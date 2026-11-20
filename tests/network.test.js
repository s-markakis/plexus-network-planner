import { describe, it, expect } from 'vitest';
import {
  runLengthM,
  analyzeLoad,
  ipToInt,
  intToIp,
  nextFreeIp,
  cableBoxCount,
  parseCidr,
  ipInCidr,
  subnetUsage,
} from '../files/src/network.js';

describe('runLengthM', () => {
  it('converts fractional pixel distance to metres', () => {
    // 0.5 of a 1000px-wide image = 500px; at 100 m/100px ⇒ 500 m.
    expect(runLengthM(0.5, 0, 0, 0, 1000, 1000, 100, 1)).toBe(500);
  });
  it('applies the routing factor', () => {
    expect(runLengthM(0.5, 0, 0, 0, 1000, 1000, 100, 1.3)).toBeCloseTo(650);
  });
  it('uses Euclidean distance across both axes', () => {
    // 3-4-5 triangle: dx=300, dy=400 ⇒ 500px ⇒ 500 m at 100 m/100px.
    expect(runLengthM(0.3, 0.4, 0, 0, 1000, 1000, 100, 1)).toBe(500);
  });
  it('treats a non-positive factor as 1', () => {
    expect(runLengthM(0.5, 0, 0, 0, 1000, 1000, 100, 0)).toBe(500);
  });
});

describe('analyzeLoad', () => {
  const clients = [
    { w: 20, cls: 'at' },
    { w: 30, cls: 'at' },
    { w: 60, cls: 'bt' },
  ];
  it('sums draw and counts ports', () => {
    const a = analyzeLoad(clients, { budget: 0, ports: null, swCls: null });
    expect(a.draw).toBe(110);
    expect(a.used).toBe(3);
  });
  it('flags over-budget', () => {
    expect(analyzeLoad(clients, { budget: 100 }).overBudget).toBe(true);
    expect(analyzeLoad(clients, { budget: 200 }).overBudget).toBe(false);
  });
  it('computes headroom percentage', () => {
    expect(analyzeLoad(clients, { budget: 220 }).headroom).toBe(50);
    expect(analyzeLoad(clients, { budget: 0 }).headroom).toBeNull();
  });
  it('flags over-ports only when port count is known', () => {
    expect(analyzeLoad(clients, { ports: 2 }).overPorts).toBe(true);
    expect(analyzeLoad(clients, { ports: 8 }).overPorts).toBe(false);
    expect(analyzeLoad(clients, { ports: null }).overPorts).toBe(false);
  });
  it('flags devices needing a higher PoE class than the switch delivers', () => {
    // switch delivers 'at'; the 'bt' device is a mismatch.
    const fails = analyzeLoad(clients, { swCls: 'at' }).classFails;
    expect(fails).toHaveLength(1);
    expect(fails[0].cls).toBe('bt');
  });
  it('flags everything PoE when the switch has no PoE', () => {
    expect(analyzeLoad(clients, { swCls: null }).classFails).toHaveLength(3);
  });
});

describe('ipToInt / intToIp', () => {
  it('round-trips addresses including high first octets', () => {
    for (const ip of ['0.0.0.0', '10.0.10.5', '192.168.1.1', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip))).toBe(ip);
    }
  });
  it('rejects malformed or out-of-range input', () => {
    expect(ipToInt('not.an.ip')).toBeNull();
    expect(ipToInt('256.0.0.1')).toBeNull();
    expect(ipToInt('1.2.3')).toBeNull();
  });
});

