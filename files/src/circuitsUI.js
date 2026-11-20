// Circuits dialog: record the path a connection takes (end device → switch →
// patch panel → … → core) and find it again by anything on it. Thin DOM shell
// over circuits.js; all plan- and record-derived text goes through textContent.

import {
  HOP_TYPES, HOP_TYPE_LABELS, deviceIndex, autoTrace, mergeTrace, circuitDrift,
  searchCircuits, circuitsThrough, hopText, newCircuitId, normalizeCircuits,
} from './circuits.js';

const TYPE_NAMES = { ap: 'AP', cam: 'Camera', sw: 'Switch' };

/**
 * @param {{root:any, getProject:()=>any, getCircuits:()=>any[], setCircuits:(c:any[])=>void,
 *   onFocus?:(deviceId:string)=>void, deviceId?:string, getTech?:()=>string, setTech?:(t:string)=>void,
 *   today?:()=>string}} opts
 */
export function mountCircuits(opts) {
  const { root, getProject, getCircuits, setCircuits } = opts;
  const onFocus = opts.onFocus || (() => {});
  const getTech = opts.getTech || (() => '');
  const setTech = opts.setTech || (() => {});
  const today = opts.today || (() => new Date().toISOString().slice(0, 10));
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
  let throughId = opts.deviceId || '';
  let query = '';

  root.innerHTML = '';
  root.classList.add('ckt-root');

  function fillDevices(sel, idx, current) {
    sel.innerHTML = '';
    option(sel, '', '— choose device —');
    const project = getProject();
    (project.floors || []).forEach((f, fi) => {
      const g = doc.createElement('optgroup');
      g.label = (f && f.name) || `Floor ${fi + 1}`;
      for (const [id, d] of idx) if (d.floor === fi) option(g, id, `${d.item.name || id} (${TYPE_NAMES[d.type]})`);
      if (g.children.length) sel.appendChild(g);
    });
    // A recorded device that has since been deleted must stay selectable, or
    // re-saving the circuit would silently rewrite the record.
    if (current && !idx.has(current)) option(sel, current, `${current} (not in plan)`);
    sel.value = current || '';
  }

  // ---- list view ----
  function showList() {
    root.innerHTML = '';
    const idx = deviceIndex(getProject());
    const search = el('input', { class: 'ep-in ckt-search', type: 'search', placeholder: 'Search device, port, patch panel, cable label, technician…' });
    search.value = query;
    const addBtn = el('button', { class: 'btn btn-primary', text: '＋ New circuit' });
    const summary = el('div', { class: 'ckt-summary' });
    const list = el('ul', { class: 'ckt-list' });
    const bar = el('div', { class: 'ckt-bar' }, [search, addBtn]);
    root.append(
      el('div', { class: 'ep-hint', text: 'A circuit records the path a connection takes from its end device to the core, including passive points the plan doesn\'t draw (patch panels, wall outlets, converters, cable labels). Search finds a circuit by anything on its path.' }),
      bar
    );
    if (throughId) {
      const d = idx.get(throughId);
      const chip = el('div', { class: 'ckt-chip' }, [el('span', { text: `Through: ${(d && d.item.name) || throughId}` })]);
      const x = el('button', { class: 'btn btn-ghost', text: '✕', title: 'Show all circuits' });
      x.addEventListener('click', () => { throughId = ''; showList(); });
      chip.appendChild(x);
      root.appendChild(chip);
    }
    root.append(summary, list);

    function draw() {
      list.innerHTML = '';
      const all = getCircuits();
      const pool = throughId ? circuitsThrough(all, throughId) : all;
      const hits = searchCircuits(getProject(), pool, query, idx);
      summary.textContent = !all.length ? 'No circuits recorded yet.'
        : `${hits.length} of ${pool.length} circuit(s)${query ? ' match' : ''}`;
      for (const { circuit: c, hops: hitHops } of hits.slice(0, 200)) {
        const li = el('li', { class: 'ckt-item' });
        const drift = circuitDrift(getProject(), c, idx);
        const head = el('div', { class: 'ckt-head' }, [el('span', { class: 'ckt-name', text: c.name || '(unnamed)' })]);
        if (drift.length) head.appendChild(el('span', { class: 'ckt-drift', text: '⚠ differs from plan', title: drift.join('\n') }));
        const edit = el('button', { class: 'btn btn-ghost', text: 'Edit' });
        edit.addEventListener('click', () => showEditor(c));
        const del = el('button', { class: 'btn btn-ghost ckt-del', text: '✕', title: 'Delete circuit' });
        // Two-step delete instead of confirm(): a native dialog would block the app.
        del.addEventListener('click', () => {
          if (del.dataset.armed) { setCircuits(getCircuits().filter((x) => x.id !== c.id)); draw(); return; }
          del.dataset.armed = '1'; del.textContent = 'Delete?';
          setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = '✕'; } }, 3000);
        });
        head.append(edit, del);
        const path = el('div', { class: 'ckt-path' });
        c.hops.forEach((h, i) => {
          if (i) path.appendChild(el('span', { class: 'ckt-arrow', text: '→' }));
          const cls = `ckt-hop ckt-${h.type}${hitHops.includes(i) ? ' hit' : ''}`;
          if (h.type === 'device' && idx.has(h.ref)) {
            const b = el('button', { class: cls, text: hopText(h, idx), title: 'Show on map' });
            b.addEventListener('click', () => onFocus(h.ref));
            path.appendChild(b);
          } else {
            path.appendChild(el('span', { class: cls, text: hopText(h, idx), title: h.note || HOP_TYPE_LABELS[h.type] }));
          }
        });
        li.append(head, path);
        const meta = [c.tech, c.date].filter(Boolean).join(' · ');
        if (meta) li.appendChild(el('div', { class: 'ckt-meta', text: `Recorded by ${meta}` }));
        if (c.notes) li.appendChild(el('div', { class: 'ckt-meta', text: c.notes }));
        for (const d of drift.slice(0, 3)) li.appendChild(el('div', { class: 'ckt-meta ckt-warn', text: d }));
        list.appendChild(li);
      }
    }
    search.addEventListener('input', () => { query = search.value; draw(); });
    addBtn.addEventListener('click', () => showEditor(null));
    draw();
    search.focus();
  }

  // ---- editor view ----
  function showEditor(existing) {
    root.innerHTML = '';
    const project = getProject();
    const idx = deviceIndex(project);
    const work = existing
      ? { ...existing, hops: existing.hops.map((h) => ({ ...h })) }
      : { id: '', name: '', from: throughId, hops: [], tech: getTech(), date: today(), notes: '' };
    if (!existing && work.from) work.hops = autoTrace(project, work.from, idx);

    const nameIn = el('input', { class: 'ep-in', placeholder: 'Circuit name / ID, e.g. CAM-Pool-03' });
    nameIn.value = work.name;
    const fromSel = el('select', { class: 'ep-sel' });
    fillDevices(fromSel, idx, work.from);
    const traceBtn = el('button', { class: 'btn', text: '↻ Fill path from plan', title: 'Take switch/uplink hops from the plan; keeps your passive hops' });
    const hopsBox = el('div', { class: 'ckt-hops' });
    const addHop = el('button', { class: 'btn', text: '＋ Add hop' });
    const techIn = el('input', { class: 'ep-in', placeholder: 'Technician' });
    techIn.value = work.tech;
    const dateIn = el('input', { class: 'ep-in', type: 'date' });
    dateIn.value = work.date;
    const notesIn = el('textarea', { class: 'ep-in ckt-notes', rows: '2', placeholder: 'Notes' });
    notesIn.value = work.notes;
    const msg = el('div', { class: 'ckt-summary' });
    const save = el('button', { class: 'btn btn-primary', text: existing ? 'Save changes' : 'Save circuit' });
    const cancel = el('button', { class: 'btn', text: 'Back' });
    const field = (label, node) => el('label', { class: 'ckt-field' }, [el('span', { text: label }), node]);

    root.append(
      field('Name', nameIn),
      el('div', { class: 'ckt-from' }, [field('End device', fromSel), traceBtn]),
      el('div', { class: 'ckt-sub', text: 'Path (from the end device towards the core)' }),
      hopsBox,
      el('div', { class: 'ep-btn-row' }, [addHop]),
      el('div', { class: 'ckt-from' }, [field('Technician', techIn), field('Date', dateIn)]),
      field('Notes', notesIn),
      el('div', { class: 'ep-btn-row' }, [save, cancel, msg])
    );

    function drawHops() {
      hopsBox.innerHTML = '';
      if (!work.hops.length) hopsBox.appendChild(el('div', { class: 'ckt-meta', text: 'No hops yet — pick the end device and fill from plan, or add hops by hand.' }));
      work.hops.forEach((h, i) => {
        const row = el('div', { class: 'ckt-hoprow' });
        const typeSel = el('select', { class: 'ep-sel' });
        for (const t of HOP_TYPES) option(typeSel, t, HOP_TYPE_LABELS[t]);
        typeSel.value = h.type;
        typeSel.addEventListener('change', () => { h.type = typeSel.value; if (h.type !== 'device') h.ref = ''; drawHops(); });
        let what;
        if (h.type === 'device') {
          what = el('select', { class: 'ep-sel' });
          fillDevices(what, idx, h.ref);
          what.addEventListener('change', () => { h.ref = what.value; });
        } else {
          what = el('input', { class: 'ep-in', placeholder: h.type === 'patch' ? 'Panel, e.g. PP2' : h.type === 'cable' ? 'Cable label' : 'Label' });
          what.value = h.label;
          what.addEventListener('input', () => { h.label = what.value; });
        }
        const port = el('input', { class: 'ep-in ep-mono ckt-port', placeholder: h.type === 'patch' ? 'position' : 'port' });
        port.value = h.port;
        port.addEventListener('input', () => { h.port = port.value; });
        const note = el('input', { class: 'ep-in', placeholder: 'note' });
        note.value = h.note;
        note.addEventListener('input', () => { h.note = note.value; });
        const mv = (d) => { const j = i + d; if (j < 0 || j >= work.hops.length) return; [work.hops[i], work.hops[j]] = [work.hops[j], work.hops[i]]; drawHops(); };
        const up = el('button', { class: 'btn btn-ghost', text: '↑', title: 'Move up' }); up.addEventListener('click', () => mv(-1));
        const dn = el('button', { class: 'btn btn-ghost', text: '↓', title: 'Move down' }); dn.addEventListener('click', () => mv(1));
        const rm = el('button', { class: 'btn btn-ghost', text: '✕', title: 'Remove hop' }); rm.addEventListener('click', () => { work.hops.splice(i, 1); drawHops(); });
        row.append(typeSel, what, port, note, up, dn, rm);
        hopsBox.appendChild(row);
      });
    }

    fromSel.addEventListener('change', () => {
      const prev = work.from;
      work.from = fromSel.value;
      // Fresh path for a fresh pick; an edited path is only replaced on request.
      if (!work.hops.length || (work.hops.length === 1 && work.hops[0].ref === prev)) {
        work.hops = work.from ? autoTrace(project, work.from, idx) : [];
        drawHops();
      }
      if (!nameIn.value && idx.has(work.from)) nameIn.value = idx.get(work.from).item.name || '';
    });
    traceBtn.addEventListener('click', () => {
      if (!work.from) { msg.textContent = 'Pick the end device first.'; msg.className = 'ckt-summary bad'; return; }
      work.hops = mergeTrace(work.hops, autoTrace(project, work.from, idx));
      msg.textContent = ''; drawHops();
    });
    addHop.addEventListener('click', () => { work.hops.push({ type: 'patch', ref: '', port: '', label: '', note: '' }); drawHops(); });
    cancel.addEventListener('click', showList);
    save.addEventListener('click', () => {
      const name = nameIn.value.trim() || (idx.has(work.from) ? idx.get(work.from).item.name : '');
      const [rec] = normalizeCircuits([{ ...work, name, tech: techIn.value.trim(), date: dateIn.value, notes: notesIn.value.trim() }]);
      if (!rec.name) { msg.textContent = 'Give the circuit a name.'; msg.className = 'ckt-summary bad'; return; }
      if (!rec.hops.length) { msg.textContent = 'Add at least one hop.'; msg.className = 'ckt-summary bad'; return; }
      const cur = getCircuits();
      if (existing) rec.id = existing.id;
      else rec.id = newCircuitId(new Set(cur.map((c) => c.id)));
      setCircuits(existing ? cur.map((c) => (c.id === existing.id ? rec : c)) : [...cur, rec]);
      if (rec.tech) setTech(rec.tech);
      showList();
    });
    drawHops();
    nameIn.focus();
  }

  showList();
  return { el: root, showList, showEditor };
}
