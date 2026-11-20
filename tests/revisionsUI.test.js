// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { revisionsEl } from '../files/src/revisionsUI.js';

const revs = [{ id: 'r1', name: 'A', createdAt: '2026-01-01T00:00:00Z', snapshot: [] }, { id: 'r2', name: 'B', createdAt: '2026-01-02T00:00:00Z', snapshot: [] }];
const make = (over = {}) => revisionsEl(document, { revisions: revs, locale: 'en-GB', diffVsNow: () => ['x'], diffLastTwo: () => ['~ moved'],
  onToggleBaseline: vi.fn(), onRestore: vi.fn(), onDelete: vi.fn(), onNew: vi.fn(), ...over });
const btn = (el, t) => [...el.querySelectorAll('button')].find((b) => b.textContent === t);

describe('revisions dialog', () => {
  it('shows one labelled diff at a time', () => {
    const el = make();
    btn(el, 'Diff last two revisions').click();
    btn(el, 'Diff last two revisions').click();
    btn(el, 'Diff vs now').click();
    btn(el, 'Diff last two revisions').click();
    const pres = el.querySelectorAll('pre');
    expect(pres).toHaveLength(1);
    expect(pres[0].textContent).toBe('A → B\n\n~ moved');
  });
  it('delete needs a second click', () => {
    const onDelete = vi.fn();
    const el = make({ onDelete });
    const x = /** @type {HTMLButtonElement} */ (el.querySelector('.btn.danger'));
    x.click();
    expect(onDelete).not.toHaveBeenCalled();
    expect(x.textContent).toBe('Delete?');
    x.click();
    expect(onDelete).toHaveBeenCalledWith(revs[0]);
  });
});
