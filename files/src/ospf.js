// OSPF-style dynamic routing for the packet tracer — the control-plane result,
// computed as pure link-state math over a sim net (sim.js buildNet). It is not a
// packet-level protocol simulation (no Hellos/LSAs on the wire); it discovers
// adjacencies from shared subnets, builds the segment/router graph, runs Dijkstra
// from every router, and installs intra-area routes (kind 'ospf') into each
// router's RIB. The engine then forwards on them exactly like static routes, so
// a multi-router topology reaches end to end with no hand-written statics.
//
// Pure and self-contained: operates on a net's own device/interface structures
// (interface IPs are already integers there), mutates only `dev.routes`, and is
// deterministic (ties break by router id). Re-runnable: it clears its own prior
// 'ospf' routes first, so running after a config change reconverges cleanly.

import { intToIp } from './network.js';

function maskInt(prefix) {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
function netOf(ipInt, prefix) {
  return (ipInt & maskInt(prefix)) >>> 0;
}

// Default: every addressed, up interface on a router participates in OSPF.
function defaultEnabled(dev, iface) {
  return dev.kind === 'router' && iface.ipInt != null && iface.prefix != null && iface.up !== false;
}

/**
 * Compute and install OSPF routes across `net`.
 * @param {any} net                       a buildNet() network
 * @param {{cost?:number, enabled?:(dev:any,iface:any)=>boolean}} [opts]
 *   cost    per-interface metric (default 10, OSPF reference-style)
 *   enabled predicate selecting which interfaces run OSPF (default: all router IPs)
 * @returns {{installed:number, routers:number, segments:number}}
 */
export function runOspf(net, opts = {}) {
  const cost = opts.cost == null ? 10 : opts.cost;
  const isEnabled = opts.enabled || defaultEnabled;

  const routers = [...net.devices.values()].filter((d) => d.kind === 'router');

  // Segments: a subnet (net/prefix) and every router interface sitting on it.
  // Two routers sharing a segment are OSPF neighbors over it; a one-member
  // segment is a stub network (e.g. a host LAN behind its gateway router).
  const segments = new Map(); // "net/prefix" → { net, prefix, members:[{routerId, iface, ipInt}] }
  for (const dev of routers) {
    for (const i of dev.ifaces.values()) {
      if (!isEnabled(dev, i)) continue;
      const base = netOf(i.ipInt, i.prefix);
      const key = `${base}/${i.prefix}`;
      if (!segments.has(key)) segments.set(key, { net: base, prefix: i.prefix, members: [] });
      segments.get(key).members.push({ routerId: dev.id, iface: i.name, ipInt: i.ipInt });
    }
  }

  // Router adjacency graph: A→B over a shared segment, next hop = B's IP on it,
  // egress = A's interface on it, link cost = A's outgoing interface cost.
  const adj = new Map(); // routerId → [{ to, nextHopIp, egress, cost }]
  const addAdj = (from, edge) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(edge);
  };
  for (const seg of segments.values()) {
    if (seg.members.length < 2) continue;
    for (const a of seg.members) {
      for (const b of seg.members) {
        if (a.routerId === b.routerId) continue;
        addAdj(a.routerId, { to: b.routerId, nextHopIp: b.ipInt, egress: a.iface, cost });
      }
    }
  }

  let installed = 0;
  for (const src of routers) {
    // Dijkstra over routers from src (small graph → linear-scan frontier).
    const dist = new Map([[src.id, 0]]);
    const firstHop = new Map(); // routerId → { nextHopIp, egress } (first hop from src)
    const done = new Set();
    for (;;) {
      let u = null;
      let best = Infinity;
      for (const [rid, d] of dist) {
        if (!done.has(rid) && (d < best || (d === best && u != null && rid < u))) { u = rid; best = d; }
      }
      if (u == null) break;
      done.add(u);
      for (const e of adj.get(u) || []) {
        const nd = best + e.cost;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          firstHop.set(e.to, u === src.id ? { nextHopIp: e.nextHopIp, egress: e.egress } : firstHop.get(u));
        }
      }
    }

    // Networks src is directly connected to never get an OSPF route (connected
    // always wins); everything else is reachable via the nearest member router.
    const ownNets = new Set();
    for (const i of src.ifaces.values()) {
      if (i.ipInt != null && i.prefix != null) ownNets.add(`${netOf(i.ipInt, i.prefix)}/${i.prefix}`);
    }
    src.routes = src.routes.filter((r) => r.kind !== 'ospf');
    for (const seg of segments.values()) {
      if (ownNets.has(`${seg.net}/${seg.prefix}`)) continue;
      let pick = null;
      for (const m of seg.members) {
        if (m.routerId === src.id) continue;
        const d = dist.get(m.routerId);
        const fh = firstHop.get(m.routerId);
        if (d == null || !fh) continue;
        if (!pick || d < pick.metric) pick = { metric: d, fh };
      }
      if (pick) {
        src.routes.push({ net: seg.net, prefix: seg.prefix, via: pick.fh.nextHopIp, iface: pick.fh.egress, kind: 'ospf', metric: pick.metric });
        installed++;
      }
    }
  }

  return { installed, routers: routers.length, segments: segments.size };
}

// OSPF neighbors of `routerId`: the other routers that share one of its subnets
// (an adjacency would form there). Returns [{ id, name, ip }] — ip is the
// neighbor's address on the shared segment. For "show ip ospf neighbor".
export function ospfNeighbors(net, routerId, opts = {}) {
  const isEnabled = opts.enabled || defaultEnabled;
  const me = net.devices.get(routerId);
  if (!me || me.kind !== 'router') return [];
  const mySubnets = new Set();
  for (const i of me.ifaces.values()) {
    if (isEnabled(me, i)) mySubnets.add(`${netOf(i.ipInt, i.prefix)}/${i.prefix}`);
  }
  const out = [];
  for (const dev of net.devices.values()) {
    if (dev.kind !== 'router' || dev.id === routerId) continue;
    for (const i of dev.ifaces.values()) {
      if (!isEnabled(dev, i)) continue;
      if (mySubnets.has(`${netOf(i.ipInt, i.prefix)}/${i.prefix}`)) {
        out.push({ id: dev.id, name: dev.name, ip: intToIp(i.ipInt) });
        break;
      }
    }
  }
  return out;
}
