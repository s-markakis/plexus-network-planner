import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// The validator is CommonJS (shared with the Electron main process); load it as-is.
const { buildSshArgv } = require('../electron/sshArgv.cjs');

describe('buildSshArgv — valid targets', () => {
  it('builds host-only when no user/key/port', () => {
    expect(buildSshArgv({ host: '192.0.2.10' })).toEqual({ ok: true, argv: ['ssh', '192.0.2.10'] });
  });
  it('builds user@host with a non-default port', () => {
    expect(buildSshArgv({ host: '10.0.0.1', user: 'admin', port: '2222' }))
      .toEqual({ ok: true, argv: ['ssh', '-p', '2222', 'admin@10.0.0.1'] });
  });
  it('omits -p for port 22 and for a blank port', () => {
    expect(buildSshArgv({ host: 'h', user: 'a', port: 22 }).argv).toEqual(['ssh', 'a@h']);
    expect(buildSshArgv({ host: 'h', user: 'a', port: '' }).argv).toEqual(['ssh', 'a@h']);
  });
  it('expands a leading ~ in the key to the real home dir', () => {
    const r = buildSshArgv({ host: '192.0.2.10', user: 'admin', key: '~/.ssh/id_ed25519' });
    expect(r.ok).toBe(true);
    expect(r.argv).toEqual(['ssh', '-i', `${os.homedir()}/.ssh/id_ed25519`, 'admin@192.0.2.10']);
  });
  it('accepts an absolute key path unchanged', () => {
    expect(buildSshArgv({ host: 'h', key: '/etc/keys/id' }).argv).toEqual(['ssh', '-i', '/etc/keys/id', 'h']);
  });
});

describe('buildSshArgv — fail closed on hostile input', () => {
  it('rejects a host with shell metacharacters', () => {
    for (const host of ['h";do shell script "x', '1.2.3.4 evil', 'a;b', 'a$(id)', 'a|b', 'a`id`', 'a&b', "a'b"]) {
      expect(buildSshArgv({ host }), host).toMatchObject({ ok: false });
    }
  });
  it('rejects a missing host', () => {
    expect(buildSshArgv({})).toMatchObject({ ok: false, error: 'Invalid SSH host' });
    expect(buildSshArgv({ host: '' })).toMatchObject({ ok: false });
  });
  it('rejects a username with metacharacters', () => {
    expect(buildSshArgv({ host: 'h', user: 'a;b' })).toMatchObject({ ok: false, error: 'Invalid username' });
    expect(buildSshArgv({ host: 'h', user: 'a b' })).toMatchObject({ ok: false });
    expect(buildSshArgv({ host: 'h', user: 'a`id`' })).toMatchObject({ ok: false });
  });
  it('rejects a key path with metacharacters or spaces', () => {
    expect(buildSshArgv({ host: 'h', key: '/k;rm -rf' })).toMatchObject({ ok: false, error: 'Invalid key path' });
    expect(buildSshArgv({ host: 'h', key: '/my key' })).toMatchObject({ ok: false });
  });
  it('rejects an out-of-range or non-integer port', () => {
    expect(buildSshArgv({ host: 'h', port: 0 })).toMatchObject({ ok: false, error: 'Invalid port' });
    expect(buildSshArgv({ host: 'h', port: 70000 })).toMatchObject({ ok: false });
    expect(buildSshArgv({ host: 'h', port: '22; rm' })).toMatchObject({ ok: false });
  });
});
