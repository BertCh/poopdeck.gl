// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `HexbinMaterial` — the extruded hexagonal prisms of the RUNTIME hexbin, the
 * Three port of deck's `AnimatedHexagonLayer` cell pass. One instance per
 * OCCUPIED CELL of the lattice `lib/hexbin-buffers.ts` bins; the shared unit
 * prism is `makeColumnPrismGeometry(6, π/6)` — a six-sided, incircle-1 prism
 * rotated 30° so its flat sides face east/west, i.e. deck's pointy-top hexagon.
 *
 * ── POSITION (`positionNode`) ────────────────────────────────────────────────
 * The unit-prism object position `(ox, oy, oz)` is recomposed into the cell's
 * RTC-local ground frame exactly as `column-material.ts` does:
 *   `local = base + (ox·basisX + oy·basisY + oz·height·elevationScale·basisZ)·gate`
 * `basisX`/`basisY` fold in the cell's ground radius AND the world east/north
 * directions, so one instance buffer covers the AV plane, mercator and the ECEF
 * globe with no shader branch. `basisZ` deliberately does NOT fold in a height:
 * it carries WORLD UNITS PER METRE of altitude, and the per-instance
 * `sttHeight` (metres) times the `elevationScale` uniform supplies the rest.
 * That is what lets a re-aggregation re-upload one float per cell instead of a
 * whole vec3 basis, and it makes animating the flat⇄extruded morph free.
 *
 * ── THE TWO GATES, AND WHY THERE ARE TWO ─────────────────────────────────────
 * A hexbin's aggregate is a CPU reduction that re-runs when the window centre
 * crosses an aggregation step, so it is a STEPPED quantity. Two vertex-stage
 * gates multiply into the prism offset, and each covers what the other cannot:
 *
 *  1. `sttVisible` — the AGGREGATE's own hard `0 | 1`: the cell had no
 *     contributing member at the last re-aggregation, or its value fell outside
 *     the `lowerPercentile`/`upperPercentile` band. An empty cell is ABSENCE,
 *     not a zero sample, so it must not draw a zero-height hexagon.
 *  2. {@link timeFilterVisibleNode} over the cell's OWN temporal span
 *     (`sttStart` = earliest contributing member start, `sttEnd` = latest end).
 *     This is the SUB-STEP half: between two re-aggregations the play head keeps
 *     moving, and a cell whose last member has just fallen behind the window
 *     collapses immediately rather than lingering until the next step. It is a
 *     refinement of the aggregate, never a contradiction of it — the aggregate
 *     only ever includes members the window admitted.
 *
 * Both collapse the prism to ZERO EXTENT at `base` (every vertex coincides →
 * dies at primitive assembly, no fragment cost) rather than discarding
 * fragments; deck.gl #7509 is why. The fragment `opacityNode` then carries the
 * SOFT half — the window's fade ramps recomputed from the RAW varied
 * `sttStart`/`sttEnd` (never a `varying()`-wrapped `select()`; that is the
 * recurring WGSL crash).
 *
 * ── SHADE ────────────────────────────────────────────────────────────────────
 * Same baked fixed-sun Lambert term as `column-material.ts`: the object normal
 * is rotated by the NORMALIZED basis (direction only, so it survives the
 * non-uniform radius/height scale) and shades the albedo. One backend, one look
 * for extruded prisms — and no scene light is required anywhere.
 *
 * ── DELIBERATELY ABSENT ──────────────────────────────────────────────────────
 * No `dataFilter` and no `colorPalette`. Both are PER-FEATURE constructs and a
 * cell is not a feature: the column filter belongs on the CONTRIBUTING POINTS,
 * where `lib/hexbin-buffers.ts` gates them during the reduction, and an
 * aggregate has no category to look up in a stable palette. Installing either
 * here would present a prop that quietly filtered nothing.
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
  select,
  type UniformNode,
  type TSLNode,
} from './nodes.js';
import { srgbToWorking } from './color-space.js';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  timeFilterVisibleNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';

/** Ambient floor of the baked self-lit shade (shadowed faces stay readable). */
const HEXBIN_AMBIENT = 0.45;

