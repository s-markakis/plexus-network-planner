// Undo/redo history over opaque serialized states. Extracted from app.js so the
// rules are testable without the DOM:
//   - snapshot()      commit the current state as an undo point now;
//   - snapshotSoon()  for streaming edits (sliders, typing): the FIRST call of a
//                     burst captures the pre-edit state, and it is committed once
//                     the burst goes quiet — so Undo jumps the whole burst;
//   - reset()         drop everything (a different project was opened: its
//                     history must never be undone into the new one).
// The owner supplies serialize()/restore(); entries are plain strings.

/**
 * @param {{serialize:()=>string, restore:(s:string)=>void, limit?:number,
 *          debounceMs?:number, onChange?:()=>void}} opts
 */
export function createHistory({ serialize, restore, limit = 50, debounceMs = 400, onChange = () => {} }) {
  /** @type {string[]} */ let undoStack = [];
  /** @type {string[]} */ let redoStack = [];
  /** @type {any} */ let timer = null;
  let pending = false;
  /** @type {string|null} */ let preState = null;

  const commit = (state) => {
    undoStack.push(state);
    if (undoStack.length > limit) undoStack.shift();
    redoStack = [];
    onChange();
  };
  const cancelPending = () => { pending = false; clearTimeout(timer); timer = null; preState = null; };

  return {
    snapshot() {
      // A synchronous commit already holds the right "before" state, so a
      // pending debounced one is redundant.
      cancelPending();
      commit(serialize());
    },
    snapshotSoon() {
      if (!pending) { pending = true; preState = serialize(); }
      clearTimeout(timer);
      timer = setTimeout(() => this.flush(), debounceMs);
    },
    // Commit a pending burst immediately (blur handlers).
    flush() {
      if (!pending) return;
      const state = /** @type {string} */ (preState);
      cancelPending();
      commit(state);
    },
    undo() {
      if (!undoStack.length) return false;
      redoStack.push(serialize());
      restore(/** @type {string} */ (undoStack.pop()));
      onChange();
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(serialize());
      restore(/** @type {string} */ (redoStack.pop()));
      onChange();
      return true;
    },
    reset() { cancelPending(); undoStack = []; redoStack = []; onChange(); },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    // Does any reachable state still mention this text (e.g. an image id)?
    mentions(text) {
      return undoStack.some((e) => e.includes(text)) || redoStack.some((e) => e.includes(text))
        || (preState != null && preState.includes(text));
    },
  };
}
