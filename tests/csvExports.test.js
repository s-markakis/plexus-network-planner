import { describe, it, expect } from 'vitest';
import { csvEscape, toCsv, bomCsv, cableScheduleCsv, ipPlanCsv, portMapCsv, inventoryCsv } from '../files/src/csvExports.js';

const floor = {
  name: 'Ground',
  APS: [{ id: 'a1', name: 'AP-1', model: 'U6 Pro', swId: 's1', port: '1', ip: '10.0.10.5', vlan: '10', mac: 'aa' }],
  CAMS: [{ id: 'c1', name: 'CAM, "pool"', model: 'G5 Bullet', swId: 's1', port: '7' }],
  SWS: [{ id: 's1', name: 'SW-1', model: 'USW-24-PoE' }],
};
const devices = [{ dev: floor.APS[0], type: 'AP', floor }, { dev: floor.CAMS[0], type: 'Camera', floor }];

describe('csv basics', () => {
  it('escapes quotes, commas and newlines only when needed', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(null)).toBe('');
    expect(toCsv([['a', 1], []])).toBe('a,1\n');
  });
});

describe('bomCsv', () => {
  it('tallies by model and adds cabling and storage rollups', () => {
    const csv = bomCsv({ floors: [floor, floor], cable: { runs: 4, totalM: 400 }, cableBoxM: 305, storageGb: 1500, retentionDays: '14', storageCodec: 'h264' });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Kind,Model,Qty,Total PoE draw (W)');
    expect(lines.find((l) => l.startsWith('AP,U6 Pro,2,'))).toBeTruthy();
    expect(lines).toContain('Switch,USW-24-PoE,2,');
    expect(lines).toContain('Cabling,Cable boxes (305 m),2,');
    expect(lines).toContain('Storage,NVR capacity for 14 d retention (H.264),1.50 TB,');
  });
  it('omits empty rollups', () => {
    expect(bomCsv({ floors: [], cable: { runs: 0, totalM: 0 }, storageGb: 0 })).toBe('Kind,Model,Qty,Total PoE draw (W)');
  });
});

describe('cableScheduleCsv', () => {
  it('rounds, adds slack and flags long runs', () => {
    const runM = (dev) => (dev.id === 'a1' ? 45.04 : 95.5);
    const lines = cableScheduleCsv({ floors: [floor], runM }).split('\n');
    expect(lines[1]).toBe('Ground,AP-1,AP,SW-1,1,45,4.5,OK');
    expect(lines[2]).toBe('Ground,"CAM, ""pool""",Camera,SW-1,7,95.5,9.6,Near limit');
  });
  it('is empty without cabled devices', () => {
    expect(cableScheduleCsv({ floors: [{ SWS: [], APS: [{ id: 'x' }] }], runM: () => 1 })).toBe('');
  });
});

describe('ipPlanCsv / inventoryCsv / portMapCsv', () => {
  it('ip plan checks subnet membership', () => {
    const vlans = { 10: { id: '10', name: 'Staff', subnet: '10.0.20.0/24' } };
    const csv = ipPlanCsv({ devices, vlanById: (id) => vlans[id] || null });
    expect(csv.split('\n')[1]).toBe('Ground,AP-1,AP,U6 Pro,10.0.10.5,10,Staff,10.0.20.0/24,NO,SW-1,1,aa');
    expect(csv.split('\n')).toHaveLength(2); // the camera has no network identity
  });
  it('inventory lists every device with its status label', () => {
    const csv = inventoryCsv({ devices, statusLabel: () => 'Planned' });
    expect(csv.split('\n')[1].startsWith('Ground,AP,AP-1,U6 Pro,Planned,')).toBe(true);
  });
  it('port map lists free ports and port-less clients', () => {
    const clients = [{ port: '2', name: 'AP-1', type: 'AP', model: 'U6 Pro', ip: '', dev: { vlan: '10' }, w: 13 }, { port: 'x', name: 'CAM', type: 'Camera', dev: {} }];
    const lines = portMapCsv([{ sw: floor.SWS[0], floor, analysis: { ports: 3, clients } }]).split('\n');
    expect(lines.slice(1)).toEqual([
      'SW-1,Ground,USW-24-PoE,1,— free —,,,,,',
      'SW-1,Ground,USW-24-PoE,2,AP-1,AP,U6 Pro,,10,13',
      'SW-1,Ground,USW-24-PoE,3,— free —,,,,,',
      'SW-1,Ground,USW-24-PoE,x,CAM,Camera,,,,',
    ]);
    expect(portMapCsv([])).toBe('');
  });
});
