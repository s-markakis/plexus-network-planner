// Config drift: does the real device still match the plan? Parses the text of a
// RouterOS `/export` and compares it with the device model the plan implies
// (rosExport.planDeviceModel). Read-only by construction — it takes pasted or
// uploaded text and never talks to a device.
//
// Pure: text + model in, findings out. No DOM.

// Split one export line into tokens, honouring double-quoted values.
function tokenize(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
      if (c === '"') { q = false; continue; }
      cur += c;
    } else if (c === '"') q = true;
    else if (c === ' ' || c === '\t') { if (cur) { out.push(cur); cur = ''; } }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function kvOf(tokens) {
  /** @type {Record<string,string>} */
  const kv = Object.create(null);
  for (const t of tokens) {
    const i = t.indexOf('=');
    if (i > 0) kv[t.slice(0, i)] = t.slice(i + 1);
  }
  return kv;
}
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
function vlanIds(spec) {
  const out = [];
  for (const part of list(spec)) {
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (m) { for (let i = Math.max(1, +m[1]); i <= Math.min(4094, +m[2]); i++) out.push(i); }
    else if (/^\d+$/.test(part)) out.push(+part);
  }
  return out;
}

/**
 * Parse RouterOS `/export` text into the facts drift cares about.
 * @param {string} text
 * @returns {{identity:string, filtering:boolean|null, bridges:string[],
 *   ports:Array<{iface:string,pvid:number,frameTypes:string,disabled:boolean}>,
 *   vlanTable:Array<{ids:number[],tagged:string[],untagged:string[]}>,
 *   vlanIfaces:Array<{name:string,vlanId:number,iface:string}>,
 *   addresses:Array<{address:string,iface:string}>, routes:Array<{dst:string,gateway:string}>}}
 */
export function parseRouterOsExport(text) {
  const res = { identity: '', filtering: null, bridges: [], ports: [], vlanTable: [], vlanIfaces: [], addresses: [], routes: [] };
  // Join backslash-continued lines, drop comments.
  const lines = [];
  let carry = '';
  for (const raw of String(text == null ? '' : text).slice(0, 2_000_000).split(/\r?\n/)) {
    // A continued line ends in "\" and resumes (indented) on the next one; the
    // break can fall mid-token, so the pieces are joined with nothing between.
    const l = raw.replace(/\s+$/, '');
    const piece = carry ? l.replace(/^\s+/, '') : l;
    if (piece.endsWith('\\')) { carry += piece.slice(0, -1); continue; }
    const full = (carry + piece).trim();
    carry = '';
    if (full && !full.startsWith('#')) lines.push(full);
  }
  let path = '';
  for (let line of lines) {
    if (line.startsWith('/')) {
      // Either a bare section ("/ip address") or a one-liner ("/ip address add …").
      const m = /^(\/[a-z0-9 -]+?)(?:\s+(add|set)\b(.*))?$/i.exec(line);
      if (!m) continue;
      path = m[1].trim().replace(/\s+/g, ' ');
      if (!m[2]) continue;
      line = `${m[2]}${m[3] || ''}`;
    }
    const tok = tokenize(line);
    const verb = tok[0];
    if (verb !== 'add' && verb !== 'set') continue;
    const kv = kvOf(tok.slice(1));
    const disabled = kv.disabled === 'yes';
    if (path === '/system identity' && verb === 'set' && kv.name != null) res.identity = kv.name;
    else if (path === '/interface bridge') {
      if (verb === 'add' && kv.name) res.bridges.push(kv.name);
      if (kv['vlan-filtering'] != null) res.filtering = kv['vlan-filtering'] === 'yes';
    } else if (path === '/interface bridge port' && verb === 'add' && kv.interface) {
      res.ports.push({ iface: kv.interface, pvid: kv.pvid ? parseInt(kv.pvid, 10) : 1, frameTypes: kv['frame-types'] || 'admit-all', disabled });
    } else if (path === '/interface bridge vlan' && verb === 'add' && kv['vlan-ids']) {
      if (!disabled) res.vlanTable.push({ ids: vlanIds(kv['vlan-ids']), tagged: list(kv.tagged), untagged: list(kv.untagged) });
    } else if (path === '/interface vlan' && verb === 'add' && kv.name && kv['vlan-id']) {
      if (!disabled) res.vlanIfaces.push({ name: kv.name, vlanId: parseInt(kv['vlan-id'], 10), iface: kv.interface || '' });
    } else if (path === '/ip address' && verb === 'add' && kv.address) {
      if (!disabled) res.addresses.push({ address: kv.address, iface: kv.interface || '' });
    } else if (path === '/ip route' && verb === 'add' && kv.gateway) {
      if (!disabled) res.routes.push({ dst: kv['dst-address'] || '0.0.0.0/0', gateway: kv.gateway });
    }
  }
  return res;
}

