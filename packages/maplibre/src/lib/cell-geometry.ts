/**
 * Cell-geometry kernel for the summary family.
 *
 * The summary tier stores one row per spatial CELL, keyed by a u64 cell id in
 * the Arrow `id` column (`BinaryFeatures.featureIds64` — the 32-bit
 * `featureIds` mirror TRUNCATES the high bits and must never be used here).
 * This module turns those ids into drawable geometry in the one space this
 * backend renders in: the **mercator unit square** (`lib/projection.ts` — lon
 * −180 → x 0, lon 180 → x 1, lat 85.0511 → y 0, lat −85.0511 → y 1, so y grows
 * SOUTHWARD).
 *
 * Three cell families, three very different provenances:
 *
 * - **H3** (`SummaryScheme === 'h3'`) — the boundary is icosahedral geometry
 *   only h3-js can produce. We do NOT reimplement it: `cellToBoundary` is
 *   passed IN (see {@link H3CellToBoundary}). `@poopdeck.gl/layers` and
 *   `@poopdeck.gl/three` both depend on `h3-js@^4.1` and both resolve cell
 *   boundaries with `cellToBoundary(index, true)`; this kernel consumes that
 *   exact function so all three backends share one source of truth.
 *   Injection (rather than a direct import) is deliberate: `h3-js` is not in
 *   this package's `dependencies`, and keeping the kernel dependency-free
 *   means the single `import {cellToBoundary} from 'h3-js'` lives in the layer
 *   that needs it.
 * - **Quadbin** (`SummaryScheme === 'quadbin'`) — a pure `(z, x, y)` bit
 *   layout. Decoded here (third copy of a ~40-line pure port; the other two are
 *   `@poopdeck.gl/layers` `lib/quadbin-cell.ts` and `@poopdeck.gl/three`
 *   `lib/quadbin-cell.ts`) and turned straight into an EXACT mercator quad —
 *   `x / 2^z` — with no lon/lat round trip at all.
 * - **hexbin** — NOT a stored cell id. deck's `AnimatedHexagonLayer` wraps
 *   `@deck.gl/aggregation-layers`' `HexagonLayer`, which bins the RAW point
 *   tier at runtime; there is nothing in the archive to decode. What is
 *   portable is deck's lattice, which this module reproduces exactly (see
 *   {@link pointToHexBin}), so a native hexbin layer can bin CPU-side at tile
 *   upload and land on the same cells deck would.
 *
 * ## Antimeridian and poles (the two real failure modes)
 *
 * A naive per-vertex projection of an H3 cell straddling ±180° puts some
 * vertices at x ≈ 0.9997 and others at x ≈ 0.0003, and the cell SMEARS across
 * the whole world. Raw geometry never hits this — `crates/stt-build/src/clip.rs`
 * splits crossing rings at build time (`split_polygon_at_antimeridian`) — but a
 * cell id is atomic, so its boundary is only ever reconstructed client-side and
 * the split cannot have happened. Handling here, mirroring the Rust
 * "unwrap into a continuous longitude frame first" step:
 *
 * 1. Longitudes are unwrapped SEQUENTIALLY (each vertex placed within ±180° of
 *    its predecessor), producing a continuous ring.
 * 2. The ring is translated by a whole multiple of 360° so its MEAN longitude
 *    lands in `[-180, 180)`, i.e. its centroid x lands in `[0, 1)`.
 * 3. Vertices may therefore sit slightly outside `[0, 1]`. That is correct and
 *    intended: the ring stays contiguous, which is what stops the smear.
 *    `seamMode: 'duplicate'` additionally emits the ±1 twin so a flat map
 *    panned to the seam draws both halves (maplibre renders a custom layer
 *    ONCE, so it does not repeat world copies for us). On globe the twin
 *    projects to the same place (longitude is periodic there) and double-blends
 *    — keep the default `'unwrap'` when `isGlobe`.
 *
 * A cell CONTAINING a pole (H3 res 0 `8001fffffffffff` is the north-pole cell;
 * every resolution has one per pole) cannot be a mercator ring at all: its
 * boundary winds 360° in longitude and the pole itself is at y = ∓∞. Those are
 * detected by the winding total (step 1 sums to ±360°, not 0) and handled by
 * {@link CellRingOptions.poleMode} — `'band'` (default) emits the full-width
 * mercator rectangle from the pole edge to the cell's equatorward-most vertex,
 * `'skip'` drops the cell. Both are counted in {@link CellRingDiagnostics} so a
 * layer can warn rather than silently mis-draw or silently lose rows.
 *
 * Everything here is pure geometry: no GL, no map, no layer imports, and no
 * per-frame work — every entry point is a TILE-UPLOAD-time call.
 */

import type { SummaryScheme } from '@poopdeck.gl/core';
import { lngLatToMercatorInto, metersToMercatorUnits } from './projection.js';

// ── shared types ────────────────────────────────────────────────────────────

/**
 * h3-js's `cellToBoundary`, structurally. Pass the real thing:
 *
 * ```ts
 * import { cellToBoundary } from 'h3-js';
 * const ring = h3CellToMercatorRing(cellId, cellToBoundary);
 * ```
 *
 * With `formatAsGeoJson === true` h3-js returns `[lng, lat]` degree pairs AND
 * CLOSES the ring (the first vertex is repeated at the end) — 6 entries for a
 * pentagon, 7 for a hexagon, more where a cell crosses an icosahedron edge
 * (H3's `MAX_CELL_BNDRY_VERTS` is 10). This kernel drops that duplicate before
 * doing anything and re-adds it at the end, so it never depends on which
 * convention a caller's h3-js version uses.
 *
 * (`@poopdeck.gl/three`'s `lib/h3-cell.ts` documents the same call as returning
 * an OPEN ring and fans over every returned vertex — with the closing duplicate
 * present that costs one extra vertex and one zero-area triangle per cell.
 * Harmless, but it is not the same handling as here.)
 */
