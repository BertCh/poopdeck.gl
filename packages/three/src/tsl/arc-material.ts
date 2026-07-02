// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `ArcMaterial` — raised origin→destination arcs, the Three port of deck's
 * `AnimatedArcLayer` (`ArcLayer`). Each arc is ONE instance of a multi-segment
 * strip ({@link makeArcStripGeometry}, `N+1` samples × 2 sides) whose vertex
 * stage **tessellates the curve along `t ∈ [0,1]`**: the position is
 * interpolated between the per-instance source/target endpoints with a raised
 * height, then the ribbon is expanded to a constant `widthPx` in screen space
 * (the same screen-pixel trick as {@link createWideLineMaterial}).
 *
 * Two arc shapes (mirrors deck's `greatCircle`):
 *   • `parabolic` (default, mercator/ENU flat map) — linear XY interpolation with
 *     a parabolic lift in +Z proportional to the chord length: a flat raised arc.
 *   • `greatCircle` (globe) — spherical interpolation (slerp) of the two ECEF
 *     direction vectors, lifted radially by the same parabola. Endpoints arrive
 *     RTC-local; the absolute direction is reconstructed by adding the `origin`
 *     uniform back (slerp needs ~absolute vectors).
 *
 * Time mode is **window** (whole-feature on/off + fade, deck's window mode) —
 * arcs are OD flows, shown while `[sttStart, sttEnd]` overlaps the playhead
 * window. Colour gradients per-vertex from `sttColorSource`→`sttColorTarget`.
 *
 * WGSL: the window alpha is a `select()`, computed in the FRAGMENT stage from
 * VARIED raw inputs (`sttStart`/`sttEnd`) — never wrapped in a `varying()` (the
 * codebase's recurring WGSL crash). `mix()` colour gradients ARE varying-safe.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { InstancedBufferGeometry, Float32BufferAttribute } from 'three';
import { DoubleSide, NormalBlending, AdditiveBlending } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  mix,
  max,
  sqrt,
  modelViewMatrix,
  cameraProjectionMatrix,
  type TSLNode,
  type UniformNode,
} from './nodes.js';
import {
  TimeFilterUniforms,
  windowAlphaNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';

export type ArcShape = 'parabolic' | 'greatCircle';

export interface ArcMaterialOptions {
  /** parabolic flat-map raised arc | greatCircle spherical (globe). @default 'parabolic' */
  shape?: ArcShape;
  /** Additive blending (glowing flows) vs normal alpha. @default false */
  additive?: boolean;
  /** Write depth (opaque-ish) vs not (translucent flows). @default false */
  depthWrite?: boolean;
  /** Discard fragments below this final alpha. @default 0.02 */
  alphaCutoff?: number;
}

/**
 * Number of segments along an arc strip (so `N+1` samples). 32 reads smooth at
 * demo scale and keeps the per-instance vertex count modest.
 */
export const ARC_SEGMENTS = 32;

/**
 * Unit arc strip as an `InstancedBufferGeometry` — one instance per arc; the
 * material tessellates it along `t`. Layout per vertex:
 *   `position.x` ∈ [0,1] — parameter ALONG the arc (0 = source, 1 = target)
 *   `position.y` ∈ {-1,1} — SIDE of the centreline (scaled by half screen-width)
 * `N+1` samples × 2 sides → `N` quads.
 */
export function makeArcStripGeometry(segments = ARC_SEGMENTS): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  const samples = segments + 1;
  const positions = new Float32Array(samples * 2 * 3);
  let p = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / segments;
    // side -1 then +1 for this sample.
    positions[p++] = t; positions[p++] = -1; positions[p++] = 0;
    positions[p++] = t; positions[p++] = 1; positions[p++] = 0;
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2; // sample i, side -1
    const b = i * 2 + 1; // sample i, side +1
    const c = (i + 1) * 2; // sample i+1, side -1
    const d = (i + 1) * 2 + 1; // sample i+1, side +1
    indices.push(a, c, d, a, d, b);
  }
  geometry.setIndex(indices);
  return geometry;
}

/** Live arc uniforms: pixel width, opacity, canvas size, and arc-shape origin. */
export class ArcUniforms {
  readonly widthPx: UniformNode = uniform(2);
  readonly opacity: UniformNode = uniform(1);
  /** Drawing-buffer size (px); host updates on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
  /**
   * RTC world origin (f64→f32). Only used by the `greatCircle` shape to recover
   * ~absolute ECEF endpoints for slerp; `parabolic` ignores it.
   */
  readonly origin: UniformNode = uniform(vec3(0, 0, 0));
}

export interface ArcMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  arc: ArcUniforms;
  shape: ArcShape;
}

/**
 * Position of the arc at parameter `t` for the PARABOLIC (flat-map) shape:
 * linear XY/Z interpolation between the RTC endpoints, lifted in +Z by a
 * parabola `4·t·(1−t)` scaled by the per-arc height × chord length.
 */
function parabolicPos(src: TSLNode, tgt: TSLNode, height: TSLNode, t: TSLNode): TSLNode {
  const base = mix(src, tgt, t);
  // chord length in the ground (XY) plane.
  const dx = tgt.x.sub(src.x);
  const dy = tgt.y.sub(src.y);
  const chord = sqrt(dx.mul(dx).add(dy.mul(dy)));
  const lift = height.mul(chord).mul(float(4).mul(t).mul(float(1).sub(t)));
  return vec3(base.x, base.y, base.z.add(lift));
}

/**
 * Position of the arc at parameter `t` for the GREAT-CIRCLE (globe) shape.
 * Endpoints arrive RTC-local; add the origin back to recover ~absolute ECEF,
 * slerp the two direction vectors, then scale by the interpolated radius plus a
 * parabolic radial lift proportional to the chord.
 */
