// Pure packet-forwarding simulation engine — a "packet tracer" core for Plexus.
// Compiles a normalised topology (devices + interfaces + links) and traces a
// packet's journey as an ordered, deterministic list of events suitable for
// step-through animation. No DOM, no randomness, no app globals.
//
// Scope (Phase 1): L2 switching with VLANs + MAC learning, ARP resolution,
// L3 forwarding over connected/static routes (longest-prefix match) with TTL,
// and ICMP ping + traceroute. Dynamic routing (OSPF/EIGRP/RIP) and per-vendor
// CLI config are deliberately NOT here — they are additive layers that feed the
// same routing tables / config model. The engine is vendor-neutral: a device's
// `vendor` ('cisco'|'mikrotik'|'generic') is metadata only; Cisco and MikroTik
// forward identically and differ solely in the CLI dialect built on top later.

import { ipToInt, intToIp } from './network.js';

const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';
const DEFAULT_TTL = 64;
const MAX_HOPS = 64; // hard loop guard, independent of a packet's TTL

// ── Prefix math ─────────────────────────────────────────────────────────────
// network.js#parseCidr caps at /30 (host-subnet planning); the sim needs the
// full /0–/32 range for router links, loopbacks and default routes, so prefix
// math lives here.
function maskInt(prefix) {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
function netOf(ipInt, prefix) {
  return (ipInt & maskInt(prefix)) >>> 0;
}
function parsePrefixCidr(cidr) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(String(cidr || '').trim());
  if (!m) return null;
  const base = ipToInt(m[1]);
  const prefix = parseInt(m[2], 10);
  if (base == null || prefix < 0 || prefix > 32) return null;
  return { net: netOf(base, prefix), prefix };
}

// ── Topology construction ────────────────────────────────────────────────────
// A net is built from a plain declarative spec so it is trivial to unit-test and
// so the Phase-2 adapter (Plexus project → sim net) has a single target shape.
//
//   spec = {
//     devices: [{
//       id, name, kind:'host'|'switch'|'router', vendor?,
//       ifaces: [{ name, mac?, ip?, prefix?,                 // routed / host NIC
//                  mode?:'access'|'trunk'|'routed', vlan?, allowed?:[vlan] }],
//       routes?: [{ cidr, via?, iface? }],                    // static routes (routers)
//       gateway?                                              // default gw (hosts)
//     }],
//     links: [['d1/eth0','d2/eth1'], ...]                     // iface refs 'devId/ifaceName'
//   }
//
// Connected routes are derived automatically from every iface that carries an
// ip+prefix; a host's gateway becomes a 0.0.0.0/0 default route.
export function buildNet(spec = {}) {
  const net = { devices: new Map(), _macSeq: 0 };

  for (const d of spec.devices || []) {
    if (!d || !d.id) throw new Error('device needs an id');
    if (net.devices.has(d.id)) throw new Error(`duplicate device id: ${d.id}`);
    const dev = {
      id: d.id,
      name: d.name || d.id,
      kind: d.kind || 'host',
      vendor: d.vendor || 'generic',
      ifaces: new Map(),
      routes: [], // {net, prefix, via:int|null, iface, kind:'connected'|'static'}
      arp: new Map(), // ipInt -> mac
      macTable: new Map(), // `${vlan}|${mac}` -> ifaceName  (switches only)
      acls: Array.isArray(d.acls) ? d.acls : [], // packet-filter rules (see aclEval)
      services: Array.isArray(d.services) ? d.services : [], // [{proto,port}] this host listens on
      nat: d.nat || null, // { inside:[cidr...], outsideIface } edge PAT, or null
    };
    net.devices.set(d.id, dev);

    for (const i of d.ifaces || []) {
      const mode = i.mode || (i.ip != null ? 'routed' : 'access');
      const iface = {
        name: i.name,
        device: d.id,
        mac: i.mac || nextMac(net),
        ipInt: i.ip != null ? ipToInt(i.ip) : null,
        prefix: i.prefix != null ? i.prefix : null,
        mode,
        vlan: i.vlan != null ? i.vlan : mode === 'access' ? 1 : null,
        allowed: new Set(i.allowed || []),
        up: i.up !== false,
      };
      if (iface.ipInt == null && (mode === 'routed' || dev.kind === 'host')) {
        // routed/host iface declared without an address is allowed but inert
      }
      dev.ifaces.set(iface.name, iface);
      // Connected route for any addressed iface.
      if (iface.ipInt != null && iface.prefix != null) {
        dev.routes.push({
          net: netOf(iface.ipInt, iface.prefix),
          prefix: iface.prefix,
          via: null,
          iface: iface.name,
          kind: 'connected',
        });
      }
    }

    for (const r of d.routes || []) {
      const c = parsePrefixCidr(r.cidr);
      if (!c) throw new Error(`${d.id}: bad route cidr ${r.cidr}`);
      dev.routes.push({
        net: c.net,
        prefix: c.prefix,
        via: r.via != null ? ipToInt(r.via) : null,
        iface: r.iface || null,
        kind: 'static',
      });
    }

    if (d.gateway != null) {
      dev.routes.push({
        net: 0,
        prefix: 0,
        via: ipToInt(d.gateway),
        iface: firstAddressedIface(dev),
        kind: 'static',
      });
    }
  }

  for (const [a, b] of spec.links || []) {
    connect(net, a, b);
  }
  return net;
}

