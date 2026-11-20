// Pure geometry + RF helpers used by the renderer, the coverage sampler,

// Number.isFinite typed as a guard, so a checked field narrows to number.
const fin = /** @type {(v:unknown)=>v is number} */ (Number.isFinite);
// and the heatmap/SNR/throughput layers. Kept in their own ES module so they
// can be unit-tested in isolation (no DOM, no globals). app.js imports them
// as the single source of truth.

/**
 * @typedef {Object} APLike
 * @property {number=} fx     Fractional X position in [0,1].
 * @property {number=} fy     Fractional Y position in [0,1].
 * @property {number=} r      Effective radius in pixels (geometric reach).
 * @property {string=} freq  Band label, e.g. '2.4 / 5 GHz', '5 GHz only', '6 GHz (WiFi 6E)'.
 * @property {string=} pattern  Antenna pattern key ('omni', 'sector-30', etc.).
 * @property {number=} heading  Heading in degrees, 0 = east.
 * @property {number=} antennaGainDbi  Antenna gain (dBi). 0 if absent.
 * @property {number=} cableLossDb     Coax/connector loss between AP radio and antenna.
 * @property {number=} txPowerDbm      Conducted Tx power at the AP. 20 if absent.
 *
 * @typedef {Object} WallLike
 * @property {string=} material  Key into WALL_MATERIALS.
 * @property {number=} fx1 @property {number=} fy1 @property {number=} fx2 @property {number=} fy2
 * @property {number=} x1  @property {number=} y1  @property {number=} x2  @property {number=} y2
 *
 * @typedef {Object} RfOpts
 * @property {number=} rays
 * @property {number=} bandFactor
 * @property {number=} arcDeg     Half-width of the radiated arc in degrees. 180 = omni.
 * @property {number=} headingDeg
 * @property {number=} eirpDbm    EIRP override. If absent, derived from txPower+gain-cable.
 * @property {number=} noiseFloorDbm  Noise floor for SNR/MCS. Default -95 dBm.
 * @property {number=} chanWidthMhz  Channel width (20/40/80/160/320). Widens
 *                                  the noise floor and scales throughput.
 * @property {string=} model      Propagation model key (see PROPAGATION_MODELS).
 * @property {number=} metersPerPx  Real-world scale. When present and > 0, dBm is
 *                                  computed with physical path loss (FSPL at the
 *                                  band's frequency + model exponent + wall dB)
 *                                  instead of the per-radius heuristic.
 * @property {number=} freqMhz    Carrier frequency override for the physical model.
 */

// Wall-material attenuation table. `loss` is approximate signal attenuation
// in dB per traversal at 5 GHz (the baseline). Band-aware code multiplies
// this by a band factor (see BAND_LOSS).
export const WALL_MATERIALS={
  drywall:  {label:'Drywall',  loss:3,  strokeWidth:1.2},
  wood:     {label:'Wood',     loss:5,  strokeWidth:1.8},
  glass:    {label:'Glass',    loss:6,  strokeWidth:1,   dash:'2 2'},
  brick:    {label:'Brick',    loss:10, strokeWidth:2.4},
  concrete: {label:'Concrete', loss:15, strokeWidth:3.5},
};

// Band-loss multipliers applied to per-wall dB loss. 5 GHz is the baseline
// (1.0). 2.4 GHz penetrates better → less effective loss. 6 GHz (WiFi 6E)
// penetrates worse. Values are conservative real-world estimates.
export const BAND_LOSS={
  '2.4 GHz only':    0.6,
  '2.4 / 5 GHz':     0.6,
  '5 GHz only':      1.0,
  '6 GHz (WiFi 6E)': 1.3,
};
/**
 * @param {string=} freq
 * @returns {number}
 */
export function bandLossMultiplier(freq){
  return BAND_LOSS[freq]??1.0;
}

