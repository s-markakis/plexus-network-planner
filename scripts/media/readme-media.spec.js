// README media: every screenshot in docs/media/ and the demo GIF, taken from
// the sample office in the dark theme. Run with `npm run docs:media`.
// The GIF needs ffmpeg on PATH; without it the screenshots are still written.
import {test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSampleProject} from '../../files/src/sampleProject.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'media');
const VIEW = {width: 1440, height: 900};

// The sample office, routed: an L3 MikroTik core owns the VLAN gateways, AP-02
// carries the guest SSID, a WiFi router sits in the storage room, and intent is
// written as two policies (one of which the plan does not yet satisfy).
function demo() {
  const p = buildSampleProject();
  p.settings.reportTitle = 'Office — Network Plan';
  p.settings.vlans = [
    {id: '1', name: 'Mgmt', color: '#8e6bd8', subnet: '10.0.1.0/24', gateway: '10.0.1.1'},
    {id: '10', name: 'Corp', color: '#3b8cf0', subnet: '10.0.10.0/24', gateway: '10.0.10.1'},
    {id: '20', name: 'Cameras', color: '#17b8c4', subnet: '10.0.20.0/24', gateway: '10.0.20.1'},
    {id: '30', name: 'Guest', color: '#f0902b', subnet: '10.0.30.0/24', gateway: '10.0.30.1'},
  ];
  p.settings.policies = [
    {id: 'p1', name: 'Guests must never reach the cameras', from: {kind: 'vlan', vlan: '30'}, to: {kind: 'vlan', vlan: '20'}, proto: 'any', expect: 'deny'},
    {id: 'p2', name: 'Corp can view the cameras', from: {kind: 'vlan', vlan: '10'}, to: {kind: 'vlan', vlan: '20'}, proto: 'any', expect: 'allow'},
  ];
  const f = p.floors[0];
  Object.assign(f.SWS[0], {model: 'MikroTik CRS326', name: 'Core', role: 'l3', ip: '10.0.1.2', vlan: '1'});
  f.APS[1].vlan = '30'; f.APS[1].ip = '10.0.30.12';
  return p;
}

