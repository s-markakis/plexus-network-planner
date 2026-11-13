// VLAN-to-VLAN reachability matrix: "can a device in VLAN A reach a device in
// VLAN B?" answered by actually pinging a representative pair through the
// compiled plan. Turns the firewall/routing design into a table a client can
// read. Pure: takes a compileTopology() result.

import { ping, resetRuntime } from './sim.js';

const ENDPOINT = new Set(['ap', 'camera', 'client']);

/**
 * @param {any} compiled  result of compileTopology()
 * @returns {{vlans:string[], cells:Array<Array<{status:'allowed'|'blocked'|'unreachable'|'n/a', from:string, to:string}>>}}
 *   cells[i][j] = traffic from vlans[i] to vlans[j]. 'blocked' = a firewall/ACL
 *   rule dropped it; 'unreachable' = no path/route; 'n/a' = fewer than two
 *   devices to test with (the diagonal of a single-device VLAN).
 */
export function reachabilityMatrix(compiled) {
  const byVlan = new Map();
  for (const [simId, m] of compiled.meta) {
    if (!ENDPOINT.has(m.type) || !m.ip || !compiled.net.devices.has(simId)) continue;
    const k = String(m.vlan ?? 1);
    if (!byVlan.has(k)) byVlan.set(k, []);
    if (byVlan.get(k).length < 2) byVlan.get(k).push({ simId, ip: m.ip, name: m.name });
  }
  const vlans = [...byVlan.keys()].sort((a, b) => Number(a) - Number(b));
  const cells = vlans.map((a) => vlans.map((b) => {
    const src = byVlan.get(a)[0];
    const dst = a === b ? byVlan.get(b)[1] : byVlan.get(b)[0];
    if (!dst) return { status: /** @type {'n/a'} */ ('n/a'), from: src.name, to: '' };
    resetRuntime(compiled.net); // each cell is an independent, cold-cache test
    let status;
    try {
      const r = ping(compiled.net, { from: src.simId, to: dst.ip });
      status = r.ok ? 'allowed' : r.status === 'filtered' ? 'blocked' : 'unreachable';
    } catch { status = 'unreachable'; }
    return { status: /** @type {any} */ (status), from: src.name, to: dst.name };
  }));
  resetRuntime(compiled.net);
  return { vlans, cells };
}
