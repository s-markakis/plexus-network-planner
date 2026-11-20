// Ekahau project (.esx) interop — best-effort import and export.
//
// An .esx is a zip of JSON documents (floorPlans.json, wallPoints.json,
// wallSegments.json, wallTypes.json, accessPoints.json, simulatedRadios.json,
// …) plus image blobs named `image-<id>`. The schema is undocumented and
// shifts between Ekahau versions, so import is defensive: unknown fields are
// ignored, missing files degrade gracefully, and only geometry we can map
// (floors, walls, AP positions/names, channels/tx from simulated radios) is
// carried over. Export writes the same minimal document set.

import { zipRead, zipStore } from './zip.js';

// Map an Ekahau wall type to our material keys, by name keyword first and
// per-traversal attenuation (dB) as the fallback.
/**
 * @param {{name?:string, propagationProperties?:Array<{attenuationFactor?:number}>}} wt
 * @returns {string}
 */
export function materialForWallType(wt) {
  const name = ((wt && wt.name) || '').toLowerCase();
  if (/concrete|masonry heavy|elevator/.test(name)) return 'concrete';
  if (/brick|stone|block/.test(name)) return 'brick';
  if (/glass|window/.test(name)) return 'glass';
  if (/wood|door|timber/.test(name)) return 'wood';
  if (/dry\s*wall|drywall|interior|partition|plaster/.test(name)) return 'drywall';
  const att = wt && Array.isArray(wt.propagationProperties) && wt.propagationProperties.length
    ? Number(wt.propagationProperties[0].attenuationFactor)
    : NaN;
  if (Number.isFinite(att)) {
    if (att >= 12) return 'concrete';
    if (att >= 8) return 'brick';
    if (att >= 5.5) return 'glass';
    if (att >= 4) return 'wood';
  }
  return 'drywall';
}

const dec = new TextDecoder();
const parseEntry = (byName, name) => {
  const e = byName.get(name);
  if (!e) return null;
  try { return JSON.parse(dec.decode(e.data)); } catch { return null; }
};

/**
 * Parse an .esx archive.
 * @param {Uint8Array} bytes
 * @returns {Promise<{floors:Array<{
 *   name:string, imgW:number, imgH:number, scaleM:number|null,
 *   imageBytes:Uint8Array|null,
 *   walls:Array<{fx1:number,fy1:number,fx2:number,fy2:number,material:string}>,
 *   aps:Array<{name:string,fx:number,fy:number,model:string,channel:string,txPowerDbm:number|null}>,
 * }>, warnings:string[]}>}
 */
