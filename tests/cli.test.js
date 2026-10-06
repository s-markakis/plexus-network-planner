import { describe, it, expect } from 'vitest';
import { newConfig, makeSession, configToDevice } from '../files/src/cli.js';
import { buildNet, ping } from '../files/src/sim.js';

function cisco() { return makeSession(newConfig({ vendor: 'cisco', hostname: 'R1' })); }
function ros() { return makeSession(newConfig({ vendor: 'mikrotik', hostname: 'MT1' })); }
const run = (s, lines) => lines.map((l) => s.exec(l));

describe('Cisco IOS: config mode + interface addressing', () => {
  it('walks the mode state machine and sets an interface IP', () => {
    const s = cisco();
    expect(s.prompt()).toBe('R1>');
    s.exec('enable');
    expect(s.prompt()).toBe('R1#');
    s.exec('configure terminal');
    expect(s.prompt()).toBe('R1(config)#');
    s.exec('interface Gig0/0');
    expect(s.prompt()).toBe('R1(config-if)#');
    s.exec('ip address 10.0.0.1 255.255.255.0');
    const i = s.config.interfaces['Gig0/0'];
    expect(i).toMatchObject({ ip: '10.0.0.1', prefix: 24, mode: 'routed' });
  });

  it('honours abbreviations (conf t / int / no shut)', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'int Gi0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shut']);
    expect(s.config.interfaces['Gi0/1']).toMatchObject({ ip: '10.0.1.1', prefix: 24, shutdown: false });
  });

  it('configures access and trunk switchports', () => {
    const s = cisco();
    run(s, ['en', 'conf t',
      'interface Gi0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Gi0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20,30', 'exit']);
    expect(s.config.interfaces['Gi0/1']).toMatchObject({ mode: 'access', vlan: 10 });
    expect(s.config.interfaces['Gi0/2']).toMatchObject({ mode: 'trunk', allowed: [10, 20, 30] });
  });

  it('expands a VLAN range on a trunk', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface Gi0/2', 'switchport trunk allowed vlan 10-12']);
    expect(s.config.interfaces['Gi0/2'].allowed).toEqual([10, 11, 12]);
  });

  it('creates an SVI via "interface vlan N"', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0']);
    expect(s.config.interfaces['Vlan10']).toMatchObject({ ip: '10.0.10.1', prefix: 24, vlan: 10 });
  });

  it('adds and removes static routes', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'ip route 10.0.2.0 255.255.255.0 10.0.1.2']);
    expect(s.config.routes).toEqual([{ cidr: '10.0.2.0/24', via: '10.0.1.2' }]);
    s.exec('no ip route 10.0.2.0 255.255.255.0 10.0.1.2');
    expect(s.config.routes).toEqual([]);
  });

  it('normalises a host-bit network to its base in the route', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'ip route 10.0.2.55 255.255.255.0 10.0.1.2']);
    expect(s.config.routes[0].cidr).toBe('10.0.2.0/24');
  });
});

describe('Cisco IOS: error handling + show', () => {
  it('rejects conf-t before enable', () => {
    const s = cisco();
    expect(s.exec('configure terminal').error).toBe(true);
  });
  it('flags an invalid command', () => {
    const s = cisco();
    run(s, ['en', 'conf t']);
    expect(s.exec('frobnicate the widget').error).toBe(true);
    expect(s.exec('frobnicate the widget').output[0]).toMatch(/Invalid input/);
  });
  it('rejects a malformed IP address', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface Gi0/1']);
    expect(s.exec('ip address 999.1.1.1 255.255.255.0').error).toBe(true);
    expect(s.exec('ip address 10.0.0.1 255.255.0.255').error).toBe(true); // non-contiguous mask
  });
  it('show running-config round-trips the key lines', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 10.0.0.254', 'end']);
    const out = s.exec('show running-config').output.join('\n');
    expect(out).toMatch(/interface Gi0\/0/);
    expect(out).toMatch(/ip address 10\.0\.0\.1 255\.255\.255\.0/);
    expect(out).toMatch(/ip route 0\.0\.0\.0 0\.0\.0\.0 10\.0\.0\.254/);
  });
  it('show ip route lists connected + static', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'ip route 10.9.0.0 255.255.255.0 10.0.0.2', 'end']);
    const out = s.exec('show ip route').output.join('\n');
    expect(out).toMatch(/C {4}10\.0\.0\.0\/24 is directly connected, Gi0\/0/);
    expect(out).toMatch(/S {4}10\.9\.0\.0\/24 \[1\/0\] via 10\.0\.0\.2/);
  });
  it('ping returns a sentinel for the UI to execute', () => {
    const s = cisco();
    s.exec('enable');
    expect(s.exec('ping 10.0.0.9')).toMatchObject({ ping: '10.0.0.9' });
  });
});

