// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Unit extruded-prism geometry for the column layer — the Three analogue of
 * deck `STTColumnLayer`'s `diskResolution`-sided disk swept into a 3D bar.
 *
 * The prism is a regular `sides`-gon of **incircle radius 1** in the local XY
 * plane (matching STTColumnLayer's "radius" = inscribed circle), extruded along
 * local +Z from `z = 0` (the foot) to `z = 1` (the top). The column layer scales
 * & orients this unit prism per-instance: `basisX`/`basisY` carry the world east/
 * north × metric radius, `basisZ` carries world up × metric height, so XY → ground
 * disk and Z → column height with the geometry untouched.
 *
 * Returned as an `InstancedBufferGeometry` carrying `position` + `normal`
 * (object-space; the material rotates normals into world space via the same
 * per-instance basis so the standard/lambert lighting reads correctly). The
 * caller sets `instanceCount` and attaches the per-instance attributes.
 *
 * Topology: `sides` quad side-walls (2 tris each) + a `sides`-fan top cap. No
 * bottom cap — the foot sits on the ground and is never seen, saving `sides`
 * triangles (same call deck.gl makes for `extruded` columns).
 */

import { InstancedBufferGeometry, Float32BufferAttribute } from 'three';

/** Incircle (inscribed-circle) radius of 1 ⇒ circumradius `1/cos(π/sides)`. */
export function circumradiusForIncircle(sides: number): number {
  return 1 / Math.cos(Math.PI / sides);
}

export interface ColumnPrismGeometry {
  geometry: InstancedBufferGeometry;
  /** Vertex count (for tests / draw-range sanity). */
  vertexCount: number;
}

/**
 * Build the shared unit-prism geometry with `sides` faces (≥ 3).
 *
 * @param sides  number of disk faces (deck `diskResolution`); clamped to ≥ 3.
 * @param angle  disk rotation in radians (deck `angle`, CCW). @default 0
 */
export function makeColumnPrismGeometry(
  sides: number,
  angle = 0,
): ColumnPrismGeometry {
  const n = Math.max(3, Math.floor(sides));
  const R = circumradiusForIncircle(n);

  // Ring corner unit positions in XY (z filled per ring below).
  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = angle + (k / n) * Math.PI * 2;
    cx[k] = R * Math.cos(a);
    cy[k] = R * Math.sin(a);
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  // ── Side walls: one quad per face (4 unique verts, outward face normal). ──
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    // Outward normal = the face-midpoint direction (flat-shaded sides).
    const nx = (cx[k] + cx[k2]) / 2;
    const ny = (cy[k] + cy[k2]) / 2;
    const nl = Math.hypot(nx, ny) || 1;
    const onx = nx / nl;
    const ony = ny / nl;

    const base = positions.length / 3;
    // bottom-k, bottom-k2, top-k2, top-k
    positions.push(cx[k], cy[k], 0);
    positions.push(cx[k2], cy[k2], 0);
    positions.push(cx[k2], cy[k2], 1);
    positions.push(cx[k], cy[k], 1);
    for (let v = 0; v < 4; v++) normals.push(onx, ony, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // ── Top cap: fan around the top ring (normal = +Z up). ──
  const capBase = positions.length / 3;
  positions.push(0, 0, 1);
  normals.push(0, 0, 1);
  for (let k = 0; k < n; k++) {
    positions.push(cx[k], cy[k], 1);
    normals.push(0, 0, 1);
  }
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    indices.push(capBase, capBase + 1 + k, capBase + 1 + k2);
  }

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    'normal',
    new Float32BufferAttribute(new Float32Array(normals), 3),
  );
  geometry.setIndex(indices);

  return { geometry, vertexCount: positions.length / 3 };
}
