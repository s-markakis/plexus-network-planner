import {test,expect} from '@playwright/test';
import {buildSampleProject} from '../../files/src/sampleProject.js';
import {en} from '../../files/src/i18n/en.js';
import {fr} from '../../files/src/i18n/fr.js';

async function loadProject(page,project){
  await page.goto('/');
  await page.locator('#load-up').setInputFiles({name:'summaries.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.ap-grp')).toHaveCount(project.floors[0].APS.length);
}
async function language(page,lang){
  await page.evaluate(async value=>{const path='/src/i18n.js';const {setLang}=await import(path);setLang(value);},lang);
}
async function translatedNodes(page,lang){
  const bundle=lang==='fr'?fr:en;
  const nodes=await page.locator('#mdl [data-i18n], #mdl [data-i18n-title]').evaluateAll(elements=>elements.flatMap(el=>{
    const vars=JSON.parse(el.getAttribute('data-i18n-vars')||'{}');
    return ['','title'].flatMap(attr=>{const key=el.getAttribute('data-i18n'+(attr?'-'+attr:''));return key?[{key,vars,text:attr?el.getAttribute(attr):el.textContent}]:[];});
  }));
  expect(nodes.length).toBeGreaterThan(3);
  for(const {key,vars,text} of nodes){
    expect(bundle[key],key).toBeDefined();
    let expected=bundle[key];for(const [name,value] of Object.entries(vars))expected=expected.replaceAll('{'+name+'}',()=>String(value));
    expect(text,key).toBe(expected);
  }
}
async function save(page){
  const pending=page.waitForEvent('download');await page.locator('[data-action="save"]').click();
  const stream=await (await pending).createReadStream();const chunks=[];
  for await(const chunk of stream)chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

for(const view of ['poe','topology']){
  test(`${view} summaries switch languages in place and preserve values`,async({page})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const project=buildSampleProject();const floor=project.floors[0];
    floor.SWS[0].name='Switch <literal> $&';floor.SWS[0].ports=2;floor.SWS[0].poeBudget=1;
    floor.SWS.push({...floor.SWS[0],id:'no-poe',name:'No PoE literal',model:'Custom/Other',poeBudget:0,ports:0});
    floor.APS[0].swId='no-poe';floor.APS[0].port='';
    for(const d of [...floor.APS.slice(1),...floor.CAMS]){d.swId=floor.SWS[0].id;d.port='';}
    project.floors.push({...structuredClone(floor),id:'f2',name:'',APS:[],CAMS:[],SWS:[{...floor.SWS[0],id:'other-floor',name:'Other floor literal',model:'Custom/Other',ports:0}]});
    await loadProject(page,project);
    const loaded=await save(page);
    await page.locator(`[data-action="show-${view}"]`).click();
    const body=await page.locator('#mdl-body').elementHandle();
    const english=await page.locator('#mdl-body').textContent();
    for(const lang of ['en','fr','en','fr']){
      await language(page,lang);await translatedNodes(page,lang);
      expect(await body.evaluate(el=>el===document.getElementById('mdl-body'))).toBe(true);
      const text=await page.locator('#mdl-body').textContent();
      expect(text.match(/\d+(?:\.\d+)?/g)).toEqual(english.match(/\d+(?:\.\d+)?/g));
      expect(text).toContain('Switch <literal> $&');
      await expect(page.locator('#mdl-body literal')).toHaveCount(0);
    }
    if(view==='poe'){
      await expect(page.locator('[data-i18n="poe.draw_warning"]')).toHaveCount(1);
      await expect(page.locator('[data-i18n="poe.port_warning"]')).toHaveCount(1);
      await expect(page.locator('[data-i18n="poe.class_warning_none"]')).toHaveCount(1);
    }else{
      await expect(page.locator('[data-i18n="topology.floor"]')).toHaveText('Étage 2');
      await expect(page.locator('[data-i18n="topology.cabling"]')).toContainText('Câblage');
      await expect(page.locator('[data-i18n-title="topology.port_free"]').first()).toHaveAttribute('title','Port 1 : libre');
    }
    await page.locator('[data-action="modal-close"]').click();
    const saved=await save(page);
    for(let i=0;i<project.floors.length;i++)for(const kind of ['APS','CAMS','SWS','WALLS'])expect(saved.floors[i][kind]).toEqual(loaded.floors[i][kind]);
    expect(errors).toEqual([]);
  });
}

test('revision differences translate live, escape names and retain snapshots and actions',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const project=buildSampleProject();const before=structuredClone(project.floors);
  before[0].APS[0].name='<literal> $&';before[0].APS[0].ip='';before[0].APS[0].fx+=0.01;
  before[0].WALLS[0].fx1+=0.01;before[0].APS.pop();
  before[0].SWS.push({...before[0].SWS[0],id:'removed',name:'Removed literal'});
  before.push({...structuredClone(before[0]),id:'removed-floor',name:'Removed floor literal'});
  project.revisions=[{id:'rev-a',name:'Revision <literal> $&',createdAt:'2026-10-01T10:00:00Z',baseline:true,snapshot:before},{id:'rev-b',name:'Unchanged revision',createdAt:'2026-10-02T10:00:00Z',baseline:false,snapshot:structuredClone(project.floors)}];
  await loadProject(page,project);await page.locator('[data-action="show-revisions"]').click();
  await page.locator('.rev-row').first().locator('[data-i18n="revisions.diff"]').click();
  const diff=await page.locator('.rev-diff').elementHandle();const original=await page.locator('.rev-diff').textContent();
  for(const lang of ['en','fr','en','fr']){
    await language(page,lang);await translatedNodes(page,lang);
    expect(await diff.evaluate(el=>el===document.querySelector('.rev-diff'))).toBe(true);
    await expect(page.locator('.rev-diff')).toContainText('Revision <literal> $&');
    await expect(page.locator('.rev-diff')).toContainText('<literal> $&');
    await expect(page.locator('.rev-diff literal')).toHaveCount(0);
    expect((await page.locator('.rev-diff').textContent()).match(/\d+(?:\.\d+)?/g)).toEqual(original.match(/\d+(?:\.\d+)?/g));
  }
  await expect(page.locator('.rev-diff')).toContainText('remodelé');
  await expect(page.locator('.rev-diff')).toContainText('(vide)');
  await page.locator('[data-i18n="revisions.diff_last"]').click();
  await expect(page.locator('.rev-diff')).toHaveCount(2);
  await page.locator('.rev-row').last().locator('[data-i18n="revisions.diff"]').click();
  await expect(page.locator('.rev-diff').last()).toContainText(fr['revisions.no_diff']);
  await language(page,'en');await expect(page.locator('.rev-diff').last()).toContainText(en['revisions.no_diff']);
  await page.locator('[data-action="modal-close"]').click();
  expect((await save(page)).revisions).toEqual(project.revisions);
  await page.locator('[data-action="show-revisions"]').click();
  await page.locator('.rev-row').first().locator('[data-i18n-title="revisions.unmark"]').click();
  await expect(page.locator('.rev-row').first().locator('[data-i18n-title="revisions.mark"]')).toHaveCount(1);
  await page.locator('[data-action="modal-close"]').click();
  expect((await save(page)).revisions[0].baseline).toBe(false);
  expect(errors).toEqual([]);
});
