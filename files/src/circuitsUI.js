// Circuits dialog: record the path a connection takes (end device → switch →
// patch panel → … → core) and find it again by anything on it. Thin DOM shell
// over circuits.js; all plan- and record-derived text goes through textContent.

import {
  HOP_TYPES, HOP_TYPE_LABELS, deviceIndex, autoTrace, mergeTrace, circuitDrift,
  searchCircuits, circuitsThrough, hopText, newCircuitId, normalizeCircuits,
  newHopIndex, labelSuggestions, circuitConflicts, conflictText, bulkCircuits,
} from './circuits.js';

const TYPE_NAMES = { ap: 'AP', cam: 'Camera', sw: 'Switch' };

/**
 * @typedef {{put:(file:File)=>Promise<string>, src:(id:string)=>Promise<string>, release:(id:string)=>void}} HopPhotos
 * @param {{root:any, getProject:()=>any, getCircuits:()=>any[], setCircuits:(c:any[])=>void,
 *   onFocus?:(deviceId:string)=>void, onShowPath?:(circuit:any)=>void, deviceId?:string,
 *   getTech?:()=>string, setTech?:(t:string)=>void, today?:()=>string, undo?:()=>void,
 *   photos?:HopPhotos, exports?:{circuitsCsv?:()=>void, patchCsv?:()=>void, labels?:()=>void}}} opts
 */
