// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * CARTO **Quadbin** cell maths — the id → boundary-ring half of the
 * `quadbinSummary` kind, and the exact Quadbin counterpart of
 * `lib/summary-cells.ts`'s `h3IndexFromU64` + {@link h3BoundaryResolver} pair.
 *
 * `lib/summary-cells.ts` is generic over "a function from cell id to a boundary
 * ring" ({@link CellBoundaryResolver}) precisely so a second cell family costs
 * one small module and no branching. This is that module: everything after the
 * first arrow of
 *
 *   cell id (u64) → boundary ring (lon/lat °) → ECEF ring → coloured instance
 *
 * is shared with the H3 layer, unmodified.
 *
 * ## Why Quadbin needs no injected library and H3 does
 *
 * An H3 boundary is icosahedral geometry only `h3-js` can produce, so
 * `STTH3SummaryLayer` REQUIRES an injected `cellToBoundary`. A Quadbin id is
 * just a slippy-map `(z, x, y)` address in a bit field, and a slippy tile's
 * lon/lat box is four lines of arithmetic — so this layer has no injection
 * point, no required option, and still adds nothing to the package's single
 * runtime dependency (`@poopdeck.gl/core`).
 *
 * ## The CARTO Quadbin u64 layout (bits, MSB→LSB)
 *
 * ```
 *   63       : reserved (0)
 *   62 .. 60 : header = 0b100   — the Quadbin marker
 *   59       : mode   = 1       — "tile" mode
 *   58 .. 57 : mode-dependent = 0
 *   56 .. 52 : zoom z (5 bits, 0..26)
 *   51 ..  0 : 52-bit interleaved (Morton) x/y, LEFT-aligned for the cell's
 *              zoom; the low (52 − 2z) bits are a 1…1 fill so distinct cells
 *              stay distinct as fixed-width integers.
 * ```
 *
 * The decode is byte-for-byte the one in `@poopdeck.gl/layers`
 * `lib/quadbin-cell.ts`, `@poopdeck.gl/three` `lib/quadbin-cell.ts` and
 * `@poopdeck.gl/maplibre` `lib/cell-geometry.ts`. It is repeated here for the
 * same reason those three repeat each other: this package depends on
 * `@poopdeck.gl/core` alone, and none of those modules lives in core yet —
 * importing one would drag in deck, three or maplibre. Core is the right
 * long-term home; when it lands, all four call sites collapse into it. The
 * canonical CARTO vector `(0,0,0) → 0x480fffffffffffff` is pinned in this
 * package's tests, as it is in theirs.
 *
 * The Rust builder bakes summary cells at `build_zoom + QUADBIN_RES_OFFSET`;
 * that offset is already inside the id's own zoom field, so decoding is
 * offset-agnostic and this module never needs to know the tile it came from.
 *
 * ## Zero Cesium imports, on purpose
 *
 * Like every `lib/` module here this is pure and Cesium-free, so it is
 * unit-testable in plain Node and shared with any future backend. The layer
 * turns its rings into `Cartesian3`s; this file never sees one.
 */

/** A decoded Quadbin tile address. */
export interface QuadbinTile {
  /** Zoom level, 0..{@link QUADBIN_MAX_ZOOM}. */
  z: number;
  /** Tile column, 0..2^z − 1, counting EAST from −180°. */
  x: number;
  /** Tile row, 0..2^z − 1, counting SOUTH from the mercator north edge. */
  y: number;
}

/** Highest zoom the 52-bit Morton field can address (2 bits per level). */
export const QUADBIN_MAX_ZOOM = 26;

/**
 * The top 5 bits (63..59) of every tile-mode Quadbin: `0` reserved, `0b100`
 * header, `1` mode. An id whose prefix differs is not a Quadbin — an H3 index,
 * a raw feature id, a corrupt value — and is rejected rather than decoded into
 * a plausible-looking cell somewhere in the Pacific.
 */
const QUADBIN_PREFIX = 0b01001n;

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
 * True when `id` carries the Quadbin header, mode bit and an in-band zoom.
 *
 * This is a CHEAP structural check, not a proof of provenance: it exists so a
 * mis-built archive (an H3 summary tier pointed at this layer) is reported as
 * skipped rows rather than drawn as garbage.
 */
export function isQuadbinId(id: bigint): boolean {
  if (id < 0n || id >> 64n !== 0n) return false;
  if (id >> 59n !== QUADBIN_PREFIX) return false;
  const z = Number((id >> 52n) & 0x1fn);
  return z >= 0 && z <= QUADBIN_MAX_ZOOM;
}

/**
 * Decode a CARTO Quadbin u64 into its `(z, x, y)` tile address.
 *
 * Assumes a well-formed id; call {@link isQuadbinId} first if the source is
 * untrusted ({@link quadbinBoundaryResolver} does).
 */
