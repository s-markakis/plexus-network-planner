import { describe, it, expect } from 'vitest';
import { compileTopology, pingableDevices } from '../files/src/simCompile.js';
import { ping, probe } from '../files/src/sim.js';
import { buildSampleProject } from '../files/src/sampleProject.js';
import { newConfig, makeSession } from '../files/src/cli.js';

// Build a running-config by feeding CLI lines (Phase 3b).
function cliConfig(lines, vendor = 'cisco', hostname = 'CORE') {
  const s = makeSession(newConfig({ vendor, hostname }));
  for (const l of lines) s.exec(l);
  return s.config;
}

describe('compileTopology on the bundled sample project', () => {
  it('maps every switch and IP-bearing endpoint to a sim device', () => {
    const c = compileTopology(buildSampleProject());
    // sample = 1 switch (sw17) + 3 APs + 2 cameras, all addressed.
    expect(c.net.devices.has('sw:sw17')).toBe(true);
    expect([...c.net.devices.keys()].filter((k) => k.startsWith('h:'))).toHaveLength(5);
    expect(c.warnings).toEqual([]);
  });

  it('puts endpoints in the right subnet from their VLAN', () => {
    const c = compileTopology(buildSampleProject());
    const ap = c.net.devices.get('h:ap14').ifaces.get('eth0');
    expect(ap.prefix).toBe(24); // 10.0.10.0/24
  });

  it('delivers a ping between two APs in the same VLAN', () => {
    const c = compileTopology(buildSampleProject());
    const r = ping(c.net, { from: 'h:ap14', to: '10.0.10.12' });
    expect(r.ok).toBe(true);
  });

  it('delivers a ping between the two cameras (VLAN 20)', () => {
    const c = compileTopology(buildSampleProject());
    const r = ping(c.net, { from: 'h:cm18', to: '10.0.20.22' });
    expect(r.ok).toBe(true);
  });

  it('cannot route AP → camera across VLANs with no L3 device', () => {
    const c = compileTopology(buildSampleProject());
    const r = ping(c.net, { from: 'h:ap14', to: '10.0.20.21' });
    expect(r.ok).toBe(false);
    expect(r.events.some((e) => e.kind === 'l3-no-route')).toBe(true);
  });

  it('lists pingable endpoints for the UI picker', () => {
    const list = pingableDevices(compileTopology(buildSampleProject()));
    expect(list).toHaveLength(5);
    expect(list.find((d) => d.simId === 'h:ap14')).toMatchObject({ ip: '10.0.10.11', type: 'ap' });
  });
});

describe('compileTopology warnings', () => {
  it('skips an endpoint with no switch and one with no IP', () => {
    const project = {
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{
        id: 'f1',
        SWS: [{ id: 's1', name: 'SW1' }],
        APS: [
          { id: 'a1', name: 'orphan', ip: '10.0.10.5', vlan: '10' }, // no swId
          { id: 'a2', name: 'noip', swId: 's1', vlan: '10', port: '1' }, // no ip
          { id: 'a3', name: 'ok', swId: 's1', vlan: '10', port: '2', ip: '10.0.10.6' },
        ],
        CAMS: [],
      }],
    };
    const c = compileTopology(project);
    expect(c.warnings).toHaveLength(2);
    expect(c.net.devices.has('h:a3')).toBe(true);
    expect(c.net.devices.has('h:a1')).toBe(false);
    expect(c.net.devices.has('h:a2')).toBe(false);
  });

  it('warns on a dangling uplink target', () => {
    const project = {
      settings: { vlans: [] },
      floors: [{ id: 'f1', SWS: [{ id: 's1', name: 'SW1', uplinkId: 'ghost' }], APS: [], CAMS: [] }],
    };
    const c = compileTopology(project);
    expect(c.warnings.some((w) => /uplink target ghost not found/.test(w))).toBe(true);
  });

  it('links two switches over a trunk uplink so cross-switch same-VLAN pings work', () => {
    const project = {
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{
        id: 'f1',
        SWS: [
          { id: 'core', name: 'CORE' },
          { id: 'edge', name: 'EDGE', uplinkId: 'core' },
        ],
        APS: [
          { id: 'a1', name: 'A1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.1' },
          { id: 'a2', name: 'A2', swId: 'edge', port: '1', vlan: '10', ip: '10.0.10.2' },
        ],
        CAMS: [],
      }],
    };
    const c = compileTopology(project);
    const r = ping(c.net, { from: 'h:a1', to: '10.0.10.2' });
    expect(r.ok).toBe(true);
  });
});