describe('MikroTik RouterOS', () => {
  it('sets identity and an interface address', () => {
    const s = ros();
    s.exec('/system identity set name=edge1');
    s.exec('/ip address add address=10.0.0.1/24 interface=ether1');
    expect(s.config.hostname).toBe('edge1');
    expect(s.config.interfaces.ether1).toMatchObject({ ip: '10.0.0.1', prefix: 24, mode: 'routed' });
  });
  it('adds a static route', () => {
    const s = ros();
    s.exec('/ip route add dst-address=10.0.2.0/24 gateway=10.0.1.2');
    expect(s.config.routes).toEqual([{ cidr: '10.0.2.0/24', via: '10.0.1.2' }]);
  });
  it('maps a bridge port pvid to an access VLAN', () => {
    const s = ros();
    s.exec('/interface bridge port add bridge=br1 interface=ether2 pvid=10');
    expect(s.config.interfaces.ether2).toMatchObject({ mode: 'access', vlan: 10 });
  });
  it('maps a bridge-vlan tagged list to trunk ports', () => {
    const s = ros();
    s.exec('/interface bridge vlan add bridge=br1 tagged=ether3,ether4 vlan-ids=10,20');
    expect(s.config.interfaces.ether3).toMatchObject({ mode: 'trunk', allowed: [10, 20] });
    expect(s.config.interfaces.ether4.allowed).toEqual([10, 20]);
    expect(s.config.vlans.sort()).toEqual([10, 20]);
  });
  it('creates a tagged VLAN subinterface', () => {
    const s = ros();
    s.exec('/interface vlan add name=vlan10 vlan-id=10 interface=ether1');
    expect(s.config.interfaces.vlan10).toMatchObject({ mode: 'routed', vlan: 10 });
  });
  it('rejects a malformed address and an unknown command', () => {
    const s = ros();
    expect(s.exec('/ip address add address=garbage interface=ether1').error).toBe(true);
    expect(s.exec('/make me a sandwich').error).toBe(true);
  });
  it('ping returns a sentinel', () => {
    expect(ros().exec('/ping 10.0.0.9')).toMatchObject({ ping: '10.0.0.9' });
  });

  it('/ip address print lists addresses (not routes) — matches real RouterOS columns', () => {
    const s = ros();
    s.exec('/ip address add address=10.10.10.1/24 interface=ether1');
    s.exec('/ip route add dst-address=0.0.0.0/0 gateway=10.10.10.254');
    const out = s.exec('/ip address print').output.join('\n');
    expect(out).toMatch(/ADDRESS, NETWORK, INTERFACE/);
    expect(out).toMatch(/10\.10\.10\.1\/24 {2}10\.10\.10\.0 {2}ether1/);
    expect(out).not.toMatch(/0\.0\.0\.0\/0/); // the route must NOT appear here
  });
});

describe('config → sim device, end to end', () => {
  it('two routers configured purely by CLI route between each other', () => {
    // Build R1 (Cisco) and R2 (MikroTik) consoles, then simulate between hosts.
    const r1 = cisco();
    run(r1, ['en', 'conf t',
      'interface e0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'interface e1', 'ip address 10.0.1.1 255.255.255.252', 'no shutdown', 'exit',
      'ip route 10.0.2.0 255.255.255.0 10.0.1.2', 'end']);
    const r2 = ros();
    run(r2, [
      '/ip address add address=10.0.1.2/30 interface=e0',
      '/ip address add address=10.0.2.1/24 interface=e1',
      '/ip route add dst-address=10.0.0.0/24 gateway=10.0.1.1',
    ]);
    const net = buildNet({
      devices: [
        { id: 'h1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'h2', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.2.10', prefix: 24 }], gateway: '10.0.2.1' },
        configToDevice(r1.config, { id: 'r1' }),
        configToDevice(r2.config, { id: 'r2' }),
      ],
      links: [['h1/e', 'r1/e0'], ['r1/e1', 'r2/e0'], ['r2/e1', 'h2/e']],
    });
    expect(ping(net, { from: 'h1', to: '10.0.2.10' }).ok).toBe(true);
  });

  it('configToDevice carries shutdown as an interface down state', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface e0', 'ip address 10.0.0.1 255.255.255.0', 'shutdown', 'end']);
    const dev = configToDevice(s.config, { id: 'r' });
    expect(dev.ifaces[0].up).toBe(false);
  });
});

describe('OSPF enablement', () => {
  it('IOS: router ospf enables OSPF, enters config-router, records networks', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']);
    expect(s.config.ospf).toMatchObject({ enabled: true });
    expect(s.config.ospf.networks).toContain('10.0.0.0 0.0.0.255 area 0');
    expect(s.prompt()).toBe('R1(config-router)#');
    s.exec('exit');
    expect(s.prompt()).toBe('R1(config)#');
  });
  it('RouterOS: /routing ospf instance + network enable OSPF', () => {
    const s = ros();
    s.exec('/routing ospf instance add name=default router-id=1.1.1.1');
    s.exec('/routing ospf network add network=10.0.0.0/24 area=backbone');
    expect(s.config.ospf.enabled).toBe(true);
    expect(s.config.ospf.networks).toContain('10.0.0.0/24');
  });
});

