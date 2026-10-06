import { describe, it, expect } from 'vitest';
import { buildNet, ping } from '../files/src/sim.js';
import { runRip } from '../files/src/rip.js';

function line3() {
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

describe('runRip', () => {
  it('converges a multi-hop line end to end, labelling routes kind rip', () => {
    const net = line3();
    const res = runRip(net);
    expect(res.routers).toBe(3);
    expect(ping(net, { from: 'pc1', to: '10.0.3.10' }).ok).toBe(true);
    expect(net.devices.get('r1').routes.some((r) => r.kind === 'rip')).toBe(true);
  });

  it('metric is hop count', () => {
    const net = line3();
    runRip(net);
    // r1 → 10.0.3.0/24 is r3's LAN: r1→r2→r3 is 2 router hops, +1 into the net = 3.
    const r = net.devices.get('r1').routes.find((rt) => rt.kind === 'rip' && rt.prefix === 24);
    expect(r.metric).toBe(3);
  });

  it('drops routes beyond the hop limit (RIP infinity)', () => {
    const net = line3();
    const res = runRip(net, { maxMetric: 2 }); // r1→r3 LAN needs metric 3 > 2
    expect(res.unreachable).toBeGreaterThan(0);
    expect(ping(net, { from: 'pc1', to: '10.0.3.10' }).ok).toBe(false);
  });

  it('is idempotent', () => {
    const net = line3();
    runRip(net);
    const n1 = net.devices.get('r1').routes.filter((r) => r.kind === 'rip').length;
    runRip(net);
    expect(net.devices.get('r1').routes.filter((r) => r.kind === 'rip').length).toBe(n1);
  });
});
