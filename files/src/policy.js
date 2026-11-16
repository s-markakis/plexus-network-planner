// Network intent as tests. A policy states what must — or must never — be able
// to talk: "Guest must never reach Management", "Staff must reach the NVR on
// tcp/554". evaluatePolicies() proves each one against the simulated plan and
// names every pair that breaks it.
//
// It does not test one convenient host per VLAN. Firewall rules carve a subnet
// into regions (a rule for 10.0.10.0/28 treats .5 and .50 differently), so for
// every VLAN a policy names, probe hosts are placed at an address inside and
// just outside each rule prefix that overlaps the VLAN's subnet — one per
// region — in addition to the real devices. A rule that only covers part of a
// subnet can therefore not hide behind the devices that happen to be planned.
//
// Pure: project in, results out.

import { compileTopology } from './simCompile.js';
import { ping, probe, resetRuntime } from './sim.js';
import { ipToInt, intToIp } from './network.js';

const MAX_PROBES_PER_VLAN = 10;
const MAX_PAIRS = 600;
const ENDPOINT = new Set(['ap', 'camera', 'client', 'ghost']);

/**
 * @typedef {{kind:'vlan', vlan:string}|{kind:'device', id:string}|{kind:'mgmt'}|{kind:'internet'}} Selector
 * @typedef {{id:string, name?:string, from:Selector, to:Selector, proto?:'any'|'icmp'|'tcp'|'udp', port?:number, expect:'allow'|'deny'}} Policy
 */

const parse = (cidr) => {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(String(cidr || '').trim());
  const n = m ? ipToInt(m[1]) : null;
  if (n == null || +m[2] > 32) return null;
  const size = 2 ** (32 - +m[2]);
  const lo = Math.floor(n / size) * size;
  return { lo, hi: lo + size - 1 };
};

export function selectorLabel(s) {
  if (!s) return '?';
  if (s.kind === 'vlan') return `VLAN ${s.vlan}`;
  if (s.kind === 'device') return `device ${s.id}`;
  if (s.kind === 'mgmt') return 'network management';
  if (s.kind === 'internet') return 'the Internet';
  return '?';
}
export function policyLabel(p) {
  const svc = p.proto && p.proto !== 'any' ? ` on ${p.proto}${p.port ? '/' + p.port : ''}` : '';
  return `${selectorLabel(p.from)} ${p.expect === 'deny' ? 'must NOT reach' : 'must reach'} ${selectorLabel(p.to)}${svc}`;
}

// Probe addresses for one VLAN: inside and just outside every rule prefix that
// cuts through its subnet. Never the network/broadcast address or a taken IP.
function probeAddresses(subnet, rulePrefixes, taken) {
  const sn = parse(subnet);
  if (!sn) return [];
  const out = [];
  const usable = (n) => n > sn.lo && n < sn.hi && !taken.has(intToIp(n)) && !out.includes(n);
  const first = (from, to, step) => { for (let n = from; step > 0 ? n <= to : n >= to; n += step) if (usable(n)) return n; return null; };
  for (const pr of rulePrefixes) {
    const lo = Math.max(pr.lo, sn.lo), hi = Math.min(pr.hi, sn.hi);
    if (lo > hi) continue; // no overlap
    if (pr.lo <= sn.lo && pr.hi >= sn.hi) continue; // covers the whole subnet: no boundary inside
    const inside = first(lo, hi, 1);
    if (inside != null) out.push(inside);
    const above = first(hi + 1, sn.hi, 1);
    if (above != null) out.push(above);
    const below = first(lo - 1, sn.lo, -1);
    if (below != null) out.push(below);
    if (out.length >= MAX_PROBES_PER_VLAN) break;
  }
  return out.slice(0, MAX_PROBES_PER_VLAN).map(intToIp);
}

/**
 * @param {any} project
 * @param {Policy[]} policies
 * @returns {{results:Array<{policy:Policy, label:string, status:'pass'|'fail'|'skipped', pairs:number, reason?:string,
 *   violations:Array<{from:string, fromIp:string, to:string, toIp:string, status:string, synthetic:boolean}>}>, probes:number}}
 */
