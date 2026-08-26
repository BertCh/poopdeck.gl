// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `ColumnMaterial` — lit extruded prisms (3D bars), the Three port of deck's
 * `AnimatedColumnLayer` over a `STTColumnLayer` sublayer. Each instance is a unit
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
 * ── TIME ──────────────────────────────────────────────────────────────────────
 * HARD cut (VERTEX stage): the prism offset is multiplied by the hard
 * {@link timeFilterVisibleNode} gate, so a time-filtered prism outside its window
 * collapses to a zero-volume prism at `base` (every vertex coincides → dies at
 * assembly, no fragment cost; deck.gl #7509) instead of an alpha-cutoff discard.
 * SOFT fade (`opacityNode`): the window alpha is a `select()`, so we vary the RAW
 * per-instance `start`/`end` and recompute the alpha in the FRAGMENT stage —
 * never wrap a `select()` in a `varying()` (mirrors point-material.ts).
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide } from 'three';
import type { Texture } from 'three';
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
import { PaletteUniforms, paletteColorNode } from './palette.js';

/** Ambient floor of the baked self-lit shade (shadowed faces stay readable). */
const COLUMN_AMBIENT = 0.45;
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  timeFilterVisibleNode,
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
import { TimeHeightUniforms } from './time-height.js';
import {
  resolveExtensions,
  extensionHooks,
  type MaterialHooks,
  type ResolvedExtensions,
  type STTExtensionOptions,
} from './extensions.js';

// The space-time-cube lift holder is shared with the other lifting materials;
// re-exported here so a bundle's `timeHeight` field is nameable from the module
// that produced the bundle.
export { TimeHeightUniforms };

/** Live column uniforms (constant opacity multiplier on top of the time window). */
export class ColumnUniforms {
  readonly opacity: UniformNode = uniform(1);
}

export interface ColumnMaterialOptions extends STTExtensionOptions {
  /** Apply the window time-filter (fade by `[start,end]` overlap). @default true */
  timeFiltered?: boolean;
  /** Translucent columns (window fade). @default false (opaque, depth-sorted) */
  transparent?: boolean;
  /** Discard fragments below this alpha when transparent. @default 0.01 */
  alphaCutoff?: number;
  /**
   * Install the GPU column filter (deck `DataFilterExtension`): binds a
   * per-instance `sttFilterValue` attribute and gates each prism by
   * `filterRange`/`filterSoftRange` (hard range → prism collapse, soft band →
   * fade). @default false
   */
  dataFilter?: boolean;
  /**
   * Install the time-as-height ("space-time cube") lift (deck `timeHeightScale`):
   * binds the per-instance `sttLift` direction attribute + `heightScale` /
   * `heightOrigin` uniforms and raises each prism's foot by
   * `(sttStart − heightOrigin) × heightScale` metres along local up. A single
   * scale uniform, so animating the flat⇄cube morph is free; `heightScale = 0`
   * renders flat. Composes with the time-filter + column-filter collapse gates.
   * @default false
   */
  timeHeight?: boolean;
  /**
   * GPU stable categorical colour (deck `CategoryColorExtension`): when set, the
   * per-instance `sttColor` attribute is REPLACED by a palette-texture sample
   * indexed by the per-instance `sttCategoryIndex` slot, so a category renders the
   * same colour in every tile and recolouring is a uniform/texture swap. Off
   * (undefined) leaves the constant/per-instance colour path BYTE-IDENTICAL.
   * @default undefined
   */
  colorPalette?: { texture: Texture };
}

export interface ColumnMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  column: ColumnUniforms;
  timeFiltered: boolean;
  /** Present only when built with `dataFilter: true`; drives the column filter. */
  filter?: DataFilterUniforms;
  /** Present only when built with `timeHeight: true`; drives the space-time-cube lift. */
  timeHeight?: TimeHeightUniforms;
  /** Present only when built with `colorPalette`; carries the palette-texture width. */
  palette?: PaletteUniforms;
  /**
   * Present ONLY when at least one user extension was composed (see
   * `./extensions.ts`); carries their uniform nodes and the attributes the host
   * must bind onto the live geometry.
   */
  extensions?: ResolvedExtensions;
}

