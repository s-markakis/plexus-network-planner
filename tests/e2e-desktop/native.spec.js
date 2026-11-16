// Desktop E2E: the features that only exist in the native app — Operate mode,
// the UniFi controller dialog, the live WiFi survey bridge and the SSH entry
// point. Nothing here contacts a real device: no terminal is opened and no
// controller is reached.
import {test, expect, _electron as electron} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir; let app; let page;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-native-'));
  app = await electron.launch({args: [ROOT, `--user-data-dir=${path.join(dir, 'profile')}`]});
  page = await app.firstWindow();
  await page.waitForSelector('[data-action="load-sample"]');
});
test.afterEach(async () => {
  await app.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

function trackErrors(p) {
  const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

test('desktop-only controls appear, and Operate mode switches the workspace', async () => {
  const errors = trackErrors(page);
  await expect(page.locator('#mode-operate')).toBeVisible();
  await expect(page.locator('#btn-survey')).toBeVisible();
  await expect(page.locator('#btn-unifi')).toBeVisible();
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  // Entering Operate asks first (it touches real devices). Declining stays put…
  page.once('dialog', (d) => d.dismiss());
  await page.locator('#mode-operate').click();
  await expect(page.locator('#mode-operate')).not.toHaveClass(/active/);
  // …accepting switches.
  page.once('dialog', (d) => d.accept());
  await page.locator('#mode-operate').click();
  await expect(page.locator('#mode-operate')).toHaveClass(/active/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('UniFi dialog opens with its fields and does not connect by itself', async () => {
  const errors = trackErrors(page);
  await page.locator('[data-action="load-sample"]').click();
  await page.locator('#btn-unifi').click();
  await expect(page.locator('#mdl-title')).toHaveText('UniFi controller sync');
  await expect(page.locator('#mdl-body input').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#mbg')).not.toHaveClass(/vis/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('live survey bridge answers with a reading or a clear reason', async () => {
  const res = await page.evaluate(() => /** @type {any} */(window).plexusNative.wifiSample());
  expect(typeof res.ok).toBe('boolean');
  if (res.ok) {
    expect(Number.isFinite(res.rssi)).toBe(true);
    expect(res.rssi).toBeLessThan(0);
  } else {
    expect(String(res.error).length).toBeGreaterThan(0);
  }
});

test('the device menu offers Connect via SSH, and the bridge refuses hostile targets', async () => {
  const errors = trackErrors(page);
  await page.locator('[data-action="load-sample"]').click();
  await page.locator('.list-item', {hasText: 'SW-01'}).click();
  await page.locator('.sw-grp').first().click({button: 'right', force: true});
  await expect(page.locator('#ctx-menu')).toHaveClass(/vis/);
  await expect(page.locator('#ctx-menu')).toContainText('Connect via SSH');
  await page.keyboard.press('Escape');
  // Straight at the bridge: an injection attempt is rejected before any terminal opens.
  const bad = await page.evaluate(() => /** @type {any} */(window).plexusNative.openSshTerminal({host: '-oProxyCommand=touch /tmp/pwned', user: 'admin'}));
  expect(bad.ok).toBe(false);
  expect(fs.existsSync('/tmp/pwned')).toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});