// Representative carrier frequency per band label, used by the physical
// path-loss model. Dual-band APs use the 2.4 GHz value to stay consistent
// with BAND_LOSS, which treats them as 2.4 GHz for wall penetration.
export const FREQ_MHZ={
  '2.4 GHz only':    2437,  // channel 6 centre
  '2.4 / 5 GHz':     2437,
  '5 GHz only':      5500,  // mid U-NII
  '6 GHz (WiFi 6E)': 6525,  // mid 6 GHz band
};
/**
 * @param {string=} freq
 * @returns {number}
 */
export function bandFreqMhz(freq){
  return FREQ_MHZ[freq]??5500;
}

// Propagation-model path-loss "exponent" in dB across one AP radius. Bigger
// values = signal decays faster with distance. Mirrors `PROPAGATION_MODELS`
// in constants.js but is kept here too so geometry.js stays DOM-/UI-free.
// Per-radius path-loss "exponent" (dB across one AP radius) per propagation
// model. Single source of truth — constants.js's PROPAGATION_MODELS imports
// these so the UI labels and the math can't drift apart.
export const PROP_EXPONENT={
  'logd':       25,
  'itu-indoor': 30,
  'multi-wall': 32,
};

// Physical path-loss exponents (n in 10·n·log10(d)) used when a real-world
// scale (metersPerPx) is supplied. Walls are always added explicitly on top,
// so these reflect *clutter between walls*, not wall penetration:
//  - logd:       lightly cluttered indoor line-of-sight (n ≈ 2.2)
//  - itu-indoor: ITU-R P.1238 office (power-loss coefficient N=30 → n = 3.0;
//                P.1238 folds light obstructions into the exponent)
//  - multi-wall: COST-231 multi-wall = pure free space (n = 2.0) + explicit
//                per-wall loss terms, which is exactly our wall model
export const PROP_N={
  'logd':       2.2,
  'itu-indoor': 3.0,
  'multi-wall': 2.0,
};

// Log-distance path loss in dB at distance dM metres and carrier fMhz MHz:
// FSPL(1 m) + 10·n·log10(d). FSPL(1 m) = 20·log10(f_MHz) − 27.55 (d in m).
// Distance is floored at 0.5 m to avoid the near-field singularity.
/**
 * @param {number} dM
 * @param {number} fMhz
 * @param {string=} modelKey
 * @returns {number}
 */
export function pathLossDb(dM,fMhz,modelKey){
  const n=PROP_N[modelKey??'logd']??PROP_N.logd;
  const d=Math.max(0.5,dM);
  return 20*Math.log10(fMhz)-27.55 + 10*n*Math.log10(d);
}
const DEFAULT_NOISE_FLOOR_DBM=-95;

// ── Channel widths ─────────────────────────────────────────────────────────
// Supported channel bandwidths (MHz). 320 MHz is WiFi 7 / 6 GHz only.
export const CHANNEL_WIDTHS=[20,40,80,160,320];

// Thermal noise scales with bandwidth: +3 dB per doubling over the 20 MHz
// baseline. `baseNf20` is the project noise floor measured at 20 MHz.
/**
 * @param {number} baseNf20
 * @param {number=} widthMhz
 * @returns {number}
 */
export function noiseFloorForWidth(baseNf20,widthMhz){
  const w=fin(widthMhz)&&CHANNEL_WIDTHS.includes(widthMhz)?widthMhz:20;
  return baseNf20+10*Math.log10(w/20);
}

// Throughput multiplier vs the 20 MHz MCS-table baseline. Ratios follow the
// OFDMA data-subcarrier counts (242 / 484 / 980 / 1960 / 3920 tones), not a
// naive 2x per doubling — wider channels waste proportionally fewer guards.
const WIDTH_TONES={20:242,40:484,80:980,160:1960,320:3920};
/**
 * @param {number=} widthMhz
 * @returns {number}
 */
export function widthThroughputMult(widthMhz){
  const w=fin(widthMhz)&&CHANNEL_WIDTHS.includes(widthMhz)?widthMhz:20;
  return WIDTH_TONES[w]/WIDTH_TONES[20];
}

