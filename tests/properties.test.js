// Property tests for the IP/VLAN math, against an independent BigInt oracle.
// Deterministic (seeded PRNG) so a failure is reproducible; the address space
// is sampled across the whole 32-bit range on purpose — the 2026-11 signed-int
// bug lived above 128.0.0.0, where the hand-written cases never looked.
import { describe, it, expect } from 'vitest';
import { ipToInt, intToIp, parseCidr, ipInCidr, nextFreeIp, subnetUsage } from '../files/src/network.js';
import { parseIgpNetworks, igpCovers } from '../files/src/cli.js';

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(0x504c5853);
const u32 = () => Math.floor(rand() * 4294967296) >>> 0;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const dotted = (n) => [24, 16, 8, 0].map((s) => Number((BigInt(n) >> BigInt(s)) & 255n)).join('.');
const netOfBig = (n, bits) => (BigInt(n) >> BigInt(32 - bits)) << BigInt(32 - bits);
const N = 4000;

describe('ip <-> int', () => {
  it('round-trips every sampled address and stays unsigned', () => {
    for (let i = 0; i < N; i++) {
      const n = u32();
      const s = intToIp(n);
      expect(s).toBe(dotted(n));
      const back = ipToInt(s);
      expect(back).toBe(n);
      expect(back).toBeGreaterThanOrEqual(0);
    }
  });
  it('rejects out-of-range and malformed input', () => {
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '', '1.2.3.-4', ' ', '1..2.3']) expect(ipToInt(bad)).toBeNull();
  });
});

describe('CIDR membership agrees with a BigInt oracle', () => {
  it('parseCidr yields the unsigned network for /1…/30 anywhere in the space', () => {
    for (let i = 0; i < N; i++) {
      const base = u32(), bits = int(1, 30);
      const c = parseCidr(`${dotted(base)}/${bits}`);
      expect(BigInt(c.net)).toBe(netOfBig(base, bits));
      expect(c.net).toBeGreaterThanOrEqual(0);
      expect(c.size).toBe(2 ** (32 - bits));
    }
  });
  it('ipInCidr matches the oracle for inside, outside and boundary addresses', () => {
    for (let i = 0; i < N; i++) {
      const base = u32(), bits = int(1, 30);
      const cidr = `${dotted(base)}/${bits}`;
      const net = netOfBig(base, bits), size = 1n << BigInt(32 - bits);
      const probes = [u32(), Number(net), Number(net + size - 1n), Number((net + size) & 0xffffffffn), Number((net - 1n + 0x100000000n) & 0xffffffffn), Number(net + BigInt(int(0, Number(size - 1n))))];
      for (const p of probes) {
        const want = netOfBig(p, bits) === net;
        expect(ipInCidr(dotted(p), cidr), `${dotted(p)} in ${cidr}`).toBe(want);
      }
    }
  });
});

describe('address allocation', () => {
  it('nextFreeIp is always inside the subnet, unused, and never network/gateway/broadcast', () => {
    for (let i = 0; i < 1500; i++) {
      const base = u32(), bits = int(20, 30);
      const cidr = `${dotted(base)}/${bits}`;
      const net = Number(netOfBig(base, bits)), size = 2 ** (32 - bits);
      const used = Array.from({ length: int(0, Math.min(40, size)) }, () => dotted((net + int(0, size - 1)) >>> 0));
      const ip = nextFreeIp(cidr, used);
      if (ip === '') { // full: every allocatable host must be taken
        for (let h = 2; h < size - 1; h++) expect(used).toContain(dotted((net + h) >>> 0));
        continue;
      }
      const off = ipToInt(ip) - net;
      expect(ipInCidr(ip, cidr)).toBe(true);
      expect(used).not.toContain(ip);
      expect(off).toBeGreaterThanOrEqual(2);
      expect(off).toBeLessThan(size - 1);
    }
  });
  it('subnetUsage counts exactly the distinct addresses inside', () => {
    for (let i = 0; i < 800; i++) {
      const base = u32(), bits = int(22, 29);
      const cidr = `${dotted(base)}/${bits}`;
      const net = netOfBig(base, bits);
      const ips = Array.from({ length: int(0, 30) }, () => dotted(rand() < 0.6 ? Number(net) + int(0, 2 ** (32 - bits) - 1) : u32()));
      const want = new Set(ips.filter((s) => netOfBig(ipToInt(s), bits) === net)).size;
      expect(subnetUsage(cidr, ips).used).toBe(want);
    }
  });
});

describe('IGP network statements', () => {
  it('a CIDR statement and its wildcard-mask form cover exactly the same addresses', () => {
    for (let i = 0; i < 1500; i++) {
      const base = u32(), bits = int(0, 32);
      const net = Number(bits === 0 ? 0n : netOfBig(base, bits));
      const wild = bits === 0 ? 0xffffffff : bits === 32 ? 0 : (2 ** (32 - bits) - 1);
      const a = parseIgpNetworks([`${dotted(net)}/${bits}`]);
      const b = parseIgpNetworks([`${dotted(net)} ${dotted(wild)} area 0`]);
      for (const p of [u32(), net, (net + wild) >>> 0]) {
        const want = bits === 0 ? true : netOfBig(p, bits) === BigInt(net);
        expect(igpCovers(a, p)).toBe(want);
        expect(igpCovers(b, p)).toBe(want);
      }
    }
  });
});
