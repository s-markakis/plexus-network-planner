// Camera optics + storage math: IEC 62676-4 DORI pixel-density bands and a
// recording-storage estimator. Pure functions — no DOM, no app globals — so
// the thresholds and the geometry are unit-testable.

// Horizontal pixel count per resolution label used in the camera catalog.
// Approximate for MP-labelled sensors (real aspect ratios vary slightly).
export const CAM_RES_HPX = {
  '720p': 1280,
  '1080p': 1920,
  '2MP': 1920,
  '4MP': 2560,
  '5MP': 2880,
  '6MP': 3072,
  '8MP': 3840,
  '4K': 3840,
  '12MP': 4000,
};

// IEC 62676-4 operational requirement tiers, in pixels-per-metre at the
// target. Order matters: strongest (nearest) first, mirroring how the bands
// nest inside the FoV cone.
export const DORI_LEVELS = [
  { key: 'identify',  ppm: 250, label: 'Identify',  color: '#1e7d3c' },
  { key: 'recognize', ppm: 125, label: 'Recognize', color: '#76b542' },
  { key: 'observe',   ppm: 63,  label: 'Observe',   color: '#e7b40e' },
  { key: 'detect',    ppm: 25,  label: 'Detect',    color: '#e07b22' },
];

// Pixel density (px/m) at distance dM for a camera with `hpx` horizontal
// pixels spread across `fovDeg` degrees: the image width at distance d is
// 2·d·tan(fov/2) metres, so ppm = hpx / that. Fisheye/360° cameras are
// clamped to a hemisphere-ish 179° — beyond that the planar model is
// meaningless anyway.
/**
 * @param {number} hpx
 * @param {number} fovDeg
 * @param {number} dM
 * @returns {number}
 */
export function ppmAt(hpx, fovDeg, dM) {
  const half = (Math.min(179, Math.max(1, fovDeg)) / 2) * (Math.PI / 180);
  if (!(dM > 0)) return Infinity;
  return hpx / (2 * dM * Math.tan(half));
}

// Max distance (m) for each DORI tier, for a camera resolution + FoV.
// Returns [{key,ppm,label,color,m}] strongest tier first.
/**
 * @param {string} resKey  Resolution label, e.g. '4MP'.
 * @param {number} fovDeg
 * @returns {Array<{key:string,ppm:number,label:string,color:string,m:number}>}
 */
export function doriDistancesM(resKey, fovDeg) {
  const hpx = CAM_RES_HPX[resKey] ?? 1920;
  const half = (Math.min(179, Math.max(1, fovDeg)) / 2) * (Math.PI / 180);
  const ppmTimesD = hpx / (2 * Math.tan(half));   // ppm(d) · d is constant
  return DORI_LEVELS.map((l) => ({ ...l, m: ppmTimesD / l.ppm }));
}

// Typical continuous-recording bitrate (Mbps) by resolution, H.264 baseline
// at mainstream frame rates. H.265 saves ~40%. A per-camera override (>0)
// wins over the table.
const H264_MBPS = {
  '720p': 1, '1080p': 2, '2MP': 2, '4MP': 4, '5MP': 5,
  '6MP': 6, '8MP': 8, '4K': 8, '12MP': 12,
};
/**
 * @param {string} resKey
 * @param {('h264'|'h265')=} codec
 * @param {number=} overrideMbps  Per-camera override; used when > 0.
 * @returns {number}
 */
export function cameraBitrateMbps(resKey, codec, overrideMbps) {
  if (overrideMbps != null && overrideMbps > 0) return overrideMbps;
  const base = H264_MBPS[resKey] ?? 4;
  return codec === 'h265' ? +(base * 0.6).toFixed(2) : base;
}

// Continuous-recording storage for one stream: Mbps → GB (decimal, like
// drive vendors label them) over `days` of retention.
/**
 * @param {number} bitrateMbps
 * @param {number} days
 * @returns {number} gigabytes
 */
export function storageGb(bitrateMbps, days) {
  if (!(bitrateMbps > 0) || !(days > 0)) return 0;
  return (bitrateMbps / 8) * 86400 * days / 1000;
}
