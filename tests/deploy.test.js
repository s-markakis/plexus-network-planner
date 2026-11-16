import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildRosconfArgv, writeScript, loadRosconfPath, saveRosconfPath, commandLine } = require('../electron/deploy.cjs');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-deploy-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const ROS = '/opt/tools/rosconf';
const FILE = '/tmp/x/core.rsc';

describe('rosconf argv', () => {
  it('builds a dry-run apply — never with --apply', () => {
    const r = buildRosconfArgv({ rosconf: ROS, target: { host: '192.0.2.1', user: 'admin', port: 2222, key: '/home/u/.ssh/id' }, file: FILE });
    expect(r).toEqual({ ok: true, argv: [ROS, 'apply', '192.0.2.1', '-u', 'admin', '-p', '2222', '-i', '/home/u/.ssh/id', '-f', FILE] });
    for (const t of [{ host: 'sw1' }, { host: 'sw1', user: 'a', port: 22 }, { host: '10.0.0.1', key: '~/.ssh/k' }]) {
      const a = buildRosconfArgv({ rosconf: ROS, target: t, file: FILE });
      expect(a.ok).toBe(true);
      expect(a.argv).not.toContain('--apply');
    }
  });

  it('runs a .py through python3 and omits defaults', () => {
    const r = buildRosconfArgv({ rosconf: '/x/rosconf.py', target: { host: 'sw1', port: 22 }, file: FILE });
    expect(r.argv).toEqual(['python3', '/x/rosconf.py', 'apply', 'sw1', '-f', FILE]);
  });

  it('rejects hostile targets from a project file', () => {
    for (const target of [
      { host: '--apply' }, { host: '-oProxyCommand=id' }, { host: 'a b' }, { host: 'h;rm -rf ~' }, { host: '' },
      { host: 'sw1', user: '--apply' }, { host: 'sw1', user: 'a b' }, { host: 'sw1', key: '$(id)' }, { host: 'sw1', port: '22;id' },
    ]) {
      const r = buildRosconfArgv({ rosconf: ROS, target, file: FILE });
      expect(r.ok, JSON.stringify(target)).toBe(false);
    }
  });

  it('needs an absolute rosconf and script path', () => {
    expect(buildRosconfArgv({ rosconf: 'rosconf', target: { host: 'sw1' }, file: FILE }).ok).toBe(false);
    expect(buildRosconfArgv({ rosconf: ROS, target: { host: 'sw1' }, file: 'core.rsc' }).ok).toBe(false);
    expect(buildRosconfArgv({ rosconf: undefined, target: { host: 'sw1' }, file: FILE }).ok).toBe(false);
  });

  it('command line quoting survives spaces and quotes', () => {
    expect(commandLine(['python3', "/Users/a b/it's/rosconf.py", 'apply', 'sw1'])).toBe("python3 '/Users/a b/it'\\''s/rosconf.py' apply sw1");
  });
});

describe('script file', () => {
  it('writes inside the given directory, private, with a sanitized name', () => {
    const out = path.join(dir, 'deploy');
    const f = writeScript(out, '../../etc/cron.d/evil name.rsc', '/system identity set name=x\n', new Date('2026-11-15T10:20:30Z'));
    expect(path.dirname(f)).toBe(out);
    expect(path.basename(f)).toBe('etc_cron.d_evil_name-20261115T102030.rsc');
    expect(fs.readFileSync(f, 'utf8')).toBe('/system identity set name=x\n');
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o077).toBe(0);
  });

  it('refuses empty, oversized and NUL-carrying scripts', () => {
    expect(() => writeScript(dir, 'a', '   ')).toThrow();
    expect(() => writeScript(dir, 'a', 'x'.repeat(2 * 1024 * 1024 + 1))).toThrow();
    expect(() => writeScript(dir, 'a', '/ip\u0000 address')).toThrow();
    expect(() => writeScript(dir, 'a', /** @type {any} */ (null))).toThrow();
  });
});

describe('rosconf location store', () => {
  it('round-trips an existing file and rejects junk', () => {
    const store = path.join(dir, 'cfg', 'rosconf.json');
    const exe = path.join(dir, 'rosconf.py'); fs.writeFileSync(exe, '#!/usr/bin/env python3\n');
    expect(loadRosconfPath(store)).toBe(null);
    saveRosconfPath(store, exe);
    expect(loadRosconfPath(store)).toBe(exe);
    saveRosconfPath(store, path.join(dir, 'missing'));
    expect(loadRosconfPath(store)).toBe(null);
    fs.writeFileSync(store, JSON.stringify({ path: 'relative/rosconf' }));
    expect(loadRosconfPath(store)).toBe(null);
  });
});
