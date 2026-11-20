// Minimal DXF (ASCII) reader for wall import. Architects hand over DXF far
// more often than SVG; we only need straight geometry, so this parses the
// ENTITIES section for LINE, LWPOLYLINE and legacy POLYLINE/VERTEX chains and
// ignores everything else (curves, arcs, blocks, text). Pure text → segments,
// no DOM.

/**
 * @param {string} text  DXF file contents (ASCII).
 * @returns {{segments:Array<{x1:number,y1:number,x2:number,y2:number}>,
 *            minX:number,minY:number,maxX:number,maxY:number}}
 *   Segments in DXF drawing units, Y up (CAD convention — caller flips).
 */
export function parseDxf(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/);
  // DXF is a flat list of (group code, value) pairs, one per line.
  /** @type {Array<[number,string]>} */
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isFinite(code)) pairs.push([code, lines[i + 1].trim()]);
  }

  const segments = [];
  const push = (x1, y1, x2, y2) => {
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    if (x1 === x2 && y1 === y2) return;
    segments.push({ x1, y1, x2, y2 });
  };

  let inEntities = false;
  /** @type {any} */ let ent = null;           // current entity being accumulated
  /** @type {any} */ let polyOpen = null;      // legacy POLYLINE accumulator {pts, closed}

  const flush = () => {
    if (!ent) return;
    if (ent.type === 'LINE') {
      push(ent.x1, ent.y1, ent.x2, ent.y2);
    } else if (ent.type === 'LWPOLYLINE') {
      const n = Math.min(ent.xs.length, ent.ys.length);
      for (let i = 0; i + 1 < n; i++) push(ent.xs[i], ent.ys[i], ent.xs[i + 1], ent.ys[i + 1]);
      if (ent.closed && n > 2) push(ent.xs[n - 1], ent.ys[n - 1], ent.xs[0], ent.ys[0]);
    }
    ent = null;
  };

  for (const [code, val] of pairs) {
    if (code === 0) {
      // Section bookkeeping.
      if (val === 'SECTION') { flush(); continue; }
      if (val === 'ENDSEC') { flush(); inEntities = false; continue; }
      if (!inEntities && val === 'EOF') break;

      // Entity boundaries.
      flush();
      if (val === 'LINE') ent = { type: 'LINE', x1: NaN, y1: NaN, x2: NaN, y2: NaN };
      else if (val === 'LWPOLYLINE') ent = { type: 'LWPOLYLINE', xs: [], ys: [], closed: false };
      else if (val === 'POLYLINE') polyOpen = { pts: [], closed: false };
      else if (val === 'VERTEX' && polyOpen) polyOpen.pts.push({ x: NaN, y: NaN });
      else if (val === 'SEQEND' && polyOpen) {
        const pts = polyOpen.pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        for (let i = 0; i + 1 < pts.length; i++) push(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        if (polyOpen.closed && pts.length > 2) push(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y);
        polyOpen = null;
      }
      continue;
    }
    if (code === 2 && val === 'ENTITIES') { inEntities = true; continue; }
    if (!inEntities) continue;

    const num = parseFloat(val);
    if (ent && ent.type === 'LINE') {
      if (code === 10) ent.x1 = num;
      else if (code === 20) ent.y1 = num;
      else if (code === 11) ent.x2 = num;
      else if (code === 21) ent.y2 = num;
    } else if (ent && ent.type === 'LWPOLYLINE') {
      if (code === 10) ent.xs.push(num);
      else if (code === 20) ent.ys.push(num);
      else if (code === 70) ent.closed = (parseInt(val, 10) & 1) === 1;
    } else if (polyOpen) {
      const last = polyOpen.pts[polyOpen.pts.length - 1];
      if (last && code === 10) last.x = num;
      else if (last && code === 20) last.y = num;
      else if (!polyOpen.pts.length && code === 70) polyOpen.closed = (parseInt(val, 10) & 1) === 1;
    }
  }
  flush();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.x1, s.x2); maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2); maxY = Math.max(maxY, s.y1, s.y2);
  }
  if (!segments.length) { minX = minY = 0; maxX = maxY = 1; }
  return { segments, minX, minY, maxX, maxY };
}
