// The right-hand inspector panels (AP, switch/router, camera, wall, dead
// zone) as markup. The app looks up the item, sets the header, inserts the
// markup and wires it; these only build it. Live values come in through ctx
// (current floor's switches, all floors, scale, measurements and the image /
// datalist / airtime helpers that need the running app). Plan values go
// through esc().

import { esc } from './html.js';
import { AP_MODEL_GROUPS, AP_COLORS, AP_PATTERN_KEYS, AP_PATTERNS, SW_MODEL_GROUPS, SW_MODELS, swPortCount, CAM_MODEL_GROUPS, WALL_MATERIAL_KEYS } from './constants.js';
import { CHANNEL_WIDTHS, WALL_MATERIALS } from './geometry.js';
import { routerWifiSpec } from './routerWifi.js';
import { doriDistancesM, cameraBitrateMbps } from './cameras.js';
import { buildGroupedOptions, portControl, inventoryBlock, credsBlock } from './panelBlocks.js';

/**
 * @typedef {Object} PanelCtx
 * @property {any[]} switches   switches on the floor on screen
 * @property {any[]} floors
 * @property {number} mPerPx    metres per image pixel on the floor on screen
 * @property {(item:any, type:string)=>string} deviceImageBlock
 * @property {(dev:any)=>number|null} devSwitchPorts
 * @property {(ap:any)=>string} airtimeLabel
 * @property {(basePx:number, m:number)=>number} radiusMaxPx
 * @property {()=>string} vlanDatalist
 * @property {(sw:any)=>any} analyze
 * @property {(cam:any)=>string} camStorageLabel
 * @property {(w:any)=>{x1:number,y1:number,x2:number,y2:number}} wallPx
 * @property {'h264'|'h265'} storageCodec
 */

/** @param {any} ap @param {PanelCtx} ctx @returns {string} */
export function apPanelHtml(ap, ctx) {
  const mOpts=buildGroupedOptions(AP_MODEL_GROUPS,ap.model||'U6 Pro');
  const realR=Math.round(ap.r*ctx.mPerPx);
  return `
    ${ctx.deviceImageBlock(ap,'ap')}
    <div class="ep-section">Identity</div>
    <div class="ep-row"><label class="ep-lbl">Name</label><input class="ep-in" id="ep-name" value="${esc(ap.name)}" data-input-action="upd-ap"/></div>
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
      <input class="ep-rng" id="ep-r" type="range" min="15" max="${ctx.radiusMaxPx(500,100)}" value="${Math.round(ap.r)}" data-input-action="upd-ap-r"/>
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
    <div class="ep-row"><label class="ep-lbl">Airtime est.</label><span class="ep-rng-val" id="ep-airtime-v">${ctx.airtimeLabel(ap)}</span></div>
    <div class="ep-section">Network Info</div>
    <div class="ep-row"><label class="ep-lbl">IP Address</label><input class="ep-in" id="ep-ip" value="${esc(ap.ip||'')}" data-input-action="upd-ap" placeholder="192.168.1.x"/><button class="btn" style="flex:0 0 auto;padding:4px 8px" data-action="suggest-ip-ap" title="Suggest next free IP in this device's VLAN subnet">IP+</button></div>
    <div class="ep-row"><label class="ep-lbl">MAC Address</label><input class="ep-in ep-mono" id="ep-mac" value="${esc(ap.mac||'')}" data-input-action="upd-ap" placeholder="aa:bb:cc:dd:ee:ff"/></div>
    <div class="ep-row"><label class="ep-lbl">Switch</label>
      <select class="ep-sel" id="ep-sw" data-input-action="upd-ap">
        <option value=""${!ap.swId?' selected':''}>— None —</option>
        ${ctx.switches.map(sw=>`<option value="${esc(sw.id)}"${sw.id===ap.swId?' selected':''}>${esc(sw.name)} · ${esc(sw.model||'')}</option>`).join('')}
      </select>
    </div>
    <div class="ep-row"><label class="ep-lbl">Switch Port</label>${ap.swId
      ? portControl(ctx.devSwitchPorts(ap),ap.port,'id="ep-port" data-input-action="upd-ap"')
      : `<input class="ep-in" id="ep-port" value="${esc(ap.port||'')}" data-input-action="upd-ap" placeholder="Assign a switch first" disabled/>`}</div>
    <div class="ep-row"><label class="ep-lbl">VLAN</label><input class="ep-in" id="ep-vlan" list="vlan-list" value="${esc(ap.vlan||'')}" data-input-action="upd-ap" placeholder="10"/>${ctx.vlanDatalist()}</div>
    ${inventoryBlock(ap,'ep','upd-ap')}
    <div class="ep-section">Options</div>
    <label class="ep-check"><input type="checkbox" ${ap.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    <div class="ep-btn-row">
      <button class="btn" data-action="duplicate">⧉ Duplicate</button>
    </div>
    ${credsBlock(ap)}
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="ep-notes" rows="4" data-input-action="upd-ap" placeholder="Cable run, switch port, install notes...">${esc(ap.notes||'')}</textarea></div>
    <button class="btn ep-del" data-action="ask-del">✕ Delete AP</button>`;
}

