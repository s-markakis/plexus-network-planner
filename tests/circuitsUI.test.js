// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mountCircuits } from '../files/src/circuitsUI.js';

const project = () => ({
  settings: {},
  floors: [{ name: 'G', SWS: [{ id: 'core', name: 'Core', uplinkId: '' }, { id: 'acc', name: '<img src=x onerror=alert(1)>', uplinkId: 'core' }],
    APS: [], CAMS: [{ id: 'cam1', name: 'CAM-1', swId: 'acc', port: '7' }] }],
});

function mount(extra = {}) {
  let store = extra.circuits || [];
  const root = document.createElement('div');
  document.body.appendChild(root);
  const setCircuits = vi.fn((c) => { store = c; });
  const api = mountCircuits({ root, getProject: project, getCircuits: () => store, setCircuits, today: () => '2026-11-20', ...extra });
  return { root, api, setCircuits, get store() { return store; } };
}
/** @returns {any} */
const q = (root, sel) => root.querySelector(sel);
const btn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));

describe('circuits dialog', () => {
  it('records a circuit: device pick auto-fills the path, a passive hop is added, saved', () => {
    const m = mount({ getTech: () => 'Nikos' });
    btn(m.root, 'New circuit').click();
    const from = q(m.root, '.ckt-from select');
    from.value = 'cam1'; from.dispatchEvent(new Event('change'));
    expect(m.root.querySelectorAll('.ckt-hoprow')).toHaveLength(3); // cam1, acc:7, core
    btn(m.root, 'Add hop').click();
    const rows = m.root.querySelectorAll('.ckt-hoprow');
    const last = rows[rows.length - 1];
    const [label, port] = last.querySelectorAll('input');
    label.value = 'PP2'; label.dispatchEvent(new Event('input'));
    port.value = '14'; port.dispatchEvent(new Event('input'));
    btn(m.root, 'Save circuit').click();
    expect(m.store).toHaveLength(1);
    expect(m.store[0]).toMatchObject({ name: 'CAM-1', from: 'cam1', tech: 'Nikos', date: '2026-11-20' });
    expect(m.store[0].hops.map((h) => h.ref || h.label)).toEqual(['cam1', 'acc', 'core', 'PP2']);
    // back on the list, searchable
    const search = q(m.root, '.ckt-search');
    search.value = 'pp2'; search.dispatchEvent(new Event('input'));
    expect(m.root.querySelectorAll('.ckt-item')).toHaveLength(1);
    expect(q(m.root, '.ckt-hop.hit').textContent).toBe('PP2 #14');
    search.value = 'zzz'; search.dispatchEvent(new Event('input'));
    expect(m.root.querySelectorAll('.ckt-item')).toHaveLength(0);
  });

  it('refuses to save without hops', () => {
    const m = mount();
    btn(m.root, 'New circuit').click();
    q(m.root, 'input').value = 'empty';
    btn(m.root, 'Save circuit').click();
    expect(m.setCircuits).not.toHaveBeenCalled();
    expect(m.root.textContent).toContain('Add at least one hop');
  });

  const saved = [{ id: 'k', name: 'Pool', from: 'cam1', hops: [{ type: 'device', ref: 'cam1', port: '', label: '', note: '' }, { type: 'device', ref: 'acc', port: '9', label: '', note: '' }, { type: 'device', ref: 'core', port: '', label: '', note: '' }], tech: '', date: '', notes: '' }];

  it('flags drift, focuses a device hop, filters through a device', () => {
    const onFocus = vi.fn();
    const m = mount({ circuits: saved, onFocus, deviceId: 'core' });
    expect(q(m.root, '.ckt-chip')).not.toBeNull();
    expect(q(m.root, '.ckt-drift')).not.toBeNull(); // port 9 vs plan 7
    q(m.root, 'button.ckt-hop').click();
    expect(onFocus).toHaveBeenCalledWith('cam1');
  });

  it('delete is two-step (no native confirm)', () => {
    const m = mount({ circuits: saved });
    const del = q(m.root, '.ckt-del');
    del.click();
    expect(m.setCircuits).not.toHaveBeenCalled();
    del.click();
    expect(m.store).toEqual([]);
  });

  it('renders hostile device names as text only', () => {
    const m = mount({ circuits: saved });
    expect(q(m.root, 'img')).toBeNull();
    expect(m.root.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
