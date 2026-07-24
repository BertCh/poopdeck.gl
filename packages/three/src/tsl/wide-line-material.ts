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
 * Time modes (shared {@link timeFilterAlphaNode} soft band +
 * {@link timeFilterVisibleNode} hard vertex collapse):
 *   • `window`  — whole-feature visibility over `[sttStart,sttEnd]` (Path/OD-Line).
 *   • `trail`   — per-vertex fade behind the playhead over `[cur-trail,cur]` using
 *                 the interpolated per-vertex time (Trips, AND the Path kind's
 *                 progressive reveal — deck `revealTrail` — which drives this same
 *                 per-vertex gate with arc-length reveal times so a timeless line
 *                 inks itself in up to the playhead).
 *   • `none`    — always visible.
 * The HARD cut is a vertex-stage collapse: an out-of-window/out-of-trail vertex
 * gets segment width ×0 so the quad's two sides coincide on the centreline (zero
 * area → dies at assembly, no fragment cost, keeps early-Z; deck.gl #7509). The
 * soft fade band stays in the fragment `opacityNode`.
 * Colour interpolates per-vertex (`sttColorA`→`sttColorB`) for trip gradients.
 *
 * WGSL: the soft alpha is a `select()`, computed in the FRAGMENT stage from
 * VARIED raw inputs — never wrapped in a `varying()` (the codebase's recurring
 * WGSL crash). The vertex visibility gate is branch-free (`step()`). `mix()`
 * colour/time gradients ARE safe to vary.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending, AdditiveBlending } from 'three';