function nextMac(net) {
  const n = net._macSeq++;
  const hex = n.toString(16).padStart(4, '0');
  return `02:00:00:00:${hex.slice(0, 2)}:${hex.slice(2)}`;
}

function firstAddressedIface(dev) {
  for (const [name, i] of dev.ifaces) if (i.ipInt != null) return name;
  return dev.ifaces.size ? [...dev.ifaces.keys()][0] : null;
}

function parseRef(ref) {
  const i = String(ref).indexOf('/');
  if (i < 0) throw new Error(`bad iface ref: ${ref}`);
  return { dev: ref.slice(0, i), iface: ref.slice(i + 1) };
}

export function connect(net, aRef, bRef) {
  const a = parseRef(aRef);
  const b = parseRef(bRef);
  const ia = net.devices.get(a.dev)?.ifaces.get(a.iface);
  const ib = net.devices.get(b.dev)?.ifaces.get(b.iface);
  if (!ia) throw new Error(`no such iface: ${aRef}`);
  if (!ib) throw new Error(`no such iface: ${bRef}`);
  ia.peer = { dev: b.dev, iface: b.iface };
  ib.peer = { dev: a.dev, iface: a.iface };
}

// Clear all learned (data-plane) state: MAC tables and ARP caches. The control
// plane (routes, addresses, links) is untouched. Learning otherwise persists
// across simulate() calls, as on real gear (a warm ARP cache skips re-ARP).
export function resetRuntime(net) {
  for (const dev of net.devices.values()) {
    dev.arp.clear();
    dev.macTable.clear();
  }
}

