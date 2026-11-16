// E2E for the plan→device and simulation tooling: Import menu, the device
// config / drift dialog, and the sim panel's probe, faults and VLAN matrix —
// all under the strict CSP (any violation surfaces as a console error).
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

// Blank 800×600 floor plan, so devices render on the map.
const MAP = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#fff"/></svg>').toString('base64');

// A small routed plan: L3 core + access switch, two VLANs, an NVR listening on 554.
function plan() {
  const base = {locked: false};
  return {version: 11,
    settings: {vlans: [
      {id: '10', name: 'Staff', subnet: '192.168.10.0/24', gateway: '192.168.10.1'},
      {id: '20', name: 'Cameras', subnet: '192.168.20.0/24', gateway: '192.168.20.1'},
    ]},
    floors: [{id: 'f1', name: 'Ground', img: MAP,
      SWS: [{...base, id: 'sw1', name: 'Core', model: 'MikroTik CRS326', role: 'l3', fx: 0.2, fy: 0.2},
            {...base, id: 'sw2', name: 'Access', model: 'MikroTik CRS112', uplinkId: 'sw1', fx: 0.7, fy: 0.6}],
      APS: [{...base, id: 'ap1', name: 'AP-Lobby', swId: 'sw1', port: '2', vlan: '10', ip: '192.168.10.5', fx: 0.3, fy: 0.3, r: 80}],
      CAMS: [{...base, id: 'cam1', name: 'NVR', swId: 'sw2', port: '3', vlan: '20', ip: '192.168.20.5', fx: 0.8, fy: 0.7,
              services: [{proto: 'tcp', port: 554}]}],
      DZS: [], WALLS: []}]};
}
async function loadPlan(page, p = plan()) {
  const file = path.join(os.tmpdir(), `plexus-e2e-tools-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(p));
  await page.goto('/');
  await page.locator('#load-up').setInputFiles(file);
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  fs.rmSync(file, {force: true});
}

test('Import menu groups the import tools', async ({page}) => {
  const errors = trackErrors(page);
  await page.goto('/');
  const item = page.locator('#import-menu [data-action="open-dxf"]');
  await expect(item).toBeHidden();
  await page.locator('[data-arg="import-menu"]').click();
  await expect(item).toBeVisible();
  await expect(page.locator('#import-menu [data-action="open-survey"]')).toBeVisible();
  await page.locator('#brand-lbl').click();               // outside click closes it
  await expect(item).toBeHidden();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('device config: generate RouterOS from the plan, then detect drift', async ({page}) => {
  const errors = trackErrors(page);
  await loadPlan(page);
  await page.locator('[data-arg="export-menu"]').click();
  await page.locator('[data-action="device-config"]').click();
  const script = page.locator('.dc-script');
  await page.locator('.dc-switch').selectOption('sw2');
  await expect(script).toHaveValue(/# NOT CONFIGURED: trunk to Core/);

  await page.locator('.dc-trunk').fill('sfp-sfpplus1');
  await page.locator('.dc-trunk').dispatchEvent('change');
  await expect(script).toHaveValue(/interface=sfp-sfpplus1 frame-types=admit-only-vlan-tagged/);
  await expect(script).toHaveValue(/interface=ether3 pvid=20 .*comment="NVR"/);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: /Download \.rsc/}).click()]);
  expect(download.suggestedFilename()).toBe('Access.rsc');
  const rsc = fs.readFileSync(await download.path(), 'utf8');
  expect(rsc.trim().split('\n').pop()).toBe('/interface bridge set bridge1 vlan-filtering=yes');

  // A device running exactly that config matches; move a port and it doesn't.
  await page.locator('.dc-actual').fill(rsc);
  await page.getByRole('button', {name: 'Check drift'}).click();
  await expect(page.locator('.dc-drift-head')).toHaveText(/matches the plan/);
  await page.locator('.dc-actual').fill(rsc.replace('pvid=20', 'pvid=10'));
  await page.getByRole('button', {name: 'Check drift'}).click();
  await expect(page.locator('.dc-drift-list')).toContainText('ether3 (NVR): on VLAN 10, plan says VLAN 20');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('simulate: probe a port, cut a link, read the VLAN matrix', async ({page}) => {
  const errors = trackErrors(page);
  await loadPlan(page);
  await page.locator('[data-uimode-btn="simulate"]').click();
  const panel = page.locator('#sim-panel');
  await expect(panel).toBeVisible();
  const verdict = panel.locator('.sim-verdict');

  await panel.locator('#sim-from').selectOption('h:ap1');
  await panel.locator('#sim-to').selectOption('h:cam1');
  await panel.locator('#sim-port').fill('554');
  await panel.getByRole('button', {name: 'Probe port'}).click();
  await expect(verdict).toHaveText(/Open — tcp\/554/);
  await panel.locator('#sim-port').fill('22');
  await panel.getByRole('button', {name: 'Probe port'}).click();
  await expect(verdict).toHaveText(/Closed/);

  // Gateways are selectable destinations.
  await panel.locator('#sim-to').selectOption('ip:192.168.20.1');
  await panel.getByRole('button', {name: 'Ping', exact: true}).click();
  await expect(verdict).toHaveText(/Reachable/);

  // Cut the uplink: the camera VLAN's device is gone, the gateway on the core stays.
  await panel.locator('.sim-faults summary').click();
  await panel.locator('.sim-fault', {hasText: 'Cut uplink Access → Core'}).locator('input').check();
  await expect(panel.locator('.sim-faults summary')).toHaveText('Faults — 1 active');
  await panel.locator('#sim-to').selectOption('h:cam1');
  await panel.getByRole('button', {name: 'Ping', exact: true}).click();
  await expect(verdict).toHaveText(/Unreachable/);
  await panel.locator('.sim-fault', {hasText: 'Cut uplink Access → Core'}).locator('input').uncheck();

  await panel.getByRole('button', {name: 'VLAN matrix'}).click();
  const cells = await panel.locator('.sim-matrix-table tr').evaluateAll(rows => rows.map(r => [...r.children].map(c => c.textContent)));
  expect(cells).toEqual([['from \\ to', 'VLAN 10', 'VLAN 20'], ['VLAN 10', '·', '✓'], ['VLAN 20', '✓', '·']]);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('hostile ids and notes in a project file stay inert', async ({page}) => {
  const errors = trackErrors(page);
  /** @type {any} */
  const p = plan();
  const evil = 'x"><img src=x onerror="window.__xss=1">';
  p.floors[0].APS[0].id = evil;
  p.floors[0].APS[0].notes = '</textarea><img src=x onerror="window.__xss=2">';
  p.floors[0].SWS[1].id = evil + '2';
  p.floors[0].CAMS[0].color = '#000" onload="window.__xss=3';
  await loadPlan(page, p);
  await expect(page.locator('.li-del[data-type="ap"]')).toHaveAttribute('data-id', evil);
  await page.locator('.ap-grp').first().click({force: true});
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => /** @type {any} */(window).__xss)).toBeUndefined();
  expect(await page.locator('#rp-body img[src="x"], #list img[src="x"]').count()).toBe(0);
  expect(errors.filter(e => !/net::ERR|Failed to load resource/.test(e)), errors.join('\n')).toEqual([]);
});

test('policies: state intent and see the violating pair', async ({page}) => {
  const errors = trackErrors(page);
  await loadPlan(page);
  await page.locator('[data-uimode-btn="simulate"]').click();
  await page.locator('[data-action="show-policies"]').click();
  await page.locator('.pol-from').selectOption('vlan:20');
  await page.locator('.pol-expect').selectOption('deny');
  await page.locator('.pol-to').selectOption('vlan:10');
  await page.getByRole('button', {name: /Add policy/}).click();
  await expect(page.locator('.pol-summary')).toHaveText('0 pass · 1 fail');
  await expect(page.locator('.pol-item')).toContainText('VLAN 20 must NOT reach VLAN 10');
  await expect(page.locator('.pol-detail').first()).toContainText('NVR (192.168.20.5) → AP-Lobby (192.168.10.5): reachable');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('labs: start a lab, fail the check, fix the plan in the editor, pass', async ({page}) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('[data-uimode-btn="simulate"]').click();
  await page.locator('[data-action="show-labs"]').click();
  await page.locator('.lab-select').selectOption('redundant-uplink');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', {name: /Start lab/}).click();
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  await page.getByRole('button', {name: /Check my work/}).click();
  await expect(page.locator('.lab-score')).toHaveText('1/3 checks pass');
  await page.keyboard.press('Escape');

  // Fix it the way a user would: give Access a redundant uplink to Core-2.
  await page.locator('[data-uimode-btn="design"]').click();
  await page.locator('.list-item.sw-item', {hasText: 'Access'}).click();
  await page.locator('#sw-uplink2').selectOption('lab-c2');
  await page.locator('#sw-uplink2').dispatchEvent('input');

  await page.locator('[data-uimode-btn="simulate"]').click();
  await page.locator('[data-action="show-labs"]').click();
  await expect(page.locator('.lab-select')).toHaveValue('redundant-uplink');
  await page.getByRole('button', {name: /Check my work/}).click();
  await expect(page.locator('.lab-score')).toHaveText('✓ Passed — 3/3');
  expect(errors, errors.join('\n')).toEqual([]);
});
