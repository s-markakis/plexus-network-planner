// Plan → device configuration. Turns what the plan already knows about one
// switch (its access ports + VLANs, trunks to neighbouring switches, the VLAN
// gateways it hosts, its management address and static routes) into
//   planDeviceModel()  a neutral, comparable model of that device, and
//   renderRouterOs()   a RouterOS 7 script (.rsc) built from the model.
// The same model is what drift.js compares a real device export against, so the
// generator and the checker can never disagree about what the plan says.
//
// Safe default / intended use: the script is for review and for gear you
// manage. It never guesses a physical trunk port — an unassigned trunk is left
// out (and reported) rather than assumed — and bridge VLAN filtering is switched
// on last, as a separate, clearly marked step, because enabling it on a live
// device with a wrong table cuts management access.
//
// Pure: plain project data in, plain data/text out. No DOM.

import { ipToInt, ipInCidr } from './network.js';

const validIp = (s) => typeof s === 'string' && ipToInt(s) != null;
const prefixOf = (subnet) => {
  const m = /\/(\d+)\s*$/.exec(String(subnet || ''));
  const p = m ? parseInt(m[1], 10) : NaN;
  return p >= 0 && p <= 32 ? p : null;
};
const vlanNum = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 4094 ? n : null;
};
// RouterOS interface names we are willing to emit unquoted.
const IFACE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
// Text destined for a quoted RouterOS string: drop anything that could end the
// string, start a substitution ($, [ ]) or break the line.
const rosText = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '_').replace(/["\\$\[\]{};]/g, '_').slice(0, 64);

/**
 * @typedef {{port:string, iface:string, vlan:number, name:string, type:string}} AccessPort
 * @typedef {{peerId:string, peerName:string, role:'uplink'|'downlink', iface:string|null}} Trunk
 * @typedef {{vlan:number, name:string, address:string, prefix:number}} Svi
 * @typedef {{id:string, name:string, model:string, accessPorts:AccessPort[], trunks:Trunk[],
 *   vlans:number[], vlanNames:Record<string,string>, svis:Svi[],
 *   mgmt:{address:string,prefix:number,vlan:number}|null,
 *   routes:Array<{dst:string,gateway:string}>, warnings:string[]}} DeviceModel
 */

/**
 * @param {any} project  { settings, floors }
 * @param {string} swId
 * @param {{portPrefix?:string, trunkIfaces?:Record<string,string>}} [opts]
 *   portPrefix   interface name prefix for numbered ports (default "ether")
 *   trunkIfaces  neighbouring-switch id → the physical interface that reaches it
 * @returns {DeviceModel|null} null when the switch isn't in the plan
 */
export function planDeviceModel(project, swId, opts = {}) {
  const portPrefix = IFACE_RE.test(opts.portPrefix || '') ? opts.portPrefix : 'ether';
  const trunkIfaces = opts.trunkIfaces && typeof opts.trunkIfaces === 'object' ? opts.trunkIfaces : {};
  const floors = Array.isArray(project && project.floors) ? project.floors : [];
  const allSw = floors.flatMap((f) => (Array.isArray(f.SWS) ? f.SWS : [])).filter((s) => s && s.id);
  const sw = allSw.find((s) => s.id === swId);
  if (!sw) return null;
  const warnings = [];
  const vlanReg = (Array.isArray(project?.settings?.vlans) ? project.settings.vlans : []).filter((v) => v && vlanNum(v.id) != null);

  // Access ports: every endpoint cabled to this switch.
  /** @type {AccessPort[]} */
  const accessPorts = [];
  const seenPorts = new Set();
  for (const f of floors) {
    for (const [list, type] of [[f.APS, 'ap'], [f.CAMS, 'camera']]) {
      for (const d of Array.isArray(list) ? list : []) {
        if (!d || d.swId !== swId) continue;
        const label = d.name || d.id;
        const port = parseInt(d.port, 10);
        if (!(port >= 1)) { warnings.push(`${label}: no switch port number — left out of the port config`); continue; }
        if (seenPorts.has(port)) { warnings.push(`${label}: port ${port} is used twice — left out`); continue; }
        seenPorts.add(port);
        const vlan = vlanNum(d.vlan) ?? 1;
        accessPorts.push({ port: String(port), iface: `${portPrefix}${port}`, vlan, name: label, type });
      }
    }
  }
  accessPorts.sort((a, b) => Number(a.port) - Number(b.port));

  // Trunks: our own uplink plus every switch that uplinks to us. Routed (L3)
  // uplinks are point-to-point routed ports, not VLAN trunks — reported only.
  /** @type {Trunk[]} */
  const trunks = [];
  const addTrunk = (peer, role) => {
    const raw = trunkIfaces[peer.id];
    const iface = typeof raw === 'string' && IFACE_RE.test(raw.trim()) ? raw.trim() : null;
    if (raw && !iface) warnings.push(`trunk to ${peer.name || peer.id}: "${rosText(raw)}" is not a valid interface name — ignored`);
    if (!iface) warnings.push(`trunk to ${peer.name || peer.id}: no interface assigned — not configured (set it and regenerate)`);
    else if (accessPorts.some((p) => p.iface === iface)) warnings.push(`trunk to ${peer.name || peer.id}: ${iface} is also an access port`);
    trunks.push({ peerId: peer.id, peerName: peer.name || peer.id, role, iface });
  };
  if (sw.uplinkId) {
    const up = allSw.find((s) => s.id === sw.uplinkId);
    if (!up) warnings.push(`uplink target ${sw.uplinkId} is not in the plan`);
    else if (sw.uplinkMode === 'routed') warnings.push(`uplink to ${up.name || up.id} is routed (L3) — configure its transit address by hand`);
    else addTrunk(up, 'uplink');
  }
  for (const other of allSw) {
    if (other.uplinkId !== swId || other.id === swId) continue;
    if (other.uplinkMode === 'routed') { warnings.push(`downlink to ${other.name || other.id} is routed (L3) — configure its transit address by hand`); continue; }
    addTrunk(other, 'downlink');
  }

  // Gateways (SVIs) this switch hosts: the first L3 switch in the plan owns
  // every VLAN gateway from the registry (same rule the simulator applies).
  const firstL3 = allSw.find((s) => s.role === 'l3');
  /** @type {Svi[]} */
  const svis = [];
  if (firstL3 && firstL3.id === swId) {
    for (const v of vlanReg) {
      if (!v.gateway) continue;
      const p = prefixOf(v.subnet);
      if (!validIp(v.gateway) || p == null) { warnings.push(`VLAN ${v.id}: gateway/subnet invalid — gateway not configured`); continue; }
      const vid = /** @type {number} */ (vlanNum(v.id));   // vlanReg holds valid ids only
      svis.push({ vlan: vid, name: `vlan${vid}`, address: v.gateway, prefix: p });
    }
  }

  // Management address: on the VLAN whose subnet contains the switch IP.
  let mgmt = null;
  if (validIp(sw.ip) && !svis.some((s) => s.address === sw.ip)) {
    const home = vlanReg.find((v) => v.subnet && ipInCidr(sw.ip, v.subnet));
    if (home) mgmt = { address: sw.ip, prefix: /** @type {number} */ (prefixOf(home.subnet)), vlan: /** @type {number} */ (vlanNum(home.id)) };
    else { mgmt = { address: sw.ip, prefix: 24, vlan: 1 }; warnings.push(`management IP ${sw.ip} is in no VLAN subnet — assumed /24 on VLAN 1`); }
  } else if (sw.ip && !validIp(sw.ip)) warnings.push(`management IP ${rosText(sw.ip)} is invalid — skipped`);

  // The VLAN set this device must carry: local access VLANs, hosted gateways,
  // management, and — because it is a transit switch for its trunks — every VLAN
  // in the registry when it has any trunk at all.
  const vset = new Set(accessPorts.map((p) => p.vlan));
  for (const s of svis) vset.add(s.vlan);
  if (mgmt) vset.add(mgmt.vlan);
  if (trunks.length) for (const v of vlanReg) vset.add(/** @type {number} */ (vlanNum(v.id)));
  const vlans = [...vset].filter((n) => n != null).sort((a, b) => a - b);
  /** @type {Record<string,string>} */
  const vlanNames = {};
  for (const v of vlanReg) if (v.name) vlanNames[String(vlanNum(v.id))] = String(v.name);

  // Static routes typed into the device's CLI console.
  const routes = [];
  for (const r of Array.isArray(sw.cli && sw.cli.routes) ? sw.cli.routes : []) {
    if (r && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(String(r.cidr)) && validIp(r.via) && prefixOf(r.cidr) != null && validIp(String(r.cidr).split('/')[0])) {
      routes.push({ dst: r.cidr, gateway: r.via });
    }
  }

  return { id: sw.id, name: sw.name || sw.id, model: sw.model || '', accessPorts, trunks, vlans, vlanNames, svis, mgmt, routes, warnings };
}

/**
 * Render a device model as a RouterOS 7 script.
 * @param {DeviceModel} model
 * @param {{bridge?:string, generatedAt?:string}} [opts]
 * @returns {string}
 */
export function renderRouterOs(model, opts = {}) {
  const bridge = IFACE_RE.test(opts.bridge || '') ? opts.bridge : 'bridge1';
  const L = [];
  const trunks = model.trunks.filter((t) => t.iface);
  L.push(`# Plexus — RouterOS 7 config for "${rosText(model.name)}"${opts.generatedAt ? ` (generated ${rosText(opts.generatedAt)})` : ''}`);
  L.push('# REVIEW BEFORE APPLYING. Written for a device you manage, starting from a');
  L.push('# config with no bridge/VLAN setup of its own. Apply from the console or in');
  L.push('# Safe Mode: step 6 changes how the bridge forwards and can cut your session.');
  for (const w of model.warnings) L.push(`# WARNING: ${rosText(w)}`);
  L.push('');
  L.push('# 1. identity');
  L.push(`/system identity set name="${rosText(model.name)}"`);
  L.push('');
  L.push('# 2. bridge (VLAN filtering stays OFF until step 6)');
  L.push('/interface bridge');
  L.push(`add name=${bridge} vlan-filtering=no comment="plexus"`);
  L.push('');
  L.push('# 3. ports');
  L.push('/interface bridge port');
  for (const p of model.accessPorts) {
    L.push(`add bridge=${bridge} interface=${p.iface} pvid=${p.vlan} frame-types=admit-only-untagged-and-priority-tagged comment="${rosText(p.name)}"`);
  }
  for (const t of trunks) {
    L.push(`add bridge=${bridge} interface=${t.iface} frame-types=admit-only-vlan-tagged comment="trunk to ${rosText(t.peerName)}"`);
  }
  for (const t of model.trunks.filter((x) => !x.iface)) L.push(`# NOT CONFIGURED: trunk to ${rosText(t.peerName)} — no interface assigned`);
  L.push('');
  L.push('# 4. VLAN table');
  L.push('/interface bridge vlan');
  // The bridge itself is a tagged member of a VLAN only when the CPU needs to
  // see it: a hosted gateway or the management address.
  const cpuVlans = new Set(model.svis.map((s) => s.vlan));
  if (model.mgmt) cpuVlans.add(model.mgmt.vlan);
  for (const v of model.vlans) {
    const tagged = [...(cpuVlans.has(v) ? [bridge] : []), ...trunks.map((t) => t.iface)];
    const untagged = model.accessPorts.filter((p) => p.vlan === v).map((p) => p.iface);
    if (!tagged.length && !untagged.length) continue;
    const name = model.vlanNames[String(v)];
    L.push(`add bridge=${bridge} vlan-ids=${v}${tagged.length ? ` tagged=${tagged.join(',')}` : ''}${untagged.length ? ` untagged=${untagged.join(',')}` : ''}${name ? ` comment="${rosText(name)}"` : ''}`);
  }
  L.push('');
  L.push('# 5. L3 interfaces, addresses, routes');
  const l3 = [...model.svis.map((s) => ({ vlan: s.vlan, address: s.address, prefix: s.prefix, what: 'gateway' }))];
  if (model.mgmt) l3.push({ vlan: model.mgmt.vlan, address: model.mgmt.address, prefix: model.mgmt.prefix, what: 'management' });
  if (l3.length) {
    L.push('/interface vlan');
    for (const v of [...new Set(l3.map((x) => x.vlan))]) L.push(`add name=vlan${v} interface=${bridge} vlan-id=${v}`);
    L.push('/ip address');
    for (const x of l3) L.push(`add address=${x.address}/${x.prefix} interface=vlan${x.vlan} comment="${x.what}"`);
  } else {
    L.push('# (none in the plan)');
  }
  if (model.routes.length) {
    L.push('/ip route');
    for (const r of model.routes) L.push(`add dst-address=${r.dst} gateway=${r.gateway}`);
  }
  L.push('');
  L.push('# 6. LAST STEP — turn VLAN filtering on. Check steps 3-5 took effect first');
  L.push('#    (/interface bridge vlan print). A wrong table here locks you out.');
  L.push(`/interface bridge set ${bridge} vlan-filtering=yes`);
  return L.join('\n') + '\n';
}

/** Convenience: model + script in one call. @returns {{model:DeviceModel, text:string}|null} */
export function exportRouterOs(project, swId, opts = {}) {
  const model = planDeviceModel(project, swId, opts);
  return model ? { model, text: renderRouterOs(model, opts) } : null;
}
