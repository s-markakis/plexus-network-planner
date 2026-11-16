// Blast radius: "if this device is compromised, what can it reach?" Sweeps
// every address in the plan from one source — ping, plus a probe of each
// service the target listens on — and turns the result into findings a
// segmentation review would raise. Read-only analysis of the simulated plan.

import { ping, probe, resetRuntime } from './sim.js';
import { intToIp } from './network.js';

/**
 * @param {any} compiled  compileTopology() result
 * @param {string} sourceSimId  e.g. "h:<plan id>"
 * @returns {null|{source:{name:string, ip:string, vlan:any},
 *   targets:Array<{name:string, ip:string, group:'same-vlan'|'other-vlan'|'management'|'gateway'|'internet', vlan:any, reachable:boolean, open:Array<{proto:string,port:number}>}>,
 *   findings:Array<{severity:'high'|'medium'|'info', text:string}>, reachable:number, total:number}}
 */
export function blastRadius(compiled, sourceSimId) {
  const net = compiled.net;
  const src = net.devices.get(sourceSimId);
  const srcMeta = compiled.meta.get(sourceSimId);
  if (!src || !srcMeta) return null;
  const srcIps = new Set([...src.ifaces.values()].filter((i) => i.ipInt != null).map((i) => intToIp(i.ipInt)));
  if (!srcIps.size) return null;

  const candidates = [];
  for (const [simId, m] of compiled.meta) {
    const dev = net.devices.get(simId);
    if (!dev || simId === sourceSimId || m.type === 'ghost') continue;
    if (m.type === 'ap' || m.type === 'camera' || m.type === 'client') {
      candidates.push({ name: m.name, ip: m.ip, group: String(m.vlan) === String(srcMeta.vlan) ? 'same-vlan' : 'other-vlan', vlan: m.vlan, services: dev.services || [] });
    } else if (m.type === 'mgmt') {
      candidates.push({ name: `${m.name} (management)`, ip: m.ip, group: 'management', vlan: m.vlan, services: dev.services || [] });
    } else if (m.type === 'router') {
      for (const i of dev.ifaces.values()) if (i.ipInt != null) candidates.push({ name: `${m.name} ${i.name}`, ip: intToIp(i.ipInt), group: 'gateway', vlan: null, services: dev.services || [] });
    } else if (m.type === 'cloud') {
      candidates.push({ name: 'Internet', ip: '8.8.8.8', group: 'internet', vlan: null, services: [] });
    }
  }

  const targets = [];
  for (const c of candidates) {
    if (!c.ip || srcIps.has(c.ip)) continue;
    resetRuntime(net);
    let reachable = false;
    try { const r = ping(net, { from: sourceSimId, to: c.ip }); reachable = r.ok; } catch { /* unreachable */ }
    const open = [];
    for (const s of c.services) {
      resetRuntime(net);
      try { if (probe(net, { from: sourceSimId, to: c.ip, port: s.port, protocol: s.proto }).ok) open.push({ proto: s.proto, port: s.port }); } catch { /* closed/unreachable */ }
    }
    targets.push({ name: c.name, ip: c.ip, group: /** @type {any} */ (c.group), vlan: c.vlan, reachable: reachable || open.length > 0, open });
  }
  resetRuntime(net);

  const hit = targets.filter((t) => t.reachable);
  const svc = (t) => (t.open.length ? ` (${t.open.map((o) => `${o.proto}/${o.port}`).join(', ')})` : '');
  const findings = [];
  // A device's own gateway is expected to answer; a gateway that also exposes
  // admin services to it, or any other management address, is the finding.
  const mgmt = hit.filter((t) => (t.group === 'management' || t.group === 'gateway') && t.open.length);
  if (mgmt.length) findings.push({ severity: /** @type {'high'} */ ('high'), text: `Network management is reachable from ${srcMeta.name}: ${mgmt.map((t) => `${t.name} ${t.ip}${svc(t)}`).join('; ')}` });
  const other = hit.filter((t) => t.group === 'other-vlan');
  if (other.length) {
    const vlans = [...new Set(other.map((t) => t.vlan))].sort((a, b) => Number(a) - Number(b));
    findings.push({ severity: /** @type {'medium'} */ ('medium'), text: `Reaches ${other.length} device(s) in other VLANs (${vlans.map((v) => `VLAN ${v}`).join(', ')}) — no filtering between these segments` });
  }
  const same = hit.filter((t) => t.group === 'same-vlan');
  if (same.length) findings.push({ severity: /** @type {'info'} */ ('info'), text: `${same.length} device(s) share its VLAN and are reachable directly at layer 2 — a gateway firewall cannot separate them` });
  if (hit.some((t) => t.group === 'internet')) findings.push({ severity: /** @type {'info'} */ ('info'), text: 'Can open connections to the Internet (outbound path for exfiltration or command-and-control)' });
  if (!hit.length) findings.push({ severity: /** @type {'info'} */ ('info'), text: 'Reaches nothing else in the plan — fully isolated' });

  return { source: { name: srcMeta.name, ip: [...srcIps][0], vlan: srcMeta.vlan }, targets, findings, reachable: hit.length, total: targets.length };
}