describe('L3 / inter-VLAN routing', () => {
  // One L3 switch (role 'l3') with a gateway per VLAN, an AP in VLAN 10 and a
  // camera in VLAN 20.
  const l3Project = () => ({
    settings: {
      vlans: [
        { id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' },
        { id: '20', subnet: '10.0.20.0/24', gateway: '10.0.20.1' },
      ],
    },
    floors: [{
      id: 'f1',
      SWS: [{ id: 'core', name: 'CORE', role: 'l3' }],
      APS: [{ id: 'a1', name: 'A1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }],
      CAMS: [{ id: 'c1', name: 'C1', swId: 'core', port: '2', vlan: '20', ip: '10.0.20.5' }],
    }],
  });

  it('spins up a router device with an SVI per gateway VLAN', () => {
    const c = compileTopology(l3Project());
    expect(c.net.devices.has('r:core')).toBe(true);
    const r = c.net.devices.get('r:core');
    expect(r.kind).toBe('router');
    expect([...r.ifaces.keys()].sort()).toEqual(['svi10', 'svi20']);
  });

  it('gives hosts a default route toward their VLAN gateway', () => {
    const c = compileTopology(l3Project());
    const def = c.net.devices.get('h:a1').routes.find((rt) => rt.prefix === 0);
    expect(def).toBeTruthy();
  });

  it('routes AP (VLAN 10) → camera (VLAN 20) once an L3 device exists', () => {
    const c = compileTopology(l3Project());
    const r = ping(c.net, { from: 'h:a1', to: '10.0.20.5' });
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === 'l3-route')).toBe(true);
  });

  it('still blocks inter-VLAN when the same switch is a plain L2 switch', () => {
    const p = l3Project();
    p.floors[0].SWS[0].role = 'switch'; // demote the core to L2
    const c = compileTopology(p);
    expect(c.net.devices.has('r:core')).toBe(false);
    expect(ping(c.net, { from: 'h:a1', to: '10.0.20.5' }).ok).toBe(false);
  });

  it('warns when a switch is L3 but no VLAN has a gateway', () => {
    const p = l3Project();
    p.settings.vlans.forEach((v) => (v.gateway = ''));
    const c = compileTopology(p);
    expect(c.net.devices.has('r:core')).toBe(false);
    expect(c.warnings.some((w) => /no SVI\/routed interface/.test(w))).toBe(true);
  });
});

describe('Phase 3b — CLI running-configs fold into the topology', () => {
  it('a switch with CLI SVIs routes between VLANs (no GUI gateway, no role flag)', () => {
    const cli = cliConfig([
      'en', 'conf t',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit',
      'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'end',
    ]);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{
        SWS: [{ id: 'core', name: 'CORE', cli }],
        APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }],
        CAMS: [{ id: 'c1', swId: 'core', port: '2', vlan: '20', ip: '10.0.20.5' }],
      }],
    });
    expect(c.net.devices.has('r:core')).toBe(true);
    expect(ping(c.net, { from: 'h:a1', to: '10.0.20.5' }).ok).toBe(true);
  });

  it('works with RouterOS SVIs too (VLAN subinterfaces)', () => {
    const cli = cliConfig([
      '/interface vlan add name=v10 vlan-id=10 interface=br1',
      '/ip address add address=10.0.10.1/24 interface=v10',
      '/interface vlan add name=v20 vlan-id=20 interface=br1',
      '/ip address add address=10.0.20.1/24 interface=v20',
    ], 'mikrotik', 'MT-CORE');
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{
        SWS: [{ id: 'core', name: 'MT-CORE', model: 'MikroTik CRS', cli }],
        APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }],
        CAMS: [{ id: 'c1', swId: 'core', port: '2', vlan: '20', ip: '10.0.20.5' }],
      }],
    });
    expect(ping(c.net, { from: 'h:a1', to: '10.0.20.5' }).ok).toBe(true);
  });

  it('attaches CLI static routes to the compiled router', () => {
    const cli = cliConfig([
      'en', 'conf t',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit',
      'ip route 10.9.0.0 255.255.255.0 10.0.10.9', 'end',
    ]);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ SWS: [{ id: 'core', cli }], APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    const r = c.spec.devices.find((d) => d.id === 'r:core');
    expect(r.routes).toContainEqual({ cidr: '10.9.0.0/24', via: '10.0.10.9' });
  });

  it('a settings gateway takes precedence over a CLI SVI address', () => {
    const cli = cliConfig(['en', 'conf t', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'end']);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.254' }] },
      floors: [{ SWS: [{ id: 'core', role: 'l3', cli }], APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
    });
    expect(c.spec.devices.find((d) => d.id === 'h:a1').gateway).toBe('10.0.10.254');
    expect(c.spec.devices.find((d) => d.id === 'r:core').ifaces.find((i) => i.name === 'svi10').ip).toBe('10.0.10.254');
  });

  it('ignores a malformed sw.cli without crashing', () => {
    for (const bad of [null, 'nope', {}, { interfaces: null }, { interfaces: { x: { vlan: 10, ip: 'bad', prefix: 24 } } }, { routes: 'x' }]) {
      const c = compileTopology({
        settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
        floors: [{ SWS: [{ id: 'core', cli: bad }], APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }], CAMS: [] }],
      });
      expect(c.net.devices.has('h:a1')).toBe(true);
    }
  });
});

