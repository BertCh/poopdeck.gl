// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * CARTO Quadbin cell-index helpers — the Quadbin analog of h3-js's
 * `splitLongToH3Index`, used by {@link QuadbinSummaryLayer}.
 *
 * BACKGROUND: the STT summary tier can index cells by either Uber H3 or CARTO
 * Quadbin (see `SummaryScheme` in crates/stt-core/src/metadata.rs, documented
 * there as *"CARTO Quadbin (Z/X/Y quad-key encoded as u64)"*). The Arrow `id`
 * UInt64 column carries the cell index verbatim for BOTH schemes; the TS
 * decoder preserves it on `BinaryFeatures.featureIds64` (tile.ts: *"the ID IS
 * the H3/quadbin cell index"*). H3SummaryLayer turns that u64 into an h3-js
 * hex-string; this module turns it into the Bing **quadkey string** that
 * deck.gl's `QuadkeyLayer` (`@deck.gl/geo-layers`) consumes via `getQuadkey`.
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
 * Decoding recovers `(z, x, y)`; the Bing quadkey is then the base-4 path from
 * the root tile to that (z, x, y), one digit per zoom level — exactly the
 * string `QuadkeyLayer.getQuadkey` expects (`"0"`, `"21"`, `"130"`, …).
 *
 * This is a pure, dependency-free port of CARTO's `quadbin → tile → quadkey`
 * path, kept small and unit-tested so the renderer can stay a thin wrapper.
 */

/** A decoded Quadbin tile address. */
export interface QuadbinTile {
  z: number;
  x: number;
  y: number;
}

/** Mask off the low `n` bits of a BigInt (n ≤ 64). */
function lowBits(v: bigint, n: number): bigint {
  return v & ((1n << BigInt(n)) - 1n);
}

/**
 * De-interleave a Morton-coded 32-bit value into its even-bit (x) component.
 * The CARTO reference uses this magic-number bit-spread for the 52-bit field;
 * we operate on the already zoom-shifted 2z-bit value, so 32 bits is ample
 * (Quadbin tops out at z=26 → 52 interleaved bits, but `x`/`y` each ≤ 26 bits).
 */
function deinterleave(coded: bigint): number {
  // Keep only even bits, then compact them down.
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
 *
 * Mirrors CARTO's `quadbinToTile`: pull the 5-bit zoom out of bits 52..56,
 * right-shift the 52-bit Morton field down to its `2z` significant bits, then
 * de-interleave the even/odd bits into `x`/`y`.
 */
export function quadbinToTile(quadbin: bigint): QuadbinTile {
  const z = Number((quadbin >> 52n) & 0x1fn);
  // The 52-bit interleaved payload is left-aligned: the cell's significant
  // bits occupy the TOP 2z bits, so shift the dead low fill out.
  const mortonShift = BigInt(52 - 2 * z);
  const interleaved = lowBits(quadbin, 52) >> mortonShift;
  const x = deinterleave(interleaved);
  const y = deinterleave(interleaved >> 1n);
  return { z, x, y };
}

/**
 * Convert a `(z, x, y)` tile address into its Bing **quadkey string** — the
 * base-4 path from the root tile, one digit (0..3) per zoom level. This is the
 * exact form `QuadkeyLayer.getQuadkey` expects. The root tile (`z === 0`)
 * yields the empty string, matching deck's quadkey convention.
 */
export function tileToQuadkey({ z, x, y }: QuadbinTile): string {
  let quadkey = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quadkey += String(digit);
  }
  return quadkey;
}

/**
 * Convert the BigUint64 CARTO Quadbin cell index at row `i` into the Bing
 * quadkey string `QuadkeyLayer` consumes — the Quadbin counterpart of
 * H3SummaryLayer's `h3IndexFromTile`. Returns `null` for an out-of-range
 * index or a malformed (out-of-band zoom) id so the caller can skip the cell.
 *
 * The Rust builder packs the Quadbin u64 into the Arrow `id` UInt64 column;
 * the TS decoder copies it into `binary.featureIds64` so the full 64 bits
 * survive (the 32-bit `featureIds` mirror would truncate the high bits).
 */
export function quadkeyFromTile(
  featureIds64: BigUint64Array | undefined,
  i: number,
): string | null {
  if (!featureIds64 || i >= featureIds64.length) return null;
  const tile = quadbinToTile(featureIds64[i]);
  // Guard a corrupt / non-Quadbin id: zoom 0..26 is the valid Quadbin band.
  if (tile.z < 0 || tile.z > 26) return null;
  return tileToQuadkey(tile);
}
