import { describe, it, expect } from 'vitest';
import { sanitizeProject } from '../files/src/validate.js';
import { migrateProject } from '../files/src/migrate.js';

describe('sanitizeProject', () => {
  it('rejects things that are not projects', () => {
    expect(() => sanitizeProject(null)).toThrow(/Not a Plexus project/);
    expect(() => sanitizeProject([])).toThrow(/Not a Plexus project/);
    expect(() => sanitizeProject({})).toThrow(/Missing floors/);
  });
  it('leaves a well-formed project untouched and reports nothing', () => {
    const p = { version: 11, floors: [{ id: 'f', name: 'G', APS: [{ id: 'a1', name: 'AP', fx: 0.5, fy: 0.5, r: 80, port: 3, channel: 36 }] }] };
    const [out, issues] = sanitizeProject(JSON.parse(JSON.stringify(p)));
    expect(out.floors).toEqual(p.floors);
    expect(issues).toEqual([]);
  });
  it('does not mutate its input', () => {
    const p = { floors: [{ APS: [null, { id: 7 }] }] };
    const before = JSON.stringify(p);
    sanitizeProject(p);
    expect(JSON.stringify(p)).toBe(before);
  });
  it('drops malformed entries and resets non-list device lists', () => {
    const [out, issues] = sanitizeProject({ floors: [null, 'x', { APS: [null, 5, { id: 'a' }], SWS: 'nope', CAMS: { 0: {} } }] });
    expect(out.floors).toHaveLength(1);
    expect(out.floors[0].APS).toEqual([{ id: 'a' }]);
    expect(out.floors[0].SWS).toEqual([]);
    expect(out.floors[0].CAMS).toEqual([]);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
  it('coerces text and numeric fields to the type the app expects', () => {
    const [out] = sanitizeProject({ floors: [{ APS: [{ id: 12, name: { evil: 1 }, ip: 3232235777, vlan: 10, r: '90', fx: 'abc', heading: '<img>' }] }] });
    expect(out.floors[0].APS[0]).toEqual({ id: '12', ip: '3232235777', vlan: '10', r: 90 });
  });
  it('strips prototype-aliasing keys at any depth', () => {
    const raw = JSON.parse('{"floors":[{"SWS":[{"id":"s","cli":{"interfaces":{"__proto__":{"ip":"9.9.9.9"},"g0":{"ip":"1.1.1.1"}}}}]}],"__proto__":{"polluted":true}}');
    const [out, issues] = sanitizeProject(raw);
    expect(Object.keys(out.floors[0].SWS[0].cli.interfaces)).toEqual(['g0']);
    expect(out.floors[0].SWS[0].cli.interfaces.g0.name).toBe('g0');
    expect(({}).polluted).toBeUndefined();
    expect(issues.some((i) => /reserved key/.test(i))).toBe(true);
  });
  it('repairs malformed creds, cli, settings and revisions', () => {
    const [out] = sanitizeProject({
      floors: [{ SWS: [{ id: 's', creds: 'plain', cli: [] }, { id: 't', creds: { user: 5, pass: null }, cli: { interfaces: [], routes: 'x' } }] }],
      settings: 'x', revisions: [null, { name: 3, snapshot: [null, { APS: [null] }] }, { snapshot: 'bad' }],
    });
    const [s, t] = out.floors[0].SWS;
    expect(s.creds).toBeUndefined();
    expect(s.cli).toBeUndefined();
    expect(t.creds).toEqual({ user: '5', pass: '' });
    expect(t.cli).toMatchObject({ interfaces: {}, routes: [], acls: [] });
    expect(out.settings).toBeUndefined();
    expect(out.revisions).toHaveLength(2);
    expect(out.revisions[0]).toMatchObject({ name: '3', snapshot: [{ APS: [] }] });
    expect(out.revisions[1].snapshot).toEqual([]);
  });
  it('bounds depth and length', () => {
    /** @type {any} */
    let deep = {}; const root = deep;
    for (let i = 0; i < 60; i++) { deep.x = {}; deep = deep.x; }
    const [out, issues] = sanitizeProject({ floors: [{ APS: [{ id: 'a', name: 'n'.repeat(300000), img: 'd'.repeat(300000), deep: root }] }] });
    expect(out.floors[0].APS[0].name.length).toBe(200000);
    expect(out.floors[0].APS[0].img.length).toBe(300000);   // image blobs are exempt
    expect(issues.some((i) => /too deep/.test(i))).toBe(true);
  });
});

describe('migrateProject on hostile files', () => {
  it('loads a structurally broken project instead of throwing later', () => {
    const [data, warnings] = migrateProject({ floors: [{ APS: [null, { id: 'a' }], SWS: 7, WALLS: [3] }], revisions: [null] });
    expect(data.floors[0].APS).toHaveLength(1);
    expect(data.floors[0].APS[0].model).toBe('U6 Pro');     // defaults still applied
    expect(data.floors[0].SWS).toEqual([]);
    expect(warnings.some((w) => /structural problem/.test(w))).toBe(true);
  });
  it('normalises revision snapshots like live floors (they can be restored)', () => {
    const [data] = migrateProject({ floors: [{}], revisions: [{ id: 'r1', name: 'x', snapshot: [{ DZS: [{ id: 'd', r: '"><img src=x>' }], APS: [{ id: 'a', heading: 'x' }] }] }] });
    const snap = data.revisions[0].snapshot[0];
    expect(snap.DZS[0].r).toBe(40);
    expect(snap.APS[0].heading).toBe(0);
    expect(snap.APS[0].model).toBe('U6 Pro');
  });
});