export function evaluatePolicies(project, policies) {
  const list = (Array.isArray(policies) ? policies : []).filter((p) => p && p.from && p.to && (p.expect === 'allow' || p.expect === 'deny'));
  if (!list.length) return { results: [], probes: 0 };

  // Pass 1: learn the rule prefixes and addresses in use.
  const base = compileTopology(project);
  const rulePrefixes = [];
  for (const dev of base.net.devices.values()) {
    for (const r of dev.acls || []) for (const c of [r.src, r.dst]) { const p = parse(c); if (p) rulePrefixes.push(p); }
  }
  const taken = new Set();
  for (const dev of base.net.devices.values()) for (const i of dev.ifaces.values()) if (i.ipInt != null) taken.add(intToIp(i.ipInt));
  const vlanSubnet = new Map((project?.settings?.vlans || []).filter((v) => v && v.id != null && v.subnet).map((v) => [String(v.id), String(v.subnet)]));
  const wanted = new Set();
  for (const p of list) for (const s of [p.from, p.to]) if (s.kind === 'vlan') wanted.add(String(s.vlan));
  const extraHosts = [];
  for (const vid of wanted) {
    const sn = vlanSubnet.get(vid);
    if (!sn) continue;
    probeAddresses(sn, rulePrefixes, taken).forEach((ip, k) => { taken.add(ip); extraHosts.push({ id: `probe-${vid}-${k}`, name: `probe ${ip}`, vlan: vid, ip }); });
  }

  // Pass 2: the plan plus the probe hosts.
  const compiled = extraHosts.length ? compileTopology(project, { extraHosts }) : base;
  const net = compiled.net;
  const hasCloud = [...net.devices.values()].some((d) => d.kind === 'cloud');

  const members = (sel, asSource) => {
    const out = [];
    if (sel.kind === 'vlan') {
      for (const [simId, m] of compiled.meta) if (ENDPOINT.has(m.type) && String(m.vlan) === String(sel.vlan) && m.ip && net.devices.has(simId)) out.push({ simId, ip: m.ip, name: m.name, synthetic: m.type === 'ghost' });
    } else if (sel.kind === 'device') {
      for (const simId of [`h:${sel.id}`, `m:${sel.id}`, `r:${sel.id}`]) {
        const dev = net.devices.get(simId);
        if (!dev) continue;
        for (const i of dev.ifaces.values()) if (i.ipInt != null) { out.push({ simId, ip: intToIp(i.ipInt), name: dev.name, synthetic: false }); if (asSource) break; }
      }
    } else if (sel.kind === 'mgmt') {
      for (const [simId, m] of compiled.meta) if (m.type === 'mgmt' && net.devices.has(simId)) out.push({ simId, ip: m.ip, name: `${m.name} (mgmt)`, synthetic: false });
      if (!asSource) for (const dev of net.devices.values()) if (dev.kind === 'router') for (const i of dev.ifaces.values()) if (i.ipInt != null) out.push({ simId: dev.id, ip: intToIp(i.ipInt), name: `${dev.name} ${i.name}`, synthetic: false });
    } else if (sel.kind === 'internet') {
      if (!asSource && hasCloud) out.push({ simId: null, ip: '8.8.8.8', name: 'Internet', synthetic: false });
    }
    return out;
  };

  const results = list.map((policy) => {
    const label = policy.name || policyLabel(policy);
    const srcs = members(policy.from, true);
    const dsts = members(policy.to, false);
    if (!srcs.length) return { policy, label, status: /** @type {'skipped'} */ ('skipped'), pairs: 0, reason: `nothing in the plan matches ${selectorLabel(policy.from)}`, violations: [] };
    if (!dsts.length) return { policy, label, status: /** @type {'skipped'} */ ('skipped'), pairs: 0, reason: `nothing in the plan matches ${selectorLabel(policy.to)}`, violations: [] };
    const l4 = (policy.proto === 'tcp' || policy.proto === 'udp') && Number(policy.port) >= 1;
    const violations = [];
    let pairs = 0;
    outer: for (const s of srcs) {
      for (const d of dsts) {
        if (s.ip === d.ip) continue;
        if (++pairs > MAX_PAIRS) { pairs--; break outer; }
        resetRuntime(net);
        let status;
        try {
          status = (l4 ? probe(net, { from: s.simId, to: d.ip, port: Number(policy.port), protocol: policy.proto }) : ping(net, { from: s.simId, to: d.ip })).status;
        } catch { status = 'unreachable'; }
        // "closed" still means the packet got there — the path is open.
        const reached = status === 'delivered' || status === 'closed';
        if (reached !== (policy.expect === 'allow')) violations.push({ from: s.name, fromIp: s.ip, to: d.name, toIp: d.ip, status, synthetic: s.synthetic || d.synthetic });
      }
    }
    return { policy, label, status: /** @type {'pass'|'fail'} */ (violations.length ? 'fail' : 'pass'), pairs, violations };
  });
  resetRuntime(net);
  return { results, probes: extraHosts.length };
}
