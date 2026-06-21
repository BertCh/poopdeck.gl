// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * 12-edge oriented-cuboid outline geometry, in the local ENU metric world.
 *
 * Because the world is already ENU metres, a box's metric corners are added
 * DIRECTLY to its projected centre (no lon/lat reconversion like the deck layer):
 * yaw rotates the (length, width) footprint in the X(east)/Y(north) plane, the
 * box rises from its centre altitude `cz` to `cz + height` in Z(up).
 *
 *   east  = lx·cosθ − ly·sinθ
 *   north = lx·sinθ + ly·cosθ
 *
 * Output is a flat triple buffer of the 12 edges (24 vertices) ready for a
 * `LineSegments`.
 */

/** Unit cuboid corners: (sx, sy, sz) with sx,sy ∈ {−1,1} (footprint), sz ∈ {0,1} (height). */
export const BOX_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, 0],
  [1, -1, 0],
  [1, 1, 0],
  [-1, 1, 0],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

/** The 12 true box edges (4 bottom, 4 top, 4 vertical) as corner-index pairs. */
export const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** Floats written per box (12 edges × 2 endpoints × 3 components). */
export const FLOATS_PER_BOX = BOX_EDGES.length * 2 * 3;

/**
 * Write one oriented box's 12 edges into `out` starting at float index `offset`.
 * `heading` is radians (0 = +X/east, CCW); NaN ⇒ axis-aligned. Returns the next
 * free float index.
 */
export function writeBoxEdges(
  out: Float32Array,
  offset: number,
  cx: number,
  cy: number,
  cz: number,
  heading: number,
  length: number,
  width: number,
  height: number,
): number {
  const c = Number.isFinite(heading) ? Math.cos(heading) : 1;
  const s = Number.isFinite(heading) ? Math.sin(heading) : 0;
  const hx = length / 2;
  const hy = width / 2;

  const wx: number[] = new Array(8);
  const wy: number[] = new Array(8);
  const wz: number[] = new Array(8);
  for (let k = 0; k < 8; k++) {
    const corner = BOX_CORNERS[k];
    const lx = corner[0] * hx;
    const ly = corner[1] * hy;
    const lz = corner[2] * height;
    wx[k] = cx + (lx * c - ly * s);
    wy[k] = cy + (lx * s + ly * c);
    wz[k] = cz + lz;
  }

  let o = offset;
  for (const [a, b] of BOX_EDGES) {
    out[o++] = wx[a];
    out[o++] = wy[a];
    out[o++] = wz[a];
    out[o++] = wx[b];
    out[o++] = wy[b];
    out[o++] = wz[b];
  }
  return o;
}
