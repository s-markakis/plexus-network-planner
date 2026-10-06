// Adapter: a Plexus project → the sim engine's normalised topology.
// Keeps sim.js a pure engine; this is the only module that knows the project
// schema (floors with SWS/APS/CAMS, settings.vlans). Returns the built net plus
// `meta` (sim-id → source device, incl. fx/fy for canvas animation) and
// `warnings` for anything that couldn't be mapped.
//
// What the project expresses today is an L2 plan: switches (SWS) linked by
// `uplinkId`, endpoints (APS/CAMS) on a switch access port in a VLAN with an IP,
// and VLAN→subnet in settings.vlans. There is no router/gateway in the schema,
// so inter-VLAN traffic compiles to "no route" — which is the truth about the
// plan, and a useful thing for the simulator to show. A gateway/L3 device is a
// later schema addition (Phase 3/4), at which point this adapter grows a case.

import { buildNet } from './sim.js';
import { runOspf } from './ospf.js';
import { normName } from './dns.js';
import { ipToInt } from './network.js';

const validIp = (s) => s != null && s !== '' && ipToInt(s) != null;
const sameSubnet = (ipA, pA, ipB, pB) => {
  if (pA !== pB) return false;
  const a = ipToInt(ipA);
  const b = ipToInt(ipB);
  if (a == null || b == null) return false;
  const mask = pA <= 0 ? 0 : (0xffffffff << (32 - pA)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
};

function vendorOf(model = '') {
  const m = String(model).toLowerCase();
  if (/\b(mikrotik|routeros|rb\d|crs\d|ccr\d|hap|cap ?ac)\b/.test(m)) return 'mikrotik';
  if (/\b(cisco|catalyst|nexus|meraki|ws-c|c9\d{3}|cbs\d)\b/.test(m)) return 'cisco';
  return 'generic';
}

function prefixOfSubnet(subnet = '') {
  const m = /\/(\d+)\s*$/.exec(String(subnet));
  if (!m) return null;
  const p = parseInt(m[1], 10);
  return p >= 0 && p <= 32 ? p : null;
}

// A switch may carry a CLI running-config (sw.cli, shape from cli.js newConfig).
// These read it defensively — a half-typed or malformed config must never throw.
// SVIs = addressed interfaces that belong to a VLAN (the L3 gateway for it).
function cliSvis(sw) {
  const cfg = sw && sw.cli;
  if (!cfg || typeof cfg !== 'object' || !cfg.interfaces) return [];
  const out = [];
  for (const i of Object.values(cfg.interfaces)) {
    if (i && i.vlan != null && validIp(i.ip) && Number.isFinite(i.prefix)) {
      out.push({ vlan: Number(i.vlan), ip: i.ip, prefix: i.prefix });
    }
  }
  return out;
}
function cliRoutes(sw) {
  const cfg = sw && sw.cli;
  if (!cfg || !Array.isArray(cfg.routes)) return [];
  return cfg.routes
    .filter((r) => r && typeof r.cidr === 'string' && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(r.cidr) && validIp(r.via))
    .map((r) => ({ cidr: r.cidr, via: r.via }));
}
// Routed L3 interfaces (addressed, no VLAN) — used for routed inter-switch links.
function cliRoutedIfaces(sw) {
  const cfg = sw && sw.cli;
  if (!cfg || typeof cfg !== 'object' || !cfg.interfaces) return [];
  const out = [];
  for (const i of Object.values(cfg.interfaces)) {
    if (i && i.vlan == null && validIp(i.ip) && Number.isFinite(i.prefix)) {
      out.push({ name: i.name, ip: i.ip, prefix: i.prefix, up: i.shutdown !== true });
    }
  }
  return out;
}
function cliOspfEnabled(sw) {
  return !!(sw && sw.cli && sw.cli.ospf && sw.cli.ospf.enabled);
}
// Packet-filter rules from a CLI config (access-list / firewall filter).
function cliAcls(sw) {
  const cfg = sw && sw.cli;
  if (!cfg || !Array.isArray(cfg.acls)) return [];
  return cfg.acls.filter((r) => r && (r.action === 'permit' || r.action === 'deny'));
}

/**
 * @param {any} project
 * @returns {{net:any, spec:any, meta:Map<string,any>, warnings:string[], ospfRouters:string[], dns:Record<string,string>}}
 */
export function compileTopology(project) {
  const warnings = [];
  const meta = new Map();
  const devices = [];
  const links = [];

  // VLAN id (string) → { prefix, gateway } from settings.vlans. `gateway` is the
  // SVI address an L3 device owns and hosts use as their default route. Bad
  // subnets/gateways are warned and dropped, never trusted into the topology.
  const vlanInfo = new Map();
  for (const v of project?.settings?.vlans || []) {
    if (!v || v.id == null) continue;
    const p = prefixOfSubnet(v.subnet);
    if (p == null) {
      if (v.subnet) warnings.push(`VLAN ${v.id}: invalid subnet ${v.subnet} — ignored`);
      continue;
    }
    let gateway = v.gateway || '';
    if (gateway && !validIp(gateway)) {
      warnings.push(`VLAN ${v.id}: invalid gateway IP ${gateway} — ignored`);
      gateway = '';
    }
    vlanInfo.set(String(v.id), { prefix: p, gateway });
  }

  // Gather switches + endpoints across every floor (the plan is multi-floor but
  // the network is one fabric). Device ids become sim-device keys, so a missing
  // or duplicate id would collide in buildNet — skip and warn instead of letting
  // it throw, since this runs on live (possibly half-edited) plan data.
  const switches = [];
  const endpoints = [];
  const seenSw = new Set();
  const seenEp = new Set();
  for (const f of project?.floors || []) {
    for (const sw of f.SWS || []) {
      if (!sw || !sw.id) { warnings.push(`switch ${(sw && sw.name) || '(unnamed)'}: missing id — skipped`); continue; }
      if (seenSw.has(sw.id)) { warnings.push(`switch ${sw.name || sw.id}: duplicate id ${sw.id} — skipped`); continue; }
      seenSw.add(sw.id);
      switches.push({ sw, floorId: f.id });
    }
    for (const [list, type] of [[f.APS, 'ap'], [f.CAMS, 'camera']]) {
      for (const ep of list || []) {
        if (!ep || !ep.id) { warnings.push(`${type} ${(ep && ep.name) || '(unnamed)'}: missing id — skipped`); continue; }
        if (seenEp.has(ep.id)) { warnings.push(`${type} ${ep.name || ep.id}: duplicate id ${ep.id} — skipped`); continue; }
        seenEp.add(ep.id);
        endpoints.push({ ep, type, floorId: f.id });
      }
    }
  }
  const swById = new Map(switches.map((s) => [s.sw.id, s]));

  // Fold in per-device CLI configs (Phase 3b). A CLI SVI supplies a VLAN's
  // gateway when settings didn't, and marks the switch that will host that SVI
  // (settings-defined gateways win and are hosted by a role:'l3' switch). An
  // unknown VLAN referenced only by CLI is registered so it still works.
  const cliOwner = new Map(); // vlan id (string) → switch id hosting its SVI
  for (const { sw } of switches) {
    for (const svi of cliSvis(sw)) {
      const vid = String(svi.vlan);
      if (!vlanInfo.has(vid)) vlanInfo.set(vid, { prefix: svi.prefix, gateway: '' });
      const info = vlanInfo.get(vid);
      if (!info.gateway) info.gateway = svi.ip; // settings gateway wins; else CLI provides
      if (!cliOwner.has(vid) && info.gateway === svi.ip) cliOwner.set(vid, sw.id);
    }
  }
  const allVlans = [...new Set([...vlanInfo.keys()].map(Number).concat(1))];

  // Per-switch interface list, accumulated as we wire endpoints and uplinks.
  const swIfaces = new Map();
  const ifacesOf = (id) => {
    if (!swIfaces.has(id)) swIfaces.set(id, []);
    return swIfaces.get(id);
  };
  const hasPort = (id, name) => ifacesOf(id).some((i) => i.name === name);

  // Endpoints → host devices on switch access ports.
  for (const { ep, type, floorId } of endpoints) {
    const label = ep.name || ep.id;
    if (!ep.swId || !swById.has(ep.swId)) {
      warnings.push(`${type} ${label}: not attached to a known switch — skipped`);
      continue;
    }
    if (!ep.ip) {
      warnings.push(`${type} ${label}: no IP — skipped`);
      continue;
    }
    if (!validIp(ep.ip)) {
      warnings.push(`${type} ${label}: invalid IP ${ep.ip} — skipped`);
      continue;
    }
    const vlan = ep.vlan && Number.isFinite(Number(ep.vlan)) ? Number(ep.vlan) : 1;
    const info = vlanInfo.get(String(ep.vlan));
    const prefix = info?.prefix ?? 24;
    const portName = `p${ep.port || `-${ep.id}`}`;
    if (hasPort(ep.swId, portName)) {
      warnings.push(`${type} ${label}: port ${ep.port} on ${ep.swId} already used — skipped`);
      continue;
    }
    const hostId = `h:${ep.id}`;
    const iface = { name: 'eth0', ip: ep.ip, prefix };
    if (ep.mac) iface.mac = ep.mac;
    const host = { id: hostId, name: label, kind: 'host', vendor: vendorOf(ep.model), ifaces: [iface] };
    if (info?.gateway) host.gateway = info.gateway; // default route toward the L3 device
    devices.push(host);
    meta.set(hostId, { type, srcId: ep.id, name: label, fx: ep.fx, fy: ep.fy, floorId, ip: ep.ip, vlan });
    ifacesOf(ep.swId).push({ name: portName, mode: 'access', vlan });
    links.push([`${hostId}/eth0`, `sw:${ep.swId}/${portName}`]);
  }

  // Uplinks → trunk links between switches (carry every known VLAN). A routed
  // uplink (uplinkMode 'routed') is an L3 point-to-point handled after routers exist.
  for (const { sw } of switches) {
    if (!sw.uplinkId || sw.uplinkMode === 'routed') continue;
    if (!swById.has(sw.uplinkId)) {
      warnings.push(`switch ${sw.name || sw.id}: uplink target ${sw.uplinkId} not found`);
      continue;
    }
    const near = `up_${sw.uplinkId}`;
    const far = `up_${sw.id}`;
    ifacesOf(sw.id).push({ name: near, mode: 'trunk', allowed: allVlans });
    ifacesOf(sw.uplinkId).push({ name: far, mode: 'trunk', allowed: allVlans });
    links.push([`sw:${sw.id}/${near}`, `sw:${sw.uplinkId}/${far}`]);
  }

  // L3 devices. A switch routes between VLANs — becoming a sim router with one
  // SVI per gateway'd VLAN, each cabled to an internal access port on its own L2
  // switch (an L3 switch both switches and routes, like a Catalyst/CRS/RouterOS
  // box) — when EITHER it is role:'l3' OR its CLI config defines SVIs/routes.
  // Each gateway'd VLAN's SVI is hosted by the CLI switch that defined it, else
  // by the first role:'l3' switch, so ownership is unambiguous.
  const firstL3 = switches.find((s) => s.sw.role === 'l3');
  const sviByOwner = new Map(); // switch id → [{ vid, ip, prefix }]
  for (const [vid, info] of vlanInfo) {
    if (!info.gateway) continue;
    const ownerId = cliOwner.get(vid) || (firstL3 && firstL3.sw.id);
    if (!ownerId) continue; // a gateway with no device able to host it
    if (!sviByOwner.has(ownerId)) sviByOwner.set(ownerId, []);
    sviByOwner.get(ownerId).push({ vid: Number(vid), ip: info.gateway, prefix: info.prefix });
  }
  const routerIds = new Set(); // switch ids that became sim routers
  const ospfRouterSimIds = new Set(); // r:<id> running OSPF
  for (const { sw, floorId } of switches) {
    const svis = sviByOwner.get(sw.id) || [];
    const routed = cliRoutedIfaces(sw); // routed CLI ports (for routed uplinks / stubs)
    const routes = cliRoutes(sw);
    const ospf = cliOspfEnabled(sw);
    const wantsL3 = sw.role === 'l3' || svis.length || routed.length || routes.length || ospf;
    if (!wantsL3) continue;
    if (!svis.length && !routed.length) {
      warnings.push(`switch ${sw.name || sw.id}: L3 configured but no SVI/routed interface — no routing added`);
      continue;
    }
    const rId = `r:${sw.id}`;
    const rIfaces = [];
    for (const s of svis) {
      rIfaces.push({ name: `svi${s.vid}`, ip: s.ip, prefix: s.prefix });
      const sviPort = `l3_${s.vid}`;
      ifacesOf(sw.id).push({ name: sviPort, mode: 'access', vlan: s.vid });
      links.push([`${rId}/svi${s.vid}`, `sw:${sw.id}/${sviPort}`]);
    }
    for (const r of routed) rIfaces.push({ name: r.name, ip: r.ip, prefix: r.prefix, up: r.up });
    const dev = { id: rId, name: `${sw.name || sw.id} (L3)`, kind: 'router', vendor: vendorOf(sw.model), ifaces: rIfaces };
    if (routes.length) dev.routes = routes; // CLI static routes
    const acls = cliAcls(sw);
    if (acls.length) dev.acls = acls; // CLI firewall / access-list
    devices.push(dev);
    meta.set(rId, { type: 'router', srcId: sw.id, name: sw.name || sw.id, fx: sw.fx, fy: sw.fy, floorId, ip: sw.ip });
    routerIds.add(sw.id);
    if (ospf) ospfRouterSimIds.add(rId);
  }

  // Routed uplinks → an L3 point-to-point between two switches' routers, using the
  // pair of routed interfaces that share a subnet (a /30 transit, typically).
  for (const { sw } of switches) {
    if (sw.uplinkMode !== 'routed' || !sw.uplinkId) continue;
    if (!routerIds.has(sw.id) || !swById.has(sw.uplinkId) || !routerIds.has(sw.uplinkId)) {
      warnings.push(`routed uplink ${sw.name || sw.id} → ${sw.uplinkId}: both ends need a routed (L3) interface`);
      continue;
    }
    const mine = cliRoutedIfaces(sw);
    const peer = cliRoutedIfaces(swById.get(sw.uplinkId).sw);
    const pair = mine.flatMap((a) => peer.map((b) => [a, b])).find(([a, b]) => sameSubnet(a.ip, a.prefix, b.ip, b.prefix));
    if (!pair) {
      warnings.push(`routed uplink ${sw.name || sw.id} → ${sw.uplinkId}: no shared transit subnet between their routed interfaces`);
      continue;
    }
    links.push([`r:${sw.id}/${pair[0].name}`, `r:${sw.uplinkId}/${pair[1].name}`]);
  }

  // Switch devices (built last, after every access/trunk/SVI port is accrued).
  for (const { sw, floorId } of switches) {
    const simId = `sw:${sw.id}`;
    devices.push({ id: simId, name: sw.name || sw.id, kind: 'switch', vendor: vendorOf(sw.model), ifaces: ifacesOf(sw.id) });
    meta.set(simId, { type: 'switch', srcId: sw.id, name: sw.name || sw.id, fx: sw.fx, fy: sw.fy, floorId, ip: sw.ip });
  }

  // DNS zone: every named device with an IP resolves by name for free; explicit
  // settings.dns records win over the auto-entries.
  /** @type {Record<string,string>} */
  const dns = {};
  for (const m of meta.values()) {
    if (m.ip && m.name) dns[normName(m.name)] = m.ip;
  }
  for (const rec of project?.settings?.dns || []) {
    if (rec && rec.name && validIp(rec.ip)) dns[normName(rec.name)] = rec.ip;
  }

  const spec = { devices, links };
  const net = buildNet(spec);
  // If any device runs OSPF, converge it so routes appear without hand-written
  // statics. Only OSPF-enabled routers' interfaces participate.
  if (ospfRouterSimIds.size) {
    runOspf(net, { enabled: (dev, i) => ospfRouterSimIds.has(dev.id) && i.ipInt != null && i.up !== false });
  }
  return { net, spec, meta, warnings, ospfRouters: [...ospfRouterSimIds], dns };
}

// Convenience for the UI device picker: the pingable endpoints (anything with
// an IP that made it into the net), as [{ simId, name, ip, type, vlan }].
export function pingableDevices(compiled) {
  const out = [];
  for (const [simId, m] of compiled.meta) {
    if (m.ip && (m.type === 'ap' || m.type === 'camera')) {
      out.push({ simId, name: m.name, ip: m.ip, type: m.type, vlan: m.vlan });
    }
  }
  return out;
}
