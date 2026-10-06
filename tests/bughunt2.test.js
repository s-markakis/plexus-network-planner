// Second adversarial bug-hunt: the wiring added after the first pass — GUI client
// placement data, RIP/NAT/cloud/dot1q wiring, and the auto internet-cloud.
import { describe, it, expect } from 'vitest';
import { ping } from '../files/src/sim.js';
import { compileTopology, pingableDevices } from '../files/src/simCompile.js';
import { newConfig, makeSession } from '../files/src/cli.js';

const cfg = (lines, vendor = 'cisco', name = 'R') => { const s = makeSession(newConfig({ vendor, hostname: name })); lines.forEach((l) => s.exec(l)); return s.config; };

describe('auto internet-cloud edge cases', () => {
  it('does NOT synthesize a cloud for a default route via a host-owned IP', () => {
    const cli = cfg(['en', 'conf t', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 10.0.10.5', 'end']);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ SWS: [{ id: 'core', cli }], APS: [{ id: 'pc', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    expect([...c.net.devices.keys()].some((k) => k.startsWith('cloud:'))).toBe(false);
  });
  it('does NOT synthesize a cloud when the next-hop is on no interface subnet', () => {
    const cli = cfg(['en', 'conf t', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1', 'end']);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ SWS: [{ id: 'core', cli }], APS: [{ id: 'pc', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    expect([...c.net.devices.keys()].some((k) => k.startsWith('cloud:'))).toBe(false);
  });
});

describe('NAT config correctness', () => {
  it('the NAT inside list excludes the outside/WAN subnet', () => {
    const cli = cfg(['en', 'conf t',
      'interface lan', 'ip address 10.0.0.1 255.255.255.0', 'ip nat inside', 'exit',
      'interface wan', 'ip address 203.0.113.2 255.255.255.252', 'ip nat outside', 'exit',
      'ip nat inside source list 1 interface wan overload',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    const c = compileTopology({
      settings: { vlans: [] },
      floors: [{ SWS: [{ id: 'edge', cli, role: 'l3' }], APS: [], CAMS: [] }],
    });
    const edge = c.net.devices.get('r:edge');
    expect(edge.nat).toBeTruthy();
    expect(edge.nat.inside.some((cidr) => cidr.startsWith('203.0.113'))).toBe(false);
    expect(edge.nat.inside.some((cidr) => cidr.startsWith('10.0.0'))).toBe(true);
  });
});

describe('RIP + OSPF coexistence from CLI', () => {
  it('a device can run both without breaking forwarding', () => {
    const a = cfg(['en', 'conf t', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit', 'interface t', 'ip address 10.0.99.1 255.255.255.252', 'exit', 'router ospf 1', 'exit', 'router rip', 'end'], 'cisco', 'A');
    const b = cfg(['en', 'conf t', 'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'exit', 'interface t', 'ip address 10.0.99.2 255.255.255.252', 'exit', 'router ospf 1', 'exit', 'router rip', 'end'], 'cisco', 'B');
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{ SWS: [{ id: 'a', cli: a }, { id: 'b', cli: b, uplinkId: 'a', uplinkMode: 'routed' }], APS: [{ id: 'h1', swId: 'a', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [{ id: 'h2', swId: 'b', port: '2', vlan: '20', ip: '10.0.20.5' }] }],
    });
    expect(ping(c.net, { from: 'h:h1', to: '10.0.20.5' }).ok).toBe(true);
  });
});

describe('wireless client robustness', () => {
  const floor = (clients, aps) => ({
    settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }] },
    floors: [{ id: 'f1', imgW: 1000, imgH: 1000, scaleM: 100, SWS: [{ id: 'sw', role: 'l3' }], APS: aps, CAMS: [], WALLS: [], CLIENTS: clients }],
  });
  const ap = { id: 'ap', name: 'AP', fx: 0.5, fy: 0.5, r: 600, freq: '5 GHz', swId: 'sw', vlan: '10', ip: '10.0.10.2' };

  it('a client with no fx/fy is skipped, not fatal', () => {
    const c = compileTopology(floor([{ id: 'bad' }], [ap]));
    expect(c.net.devices.has('h:bad')).toBe(false);
  });
  it('a client whose best AP has no switch is not associated', () => {
    const c = compileTopology(floor([{ id: 'cl', fx: 0.5, fy: 0.5, ip: 'dhcp' }], [{ ...ap, swId: '' }]));
    expect(c.net.devices.has('h:cl')).toBe(false);
    expect(c.warnings.some((w) => /no in-range AP on a switch/.test(w))).toBe(true);
  });
  it('malformed CLIENTS entries do not crash compile', () => {
    expect(() => compileTopology(floor([null, 'x', { id: 'ok', fx: 0.5, fy: 0.5, ip: 'dhcp' }], [ap]))).not.toThrow();
  });
});

describe('hostile project input', () => {
  it('__proto__ device ids do not pollute Object.prototype', () => {
    compileTopology({ settings: { vlans: [] }, floors: [{ SWS: [{ id: '__proto__' }], APS: [{ id: 'constructor', swId: '__proto__', port: '1', vlan: '1', ip: '10.0.0.1' }], CAMS: [] }] });
    expect({}.polluted).toBeUndefined();
    expect(({}).constructor).toBe(Object);
  });
  it('a totally malformed project fails closed, never throws', () => {
    for (const p of [null, {}, { floors: 'x' }, { floors: [{ SWS: 'x', APS: null, CLIENTS: 7 }] }, { settings: { vlans: 'no' }, floors: [{}] }]) {
      expect(() => compileTopology(p)).not.toThrow();
    }
  });
});

describe('pingableDevices never exposes synthetic/internal devices', () => {
  it('clouds and routers are not pingable sources', () => {
    const cli = cfg(['en', 'conf t', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 10.0.99.1', 'exit', 'interface wan', 'ip address 10.0.99.2 255.255.255.252', 'end']);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ SWS: [{ id: 'core', cli }], APS: [{ id: 'a', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    const ids = pingableDevices(c).map((d) => d.simId);
    expect(ids.every((i) => i.startsWith('h:'))).toBe(true);
    expect(ids.some((i) => i.startsWith('cloud:') || i.startsWith('r:'))).toBe(false);
  });
});

describe('full NAT + auto-cloud chain via CLI', () => {
  it('an inside host reaches the internet through CLI-configured NAT + synthesized cloud', () => {
    const cli = cfg(['en', 'conf t',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'ip nat inside', 'exit',
      'interface wan', 'ip address 203.0.113.2 255.255.255.252', 'ip nat outside', 'exit',
      'ip nat inside source list 1 interface wan overload',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ SWS: [{ id: 'edge', cli }], APS: [{ id: 'pc', swId: 'edge', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    const r = ping(c.net, { from: 'h:pc', to: '8.8.8.8' });
    expect(r.ok).toBe(true);
    // the cloud saw the public (NAT'd) source, never the private host
    const cloudReply = r.events.find((e) => e.kind === 'cloud-reply');
    expect(cloudReply.from).toBe('203.0.113.2');
  });
});

describe('duplicate VLAN gateway determinism', () => {
  it('a dot1q subinterface and an interface vlan for the same VLAN do not double-route', () => {
    const cli = cfg(['en', 'conf t',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit',
      'interface Gi0/0.10', 'encapsulation dot1q 10', 'ip address 10.0.10.254 255.255.255.0', 'exit',
      'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'end']);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{ SWS: [{ id: 'core', cli }], APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [{ id: 'c1', swId: 'core', port: '2', vlan: '20', ip: '10.0.20.5' }] }],
    });
    // only one SVI per VLAN should be hosted (first wins) — still routes fine
    const svis = [...c.net.devices.get('r:core').ifaces.keys()].filter((n) => n.startsWith('svi'));
    expect(svis.sort()).toEqual(['svi10', 'svi20']);
    expect(ping(c.net, { from: 'h:a1', to: '10.0.20.5' }).ok).toBe(true);
  });
});
