// Security E2E for the 2026-11 audit: fields from an (untrusted) project file
// must render as text, saved revisions must never leak credentials around the
// vault, and a share link must not load without the user's consent.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const XSS = '"><img src=x onerror="window.__xss=1">';
const SECRET = 'S3cret-Device-Pass';

// Sample project → file on disk, after `mutate(project)`.
async function sampleFile(page, mutate, name) {
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="save"]').click(),
  ]);
  const project = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  mutate(project);
  const file = path.join(os.tmpdir(), `plexus-e2e-${name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(project));
  return file;
}

async function reload(page, file) {
  await page.locator('[data-action="new-project"]').click();
  await page.locator('[data-action="modal-ok"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(0);
  await page.locator('#load-up').setInputFiles(file);
  await expect(page.locator('.ap-grp')).toHaveCount(3);
}

test('hostile device names/MACs render as text, not markup', async ({page}) => {
  const file = await sampleFile(page, (p) => {
    for (const ap of p.floors[0].APS) { ap.name = XSS; ap.mac = XSS; }
    for (const dz of p.floors[0].DZS || []) dz.label = XSS;
  }, 'xss');
  await reload(page, file);

  await page.locator('.ap-grp').first().dispatchEvent('mousedown');
  await page.locator('.ap-grp').first().dispatchEvent('mouseup');
  await page.locator('.ap-grp').first().click({force: true});
  await expect(page.locator('#ep-name')).toHaveValue(XSS);
  await expect(page.locator('#ep-mac')).toHaveValue(XSS);

  if (await page.locator('.dz-grp').count()) {
    await page.locator('.dz-grp').first().click({force: true});
    await expect(page.locator('#dz-lbl')).toHaveValue(XSS);
  }
  await page.waitForTimeout(200);       // give an injected onerror time to fire
  expect(await page.evaluate(() => /** @type {any} */(window).__xss)).toBeUndefined();
  fs.rmSync(file, {force: true});
});

test('encrypted save keeps credentials out of revision snapshots', async ({page}) => {
  const creds = {proto: 'ssh', host: '', port: '', user: 'admin', pass: SECRET, key: ''};
  const file = await sampleFile(page, (p) => {
    p.floors[0].APS[0].creds = creds;
    // A revision written by an older build: its snapshot still carries creds.
    const legacy = JSON.parse(JSON.stringify(p.floors));
    for (const f of legacy) delete f.img;
    p.revisions = [{id: 'rev900', name: 'legacy', createdAt: new Date().toISOString(), baseline: false, snapshot: legacy}];
  }, 'creds');
  await reload(page, file);

  // New revision through the UI (name comes from a prompt()).
  page.once('dialog', d => d.accept('rev e2e'));
  await page.locator('[data-action="show-revisions"]').click();
  await page.getByRole('button', {name: 'Save current state as new revision'}).click();

  // Set a credentials passphrase in Settings.
  await page.locator('[data-action="show-settings"]').click();
  await page.locator('input[placeholder="blank = store credentials unencrypted"]').fill('vault-pass');
  await page.locator('[data-action="modal-ok"]').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="save"]').click(),
  ]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  const saved = JSON.parse(text);
  expect(saved.credsVault, 'creds must be in the vault').toBeTruthy();
  expect(saved.revisions).toHaveLength(2);
  expect(text.includes(SECRET), 'plaintext password must not appear anywhere in the file').toBe(false);
  expect(text.includes('"creds"'), 'no inline creds objects, incl. inside revisions').toBe(false);
  fs.rmSync(file, {force: true});
});

test('share link asks before replacing the session', async ({page}) => {
  const project = {version: 11, settings: {}, floors: [{id: 'f1', name: 'LinkFloor', APS: [], DZS: [], SWS: [], CAMS: [], WALLS: []}]};
  const hash = '#p=' + zlib.gzipSync(JSON.stringify(project)).toString('base64url');

  let asked = '';
  page.once('dialog', d => { asked = d.message(); d.dismiss(); });
  await page.goto('/' + hash);
  await expect.poll(() => asked).toMatch(/Open the project embedded in this link/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  await expect(page.locator('#floor-tabs')).not.toContainText('LinkFloor');

  // A hash-only change is a same-document navigation; leave the page first.
  await page.goto('about:blank');
  page.once('dialog', d => d.accept());
  await page.goto('/' + hash);
  await expect(page.locator('#floor-tabs')).toContainText('LinkFloor');
});
