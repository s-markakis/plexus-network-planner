// Map layers for placed items: AP coverage rings + markers, dead zones,
// cable runs, camera view cones and switches, as SVG. They read the live
// plan through ctx and hand pointer-downs back to the app (selection and
// dragging stay in app.js). Labels go in via textContent.

import { doriDistancesM } from './cameras.js';
import { routerAsAp } from './routerWifi.js';
import { AP_PATTERNS, ROAMING_OVERLAP_DBM, HEATMAP_STOPS } from './constants.js';
import { dbmAt, bandLossMultiplier, effectiveEirp } from './geometry.js';
import { apChansOverlap } from './channels.js';

/** Wedge (or full-circle → null) path for a camera's view area. */
export function _camWedgePath(cx,cy,r,heading,fov){
  if(fov>=350)return null;   // caller draws a <circle> instead
  const half=fov/2;
  const a1=(heading-half)*Math.PI/180;
  const a2=(heading+half)*Math.PI/180;
  const x1=cx+Math.cos(a1)*r, y1=cy+Math.sin(a1)*r;
  const x2=cx+Math.cos(a2)*r, y2=cy+Math.sin(a2)*r;
  const largeArc=fov>180?1:0;
  return `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`;
}

export function renderAPLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';
  const w=ctx.w,h=ctx.h;
  // If no image loaded yet, don't render APs at all — they'd land at (0,0)
  // as a phantom cluster.
  if(!w||!h)return;
  ctx.aps.forEach(ap=>{
    // Skip APs with invalid data rather than render a bogus circle at origin.
    if(!Number.isFinite(ap.fx)||!Number.isFinite(ap.fy)||!Number.isFinite(ap.r)||ap.r<=0){
      console.warn('Skipping AP with invalid coords:',ap);
      return;
    }
    const cx=ap.fx*w,cy=ap.fy*h,r=ap.r,isSel=ctx.isSelected(ap.id,'ap');
    const ls=Math.max(8,Math.min(14,r*.17));
    const g=mk('g');g.setAttribute('class','ap-grp');g.dataset.id=ap.id;g.style.pointerEvents='all';
    if(ap.locked)g.style.opacity='.7';
    if(ctx.statusDimmed(ap))g.style.opacity='.15';

    const hasWalls=ctx.walls.length>0;
    // Per-AP color (empty string = use default ink — no override). When "colour
    // by VLAN" is on, an unstyled AP inherits its VLAN's colour.
    const apColor=ap.color||(ctx.settings.colorByVlan?ctx.vlanColor(ap.vlan):'')||'';
    // User-controlled coverage opacity (Settings → Coverage opacity).
    // 100 = full strength; values below 100 fade the ring fill+stroke.
    const covOp=Math.max(0,Math.min(1,(ctx.settings.coverageOpacity??100)/100));
    // Outer coverage: wall-clipped path if walls exist, else simple circle
    let ro;
    if(hasWalls){
      ro=mk('path');
      ro.setAttribute('d',ctx.getCoveragePath(ap));
    }else{
      ro=mk('circle');ro.setAttribute('cx',cx);ro.setAttribute('cy',cy);ro.setAttribute('r',r);
    }
    ro.setAttribute('class',isSel?'ap-sel-outer':ap.sig==='medium'?'ap-outer-m':ap.sig==='weak'?'ap-outer-w':'ap-outer');
    if(apColor){
      // Override the ink-black defaults with the AP's color. We keep the fill
      // transparent-ish (8% alpha) so overlapping coverage areas still mix visually.
      ro.style.stroke=apColor;
      ro.style.fill=ctx.hexToRgba(apColor,.08);
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
      ri.setAttribute('d',ctx.getInnerCoveragePath(ap));
    }else{
      ri=mk('circle');ri.setAttribute('cx',cx);ri.setAttribute('cy',cy);ri.setAttribute('r',r*.54);
    }
    ri.setAttribute('class',isSel?'ap-sel-inner':ap.sig==='medium'?'ap-inner-m':ap.sig==='weak'?'ap-inner-w':'ap-inner');
    if(apColor){
      ri.style.stroke=apColor;
      ri.style.fill=ctx.hexToRgba(apColor,.12);
    }
    if(covOp<1)ri.setAttribute('opacity',covOp);

    const dot=mk('circle');dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);dot.setAttribute('r',7);
    dot.setAttribute('class',isSel?'ap-sel-dot':'ap-dot');dot.setAttribute('filter','url(#gf)');
    dot.style.animation='pulse 2.2s ease-in-out infinite';
    if(apColor)dot.style.fill=apColor;

    // On-map label: just the AP name. Model + all other technical details are
    // visible in the right-side properties panel when an AP is selected.
    // Below the dot (7 px radius), so the name never sits on top of the marker.
    const lbl=mk('text');lbl.setAttribute('x',cx);lbl.setAttribute('y',cy+9+ls*.75);
    lbl.setAttribute('class',isSel?'ap-lbl-sel':'ap-lbl');lbl.setAttribute('font-size',ls);lbl.textContent=ap.name;
    if(apColor)lbl.style.fill=apColor;

    // Notes dot
    if(ap.notes&&ap.notes.trim()){
      const nd=mk('circle');nd.setAttribute('cx',cx+r*.22);nd.setAttribute('cy',cy-r*.22);
      nd.setAttribute('r',Math.max(3,ls*.38));nd.setAttribute('fill',isSel?ctx.tInk():ctx.tInk(.55));nd.setAttribute('opacity','.85');
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
    if(ctx.showCoverage){parts.unshift(ro,ri);}
    parts.forEach(el=>g.appendChild(el));
    g.addEventListener('pointerdown',e=>ctx.onItemPointerDown('ap',ap,e));
    layer.appendChild(g);
  });
}

