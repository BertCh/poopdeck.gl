// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `PointMaterial` — billboarded point splats, the Three port of deck's
 * `AnimatedPointLayer` (+ its `SplatExtension`). Each instance is a camera-facing
 * quad whose inscribed circle is the rendered disc; an optional soft Gaussian
 * (`alpha *= exp(-falloff·r²)`, the `splat: true` look) and the shared
 * {@link timeFilterAlphaNode} give the same window / wake(scan) / cumulative
 * animation as deck.
 *
 * The billboard is built in `vertexNode`: the instance centre is taken to view
 * space (`modelViewMatrix · center`), the quad corner is added in the view XY
 * plane (so the splat always faces the camera and shrinks with distance — metric
 * world size), then projected. Off-time instances get `alpha = 0` and are
 * discarded by `alphaTest` (no depth write).
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec4,
  select,
  exp,
  modelViewMatrix,
  cameraProjectionMatrix,
  type TSLNode,
  type UniformNode,
} from './nodes';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  wakeSizeScaleNode,
  updateTimeFilterUniforms,
} from './time-filter';
import type { TimeFilterMode, TimeFilterParams } from './time-filter-math';

/**
 * Live point uniforms. `pointSize` is the billboard HALF-size: in world metres
 * when `sizeUnits:'meters'` (default — AV), or in CSS pixels when
 * `sizeUnits:'pixels'`. `viewport` is the drawing-buffer size in px, used only
 * by the pixel-sizing path (host pushes it on resize, like wide-line).
 */
export class PointUniforms {
  readonly pointSize: UniformNode = uniform(0.06);
  readonly opacity: UniformNode = uniform(1);
  readonly splatFalloff: UniformNode = uniform(3);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

/** How {@link PointUniforms.pointSize} is interpreted. @default 'meters' */
export type PointSizeUnits = 'meters' | 'pixels';

export interface PointMaterialOptions {
  /** Time-filter mode: window (raw), wake (scan sweep), cumulative (worldbuild). */
  mode: TimeFilterMode;
  /** Soft Gaussian point splat (deck's `splat: true`). @default false */
  splat?: boolean;
  /** Discard fragments below this final alpha. @default 0.01 */
  alphaCutoff?: number;
  /**
   * Billboard sizing. `'meters'` (default, AV-unchanged) expands the quad in
   * view space so a point is a fixed metric size that shrinks with distance.
   * `'pixels'` (deck `radiusUnits:'pixels'`) expands it in clip space so every
   * point keeps a constant on-screen radius regardless of depth (needs the
   * `viewport` uniform, like {@link createWideLineMaterial}).
   * @default 'meters'
   */
  sizeUnits?: PointSizeUnits;
}

export interface PointMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  point: PointUniforms;
  mode: TimeFilterMode;
}

/**
 * The shared billboard clip-space position node used by both the colour and the
 * id materials, so they rasterise IDENTICAL quads (a pick must land on the same
 * pixels the point drew). Factored out verbatim — the emitted TSL graph is the
 * same whether these ops are inline or in a helper.
 */
function billboardVertexNode(
  center: TSLNode,
  corner: TSLNode,
  half: TSLNode,
  sizeUnits: PointSizeUnits,
  viewport: UniformNode,
): TSLNode {
  if (sizeUnits === 'pixels') {
    // CLIP-SPACE billboard: project the centre, then push the quad corner by a
    // constant pixel half-size. corner ∈ [-1,1]², so corner·half = ±half px.
    // px → NDC = ×2/viewport, NDC → clip = ×clip.w (cancels the perspective
    // divide so on-screen size is depth-independent). Mirrors wide-line.
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(center, 1));
    const off = corner.mul(half).mul(float(2)).div(viewport).mul(clip.w);
    return vec4(clip.x.add(off.x), clip.y.add(off.y), clip.z, clip.w);
  }
  // VIEW-SPACE billboard (default, AV-unchanged): metric size that shrinks
  // with distance.
  const viewCenter = modelViewMatrix.mul(vec4(center, 1));
  const viewPos = vec4(
    viewCenter.x.add(corner.x.mul(half)),
    viewCenter.y.add(corner.y.mul(half)),
    viewCenter.z,
    viewCenter.w,
  );
  return cameraProjectionMatrix.mul(viewPos);
}

