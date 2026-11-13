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
 *   interfaces:Record<string,any>, routes:Array<any>, vlans:number[], ospf:any, rip:any, acls:Array<any>, startup:any, natEnabled:boolean, natMasquerade:any, dhcpPools:Array<any>}}
 */
export function newConfig({ hostname = '', vendor = 'cisco' } = {}) {
  return { hostname, vendor, interfaces: {}, routes: [], vlans: [], ospf: null, rip: null, acls: [], startup: null, natEnabled: false, natMasquerade: null, dhcpPools: [] };
}

// Snapshot/restore the persistable part of a running-config (for startup-config).
function snapshotConfig(c) {
  return JSON.parse(JSON.stringify({ hostname: c.hostname, interfaces: c.interfaces, routes: c.routes, vlans: c.vlans, ospf: c.ospf, rip: c.rip, acls: c.acls, natEnabled: !!c.natEnabled, natMasquerade: c.natMasquerade || null, dhcpPools: c.dhcpPools || [] }));
}
function restoreConfig(c, snap) {
  c.hostname = snap.hostname;
  c.interfaces = JSON.parse(JSON.stringify(snap.interfaces || {}));
  c.routes = JSON.parse(JSON.stringify(snap.routes || []));
  c.vlans = JSON.parse(JSON.stringify(snap.vlans || []));
  c.ospf = snap.ospf ? JSON.parse(JSON.stringify(snap.ospf)) : null;
  c.acls = JSON.parse(JSON.stringify(snap.acls || []));
  c.rip = snap.rip ? JSON.parse(JSON.stringify(snap.rip)) : null;
  c.natEnabled = !!snap.natEnabled;
  c.natMasquerade = snap.natMasquerade ? JSON.parse(JSON.stringify(snap.natMasquerade)) : null;
  c.dhcpPools = JSON.parse(JSON.stringify(snap.dhcpPools || []));
}

// ── ACL address helpers (shared by both dialects) ───────────────────────────
// Normalise an address spec to 'any' or '<ip>/<prefix>' so the engine's
// cidrContains can match it (a bare host IP becomes /32).
function normAddr(s) {
  if (!s || s === 'any' || s === '0.0.0.0/0') return 'any';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return `${s}/32`;
  return s;
}
function portNum(s) {
  const n = parseInt(s, 10);
  if (Number.isFinite(n)) return n;
  const named = { www: 80, http: 80, https: 443, ssh: 22, telnet: 23, domain: 53, ftp: 21, smtp: 25 };
  return named[String(s).toLowerCase()] ?? null;
}
// Cisco wildcard mask (inverted) → prefix length. 0.0.0.255 → 24.
function wildcardToPrefix(wc) {
  const n = ipToInt(wc);
  if (n == null) return null;
  return maskToPrefix(intToIp((~n) >>> 0));
}
// Parse one Cisco address operand starting at tok[i]; returns [spec, nextIndex].
function parseAclAddr(tok, i) {
  const w = (tok[i] || '').toLowerCase();
  if (w === 'any') return ['any', i + 1];
  if (w === 'host' && tok[i + 1]) return [normAddr(tok[i + 1]), i + 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tok[i] || '') && /^\d+\.\d+\.\d+\.\d+$/.test(tok[i + 1] || '')) {
    const p = wildcardToPrefix(tok[i + 1]);
    if (p == null) return [null, i];
    return [`${tok[i]}/${p}`, i + 2];
  }
  return [null, i];
}
// `access-list <n> {permit|deny} <proto> <src> <dst> [eq <port>]` → engine rule.
function parseIosAcl(tok) {
  const action = (tok[1] || '').toLowerCase();
  if (action !== 'permit' && action !== 'deny') return null;
  const proto = (tok[2] || '').toLowerCase();
  if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) return null;
  let i = 3;
  const [src, ni] = parseAclAddr(tok, i);
  if (!src) return null;
  i = ni;
  const [dst, nj] = parseAclAddr(tok, i);
  if (!dst) return null;
  i = nj;
  let dport = null;
  if ((tok[i] || '').toLowerCase() === 'eq' && tok[i + 1]) { dport = portNum(tok[i + 1]); i += 2; }
  const rule = { action, proto, src, dst, dport, list: String(tok[0]) };
  // `established` — only packets belonging to a connection opened the other way.
  if (tok.slice(i).some((w) => w.toLowerCase() === 'established')) rule.state = ['established'];
  return rule;
}

