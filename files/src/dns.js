// Tiny name resolver for the simulator. A "zone" is a plain map of lowercased
// name → IP string. The adapter auto-populates it from every device's name (so
// `ping AP-01` resolves without configuring a DNS server — something Packet Tracer
// makes you set up), plus any explicit settings.dns records.

export function normName(name) {
  return String(name == null ? '' : name).trim().replace(/\.$/, '').toLowerCase();
}

export function buildZone(records = []) {
  const zone = {};
  for (const r of records) {
    if (r && r.name && r.ip) zone[normName(r.name)] = r.ip;
  }
  return zone;
}

// Resolve `name` to an IP via `zone`, or null. An IP passed in returns itself.
export function resolve(zone, name) {
  const n = normName(name);
  if (!n) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(n)) return n;
  return (zone && zone[n]) || null;
}
