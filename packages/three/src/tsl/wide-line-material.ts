// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `WideLineMaterial` — screen-pixel-width lines/ribbons, the Three port of deck's
 * `PathLayer` / `AnimatedTripsLayer` / `AnimatedLineLayer` / `FlowCorridorLayer`
 * wide-line rendering. No Three primitive draws constant-pixel-width lines (GL
 * `LineSegments` is 1px), so each line segment is one instance of a
 * {@link makeSegmentQuadGeometry} quad that the **vertex stage expands to width
 * in screen space**: both endpoints go to clip space, the screen-space segment
 * direction gives a perpendicular, and the quad's `side` corner is pushed
 * `widthPx/2` pixels along it (converted back through `clip.w` so width is
 * constant on screen regardless of depth).
 *
 * Time modes (shared {@link timeFilterAlphaNode}):
 *   • `window`  — whole-feature visibility over `[sttStart,sttEnd]` (Path/OD-Line).
 *   • `trail`   — per-vertex fade behind the playhead over `[cur-trail,cur]` using
 *                 the interpolated per-vertex time (Trips).
 *   • `none`    — always visible.
 * Colour interpolates per-vertex (`sttColorA`→`sttColorB`) for trip gradients.
 *
 * WGSL: the alpha is a `select()`, so it is computed in the FRAGMENT stage from
 * VARIED raw inputs — never wrapped in a `varying()` (the codebase's recurring
 * WGSL crash). `mix()` colour/time gradients ARE safe to vary.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending, AdditiveBlending } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
} from './nodes.js';
import {
  TimeFilterUniforms,
  windowAlphaNode,
  trailAlphaNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';

export type WideLineMode = 'window' | 'trail' | 'none';

export interface WideLineMaterialOptions {
  /** Time-filter mode. @default 'none' */
  mode?: WideLineMode;
  /** Additive blending (glowing trips/flows) vs normal alpha. @default false */
  additive?: boolean;
  /** Write depth (opaque-ish paths) vs not (translucent trails). @default false */
  depthWrite?: boolean;
  /** Discard fragments below this final alpha. @default 0.02 */
  alphaCutoff?: number;
}

/** Live wide-line uniforms: pixel width, opacity, and the canvas size in px. */
export class WideLineUniforms {
  readonly widthPx: UniformNode = uniform(2);
  readonly opacity: UniformNode = uniform(1);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

export interface WideLineMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  line: WideLineUniforms;
  mode: WideLineMode;
}

/**
 * Build a wide-line material. The layer attaches per-instance attributes
 * `sttPosA`/`sttPosB` (vec3, RTC-local), `sttColorA`/`sttColorB` (vec4 straight
 * RGBA 0..1), `sttStart`/`sttEnd` (float, window mode), `sttTimeA`/`sttTimeB`
 * (float, trail mode — relative ms), on a {@link makeSegmentQuadGeometry}.
 */
export function createWideLineMaterial(
  opts: WideLineMaterialOptions = {},
): WideLineMaterialBundle {
  const mode: WideLineMode = opts.mode ?? 'none';
  const time = new TimeFilterUniforms();
  const line = new WideLineUniforms();

  const posA = attribute('sttPosA', 'vec3');
  const posB = attribute('sttPosB', 'vec3');
  const along = positionGeometry.x; // 0 (A) .. 1 (B)
  const side = positionGeometry.y; // -1 .. +1

  // ── VERTEX: expand the segment to `widthPx` in screen space ─────────────────
  const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
  const clipA = mvp.mul(vec4(posA, 1));
  const clipB = mvp.mul(vec4(posB, 1));
  const ndcA = clipA.xy.div(clipA.w);
  const ndcB = clipB.xy.div(clipB.w);
  // Screen-space (pixel) direction of the segment, then its left normal.
  const dir = ndcB.sub(ndcA).mul(line.viewport).normalize();
  const perp = vec2(dir.y.negate(), dir.x);
  const clip = mix(clipA, clipB, along);
  // pixel half-offset (side·widthPx/2) → NDC (×2/viewport) → clip (×w).
  const off = perp.mul(side).mul(line.widthPx).div(line.viewport).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(off.x),
    clip.y.add(off.y),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: gradient colour + time alpha ──────────────────────────────────
  const colA = attribute('sttColorA', 'vec4');
  const colB = attribute('sttColorB', 'vec4');
  const vColor = varying(mix(colA, colB, along)); // gradient (mix is varying-safe)

  let alpha;
  if (mode === 'window') {
    const vStart = varying(attribute('sttStart', 'float'));
    const vEnd = varying(attribute('sttEnd', 'float'));
    alpha = windowAlphaNode(time, vStart, vEnd);
  } else if (mode === 'trail') {
    const tA = attribute('sttTimeA', 'float');
    const tB = attribute('sttTimeB', 'float');
    const vTime = varying(mix(tA, tB, along)); // per-vertex time gradient
    alpha = trailAlphaNode(time, vTime);
  } else {
    alpha = float(1);
  }

  material.colorNode = vColor.xyz;
  material.opacityNode = vColor.a.mul(line.opacity).mul(alpha);
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.side = DoubleSide;
  material.blending = opts.additive ? AdditiveBlending : NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.02;

  return { material, time, line, mode };
}

export interface WideLineUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  /** Full line width in CSS pixels. */
  widthPx?: number;
  opacity?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
}

/** Push the playhead + width/viewport into the uniforms. Call once per frame. */
export function updateWideLineUniforms(
  bundle: WideLineMaterialBundle,
  v: WideLineUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  if (v.widthPx !== undefined) bundle.line.widthPx.value = v.widthPx;
  if (v.opacity !== undefined) bundle.line.opacity.value = v.opacity;
  if (v.viewport) bundle.line.viewport.value.set(v.viewport[0], v.viewport[1]);
}
