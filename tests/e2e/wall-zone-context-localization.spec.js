import {test,expect} from '@playwright/test';
import {buildSampleProject} from '../../files/src/sampleProject.js';
import {WALL_MATERIALS} from '../../files/src/geometry.js';
import {en} from '../../files/src/i18n/en.js';
import {fr} from '../../files/src/i18n/fr.js';

async function loadProject(page){
  await page.goto('/');
  await page.locator('#load-up').setInputFiles({name:'localization.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(buildSampleProject()))});
  await expect(page.locator('#left-list .list-item')).not.toHaveCount(0);
}

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

for(const kind of ['wall','dz']){
  test(`${kind} panel preserves selected object and unsaved edits across languages`,async({page})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await loadProject(page);
    const item=page.locator('#left-list .list-item').filter({has:page.getByText(kind==='wall'?'Wall 1':'Dead Zone 1',{exact:true})});
    await item.locator('.li-name').click();
    const notes=page.locator('#'+kind+'-notes');
    const node=await notes.elementHandle();
    await notes.fill('Notes / Label / Glass — texte personnel');
    if(kind==='dz')await page.locator('#dz-lbl').fill('Label / Radius — texte personnel');
    const before=await saveProject(page);
    for(const language of ['fr','en','fr']){
      // A draft not yet dispatched through an input event must also survive.
      await notes.evaluate(el=>{/** @type {HTMLTextAreaElement} */(el).value='Draft non enregistré — Notes';});
      await switchLanguage(page,language);
      expect(await node.evaluate(el=>el===document.getElementById(el.id))).toBe(true);
      await expect(notes).toHaveValue('Draft non enregistré — Notes');
      await expect(notes).toHaveAttribute('placeholder',(language==='fr'?fr:en)[kind==='wall'?'wall.notes_hint':'dz.notes_hint']);
      await expect(page.locator('#rp-head')).toHaveText((language==='fr'?fr:en)[kind==='wall'?'sidebar.edit_wall':'sidebar.edit_dz']);
      if(kind==='wall'){
        for(const [id,material] of Object.entries(WALL_MATERIALS)){
          await expect(page.locator(`#wall-mat option[value="${id}"]`)).toHaveText((language==='fr'?fr:en)['wall.material.'+id].replace('{loss}',String(material.loss)));
        }
        await expect(page.locator('#wall-mat')).toHaveValue(before.floors[0].WALLS[0].material);
      }else{
        await expect(page.locator('#dz-lbl')).toHaveValue('Label / Radius — texte personnel');
        await expect(page.locator('[data-i18n="dz.radius"]')).toHaveText(language==='fr'?'Rayon':'Radius');
      }
    }
    expect((await saveProject(page)).floors).toEqual(before.floors);
    if(kind==='wall'){
      await page.locator('#wall-mat').selectOption('glass');
      await expect(page.locator('#rp-body .ep-readout').last()).toHaveText('6 dB');
      await expect(page.locator('#wall-mat option:checked')).toHaveText('Verre · 6 dB');
      expect((await saveProject(page)).floors[0].WALLS[0].material).toBe('glass');
    }else{
      await page.locator('#rp-body [data-change-action="toggle-lock"]').check();
      await expect(page.locator('#rp-body [data-change-action="toggle-lock"]')).toBeChecked();
      await expect(page.locator('[data-i18n="panel.lock"]')).toHaveText('Verrouiller la position');
    }
    await page.locator('#rp-body [data-action="ask-del"]').click();
    await expect(page.locator('#mdl-title')).toHaveText('Supprimer un élément');
    await page.locator('[data-action="modal-close"]').click();
    await expect(page.locator('#rp-head')).toHaveText(kind==='wall'?fr['sidebar.edit_wall']:fr['sidebar.edit_dz']);
    expect(errors).toEqual([]);
  });
}

for(const object of [
  {type:'ap',id:'ap14',group:'ap',field:'ep-name',name:'AP-01',collection:'APS'},
  {type:'dz',id:'dz20',group:'dz',field:'dz-lbl',name:'Dead Zone 1',collection:'DZS'},
  {type:'sw',id:'sw17',group:'sw',field:'sw-name',name:'SW-01',collection:'SWS'},
]){
  test(`${object.type} context menu translates live and retains actions and shortcuts`,async({page})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await loadProject(page);
    const open=async()=>{
      await page.locator(`.${object.group}-grp[data-id="${object.id}"]`).dispatchEvent('contextmenu',{clientX:1250,clientY:680,bubbles:true});
      await expect(page.locator('#ctx-menu')).toHaveClass(/vis/);
    };
    await open();
    const menu=page.locator('#ctx-menu');
    const first=await menu.locator('.ctx-item').first().elementHandle();
    const shortcuts=object.type==='ap'?['Ctrl+D','Ctrl+L','Del']:['Ctrl+L','Del'];
    for(const language of ['en','fr','en','fr']){
      // Clicking Settings dismisses a menu by design. Exercise the same language
      // event directly here to verify an already-visible menu updates in place.
      await page.evaluate(async lang=>{
        const modulePath='/src/i18n.js';const {setLang}=await import(modulePath);setLang(lang);
      },language);
      expect(await first.evaluate(el=>el===document.querySelector('#ctx-menu .ctx-item'))).toBe(true);
      await expect(menu.locator('[data-i18n="context.edit"]')).toHaveText(language==='fr'?'Modifier les propriétés':'Edit properties');
      await expect(menu.locator('[data-i18n="context.lock"]')).toHaveText(language==='fr'?'Verrouiller':'Lock');
      await expect(menu.locator('[data-i18n="modal.delete"]')).toHaveText(language==='fr'?'Supprimer':'Delete');
      await expect(menu.locator('.ctx-key')).toHaveText(shortcuts);
      const bounds=await menu.boundingBox();expect(bounds.x+bounds.width).toBeLessThanOrEqual(1280);
      await expect(page.locator('#'+object.field)).toHaveValue(object.name);
    }
    await menu.locator('[data-i18n="context.lock"]').click();
    await open();
    await expect(menu.locator('[data-i18n="context.unlock"]')).toHaveText('Déverrouiller');
    await menu.locator('[data-i18n="context.unlock"]').click();
    await open();await menu.locator('[data-i18n="context.edit"]').click();
    await expect(page.locator('#'+object.field)).toHaveValue(object.name);
    if(object.type==='ap'){
      await open();await menu.locator('[data-i18n="help.duplicate"]').click();
      await expect(page.locator('#toast')).toHaveText('Point d’accès dupliqué');
      await expect(page.locator('#ep-name')).toHaveValue('AP-01-copy');
    }
    await open();await page.keyboard.press('Escape');await expect(menu).not.toHaveClass(/vis/);
    await open();await menu.locator('[data-i18n="modal.delete"]').click();
    await expect(page.locator('#mdl-body')).toHaveText('Supprimer cet élément ?');
    await page.locator('#mdl-ok').click();
    await expect(page.locator('#toast')).toHaveText('Supprimé');
    expect((await saveProject(page)).floors[0][object.collection].some(item=>item.id===object.id)).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('notifications, sidebar walls and validation localize without changing technical values',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await loadProject(page);
  const wall=page.locator('#left-list .list-item').filter({has:page.getByText('Wall 1',{exact:true})});
  const englishDescription=await wall.locator('.li-sub').textContent();
  await page.evaluate(async()=>{
    const modulePath='/src/i18n.js';const {setLang}=await import(modulePath);setLang('fr');
  });
  const frenchWall=page.locator('#left-list .list-item').filter({has:page.getByText('Mur 1',{exact:true})});
  await expect(frenchWall).toHaveCount(1);
  expect((await frenchWall.locator('.li-sub').textContent()).split(' · ')[1]).toBe(englishDescription.split(' · ')[1]);
  await page.locator('[data-action="show-validation"]').click();
  await expect(page.locator('#mdl-title')).toHaveText(fr['modal.validation']);
  await expect(page.locator('#mdl-body')).toContainText('Étage vérifié');
  const french=await page.locator('#mdl-body').textContent();
  await page.locator('[data-action="modal-close"]').click();
  await page.evaluate(async()=>{const modulePath='/src/i18n.js';const {setLang}=await import(modulePath);setLang('en');});
  await page.locator('[data-action="show-validation"]').click();
  const english=await page.locator('#mdl-body').textContent();
  expect(french.match(/\d+(?:\.\d+)?/g)).toEqual(english.match(/\d+(?:\.\d+)?/g));
  await expect(page.locator('#mdl-body')).toContainText('Checked floor');
  await page.locator('[data-action="modal-close"]').click();
  await switchLanguage(page,'fr');
  await saveProject(page);
  await expect(page.locator('#toast')).toHaveText(fr['notify.project_saved']);
  expect(errors).toEqual([]);
});