import type { Texture } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  select,
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
  type TSLNode,
} from './nodes.js';
import { PaletteUniforms, paletteColorNode } from './palette.js';
import {
  TimeFilterUniforms,
  windowAlphaNode,
  windowVisibleNode,
  trailAlphaNode,
  trailVisibleNode,
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
  /**
   * Install the GPU column filter (deck `DataFilterExtension`): binds a
   * per-instance `sttFilterValue` attribute and gates each segment by
   * `filterRange`/`filterSoftRange` (hard range → width collapse, soft band →
   * fade). Serves the `line`, `od-line` and `trips` kinds. @default false
   */
  dataFilter?: boolean;
  /**
   * GPU stable categorical colour (deck `CategoryColorExtension`): when set, each
   * segment is coloured by a palette-texture sample indexed by the per-instance
   * `sttCategoryIndex` slot (a single per-feature colour, no A→B gradient), so a
   * category renders the same colour in every tile and recolouring is a
   * uniform/texture swap. Off (undefined) leaves the `sttColorA`→`sttColorB`
   * gradient path BYTE-IDENTICAL. @default undefined
   */
  colorPalette?: { texture: Texture };
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
  /** Present only when built with `dataFilter: true`; drives the column filter. */
  filter?: DataFilterUniforms;
  /** Present only when built with `colorPalette`; carries the palette-texture width. */
  palette?: PaletteUniforms;
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
  const dataFilter = opts.dataFilter ?? false;
  const filter = dataFilter ? new DataFilterUniforms() : undefined;
  const filterValue = dataFilter ? attribute('sttFilterValue', 'float') : null;
  const paletteU = opts.colorPalette ? new PaletteUniforms() : undefined;

  const posA = attribute('sttPosA', 'vec3');
  const posB = attribute('sttPosB', 'vec3');
  const along = positionGeometry.x; // 0 (A) .. 1 (B)
  const side = positionGeometry.y; // -1 .. +1

  // Time gate — `visible` (hard 0/1) collapses the segment WIDTH in the vertex
  // stage; `alpha` (soft) fades it in the fragment stage. Both derive from the
  // same window/trail test on the raw per-vertex times, so a collapsed segment is
  // exactly one whose alpha is 0 (deck.gl #7509: no alpha-cutoff raster cost).
  //   • window — per-INSTANCE (both endpoints share `[start,end]`).
  //   • trail  — per-VERTEX (each end tests its own interpolated time; a segment
  //              fully outside the trail collapses to zero area, a boundary
  //              segment tapers where the alpha is already ~0). Also serves the
  //              Path kind's progressive reveal, whose `sttTimeA/B` are the
  //              synthesized arc-length reveal times.
  let visible = float(1);
  let alpha = float(1);
  if (mode === 'window') {
    const start = attribute('sttStart', 'float');
    const end = attribute('sttEnd', 'float');
    visible = windowVisibleNode(time, start, end);
    alpha = windowAlphaNode(time, varying(start), varying(end));
  } else if (mode === 'trail') {
    const tA = attribute('sttTimeA', 'float');
    const tB = attribute('sttTimeB', 'float');
    const segTime = mix(tA, tB, along); // per-vertex time gradient
    visible = trailVisibleNode(time, segTime);
    alpha = trailAlphaNode(time, varying(segTime));
  }

  // Column filter (deck DataFilterExtension): the segment collapses when its
  // per-instance `filterValue` is out of `filterRange` (hard width gate), and
  // fades across `filterSoftRange` (soft opacity). `filterValue` is per-feature,
  // so both endpoints of a segment share it — the segment collapses as a whole.
  if (filter && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filter, filterValue));
    alpha = alpha.mul(dataFilterAlphaNode(filter, varying(filterValue)));
  }

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
  // pixel half-offset (side·widthPx/2) → NDC (×2/viewport) → clip (×w), ×visible
  // so an out-of-window/out-of-trail vertex collapses the quad width to 0.
  const off = perp
    .mul(side)
    .mul(line.widthPx)
    .mul(visible)
    .div(line.viewport)
    .mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(off.x),
    clip.y.add(off.y),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: gradient colour (or unified palette colour) + time alpha ───────
  // Palette path: a single per-feature category colour drives the segment (no
  // A→B gradient). The per-vertex colour attributes are not read, so they are not
  // declared (mirrors the arc palette path). Off ⇒ the gradient is byte-identical.
  const vColor = paletteU
    ? varying(paletteColorNode(opts.colorPalette!.texture, paletteU))
    : varying(
        mix(
          attribute('sttColorA', 'vec4'),
          attribute('sttColorB', 'vec4'),
          along,
        ),
      ); // gradient (mix is varying-safe)

  material.colorNode = vColor.xyz;
  material.opacityNode = vColor.a.mul(line.opacity).mul(alpha);
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.side = DoubleSide;
  material.blending = opts.additive ? AdditiveBlending : NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.02;

  return { material, time, line, mode, filter, palette: paletteU };
}

export interface WideLineUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  /** Full line width in CSS pixels. */
  widthPx?: number;
  opacity?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
  /** Column-filter props (no-op unless built with `dataFilter: true`). */
  dataFilter?: DataFilterOptions;
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
  if (bundle.filter) updateDataFilterUniforms(bundle.filter, v.dataFilter);
}

// ── GPU id-buffer pick material (GPU picking catalog: wide-line family variant) ──
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Serves the WHOLE wide-line
// family — the `line`, `od-line`, `trips` and `path` kinds all ride the shared
// {@link createWideLineMaterial} ribbon, so ONE id material (per `mode`) covers
// them. It expands the SAME segment quad as the colour material (identical
// screen-space width `vertexNode`), REUSING the identical vertex-stage
// width-collapse gate — {@link windowVisibleNode} / {@link trailVisibleNode}
// (whichever `mode` selects) AND {@link dataFilterVisibleNode} — so an
// out-of-window / behind-the-trail / out-of-filter-range segment collapses to a
// zero-area degenerate quad and is never pickable, exactly matching the eye. The
// ribbon is painted the flat per-instance id colour (`sttIdColor`, from
// `buildIdColors(mergedCount)`) at full intensity; off-time / off-range fragments
// are discarded (opacity 0 + alphaTest) and depth is written so the nearest
// segment wins the pick. Bind {@link updateWideLineUniforms} to sync
// time / width / viewport / filter before the pass. Shape-compatible with
// {@link WideLineMaterialBundle}.

