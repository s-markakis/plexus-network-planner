// Per-device CLI console engine for the packet tracer — Cisco IOS and MikroTik
// RouterOS dialects over one shared running-config. Pure and headless: a session
// takes command lines and mutates a config object, returning output lines the
// way the real gear would. No DOM, no engine coupling.
//
// The config model is deliberately shaped to convert straight into the sim
// engine's device spec (interfaces with ip/prefix/mode/vlan, static routes), so
// the Phase-3b adapter can fold a CLI-configured device into buildNet with no
// translation. Only the subset the simulator actually forwards on is modelled;
// unknown commands fail the way the device would (`% Invalid input` /
// `bad command name`) rather than throwing.

import { ipToInt, intToIp } from './network.js';

// ── Running config ───────────────────────────────────────────────────────────
/**
 * @returns {{hostname:string, vendor:string,
 *   interfaces:Record<string,any>, routes:Array<any>, vlans:number[]}}
 */
export function newConfig({ hostname = '', vendor = 'cisco' } = {}) {
  return { hostname, vendor, interfaces: {}, routes: [], vlans: [] };
}

function iface(config, name) {
  if (!config.interfaces[name]) {
    config.interfaces[name] = { name, ip: null, prefix: null, mode: null, vlan: null, allowed: [], shutdown: false };
  }
  return config.interfaces[name];
}