// ── Channel geometry (centre frequency + occupied range) ──────────────────
// Band keys: '2.4' | '5' | '6' (see _bandForAp in app.js / bandKey below).
/**
 * @param {string=} freq  Band label like '5 GHz only'.
 * @returns {'2.4'|'5'|'6'}
 */
export function bandKey(freq){
  const f=freq||'';
  if(f.indexOf('6 GHz')>=0)return '6';
  if(f==='2.4 GHz only')return '2.4';
  return '5';
}
/**
 * Centre frequency (MHz) of a channel number on a band. Null if unparsable.
 * @param {'2.4'|'5'|'6'} band
 * @param {number} ch
 * @returns {number|null}
 */
export function channelCenterMhz(band,ch){
  if(!fin(ch))return null;
  if(band==='2.4')return ch===14?2484:2407+5*ch;
  if(band==='5')return 5000+5*ch;
  if(band==='6')return 5950+5*ch;
  return null;
}
/**
 * Occupied frequency range of (band, channel, width). Null if unparsable.
 * 2.4 GHz channels are treated as 20 MHz wide regardless of the width field
 * unless 40 is set explicitly (40 MHz on 2.4 GHz is legal but rude).
 * @returns {{lo:number,hi:number}|null}
 */
export function channelRangeMhz(band,ch,widthMhz){
  const c=channelCenterMhz(band,ch);
  if(c===null)return null;
  let w=CHANNEL_WIDTHS.includes(widthMhz)?widthMhz:20;
  if(band==='2.4'&&w>40)w=20;
  return {lo:c-w/2,hi:c+w/2};
}
/**
 * Do two (band, channel, width) tuples occupy overlapping spectrum?
 * Different bands never overlap. Unknown channels ('auto') → false.
 */
export function channelsOverlapMhz(bandA,chA,widthA,bandB,chB,widthB){
  if(bandA!==bandB)return false;
  const a=channelRangeMhz(bandA,chA,widthA);
  const b=channelRangeMhz(bandB,chB,widthB);
  if(!a||!b)return false;
  return a.lo<b.hi && b.lo<a.hi;
}

// ── SINR ───────────────────────────────────────────────────────────────────
// Given every AP's received power at a sample point, pick the strongest as
// the serving AP and fold co-channel neighbours into the interference term:
//   SINR = S − 10·log10(N_linear + ΣI_linear)
// `contribs`: [{dbm, band, channel, widthMhz}] for each AP that reaches the
// point. `noiseFloorDbm` should already be width-adjusted for the server.
// Returns null when nothing reaches the point.
/**
 * @param {Array<{dbm:number,band:string,channel:number|null,widthMhz:number}>} contribs
 * @param {number} noiseFloorDbm
 * @returns {number|null}
 */
export function sinrFromContributions(contribs,noiseFloorDbm){
  if(!contribs||!contribs.length)return null;
  let server=contribs[0];
  for(const c of contribs)if(c.dbm>server.dbm)server=c;
  let denomMw=Math.pow(10,noiseFloorDbm/10);
  for(const c of contribs){
    if(c===server)continue;
    if(!channelsOverlapMhz(server.band,server.channel,server.widthMhz,c.band,c.channel,c.widthMhz))continue;
    denomMw+=Math.pow(10,c.dbm/10);
  }
  return server.dbm-10*Math.log10(denomMw);
}

// SINR where the noise floor is width-adjusted for the *serving* AP's channel
// width. `baseNf20` is the project noise floor at 20 MHz.
/**
 * @param {Array<{dbm:number,band:string,channel:number|null,widthMhz:number}>} contribs
 * @param {number} baseNf20
 * @returns {number|null}
 */
export function sinrWithWidthNoise(contribs,baseNf20){
  if(!contribs||!contribs.length)return null;
  let server=contribs[0];
  for(const c of contribs)if(c.dbm>server.dbm)server=c;
  return sinrFromContributions(contribs,noiseFloorForWidth(baseNf20,server.widthMhz));
}

