import { describe, it, expect } from 'vitest';
import { diffRevisions } from '../files/src/revisionDiff.js';

const fl = (over = {}) => ({
  id: 'f1', name: 'G',
  APS: [{ id: 'a1', name: 'AP-1', fx: 0.1, fy: 0.1, ip: '10.0.0.5', port: '1' }],
  CAMS: [], SWS: [{ id: 's1', name: 'SW', fx: 0.5, fy: 0.5 }], DZS: [],
  WALLS: [{ id: 'w1', fx1: 0, fy1: 0, fx2: 1, fy2: 0 }],
  ...over,
});

describe('diffRevisions', () => {
  it('reports nothing for identical floors', () => {
    expect(diffRevisions([fl()], [fl()])).toEqual([]);
  });
  it('reports adds, removes, moves, reshapes and field changes', () => {
    const b = fl({
      APS: [{ id: 'a1', name: 'AP-1', fx: 0.2, fy: 0.1, ip: '10.0.0.6', port: '1' }, { id: 'a2', name: 'AP-2', fx: 0, fy: 0 }],
      SWS: [],
      WALLS: [{ id: 'w1', fx1: 0, fy1: 0, fx2: 1, fy2: 1 }],
    });
    expect(diffRevisions([fl()], [b])).toEqual([
      '~ [G] AP AP-1 moved',
      '~ [G] AP AP-1: ip 10.0.0.5 → 10.0.0.6',
      '+ [G] AP AP-2 added',
      '- [G] SW SW removed',
      '~ [G] WALL w1 reshaped',
    ]);
  });
  it('reports whole floors added or removed', () => {
    expect(diffRevisions([fl()], [fl(), fl({ id: 'f2', name: 'First' })])).toEqual(['+ Floor "First" added']);
    expect(diffRevisions([fl(), fl({ id: 'f2', name: 'First' })], [fl()])).toEqual(['- Floor "First" removed']);
  });
  it('shows emptied fields as (empty)', () => {
    const b = fl({ APS: [{ id: 'a1', name: 'AP-1', fx: 0.1, fy: 0.1, ip: '', port: '1' }] });
    expect(diffRevisions([fl()], [b])).toEqual(['~ [G] AP AP-1: ip 10.0.0.5 → (empty)']);
  });
});

describe('diffRevisions — floor matching and RF fields', () => {
  it('matches floors by id: deleting a middle floor reports just that floor', () => {
    const a = [fl({ id: 'f1', name: 'G' }), fl({ id: 'f2', name: 'First' }), fl({ id: 'f3', name: 'Second' })];
    const b = [a[0], a[2]];
    expect(diffRevisions(a, b)).toEqual(['- Floor "First" removed']);
  });
  it('reports a renamed floor and reorders without noise', () => {
    const a = [fl({ id: 'f1', name: 'G' }), fl({ id: 'f2', name: 'First' })];
    expect(diffRevisions(a, [a[1], { ...a[0], name: 'Ground' }])).toEqual(['~ Floor "G" renamed to "Ground"']);
  });
  it('falls back to position when floors have no ids', () => {
    const a = [fl({ id: undefined, name: 'G' })];
    expect(diffRevisions(a, [fl({ id: undefined, name: 'G' })])).toEqual([]);
  });
  it('sees Auto-power and channel-width changes', () => {
    const b = fl({ APS: [{ id: 'a1', name: 'AP-1', fx: 0.1, fy: 0.1, ip: '10.0.0.5', port: '1', txPowerDbm: 14, chanWidth: 40 }] });
    expect(diffRevisions([fl()], [b])).toEqual(['~ [G] AP AP-1: chanWidth (empty) → 40', '~ [G] AP AP-1: txPowerDbm (empty) → 14']);
  });
});
