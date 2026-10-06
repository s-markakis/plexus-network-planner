// Adversarial bug-hunt over this session's new features (NAT, ACL, L4, cloud,
// DHCP, wireless, protocols). Each probes an edge the main suites didn't.
import { describe, it, expect } from 'vitest';
import { buildNet, ping, probe, resetRuntime } from '../files/src/sim.js';
import { compileTopology } from '../files/src/simCompile.js';
import { runOspf } from '../files/src/ospf.js';
import { runRip } from '../files/src/rip.js';

function natNet() {
  return buildNet({
    devices: [
      { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
      { id: 'edge', kind: 'router', nat: { inside: ['10.0.0.0/24'], outside: 'wan' },
        ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 'wan', ip: '203.0.113.2', prefix: 30 }],
        routes: [{ cidr: '0.0.0.0/0', via: '203.0.113.1' }] },
      { id: 'net', kind: 'cloud', ifaces: [{ name: 'w', ip: '203.0.113.1', prefix: 30 }], routes: [{ cidr: '10.0.0.0/24', via: '203.0.113.2' }] },
    ],
    links: [['pc1/e', 'edge/lan'], ['edge/wan', 'net/w']],
  });
}

describe('NAT edge cases', () => {
  it('pinging the WAN IP still reaches the router even after a NAT session exists', () => {
    const net = natNet();
    expect(ping(net, { from: 'pc1', to: '8.8.8.8' }).ok).toBe(true); // opens a NAT session
    // now ping the edge's own WAN interface — must be delivered, not de-NAT'd away
    expect(ping(net, { from: 'pc1', to: '203.0.113.2' }).ok).toBe(true);
  });
  it('an L4 probe to the internet works through NAT', () => {
    const net = natNet();
    expect(probe(net, { from: 'pc1', to: '1.1.1.1', port: 443 }).ok).toBe(true);
  });
  it('resetRuntime clears the NAT session', () => {
    const net = natNet();
    ping(net, { from: 'pc1', to: '8.8.8.8' });
    resetRuntime(net);
    expect(net.devices.get('edge')._natSession).toBeNull();
  });
});

describe('ACL proto matching', () => {
  function filtered(acls) {
    const net = buildNet({
      devices: [
        { id: 'a', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.1', prefix: 24 }], gateway: '10.0.0.254' },
        { id: 'b', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.1.1', prefix: 24 }], gateway: '10.0.1.254', services: [{ proto: 'tcp', port: 80 }] },
        { id: 'r', kind: 'router', acls, ifaces: [{ name: 'x', ip: '10.0.0.254', prefix: 24 }, { name: 'y', ip: '10.0.1.254', prefix: 24 }] },
      ],
      links: [['a/e', 'r/x'], ['r/y', 'b/e']],
    });
    return net;
  }
  it('proto ip blocks both icmp and tcp', () => {
    const n = filtered([{ action: 'deny', proto: 'ip', src: 'any', dst: 'any' }]);
    expect(ping(n, { from: 'a', to: '10.0.1.1' }).status).toBe('filtered');
    expect(probe(n, { from: 'a', to: '10.0.1.1', port: 80 }).status).toBe('filtered');
  });
  it('a tcp deny leaves icmp alone', () => {
    const n = filtered([{ action: 'deny', proto: 'tcp', src: 'any', dst: 'any' }]);
    expect(ping(n, { from: 'a', to: '10.0.1.1' }).ok).toBe(true);
    expect(probe(n, { from: 'a', to: '10.0.1.1', port: 80 }).status).toBe('filtered');
  });
});

describe('DHCP correctness', () => {
  it('a lease is never the gateway or a static address', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }] },
      floors: [{ SWS: [{ id: 'sw', role: 'l3' }], APS: [
        { id: 's', swId: 'sw', port: '1', vlan: '10', ip: '10.0.10.2' },
        { id: 'd', swId: 'sw', port: '2', vlan: '10', ip: 'dhcp' },
      ], CAMS: [] }],
    });
    const lease = c.meta.get('h:d').ip;
    expect(lease).not.toBe('10.0.10.1'); // not the gateway
    expect(lease).not.toBe('10.0.10.2'); // not the static host
  });
});

