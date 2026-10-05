// Adversarial / robustness suite for the packet-tracer engine + adapter.
// The "attacker" here is malformed or hostile *plan data* and pathological
// *topologies*: the engine must stay bounded (no hang / no stack blow-up),
// fail closed on bad input, and never produce a wrong-but-plausible "reachable".
import { describe, it, expect } from 'vitest';
import { buildNet, ping, traceroute, resetRuntime } from '../files/src/sim.js';
import { compileTopology, pingableDevices } from '../files/src/simCompile.js';

// ── Termination / DoS resistance ─────────────────────────────────────────────
describe('bounded under pathological topologies', () => {
  it('a routing loop terminates and reports non-delivery (TTL budget spent)', () => {
    // R1 default→R2, R2 default→R1; destination nobody owns.
    const net = buildNet({
      devices: [
        { id: 'h', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'r1', kind: 'router', ifaces: [{ name: 'a', ip: '10.0.0.1', prefix: 24 }, { name: 'b', ip: '10.0.1.1', prefix: 30 }], routes: [{ cidr: '0.0.0.0/0', via: '10.0.1.2' }] },
        { id: 'r2', kind: 'router', ifaces: [{ name: 'a', ip: '10.0.1.2', prefix: 30 }], routes: [{ cidr: '0.0.0.0/0', via: '10.0.1.1' }] },
      ],
      links: [['h/e', 'r1/a'], ['r1/b', 'r2/a']],
    });
    const r = ping(net, { from: 'h', to: '8.8.8.8' });
    expect(r.ok).toBe(false);
    expect(['unreachable', 'ttl-exceeded']).toContain(r.status);
    expect(r.events.length).toBeLessThan(5000); // bounded, not runaway
  }, 2000);

  it('traceroute on a routing loop is capped at maxHops', () => {
    const net = buildNet({
      devices: [
        { id: 'h', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'r1', kind: 'router', ifaces: [{ name: 'a', ip: '10.0.0.1', prefix: 24 }, { name: 'b', ip: '10.0.1.1', prefix: 30 }], routes: [{ cidr: '0.0.0.0/0', via: '10.0.1.2' }] },
        { id: 'r2', kind: 'router', ifaces: [{ name: 'a', ip: '10.0.1.2', prefix: 30 }], routes: [{ cidr: '0.0.0.0/0', via: '10.0.1.1' }] },
      ],
      links: [['h/e', 'r1/a'], ['r1/b', 'r2/a']],
    });
    const hops = traceroute(net, { from: 'h', to: '8.8.8.8', maxHops: 8 });
    expect(hops.length).toBeLessThanOrEqual(8);
  }, 2000);

  it('an L2 switch ring does not loop forever when flooding', () => {
    // Three switches cabled in a ring (no STP modelled). ARP must terminate.
    const net = buildNet({
      devices: [
        { id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] },
        { id: 'b', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24 }] },
        { id: 's1', kind: 'switch', ifaces: [{ name: 'h', mode: 'access', vlan: 1 }, { name: 't2', mode: 'trunk' }, { name: 't3', mode: 'trunk' }] },
        { id: 's2', kind: 'switch', ifaces: [{ name: 't1', mode: 'trunk' }, { name: 't3', mode: 'trunk' }] },
        { id: 's3', kind: 'switch', ifaces: [{ name: 'h', mode: 'access', vlan: 1 }, { name: 't1', mode: 'trunk' }, { name: 't2', mode: 'trunk' }] },
      ],
      links: [
        ['a/e', 's1/h'], ['b/e', 's3/h'],
        ['s1/t2', 's2/t1'], ['s2/t3', 's3/t1'], ['s3/t2', 's1/t3'],
      ],
    });
    const r = ping(net, { from: 'a', to: '10.0.0.2' }); // a throw here fails the test; 2s timeout guards a hang
    expect(typeof r.ok).toBe('boolean');
    expect(r.events.length).toBeLessThan(5000);
  }, 2000);

  it('a self-linked switch port does not hang', () => {
    const net = buildNet({
      devices: [
        { id: 'h', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] },
        { id: 's', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: 1 }, { name: 'b', mode: 'access', vlan: 1 }] },
      ],
      links: [['h/e', 's/a'], ['s/b', 's/b']],
    });
    expect(() => ping(net, { from: 'h', to: '10.0.0.9' })).not.toThrow();
  }, 2000);
});

