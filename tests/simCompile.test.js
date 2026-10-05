import { describe, it, expect } from 'vitest';
import { compileTopology, pingableDevices } from '../files/src/simCompile.js';
import { ping } from '../files/src/sim.js';
import { buildSampleProject } from '../files/src/sampleProject.js';

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
    expect(c.warnings.some((w) => /role is L3 but no VLAN has a gateway/.test(w))).toBe(true);
  });
});
