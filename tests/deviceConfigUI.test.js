// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mountDeviceConfig } from '../files/src/deviceConfigUI.js';

const project = () => ({
  settings: { vlans: [{ id: '10', name: 'Staff', subnet: '192.168.10.0/24', gateway: '192.168.10.1' }, { id: '99', name: 'Mgmt', subnet: '192.168.99.0/24' }] },
  floors: [{ id: 'f',
    SWS: [{ id: 'core', name: 'Core', role: 'l3', ip: '192.168.99.2' }, { id: 'acc', name: 'Acc <1>', ip: '192.168.99.3', uplinkId: 'core' }],
    APS: [{ id: 'a1', name: 'AP-1', swId: 'acc', port: '2', vlan: '10', ip: '192.168.10.5' }], CAMS: [] }],
});
function mount(p, extra = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ui = mountDeviceConfig({ root, getProject: () => p, switchId: 'acc', ...extra });
  return { root, ui, q: (s) => root.querySelector(s) };
}
const change = (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); };

describe('device config dialog', () => {
  it('asks for the trunk interface instead of guessing, then stores it on the switch', () => {
    const p = project(); const onChange = vi.fn();
    const { q } = mount(p, { onChange });
    expect(q('.dc-script').value).toContain('# NOT CONFIGURED: trunk to Core');
    expect([...q('.dc-warnings').children].some((li) => /no interface assigned/.test(li.textContent))).toBe(true);
    change(q('.dc-trunk'), 'sfp-sfpplus1');
    expect(p.floors[0].SWS[1].trunkIfaces).toEqual({ core: 'sfp-sfpplus1' });
    expect(onChange).toHaveBeenCalled();
    expect(q('.dc-script').value).toContain('interface=sfp-sfpplus1 frame-types=admit-only-vlan-tagged');
    expect(q('.dc-trunk').value).toBe('sfp-sfpplus1');
  });
  it('downloads with a filesystem-safe name', () => {
    const onDownload = vi.fn();
    const { root } = mount(project(), { onDownload });
    [...root.querySelectorAll('button')].find((b) => /Download/.test(b.textContent)).click();
    expect(onDownload.mock.calls[0][0]).toBe('Acc_1_.rsc');
    expect(onDownload.mock.calls[0][1]).toContain('/interface bridge');
  });
  it('drift: clean when the device runs the generated config, findings when it does not', () => {
    const p = project(); p.floors[0].SWS[1].trunkIfaces = { core: 'ether1' };
    const { q, ui } = mount(p);
    expect(ui.checkDrift()).toEqual([]);
    expect(q('.dc-drift').textContent).toMatch(/Paste or upload/);
    q('.dc-actual').value = q('.dc-script').value;
    expect(ui.checkDrift()).toEqual([]);
    expect(q('.dc-drift-head').textContent).toMatch(/matches the plan/);
    q('.dc-actual').value = q('.dc-script').value.replace('pvid=10', 'pvid=30');
    const f = ui.checkDrift();
    expect(f[0]).toMatchObject({ severity: 'error', area: 'port' });
    expect(q('.dc-drift-head').className).toMatch(/bad/);
    q('.dc-actual').value = 'hello world';
    ui.checkDrift();
    expect(q('.dc-drift').textContent).toMatch(/does not look like a RouterOS/);
  });
  it('renders hostile names as text', () => {
    const p = project(); p.floors[0].SWS[0].name = '<img src=x onerror=alert(1)>';
    const { root } = mount(p);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.dc-trunks').textContent).toContain('<img src=x');
  });
});