// ── Fail-closed on malformed plan data ───────────────────────────────────────
describe('compileTopology never throws on malformed input', () => {
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['floors null', { floors: null }],
    ['floors not array', { floors: 'nope' }],
    ['null device arrays', { floors: [{ SWS: null, APS: null, CAMS: null }] }],
    ['settings null', { settings: null, floors: [] }],
    ['vlans not array', { settings: { vlans: 'x' }, floors: [] }],
    ['device entries null', { floors: [{ SWS: [null], APS: [null], CAMS: [undefined] }] }],
  ];
  for (const [name, input] of cases) {
    it(`handles ${name}`, () => {
      const c = compileTopology(input); // a throw here fails the test
      expect(c.net.devices).toBeInstanceOf(Map);
      expect(Array.isArray(c.warnings)).toBe(true);
    });
  }

  it('skips (not throws) two switches sharing a missing id', () => {
    const c = compileTopology({ settings: { vlans: [] }, floors: [{ SWS: [{ name: 'a' }, { name: 'b' }], APS: [], CAMS: [] }] });
    expect(c.net.devices.size).toBe(0);
    expect(c.warnings.filter((w) => /missing id/.test(w))).toHaveLength(2);
  });

  it('skips a duplicate endpoint id rather than colliding', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ SWS: [{ id: 's' }], APS: [
        { id: 'x', swId: 's', port: '1', vlan: '10', ip: '10.0.10.1' },
        { id: 'x', swId: 's', port: '2', vlan: '10', ip: '10.0.10.2' },
      ], CAMS: [] }],
    });
    expect(c.net.devices.has('h:x')).toBe(true);
    expect(c.warnings.some((w) => /duplicate id x/.test(w))).toBe(true);
  });

  it('skips a duplicate switch id', () => {
    const c = compileTopology({ settings: { vlans: [] }, floors: [{ SWS: [{ id: 's', name: 'A' }, { id: 's', name: 'B' }], APS: [], CAMS: [] }] });
    expect([...c.net.devices.keys()]).toEqual(['sw:s']);
    expect(c.warnings.some((w) => /duplicate id s/.test(w))).toBe(true);
  });

  it('id like __proto__ does not pollute or crash', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '1', subnet: '10.0.0.0/24' }] },
      floors: [{ SWS: [{ id: '__proto__' }], APS: [{ id: 'constructor', swId: '__proto__', port: '1', vlan: '1', ip: '10.0.0.5' }], CAMS: [] }],
    });
    expect(c.net.devices.has('h:constructor')).toBe(true);
    expect({}.polluted).toBeUndefined();
  });
});