// 802.11ac/ax MCS minimum-SNR thresholds (dB) for a single spatial stream.
// Approximate; used to map SNR → MCS index → expected Mbps.
const MCS_SNR_TABLE=[
  {mcs:0, snr:5,  mbps:7.2},
  {mcs:1, snr:8,  mbps:14.4},
  {mcs:2, snr:11, mbps:21.7},
  {mcs:3, snr:14, mbps:28.9},
  {mcs:4, snr:18, mbps:43.3},
  {mcs:5, snr:22, mbps:57.8},
  {mcs:6, snr:25, mbps:65.0},
  {mcs:7, snr:28, mbps:72.2},
  {mcs:8, snr:31, mbps:86.7},
  {mcs:9, snr:34, mbps:96.3},
  {mcs:10,snr:37, mbps:108.3},
  {mcs:11,snr:41, mbps:120.4},
];
// Approximate spatial-stream multipliers per band. 5 GHz APs commonly have
// 2-4 streams; we average to 2.5x. 6 GHz adds 160 MHz BW + WiFi 7 → ~4x.
const BAND_STREAM_MULT={
  '2.4 GHz only':    1.2,
  '2.4 / 5 GHz':     2.5,
  '5 GHz only':      2.5,
  '6 GHz (WiFi 6E)': 4.0,
};

// Each 3 dB of loss roughly halves the usable range in that direction.
// Floored at 0.05 so a thick bunker wall still produces some coverage.
/**
 * @param {number} totalLossDb
 * @returns {number}
 */
export function attenuationFactor(totalLossDb){
  return Math.max(0.05, Math.pow(0.5, totalLossDb/3));
}

// Segment-segment intersection. Returns the parametric t along the ray
// (from a → b) where it hits the wall, or null if no hit within 0..1.
/**
 * @returns {number|null}
 */
export function rayWallIntersect(ax,ay, bx,by, wx1,wy1, wx2,wy2){
  const rdx=bx-ax, rdy=by-ay;
  const sdx=wx2-wx1, sdy=wy2-wy1;
  const denom=rdx*sdy - rdy*sdx;
  if(Math.abs(denom)<1e-9)return null;
  const t=((wx1-ax)*sdy - (wy1-ay)*sdx)/denom;
  const u=((wx1-ax)*rdy - (wy1-ay)*rdx)/denom;
  if(t<0||t>1||u<0||u>1)return null;
  return t;
}

// Resolve a wall to absolute pixel coords given image dimensions.
// Accepts both fractional (fx1/fy1/fx2/fy2) and legacy pixel (x1/y1/x2/y2) walls.
/**
 * @param {WallLike} w
 * @param {number} imgW
 * @param {number} imgH
 * @returns {{x1:number,y1:number,x2:number,y2:number}}
 */
export function wallToPx(w,imgW,imgH){
  if(fin(w.fx1)&&fin(w.fy1)&&fin(w.fx2)&&fin(w.fy2)){
    return {x1:w.fx1*imgW,y1:w.fy1*imgH,x2:w.fx2*imgW,y2:w.fy2*imgH};
  }
  return {x1:w.x1||0,y1:w.y1||0,x2:w.x2||0,y2:w.y2||0};
}

// Normalize an angle to [-180, 180].
function _angleDelta(a,b){
  let d=a-b;
  while(d>180)d-=360;
  while(d<-180)d+=360;
  return d;
}

// EIRP for an AP: conducted Tx power (dBm) + antenna gain (dBi) − cable/connector loss (dB).
// Defaults: txPower=20 dBm (a common conducted limit), gain=0, cableLoss=0.
/**
 * @param {APLike} ap
 * @returns {number}
 */
export function effectiveEirp(ap){
  const tx=fin(ap.txPowerDbm)?ap.txPowerDbm:20;
  const gain=fin(ap.antennaGainDbi)?ap.antennaGainDbi:0;
  const cable=fin(ap.cableLossDb)?ap.cableLossDb:0;
  return tx+gain-cable;
}

// Compute the polygon of reachable points around an AP considering walls.
// Returns an SVG path "d" string. Opts as documented at the top of the file.
/**
 * @param {APLike} ap
 * @param {number} imgW
 * @param {number} imgH
 * @param {WallLike[]} walls
 * @param {RfOpts|number=} opts
 * @returns {string}
 */
