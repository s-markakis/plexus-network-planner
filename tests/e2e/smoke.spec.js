// Smoke E2E: verifies the app boots cleanly and core v3 chrome is wired up.
// These checks don't need a floor plan — they exercise mode switching,
// the settings modal, heatmap pills and the help dialog.
import {test, expect} from '@playwright/test';

// Fail the test on any uncaught page error or console error during the run.
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

test('app boots without errors and shows empty state', async ({page}) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/Plexus/i);
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#btn-add')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('mode toolbar switches the active tool', async ({page}) => {
  await page.goto('/');
  // Add AP is the default active tool.
  await expect(page.locator('#btn-add')).toHaveClass(/active/);
  await page.locator('#btn-sel').click();
  await expect(page.locator('#btn-sel')).toHaveClass(/active/);
  await expect(page.locator('#btn-add')).not.toHaveClass(/active/);
});

test('annotation mode reveals the sub-tool bar', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('#anno-sub-bar')).toBeHidden();
  await page.locator('#btn-anno').click();
  await expect(page.locator('#btn-anno')).toHaveClass(/active/);
  await expect(page.locator('#anno-sub-bar')).toBeVisible();
});

test('heatmap mode pill cycles through metrics', async ({page}) => {
  await page.goto('/');
  // Heatmap controls live in the Layers ▾ dropdown — open it first.
  await page.locator('[data-action="toggle-menu"][data-arg="layers-menu"]').click();
  const pill = page.locator('#heat-mode-pill');
  const first = (await pill.textContent())?.trim();
  await pill.click();
  const second = (await pill.textContent())?.trim();
  expect(second).not.toBe(first);
});

test('worker heatmap paints, including the SINR mode', async ({page}) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  // Heatmap controls live in the Layers ▾ dropdown — open it, then turn the
  // heatmap on and walk the mode pill until it reads SINR.
  await page.locator('[data-action="toggle-menu"][data-arg="layers-menu"]').click();
  await page.locator('#btn-heat').click();
  const pill = page.locator('#heat-mode-pill');
  for (let i = 0; i < 6 && !/SINR/i.test((await pill.textContent()) || ''); i++) {
    await pill.click();
  }
  await expect(pill).toContainText(/SINR/i);
  // The worker result lands asynchronously — wait until pixels are painted.
  await expect(page.locator('#heat-canvas')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const cv = /** @type {HTMLCanvasElement} */ (document.getElementById('heat-canvas'));
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }), {timeout: 5000}).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('settings modal opens with sectioned headings', async ({page}) => {
  await page.goto('/');
  await page.locator('[data-action="show-settings"]').click();
  await expect(page.locator('#mbg')).toHaveClass(/vis/);
  await expect(page.locator('.settings-heading').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#mbg')).not.toHaveClass(/vis/);
});

test('help dialog opens via the ? shortcut', async ({page}) => {
  await page.goto('/');
  await page.keyboard.press('?');
  await expect(page.locator('#mbg')).toHaveClass(/vis/);
  await expect(page.locator('.help-grid')).toBeVisible();
});