export type H3CellToBoundary = (
  h3Index: string,
  formatAsGeoJson?: boolean,
) => number[][];

/** How a ring that crosses the ±180° seam is emitted. */
export type SeamMode = 'unwrap' | 'duplicate';

/** How a cell that ENCLOSES a pole is emitted. */
export type PoleMode = 'band' | 'skip';

/** Options shared by every ring producer in this module. */
export interface CellRingOptions {
  /**
   * Shrink each cell toward its own centroid, `0..1` (deck's `coverage` on
   * `H3HexagonLayer` / `QuadkeyLayer` / `HexagonLayer`). @default 1
   *
   * Applied in MERCATOR space, unlike `@poopdeck.gl/three`, which shrinks in
   * lon/lat. The two differ only by mercator's latitude stretch ACROSS ONE
   * CELL — second order everywhere a cell is legible, and the mercator form is
   * the one that keeps a shrunk cell centred on the drawn cell.
   */
  coverage?: number;
  /**
   * Antimeridian policy. `'unwrap'` (default) emits ONE contiguous ring whose
   * x may leave `[0, 1]`; `'duplicate'` also emits the ±1 twin (batch forms
   * only — the single-cell forms always return one ring).
   * @default 'unwrap'
   */
  seamMode?: SeamMode;
  /**
   * Pole-enclosing-cell policy: `'band'` (default) → full-width mercator
   * rectangle to the cell's equatorward-most vertex; `'skip'` → drop the cell.
   * @default 'band'
   */
  poleMode?: PoleMode;
}

/** What a batch build had to do to the data — surface these, do not hide them. */
export interface CellRingDiagnostics {
  /** Cell ids that decoded to geometry (before seam duplication). */
  cells: number;
  /** Rows skipped: undecodable id, out-of-band zoom, degenerate boundary. */
  skipped: number;
  /** Cells whose ring crosses the ±180° seam (x left `[0, 1]`). */
  seamCells: number;
  /** Extra rings emitted by `seamMode: 'duplicate'`. */
  duplicated: number;
  /** Cells detected as enclosing a pole. */
  poleCells: number;
  /** Pole cells dropped because `poleMode: 'skip'`. */
  poleSkipped: number;
}

/**
 * A tile's worth of cell rings, packed flat.
 *
 * `positions` is `[x0, y0, x1, y1, …]` in mercator units; ring `r` owns
 * vertices `ringOffsets[r] … ringOffsets[r + 1] - 1` (VERTEX indices, not
 * float offsets) and every ring is CLOSED (its last vertex repeats its first).
 * `sourceIndices[r]` is the row the ring came from — the only correct way back
 * to that cell's weight column, color and pick id, because undecodable rows are
 * skipped and seam duplicates repeat a row.
 */
export interface CellRingBatch {
  ringCount: number;
  positions: Float64Array;
  /** `ringCount + 1` vertex offsets into `positions`. */
  ringOffsets: Uint32Array;
  /** `ringCount` source row indices. */
  sourceIndices: Uint32Array;
  diagnostics: CellRingDiagnostics;
}

/** Fan triangulation of one ring or one batch. */
export interface CellTriangles {
  /** Flat mercator xy. */
  positions: Float64Array;
  /** Triangle list into `positions`. */
  indices: Uint32Array;
}

/** {@link triangulateCellRings} adds the per-vertex row mapping. */
export interface CellBatchTriangles extends CellTriangles {
  /** Source row index per vertex — expand per-cell color / pick id with this. */
  vertexSourceIndex: Uint32Array;
}

// ── ring primitives ─────────────────────────────────────────────────────────

/**
 * Twice the signed area of a flat xy ring (the shoelace sum), computed in the
 * MERCATOR frame (x east, y SOUTH). Positive is this module's canonical
 * orientation — see {@link orientRingPositive}. A trailing duplicate closing
 * vertex contributes zero, so closed and open rings agree.
 *
 * The sum is taken RELATIVE TO THE FIRST VERTEX. Cell areas in the unit square
 * are minuscule (an H3 res-9 hexagon is ~1e-11, a res-15 one ~1e-18) while the
 * coordinates themselves are order 1, so the textbook `x_j·y_i − x_i·y_j` form
 * cancels away most of its significant digits — enough, at fine resolutions,
 * to get the SIGN wrong and have {@link orientRingPositive} flip a perfectly
 * good ring. Translating to a local origin first costs one subtraction per
 * vertex and removes the cancellation entirely.
 */
export function ringSignedArea2(ring: ArrayLike<number>): number {
  const n = ring.length >> 1;
  if (n < 3) return 0;
  const ox = ring[0];
  const oy = ring[1];
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum +=
      (ring[j * 2] - ox) * (ring[i * 2 + 1] - oy) -
      (ring[i * 2] - ox) * (ring[j * 2 + 1] - oy);
  }
  return sum;
}