describe('nextFreeIp', () => {
  it('returns the first host, skipping .0 and .1', () => {
    expect(nextFreeIp('192.168.1.0/24', [])).toBe('192.168.1.2');
  });
  it('skips addresses already in use', () => {
    const used = ['192.168.1.2', '192.168.1.3'];
    expect(nextFreeIp('192.168.1.0/24', used)).toBe('192.168.1.4');
  });
  it('accepts a Set of used addresses', () => {
    expect(nextFreeIp('10.0.0.0/24', new Set(['10.0.0.2']))).toBe('10.0.0.3');
  });
  it('normalises a non-aligned base to the network address', () => {
    expect(nextFreeIp('192.168.1.37/24', [])).toBe('192.168.1.2');
  });
  it('returns "" for no/invalid subnet', () => {
    expect(nextFreeIp('', [])).toBe('');
    expect(nextFreeIp('192.168.1.0', [])).toBe('');
    expect(nextFreeIp('192.168.1.0/33', [])).toBe('');
    expect(nextFreeIp('192.168.1.0/0', [])).toBe('');
  });
  it('returns "" when the usable range is exhausted', () => {
    // /30 ⇒ hosts .1 and .2; we skip .1, so only .2 is offerable.
    expect(nextFreeIp('192.168.1.0/30', ['192.168.1.2'])).toBe('');
  });
  it('caps the scan so a huge subnet cannot hang', () => {
    // /8 with the low range fully used → must stop at the cap, returning ''.
    const used = new Set();
    for (let i = 2; i < 2 + 4094; i++) used.add(`10.0.${(i >> 8) & 255}.${i & 255}`);
    expect(nextFreeIp('10.0.0.0/8', used, 4094)).toBe('');
  });
});

describe('cableBoxCount', () => {
  it('rounds up to whole boxes', () => {
    expect(cableBoxCount(0, 305)).toBe(0);
    expect(cableBoxCount(1, 305)).toBe(1);
    expect(cableBoxCount(305, 305)).toBe(1);
    expect(cableBoxCount(306, 305)).toBe(2);
  });
});

describe('parseCidr / ipInCidr', () => {
  it('parses a /24 and reports usable capacity', () => {
    const c = parseCidr('10.0.10.0/24');
    expect(c).not.toBeNull();
    expect(c.size).toBe(256);
    expect(c.capacity).toBe(253); // minus network, gateway, broadcast
  });
  it('rejects malformed CIDRs', () => {
    expect(parseCidr('')).toBeNull();
    expect(parseCidr('10.0.10.0')).toBeNull();
    expect(parseCidr('10.0.10.0/31')).toBeNull();
    expect(parseCidr('999.0.0.0/24')).toBeNull();
  });
  it('checks membership against the network base, not the literal base', () => {
    // 10.0.10.99/24 normalises to the 10.0.10.0 network.
    expect(ipInCidr('10.0.10.7', '10.0.10.99/24')).toBe(true);
    expect(ipInCidr('10.0.11.7', '10.0.10.0/24')).toBe(false);
    expect(ipInCidr('not-an-ip', '10.0.10.0/24')).toBe(false);
    expect(ipInCidr('10.0.10.7', 'nope')).toBe(false);
  });
});

describe('subnetUsage', () => {
  it('counts only addresses inside the subnet, deduplicated', () => {
    const u = subnetUsage('10.0.10.0/24', ['10.0.10.2', '10.0.10.2', '10.0.10.3', '192.168.1.5', '']);
    expect(u.used).toBe(2);
    expect(u.capacity).toBe(253);
    expect(u.pct).toBe(1);
  });
  it('reports a nearly-full pool', () => {
    // /29 ⇒ size 8, capacity 5 (idx 2..6).
    const ips = ['10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6'];
    const u = subnetUsage('10.0.0.0/29', ips);
    expect(u.used).toBe(5);
    expect(u.capacity).toBe(5);
    expect(u.pct).toBe(100);
  });
  it('does not count the network, gateway (.1) or broadcast addresses', () => {
    // Router on .1 plus 252 hosts in a /24: one address (.254) is still free.
    const ips = ['10.0.10.1', ...Array.from({ length: 252 }, (_, i) => `10.0.10.${i + 2}`), '10.0.10.0', '10.0.10.255'];
    const u = subnetUsage('10.0.10.0/24', ips);
    expect(u.used).toBe(252);
    expect(u.pct).toBe(100);           // rounds, but…
    expect(u.used < u.capacity).toBe(true);   // …one host is free
    expect(subnetUsage('10.0.0.0/30', ['10.0.0.1', '10.0.0.2']).used).toBe(1);
  });
  it('returns null for an unusable CIDR but not for a tiny one', () => {
    expect(subnetUsage('', [])).toBeNull();
    expect(subnetUsage('10.0.0.0/30', []).capacity).toBe(1); // /30 still has one offerable host
  });
});
