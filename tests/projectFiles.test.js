import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createProjectFiles, MAX_RECENTS } = require('../electron/projectFiles.cjs');

let dir; let recentsFile;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-pf-')); recentsFile = path.join(dir, 'app', 'recent.json'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const make = (extra = {}) => createProjectFiles({ recentsFile, ...extra });
const write = (name, text = '{"floors":[]}') => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

describe('project files gate', () => {
  it('refuses to save to a path the user never chose', () => {
    const pf = make();
    const victim = write('victim.txt', 'keep me');
    const res = pf.save(victim, 'pwned');
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
  });

  it('refuses to read a path that is not in the recents list', () => {
    const pf = make();
    const secret = write('id_ed25519', 'PRIVATE');
    const res = pf.openRecent(secret);
    expect(res.ok).toBe(false);
    expect(/** @type {any} */ (res).text).toBeUndefined();
  });

  it('a recents file cannot smuggle in relative or non-string entries', () => {
    fs.mkdirSync(path.dirname(recentsFile), { recursive: true });
    const good = write('good.json');
    fs.writeFileSync(recentsFile, JSON.stringify(['../../etc/passwd', 42, null, good]));
    expect(make().recents().map((r) => r.path)).toEqual([good]);
  });

  it('open → save round-trips, and Save As grants the new path', () => {
    const pf = make();
    const f = write('plan.json', 'v1');
    const opened = pf.openPicked(f);
    expect(opened).toMatchObject({ ok: true, name: 'plan.json', text: 'v1' });
    expect(pf.save(f, 'v2').ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('v2');
    const copy = path.join(dir, 'copy.json');
    expect(pf.saveAsPicked(copy, 'v3')).toMatchObject({ ok: true, name: 'copy.json' });
    expect(pf.save(copy, 'v4').ok).toBe(true);
    expect(fs.readFileSync(copy, 'utf8')).toBe('v4');
  });

  it('a cancelled dialog is reported as cancelled, not as an error', () => {
    const pf = make();
    expect(pf.openPicked(undefined)).toEqual({ ok: false, cancelled: true });
    expect(pf.saveAsPicked(undefined, 'x')).toEqual({ ok: false, cancelled: true });
  });

  it('saving leaves no temp file behind and never truncates on failure', () => {
    const pf = make();
    const f = write('plan.json', 'good');
    pf.openPicked(f);
    pf.save(f, 'better');
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]);
    // A target whose directory vanished: the write fails and reports it.
    const gone = path.join(dir, 'gone', 'x.json');
    expect(pf.saveAsPicked(gone, 'x').ok).toBe(false);
  });

  it('recents: most recent first, de-duplicated, capped, persisted, pruned', () => {
    const changes = [];
    const pf = make({ onRecentsChanged: (l) => changes.push(l.length) });
    const files = Array.from({ length: MAX_RECENTS + 3 }, (_, i) => write(`p${i}.json`));
    for (const f of files) pf.openPicked(f);
    pf.openPicked(files[5]);
    const list = pf.recents().map((r) => r.name);
    expect(list.length).toBe(MAX_RECENTS);
    expect(list[0]).toBe('p5.json');
    expect(new Set(list).size).toBe(list.length);
    expect(changes.length).toBeGreaterThan(0);
    // A second instance reads the same list; a deleted file drops out.
    fs.rmSync(files[5]);
    const again = make();
    expect(again.recents().map((r) => r.name)).not.toContain('p5.json');
    expect(again.openRecent(files[5]).ok).toBe(false);
    expect(again.openRecent(files[12])).toMatchObject({ ok: true, name: 'p12.json' });
  });

  it('rejects a directory and an oversized target cleanly', () => {
    const pf = make();
    expect(pf.openPicked(dir).ok).toBe(false);
    expect(pf.save(path.join(dir, 'never-chosen.json'), 'x').ok).toBe(false);
  });
});

describe('saved file permissions', () => {
  it.skipIf(process.platform === 'win32')('writes projects owner-only (they can hold credentials)', () => {
    const pf = make();
    const target = path.join(dir, 'site.json');
    expect(pf.saveAsPicked(target, '{"floors":[]}').ok).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    fs.chmodSync(target, 0o644);
    expect(pf.save(target, '{"floors":[1]}').ok).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});
