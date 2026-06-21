// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Hexagon disk-envelope geometry for surfel splatting — the Three port of the
 * deck `SplatPrimitiveLayer` HEX_CORNERS.
 *
 * The envelope is a flat hexagon whose **inscribed circle is the unit disk**
 * (incircle radius 1 ⇒ circumradius `2/√3 ≈ 1.1547`). The vertex `(u,v)` doubles
 * as the disk's radial coordinate: `r² = u²+v²` is 0 at centre, 1 at the disk
 * rim, and `> 1` only in the six corner slivers (which the fragment discards).
 * So the visible disk is pixel-identical to a quad's, but ~13% fewer fragments
 * enter the shader — pure overdraw win.
 *
 * Returned as an `InstancedBufferGeometry`: the caller sets `instanceCount` and
 * attaches per-surfel instanced attributes (centre, quaternion, scale, colour,
 * start time, dynamic flag); the surfel material's `positionNode` expands each
 * instance's hexagon in its oriented tangent plane.
 */

import { InstancedBufferGeometry, Float32BufferAttribute } from 'three';

/** Circumradius for an incircle of 1. */
export const HEX_CIRCUMRADIUS = 2 / Math.sqrt(3);

/** The six hexagon corners (u,v) in angular order, z = 0 (the disk's local frame). */
export function hexCornerPositions(): Float32Array {
  const out = new Float32Array(6 * 3);
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    out[k * 3] = HEX_CIRCUMRADIUS * Math.cos(a);
    out[k * 3 + 1] = HEX_CIRCUMRADIUS * Math.sin(a);
    out[k * 3 + 2] = 0;
  }
  return out;
}

/** Triangle-fan indices over the convex hexagon (4 triangles, 6 shared corners). */
export const HEX_FAN_INDICES = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5];

/**
 * Build the shared hexagon disk geometry. One geometry instance per surfel layer;
 * the material reads the corner via `positionGeometry.xy`.
 */
export function makeHexDiskGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(hexCornerPositions(), 3));
  geometry.setIndex(HEX_FAN_INDICES);
  return geometry;
}
