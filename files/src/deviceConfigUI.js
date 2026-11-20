// "Plan → device" dialog: pick a switch, assign the physical trunk interfaces
// the plan can't know, get a RouterOS script for it, and check a real device's
// `/export` against the plan (drift). A thin DOM shell over rosExport.js and
// drift.js; everything user- or file-controlled reaches the DOM via textContent
// / .value only.

import { planDeviceModel, renderRouterOs } from './rosExport.js';
import { parseRouterOsExport, diffAgainstPlan, remediationScript } from './drift.js';

const SEV_LABEL = { error: '✗', warn: '⚠', info: 'ℹ' };

/**
 * @param {{root:any, getProject:()=>any, switchId?:string,
 *   onChange?:()=>void, onDownload?:(filename:string, text:string)=>void,
 *   onPull?:(sw:any)=>Promise<any>,
 *   onDeploy?:(sw:any, filename:string, text:string)=>Promise<any>,
 *   onDrift?:(sw:any, result:{errors:number,warnings:number,info:number})=>void}} opts
 *   onChange   called after trunk/prefix assignments were edited (they are
 *              stored on the switch object, so the caller should autosave)
 *   onDownload saves the generated script
 *   onPull     (optional, desktop) reads the device's config over SSH:
 *              (switch) => Promise<{ok:boolean, text?:string, error?:string}>
 *   onDeploy   (optional, desktop) hands a script to rosconf as a DRY RUN:
 *              (switch, filename, text) => Promise<{ok:boolean, launched?:boolean,
 *              command?:string, error?:string}|null>   (null = cancelled)
 *   onDrift    (optional) told the outcome of every drift check:
 *              (switch, {errors:number, warnings:number, info:number})
 */
