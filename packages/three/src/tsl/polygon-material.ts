// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `PolygonMaterial` — the TSL port of deck's `AnimatedPolygonLayer` fill (a
 * GPU-time-windowed `SolidPolygonLayer`). The filled mesh from
 * {@link buildPolygonBuffers} is shaded by its per-vertex `sttColor` and, in
 * `window` mode, faded in/out around the playhead by the per-vertex
 * `[sttStart, sttEnd]` window. `none` mode is the shipped static map-polygon
 * behaviour — a constant per-frame alpha, no time filter.
 *
 * A `MeshBasicNodeMaterial` (node material → WebGPU + WebGL2 fallback) gives us
 * the `opacityNode` the window needs, unlike `MeshBasicMaterial`.
 *
 * IMPORTANT (WGSL): we vary the RAW per-vertex inputs (`sttColor`, `sttStart`,
 * `sttEnd`) and compute the window alpha — a `select()` — in the FRAGMENT stage.
 * A `select()` wrapped in a `varying()` fails to build on the WGSL backend (see
 * `iso-line-material.ts` / `surfel-material.ts`); the alpha node must never be
 * varied. `none` mode never even builds the select.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending } from 'three';
import { attribute, varying, uniform, float } from './nodes';
import type { UniformNode } from './nodes';
import { TimeFilterUniforms, windowAlphaNode, updateTimeFilterUniforms } from './time-filter';
import type { TimeFilterParams } from './time-filter-math';

export type PolygonTimeMode = 'window' | 'none';

export interface PolygonMaterialOptions {
  /** `window` time-filters by `[sttStart,sttEnd]`; `none` is static. @default 'none' */
  mode?: PolygonTimeMode;
  /** Discard fragments below this final alpha. @default 0.004 */
  alphaCutoff?: number;
  /** Write depth (opaque-ish fills). @default false (ground decals) */
  depthWrite?: boolean;
}

export interface PolygonUniforms {
  /** Layer opacity multiplier. */
  opacity: UniformNode;
}

export interface PolygonMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  poly: PolygonUniforms;
}

/**
 * Create a polygon fill material. The layer attaches per-vertex attributes
 * `sttColor` (vec4, straight RGBA 0..1) and (in `window` mode) `sttStart` /
 * `sttEnd` (float, relative ms).
 */
export function createPolygonMaterial(opts: PolygonMaterialOptions = {}): PolygonMaterialBundle {
  const mode = opts.mode ?? 'none';
  const time = new TimeFilterUniforms();
  const opacity = uniform(1);

  const colorAttr = attribute('sttColor', 'vec4');
  const vColor = varying(colorAttr);

  let alpha;
  if (mode === 'window') {
    // Vary the raw inputs; compute the window alpha (a select) in the fragment.
    const vStart = varying(attribute('sttStart', 'float'));
    const vEnd = varying(attribute('sttEnd', 'float'));
    alpha = windowAlphaNode(time, vStart, vEnd);
  } else {
    alpha = float(1);
  }

  const material = new MeshBasicNodeMaterial();
  material.colorNode = vColor.xyz;
  material.opacityNode = vColor.a.mul(opacity).mul(alpha);
  material.transparent = true;
  material.side = DoubleSide;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.004;

  return { material, time, poly: { opacity } };
}

export interface PolygonUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  opacity?: number;
}

/** Push the playhead + window params into the polygon uniforms. Call once per frame. */
export function updatePolygonUniforms(bundle: PolygonMaterialBundle, v: PolygonUniformValues): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.poly.opacity.value = v.opacity ?? 1;
}