export function computeCoveragePath(ap,imgW,imgH,walls,opts){
  // Back-compat: callers used to pass `rays` as a number for the 5th arg.
  const rays=typeof opts==='number'?opts:(opts&&opts.rays)||72;
  const bandFactor=(opts&&typeof opts==='object'&&fin(opts.bandFactor))?opts.bandFactor:1;
  const arcDeg=(opts&&typeof opts==='object'&&typeof opts.arcDeg==='number')?opts.arcDeg:180;
  const headingDeg=(opts&&typeof opts==='object'&&typeof opts.headingDeg==='number')?opts.headingDeg:0;
  const directional=arcDeg<180;
  if(!imgW||!imgH)return 'M0,0Z';
  if(!fin(ap.fx)||!fin(ap.fy)||!fin(ap.r)||ap.r<=0)return 'M0,0Z';
  const cx=ap.fx*imgW, cy=ap.fy*imgH;
  const r=ap.r;
  const pxWalls=walls.map(w=>({...wallToPx(w,imgW,imgH),material:w.material}));
  const pts=[];
  for(let i=0;i<rays;i++){
    const angleDeg=(i/rays)*360;
    if(directional && Math.abs(_angleDelta(angleDeg,headingDeg))>arcDeg){
      const a=angleDeg*Math.PI/180;
      pts.push({x:cx+Math.cos(a)*r*0.02, y:cy+Math.sin(a)*r*0.02});
      continue;
    }
    const angle=angleDeg*Math.PI/180;
    const dx=Math.cos(angle), dy=Math.sin(angle);
    const ex=cx+dx*r, ey=cy+dy*r;
    const hits=[];
    for(const wall of pxWalls){
      const t=rayWallIntersect(cx,cy,ex,ey,wall.x1,wall.y1,wall.x2,wall.y2);
      if(t!==null){
        const mat=WALL_MATERIALS[wall.material]||WALL_MATERIALS.drywall;
        hits.push({t,loss:mat.loss*bandFactor});
      }
    }
    hits.sort((a,b)=>a.t-b.t);
    let reachT=1, cumLoss=0;
    for(const hit of hits){
      cumLoss+=hit.loss;
      const atten=attenuationFactor(cumLoss);
      const newReach=hit.t + (1-hit.t)*atten;
      if(newReach<reachT)reachT=newReach;
      if(reachT<=hit.t)break;
    }
    pts.push({x:cx+dx*r*reachT, y:cy+dy*r*reachT});
  }
  return 'M'+pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')+'Z';
}

// Estimate the signal strength in dBm at a sample point from a single AP.
// Returns null if the point is beyond the AP's effective range.
//
// Uses a configurable distance-only term: -PE * log10(r/d) where PE is the
// per-radius path-loss exponent (25 dB for log-distance, 30 for ITU indoor,
// 32 for multi-wall COST-231-like). EIRP-derived adjustments are added on top.
//
// Back-compat: the 7th positional arg may be a number (bandFactor).
/**
 * @param {APLike} ap
 * @param {number} sx
 * @param {number} sy
 * @param {number} imgW
 * @param {number} imgH
 * @param {WallLike[]} walls
 * @param {RfOpts|number=} opts
 * @returns {number|null}
 */
