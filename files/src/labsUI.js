// Labs dialog: pick a guided scenario, load its starting plan, and have the
// simulator grade the result. Thin DOM shell over labs.js.

import { LABS, getLab, gradeLab } from './labs.js';

/**
 * @param {{root:any, getProject:()=>any, getActive:()=>string, onStart:(lab:any)=>void}} opts
 *   getActive  id of the lab whose starting plan is currently loaded ('' = none)
 *   onStart    load lab.build() as the current project (the caller confirms)
 */
export function mountLabs(opts) {
  const { root, getProject, getActive, onStart } = opts;
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

  const labSel = el('select', { class: 'ep-sel lab-select' });
  for (const l of LABS) { const o = doc.createElement('option'); o.value = l.id; o.textContent = `${l.level} — ${l.title}`; labSel.appendChild(o); }
  const brief = el('div', { class: 'lab-brief' });
  const hints = el('details', { class: 'lab-hints' });
  const startBtn = el('button', { class: 'btn', text: 'Start lab (loads its plan)' });
  const checkBtn = el('button', { class: 'btn btn-primary', text: '✓ Check my work' });
  const score = el('div', { class: 'lab-score' });
  const results = el('ul', { class: 'lab-results' });

  root.innerHTML = '';
  root.classList.add('lab-root');
  root.append(labSel, brief, hints, el('div', { class: 'ep-btn-row' }, [startBtn, checkBtn]), score, results);

  function renderLab() {
    const lab = getLab(labSel.value);
    brief.innerHTML = ''; hints.innerHTML = ''; results.innerHTML = ''; score.textContent = '';
    if (!lab) return;
    for (const line of lab.brief) brief.appendChild(el('p', { text: line }));
    hints.appendChild(el('summary', { text: 'Hints' }));
    const ul = doc.createElement('ul');
    for (const h of lab.hints) ul.appendChild(el('li', { text: h }));
    hints.appendChild(ul);
    hints.open = false;
    const active = getActive() === lab.id;
    checkBtn.disabled = !active;
    checkBtn.title = active ? '' : 'Start this lab first';
    score.textContent = active ? 'Lab in progress — configure the plan, then check your work.' : '';
    score.className = 'lab-score';
  }

  function check() {
    const g = gradeLab(getProject(), labSel.value);
    results.innerHTML = '';
    if (!g) return null;
    score.textContent = g.passed ? `✓ Passed — ${g.score}/${g.total}` : `${g.score}/${g.total} checks pass`;
    score.className = 'lab-score ' + (g.passed ? 'ok' : 'bad');
    for (const r of g.results) {
      const li = el('li', { class: r.ok ? 'ok' : 'bad' });
      li.appendChild(el('span', { class: 'lab-mark', text: r.ok ? '✓' : '✗' }));
      li.appendChild(el('span', { text: ` ${r.label}` }));
      if (r.detail) li.appendChild(el('div', { class: 'lab-detail', text: r.detail }));
      results.appendChild(li);
    }
    return g;
  }

  labSel.addEventListener('change', renderLab);
  startBtn.addEventListener('click', () => { const lab = getLab(labSel.value); if (lab && typeof onStart === 'function') { onStart(lab); renderLab(); } });
  checkBtn.addEventListener('click', check);

  if (getActive() && getLab(getActive())) labSel.value = getActive();
  renderLab();
  return { el: root, check, renderLab };
}
