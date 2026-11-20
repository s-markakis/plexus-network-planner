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
      x.addEventListener('click', () => onDelete(rev));
      row.appendChild(name); row.appendChild(when); row.appendChild(b); row.appendChild(d); row.appendChild(r); row.appendChild(x);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    if (revisions.length >= 2) {
      const diffBtn = doc.createElement('button'); diffBtn.className = 'btn'; diffBtn.textContent = 'Diff last two revisions';
      diffBtn.style.marginTop = '12px';
      diffBtn.addEventListener('click', () => {
        const lines = diffLastTwo();
        const out = doc.createElement('pre'); out.className = 'rev-diff';
        out.textContent = lines.length ? lines.join('\n') : '(no differences detected)';
        wrap.appendChild(out);
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
