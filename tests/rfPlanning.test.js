import { describe, it, expect } from 'vitest';
import { planChannels, planTxPower, bandForAp, regionChannels, radiusAtTx } from '../files/src/rfPlanning.js';
import { REGULATORY_REGIONS, DEFAULT_REGULATORY_REGION } from '../files/src/constants.js';
import { channelsOverlapMhz } from '../files/src/geometry.js';

// The algorithms as they were inside app.js (mutating in place), kept here as
// the reference the extracted planners must reproduce exactly.
function refAutoChannel(aps, w, h, regionKey) {
  const region = REGULATORY_REGIONS[regionKey || DEFAULT_REGULATORY_REGION] || REGULATORY_REGIONS[DEFAULT_REGULATORY_REGION];
  const chans = (band) => band === '2.4' ? region.channels24.slice() : band === '5' ? region.channels5.slice() : band === '6' ? region.channels6.slice() : [];
  for (const ap of aps) {
    const band = bandForAp(ap); const list = chans(band); if (!list.length) continue;
    const dfs = region ? region.dfs || [] : [];
    const candidates = list.filter((c) => !dfs.includes(c)); const pool = candidates.length ? candidates : list;
    let bestCh = pool[0], bestScore = Infinity; const apWidth = ap.chanWidth || 20;
    for (const ch of pool) {
      let score = 0;
      for (const other of aps) {
        if (other === ap) continue; if (bandForAp(other) !== band) continue;
        const ax = ap.fx * w, ay = ap.fy * h, bx = other.fx * w, by = other.fy * h;
        const dist = Math.hypot(ax - bx, ay - by);
        if (dist >= (ap.r + other.r) * 0.9) continue;
        const otherCh = parseInt(String(other.channel || ''), 10); if (!Number.isFinite(otherCh)) continue;
        if (channelsOverlapMhz(band, ch, apWidth, band, otherCh, other.chanWidth || 20)) score += otherCh === ch ? 10 : 5;
        else if ((band === '5' || band === '6') && Math.abs(otherCh - ch) < 4) score += 1;
      }
      if (score < bestScore) { bestScore = score; bestCh = ch; }
    }
    if (String(ap.channel) !== String(bestCh)) ap.channel = String(bestCh);
  }
}
function refAutoTx(aps, w, h) {
  for (const ap of aps) {
    let bestTx = 20, bestDelta = Infinity, any = false; const ax = ap.fx * w, ay = ap.fy * h;
    for (const tx of [5, 8, 11, 14, 17, 20, 23]) {
      const a = ap.r * Math.pow(10, (tx - 20) / 30); let overlap = 0; const own = Math.PI * a * a;
      for (const other of aps) {
        if (other === ap) continue; if (bandForAp(other) !== bandForAp(ap)) continue;
        const d = Math.hypot(ax - other.fx * w, ay - other.fy * h); const b = other.r;
        if (d >= a + b) continue;
        if (d <= Math.abs(a - b)) overlap += Math.PI * Math.min(a, b) ** 2;
        else {
          const a2 = Math.acos((d * d + a * a - b * b) / (2 * d * a)) * a * a;
          const b2 = Math.acos((d * d + b * b - a * a) / (2 * d * b)) * b * b;
          const tri = 0.5 * Math.sqrt(Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b)));
          overlap += Math.max(0, a2 + b2 - tri);
        }
      }
      if (overlap > 0) any = true;
      const delta = Math.abs((own ? overlap / own : 0) - 0.3);
      if (delta < bestDelta) { bestDelta = delta; bestTx = tx; }
    }
    // Fix on top of the original: no neighbour to overlap → keep the power.
    ap.txPowerDbm = any ? bestTx : (Number.isFinite(ap.txPowerDbm) ? ap.txPowerDbm : 20);
  }
}

// Deterministic PRNG so failures reproduce.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const FREQS = ['2.4 / 5 GHz', '5 GHz only', '2.4 GHz only', '6 GHz (WiFi 6E)'];
/** @returns {any[]} */
function layout(seed) {
  const r = rng(seed); const n = 2 + Math.floor(r() * 14);
  return Array.from({ length: n }, (_, i) => ({
    id: 'a' + i, fx: r(), fy: r(), r: 40 + r() * 300, freq: FREQS[Math.floor(r() * 4)],
    chanWidth: [20, 40, 80, 160][Math.floor(r() * 4)], channel: r() < 0.5 ? String([1, 6, 11, 36, 44, 149][Math.floor(r() * 6)]) : '',
  }));
}

describe('rfPlanning matches the in-app algorithms', () => {
  const regions = Object.keys(REGULATORY_REGIONS);
  it('channel plan: identical on 500 random floors across regions', { timeout: 60000 }, () => {
    for (let seed = 1; seed <= 500; seed++) {
      const regionKey = regions[seed % regions.length];
      const aps = layout(seed); const ref = structuredClone(aps);
      refAutoChannel(ref, 1200, 800, regionKey);
      const plan = planChannels(aps, { w: 1200, h: 800, regionKey });
      expect(aps.map((a) => plan.has(a) ? plan.get(a) : a.channel), `seed ${seed}`).toEqual(ref.map((a) => a.channel));
    }
  });
  it('tx power: identical on 500 random floors', { timeout: 60000 }, () => {
    for (let seed = 1; seed <= 500; seed++) {
      const aps = layout(seed); const ref = structuredClone(aps);
      refAutoTx(ref, 1000, 1000);
      const plan = planTxPower(aps, { w: 1000, h: 1000 });
      expect(aps.map((a) => plan.get(a)), `seed ${seed}`).toEqual(ref.map((a) => a.txPowerDbm));
    }
  });
});

describe('rfPlanning basics', () => {
  it('plans dual-band on 5 GHz and avoids DFS', () => {
    expect(bandForAp({ freq: '2.4 / 5 GHz' })).toBe('5');
    const two = [{ fx: 0.5, fy: 0.5, r: 300, freq: '5 GHz only' }, { fx: 0.52, fy: 0.5, r: 300, freq: '5 GHz only' }];
    const plan = planChannels(two, { w: 1000, h: 1000, regionKey: 'FCC-US' });
    const [c1, c2] = two.map((a) => Number(plan.get(a)));
    expect(c1).not.toBe(c2);
    const dfs = REGULATORY_REGIONS['FCC-US'].dfs || [];
    expect(dfs.includes(c1) || dfs.includes(c2)).toBe(false);
    expect(regionChannels('FCC-US', '2.4')).toContain(11);
  });
  it('radius scales ~2x per +9 dB; APs with no neighbour to overlap keep their power', () => {
    expect(radiusAtTx(100, 29)).toBeCloseTo(199.5, 0);
    const lone = [{ fx: 0.1, fy: 0.1, r: 50 }, { fx: 0.9, fy: 0.9, r: 50, txPowerDbm: 17 }];
    expect([...planTxPower(lone, { w: 1000, h: 1000 }).values()]).toEqual([20, 17]);
    expect([...planTxPower([{ fx: 0.5, fy: 0.5, r: 200 }], { w: 1000, h: 1000 }).values()]).toEqual([20]);
  });
});
