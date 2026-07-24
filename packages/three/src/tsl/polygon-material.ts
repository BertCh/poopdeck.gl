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
 * HARD cut (VERTEX stage): in `window` mode the geometry position is multiplied by
 * the hard {@link windowVisibleNode} gate. Every vertex of one polygon shares its
 * `[sttStart, sttEnd]` window (see `polygon-buffers.ts` — starts/ends are written
 * per-feature to every vertex, and every triangle references only that feature's
 * vertices), so an out-of-window feature collapses ALL its vertices to the local
 * origin → every triangle is degenerate (zero area, dies at assembly, no fragment
 * cost, keeps early-Z; deck.gl #7509) instead of an alpha-cutoff fragment discard.
 * In-window ⇒ ×1 (position untouched). The soft window fade stays in `opacityNode`.
 *
 * IMPORTANT (WGSL): we vary the RAW per-vertex inputs (`sttColor`, `sttStart`,
 * `sttEnd`) and compute the SOFT window alpha — a `select()` — in the FRAGMENT
 * stage. A `select()` wrapped in a `varying()` fails to build on the WGSL backend
 * (see `iso-line-material.ts` / `surfel-material.ts`); the alpha node must never
 * be varied. The vertex visibility gate is branch-free (`step()`). `none` mode
 * never builds the select and never collapses.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending } from 'three';
import {
  attribute,
  varying,
  uniform,
  float,
  select,
  positionGeometry,
  type TSLNode,
} from './nodes.js';
import type { UniformNode } from './nodes.js';
import {
  TimeFilterUniforms,
  windowAlphaNode,
  windowVisibleNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';
import {
  DataFilterUniforms,
  dataFilterVisibleNode,
  dataFilterAlphaNode,
  updateDataFilterUniforms,
  type DataFilterOptions,
} from './data-filter.js';

export type PolygonTimeMode = 'window' | 'none';

export interface PolygonMaterialOptions {
  /** `window` time-filters by `[sttStart,sttEnd]`; `none` is static. @default 'none' */
  mode?: PolygonTimeMode;
  /** Discard fragments below this final alpha. @default 0.004 */
  alphaCutoff?: number;
  /** Write depth (opaque-ish fills). @default false (ground decals) */
  depthWrite?: boolean;
  /**
   * Install the GPU column filter (deck `DataFilterExtension`): binds a
   * per-vertex `sttFilterValue` attribute and gates each feature by
   * `filterRange`/`filterSoftRange`. Every vertex of a feature shares the value,
   * so an out-of-range feature's triangles all degenerate (hard collapse); the
   * soft band fades opacity. Composes with `window` mode. @default false
   */
  dataFilter?: boolean;
  /**
   * Install the time-as-height ("space-time cube") lift (deck `timeHeightScale`):
   * binds the per-vertex `sttLift` direction attribute + `heightScale` /
   * `heightOrigin` uniforms and raises each feature by
   * `(sttStart − heightOrigin) × heightScale` metres along local up. The lift is
   * applied BEFORE the window / column-filter collapse gate, so an excluded
   * feature still collapses to the origin. A single scale uniform, so animating
   * the flat⇄cube morph is free; `heightScale = 0` renders flat. @default false
   */
  timeHeight?: boolean;
}

/**
 * Live time-as-height uniforms (the space-time-cube lift). All times are
 * RELATIVE to the layer `timeOrigin`, matching `sttStart`. Idles flat while
 * `heightScale` is 0 (deck's `timeHeightScale` default).
 */
export class TimeHeightUniforms {
  /** Metres of altitude per simulation millisecond (0 = flat). */
  readonly heightScale: UniformNode = uniform(0);
  /** Relative time (vs the layer timeOrigin) mapped to altitude 0. */
  readonly heightOrigin: UniformNode = uniform(0);
}

export interface PolygonUniforms {
  /** Layer opacity multiplier. */
  opacity: UniformNode;
}

export interface PolygonMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  poly: PolygonUniforms;
  /** Present only when built with `dataFilter: true`; drives the column filter. */
  filter?: DataFilterUniforms;
  /** Present only when built with `timeHeight: true`; drives the space-time-cube lift. */
  timeHeight?: TimeHeightUniforms;
}

/**
 * Create a polygon fill material. The layer attaches per-vertex attributes
 * `sttColor` (vec4, straight RGBA 0..1) and (in `window` mode) `sttStart` /
 * `sttEnd` (float, relative ms).
 */
