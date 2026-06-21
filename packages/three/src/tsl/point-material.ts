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
  vec4,
  select,
  exp,
  modelViewMatrix,
  cameraProjectionMatrix,
} from 'three/tsl';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  wakeSizeScaleNode,
  updateTimeFilterUniforms,
  type UniformNode,
} from './time-filter';
import type { TimeFilterMode, TimeFilterParams } from './time-filter-math';

/** Live point uniforms (size in world metres, opacity, splat tightness). */
export class PointUniforms {
  readonly pointSize: UniformNode = uniform(0.06);
  readonly opacity: UniformNode = uniform(1);
  readonly splatFalloff: UniformNode = uniform(3);
}

export interface PointMaterialOptions {
  /** Time-filter mode: window (raw), wake (scan sweep), cumulative (worldbuild). */
  mode: TimeFilterMode;
  /** Soft Gaussian point splat (deck's `splat: true`). @default false */
  splat?: boolean;
  /** Discard fragments below this final alpha. @default 0.01 */
  alphaCutoff?: number;
}

export interface PointMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  point: PointUniforms;
  mode: TimeFilterMode;
}

export function createPointMaterial(opts: PointMaterialOptions): PointMaterialBundle {
  const time = new TimeFilterUniforms();
  const point = new PointUniforms();

  const center = attribute('sttCenter', 'vec3');
  const color = attribute('sttColor', 'vec4');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const corner = positionGeometry.xy;

  const alpha = timeFilterAlphaNode(opts.mode, time, start, end);
  // Wake mode shrinks the tail toward `wakeTailScale`; other modes keep full size.
  const sizeFactor = opts.mode === 'wake' ? wakeSizeScaleNode(time, alpha) : float(1);
  const half = point.pointSize.mul(sizeFactor);

  const viewCenter = modelViewMatrix.mul(vec4(center, 1));
  const viewPos = vec4(
    viewCenter.x.add(corner.x.mul(half)),
    viewCenter.y.add(corner.y.mul(half)),
    viewCenter.z,
    viewCenter.w,
  );

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = cameraProjectionMatrix.mul(viewPos);

  const vColor = varying(color);
  const vAlpha = varying(alpha);
  const vUv = varying(corner);

  const r2 = vUv.dot(vUv);
  const soft = opts.splat ? exp(r2.mul(point.splatFalloff).negate()) : float(1);
  const a = select(
    r2.greaterThan(1),
    float(0),
    vColor.a.mul(point.opacity).mul(vAlpha).mul(soft),
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
  /** World-metre half-size of each point splat. */
  pointSize?: number;
  opacity?: number;
  splatFalloff?: number;
}

export function updatePointUniforms(bundle: PointMaterialBundle, v: PointUniformValues): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.point.pointSize.value = v.pointSize ?? 0.06;
  bundle.point.opacity.value = v.opacity ?? 1;
  bundle.point.splatFalloff.value = v.splatFalloff ?? 3;
}