export async function importEsx(bytes) {
  const entries = await zipRead(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const warnings = [];

  const floorPlans = (parseEntry(byName, 'floorPlans.json') || {}).floorPlans || [];
  if (!floorPlans.length) throw new Error('No floorPlans.json — not an Ekahau .esx?');
  const wallPoints = (parseEntry(byName, 'wallPoints.json') || {}).wallPoints || [];
  const wallSegments = (parseEntry(byName, 'wallSegments.json') || {}).wallSegments || [];
  const wallTypes = (parseEntry(byName, 'wallTypes.json') || {}).wallTypes || [];
  const accessPoints = (parseEntry(byName, 'accessPoints.json') || {}).accessPoints || [];
  const simulatedRadios = (parseEntry(byName, 'simulatedRadios.json') || {}).simulatedRadios || [];

  const ptById = new Map(wallPoints.map((p) => [p.id, p]));
  const typeById = new Map(wallTypes.map((t) => [t.id, t]));
  const radiosByAp = new Map();
  for (const r of simulatedRadios) {
    if (!radiosByAp.has(r.accessPointId)) radiosByAp.set(r.accessPointId, []);
    radiosByAp.get(r.accessPointId).push(r);
  }

  const floors = floorPlans.map((fp) => {
    const imgW = Number(fp.width) || 1000;
    const imgH = Number(fp.height) || 800;
    // metersPerUnit: metres per floor-plan pixel (newer esx). Our scaleM is
    // metres per 100 px.
    const mpu = Number(fp.metersPerUnit);
    const imgEntry = fp.imageId ? byName.get(`image-${fp.imageId}`) : null;
    return {
      _id: fp.id,
      name: fp.name || 'Imported floor',
      imgW, imgH,
      scaleM: Number.isFinite(mpu) && mpu > 0 ? mpu * 100 : null,
      imageBytes: imgEntry ? imgEntry.data : null,
      walls: [], aps: [],
    };
  });
  const floorByEsxId = new Map(floors.map((f) => [f._id, f]));

  let droppedWalls = 0;
  for (const seg of wallSegments) {
    const ids = Array.isArray(seg.wallPoints) ? seg.wallPoints : [];
    const a = ptById.get(ids[0]), b = ptById.get(ids[1]);
    const la = a && a.location, lb = b && b.location;
    if (!la || !lb || !la.coord || !lb.coord) { droppedWalls++; continue; }
    const fl = floorByEsxId.get(la.floorPlanId);
    if (!fl || la.floorPlanId !== lb.floorPlanId) { droppedWalls++; continue; }
    fl.walls.push({
      fx1: la.coord.x / fl.imgW, fy1: la.coord.y / fl.imgH,
      fx2: lb.coord.x / fl.imgW, fy2: lb.coord.y / fl.imgH,
      material: materialForWallType(typeById.get(seg.wallTypeId)),
    });
  }
  if (droppedWalls) warnings.push(`${droppedWalls} wall segment(s) had no usable geometry and were skipped.`);

  let droppedAps = 0;
  for (const ap of accessPoints) {
    const loc = ap.location;
    if (!loc || !loc.coord) { droppedAps++; continue; }
    const fl = floorByEsxId.get(loc.floorPlanId);
    if (!fl) { droppedAps++; continue; }
    let channel = 'auto', tx = null;
    for (const r of radiosByAp.get(ap.id) || []) {
      const ch = Array.isArray(r.channel) ? r.channel[0] : r.channel;
      if (channel === 'auto' && Number.isFinite(Number(ch))) channel = String(ch);
      if (tx === null && Number.isFinite(Number(r.transmitPower))) tx = Number(r.transmitPower);
    }
    fl.aps.push({
      name: ap.name || 'AP',
      fx: loc.coord.x / fl.imgW, fy: loc.coord.y / fl.imgH,
      model: [ap.vendor, ap.model].filter(Boolean).join(' ') || 'Custom/Other',
      channel, txPowerDbm: tx,
    });
  }
  if (droppedAps) warnings.push(`${droppedAps} access point(s) had no map position and were skipped.`);

  floors.forEach((f) => delete f._id);
  return { floors, warnings };
}

// Attenuation (dB per traversal at 5 GHz) for our materials — mirrors
// WALL_MATERIALS in geometry.js but kept literal here so this module stays
// dependency-free for export.
const EXPORT_WALL_TYPES = [
  { key: 'drywall', name: 'Dry wall', att: 3 },
  { key: 'wood', name: 'Wooden wall', att: 5 },
  { key: 'glass', name: 'Glass wall', att: 6 },
  { key: 'brick', name: 'Brick wall', att: 10 },
  { key: 'concrete', name: 'Concrete wall', att: 15 },
];

/**
 * Build the .esx file list (zip with zipStore afterwards) from project data.
 * @param {Array<{name:string,imgW:number,imgH:number,scaleM:number,
 *   imageBytes?:Uint8Array|null, imageExt?:string,
 *   walls:Array<{fx1:number,fy1:number,fx2:number,fy2:number,material?:string}>,
 *   aps:Array<{name?:string,fx:number,fy:number,model?:string,channel?:string,txPowerDbm?:number}>}>} floors
 * @param {{projectName?:string}=} opts
 * @returns {Array<{name:string,data:string|Uint8Array}>}
 */
export function buildEsx(floors, opts = {}) {
  let seq = 0;
  const uid = (p) => `${p}-${++seq}`;
  const files = [];

  const fpDocs = [], wallPointDocs = [], wallSegDocs = [], apDocs = [];
  const wallTypeDocs = EXPORT_WALL_TYPES.map((m) => ({
    id: uid('walltype'),
    name: m.name,
    propagationProperties: [{ band: 'FIVE', attenuationFactor: m.att, attenuationUnit: 'DB' }],
  }));
  const typeIdByKey = new Map(EXPORT_WALL_TYPES.map((m, i) => [m.key, wallTypeDocs[i].id]));

  for (const f of floors) {
    const fpId = uid('floorplan');
    let imageId = null;
    if (f.imageBytes && f.imageBytes.length) {
      imageId = uid('image');
      files.push({ name: `image-${imageId}`, data: f.imageBytes });
    }
    fpDocs.push({
      id: fpId, name: f.name || 'Floor',
      width: f.imgW || 1000, height: f.imgH || 800,
      imageId: imageId || undefined,
      metersPerUnit: (f.scaleM || 100) / 100,
    });
    for (const wl of f.walls || []) {
      const p1 = { id: uid('wallpoint'), location: { floorPlanId: fpId, coord: { x: wl.fx1 * f.imgW, y: wl.fy1 * f.imgH } } };
      const p2 = { id: uid('wallpoint'), location: { floorPlanId: fpId, coord: { x: wl.fx2 * f.imgW, y: wl.fy2 * f.imgH } } };
      wallPointDocs.push(p1, p2);
      wallSegDocs.push({
        id: uid('wallsegment'),
        wallPoints: [p1.id, p2.id],
        wallTypeId: typeIdByKey.get(wl.material || 'drywall') || /** @type {string} */ (typeIdByKey.get('drywall')),
        originType: 'WALL_TOOL',
      });
    }
    for (const ap of f.aps || []) {
      apDocs.push({
        id: uid('accesspoint'),
        name: ap.name || 'AP',
        location: { floorPlanId: fpId, coord: { x: ap.fx * f.imgW, y: ap.fy * f.imgH } },
        model: ap.model || '',
        vendor: '',
      });
    }
  }

  files.push(
    { name: 'project.json', data: JSON.stringify({ name: opts.projectName || 'Plexus export', title: opts.projectName || 'Plexus export' }) },
    { name: 'floorPlans.json', data: JSON.stringify({ floorPlans: fpDocs }) },
    { name: 'wallTypes.json', data: JSON.stringify({ wallTypes: wallTypeDocs }) },
    { name: 'wallPoints.json', data: JSON.stringify({ wallPoints: wallPointDocs }) },
    { name: 'wallSegments.json', data: JSON.stringify({ wallSegments: wallSegDocs }) },
    { name: 'accessPoints.json', data: JSON.stringify({ accessPoints: apDocs }) },
  );
  return files;
}

// Convenience: floors → zipped .esx bytes.
export function buildEsxZip(floors, opts) {
  return zipStore(buildEsx(floors, opts));
}
