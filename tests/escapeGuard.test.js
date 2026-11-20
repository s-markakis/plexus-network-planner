// Ratchet against HTML injection in app.js. Every `${…}` that lands in markup
// must either go through esc() or be on the reviewed allowlist below (numbers,
// constants, pre-escaped fragments). A new raw interpolation of an object field
// or an attribute value fails this test — wrap it in esc(), or review it and
// add it to tests/escapeGuard.allow.json.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../files/app.js', import.meta.url), 'utf8');
const allow = JSON.parse(fs.readFileSync(new URL('./escapeGuard.allow.json', import.meta.url), 'utf8'));

// Raw (non-esc) interpolations on lines that contain markup.
export function rawInterpolations(text) {
  const fields = new Set();
  const attrs = new Set();
  for (const line of text.split('\n')) {
    if (!/<[a-zA-Z/]/.test(line)) continue;
    let m;
    const any = /\$\{([^{}]*)\}/g;
    while ((m = any.exec(line))) {
      const e = m[1].trim();
      if (/^esc\(/.test(e)) continue;
      // object.field access — the shape untrusted project data arrives in
      if (/\b[A-Za-z_][A-Za-z0-9_]*\.[a-zA-Z_]+/.test(e) && !/^(Math\.|esc\()/.test(e)) fields.add(e);
    }
    const attr = /[a-zA-Z-]+="\$\{([^{}]*)\}"/g;
    while ((m = attr.exec(line))) {
      const e = m[1].trim();
      if (!/^esc\(/.test(e)) attrs.add(e);
    }
  }
  return { fields: [...fields].sort(), attrs: [...attrs].sort() };
}

describe('app.js markup interpolations', () => {
  const found = rawInterpolations(src);
  it('no unreviewed raw object-field interpolation', () => {
    expect(found.fields.filter((e) => !allow.fields.includes(e))).toEqual([]);
  });
  it('no unreviewed raw attribute interpolation', () => {
    expect(found.attrs.filter((e) => !allow.attrs.includes(e))).toEqual([]);
  });
});

// Code moved out of app.js must stay under the same ratchet: every module in
// files/src is scanned, with its own reviewed allowlist (allow.modules[file]).
describe('files/src markup interpolations', () => {
  const dir = new URL('../files/src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('._'));
  it('scans every module', () => expect(files.length).toBeGreaterThan(40));
  for (const f of files) {
    it(`${f}: no unreviewed raw interpolation`, () => {
      const found = rawInterpolations(fs.readFileSync(new URL(f, dir), 'utf8'));
      const ok = (allow.modules && allow.modules[f]) || { fields: [], attrs: [] };
      expect({ fields: found.fields.filter((e) => !ok.fields.includes(e)), attrs: found.attrs.filter((e) => !ok.attrs.includes(e)) })
        .toEqual({ fields: [], attrs: [] });
    });
  }
});

describe('scanner self-test', () => {
  it('the scanner catches the patterns it exists for', () => {
    const bad = rawInterpolations('x=`<input value="${ap.name}"/><td>${dev.ip}</td><b>${esc(ap.name)}</b>`');
    expect(bad.fields).toEqual(['ap.name', 'dev.ip']);
    expect(bad.attrs).toEqual(['ap.name']);
  });
});
