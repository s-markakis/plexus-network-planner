// Channel helpers shared by the overlap overlay and the heatmap job. Pure.

import { AP_PATTERNS } from './constants.js';
import { bandKey, channelsOverlapMhz, CHANNEL_WIDTHS, effectiveEirp, bandLossMultiplier } from './geometry.js';

/** Loose channel parse: "6", "ch6" → 6; "auto", "" → null. */
export function parseChannel(c) {
  if (!c || c === 'auto') return null;
  const m = String(c).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Do two APs' occupied frequency ranges intersect (band- and width-aware)?
 * False when either channel is 'auto'/unparsable.
 */
export function apChansOverlap(a, b) {
  const ai = parseChannel(a.channel), bi = parseChannel(b.channel);
  if (ai == null || bi == null) return false;
  return channelsOverlapMhz(bandKey(a.freq), ai, a.chanWidth || 20, bandKey(b.freq), bi, b.chanWidth || 20);
}

/** Does an AP radiate in the heatmap's band filter ('all' | '2.4' | '5' | '6')? */
export function bandMatches(ap, bandFilter) {
  if (bandFilter === 'all' || !bandFilter) return true;
  const f = ap.freq || '';
  if (bandFilter === '2.4') return f.indexOf('2.4') >= 0;
  if (bandFilter === '5') return f === '5 GHz only' || f === '2.4 / 5 GHz';
  if (bandFilter === '6') return f.indexOf('6 GHz') >= 0;
  return true;
}

/** An AP as the plain, structured-cloneable shape the heatmap worker needs. */
export function heatApShape(ap) {
  const pat = AP_PATTERNS[ap.pattern] || AP_PATTERNS.omni;
  return {
    fx: ap.fx, fy: ap.fy, r: ap.r, freq: ap.freq,
    band: bandKey(ap.freq),
    channel: parseChannel(ap.channel),
    widthMhz: CHANNEL_WIDTHS.includes(ap.chanWidth) ? ap.chanWidth : 20,
    arcDeg: pat.arc, headingDeg: ap.heading || 0,
    eirpDbm: effectiveEirp(ap),
    bandFactor: bandLossMultiplier(ap.freq),
  };
}
