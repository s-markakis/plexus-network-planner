import { describe, it, expect } from 'vitest';
import {
  normalizeCircuits, mergeTrace, normLabel, newHopIndex, labelSuggestions, circuitConflicts,
  conflictText, bulkCircuits, circuitRows, sortBySwitchPort, circuitImageIds, cableLabelsHtml,
  circuitsReportHtml, deviceIndex,
} from '../files/src/circuits.js';
import { circuitsCsv, patchScheduleCsv } from '../files/src/csvExports.js';

// core ← acc; AP on acc port 3, camera on acc port 7 (first floor), and an AP
// that is not cabled to any switch.
const plan = () => ({
  settings: {},
  floors: [
    { name: 'Ground', SWS: [
      { id: 'core', name: 'Core', uplinkId: '' },
      { id: 'acc', name: 'Acc-1', uplinkId: 'core' },
    ], APS: [
      { id: 'ap1', name: 'AP-Lobby', swId: 'acc', port: '3' },
      { id: 'ap2', name: 'AP-Loose', swId: '' },
    ], CAMS: [] },
    { name: 'First', SWS: [], APS: [], CAMS: [{ id: 'cam1', name: 'CAM-Pool', swId: 'acc', port: '7' }] },
  ],
});
const dev = (ref, port = '') => ({ type: 'device', ref, port, label: '', note: '' });
const hop = (type, label, port = '') => ({ type, ref: '', port, label, note: '' });
const ckt = (id, name, from, hops, extra = {}) => ({ id, name, from, hops, tech: '', date: '', notes: '', ...extra });
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('hop photos', () => {
  it('keeps a valid image id and an image data: URL, nothing else', () => {
    const [c] = normalizeCircuits([ckt('a', 'A', 'ap1', [
      { ...hop('patch', 'PP1', '4'), imgId: 'img_abc_123' },
      { ...hop('outlet', 'W1'), img: PNG },
      { ...hop('cable', 'C1'), img: 'https://evil.example/x.png', imgId: '../../etc' },
      { ...hop('other', 'X'), img: 'data:text/html;base64,PHNjcmlwdD4=' },
    ])]);
    expect(c.hops[0].imgId).toBe('img_abc_123');
    expect(c.hops[1].img).toBe(PNG);
    expect(c.hops[2]).toEqual(hop('cable', 'C1'));        // remote URL + bad id dropped
    expect(c.hops[3]).toEqual(hop('other', 'X'));
  });
  it('a photo-only hop is kept; a photo-less hop keeps its old shape', () => {
    const [c] = normalizeCircuits([ckt('a', 'A', '', [{ type: 'patch', imgId: 'img_x_1' }, hop('patch', 'PP1')])]);
    expect(c.hops).toHaveLength(2);
    expect(Object.keys(c.hops[1]).sort()).toEqual(['label', 'note', 'port', 'ref', 'type']);
  });
  it('rejects an oversized inline image', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(3_000_001);
    const [c] = normalizeCircuits([ckt('a', 'A', '', [{ ...hop('patch', 'PP1'), img: big }])]);
    expect(c.hops[0].img).toBeUndefined();
  });
  it('re-deriving the path keeps a device hop photo', () => {
    const out = mergeTrace([{ ...dev('acc', '3'), imgId: 'img_sw_1' }], [dev('ap1'), dev('acc', '3')]);
    expect(out[1].imgId).toBe('img_sw_1');
  });
  it('circuitImageIds collects every hop photo id', () => {
    const ids = circuitImageIds([ckt('a', 'A', '', [{ ...hop('patch', 'P'), imgId: 'img_1' }, hop('outlet', 'O')]), ckt('b', 'B', '', [{ ...dev('x'), imgId: 'img_2' }])]);
    expect([...ids].sort()).toEqual(['img_1', 'img_2']);
  });
});

describe('labels', () => {
  it('normLabel treats spacing, dashes, case and accents as the same panel', () => {
    expect(normLabel('PP-1')).toBe(normLabel('pp 1'));
    expect(normLabel('PP1')).toBe('pp1');
    expect(normLabel('Πισίνα-2')).toBe('πισινα2');
  });
  it('a new hop goes after the passive plant that follows the end device, before the switch', () => {
    expect(newHopIndex([dev('cam1'), dev('acc', '7'), dev('core')])).toBe(1);
    expect(newHopIndex([dev('cam1'), hop('outlet', 'W1'), dev('acc', '7')])).toBe(2);
    expect(newHopIndex([dev('cam1')])).toBe(1);
    expect(newHopIndex([])).toBe(0);
  });
  it('suggests labels already used, per hop type, first spelling wins', () => {
    const s = labelSuggestions([
      ckt('a', 'A', '', [hop('patch', 'PP2'), hop('patch', 'PP10'), hop('outlet', 'Wall A')]),
      ckt('b', 'B', '', [hop('patch', 'pp-2'), hop('cable', 'C-07')]),
    ]);
    expect(s.patch).toEqual(['PP2', 'PP10']);   // numeric order, "pp-2" folded into PP2
    expect(s.outlet).toEqual(['Wall A']);
    expect(s.cable).toEqual(['C-07']);
    expect(s.device).toBeUndefined();
  });
});

