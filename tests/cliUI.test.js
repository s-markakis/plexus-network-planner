// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mountCliConsole, pingSummary, guessVendor } from '../files/src/cliUI.js';
import { newConfig, makeSession } from '../files/src/cli.js';

describe('pingSummary / guessVendor (pure)', () => {
  it('summarises ping outcomes', () => {
    expect(pingSummary(null, '10.0.0.1')).toMatch(/no routed interface/);
    expect(pingSummary({ ok: true }, '10.0.0.1')).toMatch(/Reply from 10\.0\.0\.1/);
    expect(pingSummary({ ok: false, status: 'unreachable' }, '10.0.0.1')).toMatch(/unreachable/);
    expect(pingSummary({ ok: false, status: 'ttl-exceeded' }, '10.0.0.1')).toMatch(/TTL expired/);
  });
  it('guesses the dialect from the model, defaulting to Cisco', () => {
    expect(guessVendor('MikroTik CRS326')).toBe('mikrotik');
    expect(guessVendor('hAP ac2')).toBe('mikrotik');
    expect(guessVendor('USW-24-PoE')).toBe('cisco');
    expect(guessVendor('')).toBe('cisco');
  });
});

describe('mountCliConsole (DOM)', () => {
  function setup(device = { id: 'core', name: 'CORE', model: 'Catalyst 9300' }, project = { settings: { vlans: [] }, floors: [] }) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onConfigChange = vi.fn();
    const con = mountCliConsole({ root, getDevice: () => device, getProject: () => project, onConfigChange });
    const input = /** @type {HTMLInputElement} */ (root.querySelector('.cli-input'));
    const type = (line) => { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); };
    return { root, device, con, onConfigChange, input, type };
  }

  it('creates a running-config on the device and shows a prompt', () => {
    const { root, device } = setup();
    expect(device.cli).toBeTruthy();
    expect(root.querySelector('.cli-prompt').textContent).toBe('CORE>');
  });

  it('runs IOS commands and mutates the device config', () => {
    const { root, device, type, onConfigChange } = setup();
    ['enable', 'configure terminal', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0'].forEach(type);
    expect(device.cli.interfaces.Vlan10).toMatchObject({ ip: '10.0.10.1', prefix: 24, vlan: 10 });
    expect(root.querySelector('.cli-prompt').textContent).toBe('CORE(config-if)#');
    expect(onConfigChange).toHaveBeenCalled();
  });

  it('shows an error line for an invalid command', () => {
    const { root, type } = setup();
    type('frobnicate');
    expect(root.querySelector('.cli-err')).toBeTruthy();
    expect(root.textContent).toMatch(/Invalid input/);
  });

  it('echoes the command with its prompt', () => {
    const { root, type } = setup();
    type('enable');
    expect(root.querySelector('.cli-cmd').textContent).toMatch(/CORE>\s+enable/);
  });

  it('ArrowUp recalls the previous command', () => {
    const { input, type } = setup();
    type('enable');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input.value).toBe('enable');
  });

  it('switching dialect changes the prompt and config vendor', () => {
    const { root, device } = setup();
    const sel = /** @type {HTMLSelectElement} */ (root.querySelector('.cli-vendor'));
    sel.value = 'mikrotik';
    sel.dispatchEvent(new Event('change'));
    expect(device.cli.vendor).toBe('mikrotik');
    expect(root.querySelector('.cli-prompt').textContent).toMatch(/\[admin@/);
  });

  it('ping against a live plan: routes between VLANs once SVIs are configured', () => {
    const device = { id: 'core', name: 'CORE', model: 'Catalyst 9300' };
    const project = {
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{
        SWS: [device],
        APS: [{ id: 'a1', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }],
        CAMS: [{ id: 'c1', swId: 'core', port: '2', vlan: '20', ip: '10.0.20.5' }],
      }],
    };
    const { root, type } = setup(device, project);
    ['enable', 'configure terminal',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit',
      'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'end',
      'ping 10.0.20.5'].forEach(type);
    expect(root.textContent).toMatch(/Reply from 10\.0\.20\.5/);
  });

  it('ping resolves a device name via DNS and shows the IP', () => {
    const device = { id: 'core', name: 'CORE', model: 'Catalyst 9300' };
    const project = {
      settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
      floors: [{
        SWS: [device],
        APS: [{ id: 'a1', name: 'AP-01', swId: 'core', port: '1', vlan: '10', ip: '10.0.10.5' }],
        CAMS: [{ id: 'c1', name: 'CAM-01', swId: 'core', port: '2', vlan: '20', ip: '10.0.20.5' }],
      }],
    };
    const { root, type } = setup(device, project);
    ['enable', 'configure terminal',
      'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit',
      'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'end',
      'ping CAM-01'].forEach(type);
    expect(root.textContent).toMatch(/Reply from CAM-01 \[10\.0\.20\.5\]/);
  });

  it('ping an unknown name reports it cannot resolve', () => {
    const device = { id: 'core', name: 'CORE', model: 'Catalyst 9300' };
    const project = { settings: { vlans: [] }, floors: [{ SWS: [device], APS: [], CAMS: [] }] };
    const { root, type } = setup(device, project);
    ['enable', 'ping nonexistent-host'].forEach(type);
    expect(root.textContent).toMatch(/can't resolve host nonexistent-host/);
  });

  it('ping from a switch with no routed interface reports no source', () => {
    const device = { id: 'sw', name: 'SW', model: 'USW-24' };
    const project = { settings: { vlans: [] }, floors: [{ SWS: [device], APS: [], CAMS: [] }] };
    const { root, type } = setup(device, project);
    ['enable', 'ping 10.0.0.1'].forEach(type);
    expect(root.textContent).toMatch(/no routed interface/);
  });
});

describe('show ip ospf neighbor in the console', () => {
  function ospfProject() {
    const cfg = (lines, name) => { const s = makeSession(newConfig({ vendor: 'cisco', hostname: name })); lines.forEach((l) => s.exec(l)); return s.config; };
    const a = cfg(['en', 'conf t', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit', 'interface eth5', 'ip address 10.0.99.1 255.255.255.252', 'exit', 'router ospf 1', 'end'], 'SITE-A');
    const b = cfg(['en', 'conf t', 'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'exit', 'interface eth5', 'ip address 10.0.99.2 255.255.255.252', 'exit', 'router ospf 1', 'end'], 'SITE-B');
    const siteA = { id: 'siteA', name: 'SITE-A', cli: a };
    return {
      device: siteA,
      project: {
        settings: { vlans: [{ id: '10', subnet: '10.0.10.0/24' }, { id: '20', subnet: '10.0.20.0/24' }] },
        floors: [{ SWS: [siteA, { id: 'siteB', name: 'SITE-B', cli: b, uplinkId: 'siteA', uplinkMode: 'routed' }], APS: [], CAMS: [] }],
      },
    };
  }

  it('lists the OSPF peer', () => {
    const { device, project } = ospfProject();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountCliConsole({ root, getDevice: () => device, getProject: () => project, onConfigChange() {} });
    const input = /** @type {HTMLInputElement} */ (root.querySelector('.cli-input'));
    const type = (l) => { input.value = l; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); };
    ['enable', 'show ip ospf neighbor'].forEach(type);
    expect(root.textContent).toMatch(/r:siteB/);
    expect(root.textContent).toMatch(/10\.0\.99\.2/);
  });
});
