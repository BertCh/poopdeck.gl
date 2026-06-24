// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * H3 cell-index helpers for the Three renderer — the geometry-side port of
 * `@poopdeck.gl/layers`'s `lib/summary/h3-summary-layer.ts` id-decode. Where the
 * deck version hands the H3 hex string straight to deck's `H3HexagonLayer`, this
 * version decodes the same u64 → the cell's **lon/lat boundary ring** (via
 * h3-js's `cellToBoundary`) so the Three {@link H3SummaryLayer} can project +
 * tessellate the cell itself (no H3HexagonLayer sublayer exists in the Three
 * world).
 *
 * THE H3 CELL INDEX is a 64-bit integer (mode + resolution + 7×3-bit base-cell
 * digits). The Rust builder packs it into the Arrow `id` UInt64 column; the TS
 * decoder copies the full 64 bits into `binary.featureIds64`. H3 cells at
 * resolution ≥ 7 need the full u64 (the high bits matter), so — exactly like the
 * deck layer — we read the BigUint64 column and split it into its low/high 32-bit
 * halves for h3-js's `splitLongToH3Index`. The 32-bit `featureIds` mirror would
 * truncate the high bits and is deliberately NOT used.
 *
 * A cell's boundary is a small ring of 5 (pentagon), 6 (hexagon), or 7
 * (icosahedron-edge distorted) lon/lat vertices. `cellToBoundary(idx, true)`
 * returns them in GeoJSON `[lng, lat]` order (degrees), which is what the
 * projection + tessellation downstream want.
 *
 * Pure + framework-free (BigInt + h3-js only); GPU-free and unit-tested.
 */

import { cellToBoundary, splitLongToH3Index } from 'h3-js';

/**
 * A decoded H3 cell boundary — a closed ring of lon/lat (degrees) vertices.
 * Length is 5 (pentagon), 6 (hexagon), or 7 (distorted) — the caller fans it.
 */
export interface H3Boundary {
  /** The canonical 15-char H3 index string the ring belongs to. */
  hex: string;
  /** `[lng, lat]` (degrees) vertices, CCW, in GeoJSON order (not closed). */
  ring: [number, number][];
}

/**
 * Convert the BigUint64 H3 cell index at row `i` into the canonical 15-char
 * hex-string form that h3-js consumes. Mirrors the deck layer's
 * `h3IndexFromTile`: split the u64 into its low/high 32-bit halves and feed them
 * to `splitLongToH3Index` (the high half carries the resolution + leading
 * base-cell digits, so it MUST be preserved). Returns `null` for an
 * out-of-range index.
 */
export function h3IndexFromTile(
  featureIds64: BigUint64Array | undefined,
  i: number,
): string | null {
  if (!featureIds64 || i >= featureIds64.length) return null;
  const v = featureIds64[i];
  const lower = Number(v & 0xffffffffn) >>> 0;
  const upper = Number((v >> 32n) & 0xffffffffn) >>> 0;
  return splitLongToH3Index(lower, upper);
}

/**
 * Decode the H3 cell index at row `i` of a BigUint64 column directly into its
 * lon/lat {@link H3Boundary}. Returns `null` for an out-of-range index or a
 * malformed / undecodable id (h3-js throws or yields an empty ring) so the
 * caller can skip the cell.
 *
 * The Rust builder packs the H3 u64 into the Arrow `id` UInt64 column; the TS
 * decoder copies it into `binary.featureIds64` so the full 64 bits survive
 * (the 32-bit `featureIds` mirror would truncate the high bits).
 */
export function cellBoundaryFromTile(
  featureIds64: BigUint64Array | undefined,
  i: number,
): H3Boundary | null {
  const hex = h3IndexFromTile(featureIds64, i);
  if (!hex) return null;
  let ring: [number, number][];
  try {
    // `true` → GeoJSON `[lng, lat]` order (degrees). h3-js throws on a
    // non-cell index; we swallow it and skip the cell.
    ring = cellToBoundary(hex, true) as [number, number][];
  } catch {
    return null;
  }
  if (!ring || ring.length < 3) return null;
  return { hex, ring };
}
