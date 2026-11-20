// Circuits, end to end: reachable from Design, the device panel and the context
// menu; undoable; traced on the map; checked by Validate; carried into every
// deliverable (CSVs, handover pack, technical report, cable labels); and hop
// photos that travel inside the saved file to another browser.
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
const tmp = (name, data) => { const f = path.join(os.tmpdir(), `plexus-ckt-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`); fs.writeFileSync(f, data); return f; };
// A real, decodable 1×1 PNG (the app downscales photos through a canvas).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

async function saved(page) {
  const [d] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="save"]').click()]);
  return JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
}
async function download(page, run) {
  const [d] = await Promise.all([page.waitForEvent('download'), run()]);
  return {name: d.suggestedFilename(), data: fs.readFileSync(await d.path())};
}
async function sample(page) {
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
}
async function openFile(page, project) {
  await page.locator('[data-action="new-project"]').click(); await page.locator('#mdl-ok').click();
  await page.locator('#load-up').setInputFiles(tmp('p.json', JSON.stringify(project)));
  await expect(page.locator('.ap-grp')).toHaveCount(3);
}
const byName = (list, name) => list.find((d) => d.name === name);
// The sample plan, saved, with circuits added the way a technician's file
// would carry them.
async function sampleWithCircuits(page, make) {
  await sample(page);
  const p = await saved(page);
  const f = p.floors[0];
  const ids = {cam1: byName(f.CAMS, 'CAM-01').id, cam2: byName(f.CAMS, 'CAM-02').id, ap1: byName(f.APS, 'AP-01').id, sw: byName(f.SWS, 'SW-01').id};
  p.settings.circuits = make(ids);
  await openFile(page, p);
  return ids;
}
const dev = (ref, port = '') => ({type: 'device', ref, port, label: '', note: ''});
const pp = (label, port) => ({type: 'patch', ref: '', port, label, note: ''});
const twoOnPP1 = (i) => [
  {id: 'c1', name: 'CAM-02 run', from: i.cam2, hops: [dev(i.cam2), pp('PP1', '14'), dev(i.sw, '6')], tech: 'Nikos', date: '2026-11-20', notes: ''},
  {id: 'c2', name: 'AP-01 run', from: i.ap1, hops: [dev(i.ap1), pp('pp-1', '14'), dev(i.sw, '1')], tech: '', date: '', notes: ''},
];
const openCircuits = (page) => page.locator('[data-action="show-circuits"]').click();
// A circuit's list item by its exact name (another item's conflict line may
// mention the same name).
const item = (page, name) => page.locator('.ckt-item').filter({has: page.locator('.ckt-name', {hasText: new RegExp(`^${name}$`)})});

test('Circuits is in Design and Simulate', async ({page}) => {
  await sample(page);
  await expect(page.locator('[data-action="show-circuits"]')).toBeVisible();
  await page.locator('[data-uimode-btn="simulate"]').click();
  await expect(page.locator('[data-action="show-circuits"]')).toBeVisible();
});