export function dbmAt(ap,sx,sy,imgW,imgH,walls,opts){
  const bf=typeof opts==='number'?opts:((opts&&opts.bandFactor)??1);
  const arcDeg=(opts&&typeof opts==='object'&&typeof opts.arcDeg==='number')?opts.arcDeg:180;
  const headingDeg=(opts&&typeof opts==='object'&&typeof opts.headingDeg==='number')?opts.headingDeg:0;
  const modelKey=(opts&&typeof opts==='object'&&typeof opts.model==='string')?opts.model:'logd';
  const pe=PROP_EXPONENT[modelKey]??PROP_EXPONENT.logd;
  const eirp=(opts&&typeof opts==='object'&&fin(opts.eirpDbm))?opts.eirpDbm:effectiveEirp(ap);
  // EIRP delta vs. the model baseline (logd assumes 20 dBm EIRP → -55 dBm at the
  // edge). Higher-PE models drop the edge value so larger PE = faster real-world
  // decay across the radius, not just a steeper near-field gradient.
  const eirpBoost=eirp-20;
  const edgeDbm=-55-(pe-25);
  // An AP without a position or radius covers nothing (instead of NaN dBm).
  if(!fin(ap.fx)||!fin(ap.fy)||!fin(ap.r))return null;
  const ax=ap.fx*imgW, ay=ap.fy*imgH;
  const dist=Math.hypot(sx-ax,sy-ay);
  if(dist>ap.r)return null;
  if(arcDeg<180){
    const angle=Math.atan2(sy-ay,sx-ax)*180/Math.PI;
    if(Math.abs(_angleDelta(angle,headingDeg))>arcDeg)return null;
  }
  let lossDb=0;
  for(const wl of walls){
    const px=wallToPx(wl,imgW,imgH);
    const t=rayWallIntersect(ax,ay,sx,sy,px.x1,px.y1,px.x2,px.y2);
    if(t!==null){
      const mat=WALL_MATERIALS[wl.material]||WALL_MATERIALS.drywall;
      lossDb+=mat.loss*bf;
    }
  }
  if(dist > ap.r*attenuationFactor(lossDb))return null;
  // Physical model: real FSPL at the band's carrier + model exponent + wall dB.
  // Activated by a metersPerPx scale; the per-radius heuristic remains the
  // fallback so unscaled projects keep their previous behaviour.
  const mpp=(opts&&typeof opts==='object'&&fin(opts.metersPerPx)&&opts.metersPerPx>0)?opts.metersPerPx:null;
  if(mpp){
    const fMhz=(opts&&typeof opts==='object'&&fin(opts.freqMhz))?opts.freqMhz:bandFreqMhz(ap.freq);
    return eirp - pathLossDb(dist*mpp,fMhz,modelKey) - lossDb;
  }
  const dRatio=Math.max(0.05,dist/ap.r);
  const fsLoss=pe*Math.log10(1/dRatio);
  return edgeDbm + fsLoss - lossDb + eirpBoost;
}

// SNR (dB) for a single AP at a sample point. Returns null when out of reach.
/**
 * @param {APLike} ap
 * @param {number} sx @param {number} sy
 * @param {number} imgW @param {number} imgH
 * @param {WallLike[]} walls
 * @param {RfOpts=} opts
 * @returns {number|null}
 */
export function snrAt(ap,sx,sy,imgW,imgH,walls,opts){
  const dbm=dbmAt(ap,sx,sy,imgW,imgH,walls,opts);
  if(dbm===null)return null;
  let nf=(opts&&fin(opts.noiseFloorDbm))?opts.noiseFloorDbm:DEFAULT_NOISE_FLOOR_DBM;
  // Wider channels admit more thermal noise (+3 dB per doubling vs 20 MHz).
  const cw=(opts&&typeof opts==='object')?opts.chanWidthMhz:undefined;
  if(fin(cw))nf=noiseFloorForWidth(nf,cw);
  return dbm-nf;
}

// SNR → MCS index. Returns -1 if below MCS 0 (i.e. link not usable).
/**
 * @param {number} snrDb
 * @returns {number}
 */
export function mcsFromSnr(snrDb){
  if(!fin(snrDb))return -1;
  let best=-1;
  for(const e of MCS_SNR_TABLE){
    if(snrDb>=e.snr)best=e.mcs;
  }
  return best;
}

// Approximate single-link throughput in Mbps. Uses the MCS row for the SNR,
// multiplied by a stream factor derived from the AP's band (2.4 ≈ 1.2x, 5 ≈ 2.5x,
// 6/WiFi 7 ≈ 4x). Returns 0 if no link.
/**
 * @param {APLike} ap
 * @param {number} sx @param {number} sy
 * @param {number} imgW @param {number} imgH
 * @param {WallLike[]} walls
 * @param {RfOpts=} opts
 * @returns {number}
 */
