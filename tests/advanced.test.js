// @ts-nocheck — fixtures here are deliberately loose plan objects.
// Stateful firewall + runtime state, CLI help/completion/shows, spanning tree,
// DHCP server/relay, policies-as-tests, blast radius and graded labs.
import { describe, it, expect } from 'vitest';
import { buildNet, ping, probe, runtimeState, resetRuntime } from '../files/src/sim.js';
import { compileTopology, applyFaults } from '../files/src/simCompile.js';
import { newConfig, makeSession, complete } from '../files/src/cli.js';
import { runStp } from '../files/src/stp.js';
import { evaluatePolicies, policyLabel } from '../files/src/policy.js';
import { blastRadius } from '../files/src/blast.js';
import { LABS, gradeLab } from '../files/src/labs.js';
import { parseRouterOsExport } from '../files/src/drift.js';

const sess = (vendor = 'cisco', lines = []) => {
  const s = makeSession(newConfig({ vendor, hostname: 'R1' }), vendor);
  for (const l of lines) { const r = s.exec(l); if (r.error) throw new Error(`${l} → ${r.output}`); }
  return s;
};
const cfg = (lines, vendor) => sess(vendor, lines).config;

describe('stateful firewall', () => {
  const spec = (acls) => ({
    devices: [
      { id: 'staff', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.1.2', prefix: 24 }], gateway: '10.0.1.1', services: [{ proto: 'tcp', port: 22 }] },
      { id: 'guest', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.2.2', prefix: 24 }], gateway: '10.0.2.1', services: [{ proto: 'tcp', port: 80 }] },
      { id: 'r', kind: 'router', acls, ifaces: [{ name: 'a', ip: '10.0.1.1', prefix: 24 }, { name: 'b', ip: '10.0.2.1', prefix: 24 }] },
    ],
    links: [['staff/e', 'r/a'], ['guest/e', 'r/b']],
  });
  const denyGuest = { action: 'deny', proto: 'ip', src: '10.0.2.0/24', dst: '10.0.1.0/24' };
  it('a stateless deny also kills the replies to the allowed direction', () => {
    expect(ping(buildNet(spec([denyGuest])), { from: 'staff', to: '10.0.2.2' }).status).toBe('filtered');
  });
  it('permitting established traffic makes the policy one-directional', () => {
    const net = () => buildNet(spec([{ action: 'permit', proto: 'ip', src: 'any', dst: 'any', state: ['established'] }, denyGuest]));
    expect(ping(net(), { from: 'staff', to: '10.0.2.2' }).ok).toBe(true);
    expect(probe(net(), { from: 'staff', to: '10.0.2.2', port: 80 }).ok).toBe(true);
    expect(ping(net(), { from: 'guest', to: '10.0.1.2' }).status).toBe('filtered');
    expect(probe(net(), { from: 'guest', to: '10.0.1.2', port: 22 }).status).toBe('filtered');
  });
  it('an established rule alone never lets a new connection in', () => {
    const net = buildNet(spec([{ action: 'permit', proto: 'ip', src: 'any', dst: 'any', state: ['established'] }, { action: 'deny', proto: 'ip', src: 'any', dst: 'any' }]));
    expect(ping(net, { from: 'staff', to: '10.0.2.2' }).status).toBe('filtered');
  });
  it('CLI: IOS `established` and RouterOS connection-state produce state rules', () => {
    expect(cfg(['en', 'conf t', 'access-list 101 permit tcp any any established']).acls[0].state).toEqual(['established']);
    expect(cfg(['en', 'conf t', 'access-list 101 deny tcp any any eq 22']).acls[0].state).toBeUndefined();
    expect(cfg(['/ip firewall filter add chain=forward action=accept connection-state=established,related'], 'mikrotik').acls[0].state).toEqual(['established']);
    expect(cfg(['/ip firewall filter add chain=forward action=drop connection-state=invalid'], 'mikrotik').acls[0].state).toEqual(['invalid']);
  });
  it('keeps learned state between tests and exposes it', () => {
    const net = buildNet(spec([]));
    ping(net, { from: 'staff', to: '10.0.2.2' });
    const r = runtimeState(net, 'r');
    expect(r.arp.map((a) => a.ip).sort()).toEqual(['10.0.1.2', '10.0.2.2']);
    expect(r.conns).toEqual([{ proto: 'icmp', src: '10.0.1.2', dst: '10.0.2.2', dport: null }]);
    resetRuntime(net);
    expect(runtimeState(net, 'r')).toMatchObject({ arp: [], conns: [] });
    expect(runtimeState(net, 'nope')).toBeNull();
  });
  it('events carry the packet for the PDU inspector', () => {
    const r = ping(buildNet(spec([])), { from: 'staff', to: '10.0.2.2' });
    const route = r.events.find((e) => e.kind === 'l3-route' && e.dev === 'r');
    expect(route.pdu).toMatchObject({ src: '10.0.1.2', dst: '10.0.2.2', proto: 'icmp', type: 'echo-request' });
    expect(route.pdu.ttl).toBeLessThanOrEqual(64);
  });
});

describe('CLI: help, completion, do, shows', () => {
  it('? lists what fits the current mode', () => {
    const s = sess('cisco', ['en']);
    expect(s.exec('show ip ?').output.map((x) => x.trim())).toContain('show ip route');
    expect(s.exec('?').output.length).toBeGreaterThan(10);
    s.exec('conf t');
    expect(s.exec('?').output.map((x) => x.trim())).toContain('router ospf');
    expect(s.exec('zzz?').output).toEqual(['% Unrecognized command']);
    expect(sess('mikrotik').exec('/ip fire?').output.map((x) => x.trim())).toContain('/ip firewall filter add');
  });
  it('Tab completes a unique prefix and extends an ambiguous one', () => {
    const s = sess('cisco', ['en']);
    expect(complete(s, 'conf')).toEqual({ text: 'configure terminal ', options: [] });
    const amb = complete(s, 'show ip n');
    expect(amb.text).toBe('show ip nat translations ');
    expect(complete(s, 'show ip').options.length).toBeGreaterThan(3);
    expect(complete(s, 'nonsense')).toEqual({ text: 'nonsense', options: [] });
    expect(complete(sess('mikrotik'), '/sys').text).toBe('/system identity set ');
  });
  it('do runs exec commands from config modes; global commands leave sub-modes', () => {
    const s = sess('cisco', ['en', 'conf t', 'interface g0/1', 'ip address 10.0.0.1 255.255.255.0']);
    expect(s.exec('do show ip interface brief').output.join('\n')).toContain('10.0.0.1');
    expect(s.ctx.mode).toBe('config-if');
  });
  it('show interfaces / access-lists / protocols / running-config reflect the config', () => {
    const s = sess('cisco', ['en', 'conf t', 'interface g0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'ip access-group 110 in', 'ip helper-address 10.0.99.5',
      'access-list 110 permit tcp any host 10.0.1.5 eq 443', 'router ospf 1', 'network 10.0.10.0 0.0.0.255 area 0',
      'ip dhcp pool STAFF', 'network 10.0.10.0 255.255.255.0', 'default-router 10.0.10.1', 'end']);
    expect(s.exec('show interfaces').output.join('\n')).toMatch(/g0\/1\s+up\s+trunk\s+10,20/);
    expect(s.exec('show access-lists').output[0]).toContain('access-list 110 permit tcp any host 10.0.1.5 eq 443');
    expect(s.exec('show ip protocols').output.join('\n')).toContain('10.0.10.0 0.0.0.255 area 0');
    const run = s.exec('show run').output.join('\n');
    for (const want of ['ip access-group 110 in', 'router ospf 1', ' network 10.0.10.0 0.0.0.255 area 0', 'ip dhcp pool STAFF', ' default-router 10.0.10.1', 'access-list 110 permit tcp any host 10.0.1.5 eq 443']) expect(run).toContain(want);
    expect(s.config.interfaces.Vlan10.helper).toBe('10.0.99.5');
    expect(s.exec('show arp')).toMatchObject({ show: 'arp' });
    expect(s.exec('sh mac address-table')).toMatchObject({ show: 'mac' });
  });
  it('RouterOS /export round-trips through the drift parser', () => {
    const s = sess('mikrotik', ['/interface bridge port add interface=ether2 pvid=10', '/interface bridge vlan add vlan-ids=10,20 tagged=ether1',
      '/interface vlan add name=vlan10 vlan-id=10 interface=bridge', '/ip address add address=10.0.10.1/24 interface=vlan10',
      '/ip route add dst-address=0.0.0.0/0 gateway=10.0.10.254', '/ip dhcp-server network add address=10.0.10.0/24 gateway=10.0.10.1',
      '/ip dhcp-relay add interface=vlan10 dhcp-server=10.0.99.5', '/system identity set name=core']);
    const parsed = parseRouterOsExport(s.exec('/export').output.join('\n'));
    expect(parsed.identity).toBe('core');
    expect(parsed.ports.find((p) => p.iface === 'ether2').pvid).toBe(10);
    expect(parsed.addresses).toEqual([{ address: '10.0.10.1/24', iface: 'vlan10' }]);
    expect(parsed.routes).toEqual([{ dst: '0.0.0.0/0', gateway: '10.0.10.254' }]);
    expect(s.config.dhcpPools[0]).toMatchObject({ cidr: '10.0.10.0/24', router: '10.0.10.1' });
    expect(s.exec('/ip arp print')).toMatchObject({ show: 'arp' });
  });
});

describe('spanning tree + redundant uplinks', () => {
  const project = (extra = {}) => ({
    settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
    floors: [{ id: 'f', CAMS: [],
      SWS: [{ id: 'c1', name: 'Core-1' }, { id: 'c2', name: 'Core-2', uplinkId: 'c1' }, { id: 'ac', name: 'Access', uplinkId: 'c1', uplink2Id: 'c2', ...extra }],
      APS: [{ id: 'srv', name: 'Server', swId: 'c2', port: 1, vlan: '10', ip: '10.0.10.2' }, { id: 'pc', name: 'PC', swId: 'ac', port: 1, vlan: '10', ip: '10.0.10.10' }] }],
  });
  it('blocks exactly one link of a triangle and still forwards', () => {
    const c = compileTopology(project());
    expect(c.stp.roots).toEqual(['sw:ac']);              // lowest bridge id
    expect(c.stp.blocked).toHaveLength(1);
    const r = ping(c.net, { from: 'h:pc', to: '10.0.10.2' });
    expect(r.ok).toBe(true);
  });
  it('priority moves the root bridge', () => {
    const p = project(); p.floors[0].SWS[0].stpPriority = 4096;
    expect(compileTopology(p).stp.roots).toEqual(['sw:c1']);
  });
  it('fails over when a link is cut, in either direction', () => {
    for (const cut of ['ac', 'ac#2', 'c2']) {
      const c = compileTopology(project());
      expect(applyFaults(c, { links: [cut] })).toBe(1);
      expect(c.stp.blocked).toHaveLength(0);             // the backup link is in use now
      expect(ping(c.net, { from: 'h:pc', to: '10.0.10.2' }).ok, `cut ${cut}`).toBe(true);
    }
  });
  it('no loop, nothing blocked; runStp is idempotent', () => {
    const p = project({ uplink2Id: '' });
    const c = compileTopology(p);
    expect(c.stp.blocked).toEqual([]);
    expect(runStp(c.net)).toEqual(runStp(c.net));
  });
});

describe('DHCP server and relay', () => {
  const base = (coreCli, accCli) => ({
    settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }, { id: '99', subnet: '10.0.99.0/24', gateway: '10.0.99.1' }] },
    floors: [{ id: 'f', CAMS: [],
      SWS: [{ id: 'core', name: 'Core', role: 'l3', ...(coreCli ? { cli: coreCli } : {}) }, { id: 'srv', name: 'Server-SW', uplinkId: 'core', ip: '10.0.99.5', ...(accCli ? { cli: accCli } : {}) }],
      APS: [{ id: 'pc', name: 'PC', swId: 'core', port: 1, vlan: '10', ip: 'dhcp' }] }],
  });
  const lease = (p) => { const c = compileTopology(p); return { ip: c.meta.get('h:pc')?.ip, warnings: c.warnings }; };
  it('permissive when the plan configures no DHCP at all (legacy behaviour)', () => {
    expect(lease(base()).ip).toBe('10.0.10.2');
  });
  it('a pool on the gateway device serves its VLAN', () => {
    expect(lease(base(cfg(['en', 'conf t', 'ip dhcp pool STAFF', 'network 10.0.10.0 255.255.255.0', 'default-router 10.0.10.1']))).ip).toBe('10.0.10.2');
  });
  it('a pool for another subnet does not; the client is left without a lease', () => {
    const r = lease(base(cfg(['en', 'conf t', 'ip dhcp pool OTHER', 'network 10.0.50.0 255.255.255.0'])));
    expect(r.ip).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/PC: no DHCP lease in VLAN 10 — no DHCP pool covers its subnet/);
  });
  const remotePool = cfg(['en', 'conf t', 'ip dhcp pool STAFF', 'network 10.0.10.0 255.255.255.0']);
  it('a remote pool needs a relay on the VLAN gateway', () => {
    expect(lease(base(null, remotePool)).warnings.join('\n')).toMatch(/has no relay/);
    expect(lease(base(cfg(['en', 'conf t', 'interface vlan 10', 'ip helper-address 10.0.99.5']), remotePool)).ip).toBe('10.0.10.2');
    expect(lease(base(cfg(['en', 'conf t', 'interface vlan 10', 'ip helper-address 10.0.99.77']), remotePool)).warnings.join('\n')).toMatch(/not a DHCP server in the plan/);
  });
});

