// RIP-style distance-vector routing for the packet tracer — the converged result
// as pure math over a sim net. Like ospf.js but the metric is hop count and the
// reach is capped at 15 hops (16 = infinity = unreachable), the defining RIP
// trait. Discovers adjacencies from shared subnets, finds the fewest-hops path
// from each router, and installs kind:'rip' routes into the RIBs.
//
// Pure, deterministic (ties by router id), idempotent (clears its own prior 'rip'
// routes). A small amount of segment/adjacency setup is shared in spirit with
// ospf.js but kept local so each protocol module reads on its own.

function maskInt(prefix) {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
function netOf(ipInt, prefix) {
  return (ipInt & maskInt(prefix)) >>> 0;
}
function defaultEnabled(dev, iface) {
  return dev.kind === 'router' && iface.ipInt != null && iface.prefix != null && iface.up !== false;
}

/**
 * @param {any} net
 * @param {{maxMetric?:number, enabled?:(dev:any,iface:any)=>boolean}} [opts]
 *   maxMetric RIP infinity threshold (default 15; a route needing more is dropped)
 * @returns {{installed:number, routers:number, unreachable:number}}
 */
export function runRip(net, opts = {}) {
  const maxMetric = opts.maxMetric == null ? 15 : opts.maxMetric;
  const isEnabled = opts.enabled || defaultEnabled;

  const routers = [...net.devices.values()].filter((d) => d.kind === 'router');

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

  const adj = new Map(); // routerId → [{ to, nextHopIp, egress }]
  for (const seg of segments.values()) {
    if (seg.members.length < 2) continue;
    for (const a of seg.members) {
      for (const b of seg.members) {
        if (a.routerId === b.routerId) continue;
        if (!adj.has(a.routerId)) adj.set(a.routerId, []);
        adj.get(a.routerId).push({ to: b.routerId, nextHopIp: b.ipInt, egress: a.iface });
      }
    }
  }

  let installed = 0;
  let unreachable = 0;
  for (const src of routers) {
    // Fewest-hops BFS (unit cost per router traversed) from src.
    const dist = new Map([[src.id, 0]]);
    const firstHop = new Map();
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
        const nd = best + 1;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          firstHop.set(e.to, u === src.id ? { nextHopIp: e.nextHopIp, egress: e.egress } : firstHop.get(u));
        }
      }
    }

    const ownNets = new Set();
    for (const i of src.ifaces.values()) {
      if (i.ipInt != null && i.prefix != null) ownNets.add(`${netOf(i.ipInt, i.prefix)}/${i.prefix}`);
    }
    src.routes = src.routes.filter((r) => r.kind !== 'rip');
    for (const seg of segments.values()) {
      if (ownNets.has(`${seg.net}/${seg.prefix}`)) continue;
      let pick = null;
      for (const m of seg.members) {
        if (m.routerId === src.id) continue;
        const d = dist.get(m.routerId);
        const fh = firstHop.get(m.routerId);
        if (d == null || !fh) continue;
        const metric = d + 1; // +1 hop into the destination network
        if (!pick || metric < pick.metric) pick = { metric, fh };
      }
      if (!pick) continue;
      if (pick.metric > maxMetric) { unreachable++; continue; } // RIP infinity
      src.routes.push({ net: seg.net, prefix: seg.prefix, via: pick.fh.nextHopIp, iface: pick.fh.egress, kind: 'rip', metric: pick.metric });
      installed++;
    }
  }

  return { installed, routers: routers.length, unreachable };
}