export function mbpsAt(ap,sx,sy,imgW,imgH,walls,opts){
  const snr=snrAt(ap,sx,sy,imgW,imgH,walls,opts);
  if(snr===null)return 0;
  let row=null;
  for(const e of MCS_SNR_TABLE){if(snr>=e.snr)row=e;}
  if(!row)return 0;
  const mult=BAND_STREAM_MULT[ap.freq]??2.0;
  // MCS table is the 20 MHz baseline; scale by the channel-width tone ratio.
  const cw=(opts&&typeof opts==='object')?opts.chanWidthMhz:undefined;
  const wMult=fin(cw)?widthThroughputMult(cw):1;
  return row.mbps*mult*wMult;
}

// Returns whether a sample point is reachable by an AP considering wall
// attenuation. Used by the coverage % sampler.
/**
 * @param {APLike} ap
 * @param {number} sx @param {number} sy
 * @param {number} imgW @param {number} imgH
 * @param {WallLike[]} walls
 * @param {number=} bandFactor
 * @param {number=} arcDeg      Half-width of the radiated arc (180/absent = omni).
 * @param {number=} headingDeg
 * @returns {boolean}
 */
export function coveredThroughWalls(ap,sx,sy,imgW,imgH,walls,bandFactor,arcDeg,headingDeg){
  const bf=bandFactor??1;
  if(!fin(ap.fx)||!fin(ap.fy)||!fin(ap.r))return false;
  const ax=ap.fx*imgW, ay=ap.fy*imgH;
  const dist=Math.hypot(sx-ax,sy-ay);
  if(dist>ap.r)return false;
  // Directional antennas only radiate inside their arc (same rule as dbmAt).
  if(fin(arcDeg)&&arcDeg<180){
    const angle=Math.atan2(sy-ay,sx-ax)*180/Math.PI;
    if(Math.abs(_angleDelta(angle,headingDeg||0))>arcDeg)return false;
  }
  if(!walls.length)return true;
  let lossDb=0;
  for(const wl of walls){
    const px=wallToPx(wl,imgW,imgH);
    const t=rayWallIntersect(ax,ay,sx,sy, px.x1,px.y1, px.x2,px.y2);
    if(t!==null){
      const mat=WALL_MATERIALS[wl.material]||WALL_MATERIALS.drywall;
      lossDb+=mat.loss*bf;
    }
  }
  return dist <= ap.r * attenuationFactor(lossDb);
}

// Sample a floor for coverage at a coarse grid; return {covered, total}.
/**
 * @param {{APS?:APLike[],WALLS?:WallLike[]}} floor
 * @param {number} imgW @param {number} imgH
 * @param {{arcOf?:(ap:APLike)=>number}=} opts  arcOf maps an AP to its antenna
 *   half-arc in degrees; without it every AP is treated as omni.
 * @returns {{covered:number,total:number}}
 */
export function sampleFloorCoverage(floor,imgW,imgH,opts){
  const arcOf=opts&&typeof opts.arcOf==='function'?opts.arcOf:null;
  const aps=floor.APS||[];
  if(!aps.length)return {covered:0,total:0};
  const walls=floor.WALLS||[];
  const w=imgW||1,h=imgH||1;
  const step=Math.max(4,Math.round(Math.min(w,h)/60));
  let total=0,covered=0;
  for(let x=0;x<w;x+=step)for(let y=0;y<h;y+=step){
    total++;
    if(aps.some(ap=>coveredThroughWalls(ap,x,y,w,h,walls,bandLossMultiplier(ap.freq),arcOf?arcOf(ap):undefined,ap.heading||0)))covered++;
  }
  return {covered,total};
}

// Sample a floor for roaming overlap: % of sample points where ≥2 APs deliver
// ≥ thresholdDbm. Returns {covered, total}.
/**
 * @param {{APS?:APLike[],WALLS?:WallLike[],scaleM?:number}} floor
 * @param {number} imgW @param {number} imgH
 * @param {number=} thresholdDbm
 * @param {{arcOf?:(ap:APLike)=>number}=} opts  see sampleFloorCoverage
 * @returns {{covered:number,total:number}}
 */
