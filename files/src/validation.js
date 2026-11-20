// Network validation ("Validate"): design checks for the floor on screen plus
// the building-wide ones (duplicate IPs, subnet pools, policies, capacity,
// storage). Pure — the app passes in what needs the live plan (switch PoE
// analysis, cable lengths, airtime, naming, policy results). Messages are
// plain text; the caller must render them with textContent.

import { ipInCidr, subnetUsage } from './network.js';

/**
 * @param {{
 *   floor:any, floors:any[], vlans:any[],
 *   settings:{perClientMbps?:any, expectedClients?:any, retentionDays?:any, storageCodec?:string, namePattern?:string, policies?:any[]},
 *   hasMap:boolean,
 *   analyze:(sw:any)=>any,
 *   runM:(dev:any, sw:any)=>number,
 *   airtimePct:(ap:any)=>number,
 *   nameOk?:((dev:any, type:string)=>boolean)|null,
 *   evalPolicies?:(()=>any[])|null,
 *   clientCapacity:()=>number,
 *   storageGb:number,
 * }} ctx
 * @returns {{errors:string[], warns:string[], infos:string[]}}
 */
export function validatePlan(ctx) {
  const { floor: f, floors, vlans, settings: S, hasMap } = ctx;
  const errors = [], warns = [], infos = [];
  const APS = f.APS || [], CAMS = f.CAMS || [], sws = f.SWS || [];
  const vlanById = (id) => { const k = (id == null ? '' : String(id)).trim(); return k ? vlans.find((v) => String(v.id) === k) || null : null; };

  for (const sw of sws) {
    const a = ctx.analyze(sw);
    if (a.overBudget) errors.push(`${sw.name}: PoE draw ${a.draw.toFixed(0)} W exceeds ${a.budget} W budget.`);
    else if (a.budget > 0 && a.headroom != null && a.headroom < 10 && a.draw > 0) warns.push(`${sw.name}: only ${a.headroom}% PoE headroom left.`);
    if (a.overPorts) errors.push(`${sw.name}: ${a.used} devices on ${a.ports} ports — over capacity.`);
    for (const c of a.classFails) errors.push(`${c.name} needs ${c.cls} PoE but ${sw.name} delivers ${a.swCls || 'none'}.`);
    if (!a.swCls && a.clients.some((c) => c.w > 0)) warns.push(`${sw.name} has PoE devices but no PoE budget set.`);
    // Duplicate port labels on the same switch.
    const seen = new Map();
    for (const c of a.clients) {
      const p = (c.port || '').trim().toLowerCase();
      if (!p) continue;
      if (seen.has(p)) warns.push(`${sw.name}: port "${c.port}" used by both ${seen.get(p)} and ${c.name}.`);
      else seen.set(p, c.name);
    }
  }
  // Cable-run length (real scale → needs a map).
  const checkRun = (dev, label) => {
    if (!dev.swId) return;
    const sw = sws.find((s) => s.id === dev.swId); if (!sw) return;
    const m = ctx.runM(dev, sw);
    if (m > 100) errors.push(`${label}: cable run to ${sw.name} is ${m.toFixed(0)} m (>100 m Ethernet limit).`);
    else if (m > 90) warns.push(`${label}: cable run to ${sw.name} is ${m.toFixed(0)} m (near 100 m limit).`);
  };
  if (hasMap) { APS.forEach((ap) => checkRun(ap, ap.name)); CAMS.forEach((c) => checkRun(c, c.name)); }
  // Unassigned devices (informational).
  APS.forEach((ap) => { if (!ap.swId) infos.push(`${ap.name} is not assigned to a switch.`); });
  CAMS.forEach((c) => { if (!c.swId) infos.push(`${c.name} is not assigned to a switch.`); });
  // Duplicate IPs, building-wide (addresses are global); this floor first.
  const ipMap = new Map();
  const where = (fl, name) => (floors.length > 1 && fl !== f ? `${name} (${fl.name || 'another floor'})` : name);
  const noteIp = (ip, label) => { const k = (ip || '').trim(); if (!k) return; if (ipMap.has(k)) warns.push(`Duplicate IP ${k}: ${ipMap.get(k)} and ${label}.`); else ipMap.set(k, label); };
  for (const fl of [f, ...floors.filter((x) => x !== f)])
    for (const list of [fl.APS, fl.CAMS, fl.SWS]) for (const d of list || []) noteIp(d.ip, where(fl, d.name));
  // VLANs referenced but not in the registry (only when a registry exists).
  if (vlans.length) {
    const checkVlan = (dev, label) => { const v = (dev.vlan || '').trim(); if (v && !vlanById(v)) warns.push(`${label}: VLAN "${v}" is not in the VLAN registry.`); };
    APS.forEach((ap) => checkVlan(ap, ap.name));
    CAMS.forEach((c) => checkVlan(c, c.name));
  }
  // IPs outside their VLAN's declared subnet.
  const checkIpSubnet = (dev, label) => {
    const v = vlanById(dev.vlan);
    const ip = (dev.ip || '').trim();
    if (!ip || !v || !v.subnet) return;
    if (!ipInCidr(ip, v.subnet)) warns.push(`${label}: IP ${ip} is outside VLAN ${v.id} subnet ${v.subnet}.`);
  };
  APS.forEach((ap) => checkIpSubnet(ap, ap.name));
  CAMS.forEach((c) => checkIpSubnet(c, c.name));
  // Subnet pool exhaustion (building-wide).
  if (vlans.length) {
    const allIps = [];
    for (const fl of floors) for (const list of [fl.APS, fl.CAMS, fl.SWS]) for (const d of list || []) if (d.ip) allIps.push(d.ip);
    for (const v of vlans) {
      if (!v.subnet) continue;
      const u = subnetUsage(v.subnet, allIps);
      if (!u) continue;
      if (u.pct >= 100) errors.push(`VLAN ${v.id} subnet ${v.subnet} is full (${u.used}/${u.capacity} hosts).`);
      else if (u.pct >= 90) warns.push(`VLAN ${v.id} subnet ${v.subnet} is ${u.pct}% full (${u.used}/${u.capacity} hosts).`);
    }
  }
  // Naming convention (only when one with a number is configured).
  if (ctx.nameOk) {
    const offenders = [];
    for (const [list, type] of [[APS, 'AP'], [CAMS, 'CAM'], [sws, 'SW']])
      for (const dev of list) if (!ctx.nameOk(dev, type)) offenders.push(dev.name || dev.id);
    if (offenders.length) {
      const shown = offenders.slice(0, 3).join(', ');
      warns.push(`${offenders.length} device name${offenders.length === 1 ? '' : 's'} break the "${S.namePattern}" convention (${shown}${offenders.length > 3 ? ', …' : ''}) — Inventory → Auto-rename fixes them.`);
    }
  }
  // Per-AP airtime: clients × per-client Mbps vs what the cell delivers.
  if (hasMap) {
    for (const ap of APS) {
      if (!(ap.capacityClients > 0)) continue;
      const pct = ctx.airtimePct(ap);
      if (pct === Infinity) errors.push(`${ap.name}: expected ${ap.capacityClients} clients but the cell delivers no usable throughput.`);
      else if (pct > 100) errors.push(`${ap.name}: airtime ~${pct}% — ${ap.capacityClients} clients × ${parseFloat(S.perClientMbps) || 5} Mbps exceeds what this cell can carry.`);
      else if (pct > 80) warns.push(`${ap.name}: airtime ~${pct}% — near saturation; consider a wider channel or another AP.`);
    }
  }
  // Policies (reachability intent): a violated policy is a design error.
  if (ctx.evalPolicies && Array.isArray(S.policies) && S.policies.length) {
    try {
      const pr = ctx.evalPolicies();
      for (const r of pr) {
        if (r.status === 'fail') { const v = r.violations[0]; errors.push(`Policy violated — ${r.label}: ${v.from} (${v.fromIp}) → ${v.to} (${v.toIp})${r.violations.length > 1 ? ` (+${r.violations.length - 1} more)` : ''}.`); }
        else if (r.status === 'skipped') warns.push(`Policy not testable — ${r.label}: ${r.reason}.`);
      }
      const okN = pr.filter((r) => r.status === 'pass').length;
      if (okN) infos.push(`${okN} reachability polic${okN === 1 ? 'y holds' : 'ies hold'}.`);
    } catch (_) { warns.push('Policies could not be evaluated (the plan does not simulate).'); }
  }
  // Client-capacity rollup (only when an expectation is set).
  const expected = parseInt(S.expectedClients, 10) || 0;
  if (expected > 0) {
    const cap = ctx.clientCapacity();
    if (cap < expected) warns.push(`Client capacity ${cap} < expected ${expected} — consider more/denser APs.`);
    else infos.push(`Client capacity ${cap} ≥ expected ${expected}.`);
  }
  // Camera storage rollup.
  if (ctx.storageGb > 0) {
    const days = parseInt(S.retentionDays, 10) || 30;
    infos.push(`Camera recording needs ~${ctx.storageGb >= 1000 ? (ctx.storageGb / 1000).toFixed(2) + ' TB' : Math.round(ctx.storageGb) + ' GB'} of NVR storage for ${days}-day retention (${S.storageCodec === 'h264' ? 'H.264' : 'H.265'}).`);
  }
  return { errors, warns, infos };
}
