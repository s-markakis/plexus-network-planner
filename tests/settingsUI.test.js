// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { settingsForm } from '../files/src/settingsUI.js';

const make = (over = {}) => settingsForm(document, { settings: { company: '<img src=x onerror=alert(1)>', coverageOpacity: 70 }, vlans: [{ id: '10', name: 'Corp', subnet: '10.0.10.0/24' }],
  credsPass: '', langs: ['en', 'el'], onOpacityPreview: vi.fn(), ...over });

describe('settings form', () => {
  it('is paned into sections and keeps hostile values inert', () => {
    const { el } = make();
    expect(el.classList.contains('paned')).toBe(true);
    expect(el.querySelectorAll('.settings-nav-item').length).toBeGreaterThan(5);
    expect(el.querySelector('img')).toBeNull();
  });
  it('reads back VLAN rows (blank rows dropped), opacity and passphrase', () => {
    const preview = vi.fn();
    const f = make({ onOpacityPreview: preview });
    const add = [...f.el.querySelectorAll('button')].find((b) => b.textContent === '+ Add VLAN');
    add.click(); add.click();
    const rows = [...f.el.querySelectorAll('.ep-row')].filter((r) => r.querySelector('input[type=color]'));
    /** @type {any} */ (rows[1].querySelector('input')).value = ' 20 ';
    const rng = /** @type {HTMLInputElement} */ (f.el.querySelector('input[type=range]'));
    rng.value = '40'; rng.dispatchEvent(new Event('input'));
    const r = f.read();
    expect(r.vlans.map((v) => v.id)).toEqual(['10', '20']);
    expect(r.opacity).toBe(40);
    expect(preview).toHaveBeenCalledWith(40);
    expect(r.inputs.company.value).toBe('<img src=x onerror=alert(1)>');
  });
});
