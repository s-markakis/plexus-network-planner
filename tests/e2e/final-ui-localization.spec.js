import {test,expect} from '@playwright/test';
import {en} from '../../files/src/i18n/en.js';
import {fr} from '../../files/src/i18n/fr.js';

async function language(page,lang){
  await page.evaluate(async value=>{const path='/src/i18n.js';const {setLang}=await import(path);setLang(value);},lang);
}
async function sample(page){
  await page.goto('/');await page.locator('[data-action="load-sample"]').click();
  await expect(page.locator('.ap-grp')).toHaveCount(3);
}
async function download(page,action){
  const pending=page.waitForEvent('download');await action();const file=await pending;
  const stream=await file.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  return {name:file.suggestedFilename(),bytes:Buffer.concat(chunks)};
}

test('calibration instructions switch live and keep length input and scale calculation',async({page})=>{
  await sample(page);await language(page,'fr');
  await page.locator('#btn-cov').click();
  await page.locator('[data-action="calibrate-scale"]').click();
  await expect(page.locator('#toast')).toHaveText(fr['notify.draw_a_line_over_a_known_dimension_to_set_the_scale']);
  const vp=await page.locator('#vp').boundingBox();
  await page.mouse.click(vp.x+vp.width/2-60,vp.y+vp.height/2);
  await page.mouse.click(vp.x+vp.width/2+60,vp.y+vp.height/2);
  await expect(page.locator('#mdl-title')).toHaveText(fr['modal.calibrate']);
  const instruction=page.locator('[data-i18n="calibrate.line_length"]');
  const {px}=JSON.parse(await instruction.getAttribute('data-i18n-vars'));
  const input=page.locator('#mdl-body input');await input.fill('12.3');const node=await input.elementHandle();
  for(const lang of ['en','fr','en','fr']){
    await language(page,lang);
    await expect(instruction).toHaveText((lang==='fr'?fr:en)['calibrate.line_length'].replace('{px}',px));
    await expect(input).toHaveValue('12.3');
    expect(await node.evaluate(el=>el===document.querySelector('#mdl-body input'))).toBe(true);
  }
  // Use exact ruler length displayed by the default input to verify scale,
  // allowing the instruction's integer pixel rounding.
  await page.locator('#mdl-ok').click();
  const saved=JSON.parse((await download(page,()=>page.locator('[data-action="save"]').click())).bytes.toString('utf8'));
  const scale=saved.floors[0].scaleM;
  expect(Math.abs(12.3/scale*100-Number(px))).toBeLessThanOrEqual(0.5);
  await expect(page.locator('#toast')).toHaveText(fr['notify.project_saved']);
  await page.locator('[data-action="calibrate-scale"]').click();
  await page.locator('#mdl-body input').fill('0');await page.locator('#mdl-ok').click();
  await expect(page.locator('#toast')).toHaveText(fr['notify.enter_a_positive_length']);
  const unchanged=JSON.parse((await download(page,()=>page.locator('[data-action="save"]').click())).bytes.toString('utf8'));
  expect(unchanged.floors[0].scaleM).toBe(scale);
});

for(const lang of ['en','fr']){
  test(`catalog notifications in ${lang} preserve JSON and technical model values`,async({page})=>{
    await sample(page);await language(page,lang);const bundle=lang==='fr'?fr:en;
    const open=()=>page.locator('[data-action="show-plugins"]').click();
    await open();await page.locator('#mdl-body textarea').fill('{');await page.locator('#mdl-ok').click();
    await expect(page.locator('#toast')).toContainText(bundle['catalog.invalid_json']);
    await open();await page.locator('#mdl-body textarea').fill('{}');await page.locator('#mdl-ok').click();
    await expect(page.locator('#toast')).toHaveText(bundle['catalog.no_changes']);
    const catalog={aps:[{label:'Vendor literal',models:['X1 literal'],range:{'X1 literal':30},poe:{'X1 literal':15}}]};
    await open();await page.locator('#mdl-body textarea').fill(JSON.stringify(catalog));await page.locator('#mdl-ok').click();
    await expect(page.locator('#toast')).toHaveText(bundle['catalog.merged']);
    const saved=JSON.parse((await download(page,()=>page.locator('[data-action="save"]').click())).bytes.toString('utf8'));
    expect(JSON.parse(saved.settings.customCatalog)).toEqual({...catalog,cams:[],switches:[]});
  });
}

test('CSV and HTML export notifications translate while file contents and names remain unchanged',async({page})=>{
  await sample(page);
  const exports=[
    {key:'export.inventory_done',button:'inventory.csv'},
    {key:'export.ip_done',button:'inventory.ip_csv'},
    {key:'export.ports_done',button:'inventory.port_csv'},
  ];
  await page.locator('[data-action="show-inventory"]').click();
  for(const entry of exports){
    await language(page,'en');const english=await download(page,()=>page.locator(`[data-i18n="${entry.button}"]`).click());
    await expect(page.locator('#toast')).toHaveText(en[entry.key]);
    await language(page,'fr');const french=await download(page,()=>page.locator(`[data-i18n="${entry.button}"]`).click());
    await expect(page.locator('#toast')).toHaveText(fr[entry.key]);
    expect(french.name).toBe(english.name);expect(french.bytes).toEqual(english.bytes);
  }
  await page.locator('[data-action="modal-close"]').click();
  await language(page,'en');const english=await download(page,()=>page.locator('[data-action="export"]').click());
  await expect(page.locator('#toast')).toHaveText(en['toast.exported']);
  await language(page,'fr');const french=await download(page,()=>page.locator('[data-action="export"]').click());
  await expect(page.locator('#toast')).toHaveText(fr['toast.exported']);
  expect(french.name).toBe(english.name);expect(french.bytes).toEqual(english.bytes);
  await download(page,()=>page.locator('[data-action="export-esx"]').click());
  await expect(page.locator('#toast')).toHaveText(fr['export.esx_done']);
  const handover=await download(page,()=>page.locator('[data-action="handover-pack"]').click());
  expect(handover.bytes.subarray(0,2).toString()).toBe('PK');
  await expect(page.locator('#toast')).toHaveText(/Dossier de livraison : \d+ fichiers compressés en ZIP/);
});

test('empty export warnings are French without generating downloads',async({page})=>{
  await page.goto('/');await language(page,'fr');const downloads=[];page.on('download',d=>downloads.push(d));
  await page.locator('[data-action="export-cables"]').click();await expect(page.locator('#toast')).toHaveText(fr['export.no_links']);
  await page.locator('[data-action="handover-pack"]').click();await expect(page.locator('#toast')).toHaveText(fr['export.no_devices']);
  expect(downloads).toEqual([]);
});
