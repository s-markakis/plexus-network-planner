import { describe, it, expect } from 'vitest';
import { ROUTER_WIFI, routerWifiSpec, hasWifi, routerAsAp, rfAps, rfFloor } from '../files/src/routerWifi.js';
import { SW_MODELS, SW_MODEL_GROUPS } from '../files/src/constants.js';
import { sampleFloorCoverage } from '../files/src/geometry.js';

describe('WiFi router catalogue', () => {
  it('every entry is a model that exists in the switch/router catalogue', () => {
    for (const m of Object.keys(ROUTER_WIFI)) expect(SW_MODELS, m).toContain(m);
  });

  it('entries are sane: known band string, plausible gain and range', () => {
    for (const [m, s] of Object.entries(ROUTER_WIFI)) {
      expect(['2.4 GHz only', '2.4 / 5 GHz', '2.4 / 5 / 6 GHz'], m).toContain(s.freq);
      expect(s.gainDbi, m).toBeGreaterThan(0); expect(s.gainDbi, m).toBeLessThan(10);
      expect(s.rangeM, m).toBeGreaterThanOrEqual(8); expect(s.rangeM, m).toBeLessThanOrEqual(25);
    }
  });

  it('wired-only routers and every switch stay without WiFi', () => {
    for (const m of ['UDM-Pro', 'UDM-SE', 'UXG-Lite', 'UCG-Ultra', 'Cloud Gateway Fiber', 'USG', 'hEX S (RB760iGS)',
      'RB4011iGS+RM', 'RB5009UG+S+IN', 'L009UiGS-RM', 'CCR2004-16G-2S+', 'USW-24-PoE', 'CRS326-24G-2S+RM', 'Custom/Other']) {
      expect(routerWifiSpec(m), m).toBe(null);
    }
    const switchGroups = SW_MODEL_GROUPS.filter((g) => /Switch/.test(g.label));
    for (const g of switchGroups) for (const m of g.models) expect(routerWifiSpec(m), m).toBe(null);
    expect(routerWifiSpec(undefined)).toBe(null);
    expect(routerWifiSpec('toString')).toBe(null);          // not fooled by prototype keys
  });

  it('marks the WiFi variants and their bands', () => {
    expect(routerWifiSpec('hAP ax³').freq).toBe('2.4 / 5 GHz');
    expect(routerWifiSpec('hAP ax lite').freq).toBe('2.4 GHz only');
    expect(routerWifiSpec('L009UiGS-2HaxD-IN').freq).toBe('2.4 GHz only');
    expect(routerWifiSpec('RB4011iGS+5HacQ2HnD-IN')).toBeTruthy();
    expect(routerWifiSpec('Dream Router 7').freq).toBe('2.4 / 5 / 6 GHz');
    expect(routerWifiSpec('UDM')).toBeTruthy();
  });
});

describe('router as an access point', () => {
  const sw = () => ({ id: 'sw1', name: 'Router', model: 'hAP ax³', fx: 0.5, fy: 0.5 });

  it('radius follows the floor scale so the range in metres is fixed', () => {
    const a = routerAsAp(sw(), 100), b = routerAsAp(sw(), 5), c = routerAsAp(sw(), 0.5);
    expect(a.r).toBeCloseTo(17, 6);            // 1 m per px
    expect(b.r * 5 / 100).toBeCloseTo(17, 6);
    expect(c.r * 0.5 / 100).toBeCloseTo(17, 6);
    expect(a.freq).toBe('2.4 / 5 GHz'); expect(a.antennaGainDbi).toBe(5.5);
  });

  it('is off for wired models, a disabled radio, or an unplaced device', () => {
    expect(routerAsAp({ ...sw(), model: 'RB5009UG+S+IN' }, 100)).toBe(null);
    expect(routerAsAp({ ...sw(), wifi: false }, 100)).toBe(null);
    expect(hasWifi({ ...sw(), wifi: false })).toBe(false);
    expect(routerAsAp({ ...sw(), fx: undefined }, 100)).toBe(null);
    expect(hasWifi(null)).toBe(false);
  });

  it('keeps one cached object per device and it never reaches a saved file', () => {
    const s = sw();
    const a = routerAsAp(s, 100); const b = routerAsAp(s, 100);
    expect(b).toBe(a);
    s.fx = 0.2; expect(routerAsAp(s, 100).fx).toBe(0.2);                       // follows the device
    const saved = JSON.stringify(s, (k, v) => (k.startsWith('_') ? undefined : v));
    expect(saved).not.toContain('_wifiAp'); expect(saved).not.toContain('viaRouter');
  });
});

describe('floor RF view', () => {
  const floor = (model) => ({ scaleM: 10, APS: [], WALLS: [], SWS: [{ id: 'sw1', name: 'R', model, fx: 0.5, fy: 0.5 }] });

  it('a floor with no WiFi router is passed through untouched', () => {
    const f = floor('RB5009UG+S+IN');
    expect(rfFloor(f)).toBe(f); expect(rfAps(f)).toBe(f.APS);
  });

  it('a WiFi router alone gives the floor coverage; a wired one gives none', () => {
    const wifi = sampleFloorCoverage(rfFloor(floor('hAP ax³')), 400, 300);
    const wired = sampleFloorCoverage(rfFloor(floor('RB5009UG+S+IN')), 400, 300);
    expect(wired.covered).toBe(0);
    expect(wifi.covered).toBeGreaterThan(0);
    expect(wired.total).toBe(0);                         // nothing radiates: no coverage figure at all
  });

  it('real access points are kept and the router is added after them', () => {
    const f = floor('hAP ax²'); f.APS = [{ id: 'ap1', fx: 0.1, fy: 0.1, r: 50 }];
    const all = rfAps(f);
    expect(all.map((a) => a.id)).toEqual(['ap1', 'sw1']);
    expect(f.APS).toHaveLength(1);                       // the plan itself is not changed
  });
});
