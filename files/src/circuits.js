// Circuit records: the documented path a connection takes from an end device
// back to the core, including passive plant the plan doesn't model (patch
// panels, wall outlets, media converters, labelled cable runs). Pure — no DOM —
// so recording, searching and drift checks are unit-testable.
//
// Stored at project.settings.circuits. Plan data is untrusted (files are
// shared between technicians), so everything is normalised and size-capped.

import { esc } from './html.js';

export const HOP_TYPES = ['device', 'patch', 'outlet', 'converter', 'cable', 'other'];
export const HOP_TYPE_LABELS = {
  device: 'Device', patch: 'Patch panel', outlet: 'Wall outlet',
  converter: 'Media converter', cable: 'Cable run', other: 'Other',
};

const MAX_CIRCUITS = 2000;
const MAX_HOPS = 64;
const MAX_TEXT = 200;
const MAX_NOTES = 2000;
const DEVICE_LISTS = [['APS', 'ap'], ['CAMS', 'cam'], ['SWS', 'sw']];

const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '').slice(0, max);

// A hop may carry one photo (a patch panel, an outlet). In the app it is an
// IndexedDB id; in a saved file the image is inlined as a data: URL, and only
// an image data: URL is accepted — a shared file must not make the app fetch
// from someone else's server.
const IMG_ID_RE = /^img_[a-z0-9_]{1,40}$/i;
const HOP_IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_HOP_IMG = 3_000_000;   // chars of data: URL (~2.2 MB image)

function normHop(h) {
  if (!h || typeof h !== 'object') return null;
  const type = HOP_TYPES.includes(h.type) ? h.type : 'other';
  const hop = { type, ref: type === 'device' ? str(h.ref) : '', port: str(h.port), label: str(h.label), note: str(h.note) };
  // Photo fields only when present, so a photo-less hop keeps its shape.
  if (typeof h.imgId === 'string' && IMG_ID_RE.test(h.imgId)) hop.imgId = h.imgId;
  if (typeof h.img === 'string' && h.img.length <= MAX_HOP_IMG && HOP_IMG_RE.test(h.img)) hop.img = h.img;
  // A hop with nothing in it documents nothing.
  if (!hop.ref && !hop.port && !hop.label && !hop.note && !hop.imgId && !hop.img) return null;
  return hop;
}

/** Repair an untrusted circuits list. Drops junk; never throws. */
export function normalizeCircuits(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const c of raw) {
    if (out.length >= MAX_CIRCUITS) break;
    if (!c || typeof c !== 'object') continue;
    let id = str(c.id, 64);
    if (!id || seen.has(id)) id = newCircuitId(seen);
    seen.add(id);
    const hops = (Array.isArray(c.hops) ? c.hops : []).slice(0, MAX_HOPS).map(normHop).filter(Boolean);
    out.push({
      id,
      name: str(c.name),
      from: str(c.from),
      hops,
      tech: str(c.tech),
      date: /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : '',
      notes: str(c.notes, MAX_NOTES),
    });
  }
  return out;
}

export function newCircuitId(taken = new Set()) {
  let id;
  do id = 'ckt-' + Math.random().toString(36).slice(2, 10); while (taken.has(id));
  return id;
}

/** Index every networked device in the plan: id → {item, type, floor}. First id wins. */
export function deviceIndex(project) {
  const idx = new Map();
  (project && Array.isArray(project.floors) ? project.floors : []).forEach((f, floor) => {
    for (const [key, type] of DEVICE_LISTS) {
      for (const d of (f && Array.isArray(f[key]) ? f[key] : [])) {
        if (d && typeof d.id === 'string' && d.id && !idx.has(d.id)) idx.set(d.id, { item: d, type, floor });
      }
    }
  });
  return idx;
}

/**
 * Derive the path the plan itself knows: device → its switch (access port) →
 * that switch's uplink chain to the top. Uplink ports aren't modelled, so
 * inter-switch hops carry no port. Bounded against uplink cycles.
 */