/**
 * Force a ring into this module's canonical winding — POSITIVE shoelace area in
 * mercator (x east, y south) — reversing in place when needed. Returns the ring.
 *
 * Why positive-in-mercator rather than "CCW on screen": it is a single
 * arithmetic invariant that every producer here can assert, and it matches the
 * parameterization `STTColumnLayer.columnUnitRing` already emits
 * (`(cos θ, sin θ)`, θ increasing). Because mercator y points south this reads
 * as CLOCKWISE in a north-up view. Nothing in this backend enables
 * `gl.CULL_FACE`, so the choice is about consistency (and about a future
 * extruded summary column sharing the column layer's cap rule), not visibility.
 */
export function orientRingPositive(ring: Float64Array): Float64Array {
  if (ringSignedArea2(ring) >= 0) return ring;
  const n = ring.length >> 1;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const x = ring[i * 2];
    const y = ring[i * 2 + 1];
    ring[i * 2] = ring[j * 2];
    ring[i * 2 + 1] = ring[j * 2 + 1];
    ring[j * 2] = x;
    ring[j * 2 + 1] = y;
  }
  return ring;
}

/** Shrink an OPEN ring toward its own vertex centroid, `coverage` in `0..1`. */
function shrinkRingInPlace(ring: Float64Array, coverage: number): void {
  if (coverage >= 1) return;
  const n = ring.length >> 1;
  if (n === 0) return;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2];
    cy += ring[i * 2 + 1];
  }
  cx /= n;
  cy /= n;
  for (let i = 0; i < n; i++) {
    ring[i * 2] = cx + (ring[i * 2] - cx) * coverage;
    ring[i * 2 + 1] = cy + (ring[i * 2 + 1] - cy) * coverage;
  }
}

/** Close an OPEN ring: allocate `n + 1` vertices with the first repeated. */
function closeRing(open: Float64Array): Float64Array {
  const n = open.length >> 1;
  const out = new Float64Array((n + 1) * 2);
  out.set(open);
  out[n * 2] = open[0];
  out[n * 2 + 1] = open[1];
  return out;
}

/** Vertex count of `ring` ignoring a trailing duplicate of the first vertex. */
function openVertexCount(ring: ArrayLike<number>): number {
  const n = ring.length >> 1;
  if (n < 2) return n;
  const closed =
    ring[0] === ring[(n - 1) * 2] && ring[1] === ring[(n - 1) * 2 + 1];
  return closed ? n - 1 : n;
}

function sanitizeCoverage(coverage: number | undefined): number {
  if (coverage === undefined || !Number.isFinite(coverage)) return 1;
  return coverage < 0 ? 0 : coverage > 1 ? 1 : coverage;
}

// ── lon/lat ring → mercator ring (unwrap + pole handling) ───────────────────

/** Wrap a longitude DELTA into `(-180, 180]`. */
function wrapDelta180(d: number): number {
  return d - 360 * Math.round(d / 360);
}

/** Outcome of {@link lonLatRingToMercatorRing} beyond the ring itself. */
interface RingClassification {
  /** Ring left `[0, 1]` in x — it straddles the ±180° seam. */
  seam: boolean;
  /** Ring wound a full turn in longitude — it encloses a pole. */
  pole: boolean;
}

/**
 * Project an OPEN lon/lat degree ring (`[lon0, lat0, lon1, lat1, …]`) into a
 * closed mercator ring, handling the antimeridian and poles per the module doc.
 * Returns `null` when the ring is degenerate, or when it encloses a pole and
 * `poleMode` is `'skip'`.
 */
function lonLatRingToMercatorRing(
  lonLat: Float64Array,
  options: CellRingOptions,
  out: RingClassification,
): Float64Array | null {
  const n = lonLat.length >> 1;
  out.seam = false;
  out.pole = false;
  if (n < 3) return null;

  // 1. Sequential unwrap into a continuous longitude frame + winding total.
  const lons = new Float64Array(n);
  lons[0] = lonLat[0];
  let winding = 0;
  for (let i = 1; i < n; i++) {
    const d = wrapDelta180(lonLat[i * 2] - lonLat[(i - 1) * 2]);
    lons[i] = lons[i - 1] + d;
    winding += d;
  }
  winding += wrapDelta180(lonLat[0] - lonLat[(n - 1) * 2]);

  // 2. Pole test. A ring that does not enclose a pole sums to exactly 0; one
  //    that does sums to ±360. The 180 threshold is the only sane cut between
  //    them (a single edge spanning ≥180° of longitude is not representable in
  //    ANY planar frame, so there is no third case to protect).
  if (Math.abs(winding) > 180) {
    out.pole = true;
    if ((options.poleMode ?? 'band') === 'skip') return null;
    return poleBandRing(lonLat, options);
  }

  // 3. Translate the whole ring by a multiple of 360° so its mean longitude —
  //    hence its centroid x — lands in the primary world copy.
  let meanLon = 0;
  for (let i = 0; i < n; i++) meanLon += lons[i];
  meanLon /= n;
  const shift = -360 * Math.floor((meanLon + 180) / 360);

  // 4. Project. `lngLatToMercatorInto` extrapolates x linearly outside ±180°
  //    (x = lon/360 + 0.5), which is exactly the continuity we unwrapped for,
  //    and clamps latitude to the mercator cutoff.
  const ring = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    lngLatToMercatorInto(lons[i] + shift, lonLat[i * 2 + 1], ring, i * 2);
    const x = ring[i * 2];
    if (x < 0 || x > 1) out.seam = true;
  }

  shrinkRingInPlace(ring, sanitizeCoverage(options.coverage));
  return closeRing(orientRingPositive(ring));
}

