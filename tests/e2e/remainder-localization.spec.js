import {test,expect} from '@playwright/test';
import {buildSampleProject} from '../../files/src/sampleProject.js';
import {en} from '../../files/src/i18n/en.js';
import {fr} from '../../files/src/i18n/fr.js';
import {PROJECT_VERSION} from '../../files/src/migrate.js';

async function language(page,lang){
  await page.evaluate(async value=>{const path='/src/i18n.js';const {setLang}=await import(path);setLang(value);},lang);
}
async function load(page,project){
  await page.goto('/');
  await page.locator('#load-up').setInputFiles({name:'remainder.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.ap-grp')).toHaveCount(project.floors[0].APS.length);
}
async function save(page){
  const pending=page.waitForEvent('download');await page.locator('[data-action="save"]').click();
  const stream=await (await pending).createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('inventory summaries and status tooltips switch live without changing rollout data',async({page})=>{
  const project=buildSampleProject();await load(page,project);const before=await save(page);
  const statusNode=await page.locator('#left-list .li-status').first().elementHandle();
  await page.locator('[data-action="show-inventory"]').click();
  const select=page.locator('#mdl-body tbody select').first();const value=await select.inputValue();const node=await select.elementHandle();
  const pct=JSON.parse(await page.locator('[data-i18n="inventory.progress"]').getAttribute('data-i18n-vars')).pct;
  for(const lang of ['en','fr','en','fr']){
    await language(page,lang);const bundle=lang==='fr'?fr:en;
    await expect(page.locator('[data-i18n="inventory.progress"]')).toHaveText(bundle['inventory.progress'].replace('{pct}',String(pct)));
    for(const status of ['planned','ordered','installed','tested','live'])await expect(page.locator(`#mdl-body span[data-i18n="status.${status}"]`)).toHaveText(bundle['status.'+status]);
    expect(await statusNode.evaluate(el=>el===document.querySelector('#left-list .li-status'))).toBe(true);
    const key=await statusNode.getAttribute('data-i18n-title');expect(await statusNode.getAttribute('title')).toBe(bundle[key]);
    await expect(select).toHaveValue(value);expect(await node.evaluate(el=>el===document.querySelector('#mdl-body tbody select'))).toBe(true);
  }
  await page.locator('[data-action="modal-close"]').click();expect((await save(page)).floors).toEqual(before.floors);
});

test('RF descriptions switch live while IDs and unsaved selections remain intact',async({page})=>{
  await load(page,buildSampleProject());await page.locator('[data-action="show-settings"]').click();
  const prop=page.locator('.ep-row').filter({has:page.locator('[data-i18n="settings.propagation_model"]')}).locator('select');
  const region=page.locator('.ep-row').filter({has:page.locator('[data-i18n="settings.regulatory_region"]')}).locator('select');
  await prop.selectOption('multi-wall');await region.selectOption('JP');
  for(const lang of ['en','fr','en','fr']){
    await language(page,lang);const bundle=lang==='fr'?fr:en;
    for(const sel of [prop,region])for(const option of await sel.locator('option').all()){
      const key=await option.getAttribute('data-i18n');await expect(option).toHaveText(bundle[key]);
    }
    await expect(prop).toHaveValue('multi-wall');await expect(region).toHaveValue('JP');
  }
  await page.locator('#mdl-ok').click();const saved=await save(page);
  expect(saved.settings.propagationModel).toBe('multi-wall');expect(saved.settings.regulatoryRegion).toBe('JP');
});

test('map and survey labels update in place while SVG geometry and user annotations stay unchanged',async({page})=>{
  const project=buildSampleProject();project.floors[0].SAMPLES=[{id:'s99',fx:0.5,fy:0.5,rssi:-55,ssid:'Literal SSID',channel:'36'}];
  project.floors[0].ANNOS.push({id:'an98',kind:'text',fx:0.4,fy:0.4,fx2:0.4,fy2:0.4,text:'Note <literal> $&'});
  await load(page,project);const before=await save(page);
  await page.locator('#left-list .list-item').filter({has:page.getByText('Wall 1',{exact:true})}).click();
  const wall=page.locator('.wall-lbl');await expect(wall).toHaveCount(1);const node=await wall.elementHandle();
  const sample=page.locator('.sample-dot title');await expect(sample).toHaveCount(1);const titleNode=await sample.elementHandle();
  const geometry=await page.locator('.sample-dot').evaluate(el=>[el.getAttribute('cx'),el.getAttribute('cy'),el.getAttribute('fill')]);
  const vars=JSON.parse(await sample.getAttribute('data-i18n-vars'));
  for(const lang of ['en','fr','en','fr']){
    await language(page,lang);const bundle=lang==='fr'?fr:en;
    await expect(wall).toHaveText(bundle[await wall.getAttribute('data-i18n')]);
    let expected=bundle['survey.comparison'];for(const [key,value] of Object.entries(vars))expected=expected.replaceAll('{'+key+'}',String(value));
    await expect(sample).toHaveText(expected);
    expect(await node.evaluate(el=>el===document.querySelector('.wall-lbl'))).toBe(true);
    expect(await titleNode.evaluate(el=>el===document.querySelector('.sample-dot title'))).toBe(true);
    expect(await page.locator('.sample-dot').evaluate(el=>[el.getAttribute('cx'),el.getAttribute('cy'),el.getAttribute('fill')])).toEqual(geometry);
    await expect(page.getByText('Note <literal> $&',{exact:true})).toHaveCount(1);
  }
  const saved=await save(page);expect(saved.floors).toEqual(before.floors);
});

test('credential unlock instructions switch live and cancellation keeps devices locked',async({page})=>{
  const project=buildSampleProject();project.settings.language='fr';project.credsVault={ciphertext:'locked literal'};
  await load(page,project);const input=page.locator('#mdl-body input[type="password"]');await input.fill('Secret literal $&');const node=await input.elementHandle();
  for(const lang of ['fr','en','fr']){
    await language(page,lang);await expect(page.locator('[data-i18n="credentials.unlock_instructions"]')).toHaveText((lang==='fr'?fr:en)['credentials.unlock_instructions']);
    await expect(input).toHaveValue('Secret literal $&');expect(await node.evaluate(el=>el===document.querySelector('#mdl-body input'))).toBe(true);
  }
  await page.locator('[data-action="modal-close"]').click();
  const saved=await save(page);for(const kind of ['APS','CAMS','SWS'])for(const device of saved.floors[0][kind])expect(device.creds).toBeUndefined();
});

test('migration warnings use loaded language and retain version and project identifiers',async({page})=>{
  const project=buildSampleProject();project.version=PROJECT_VERSION+1;project.settings.language='fr';await load(page,project);
  await expect(page.locator('#toast')).toHaveText(fr['migration.newer_version'].replace('{version}',String(PROJECT_VERSION+1)));
  expect((await save(page)).floors[0].id).toBe(project.floors[0].id);
  await page.locator('#load-up').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  await expect(page.locator('#toast')).toHaveText(fr['notify.error_loading_project']+fr['migration.missing_floors']);
});

test('French annotation prompt preserves entered text as user content',async({page})=>{
  await load(page,buildSampleProject());await language(page,'fr');
  await page.locator('#btn-cov').click();await page.locator('#btn-anno').click();
  const pending=page.waitForEvent('dialog');const vp=await page.locator('#vp').boundingBox();
  const click=page.mouse.click(vp.x+vp.width/2,vp.y+vp.height/2+60);
  const dialog=await pending;expect(dialog.message()).toBe(fr['anno.label_prompt']);await dialog.accept('Label text <literal> $&');await click;
  await expect(page.getByText('Label text <literal> $&',{exact:true})).toHaveCount(1);
  await language(page,'en');await expect(page.getByText('Label text <literal> $&',{exact:true})).toHaveCount(1);
  expect((await save(page)).floors[0].ANNOS.some(a=>a.text==='Label text <literal> $&')).toBe(true);
});

test('switch uplink unnamed-floor fallback translates live and preserves named floors and IDs',async({page})=>{
  const project=buildSampleProject();const first=project.floors[0];
  project.floors.push({...structuredClone(first),id:'unnamed',name:'',APS:[],CAMS:[],SWS:[{...first.SWS[0],id:'target',name:'Target literal'}]});
  await load(page,project);const before=await save(page);
  await page.locator('.sw-grp[data-id="sw17"]').click();
  const select=page.locator('#sw-uplink');await select.selectOption('target');
  const group=select.locator('[data-i18n-label="topology.floor"]');const node=await group.elementHandle();
  for(const lang of ['en','fr','en','fr']){
    await language(page,lang);await expect(group).toHaveAttribute('label',lang==='fr'?'Étage 2':'Floor 2');
    await expect(select).toHaveValue('target');await expect(group.locator('option')).toHaveText('Target literal · USW-24-PoE');
    expect(await node.evaluate(el=>el===document.querySelector('#sw-uplink [data-i18n-label]'))).toBe(true);
  }
  const saved=await save(page);expect(saved.floors[1]).toEqual(before.floors[1]);
  expect(saved.floors[0].name).toBe(before.floors[0].name);expect(saved.floors[0].SWS[0].uplinkId).toBe('target');
});