export function autoTrace(project, deviceId, idx = deviceIndex(project)) {
  const start = idx.get(deviceId);
  if (!start) return [];
  const hops = [{ type: 'device', ref: deviceId, port: '', label: '', note: '' }];
  const visited = new Set([deviceId]);
  let swId = start.type === 'sw' ? str(start.item.uplinkId) : str(start.item.swId);
  let port = start.type === 'sw' ? '' : str(start.item.port);
  while (swId && !visited.has(swId)) {
    const sw = idx.get(swId);
    if (!sw || sw.type !== 'sw') break;
    visited.add(swId);
    hops.push({ type: 'device', ref: swId, port, label: '', note: '' });
    swId = str(sw.item.uplinkId);
    port = '';
  }
  return hops;
}

/**
 * Compare a circuit's device hops with what the plan says today. Passive hops
 * are the technician's knowledge and can't drift against the plan. Port is
 * only compared where both sides have one (uplink ports aren't modelled).
 * @returns {string[]} human-readable problems; empty = matches the plan.
 */
export function circuitDrift(project, circuit, idx = deviceIndex(project)) {
  const issues = [];
  const recorded = circuit.hops.filter((h) => h.type === 'device');
  for (const h of recorded) if (h.ref && !idx.has(h.ref)) issues.push(`Device ${h.ref} is no longer in the plan`);
  if (!circuit.from) return issues;
  if (!idx.has(circuit.from)) {
    if (!recorded.some((h) => h.ref === circuit.from)) issues.push(`End device ${circuit.from} is no longer in the plan`);
    return issues;
  }
  const derived = autoTrace(project, circuit.from, idx);
  const name = (id) => (idx.get(id) && idx.get(id).item.name) || id;
  const rec = recorded.filter((h) => idx.has(h.ref));
  const n = Math.max(rec.length, derived.length);
  for (let i = 0; i < n; i++) {
    const a = rec[i], b = derived[i];
    if (!a) { issues.push(`Plan has ${name(b.ref)} after the recorded path ends`); break; }
    if (!b) { issues.push(`Recorded ${name(a.ref)} is not on the plan's path`); break; }
    if (a.ref !== b.ref) { issues.push(`Hop ${i + 1}: recorded ${name(a.ref)}, plan says ${name(b.ref)}`); break; }
    if (a.port && b.port && a.port !== b.port) issues.push(`${name(a.ref)}: recorded port ${a.port}, plan says ${b.port}`);
  }
  return issues;
}