/**
 * The `poleMode: 'band'` substitute for a pole-enclosing cell: the full-width
 * mercator rectangle from the pole edge (y = 0 north, y = 1 south) to the
 * cell's EQUATORWARD-most boundary vertex.
 *
 * Deliberately OVER-covers (a gap at the pole reads as missing data; an overlap
 * reads as a slightly large polar cap, and everything poleward of ±85.0511° is
 * a degenerate sliver in mercator anyway). At coarse H3 resolutions the polar
 * cell is a large fraction of the arctic and the band is a visibly rough
 * approximation — {@link CellRingDiagnostics.poleCells} exists so a layer can
 * say so.
 */
function poleBandRing(
  lonLat: Float64Array,
  options: CellRingOptions,
): Float64Array {
  const n = lonLat.length >> 1;
  let meanLat = 0;
  const scratch = new Float64Array(2);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    meanLat += lonLat[i * 2 + 1];
    lngLatToMercatorInto(0, lonLat[i * 2 + 1], scratch, 0);
    if (scratch[1] < minY) minY = scratch[1];
    if (scratch[1] > maxY) maxY = scratch[1];
  }
  const north = meanLat / n >= 0;
  const yPole = north ? 0 : 1;
  // Clamp into the unit square: `lngLatToMercator` is a hair off 0 / 1 AT the
  // mercator cutoff (~8e-16), and a band is the one shape that has no business
  // poking out of the world.
  const edge = north ? maxY : minY;
  const yEdge = edge < 0 ? 0 : edge > 1 ? 1 : edge;
  const ring = new Float64Array([0, yPole, 0, yEdge, 1, yEdge, 1, yPole]);
  shrinkRingInPlace(ring, sanitizeCoverage(options.coverage));
  return closeRing(orientRingPositive(ring));
}

// ── H3 ──────────────────────────────────────────────────────────────────────

/**
 * A u64 H3 cell index → the canonical h3-js index STRING.
 *
 * h3-js's own `splitLongToH3Index(lower, upper)` is exactly this hex formatting
 * of the same 64 bits (it exists only because JS had no BigInt when h3-js was
 * written); `BigInt.prototype.toString(16)` produces the identical, leading-zero-
 * free 15-character form. `test/cell-geometry.test.ts` pins the equivalence
 * against literals taken from h3-js itself.
 *
 * The u64 must come from `BinaryFeatures.featureIds64` — the 32-bit
 * `featureIds` mirror truncates the high bits, which carry the mode,
 * resolution and leading base-cell digits.
 */
export function h3IndexFromU64(cellId: bigint): string {
  return (cellId & 0xffffffffffffffffn).toString(16);
}

/**
 * One H3 cell → a CLOSED flat-xy mercator ring, or `null` if the id is not a
 * decodable cell (h3-js throws) or the cell is dropped by `poleMode: 'skip'`.
 *
 * `cellToBoundary` is h3-js's — see {@link H3CellToBoundary} for why it is a
 * parameter. Seam-crossing cells come back as ONE contiguous ring whose x may
 * leave `[0, 1]`; use {@link buildSummaryCellRings} with
 * `seamMode: 'duplicate'` if the flat-map seam copy is wanted.
 */
export function h3CellToMercatorRing(
  h3Index: string | bigint,
  cellToBoundary: H3CellToBoundary,
  options: CellRingOptions = {},
): Float64Array | null {
  return h3RingInternal(h3Index, cellToBoundary, options, {
    seam: false,
    pole: false,
  });
}

function h3RingInternal(
  h3Index: string | bigint,
  cellToBoundary: H3CellToBoundary,
  options: CellRingOptions,
  klass: RingClassification,
): Float64Array | null {
  const index = typeof h3Index === 'bigint' ? h3IndexFromU64(h3Index) : h3Index;
  let boundary: number[][];
  try {
    // `true` → GeoJSON [lng, lat] degree order. h3-js THROWS on a non-cell
    // index; a summary tile whose id column is not H3 must degrade, not crash.
    boundary = cellToBoundary(index, true) as number[][];
  } catch {
    return null;
  }
  if (!boundary || boundary.length < 3) return null;

  // Drop h3-js's closing duplicate if present (GeoJSON mode adds one).
  let n = boundary.length;
  const first = boundary[0];
  const last = boundary[n - 1];
  if (n >= 2 && first[0] === last[0] && first[1] === last[1]) n -= 1;
  if (n < 3) return null;

  const lonLat = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    lonLat[i * 2] = boundary[i][0];
    lonLat[i * 2 + 1] = boundary[i][1];
  }
  return lonLatRingToMercatorRing(lonLat, options, klass);
}

// ── Quadbin ─────────────────────────────────────────────────────────────────

/** A decoded Quadbin tile address. */
export interface QuadbinTile {
  z: number;
  x: number;
  y: number;
}

/** Mercator-unit-square bounds of a cell. `north < south` — y grows southward. */
export interface MercatorBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

/** Highest zoom the CARTO Quadbin 52-bit Morton field can address. */
const QUADBIN_MAX_ZOOM = 26;

/** De-interleave a Morton value into its even-bit (x) component. */
function deinterleave(coded: bigint): number {
  let v = coded & 0x5555555555555555n;
  v = (v | (v >> 1n)) & 0x3333333333333333n;
  v = (v | (v >> 2n)) & 0x0f0f0f0f0f0f0f0fn;
  v = (v | (v >> 4n)) & 0x00ff00ff00ff00ffn;
  v = (v | (v >> 8n)) & 0x0000ffff0000ffffn;
  v = (v | (v >> 16n)) & 0x00000000ffffffffn;
  return Number(v) >>> 0;
}