function normalizeNode(v: TSLNode): TSLNode {
  return v.normalize();
}

/**
 * The `size` seam for a prism. A column carries its extent in the three basis
 * vectors, not in a scalar, so the seam is fed the neutral scale `1` and its
 * result multiplies the object-space offset — the shipped expression is left
 * untouched when nobody declares the seam.
 */
function scaledPrismOffset(hooks: MaterialHooks, offset: TSLNode): TSLNode {
  return hooks.has('size') ? offset.mul(hooks.size(float(1))) : offset;
}

export function createColumnMaterial(
  opts: ColumnMaterialOptions = {},
): ColumnMaterialBundle {
  const time = new TimeFilterUniforms();
  const column = new ColumnUniforms();
  // User extensions (`./extensions.ts`). Empty ⇒ the shared identity hooks, so
  // every expression below is byte-identical to the un-extended material.
  const ext = resolveExtensions('column', opts.extensions);
  const hooks = extensionHooks(ext, { kind: 'column', pass: 'color', time });
  const timeFiltered = opts.timeFiltered ?? true;
  const transparent = opts.transparent ?? false;
  const dataFilter = opts.dataFilter ?? false;
  const filter = dataFilter ? new DataFilterUniforms() : undefined;
  const timeHeight = opts.timeHeight ?? false;
  const height = timeHeight ? new TimeHeightUniforms() : undefined;
  const paletteU = opts.colorPalette ? new PaletteUniforms() : undefined;

  const base = attribute('sttBase', 'vec3');
  const bx = attribute('sttBasisX', 'vec3');
  const by = attribute('sttBasisY', 'vec3');
  const bz = attribute('sttBasisZ', 'vec3');
  // Colour: GPU stable-palette sample (per-instance `sttCategoryIndex` slot) when
  // a palette texture is installed; otherwise the per-instance `sttColor` attr.
  const color = paletteU
    ? paletteColorNode(opts.colorPalette!.texture, paletteU)
    : attribute('sttColor', 'vec4');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const filterValue = dataFilter ? attribute('sttFilterValue', 'float') : null;

  const op = positionGeometry; // unit-prism object position
  const offset = scaledPrismOffset(
    hooks,
    bx.mul(op.x).add(by.mul(op.y)).add(bz.mul(op.z)),
  );
  // HARD vertex-stage collapse: an out-of-window (time-filtered) OR out-of-range
  // (column-filtered) prism shrinks to a zero-volume prism at `base` (all
  // vertices coincide → dies at assembly). Not filtered ⇒ gate = 1 (no collapse).
  // The soft window / soft-range fades stay in the fragment `opacityNode` below.
  let visible = timeFiltered
    ? timeFilterVisibleNode('window', time, start, end)
    : float(1);
  if (filter && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filter, filterValue));
  }
  // Time-as-height ("space-time cube"): raise the prism FOOT by the feature's
  // start time before adding the (window/filter-gated) body offset, so the whole
  // prism rises coherently. `sttLift` carries world-units-per-metre-of-altitude
  // (local up ÷ metersPerWorldUnit), so `sttLift × heightMeters` is the world
  // displacement. A collapsed prism still coincides at the lifted foot → stays a
  // zero-volume degenerate. `heightScale = 0` ⇒ +0 (byte-identical flat render).
  let foot: TSLNode = base;
  if (height) {
    const lift = attribute('sttLift', 'vec3');
    const heightMeters = start.sub(height.heightOrigin).mul(height.heightScale);
    foot = base.add(lift.mul(heightMeters));
  }
  // `position` seam, gate LAST: with a hook this becomes
  // `foot + (hook(foot+offset) − foot)·visible`, so a gated prism still
  // degenerates exactly at `foot`; without one it is `foot + offset·visible`,
  // node for node.
  const local = hooks.offsetPosition(foot, offset, visible);

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

  // Per-instance albedo × baked shade, then sRGB→working (see ./color-space.ts).
  // The shade multiplies INSIDE the conversion because deck darkens the 0–255
  // colour the same way — converting first would change the falloff curve.
  const vColor = varying(color);
  // `color` seam sits INSIDE srgbToWorking and AFTER the baked shade, so an
  // extension sees exactly the sRGB value deck would have written.
  material.colorNode = srgbToWorking(hooks.color(vColor.xyz.mul(shade)));

  // Time window → opacity (vary raw start/end; recompute the select() alpha here).
  const vStart = varying(start);
  const vEnd = varying(end);
  const fragAlpha = timeFiltered
    ? timeFilterAlphaNode('window', time, vStart, vEnd)
    : float(1);
  // `alpha` seam takes the base alpha; the soft window/filter ramps multiply
  // AFTER it, so a hook can only ever subtract visibility.
  let opacityNode = hooks.alpha(vColor.a.mul(column.opacity)).mul(fragAlpha);
  if (filter && filterValue) {
    // Soft column-filter fade (vary the raw value; the alpha node is a
    // mix()/step() graph, never a select(), so it is varying-safe).
    opacityNode = opacityNode.mul(
      dataFilterAlphaNode(filter, varying(filterValue)),
    );
  }
  material.opacityNode = opacityNode;

  material.transparent = transparent;
  material.depthWrite = transparent ? false : true;
  material.depthTest = true;
  material.side = DoubleSide;
  if (transparent) material.alphaTest = opts.alphaCutoff ?? 0.01;

  const bundle: ColumnMaterialBundle = {
    material,
    time,
    column,
    timeFiltered,
    filter,
    timeHeight: height,
    palette: paletteU,
  };
  if (ext.active) bundle.extensions = ext;
  return bundle;
}

