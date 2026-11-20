// UX regressions found by a manual walk through the app (2026-11): each test
// pins one fix so it can't quietly come back.
import {test, expect} from '@playwright/test';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}
async function loadSample(page) {
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
}
const zoomPct = async (page) => parseInt((await page.locator('#zval').textContent()) || '0', 10);
const rect = (page, sel) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect(); return {l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height};
});

test('the empty map image shows no broken-image glyph', async ({page}) => {
  await page.goto('/');
  const vis = await page.locator('#mi').evaluate((el) => getComputedStyle(el).visibility);
  expect(vis).toBe('hidden');
});

test('selecting a device from the list never zooms out', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await loadSample(page);
  const before = await zoomPct(page);
  await page.locator('.list-item', {hasText: 'AP-01'}).first().click();
  await page.waitForTimeout(300);
  expect(await zoomPct(page)).toBeGreaterThanOrEqual(before);
  await page.locator('.list-item', {hasText: 'CAM-01'}).first().click();
  await page.waitForTimeout(300);
  expect(await zoomPct(page)).toBeGreaterThanOrEqual(before);
});

test('Escape closes an open menu first and keeps the selection', async ({page}) => {
  await loadSample(page);
  await page.locator('.list-item', {hasText: 'AP-01'}).first().click();
  await expect(page.locator('#ep-name')).toHaveValue('AP-01');
  await page.locator('[data-arg="layers-menu"]').click();
  await expect(page.locator('#layers-menu')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#layers-menu')).not.toHaveClass(/open/);
  await expect(page.locator('#ep-name')).toHaveValue('AP-01');   // still selected
});

test('a right-click closes an open menu: one popup at a time', async ({page}) => {
  await loadSample(page);
  await page.locator('[data-arg="layers-menu"]').click();
  await expect(page.locator('#layers-menu')).toHaveClass(/open/);
  // AP-02's dot: mid-plan, clear of the open menu (AP-01 can be under it).
  const ap = await page.locator('.ap-grp').nth(1).locator('.ap-dot').evaluate((el) => {
    const r = el.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  });
  await page.mouse.click(ap.x, ap.y, {button: 'right'});
  await expect(page.locator('#ctx-menu')).toHaveClass(/vis/);
  await expect(page.locator('#layers-menu')).not.toHaveClass(/open/);
});

test('packet-simulation buttons stay inside the panel', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await loadSample(page);
  await page.locator('[data-uimode-btn="simulate"]').click();
  await expect(page.locator('#sim-panel')).toBeVisible();
  const panel = await rect(page, '#sim-panel');
  const clipped = await page.locator('#sim-panel button').evaluateAll((bs, p) => /** @type {HTMLButtonElement[]} */ (bs)
    .filter((b) => b.offsetParent)
    .map((b) => ({t: (b.textContent || '').trim(), r: b.getBoundingClientRect().right}))
    .filter((b) => b.r > p.r + 1), panel);
  expect(clipped).toEqual([]);
});

test('a fitted plan re-fits when the window shrinks, clear of the tool palette', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await loadSample(page);
  await page.locator('[data-action="zoom-fit"]').evaluate((b) => /** @type {HTMLButtonElement} */ (b).click());
  await page.setViewportSize({width: 1024, height: 680});
  await page.waitForTimeout(400);
  const vp = await rect(page, '#vp');
  const img = await rect(page, '#mi');
  const pal = await rect(page, '#tool-palette');
  expect(img.l).toBeGreaterThanOrEqual(pal.r);       // not under the palette
  expect(img.r).toBeLessThanOrEqual(vp.r + 1);
  expect(img.b).toBeLessThanOrEqual(vp.b + 1);
  expect(img.t).toBeGreaterThanOrEqual(vp.t - 1);
});

