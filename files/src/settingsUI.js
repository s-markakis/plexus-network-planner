// Project Settings dialog: the form (branding, coverage display, RF model,
// scale, organization, cabling, cameras, VLANs, credentials passphrase) laid
// out like System Settings — section list on the left, a card per section.
// Built as DOM nodes (no innerHTML), so user-supplied strings are inert.
// Reading the form back is separate from applying it: the app owns SETTINGS.

import { HEATMAP_MODE_KEYS, HEATMAP_MODES, PROPAGATION_MODEL_KEYS, PROPAGATION_MODELS,
  REGULATORY_REGION_KEYS, REGULATORY_REGIONS, ARCH_SCALE_PRESETS } from './constants.js';

export const SETTINGS_STRING_KEYS = ['company','tagline','contact','metaLine','reportTitle','footerLine','logoDataUrl','locale','language','propagationModel','regulatoryRegion','heatmapMode','heatmapBand','archScale','siteCode','namePattern','storageCodec','unifiUrl','unifiSite','unifiUser'];
export const SETTINGS_NUMBER_KEYS = ['noiseFloorDbm','floorSlabAttenDb','floorHeightM','cableRoutingFactor','cableBoxM','expectedClients','perClientMbps','retentionDays'];
export const SETTINGS_BOOL_KEYS = ['showRoamingOverlap','showFloorLeakage','colorByVlan','showDori'];

// Group the flat form by its headings into a nav + one card per section. All
// sections stay in the page (the nav scrolls to them).
function paneSettings(doc,form){
  /** @type {Array<{title:string, nodes:Element[]}>} */ const groups=[];
  /** @type {{title:string, nodes:Element[]}|null} */ let cur=null;
  for(const k of [...form.children]){
    if(k.classList.contains('settings-heading')){cur={title:k.textContent,nodes:[]};groups.push(cur);}
    else{if(!cur){cur={title:'General',nodes:[]};groups.push(cur);}cur.nodes.push(k);}
  }
  if(groups.length<2)return;
  const nav=doc.createElement('div');nav.className='settings-nav';
  const panes=doc.createElement('div');panes.className='settings-panes';
  const items=[];
  groups.forEach((g,i)=>{
    const pane=doc.createElement('section');pane.className='settings-pane';
    const h=doc.createElement('div');h.className='settings-pane-title';h.textContent=g.title;
    const card=doc.createElement('div');card.className='settings-card';
    card.append(...g.nodes);
    pane.append(h,card);panes.appendChild(pane);
    const b=doc.createElement('button');b.type='button';b.className='settings-nav-item'+(i===0?' active':'');b.textContent=g.title;
    b.addEventListener('click',()=>{
      items.forEach(x=>x.classList.toggle('active',x===b));
      pane.scrollIntoView({block:'start',behavior:'smooth'});
    });
    items.push(b);nav.appendChild(b);
  });
  form.replaceChildren(nav,panes);
  form.classList.add('paned');
}

// A language's own name ("English", "Ελληνικά"), falling back to the code
// where Intl.DisplayNames is unavailable or doesn't know it.
/** @param {string} code */
function languageName(code) {
  try {
    const n = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return n && n !== code ? n.charAt(0).toLocaleUpperCase(code) + n.slice(1) : code;
  } catch { return code; }
}

/**
 * @param {Document} doc
 * @param {{settings:any, vlans:any[], credsPass:string, langs:string[], onOpacityPreview:(v:number)=>void}} p
 * @returns {{el:HTMLElement, read:()=>{inputs:Record<string,any>, vlans:any[], opacity:number, credPass:string}}}
 */