function greatCirclePos(
  src: TSLNode,
  tgt: TSLNode,
  height: TSLNode,
  t: TSLNode,
  origin: TSLNode,
): TSLNode {
  const aAbs = src.add(origin);
  const bAbs = tgt.add(origin);
  const ra = aAbs.length();
  const rb = bAbs.length();
  const da = aAbs.div(max(ra, float(1e-6)));
  const db = bAbs.div(max(rb, float(1e-6)));
  // slerp(da, db, t): angle between unit dirs.
  const cosOmega = da.dot(db).clamp(-1, 1);
  const omega = cosOmega.acos();
  const sinOmega = max(omega.sin(), float(1e-6));
  const wa = omega.mul(float(1).sub(t)).sin().div(sinOmega);
  const wb = omega.mul(t).sin().div(sinOmega);
  const dir = da.mul(wa).add(db.mul(wb)).normalize();
  const radius = mix(ra, rb, t);
  // radial parabolic lift proportional to the chord (great-circle separation).
  const chord = aAbs.sub(bAbs).length();
  const lift = height.mul(chord).mul(float(4).mul(t).mul(float(1).sub(t)));
  // back to RTC-local (subtract origin) so the model/view matrix sees small f32.
  return dir.mul(radius.add(lift)).sub(origin);
}

/**
 * Build an arc material. The layer attaches per-instance attributes
 * `sttPosSource`/`sttPosTarget` (vec3 RTC-local), `sttColorSource`/
 * `sttColorTarget` (vec4 0..1), `sttStart`/`sttEnd` (float, window), `sttHeight`
 * (float, per-arc height multiplier) on a {@link makeArcStripGeometry}.
 */
export function createArcMaterial(opts: ArcMaterialOptions = {}): ArcMaterialBundle {
  const shape: ArcShape = opts.shape ?? 'parabolic';
  const time = new TimeFilterUniforms();
  const arc = new ArcUniforms();

  const src = attribute('sttPosSource', 'vec3');
  const tgt = attribute('sttPosTarget', 'vec3');
  const height = attribute('sttHeight', 'float');
  const t = positionGeometry.x; // 0 (source) .. 1 (target)
  const side = positionGeometry.y; // -1 .. +1

  const posAt = (param: TSLNode): TSLNode =>
    shape === 'greatCircle'
      ? greatCirclePos(src, tgt, height, param, arc.origin)
      : parabolicPos(src, tgt, height, param);

  // ── VERTEX: tessellate curve at t and a neighbour, expand to widthPx ─────────
  const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
  // A small forward step along the curve for the screen-space tangent. Clamp so
  // the very last sample (t=1) still has a valid neighbour behind it.
  const dt = float(1 / ARC_SEGMENTS);
  // The vertex stays at the TRUE param `t`; the tangent is sampled from a forward
  // step whose BASE is clamped to ≤ 1-dt, so the last sample (t=1) still has a
  // distinct neighbour behind it (a zero-length tangent → normalize(0) → NaN tip).
  const tTanA = t.min(float(1).sub(dt));
  const tTanB = tTanA.add(dt);
  const clipHere = mvp.mul(vec4(posAt(t), 1)); // position at the true param t
  const clipTanA = mvp.mul(vec4(posAt(tTanA), 1));
  const clipTanB = mvp.mul(vec4(posAt(tTanB), 1));
  const ndcHere = clipTanA.xy.div(clipTanA.w);
  const ndcNext = clipTanB.xy.div(clipTanB.w);
  // screen-space (pixel) tangent of the curve, then its left normal.
  const dir = ndcNext.sub(ndcHere).mul(arc.viewport).normalize();
  const perp = vec2(dir.y.negate(), dir.x);
  // pixel half-offset (side·widthPx/2) → NDC (×2/viewport) → clip (×w).
  const off = perp.mul(side).mul(arc.widthPx).div(arc.viewport).mul(clipHere.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clipHere.x.add(off.x),
    clipHere.y.add(off.y),
    clipHere.z,
    clipHere.w,
  );

  // ── FRAGMENT: gradient colour + window alpha ────────────────────────────────
  const colSrc = attribute('sttColorSource', 'vec4');
  const colTgt = attribute('sttColorTarget', 'vec4');
  const vColor = varying(mix(colSrc, colTgt, t)); // gradient (mix is varying-safe)
  const vStart = varying(attribute('sttStart', 'float'));
  const vEnd = varying(attribute('sttEnd', 'float'));
  const alpha = windowAlphaNode(time, vStart, vEnd);

  material.colorNode = vColor.xyz;
  material.opacityNode = vColor.a.mul(arc.opacity).mul(alpha);
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.side = DoubleSide;
  material.blending = opts.additive ? AdditiveBlending : NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.02;

  return { material, time, arc, shape };
}

export interface ArcUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  /** Full arc width in CSS pixels. */
  widthPx?: number;
  opacity?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
  /** RTC world origin (greatCircle shape only). */
  origin?: [number, number, number];
}

/** Push the playhead + width/viewport/origin into the uniforms. Once per frame. */
export function updateArcUniforms(bundle: ArcMaterialBundle, v: ArcUniformValues): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  if (v.widthPx !== undefined) bundle.arc.widthPx.value = v.widthPx;
  if (v.opacity !== undefined) bundle.arc.opacity.value = v.opacity;
  if (v.viewport) bundle.arc.viewport.value.set(v.viewport[0], v.viewport[1]);
  if (v.origin) bundle.arc.origin.value.set(v.origin[0], v.origin[1], v.origin[2]);
}
