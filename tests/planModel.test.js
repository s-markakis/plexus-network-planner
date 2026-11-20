import { describe, it, expect } from 'vitest';
import * as pm from '../files/src/planModel.js';

const f1 = { name: 'G', SWS: [{ id: 'core', name: 'Core' }, { id: 'acc', name: 'Acc', uplinkId: 'core', poeBudget: 30, ports: 2 }],
  APS: [{ id: 'a1', model: 'U6 Pro', swId: 'acc', port: '1', capacityClients: 40, status: 'live' }, { id: 'a2', model: 'Mystery', swId: 'acc', port: '2' }],
  CAMS: [{ id: 'c1', model: 'G5 Bullet', swId: 'acc', resolution: '4K' }] };
const f2 = { name: 'F', SWS: [{ id: 'edge', uplinkId: 'acc' }, { id: 'loop', uplinkId: 'loop' }], APS: [], CAMS: [] };
const floors = [f1, f2];

describe('planModel', () => {
  it('topology spans floors; self-uplinks are roots', () => {
    const t = pm.topologyModel(floors);
    expect(t.roots.map((e) => e.sw.id)).toEqual(['core', 'loop']);
    expect(t.children.get('acc').map((e) => e.sw.id)).toEqual(['edge']);
    expect(pm.findSwitchAnywhere(floors, 'edge').floorIdx).toBe(1);
    expect(pm.findSwitchAnywhere(floors, 'nope')).toBeNull();
  });
  it('switch analysis counts clients, ports and PoE', () => {
    const a = pm.analyzeSwitch(f1.SWS[1], f1);
    expect(a.clients.map((c) => c.dev.id)).toEqual(['a1', 'a2', 'c1']);
    expect(a.clients[1].w).toBe(10);            // unknown AP model → assumed 10 W
    expect(a.overPorts).toBe(true);              // 3 devices on 2 ports
  });
  it('device listings and rollups', () => {
    expect(pm.allDevices(floors).map((d) => d.type).join('')).toBe('APAPCAMSWSWSWSW');
    expect(pm.deviceStatusCounts(floors)).toMatchObject({ live: 1, planned: 6 });
    expect(pm.totalClientCapacity(floors)).toBe(65);
    expect(pm.cableTotals(floors, () => 50)).toEqual({ runs: 3, totalM: 165 });
    expect(pm.totalStorageGb(floors, { retentionDays: 1 })).toBeGreaterThan(0);
  });
});
