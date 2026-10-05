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
import { ipToInt } from './network.js';

const validIp = (s) => s != null && s !== '' && ipToInt(s) != null;

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

/**
 * @param {any} project
 * @returns {{net:any, spec:any, meta:Map<string,any>, warnings:string[]}}
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
  const allVlans = [...new Set([...vlanInfo.keys()].map(Number).concat(1))];

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

  // Uplinks → trunk links between switches (carry every known VLAN).
  for (const { sw } of switches) {
    if (!sw.uplinkId) continue;
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

  // L3 devices. A switch with role 'l3' also routes between VLANs: it becomes a
  // sim router with one SVI per gateway'd VLAN, each SVI cabled to an internal
  // access port on its own L2 switch (so the L3 switch both switches and routes,
  // like a real Catalyst/CRS/RouterOS box). The first L3 device to claim a
  // VLAN's gateway owns it, so two L3 switches can't fight over the same SVI IP.
  const claimedGw = new Set();
  for (const { sw, floorId } of switches) {
    if (sw.role !== 'l3') continue;
    const rId = `r:${sw.id}`;
    const rIfaces = [];
    for (const [vid, info] of vlanInfo) {
      if (!info.gateway || claimedGw.has(vid)) continue;
      claimedGw.add(vid);
      const sviPort = `l3_${vid}`;
      rIfaces.push({ name: `svi${vid}`, ip: info.gateway, prefix: info.prefix });
      ifacesOf(sw.id).push({ name: sviPort, mode: 'access', vlan: Number(vid) });
      links.push([`${rId}/svi${vid}`, `sw:${sw.id}/${sviPort}`]);
    }
    if (!rIfaces.length) {
      warnings.push(`switch ${sw.name || sw.id}: role is L3 but no VLAN has a gateway IP — no routing added`);
      continue;
    }
    devices.push({ id: rId, name: `${sw.name || sw.id} (L3)`, kind: 'router', vendor: vendorOf(sw.model), ifaces: rIfaces });
    meta.set(rId, { type: 'router', srcId: sw.id, name: sw.name || sw.id, fx: sw.fx, fy: sw.fy, floorId, ip: sw.ip });
  }

  // Switch devices (built last, after every access/trunk/SVI port is accrued).
  for (const { sw, floorId } of switches) {
    const simId = `sw:${sw.id}`;
    devices.push({ id: simId, name: sw.name || sw.id, kind: 'switch', vendor: vendorOf(sw.model), ifaces: ifacesOf(sw.id) });
    meta.set(simId, { type: 'switch', srcId: sw.id, name: sw.name || sw.id, fx: sw.fx, fy: sw.fy, floorId, ip: sw.ip });
  }

  const spec = { devices, links };
  return { net: buildNet(spec), spec, meta, warnings };
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