export function renderDZLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';
  const w=ctx.w,h=ctx.h;
  if(!w||!h)return;
  ctx.dzs.forEach(dz=>{
    if(!Number.isFinite(dz.fx)||!Number.isFinite(dz.fy)||!Number.isFinite(dz.r)||dz.r<=0)return;
    const cx=dz.fx*w,cy=dz.fy*h,isSel=ctx.isSelected(dz.id,'dz');
    const g=mk('g');g.setAttribute('class','dz-grp');g.dataset.id=dz.id;g.style.pointerEvents='all';
    const pulse=mk('circle');pulse.setAttribute('cx',cx);pulse.setAttribute('cy',cy);pulse.setAttribute('r',dz.r);
    pulse.setAttribute('class','dz-pulse');pulse.style.transformOrigin=`${cx}px ${cy}px`;pulse.style.animation='dzs 8s linear infinite';
    if(isSel){pulse.style.stroke=ctx.tInk();pulse.style.strokeWidth='2.5';pulse.style.fill=ctx.tInk(.1);}
    const icon=mk('text');icon.setAttribute('x',cx);icon.setAttribute('y',cy);icon.setAttribute('text-anchor','middle');icon.setAttribute('dominant-baseline','central');icon.setAttribute('font-size','18');icon.setAttribute('fill',ctx.tInk());icon.textContent='⚠';
    const lbl=mk('text');lbl.setAttribute('x',cx);lbl.setAttribute('y',cy+dz.r+11);lbl.setAttribute('text-anchor','middle');lbl.setAttribute('font-size','10');lbl.setAttribute('font-family','-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica Neue,Arial,sans-serif');lbl.setAttribute('font-weight','700');lbl.setAttribute('letter-spacing','.1em');lbl.setAttribute('fill',ctx.tInk());lbl.setAttribute('paint-order','stroke');lbl.setAttribute('stroke',ctx.tBg());lbl.setAttribute('stroke-width','3');lbl.textContent=(dz.label||'').toUpperCase();
    if(isSel&&!dz.locked){const rh=mk('circle');rh.setAttribute('cx',cx+dz.r);rh.setAttribute('cy',cy);rh.setAttribute('r',8);rh.setAttribute('class','rh-sel');rh.dataset.resizeDz=dz.id;rh.style.pointerEvents='all';rh.addEventListener('pointerdown',e=>ctx.onDzResizeDown(dz,e));g.appendChild(rh);}
    [pulse,icon,lbl].forEach(el=>g.appendChild(el));
    g.addEventListener('pointerdown',e=>ctx.onItemPointerDown('dz',dz,e));
    layer.appendChild(g);
  });
}

