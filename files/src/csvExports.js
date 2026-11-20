// The CSV deliverables: bill of materials, cable schedule, IP plan, port map
// and inventory. Pure — the caller supplies the plan plus the few measurements
// that need the live app (cable lengths, switch port analysis, storage). Each
// builder returns the CSV text, or '' when there is nothing to export (the BoM
// always has its header). The single-file downloads and the handover pack use
// the same builders.

import { apPoeW, camPoeW } from './planModel.js';
import { ipInCidr } from './network.js';

/** RFC 4180 field: quoted when it holds a quote, comma or newline. */
export function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
/** @param {Array<Array<any>>} rows */
export const toCsv = (rows) => rows.map((r) => r.map(csvEscape).join(',')).join('\n');
const orEmpty = (rows) => (rows.length <= 1 ? '' : toCsv(rows));

/**
 * @param {{floors:any[], cable:{runs:number,totalM:number}, cableBoxM?:any,
 *          storageGb:number, retentionDays?:any, storageCodec?:string}} p
 */
export function bomCsv({ floors, cable, cableBoxM, storageGb, retentionDays, storageCodec }) {
  /** @type {Map<string,{kind:string,model:string,qty:number,poeW:number}>} */
  const tally = new Map();
  const count = (key, kind, model, w) => {
    const e = tally.get(key) || { kind, model: model || 'Custom/Other', qty: 0, poeW: 0 };
    e.qty++; e.poeW += w;
    tally.set(key, e);
  };
  for (const f of floors) {
    // Same per-model draw as the PoE budget checks (unknown APs: 10 W).
    for (const ap of f.APS || []) count('AP|' + (ap.model || ''), 'AP', ap.model, apPoeW(ap.model));
    for (const c of f.CAMS || []) count('CAM|' + (c.model || ''), 'Camera', c.model, camPoeW(c.model));
    for (const sw of f.SWS || []) count('SW|' + (sw.model || ''), 'Switch', sw.model, 0);
  }
  /** @type {Array<Array<any>>} */
  const rows = [['Kind', 'Model', 'Qty', 'Total PoE draw (W)']];
  for (const e of tally.values()) rows.push([e.kind, e.model, e.qty, e.poeW || '']);
  // Cabling rollup: every device→switch run (routing factor + slack), and the
  // boxes of cable that takes.
  if (cable.runs > 0) {
    const boxM = parseFloat(cableBoxM) || 305;
    rows.push([], ['Cabling', 'Ethernet runs', cable.runs, ''], ['Cabling', 'Cable length incl. slack (m)', cable.totalM, ''],
      ['Cabling', `Cable boxes (${boxM} m)`, Math.ceil(cable.totalM / boxM), '']);
  }
  // NVR storage for the camera fleet at the configured retention/codec.
  if (storageGb > 0) {
    const days = parseInt(retentionDays, 10) || 30;
    const codec = storageCodec === 'h264' ? 'H.264' : 'H.265';
    rows.push([], ['Storage', `NVR capacity for ${days} d retention (${codec})`,
      storageGb >= 1000 ? (storageGb / 1000).toFixed(2) + ' TB' : Math.round(storageGb) + ' GB', '']);
  }
  return toCsv(rows);
}

/**
 * One row per AP/camera cabled to a switch on its own floor.
 * @param {{floors:any[], runM:(dev:any, sw:any, floor:any)=>number}} p  runM: metres, routing factor included
 */
export function cableScheduleCsv({ floors, runM }) {
  const rows = [['Floor', 'Device', 'Type', 'Switch', 'Port', 'Length (m)', 'Slack (m)', 'Status']];
  for (const f of floors) {
    const sws = f.SWS || [];
    const add = (dev, type) => {
      const sw = sws.find((s) => s.id === dev.swId);
      if (!sw) return;
      const m = Math.round(runM(dev, sw, f) * 10) / 10;
      const slack = Math.max(1, Math.round(m * 0.1 * 10) / 10);
      const status = m > 100 ? 'OVER 100m' : m > 90 ? 'Near limit' : 'OK';
      rows.push([f.name || '', dev.name || dev.id, type, sw.name || sw.id, dev.port || '', m, slack, status]);
    };
    for (const ap of f.APS || []) add(ap, 'AP');
    for (const cam of f.CAMS || []) add(cam, 'Camera');
  }
  return orEmpty(rows);
}

