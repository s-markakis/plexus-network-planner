'use strict';
// The security boundary for right-click → Connect via SSH. The renderer sends
// only structured fields; this rebuilds the `ssh` argv after strict validation,
// because a loaded .plexus file is untrusted — a malicious host/user/key from a
// shared project must never reach a shell. Fail closed on anything that isn't a
// clean hostname/IP, user, port or key path. No password is ever accepted
// (key- or agent-auth only). Pure + dependency-light so it's unit-testable
// without booting Electron; main.cjs requires it.
const os = require('node:os');

const SSH_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/;
// No leading '-': the user becomes the first character of the destination
// token, and ssh would parse `-x@host` as an option.
const SSH_USER_RE = /^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,63}$/;
const SSH_KEY_RE  = /^[A-Za-z0-9._~/-]{1,256}$/;

function buildSshArgv(t = {}) {
  const host = String(t.host || '').trim();
  if (!SSH_HOST_RE.test(host)) return { ok: false, error: 'Invalid SSH host' };
  const argv = ['ssh'];
  if (t.key != null && String(t.key).trim() !== '') {
    let key = String(t.key).trim();
    if (!SSH_KEY_RE.test(key)) return { ok: false, error: 'Invalid key path' };
    // Expand a leading ~ to the real home dir so the path still resolves when
    // the token is shell-quoted (single quotes would otherwise suppress ~).
    if (key.startsWith('~/')) key = os.homedir() + key.slice(1);
    argv.push('-i', key);
  }
  if (t.port != null && String(t.port) !== '' && Number(t.port) !== 22) {
    const port = Number(t.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Invalid port' };
    argv.push('-p', String(port));
  }
  let user = '';
  if (t.user != null && String(t.user).trim() !== '') {
    user = String(t.user).trim();
    if (!SSH_USER_RE.test(user)) return { ok: false, error: 'Invalid username' };
  }
  argv.push(user ? `${user}@${host}` : host);
  return { ok: true, argv };
}

// The ONLY commands the app will ever run on a device by itself, per vendor —
// read-only configuration dumps. Nothing from the renderer or a project file
// can add to or alter this table.
const PULL_COMMANDS = Object.freeze({ mikrotik: '/export' });

// argv for a non-interactive, read-only config pull. Same validation as the
// terminal launcher, plus: never prompt (BatchMode — key/agent auth only),
// never trust a new host key silently (the user must have connected to the
// device once themselves), bounded connect time, and a fixed remote command.
function buildSshPullArgv(t = {}) {
  const cmd = Object.prototype.hasOwnProperty.call(PULL_COMMANDS, t.vendor) ? PULL_COMMANDS[t.vendor] : null;
  if (!cmd) return { ok: false, error: 'Reading the configuration is supported for MikroTik RouterOS devices only' };
  const base = buildSshArgv(t);
  if (!base.ok) return base;
  const [, ...rest] = base.argv;
  return { ok: true, argv: ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-T', ...rest, cmd] };
}

module.exports = { buildSshArgv, buildSshPullArgv, PULL_COMMANDS, SSH_HOST_RE, SSH_USER_RE, SSH_KEY_RE };
