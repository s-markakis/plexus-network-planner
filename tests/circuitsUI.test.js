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
    // A new hop lands after the end device, before its switch.
    const rows = m.root.querySelectorAll('.ckt-hoprow');
    expect(rows).toHaveLength(4);
    const [label, port] = rows[1].querySelectorAll('input');
    label.value = 'PP2'; label.dispatchEvent(new Event('input'));
    port.value = '14'; port.dispatchEvent(new Event('input'));
    btn(m.root, 'Save circuit').click();
    expect(m.store).toHaveLength(1);
    expect(m.store[0]).toMatchObject({ name: 'CAM-1', from: 'cam1', tech: 'Nikos', date: '2026-11-20' });
    expect(m.store[0].hops.map((h) => h.ref || h.label)).toEqual(['cam1', 'PP2', 'acc', 'core']);
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

describe('circuits dialog — tools', () => {
  const recorded = (extra = {}) => ({ id: 'k', name: 'Pool', from: 'cam1', hops: [
    { type: 'device', ref: 'cam1', port: '', label: '', note: '' },
    { type: 'patch', ref: '', port: '14', label: 'PP1', note: '' },
    { type: 'device', ref: 'acc', port: '7', label: '', note: '' },
    { type: 'device', ref: 'core', port: '', label: '', note: '' }], tech: '', date: '2026-11-19', notes: '', ...extra });

  it('inserts a hop below any row', () => {
    const m = mount({ circuits: [recorded()] });
    btn(m.root, 'Edit').click();
    /** @type {HTMLButtonElement} */ (m.root.querySelectorAll('.ckt-insert')[1]).click();   // below PP1
    expect([.../** @type {NodeListOf<HTMLSelectElement>} */ (m.root.querySelectorAll('.ckt-hoprow select:first-child'))].map((s) => s.value))
      .toEqual(['device', 'patch', 'patch', 'device', 'device']);
  });

  it('creates circuits for every cabled AP/camera without one', () => {
    const m = mount({ getTech: () => 'Nikos' });
    btn(m.root, 'Create for all devices').click();
    expect(m.store).toHaveLength(1);
    expect(m.store[0]).toMatchObject({ from: 'cam1', tech: 'Nikos', date: '2026-11-20' });
    expect(q(m.root, '.ckt-flash').textContent).toMatch(/Created 1 circuit/);
    btn(m.root, 'Create for all devices').click();               // idempotent
    expect(m.store).toHaveLength(1);
    expect(q(m.root, '.ckt-flash').textContent).toMatch(/Created 0 circuit.*1 already had one/);
  });

  it('updates a drifted circuit from the plan, keeping passive hops', () => {
    const drifted = recorded();
    drifted.hops[2] = { ...drifted.hops[2], port: '9' };
    const m = mount({ circuits: [drifted] });
    expect(q(m.root, '.ckt-drift')).not.toBeNull();
    q(m.root, '.ckt-update').click();
    expect(m.store[0].hops.map((h) => h.ref || h.label)).toEqual(['cam1', 'PP1', 'acc', 'core']);
    expect(m.store[0].hops[2].port).toBe('7');
    expect(q(m.root, '.ckt-drift')).toBeNull();
    expect(q(m.root, '.ckt-update')).toBeNull();
  });

  it('shows conflicts on each circuit involved', () => {
    const m = mount({ circuits: [recorded(), recorded({ id: 'j', name: 'Other', from: '' })] });
    expect(m.root.querySelectorAll('.ckt-conflict')).toHaveLength(2);
    expect(q(m.root, '.ckt-summary').textContent).toContain('1 conflict');
  });

  it('delete offers Undo; meta reads well without a technician', () => {
    const undo = vi.fn();
    const m = mount({ circuits: [recorded()], undo });
    expect(q(m.root, '.ckt-meta').textContent).toBe('Recorded 2026-11-19');
    const del = q(m.root, '.ckt-del'); del.click(); del.click();
    expect(m.store).toEqual([]);
    btn(m.root, 'Undo').click();
    expect(undo).toHaveBeenCalled();
  });

  it('export, map and label buttons call the app', () => {
    const circuitsCsv = vi.fn(), patchCsv = vi.fn(), labels = vi.fn(), onShowPath = vi.fn();
    const m = mount({ circuits: [recorded()], exports: { circuitsCsv, patchCsv, labels }, onShowPath });
    btn(m.root, 'Circuits CSV').click(); btn(m.root, 'Patch schedule').click(); btn(m.root, 'Cable labels').click();
    q(m.root, '.ckt-map').click();
    expect([circuitsCsv, patchCsv, labels].every((f) => f.mock.calls.length === 1)).toBe(true);
    expect(onShowPath).toHaveBeenCalledWith(expect.objectContaining({ id: 'k' }));
    const bare = mount({ circuits: [recorded()] });
    expect(btn(bare.root, 'Circuits CSV')).toBeUndefined();     // only when provided
  });

  it('suggests labels already used for that hop type', () => {
    const m = mount({ circuits: [recorded()] });
    btn(m.root, 'New circuit').click();
    btn(m.root, 'Add hop').click();
    const input = q(m.root, '.ckt-hoprow input');
    expect(input.getAttribute('list')).toBe('ckt-dl-patch');
    expect([...q(m.root, '#ckt-dl-patch').options].map((o) => o.value)).toEqual(['PP1']);
  });

  describe('hop photos', () => {
    const fakePhotos = () => {
      let n = 0;
      return { put: vi.fn(async () => `img_t_${++n}`), src: vi.fn(async () => 'data:image/png;base64,AA=='), release: vi.fn() };
    };
    const pick = async (root, photos) => {
      const file = q(root, '.ckt-photo-in');
      Object.defineProperty(file, 'files', { value: [new Blob(['x'], { type: 'image/png' })] });
      file.dispatchEvent(new Event('change'));
      await Promise.resolve(); await Promise.resolve();
      expect(photos.put).toHaveBeenCalled();
    };
    it('adds a photo to a hop and saves it on the record', async () => {
      const photos = fakePhotos();
      const m = mount({ circuits: [recorded()], photos });
      btn(m.root, 'Edit').click();
      await pick(m.root, photos);
      expect(q(m.root, '.ckt-thumb')).not.toBeNull();
      btn(m.root, 'Save changes').click();
      expect(m.store[0].hops[0].imgId).toBe('img_t_1');
      expect(photos.release).not.toHaveBeenCalled();
      expect(q(m.root, '.ckt-has-photo')).not.toBeNull();         // marked in the list
    });
    it('Back releases a photo that was never saved', async () => {
      const photos = fakePhotos();
      const m = mount({ circuits: [recorded()], photos });
      btn(m.root, 'Edit').click();
      await pick(m.root, photos);
      btn(m.root, 'Back').click();
      expect(photos.release).toHaveBeenCalledWith('img_t_1');
      expect(m.setCircuits).not.toHaveBeenCalled();
    });
    it('removing a saved photo releases it on save; deleting a circuit releases its photos', () => {
      const photos = fakePhotos();
      const withPhoto = recorded();
      withPhoto.hops[1] = { ...withPhoto.hops[1], imgId: 'img_old_1' };
      const m = mount({ circuits: [withPhoto], photos });
      btn(m.root, 'Edit').click();
      q(m.root, '.ckt-photo-rm').click();
      btn(m.root, 'Save changes').click();
      expect(photos.release).toHaveBeenCalledWith('img_old_1');
      expect(m.store[0].hops[1].imgId).toBeUndefined();
      const photos2 = fakePhotos();
      const m2 = mount({ circuits: [withPhoto], photos: photos2 });
      const del = q(m2.root, '.ckt-del'); del.click(); del.click();
      expect(m2.root.textContent).toContain('Deleted Pool');
      expect(photos2.release).toHaveBeenCalledWith('img_old_1');
    });
  });
});