/** Live hexbin uniforms — the two knobs that move without a re-aggregation. */
export class HexbinUniforms {
  /** Constant opacity multiplier on top of the cell colour's own alpha. */
  readonly opacity: UniformNode = uniform(1);
  /**
   * Multiplier on every cell's METRE height (deck `elevationScale`). A uniform,
   * not a baked attribute, so `0 → 1` is a free flat⇄extruded morph.
   */
  readonly elevationScale: UniformNode = uniform(1);
}

export interface HexbinMaterialOptions {
  /**
   * Apply the sub-step window time-filter over each cell's own temporal span
   * (see the module header's "two gates"). @default true
   */
  timeFiltered?: boolean;
  /** Translucent cells (lets the window fade show). @default false */
  transparent?: boolean;
  /** Discard fragments below this alpha when transparent. @default 0.01 */
  alphaCutoff?: number;
}

export interface HexbinMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  hexbin: HexbinUniforms;
  timeFiltered: boolean;
}

function normalizeNode(v: TSLNode): TSLNode {
  return v.normalize();
}

/**
 * The per-instance attribute set both variants read, built once so the colour
 * and id graphs cannot drift apart on a name (there is no compile-time link
 * between `geometry.setAttribute` and `attribute()` — only string identity).
 */
function hexbinAttributes(): {
  base: TSLNode;
  bx: TSLNode;
  by: TSLNode;
  bz: TSLNode;
  height: TSLNode;
  visible: TSLNode;
  start: TSLNode;
  end: TSLNode;
} {
  return {
    base: attribute('sttBase', 'vec3'),
    bx: attribute('sttBasisX', 'vec3'),
    by: attribute('sttBasisY', 'vec3'),
    bz: attribute('sttBasisZ', 'vec3'),
    height: attribute('sttHeight', 'float'),
    visible: attribute('sttVisible', 'float'),
    start: attribute('sttStart', 'float'),
    end: attribute('sttEnd', 'float'),
  };
}

/**
 * The shared vertex-stage prism recomposition + collapse gates. Called by BOTH
 * {@link createHexbinMaterial} and {@link createHexbinIdMaterial} so an
 * out-of-window / empty / percentile-clipped cell is equally invisible AND
 * unpickable, by construction rather than by review.
 */
function hexbinLocalPosition(
  a: ReturnType<typeof hexbinAttributes>,
  hexbin: HexbinUniforms,
  time: TimeFilterUniforms,
  timeFiltered: boolean,
): TSLNode {
  const op = positionGeometry; // unit prism: incircle-1 XY disk, z ∈ [0,1]
  const lift = a.height.mul(hexbin.elevationScale);
  const offset = a.bx
    .mul(op.x)
    .add(a.by.mul(op.y))
    .add(a.bz.mul(op.z.mul(lift)));
  let gate: TSLNode = a.visible;
  if (timeFiltered) {
    gate = gate.mul(timeFilterVisibleNode('window', time, a.start, a.end));
  }
  return a.base.add(offset.mul(gate));
}

export function createHexbinMaterial(
  opts: HexbinMaterialOptions = {},
): HexbinMaterialBundle {
  const time = new TimeFilterUniforms();
  const hexbin = new HexbinUniforms();
  const timeFiltered = opts.timeFiltered ?? true;
  const transparent = opts.transparent ?? false;

  const a = hexbinAttributes();
  const color = attribute('sttColor', 'vec4');

  const material = new MeshBasicNodeMaterial();
  material.positionNode = vec3(
    hexbinLocalPosition(a, hexbin, time, timeFiltered),
  );

  // Self-lit (no scene lights): rotate the object normal into world space by the
  // NORMALIZED basis, then bake a fixed-sun hemispheric Lambert term into the
  // albedo — the identical term `column-material.ts` uses, so a hexbin prism and
  // a column prism catch the light the same way.
  const nrm = attribute('normal', 'vec3');
  const worldN = normalizeNode(a.bx)
    .mul(nrm.x)
    .add(normalizeNode(a.by).mul(nrm.y))
    .add(normalizeNode(a.bz).mul(nrm.z));
  const vWorldN = varying(worldN);
  const ndl = saturate(vWorldN.normalize().dot(vec3(0.32, 0.4, 0.86)));
  const shade = float(HEXBIN_AMBIENT).add(ndl.mul(1 - HEXBIN_AMBIENT));

  // Per-cell ramp colour × baked shade, then sRGB→working (see ./color-space.ts):
  // the shade multiplies INSIDE the conversion because deck darkens the 0–255
  // colour the same way — converting first would change the falloff curve.
  const vColor = varying(color);
  material.colorNode = srgbToWorking(vColor.xyz.mul(shade));

  // Window → opacity. Vary the RAW start/end and recompute the select()-based
  // alpha in the FRAGMENT stage; never wrap a select() in a varying().
  const vStart = varying(a.start);
  const vEnd = varying(a.end);
  const fragAlpha = timeFiltered
    ? timeFilterAlphaNode('window', time, vStart, vEnd)
    : float(1);
  material.opacityNode = vColor.a
    .mul(hexbin.opacity)
    .mul(varying(a.visible))
    .mul(fragAlpha);

  material.transparent = transparent;
  material.depthWrite = transparent ? false : true;
  material.depthTest = true;
  material.side = DoubleSide;
  if (transparent) material.alphaTest = opts.alphaCutoff ?? 0.01;

  return { material, time, hexbin, timeFiltered };
}

