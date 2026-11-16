// Guided labs with automatic grading — the Packet Tracer "activity", but checked
// by proving the result in the simulator instead of comparing configs line by
// line. A lab is a starting plan, a brief, and a list of checks; each check is
// either a policy (see policy.js) or a function over the compiled plan. Any
// config that makes the network behave as asked passes.
//
// Pure: no DOM. The starting plans are generated here (no real site data).

import { compileTopology, applyFaults } from './simCompile.js';
import { evaluatePolicies } from './policy.js';
import { ping, resetRuntime } from './sim.js';
import { PROJECT_VERSION } from './migrate.js';

// Blank floor so devices have a map to sit on.
const BLANK_MAP = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#f6f4ee"/></svg>');

const ap = (id, name, swId, port, vlan, ip, fx, fy, extra = {}) => ({ id, name, model: 'U6 Lite', swId, port: String(port), vlan: String(vlan), ip, fx, fy, r: 60, ...extra });
const sw = (id, name, fx, fy, extra = {}) => ({ id, name, model: 'MikroTik CRS326', fx, fy, ...extra });
const plan = (vlans, SWS, APS, CAMS = []) => ({
  version: PROJECT_VERSION,
  settings: { vlans },
  floors: [{ id: 'lab-floor', name: 'Lab', img: BLANK_MAP, scaleM: 10, SWS, APS, CAMS, DZS: [], WALLS: [], CLIENTS: [], ANNOS: [], SAMPLES: [] }],
});
const allow = (from, to, extra = {}) => ({ id: `${from}>${to}`, from: { kind: 'vlan', vlan: String(from) }, to: { kind: 'vlan', vlan: String(to) }, expect: 'allow', ...extra });
const deny = (from, to, extra = {}) => ({ ...allow(from, to, extra), expect: 'deny' });