describe('policies as tests', () => {
  const guestAcl = (srcWild) => cfg(['en', 'conf t', 'access-list 130 permit ip any any established', `access-list 130 deny ip 10.0.30.0 ${srcWild} 10.0.10.0 0.0.0.255`, 'access-list 130 permit ip any any', 'interface vlan 30', 'ip access-group 130 in']);
  const project = (cli) => ({
    settings: { vlans: [{ id: '10', name: 'Staff', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }, { id: '30', name: 'Guest', subnet: '10.0.30.0/24', gateway: '10.0.30.1' }] },
    floors: [{ id: 'f', CAMS: [], SWS: [{ id: 'core', name: 'Core', role: 'l3', ip: '10.0.10.1', ...(cli ? { cli } : {}) }],
      APS: [{ id: 's1', name: 'Staff-PC', swId: 'core', port: 1, vlan: '10', ip: '10.0.10.10' }, { id: 'g1', name: 'Guest-1', swId: 'core', port: 2, vlan: '30', ip: '10.0.30.5' }] }],
  });
  const guestOut = { id: 'p1', from: { kind: 'vlan', vlan: '30' }, to: { kind: 'vlan', vlan: '10' }, expect: 'deny' };
  const staffIn = { id: 'p2', from: { kind: 'vlan', vlan: '10' }, to: { kind: 'vlan', vlan: '30' }, expect: 'allow' };
  it('passes when the firewall really enforces the intent, both ways', () => {
    const { results } = evaluatePolicies(project(guestAcl('0.0.0.255')), [guestOut, staffIn]);
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass']);
  });
  it('fails an open network and names the offending pair', () => {
    const r = evaluatePolicies(project(), [guestOut]).results[0];
    expect(r.status).toBe('fail');
    expect(r.violations[0]).toMatchObject({ from: 'Guest-1', fromIp: '10.0.30.5', to: 'Staff-PC', status: 'delivered' });
  });
  it('catches a rule that covers only part of the subnet — the planned host alone would pass', () => {
    // The deny only matches 10.0.30.0/28. Guest-1 (.5) is inside it, so a
    // one-host-per-VLAN check sees "blocked"; any guest above .15 walks through.
    const { results, probes } = evaluatePolicies(project(guestAcl('0.0.0.15')), [guestOut]);
    expect(probes).toBeGreaterThan(0);
    expect(results[0].status).toBe('fail');
    expect(results[0].violations.every((v) => v.synthetic && v.fromIp !== '10.0.30.5')).toBe(true);
    expect(results[0].violations[0].fromIp).toBe('10.0.30.16');
  });
  it('service policies, management and device selectors', () => {
    const p = project();
    const ssh = { id: 'm', from: { kind: 'vlan', vlan: '30' }, to: { kind: 'mgmt' }, proto: 'tcp', port: 22, expect: 'deny' };
    expect(evaluatePolicies(p, [ssh]).results[0].status).toBe('fail');
    expect(evaluatePolicies(p, [{ id: 'd', from: { kind: 'device', id: 'g1' }, to: { kind: 'device', id: 's1' }, expect: 'allow' }]).results[0].status).toBe('pass');
    const skipped = evaluatePolicies(p, [{ id: 'x', from: { kind: 'vlan', vlan: '77' }, to: { kind: 'internet' }, expect: 'deny' }]).results[0];
    expect(skipped.status).toBe('skipped');
    expect(policyLabel(ssh)).toBe('VLAN 30 must NOT reach network management on tcp/22');
    expect(evaluatePolicies(p, [null, { nope: 1 }])).toEqual({ results: [], probes: 0 });
  });
});

