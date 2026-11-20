import { describe, it, expect } from 'vitest';
import {
  normalizeCircuits, deviceIndex, autoTrace, circuitDrift, searchCircuits,
  circuitsThrough, mergeTrace, pathText, foldText,
} from '../files/src/circuits.js';
import { migrateProject } from '../files/src/migrate.js';

// core ← dist ← acc (port 7) ← cam on floor 2; AP on acc port 3.
const plan = () => ({
  settings: {},
  floors: [
    { name: 'Ground', SWS: [
      { id: 'core', name: 'Core', uplinkId: '' },
      { id: 'dist', name: 'Dist', uplinkId: 'core' },
      { id: 'acc', name: 'Acc-1', uplinkId: 'dist' },
    ], APS: [{ id: 'ap1', name: 'AP-Lobby', swId: 'acc', port: '3', ip: '10.0.0.5' }], CAMS: [] },
    { name: 'First', SWS: [], APS: [], CAMS: [{ id: 'cam1', name: 'CAM-Πισίνα', swId: 'acc', port: '7', mac: 'aa:bb:cc:00:11:22' }] },
  ],
});
const dev = (ref, port = '') => ({ type: 'device', ref, port, label: '', note: '' });
const pp = (label, port = '', note = '') => ({ type: 'patch', ref: '', port, label, note });

describe('autoTrace', () => {
  it('walks device → access switch port → uplink chain, across floors', () => {
    const p = plan();
    expect(autoTrace(p, 'cam1')).toEqual([dev('cam1'), dev('acc', '7'), dev('dist'), dev('core')]);
    expect(autoTrace(p, 'dist')).toEqual([dev('dist'), dev('core')]);
    expect(autoTrace(p, 'nope')).toEqual([]);
  });
  it('is bounded under an uplink cycle', () => {
    const p = plan();
    p.floors[0].SWS[0].uplinkId = 'acc'; // core → acc → dist → core
    expect(autoTrace(p, 'cam1').map((h) => h.ref)).toEqual(['cam1', 'acc', 'dist', 'core']);
  });
  it('stops at a dangling uplink', () => {
    const p = plan();
    p.floors[0].SWS[2].uplinkId = 'ghost';
    expect(autoTrace(p, 'ap1').map((h) => h.ref)).toEqual(['ap1', 'acc']);
  });
});

describe('normalizeCircuits', () => {
  it('drops junk, repairs fields, dedupes ids, never throws', () => {
    const out = normalizeCircuits([null, 5, { id: 'a', name: 7, hops: [{ type: 'weird', label: 'x' }, {}, 'bad'], date: 'yesterday' }, { id: 'a', name: 'dup' }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'a', name: '7', date: '', hops: [{ type: 'other', label: 'x' }] });
    expect(out[1].id).not.toBe('a');
    expect(normalizeCircuits('nope')).toEqual([]);
  });
  it('strips ref from non-device hops and caps sizes', () => {
    const [c] = normalizeCircuits([{ id: 'c', hops: [{ type: 'patch', ref: 'sw1', label: 'PP1' }], notes: 'x'.repeat(5000) }]);
    expect(c.hops[0].ref).toBe('');
    expect(c.notes.length).toBe(2000);
    const many = normalizeCircuits([{ id: 'm', hops: Array.from({ length: 500 }, (_, i) => pp('P' + i)) }]);
    expect(many[0].hops.length).toBe(64);
  });
  it('survives a project round-trip through migrate', () => {
    const p = plan();
    p.settings.circuits = [{ id: 'k1', name: 'Pool cam', from: 'cam1', hops: [dev('cam1'), pp('PP2', '14'), dev('acc', '7')], tech: 'Nikos', date: '2026-11-20' }, 'junk'];
    const [m] = migrateProject(p);
    expect(m.settings.circuits).toHaveLength(1);
    expect(m.settings.circuits[0]).toMatchObject({ name: 'Pool cam', tech: 'Nikos', date: '2026-11-20' });
    const [m2] = migrateProject({ floors: [] });
    expect(m2.settings.circuits).toEqual([]);
  });
});

