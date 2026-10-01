// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {en} from '../files/src/i18n/en.js';
import {fr} from '../files/src/i18n/fr.js';
import {getLang,onLanguageChange,registerBundle,setLang,t} from '../files/src/i18n.js';
import {localizeDOM,localizeText} from '../files/src/localizeDom.js';

afterEach(()=>{setLang('en');document.body.replaceChildren();});

describe('static interface localization',()=>{
  it('keeps bundle keys and substitution tokens in sync',()=>{
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for(const key of Object.keys(en)){
      expect(fr[key].match(/\{\w+\}/g)||[],key).toEqual(en[key].match(/\{\w+\}/g)||[]);
    }
  });

  it('localizes the actual HTML without changing controls, values, icons or callbacks',()=>{
    const html=readFileSync('files/index.html','utf8');
    document.documentElement.innerHTML=html;
    const button=document.querySelector('[data-action="save"]');
    const input=/** @type {HTMLInputElement} */(document.getElementById('sb-search'));
    const status=/** @type {HTMLSelectElement} */(document.getElementById('sb-status'));
    const listener=vi.fn();button.addEventListener('click',listener);
    input.value='Coverage';status.value='installed';
    const toggle=document.querySelector('#btn-cov .toggle-switch');
    const stop=onLanguageChange(()=>localizeDOM());
    try{
      for(const lang of ['fr','en','fr']){
        setLang(lang);
        expect(document.documentElement.lang).toBe(lang);
        expect(document.querySelector('[data-action="save"]')).toBe(button);
        expect(button.textContent).toBe('💾 '+t('tb.save'));
        expect(input.value).toBe('Coverage');
        expect(status.value).toBe('installed');
        expect(input.placeholder).toBe(t('sidebar.search'));
        expect(document.querySelector('#btn-cov .toggle-switch')).toBe(toggle);
        expect(document.getElementById('btn-add').title).toContain('(A)');
        button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      }
      expect(listener).toHaveBeenCalledTimes(3);
      for(const element of document.querySelectorAll('*')){
        for(const attr of element.attributes){
          if(attr.name==='data-i18n'||attr.name.startsWith('data-i18n-'))expect(en[attr.value],attr.value).toBeDefined();
        }
      }
    }finally{stop();}
  });

  it('updates newly created labels and treats translated markup as text',()=>{
    registerBundle('test-ui',{'test.markup':'<img src=x onerror=alert(1)>'});
    const label=document.createElement('span');
    localizeText(label,'sidebar.edit_ap');document.body.append(label);
    setLang('fr');localizeDOM();expect(label.textContent).toBe(fr['sidebar.edit_ap']);
    setLang('test-ui');localizeText(label,'test.markup');
    expect(label.children).toHaveLength(0);
    expect(label.textContent).toContain('<img');
    expect(t('tb.save')).toBe('Save');
    setLang('unknown');expect(getLang()).toBe('en');
  });

  it('preserves literal device values when translating parameterized panel text and attributes',()=>{
    const select=document.createElement('select');
    const group=document.createElement('optgroup');
    group.setAttribute('data-i18n-label','panel.other');
    const option=document.createElement('option');
    const port='Port $& <custom> "A"';
    option.value=port;
    option.setAttribute('data-i18n','panel.custom_port');
    option.setAttribute('data-i18n-vars',JSON.stringify({port}));
    group.append(option);select.append(group);document.body.append(select);
    const host=document.createElement('input');
    host.value='Identity';
    host.setAttribute('data-i18n-placeholder','panel.host_default');
    host.setAttribute('data-i18n-vars',JSON.stringify({ip:'192.0.2.10'}));
    document.body.append(host);
    for(const lang of ['en','fr','en']){
      setLang(lang);localizeDOM();
      expect(select.value).toBe(port);
      expect(option.textContent).toBe(port+(lang==='fr'?' (personnalisé)':' (custom)'));
      expect(option.childElementCount).toBe(0);
      expect(group.label).toBe(lang==='fr'?'Autre':'Other');
      expect(host.value).toBe('Identity');
      expect(host.placeholder).toBe(t('panel.host_default',{ip:'192.0.2.10'}));
    }
  });
});