/**
 * Decode a CARTO Quadbin u64 into its `(z, x, y)` tile address.
 *
 * ```
 *   63       : reserved (0)
 *   62 .. 60 : header = 0b100        — Quadbin marker
 *   59       : mode   = 1            — "tile" mode
 *   58 .. 57 : mode-dependent = 0
 *   56 .. 52 : zoom z (5 bits, 0..26)
 *   51 .. 0  : 52-bit interleaved (Morton) x/y, LEFT-aligned for the cell's
 *              zoom; the low (52 − 2z) bits are a 1…1 fill.
 * ```
 *
 * Byte-for-byte the same decode as `@poopdeck.gl/layers` `lib/quadbin-cell.ts`
 * and `@poopdeck.gl/three` `lib/quadbin-cell.ts` (this backend cannot import
 * either without taking a deck or three dependency — see concerns; the right
 * long-term home is `@poopdeck.gl/core`). Cross-checked against CARTO's
 * published `(0,0,0) → 0x480fffffffffffff` in the test suite.
 *
 * The Rust builder bakes summary cells at `build_zoom + QUADBIN_RES_OFFSET`;
 * that offset is already inside the id's own zoom field, so decode is
 * offset-agnostic.
 */
export function quadbinToTile(quadbin: bigint): QuadbinTile {
  const z = Number((quadbin >> 52n) & 0x1fn);
  const mortonShift = BigInt(52 - 2 * z);
  const interleaved = (quadbin & ((1n << 52n) - 1n)) >> mortonShift;
  return {
    z,
    x: deinterleave(interleaved),
    y: deinterleave(interleaved >> 1n),
  };
}

/**
 * A slippy-map tile address → its EXACT mercator-unit-square bounds.
 *
 * Exact by construction: the mercator unit square IS the z0 tile, so a cell is
 * `x / 2^z … (x + 1) / 2^z` with no trigonometry at all. Equivalent to the
 * lon/lat path the deck and three ports take
 * (`tileToBounds` → `lngLatToMercator`) to within double rounding — the test
 * suite pins the two against each other — but without the `atan(sinh(…))` /
 * `log(tan(…))` round trip.
 *
 * Tile y counts from the NORTH edge and mercator y grows southward, so
 * `north = y / 2^z` is the SMALLER value.
 */
export function quadbinTileToMercatorBounds(tile: QuadbinTile): MercatorBounds {
  const n = Math.pow(2, tile.z);
  return {
    west: tile.x / n,
    east: (tile.x + 1) / n,
    north: tile.y / n,
    south: (tile.y + 1) / n,
  };
}

/**
 * One Quadbin cell → a CLOSED flat-xy mercator ring (5 vertices: the quad plus
 * its repeated first corner), or `null` for a malformed id.
 *
 * A string id is parsed as hexadecimal when it starts with `0x`/`0X` and as
 * DECIMAL otherwise — CARTO ships quadbins both ways.
 *
 * Quadbin cells can never cross the antimeridian (they are axis-aligned
 * subdivisions of the unit square, so `0 ≤ x ≤ 1` identically) and can never
 * enclose a pole (mercator has no poles), so the seam/pole machinery does not
 * apply to this family at all.
 */
export function quadbinCellToMercatorRing(
  quadbin: bigint | string,
  options: CellRingOptions = {},
): Float64Array | null {
  let id: bigint;
  if (typeof quadbin === 'bigint') {
    id = quadbin;
  } else {
    const text = quadbin.trim();
    // `BigInt('')` is 0n, which would decode as the valid root cell — an empty
    // id is missing data, not the whole world.
    if (text === '') return null;
    try {
      id = BigInt(text);
    } catch {
      return null;
    }
  }
  const tile = quadbinToTile(id);
  if (tile.z < 0 || tile.z > QUADBIN_MAX_ZOOM) return null;
  const b = quadbinTileToMercatorBounds(tile);
  // SW, NW, NE, SE — positive shoelace in the mercator (y-south) frame.
  const ring = new Float64Array([
    b.west,
    b.south,
    b.west,
    b.north,
    b.east,
    b.north,
    b.east,
    b.south,
  ]);
  shrinkRingInPlace(ring, sanitizeCoverage(options.coverage));
  return closeRing(orientRingPositive(ring));
}

// ── hexbin ──────────────────────────────────────────────────────────────────

/*
 * Lattice constants copied VERBATIM from `@deck.gl/aggregation-layers`
 * `src/hexagon-layer/hexbin.ts` (itself adapted from d3-hexbin). Row pitch is
 * `1.5 · radius`, column pitch is `2 · sin(60°) · radius`, odd rows are offset
 * half a column.
 */
const THIRD_PI = Math.PI / 3;
const HEX_DIST_X = 2 * Math.sin(THIRD_PI);
const HEX_DIST_Y = 1.5;

/**
 * Hex-bin ids are packed into ONE double so a layer can aggregate with a plain
 * `Map<number, …>` and no per-point allocation: `key = (i + OFF) * STRIDE +
 * (j + OFF)` with `OFF = STRIDE / 2 = 2^25`. Exact in a double while
 * `|i|, |j| < 2^25` (max key ≈ 4.5e15 < 2^53), which a mercator radius reaches
 * only below roughly 0.6 m of ground radius.
 */
const HEX_KEY_STRIDE = 1 << 26;
const HEX_KEY_OFFSET = 1 << 25;