/**
 * Compare a device export with the plan's model of that device.
 * @param {import('./rosExport.js').DeviceModel} model
 * @param {ReturnType<typeof parseRouterOsExport>} actual
 * @returns {Array<{severity:'error'|'warn'|'info', area:string, message:string}>}
 *   Empty array = the device matches the plan. `error` = the plan's intent is
 *   not met; `warn` = met differently / weaker than planned; `info` = present on
 *   the device but unknown to the plan.
 */
export function diffAgainstPlan(model, actual) {
  /** @type {Array<{severity:'error'|'warn'|'info', area:string, message:string}>} */
  const out = [];
  const add = (severity, area, message) => out.push({ severity, area, message });

  if (actual.identity && actual.identity !== model.name) add('warn', 'identity', `device is named "${actual.identity}", plan says "${model.name}"`);

  const needsVlans = model.vlans.some((v) => v !== 1) || model.trunks.length > 0;
  if (needsVlans && actual.filtering !== true) add('error', 'bridge', 'bridge VLAN filtering is not enabled — VLAN separation is not enforced');

  const portBy = new Map(actual.ports.map((p) => [p.iface, p]));
  const memberOf = (iface, vlan, kind) => actual.vlanTable.some((r) => r.ids.includes(vlan) && r[kind].includes(iface));

  for (const p of model.accessPorts) {
    const a = portBy.get(p.iface);
    if (!a) { add('error', 'port', `${p.iface} (${p.name}): not a bridge port on the device`); continue; }
    if (a.disabled) add('warn', 'port', `${p.iface} (${p.name}): bridge port is disabled`);
    if (a.pvid !== p.vlan) add('error', 'port', `${p.iface} (${p.name}): on VLAN ${a.pvid}, plan says VLAN ${p.vlan}`);
    else if (p.vlan !== 1 && /tagged/.test(a.frameTypes) && !/untagged/.test(a.frameTypes)) add('error', 'port', `${p.iface} (${p.name}): accepts only tagged frames but is planned as an access port`);
  }
  for (const t of model.trunks) {
    if (!t.iface) { add('info', 'trunk', `trunk to ${t.peerName}: no interface assigned in the plan — not checked`); continue; }
    if (!portBy.has(t.iface)) { add('error', 'trunk', `${t.iface} (trunk to ${t.peerName}): not a bridge port on the device`); continue; }
    const missing = model.vlans.filter((v) => v !== 1 && !memberOf(t.iface, v, 'tagged'));
    if (missing.length) add('error', 'trunk', `${t.iface} (trunk to ${t.peerName}): VLAN ${missing.join(', ')} not tagged on it`);
  }

  const hasAddr = (address, prefix) => actual.addresses.some((a) => a.address === `${address}/${prefix}`);
  const anyPrefix = (address) => actual.addresses.find((a) => a.address.split('/')[0] === address);
  for (const s of model.svis) {
    if (hasAddr(s.address, s.prefix)) {
      const a = actual.addresses.find((x) => x.address === `${s.address}/${s.prefix}`);
      const vi = actual.vlanIfaces.find((v) => v.name === a.iface);
      if (!vi || vi.vlanId !== s.vlan) add('warn', 'gateway', `VLAN ${s.vlan} gateway ${s.address} is on interface "${a.iface}", not a VLAN ${s.vlan} interface`);
    } else if (anyPrefix(s.address)) add('warn', 'gateway', `VLAN ${s.vlan} gateway ${s.address}: prefix is ${anyPrefix(s.address).address.split('/')[1]}, plan says /${s.prefix}`);
    else add('error', 'gateway', `VLAN ${s.vlan} gateway ${s.address}/${s.prefix} is not configured`);
  }
  if (model.mgmt) {
    if (!anyPrefix(model.mgmt.address)) add('error', 'management', `management address ${model.mgmt.address} is not configured`);
    else if (!hasAddr(model.mgmt.address, model.mgmt.prefix)) add('warn', 'management', `management address ${model.mgmt.address}: prefix differs from the plan's /${model.mgmt.prefix}`);
  }
  for (const r of model.routes) {
    if (!actual.routes.some((a) => a.dst === r.dst && a.gateway === r.gateway)) add('error', 'route', `static route ${r.dst} via ${r.gateway} is missing`);
  }

  // Present on the device, absent from the plan.
  const plannedIfaces = new Set([...model.accessPorts.map((p) => p.iface), ...model.trunks.map((t) => t.iface).filter(Boolean)]);
  for (const a of actual.ports) {
    if (!plannedIfaces.has(a.iface) && a.pvid !== 1) add('info', 'port', `${a.iface}: on VLAN ${a.pvid} on the device, but nothing is planned on that port`);
  }
  const plannedAddrs = new Set([...model.svis.map((s) => s.address), ...(model.mgmt ? [model.mgmt.address] : [])]);
  for (const a of actual.addresses) {
    if (!plannedAddrs.has(a.address.split('/')[0])) add('info', 'address', `${a.address} on ${a.iface || '?'} is not in the plan`);
  }
  const plannedVlans = new Set(model.vlans);
  const extra = [...new Set(actual.vlanTable.flatMap((r) => r.ids))].filter((v) => !plannedVlans.has(v)).sort((a, b) => a - b);
  if (extra.length) add('info', 'vlan', `VLAN ${extra.join(', ')} exist on the device but not in the plan`);

  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * A RouterOS script that brings a drifted device back to the plan. It only
 * ADDS or SETS what the plan requires and is missing or wrong on the device —
 * it never removes anything (addresses, ports or VLANs the plan doesn't know
 * are reported by diffAgainstPlan as info and left alone). Like the generator,
 * VLAN filtering is the last step.
 * @param {import('./rosExport.js').DeviceModel} model
 * @param {ReturnType<typeof parseRouterOsExport>} actual
 * @returns {{text:string, changes:number, manual:string[]}} manual = things it
 *   could not safely script, to be fixed by hand
 */
export function remediationScript(model, actual) {
  const IFACE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
  const bridge = actual.bridges.find((b) => IFACE.test(b)) || 'bridge1';
  const q = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '_').replace(/["\\$\[\]{};]/g, '_').slice(0, 64);
  const lines = [];
  const manual = [];
  const portBy = new Map(actual.ports.map((p) => [p.iface, p]));
  const ACCESS = 'admit-only-untagged-and-priority-tagged';

  if (!actual.bridges.length) lines.push('/interface bridge', `add name=${bridge} vlan-filtering=no comment="plexus"`);

  const portCmds = [];
  for (const p of model.accessPorts) {
    const a = portBy.get(p.iface);
    if (!a) portCmds.push(`add bridge=${bridge} interface=${p.iface} pvid=${p.vlan} frame-types=${ACCESS} comment="${q(p.name)}"`);
    else if (a.pvid !== p.vlan || (/tagged/.test(a.frameTypes) && !/untagged/.test(a.frameTypes))) portCmds.push(`set [find interface=${p.iface}] pvid=${p.vlan} frame-types=${ACCESS}`);
    else if (a.disabled) portCmds.push(`set [find interface=${p.iface}] disabled=no`);
  }
  const trunks = model.trunks.filter((t) => t.iface);
  for (const t of trunks) if (!portBy.has(t.iface)) portCmds.push(`add bridge=${bridge} interface=${t.iface} frame-types=admit-only-vlan-tagged comment="trunk to ${q(t.peerName)}"`);
  if (portCmds.length) lines.push('/interface bridge port', ...portCmds);

  // VLAN table: every planned VLAN tagged on every trunk (and on the bridge when
  // the CPU needs it).
  const cpu = new Set(model.svis.map((s) => s.vlan));
  if (model.mgmt) cpu.add(model.mgmt.vlan);
  const vlanCmds = [];
  for (const v of model.vlans) {
    const want = [...(cpu.has(v) ? [bridge] : []), ...trunks.map((t) => t.iface)];
    const untagged = model.accessPorts.filter((p) => p.vlan === v).map((p) => p.iface);
    const rows = actual.vlanTable.filter((r) => r.ids.includes(v));
    if (!rows.length) {
      if (want.length || untagged.length) vlanCmds.push(`add bridge=${bridge} vlan-ids=${v}${want.length ? ` tagged=${want.join(',')}` : ''}${untagged.length ? ` untagged=${untagged.join(',')}` : ''}`);
      continue;
    }
    const have = new Set(rows.flatMap((r) => r.tagged));
    const missing = want.filter((i) => !have.has(i));
    if (!missing.length) continue;
    // Only a row that is exactly this VLAN can be addressed unambiguously.
    const own = rows.find((r) => r.ids.length === 1);
    if (own) vlanCmds.push(`set [find vlan-ids=${v}] tagged=${[...new Set([...own.tagged, ...missing])].join(',')}`);
    else manual.push(`VLAN ${v} is part of a grouped bridge-vlan entry on the device — add ${missing.join(', ')} to its tagged list by hand`);
  }
  if (vlanCmds.length) lines.push('/interface bridge vlan', ...vlanCmds);

  // L3: VLAN interfaces + addresses the plan needs and the device lacks.
  const needAddr = [...model.svis.map((s) => ({ vlan: s.vlan, address: s.address, prefix: s.prefix, what: 'gateway' })), ...(model.mgmt ? [{ vlan: model.mgmt.vlan, address: model.mgmt.address, prefix: model.mgmt.prefix, what: 'management' }] : [])];
  const vifCmds = [];
  const addrCmds = [];
  for (const x of needAddr) {
    const cur = actual.addresses.find((a) => a.address.split('/')[0] === x.address);
    if (cur && cur.address === `${x.address}/${x.prefix}`) continue;
    if (cur) { manual.push(`${x.what} address ${x.address} is configured as ${cur.address}; the plan says /${x.prefix} — correct the prefix by hand`); continue; }
    let vif = actual.vlanIfaces.find((i) => i.vlanId === x.vlan && IFACE.test(i.name));
    if (!vif) {
      vif = { name: `vlan${x.vlan}`, vlanId: x.vlan, iface: bridge };
      if (!vifCmds.some((c) => c.includes(`vlan-id=${x.vlan}`))) vifCmds.push(`add name=${vif.name} interface=${bridge} vlan-id=${x.vlan}`);
    }
    addrCmds.push(`add address=${x.address}/${x.prefix} interface=${vif.name} comment="${x.what}"`);
  }
  if (vifCmds.length) lines.push('/interface vlan', ...vifCmds);
  if (addrCmds.length) lines.push('/ip address', ...addrCmds);
  const routeCmds = model.routes.filter((r) => !actual.routes.some((a) => a.dst === r.dst && a.gateway === r.gateway)).map((r) => `add dst-address=${r.dst} gateway=${r.gateway}`);
  if (routeCmds.length) lines.push('/ip route', ...routeCmds);

  const needsVlans = model.vlans.some((v) => v !== 1) || model.trunks.length > 0;
  const enableFiltering = needsVlans && actual.filtering !== true;
  const changes = lines.filter((l) => !l.startsWith('/')).length + (enableFiltering ? 1 : 0);
  for (const t of model.trunks.filter((x) => !x.iface)) manual.push(`trunk to ${t.peerName} has no interface assigned in the plan — not scripted`);

  const out = [`# Plexus — remediation for "${q(model.name)}": bring the device back to the plan`,
    '# REVIEW BEFORE APPLYING. Adds/sets only what the plan requires; removes nothing.',
    ...manual.map((m) => `# BY HAND: ${q(m)}`)];
  if (!changes) out.push('# Nothing to change — the device already meets the plan.');
  else {
    out.push('', ...lines);
    if (enableFiltering) out.push('', '# LAST STEP — check the VLAN table above took effect first; a wrong table here locks you out.', `/interface bridge set ${bridge} vlan-filtering=yes`);
  }
  return { text: out.join('\n') + '\n', changes, manual };
}