export function mountDeviceConfig(opts) {
  const { root, getProject, onChange, onDownload, onPull, onDeploy, onDrift } = opts;
  const doc = root.ownerDocument;
  const el = (tag, attrs = {}, kids = []) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids) n.appendChild(c);
    return n;
  };
  const switches = () => (getProject().floors || []).flatMap((f) => (Array.isArray(f.SWS) ? f.SWS : [])).filter((s) => s && s.id);

  const swSel = el('select', { class: 'ep-sel dc-switch' });
  const prefixInp = el('input', { class: 'ep-in ep-mono dc-prefix', placeholder: 'ether', maxlength: '16' });
  const trunkBox = el('div', { class: 'dc-trunks' });
  const warnBox = el('ul', { class: 'dc-warnings' });
  const script = el('textarea', { class: 'dc-script ep-mono', readonly: 'readonly', rows: '14', spellcheck: 'false' });
  const dlBtn = el('button', { class: 'btn btn-primary', text: '↓ Download .rsc' });
  const copyBtn = el('button', { class: 'btn', text: 'Copy' });
  const deployBtn = el('button', { class: 'btn dc-deploy', text: '⇢ Dry-run with rosconf', title: 'Open a terminal running rosconf in dry-run mode for this script' });
  const deployOut = el('div', { class: 'ep-hint dc-deploy-out' });
  const lastCheck = el('div', { class: 'ep-hint dc-last-check' });
  const canDeploy = typeof onDeploy === 'function';
  // Hand a script to rosconf (dry run) and say what happened / what to run.
  async function deploy(sw, filename, text, out) {
    out.textContent = 'Preparing…';
    let res;
    if (!onDeploy) return;
    try { res = await onDeploy(sw, filename, text); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res) { out.textContent = ''; return; }
    if (!res.ok) { out.textContent = `✕ ${res.error || 'Could not start rosconf'}`; return; }
    out.textContent = (res.launched
      ? 'Opened a terminal with a DRY RUN — nothing was changed. Read what it would send; to apply it, re-run the same command with --apply added:'
      : 'Run this in a terminal for a DRY RUN (nothing changes until you add --apply):') + '\n' + (res.command || '');
  }
  const actual = el('textarea', { class: 'dc-actual ep-mono', rows: '7', spellcheck: 'false', placeholder: 'Paste the output of  /export  from the device here…' });
  const fileInp = el('input', { type: 'file', accept: '.rsc,.txt,text/plain', class: 'dc-file' });
  const checkBtn = el('button', { class: 'btn btn-primary', text: 'Check drift' });
  const pullBtn = el('button', { class: 'btn', text: '⇣ Pull from device', title: 'Read the configuration over SSH (read-only) and check it' });
  const fixBox = el('div', { class: 'dc-fix' });
  const driftOut = el('div', { class: 'dc-drift' });

  root.innerHTML = '';
  root.classList.add('dc-root');
  root.append(
    el('div', { class: 'ep-row' }, [el('label', { class: 'ep-lbl', text: 'Device' }), swSel]),
    lastCheck,
    el('div', { class: 'ep-row' }, [el('label', { class: 'ep-lbl', text: 'Port prefix' }), prefixInp]),
    trunkBox,
    el('div', { class: 'ep-section', text: 'RouterOS 7 config from the plan' }),
    warnBox,
    script,
    el('div', { class: 'ep-btn-row' }, [dlBtn, copyBtn, ...(canDeploy ? [deployBtn] : [])]),
    deployOut,
    el('div', { class: 'ep-hint', text: 'Review before applying. Bridge VLAN filtering is switched on as the last step — apply from the console or in Safe Mode.' }),
    el('div', { class: 'ep-section', text: 'Drift check — does the device still match the plan?' }),
    actual,
    el('div', { class: 'ep-btn-row' }, [...(typeof onPull === 'function' ? [pullBtn] : []), fileInp, checkBtn]),
    driftOut,
    fixBox
  );

  const current = () => switches().find((s) => s.id === swSel.value) || null;
  const modelOpts = (sw) => ({ portPrefix: sw.portPrefix || 'ether', trunkIfaces: sw.trunkIfaces || {} });

  function fillSwitches() {
    const list = switches();
    swSel.innerHTML = '';
    for (const s of list) {
      const o = doc.createElement('option');
      o.value = s.id;
      o.textContent = `${s.name || s.id}${s.model ? ' · ' + s.model : ''}`;
      swSel.appendChild(o);
    }
    if (opts.switchId && list.some((s) => s.id === opts.switchId)) swSel.value = opts.switchId;
  }

  function render() {
    const sw = current();
    trunkBox.innerHTML = '';
    warnBox.innerHTML = '';
    driftOut.innerHTML = '';
    fixBox.innerHTML = '';
    deployOut.textContent = '';
    lastCheck.textContent = '';
    if (!sw) { script.value = ''; warnBox.appendChild(el('li', { text: 'No switches in the plan.' })); return; }
    showLastCheck(sw);
    prefixInp.value = sw.portPrefix || '';
    const model = planDeviceModel(getProject(), sw.id, modelOpts(sw));
    // The switch can be deleted from the plan while this dialog is open.
    if (!model) { script.value = ''; warnBox.appendChild(el('li', { text: 'This switch is no longer in the plan.' })); return; }
    // One input per trunk: the physical interface is a site fact the plan
    // doesn't hold, so it is asked for rather than guessed.
    for (const t of model.trunks) {
      const inp = el('input', { class: 'ep-in ep-mono dc-trunk', placeholder: 'e.g. sfp-sfpplus1 or ether24', maxlength: '32' });
      inp.value = (sw.trunkIfaces && sw.trunkIfaces[t.peerId]) || '';
      inp.dataset.peer = t.peerId;
      inp.addEventListener('change', () => {
        const next = { ...(sw.trunkIfaces || {}) };
        const v = inp.value.trim();
        if (v) next[t.peerId] = v; else delete next[t.peerId];
        sw.trunkIfaces = next;
        if (typeof onChange === 'function') onChange();
        render();
      });
      trunkBox.appendChild(el('div', { class: 'ep-row' }, [el('label', { class: 'ep-lbl', text: `${t.role === 'uplink' ? 'Uplink to' : 'Downlink to'} ${t.peerName}` }), inp]));
    }
    for (const w of model.warnings) warnBox.appendChild(el('li', { text: w }));
    script.value = renderRouterOs(model, { generatedAt: new Date().toISOString().slice(0, 10) });
  }

  // The outcome of the last drift check, stored on the switch by the owner.
  function showLastCheck(sw) {
    const d = sw && sw.drift;
    if (!d || typeof d.at !== 'string') { lastCheck.textContent = 'Not checked against the device yet.'; return; }
    const when = d.at.slice(0, 16).replace('T', ' ');
    lastCheck.textContent = d.errors || d.warnings
      ? `Last check ${when}: ${d.errors || 0} mismatch(es), ${d.warnings || 0} warning(s) — the device differs from the plan.`
      : `Last check ${when}: the device matched the plan.`;
  }
  const safeName = (sw) => String(sw.name || sw.id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'device';
  deployBtn.addEventListener('click', () => {
    const sw = current();
    if (!sw || !canDeploy) return;
    deploy(sw, `${safeName(sw)}.rsc`, script.value, deployOut);
  });
  swSel.addEventListener('change', render);
  prefixInp.addEventListener('change', () => {
    const sw = current();
    if (!sw) return;
    const v = prefixInp.value.trim();
    if (v) sw.portPrefix = v; else delete sw.portPrefix;
    if (typeof onChange === 'function') onChange();
    render();
  });
  dlBtn.addEventListener('click', () => {
    const sw = current();
    if (!sw || typeof onDownload !== 'function') return;
    const safe = String(sw.name || sw.id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'device';
    onDownload(`${safe}.rsc`, script.value);
  });
  copyBtn.addEventListener('click', () => {
    const nav = doc.defaultView && doc.defaultView.navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(script.value).catch(() => {});
    script.select();
  });
  fileInp.addEventListener('change', () => {
    const f = fileInp.files && fileInp.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { driftOut.textContent = 'That file is too large to be a device export.'; return; }
    f.text().then((t) => { actual.value = t; }).catch(() => { driftOut.textContent = 'Could not read that file.'; });
  });

  function checkDrift() {
    const sw = current();
    driftOut.innerHTML = '';
    fixBox.innerHTML = '';
    if (!sw) return [];
    if (!actual.value.trim()) { driftOut.textContent = 'Paste or upload the device export first.'; return []; }
    const model = planDeviceModel(getProject(), sw.id, modelOpts(sw));
    if (!model) { driftOut.textContent = 'This switch is no longer in the plan.'; return []; }
    const parsed = parseRouterOsExport(actual.value);
    if (!parsed.ports.length && !parsed.addresses.length && !parsed.bridges.length && !parsed.identity) {
      driftOut.textContent = 'That does not look like a RouterOS /export (no bridge, ports, addresses or identity found).';
      return [];
    }
    const findings = diffAgainstPlan(model, parsed);
    const n = (sev) => findings.filter((f) => f.severity === sev).length;
    const head = el('div', { class: 'dc-drift-head ' + (n('error') ? 'bad' : 'ok') });
    head.textContent = findings.length
      ? `${n('error')} mismatch(es) · ${n('warn')} warning(s) · ${n('info')} not in the plan`
      : '✓ The device matches the plan.';
    driftOut.appendChild(head);
    if (typeof onDrift === 'function') { onDrift(sw, { errors: n('error'), warnings: n('warn'), info: n('info') }); showLastCheck(sw); }
    const ul = el('ul', { class: 'dc-drift-list' });
    for (const f of findings) {
      ul.appendChild(el('li', { class: `dc-${f.severity}`, text: `${SEV_LABEL[f.severity]} [${f.area}] ${f.message}` }));
    }
    driftOut.appendChild(ul);
    // Offer the script that fixes what can be fixed.
    if (findings.some((f) => f.severity !== 'info')) {
      const fix = remediationScript(model, parsed);
      const btn = el('button', { class: 'btn', text: `Remediation script (${fix.changes} change${fix.changes === 1 ? '' : 's'})` });
      btn.addEventListener('click', () => {
        fixBox.innerHTML = '';
        const ta = el('textarea', { class: 'dc-script dc-fix-script ep-mono', readonly: 'readonly', rows: '10', spellcheck: 'false' });
        ta.value = fix.text;
        const dl = el('button', { class: 'btn', text: '↓ Download remediation .rsc' });
        dl.addEventListener('click', () => {
          if (typeof onDownload !== 'function') return;
          const safe = String(sw.name || sw.id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'device';
          onDownload(`${safe}-remediation.rsc`, fix.text);
        });
        const fixOut = el('div', { class: 'ep-hint dc-deploy-out' });
        const run = el('button', { class: 'btn dc-deploy-fix', text: '⇢ Dry-run with rosconf' });
        run.addEventListener('click', () => deploy(sw, `${safeName(sw)}-remediation.rsc`, fix.text, fixOut));
        fixBox.append(ta, el('div', { class: 'ep-btn-row' }, [dl, ...(canDeploy ? [run] : [])]), fixOut, el('div', { class: 'ep-hint', text: 'Adds or corrects only what the plan requires. It removes nothing — anything on the device that the plan does not know stays as it is.' }));
      });
      driftOut.appendChild(btn);
    }
    return findings;
  }
  checkBtn.addEventListener('click', checkDrift);
  pullBtn.addEventListener('click', async () => {
    const sw = current();
    if (!sw || typeof onPull !== 'function') return;
    driftOut.innerHTML = ''; fixBox.innerHTML = '';
    driftOut.textContent = 'Connecting…';
    pullBtn.disabled = true;
    let res;
    try { res = await onPull(sw); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    pullBtn.disabled = false;
    if (!res) { driftOut.textContent = ''; return; } // cancelled
    if (!res.ok) { driftOut.textContent = `✕ ${res.error || 'Could not read the device'}`; return; }
    actual.value = String(res.text || '');
    checkDrift();
  });

  fillSwitches();
  render();
  return { el: root, render, checkDrift };
}
