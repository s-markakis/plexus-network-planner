// Desktop E2E: plan → device hand-off to rosconf. The terminal is withheld
// (PLEXUS_NO_TERMINAL) so the test sees the command instead of opening a window;
// the script file, the argv and the validation are the real main-process code.
import {test, expect, _electron as electron} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir; let profile; let app; let page;

const plan = (ip) => ({version: 11,
  settings: {vlans: [{id: '10', name: 'Staff', subnet: '192.168.10.0/24', gateway: '192.168.10.1'}]},
  floors: [{id: 'f1', name: 'Ground',
    SWS: [{id: 'sw1', name: 'Core Switch', model: 'MikroTik CRS326', role: 'l3', ip, fx: 0.2, fy: 0.2, locked: false,
           creds: {proto: 'ssh', host: '', port: '2222', user: 'admin', pass: '', key: ''}}],
    APS: [{id: 'ap1', name: 'AP-Lobby', swId: 'sw1', port: '2', vlan: '10', ip: '192.168.10.5', fx: 0.3, fy: 0.3, r: 80, locked: false}],
    CAMS: [], DZS: [], WALLS: []}]});

async function start(ip) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-deploy-e2e-'));
  profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, {recursive: true});
  const rosconf = path.join(dir, 'rosconf.py');
  fs.writeFileSync(rosconf, '#!/usr/bin/env python3\n');
  fs.writeFileSync(path.join(profile, 'rosconf-path.json'), JSON.stringify({path: rosconf}));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan(ip)));
  app = await electron.launch({args: [ROOT, `--user-data-dir=${profile}`], env: {...process.env, PLEXUS_NO_TERMINAL: '1'}});
  page = await app.firstWindow();
  await page.waitForSelector('[data-action="load-sample"]');
  await app.evaluate(({dialog}, f) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [f]}); }, file);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', {action: 'open'}));
  await expect(page.locator('.ftab-name').first()).toHaveText('Ground');
  await page.locator('[data-arg="export-menu"]').click();
  await page.locator('[data-action="device-config"]').click();
  await expect(page.locator('.dc-script')).not.toHaveValue('');
  return rosconf;
}
test.afterEach(async () => { await app.close(); fs.rmSync(dir, {recursive: true, force: true}); });

test('dry-run hands the generated script to rosconf — without --apply', async () => {
  const rosconf = await start('192.0.2.10');
  const script = await page.locator('.dc-script').inputValue();
  await page.locator('.dc-deploy').click();
  const out = page.locator('.dc-deploy-out').first();
  await expect(out).toContainText('apply 192.0.2.10');
  const command = (await out.textContent()).split('\n').pop();
  const deployDir = path.join(profile, 'deploy');
  const files = fs.readdirSync(deployDir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^Core_Switch-\d{8}T\d{6}\.rsc$/);
  expect(fs.readFileSync(path.join(deployDir, files[0]), 'utf8')).toBe(script);
  expect(command).toContain(`python3 ${rosconf} apply 192.0.2.10 -u admin -p 2222 -f `);
  expect(command).toContain(files[0]);
  expect(command.split(' ')).not.toContain('--apply');
});

test('a hostile host from the project file never reaches the command', async () => {
  await start('--apply');
  await page.locator('.dc-deploy').click();
  await expect(page.locator('.dc-deploy-out').first()).toContainText('✕');
  expect(fs.existsSync(path.join(profile, 'deploy'))).toBe(false);
  // …and straight at the bridge, bypassing the renderer's own check:
  const res = await page.evaluate(() => /** @type {any} */(window).plexusNative.deployRosconf(
    {target: {host: 'sw1;touch /tmp/pwned', user: 'admin'}, name: 'x', text: '/system identity print'}));
  expect(res.ok).toBe(false);
  expect(fs.existsSync(path.join(profile, 'deploy'))).toBe(false);
});