export interface ColumnUniformValues {
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

export function updateColumnUniforms(
  bundle: ColumnMaterialBundle,
  v: ColumnUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.column.opacity.value = v.opacity ?? 1;
  if (bundle.filter) updateDataFilterUniforms(bundle.filter, v.dataFilter);
  if (bundle.timeHeight) {
    bundle.timeHeight.heightScale.value = v.timeHeight?.heightScale ?? 0;
    bundle.timeHeight.heightOrigin.value = v.timeHeight?.heightOrigin ?? 0;
  }
}

// ── GPU id-buffer pick material (GPU picking catalog: column variant) ────────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Renders each column's flat
// per-instance id colour (`sttIdColor`, from `buildIdColors(mergedCount)`) into
// the picker's off-screen target. It recomposes the SAME prism as the colour
// material (identical `positionNode`), REUSING the identical vertex-stage collapse
// gates — the time-filter {@link timeFilterVisibleNode} AND the column
// {@link dataFilterVisibleNode}, AND the time-as-height lift — so an out-of-window
// / out-of-filter-range / lifted prism picks EXACTLY where (and only when) it is
// drawn. The id is written opaque at full intensity (never × alpha), so the
// decoded RGB is an exact 24-bit index; off-time / off-range fragments are
// discarded (opacity 0 + alphaTest) so they never win a pick. Bind
// {@link updateColumnUniforms} to sync its time / filter / lift uniforms before
// the pass. The returned bundle is shape-compatible with {@link ColumnMaterialBundle}.

/**
 * Build the column id material. `opts` mirror the colour material's gate options
 * (`timeFiltered`, `dataFilter`, `timeHeight`, `alphaCutoff`) so the pick pass
 * matches the on-screen prisms; the colour-only options (`transparent`,
 * `colorPalette`) are ignored (the id is a flat per-instance colour).
 */
export function createColumnIdMaterial(
  opts: ColumnMaterialOptions = {},
): ColumnMaterialBundle {
  const time = new TimeFilterUniforms();
  const column = new ColumnUniforms();
  // SAME extension seams as the colour material (position / size / alpha), so a
  // hook that moves or rescales a prism picks exactly where it draws. The
  // `color` seam is inert in the id pass — the index must decode bit-exact.
  const ext = resolveExtensions('column', opts.extensions);
  const hooks = extensionHooks(ext, { kind: 'column', pass: 'id', time });
  const timeFiltered = opts.timeFiltered ?? true;
  const dataFilter = opts.dataFilter ?? false;
  const filter = dataFilter ? new DataFilterUniforms() : undefined;
  const timeHeight = opts.timeHeight ?? false;
  const height = timeHeight ? new TimeHeightUniforms() : undefined;

  const base = attribute('sttBase', 'vec3');
  const bx = attribute('sttBasisX', 'vec3');
  const by = attribute('sttBasisY', 'vec3');
  const bz = attribute('sttBasisZ', 'vec3');
  const idColor = attribute('sttIdColor', 'vec3');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const filterValue = dataFilter ? attribute('sttFilterValue', 'float') : null;

  const op = positionGeometry; // unit-prism object position
  const offset = scaledPrismOffset(
    hooks,
    bx.mul(op.x).add(by.mul(op.y)).add(bz.mul(op.z)),
  );
  // SAME hard vertex-stage collapse as the colour material: out-of-window /
  // out-of-range prisms shrink to a zero-volume degenerate at the (lifted) foot,
  // so they never rasterise → are never pickable, exactly matching the eye.
  let visible = timeFiltered
    ? timeFilterVisibleNode('window', time, start, end)
    : float(1);
  if (filter && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filter, filterValue));
  }
  let foot: TSLNode = base;
  if (height) {
    const lift = attribute('sttLift', 'vec3');
    const heightMeters = start.sub(height.heightOrigin).mul(height.heightScale);
    foot = base.add(lift.mul(heightMeters));
  }
  const local = hooks.offsetPosition(foot, offset, visible);

  const material = new MeshBasicNodeMaterial();
  material.positionNode = vec3(local);

  // FRAGMENT: flat per-instance id colour, opaque wherever the prism is drawn AND
  // on-time AND in-range. The soft window / column-filter fades are `select()` /
  // mix() graphs recomputed here from VARIED raw inputs (never a varying-wrapped
  // select), then thresholded to a hard 0/1 alpha so a barely-faded prism doesn't
  // register a partial-alpha id.
  material.colorNode = varying(idColor);
  const cutoff = opts.alphaCutoff ?? 0.01;
  let onGate: TSLNode | null = null;
  if (timeFiltered) {
    onGate = timeFilterAlphaNode(
      'window',
      time,
      varying(start),
      varying(end),
    ).greaterThan(float(cutoff));
  }
  if (filter && filterValue) {
    const fg = dataFilterAlphaNode(filter, varying(filterValue)).greaterThan(
      float(cutoff),
    );
    onGate = onGate ? onGate.and(fg) : fg;
  }
  if (hooks.has('alpha')) {
    // The id is opaque, so the alpha seam is fed `1` and its result thresholded
    // into the pick gate: an extension that MASKS a prism to zero makes it
    // unpickable (matching the eye); one that merely dims it does not.
    const ug = hooks.alpha(float(1)).greaterThan(float(cutoff));
    onGate = onGate ? onGate.and(ug) : ug;
  }
  material.opacityNode = onGate ? select(onGate, float(1), float(0)) : float(1);

  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.alphaTest = 0.5;

  const bundle: ColumnMaterialBundle = {
    material,
    time,
    column,
    timeFiltered,
    filter,
    timeHeight: height,
  };
  if (ext.active) bundle.extensions = ext;
  return bundle;
}