/** @param {any} sw @param {PanelCtx} ctx @returns {string} */
export function swPanelHtml(sw, ctx) {
  // Built-in WiFi (only for models that have a radio — ./src/routerWifi.js).
  const wifiSpec=routerWifiSpec(sw.model);
  const wifiRow=wifiSpec?`<label class="ep-check"><input type="checkbox" id="sw-wifi" ${sw.wifi===false?'':'checked'} data-input-action="upd-sw"/><span>Built-in WiFi — ${esc(wifiSpec.std)}, ${esc(wifiSpec.freq)}, about ${esc(wifiSpec.rangeM)} m (coverage, and wireless clients can join it)</span></label>`:'';
  const mOpts=buildGroupedOptions(SW_MODEL_GROUPS,sw.model||'USW-24-PoE');
  // If the stored model isn't in our known list, treat it as a custom override
  const isCustom=!SW_MODELS.includes(sw.model||'');
  const a=ctx.analyze(sw);
  const derivedPorts=swPortCount(sw.model);
  // Any other switch in the building is a candidate uplink target (grouped by
  // floor so risers to another floor are easy to pick).
  const uplinkOpts=ctx.floors.map((f,i)=>{
    const opts=(f.SWS||[]).filter(s=>s.id!==sw.id)
      .map(s=>`<option value="${esc(s.id)}"${s.id===sw.uplinkId?' selected':''}>${esc(s.name)} · ${esc(s.model||'')}</option>`).join('');
    return opts?`<optgroup label="${esc(f.name||('Floor '+(i+1)))}">${opts}</optgroup>`:'';
  }).join('');
  const uplink2Opts=ctx.floors.map((f,i)=>{
    const opts=(f.SWS||[]).filter(s=>s.id!==sw.id)
      .map(s=>`<option value="${esc(s.id)}"${s.id===sw.uplink2Id?' selected':''}>${esc(s.name)} · ${esc(s.model||'')}</option>`).join('');
    return opts?`<optgroup label="${esc(f.name||('Floor '+(i+1)))}">${opts}</optgroup>`:'';
  }).join('');
  const statusColor=a.overBudget||a.overPorts||a.classFails.length?'#c0382b':'#1e7d3c';
  const portTxt=a.ports!=null?`${a.used}/${a.ports}`:`${a.used}`;
  const statusLine=`${a.draw.toFixed(0)} W${a.budget>0?` / ${a.budget} W${a.headroom!=null?` (${a.headroom}% free)`:''}`:''} · ${portTxt} ports${a.swCls?` · ${a.swCls.toUpperCase()}`:' · no PoE'}`;
  return `
    ${ctx.deviceImageBlock(sw,'sw')}
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
    <div class="ep-row"><label class="ep-lbl">Uplink Type</label>
      <select class="ep-sel" id="sw-uplinkmode" data-input-action="upd-sw">
        <option value="trunk"${sw.uplinkMode!=='routed'?' selected':''}>Trunk (L2)</option>
        <option value="routed"${sw.uplinkMode==='routed'?' selected':''}>Routed (L3 /30)</option>
      </select>
    </div>
    <div class="ep-row"><label class="ep-lbl">Redundant uplink</label>
      <select class="ep-sel" id="sw-uplink2" data-input-action="upd-sw" title="A second trunk to another switch. Spanning tree blocks one link and fails over to the other.">
        <option value=""${!sw.uplink2Id?' selected':''}>— None —</option>${uplink2Opts}
      </select>
    </div>
    <div class="ep-row"><label class="ep-lbl">STP priority</label><input class="ep-in ep-mono" id="sw-stp" type="number" min="0" max="61440" step="4096" value="${Number.isFinite(sw.stpPriority)?sw.stpPriority:''}" data-input-action="upd-sw" placeholder="32768 (lowest becomes root)"/></div>
    <label class="ep-check"><input type="checkbox" id="sw-l3" ${sw.role==='l3'?'checked':''} data-input-action="upd-sw"/><span>Layer 3 — routes between VLANs (set a gateway IP per VLAN in Project Settings)</span></label>
    ${wifiRow}
    <div class="ep-row"><button class="btn" data-action="open-console" style="width:100%">⌨ CLI Console (IOS / RouterOS)</button></div>
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
    <div class="ep-row"><textarea class="ep-txt" id="sw-notes" rows="3" data-input-action="upd-sw" placeholder="Location, uplink, config notes...">${esc(sw.notes||'')}</textarea></div>
    <label class="ep-check"><input type="checkbox" ${sw.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    <button class="btn ep-del" data-action="ask-del">✕ Delete</button>`;
}

