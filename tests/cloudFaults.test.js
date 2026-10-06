import { describe, it, expect } from 'vitest';
import { buildNet, ping, probe, setIfaceDown } from '../files/src/sim.js';
import { runOspf } from '../files/src/ospf.js';

describe('internet cloud', () => {
  // pc1 — edge router — cloud. pc1 default-routes to edge; edge default-routes to
  // the cloud; the cloud answers any public IP and routes replies back via edge.
  function withCloud() {
    return buildNet({
      devices: [
        { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'edge', kind: 'router', ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 'wan', ip: '203.0.113.2', prefix: 30 }], routes: [{ cidr: '0.0.0.0/0', via: '203.0.113.1' }] },
        { id: 'net', kind: 'cloud', ifaces: [{ name: 'w', ip: '203.0.113.1', prefix: 30 }], routes: [{ cidr: '10.0.0.0/24', via: '203.0.113.2' }] },
      ],
      links: [['pc1/e', 'edge/lan'], ['edge/wan', 'net/w']],
    });
  }

  it('pings a public IP through the edge router', () => {
    const r = ping(withCloud(), { from: 'pc1', to: '8.8.8.8' });
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === 'cloud-reply')).toBe(true);
  });

  it('reports a public service as reachable via probe', () => {
    expect(probe(withCloud(), { from: 'pc1', to: '1.1.1.1', port: 443 }).ok).toBe(true);
  });
});

describe('fault injection + reconvergence', () => {
  // pc1 — r1 =two paths= r3 — pc3, with r2 as the shorter middle path and a direct
  // r1–r3 backup link. OSPF uses one; downing it should reconverge onto the other.
  function dualPath() {
    return buildNet({
      devices: [
        { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'pc3', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.3.10', prefix: 24 }], gateway: '10.0.3.1' },
        { id: 'r1', kind: 'router', ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 'mid', ip: '10.0.1.1', prefix: 30 }, { name: 'bk', ip: '10.0.4.1', prefix: 30 }] },
        { id: 'r2', kind: 'router', ifaces: [{ name: 'a', ip: '10.0.1.2', prefix: 30 }, { name: 'b', ip: '10.0.2.1', prefix: 30 }] },
        { id: 'r3', kind: 'router', ifaces: [{ name: 'mid', ip: '10.0.2.2', prefix: 30 }, { name: 'bk', ip: '10.0.4.2', prefix: 30 }, { name: 'lan', ip: '10.0.3.1', prefix: 24 }] },
      ],
      links: [['pc1/e', 'r1/lan'], ['r1/mid', 'r2/a'], ['r2/b', 'r3/mid'], ['r1/bk', 'r3/bk'], ['r3/lan', 'pc3/e']],
    });
  }

  it('stays reachable after a link fails, via the backup path', () => {
    const net = dualPath();
    runOspf(net);
    expect(ping(net, { from: 'pc1', to: '10.0.3.10' }).ok).toBe(true);
    // Fail the direct r1–r3 backup link, then the r1–r2 link — force the path
    // onto whatever remains and reconverge.
    setIfaceDown(net, 'r1', 'bk');
    setIfaceDown(net, 'r3', 'bk');
    runOspf(net);
    expect(ping(net, { from: 'pc1', to: '10.0.3.10' }).ok).toBe(true); // still reachable via r2
  });

  it('becomes unreachable when every path is down', () => {
    const net = dualPath();
    runOspf(net);
    setIfaceDown(net, 'r1', 'mid');
    setIfaceDown(net, 'r1', 'bk');
    runOspf(net);
    expect(ping(net, { from: 'pc1', to: '10.0.3.10' }).ok).toBe(false);
  });
});

describe('NAT / PAT', () => {
  function natEdge() {
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

  it('translates the inside source to the edge public IP and back', () => {
    const net = natEdge();
    const r = ping(net, { from: 'pc1', to: '8.8.8.8' });
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === 'nat-out' && e.to === '203.0.113.2')).toBe(true);
    expect(r.events.some((e) => e.kind === 'nat-in')).toBe(true);
    // the cloud saw the public (translated) source, never the private 10.0.0.10
    const cloudReply = r.events.find((e) => e.kind === 'cloud-reply');
    expect(cloudReply.from).toBe('203.0.113.2');
  });

  it('does not translate traffic that stays inside', () => {
    const net = buildNet({
      devices: [
        { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
        { id: 'pc2', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.20', prefix: 24 }] },
        { id: 'edge', kind: 'router', nat: { inside: ['10.0.0.0/24'], outside: 'wan' },
          ifaces: [{ name: 'lan', ip: '10.0.0.1', prefix: 24 }, { name: 'wan', ip: '203.0.113.2', prefix: 30 }] },
        { id: 'sw', kind: 'switch', ifaces: [{ name: 'a', mode: 'access', vlan: 1 }, { name: 'b', mode: 'access', vlan: 1 }, { name: 'c', mode: 'access', vlan: 1 }] },
      ],
      links: [['pc1/e', 'sw/a'], ['pc2/e', 'sw/b'], ['sw/c', 'edge/lan']],
    });
    const r = ping(net, { from: 'pc1', to: '10.0.0.20' });
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === 'nat-out')).toBe(false); // same subnet, never hits the edge's WAN
  });
});