export function quadbinToTile(quadbin: bigint): QuadbinTile {
  const z = Number((quadbin >> 52n) & 0x1fn);
  // The 52-bit interleaved payload is left-aligned: the cell's significant
  // bits occupy the TOP 2z bits, so shift the dead low fill out.
  const mortonShift = BigInt(52 - 2 * z);
  const interleaved = (quadbin & ((1n << 52n) - 1n)) >> mortonShift;
  return {
    z,
    x: deinterleave(interleaved),
    y: deinterleave(interleaved >> 1n),
  };
}

/**
 * A FRACTIONAL slippy-tile coordinate → `[lng, lat]` degrees: the exact inverse
 * of Web Mercator (`lat = atan(sinh(π(1 − 2y/2^z)))`), matching
 * `@math.gl/web-mercator`'s `worldToLngLat` and the deck/three/maplibre ports.
 * Kept local so this module stays dependency-free.
 */
function tileFracToLngLat(z: number, xf: number, yf: number): [number, number] {
  const n = 2 ** z;
  const lng = (xf / n) * 360 - 180;
  const lat =
    (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * yf) / n)));
  return [lng, lat];
}

/**
 * `[west, south, east, north]` degree bounds of a Quadbin cell.
 *
 * No `coverage` argument on purpose: `buildSummaryCells` insets every ring
 * toward its own centroid AFTER this, so the H3 and Quadbin kinds shrink by
 * exactly the same rule (see the layer header for how that differs from deck).
 */
export function quadbinTileToLngLatBounds(
  tile: QuadbinTile,
): [number, number, number, number] {
  const [west, north] = tileFracToLngLat(tile.z, tile.x, tile.y);
  const [east, south] = tileFracToLngLat(tile.z, tile.x + 1, tile.y + 1);
  return [west, south, east, north];
}

/**
 * No ring segment may span more than this many degrees of longitude.
 *
 * `buildSummaryCells` unwraps a ring by placing each vertex within ±180° of its
 * PREDECESSOR — the standard antimeridian defence. A cell wider than 180°
 * (Quadbin z0 is the whole world, z1 a half of it) would hit that rule on its
 * own south edge and fold east back onto west, collapsing the cell to a
 * zero-width sliver. Densifying the horizontal edges keeps every step
 * comfortably inside the rule, and costs nothing from z2 up (a z2 cell spans
 * 90°, so it still emits exactly four corners).
 */
export const MAX_RING_SEGMENT_DEGREES = 90;

/**
 * One Quadbin cell → an OPEN ring of `[lng, lat]` degree pairs, wound
 * counter-clockwise seen from above (SW → SE → NE → NW).
 *
 * Open because `buildSummaryCells` drops a repeated first vertex anyway and
 * Cesium's polygon geometries close the ring themselves.
 *
 * A Quadbin cell is axis-aligned in mercator, so it can never straddle the
 * antimeridian and never encloses a pole (the mercator square's top and bottom
 * edges stop at ±85.051°). That is why this file has none of the seam and pole
 * machinery `@poopdeck.gl/maplibre` needs. The only wide-cell care needed is
 * {@link MAX_RING_SEGMENT_DEGREES}.
 *
 * ⚠ The z0 cell IS the whole world, and a region bounded by two whole parallels
 * is not a simple polygon on a sphere — no globe renderer can draw it as one
 * ring, and Cesium is no exception. The densified ring below at least survives
 * the unwrap instead of collapsing; it cannot make a whole-world cell
 * meaningful. Real archives never reach it: `stt-build` bakes summary cells at
 * `build_zoom + QUADBIN_RES_OFFSET`, so even a z0 tile carries cells several
 * zooms finer.
 */
export function quadbinCellRing(tile: QuadbinTile): [number, number][] {
  const [w, s, e, n] = quadbinTileToLngLatBounds(tile);
  const steps = Math.max(1, Math.ceil((e - w) / MAX_RING_SEGMENT_DEGREES));
  const ring: [number, number][] = [];
  // South edge west → east, then north edge east → west. At `steps === 1` —
  // every cell from z2 down — this is exactly the four corners.
  for (let i = 0; i <= steps; i++) ring.push([w + ((e - w) * i) / steps, s]);
  for (let i = steps; i >= 0; i--) ring.push([w + ((e - w) * i) / steps, n]);
  return ring;
}

/**
 * The Quadbin {@link CellBoundaryResolver}: u64 → boundary ring, or `null` for
 * an id this family cannot decode.
 *
 * `null` is how `buildSummaryCells` counts a row as SKIPPED — one bad row skips
 * one cell and shows up in the diagnostics, rather than blanking the tile or
 * painting a cell in the wrong hemisphere. Point an H3 archive at this layer
 * and every row lands here, which is exactly the loud failure you want.
 */
export function quadbinBoundaryResolver(): (
  cellId: bigint,
) => readonly (readonly number[])[] | null {
  return (cellId: bigint) => {
    if (!isQuadbinId(cellId)) return null;
    // No range check on x/y is possible or needed: the Morton field is
    // left-aligned, so de-interleaving 2z bits yields at most z bits per axis —
    // any id that passes `isQuadbinId` is already inside its own zoom's grid.
    return quadbinCellRing(quadbinToTile(cellId));
  };
}
