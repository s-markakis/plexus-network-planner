// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { inventoryEl } from '../files/src/inventoryUI.js';
import { DEVICE_STATUS_META } from '../files/src/constants.js';

const floor = { name: 'G', SWS: [], APS: [], CAMS: [] };
const devs = [{ dev: { id: 'a', name: '<img src=x onerror=alert(1)>', status: 'planned' }, type: 'AP', floor, floorIdx: 0 },
  { dev: { id: 'b', name: 'B', status: 'live' }, type: 'AP', floor, floorIdx: 0 }];
const statusMeta = (d) => DEVICE_STATUS_META[d.status] || DEVICE_STATUS_META.planned;
const mount = (onStatus = (d, s) => { d.status = s; }) => inventoryEl(document, { devices: devs, statusMeta, onStatus, onOpen: vi.fn(),
  actions: { ipAll() {}, rename() {}, inventoryCsv() {}, ipPlanCsv() {}, portMapCsv() {}, handover() {} } });

describe('inventory dialog', () => {
  it('progress updates after an inline status change', () => {
    const el = mount();
    expect(el.textContent).toContain('50% tested/live');
    const sel = /** @type {HTMLSelectElement} */ (el.querySelector('tbody select'));
    sel.value = 'tested'; sel.dispatchEvent(new Event('change'));
    expect(el.textContent).toContain('100% tested/live');
  });
  it('renders hostile names as text', () => {
    const el = mount();
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