export interface HexbinUniformValues {
  /** Play head RELATIVE to the layer `timeOrigin`. */
  relativeCurrentTime: number;
  /** Window half-width + fade ramps. */
  params?: TimeFilterParams;
  /** Constant opacity multiplier. @default 1 */
  opacity?: number;
  /** Multiplier on every cell height (deck `elevationScale`). @default 1 */
  elevationScale?: number;
}

/**
 * Push one frame's values into every uniform holder on the bundle. A uniform
 * PUSH, not a rebuild — cheap enough to run every frame, and it works unchanged
 * on the id bundle (same shape), which is how the pick pass stays synced to the
 * live play head.
 */
export function updateHexbinUniforms(
  bundle: HexbinMaterialBundle,
  v: HexbinUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.hexbin.opacity.value = v.opacity ?? 1;
  bundle.hexbin.elevationScale.value = v.elevationScale ?? 1;
}

// ── GPU id-buffer pick material (GPU picking catalog: hexbin variant) ────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Renders each CELL's flat
// per-instance id colour (`sttIdColor`, from `buildIdColors(cellCount)`) into
// the picker's off-screen target. The decoded id is a CELL index, not a feature
// index — the hexbin (like `text`) is one of the kinds whose provenance is not
// 1:1 with a source feature; see `layers/hexbin-layer.ts`.
//
// It recomposes the SAME prism as the colour material (identical
// `positionNode` via {@link hexbinLocalPosition}), reusing the identical
// vertex-stage gates — the aggregate's `sttVisible` AND the sub-step
// {@link timeFilterVisibleNode} — so a cell picks EXACTLY where, and only when,
// it is drawn. The id is written opaque at full intensity (never × alpha, never
// through `srgbToWorking`), so the readback decodes an exact 24-bit index.

/**
 * Build the hexbin id material. `opts` mirror the colour material's GATE options
 * (`timeFiltered`, `alphaCutoff`) so the pick pass matches the on-screen cells;
 * `transparent` is ignored (the id pass is always opaque).
 */
export function createHexbinIdMaterial(
  opts: HexbinMaterialOptions = {},
): HexbinMaterialBundle {
  const time = new TimeFilterUniforms();
  const hexbin = new HexbinUniforms();
  const timeFiltered = opts.timeFiltered ?? true;

  const a = hexbinAttributes();
  const idColor = attribute('sttIdColor', 'vec3');

  const material = new MeshBasicNodeMaterial();
  material.positionNode = vec3(
    hexbinLocalPosition(a, hexbin, time, timeFiltered),
  );

  // FRAGMENT: flat per-cell id colour, opaque wherever the prism is drawn AND
  // occupied AND on-time. The soft window fade is a select() graph recomputed
  // here from VARIED raw inputs (never a varying-wrapped select), then
  // thresholded to a hard 0/1 alpha so a barely-faded cell cannot register a
  // partial-alpha id.
  material.colorNode = varying(idColor);
  const cutoff = opts.alphaCutoff ?? 0.01;
  let onGate: TSLNode = varying(a.visible).greaterThan(float(0.5));
  if (timeFiltered) {
    onGate = onGate.and(
      timeFilterAlphaNode(
        'window',
        time,
        varying(a.start),
        varying(a.end),
      ).greaterThan(float(cutoff)),
    );
  }
  material.opacityNode = select(onGate, float(1), float(0));

  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.alphaTest = 0.5;

  return { material, time, hexbin, timeFiltered };
}