/** @param {any} c @param {PanelCtx} ctx @returns {string} */
export function camPanelHtml(c, ctx) {
  const mOpts=buildGroupedOptions(CAM_MODEL_GROUPS,c.model||'G4 Pro');
  const realR=Math.round((c.range||80)*ctx.mPerPx);
  const swOptions=ctx.switches.map(sw=>`<option value="${esc(sw.id)}"${sw.id===c.swId?' selected':''}>${esc(sw.name)} · ${esc(sw.model||'')}</option>`).join('');
  return `
    ${ctx.deviceImageBlock(c,'cam')}
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
      <input class="ep-rng" id="cam-range" type="range" min="20" max="${ctx.radiusMaxPx(400,150)}" value="${Math.round(c.range||80)}" data-input-action="upd-cam-range"/>
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
    <div class="ep-row"><label class="ep-lbl">Bitrate (Mbps)</label><input class="ep-in ep-mono" id="cam-bitrate" type="number" min="0" step="0.5" value="${c.bitrateMbps||''}" data-input-action="upd-cam" placeholder="auto: ${cameraBitrateMbps(c.resolution||'4K',ctx.storageCodec)}"/></div>
    <div class="ep-row"><label class="ep-lbl">Storage</label><span class="ep-rng-val" id="cam-storage-v">${ctx.camStorageLabel(c)}</span></div>
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
      ? portControl(ctx.devSwitchPorts(c),c.port,'id="cam-port" data-input-action="upd-cam"')
      : `<input class="ep-in" id="cam-port" value="${esc(c.port||'')}" data-input-action="upd-cam" placeholder="Assign a switch first" disabled/>`}</div>
    <div class="ep-row"><label class="ep-lbl">VLAN</label><input class="ep-in" id="cam-vlan" list="vlan-list" value="${esc(c.vlan||'')}" data-input-action="upd-cam" placeholder="20"/>${ctx.vlanDatalist()}</div>
    ${inventoryBlock(c,'cam','upd-cam')}
    <div class="ep-section">Options</div>
    <label class="ep-check"><input type="checkbox" ${c.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    ${credsBlock(c)}
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="cam-notes" rows="3" data-input-action="upd-cam" placeholder="Mount type, lens info, install notes…">${esc(c.notes||'')}</textarea></div>
    <button class="btn ep-del" data-action="ask-del">✕ Delete Camera</button>`;
}

/** @param {any} w @param {PanelCtx} ctx @returns {string} */
export function wallPanelHtml(w, ctx) {
  const mat=WALL_MATERIALS[w.material]||WALL_MATERIALS.drywall;
  const px=ctx.wallPx(w);
  const lengthPx=Math.hypot(px.x2-px.x1,px.y2-px.y1);
  const lengthM=(lengthPx*ctx.mPerPx).toFixed(1);
  const opts=WALL_MATERIAL_KEYS.map(k=>{
    const m=WALL_MATERIALS[k];
    return `<option value="${k}"${k===w.material?' selected':''}>${esc(m.label)} · ${m.loss} dB</option>`;
  }).join('');
  return `
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

/** @param {any} dz @param {PanelCtx} ctx @returns {string} */
export function dzPanelHtml(dz, ctx) {
  const realR=Math.round(dz.r*ctx.mPerPx);
  return `
    <div class="ep-section">Label</div>
    <div class="ep-row"><input class="ep-in" id="dz-lbl" value="${esc(dz.label)}" data-input-action="upd-dz"/></div>
    <div class="ep-section">Radius</div>
    <div class="ep-row ep-slider-row">
      <input class="ep-rng" id="dz-r" type="range" min="10" max="${ctx.radiusMaxPx(300,60)}" value="${Math.round(dz.r)}" data-input-action="upd-dz-r"/>
      <span class="ep-rng-val" id="dz-rv">${realR}m</span>
    </div>
    <label class="ep-check"><input type="checkbox" ${dz.locked?'checked':''} data-change-action="toggle-lock"/><span>Lock position</span></label>
    <div class="ep-section">Notes</div>
    <div class="ep-row"><textarea class="ep-txt" id="dz-notes" rows="3" data-input-action="upd-dz" placeholder="Why this area is a dead zone, remediation plan…">${esc(dz.notes||'')}</textarea></div>
    <button class="btn ep-del" data-action="ask-del">✕ Delete</button>`;
}