test('a zoomed-in view keeps its centre when the window resizes', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await loadSample(page);
  for (let i = 0; i < 4; i++) await page.locator('[data-action="zoom-in"]').click();
  await page.waitForTimeout(250);
  const centreImgPoint = () => page.evaluate(() => {
    const vp = document.getElementById('vp').getBoundingClientRect();
    const im = document.getElementById('mi').getBoundingClientRect();
    return {x: (vp.left + vp.width / 2 - im.left) / im.width, y: (vp.top + vp.height / 2 - im.top) / im.height};
  });
  const a = await centreImgPoint();
  await page.setViewportSize({width: 1300, height: 820});
  await page.waitForTimeout(300);
  const b = await centreImgPoint();
  expect(Math.abs(a.x - b.x)).toBeLessThan(0.02);
  expect(Math.abs(a.y - b.y)).toBeLessThan(0.02);
});

test('help describes Shift+click and Escape as they behave', async ({page}) => {
  await page.goto('/');
  await page.locator('[data-action="show-help"]').click();
  const body = page.locator('#mdl-body');
  await expect(body).toContainText('Add or remove from selection');
  await expect(body).toContainText('Duplicate selected AP');
  await expect(body).toContainText('Close menu or dialog');
});

test('policies form: sensible defaults, inert controls look inert', async ({page}) => {
  await loadSample(page);
  await page.locator('[data-uimode-btn="simulate"]').click();
  await page.locator('[data-action="show-policies"]').click();
  const from = await page.locator('.pol-from').inputValue();
  const to = await page.locator('.pol-to').inputValue();
  expect(to).not.toBe(from);
  await expect(page.locator('.pol-port')).toBeDisabled();
  await expect(page.getByRole('button', {name: /Re-check/})).toBeDisabled();
  const re = await rect(page, '.pol-root .ep-btn-row .btn');
  const row = await rect(page, '.pol-root .ep-btn-row');
  expect(re.w).toBeLessThan(row.w / 2);               // not stretched across the row
});

test('settings: the opacity value sits on the slider row; languages are named', async ({page}) => {
  await page.goto('/');
  await page.locator('[data-action="show-settings"]').evaluate((b) => /** @type {HTMLButtonElement} */ (b).click());
  const rng = await rect(page, '.settings-card > .ep-slider-row .ep-rng');
  const val = await rect(page, '.settings-card > .ep-slider-row .ep-rng-val');
  expect(Math.abs((rng.t + rng.b) / 2 - (val.t + val.b) / 2)).toBeLessThan(8);
  expect(val.l).toBeGreaterThan(rng.r - 1);
  const labels = await page.locator('select').evaluateAll((els) => {
    const ss = /** @type {HTMLSelectElement[]} */ (els);
    const s = ss.find((x) => [...x.options].some((o) => o.value === 'en'));
    return s ? [...s.options].map((o) => o.textContent) : [];
  });
  expect(labels).toContain('English');
});

for (const width of [1024, 1280, 1400, 1440]) {
  test(`${width} px: each toolbar stays on one row in design and simulate`, async ({page}) => {
    const errors = trackErrors(page);
    await page.setViewportSize({width, height: 760});
    await loadSample(page);
    for (const mode of ['design', 'simulate']) {
      await page.locator(`[data-uimode-btn="${mode}"]`).click();
      for (const sel of ['.topbar-meta', '.topbar-tools']) {
        const r = await rect(page, sel);
        if (r.h) expect(r.h, `${mode}: ${sel} wraps`).toBeLessThan(52);
      }
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('icon-only toolbar buttons keep their names', async ({page}) => {
  await page.setViewportSize({width: 1024, height: 680});
  await loadSample(page);
  await expect(page.getByRole('button', {name: 'Auto-place'})).toBeVisible();
  await expect(page.getByRole('button', {name: /Upload Map/})).toBeVisible();
  // and a click on one still runs it
  await page.getByRole('button', {name: 'Topology'}).click();
  await expect(page.locator('#mdl')).toContainText('Network topology');
});