describe('circuitDrift', () => {
  const rec = (hops) => normalizeCircuits([{ id: 'x', name: 'x', from: 'cam1', hops }])[0];
  it('is clean when device hops match the plan, ignoring passive hops', () => {
    expect(circuitDrift(plan(), rec([dev('cam1'), pp('PP2', '14'), dev('acc', '7'), pp('PP1', '1'), dev('dist'), dev('core')]))).toEqual([]);
  });
  it('flags a moved port and a re-homed switch', () => {
    const p = plan();
    p.floors[1].CAMS[0].port = '9';
    expect(circuitDrift(p, rec([dev('cam1'), dev('acc', '7'), dev('dist'), dev('core')]))).toEqual(['Acc-1: recorded port 7, plan says 9']);
    p.floors[0].SWS[2].uplinkId = 'core';
    expect(circuitDrift(p, rec([dev('cam1'), dev('acc', '9'), dev('dist'), dev('core')]))[0]).toMatch(/Hop 3: recorded Dist, plan says Core/);
  });
  it('flags deleted devices', () => {
    const p = plan();
    p.floors[0].SWS.splice(1, 1); // dist gone
    const issues = circuitDrift(p, rec([dev('cam1'), dev('acc', '7'), dev('dist'), dev('core')]));
    expect(issues).toContain('Device dist is no longer in the plan');
  });
});

describe('searchCircuits', () => {
  const p = plan();
  const all = normalizeCircuits([
    { id: 'a', name: 'Pool camera', from: 'cam1', hops: [dev('cam1'), pp('PP2', '14', 'blue cable'), dev('acc', '7')], tech: 'Nikos' },
    { id: 'b', name: 'Lobby AP', from: 'ap1', hops: [dev('ap1'), { type: 'outlet', label: 'W-12' }, dev('acc', '3')], tech: 'Maria' },
  ]);
  const ids = (q) => searchCircuits(p, all, q).map((r) => r.circuit.id);
  it('empty query lists everything', () => expect(ids('')).toEqual(['a', 'b']));
  it('finds by passive label, port, device name, tech, device MAC/IP', () => {
    expect(ids('pp2')).toEqual(['a']);
    expect(ids('w-12')).toEqual(['b']);
    expect(ids('acc-1')).toEqual(['a', 'b']);
    expect(ids('maria')).toEqual(['b']);
    expect(ids('aa:bb:cc')).toEqual(['a']);
    expect(ids('10.0.0.5')).toEqual(['b']);
  });
  it('is accent- and case-insensitive (Greek)', () => expect(ids('ΠΙΣΙΝΑ')).toEqual(['a']));
  it('ANDs terms and reports the matching hops', () => {
    expect(ids('acc-1 blue')).toEqual(['a']);
    const [r] = searchCircuits(p, all, 'pp2 port 7');
    expect(r.hops).toEqual([1, 2]);
  });
  it('circuitsThrough filters by any device on the path', () => {
    expect(circuitsThrough(all, 'acc').map((c) => c.id)).toEqual(['a', 'b']);
    expect(circuitsThrough(all, 'cam1').map((c) => c.id)).toEqual(['a']);
    expect(circuitsThrough(all, '')).toEqual([]);
  });
  it('pathText reads end-to-core', () => {
    expect(pathText(all[0], deviceIndex(p))).toBe('CAM-Πισίνα → PP2 #14 → Acc-1 port 7');
  });
  it('foldText strips accents', () => expect(foldText('Πισίνα')).toBe('πισινα'));
});

describe('mergeTrace', () => {
  it('re-derives device hops and keeps passive hops after their anchor', () => {
    const hops = [dev('cam1'), pp('PP2', '14'), dev('acc', '7'), pp('PP1', '1')];
    const out = mergeTrace(hops, autoTrace(plan(), 'cam1'));
    expect(out.map((h) => h.ref || h.label)).toEqual(['cam1', 'PP2', 'acc', 'PP1', 'dist', 'core']);
  });
  it('re-homes passive hops whose anchor left the path, never drops them', () => {
    const hops = [pp('Front'), dev('cam1'), dev('old', '2'), pp('PP9', '3'), dev('acc', '7')];
    const out = mergeTrace(hops, autoTrace(plan(), 'cam1'));
    expect(out.map((h) => h.ref || h.label)).toEqual(['Front', 'cam1', 'PP9', 'acc', 'dist', 'core']);
  });
  it('keeps a recorded uplink port the plan does not model', () => {
    const out = mergeTrace([dev('cam1'), dev('acc', '7'), dev('dist', 'Gi0/24')], autoTrace(plan(), 'cam1'));
    expect(out.find((h) => h.ref === 'dist').port).toBe('Gi0/24');
  });
});