describe('blast radius', () => {
  const project = (cli) => ({
    settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }, { id: '20', subnet: '10.0.20.0/24', gateway: '10.0.20.1' }, { id: '99', subnet: '10.0.99.0/24', gateway: '10.0.99.1' }] },
    floors: [{ id: 'f', SWS: [{ id: 'core', name: 'Core', role: 'l3', model: 'MikroTik CRS', ...(cli ? { cli } : {}) }, { id: 'acc', name: 'Acc', uplinkId: 'core', ip: '10.0.99.3' }],
      APS: [{ id: 'pc', name: 'PC', swId: 'core', port: 1, vlan: '10', ip: '10.0.10.10' }],
      CAMS: [{ id: 'cam1', name: 'Cam-1', swId: 'acc', port: 1, vlan: '20', ip: '10.0.20.10' }, { id: 'cam2', name: 'Cam-2', swId: 'acc', port: 2, vlan: '20', ip: '10.0.20.11', services: [{ proto: 'tcp', port: 554 }] }] }],
  });
  it('an unfiltered camera reaches management, other VLANs and its neighbours', () => {
    const b = blastRadius(compileTopology(project()), 'h:cam1');
    expect(b.source).toMatchObject({ name: 'Cam-1', ip: '10.0.20.10' });
    expect(b.findings.map((f) => f.severity)).toEqual(['high', 'medium', 'info']);
    expect(b.findings[0].text).toMatch(/Acc \(management\) 10\.0\.99\.3 \(tcp\/22, tcp\/443\)/);
    expect(b.targets.find((t) => t.name === 'Cam-2')).toMatchObject({ group: 'same-vlan', reachable: true, open: [{ proto: 'tcp', port: 554 }] });
  });
  it('after isolating the camera VLAN only its own segment is left', () => {
    const cli = cfg(['en', 'conf t', 'access-list 120 permit ip any any established', 'access-list 120 deny ip any any', 'interface vlan 20', 'ip access-group 120 in']);
    const b = blastRadius(compileTopology(project(cli)), 'h:cam1');
    expect(b.findings.map((f) => f.severity)).toEqual(['info']);
    expect(b.targets.filter((t) => t.reachable).map((t) => t.name)).toEqual(['Cam-2']);
    // …while staff can still pull video from the cameras.
    expect(probe(compileTopology(project(cli)).net, { from: 'h:pc', to: '10.0.20.11', port: 554 }).ok).toBe(true);
  });
  it('unknown source → null', () => {
    expect(blastRadius(compileTopology(project()), 'h:nope')).toBeNull();
  });
});