export function createPolygonMaterial(
  opts: PolygonMaterialOptions = {},
): PolygonMaterialBundle {
  const mode = opts.mode ?? 'none';
  const time = new TimeFilterUniforms();
  const opacity = uniform(1);
  const dataFilter = opts.dataFilter ?? false;
  const filter = dataFilter ? new DataFilterUniforms() : undefined;
  const filterValue = dataFilter ? attribute('sttFilterValue', 'float') : null;
  const timeHeight = opts.timeHeight ?? false;
  const height = timeHeight ? new TimeHeightUniforms() : undefined;
  // `sttStart` drives BOTH the window filter and the time-as-height lift, so bind
  // it once when either needs it (window mode always writes it; the lift reads it
  // even in `none` mode).
  const startAttr =
    mode === 'window' || timeHeight ? attribute('sttStart', 'float') : null;

  const colorAttr = attribute('sttColor', 'vec4');
  const vColor = varying(colorAttr);

  const material = new MeshBasicNodeMaterial();

  // Multiplicative HARD collapse gate for the vertex position — the product of
  // the window visibility (if `window` mode) and the column-filter visibility
  // (if installed). Every vertex of one feature shares both the `[start,end]`
  // window and the per-feature `filterValue`, so an excluded feature's triangles
  // all degenerate to zero area (die at assembly, no fragment cost). `null` when
  // neither filter applies ⇒ the static geometry position (no positionNode).
  let posGate: TSLNode | null = null;
  let alpha: TSLNode = float(1);
  if (mode === 'window' && startAttr) {
    const end = attribute('sttEnd', 'float');
    posGate = windowVisibleNode(time, startAttr, end);
    // Vary the raw inputs; compute the SOFT window alpha (a select) in the fragment.
    alpha = windowAlphaNode(time, varying(startAttr), varying(end));
  }
  if (filter && filterValue) {
    const fVisible = dataFilterVisibleNode(filter, filterValue);
    posGate = posGate ? posGate.mul(fVisible) : fVisible;
    alpha = alpha.mul(dataFilterAlphaNode(filter, varying(filterValue)));
  }
  // Time-as-height ("space-time cube"): lift the geometry position by the
  // feature's start time BEFORE the collapse gate, so an excluded feature still
  // degenerates to the origin (× posGate = 0). `sttLift` carries world-units-per-
  // metre-of-altitude, so `sttLift × heightMeters` is the world displacement;
  // `heightScale = 0` ⇒ +0 (byte-identical flat render). Every vertex of a
  // feature shares the lift, so the whole feature rises coherently.
  let basePos: TSLNode = positionGeometry;
  if (height && startAttr) {
    const lift = attribute('sttLift', 'vec3');
    const heightMeters = startAttr
      .sub(height.heightOrigin)
      .mul(height.heightScale);
    basePos = positionGeometry.add(lift.mul(heightMeters));
  }
  if (posGate) material.positionNode = basePos.mul(posGate);
  else if (height) material.positionNode = basePos;

  material.colorNode = vColor.xyz;
  material.opacityNode = vColor.a.mul(opacity).mul(alpha);
  material.transparent = true;
  material.side = DoubleSide;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.004;

  return { material, time, poly: { opacity }, filter, timeHeight: height };
}

export interface PolygonUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  opacity?: number;
  /** Column-filter props (no-op unless built with `dataFilter: true`). */
  dataFilter?: DataFilterOptions;
  /**
   * Time-as-height lift params (no-op unless built with `timeHeight: true`).
   * `heightScale` is metres of altitude per sim-ms; `heightOrigin` is the time
   * mapped to altitude 0, RELATIVE to the layer timeOrigin.
   */
  timeHeight?: { heightScale: number; heightOrigin: number };
}

/** Push the playhead + window params into the polygon uniforms. Call once per frame. */
export function updatePolygonUniforms(
  bundle: PolygonMaterialBundle,
  v: PolygonUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.poly.opacity.value = v.opacity ?? 1;
  if (bundle.filter) updateDataFilterUniforms(bundle.filter, v.dataFilter);
  if (bundle.timeHeight) {
    bundle.timeHeight.heightScale.value = v.timeHeight?.heightScale ?? 0;
    bundle.timeHeight.heightOrigin.value = v.timeHeight?.heightOrigin ?? 0;
  }
}

