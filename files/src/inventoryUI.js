// Inventory & rollout dialog: a flat, searchable as-built record of every
// device on every floor, with rollout progress and inline status editing.
// Builds DOM from the data passed in; every plan string goes through esc().

import { esc } from './html.js';
import { DEVICE_STATUSES, DEVICE_STATUS_META } from './constants.js';

/**
 * @param {Document} doc
 * @param {{devices:Array<{dev:any,type:string,floor:any,floorIdx:number}>, counts:Record<string,number>,
 *   statusMeta:(dev:any)=>{label:string,color:string},
 *   onStatus:(dev:any, status:string)=>void, onOpen:(entry:any)=>void,
 *   actions:{ipAll:()=>void, rename:()=>void, inventoryCsv:()=>void, ipPlanCsv:()=>void, portMapCsv:()=>void, handover:()=>void}}} p
 * @returns {HTMLElement}
 */
export function inventoryEl(doc, { devices: devs, counts, statusMeta, onStatus, onOpen, actions }) {
  const wrap = doc.createElement('div');
  wrap.style.cssText = 'font-family:inherit;font-size:13px';
  if (!devs.length) {
    wrap.textContent = 'Nothing placed yet. Add APs, cameras or switches first.';
    return wrap;
  }
  // Rollout progress pills.
  const prog = doc.createElement('div');
  prog.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:11px';
  for (const s of DEVICE_STATUSES) {
    const m = DEVICE_STATUS_META[s];
    const pill = doc.createElement('span');
    pill.style.cssText = 'display:flex;align-items:center;gap:5px';
    pill.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:${m.color}"></span>${m.label} <strong>${counts[s]}</strong>`;
    prog.appendChild(pill);
  }
  const done = counts.live + counts.tested;
  const pct = Math.round((done / devs.length) * 100);
  const pctEl = doc.createElement('span');
  pctEl.style.cssText = 'margin-left:auto;font-family:var(--font-mono);font-size:11px;opacity:.7';
  pctEl.textContent = `${pct}% tested/live`;
  prog.appendChild(pctEl);
  wrap.appendChild(prog);
  // Search box.
  const search = doc.createElement('input');
  search.className = 'ep-in'; search.type = 'text'; search.placeholder = 'Filter by name, model, serial, IP, status…';
  search.style.cssText = 'width:100%;margin-bottom:8px';
  wrap.appendChild(search);
  // Table.
  const scroller = doc.createElement('div');
  scroller.style.cssText = 'max-height:46vh;overflow:auto;border:1px solid var(--ink-04);border-radius:3px';
  const tbl = doc.createElement('table');
  tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';
  tbl.innerHTML = `<thead><tr style="position:sticky;top:0;background:var(--bg,inherit)">${
    ['Floor', 'Type', 'Name', 'Model', 'Status', 'Serial', 'Asset', 'IP', 'Switch·Port']
      .map((h) => `<th style="text-align:left;font-size:9px;letter-spacing:.12em;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--ink-04)">${h}</th>`).join('')
  }</tr></thead>`;
  const tbody = doc.createElement('tbody');
  tbl.appendChild(tbody); scroller.appendChild(tbl); wrap.appendChild(scroller);
  const renderRows = () => {
    const q = (search.value || '').trim().toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;
    for (const entry of devs) {
      const { dev, type, floor, floorIdx } = entry;
      const hay = [dev.name, dev.model, dev.serial, dev.assetTag, dev.firmware, dev.ip, dev.mac, dev.vlan, statusMeta(dev).label, floor.name].join(' ').toLowerCase();
      if (q && !hay.includes(q)) continue;
      shown++;
      const sw = (floor.SWS || []).find((s) => s.id === dev.swId);
      const tr = doc.createElement('tr');
      tr.style.cssText = 'cursor:pointer';
      const td = (html, mono) => { const c = doc.createElement('td'); c.style.cssText = `padding:5px 8px;border-bottom:1px solid var(--ink-04)${mono ? ';font-family:\'Share Tech Mono\',monospace;font-size:10px' : ''}`; c.innerHTML = html; return c; };
      tr.appendChild(td(esc(floor.name || `Floor ${floorIdx + 1}`)));
      tr.appendChild(td(type));
      tr.appendChild(td(`<strong>${esc(dev.name || dev.id)}</strong>`));
      tr.appendChild(td(esc(dev.model || '')));
      // Inline status editor — the one field that changes during a rollout.
      const stTd = td('');
      const stSel = doc.createElement('select');
      stSel.className = 'ep-sel'; stSel.style.cssText = 'font-size:11px;padding:2px 4px';
      for (const s of DEVICE_STATUSES) {
        const o = doc.createElement('option'); o.value = s; o.textContent = DEVICE_STATUS_META[s].label;
        if ((dev.status || 'planned') === s) o.selected = true;
        stSel.appendChild(o);
      }
      stSel.style.color = statusMeta(dev).color;
      stSel.addEventListener('click', (e) => e.stopPropagation());
      stSel.addEventListener('change', () => { onStatus(dev, stSel.value); stSel.style.color = statusMeta(dev).color; });
      stTd.appendChild(stSel); tr.appendChild(stTd);
      tr.appendChild(td(esc(dev.serial || '—'), true));
      tr.appendChild(td(esc(dev.assetTag || '—'), true));
      tr.appendChild(td(esc(dev.ip || '—'), true));
      tr.appendChild(td(esc(sw ? (sw.name || sw.id) : '—') + (dev.port ? ` · ${esc(String(dev.port))}` : '')));
      tr.addEventListener('click', () => onOpen(entry));
      tbody.appendChild(tr);
    }
    if (!shown) {
      const tr = doc.createElement('tr');
      tr.innerHTML = `<td colspan="9" style="padding:14px;text-align:center;opacity:.6">No matches.</td>`;
      tbody.appendChild(tr);
    }
  };
  renderRows();
  search.addEventListener('input', renderRows);
  // Footer: organization actions + exports.
  const foot = doc.createElement('div');
  foot.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px';
  const mkBtn = (label, title, fn) => {
    const b = doc.createElement('button'); b.className = 'btn'; b.textContent = label; b.title = title;
    b.addEventListener('click', fn); foot.appendChild(b);
  };
  mkBtn('IP+ all', 'Fill every empty IP from its VLAN subnet', actions.ipAll);
  mkBtn('Auto-rename', 'Rename all devices to the convention in Settings → Organization', actions.rename);
  mkBtn('⇣ Inventory CSV', 'Export this table as CSV', actions.inventoryCsv);
  mkBtn('⇣ IP plan CSV', 'One row per device with IP/VLAN/subnet', actions.ipPlanCsv);
  mkBtn('⇣ Port map CSV', 'One row per switch port', actions.portMapCsv);
  const hb = doc.createElement('button'); hb.className = 'btn btn-primary'; hb.textContent = '⇩ Handover pack';
  hb.title = 'Zip of the HTML summary + every CSV deliverable';
  hb.addEventListener('click', actions.handover);
  foot.appendChild(hb);
  wrap.appendChild(foot);
  return wrap;
}
