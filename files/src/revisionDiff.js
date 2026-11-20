// Revision diff: what changed between two snapshots of the plan's floors.
// Pure (moved out of app.js).

const KINDS = ['APS', 'CAMS', 'SWS', 'DZS', 'WALLS'];
// Identity, wiring and rollout fields — the as-designed vs as-built story,
// not geometry. txPowerDbm/chanWidth are what Auto-power/Auto-channel change.
const FIELDS = ['name', 'model', 'ip', 'vlan', 'port', 'swId', 'status', 'serial', 'channel', 'chanWidth', 'txPower', 'txPowerDbm', 'resolution'];

// Pair floors by id, so deleting or reordering a floor doesn't make every
// later floor look rewritten. Floors without a usable id fall back to position.
function pairFloors(a, b) {
  const idsOk = (list) => {
    const ids = list.map((f) => f && f.id);
    return ids.every((x) => typeof x === 'string' && x) && new Set(ids).size === ids.length;
  };
  /** @type {Array<[any, any, number]>} */
  const pairs = [];
  if (idsOk(a) && idsOk(b)) {
    const byIdA = new Map(a.map((f) => [f.id, f]));
    b.forEach((fb, i) => { pairs.push([byIdA.get(fb.id), fb, i]); byIdA.delete(fb.id); });
    a.forEach((fa, i) => { if (byIdA.has(fa.id)) pairs.push([fa, undefined, i]); });
  } else {
    for (let i = 0; i < Math.max(a.length, b.length); i++) pairs.push([a[i], b[i], i]);
  }
  return pairs;
}

// First item per id wins, as before.
const byId = (list) => {
  const m = new Map();
  for (const x of list) if (x && !m.has(x.id)) m.set(x.id, x);
  return m;
};

/**
 * Human-readable changes between two floor lists (revision snapshots or the
 * live plan): floors and devices/zones/walls added, removed, moved, and the
 * identity, wiring and rollout fields that changed.
 * @param {any[]} a  before
 * @param {any[]} b  after
 * @returns {string[]}
 */
export function diffRevisions(a, b) {
  const out = [];
  for (const [fa, fb, i] of pairFloors(a || [], b || [])) {
    if (!fa) { out.push(`+ Floor "${fb.name || i}" added`); continue; }
    if (!fb) { out.push(`- Floor "${fa.name || i}" removed`); continue; }
    if ((fa.name || '') !== (fb.name || '')) out.push(`~ Floor "${fa.name || i}" renamed to "${fb.name || i}"`);
    const label = fb.name || i;
    for (const kind of KINDS) {
      const one = kind.slice(0, -1);
      const ma = byId(fa[kind] || []), mb = byId(fb[kind] || []);
      for (const id of new Set([...ma.keys(), ...mb.keys()])) {
        const ia = ma.get(id), ib = mb.get(id);
        if (ia && !ib) out.push(`- [${label}] ${one} ${ia.name || id} removed`);
        else if (!ia && ib) out.push(`+ [${label}] ${one} ${ib.name || id} added`);
        else {
          // Walls carry endpoint coords; everything else a single fx/fy anchor.
          const moved = kind === 'WALLS'
            ? (ia.fx1 !== ib.fx1 || ia.fy1 !== ib.fy1 || ia.fx2 !== ib.fx2 || ia.fy2 !== ib.fy2)
            : (ia.fx !== ib.fx || ia.fy !== ib.fy);
          if (moved) out.push(`~ [${label}] ${one} ${ia.name || id} ${kind === 'WALLS' ? 'reshaped' : 'moved'}`);
          if (kind === 'WALLS' || kind === 'DZS') continue;
          for (const fld of FIELDS) {
            const va = ia[fld] ?? '', vb = ib[fld] ?? '';
            if (String(va) !== String(vb)) out.push(`~ [${label}] ${one} ${ia.name || id}: ${fld} ${va === '' ? '(empty)' : va} → ${vb === '' ? '(empty)' : vb}`);
          }
        }
      }
    }
  }
  return out;
}
