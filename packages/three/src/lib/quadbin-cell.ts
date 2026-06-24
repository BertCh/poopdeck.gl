// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * CARTO Quadbin cell-index helpers for the Three renderer — the geometry-side
 * port of `@poopdeck.gl/layers`'s `lib/quadbin-cell.ts`. Where the deck version
 * decodes a Quadbin u64 → `(z, x, y)` → a Bing **quadkey string** for deck's
 * `QuadkeyLayer`, this version decodes the same u64 → `(z, x, y)` → the cell's
 * **lon/lat bounds** (a mercator quad) so the Three {@link QuadbinSummaryLayer}
 * can project + tessellate the cell itself (no QuadkeyLayer sublayer exists in
 * the Three world).
 *
 * THE CARTO QUADBIN u64 LAYOUT (bits, MSB→LSB, per the CARTO spec):
 * ```
 *   63        : reserved/sign (0)
 *   62 .. 60  : header   = 0b100  (value 4)   — Quadbin marker
 *   59        : mode     = 1                  — "tile" mode
 *   58 .. 57  : mode-dep = 0
 *   56 .. 52  : zoom z   (5 bits, 0..26)
 *   51 .. 0   : 52-bit interleaved (Morton) x/y, LEFT-aligned for the cell's
 *               zoom (the low (52 - 2z) bits are a `1…1` fill so distinct
 *               cells stay distinct as fixed-width integers).
 * ```
 *
 * Note on `QUADBIN_RES_OFFSET`: the Rust builder (`crates/stt-build/src/summary.rs`)
 * bakes summary cells at `build_zoom + QUADBIN_RES_OFFSET` (=3, clamped ≤26) so a
 * cell is finer than the tile that carries it — a 1:1 zoom map otherwise produces
 * camera-engulfing giant cells. That offset is baked into the u64 itself (its zoom
 * field already includes it), so decode is offset-agnostic: we just read whatever
 * zoom the cell declares. No adjustment here.
 *
 * This is a pure, dependency-free port (BigInt only); GPU-free and unit-tested.
 */

/** A decoded Quadbin tile address. */
export interface QuadbinTile {
  z: number;
  x: number;
  y: number;
}

/** lon/lat (degrees) bounds of a cell — `[west, south, east, north]`. */
export interface CellBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Mask off the low `n` bits of a BigInt (n ≤ 64). */
function lowBits(v: bigint, n: number): bigint {
  return v & ((1n << BigInt(n)) - 1n);
}

/**
 * De-interleave a Morton-coded value into its even-bit (x) component. Operates
 * on the already zoom-shifted 2z-bit value (Quadbin tops out at z=26 → 52
 * interleaved bits, but `x`/`y` each ≤ 26 bits).
 */
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
 * Decode a CARTO Quadbin u64 (as a BigInt) into its `(z, x, y)` tile address.
 * Mirrors CARTO's `quadbinToTile` (and the deck port): pull the 5-bit zoom out
 * of bits 52..56, right-shift the 52-bit Morton field down to its `2z`
 * significant bits, then de-interleave the even/odd bits into `x`/`y`.
 */
export function quadbinToTile(quadbin: bigint): QuadbinTile {
  const z = Number((quadbin >> 52n) & 0x1fn);
  const mortonShift = BigInt(52 - 2 * z);
  const interleaved = lowBits(quadbin, 52) >> mortonShift;
  const x = deinterleave(interleaved);
  const y = deinterleave(interleaved >> 1n);
  return { z, x, y };
}

/**
 * Web-Mercator slippy-map tile `(z, x, y)` → its lon/lat bounds (degrees). The
 * standard XYZ tile scheme: longitude is linear in x, latitude is the inverse
 * Gudermannian of a linear function of y. Y increases southward (so `y` →
 * `north` edge, `y+1` → `south` edge). This is the exact bbox deck's
 * `QuadkeyLayer` derives from the same quadkey via tile2lng/tile2lat.
 */
export function tileToBounds({ z, x, y }: QuadbinTile): CellBounds {
  const n = Math.pow(2, z);
  const lng = (xx: number) => (xx / n) * 360 - 180;
  const lat = (yy: number) => {
    const r = Math.PI - (2 * Math.PI * yy) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(r) - Math.exp(-r)));
  };
  return {
    west: lng(x),
    east: lng(x + 1),
    north: lat(y),
    south: lat(y + 1),
  };
}

/**
 * Decode the CARTO Quadbin cell index at row `i` of a BigUint64 column directly
 * into its lon/lat {@link CellBounds}. Returns `null` for an out-of-range index
 * or a malformed (out-of-band zoom) id so the caller can skip the cell.
 *
 * The Rust builder packs the Quadbin u64 into the Arrow `id` UInt64 column; the
 * TS decoder copies it into `binary.featureIds64` so the full 64 bits survive
 * (the 32-bit `featureIds` mirror would truncate the high bits).
 */
export function cellBoundsFromTile(
  featureIds64: BigUint64Array | undefined,
  i: number,
): CellBounds | null {
  if (!featureIds64 || i >= featureIds64.length) return null;
  const tile = quadbinToTile(featureIds64[i]);
  // Guard a corrupt / non-Quadbin id: zoom 0..26 is the valid Quadbin band.
  if (tile.z < 0 || tile.z > 26) return null;
  return tileToBounds(tile);
}