describe('Phase 4b — routed uplinks + OSPF auto-convergence', () => {
  // Two L3 switches, each with a LAN SVI + a /30 routed transit interface, joined
  // by a routed uplink, both running OSPF. No static routes anywhere.
  const siteA = () => cliConfig([
    'en', 'conf t',
    'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit',
    'interface eth5', 'ip address 10.0.99.1 255.255.255.252', 'exit',
    'router ospf 1', 'end',
  ], 'cisco', 'SITE-A');
  const siteB = () => cliConfig([
    'en', 'conf t',
    'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'exit',
    'interface eth5', 'ip address 10.0.99.2 255.255.255.252', 'exit',
    'router ospf 1', 'end',
  ], 'cisco', 'SITE-B');

  const project = (routed = true, ospf = true) => {
    const a = siteA(); const b = siteB();
    if (!ospf) { a.ospf = null; b.ospf = null; }
    return {
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{
        SWS: [
          { id: 'siteA', name: 'SITE-A', cli: a },
          { id: 'siteB', name: 'SITE-B', cli: b, uplinkId: 'siteA', uplinkMode: routed ? 'routed' : 'trunk' },
        ],
        APS: [{ id: 'a1', swId: 'siteA', port: '1', vlan: '10', ip: '10.0.10.5' }],
        CAMS: [{ id: 'c1', swId: 'siteB', port: '2', vlan: '20', ip: '10.0.20.5' }],
      }],
    };
  };

  it('builds a router per site with the routed transit interface', () => {
    const c = compileTopology(project());
    expect(c.net.devices.has('r:siteA')).toBe(true);
    expect([...c.net.devices.get('r:siteA').ifaces.keys()]).toEqual(expect.arrayContaining(['svi10', 'eth5']));
  });

  it('OSPF converges so the two sites reach each other with no static routes', () => {
    const c = compileTopology(project());
    expect(c.ospfRouters.sort()).toEqual(['r:siteA', 'r:siteB']);
    expect(ping(c.net, { from: 'h:a1', to: '10.0.20.5' }).ok).toBe(true);
    expect(ping(c.net, { from: 'h:c1', to: '10.0.10.5' }).ok).toBe(true);
  });

  it('without OSPF the sites cannot reach each other (OSPF is what links them)', () => {
    const c = compileTopology(project(true, false));
    expect(ping(c.net, { from: 'h:a1', to: '10.0.20.5' }).ok).toBe(false);
  });

  it('warns on a routed uplink with no shared transit subnet', () => {
    const p = project();
    // break site B's transit subnet so it no longer matches A's /30
    const b = p.floors[0].SWS[1].cli;
    b.interfaces.eth5.ip = '10.0.88.2';
    const c = compileTopology(p);
    expect(c.warnings.some((w) => /no shared transit subnet/.test(w))).toBe(true);
  });
});