// Case- and accent-insensitive (Greek labels: «Πισίνα» must match "πισινα").
export function foldText(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function hopText(hop, idx) {
  if (hop.type === 'device') {
    const d = idx && idx.get(hop.ref);
    const nm = (d && d.item.name) || hop.ref || '?';
    return hop.port ? `${nm} port ${hop.port}` : nm;
  }
  const base = hop.label || HOP_TYPE_LABELS[hop.type];
  return hop.port ? `${base} #${hop.port}` : base;
}

/** One-line path, end device first: "CAM-03 → SW-2 port 7 → Patch PP2-14 → Core". */
export function pathText(circuit, idx) {
  return circuit.hops.map((h) => hopText(h, idx)).join(' → ');
}

/**
 * Search circuits by free text. Every whitespace-separated term must match
 * somewhere in the circuit (AND). Returns matches with the hop indices that
 * matched, so the UI can highlight where the hit is.
 * @returns {{circuit:any, hops:number[]}[]}
 */
export function searchCircuits(project, circuits, query, idx = deviceIndex(project)) {
  const terms = foldText(query || '').split(/\s+/).filter(Boolean);
  const out = [];
  for (const c of circuits) {
    const head = foldText([c.name, c.tech, c.notes, c.date].join(' '));
    const hopTexts = c.hops.map((h) => {
      const d = h.type === 'device' && idx.get(h.ref);
      return foldText([hopText(h, idx), h.ref, h.port, h.label, h.note, HOP_TYPE_LABELS[h.type],
        d ? [d.item.ip, d.item.mac, d.item.serial, d.item.assetTag].join(' ') : ''].join(' '));
    });
    if (!terms.length) { out.push({ circuit: c, hops: [] }); continue; }
    const hit = new Set();
    const ok = terms.every((t) => {
      let any = head.includes(t);
      hopTexts.forEach((ht, i) => { if (ht.includes(t)) { hit.add(i); any = true; } });
      return any;
    });
    if (ok) out.push({ circuit: c, hops: [...hit].sort((a, b) => a - b) });
  }
  return out;
}

/** Circuits whose path touches the given device (as end device or any hop). */
export function circuitsThrough(circuits, deviceId) {
  if (!deviceId) return [];
  return circuits.filter((c) => c.from === deviceId || c.hops.some((h) => h.type === 'device' && h.ref === deviceId));
}

/**
 * Re-derive the device hops from the plan while keeping the technician's
 * passive hops. Each passive hop stays after the device hop it followed; one
 * whose anchor device left the path goes after the nearest surviving anchor
 * before it (or the front), so recorded knowledge is never silently dropped.
 */
export function mergeTrace(hops, derived) {
  const before = [];          // passive hops ahead of any device hop
  const after = new Map();    // device ref → passive hops that followed it
  let anchor = null;
  const anchors = [];
  for (const h of hops) {
    if (h.type === 'device') { anchor = h.ref; anchors.push(h.ref); continue; }
    if (anchor === null) before.push(h);
    else { if (!after.has(anchor)) after.set(anchor, []); after.get(anchor).push(h); }
  }
  const kept = new Set(derived.map((d) => d.ref));
  // Re-home orphans onto the closest earlier anchor that survives.
  for (let i = 0; i < anchors.length; i++) {
    const ref = anchors[i];
    if (kept.has(ref) || !after.has(ref)) continue;
    const orphans = after.get(ref);
    after.delete(ref);
    let j = i - 1;
    while (j >= 0 && !kept.has(anchors[j])) j--;
    if (j < 0) before.push(...orphans);
    else { if (!after.has(anchors[j])) after.set(anchors[j], []); after.get(anchors[j]).push(...orphans); }
  }
  const out = [...before];
  for (const d of derived) {
    // Keep a recorded port if the plan has none (uplink ports aren't modelled).
    const prev = hops.find((h) => h.type === 'device' && h.ref === d.ref);
    const keep = { ...d, port: d.port || (prev ? prev.port : ''), note: prev ? prev.note : '' };
    if (prev && prev.imgId) keep.imgId = prev.imgId;   // a photo stays with its device hop
    if (prev && prev.img) keep.img = prev.img;
    out.push(keep);
    if (after.has(d.ref)) out.push(...after.get(d.ref));
  }
  return out.slice(0, MAX_HOPS);
}

// ── Labels, conflicts, bulk creation, exports ────────────────────────────────

/** Comparable form of a label or port: "PP-1", "pp 1" and "PP1" are one panel. */
export function normLabel(s) {
  return foldText(s == null ? '' : s).replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Where a new hop goes: after the passive hops that follow the end device and
 * before the next device (usually its switch) — passive plant sits between the
 * end device and the switch far more often than beyond it.
 */
export function newHopIndex(hops) {
  for (let i = 1; i < hops.length; i++) if (hops[i].type === 'device') return i;
  return hops.length;
}

/** Labels already used, per passive hop type, for autocomplete. First spelling wins. */
export function labelSuggestions(circuits) {
  /** @type {Record<string, Map<string,string>>} */
  const by = {};
  for (const t of HOP_TYPES) if (t !== 'device') by[t] = new Map();
  for (const c of circuits || []) for (const h of (c && c.hops) || []) {
    if (!h || h.type === 'device' || !by[h.type] || !h.label) continue;
    const k = normLabel(h.label);
    if (k && !by[h.type].has(k)) by[h.type].set(k, h.label);
  }
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [t, m] of Object.entries(by)) out[t] = [...m.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return out;
}

/**
 * Physical points claimed by more than one circuit: a patch-panel position or a
 * wall-outlet port (label + port), or a cable label (meant to be unique). Two
 * circuits on one point means one of the records is wrong.
 * @returns {{key:string, type:string, label:string, port:string, circuits:{id:string,name:string}[]}[]}
 */
export function circuitConflicts(circuits) {
  /** @type {Map<string, any>} */
  const seen = new Map();
  for (const c of circuits || []) {
    const mine = new Set();
    for (const h of (c && c.hops) || []) {
      let key = null;
      if ((h.type === 'patch' || h.type === 'outlet') && normLabel(h.label) && normLabel(h.port)) key = `${h.type}|${normLabel(h.label)}|${normLabel(h.port)}`;
      else if (h.type === 'cable' && normLabel(h.label)) key = `cable|${normLabel(h.label)}`;
      if (!key || mine.has(key)) continue;
      mine.add(key);
      if (!seen.has(key)) seen.set(key, { key, type: h.type, label: h.label, port: h.type === 'cable' ? '' : h.port, circuits: [] });
      seen.get(key).circuits.push({ id: c.id, name: c.name || c.id });
    }
  }
  return [...seen.values()].filter((e) => e.circuits.length > 1);
}

/** @param {{type:string,label:string,port:string,circuits:{name:string}[]}} e */
export function conflictText(e) {
  const where = e.type === 'cable' ? `Cable label ${e.label}` : `${HOP_TYPE_LABELS[e.type]} ${e.label} #${e.port}`;
  return `${where} is on ${e.circuits.length} circuits: ${e.circuits.map((c) => c.name).join(', ')}`;
}

/**
 * Circuits for every AP and camera that has none yet, path filled from the
 * plan. A device not cabled to a switch is skipped (its path would be only
 * itself). Switches are left out: their uplinks are already on the endpoints'
 * paths.
 * @returns {{created:any[], existing:number, unlinked:string[]}}
 */
export function bulkCircuits(project, existing, { tech = '', date = '' } = {}, idx = deviceIndex(project)) {
  const list = Array.isArray(existing) ? existing : [];
  const have = new Set(list.map((c) => c.from).filter(Boolean));
  const taken = new Set(list.map((c) => c.id));
  const room = Math.max(0, MAX_CIRCUITS - list.length);
  /** @type {any[]} */ const created = [];
  /** @type {string[]} */ const unlinked = [];
  let already = 0;
  for (const [id, d] of idx) {
    if (d.type === 'sw') continue;
    if (have.has(id)) { already++; continue; }
    const hops = autoTrace(project, id, idx);
    if (hops.length < 2) { unlinked.push(str(d.item.name) || id); continue; }
    if (created.length >= room) break;
    const cid = newCircuitId(taken);
    taken.add(cid);
    created.push({ id: cid, name: str(d.item.name) || id, from: id, hops, tech: str(tech), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', notes: '' });
  }
  return { created, existing: already, unlinked };
}

/**
 * One flat record per circuit for the exports: the end device, the switch and
 * port it lands on, and the passive plant by type.
 */
export function circuitRows(project, circuits, idx = deviceIndex(project)) {
  const floors = (project && Array.isArray(project.floors)) ? project.floors : [];
  const devName = (ref) => (idx.get(ref) && idx.get(ref).item.name) || ref;
  return (circuits || []).map((c) => {
    const passive = (type) => c.hops.filter((h) => h.type === type).map((h) => hopText(h, idx)).join('; ');
    const end = idx.get(c.from);
    const later = c.hops.slice(1).filter((h) => h.type === 'device');
    const sw = later.find((h) => idx.has(h.ref) && idx.get(h.ref).type === 'sw') || later[0];
    return {
      id: c.id, name: c.name,
      device: c.from ? devName(c.from) : '',
      deviceType: end ? end.type : '',
      floor: end ? ((floors[end.floor] && floors[end.floor].name) || `Floor ${end.floor + 1}`) : '',
      switchName: sw ? devName(sw.ref) : '',
      switchPort: sw ? sw.port : '',
      patch: passive('patch'), outlet: passive('outlet'), cable: passive('cable'),
      converter: passive('converter'), other: passive('other'),
      path: pathText(c, idx), tech: c.tech, date: c.date, notes: c.notes,
      check: circuitDrift(project, c, idx).join('; '),
    };
  });
}

/** Rows in rack order: by switch, then port (numeric where it is a number). */
export function sortBySwitchPort(rows) {
  const portKey = (p) => { const n = parseInt(String(p || ''), 10); return Number.isFinite(n) ? n : Infinity; };
  return [...rows].sort((a, b) => (a.switchName || '￿').localeCompare(b.switchName || '￿', undefined, { numeric: true })
    || portKey(a.switchPort) - portKey(b.switchPort)
    || String(a.switchPort).localeCompare(String(b.switchPort), undefined, { numeric: true })
    || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
}

/** IndexedDB ids of hop photos, for the image store's liveness check. */
export function circuitImageIds(circuits, out = new Set()) {
  for (const c of circuits || []) for (const h of (c && c.hops) || []) if (h && h.imgId) out.add(h.imgId);
  return out;
}

/**
 * Printable cable labels: two per circuit, A at the device end and B at the
 * switch end, each naming the circuit and both ends. A complete HTML document.
 */
export function cableLabelsHtml(rows, { title = 'Cable labels' } = {}) {
  const lbl = (r, end) => {
    const ends = `${r.device || '?'} ⇄ ${r.switchName || '?'}${r.switchPort ? ' · ' + r.switchPort : ''}`;
    const plant = [r.patch, r.outlet].filter(Boolean).join(' · ');
    return `<div class="lbl"><span class="end">${end}</span><div class="nm">${esc(r.name || r.device || r.id)}</div><div class="ln">${esc(ends)}</div>${plant ? `<div class="pl">${esc(plant)}</div>` : ''}</div>`;
  };
  const cells = rows.map((r) => lbl(r, 'A') + lbl(r, 'B')).join('');
  const n = rows.length, labels = n * 2;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${esc(title)}</title><style>
@page{size:A4;margin:10mm}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#000;background:#fff;padding:12px}
.hd{font-size:12px;margin-bottom:8px;color:#444}
.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}
.lbl{position:relative;border:1px dashed #888;height:24mm;padding:2mm 3mm;overflow:hidden;break-inside:avoid}
.end{position:absolute;top:1.5mm;right:2mm;font-size:9px;font-weight:700;border:1px solid #000;border-radius:2px;padding:0 3px}
.nm{font-size:13px;font-weight:700;margin-right:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln{font-size:10px;margin-top:1.5mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl{font-size:9px;color:#333;margin-top:1mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.print-btn{margin-top:14px;padding:10px 22px;background:#000;color:#fff;border:none;border-radius:2px;font-size:12px;cursor:pointer}
@media print{body{padding:0}.print-btn,.hd{display:none}}
</style></head><body><div class="hd">${esc(title)} — ${n} circuit(s), ${labels} labels. A = device end, B = switch end.</div>
<div class="sheet">${cells}</div><button class="print-btn">Print / Save as PDF</button></body></html>`;
}

/** Technical-report section: the patch schedule as a table ('' with no circuits). */
export function circuitsReportHtml(rows) {
  const count = rows.length;
  if (!count) return '';
  const tr = sortBySwitchPort(rows).map((r) => `<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(r.device)}</td><td class="mono">${esc(r.switchName + (r.switchPort ? ' · ' + r.switchPort : ''))}</td><td class="mono">${esc(r.patch || '—')}</td><td>${esc(r.outlet || '—')}</td><td class="mono">${esc(r.cable || '—')}</td><td class="muted">${esc([r.tech, r.date].filter(Boolean).join(' · ') || '—')}</td></tr>${r.check ? `<tr class="note-row"><td colspan="7">⚠ ${esc(r.check)}</td></tr>` : ''}`).join('');
  return `<h2><span>Circuits &amp; patch schedule</span><span class="floor-cov">${count}</span></h2><table><thead><tr><th>Circuit</th><th>Device</th><th>Switch · port</th><th>Patch panel</th><th>Outlet</th><th>Cable</th><th>Recorded</th></tr></thead><tbody>${tr}</tbody></table>`;
}
