import {test,expect} from '@playwright/test';
import {buildSampleProject} from '../../files/src/sampleProject.js';
import {en} from '../../files/src/i18n/en.js';
import {fr} from '../../files/src/i18n/fr.js';

async function saveProject(page){
  const pending=page.waitForEvent('download');
  await page.locator('[data-action="save"]').click();
  const stream=await (await pending).createReadStream();
  const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function switchLanguage(page,language){
  await page.locator('[data-action="show-settings"]').click();
  await page.locator('.ep-row').filter({has:page.locator('[data-i18n="settings.language"]')}).locator('select').selectOption(language);
  await page.locator('#mdl-ok').click();
}

async function expectPanelTranslations(page,language){
  const bundle=language==='fr'?fr:en;
  const strings=await page.locator('#rp-body [data-i18n], #rp-body [data-i18n-title], #rp-body [data-i18n-placeholder], #rp-body [data-i18n-aria-label], #rp-body [data-i18n-label]').evaluateAll(nodes=>nodes.flatMap(node=>{
    const vars=JSON.parse(node.getAttribute('data-i18n-vars')||'{}');
    return ['','title','placeholder','aria-label','label'].flatMap(attr=>{
      const key=node.getAttribute('data-i18n'+(attr?'-'+attr:''));
      return key?[{key,vars,actual:attr?node.getAttribute(attr):node.textContent}]:[];
    });
  }));
  expect(strings.length).toBeGreaterThan(30);
  for(const {key,vars,actual} of strings){
    expect(bundle[key],key).toBeDefined();
    let expected=bundle[key];
    for(const [name,value] of Object.entries(vars))expected=expected.replaceAll('{'+name+'}',()=>String(value));
    expect(actual,key).toBe(expected);
  }
}

for(const device of [
  {kind:'camera',name:'CAM-01',prefix:'cam',model:'G5 Dome'},
  {kind:'switch',name:'SW-01',prefix:'sw',model:'USW-24-PoE'},
  {kind:'router',name:'Router literal',prefix:'sw',model:'Custom/Other'},
  {kind:'access point',name:'AP-01',prefix:'ep',model:'U6 Pro'},
]){
  test(`${device.kind} panel switches English/French in place and preserves saved values`,async({page},testInfo)=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const project=buildSampleProject();
    project.floors[0].SWS.push({...project.floors[0].SWS[0],id:'router100',name:'Router literal',model:'Custom Router / Other',ports:8,poeBudget:0,fx:.5,fy:.5});
    project.floors[0].CAMS[0].port='Port $& "custom"';
    await page.goto('/');
    await page.locator('#load-up').setInputFiles({name:'panels.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
    await page.locator('#left-list .list-item').filter({has:page.getByText(device.name,{exact:true})}).click();
    const panel=page.locator('#rp-body');
    const model=page.locator('#'+device.prefix+'-model');
    await expect(model).toHaveValue(device.model);
    const name=page.locator('#'+device.prefix+'-name');
    const originalNode=await name.elementHandle();
    await page.locator('#'+device.prefix+'-notes').fill('Identity / Strong / Other — user text');
    await page.locator('#cred-user').fill('Username literal');
    await page.locator('#cred-pass').fill('Password literal');
    const before=await saveProject(page);
    const values=await panel.locator('input:not([type="file"]),select,textarea').evaluateAll(nodes=>nodes.map(node=>({id:node.id,value:/** @type {HTMLInputElement} */(node).value})));
    for(const language of ['en','fr','en']){
      await switchLanguage(page,language);
      expect(await originalNode.evaluate(node=>node===document.getElementById(node.id))).toBe(true);
      await expectPanelTranslations(page,language);
      expect(await panel.locator('input:not([type="file"]),select,textarea').evaluateAll(nodes=>nodes.map(node=>({id:node.id,value:/** @type {HTMLInputElement} */(node).value})))).toEqual(values);
      await expect(model.locator('option:checked')).toHaveText(device.model==='Custom/Other'?(language==='fr'?'Personnalisé/Autre':'Custom/Other'):device.model);
      if(device.kind==='camera'){
        await expect(page.locator('#cam-storage-v')).toContainText('Mbps');
        await expect(page.locator('#cam-port')).toHaveValue('Port $& "custom"');
        await expect(panel.locator('[data-i18n="panel.dori.identify"]')).toHaveText(language==='fr'?'Identifier':'Identify');
      }
      if(device.kind==='router'){
        await expect(page.locator('#sw-model-custom')).toHaveValue('Custom Router / Other');
        await expect(panel.locator('[data-i18n="panel.no_poe"]')).toHaveText(language==='fr'?'sans PoE':'no PoE');
      }
      if(language==='fr'){
        await panel.evaluate(node=>{node.scrollTop=0;});
        await page.screenshot({path:testInfo.outputPath('french-panel.png'),fullPage:true});
      }
    }
    expect((await saveProject(page)).floors).toEqual(before.floors);
    // The existing delegated handlers still operate after repeated localization.
    await panel.locator('[data-action="toggle-pass"]').click();
    await expect(page.locator('#cred-pass')).toHaveAttribute('type','text');
    await page.locator('#'+device.prefix+'-status').selectOption('ordered');
    await switchLanguage(page,'fr');
    await expect(page.locator('#'+device.prefix+'-status')).toHaveValue('ordered');
    if(device.kind==='access point'){
      await page.locator('#ep-freq').selectOption('5 GHz only');
      await expect(page.locator('#ep-freq option:checked')).toHaveText('5 GHz uniquement');
      await page.locator('#ep-pattern').selectOption('sector-90');
      await expect(page.locator('#ep-pattern option:checked')).toHaveText('Secteur 90°');
      const saved=await saveProject(page);
      expect(saved.floors[0].APS[0].freq).toBe('5 GHz only');
      expect(saved.floors[0].APS[0].pattern).toBe('sector-90');
    }
    // Reselect in French to check newly generated panel nodes, not just existing ones.
    await page.locator('#left-list .list-item').filter({has:page.getByText(device.name,{exact:true})}).click();
    await expectPanelTranslations(page,'fr');
    expect(errors).toEqual([]);
  });
}
