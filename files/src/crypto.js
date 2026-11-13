// Passphrase encryption for sensitive project data (device credentials).
// AES-256-GCM with a PBKDF2-SHA256-derived key. Uses the Web Crypto API, which
// is available both in the browser/Electron renderer and in Node 18+ (so the
// round-trip is unit-testable). No dependencies.

// OWASP-recommended floor for PBKDF2-SHA256 (2023+). Blobs written before the
// bump decrypt fine — decryptObject reads the iteration count from the blob.
const PBKDF2_ITERS = 600000;
const MAX_PBKDF2_ITERS = 10000000;

function bytesToB64(bytes) {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64ToBytes(str) {
  const s = atob(str);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt any JSON-serialisable value → a self-describing blob (safe to store
// in the project file). A fresh random salt + IV are used every call.
export async function encryptObject(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERS);
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITERS,
    salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(ct),
  };
}

// Decrypt a blob produced by encryptObject. Throws on a wrong passphrase or
// tampering (GCM auth failure) — callers should treat that as "stay locked".
export async function decryptObject(blob, passphrase) {
  if (!blob || !blob.ct || !blob.salt || !blob.iv) throw new Error('Not an encrypted blob');
  // The iteration count comes from the (untrusted) file: bound it so a crafted
  // blob can't hang the unlock prompt with a multi-billion-round KDF.
  const iter = blob.iter == null ? PBKDF2_ITERS : blob.iter;
  if (!Number.isInteger(iter) || iter < 1 || iter > MAX_PBKDF2_ITERS) throw new Error('Unsupported KDF parameters');
  const key = await deriveKey(passphrase, b64ToBytes(blob.salt), iter);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(blob.iv) }, key, b64ToBytes(blob.ct)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

// Does a value look like one of our encrypted blobs?
export function isEncryptedBlob(x) {
  return !!(x && typeof x === 'object' && x.alg === 'AES-GCM' && x.ct && x.salt && x.iv);
}