describe('CLI firewall folds into the topology', () => {
  it('a deny rule blocks matching inter-VLAN traffic (filtered)', () => {
    const cli = cliConfig([
      'en', 'conf t',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit',
      'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'exit',
      'access-list 101 deny icmp 10.0.10.0 0.0.0.255 10.0.20.0 0.0.0.255', 'end',
    ]);
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{
        SWS: [{ id: 'core', cli }],
        APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }],
        CAMS: [{ id: 'c1', swId: 'core', port: '2', vlan: '20', ip: '10.0.20.5' }],
      }],
    });
    const r = ping(c.net, { from: 'h:a1', to: '10.0.20.5' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('filtered');
    expect(c.net.devices.get('r:core').acls).toHaveLength(1);
  });
});

describe('DHCP lease assignment + services', () => {
  const base = (eps) => ({
    settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }] },
    floors: [{ SWS: [{ id: 'core', role: 'l3' }], APS: eps, CAMS: [] }],
  });

  it('assigns a lease from the VLAN subnet to a dhcp endpoint, avoiding collisions', () => {
    const c = compileTopology(base([
      { id: 'static', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.100' },
      { id: 'd1', swId: 'core', port: '2', vlan: '10', ip: 'dhcp' },
      { id: 'd2', swId: 'core', port: '3', vlan: '10', dhcp: true },
    ]));
    expect(c.net.devices.get('h:d1').ifaces.get('eth0').ipInt).not.toBeNull();
    const leased = ['h:d1', 'h:d2'].map((id) => [...c.net.devices.get(id).ifaces.values()][0].ipInt);
    expect(leased[0]).not.toBeNull();
    expect(leased[0]).not.toBe(leased[1]); // distinct leases
    // leases don't collide with the static .100 or the gateway .1
    const list = pingableDevices(c).map((d) => d.ip);
    expect(new Set(list).size).toBe(list.length);
  });

  it('a DHCP host reaches a static host in the same subnet', () => {
    const c = compileTopology(base([
      { id: 'srv', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.50' },
      { id: 'd1', swId: 'core', port: '2', vlan: '10', ip: 'dhcp' },
    ]));
    expect(ping(c.net, { from: 'h:d1', to: '10.0.10.50' }).ok).toBe(true);
  });

  it('warns when DHCP has no subnet to lease from', () => {
    const c = compileTopology({
      settings: { vlans: [] },
      floors: [{ SWS: [{ id: 'core' }], APS: [{ id: 'd1', swId: 'core', port: '1', vlan: '10', ip: 'dhcp' }], CAMS: [] }],
    });
    expect(c.warnings.some((w) => /DHCP needs a VLAN subnet/.test(w))).toBe(true);
  });

  it('an endpoint can declare listening services for L4 probe', () => {
    const c = compileTopology(base([
      { id: 'srv', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.50', services: [{ proto: 'tcp', port: 443 }] },
      { id: 'd1', swId: 'core', port: '2', vlan: '10', ip: '10.0.10.51' },
    ]));
    expect(probe(c.net, { from: 'h:d1', to: '10.0.10.50', port: 443 }).ok).toBe(true);
    expect(probe(c.net, { from: 'h:d1', to: '10.0.10.50', port: 22 }).status).toBe('closed');
  });
});
