// @vitest-environment jsdom
// Sim panel: L4 probe, fault injection, gateway/management targets, VLAN matrix.
import { describe, it, expect } from 'vitest';
import { mountSimPanel, summarizeProbe, matrixRows } from '../files/src/simUI.js';

const project = () => ({
  settings: { vlans: [
    { id: '10', subnet: '192.168.10.0/24', gateway: '192.168.10.1' },
    { id: '20', subnet: '192.168.20.0/24', gateway: '192.168.20.1' },
  ] },
  floors: [{ id: 'f',
    SWS: [{ id: 'core', name: 'Core', role: 'l3', fx: 0.1, fy: 0.1 }, { id: 'acc', name: 'Acc', uplinkId: 'core', fx: 0.5, fy: 0.5 }],
    APS: [{ id: 'a1', name: 'A1', swId: 'core', port: 1, vlan: '10', ip: '192.168.10.5', fx: 0.2, fy: 0.2 }],
    CAMS: [{ id: 'c1', name: 'NVR', swId: 'acc', port: 1, vlan: '20', ip: '192.168.20.5', fx: 0.6, fy: 0.6, services: [{ proto: 'tcp', port: 554 }] }] }],
});

function mount(p = project()) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountSimPanel({ root, getProject: () => p });
  const q = (s) => root.querySelector(s);
  const btn = (text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
  return { root, q, btn, verdict: () => q('.sim-verdict').textContent };
}

describe('L4 probe', () => {
  it('reports open, closed and bad ports', () => {
    const { q, btn, verdict } = mount();
    q('#sim-from').value = 'h:a1'; q('#sim-to').value = 'h:c1';
    q('#sim-port').value = '554'; btn('Probe port').click();
    expect(verdict()).toMatch(/Open — tcp\/554/);
    q('#sim-port').value = '22'; btn('Probe port').click();
    expect(verdict()).toMatch(/Closed/);
    q('#sim-port').value = '99999'; btn('Probe port').click();
    expect(verdict()).toMatch(/port between 1 and 65535/);
  });
  it('summarizeProbe words every status', () => {
    const r = (status) => summarizeProbe({ ok: status === 'delivered', status, events: [] }, 'tcp', 22).label;
    expect(r('filtered')).toMatch(/Filtered/);
    expect(r('unreachable')).toMatch(/Unreachable/);
  });
});

describe('targets', () => {
  it('offers gateways as destinations and keeps the choice across a run', () => {
    const { q, btn, verdict } = mount();
    const gw = [...q('#sim-to').options].find((o) => o.dataset.ip === '192.168.20.1');
    expect(gw.parentElement.label).toBe('Gateways');
    q('#sim-from').value = 'h:a1'; q('#sim-to').value = gw.value;
    btn('Ping').click();
    expect(verdict()).toMatch(/Reachable/);
    expect(q('#sim-to').value).toBe('ip:192.168.20.1');
    expect([...q('#sim-from').options].every((o) => !o.value.startsWith('ip:'))).toBe(true);
  });
});

describe('fault injection', () => {
  it('cutting the uplink breaks the path; clearing it restores it', () => {
    const { root, q, btn, verdict } = mount();
    q('#sim-from').value = 'h:a1'; q('#sim-to').value = 'h:c1';
    btn('Ping').click();
    expect(verdict()).toMatch(/Reachable/);
    const cut = () => [...root.querySelectorAll('.sim-fault')].find((l) => /Cut uplink Acc → Core/.test(l.textContent)).querySelector('input');
    cut().checked = true; cut().dispatchEvent(new Event('change'));
    expect(q('.sim-faults summary').textContent).toBe('Faults — 1 active');
    btn('Ping').click();
    expect(verdict()).toMatch(/Unreachable/);
    expect(cut().checked).toBe(true);           // survives the recompile
    cut().checked = false; cut().dispatchEvent(new Event('change'));
    btn('Ping').click();
    expect(verdict()).toMatch(/Reachable/);
  });
  it('device names in fault labels are text, not markup', () => {
    const p = project(); p.floors[0].SWS[1].name = '<img src=x onerror=alert(1)>';
    const { root } = mount(p);
    expect(root.querySelector('.sim-faults img')).toBeNull();
  });
});

describe('VLAN matrix', () => {
  it('renders a table with one row/column per VLAN', () => {
    const { q, btn } = mount();
    btn('VLAN matrix').click();
    const rows = [...q('.sim-matrix-table').rows].map((r) => [...r.cells].map((c) => c.textContent));
    expect(rows).toEqual([['from \\ to', 'VLAN 10', 'VLAN 20'], ['VLAN 10', '·', '✓'], ['VLAN 20', '✓', '·']]);
    btn('Ping').click();
    expect(q('.sim-matrix-table')).toBeNull();   // cleared by the next test
  });
  it('matrixRows marks blocked and unreachable cells', () => {
    const m = { vlans: ['1', '2'], cells: [[{ status: 'n/a' }, { status: 'blocked' }], [{ status: 'unreachable' }, { status: 'allowed' }]] };
    expect(matrixRows(m).slice(1)).toEqual([['VLAN 1', '·', '⛔'], ['VLAN 2', '✗', '✓']]);
  });
});
