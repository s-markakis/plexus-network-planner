// Desktop E2E: project files through the native bridge. The Open/Save dialogs
// are stubbed in the main process (they are modal OS windows); everything else
// — IPC, the path gate, the atomic write, the recents list, the window title —
// is the real thing, in an isolated profile.
import {test, expect, _electron as electron} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir; let app; let page;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-desktop-'));
  app = await electron.launch({args: [ROOT, `--user-data-dir=${path.join(dir, 'profile')}`]});
  page = await app.firstWindow();
  await page.waitForSelector('[data-action="load-sample"]');
});
test.afterEach(async () => {
  await app.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

// Make the next native dialogs answer with these paths (undefined = cancel).
const stubDialogs = (save, open) => app.evaluate(({dialog}, {save, open}) => {
  dialog.showSaveDialog = async () => (save ? {canceled: false, filePath: save} : {canceled: true});
  dialog.showOpenDialog = async () => (open ? {canceled: false, filePaths: [open]} : {canceled: true, filePaths: []});
}, {save, open});
const menu = (action, arg) => app.evaluate(({BrowserWindow}, m) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', m), {action, arg});

test('Save As writes the file, Save writes back to it, Open Recent reopens it', async () => {
  const file = path.join(dir, 'site.plexus.json');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);

  // First save has no file yet → the Save dialog.
  await stubDialogs(file, undefined);
  await page.locator('[data-action="save"]').click();
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(first.floors[0].APS).toHaveLength(3);
  await expect.poll(() => page.title()).toBe('site.plexus.json — Plexus');

  // Edit → the title shows it is unsaved; Save writes straight back (the dialog
  // would now cancel, so a second prompt would leave the file unchanged).
  await stubDialogs(undefined, undefined);
  await page.locator('[data-action="auto-channel"]').click();
  await expect.poll(() => page.title()).toBe('• site.plexus.json — Plexus');
  await menu('save');
  await expect.poll(() => page.title()).toBe('site.plexus.json — Plexus');
  const second = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(second.floors[0].APS.map(a => a.channel)).not.toEqual(first.floors[0].APS.map(a => a.channel));
  expect(fs.readdirSync(dir).filter(n => n.includes('.tmp'))).toEqual([]);

  // New project, then reopen from the recent list.
  await menu('new');
  await page.locator('[data-action="modal-ok"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(0);
  await expect.poll(() => page.title()).not.toContain('site.plexus.json');
  const recents = await page.evaluate(() => /** @type {any} */(window).plexusNative.projectRecents());
  expect(recents.map(r => r.name)).toEqual(['site.plexus.json']);
  await menu('open-recent', file);
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  await expect.poll(() => page.title()).toBe('site.plexus.json — Plexus');
});

test('Open reads the picked file; a cancelled dialog changes nothing', async () => {
  const file = path.join(dir, 'other.json');
  fs.writeFileSync(file, JSON.stringify({version: 11, settings: {}, floors: [{id: 'f1', name: 'FromDisk',
    APS: [{id: 'ap1', name: 'AP-01', fx: 0.5, fy: 0.5, r: 80}], DZS: [], SWS: [], CAMS: [], WALLS: []}]}));
  await stubDialogs(undefined, undefined);
  await menu('open');
  await expect(page.locator('.ftab-name').first()).not.toHaveText('FromDisk');
  await stubDialogs(undefined, file);
  await menu('open');
  await expect(page.locator('.ftab-name').first()).toHaveText('FromDisk');
});

test('the renderer cannot read or write paths the user never picked', async () => {
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'PRIVATE');
  const res = await page.evaluate(async (p) => {
    const n = /** @type {any} */(window).plexusNative;
    return {read: await n.projectOpenRecent(p), write: await n.projectSave({path: p, text: 'pwned'})};
  }, secret);
  expect(res.read.ok).toBe(false);
  expect(res.read.text).toBeUndefined();
  expect(res.write.ok).toBe(false);
  expect(fs.readFileSync(secret, 'utf8')).toBe('PRIVATE');
});