async function open(browser, opts = {}) {
  const ctx = await browser.newContext({viewport: VIEW, deviceScaleFactor: 1.5, ...opts});
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('[data-action="toggle-theme"]').click();   // dark
  await page.waitForTimeout(300);
  return {ctx, page};
}
async function load(page, project) {
  const file = path.join(os.tmpdir(), `plexus-media-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(project));
  await page.locator('#load-up').setInputFiles(file);
  await page.waitForTimeout(1500);
  fs.rmSync(file, {force: true});
}
const shot = (page, name) => page.screenshot({path: path.join(OUT, `${name}.png`)});
const closeMenus = (page) => page.locator('#brand-lbl').click();
async function layer(page, id) {
  await page.locator('[data-arg="layers-menu"]').click();
  await page.locator('#' + id).click();
  await closeMenus(page);
  await page.waitForTimeout(900);
}

test('screenshots', async ({browser}) => {
  fs.mkdirSync(OUT, {recursive: true});
  const {ctx, page} = await open(browser);

  // Templates (empty state behind)
  await page.locator('[data-action="new-from-template"]').click();
  await page.waitForTimeout(400);
  await shot(page, 'templates');
  await page.keyboard.press('Escape');

  await load(page, demo());

  // Coverage rings clipped by walls + camera cones
  await shot(page, 'coverage');

  // Cable runs
  await layer(page, 'btn-cables');
  await shot(page, 'cables');
  await layer(page, 'btn-cables');

  // Heatmaps: RSSI, then throughput
  await layer(page, 'btn-heat');
  await shot(page, 'heatmap-rssi');
  await page.locator('[data-arg="layers-menu"]').click();
  for (let i = 0; i < 6; i++) {
    if (/Throughput|Mbps/i.test(await page.locator('#heat-mode-pill').textContent())) break;
    await page.locator('#heat-mode-pill').click();
  }
  await closeMenus(page);
  await page.waitForTimeout(900);
  await shot(page, 'heatmap-throughput');
  await page.locator('[data-arg="layers-menu"]').click();
  for (let i = 0; i < 6; i++) {
    if (/RSSI/i.test(await page.locator('#heat-mode-pill').textContent())) break;
    await page.locator('#heat-mode-pill').click();
  }
  await closeMenus(page);

  // Hero: heatmap with an AP selected and its inspector open
  await page.locator('.list-item', {hasText: 'AP-01'}).click();   // selecting from the list zooms to the item…
  await page.locator('[data-action="zoom-fit"]').click();          // …so fit the plan back in view
  await page.waitForTimeout(900);
  await shot(page, 'hero');
  await layer(page, 'btn-heat');

  // Simulate: a guest AP pings a camera across the L3 core
  await page.locator('[data-uimode-btn="simulate"]').click();
  const panel = page.locator('#sim-panel');
  await panel.locator('#sim-from').selectOption('h:' + demo().floors[0].APS[1].id);
  await panel.locator('#sim-to').selectOption('h:' + demo().floors[0].CAMS[0].id);
  await panel.getByRole('button', {name: 'Ping', exact: true}).click();
  await page.waitForTimeout(1500);
  await shot(page, 'simulate');

  // Policies: intent as tests
  await page.locator('[data-action="show-policies"]').click();
  await page.waitForTimeout(1200);
  await shot(page, 'policies');
  await page.keyboard.press('Escape');
  await page.locator('[data-uimode-btn="design"]').click();

  // Plan → device: RouterOS config and one drift finding
  await page.locator('[data-arg="export-menu"]').click();
  await page.locator('[data-action="device-config"]').click();
  await page.waitForTimeout(600);
  const rsc = await page.locator('.dc-script').inputValue();
  await page.locator('.dc-actual').fill(rsc.replace(/pvid=20/, 'pvid=10'));
  await page.getByRole('button', {name: 'Check drift'}).click();
  await page.waitForTimeout(500);
  await page.locator('.dc-drift').scrollIntoViewIfNeeded();
  await shot(page, 'drift');
  await page.keyboard.press('Escape');

  // Settings
  await page.locator('[data-action="show-settings"]').click();
  await page.waitForTimeout(500);
  await shot(page, 'settings');
  await page.keyboard.press('Escape');

  // A router with built-in WiFi radiates like an AP
  const withRouter = demo();
  withRouter.floors[0].SWS.push({id: 'swr1', name: 'Router', model: 'hAP ax³', fx: 0.6, fy: 0.82, locked: false, ip: '10.0.1.3', vlan: '1'});
  await load(page, withRouter);
  await page.locator('.list-item', {hasText: 'Router'}).click();
  await page.locator('[data-action="zoom-fit"]').click();
  await page.waitForTimeout(900);
  await shot(page, 'wifi-router');

  // Client report (a document for the client: its own light, printable page)
  await page.locator('[data-arg="export-menu"]').click();
  const [report] = await Promise.all([ctx.waitForEvent('page'), page.locator('[data-action="client-report"]').click()]);
  await report.setViewportSize({width: 1100, height: 1400});
  await report.waitForTimeout(800);
  await report.screenshot({path: path.join(OUT, 'client-report.png')});
  await report.close();

  // Light theme, for comparison
  await page.locator('[data-action="toggle-theme"]').click();
  await layer(page, 'btn-heat');
  await shot(page, 'light');
  await ctx.close();
});

test('demo gif — dragging an AP re-clips its coverage against the walls', async ({browser}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-gif-'));
  const size = {width: 1440, height: 810};
  const {ctx, page} = await open(browser, {viewport: size, deviceScaleFactor: 1, recordVideo: {dir, size}});
  await load(page, demo());
  await page.locator('[data-action="set-mode"][data-arg="sel"]').click();
  const dot = await page.locator('.ap-grp').nth(1).locator('circle').last().boundingBox();
  const x = dot.x + dot.width / 2, y = dot.y + dot.height / 2;
  await page.mouse.move(x, y);
  await page.waitForTimeout(500);
  await page.mouse.down();
  const path2 = [[-150, -40], [-260, 60], [-200, 190], [-40, 200], [80, 110], [40, -30], [0, 0]];
  let px = x, py = y;
  for (const [dx, dy] of path2) {
    const tx = x + dx, ty = y + dy;
    for (let i = 1; i <= 14; i++) { await page.mouse.move(px + (tx - px) * i / 14, py + (ty - py) * i / 14); await page.waitForTimeout(35); }
    px = tx; py = ty;
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  try {
    const pal = path.join(dir, 'pal.png');
    execFileSync('ffmpeg', ['-y', '-ss', '1.8', '-i', webm, '-vf', 'fps=12,scale=900:-1:flags=lanczos,palettegen=max_colors=96', pal], {stdio: 'ignore'});
    execFileSync('ffmpeg', ['-y', '-ss', '1.8', '-i', webm, '-i', pal, '-lavfi', 'fps=12,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4', path.join(OUT, 'demo.gif')], {stdio: 'ignore'});
  } catch (e) {
    console.log('ffmpeg not available — demo.gif not regenerated');
  }
  fs.rmSync(dir, {recursive: true, force: true});
});
