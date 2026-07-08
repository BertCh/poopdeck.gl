/**
 * Space-filling-curve linearization + range-read simulation for the demo-page
 * "cube laid down in a line" utility (CubeInLine).
 *
 * A tile blob's address has three axes — (x, y) on the map plus a time bucket —
 * but a pack is one flat byte string. `--blob-ordering` picks the space-filling
 * walk that linearizes that cube; the walk decides how many HTTP range reads a
 * query costs. These are direct ports of the production ordering math in
 * `crates/stt-core/src/curve.rs` (2D Hilbert for the spatial key, Skilling's
 * transpose for the 3D Hilbert, bit-interleave for Morton), so a walk here
 * behaves exactly as the writer would order bytes — just over a downsampled
 * SB×SB×TB density grid instead of the archive's native tiles.
 */

export type Walk = 'spatial' | 'hilbert3' | 'morton3' | 'time';
export type Query = 'scrub' | 'pan';

export const WALKS: Walk[] = ['spatial', 'hilbert3', 'morton3', 'time'];

export const WALK_LABEL: Record<Walk, string> = {
  spatial: '2D Hilbert + time',
  hilbert3: '3D Hilbert',
  morton3: '3D Morton',
  time: 'time-major',
};

/** One occupied cell of the downsampled cube. `h2` is its 2D-Hilbert rank. */
export interface Cell {
  sx: number;
  sy: number;
  tb: number;
  count: number;
  bytes: number;
  h2: number;
}

/* ── Curve math (ports of curve.rs) ──────────────────────────────────── */

/** Bits needed to represent values `0..n-1` (port of `curve::bits_for`). */
export function bitsFor(n: number): number {
  if (n <= 1) return 0;
  return 32 - Math.clz32(n - 1);
}

/** Cube side in bits for the 3D curves (port of `curve::curve_bits`). */
export function curveBits(spaceBits: number, timeBins: number): number {
  return Math.min(Math.max(spaceBits, bitsFor(timeBins)), 21);
}

/** 2D Hilbert index of (x, y) on a `2^bits` grid — the canonical xy→d walk. */
export function hilbert2(bits: number, x: number, y: number): number {
  const n = 1 << bits;
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x;
        y = n - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/** 3D Hilbert distance via Skilling's transpose (port of `curve::hilbert3`). */
export function hilbert3(
  x: number,
  y: number,
  t: number,
  bits: number,
): number {
  if (bits === 0) return 0;
  const n = 3;
  const coords = [x, y, t];
  let q = 1 << (bits - 1);
  while (q > 1) {
    const p = q - 1;
    for (let i = 0; i < n; i++) {
      if (coords[i] & q) {
        coords[0] ^= p;
      } else {
        const s = (coords[0] ^ coords[i]) & p;
        coords[0] ^= s;
        coords[i] ^= s;
      }
    }
    q >>= 1;
  }
  for (let i = 1; i < n; i++) coords[i] ^= coords[i - 1];
  let acc = 0;
  let q2 = 1 << (bits - 1);
  while (q2 > 1) {
    if (coords[n - 1] & q2) acc ^= q2 - 1;
    q2 >>= 1;
  }
  for (let i = 0; i < n; i++) coords[i] ^= acc;
  // Interleave transpose words MSB-first (multiply, not shift — 3*bits can top 32).
  let key = 0;
  for (let bit = bits - 1; bit >= 0; bit--) {
    for (let i = 0; i < n; i++) key = key * 2 + ((coords[i] >> bit) & 1);
  }
  return key;
}

/** 3D Morton / Z-order: interleave the low `bits` of x, y, t (port of `curve::morton3`). */
export function morton3(x: number, y: number, t: number, bits: number): number {
  let key = 0;
  let wx = 1;
  let wy = 2;
  let wt = 4;
  for (let i = 0; i < bits; i++) {
    key += ((x >> i) & 1) * wx + ((y >> i) & 1) * wy + ((t >> i) & 1) * wt;
    wx *= 8;
    wy *= 8;
    wt *= 8;
  }
  return key;
}

/** Native-resolution axes for the 3D curves (port of `curve::scale_axes`). */
function scaleAxes(
  sx: number,
  sy: number,
  tb: number,
  spaceBits: number,
  bits: number,
): [number, number, number] {
  const sdrop = Math.max(spaceBits - bits, 0);
  const xs = sx >>> sdrop;
  const ys = sy >>> sdrop;
  const tdrop = Math.max(bitsFor(tb + 1) - bits, 0);
  const qt = tb >>> tdrop;
  return [xs, ys, qt];
}

/**
 * A single comparable sort key laying `cell` down in `walk` byte order — the
 * 4-tuple of `curve::space_time_key` folded into one Number (safe: the grid is
 * tiny, at most ~2^20 space cells × a few hundred time bins).
 */
export function orderKey(
  walk: Walk,
  cell: Cell,
  spaceBits: number,
  timeBins: number,
): number {
  const bits = curveBits(spaceBits, timeBins);
  switch (walk) {
    case 'spatial':
      // (hilbert, time_start): each cell's whole timeline stays contiguous.
      return cell.h2 * timeBins + cell.tb;
    case 'time': {
      // (time_bucket, hilbert): one instant's whole map stays contiguous.
      const spaceCells = 1 << (2 * spaceBits);
      return cell.tb * spaceCells + cell.h2;
    }
    case 'hilbert3': {
      const [xs, ys, qt] = scaleAxes(
        cell.sx,
        cell.sy,
        cell.tb,
        spaceBits,
        bits,
      );
      return hilbert3(xs, ys, qt, bits);
    }
    case 'morton3': {
      const [xs, ys, qt] = scaleAxes(
        cell.sx,
        cell.sy,
        cell.tb,
        spaceBits,
        bits,
      );
      return morton3(xs, ys, qt, bits);
    }
  }
}

/** The occupied cells laid down as one line in `walk` order. */
export function linearize(
  cells: Cell[],
  walk: Walk,
  spaceBits: number,
  timeBins: number,
): Cell[] {
  return [...cells].sort(
    (a, b) =>
      orderKey(walk, a, spaceBits, timeBins) -
      orderKey(walk, b, spaceBits, timeBins),
  );
}

/** Adjacency breaks: consecutive blobs that are not (sx, sy, tb) neighbours. */
export function seeks(ordered: Cell[]): number {
  let n = 0;
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    const d =
      Math.abs(a.sx - b.sx) + Math.abs(a.sy - b.sy) + Math.abs(a.tb - b.tb);
    if (d !== 1) n++;
  }
  return n;
}