test('record a circuit from the context menu; the panel and menu count it', async ({page}) => {
  const errors = trackErrors(page);
  await sample(page);
  // Right-click AP-02's dot by position: once selected its dot changes class
  // and pulses, which Playwright never considers "stable" for a click.
  const id = await page.locator('.ap-grp').nth(1).getAttribute('data-id');
  const rightClickAp = async () => {
    const p = await page.locator(`.ap-grp[data-id="${id}"] circle[class$="dot"]`).first()
      .evaluate((e) => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
    await page.mouse.click(p.x, p.y, {button: 'right'});
  };
  await rightClickAp();
  await page.locator('#ctx-menu').getByText('Record a circuit…').click();
  await expect(page.locator('.ckt-hoprow')).toHaveCount(2);            // AP-02 → SW-01 port 2
  await page.getByRole('button', {name: /Add hop/}).click();
  const row = page.locator('.ckt-hoprow').nth(1);                      // after the AP, before the switch
  await row.locator('input').first().fill('PP1');
  await row.locator('input.ckt-port').fill('2');
  await page.getByRole('button', {name: 'Save circuit'}).click();
  await expect(page.locator('.ckt-item')).toHaveCount(1);
  await expect(page.locator('.ckt-path')).toContainText('AP-02→PP1 #2→SW-01 port 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('#rp-body .rp-ckt')).toContainText('Circuits: 1');
  await rightClickAp();
  await expect(page.locator('#ctx-menu')).toContainText('Circuits through this (1)');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('bulk creation is undoable — in the dialog and with Ctrl+Z', async ({page}) => {
  await sample(page);
  await openCircuits(page);
  await page.getByRole('button', {name: 'Create for all devices'}).click();
  await expect(page.locator('.ckt-flash')).toContainText('Created 5 circuit(s)');
  await expect(page.locator('.ckt-item')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await openCircuits(page);
  await expect(page.locator('.ckt-summary')).toHaveText('No circuits recorded yet.');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+y');                         // redo brings them back
  await openCircuits(page);
  await expect(page.locator('.ckt-item')).toHaveCount(5);
  // and a deletion can be undone from inside the dialog
  const del = page.locator('.ckt-del').first();
  await del.click(); await del.click();
  await expect(page.locator('.ckt-item')).toHaveCount(4);
  await page.locator('.ckt-flash').getByRole('button', {name: 'Undo'}).click();
  await expect(page.locator('.ckt-item')).toHaveCount(5);
});

test('a circuit is traced on the map; Escape clears it', async ({page}) => {
  await sampleWithCircuits(page, twoOnPP1);
  await openCircuits(page);
  await item(page, 'CAM-02 run').locator('.ckt-map').click();
  await expect(page.locator('#mdl')).toBeHidden();
  await expect(page.locator('#ckt-layer path.ckt-hl-line')).toHaveCount(1);
  await expect(page.locator('#ckt-layer circle.ckt-hl-ring')).toHaveCount(2);   // CAM-02 and SW-01
  await page.keyboard.press('Escape');
  await expect(page.locator('#ckt-layer > *')).toHaveCount(0);
});

test('Validate reports a patch position used by two circuits', async ({page}) => {
  await sampleWithCircuits(page, twoOnPP1);
  await expect(async () => {
    await openCircuits(page);
    await expect(page.locator('.ckt-conflict')).toHaveCount(2);
  }).toPass();
  await page.keyboard.press('Escape');
  await page.locator('[data-action="show-validation"]').click();
  await expect(page.locator('#mdl-body')).toContainText('Patch panel PP1 #14 is on 2 circuits: CAM-02 run, AP-01 run');
});

test('circuits reach every deliverable', async ({page}) => {
  await sampleWithCircuits(page, twoOnPP1);
  await openCircuits(page);
  const c = await download(page, () => page.getByRole('button', {name: /Circuits CSV/}).click());
  expect(c.name).toBe('circuits.csv');
  expect(c.data.toString()).toContain('CAM-02 run,CAM-02,cam,');
  const ps = await download(page, () => page.getByRole('button', {name: /Patch schedule/}).click());
  const lines = ps.data.toString().split('\n');
  expect(lines[0]).toBe('Switch,Port,Patch panel,Outlet,Cable,Device,Circuit');
  expect(lines[1].startsWith('SW-01,1,')).toBe(true);                 // rack order
  expect(lines[2]).toBe('SW-01,6,PP1 #14,,,CAM-02,CAM-02 run');
  const [labels] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', {name: /Cable labels/}).click()]);
  await expect(labels.locator('.lbl')).toHaveCount(4);
  await labels.close();
  await page.keyboard.press('Escape');
  // handover pack
  await page.locator('[data-arg="export-menu"]').click();
  const zip = await download(page, () => page.locator('#export-menu [data-action="handover-pack"]').click());
  const names = (await zipRead(new Uint8Array(zip.data))).map((e) => e.name);
  expect(names).toEqual(expect.arrayContaining(['circuits.csv', 'patch-schedule.csv']));
  // technical report
  await page.locator('[data-arg="export-menu"]').click();
  const [report] = await Promise.all([page.waitForEvent('popup'), page.locator('#export-menu [data-action="pdf"]').click()]);
  await expect(report.locator('body')).toContainText('Circuits & patch schedule');
  await expect(report.locator('body')).toContainText('PP1 #14');
});

test('a hop photo travels inside the saved file to a fresh browser', async ({page, browser}) => {
  const errors = trackErrors(page);
  await sampleWithCircuits(page, twoOnPP1);
  await openCircuits(page);
  await item(page, 'CAM-02 run').getByRole('button', {name: 'Edit'}).click();
  await page.locator('.ckt-hoprow').nth(1).locator('.ckt-photo-in').setInputFiles({name: 'pp1.png', mimeType: 'image/png', buffer: PNG});
  await expect(page.locator('.ckt-hoprow').nth(1).locator('.ckt-thumb')).toBeVisible();
  await page.getByRole('button', {name: 'Save changes'}).click();
  await expect(item(page, 'CAM-02 run').locator('.ckt-has-photo')).toHaveCount(1);
  await page.keyboard.press('Escape');
  const file = await saved(page);
  const hop = file.settings.circuits.find((c) => c.id === 'c1').hops[1];
  expect(hop.img).toMatch(/^data:image\/(webp|jpeg|png);base64,/);
  // Another laptop: an empty browser profile (no IndexedDB images).
  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await other.locator('#load-up').setInputFiles(tmp('p.json', JSON.stringify(file)));
  await expect(other.locator('.ap-grp')).toHaveCount(3);
  await other.locator('[data-action="show-circuits"]').click();
  await item(other, 'CAM-02 run').locator('button.ckt-hop', {hasText: 'PP1'}).click();
  await expect(other.locator('.ckt-photo-full')).toHaveAttribute('src', /^data:image\//);
  expect(errors, errors.join('\n')).toEqual([]);
});
