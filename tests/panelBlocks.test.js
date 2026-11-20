import { describe, it, expect } from 'vitest';
import { portOptions, portControl, statusOptions, buildGroupedOptions, vlanDatalist, credsBlock, inventoryBlock } from '../files/src/panelBlocks.js';

describe('panel blocks', () => {
  it('port picker keeps a legacy or out-of-range value as a custom option', () => {
    expect(portOptions(4, 'SW1 Port 4')).toContain('<option value="SW1 Port 4" selected>SW1 Port 4 (custom)</option>');
    expect(portOptions(4, '9')).toContain('9 (custom)');
    expect(portOptions(4, '2')).toContain('<option value="2" selected>Port 2</option>');
    expect(portControl(null, '7', 'id="x"')).toBe('<input class="ep-in" type="number" min="1" value="7" placeholder="Port #" id="x"/>');
  });
  it('status falls back to planned; grouped options select Custom/Other for unknown models', () => {
    expect(statusOptions('bogus')).toContain('value="planned" selected');
    const g = buildGroupedOptions([{ label: 'U', models: ['U6 Pro', 'Custom/Other'] }], 'Mystery');
    expect(g).toContain('<option selected>Custom/Other</option>');
  });
  it('escapes plan values', () => {
    expect(vlanDatalist([{ id: '1"', name: '<b>' }])).toBe('<datalist id="vlan-list"><option value="1&quot;">&lt;b&gt;</option></datalist>');
    expect(vlanDatalist([])).toBe('');
    expect(credsBlock({ creds: { pass: 'a"<b' } })).toContain('value="a&quot;&lt;b"');
    expect(inventoryBlock({ serial: '<x>' }, 'ep', 'upd-ap')).toContain('value="&lt;x&gt;"');
  });
});