/**
 * Build the wide-line id material. `opts` mirror the colour material's gate
 * options (`mode`, `dataFilter`, `alphaCutoff`) so the pick pass matches the
 * on-screen ribbon; the colour-only options (`additive`, `depthWrite`,
 * `colorPalette`) are ignored (the id is a flat per-instance colour, opaque with
 * depth-write so the front-most segment wins). Reused by all four wide-line kinds:
 * `line`/`od-line` (`mode: 'window'`), `trips` (`mode: 'trail'`), and `path`
 * (`'window'` or, under reveal, `'trail'`).
 */
export function createWideLineIdMaterial(
  opts: WideLineMaterialOptions = {},
): WideLineMaterialBundle {
  const mode: WideLineMode = opts.mode ?? 'none';
  const time = new TimeFilterUniforms();
  const line = new WideLineUniforms();
  const dataFilter = opts.dataFilter ?? false;
  const filter = dataFilter ? new DataFilterUniforms() : undefined;
  const filterValue = dataFilter ? attribute('sttFilterValue', 'float') : null;

  const posA = attribute('sttPosA', 'vec3');
  const posB = attribute('sttPosB', 'vec3');
  const idColor = attribute('sttIdColor', 'vec3');
  const along = positionGeometry.x; // 0 (A) .. 1 (B)
  const side = positionGeometry.y; // -1 .. +1

  const cutoff = opts.alphaCutoff ?? 0.02;

  // SAME hard vertex-stage width-collapse gate as the colour material (`visible`),
  // plus a FRAGMENT on-gate (`onGate`) recomputing the soft window/trail/filter
  // alpha from VARIED raw inputs and thresholding to a hard 0/1 (never a
  // varying-wrapped select). `none` mode has no time gate → onGate stays null.
  let visible: TSLNode = float(1);
  let onGate: TSLNode | null = null;
  if (mode === 'window') {
    const start = attribute('sttStart', 'float');
    const end = attribute('sttEnd', 'float');
    visible = windowVisibleNode(time, start, end);
    onGate = windowAlphaNode(time, varying(start), varying(end)).greaterThan(
      float(cutoff),
    );
  } else if (mode === 'trail') {
    const tA = attribute('sttTimeA', 'float');
    const tB = attribute('sttTimeB', 'float');
    const segTime = mix(tA, tB, along); // per-vertex time gradient (varying-safe)
    visible = trailVisibleNode(time, segTime);
    onGate = trailAlphaNode(time, varying(segTime)).greaterThan(float(cutoff));
  }
  if (filter && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filter, filterValue));
    const fg = dataFilterAlphaNode(filter, varying(filterValue)).greaterThan(
      float(cutoff),
    );
    onGate = onGate ? onGate.and(fg) : fg;
  }

  // ── VERTEX: identical screen-space width expansion to the colour material ─────
  const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
  const clipA = mvp.mul(vec4(posA, 1));
  const clipB = mvp.mul(vec4(posB, 1));
  const ndcA = clipA.xy.div(clipA.w);
  const ndcB = clipB.xy.div(clipB.w);
  const dir = ndcB.sub(ndcA).mul(line.viewport).normalize();
  const perp = vec2(dir.y.negate(), dir.x);
  const clip = mix(clipA, clipB, along);
  const off = perp
    .mul(side)
    .mul(line.widthPx)
    .mul(visible)
    .div(line.viewport)
    .mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(off.x),
    clip.y.add(off.y),
    clip.z,
    clip.w,
  );

  // FRAGMENT: flat per-instance id colour, opaque wherever the ribbon is drawn AND
  // on-time AND in-range.
  material.colorNode = varying(idColor);
  material.opacityNode = onGate ? select(onGate, float(1), float(0)) : float(1);

  material.transparent = false;
  material.depthTest = true;
  material.depthWrite = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = 0.5;

  return { material, time, line, mode, filter };
}
