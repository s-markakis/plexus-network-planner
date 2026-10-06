// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  describeEvent,
  describePdu,
  summarizePing,
  summarizeTrace,
  mountSimPanel,
} from '../files/src/simUI.js';
import { buildSampleProject } from '../files/src/sampleProject.js';

describe('describeEvent', () => {
  it('renders the common event kinds', () => {
    expect(describeEvent({ kind: 'host-send', devName: 'PC1', to: '10.0.0.2' })).toBe(
      'PC1 sends ICMP echo → 10.0.0.2'
    );
    expect(describeEvent({ kind: 'arp-request', devName: 'PC1', who: '10.0.0.1' })).toBe(
      'PC1 ARP: who-has 10.0.0.1?'
    );
    expect(describeEvent({ kind: 'l3-no-route', devName: 'R1', dst: '8.8.8.8' })).toBe(
      'R1 has no route to 8.8.8.8'
    );
  });
  it('falls back to the raw kind for anything unknown', () => {
    expect(describeEvent({ kind: 'mystery', devName: 'X' })).toBe('X mystery');
  });
});

describe('summarizePing / summarizeTrace', () => {
  it('summarizes a delivered result', () => {
    const s = summarizePing({ ok: true, status: 'delivered', events: [{ kind: 'host-send', devName: 'A', to: 'b' }] });
    expect(s.ok).toBe(true);
    expect(s.label).toMatch(/Reachable/);
    expect(s.lines[0].text).toContain('sends ICMP echo');
  });
  it('marks the reached hop in a traceroute', () => {
    const lines = summarizeTrace([
      { ttl: 1, ip: '10.0.0.1', reached: false },
      { ttl: 2, ip: '10.0.2.10', reached: true },
    ]);
    expect(lines[1].reached).toBe(true);
    expect(lines[1].text).toContain('← destination');
  });
});

describe('mountSimPanel against the sample project', () => {
  function setup() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onFocus = vi.fn();
    const panel = mountSimPanel({ root, getProject: () => buildSampleProject(), onFocus });
    return { root, panel, onFocus };
  }
  /** @returns {HTMLSelectElement} */
  const pick = (root, id) => root.querySelector(id);

  it('populates the device pickers from the plan', () => {
    const { root } = setup();
    expect(pick(root, '#sim-from').options.length).toBe(5); // 3 APs + 2 cameras
  });

  it('a same-VLAN ping reports reachable and logs an ARP exchange', () => {
    const { root } = setup();
    pick(root, '#sim-from').value = 'h:ap14'; // 10.0.10.11
    pick(root, '#sim-to').value = 'h:ap15'; // 10.0.10.12
    root.querySelectorAll('button')[0].click(); // Ping
    expect(root.querySelector('.sim-verdict').classList.contains('ok')).toBe(true);
    const logText = root.querySelector('.sim-log').textContent;
    expect(logText).toMatch(/ARP: who-has/);
    expect(logText).toMatch(/echo-reply/);
  });

  it('a cross-VLAN ping reports unreachable with a no-route step', () => {
    const { root } = setup();
    pick(root, '#sim-from').value = 'h:ap14'; // VLAN 10
    pick(root, '#sim-to').value = 'h:cm18'; // VLAN 20
    root.querySelectorAll('button')[0].click();
    expect(root.querySelector('.sim-verdict').classList.contains('bad')).toBe(true);
    expect(root.querySelector('.sim-log').textContent).toMatch(/no route/);
  });

  it('Step ▶ focuses the device of the current log line', () => {
    const { root, onFocus } = setup();
    pick(root, '#sim-from').value = 'h:ap14';
    pick(root, '#sim-to').value = 'h:ap15';
    root.querySelectorAll('button')[0].click(); // Ping
    const buttons = [...root.querySelectorAll('button')];
    const step = buttons.find((b) => b.textContent.includes('Step'));
    step.click();
    expect(onFocus).toHaveBeenCalled();
    expect(onFocus.mock.calls[0][0]).toHaveProperty('srcId');
  });
});