export interface QueryResult {
  reads: number;
  runs: [number, number][]; // fused index spans in the ordered line
  hits: number[]; // ordered-line positions the query needs
  weightNeeded: number;
  weightRead: number; // needed + over-read swept up inside fused runs
}

/**
 * Simulate a query over the linearized blobs with HTTP-style range coalescing:
 * two needed blobs fuse into one request when at most `gap` unneeded blobs lie
 * between them. `weightOf` picks the cost axis (feature count or bytes).
 */
export function simulateQuery(
  ordered: Cell[],
  isHit: (c: Cell) => boolean,
  gap: number,
  weightOf: (c: Cell) => number,
): QueryResult {
  const hits: number[] = [];
  for (let i = 0; i < ordered.length; i++) if (isHit(ordered[i])) hits.push(i);

  const runs: [number, number][] = [];
  for (const p of hits) {
    const last = runs[runs.length - 1];
    if (last && p - last[1] - 1 <= gap) last[1] = p;
    else runs.push([p, p]);
  }

  let weightNeeded = 0;
  for (const p of hits) weightNeeded += weightOf(ordered[p]);
  let weightRead = 0;
  for (const [a, b] of runs)
    for (let i = a; i <= b; i++) weightRead += weightOf(ordered[i]);

  return { reads: runs.length, runs, hits, weightNeeded, weightRead };
}

/* ── Canonical queries (generalized from the toy figure) ─────────────── */

/**
 * "scrub a viewport": a contiguous spatial band across all of time. The band is
 * the central quarter of the occupied cells in 2D-Hilbert space order — a
 * neighbourhood you'd zoom to and play through time.
 */
export function scrubHit(cells: Cell[]): (c: Cell) => boolean {
  const space = [...new Set(cells.map((c) => c.h2))].sort((a, b) => a - b);
  const m = space.length;
  const band = new Set(
    space.slice(
      Math.floor(m * 0.375),
      Math.max(Math.floor(m * 0.625), Math.floor(m * 0.375) + 1),
    ),
  );
  return (c) => band.has(c.h2);
}

/** "pan at one instant": the densest single time bin across the whole map. */
export function panHit(cells: Cell[]): {
  hit: (c: Cell) => boolean;
  tb: number;
} {
  const byTb = new Map<number, number>();
  for (const c of cells) byTb.set(c.tb, (byTb.get(c.tb) ?? 0) + c.count);
  let best = 0;
  let bestW = -1;
  for (const [tb, w] of byTb) {
    if (w > bestW) {
      bestW = w;
      best = tb;
    }
  }
  return { hit: (c) => c.tb === best, tb: best };
}
