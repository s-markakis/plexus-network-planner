// Device-credential handling for saved projects. Extracted from app.js so the
// rules are in one place and unit-testable:
//   - with a passphrase, every device's creds move into one encrypted vault and
//     no plaintext copy may remain anywhere in the saved file — including inside
//     revision snapshots;
//   - revision snapshots never carry creds in the first place.
// Pure apart from Web Crypto (via crypto.js).

import { encryptObject, decryptObject } from './crypto.js';

const CRED_LISTS = ['APS', 'CAMS', 'SWS'];

// {deviceId: creds} across every floor.
export function collectCreds(floors) {
  const map = {};
  for (const f of floors || []) {
    for (const key of CRED_LISTS) {
      for (const d of (f && f[key]) || []) if (d && d.creds && d.id) map[d.id] = d.creds;
    }
  }
  return map;
}

// JSON.stringify replacer: drop per-item caches (`_x`) and credentials.
export function stripCredsReplacer(k, v) {
  return k.startsWith('_') || k === 'creds' ? undefined : v;
}

// Deep copy with every `creds` object removed, at any depth.
export function withoutCreds(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === 'creds' ? undefined : v)));
}

// Reattach creds by device id. With overwrite:false, devices that already have
// creds keep them.
export function attachCreds(floors, map, { overwrite = true } = {}) {
  let n = 0;
  for (const f of floors || []) {
    for (const key of CRED_LISTS) {
      for (const d of (f && f[key]) || []) {
        if (!d || !Object.prototype.hasOwnProperty.call(map, d.id)) continue;
        if (!overwrite && d.creds) continue;
        d.creds = map[d.id];
        n++;
      }
    }
  }
  return n;
}

export function hasPlaintextPasswords(floors) {
  return Object.values(collectCreds(floors)).some((c) => c && c.pass);
}

/**
 * Seal a project that is about to be saved: creds → `data.credsVault`, and no
 * plaintext creds left in `data.floors` or `data.revisions`. Replaces those
 * arrays on `data` with stripped copies; the objects they came from (the live
 * plan) are never mutated. No passphrase → no-op (plaintext mode is the user's
 * explicit choice).
 * @param {any} data  the export object ({floors, revisions, …})
 * @param {string} passphrase
 */
export async function sealCreds(data, passphrase) {
  if (!passphrase) return false;
  const map = collectCreds(data.floors);
  // Revisions written by older builds may still hold creds in their snapshots.
  if (Array.isArray(data.revisions)) data.revisions = withoutCreds(data.revisions);
  if (Object.keys(map).length) data.credsVault = await encryptObject(map, passphrase);
  data.floors = (data.floors || []).map((f) => {
    const out = { ...f };
    for (const key of CRED_LISTS) {
      if (Array.isArray(out[key])) out[key] = out[key].map((d) => { if (d && d.creds) { const c = { ...d }; delete c.creds; return c; } return d; });
    }
    return out;
  });
  return true;
}

// Decrypt a vault → {deviceId: creds}. Throws on a wrong passphrase.
export function openVault(vault, passphrase) {
  return decryptObject(vault, passphrase);
}