describe('ACL / firewall commands', () => {
  it('IOS access-list builds engine rules (host + eq port)', () => {
    const s = cisco();
    run(s, ['en', 'conf t',
      'access-list 101 deny tcp any host 10.0.1.10 eq 22',
      'access-list 101 permit ip any any']);
    expect(s.config.acls).toEqual([
      { action: 'deny', proto: 'tcp', src: 'any', dst: '10.0.1.10/32', dport: 22 },
      { action: 'permit', proto: 'ip', src: 'any', dst: 'any', dport: null },
    ]);
  });
  it('IOS wildcard mask converts to a prefix', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'access-list 10 deny icmp 10.0.0.0 0.0.0.255 10.0.1.0 0.0.0.255']);
    expect(s.config.acls[0]).toMatchObject({ src: '10.0.0.0/24', dst: '10.0.1.0/24', proto: 'icmp' });
  });
  it('RouterOS firewall filter builds engine rules', () => {
    const s = ros();
    s.exec('/ip firewall filter add chain=forward action=drop protocol=tcp dst-address=10.0.1.0/24 dst-port=22');
    expect(s.config.acls[0]).toEqual({ action: 'deny', proto: 'tcp', src: 'any', dst: '10.0.1.0/24', dport: 22 });
  });
  it('configToDevice carries ACLs into the sim device', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'access-list 1 deny ip any any']);
    expect(configToDevice(s.config, { id: 'r' }).acls).toHaveLength(1);
  });
});

describe('startup-config vs running-config', () => {
  it('copy run start saves, reload reverts unsaved changes', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'end']);
    s.exec('copy run start');
    // make an unsaved change
    run(s, ['conf t', 'interface Gi0/1', 'ip address 10.0.1.1 255.255.255.0', 'end']);
    expect(s.config.interfaces['Gi0/1']).toBeTruthy();
    s.exec('reload');
    // reverted: Gi0/1 gone, Gi0/0 (saved) kept
    expect(s.config.interfaces['Gi0/1']).toBeUndefined();
    expect(s.config.interfaces['Gi0/0']).toMatchObject({ ip: '10.0.0.1' });
  });
  it('show startup-config reports none until saved', () => {
    const s = cisco();
    expect(s.exec('show startup-config').output.join('\n')).toMatch(/No startup-config/);
    run(s, ['en', 'conf t', 'hostname R9', 'end']);
    s.exec('wr');
    expect(s.exec('show startup-config').output.join('\n')).toMatch(/hostname R9/);
  });
});

describe('RIP enablement', () => {
  it('IOS router rip enables RIP and keeps networks separate from OSPF', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit', 'router rip', 'network 10.0.1.0']);
    expect(s.config.ospf.enabled).toBe(true);
    expect(s.config.rip.enabled).toBe(true);
    expect(s.config.ospf.networks).toContain('10.0.0.0 0.0.0.255 area 0');
    expect(s.config.rip.networks).toContain('10.0.1.0');
  });
  it('RouterOS /routing rip enables RIP', () => {
    const s = ros();
    s.exec('/routing rip instance add name=default');
    expect(s.config.rip.enabled).toBe(true);
  });
});

describe('NAT via CLI', () => {
  it('IOS ip nat inside/outside + overload builds nat and works end to end', () => {
    const s = cisco();
    run(s, ['en', 'conf t',
      'interface lan', 'ip address 10.0.0.1 255.255.255.0', 'ip nat inside', 'exit',
      'interface wan', 'ip address 203.0.113.2 255.255.255.252', 'ip nat outside', 'exit',
      'ip nat inside source list 1 interface wan overload',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    const edge = configToDevice(s.config, { id: 'edge' });
    expect(edge.nat).toMatchObject({ outside: 'wan' });
    expect(edge.nat.inside).toContain('10.0.0.1/24');
    const net = buildNet({
      devices: [
        { id: 'pc', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
        edge,
        { id: 'net', kind: 'cloud', ifaces: [{ name: 'w', ip: '203.0.113.1', prefix: 30 }], routes: [{ cidr: '10.0.0.0/24', via: '203.0.113.2' }] },
      ],
      links: [['pc/e', 'edge/lan'], ['edge/wan', 'net/w']],
    });
    const r = ping(net, { from: 'pc', to: '8.8.8.8' });
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === 'nat-out' && e.to === '203.0.113.2')).toBe(true);
  });
  it('RouterOS masquerade sets the outside interface', () => {
    const s = ros();
    s.exec('/ip address add address=10.0.0.1/24 interface=lan');
    s.exec('/ip address add address=203.0.113.2/30 interface=wan');
    s.exec('/ip firewall nat add chain=srcnat action=masquerade out-interface=wan');
    const dev = configToDevice(s.config, { id: 'r' });
    expect(dev.nat).toMatchObject({ outside: 'wan' });
    expect(dev.nat.inside).toContain('10.0.0.1/24');
  });
});

describe('dot1q subinterfaces (router-on-a-stick)', () => {
  it('a subinterface with encapsulation dot1q becomes a routed VLAN gateway', () => {
    const s = cisco();
    run(s, ['en', 'conf t', 'interface Gi0/0.10', 'encapsulation dot1q 10', 'ip address 10.0.10.1 255.255.255.0']);
    expect(s.config.interfaces['Gi0/0.10']).toMatchObject({ vlan: 10, ip: '10.0.10.1', mode: 'routed' });
  });
});
