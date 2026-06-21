// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Unit quad (`corners ∈ [-1,1]²`) as an `InstancedBufferGeometry` — the base for
 * billboarded point splats. The corner `(u,v)` doubles as the radial coordinate
 * (`r² = u²+v²`), so the inscribed circle `r=1` is the rendered disc and the four
 * corners (`r²=2`) are discarded — same convention as the hexagon disk, just a
 * quad (points don't need the hexagon's overdraw trim).
 */

import { InstancedBufferGeometry, Float32BufferAttribute } from 'three';

export function makeBillboardQuadGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  // prettier-ignore
  const corners = new Float32Array([
    -1, -1, 0,
     1, -1, 0,
     1,  1, 0,
    -1,  1, 0,
  ]);
  geometry.setAttribute('position', new Float32BufferAttribute(corners, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}
