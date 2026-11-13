// Simulator features: fault injection + reconvergence, interface-bound ACLs,
// IGP network statements, switch management addresses, reachability matrix.
import { describe, it, expect } from 'vitest';
import { buildNet, ping, probe, setIfaceDown } from '../files/src/sim.js';
import { compileTopology, applyFaults, pingTargets } from '../files/src/simCompile.js';
import { newConfig, makeSession, effectiveAcls, parseIgpNetworks, igpCovers } from '../files/src/cli.js';
import { reachabilityMatrix } from '../files/src/simMatrix.js';
import { ipToInt } from '../files/src/network.js';

const cfg = (lines, vendor = 'cisco') => {
  const c = newConfig({ vendor });
  const s = makeSession(c, vendor);
  for (const l of lines) { const r = s.exec(l); if (r.error) throw new Error(`${l} → ${r.output}`); }
  return c;
};

describe('route withdrawal on a failed link', () => {
  const spec = () => ({
    devices: [
      { id: 'h', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.2', prefix: 24 }], gateway: '10.0.0.1' },
      { id: 'r1', kind: 'router', ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 'a', ip: '10.1.0.1', prefix: 30 }, { name: 'b', ip: '10.2.0.1', prefix: 30 }],
        routes: [{ cidr: '10.9.0.0/24', via: '10.1.0.2' }, { cidr: '10.9.0.0/16', via: '10.2.0.2' }] },
      { id: 'r2', kind: 'router', ifaces: [{ name: 'a', ip: '10.1.0.2', prefix: 30 }, { name: 'b', ip: '10.2.0.2', prefix: 30 }, { name: 'srv', ip: '10.9.0.1', prefix: 24 }],
        routes: [{ cidr: '10.0.0.0/24', via: '10.1.0.1' }, { cidr: '10.0.0.0/16', via: '10.2.0.1' }] },
    ],
    links: [['h/e', 'r1/lan'], ['r1/a', 'r2/a'], ['r1/b', 'r2/b']],
  });
  it('fails over to the backup route when the primary link goes down', () => {
    const net = buildNet(spec());
    const before = ping(net, { from: 'h', to: '10.9.0.1' });
    expect(before.ok).toBe(true);
    expect(before.events.find((e) => e.kind === 'l3-route' && e.dev === 'r1').via).toBe('10.1.0.2');
    setIfaceDown(net, 'r1', 'a'); setIfaceDown(net, 'r2', 'a');
    const after = ping(net, { from: 'h', to: '10.9.0.1' });
    expect(after.ok).toBe(true);
    expect(after.events.find((e) => e.kind === 'l3-route' && e.dev === 'r1').via).toBe('10.2.0.2');
  });
  it('is unreachable once both links are down', () => {
    const net = buildNet(spec());
    for (const i of ['a', 'b']) { setIfaceDown(net, 'r1', i); setIfaceDown(net, 'r2', i); }
    expect(ping(net, { from: 'h', to: '10.9.0.1' }).ok).toBe(false);
  });
});

