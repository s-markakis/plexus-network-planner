// Heatmap grid computation, shared by the Web Worker (heatmapWorker.js) and
// the synchronous fallback in app.js. Pure data in → Int16Array of colour-stop
// indices out, so it can run off the main thread and be unit-tested headless.
//
// A "job" is a plain serializable object:
//   {
//     w, h        image pixel size
//     step        cell size in px
//     metric      'dbm' | 'snr' | 'mcs' | 'mbps' | 'sinr'
//     aps         [{fx,fy,r,freq,band,channel,widthMhz,arcDeg,headingDeg,
//                   eirpDbm,bandFactor}]      — this floor's APs
//     neighbour   same shape                   — APs on adjacent floors
//     walls       [{fx1,fy1,fx2,fy2,material}]
//     propModel   propagation model key
//     slabDb      floor-slab attenuation (dB)
//     noiseFloorDbm  project noise floor at 20 MHz
//     metersPerPx real-world scale (0/undefined → per-radius heuristic)
//     stops       [{v}] colour stops, strongest threshold first
//   }

import {
  dbmAt, snrAt, mbpsAt, mcsFromSnr, dbmAtThroughSlab,
  sinrWithWidthNoise, noiseFloorForWidth,
} from './geometry.js';

function apOpts(ap, job) {
  return {
    bandFactor: ap.bandFactor,
    arcDeg: ap.arcDeg, headingDeg: ap.headingDeg || 0,
    eirpDbm: ap.eirpDbm,
    noiseFloorDbm: job.noiseFloorDbm,
    chanWidthMhz: ap.widthMhz,
    model: job.propModel,
    metersPerPx: job.metersPerPx,
  };
}

// Best (strongest) value of `metric` at image point (x,y). Mirrors the RF
// pipeline in geometry.js; neighbour-floor APs come in through the slab.
// Returns null when nothing reaches the point.
export function bestMetricAt(metric, x, y, job) {
  const { w, h, walls } = job;
  if (metric === 'sinr') {
    // SINR needs every reaching AP, not just the strongest.
    const contribs = [];
    for (const ap of job.aps) {
      const dbm = dbmAt(ap, x, y, w, h, walls, apOpts(ap, job));
      if (dbm !== null) contribs.push({ dbm, band: ap.band, channel: ap.channel, widthMhz: ap.widthMhz });
    }
    for (const ap of job.neighbour) {
      const dbm = dbmAtThroughSlab(ap, x, y, w, h, job.slabDb, ap.bandFactor, job.propModel, job.metersPerPx, ap.slabs, ap.verticalM);
      if (dbm !== null) contribs.push({ dbm, band: ap.band, channel: ap.channel, widthMhz: ap.widthMhz });
    }
    return sinrWithWidthNoise(contribs, job.noiseFloorDbm);
  }
  let best = -Infinity;
  for (const ap of job.aps) {
    const opts = apOpts(ap, job);
    let v = null;
    if (metric === 'dbm') v = dbmAt(ap, x, y, w, h, walls, opts);
    else if (metric === 'snr') v = snrAt(ap, x, y, w, h, walls, opts);
    else if (metric === 'mcs') {
      const snr = snrAt(ap, x, y, w, h, walls, opts);
      v = snr === null ? null : mcsFromSnr(snr);
    } else if (metric === 'mbps') v = mbpsAt(ap, x, y, w, h, walls, opts);
    if (v !== null && Number.isFinite(v) && v > best) best = v;
  }
  for (const ap of job.neighbour) {
    const dbm = dbmAtThroughSlab(ap, x, y, w, h, job.slabDb, ap.bandFactor, job.propModel, job.metersPerPx, ap.slabs, ap.verticalM);
    if (dbm === null) continue;
    const nf = noiseFloorForWidth(job.noiseFloorDbm, ap.widthMhz);
    let v = null;
    if (metric === 'dbm') v = dbm;
    else if (metric === 'snr') v = dbm - nf;
    else if (metric === 'mcs') v = mcsFromSnr(dbm - nf);
    else if (metric === 'mbps') {
      // Rough proxy: scale the MCS index to approximate a multi-stream link.
      const m = mcsFromSnr(dbm - nf);
      v = m < 0 ? 0 : m * 8;
    }
    if (v !== null && Number.isFinite(v) && v > best) best = v;
  }
  return best === -Infinity ? null : best;
}

// Compute the whole grid: one Int16 per cell, holding the index of the first
// colour stop the cell's value meets, or -1 for "paint nothing".
export function computeHeatGrid(job) {
  const cols = Math.ceil(job.w / job.step), rows = Math.ceil(job.h / job.step);
  const out = new Int16Array(cols * rows).fill(-1);
  const stops = job.stops;
  for (let gy = 0; gy < rows; gy++) {
    const y = gy * job.step;
    for (let gx = 0; gx < cols; gx++) {
      const v = bestMetricAt(job.metric, gx * job.step, y, job);
      if (v === null || !Number.isFinite(v)) continue;
      for (let i = 0; i < stops.length; i++) {
        if (v >= stops[i].v) { out[gy * cols + gx] = i; break; }
      }
    }
  }
  return { grid: out, cols, rows };
}