// ── GPU id-buffer pick material (GPU picking catalog: polygon variant) ───────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Unlike the instanced kinds
// (point / column / arc), a polygon is ONE merged (non-instanced) mesh, so the
// id colour is a PER-VERTEX attribute (`sttIdColor`, from `buildPolygonBuffers`):
// every vertex of a feature carries the SAME colour, which encodes that feature's
// merged index — a readback on any of its pixels decodes to the one merged index.
// The material recomposes the SAME vertex-stage collapse as the colour material
// (identical `positionNode`): the `window` visibility gate AND the column
// `dataFilterVisibleNode` gate, AND the time-as-height lift — so an out-of-window
// / out-of-range / lifted feature collapses to a zero-area degenerate and is never
// pickable, exactly matching the eye. The id is written opaque at full intensity
// (never × alpha), so the decoded RGB is an exact 24-bit index; off-time /
// off-range fragments are discarded (opacity 0 + alphaTest) so they never win a
// pick. Bind {@link updatePolygonUniforms} to sync its time / filter / lift
// uniforms before the pass. The returned bundle is {@link PolygonMaterialBundle}.

/**
 * Build the polygon id material. `opts` mirror the colour material's gate options
 * (`mode`, `dataFilter`, `timeHeight`, `alphaCutoff`) so the pick pass matches the
 * on-screen fill; the colour-only options (`depthWrite`) are ignored (the id is a
 * flat per-vertex colour, opaque with depth-write so the front-most feature wins).
 */
export function createPolygonIdMaterial(
  opts: PolygonMaterialOptions = {},
): PolygonMaterialBundle {
  const mode = opts.mode ?? 'none';
  const time = new TimeFilterUniforms();
  const opacity = uniform(1);
  const dataFilter = opts.dataFilter ?? false;
  const filter = dataFilter ? new DataFilterUniforms() : undefined;
  const filterValue = dataFilter ? attribute('sttFilterValue', 'float') : null;
  const timeHeight = opts.timeHeight ?? false;
  const height = timeHeight ? new TimeHeightUniforms() : undefined;
  const startAttr =
    mode === 'window' || timeHeight ? attribute('sttStart', 'float') : null;

  const idColor = attribute('sttIdColor', 'vec3');
  const material = new MeshBasicNodeMaterial();

  // SAME hard vertex-stage collapse as the colour material: an out-of-window /
  // out-of-range feature's triangles all degenerate to zero area, so they never
  // rasterise → are never pickable, exactly matching the eye.
  let posGate: TSLNode | null = null;
  let onGate: TSLNode | null = null;
  const cutoff = opts.alphaCutoff ?? 0.004;
  if (mode === 'window' && startAttr) {
    const end = attribute('sttEnd', 'float');
    posGate = windowVisibleNode(time, startAttr, end);
    // Recompute the soft window alpha from VARIED raw inputs (never a
    // varying-wrapped select), then threshold to a hard 0/1 pick alpha.
    onGate = windowAlphaNode(
      time,
      varying(startAttr),
      varying(end),
    ).greaterThan(float(cutoff));
  }
  if (filter && filterValue) {
    const fVisible = dataFilterVisibleNode(filter, filterValue);
    posGate = posGate ? posGate.mul(fVisible) : fVisible;
    const fg = dataFilterAlphaNode(filter, varying(filterValue)).greaterThan(
      float(cutoff),
    );
    onGate = onGate ? onGate.and(fg) : fg;
  }
  // Time-as-height lift BEFORE the collapse gate (an excluded feature still
  // degenerates to the origin), identical to the colour material.
  let basePos: TSLNode = positionGeometry;
  if (height && startAttr) {
    const lift = attribute('sttLift', 'vec3');
    const heightMeters = startAttr
      .sub(height.heightOrigin)
      .mul(height.heightScale);
    basePos = positionGeometry.add(lift.mul(heightMeters));
  }
  if (posGate) material.positionNode = basePos.mul(posGate);
  else if (height) material.positionNode = basePos;

  // FRAGMENT: flat per-vertex id colour, opaque wherever the fill is drawn AND
  // on-time AND in-range; a hard 0/1 alpha so a barely-faded feature never
  // registers a partial-alpha id.
  material.colorNode = varying(idColor);
  material.opacityNode = onGate ? select(onGate, float(1), float(0)) : float(1);
  material.transparent = false;
  material.side = DoubleSide;
  material.depthTest = true;
  material.depthWrite = true;
  material.blending = NormalBlending;
  material.alphaTest = 0.5;

  return { material, time, poly: { opacity }, filter, timeHeight: height };
}
