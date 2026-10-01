// @ts-nocheck
// Single source of truth: pure geometry + migration helpers live in
// files/src/*.js so they can be unit-tested under vitest without the DOM.
// app.js imports them as ES modules; Vite handles bundling for production.
//
// Note: this DOM-heavy orchestrator is excluded from strict typecheck (the
// `@ts-nocheck` directive above). Type safety is enforced on the pure modules
// in files/src/*.js where the schema invariants and RF math live.
import {
  WALL_MATERIALS,
  bandLossMultiplier,
  wallToPx,
  computeCoveragePath as _computeCoveragePath,
  sampleFloorCoverage as _sampleFloorCoverage,
  sampleRoamingOverlap as _sampleRoamingOverlap,
  dbmAt,
  snrAt,
  mbpsAt,
  mcsFromSnr,
  effectiveEirp,
  dbmAtThroughSlab,
  bandKey,
  CHANNEL_WIDTHS,
  channelsOverlapMhz,
  widthThroughputMult,
} from './src/geometry.js';
import {computeHeatGrid} from './src/heatmap.js';
// Heatmap computation runs in a Web Worker (inline-bundled like the PDF
// worker) so dragging an AP never janks the main thread. computeHeatGrid is
// the synchronous fallback when workers are unavailable.
import HeatWorker from './src/heatmapWorker.js?worker&inline';
import {
  migrateProject,
  syncNidFromFloors as _syncNidFromFloors,
  nextNameSuffix,
  PROJECT_VERSION,
  DEFAULT_SETTINGS,
} from './src/migrate.js';
import {
  AP_MODEL_GROUPS, MODELS, AP_RANGE_M, AP_ANTENNA_GAIN_DBI,
  SW_MODEL_GROUPS, SW_MODELS, SW_POE_BUDGET_W,
  SW_PORTS, swPortCount, SW_POE_CLASS, POE_CLASS_RANK,
  poeClassForWatts, swPoeClass,
  WALL_MATERIAL_KEYS, AP_COLORS,
  AP_PATTERNS, AP_PATTERN_KEYS, AP_POE_W,
  CAM_MODEL_GROUPS, CAM_MODELS, CAM_SPECS,
  HEATMAP_STOPS, HEATMAP_MODES, HEATMAP_MODE_KEYS,
  REGULATORY_REGIONS, REGULATORY_REGION_KEYS, DEFAULT_REGULATORY_REGION,
  PROPAGATION_MODELS, PROPAGATION_MODEL_KEYS,
  ROAMING_OVERLAP_DBM, DEFAULT_FLOOR_SLAB_DB,
  ARCH_SCALE_PRESETS,
  MODEL_IMAGE_PLACEHOLDERS, modelImageUrl, MODEL_IMAGES,
  DEVICE_STATUSES, DEVICE_STATUS_META,
} from './src/constants.js';
import {runLengthM,analyzeLoad,nextFreeIp as netNextFreeIp,ipInCidr,subnetUsage,airtimeUtilization} from './src/network.js';
import {formatName,nameMatches,patternHasNumber} from './src/naming.js';
import {zipStore} from './src/zip.js';
import {encryptObject,decryptObject} from './src/crypto.js';
// PDF floor-plan import. The worker is bundled inline (?worker&inline) so the
// portable single-file build still works from file:// with no external fetch.
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import {t,setLang,getLang,availableLangs,onLanguageChange} from './src/i18n.js';
import {localizeDOM,localizeText} from './src/localizeDom.js';
import {detectWalls} from './src/walldetect.js';
import {parseDxf} from './src/dxf.js';
import {importEsx,buildEsxZip} from './src/esx.js';
import {CAM_RES_HPX,DORI_LEVELS,doriDistancesM,cameraBitrateMbps,storageGb} from './src/cameras.js';
import {buildSampleProject} from './src/sampleProject.js';
import {
  idbPutImage, idbGetImage, idbDeleteImage,
  newImgId as _newImgId,
  imgCache as _imgCache,
  resolveFloorImage,
} from './src/imageStore.js';

// AP_MODEL_GROUPS, AP_RANGE_M, SW_MODEL_GROUPS, AP_COLORS, WALL_MATERIAL_KEYS
// all live in ./src/constants.js (single source of truth for the catalogs).

// ═══ COVERAGE GEOMETRY (wall-clipped) ═════════════
// For each AP we cast N rays outward. For each ray we find how many walls
// it crosses and sum the dB loss (scaled by the AP's band factor), then
// shrink the ray's max length by the attenuation factor. We cache the
// polygon's SVG path on the AP object and invalidate it only when walls or
// AP position/radius change. The actual ray-cast lives in geometry.js.
const COVERAGE_RAYS=72;   // one ray every 5°.

function _apPatternOpts(ap){
  const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
  return {
    rays:COVERAGE_RAYS,
    bandFactor:bandLossMultiplier(ap.freq),
    arcDeg:pat.arc,
    headingDeg:ap.heading||0,
  };
}
function computeCoveragePath(ap){
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  return _computeCoveragePath(ap,w,h,WALLS(),_apPatternOpts(ap));
}

// Cache lookups — both outer (full r) and inner (r * 0.54) coverage paths are
// memoized on the AP. Cache fields are prefixed `_` so the save/autosave
// stripper drops them, keeping JSON small and avoiding stale cache resurrection.
function _cacheKey(ap,r){return `${ap.fx},${ap.fy},${r},${ap.freq||''},${ap.pattern||''},${ap.heading||0},${WALLS().length},${_wallsCacheKey}`;}
function getCoveragePath(ap){
  const key=_cacheKey(ap,ap.r);
  if(ap._coveragePath&&ap._coverageFor===key)return ap._coveragePath;
  const path=computeCoveragePath(ap);
  ap._coveragePath=path;
  ap._coverageFor=key;
  return path;
}
function getInnerCoveragePath(ap){
  const innerR=ap.r*.54;
  const key=_cacheKey(ap,innerR);
  if(ap._innerCoveragePath&&ap._innerCoverageFor===key)return ap._innerCoveragePath;
  const path=computeCoveragePath({fx:ap.fx,fy:ap.fy,r:innerR,freq:ap.freq,pattern:ap.pattern,heading:ap.heading});
  ap._innerCoveragePath=path;
  ap._innerCoverageFor=key;
  return path;
}
let _wallsCacheKey=0;
function invalidateCoverageCache(){_wallsCacheKey++;}

// Convert metres → pixels using current floor's scale (metres per 100 px)
function rangeMToPx(m){return Math.round(m*100/(scaleM||100));}

// HTML-escape for safely interpolating user-controlled strings into templates.
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

// Convert "#rrggbb" to "rgba(r,g,b,a)" — used for AP color fills where we want
// the stroke at full opacity but the fill semi-transparent so overlaps blend.
function hexToRgba(hex,alpha){
  if(!hex||hex[0]!=='#'||hex.length!==7)return `rgba(0,0,0,${alpha})`;
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Theme-aware color helpers for inline SVG attributes (which can't reference CSS
// custom properties). These read the current values from :root at call time, so
// they automatically follow theme switches without re-rendering bookkeeping.
// `_themeCache` memoizes both --ink and --bg per render pass; reset by
// `_resetThemeCache()` (called at the start of render() and on theme toggle).
let _themeCache={ink:null,bg:null};
function _resetThemeCache(){_themeCache.ink=null;_themeCache.bg=null;}
function tInk(alpha){
  // Get the current --ink color and apply alpha. CSS may compute the var as
  // a 3-char hex (#000), a 6-char hex (#000000), or rgb()/rgba(), depending on
  // how the var is declared and how the browser normalizes it. Handle all three.
  const ink=_themeCache.ink||(_themeCache.ink=(getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()||'#000'));
  if(alpha===undefined||alpha>=1)return ink;
  let r,g,b;
  if(ink[0]==='#'&&ink.length===4){
    // Shorthand hex like #abc → expands to #aabbcc
    r=parseInt(ink[1]+ink[1],16);g=parseInt(ink[2]+ink[2],16);b=parseInt(ink[3]+ink[3],16);
  }else if(ink[0]==='#'&&ink.length===7){
    r=parseInt(ink.slice(1,3),16);g=parseInt(ink.slice(3,5),16);b=parseInt(ink.slice(5,7),16);
  }else{
    // Already in rgb()/rgba() form. Pull out the first three numbers.
    const m=ink.match(/(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
    if(m){r=+m[1];g=+m[2];b=+m[3];}
    else return ink;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}
function tBg(){
  return _themeCache.bg||(_themeCache.bg=(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()||'#efece5'));
}

// Build an <optgroup>-structured <option> list for a grouped dropdown.
// If `selected` isn't in any group's list, the "Custom/Other" option (if present) gets selected
// and the panel will show a free-text override input.
function buildGroupedOptions(groups,selected){
  const flat=groups.flatMap(g=>g.models);
  const known=flat.includes(selected);
  return groups.map(g=>{
    const opts=g.models.map(m=>{
      const isSel=(m===selected)||(!known&&m==='Custom/Other');
      return `<option${isSel?' selected':''}>${esc(m)}</option>`;
    }).join('');
    return `<optgroup label="${esc(g.label)}">${opts}</optgroup>`;
  }).join('');
}


// Image store (IndexedDB-backed) lives in ./src/imageStore.js. We import
// idbPutImage / idbGetImage / idbDeleteImage / newImgId / imgCache /
// resolveFloorImage at the top of this file.

// ═══ PROJECT SETTINGS ═════════════════════════════
// DEFAULT_SETTINGS imported from ./src/migrate.js (single source of truth).
// Clone vlans so we never mutate the shared DEFAULT_SETTINGS array.
let SETTINGS={...DEFAULT_SETTINGS,vlans:[]};
// Session-only credentials passphrase. When set, device credentials are
// AES-GCM encrypted in saved/exported project files and stripped from autosave
// and Share links. Never persisted to SETTINGS or disk.
let _credPass='';

// ═══ STATE ════════════════════════════════════════
let FLOORS=[{id:'f1',name:'Floor 1',img:'',imgName:'',APS:[],DZS:[],SWS:[],WALLS:[],CAMS:[],ANNOS:[],SAMPLES:[],scaleM:100}];
let curFloor=0;
let nid=1;
let mode='add';
let selId=null,selType=null;
let showOL=false,showHeat=false,showGrid=false;
let showCoverage=true;  // coverage circles/polygons. Toggle to declutter the map.
let pres=false;
let pendDel=null,modalCB=null;
// scaleM is a mirror of F().scaleM kept in sync for fast read access.
// Reads happen on every render; writes go through setScaleM() which updates
// both the global and the current floor.
let scaleM=100; // metres per 100px (mirror of current floor's scaleM)
function syncScaleFromFloor(){scaleM=F().scaleM||100;const el=document.getElementById('scale-m');if(el)el.value=scaleM;}
function setScaleM(v){scaleM=Math.max(1,parseFloat(v)||100);F().scaleM=scaleM;}
// Undo/redo
let undoStack=[],redoStack=[];
// Zoom/pan
let scale=1,panX=0,panY=0;
let panning=false,panStartX=0,panStartY=0,panPrevX=0,panPrevY=0;
// Drag
let dragId=null,dragType=null,dragOffX=0,dragOffY=0;
let resId=null,resizeStartX=0,resizeStartR=0;
// Ruler (measurement tool)
let rulerStart=null;      // {x,y} in image coords, once the user has placed the first point
let rulerEnd=null;        // {x,y} once two clicks have happened; null while still hovering
let rulerHover=null;      // {x,y} current pointer position while waiting for 2nd click
let calibratePending=false; // next completed ruler line opens the scale-calibration prompt
// Wall (draw tool)
let wallStart=null;       // {x,y} in image coords
let wallHover=null;       // {x,y} while dragging out second point
// Grid
const GRID_SZ=50; // px in image space
// Search filter for left sidebar list. Empty string = show all.
let searchQuery='';
let _searchT=null;
let statusFilter='';   // '' = all; otherwise dim devices whose status differs

// Shortcuts
const F=()=>FLOORS[curFloor];
const APS=()=>F().APS;
const DZS=()=>F().DZS;
const SWS=()=>F().SWS;
const WALLS=()=>F().WALLS||(F().WALLS=[]);
const CAMS=()=>F().CAMS||(F().CAMS=[]);
const ANNOS=()=>F().ANNOS||(F().ANNOS=[]);
const SAMPLES=()=>F().SAMPLES||(F().SAMPLES=[]);
const REVS=()=>(typeof window!=='undefined'&&Array.isArray(PROJECT_REVISIONS)?PROJECT_REVISIONS:[]);

// v3 state
let annoStart=null;        // {x,y} while drawing an arrow/dim annotation
let annoHover=null;
let annoSubMode='text';    // 'text' | 'arrow' | 'dim'
let apStickStart=null;     // {id, fx, fy, covPct} captured at drag start (AP-on-stick)
let apStickBest=null;      // best coverage % seen during this drag
let PROJECT_REVISIONS=[];  // mirror of data.revisions for the loaded project

// ═══ DOM ══════════════════════════════════════════
const viewport=document.getElementById('vp'),canvas=document.getElementById('cv'),mapImg=document.getElementById('mi');
const svgLayer=document.getElementById('sl');
const apLayer=document.getElementById('ap-layer'),dzLayer=document.getElementById('dz-layer');
const swLayer=document.getElementById('sw-layer');
const camLayer=document.getElementById('cam-layer');
const olLayer=document.getElementById('ol-layer'),heatLayer=document.getElementById('heat-layer');
const heatCanvas=document.getElementById('heat-canvas');
const gridLayer=document.getElementById('grid-layer');
const rulerLayer=document.getElementById('ruler-layer');
const wallLayer=document.getElementById('wall-layer');
const cableLayer=document.getElementById('cable-layer');
const chOverlapLayer=document.getElementById('ch-overlap-layer');
const marqueeLayer=document.getElementById('marquee-layer');
// Minimap was removed. These references are kept as nulls so the rest of the
// codebase doesn't need changes; renderMM is a no-op below, and mmImg.src
// assignments are guarded with `if(mmImg)` checks throughout.
const mmImg=null,mmVp=null;
const leftList=document.getElementById('left-list'),rpBody=document.getElementById('rp-body');

// ═══ FLOORS ═══════════════════════════════════════
function renderFloorTabs(){
  const c=document.getElementById('floor-tabs');c.innerHTML='';
  const canDelete=FLOORS.length>1;
  FLOORS.forEach((f,i)=>{
    const t=document.createElement('div');
    t.className='ftab'+(i===curFloor?' active':'');
    // Name label
    const name=document.createElement('span');name.className='ftab-name';name.textContent=f.name;
    t.appendChild(name);
    // Delete × (only shown when more than one floor exists)
    if(canDelete){
      const x=document.createElement('button');
      x.className='ftab-del';x.textContent='×';x.setAttribute('data-i18n-title','help.delete_floor');x.title=t('help.delete_floor');
      x.addEventListener('click',e=>{
        e.stopPropagation();
        askDeleteFloor(i);
      });
      t.appendChild(x);
    }
    t.addEventListener('click',e=>{
      // Ignore clicks that originated on the delete × or while editing the name
      if(e.target.closest('.ftab-del'))return;
      if(t.classList.contains('editing'))return;
      switchFloor(i);
    });
    t.addEventListener('dblclick',e=>{
      // Also ignore double-clicks on the × (would otherwise open rename)
      if(e.target.closest('.ftab-del'))return;
      e.stopPropagation();
      startFloorRename(name,f);
    });
    c.appendChild(t);
  });
  document.getElementById('fl-cnt').textContent=FLOORS.length;
}
function askDeleteFloor(i){
  if(FLOORS.length<=1){toast('Cannot delete the only floor');return;}
  const f=FLOORS[i];
  const total=(f.APS?.length||0)+(f.DZS?.length||0)+(f.SWS?.length||0);
  const body=total>0
    ? `Delete <strong>${esc(f.name)}</strong>?<br><br>This will remove ${total} item${total===1?'':'s'} on this floor.`
    : `Delete <strong>${esc(f.name)}</strong>?`;
  showModal({i18n:'modal.delete_floor'},body,()=>deleteFloor(i));
}
function deleteFloor(i){
  if(FLOORS.length<=1)return;
  if(i<0||i>=FLOORS.length)return;
  snapshot();
  const removed=FLOORS[i];
  if(removed&&removed.imgId)idbDeleteImage(removed.imgId).catch(()=>{});
  FLOORS.splice(i,1);
  // Adjust curFloor so we stay on a valid index. If we deleted the current
  // floor, move to the one before it (or stay at 0 if it was the first).
  if(curFloor===i)curFloor=Math.max(0,i-1);
  else if(curFloor>i)curFloor--;
  selId=null;selType=null;
  loadFloorImage();renderFloorTabs();render();renderList();renderRP();
  toast('Floor deleted');
}
function startFloorRename(nameEl,floor){
  const tabEl=nameEl.parentElement;
  tabEl.classList.add('editing');
  nameEl.setAttribute('contenteditable','true');
  nameEl.focus();
  // Select all text inside the name span
  const range=document.createRange();range.selectNodeContents(nameEl);
  const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
  const commit=()=>{
    const newName=nameEl.textContent.trim();
    tabEl.classList.remove('editing');
    nameEl.removeAttribute('contenteditable');
    if(newName&&newName!==floor.name){floor.name=newName;renderFloorTabs();}
    else{nameEl.textContent=floor.name;}
  };
  const cancel=()=>{
    tabEl.classList.remove('editing');
    nameEl.removeAttribute('contenteditable');
    nameEl.textContent=floor.name;
  };
  nameEl.addEventListener('blur',commit,{once:true});
  nameEl.addEventListener('keydown',function onKey(e){
    if(e.key==='Enter'){e.preventDefault();nameEl.removeEventListener('keydown',onKey);nameEl.blur();}
    else if(e.key==='Escape'){e.preventDefault();nameEl.removeEventListener('keydown',onKey);nameEl.removeEventListener('blur',commit);cancel();}
  });
}
function switchFloor(i){curFloor=i;selId=null;selType=null;syncScaleFromFloor();loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();}
function addFloor(){
  const defaultName='Floor '+(FLOORS.length+1);
  // New floors inherit the current floor's scale as a sensible default — the
  // user can override per-floor afterwards.
  const inheritedScale=F()?.scaleM||100;
  FLOORS.push({id:'f'+(++nid),name:defaultName,img:'',imgId:'',imgName:'',APS:[],DZS:[],SWS:[],WALLS:[],CAMS:[],ANNOS:[],SAMPLES:[],scaleM:inheritedScale});
  switchFloor(FLOORS.length-1);
  toast('Floor added');
  // Immediately enter rename mode on the new tab so user can pick a real name
  setTimeout(()=>{
    const tabs=document.querySelectorAll('#floor-tabs .ftab');
    const last=tabs[tabs.length-1];
    if(last){
      const name=last.querySelector('.ftab-name');
      if(name)startFloorRename(name,FLOORS[FLOORS.length-1]);
    }
  },50);
}
function updateEmptyState(){
  const es=document.getElementById('empty-state');
  if(!es)return;
  const hasImage=F().img||F().imgId||(mapImg.src&&mapImg.naturalWidth>0);
  es.classList.toggle('hidden',!!hasImage);
}

function loadFloorImage(){
  const f=F();
  // Prefer the IDB-stored image (new path); fall back to the inline `img`
  // data URL so legacy projects loaded into memory (pre-migration) still
  // render correctly during the transition.
  const applySrc=(src,name)=>{
    mapImg.src=src||'';if(mmImg)mmImg.src=src||'';
    document.getElementById('brand-lbl').textContent=src?(SETTINGS.company||'Plexus')+' · '+(name||''):(SETTINGS.company||'Plexus')+' Planner';
    if(src&&mapImg.complete&&mapImg.naturalWidth>0){fitZoom();render();renderMM();updateScaleBar();calcCoverage();}
    updateEmptyState();
  };
  if(f.imgId){
    resolveFloorImage(f).then(src=>applySrc(src,f.imgName)).catch(()=>applySrc('',''));
  }else if(f.img){
    applySrc(f.img,f.imgName);
  }else{
    applySrc('','');
  }
}

// ═══ IMAGE UPLOAD ══════════════════════════════════
// Store an image data-URL as the current floor's plan (IDB-backed, with an
// inline fallback). Shared by image and PDF uploads.
async function _applyMapDataUrl(dataUrl,name,label){
  const oldId=F().imgId;
  const id=_newImgId();
  try{
    await idbPutImage(id,dataUrl);
    _imgCache.set(id,dataUrl);
    F().img='';F().imgId=id;F().imgName=name;
    mapImg.src=dataUrl;if(mmImg)mmImg.src=dataUrl;
    document.getElementById('brand-lbl').textContent=(SETTINGS.company||'Plexus')+' · '+name;
    updateEmptyState();
    toast('Map loaded: '+label);
    if(oldId&&oldId!==id)idbDeleteImage(oldId).catch(()=>{});
  }catch(err){
    // IndexedDB unavailable or quota exceeded — fall back to inline.
    F().img=dataUrl;F().imgName=name;F().imgId='';
    mapImg.src=dataUrl;if(mmImg)mmImg.src=dataUrl;
    document.getElementById('brand-lbl').textContent=(SETTINGS.company||'Plexus')+' · '+name;
    updateEmptyState();
    toast('Map loaded (inline fallback)');
  }
}
// Render the first page of a PDF to a PNG data-URL at a crisp resolution.
let _pdfWorker=null;
async function _pdfFirstPageDataUrl(file){
  if(!_pdfWorker){_pdfWorker=new PdfWorker();pdfjsLib.GlobalWorkerOptions.workerPort=_pdfWorker;}
  const buf=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:buf}).promise;
  const page=await pdf.getPage(1);
  const unit=page.getViewport({scale:1});
  // Aim for ~2× crispness, capped so we don't blow past canvas limits.
  const longSide=Math.max(unit.width,unit.height);
  const scale=Math.min(4,Math.max(1,3000/longSide));
  const viewport=page.getViewport({scale});
  const canvas=document.createElement('canvas');
  canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  const ctx=canvas.getContext('2d');
  // PDFs are transparent — paint white so the plan reads on the dark map area.
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport}).promise;
  return canvas.toDataURL('image/png');
}
function uploadMap(input){
  const file=input.files[0];if(!file)return;
  const name=file.name.replace(/\.[^/.]+$/,'');
  const isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name);
  if(isPdf){
    toast('Rendering PDF…');
    _pdfFirstPageDataUrl(file)
      .then(dataUrl=>_applyMapDataUrl(dataUrl,name,file.name+' (page 1)'))
      .catch(err=>{console.error('PDF import failed',err);toast('Could not read PDF: '+(err&&err.message||err));});
    input.value='';
    return;
  }
  const reader=new FileReader();
  reader.onload=e=>_applyMapDataUrl(e.target.result,name,file.name);
  reader.readAsDataURL(file);input.value='';
}
// onload handled in loadFloorImage()

// ═══ AUTO-AP PLACEMENT ════════════════════════════
// Greedy coverage maximization: pick a sparse grid of candidate positions,
// then iteratively place an AP at whichever candidate covers the most
// currently-uncovered points. Stop when target % is reached or max APs hit.
// Not optimal in the strict NP-hard sense; good enough in practice and
// finishes in well under a second for realistic floor sizes.
function autoPlaceAPs(){
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  if(!w||!h){toast('Upload a map first');return;}
  const model=AP_RANGE_M[SETTINGS.lastModel]?SETTINGS.lastModel:'U6 Pro';
  const r=rangeMToPx(AP_RANGE_M[model]);
  // Build a sample grid (the same one sampleFloorCoverage uses, conceptually).
  const step=Math.max(6,Math.round(Math.min(w,h)/80));
  const samples=[];
  for(let y=0;y<h;y+=step)for(let x=0;x<w;x+=step)samples.push({x,y,covered:false});
  // Mark already-covered points by existing APs so we don't double-count.
  const walls=WALLS();
  const existing=APS();
  for(const ap of existing){
    const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
    const bf=bandLossMultiplier(ap.freq);
    for(const s of samples){
      if(s.covered)continue;
      const d=dbmAt(ap,s.x,s.y,w,h,walls,{bandFactor:bf,arcDeg:pat.arc,headingDeg:ap.heading||0});
      if(d!==null)s.covered=true;
    }
  }
  // Candidate positions: a sparser grid than the sample grid.
  const candStep=Math.max(step*2,Math.round(Math.min(w,h)/30));
  const candidates=[];
  for(let y=candStep/2;y<h;y+=candStep)for(let x=candStep/2;x<w;x+=candStep){
    candidates.push({x,y});
  }
  // We treat a candidate AP as an "omni AP at default range" for placement
  // scoring. Once placed, the user can fine-tune.
  const placedNow=[];
  const TARGET=0.92, MAX_APS=12;
  // Helper: which samples a candidate would cover.
  const candidateCovers=(cx,cy)=>{
    const fakeAp={fx:cx/w,fy:cy/h,r,freq:'2.4 / 5 GHz',pattern:'omni',heading:0};
    const out=[];
    for(let i=0;i<samples.length;i++){
      const s=samples[i];
      if(s.covered)continue;
      // Cheap distance check first; only do dbmAt if within radius.
      if(Math.hypot(s.x-cx,s.y-cy)>r)continue;
      const d=dbmAt(fakeAp,s.x,s.y,w,h,walls,{bandFactor:0.6});
      if(d!==null)out.push(i);
    }
    return out;
  };
  const coveredCount=()=>{let n=0;for(const s of samples)if(s.covered)n++;return n;};
  snapshot();
  while(placedNow.length<MAX_APS && coveredCount()/samples.length<TARGET){
    let bestIdx=-1,bestGain=-1,bestCovers=null;
    for(let i=0;i<candidates.length;i++){
      const c=candidates[i];
      if(c.used)continue;
      const covers=candidateCovers(c.x,c.y);
      if(covers.length>bestGain){bestGain=covers.length;bestIdx=i;bestCovers=covers;}
    }
    if(bestIdx<0||bestGain<=0)break;
    candidates[bestIdx].used=true;
    for(const i of bestCovers)samples[i].covered=true;
    // Place the AP for real.
    const c=candidates[bestIdx];
    const id='ap'+nid++;
    const num=nextNameSuffix(APS(),/^AP-(\d+)/);
    APS().push({id,name:'AP-'+String(num).padStart(2,'0'),model,freq:'2.4 / 5 GHz',channel:'auto',txPower:'auto',sig:'strong',color:'',ip:'',mac:'',swId:'',port:'',vlan:'',notes:'',fx:c.x/w,fy:c.y/h,r,pattern:'omni',heading:0,locked:false});
    placedNow.push(id);
  }
  invalidateCoverageCache();
  render();renderList();renderRP();calcCoverage();
  if(placedNow.length){
    const pct=Math.round(coveredCount()/samples.length*100);
    toast(`Placed ${placedNow.length} ${model} AP${placedNow.length===1?'':'s'} — ${pct}% coverage`);
    // Capacity sanity check vs this floor's switches (ports + PoE budget).
    if(SWS().length){
      let ports=0,portsKnown=true,budget=0;
      for(const sw of SWS()){const p=sw.ports||swPortCount(sw.model);if(p==null)portsKnown=false;else ports+=p;budget+=sw.poeBudget||0;}
      const devCount=APS().length+CAMS().length;
      const draw=APS().reduce((n,a)=>n+(AP_POE_W[a.model]||10),0)+CAMS().reduce((n,c)=>n+((CAM_SPECS[c.model]||{}).poeW||0),0);
      const issues=[];
      if(portsKnown && devCount>ports)issues.push(`${devCount} devices vs ${ports} ports`);
      if(budget>0 && draw>budget)issues.push(`${draw.toFixed(0)} W vs ${budget} W PoE`);
      if(issues.length)toast('⚠ Switch capacity: '+issues.join(' · ')+' — add/upgrade switches');
    }
  }else{
    toast('Already at target coverage — nothing to place');
  }
}

// ═══ POE BUDGET SUMMARY ═══════════════════════════
// ── Switch analysis helpers ───────────────────────────────────────────────
// These back the PoE summary, the validation panel, the topology view and the
// auto-assign tool, so the rules (budget, ports, PoE class, run length) live
// in exactly one place.

// Factor applied to straight-line runs to approximate real (orthogonal,
// tray/riser) cabling. 1 = straight line.
function routingFactor(){const f=parseFloat(SETTINGS.cableRoutingFactor);return Number.isFinite(f)&&f>0?f:1;}
// Real-world cable-run length (m) between a device and its switch on a floor,
// including the routing factor.
function cableRunM(dev,sw,floor){
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  return runLengthM(dev.fx,dev.fy,sw.fx,sw.fy,w,h,((floor||F()).scaleM)||100,routingFactor());
}
// VLAN registry helpers.
function vlanList(){return Array.isArray(SETTINGS.vlans)?SETTINGS.vlans:[];}
function vlanById(id){id=(id==null?'':String(id)).trim();if(!id)return null;return vlanList().find(v=>String(v.id)===id)||null;}
function vlanColor(id){const v=vlanById(id);return v&&v.color?v.color:'';}
// <datalist> of registered VLAN ids for the device VLAN inputs.
function vlanDatalist(){
  if(!vlanList().length)return '';
  return `<datalist id="vlan-list">${vlanList().map(v=>`<option value="${esc(v.id)}">${esc(v.name||'')}</option>`).join('')}</datalist>`;
}
// Find a switch by id across ALL floors (for inter-floor uplinks).
function findSwitchAnywhere(id){
  if(!id)return null;
  for(let i=0;i<FLOORS.length;i++){
    const sw=(FLOORS[i].SWS||[]).find(s=>s.id===id);
    if(sw)return {sw,floor:FLOORS[i],floorIdx:i};
  }
  return null;
}
// Sum every device→switch run across all floors. totalM includes 10% slack per
// run. Pixel→metre conversion uses the current map resolution (as the cable
// schedule export does).
function cableTotals(){
  let runs=0,totalM=0;
  for(const f of FLOORS){
    const sws=f.SWS||[];
    const add=(dev)=>{
      if(!dev.swId)return;
      const sw=sws.find(s=>s.id===dev.swId);if(!sw)return;
      const m=cableRunM(dev,sw,f);
      runs++;totalM+=m+Math.max(1,m*0.1);
    };
    (f.APS||[]).forEach(add);(f.CAMS||[]).forEach(add);
  }
  return {runs,totalM:Math.round(totalM)};
}
// Building-wide switch uplink graph (roots + children), spanning floors.
function topologyModel(){
  const all=[];
  FLOORS.forEach((f,i)=>(f.SWS||[]).forEach(sw=>all.push({sw,floor:f,floorIdx:i})));
  const byId=new Map(all.map(e=>[e.sw.id,e]));
  const children=new Map(all.map(e=>[e.sw.id,[]]));
  const roots=[];
  for(const e of all){
    const up=e.sw.uplinkId;
    if(up && byId.has(up) && up!==e.sw.id)children.get(up).push(e);
    else roots.push(e);
  }
  return {all,byId,children,roots};
}
// A switch's port grid as HTML (filled cells = device on that port number).
function portGridHtml(a,border){
  border=border||'var(--ink-04)';
  if(a.ports==null)return `<div style="font-size:11px;opacity:.7">${a.used} device(s) · port count unknown</div>`;
  const byPort=new Map();
  for(const c of a.clients){const p=parseInt(c.port,10);if(p>=1&&p<=a.ports)byPort.set(p,c);}
  let cells='';
  for(let i=1;i<=a.ports;i++){
    const c=byPort.get(i);
    const bg=c?(c.type==='AP'?'#1565c0':'#6a1b9a'):'transparent';
    cells+=`<div title="${esc(c?`Port ${i}: ${c.name} (${c.model})`:`Port ${i}: free`)}" style="width:17px;height:14px;border:1px solid ${border};border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;font-family:'Share Tech Mono',monospace;background:${bg};color:${c?'#fff':'inherit'}">${i}</div>`;
  }
  const noPort=a.clients.filter(c=>{const p=parseInt(c.port,10);return !(p>=1&&p<=a.ports);});
  const extra=noPort.length?`<div style="font-size:10px;opacity:.6;margin-top:3px">${noPort.length} device(s) without a port #</div>`:'';
  return `<div style="display:flex;flex-wrap:wrap;gap:3px">${cells}</div>${extra}`;
}
// Suggest the next free IP within a device's VLAN subnet (CIDR like
// 192.168.10.0/24). Returns '' if no subnet is known or the range is full.
function nextFreeIp(dev){
  const v=vlanById(dev.vlan);
  const cidr=v&&v.subnet?String(v.subnet).trim():'';
  // Collect IPs already in use across all floors, then defer the subnet math
  // to ./src/network.js (nextFreeIp).
  const used=[];
  for(const f of FLOORS){
    for(const list of [f.APS,f.CAMS,f.SWS])for(const d of (list||[]))if(d.ip)used.push(String(d.ip).trim());
  }
  return netNextFreeIp(cidr,used);
}
// Total estimated client capacity (sum of per-AP capacityClients) across floors.
// ── Airtime estimates ─────────────────────────────────────────────────────
// Average deliverable throughput across an AP's cell, sampled on 12 spokes ×
// 3 radii. Cell-edge samples matter: airtime is shared, so one -80 dBm client
// drags everyone down — a peak-rate figure would hide that.
function apAvgCellMbps(ap,floor){
  const f=floor||F();
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  const walls=f.WALLS||[];
  const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
  const opts={
    bandFactor:bandLossMultiplier(ap.freq),
    arcDeg:pat.arc,headingDeg:ap.heading||0,
    eirpDbm:effectiveEirp(ap),
    noiseFloorDbm:Number.isFinite(SETTINGS.noiseFloorDbm)?SETTINGS.noiseFloorDbm:-95,
    chanWidthMhz:ap.chanWidth||20,
    model:SETTINGS.propagationModel||'logd',
    metersPerPx:((f.scaleM||100)/100),
  };
  let sum=0,n=0;
  for(let i=0;i<12;i++){
    const a=(i/12)*2*Math.PI;
    for(const rr of [0.35,0.65,0.9]){
      const x=ap.fx*w+Math.cos(a)*ap.r*rr, y=ap.fy*h+Math.sin(a)*ap.r*rr;
      if(x<0||y<0||x>w||y>h)continue;
      sum+=mbpsAt(ap,x,y,w,h,walls,opts);n++;
    }
  }
  return n?sum/n:0;
}
// Airtime utilization % for an AP (Infinity when the cell delivers nothing).
function apAirtimePct(ap,floor){
  const u=airtimeUtilization(ap.capacityClients||0,parseFloat(SETTINGS.perClientMbps)||5,apAvgCellMbps(ap,floor));
  return u===Infinity?Infinity:Math.round(u*100);
}
function _airtimeLabel(ap){
  const pct=apAirtimePct(ap);
  if(pct===Infinity)return '∞ (no throughput)';
  const flag=pct>90?' ⚠':'';
  return pct+'%'+flag+` @ ${parseFloat(SETTINGS.perClientMbps)||5} Mbps/client`;
}

function totalClientCapacity(){
  let n=0;
  for(const f of FLOORS)for(const ap of (f.APS||[]))n+=(ap.capacityClients||25);
  return n;
}
// Building-wide network section for the HTML/PDF report: uplink tree, per-switch
// port grids, cabling totals and the VLAN plan. '' when there's nothing to show.
function reportNetworkHtml(){
  const {all,children,roots}=topologyModel();
  if(!all.length && !vlanList().length)return '';
  const multiFloor=FLOORS.length>1;
  let treeHtml='';const seen=new Set();
  const node=(e,depth)=>{
    if(seen.has(e.sw.id))return;seen.add(e.sw.id);
    const a=analyzeSwitch(e.sw,e.floor);
    const portStr=a.ports!=null?`${a.used}/${a.ports}`:`${a.used}`;
    const floorTag=multiFloor?` <span style="color:rgba(0,0,0,.4)">[${esc(e.floor.name||('Floor '+(e.floorIdx+1)))}]</span>`:'';
    treeHtml+=`<div style="padding:2px 0 2px ${depth*20}px">${depth?'└ ':''}⊞ <strong>${esc(e.sw.name)}</strong> <span style="color:rgba(0,0,0,.5)">${esc(e.sw.model||'')}</span>${floorTag} — ${portStr} ports · ${a.draw.toFixed(0)} W</div>`;
    children.get(e.sw.id).forEach(c=>node(c,depth+1));
  };
  roots.forEach(e=>node(e,0));all.forEach(e=>{if(!seen.has(e.sw.id))node(e,0);});
  let rackHtml='';
  for(const e of all){
    const a=analyzeSwitch(e.sw,e.floor);
    rackHtml+=`<div style="margin-bottom:10px;padding:8px 10px;border:1px solid rgba(0,0,0,.18);border-radius:3px">
      <div style="display:flex;justify-content:space-between;margin-bottom:5px"><span><strong>${esc(e.sw.name)}</strong> <span style="color:rgba(0,0,0,.5)">${esc(e.sw.model||'')}</span></span><span style="font-family:'Share Tech Mono',monospace">${a.ports!=null?`${a.used}/${a.ports}`:`${a.used}/?`}${a.overPorts?' ⚠':''}</span></div>
      ${portGridHtml(a,'rgba(0,0,0,.18)')}</div>`;
  }
  const cable=cableTotals();
  const boxM=parseFloat(SETTINGS.cableBoxM)||305;
  const cableHtml=cable.runs?`<p style="margin-top:8px">Cabling: <strong>${cable.runs}</strong> runs · <strong>~${cable.totalM} m</strong> incl. slack (×${routingFactor()} routing) · <strong>~${Math.ceil(cable.totalM/boxM)}</strong> box(es) of ${boxM} m.</p>`:'';
  const vlanHtml=vlanList().length?`<h3>VLAN Plan</h3><table><thead><tr><th>ID</th><th>Name</th><th>Subnet</th></tr></thead><tbody>${vlanList().map(v=>`<tr><td>${esc(v.id)}</td><td>${esc(v.name||'')}</td><td>${esc(v.subnet||'—')}</td></tr>`).join('')}</tbody></table>`:'';
  if(!all.length)return `<section class="floor-sec page-break"><h2>Network</h2>${vlanHtml}</section>`;
  return `<section class="floor-sec page-break"><h2>Network Topology</h2>
    <h3>Uplink Tree</h3><div style="font-family:'Rajdhani',sans-serif;font-size:13px">${treeHtml}</div>
    ${cableHtml}
    <h3>Rack — Port Usage</h3>${rackHtml}
    ${vlanHtml}</section>`;
}
// APs + cameras assigned to a switch, each with PoE draw and required class.
function switchClients(sw,floor){
  const f=floor||F();
  const out=[];
  (f.APS||[]).forEach(ap=>{if(ap.swId===sw.id){const w=AP_POE_W[ap.model]||10;out.push({dev:ap,type:'AP',name:ap.name,model:ap.model,w,cls:poeClassForWatts(w),port:ap.port,ip:ap.ip});}});
  (f.CAMS||[]).forEach(c=>{if(c.swId===sw.id){const w=(CAM_SPECS[c.model]||{}).poeW||0;out.push({dev:c,type:'CAM',name:c.name,model:c.model,w,cls:poeClassForWatts(w),port:c.port,ip:c.ip});}});
  return out;
}
// Full PoE / port / class picture for one switch.
function analyzeSwitch(sw,floor){
  const clients=switchClients(sw,floor||F());
  const budget=sw.poeBudget||0;
  const ports=sw.ports||swPortCount(sw.model);   // null = unknown → skip check
  const swCls=swPoeClass(sw.model,budget);
  // Pure PoE/port/class verdict lives in ./src/network.js (analyzeLoad).
  return {sw,clients,budget,ports,swCls,...analyzeLoad(clients,{budget,ports,swCls})};
}
// <option>s for a numbered port picker. Preserves a legacy/custom value (e.g.
// "SW1 Port 4") that isn't a plain 1..N so old projects don't lose data.
function portOptions(ports,cur){
  cur=(cur==null?'':String(cur)).trim();
  const curNum=/^\d+$/.test(cur)?parseInt(cur,10):null;
  let html=`<option value=""${cur===''?' selected':''}>— unassigned —</option>`;
  if(cur!=='' && (curNum===null || (ports!=null && (curNum<1||curNum>ports))))
    html+=`<option value="${esc(cur)}" selected>${esc(cur)} (custom)</option>`;
  if(ports!=null)for(let i=1;i<=ports;i++)
    html+=`<option value="${i}"${curNum===i?' selected':''}>Port ${i}</option>`;
  return html;
}
// A port picker: numbered <select> when the switch's port count is known, else
// a free number input. `attrs` are extra attributes (id / data-* the caller needs).
function portControl(ports,cur,attrs){
  cur=cur==null?'':String(cur);
  return ports!=null
    ? `<select class="ep-sel" ${attrs}>${portOptions(ports,cur)}</select>`
    : `<input class="ep-in" type="number" min="1" value="${esc(cur)}" placeholder="Port #" ${attrs}/>`;
}
// <option>s for the install-status picker.
function statusOptions(cur){
  cur=DEVICE_STATUSES.includes(cur)?cur:'planned';
  return DEVICE_STATUSES.map(s=>`<option value="${s}"${s===cur?' selected':''}>${DEVICE_STATUS_META[s].label}</option>`).join('');
}
// Shared "Status & Inventory" panel section. `p` is the element-id prefix
// (ep / cam / sw) and `act` the panel's data-input-action.
function inventoryBlock(dev,p,act){
  return `<div class="ep-section">Status &amp; Inventory</div>
    <div class="ep-row"><label class="ep-lbl">Status</label><select class="ep-sel" id="${p}-status" data-input-action="${act}">${statusOptions(dev.status)}</select></div>
    <div class="ep-row"><label class="ep-lbl">Serial #</label><input class="ep-in ep-mono" id="${p}-serial" value="${esc(dev.serial||'')}" data-input-action="${act}" placeholder="from the unit label"/></div>
    <div class="ep-row"><label class="ep-lbl">Asset Tag</label><input class="ep-in ep-mono" id="${p}-asset" value="${esc(dev.assetTag||'')}" data-input-action="${act}" placeholder="ASSET-0001"/></div>
    <div class="ep-row"><label class="ep-lbl">Firmware</label><input class="ep-in ep-mono" id="${p}-firmware" value="${esc(dev.firmware||'')}" data-input-action="${act}" placeholder="e.g. 6.5.28"/></div>`;
}
// Read the shared section back into the device. Safe when the section isn't
// in the current panel (elements missing → no-op).
function readInventoryBlock(dev,p){
  const g=id=>document.getElementById(`${p}-${id}`);
  const st=g('status');if(st)dev.status=st.value;
  const se=g('serial');if(se)dev.serial=se.value;
  const as=g('asset');if(as)dev.assetTag=as.value;
  const fw=g('firmware');if(fw)dev.firmware=fw.value;
}
// Resolved port count for the switch a device is attached to (null = no switch
// or unknown count).
function devSwitchPorts(dev){
  const sw=SWS().find(s=>s.id===dev.swId);
  return sw?(sw.ports||swPortCount(sw.model)):null;
}
// Fill a device's IP with the next free address in its VLAN subnet.
function suggestIp(type){
  const list=type==='cam'?CAMS():APS();
  const d=list.find(x=>x.id===selId);if(!d)return;
  if(!vlanById(d.vlan)){toast('Set this device’s VLAN first (see Settings → VLANs)');return;}
  const ip=nextFreeIp(d);
  if(!ip){toast('No subnet on that VLAN, or its range is full');return;}
  snapshot();d.ip=ip;
  render();renderList();
  if(type==='cam')renderCAMPanel();else renderAPPanel();
}
// Edit a device's port from the switch-side port map.
function updSwPort(el){
  const list=el.dataset.devType==='cam'?CAMS():APS();
  const d=list.find(x=>x.id===el.dataset.devId);if(!d)return;
  snapshotSoon();
  d.port=el.value;
  render();
}

// ── Organization helpers ──────────────────────────────────────────────────
// Every networked device in the building, flattened with its floor context.
// Type tags match the naming convention's {type} token.
function allDevices(){
  const out=[];
  FLOORS.forEach((f,floorIdx)=>{
    (f.APS||[]).forEach(dev=>out.push({dev,type:'AP',floor:f,floorIdx}));
    (f.CAMS||[]).forEach(dev=>out.push({dev,type:'CAM',floor:f,floorIdx}));
    (f.SWS||[]).forEach(dev=>out.push({dev,type:'SW',floor:f,floorIdx}));
  });
  return out;
}
function statusMeta(dev){return DEVICE_STATUS_META[dev.status]||DEVICE_STATUS_META.planned;}
function statusDimmed(dev){return !!statusFilter&&(dev.status||'planned')!==statusFilter;}
function deviceStatusCounts(){
  const counts=Object.fromEntries(DEVICE_STATUSES.map(s=>[s,0]));
  for(const {dev} of allDevices())counts[dev.status||'planned']++;
  return counts;
}
function namingCtx(type,floorIdx){
  return {site:(SETTINGS.siteCode||'').trim(),floor:floorIdx+1,type};
}
// Fill every empty IP across the building from each device's VLAN subnet.
function autoAssignIps(){
  const used=new Set();
  for(const {dev} of allDevices())if(dev.ip)used.add(String(dev.ip).trim());
  const todo=allDevices().filter(({dev})=>{
    if((dev.ip||'').trim())return false;
    const v=vlanById(dev.vlan);
    return !!(v&&v.subnet);
  });
  if(!todo.length){toast('No devices with a subnet-backed VLAN are missing an IP');return;}
  snapshot();
  let n=0;
  for(const {dev} of todo){
    const v=vlanById(dev.vlan);
    const ip=netNextFreeIp(v.subnet,used);
    if(!ip)continue;
    dev.ip=ip;used.add(ip);n++;
  }
  render();renderList();renderRP();
  toast(n?`Assigned ${n} IP address${n===1?'':'es'}`:'No free addresses left in the VLAN subnets');
}
// Rename every AP/camera/switch to the convention in SETTINGS.namePattern,
// numbering devices per floor and type in list order.
function autoRenameDevices(){
  const pattern=(SETTINGS.namePattern||'').trim();
  if(!patternHasNumber(pattern)){toast('Set a name pattern with a number token first (Settings → Organization)');return;}
  snapshot();
  let n=0;
  FLOORS.forEach((f,floorIdx)=>{
    for(const [list,type] of [[f.APS,'AP'],[f.CAMS,'CAM'],[f.SWS,'SW']]){
      (list||[]).forEach((dev,i)=>{
        const name=formatName(pattern,{...namingCtx(type,floorIdx),n:i+1});
        if(dev.name!==name){dev.name=name;n++;}
      });
    }
  });
  render();renderList();renderRP();
  toast(n?`Renamed ${n} device${n===1?'':'s'}`:'All names already follow the pattern');
}

// Walk every switch on the current floor, summarise PoE draw vs budget, port
// usage and PoE-class fit. Footer offers auto-assign and full validation.
function showPoESummary(){
  const wrap=document.createElement('div');
  wrap.style.cssText='font-family:Rajdhani,sans-serif;font-size:13px';
  const sws=SWS();
  if(!sws.length){
    localizeText(wrap,'poe.empty_help');
    showModalNode({i18n:'poe.title'},wrap,null);
    return;
  }
  let totalDraw=0,totalBudget=0;
  for(const sw of sws){
    const a=analyzeSwitch(sw);
    totalDraw+=a.draw;totalBudget+=a.budget;
    const sec=document.createElement('div');sec.style.cssText='margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(0,0,0,.08)';
    const head=document.createElement('div');head.style.cssText='display:flex;justify-content:space-between;font-weight:600;margin-bottom:4px';
    const portStr=a.ports!=null?` · ${a.used}/${a.ports} ports`:` · ${a.used} ports`;
    head.innerHTML=`<span>${esc(sw.name)} <span style="font-family:'Share Tech Mono';font-size:10px;opacity:.6">${esc(sw.model||'')}${esc(portStr)}</span></span>
      <span style="font-family:'Share Tech Mono';color:${a.overBudget?'#c0382b':'#1e7d3c'}">${a.draw.toFixed(1)} W${a.budget>0?` / ${a.budget} W${a.headroom!=null?` · ${a.headroom}%`:''}`:''}</span>`;
    sec.appendChild(head);
    if(!a.clients.length){
      const empty=document.createElement('div');empty.style.cssText='font-size:11px;opacity:.6;font-style:italic';localizeText(empty,'poe.unassigned');
      sec.appendChild(empty);
    }else{
      for(const c of a.clients){
        const bad=a.classFails.includes(c);
        const li=document.createElement('div');li.style.cssText='display:flex;justify-content:space-between;font-size:11px;padding:2px 8px;opacity:.85';
        li.innerHTML=`<span>${c.type==='AP'?'●':'◉'} ${esc(c.name)} <span style="opacity:.5">${esc(c.model)}</span></span><span style="font-family:'Share Tech Mono'${bad?';color:#c0382b;font-weight:700':''}">${c.w} W${c.cls?` ${c.cls}`:''}</span>`;
        sec.appendChild(li);
      }
    }
    const warn=(txt)=>{const d=document.createElement('div');d.style.cssText='font-size:11px;color:#c0382b;margin-top:4px;font-weight:600';d.textContent=txt;sec.appendChild(d);};
    if(a.overBudget)warn('⚠ Draw exceeds budget — switch may shut down PoE on lower-priority ports.');
    if(a.overPorts)warn(`⚠ ${a.used} devices on a ${a.ports}-port switch — over capacity.`);
    if(a.classFails.length)warn(`⚠ ${a.classFails.length} device(s) need ${a.classFails.map(c=>c.cls).sort().pop()} PoE; switch delivers ${a.swCls||'none'}.`);
    wrap.appendChild(sec);
  }
  const total=document.createElement('div');total.style.cssText='margin-top:8px;padding-top:8px;border-top:1px solid #000;font-weight:600;display:flex;justify-content:space-between';
  total.innerHTML=`<span>Total</span><span style="font-family:'Share Tech Mono'">${totalDraw.toFixed(1)} W${totalBudget>0?` / ${totalBudget} W`:''}</span>`;
  wrap.appendChild(total);
  const foot=document.createElement('div');foot.style.cssText='margin-top:12px;display:flex;gap:8px;flex-wrap:wrap';
  const mkBtn=(label,fn)=>{const b=document.createElement('button');b.className='btn';localizeText(b,label);b.addEventListener('click',fn);foot.appendChild(b);};
  mkBtn('poe.auto_assign',()=>{closeModal();autoAssignSwitches();});
  mkBtn('poe.validate',()=>{closeModal();showValidation();});
  wrap.appendChild(foot);
  const hint=document.createElement('div');hint.style.cssText='margin-top:10px;font-size:10px;opacity:.55';
  localizeText(hint,'poe.hint');
  wrap.appendChild(hint);
  showModalNode({i18n:'poe.title'},wrap,null);
}

// ── Auto-assign devices to nearest switch ─────────────────────────────────
// For each AP/camera, pick the closest switch (by cable geometry) that still
// has PoE-budget and port headroom. Devices already assigned keep their switch
// unless that link is now invalid. Budget/ports are tracked live so the result
// is internally consistent.
function autoAssignSwitches(){
  const sws=SWS();
  if(!sws.length){toast('Place a switch first (W)');return;}
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  // Running tallies per switch so we don't oversubscribe as we assign.
  const state=new Map(sws.map(sw=>{
    const a=analyzeSwitch(sw);
    return [sw.id,{sw,draw:0,used:0,budget:a.budget,ports:a.ports,swCls:a.swCls}];
  }));
  const devices=[...APS().map(d=>({d,type:'AP',w:AP_POE_W[d.model]||10})),
                 ...CAMS().map(d=>({d,type:'CAM',w:(CAM_SPECS[d.model]||{}).poeW||0}))];
  snapshot();   // capture pre-assignment state so Undo reverts the whole pass
  let assigned=0;
  for(const {d,w:watt} of devices){
    const need=poeClassForWatts(watt);
    let best=null,bestDist=Infinity;
    for(const st of state.values()){
      // Capacity guards — skip switches that can't take this device.
      if(st.ports!=null && st.used>=st.ports)continue;
      if(st.budget>0 && st.draw+watt>st.budget)continue;
      if(need && st.swCls && POE_CLASS_RANK[need]>POE_CLASS_RANK[st.swCls])continue;
      const dx=(d.fx-st.sw.fx)*w, dy=(d.fy-st.sw.fy)*h;
      const dist=Math.hypot(dx,dy);
      if(dist<bestDist){bestDist=dist;best=st;}
    }
    // Fall back to the geometrically nearest switch if none had headroom, so a
    // device is never left unassigned (the validation panel flags the overload).
    if(!best){
      for(const st of state.values()){
        const dx=(d.fx-st.sw.fx)*w, dy=(d.fy-st.sw.fy)*h;
        const dist=Math.hypot(dx,dy);
        if(dist<bestDist){bestDist=dist;best=st;}
      }
    }
    if(best){if(d.swId!==best.sw.id)assigned++;d.swId=best.sw.id;best.used++;best.draw+=watt;}
  }
  render();renderList();renderRP();
  showCables=true;document.getElementById('btn-cables')?.classList.add('active');render();
  toast(assigned?`Assigned ${assigned} device(s) to nearest switch`:'All devices already on nearest switch');
}

// ── Network validation ────────────────────────────────────────────────────
// One pass over the current floor surfacing wiring/PoE problems before
// handoff, grouped by severity. Cable-length checks need a placed map (scale).
function showValidation(){
  const f=F();
  const errors=[],warns=[],infos=[];
  const sws=SWS();
  for(const sw of sws){
    const a=analyzeSwitch(sw,f);
    if(a.overBudget)errors.push(`${sw.name}: PoE draw ${a.draw.toFixed(0)} W exceeds ${a.budget} W budget.`);
    else if(a.budget>0 && a.headroom!=null && a.headroom<10 && a.draw>0)warns.push(`${sw.name}: only ${a.headroom}% PoE headroom left.`);
    if(a.overPorts)errors.push(`${sw.name}: ${a.used} devices on ${a.ports} ports — over capacity.`);
    for(const c of a.classFails)errors.push(`${c.name} needs ${c.cls} PoE but ${sw.name} delivers ${a.swCls||'none'}.`);
    if(!a.swCls && a.clients.some(c=>c.w>0))warns.push(`${sw.name} has PoE devices but no PoE budget set.`);
    // Duplicate port labels on the same switch.
    const seen=new Map();
    for(const c of a.clients){
      const p=(c.port||'').trim().toLowerCase();
      if(!p)continue;
      if(seen.has(p))warns.push(`${sw.name}: port "${c.port}" used by both ${seen.get(p)} and ${c.name}.`);
      else seen.set(p,c.name);
    }
  }
  // Cable-run length (real scale → needs a map).
  const hasMap=!!(mapImg.naturalWidth&&mapImg.naturalHeight);
  const checkRun=(dev,label)=>{
    if(!dev.swId)return;
    const sw=sws.find(s=>s.id===dev.swId);if(!sw)return;
    const m=cableRunM(dev,sw,f);
    if(m>100)errors.push(`${label}: cable run to ${sw.name} is ${m.toFixed(0)} m (>100 m Ethernet limit).`);
    else if(m>90)warns.push(`${label}: cable run to ${sw.name} is ${m.toFixed(0)} m (near 100 m limit).`);
  };
  if(hasMap){APS().forEach(ap=>checkRun(ap,ap.name));CAMS().forEach(c=>checkRun(c,c.name));}
  // Unassigned devices (informational).
  APS().forEach(ap=>{if(!ap.swId)infos.push(`${ap.name} is not assigned to a switch.`);});
  CAMS().forEach(c=>{if(!c.swId)infos.push(`${c.name} is not assigned to a switch.`);});
  // Duplicate IPs across all floor devices + switches.
  const ipMap=new Map();
  const noteIp=(ip,name)=>{const k=(ip||'').trim();if(!k)return;if(ipMap.has(k))warns.push(`Duplicate IP ${k}: ${ipMap.get(k)} and ${name}.`);else ipMap.set(k,name);};
  APS().forEach(ap=>noteIp(ap.ip,ap.name));
  CAMS().forEach(c=>noteIp(c.ip,c.name));
  sws.forEach(sw=>noteIp(sw.ip,sw.name));
  // VLANs referenced but not in the registry (only when a registry exists).
  if(vlanList().length){
    const checkVlan=(dev,label)=>{const v=(dev.vlan||'').trim();if(v&&!vlanById(v))warns.push(`${label}: VLAN "${v}" is not in the VLAN registry.`);};
    APS().forEach(ap=>checkVlan(ap,ap.name));
    CAMS().forEach(c=>checkVlan(c,c.name));
  }
  // IPs that sit outside their VLAN's declared subnet (floor devices).
  const checkIpSubnet=(dev,label)=>{
    const v=vlanById(dev.vlan);
    const ip=(dev.ip||'').trim();
    if(!ip||!v||!v.subnet)return;
    if(!ipInCidr(ip,v.subnet))warns.push(`${label}: IP ${ip} is outside VLAN ${v.id} subnet ${v.subnet}.`);
  };
  APS().forEach(ap=>checkIpSubnet(ap,ap.name));
  CAMS().forEach(c=>checkIpSubnet(c,c.name));
  // Subnet pool exhaustion (building-wide — IPs are global).
  if(vlanList().length){
    const allIps=[];
    for(const fl of FLOORS)for(const list of [fl.APS,fl.CAMS,fl.SWS])for(const d of (list||[]))if(d.ip)allIps.push(d.ip);
    for(const v of vlanList()){
      if(!v.subnet)continue;
      const u=subnetUsage(v.subnet,allIps);
      if(!u)continue;
      if(u.pct>=100)errors.push(`VLAN ${v.id} subnet ${v.subnet} is full (${u.used}/${u.capacity} hosts).`);
      else if(u.pct>=90)warns.push(`VLAN ${v.id} subnet ${v.subnet} is ${u.pct}% full (${u.used}/${u.capacity} hosts).`);
    }
  }
  // Naming convention (when one is configured in Settings → Organization).
  if(patternHasNumber(SETTINGS.namePattern)){
    const offenders=[];
    for(const [list,type] of [[APS(),'AP'],[CAMS(),'CAM'],[SWS(),'SW']]){
      for(const dev of list)
        if(!nameMatches(dev.name,SETTINGS.namePattern,namingCtx(type,curFloor)))offenders.push(dev.name||dev.id);
    }
    if(offenders.length){
      const shown=offenders.slice(0,3).join(', ');
      warns.push(`${offenders.length} device name${offenders.length===1?'':'s'} break the "${SETTINGS.namePattern}" convention (${shown}${offenders.length>3?', …':''}) — Inventory → Auto-rename fixes them.`);
    }
  }
  // Per-AP airtime utilization (this floor). Demand = clients × per-client
  // Mbps vs what the cell actually delivers on average.
  if(hasMap){
    for(const ap of APS()){
      if(!(ap.capacityClients>0))continue;
      const pct=apAirtimePct(ap,f);
      if(pct===Infinity)errors.push(`${ap.name}: expected ${ap.capacityClients} clients but the cell delivers no usable throughput.`);
      else if(pct>100)errors.push(`${ap.name}: airtime ~${pct}% — ${ap.capacityClients} clients × ${parseFloat(SETTINGS.perClientMbps)||5} Mbps exceeds what this cell can carry.`);
      else if(pct>80)warns.push(`${ap.name}: airtime ~${pct}% — near saturation; consider a wider channel or another AP.`);
    }
  }
  // Client-capacity rollup (building-wide; only when an expectation is set).
  const expected=parseInt(SETTINGS.expectedClients,10)||0;
  if(expected>0){
    const cap=totalClientCapacity();
    if(cap<expected)warns.push(`Client capacity ${cap} < expected ${expected} — consider more/denser APs.`);
    else infos.push(`Client capacity ${cap} ≥ expected ${expected}.`);
  }
  // Camera storage rollup (building-wide).
  const storGb=totalStorageGb();
  if(storGb>0){
    const days=parseInt(SETTINGS.retentionDays,10)||30;
    infos.push(`Camera recording needs ~${storGb>=1000?(storGb/1000).toFixed(2)+' TB':Math.round(storGb)+' GB'} of NVR storage for ${days}-day retention (${SETTINGS.storageCodec==='h264'?'H.264':'H.265'}).`);
  }

  const wrap=document.createElement('div');
  wrap.style.cssText='font-family:Rajdhani,sans-serif;font-size:13px';
  // The ✓ banner keys off problems only — informational lines (e.g. the NVR
  // storage rollup) still print below a passing result.
  if(!errors.length&&!warns.length){
    const ok=document.createElement('div');ok.style.cssText='color:#1e7d3c;font-weight:700;font-size:15px;padding:6px 0';
    ok.textContent='✓ All checks passed.';wrap.appendChild(ok);
  }
  {
    const group=(title,items,color,icon)=>{
      if(!items.length)return;
      const h=document.createElement('div');h.style.cssText=`font-weight:700;margin:10px 0 4px;color:${color}`;h.textContent=`${icon} ${title} (${items.length})`;wrap.appendChild(h);
      for(const it of items){const d=document.createElement('div');d.style.cssText='font-size:12px;padding:2px 0 2px 16px';d.textContent=it;wrap.appendChild(d);}
    };
    group('Errors',errors,'#c0382b','✕');
    group('Warnings',warns,'#b8860b','⚠');
    group('Info',infos,'#555','ℹ');
  }
  if(!hasMap){const n=document.createElement('div');n.style.cssText='margin-top:10px;font-size:10px;opacity:.55';n.textContent='Cable-length checks skipped — no floor plan on this floor.';wrap.appendChild(n);}
  const scope=document.createElement('div');scope.style.cssText='margin-top:8px;font-size:10px;opacity:.55';scope.textContent=`Checked floor "${f.name||''}".`;wrap.appendChild(scope);
  showModalNode({i18n:'modal.validation'},wrap,null);
}

// ── Topology / rack view ──────────────────────────────────────────────────
// The switch uplink tree (roots/gateways on top) plus a compact rack list
// showing each switch's port usage. Read-only documentation aid.
function showTopology(){
  const wrap=document.createElement('div');
  wrap.style.cssText='font-family:Rajdhani,sans-serif;font-size:13px';
  const {all,children,roots}=topologyModel();
  if(!all.length){localizeText(wrap,'poe.no_switches');showModalNode({i18n:'modal.topology'},wrap,null);return;}
  const multiFloor=FLOORS.length>1;
  const th=document.createElement('div');th.style.cssText='font-weight:700;margin-bottom:4px';localizeText(th,'topology.tree');wrap.appendChild(th);
  const tree=document.createElement('div');wrap.appendChild(tree);
  const seen=new Set();
  const renderNode=(e,depth)=>{
    if(seen.has(e.sw.id))return;            // guard against accidental cycles
    seen.add(e.sw.id);
    const a=analyzeSwitch(e.sw,e.floor);
    const row=document.createElement('div');
    row.style.cssText=`padding:3px 0 3px ${depth*18}px;display:flex;justify-content:space-between;gap:10px`;
    const portStr=a.ports!=null?`${a.used}/${a.ports}`:`${a.used}`;
    const floorTag=multiFloor?` <span style="opacity:.45;font-size:9px">[${esc(e.floor.name||('Floor '+(e.floorIdx+1)))}]</span>`:'';
    row.innerHTML=`<span>${depth?'└ ':''}⊞ <strong>${esc(e.sw.name)}</strong> <span style="opacity:.55;font-family:'Share Tech Mono';font-size:10px">${esc(e.sw.model||'')}</span>${floorTag}</span>
      <span style="font-family:'Share Tech Mono';font-size:10px;opacity:.7">${portStr} ports · ${a.draw.toFixed(0)} W</span>`;
    tree.appendChild(row);
    children.get(e.sw.id).forEach(c=>renderNode(c,depth+1));
  };
  roots.forEach(e=>renderNode(e,0));
  all.forEach(e=>{if(!seen.has(e.sw.id))renderNode(e,0);});  // safety net
  // Rack / port grid per switch.
  const rh=document.createElement('div');rh.style.cssText='font-weight:700;margin:14px 0 6px';localizeText(rh,'topology.rack');wrap.appendChild(rh);
  for(const e of all){
    const a=analyzeSwitch(e.sw,e.floor);
    const unit=document.createElement('div');unit.style.cssText='margin-bottom:8px;padding:6px 8px;border:1px solid var(--ink-04);border-radius:3px';
    unit.innerHTML=`<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span><strong>${esc(e.sw.name)}</strong> <span style="opacity:.55;font-size:10px">${esc(e.sw.model||'')}</span></span><span style="font-family:'Share Tech Mono';opacity:.7">${a.ports!=null?`${a.used}/${a.ports}`:`${a.used}/?`}${a.overPorts?' ⚠':''}</span></div>${portGridHtml(a)}`;
    wrap.appendChild(unit);
  }
  // Cabling rollup.
  const cable=cableTotals();
  if(cable.runs>0){
    const boxM=parseFloat(SETTINGS.cableBoxM)||305;
    const cl=document.createElement('div');cl.style.cssText='margin-top:12px;padding-top:8px;border-top:1px solid var(--ink-04);font-size:11px;opacity:.8';
    cl.textContent=`Cabling: ${cable.runs} runs · ~${cable.totalM} m incl. slack (×${routingFactor()} routing) · ~${Math.ceil(cable.totalM/boxM)} box(es)`;
    wrap.appendChild(cl);
  }
  showModalNode({i18n:'modal.topology'},wrap,null);
}

// ═══ SHARE LINK ═══════════════════════════════════
// Encode the current project into the URL hash, compressed with gzip when
// the browser supports CompressionStream, then base64url-encoded so it's
// safe to drop in a chat message. Floor-plan images are intentionally
// stripped — they'd inflate the URL well past every browser's address-bar
// length limit. Recipients see the project structure and re-upload the map
// themselves.
async function _b64urlFromBytes(bytes){
  let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function _bytesFromB64url(s){
  s=s.replace(/-/g,'+').replace(/_/g,'/');
  while(s.length%4)s+='=';
  const bin=atob(s);
  const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
}
async function _gzip(text){
  if(typeof CompressionStream==='undefined'){
    // Plain text path — bigger URL but functional.
    return new TextEncoder().encode(text);
  }
  const cs=new CompressionStream('gzip');
  const writer=cs.writable.getWriter();
  writer.write(new TextEncoder().encode(text));writer.close();
  const reader=cs.readable.getReader();
  const chunks=[];let len=0;
  while(true){
    const {value,done}=await reader.read();
    if(done)break;
    chunks.push(value);len+=value.length;
  }
  const out=new Uint8Array(len);let p=0;
  for(const c of chunks){out.set(c,p);p+=c.length;}
  return out;
}
async function _gunzip(bytes){
  if(typeof DecompressionStream==='undefined'){
    return new TextDecoder().decode(bytes);
  }
  const ds=new DecompressionStream('gzip');
  const writer=ds.writable.getWriter();writer.write(bytes);writer.close();
  const reader=ds.readable.getReader();
  const chunks=[];let len=0;
  while(true){
    const {value,done}=await reader.read();
    if(done)break;
    chunks.push(value);len+=value.length;
  }
  const out=new Uint8Array(len);let p=0;
  for(const c of chunks){out.set(c,p);p+=c.length;}
  return new TextDecoder().decode(out);
}
async function shareLink(){
  try{
    // Strip floor-plan images (size) and device credentials (privacy) so the
    // shareable URL never carries logins.
    const stripCreds=arr=>(arr||[]).map(d=>{if(!d.creds)return d;const o={...d};delete o.creds;return o;});
    const floorsForLink=FLOORS.map(f=>{
      const o={...f};delete o.img;delete o.imgId;
      o.APS=stripCreds(f.APS);o.CAMS=stripCreds(f.CAMS);o.SWS=stripCreds(f.SWS);
      return o;
    });
    const data={version:PROJECT_VERSION,settings:SETTINGS,floors:floorsForLink};
    const json=JSON.stringify(data,_stripCacheReplacer);
    const bytes=await _gzip(json);
    const b64=await _b64urlFromBytes(bytes);
    const url=`${location.origin}${location.pathname}#p=${b64}`;
    if(url.length>8000){
      toast('Project too large for a URL — use 💾 Save instead');
      return;
    }
    try{
      await navigator.clipboard.writeText(url);
      toast('Share link copied to clipboard (no floor-plan image)');
    }catch{
      // Clipboard blocked (insecure context, perms). Show the URL in a modal.
      const wrap=document.createElement('div');
      const p=document.createElement('p');localizeText(p,'share.copy');
      const ta=document.createElement('textarea');
      ta.value=url;ta.rows=4;ta.style.cssText='width:100%;font-family:monospace;font-size:11px';
      ta.addEventListener('focus',()=>ta.select());
      wrap.appendChild(p);wrap.appendChild(ta);
      showModalNode({i18n:'modal.share'},wrap,null);
      setTimeout(()=>ta.select(),50);
    }
  }catch(err){
    toast('Share failed: '+(err.message||'unknown error'));
  }
}
async function tryLoadFromHash(){
  const m=/^#p=(.+)$/.exec(location.hash||'');
  if(!m)return false;
  try{
    const bytes=_bytesFromB64url(m[1]);
    const json=await _gunzip(bytes);
    const raw=JSON.parse(json);
    const [data,warnings]=migrateProject(raw);
    FLOORS=data.floors;
    SETTINGS={...DEFAULT_SETTINGS,...(data.settings||{})};
    applyStoredCatalog();
    curFloor=0;selId=null;selType=null;
    syncScaleFromFloor();syncNidFromFloors();
    await _rehydrateImages();
    applySettingsToBrand();
    loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
    // Strip the hash so a reload doesn't keep loading the same project.
    history.replaceState(null,'',location.pathname+location.search);
    toast(warnings.length?warnings[0]:'Project loaded from link');
    return true;
  }catch(err){
    toast('Could not decode shared link');
    return false;
  }
}

// ═══ SVG WALL IMPORT ══════════════════════════════
// Architects ship floor plans as SVG more often than not — parsing the line
// primitives directly saves users an enormous amount of manual click-clicking.
// We accept <line>, <polyline>, <polygon>, and the line-like subset of <path>.
function importSvgWalls(input){
  const file=input.files[0];if(!file)return;
  if(!mapImg.naturalWidth){toast('Upload a floor-plan image first so we know the scale');input.value='';return;}
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const text=e.target.result;
      const doc=new DOMParser().parseFromString(text,'image/svg+xml');
      const svg=doc.querySelector('svg');
      if(!svg)throw new Error('No <svg> root found');
      // Determine the SVG's intrinsic coordinate system.
      const vb=(svg.getAttribute('viewBox')||'').trim().split(/\s+|,/).map(parseFloat);
      let vbX=0,vbY=0,vbW,vbH;
      if(vb.length===4&&vb.every(Number.isFinite)){[vbX,vbY,vbW,vbH]=vb;}
      else{
        vbW=parseFloat(svg.getAttribute('width'))||100;
        vbH=parseFloat(svg.getAttribute('height'))||100;
      }
      const segs=[];
      const pushSeg=(x1,y1,x2,y2)=>{
        if(!Number.isFinite(x1)||!Number.isFinite(y1)||!Number.isFinite(x2)||!Number.isFinite(y2))return;
        if(Math.hypot(x2-x1,y2-y1)<1)return;
        segs.push([x1,y1,x2,y2]);
      };
      doc.querySelectorAll('line').forEach(el=>{
        pushSeg(+el.getAttribute('x1')||0,+el.getAttribute('y1')||0,+el.getAttribute('x2')||0,+el.getAttribute('y2')||0);
      });
      const splitPts=s=>(s||'').trim().split(/\s+|,/).filter(Boolean).map(parseFloat);
      doc.querySelectorAll('polyline,polygon').forEach(el=>{
        const pts=splitPts(el.getAttribute('points'));
        const closed=el.tagName.toLowerCase()==='polygon';
        for(let i=0;i+3<pts.length;i+=2){
          pushSeg(pts[i],pts[i+1],pts[i+2],pts[i+3]);
        }
        if(closed&&pts.length>=4){
          pushSeg(pts[pts.length-2],pts[pts.length-1],pts[0],pts[1]);
        }
      });
      // Very lightweight path parser — only honours M/L/H/V/Z (absolute & relative).
      // Curves and arcs are skipped (we'd need full bezier sampling otherwise).
      doc.querySelectorAll('path').forEach(el=>{
        const d=el.getAttribute('d')||'';
        const tokens=d.match(/[MmLlHhVvZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g)||[];
        let i=0,cx=0,cy=0,sx=0,sy=0,cmd='M';
        while(i<tokens.length){
          const t=tokens[i];
          if(/[A-Za-z]/.test(t)){cmd=t;i++;continue;}
          const isRel=cmd===cmd.toLowerCase();
          if(cmd==='M'||cmd==='m'){
            const x=parseFloat(tokens[i++]),y=parseFloat(tokens[i++]);
            const nx=isRel?cx+x:x, ny=isRel?cy+y:y;
            cx=nx;cy=ny;sx=nx;sy=ny;cmd=isRel?'l':'L';
          }else if(cmd==='L'||cmd==='l'){
            const x=parseFloat(tokens[i++]),y=parseFloat(tokens[i++]);
            const nx=isRel?cx+x:x, ny=isRel?cy+y:y;
            pushSeg(cx,cy,nx,ny);cx=nx;cy=ny;
          }else if(cmd==='H'||cmd==='h'){
            const x=parseFloat(tokens[i++]);
            const nx=isRel?cx+x:x;
            pushSeg(cx,cy,nx,cy);cx=nx;
          }else if(cmd==='V'||cmd==='v'){
            const y=parseFloat(tokens[i++]);
            const ny=isRel?cy+y:y;
            pushSeg(cx,cy,cx,ny);cy=ny;
          }else if(cmd==='Z'||cmd==='z'){
            pushSeg(cx,cy,sx,sy);cx=sx;cy=sy;
          }else{
            // Unsupported command (curves/arcs) — skip its numeric args.
            i++;
          }
        }
      });
      if(!segs.length){toast('No line segments found in that SVG');return;}
      // Map SVG viewBox coords → fractional image coords.
      snapshot();
      const imgW=mapImg.naturalWidth,imgH=mapImg.naturalHeight;
      for(const [x1,y1,x2,y2] of segs){
        const fx1=(x1-vbX)/vbW, fy1=(y1-vbY)/vbH;
        const fx2=(x2-vbX)/vbW, fy2=(y2-vbY)/vbH;
        WALLS().push({id:'w'+(++nid),fx1,fy1,fx2,fy2,material:'drywall'});
      }
      invalidateCoverageCache();
      render();renderList();calcCoverage();
      toast(`Imported ${segs.length} walls from SVG`);
    }catch(err){
      toast('SVG import failed: '+(err.message||'invalid SVG'));
    }
  };
  reader.readAsText(file);
  input.value='';
}

// ═══ DXF WALL IMPORT ══════════════════════════════
// DXF is Y-up; images are Y-down, so the vertical axis flips. The drawing's
// extents are fitted into the floor image with a small margin. With no plan
// loaded yet, a blank white canvas matched to the drawing's aspect is created
// so walls-only DXF handoffs still produce a usable floor.
function importDxfWalls(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=async e=>{
    try{
      const {segments,minX,minY,maxX,maxY}=parseDxf(String(e.target.result||''));
      if(!segments.length){toast('No LINE/POLYLINE entities found in that DXF');return;}
      const spanX=Math.max(1e-9,maxX-minX),spanY=Math.max(1e-9,maxY-minY);
      let w=mapImg.naturalWidth,h=mapImg.naturalHeight;
      if(!w||!h){
        const long=1600;
        w=spanX>=spanY?long:Math.max(200,Math.round(long*spanX/spanY));
        h=spanX>=spanY?Math.max(200,Math.round(long*spanY/spanX)):long;
        const cv=document.createElement('canvas');cv.width=w;cv.height=h;
        const ctx=cv.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);
        await _applyMapDataUrl(cv.toDataURL('image/png'),file.name.replace(/\.[^/.]+$/,''),file.name+' (blank canvas)');
      }
      const margin=0.03;
      const k=Math.min(w*(1-2*margin)/spanX,h*(1-2*margin)/spanY);
      const ox=(w-spanX*k)/2, oy=(h-spanY*k)/2;
      snapshot();
      for(const s of segments){
        const x1=ox+(s.x1-minX)*k, y1=oy+(maxY-s.y1)*k;
        const x2=ox+(s.x2-minX)*k, y2=oy+(maxY-s.y2)*k;
        WALLS().push({id:'w'+(++nid),fx1:x1/w,fy1:y1/h,fx2:x2/w,fy2:y2/h,material:'drywall'});
      }
      invalidateCoverageCache();
      render();renderList();calcCoverage();
      toast(`Imported ${segments.length} walls from DXF`);
    }catch(err){
      toast('DXF import failed: '+(err&&err.message||err));
    }
  };
  reader.readAsText(file);
  input.value='';
}

// ═══ EKAHAU .ESX IMPORT / EXPORT ══════════════════
// Best-effort interop: floors (plan image + scale), walls (material-mapped)
// and AP positions/names/channels round-trip; Plexus-specific data (switches,
// cameras, IPAM, inventory) stays on our side.
function importEsxFile(input){
  const file=input.files[0];if(!file)return;
  toast('Reading Ekahau project…');
  file.arrayBuffer()
    .then(buf=>importEsx(new Uint8Array(buf)))
    .then(async ({floors,warnings})=>{
      if(!floors.length){toast('No floors found in that .esx');return;}
      snapshot();
      const firstNew=FLOORS.length;
      for(const ef of floors){
        const floor={id:'f'+(++nid),name:ef.name,img:'',imgId:'',imgName:'',APS:[],DZS:[],SWS:[],WALLS:[],CAMS:[],ANNOS:[],SAMPLES:[],scaleM:ef.scaleM||100};
        for(const wl of ef.walls)floor.WALLS.push({id:'w'+(++nid),...wl});
        for(const ap of ef.aps){
          floor.APS.push({
            id:'ap'+(++nid),name:ap.name,fx:ap.fx,fy:ap.fy,
            model:MODELS.includes(ap.model)?ap.model:'Custom/Other',
            freq:'2.4 / 5 GHz',sig:'strong',
            r:Math.round(25*100/(floor.scaleM||100)),
            channel:ap.channel||'auto',txPower:'auto',
            ...(Number.isFinite(ap.txPowerDbm)?{txPowerDbm:ap.txPowerDbm}:{}),
          });
        }
        if(ef.imageBytes&&ef.imageBytes.length){
          const b=ef.imageBytes;
          const mime=b[0]===0x89?'image/png':'image/jpeg';
          const dataUrl=await new Promise(res=>{
            const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(new Blob([b],{type:mime}));
          });
          try{
            const id=_newImgId();
            await idbPutImage(id,dataUrl);
            _imgCache.set(id,dataUrl);
            floor.imgId=id;floor.imgName=ef.name;
          }catch(_){floor.img=dataUrl;floor.imgName=ef.name;}
        }
        FLOORS.push(floor);
      }
      // Migration pass fills schema defaults on everything just imported.
      migrateProject({version:PROJECT_VERSION,floors:FLOORS});
      syncNidFromFloors();
      switchFloor(firstNew);
      warnings.forEach(w=>console.warn('[esx import]',w));
      toast(`Imported ${floors.length} floor(s) from Ekahau${warnings.length?` — ${warnings.length} warning(s) in console`:''}`);
    })
    .catch(err=>toast('ESX import failed: '+(err&&err.message||err)));
  input.value='';
}
async function doExportEsx(){
  toast('Building .esx…');
  const floors=[];
  for(const f of FLOORS){
    let imageBytes=null,imgW=1000,imgH=800;
    const src=await resolveFloorImage(f).catch(()=>f.img||'');
    if(src){
      const m=/^data:[^;]+;base64,(.*)$/s.exec(src);
      if(m)imageBytes=Uint8Array.from(atob(m[1]),c=>c.charCodeAt(0));
      const dim=await new Promise(res=>{
        const im=new Image();
        im.onload=()=>res({w:im.naturalWidth,h:im.naturalHeight});
        im.onerror=()=>res(null);
        im.src=src;
      });
      if(dim&&dim.w){imgW=dim.w;imgH=dim.h;}
    }
    floors.push({
      name:f.name,imgW,imgH,scaleM:f.scaleM||100,imageBytes,
      walls:(f.WALLS||[]).map(w=>({fx1:w.fx1,fy1:w.fy1,fx2:w.fx2,fy2:w.fy2,material:w.material})),
      aps:(f.APS||[]).map(a=>({name:a.name,fx:a.fx,fy:a.fy,model:a.model,channel:a.channel,txPowerDbm:a.txPowerDbm})),
    });
  }
  const bytes=buildEsxZip(floors,{projectName:SETTINGS.company||'Plexus'});
  _downloadFile('plexus-project.esx',bytes,'application/octet-stream');
  toast('Ekahau .esx exported (best-effort — verify in Ekahau)');
}

// ═══ UNIFI CONTROLLER SYNC (desktop app only) ═════
// Pull: match controller devices to planned devices (MAC first, then name)
// and fill in as-built inventory (IP, firmware, serial) + set Live status.
// Push: send the channel/width/tx plan to matching APs. All network traffic
// runs in the Electron main process (self-signed controller certs).
let _unifiPass='';   // session-only, never saved to SETTINGS or project files
function _applyUnifiDevices(devices){
  const norm=m=>String(m||'').toLowerCase().replace(/[^0-9a-f]/g,'');
  const all=[];
  for(const f of FLOORS)for(const list of [f.APS,f.SWS,f.CAMS])for(const d of (list||[]))all.push(d);
  let matched=0;
  snapshot();
  for(const dev of devices){
    const dm=norm(dev.mac);
    let target=(dm&&all.find(x=>norm(x.mac)===dm))||null;
    if(!target&&dev.name)target=all.find(x=>(x.name||'').toLowerCase()===dev.name.toLowerCase())||null;
    if(!target)continue;
    matched++;
    if(dev.ip)target.ip=dev.ip;
    if(dev.mac&&!target.mac)target.mac=dev.mac;
    if(dev.version)target.firmware=dev.version;
    if(dev.serial&&!target.serial)target.serial=dev.serial;
    if(dev.state===1)target.status='live';
  }
  render();renderList();renderRP();autosave();
  return matched;
}
function _unifiChannelPlan(){
  const changes=[];
  for(const f of FLOORS)for(const ap of (f.APS||[])){
    const ch=_parseChannel(ap.channel);
    if(ch==null)continue;
    changes.push({
      mac:ap.mac||'',name:ap.name||'',
      band:bandKey(ap.freq),channel:ch,width:ap.chanWidth||20,
      txPowerDbm:Number.isFinite(ap.txPowerDbm)?ap.txPowerDbm:undefined,
    });
  }
  return changes;
}
function showUnifiDialog(){
  if(!(window.plexusNative&&window.plexusNative.unifiPull)){
    toast('UniFi sync needs the desktop app');return;
  }
  const wrap=document.createElement('div');wrap.className='settings-form';
  const field=(label,type,value,placeholder)=>{
    const row=document.createElement('div');row.className='ep-row';
    const lbl=document.createElement('label');lbl.className='ep-lbl';localizeText(lbl,label);
    const inp=document.createElement('input');inp.className='ep-in';inp.type=type;
    inp.value=value||'';inp.placeholder=placeholder||'';
    if(type==='password')inp.autocomplete='new-password';
    row.append(lbl,inp);wrap.appendChild(row);
    return inp;
  };
  const url=field('unifi.url','text',SETTINGS.unifiUrl,'https://192.168.1.1');
  const site=field('unifi.site','text',SETTINGS.unifiSite||'default','default');
  const user=field('unifi.username','text',SETTINGS.unifiUser,'admin');
  const pass=field('unifi.password','password',_unifiPass,'');
  const status=document.createElement('div');
  status.style.cssText='font-family:"Share Tech Mono";font-size:11px;white-space:pre-wrap;margin:8px 0;min-height:16px';
  const saveFields=()=>{
    SETTINGS.unifiUrl=(url.value||'').trim();
    SETTINGS.unifiSite=(site.value||'default').trim();
    SETTINGS.unifiUser=(user.value||'').trim();
    _unifiPass=pass.value||'';
  };
  const cfg=()=>({url:SETTINGS.unifiUrl,site:SETTINGS.unifiSite,user:SETTINGS.unifiUser,pass:_unifiPass});
  const btnRow=document.createElement('div');btnRow.className='ep-btn-row';
  const mkBtn=(label,title)=>{
    const b=document.createElement('button');b.className='btn';localizeText(b,label);b.setAttribute('data-i18n-title',title);b.title=t(title);
    btnRow.appendChild(b);return b;
  };
  const pullBtn=mkBtn('unifi.pull','unifi.pull_tip');
  const pushBtn=mkBtn('unifi.push','unifi.push_tip');
  const busy=(on)=>{pullBtn.disabled=on;pushBtn.disabled=on;};
  pullBtn.addEventListener('click',async()=>{
    saveFields();busy(true);status.textContent='Connecting…';
    const res=await window.plexusNative.unifiPull(cfg());
    busy(false);
    if(!res.ok){status.textContent='✕ '+res.error;return;}
    const n=_applyUnifiDevices(res.devices);
    status.textContent=`✓ Controller reports ${res.devices.length} device(s); matched ${n} to this plan (by MAC, then name). IP / firmware / serial / status updated.`;
  });
  pushBtn.addEventListener('click',async()=>{
    saveFields();
    const changes=_unifiChannelPlan();
    if(!changes.length){status.textContent='✕ No APs with a concrete channel — run ⌁ Auto-channel first.';return;}
    if(!confirm(`Push channel/width/tx settings for ${changes.length} AP(s) to the controller? Radios will briefly drop clients when they retune.`))return;
    busy(true);status.textContent='Pushing…';
    const res=await window.plexusNative.unifiPush({...cfg(),changes});
    busy(false);
    if(!res.ok){status.textContent='✕ '+res.error;return;}
    const okN=res.results.filter(r=>r.ok).length;
    const fails=res.results.filter(r=>!r.ok);
    status.textContent=`✓ Updated ${okN}/${res.results.length} AP(s).`+(fails.length?'\n'+fails.map(f=>`  ✕ ${f.name}: ${f.error}`).join('\n'):'');
  });
  wrap.appendChild(btnRow);
  wrap.appendChild(status);
  const hint=document.createElement('div');hint.className='ep-hint';
  localizeText(hint,'unifi.hint');
  wrap.appendChild(hint);
  showModalNode({i18n:'modal.unifi'},wrap,()=>{saveFields();autosave();});
}

// ═══ SAVE / LOAD PROJECT ══════════════════════════
// PROJECT_VERSION, migrateProject, syncNidFromFloors, nextNameSuffix all
// imported from ./src/migrate.js. See top of file.

// Strip per-item cache fields (`_coveragePath`, `_coverageFor`, etc.) so saved
// JSON stays small and never round-trips stale geometry into a future load.
function _stripCacheReplacer(k,v){return k.startsWith('_')?undefined:v;}
async function saveProject(){
  // Inline the IDB-stored images into the saved file so the project remains
  // self-contained when shared. The in-memory FLOORS keeps `imgId` only —
  // we serialize a copy with `img` populated for portability.
  const inlineFor=async id=>{
    if(!id)return '';
    if(_imgCache.has(id))return _imgCache.get(id);
    try{return await idbGetImage(id)||'';}catch(_){return '';}
  };
  const floorsForExport=await Promise.all(FLOORS.map(async f=>{
    const out={...f};
    if(f.imgId&&!f.img){const data=await inlineFor(f.imgId);if(data)out.img=data;}
    // Inline uploaded device images too, so the project file is fully
    // self-contained and portable between technicians' laptops.
    for(const key of ['APS','CAMS','SWS']){
      if(!Array.isArray(out[key]))continue;
      out[key]=await Promise.all(out[key].map(async it=>{
        if(it&&it.imgId&&!it.img){const data=await inlineFor(it.imgId);if(data)return {...it,img:data};}
        return it;
      }));
    }
    return out;
  }));
  // scaleM is now stored per-floor; project-level field omitted.
  const data={version:PROJECT_VERSION,settings:SETTINGS,floors:floorsForExport,revisions:PROJECT_REVISIONS,savedAt:new Date().toISOString()};
  // When a credentials passphrase is set, encrypt every device's creds into a
  // single vault and strip the plaintext from the exported devices.
  await _encryptCredsInto(data);
  const blob=new Blob([JSON.stringify(data,_stripCacheReplacer,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='plexus_project.json';a.click();
  toast(_credPass?'Project saved (credentials encrypted)':'Project saved');
}
// ── Credential vault (encrypt-at-rest for saved/exported projects) ─────────
// Gather {deviceId: creds} across floors.
function _collectCreds(floors){
  const map={};
  for(const f of (floors||[]))for(const key of ['APS','CAMS','SWS'])
    for(const d of (f[key]||[]))if(d&&d.creds&&d.id)map[d.id]=d.creds;
  return map;
}
// If a passphrase is set, move creds into data.credsVault and strip the inline
// plaintext from copies of the affected devices (never mutating live FLOORS).
async function _encryptCredsInto(data){
  if(!_credPass)return;
  const map=_collectCreds(data.floors);
  if(!Object.keys(map).length)return;
  data.credsVault=await encryptObject(map,_credPass);
  for(const f of data.floors)for(const key of ['APS','CAMS','SWS']){
    if(!Array.isArray(f[key]))continue;
    f[key]=f[key].map(d=>{if(d&&d.creds){const c={...d};delete c.creds;return c;}return d;});
  }
}
// After loading a project whose creds are encrypted, prompt for the passphrase
// and reattach the decrypted creds to the in-memory devices.
async function _unlockCreds(data){
  if(!data||!data.credsVault)return;
  const pass=await promptPassphrase('This project’s credentials are encrypted.\nEnter the passphrase to unlock them, or Cancel to keep them locked:');
  if(pass==null)return;
  try{
    const map=await decryptObject(data.credsVault,pass);
    _credPass=pass;   // remember so a re-save stays encrypted with the same key
    for(const f of FLOORS)for(const key of ['APS','CAMS','SWS'])
      for(const d of (f[key]||[]))if(map[d.id])d.creds=map[d.id];
    render();renderRP();
    toast('Credentials unlocked');
  }catch{
    toast('Wrong passphrase — credentials stay locked');
  }
}
// Modal password prompt → resolves to the string, or null if cancelled.
function promptPassphrase(message){
  return new Promise(resolve=>{
    const wrap=document.createElement('div');wrap.style.cssText='font-family:Rajdhani,sans-serif;font-size:13px';
    String(message).split('\n').forEach((line,i,arr)=>{wrap.appendChild(document.createTextNode(line));if(i<arr.length-1)wrap.appendChild(document.createElement('br'));});
    const inp=document.createElement('input');inp.type='password';inp.className='ep-in';inp.autocomplete='off';
    inp.style.cssText='width:100%;margin-top:10px';
    wrap.appendChild(inp);
    let done=false;
    showModalNode({i18n:'settings.passphrase'},wrap,()=>{done=true;resolve(inp.value||'');},()=>{if(!done)resolve(null);});
    setTimeout(()=>inp.focus(),50);
  });
}

// Clears all floors and starts a single fresh blank floor.
// Confirms first if there's anything to lose; also removes the autosave snapshot
// so the next page load doesn't offer to restore what the user just wiped.
function newProject(){
  const hasAny=FLOORS.some(f=>(f.APS?.length||f.DZS?.length||f.SWS?.length||(f.WALLS&&f.WALLS.length)||f.img||f.imgId));
  const doIt=async ()=>{
    // Drop any IDB-stored images for the floors we're discarding so the
    // database doesn't grow without bound across "New Project" cycles.
    const oldIds=FLOORS.map(f=>f.imgId).filter(Boolean);
    // Mutate FLOORS in place rather than reassigning the binding — this keeps
    // any existing references (tests, inspector debugging, closures) valid.
    FLOORS.length=0;
    FLOORS.push({id:'f1',name:'Floor 1',img:'',imgId:'',imgName:'',APS:[],DZS:[],SWS:[],WALLS:[],CAMS:[],ANNOS:[],SAMPLES:[],scaleM:100});
    PROJECT_REVISIONS=[];
    curFloor=0;selId=null;selType=null;nid=1;
    syncScaleFromFloor();
    try{localStorage.removeItem(AUTOSAVE_KEY);}catch(_){}
    for(const id of oldIds){idbDeleteImage(id).catch(()=>{});}
    lastAutosavePayload='';
    invalidateCoverageCache();
    loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
    toast('New project');
  };
  if(hasAny){
    showModalText({i18n:'modal.new'},{i18n:'modal.new_body'},doIt);
  }else{
    doIt();
  }
}
function loadProject(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=async e=>{
    try{
      const raw=JSON.parse(e.target.result);
      const [data,warnings]=migrateProject(raw);
      FLOORS=data.floors;
      SETTINGS={...DEFAULT_SETTINGS,...(data.settings||{})};
      applyStoredCatalog();
      PROJECT_REVISIONS=Array.isArray(data.revisions)?data.revisions:[];
      // Apply the persisted UI language (i18n bundle) right away.
      setLang(SETTINGS.language||'en');
      curFloor=0;selId=null;selType=null;
      syncScaleFromFloor();
      syncNidFromFloors();
      // Import any inline floor/device images into IDB (and warm the cache) so
      // the project is portable across laptops; keeps autosaves tiny afterward.
      await _rehydrateImages();
      applySettingsToBrand();
      loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
      if(warnings.length){toast(warnings[0]);}else{toast('Project loaded');}
      await _unlockCreds(data);   // prompt for the passphrase if creds are encrypted
    }catch(err){toast('Error loading project: '+(err.message||'invalid file'));}
  };
  reader.readAsText(file);input.value='';
}
// Load the bundled sample project (empty-state button). Same pipeline as
// loadProject, minus the file read — the sample is generated in-memory.
async function loadSampleProject(){
  try{
    const [data,warnings]=migrateProject(buildSampleProject());
    FLOORS=data.floors;
    SETTINGS={...DEFAULT_SETTINGS,...(data.settings||{})};
    applyStoredCatalog();
    PROJECT_REVISIONS=Array.isArray(data.revisions)?data.revisions:[];
    setLang(SETTINGS.language||'en');
    curFloor=0;selId=null;selType=null;
    syncScaleFromFloor();
    syncNidFromFloors();
    await _rehydrateImages();
    applySettingsToBrand();
    loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
    if(warnings.length){toast(warnings[0]);}else{toast('Sample project loaded — drag things around');}
  }catch(err){toast('Error loading sample: '+(err.message||'unknown'));}
}
// Update the top-bar brand label to whatever the current SETTINGS specify.
// Called after settings change or a project load.
function applySettingsToBrand(){
  setLang(SETTINGS.language||'en');
  const lbl=document.getElementById('brand-lbl');
  if(lbl){
    const co=SETTINGS.company||'Plexus';
    const f=F();
    lbl.textContent=f&&f.imgName?co+' · '+f.imgName:co+' '+t('app.planner');
  }
  _syncToolbarFromSettings();
}
// Reflect persisted v3 settings on the toolbar — the heatmap-mode / band
// pills and the Roaming toggle. Without this, loading a project saved with
// a non-default heatmap mode leaves the pill showing the wrong label.
function _syncToolbarFromSettings(){
  const modePill=document.getElementById('heat-mode-pill');
  if(modePill){
    const m=SETTINGS.heatmapMode||'rssi';
    localizeText(modePill,'heat.metric_'+(HEATMAP_MODES[m]?m:'rssi'));
  }
  const bandPill=document.getElementById('heat-band-pill');
  if(bandPill){
    const b=SETTINGS.heatmapBand||'all';
    localizeText(bandPill,({'all':'heat.all','2.4':'heat.band_24','5':'heat.band_5','6':'heat.band_6'})[b]||'heat.all');
  }
  const roam=document.getElementById('btn-roaming');
  if(roam)roam.classList.toggle('active',!!SETTINGS.showRoamingOverlap);
  const vlanBtn=document.getElementById('btn-vlan');
  if(vlanBtn)vlanBtn.classList.toggle('active',!!SETTINGS.colorByVlan);
}

// ═══ ID SYNC ══════════════════════════════════════
// After loading a project (from file or autosave), the global `nid` counter
// might be lower than the highest ID already in use. If we let `nid` reset
// to 1, the next placed AP gets an ID like "ap1" — which collides with an
// existing item. The collision causes findIndex() to return the wrong item
// later, so e.g. clicking "AP-22" in the list might select AP-16 (whichever
// has the same internal id).
//
// Run this whenever FLOORS is loaded or restored from outside.
function syncNidFromFloors(){nid=_syncNidFromFloors(FLOORS);}
function applyT(){
  // Clamp pan so the image stays connected to the viewport. Two regimes:
  //  - Image smaller than viewport on an axis → center it on that axis
  //  - Image larger than viewport → allow pan but keep at least an edge visible
  const va=viewport.getBoundingClientRect();
  const iw=(mapImg.naturalWidth||0)*scale;
  const ih=(mapImg.naturalHeight||0)*scale;
  if(iw>0&&ih>0){
    if(iw<=va.width){
      // Image fits horizontally — center it
      panX=(va.width-iw)/2;
    }else{
      // Image wider than viewport — allow pan, but keep a margin visible
      const margin=Math.min(va.width*.5,iw*.3);
      panX=Math.max(va.width-iw-margin,Math.min(margin,panX));
    }
    if(ih<=va.height){
      panY=(va.height-ih)/2;
    }else{
      const margin=Math.min(va.height*.5,ih*.3);
      panY=Math.max(va.height-ih-margin,Math.min(margin,panY));
    }
  }
  canvas.style.transform=`translate(${panX}px,${panY}px) scale(${scale})`;
  document.getElementById('zval').textContent=Math.round(scale*100)+'%';
  renderMM();updateScaleBar();
}

// Trigger a short transition on #cv so a discrete zoom (button click, keyboard)
// glides smoothly instead of snapping. Wheel/pinch do NOT call this — they're
// continuous and a transition would make them feel laggy.
let smoothTimeout=null;
function smoothZoom(delta){
  canvas.classList.add('smooth-zoom');
  doZoom(delta);
  clearTimeout(smoothTimeout);
  smoothTimeout=setTimeout(()=>canvas.classList.remove('smooth-zoom'),200);
}
function fitZoom(){
  if(!mapImg.naturalWidth)return;
  const va=viewport.getBoundingClientRect();
  scale=Math.min(va.width/mapImg.naturalWidth,va.height/mapImg.naturalHeight)*.96;
  panX=(va.width-mapImg.naturalWidth*scale)/2;panY=(va.height-mapImg.naturalHeight*scale)/2;applyT();
}
function doZoom(delta,cx,cy){
  const va=viewport.getBoundingClientRect();cx=cx??va.width/2;cy=cy??va.height/2;
  const prev=scale;
  // Multiplicative zoom: each step changes scale by the same *percentage* so
  // zooming feels consistent at any level. `delta` is now a factor-per-step
  // in the neighbourhood of ±0.15 (treat as a log-space delta).
  const factor=Math.exp(delta);
  scale=Math.max(.15,Math.min(8,prev*factor));
  const r=scale/prev;
  panX=cx-r*(cx-panX);panY=cy-r*(cy-panY);applyT();
}
viewport.addEventListener('wheel',e=>{
  e.preventDefault();
  const va=viewport.getBoundingClientRect();
  // Normalize wheel deltas across mouse / trackpad / mac / win.
  // deltaMode 0 = pixels (trackpads), 1 = lines (~16-40px), 2 = pages.
  // Clamp per-event delta so a big mouse-wheel kick doesn't jump half a screen.
  let d=e.deltaY;
  if(e.deltaMode===1)d*=16;            // convert lines → px equivalent
  else if(e.deltaMode===2)d*=va.height;
  d=Math.max(-120,Math.min(120,d));
  // Scale factor is a fraction of the delta magnitude, inverted (scroll up = zoom in).
  // 0.0025 gives a comfortable feel across hardware; at d=120 that's ~30% per tick.
  const factor=-d*0.0025;
  doZoom(factor,e.clientX-va.left,e.clientY-va.top);
},{passive:false});

let spaceDown=false;
document.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.tagName!=='INPUT'&&e.target.tagName!=='TEXTAREA'){spaceDown=true;e.preventDefault();}});
document.addEventListener('keyup',e=>{if(e.code==='Space')spaceDown=false;});

// Pointer events: unified handling for mouse, touch, and pen.
// When two touch points are active we yield to the pinch-zoom path below.
let activePointers=0;
viewport.addEventListener('pointerdown',e=>{
  activePointers++;
  // Don't engage drag/pan if this is the 2nd finger of a pinch gesture
  if(e.pointerType==='touch'&&activePointers>1){panning=false;dragId=null;resId=null;return;}
  // Middle-click / right-click / space+click = pan
  if(e.button===1||e.button===2||(e.button===0&&spaceDown)){
    e.preventDefault();panning=true;panStartX=e.clientX;panStartY=e.clientY;panPrevX=panX;panPrevY=panY;viewport.classList.add('cur-grabbing');
    return;
  }
  // Left-click on empty canvas in select mode — start a marquee drag.
  if(e.button===0&&mode==='sel'&&!e.target.closest('.ap-grp,.dz-grp,.sw-grp,.cam-grp,.cam-lens,.wall-line,.wall-vert')){
    startMarquee(e.clientX,e.clientY,e.shiftKey);
  }
});
viewport.addEventListener('contextmenu',e=>{
  e.preventDefault();
  // Find what was right-clicked: AP / DZ / SW group
  const apGroup=e.target.closest('.ap-grp');
  const dzGroup=e.target.closest('.dz-grp');
  const swGroup=e.target.closest('.sw-grp');
  if(apGroup){openItemContextMenu('ap',apGroup.dataset.id,e.clientX,e.clientY);return;}
  if(dzGroup){openItemContextMenu('dz',dzGroup.dataset.id,e.clientX,e.clientY);return;}
  if(swGroup){openItemContextMenu('sw',swGroup.dataset.id,e.clientX,e.clientY);return;}
  const camLens=e.target.closest('.cam-grp,.cam-lens');
  if(camLens){
    const grp=camLens.closest('.cam-grp');
    const id=(grp&&grp.dataset.id)||camLens.dataset.id;
    if(id)openItemContextMenu('cam',id,e.clientX,e.clientY);
    return;
  }
});
document.addEventListener('pointermove',e=>{
  if(panning){panX=panPrevX+(e.clientX-panStartX);panY=panPrevY+(e.clientY-panStartY);applyT();return;}
  if(wallVertDrag){updateWallVertex(e.clientX,e.clientY);return;}
  if(marqueeDrag){updateMarquee(e.clientX,e.clientY);return;}
  if(dragId)doDrag(e.clientX,e.clientY);
  if(resId)doResize(e.clientX);
  if(mode==='ruler'&&rulerStart&&!rulerEnd)updateRuler(e.clientX,e.clientY);
  if(mode==='wall'&&wallStart)updateWallPreview(e.clientX,e.clientY,e.shiftKey);
  if(mode==='anno'&&annoStart&&annoSubMode!=='text'){
    const img=vpToImg(e.clientX,e.clientY);
    annoHover={x:img.x,y:img.y};
    renderAnnoPreview();
  }
});
document.addEventListener('pointerup',()=>{
  activePointers=Math.max(0,activePointers-1);
  panning=false;viewport.classList.remove('cur-grabbing');
  if(wallVertDrag){wallVertDrag=null;render();calcCoverage();}
  if(marqueeDrag){finishMarquee();}
  endDrag();resId=null;
});
document.addEventListener('pointercancel',()=>{activePointers=0;panning=false;viewport.classList.remove('cur-grabbing');wallVertDrag=null;if(marqueeDrag)finishMarquee();endDrag();resId=null;});

let lastPD=0;
viewport.addEventListener('touchstart',e=>{if(e.touches.length===2)lastPD=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);},{passive:true});
viewport.addEventListener('touchmove',e=>{
  if(e.touches.length===2){e.preventDefault();const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);const va=viewport.getBoundingClientRect();doZoom((d-lastPD)*.008,(e.touches[0].clientX+e.touches[1].clientX)/2-va.left,(e.touches[0].clientY+e.touches[1].clientY)/2-va.top);lastPD=d;}
},{passive:false});

// ═══ COORDS ═══════════════════════════════════════
function vpToImg(cx,cy){const va=viewport.getBoundingClientRect();return{x:(cx-va.left-panX)/scale,y:(cy-va.top-panY)/scale};}
function snapPt(x,y){if(!showGrid)return{x,y};return{x:Math.round(x/GRID_SZ)*GRID_SZ,y:Math.round(y/GRID_SZ)*GRID_SZ};}
function imgToFrac(x,y){const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;return{fx:x/w,fy:y/h};}
function fracToImg(fx,fy){return{x:fx*(mapImg.naturalWidth||1),y:fy*(mapImg.naturalHeight||1)};}

// ═══ UNDO / REDO ══════════════════════════════════
// Snapshot the entire FLOORS array + curFloor + scaleM, not just the current
// floor — so cross-floor changes (delete floor, reorder, etc.) are reversible.
// Strips per-AP cache fields (anything starting with `_`) so the snapshot
// stays small and never resurrects stale geometry caches on undo.
function _serializeState(){
  // Per-floor scaleM is carried inside each floor object now.
  return JSON.stringify({floors:FLOORS,curFloor},(k,v)=>k.startsWith('_')?undefined:v);
}
function _restoreState(json){
  const s=JSON.parse(json);
  FLOORS=s.floors;
  curFloor=Math.max(0,Math.min(FLOORS.length-1,s.curFloor??0));
  syncScaleFromFloor();
  invalidateCoverageCache();
}
function snapshot(){
  // Cancel any pending debounced snapshot — committing one synchronously
  // means we already have the right "before" state captured here.
  _snapPending=false;clearTimeout(_snapT);_snapT=null;
  undoStack.push(_serializeState());
  if(undoStack.length>50)undoStack.shift();
  redoStack=[];
  document.getElementById('btn-undo').disabled=false;
  document.getElementById('btn-redo').disabled=true;
}
// Debounced snapshot for streaming edits (sliders, text inputs). The first
// call within a quiet window captures the *pre-edit* state, then 400ms after
// the last call we commit. This way Undo jumps back across the whole edit
// burst (one visible step) instead of per-keystroke (many).
let _snapT=null,_snapPending=false,_snapPreState=null;
function snapshotSoon(){
  if(!_snapPending){
    _snapPending=true;
    _snapPreState=_serializeState();
  }
  clearTimeout(_snapT);
  _snapT=setTimeout(()=>{
    if(!_snapPending)return;
    _snapPending=false;
    undoStack.push(_snapPreState);
    if(undoStack.length>50)undoStack.shift();
    redoStack=[];
    document.getElementById('btn-undo').disabled=false;
    document.getElementById('btn-redo').disabled=true;
    _snapPreState=null;
  },400);
}
// Force commit immediately — call from blur handlers so leaving a field
// finalizes its snapshot without waiting for the timer.
function snapshotFlush(){
  if(!_snapPending)return;
  clearTimeout(_snapT);_snapT=null;
  _snapPending=false;
  undoStack.push(_snapPreState);
  if(undoStack.length>50)undoStack.shift();
  redoStack=[];
  document.getElementById('btn-undo').disabled=false;
  document.getElementById('btn-redo').disabled=true;
  _snapPreState=null;
}
function undo(){
  if(!undoStack.length)return;
  redoStack.push(_serializeState());
  _restoreState(undoStack.pop());
  selId=null;selType=null;
  loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
  document.getElementById('btn-undo').disabled=!undoStack.length;
  document.getElementById('btn-redo').disabled=false;
  toast('Undo');
}
function redo(){
  if(!redoStack.length)return;
  undoStack.push(_serializeState());
  _restoreState(redoStack.pop());
  selId=null;selType=null;
  loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
  document.getElementById('btn-redo').disabled=!redoStack.length;
  document.getElementById('btn-undo').disabled=false;
  toast('Redo');
}

// ═══ MODE ═════════════════════════════════════════
function setMode(m){
  mode=m;
  // Clear any in-progress ruler measurement when leaving ruler mode
  if(m!=='ruler'){rulerStart=null;renderRuler();}
  // Clear any in-progress wall when leaving wall mode
  if(m!=='wall'){wallStart=null;wallHover=null;renderWallPreview();}
  // Clear annotation drag when leaving annotation mode
  if(m!=='anno'){annoStart=null;annoHover=null;renderAnnoPreview();}
  ['add','sel','dz','sw','cam','ruler','wall','anno','survey'].forEach(mm=>document.getElementById('btn-'+mm)?.classList.toggle('active',mm===m));
  viewport.className=m==='sel'?'':m==='dz'?'cur-cell':m==='sw'?'cur-cell':m==='cam'?'cur-cell':'cur-cross';
  // Show/hide the annotation sub-mode chooser (text / arrow / dim).
  const subBar=document.getElementById('anno-sub-bar');
  if(subBar)subBar.style.display=(m==='anno')?'flex':'none';
  // Hint pill: show prominently for 3.5s on mode change, then fade to background.
  // The auto-fade keeps it visible enough to consult but unobtrusive while you work.
  const hintEl=document.getElementById('hint-bar');
  if(hintEl){
    localizeText(hintEl,'hint.'+m);
    hintEl.classList.remove('faded');
    clearTimeout(hintEl._fadeT);
    hintEl._fadeT=setTimeout(()=>hintEl.classList.add('faded'),3500);
  }
}

// ═══ MAP CLICK ════════════════════════════════════
viewport.addEventListener('click',e=>{
  if(panning||spaceDown||e.button!==0)return;
  if(e.target.closest('.ap-grp,.dz-grp,.sw-grp'))return;
  if(!mapImg.naturalWidth){toast('Upload a map image first');return;}
  const raw=vpToImg(e.clientX,e.clientY);
  const {x,y}=snapPt(raw.x,raw.y);
  const {fx,fy}=imgToFrac(x,y);
  if(fx<0||fx>1||fy<0||fy>1){desel();return;}

  if(mode==='add'){
    snapshot();
    const id='ap'+nid++;
    const num=nextNameSuffix(APS(),/^AP-(\d+)/);
    // Remember last-used model: new APs default to whatever model the user
    // last selected or placed in this session (or the project default).
    const defaultModel=AP_RANGE_M[SETTINGS.lastModel]?SETTINGS.lastModel:'U6 Pro';
    APS().push({
      id,name:'AP-'+String(num).padStart(2,'0'),model:defaultModel,
      freq:'2.4 / 5 GHz',channel:'auto',txPower:'auto',sig:'strong',color:'',
      ip:'',mac:'',port:'',vlan:'',notes:'',comment:'',
      fx,fy,r:rangeMToPx(AP_RANGE_M[defaultModel]),locked:false,
      pattern:'omni',heading:0,swId:'',
      antennaGainDbi:AP_ANTENNA_GAIN_DBI[defaultModel]??4,
      cableLossDb:0,txPowerDbm:20,mountHeightM:2.7,downtiltDeg:0,
      capacityClients:25,chanWidth:40,
    });
    sel(id,'ap');setMode('sel');render();renderList();calcCoverage();toast('AP placed — edit in panel');
  }else if(mode==='dz'){
    snapshot();
    const id='dz'+nid++;
    const num=nextNameSuffix(DZS(),/^Dead Zone (\d+)/);
    DZS().push({id,label:'Dead Zone '+num,fx,fy,r:40,locked:false});
    sel(id,'dz');setMode('sel');render();renderList();toast('Dead zone marked');
  }else if(mode==='sw'){
    snapshot();
    const id='sw'+nid++;
    const num=nextNameSuffix(SWS(),/^SW-(\d+)/);
    SWS().push({id,name:'SW-'+num,model:'USW-24-PoE',ip:'',notes:'',fx,fy,size:22,locked:false,poeBudget:SW_POE_BUDGET_W['USW-24-PoE']||0,ports:0,uplinkId:''});
    sel(id,'sw');setMode('sel');render();renderList();toast('Switch placed');
  }else if(mode==='cam'){
    snapshot();
    const id='cm'+nid++;
    const num=nextNameSuffix(CAMS(),/^CAM-(\d+)/);
    const model=SETTINGS.lastCamModel&&CAM_SPECS[SETTINGS.lastCamModel]?SETTINGS.lastCamModel:'G4 Pro';
    const spec=CAM_SPECS[model]||CAM_SPECS['Custom/Other'];
    CAMS().push({
      id,name:'CAM-'+String(num).padStart(2,'0'),model,
      fx,fy,
      fov:spec.fov, range:Math.round(spec.range*100/(scaleM||100)),
      heading:0, resolution:spec.res,
      ip:'',mac:'',swId:'',port:'',vlan:'',notes:'',color:'',locked:false,
    });
    sel(id,'cam');setMode('sel');render();renderList();toast('Camera placed — set heading in panel');
  }else if(mode==='ruler'){
    if(!rulerStart){
      rulerStart={x,y};rulerEnd=null;rulerHover={x,y};
    }else if(!rulerEnd){
      rulerEnd={x,y};
      if(calibratePending){calibratePending=false;renderRuler();promptCalibration();return;}
      const distM=Math.hypot(rulerEnd.x-rulerStart.x,rulerEnd.y-rulerStart.y)*(scaleM/100);
      toast(`${distM.toFixed(1)} m · Click again for new measurement`);
    }else{
      // Start a new measurement
      rulerStart={x,y};rulerEnd=null;rulerHover={x,y};
    }
    renderRuler();
  }else if(mode==='wall'){
    // Two-click wall drawing: first click = start, second click = commit
    if(!wallStart){
      wallStart={x,y};wallHover={x,y};renderWallPreview();
    }else{
      commitWall(x,y);
    }
  }else if(mode==='anno'){
    // Text: single click → prompt. Arrow/dim: two-click drag like walls.
    if(annoSubMode==='text'){
      annoStart={x,y};
      commitAnno(x,y);
    } else if(!annoStart){
      annoStart={x,y};annoHover={x,y};renderAnnoPreview();
    } else {
      commitAnno(x,y);
    }
  }else if(mode==='survey'){
    // Live survey (desktop app): click = "I'm standing here", sample the OS's
    // current WiFi connection and drop a survey point at the click.
    if(!(window.plexusNative&&window.plexusNative.wifiSample)){
      toast('Live survey needs the desktop app');return;
    }
    toast('Sampling WiFi…');
    window.plexusNative.wifiSample().then(res=>{
      if(!res||!res.ok){toast('WiFi sample failed: '+((res&&res.error)||'no WiFi info'));return;}
      snapshot();
      SAMPLES().push({
        id:'s'+(++nid),fx,fy,
        ssid:res.ssid||'',bssid:res.bssid||'',
        rssi:Number.isFinite(res.rssi)?res.rssi:-95,
        channel:res.channel!=null?String(res.channel):'',
        floorName:F().name||'',
      });
      render();
      toast(`Sampled ${res.rssi} dBm${res.ssid?' on '+res.ssid:''}${res.channel?` · ch ${res.channel}`:''}`);
    });
  }else{
    desel();render();
  }
});

// ═══ ITEM GEOMETRY HELPERS ════════════════════════
function getItemCenter(type,id){
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  if(type==='ap'){const ap=APS().find(a=>a.id===id);return ap?{x:ap.fx*w,y:ap.fy*h}:null;}
  if(type==='sw'){const sw=SWS().find(a=>a.id===id);return sw?{x:sw.fx*w,y:sw.fy*h}:null;}
  if(type==='cam'){const c=CAMS().find(a=>a.id===id);return c?{x:c.fx*w,y:c.fy*h}:null;}
  if(type==='dz'){const dz=DZS().find(a=>a.id===id);return dz?{x:dz.fx*w,y:dz.fy*h}:null;}
  if(type==='wall'){const wl=WALLS().find(a=>a.id===id);if(!wl)return null;const p=_wallPx(wl);return {x:(p.x1+p.x2)/2,y:(p.y1+p.y2)/2};}
  return null;
}
// Returns {x,y,w,h} in image coords describing the item's bounding box —
// used by zoomToSelected to pick an appropriate target scale.
function getItemBounds(type,id){
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  if(type==='ap'){const ap=APS().find(a=>a.id===id);return ap?{x:ap.fx*w-ap.r,y:ap.fy*h-ap.r,w:ap.r*2,h:ap.r*2}:null;}
  if(type==='dz'){const dz=DZS().find(a=>a.id===id);return dz?{x:dz.fx*w-dz.r,y:dz.fy*h-dz.r,w:dz.r*2,h:dz.r*2}:null;}
  if(type==='sw'){const sw=SWS().find(a=>a.id===id);if(!sw)return null;const sz=sw.size||22;return {x:sw.fx*w-sz,y:sw.fy*h-sz*.6,w:sz*2,h:sz*1.2};}
  if(type==='cam'){const c=CAMS().find(a=>a.id===id);if(!c)return null;const r=c.range||80;return {x:c.fx*w-r,y:c.fy*h-r,w:r*2,h:r*2};}
  if(type==='wall'){const wl=WALLS().find(a=>a.id===id);if(!wl)return null;const p=_wallPx(wl);const x=Math.min(p.x1,p.x2),y=Math.min(p.y1,p.y2);return {x,y,w:Math.abs(p.x2-p.x1)+1,h:Math.abs(p.y2-p.y1)+1};}
  return null;
}

// ═══ RULER ════════════════════════════════════════
function renderRuler(){
  rulerLayer.innerHTML='';
  if(!rulerStart)return;
  // Endpoint: either the locked second click, or the current hover
  const end=rulerEnd||rulerHover;
  if(!end)return;
  const a=rulerStart,b=end;
  const distPx=Math.hypot(b.x-a.x,b.y-a.y);
  const distM=(distPx*(scaleM/100)).toFixed(1);
  const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;

  const line=mk('line');
  line.setAttribute('x1',a.x);line.setAttribute('y1',a.y);
  line.setAttribute('x2',b.x);line.setAttribute('y2',b.y);
  line.setAttribute('class','ruler-line');
  rulerLayer.appendChild(line);

  // Endpoint markers
  for(const p of [a,b]){
    const c=mk('circle');
    c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r',4);
    c.setAttribute('class','ruler-pt');
    rulerLayer.appendChild(c);
  }
  // Tick marks at each end, perpendicular to the line
  const angle=Math.atan2(b.y-a.y,b.x-a.x);
  const tickLen=10;
  const perp={x:-Math.sin(angle)*tickLen,y:Math.cos(angle)*tickLen};
  for(const p of [a,b]){
    const tick=mk('line');
    tick.setAttribute('x1',p.x-perp.x);tick.setAttribute('y1',p.y-perp.y);
    tick.setAttribute('x2',p.x+perp.x);tick.setAttribute('y2',p.y+perp.y);
    tick.setAttribute('class','ruler-tick');
    rulerLayer.appendChild(tick);
  }
  // Distance label — background pill + text
  const lblBg=mk('rect');
  const lblW=60,lblH=18;
  lblBg.setAttribute('x',mx-lblW/2);lblBg.setAttribute('y',my-lblH/2);
  lblBg.setAttribute('width',lblW);lblBg.setAttribute('height',lblH);
  lblBg.setAttribute('rx',9);lblBg.setAttribute('class','ruler-lbl-bg');
  rulerLayer.appendChild(lblBg);
  const lbl=mk('text');
  lbl.setAttribute('x',mx);lbl.setAttribute('y',my);
  lbl.setAttribute('class','ruler-lbl');
  lbl.textContent=distM+' m';
  rulerLayer.appendChild(lbl);
}
function updateRuler(cx,cy){
  if(mode!=='ruler'||!rulerStart||rulerEnd)return;
  const img=vpToImg(cx,cy);
  rulerHover={x:img.x,y:img.y};
  renderRuler();
}
function clearRuler(){
  rulerStart=null;rulerEnd=null;rulerHover=null;
  renderRuler();
}

// ═══ WALLS ════════════════════════════════════════
// Walls store fractional coords (fx1/fy1/fx2/fy2 in 0..1) so they survive
// map image swaps. We resolve to absolute pixels at render time. Drawn as
// straight line segments between two points, with per-material stroke width.
function _wallPx(w){return wallToPx(w,mapImg.naturalWidth||1,mapImg.naturalHeight||1);}
function renderWalls(){
  wallLayer.innerHTML='';
  WALLS().forEach(w=>{
    const mat=WALL_MATERIALS[w.material]||WALL_MATERIALS.drywall;
    const isSel=(selType==='wall'&&selId===w.id);
    const px=_wallPx(w);
    // Thin highlight underlay when selected
    if(isSel){
      const hl=mk('line');
      hl.setAttribute('x1',px.x1);hl.setAttribute('y1',px.y1);
      hl.setAttribute('x2',px.x2);hl.setAttribute('y2',px.y2);
      hl.setAttribute('class','wall-sel-hl');
      wallLayer.appendChild(hl);
    }
    const ln=mk('line');
    ln.setAttribute('x1',px.x1);ln.setAttribute('y1',px.y1);
    ln.setAttribute('x2',px.x2);ln.setAttribute('y2',px.y2);
    ln.setAttribute('class','wall-line');
    ln.setAttribute('stroke-width',mat.strokeWidth);
    if(mat.dash)ln.setAttribute('stroke-dasharray',mat.dash);
    ln.dataset.id=w.id;
    ln.style.pointerEvents='stroke';
    ln.style.cursor='pointer';
    ln.addEventListener('pointerdown',e=>{
      if(mode==='sel'){e.stopPropagation();sel(w.id,'wall');}
    });
    wallLayer.appendChild(ln);
    // Draw a small material pill near the midpoint when selected
    if(isSel){
      const mx=(px.x1+px.x2)/2,my=(px.y1+px.y2)/2;
      const bg=mk('rect');
      bg.setAttribute('x',mx-22);bg.setAttribute('y',my-9);
      bg.setAttribute('width',44);bg.setAttribute('height',18);
      bg.setAttribute('rx',9);bg.setAttribute('class','wall-lbl-bg');
      wallLayer.appendChild(bg);
      const lbl=mk('text');
      lbl.setAttribute('x',mx);lbl.setAttribute('y',my);
      lbl.setAttribute('class','wall-lbl');
      lbl.textContent=mat.label;
      wallLayer.appendChild(lbl);

      // Vertex handles — drag to reshape the wall endpoints in place.
      // Stored fractional coords mean we can update fx1/fy1 directly.
      const mkVert=(ex,ey,endpoint)=>{
        const v=mk('circle');
        v.setAttribute('cx',ex);v.setAttribute('cy',ey);v.setAttribute('r',6);
        v.setAttribute('class','wall-vert');
        v.dataset.wallId=w.id;v.dataset.endpoint=endpoint;
        v.style.pointerEvents='all';
        v.addEventListener('pointerdown',e=>{
          e.stopPropagation();
          wallVertDrag={wallId:w.id,endpoint};
          snapshot();
        });
        wallLayer.appendChild(v);
      };
      mkVert(px.x1,px.y1,'a');
      mkVert(px.x2,px.y2,'b');
    }
  });
  // Auto-detected wall candidates awaiting the user's accept/discard choice.
  if(_detectedWallPreview){
    const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
    for(const s of _detectedWallPreview){
      const ln=mk('line');
      ln.setAttribute('x1',s.fx1*w);ln.setAttribute('y1',s.fy1*h);
      ln.setAttribute('x2',s.fx2*w);ln.setAttribute('y2',s.fy2*h);
      ln.setAttribute('class','wall-line');
      ln.setAttribute('stroke','#1565c0');
      ln.setAttribute('stroke-width','2.5');
      ln.setAttribute('stroke-dasharray','6 4');
      ln.setAttribute('opacity','.85');
      wallLayer.appendChild(ln);
    }
  }
  renderWallPreview();
}

// ── Automatic wall detection ──────────────────────────────────────────────
// Rasterize the floor plan (downscaled), run the Hough-based detector, and
// preview the candidates as dashed blue lines behind a confirm dialog.
let _detectedWallPreview=null;
function detectWallsFromMap(){
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  if(!w||!h){toast('Upload a floor plan first');return;}
  toast('Detecting walls…');
  // Let the toast paint before the (CPU-bound) detection pass runs.
  setTimeout(()=>{
    try{
      const MAX=900;
      const k=Math.min(1,MAX/Math.max(w,h));
      const cw=Math.max(1,Math.round(w*k)),ch=Math.max(1,Math.round(h*k));
      const cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
      const ctx=cv.getContext('2d',{willReadFrequently:true});
      ctx.fillStyle='#fff';ctx.fillRect(0,0,cw,ch);   // flatten transparency
      ctx.drawImage(mapImg,0,0,cw,ch);
      const segs=detectWalls(ctx.getImageData(0,0,cw,ch));
      if(!segs.length){toast('No wall-like lines found — try the SVG/DXF import instead');return;}
      _detectedWallPreview=segs.map(s=>({fx1:s.x1/cw,fy1:s.y1/ch,fx2:s.x2/cw,fy2:s.y2/ch}));
      renderWalls();
      showModalText(
        {i18n:'modal.wall_detection'},
        `Found ${segs.length} straight wall candidates (previewed as dashed blue lines). Add them as drywall walls? You can re-material or delete individual walls afterwards.`,
        ()=>{
          snapshot();
          for(const s of _detectedWallPreview){
            WALLS().push({id:'w'+(++nid),...s,material:'drywall'});
          }
          const n=_detectedWallPreview.length;
          _detectedWallPreview=null;
          invalidateCoverageCache();
          render();renderList();calcCoverage();
          toast(`Added ${n} detected walls`);
        },
        ()=>{_detectedWallPreview=null;renderWalls();},
      );
    }catch(err){
      _detectedWallPreview=null;
      toast('Wall detection failed: '+(err&&err.message||err));
    }
  },30);
}

// Wall-vertex drag state — set when the user grabs an endpoint handle.
let wallVertDrag=null;

// Marquee multi-select: in select mode, click-drag on empty map starts a
// rectangle; on release, every item whose centre lies inside is selected.
// Shift-drag adds to the existing selection; plain drag replaces it.
let marqueeDrag=null;  // {startImg:{x,y}, addToExisting:bool}
function startMarquee(cx,cy,shift){
  const p=vpToImg(cx,cy);
  marqueeDrag={start:{x:p.x,y:p.y},end:{x:p.x,y:p.y},additive:!!shift};
  renderMarquee();
}
function updateMarquee(cx,cy){
  if(!marqueeDrag)return;
  const p=vpToImg(cx,cy);
  marqueeDrag.end={x:p.x,y:p.y};
  renderMarquee();
}
function renderMarquee(){
  marqueeLayer.innerHTML='';
  if(!marqueeDrag)return;
  const {start,end}=marqueeDrag;
  const x=Math.min(start.x,end.x),y=Math.min(start.y,end.y);
  const w=Math.abs(end.x-start.x),h=Math.abs(end.y-start.y);
  if(w<2&&h<2)return;
  const r=mk('rect');
  r.setAttribute('x',x);r.setAttribute('y',y);r.setAttribute('width',w);r.setAttribute('height',h);
  r.setAttribute('class','marquee-rect');
  marqueeLayer.appendChild(r);
}
function finishMarquee(){
  if(!marqueeDrag){marqueeLayer.innerHTML='';return;}
  const {start,end,additive}=marqueeDrag;
  marqueeDrag=null;marqueeLayer.innerHTML='';
  const imgW=mapImg.naturalWidth||1,imgH=mapImg.naturalHeight||1;
  const x0=Math.min(start.x,end.x),y0=Math.min(start.y,end.y);
  const x1=Math.max(start.x,end.x),y1=Math.max(start.y,end.y);
  const w=x1-x0,h=y1-y0;
  // Treat a near-zero drag as just a click — don't clobber selection.
  if(w<3&&h<3){renderRP();return;}
  const inside=(fx,fy)=>{
    const px=fx*imgW,py=fy*imgH;
    return px>=x0&&px<=x1&&py>=y0&&py<=y1;
  };
  if(!additive)selection.clear();
  for(const ap of APS()) if(inside(ap.fx,ap.fy))selection.add(_selKey(ap.id,'ap'));
  for(const sw of SWS()) if(inside(sw.fx,sw.fy))selection.add(_selKey(sw.id,'sw'));
  for(const c  of CAMS())if(inside(c.fx,c.fy)) selection.add(_selKey(c.id,'cam'));
  for(const dz of DZS()) if(inside(dz.fx,dz.fy))selection.add(_selKey(dz.id,'dz'));
  // Promote the first one we found as primary, so a properties panel renders.
  const first=selection.values().next().value;
  if(first){[selType,selId]=first.split(':');}else{selId=null;selType=null;}
  render();renderList();renderRP();
  if(selection.size>1)toast(`${selection.size} items selected`);
}

// Bulk-delete every currently selected item. Used by Delete/Backspace when
// the selection has more than one entry, and by a future right-click menu.
function deleteSelection(){
  if(!selection.size)return;
  snapshot();
  // Iterate over a snapshot so we can mutate the underlying arrays freely.
  const targets=Array.from(selection,k=>{const i=k.indexOf(':');return {type:k.slice(0,i),id:k.slice(i+1)};});
  for(const t of targets){
    const list=t.type==='ap'?APS():t.type==='dz'?DZS():t.type==='sw'?SWS():t.type==='cam'?CAMS():t.type==='wall'?WALLS():null;
    if(!list)continue;
    const idx=list.findIndex(x=>x.id===t.id);
    if(idx>=0)list.splice(idx,1);
  }
  clearSelection();
  invalidateCoverageCache();
  render();renderList();renderRP();calcCoverage();
  toast(`Deleted ${targets.length} item${targets.length===1?'':'s'}`);
}
function updateWallVertex(cx,cy){
  if(!wallVertDrag)return;
  const w=WALLS().find(x=>x.id===wallVertDrag.wallId);
  if(!w)return;
  const imgW=mapImg.naturalWidth||1,imgH=mapImg.naturalHeight||1;
  const p=vpToImg(cx,cy);
  const fx=Math.max(0,Math.min(1,p.x/imgW));
  const fy=Math.max(0,Math.min(1,p.y/imgH));
  if(wallVertDrag.endpoint==='a'){w.fx1=fx;w.fy1=fy;}
  else{w.fx2=fx;w.fy2=fy;}
  invalidateCoverageCache();
  render();
}
function renderWallPreview(){
  // Remove any existing preview line
  const prev=wallLayer.querySelector('.wall-preview');
  if(prev)prev.remove();
  if(!wallStart||!wallHover)return;
  const ln=mk('line');
  ln.setAttribute('x1',wallStart.x);ln.setAttribute('y1',wallStart.y);
  ln.setAttribute('x2',wallHover.x);ln.setAttribute('y2',wallHover.y);
  ln.setAttribute('class','wall-line wall-preview');
  ln.setAttribute('stroke-width','1.5');
  wallLayer.appendChild(ln);
}
function updateWallPreview(cx,cy,shift){
  if(mode!=='wall'||!wallStart)return;
  const img=vpToImg(cx,cy);
  let x=img.x,y=img.y;
  if(shift){
    // Constrain to nearest 45° multiple
    const dx=x-wallStart.x,dy=y-wallStart.y;
    const angle=Math.atan2(dy,dx);
    const snapped=Math.round(angle/(Math.PI/4))*(Math.PI/4);
    const len=Math.hypot(dx,dy);
    x=wallStart.x+Math.cos(snapped)*len;
    y=wallStart.y+Math.sin(snapped)*len;
  }
  wallHover={x,y};
  renderWallPreview();
}
function commitWall(x2,y2){
  if(!wallStart)return;
  // Avoid zero-length walls from accidental double-clicks
  if(Math.hypot(x2-wallStart.x,y2-wallStart.y)<3){wallStart=null;wallHover=null;renderWallPreview();return;}
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  snapshot();
  WALLS().push({
    id:'w'+(++nid),
    fx1:wallStart.x/w,fy1:wallStart.y/h,
    fx2:x2/w,        fy2:y2/h,
    material:'drywall',
  });
  wallStart=null;wallHover=null;
  invalidateCoverageCache();
  render();renderList();
  toast('Wall added — drywall by default');
}

// ═══ SELECTION ════════════════════════════════════
// Multi-selection: `selection` is the full set of {type:id} pairs the user
// has selected. `selId`/`selType` remain the "primary" / last-selected item
// (drives which properties panel renders). Clicking without Shift replaces
// the selection; Shift-clicking adds/removes.
const selection=new Set();
const _selKey=(id,type)=>type+':'+id;
function isSelected(id,type){return selection.has(_selKey(id,type));}
function clearSelection(){selection.clear();selId=null;selType=null;}
function addToSelection(id,type){selection.add(_selKey(id,type));selId=id;selType=type;}
function toggleSelection(id,type){
  const k=_selKey(id,type);
  if(selection.has(k)){
    selection.delete(k);
    if(selId===id&&selType===type){
      // Primary went away — promote whichever pair is still in the set, if any.
      const next=selection.values().next().value;
      if(next){[selType,selId]=next.split(':');}else{selId=null;selType=null;}
    }
  }else{
    addToSelection(id,type);
  }
  render();renderList();renderRP();
}

function sel(id,type,options){
  selection.clear();
  selection.add(_selKey(id,type));
  selId=id;selType=type;
  render();renderList();renderRP();
  // When selection came from a non-map source (list item, context menu from list),
  // ease the viewport so the item is centered & visible. The caller passes
  // {zoom:true} to request this. Direct map clicks leave the viewport alone.
  if(options&&options.zoom){zoomToItem(type,id);}
}

// Smoothly pan + zoom so the given item fills a comfortable portion of the viewport.
// Uses the same .smooth-zoom CSS transition the zoom buttons use.
function zoomToItem(type,id){
  const bounds=getItemBounds(type,id);
  if(!bounds)return;
  const va=viewport.getBoundingClientRect();
  if(!va.width||!va.height)return;
  // Target scale: fit the item into ~40% of the viewport (so there's generous padding).
  // Bounded to the same [.08, 8] that doZoom uses.
  const padding=0.4;
  const sx=va.width/(bounds.w/padding);
  const sy=va.height/(bounds.h/padding);
  const targetScale=Math.max(0.4, Math.min(4, Math.min(sx,sy)));
  // Target pan: put the item's center at the viewport center at the new scale.
  const centerX=bounds.x+bounds.w/2;
  const centerY=bounds.y+bounds.h/2;
  const targetPanX=va.width/2-centerX*targetScale;
  const targetPanY=va.height/2-centerY*targetScale;
  // Apply with transition
  canvas.classList.add('smooth-zoom');
  scale=targetScale;panX=targetPanX;panY=targetPanY;applyT();
  clearTimeout(smoothTimeout);
  smoothTimeout=setTimeout(()=>canvas.classList.remove('smooth-zoom'),220);
}
function desel(){selId=null;selType=null;renderRP();render();renderList();}

// ═══ DUPLICATE ════════════════════════════════════
function duplicateSelected(){
  if(selType!=='ap')return;
  const ap=APS().find(a=>a.id===selId);if(!ap)return;
  snapshot();
  const id='ap'+nid++;
  APS().push({...ap,id,name:ap.name+'-copy',fx:Math.min(1,ap.fx+0.05),fy:Math.min(1,ap.fy+0.05)});
  sel(id,'ap');render();renderList();calcCoverage();toast('AP duplicated');
}

// ═══ LOCK ═════════════════════════════════════════
function toggleLock(){
  if(!selId)return;
  if(selType==='ap'){const ap=APS().find(a=>a.id===selId);if(ap){ap.locked=!ap.locked;render();renderList();renderRP();}}
  else if(selType==='dz'){const dz=DZS().find(a=>a.id===selId);if(dz){dz.locked=!dz.locked;render();renderList();renderRP();}}
  else if(selType==='sw'){const sw=SWS().find(a=>a.id===selId);if(sw){sw.locked=!sw.locked;render();renderList();renderRP();}}
  else if(selType==='cam'){const c=CAMS().find(a=>a.id===selId);if(c){c.locked=!c.locked;render();renderList();renderRP();}}
}

// ═══ RENDER ═══════════════════════════════════════
function mk(tag){return document.createElementNS('http://www.w3.org/2000/svg',tag);}

function renderAPs(){
  apLayer.innerHTML='';
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  // If no image loaded yet, don't render APs at all — they'd land at (0,0)
  // as a phantom cluster.
  if(!w||!h)return;
  APS().forEach(ap=>{
    // Skip APs with invalid data rather than render a bogus circle at origin.
    if(!Number.isFinite(ap.fx)||!Number.isFinite(ap.fy)||!Number.isFinite(ap.r)||ap.r<=0){
      console.warn('Skipping AP with invalid coords:',ap);
      return;
    }
    const cx=ap.fx*w,cy=ap.fy*h,r=ap.r,isSel=isSelected(ap.id,'ap');
    const ls=Math.max(8,Math.min(14,r*.17));
    const g=mk('g');g.setAttribute('class','ap-grp');g.dataset.id=ap.id;g.style.pointerEvents='all';
    if(ap.locked)g.style.opacity='.7';
    if(statusDimmed(ap))g.style.opacity='.15';

    const hasWalls=WALLS().length>0;
    // Per-AP color (empty string = use default ink — no override). When "colour
    // by VLAN" is on, an unstyled AP inherits its VLAN's colour.
    const apColor=ap.color||(SETTINGS.colorByVlan?vlanColor(ap.vlan):'')||'';
    // User-controlled coverage opacity (Settings → Coverage opacity).
    // 100 = full strength; values below 100 fade the ring fill+stroke.
    const covOp=Math.max(0,Math.min(1,(SETTINGS.coverageOpacity??100)/100));
    // Outer coverage: wall-clipped path if walls exist, else simple circle
    let ro;
    if(hasWalls){
      ro=mk('path');
      ro.setAttribute('d',getCoveragePath(ap));
    }else{
      ro=mk('circle');ro.setAttribute('cx',cx);ro.setAttribute('cy',cy);ro.setAttribute('r',r);
    }
    ro.setAttribute('class',isSel?'ap-sel-outer':ap.sig==='medium'?'ap-outer-m':ap.sig==='weak'?'ap-outer-w':'ap-outer');
    if(apColor){
      // Override the ink-black defaults with the AP's color. We keep the fill
      // transparent-ish (8% alpha) so overlapping coverage areas still mix visually.
      ro.style.stroke=apColor;
      ro.style.fill=hexToRgba(apColor,.08);
    }
    if(covOp<1)ro.setAttribute('opacity',covOp);
    // Only animate the spin when we're showing a plain circle — spinning a
    // polygon looks wrong because its shape is directional.
    if(!hasWalls){ro.style.transformOrigin=`${cx}px ${cy}px`;ro.style.animation='spin 20s linear infinite';}

    // Inner ring: same trick but at 54% radius. Compute a second path with
    // a temporarily smaller r so we reuse computeCoveragePath.
    let ri;
    if(hasWalls){
      ri=mk('path');
      ri.setAttribute('d',getInnerCoveragePath(ap));
    }else{
      ri=mk('circle');ri.setAttribute('cx',cx);ri.setAttribute('cy',cy);ri.setAttribute('r',r*.54);
    }
    ri.setAttribute('class',isSel?'ap-sel-inner':ap.sig==='medium'?'ap-inner-m':ap.sig==='weak'?'ap-inner-w':'ap-inner');
    if(apColor){
      ri.style.stroke=apColor;
      ri.style.fill=hexToRgba(apColor,.12);
    }
    if(covOp<1)ri.setAttribute('opacity',covOp);

    const dot=mk('circle');dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);dot.setAttribute('r',7);
    dot.setAttribute('class',isSel?'ap-sel-dot':'ap-dot');dot.setAttribute('filter','url(#gf)');
    dot.style.animation='pulse 2.2s ease-in-out infinite';
    if(apColor)dot.style.fill=apColor;

    // On-map label: just the AP name. Model + all other technical details are
    // visible in the right-side properties panel when an AP is selected.
    const lbl=mk('text');lbl.setAttribute('x',cx);lbl.setAttribute('y',cy);
    lbl.setAttribute('class',isSel?'ap-lbl-sel':'ap-lbl');lbl.setAttribute('font-size',ls);lbl.textContent=ap.name;
    if(apColor)lbl.style.fill=apColor;

    // Notes dot
    if(ap.notes&&ap.notes.trim()){
      const nd=mk('circle');nd.setAttribute('cx',cx+r*.22);nd.setAttribute('cy',cy-r*.22);
      nd.setAttribute('r',Math.max(3,ls*.38));nd.setAttribute('fill',isSel?tInk():tInk(.55));nd.setAttribute('opacity','.85');
      g.appendChild(nd);
    }
    // Locked APs are indicated in the left sidebar list (🔒 next to name) and
    // in the properties panel — no on-map icon, since it clutters the map.

    // Range is edited via the properties panel slider only — no on-map handle.

    // The coverage rings (outer + inner, including the selection-highlighted
    // versions) are part of the coverage visualization — they hide when the
    // user toggles coverage off. The center dot stays because it's the AP
    // marker itself, not a coverage indicator.
    const parts=[dot,lbl];
    if(showCoverage){parts.unshift(ro,ri);}
    parts.forEach(el=>g.appendChild(el));
    g.addEventListener('pointerdown',e=>{
      if(e.target.dataset.resize)return;
      e.stopPropagation();
      if(e.shiftKey&&mode==='sel'){toggleSelection(ap.id,'ap');return;}
      sel(ap.id,'ap');
      if(!ap.locked){const img=vpToImg(e.clientX,e.clientY);dragOffX=ap.fx*w-img.x;dragOffY=ap.fy*h-img.y;dragId=ap.id;dragType='ap';_dragInitialFx=ap.fx;_dragInitialFy=ap.fy;startApStick(ap.id);}
    });
    apLayer.appendChild(g);
  });
}

function renderDZs(){
  dzLayer.innerHTML='';
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  if(!w||!h)return;
  DZS().forEach(dz=>{
    if(!Number.isFinite(dz.fx)||!Number.isFinite(dz.fy)||!Number.isFinite(dz.r)||dz.r<=0)return;
    const cx=dz.fx*w,cy=dz.fy*h,isSel=isSelected(dz.id,'dz');
    const g=mk('g');g.setAttribute('class','dz-grp');g.dataset.id=dz.id;g.style.pointerEvents='all';
    const pulse=mk('circle');pulse.setAttribute('cx',cx);pulse.setAttribute('cy',cy);pulse.setAttribute('r',dz.r);
    pulse.setAttribute('class','dz-pulse');pulse.style.transformOrigin=`${cx}px ${cy}px`;pulse.style.animation='dzs 8s linear infinite';
    if(isSel){pulse.style.stroke=tInk();pulse.style.strokeWidth='2.5';pulse.style.fill=tInk(.1);}
    const icon=mk('text');icon.setAttribute('x',cx);icon.setAttribute('y',cy);icon.setAttribute('text-anchor','middle');icon.setAttribute('dominant-baseline','central');icon.setAttribute('font-size','18');icon.setAttribute('fill',tInk());icon.textContent='⚠';
    const lbl=mk('text');lbl.setAttribute('x',cx);lbl.setAttribute('y',cy+dz.r+11);lbl.setAttribute('text-anchor','middle');lbl.setAttribute('font-size','10');lbl.setAttribute('font-family','Rajdhani,sans-serif');lbl.setAttribute('font-weight','700');lbl.setAttribute('letter-spacing','.1em');lbl.setAttribute('fill',tInk());lbl.setAttribute('paint-order','stroke');lbl.setAttribute('stroke',tBg());lbl.setAttribute('stroke-width','3');lbl.textContent=(dz.label||'').toUpperCase();
    if(isSel&&!dz.locked){const rh=mk('circle');rh.setAttribute('cx',cx+dz.r);rh.setAttribute('cy',cy);rh.setAttribute('r',8);rh.setAttribute('class','rh-sel');rh.dataset.resizeDz=dz.id;rh.style.pointerEvents='all';rh.addEventListener('pointerdown',e=>{e.stopPropagation();resId=dz.id;resizeStartX=e.clientX;resizeStartR=dz.r;});g.appendChild(rh);}
    [pulse,icon,lbl].forEach(el=>g.appendChild(el));
    g.addEventListener('pointerdown',e=>{e.stopPropagation();if(e.shiftKey&&mode==='sel'){toggleSelection(dz.id,'dz');return;}sel(dz.id,'dz');if(!dz.locked){const img=vpToImg(e.clientX,e.clientY);dragOffX=dz.fx*w-img.x;dragOffY=dz.fy*h-img.y;dragId=dz.id;dragType='dz';_dragInitialFx=dz.fx;_dragInitialFy=dz.fy;}});
    dzLayer.appendChild(g);
  });
}

// Cable runs: a thin line from each AP/camera to its assigned switch.
// Visualizes PoE wiring and helps spot long runs at a glance. See the PoE
// panel (Show PoE button) for budget summaries per switch.
let showCables=false;
function renderCables(){
  cableLayer.innerHTML='';
  if(!showCables)return;
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  if(!w||!h)return;
  const drawCable=(dev,sw)=>{
    const dx=dev.fx*w,dy=dev.fy*h,sx=sw.fx*w,sy=sw.fy*h;
    const ln=mk('line');
    ln.setAttribute('x1',dx);ln.setAttribute('y1',dy);
    ln.setAttribute('x2',sx);ln.setAttribute('y2',sy);
    ln.setAttribute('class','cable-line');
    cableLayer.appendChild(ln);
    // Length label at midpoint (includes the routing factor for a realistic run)
    const lenPx=Math.hypot(sx-dx,sy-dy);
    const lenM=(lenPx*(scaleM/100)*routingFactor()).toFixed(1);
    if(lenPx*scale>40){
      const mx=(dx+sx)/2,my=(dy+sy)/2;
      const txt=mk('text');
      txt.setAttribute('x',mx);txt.setAttribute('y',my-3);
      txt.setAttribute('class','cable-lbl');
      txt.textContent=lenM+' m';
      const lm=parseFloat(lenM);
      if(lm>100)txt.classList.add('cable-lbl-warn');        // over Ethernet limit
      else if(lm>90)txt.classList.add('cable-lbl-near');    // approaching limit
      cableLayer.appendChild(txt);
    }
  };
  APS().forEach(ap=>{
    if(!ap.swId)return;
    const sw=SWS().find(s=>s.id===ap.swId);
    if(sw)drawCable(ap,sw);
  });
  CAMS().forEach(c=>{
    if(!c.swId)return;
    const sw=SWS().find(s=>s.id===c.swId);
    if(sw)drawCable(c,sw);
  });
  // Switch → uplink backbone links — thicker/solid so they read as trunks
  // distinct from the dashed device runs.
  SWS().forEach(sw=>{
    if(!sw.uplinkId||sw.uplinkId===sw.id)return;
    const up=SWS().find(s=>s.id===sw.uplinkId);
    const x=sw.fx*w,y=sw.fy*h;
    if(up){
      const ln=mk('line');
      ln.setAttribute('x1',x);ln.setAttribute('y1',y);
      ln.setAttribute('x2',up.fx*w);ln.setAttribute('y2',up.fy*h);
      ln.setAttribute('class','uplink-line');
      cableLayer.appendChild(ln);
    }else{
      // Uplink is on another floor — draw a short riser stub + label.
      const tgt=findSwitchAnywhere(sw.uplinkId);
      if(!tgt)return;
      const ln=mk('line');
      ln.setAttribute('x1',x);ln.setAttribute('y1',y);
      ln.setAttribute('x2',x);ln.setAttribute('y2',y-26);
      ln.setAttribute('class','uplink-line');ln.setAttribute('stroke-dasharray','3 3');
      cableLayer.appendChild(ln);
      const txt=mk('text');
      txt.setAttribute('x',x);txt.setAttribute('y',y-30);
      txt.setAttribute('class','cable-lbl');txt.style.fill='#6a1b9a';
      txt.textContent='↑ '+(tgt.sw.name||'')+' · '+(tgt.floor.name||('Floor '+(tgt.floorIdx+1)));
      cableLayer.appendChild(txt);
    }
  });
}

// Cameras render as a triangular "field-of-view" cone (the visible area the
// camera can see) plus a small lens marker at the position. Heading rotates
// the cone around the position. 360° fisheye cameras get a ring instead.
// Wedge (or full-circle) path for a camera's view area.
function _camWedgePath(cx,cy,r,heading,fov){
  if(fov>=350)return null;   // caller draws a <circle> instead
  const half=fov/2;
  const a1=(heading-half)*Math.PI/180;
  const a2=(heading+half)*Math.PI/180;
  const x1=cx+Math.cos(a1)*r, y1=cy+Math.sin(a1)*r;
  const x2=cx+Math.cos(a2)*r, y2=cy+Math.sin(a2)*r;
  const largeArc=fov>180?1:0;
  return `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`;
}
function renderCAMs(){
  camLayer.innerHTML='';
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  if(!w||!h)return;
  CAMS().forEach(c=>{
    if(!Number.isFinite(c.fx)||!Number.isFinite(c.fy))return;
    const cx=c.fx*w,cy=c.fy*h;
    const isSel=isSelected(c.id,'cam');
    const range=c.range||80;
    const fov=Math.max(10,Math.min(360,c.fov||80));
    const heading=c.heading||0;
    const color=c.color||(SETTINGS.colorByVlan&&vlanColor(c.vlan))||tInk();
    const fillRgba=c.color?hexToRgba(c.color,.12):tInk(.08);
    const g=mk('g');g.setAttribute('class','cam-grp');g.dataset.id=c.id;g.style.pointerEvents='all';
    if(c.locked)g.style.opacity='.7';
    if(statusDimmed(c))g.style.opacity='.15';

    // Cone path (or full circle for fisheye / 360°).
    let cone;
    if(fov>=350){
      cone=mk('circle');
      cone.setAttribute('cx',cx);cone.setAttribute('cy',cy);cone.setAttribute('r',range);
    }else{
      const half=fov/2;
      const a1=(heading-half)*Math.PI/180;
      const a2=(heading+half)*Math.PI/180;
      const x1=cx+Math.cos(a1)*range, y1=cy+Math.sin(a1)*range;
      const x2=cx+Math.cos(a2)*range, y2=cy+Math.sin(a2)*range;
      const largeArc=fov>180?1:0;
      cone=mk('path');
      cone.setAttribute('d',`M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${range},${range} 0 ${largeArc} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`);
    }
    cone.setAttribute('class','cam-cone'+(isSel?' cam-cone-sel':''));
    cone.style.fill=fillRgba;
    cone.style.stroke=color;
    if(statusDimmed(c))cone.setAttribute('opacity','.15');
    camLayer.appendChild(cone);

    // DORI pixel-density bands (IEC 62676-4). Stacked translucent wedges,
    // strongest tier innermost — the compounded tint reads as a gradient of
    // "how much detail you actually get" inside the raw view cone.
    if(SETTINGS.showDori!==false && Number.isFinite(scaleM) && scaleM>0 && !statusDimmed(c)){
      const mpp=scaleM/100;
      const bands=doriDistancesM(c.resolution||'4K',fov);
      for(const b of bands){
        const rPx=b.m/mpp;
        if(!(rPx>0)||rPx>=range)continue;   // tier reaches past the cone — no ring to draw
        let el;
        if(fov>=350){
          el=mk('circle');
          el.setAttribute('cx',cx);el.setAttribute('cy',cy);el.setAttribute('r',rPx);
        }else{
          el=mk('path');
          el.setAttribute('d',_camWedgePath(cx,cy,rPx,heading,fov));
        }
        el.setAttribute('fill',b.color);
        el.setAttribute('fill-opacity','.10');
        el.setAttribute('stroke',b.color);
        el.setAttribute('stroke-opacity','.55');
        el.setAttribute('stroke-width','1');
        el.style.pointerEvents='none';
        camLayer.appendChild(el);
      }
    }

    // Lens marker at position.
    const lens=mk('circle');
    lens.setAttribute('cx',cx);lens.setAttribute('cy',cy);lens.setAttribute('r',6);
    lens.setAttribute('class','cam-lens'+(isSel?' cam-lens-sel':''));
    lens.style.fill=color;
    camLayer.appendChild(lens);
    const inner=mk('circle');
    inner.setAttribute('cx',cx);inner.setAttribute('cy',cy);inner.setAttribute('r',2.5);
    inner.style.fill=tBg();
    inner.style.pointerEvents='none';
    camLayer.appendChild(inner);

    // Heading nub — small marker on the cone's centre line so the camera's
    // forward direction is unambiguous even when the FoV is wide.
    if(fov<350){
      const a=heading*Math.PI/180;
      const tipX=cx+Math.cos(a)*Math.min(range,18);
      const tipY=cy+Math.sin(a)*Math.min(range,18);
      const tip=mk('line');
      tip.setAttribute('x1',cx);tip.setAttribute('y1',cy);
      tip.setAttribute('x2',tipX);tip.setAttribute('y2',tipY);
      tip.setAttribute('class','cam-heading');
      tip.style.stroke=color;
      camLayer.appendChild(tip);
    }

    // Label below the lens.
    const lbl=mk('text');
    lbl.setAttribute('x',cx);lbl.setAttribute('y',cy+14);
    lbl.setAttribute('class','cam-lbl');
    lbl.style.fill=color;
    lbl.textContent=(c.name||'').toUpperCase();
    camLayer.appendChild(lbl);

    g.appendChild(cone);g.appendChild(lens);g.appendChild(inner);g.appendChild(lbl);

    // The group itself isn't appended (we already appended children directly
    // into camLayer). Attach pointer handlers to the lens — it's the obvious
    // hit target. Cone is non-interactive on its own.
    lens.style.cursor='pointer';
    lens.addEventListener('pointerdown',e=>{
      e.stopPropagation();
      if(e.shiftKey&&mode==='sel'){toggleSelection(c.id,'cam');return;}
      sel(c.id,'cam');
      if(!c.locked){
        const img=vpToImg(e.clientX,e.clientY);
        dragOffX=c.fx*w-img.x;dragOffY=c.fy*h-img.y;
        dragId=c.id;dragType='cam';
        _dragInitialFx=c.fx;_dragInitialFy=c.fy;
      }
    });
  });
}

function renderSWs(){
  swLayer.innerHTML='';
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  if(!w||!h)return;
  SWS().forEach(sw=>{
    if(!Number.isFinite(sw.fx)||!Number.isFinite(sw.fy))return;
    const cx=sw.fx*w,cy=sw.fy*h,isSel=isSelected(sw.id,'sw');
    const g=mk('g');g.setAttribute('class','sw-grp');g.dataset.id=sw.id;g.style.pointerEvents='all';
    if(statusDimmed(sw))g.style.opacity='.15';
    const sz=sw.size||22;
    // Box and icon sizes scale with sz so a bigger switch reads as a bigger icon, not just a bigger empty box.
    const iconFs=Math.max(8,sz*.65);
    const lblFs=Math.max(7,sz*.42);
    const box=mk('rect');box.setAttribute('x',cx-sz);box.setAttribute('y',cy-sz*.6);
    box.setAttribute('width',sz*2);box.setAttribute('height',sz*1.2);box.setAttribute('rx',2);
    box.setAttribute('fill',isSel?tInk(.1):tInk(.04));
    box.setAttribute('stroke',tInk());box.setAttribute('stroke-width',isSel?'2':'1.2');
    const icon=mk('text');icon.setAttribute('x',cx);icon.setAttribute('y',cy);icon.setAttribute('text-anchor','middle');icon.setAttribute('dominant-baseline','central');icon.setAttribute('font-size',iconFs);icon.setAttribute('fill',tInk());icon.textContent='⊞';
    const lbl=mk('text');lbl.setAttribute('x',cx);lbl.setAttribute('y',cy+sz*.9);lbl.setAttribute('text-anchor','middle');lbl.setAttribute('font-size',lblFs);lbl.setAttribute('font-family','Rajdhani,sans-serif');lbl.setAttribute('font-weight','700');lbl.setAttribute('letter-spacing','.08em');lbl.setAttribute('fill',tInk());lbl.setAttribute('paint-order','stroke');lbl.setAttribute('stroke',tBg());lbl.setAttribute('stroke-width','2.5');lbl.textContent=(sw.name||'').toUpperCase();
    [box,icon,lbl].forEach(el=>g.appendChild(el));
    g.addEventListener('pointerdown',e=>{
      e.stopPropagation();
      if(e.shiftKey&&mode==='sel'){toggleSelection(sw.id,'sw');return;}
      sel(sw.id,'sw');
      if(!sw.locked){const img=vpToImg(e.clientX,e.clientY);dragOffX=sw.fx*w-img.x;dragOffY=sw.fy*h-img.y;dragId=sw.id;dragType='sw';_dragInitialFx=sw.fx;_dragInitialFy=sw.fy;}
    });
    swLayer.appendChild(g);
  });
}

// ═══ CHANNEL OVERLAP ══════════════════════════════
// Visually flag APs that share or overlap their RF channels AND whose
// coverage circles touch. Two channels overlap if:
//   - They're the same number on any band
//   - Both are 2.4 GHz channels within 4 of each other (22 MHz wide,
//     5 MHz apart — so 1&5 are the boundary case)
// Channels parsed loosely: "6", "ch6", "auto" → numeric or "auto".
function _parseChannel(c){
  if(!c||c==='auto')return null;
  const m=String(c).match(/(\d+)/);
  return m?parseInt(m[1],10):null;
}
function _is24Channel(n){return Number.isInteger(n)&&n>=1&&n<=14;}
function chanOverlap(a,b){
  const ai=_parseChannel(a),bi=_parseChannel(b);
  if(ai==null||bi==null)return false;
  if(ai===bi)return true;
  if(_is24Channel(ai)&&_is24Channel(bi)&&Math.abs(ai-bi)<5)return true;
  return false;
}
// Width- and band-aware overlap between two APs: do their occupied frequency
// ranges intersect? Falls back to the legacy channel-number heuristic when
// either channel is 'auto'/unparsable.
function apChansOverlap(a,b){
  const ai=_parseChannel(a.channel),bi=_parseChannel(b.channel);
  if(ai==null||bi==null)return false;
  return channelsOverlapMhz(bandKey(a.freq),ai,a.chanWidth||20,bandKey(b.freq),bi,b.chanWidth||20);
}
function renderChannelOverlap(){
  chOverlapLayer.innerHTML='';
  const w=mapImg.naturalWidth,h=mapImg.naturalHeight;
  if(!w||!h)return;
  const aps=APS();
  for(let i=0;i<aps.length;i++)for(let j=i+1;j<aps.length;j++){
    const a=aps[i],b=aps[j];
    if(!apChansOverlap(a,b))continue;
    const ax=a.fx*w,ay=a.fy*h,bx=b.fx*w,by=b.fy*h;
    const dist=Math.hypot(ax-bx,ay-by);
    // Only flag pairs whose coverage areas overlap — otherwise interference
    // is not really a concern, just a coincidental channel match.
    if(dist>=(a.r+b.r)*0.9)continue;
    const ln=mk('line');
    ln.setAttribute('x1',ax);ln.setAttribute('y1',ay);
    ln.setAttribute('x2',bx);ln.setAttribute('y2',by);
    ln.setAttribute('class','ch-overlap-line');
    chOverlapLayer.appendChild(ln);
    const mx=(ax+bx)/2,my=(ay+by)/2;
    const bg=mk('rect');
    bg.setAttribute('x',mx-26);bg.setAttribute('y',my-10);
    bg.setAttribute('width',52);bg.setAttribute('height',20);
    bg.setAttribute('rx',10);bg.setAttribute('class','ch-overlap-bg');
    chOverlapLayer.appendChild(bg);
    const txt=mk('text');
    txt.setAttribute('x',mx);txt.setAttribute('y',my);
    txt.setAttribute('class','ch-overlap-lbl');
    const labelA=a.channel==='auto'||!a.channel?'?':a.channel;
    const labelB=b.channel==='auto'||!b.channel?'?':b.channel;
    txt.textContent=labelA===labelB?`⚡ Ch ${labelA}`:`⚡ ${labelA}↔${labelB}`;
    chOverlapLayer.appendChild(txt);
  }
}

function renderOL(){
  olLayer.innerHTML='';if(!showOL)return;
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  for(let i=0;i<APS().length;i++)for(let j=i+1;j<APS().length;j++){
    const a=APS()[i],b=APS()[j];
    const ax=a.fx*w,ay=a.fy*h,bx=b.fx*w,by=b.fy*h;
    const dist=Math.hypot(ax-bx,ay-by);
    if(dist<a.r+b.r){const c=mk('circle');c.setAttribute('cx',(ax+bx)/2);c.setAttribute('cy',(ay+by)/2);c.setAttribute('r',Math.max(8,(a.r+b.r-dist)*.42));c.setAttribute('class','ol-zone');olLayer.appendChild(c);}
  }
}

// Per-pixel signal-strength heatmap. We paint to an offscreen canvas at a
// coarse grid resolution, shading each cell by the strongest contributor at
// that point. v3 supports four metric modes (RSSI / SNR / MCS / Throughput)
// + a band filter + neighbouring-floor leakage through slabs.

function _heatColor(dbm){
  // Legacy single-mode helper retained for code paths that still call it.
  if(dbm===null||dbm===undefined||!Number.isFinite(dbm))return null;
  for(const s of HEATMAP_STOPS){if(dbm>=s.dbm)return s.color;}
  return null;
}
function _heatColorFor(mode,value){
  if(value===null||value===undefined||!Number.isFinite(value))return null;
  const stops=(HEATMAP_MODES[mode]||HEATMAP_MODES.rssi).stops;
  for(const s of stops){if(value>=s.v)return s.color;}
  return null;
}
function cycleHeatmapMode(){
  const keys=HEATMAP_MODE_KEYS;
  const cur=SETTINGS.heatmapMode||'rssi';
  const i=keys.indexOf(cur);
  SETTINGS.heatmapMode=keys[(i+1)%keys.length];
  const lbl=(HEATMAP_MODES[SETTINGS.heatmapMode]||HEATMAP_MODES.rssi).label;
  const pill=document.getElementById('heat-mode-pill');
  if(pill)localizeText(pill,'heat.metric_'+SETTINGS.heatmapMode);
  render();autosave();
  toast('Heatmap mode: '+lbl);
}
function cycleHeatmapBand(){
  const cur=SETTINGS.heatmapBand||'all';
  const order=['all','2.4','5','6'];
  const i=order.indexOf(cur);
  SETTINGS.heatmapBand=order[(i+1)%order.length];
  const pill=document.getElementById('heat-band-pill');
  if(pill)localizeText(pill,({'all':'heat.all','2.4':'heat.band_24','5':'heat.band_5','6':'heat.band_6'})[SETTINGS.heatmapBand]);
  render();autosave();
  toast('Heatmap band: '+SETTINGS.heatmapBand);
}
function _bandMatches(ap,bandFilter){
  if(bandFilter==='all'||!bandFilter)return true;
  const f=ap.freq||'';
  if(bandFilter==='2.4')return f.indexOf('2.4')>=0;
  if(bandFilter==='5')  return f==='5 GHz only'||f==='2.4 / 5 GHz';
  if(bandFilter==='6')  return f.indexOf('6 GHz')>=0;
  return true;
}
// Serialize an AP into the plain shape the heatmap job needs (structured-
// cloneable for the worker; no DOM objects, no cache fields).
function _heatApShape(ap){
  const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
  return {
    fx:ap.fx,fy:ap.fy,r:ap.r,freq:ap.freq,
    band:bandKey(ap.freq),
    channel:_parseChannel(ap.channel),
    widthMhz:CHANNEL_WIDTHS.includes(ap.chanWidth)?ap.chanWidth:20,
    arcDeg:pat.arc,headingDeg:ap.heading||0,
    eirpDbm:effectiveEirp(ap),
    bandFactor:bandLossMultiplier(ap.freq),
  };
}
// Build the current floor's heatmap job, or null when there's nothing to paint.
function _heatJob(){
  const w=mapImg.naturalWidth||0,h=mapImg.naturalHeight||0;
  if(!w||!h)return null;
  const mode=SETTINGS.heatmapMode||'rssi';
  const modeDef=HEATMAP_MODES[mode]||HEATMAP_MODES.rssi;
  const bandFilter=SETTINGS.heatmapBand||'all';
  const aps=APS().filter(ap=>_bandMatches(ap,bandFilter)).map(_heatApShape);
  const neighbour=[];
  if(SETTINGS.showFloorLeakage){
    if(curFloor-1>=0)for(const ap of (FLOORS[curFloor-1].APS||[]))if(_bandMatches(ap,bandFilter))neighbour.push(_heatApShape(ap));
    if(curFloor+1<FLOORS.length)for(const ap of (FLOORS[curFloor+1].APS||[]))if(_bandMatches(ap,bandFilter))neighbour.push(_heatApShape(ap));
  }
  if(!aps.length&&!neighbour.length)return null;
  return {
    w,h,
    step:Math.max(4,Math.round(Math.min(w,h)/120)),
    metric:modeDef.metric,
    aps,neighbour,
    walls:WALLS().map(wl=>({fx1:wl.fx1,fy1:wl.fy1,fx2:wl.fx2,fy2:wl.fy2,material:wl.material})),
    propModel:SETTINGS.propagationModel||'logd',
    slabDb:Number.isFinite(SETTINGS.floorSlabAttenDb)?SETTINGS.floorSlabAttenDb:DEFAULT_FLOOR_SLAB_DB,
    noiseFloorDbm:Number.isFinite(SETTINGS.noiseFloorDbm)?SETTINGS.noiseFloorDbm:-95,
    metersPerPx:(scaleM||100)/100,
    // Worker only compares thresholds; colours stay on this side.
    stops:modeDef.stops.map(s=>({v:s.v})),
  };
}
let _heatWorker=null,_heatWorkerBroken=false,_heatJobId=0,_heatJobColors=null,_heatJobMeta=null;
function _getHeatWorker(){
  if(_heatWorkerBroken)return null;
  if(!_heatWorker){
    try{
      _heatWorker=new HeatWorker();
      _heatWorker.onmessage=e=>_paintHeatResult(e.data);
      // A worker-level error (e.g. CSP or bundling edge case): fall back to
      // synchronous rendering for the rest of the session.
      _heatWorker.onerror=()=>{
        _heatWorkerBroken=true;
        try{_heatWorker.terminate();}catch(_){/* already dead */}
        _heatWorker=null;
        renderHeat();
      };
    }catch(_){_heatWorkerBroken=true;_heatWorker=null;}
  }
  return _heatWorker;
}
function _paintHeatGrid(grid,cols,rows,step,colors){
  const ctx=heatCanvas.getContext('2d');
  ctx.clearRect(0,0,heatCanvas.width,heatCanvas.height);
  for(let gy=0;gy<rows;gy++){
    for(let gx=0;gx<cols;gx++){
      const idx=grid[gy*cols+gx];
      if(idx<0)continue;
      ctx.fillStyle=colors[idx];
      ctx.fillRect(gx*step,gy*step,step,step);
    }
  }
}
function _paintHeatResult(msg){
  if(msg.jobId!==_heatJobId)return;   // stale — a newer job superseded it
  if(msg.error){_heatWorkerBroken=true;renderHeat();return;}
  if(!showHeat||!_heatJobColors)return;
  _paintHeatGrid(new Int16Array(msg.buf),msg.cols,msg.rows,msg.step,_heatJobColors);
}
function renderHeat(){
  heatLayer.innerHTML='';
  _heatJobId++;                       // invalidate any in-flight worker job
  if(!showHeat||!heatCanvas){heatCanvas.style.display='none';return;}
  const job=_heatJob();
  const w=mapImg.naturalWidth||0,h=mapImg.naturalHeight||0;
  if(!job){
    if(w&&h){heatCanvas.width=w;heatCanvas.height=h;}
    heatCanvas.style.display='none';
    return;
  }
  if(heatCanvas.width!==w)heatCanvas.width=w;
  if(heatCanvas.height!==h)heatCanvas.height=h;
  heatCanvas.style.width=w+'px';heatCanvas.style.height=h+'px';
  heatCanvas.style.display='block';
  const mode=SETTINGS.heatmapMode||'rssi';
  _heatJobColors=(HEATMAP_MODES[mode]||HEATMAP_MODES.rssi).stops.map(s=>s.color);
  const wk=_getHeatWorker();
  if(wk){
    job.jobId=_heatJobId;
    wk.postMessage(job);              // paint happens in _paintHeatResult
  }else{
    const {grid,cols,rows}=computeHeatGrid(job);
    _paintHeatGrid(grid,cols,rows,job.step,_heatJobColors);
  }
}

// Roaming overlap layer. Tints cells where ≥2 APs deliver ≥ ROAMING_OVERLAP_DBM
// signal. Same canvas as the heatmap is unsuitable (different colour role), so
// we use a dedicated SVG group with semi-transparent rects.
function renderRoaming(){
  const layer=document.getElementById('roaming-layer');
  if(!layer)return;
  layer.innerHTML='';
  if(!SETTINGS.showRoamingOverlap)return;
  const w=mapImg.naturalWidth||0,h=mapImg.naturalHeight||0;
  if(!w||!h)return;
  const aps=APS();
  if(aps.length<2)return;
  const walls=WALLS();
  const propModel=SETTINGS.propagationModel||'logd';
  const step=Math.max(6,Math.round(Math.min(w,h)/80));
  // Render into a path of overlapping rects so the DOM stays small.
  let d='';
  for(let y=0;y<h;y+=step){
    for(let x=0;x<w;x+=step){
      let n=0;
      for(const ap of aps){
        const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
        const dbm=dbmAt(ap,x,y,w,h,walls,{
          bandFactor:bandLossMultiplier(ap.freq),
          arcDeg:pat.arc,headingDeg:ap.heading||0,
          eirpDbm:effectiveEirp(ap),
          model:propModel,
          metersPerPx:(scaleM||100)/100,
        });
        if(dbm!==null && dbm>=ROAMING_OVERLAP_DBM){n++;if(n>=2)break;}
      }
      if(n>=2) d+=`M${x},${y}h${step}v${step}h${-step}Z`;
    }
  }
  if(!d)return;
  const path=mk('path');
  path.setAttribute('d',d);
  path.setAttribute('class','roaming-fill');
  layer.appendChild(path);
}

// Annotation layer. Text labels and arrows live in floor.ANNOS.
function renderAnnotations(){
  const layer=document.getElementById('anno-layer');
  if(!layer)return;
  layer.innerHTML='';
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  for(const a of ANNOS()){
    const x=(a.fx||0)*w, y=(a.fy||0)*h;
    if(a.kind==='arrow'||a.kind==='dim'){
      const x2=(a.fx2||a.fx||0)*w, y2=(a.fy2||a.fy||0)*h;
      const ln=mk('line');
      ln.setAttribute('x1',x);ln.setAttribute('y1',y);
      ln.setAttribute('x2',x2);ln.setAttribute('y2',y2);
      ln.setAttribute('class', a.kind==='dim' ? 'anno-dim' : 'anno-arrow');
      ln.setAttribute('marker-end','url(#anno-arrowhead)');
      layer.appendChild(ln);
      if(a.kind==='dim'){
        // Show distance label at the midpoint
        const mx=(x+x2)/2, my=(y+y2)/2;
        const dist=Math.hypot(x-x2,y-y2);
        const m=Math.round(dist*(scaleM||100)/100*10)/10;
        const lbl=mk('text');
        lbl.setAttribute('x',mx);lbl.setAttribute('y',my-6);
        lbl.setAttribute('class','anno-dim-label');
        lbl.textContent=m+' m';
        layer.appendChild(lbl);
      }
      if(a.text){
        const lbl=mk('text');
        lbl.setAttribute('x',x);lbl.setAttribute('y',y-10);
        lbl.setAttribute('class','anno-text');
        lbl.textContent=a.text;
        layer.appendChild(lbl);
      }
    } else {
      const lbl=mk('text');
      lbl.setAttribute('x',x);lbl.setAttribute('y',y);
      lbl.setAttribute('class','anno-text');
      lbl.textContent=a.text||'Note';
      layer.appendChild(lbl);
    }
  }
}

// Survey-sample layer. Each sample is a small circle coloured by its RSSI,
// with a thin outline that turns red when the measured value is materially
// stronger or weaker than the predicted value at that point.
function renderSamples(){
  const layer=document.getElementById('sample-layer');
  if(!layer)return;
  layer.innerHTML='';
  const samples=SAMPLES();
  if(!samples.length)return;
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  const walls=WALLS();
  const propModel=SETTINGS.propagationModel||'logd';
  for(const s of samples){
    const x=(s.fx||0)*w, y=(s.fy||0)*h;
    // Predicted: max dBm across local APs.
    let predicted=-Infinity;
    for(const ap of APS()){
      const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
      const d=dbmAt(ap,x,y,w,h,walls,{
        bandFactor:bandLossMultiplier(ap.freq),
        arcDeg:pat.arc,headingDeg:ap.heading||0,
        eirpDbm:effectiveEirp(ap),
        model:propModel,
        metersPerPx:(scaleM||100)/100,
      });
      if(d!==null&&d>predicted)predicted=d;
    }
    const measured=Number.isFinite(s.rssi)?s.rssi:-95;
    const delta=predicted===-Infinity?null:(measured-predicted);
    const color=_heatColor(measured)||'#666';
    const c=mk('circle');
    c.setAttribute('cx',x);c.setAttribute('cy',y);c.setAttribute('r',5);
    c.setAttribute('fill',color);
    c.setAttribute('class','sample-dot');
    if(delta!==null && Math.abs(delta)>8){
      c.setAttribute('stroke','#c0382b');c.setAttribute('stroke-width','2');
    } else {
      c.setAttribute('stroke','#000');c.setAttribute('stroke-width','1');
    }
    c.setAttribute('data-rssi',String(measured));
    if(delta!==null){
      const t=mk('title');
      t.textContent=`Measured ${measured} dBm · Predicted ${Math.round(predicted)} dBm · Δ ${delta>=0?'+':''}${Math.round(delta)} dB`;
      c.appendChild(t);
    }
    layer.appendChild(c);
  }
}

// ═══ ANNOTATION DRAWING ═══════════════════════════
// Live preview while the user drags out an arrow / dim annotation.
function renderAnnoPreview(){
  const layer=document.getElementById('anno-preview-layer');
  if(!layer)return;
  layer.innerHTML='';
  if(!annoStart||!annoHover)return;
  if(annoSubMode==='text')return;
  const ln=mk('line');
  ln.setAttribute('x1',annoStart.x);ln.setAttribute('y1',annoStart.y);
  ln.setAttribute('x2',annoHover.x);ln.setAttribute('y2',annoHover.y);
  ln.setAttribute('class', annoSubMode==='dim' ? 'anno-dim preview' : 'anno-arrow preview');
  ln.setAttribute('marker-end','url(#anno-arrowhead)');
  layer.appendChild(ln);
}
function commitAnno(x2,y2){
  if(!annoStart)return;
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  const fx=annoStart.x/w, fy=annoStart.y/h, fx2=x2/w, fy2=y2/h;
  if(annoSubMode==='text'){
    const txt=prompt('Label text','');
    if(txt!==null && txt.trim()){
      snapshot();
      ANNOS().push({id:'an'+(++nid),kind:'text',fx,fy,fx2:fx,fy2:fy,text:txt.trim()});
    }
  } else {
    snapshot();
    ANNOS().push({id:'an'+(++nid),kind:annoSubMode,fx,fy,fx2,fy2,text:''});
  }
  annoStart=null;annoHover=null;
  render();
}
function setAnnoSubMode(m){
  annoSubMode=m;
  document.querySelectorAll('[data-anno-sub]').forEach(b=>b.classList.toggle('active',b.dataset.annoSub===m));
}

// ═══ AP-ON-STICK READOUT ══════════════════════════
function updateApStickReadout(){
  const el=document.getElementById('ap-stick-readout');
  if(!el)return;
  if(!apStickStart || !dragId || dragType!=='ap'){el.style.display='none';return;}
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  const cur=_sampleFloorCoverage(F(),w,h);
  const curPct=cur.total?cur.covered/cur.total*100:0;
  if(apStickBest===null||curPct>apStickBest)apStickBest=curPct;
  const delta=curPct-apStickStart.covPct;
  el.style.display='block';
  el.innerHTML=
    `Cov: <b>${curPct.toFixed(1)}%</b> `+
    `(<span style="color:${delta>=0?'#1e7d3c':'#c0382b'}">${delta>=0?'+':''}${delta.toFixed(1)}%</span>)`+
    ` · best ${apStickBest.toFixed(1)}%`;
}
function startApStick(apId){
  if(!apId)return;
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  const cur=_sampleFloorCoverage(F(),w,h);
  const ap=APS().find(a=>a.id===apId);
  if(!ap)return;
  apStickStart={id:apId,fx:ap.fx,fy:ap.fy,covPct:cur.total?cur.covered/cur.total*100:0};
  apStickBest=apStickStart.covPct;
}
function endApStick(){apStickStart=null;apStickBest=null;updateApStickReadout();}
function cancelApStick(){
  // Esc during drag — snap back to the start position.
  if(!apStickStart)return;
  const ap=APS().find(a=>a.id===apStickStart.id);
  if(ap){ap.fx=apStickStart.fx;ap.fy=apStickStart.fy;invalidateCoverageCache();render();calcCoverage();}
  endApStick();
}

// ═══ SURVEY CSV IMPORT ════════════════════════════
// Accepts `x,y,floor,ssid,bssid,rssi,channel` rows. Headers detected via the
// first line; missing columns are tolerated. (`x,y` are fractional [0,1] or
// raw pixel — auto-detected: ≤2 → fractional, otherwise pixel.)
function importSurveyCsv(input){
  const file=input&&input.files&&input.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const text=String(e.target.result||'');
      const lines=text.split(/\r?\n/).filter(l=>l.trim().length);
      if(!lines.length){toast('CSV is empty');return;}
      const head=lines[0].toLowerCase().split(',').map(s=>s.trim());
      const hasHeader=head.some(h=>['x','fx','rssi','ssid','bssid','channel','floor'].includes(h));
      const colIdx=(k,fallback)=>{
        if(!hasHeader)return fallback;
        const i=head.indexOf(k);return i>=0?i:fallback;
      };
      const ix=colIdx('x',0), iy=colIdx('y',1), iFloor=colIdx('floor',2);
      const iSsid=colIdx('ssid',3), iBssid=colIdx('bssid',4);
      const iRssi=colIdx('rssi',5), iCh=colIdx('channel',6);
      const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
      const start=hasHeader?1:0;
      const samples=[];
      for(let r=start;r<lines.length;r++){
        const cols=lines[r].split(',').map(s=>s.trim());
        const rawX=parseFloat(cols[ix]);
        const rawY=parseFloat(cols[iy]);
        if(!Number.isFinite(rawX)||!Number.isFinite(rawY))continue;
        // Auto-detect fractional vs pixel
        const fx=rawX<=2?rawX:rawX/w;
        const fy=rawY<=2?rawY:rawY/h;
        const fl=cols[iFloor];
        const rssi=parseFloat(cols[iRssi]);
        samples.push({
          id:'s'+(++nid), fx, fy,
          ssid: cols[iSsid]||'',
          bssid: cols[iBssid]||'',
          rssi: Number.isFinite(rssi)?rssi:-95,
          channel: cols[iCh]||'',
          floorName: fl||'',
        });
      }
      if(!samples.length){toast('No valid samples found in CSV');return;}
      snapshot();
      // For now, route all samples to the current floor — a future patch
      // could route by `floorName` when provided.
      F().SAMPLES=(F().SAMPLES||[]).concat(samples);
      render();
      toast(t('toast.imported_samples',{n:samples.length}));
    }catch(err){
      toast('Failed to parse CSV: '+(err&&err.message||err));
    }
    if(input)input.value='';
  };
  reader.readAsText(file);
}

// ═══ AUTO CHANNEL + TX-POWER PLANNING ═════════════
// Greedy graph-coloring channel assignment. Looks at all APs on the current
// floor, picks a channel for each from its band's region-allowed list, and
// favours channels that don't overlap with neighbours within 0.9*(rA+rB).
function _regionChannels(band){
  const region=REGULATORY_REGIONS[SETTINGS.regulatoryRegion||DEFAULT_REGULATORY_REGION]||REGULATORY_REGIONS[DEFAULT_REGULATORY_REGION];
  if(band==='2.4')return region.channels24.slice();
  if(band==='5')return region.channels5.slice();
  if(band==='6')return region.channels6.slice();
  return [];
}
function _bandForAp(ap){
  const f=ap.freq||'';
  if(f.indexOf('6 GHz')>=0)return '6';
  if(f==='2.4 GHz only')return '2.4';
  return '5';   // 5 GHz only and 2.4/5 GHz dual → plan on 5 GHz
}
function autoChannelPlan(){
  const aps=APS();
  if(!aps.length){toast('No APs to plan');return;}
  snapshot();
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  // For each AP, score each channel in its band by neighbour overlap penalty.
  let changed=0;
  for(const ap of aps){
    const band=_bandForAp(ap);
    const list=_regionChannels(band);
    if(!list.length)continue;
    // Skip channels that are DFS in the current region (avoid unnecessary
    // radar pre-emption hits) unless the AP already sits on one explicitly.
    const region=REGULATORY_REGIONS[SETTINGS.regulatoryRegion||DEFAULT_REGULATORY_REGION];
    const dfs=region?region.dfs||[]:[];
    const candidates=list.filter(c=>!dfs.includes(c));
    const pool=candidates.length?candidates:list;
    let bestCh=pool[0], bestScore=Infinity;
    const apWidth=ap.chanWidth||20;
    for(const ch of pool){
      let score=0;
      for(const other of aps){
        if(other===ap)continue;
        if(_bandForAp(other)!==band)continue;
        const ax=ap.fx*w, ay=ap.fy*h;
        const bx=other.fx*w, by=other.fy*h;
        const dist=Math.hypot(ax-bx,ay-by);
        if(dist>=(ap.r+other.r)*0.9)continue;
        const otherCh=parseInt(String(other.channel||''),10);
        if(!Number.isFinite(otherCh))continue;
        // Width-aware: spectrum overlap of the candidate (at this AP's width)
        // vs the neighbour's actual channel+width is the real conflict test.
        if(channelsOverlapMhz(band,ch,apWidth,band,otherCh,other.chanWidth||20)){
          score+=otherCh===ch?10:5;
        }else if((band==='5'||band==='6') && Math.abs(otherCh-ch)<4){
          score+=1;   // adjacent-channel leakage penalty
        }
      }
      if(score<bestScore){bestScore=score;bestCh=ch;}
    }
    if(String(ap.channel)!==String(bestCh)){ap.channel=String(bestCh);changed++;}
  }
  render();renderRP();
  toast(`Auto channel: ${changed} AP${changed===1?'':'s'} updated`);
}
// Reference Tx power that maps to an AP's stored coverage radius `ap.r`.
const TX_POWER_REF_DBM=20;
// Effective coverage radius if the AP ran at `tx` dBm. Indoor path-loss
// exponent ≈3, so the usable range scales as 10^(ΔdBm/30) — i.e. roughly
// doubling for every +9 dB.
function _radiusAtTx(baseR,tx){
  return baseR*Math.pow(10,(tx-TX_POWER_REF_DBM)/30);
}
function autoTxPower(){
  const aps=APS();
  if(!aps.length){toast('No APs to plan');return;}
  snapshot();
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  // Try each Tx power (from 5 to 23 dBm) and pick the one whose resulting
  // coverage overlaps neighbouring same-band APs by ~30 % of its own area —
  // enough for roaming without blanketing the floor. The candidate radius
  // scales with Tx power, so the heuristic actually discriminates.
  for(const ap of aps){
    let bestTx=TX_POWER_REF_DBM, bestDelta=Infinity;
    const ax=ap.fx*w, ay=ap.fy*h;
    for(const tx of [5,8,11,14,17,20,23]){
      const a=_radiusAtTx(ap.r,tx);
      let overlap=0;
      const own=Math.PI*a*a;
      for(const other of aps){
        if(other===ap)continue;
        if(_bandForAp(other)!==_bandForAp(ap))continue;
        const bx=other.fx*w, by=other.fy*h;
        const d=Math.hypot(ax-bx,ay-by);
        const b=other.r;
        if(d>=a+b)continue;
        // Lens (circle–circle intersection) area approximation.
        if(d<=Math.abs(a-b))overlap+=Math.PI*Math.min(a,b)**2;
        else{
          const a2=Math.acos((d*d+a*a-b*b)/(2*d*a))*a*a;
          const b2=Math.acos((d*d+b*b-a*a)/(2*d*b))*b*b;
          const tri=0.5*Math.sqrt(Math.max(0,(-d+a+b)*(d+a-b)*(d-a+b)*(d+a+b)));
          overlap+=Math.max(0,a2+b2-tri);
        }
      }
      const ratio=own?overlap/own:0;
      const delta=Math.abs(ratio-0.3);
      if(delta<bestDelta){bestDelta=delta;bestTx=tx;}
    }
    ap.txPowerDbm=bestTx;
  }
  invalidateCoverageCache();
  render();renderRP();calcCoverage();
  toast('Tx-power tuned for each AP');
}

// ═══ BOM + CABLE-SCHEDULE CSV EXPORTS ═════════════
function _csvEscape(v){
  const s=String(v??'');
  if(/[",\n]/.test(s))return '"'+s.replace(/"/g,'""')+'"';
  return s;
}
function _downloadFile(filename,content,mime){
  const blob=new Blob([content],{type:mime||'text/plain'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},0);
}
// Each _*CsvString builder returns the CSV text ('' when there is nothing to
// export) so the single-file downloads and the handover pack share one source.
function _bomCsvString(){
  const tally=new Map(); // model → {kind, model, qty, poeWatts}
  for(const f of FLOORS){
    for(const ap of (f.APS||[])){
      const k='AP|'+(ap.model||'');
      const e=tally.get(k)||{kind:'AP',model:ap.model||'Custom/Other',qty:0,poeW:0};
      e.qty++;e.poeW+=(AP_POE_W[ap.model]||0);
      tally.set(k,e);
    }
    for(const c of (f.CAMS||[])){
      const k='CAM|'+(c.model||'');
      const e=tally.get(k)||{kind:'Camera',model:c.model||'Custom/Other',qty:0,poeW:0};
      e.qty++;e.poeW+=((CAM_SPECS[c.model]||{}).poeW||0);
      tally.set(k,e);
    }
    for(const sw of (f.SWS||[])){
      const k='SW|'+(sw.model||'');
      const e=tally.get(k)||{kind:'Switch',model:sw.model||'Custom/Other',qty:0,poeW:0};
      e.qty++;
      tally.set(k,e);
    }
  }
  const rows=[['Kind','Model','Qty','Total PoE draw (W)']];
  for(const e of tally.values())rows.push([e.kind,e.model,e.qty,e.poeW||'']);
  // Cabling rollup: sum every device→switch run (with routing factor + slack)
  // across all floors, then estimate boxes of cable needed.
  const cable=cableTotals();
  if(cable.runs>0){
    rows.push([]);
    rows.push(['Cabling','Ethernet runs',cable.runs,'']);
    rows.push(['Cabling','Cable length incl. slack (m)',cable.totalM,'']);
    const boxM=parseFloat(SETTINGS.cableBoxM)||305;
    rows.push(['Cabling',`Cable boxes (${boxM} m)`,Math.ceil(cable.totalM/boxM),'']);
  }
  // NVR storage rollup for the camera fleet at the configured retention/codec.
  const storGb=totalStorageGb();
  if(storGb>0){
    const days=parseInt(SETTINGS.retentionDays,10)||30;
    const codec=SETTINGS.storageCodec==='h264'?'H.264':'H.265';
    rows.push([]);
    rows.push(['Storage',`NVR capacity for ${days} d retention (${codec})`,
      storGb>=1000?(storGb/1000).toFixed(2)+' TB':Math.round(storGb)+' GB','']);
  }
  return rows.map(r=>r.map(_csvEscape).join(',')).join('\n');
}
function doBomCsv(){
  _downloadFile('bom.csv',_bomCsvString(),'text/csv');
  toast(t('toast.bom_exported'));
}
function _cableCsvString(){
  const rows=[['Floor','Device','Type','Switch','Port','Length (m)','Slack (m)','Status']];
  for(const f of FLOORS){
    const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
    const sws=f.SWS||[];
    const computeLen=(item)=>{
      const sw=sws.find(s=>s.id===item.swId);
      if(!sw)return null;
      const dx=(item.fx-sw.fx)*w, dy=(item.fy-sw.fy)*h;
      const px=Math.hypot(dx,dy);
      const m=Math.round(px*(f.scaleM||100)/100*routingFactor()*10)/10;
      const slack=Math.max(1,Math.round(m*0.1*10)/10);
      const status=m>100?'OVER 100m':m>90?'Near limit':'OK';
      return {m,slack,swName:sw.name||sw.id,status};
    };
    for(const ap of (f.APS||[])){
      const c=computeLen(ap);
      if(!c)continue;
      rows.push([f.name||'',ap.name||ap.id,'AP',c.swName,ap.port||'',c.m,c.slack,c.status]);
    }
    for(const cam of (f.CAMS||[])){
      const c=computeLen(cam);
      if(!c)continue;
      rows.push([f.name||'',cam.name||cam.id,'Camera',c.swName,cam.port||'',c.m,c.slack,c.status]);
    }
  }
  if(rows.length<=1)return '';
  return rows.map(r=>r.map(_csvEscape).join(',')).join('\n');
}
function doCableCsv(){
  const csv=_cableCsvString();
  if(!csv){toast('No linked devices to export');return;}
  _downloadFile('cable-schedule.csv',csv,'text/csv');
  toast(t('toast.cable_exported'));
}

// IP plan: one row per device with any network identity, across all floors.
function _ipPlanCsvString(){
  const rows=[['Floor','Device','Type','Model','IP','VLAN','VLAN name','Subnet','In subnet','Switch','Port','MAC']];
  for(const {dev,type,floor} of allDevices()){
    if(!(dev.ip||dev.vlan||dev.mac))continue;
    const v=vlanById(dev.vlan);
    const sw=(floor.SWS||[]).find(s=>s.id===dev.swId);
    const inSubnet=dev.ip&&v&&v.subnet?(ipInCidr(dev.ip,v.subnet)?'yes':'NO'):'';
    rows.push([floor.name||'',dev.name||dev.id,type,dev.model||'',dev.ip||'',dev.vlan||'',
      v?(v.name||''):'',v?(v.subnet||''):'',inSubnet,sw?(sw.name||sw.id):'',dev.port||'',dev.mac||'']);
  }
  if(rows.length<=1)return '';
  return rows.map(r=>r.map(_csvEscape).join(',')).join('\n');
}
function doIpPlanCsv(){
  const csv=_ipPlanCsvString();
  if(!csv){toast('No device has an IP, VLAN or MAC yet');return;}
  _downloadFile('ip-plan.csv',csv,'text/csv');
  toast('IP plan exported');
}

// Port map: one row per switch port (free ports included), plus clients
// without a parseable port number.
function _portMapCsvString(){
  const rows=[['Switch','Floor','Switch model','Port','Device','Type','Device model','IP','VLAN','PoE (W)']];
  const {all}=topologyModel();
  for(const e of all){
    const a=analyzeSwitch(e.sw,e.floor);
    const swName=e.sw.name||e.sw.id, swFloor=e.floor.name||'', swModel=e.sw.model||'';
    const byPort=new Map();
    const noPort=[];
    for(const c of a.clients){
      const p=parseInt(c.port,10);
      if(p>=1&&(a.ports==null||p<=a.ports))byPort.set(p,c);
      else noPort.push(c);
    }
    const maxPort=a.ports!=null?a.ports:Math.max(0,...byPort.keys());
    for(let p=1;p<=maxPort;p++){
      const c=byPort.get(p);
      rows.push(c
        ?[swName,swFloor,swModel,p,c.name,c.type==='AP'?'AP':'Camera',c.model||'',c.ip||'',c.dev.vlan||'',c.w||'']
        :[swName,swFloor,swModel,p,'— free —','','','','','']);
    }
    for(const c of noPort)
      rows.push([swName,swFloor,swModel,c.port||'?',c.name,c.type==='AP'?'AP':'Camera',c.model||'',c.ip||'',c.dev.vlan||'',c.w||'']);
  }
  if(rows.length<=1)return '';
  return rows.map(r=>r.map(_csvEscape).join(',')).join('\n');
}
function doPortMapCsv(){
  const csv=_portMapCsvString();
  if(!csv){toast('No switches placed yet');return;}
  _downloadFile('port-map.csv',csv,'text/csv');
  toast('Port map exported');
}

// Inventory: the as-built record — identity, status and install fields for
// every device in the building.
function _inventoryCsvString(){
  const rows=[['Floor','Type','Name','Model','Status','Serial','Asset tag','Firmware','MAC','IP','VLAN','Switch','Port','Notes']];
  for(const {dev,type,floor} of allDevices()){
    const sw=(floor.SWS||[]).find(s=>s.id===dev.swId);
    rows.push([floor.name||'',type,dev.name||dev.id,dev.model||'',statusMeta(dev).label,
      dev.serial||'',dev.assetTag||'',dev.firmware||'',dev.mac||'',dev.ip||'',dev.vlan||'',
      sw?(sw.name||sw.id):'',dev.port||'',dev.comment||dev.notes||'']);
  }
  if(rows.length<=1)return '';
  return rows.map(r=>r.map(_csvEscape).join(',')).join('\n');
}
function doInventoryCsv(){
  const csv=_inventoryCsvString();
  if(!csv){toast('Nothing placed yet');return;}
  _downloadFile('inventory.csv',csv,'text/csv');
  toast('Inventory exported');
}

// ═══ HANDOVER PACK ════════════════════════════════
// One zip with everything the customer/installer is handed at the end of a
// job: an HTML summary plus every CSV deliverable. Images are deliberately
// excluded — the HTML/PDF report exports cover the visual side.
function _handoverSummaryHtml(){
  const counts=deviceStatusCounts();
  const total=allDevices().length;
  const statusRow=DEVICE_STATUSES
    .map(s=>`<span style="display:inline-block;margin-right:14px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${DEVICE_STATUS_META[s].color};margin-right:4px"></span>${DEVICE_STATUS_META[s].label}: <strong>${counts[s]}</strong></span>`)
    .join('');
  const floorSections=FLOORS.map(f=>{
    const devs=allDevices().filter(d=>d.floor===f);
    if(!devs.length)return '';
    const rows=devs.map(({dev,type,floor})=>{
      const sw=(floor.SWS||[]).find(s=>s.id===dev.swId);
      return `<tr><td>${esc(type)}</td><td><strong>${esc(dev.name||dev.id)}</strong></td><td>${esc(dev.model||'')}</td>
        <td><span style="color:${statusMeta(dev).color};font-weight:700">${esc(statusMeta(dev).label)}</span></td>
        <td class="mono">${esc(dev.serial||'—')}</td><td class="mono">${esc(dev.assetTag||'—')}</td>
        <td class="mono">${esc(dev.ip||'—')}</td><td>${esc(dev.vlan||'—')}</td>
        <td>${esc(sw?(sw.name||sw.id):'—')}${dev.port?` · ${esc(String(dev.port))}`:''}</td></tr>`;
    }).join('');
    return `<section class="floor-sec"><h2>${esc(f.name||'Floor')}</h2>
      <table><thead><tr><th>Type</th><th>Name</th><th>Model</th><th>Status</th><th>Serial</th><th>Asset</th><th>IP</th><th>VLAN</th><th>Switch · Port</th></tr></thead>
      <tbody>${rows}</tbody></table></section>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${esc(SETTINGS.company||'Plexus')} — Handover</title><style>
body{font-family:Verdana,Geneva,sans-serif;color:#000;background:#fff;max-width:980px;margin:0 auto;padding:36px 28px}
h1{font-size:26px;margin-bottom:2px}
h2{font-size:17px;margin:26px 0 8px;border-bottom:1px solid #000;padding-bottom:4px}
h3{font-size:13px;margin:16px 0 6px}
.sub{font-size:11px;color:#555;margin-bottom:18px}
table{width:100%;border-collapse:collapse;margin-bottom:12px}
th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:6px 8px;border-bottom:1px solid #000}
td{font-size:12px;padding:5px 8px;border-bottom:1px solid rgba(0,0,0,.1)}
.mono{font-family:monospace;font-size:11px}
.note{font-size:10px;color:#777;margin-top:24px}
</style></head><body>
<h1>${esc(SETTINGS.reportTitle||'Network Handover')}</h1>
<div class="sub">${esc(SETTINGS.company||'Plexus')}${SETTINGS.tagline?' · '+esc(SETTINGS.tagline):''} · ${new Date().toLocaleDateString(SETTINGS.locale||'en-GB')} · ${total} devices · ${FLOORS.length} floor${FLOORS.length===1?'':'s'}</div>
<div>${statusRow}</div>
${floorSections}
${reportNetworkHtml()}
<div class="note">Generated by Plexus — Network Site Planner. The CSVs in this pack (inventory, IP plan, port map, BoM, cable schedule) carry the same data in machine-readable form.${SETTINGS.footerLine?' · '+esc(SETTINGS.footerLine):''}</div>
</body></html>`;
}
function doHandoverPack(){
  if(!allDevices().length){toast('Nothing placed yet');return;}
  const files=[{name:'summary.html',data:_handoverSummaryHtml()}];
  for(const [name,csv] of [
    ['inventory.csv',_inventoryCsvString()],
    ['ip-plan.csv',_ipPlanCsvString()],
    ['port-map.csv',_portMapCsvString()],
    ['bom.csv',_bomCsvString()],
    ['cable-schedule.csv',_cableCsvString()],
  ])if(csv)files.push({name,data:csv});
  const zip=zipStore(files);
  const date=new Date().toISOString().slice(0,10);
  const site=(SETTINGS.siteCode||SETTINGS.company||'plexus').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'plexus';
  _downloadFile(`${site}-handover-${date}.zip`,zip,'application/zip');
  toast(`Handover pack: ${files.length} files zipped`);
}

// ═══ PER-AP INSTALL SHEETS ════════════════════════
async function doInstallSheets(){
  const w=window.open('','_blank');
  if(w)w.document.write('<p style="font-family:sans-serif;padding:28px;color:#555">Building install sheets…</p>');
  const allAps=[];
  for(const f of FLOORS){
    for(const ap of (f.APS||[])){
      allAps.push({ap,floor:f});
    }
  }
  if(!allAps.length){if(w){w.document.open();w.document.write('<p>No APs to document.</p>');w.document.close();}return;}
  // Resolve each AP's product photo to an inline data: URL up front.
  const imgMap=await _resolveExportImages(allAps.map(a=>a.ap));
  const pat=(k)=>(AP_PATTERNS[k]||AP_PATTERNS.omni).label;
  const sections=allAps.map(({ap,floor},i)=>{
    const sw=(floor.SWS||[]).find(s=>s.id===ap.swId);
    const swName=sw?(sw.name||sw.id):'—';
    const eirp=effectiveEirp(ap).toFixed(1);
    const m=Math.round(ap.r*(floor.scaleM||100)/100);
    const prod=imgMap.get(ap);
    return `<section class="sheet${i>0?' page':''}">
      <h2>${esc(ap.name||'AP')} <span class="floor">· ${esc(floor.name||'')}</span></h2>
      ${prod?`<img class="product-photo" src="${prod}" alt="${esc(ap.model||'')}"/>`:''}
      <table class="install">
        <tr><th>Model</th><td>${esc(ap.model||'')}</td>
            <th>Pattern</th><td>${esc(pat(ap.pattern))}</td></tr>
        <tr><th>Band</th><td>${esc(ap.freq||'')}</td>
            <th>Channel</th><td>${esc(ap.channel||'auto')}</td></tr>
        <tr><th>Tx (dBm)</th><td>${esc(ap.txPowerDbm||20)}</td>
            <th>Gain (dBi)</th><td>${esc(ap.antennaGainDbi??0)}</td></tr>
        <tr><th>Cable loss (dB)</th><td>${esc(ap.cableLossDb??0)}</td>
            <th>EIRP (dBm)</th><td>${eirp}</td></tr>
        <tr><th>Heading (°)</th><td>${esc(ap.heading||0)}</td>
            <th>Downtilt (°)</th><td>${esc(ap.downtiltDeg||0)}</td></tr>
        <tr><th>Mount height (m)</th><td>${esc(ap.mountHeightM||2.7)}</td>
            <th>Capacity (clients)</th><td>${esc(ap.capacityClients||25)}</td></tr>
        <tr><th>Range (m)</th><td>${m}</td>
            <th>Switch</th><td>${esc(swName)}${ap.swId&&ap.port?` · Port ${esc(ap.port)}`:''}</td></tr>
        <tr><th>IP</th><td>${esc(ap.ip||'')}</td>
            <th>MAC</th><td>${esc(ap.mac||'')}</td></tr>
        <tr><th>Serial</th><td>${esc(ap.serial||'')}</td>
            <th>Asset tag</th><td>${esc(ap.assetTag||'')}</td></tr>
        <tr><th>VLAN</th><td>${esc(ap.vlan||'')}</td>
            <th>Status</th><td>${esc(statusMeta(ap).label)}</td></tr>
        <tr><th>Notes</th><td colspan="3">${esc(ap.comment||ap.notes||'')}</td></tr>
      </table>
      <div class="photo-placeholder">📷 INSTALL PHOTO</div>
    </section>`;
  }).join('\n');
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${esc(SETTINGS.company||'Plexus')} — Install Sheets</title><link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#efece5;font-family:'Rajdhani',sans-serif;color:#000;padding:36px 40px}
.cover{margin-bottom:30px;padding-bottom:14px;border-bottom:1px solid #000}
.cover h1{font-size:32px;letter-spacing:-.01em}
.cover .sub{font-family:'Share Tech Mono',monospace;letter-spacing:.2em;text-transform:uppercase;font-size:10px;color:rgba(0,0,0,.55);margin-top:8px}
.sheet{padding:30px 0;border-top:1px solid #000}
.sheet.page{page-break-before:always}
.sheet h2{font-size:18px;font-weight:700;margin-bottom:14px}
.sheet h2 .floor{font-weight:500;font-size:13px;color:rgba(0,0,0,.55)}
.product-photo{float:right;max-width:160px;max-height:120px;margin:0 0 10px 16px;object-fit:contain}
table.install{width:100%;border-collapse:collapse;margin-bottom:14px}
table.install th{text-align:left;background:#efece5;font-family:'Share Tech Mono',monospace;letter-spacing:.15em;text-transform:uppercase;font-size:9px;padding:6px 9px;border-bottom:1px solid rgba(0,0,0,.15);width:22%}
table.install td{font-size:12px;padding:6px 9px;border-bottom:1px solid rgba(0,0,0,.08);width:28%}
.photo-placeholder{width:100%;aspect-ratio:16/9;border:1px dashed rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-family:'Share Tech Mono',monospace;letter-spacing:.2em;color:rgba(0,0,0,.4);font-size:11px}
.print-btn{margin-top:24px;padding:12px 28px;background:#000;color:#efece5;border:none;font-size:11px;cursor:pointer;font-family:'Share Tech Mono',monospace;letter-spacing:.2em;text-transform:uppercase;font-weight:700}
@media print{body{padding:24px;background:#fff}.print-btn{display:none}.sheet.page{page-break-before:always}}
</style></head><body>
<div class="cover"><h1>${esc(SETTINGS.company||'Plexus')} — AP install sheets</h1><div class="sub">${new Date().toLocaleDateString()} · ${allAps.length} sheets</div></div>
${sections}
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
</body></html>`;
  if(w){w.document.open();w.document.write(html);w.document.close();toast(t('toast.installs_exported'));}
  else toast('Allow pop-ups to open the install sheets');
}

// ═══ REVISIONS + DIFF ═════════════════════════════
function _snapshotForRevision(){
  return JSON.parse(JSON.stringify(FLOORS,_stripCacheReplacer));
}
function newRevision(){
  const name=prompt('Revision name (e.g., "rev B – after client walk")','rev '+String.fromCharCode(65+PROJECT_REVISIONS.length));
  if(!name)return;
  PROJECT_REVISIONS.push({
    id:'rev'+(++nid),
    name:name.trim(),
    createdAt:new Date().toISOString(),
    snapshot:_snapshotForRevision(),
  });
  toast('Revision saved: '+name.trim());
  autosave();
}
function restoreRevision(id){
  const rev=PROJECT_REVISIONS.find(r=>r.id===id);
  if(!rev)return;
  showModal({i18n:'modal.restore_revision'},`Replace current floors with revision <strong>${esc(rev.name)}</strong>? Current state will be lost (consider saving a fresh revision first).`,()=>{
    snapshot();
    FLOORS=JSON.parse(JSON.stringify(rev.snapshot));
    if(curFloor>=FLOORS.length)curFloor=0;
    syncScaleFromFloor();loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
    toast('Restored '+rev.name);
  });
}
function _diffRevisions(a,b){
  // Walk floor by floor and report adds/removes/moves of APs+CAMs+SWs+DZs+WALLS.
  const out=[];
  const fLen=Math.max(a.length,b.length);
  for(let i=0;i<fLen;i++){
    const fa=a[i],fb=b[i];
    if(!fa){out.push(`+ Floor "${fb.name||i}" added`);continue;}
    if(!fb){out.push(`- Floor "${fa.name||i}" removed`);continue;}
    for(const kind of ['APS','CAMS','SWS','DZS','WALLS']){
      const la=fa[kind]||[],lb=fb[kind]||[];
      const ids=new Set([...la.map(x=>x.id),...lb.map(x=>x.id)]);
      for(const id of ids){
        const ia=la.find(x=>x.id===id), ib=lb.find(x=>x.id===id);
        if(ia && !ib)out.push(`- [${fa.name||i}] ${kind.slice(0,-1)} ${ia.name||id} removed`);
        else if(!ia && ib)out.push(`+ [${fb.name||i}] ${kind.slice(0,-1)} ${ib.name||id} added`);
        else if(ia && ib){
          // Walls carry endpoint coords (fx1/fy1/fx2/fy2); everything else
          // has a single fx/fy anchor.
          const moved=kind==='WALLS'
            ? (ia.fx1!==ib.fx1||ia.fy1!==ib.fy1||ia.fx2!==ib.fx2||ia.fy2!==ib.fy2)
            : (ia.fx!==ib.fx||ia.fy!==ib.fy);
          if(moved)out.push(`~ [${fa.name||i}] ${kind.slice(0,-1)} ${ia.name||id} ${kind==='WALLS'?'reshaped':'moved'}`);
          // Field-level changes — the as-designed vs as-built story: identity,
          // wiring and rollout fields, not geometry.
          if(kind!=='WALLS'&&kind!=='DZS'){
            for(const fld of ['name','model','ip','vlan','port','swId','status','serial','channel','txPower']){
              const va=ia[fld]??'',vb=ib[fld]??'';
              if(String(va)!==String(vb))out.push(`~ [${fa.name||i}] ${kind.slice(0,-1)} ${ia.name||id}: ${fld} ${va===''?'(empty)':va} → ${vb===''?'(empty)':vb}`);
            }
          }
        }
      }
    }
  }
  return out;
}
function showRevisions(){
  const wrap=document.createElement('div');wrap.className='settings-form';
  if(!PROJECT_REVISIONS.length){
    const e=document.createElement('div');e.className='ep-hint';
    localizeText(e,'revisions.empty');
    wrap.appendChild(e);
  } else {
    const list=document.createElement('div');list.className='rev-list';
    const showDiff=(lines,label)=>{
      const old=wrap.querySelector('.rev-diff');if(old)old.remove();
      const out=document.createElement('pre');out.className='rev-diff';
      out.textContent=(label?label+'\n\n':'')+(lines.length?lines.join('\n'):'(no differences detected)');
      wrap.appendChild(out);
    };
    for(const rev of PROJECT_REVISIONS){
      const row=document.createElement('div');row.className='rev-row';
      const name=document.createElement('div');name.className='rev-name';
      name.textContent=(rev.baseline?'★ ':'')+rev.name;
      if(rev.baseline)name.setAttribute('data-i18n-title','revisions.baseline');name.title=t('revisions.baseline');
      const when=document.createElement('div');when.className='rev-when';when.textContent=new Date(rev.createdAt).toLocaleString(SETTINGS.locale||'en-GB');
      // Mark as the design baseline (one at a time) — the "as-designed" state
      // that later as-built diffs are read against.
      const b=document.createElement('button');b.className='btn';b.textContent=rev.baseline?'★':'☆';
      b.setAttribute('data-i18n-title',rev.baseline?'revisions.unmark':'revisions.mark');b.title=t(b.getAttribute('data-i18n-title'));
      b.addEventListener('click',()=>{
        const on=!rev.baseline;
        PROJECT_REVISIONS.forEach(r=>r.baseline=false);
        rev.baseline=on;
        autosave();closeModal();showRevisions();
      });
      const d=document.createElement('button');d.className='btn';localizeText(d,'revisions.diff');
      d.setAttribute('data-i18n-title','revisions.diff_tip');d.title=t('revisions.diff_tip');
      d.addEventListener('click',()=>{
        showDiff(_diffRevisions(rev.snapshot,_snapshotForRevision()),`${rev.name} → current state`);
      });
      const r=document.createElement('button');r.className='btn';localizeText(r,'revisions.restore');
      r.addEventListener('click',()=>{closeModal();restoreRevision(rev.id);});
      const x=document.createElement('button');x.className='btn danger';x.textContent='×';x.setAttribute('data-i18n-title','modal.delete');x.title=t('modal.delete');
      x.addEventListener('click',()=>{
        PROJECT_REVISIONS=PROJECT_REVISIONS.filter(r=>r.id!==rev.id);
        autosave();closeModal();showRevisions();
      });
      row.appendChild(name);row.appendChild(when);row.appendChild(b);row.appendChild(d);row.appendChild(r);row.appendChild(x);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    if(PROJECT_REVISIONS.length>=2){
      const diffBtn=document.createElement('button');diffBtn.className='btn';localizeText(diffBtn,'revisions.diff_last');
      diffBtn.style.marginTop='12px';
      diffBtn.addEventListener('click',()=>{
        const a=PROJECT_REVISIONS[PROJECT_REVISIONS.length-2].snapshot;
        const b=PROJECT_REVISIONS[PROJECT_REVISIONS.length-1].snapshot;
        const lines=_diffRevisions(a,b);
        const out=document.createElement('pre');out.className='rev-diff';
        out.textContent=lines.length?lines.join('\n'):'(no differences detected)';
        wrap.appendChild(out);
      });
      wrap.appendChild(diffBtn);
    }
  }
  const saveBtn=document.createElement('button');saveBtn.className='btn btn-primary';localizeText(saveBtn,'revisions.save');
  saveBtn.style.marginTop='12px';
  saveBtn.addEventListener('click',()=>{closeModal();newRevision();});
  wrap.appendChild(saveBtn);
  showModalNode({i18n:'tb.revisions'},wrap,null);
}

// ═══ INVENTORY ════════════════════════════════════
// Flat, searchable as-built record of every device across all floors, with
// rollout progress and inline status editing. The footer collects the
// organization actions (bulk IPs, renaming, CSV/handover exports).
function showInventory(){
  const wrap=document.createElement('div');
  wrap.style.cssText='font-family:Rajdhani,sans-serif;font-size:13px';
  const devs=allDevices();
  if(!devs.length){
    localizeText(wrap,'inventory.empty');
    showModalNode({i18n:'tb.inventory'},wrap,null);
    return;
  }
  // Rollout progress pills.
  const counts=deviceStatusCounts();
  const prog=document.createElement('div');
  prog.style.cssText='display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:11px';
  for(const s of DEVICE_STATUSES){
    const m=DEVICE_STATUS_META[s];
    const pill=document.createElement('span');
    pill.style.cssText='display:flex;align-items:center;gap:5px';
    pill.innerHTML=`<span style="width:9px;height:9px;border-radius:50%;background:${m.color}"></span>${m.label} <strong>${counts[s]}</strong>`;
    prog.appendChild(pill);
  }
  const done=counts.live+counts.tested;
  const pct=Math.round((done/devs.length)*100);
  const pctEl=document.createElement('span');
  pctEl.style.cssText='margin-left:auto;font-family:"Share Tech Mono",monospace;font-size:11px;opacity:.7';
  pctEl.textContent=`${pct}% tested/live`;
  prog.appendChild(pctEl);
  wrap.appendChild(prog);
  // Search box.
  const search=document.createElement('input');
  search.className='ep-in';search.type='text';search.setAttribute('data-i18n-placeholder','inventory.search');search.placeholder=t('inventory.search');
  search.style.cssText='width:100%;margin-bottom:8px';
  wrap.appendChild(search);
  // Table.
  const scroller=document.createElement('div');
  scroller.style.cssText='max-height:46vh;overflow:auto;border:1px solid var(--ink-04);border-radius:3px';
  const tbl=document.createElement('table');
  tbl.style.cssText='width:100%;border-collapse:collapse;font-size:12px';
  tbl.innerHTML=`<thead><tr style="position:sticky;top:0;background:var(--bg,inherit)">${
    ['inventory.floor','inventory.type','settings.name','inventory.model','inventory.status','inventory.serial','inventory.asset','IP','inventory.port']
      .map(h=>`<th ${h==='IP'?'':`data-i18n="${h}"`} style="text-align:left;font-size:9px;letter-spacing:.12em;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--ink-04)">${esc(h==='IP'?h:t(h))}</th>`).join('')
  }</tr></thead>`;
  const tbody=document.createElement('tbody');
  tbl.appendChild(tbody);scroller.appendChild(tbl);wrap.appendChild(scroller);
  const renderRows=()=>{
    const q=(search.value||'').trim().toLowerCase();
    tbody.innerHTML='';
    let shown=0;
    for(const entry of devs){
      const {dev,type,floor,floorIdx}=entry;
      const hay=[dev.name,dev.model,dev.serial,dev.assetTag,dev.firmware,dev.ip,dev.mac,dev.vlan,statusMeta(dev).label,floor.name].join(' ').toLowerCase();
      if(q&&!hay.includes(q))continue;
      shown++;
      const sw=(floor.SWS||[]).find(s=>s.id===dev.swId);
      const tr=document.createElement('tr');
      tr.style.cssText='cursor:pointer';
      const td=(html,mono)=>{const c=document.createElement('td');c.style.cssText=`padding:5px 8px;border-bottom:1px solid var(--ink-04)${mono?';font-family:\'Share Tech Mono\',monospace;font-size:10px':''}`;c.innerHTML=html;return c;};
      tr.appendChild(td(esc(floor.name||`Floor ${floorIdx+1}`)));
      tr.appendChild(td(type));
      tr.appendChild(td(`<strong>${esc(dev.name||dev.id)}</strong>`));
      tr.appendChild(td(esc(dev.model||'')));
      // Inline status editor — the one field that changes during a rollout.
      const stTd=td('');
      const stSel=document.createElement('select');
      stSel.className='ep-sel';stSel.style.cssText='font-size:11px;padding:2px 4px';
      for(const s of DEVICE_STATUSES){
        const o=document.createElement('option');o.value=s;localizeText(o,'status.'+s);
        if((dev.status||'planned')===s)o.selected=true;
        stSel.appendChild(o);
      }
      stSel.style.color=statusMeta(dev).color;
      stSel.addEventListener('click',e=>e.stopPropagation());
      stSel.addEventListener('change',()=>{
        snapshot();dev.status=stSel.value;stSel.style.color=statusMeta(dev).color;
        render();renderList();autosave();
      });
      stTd.appendChild(stSel);tr.appendChild(stTd);
      tr.appendChild(td(esc(dev.serial||'—'),true));
      tr.appendChild(td(esc(dev.assetTag||'—'),true));
      tr.appendChild(td(esc(dev.ip||'—'),true));
      tr.appendChild(td(esc(sw?(sw.name||sw.id):'—')+(dev.port?` · ${esc(String(dev.port))}`:'')));
      tr.addEventListener('click',()=>{
        closeModal();
        if(floorIdx!==curFloor)switchFloor(floorIdx);
        setMode('sel');
        const kind={AP:'ap',CAM:'cam',SW:'sw'}[type];
        // The floor image loads async on a switch — give it a beat before zooming.
        setTimeout(()=>sel(dev.id,kind,{zoom:true}),floorIdx!==curFloor?250:0);
      });
      tbody.appendChild(tr);
    }
    if(!shown){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td colspan="9" style="padding:14px;text-align:center;opacity:.6" data-i18n="inventory.no_matches">${esc(t('inventory.no_matches'))}</td>`;
      tbody.appendChild(tr);
    }
  };
  renderRows();
  search.addEventListener('input',renderRows);
  // Footer: organization actions + exports.
  const foot=document.createElement('div');
  foot.style.cssText='display:flex;gap:6px;flex-wrap:wrap;margin-top:10px';
  const mkBtn=(label,title,fn)=>{
    const b=document.createElement('button');b.className='btn';localizeText(b,label);b.setAttribute('data-i18n-title',title);b.title=t(title);
    b.addEventListener('click',fn);foot.appendChild(b);
  };
  mkBtn('inventory.ip_all','inventory.ip_tip',()=>{autoAssignIps();closeModal();showInventory();});
  mkBtn('inventory.rename','inventory.rename_tip',()=>{autoRenameDevices();closeModal();showInventory();});
  mkBtn('inventory.csv','inventory.csv_tip',()=>doInventoryCsv());
  mkBtn('inventory.ip_csv','inventory.ip_csv_tip',()=>doIpPlanCsv());
  mkBtn('inventory.port_csv','inventory.port_csv_tip',()=>doPortMapCsv());
  const hb=document.createElement('button');hb.className='btn btn-primary';localizeText(hb,'inventory.handover');
  hb.setAttribute('data-i18n-title','tip.handover');hb.title=t('tip.handover');
  hb.addEventListener('click',()=>doHandoverPack());
  foot.appendChild(hb);
  wrap.appendChild(foot);
  showModalNode({i18n:'modal.inventory_rollout'},wrap,null);
  document.getElementById('mdl').classList.add('wide-modal');
}

// ═══ PLUGIN API (vendor catalog merging) ══════════
// A user can paste a JSON dictionary that adds APs/cams/switches to the
// catalogs without rebuilding. The accumulated catalog is persisted on the
// project (SETTINGS.customCatalog) and re-applied at load via applyStoredCatalog.
// Model-level dedup keeps re-applies (reload / loading several projects) from
// piling duplicate entries into the dropdowns.
function _mergeCustomCatalog(catalog){
  if(!catalog||typeof catalog!=='object')return false;
  // Catalog shape:
  // { aps: [{label:'My Vendor', models:['X1','X2'], range:{X1:30}, poe:{X1:15}, gain:{X1:5}}],
  //   cams: [{label:'My CCTV', models:['CamA'], specs:{CamA:{fov:90,range:30,res:'4K',poeW:8}}}],
  //   switches: [{label:'My SW', models:['SW1'], ports:{SW1:24}, poe:{SW1:380}, class:{SW1:'bt'}}] }
  let added=0;
  for(const g of (catalog.aps||[])){
    if(!g.label||!Array.isArray(g.models))continue;
    for(const m of g.models){
      if(g.range&&Number.isFinite(g.range[m]))AP_RANGE_M[m]=g.range[m];
      if(g.poe&&Number.isFinite(g.poe[m]))AP_POE_W[m]=g.poe[m];
      if(g.gain&&Number.isFinite(g.gain[m]))AP_ANTENNA_GAIN_DBI[m]=g.gain[m];
    }
    const fresh=g.models.filter(m=>!MODELS.includes(m));
    if(fresh.length){AP_MODEL_GROUPS.push({label:g.label,models:fresh});for(const m of fresh)MODELS.push(m);added+=fresh.length;}
  }
  for(const g of (catalog.cams||[])){
    if(!g.label||!Array.isArray(g.models))continue;
    if(g.specs)for(const k of Object.keys(g.specs))CAM_SPECS[k]=g.specs[k];
    const fresh=g.models.filter(m=>!CAM_MODELS.includes(m));
    if(fresh.length){CAM_MODEL_GROUPS.push({label:g.label,models:fresh});for(const m of fresh)CAM_MODELS.push(m);added+=fresh.length;}
  }
  for(const g of (catalog.switches||[])){
    if(!g.label||!Array.isArray(g.models))continue;
    for(const m of g.models){
      if(g.ports&&Number.isFinite(g.ports[m]))SW_PORTS[m]=g.ports[m];
      if(g.poe&&Number.isFinite(g.poe[m]))SW_POE_BUDGET_W[m]=g.poe[m];
      if(g.class&&typeof g.class[m]==='string')SW_POE_CLASS[m]=g.class[m];
    }
    const fresh=g.models.filter(m=>!SW_MODELS.includes(m));
    if(fresh.length){SW_MODEL_GROUPS.push({label:g.label,models:fresh});for(const m of fresh)SW_MODELS.push(m);added+=fresh.length;}
  }
  return added>0;
}
// Append a freshly-merged catalog onto the persisted accumulation so it
// survives reloads / save+load (re-applied by applyStoredCatalog).
function _accumulateCatalog(json){
  let store={aps:[],cams:[],switches:[]};
  if(SETTINGS.customCatalog){try{const p=JSON.parse(SETTINGS.customCatalog)||{};store={aps:p.aps||[],cams:p.cams||[],switches:p.switches||[]};}catch{}}
  for(const k of ['aps','cams','switches'])if(Array.isArray(json[k]))store[k]=store[k].concat(json[k]);
  SETTINGS.customCatalog=JSON.stringify(store);
}
// Re-merge the project's persisted custom catalog into the live dropdowns.
// Safe to call repeatedly — _mergeCustomCatalog dedups by model name.
function applyStoredCatalog(){
  if(!SETTINGS.customCatalog)return;
  try{_mergeCustomCatalog(JSON.parse(SETTINGS.customCatalog));}catch{}
}
function showPluginCatalogDialog(){
  const wrap=document.createElement('div');wrap.className='settings-form';
  const hint=document.createElement('div');hint.className='ep-hint';
  hint.innerHTML=`<span data-i18n="catalog.hint">${esc(t('catalog.hint'))}</span><br>
<code style="font-size:11px;font-family:monospace;background:rgba(0,0,0,.05);padding:8px;display:block;white-space:pre;margin-top:6px">{"aps":[{"label":"My Vendor","models":["X1"],"range":{"X1":30},"poe":{"X1":15}}],
 "cams":[{"label":"My CCTV","models":["CamA"],"specs":{"CamA":{"fov":90,"range":30,"res":"4K","poeW":8}}}],
 "switches":[{"label":"My SW","models":["SW1"],"ports":{"SW1":24},"poe":{"SW1":380},"class":{"SW1":"bt"}}]}</code>`;
  wrap.appendChild(hint);
  const ta=document.createElement('textarea');
  ta.style.width='100%';ta.style.height='180px';ta.style.fontFamily='monospace';ta.style.fontSize='12px';
  ta.placeholder='{"aps":[...]}';
  wrap.appendChild(ta);
  showModalNode({i18n:'modal.catalog'},wrap,()=>{
    try{
      const json=JSON.parse(ta.value||'{}');
      if(_mergeCustomCatalog(json)){
        _accumulateCatalog(json);
        autosave();
        renderRP();   // refresh an open device panel so new models show in dropdowns
        toast('Catalog merged & saved');
      }else toast('Nothing to merge');
    }catch(err){
      toast('Invalid JSON: '+(err&&err.message||err));
    }
  });
}

function renderGrid(){
  gridLayer.innerHTML='';if(!showGrid)return;
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  const g=mk('g');g.setAttribute('class','snap-grid');
  for(let x=0;x<=w;x+=GRID_SZ){const l=mk('line');l.setAttribute('x1',x);l.setAttribute('y1',0);l.setAttribute('x2',x);l.setAttribute('y2',h);g.appendChild(l);}
  for(let y=0;y<=h;y+=GRID_SZ){const l=mk('line');l.setAttribute('x1',0);l.setAttribute('y1',y);l.setAttribute('x2',w);l.setAttribute('y2',y);g.appendChild(l);}
  gridLayer.appendChild(g);
}

function render(){_resetThemeCache();renderGrid();renderHeat();renderRoaming();renderOL();renderWalls();renderCables();renderSWs();renderAPs();renderCAMs();renderDZs();renderChannelOverlap();renderAnnotations();renderSamples();renderAnnoPreview();renderRuler();updateCnt();updateApStickReadout();updateVlanLegend();}
// Populate the map legend with a colour chip per registered VLAN (only when
// "colour by VLAN" is active, so it matches what's on the map).
function updateVlanLegend(){
  const el=document.getElementById('leg-vlans');if(!el)return;
  if(!SETTINGS.colorByVlan||!vlanList().length){el.innerHTML='';return;}
  el.innerHTML=vlanList().filter(v=>v.color).map(v=>
    `<span class="leg-i"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(v.color)}"></span>${esc(v.name||v.id)}</span>`
  ).join('');
}

// ═══ DRAG ═════════════════════════════════════════
// During an active drag we update the moved item's geometry directly via a
// `transform` translate on its <g>, rather than re-running render() (which
// wipes and rebuilds every SVG layer). This keeps drag at 60fps even with
// dozens of items + walls (where coverage is O(rays * walls) per AP).
// On pointerup the full render runs once and clears the transform.
let _dragInitialFx=0,_dragInitialFy=0;
function doDrag(cx,cy){
  const img=vpToImg(cx,cy);
  const {x,y}=snapPt(img.x,img.y);
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  const fx=Math.max(0,Math.min(1,(x+dragOffX)/w)),fy=Math.max(0,Math.min(1,(y+dragOffY)/h));
  let item=null;
  if(dragType==='ap')item=APS().find(a=>a.id===dragId);
  else if(dragType==='dz')item=DZS().find(a=>a.id===dragId);
  else if(dragType==='sw')item=SWS().find(a=>a.id===dragId);
  else if(dragType==='cam')item=CAMS().find(a=>a.id===dragId);
  if(!item)return;
  item.fx=fx;item.fy=fy;
  // For APs with walls the coverage *shape* depends on position, so we still
  // need a full re-render. Plain circle coverage rotates with the AP, so a
  // transform is fine. DZ/SW are always handled as transforms.
  const apHasWalls=(dragType==='ap'&&WALLS().length>0);
  if(apHasWalls){
    invalidateCoverageCache();
    render();
    return;
  }
  // Camera drags always do a full re-render so the cone updates with the
  // new position. Other types use a cheap transform on the existing group.
  if(dragType==='cam'){render();return;}
  const layer=dragType==='ap'?apLayer:dragType==='dz'?dzLayer:swLayer;
  const grp=layer.querySelector(`[data-id="${dragId}"]`);
  if(grp){
    const dx=(fx-_dragInitialFx)*w;
    const dy=(fy-_dragInitialFy)*h;
    grp.setAttribute('transform',`translate(${dx},${dy})`);
    // The transform fast-path skips render(), so refresh the AP-on-stick
    // live coverage readout explicitly (render() would otherwise do it).
    if(dragType==='ap')updateApStickReadout();
  }else{
    render();
  }
}
function endDrag(){
  if(!dragId)return;
  // Clear the per-element transform and do one full render so the item's real
  // coords (now updated on the data) are reflected everywhere.
  const layer=dragType==='ap'?apLayer:dragType==='dz'?dzLayer:dragType==='sw'?swLayer:dragType==='cam'?camLayer:null;
  if(layer){const grp=layer.querySelector(`[data-id="${dragId}"]`);if(grp)grp.removeAttribute('transform');}
  if(dragType==='ap')invalidateCoverageCache();
  // AP-on-stick: clear the live coverage readout.
  if(dragType==='ap')endApStick();
  dragId=null;dragType=null;
  render();calcCoverage();
}
function doResize(cx){
  const img=vpToImg(cx,0);
  const ap=APS().find(a=>a.id===resId);
  if(ap){ap.r=Math.max(15,Math.min(500,Math.abs(img.x-ap.fx*(mapImg.naturalWidth||1))));const slider=document.getElementById('ep-r');if(slider){slider.value=Math.round(ap.r);document.getElementById('ep-rv').textContent=Math.round(ap.r*(scaleM/100))+'m';}render();calcCoverage();return;}
  const dz=DZS().find(a=>a.id===resId);
  if(dz){dz.r=Math.max(10,Math.min(300,Math.abs(img.x-dz.fx*(mapImg.naturalWidth||1))));const slider=document.getElementById('dz-r');if(slider){slider.value=Math.round(dz.r);document.getElementById('dz-rv').textContent=Math.round(dz.r*(scaleM/100))+'m';}render();}
}

// ═══ COVERAGE CALC ════════════════════════════════
// Defers to the pure sampler in geometry.js so logic stays in one place.
function sampleFloorCoverage(floor){
  const w=mapImg.naturalWidth||1,h=mapImg.naturalHeight||1;
  return _sampleFloorCoverage(floor,w,h);
}
// Wall-aware sampling is heavier than the old circle check, so coalesce calls
// during fast operations (drag, slider scrub). `calcCoverage()` schedules the
// real work; `_calcCoverageNow()` does it. Skipped when the tab is hidden.
let _covScheduled=false;
function calcCoverage(){
  if(_covScheduled)return;
  if(typeof document!=='undefined'&&document.hidden)return;
  _covScheduled=true;
  const run=()=>{_covScheduled=false;_calcCoverageNow();};
  if(typeof requestIdleCallback==='function')requestIdleCallback(run,{timeout:200});
  else setTimeout(run,80);
}
function _calcCoverageNow(){
  const el=document.getElementById('cov-pct');
  if(!el)return;
  // Current floor
  const cur=sampleFloorCoverage(F());
  if(!cur.total){el.textContent='—';return;}
  const curPct=Math.round(cur.covered/cur.total*100);
  // Whole building — but only show it if >1 floor exists
  if(FLOORS.length>1){
    let totalC=0,totalT=0;
    FLOORS.forEach(f=>{const s=sampleFloorCoverage(f);totalC+=s.covered;totalT+=s.total;});
    const allPct=totalT?Math.round(totalC/totalT*100):0;
    el.innerHTML=`${curPct}%<span class="cov-all"> · All: ${allPct}%</span>`;
  }else{
    el.textContent=curPct+'%';
  }
}

// ═══ SCALE ════════════════════════════════════════
// Per-floor: writes to F().scaleM as well as the global mirror.
function updateScale(){snapshotSoon();setScaleM(document.getElementById('scale-m').value);updateScaleBar();calcCoverage();render();renderList();renderRP();}

// Calibrate the scale by measuring a known real-world dimension on the plan.
// Entry point: if a ruler measurement already exists, prompt now; otherwise arm
// the ruler so the next line the user draws opens the prompt.
function calibrateScale(){
  if(rulerStart&&rulerEnd){promptCalibration();return;}
  calibratePending=true;
  setMode('ruler');
  toast('Draw a line over a known dimension to set the scale');
}
// Ask for the line's real length, then derive metres-per-100px from its pixels.
function promptCalibration(){
  if(!(rulerStart&&rulerEnd))return;
  const px=Math.hypot(rulerEnd.x-rulerStart.x,rulerEnd.y-rulerStart.y);
  if(px<2){toast('Line too short — draw a longer one');return;}
  const wrap=document.createElement('div');
  wrap.style.cssText='font-family:Rajdhani,sans-serif;font-size:13px';
  const p=document.createElement('div');
  p.textContent=`This line is ${px.toFixed(0)} px. Enter its real-world length:`;
  p.style.marginBottom='8px';
  const row=document.createElement('div');row.style.cssText='display:flex;gap:6px;align-items:center';
  const inp=document.createElement('input');
  inp.type='number';inp.min='0.1';inp.step='0.1';inp.className='ep-in';
  inp.value=(px*(scaleM/100)).toFixed(1);inp.style.width='130px';
  const unit=document.createElement('span');localizeText(unit,'calibrate.metres');
  row.append(inp,unit);wrap.append(p,row);
  showModalNode({i18n:'modal.calibrate'},wrap,()=>{
    const realM=parseFloat(inp.value);
    if(!(realM>0)){toast('Enter a positive length');return;}
    snapshot();
    const newScale=realM/px*100;            // metres per 100 px
    setScaleM(newScale);
    const el=document.getElementById('scale-m');if(el)el.value=Math.round(newScale*100)/100;
    SETTINGS.archScale='';                   // now a custom, measured scale
    updateScaleBar();calcCoverage();render();renderList();renderRP();
    toast(`Scale set: ${newScale.toFixed(2)} m / 100 px`);
  });
  setTimeout(()=>{inp.focus();inp.select();},50);
}
function updateScaleBar(){
  const bar=document.getElementById('scale-bar');
  if(!scaleM||!mapImg.naturalWidth){bar.style.display='none';return;}
  bar.style.display='flex';
  // 100px in image space = scaleM metres; in screen space = 100*sc px
  const screenPx=100*scale;
  document.getElementById('sbar-line').style.width=screenPx+'px';
  document.getElementById('sbar-txt').textContent=scaleM+'m';
}

// ═══ TOGGLES ══════════════════════════════════════
function toggleOL(){showOL=!showOL;document.getElementById('btn-ol').classList.toggle('active',showOL);document.getElementById('leg-ol').style.display=showOL?'flex':'none';render();}
function toggleHeat(){showHeat=!showHeat;document.getElementById('btn-heat').classList.toggle('active',showHeat);render();}
function toggleGrid(){showGrid=!showGrid;document.getElementById('btn-grid').classList.toggle('active',showGrid);render();}
function toggleCables(){showCables=!showCables;document.getElementById('btn-cables').classList.toggle('active',showCables);render();}
function toggleCoverage(){
  showCoverage=!showCoverage;
  document.getElementById('btn-cov').classList.toggle('active',showCoverage);
  render();
}

// ═══ MINIMAP ══════════════════════════════════════
// Minimap was removed by user request. renderMM kept as a no-op so call sites
// throughout the codebase don't have to be ripped out.
function renderMM(){}

// ═══ RIGHT PANEL ══════════════════════════════════
// Resolve the currently-selected physical device (AP / camera / switch).
// Dead zones, walls and annotations have no product image, so return null.
function _selectedDevice(){
  if(selType==='ap')return APS().find(a=>a.id===selId);
  if(selType==='cam')return CAMS().find(a=>a.id===selId);
  if(selType==='sw')return SWS().find(a=>a.id===selId);
  return null;
}

// ── Device management credentials ─────────────────────────────────────────
// Login/management details for a router/switch/AP/camera. Stored in the
// project file only — stripped from Share links (see shareLink) and never
// printed in reports. Shared markup so every device panel looks the same.
const CRED_PROTOS=['https','http','ssh','telnet'];
function credsBlock(dev){
  const c=dev.creds||{};
  const proto=c.proto||'https';
  const protoOpts=CRED_PROTOS.map(p=>`<option value="${p}"${proto===p?' selected':''}>${p.toUpperCase()}</option>`).join('');
  return `
    <div class="ep-section">Credentials</div>
    <div class="ep-row"><label class="ep-lbl">Protocol</label><select class="ep-sel" id="cred-proto" data-input-action="upd-creds">${protoOpts}</select></div>
    <div class="ep-row"><label class="ep-lbl">Host / URL</label><input class="ep-in ep-mono" id="cred-host" value="${esc(c.host||'')}" data-input-action="upd-creds" placeholder="defaults to IP (${esc(dev.ip||'—')})"/></div>
    <div class="ep-row"><label class="ep-lbl">Port</label><input class="ep-in ep-mono" id="cred-port" value="${esc(c.port||'')}" data-input-action="upd-creds" placeholder="443"/></div>
    <div class="ep-row"><label class="ep-lbl">Username</label><input class="ep-in" id="cred-user" value="${esc(c.user||'')}" data-input-action="upd-creds" autocomplete="off"/></div>
    <div class="ep-row"><label class="ep-lbl">Password</label><input class="ep-in ep-mono" id="cred-pass" type="password" value="${esc(c.pass||'')}" data-input-action="upd-creds" autocomplete="new-password"/><button class="btn" style="flex:0 0 auto;padding:4px 8px" data-action="toggle-pass" title="Show / hide password">👁</button></div>
    <div class="ep-row"><a href="#" data-action="open-mgmt" style="font-size:11px">↗ Open management UI</a></div>
    <div class="ep-row" style="font-size:10px;opacity:.55">Saved in the project file only — excluded from Share links and PDF/HTML reports.</div>`;
}
function updCreds(){
  const d=_selectedDevice();if(!d)return;
  snapshotSoon();
  const g=id=>document.getElementById(id);
  const proto=g('cred-proto')?.value||'https';
  const host=(g('cred-host')?.value||'').trim();
  const port=(g('cred-port')?.value||'').trim();
  const user=g('cred-user')?.value||'';
  const pass=g('cred-pass')?.value||'';
  // Keep the object only while something is set, so blank creds don't bloat saves.
  if(proto==='https'&&!host&&!port&&!user&&!pass)delete d.creds;
  else d.creds={proto,host,port,user,pass};
}
function togglePass(){
  const el=document.getElementById('cred-pass');if(!el)return;
  el.type=el.type==='password'?'text':'password';
}
function openMgmt(){
  const proto=document.getElementById('cred-proto')?.value||'https';
  const d=_selectedDevice();
  const host=(document.getElementById('cred-host')?.value||'').trim()||((d&&d.ip)||'').trim();
  const port=(document.getElementById('cred-port')?.value||'').trim();
  if(!host){toast('No host or IP set');return;}
  if(proto!=='http'&&proto!=='https'){toast('Open supports HTTP/HTTPS only — use an SSH client for '+proto.toUpperCase());return;}
  window.open(`${proto}://${host}${port?':'+port:''}`,'_blank','noopener');
}

// Shared device-image preview + per-device image-URL override. Used by the AP,
// camera and switch panels. The <img> src resolves override → model map →
// category placeholder; broken/offline URLs fall back to the same category
// placeholder via onerror (the resolved data-URI is stashed in data-ph so
// _wireDeviceImg stays clear of inline handlers).
// Resolve a device's preview <img src>: an uploaded image (stored in IndexedDB,
// cached in memory by id) wins, then the per-device URL / model map / category
// placeholder via modelImageUrl. Sync — if an uploaded id isn't cached yet
// (cold right after load) it falls back until preloadDeviceImages() warms it.
function deviceImgSrc(item,type){
  if(item&&item.imgId&&_imgCache.has(item.imgId))return _imgCache.get(item.imgId);
  return modelImageUrl(item,type);
}

// A device's REAL image src (uploaded → pasted URL → bundled model image), or
// '' when only the placeholder would apply. Used by exports, which embed an
// actual photo or nothing — never the "no image" silhouette.
function deviceExportSrc(item){
  if(item&&item.imgId&&_imgCache.has(item.imgId))return _imgCache.get(item.imgId);
  if(item&&item.imageUrl)return item.imageUrl;
  const mapped=item&&item.model&&MODEL_IMAGES[item.model];
  return mapped||'';
}
// Fetch a src and return it as a self-contained data: URL so exported HTML/PDF
// works offline and when emailed. data: URLs pass through; failures return ''.
async function _imgToDataUrl(src){
  if(!src)return '';
  if(src.startsWith('data:'))return src;
  try{
    const r=await fetch(src);
    if(!r.ok)return '';
    const blob=await r.blob();
    return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result||''));fr.onerror=()=>res('');fr.readAsDataURL(blob);});
  }catch{return '';}
}
// Resolve a list of devices to a Map(device → data-URL) for embedding in exports.
async function _resolveExportImages(items){
  const map=new Map();
  await Promise.all((items||[]).map(async it=>{
    const d=await _imgToDataUrl(deviceExportSrc(it));
    if(d)map.set(it,d);
  }));
  return map;
}

function deviceImageBlock(item,type){
  const src=deviceImgSrc(item,type);
  const ph=MODEL_IMAGE_PLACEHOLDERS[type]||MODEL_IMAGE_PLACEHOLDERS.default;
  // An uploaded image lives in IndexedDB (item.imgId); legacy projects may still
  // carry an inline data: URL on item.imageUrl. Either way, don't dump it into
  // the text field — show it empty with a hint instead.
  const isUpload=!!item.imgId||/^data:/.test(item.imageUrl||'');
  const hasOverride=!!(item.imgId||item.imageUrl);
  const urlVal=/^data:/.test(item.imageUrl||'')?'':esc(item.imageUrl||'');
  const urlPh=isUpload?'Uploaded image — Clear to remove':'https://… (overrides model image)';
  return `
    <div class="ep-device-img"><img id="ep-img" src="${esc(src)}" data-ph="${esc(ph)}" alt="${esc(item.model||'device')}"/></div>
    <div class="ep-img-actions">
      <button class="btn ep-img-btn" data-action="upload-device-img">↑ Upload image</button>
      <button class="btn ep-img-btn"${hasOverride?'':' disabled'} data-action="clear-device-img">✕ Clear</button>
      <input type="file" id="ep-img-file" accept="image/*" hidden data-change-action="device-img-file"/>
    </div>
    <div class="ep-row"><label class="ep-lbl">Image URL</label><input class="ep-in ep-mono" id="ep-img-url" value="${urlVal}" data-input-action="upd-img" placeholder="${urlPh}"/></div>`;
}

// Attach the placeholder fallback after a panel sets its innerHTML. Called at
// the tail of each device panel render (and after direct re-renders). Falls back
// to the category placeholder stashed on the img's data-ph attribute.
function _wireDeviceImg(){
  const img=document.getElementById('ep-img');
  if(!img)return;
  img.onerror=()=>{img.onerror=null;img.src=img.dataset.ph||'';};
}

// Refresh the device preview <img> in place to match the item's current model /
// override, without rebuilding the panel. No-op when the resolved URL is
// unchanged so we don't re-trigger a network load on unrelated edits.
function _refreshDeviceImg(item,type){
  const img=document.getElementById('ep-img');
  if(!img||!item)return;
  const next=deviceImgSrc(item,type);
  if(img.getAttribute('src')===next)return;
  _wireDeviceImg();
  img.src=next;
}

// Live-update the selected device's image-URL override and refresh the preview
// without re-rendering the whole panel (keeps the text caret in the input).
function updImg(){
  const item=_selectedDevice();if(!item)return;
  const el=document.getElementById('ep-img-url');if(!el)return;
  const v=el.value.trim();
  snapshotSoon();
  item.imageUrl=v;
  // A typed URL replaces any uploaded image; release the IDB blob.
  if(v&&item.imgId){const old=item.imgId;item.imgId='';idbDeleteImage(old).catch(()=>{});}
  _refreshDeviceImg(item,selType);
}

// Read an image File, downscale it to a sane size, and store it on the selected
// device as a data: URL (self-contained — survives save/load/share with no
// IndexedDB or network). Capped at 512 px and re-encoded so the project file
// stays small. Shared by the Upload button and the drag-and-drop handler.
function _applyDeviceImageFile(file){
  if(!file)return;
  if(!/^image\//.test(file.type)){alert('Please choose an image file.');return;}
  const item=_selectedDevice();
  if(!item)return;
  const objUrl=URL.createObjectURL(file);
  const img=new Image();
  img.onload=async()=>{
    URL.revokeObjectURL(objUrl);
    const MAX=512;
    const w=img.naturalWidth||1, h=img.naturalHeight||1;
    const k=Math.min(1,MAX/Math.max(w,h));
    const cw=Math.max(1,Math.round(w*k)), ch=Math.max(1,Math.round(h*k));
    const cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
    cv.getContext('2d').drawImage(img,0,0,cw,ch);
    let dataUrl;
    try{
      dataUrl=cv.toDataURL('image/webp',0.85);
      if(!/^data:image\/webp/.test(dataUrl))dataUrl=cv.toDataURL('image/jpeg',0.85);
    }catch{dataUrl=cv.toDataURL('image/jpeg',0.85);}
    snapshot();
    // Store in IndexedDB and reference by id so the project JSON / share link
    // stay tiny (mirrors floor-image handling). Fall back to inline if IDB fails.
    const oldId=item.imgId;
    const id=_newImgId();
    try{
      await idbPutImage(id,dataUrl);
      _imgCache.set(id,dataUrl);
      item.imgId=id;item.imageUrl='';
      if(oldId&&oldId!==id)idbDeleteImage(oldId).catch(()=>{});
    }catch{
      item.imgId='';item.imageUrl=dataUrl;
    }
    if(selType==='ap')renderAPPanel();else if(selType==='cam')renderCAMPanel();else if(selType==='sw')renderSWPanel();
    render();renderList();
  };
  img.onerror=()=>{URL.revokeObjectURL(objUrl);alert('Could not read that image.');};
  img.src=objUrl;
}
function uploadDeviceImage(input){
  const file=input.files&&input.files[0];
  input.value='';
  _applyDeviceImageFile(file);
}

// Remove a device's image override (uploaded or URL); reverts to the model
// image or the category placeholder.
function clearDeviceImage(){
  const item=_selectedDevice();if(!item||!(item.imgId||item.imageUrl))return;
  snapshot();
  if(item.imgId){const old=item.imgId;item.imgId='';idbDeleteImage(old).catch(()=>{});}
  item.imageUrl='';
  if(selType==='ap')renderAPPanel();else if(selType==='cam')renderCAMPanel();else if(selType==='sw')renderSWPanel();
  render();renderList();
}

// Warm the in-memory image cache from IndexedDB for every device that
// references an uploaded image (item.imgId), so deviceImgSrc() resolves them
// synchronously. Called after a project loads. Re-renders once warm.
async function preloadDeviceImages(){
  const ids=new Set();
  for(const f of (FLOORS||[])){
    for(const arr of [f.APS,f.CAMS,f.SWS]){
      for(const it of (arr||[]))if(it&&it.imgId&&!_imgCache.has(it.imgId))ids.add(it.imgId);
    }
  }
  if(!ids.size)return;
  await Promise.all([...ids].map(async id=>{
    try{const d=await idbGetImage(id);if(d)_imgCache.set(id,d);}catch{/* skip */}
  }));
  if(selId)renderRP();
  render();
}

// After loading a project FILE (or shared link), import any inline images it
// carries into THIS browser's IndexedDB and re-point the refs locally — so a
// project made on one laptop shows its floor plans and device photos on
// another. Refs without inline data are warmed from local IDB instead.
async function _rehydrateImages(){
  const promote=async(obj)=>{
    if(!obj||!obj.img)return;
    const id=_newImgId();
    try{await idbPutImage(id,obj.img);_imgCache.set(id,obj.img);obj.imgId=id;obj.img='';}
    catch{
      // IndexedDB unavailable (private mode / quota): KEEP the inline image so it
      // still renders — floors via loadFloorImage(f.img), devices via imageUrl.
      if(/^data:/.test(obj.img)&&!obj.imageUrl)obj.imageUrl=obj.img;
    }
  };
  for(const f of (FLOORS||[])){
    await promote(f);
    for(const key of ['APS','CAMS','SWS'])for(const it of (f[key]||[]))await promote(it);
  }
  await preloadDeviceImages();
}

function renderRP(){
  const rph=document.getElementById('rp-head');
  if(!selId){localizeText(rph,'sidebar.properties');rpBody.innerHTML='<div class="rp-empty"><div class="rp-empty-icon">◎</div><div class="rp-empty-txt" data-i18n="sidebar.select">'+esc(t('sidebar.select'))+'</div></div>';return;}
  if(selType==='ap')renderAPPanel();
  else if(selType==='dz')renderDZPanel();
  else if(selType==='sw')renderSWPanel();
  else if(selType==='cam')renderCAMPanel();
  else if(selType==='wall')renderWallPanel();
}

// Storage line for one camera at the project's retention/codec settings.
function _camStorageLabel(c){
  const days=parseInt(SETTINGS.retentionDays,10)||30;
  const br=cameraBitrateMbps(c.resolution||'4K',SETTINGS.storageCodec,c.bitrateMbps);
  const gb=storageGb(br,days);
  return `${br} Mbps → ${gb>=1000?(gb/1000).toFixed(2)+' TB':Math.round(gb)+' GB'} / ${days} d`;
}
// Building-wide recording storage at the current retention/codec settings.
function totalStorageGb(){
  const days=parseInt(SETTINGS.retentionDays,10)||30;
  let gb=0;
  for(const f of FLOORS)for(const c of (f.CAMS||[]))
    gb+=storageGb(cameraBitrateMbps(c.resolution||'4K',SETTINGS.storageCodec,c.bitrateMbps),days);
  return gb;
}
function renderCAMPanel(){
  const c=CAMS().find(x=>x.id===selId);if(!c)return;
  localizeText(document.getElementById('rp-head'),'sidebar.edit_camera');
  const mOpts=buildGroupedOptions(CAM_MODEL_GROUPS,c.model||'G4 Pro');
  const realR=Math.round((c.range||80)*(scaleM/100));
  const swOptions=SWS().map(sw=>`<option value="${esc(sw.id)}"${sw.id===c.swId?' selected':''}>${esc(sw.name)} · ${esc(sw.model||'')}</option>`).join('');
  rpBody.innerHTML=`
    ${deviceImageBlock(c,'cam')}
    <div class="ep-section">Identity</div>
    <div class="ep-row"><label class="ep-lbl">Name</label><input class="ep-in" id="cam-name" value="${esc(c.name)}" data-input-action="upd-cam"/></div>
    <div class="ep-row"><label class="ep-lbl">Model</label><select class="ep-sel" id="cam-model" data-input-action="upd-cam">${mOpts}</select></div>
    <div class="ep-row"><label class="ep-lbl">Resolution</label>
      <select class="ep-sel" id="cam-res" data-input-action="upd-cam">
        ${['8MP','4K','5MP','4MP','2MP','12MP','1080p','720p'].map(r=>`<option${c.resolution===r?' selected':''}>${r}</option>`).join('')}
      </select>
    </div>
    <div class="ep-section">Lens</div>
    <div class="ep-row ep-slider-row">
      <label class="ep-lbl">Field of View</label>
      <input class="ep-rng" id="cam-fov" type="range" min="10" max="360" value="${Math.round(c.fov||80)}" data-input-action="upd-cam-fov"/>
      <span class="ep-rng-val" id="cam-fov-v">${Math.round(c.fov||80)}°</span>
    </div>
    <div class="ep-row ep-slider-row">
      <label class="ep-lbl">View Range</label>
      <input class="ep-rng" id="cam-range" type="range" min="20" max="400" value="${Math.round(c.range||80)}" data-input-action="upd-cam-range"/>
      <span class="ep-rng-val" id="cam-range-v">${realR}m</span>
    </div>
    <div class="ep-row ep-slider-row">
      <label class="ep-lbl">Heading</label>
      <input class="ep-rng" id="cam-heading" type="range" min="0" max="359" value="${Math.round(c.heading||0)}" data-input-action="upd-cam-heading"/>
      <span class="ep-rng-val" id="cam-heading-v">${Math.round(c.heading||0)}°</span>
    </div>
    <div class="ep-section">DORI (IEC 62676-4)</div>
    <div class="ep-row" style="font-family:'Share Tech Mono';font-size:11px;line-height:1.7;display:block">
      ${doriDistancesM(c.resolution||'4K',Math.max(10,Math.min(360,c.fov||80))).map(b=>
        `<span style="color:${b.color}">●</span> ${esc(b.label)} (${b.ppm} px/m) ≤ ${b.m>=100?Math.round(b.m):b.m.toFixed(1)} m<br>`).join('')}
    </div>
    <div class="ep-section">Recording</div>
    <div class="ep-row"><label class="ep-lbl">Bitrate (Mbps)</label><input class="ep-in ep-mono" id="cam-bitrate" type="number" min="0" step="0.5" value="${c.bitrateMbps||''}" data-input-action="upd-cam" placeholder="auto: ${cameraBitrateMbps(c.resolution||'4K',SETTINGS.storageCodec)}"/></div>
    <div class="ep-row"><label class="ep-lbl">Storage</label><span class="ep-rng-val" id="cam-storage-v">${_camStorageLabel(c)}</span></div>
    <div class="ep-section">Color</div>
    <div class="color-swatches">
      ${AP_COLORS.map(col=>{
        const isSel=(c.color||'')===col.value;
        return `<button class="color-swatch${col.value?'':' color-default'}${isSel?' on':''}" ${col.value?`style="background:${col.value}"`:''} data-action="set-cam-color" data-arg="${esc(col.value)}" title="${esc(col.label)}" aria-label="${esc(col.label)}"></button>`;
      }).join('')}
    </div>
    <div class="ep-section">Network / PoE</div>
    <div class="ep-row"><label class="ep-lbl">IP Address</label><input class="ep-in ep-mono" id="cam-ip" value="${esc(c.ip||'')}" data-input-action="upd-cam" placeholder="192.168.1.x"/><button class="btn" style="flex:0 0 auto;padding:4px 8px" data-action="suggest-ip-cam" title="Suggest next free IP in this device's VLAN subnet">IP+</button></div>
    <div class="ep-row"><label class="ep-lbl">MAC Address</label><input class="ep-in ep-mono" id="cam-mac" value="${esc(c.mac||'')}" data-input-action="upd-cam" placeholder="aa:bb:cc:dd:ee:ff"/></div>
    <div class="ep-row"><label class="ep-lbl">Switch</label>
      <select class="ep-sel" id="cam-sw" data-input-action="upd-cam">
        <option value=""${!c.swId?' selected':''}>— None —</option>${swOptions}
      </select>
    </div>
    <div class="ep-row"><label class="ep-lbl">Switch Port</label>${c.swId
      ? portControl(devSwitchPorts(c),c.port,'id="cam-port" data-input-action="upd-cam"')
      : `<input class="ep-in" id="cam-port" value="${esc(c.port||'')}" data-input-action="upd-cam" placeholder="Assign a switch first" disabled/>`}</div>
    <div class="ep-row"><label class="ep-lbl">VLAN</label><input class="ep-in" id="cam-vlan" list="vlan-list" value="${esc(c.vlan||'')}" data-input-action="upd-cam" placeholder="20"/>${vlanDatalist()}</div>
    ${inventoryBlock(c,'cam','upd-cam')}
    <div class="ep-section">Options</div>
    <label class="ep-check"><input type="checkbox" ${c.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    ${credsBlock(c)}
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="cam-notes" rows="3" data-input-action="upd-cam" placeholder="Mount type, lens info, install notes…">${esc(c.notes||'')}</textarea></div>
    <button class="btn ep-del" data-action="ask-del">✕ Delete Camera</button>`;
  _wireDeviceImg();
}
function updCam(){
  const c=CAMS().find(x=>x.id===selId);if(!c)return;
  snapshotSoon();
  const prevModel=c.model;
  c.name=document.getElementById('cam-name').value||c.name;
  c.model=document.getElementById('cam-model').value;
  c.resolution=document.getElementById('cam-res').value;
  c.ip=document.getElementById('cam-ip').value;
  c.mac=document.getElementById('cam-mac').value;
  const prevSwId=c.swId;
  c.swId=document.getElementById('cam-sw').value;
  const portEl=document.getElementById('cam-port');if(portEl)c.port=portEl.value;
  c.vlan=document.getElementById('cam-vlan').value;
  const brEl=document.getElementById('cam-bitrate');
  if(brEl){const br=parseFloat(brEl.value);c.bitrateMbps=Number.isFinite(br)&&br>0?br:0;}
  const stEl=document.getElementById('cam-storage-v');if(stEl)stEl.textContent=_camStorageLabel(c);
  readInventoryBlock(c,'cam');
  c.notes=document.getElementById('cam-notes').value;
  const swChanged=c.swId!==prevSwId;
  if(c.model!==prevModel && CAM_SPECS[c.model]){
    const s=CAM_SPECS[c.model];
    c.fov=s.fov;c.range=Math.round(s.range*100/(scaleM||100));c.resolution=s.res;
    const fovEl=document.getElementById('cam-fov');if(fovEl){fovEl.value=c.fov;document.getElementById('cam-fov-v').textContent=c.fov+'°';}
    const rEl=document.getElementById('cam-range');if(rEl){rEl.value=c.range;document.getElementById('cam-range-v').textContent=Math.round(c.range*(scaleM/100))+'m';}
  }
  if(c.model)SETTINGS.lastCamModel=c.model;
  _refreshDeviceImg(c,'cam');
  render();renderList();
  if(swChanged)renderCAMPanel();
}
function updCamFov(v){const c=CAMS().find(x=>x.id===selId);if(!c)return;snapshotSoon();c.fov=parseInt(v,10);document.getElementById('cam-fov-v').textContent=c.fov+'°';render();}
function updCamRange(v){const c=CAMS().find(x=>x.id===selId);if(!c)return;snapshotSoon();c.range=parseInt(v,10);document.getElementById('cam-range-v').textContent=Math.round(c.range*(scaleM/100))+'m';render();}
function updCamHeading(v){const c=CAMS().find(x=>x.id===selId);if(!c)return;snapshotSoon();c.heading=parseInt(v,10);document.getElementById('cam-heading-v').textContent=c.heading+'°';render();}
function setCamColor(col){const c=CAMS().find(x=>x.id===selId);if(!c)return;snapshot();c.color=col||'';render();renderList();renderCAMPanel();}

function renderWallPanel(){
  const w=WALLS().find(x=>x.id===selId);if(!w)return;
  localizeText(document.getElementById('rp-head'),'sidebar.edit_wall');
  const mat=WALL_MATERIALS[w.material]||WALL_MATERIALS.drywall;
  const px=_wallPx(w);
  const lengthPx=Math.hypot(px.x2-px.x1,px.y2-px.y1);
  const lengthM=(lengthPx*(scaleM/100)).toFixed(1);
  const opts=WALL_MATERIAL_KEYS.map(k=>{
    const m=WALL_MATERIALS[k];
    return `<option value="${k}"${k===w.material?' selected':''}>${esc(m.label)} · ${m.loss} dB</option>`;
  }).join('');
  rpBody.innerHTML=`
    <div class="ep-section">Material</div>
    <div class="ep-row">
      <select class="ep-sel" id="wall-mat" data-change-action="upd-wall">${opts}</select>
    </div>
    <div class="ep-section">Info</div>
    <div class="ep-row">
      <div class="ep-lbl">Length</div>
      <div class="ep-readout">${lengthM} m</div>
    </div>
    <div class="ep-row">
      <div class="ep-lbl">Signal Loss</div>
      <div class="ep-readout">${mat.loss} dB</div>
    </div>
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="wall-notes" rows="3" data-input-action="upd-wall-notes" placeholder="Construction detail, partial-height, glazing…">${esc(w.notes||'')}</textarea></div>
    <button class="btn ep-del" data-action="ask-del">✕ Delete Wall</button>`;
}

function updWall(){
  const w=WALLS().find(x=>x.id===selId);if(!w)return;
  snapshot();
  const sel=document.getElementById('wall-mat');
  if(sel){w.material=sel.value;}
  invalidateCoverageCache();
  render();renderRP();renderList();calcCoverage();
}

function renderAPPanel(){
  const ap=APS().find(a=>a.id===selId);if(!ap)return;
  localizeText(document.getElementById('rp-head'),'sidebar.edit_ap');
  const mOpts=buildGroupedOptions(AP_MODEL_GROUPS,ap.model||'U6 Pro');
  const realR=Math.round(ap.r*(scaleM/100));
  rpBody.innerHTML=`
    ${deviceImageBlock(ap,'ap')}
    <div class="ep-section">Identity</div>
    <div class="ep-row"><label class="ep-lbl">Name</label><input class="ep-in" id="ep-name" value="${ap.name}" data-input-action="upd-ap"/></div>
    <div class="ep-row"><label class="ep-lbl">AP Model</label><select class="ep-sel" id="ep-model" data-input-action="upd-ap">${mOpts}</select></div>
    <div class="ep-row"><label class="ep-lbl">Frequency</label>
      <select class="ep-sel" id="ep-freq" data-input-action="upd-ap">
        <option ${ap.freq==='2.4 / 5 GHz'?'selected':''}>2.4 / 5 GHz</option>
        <option ${ap.freq==='5 GHz only'?'selected':''}>5 GHz only</option>
        <option ${ap.freq==='2.4 GHz only'?'selected':''}>2.4 GHz only</option>
        <option ${ap.freq==='6 GHz (WiFi 6E)'?'selected':''}>6 GHz (WiFi 6E)</option>
      </select></div>
    <div class="ep-section">Signal</div>
    <div class="sig-chips">
      <div class="sig-chip ${ap.sig==='strong'?'on':''}" data-action="set-sig" data-arg="strong">Strong</div>
      <div class="sig-chip ${ap.sig==='medium'?'on':''}" data-action="set-sig" data-arg="medium">Medium</div>
      <div class="sig-chip ${ap.sig==='weak'?'on':''}" data-action="set-sig" data-arg="weak">Weak</div>
    </div>
    <div class="ep-section">Color</div>
    <div class="color-swatches">
      ${AP_COLORS.map(c=>{
        const isSel=(ap.color||'')===c.value;
        const swatchStyle=c.value?`style="background:${c.value}"`:'class-default';
        return `<button class="color-swatch${c.value?'':' color-default'}${isSel?' on':''}" ${c.value?`style="background:${c.value}"`:''} data-action="set-color" data-arg="${esc(c.value)}" title="${esc(c.label)}" aria-label="${esc(c.label)}"></button>`;
      }).join('')}
    </div>
    <div class="ep-section">Coverage Range</div>
    <div class="ep-row ep-slider-row">
      <input class="ep-rng" id="ep-r" type="range" min="15" max="500" value="${Math.round(ap.r)}" data-input-action="upd-ap-r"/>
      <span class="ep-rng-val" id="ep-rv">${realR}m</span>
    </div>
    <div class="ep-section">Antenna Pattern</div>
    <div class="ep-row"><label class="ep-lbl">Pattern</label>
      <select class="ep-sel" id="ep-pattern" data-input-action="upd-ap">
        ${AP_PATTERN_KEYS.map(k=>`<option value="${k}"${(ap.pattern||'omni')===k?' selected':''}>${esc(AP_PATTERNS[k].label)}</option>`).join('')}
      </select>
    </div>
    <div class="ep-row ep-slider-row" id="ep-heading-row" style="${(ap.pattern&&ap.pattern!=='omni'&&ap.pattern!=='ceiling')?'':'display:none'}">
      <label class="ep-lbl">Heading</label>
      <input class="ep-rng" id="ep-heading" type="range" min="0" max="359" value="${Math.round(ap.heading||0)}" data-input-action="upd-ap-heading"/>
      <span class="ep-rng-val" id="ep-heading-v">${Math.round(ap.heading||0)}°</span>
    </div>
    <div class="ep-section">Radio</div>
    <div class="ep-row"><label class="ep-lbl">Channel</label><input class="ep-in ep-mono" id="ep-channel" value="${esc(ap.channel||'auto')}" data-input-action="upd-ap" placeholder="auto · 6 · 36 · 149 …"/></div>
    <div class="ep-row"><label class="ep-lbl">Width (MHz)</label>
      <select class="ep-sel" id="ep-chanwidth" data-input-action="upd-ap">
        ${CHANNEL_WIDTHS.map(cw=>`<option value="${cw}"${(ap.chanWidth||20)===cw?' selected':''}>${cw} MHz${cw===320?' (WiFi 7)':''}</option>`).join('')}
      </select></div>
    <div class="ep-row"><label class="ep-lbl">TX Power</label><input class="ep-in ep-mono" id="ep-txpower" value="${esc(ap.txPower||'auto')}" data-input-action="upd-ap" placeholder="auto · low · medium · high · 20 dBm"/></div>
    <div class="ep-section">Capacity</div>
    <div class="ep-row"><label class="ep-lbl">Clients</label><input class="ep-in ep-mono" id="ep-clients" type="number" min="0" max="500" value="${ap.capacityClients??25}" data-input-action="upd-ap" title="Expected concurrent clients on this AP"/></div>
    <div class="ep-row"><label class="ep-lbl">Airtime est.</label><span class="ep-rng-val" id="ep-airtime-v">${_airtimeLabel(ap)}</span></div>
    <div class="ep-section">Network Info</div>
    <div class="ep-row"><label class="ep-lbl">IP Address</label><input class="ep-in" id="ep-ip" value="${esc(ap.ip||'')}" data-input-action="upd-ap" placeholder="192.168.1.x"/><button class="btn" style="flex:0 0 auto;padding:4px 8px" data-action="suggest-ip-ap" title="Suggest next free IP in this device's VLAN subnet">IP+</button></div>
    <div class="ep-row"><label class="ep-lbl">MAC Address</label><input class="ep-in ep-mono" id="ep-mac" value="${ap.mac||''}" data-input-action="upd-ap" placeholder="aa:bb:cc:dd:ee:ff"/></div>
    <div class="ep-row"><label class="ep-lbl">Switch</label>
      <select class="ep-sel" id="ep-sw" data-input-action="upd-ap">
        <option value=""${!ap.swId?' selected':''}>— None —</option>
        ${SWS().map(sw=>`<option value="${esc(sw.id)}"${sw.id===ap.swId?' selected':''}>${esc(sw.name)} · ${esc(sw.model||'')}</option>`).join('')}
      </select>
    </div>
    <div class="ep-row"><label class="ep-lbl">Switch Port</label>${ap.swId
      ? portControl(devSwitchPorts(ap),ap.port,'id="ep-port" data-input-action="upd-ap"')
      : `<input class="ep-in" id="ep-port" value="${esc(ap.port||'')}" data-input-action="upd-ap" placeholder="Assign a switch first" disabled/>`}</div>
    <div class="ep-row"><label class="ep-lbl">VLAN</label><input class="ep-in" id="ep-vlan" list="vlan-list" value="${esc(ap.vlan||'')}" data-input-action="upd-ap" placeholder="10"/>${vlanDatalist()}</div>
    ${inventoryBlock(ap,'ep','upd-ap')}
    <div class="ep-section">Options</div>
    <label class="ep-check"><input type="checkbox" ${ap.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    <div class="ep-btn-row">
      <button class="btn" data-action="duplicate">⧉ Duplicate</button>
    </div>
    ${credsBlock(ap)}
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="ep-notes" rows="4" data-input-action="upd-ap" placeholder="Cable run, switch port, install notes...">${ap.notes||''}</textarea></div>
    <button class="btn ep-del" data-action="ask-del">✕ Delete AP</button>`;
  _wireDeviceImg();
}

function renderDZPanel(){
  const dz=DZS().find(a=>a.id===selId);if(!dz)return;
  localizeText(document.getElementById('rp-head'),'sidebar.edit_dz');
  const realR=Math.round(dz.r*(scaleM/100));
  rpBody.innerHTML=`
    <div class="ep-section">Label</div>
    <div class="ep-row"><input class="ep-in" id="dz-lbl" value="${dz.label}" data-input-action="upd-dz"/></div>
    <div class="ep-section">Radius</div>
    <div class="ep-row ep-slider-row">
      <input class="ep-rng" id="dz-r" type="range" min="10" max="300" value="${Math.round(dz.r)}" data-input-action="upd-dz-r"/>
      <span class="ep-rng-val" id="dz-rv">${realR}m</span>
    </div>
    <label class="ep-check"><input type="checkbox" ${dz.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="dz-notes" rows="3" data-input-action="upd-dz" placeholder="Why this area is a dead zone, remediation plan…">${esc(dz.notes||'')}</textarea></div>
    <button class="btn ep-del" data-action="ask-del">✕ Delete</button>`;
}

function renderSWPanel(){
  const sw=SWS().find(a=>a.id===selId);if(!sw)return;
  localizeText(document.getElementById('rp-head'),'sidebar.edit_switch');
  const mOpts=buildGroupedOptions(SW_MODEL_GROUPS,sw.model||'USW-24-PoE');
  // If the stored model isn't in our known list, treat it as a custom override
  const isCustom=!SW_MODELS.includes(sw.model||'');
  const a=analyzeSwitch(sw);
  const derivedPorts=swPortCount(sw.model);
  // Any other switch in the building is a candidate uplink target (grouped by
  // floor so risers to another floor are easy to pick).
  const uplinkOpts=FLOORS.map((f,i)=>{
    const opts=(f.SWS||[]).filter(s=>s.id!==sw.id)
      .map(s=>`<option value="${esc(s.id)}"${s.id===sw.uplinkId?' selected':''}>${esc(s.name)} · ${esc(s.model||'')}</option>`).join('');
    return opts?`<optgroup label="${esc(f.name||('Floor '+(i+1)))}">${opts}</optgroup>`:'';
  }).join('');
  const statusColor=a.overBudget||a.overPorts||a.classFails.length?'#c0382b':'#1e7d3c';
  const portTxt=a.ports!=null?`${a.used}/${a.ports}`:`${a.used}`;
  const statusLine=`${a.draw.toFixed(0)} W${a.budget>0?` / ${a.budget} W${a.headroom!=null?` (${a.headroom}% free)`:''}`:''} · ${portTxt} ports${a.swCls?` · ${a.swCls.toUpperCase()}`:' · no PoE'}`;
  rpBody.innerHTML=`
    ${deviceImageBlock(sw,'sw')}
    <div class="ep-section">Identity</div>
    <div class="ep-row"><label class="ep-lbl">Name</label><input class="ep-in" id="sw-name" value="${esc(sw.name)}" data-input-action="upd-sw"/></div>
    <div class="ep-row"><label class="ep-lbl">Model</label><select class="ep-sel" id="sw-model" data-input-action="upd-sw">${mOpts}</select></div>
    <div class="ep-row" id="sw-custom-row" style="${isCustom?'':'display:none'}">
      <label class="ep-lbl">Custom Model Name</label>
      <input class="ep-in" id="sw-model-custom" value="${isCustom?esc(sw.model||''):''}" data-input-action="upd-sw" placeholder="Enter model name"/>
    </div>
    <div class="ep-row"><label class="ep-lbl">IP Address</label><input class="ep-in ep-mono" id="sw-ip" value="${esc(sw.ip||'')}" data-input-action="upd-sw" placeholder="192.168.1.1"/></div>
    <div class="ep-row"><label class="ep-lbl">MAC Address</label><input class="ep-in ep-mono" id="sw-mac" value="${esc(sw.mac||'')}" data-input-action="upd-sw" placeholder="aa:bb:cc:dd:ee:ff"/></div>
    <div class="ep-row"><label class="ep-lbl">PoE Budget (W)</label><input class="ep-in ep-mono" id="sw-poe" type="number" min="0" value="${sw.poeBudget||0}" data-input-action="upd-sw" placeholder="0 for non-PoE"/></div>
    <div class="ep-row"><label class="ep-lbl">Port Count</label><input class="ep-in ep-mono" id="sw-ports" type="number" min="0" value="${sw.ports||''}" data-input-action="upd-sw" placeholder="${derivedPorts!=null?derivedPorts:'auto'}"/></div>
    <div class="ep-row"><label class="ep-lbl">Uplink To</label>
      <select class="ep-sel" id="sw-uplink" data-input-action="upd-sw">
        <option value=""${!sw.uplinkId?' selected':''}>— None (root) —</option>${uplinkOpts}
      </select>
    </div>
    <div class="ep-row" style="font-family:'Share Tech Mono';font-size:11px;color:${statusColor};opacity:.9">${esc(statusLine)}</div>
    <div class="ep-section">Connected Devices (${a.used})</div>
    ${a.clients.length
      ? a.clients.map(c=>`<div class="ep-row"><label class="ep-lbl">${c.type==='AP'?'●':'◉'} ${esc(c.name)}</label>${portControl(a.ports,c.port,`data-input-action="upd-sw-port" data-dev-id="${esc(c.dev.id)}" data-dev-type="${c.type==='AP'?'ap':'cam'}"`)}</div>`).join('')
      : `<div class="ep-row" style="opacity:.6;font-size:11px">None assigned. Set this switch on an AP/camera, or use ⚯ Auto-cable.</div>`}
    <div class="ep-section">Icon Size</div>
    <div class="ep-row ep-slider-row">
      <input class="ep-rng" id="sw-size" type="range" min="10" max="80" value="${sw.size||22}" data-input-action="upd-sw-size"/>
      <span class="ep-rng-val" id="sw-size-v">${sw.size||22}px</span>
    </div>
    ${inventoryBlock(sw,'sw','upd-sw')}
    ${credsBlock(sw)}
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="sw-notes" rows="3" data-input-action="upd-sw" placeholder="Location, uplink, config notes...">${sw.notes||''}</textarea></div>
    <label class="ep-check"><input type="checkbox" ${sw.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    <button class="btn ep-del" data-action="ask-del">✕ Delete</button>`;
  _wireDeviceImg();
}

function updAP(){
  const ap=APS().find(a=>a.id===selId);if(!ap)return;
  snapshotSoon();
  const prevModel=ap.model;
  ap.name=document.getElementById('ep-name').value||ap.name;
  ap.model=document.getElementById('ep-model').value;
  ap.freq=document.getElementById('ep-freq').value;
  const patEl=document.getElementById('ep-pattern');
  if(patEl){
    ap.pattern=patEl.value;
    // Show/hide heading slider for directional patterns
    const row=document.getElementById('ep-heading-row');
    if(row)row.style.display=(ap.pattern==='omni'||ap.pattern==='ceiling')?'none':'';
    invalidateCoverageCache();
  }
  const chEl=document.getElementById('ep-channel');if(chEl)ap.channel=chEl.value;
  const cwEl=document.getElementById('ep-chanwidth');
  if(cwEl){const cw=parseInt(cwEl.value,10);ap.chanWidth=CHANNEL_WIDTHS.includes(cw)?cw:20;}
  const pwEl=document.getElementById('ep-txpower');if(pwEl)ap.txPower=pwEl.value;
  const clEl=document.getElementById('ep-clients');
  if(clEl){const n=parseInt(clEl.value,10);if(Number.isFinite(n)&&n>=0)ap.capacityClients=n;}
  const atEl=document.getElementById('ep-airtime-v');if(atEl)atEl.textContent=_airtimeLabel(ap);
  ap.ip=document.getElementById('ep-ip').value;
  ap.mac=document.getElementById('ep-mac').value;
  const prevSwId=ap.swId;
  const swEl=document.getElementById('ep-sw');if(swEl)ap.swId=swEl.value;
  const portEl=document.getElementById('ep-port');if(portEl)ap.port=portEl.value;
  ap.vlan=document.getElementById('ep-vlan').value;
  readInventoryBlock(ap,'ep');
  const swChanged=ap.swId!==prevSwId;
  ap.notes=document.getElementById('ep-notes').value;
  // If the user just picked a different model, auto-adjust coverage radius
  // to the typical range for that model (user can still override via slider).
  if(ap.model!==prevModel && AP_RANGE_M[ap.model]){
    ap.r=rangeMToPx(AP_RANGE_M[ap.model]);
    // Keep the range slider UI in sync if it's visible
    const slider=document.getElementById('ep-r');
    if(slider){slider.value=ap.r;document.getElementById('ep-rv').textContent=Math.round(ap.r*(scaleM/100))+'m';}
    calcCoverage();
  }
  // Remember this model as the default for the next placed AP.
  if(ap.model)SETTINGS.lastModel=ap.model;
  _refreshDeviceImg(ap,'ap');
  render();renderList();
  // Switch changed → rebuild the panel so the port picker matches the new
  // switch's port count (and enables/disables when (un)assigned).
  if(swChanged)renderAPPanel();
}
function updR(v){const ap=APS().find(a=>a.id===selId);if(!ap)return;snapshotSoon();ap.r=parseInt(v);if(WALLS().length)invalidateCoverageCache();document.getElementById('ep-rv').textContent=Math.round(v*(scaleM/100))+'m';render();calcCoverage();}
function updAPHeading(v){const ap=APS().find(a=>a.id===selId);if(!ap)return;snapshotSoon();ap.heading=parseInt(v,10);invalidateCoverageCache();document.getElementById('ep-heading-v').textContent=ap.heading+'°';render();calcCoverage();}
function setSig(s){const ap=APS().find(a=>a.id===selId);if(!ap)return;snapshot();ap.sig=s;render();renderList();renderAPPanel();}
function setApColor(c){
  const ap=APS().find(a=>a.id===selId);
  if(!ap)return;
  snapshot();
  ap.color=c||'';
  render();renderList();renderAPPanel();
}
function updDZ(){const dz=DZS().find(a=>a.id===selId);if(!dz)return;snapshotSoon();dz.label=document.getElementById('dz-lbl').value||dz.label;const nt=document.getElementById('dz-notes');if(nt)dz.notes=nt.value;render();renderList();}
function updDZR(v){const dz=DZS().find(a=>a.id===selId);if(!dz)return;snapshotSoon();dz.r=parseInt(v);document.getElementById('dz-rv').textContent=Math.round(v*(scaleM/100))+'m';render();}
function updSW(){
  const sw=SWS().find(a=>a.id===selId);if(!sw)return;
  snapshotSoon();
  const prevModel=sw.model;
  sw.name=document.getElementById('sw-name').value||sw.name;
  const dropdown=document.getElementById('sw-model').value;
  const customRow=document.getElementById('sw-custom-row');
  const customInput=document.getElementById('sw-model-custom');
  if(dropdown==='Custom/Other'){
    if(customRow)customRow.style.display='';
    sw.model=customInput&&customInput.value?customInput.value:'Custom/Other';
  }else{
    if(customRow)customRow.style.display='none';
    sw.model=dropdown;
  }
  sw.ip=document.getElementById('sw-ip').value;
  const macEl=document.getElementById('sw-mac');if(macEl)sw.mac=macEl.value;
  readInventoryBlock(sw,'sw');
  const poeEl=document.getElementById('sw-poe');
  if(poeEl)sw.poeBudget=parseInt(poeEl.value,10)||0;
  const portsEl=document.getElementById('sw-ports');
  if(portsEl)sw.ports=parseInt(portsEl.value,10)||0;   // 0/blank → derive from model
  const upEl=document.getElementById('sw-uplink');
  if(upEl)sw.uplinkId=upEl.value;
  sw.notes=document.getElementById('sw-notes').value;
  // Switching to a different known model: adopt its default PoE budget unless
  // the user had set a custom one (i.e. it still matches the old model's default).
  if(sw.model!==prevModel && SW_POE_BUDGET_W[sw.model]!=null){
    const wasDefault=!sw.poeBudget || sw.poeBudget===SW_POE_BUDGET_W[prevModel];
    if(wasDefault){sw.poeBudget=SW_POE_BUDGET_W[sw.model];if(poeEl)poeEl.value=sw.poeBudget;}
  }
  _refreshDeviceImg(sw,'sw');
  render();renderList();
}
function updSWSize(v){
  const sw=SWS().find(a=>a.id===selId);if(!sw)return;
  snapshotSoon();
  sw.size=parseInt(v,10);
  const lbl=document.getElementById('sw-size-v');if(lbl)lbl.textContent=sw.size+'px';
  render();
}

// ═══ LEFT LIST ════════════════════════════════════
function renderList(){
  leftList.innerHTML='';
  const apN=APS().length,swN=SWS().length,dzN=DZS().length,wN=WALLS().length,cmN=CAMS().length;
  const total=apN+swN+dzN+wN+cmN;
  // Per-category counters in the header. Each one styled subtly so the eye lands
  // on the most populous one but they're all readable at a glance.
  const cnts=document.getElementById('sb-counters');
  if(cnts){
    cnts.innerHTML=`
      <span class="cnt-pill" data-i18n-title="report.aps" title="${esc(t('report.aps'))}"><span class="cnt-icon">●</span><span class="cnt-num">${apN}</span><span class="cnt-lbl">APs</span></span>
      <span class="cnt-pill" data-i18n-title="sidebar.switches" title="${esc(t('sidebar.switches'))}"><span class="cnt-icon">⊞</span><span class="cnt-num">${swN}</span><span class="cnt-lbl">SW</span></span>
      <span class="cnt-pill" data-i18n-title="report.cameras" title="${esc(t('report.cameras'))}"><span class="cnt-icon">◉</span><span class="cnt-num">${cmN}</span><span class="cnt-lbl">CAM</span></span>
      <span class="cnt-pill" data-i18n-title="report.dead_zones" title="${esc(t('report.dead_zones'))}"><span class="cnt-icon">⚠</span><span class="cnt-num">${dzN}</span><span class="cnt-lbl">DZ</span></span>
      <span class="cnt-pill" data-i18n-title="sidebar.walls" title="${esc(t('sidebar.walls'))}"><span class="cnt-icon">▌</span><span class="cnt-num">${wN}</span><span class="cnt-lbl">W</span></span>`;
  }
  if(!total){leftList.innerHTML='<div class="empty-msg" data-i18n="sidebar.empty">'+esc(t('sidebar.empty'))+'</div>';return;}

  // Search filter — case-insensitive, matches against multiple fields per item.
  // Empty query returns true for everything, so the no-search case is no-op fast.
  const q=(searchQuery||'').trim().toLowerCase();
  const matches=(...fields)=>{
    if(!q)return true;
    return fields.some(f=>String(f||'').toLowerCase().includes(q));
  };

  const stOk=d=>!statusFilter||(d.status||'planned')===statusFilter;
  const filteredAPs=APS().filter(ap=>stOk(ap)&&matches(ap.name,ap.model,ap.freq,ap.ip,ap.mac,ap.serial,ap.assetTag,ap.notes));
  const filteredSWs=SWS().filter(sw=>stOk(sw)&&matches(sw.name,sw.model,sw.ip,sw.mac,sw.serial,sw.assetTag,sw.notes));
  const filteredCAMs=CAMS().filter(c=>stOk(c)&&matches(c.name,c.model,c.ip,c.mac,c.serial,c.assetTag,c.notes));
  const filteredDZs=DZS().filter(dz=>matches(dz.label));
  const filteredWalls=WALLS().filter(w=>matches((WALL_MATERIALS[w.material]||{}).label));
  const matchTotal=filteredAPs.length+filteredSWs.length+filteredCAMs.length+filteredDZs.length+filteredWalls.length;

  // No matches when there IS a query → friendly "no results" instead of empty space
  if(q&&matchTotal===0){
    leftList.innerHTML=`<div class="no-match-msg">No items match <span class="nm-query">"${esc(searchQuery)}"</span><br>Try a different search.</div>`;
    return;
  }

  if(filteredAPs.length){
    const h=document.createElement('div');h.className='sec-lbl';localizeText(h,'report.aps');leftList.appendChild(h);
    filteredAPs.forEach(ap=>{
      const d=document.createElement('div');d.className='list-item'+(ap.id===selId?' active':'')+(ap.locked?' locked':'');
      const sigDots={strong:'●●●',medium:'●●○',weak:'●○○'}[ap.sig||'strong'];
      const sigClass={strong:'sig-s',medium:'sig-m',weak:'sig-w'}[ap.sig||'strong'];
      const dotStyle=ap.color?` style="background:${esc(ap.color)}"`:'';
      d.innerHTML=`<div class="li-dot"${dotStyle}></div><div class="li-info"><div class="li-name">${esc(ap.name)}<span class="li-status" style="background:${statusMeta(ap).color}" title="${esc(statusMeta(ap).label)}"></span></div><div class="li-sub">${esc(ap.model||'U6 Pro')}</div></div><span class="li-sig ${sigClass}">${sigDots}</span>${ap.locked?'<span class="li-lock">🔒</span>':''}<button class="li-del" data-action="quick-del" data-id="${ap.id}" data-type="ap">✕</button>`;
      d.addEventListener('click',e=>{if(e.target.closest('.li-del'))return;sel(ap.id,'ap',{zoom:true});setMode('sel');});leftList.appendChild(d);
    });
  }
  if(filteredSWs.length){
    const h=document.createElement('div');h.className='sec-lbl';localizeText(h,'sidebar.switches');leftList.appendChild(h);
    filteredSWs.forEach(sw=>{
      const d=document.createElement('div');d.className='list-item sw-item'+(sw.id===selId?' active':'');
      d.innerHTML=`<span style="font-size:12px">⊞</span><div class="li-info"><div class="li-name">${esc(sw.name)}<span class="li-status" style="background:${statusMeta(sw).color}" title="${esc(statusMeta(sw).label)}"></span></div><div class="li-sub">${esc(sw.model||'')}</div></div><button class="li-del" data-action="quick-del" data-id="${sw.id}" data-type="sw">✕</button>`;
      d.addEventListener('click',e=>{if(e.target.closest('.li-del'))return;sel(sw.id,'sw',{zoom:true});setMode('sel');});leftList.appendChild(d);
    });
  }
  if(filteredCAMs.length){
    const h=document.createElement('div');h.className='sec-lbl';localizeText(h,'report.cameras');leftList.appendChild(h);
    filteredCAMs.forEach(c=>{
      const d=document.createElement('div');d.className='list-item cam-item'+(c.id===selId?' active':'')+(c.locked?' locked':'');
      const dotStyle=c.color?` style="background:${esc(c.color)}"`:'';
      d.innerHTML=`<div class="li-dot"${dotStyle}></div><div class="li-info"><div class="li-name">${esc(c.name)}<span class="li-status" style="background:${statusMeta(c).color}" title="${esc(statusMeta(c).label)}"></span></div><div class="li-sub">${esc(c.model||'')} · ${esc(c.resolution||'')}</div></div>${c.locked?'<span class="li-lock">🔒</span>':''}<button class="li-del" data-action="quick-del" data-id="${c.id}" data-type="cam">✕</button>`;
      d.addEventListener('click',e=>{if(e.target.closest('.li-del'))return;sel(c.id,'cam',{zoom:true});setMode('sel');});leftList.appendChild(d);
    });
  }
  if(filteredDZs.length){
    const h=document.createElement('div');h.className='sec-lbl';localizeText(h,'report.dead_zones');leftList.appendChild(h);
    filteredDZs.forEach(dz=>{
      const d=document.createElement('div');d.className='list-item dz-item'+(dz.id===selId?' active':'');
      d.innerHTML=`<span style="font-size:12px">⚠</span><span class="li-name">${esc(dz.label)}</span><button class="li-del" data-action="quick-del" data-id="${dz.id}" data-type="dz">✕</button>`;
      d.addEventListener('click',e=>{if(e.target.closest('.li-del'))return;sel(dz.id,'dz',{zoom:true});setMode('sel');});leftList.appendChild(d);
    });
  }
  if(filteredWalls.length){
    const h=document.createElement('div');h.className='sec-lbl';h.innerHTML=`<span data-i18n="sidebar.walls">${esc(t('sidebar.walls'))}</span> (${filteredWalls.length}${q?' / '+wN:''})`;leftList.appendChild(h);
    filteredWalls.forEach(w=>{
      // Use original WALLS() index for display (W-1, W-2, etc.) so numbers match the master list
      const i=WALLS().indexOf(w);
      const mat=WALL_MATERIALS[w.material]||WALL_MATERIALS.drywall;
      const wpx=_wallPx(w);
      const lenM=(Math.hypot(wpx.x2-wpx.x1,wpx.y2-wpx.y1)*(scaleM/100)).toFixed(1);
      const d=document.createElement('div');
      d.className='list-item'+(w.id===selId?' active':'');
      d.innerHTML=`<span style="font-size:12px">▌</span><div class="li-info"><div class="li-name">Wall ${i+1}</div><div class="li-sub">${esc(mat.label)} · ${lenM} m</div></div><button class="li-del" data-action="quick-del" data-id="${w.id}" data-type="wall">✕</button>`;
      d.addEventListener('click',e=>{if(e.target.closest('.li-del'))return;sel(w.id,'wall',{zoom:true});setMode('sel');});
      leftList.appendChild(d);
    });
  }
}

// ═══ DELETE ═══════════════════════════════════════
function askDel(){
  if(selId==null)return;
  const target={id:selId,type:selType};
  showModalText({i18n:'modal.delete_item'},{i18n:'modal.delete_map'},()=>doDelete(target));
}
function qDel(id,type){
  const target={id,type};
  showModalText({i18n:'modal.delete_item'},{i18n:'modal.remove'},()=>doDelete(target));
}
function doDelete(target){
  if(!target)return;
  const {id,type}=target;
  snapshot();
  const list=type==='ap'?APS():type==='dz'?DZS():type==='sw'?SWS():type==='cam'?CAMS():type==='wall'?WALLS():null;
  if(!list)return;
  const idx=list.findIndex(a=>a.id===id);
  if(idx<0)return;  // already deleted; bail silently
  list.splice(idx,1);
  if(selId===id){selId=null;selType=null;}
  // Wall removal changes coverage shapes everywhere
  if(type==='wall'||type==='ap')invalidateCoverageCache();
  render();renderList();renderRP();calcCoverage();toast('Deleted');
}
let modalCancelCB=null;
// Element focused before the modal opened — focus returns here on close so
// keyboard users aren't dumped back at the top of the document.
let _modalReturnFocus=null;
// Internal: install a body element + buttons + callbacks. `bodyEl` must be a
// DOM node; callers wanting to pass plain text should use showModalText.
function _showModalEl(title,bodyEl,okCB,cancelCB){
  _modalReturnFocus=document.activeElement;
  const titleEl=document.getElementById('mdl-title');
  titleEl.removeAttribute('data-i18n');
  if(title && typeof title==='object' && title.i18n)localizeText(titleEl,title.i18n);
  else titleEl.textContent=title;
  const body=document.getElementById('mdl-body');
  body.replaceChildren(bodyEl);
  modalCB=okCB||null;modalCancelCB=cancelCB||null;
  document.getElementById('mdl').classList.remove('help-modal','wide-modal');
  const ok=document.getElementById('mdl-ok');
  if(ok){ok.style.display=okCB?'':'none';}
  const cancel=document.querySelector('#mdl .mdl-actions .btn:not(#mdl-ok)');
  if(cancel)localizeText(cancel,okCB?'modal.cancel':'modal.close');
  localizeDOM(body);
  document.getElementById('mbg').classList.add('vis');
  // Move focus into the dialog so screen readers announce it and Tab is trapped.
  const mdl=document.getElementById('mdl');
  const first=mdl.querySelector('input,select,textarea,button');
  if(first){try{first.focus();}catch(_){}}
}
// Restore focus to whatever was focused before the modal opened.
function _restoreModalFocus(){
  const el=_modalReturnFocus;_modalReturnFocus=null;
  if(el&&typeof el.focus==='function'){try{el.focus();}catch(_){}}
}
// Keep Tab focus inside an open modal — cycle between first/last focusable.
document.addEventListener('keydown',e=>{
  if(e.key!=='Tab')return;
  const bg=document.getElementById('mbg');
  if(!bg||!bg.classList.contains('vis'))return;
  const mdl=document.getElementById('mdl');
  const items=[...mdl.querySelectorAll('input,select,textarea,button,[href],[tabindex]:not([tabindex="-1"])')]
    .filter(el=>!el.disabled&&el.offsetParent!==null);
  if(!items.length)return;
  const first=items[0],last=items[items.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
},true);
// Plain-text body (auto-escaped). Newlines become <br>.
function showModalText(title,text,okCB,cancelCB){
  const div=document.createElement('div');
  if(text && typeof text==='object' && text.i18n){
    localizeText(div,text.i18n);
    _showModalEl(title,div,okCB,cancelCB);
    return;
  }
  String(text||'').split(/\n/).forEach((line,i,arr)=>{
    div.appendChild(document.createTextNode(line));
    if(i<arr.length-1)div.appendChild(document.createElement('br'));
  });
  _showModalEl(title,div,okCB,cancelCB);
}
// DOM body (caller built the nodes). Safe by construction.
function showModalNode(title,node,okCB,cancelCB){
  _showModalEl(title,node,okCB,cancelCB);
}
// Legacy HTML-string entrypoint. Deprecated — kept so existing callers still
// work, but new code should use showModalText / showModalNode. A template tag
// parses the markup; we then move it into the body. Callers must still esc()
// any user-controlled values they interpolate into the string.
function showModal(title,body,okCB,cancelCB){
  const tpl=document.createElement('template');
  tpl.innerHTML=String(body??'');
  _showModalEl(title,tpl.content,okCB,cancelCB);
}
function closeModal(){
  document.getElementById('mbg').classList.remove('vis');
  pendDel=null;
  _restoreModalFocus();
  if(modalCancelCB){const cb=modalCancelCB;modalCancelCB=null;modalCB=null;cb();return;}
  modalCB=null;
}
function modalOK(){
  const cb=modalCB;modalCB=null;modalCancelCB=null;
  document.getElementById('mbg').classList.remove('vis');pendDel=null;
  _restoreModalFocus();
  if(cb)cb();
}

// ═══ CONTEXT MENU ═════════════════════════════════
// Right-click on any placed item (AP/DZ/SW) opens a floating menu
// with Edit / Duplicate / Lock / Delete. Escape or outside-click closes it.
function showContextMenu(clientX,clientY,items){
  const m=document.getElementById('ctx-menu');
  m.innerHTML=items.map((it,i)=>{
    if(it==='-')return '<div class="ctx-sep"></div>';
    return `<div class="ctx-item${it.disabled?' disabled':''}${it.danger?' danger':''}" data-ctx-idx="${i}">${esc(it.label)}${it.key?`<span class="ctx-key">${esc(it.key)}</span>`:''}</div>`;
  }).join('');
  m.classList.add('vis');
  // Position: keep menu on-screen
  const rect=m.getBoundingClientRect();
  const maxX=window.innerWidth-rect.width-4;
  const maxY=window.innerHeight-rect.height-4;
  m.style.left=Math.min(clientX,maxX)+'px';
  m.style.top=Math.min(clientY,maxY)+'px';
  // Attach one-shot click handler
  const onItemClick=e=>{
    const target=e.target.closest('[data-ctx-idx]');
    if(!target)return;
    const idx=parseInt(target.dataset.ctxIdx,10);
    const it=items[idx];
    if(it&&!it.disabled&&it.action)it.action();
    closeContextMenu();
  };
  m.addEventListener('click',onItemClick,{once:true});
  // Closing it later
  m._cleanup=()=>{m.removeEventListener('click',onItemClick);};
}
function closeContextMenu(){
  const m=document.getElementById('ctx-menu');
  if(!m.classList.contains('vis'))return;
  m.classList.remove('vis');
  if(m._cleanup){m._cleanup();m._cleanup=null;}
  m.innerHTML='';
}
// Dismiss on outside click / scroll / Escape
document.addEventListener('pointerdown',e=>{
  if(e.target.closest('#ctx-menu'))return;
  closeContextMenu();
},true);
window.addEventListener('blur',closeContextMenu);

// Build a menu for an item and show it
function openItemContextMenu(type,id,clientX,clientY){
  const item=type==='ap'?APS().find(a=>a.id===id)
          :type==='dz'?DZS().find(a=>a.id===id)
          :type==='sw'?SWS().find(a=>a.id===id)
          :type==='cam'?CAMS().find(a=>a.id===id):null;
  if(!item)return;
  // Select the item so Edit + Delete use the right target
  sel(id,type);
  const items=[];
  items.push({label:'Edit properties',key:'', action:()=>{sel(id,type);setMode('sel');}});
  if(type==='ap'){
    items.push({label:'Duplicate',key:'Ctrl+D',action:()=>duplicateSelected()});
  }
  items.push({label:item.locked?'Unlock':'Lock',key:'Ctrl+L',action:()=>toggleLock()});
  items.push('-');
  items.push({label:'Delete',key:'Del',danger:true,action:()=>{qDel(id,type);}});
  showContextMenu(clientX,clientY,items);
}
// Right-click on the empty map shouldn't show a browser context menu (we use it for panning).
// But right-click on an item *should* open ours. The item handlers call openItemContextMenu
// which stops propagation, so the viewport-level preventDefault still prevents the native menu.

// ═══ COUNTERS ═════════════════════════════════════
function updateCnt(){document.getElementById('ap-cnt').textContent=APS().length;}

// ═══ PRESENT MODE ═════════════════════════════════
function togglePresent(){
  pres=!pres;
  document.getElementById('btn-pres').classList.toggle('active',pres);
  const button=document.getElementById('btn-pres');
  button.replaceChildren(document.createTextNode(pres?'■ ':'▶ '),document.createElement('span'));
  localizeText(button.lastElementChild,pres?'tb.exit':'tb.present');
  ['hint-bar','left-sb','right-sb'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display=pres?'none':'';});
  // Hide the meta + tools rows, but keep the floor-row so users can still flip floors.
  document.querySelectorAll('.topbar-meta, .topbar-tools').forEach(el=>{el.style.display=pres?'none':'';});
  document.querySelector('.topbar.floor-row').classList.toggle('present-slim',pres);
  setTimeout(fitZoom,50);toast(pres?'Presentation mode — Esc to exit':'Editor mode');
}

// ═══ TOAST ════════════════════════════════════════
let tT;function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');clearTimeout(tT);tT=setTimeout(()=>el.classList.remove('show'),2400);}

// ═══ EXPORT HTML ══════════════════════════════════
// Build the SVG overlay content for a specific floor (walls, switches, APs,
// cameras, dead zones). For the current floor we can use the live coverage
// path cache; for other floors we recompute against their stored width/
// height. Returns {cw, ch, innerSVG} where innerSVG is a string of <g>
// blocks ready to drop inside an <svg>.
function buildFloorOverlaySVG(floor,imgEl){
  const cw=(imgEl&&imgEl.naturalWidth)||1000,ch=(imgEl&&imgEl.naturalHeight)||700;
  const walls=floor.WALLS||[];
  const hasWalls=walls.length>0;
  const aps=floor.APS||[];
  const dzs=floor.DZS||[];
  const sws=floor.SWS||[];
  const cams=floor.CAMS||[];
  const apSVG=aps.map(ap=>{
    if(!Number.isFinite(ap.fx)||!Number.isFinite(ap.fy)||!Number.isFinite(ap.r)||ap.r<=0)return '';
    const cx=(ap.fx*cw).toFixed(1),cy=(ap.fy*ch).toFixed(1),r=ap.r,ri=(r*.54).toFixed(1);
    const ls=Math.max(8,Math.min(14,r*.17)).toFixed(1);
    const col=ap.color||'';
    const oc=col||({strong:'#000',medium:'rgba(0,0,0,.55)',weak:'rgba(0,0,0,.3)'}[ap.sig]);
    const of=col?hexToRgba(col,.08):({strong:'rgba(0,0,0,.04)',medium:'rgba(0,0,0,.035)',weak:'rgba(0,0,0,.025)'}[ap.sig]);
    const innerFill=col?hexToRgba(col,.12):'rgba(0,0,0,.05)';
    const dotFill=col||'#000';
    const lblFill=col||'#000';
    const sw={strong:'1.5',medium:'1.2',weak:'1'}[ap.sig];
    const da=ap.sig==='strong'?'':`stroke-dasharray="${ap.sig==='medium'?'6 3':'3 3'}"`;
    const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
    const opts={rays:COVERAGE_RAYS,bandFactor:bandLossMultiplier(ap.freq),arcDeg:pat.arc,headingDeg:ap.heading||0};
    const outerD=_computeCoveragePath(ap,cw,ch,walls,opts);
    const innerD=_computeCoveragePath({...ap,r:ap.r*.54},cw,ch,walls,opts);
    const outerShape=hasWalls||pat.arc<180
      ? `<path d="${outerD}" fill="${of}" stroke="${oc}" stroke-width="${sw}" ${da}/>`
      : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${of}" stroke="${oc}" stroke-width="${sw}" ${da}/>`;
    const innerShape=hasWalls||pat.arc<180
      ? `<path d="${innerD}" fill="${innerFill}" stroke="${oc}" stroke-width=".8" opacity=".6"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${ri}" fill="${innerFill}" stroke="${oc}" stroke-width=".8" opacity=".6"/>`;
    return `<g>${outerShape}
${innerShape}
<circle cx="${cx}" cy="${cy}" r="7" fill="${dotFill}"/>
<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Rajdhani,sans-serif" font-size="${ls}" font-weight="700" letter-spacing=".04em" fill="${lblFill}" paint-order="stroke" stroke="#efece5" stroke-width="3">${esc(ap.name)}</text>
</g>`;
  }).join('\n');
  const wallSVG=walls.map(w=>{
    const mat=WALL_MATERIALS[w.material]||WALL_MATERIALS.drywall;
    const dash=mat.dash?` stroke-dasharray="${mat.dash}"`:'';
    const px=wallToPx(w,cw,ch);
    return `<line x1="${px.x1.toFixed(1)}" y1="${px.y1.toFixed(1)}" x2="${px.x2.toFixed(1)}" y2="${px.y2.toFixed(1)}" stroke="#000" stroke-width="${mat.strokeWidth}" stroke-linecap="round"${dash}/>`;
  }).join('\n');
  const dzSVG=dzs.map(dz=>{
    if(!Number.isFinite(dz.fx)||!Number.isFinite(dz.fy)||!Number.isFinite(dz.r)||dz.r<=0)return '';
    const cx=(dz.fx*cw).toFixed(1),cy=(dz.fy*ch).toFixed(1);
    return `<g><circle cx="${cx}" cy="${cy}" r="${dz.r}" fill="rgba(0,0,0,.06)" stroke="#000" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="18" fill="#000">⚠</text><text x="${cx}" y="${(parseFloat(cy)+dz.r+11).toFixed(1)}" text-anchor="middle" font-family="Rajdhani,sans-serif" font-size="10" font-weight="700" letter-spacing=".1em" fill="#000" paint-order="stroke" stroke="#efece5" stroke-width="3">${esc((dz.label||'').toUpperCase())}</text></g>`;
  }).join('\n');
  const swSVG=sws.map(sw=>{
    if(!Number.isFinite(sw.fx)||!Number.isFinite(sw.fy))return '';
    const cx=(sw.fx*cw).toFixed(1),cy=(sw.fy*ch).toFixed(1),sz=sw.size||22;
    const iconFs=Math.max(8,sz*.65).toFixed(1);
    const lblFs=Math.max(7,sz*.42).toFixed(1);
    return `<g><rect x="${parseFloat(cx)-sz}" y="${parseFloat(cy)-sz*.6}" width="${sz*2}" height="${sz*1.2}" rx="2" fill="rgba(0,0,0,.04)" stroke="#000" stroke-width="1.2"/><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${iconFs}" fill="#000">⊞</text><text x="${cx}" y="${(parseFloat(cy)+sz*.9).toFixed(1)}" text-anchor="middle" font-family="Rajdhani,sans-serif" font-size="${lblFs}" font-weight="700" letter-spacing=".08em" fill="#000" paint-order="stroke" stroke="#efece5" stroke-width="2.5">${esc((sw.name||'').toUpperCase())}</text></g>`;
  }).join('\n');
  const camSVG=cams.map(c=>{
    if(!Number.isFinite(c.fx)||!Number.isFinite(c.fy))return '';
    const cx=c.fx*cw, cy=c.fy*ch;
    const fov=c.fov||80,heading=c.heading||0,range=c.range||80;
    const col=c.color||'#000';
    let cone;
    if(fov>=350){
      cone=`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${range}" fill="${hexToRgba(col,.12)}" stroke="${col}" stroke-width="1.2" opacity=".85"/>`;
    }else{
      const half=fov/2;
      const a1=(heading-half)*Math.PI/180, a2=(heading+half)*Math.PI/180;
      const x1=cx+Math.cos(a1)*range, y1=cy+Math.sin(a1)*range;
      const x2=cx+Math.cos(a2)*range, y2=cy+Math.sin(a2)*range;
      const largeArc=fov>180?1:0;
      cone=`<path d="M${cx.toFixed(1)},${cy.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} A${range},${range} 0 ${largeArc} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${hexToRgba(col,.12)}" stroke="${col}" stroke-width="1.2" opacity=".85"/>`;
    }
    return `<g>${cone}<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${col}"/>
<text x="${cx.toFixed(1)}" y="${(cy+14).toFixed(1)}" text-anchor="middle" font-family="Rajdhani,sans-serif" font-size="10" font-weight="700" letter-spacing=".08em" fill="${col}" paint-order="stroke" stroke="#efece5" stroke-width="3">${esc((c.name||'').toUpperCase())}</text></g>`;
  }).join('\n');
  return {cw,ch,innerSVG:`${wallSVG}${swSVG}${apSVG}${camSVG}${dzSVG}`};
}
// Legacy single-floor wrapper kept for the HTML export which uses the live
// mapImg.naturalWidth/Height directly.
function buildMapOverlaySVG(){
  return buildFloorOverlaySVG(F(),mapImg);
}
async function doExport(){
  const f=F();const imgSrc=mapImg.src;
  const {cw,ch,innerSVG}=buildMapOverlaySVG();
  const name=f.imgName||'WiFi Map';
  const apImg=await _resolveExportImages(APS());
  const html=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${name} — Coverage | Plexus</title><link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@500;600;700&display=swap" rel="stylesheet"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#efece5;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 18px 40px;font-family:'Rajdhani',sans-serif;color:#000}
.tb{width:100%;max-width:1200px;display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.br{font-size:10px;font-family:'Share Tech Mono',monospace;color:#000;letter-spacing:.2em;text-transform:uppercase;font-weight:700}
.st{font-size:10px;font-family:'Share Tech Mono',monospace;color:rgba(0,0,0,.55);display:flex;align-items:center;gap:6px;letter-spacing:.1em;text-transform:uppercase}
.sd{width:5px;height:5px;border-radius:50%;background:#000}
/* Header pill: standalone block above the map, with breathing space below.
   Hierarchy: Plexus Network Audit dominant (the brand) → project name secondary
   (variable, project-specific) → tagline tertiary on the right. */
.mh{
  width:100%;max-width:1200px;
  display:flex;align-items:center;justify-content:space-between;gap:24px;
  padding:18px 24px;
  background:#efece5;
  border:1px solid #000;border-radius:2px;
  margin-bottom:14px;
}
.mhl{display:flex;flex-direction:column;gap:4px;min-width:0}
.mht{
  font-size:18px;font-weight:700;color:#000;letter-spacing:.04em;
  font-family:'Rajdhani',sans-serif;line-height:1;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.mhs{
  font-size:9px;font-family:'Share Tech Mono',monospace;
  color:rgba(0,0,0,.6);letter-spacing:.18em;text-transform:uppercase;font-weight:700;
  margin-top:2px;
}
.mhm{
  font-size:9px;font-family:'Share Tech Mono',monospace;
  color:rgba(0,0,0,.45);letter-spacing:.2em;text-transform:uppercase;
  flex-shrink:0;
}
#mw{position:relative;width:100%;max-width:1200px;overflow:hidden;border:1px solid #000;border-radius:2px;background:#efece5}
/* Map body — clip the SVG overlay so AP coverage rings near the edge can't
   bleed past the floor plan into surrounding space. */
.mb{position:relative;background:#e9e6df;overflow:hidden}
#mi{width:100%;display:block;filter:grayscale(.15) brightness(1.02);opacity:.92}
#ov{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}
#sl{width:100%;height:100%}
.ml{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:8px 16px;background:#efece5;border-top:1px solid rgba(0,0,0,.12);font-size:9px;font-family:'Share Tech Mono',monospace;color:rgba(0,0,0,.55);letter-spacing:.1em;text-transform:uppercase}
.li{display:flex;align-items:center;gap:5px}
.ld{width:7px;height:7px;border-radius:50%;background:#000}
.lr{width:12px;height:12px;border-radius:50%;border:1.5px solid #000;background:rgba(0,0,0,.04)}
.lb{margin-left:auto;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(0,0,0,.3);letter-spacing:.2em;font-weight:700}
.at{width:100%;max-width:1200px;border-collapse:collapse;margin-top:16px}
.at th{font-size:8px;font-family:'Share Tech Mono',monospace;color:#000;letter-spacing:.15em;text-transform:uppercase;text-align:left;padding:9px 11px;border-bottom:1px solid #000;font-weight:700}
.at td{font-size:11px;font-family:'Rajdhani',sans-serif;color:rgba(0,0,0,.75);padding:7px 11px;border-bottom:1px solid rgba(0,0,0,.08)}
.at td img.thumb{height:24px;width:auto;max-width:40px;object-fit:contain;vertical-align:middle;margin-right:6px}
.ss{color:#000;font-weight:600}.sm{color:rgba(0,0,0,.55);font-weight:600}.sw{color:rgba(0,0,0,.35);font-weight:600}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pulse{0%,100%{r:7;opacity:1}50%{r:10;opacity:.55}}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes dzs{from{transform:rotate(0deg)}to{transform:rotate(-360deg)}}
.ft{width:100%;max-width:1200px;margin-top:18px;padding-top:10px;border-top:1px solid rgba(0,0,0,.2);font-size:9px;font-family:'Share Tech Mono',monospace;color:rgba(0,0,0,.5);letter-spacing:.12em;text-transform:uppercase;text-align:center}
.mhlogo{max-height:38px;max-width:170px;display:block;margin-bottom:7px}
</style></head><body>
<header class="mh"><div class="mhl">${SETTINGS.logoDataUrl?`<img class="mhlogo" src="${esc(SETTINGS.logoDataUrl)}" alt=""/>`:''}<div class="mht">${esc(SETTINGS.reportTitle||name)}</div><div class="mhs">${esc(SETTINGS.company||'Plexus')}${SETTINGS.tagline?' · '+esc(SETTINGS.tagline):''}</div></div><div class="mhm">${esc(SETTINGS.metaLine||'WiFi Coverage Audit')}</div></header>
<div id="mw">
<div class="mb"><img id="mi" src="${imgSrc}" alt="Coverage Map"/><div id="ov"><svg id="sl" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cw} ${ch}" preserveAspectRatio="xMidYMid meet"><defs><filter id="gf"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${innerSVG}</svg></div></div>
<div class="ml"><div class="li"><div class="ld"></div>AP</div><div class="li"><div class="lr"></div>Coverage</div><div class="li">⚠ Dead Zone</div><div class="li">⊞ Switch</div><span class="lb">${esc(SETTINGS.company||'Plexus')}</span></div></div>
${APS().length?`<table class="at"><thead><tr><th>#</th><th>Name</th><th>Model</th><th>Freq</th><th>Ch</th><th>TX</th><th>Signal</th><th>IP</th><th>MAC</th><th>Port</th><th>VLAN</th><th>Notes</th></tr></thead><tbody>${APS().map((ap,i)=>`<tr><td>${i+1}</td><td>${apImg.has(ap)?`<img class="thumb" src="${apImg.get(ap)}" alt=""/>`:''}${ap.name}</td><td>${ap.model||''}</td><td>${ap.freq}</td><td style="font-family:'Share Tech Mono',monospace;font-size:10px">${ap.channel||'auto'}</td><td style="font-family:'Share Tech Mono',monospace;font-size:10px">${ap.txPower||'auto'}</td><td class="${{strong:'ss',medium:'sm',weak:'sw'}[ap.sig]}">${{strong:'● Strong',medium:'● Medium',weak:'● Weak'}[ap.sig]}</td><td style="font-family:'Share Tech Mono',monospace;font-size:10px">${ap.ip||'—'}</td><td style="font-family:'Share Tech Mono',monospace;font-size:10px">${ap.mac||'—'}</td><td>${ap.port||'—'}</td><td>${ap.vlan||'—'}</td><td style="font-size:10px;color:rgba(0,0,0,.55)">${esc(ap.comment||ap.notes||'—')}</td></tr>`).join('')}</tbody></table>`:''}
${SETTINGS.footerLine?`<footer class="ft">${esc(SETTINGS.footerLine)}</footer>`:''}
</body></html>`;
  const blob=new Blob([html],{type:'text/html'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(name||'wifi').replace(/\s+/g,'_')+'_coverage.html';a.click();toast('Exported!');
}

// ═══ PDF ══════════════════════════════════════════
async function doPDF(){
  // Resolve each floor's image (from IDB) and load it into a temporary
  // HTMLImageElement so we know its natural dimensions for the overlay SVG.
  toast('Building PDF…');
  const floorRecords=[];
  for(const f of FLOORS){
    const src=await resolveFloorImage(f).catch(()=>f.img||'');
    let cw=1000,ch=700;
    if(src){
      // Detect dimensions via a transient Image; this avoids depending on the
      // currently-displayed map size.
      try{
        const dims=await new Promise((res,rej)=>{
          const im=new Image();im.onload=()=>res({w:im.naturalWidth,h:im.naturalHeight});im.onerror=rej;im.src=src;
        });
        cw=dims.w;ch=dims.h;
      }catch(_){}
    }
    const overlay=buildFloorOverlaySVG(f,{naturalWidth:cw,naturalHeight:ch});
    const cov=_sampleFloorCoverage(f,cw,ch);
    const pct=cov.total?Math.round(cov.covered/cov.total*100):0;
    floorRecords.push({floor:f,src,overlay,pct});
  }
  // Whole-building coverage rollup (weighted by floor sample counts).
  let allC=0,allT=0;
  for(const r of floorRecords){
    const c=_sampleFloorCoverage(r.floor,r.overlay.cw,r.overlay.ch);
    allC+=c.covered;allT+=c.total;
  }
  const buildingPct=allT?Math.round(allC/allT*100):0;

  // Build per-floor section HTML.
  const sigName={strong:'Strong',medium:'Medium',weak:'Weak'};
  // Resolve product photos for every AP and camera to inline data: URLs once.
  const _allDev=[];
  for(const f of FLOORS){for(const ap of (f.APS||[]))_allDev.push(ap);for(const c of (f.CAMS||[]))_allDev.push(c);}
  const devImg=await _resolveExportImages(_allDev);
  const floorSections=floorRecords.map((r,fi)=>{
    const f=r.floor;
    const aps=f.APS||[],sws=f.SWS||[],cams=f.CAMS||[],dzs=f.DZS||[];
    const apTable=aps.length?`<h3>Access Points (${aps.length})</h3><table><thead><tr><th>#</th><th>Name</th><th>Model</th><th>Freq</th><th>Pattern</th><th>Ch</th><th>TX</th><th>Signal</th><th>IP</th><th>MAC</th><th>Switch</th><th>Port</th><th>VLAN</th></tr></thead><tbody>${aps.map((ap,i)=>{
      const swName=(sws.find(s=>s.id===ap.swId)||{}).name||'—';
      const patLbl=(AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni).label;
      const apNote=ap.comment||ap.notes||'';
      return `<tr><td>${i+1}</td><td>${devImg.has(ap)?`<img class="thumb" src="${devImg.get(ap)}" alt=""/>`:''}<strong>${esc(ap.name)}</strong></td><td>${esc(ap.model||'—')}</td><td>${esc(ap.freq||'')}</td><td>${esc(patLbl)}</td><td class="mono">${esc(ap.channel||'auto')}</td><td class="mono">${esc(ap.txPower||'auto')}</td><td class="sig-${(ap.sig||'strong')[0]}">● ${sigName[ap.sig||'strong']}</td><td class="mono">${esc(ap.ip||'—')}</td><td class="mono">${esc(ap.mac||'—')}</td><td>${esc(swName)}</td><td class="mono">${ap.swId?esc(ap.port||'—'):'—'}</td><td>${esc(ap.vlan||'—')}</td></tr>${apNote?`<tr class="note-row"><td colspan="13">${esc(apNote)}</td></tr>`:''}`;
    }).join('')}</tbody></table>`:'';
    const camTable=cams.length?`<h3>Cameras (${cams.length})</h3><table><thead><tr><th>#</th><th>Name</th><th>Model</th><th>Resolution</th><th>FoV</th><th>Range</th><th>Heading</th><th>IP</th><th>Switch</th><th>Port</th><th>VLAN</th></tr></thead><tbody>${cams.map((c,i)=>{
      const swName=(sws.find(s=>s.id===c.swId)||{}).name||'—';
      const rangeM=Math.round((c.range||80)*((f.scaleM||100)/100));
      const camNote=c.comment||c.notes||'';
      return `<tr><td>${i+1}</td><td>${devImg.has(c)?`<img class="thumb" src="${devImg.get(c)}" alt=""/>`:''}<strong>${esc(c.name)}</strong></td><td>${esc(c.model||'—')}</td><td class="mono">${esc(c.resolution||'')}</td><td class="mono">${c.fov||80}°</td><td class="mono">${rangeM} m</td><td class="mono">${c.heading||0}°</td><td class="mono">${esc(c.ip||'—')}</td><td>${esc(swName)}</td><td class="mono">${c.swId?esc(c.port||'—'):'—'}</td><td>${esc(c.vlan||'—')}</td></tr>${camNote?`<tr class="note-row"><td colspan="11">${esc(camNote)}</td></tr>`:''}`;
    }).join('')}</tbody></table>`:'';
    const swTable=sws.length?`<h3>Switches / Routers (${sws.length})</h3><table><thead><tr><th>Name</th><th>Model</th><th>IP</th><th>PoE Budget</th><th>Ports</th><th>Uplink</th><th>Notes</th></tr></thead><tbody>${sws.map(sw=>{
      const a=analyzeSwitch(sw,f);
      const budgetStr=sw.poeBudget?`${a.draw.toFixed(0)} W / ${sw.poeBudget} W`:'—';
      const over=a.overBudget?' style="color:#c0382b;font-weight:700"':'';
      const portStr=a.ports!=null?`${a.used} / ${a.ports}`:`${a.used}`;
      const portOver=a.overPorts?' style="color:#c0382b;font-weight:700"':'';
      const upName=sw.uplinkId?((sws.find(s=>s.id===sw.uplinkId)||{}).name||'—'):'—';
      return `<tr><td><strong>${esc(sw.name)}</strong></td><td>${esc(sw.model||'—')}</td><td class="mono">${esc(sw.ip||'—')}</td><td class="mono"${over}>${budgetStr}</td><td class="mono"${portOver}>${portStr}</td><td>${esc(upName)}</td><td class="muted">${esc(sw.comment||sw.notes||'—')}</td></tr>`;
    }).join('')}</tbody></table>`:'';
    const dzTable=dzs.length?`<h3>Dead Zones (${dzs.length})</h3><table><thead><tr><th>Label</th><th>Notes</th></tr></thead><tbody>${dzs.map(dz=>`<tr><td>${esc(dz.label||'—')}</td><td class="muted">${esc(dz.comment||dz.notes||'—')}</td></tr>`).join('')}</tbody></table>`:'';
    const mapBlock=r.src
      ? `<div class="map-wrap"><img src="${r.src}" alt="Map"/><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r.overlay.cw} ${r.overlay.ch}" preserveAspectRatio="xMidYMid meet">${r.overlay.innerSVG}</svg></div>`
      : `<div class="map-wrap empty"><span>No floor plan uploaded for this floor.</span></div>`;
    return `<section class="floor-sec${fi>0?' page-break':''}">
  <h2>${esc(f.name||('Floor '+(fi+1)))}<span class="floor-cov"> · ${r.pct}% coverage</span></h2>
  <div class="floor-meta">${aps.length} AP${aps.length===1?'':'s'} · ${cams.length} camera${cams.length===1?'':'s'} · ${sws.length} switch${sws.length===1?'':'es'} · ${(f.WALLS||[]).length} wall${(f.WALLS||[]).length===1?'':'s'} · scale ${f.scaleM||100} m/100px</div>
  ${mapBlock}
  ${apTable}${camTable}${swTable}${dzTable}
</section>`;
  }).join('\n');

  const w=window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${esc(SETTINGS.company||'Plexus')} — ${esc(SETTINGS.reportTitle||'Network Audit Report')}</title><link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#efece5;font-family:'Rajdhani',sans-serif;color:#000;padding:44px 48px;min-height:100vh}
.cover{text-align:left;padding:8px 0 40px;border-bottom:1px solid #000;margin-bottom:40px;position:relative}
.cover-meta{font-size:10px;font-family:'Share Tech Mono',monospace;color:#000;letter-spacing:.2em;text-transform:uppercase;font-weight:700;margin-bottom:60px}
.logo{font-size:88px;font-weight:700;color:#000;letter-spacing:-.02em;line-height:.95;font-family:'Rajdhani',sans-serif}
.tagline{font-size:11px;font-family:'Share Tech Mono',monospace;color:#000;letter-spacing:.2em;text-transform:uppercase;font-weight:700;margin-top:28px;padding-top:14px;border-top:1px solid rgba(0,0,0,.15)}
.doc-title{font-size:22px;font-weight:600;color:#000;margin-top:32px;letter-spacing:.02em}
.doc-sub{font-size:11px;font-family:'Share Tech Mono',monospace;color:rgba(0,0,0,.55);margin-top:6px;letter-spacing:.1em;text-transform:uppercase}
.cover-stats{margin-top:24px;display:flex;gap:32px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase}
.cover-stat strong{display:block;font-size:32px;font-family:'Rajdhani',sans-serif;font-weight:700;letter-spacing:-.02em;line-height:1}
h2{font-size:13px;color:#000;letter-spacing:.2em;text-transform:uppercase;margin:36px 0 8px;padding-bottom:8px;border-bottom:1px solid #000;font-weight:700;font-family:'Share Tech Mono',monospace;display:flex;justify-content:space-between;align-items:baseline}
.floor-cov{font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:600;letter-spacing:0;text-transform:none;color:#1e7d3c}
h3{font-size:10px;color:rgba(0,0,0,.7);letter-spacing:.15em;text-transform:uppercase;margin:22px 0 10px;font-weight:700;font-family:'Share Tech Mono',monospace}
.floor-sec.page-break{page-break-before:always}
.floor-meta{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(0,0,0,.55);margin-bottom:14px}
.map-wrap{position:relative;width:100%;border:1px solid #000;background:#e9e6df;overflow:hidden;margin-bottom:8px}
.map-wrap img{width:100%;display:block;filter:grayscale(.15) brightness(1.02)}
.map-wrap svg{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}
.map-wrap.empty{aspect-ratio:1200/700;display:flex;align-items:center;justify-content:center;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:rgba(0,0,0,.45)}
table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:11px}
th{background:#efece5;color:#000;font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:.15em;text-transform:uppercase;text-align:left;padding:9px 11px;border-bottom:1px solid #000;font-weight:700}
td{padding:8px 11px;border-bottom:1px solid rgba(0,0,0,.08);vertical-align:top;color:rgba(0,0,0,.8)}
.sig-s{color:#000;font-weight:700}.sig-m{color:rgba(0,0,0,.6);font-weight:600}.sig-w{color:rgba(0,0,0,.35);font-weight:500}
.mono{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:.02em}
.muted{font-size:10px;color:rgba(0,0,0,.5)}
img.thumb{height:26px;width:auto;max-width:44px;object-fit:contain;vertical-align:middle;margin-right:6px}
.note-row td{font-size:10px;color:rgba(0,0,0,.6);font-style:italic;padding-top:2px;border-bottom:1px solid rgba(0,0,0,.08)}
.note-row td::before{content:'↳ ';font-style:normal;color:rgba(0,0,0,.35)}
.cover-logo{max-height:64px;max-width:260px;display:block;margin-bottom:26px}
.footer-line{margin-top:8px;font-size:9px;color:rgba(0,0,0,.5);font-family:'Share Tech Mono',monospace;letter-spacing:.14em;text-transform:uppercase;text-align:center}
.footer{margin-top:48px;padding-top:16px;border-top:1px solid #000;font-size:9px;color:#000;font-family:'Share Tech Mono',monospace;display:flex;justify-content:space-between;letter-spacing:.15em;text-transform:uppercase;font-weight:700}
.print-btn{margin-top:24px;padding:12px 28px;background:#000;color:#efece5;border:none;border-radius:2px;font-size:11px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-weight:700;letter-spacing:.2em;text-transform:uppercase}
.print-btn:hover{background:rgba(0,0,0,.8)}
@media print{body{padding:24px 28px;background:#fff}.print-btn{display:none}.cover{page-break-after:always}h2,h3{page-break-after:avoid}table{page-break-inside:auto}tr{page-break-inside:avoid}.floor-sec{page-break-inside:avoid}}
</style></head><body>
<div class="cover">
  ${SETTINGS.metaLine?`<div class="cover-meta">${esc(SETTINGS.metaLine)}</div>`:''}
  ${SETTINGS.logoDataUrl?`<img class="cover-logo" src="${esc(SETTINGS.logoDataUrl)}" alt=""/>`:''}
  <div class="logo">${esc(SETTINGS.company||'Plexus')}</div>
  ${SETTINGS.tagline?`<div class="tagline">${esc(SETTINGS.tagline)}</div>`:''}
  <div class="doc-title">${esc(SETTINGS.reportTitle||'Network Audit Report')}</div>
  <div class="doc-sub">${new Date().toLocaleDateString(SETTINGS.locale||'en-GB')}${SETTINGS.contact?' · '+esc(SETTINGS.contact):''}</div>
  <div class="cover-stats">
    <div class="cover-stat"><strong>${FLOORS.length}</strong>${FLOORS.length===1?'Floor':'Floors'}</div>
    <div class="cover-stat"><strong>${FLOORS.reduce((n,f)=>n+(f.APS||[]).length,0)}</strong>Access points</div>
    <div class="cover-stat"><strong>${FLOORS.reduce((n,f)=>n+(f.CAMS||[]).length,0)}</strong>Cameras</div>
    <div class="cover-stat"><strong>${FLOORS.reduce((n,f)=>n+(f.SWS||[]).length,0)}</strong>Switches</div>
    <div class="cover-stat"><strong>${buildingPct}%</strong>Coverage</div>
    <div class="cover-stat"><strong>~${totalClientCapacity()}</strong>Client capacity</div>
  </div>
</div>
${floorSections}
${reportNetworkHtml()}
<div class="footer"><span>${esc(SETTINGS.company||'Plexus')}${SETTINGS.contact?' · '+esc(SETTINGS.contact):''}</span><span>Generated ${new Date().toLocaleString(SETTINGS.locale||'en-GB')}</span></div>
${SETTINGS.footerLine?`<div class="footer-line">${esc(SETTINGS.footerLine)}</div>`:''}
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
</body></html>`);
  w.document.close();
  toast('PDF preview opened — use Print to save as PDF');
}

// ═══ INIT ═════════════════════════════════════════
window.addEventListener('resize',()=>{render();renderMM();updateScaleBar();});

// ── Autosave to localStorage ──────────────────────
// Silent save every 10s; full state is captured so a refresh doesn't lose work.
// Note: if the user has a very large embedded floor-plan image, the payload may
// exceed the 5MB localStorage quota — we catch that and skip silently.
const AUTOSAVE_KEY='noctis_wifi_autosave';
const AUTOSAVE_INTERVAL_MS=10000;
let lastAutosavePayload='';

let _autosaveQuotaWarned=false;
function autosave(){
  // Skip when the tab is not visible — the user isn't making changes, and
  // running the JSON.stringify on every tick in a backgrounded tab is wasteful.
  // Images live in IndexedDB now (referenced by imgId), so the autosave payload
  // is a few KB even with multi-floor projects.
  if(typeof document!=='undefined'&&document.hidden)return;
  try{
    // When a credentials passphrase is set, never write plaintext creds to
    // localStorage — strip them from the autosave payload (the encrypted copy
    // lives only in explicitly-saved project files).
    const replacer=_credPass
      ? (k,v)=>(k.startsWith('_')||k==='creds')?undefined:v
      : _stripCacheReplacer;
    const payload=JSON.stringify({version:PROJECT_VERSION,settings:SETTINGS,floors:FLOORS,revisions:PROJECT_REVISIONS,savedAt:new Date().toISOString()},replacer);
    if(payload===lastAutosavePayload)return;  // nothing changed
    localStorage.setItem(AUTOSAVE_KEY,payload);
    lastAutosavePayload=payload;
    _autosaveQuotaWarned=false;
  }catch(err){
    // QuotaExceededError — floor-plan images can be large. Tell the user once
    // per session so they know to use Save instead of relying on autosave.
    const isQuota=err&&(err.name==='QuotaExceededError'||err.code===22||err.code===1014);
    if(isQuota&&!_autosaveQuotaWarned){
      _autosaveQuotaWarned=true;
      toast('Autosave full — use Save to keep your work');
    }
  }
}
function tryRestoreAutosave(){
  try{
    const raw=localStorage.getItem(AUTOSAVE_KEY);
    if(!raw)return false;
    const data=JSON.parse(raw);
    // Only offer to restore if there's actually content
    const hasContent=(data.floors||[]).some(f=>(f.APS&&f.APS.length)||(f.DZS&&f.DZS.length)||(f.SWS&&f.SWS.length)||f.img||f.imgId);
    if(!hasContent){localStorage.removeItem(AUTOSAVE_KEY);return false;}
    const when=data.savedAt?new Date(data.savedAt).toLocaleString():'previous session';
    showModalText({i18n:'modal.restore_session'},`A saved session from ${when} was found.\n\nRestore it, or start fresh?`,
      async ()=>{
        const [migrated]=migrateProject(data);
        FLOORS=migrated.floors;
        SETTINGS={...DEFAULT_SETTINGS,...(migrated.settings||{})};
        applyStoredCatalog();
        PROJECT_REVISIONS=Array.isArray(migrated.revisions)?migrated.revisions:[];
        setLang(SETTINGS.language||'en');
        curFloor=0;selId=null;selType=null;
        syncScaleFromFloor();
        syncNidFromFloors();
        // Import any inline images (legacy autosave / device uploads) into IDB
        // and warm the cache.
        await _rehydrateImages();
        applySettingsToBrand();
        loadFloorImage();renderFloorTabs();render();renderList();renderRP();calcCoverage();
        toast('Session restored');
      },
      ()=>{localStorage.removeItem(AUTOSAVE_KEY);}
    );
    return true;
  }catch(err){
    localStorage.removeItem(AUTOSAVE_KEY);
    return false;
  }
}
setInterval(autosave,AUTOSAVE_INTERVAL_MS);
// Save immediately when the user returns to the tab, or is about to close it —
// this catches changes that happened in the last interval-tick or while hidden.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)autosave();});
window.addEventListener('beforeunload',autosave);

renderFloorTabs();renderList();renderRP();applySettingsToBrand();

// ═══ EVENT DELEGATION ═════════════════════════════
// Inline onclick/onchange were replaced with data-action attributes.
// One delegated listener dispatches to the right handler.
const CLICK_ACTIONS={
  'open-upload':   ()=>document.getElementById('file-up').click(),
  'open-svg':      ()=>document.getElementById('svg-up').click(),
  'detect-walls':  ()=>detectWallsFromMap(),
  'open-dxf':      ()=>document.getElementById('dxf-up')?.click(),
  'open-esx':      ()=>document.getElementById('esx-up')?.click(),
  'export-esx':    ()=>doExportEsx(),
  'show-unifi':    ()=>showUnifiDialog(),
  'open-load':     ()=>document.getElementById('load-up').click(),
  'load-sample':   ()=>loadSampleProject(),
  'save':          ()=>saveProject(),
  'share-link':    ()=>shareLink(),
  'new-project':   ()=>newProject(),
  'set-mode':      (arg)=>setMode(arg),
  'zoom-in':       ()=>smoothZoom(+.18),
  'zoom-out':      ()=>smoothZoom(-.18),
  'zoom-fit':      ()=>fitZoom(),
  'toggle-ol':     ()=>toggleOL(),
  'toggle-heat':   ()=>toggleHeat(),
  'toggle-grid':   ()=>toggleGrid(),
  'toggle-cables': ()=>toggleCables(),
  'toggle-coverage':()=>toggleCoverage(),
  'auto-place':    ()=>autoPlaceAPs(),
  'show-poe':      ()=>showPoESummary(),
  'calibrate-scale':()=>calibrateScale(),
  'auto-assign-sw':()=>autoAssignSwitches(),
  'show-topology': ()=>showTopology(),
  'show-validation':()=>showValidation(),
  'suggest-ip-ap': ()=>suggestIp('ap'),
  'suggest-ip-cam':()=>suggestIp('cam'),
  'toggle-pass':   ()=>togglePass(),
  'open-mgmt':     (_,e)=>{if(e)e.preventDefault();openMgmt();},
  'toggle-vlan-colors':()=>{SETTINGS.colorByVlan=!SETTINGS.colorByVlan;document.getElementById('btn-vlan')?.classList.toggle('active',SETTINGS.colorByVlan);render();autosave();},
  'undo':          ()=>undo(),
  'redo':          ()=>redo(),
  'toggle-present':()=>togglePresent(),
  'export':        ()=>doExport(),
  'pdf':           ()=>doPDF(),
  'add-floor':     ()=>addFloor(),
  'modal-close':   ()=>closeModal(),
  'modal-ok':      ()=>modalOK(),
  'show-help':     ()=>showHelp(),
  'show-settings': ()=>showSettings(),
  'toggle-theme':  ()=>toggleTheme(),
  // v3 additions
  'toggle-roaming':()=>{SETTINGS.showRoamingOverlap=!SETTINGS.showRoamingOverlap;document.getElementById('btn-roaming')?.classList.toggle('active',SETTINGS.showRoamingOverlap);render();autosave();},
  'cycle-heatmap-mode':()=>cycleHeatmapMode(),
  'cycle-heatmap-band':()=>cycleHeatmapBand(),
  'auto-channel': ()=>autoChannelPlan(),
  'auto-power':   ()=>autoTxPower(),
  'export-bom':   ()=>doBomCsv(),
  'export-cables':()=>doCableCsv(),
  'install-sheets':()=>doInstallSheets(),
  // Organization features
  'show-inventory':()=>showInventory(),
  'handover-pack': ()=>doHandoverPack(),
  'export-ip-plan':()=>doIpPlanCsv(),
  'export-port-map':()=>doPortMapCsv(),
  'export-inventory':()=>doInventoryCsv(),
  'auto-assign-ips':()=>autoAssignIps(),
  'auto-rename':   ()=>autoRenameDevices(),
  'open-survey':  ()=>document.getElementById('survey-up')?.click(),
  'show-plugins': ()=>showPluginCatalogDialog(),
  'show-revisions':()=>showRevisions(),
  'anno-sub':     (arg)=>setAnnoSubMode(arg),
  // Item/panel actions (previously inline)
  'set-sig':       (arg)=>setSig(arg),
  'set-color':     (arg)=>setApColor(arg),
  'set-cam-color': (arg)=>setCamColor(arg),
  'upload-device-img':()=>document.getElementById('ep-img-file')?.click(),
  'clear-device-img':()=>clearDeviceImage(),
  'duplicate':     ()=>duplicateSelected(),
  'ask-del':       ()=>askDel(),
  'quick-del':     (_,e,t)=>{e.stopPropagation();qDel(t.dataset.id,t.dataset.type);},
  'sb-search-clear':()=>{clearSearch();},
};
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-action]');
  if(!t)return;
  const fn=CLICK_ACTIONS[t.dataset.action];
  if(fn)fn(t.dataset.arg,e,t);
});
document.addEventListener('change',e=>{
  const t=e.target.closest('[data-change-action]');
  if(!t)return;
  const a=t.dataset.changeAction;
  if(a==='upload-map')uploadMap(t);
  else if(a==='import-svg-walls')importSvgWalls(t);
  else if(a==='import-dxf-walls')importDxfWalls(t);
  else if(a==='import-esx')importEsxFile(t);
  else if(a==='load-project')loadProject(t);
  else if(a==='toggle-lock')toggleLock();
  else if(a==='upd-wall')updWall();
  else if(a==='import-survey-csv')importSurveyCsv(t);
  else if(a==='device-img-file')uploadDeviceImage(t);
});
// Safety net: a file dropped ANYWHERE on the page (e.g. a near-miss of the
// preview box) would otherwise make the browser navigate to that file and
// unload the app — losing the survey. Swallow file drags that aren't handled
// by a specific drop zone below. Only acts on file drags, leaving other DnD
// (text, etc.) untouched.
const _isFileDrag=e=>{try{return e.dataTransfer&&[...e.dataTransfer.types].includes('Files');}catch{return false;}};
window.addEventListener('dragover',e=>{if(_isFileDrag(e))e.preventDefault();});
window.addEventListener('drop',e=>{
  if(_isFileDrag(e)&&!(e.target.closest&&e.target.closest('.ep-device-img')))e.preventDefault();
});
// Drag-and-drop an image file onto the device preview box to set its photo.
document.addEventListener('dragover',e=>{
  const box=e.target.closest&&e.target.closest('.ep-device-img');
  if(!box)return;
  e.preventDefault();
  if(e.dataTransfer)e.dataTransfer.dropEffect='copy';
  box.classList.add('drag-over');
});
document.addEventListener('dragleave',e=>{
  const box=e.target.closest&&e.target.closest('.ep-device-img');
  if(box&&!box.contains(e.relatedTarget))box.classList.remove('drag-over');
});
document.addEventListener('drop',e=>{
  const box=e.target.closest&&e.target.closest('.ep-device-img');
  if(!box)return;
  e.preventDefault();
  box.classList.remove('drag-over');
  const file=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
  _applyDeviceImageFile(file);
});
// Paste an image from the clipboard (Ctrl/Cmd+V) onto the selected device.
// Ignored while typing in a field so text paste (e.g. into Image URL) is intact.
document.addEventListener('paste',e=>{
  if(!_selectedDevice())return;
  const t=e.target;
  if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable))return;
  const items=(e.clipboardData&&e.clipboardData.items)||[];
  for(const it of items){
    if(it.type&&it.type.startsWith('image/')){
      const file=it.getAsFile();
      if(file){e.preventDefault();_applyDeviceImageFile(file);return;}
    }
  }
});
// Blur on a panel input (or pointerup ending a slider drag) commits any
// pending debounced snapshot so the next edit starts a fresh undo step.
document.addEventListener('blur',e=>{
  const t=e.target;
  if(t&&t.dataset&&(t.dataset.inputAction||t.dataset.changeAction))snapshotFlush();
},true);
document.addEventListener('change',e=>{
  const t=e.target;
  if(t&&t.type==='range')snapshotFlush();
},true);

document.addEventListener('input',e=>{
  const t=e.target.closest('[data-input-action]');
  if(!t)return;
  const a=t.dataset.inputAction;
  if(a==='update-scale')updateScale();
  else if(a==='upd-ap')updAP();
  else if(a==='upd-ap-r')updR(t.value);
  else if(a==='upd-ap-heading')updAPHeading(t.value);
  else if(a==='upd-dz')updDZ();
  else if(a==='upd-dz-r')updDZR(t.value);
  else if(a==='upd-wall-notes'){const w=WALLS().find(x=>x.id===selId);if(w){snapshotSoon();w.notes=t.value;}}
  else if(a==='upd-sw')updSW();
  else if(a==='upd-creds')updCreds();
  else if(a==='upd-sw-port')updSwPort(t);
  else if(a==='upd-sw-size')updSWSize(t.value);
  else if(a==='upd-img')updImg();
  else if(a==='upd-cam')updCam();
  else if(a==='upd-cam-fov')updCamFov(t.value);
  else if(a==='upd-cam-range')updCamRange(t.value);
  else if(a==='upd-cam-heading')updCamHeading(t.value);
  else if(a==='status-filter'){
    statusFilter=t.value;
    renderList();render();
  }
  else if(a==='sb-search'){
    searchQuery=t.value;
    // Reflect "has-text" state on the row so the clear (×) button shows up
    const row=t.closest('.sb-search-row');
    if(row)row.classList.toggle('has-text',!!t.value);
    // Debounce — typing fast shouldn't re-render the list per keystroke.
    clearTimeout(_searchT);
    _searchT=setTimeout(renderList,90);
  }
});

// ═══ KEYBOARD SHORTCUTS ═══════════════════════════
document.addEventListener('keydown',e=>{
  // Don't hijack typing into form fields
  const tag=e.target.tagName;
  // Search input gets a special Esc handler that clears + blurs. Other form
  // fields still get hijack-protection (typing should not trigger shortcuts).
  if(tag==='INPUT'&&e.target.id==='sb-search'&&e.key==='Escape'){
    e.preventDefault();clearSearch();return;
  }
  // Form fields swallow shortcuts — except Escape while a modal is open, so a
  // keyboard user focused inside a dialog can still dismiss it.
  const _modalOpen=document.getElementById('mbg')?.classList.contains('vis');
  if((tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||e.target.isContentEditable)
     && !(e.key==='Escape'&&_modalOpen))return;
  // Single-key mode/toggle shortcuts shouldn't fire when a button (e.g. just-clicked
  // toolbar) holds focus — the user is most likely about to press Space/Enter on it,
  // not switch tools. Modifier-keyed shortcuts (Ctrl+Z etc.) still pass through.
  const isPlainKey=!e.ctrlKey&&!e.metaKey&&!e.altKey;
  if(isPlainKey&&tag==='BUTTON'&&e.key!=='Escape'&&e.key!=='Delete'&&e.key!=='Backspace')return;
  // Undo/redo
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key==='z'){e.preventDefault();undo();return;}
  if(((e.ctrlKey||e.metaKey)&&e.key==='y')||((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key==='Z')){e.preventDefault();redo();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='d'){e.preventDefault();duplicateSelected();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='l'){e.preventDefault();toggleLock();return;}
  // Escape = deselect / close modal
  if(e.key==='Escape'){
    if(document.getElementById('ctx-menu').classList.contains('vis')){closeContextMenu();return;}
    if(document.getElementById('mbg').classList.contains('vis')){closeModal();return;}
    if(pres){togglePresent();return;}
    if(rulerStart){clearRuler();return;}
    if(wallStart){wallStart=null;wallHover=null;renderWallPreview();return;}
    if(annoStart){annoStart=null;annoHover=null;renderAnnoPreview();return;}
    if(apStickStart && dragId){cancelApStick();return;}
    desel();return;
  }
  // Delete selected item (bulk-delete if multiple are selected)
  if((e.key==='Delete'||e.key==='Backspace')&&selection.size){
    e.preventDefault();
    if(selection.size>1)deleteSelection();
    else askDel();
    return;
  }
  // Mode switches (matches buttons)
  if(e.key==='a'||e.key==='A'){setMode('add');return;}
  if(e.key==='s'||e.key==='S'){setMode('sel');return;}
  if(e.key==='d'||e.key==='D'){setMode('dz');return;}
  if(e.key==='w'||e.key==='W'){setMode('sw');return;}
  if(e.key==='c'||e.key==='C'){setMode('cam');return;}
  if(e.key==='r'||e.key==='R'){setMode('ruler');return;}
  if(e.key==='l'||e.key==='L'){setMode('wall');return;}
  if(e.key==='n'||e.key==='N'){setMode('anno');return;}
  if(e.key==='p'||e.key==='P'){togglePresent();return;}
  // Toggles
  if(e.key==='o'||e.key==='O'){toggleOL();return;}
  if(e.key==='h'||e.key==='H'){toggleHeat();return;}
  if(e.key==='g'||e.key==='G'){toggleGrid();return;}
  if(e.key==='v'||e.key==='V'){toggleCoverage();return;}
  // Zoom
  if(e.key==='+'||e.key==='='){smoothZoom(+.18);return;}
  if(e.key==='-'||e.key==='_'){smoothZoom(-.18);return;}
  if(e.key==='0'){fitZoom();return;}
  // Help
  if(e.key==='?'||(e.shiftKey&&e.key==='/')){e.preventDefault();showHelp();return;}
});

// ═══ SETTINGS PANEL ═══════════════════════════════
// Per-project branding/locale shown in HTML & PDF exports. Built as DOM nodes
// (no innerHTML) so user-supplied strings are inert.
function showSettings(){
  const savedLanguage=getLang();
  const wrap=document.createElement('div');wrap.className='settings-form';

  // ── Helpers for compact rows ──
  const inputs={};
  const addText=(key,label,placeholder)=>{
    const row=document.createElement('div');row.className='ep-row';
    const lbl=document.createElement('label');lbl.className='ep-lbl';localizeText(lbl,label);
    const inp=document.createElement('input');inp.className='ep-in';inp.type='text';
    inp.value=SETTINGS[key]??'';if(placeholder && typeof placeholder==='object'){
      inp.setAttribute('data-i18n-placeholder',placeholder.i18n);inp.placeholder=t(placeholder.i18n);
    }else inp.placeholder=placeholder||'';
    row.appendChild(lbl);row.appendChild(inp);wrap.appendChild(row);
    inputs[key]=inp;
  };
  const addNumber=(key,label,min,max,step)=>{
    const row=document.createElement('div');row.className='ep-row';
    const lbl=document.createElement('label');lbl.className='ep-lbl';localizeText(lbl,label);
    const inp=document.createElement('input');inp.className='ep-in';inp.type='number';
    if(min!==undefined)inp.min=min;if(max!==undefined)inp.max=max;
    if(step!==undefined)inp.step=step;
    inp.value=String(SETTINGS[key]??'');
    row.appendChild(lbl);row.appendChild(inp);wrap.appendChild(row);
    inputs[key]=inp;
  };
  const addSelect=(key,label,options)=>{
    const row=document.createElement('div');row.className='ep-row';
    const lbl=document.createElement('label');lbl.className='ep-lbl';localizeText(lbl,label);
    const sel=document.createElement('select');sel.className='ep-in';
    for(const o of options){
      const op=document.createElement('option');op.value=o.value;if(o.i18n)localizeText(op,o.i18n);else op.textContent=o.label;
      if(String(SETTINGS[key])===String(o.value))op.selected=true;
      sel.appendChild(op);
    }
    row.appendChild(lbl);row.appendChild(sel);wrap.appendChild(row);
    inputs[key]=sel;
  };
  const addCheck=(key,label)=>{
    const row=document.createElement('div');row.className='ep-row';
    const lbl=document.createElement('label');lbl.className='ep-lbl';localizeText(lbl,label);
    const inp=document.createElement('input');inp.type='checkbox';
    inp.checked=!!SETTINGS[key];
    row.appendChild(lbl);row.appendChild(inp);wrap.appendChild(row);
    inputs[key]=inp;
  };
  const addHeading=(text)=>{
    const h=document.createElement('div');h.className='settings-heading';localizeText(h,text);
    wrap.appendChild(h);
  };

  // ── Branding ──
  addHeading('settings.branding');
  addText('company','settings.company','Plexus');
  addText('tagline','settings.tagline',{i18n:'settings.tagline_placeholder'});
  addText('contact','settings.contact','hello@plexus.example');
  addText('metaLine','settings.meta_line',{i18n:'settings.meta_placeholder'});
  addText('reportTitle','settings.report_title',{i18n:'settings.report_placeholder'});
  addText('footerLine','settings.footer_line',{i18n:'settings.footer_placeholder'});
  addText('logoDataUrl','settings.logo','data:image/png;base64,...');
  addText('locale','settings.locale','en-GB');
  addSelect('language','settings.language',availableLangs().map(c=>({value:c,label:c})));

  inputs.language.addEventListener('change',()=>setLang(inputs.language.value));

  // ── Coverage display ──
  addHeading('settings.display');
  const opacityRow=document.createElement('div');opacityRow.className='ep-row ep-slider-row';
  const opacityLbl=document.createElement('label');opacityLbl.className='ep-lbl';localizeText(opacityLbl,'settings.coverage_opacity');
  const opacityIn=document.createElement('input');
  opacityIn.type='range';opacityIn.min='20';opacityIn.max='100';opacityIn.step='5';
  opacityIn.className='ep-rng';
  const initialOpacity=Math.max(20,Math.min(100,Math.round(SETTINGS.coverageOpacity??100)));
  opacityIn.value=String(initialOpacity);
  const opacityVal=document.createElement('span');opacityVal.className='ep-rng-val';opacityVal.textContent=initialOpacity+'%';
  opacityRow.appendChild(opacityLbl);opacityRow.appendChild(opacityIn);opacityRow.appendChild(opacityVal);
  wrap.appendChild(opacityRow);
  const savedOpacity=SETTINGS.coverageOpacity??100;
  opacityIn.addEventListener('input',()=>{
    const v=parseInt(opacityIn.value,10)||100;
    opacityVal.textContent=v+'%';
    SETTINGS.coverageOpacity=v;
    render();
  });
  addSelect('heatmapMode','settings.heatmap_mode',HEATMAP_MODE_KEYS.map(k=>({value:k,i18n:'heat.metric_'+k})));
  addSelect('heatmapBand','settings.heatmap_band',[
    {value:'all',i18n:'heat.band_all'},
    {value:'2.4',i18n:'heat.band_24'},
    {value:'5',i18n:'heat.band_5'},
    {value:'6',i18n:'heat.band_6'},
  ]);
  addCheck('showRoamingOverlap','settings.roaming_detail');

  // ── RF model + regulatory ──
  addHeading('settings.rf');
  addSelect('propagationModel','settings.propagation_model',PROPAGATION_MODEL_KEYS.map(k=>({value:k,label:PROPAGATION_MODELS[k].label})));
  addSelect('regulatoryRegion','settings.regulatory_region',REGULATORY_REGION_KEYS.map(k=>({value:k,label:REGULATORY_REGIONS[k].label})));
  addNumber('noiseFloorDbm','settings.noise_floor',-110,-70,1);
  addNumber('floorSlabAttenDb','settings.floor_slab',0,40,1);
  addCheck('showFloorLeakage','settings.show_floor_leakage');

  // ── Architect scale ──
  addHeading('settings.drawing');
  addSelect('archScale','settings.arch_scale',[
    {value:'',i18n:'settings.custom_scale'},
    ...ARCH_SCALE_PRESETS.map(p=>({value:p.label,label:`${p.label} (${p.m100px} m / 100 px)`})),
  ]);

  // ── Organization ──
  addHeading('settings.organization');
  addText('siteCode','settings.site_code',{i18n:'settings.site_placeholder'});
  addText('namePattern','settings.name_pattern','{site}-F{floor}-{type}{nn}');
  const nameHint=document.createElement('div');nameHint.className='ep-hint';
  localizeText(nameHint,'settings.name_hint');
  wrap.appendChild(nameHint);

  // ── Cabling & capacity ──
  addHeading('settings.cabling');
  addNumber('cableRoutingFactor','settings.routing',1,3,0.05);
  addNumber('cableBoxM','settings.box',1,1000,1);
  addNumber('expectedClients','settings.clients',0,100000,1);
  addNumber('perClientMbps','settings.demand',0.5,100,0.5);
  addCheck('colorByVlan','settings.vlan_colors');

  // ── Cameras: DORI + storage ──
  addHeading('report.cameras');
  addCheck('showDori','settings.dori');
  addNumber('retentionDays','settings.retention',1,365,1);
  addSelect('storageCodec','settings.codec',[
    {value:'h265',label:'H.265 / HEVC'},
    {value:'h264',label:'H.264 / AVC'},
  ]);

  // ── VLAN registry ──
  addHeading('settings.vlans');
  const vlanWrap=document.createElement('div');
  const vlanRows=[];
  const addVlanRow=(v)=>{
    const row=document.createElement('div');row.className='ep-row';row.style.cssText='display:flex;gap:4px;align-items:center';
    const id=document.createElement('input');id.className='ep-in';id.placeholder='ID';id.value=(v&&v.id)||'';id.style.cssText='width:50px;flex:0 0 auto';
    const name=document.createElement('input');name.className='ep-in';name.setAttribute('data-i18n-placeholder','settings.name');name.placeholder=t('settings.name');name.value=(v&&v.name)||'';
    const color=document.createElement('input');color.type='color';color.value=(v&&v.color)||'#1565c0';color.style.cssText='width:30px;height:28px;padding:0;border:none;background:none;flex:0 0 auto';
    const subnet=document.createElement('input');subnet.className='ep-in ep-mono';subnet.placeholder='10.0.10.0/24';subnet.value=(v&&v.subnet)||'';subnet.style.cssText='width:118px;flex:0 0 auto';
    const del=document.createElement('button');del.className='btn';del.textContent='✕';del.style.cssText='flex:0 0 auto;padding:4px 8px';
    const entry={id,name,color,subnet};
    del.addEventListener('click',()=>{row.remove();const i=vlanRows.indexOf(entry);if(i>=0)vlanRows.splice(i,1);});
    row.append(id,name,color,subnet,del);
    vlanWrap.appendChild(row);
    vlanRows.push(entry);
  };
  vlanList().forEach(addVlanRow);
  wrap.appendChild(vlanWrap);
  const addVlanBtn=document.createElement('button');addVlanBtn.className='btn';localizeText(addVlanBtn,'settings.add_vlan');addVlanBtn.style.marginTop='4px';
  addVlanBtn.addEventListener('click',()=>addVlanRow());
  wrap.appendChild(addVlanBtn);

  // ── Security ──
  addHeading('settings.security');
  const credRow=document.createElement('div');credRow.className='ep-row';
  const credLbl=document.createElement('label');credLbl.className='ep-lbl';localizeText(credLbl,'settings.passphrase');
  const credInp=document.createElement('input');
  credInp.type='password';credInp.className='ep-in';credInp.autocomplete='new-password';
  credInp.value=_credPass;credInp.setAttribute('data-i18n-placeholder','settings.passphrase_placeholder');credInp.placeholder=t('settings.passphrase_placeholder');
  credRow.append(credLbl,credInp);wrap.appendChild(credRow);
  const credHint=document.createElement('div');credHint.className='ep-hint';
  localizeText(credHint,'settings.credentials_hint');
  wrap.appendChild(credHint);

  const hint=document.createElement('div');
  hint.className='ep-hint';
  localizeText(hint,'settings.detail_hint');
  wrap.appendChild(hint);

  const apply=()=>{
    let changed=false;
    // Strings
    for(const k of ['company','tagline','contact','metaLine','reportTitle','footerLine','logoDataUrl','locale','language','propagationModel','regulatoryRegion','heatmapMode','heatmapBand','archScale','siteCode','namePattern','storageCodec','unifiUrl','unifiSite','unifiUser']){
      if(!inputs[k])continue;
      const val=(inputs[k].value||'').trim();
      if(String(SETTINGS[k]||'')!==val){SETTINGS[k]=val;changed=true;}
    }
    // Numbers
    for(const k of ['noiseFloorDbm','floorSlabAttenDb','cableRoutingFactor','cableBoxM','expectedClients','perClientMbps','retentionDays']){
      if(!inputs[k])continue;
      const v=parseFloat(inputs[k].value);
      if(Number.isFinite(v)&&SETTINGS[k]!==v){SETTINGS[k]=v;changed=true;}
    }
    // Bools
    for(const k of ['showRoamingOverlap','showFloorLeakage','colorByVlan','showDori']){
      if(!inputs[k])continue;
      const v=!!inputs[k].checked;
      if(SETTINGS[k]!==v){SETTINGS[k]=v;changed=true;}
    }
    // VLAN registry.
    const newVlans=vlanRows.map(e=>({id:(e.id.value||'').trim(),name:(e.name.value||'').trim(),color:e.color.value||'',subnet:(e.subnet.value||'').trim()})).filter(v=>v.id||v.name);
    if(JSON.stringify(newVlans)!==JSON.stringify(vlanList())){SETTINGS.vlans=newVlans;changed=true;}
    // Credentials passphrase (session-only; never persisted to SETTINGS).
    _credPass=credInp.value||'';
    const opacity=parseInt(opacityIn.value,10)||100;
    if(SETTINGS.coverageOpacity!==opacity){SETTINGS.coverageOpacity=opacity;changed=true;}
    setLang(SETTINGS.language||'en');
    // Apply architect scale: convert to m/100px and propagate to current floor.
    if(SETTINGS.archScale){
      const preset=ARCH_SCALE_PRESETS.find(p=>p.label===SETTINGS.archScale);
      if(preset){
        setScaleM(preset.m100px);
        const el=document.getElementById('scale-m');
        if(el)el.value=String(preset.m100px);
      }
    }
    if(changed){
      applySettingsToBrand();
      invalidateCoverageCache();
      render();autosave();
    }
  };
  const cancel=()=>{
    setLang(savedLanguage);
    if(SETTINGS.coverageOpacity!==savedOpacity){
      SETTINGS.coverageOpacity=savedOpacity;
      render();
    }
  };
  showModalNode({i18n:'settings.title'},wrap,apply,cancel);
}

// ═══ HELP OVERLAY ═════════════════════════════════
// Built as DOM nodes (no innerHTML) so any future translation strings can't
// inadvertently inject markup.
function _helpRow(parent,parts){
  const row=document.createElement('div');row.className='help-row';
  // parts: array of either {kbd:'A'} | {text:'foo'} | {desc:'mode.add'}
  // We render kbd/text inline, then push desc into a <span>.
  parts.forEach(p=>{
    if(p.kbd){const k=document.createElement('kbd');k.textContent=p.kbd;row.appendChild(k);}
    else if(p.sep){row.appendChild(document.createTextNode(p.sep));}
    else if(p.text){const span=document.createElement('span');if(p.text==='+')span.textContent='+';else localizeText(span,p.text);row.appendChild(span);}
    else if(p.desc){const s=document.createElement('span');localizeText(s,p.desc);row.appendChild(s);}
  });
  parent.appendChild(row);
}
function _helpSection(grid,title,rows){
  const sec=document.createElement('div');sec.className='help-sec';
  const h=document.createElement('div');h.className='help-h';localizeText(h,title);sec.appendChild(h);
  rows.forEach(r=>_helpRow(sec,r));
  grid.appendChild(sec);
}
function showHelp(){
  const grid=document.createElement('div');grid.className='help-grid';
  _helpSection(grid,'help.modes',[
    [{kbd:'A'},{desc:'mode.add'}],
    [{kbd:'S'},{desc:'mode.select'}],
    [{kbd:'D'},{desc:'mode.dead_zone'}],
    [{kbd:'W'},{desc:'mode.switch'}],
    [{kbd:'L'},{desc:'mode.wall'}],
    [{kbd:'R'},{desc:'mode.ruler'}],
    [{kbd:'C'},{desc:'mode.camera'}],
    [{kbd:'N'},{desc:'mode.annotation'}],
    [{kbd:'P'},{desc:'help.present'}],
  ]);
  _helpSection(grid,'help.view',[
    [{kbd:'O'},{desc:'help.overlaps'}],
    [{kbd:'H'},{desc:'help.heatmap'}],
    [{kbd:'G'},{desc:'help.grid'}],
    [{kbd:'V'},{desc:'help.coverage'}],
    [{kbd:'+'},{sep:' / '},{kbd:'-'},{desc:'help.zoom'}],
    [{kbd:'0'},{desc:'help.fit'}],
    [{kbd:'Space'},{text:'help.drag'},{desc:'help.pan'}],
    [{text:'help.scroll'},{desc:'help.zoom_in_out'}],
  ]);
  _helpSection(grid,'help.edit',[
    [{kbd:'Ctrl'},{text:'+'},{kbd:'Z'},{desc:'tb.undo'}],
    [{kbd:'Ctrl'},{text:'+'},{kbd:'Y'},{desc:'tb.redo'}],
    [{kbd:'Del'},{desc:'help.delete'}],
    [{kbd:'Esc'},{desc:'help.deselect'}],
    [{kbd:'Shift'},{text:'help.click_ap'},{desc:'help.duplicate'}],
  ]);
  _helpSection(grid,'report.floors',[
    [{text:'help.click'},{kbd:'+'},{desc:'tip.floor'}],
    [{text:'help.double_click'},{desc:'help.rename'}],
    [{text:'help.click'},{kbd:'×'},{text:'help.on_tab'},{desc:'help.delete_floor'}],
  ]);
  _helpSection(grid,'tb.help',[
    [{kbd:'?'},{desc:'help.show'}],
  ]);
  showModalNode({i18n:'help.title'},grid,null);
  // Widen the modal for the help grid
  const mdl=document.getElementById('mdl');
  if(mdl)mdl.classList.add('help-modal');
}

function initImage(){
  if(mapImg.naturalWidth>0){fitZoom();render();renderMM();updateScaleBar();calcCoverage();updateEmptyState();}
  else{updateEmptyState();setTimeout(initImage,50);}
}

// ═══ THEME ════════════════════════════════════════
// Dark / light mode. The cream-and-black "light" theme is the default; dark
// inverts the palette while keeping all role tokens intact. CSS handles most
// theming via custom properties; inline SVG attribute colors (the ones that
// can't reference CSS vars) read live values via tInk()/tBg() at render time.
const THEME_KEY='noctis_theme';
function applyTheme(t){
  document.body.classList.toggle('theme-dark',t==='dark');
  if(typeof _resetThemeCache==='function')_resetThemeCache();
  const btn=document.getElementById('btn-theme');
  if(btn)btn.textContent=t==='dark'?'☼':'☾';
  // Inline-SVG colors are baked at render time — re-render so they pick up the
  // new tokens. Defer to next frame so this is safe to call during early init.
  if(typeof render==='function'&&typeof requestAnimationFrame!=='undefined'){
    try{requestAnimationFrame(()=>{try{render();}catch(_){}});}catch(_){}
  }
}
function toggleTheme(){
  const next=document.body.classList.contains('theme-dark')?'light':'dark';
  applyTheme(next);
  try{localStorage.setItem(THEME_KEY,next);}catch(_){}
  toast(next==='dark'?'Dark mode':'Light mode');
}

// Clear the sidebar search filter and reset the input + clear-button visibility.
function clearSearch(){
  searchQuery='';
  const inp=document.getElementById('sb-search');
  if(inp){inp.value='';inp.blur();}
  const row=document.querySelector('.sb-search-row');
  if(row)row.classList.remove('has-text');
  renderList();
}
// Restore theme on load before first paint.
(function restoreTheme(){
  try{
    const t=localStorage.getItem(THEME_KEY);
    if(t==='dark')applyTheme('dark');
    else applyTheme('light');
  }catch(_){applyTheme('light');}
})();

// ═══ LEFT SIDEBAR RESIZE ══════════════════════════
// User drags the right edge of the left sidebar to resize. Width is stored as
// a CSS custom property on :root, so existing flex layout stays correct.
// Persisted to localStorage so the chosen width sticks across sessions.
const SB_W_KEY='noctis_sb_w';
const SB_MIN=180,SB_MAX=520;
function setSidebarWidth(px){
  const w=Math.max(SB_MIN,Math.min(SB_MAX,Math.round(px)));
  document.documentElement.style.setProperty('--left-sb-w',w+'px');
  try{localStorage.setItem(SB_W_KEY,String(w));}catch(_){}
}
// Restore previous width on page load
(function restoreSbWidth(){
  try{
    const stored=parseInt(localStorage.getItem(SB_W_KEY)||'',10);
    if(Number.isFinite(stored)&&stored>=SB_MIN&&stored<=SB_MAX){
      document.documentElement.style.setProperty('--left-sb-w',stored+'px');
    }
  }catch(_){}
})();
(function wireSbResize(){
  const handle=document.getElementById('sb-resize-handle');
  const sb=document.getElementById('left-sb');
  if(!handle||!sb)return;
  let dragging=false;
  handle.addEventListener('pointerdown',e=>{
    e.preventDefault();dragging=true;
    handle.classList.add('dragging');
    document.body.classList.add('sb-resizing');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove',e=>{
    if(!dragging)return;
    const r=sb.getBoundingClientRect();
    setSidebarWidth(e.clientX-r.left);
  });
  const stop=e=>{
    if(!dragging)return;
    dragging=false;
    handle.classList.remove('dragging');
    document.body.classList.remove('sb-resizing');
    try{handle.releasePointerCapture(e.pointerId);}catch(_){}
    // Map sometimes stays at old size after sidebar resize — re-fit.
    setTimeout(fitZoom,30);
  };
  handle.addEventListener('pointerup',stop);
  handle.addEventListener('pointercancel',stop);
  // Double-click to reset to default
  handle.addEventListener('dblclick',()=>{setSidebarWidth(220);setTimeout(fitZoom,30);});
})();

// In the desktop (Electron) build the page lives at a file:// URL, so the
// Share-link feature (which encodes the project into a shareable https URL)
// is meaningless — hide its button there.
const IS_ELECTRON=/electron/i.test((typeof navigator!=='undefined'&&navigator.userAgent)||'');
if(IS_ELECTRON){
  const sb=document.querySelector('[data-action="share-link"]');
  if(sb)sb.style.display='none';
}
// Desktop-only features (need the preload bridge): live survey + UniFi sync.
if(typeof window!=='undefined'&&window.plexusNative){
  const sv=document.getElementById('btn-survey');
  if(sv)sv.style.display='';
  const un=document.getElementById('btn-unifi');
  if(un)un.style.display='';
}

// Small delay to let browser lay out the image, then offer to restore.
// If the URL has a #p=... payload, that takes priority — autosave restore
// only triggers when there's no shared project to load.
setTimeout(async ()=>{
  initImage();
  const loaded=await tryLoadFromHash();
  if(!loaded)tryRestoreAutosave();
},100);

// Localize the initial static interface and every subsequent language change.
onLanguageChange(()=>{
  localizeDOM();
  const label=document.getElementById('brand-lbl');
  const floor=F();
  if(label && !(floor&&floor.imgName))label.textContent=(SETTINGS.company||'Plexus')+' '+t('app.planner');
});
localizeDOM();
