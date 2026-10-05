import { describe, it, expect } from 'vitest';
import { buildNet, ping, traceroute, resetRuntime } from '../files/src/sim.js';

// Two hosts on one switch, same subnet.
function flatLan() {
  return buildNet({
    devices: [
      { id: 'pc1', name: 'PC1', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.0.10', prefix: 24 }] },
      { id: 'pc2', name: 'PC2', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.0.20', prefix: 24 }] },
      {
        id: 'sw1', name: 'SW1', kind: 'switch',
        ifaces: [
          { name: 'g1', mode: 'access', vlan: 1 },
          { name: 'g2', mode: 'access', vlan: 1 },
        ],
      },
    ],
    links: [['pc1/eth0', 'sw1/g1'], ['pc2/eth0', 'sw1/g2']],
  });
}

// Two hosts on one switch but in different VLANs (no router) → isolated.
function vlanLan() {
  return buildNet({
    devices: [
      { id: 'pc1', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.0.10', prefix: 24 }] },
      { id: 'pc2', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.0.20', prefix: 24 }] },
      {
        id: 'sw1', kind: 'switch',
        ifaces: [
          { name: 'g1', mode: 'access', vlan: 10 },
          { name: 'g2', mode: 'access', vlan: 20 },
        ],
      },
    ],
    links: [['pc1/eth0', 'sw1/g1'], ['pc2/eth0', 'sw1/g2']],
  });
}

// pc1 — sw1 — R1 — sw2 — pc2, two subnets routed by R1 (router-on-a-stick-ish,
// but two physical router ports). Hosts point their default gateway at R1.
function routedNet() {
  return buildNet({
    devices: [
      { id: 'pc1', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
      { id: 'pc2', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.1.10', prefix: 24 }], gateway: '10.0.1.1' },
      {
        id: 'r1', name: 'R1', kind: 'router', vendor: 'cisco',
        ifaces: [
          { name: 'g0/0', ip: '10.0.0.1', prefix: 24 },
          { name: 'g0/1', ip: '10.0.1.1', prefix: 24 },
        ],
      },
      { id: 'sw1', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: 1 }, { name: 'b', mode: 'access', vlan: 1 }] },
      { id: 'sw2', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: 1 }, { name: 'b', mode: 'access', vlan: 1 }] },
    ],
    links: [
      ['pc1/eth0', 'sw1/a'], ['sw1/b', 'r1/g0/0'],
      ['r1/g0/1', 'sw2/a'], ['sw2/b', 'pc2/eth0'],
    ],
  });
}

// pc1 — R1 — R2 — pc2, two router hops joined by a transit link, static routes.
function twoRouterNet() {
  return buildNet({
    devices: [
      { id: 'pc1', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
      { id: 'pc2', kind: 'host', ifaces: [{ name: 'eth0', ip: '10.0.2.10', prefix: 24 }], gateway: '10.0.2.1' },
      {
        id: 'r1', kind: 'router', vendor: 'mikrotik',
        ifaces: [
          { name: 'ether1', ip: '10.0.0.1', prefix: 24 },
          { name: 'ether2', ip: '10.0.1.1', prefix: 30 },
        ],
        routes: [{ cidr: '10.0.2.0/24', via: '10.0.1.2' }],
      },
      {
        id: 'r2', kind: 'router', vendor: 'cisco',
        ifaces: [
          { name: 'g0/0', ip: '10.0.1.2', prefix: 30 },
          { name: 'g0/1', ip: '10.0.2.1', prefix: 24 },
        ],
        routes: [{ cidr: '10.0.0.0/24', via: '10.0.1.1' }],
      },
    ],
    links: [['pc1/eth0', 'r1/ether1'], ['r1/ether2', 'r2/g0/0'], ['r2/g0/1', 'pc2/eth0']],
  });
}

describe('buildNet', () => {
  it('derives a connected route from each addressed interface', () => {
    const net = routedNet();
    const connected = net.devices.get('r1').routes.filter((r) => r.kind === 'connected');
    expect(connected).toHaveLength(2);
  });
  it('turns a host gateway into a default route', () => {
    const net = routedNet();
    const def = net.devices.get('pc1').routes.find((r) => r.prefix === 0);
    expect(def).toBeTruthy();
  });
  it('rejects duplicate device ids', () => {
    expect(() =>
      buildNet({ devices: [{ id: 'x', ifaces: [] }, { id: 'x', ifaces: [] }] })
    ).toThrow(/duplicate/);
  });
});

describe('L2 ping within a subnet', () => {
  it('delivers pc1 → pc2 over a switch', () => {
    const net = flatLan();
    const r = ping(net, { from: 'pc1', to: '10.0.0.20' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('delivered');
  });
  it('resolves via ARP and completes the echo/reply', () => {
    const net = flatLan();
    const r = ping(net, { from: 'pc1', to: '10.0.0.20' });
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toContain('arp-request');
    expect(kinds).toContain('arp-reply');
    expect(kinds).toContain('icmp-echo');
    expect(kinds).toContain('icmp-reply');
  });
  it('floods the first frame, then forwards from the learned MAC table', () => {
    const net = flatLan();
    ping(net, { from: 'pc1', to: '10.0.0.20' }); // warms SW1's MAC table
    const r = ping(net, { from: 'pc1', to: '10.0.0.20' });
    expect(r.events.some((e) => e.kind === 'l2-flood')).toBe(false);
    expect(r.ok).toBe(true);
  });
  it('uses the warm ARP cache on a repeat ping', () => {
    const net = flatLan();
    ping(net, { from: 'pc1', to: '10.0.0.20' });
    const r = ping(net, { from: 'pc1', to: '10.0.0.20' });
    expect(r.events.some((e) => e.kind === 'arp-cached')).toBe(true);
  });
});

describe('VLAN isolation', () => {
  it('cannot reach a host in another VLAN on the same switch', () => {
    const net = vlanLan();
    const r = ping(net, { from: 'pc1', to: '10.0.0.20' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('unreachable');
  });
});

describe('L3 routing through one router', () => {
  it('delivers pc1 → pc2 across subnets via the gateway', () => {
    const net = routedNet();
    const r = ping(net, { from: 'pc1', to: '10.0.1.10' });
    expect(r.ok).toBe(true);
  });
  it('ARPs twice: once for the gateway, once for the final host', () => {
    const net = routedNet();
    const r = ping(net, { from: 'pc1', to: '10.0.1.10' });
    const arpReqs = r.events.filter((e) => e.kind === 'arp-request');
    expect(arpReqs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('L3 routing through two routers with static routes', () => {
  it('delivers end-to-end', () => {
    const net = twoRouterNet();
    const r = ping(net, { from: 'pc1', to: '10.0.2.10' });
    expect(r.ok).toBe(true);
  });
  it('is unreachable when the return static route is missing', () => {
    const net = twoRouterNet();
    net.devices.get('r2').routes = net.devices
      .get('r2')
      .routes.filter((rt) => rt.kind === 'connected'); // drop the route back to 10.0.0.0/24
    const r = ping(net, { from: 'pc1', to: '10.0.2.10' });
    expect(r.ok).toBe(false);
  });
});

describe('unreachable destinations', () => {
  it('reports no-route for an unknown network', () => {
    const net = routedNet();
    const r = ping(net, { from: 'pc1', to: '192.168.99.1' });
    expect(r.ok).toBe(false);
    expect(r.events.some((e) => e.kind === 'l3-no-route')).toBe(true);
  });
});

describe('traceroute', () => {
  it('lists each router hop then the destination', () => {
    const net = twoRouterNet();
    resetRuntime(net);
    const hops = traceroute(net, { from: 'pc1', to: '10.0.2.10' });
    expect(hops[0]).toMatchObject({ ttl: 1, ip: '10.0.0.1', reached: false });
    const last = hops[hops.length - 1];
    expect(last.reached).toBe(true);
    expect(last.ip).toBe('10.0.2.10');
  });
});
