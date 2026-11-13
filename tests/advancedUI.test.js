// @vitest-environment jsdom
// @ts-nocheck — loose plan fixtures.
// DOM tests: console state/Tab/shows, sim panel playback/filters/queue/blast,
// policies + labs dialogs, live pull + remediation in the device dialog.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mountCliConsole } from '../files/src/cliUI.js';
import { mountSimPanel, pduLayers, eventCategory } from '../files/src/simUI.js';
import { mountPolicies } from '../files/src/policyUI.js';
import { mountLabs } from '../files/src/labsUI.js';
import { mountDeviceConfig } from '../files/src/deviceConfigUI.js';
import { planDeviceModel, renderRouterOs } from '../files/src/rosExport.js';
import { parseRouterOsExport, diffAgainstPlan, remediationScript } from '../files/src/drift.js';
import { LABS } from '../files/src/labs.js';

const require = createRequire(import.meta.url);
const { buildSshPullArgv, PULL_COMMANDS } = require('../electron/sshArgv.cjs');

const project = () => ({
  settings: { vlans: [
    { id: '10', name: 'Staff', subnet: '192.168.10.0/24', gateway: '192.168.10.1' },
    { id: '20', name: 'Cameras', subnet: '192.168.20.0/24', gateway: '192.168.20.1' },
    { id: '99', name: 'Mgmt', subnet: '192.168.99.0/24', gateway: '192.168.99.1' },
  ], policies: [] },
  floors: [{ id: 'f',
    SWS: [{ id: 'core', name: 'Core', role: 'l3', model: 'MikroTik CRS326', fx: 0.2, fy: 0.2 }, { id: 'acc', name: 'Acc', model: 'MikroTik CRS112', uplinkId: 'core', ip: '192.168.99.3', fx: 0.6, fy: 0.6 }],
    APS: [{ id: 'a1', name: 'PC', swId: 'core', port: '1', vlan: '10', ip: '192.168.10.5', fx: 0.3, fy: 0.3 }],
    CAMS: [{ id: 'c1', name: 'NVR', swId: 'acc', port: '3', vlan: '20', ip: '192.168.20.5', fx: 0.7, fy: 0.7, services: [{ proto: 'tcp', port: 554 }] }] }],
});
const div = () => { const r = document.createElement('div'); document.body.appendChild(r); return r; };
const btn = (root, re) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('console', () => {
  const mount = (p = project()) => {
    const root = div();
    const dev = p.floors[0].SWS[0];
    dev.model = 'Cisco Catalyst 9300'; // IOS dialect for these tests
    const c = mountCliConsole({ root, getDevice: () => dev, getProject: () => p });
    const input = root.querySelector('.cli-input');
    const run = (line) => { input.value = line; key(input, 'Enter'); };
    const out = () => [...root.querySelectorAll('.cli-line')].map((l) => l.textContent);
    return { root, input, run, out, c };
  };
  it('remembers what the device learned: ping, then show arp / mac / connections', () => {
    const { run, out } = mount();
    run('en');
    run('show arp');
    expect(out().at(-1)).toMatch(/ARP table is empty/);
    run('ping 192.168.20.5');
    expect(out().at(-1)).toMatch(/echo reply received/);
    run('show arp');
    expect(out().join('\n')).toMatch(/192\.168\.20\.5\s+02:00/);
    run('show mac address-table');
    expect(out().at(-1)).toMatch(/^\d+\s+02:00:/);
    run('show spanning-tree');
    expect(out().join('\n')).toMatch(/This bridge is the root|Root bridge:/);
  });
  it('a config change rebuilds the network (learned state starts over)', () => {
    const { run, out } = mount();
    run('en'); run('ping 192.168.20.5'); run('conf t'); run('hostname CORE1'); run('end'); run('show arp');
    expect(out().at(-1)).toMatch(/ARP table is empty/);
  });
  it('Tab completes and lists options', () => {
    const { input, run, out } = mount();
    run('en');
    input.value = 'conf'; key(input, 'Tab');
    expect(input.value).toBe('configure terminal ');
    input.value = 'show ip'; key(input, 'Tab');
    expect(out().join('\n')).toContain('show ip route');
  });
});

