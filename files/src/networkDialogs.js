// The PoE budget and network topology dialogs, plus the switch port grid the
// printed network report reuses. They build DOM from plan data passed in;
// every plan string goes through esc().

import { esc } from './html.js';

/** Port grid for one analysed switch, as markup (also used in the report). */
export function portGridHtml(a, border) {
  border = border || 'var(--ink-04)';
  if (a.ports == null) return `<div style="font-size:11px;opacity:.7">${a.used} device(s) · port count unknown</div>`;
  const byPort = new Map();
  for (const c of a.clients) { const p = parseInt(c.port, 10); if (p >= 1 && p <= a.ports) byPort.set(p, c); }
  let cells = '';
  for (let i = 1; i <= a.ports; i++) {
    const c = byPort.get(i);
    const bg = c ? (c.type === 'AP' ? '#1565c0' : '#6a1b9a') : 'transparent';
    cells += `<div title="${esc(c ? `Port ${i}: ${c.name} (${c.model})` : `Port ${i}: free`)}" style="width:17px;height:14px;border:1px solid ${border};border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;font-family:'Share Tech Mono',monospace;background:${bg};color:${c ? '#fff' : 'inherit'}">${i}</div>`;
  }
  const noPort = a.clients.filter((c) => { const p = parseInt(c.port, 10); return !(p >= 1 && p <= a.ports); });
  const extra = noPort.length ? `<div style="font-size:10px;opacity:.6;margin-top:3px">${noPort.length} device(s) without a port #</div>` : '';
  return `<div style="display:flex;flex-wrap:wrap;gap:3px">${cells}</div>${extra}`;
}

/**
 * PoE budget per switch on the floor, with totals and two shortcuts.
 * @param {Document} doc
 * @param {{analyses:any[], onAutoAssign:()=>void, onValidate:()=>void}} p  analyses: analyzeSwitch() per switch
 * @returns {HTMLElement}
 */
export function poeSummaryEl(doc, { analyses, onAutoAssign, onValidate }) {
  const wrap = doc.createElement('div');
  wrap.style.cssText = 'font-family:inherit;font-size:13px';
  if (!analyses.length) {
    wrap.textContent = 'No switches placed yet. Drop a switch on the map (W) then assign APs/cameras to it.';
    return wrap;
  }
  let totalDraw = 0, totalBudget = 0;
  for (const a of analyses) {
    const sw = a.sw;
    totalDraw += a.draw; totalBudget += a.budget;
    const sec = doc.createElement('div'); sec.style.cssText = 'margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(0,0,0,.08)';
    const head = doc.createElement('div'); head.style.cssText = 'display:flex;justify-content:space-between;font-weight:600;margin-bottom:4px';
    const portStr = a.ports != null ? ` · ${a.used}/${a.ports} ports` : ` · ${a.used} ports`;
    head.innerHTML = `<span>${esc(sw.name)} <span style="font-family:var(--font-mono);font-size:10px;opacity:.6">${esc(sw.model || '')}${esc(portStr)}</span></span>
      <span style="font-family:var(--font-mono);color:${a.overBudget ? '#c0382b' : '#1e7d3c'}">${a.draw.toFixed(1)} W${a.budget > 0 ? ` / ${a.budget} W${a.headroom != null ? ` · ${a.headroom}%` : ''}` : ''}</span>`;
    sec.appendChild(head);
    if (!a.clients.length) {
      const empty = doc.createElement('div'); empty.style.cssText = 'font-size:11px;opacity:.6;font-style:italic'; empty.textContent = 'No devices assigned.';
      sec.appendChild(empty);
    } else {
      for (const c of a.clients) {
        const bad = a.classFails.includes(c);
        const li = doc.createElement('div'); li.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;padding:2px 8px;opacity:.85';
        li.innerHTML = `<span>${c.type === 'AP' ? '●' : '◉'} ${esc(c.name)} <span style="opacity:.5">${esc(c.model)}</span></span><span style="font-family:var(--font-mono)${bad ? ';color:#c0382b;font-weight:700' : ''}">${c.w} W${c.cls ? ` ${c.cls}` : ''}</span>`;
        sec.appendChild(li);
      }
    }
    const warn = (txt) => { const d = doc.createElement('div'); d.style.cssText = 'font-size:11px;color:#c0382b;margin-top:4px;font-weight:600'; d.textContent = txt; sec.appendChild(d); };
    if (a.overBudget) warn('⚠ Draw exceeds budget — switch may shut down PoE on lower-priority ports.');
    if (a.overPorts) warn(`⚠ ${a.used} devices on a ${a.ports}-port switch — over capacity.`);
    if (a.classFails.length) warn(`⚠ ${a.classFails.length} device(s) need ${a.classFails.map((c) => c.cls).sort().pop()} PoE; switch delivers ${a.swCls || 'none'}.`);
    wrap.appendChild(sec);
  }
  const total = doc.createElement('div'); total.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #000;font-weight:600;display:flex;justify-content:space-between';
  total.innerHTML = `<span>Total</span><span style="font-family:var(--font-mono)">${totalDraw.toFixed(1)} W${totalBudget > 0 ? ` / ${totalBudget} W` : ''}</span>`;
  wrap.appendChild(total);
  const foot = doc.createElement('div'); foot.style.cssText = 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap';
  const mkBtn = (label, fn) => { const b = doc.createElement('button'); b.className = 'btn'; b.textContent = label; b.addEventListener('click', fn); foot.appendChild(b); };
  mkBtn('⚯ Auto-assign to nearest switch', onAutoAssign);
  mkBtn('✓ Validate network', onValidate);
  wrap.appendChild(foot);
  const hint = doc.createElement('div'); hint.style.cssText = 'margin-top:10px;font-size:10px;opacity:.55';
  hint.textContent = 'PoE budgets / port counts are set per switch in the switch properties panel.';
  wrap.appendChild(hint);
  return wrap;
}

