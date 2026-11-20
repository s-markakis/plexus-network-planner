// Circuit records: the documented path a connection takes from an end device
// back to the core, including passive plant the plan doesn't model (patch
// panels, wall outlets, media converters, labelled cable runs). Pure — no DOM —
// so recording, searching and drift checks are unit-testable.
//
// Stored at project.settings.circuits. Plan data is untrusted (files are
// shared between technicians), so everything is normalised and size-capped.

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

function normHop(h) {
  if (!h || typeof h !== 'object') return null;
  const type = HOP_TYPES.includes(h.type) ? h.type : 'other';
  const hop = { type, ref: type === 'device' ? str(h.ref) : '', port: str(h.port), label: str(h.label), note: str(h.note) };
  // A hop with nothing in it documents nothing.
  if (!hop.ref && !hop.port && !hop.label && !hop.note) return null;
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
    out.push({ ...d, port: d.port || (prev ? prev.port : ''), note: prev ? prev.note : '' });
    if (after.has(d.ref)) out.push(...after.get(d.ref));
  }
  return out.slice(0, MAX_HOPS);
}
