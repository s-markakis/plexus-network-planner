// Feature sweep: every toolbar action, editor panel, layer, auto-tool, export
// and import, driven through the UI and checked by its RESULT (the saved
// project, a downloaded file, the DOM it produces) — not only for the absence
// of errors. Complements the scenario specs; anything they already cover in
// depth (simulator, policies, labs, drift, credentials) is only touched here.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {zipRead} from '../../files/src/zip.js';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}
const tmp = (name, data) => { const f = path.join(os.tmpdir(), `plexus-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`); fs.writeFileSync(f, data); return f; };

// The current project, as Save writes it.
async function saved(page) {
  const [d] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="save"]').click()]);
  return JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
}
// A file some action downloads.
async function download(page, run) {
  const [d] = await Promise.all([page.waitForEvent('download'), run()]);
  return {name: d.suggestedFilename(), data: fs.readFileSync(await d.path())};
}
async function sample(page) {
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
}
async function exportMenu(page, action) {
  await page.locator('[data-arg="export-menu"]').click();
  await page.locator(`#export-menu [data-action="${action}"]`).click();
}
async function importMenu(page, action) {
  await page.locator('[data-arg="import-menu"]').click();
  await page.locator(`#import-menu [data-action="${action}"]`).click();
}
async function layer(page, id) {
  await page.locator('[data-arg="layers-menu"]').click();
  await page.locator('#' + id).click();
  await page.locator('#brand-lbl').click();
}
// A point on the map, as fractions of the plan image.
async function mapPoint(page, fx, fy) {
  const b = await page.locator('#mi').boundingBox();
  return {x: b.x + b.width * fx, y: b.y + b.height * fy};
}
async function clickMap(page, fx, fy) { const p = await mapPoint(page, fx, fy); await page.mouse.click(p.x, p.y); }
const modalTitle = (page) => page.locator('#mdl-title');
const closeModal = async (page) => { await page.keyboard.press('Escape'); await expect(page.locator('#mbg')).not.toHaveClass(/vis/); };

