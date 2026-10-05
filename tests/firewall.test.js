import { describe, it, expect } from 'vitest';
import { buildNet, ping, probe } from '../files/src/sim.js';

// pc1 — R (router, filters) — pc2, two subnets. ACLs/services live on R or pc2.
function net({ acls = [], services = [] } = {}) {
  return buildNet({
    devices: [
      { id: 'pc1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.10', prefix: 24 }], gateway: '10.0.0.1' },
      { id: 'pc2', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.1.10', prefix: 24 }], gateway: '10.0.1.1', services },
      { id: 'r', kind: 'router', acls, ifaces: [{ name: 'a', ip: '10.0.0.1', prefix: 24 }, { name: 'b', ip: '10.0.1.1', prefix: 24 }] },
      { id: 's0', kind: 'switch', ifaces: [{ name: 'x', mode: 'access', vlan: 1 }, { name: 'y', mode: 'access', vlan: 1 }] },
      { id: 's1', kind: 'switch', ifaces: [{ name: 'x', mode: 'access', vlan: 1 }, { name: 'y', mode: 'access', vlan: 1 }] },
    ],
    links: [['pc1/e', 's0/x'], ['s0/y', 'r/a'], ['r/b', 's1/x'], ['s1/y', 'pc2/e']],
  });
}

describe('ACL / firewall', () => {
  it('permits by default when no ACL is set', () => {
    expect(ping(net(), { from: 'pc1', to: '10.0.1.10' }).ok).toBe(true);
  });

  it('a deny rule drops matching traffic (filtered)', () => {
    const n = net({ acls: [{ action: 'deny', proto: 'icmp', src: '10.0.0.0/24', dst: '10.0.1.0/24' }] });
    const r = ping(n, { from: 'pc1', to: '10.0.1.10' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('filtered');
    expect(r.events.some((e) => e.kind === 'acl-drop')).toBe(true);
  });

  it('first-match wins: a specific deny before permit-any blocks that source', () => {
    const n = net({ acls: [{ action: 'deny', src: '10.0.0.10/32', dst: 'any' }, { action: 'permit', src: 'any', dst: 'any' }] });
    expect(ping(n, { from: 'pc1', to: '10.0.1.10' }).ok).toBe(false);
  });

  it('permit icmp + deny-any lets ping through both ways but blocks tcp', () => {
    const n = net({
      acls: [
        { action: 'permit', proto: 'icmp', src: 'any', dst: 'any' },
        { action: 'deny', proto: 'any', src: 'any', dst: 'any' },
      ],
      services: [{ proto: 'tcp', port: 80 }],
    });
    expect(ping(n, { from: 'pc1', to: '10.0.1.10' }).ok).toBe(true);
    expect(probe(n, { from: 'pc1', to: '10.0.1.10', port: 80 }).status).toBe('filtered');
  });

  it('stateless gotcha: a one-way permit + deny-any blocks the return traffic', () => {
    // The request (10.0.0.x→10.0.1.x) is permitted, but the echo-reply
    // (10.0.1.x→10.0.0.x) matches deny-any — so a stateless ACL needs a return
    // permit. This is the real behaviour, surfaced deliberately.
    const n = net({
      acls: [
        { action: 'permit', proto: 'icmp', src: '10.0.0.0/24', dst: '10.0.1.0/24' },
        { action: 'deny', proto: 'any', src: 'any', dst: 'any' },
      ],
    });
    expect(ping(n, { from: 'pc1', to: '10.0.1.10' }).ok).toBe(false);
  });

  it('a port-specific deny blocks that service but not others', () => {
    const n = net({
      acls: [{ action: 'deny', proto: 'tcp', src: 'any', dst: '10.0.1.0/24', dport: 22 }],
      services: [{ proto: 'tcp', port: 22 }, { proto: 'tcp', port: 80 }],
    });
    expect(probe(n, { from: 'pc1', to: '10.0.1.10', port: 22 }).status).toBe('filtered');
    expect(probe(n, { from: 'pc1', to: '10.0.1.10', port: 80 }).ok).toBe(true);
    // ICMP still passes (the deny is tcp/22 only)
    expect(ping(n, { from: 'pc1', to: '10.0.1.10' }).ok).toBe(true);
  });
});

describe('L4 services (probe)', () => {
  it('open when the host listens on the port', () => {
    const n = net({ services: [{ proto: 'tcp', port: 443 }] });
    const r = probe(n, { from: 'pc1', to: '10.0.1.10', port: 443 });
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === 'l4-open')).toBe(true);
  });

  it('closed when the host is reachable but nothing listens', () => {
    const n = net({ services: [{ proto: 'tcp', port: 443 }] });
    const r = probe(n, { from: 'pc1', to: '10.0.1.10', port: 3306 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('closed');
    expect(r.events.some((e) => e.kind === 'l4-closed')).toBe(true);
  });

  it('udp and tcp on the same port are distinct', () => {
    const n = net({ services: [{ proto: 'udp', port: 53 }] });
    expect(probe(n, { from: 'pc1', to: '10.0.1.10', port: 53, protocol: 'udp' }).ok).toBe(true);
    expect(probe(n, { from: 'pc1', to: '10.0.1.10', port: 53, protocol: 'tcp' }).status).toBe('closed');
  });

  it('unreachable (no route) is distinct from closed', () => {
    const n = net({ services: [{ proto: 'tcp', port: 80 }] });
    expect(probe(n, { from: 'pc1', to: '192.168.50.1', port: 80 }).status).toBe('unreachable');
  });
});