// ── L2: frame delivery across a switched segment ─────────────────────────────
// Push one frame out `egressIface` of `srcDev` and walk it through the switch
// fabric, learning source MACs and forwarding/flooding per VLAN, until it
// reaches the NIC(s) of non-switch devices. Returns those endpoints as
// [{dev, iface}]. Events are appended for every hop.
function deliverFrame(net, srcDevId, egressIfaceName, frame, events) {
  const srcDev = net.devices.get(srcDevId);
  const egress = srcDev.ifaces.get(egressIfaceName);
  if (!egress || !egress.up || !egress.peer) return [];

  const endpoints = [];
  const visited = new Set(); // `${dev}/${iface}` ingress ports already processed
  // Queue entries: a frame arriving on an ingress port, carrying an internal
  // VLAN id. `vlan` is the segment VLAN the frame currently belongs to.
  const queue = [{ dev: egress.peer.dev, iface: egress.peer.iface, vlan: frame.vlan }];

  while (queue.length) {
    const hop = queue.shift();
    const key = `${hop.dev}/${hop.iface}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const dev = net.devices.get(hop.dev);
    const port = dev.ifaces.get(hop.iface);
    if (!port || !port.up) continue;

    // A non-switch device: the frame has reached a host/router NIC.
    if (dev.kind !== 'switch') {
      endpoints.push({ dev: hop.dev, iface: hop.iface });
      continue;
    }

    // Determine the internal VLAN this frame occupies on ingress.
    let vlan;
    if (port.mode === 'trunk') {
      vlan = hop.vlan != null ? hop.vlan : 1;
      if (port.allowed.size && !port.allowed.has(vlan)) {
        events.push(ev('l2-drop-vlan', dev, port, { vlan }));
        continue;
      }
    } else {
      vlan = port.vlan != null ? port.vlan : 1;
    }

    // Learn the source MAC on this ingress port for this VLAN.
    const learnKey = `${vlan}|${frame.srcMac}`;
    if (dev.macTable.get(learnKey) !== port.name) {
      dev.macTable.set(learnKey, port.name);
      events.push(ev('l2-learn', dev, port, { vlan, mac: frame.srcMac }));
    }

    // Choose egress ports within this VLAN.
    const known =
      frame.dstMac !== BROADCAST_MAC ? dev.macTable.get(`${vlan}|${frame.dstMac}`) : null;
    const flood = !known;
    events.push(
      ev(flood ? 'l2-flood' : 'l2-forward', dev, port, { vlan, dstMac: frame.dstMac })
    );

    for (const out of dev.ifaces.values()) {
      if (out.name === port.name || !out.up || !out.peer) continue;
      if (!known && !portInVlan(out, vlan)) continue; // flood: same-VLAN ports only
      if (known && out.name !== known) continue; // known unicast: the one learned port
      queue.push({ dev: out.peer.dev, iface: out.peer.iface, vlan });
    }
  }
  return endpoints;
}

function portInVlan(port, vlan) {
  if (port.mode === 'trunk') return !port.allowed.size || port.allowed.has(vlan);
  return (port.vlan != null ? port.vlan : 1) === vlan;
}

// ── ARP ──────────────────────────────────────────────────────────────────────
// Resolve `targetIp` reachable out `egressIfaceName` of `dev`. Returns the MAC
// or null. Populates both ends' ARP caches and lets intermediate switches learn
// the responder's MAC (so the following unicast need not flood).
function arpResolve(net, dev, egressIfaceName, targetIp, events) {
  if (dev.arp.has(targetIp)) {
    events.push(ev('arp-cached', dev, dev.ifaces.get(egressIfaceName), { ip: intToIp(targetIp) }));
    return dev.arp.get(targetIp);
  }
  const egress = dev.ifaces.get(egressIfaceName);
  if (!egress || !egress.up) return null;

  events.push(ev('arp-request', dev, egress, { who: intToIp(targetIp) }));
  const request = { srcMac: egress.mac, dstMac: BROADCAST_MAC, vlan: egress.vlan };
  const reached = deliverFrame(net, dev.id, egressIfaceName, request, events);

  // The endpoint that owns targetIp answers.
  for (const ep of reached) {
    const peerDev = net.devices.get(ep.dev);
    const peerIface = peerDev.ifaces.get(ep.iface);
    if (peerIface.ipInt === targetIp) {
      dev.arp.set(targetIp, peerIface.mac);
      peerDev.arp.set(egress.ipInt, egress.mac); // responder learns us too
      events.push(ev('arp-reply', peerDev, peerIface, { ip: intToIp(targetIp), mac: peerIface.mac }));
      // Send the unicast reply back so switches learn the responder's MAC.
      deliverFrame(net, ep.dev, ep.iface, { srcMac: peerIface.mac, dstMac: egress.mac, vlan: peerIface.vlan }, events);
      return peerIface.mac;
    }
  }
  return null;
}

// ── L3: routing ──────────────────────────────────────────────────────────────
// Longest-prefix match over a device's routes; connected wins ties with static.
function lookupRoute(dev, dstIp) {
  let best = null;
  for (const r of dev.routes) {
    if (netOf(dstIp, r.prefix) !== r.net) continue;
    if (
      !best ||
      r.prefix > best.prefix ||
      (r.prefix === best.prefix && r.kind === 'connected' && best.kind !== 'connected')
    ) {
      best = r;
    }
  }
  return best;
}

function ownsIp(dev, ip) {
  for (const i of dev.ifaces.values()) if (i.ipInt === ip) return i;
  return null;
}

// The local interface whose connected subnet contains `ip` (used to resolve the
// egress port of a next-hop static route, as a router's RIB does).
function ifaceForIp(dev, ip) {
  for (const [name, i] of dev.ifaces) {
    if (i.ipInt == null || i.prefix == null) continue;
    if (netOf(ip, i.prefix) === netOf(i.ipInt, i.prefix)) return name;
  }
  return null;
}

// True when `ipInt` falls inside `cidr` ("any"/null matches everything).
function cidrContains(ipInt, cidr) {
  if (cidr == null || cidr === 'any') return true;
  const c = parsePrefixCidr(cidr);
  if (!c) return false;
  return netOf(ipInt, c.prefix) === c.net;
}

// First-match packet-filter. Rules: {action:'permit'|'deny', proto?:'ip'|'icmp'|
// 'tcp'|'udp', src?:cidr|'any', dst?:cidr|'any', dport?:number}. No match → permit
// (add an explicit `deny any` rule for Cisco-style default-deny).
function aclEval(rules, pkt) {
  for (const r of rules) {
    if (r.proto && r.proto !== 'ip' && r.proto !== 'any' && r.proto !== pkt.protocol) continue;
    if (!cidrContains(pkt.srcIp, r.src)) continue;
    if (!cidrContains(pkt.dstIp, r.dst)) continue;
    if (r.dport != null && r.dport !== pkt.dport) continue;
    return r.action === 'deny' ? 'deny' : 'permit';
  }
  return 'permit';
}

// Forward `pkt` one device at a time. `pkt` = {srcIp, dstIp, ttl, type, protocol,
// dport?}. Returns {status, hopIp?} — status 'delivered' | 'unreachable' |
// 'ttl-exceeded' | 'filtered' | 'closed'. `hops` guards routing loops.
function forward(net, dev, pkt, events, hops = 0) {
  if (hops > MAX_HOPS) return { status: 'unreachable' };

  // Inbound packet filter (ACL / firewall) on this device.
  if (dev.acls && dev.acls.length && aclEval(dev.acls, pkt) === 'deny') {
    events.push(ev('acl-drop', dev, null, { proto: pkt.protocol, dst: intToIp(pkt.dstIp), port: pkt.dport }));
    return { status: 'filtered' };
  }

  // Destined for this device?
  const mine = ownsIp(dev, pkt.dstIp);
  if (mine) {
    if (pkt.type === 'echo-request') {
      events.push(ev('icmp-echo', dev, mine, { from: intToIp(pkt.srcIp) }));
      const reply = { srcIp: pkt.dstIp, dstIp: pkt.srcIp, ttl: DEFAULT_TTL, type: 'echo-reply', protocol: 'icmp' };
      return forward(net, dev, reply, events, hops + 1);
    }
    if (pkt.type === 'l4-request') {
      const listening = (dev.services || []).some((s) => s.proto === pkt.protocol && s.port === pkt.dport);
      events.push(ev(listening ? 'l4-open' : 'l4-closed', dev, mine, { proto: pkt.protocol, port: pkt.dport, from: intToIp(pkt.srcIp) }));
      if (!listening) return { status: 'closed' };
      const reply = { srcIp: pkt.dstIp, dstIp: pkt.srcIp, ttl: DEFAULT_TTL, type: 'l4-reply', protocol: pkt.protocol, dport: pkt.dport };
      return forward(net, dev, reply, events, hops + 1);
    }
    events.push(ev(pkt.type === 'l4-reply' ? 'l4-reply' : 'icmp-reply', dev, mine, { from: intToIp(pkt.srcIp) }));
    return { status: 'delivered' };
  }

  const route = lookupRoute(dev, pkt.dstIp);
  if (!route) {
    events.push(ev('l3-no-route', dev, null, { dst: intToIp(pkt.dstIp) }));
    return { status: 'unreachable' };
  }
  // The next hop is the route's gateway, or the destination itself on a
  // connected route. A static route given only by next-hop carries no egress
  // iface; derive it from whichever connected subnet the next-hop sits in.
  const nextHopIp = route.via != null ? route.via : pkt.dstIp;
  const egressName = route.iface || ifaceForIp(dev, nextHopIp);
  const egress = egressName ? dev.ifaces.get(egressName) : null;
  if (!egress) {
    events.push(ev('l3-no-route', dev, null, { dst: intToIp(pkt.dstIp) }));
    return { status: 'unreachable' };
  }
  events.push(
    ev('l3-route', dev, egress, {
      dst: intToIp(pkt.dstIp),
      via: route.via != null ? intToIp(route.via) : 'connected',
      routeKind: route.kind, // NOT `kind` — that key is the event type and must not be shadowed
    })
  );

  // A router decrements TTL at each hop; a host originating a packet does not.
  // TTL reaching 0 after the decrement means the hop budget is spent — the
  // router drops it and would emit ICMP time-exceeded (this is what traceroute
  // walks). Expiring at <=0 makes TTL=1 stop at the first router.
  if (dev.kind !== 'host' || pkt._forwarded) {
    pkt.ttl -= 1;
    if (pkt.ttl <= 0) {
      events.push(ev('ttl-expired', dev, null, { dst: intToIp(pkt.dstIp) }));
      return { status: 'ttl-exceeded', hopIp: ownHopIp(dev) };
    }
  }

  const mac = arpResolve(net, dev, egressName, nextHopIp, events);
  if (!mac) {
    events.push(ev('arp-fail', dev, egress, { ip: intToIp(nextHopIp) }));
    return { status: 'unreachable' };
  }

  const frame = { srcMac: egress.mac, dstMac: mac, vlan: egress.vlan };
  const reached = deliverFrame(net, dev.id, egressName, frame, events);
  const nextDev = reached
    .map((ep) => net.devices.get(ep.dev))
    .find((d) => d && [...d.ifaces.values()].some((i) => i.mac === mac));
  if (!nextDev) return { status: 'unreachable' };

  pkt._forwarded = true;
  return forward(net, nextDev, pkt, events, hops + 1);
}

function ownHopIp(dev) {
  const i = firstAddressedIface(dev);
  return i ? intToIp(dev.ifaces.get(i).ipInt) : null;
}

// ── Public simulation API ────────────────────────────────────────────────────
// Trace an ICMP echo from device `from` to IP `to`. Returns:
//   { ok, status, events } where status mirrors forward()'s.
/** @param {{from:string, to:string, ttl?:number}} opts */
export function ping(net, opts) {
  const { from, to, ttl = DEFAULT_TTL } = opts;
  const src = net.devices.get(from);
  if (!src) throw new Error(`no such device: ${from}`);
  const dstIp = ipToInt(to);
  if (dstIp == null) throw new Error(`bad destination ip: ${to}`);
  const srcIfaceName = firstAddressedIface(src);
  const srcIp = srcIfaceName ? src.ifaces.get(srcIfaceName).ipInt : null;
  if (srcIp == null) throw new Error(`${from} has no addressed interface`);

  const events = [];
  events.push(ev('host-send', src, src.ifaces.get(srcIfaceName), { to }));
  const pkt = { srcIp, dstIp, ttl, type: 'echo-request', protocol: 'icmp' };
  const res = forward(net, src, pkt, events, 0);
  return { ok: res.status === 'delivered', status: res.status, events };
}

// Probe an L4 service: does a tcp/udp connection from `from` to `to:port` succeed?
// Returns { ok, status, events } where status is 'delivered' (open), 'closed'
// (reached but nothing listening), 'filtered' (ACL drop), or an unreachable code.
/** @param {{from:string, to:string, port:number, protocol?:string, ttl?:number}} opts */
export function probe(net, opts) {
  const { from, to, port, protocol = 'tcp', ttl = DEFAULT_TTL } = opts;
  const src = net.devices.get(from);
  if (!src) throw new Error(`no such device: ${from}`);
  const dstIp = ipToInt(to);
  if (dstIp == null) throw new Error(`bad destination ip: ${to}`);
  const srcIfaceName = firstAddressedIface(src);
  const srcIp = srcIfaceName ? src.ifaces.get(srcIfaceName).ipInt : null;
  if (srcIp == null) throw new Error(`${from} has no addressed interface`);

  const events = [];
  events.push(ev('host-send', src, src.ifaces.get(srcIfaceName), { to, port, protocol }));
  const pkt = { srcIp, dstIp, ttl, type: 'l4-request', protocol, dport: port };
  const res = forward(net, src, pkt, events, 0);
  return { ok: res.status === 'delivered', status: res.status, events };
}

// Discover the hops to `to` by sending probes with increasing TTL. Returns an
// ordered list of { ttl, ip|null, reached } — `reached` true on the final hop.
/** @param {{from:string, to:string, maxHops?:number}} opts */
export function traceroute(net, opts) {
  const { from, to, maxHops = 30 } = opts;
  const hops = [];
  for (let ttl = 1; ttl <= maxHops; ttl++) {
    const events = [];
    const src = net.devices.get(from);
    const srcIfaceName = firstAddressedIface(src);
    const srcIp = src.ifaces.get(srcIfaceName).ipInt;
    const pkt = { srcIp, dstIp: ipToInt(to), ttl, type: 'echo-request' };
    const res = forward(net, src, pkt, events, 0);
    if (res.status === 'ttl-exceeded') {
      hops.push({ ttl, ip: res.hopIp, reached: false });
    } else if (res.status === 'delivered') {
      hops.push({ ttl, ip: to, reached: true });
      break;
    } else {
      hops.push({ ttl, ip: null, reached: false });
      break;
    }
  }
  return hops;
}

// ── Event helper ─────────────────────────────────────────────────────────────
// One animation/trace step. Kept small and serialisable so the UI can replay it.
let _seq = 0;
function ev(kind, dev, iface, detail = {}) {
  return {
    seq: _seq++,
    kind,
    dev: dev ? dev.id : null,
    devName: dev ? dev.name : null,
    iface: iface ? iface.name : null,
    ...detail,
  };
}
