// Automatic RF planning for the APs on one floor: a greedy channel plan and
// per-AP Tx-power tuning. Pure — returns the plan; the caller applies it.
// Positions are fractions; radii are pixels of the floor image (w × h).

import { REGULATORY_REGIONS, DEFAULT_REGULATORY_REGION } from './constants.js';
import { channelsOverlapMhz } from './geometry.js';

/** Band the planner works in: dual-band APs are planned on 5 GHz. */
export function bandForAp(ap) {
  const f = ap.freq || '';
  if (f.indexOf('6 GHz') >= 0) return '6';
  if (f === '2.4 GHz only') return '2.4';
  return '5';
}

const regionOf = (key) => REGULATORY_REGIONS[key || DEFAULT_REGULATORY_REGION] || REGULATORY_REGIONS[DEFAULT_REGULATORY_REGION];

/** Channels the regulatory region allows in a band. */
export function regionChannels(regionKey, band) {
  const r = regionOf(regionKey);
  if (band === '2.4') return r.channels24.slice();
  if (band === '5') return r.channels5.slice();
  if (band === '6') return r.channels6.slice();
  return [];
}

/**
 * Greedy graph colouring: each AP in turn takes the channel of its band that
 * conflicts least with neighbours whose cells overlap (closer than
 * 0.9·(rA+rB)). Width-aware: a conflict is real spectrum overlap at each
 * AP's channel width. DFS channels are avoided unless nothing else exists.
 * Each choice is seen by the APs after it, as when planned in place.
 * @param {any[]} aps
 * @param {{w:number, h:number, regionKey?:string}} opts
 * @returns {Map<any,string>} AP → channel, for APs whose band has channels
 */
export function planChannels(aps, { w, h, regionKey }) {
  const chOf = new Map(aps.map((ap) => [ap, ap.channel]));
  const dfs = regionOf(regionKey).dfs || [];
  /** @type {Map<any,string>} */
  const plan = new Map();
  for (const ap of aps) {
    const band = bandForAp(ap);
    const list = regionChannels(regionKey, band);
    if (!list.length) continue;
    const candidates = list.filter((c) => !dfs.includes(c));
    const pool = candidates.length ? candidates : list;
    let bestCh = pool[0], bestScore = Infinity;
    const apWidth = ap.chanWidth || 20;
    for (const ch of pool) {
      let score = 0;
      for (const other of aps) {
        if (other === ap || bandForAp(other) !== band) continue;
        const dist = Math.hypot(ap.fx * w - other.fx * w, ap.fy * h - other.fy * h);
        if (dist >= (ap.r + other.r) * 0.9) continue;
        const otherCh = parseInt(String(chOf.get(other) || ''), 10);
        if (!Number.isFinite(otherCh)) continue;
        if (channelsOverlapMhz(band, ch, apWidth, band, otherCh, other.chanWidth || 20)) score += otherCh === ch ? 10 : 5;
        else if ((band === '5' || band === '6') && Math.abs(otherCh - ch) < 4) score += 1;   // adjacent-channel leakage
      }
      if (score < bestScore) { bestScore = score; bestCh = ch; }
    }
    plan.set(ap, String(bestCh));
    chOf.set(ap, String(bestCh));
  }
  return plan;
}

/** Tx power that maps to an AP's stored coverage radius. */
export const TX_POWER_REF_DBM = 20;

/** Radius at `tx` dBm: indoor path-loss exponent ≈3 → range × 10^(ΔdBm/30). */
export function radiusAtTx(baseR, tx) {
  return baseR * Math.pow(10, (tx - TX_POWER_REF_DBM) / 30);
}

// Area of the intersection of two circles (radii a, b; centres d apart).
function lensArea(a, b, d) {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.PI * Math.min(a, b) ** 2;
  // Clamped: rounding can push the cosine just past ±1 (→ NaN).
  const acos = (x) => Math.acos(Math.max(-1, Math.min(1, x)));
  const a2 = acos((d * d + a * a - b * b) / (2 * d * a)) * a * a;
  const b2 = acos((d * d + b * b - a * a) / (2 * d * b)) * b * b;
  const tri = 0.5 * Math.sqrt(Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b)));
  return Math.max(0, a2 + b2 - tri);
}

/**
 * Per AP, the Tx power (5…23 dBm) whose cell overlaps same-band neighbours by
 * closest to 30 % of its own area — enough for roaming without blanketing the
 * floor. Neighbours are taken at their stored radius.
 * @param {any[]} aps
 * @param {{w:number, h:number}} opts
 * @returns {Map<any,number>} AP → dBm
 */
export function planTxPower(aps, { w, h }) {
  /** @type {Map<any,number>} */
  const plan = new Map();
  for (const ap of aps) {
    let bestTx = TX_POWER_REF_DBM, bestDelta = Infinity;
    for (const tx of [5, 8, 11, 14, 17, 20, 23]) {
      const a = radiusAtTx(ap.r, tx);
      let overlap = 0;
      for (const other of aps) {
        if (other === ap || bandForAp(other) !== bandForAp(ap)) continue;
        overlap += lensArea(a, other.r, Math.hypot(ap.fx * w - other.fx * w, ap.fy * h - other.fy * h));
      }
      const own = Math.PI * a * a;
      const delta = Math.abs((own ? overlap / own : 0) - 0.3);
      if (delta < bestDelta) { bestDelta = delta; bestTx = tx; }
    }
    plan.set(ap, bestTx);
  }
  return plan;
}
