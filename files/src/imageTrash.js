// Deferred deletion of stored images. An image may only be deleted once
// nothing can bring it back: undo entries and revision snapshots name images by
// id, so deleting on the spot lost the floor plan after an undo or a revision
// restore. Released ids wait here until they are neither live nor held.
// Session-local on purpose: it only ever deletes ids released through it, never
// "everything unreferenced" (another window may share the same store).

// Collect the image ids a list of floors refers to (plans + device photos).
/** @param {any[]|undefined|null} floors @param {Set<string>} [out] */
export function imageIdsIn(floors, out = new Set()) {
  for (const f of floors || []) {
    if (!f) continue;
    if (f.imgId) out.add(f.imgId);
    for (const k of ['APS', 'CAMS', 'SWS']) for (const it of f[k] || []) if (it && it.imgId) out.add(it.imgId);
  }
  return out;
}

/**
 * @param {{liveIds:()=>Set<string>, isHeld:(id:string)=>boolean, drop:(id:string)=>void}} opts
 *   liveIds: ids the current project (floors + revisions) refers to;
 *   isHeld:  true while history could still restore a state naming the id;
 *   drop:    actually delete the image.
 */
export function createImageTrash({ liveIds, isHeld, drop }) {
  /** @type {Set<string>} */ const trash = new Set();
  const sweep = () => {
    if (!trash.size) return;
    const live = liveIds();
    for (const id of [...trash]) {
      // Stays in the trash while reachable: an undo can make it live again and
      // a later redo drop it again without another release().
      if (live.has(id) || isHeld(id)) continue;
      trash.delete(id);
      drop(id);
    }
  };
  return {
    release(id) { if (!id) return; trash.add(id); sweep(); },
    // Queue many ids without sweeping (the project is about to be replaced).
    retire(ids) { for (const id of ids || []) if (id) trash.add(id); },
    sweep,
    pending: () => trash.size,
  };
}
