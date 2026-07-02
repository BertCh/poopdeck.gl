// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `IsoLineMaterial` — the TSL port of deck's `AnimatedPathLayer` for the AV
 * density iso-line modes (`lidarIso` / `lidarIso3d`). Each contour LineString is
 * drawn as window-filtered `LineSegments`: a segment is visible only while its
 * `[sttStart, sttEnd]` overlaps the playhead window, fading at the edges, and is
 * coloured by the per-vertex `density_band` ramp colour.
 *
 * A `LineBasicNodeMaterial` (node material → WebGPU + WebGL2 fallback) gives us
 * an `opacityNode` for the time window, unlike `LineBasicMaterial`. GL line width
 * is 1px (the GL limitation), which matches deck's `widthMinPixels: 1` for iso.
 *
 * IMPORTANT (WGSL): we vary the RAW per-vertex inputs (`sttColor`, `sttStart`,
 * `sttEnd`) and compute the window alpha — a `select()` — in the FRAGMENT stage.
 * A `select()` wrapped in a `varying()` fails to build on the WGSL backend (see
 * `surfel-material.ts`), so the alpha node must never be varied.
 */

import { LineBasicNodeMaterial } from 'three/webgpu';
import { NormalBlending } from 'three';
import { attribute, varying, uniform } from './nodes.js';
import type { UniformNode } from './nodes.js';
import { TimeFilterUniforms, windowAlphaNode, updateTimeFilterUniforms } from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';

export interface IsoLineMaterialOptions {
  /** Discard fragments below this final alpha. @default 0.02 */
  alphaCutoff?: number;
}

export interface IsoLineUniforms {
  /** Layer opacity multiplier. */
  opacity: UniformNode;
}

export interface IsoLineMaterialBundle {
  material: LineBasicNodeMaterial;
  time: TimeFilterUniforms;
  iso: IsoLineUniforms;
}

/**
 * Create an iso-line material. The layer attaches per-vertex attributes
 * `sttColor` (vec4, straight RGBA 0..1), `sttStart` / `sttEnd` (float, relative
 * ms). All vertices of a contour share the contour's time window.
 */
export function createIsoLineMaterial(opts: IsoLineMaterialOptions = {}): IsoLineMaterialBundle {
  const time = new TimeFilterUniforms();
  const opacity = uniform(0.95);

  const colorAttr = attribute('sttColor', 'vec4');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');

  // Vary the raw inputs; compute the window alpha (a select) in the fragment.
  const vColor = varying(colorAttr);
  const vStart = varying(start);
  const vEnd = varying(end);
  const alpha = windowAlphaNode(time, vStart, vEnd);

  const material = new LineBasicNodeMaterial();
  material.colorNode = vColor.xyz;
  material.opacityNode = vColor.a.mul(opacity).mul(alpha);
  material.transparent = true;
  material.depthTest = true;
  // Thin translucent topographic overlay — don't write depth (no self-occlusion
  // artifacts as contours fade in/out, and the terraced iso3d stack reads clean).
  material.depthWrite = false;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.02;

  return { material, time, iso: { opacity } };
}

export interface IsoLineUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  opacity?: number;
}

/** Push the playhead + window params into the iso uniforms. Call once per frame. */
export function updateIsoLineUniforms(bundle: IsoLineMaterialBundle, v: IsoLineUniformValues): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.iso.opacity.value = v.opacity ?? 0.95;
}