export function renderCableLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';
  if(!ctx.showCables)return;
  const w=ctx.w,h=ctx.h;
  if(!w||!h)return;
  const drawCable=(dev,sw)=>{
    const dx=dev.fx*w,dy=dev.fy*h,sx=sw.fx*w,sy=sw.fy*h;
    const ln=mk('line');
    ln.setAttribute('x1',dx);ln.setAttribute('y1',dy);
    ln.setAttribute('x2',sx);ln.setAttribute('y2',sy);
    ln.setAttribute('class','cable-line');
    layer.appendChild(ln);
    // Length label at midpoint (includes the routing factor for a realistic run)
    const lenPx=Math.hypot(sx-dx,sy-dy);
    const lenM=(lenPx*ctx.mPerPx*ctx.routingFactor).toFixed(1);
    if(lenPx*ctx.zoom>40){
      const mx=(dx+sx)/2,my=(dy+sy)/2;
      const txt=mk('text');
      txt.setAttribute('x',mx);txt.setAttribute('y',my-3);
      txt.setAttribute('class','cable-lbl');
      txt.textContent=lenM+' m';
      const lm=parseFloat(lenM);
      if(lm>100)txt.classList.add('cable-lbl-warn');        // over Ethernet limit
      else if(lm>90)txt.classList.add('cable-lbl-near');    // approaching limit
      layer.appendChild(txt);
    }
  };
  ctx.aps.forEach(ap=>{
    if(!ap.swId)return;
    const sw=ctx.sws.find(s=>s.id===ap.swId);
    if(sw)drawCable(ap,sw);
  });
  ctx.cams.forEach(c=>{
    if(!c.swId)return;
    const sw=ctx.sws.find(s=>s.id===c.swId);
    if(sw)drawCable(c,sw);
  });
  // Switch → uplink backbone links — thicker/solid so they read as trunks
  // distinct from the dashed device runs.
  ctx.sws.forEach(sw=>{
    if(!sw.uplinkId||sw.uplinkId===sw.id)return;
    const up=ctx.sws.find(s=>s.id===sw.uplinkId);
    const x=sw.fx*w,y=sw.fy*h;
    if(up){
      const ln=mk('line');
      ln.setAttribute('x1',x);ln.setAttribute('y1',y);
      ln.setAttribute('x2',up.fx*w);ln.setAttribute('y2',up.fy*h);
      ln.setAttribute('class','uplink-line');
      layer.appendChild(ln);
    }else{
      // Uplink is on another floor — draw a short riser stub + label.
      const tgt=ctx.findSwitchAnywhere(sw.uplinkId);
      if(!tgt)return;
      const ln=mk('line');
      ln.setAttribute('x1',x);ln.setAttribute('y1',y);
      ln.setAttribute('x2',x);ln.setAttribute('y2',y-26);
      ln.setAttribute('class','uplink-line');ln.setAttribute('stroke-dasharray','3 3');
      layer.appendChild(ln);
      const txt=mk('text');
      txt.setAttribute('x',x);txt.setAttribute('y',y-30);
      txt.setAttribute('class','cable-lbl');txt.style.fill='#6a1b9a';
      txt.textContent='↑ '+(tgt.sw.name||'')+' · '+(tgt.floor.name||('Floor '+(tgt.floorIdx+1)));
      layer.appendChild(txt);
    }
  });
}

export function renderCAMLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';
  const w=ctx.w,h=ctx.h;
  if(!w||!h)return;
  ctx.cams.forEach(c=>{
    if(!Number.isFinite(c.fx)||!Number.isFinite(c.fy))return;
    const cx=c.fx*w,cy=c.fy*h;
    const isSel=ctx.isSelected(c.id,'cam');
    const range=c.range||80;
    const fov=Math.max(10,Math.min(360,c.fov||80));
    const heading=c.heading||0;
    const color=c.color||(ctx.settings.colorByVlan&&ctx.vlanColor(c.vlan))||ctx.tInk();
    const fillRgba=c.color?ctx.hexToRgba(c.color,.08):ctx.tInk(.08);
    const g=mk('g');g.setAttribute('class','cam-grp');g.dataset.id=c.id;g.style.pointerEvents='all';
    if(c.locked)g.style.opacity='.7';
    if(ctx.statusDimmed(c))g.style.opacity='.15';

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
    if(ctx.statusDimmed(c))cone.setAttribute('opacity','.15');
    layer.appendChild(cone);

    // DORI pixel-density bands (IEC 62676-4). Stacked translucent wedges,
    // strongest tier innermost — the compounded tint reads as a gradient of
    // "how much detail you actually get" inside the raw view cone.
    if(ctx.settings.showDori!==false && Number.isFinite(ctx.scaleM) && ctx.scaleM>0 && !ctx.statusDimmed(c)){
      const mpp=ctx.scaleM/100;
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
        layer.appendChild(el);
      }
    }

    // Lens marker at position.
    const lens=mk('circle');
    lens.setAttribute('cx',cx);lens.setAttribute('cy',cy);lens.setAttribute('r',5);
    lens.setAttribute('class','cam-lens'+(isSel?' cam-lens-sel':''));
    lens.style.fill='#000';
    layer.appendChild(lens);
    const inner=mk('circle');
    inner.setAttribute('cx',cx);inner.setAttribute('cy',cy);inner.setAttribute('r',2);
    inner.style.fill=ctx.tBg();
    inner.style.pointerEvents='none';
    layer.appendChild(inner);

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
      layer.appendChild(tip);
    }

    // Label below the lens.
    const lbl=mk('text');
    lbl.setAttribute('x',cx);lbl.setAttribute('y',cy+14);
    lbl.setAttribute('class','cam-lbl');
    lbl.style.fill=color;
    lbl.textContent=(c.name||'').toUpperCase();
    layer.appendChild(lbl);



    // Invisible hit area reuses the existing selection and drag handler.
    const hit=mk('circle');
    hit.setAttribute('cx',cx);hit.setAttribute('cy',cy);hit.setAttribute('r',14);
    hit.setAttribute('class','cam-grp');hit.dataset.id=c.id;
    hit.style.fill='transparent';hit.style.pointerEvents='all';
    layer.appendChild(hit);
    hit.style.cursor='pointer';
    hit.addEventListener('pointerdown',e=>ctx.onItemPointerDown('cam',c,e));
  });
}

