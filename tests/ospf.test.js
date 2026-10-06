import { describe, it, expect } from 'vitest';
import { buildNet, ping } from '../files/src/sim.js';
import { runOspf, ospfNeighbors } from '../files/src/ospf.js';

// pc1 — r1 — r2 — pc2, routers joined by a /30 transit, NO static routes.
function twoRouter() {
  return buildNet({
    devices: [
      { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
      { id: 'pc2', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.2.10', prefix: 24 }], gateway: '10.0.2.1' },
      { id: 'r1', kind: 'router', ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 't', ip: '10.0.1.1', prefix: 30 }] },
      { id: 'r2', kind: 'router', ifaces: [{ name: 't', ip: '10.0.1.2', prefix: 30 }, { name: 'lan', ip: '10.0.2.1', prefix: 24 }] },
    ],
    links: [['pc1/e', 'r1/lan'], ['r1/t', 'r2/t'], ['r2/lan', 'pc2/e']],
  });
}

// Three routers in a line: pc1 — r1 — r2 — r3 — pc3.
function threeRouter() {
  return buildNet({
    devices: [
      { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
      { id: 'pc3', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.3.10', prefix: 24 }], gateway: '10.0.3.1' },
      { id: 'r1', kind: 'router', ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 't', ip: '10.0.1.1', prefix: 30 }] },
      { id: 'r2', kind: 'router', ifaces: [{ name: 'w', ip: '10.0.1.2', prefix: 30 }, { name: 'e', ip: '10.0.2.1', prefix: 30 }] },
      { id: 'r3', kind: 'router', ifaces: [{ name: 't', ip: '10.0.2.2', prefix: 30 }, { name: 'lan', ip: '10.0.3.1', prefix: 24 }] },
    ],
    links: [['pc1/e', 'r1/lan'], ['r1/t', 'r2/w'], ['r2/e', 'r3/t'], ['r3/lan', 'pc3/e']],
  });
}

describe('runOspf', () => {
  it('leaves the network unreachable before it runs (sanity)', () => {
    const net = twoRouter();
    expect(ping(net, { from: 'pc1', to: '10.0.2.10' }).ok).toBe(false);
  });

  it('converges a two-router network end to end with no static routes', () => {
    const net = twoRouter();
    const res = runOspf(net);
    expect(res.routers).toBe(2);
    expect(ping(net, { from: 'pc1', to: '10.0.2.10' }).ok).toBe(true);
    expect(ping(net, { from: 'pc2', to: '10.0.0.10' }).ok).toBe(true);
  });

  it('installs the remote LAN as an OSPF route with the right next hop', () => {
    const net = twoRouter();
    runOspf(net);
    const r1 = net.devices.get('r1');
    const ospfRoutes = r1.routes.filter((r) => r.kind === 'ospf');
    // r1 should learn 10.0.2.0/24 via r2's transit IP 10.0.1.2 out its 't' iface.
    const toLan2 = ospfRoutes.find((r) => r.prefix === 24);
    expect(toLan2).toBeTruthy();
    expect(toLan2.iface).toBe('t');
  });

  it('converges a three-router line (multi-hop)', () => {
    const net = threeRouter();
    runOspf(net);
    expect(ping(net, { from: 'pc1', to: '10.0.3.10' }).ok).toBe(true);
    expect(ping(net, { from: 'pc3', to: '10.0.0.10' }).ok).toBe(true);
  });

  it('is idempotent — re-running does not duplicate routes', () => {
    const net = twoRouter();
    runOspf(net);
    const after1 = net.devices.get('r1').routes.filter((r) => r.kind === 'ospf').length;
    runOspf(net);
    const after2 = net.devices.get('r1').routes.filter((r) => r.kind === 'ospf').length;
    expect(after2).toBe(after1);
    expect(ping(net, { from: 'pc1', to: '10.0.2.10' }).ok).toBe(true);
  });

  it('prefers the lower-cost path on a triangle', () => {
    // r1-r2 direct (1 hop); r1-r3-r2 (2 hops). r1 should reach r2's LAN directly.
    const net = buildNet({
      devices: [
        { id: 'r1', kind: 'router', ifaces: [{ name: 'd', ip: '10.0.12.1', prefix: 30 }, { name: 'x', ip: '10.0.13.1', prefix: 30 }] },
        { id: 'r2', kind: 'router', ifaces: [{ name: 'd', ip: '10.0.12.2', prefix: 30 }, { name: 'x', ip: '10.0.23.1', prefix: 30 }, { name: 'lan', ip: '10.0.2.1', prefix: 24 }] },
        { id: 'r3', kind: 'router', ifaces: [{ name: 'a', ip: '10.0.13.2', prefix: 30 }, { name: 'b', ip: '10.0.23.2', prefix: 30 }] },
      ],
      links: [['r1/d', 'r2/d'], ['r1/x', 'r3/a'], ['r3/b', 'r2/x']],
    });
    runOspf(net);
    const r = net.devices.get('r1').routes.find((rt) => rt.kind === 'ospf' && rt.prefix === 24);
    expect(r.iface).toBe('d'); // direct link, not via r3
  });

  it('does not route across a partition', () => {
    const net = buildNet({
      devices: [
        { id: 'r1', kind: 'router', ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }] },
        { id: 'r2', kind: 'router', ifaces: [{ name: 'lan', ip: '10.0.9.1', prefix: 24 }] },
      ],
      links: [],
    });
    const res = runOspf(net);
    expect(res.installed).toBe(0);
    expect(net.devices.get('r1').routes.some((r) => r.kind === 'ospf')).toBe(false);
  });

  it('only routers participate; a host-only net installs nothing', () => {
    const net = buildNet({
      devices: [{ id: 'h', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.5', prefix: 24 }] }],
      links: [],
    });
    expect(runOspf(net)).toMatchObject({ routers: 0, installed: 0 });
  });
});

describe('ospfNeighbors', () => {
  it('lists the router sharing a transit subnet', () => {
    const net = twoRouter();
    const n = ospfNeighbors(net, 'r1');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ id: 'r2', ip: '10.0.1.2' });
  });
  it('a lone router has no neighbors', () => {
    const net = twoRouter();
    // isolate r1 by downing its transit link
    net.devices.get('r1').ifaces.get('t').up = false;
    net.devices.get('r2').ifaces.get('t').up = false;
    expect(ospfNeighbors(net, 'r1')).toHaveLength(0);
  });
});