describe('interface-bound ACLs', () => {
  const spec = (acls) => ({
    devices: [
      { id: 'h1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.1.2', prefix: 24 }], gateway: '10.0.1.1' },
      { id: 'h2', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.2.2', prefix: 24 }], gateway: '10.0.2.1', services: [{ proto: 'tcp', port: 22 }] },
      { id: 'h3', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.3.2', prefix: 24 }], gateway: '10.0.3.1' },
      { id: 'r', kind: 'router', acls, ifaces: [{ name: 'a', ip: '10.0.1.1', prefix: 24 }, { name: 'b', ip: '10.0.2.1', prefix: 24 }, { name: 'c', ip: '10.0.3.1', prefix: 24 }] },
    ],
    links: [['h1/e', 'r/a'], ['h2/e', 'r/b'], ['h3/e', 'r/c']],
  });
  const denyAll = { action: 'deny', proto: 'ip', src: 'any', dst: 'any' };
  it('an inbound rule only filters traffic entering that interface', () => {
    const net = () => buildNet(spec([{ ...denyAll, iface: 'a', dir: 'in' }]));
    expect(ping(net(), { from: 'h1', to: '10.0.2.2' }).status).toBe('filtered');
    expect(ping(net(), { from: 'h3', to: '10.0.2.2' }).ok).toBe(true);
  });
  it('an outbound rule filters traffic leaving that interface, from any source', () => {
    const net = () => buildNet(spec([{ action: 'deny', proto: 'tcp', src: 'any', dst: 'any', dport: 22, iface: 'b', dir: 'out' }]));
    expect(probe(net(), { from: 'h1', to: '10.0.2.2', port: 22 }).status).toBe('filtered');
    expect(probe(net(), { from: 'h3', to: '10.0.2.2', port: 22 }).status).toBe('filtered');
    expect(ping(net(), { from: 'h1', to: '10.0.2.2' }).ok).toBe(true);
  });
  it('an unbound rule stays device-wide', () => {
    expect(ping(buildNet(spec([denyAll])), { from: 'h3', to: '10.0.2.2' }).status).toBe('filtered');
  });
  it('IOS ip access-group scopes a list; an unbound list stays device-wide', () => {
    const c = cfg(['en', 'conf t', 'access-list 101 deny ip any any', 'access-list 102 deny tcp any any eq 22', 'interface g0/1', 'ip access-group 101 in']);
    expect(effectiveAcls(c)).toEqual([
      { action: 'deny', proto: 'tcp', src: 'any', dst: 'any', dport: 22 },
      { action: 'deny', proto: 'ip', src: 'any', dst: 'any', dport: null, iface: 'g0/1', dir: 'in' },
    ]);
  });
  it('RouterOS in-interface/out-interface scope a filter rule', () => {
    const c = cfg(['/ip firewall filter add chain=forward action=drop in-interface=ether2'], 'mikrotik');
    expect(effectiveAcls(c)[0]).toMatchObject({ action: 'deny', iface: 'ether2', dir: 'in' });
  });
  it('through the plan: an ACL bound to one SVI blocks only that VLAN', () => {
    const cli = cfg(['en', 'conf t', 'access-list 110 deny ip any 10.0.30.0 0.0.0.255', 'access-list 110 permit ip any any', 'interface vlan 10', 'ip access-group 110 in']);
    const project = {
      settings: { vlans: [10, 20, 30].map((v) => ({ id: String(v), subnet: `10.0.${v}.0/24`, gateway: `10.0.${v}.1` })) },
      floors: [{ id: 'f', SWS: [{ id: 's', name: 'Core', role: 'l3', cli }], CAMS: [],
        APS: [10, 20, 30].map((v, i) => ({ id: `a${v}`, name: `H${v}`, swId: 's', port: i + 1, vlan: String(v), ip: `10.0.${v}.5` })) }],
    };
    const net = () => compileTopology(project).net;
    expect(ping(net(), { from: 'h:a10', to: '10.0.30.5' }).status).toBe('filtered');
    expect(ping(net(), { from: 'h:a20', to: '10.0.30.5' }).ok).toBe(true);
    expect(ping(net(), { from: 'h:a10', to: '10.0.20.5' }).ok).toBe(true);
  });
});

describe('IGP control', () => {
  it('parses wildcard, CIDR and classful network statements', () => {
    const m = parseIgpNetworks(['10.0.0.0 0.0.0.255 area 0', '172.16.4.0/22', '192.168.5.0', 'garbage']);
    expect(m).toHaveLength(3);
    expect(igpCovers(m, ipToInt('10.0.0.9'))).toBe(true);
    expect(igpCovers(m, ipToInt('172.16.7.1'))).toBe(true);
    expect(igpCovers(m, ipToInt('192.168.5.200'))).toBe(true);
    expect(igpCovers(m, ipToInt('10.0.1.9'))).toBe(false);
    expect(igpCovers([], ipToInt('1.2.3.4'))).toBe(true);
  });
  it('no router ospf / rip turns the protocol off', () => {
    const c = cfg(['en', 'conf t', 'router ospf 1', 'exit', 'router rip', 'exit', 'no router ospf 1']);
    expect(c.ospf).toBeNull();
    expect(c.rip.enabled).toBe(true);
    cfg(['/routing ospf instance add name=default', '/routing ospf instance remove numbers=0'], 'mikrotik');
  });

  // Two sites joined by a routed /30; each advertises its LAN only if a network
  // statement covers it.
  const twoSites = (lanNet2) => {
    const site = (n, lanStmt) => cfg(['en', 'conf t', `interface vlan ${n}0`, `ip address 10.${n}.0.1 255.255.255.0`, 'interface g0/1', `ip address 10.255.0.${n} 255.255.255.252`, 'router ospf 1', 'network 10.255.0.0 0.0.0.3 area 0', lanStmt]);
    return {
      settings: { vlans: [] },
      floors: [{ id: 'f', CAMS: [],
        SWS: [{ id: 's1', name: 'S1', cli: site(1, 'network 10.1.0.0 0.0.0.255 area 0') }, { id: 's2', name: 'S2', uplinkId: 's1', uplinkMode: 'routed', cli: site(2, lanNet2) }],
        APS: [{ id: 'a1', name: 'A1', swId: 's1', port: 1, vlan: '10', ip: '10.1.0.5' }, { id: 'a2', name: 'A2', swId: 's2', port: 1, vlan: '20', ip: '10.2.0.5' }] }],
    };
  };
  it('a LAN covered by a network statement is advertised and reachable', () => {
    expect(ping(compileTopology(twoSites('network 10.2.0.0 0.0.0.255 area 0')).net, { from: 'h:a1', to: '10.2.0.5' }).ok).toBe(true);
  });
  it('a LAN left out of the network statements is not advertised', () => {
    expect(ping(compileTopology(twoSites('network 10.77.0.0 0.0.0.255 area 0')).net, { from: 'h:a1', to: '10.2.0.5' }).ok).toBe(false);
  });
  it('cutting the routed uplink withdraws the OSPF routes', () => {
    const c = compileTopology(twoSites('network 10.2.0.0 0.0.0.255 area 0'));
    expect(c.uplinks.map((u) => [u.id, u.mode])).toEqual([['s2', 'routed']]);
    expect(applyFaults(c, { links: ['s2'] })).toBe(1);
    const r = ping(c.net, { from: 'h:a1', to: '10.2.0.5' });
    expect(r.ok).toBe(false);
    expect(r.events.some((e) => e.kind === 'l3-no-route')).toBe(true);
  });
});