/** @type {Array<{id:string, title:string, level:string, brief:string[], hints:string[], build:()=>any, checks:Array<any>}>} */
export const LABS = [
  {
    id: 'inter-vlan',
    title: 'Inter-VLAN routing',
    level: 'Basics',
    brief: [
      'Two VLANs share one switch: Staff (10) and Printers (20). Devices in the same VLAN can talk; across VLANs they cannot.',
      'Make the switch route between them so PC-Staff can reach Printer-1 and back.',
    ],
    hints: [
      'Each VLAN needs a gateway address on a layer-3 device: Settings → VLANs → Gateway, and tick "Layer 3" on the switch.',
      'Or do it in the switch console: `interface vlan 10` / `ip address 10.0.10.1 255.255.255.0`, same for VLAN 20.',
    ],
    build: () => plan(
      [{ id: '10', name: 'Staff', subnet: '10.0.10.0/24', gateway: '' }, { id: '20', name: 'Printers', subnet: '10.0.20.0/24', gateway: '' }],
      [sw('lab-sw1', 'SW1', 0.5, 0.3)],
      [ap('lab-a1', 'PC-Staff', 'lab-sw1', 1, 10, '10.0.10.10', 0.3, 0.6), ap('lab-a2', 'PC-Staff-2', 'lab-sw1', 2, 10, '10.0.10.11', 0.4, 0.7), ap('lab-a3', 'Printer-1', 'lab-sw1', 3, 20, '10.0.20.10', 0.7, 0.6)]
    ),
    checks: [
      { label: 'Staff reaches Printers', policy: allow(10, 20) },
      { label: 'Printers reach Staff', policy: allow(20, 10) },
      { label: 'Devices inside Staff still reach each other', policy: allow(10, 10) },
    ],
  },
  {
    id: 'guest-isolation',
    title: 'Isolate the guest network',
    level: 'Firewall',
    brief: [
      'The core switch routes between Staff (10), Guest (30) and Management (99). Right now everything reaches everything.',
      'Lock Guest down: guests must not reach Staff or any network management address. Staff must still be able to reach Guest devices (to support them) and management.',
    ],
    hints: [
      'A plain "deny Guest → Staff" rule also drops the replies to Staff → Guest. Permit established traffic first: `access-list 130 permit ip any any established` (RouterOS: `connection-state=established,related`).',
      'Bind the list where Guest traffic enters: `interface vlan 30` / `ip access-group 130 in`.',
      'Order matters: first match wins, and traffic that matches no rule is permitted.',
    ],
    build: () => plan(
      [{ id: '10', name: 'Staff', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }, { id: '30', name: 'Guest', subnet: '10.0.30.0/24', gateway: '10.0.30.1' }, { id: '99', name: 'Management', subnet: '10.0.99.0/24', gateway: '10.0.99.1' }],
      [sw('lab-core', 'Core', 0.5, 0.25, { role: 'l3' }), sw('lab-acc', 'Access', 0.5, 0.6, { uplinkId: 'lab-core', ip: '10.0.99.3' })],
      [ap('lab-s1', 'Staff-PC', 'lab-core', 1, 10, '10.0.10.10', 0.25, 0.4), ap('lab-g1', 'Guest-Phone', 'lab-acc', 1, 30, '10.0.30.10', 0.3, 0.8), ap('lab-g2', 'Guest-Laptop', 'lab-acc', 2, 30, '10.0.30.11', 0.7, 0.8)]
    ),
    checks: [
      { label: 'Guest cannot reach Staff', policy: deny(30, 10) },
      { label: 'Guest cannot reach network management', policy: { id: 'g>m', from: { kind: 'vlan', vlan: '30' }, to: { kind: 'mgmt' }, proto: 'tcp', port: 22, expect: 'deny' } },
      { label: 'Staff can still reach Guest devices', policy: allow(10, 30) },
      { label: 'Staff can still reach management (ssh)', policy: { id: 's>m', from: { kind: 'vlan', vlan: '10' }, to: { kind: 'device', id: 'lab-acc' }, proto: 'tcp', port: 22, expect: 'allow' } },
    ],
  },
  {
    id: 'ospf-two-sites',
    title: 'Two sites, one routing protocol',
    level: 'Routing',
    brief: [
      'Site A and Site B each have a LAN behind an L3 switch, joined by a routed /30 link (already addressed: 10.255.0.1 ↔ 10.255.0.2). Neither site knows the other\'s LAN.',
      'Make the LANs reach each other with OSPF — no static routes.',
    ],
    hints: [
      'On both switches: `router ospf 1`, then a `network` statement for the transit link and one for the LAN (wildcard masks: `network 10.1.0.0 0.0.0.255 area 0`).',
      'An interface only joins OSPF if a network statement covers its address. `show ip ospf neighbor` and `show ip route` tell you where you are.',
    ],
    build: () => {
      const site = (n) => ({
        hostname: `Site${n === 1 ? 'A' : 'B'}`, vendor: 'cisco', routes: [], vlans: [], ospf: null, rip: null, acls: [], startup: null, natEnabled: false, natMasquerade: null, dhcpPools: [],
        interfaces: {
          [`Vlan${n}0`]: { name: `Vlan${n}0`, ip: `10.${n}.0.1`, prefix: 24, mode: 'routed', vlan: n * 10, allowed: [], shutdown: false },
          'Gi0/1': { name: 'Gi0/1', ip: `10.255.0.${n}`, prefix: 30, mode: 'routed', vlan: null, allowed: [], shutdown: false },
        },
      });
      return plan(
        [{ id: '10', name: 'Site A LAN', subnet: '10.1.0.0/24', gateway: '' }, { id: '20', name: 'Site B LAN', subnet: '10.2.0.0/24', gateway: '' }],
        [sw('lab-a', 'SiteA', 0.25, 0.3, { cli: site(1) }), sw('lab-b', 'SiteB', 0.75, 0.3, { cli: site(2), uplinkId: 'lab-a', uplinkMode: 'routed' })],
        [ap('lab-pa', 'PC-A', 'lab-a', 1, 10, '10.1.0.10', 0.2, 0.7), ap('lab-pb', 'PC-B', 'lab-b', 1, 20, '10.2.0.10', 0.8, 0.7)]
      );
    },
    checks: [
      { label: 'Site A LAN reaches Site B LAN', policy: allow(10, 20) },
      { label: 'Site B LAN reaches Site A LAN', policy: allow(20, 10) },
      { label: 'OSPF runs on both switches', test: (c) => c.ospfRouters.length === 2, fail: 'OSPF is not enabled on both devices' },
      { label: 'No static routes were used', test: (c, project) => project.floors.every((f) => (f.SWS || []).every((s) => !(s.cli && s.cli.routes && s.cli.routes.length))), fail: 'a static route is configured — remove it and let OSPF do the work' },
    ],
  },
  {
    id: 'redundant-uplink',
    title: 'Survive a cut uplink',
    level: 'Resilience',
    brief: [
      'Access hangs off Core-1 by a single uplink. If that cable is cut, everything on Access goes dark.',
      'Add a second uplink from Access to Core-2 so the network keeps working when the first one fails. Spanning tree keeps the loop from melting the network.',
    ],
    hints: [
      'Select the Access switch and set its "Redundant uplink" to Core-2.',
      'In Simulate → Faults, cut the primary uplink and ping again. `show spanning-tree` on a switch console shows which port is blocked.',
    ],
    build: () => plan(
      [{ id: '10', name: 'Staff', subnet: '10.0.10.0/24', gateway: '' }],
      [sw('lab-c1', 'Core-1', 0.3, 0.2), sw('lab-c2', 'Core-2', 0.7, 0.2, { uplinkId: 'lab-c1' }), sw('lab-ac', 'Access', 0.5, 0.6, { uplinkId: 'lab-c1' })],
      [ap('lab-srv', 'Server', 'lab-c2', 1, 10, '10.0.10.2', 0.85, 0.35), ap('lab-pc', 'PC', 'lab-ac', 1, 10, '10.0.10.10', 0.5, 0.85)]
    ),
    checks: [
      { label: 'PC reaches the Server', policy: allow(10, 10) },
      { label: 'Spanning tree blocks exactly one link of the loop', test: (c) => c.stp.blocked.length === 1, fail: 'no redundant link found (or more than one loop)' },
      { label: 'PC still reaches the Server with the primary uplink cut',
        test: (c, project) => {
          const again = compileTopology(project);
          applyFaults(again, { links: ['lab-ac'] });
          resetRuntime(again.net);
          return ping(again.net, { from: 'h:lab-pc', to: '10.0.10.2' }).ok;
        },
        fail: 'with Access → Core-1 cut there is no other path' },
    ],
  },
];