test.describe('placing things', () => {
  test('every drawing tool places what it says', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    const before = await saved(page);
    const f0 = before.floors[0];
    await page.locator('#btn-add').click(); await clickMap(page, 0.45, 0.62);
    await page.locator('#btn-dz').click(); await clickMap(page, 0.3, 0.3);
    await page.locator('#btn-sw').click(); await clickMap(page, 0.6, 0.3);
    await page.locator('#btn-cam').click(); await clickMap(page, 0.7, 0.7);
    await page.locator('#btn-wall').click(); await clickMap(page, 0.2, 0.9); await clickMap(page, 0.4, 0.9);
    await page.locator('#btn-anno').click();
    await page.locator('[data-anno-sub="arrow"]').click();
    await clickMap(page, 0.5, 0.1); await clickMap(page, 0.6, 0.15);
    await page.locator('[data-anno-sub="text"]').click();
    await clickMap(page, 0.55, 0.5);
    await page.locator('#mdl-body input[type="text"]').fill('Server rack');
    await page.locator('#mdl-body input[type="text"]').press('Enter');
    const after = (await saved(page)).floors[0];
    expect(after.APS.length).toBe(f0.APS.length + 1);
    expect(after.DZS.length).toBe(f0.DZS.length + 1);
    expect(after.SWS.length).toBe(f0.SWS.length + 1);
    expect(after.CAMS.length).toBe(f0.CAMS.length + 1);
    expect(after.WALLS.length).toBe(f0.WALLS.length + 1);
    expect(after.ANNOS.map((a) => a.kind)).toEqual(expect.arrayContaining(['arrow', 'text']));
    expect(after.ANNOS.find((a) => a.kind === 'text' && a.text === 'Server rack')).toBeTruthy();
    // Simulate mode adds wireless clients.
    await page.locator('[data-uimode-btn="simulate"]').click();
    await page.locator('#btn-client').click(); await clickMap(page, 0.5, 0.5);
    expect((await saved(page)).floors[0].CLIENTS.length).toBe(1);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('ruler measures and calibrate sets the scale from a known length', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('#btn-ruler').click();
    await clickMap(page, 0.3, 0.5); await clickMap(page, 0.7, 0.5);
    await expect(page.locator('.ruler-lbl')).toHaveText(/^\d+(\.\d)? m$/);
    await page.locator('[data-action="calibrate-scale"]').click();
    await expect(modalTitle(page)).toHaveText('Calibrate scale');
    await page.locator('#mdl-body input').fill('20');
    await page.locator('#mdl-ok').click();
    await expect(page.locator('.ruler-lbl')).toHaveText('20.0 m');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('editing', () => {
  test('access point panel: every field reaches the project', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('.list-item', {hasText: 'AP-01'}).click();
    await page.locator('#ep-name').fill('Lobby AP');
    await page.locator('#ep-name').dispatchEvent('input');
    await page.locator('#ep-model').selectOption('U7 Pro');
    await page.locator('#ep-freq').selectOption({index: 1});
    await page.locator('#ep-channel').fill('36'); await page.locator('#ep-channel').dispatchEvent('input');
    await page.locator('#ep-ip').fill('10.0.10.50'); await page.locator('#ep-ip').dispatchEvent('input');
    await page.locator('#ep-mac').fill('aa:bb:cc:00:11:22'); await page.locator('#ep-mac').dispatchEvent('input');
    await page.locator('#ep-notes').fill('Ceiling, 2.7 m'); await page.locator('#ep-notes').dispatchEvent('input');
    await page.locator('[data-action="set-sig"][data-arg="weak"]').click();
    await page.locator('#ep-r').fill('120'); await page.locator('#ep-r').dispatchEvent('input');
    await expect(page.locator('#ep-rv')).toHaveText(/m$/);
    await page.locator('[data-action="suggest-ip-ap"]').click().catch(() => {});
    const ap = (await saved(page)).floors[0].APS.find((a) => a.name === 'Lobby AP');
    expect(ap).toBeTruthy();
    expect(ap.model).toBe('U7 Pro');
    expect(ap.sig).toBe('weak');
    expect(ap.r).toBe(120);
    expect(ap.notes).toBe('Ceiling, 2.7 m');
    expect(ap.mac).toBe('aa:bb:cc:00:11:22');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('switch, camera, dead zone and wall panels', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('.list-item', {hasText: 'SW-01'}).click();
    await page.locator('#sw-name').fill('Core'); await page.locator('#sw-name').dispatchEvent('input');
    await page.locator('#sw-model').selectOption('CRS326-24G-2S+RM');
    await page.locator('#sw-l3').check();
    await page.locator('.list-item', {hasText: 'CAM-01'}).click();
    await page.locator('#cam-fov').fill('110'); await page.locator('#cam-fov').dispatchEvent('input');
    await page.locator('#cam-heading').fill('45'); await page.locator('#cam-heading').dispatchEvent('input');
    await page.locator('.list-item', {hasText: 'Dead Zone 1'}).click();
    await page.locator('#dz-lbl').fill('Lift shaft'); await page.locator('#dz-lbl').dispatchEvent('input');
    await page.locator('.list-item').filter({has: page.locator('.li-name', {hasText: /^Wall 1$/})}).click();
    await page.locator('#wall-mat').selectOption('glass');
    const f = (await saved(page)).floors[0];
    expect(f.SWS[0]).toMatchObject({name: 'Core', model: 'CRS326-24G-2S+RM', role: 'l3'});
    expect(f.CAMS[0]).toMatchObject({fov: 110, heading: 45});
    expect(f.DZS[0].label).toBe('Lift shaft');
    expect(f.WALLS[0].material).toBe('glass');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('duplicate, lock, delete from the panel and from the list, undo and redo', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('.list-item', {hasText: 'AP-01'}).click();
    await page.locator('[data-action="duplicate"]').click();
    await expect(page.locator('.ap-grp')).toHaveCount(4);
    await page.locator('.list-item', {hasText: 'AP-02'}).click();
    await page.locator('input[data-change-action="toggle-lock"]').check();
    expect((await saved(page)).floors[0].APS.find((a) => a.name === 'AP-02').locked).toBe(true);
    await page.locator('.list-item', {hasText: 'AP-03'}).click();
    await page.locator('[data-action="ask-del"]').click();
    await page.locator('#mdl-ok').click();
    await expect(page.locator('.ap-grp')).toHaveCount(3);
    await page.locator('.list-item', {hasText: 'CAM-02'}).hover();
    await page.locator('.list-item', {hasText: 'CAM-02'}).locator('[data-action="quick-del"]').click();
    await page.locator('#mdl-ok').click();                          // the list asks first
    await expect(page.locator('.list-item', {hasText: 'CAM-02'})).toHaveCount(0);
    await page.locator('#btn-undo').click();
    await expect(page.locator('.list-item', {hasText: 'CAM-02'})).toHaveCount(1);
    await page.locator('#btn-redo').click();
    await expect(page.locator('.list-item', {hasText: 'CAM-02'})).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('floors: add, rename, switch, delete', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('[data-action="add-floor"]').click();
    await expect(page.locator('.ftab-name[contenteditable="true"]')).toBeFocused();   // rename starts on its own
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Upstairs'); await page.keyboard.press('Enter');
    await expect(page.locator('.ftab-name')).toHaveText(['Ground Floor', 'Upstairs']);
    await expect(page.locator('.ap-grp')).toHaveCount(0);           // new floor is empty
    await page.locator('.ftab-name', {hasText: 'Ground Floor'}).click();
    await expect(page.locator('.ap-grp')).toHaveCount(3);
    await page.locator('.ftab', {hasText: 'Upstairs'}).hover();
    await page.locator('.ftab', {hasText: 'Upstairs'}).locator('.ftab-del').click();
    await page.locator('#mdl-ok').click();
    await expect(page.locator('.ftab-name')).toHaveText(['Ground Floor']);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('view', () => {
  test('layers, heatmap metrics and bands, zoom, theme, presentation', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    for (const id of ['btn-ol', 'btn-heat', 'btn-grid', 'btn-cables', 'btn-roaming', 'btn-vlan']) {
      await layer(page, id);
      await expect(page.locator('#' + id), id).toHaveClass(/active/);
    }
    await expect(page.locator('.cable-line').first()).toBeVisible();
    // Heatmap paints pixels.
    await expect.poll(() => page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.getElementById('heat-canvas')); if (!c || !c.width) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 3; i < d.length; i += 400) if (d[i]) n++; return n;
    }), {timeout: 10000}).toBeGreaterThan(10);
    await page.locator('[data-arg="layers-menu"]').click();
    const modes = new Set(); const bands = new Set();
    for (let i = 0; i < 6; i++) { modes.add(await page.locator('#heat-mode-pill').textContent()); await page.locator('#heat-mode-pill').click(); }
    for (let i = 0; i < 4; i++) { bands.add(await page.locator('#heat-band-pill').textContent()); await page.locator('#heat-band-pill').click(); }
    expect(modes.size).toBeGreaterThanOrEqual(5);
    expect(bands.size).toBeGreaterThanOrEqual(3);
    await page.locator('#brand-lbl').click();
    // Coverage off hides the rings.
    await layer(page, 'btn-cov');
    await expect(page.locator('.ap-outer')).toHaveCount(0);
    await layer(page, 'btn-cov');
    // Zoom.
    const z0 = await page.locator('#zval').textContent();
    await page.locator('[data-action="zoom-in"]').click();
    expect(await page.locator('#zval').textContent()).not.toBe(z0);
    await page.locator('[data-action="zoom-fit"]').click();
    // Theme.
    await page.locator('[data-action="toggle-theme"]').click();
    await expect(page.locator('body')).toHaveClass(/theme-dark/);
    await page.locator('[data-action="toggle-theme"]').click();
    await expect(page.locator('body')).not.toHaveClass(/theme-dark/);
    // Presentation hides the chrome; Escape brings it back.
    await page.locator('[data-action="toggle-present"]').click();
    await expect(page.locator('.topbar-tools')).toBeHidden();
    await expect(page.locator('#left-sb')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('.topbar-tools')).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('search and status filter narrow the list', async ({page}) => {
    await sample(page);
    await page.locator('#sb-search').fill('CAM');
    await page.locator('#sb-search').dispatchEvent('input');
    // Filtered rows are hidden, not removed.
    await expect(page.locator('.list-item:visible', {hasText: 'AP-01'})).toHaveCount(0);
    await expect(page.locator('.list-item:visible', {hasText: 'CAM-01'})).toHaveCount(1);
    await page.locator('[data-action="sb-search-clear"]').click();
    await expect(page.locator('.list-item:visible', {hasText: 'AP-01'})).toHaveCount(1);
    // In the sample, only CAM-02 is "ordered" (AP-01 is live).
    await page.locator('#sb-status').selectOption('ordered');
    await expect(page.locator('.list-item:visible', {hasText: 'CAM-02'})).toHaveCount(1);
    await expect(page.locator('.list-item:visible', {hasText: 'AP-01'})).toHaveCount(0);
  });

  test('keyboard shortcuts', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    const press = async (k) => { await page.locator('#brand-lbl').click(); await page.keyboard.press(k); };
    for (const [k, id] of [['a', 'btn-add'], ['d', 'btn-dz'], ['w', 'btn-sw'], ['c', 'btn-cam'], ['r', 'btn-ruler'], ['l', 'btn-wall'], ['n', 'btn-anno'], ['s', 'btn-sel']]) {
      await press(k);
      await expect(page.locator('#' + id), `key ${k}`).toHaveClass(/active/);
    }
    for (const [k, id] of [['h', 'btn-heat'], ['g', 'btn-grid'], ['o', 'btn-ol']]) {
      const was = await page.locator('#' + id).getAttribute('class');
      await press(k);
      expect(await page.locator('#' + id).getAttribute('class'), `key ${k}`).not.toBe(was);
    }
    await press('?');
    await expect(modalTitle(page)).toHaveText('Keyboard Shortcuts');
    await closeModal(page);
    await press('m');
    await expect(page.locator('#sim-panel')).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('automatic tools and analysis', () => {
  test('auto-place, auto-channel, auto-power, auto-cable, IPs and names change the plan', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('[data-action="auto-channel"]').click();
    await page.locator('[data-action="auto-power"]').click();
    await page.locator('[data-action="auto-assign-sw"]').click();
    let f = (await saved(page)).floors[0];
    expect(f.APS.every((a) => /^\d+$/.test(String(a.channel)))).toBe(true);
    expect(f.APS.every((a) => Number.isFinite(a.txPowerDbm))).toBe(true);
    expect(f.APS.every((a) => a.swId)).toBe(true);
    // Inventory tools (IPs, naming) live in the Inventory dialog.
    await exportMenu(page, 'show-inventory');
    await expect(modalTitle(page)).toHaveText(/Inventory/);
    await page.locator('#mdl').getByRole('button', {name: 'IP+ all'}).click();
    await page.locator('#mdl').getByRole('button', {name: 'Auto-rename'}).click();
    await closeModal(page);
    f = (await saved(page)).floors[0];
    expect(f.APS.every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a.ip))).toBe(true);
    // Auto-place on an empty floor of the same plan.
    await page.locator('.list-item', {hasText: 'AP-01'}).click();
    for (let i = 0; i < 3; i++) {
      await page.locator('.list-item').filter({hasText: /^AP-0\d/}).first().click();
      await page.locator('[data-action="ask-del"]').click(); await page.locator('#mdl-ok').click();
    }
    await expect(page.locator('.ap-grp')).toHaveCount(0);
    await page.locator('[data-action="auto-place"]').click();
    await expect.poll(() => page.locator('.ap-grp').count()).toBeGreaterThan(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('PoE, topology and validation dialogs report on the plan', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('[data-action="show-poe"]').click();
    await expect(modalTitle(page)).toHaveText('PoE Budget');
    await expect(page.locator('#mdl-body')).toContainText('W');
    await closeModal(page);
    await page.locator('[data-action="show-topology"]').click();
    await expect(modalTitle(page)).toHaveText('Network topology');
    await expect(page.locator('#mdl-body')).toContainText('SW-01');
    await closeModal(page);
    await page.locator('[data-action="show-validation"]').click();
    await expect(modalTitle(page)).toHaveText('Network validation');
    await closeModal(page);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test('choosing a command closes its menu; the Layers menu stays open for its switches', async ({page}) => {
  await sample(page);
  await page.locator('[data-arg="export-menu"]').click();
  await download(page, () => page.locator('#export-menu [data-action="export-bom"]').click());
  await expect(page.locator('#export-menu')).not.toHaveClass(/open/);
  await page.locator('[data-arg="layers-menu"]').click();
  await page.locator('#btn-grid').click();
  await expect(page.locator('#layers-menu')).toHaveClass(/open/);
});

test('ruler, walls and new APs work on top of coverage areas', async ({page}) => {
  const errors = trackErrors(page);
  await sample(page);
  const n0 = (await saved(page)).floors[0];
  // Points inside AP-02's coverage (open office).
  await page.locator('#btn-ruler').click(); await clickMap(page, 0.45, 0.55); await clickMap(page, 0.7, 0.55);
  await expect(page.locator('.ruler-lbl')).toHaveCount(1);
  await page.locator('#btn-wall').click(); await clickMap(page, 0.5, 0.45); await clickMap(page, 0.6, 0.45);
  await page.locator('#btn-add').click(); await clickMap(page, 0.62, 0.62);
  const f = (await saved(page)).floors[0];
  expect(f.WALLS.length).toBe(n0.WALLS.length + 1);
  expect(f.APS.length).toBe(n0.APS.length + 1);
  // In Select, clicking an AP's marker still selects it.
  await page.locator('#btn-sel').click();
  await page.locator('.ap-grp').first().locator('circle.ap-dot, circle.ap-sel-dot').first().click({force: true});
  await expect(page.locator('#rp-head')).toHaveText('Edit AP');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the hidden welcome screen does not catch clicks on the map', async ({page}) => {
  const errors = trackErrors(page);
  await sample(page);
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  // Where the welcome buttons sat: the middle of the map.
  const box = await page.locator('[data-action="new-from-template"]').boundingBox();
  await page.locator('#btn-add').click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#mbg')).not.toHaveClass(/vis/);          // no "New from template" dialog
  await expect(page.locator('.ap-grp')).toHaveCount(4);               // an AP was placed instead
  expect(errors, errors.join('\n')).toEqual([]);
});

test.describe('exports', () => {
  test('every CSV / HTML / zip export downloads real content', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    const bom = await download(page, () => exportMenu(page, 'export-bom'));
    expect(bom.data.toString()).toMatch(/^Kind,Model,Qty/);
    expect(bom.data.toString()).toContain('U6 Pro');
    const cables = await download(page, () => exportMenu(page, 'export-cables'));
    expect(cables.data.toString().split('\n').length).toBeGreaterThan(2);
    const html = await download(page, () => exportMenu(page, 'export'));
    expect(html.data.toString()).toMatch(/<html[\s>]/i);
    expect(html.data.toString()).toContain('AP-01');
    const zip = await download(page, () => exportMenu(page, 'handover-pack'));
    const files = (await zipRead(new Uint8Array(zip.data))).map((e) => e.name);
    expect(files.some((n) => /\.csv$/.test(n))).toBe(true);
    expect(files.some((n) => /\.html$/.test(n))).toBe(true);
    // Inventory dialog exports.
    await exportMenu(page, 'show-inventory');
    for (const label of ['Inventory CSV', 'IP plan CSV', 'Port map CSV']) {
      const d = await download(page, () => page.locator('#mdl').getByRole('button', {name: label}).click());
      expect(d.data.toString().split('\n').length, label).toBeGreaterThan(1);
    }
    await closeModal(page);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('PDF, install sheets and the client report open as documents', async ({page, context}) => {
    const errors = trackErrors(page);
    await sample(page);
    for (const [a, expectText] of [['pdf', 'AP-01'], ['install-sheets', 'AP-01'], ['client-report', 'Acceptance']]) {
      const [w] = await Promise.all([context.waitForEvent('page'), exportMenu(page, a)]);
      await expect(w.locator('body'), a).toContainText(expectText, {timeout: 15000});
      await w.close();
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Ekahau .esx export reimports with the same access points', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    const esx = await download(page, () => exportMenu(page, 'export-esx'));
    expect(esx.name).toMatch(/\.esx$/);
    await page.locator('[data-action="new-project"]').click(); await page.locator('#mdl-ok').click();
    await expect(page.locator('.ap-grp')).toHaveCount(0);
    await page.locator('#esx-up').setInputFiles(tmp('round.esx', esx.data));
    await expect(page.locator('.ap-grp')).toHaveCount(3);              // drawn: the plan image came along
    await expect(page.locator('.ftab-name')).toHaveText(['Ground Floor']);   // no empty "Floor 1" left in front
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('devices are drawn on a plan that finishes loading after the project switch', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    const project = await saved(page);
    await page.locator('[data-action="new-project"]').click(); await page.locator('#mdl-ok').click();
    await page.locator('#load-up').setInputFiles(tmp('again.json', JSON.stringify(project)));
    await expect(page.locator('.ap-grp')).toHaveCount(3);
    await expect(page.locator('.sw-grp')).toHaveCount(1);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('imports', () => {
  test('floor-plan image, SVG walls, DXF walls, survey CSV and wall detection', async ({page}) => {
    const errors = trackErrors(page);
    await page.goto('/');
    // An SVG floor plan with an outline and one interior wall.
    const svgPlan = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#fff"/><rect x="40" y="40" width="720" height="520" fill="none" stroke="#000" stroke-width="10"/><line x1="400" y1="40" x2="400" y2="560" stroke="#000" stroke-width="10"/></svg>';
    await page.locator('#file-up').setInputFiles(tmp('plan.svg', svgPlan));
    await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
    await page.locator('#svg-up').setInputFiles(tmp('walls.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><line x1="40" y1="300" x2="760" y2="300"/><polyline points="100,100 200,100 200,200"/></svg>'));
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '10', '20', '10', '11', '200', '21', '10', '0', 'LINE', '8', '0', '10', '200', '20', '10', '11', '200', '21', '150', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    await page.locator('#dxf-up').setInputFiles(tmp('walls.dxf', dxf));
    await page.locator('#survey-up').setInputFiles(tmp('survey.csv', 'x,y,floor,ssid,bssid,rssi,channel\n0.2,0.2,,Office,,-48,36\n0.5,0.5,,Office,,-63,36\n0.8,0.7,,Office,,-74,36\n'));
    const f = (await saved(page)).floors[0];
    expect(f.WALLS.length).toBeGreaterThanOrEqual(5);           // 3 SVG + 2 DXF
    expect(f.SAMPLES.map((s) => s.rssi)).toEqual([-48, -63, -74]);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('wall detection finds the walls drawn on a floor plan', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    const before = (await saved(page)).floors[0].WALLS.length;
    await importMenu(page, 'detect-walls');
    await expect(modalTitle(page)).toHaveText('Wall detection', {timeout: 20000});   // it previews, then asks
    await expect(page.locator('#mdl-body')).toContainText(/Found \d+ straight wall candidates/);
    await page.locator('#mdl-ok').click();
    await expect(page.locator('#toast')).toContainText(/Added \d+ detected walls/);
    expect((await saved(page)).floors[0].WALLS.length).toBeGreaterThan(before);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a device photo upload is shown in the panel and can be cleared', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('.list-item', {hasText: 'AP-01'}).click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8Dwn4GBgQFEMDAAAPcFAf9Z1hEAAAAASUVORK5CYII=', 'base64');
    await page.locator('#ep-img-file, input[data-change-action="device-img-file"]').first().setInputFiles(tmp('ap.png', png));
    await expect.poll(async () => (await saved(page)).floors[0].APS[0].img || (await saved(page)).floors[0].APS[0].imageUrl || '').toMatch(/^data:image\//);
    await page.locator('[data-action="clear-device-img"]').click();
    const ap = (await saved(page)).floors[0].APS[0];
    expect(ap.img || ap.imageUrl || '').toBe('');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('project lifecycle', () => {
  test('save → open round-trip keeps the whole plan', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    const a = await saved(page);
    await page.locator('[data-action="new-project"]').click(); await page.locator('#mdl-ok').click();
    await expect(page.locator('.ap-grp')).toHaveCount(0);
    await page.locator('#load-up').setInputFiles(tmp('p.json', JSON.stringify(a)));
    await expect(page.locator('.ap-grp')).toHaveCount(3);
    const b = await saved(page);
    const shape = (p) => p.floors.map((f) => [f.APS.length, f.SWS.length, f.CAMS.length, f.WALLS.length, f.DZS.length, f.scaleM]);
    expect(shape(b)).toEqual(shape(a));
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('revisions: save one, change the plan, restore it', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('[data-action="show-revisions"]').click();
    await page.getByRole('button', {name: 'Save current state as new revision'}).click();
    await page.locator('#mdl-body input[type="text"]').fill('before');
    await page.locator('#mdl-body input[type="text"]').press('Enter');
    await page.locator('.list-item', {hasText: 'AP-01'}).click();
    await page.locator('[data-action="ask-del"]').click(); await page.locator('#mdl-ok').click();
    await expect(page.locator('.ap-grp')).toHaveCount(2);
    await page.locator('[data-action="show-revisions"]').click();
    await page.locator('.rev-row', {hasText: 'before'}).getByRole('button', {name: /Restore/}).click();
    await page.locator('#mdl-ok').click();
    await expect(page.locator('.ap-grp')).toHaveCount(3);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a reload offers the previous session back', async ({page}) => {
    await sample(page);
    await page.locator('[data-action="auto-channel"]').click();
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.reload();
    await expect(modalTitle(page)).toHaveText('Restore Previous Session?');
    await page.locator('#mdl-ok').click();
    await expect(page.locator('.ap-grp')).toHaveCount(3);
  });

  test('settings persist into the saved project', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('[data-action="show-settings"]').click();
    const company = page.locator('.settings-card .ep-row', {hasText: 'Company'}).locator('input');
    await company.fill('Acme Networks');
    const height = page.locator('.settings-card .ep-row', {hasText: 'Floor-to-floor height'}).locator('input');
    await height.fill('3.4');
    await page.locator('#mdl-ok').click();
    const s = (await saved(page)).settings;
    expect(s.company).toBe('Acme Networks');
    expect(s.floorHeightM).toBe(3.4);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('custom vendor catalog adds a model to the pickers', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('[data-action="show-plugins"]').click();
    await expect(modalTitle(page)).toHaveText('Custom vendor catalog');
    await closeModal(page);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('simulate and the CLI', () => {
  test('traceroute, blast radius and the device console', async ({page}) => {
    const errors = trackErrors(page);
    await sample(page);
    await page.locator('[data-uimode-btn="simulate"]').click();
    const panel = page.locator('#sim-panel');
    await panel.locator('#sim-from').selectOption({index: 0});
    await panel.locator('#sim-to').selectOption({index: 2});
    await panel.getByRole('button', {name: 'Traceroute'}).click();
    await expect(panel.locator('.sim-verdict')).not.toHaveText('');
    await panel.getByRole('button', {name: 'Blast radius'}).click();
    await expect(panel.locator('.sim-matrix, .sim-blast, .sim-verdict').first()).toBeVisible();
    // CLI console on the switch.
    await page.locator('.list-item', {hasText: 'SW-01'}).click();
    await page.locator('[data-action="open-console"]').click();
    await expect(page.locator('#cli-panel')).toBeVisible();
    const input = page.locator('#cli-panel input').first();
    await input.fill('enable'); await input.press('Enter');
    await input.fill('show vlan brief'); await input.press('Enter');
    await expect(page.locator('#cli-panel')).toContainText(/VLAN|vlan/);
    await page.locator('[data-action="close-console"]').click();
    await expect(page.locator('#cli-panel')).toBeHidden();
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