/**
 * Uplink tree, rack/port view and cabling rollup for the whole building.
 * @param {Document} doc
 * @param {{model:{all:any[], children:Map<string,any[]>, roots:any[]}, analyze:(sw:any, floor:any)=>any,
 *          multiFloor:boolean, cable:{runs:number,totalM:number}, cableBoxM:any, routing:number}} p
 * @returns {HTMLElement}
 */
export function topologyEl(doc, { model, analyze, multiFloor, cable, cableBoxM, routing }) {
  const wrap = doc.createElement('div');
  wrap.style.cssText = 'font-family:inherit;font-size:13px';
  const { all, children, roots } = model;
  if (!all.length) { wrap.textContent = 'No switches placed yet.'; return wrap; }
  const th = doc.createElement('div'); th.style.cssText = 'font-weight:700;margin-bottom:4px'; th.textContent = 'Uplink tree'; wrap.appendChild(th);
  const tree = doc.createElement('div'); wrap.appendChild(tree);
  const seen = new Set();
  const renderNode = (e, depth) => {
    if (seen.has(e.sw.id)) return;            // guard against accidental cycles
    seen.add(e.sw.id);
    const a = analyze(e.sw, e.floor);
    const row = doc.createElement('div');
    row.style.cssText = `padding:3px 0 3px ${depth * 18}px;display:flex;justify-content:space-between;gap:10px`;
    const portStr = a.ports != null ? `${a.used}/${a.ports}` : `${a.used}`;
    const floorTag = multiFloor ? ` <span style="opacity:.45;font-size:9px">[${esc(e.floor.name || ('Floor ' + (e.floorIdx + 1)))}]</span>` : '';
    row.innerHTML = `<span>${depth ? '└ ' : ''}⊞ <strong>${esc(e.sw.name)}</strong> <span style="opacity:.55;font-family:var(--font-mono);font-size:10px">${esc(e.sw.model || '')}</span>${floorTag}</span>
      <span style="font-family:var(--font-mono);font-size:10px;opacity:.7">${portStr} ports · ${a.draw.toFixed(0)} W</span>`;
    tree.appendChild(row);
    (children.get(e.sw.id) || []).forEach((c) => renderNode(c, depth + 1));
  };
  roots.forEach((e) => renderNode(e, 0));
  all.forEach((e) => { if (!seen.has(e.sw.id)) renderNode(e, 0); });  // safety net
  const rh = doc.createElement('div'); rh.style.cssText = 'font-weight:700;margin:14px 0 6px'; rh.textContent = 'Rack — port usage'; wrap.appendChild(rh);
  for (const e of all) {
    const a = analyze(e.sw, e.floor);
    const unit = doc.createElement('div'); unit.style.cssText = 'margin-bottom:8px;padding:6px 8px;border:1px solid var(--ink-04);border-radius:3px';
    unit.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span><strong>${esc(e.sw.name)}</strong> <span style="opacity:.55;font-size:10px">${esc(e.sw.model || '')}</span></span><span style="font-family:var(--font-mono);opacity:.7">${a.ports != null ? `${a.used}/${a.ports}` : `${a.used}/?`}${a.overPorts ? ' ⚠' : ''}</span></div>${portGridHtml(a)}`;
    wrap.appendChild(unit);
  }
  if (cable.runs > 0) {
    const boxM = parseFloat(cableBoxM) || 305;
    const cl = doc.createElement('div'); cl.style.cssText = 'margin-top:12px;padding-top:8px;border-top:1px solid var(--ink-04);font-size:11px;opacity:.8';
    cl.textContent = `Cabling: ${cable.runs} runs · ~${cable.totalM} m incl. slack (×${routing} routing) · ~${Math.ceil(cable.totalM / boxM)} box(es)`;
    wrap.appendChild(cl);
  }
  return wrap;
}