describe('routing protocols do not interfere', () => {
  function line() {
    return buildNet({
      devices: [
        { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'pc2', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.2.10', prefix: 24 }], gateway: '10.0.2.1' },
        { id: 'r1', kind: 'router', ifaces: [{ name: 'l', ip: '10.0.0.1', prefix: 24 }, { name: 't', ip: '10.0.1.1', prefix: 30 }] },
        { id: 'r2', kind: 'router', ifaces: [{ name: 't', ip: '10.0.1.2', prefix: 30 }, { name: 'l', ip: '10.0.2.1', prefix: 24 }] },
      ],
      links: [['pc1/e', 'r1/l'], ['r1/t', 'r2/t'], ['r2/l', 'pc2/e']],
    });
  }
  it('re-running OSPF twice does not break forwarding', () => {
    const net = line();
    runOspf(net); runOspf(net);
    expect(ping(net, { from: 'pc1', to: '10.0.2.10' }).ok).toBe(true);
  });
  it('OSPF then RIP both converge and forwarding still works', () => {
    const net = line();
    runOspf(net); runRip(net);
    expect(ping(net, { from: 'pc1', to: '10.0.2.10' }).ok).toBe(true);
  });
});

describe('more edges', () => {
  it('an ACL can block internet access while leaving the LAN reachable', () => {
    const net = buildNet({
      devices: [
        { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'srv', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.20', prefix: 24 }] },
        { id: 'edge', kind: 'router', acls: [{ action: 'deny', proto: 'ip', src: '10.0.0.0/24', dst: '0.0.0.0/0' }],
          ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 'wan', ip: '203.0.113.2', prefix: 30 }], routes: [{ cidr: '0.0.0.0/0', via: '203.0.113.1' }] },
        { id: 'net', kind: 'cloud', ifaces: [{ name: 'w', ip: '203.0.113.1', prefix: 30 }], routes: [{ cidr: '10.0.0.0/24', via: '203.0.113.2' }] },
        { id: 'sw', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: 1 }, { name: 'b', mode: 'access', vlan: 1 }, { name: 'c', mode: 'access', vlan: 1 }] },
      ],
      links: [['pc1/e', 'sw/a'], ['srv/e', 'sw/b'], ['sw/c', 'edge/lan']],
    });
    // NOTE: dst 0.0.0.0/0 matches EVERYTHING incl the LAN, but the LAN ping never
    // transits the edge router (same subnet) so it is unaffected.
    expect(ping(net, { from: 'pc1', to: '10.0.0.20' }).ok).toBe(true); // LAN stays up
    expect(ping(net, { from: 'pc1', to: '8.8.8.8' }).status).toBe('filtered'); // internet blocked
  });

  it('a wireless client can override the AP VLAN', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }, { id: '99', subnet: '10.0.99.0/24', gateway: '10.0.99.1' }] },
      floors: [{ id: 'f1', imgW: 1000, imgH: 1000, scaleM: 100,
        SWS: [{ id: 'sw', role: 'l3' }],
        APS: [{ id: 'ap', name: 'AP', fx: 0.5, fy: 0.5, r: 600, freq: '5 GHz', swId: 'sw', vlan: '10', ip: '10.0.10.2' }],
        CAMS: [], WALLS: [],
        CLIENTS: [{ id: 'guest', fx: 0.5, fy: 0.5, vlan: '99', ip: 'dhcp' }] }],
    });
    expect(c.meta.get('h:guest').vlan).toBe(99); // overrode AP's VLAN 10
  });

  it('DHCP without a gateway still leases (host just has no default route)', () => {
    const c = compileTopology({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ SWS: [{ id: 'sw' }], APS: [{ id: 'd', swId: 'sw', port: '1', vlan: '10', ip: 'dhcp' }], CAMS: [] }],
    });
    expect(c.net.devices.has('h:d')).toBe(true);
    expect(c.net.devices.get('h:d').ifaces.get('eth0').ipInt).not.toBeNull();
  });
});
