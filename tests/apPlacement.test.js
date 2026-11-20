import { describe, it, expect } from 'vitest';
import { planApPlacement } from '../files/src/apPlacement.js';
import { AP_PATTERNS } from '../files/src/constants.js';
import { bandLossMultiplier, dbmAt } from '../files/src/geometry.js';

// The algorithm as it was inside app.js, kept as the reference.
function reference(w, h, walls, existing, r) {
  const step = Math.max(6, Math.round(Math.min(w, h) / 80));
  const samples = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) samples.push({ x, y, covered: false });
  for (const ap of existing) {
    const pat = AP_PATTERNS[ap.pattern] || AP_PATTERNS.omni; const bf = bandLossMultiplier(ap.freq);
    for (const s of samples) { if (s.covered) continue; const d = dbmAt(ap, s.x, s.y, w, h, walls, { bandFactor: bf, arcDeg: pat.arc, headingDeg: ap.heading || 0 }); if (d !== null) s.covered = true; }
  }
  const candStep = Math.max(step * 2, Math.round(Math.min(w, h) / 30));
  /** @type {any[]} */ const candidates = [];
  for (let y = candStep / 2; y < h; y += candStep) for (let x = candStep / 2; x < w; x += candStep) candidates.push({ x, y });
  const placed = []; const TARGET = 0.92, MAX_APS = 12;
  const candidateCovers = (cx, cy) => {
    const fakeAp = { fx: cx / w, fy: cy / h, r, freq: '2.4 / 5 GHz', pattern: 'omni', heading: 0 }; const out = [];
    for (let i = 0; i < samples.length; i++) { const s = samples[i]; if (s.covered) continue; if (Math.hypot(s.x - cx, s.y - cy) > r) continue; const d = dbmAt(fakeAp, s.x, s.y, w, h, walls, { bandFactor: 0.6 }); if (d !== null) out.push(i); }
    return out;
  };
  const coveredCount = () => { let n = 0; for (const s of samples) if (s.covered) n++; return n; };
  while (placed.length < MAX_APS && coveredCount() / samples.length < TARGET) {
    let bestIdx = -1, bestGain = -1, bestCovers = null;
    for (let i = 0; i < candidates.length; i++) { const c = candidates[i]; if (c.used) continue; const covers = candidateCovers(c.x, c.y); if (covers.length > bestGain) { bestGain = covers.length; bestIdx = i; bestCovers = covers; } }
    if (bestIdx < 0 || bestGain <= 0) break;
    candidates[bestIdx].used = true; for (const i of bestCovers) samples[i].covered = true;
    placed.push({ fx: candidates[bestIdx].x / w, fy: candidates[bestIdx].y / h });
  }
  return { placed, coveredFrac: coveredCount() / samples.length };
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const MATS = ['drywall', 'concrete', 'glass', 'brick'];
function floor(seed) {
  const R = rng(seed);
  const w = 160 + Math.floor(R() * 120), h = 120 + Math.floor(R() * 100);
  const walls = Array.from({ length: Math.floor(R() * 8) }, () => ({ fx1: R(), fy1: R(), fx2: R(), fy2: R(), material: MATS[Math.floor(R() * 4)] }));
  const existing = Array.from({ length: Math.floor(R() * 3) }, () => ({ fx: R(), fy: R(), r: 20 + R() * 60, freq: R() < 0.5 ? '2.4 / 5 GHz' : '5 GHz only', pattern: R() < 0.3 ? 'sector-90' : 'omni', heading: Math.floor(R() * 360) }));
  return { w, h, walls, existing, r: 25 + R() * 50 };
}

describe('planApPlacement', () => {
  it('matches the in-app algorithm exactly on 40 random floors', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const f = floor(seed);
      const want = reference(f.w, f.h, f.walls, f.existing, f.r);
      const got = planApPlacement(f);
      expect(got, `seed ${seed}`).toEqual(want);
    }
  });
  it('places nothing when the floor is already covered, and respects the AP limit', () => {
    expect(planApPlacement({ w: 200, h: 200, walls: [], existing: [{ fx: 0.5, fy: 0.5, r: 400, freq: '5 GHz only' }], r: 50 }).placed).toEqual([]);
    expect(planApPlacement({ w: 400, h: 400, walls: [], existing: [], r: 10, maxAps: 3 }).placed).toHaveLength(3);
  });
});
