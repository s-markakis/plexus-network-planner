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
const SSH_USER_RE = /^[A-Za-z0-9._+-]{1,64}$/;
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

module.exports = { buildSshArgv, SSH_HOST_RE, SSH_USER_RE, SSH_KEY_RE };
