// Node 18 has no global Web Crypto (it arrived in Node 19); the app's crypto
// code uses `crypto.subtle` like a browser does. Polyfill it once for every
// test file instead of in each one.
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = /** @type {any} */ (webcrypto);