export function renderSWLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';
  const w=ctx.w,h=ctx.h;
  if(!w||!h)return;
  ctx.sws.forEach(sw=>{
    if(!Number.isFinite(sw.fx)||!Number.isFinite(sw.fy))return;
    const cx=sw.fx*w,cy=sw.fy*h,isSel=ctx.isSelected(sw.id,'sw');
    const g=mk('g');g.setAttribute('class','sw-grp');g.dataset.id=sw.id;g.style.pointerEvents='all';
    if(ctx.statusDimmed(sw))g.style.opacity='.15';
    const sz=sw.size||22;
    // Box and icon sizes scale with sz so a bigger switch reads as a bigger icon, not just a bigger empty box.
    const iconFs=Math.max(8,sz*.65);
    const lblFs=Math.max(7,sz*.42);
    const box=mk('rect');box.setAttribute('x',cx-sz);box.setAttribute('y',cy-sz*.6);
    box.setAttribute('width',sz*2);box.setAttribute('height',sz*1.2);box.setAttribute('rx',2);
    box.setAttribute('fill',isSel?ctx.tInk(.1):ctx.tInk(.04));
    box.setAttribute('stroke',ctx.tInk());box.setAttribute('stroke-width',isSel?'2':'1.2');
    const icon=mk('text');icon.setAttribute('x',cx);icon.setAttribute('y',cy);icon.setAttribute('text-anchor','middle');icon.setAttribute('dominant-baseline','central');icon.setAttribute('font-size',iconFs);icon.setAttribute('fill',ctx.tInk());icon.textContent='⊞';
    const lbl=mk('text');lbl.setAttribute('x',cx);lbl.setAttribute('y',cy+sz*.9);lbl.setAttribute('text-anchor','middle');lbl.setAttribute('font-size',lblFs);lbl.setAttribute('font-family','-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica Neue,Arial,sans-serif');lbl.setAttribute('font-weight','700');lbl.setAttribute('letter-spacing','.08em');lbl.setAttribute('fill',ctx.tInk());lbl.setAttribute('paint-order','stroke');lbl.setAttribute('stroke',ctx.tBg());lbl.setAttribute('stroke-width','2.5');lbl.textContent=(sw.name||'').toUpperCase();
    // A router with a built-in radio covers the floor like an AP: draw its
    // ring (clipped by walls) under the device box.
    const wifiAp=ctx.showCoverage?routerAsAp(sw,ctx.floorScaleM):null;
    if(wifiAp){
      const ring=mk('path');ring.setAttribute('d',ctx.getCoveragePath(wifiAp));
      ring.setAttribute('class',isSel?'ap-sel-outer':'ap-outer');ring.style.pointerEvents='none';
      const covOp=Math.max(0,Math.min(1,(ctx.settings.coverageOpacity??100)/100));
      if(covOp<1)ring.setAttribute('opacity',covOp);
      g.appendChild(ring);
    }
    [box,icon,lbl].forEach(el=>g.appendChild(el));
    g.addEventListener('pointerdown',e=>ctx.onItemPointerDown('sw',sw,e));
    layer.appendChild(g);
  });
}

/** RSSI → heat colour (null when unknown). */
export function _heatColor(dbm){
  // Legacy single-mode helper retained for code paths that still call it.
  if(dbm===null||dbm===undefined||!Number.isFinite(dbm))return null;
  for(const s of HEATMAP_STOPS){if(dbm>=s.dbm)return s.color;}
  return null;
}