export function createPointMaterial(opts: PointMaterialOptions): PointMaterialBundle {
  const time = new TimeFilterUniforms();
  const point = new PointUniforms();

  const center = attribute('sttCenter', 'vec3');
  const color = attribute('sttColor', 'vec4');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const corner = positionGeometry.xy;

  // VERTEX stage: the time alpha (a `select()`) feeds the wake tail-size only.
  // Used directly in the vertex computation (never wrapped in a varying), so the
  // WGSL backend builds it fine.
  const vertexAlpha = timeFilterAlphaNode(opts.mode, time, start, end);
  // Wake mode shrinks the tail toward `wakeTailScale`; other modes keep full size.
  const sizeFactor = opts.mode === 'wake' ? wakeSizeScaleNode(time, vertexAlpha) : float(1);
  const half = point.pointSize.mul(sizeFactor);

  const material = new MeshBasicNodeMaterial();
  const sizeUnits: PointSizeUnits = opts.sizeUnits ?? 'meters';
  material.vertexNode = billboardVertexNode(center, corner, half, sizeUnits, point.viewport);

  // IMPORTANT (WGSL): vary the RAW per-instance inputs and recompute the time
  // alpha — a `select()` — in the FRAGMENT stage. A `select()` wrapped in a
  // `varying()` fails to build on the WGSL backend (the same crash that was
  // fixed for surfel-material.ts / iso-line-material.ts; point-material was
  // missed). `start`/`end` are per-instance constants, so the recomputed
  // fragment alpha is identical to the (formerly varied) vertex alpha.
  const vColor = varying(color);
  const vStart = varying(start);
  const vEnd = varying(end);
  const vUv = varying(corner);
  const fragAlpha = timeFilterAlphaNode(opts.mode, time, vStart, vEnd);

  const r2 = vUv.dot(vUv);
  const soft = opts.splat ? exp(r2.mul(point.splatFalloff).negate()) : float(1);
  const a = select(
    r2.greaterThan(1),
    float(0),
    vColor.a.mul(point.opacity).mul(fragAlpha).mul(soft),
  );

  material.colorNode = vColor.xyz;
  material.opacityNode = a;
  material.transparent = true;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.01;

  return { material, time, point, mode: opts.mode };
}

export interface PointUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams & { wakeTailScale?: number };
  /** Billboard half-size — world metres (`sizeUnits:'meters'`) or CSS px (`'pixels'`). */
  pointSize?: number;
  opacity?: number;
  splatFalloff?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize; pixel sizing only). */
  viewport?: [number, number];
}

export function updatePointUniforms(bundle: PointMaterialBundle, v: PointUniformValues): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.point.pointSize.value = v.pointSize ?? 0.06;
  bundle.point.opacity.value = v.opacity ?? 1;
  bundle.point.splatFalloff.value = v.splatFalloff ?? 3;
  if (v.viewport) bundle.point.viewport.value.set(v.viewport[0], v.viewport[1]);
}

// ── GPU id-buffer pick material (§5.3 merged-buffer picking) ─────────────────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Renders each point's flat
// per-instance id colour (`sttIdColor`, from `buildIdColors(mergedCount)`) into an
// off-screen target the picker reads back. It rasterises the SAME billboard quad
// as the colour material (shared `billboardVertexNode`), and reuses the identical
// time filter + disc mask so ONLY the points visible this frame are pickable —
// but the id is written at FULL intensity (never multiplied by alpha), so the
// decoded RGB is an exact 24-bit index. Bind `updatePointUniforms` to sync its
// time/size uniforms before the pass. The returned bundle is shape-compatible with
// {@link PointMaterialBundle}.

/**
 * Build the point-cloud id material. `opts` mirror the colour material's so the
 * pick pass matches the on-screen quads (size, splat disc, time-filter mode).
 */
export function createPointIdMaterial(opts: PointMaterialOptions): PointMaterialBundle {
  const time = new TimeFilterUniforms();
  const point = new PointUniforms();

  const center = attribute('sttCenter', 'vec3');
  const idColor = attribute('sttIdColor', 'vec3');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const corner = positionGeometry.xy;

  const vertexAlpha = timeFilterAlphaNode(opts.mode, time, start, end);
  const sizeFactor = opts.mode === 'wake' ? wakeSizeScaleNode(time, vertexAlpha) : float(1);
  const half = point.pointSize.mul(sizeFactor);

  const material = new MeshBasicNodeMaterial();
  const sizeUnits: PointSizeUnits = opts.sizeUnits ?? 'meters';
  material.vertexNode = billboardVertexNode(center, corner, half, sizeUnits, point.viewport);

  // FRAGMENT: same WGSL discipline as the colour material — vary the raw inputs
  // and recompute the `select()` here (a `select()` wrapped in a `varying()`
  // fails to build on the WGSL backend).
  const vId = varying(idColor);
  const vStart = varying(start);
  const vEnd = varying(end);
  const vUv = varying(corner);
  const fragAlpha = timeFilterAlphaNode(opts.mode, time, vStart, vEnd);
  const r2 = vUv.dot(vUv);
  const cutoff = opts.alphaCutoff ?? 0.01;
  // Visible iff inside the disc AND on-time; the id is opaque, everything else
  // is discarded (alphaTest) so background / off-time points never win a pick.
  const visible = r2.lessThanEqual(1).and(fragAlpha.greaterThan(float(cutoff)));
  const a = select(visible, float(1), float(0));

  material.colorNode = vId;
  material.opacityNode = a;
  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = 0.5;

  return { material, time, point, mode: opts.mode };
}
