// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  describeEvent,
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
