// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Unit segment quad as an `InstancedBufferGeometry` — the base for screen-pixel
 * width lines/ribbons (Trips, Path, OD-Line, FlowCorridor). Each line segment is
 * one instance; the quad is expanded to width in {@link createWideLineMaterial}'s
 * vertex stage.
 *
 * Vertex layout per the four corners:
 *   `position.x` ∈ {0,1} — parameter ALONG the segment (0 = endpoint A, 1 = B)
 *   `position.y` ∈ {-1,1} — SIDE of the centreline (scaled by half-width)
 */

import { InstancedBufferGeometry, Float32BufferAttribute } from 'three';

export function makeSegmentQuadGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  // prettier-ignore
  const corners = new Float32Array([
    0, -1, 0, // A, right
    1, -1, 0, // B, right
    1,  1, 0, // B, left
    0,  1, 0, // A, left
  ]);
  geometry.setAttribute('position', new Float32BufferAttribute(corners, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}