export function renderAnnoLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  if(!layer)return;
  layer.innerHTML='';
  const w=ctx.w||1,h=ctx.h||1;
  for(const a of ctx.annos){
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
        const m=Math.round(dist*(ctx.scaleM||100)/100*10)/10;
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

export function renderSampleLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  if(!layer)return;
  layer.innerHTML='';
  const samples=ctx.samples;
  if(!samples.length)return;
  const w=ctx.w||1,h=ctx.h||1;
  const walls=ctx.walls;
  const propModel=ctx.settings.propagationModel||'logd';
  for(const s of samples){
    const x=(s.fx||0)*w, y=(s.fy||0)*h;
    // Predicted: max dBm across local APs.
    let predicted=-Infinity;
    for(const ap of ctx.aps){
      const pat=AP_PATTERNS[ap.pattern]||AP_PATTERNS.omni;
      const d=dbmAt(ap,x,y,w,h,walls,{
        bandFactor:bandLossMultiplier(ap.freq),
        arcDeg:pat.arc,headingDeg:ap.heading||0,
        eirpDbm:effectiveEirp(ap),
        model:propModel,
        metersPerPx:(ctx.scaleM||100)/100,
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

export function renderRoamingLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  if(!layer)return;
  layer.innerHTML='';
  if(!ctx.settings.showRoamingOverlap)return;
  const w=ctx.w||0,h=ctx.h||0;
  if(!w||!h)return;
  const aps=ctx.aps;
  if(aps.length<2)return;
  const walls=ctx.walls;
  const propModel=ctx.settings.propagationModel||'logd';
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
          metersPerPx:(ctx.scaleM||100)/100,
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

export function renderChannelOverlapLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';
  const w=ctx.w,h=ctx.h;
  if(!w||!h)return;
  const aps=ctx.aps;
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
    layer.appendChild(ln);
    const mx=(ax+bx)/2,my=(ay+by)/2;
    const bg=mk('rect');
    bg.setAttribute('x',mx-26);bg.setAttribute('y',my-10);
    bg.setAttribute('width',52);bg.setAttribute('height',20);
    bg.setAttribute('rx',10);bg.setAttribute('class','ch-overlap-bg');
    layer.appendChild(bg);
    const txt=mk('text');
    txt.setAttribute('x',mx);txt.setAttribute('y',my);
    txt.setAttribute('class','ch-overlap-lbl');
    const labelA=a.channel==='auto'||!a.channel?'?':a.channel;
    const labelB=b.channel==='auto'||!b.channel?'?':b.channel;
    txt.textContent=labelA===labelB?`⚡ Ch ${labelA}`:`⚡ ${labelA}↔${labelB}`;
    layer.appendChild(txt);
  }
}

export function renderOverlapZoneLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';if(!ctx.showOL)return;
  const w=ctx.w||1,h=ctx.h||1;
  for(let i=0;i<ctx.aps.length;i++)for(let j=i+1;j<ctx.aps.length;j++){
    const a=ctx.aps[i],b=ctx.aps[j];
    const ax=a.fx*w,ay=a.fy*h,bx=b.fx*w,by=b.fy*h;
    const dist=Math.hypot(ax-bx,ay-by);
    if(dist<a.r+b.r){const c=mk('circle');c.setAttribute('cx',(ax+bx)/2);c.setAttribute('cy',(ay+by)/2);c.setAttribute('r',Math.max(8,(a.r+b.r-dist)*.42));c.setAttribute('class','ol-zone');layer.appendChild(c);}
  }
}

export function renderGridLayer(layer, ctx){
  const mk=(tag)=>ctx.doc.createElementNS('http://www.w3.org/2000/svg',tag);
  layer.innerHTML='';if(!ctx.showGrid)return;
  const w=ctx.w||1,h=ctx.h||1;
  const g=mk('g');g.setAttribute('class','snap-grid');
  for(let x=0;x<=w;x+=ctx.gridSize){const l=mk('line');l.setAttribute('x1',x);l.setAttribute('y1',0);l.setAttribute('x2',x);l.setAttribute('y2',h);g.appendChild(l);}
  for(let y=0;y<=h;y+=ctx.gridSize){const l=mk('line');l.setAttribute('x1',0);l.setAttribute('y1',y);l.setAttribute('x2',w);l.setAttribute('y2',y);g.appendChild(l);}
  layer.appendChild(g);
}