export function mountCircuits(opts) {
  const { root, getProject, getCircuits, setCircuits } = opts;
  const onFocus = opts.onFocus || (() => {});
  const onShowPath = opts.onShowPath || null;
  const getTech = opts.getTech || (() => '');
  const setTech = opts.setTech || (() => {});
  const today = opts.today || (() => new Date().toISOString().slice(0, 10));
  const photos = opts.photos || null;
  const exp = opts.exports || {};
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
  let flash = '';   // one-line message shown on the next list draw

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

  // Load a hop photo into an <img> (an inline data: URL is used as is).
  function loadPhoto(img, hop) {
    if (hop.img) { img.src = hop.img; return; }
    if (hop.imgId && photos) photos.src(hop.imgId).then((u) => { if (u) img.src = u; else img.alt = 'photo not available'; });
  }

  // ---- photo view ----
  function showPhoto(hop, caption, back) {
    root.innerHTML = '';
    const img = el('img', { class: 'ckt-photo-full', alt: caption });
    loadPhoto(img, hop);
    const close = el('button', { class: 'btn', text: 'Back' });
    close.addEventListener('click', back);
    root.append(el('div', { class: 'ckt-sub', text: caption }), img, el('div', { class: 'ep-btn-row ckt-actions' }, [close]));
  }

  // ---- list view ----
  function showList() {
    root.innerHTML = '';
    const idx = deviceIndex(getProject());
    const search = el('input', { class: 'ep-in ckt-search', type: 'search', placeholder: 'Search device, port, patch panel, cable label, technician…' });
    search.value = query;
    const addBtn = el('button', { class: 'btn btn-primary', text: '＋ New circuit' });
    const bulkBtn = el('button', { class: 'btn', text: 'Create for all devices', title: 'A circuit for every AP and camera that has none, path filled from the plan — then add the patch panels and outlets' });
    const summary = el('div', { class: 'ckt-summary' });
    const list = el('ul', { class: 'ckt-list' });
    const tools = el('div', { class: 'ckt-tools' }, [bulkBtn]);
    const tool = (text, title, fn) => { if (!fn) return; const b = el('button', { class: 'btn btn-ghost', text, title }); b.addEventListener('click', fn); tools.appendChild(b); };
    tool('⇩ Circuits CSV', 'Every circuit with its full path', exp.circuitsCsv);
    tool('⇩ Patch schedule', 'Switch port ↔ patch panel ↔ outlet ↔ device, in rack order', exp.patchCsv);
    tool('🏷 Cable labels', 'Printable labels, two per circuit', exp.labels);
    root.append(
      el('div', { class: 'ep-hint', text: 'A circuit records the path a connection takes from its end device to the core, including passive points the plan doesn\'t draw (patch panels, wall outlets, converters, cable labels). Search finds a circuit by anything on its path.' }),
      el('div', { class: 'ckt-bar' }, [search, addBtn]),
      tools
    );
    if (throughId) {
      const d = idx.get(throughId);
      const chip = el('div', { class: 'ckt-chip' }, [el('span', { text: `Through: ${(d && d.item.name) || throughId}` })]);
      const x = el('button', { class: 'btn btn-ghost', text: '✕', title: 'Show all circuits' });
      x.addEventListener('click', () => { throughId = ''; showList(); });
      chip.appendChild(x);
      root.appendChild(chip);
    }
    const note = el('div', { class: 'ckt-flash' });
    root.append(note, summary, list);
    if (flash) {
      note.textContent = flash;
      if (opts.undo && /^Deleted/.test(flash)) {
        const u = el('button', { class: 'btn btn-ghost', text: 'Undo' });
        u.addEventListener('click', () => { if (opts.undo) opts.undo(); flash = ''; showList(); });
        note.appendChild(u);
      }
      flash = '';
    }

    function draw() {
      list.innerHTML = '';
      const all = getCircuits();
      const pool = throughId ? circuitsThrough(all, throughId) : all;
      const hits = searchCircuits(getProject(), pool, query, idx);
      const conflicts = circuitConflicts(all);
      summary.textContent = !all.length ? 'No circuits recorded yet.'
        : `${hits.length} of ${pool.length} circuit(s)${query ? ' match' : ''}${conflicts.length ? ` · ⚠ ${conflicts.length} conflict(s)` : ''}`;
      for (const { circuit: c, hops: hitHops } of hits.slice(0, 200)) {
        const li = el('li', { class: 'ckt-item' });
        const drift = circuitDrift(getProject(), c, idx);
        const head = el('div', { class: 'ckt-head' }, [el('span', { class: 'ckt-name', text: c.name || '(unnamed)' })]);
        if (drift.length) head.appendChild(el('span', { class: 'ckt-drift', text: '⚠ differs from plan', title: drift.join('\n') }));
        if (onShowPath) {
          const mapBtn = el('button', { class: 'btn btn-ghost ckt-map', text: '⌖ Map', title: 'Trace this circuit on the plan' });
          mapBtn.addEventListener('click', () => onShowPath(c));
          head.appendChild(mapBtn);
        }
        if (drift.length && c.from && idx.has(c.from)) {
          const upd = el('button', { class: 'btn btn-ghost ckt-update', text: '↻ Update from plan', title: 'Take the device hops from the plan; your patch panels, outlets and cables stay' });
          upd.addEventListener('click', () => {
            const [rec] = normalizeCircuits([{ ...c, hops: mergeTrace(c.hops, autoTrace(getProject(), c.from, idx)) }]);
            rec.id = c.id;
            setCircuits(getCircuits().map((x) => (x.id === c.id ? rec : x)));
            flash = `Updated ${c.name || 'circuit'} from the plan.`;
            showList();
          });
          head.appendChild(upd);
        }
        const edit = el('button', { class: 'btn btn-ghost', text: 'Edit' });
        edit.addEventListener('click', () => showEditor(c));
        const del = el('button', { class: 'btn btn-ghost ckt-del', text: '✕', title: 'Delete circuit' });
        // Two-step delete instead of confirm(): a native dialog would block the app.
        del.addEventListener('click', () => {
          if (del.dataset.armed) {
            setCircuits(getCircuits().filter((x) => x.id !== c.id));
            // Deferred by the owner: an undo can still bring the photo back.
            if (photos) for (const h of c.hops) if (h.imgId) photos.release(h.imgId);
            flash = `Deleted ${c.name || 'circuit'}.`;
            showList();
            return;
          }
          del.dataset.armed = '1'; del.textContent = 'Delete?';
          setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = '✕'; } }, 3000);
        });
        head.append(edit, del);
        const path = el('div', { class: 'ckt-path' });
        c.hops.forEach((h, i) => {
          if (i) path.appendChild(el('span', { class: 'ckt-arrow', text: '→' }));
          const cls = `ckt-hop ckt-${h.type}${hitHops.includes(i) ? ' hit' : ''}`;
          const hasPhoto = !!(h.imgId || h.img);
          const text = hopText(h, idx);
          let node;
          if (h.type === 'device' && idx.has(h.ref)) {
            node = el('button', { class: cls, text, title: 'Show on map' });
            node.addEventListener('click', () => onFocus(h.ref));
          } else if (hasPhoto) {
            node = el('button', { class: cls, text, title: h.note || 'Show photo' });
            node.addEventListener('click', () => showPhoto(h, `${c.name} — ${text}`, showList));
          } else {
            node = el('span', { class: cls, text, title: h.note || HOP_TYPE_LABELS[h.type] });
          }
          if (hasPhoto) node.appendChild(el('span', { class: 'ckt-has-photo', text: ' 📷', title: 'Has a photo' }));
          path.appendChild(node);
        });
        li.append(head, path);
        const meta = c.tech ? `Recorded by ${c.tech}${c.date ? ' · ' + c.date : ''}` : c.date ? `Recorded ${c.date}` : '';
        if (meta) li.appendChild(el('div', { class: 'ckt-meta', text: meta }));
        if (c.notes) li.appendChild(el('div', { class: 'ckt-meta', text: c.notes }));
        for (const d of drift.slice(0, 3)) li.appendChild(el('div', { class: 'ckt-meta ckt-warn', text: d }));
        for (const e of conflicts.filter((x) => x.circuits.some((cc) => cc.id === c.id))) {
          li.appendChild(el('div', { class: 'ckt-meta ckt-warn ckt-conflict', text: conflictText(e) }));
        }
        list.appendChild(li);
      }
    }
    search.addEventListener('input', () => { query = search.value; draw(); });
    addBtn.addEventListener('click', () => showEditor(null));
    bulkBtn.addEventListener('click', () => {
      const cur = getCircuits();
      const r = bulkCircuits(getProject(), cur, { tech: getTech(), date: today() }, idx);
      if (r.created.length) setCircuits([...cur, ...normalizeCircuits(r.created)]);
      flash = `Created ${r.created.length} circuit(s)`
        + (r.existing ? ` · ${r.existing} already had one` : '')
        + (r.unlinked.length ? ` · not cabled to a switch: ${r.unlinked.slice(0, 5).join(', ')}${r.unlinked.length > 5 ? '…' : ''}` : '')
        + (r.created.length ? ' — add their patch panels and outlets.' : '.');
      showList();
    });
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
    // Photos added in this editor session: released again unless saved.
    /** @type {Set<string>} */ const added = new Set();
    const suggest = labelSuggestions(getCircuits());

    const nameIn = el('input', { class: 'ep-in', placeholder: 'Circuit name / ID, e.g. CAM-Pool-03 (default: the end device)' });
    nameIn.value = work.name;
    const fromSel = el('select', { class: 'ep-sel' });
    fillDevices(fromSel, idx, work.from);
    const traceBtn = el('button', { class: 'btn', text: '↻ Fill path from plan', title: 'Take switch/uplink hops from the plan; keeps your passive hops' });
    const hopsBox = el('div', { class: 'ckt-hops' });
    const addHop = el('button', { class: 'btn', text: '＋ Add hop', title: 'Adds after the end device\'s patch panels / outlets, before its switch' });
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
    // Autocomplete per passive hop type, from labels already used in the project.
    const lists = el('div', { class: 'ckt-datalists', hidden: '' });
    for (const [t, vals] of Object.entries(suggest)) {
      const dl = el('datalist', { id: `ckt-dl-${t}` });
      for (const v of vals) dl.appendChild(el('option', { value: v }));
      lists.appendChild(dl);
    }

    root.append(
      field('Name', nameIn),
      el('div', { class: 'ckt-from' }, [field('End device', fromSel), traceBtn]),
      el('div', { class: 'ckt-sub', text: 'Path (from the end device towards the core)' }),
      hopsBox,
      el('div', { class: 'ep-btn-row' }, [addHop]),
      el('div', { class: 'ckt-from' }, [field('Technician', techIn), field('Date', dateIn)]),
      field('Notes', notesIn),
      el('div', { class: 'ep-btn-row ckt-actions' }, [save, cancel, msg]),
      lists
    );
    const editorNodes = [...root.childNodes];
    // Returning from a photo view must not lose the unsaved edits.
    const backToEditor = () => { root.innerHTML = ''; root.append(...editorNodes); drawHops(); };

    const blankHop = () => ({ type: 'patch', ref: '', port: '', label: '', note: '' });
    const dropAdded = (h) => { if (photos && h.imgId && added.has(h.imgId)) { photos.release(h.imgId); added.delete(h.imgId); } };

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
          what = el('input', { class: 'ep-in', list: `ckt-dl-${h.type}`, placeholder: h.type === 'patch' ? 'Panel, e.g. PP2' : h.type === 'cable' ? 'Cable label' : h.type === 'outlet' ? 'Outlet, e.g. Wall A' : 'Label' });
          what.value = h.label;
          what.addEventListener('input', () => { h.label = what.value; });
        }
        const port = el('input', { class: 'ep-in ep-mono ckt-port', placeholder: h.type === 'patch' ? 'position' : 'port' });
        port.value = h.port;
        port.addEventListener('input', () => { h.port = port.value; });
        const note = el('input', { class: 'ep-in', placeholder: 'note' });
        note.value = h.note;
        note.addEventListener('input', () => { h.note = note.value; });
        const ctl = el('div', { class: 'ckt-hopctl' });
        const ctlBtn = (text, title, fn, cls = 'btn btn-ghost') => { const b = el('button', { class: cls, text, title }); b.addEventListener('click', fn); ctl.appendChild(b); return b; };
        if (photos) {
          if (h.imgId || h.img) {
            const thumb = el('img', { class: 'ckt-thumb', alt: 'photo', title: 'Show photo' });
            loadPhoto(thumb, h);
            thumb.addEventListener('click', () => showPhoto(h, hopText(h, idx), backToEditor));
            ctl.appendChild(thumb);
            ctlBtn('✕', 'Remove photo', () => { dropAdded(h); delete h.imgId; delete h.img; drawHops(); }, 'btn btn-ghost ckt-photo-rm');
          } else {
            const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'ckt-photo-in', hidden: '' });
            file.addEventListener('change', () => {
              const f = file.files && file.files[0];
              if (!f) return;
              photos.put(f).then((id) => { dropAdded(h); h.imgId = id; delete h.img; added.add(id); drawHops(); })
                .catch((e) => { msg.textContent = String((e && e.message) || e); msg.className = 'ckt-summary bad'; });
            });
            ctl.appendChild(file);
            ctlBtn('📷', 'Add a photo (e.g. the patch panel)', () => file.click(), 'btn btn-ghost ckt-photo-add');
          }
        }
        const mv = (d) => { const j = i + d; if (j < 0 || j >= work.hops.length) return; [work.hops[i], work.hops[j]] = [work.hops[j], work.hops[i]]; drawHops(); };
        ctlBtn('↑', 'Move up', () => mv(-1));
        ctlBtn('↓', 'Move down', () => mv(1));
        ctlBtn('＋', 'Insert a hop below', () => { work.hops.splice(i + 1, 0, blankHop()); drawHops(); }, 'btn btn-ghost ckt-insert');
        ctlBtn('✕', 'Remove hop', () => { dropAdded(h); work.hops.splice(i, 1); drawHops(); }, 'btn btn-ghost ckt-hop-rm');
        row.append(typeSel, what, port, note, ctl);
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
    addHop.addEventListener('click', () => { work.hops.splice(newHopIndex(work.hops), 0, blankHop()); drawHops(); });
    cancel.addEventListener('click', () => {
      if (photos) for (const id of added) photos.release(id);
      showList();
    });
    save.addEventListener('click', () => {
      const name = nameIn.value.trim() || (idx.has(work.from) ? idx.get(work.from).item.name : '');
      const [rec] = normalizeCircuits([{ ...work, name, tech: techIn.value.trim(), date: dateIn.value, notes: notesIn.value.trim() }]);
      if (!rec.name) { msg.textContent = 'Give the circuit a name.'; msg.className = 'ckt-summary bad'; return; }
      if (!rec.hops.length) { msg.textContent = 'Add at least one hop.'; msg.className = 'ckt-summary bad'; return; }
      const cur = getCircuits();
      if (existing) rec.id = existing.id;
      else rec.id = newCircuitId(new Set(cur.map((c) => c.id)));
      setCircuits(existing ? cur.map((c) => (c.id === existing.id ? rec : c)) : [...cur, rec]);
      // Photos the record no longer names (removed or replaced) can go; the
      // owner defers the actual delete while an undo step still names them.
      if (photos) {
        const kept = new Set(rec.hops.map((h) => h.imgId).filter(Boolean));
        for (const h of (existing ? existing.hops : [])) if (h.imgId && !kept.has(h.imgId)) photos.release(h.imgId);
        for (const id of added) if (!kept.has(id)) photos.release(id);
      }
      if (rec.tech) setTech(rec.tech);
      showList();
    });
    drawHops();
    nameIn.focus();
  }

  showList();
  return { el: root, showList, showEditor };
}
