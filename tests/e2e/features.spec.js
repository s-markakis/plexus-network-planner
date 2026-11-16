// E2E for the site templates and the client-facing report.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}
async function savedProject(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="save"]').click()]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  return {text, data: JSON.parse(text)};
}

test('New from template starts a project with the VLAN plan and policies', async ({page}) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('[data-action="new-from-template"]').click();
  await expect(page.locator('.tpl-item')).toHaveCount(3);
  await page.locator('[data-template="hotel"]').click();
  await expect(page.locator('.ftab-name')).toHaveText(['Ground floor', 'Floor 1', 'Floor 2']);
  const {data} = await savedProject(page);
  expect(data.settings.vlans.map(v => v.name)).toEqual(['Mgmt', 'Staff', 'Cameras', 'Guest', 'POS', 'IPTV-VoIP']);
  expect(data.settings.policies).toHaveLength(6);
  expect(data.settings.expectedClients).toBe(200);
  expect(data.floors[0].SWS[0]).toMatchObject({name: 'Core', role: 'l3'});
  expect(data.floors.every(f => f.APS.length === 0)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('client report shows coverage and equipment but no addresses or credentials', async ({page, context}) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
  // Give the sample devices the details a client must never see.
  const {data} = await savedProject(page);
  for (const ap of data.floors[0].APS) { ap.ip = '192.0.2.77'; ap.mac = 'DE:AD:BE:EF:00:01'; ap.notes = 'INTERNAL-NOTE'; ap.creds = {proto: 'ssh', host: '', port: '', user: 'root', pass: 'S3cret-Client', key: ''}; }
  const file = `${test.info().outputPath('with-details.json')}`;
  fs.writeFileSync(file, JSON.stringify(data));
  await page.locator('#load-up').setInputFiles(file);
  await expect(page.locator('.ap-grp')).toHaveCount(3);

  await page.locator('[data-arg="export-menu"]').click();
  const [report] = await Promise.all([context.waitForEvent('page'), page.locator('[data-action="client-report"]').click()]);
  await expect(report.locator('.doc-title')).toContainText('Network Proposal & Coverage Report');
  await expect(report.locator('.stat').first()).toContainText('%');
  await expect(report.locator('table tbody tr').first()).toBeVisible();
  await expect(report.locator('.map svg')).toHaveCount(1);
  const html = await report.content();
  for (const leak of ['192.0.2.77', 'DE:AD:BE:EF', 'INTERNAL-NOTE', 'S3cret-Client']) expect(html, `leaks ${leak}`).not.toContain(leak);
  expect(errors, errors.join('\n')).toEqual([]);
});