// ── Fail-closed on malformed addressing ──────────────────────────────────────
describe('bad addresses are rejected, not trusted', () => {
  const bad = (ip) => compileTopology({
    settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
    floors: [{ SWS: [{ id: 's' }], APS: [{ id: 'x', swId: 's', port: '1', vlan: '10', ip }], CAMS: [] }],
  });

  for (const ip of ['999.1.1.1', '10.0.0', 'abc', '10.0.0.0.0', '-1.0.0.0', '10.0.0.256']) {
    it(`skips endpoint with invalid IP ${ip}`, () => {
      const c = bad(ip);
      expect(c.net.devices.has('h:x')).toBe(false);
      expect(c.warnings.some((w) => /invalid IP/.test(w))).toBe(true);
    });
  }

  it('ignores an invalid VLAN subnet (endpoints fall back, no crash)', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/99', gateway: '10.0.10.1' }] },
      floors: [{ SWS: [{ id: 's' }], APS: [{ id: 'x', swId: 's', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    expect(c.warnings.some((w) => /invalid subnet/.test(w))).toBe(true);
    expect(c.net.devices.has('h:x')).toBe(true); // still placed, /24 fallback
  });

  it('ignores an invalid VLAN gateway but keeps the VLAN', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: 'not-an-ip' }] },
      floors: [{ SWS: [{ id: 'core', role: 'l3' }], APS: [{ id: 'x', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    expect(c.warnings.some((w) => /invalid gateway/.test(w))).toBe(true);
    // No valid gateway anywhere ⇒ the L3 switch adds no SVI and warns.
    expect(c.net.devices.has('r:core')).toBe(false);
  });

  it('ping throws a clean error (does not hang) on a bad destination', () => {
    const net = buildNet({ devices: [{ id: 'h', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] }], links: [] });
    expect(() => ping(net, { from: 'h', to: 'not.an.ip' })).toThrow(/bad destination/);
    expect(() => ping(net, { from: 'ghost', to: '10.0.0.1' })).toThrow(/no such device/);
  });
});

// ── Operational correctness edge cases ───────────────────────────────────────
describe('forwarding edge cases', () => {
  const twoHostOneSwitch = (vlanA = 1, vlanB = 1) => buildNet({
    devices: [
      { id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] },
      { id: 'b', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24 }] },
      { id: 's', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: vlanA }, { name: 'b', mode: 'access', vlan: vlanB }] },
    ],
    links: [['a/e', 's/a'], ['b/e', 's/b']],
  });

  it('self-ping (own IP) is delivered', () => {
    expect(ping(twoHostOneSwitch(), { from: 'a', to: '10.0.0.1' }).ok).toBe(true);
  });

  it('a down interface makes the peer unreachable', () => {
    const net = buildNet({
      devices: [
        { id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] },
        { id: 'b', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24, up: false }] },
        { id: 's', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: 1 }, { name: 'b', mode: 'access', vlan: 1 }] },
      ],
      links: [['a/e', 's/a'], ['b/e', 's/b']],
    });
    expect(ping(net, { from: 'a', to: '10.0.0.2' }).ok).toBe(false);
  });

  it('a trunk that disallows the VLAN on both sides keeps hosts isolated', () => {
    // Symmetric: neither trunk carries VLAN 10, so the frame is never even put
    // on the trunk — isolated, no l2-drop event (blocked at egress selection).
    const net = buildNet({
      devices: [
        { id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] },
        { id: 'b', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24 }] },
        { id: 's1', kind: 'switch', ifaces: [{ name: 'h', mode: 'access', vlan: 10 }, { name: 't', mode: 'trunk', allowed: [20] }] },
        { id: 's2', kind: 'switch', ifaces: [{ name: 'h', mode: 'access', vlan: 10 }, { name: 't', mode: 'trunk', allowed: [20] }] },
      ],
      links: [['a/e', 's1/h'], ['b/e', 's2/h'], ['s1/t', 's2/t']],
    });
    expect(ping(net, { from: 'a', to: '10.0.0.2' }).ok).toBe(false);
  });

  it('an asymmetric trunk drops the disallowed VLAN at ingress', () => {
    // s1 carries VLAN 10 out the trunk, s2 does not accept it → ingress drop.
    const net = buildNet({
      devices: [
        { id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] },
        { id: 'b', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24 }] },
        { id: 's1', kind: 'switch', ifaces: [{ name: 'h', mode: 'access', vlan: 10 }, { name: 't', mode: 'trunk', allowed: [10, 20] }] },
        { id: 's2', kind: 'switch', ifaces: [{ name: 'h', mode: 'access', vlan: 10 }, { name: 't', mode: 'trunk', allowed: [20] }] },
      ],
      links: [['a/e', 's1/h'], ['b/e', 's2/h'], ['s1/t', 's2/t']],
    });
    const r = ping(net, { from: 'a', to: '10.0.0.2' });
    expect(r.ok).toBe(false);
    expect(r.events.some((e) => e.kind === 'l2-drop-vlan')).toBe(true);
  });

  it('a host off-subnet with no gateway gets no route', () => {
    const net = twoHostOneSwitch();
    const r = ping(net, { from: 'a', to: '192.168.1.1' });
    expect(r.ok).toBe(false);
    expect(r.events.some((e) => e.kind === 'l3-no-route')).toBe(true);
  });

  it('a gateway that no device owns yields ARP failure, not a hang', () => {
    const net = buildNet({
      devices: [{ id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }], gateway: '10.0.0.254' }],
      links: [],
    });
    const r = ping(net, { from: 'a', to: '8.8.8.8' }); // throw fails the test; 2s timeout guards a hang
    expect(r.ok).toBe(false);
  }, 2000);

  it('duplicate IPs on a subnet resolve deterministically across runs', () => {
    const dup = () => buildNet({
      devices: [
        { id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }] },
        { id: 'b', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.9', prefix: 24 }] },
        { id: 'c', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.9', prefix: 24 }] },
        { id: 's', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: 1 }, { name: 'b', mode: 'access', vlan: 1 }, { name: 'c', mode: 'access', vlan: 1 }] },
      ],
      links: [['a/e', 's/a'], ['b/e', 's/b'], ['c/e', 's/c']],
    });
    const r1 = ping(dup(), { from: 'a', to: '10.0.0.9' });
    const r2 = ping(dup(), { from: 'a', to: '10.0.0.9' });
    expect(r1.ok).toBe(true);
    expect(r1.events.map((e) => e.kind)).toEqual(r2.events.map((e) => e.kind));
  });

  it('after MAC learning, a repeat unicast does not flood', () => {
    const net = twoHostOneSwitch();
    ping(net, { from: 'a', to: '10.0.0.2' });
    const r = ping(net, { from: 'a', to: '10.0.0.2' });
    expect(r.events.some((e) => e.kind === 'l2-flood')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('resetRuntime clears learned state so ARP + flood happen again', () => {
    const net = twoHostOneSwitch();
    ping(net, { from: 'a', to: '10.0.0.2' });
    // Warm run: sender uses its ARP cache, switch uses its MAC table.
    const warm = ping(net, { from: 'a', to: '10.0.0.2' });
    expect(warm.events.some((e) => e.kind === 'l2-flood')).toBe(false);
    // After reset, the cold exchange (request + flood) is traced from scratch.
    resetRuntime(net);
    const cold = ping(net, { from: 'a', to: '10.0.0.2' });
    expect(cold.events.some((e) => e.kind === 'arp-request')).toBe(true);
    expect(cold.events.some((e) => e.kind === 'l2-flood')).toBe(true);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────
describe('determinism', () => {
  it('two L3 switches cannot both claim the same VLAN gateway', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }, { id: '20', subnet: '10.0.20.0/24', gateway: '10.0.20.1' }] },
      floors: [{
        SWS: [{ id: 'core1', name: 'C1', role: 'l3' }, { id: 'core2', name: 'C2', role: 'l3' }],
        APS: [], CAMS: [],
      }],
    });
    // The first L3 switch owns both SVIs; the second gets none (and warns).
    expect([...c.net.devices.get('r:core1').ifaces.keys()].sort()).toEqual(['svi10', 'svi20']);
    expect(c.net.devices.has('r:core2')).toBe(false);
  });

  it('an uplink cycle compiles and still terminates at sim time', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{
        SWS: [{ id: 'x', name: 'X', uplinkId: 'y' }, { id: 'y', name: 'Y', uplinkId: 'x' }],
        APS: [
          { id: 'a', swId: 'x', port: '1', vlan: '10', ip: '10.0.10.1' },
          { id: 'b', swId: 'y', port: '1', vlan: '10', ip: '10.0.10.2' },
        ], CAMS: [],
      }],
    });
    const r = ping(c.net, { from: 'h:a', to: '10.0.10.2' }); // throw fails the test; 2s timeout guards a hang
    expect(r.events.length).toBeLessThan(5000);
  }, 2000);

  it('pingableDevices only lists addressed endpoints, never switches/routers', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }] },
      floors: [{ SWS: [{ id: 'core', role: 'l3' }], APS: [{ id: 'a', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    const list = pingableDevices(c);
    expect(list.every((d) => d.simId.startsWith('h:'))).toBe(true);
    expect(list).toHaveLength(1);
  });
});
