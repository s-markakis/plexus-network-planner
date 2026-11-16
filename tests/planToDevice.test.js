// Plan → device config (rosExport) and device → plan drift check (drift).
import { describe, it, expect } from 'vitest';
import { planDeviceModel, renderRouterOs, exportRouterOs } from '../files/src/rosExport.js';
import { parseRouterOsExport, diffAgainstPlan } from '../files/src/drift.js';

const project = () => ({
  settings: { vlans: [
    { id: '10', name: 'Staff', subnet: '192.168.10.0/24', gateway: '192.168.10.1' },
    { id: '20', name: 'Cameras', subnet: '192.168.20.0/24', gateway: '192.168.20.1' },
    { id: '99', name: 'Mgmt', subnet: '192.168.99.0/24', gateway: '192.168.99.1' },
  ] },
  floors: [{ id: 'f1',
    SWS: [
      { id: 'core', name: 'Core', model: 'MikroTik CRS326', role: 'l3', ip: '192.168.99.2', cli: { routes: [{ cidr: '0.0.0.0/0', via: '192.168.99.254' }] } },
      { id: 'acc', name: 'Access-1', model: 'MikroTik CRS112', role: 'switch', ip: '192.168.99.3', uplinkId: 'core' },
    ],
    APS: [{ id: 'a1', name: 'AP-Lobby', swId: 'acc', port: '2', vlan: '10', ip: '192.168.10.5' }],
    CAMS: [
      { id: 'c1', name: 'Cam-Door', swId: 'acc', port: '3', vlan: '20', ip: '192.168.20.5' },
      { id: 'c2', name: 'Cam-NoPort', swId: 'acc', vlan: '20', ip: '192.168.20.6' },
    ] }],
});

describe('planDeviceModel', () => {
  it('collects access ports, trunks, VLANs and management for an access switch', () => {
    const m = planDeviceModel(project(), 'acc', { trunkIfaces: { core: 'sfp-sfpplus1' } });
    expect(m.accessPorts.map((p) => [p.iface, p.vlan, p.name])).toEqual([['ether2', 10, 'AP-Lobby'], ['ether3', 20, 'Cam-Door']]);
    expect(m.trunks).toEqual([{ peerId: 'core', peerName: 'Core', role: 'uplink', iface: 'sfp-sfpplus1' }]);
    expect(m.vlans).toEqual([10, 20, 99]);
    expect(m.svis).toEqual([]);
    expect(m.mgmt).toEqual({ address: '192.168.99.3', prefix: 24, vlan: 99 });
    expect(m.warnings.some((w) => /Cam-NoPort.*no switch port/.test(w))).toBe(true);
  });
  it('the L3 core hosts every gateway and sees its downlink', () => {
    const m = planDeviceModel(project(), 'core', { trunkIfaces: { acc: 'ether24' } });
    expect(m.svis.map((s) => [s.vlan, s.address, s.prefix])).toEqual([[10, '192.168.10.1', 24], [20, '192.168.20.1', 24], [99, '192.168.99.1', 24]]);
    expect(m.trunks[0]).toMatchObject({ peerId: 'acc', role: 'downlink', iface: 'ether24' });
    expect(m.routes).toEqual([{ dst: '0.0.0.0/0', gateway: '192.168.99.254' }]);
  });
  it('never guesses a trunk port: unassigned trunks are reported, not configured', () => {
    const { model, text } = exportRouterOs(project(), 'acc');
    expect(model.trunks[0].iface).toBeNull();
    expect(model.warnings.some((w) => /trunk to Core: no interface assigned/.test(w))).toBe(true);
    expect(text).toContain('# NOT CONFIGURED: trunk to Core');
    expect(text).not.toMatch(/admit-only-vlan-tagged/);
  });
  it('returns null for an unknown switch and rejects hostile interface names', () => {
    expect(planDeviceModel(project(), 'nope')).toBeNull();
    const m = planDeviceModel(project(), 'acc', { trunkIfaces: { core: 'ether1 ; /system reset-configuration' } });
    expect(m.trunks[0].iface).toBeNull();
  });
});

