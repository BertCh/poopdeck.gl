// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The 9-vertex (3-triangle) tapered half-arrow template as an
 * `InstancedBufferGeometry` — the base for {@link createFlowArrowMaterial}, the
 * Three port of deck's `FlowLinesLayer` (itself a port of flowmap.gl's
 * `FlowLinesLayer`). Each OD flow is ONE instance; the vertex stage extrudes
 * this template in screen space into a straight shaft that tapers into a
 * triangular arrowhead at the destination.
 *
 * Each vertex is `(mix, perpendicular, alongTravel)` in WIDTH units:
 *   • `position.x` — lerp factor source(0) → target(1) along the centreline
 *   • `position.y` — perpendicular offset (all ≥ 0 ⇒ a HALF arrow, one side of
 *     the centreline)
 *   • `position.z` — along-travel offset (negative ⇒ pulled back toward source)
 *
 * Verts 1/2 (perp 2 / 1, travel −3) form the arrowhead flaring back from the
 * target tip; verts 3..8 form the shaft from the source. Topology: triangle-list
 * (9 verts → 3 triangles, no index). Identical layout to the deck primitive's
 * `ARROW_TEMPLATE_POSITIONS` so the geometry math is a 1:1 port.
 */

import { InstancedBufferGeometry, Float32BufferAttribute } from 'three';

/** The raw 9-vertex (`mix, perpendicular, alongTravel`) arrow template values. */
// prettier-ignore
export const ARROW_TEMPLATE_POSITIONS = [
  1, 0, 0,
  1, 2, -3,
  1, 1, -3,
  1, 0, 0,
  1, 1, -3,
  0, 1, 0,
  1, 0, 0,
  0, 1, 0,
  0, 0, 0,
];

/** Build the instanced tapered-arrow template geometry (one instance per flow). */
export function makeArrowTemplateGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(new Float32Array(ARROW_TEMPLATE_POSITIONS), 3),
  );
  return geometry;
}
