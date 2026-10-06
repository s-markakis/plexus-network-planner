// Wireless association for the packet tracer — the bridge that makes Plexus's RF
// model drive the network sim. A wireless client at a map position associates to
// the AP with the strongest received signal (wall-aware, via geometry.dbmAt),
// then joins that AP's VLAN in the simulated L2/L3 topology. Packet Tracer has no
// real RF; Plexus does, so a laptop dropped on the plan lands on the right SSID/
// VLAN by actual signal, not a manual cable.
//
// Pure: takes plain AP/wall data + image dimensions; no DOM.

import { dbmAt, bandLossMultiplier } from './geometry.js';

/**
 * Pick the best-signal AP for a client at its fractional position.
 * @param {{fx:number, fy:number}} client
 * @param {Array<any>} aps      APs on the floor ({fx,fy,r,freq,...})
 * @param {Array<any>} walls    floor WALLS (fractional coords)
 * @param {number} imgW @param {number} imgH   floor image pixel size
 * @param {{model?:string, metersPerPx?:number}} [opts]
 * @returns {{ap:any, dbm:number}|null} strongest AP + its RSSI, or null if none reach
 */
export function bestAp(client, aps, walls, imgW, imgH, opts = {}) {
  if (!client || !Number.isFinite(client.fx) || !Number.isFinite(client.fy)) return null;
  const sx = client.fx * imgW;
  const sy = client.fy * imgH;
  let best = null;
  for (const ap of aps || []) {
    if (!ap || !Number.isFinite(ap.fx) || !Number.isFinite(ap.fy) || !ap.r) continue;
    const o = { bandFactor: bandLossMultiplier(ap.freq) };
    if (opts.model) o.model = opts.model;
    if (Number.isFinite(opts.metersPerPx) && opts.metersPerPx > 0) o.metersPerPx = opts.metersPerPx;
    const dbm = dbmAt(ap, sx, sy, imgW, imgH, walls || [], o);
    if (dbm == null) continue;
    if (!best || dbm > best.dbm) best = { ap, dbm };
  }
  return best;
}
