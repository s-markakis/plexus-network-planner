import { describe, it, expect } from 'vitest';
import { apPanelHtml, swPanelHtml, camPanelHtml, wallPanelHtml, dzPanelHtml } from '../files/src/panels.js';

/** @type {any} */
const ctx = {
  switches: [{ id: 's1', name: 'Core', model: 'USW-24-PoE' }], floors: [{ name: 'G', SWS: [{ id: 's1', name: 'Core' }, { id: 's2', name: 'Edge' }] }],
  mPerPx: 0.5, storageCodec: 'h265',
  deviceImageBlock: () => '<div class="img"></div>', devSwitchPorts: () => 8, airtimeLabel: () => '12%',
  radiusMaxPx: (b) => b, vlanDatalist: () => '', camStorageLabel: () => '4 Mbps', wallPx: () => ({ x1: 0, y1: 0, x2: 30, y2: 40 }),
  analyze: () => ({ draw: 12, budget: 60, headroom: 80, used: 1, ports: 8, swCls: 'at', overBudget: false, overPorts: false, classFails: [], clients: [] }),
};
const evil = '"><img src=x onerror=alert(1)>';

describe('inspector panels', () => {
  it('escape every plan string', () => {
    for (const html of [
      apPanelHtml({ id: 'a', name: evil, notes: evil, ip: evil, r: 100 }, ctx),
      swPanelHtml({ id: 's2', name: evil, notes: evil, model: evil }, ctx),
      camPanelHtml({ id: 'c', name: evil, notes: evil }, ctx),
      wallPanelHtml({ id: 'w', notes: evil, material: 'drywall' }, ctx),
      dzPanelHtml({ id: 'd', label: evil, notes: evil, r: 20 }, ctx),
    ]) expect(html).not.toContain('<img src=x');
  });
  it('uses the floor scale for readouts', () => {
    expect(apPanelHtml({ id: 'a', name: 'A', r: 100 }, ctx)).toContain('id="ep-rv">50m<');
    expect(wallPanelHtml({ id: 'w', material: 'drywall' }, ctx)).toContain('25.0 m');
  });
  it('offers every other switch on every floor as an uplink', () => {
    const html = swPanelHtml({ id: 's1', name: 'Core', model: 'USW-24-PoE' }, ctx);
    expect(html).toContain('value="s2"');
    expect(html).not.toMatch(/<option value="s1"/);
  });
});