describe('graded labs', () => {
  const solve = {
    'inter-vlan': (p) => { p.settings.vlans[0].gateway = '10.0.10.1'; p.settings.vlans[1].gateway = '10.0.20.1'; p.floors[0].SWS[0].role = 'l3'; },
    'guest-isolation': (p) => {
      p.floors[0].SWS[0].cli = cfg(['en', 'conf t', 'access-list 130 permit ip any any established', 'access-list 130 deny tcp any any eq 22',
        'access-list 130 deny ip any 10.0.10.0 0.0.0.255', 'access-list 130 deny ip any 10.0.99.0 0.0.0.255', 'access-list 130 permit ip any any', 'interface vlan 30', 'ip access-group 130 in']);
    },
    'ospf-two-sites': (p) => {
      p.floors[0].SWS.forEach((s, k) => {
        const se = makeSession(s.cli, 'cisco');
        for (const l of ['en', 'conf t', 'router ospf 1', 'network 10.255.0.0 0.0.0.3 area 0', `network 10.${k + 1}.0.0 0.0.0.255 area 0`]) expect(se.exec(l).error).toBeUndefined();
      });
    },
    'redundant-uplink': (p) => { p.floors[0].SWS[2].uplink2Id = 'lab-c2'; },
  };
  it('every lab has a solution here', () => {
    expect(LABS.map((l) => l.id).sort()).toEqual(Object.keys(solve).sort());
  });
  for (const lab of LABS) {
    it(`${lab.id}: the starting plan fails, a correct solution scores full marks`, () => {
      const start = gradeLab(lab.build(), lab.id);
      expect(start.passed).toBe(false);
      expect(start.total).toBe(lab.checks.length);
      const p = lab.build();
      solve[lab.id](p);
      const done = gradeLab(p, lab.id);
      expect(done.results.filter((r) => !r.ok)).toEqual([]);
      expect(done).toMatchObject({ passed: true, score: lab.checks.length });
    });
  }
  it('a wrong but plausible answer is caught: static routes in the OSPF lab', () => {
    const p = LABS.find((l) => l.id === 'ospf-two-sites').build();
    p.floors[0].SWS[0].cli.routes.push({ cidr: '10.2.0.0/24', via: '10.255.0.2' });
    p.floors[0].SWS[1].cli.routes.push({ cidr: '10.1.0.0/24', via: '10.255.0.1' });
    const g = gradeLab(p, 'ospf-two-sites');
    expect(g.results.slice(0, 2).every((r) => r.ok)).toBe(true);   // it does work…
    expect(g.passed).toBe(false);                                   // …but not the way asked
    expect(gradeLab(p, 'nope')).toBeNull();
  });
});