describe('plan-level faults, management addresses, targets, matrix', () => {
  const project = () => ({
    settings: { vlans: [
      { id: '10', subnet: '192.168.10.0/24', gateway: '192.168.10.1' },
      { id: '20', subnet: '192.168.20.0/24', gateway: '192.168.20.1' },
      { id: '99', subnet: '192.168.99.0/24', gateway: '192.168.99.1' },
    ] },
    floors: [{ id: 'f',
      SWS: [{ id: 'core', name: 'Core', role: 'l3', ip: '192.168.99.1' }, { id: 'acc', name: 'Acc', ip: '192.168.99.3', uplinkId: 'core' }],
      APS: [{ id: 'a1', name: 'A1', swId: 'core', port: 1, vlan: '10', ip: '192.168.10.5' }, { id: 'a2', name: 'A2', swId: 'acc', port: 1, vlan: '10', ip: '192.168.10.6' }],
      CAMS: [{ id: 'c1', name: 'C1', swId: 'acc', port: 2, vlan: '20', ip: '192.168.20.5' }] }],
  });
  it('a switch management IP is pingable, across VLANs, by IP and by name', () => {
    const c = compileTopology(project());
    expect(c.net.devices.has('m:acc')).toBe(true);
    expect(c.net.devices.has('m:core')).toBe(false); // its IP is the VLAN 99 gateway already
    expect(ping(c.net, { from: 'h:a1', to: '192.168.99.3' }).ok).toBe(true);
    expect(c.dns.acc).toBe('192.168.99.3');
  });
  it('no management NIC when another device already holds that IP', () => {
    const p = project(); p.floors[0].SWS[1].ip = '192.168.10.6';
    const c = compileTopology(p);
    expect(c.net.devices.has('m:acc')).toBe(false);
    expect(c.warnings).toEqual([]);
  });
  it('ping targets include endpoints, management and gateways', () => {
    const t = pingTargets(compileTopology(project()));
    expect(t.filter((x) => x.group === 'Endpoints').map((x) => x.ip)).toEqual(['192.168.10.5', '192.168.10.6', '192.168.20.5']);
    expect(t.find((x) => x.group === 'Switch management').ip).toBe('192.168.99.3');
    expect(t.filter((x) => x.group === 'Gateways').map((x) => x.ip).sort()).toEqual(['192.168.10.1', '192.168.20.1', '192.168.99.1']);
  });
  it('cutting an uplink or powering off a switch isolates what is behind it', () => {
    const cut = compileTopology(project());
    expect(ping(cut.net, { from: 'h:a1', to: '192.168.10.6' }).ok).toBe(true);
    expect(applyFaults(cut, { links: ['acc'] })).toBe(1);
    expect(ping(cut.net, { from: 'h:a1', to: '192.168.10.6' }).ok).toBe(false);
    const off = compileTopology(project());
    expect(applyFaults(off, { devices: ['acc', 'ghost'] })).toBe(1);
    expect(ping(off.net, { from: 'h:a1', to: '192.168.20.5' }).ok).toBe(false);
    expect(ping(off.net, { from: 'h:a1', to: '192.168.10.1' }).ok).toBe(true);
  });
  it('reachability matrix: routed VLANs allowed, an ACL shows as blocked', () => {
    const open = reachabilityMatrix(compileTopology(project()));
    expect(open.vlans).toEqual(['10', '20']);
    expect(open.cells.map((r) => r.map((c) => c.status))).toEqual([['allowed', 'allowed'], ['allowed', 'n/a']]);
    const p = project();
    p.floors[0].SWS[0].cli = cfg(['en', 'conf t', 'access-list 100 deny ip 192.168.20.0 0.0.0.255 192.168.10.0 0.0.0.255', 'access-list 100 permit ip any any', 'interface vlan 20', 'ip access-group 100 in']);
    const m = reachabilityMatrix(compileTopology(p));
    expect(m.cells[1][0].status).toBe('blocked');   // 20 → 10 dropped on entry
  });
  it('without an L3 device, VLANs are unreachable from each other', () => {
    const p = project(); p.floors[0].SWS[0].role = 'switch';
    expect(reachabilityMatrix(compileTopology(p)).cells[0][1].status).toBe('unreachable');
  });
});