export function settingsForm(doc, { settings, vlans, credsPass, langs, onOpacityPreview }) {
  const wrap=doc.createElement('div');wrap.className='settings-form';

  // ── Helpers for compact rows ──
  const inputs={};
  const addText=(key,label,placeholder)=>{
    const row=doc.createElement('div');row.className='ep-row';
    const lbl=doc.createElement('label');lbl.className='ep-lbl';lbl.textContent=label;
    const inp=doc.createElement('input');inp.className='ep-in';inp.type='text';
    inp.value=settings[key]??'';inp.placeholder=placeholder||'';
    row.appendChild(lbl);row.appendChild(inp);wrap.appendChild(row);
    inputs[key]=inp;
  };
  const addNumber=(key,label,min,max,step)=>{
    const row=doc.createElement('div');row.className='ep-row';
    const lbl=doc.createElement('label');lbl.className='ep-lbl';lbl.textContent=label;
    const inp=doc.createElement('input');inp.className='ep-in';inp.type='number';
    if(min!==undefined)inp.min=min;if(max!==undefined)inp.max=max;
    if(step!==undefined)inp.step=step;
    inp.value=String(settings[key]??'');
    row.appendChild(lbl);row.appendChild(inp);wrap.appendChild(row);
    inputs[key]=inp;
  };
  const addSelect=(key,label,options)=>{
    const row=doc.createElement('div');row.className='ep-row';
    const lbl=doc.createElement('label');lbl.className='ep-lbl';lbl.textContent=label;
    const sel=doc.createElement('select');sel.className='ep-in';
    for(const o of options){
      const op=doc.createElement('option');op.value=o.value;op.textContent=o.label;
      if(String(settings[key])===String(o.value))op.selected=true;
      sel.appendChild(op);
    }
    row.appendChild(lbl);row.appendChild(sel);wrap.appendChild(row);
    inputs[key]=sel;
  };
  const addCheck=(key,label)=>{
    const row=doc.createElement('div');row.className='ep-row';
    const lbl=doc.createElement('label');lbl.className='ep-lbl';lbl.textContent=label;
    const inp=doc.createElement('input');inp.type='checkbox';
    inp.checked=!!settings[key];
    row.appendChild(lbl);row.appendChild(inp);wrap.appendChild(row);
    inputs[key]=inp;
  };
  const addHeading=(text)=>{
    const h=doc.createElement('div');h.className='settings-heading';h.textContent=text;
    wrap.appendChild(h);
  };

  // ── Branding ──
  addHeading('Branding');
  addText('company','Company / Brand','Plexus');
  addText('tagline','Tagline','Network Planning');
  addText('contact','Contact','hello@plexus.example');
  addText('metaLine','Cover meta line','optional, shown above the logo on exports');
  addText('reportTitle','Report title','Network Audit Report');
  addText('footerLine','Footer line','optional, shown in HTML/PDF report footer');
  addText('logoDataUrl','Brand logo (data URL)','data:image/png;base64,...');
  addText('locale','Date locale','en-GB');
  addSelect('language','UI language',langs.map(c=>({value:c,label:languageName(c)})));

  // ── Coverage display ──
  addHeading('Coverage display');
  const opacityRow=doc.createElement('div');opacityRow.className='ep-row ep-slider-row';
  const opacityLbl=doc.createElement('label');opacityLbl.className='ep-lbl';opacityLbl.textContent='Coverage opacity';
  const opacityIn=doc.createElement('input');
  opacityIn.type='range';opacityIn.min='20';opacityIn.max='100';opacityIn.step='5';
  opacityIn.className='ep-rng';
  const initialOpacity=Math.max(20,Math.min(100,Math.round(settings.coverageOpacity??100)));
  opacityIn.value=String(initialOpacity);
  const opacityVal=doc.createElement('span');opacityVal.className='ep-rng-val';opacityVal.textContent=initialOpacity+'%';
  opacityRow.appendChild(opacityLbl);opacityRow.appendChild(opacityIn);opacityRow.appendChild(opacityVal);
  wrap.appendChild(opacityRow);
  opacityIn.addEventListener('input',()=>{
    const v=parseInt(opacityIn.value,10)||100;
    opacityVal.textContent=v+'%';
    onOpacityPreview(v);
  });
  addSelect('heatmapMode','Heatmap mode',HEATMAP_MODE_KEYS.map(k=>({value:k,label:HEATMAP_MODES[k].label})));
  addSelect('heatmapBand','Heatmap band',[
    {value:'all',label:'All bands'},
    {value:'2.4',label:'2.4 GHz'},
    {value:'5',label:'5 GHz'},
    {value:'6',label:'6 GHz'},
  ]);
  addCheck('showRoamingOverlap','Show roaming-overlap layer (≥2 APs ≥ -67 dBm)');

  // ── RF model + regulatory ──
  addHeading('RF model & regulatory');
  addSelect('propagationModel','Propagation model',PROPAGATION_MODEL_KEYS.map(k=>({value:k,label:PROPAGATION_MODELS[k].label})));
  addSelect('regulatoryRegion','Regulatory region',REGULATORY_REGION_KEYS.map(k=>({value:k,label:REGULATORY_REGIONS[k].label})));
  addNumber('noiseFloorDbm','Noise floor (dBm)',-110,-70,1);
  addNumber('floorSlabAttenDb','Floor slab attenuation (dB)',0,40,1);
  addNumber('floorHeightM','Floor-to-floor height (m)',2,10,0.1);
  addCheck('showFloorLeakage','Include other floors in heatmap (through the slabs)');

  // ── Architect scale ──
  addHeading('Drawing scale');
  addSelect('archScale','Architect scale preset',[
    {value:'',label:'Custom (use scale toolbar)'},
    ...ARCH_SCALE_PRESETS.map(p=>({value:p.label,label:`${p.label} (${p.m100px} m / 100 px)`})),
  ]);

  // ── Organization ──
  addHeading('Organization');
  addText('siteCode','Site code','HQ — feeds {site} in the name pattern');
  addText('namePattern','Device name pattern','{site}-F{floor}-{type}{nn}');
  const nameHint=doc.createElement('div');nameHint.className='ep-hint';
  nameHint.textContent='Tokens: {site} {floor} {type} {n}/{nn}/{nnn}. Validate flags names that break the pattern; Inventory → Auto-rename applies it to every device.';
  wrap.appendChild(nameHint);

  // ── Cabling & capacity ──
  addHeading('Cabling & capacity');
  addNumber('cableRoutingFactor','Cable routing factor',1,3,0.05);
  addNumber('cableBoxM','Cable box length (m)',1,1000,1);
  addNumber('expectedClients','Expected concurrent clients',0,100000,1);
  addNumber('perClientMbps','Per-client demand (Mbps)',0.5,100,0.5);
  addCheck('colorByVlan','Colour devices by VLAN on the map');

  // ── Cameras: DORI + storage ──
  addHeading('Cameras');
  addCheck('showDori','Show DORI pixel-density bands in camera cones');
  addNumber('retentionDays','Video retention (days)',1,365,1);
  addSelect('storageCodec','Recording codec',[
    {value:'h265',label:'H.265 / HEVC'},
    {value:'h264',label:'H.264 / AVC'},
  ]);

  // ── VLAN registry ──
  addHeading('VLANs');
  const vlanWrap=doc.createElement('div');
  const vlanRows=[];
  const addVlanRow=(v)=>{
    const row=doc.createElement('div');row.className='ep-row';row.style.cssText='display:flex;gap:4px;align-items:center';
    const id=doc.createElement('input');id.className='ep-in';id.placeholder='ID';id.value=(v&&v.id)||'';id.style.cssText='width:50px;flex:0 0 auto';
    const name=doc.createElement('input');name.className='ep-in';name.placeholder='Name';name.value=(v&&v.name)||'';
    const color=doc.createElement('input');color.type='color';color.value=(v&&v.color)||'#1565c0';color.style.cssText='width:30px;height:28px;padding:0;border:none;background:none;flex:0 0 auto';
    const subnet=doc.createElement('input');subnet.className='ep-in ep-mono';subnet.placeholder='10.0.10.0/24';subnet.value=(v&&v.subnet)||'';subnet.style.cssText='width:118px;flex:0 0 auto';
    const gw=doc.createElement('input');gw.className='ep-in ep-mono';gw.placeholder='gateway';gw.title='Gateway/SVI IP for inter-VLAN routing (L3)';gw.value=(v&&v.gateway)||'';gw.style.cssText='width:92px;flex:0 0 auto';
    const del=doc.createElement('button');del.className='btn';del.textContent='✕';del.style.cssText='flex:0 0 auto;padding:4px 8px';
    const entry={id,name,color,subnet,gw};
    del.addEventListener('click',()=>{row.remove();const i=vlanRows.indexOf(entry);if(i>=0)vlanRows.splice(i,1);});
    row.append(id,name,color,subnet,gw,del);
    vlanWrap.appendChild(row);
    vlanRows.push(entry);
  };
  vlans.forEach(addVlanRow);
  wrap.appendChild(vlanWrap);
  const addVlanBtn=doc.createElement('button');addVlanBtn.className='btn';addVlanBtn.textContent='+ Add VLAN';addVlanBtn.style.marginTop='4px';
  addVlanBtn.addEventListener('click',()=>addVlanRow());
  wrap.appendChild(addVlanBtn);

  // ── Security ──
  addHeading('Security');
  const credRow=doc.createElement('div');credRow.className='ep-row';
  const credLbl=doc.createElement('label');credLbl.className='ep-lbl';credLbl.textContent='Credentials passphrase';
  const credInp=doc.createElement('input');
  credInp.type='password';credInp.className='ep-in';credInp.autocomplete='new-password';
  credInp.value=credsPass;credInp.placeholder='blank = store credentials unencrypted';
  credRow.append(credLbl,credInp);wrap.appendChild(credRow);
  const credHint=doc.createElement('div');credHint.className='ep-hint';
  credHint.textContent='When set, device credentials are AES-256-GCM encrypted in saved project files and never written to autosave or Share links. Session-only — not stored anywhere; you re-enter it to unlock an encrypted project.';
  wrap.appendChild(credHint);

  const hint=doc.createElement('div');
  hint.className='ep-hint';
  hint.textContent='Saved with the project. Used in HTML/PDF exports, the heatmap pipeline, the top-bar brand label, and channel/Tx planning. Routing factor scales straight-line cable runs; VLAN subnets feed the “suggest IP” buttons.';
  wrap.appendChild(hint);


  paneSettings(doc, wrap);
  // What the user entered, read on OK. Inputs are returned as elements so the
  // caller keeps its exact comparison/apply rules.
  const read = () => ({
    inputs,
    vlans: vlanRows.map((e) => ({ id: (e.id.value || '').trim(), name: (e.name.value || '').trim(), color: e.color.value || '', subnet: (e.subnet.value || '').trim(), gateway: (e.gw.value || '').trim() })).filter((v) => v.id || v.name),
    opacity: parseInt(opacityIn.value, 10) || 100,
    credPass: credInp.value,
  });
  return { el: wrap, read };
}
