// HTML building blocks shared by the device panels (right-hand inspector).
// Pure string builders; every plan value goes through esc().

import { esc } from './html.js';
import { DEVICE_STATUSES, DEVICE_STATUS_META } from './constants.js';

export const CRED_PROTOS=['https','http','ssh','telnet'];

export function credsBlock(dev){
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
    <div class="ep-row"><label class="ep-lbl">SSH key</label><input class="ep-in ep-mono" id="cred-key" value="${esc(c.key||'')}" data-input-action="upd-creds" placeholder="~/.ssh/id_ed25519 (optional)"/></div>
    <div class="ep-row"><a href="#" data-action="open-mgmt" style="font-size:11px">↗ Open management UI</a></div>
    <div class="ep-row" style="font-size:10px;opacity:.55">Saved in the project file only — excluded from Share links and PDF/HTML reports.</div>`;
}

export function inventoryBlock(dev,p,act){
  return `<div class="ep-section">Status &amp; Inventory</div>
    <div class="ep-row"><label class="ep-lbl">Status</label><select class="ep-sel" id="${p}-status" data-input-action="${act}">${statusOptions(dev.status)}</select></div>
    <div class="ep-row"><label class="ep-lbl">Serial #</label><input class="ep-in ep-mono" id="${p}-serial" value="${esc(dev.serial||'')}" data-input-action="${act}" placeholder="from the unit label"/></div>
    <div class="ep-row"><label class="ep-lbl">Asset Tag</label><input class="ep-in ep-mono" id="${p}-asset" value="${esc(dev.assetTag||'')}" data-input-action="${act}" placeholder="ASSET-0001"/></div>
    <div class="ep-row"><label class="ep-lbl">Firmware</label><input class="ep-in ep-mono" id="${p}-firmware" value="${esc(dev.firmware||'')}" data-input-action="${act}" placeholder="e.g. 6.5.28"/></div>`;
}

export function portOptions(ports,cur){
  cur=(cur==null?'':String(cur)).trim();
  const curNum=/^\d+$/.test(cur)?parseInt(cur,10):null;
  let html=`<option value=""${cur===''?' selected':''}>— unassigned —</option>`;
  if(cur!=='' && (curNum===null || (ports!=null && (curNum<1||curNum>ports))))
    html+=`<option value="${esc(cur)}" selected>${esc(cur)} (custom)</option>`;
  if(ports!=null)for(let i=1;i<=ports;i++)
    html+=`<option value="${i}"${curNum===i?' selected':''}>Port ${i}</option>`;
  return html;
}

export function portControl(ports,cur,attrs){
  cur=cur==null?'':String(cur);
  return ports!=null
    ? `<select class="ep-sel" ${attrs}>${portOptions(ports,cur)}</select>`
    : `<input class="ep-in" type="number" min="1" value="${esc(cur)}" placeholder="Port #" ${attrs}/>`;
}

export function statusOptions(cur){
  cur=DEVICE_STATUSES.includes(cur)?cur:'planned';
  return DEVICE_STATUSES.map(s=>`<option value="${s}"${s===cur?' selected':''}>${DEVICE_STATUS_META[s].label}</option>`).join('');
}

export function buildGroupedOptions(groups,selected){
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

/** <datalist> of registered VLAN ids for the device VLAN inputs. */
export function vlanDatalist(vlans){
  if(!vlans.length)return '';
  return `<datalist id="vlan-list">${vlans.map(v=>`<option value="${esc(v.id)}">${esc(v.name||'')}</option>`).join('')}</datalist>`;
}

