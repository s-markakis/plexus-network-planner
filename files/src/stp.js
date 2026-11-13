// Spanning tree for the packet tracer — the converged result, computed as pure
// graph math over a sim net (like ospf.js: no BPDUs on the wire). Among the
// switches it elects a root bridge (lowest priority, then lowest id), keeps the
// shortest path from every switch to the root, and puts every other
// switch-to-switch link into the discarding state on its non-designated end.
// The engine's L2 forwarding skips blocked ports, so a plan with redundant
// uplinks forwards loop-free — and when a link fails, re-running this unblocks
// the backup path.
//
// Pure, deterministic, idempotent (clears its own previous result first).

const DEFAULT_PRIORITY = 32768;

/**
 * @param {any} net  a buildNet() network
 * @param {{priority?:(dev:any)=>number}} [opts]  bridge priority per switch
 * @returns {{roots:string[], blocked:Array<{dev:string, iface:string}>, ports:Array<{dev:string,iface:string,role:string}>}}
 */
export function runStp(net, opts = {}) {
  const prio = (dev) => {
    const p = opts.priority ? Number(opts.priority(dev)) : DEFAULT_PRIORITY;
    return Number.isFinite(p) && p >= 0 ? p : DEFAULT_PRIORITY;
  };
  const switches = [...net.devices.values()].filter((d) => d.kind === 'switch');
  const isSw = (id) => net.devices.get(id)?.kind === 'switch';
  // Bridge id ordering: priority first, then the device id (stands in for the MAC).
  const less = (a, b) => (prio(a) !== prio(b) ? prio(a) < prio(b) : a.id < b.id);

  // Usable inter-switch links: both ends up. Each physical link once.
  const links = [];
  for (const dev of switches) {
    for (const i of dev.ifaces.values()) {
      i.blocked = false;
      if (!i.peer || !isSw(i.peer.dev) || i.up === false) continue;
      const peer = net.devices.get(i.peer.dev).ifaces.get(i.peer.iface);
      if (!peer || peer.up === false) continue;
      const key = [`${dev.id}/${i.name}`, `${i.peer.dev}/${i.peer.iface}`].sort().join('|');
      if (!links.some((l) => l.key === key)) links.push({ key, a: { dev: dev.id, iface: i.name }, b: { dev: i.peer.dev, iface: i.peer.iface } });
    }
  }
  links.sort((x, y) => (x.key < y.key ? -1 : 1));

  const dist = new Map(); // switch id → hops to its root
  const treeLink = new Map(); // switch id → the link (key) it reaches its root through
  const roots = [];
  const remaining = new Set(switches.map((s) => s.id));
  while (remaining.size) {
    // Root of this (connected) component: the best bridge id still unvisited.
    let root = null;
    for (const id of remaining) { const d = net.devices.get(id); if (!root || less(d, root)) root = d; }
    roots.push(root.id);
    dist.set(root.id, 0);
    remaining.delete(root.id);
    let frontier = [root.id];
    while (frontier.length) {
      // Candidates one hop out; a switch reachable through several parents picks
      // the parent with the best bridge id (deterministic root port).
      const next = new Map();
      for (const id of frontier) {
        for (const l of links) {
          const other = l.a.dev === id ? l.b.dev : l.b.dev === id ? l.a.dev : null;
          if (!other || dist.has(other)) continue;
          const cur = next.get(other);
          if (!cur || less(net.devices.get(id), net.devices.get(cur.parent)) || (id === cur.parent && l.key < cur.key)) next.set(other, { parent: id, key: l.key });
        }
      }
      frontier = [];
      for (const [id, v] of next) {
        dist.set(id, dist.get(v.parent) + 1);
        treeLink.set(id, v.key);
        remaining.delete(id);
        frontier.push(id);
      }
      frontier.sort();
    }
  }

  const onTree = new Set(treeLink.values());
  const blocked = [];
  const ports = [];
  for (const l of links) {
    if (onTree.has(l.key)) {
      // The end farther from the root holds the root port.
      const aFar = dist.get(l.a.dev) > dist.get(l.b.dev);
      ports.push({ ...(aFar ? l.a : l.b), role: 'root' }, { ...(aFar ? l.b : l.a), role: 'designated' });
      continue;
    }
    // Redundant link: the end with the worse (distance, bridge id) discards.
    const A = net.devices.get(l.a.dev), B = net.devices.get(l.b.dev);
    const aWorse = dist.get(A.id) !== dist.get(B.id) ? dist.get(A.id) > dist.get(B.id) : less(B, A);
    const lose = aWorse ? l.a : l.b, keep = aWorse ? l.b : l.a;
    net.devices.get(lose.dev).ifaces.get(lose.iface).blocked = true;
    blocked.push(lose);
    ports.push({ ...lose, role: 'blocked' }, { ...keep, role: 'designated' });
  }
  return { roots, blocked, ports };
}
