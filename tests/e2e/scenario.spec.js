// Scenario E2E: exercises the core editing loop end-to-end on top of the
// bundled sample project — load sample, place an AP, draw a wall and watch
// coverage react, then export the project and re-import it.
//
// Clicks on the map must happen with coverage rings hidden (V): the rings are
// part of each AP's draggable group, so a click inside a coverage polygon
// selects that AP instead of reaching the map underneath.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

// Blur whatever button holds focus — plain-key shortcuts are intentionally
// suppressed while a BUTTON is focused.
async function blurFocus(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */(document.activeElement)?.blur?.());
}

test('sample project: load → place AP → wall reshapes coverage → export/import round-trip', async ({page}) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // ── Load the bundled sample ──────────────────────────────────────────────
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  await expect(page.locator('.dz-grp')).toHaveCount(1);
  // Wall-clipped coverage polygons rendered for every AP.
  await expect(page.locator('path.ap-outer')).toHaveCount(3);
  const coverageBefore = await page.locator('path.ap-outer').evaluateAll(
    els => els.map(e => e.getAttribute('d')));

  // ── Place a new AP ───────────────────────────────────────────────────────
  await blurFocus(page);
  await page.keyboard.press('v');               // hide rings so map clicks land
  const vp = await page.locator('#vp').boundingBox();
  const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;
  await page.keyboard.press('a');
  await page.mouse.click(cx + 60, cy + 90);
  await expect(page.locator('.ap-grp')).toHaveCount(4);

  // ── Draw a wall through the middle of the open office ───────────────────
  await blurFocus(page);
  await page.keyboard.press('l');
  await page.mouse.click(cx, cy - 100);
  await page.mouse.click(cx, cy + 100);
  await blurFocus(page);
  await page.keyboard.press('v');               // rings back on
  // The freshly placed AP is auto-selected, so its ring is .ap-sel-outer.
  const anyOuter = page.locator('path.ap-outer, path.ap-sel-outer');
  await expect(anyOuter).toHaveCount(4);
  const coverageAfter = await anyOuter.evaluateAll(
    els => els.map(e => e.getAttribute('d')));
  // The new wall must have re-clipped at least one of the original APs'
  // coverage polygons (the new AP's polygon is new anyway, ignore it).
  const changed = coverageBefore.some(d => !coverageAfter.includes(d));
  expect(changed, 'a wall through the office should reshape some AP coverage').toBe(true);

  // ── Export the project ───────────────────────────────────────────────────
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="save"]').click(),
  ]);
  const file = await download.path();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(saved.floors).toHaveLength(1);
  expect(saved.floors[0].APS).toHaveLength(4);
  expect(saved.floors[0].img, 'exported project must inline the floor image').toContain('data:image/svg+xml');

  // ── Wipe and re-import ───────────────────────────────────────────────────
  await page.locator('[data-action="new-project"]').click();
  await page.locator('[data-action="modal-ok"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(0);
  await expect(page.locator('#empty-state')).not.toHaveClass(/hidden/);

  await page.locator('#load-up').setInputFiles(file);
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  await expect(page.locator('.ap-grp')).toHaveCount(4);
  await expect(page.locator('path.ap-outer, path.ap-sel-outer')).toHaveCount(4);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('organization: inventory & rollout, status filter, validation, handover pack', async ({page}) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);

  // ── Inventory modal: 6 devices, mid-flight rollout ───────────────────────
  // Inventory lives in the Export ▾ dropdown now — open it first.
  await page.locator('[data-action="toggle-menu"][data-arg="export-menu"]').click();
  await page.locator('[data-action="show-inventory"]').click();
  await expect(page.locator('#mdl-title')).toHaveText('Inventory & rollout');
  const rows = page.locator('#mdl-body tbody tr');
  await expect(rows).toHaveCount(6);

  // Inline status edit: AP-03 planned → installed.
  const ap3row = rows.filter({hasText: 'AP-03'});
  await ap3row.locator('select').selectOption('installed');

  // Search narrows the table.
  await page.locator('#mdl-body input[type="text"]').fill('cam');
  await expect(page.locator('#mdl-body tbody tr')).toHaveCount(2);
  await page.locator('#mdl-body input[type="text"]').fill('');

  // ── Handover pack downloads a real zip ───────────────────────────────────
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#mdl-body button', {hasText: 'Handover pack'}).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/handover.*\.zip$/);
  const zipPath = await download.path();
  const head = fs.readFileSync(zipPath).subarray(0, 4);
  expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]); // "PK\3\4"
  // Informational modals show a single "Close" button (no OK callback).
  await page.locator('[data-action="modal-close"]').click();

  // ── Status edit persisted to the device panel ────────────────────────────
  await page.locator('.list-item', {hasText: 'AP-03'}).click();
  await expect(page.locator('#ep-status')).toHaveValue('installed');

  // ── Sidebar status filter: list narrows, map dims ────────────────────────
  await page.locator('#sb-status').selectOption('live');
  await expect(page.locator('.list-item', {hasText: 'AP-01'})).toHaveCount(1);
  await expect(page.locator('.list-item', {hasText: 'AP-02'})).toHaveCount(0);
  // AP-02 (ap15) is "installed" → dimmed on the map under the "live" filter.
  await expect(page.locator('.ap-grp[data-id="ap15"]')).toHaveCSS('opacity', '0.15');
  await page.locator('#sb-status').selectOption('');

  // ── Validation: the sample ships clean ───────────────────────────────────
  await page.locator('[data-action="show-validation"]').click();
  await expect(page.locator('#mdl-body')).toContainText('All checks passed');
  await page.locator('[data-action="modal-close"]').click();

  expect(errors, errors.join('\n')).toEqual([]);
});