/**
 * Ground metres → the mercator hex radius {@link pointToHexBin} and
 * {@link hexBinToMercatorRing} take.
 *
 * This is the bridge to deck's convention. deck computes
 * `radiusCommon = unitsPerMeter(lat) · radius` in its 512-unit common space;
 * dividing by 512 gives exactly `radius / (EARTH_CIRCUMFERENCE · cos lat)` —
 * i.e. `metersToMercatorUnits`, the horizontal twin of the elevation
 * conversion. The two agree to 5.7e-6 relative (deck rounds the circumference
 * to 40.03e6 m; this backend uses maplibre's own 40 030 228.884 m).
 *
 * deck resolves `lat` at the centroid of the layer's DATA bounds; a native
 * layer that resolves it per tile instead gets a lattice whose spacing drifts
 * between tiles. Pick ONE latitude per layer (data centre or map centre) and
 * pass the same radius for every tile, or cells will not line up across tile
 * boundaries.
 */
export function hexBinRadiusFromMeters(
  radiusMeters: number,
  latDeg: number,
): number {
  return metersToMercatorUnits(radiusMeters, latDeg);
}

/**
 * Which hex bin a mercator point falls into — deck's `pointToHexbin`, verbatim,
 * evaluated in the mercator unit square.
 *
 * deck bins in its common space, whose y points NORTH and whose world is 512
 * units wide; this kernel flips y (`yUp = 1 - my`) and works in unit-square
 * units, so the lattice, the origin and therefore the BIN IDS are identical to
 * deck's for `radiusMerc = radiusCommon / 512`. That is a world-space grid, not
 * a screen-space one: bins do not move when the camera does.
 *
 * Allocates a pair — use {@link hexBinKeyForPoint} in per-point loops.
 */
export function pointToHexBin(
  mx: number,
  my: number,
  radiusMerc: number,
): [number, number] {
  const py0 = (1 - my) / radiusMerc / HEX_DIST_Y;
  const pxRaw = mx / radiusMerc / HEX_DIST_X;
  let pj = Math.round(py0);
  const px0 = pxRaw - (pj & 1) / 2;
  let pi = Math.round(px0);
  const py1 = py0 - pj;
  if (Math.abs(py1) * 3 > 1) {
    const px1 = px0 - pi;
    const pi2 = pi + (px0 < pi ? -1 : 1) / 2;
    const pj2 = pj + (py0 < pj ? -1 : 1);
    const px2 = px0 - pi2;
    const py2 = py0 - pj2;
    if (px1 * px1 + py1 * py1 > px2 * px2 + py2 * py2) {
      pi = pi2 + (pj & 1 ? 1 : -1) / 2;
      pj = pj2;
    }
  }
  return [pi, pj];
}

/** Pack a bin address into one exact double. See {@link HEX_KEY_STRIDE}. */
export function hexBinKey(i: number, j: number): number {
  if (
    i < -HEX_KEY_OFFSET ||
    i >= HEX_KEY_OFFSET ||
    j < -HEX_KEY_OFFSET ||
    j >= HEX_KEY_OFFSET
  ) {
    return NaN;
  }
  return (i + HEX_KEY_OFFSET) * HEX_KEY_STRIDE + (j + HEX_KEY_OFFSET);
}

/** `i` component of a {@link hexBinKey}. */
export function hexBinKeyI(key: number): number {
  return Math.floor(key / HEX_KEY_STRIDE) - HEX_KEY_OFFSET;
}

/** `j` component of a {@link hexBinKey}. */
export function hexBinKeyJ(key: number): number {
  return (key % HEX_KEY_STRIDE) - HEX_KEY_OFFSET;
}

/**
 * Allocation-free {@link pointToHexBin} + {@link hexBinKey} — the form a
 * per-point binning loop must use. Returns `NaN` for a bin outside the packable
 * range (see {@link HEX_KEY_STRIDE}); a caller aggregating into a `Map` should
 * drop those rows rather than let them collapse into one bucket.
 */
export function hexBinKeyForPoint(
  mx: number,
  my: number,
  radiusMerc: number,
): number {
  const py0 = (1 - my) / radiusMerc / HEX_DIST_Y;
  const pxRaw = mx / radiusMerc / HEX_DIST_X;
  let pj = Math.round(py0);
  const px0 = pxRaw - (pj & 1) / 2;
  let pi = Math.round(px0);
  const py1 = py0 - pj;
  if (Math.abs(py1) * 3 > 1) {
    const px1 = px0 - pi;
    const pi2 = pi + (px0 < pi ? -1 : 1) / 2;
    const pj2 = pj + (py0 < pj ? -1 : 1);
    const px2 = px0 - pi2;
    const py2 = py0 - pj2;
    if (px1 * px1 + py1 * py1 > px2 * px2 + py2 * py2) {
      pi = pi2 + (pj & 1 ? 1 : -1) / 2;
      pj = pj2;
    }
  }
  return hexBinKey(pi, pj);
}

/** Centre of hex bin `(i, j)` in mercator units — deck's `getHexbinCentroid`. */
export function hexBinCentroidMercator(
  i: number,
  j: number,
  radiusMerc: number,
): [number, number] {
  return [
    (i + (j & 1) / 2) * radiusMerc * HEX_DIST_X,
    1 - j * radiusMerc * HEX_DIST_Y,
  ];
}

