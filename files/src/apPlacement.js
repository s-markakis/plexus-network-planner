// Auto-AP placement: greedy coverage maximisation. A sample grid covers the
// floor image; points already reached by existing APs count as covered. Each
// round places an omni AP (default range) at whichever candidate position of
// a sparser grid covers the most still-uncovered samples, until the target
// fraction or the AP limit is reached. Not optimal (set cover is NP-hard),
// fast enough for real floors. Pure — returns positions; the caller adds APs.

import { AP_PATTERNS } from './constants.js';
import { bandLossMultiplier, dbmAt } from './geometry.js';

/**
 * @param {{w:number, h:number, walls:any[], existing:any[], r:number, target?:number, maxAps?:number}} p
 *   w,h: floor image size in px; r: the new APs' radius in px.
 * @returns {{placed:Array<{fx:number,fy:number}>, coveredFrac:number}}
 */
export function planApPlacement({ w, h, walls, existing, r, target = 0.92, maxAps = 12 }) {
  const step = Math.max(6, Math.round(Math.min(w, h) / 80));
  const samples = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) samples.push({ x, y, covered: false });
  for (const ap of existing) {
    const pat = AP_PATTERNS[ap.pattern] || AP_PATTERNS.omni;
    const bf = bandLossMultiplier(ap.freq);
    for (const s of samples) {
      if (s.covered) continue;
      if (dbmAt(ap, s.x, s.y, w, h, walls, { bandFactor: bf, arcDeg: pat.arc, headingDeg: ap.heading || 0 }) !== null) s.covered = true;
    }
  }
  const candStep = Math.max(step * 2, Math.round(Math.min(w, h) / 30));
  const candidates = [];
  for (let y = candStep / 2; y < h; y += candStep) for (let x = candStep / 2; x < w; x += candStep) candidates.push({ x, y, used: false });
  // A candidate is scored as an omni AP at the default range.
  const covers = (cx, cy) => {
    const fakeAp = { fx: cx / w, fy: cy / h, r, freq: '2.4 / 5 GHz', pattern: 'omni', heading: 0 };
    const out = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.covered || Math.hypot(s.x - cx, s.y - cy) > r) continue;   // cheap check before dbmAt
      if (dbmAt(fakeAp, s.x, s.y, w, h, walls, { bandFactor: 0.6 }) !== null) out.push(i);
    }
    return out;
  };
  let covered = samples.filter((s) => s.covered).length;
  const placed = [];
  while (placed.length < maxAps && covered / samples.length < target) {
    let best = -1, bestGain = -1, bestCovers = [];
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].used) continue;
      const c = covers(candidates[i].x, candidates[i].y);
      if (c.length > bestGain) { bestGain = c.length; best = i; bestCovers = c; }
    }
    if (best < 0 || bestGain <= 0) break;
    candidates[best].used = true;
    for (const i of bestCovers) samples[i].covered = true;
    covered += bestCovers.length;
    placed.push({ fx: candidates[best].x / w, fy: candidates[best].y / h });
  }
  return { placed, coveredFrac: samples.length ? covered / samples.length : 1 };
}
