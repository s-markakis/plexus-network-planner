// The credential state of the open project, in one place:
//   - `pass`    the passphrase the user set or unlocked with (session only);
//   - `locked`  an encrypted vault from the loaded file that has NOT been
//               unlocked (prompt cancelled / wrong passphrase). It is written
//               back untouched on save — dropping it lost the credentials;
//   - an encrypted copy for the autosave, rebuilt off-tick only when the creds
//     or passphrase change (PBKDF2 is slow), so the autosave never holds
//     plaintext yet a restored session can still unlock them.
// Pure apart from Web Crypto (injected for tests).

import { collectCreds, attachCreds, sealCreds, openVault } from './credsVault.js';
import { encryptObject } from './crypto.js';

/**
 * @param {{getFloors:()=>any[], onVaultReady?:()=>void,
 *          encrypt?:(obj:any,pass:string)=>Promise<any>,
 *          open?:(vault:any,pass:string)=>Promise<any>}} opts
 */
export function createCredsSession({ getFloors, onVaultReady = () => {}, encrypt = encryptObject, open = openVault }) {
  let pass = '';
  /** @type {any} */ let locked = null;
  /** @type {any} */ let autoVault = null;
  let autoSig = '';
  let busy = false;

  return {
    get pass() { return pass; },
    get locked() { return locked; },
    // Setting a passphrase is only meaningful when nothing is locked: a locked
    // vault has its own passphrase and must be opened with tryUnlock().
    setPass(p) { if (!locked) pass = p || ''; },
    lock(vault) { locked = vault || null; },
    reset() { pass = ''; locked = null; autoVault = null; autoSig = ''; },

    // Try a passphrase on the locked vault. On success its creds are reattached
    // (devices given credentials while it was locked keep the newer ones) and
    // the passphrase is remembered so the next save stays encrypted.
    async tryUnlock(p) {
      if (!locked) return true;
      let map;
      try { map = await open(locked, p); } catch { return false; }
      locked = null; pass = p;
      attachCreds(getFloors(), map, { overwrite: false });
      return true;
    },

    // Prepare an export object for saving. A locked vault can't be merged
    // without its passphrase, so it is written back as it was; otherwise creds
    // are sealed with the current passphrase (no passphrase → left inline).
    async sealInto(data) {
      if (locked) { data.credsVault = locked; return; }
      await sealCreds(data, pass);
    },

    // The vault to store in the autosave right now (undefined → none). May be
    // one refresh behind: the stale copy is still encrypted, and onVaultReady()
    // fires when the fresh one lands so the owner can save again.
    autosaveVault() {
      if (locked) return locked;
      if (!pass) return undefined;
      const map = collectCreds(getFloors());
      const sig = pass + '\u0000' + JSON.stringify(map);
      if (sig !== autoSig && !busy) {
        busy = true;
        const p = pass;
        (Object.keys(map).length ? encrypt(map, p) : Promise.resolve(null))
          .then((v) => { autoVault = v; autoSig = sig; })
          .catch(() => {})
          .finally(() => { busy = false; onVaultReady(); });
      }
      return autoVault || undefined;
    },
  };
}
