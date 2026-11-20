'use strict';
// Plan → device: hand a generated RouterOS script to `rosconf` — as a DRY RUN.
//
// The boundary this module keeps: Plexus never pushes configuration to a device
// by itself. A project file is untrusted, and the script is generated from it,
// so the app only (1) writes the script to a file in its own data directory and
// (2) builds the `rosconf apply … -f <file>` command WITHOUT `--apply`. rosconf
// then prints what it would send; changing the device takes the user adding
// `--apply` themselves, in their terminal, after reading that output.
//
// Nothing from the renderer reaches the command line except the validated SSH
// target (same rules as the SSH launcher). The rosconf executable is NOT a
// project or renderer setting: it comes from the app's own config, set through
// a native file dialog.
const fs = require('node:fs');
const path = require('node:path');
const { buildSshArgv } = require('./sshArgv.cjs');

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

// `rosconf apply` argv for a dry run. `rosconf` is the executable path (a .py
// file is run with python3). Returns {ok, argv} or {ok:false, error}.
/**
 * @param {{rosconf:any, target?:any, file:any}} a
 */
function buildRosconfArgv({ rosconf, target = {}, file }) {
  if (typeof rosconf !== 'string' || !path.isAbsolute(rosconf)) return { ok: false, error: 'rosconf location is not set' };
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, error: 'No script file' };
  const ssh = buildSshArgv(target);            // validates host / user / port / key
  if (!ssh.ok) return ssh;
  const host = String(target.host).trim().replace(/^\[(.*)\]$/, '$1');
  const argv = /\.py$/i.test(rosconf) ? ['python3', rosconf] : [rosconf];
  argv.push('apply', host);
  if (target.user != null && String(target.user).trim() !== '') argv.push('-u', String(target.user).trim());
  if (target.port != null && String(target.port) !== '' && Number(target.port) !== 22) argv.push('-p', String(Number(target.port)));
  // The key path as validated + ~-expanded by the SSH argv builder.
  const i = ssh.argv.indexOf('-i');
  if (i >= 0) argv.push('-i', ssh.argv[i + 1]);
  argv.push('-f', file);
  // No '--apply' — by construction. See the header.
  return { ok: true, argv };
}

// Write the script where only this user can read it; the name is rebuilt from a
// strict charset so a device name from a project file can't steer the path.
function writeScript(dir, name, text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to deploy');
  if (Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('Script is too large');
  if (text.includes('\u0000')) throw new Error('Script contains invalid characters');
  const safe = String(name || 'device').replace(/\.rsc$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 48) || 'device';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safe}-${stamp}.rsc`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// App-owned record of where rosconf lives.
function loadRosconfPath(file) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')).path;
    return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isFile() ? p : null;
  } catch { return null; }
}
function saveRosconfPath(file, p) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ path: p }, null, 2), { mode: 0o600 });
}

// For display / copy: a shell-quoted rendering of an argv.
const shQuote = (s) => (/^[A-Za-z0-9._~/@:=+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const commandLine = (argv) => argv.map(shQuote).join(' ');

module.exports = { buildRosconfArgv, writeScript, loadRosconfPath, saveRosconfPath, commandLine, MAX_SCRIPT_BYTES };
