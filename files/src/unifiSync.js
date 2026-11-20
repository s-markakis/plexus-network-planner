// UniFi controller sync, minus the network: match controller devices to the
// plan, and build the channel plan to push. Pure (the Electron main process
// does the HTTP). Controller data is treated as untrusted — a compromised or
// spoofed controller must not be able to put non-text or huge values into
// the plan.

import { parseChannel } from './channels.js';
import { bandKey } from './geometry.js';

const MAX = 200;
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '').slice(0, MAX);
const norm = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * Fill in as-built fields from the controller: IP and firmware always, MAC
 * and serial only when empty, status → live for connected devices. Matches
 * by MAC first, then case-insensitive name. Mutates the plan's devices.
 * @param {any[]} floors
 * @param {any[]} devices  as returned by the main process
 * @returns {number} how many controller devices matched a planned device
 */
export function applyUnifiDevices(floors, devices) {
  const all = [];
  for (const f of floors) for (const list of [f.APS, f.SWS, f.CAMS]) for (const d of list || []) all.push(d);
  let matched = 0;
  for (const raw of Array.isArray(devices) ? devices : []) {
    if (!raw || typeof raw !== 'object') continue;
    const dev = { name: text(raw.name), mac: text(raw.mac), ip: text(raw.ip), version: text(raw.version), serial: text(raw.serial), state: raw.state };
    const dm = norm(dev.mac);
    let target = (dm && all.find((x) => norm(x.mac) === dm)) || null;
    if (!target && dev.name) target = all.find((x) => (x.name || '').toLowerCase() === dev.name.toLowerCase()) || null;
    if (!target) continue;
    matched++;
    if (dev.ip) target.ip = dev.ip;
    if (dev.mac && !target.mac) target.mac = dev.mac;
    if (dev.version) target.firmware = dev.version;
    if (dev.serial && !target.serial) target.serial = dev.serial;
    if (dev.state === 1) target.status = 'live';
  }
  return matched;
}

/** Channel/width/Tx per AP with a concrete channel, for pushing. */
export function unifiChannelPlan(floors) {
  const changes = [];
  for (const f of floors) for (const ap of f.APS || []) {
    const ch = parseChannel(ap.channel);
    if (ch == null) continue;
    changes.push({
      mac: ap.mac || '', name: ap.name || '',
      band: bandKey(ap.freq), channel: ch, width: ap.chanWidth || 20,
      txPowerDbm: Number.isFinite(ap.txPowerDbm) ? ap.txPowerDbm : undefined,
    });
  }
  return changes;
}