describe('circuitConflicts', () => {
  const list = () => [
    ckt('a', 'CAM-Pool', 'cam1', [dev('cam1'), hop('patch', 'PP1', '14'), hop('cable', 'C-01')]),
    ckt('b', 'AP-Lobby', 'ap1', [dev('ap1'), hop('patch', 'pp-1', '14'), hop('cable', 'C-02')]),
    ckt('c', 'Other', '', [hop('patch', 'PP1', '15'), hop('cable', 'c 01'), hop('outlet', 'W1')]),
  ];
  it('finds a patch position and a cable label claimed twice, normalized', () => {
    const c = circuitConflicts(list());
    expect(c.map((e) => e.key).sort()).toEqual(['cable|c01', 'patch|pp1|14']);
    const pp = c.find((e) => e.type === 'patch');
    expect(pp.circuits.map((x) => x.name)).toEqual(['CAM-Pool', 'AP-Lobby']);
    expect(conflictText(pp)).toBe('Patch panel PP1 #14 is on 2 circuits: CAM-Pool, AP-Lobby');
  });
  it('a point without a position, or used twice in one circuit, is no conflict', () => {
    expect(circuitConflicts([ckt('a', 'A', '', [hop('patch', 'PP1'), hop('patch', 'PP1')]), ckt('b', 'B', '', [hop('patch', 'PP1')])])).toEqual([]);
    expect(circuitConflicts([ckt('a', 'A', '', [hop('cable', 'C1'), hop('cable', 'C1')])])).toEqual([]);
  });
});

describe('bulkCircuits', () => {
  it('creates a circuit per uncabled-free endpoint, skipping existing and unlinked ones', () => {
    const existing = [ckt('x', 'old', 'ap1', [dev('ap1')])];
    const r = bulkCircuits(plan(), existing, { tech: 'Nikos', date: '2026-11-20' });
    expect(r.existing).toBe(1);
    expect(r.unlinked).toEqual(['AP-Loose']);
    expect(r.created).toHaveLength(1);
    const c = r.created[0];
    expect(c).toMatchObject({ name: 'CAM-Pool', from: 'cam1', tech: 'Nikos', date: '2026-11-20' });
    expect(c.hops.map((h) => h.ref)).toEqual(['cam1', 'acc', 'core']);
    expect(c.id).not.toBe('x');
    expect(normalizeCircuits(r.created)).toHaveLength(1);   // valid records
  });
  it('drops a malformed date and never makes circuits for switches', () => {
    const r = bulkCircuits(plan(), [], { date: 'yesterday' });
    expect(r.created.every((c) => c.date === '')).toBe(true);
    expect(r.created.map((c) => c.from).sort()).toEqual(['ap1', 'cam1']);
  });
});

describe('circuitRows + exports', () => {
  const p = plan();
  const circuits = [
    ckt('a', 'CAM-Pool', 'cam1', [dev('cam1'), hop('outlet', 'Pool wall', '2'), hop('patch', 'PP1', '14'), dev('acc', '7'), dev('core')], { tech: 'Nikos', date: '2026-11-20' }),
    ckt('b', 'AP-Lobby', 'ap1', [dev('ap1'), hop('cable', 'C-03'), dev('acc', '3'), dev('core')]),
  ];
  it('flattens a circuit: end device, its switch port, passive plant by type', () => {
    const [r] = circuitRows(p, circuits);
    expect(r).toMatchObject({ name: 'CAM-Pool', device: 'CAM-Pool', deviceType: 'cam', floor: 'First',
      switchName: 'Acc-1', switchPort: '7', patch: 'PP1 #14', outlet: 'Pool wall #2', cable: '', check: '' });
    expect(r.path).toBe('CAM-Pool → Pool wall #2 → PP1 #14 → Acc-1 port 7 → Core');
  });
  it('reports drift in the check column', () => {
    const moved = plan(); moved.floors[1].CAMS[0].port = '9';
    expect(circuitRows(moved, circuits)[0].check).toMatch(/recorded port 7, plan says 9/);
  });
  it('rack order sorts by switch then numeric port', () => {
    const rows = [{ name: 'x', switchName: 'Acc-1', switchPort: '10' }, { name: 'y', switchName: 'Acc-1', switchPort: '9' }, { name: 'z', switchName: '', switchPort: '' }];
    expect(sortBySwitchPort(rows).map((r) => r.name)).toEqual(['y', 'x', 'z']);
  });
  it('CSV: circuits and the patch schedule, empty with no circuits', () => {
    const rows = circuitRows(p, circuits);
    const csv = circuitsCsv(rows).split('\n');
    expect(csv[0]).toMatch(/^Circuit,Device,Type,Floor,Switch,Switch port,Patch panel/);
    expect(csv[1]).toContain('matches plan');
    const ps = patchScheduleCsv(rows).split('\n');
    expect(ps[0]).toBe('Switch,Port,Patch panel,Outlet,Cable,Device,Circuit');
    expect(ps[1].startsWith('Acc-1,3,')).toBe(true);   // port 3 before port 7
    expect(ps[2].startsWith('Acc-1,7,PP1 #14,Pool wall #2,')).toBe(true);
    expect(circuitsCsv([])).toBe('');
    expect(patchScheduleCsv([])).toBe('');
  });
  it('labels: two per circuit, hostile text stays text', () => {
    const rows = circuitRows(p, [ckt('h', '<img src=x onerror=alert(1)>', 'ap1', [dev('ap1'), dev('acc', '3')])]);
    const html = cableLabelsHtml(rows);
    expect(html.match(/class="lbl"/g)).toHaveLength(2);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
  it('report section: empty with no circuits, escaped otherwise', () => {
    expect(circuitsReportHtml([])).toBe('');
    const html = circuitsReportHtml(circuitRows(p, [ckt('h', '"><b>x', 'ap1', [dev('ap1'), dev('acc', '3')])]));
    expect(html).toContain('Circuits &amp; patch schedule');
    expect(html).not.toContain('"><b>');
  });
  it('deviceIndex still covers APs, cameras and switches', () => {
    expect([...deviceIndex(p).keys()].sort()).toEqual(['acc', 'ap1', 'ap2', 'cam1', 'core']);
  });
});
