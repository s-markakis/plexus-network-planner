'use strict';
// Trust-on-first-use store for controller certificates. The pin lives in the
// app's own data directory, NOT in the project file: a shared .plexus project
// is untrusted and must not be able to bring its own "trusted" fingerprint
// along with a controller URL.
const fs = require('node:fs');
const path = require('node:path');

const FP_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// The identity a pin is bound to: host + port (scheme is always https).
function pinKey(urlLike) {
  const u = new URL(urlLike);
  return `${u.hostname.toLowerCase()}:${u.port || '443'}`;
}

function loadPins(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && FP_RE.test(v)) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

function savePins(file, pins) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pins, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Decide what to do with the certificate a controller just presented.
 * @param {Record<string,string>} pins  current store
 * @param {string} key                  pinKey(url)
 * @param {string} seen                 fingerprint presented now
 * @param {string} [approved]           fingerprint the user explicitly approved
 *                                      in this call (first contact or re-trust)
 * @returns {{action:'use'|'store'|'ask-first'|'ask-changed', pinned?:string}}
 */
function decide(pins, key, seen, approved) {
  const pinned = Object.prototype.hasOwnProperty.call(pins, key) ? pins[key] : null;
  if (pinned && pinned === seen) return { action: 'use' };
  // The approval must be for exactly the certificate presented now.
  if (approved && approved === seen && FP_RE.test(seen)) return { action: 'store' };
  return pinned ? { action: 'ask-changed', pinned } : { action: 'ask-first' };
}

module.exports = { pinKey, loadPins, savePins, decide, FP_RE };
