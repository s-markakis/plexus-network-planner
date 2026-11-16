import { describe, it, expect } from 'vitest';
import { createImageTrash, imageIdsIn } from '../files/src/imageTrash.js';

function setup() {
  const live = new Set(); const held = new Set(); const dropped = [];
  const t = createImageTrash({ liveIds: () => live, isHeld: (id) => held.has(id), drop: (id) => dropped.push(id) });
  return { t, live, held, dropped };
}

describe('imageIdsIn', () => {
  it('collects floor plans and device photos, tolerating gaps', () => {
    const ids = imageIdsIn([
      { imgId: 'p1', APS: [{ imgId: 'a1' }, {}], CAMS: [{ imgId: 'c1' }], SWS: null },
      null, { imgId: '' },
    ]);
    expect([...ids].sort()).toEqual(['a1', 'c1', 'p1']);
    expect(imageIdsIn(undefined).size).toBe(0);
  });
});

describe('image trash', () => {
  it('deletes a released image nothing refers to', () => {
    const { t, dropped } = setup();
    t.release('x');
    expect(dropped).toEqual(['x']); expect(t.pending()).toBe(0);
  });

  it('keeps an image an undo entry could restore, until history lets go', () => {
    const { t, held, dropped } = setup();
    held.add('x');
    t.release('x');
    expect(dropped).toEqual([]);
    held.delete('x'); t.sweep();
    expect(dropped).toEqual(['x']);
  });

  it('keeps an image a revision or the plan still uses', () => {
    const { t, live, dropped } = setup();
    live.add('x');
    t.release('x');
    expect(dropped).toEqual([]); expect(t.pending()).toBe(1);
  });

  it('undo makes it live again, redo drops it again without a second release', () => {
    const { t, live, held, dropped } = setup();
    held.add('x'); t.release('x');
    live.add('x'); held.delete('x'); t.sweep();       // undone: back on the plan
    expect(dropped).toEqual([]);
    live.delete('x'); t.sweep();                      // redone + history cleared
    expect(dropped).toEqual(['x']);
  });

  it('retire queues without deleting until swept', () => {
    const { t, live, dropped } = setup();
    live.add('keep');
    t.retire(['old1', 'old2', 'keep', '']);
    expect(dropped).toEqual([]);
    t.sweep();
    expect(dropped.sort()).toEqual(['old1', 'old2']);
  });

  it('never deletes ids it was not given', () => {
    const { t, dropped } = setup();
    t.sweep(); t.release('');
    expect(dropped).toEqual([]);
  });
});