/**
 * One row per device with any network identity.
 * @param {{devices:Array<{dev:any,type:string,floor:any}>, vlanById:(id:any)=>any}} p
 */
export function ipPlanCsv({ devices, vlanById }) {
  const rows = [['Floor', 'Device', 'Type', 'Model', 'IP', 'VLAN', 'VLAN name', 'Subnet', 'In subnet', 'Switch', 'Port', 'MAC']];
  for (const { dev, type, floor } of devices) {
    if (!(dev.ip || dev.vlan || dev.mac)) continue;
    const v = vlanById(dev.vlan);
    const sw = (floor.SWS || []).find((s) => s.id === dev.swId);
    const inSubnet = dev.ip && v && v.subnet ? (ipInCidr(dev.ip, v.subnet) ? 'yes' : 'NO') : '';
    rows.push([floor.name || '', dev.name || dev.id, type, dev.model || '', dev.ip || '', dev.vlan || '',
      v ? (v.name || '') : '', v ? (v.subnet || '') : '', inSubnet, sw ? (sw.name || sw.id) : '', dev.port || '', dev.mac || '']);
  }
  return orEmpty(rows);
}

/**
 * One row per switch port (free ports included), then clients without a
 * usable port number.
 * @param {Array<{sw:any, floor:any, analysis:{ports:number|null, clients:any[]}}>} switches
 */
export function portMapCsv(switches) {
  /** @type {Array<Array<any>>} */
  const rows = [['Switch', 'Floor', 'Switch model', 'Port', 'Device', 'Type', 'Device model', 'IP', 'VLAN', 'PoE (W)']];
  for (const { sw, floor, analysis: a } of switches) {
    const head = [sw.name || sw.id, floor.name || '', sw.model || ''];
    const client = (port, c) => [...head, port, c.name, c.type === 'AP' ? 'AP' : 'Camera', c.model || '', c.ip || '', c.dev.vlan || '', c.w || ''];
    const byPort = new Map();
    const noPort = [];
    for (const c of a.clients) {
      const p = parseInt(c.port, 10);
      if (p >= 1 && (a.ports == null || p <= a.ports)) byPort.set(p, c);
      else noPort.push(c);
    }
    const maxPort = a.ports != null ? a.ports : Math.max(0, ...byPort.keys());
    for (let p = 1; p <= maxPort; p++) {
      const c = byPort.get(p);
      rows.push(c ? client(p, c) : [...head, p, '— free —', '', '', '', '', '']);
    }
    for (const c of noPort) rows.push(client(c.port || '?', c));
  }
  return orEmpty(rows);
}

/**
 * The as-built record: identity, status and install fields for every device.
 * @param {{devices:Array<{dev:any,type:string,floor:any}>, statusLabel:(dev:any)=>string}} p
 */
export function inventoryCsv({ devices, statusLabel }) {
  const rows = [['Floor', 'Type', 'Name', 'Model', 'Status', 'Serial', 'Asset tag', 'Firmware', 'MAC', 'IP', 'VLAN', 'Switch', 'Port', 'Notes']];
  for (const { dev, type, floor } of devices) {
    const sw = (floor.SWS || []).find((s) => s.id === dev.swId);
    rows.push([floor.name || '', type, dev.name || dev.id, dev.model || '', statusLabel(dev),
      dev.serial || '', dev.assetTag || '', dev.firmware || '', dev.mac || '', dev.ip || '', dev.vlan || '',
      sw ? (sw.name || sw.id) : '', dev.port || '', dev.comment || dev.notes || '']);
  }
  return orEmpty(rows);
}
