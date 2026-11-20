// Read-only views of the plan used all over the app: switch PoE/port
// analysis, the switch uplink tree, device listings and building-wide
// rollups. Pure — they take the floors (and settings) explicitly.

import { AP_POE_W, CAM_SPECS, DEVICE_STATUSES, swPortCount, swPoeClass, poeClassForWatts } from './constants.js';
import { analyzeLoad } from './network.js';
import { storageGb, cameraBitrateMbps } from './cameras.js';

/** PoE draw of an AP model; unknown models are assumed to draw 10 W. */
export const apPoeW = (model) => AP_POE_W[model] || 10;
/** PoE draw of a camera model; 0 when unknown. */
export const camPoeW = (model) => (CAM_SPECS[model] || {}).poeW || 0;

/** The APs and cameras cabled to a switch, with their PoE draw and class. */
export function switchClients(sw, floor) {
  const out = [];
  for (const ap of floor.APS || []) if (ap.swId === sw.id) { const w = apPoeW(ap.model); out.push({ dev: ap, type: 'AP', name: ap.name, model: ap.model, w, cls: poeClassForWatts(w), port: ap.port, ip: ap.ip }); }
  for (const c of floor.CAMS || []) if (c.swId === sw.id) { const w = camPoeW(c.model); out.push({ dev: c, type: 'CAM', name: c.name, model: c.model, w, cls: poeClassForWatts(w), port: c.port, ip: c.ip }); }
  return out;
}

/** Full PoE / port / class picture for one switch. ports null = unknown. */
export function analyzeSwitch(sw, floor) {
  const clients = switchClients(sw, floor);
  const budget = sw.poeBudget || 0;
  const ports = sw.ports || swPortCount(sw.model);
  const swCls = swPoeClass(sw.model, budget);
  return { sw, clients, budget, ports, swCls, ...analyzeLoad(clients, { budget, ports, swCls }) };
}

/** Building-wide switch uplink tree: roots plus children per switch id. */
export function topologyModel(floors) {
  /** @type {Array<{sw:any, floor:any, floorIdx:number}>} */
  const all = [];
  floors.forEach((f, i) => (f.SWS || []).forEach((sw) => all.push({ sw, floor: f, floorIdx: i })));
  const byId = new Map(all.map((e) => [e.sw.id, e]));
  /** @type {Map<string, typeof all>} */
  const children = new Map(all.map((e) => [e.sw.id, []]));
  const roots = [];
  for (const e of all) {
    const up = e.sw.uplinkId;
    if (up && byId.has(up) && up !== e.sw.id) /** @type {any} */ (children.get(up)).push(e);
    else roots.push(e);
  }
  return { all, byId, children, roots };
}

/** A switch by id on any floor, or null. */
export function findSwitchAnywhere(floors, id) {
  if (!id) return null;
  for (let i = 0; i < floors.length; i++) {
    const sw = (floors[i].SWS || []).find((s) => s.id === id);
    if (sw) return { sw, floor: floors[i], floorIdx: i };
  }
  return null;
}

/** Every AP, camera and switch, with its type and floor. */
export function allDevices(floors) {
  const out = [];
  floors.forEach((f, floorIdx) => {
    for (const dev of f.APS || []) out.push({ dev, type: 'AP', floor: f, floorIdx });
    for (const dev of f.CAMS || []) out.push({ dev, type: 'CAM', floor: f, floorIdx });
    for (const dev of f.SWS || []) out.push({ dev, type: 'SW', floor: f, floorIdx });
  });
  return out;
}

/** Devices per install status. */
export function deviceStatusCounts(floors) {
  const counts = Object.fromEntries(DEVICE_STATUSES.map((s) => [s, 0]));
  for (const { dev } of allDevices(floors)) counts[dev.status || 'planned']++;
  return counts;
}

/** Sum of the APs' client capacity (25 when unset). */
export function totalClientCapacity(floors) {
  let n = 0;
  for (const f of floors) for (const ap of f.APS || []) n += ap.capacityClients || 25;
  return n;
}

/**
 * Every device→switch run (same floor), metres incl. 10 % slack (min 1 m).
 * @param {any[]} floors @param {(dev:any, sw:any, floor:any)=>number} runM
 */
export function cableTotals(floors, runM) {
  let runs = 0, totalM = 0;
  for (const f of floors) {
    const sws = f.SWS || [];
    const add = (dev) => {
      if (!dev.swId) return;
      const sw = sws.find((s) => s.id === dev.swId); if (!sw) return;
      const m = runM(dev, sw, f);
      runs++; totalM += m + Math.max(1, m * 0.1);
    };
    (f.APS || []).forEach(add); (f.CAMS || []).forEach(add);
  }
  return { runs, totalM: Math.round(totalM) };
}

/** NVR storage (GB) for every camera at the configured retention/codec. */
export function totalStorageGb(floors, settings) {
  const days = parseInt(settings.retentionDays, 10) || 30;
  let gb = 0;
  for (const f of floors) for (const c of f.CAMS || []) gb += storageGb(cameraBitrateMbps(c.resolution || '4K', settings.storageCodec, c.bitrateMbps), days);
  return gb;
}
