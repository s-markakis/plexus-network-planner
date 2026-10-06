// Resolve a device's SSH connection target from its management credentials, and
// render the terminal command for it. Pure + testable: the app's right-click
// "Connect via SSH" uses this both to decide whether to show the item and to
// produce the command for the no-bridge fallback (copy-to-clipboard). The live
// path (netssh over the Electron bridge) consumes the same {host,user,port}.
//
// Host precedence: an explicit creds.host wins, else the device's own IP. A key
// path, when one is known (creds.key / creds.identityFile, or a device.ssh
// target from an ssh-config import), is surfaced as `-i`; passwords never are.

/** @param {any} device @returns {{host:string,user:string,port:number,key:string}|null} */
export function sshTarget(device) {
  if (!device || typeof device !== 'object') return null;
  const c = device.creds && typeof device.creds === 'object' ? device.creds : {};
  const host = String(c.host || device.ip || '').trim();
  if (!host) return null;
  const user = String(c.user || '').trim();
  const port = Number.parseInt(c.port, 10) || 22;
  const imported = device.ssh && typeof device.ssh === 'object' ? device.ssh : {};
  const key = String(c.key || c.identityFile || imported.identityFile || '').trim();
  return { host, user, port, key };
}

/**
 * The `ssh` command a user could paste into a terminal, or null if the device
 * has no reachable host. Argument order mirrors what one would type by hand.
 * @param {any} device @returns {string|null}
 */
export function sshCommand(device) {
  const t = sshTarget(device);
  if (!t) return null;
  const parts = ['ssh'];
  if (t.key) parts.push('-i', t.key);
  if (t.port !== 22) parts.push('-p', String(t.port));
  parts.push(t.user ? `${t.user}@${t.host}` : t.host);
  return parts.join(' ');
}

// Map a device model string to the netssh vendor dialect (same rules as the
// ssh-config importer), so the live bridge opens the session with the right
// prompt/pager handling.
/** @param {string} [model] @returns {'mikrotik'|'cisco'|'generic'} */
export function sshVendor(model = '') {
  const m = String(model).toLowerCase();
  if (/\b(mikrotik|routeros|rb\d|crs\d|ccr\d|hap|cap ?ac)\b/.test(m)) return 'mikrotik';
  if (/\b(cisco|catalyst|nexus|ws-c|c9\d{3})\b/.test(m)) return 'cisco';
  return 'generic';
}