// Interface names are user-typed keys into a plain object: never let one alias
// an Object.prototype member (`interface __proto__` would otherwise write
// ip/prefix onto every object in the app).
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
function validIfName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && !RESERVED_NAMES.has(name);
}
function validPrefixAddr(ip, prefix) {
  return ipToInt(ip) != null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function iface(config, name) {
  if (!Object.prototype.hasOwnProperty.call(config.interfaces, name)) {
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
    // Clamp to the 802.1Q range so a typo like 1-999999999 can't spin the UI.
    if (m) {
      for (let i = Math.max(1, +m[1]); i <= Math.min(4094, +m[2]); i++) out.add(i);
    } else if (/^\d+$/.test(part.trim())) {
      const v = +part.trim();
      if (v >= 1 && v <= 4094) out.add(v);
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
  if (ctx.mode === 'config-router') return `${h}(config-router)#`;
  if (ctx.mode === 'config-dhcp') return `${h}(dhcp-config)#`;
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
    [/^wr(ite)?(\s+mem(ory)?)?$/i, 'write memory'],
    [/^sh(ow)?\s+/i, 'show '],
  ];
  for (const [re, to] of subs) if (re.test(line)) return line.replace(re, to);
  return line;
}

function execIos(config, raw, ctx) {
  // Context help: `?` alone or after a partial command lists what fits here.
  if (/\?$/.test(raw)) {
    const opts = iosCandidates(ctx.mode, raw.replace(/\?$/, '').trim());
    return { output: opts.length ? opts.map((o) => `  ${o}`) : ['% Unrecognized command'] };
  }
  // `do <exec command>` from any config mode.
  if (ctx.mode.startsWith('config') && /^do\s+\S/i.test(raw)) {
    return execIos(config, raw.replace(/^do\s+/i, ''), { mode: 'enable', curIf: null, curVlan: null });
  }
  const line = iosExpand(raw);
  const t = line.split(/\s+/);
  const lc = line.toLowerCase();

  // Navigation works in any config sub-mode.
  if (lc === 'end') { ctx.mode = 'enable'; ctx.curIf = null; ctx.curVlan = null; return { output: [] }; }
  if (lc === 'exit') {
    if (ctx.mode === 'config-if' || ctx.mode === 'config-vlan' || ctx.mode === 'config-router' || ctx.mode === 'config-dhcp') { ctx.mode = 'config'; ctx.curIf = null; ctx.curVlan = null; ctx.curPool = null; }
    else if (ctx.mode === 'config') ctx.mode = 'enable';
    else if (ctx.mode === 'enable') ctx.mode = 'exec';
    return { output: [] };
  }

  // Like real IOS, a global-config command typed inside a sub-mode (config-if,
  // config-vlan, config-router) leaves the sub-mode and runs globally — so
  // `interface g0/2` straight after configuring g0/1 works without `exit`.
  if ((ctx.mode === 'config-if' || ctx.mode === 'config-vlan' || ctx.mode === 'config-router' || ctx.mode === 'config-dhcp') &&
      /^(interface|vlan|router|hostname|access-list)\s|^ip\s+(route|dhcp\s+pool)\s|^no\s+(router|access-list|ip\s+route|ip\s+dhcp\s+pool)\s/i.test(line)) {
    ctx.mode = 'config'; ctx.curIf = null; ctx.curVlan = null;
  }

  if (ctx.mode === 'exec' || ctx.mode === 'enable') {
    if (lc === 'enable') { ctx.mode = 'enable'; return { output: [] }; }
    if (lc === 'configure terminal') {
      if (ctx.mode !== 'enable') return err('% Use enable first');
      ctx.mode = 'config';
      return { output: ['Enter configuration commands, one per line.'] };
    }
    if (lc === 'show running-config') return { output: showRunIos(config) };
    if (lc === 'copy running-config startup-config' || lc === 'copy run start' || lc === 'write memory' || lc === 'write' || lc === 'wr') {
      config.startup = snapshotConfig(config);
      return { output: ['Building configuration...', '[OK]'] };
    }
    if (lc === 'show startup-config' || lc === 'show start') {
      return { output: config.startup ? showRunIos(config.startup) : ['% No startup-config present (use "copy run start")'] };
    }
    if (lc === 'reload') {
      if (config.startup) { restoreConfig(config, config.startup); return { output: ['Reloading — running-config reverted to startup-config.'] }; }
      return { output: ['% No startup-config; running-config unchanged'] };
    }
    if (lc === 'show ip route') return { output: showIpRoute(config) };
    if (lc === 'show ip ospf neighbor') return { output: [], show: 'ospf-neighbor' };
    if (lc === 'show ip interface brief') return { output: showIpIntBrief(config) };
    if (lc === 'show vlan') return { output: showVlan(config) };
    if (t[0].toLowerCase() === 'ping' && t[1]) return { output: [], ping: t[1] };
    // Learned (runtime) state lives in the simulated network, not the config:
    // the console resolves these against the live net.
    if (lc === 'show arp' || lc === 'show ip arp') return { output: [], show: 'arp' };
    if (lc === 'show mac address-table' || lc === 'show mac-address-table') return { output: [], show: 'mac' };
    if (lc === 'show ip nat translations') return { output: [], show: 'nat' };
    if (lc === 'show spanning-tree') return { output: [], show: 'stp' };
    if (lc === 'show interfaces' || lc === 'show interface' || lc === 'show interfaces status') return { output: showInterfaces(config) };
    if (lc === 'show access-lists' || lc === 'show ip access-lists') return { output: showAccessLists(config) };
    if (lc === 'show ip protocols') return { output: showIpProtocols(config) };
    if (lc === 'show ip dhcp pool') return { output: (config.dhcpPools || []).length ? config.dhcpPools.map((p) => `Pool ${p.name}: ${p.cidr || '(no network)'}${p.router ? `, default-router ${p.router}` : ''}`) : ['% no DHCP pools'] };
    return err('% Invalid input detected');
  }

  if (ctx.mode === 'config') {
    if (t[0].toLowerCase() === 'hostname' && t[1]) { config.hostname = t[1]; return { output: [] }; }
    if (t[0].toLowerCase() === 'interface' && t[1]) {
      // `interface vlan 10` → SVI named Vlan10; otherwise the literal name.
      let name = t.slice(1).join('');
      const svi = /^vlan$/i.test(t[1]) && t[2];
      if (svi) name = `Vlan${t[2]}`;
      if (!validIfName(name)) return err('% Invalid input detected');
      if (svi) iface(config, name).vlan = +t[2];
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
    // router ospf <id> / router rip → enable that IGP and enter config-router.
    if (t[0].toLowerCase() === 'router' && (t[1] || '').toLowerCase() === 'ospf') {
      if (!config.ospf) config.ospf = { enabled: true, networks: [] };
      config.ospf.enabled = true;
      ctx.mode = 'config-router';
      ctx.routerProto = 'ospf';
      return { output: [] };
    }
    if (t[0].toLowerCase() === 'router' && (t[1] || '').toLowerCase() === 'rip') {
      if (!config.rip) config.rip = { enabled: true, networks: [] };
      config.rip.enabled = true;
      ctx.mode = 'config-router';
      ctx.routerProto = 'rip';
      return { output: [] };
    }
    // ip dhcp pool <name> → config-dhcp (network / default-router)
    if (t[0].toLowerCase() === 'ip' && (t[1] || '').toLowerCase() === 'dhcp' && (t[2] || '').toLowerCase() === 'pool' && t[3]) {
      if (!Array.isArray(config.dhcpPools)) config.dhcpPools = [];
      if (!config.dhcpPools.some((p) => p.name === t[3])) config.dhcpPools.push({ name: t[3], cidr: null, router: null });
      ctx.mode = 'config-dhcp'; ctx.curPool = t[3];
      return { output: [] };
    }
    if (t[0].toLowerCase() === 'no' && (t[1] || '').toLowerCase() === 'ip' && (t[2] || '').toLowerCase() === 'dhcp' && (t[3] || '').toLowerCase() === 'pool' && t[4]) {
      config.dhcpPools = (config.dhcpPools || []).filter((p) => p.name !== t[4]);
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
    // access-list <n> permit|deny <proto> <src> <dst> [eq <port>] — device-wide
    // filter in the sim (interface binding via `ip access-group` is accepted but
    // not scoped, since the engine filters per device).
    if (t[0].toLowerCase() === 'access-list' && t.length >= 5) {
      const rule = parseIosAcl(t.slice(1));
      if (!rule) return err('% Invalid input detected');
      config.acls.push(rule);
      return { output: [] };
    }
    if (t[0].toLowerCase() === 'ip' && (t[1] || '').toLowerCase() === 'access-group') return { output: [] };
    // no access-list <n> — remove the whole list (and any interface bindings).
    if (t[0].toLowerCase() === 'no' && (t[1] || '').toLowerCase() === 'access-list' && t[2]) {
      config.acls = config.acls.filter((r) => r.list !== String(t[2]));
      for (const i of Object.values(config.interfaces)) {
        if (i.aclIn === String(t[2])) delete i.aclIn;
        if (i.aclOut === String(t[2])) delete i.aclOut;
      }
      return { output: [] };
    }
    // no router ospf [id] / no router rip — stop the IGP on this device.
    if (t[0].toLowerCase() === 'no' && (t[1] || '').toLowerCase() === 'router' && ['ospf', 'rip'].includes((t[2] || '').toLowerCase())) {
      config[(t[2] || '').toLowerCase()] = null;
      return { output: [] };
    }
    // ip nat inside source list <x> interface <y> overload  → enable PAT
    if (t[0].toLowerCase() === 'ip' && (t[1] || '').toLowerCase() === 'nat' && (t[2] || '').toLowerCase() === 'inside' && (t[3] || '').toLowerCase() === 'source') {
      config.natEnabled = true;
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
    if (lc === 'ip nat inside') { i.natRole = 'inside'; return { output: [] }; }
    if (lc === 'ip nat outside') { i.natRole = 'outside'; return { output: [] }; }
    // ip helper-address <server> — relay this segment's DHCP to a remote server.
    if (t[0].toLowerCase() === 'ip' && (t[1] || '').toLowerCase() === 'helper-address') {
      if (ipToInt(t[2]) == null) return err('% Invalid input detected');
      i.helper = t[2];
      return { output: [] };
    }
    if (lc === 'no ip helper-address') { delete i.helper; return { output: [] }; }
    // ip access-group <list> in|out — scope that access-list to this interface
    // and direction. A list bound anywhere stops being device-wide.
    if (t[0].toLowerCase() === 'ip' && (t[1] || '').toLowerCase() === 'access-group' && t[2]) {
      const dir = (t[3] || 'in').toLowerCase();
      if (dir !== 'in' && dir !== 'out') return err('% Invalid input detected');
      if (dir === 'in') i.aclIn = String(t[2]); else i.aclOut = String(t[2]);
      return { output: [] };
    }
    if (t[0].toLowerCase() === 'no' && (t[1] || '').toLowerCase() === 'ip' && (t[2] || '').toLowerCase() === 'access-group') {
      const dir = (t[4] || '').toLowerCase();
      if (dir !== 'out') delete i.aclIn;
      if (dir !== 'in') delete i.aclOut;
      return { output: [] };
    }
    // Router-on-a-stick: `encapsulation dot1q <vlan>` on a subinterface (e.g.
    // Gi0/0.10) makes it a routed VLAN interface — the SVI-equivalent gateway.
    if (t[0].toLowerCase() === 'encapsulation' && (t[1] || '').toLowerCase() === 'dot1q' && /^\d+$/.test(t[2] || '')) {
      i.vlan = Number(t[2]);
      i.mode = 'routed';
      return { output: [] };
    }
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

  if (ctx.mode === 'config-dhcp') {
    const pool = (config.dhcpPools || []).find((p) => p.name === ctx.curPool);
    if (!pool) return err('% Invalid input detected');
    if (t[0].toLowerCase() === 'network') {
      const prefix = /^\/(\d+)$/.test(t[2] || '') ? +t[2].slice(1) : maskToPrefix(t[2]);
      if (ipToInt(t[1]) == null || prefix == null || prefix > 32) return err('% Invalid input detected');
      pool.cidr = `${networkOf(t[1], prefix)}/${prefix}`;
      return { output: [] };
    }
    if (t[0].toLowerCase() === 'default-router') {
      if (ipToInt(t[1]) == null) return err('% Invalid input detected');
      pool.router = t[1];
      return { output: [] };
    }
    if (['dns-server', 'lease', 'domain-name'].includes(t[0].toLowerCase())) return { output: [] }; // accepted, not modelled
    return err('% Invalid input detected');
  }

  if (ctx.mode === 'config-router') {
    const proto = ctx.routerProto === 'rip' ? config.rip : config.ospf;
    if (t[0].toLowerCase() === 'network' && proto) {
      if (!proto.networks) proto.networks = [];
      proto.networks.push(t.slice(1).join(' '));
      return { output: [] };
    }
    if (['passive-interface', 'router-id', 'version', 'no'].includes(t[0].toLowerCase())) return { output: [] };
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

  if (/\?$/.test(line)) {
    const opts = rosCandidates(line.replace(/\?$/, '').trim());
    return { output: opts.length ? opts.map((o) => `  ${o}`) : ['bad command name or ambiguous'] };
  }
  if (t[0] === '/export') return { output: exportRouterOs(config) };

  const verbIdx = t.findIndex((x) => ROS_VERBS.has(x));
  if (verbIdx < 0) return err('bad command name or ambiguous');
  const path = t.slice(0, verbIdx).join(' ');
  const verb = t[verbIdx];
  const kv = parseKv(t.slice(verbIdx + 1));

  if (path === '/system identity' && verb === 'set' && kv.name) { config.hostname = kv.name; return { output: [] }; }
  if (verb === 'print') {
    if (path === '/ip arp') return { output: [], show: 'arp' };
    if (path === '/interface bridge host') return { output: [], show: 'mac' };
    if (path === '/ip firewall connection') return { output: [], show: 'conns' };
    if (path === '/interface') return { output: showInterfaces(config) };
    if (path === '/ip firewall filter') return { output: showAccessLists(config) };
  }
  // DHCP: a server network (+ the interface it serves), or a relay to a remote server.
  if (path === '/ip dhcp-server network' && verb === 'add') {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(kv.address || '');
    if (!m || !validPrefixAddr(m[1], +m[2])) return err('input does not match any value of address');
    if (!Array.isArray(config.dhcpPools)) config.dhcpPools = [];
    config.dhcpPools.push({ name: `net${config.dhcpPools.length + 1}`, cidr: `${networkOf(m[1], +m[2])}/${+m[2]}`, router: ipToInt(kv.gateway) != null ? kv.gateway : null });
    return { output: [] };
  }
  if (path === '/ip dhcp-server' && verb === 'add') return { output: [] }; // the network entry carries what the sim needs
  if (path === '/ip dhcp-relay' && verb === 'add') {
    if (!validIfName(kv.interface) || ipToInt(kv['dhcp-server']) == null) return err('invalid value for argument dhcp-server');
    iface(config, kv.interface).helper = kv['dhcp-server'];
    return { output: [] };
  }

  if (path === '/ip address') {
    if (verb === 'add') {
      const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(kv.address || '');
      if (!m || !validIfName(kv.interface) || !validPrefixAddr(m[1], +m[2])) return err('input does not match any value of address');
      const i = iface(config, kv.interface);
      i.ip = m[1]; i.prefix = +m[2]; if (!i.mode) i.mode = 'routed';
      return { output: [] };
    }
    if (verb === 'print') return { output: showAddresses(config) };
  }

  if (path === '/ip route') {
    if (verb === 'add') {
      const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(kv['dst-address'] || '');
      if (!m || !validPrefixAddr(m[1], +m[2]) || ipToInt(kv.gateway) == null) return err('input does not match any value of dst-address');
      const prefix = +m[2];
      config.routes.push({ cidr: `${networkOf(m[1], prefix)}/${prefix}`, via: kv.gateway });
      return { output: [] };
    }
    if (verb === 'print') return { output: showIpRoute(config) };
  }

  // Bridge VLAN model: a port's pvid is its access VLAN; a bridge-vlan tagged
  // list makes those ports trunk the VLAN.
  if (path === '/interface bridge port' && verb === 'add' && validIfName(kv.interface)) {
    const i = iface(config, kv.interface);
    if (kv.pvid) { i.mode = i.mode === 'trunk' ? 'trunk' : 'access'; i.vlan = +kv.pvid; }
    else if (!i.mode) i.mode = 'access';
    return { output: [] };
  }
  if (path === '/interface bridge vlan' && verb === 'add' && kv['vlan-ids']) {
    const ids = parseVlanList(kv['vlan-ids']);
    for (const name of String(kv.tagged || '').split(',')) {
      if (!validIfName(name.trim())) continue;
      const i = iface(config, name.trim());
      i.mode = 'trunk';
      i.allowed = [...new Set([...i.allowed, ...ids])].sort((a, b) => a - b);
    }
    for (const id of ids) if (!config.vlans.includes(id)) config.vlans.push(id);
    return { output: [] };
  }
  // NAT: /ip firewall nat add chain=srcnat action=masquerade out-interface=<if>
  if (path === '/ip firewall nat' && verb === 'add' && kv.action === 'masquerade' && kv['out-interface']) {
    config.natMasquerade = { outside: kv['out-interface'] };
    return { output: [] };
  }

  // Firewall: /ip firewall filter add chain=forward action=drop|accept protocol=…
  //           src-address=…/… dst-address=…/… dst-port=…
  if (path === '/ip firewall filter' && verb === 'add') {
    const rule = {
      action: kv.action === 'drop' || kv.action === 'reject' ? 'deny' : 'permit',
      proto: kv.protocol || 'ip',
      src: normAddr(kv['src-address']),
      dst: normAddr(kv['dst-address']),
      dport: kv['dst-port'] ? portNum(kv['dst-port']) : null,
    };
    // in-interface / out-interface scope the rule like the real firewall does.
    // connection-state=established,related — match replies of tracked flows only.
    if (kv['connection-state']) {
      const st = new Set();
      for (const s of kv['connection-state'].split(',')) {
        if (s === 'established' || s === 'related') st.add('established');
        else if (s === 'new' || s === 'invalid') st.add(s);
      }
      if (st.size) rule.state = [...st];
    }
    if (validIfName(kv['in-interface'])) { rule.iface = kv['in-interface']; rule.dir = 'in'; }
    else if (validIfName(kv['out-interface'])) { rule.iface = kv['out-interface']; rule.dir = 'out'; }
    config.acls.push(rule);
    return { output: [] };
  }

  // OSPF: /routing ospf instance add …  +  /routing ospf network add network=…/… area=…
  if ((path === '/routing ospf instance' || path === '/routing rip instance' || path === '/routing rip') && (verb === 'remove' || verb === 'disable')) {
    config[path.includes('ospf') ? 'ospf' : 'rip'] = null;
    return { output: [] };
  }
  if (path === '/routing ospf instance' && verb === 'add') {
    if (!config.ospf) config.ospf = { enabled: true, networks: [] };
    config.ospf.enabled = true;
    return { output: [] };
  }
  if (path === '/routing ospf network' && verb === 'add') {
    if (!config.ospf) config.ospf = { enabled: true, networks: [] };
    if (!config.ospf.networks) config.ospf.networks = [];
    if (kv.network) config.ospf.networks.push(kv.network);
    return { output: [] };
  }
  if ((path === '/routing rip instance' || path === '/routing rip') && verb === 'add') {
    if (!config.rip) config.rip = { enabled: true, networks: [] };
    config.rip.enabled = true;
    return { output: [] };
  }
  if (path === '/routing rip network' && verb === 'add') {
    if (!config.rip) config.rip = { enabled: true, networks: [] };
    if (!config.rip.networks) config.rip.networks = [];
    if (kv.network) config.rip.networks.push(kv.network);
    return { output: [] };
  }

  // A tagged VLAN subinterface: /interface vlan add name=v10 vlan-id=10 interface=ether1
  if (path === '/interface vlan' && verb === 'add' && validIfName(kv.name) && kv['vlan-id']) {
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
    if (i.aclIn) out.push(` ip access-group ${i.aclIn} in`);
    if (i.aclOut) out.push(` ip access-group ${i.aclOut} out`);
    out.push(i.shutdown ? ' shutdown' : ' no shutdown', '!');
  }
  for (const r of config.routes) {
    const [net, p] = r.cidr.split('/');
    out.push(`ip route ${net} ${prefixToMask(+p)} ${r.via}`);
  }
  for (const p of config.dhcpPools || []) {
    out.push(`ip dhcp pool ${p.name}`);
    if (p.cidr) { const [n, pl] = p.cidr.split('/'); out.push(` network ${n} ${prefixToMask(+pl)}`); }
    if (p.router) out.push(` default-router ${p.router}`);
    out.push('!');
  }
  for (const proto of ['ospf', 'rip']) {
    const p = config[proto];
    if (!p || !p.enabled) continue;
    out.push(proto === 'ospf' ? 'router ospf 1' : 'router rip');
    for (const n of p.networks || []) out.push(` network ${n}`);
    out.push('!');
  }
  for (const r of config.acls || []) out.push(aclLine(r));
  if (config.natEnabled) out.push('ip nat inside source list 1 interface overload');
  return out;
}

const showAddr = (a) => (!a || a === 'any' ? 'any' : /\/32$/.test(a) ? `host ${a.slice(0, -3)}` : a);
function aclLine(r) {
  return `access-list ${r.list != null ? r.list : '-'} ${r.action} ${r.proto || 'ip'} ${showAddr(r.src)} ${showAddr(r.dst)}${r.dport != null ? ` eq ${r.dport}` : ''}${r.state ? ` ${r.state.join(',')}` : ''}${r.iface ? ` (${r.dir || 'in'} ${r.iface})` : ''}`;
}
function showAccessLists(config) {
  const rules = config.acls || [];
  return rules.length ? rules.map((r, i) => `${String(i + 1).padStart(3)}  ${aclLine(r)}`) : ['% no access-lists / filter rules'];
}
function showInterfaces(config) {
  const ifs = Object.values(config.interfaces);
  if (!ifs.length) return ['% no interfaces configured'];
  const rows = [['Interface', 'Status', 'Mode', 'VLAN', 'IP-Address']];
  for (const i of ifs) {
    const vlan = i.mode === 'trunk' ? (i.allowed && i.allowed.length ? i.allowed.join(',') : 'all') : i.vlan != null ? String(i.vlan) : '-';
    rows.push([i.name, i.shutdown ? 'admin down' : 'up', i.mode || '-', vlan, i.ip != null ? `${i.ip}/${i.prefix}` : '-']);
  }
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((c, k) => String(c).padEnd(w[k])).join('  ').trimEnd());
}
function showIpProtocols(config) {
  const out = [];
  for (const [proto, label] of [['ospf', 'ospf 1'], ['rip', 'rip']]) {
    const p = config[proto];
    if (!p || !p.enabled) continue;
    out.push(`Routing Protocol is "${label}"`);
    out.push(`  Routing for Networks: ${(p.networks || []).length ? '' : '(all interfaces)'}`);
    for (const n of p.networks || []) out.push(`    ${n}`);
  }
  return out.length ? out : ['% no routing protocol is running'];
}

// RouterOS-style `/export` of the modelled config. Same grammar the real device
// prints for these sections, so it reads naturally and the drift checker can
// parse it back.
function exportRouterOs(config) {
  const out = [`# plexus simulated export — ${config.hostname || 'MikroTik'}`];
  const ifs = Object.values(config.interfaces);
  const sec = (path, lines) => { if (lines.length) out.push(path, ...lines); };
  const vlanIfs = ifs.filter((i) => i.mode === 'routed' && i.vlan != null);
  sec('/interface vlan', vlanIfs.map((i) => `add name=${i.name} vlan-id=${i.vlan}`));
  sec('/interface bridge port', ifs.filter((i) => i.mode === 'access' || i.mode === 'trunk')
    .map((i) => `add interface=${i.name}${i.mode === 'access' && i.vlan != null ? ` pvid=${i.vlan}` : ''}${i.mode === 'trunk' ? ' frame-types=admit-only-vlan-tagged' : ''}`));
  const byVlan = new Map();
  for (const i of ifs.filter((x) => x.mode === 'trunk')) for (const v of i.allowed || []) { if (!byVlan.has(v)) byVlan.set(v, []); byVlan.get(v).push(i.name); }
  sec('/interface bridge vlan', [...byVlan].sort((a, b) => a[0] - b[0]).map(([v, names]) => `add tagged=${names.join(',')} vlan-ids=${v}`));
  sec('/ip address', ifs.filter((i) => i.ip != null && i.prefix != null).map((i) => `add address=${i.ip}/${i.prefix} interface=${i.name}`));
  sec('/ip dhcp-server network', (config.dhcpPools || []).filter((p) => p.cidr).map((p) => `add address=${p.cidr}${p.router ? ` gateway=${p.router}` : ''}`));
  sec('/ip dhcp-relay', ifs.filter((i) => i.helper).map((i) => `add dhcp-server=${i.helper} interface=${i.name}`));
  sec('/ip firewall filter', (config.acls || []).map((r) => `add action=${r.action === 'deny' ? 'drop' : 'accept'} chain=forward${r.state ? ` connection-state=${r.state.join(',')}` : ''}${r.proto && r.proto !== 'ip' ? ` protocol=${r.proto}` : ''}${r.src && r.src !== 'any' ? ` src-address=${r.src}` : ''}${r.dst && r.dst !== 'any' ? ` dst-address=${r.dst}` : ''}${r.dport != null ? ` dst-port=${r.dport}` : ''}${r.iface ? ` ${r.dir === 'out' ? 'out' : 'in'}-interface=${r.iface}` : ''}`));
  if (config.natMasquerade && config.natMasquerade.outside) out.push('/ip firewall nat', `add action=masquerade chain=srcnat out-interface=${config.natMasquerade.outside}`);
  sec('/ip route', config.routes.map((r) => `add dst-address=${r.cidr} gateway=${r.via}`));
  if (config.ospf && config.ospf.enabled) { out.push('/routing ospf instance', 'add name=default'); sec('/routing ospf network', (config.ospf.networks || []).map((n) => `add network=${n}`)); }
  if (config.rip && config.rip.enabled) out.push('/routing rip instance', 'add name=default');
  out.push('/system identity', `set name=${/^[\w.-]+$/.test(config.hostname || '') ? config.hostname : `"${String(config.hostname || 'MikroTik').replace(/["\\$]/g, '_')}"`}`);
  return out;
}

// ── Help / completion ────────────────────────────────────────────────────────
// What can be typed in each mode. Drives `?` and Tab; kept next to the parser so
// a new command gets its help entry in the same change.
const IOS_COMMANDS = {
  exec: ['enable', 'ping', 'show ip route', 'show ip interface brief', 'show vlan'],
  enable: ['configure terminal', 'copy running-config startup-config', 'exit', 'ping', 'reload', 'show access-lists', 'show arp',
    'show interfaces', 'show ip dhcp pool', 'show ip interface brief', 'show ip nat translations', 'show ip ospf neighbor', 'show ip protocols',
    'show ip route', 'show mac address-table', 'show running-config', 'show spanning-tree', 'show startup-config', 'show vlan', 'write memory'],
  config: ['access-list', 'do', 'end', 'exit', 'hostname', 'interface', 'ip dhcp pool', 'ip nat inside source list', 'ip route',
    'no access-list', 'no ip dhcp pool', 'no ip route', 'no router ospf', 'no router rip', 'router ospf', 'router rip', 'vlan'],
  'config-if': ['do', 'encapsulation dot1q', 'end', 'exit', 'ip access-group', 'ip address', 'ip helper-address', 'ip nat inside', 'ip nat outside',
    'no ip access-group', 'no ip address', 'no ip helper-address', 'no shutdown', 'shutdown', 'switchport access vlan', 'switchport mode access',
    'switchport mode trunk', 'switchport trunk allowed vlan'],
  'config-vlan': ['do', 'end', 'exit', 'name'],
  'config-router': ['do', 'end', 'exit', 'network', 'passive-interface', 'router-id'],
  'config-dhcp': ['default-router', 'dns-server', 'do', 'end', 'exit', 'network'],
};
const ROS_COMMANDS = ['/export', '/interface bridge host print', '/interface bridge port add', '/interface bridge vlan add', '/interface print',
  '/interface vlan add', '/ip address add', '/ip address print', '/ip arp print', '/ip dhcp-relay add', '/ip dhcp-server add',
  '/ip dhcp-server network add', '/ip firewall connection print', '/ip firewall filter add', '/ip firewall filter print', '/ip firewall nat add',
  '/ip route add', '/ip route print', '/ping', '/routing ospf instance add', '/routing ospf instance remove', '/routing ospf network add',
  '/routing rip instance add', '/routing rip network add', '/system identity set'];

function iosCandidates(mode, partial) {
  const p = String(partial || '').toLowerCase().replace(/\s+/g, ' ');
  return (IOS_COMMANDS[mode] || []).filter((c) => c.startsWith(p));
}
function rosCandidates(partial) {
  const p = String(partial || '').replace(/\s+/g, ' ');
  return ROS_COMMANDS.filter((c) => c.startsWith(p));
}
function commonPrefix(list) {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) { while (!s.startsWith(p)) p = p.slice(0, -1); }
  return p;
}
/**
 * Tab completion. Returns the line to put in the input and, when the prefix is
 * ambiguous, the options to show.
 * @param {{vendor:string, ctx:{mode:string}}} session @param {string} line
 * @returns {{text:string, options:string[]}}
 */
export function complete(session, line) {
  const raw = String(line || '').replace(/^\s+/, '');
  const opts = session.vendor === 'mikrotik' ? rosCandidates(raw) : iosCandidates(session.ctx.mode, raw);
  if (!opts.length) return { text: line, options: [] };
  if (opts.length === 1) return { text: `${opts[0]} `, options: [] };
  const cp = commonPrefix(opts);
  return { text: cp.length > raw.length ? cp : raw, options: opts };
}

// ── Config → engine packet-filter rules ──────────────────────────────────────
// Resolve access-list bindings into the engine's rule shape. An IOS list bound
// with `ip access-group` yields one copy of its rules per binding, scoped to
// that interface + direction; a list bound nowhere stays device-wide (the sim's
// original behaviour, so a bare `access-list` still filters). RouterOS rules
// carry their own in/out-interface. `simName` maps a CLI interface to the name
// it has in the simulated device (SVIs are renamed by the plan adapter).
/** @param {any} config @param {(i:any)=>string} [simName] */
export function effectiveAcls(config, simName = (i) => i.name) {
  const rules = Array.isArray(config && config.acls) ? config.acls.filter((r) => r && (r.action === 'permit' || r.action === 'deny')) : [];
  const ifs = config && config.interfaces && typeof config.interfaces === 'object' ? Object.values(config.interfaces) : [];
  const byName = new Map(ifs.filter((i) => i && i.name).map((i) => [i.name, i]));
  const bound = new Set();
  for (const i of ifs) { if (i && i.aclIn) bound.add(String(i.aclIn)); if (i && i.aclOut) bound.add(String(i.aclOut)); }
  const strip = ({ list, ...r }) => r;
  const out = [];
  for (const r of rules) {
    if (r.list != null && bound.has(String(r.list))) continue; // emitted per binding below
    if (r.iface) { const i = byName.get(r.iface); out.push({ ...strip(r), iface: i ? simName(i) : r.iface }); }
    else out.push(strip(r));
  }
  for (const i of ifs) {
    for (const [id, dir] of [[i && i.aclIn, 'in'], [i && i.aclOut, 'out']]) {
      if (!id) continue;
      for (const r of rules) if (String(r.list) === String(id)) out.push({ ...strip(r), iface: simName(i), dir });
    }
  }
  return out;
}

// IGP `network` statements → [{base, mask}] matchers. IOS OSPF: "10.0.0.0
// 0.0.0.255 area 0" (wildcard mask); RouterOS and plain CIDR: "10.0.0.0/24";
// IOS RIP: a bare classful network "10.0.0.0". Unparsable entries are ignored.
export function parseIgpNetworks(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const tok = String(raw).trim().split(/\s+/);
    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(tok[0]);
    if (cidr) {
      const p = +cidr[2]; const b = ipToInt(cidr[1]);
      if (b == null || p > 32) continue;
      const mask = p <= 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
      out.push({ base: (b & mask) >>> 0, mask });
      continue;
    }
    const b = ipToInt(tok[0]);
    if (b == null) continue;
    const wc = tok[1] != null ? ipToInt(tok[1]) : null;
    let mask;
    if (wc != null) mask = (~wc) >>> 0;
    else { const o = b >>> 24; mask = o < 128 ? 0xff000000 : o < 192 ? 0xffff0000 : 0xffffff00; } // classful
    out.push({ base: (b & mask) >>> 0, mask: mask >>> 0 });
  }
  return out;
}
// Does an interface address fall under any `network` statement? No statements
// at all means "every interface" (the sim's permissive default).
export function igpCovers(matchers, ipInt) {
  if (!matchers.length) return true;
  return matchers.some((m) => ((ipInt & m.mask) >>> 0) === m.base);
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
  let outside = null;
  const inside = [];
  if (config.natMasquerade && config.natMasquerade.outside) {
    outside = config.natMasquerade.outside;
    for (const i of Object.values(config.interfaces)) if (i.name !== outside && i.ip != null && i.prefix != null) inside.push(`${i.ip}/${i.prefix}`);
  } else if (config.natEnabled) {
    for (const i of Object.values(config.interfaces)) {
      if (i.natRole === 'outside') outside = i.name;
      else if (i.natRole === 'inside' && i.ip != null && i.prefix != null) inside.push(`${i.ip}/${i.prefix}`);
    }
  }
  const dev = {
    id: id || config.hostname || 'dev',
    name: config.hostname || id,
    kind,
    vendor: config.vendor,
    ifaces,
    routes: config.routes.map((r) => ({ cidr: r.cidr, via: r.via })),
    acls: effectiveAcls(config),
  };
  if (outside && inside.length) dev.nat = { inside, outside };
  return dev;
}