export function sampleRoamingOverlap(floor,imgW,imgH,thresholdDbm=-67,opts){
  const arcOf=opts&&typeof opts.arcOf==='function'?opts.arcOf:null;
  const aps=floor.APS||[];
  if(aps.length<2)return {covered:0,total:0};
  const walls=floor.WALLS||[];
  const w=imgW||1,h=imgH||1;
  // Use the floor's real-world scale (m per 100 px) when present so the
  // overlap stats agree with the physical heatmap.
  const mpp=(fin(floor.scaleM)&&floor.scaleM>0)?floor.scaleM/100:undefined;
  const step=Math.max(4,Math.round(Math.min(w,h)/60));
  let total=0,covered=0;
  for(let x=0;x<w;x+=step)for(let y=0;y<h;y+=step){
    total++;
    let n=0;
    for(const ap of aps){
      const d=dbmAt(ap,x,y,w,h,walls,{bandFactor:bandLossMultiplier(ap.freq),metersPerPx:mpp,arcDeg:arcOf?arcOf(ap):undefined,headingDeg:ap.heading||0});
      if(d!==null && d>=thresholdDbm){n++;if(n>=2)break;}
    }
    if(n>=2)covered++;
  }
  return {covered,total};
}

// Approximate floor-to-floor RF leakage: returns the EIRP-equivalent dBm
// contribution from an AP on a neighbouring floor at sample (sx,sy). Treats
// the slab as a single uniform attenuator; walls on the source floor are
// ignored (we don't have their position relative to this floor's sample).
/**
 * @param {APLike} ap
 * @param {number} sx @param {number} sy
 * @param {number} imgW @param {number} imgH
 * @param {number} slabDb  Slab attenuation in dB per slab traversed.
 * @param {number=} bandFactor
 * @param {string=} modelKey  Propagation model key.
 * @param {number=} metersPerPx  Real-world scale → physical path loss (see dbmAt).
 * @param {number=} slabs  Number of slabs between the AP's floor and this one
 *   (1 = the floor directly above/below). Each one costs `slabDb`.
 * @param {number=} verticalM  Vertical separation in metres. With a physical
 *   scale the path is the 3-D distance, so a point straight under an AP two
 *   floors up is ~6 m away, not 0. Ignored without `metersPerPx`.
 * @returns {number|null}
 */
export function dbmAtThroughSlab(ap,sx,sy,imgW,imgH,slabDb,bandFactor,modelKey,metersPerPx,slabs,verticalM){
  const bf=bandFactor??1;
  const pe=PROP_EXPONENT[modelKey||'logd']??PROP_EXPONENT.logd;
  const eirp=effectiveEirp(ap);
  const eirpBoost=eirp-20;
  const edgeDbm=-55-(pe-25);
  if(!fin(ap.fx)||!fin(ap.fy)||!fin(ap.r))return null;
  const ax=ap.fx*imgW, ay=ap.fy*imgH;
  const dist=Math.hypot(sx-ax,sy-ay);
  if(dist>ap.r)return null;
  const dRatio=Math.max(0.05,dist/ap.r);
  // Apply the slab loss as an extra attenuator multiplied by the band factor —
  // 2.4 GHz penetrates slabs better than 5 GHz, just like walls.
  const nSlabs=fin(slabs)&&slabs>=1?slabs:1;
  const effSlab=slabDb*bf*nSlabs;
  if(dist > ap.r*attenuationFactor(effSlab))return null;
  if(fin(metersPerPx)&&metersPerPx>0){
    const dz=fin(verticalM)&&verticalM>0?verticalM:0;
    return eirp - pathLossDb(Math.hypot(dist*metersPerPx,dz),bandFreqMhz(ap.freq),modelKey) - effSlab;
  }
  const fsLoss=pe*Math.log10(1/dRatio);
  return edgeDbm + fsLoss - effSlab + eirpBoost;
}
