// Regression E2E for the 2026-11-15 bug sweep. Each test pins one bug that
// shipped: scale clamped at 1 m/100px, a toolbar row painting over the Layers
// menu, encrypted credentials dropped on save, undo crossing project
// boundaries, and prompt()-based dialogs (absent in Electron).
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {encryptObject} from '../../files/src/crypto.js';

const SECRET = 'S3cret-Regression-Pass';
const MAP = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500"><rect width="2000" height="1500" fill="#fff"/></svg>').toString('base64');

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

function plan(extra = {}) {
  return {version: 11, settings: {}, revisions: [], ...extra,
    floors: [{id: 'f1', name: 'Ground', img: MAP, scaleM: 1,
      APS: [{id: 'ap1', name: 'AP-01', model: 'U6 Pro', fx: 0.5, fy: 0.5, r: 2500, locked: false}],
      DZS: [], SWS: [], CAMS: [], WALLS: []}]};
}

async function loadPlan(page, p) {
  const file = path.join(os.tmpdir(), `plexus-e2e-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(p));
  await page.goto('/');
  await page.locator('#load-up').setInputFiles(file);
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  fs.rmSync(file, {force: true});
}

async function savedProject(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="save"]').click(),
  ]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  return {text, data: JSON.parse(text)};
}

test('scale below 1 m/100px sticks and keeps device ranges in metres', async ({page}) => {
  const errors = trackErrors(page);
  await loadPlan(page, plan());          // 1 m/100px, AP radius 2500 px = 25 m
  // 10 m over 1300 px → 0.769 m/100px. The old clamp forced this back to 1,
  // so the same span re-measured as 13 m.
  await page.locator('#scale-m').fill('0.769');
  await expect(page.locator('#scale-m')).toHaveValue('0.769');
  const {data} = await savedProject(page);
  const f = data.floors[0];
  expect(f.scaleM).toBeCloseTo(0.769, 6);
  expect(1300 * f.scaleM / 100).toBeCloseTo(10, 1);
  // The AP still reaches 25 m, so its pixel radius grew with the finer scale.
  expect(f.APS[0].r * f.scaleM / 100).toBeCloseTo(25, 6);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Layers menu is not painted over by the floor-tabs row', async ({page}) => {
  await page.setViewportSize({width: 900, height: 800});   // narrow: the toolbar wraps
  await page.goto('/');
  await page.locator('[data-arg="layers-menu"]').click();
  for (const id of ['btn-cov', 'btn-ol', 'btn-heat']) {
    const hit = await page.evaluate((elId) => {
      const b = document.getElementById(elId).getBoundingClientRect();
      const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!t && !!t.closest('#' + elId);
    }, id);
    expect(hit, `${id} must be the topmost element at its own centre`).toBe(true);
  }
});

test('a vault left locked survives a save; unlocking re-encrypts without plaintext', async ({page}) => {
  const vault = await encryptObject({ap1: {proto: 'ssh', host: '', port: '', user: 'admin', pass: SECRET, key: ''}}, 'right-pass');
  await loadPlan(page, plan({credsVault: vault}));

  // Cancel the unlock prompt, then save: the vault must come back untouched.
  await expect(page.locator('#mdl-body input[type="password"]')).toBeVisible();
  await page.locator('#mdl .mdl-actions .btn:not(#mdl-ok)').click();
  let saved = await savedProject(page);
  expect(saved.data.credsVault, 'locked vault must be kept').toEqual(vault);

  // The autosave keeps it too, and never holds the plaintext.
  const auto = await page.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); return localStorage.getItem('plexus_autosave'); });
  expect(JSON.parse(auto).credsVault).toEqual(vault);
  expect(auto.includes(SECRET)).toBe(false);

  // Wrong passphrase from Settings: still locked, still kept.
  await page.locator('[data-action="show-settings"]').click();
  await page.locator('input[placeholder="blank = store credentials unencrypted"]').fill('wrong-pass');
  await page.locator('[data-action="modal-ok"]').click();
  await page.waitForTimeout(1500);       // PBKDF2 + GCM failure
  saved = await savedProject(page);
  expect(saved.data.credsVault).toEqual(vault);

  // Right passphrase: unlocked, and the next save re-seals with a fresh vault.
  await page.locator('[data-action="show-settings"]').click();
  await page.locator('input[placeholder="blank = store credentials unencrypted"]').fill('right-pass');
  await page.locator('[data-action="modal-ok"]').click();
  await expect.poll(async () => (await savedProject(page)).data.credsVault.ct, {timeout: 15000}).not.toBe(vault.ct);
  saved = await savedProject(page);
  expect(saved.text.includes(SECRET)).toBe(false);
  expect(saved.text.includes('"creds"')).toBe(false);
});

test('undo history does not cross into the next project', async ({page}) => {
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  await page.locator('[data-action="auto-channel"]').click();        // snapshot() → undo enabled
  await expect(page.locator('#btn-undo')).toBeEnabled();
  await loadPlan2(page);
  await expect(page.locator('#btn-undo')).toBeDisabled();
  await expect(page.locator('.ap-grp')).toHaveCount(1);
});

// Load a second project without navigating (navigation would reset the page).
async function loadPlan2(page) {
  const file = path.join(os.tmpdir(), `plexus-e2e-reg2-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(plan()));
  await page.locator('#load-up').setInputFiles(file);
  await expect(page.locator('.ftab-name').first()).toHaveText('Ground');
  fs.rmSync(file, {force: true});
}

