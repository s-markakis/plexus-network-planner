// Policies dialog: state what must / must not be reachable, and see each rule
// proven (or broken, with the offending pair) against the simulated plan.
// Thin DOM shell over policy.js; all plan-derived text goes through textContent.

import { evaluatePolicies, policyLabel } from './policy.js';

const MAX_POLICIES = 40;

/**
 * @param {{root:any, getProject:()=>any, getPolicies:()=>any[], setPolicies:(p:any[])=>void}} opts
 */
export function mountPolicies(opts) {
  const { root, getProject, getPolicies, setPolicies } = opts;
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
  const option = (sel, value, text) => { const o = doc.createElement('option'); o.value = value; o.textContent = text; sel.appendChild(o); return o; };

  // Selector choices from the plan: value is a compact "kind:arg" string.
  function fillSelector(sel, isTarget) {
    sel.innerHTML = '';
    const project = getProject();
    const vl = doc.createElement('optgroup'); vl.label = 'VLANs';
    for (const v of (project.settings && project.settings.vlans) || []) if (v && v.id != null && v.id !== '') option(vl, `vlan:${v.id}`, `VLAN ${v.id}${v.name ? ' — ' + v.name : ''}`);
    if (vl.children.length) sel.appendChild(vl);
    const sp = doc.createElement('optgroup'); sp.label = 'Special';
    option(sp, 'mgmt:', 'Network management (switches, gateways)');
    if (isTarget) option(sp, 'internet:', 'The Internet');
    sel.appendChild(sp);
    const dv = doc.createElement('optgroup'); dv.label = 'Devices';
    for (const f of project.floors || []) for (const key of ['APS', 'CAMS', 'SWS']) for (const d of (f && f[key]) || []) if (d && d.id) option(dv, `device:${d.id}`, d.name || d.id);
    if (dv.children.length) sel.appendChild(dv);
  }
  const toSelector = (value) => {
    const i = value.indexOf(':');
    const kind = value.slice(0, i), arg = value.slice(i + 1);
    if (kind === 'vlan') return { kind: 'vlan', vlan: arg };
    if (kind === 'device') return { kind: 'device', id: arg };
    return kind === 'internet' ? { kind: 'internet' } : { kind: 'mgmt' };
  };

  const fromSel = el('select', { class: 'ep-sel pol-from' });
  const expSel = el('select', { class: 'ep-sel pol-expect' });
  option(expSel, 'deny', 'must NOT reach');
  option(expSel, 'allow', 'must reach');
  const toSel = el('select', { class: 'ep-sel pol-to' });
  const protoSel = el('select', { class: 'ep-sel pol-proto' });
  for (const [v, t] of [['any', 'any traffic'], ['tcp', 'TCP port'], ['udp', 'UDP port']]) option(protoSel, v, t);
  const portInp = el('input', { class: 'ep-in ep-mono pol-port', type: 'number', min: '1', max: '65535', placeholder: 'port' });
  const addBtn = el('button', { class: 'btn btn-primary', text: '＋ Add policy' });
  const checkBtn = el('button', { class: 'btn', text: '↻ Re-check' });
  const summary = el('div', { class: 'pol-summary' });
  const list = el('ul', { class: 'pol-list' });

  root.innerHTML = '';
  root.classList.add('pol-root');
  root.append(
    el('div', { class: 'ep-hint', text: 'A policy is a test of the design. Each one is checked against the simulated plan — including probe addresses on both sides of every firewall rule that cuts through a subnet, so a rule covering only part of a VLAN is caught.' }),
    el('div', { class: 'pol-form' }, [fromSel, expSel, toSel, protoSel, portInp, addBtn]),
    el('div', { class: 'ep-btn-row' }, [checkBtn, summary]),
    list
  );

  function evaluate() {
    const policies = getPolicies();
    list.innerHTML = '';
    if (!policies.length) { summary.textContent = 'No policies yet.'; summary.className = 'pol-summary'; return { results: [] }; }
    let out;
    try { out = evaluatePolicies(getProject(), policies); } catch (e) { summary.textContent = `Could not simulate the plan: ${(e && e.message) || e}`; summary.className = 'pol-summary bad'; return { results: [] }; }
    const n = (s) => out.results.filter((r) => r.status === s).length;
    summary.textContent = `${n('pass')} pass · ${n('fail')} fail${n('skipped') ? ` · ${n('skipped')} not testable` : ''}`;
    summary.className = 'pol-summary ' + (n('fail') ? 'bad' : n('pass') ? 'ok' : '');
    out.results.forEach((r) => {
      const li = el('li', { class: `pol-item pol-${r.status}` });
      const head = el('div', { class: 'pol-head' });
      head.append(el('span', { class: 'pol-mark', text: r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '·' }), el('span', { class: 'pol-label', text: r.label }));
      const rm = el('button', { class: 'btn btn-ghost pol-rm', text: '✕', title: 'Remove policy' });
      rm.addEventListener('click', () => { setPolicies(getPolicies().filter((p) => p.id !== r.policy.id)); evaluate(); });
      head.appendChild(rm);
      li.appendChild(head);
      if (r.status === 'skipped') li.appendChild(el('div', { class: 'pol-detail', text: r.reason || '' }));
      else if (r.status === 'pass') li.appendChild(el('div', { class: 'pol-detail', text: `${r.pairs} path(s) checked` }));
      else {
        for (const v of r.violations.slice(0, 5)) {
          const got = v.status === 'delivered' || v.status === 'closed' ? 'reachable' : v.status;
          li.appendChild(el('div', { class: 'pol-detail', text: `${v.from} (${v.fromIp}) → ${v.to} (${v.toIp}): ${got}${v.synthetic ? '  — probe address, not a planned device' : ''}` }));
        }
        if (r.violations.length > 5) li.appendChild(el('div', { class: 'pol-detail', text: `…and ${r.violations.length - 5} more of ${r.pairs} path(s)` }));
      }
      list.appendChild(li);
    });
    return out;
  }

  addBtn.addEventListener('click', () => {
    const cur = getPolicies();
    if (cur.length >= MAX_POLICIES || !fromSel.value || !toSel.value) return;
    const policy = { id: `pol${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, from: toSelector(fromSel.value), to: toSelector(toSel.value), expect: expSel.value === 'allow' ? 'allow' : 'deny', proto: 'any' };
    const port = parseInt(portInp.value, 10);
    if (protoSel.value !== 'any') {
      if (!(port >= 1 && port <= 65535)) { summary.textContent = 'Enter a port between 1 and 65535 for a TCP/UDP policy.'; summary.className = 'pol-summary bad'; return; }
      policy.proto = protoSel.value;
      policy.port = port;
    }
    if (cur.some((p) => policyLabel(p) === policyLabel(policy))) { summary.textContent = 'That policy already exists.'; summary.className = 'pol-summary bad'; return; }
    setPolicies([...cur, policy]);
    evaluate();
  });
  checkBtn.addEventListener('click', evaluate);
  protoSel.addEventListener('change', () => { portInp.disabled = protoSel.value === 'any'; });

  fillSelector(fromSel, false);
  fillSelector(toSel, true);
  portInp.disabled = true;
  evaluate();
  return { el: root, evaluate };
}