describe('renderRouterOs', () => {
  const text = () => exportRouterOs(project(), 'acc', { trunkIfaces: { core: 'sfp-sfpplus1' } }).text;
  it('emits ports, VLAN table and addresses', () => {
    const t = text();
    expect(t).toContain('add bridge=bridge1 interface=ether2 pvid=10 frame-types=admit-only-untagged-and-priority-tagged comment="AP-Lobby"');
    expect(t).toContain('add bridge=bridge1 interface=sfp-sfpplus1 frame-types=admit-only-vlan-tagged comment="trunk to Core"');
    expect(t).toContain('add bridge=bridge1 vlan-ids=10 tagged=sfp-sfpplus1 untagged=ether2 comment="Staff"');
    expect(t).toContain('add bridge=bridge1 vlan-ids=99 tagged=bridge1,sfp-sfpplus1 comment="Mgmt"');
    expect(t).toContain('add name=vlan99 interface=bridge1 vlan-id=99');
    expect(t).toContain('add address=192.168.99.3/24 interface=vlan99 comment="management"');
  });
  it('creates the bridge with filtering off and enables it only as the last command', () => {
    const lines = text().trim().split('\n');
    expect(lines.find((l) => l.startsWith('add name=bridge1'))).toContain('vlan-filtering=no');
    expect(lines[lines.length - 1]).toBe('/interface bridge set bridge1 vlan-filtering=yes');
  });
  it('neutralises names that try to break out of a quoted string', () => {
    const p = project();
    p.floors[0].APS[0].name = 'x" ; /system reset-configuration ; "';
    p.floors[0].SWS[1].name = 'sw$(evil)[/file remove]';
    const t = exportRouterOs(p, 'acc', { trunkIfaces: { core: 'ether1' } }).text;
    for (const line of t.split('\n').filter((l) => !l.startsWith('#'))) {
      expect((line.match(/"/g) || []).length % 2).toBe(0);
      expect(line).not.toMatch(/[$\[\]]/);
    }
    expect(t).not.toMatch(/^\/system reset-configuration/m);
  });
});

describe('drift check', () => {
  const model = () => planDeviceModel(project(), 'acc', { trunkIfaces: { core: 'sfp-sfpplus1' } });
  it('a device configured from the generated script has no drift', () => {
    const m = model();
    expect(diffAgainstPlan(m, parseRouterOsExport(renderRouterOs(m)))).toEqual([]);
  });
  it('parses a real-style export: sections, continuations, quoted values', () => {
    const a = parseRouterOsExport([
      '# 2026-01-01 by RouterOS 7.16', '/interface bridge', 'add name=bridge1 vlan-filtering=yes',
      '/interface bridge port', 'add bridge=bridge1 comment="AP Lobby" frame-types=\\', '    admit-only-untagged-and-priority-tagged interface=ether2 pvid=10',
      '/interface bridge vlan', 'add bridge=bridge1 tagged=bridge1,sfp-sfpplus1 vlan-ids=10,20,98-99',
      '/ip address add address=192.168.99.3/24 interface=vlan99', '/system identity', 'set name="Access-1"',
    ].join('\n'));
    expect(a.filtering).toBe(true);
    expect(a.ports).toEqual([{ iface: 'ether2', pvid: 10, frameTypes: 'admit-only-untagged-and-priority-tagged', disabled: false }]);
    expect(a.vlanTable[0].ids).toEqual([10, 20, 98, 99]);
    expect(a.addresses).toEqual([{ address: '192.168.99.3/24', iface: 'vlan99' }]);
    expect(a.identity).toBe('Access-1');
  });
  it('flags a port on the wrong VLAN, a missing trunk VLAN and filtering off', () => {
    const m = model();
    const cfg = renderRouterOs(m)
      .replace('interface=ether3 pvid=20', 'interface=ether3 pvid=10')
      .replace('vlan-ids=20 tagged=sfp-sfpplus1', 'vlan-ids=20')
      .replace('vlan-filtering=yes', 'vlan-filtering=no');
    const d = diffAgainstPlan(m, parseRouterOsExport(cfg));
    const msgs = d.filter((x) => x.severity === 'error').map((x) => x.message).join('\n');
    expect(msgs).toMatch(/ether3 \(Cam-Door\): on VLAN 10, plan says VLAN 20/);
    expect(msgs).toMatch(/sfp-sfpplus1 \(trunk to Core\): VLAN 20 not tagged/);
    expect(msgs).toMatch(/VLAN filtering is not enabled/);
  });
  it('reports things on the device that the plan does not know', () => {
    const m = model();
    const cfg = renderRouterOs(m) + '/ip address\nadd address=10.9.9.1/24 interface=ether5\n/interface bridge port\nadd bridge=bridge1 interface=ether7 pvid=66\n';
    const d = diffAgainstPlan(m, parseRouterOsExport(cfg));
    expect(d.every((x) => x.severity === 'info')).toBe(true);
    expect(d.map((x) => x.message).join('\n')).toMatch(/10\.9\.9\.1\/24.*not in the plan[\s\S]*|ether7: on VLAN 66/);
    expect(d).toHaveLength(2);
  });
  it('survives garbage input', () => {
    expect(() => diffAgainstPlan(model(), parseRouterOsExport('\u0000\\\n/ip address add\n"unterminated'))).not.toThrow();
    expect(parseRouterOsExport(null).ports).toEqual([]);
  });
});
