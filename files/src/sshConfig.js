// Parse ~/.ssh/config and match its hosts to Plexus devices, so a whole network
// can be wired for SSH in one import. Pure: feed it the config text + a device
// list, get connection targets back. Keys are referenced by PATH (IdentityFile),
// never read or copied — the key material stays in ~/.ssh and ssh-agent. The
// target is what the netssh bridge needs to `open` a live session.

// Parse OpenSSH client-config text into concrete Host blocks.
// Returns [{ patterns:[...], hostName, user, port, identityFile }].
export function parseSshConfig(text) {
  const hosts = [];
  let cur = null;
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+)[\s=]+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'host') {
      cur = { patterns: val.split(/\s+/), hostName: null, user: null, port: 22, identityFile: null };
      hosts.push(cur);
    } else if (cur) {
      if (key === 'hostname') cur.hostName = val;
      else if (key === 'user') cur.user = val;
      else if (key === 'port') cur.port = parseInt(val, 10) || 22;
      else if (key === 'identityfile' && !cur.identityFile) cur.identityFile = val.split(/\s+/)[0];
    }
  }
  return hosts;
}

const hasWild = (p) => /[*?]/.test(p);
function toTarget(h, host) {
  return {
    host: h.hostName || host,
    user: h.user || null,
    port: h.port || 22,
    identityFile: h.identityFile || null,
    alias: h.patterns.find((p) => !hasWild(p)) || h.patterns[0],
  };
}

// Match one device {name, ip} to an ssh-config host. Precedence: HostName equals
// the device IP → an exact (non-wildcard) alias equals the device name → the
// device IP appears as a Host pattern. Returns a target or null.
export function matchDeviceToHost(device, hosts) {
  const ip = device && device.ip ? String(device.ip).trim() : '';
  const name = device && device.name ? String(device.name).trim().toLowerCase() : '';
  if (ip) {
    const byIp = hosts.find((h) => h.hostName === ip);
    if (byIp) return toTarget(byIp, ip);
  }
  if (name) {
    const byName = hosts.find((h) => h.patterns.some((p) => !hasWild(p) && p.toLowerCase() === name));
    if (byName) return toTarget(byName, byName.hostName || ip);
  }
  if (ip) {
    const byPatIp = hosts.find((h) => h.patterns.some((p) => !hasWild(p) && p === ip));
    if (byPatIp) return toTarget(byPatIp, byPatIp.hostName || ip);
  }
  return null;
}

function vendorForNetssh(model = '') {
  const m = String(model).toLowerCase();
  if (/\b(mikrotik|routeros|rb\d|crs\d|ccr\d|hap|cap ?ac)\b/.test(m)) return 'mikrotik';
  if (/\b(cisco|catalyst|nexus|ws-c|c9\d{3})\b/.test(m)) return 'cisco';
  return 'generic';
}

// Bulk import: match every device to an ssh-config host. Returns
// { assigned:[{id, ssh}], unmatched:[{id, name}] }. `ssh` carries the netssh
// vendor (from the device model) alongside the connection target.
export function importSshTargets(devices, hosts) {
  const assigned = [];
  const unmatched = [];
  for (const d of devices || []) {
    if (!d || !d.id) continue;
    const t = matchDeviceToHost(d, hosts);
    if (t) assigned.push({ id: d.id, ssh: { ...t, vendor: vendorForNetssh(d.model) } });
    else unmatched.push({ id: d.id, name: d.name });
  }
  return { assigned, unmatched };
}
