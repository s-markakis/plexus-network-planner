// Structural validation of a loaded project, before migration touches it. A
// project file, share link or autosave is untrusted input: the rest of the app
// assumes "a floor is an object, its device lists are arrays of objects, text
// fields are strings" and would otherwise fail somewhere far from the cause
// (or, worse, render a non-string where a string was expected).
//
// sanitizeProject() repairs what can be repaired in place and reports what it
// changed; it only throws for input that isn't a project at all.
// Pure — no DOM.

const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 24;
const MAX_ARRAY = 50000;
const MAX_STRING = 200000;
// Keys that legitimately hold big blobs (inline images / catalogs).
const BLOB_KEYS = new Set(['img', 'imageUrl', 'logoDataUrl', 'customCatalog', 'ct']);

const DEVICE_LISTS = ['APS', 'DZS', 'SWS', 'CAMS', 'WALLS', 'CLIENTS', 'ANNOS', 'SAMPLES'];
// Fields that must be strings wherever they appear on a device/floor item.
const STRING_FIELDS = ['id', 'name', 'model', 'ip', 'mac', 'vlan', 'swId', 'uplinkId', 'uplinkMode', 'role', 'comment', 'notes', 'label',
  'color', 'serial', 'assetTag', 'firmware', 'status', 'freq', 'sig', 'pattern', 'material', 'text', 'kind', 'resolution', 'imgId', 'portPrefix', 'uplink2Id'];
// Fields that must be finite numbers when present (migration supplies defaults).
const NUMBER_FIELDS = ['fx', 'fy', 'fx1', 'fy1', 'fx2', 'fy2', 'r', 'size', 'fov', 'range', 'heading', 'poeBudget', 'ports', 'chanWidth',
  'antennaGainDbi', 'cableLossDb', 'txPowerDbm', 'mountHeightM', 'downtiltDeg', 'capacityClients', 'bitrateMbps', 'rssi', 'stpPriority'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep copy that drops prototype-aliasing keys, non-JSON values, runaway depth,
// and oversized strings/arrays.
function clean(v, depth, key, issues) {
  if (depth > MAX_DEPTH) { issues.add('nesting too deep — truncated'); return undefined; }
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    if (v.length > MAX_STRING && !BLOB_KEYS.has(key)) { issues.add(`text field "${key}" too long — truncated`); return v.slice(0, MAX_STRING); }
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY) issues.add(`list "${key}" too long — truncated`);
    const out = [];
    for (const x of v.slice(0, MAX_ARRAY)) { const c = clean(x, depth + 1, key, issues); if (c !== undefined) out.push(c); }
    return out;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (BANNED_KEYS.has(k)) { issues.add(`reserved key "${k}" removed`); continue; }
      const c = clean(v[k], depth + 1, k, issues);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined; // functions, symbols, undefined
}

function fixItem(it, issues) {
  for (const k of STRING_FIELDS) {
    if (!(k in it) || typeof it[k] === 'string') continue;
    if (typeof it[k] === 'number') it[k] = String(it[k]);
    else { delete it[k]; issues.add(`non-text "${k}" removed`); }
  }
  for (const k of NUMBER_FIELDS) {
    if (!(k in it) || typeof it[k] === 'number') continue;
    const n = typeof it[k] === 'string' && it[k].trim() !== '' ? Number(it[k]) : NaN;
    if (Number.isFinite(n)) it[k] = n;
    else { delete it[k]; issues.add(`non-numeric "${k}" removed`); }
  }
  if ('creds' in it && !isObj(it.creds)) { delete it.creds; issues.add('malformed credentials removed'); }
  if (isObj(it.creds)) for (const k of Object.keys(it.creds)) if (typeof it.creds[k] !== 'string') it.creds[k] = it.creds[k] == null ? '' : String(it.creds[k]);
  if ('cli' in it && !isObj(it.cli)) { delete it.cli; issues.add('malformed CLI config removed'); }
  if (isObj(it.cli)) {
    if (!isObj(it.cli.interfaces)) it.cli.interfaces = {};
    for (const k of ['routes', 'acls', 'vlans']) if (!Array.isArray(it.cli[k])) it.cli[k] = [];
    // An interface entry must be an object that knows its own name.
    for (const [name, i] of Object.entries(it.cli.interfaces)) {
      if (!isObj(i)) delete it.cli.interfaces[name];
      else { i.name = name; if (!Array.isArray(i.allowed)) i.allowed = []; }
    }
  }
  if ('trunkIfaces' in it && !isObj(it.trunkIfaces)) delete it.trunkIfaces;
  if ('services' in it && !Array.isArray(it.services)) delete it.services;
}

function fixFloors(floors, issues) {
  const out = [];
  for (const f of floors) {
    if (!isObj(f)) { issues.add('a floor entry that is not an object was dropped'); continue; }
    for (const key of DEVICE_LISTS) {
      if (!(key in f)) continue;
      if (!Array.isArray(f[key])) { f[key] = []; issues.add(`floor list ${key} was not a list — reset`); continue; }
      const kept = f[key].filter(isObj);
      if (kept.length !== f[key].length) issues.add(`${f[key].length - kept.length} malformed ${key} entr${f[key].length - kept.length === 1 ? 'y' : 'ies'} dropped`);
      kept.forEach((it) => fixItem(it, issues));
      f[key] = kept;
    }
    for (const k of ['id', 'name', 'imgId']) if (k in f && typeof f[k] !== 'string') f[k] = typeof f[k] === 'number' ? String(f[k]) : '';
    out.push(f);
  }
  return out;
}

/**
 * @param {any} raw  parsed JSON of a project file / share link / autosave
 * @returns {[any, string[]]} [sanitized copy, human-readable notes on repairs]
 * @throws when `raw` is not a project (not an object, or no floors list)
 */
export function sanitizeProject(raw) {
  if (!isObj(raw)) throw new Error('Not a Plexus project file');
  if (!Array.isArray(raw.floors)) throw new Error('Missing floors');
  const issues = new Set();
  const data = clean(raw, 0, '', issues);
  data.floors = fixFloors(data.floors, issues);
  if ('settings' in data && !isObj(data.settings)) { delete data.settings; issues.add('malformed settings ignored'); }
  if (isObj(data.settings) && Array.isArray(data.settings.vlans)) {
    data.settings.vlans = data.settings.vlans.filter(isObj);
    for (const v of data.settings.vlans) {
      for (const k of ['id', 'name', 'color', 'subnet', 'gateway']) if (k in v && typeof v[k] !== 'string') v[k] = typeof v[k] === 'number' ? String(v[k]) : '';
    }
  }
  if (!Array.isArray(data.revisions)) { if ('revisions' in data) issues.add('malformed revisions ignored'); data.revisions = []; }
  data.revisions = data.revisions.filter(isObj);
  for (const r of data.revisions) {
    for (const k of ['id', 'name', 'createdAt']) if (typeof r[k] !== 'string') r[k] = r[k] == null ? '' : String(r[k]);
    r.snapshot = Array.isArray(r.snapshot) ? fixFloors(r.snapshot, issues) : [];
  }
  if ('credsVault' in data && !isObj(data.credsVault)) delete data.credsVault;
  return [data, [...issues]];
}
