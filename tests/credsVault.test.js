import { describe, it, expect } from 'vitest';
import { collectCreds, stripCredsReplacer, withoutCreds, attachCreds, hasPlaintextPasswords, sealCreds, openVault } from '../files/src/credsVault.js';

const SECRET = 'S3cret-Device-Pass';
const creds = () => ({ proto: 'ssh', host: '', port: '', user: 'admin', pass: SECRET, key: '' });
const floors = () => [{ id: 'f', APS: [{ id: 'a1', name: 'AP', creds: creds(), _cache: 'x' }], SWS: [{ id: 's1', name: 'SW' }], CAMS: [{ id: 'c1', creds: { user: 'cam', pass: '' } }] }];

describe('credsVault', () => {
  it('collects creds by device id and detects plaintext passwords', () => {
    expect(Object.keys(collectCreds(floors()))).toEqual(['a1', 'c1']);
    expect(hasPlaintextPasswords(floors())).toBe(true);
    expect(hasPlaintextPasswords([{ CAMS: [{ id: 'c1', creds: { user: 'cam', pass: '' } }] }])).toBe(false);
    expect(collectCreds(null)).toEqual({});
  });
  it('revision snapshots carry neither creds nor caches', () => {
    const snap = JSON.stringify(floors(), stripCredsReplacer);
    expect(snap).not.toContain(SECRET);
    expect(snap).not.toContain('creds');
    expect(snap).not.toContain('_cache');
  });
  it('sealing leaves no plaintext anywhere — floors or legacy revision snapshots', async () => {
    const live = floors();
    const liveRevs = [{ id: 'r1', name: 'legacy', snapshot: floors() }];
    const data = { floors: live, revisions: liveRevs };
    expect(await sealCreds(data, 'vault-pass')).toBe(true);
    const text = JSON.stringify(data);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('"creds"');
    expect(data.credsVault.alg).toBe('AES-GCM');
    // the live plan and live revisions were not touched
    expect(live[0].APS[0].creds.pass).toBe(SECRET);
    expect(liveRevs[0].snapshot[0].APS[0].creds.pass).toBe(SECRET);
    expect(data.floors).not.toBe(live);
  });
  it('round-trips through the vault and reattaches by id', async () => {
    const data = { floors: floors(), revisions: [] };
    await sealCreds(data, 'vault-pass');
    const map = await openVault(data.credsVault, 'vault-pass');
    expect(attachCreds(data.floors, map)).toBe(2);
    expect(data.floors[0].APS[0].creds.pass).toBe(SECRET);
    await expect(openVault(data.credsVault, 'wrong')).rejects.toThrow();
  });
  it('without a passphrase nothing changes (plaintext mode is explicit)', async () => {
    const data = { floors: floors(), revisions: [] };
    expect(await sealCreds(data, '')).toBe(false);
    expect(data.credsVault).toBeUndefined();
    expect(data.floors[0].APS[0].creds.pass).toBe(SECRET);
  });
  it('attachCreds can keep existing creds and ignores prototype keys', () => {
    const f = [{ APS: [{ id: 'a1', creds: { user: 'keep' } }, { id: 'toString' }, { id: 'a2' }] }];
    expect(attachCreds(f, { a1: { user: 'new' }, a2: { user: 'two' } }, { overwrite: false })).toBe(1);
    expect(f[0].APS[0].creds.user).toBe('keep');
    expect(f[0].APS[1].creds).toBeUndefined();
    expect(withoutCreds(f)[0].APS[0]).toEqual({ id: 'a1' });
  });
});
