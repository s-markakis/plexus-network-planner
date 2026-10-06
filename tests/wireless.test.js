import { describe, it, expect } from 'vitest';
import { bestAp } from '../files/src/wireless.js';
import { compileTopology } from '../files/src/simCompile.js';
import { ping } from '../files/src/sim.js';

const W = 1000, H = 1000;
const ap = (name, fx, fy, extra = {}) => ({ name, fx, fy, r: 600, freq: '5 GHz', ...extra });

describe('bestAp (RF association)', () => {
  it('picks the nearer AP when there are no walls', () => {
    const near = ap('AP-near', 0.2, 0.2);
    const far = ap('AP-far', 0.9, 0.9);
    const r = bestAp({ fx: 0.25, fy: 0.25 }, [near, far], [], W, H);
    expect(r.ap.name).toBe('AP-near');
    expect(typeof r.dbm).toBe('number');
  });

  it('a wall between the client and the nearer AP can flip the winner', () => {
    const near = ap('AP-near', 0.2, 0.5);
    const other = ap('AP-other', 0.8, 0.5);
    const client = { fx: 0.5, fy: 0.5 };
    const noWall = bestAp(client, [near, other], [], W, H);
    // concrete wall right in front of AP-near, between it and the client
    const wall = [{ fx1: 0.35, fy1: 0.0, fx2: 0.35, fy2: 1.0, material: 'concrete' }];
    const withWall = bestAp(client, [near, other], wall, W, H);
    expect(noWall.ap.name).toBe('AP-near'); // nearer wins with a clear path
    expect(withWall.ap.name).toBe('AP-other'); // the wall pushes association to the far AP
  });

  it('returns null when every AP is out of range', () => {
    const tiny = { ...ap('AP', 0.1, 0.1), r: 5 };
    expect(bestAp({ fx: 0.9, fy: 0.9 }, [tiny], [], W, H)).toBeNull();
  });
});

describe('compileTopology associates wireless clients', () => {
  const project = () => ({
    settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24', gateway: '10.0.10.1' }] },
    floors: [{
      id: 'f1', imgW: 1000, imgH: 1000, scaleM: 100,
      SWS: [{ id: 'sw1', role: 'l3' }],
      APS: [{ id: 'ap1', name: 'AP-1', fx: 0.3, fy: 0.3, r: 600, freq: '5 GHz', swId: 'sw1', vlan: '10', ip: '10.0.10.2' }],
      CAMS: [],
      WALLS: [],
      CLIENTS: [{ id: 'laptop', name: 'Laptop', fx: 0.32, fy: 0.32, ip: 'dhcp' }],
    }],
  });

  it('a client joins its AP VLAN, gets a lease, and can reach the AP', () => {
    const c = compileTopology(project());
    expect(c.net.devices.has('h:laptop')).toBe(true);
    expect(c.meta.get('h:laptop').vlan).toBe(10);
    expect(typeof c.meta.get('h:laptop').rssi).toBe('number');
    // associated into VLAN 10 with a DHCP lease → reaches the AP's wired IP
    expect(ping(c.net, { from: 'h:laptop', to: '10.0.10.2' }).ok).toBe(true);
  });

  it('warns when the floor has no image size', () => {
    const p = project();
    delete p.floors[0].imgW;
    const c = compileTopology(p);
    expect(c.warnings.some((w) => /no image size for RF association/.test(w))).toBe(true);
    expect(c.net.devices.has('h:laptop')).toBe(false);
  });
});
