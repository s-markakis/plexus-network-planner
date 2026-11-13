// Minimal ZIP writer + reader with zero dependencies. The writer is STORE
// only (no compression) — enough to bundle the handover pack and .esx
// exports; any unzip tool reads STORE entries. The reader handles STORE and
// DEFLATE (via the platform DecompressionStream) so real-world archives like
// Ekahau .esx files open too. Pure byte logic so it's unit-testable without
// the DOM.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const toBytes = (d) => (d instanceof Uint8Array ? d : enc.encode(String(d)));

// MS-DOS date/time pair used by the ZIP headers.
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

// files: [{name, data: string|Uint8Array}] → Uint8Array of a complete .zip.
// `when` stamps every entry (defaults to now); pass a fixed Date in tests.
export function zipStore(files, when = new Date()) {
  const { time, date } = dosDateTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = toBytes(f.data);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);        // local file header signature
    local.setUint16(4, 20, true);                // version needed
    local.setUint16(6, 0x0800, true);            // flags: UTF-8 names
    local.setUint16(8, 0, true);                 // method: STORE
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);      // compressed size (= raw for STORE)
    local.setUint32(22, data.length, true);      // uncompressed size
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);                // extra length
    locals.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);      // central directory signature
    central.setUint16(4, 20, true);              // version made by
    central.setUint16(6, 20, true);              // version needed
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);         // local header offset
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);           // end-of-central-directory
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);              // central directory offset

  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

// ── Reader ──────────────────────────────────────────────────────────────────

// Imported archives are untrusted: cap the inflated size of a single entry so a
// zip bomb fails fast instead of exhausting memory.
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel();
      throw new Error('Zip entry is too large when decompressed');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// Read a .zip: returns [{name, data: Uint8Array}]. Walks the central
// directory (found via the end-of-central-directory record scanned from the
// tail), so it tolerates leading junk and data descriptors. Supports STORE
// and DEFLATE entries; anything else throws.
/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<{name:string,data:Uint8Array}>>}
 */
export async function zipRead(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD signature scan from the end (comment can pad up to 64 KB).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory)');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = utf8.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    // Local header repeats name/extra lengths; the data follows them.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + csize);
    if (!name.endsWith('/')) {          // skip directory entries
      if (method === 0) out.push({ name, data: raw.slice() });
      else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
      else throw new Error(`Unsupported zip compression method ${method} for ${name}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
