import { describe, it, expect } from 'vitest';
import { createCredsSession } from '../files/src/credsSession.js';
import { encryptObject } from '../files/src/crypto.js';

const creds = (pass) => ({ proto: 'ssh', host: '', port: '', user: 'admin', pass, key: '' });
const floors = () => [{ id: 'f1', APS: [{ id: 'ap1' }, { id: 'ap2' }], CAMS: [], SWS: [] }];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('creds session', () => {
  it('a locked vault is written back untouched on save', async () => {
    const vault = await encryptObject({ ap1: creds('s3cret') }, 'right');
    const fl = floors();
    const s = createCredsSession({ getFloors: () => fl });
    s.lock(vault);
    const data = { floors: fl, revisions: [] };
    await s.sealInto(data);
    expect(data.credsVault).toBe(vault);
  });

  it('wrong passphrase stays locked; right one unlocks and remembers it', async () => {
    const vault = await encryptObject({ ap1: creds('s3cret') }, 'right');
    const fl = floors();
    const s = createCredsSession({ getFloors: () => fl });
    s.lock(vault);
    expect(await s.tryUnlock('wrong')).toBe(false);
    expect(s.locked).toBe(vault); expect(s.pass).toBe('');
    expect(await s.tryUnlock('right')).toBe(true);
    expect(s.locked).toBe(null); expect(s.pass).toBe('right');
    expect(fl[0].APS[0].creds.pass).toBe('s3cret');
  });

  it('credentials entered while locked win over the vault copy on unlock', async () => {
    const vault = await encryptObject({ ap1: creds('old'), ap2: creds('vault-only') }, 'right');
    const fl = floors();
    fl[0].APS[0].creds = creds('newer');
    const s = createCredsSession({ getFloors: () => fl });
    s.lock(vault);
    await s.tryUnlock('right');
    expect(fl[0].APS[0].creds.pass).toBe('newer');
    expect(fl[0].APS[1].creds.pass).toBe('vault-only');
  });

  it('setPass is ignored while a vault is locked', () => {
    const s = createCredsSession({ getFloors: floors });
    s.lock({ ct: 'x' });
    s.setPass('other');
    expect(s.pass).toBe('');
  });

  it('unlocked + passphrase: save seals creds and leaves no plaintext', async () => {
    const fl = floors(); fl[0].APS[0].creds = creds('s3cret');
    const s = createCredsSession({ getFloors: () => fl });
    s.setPass('pw');
    const data = { floors: fl, revisions: [] };
    await s.sealInto(data);
    expect(data.credsVault).toBeTruthy();
    expect(JSON.stringify(data.floors)).not.toContain('s3cret');
    expect(fl[0].APS[0].creds.pass).toBe('s3cret');     // the live plan is not mutated
  });

  it('no passphrase: creds stay inline (the explicit plaintext mode)', async () => {
    const fl = floors(); fl[0].APS[0].creds = creds('s3cret');
    const s = createCredsSession({ getFloors: () => fl });
    const data = { floors: fl, revisions: [] };
    await s.sealInto(data);
    expect(data.credsVault).toBeUndefined();
    expect(s.autosaveVault()).toBeUndefined();
  });

  it('autosave vault: built once per change, announced when ready', async () => {
    const fl = floors(); fl[0].APS[0].creds = creds('s3cret');
    let calls = 0; let ready = 0;
    const s = createCredsSession({
      getFloors: () => fl, onVaultReady: () => ready++,
      encrypt: async (map, p) => { calls++; return { fake: true, n: calls, p, ids: Object.keys(map) }; },
    });
    s.setPass('pw');
    expect(s.autosaveVault()).toBeUndefined();          // first build still running
    await tick();
    expect(ready).toBe(1);
    expect(s.autosaveVault()).toMatchObject({ n: 1, p: 'pw', ids: ['ap1'] });
    s.autosaveVault(); s.autosaveVault(); await tick();
    expect(calls).toBe(1);                              // unchanged → no rebuild
    fl[0].APS[1].creds = creds('two');
    expect(s.autosaveVault()).toMatchObject({ n: 1 });  // stale but encrypted meanwhile
    await tick();
    expect(s.autosaveVault()).toMatchObject({ n: 2, ids: ['ap1', 'ap2'] });
  });

  it('autosave uses the locked vault as is, and reset forgets everything', async () => {
    const s = createCredsSession({ getFloors: floors, encrypt: async () => ({ fake: true }) });
    const vault = { ct: 'x' };
    s.lock(vault);
    expect(s.autosaveVault()).toBe(vault);
    s.reset();
    expect(s.locked).toBe(null); expect(s.pass).toBe(''); expect(s.autosaveVault()).toBeUndefined();
  });
});
