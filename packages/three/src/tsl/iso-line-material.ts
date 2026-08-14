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
 * HARD cut (VERTEX stage): the geometry position is multiplied by the hard
 * {@link windowVisibleNode} gate. Both endpoints of every `LineSegments` segment
 * share the contour's `[sttStart, sttEnd]` window (see `iso-layer.ts` — starts/
 * ends are written to both vertices of each segment), so an out-of-window contour
 * collapses each segment to a zero-length degenerate line at the local origin,
 * which rasterises no fragments — instead of relying on an alpha-cutoff fragment
 * discard (deck.gl #7509). In-window ⇒ ×1 (position untouched). The soft window
 * fade stays in `opacityNode`.
 *
 * IMPORTANT (WGSL): we vary the RAW per-vertex inputs (`sttColor`, `sttStart`,
 * `sttEnd`) and compute the SOFT window alpha — a `select()` — in the FRAGMENT
 * stage. A `select()` wrapped in a `varying()` fails to build on the WGSL backend
 * (see `surfel-material.ts`), so the alpha node must never be varied. The vertex
 * visibility gate is branch-free (`step()`).
 */

import { LineBasicNodeMaterial } from 'three/webgpu';
import { NormalBlending } from 'three';
import {
  attribute,
  varying,
  uniform,
  float,
  select,
  positionGeometry,
} from './nodes.js';
import { srgbToWorking } from './color-space.js';
import type { UniformNode } from './nodes.js';
import {
  TimeFilterUniforms,
  windowAlphaNode,
  windowVisibleNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
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
export function createIsoLineMaterial(
  opts: IsoLineMaterialOptions = {},
): IsoLineMaterialBundle {
  const time = new TimeFilterUniforms();
  const opacity = uniform(0.95);

  const colorAttr = attribute('sttColor', 'vec4');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');

  // Vary the raw inputs; compute the SOFT window alpha (a select) in the fragment.
  const vColor = varying(colorAttr);
  const vStart = varying(start);
  const vEnd = varying(end);
  const alpha = windowAlphaNode(time, vStart, vEnd);

  const material = new LineBasicNodeMaterial();
  // HARD vertex-stage collapse: out-of-window contours → zero-length segments at
  // the local origin (both endpoints share the window), rasterising no fragments.
  material.positionNode = positionGeometry.mul(
    windowVisibleNode(time, start, end),
  );
  material.colorNode = srgbToWorking(vColor.xyz);
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
export function updateIsoLineUniforms(
  bundle: IsoLineMaterialBundle,
  v: IsoLineUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.iso.opacity.value = v.opacity ?? 0.95;
}

// ── GPU id-buffer pick material (GPU picking catalog: iso variant) ───────────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Like polygon (and unlike the
// instanced kinds), iso-lines render as ONE merged `LineSegments` mesh, so the id
// is a PER-VERTEX attribute (`sttIdColor`, from `iso-layer.ts`): both endpoints of
// every segment of a contour carry the SAME colour, which encodes that contour's
// merged feature index — a readback on any of its pixels decodes to the one merged
// index. It reuses the SAME hard vertex-stage window collapse as the colour
// material (identical `positionNode`), so an out-of-window contour collapses to
// zero-length segments and is never pickable, exactly matching the eye. The id is
// opaque at full intensity; off-time fragments are discarded (opacity 0 +
// alphaTest). Bind {@link updateIsoLineUniforms} to sync the time uniform before
// the pass. Shape-compatible with {@link IsoLineMaterialBundle}.

/**
 * Build the iso-line id material. `opts` mirror the colour material's `alphaCutoff`
 * so the pick pass matches the on-screen contours (the id is a flat per-vertex
 * colour, opaque with depth-write so the front-most contour wins).
 */
export function createIsoLineIdMaterial(
  opts: IsoLineMaterialOptions = {},
): IsoLineMaterialBundle {
  const time = new TimeFilterUniforms();
  const opacity = uniform(0.95);

  const idColor = attribute('sttIdColor', 'vec3');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');

  const material = new LineBasicNodeMaterial();
  // SAME hard vertex-stage collapse as the colour material: out-of-window contours
  // → zero-length segments at the local origin, rasterising no fragments.
  material.positionNode = positionGeometry.mul(
    windowVisibleNode(time, start, end),
  );
  material.colorNode = varying(idColor);
  // FRAGMENT: opaque flat id wherever the segment is drawn AND on-time. The soft
  // window alpha is recomputed from VARIED raw inputs (never a varying-wrapped
  // select) and thresholded to a hard 0/1 pick alpha.
  const cutoff = opts.alphaCutoff ?? 0.02;
  const onGate = windowAlphaNode(
    time,
    varying(start),
    varying(end),
  ).greaterThan(float(cutoff));
  material.opacityNode = select(onGate, float(1), float(0));
  material.transparent = false;
  material.depthTest = true;
  material.depthWrite = true;
  material.blending = NormalBlending;
  material.alphaTest = 0.5;

  return { material, time, iso: { opacity } };
}