/**
 * Hex bin `(i, j)` → a CLOSED flat-xy mercator ring (7 vertices).
 *
 * Vertices are deck's `HexbinVertices` (`[sin θ, −cos θ]`, θ = k·60°) with y
 * negated for the mercator frame, i.e. a POINTY-TOP hexagon whose flat sides
 * face east and west — the deck.gl hexagon look.
 *
 * A bin near x = 0 or x = 1 simply extends past the edge of the unit square;
 * it is built in mercator directly so no unwrapping is involved and it can
 * never smear. `seamMode: 'duplicate'` on the batch helpers is still the way to
 * draw its twin on the far side of a flat-map seam.
 */
export function hexBinToMercatorRing(
  i: number,
  j: number,
  radiusMerc: number,
  options: CellRingOptions = {},
): Float64Array {
  const cx = (i + (j & 1) / 2) * radiusMerc * HEX_DIST_X;
  const cy = 1 - j * radiusMerc * HEX_DIST_Y;
  const ring = new Float64Array(12);
  for (let k = 0; k < 6; k++) {
    const angle = k * THIRD_PI;
    ring[k * 2] = cx + Math.sin(angle) * radiusMerc;
    ring[k * 2 + 1] = cy + Math.cos(angle) * radiusMerc;
  }
  shrinkRingInPlace(ring, sanitizeCoverage(options.coverage));
  return closeRing(orientRingPositive(ring));
}

// ── batch builders ──────────────────────────────────────────────────────────

/** Options for the whole-tile builders. */
export interface SummaryCellRingOptions extends CellRingOptions {
  /**
   * h3-js's `cellToBoundary`. REQUIRED when `scheme === 'h3'`; a missing
   * resolver is a wiring bug, not a data condition, so it throws rather than
   * silently emitting an empty tile.
   */
  cellToBoundary?: H3CellToBoundary;
}

function emptyBatch(skipped = 0): CellRingBatch {
  return {
    ringCount: 0,
    positions: new Float64Array(0),
    ringOffsets: new Uint32Array(1),
    sourceIndices: new Uint32Array(0),
    diagnostics: {
      cells: 0,
      skipped,
      seamCells: 0,
      duplicated: 0,
      poleCells: 0,
      poleSkipped: 0,
    },
  };
}

/** Grow a Float64Array to at least `needed` floats, preserving contents. */
function grow(buf: Float64Array, needed: number): Float64Array {
  if (buf.length >= needed) return buf;
  let cap = buf.length || 256;
  while (cap < needed) cap *= 2;
  const next = new Float64Array(cap);
  next.set(buf);
  return next;
}

/**
 * A whole summary tile's cell ids → its cell rings, packed flat.
 *
 * `featureIds64` is `BinaryFeatures.featureIds64` (the u64 mirror — never the
 * 32-bit one). Rows whose id does not decode are SKIPPED, which is why
 * {@link CellRingBatch.sourceIndices} exists: it is the only correct mapping
 * from a ring back to its weight/color/pick row.
 *
 * One allocation pass per tile, at tile-upload time. Never call per frame.
 */
export function buildSummaryCellRings(
  scheme: SummaryScheme,
  featureIds64: BigUint64Array | undefined,
  count?: number,
  options: SummaryCellRingOptions = {},
): CellRingBatch {
  if (!featureIds64) return emptyBatch();
  const ids = featureIds64;
  const rows = Math.min(
    ids.length,
    count === undefined ? ids.length : Math.max(0, count),
  );
  if (rows === 0) return emptyBatch();

  const duplicateSeams = (options.seamMode ?? 'unwrap') === 'duplicate';
  const klass: RingClassification = { seam: false, pole: false };

  // Resolve the per-row decoder ONCE, outside the loop: it is the only place
  // the two schemes differ, and hoisting it also narrows `cellToBoundary`
  // without a non-null assertion.
  let decodeRow: (row: number) => Float64Array | null;
  if (scheme === 'h3') {
    const cellToBoundary = options.cellToBoundary;
    if (!cellToBoundary) {
      throw new Error(
        "buildSummaryCellRings: scheme 'h3' requires options.cellToBoundary " +
          "(pass h3-js's cellToBoundary)",
      );
    }
    decodeRow = (row) =>
      h3RingInternal(ids[row], cellToBoundary, options, klass);
  } else {
    decodeRow = (row) => quadbinCellToMercatorRing(ids[row], options);
  }

  const diagnostics: CellRingDiagnostics = {
    cells: 0,
    skipped: 0,
    seamCells: 0,
    duplicated: 0,
    poleCells: 0,
    poleSkipped: 0,
  };

  // Annotated (not inferred) so reassignment from `grow` typechecks under
  // TS 5.7+'s ArrayBuffer-generic typed arrays.
  let positions: Float64Array = new Float64Array(rows * 16);
  let floats = 0;
  const offsets: number[] = [0];
  const sources: number[] = [];

  const emit = (ring: Float64Array, row: number, shiftX: number): void => {
    positions = grow(positions, floats + ring.length);
    if (shiftX === 0) {
      positions.set(ring, floats);
    } else {
      for (let k = 0; k < ring.length; k += 2) {
        positions[floats + k] = ring[k] + shiftX;
        positions[floats + k + 1] = ring[k + 1];
      }
    }
    floats += ring.length;
    offsets.push(floats >> 1);
    sources.push(row);
  };

  for (let row = 0; row < rows; row++) {
    klass.seam = false;
    klass.pole = false;
    const ring = decodeRow(row);
    if (klass.pole) diagnostics.poleCells++;
    if (!ring) {
      if (klass.pole) diagnostics.poleSkipped++;
      else diagnostics.skipped++;
      continue;
    }
    diagnostics.cells++;
    emit(ring, row, 0);
    if (!klass.seam) continue;
    diagnostics.seamCells++;
    if (!duplicateSeams) continue;
    // The ring left the unit square on exactly one side (a ring wide enough to
    // leave both is a pole cell, handled above), so one twin restores it.
    let minX = Infinity;
    let maxX = -Infinity;
    for (let k = 0; k < ring.length; k += 2) {
      if (ring[k] < minX) minX = ring[k];
      if (ring[k] > maxX) maxX = ring[k];
    }
    const shiftX = minX < 0 ? 1 : maxX > 1 ? -1 : 0;
    if (shiftX !== 0) {
      emit(ring, row, shiftX);
      diagnostics.duplicated++;
    }
  }

  const ringCount = sources.length;
  if (ringCount === 0) return { ...emptyBatch(), diagnostics };
  return {
    ringCount,
    positions: positions.subarray(0, floats),
    ringOffsets: Uint32Array.from(offsets),
    sourceIndices: Uint32Array.from(sources),
    diagnostics,
  };
}