export function getLab(id) {
  return LABS.find((l) => l.id === id) || null;
}

/**
 * Grade a plan against a lab.
 * @param {any} project  { settings, floors }
 * @param {string} labId
 * @returns {null|{lab:string, score:number, total:number, passed:boolean, results:Array<{label:string, ok:boolean, detail:string}>}}
 */
export function gradeLab(project, labId) {
  const lab = getLab(labId);
  if (!lab) return null;
  const results = [];
  let compiled = null;
  let compileError = '';
  try { compiled = compileTopology(project); } catch (e) { compileError = String((e && e.message) || e); }
  for (const check of lab.checks) {
    if (!compiled) { results.push({ label: check.label, ok: false, detail: `the plan could not be simulated: ${compileError}` }); continue; }
    if (check.policy) {
      let r;
      try { r = evaluatePolicies(project, [check.policy]).results[0]; } catch (e) { r = null; }
      if (!r) { results.push({ label: check.label, ok: false, detail: 'could not be evaluated' }); continue; }
      if (r.status === 'pass') results.push({ label: check.label, ok: true, detail: `${r.pairs} path(s) checked` });
      else if (r.status === 'skipped') results.push({ label: check.label, ok: false, detail: r.reason });
      else {
        const v = r.violations[0];
        results.push({ label: check.label, ok: false, detail: `${v.from} (${v.fromIp}) → ${v.to} (${v.toIp}): ${v.status === 'delivered' || v.status === 'closed' ? 'reachable, but it must not be' : v.status}${r.violations.length > 1 ? ` (+${r.violations.length - 1} more)` : ''}` });
      }
    } else {
      let ok = false;
      try { ok = !!check.test(compiled, project); } catch { ok = false; }
      results.push({ label: check.label, ok, detail: ok ? '' : check.fail || '' });
    }
  }
  const score = results.filter((r) => r.ok).length;
  return { lab: lab.id, score, total: results.length, passed: score === results.length, results };
}
