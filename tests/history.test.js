import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHistory } from '../files/src/history.js';

function setup(opts = {}) {
  let state = 'A';
  const changes = [];
  const h = createHistory({ serialize: () => state, restore: (s) => { state = s; }, onChange: () => changes.push(1), ...opts });
  return { h, get: () => state, set: (v) => { state = v; }, changes };
}

describe('history', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('undo and redo walk snapshots', () => {
    const { h, get, set } = setup();
    h.snapshot(); set('B');
    h.snapshot(); set('C');
    expect(h.undo()).toBe(true); expect(get()).toBe('B');
    expect(h.undo()).toBe(true); expect(get()).toBe('A');
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(true); expect(get()).toBe('B');
    expect(h.redo()).toBe(true); expect(get()).toBe('C');
    expect(h.redo()).toBe(false);
  });

  it('a new snapshot clears redo', () => {
    const { h, set } = setup();
    h.snapshot(); set('B'); h.undo();
    expect(h.canRedo()).toBe(true);
    h.snapshot();
    expect(h.canRedo()).toBe(false);
  });

  it('snapshotSoon collapses a burst into one step holding the pre-edit state', () => {
    const { h, get, set } = setup();
    h.snapshotSoon(); set('A1');
    vi.advanceTimersByTime(300);
    h.snapshotSoon(); set('A2');
    vi.advanceTimersByTime(300);
    expect(h.canUndo()).toBe(false);        // still inside the quiet window
    vi.advanceTimersByTime(200);
    expect(h.canUndo()).toBe(true);
    h.undo();
    expect(get()).toBe('A');
    expect(h.canUndo()).toBe(false);
  });

  it('flush commits a pending burst immediately', () => {
    const { h, get, set } = setup();
    h.snapshotSoon(); set('B');
    h.flush();
    expect(h.canUndo()).toBe(true);
    vi.advanceTimersByTime(1000);            // the timer must not commit twice
    h.undo(); expect(get()).toBe('A'); expect(h.canUndo()).toBe(false);
  });

  it('a synchronous snapshot supersedes a pending burst', () => {
    const { h, set } = setup();
    h.snapshotSoon(); set('B');
    h.snapshot();
    vi.advanceTimersByTime(1000);
    h.undo();
    expect(h.canUndo()).toBe(false);         // exactly one entry was recorded
  });

  it('reset drops history and any pending burst', () => {
    const { h, get, set } = setup();
    h.snapshot(); set('B'); h.snapshotSoon(); set('C');
    h.reset();
    vi.advanceTimersByTime(1000);
    expect(h.canUndo()).toBe(false); expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBe(false); expect(get()).toBe('C');
  });

  it('keeps at most `limit` entries', () => {
    const { h, get, set } = setup({ limit: 3 });
    for (const v of ['B', 'C', 'D', 'E', 'F']) { h.snapshot(); set(v); }
    let n = 0; while (h.undo()) n++;
    expect(n).toBe(3); expect(get()).toBe('C');
  });

  it('mentions() sees undo, redo and a pending pre-state', () => {
    const { h, set } = setup();
    set('has img_1'); h.snapshot(); set('plain');
    expect(h.mentions('img_1')).toBe(true);
    h.undo();                                   // 'plain' now sits on redo
    expect(h.mentions('plain')).toBe(true);
    h.reset(); set('pre img_2'); h.snapshotSoon(); set('after');
    expect(h.mentions('img_2')).toBe(true);
    expect(h.mentions('img_9')).toBe(false);
  });

  it('notifies on every change', () => {
    const { h, changes } = setup();
    h.snapshot(); h.undo(); h.redo(); h.reset();
    expect(changes.length).toBe(4);
  });
});
