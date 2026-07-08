// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `ColumnMaterial` — lit extruded prisms (3D bars), the Three port of deck's
 * `AnimatedColumnLayer` over a `ColumnLayer` sublayer. Each instance is a unit
 * prism (see `geometry/column-prism.ts`) scaled & oriented to the local ground
 * frame by three per-instance basis vectors, SELF-LIT by a baked fixed-sun Lambert
 * term (unlit `MeshBasicNodeMaterial`, so no scene light is required — consistent
 * with the rest of this renderer), coloured per instance, and time-windowed by the
 * shared {@link timeFilterAlphaNode}.
 *
 * ── POSITION (`positionNode`) ─────────────────────────────────────────────────
 * The unit-prism object position `(ox, oy, oz)` (radius-1 XY disk, z ∈ [0,1]) is
 * recomposed into the RTC-local instance frame:
 *   `local = base + ox·basisX + oy·basisY + oz·basisZ`
 * `basisX/Y/Z` already fold in metric radius/height AND the world east/north/up
 * directions, so a single instance buffer covers AV (Z-up plane) and the globe
 * (per-position ECEF basis) with no shader branch.
 *
 * ── SHADE (baked into `colorNode`) ────────────────────────────────────────────
 * The object normal is rotated by the NORMALIZED basis (direction only, so it stays
 * a pure rotation under non-uniform radius/height scale) into world space, then a
 * fixed-sun `ambient + (1-ambient)·max(0, N·L)` term multiplies the albedo.
 *
 * ── TIME (`opacityNode`) ──────────────────────────────────────────────────────
 * WGSL rule: the window alpha is a `select()`, so we vary the RAW per-instance
 * `start`/`end` and recompute the alpha in the FRAGMENT stage — never wrap a
 * `select()` in a `varying()` (mirrors point-material.ts / surfel-material.ts).
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec3,
  saturate,
  type UniformNode,
  type TSLNode,
} from './nodes.js';

/** Ambient floor of the baked self-lit shade (shadowed faces stay readable). */
const COLUMN_AMBIENT = 0.45;
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';

/** Live column uniforms (constant opacity multiplier on top of the time window). */
export class ColumnUniforms {
  readonly opacity: UniformNode = uniform(1);
}

export interface ColumnMaterialOptions {
  /** Apply the window time-filter (fade by `[start,end]` overlap). @default true */
  timeFiltered?: boolean;
  /** Translucent columns (window fade). @default false (opaque, depth-sorted) */
  transparent?: boolean;
  /** Discard fragments below this alpha when transparent. @default 0.01 */
  alphaCutoff?: number;
}

export interface ColumnMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  column: ColumnUniforms;
  timeFiltered: boolean;
}

function normalizeNode(v: TSLNode): TSLNode {
  return v.normalize();
}

export function createColumnMaterial(
  opts: ColumnMaterialOptions = {},
): ColumnMaterialBundle {
  const time = new TimeFilterUniforms();
  const column = new ColumnUniforms();
  const timeFiltered = opts.timeFiltered ?? true;
  const transparent = opts.transparent ?? false;

  const base = attribute('sttBase', 'vec3');
  const bx = attribute('sttBasisX', 'vec3');
  const by = attribute('sttBasisY', 'vec3');
  const bz = attribute('sttBasisZ', 'vec3');
  const color = attribute('sttColor', 'vec4');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');

  const op = positionGeometry; // unit-prism object position
  const local = base.add(bx.mul(op.x)).add(by.mul(op.y)).add(bz.mul(op.z));

  const material = new MeshBasicNodeMaterial();
  material.positionNode = vec3(local);

  // Self-lit (no scene lights needed): rotate the object normal into world space by
  // the normalized basis, then bake a FIXED-sun hemispheric Lambert term into the
  // albedo. The rest of this renderer is unlit `MeshBasicNodeMaterial` too, so the
  // 3D form reads regardless of the host scene's lighting; on the globe the fixed
  // world-space sun reads as a real sun across the sphere.
  const nrm = attribute('normal', 'vec3');
  const worldN = normalizeNode(bx)
    .mul(nrm.x)
    .add(normalizeNode(by).mul(nrm.y))
    .add(normalizeNode(bz).mul(nrm.z));
  const vWorldN = varying(worldN);
  const ndl = saturate(vWorldN.normalize().dot(vec3(0.32, 0.4, 0.86)));
  const shade = float(COLUMN_AMBIENT).add(ndl.mul(1 - COLUMN_AMBIENT));

  // Per-instance albedo × baked shade.
  const vColor = varying(color);
  material.colorNode = vColor.xyz.mul(shade);

  // Time window → opacity (vary raw start/end; recompute the select() alpha here).
  const vStart = varying(start);
  const vEnd = varying(end);
  const fragAlpha = timeFiltered
    ? timeFilterAlphaNode('window', time, vStart, vEnd)
    : float(1);
  material.opacityNode = vColor.a.mul(column.opacity).mul(fragAlpha);

  material.transparent = transparent;
  material.depthWrite = transparent ? false : true;
  material.depthTest = true;
  material.side = DoubleSide;
  if (transparent) material.alphaTest = opts.alphaCutoff ?? 0.01;

  return { material, time, column, timeFiltered };
}

export interface ColumnUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  opacity?: number;
}

export function updateColumnUniforms(
  bundle: ColumnMaterialBundle,
  v: ColumnUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.column.opacity.value = v.opacity ?? 1;
}
