'use strict';
// Project files on disk for the desktop app — a BOUNDED capability, like the
// SSH bridge: the renderer (which renders untrusted project data) never names
// a path to read or write on its own. A path becomes usable only when
//   - the user picked it in a native Open/Save dialog this session, or
//   - it is in the recent-files list, which only ever holds such paths and
//     lives in the app's own data directory (not in a project file).
// Reads go through the same gate, so a compromised renderer cannot use this to
// read ~/.ssh/id_ed25519 or overwrite a shell profile.
//
// Pure Node (no Electron): the dialogs are injected by main.cjs, so the gate
// and the recents store are unit-testable.
const fs = require('node:fs');
const path = require('node:path');

const MAX_PROJECT_BYTES = 512 * 1024 * 1024;   // inline floor plans can be large
const MAX_RECENTS = 10;

function loadRecents(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, MAX_RECENTS);
  } catch { return []; }
}

function saveRecents(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Write via a temp file in the same directory + rename, so a crash or a full
// disk mid-save never leaves a truncated project where the good one was.
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    // Owner-only: a project can hold device credentials (plaintext if the
    // user set no passphrase).
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw err;
  }
}

function readProject(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > MAX_PROJECT_BYTES) throw new Error('Project file is too large');
  return fs.readFileSync(file, 'utf8');
}

/**
 * @param {{recentsFile:string, onRecentsChanged?:(list:string[])=>void}} opts
 */
function createProjectFiles({ recentsFile, onRecentsChanged = () => {} }) {
  /** @type {Set<string>} */ const granted = new Set();
  let recents = loadRecents(recentsFile);

  const remember = (file) => {
    granted.add(file);
    recents = [file, ...recents.filter((p) => p !== file)].slice(0, MAX_RECENTS);
    try { saveRecents(recentsFile, recents); } catch { /* the list is a convenience */ }
    onRecentsChanged(recents.slice());
  };
  const forget = (file) => {
    recents = recents.filter((p) => p !== file);
    try { saveRecents(recentsFile, recents); } catch { /* ignore */ }
    onRecentsChanged(recents.slice());
  };
  const info = (file) => ({ path: file, name: path.basename(file) });
  const fail = (err) => ({ ok: false, error: String((err && err.message) || err) });

  return {
    // `picked`: the path the user chose in a native dialog (undefined = cancelled).
    openPicked(picked) {
      if (!picked) return { ok: false, cancelled: true };
      const file = path.resolve(String(picked));
      try { const text = readProject(file); remember(file); return { ok: true, ...info(file), text }; }
      catch (err) { return fail(err); }
    },
    openRecent(requested) {
      const file = typeof requested === 'string' ? path.resolve(requested) : '';
      if (!file || !recents.includes(file)) return { ok: false, error: 'Not a recent project' };
      try { const text = readProject(file); remember(file); return { ok: true, ...info(file), text }; }
      catch (err) { forget(file); return fail(err); }
    },
    saveAsPicked(picked, text) {
      if (!picked) return { ok: false, cancelled: true };
      if (typeof text !== 'string') return { ok: false, error: 'Nothing to save' };
      const file = path.resolve(String(picked));
      try { writeAtomic(file, text); remember(file); return { ok: true, ...info(file) }; }
      catch (err) { return fail(err); }
    },
    // Save back to a path the user already chose. Anything else is refused.
    save(requested, text) {
      const file = typeof requested === 'string' ? path.resolve(requested) : '';
      if (!file || !granted.has(file)) return { ok: false, error: 'This file was not opened or chosen in this session — use Save As' };
      if (typeof text !== 'string') return { ok: false, error: 'Nothing to save' };
      try { writeAtomic(file, text); remember(file); return { ok: true, ...info(file) }; }
      catch (err) { return fail(err); }
    },
    recents: () => recents.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }).map(info),
  };
}

module.exports = { createProjectFiles, loadRecents, writeAtomic, MAX_PROJECT_BYTES, MAX_RECENTS };