test('new revision uses an in-app dialog and no window.prompt()', async ({page}) => {
  let nativeDialog = false;
  page.on('dialog', d => { nativeDialog = true; d.dismiss(); });
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  await page.locator('[data-action="show-revisions"]').click();
  await page.getByRole('button', {name: 'Save current state as new revision'}).click();
  const input = page.locator('#mdl-body input[type="text"]');
  await expect(input).toHaveValue('rev A');
  await input.fill('walk-through');
  await input.press('Enter');
  await expect(page.locator('#mbg')).not.toHaveClass(/vis/);
  const {data} = await savedProject(page);
  expect(data.revisions.map(r => r.name)).toEqual(['walk-through']);
  expect(nativeDialog).toBe(false);
});

test('wide dialogs are not clipped at their edges', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await loadPlan(page, plan());
  await page.locator('[data-uimode-btn="simulate"]').click();
  await page.locator('[data-action="show-policies"]').click();
  await page.waitForTimeout(500);
  const clipped = await page.evaluate(() => {
    const b = document.getElementById('mdl-body');
    return b.scrollWidth > b.clientWidth + 1;
  });
  expect(clipped, 'the policies dialog must fit its content').toBe(false);
  await page.keyboard.press('Escape');
  await page.locator('[data-uimode-btn="design"]').click();
  await page.locator('[data-arg="export-menu"]').click();
  await page.locator('[data-action="device-config"]').click();
  await page.waitForTimeout(500);
  const clipped2 = await page.evaluate(() => {
    const b = document.getElementById('mdl-body');
    return b.scrollWidth > b.clientWidth + 1;
  });
  expect(clipped2, 'the device-config dialog must fit its content').toBe(false);
});

test('the toolbar always says Plexus, whatever the report company is', async ({page}) => {
  const p = plan(); p.settings = {company: 'Some Installer Ltd'};
  await loadPlan(page, p);
  await expect(page.locator('#brand-lbl')).toHaveText(/^Plexus/);
  await expect(page.locator('#brand-lbl')).not.toContainText('Some Installer');
});

test('a router with built-in WiFi covers the floor; switching its radio off removes it', async ({page}) => {
  const errors = trackErrors(page);
  const p = plan();
  p.floors[0].scaleM = 2;
  p.floors[0].APS = [];
  p.floors[0].SWS = [{id: 'sw1', name: 'Router', model: 'hAP ax³', fx: 0.5, fy: 0.5, locked: false}];
  await loadPlan(page, p);
  await expect(page.locator('.sw-grp path.ap-outer, .sw-grp path.ap-sel-outer')).toHaveCount(1);
  await expect(page.locator('#cov-pct')).toHaveText(/\d+%/);
  // Wired-only model: no ring, no coverage figure.
  await page.locator('.list-item', {hasText: 'Router'}).click();
  await expect(page.locator('#sw-wifi')).toBeChecked();
  await page.locator('#sw-wifi').uncheck();
  await expect(page.locator('.sw-grp path')).toHaveCount(0);
  await expect(page.locator('#cov-pct')).toHaveText('—');
  await page.locator('#sw-wifi').check();
  await expect(page.locator('.sw-grp path')).toHaveCount(1);
  await page.locator('#sw-model').selectOption('RB5009UG+S+IN');
  await expect(page.locator('#sw-wifi')).toHaveCount(0);
  await expect(page.locator('.sw-grp path')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the ruler label keeps a readable size on screen at any zoom', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  const p = plan(); p.floors[0].APS = [];           // empty floor: nothing to catch the clicks
  await loadPlan(page, p);                          // 2000 px wide plan → zoomed out to fit
  await page.locator('#btn-ruler').click();
  const box = await page.locator('#vp').boundingBox();
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.5);
  await expect(page.locator('.ruler-lbl')).toHaveCount(1);
  // Measured in the page: the label is re-created on every zoom frame.
  const onScreen = () => page.evaluate(() => document.querySelector('.ruler-lbl').getBoundingClientRect().height);
  const fitted = await onScreen();
  expect(fitted).toBeGreaterThan(14);               // was ~4 px on this plan before
  await page.locator('[data-action="zoom-in"]').click();
  await page.waitForTimeout(600);
  const zoomed = await onScreen();
  expect(Math.abs(zoomed - fitted)).toBeLessThan(3);
});