describe('sim panel: playback, filters, inspector, scenario, blast radius', () => {
  const mount = (p = project()) => { const root = div(); mountSimPanel({ root, getProject: () => p }); return { root, q: (s) => root.querySelector(s), verdict: () => root.querySelector('.sim-verdict').textContent }; };
  const pick = (q, from, to) => { q('#sim-from').value = from; q('#sim-to').value = to; };
  it('pduLayers splits a routed step by OSI layer; categories drive filters', () => {
    const layers = pduLayers({ kind: 'l3-route', devName: 'R1', iface: 'svi20', via: 'connected', routeKind: 'connected', pdu: { src: '10.0.1.2', dst: '10.0.2.2', ttl: 63, proto: 'tcp', type: 'l4-request', dport: 554 } });
    expect(layers.map((l) => l.layer)).toEqual(['At this device', 'Layer 3 — IP', 'Layer 4 — TCP']);
    expect(layers[1].rows).toContainEqual(['TTL', '63']);
    expect(layers[2].rows).toContainEqual(['Dst port', '554']);
    expect(pduLayers(null)).toEqual([]);
    expect(['arp-request', 'l2-flood', 'l3-route', 'acl-drop', 'icmp-echo'].map(eventCategory)).toEqual(['arp', 'l2', 'l3', 'fw', 'l4']);
  });
  it('filters hide a protocol family and stepping skips hidden steps', () => {
    const { root, q } = mount();
    pick(q, 'h:a1', 'h:c1');
    btn(root, /^Ping$/).click();
    const items = () => [...root.querySelectorAll('.sim-log li')];
    expect(items().some((li) => li.dataset.cat === 'arp')).toBe(true);
    for (const cat of ['arp', 'l2']) { const cb = root.querySelector(`.sim-filter input[data-cat="${cat}"]`); cb.checked = false; cb.dispatchEvent(new Event('change')); }
    expect(items().filter((li) => li.dataset.cat === 'arp' || li.dataset.cat === 'l2').every((li) => li.hidden)).toBe(true);
    btn(root, /Step/).click(); btn(root, /Step/).click(); btn(root, /Step/).click();
    const active = root.querySelector('.sim-log li.active');
    expect(['l3', 'l4', 'fw']).toContain(active.dataset.cat);
    expect(root.querySelector('.sim-insp-layer')).not.toBeNull();
  });
  it('auto-play walks to the last step and stops', () => {
    vi.useFakeTimers();
    try {
      const { root, q } = mount();
      pick(q, 'h:a1', 'h:c1');
      btn(root, /^Ping$/).click();
      const auto = btn(root, /Auto/);
      auto.click();
      expect(auto.textContent).toMatch(/Pause/);
      vi.advanceTimersByTime(60000);
      expect(auto.textContent).toMatch(/Auto/);
      const items = [...root.querySelectorAll('.sim-log li')];
      expect(items.at(-1).classList.contains('active')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('scenario queue runs several tests on one warm network', () => {
    const { root, q, verdict } = mount();
    pick(q, 'h:a1', 'h:c1');
    btn(root, /Queue/).click();
    q('#sim-port').value = '554'; q('#sim-port').dispatchEvent(new Event('input'));
    btn(root, /Queue/).click();
    q('#sim-port').value = '22'; q('#sim-port').dispatchEvent(new Event('input'));
    btn(root, /Queue/).click();
    expect(root.querySelectorAll('.sim-queue li')).toHaveLength(3);
    btn(root, /Run scenario/).click();
    expect(verdict()).toBe('Scenario: 2/3 passed');
    expect([...root.querySelectorAll('.sim-queue li')].map((li) => li.className)).toEqual(['ok', 'ok', 'bad']);
    const seps = [...root.querySelectorAll('.sim-log li.sim-sep')].map((li) => li.textContent);
    expect(seps).toHaveLength(3);
    expect(seps[1]).toMatch(/✓ tcp\/554  PC → NVR — delivered/);
    // warm network: the second test did not have to ARP again at the source
    const log = [...root.querySelectorAll('.sim-log li')].map((li) => li.textContent);
    const second = log.slice(log.indexOf(seps[1]), log.indexOf(seps[2]));
    expect(second.some((t) => /ARP cache hit/.test(t))).toBe(true);
    root.querySelector('.sim-queue-rm').click();
    expect(root.querySelectorAll('.sim-queue li')).toHaveLength(2);
  });
  it('blast radius lists what a compromised device reaches and flags management', () => {
    const { root, q, verdict } = mount();
    q('#sim-from').value = 'h:c1';
    btn(root, /Blast radius/).click();
    expect(verdict()).toMatch(/If NVR is compromised: reaches \d+ of \d+ addresses/);
    expect(root.querySelector('.sim-blast-high').textContent).toMatch(/Network management is reachable from NVR/);
    expect(root.querySelector('.sim-blast-table').textContent).toContain('192.168.99.3');
  });
});

describe('policies dialog', () => {
  const mount = (p = project()) => {
    const root = div();
    mountPolicies({ root, getProject: () => p, getPolicies: () => p.settings.policies, setPolicies: (x) => { p.settings.policies = x; } });
    return { root, p, q: (s) => root.querySelector(s) };
  };
  it('adds a policy, proves it, and shows the violating pair', () => {
    const { root, p, q } = mount();
    expect(q('.pol-summary').textContent).toBe('No policies yet.');
    q('.pol-from').value = 'vlan:20'; q('.pol-to').value = 'vlan:10'; q('.pol-expect').value = 'deny';
    btn(root, /Add policy/).click();
    expect(p.settings.policies).toHaveLength(1);
    expect(q('.pol-summary').textContent).toBe('0 pass · 1 fail');
    expect(q('.pol-item').textContent).toMatch(/VLAN 20 must NOT reach VLAN 10/);
    expect(q('.pol-detail').textContent).toMatch(/NVR \(192\.168\.20\.5\) → PC \(192\.168\.10\.5\): reachable/);
    btn(root, /Add policy/).click();                       // duplicate refused
    expect(p.settings.policies).toHaveLength(1);
    q('.pol-rm').click();
    expect(p.settings.policies).toEqual([]);
  });
  it('TCP policies need a port; management and Internet are selectable', () => {
    const { root, p, q } = mount();
    expect([...q('.pol-to').options].map((o) => o.value)).toEqual(expect.arrayContaining(['mgmt:', 'internet:', 'device:acc']));
    expect([...q('.pol-from').options].map((o) => o.value)).not.toContain('internet:');
    q('.pol-from').value = 'vlan:10'; q('.pol-to').value = 'mgmt:'; q('.pol-expect').value = 'allow';
    q('.pol-proto').value = 'tcp'; q('.pol-proto').dispatchEvent(new Event('change'));
    btn(root, /Add policy/).click();
    expect(q('.pol-summary').textContent).toMatch(/Enter a port/);
    q('.pol-port').value = '22';
    btn(root, /Add policy/).click();
    expect(p.settings.policies[0]).toMatchObject({ proto: 'tcp', port: 22, expect: 'allow', to: { kind: 'mgmt' } });
    expect(q('.pol-summary').textContent).toBe('1 pass · 0 fail');
  });
  it('hostile names render as text', () => {
    const p = project(); p.settings.vlans[0].name = '<img src=x onerror=alert(1)>'; p.floors[0].APS[0].name = '<b>x</b>';
    const { root } = mount(p);
    expect(root.querySelector('img, b')).toBeNull();
  });
});

describe('labs dialog', () => {
  it('start loads the lab plan; grading shows per-check results and the score', () => {
    let current = project(); let active = '';
    const root = div();
    const ui = mountLabs({ root, getProject: () => current, getActive: () => active, onStart: (lab) => { active = lab.id; current = lab.build(); } });
    const check = btn(root, /Check my work/);
    expect(check.disabled).toBe(true);
    expect(root.querySelectorAll('.lab-select option')).toHaveLength(LABS.length);
    btn(root, /Start lab/).click();
    expect(active).toBe('inter-vlan');
    expect(check.disabled).toBe(false);
    check.click();
    expect(root.querySelector('.lab-score').textContent).toBe('1/3 checks pass');
    expect(root.querySelector('.lab-results li.bad .lab-detail').textContent).toMatch(/unreachable/);
    current.settings.vlans[0].gateway = '10.0.10.1'; current.settings.vlans[1].gateway = '10.0.20.1'; current.floors[0].SWS[0].role = 'l3';
    expect(ui.check().passed).toBe(true);
    expect(root.querySelector('.lab-score').textContent).toBe('✓ Passed — 3/3');
  });
});

describe('remediation + live pull', () => {
  const model = () => planDeviceModel(project(), 'acc', { trunkIfaces: { core: 'sfp1' } });
  it('scripts exactly the fixes; applying them leaves no drift', () => {
    const m = model();
    const good = renderRouterOs(m);
    const drifted = good.replace('interface=ether3 pvid=20', 'interface=ether3 pvid=10').replace('vlan-ids=20 tagged=sfp1', 'vlan-ids=20 tagged=bridge1').replace(/add address=192\.168\.99\.3.*\n/, '').replace('set bridge1 vlan-filtering=yes', 'set bridge1 vlan-filtering=no');
    const actual = parseRouterOsExport(drifted);
    expect(diffAgainstPlan(m, actual).filter((f) => f.severity === 'error').length).toBeGreaterThanOrEqual(4);
    const fix = remediationScript(m, actual);
    expect(fix.text).toContain('set [find interface=ether3] pvid=20 frame-types=admit-only-untagged-and-priority-tagged');
    expect(fix.text).toContain('set [find vlan-ids=20] tagged=bridge1,sfp1');
    expect(fix.text).toContain('add address=192.168.99.3/24 interface=vlan99 comment="management"');
    expect(fix.text.trim().split('\n').at(-1)).toBe('/interface bridge set bridge1 vlan-filtering=yes');
    expect(fix.text).not.toMatch(/\bremove\b/);
    // Emulate the device applying it: `set [find …]` edits rewrite the matching line.
    let after = drifted.replace('interface=ether3 pvid=10', 'interface=ether3 pvid=20').replace('vlan-ids=20 tagged=bridge1', 'vlan-ids=20 tagged=bridge1,sfp1').replace('set bridge1 vlan-filtering=no', 'set bridge1 vlan-filtering=yes');
    after += '/ip address\nadd address=192.168.99.3/24 interface=vlan99\n';
    expect(diffAgainstPlan(m, parseRouterOsExport(after)).filter((f) => f.severity !== 'info')).toEqual([]);
  });
  it('a clean device needs nothing; grouped VLAN rows are left for a human', () => {
    const m = model();
    expect(remediationScript(m, parseRouterOsExport(renderRouterOs(m)))).toMatchObject({ changes: 0 });
    const grouped = renderRouterOs(m).replace(/add bridge=bridge1 vlan-ids=10 .*\n/, '').replace(/add bridge=bridge1 vlan-ids=20 .*\n/, 'add bridge=bridge1 vlan-ids=10,20 untagged=ether3\n');
    const fix = remediationScript(m, parseRouterOsExport(grouped));
    expect(fix.manual.join('\n')).toMatch(/VLAN 10 is part of a grouped bridge-vlan entry/);
  });
  it('pull argv: fixed read-only command, no prompts, unknown host keys refused, MikroTik only', () => {
    expect(PULL_COMMANDS).toEqual({ mikrotik: '/export' });
    expect(buildSshPullArgv({ host: '192.0.2.1', user: 'admin', key: '~/.ssh/id', vendor: 'mikrotik' }).argv.slice(-2)).toEqual(['admin@192.0.2.1', '/export']);
    const a = buildSshPullArgv({ host: '192.0.2.1', vendor: 'mikrotik' }).argv;
    expect(a.slice(0, 8)).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-T']);
    expect(buildSshPullArgv({ host: '192.0.2.1', vendor: 'cisco' }).ok).toBe(false);
    expect(buildSshPullArgv({ host: '192.0.2.1', vendor: 'constructor' }).ok).toBe(false);
    expect(buildSshPullArgv({ host: 'x; rm -rf /', vendor: 'mikrotik' }).ok).toBe(false);
    expect(buildSshPullArgv({ host: '192.0.2.1', vendor: 'mikrotik', command: 'reboot' }).argv.at(-1)).toBe('/export');
  });
  it('dialog: Pull from device fills the export and checks it; errors are shown', async () => {
    const p = project(); p.floors[0].SWS[1].trunkIfaces = { core: 'sfp1' };
    const good = renderRouterOs(planDeviceModel(p, 'acc', { trunkIfaces: { core: 'sfp1' } }));
    const onPull = vi.fn().mockResolvedValueOnce({ ok: true, text: good.replace('pvid=20', 'pvid=10') }).mockResolvedValueOnce({ ok: false, error: 'not reachable' }).mockResolvedValueOnce(null);
    const root = div();
    mountDeviceConfig({ root, getProject: () => p, switchId: 'acc', onPull, onDownload: vi.fn() });
    const pull = btn(root, /Pull from device/);
    pull.click(); await vi.waitFor(() => expect(root.querySelector('.dc-drift-list')).not.toBeNull());
    expect(onPull.mock.calls[0][0].id).toBe('acc');
    expect(root.querySelector('.dc-drift-list').textContent).toMatch(/ether3 \(NVR\): on VLAN 10, plan says VLAN 20/);
    btn(root, /Remediation script/).click();
    expect(root.querySelector('.dc-fix-script').value).toContain('set [find interface=ether3] pvid=20');
    pull.click(); await vi.waitFor(() => expect(root.querySelector('.dc-drift').textContent).toMatch(/not reachable/));
    pull.click(); await vi.waitFor(() => expect(pull.disabled).toBe(false));
    expect(root.querySelector('.dc-drift').textContent).toBe('');
    const noPull = div(); mountDeviceConfig({ root: noPull, getProject: () => p, switchId: 'acc' });
    expect(btn(noPull, /Pull from device/)).toBeUndefined();
  });
});
