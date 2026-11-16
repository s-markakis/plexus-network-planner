// Site templates: a new project that starts with the parts every site of its
// kind needs — a VLAN plan with subnets and gateways, the reachability intent
// (policies) that usually goes with it, a naming convention and capacity
// assumptions — so a new job starts from a reviewed baseline rather than blank.
//
// A template carries NO floor plan and no APs: those are the site. It does
// place one L3 core on the first floor so the VLAN gateways have an owner and
// the policies can be evaluated by the simulator straight away.
//
// The policies are intent, not configuration: on a fresh template the "must
// never reach" ones FAIL until the firewall rules are written (CLI console) —
// that is the checklist. Pure data + one builder.

import { PROJECT_VERSION } from './migrate.js';

const vlan = (id, name, color, subnet) => ({ id: String(id), name, color, subnet, gateway: subnet.replace(/\.\d+\/\d+$/, '.1') });
const deny = (id, name, from, to) => ({ id, name, from: { kind: 'vlan', vlan: String(from) }, to: { kind: 'vlan', vlan: String(to) }, proto: 'any', expect: 'deny' });
const allow = (id, name, from, to) => ({ id, name, from: { kind: 'vlan', vlan: String(from) }, to: { kind: 'vlan', vlan: String(to) }, proto: 'any', expect: 'allow' });

export const SITE_TEMPLATES = [
  {
    id: 'villa',
    title: 'Villa / holiday home',
    summary: 'Owner, guest and IoT networks kept apart; cameras on their own VLAN. Two floors.',
    floors: ['Ground floor', 'First floor'],
    settings: {
      reportTitle: 'Villa — Network Plan',
      propagationModel: 'itu-indoor',
      namePattern: '{site}-F{floor}-{type}{nn}',
      expectedClients: 25, perClientMbps: 8, retentionDays: 14,
      vlans: [
        vlan(1, 'Mgmt', '#6a1b9a', '10.10.1.0/24'),
        vlan(10, 'Home', '#1565c0', '10.10.10.0/24'),
        vlan(20, 'Cameras', '#00838f', '10.10.20.0/24'),
        vlan(30, 'Guest', '#ef6c00', '10.10.30.0/24'),
        vlan(40, 'IoT', '#558b2f', '10.10.40.0/24'),
      ],
      policies: [
        deny('p1', 'Guests must never reach management', 30, 1),
        deny('p2', 'Guests must never reach the cameras', 30, 20),
        deny('p3', 'Guests must never reach the home network', 30, 10),
        deny('p4', 'IoT must never reach management', 40, 1),
        allow('p5', 'Home devices can view the cameras', 10, 20),
      ],
    },
  },
  {
    id: 'hotel',
    title: 'Hotel / resort',
    summary: 'Large guest network isolated from staff, POS, cameras and management. Three floors.',
    floors: ['Ground floor', 'Floor 1', 'Floor 2'],
    settings: {
      reportTitle: 'Hotel — Network Plan',
      propagationModel: 'itu-indoor',
      namePattern: '{site}-F{floor}-{type}{nn}',
      expectedClients: 200, perClientMbps: 5, retentionDays: 30,
      vlans: [
        vlan(1, 'Mgmt', '#6a1b9a', '10.20.1.0/24'),
        vlan(10, 'Staff', '#1565c0', '10.20.10.0/24'),
        vlan(20, 'Cameras', '#00838f', '10.20.20.0/24'),
        vlan(30, 'Guest', '#ef6c00', '10.20.64.0/20'),   // 4094 hosts, clear of the /24s above
        vlan(40, 'POS', '#c62828', '10.20.40.0/24'),
        vlan(50, 'IPTV-VoIP', '#558b2f', '10.20.50.0/24'),
      ],
      policies: [
        deny('p1', 'Guests must never reach management', 30, 1),
        deny('p2', 'Guests must never reach the POS network', 30, 40),
        deny('p3', 'Guests must never reach staff', 30, 10),
        deny('p4', 'Guests must never reach the cameras', 30, 20),
        deny('p5', 'POS must never reach the guest network', 40, 30),
        allow('p6', 'Staff can view the cameras', 10, 20),
      ],
    },
  },
  {
    id: 'restaurant',
    title: 'Restaurant / café',
    summary: 'Guest WiFi isolated from POS and staff; cameras on their own VLAN. Dining room and back of house.',
    floors: ['Dining room', 'Kitchen & back of house'],
    settings: {
      reportTitle: 'Restaurant — Network Plan',
      propagationModel: 'itu-indoor',
      namePattern: '{site}-{type}{nn}',
      expectedClients: 80, perClientMbps: 4, retentionDays: 30,
      vlans: [
        vlan(1, 'Mgmt', '#6a1b9a', '10.30.1.0/24'),
        vlan(10, 'Staff', '#1565c0', '10.30.10.0/24'),
        vlan(20, 'Cameras', '#00838f', '10.30.20.0/24'),
        vlan(30, 'Guest', '#ef6c00', '10.30.30.0/23'),
        vlan(40, 'POS', '#c62828', '10.30.40.0/24'),
      ],
      policies: [
        deny('p1', 'Guests must never reach management', 30, 1),
        deny('p2', 'Guests must never reach the POS network', 30, 40),
        deny('p3', 'Guests must never reach staff', 30, 10),
        deny('p4', 'Guests must never reach the cameras', 30, 20),
        allow('p5', 'Staff can view the cameras', 10, 20),
      ],
    },
  },
];

/** @param {string} id */
export function getSiteTemplate(id) {
  return SITE_TEMPLATES.find((t) => t.id === id) || null;
}

// A fresh project object for a template (deep-copied, so templates stay
// pristine). Feed it through migrateProject like any other project.
/** @param {string} id @returns {any|null} */
export function buildTemplateProject(id) {
  const t = getSiteTemplate(id);
  if (!t) return null;
  const settings = JSON.parse(JSON.stringify(t.settings));
  const floors = t.floors.map((name, i) => ({
    id: `f${i + 1}`, name, img: '', imgId: '', imgName: '', scaleM: 100,
    APS: [], DZS: [], WALLS: [], CAMS: [], ANNOS: [], SAMPLES: [], CLIENTS: [],
    // One L3 core on the first floor owns the VLAN gateways.
    SWS: i === 0 ? [{ id: 'sw1', name: 'Core', model: '', role: 'l3', fx: 0.08, fy: 0.1, ip: '', vlan: '1', locked: false, comment: 'Core router / L3 switch — set the model and place it on the plan.' }] : [],
  }));
  return { version: PROJECT_VERSION, settings, floors, revisions: [] };
}