describe('simUI robustness (DOM)', () => {
  /** @returns {HTMLSelectElement} */
  const pick = (root, id) => root.querySelector(id);

  it('renders a hostile device name as inert text, never as markup', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const proj = () => ({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{
        id: 'f1', SWS: [{ id: 's' }],
        APS: [
          { id: 'a1', name: '<img src=x onerror=1>', swId: 's', port: '1', vlan: '10', ip: '10.0.10.1' },
          { id: 'a2', name: '<b>B</b>', swId: 's', port: '2', vlan: '10', ip: '10.0.10.2' },
        ], CAMS: [],
      }],
    });
    mountSimPanel({ root, getProject: proj, onFocus: () => {} });
    pick(root, '#sim-from').value = 'h:a1';
    pick(root, '#sim-to').value = 'h:a2';
    root.querySelectorAll('button')[0].click(); // Ping
    // No markup from the names was parsed into real elements…
    expect(root.querySelector('.sim-log img')).toBeNull();
    expect(root.querySelector('.sim-log b')).toBeNull();
    expect(root.querySelector('#sim-from img')).toBeNull();
    // …but the literal text is present.
    expect(root.querySelector('.sim-log').textContent).toContain('<img src=x onerror=1>');
  });

  it('surfaces compile warnings in the status line instead of hiding them', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const proj = () => ({
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }] },
      floors: [{ id: 'f1', SWS: [{ id: 's' }], APS: [{ id: 'a', name: 'orphan', vlan: '10', ip: '10.0.10.1' }], CAMS: [] }],
    });
    mountSimPanel({ root, getProject: proj, onFocus: () => {} });
    expect(root.querySelector('.sim-status').textContent).toMatch(/warning/);
  });

  it('shows a status (no throw) when getProject fails', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    expect(() => mountSimPanel({ root, getProject: () => { throw new Error('boom'); }, onFocus: () => {} })).not.toThrow();
    expect(root.querySelector('.sim-status').textContent).toMatch(/No project/);
  });

  it('handles an empty plan: no devices, Ping is a safe no-op', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountSimPanel({ root, getProject: () => ({ settings: { vlans: [] }, floors: [] }), onFocus: () => {} });
    expect(pick(root, '#sim-from').options.length).toBe(0);
    expect(() => root.querySelectorAll('button')[0].click()).not.toThrow();
  });
});

describe('describePdu', () => {
  it('formats the fields an event carries', () => {
    const rows = describePdu({ kind: 'l2-flood', devName: 'SW1', vlan: 10, dstMac: 'ff:ff:ff:ff:ff:ff' });
    expect(rows).toContainEqual(['Device', 'SW1']);
    expect(rows).toContainEqual(['VLAN', '10']);
    expect(rows[0]).toEqual(['Step', 'l2-flood']);
  });
  it('is empty for a null event', () => expect(describePdu(null)).toEqual([]));
});

describe('sim panel animation + inspector', () => {
  /** @returns {HTMLSelectElement} */
  const pick = (root, id) => root.querySelector(id);

  it('auto-animates after a ping — onAnimate receives the waypoints', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onAnimate = vi.fn();
    mountSimPanel({ root, getProject: () => buildSampleProject(), onFocus() {}, onAnimate });
    pick(root, '#sim-from').value = 'h:ap14';
    pick(root, '#sim-to').value = 'h:ap15';
    root.querySelectorAll('button')[0].click(); // Ping
    expect(onAnimate).toHaveBeenCalled();
    expect(onAnimate.mock.calls[0][0].length).toBeGreaterThan(1);
    expect(onAnimate.mock.calls[0][0][0]).toHaveProperty('fx');
  });

  it('clicking a log step renders the PDU inspector', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountSimPanel({ root, getProject: () => buildSampleProject(), onFocus() {}, onAnimate() {} });
    pick(root, '#sim-from').value = 'h:ap14';
    pick(root, '#sim-to').value = 'h:ap15';
    root.querySelectorAll('button')[0].click();
    root.querySelector('.sim-log li').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelectorAll('.sim-insp-row').length).toBeGreaterThan(0);
  });
});