// ── Mask / prefix helpers ────────────────────────────────────────────────────
function maskToPrefix(mask) {
  const n = ipToInt(mask);
  if (n == null) return null;
  const inv = (~n) >>> 0;
  if (((inv + 1) & inv) !== 0) return null; // not a contiguous 1*0* mask
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if (n & (1 << i)) bits++;
    else break;
  }
  return bits;
}
function prefixToMask(p) {
  return p <= 0 ? '0.0.0.0' : intToIp((0xffffffff << (32 - p)) >>> 0);
}
function networkOf(ip, prefix) {
  const n = ipToInt(ip);
  if (n == null) return null;
  const mask = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp((n & mask) >>> 0);
}
// "10,20,30" or "10-12" → [10,11,12,20,30]
function parseVlanList(spec) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) {
      for (let i = +m[1]; i <= +m[2]; i++) out.add(i);
    } else if (/^\d+$/.test(part.trim())) {
      out.add(+part.trim());
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ── Session ──────────────────────────────────────────────────────────────────
// Holds the mode/context state (IOS) and routes each line to the dialect.
// exec() returns { output:string[], error?:boolean, ping?:string }.
export function makeSession(config, vendor = config.vendor) {
  const ctx = { mode: 'exec', curIf: null, curVlan: null };
  return {
    config,
    ctx,
    vendor,
    prompt() {
      return vendor === 'mikrotik' ? routerosPrompt(config) : iosPrompt(config, ctx);
    },
    exec(line) {
      const text = String(line == null ? '' : line).trim();
      if (!text) return { output: [] };
      return vendor === 'mikrotik' ? execRouterOS(config, text, ctx) : execIos(config, text, ctx);
    },
  };
}

// ── Cisco IOS ────────────────────────────────────────────────────────────────
function iosPrompt(config, ctx) {
  const h = config.hostname || 'Router';
  if (ctx.mode === 'exec') return `${h}>`;
  if (ctx.mode === 'enable') return `${h}#`;
  if (ctx.mode === 'config') return `${h}(config)#`;
  if (ctx.mode === 'config-if') return `${h}(config-if)#`;
  if (ctx.mode === 'config-vlan') return `${h}(config-vlan)#`;
  return `${h}#`;
}

const err = (msg) => ({ output: [msg], error: true });

// Expand the handful of abbreviations people actually type.
function iosExpand(line) {
  /** @type {Array<[RegExp, string]>} */
  const subs = [
    [/^conf(ig)?\s+t(erminal)?$/i, 'configure terminal'],
    [/^en(able)?$/i, 'enable'],
    [/^int(erface)?\s+/i, 'interface '],
    [/^sh(ow)?\s+run(ning-config)?$/i, 'show running-config'],
    [/^sh(ow)?\s+ip\s+route$/i, 'show ip route'],
    [/^sh(ow)?\s+ip\s+int(erface)?\s+br(ief)?$/i, 'show ip interface brief'],
    [/^sh(ow)?\s+vlan(\s+brief)?$/i, 'show vlan'],
    [/^no\s+shut(down)?$/i, 'no shutdown'],
    [/^shut(down)?$/i, 'shutdown'],
  ];
  for (const [re, to] of subs) if (re.test(line)) return line.replace(re, to);
  return line;
}

function execIos(config, raw, ctx) {
  const line = iosExpand(raw);
  const t = line.split(/\s+/);
  const lc = line.toLowerCase();

  // Navigation works in any config sub-mode.
  if (lc === 'end') { ctx.mode = 'enable'; ctx.curIf = null; ctx.curVlan = null; return { output: [] }; }
  if (lc === 'exit') {
    if (ctx.mode === 'config-if' || ctx.mode === 'config-vlan') { ctx.mode = 'config'; ctx.curIf = null; ctx.curVlan = null; }
    else if (ctx.mode === 'config') ctx.mode = 'enable';
    else if (ctx.mode === 'enable') ctx.mode = 'exec';
    return { output: [] };
  }

  if (ctx.mode === 'exec' || ctx.mode === 'enable') {
    if (lc === 'enable') { ctx.mode = 'enable'; return { output: [] }; }
    if (lc === 'configure terminal') {
      if (ctx.mode !== 'enable') return err('% Use enable first');
      ctx.mode = 'config';
      return { output: ['Enter configuration commands, one per line.'] };
    }
    if (lc === 'show running-config') return { output: showRunIos(config) };
    if (lc === 'show ip route') return { output: showIpRoute(config) };
    if (lc === 'show ip interface brief') return { output: showIpIntBrief(config) };
    if (lc === 'show vlan') return { output: showVlan(config) };
    if (t[0].toLowerCase() === 'ping' && t[1]) return { output: [], ping: t[1] };
    return err('% Invalid input detected');
  }

  if (ctx.mode === 'config') {
    if (t[0].toLowerCase() === 'hostname' && t[1]) { config.hostname = t[1]; return { output: [] }; }
    if (t[0].toLowerCase() === 'interface' && t[1]) {
      // `interface vlan 10` → SVI named Vlan10; otherwise the literal name.
      let name = t.slice(1).join('');
      if (/^vlan$/i.test(t[1]) && t[2]) { name = `Vlan${t[2]}`; iface(config, name).vlan = +t[2]; }
      iface(config, name);
      ctx.mode = 'config-if';
      ctx.curIf = name;
      return { output: [] };
    }
    if (t[0].toLowerCase() === 'vlan' && /^\d+$/.test(t[1] || '')) {
      const id = +t[1];
      if (!config.vlans.includes(id)) config.vlans.push(id);
      ctx.mode = 'config-vlan';
      ctx.curVlan = id;
      return { output: [] };
    }
    // ip route <net> <mask> <next-hop>
    if (t[0].toLowerCase() === 'ip' && (t[1] || '').toLowerCase() === 'route') {
      const [net, mask, via] = [t[2], t[3], t[4]];
      const prefix = maskToPrefix(mask);
      if (ipToInt(net) == null || prefix == null || ipToInt(via) == null) return err('% Invalid input detected');
      config.routes.push({ cidr: `${networkOf(net, prefix)}/${prefix}`, via });
      return { output: [] };
    }
    if (t[0].toLowerCase() === 'no' && (t[1] || '').toLowerCase() === 'ip' && (t[2] || '').toLowerCase() === 'route') {
      const prefix = maskToPrefix(t[4]);
      const cidr = `${networkOf(t[3], prefix)}/${prefix}`;
      config.routes = config.routes.filter((r) => r.cidr !== cidr);
      return { output: [] };
    }
    return err('% Invalid input detected');
  }

  if (ctx.mode === 'config-if') {
    const i = iface(config, ctx.curIf);
    if (lc === 'shutdown') { i.shutdown = true; return { output: [] }; }
    if (lc === 'no shutdown') { i.shutdown = false; return { output: [] }; }
    if (t[0].toLowerCase() === 'ip' && (t[1] || '').toLowerCase() === 'address') {
      const prefix = maskToPrefix(t[3]);
      if (ipToInt(t[2]) == null || prefix == null) return err('% Invalid input detected');
      i.ip = t[2]; i.prefix = prefix; if (!i.mode) i.mode = 'routed';
      return { output: [] };
    }
    if (lc === 'no ip address') { i.ip = null; i.prefix = null; return { output: [] }; }
    if (t[0].toLowerCase() === 'switchport') {
      const sub = (t[1] || '').toLowerCase();
      if (sub === 'mode' && (t[2] === 'access' || t[2] === 'trunk')) { i.mode = t[2]; return { output: [] }; }
      if (sub === 'access' && (t[2] || '').toLowerCase() === 'vlan' && /^\d+$/.test(t[3] || '')) { i.mode = i.mode || 'access'; i.vlan = +t[3]; return { output: [] }; }
      if (sub === 'trunk' && (t[2] || '').toLowerCase() === 'allowed' && (t[3] || '').toLowerCase() === 'vlan' && t[4]) { i.mode = 'trunk'; i.allowed = parseVlanList(t[4]); return { output: [] }; }
      return err('% Invalid input detected');
    }
    return err('% Invalid input detected');
  }

  if (ctx.mode === 'config-vlan') {
    if (t[0].toLowerCase() === 'name') return { output: [] }; // accepted, not modelled
    return err('% Invalid input detected');
  }
  return err('% Invalid input detected');
}

// ── MikroTik RouterOS ────────────────────────────────────────────────────────
function routerosPrompt(config) {
  return `[admin@${config.hostname || 'MikroTik'}] > `;
}

function parseKv(tokens) {
  const kv = {};
  for (const tok of tokens) {
    const i = tok.indexOf('=');
    if (i > 0) kv[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return kv;
}

const ROS_VERBS = new Set(['add', 'set', 'remove', 'print', 'enable', 'disable']);

function execRouterOS(config, line, _ctx) {
  const t = line.split(/\s+/);
  if (t[0] === '/ping' && t[1]) return { output: [], ping: t[1] };

  const verbIdx = t.findIndex((x) => ROS_VERBS.has(x));
  if (verbIdx < 0) return err('bad command name or ambiguous');
  const path = t.slice(0, verbIdx).join(' ');
  const verb = t[verbIdx];
  const kv = parseKv(t.slice(verbIdx + 1));

  if (path === '/system identity' && verb === 'set' && kv.name) { config.hostname = kv.name; return { output: [] }; }

  if (path === '/ip address') {
    if (verb === 'add') {
      const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(kv.address || '');
      if (!m || !kv.interface) return err('input does not match any value of address');
      const i = iface(config, kv.interface);
      i.ip = m[1]; i.prefix = +m[2]; if (!i.mode) i.mode = 'routed';
      return { output: [] };
    }
    if (verb === 'print') return { output: showAddresses(config) };
  }

  if (path === '/ip route') {
    if (verb === 'add') {
      const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(kv['dst-address'] || '');
      if (!m || ipToInt(kv.gateway) == null) return err('input does not match any value of dst-address');
      const prefix = +m[2];
      config.routes.push({ cidr: `${networkOf(m[1], prefix)}/${prefix}`, via: kv.gateway });
      return { output: [] };
    }
    if (verb === 'print') return { output: showIpRoute(config) };
  }

  // Bridge VLAN model: a port's pvid is its access VLAN; a bridge-vlan tagged
  // list makes those ports trunk the VLAN.
  if (path === '/interface bridge port' && verb === 'add' && kv.interface) {
    const i = iface(config, kv.interface);
    if (kv.pvid) { i.mode = i.mode === 'trunk' ? 'trunk' : 'access'; i.vlan = +kv.pvid; }
    else if (!i.mode) i.mode = 'access';
    return { output: [] };
  }
  if (path === '/interface bridge vlan' && verb === 'add' && kv['vlan-ids']) {
    const ids = parseVlanList(kv['vlan-ids']);
    for (const name of String(kv.tagged || '').split(',')) {
      if (!name.trim()) continue;
      const i = iface(config, name.trim());
      i.mode = 'trunk';
      i.allowed = [...new Set([...i.allowed, ...ids])].sort((a, b) => a - b);
    }
    for (const id of ids) if (!config.vlans.includes(id)) config.vlans.push(id);
    return { output: [] };
  }
  // A tagged VLAN subinterface: /interface vlan add name=v10 vlan-id=10 interface=ether1
  if (path === '/interface vlan' && verb === 'add' && kv.name && kv['vlan-id']) {
    const i = iface(config, kv.name);
    i.mode = 'routed';
    i.vlan = +kv['vlan-id'];
    return { output: [] };
  }

  return err('bad command name or ambiguous');
}

// ── show / print renderers ───────────────────────────────────────────────────
function connectedRoutes(config) {
  const out = [];
  for (const i of Object.values(config.interfaces)) {
    if (i.ip != null && i.prefix != null && !i.shutdown) {
      out.push({ cidr: `${networkOf(i.ip, i.prefix)}/${i.prefix}`, iface: i.name, kind: 'C' });
    }
  }
  return out;
}

// Real RouterOS `/ip address print` columns: ADDRESS, NETWORK, INTERFACE
// (validated against RouterOS 7.24.4 on a hAP ax lite).
function showAddresses(config) {
  const rows = ['Columns: ADDRESS, NETWORK, INTERFACE'];
  for (const i of Object.values(config.interfaces)) {
    if (i.ip != null && i.prefix != null) {
      rows.push(`${i.ip}/${i.prefix}  ${networkOf(i.ip, i.prefix)}  ${i.name}`);
    }
  }
  return rows.length > 1 ? rows : ['% no addresses'];
}

function showIpRoute(config, _mode) {
  const lines = [];
  for (const r of connectedRoutes(config)) lines.push(`C    ${r.cidr} is directly connected, ${r.iface}`);
  for (const r of config.routes) lines.push(`S    ${r.cidr} [1/0] via ${r.via}`);
  return lines.length ? lines : ['% no routes'];
}

function showIpIntBrief(config) {
  const rows = [['Interface', 'IP-Address', 'Status']];
  for (const i of Object.values(config.interfaces)) {
    rows.push([i.name, i.ip || 'unassigned', i.shutdown ? 'administratively down' : 'up']);
  }
  return rows.map((r) => `${r[0].padEnd(16)} ${String(r[1]).padEnd(16)} ${r[2]}`);
}

function showVlan(config) {
  if (!config.vlans.length) return ['% no VLANs defined'];
  return config.vlans.slice().sort((a, b) => a - b).map((v) => `VLAN ${v}`);
}

function showRunIos(config) {
  const out = [`hostname ${config.hostname || 'Router'}`, '!'];
  for (const v of config.vlans) out.push(`vlan ${v}`, '!');
  for (const i of Object.values(config.interfaces)) {
    out.push(`interface ${i.name}`);
    if (i.mode === 'access') { out.push(' switchport mode access'); if (i.vlan != null) out.push(` switchport access vlan ${i.vlan}`); }
    else if (i.mode === 'trunk') { out.push(' switchport mode trunk'); if (i.allowed.length) out.push(` switchport trunk allowed vlan ${i.allowed.join(',')}`); }
    if (i.ip != null) out.push(` ip address ${i.ip} ${prefixToMask(i.prefix)}`);
    out.push(i.shutdown ? ' shutdown' : ' no shutdown', '!');
  }
  for (const r of config.routes) {
    const [net, p] = r.cidr.split('/');
    out.push(`ip route ${net} ${prefixToMask(+p)} ${r.via}`);
  }
  return out;
}

// ── Config → sim-engine device spec ──────────────────────────────────────────
// Turn a running-config into a buildNet device entry (Phase-3b uses this to fold
// CLI-configured devices into the simulated topology).
/** @param {{id?:string, kind?:string}} [opts] */
export function configToDevice(config, opts = {}) {
  const { id, kind = 'router' } = opts;
  const ifaces = [];
  for (const i of Object.values(config.interfaces)) {
    const spec = { name: i.name, up: !i.shutdown };
    if (i.ip != null && i.prefix != null) { spec.ip = i.ip; spec.prefix = i.prefix; }
    if (i.mode) spec.mode = i.mode;
    if (i.vlan != null) spec.vlan = i.vlan;
    if (i.allowed && i.allowed.length) spec.allowed = i.allowed.slice();
    ifaces.push(spec);
  }
  return {
    id: id || config.hostname || 'dev',
    name: config.hostname || id,
    kind,
    vendor: config.vendor,
    ifaces,
    routes: config.routes.map((r) => ({ cidr: r.cidr, via: r.via })),
  };
}