// ── triangulation ───────────────────────────────────────────────────────────

/**
 * Fan a single cell ring from its CENTROID: `n` triangles from `n + 1`
 * vertices, index 0 being the inserted centre. A trailing closing vertex is
 * detected and dropped, so open and closed rings triangulate identically.
 * Returns `null` for fewer than 3 distinct vertices.
 *
 * **Convexity assumption.** The fan is valid for any ring that is STAR-SHAPED
 * about its vertex centroid; every family this module produces is:
 * quadbin quads, hex bins and pole bands are exactly convex, and an H3 cell is
 * convex on the sphere, which mercator's monotone latitude stretch preserves
 * for any cell that does not contain a pole. `coverage < 1` scales about the
 * same centroid and cannot break it. No earcut, no ear clipping, no
 * self-intersection test — a caller feeding this an arbitrary polygon gets
 * garbage, quietly.
 *
 * The centroid fan (rather than the fan-from-vertex-0 the three backend uses)
 * costs one extra vertex per cell and buys well-shaped triangles: no sliver
 * spanning a hexagon end to end, which matters once these rings are handed to
 * `subdivideTrianglesMercator` for globe, where the subdivider splits on the
 * LONGEST edge.
 */
export function cellRingToTriangles(
  ring: ArrayLike<number>,
): CellTriangles | null {
  const n = openVertexCount(ring);
  if (n < 3) return null;
  const positions = new Float64Array((n + 1) * 2);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2];
    const y = ring[i * 2 + 1];
    positions[(i + 1) * 2] = x;
    positions[(i + 1) * 2 + 1] = y;
    cx += x;
    cy += y;
  }
  positions[0] = cx / n;
  positions[1] = cy / n;
  const indices = new Uint32Array(n * 3);
  for (let i = 0; i < n; i++) {
    indices[i * 3] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = ((i + 1) % n) + 1;
  }
  return { positions, indices };
}

/**
 * {@link cellRingToTriangles} over a whole {@link CellRingBatch}, merged into
 * one indexed mesh plus the per-vertex row mapping a layer needs to expand
 * per-cell color and pick ids.
 *
 * The output is exactly the `(positions: flat xy, indices)` pair
 * `subdivideTrianglesMercator` (`lib/globe.ts`) consumes, so the globe path is
 * `triangulateCellRings(batch)` → subdivide → quantize → upload.
 */
export function triangulateCellRings(batch: CellRingBatch): CellBatchTriangles {
  let vertexCount = 0;
  let triangleCount = 0;
  for (let r = 0; r < batch.ringCount; r++) {
    const start = batch.ringOffsets[r];
    const end = batch.ringOffsets[r + 1];
    const n = ringOpenCount(batch.positions, start, end);
    if (n < 3) continue;
    vertexCount += n + 1;
    triangleCount += n;
  }
  const positions = new Float64Array(vertexCount * 2);
  const vertexSourceIndex = new Uint32Array(vertexCount);
  const indices = new Uint32Array(triangleCount * 3);
  let v = 0;
  let t = 0;
  for (let r = 0; r < batch.ringCount; r++) {
    const start = batch.ringOffsets[r];
    const end = batch.ringOffsets[r + 1];
    const n = ringOpenCount(batch.positions, start, end);
    if (n < 3) continue;
    const source = batch.sourceIndices[r];
    const base = v;
    v++; // reserve the centroid slot
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const x = batch.positions[(start + i) * 2];
      const y = batch.positions[(start + i) * 2 + 1];
      positions[v * 2] = x;
      positions[v * 2 + 1] = y;
      vertexSourceIndex[v] = source;
      cx += x;
      cy += y;
      v++;
    }
    positions[base * 2] = cx / n;
    positions[base * 2 + 1] = cy / n;
    vertexSourceIndex[base] = source;
    for (let i = 0; i < n; i++) {
      indices[t++] = base;
      indices[t++] = base + 1 + i;
      indices[t++] = base + 1 + ((i + 1) % n);
    }
  }
  return { positions, indices, vertexSourceIndex };
}

/** Distinct vertex count of the ring occupying vertices `[start, end)`. */
function ringOpenCount(
  positions: Float64Array,
  start: number,
  end: number,
): number {
  const n = end - start;
  if (n < 2) return n;
  const closed =
    positions[start * 2] === positions[(end - 1) * 2] &&
    positions[start * 2 + 1] === positions[(end - 1) * 2 + 1];
  return closed ? n - 1 : n;
}
