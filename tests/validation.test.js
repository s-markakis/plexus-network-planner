import { describe, it, expect } from 'vitest';
import { validatePlan } from '../files/src/validation.js';

const okAnalysis = (sw) => ({ overBudget: false, budget: 100, headroom: 50, draw: 20, overPorts: false, used: 1, ports: 24, classFails: [], swCls: 'at', clients: [] });
const base = (over = {}) => {
  const f1 = { name: 'G', APS: [{ id: 'a', name: 'AP-1', swId: 's', ip: '10.0.0.5', vlan: '10', capacityClients: 0 }], CAMS: [], SWS: [{ id: 's', name: 'SW-1', ip: '10.0.0.2' }] };
  return {
    floor: f1, floors: [f1], vlans: [{ id: '10', subnet: '10.0.0.0/24' }], settings: {}, hasMap: true,
    analyze: okAnalysis, runM: () => 20, airtimePct: () => 10, nameOk: null, evalPolicies: null,
    clientCapacity: () => 0, storageGb: 0, ...over,
  };
};

describe('validatePlan', () => {
  it('passes a clean plan', () => {
    expect(validatePlan(base())).toEqual({ errors: [], warns: [], infos: [] });
  });
  it('PoE budget, ports, class and duplicate port labels', () => {
    const clients = [{ name: 'AP-1', port: '1', w: 13 }, { name: 'CAM', port: ' 1', w: 5 }];
    const r = validatePlan(base({ analyze: () => ({ overBudget: true, draw: 130.4, budget: 100, overPorts: true, used: 30, ports: 24, classFails: [{ name: 'AP-9', cls: 'bt' }], swCls: 'at', clients }) }));
    expect(r.errors).toEqual(['SW-1: PoE draw 130 W exceeds 100 W budget.', 'SW-1: 30 devices on 24 ports — over capacity.', 'AP-9 needs bt PoE but SW-1 delivers at.']);
    expect(r.warns).toEqual(['SW-1: port " 1" used by both AP-1 and CAM.']);
  });
  it('cable length limits only with a map', () => {
    expect(validatePlan(base({ runM: () => 120 })).errors).toEqual(['AP-1: cable run to SW-1 is 120 m (>100 m Ethernet limit).']);
    expect(validatePlan(base({ runM: () => 95 })).warns).toEqual(['AP-1: cable run to SW-1 is 95 m (near 100 m limit).']);
    expect(validatePlan(base({ runM: () => 120, hasMap: false })).errors).toEqual([]);
  });
  it('finds duplicate IPs on other floors and names the floor', () => {
    const c = base();
    const f2 = { name: 'First', APS: [{ id: 'b', name: 'AP-9', ip: '10.0.0.5' }], CAMS: [], SWS: [] };
    c.floors = [c.floor, f2];
    expect(validatePlan(c).warns).toEqual(['Duplicate IP 10.0.0.5: AP-1 and AP-9 (First).']);
  });
  it('VLAN registry, subnet membership and pool exhaustion', () => {
    const c = base();
    c.floor.APS[0].vlan = '99';
    c.floor.APS[0].ip = '10.0.0.1';   // with the switch's .2, the /30 is full
    c.floor.CAMS = [{ id: 'c', name: 'CAM-1', swId: 's', ip: '10.9.9.9', vlan: '10' }];
    c.vlans = [{ id: '10', subnet: '10.0.0.0/30' }];
    const r = validatePlan(c);
    expect(r.warns).toContain('AP-1: VLAN "99" is not in the VLAN registry.');
    expect(r.warns).toContain('CAM-1: IP 10.9.9.9 is outside VLAN 10 subnet 10.0.0.0/30.');
    expect(r.errors).toContain('VLAN 10 subnet 10.0.0.0/30 is full (2/1 hosts).');
  });
  it('names are plain text (no HTML escaping)', () => {
    const c = base();
    c.floor.APS[0].name = 'Bar & Grill'; c.floor.APS[0].swId = '';
    expect(validatePlan(c).infos).toEqual(['Bar & Grill is not assigned to a switch.']);
  });
  it('naming, airtime, policies, capacity and storage', () => {
    const c = base({
      nameOk: () => false, settings: { namePattern: '{site}-AP{nn}', expectedClients: '50', policies: [{}], retentionDays: '14' },
      airtimePct: () => 120, evalPolicies: () => [{ status: 'pass' }, { status: 'skipped', label: 'X', reason: 'no hosts' }],
      clientCapacity: () => 40, storageGb: 2500,
    });
    c.floor.APS[0].capacityClients = 30;
    const r = validatePlan(c);
    expect(r.errors).toEqual(['AP-1: airtime ~120% — 30 clients × 5 Mbps exceeds what this cell can carry.']);
    expect(r.warns).toEqual([
      '2 device names break the "{site}-AP{nn}" convention (AP-1, SW-1) — Inventory → Auto-rename fixes them.',
      'Policy not testable — X: no hosts.',
      'Client capacity 40 < expected 50 — consider more/denser APs.',
    ]);
    expect(r.infos).toEqual(['1 reachability policy holds.', 'Camera recording needs ~2.50 TB of NVR storage for 14-day retention (H.265).']);
  });
  it('a plan that does not simulate is a warning, not a crash', () => {
    const r = validatePlan(base({ settings: { policies: [{}] }, evalPolicies: () => { throw new Error('x'); } }));
    expect(r.warns).toEqual(['Policies could not be evaluated (the plan does not simulate).']);
  });
});
