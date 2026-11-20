// Revisions dialog: list saved snapshots, mark the design baseline, diff a
// revision against now (or the last two against each other), restore, delete,
// and save a new one. Builds DOM from what it is given; text only.

/**
 * @param {Document} doc
 * @param {{revisions:any[], locale:string,
 *   diffVsNow:(rev:any)=>string[], diffLastTwo:()=>string[],
 *   onToggleBaseline:(rev:any)=>void, onRestore:(rev:any)=>void, onDelete:(rev:any)=>void, onNew:()=>void}} p
 * @returns {HTMLElement}
 */
export function revisionsEl(doc, { revisions, locale, diffVsNow, diffLastTwo, onToggleBaseline, onRestore, onDelete, onNew }) {
  const wrap = doc.createElement('div'); wrap.className = 'settings-form';
  if (!revisions.length) {
    const e = doc.createElement('div'); e.className = 'ep-hint';
    e.textContent = 'No revisions yet. Save the current state as the first revision below.';
    wrap.appendChild(e);
  } else {
    const list = doc.createElement('div'); list.className = 'rev-list';
    const showDiff = (lines, label) => {
      const old = wrap.querySelector('.rev-diff'); if (old) old.remove();
      const out = doc.createElement('pre'); out.className = 'rev-diff';
      out.textContent = (label ? label + '\n\n' : '') + (lines.length ? lines.join('\n') : '(no differences detected)');
      wrap.appendChild(out);
    };
    for (const rev of revisions) {
      const row = doc.createElement('div'); row.className = 'rev-row';
      const name = doc.createElement('div'); name.className = 'rev-name';
      name.textContent = (rev.baseline ? '★ ' : '') + rev.name;
      if (rev.baseline) name.title = 'Design baseline';
      const when = doc.createElement('div'); when.className = 'rev-when'; when.textContent = new Date(rev.createdAt).toLocaleString(locale);
      // The design baseline (one at a time): the "as-designed" state that
      // later as-built diffs are read against.
      const b = doc.createElement('button'); b.className = 'btn'; b.textContent = rev.baseline ? '★' : '☆';
      b.title = rev.baseline ? 'Unmark design baseline' : 'Mark as design baseline';
      b.addEventListener('click', () => onToggleBaseline(rev));
      const d = doc.createElement('button'); d.className = 'btn'; d.textContent = 'Diff vs now';
      d.title = 'What changed between this revision and the current state';
      d.addEventListener('click', () => showDiff(diffVsNow(rev), `${rev.name} → current state`));
      const r = doc.createElement('button'); r.className = 'btn'; r.textContent = 'Restore';
      r.addEventListener('click', () => onRestore(rev));
      const x = doc.createElement('button'); x.className = 'btn danger'; x.textContent = '×'; x.title = 'Delete';
      // Deleting a revision can't be undone: ask on the button itself (a
      // second click within 3 s) rather than deleting on the first.
      x.addEventListener('click', () => {
        if (x.dataset.armed) { onDelete(rev); return; }
        x.dataset.armed = '1'; x.textContent = 'Delete?';
        setTimeout(() => { if (x.isConnected) { delete x.dataset.armed; x.textContent = '×'; } }, 3000);
      });
      row.appendChild(name); row.appendChild(when); row.appendChild(b); row.appendChild(d); row.appendChild(r); row.appendChild(x);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    if (revisions.length >= 2) {
      const diffBtn = doc.createElement('button'); diffBtn.className = 'btn'; diffBtn.textContent = 'Diff last two revisions';
      diffBtn.style.marginTop = '12px';
      // One diff on screen at a time, labelled (each click used to stack
      // another unlabelled result below the dialog).
      diffBtn.addEventListener('click', () => {
        const [a, b] = revisions.slice(-2);
        showDiff(diffLastTwo(), `${a.name} → ${b.name}`);
      });
      wrap.appendChild(diffBtn);
    }
  }
  const saveBtn = doc.createElement('button'); saveBtn.className = 'btn btn-primary'; saveBtn.textContent = 'Save current state as new revision';
  saveBtn.style.marginTop = '12px';
  saveBtn.addEventListener('click', onNew);
  wrap.appendChild(saveBtn);
  return wrap;
}
