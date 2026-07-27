// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Flowmap geometry adapter — animated origin→destination **flow arrows**.
 *
 * One tapered arrow per OD pair whose WIDTH tracks the pair's trip volume at
 * the playhead: as the slider scrubs, corridors swell and recede with demand.
 * That is the whole animation — there is no time filter doing the work, because
 * a flow tile is TIMELESS (every feature's `[startTime, endTime]` spans the
 * archive's whole range, so it loads once and never re-fetches) and an arrow
 * whose current flow is at or below `minFlow` simply has width 0.
 *
 * The deck sibling is `@poopdeck.gl/layers`'s `FlowmapLayer` + its internal
 * `FlowLinesLayer` (itself a port of flowmap.gl's arrow primitive). Same
 * geometry vocabulary, same defaults, same `√flow` width law — but the
 * magnitude decode happens on the GPU here, not the CPU, which is the whole
 * point of this layer (see below).
 *
 * ── The contract this layer exists to keep ──────────────────────────────────
 *
 *   **Geometry is built once per tile and is REF-STABLE. Magnitude reaches the
 *   GPU as a TEXTURE plus ONE per-frame scalar uniform (`uFlowBucket`).**
 *
 * | changes                | when                   | cost                |
 * | ---------------------- | ---------------------- | ------------------- |
 * | instance buffers       | tile upload / eviction | once per tile       |
 * | value-matrix texture   | tile upload / eviction | once per tile       |
 * | `uFlowBucket` uniform  | every frame            | one `uniform1f`     |
 * | magnitude per vertex   | every frame, ON THE GPU| 2 texture fetches   |
 *
 * The deck backend re-expands a width buffer every ~5 Hz sub-step and its
 * corridor sibling once re-tessellated a whole street network at that rate (the
 * rivers/rain perf root-cause note). `lib/flow-kernel.ts`'s module header is the
 * long version; `flowTileKey`'s doc-comment is the guard rail. Nothing in this
 * layer's per-frame path allocates, re-tessellates or re-uploads — except the
 * declared CPU fallback below, which is gated to a sub-step.
 *
 * ── Topology ────────────────────────────────────────────────────────────────
 * One INSTANCE per OD pair; the shared per-vertex template is a strip of
 * `2·(shaftSegments + 1) + 2·(headSegments + 1)` vertices carrying
 * `(regionT, side, region)` — see {@link buildFlowArrowTemplate}. The shaft
 * region walks `t = 0 … shaftEnd` at the corridor's half-width; the head region
 * walks `shaftEnd … 1` flaring to `headWidth` and closing to a point at the
 * destination. The two regions DUPLICATE the sample at `shaftEnd` (one at shaft
 * width, one at head width) exactly as flowmap.gl's 9-vertex template does, so
 * the shoulder is a hard step rather than a ramp; the degenerate quad between
 * them rasterizes nothing.
 *
 * Raising the segment count therefore costs vertices only — never bytes, never
 * a tile rebuild — which is what lets globe frames refine the tessellation in
 * place ({@link STTFlowmapLayer.segmentsFor}, the arc layer's rule).
 *
 * ── Pre-baked bundles ───────────────────────────────────────────────────────
 * `liveBundling` (GPU KDEEB edge bundling) is a **permanent declared fallback**
 * for this backend: it depends on luma transform feedback, which this
 * dependency-free adapter has no access to. What this layer DOES honour is
 * bundle geometry
 * an archive already baked: an OD feature with interior vertices contributes a
 * quadratic Bézier control point ({@link bundleControlPoint}) so the arrow
 * follows the bundle's own bulge. A plain 2-vertex feature gets the chord
 * MIDPOINT as its control, which reduces the Bézier exactly to
 * `mix(source, target, t)` — one code path, no per-tile shader.
 *
 * ── Magnitude: GPU by default, CPU where the host cannot ────────────────────
 * `sttFlowMagnitude` samples the packed value matrix in the VERTEX stage, which
 * WebGL2 guarantees and WebGL1 does not (its `MAX_VERTEX_TEXTURE_IMAGE_UNITS`
 * minimum is ZERO). {@link STTFlowmapLayer} probes once per context
 * (`supportsVertexTextureFetch`) and compiles either:
 *   - `magnitude: 'texture'` — `aFlowRow` + the matrix texture (the real path); or
 *   - `magnitude: 'attribute'` — a per-instance `aFlowMagnitude` re-expanded by
 *     `expandFlowMagnitudes` into a caller-owned scratch and re-uploaded only
 *     when the playhead crosses `CPU_FALLBACK_SUB_STEP`.
 *
 * A tile with NO value matrix at all falls through to the static
 * `vertexValues` channel, packed as a ONE-column matrix — so the clamped
 * sampler reads that single column at every playhead position and the shader
 * stays identical (deck's `matrix.length < …` fall-through, expressed as data).
 *
 * ── Feature surface ─────────────────────────────────────────────────────────
 *   - all four time modes, compiled in, never a uniform branch (`trail` is
 *     per-VERTEX: the arrow draws itself origin→destination across
 *     `[startTime, endTime]`, the same superset the arc layer offers);
 *   - DataFilter (`filterProperty` + ranges) bound per FEATURE — one instance
 *     is one feature, so no expansion pass;
 *   - three colour modes: the source→target gradient (deck parity), a
 *     magnitude ramp (`sttFlowRampT`), or a keyed categorical `colorMapping`;
 *   - `widthUnits: 'meters'` metric sizing with deck's pixel clamps;
 *   - id-FBO picking under the IDENTICAL gates — time, DataFilter, colour alpha
 *     AND the magnitude gate, so an arrow below `minFlow` is not a hit target.
 *
 * ── Deliberate gaps (see the package CHANGELOG / descriptor) ────────────────
 *   - **Node circles.** deck's `FlowmapLayer` also draws a circle per station
 *     sized by incident flow, which needs a CPU aggregation across every
 *     visible tile per sub-step — exactly the per-frame CPU path this layer
 *     exists to avoid, so it is deferred rather than ported;
 *     `sourceInsetPixels` / `targetInsetPixels` are the hook a node overlay
 *     would drive.
 *   - **liveBundling.** Permanent fallback (above).
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_LINE_PALETTE } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type STTFilterableLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from '../base-layer.js';
import { lngLatToMercatorInto } from '../lib/projection.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import {
  CPU_FALLBACK_SUB_STEP,
  bucketPositionAt,
  chooseFlowMatrixFormat,
  createFlowMatrixUniforms,
  deriveFlowAxis,
  expandFlowMagnitudes,
  extractFlowOdPairs,
  packValueMatrix,
  packVertexValueMatrix,
  quantizeBucketPosition,
  resolveFlowMatrixUniforms,
  supportsVertexTextureFetch,
  type FlowBucketAxis,
  type FlowMatrixUniforms,
  type PackedValueMatrix,
} from '../lib/flow-kernel.js';
import {
  FLOW_MAGNITUDE_CALL_GLSL,
  FLOW_MATRIX_TEXTURE_RECIPE,
  FLOW_MATRIX_UNIFORMS_GLSL,
  FLOW_NAMES,
  FLOW_WIDTH_GLSL,
  buildFlowMatrixSampler,
  flowSamplerCacheKey,
  type FlowMatrixFormat,
} from '../shaders/flow.glsl.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_TRAIL_GLSL,
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE,
  resolveTimeUniformLocations,
  resolveWakeTailScaleUniformLocation,
  type TimeUniformLocations,
  type WakeTailScaleUniformLocation,
} from '../shaders/time-window.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type FilterTransformSizeUniformLocation,
} from '../shaders/data-filter.glsl.js';

/** The four real time-filter modes, under this layer's name. */
export type FlowmapTimeFilterMode = STTTimeFilterMode;

/** How a flowmap arrow takes its colour. Compiled in — see {@link flowmapProgramKey}. */
export type FlowmapColorMode = 'direction' | 'magnitude' | 'category';

/** Which side(s) of the centreline the arrow occupies. */
export type FlowmapArrowShape = 'half' | 'full';

/** deck `FlowmapLayer` defaults, so a ported app sees the same map. */
const DEFAULT_SOURCE_COLOR: RGBA8 = [56, 196, 232, 235];
const DEFAULT_TARGET_COLOR: RGBA8 = [255, 142, 64, 245];

/** Shared with the deck OD layers (single source of truth in core). */
const DEFAULT_FLOW_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_LINE_PALETTE;

/** Default shaft tessellation — enough for a baked bundle's curve to read smooth. */
const DEFAULT_SHAFT_SEGMENTS = 8;
/** Default head tessellation — one segment IS a triangle, which is the shape. */
const DEFAULT_HEAD_SEGMENTS = 1;

/**
 * Ceiling on the shaft segment count, including the globe refinement bump.
 * 256 shaft segments is ~520 vertices per instance — far past the point where
 * an arrow reads as smooth, and the guard that keeps a hostile
 * `subdivisionGranularity` from demanding unbounded vertex work.
 */
export const MAX_FLOWMAP_SEGMENTS = 256;

/** Ceiling on the head segment count (a triangle needs one). */
export const MAX_FLOWMAP_HEAD_SEGMENTS = 32;

/** `gl.MAX_TEXTURE_SIZE`, spelled numerically — the kernel stays GL-free. */
const GL_MAX_TEXTURE_SIZE = 0x0d33;
/** `gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS`, same reason. */
const GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8b4c;
/** `UNPACK_PREMULTIPLY_ALPHA_WEBGL` / `UNPACK_FLIP_Y_WEBGL` pixel-store enums. */
const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
const UNPACK_FLIP_Y_WEBGL = 0x9240;

export interface STTFlowmapLayerOptions extends STTFilterableLayerOptions {
  // ── magnitude → width ────────────────────────────────────────────────────
  /**
   * Flow at or below which an arrow collapses to width 0 — INVISIBLE, which is
   * the animation. Squelches sub-bucket blend noise so the map reads cleanly.
   * The pixel clamps below apply to ACTIVE arrows only, so `widthMinPixels`
   * never resurrects a dead one (deck parity).
   * @default 0.25
   */
  minFlow?: number;
  /**
   * Pixels of arrow width per unit of `magnitude ^ widthExponent`.
   * @default 1.1
   */
  widthScale?: number;
  /**
   * Exponent applied to the magnitude before {@link widthScale}. `0.5` (√) is
   * area-proportional and keeps a wide dynamic range legible — a 100-trip
   * corridor should not be 100× a 1-trip one.
   * @default 0.5
   */
  widthExponent?: number;
  /** Lower clamp on an ACTIVE arrow's width, in device pixels. @default 1 */
  widthMinPixels?: number;
  /** Upper clamp on an arrow's width, in device pixels. @default 12 */
  widthMaxPixels?: number;
  /**
   * Unit {@link widthScale} is expressed in. `'pixels'` (the default) is
   * constant-on-screen; `'meters'` sizes the arrow on the ground, resolved per
   * tile at its centre latitude and the map's FRACTIONAL zoom (deck
   * `widthUnits` parity, same screen-space caveat under pitch as `STTLineLayer`).
   * The pixel clamps stay in pixels either way.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters';
  /**
   * Decode `|value|` from the value matrix. STT's per-bucket-DIRECTION archives
   * carry a signed matrix whose sign is travel direction and whose magnitude is
   * the volume; blending signed values would dip through zero at a direction
   * flip. Off by default (deck's `blendMatrixRow` default), so turn it on for a
   * signed archive.
   * @default false
   */
  absoluteMagnitude?: boolean;
  /**
   * Explicit `[min, max]` for the fixed-point (`unorm16`) matrix decode used on
   * hosts without float textures. Defaults to each tile's own range, which is
   * exact per tile; pass a DATASET-wide range when several tiles must share one
   * decode. Ignored on the `float32` path.
   */
  magnitudeRange?: readonly [number, number];

  // ── arrow shape ──────────────────────────────────────────────────────────
  /**
   * `'half'` (flowmap.gl / deck parity) keeps the whole arrow on ONE side of
   * the centreline, so A→B and B→A sit side by side under {@link gap}.
   * `'full'` centres a symmetric ribbon on the corridor.
   * @default 'half'
   */
  arrowShape?: FlowmapArrowShape;
  /**
   * Constant perpendicular separation from the centreline, in units of the
   * arrow width. Defaults to `0.5` for `'half'` (deck) and `0` for `'full'`
   * (a centred ribbon wants no offset).
   */
  gap?: number;
  /**
   * Arrowhead length, in units of the arrow width (deck's `-3` template
   * pull-back). Capped at {@link headMaxFraction} of the corridor's on-screen
   * length so a short flow is not all head.
   * @default 3
   */
  headLength?: number;
  /**
   * Arrowhead half-width at its base, in units of the arrow width — the flare.
   * `1` gives no flare at all (a plain taper to a point).
   * @default 2
   */
  headWidth?: number;
  /** Cap on the head's share of the corridor length, `0..1`. @default 0.4 */
  headMaxFraction?: number;
  /**
   * Width multiplier at the ORIGIN end of the shaft, tapering to `1` at the
   * head base. `1` (the default) is deck's constant-width shaft; below 1 gives
   * the classic tapered flow ribbon.
   * @default 1
   */
  tailWidthScale?: number;
  /**
   * Segments the SHAFT is tessellated into. Higher is smoother along a baked
   * bundle's curve and costs vertices only — no extra bytes and no tile
   * rebuild. On globe frames the effective count is raised (never lowered)
   * until each piece is shorter than the host's subdivision granularity.
   * @default 8
   */
  numSegments?: number;
  /** Segments the arrowHEAD is tessellated into. @default 1 */
  headSegments?: number;
  /**
   * Honour pre-baked bundle geometry: an OD feature with interior vertices
   * bends its arrow through the bundle's apex ({@link bundleControlPoint}).
   * Turning it off compiles the control-point attribute out and always draws
   * the straight chord (deck parity, 8 fewer bytes per pair).
   * @default true
   */
  bundleGeometry?: boolean;
  /**
   * Inset the arrow's TAIL along the corridor by this many device pixels — the
   * hook for leaving a gap at a hub marker. Clamped to 40% of the corridor's
   * on-screen length so a short flow never inverts.
   * @default 0
   */
  sourceInsetPixels?: number;
  /** Inset the arrow's TIP along the corridor, in device pixels. @default 0 */
  targetInsetPixels?: number;

  // ── colour ───────────────────────────────────────────────────────────────
  /**
   * How an arrow takes its colour. Defaults to `'category'` when
   * {@link colorProperty} is set, else `'direction'`.
   *
   *   - `'direction'` — the {@link sourceColor} → {@link targetColor} gradient
   *     along the arrow (deck `FlowLinesLayer` parity).
   *   - `'magnitude'` — {@link magnitudeColorRange} sampled by the live flow
   *     through `sttFlowRampT` over {@link colorDomain}.
   *   - `'category'` — a per-feature colour from {@link colorProperty} +
   *     {@link colorMapping}/{@link colorPalette}; a tile missing the column
   *     falls back to the direction gradient.
   */
  colorMode?: FlowmapColorMode;
  /**
   * Colour at the ORIGIN, `[r, g, b, a]`. Accepts 0–255 ints (the deck `Color`
   * convention, and what `colorPalette` uses) or 0–1 floats — auto-detected.
   * @default [56, 196, 232, 235]
   */
  sourceColor?: RGBA8;
  /** Colour at the DESTINATION (the arrowhead). @default [255, 142, 64, 245] */
  targetColor?: RGBA8;
  /**
   * `[lowColour, highColour]` for `colorMode: 'magnitude'`.
   * @default [[56, 196, 232, 235], [255, 142, 64, 245]]
   */
  magnitudeColorRange?: readonly [RGBA8, RGBA8];
  /**
   * Magnitude range mapped onto {@link magnitudeColorRange}. Defaults to each
   * TILE's own observed range, which is self-tuning but tile-local — set a
   * dataset-wide domain whenever several tiles are on screen together and their
   * colours must be comparable.
   */
  colorDomain?: readonly [number, number];
  /**
   * Ramp shaping exponent: `<= 0` (the default) is linear, `0.5` lifts the low
   * end, `2` crushes it.
   * @default 0
   */
  colorGamma?: number;
  /** Drive per-feature colour from a categorical property name. */
  colorProperty?: string;
  /** Palette used with {@link colorProperty} (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA colour map (deck/three `colorMapping`
   * parity), so a category renders the same colour in every tile regardless of
   * per-tile dictionary order. Unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional {@link colorPalette}.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;

  // ── time ─────────────────────────────────────────────────────────────────
  /**
   * Which temporal filter the shader applies. Defaults to `'window'`.
   *
   * A flow archive's features span the WHOLE range, so `'window'` lights every
   * corridor at every playhead position — which is correct, because the
   * magnitude is the animation. The other three exist for archives that DO
   * carry per-corridor lifetimes (a road that opened mid-year, a seasonal
   * ferry): `'wake'` lights a corridor for {@link wakeLength} ms after its
   * `startTime`, `'cumulative'` reveals and keeps it, and `'trail'` draws the
   * arrow itself origin→destination across its `[startTime, endTime]`.
   *
   * `'wake'`/`'trail'` with a non-positive length knob degrade to `'window'`,
   * matching deck. The mode is a compile-time shader choice, so switching it
   * relinks one program per host variant — no tile rebuild.
   */
  timeFilterMode?: FlowmapTimeFilterMode;
  /**
   * Wake length in ms (`'wake'` mode). Defaults to HALF the layer's
   * `timeWindow` and TRACKS `setTimeWindow`; an explicit value is the caller's
   * and is never re-derived.
   */
  wakeLength?: number;
  /** Trailing-edge width multiplier in wake mode (0..1). Defaults to core's 0.15. */
  wakeTailScale?: number;
  /** Trail length in ms (`'trail'` mode). Defaults to half the layer's `timeWindow`. */
  trailLength?: number;
  /**
   * Trail head→tail fade: `1`/`true` (default) is the classic comet, `0`/
   * `false` a solid snake, intermediate numbers blend between them.
   */
  fadeTrail?: boolean | number;
}

// ── CPU references for the compiled GLSL ────────────────────────────────────

/**
 * Shift `x` by whole worlds so it lands within half a world of `referenceX` —
 * the antimeridian fix. Mercator x is periodic with period 1, so an OD pair
 * whose endpoints straddle ±180° (0.98 → 0.02) would otherwise sweep the LONG
 * way across the entire map. The unwrapped target (1.02) keeps the arrow short
 * and continuous; coordinates outside `[0, 1]` project fine (the host matrix is
 * affine in mercator, and on globe x simply reads as a longitude past ±180°).
 *
 * Exactly halfway resolves eastward — arbitrary but deterministic.
 *
 * Byte-identical to `STTArcLayer`'s `unwrapMercatorX`; kept under a distinct
 * name so the two can be exported side by side until one of them is hoisted
 * into `lib/projection.ts`.
 */
export function unwrapFlowMercatorX(referenceX: number, x: number): number {
  return x - Math.floor(x - referenceX + 0.5);
}

/**
 * Quadratic-Bézier control point for a pre-baked bundle, in MERCATOR.
 *
 * `interior` is the flat `[x0, y0, x1, y1, …]` mercator list of the feature's
 * vertices BETWEEN its endpoints. The apex is the interior vertex furthest from
 * the source→target chord — the bundle's bulge, i.e. its visual signature — and
 * the control point is placed so the curve passes exactly THROUGH it at
 * `t = 0.5` (`B(0.5) = (P0 + 2C + P2) / 4` ⟹ `C = 2·apex − (P0 + P2)/2`).
 *
 * With no interior vertices the control is the chord MIDPOINT, for which the
 * Bézier reduces algebraically to `mix(source, target, t)` — an exactly
 * straight arrow, so a plain OD archive needs no second code path.
 *
 * A single quadratic is a deliberate approximation of an arbitrary baked
 * polyline: it reproduces a single-lobe bundle (what edge-bundling produces)
 * and smooths a multi-lobe one. Non-finite input degrades to the midpoint.
 */
export function bundleControlPoint(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  interior?: ArrayLike<number>,
): [number, number] {
  const midX = (sx + tx) / 2;
  const midY = (sy + ty) / 2;
  const n = interior ? Math.floor(interior.length / 2) : 0;
  if (n === 0) return [midX, midY];
  const ax = tx - sx;
  const ay = ty - sy;
  const chord = Math.hypot(ax, ay);
  let bestX = midX;
  let bestY = midY;
  let bestScore = -1;
  for (let i = 0; i < n; i++) {
    const px = interior![i * 2];
    const py = interior![i * 2 + 1];
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    // Perpendicular distance to the chord; a degenerate chord (coincident
    // endpoints) has no perpendicular, so fall back to plain distance.
    const score =
      chord > 0
        ? Math.abs(ax * (py - sy) - ay * (px - sx)) / chord
        : Math.hypot(px - sx, py - sy);
    if (score > bestScore) {
      bestScore = score;
      bestX = px;
      bestY = py;
    }
  }
  const cx = 2 * bestX - midX;
  const cy = 2 * bestY - midY;
  return Number.isFinite(cx) && Number.isFinite(cy) ? [cx, cy] : [midX, midY];
}

/**
 * The shared per-vertex arrow template: `(regionT, side, region)` triples for a
 * `TRIANGLE_STRIP`, where `region` is `0` for the shaft and `1` for the head and
 * `regionT` walks `0 … 1` WITHIN that region.
 *
 * The sample at the shaft/head seam appears TWICE — once carrying the shaft's
 * width and once the head's flare — which is what makes the shoulder a step
 * instead of a ramp (flowmap.gl's template does the same with distinct
 * vertices). The quad joining the two pairs is degenerate (both pairs sit at the
 * same path position) and rasterizes nothing.
 */
export function buildFlowArrowTemplate(
  shaftSegments: number,
  headSegments: number,
): Float32Array {
  const s = sanitizeSegments(shaftSegments);
  const h = sanitizeSegments(headSegments);
  const out = new Float32Array(flowArrowVertexCount(s, h) * 3);
  let w = 0;
  const emit = (regionT: number, side: number, region: number): void => {
    out[w++] = regionT;
    out[w++] = side;
    out[w++] = region;
  };
  for (let i = 0; i <= s; i++) {
    const u = i / s;
    emit(u, -1, 0);
    emit(u, 1, 0);
  }
  for (let j = 0; j <= h; j++) {
    const u = j / h;
    emit(u, -1, 1);
    emit(u, 1, 1);
  }
  return out;
}

/** Vertices {@link buildFlowArrowTemplate} emits — `2·(S+1) + 2·(H+1)`. */
export function flowArrowVertexCount(
  shaftSegments: number,
  headSegments: number,
): number {
  const s = sanitizeSegments(shaftSegments);
  const h = sanitizeSegments(headSegments);
  return 2 * (s + 1) + 2 * (h + 1);
}

/** A segment count sanitized to an integer `>= 1` (non-finite ⇒ 1). */
function sanitizeSegments(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

/**
 * JS reference for the shader's head fraction: the arrowhead is `headLength`
 * arrow-widths long, expressed as a share of the corridor's on-screen length
 * and capped at `maxFraction` so a short flow is not all head.
 */
export function flowHeadFractionJS(
  widthPx: number,
  headLength: number,
  lenPx: number,
  maxFraction: number,
): number {
  const raw = (headLength * widthPx) / Math.max(lenPx, 1);
  return Math.min(Math.max(raw, 0), maxFraction);
}

/**
 * JS reference for the shader's path parameter at one template vertex:
 * the shaft spans `[0, 1 - headFrac]` and the head `[1 - headFrac, 1]`.
 */
export function flowArrowParamJS(
  regionT: number,
  region: number,
  headFrac: number,
): number {
  const shaftEnd = 1 - headFrac;
  return region < 0.5 ? regionT * shaftEnd : shaftEnd + regionT * headFrac;
}

/**
 * JS reference for the shader's width profile at one template vertex, in units
 * of the arrow's half-width: the shaft ramps `tailScale → 1`, the head flares to
 * `headWidth` at its base and closes to `0` at the tip.
 */
export function flowArrowProfileJS(
  regionT: number,
  region: number,
  tailScale: number,
  headWidth: number,
): number {
  return region < 0.5
    ? tailScale + (1 - tailScale) * regionT
    : headWidth * (1 - regionT);
}

/**
 * Observed `[min, max]` of a magnitude source, honouring the `absolute`
 * decode and skipping the NaN entries STT bakes for "no value". Returns
 * `[0, 0]` for an all-NaN / empty input. Feeds the per-tile default
 * {@link STTFlowmapLayerOptions.colorDomain}.
 */
export function flowMagnitudeRange(
  values: ArrayLike<number>,
  total: number,
  absolute: boolean,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const n = Math.min(total, values.length);
  for (let i = 0; i < n; i++) {
    const raw = values[i];
    if (!Number.isFinite(raw)) continue;
    const v = absolute ? Math.abs(raw) : raw;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 0];
  return [min, max];
}

/**
 * Resolve the COMPILED time mode from the requested one and the two length
 * knobs, applying deck's rule: `TimeFilterExtension` enters its wake branch only
 * for `wakeLength > 0` and its trail branch only for `trailLength > 0`,
 * otherwise falling through to the window branch. Both degenerate kernels return
 * 0, so a mode left in that state would draw nothing at all.
 */
export function resolveFlowmapTimeFilterMode(
  requested: FlowmapTimeFilterMode,
  wakeLength: number,
  trailLength: number,
): FlowmapTimeFilterMode {
  if (requested === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (requested === 'trail') return trailLength > 0 ? 'trail' : 'window';
  return requested;
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builder consumes. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled flowmap program supports. Every field is structural (it adds
 * attributes / uniforms / statements), so each combination is its own program
 * and each must appear in the program-cache key — {@link flowmapProgramKey}.
 */
export interface FlowmapShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: FlowmapTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
  /** Which colour surface is compiled in. */
  colorMode: FlowmapColorMode;
  /** Compile the baked-bundle control point (a quadratic path instead of a chord). */
  bundle: boolean;
  /**
   * Where the live magnitude comes from: the value-matrix TEXTURE (the real
   * path) or a CPU-expanded per-instance ATTRIBUTE (hosts without vertex
   * texture fetch).
   */
  magnitude: 'texture' | 'attribute';
  /** Packed-matrix storage format; only meaningful on the texture path. */
  format: FlowMatrixFormat;
  /** Emit the flat id-colour pick pass instead of the visual one. */
  pick: boolean;
}

/** Baseline: window mode, no filter, direction gradient, GPU float32 matrix. */
const DEFAULT_SHADER_CONFIG: FlowmapShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
  colorMode: 'direction',
  bundle: true,
  magnitude: 'texture',
  format: 'float32',
  pick: false,
});

/** Kernel snippet compiled in per time mode (exactly one per program). */
const MODE_KERNEL: Readonly<Record<FlowmapTimeFilterMode, string>> =
  Object.freeze({
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  });

/**
 * The `timeAlpha = …` expression per mode. `trail` is the only per-VERTEX one:
 * its frontier time is the feature's `[start, end]` sampled at the arrow
 * parameter `t`, so the arrow draws itself origin→destination instead of
 * appearing whole — which is why it is emitted AFTER the geometry block while
 * the other three are emitted before it (wake feeds back into the width).
 */
const MODE_ALPHA: Readonly<Record<FlowmapTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    trail:
      'sttTrailAlpha(mix(aTime.x, aTime.y, t), uCurrentTime, uTrailLength, uFadeTrail)',
  });

// The kernel declaration snippets open with a blank line (they splice at
// end-of-line elsewhere); these call sites paste them at a line START.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');
const FLOW_UNIFORMS = FLOW_MATRIX_UNIFORMS_GLSL.replace(/^\n/, '');

/** Gradient endpoints — declared by `direction` AND `category` (its fallback). */
const GRADIENT_UNIFORMS = `  uniform vec4 uSourceColor;
  uniform vec4 uTargetColor;
`;

/** Magnitude-ramp surface. */
const RAMP_UNIFORMS = `  uniform vec4 uMagnitudeLowColor;
  uniform vec4 uMagnitudeHighColor;
  uniform vec2 uColorDomain;
  uniform float uColorGamma;
`;

/** Per-feature categorical colour surface. */
const CATEGORY_DECLS = `  attribute vec4 aColor;       // per-feature RGBA (when uUseFeatureColor=1)
  uniform float uUseFeatureColor;
`;

/** Colour declarations per compiled mode. */
const COLOR_DECLS: Readonly<Record<FlowmapColorMode, string>> = Object.freeze({
  direction: GRADIENT_UNIFORMS,
  magnitude: RAMP_UNIFORMS,
  category: `${CATEGORY_DECLS}${GRADIENT_UNIFORMS}`,
});

/**
 * The colour EXPRESSION per compiled mode. Both passes evaluate it — the visual
 * one paints with it, the id one reads only its ALPHA, so an arrow the user
 * cannot see (a gradient endpoint at alpha 0, a `colorMapping` entry at alpha 0)
 * is not a hit target. deck's `picking_filterPickingColor` discards the same
 * way. Without it the invisible end of a gradient would not just be pickable, it
 * would OVERWRITE the ids of visible features drawn earlier at those pixels (the
 * pick pass is unblended), turning their hits into misses.
 */
const COLOR_EXPR: Readonly<Record<FlowmapColorMode, string>> = Object.freeze({
  direction: 'mix(uSourceColor, uTargetColor, t)',
  magnitude:
    'mix(uMagnitudeLowColor, uMagnitudeHighColor, sttFlowRampT(magnitude, uColorDomain, uColorGamma))',
  category:
    '((uUseFeatureColor > 0.5) ? aColor : mix(uSourceColor, uTargetColor, t))',
});

/**
 * Assemble the flowmap vertex shader.
 *
 * An empty `prelude` yields the legacy `uMatrix` source (maplibre ≤v4 /
 * mapbox); a v5+ host's prelude + define are prepended (maplibre's documented
 * injection order) and every position projects through `projectTile(vec2)` —
 * the 2D entry point, which overwrites z for horizon clipping. That is correct
 * here: a flowmap arrow is a GROUND overlay, so there is no elevation and none
 * of the metres-vs-mercator-z trap the arc/column/polygon layers navigate.
 *
 * The pick pass shares this builder rather than forking the arrow math: a hit
 * shape that drifted from the drawn one is exactly the bug an id-buffer picker
 * cannot detect from the CPU side.
 */
export function buildFlowmapVertexSource(
  shader: ShaderInjection,
  cfg: FlowmapShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  const { mode, filter, colorMode, bundle, magnitude, format, pick } = cfg;
  const usesPrelude = shader.prelude.length > 0;
  const header = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const matrixUniform = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const project = (xy: string): string =>
    usesPrelude ? `projectTile(${xy})` : `uMatrix * vec4(${xy}, 0.0, 1.0)`;
  const usesTexture = magnitude === 'texture';

  const magnitudeAttribute = usesTexture
    ? `  attribute float ${FLOW_NAMES.row};    // value-matrix row for this OD pair\n`
    : '  attribute float aFlowMagnitude; // CPU-expanded magnitude (no vertex texture fetch)\n';
  const magnitudeExpr = usesTexture
    ? FLOW_MAGNITUDE_CALL_GLSL
    : 'aFlowMagnitude';
  const sampler = usesTexture ? buildFlowMatrixSampler({ format }) : '';

  const colorDecls = pick
    ? `${COLOR_DECLS[colorMode]}  attribute vec3 aIdColor;     // per-feature encoded id (UNSIGNED_BYTE normalized)
  varying vec3 vIdColor;
`
    : `${COLOR_DECLS[colorMode]}  varying vec4 vColor;
`;
  const colorAssign = pick
    ? `    vIdColor = aIdColor;
    vAlpha *= (${COLOR_EXPR[colorMode]}).a;
`
    : `    vColor = ${COLOR_EXPR[colorMode]};\n`;

  // Wake feeds BACK into the width (the tail narrows as it fades), so its alpha
  // must land before the geometry block. Trail's does not — it needs `t`.
  const trailMode = mode === 'trail';
  const preTime = trailMode
    ? ''
    : `    float timeAlpha = ${MODE_ALPHA[mode]};\n`;
  const postTime = trailMode
    ? `    float timeAlpha = ${MODE_ALPHA.trail};\n`
    : '';
  const wakeSize =
    mode === 'wake'
      ? '    widthPx *= sttWakeSizeScale(timeAlpha, uWakeTailScale);\n'
      : '';
  const filterAlphaDecl = filter
    ? `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};\n`
    : '';
  const filterSize = filter
    ? '    if (uFilterTransformSize > 0.5) widthPx *= filterAlpha;\n'
    : '';
  // deck's vs:#main-end collapse, keyed on per-FEATURE factors only — the time
  // alpha varies per vertex in trail mode and collapsing on it would strand the
  // revealed end at the origin.
  const alphaCommit = filter
    ? `    if (filterAlpha <= 0.0) gl_Position = vec4(0.0);
    float filterMask = (uFilterTransformColor > 0.5)
      ? filterAlpha
      : (filterAlpha > 0.0 ? 1.0 : 0.0);
    vAlpha = timeAlpha * filterMask * activeMask;
`
    : '    vAlpha = timeAlpha * activeMask;\n';

  const pathFn = bundle
    ? `  // Pre-baked bundle geometry: a quadratic Bézier through the archive's own
  // bundle apex. A plain 2-vertex OD feature gets control = chord midpoint, for
  // which this reduces ALGEBRAICALLY to mix(aSource, aTarget, t).
  vec2 sttFlowPathAt(float t) {
    float mt = 1.0 - t;
    return mt * mt * aSource + 2.0 * mt * t * aControl + t * t * aTarget;
  }
`
    : `  vec2 sttFlowPathAt(float t) {
    return mix(aSource, aTarget, t);
  }
`;
  // Direction drives the perpendicular the ribbon extrudes along AND the
  // arrowhead's aim. A straight arrow reuses the chord it already projected; a
  // bundled one finite-differences its own curve, looking BACKWARD at the tip
  // (and negating) so the head still points at the destination.
  const dirBlock = bundle
    ? `    float ahead = step(t, 1.0 - STT_TANGENT_DT);
    vec4 thereClip = ${project('sttFlowPathAt(mix(t - STT_TANGENT_DT, t + STT_TANGENT_DT, ahead))')};
    vec2 dirPx = (thereClip.xy / thereClip.w - hereClip.xy / hereClip.w)
      * 0.5 * uViewport * mix(-1.0, 1.0, ahead);
`
    : '    vec2 dirPx = chordPx;\n';

  return `${header}  precision highp float;
  attribute vec3 aVertex;      // (regionT, side ∈ {-1,+1}, region: 0 shaft / 1 head), per-vertex
  attribute vec2 aSource;      // mercator origin, per-instance
  attribute vec2 aTarget;      // mercator destination (antimeridian-unwrapped), per-instance
${bundle ? '  attribute vec2 aControl;     // baked-bundle quadratic control point, mercator\n' : ''}  attribute vec2 aTime;        // [startTime, endTime], per-instance, tile-relative
${magnitudeAttribute}${colorDecls}${filter ? FILTER_ATTRIBUTE : ''}${matrixUniform}  uniform vec2 uViewport;
  uniform float uMinFlow;
  uniform float uWidthScale;
  uniform float uWidthExponent;
  uniform vec2 uWidthClamp;
  uniform float uGap;
  uniform float uHalfArrow;
  uniform float uHeadLength;
  uniform float uHeadWidth;
  uniform float uHeadMaxFraction;
  uniform float uTailScale;
  uniform vec2 uEndpointInset;
${usesTexture ? FLOW_UNIFORMS : ''}${TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE[mode]}${filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${bundle ? '\n  const float STT_TANGENT_DT = 0.01;\n' : ''}${MODE_KERNEL[mode]}${filter ? DATA_FILTER_GLSL : ''}${sampler}${FLOW_WIDTH_GLSL}
${pathFn}
  void main() {
    float magnitude = ${magnitudeExpr};
    // Below minFlow this returns 0 — invisible, which IS the animation — and
    // the pixel clamp applies to ACTIVE arrows only, so uWidthClamp.x can never
    // resurrect a dead corridor.
    float widthPx = sttFlowWidth(
      magnitude, uMinFlow, uWidthScale, uWidthExponent, uWidthClamp);
${preTime}${wakeSize}${filterAlphaDecl}${filterSize}
    vec4 srcClip = ${project('aSource')};
    vec4 tgtClip = ${project('aTarget')};
    vec2 chordPx =
      (tgtClip.xy / tgtClip.w - srcClip.xy / srcClip.w) * 0.5 * uViewport;
    float lenPx = max(length(chordPx), 1.0);

    // The head is a fixed multiple of the CURRENT width, capped as a share of
    // the corridor's on-screen length so a short flow is not all head.
    float headFrac = clamp(uHeadLength * widthPx / lenPx, 0.0, uHeadMaxFraction);
    float shaftEnd = 1.0 - headFrac;
    float isHead = step(0.5, aVertex.z);
    float t = mix(aVertex.x * shaftEnd, shaftEnd + aVertex.x * headFrac, isHead);
    float profile = mix(
      mix(uTailScale, 1.0, aVertex.x),
      mix(uHeadWidth, 0.0, aVertex.x),
      isHead);

    vec2 posM = sttFlowPathAt(t);
    vec4 hereClip = ${project('posM')};
${dirBlock}    float dirLen = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / dirLen;
    vec2 perpN = vec2(-dirN.y, dirN.x);

    // 'half' keeps both vertices on ONE side of the centreline (flowmap.gl's
    // half arrow), so A→B and B→A read side by side under uGap; 'full' centres
    // a symmetric ribbon.
    float sideT = (uHalfArrow > 0.5)
      ? (aVertex.y * 0.5 + 0.5)
      : (aVertex.y * 0.5);
    float perpPx = (sideT * profile + uGap) * widthPx;
    float insetPx = mix(
      clamp(uEndpointInset.x, 0.0, 0.4 * lenPx),
      -clamp(uEndpointInset.y, 0.0, 0.4 * lenPx),
      t);
    vec2 offsetPx = perpN * perpPx + dirN * insetPx;
    vec4 outClip = hereClip;
    outClip.xy += (offsetPx / (0.5 * uViewport)) * hereClip.w;
    gl_Position = outClip;
${postTime}    // An arrow with no flow is invisible AND unpickable: the mask zeroes the
    // alpha both passes gate on, and the collapse keeps the degenerate
    // zero-width triangles out of the rasterizer entirely.
    float activeMask = (widthPx > 0.0) ? 1.0 : 0.0;
    if (activeMask <= 0.0) gl_Position = vec4(0.0);
${alphaCommit}${colorAssign}  }
`;
}

/**
 * Program-cache key for one compiled configuration. `getOrCreateProgram`
 * appends `::${variantName}` (the HOST variant) only, so two configurations
 * sharing a base key would collide on one program.
 */
export function flowmapProgramKey(cfg: FlowmapShaderConfig): string {
  const magnitude =
    cfg.magnitude === 'texture' ? flowSamplerCacheKey(cfg.format) : 'flow-attr';
  return `flowmap:${cfg.pick ? 'pick:' : ''}${cfg.mode}${
    cfg.filter ? ':filter' : ''
  }:${cfg.colorMode}${cfg.bundle ? ':bundle' : ''}:${magnitude}`;
}

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha);
  }
`;

// Id-pick fragment stage: the readback must recover the byte triple exactly, so
// the id colour is written flat and opaque with no blending or coverage term.
// The `vAlpha` discard is what makes time-filtered, range-filtered and
// below-minFlow arrows unpickable rather than invisible hit boxes.
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

interface FlowmapProgramHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  /** True when the source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aVertex: number;
  aSource: number;
  aTarget: number;
  /** -1 unless the baked-bundle path compiled the control point in. */
  aControl: number;
  aTime: number;
  /** -1 on the CPU-fallback path. */
  aFlowRow: number;
  /** -1 on the texture path. */
  aFlowMagnitude: number;
  /** -1 unless `colorMode: 'category'`. */
  aColor: number;
  /** -1 on the visual passes. */
  aIdColor: number;
  /** -1 unless the DataFilter branch was compiled in. */
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uMinFlow: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uWidthExponent: WebGLUniformLocation | null;
  uWidthClamp: WebGLUniformLocation | null;
  uGap: WebGLUniformLocation | null;
  uHalfArrow: WebGLUniformLocation | null;
  uHeadLength: WebGLUniformLocation | null;
  uHeadWidth: WebGLUniformLocation | null;
  uHeadMaxFraction: WebGLUniformLocation | null;
  uTailScale: WebGLUniformLocation | null;
  uEndpointInset: WebGLUniformLocation | null;
  // Colour: only the compiled mode's are non-null.
  uSourceColor: WebGLUniformLocation | null;
  uTargetColor: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uMagnitudeLowColor: WebGLUniformLocation | null;
  uMagnitudeHighColor: WebGLUniformLocation | null;
  uColorDomain: WebGLUniformLocation | null;
  uColorGamma: WebGLUniformLocation | null;
  // Flow matrix: null on the CPU-fallback path.
  uFlowMatrix: WebGLUniformLocation | null;
  uFlowMatrixSize: WebGLUniformLocation | null;
  uFlowMatrixDims: WebGLUniformLocation | null;
  uFlowValueScale: WebGLUniformLocation | null;
  uFlowBucket: WebGLUniformLocation | null;
}

interface FlowmapGpuCache extends TileGpuCache {
  /** Per-instance mercator origins, stride-2 Float32. */
  sourceBuffer: WebGLBuffer;
  /** Per-instance mercator destinations (antimeridian-unwrapped). */
  targetBuffer: WebGLBuffer;
  /** Per-instance baked-bundle control points; absent when `bundle` is off. */
  controlBuffer?: WebGLBuffer;
  /** Per-instance value-matrix row; absent on the CPU-fallback path. */
  rowBuffer?: WebGLBuffer;
  /** Per-instance expanded magnitude (CPU fallback only), DYNAMIC_DRAW. */
  magnitudeBuffer?: WebGLBuffer;
  /** Caller-owned scratch `expandFlowMagnitudes` re-fills in place. */
  magnitudeScratch?: Float32Array;
  /** Quantized bucket the scratch currently holds; NaN until first fill. */
  magnitudeStep: number;
  colorBuffer?: WebGLBuffer;
  /** Per-instance filter value; absent when the tile lacks the column. */
  filterBuffer?: WebGLBuffer;
  /** Third argument to `resolveDataFilterUniforms` for THIS tile. */
  hasFilterColumn: boolean;
  /** The packed value matrix backing this tile (texture payload + metadata). */
  packed: PackedValueMatrix;
  /** Value-matrix row per OD pair — also the CPU fallback's expansion index. */
  rows: Float32Array;
  /** GPU texture holding {@link packed}; absent on the CPU-fallback path. */
  matrixTexture?: WebGLTexture;
  /** This tile's timestep axis, or null when it carries only a static column. */
  axis: FlowBucketAxis | null;
  /** Observed magnitude range — the per-tile default `colorDomain`. */
  magnitudeMin: number;
  magnitudeMax: number;
  /** One instance per FEATURE — also the pick-id space size for this tile. */
  instanceCount: number;
  /** Widest per-axis mercator span of any OD pair (globe segment refinement). */
  maxSpan: number;
  /**
   * The two axes the cached VAO was recorded against: the HOST variant (whose
   * program owns the attribute slots) and the SHAFT segment count (which selects
   * the bound template buffer). Either moving invalidates the recording;
   * compared field-by-field because `drawTile` runs per resident tile per frame
   * and building a composite key there would allocate a string to prove nothing
   * changed.
   */
  vaoVariant?: string;
  vaoSegments?: number;
  /**
   * Frame stamp of the last `drawTile`. The base class frees BUFFERS when a tile
   * is evicted but knows nothing about textures, so this layer reaps its own by
   * marking every cache it draws and dropping the unmarked ones — see
   * {@link STTFlowmapLayer.reapEvictedTextures}.
   */
  frameStamp: number;
}

/**
 * Hand-built test DrawContexts may omit `frame`; treat them as a legacy uMatrix
 * host. Read-only — never handed to normalizeRenderArgs.
 */
const FALLBACK_LEGACY_FRAME: HostFrame = createHostFrame();

/**
 * MapLibre custom layer rendering STT OD-flow tiles as animated flowmap arrows.
 *
 * ```ts
 * const flows = new STTFlowmapLayer({
 *   id: 'bixi-flows',
 *   url: '/data/bixi-od.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 3_600_000,
 *   widthScale: 1.4,
 *   colorMode: 'magnitude',
 * });
 * flows.attach(map);
 * ```
 */
export class STTFlowmapLayer extends STTFilterableLayer {
  private flowOpts: {
    minFlow: number;
    widthScale: number;
    widthExponent: number;
    widthMinPixels: number;
    widthMaxPixels: number;
    widthUnits: 'pixels' | 'meters';
    absoluteMagnitude: boolean;
    magnitudeRange?: readonly [number, number];
    arrowShape: FlowmapArrowShape;
    gap: number;
    headLength: number;
    headWidth: number;
    headMaxFraction: number;
    tailWidthScale: number;
    shaftSegments: number;
    headSegments: number;
    sourceInsetPixels: number;
    targetInsetPixels: number;
    sourceColor: RGBA8;
    targetColor: RGBA8;
    magnitudeColorRange: readonly [RGBA8, RGBA8];
    colorDomain?: readonly [number, number];
    colorGamma: number;
    colorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };
  /** Allocated once; `resolveFlowMatrixUniforms` refills it per draw. */
  private readonly flowUniforms: FlowMatrixUniforms =
    createFlowMatrixUniforms();
  /** Allocated once — `[widthMinPixels, widthMaxPixels]`. */
  private readonly widthClamp = new Float32Array(2);
  /** Allocated once — `[sourceInsetPixels, targetInsetPixels]`. */
  private readonly endpointInset = new Float32Array(2);
  /** Allocated once — the resolved `[lo, hi]` magnitude colour domain. */
  private readonly colorDomain = new Float32Array(2);
  /** Compiled configuration; drives both program-cache keys. */
  private shaderConfig: FlowmapShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /**
   * Tail lengths AS PASSED (undefined ⇒ derived from `timeWindow`) and the mode
   * as REQUESTED — `shaderConfig.mode` holds the DEGRADED one.
   */
  private readonly wakeLengthOpt?: number;
  private readonly trailLengthOpt?: number;
  private requestedMode: FlowmapTimeFilterMode;
  /**
   * Shared arrow template buffers, keyed by SHAFT segment count (the head count
   * is fixed per layer). Two entries at most in practice — the configured count
   * and the globe-refined one — rebuilt lazily and released with the context.
   */
  private readonly templateBuffers = new Map<number, WebGLBuffer>();
  /** Memoized handles per pass, refreshed only on a variant / config flip. */
  private handles?: FlowmapProgramHandles;
  private handlesVariant?: string;
  private idHandles?: FlowmapProgramHandles;
  private idHandlesVariant?: string;
  /** Every live tile cache, so this layer can free the textures the base cannot. */
  private readonly liveCaches = new Set<FlowmapGpuCache>();
  private frameStamp = 0;
  private drewThisFrame = false;

  constructor(opts: STTFlowmapLayerOptions) {
    super(opts);
    this.wakeLengthOpt = opts.wakeLength;
    this.trailLengthOpt = opts.trailLength;
    this.requestedMode = opts.timeFilterMode ?? 'window';
    const halfWindow = Math.max(0, opts.timeWindow / 2);
    const arrowShape = opts.arrowShape ?? 'half';
    this.flowOpts = {
      minFlow: opts.minFlow ?? 0.25,
      widthScale: opts.widthScale ?? 1.1,
      widthExponent: opts.widthExponent ?? 0.5,
      widthMinPixels: opts.widthMinPixels ?? 1,
      widthMaxPixels: opts.widthMaxPixels ?? 12,
      widthUnits: opts.widthUnits ?? 'pixels',
      absoluteMagnitude: opts.absoluteMagnitude === true,
      magnitudeRange: opts.magnitudeRange,
      arrowShape,
      // A centred ribbon wants no side offset; a half arrow wants deck's 0.5.
      gap: opts.gap ?? (arrowShape === 'half' ? 0.5 : 0),
      headLength: opts.headLength ?? 3,
      headWidth: opts.headWidth ?? 2,
      headMaxFraction: opts.headMaxFraction ?? 0.4,
      tailWidthScale: opts.tailWidthScale ?? 1,
      shaftSegments: clampSegments(opts.numSegments ?? DEFAULT_SHAFT_SEGMENTS),
      headSegments: clampHeadSegments(
        opts.headSegments ?? DEFAULT_HEAD_SEGMENTS,
      ),
      sourceInsetPixels: opts.sourceInsetPixels ?? 0,
      targetInsetPixels: opts.targetInsetPixels ?? 0,
      sourceColor: opts.sourceColor ?? DEFAULT_SOURCE_COLOR,
      targetColor: opts.targetColor ?? DEFAULT_TARGET_COLOR,
      magnitudeColorRange: opts.magnitudeColorRange ?? [
        DEFAULT_SOURCE_COLOR,
        DEFAULT_TARGET_COLOR,
      ],
      colorDomain: opts.colorDomain,
      colorGamma: opts.colorGamma ?? 0,
      colorProperty: opts.colorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_FLOW_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      wakeLength: opts.wakeLength ?? halfWindow,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? halfWindow,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.shaderConfig = {
      // Placeholder — `resolveTimeConfig()` below owns the compiled mode.
      mode: 'window',
      // Compiled from the PROPERTY NAME alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
      colorMode:
        opts.colorMode ?? (opts.colorProperty ? 'category' : 'direction'),
      bundle: opts.bundleGeometry !== false,
      // Both resolved against the live context in `onContextReady`.
      magnitude: 'texture',
      format: 'float32',
      pick: false,
    };
    this.mainKey = '';
    this.pickKey = '';
    this.resolveTimeConfig();
    this.rebuildProgramKeys();
  }

  /**
   * Re-derive the defaulted tail lengths from the CURRENT `timeWindow` and the
   * compiled mode from those lengths. Returns true when the compiled mode moved.
   */
  private resolveTimeConfig(): boolean {
    const half = Math.max(0, this.opts.timeWindow / 2);
    const wake = this.wakeLengthOpt ?? half;
    const trail = this.trailLengthOpt ?? half;
    this.flowOpts.wakeLength = wake;
    this.flowOpts.trailLength = trail;
    const resolved = resolveFlowmapTimeFilterMode(
      this.requestedMode,
      wake,
      trail,
    );
    const changed = this.shaderConfig.mode !== resolved;
    this.shaderConfig.mode = resolved;
    return changed;
  }

  /** Rebuild both program-cache keys after the compiled config moved. */
  private rebuildProgramKeys(): void {
    this.mainKey = flowmapProgramKey(this.shaderConfig);
    this.pickKey = flowmapProgramKey({ ...this.shaderConfig, pick: true });
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /**
   * Widen/narrow the loading window. Overridden because the defaulted
   * `wakeLength`/`trailLength` are DERIVED from it.
   */
  setTimeWindow(ms: number): void {
    super.setTimeWindow(ms);
    if (!this.resolveTimeConfig()) return;
    this.rebuildProgramKeys();
    this.map?.triggerRepaint();
  }

  /**
   * Switch the temporal filter. The mode is compiled in, so this relinks one
   * program per host variant on the next frame — no tile rebuild.
   */
  setTimeFilterMode(mode: FlowmapTimeFilterMode): void {
    if (this.requestedMode === mode) return;
    this.requestedMode = mode;
    if (!this.resolveTimeConfig()) {
      this.map?.triggerRepaint();
      return;
    }
    this.rebuildProgramKeys();
    this.map?.triggerRepaint();
  }

  /**
   * Flow at or below which an arrow vanishes. Uniform-only — no relink, no tile
   * rebuild — so it is safe to drive from a slider every frame.
   */
  setMinFlow(minFlow: number): void {
    this.flowOpts.minFlow = minFlow;
    this.map?.triggerRepaint();
  }

  /** Pixels of width per unit of `magnitude ^ widthExponent`. Uniform-only. */
  setWidthScale(widthScale: number): void {
    this.flowOpts.widthScale = widthScale;
    this.map?.triggerRepaint();
  }

  /** Magnitude range mapped onto the colour ramp. Uniform-only. */
  setColorDomain(domain: readonly [number, number] | null): void {
    this.flowOpts.colorDomain = domain ?? undefined;
    this.map?.triggerRepaint();
  }

  /**
   * Tessellation density of the shaft. Costs vertices only: the template for
   * the new count is built once and cached, and no tile cache is touched.
   */
  setNumSegments(segments: number): void {
    this.flowOpts.shaftSegments = clampSegments(segments);
    this.map?.triggerRepaint();
  }

  /** STT stores OD flows as LineString features (first vertex → last vertex). */
  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.LineString;
  }

  /**
   * Resolve the two CONTEXT-dependent shader axes once per context: whether the
   * VERTEX stage can sample a texture at all (WebGL1's minimum for
   * `MAX_VERTEX_TEXTURE_IMAGE_UNITS` is ZERO) and, if so, which matrix format
   * this host can sample. Both are compiled in, so a flip relinks — and both are
   * re-probed after a context restore, where extension objects do not survive.
   */
  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const probe = {
      MAX_VERTEX_TEXTURE_IMAGE_UNITS:
        (gl as unknown as { MAX_VERTEX_TEXTURE_IMAGE_UNITS?: number })
          .MAX_VERTEX_TEXTURE_IMAGE_UNITS ?? GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS,
      getParameter: (pname: number): unknown => gl.getParameter(pname),
    };
    const magnitude: 'texture' | 'attribute' = supportsVertexTextureFetch(probe)
      ? 'texture'
      : 'attribute';
    if (magnitude === 'attribute') {
      console.warn(
        `[${this.id}] host reports no vertex texture fetch; STTFlowmapLayer ` +
          `falls back to CPU magnitude expansion (updated per ` +
          `${CPU_FALLBACK_SUB_STEP} timestep sub-step, not per frame).`,
      );
    }
    const format = chooseFlowMatrixFormat({
      webgl2: isWebGL2(gl),
      floatTextures: Boolean(gl.getExtension('OES_texture_float')),
    });
    if (
      magnitude === this.shaderConfig.magnitude &&
      format === this.shaderConfig.format
    ) {
      return;
    }
    this.shaderConfig.magnitude = magnitude;
    this.shaderConfig.format = format;
    this.rebuildProgramKeys();
    // A format/path flip changes the PACKING, not just the shader — the tiles
    // that were packed for the old one must be rebuilt. `rebuildTileCaches`
    // frees the base-owned buffers but knows nothing about our textures, so
    // free those (and drop the live-cache set) first. In practice this is only
    // reachable at the initial `onAdd` (caches empty) or after a context
    // restore (`onContextLost` already cleared both), so the loop is a no-op —
    // it is here so the invariant holds if a future path calls it live.
    for (const cache of this.liveCaches) {
      if (cache.matrixTexture) gl.deleteTexture(cache.matrixTexture);
      cache.matrixTexture = undefined;
    }
    this.liveCaches.clear();
    this.rebuildTileCaches();
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Per-variant programs live in the base program cache, which the base layer
    // invalidates for us. The template buffers and the per-tile matrix TEXTURES
    // are this layer's own: delete them when the context is alive (dispose) and
    // drop the references either way (deletes on a lost context are ignored).
    for (const buf of this.templateBuffers.values()) gl.deleteBuffer(buf);
    this.templateBuffers.clear();
    for (const cache of this.liveCaches) {
      if (cache.matrixTexture) gl.deleteTexture(cache.matrixTexture);
      cache.matrixTexture = undefined;
    }
    this.liveCaches.clear();
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /**
   * Frame driver. The base walk is unchanged; the wrapper exists only to reap
   * the matrix textures of tiles the base evicted — `deleteCacheBuffers` frees
   * BUFFERS, and a `TileGpuCache` has no texture slot for it to find.
   *
   * Every resident, accepted tile is drawn exactly once per pass, so a cache
   * whose stamp did not advance is a cache the base dropped. The reap is skipped
   * when nothing was drawn at all (`beginFrame` bailed, or the tile set is
   * momentarily empty) — otherwise an idle frame would free textures that are
   * about to be used again.
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ): void {
    this.frameStamp++;
    this.drewThisFrame = false;
    super.render(gl, matrixOrArgs, options);
    if (this.drewThisFrame) this.reapEvictedTextures(gl);
  }

  /** Delete the matrix textures of caches that were not drawn this frame. */
  private reapEvictedTextures(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    for (const cache of this.liveCaches) {
      if (cache.frameStamp === this.frameStamp) continue;
      if (cache.matrixTexture) gl.deleteTexture(cache.matrixTexture);
      cache.matrixTexture = undefined;
      this.liveCaches.delete(cache);
    }
  }

  /**
   * The shared `(regionT, side, region)` arrow template for `shaftSegments`
   * shaft segments, uploaded once per distinct count. Per-vertex (divisor 0) —
   * every instance reuses it.
   */
  private getTemplateBuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shaftSegments: number,
  ): WebGLBuffer {
    const existing = this.templateBuffers.get(shaftSegments);
    if (existing) return existing;
    const buf = this.uploadArrayBuffer(
      gl,
      buildFlowArrowTemplate(shaftSegments, this.flowOpts.headSegments),
    );
    this.templateBuffers.set(shaftSegments, buf);
    return buf;
  }

  /**
   * Shaft segments to draw this tile with. Off globe it is the configured count.
   * On globe the arrow's own tessellation IS the subdivision that keeps chords
   * from being horizon-clipped, so the count is raised (never lowered) until
   * each piece is shorter than the host's granularity — a different shared
   * template buffer, never a tile rebuild.
   */
  private segmentsFor(
    frame: HostFrame,
    tile: Tile,
    cache: FlowmapGpuCache,
  ): number {
    const base = this.flowOpts.shaftSegments;
    if (!frame.isGlobe) return base;
    const granularity = this.tileSubdivisionGranularity(tile.id.z);
    const needed = Math.ceil(cache.maxSpan * granularity);
    if (!Number.isFinite(needed) || needed <= base) return base;
    // Round UP to a power of two. Over-tessellating is always safe, and it caps
    // the shared template cache at ~9 entries however many distinct tile spans
    // are resident — otherwise every tile with its own `maxSpan` would mint (and
    // hold, until context loss) its own template buffer.
    return Math.min(MAX_FLOWMAP_SEGMENTS, 2 ** Math.ceil(Math.log2(needed)));
  }

  /**
   * Build the per-tile cache: two endpoints, an optional bundle control point,
   * the matrix row and the style columns per OD pair, plus the packed value
   * matrix (a texture, or the CPU fallback's scratch). The arrow itself is never
   * uploaded — the template is shared and `numSegments` is a per-draw choice.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): FlowmapGpuCache | null {
    if (!this.instSupport.enabled) {
      // No instancing → no arrows. Logged so hosts can detect and swap runtime.
      console.warn(
        `[${this.id}] runtime lacks ANGLE_instanced_arrays / WebGL2; ` +
          `STTFlowmapLayer requires instancing.`,
      );
      return null;
    }
    const f = layer.features;
    const pairs = extractFlowOdPairs(f);
    if (!pairs || pairs.count === 0) return null;
    const count = pairs.count;

    // Endpoints: drop the stride-3 mercator triples to the stride-2 the shader
    // binds, and take the SHORT way round the antimeridian.
    const srcM = new Float32Array(count * 2);
    const tgtM = new Float32Array(count * 2);
    let maxSpan = 0;
    for (let i = 0; i < count; i++) {
      const sx = pairs.source[i * 3];
      const sy = pairs.source[i * 3 + 1];
      const tx = unwrapFlowMercatorX(sx, pairs.target[i * 3]);
      const ty = pairs.target[i * 3 + 1];
      srcM[i * 2] = sx;
      srcM[i * 2 + 1] = sy;
      tgtM[i * 2] = tx;
      tgtM[i * 2 + 1] = ty;
      const span = Math.max(Math.abs(tx - sx), Math.abs(ty - sy));
      if (span > maxSpan) maxSpan = span;
    }

    const control = this.shaderConfig.bundle
      ? this.buildBundleControls(f, srcM, tgtM, count)
      : null;

    // Magnitude source: the per-timestep matrix when the tile bakes one, else
    // the STATIC `vertexValues` channel packed as a ONE-column matrix so the
    // clamped sampler reads it at every playhead position (deck's fall-through,
    // expressed as data rather than as a second shader).
    const packOpts = {
      format: this.shaderConfig.format,
      absolute: this.flowOpts.absoluteMagnitude,
      valueRange: this.flowOpts.magnitudeRange,
      maxTextureSize: maxTextureSizeOf(gl),
    };
    // Global-vertex count — the row axis of the vertex-major matrix, so it must
    // divide by the position STRIDE, not assume 2D.
    const posDims = f.positionDimensions === 3 ? 3 : 2;
    const vertexCount = f.positions ? f.positions.length / posDims : 0;
    const matrixPacked = packVertexValueMatrix(f, vertexCount, packOpts);
    let packed: PackedValueMatrix | null = matrixPacked;
    let rows = pairs.rows;
    let magnitudeMin = 0;
    let magnitudeMax = 0;
    if (packed && f.vertexValueMatrix) {
      const total = vertexCount * (f.vertexValueBuckets ?? 0);
      [magnitudeMin, magnitudeMax] = flowMagnitudeRange(
        f.vertexValueMatrix,
        total,
        this.flowOpts.absoluteMagnitude,
      );
    } else {
      // One row per OD PAIR now, so the shader's row attribute is the pair index
      // rather than the pair's global source-vertex index.
      const statics = new Float32Array(count);
      const vertexValues = f.vertexValues;
      for (let i = 0; i < count; i++) {
        const v = vertexValues ? vertexValues[pairs.rows[i]] : 1;
        statics[i] = Number.isFinite(v) ? v : 0;
      }
      [magnitudeMin, magnitudeMax] = flowMagnitudeRange(
        statics,
        count,
        this.flowOpts.absoluteMagnitude,
      );
      packed = packValueMatrix(statics, count, 1, packOpts);
      rows = new Float32Array(count);
      for (let i = 0; i < count; i++) rows[i] = i;
    }
    // A refusal here is a degenerate tile (see packValueMatrix's null cases),
    // not an error: nothing can be animated, so nothing is drawn.
    if (!packed) return null;

    const featureColors =
      this.shaderConfig.colorMode === 'category' && this.flowOpts.colorProperty
        ? this.expandCategoricalColors(
            f,
            this.flowOpts.colorProperty,
            this.flowOpts.colorPalette,
            this.flowOpts.colorMapping,
            this.flowOpts.colorMappingDefault,
          )
        : null;

    // Range filter: one instance IS one feature, so the per-FEATURE column binds
    // directly (no expandFilterValues). A missing / categorical column resolves
    // to `hasFilterColumn: false`, which the uniform resolver turns into
    // `enabled: 0` — an UNFILTERED tile, never a blank one.
    let filterValues: Float32Array | null = null;
    let hasFilterColumn = false;
    if (this.shaderConfig.filter) {
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical) this.warnCategoricalFilterOnce();
      filterValues = col.values;
      hasFilterColumn = col.hasColumn;
    }

    const sourceBuffer = this.uploadArrayBuffer(gl, srcM);
    const targetBuffer = this.uploadArrayBuffer(gl, tgtM);
    const timeBuffer = this.uploadFeatureTimes(gl, f.startTimes, f.endTimes);
    const extras: WebGLBuffer[] = [targetBuffer];
    let controlBuffer: WebGLBuffer | undefined;
    let rowBuffer: WebGLBuffer | undefined;
    let magnitudeBuffer: WebGLBuffer | undefined;
    let magnitudeScratch: Float32Array | undefined;
    let colorBuffer: WebGLBuffer | undefined;
    let filterBuffer: WebGLBuffer | undefined;
    if (control) {
      controlBuffer = this.uploadArrayBuffer(gl, control);
      extras.push(controlBuffer);
    }
    if (this.shaderConfig.magnitude === 'texture') {
      rowBuffer = this.uploadArrayBuffer(gl, rows);
      extras.push(rowBuffer);
    } else {
      magnitudeScratch = new Float32Array(count);
      magnitudeBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, magnitudeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, magnitudeScratch, gl.DYNAMIC_DRAW);
      extras.push(magnitudeBuffer);
    }
    if (featureColors) {
      colorBuffer = this.uploadArrayBuffer(gl, featureColors);
      extras.push(colorBuffer);
    }
    if (filterValues) {
      filterBuffer = this.uploadArrayBuffer(gl, filterValues);
      extras.push(filterBuffer);
    }

    const cache: FlowmapGpuCache = {
      // The base cleanup walk deletes `positionBuffer`/`timeBuffer`/`extraBuffers`,
      // so the origins ride in the "primary" slot.
      positionBuffer: sourceBuffer,
      sourceBuffer,
      targetBuffer,
      controlBuffer,
      rowBuffer,
      magnitudeBuffer,
      magnitudeScratch,
      magnitudeStep: Number.NaN,
      timeBuffer,
      colorBuffer,
      filterBuffer,
      hasFilterColumn,
      packed,
      rows,
      matrixTexture:
        this.shaderConfig.magnitude === 'texture'
          ? (this.uploadMatrixTexture(gl, packed) ?? undefined)
          : undefined,
      axis: deriveFlowAxis(f),
      magnitudeMin,
      magnitudeMax,
      // One instance per feature; the template's own vertex count is a per-draw
      // choice, so it is deliberately NOT baked here.
      vertexCount: count,
      indexCount: 0,
      instanceCount: count,
      maxSpan,
      timeOffset: f.timeOffset,
      extraBuffers: extras,
      frameStamp: this.frameStamp,
    };
    this.liveCaches.add(cache);
    return cache;
  }

  /**
   * Per-instance bundle control points from the tile's own baked geometry. Each
   * feature's INTERIOR vertices (everything between its endpoints) are projected
   * to mercator and handed to {@link bundleControlPoint}; a 2-vertex feature
   * yields the chord midpoint, i.e. a straight arrow.
   */
  private buildBundleControls(
    f: STTLayer['features'],
    srcM: Float32Array,
    tgtM: Float32Array,
    count: number,
  ): Float32Array {
    const out = new Float32Array(count * 2);
    const positions = f.positions;
    const startIndices = f.startIndices;
    const dims = f.positionDimensions === 3 ? 3 : 2;
    // Scratch reused across features — bundles are short, and this runs once
    // per tile, but a per-feature allocation here would be thousands of arrays.
    let interior = new Float64Array(32);
    for (let i = 0; i < count; i++) {
      const sx = srcM[i * 2];
      const sy = srcM[i * 2 + 1];
      const tx = tgtM[i * 2];
      const ty = tgtM[i * 2 + 1];
      let interiorCount = 0;
      if (positions && startIndices) {
        const begin = startIndices[i] + 1;
        const end = startIndices[i + 1] - 1;
        interiorCount = Math.max(0, end - begin);
        if (interiorCount * 2 > interior.length) {
          interior = new Float64Array(interiorCount * 2);
        }
        for (let v = 0; v < interiorCount; v++) {
          const base = (begin + v) * dims;
          lngLatToMercatorInto(
            positions[base],
            positions[base + 1],
            interior,
            v * 2,
          );
          // Keep the bundle on the same side of the antimeridian as its origin.
          interior[v * 2] = unwrapFlowMercatorX(sx, interior[v * 2]);
        }
      }
      const [cx, cy] = bundleControlPoint(
        sx,
        sy,
        tx,
        ty,
        interiorCount > 0 ? interior.subarray(0, interiorCount * 2) : undefined,
      );
      out[i * 2] = cx;
      out[i * 2 + 1] = cy;
    }
    return out;
  }

  /**
   * Upload one tile's packed value matrix. NEAREST + CLAMP_TO_EDGE (a float
   * texture is not linearly filterable without `OES_texture_float_linear`, and
   * the interpolation between timesteps happens in the shader anyway), with the
   * unpack flags the payload assumes — and the HOST's values put back, because
   * maplibre mirrors both in cached `BaseValue`s and would silently inherit ours
   * on its next glyph/sprite upload (the same hazard `STTIconLayer` documents).
   */
  private uploadMatrixTexture(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    packed: PackedValueMatrix,
  ): WebGLTexture | null {
    const recipe =
      FLOW_MATRIX_TEXTURE_RECIPE[packed.format][
        isWebGL2(gl) ? 'webgl2' : 'webgl1'
      ];
    const enums = gl as unknown as Record<string, number>;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Feature-detected: the package's test recorder implements only the GL
    // surface the layers need, and unpack state is a no-op there.
    const canSetUnpack =
      typeof (gl as { pixelStorei?: unknown }).pixelStorei === 'function';
    const premultiplied =
      canSetUnpack && Boolean(gl.getParameter(UNPACK_PREMULTIPLY_ALPHA_WEBGL));
    const flipped =
      canSetUnpack && Boolean(gl.getParameter(UNPACK_FLIP_Y_WEBGL));
    if (premultiplied) gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (flipped) gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, false);
    try {
      // The recipe's unpackAlignment is 4 for every format here, which is GL's
      // own default — nothing to set, and nothing to restore.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        enums[recipe.internalFormat],
        packed.texWidth,
        packed.texHeight,
        0,
        enums[recipe.format],
        enums[recipe.type],
        packed.data as unknown as ArrayBufferView,
      );
    } catch (err) {
      console.warn(
        `[${this.id}] value-matrix texture upload failed (${String(err)}); ` +
          `this tile will not animate.`,
      );
      gl.deleteTexture(texture);
      return null;
    } finally {
      if (premultiplied) gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (flipped) gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, true);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /**
   * Fetch (or link) the program for this frame's host variant, the active
   * compiled configuration and this pass. The base cache appends the host
   * variant name, so the mode / filter / colour / bundle / magnitude axes must
   * all be in OUR key or two different programs would collide on one entry.
   */
  private programFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    pick: boolean,
  ): FlowmapProgramHandles {
    const variant = frame.shader.variantName;
    const memo = pick ? this.idHandles : this.handles;
    const memoVariant = pick ? this.idHandlesVariant : this.handlesVariant;
    if (memo && memoVariant === variant) return memo;
    const cfg = this.shaderConfig;
    const handles = this.getOrCreateProgram(
      gl,
      pick ? this.pickKey : this.mainKey,
      frame,
      (glc, shader) => {
        const program = this.linkProgram(
          glc,
          buildFlowmapVertexSource(shader, { ...cfg, pick }),
          pick ? ID_FS_SOURCE : FS_SOURCE,
        );
        const attrib = (name: string, on: boolean): number =>
          on ? glc.getAttribLocation(program, name) : -1;
        return {
          program,
          usesPrelude: shader.prelude.length > 0,
          aVertex: glc.getAttribLocation(program, 'aVertex'),
          aSource: glc.getAttribLocation(program, 'aSource'),
          aTarget: glc.getAttribLocation(program, 'aTarget'),
          aControl: attrib('aControl', cfg.bundle),
          aTime: glc.getAttribLocation(program, 'aTime'),
          aFlowRow: attrib(FLOW_NAMES.row, cfg.magnitude === 'texture'),
          aFlowMagnitude: attrib(
            'aFlowMagnitude',
            cfg.magnitude === 'attribute',
          ),
          aColor: attrib('aColor', cfg.colorMode === 'category'),
          aIdColor: attrib('aIdColor', pick),
          aFilterValue: attrib(DATA_FILTER_NAMES.attribute, cfg.filter),
          uMatrix: glc.getUniformLocation(program, 'uMatrix'),
          uViewport: glc.getUniformLocation(program, 'uViewport'),
          uMinFlow: glc.getUniformLocation(program, 'uMinFlow'),
          uWidthScale: glc.getUniformLocation(program, 'uWidthScale'),
          uWidthExponent: glc.getUniformLocation(program, 'uWidthExponent'),
          uWidthClamp: glc.getUniformLocation(program, 'uWidthClamp'),
          uGap: glc.getUniformLocation(program, 'uGap'),
          uHalfArrow: glc.getUniformLocation(program, 'uHalfArrow'),
          uHeadLength: glc.getUniformLocation(program, 'uHeadLength'),
          uHeadWidth: glc.getUniformLocation(program, 'uHeadWidth'),
          uHeadMaxFraction: glc.getUniformLocation(program, 'uHeadMaxFraction'),
          uTailScale: glc.getUniformLocation(program, 'uTailScale'),
          uEndpointInset: glc.getUniformLocation(program, 'uEndpointInset'),
          uSourceColor: glc.getUniformLocation(program, 'uSourceColor'),
          uTargetColor: glc.getUniformLocation(program, 'uTargetColor'),
          uUseFeatureColor: glc.getUniformLocation(program, 'uUseFeatureColor'),
          uMagnitudeLowColor: glc.getUniformLocation(
            program,
            'uMagnitudeLowColor',
          ),
          uMagnitudeHighColor: glc.getUniformLocation(
            program,
            'uMagnitudeHighColor',
          ),
          uColorDomain: glc.getUniformLocation(program, 'uColorDomain'),
          uColorGamma: glc.getUniformLocation(program, 'uColorGamma'),
          uFlowMatrix: glc.getUniformLocation(program, FLOW_NAMES.matrix),
          uFlowMatrixSize: glc.getUniformLocation(program, FLOW_NAMES.texSize),
          uFlowMatrixDims: glc.getUniformLocation(program, FLOW_NAMES.dims),
          uFlowValueScale: glc.getUniformLocation(
            program,
            FLOW_NAMES.valueScale,
          ),
          uFlowBucket: glc.getUniformLocation(program, FLOW_NAMES.bucket),
          ...resolveTimeUniformLocations(glc, program),
          ...resolveWakeTailScaleUniformLocation(glc, program),
          ...resolveDataFilterUniformLocations(glc, program),
          ...resolveFilterTransformSizeUniformLocation(glc, program),
        };
      },
    );
    if (pick) {
      this.idHandles = handles;
      this.idHandlesVariant = variant;
    } else {
      this.handles = handles;
      this.handlesVariant = variant;
    }
    return handles;
  }

  /**
   * The `uWidthScale` value for one tile. In `'pixels'` it is the raw option; in
   * `'meters'` it additionally carries metres→device-px at the TILE's centre
   * latitude and the map's FRACTIONAL zoom (`ctx.zoom` is floored, which would
   * make metric widths jump a factor of 2 per zoom level).
   */
  private widthScaleFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { widthScale, widthUnits } = this.flowOpts;
    if (widthUnits !== 'meters') return widthScale;
    return widthScale * this.metricPixelScale(gl, tile, ctx);
  }

  /** Upload the active mode's time uniforms (only those exist in the program). */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowmapProgramHandles,
    cache: FlowmapGpuCache,
    ctx: DrawContext,
  ): void {
    // Tile-relative, the convention every time kernel here compares in.
    const relTime = ctx.currentTime - cache.timeOffset;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uWakeLength, this.flowOpts.wakeLength);
        gl.uniform1f(h.uWakeTailScale, this.flowOpts.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uTrailLength, this.flowOpts.trailLength);
        gl.uniform1f(h.uFadeTrail, this.flowOpts.fadeTrail);
        break;
      default: {
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  /**
   * The magnitude surface for one tile+frame. THE per-frame work of this layer:
   * on the texture path it is one `uniform1f` plus three tile-constant array
   * uniforms that travel with the bound texture (a `unorm16` decode from tile A
   * applied to tile B's texture is a silent value error, so they are resolved
   * together immediately before the draw). On the CPU-fallback path it also
   * re-expands and re-uploads the per-instance magnitudes, but only when the
   * playhead crossed a sub-step.
   */
  private setMagnitudeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowmapProgramHandles,
    cache: FlowmapGpuCache,
    ctx: DrawContext,
  ): void {
    const bucketPos = cache.axis
      ? bucketPositionAt(cache.axis, ctx.currentTime)
      : 0;
    if (this.shaderConfig.magnitude === 'texture') {
      const u = resolveFlowMatrixUniforms(
        this.flowUniforms,
        cache.packed,
        bucketPos,
      );
      gl.uniform4fv(h.uFlowMatrixSize, u.texSize);
      gl.uniform2fv(h.uFlowMatrixDims, u.dims);
      gl.uniform2fv(h.uFlowValueScale, u.valueScale);
      gl.uniform1f(h.uFlowBucket, u.bucket);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cache.matrixTexture ?? null);
      gl.uniform1i(h.uFlowMatrix, 0);
      return;
    }
    // CPU fallback: gate on the sub-step so a scrub does not re-upload per
    // frame. `magnitudeScratch` is caller-owned and reused, so the gated update
    // still allocates nothing.
    const stepped = quantizeBucketPosition(bucketPos, CPU_FALLBACK_SUB_STEP);
    if (stepped === cache.magnitudeStep) return;
    if (!cache.magnitudeScratch || !cache.magnitudeBuffer) return;
    expandFlowMagnitudes(
      cache.magnitudeScratch,
      cache.packed,
      cache.rows,
      stepped,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.magnitudeBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, cache.magnitudeScratch);
    cache.magnitudeStep = stepped;
  }

  /** Colour uniforms for the compiled mode. */
  private setColorUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowmapProgramHandles,
    cache: FlowmapGpuCache,
  ): void {
    const o = this.flowOpts;
    if (this.shaderConfig.colorMode === 'magnitude') {
      gl.uniform4fv(
        h.uMagnitudeLowColor,
        this.rgba01Uniform('MagnitudeLowColor', o.magnitudeColorRange[0]),
      );
      gl.uniform4fv(
        h.uMagnitudeHighColor,
        this.rgba01Uniform('MagnitudeHighColor', o.magnitudeColorRange[1]),
      );
      // A tile-local default domain is self-tuning but not comparable across
      // tiles — documented on the prop, and the reason `colorDomain` exists.
      const domain = o.colorDomain;
      this.colorDomain[0] = domain ? domain[0] : cache.magnitudeMin;
      this.colorDomain[1] = domain ? domain[1] : cache.magnitudeMax;
      gl.uniform2fv(h.uColorDomain, this.colorDomain);
      gl.uniform1f(h.uColorGamma, o.colorGamma);
      return;
    }
    gl.uniform4fv(
      h.uSourceColor,
      this.rgba01Uniform('SourceColor', o.sourceColor),
    );
    gl.uniform4fv(
      h.uTargetColor,
      this.rgba01Uniform('TargetColor', o.targetColor),
    );
    if (this.shaderConfig.colorMode === 'category') {
      gl.uniform1f(
        h.uUseFeatureColor,
        cache.colorBuffer && h.aColor >= 0 ? 1 : 0,
      );
    }
  }

  /**
   * Projection + shape + sizing + magnitude + time + filter + colour uniforms —
   * everything the visual and id passes set IDENTICALLY, so the pickable arrow
   * always matches the drawn one (including on globe, where the prelude owns
   * projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowmapProgramHandles,
    tile: Tile,
    cache: FlowmapGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude owns projection.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    const o = this.flowOpts;
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uMinFlow, o.minFlow);
    gl.uniform1f(h.uWidthScale, this.widthScaleFor(gl, tile, ctx));
    gl.uniform1f(h.uWidthExponent, o.widthExponent);
    this.widthClamp[0] = o.widthMinPixels;
    this.widthClamp[1] = o.widthMaxPixels;
    gl.uniform2fv(h.uWidthClamp, this.widthClamp);
    gl.uniform1f(h.uGap, o.gap);
    gl.uniform1f(h.uHalfArrow, o.arrowShape === 'half' ? 1 : 0);
    gl.uniform1f(h.uHeadLength, o.headLength);
    gl.uniform1f(h.uHeadWidth, o.headWidth);
    gl.uniform1f(h.uHeadMaxFraction, o.headMaxFraction);
    gl.uniform1f(h.uTailScale, o.tailWidthScale);
    this.endpointInset[0] = o.sourceInsetPixels;
    this.endpointInset[1] = o.targetInsetPixels;
    gl.uniform2fv(h.uEndpointInset, this.endpointInset);
    this.setMagnitudeUniforms(gl, h, cache, ctx);
    this.setTimeUniforms(gl, h, cache, ctx);
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn);
    }
    // Colour is shared because its ALPHA gates the id pass as well as painting
    // the visual one — resolving it in one place is what keeps "invisible ⇒
    // unpickable" true for a gradient that ramps to alpha 0.
    this.setColorUniforms(gl, h, cache);
  }

  /**
   * Bind the per-vertex template and the per-instance attributes both passes
   * share — INCLUDING the per-feature colour, which the id pass needs for its
   * alpha gate. Only the id colour itself is bound by the caller, since only one
   * pass has it.
   */
  private bindSharedAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowmapProgramHandles,
    c: FlowmapGpuCache,
    template: WebGLBuffer,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, template);
    gl.enableVertexAttribArray(h.aVertex);
    gl.vertexAttribPointer(h.aVertex, 3, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aVertex, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.sourceBuffer);
    gl.enableVertexAttribArray(h.aSource);
    gl.vertexAttribPointer(h.aSource, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aSource, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.targetBuffer);
    gl.enableVertexAttribArray(h.aTarget);
    gl.vertexAttribPointer(h.aTarget, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aTarget, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aTime, 1);

    if (c.controlBuffer && h.aControl >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.controlBuffer);
      gl.enableVertexAttribArray(h.aControl);
      gl.vertexAttribPointer(h.aControl, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aControl, 1);
    }
    if (c.rowBuffer && h.aFlowRow >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.rowBuffer);
      gl.enableVertexAttribArray(h.aFlowRow);
      gl.vertexAttribPointer(h.aFlowRow, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFlowRow, 1);
    }
    if (c.magnitudeBuffer && h.aFlowMagnitude >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.magnitudeBuffer);
      gl.enableVertexAttribArray(h.aFlowMagnitude);
      gl.vertexAttribPointer(h.aFlowMagnitude, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFlowMagnitude, 1);
    }
    if (c.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 1);
    }
    if (c.colorBuffer && h.aColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
      gl.enableVertexAttribArray(h.aColor);
      gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aColor, 1);
    }
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const c = cache as FlowmapGpuCache;
    // The base frees BUFFERS on eviction but not textures; this stamp is how
    // `reapEvictedTextures` tells a live cache from a dropped one.
    c.frameStamp = this.frameStamp;
    this.drewThisFrame = true;
    if (this.shaderConfig.magnitude === 'texture' && !c.matrixTexture) return;

    const h = this.programFor(gl, frame, false);
    const segments = this.segmentsFor(frame, tile, c);
    const template = this.getTemplateBuffer(gl, segments);

    gl.useProgram(h.program);
    // Note the ORDER: the CPU fallback's `bufferSubData` lands here, before the
    // VAO is bound. ARRAY_BUFFER binding is not VAO state, so either order is
    // legal, but keeping the upload outside the recording scope keeps the VAO's
    // captured pointers unambiguous.
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);

    // A VAO records attribute LOCATIONS (per program) AND the bound template
    // buffer (per segment count), so either the host variant or the segment
    // count moving invalidates it. Buffers stay valid. Compared field-by-field:
    // this is the per-tile hot path, and concatenating a key here would allocate
    // one string per tile per frame to prove nothing changed.
    const variant = frame.shader.variantName;
    if (c.vao && (c.vaoVariant !== variant || c.vaoSegments !== segments)) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    this.bindVaoOrSetup(c, () => this.bindSharedAttributes(gl, h, c, template));
    c.vaoVariant = variant;
    c.vaoSegments = segments;

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      flowArrowVertexCount(segments, this.flowOpts.headSegments),
      c.instanceCount,
    );
  }

  /**
   * Draw this flow tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)`. The id program is built
   * from the SAME vertex source as the visual pass — same projection variant,
   * same tessellation, same time mode, same DataFilter branch, same magnitude
   * gate — so the pickable area is exactly the arrow the user sees, and an arrow
   * below `minFlow` (or filtered out, or outside the time window) discards
   * instead of leaving an invisible hit box.
   *
   * One instance IS one feature, so the id colours bind directly with no
   * expansion. The buffer is rebuilt each pick and freed immediately: `idBase`
   * shifts with whatever tiles are loaded this frame, and picks are rare
   * user-initiated events.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const c = cache as FlowmapGpuCache;
    if (this.shaderConfig.magnitude === 'texture' && !c.matrixTexture) return;
    const h = this.programFor(gl, frame, true);
    const segments = this.segmentsFor(frame, tile, c);
    const template = this.getTemplateBuffer(gl, segments);
    const idBuffer = this.uploadArrayBuffer(
      gl,
      this.buildPickIdColors(c.instanceCount, idBase),
    );

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass, and
    // the temp id buffer is per-pass, so a cached VAO would just go stale.
    this.bindSharedAttributes(gl, h, c, template);
    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aIdColor, 1);

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      flowArrowVertexCount(segments, this.flowOpts.headSegments),
      c.instanceCount,
    );

    // Leave the default-VAO attribute slate clean (and every divisor back at 0)
    // so the next visual frame's VAO recording starts from a known state, then
    // drop the one-shot id buffer.
    for (const loc of [
      h.aVertex,
      h.aSource,
      h.aTarget,
      h.aTime,
      h.aControl,
      h.aFlowRow,
      h.aFlowMagnitude,
      h.aFilterValue,
      h.aIdColor,
      // Mirrors bindSharedAttributes' own condition — disabling a slot that was
      // never enabled would leave the two out of step.
      c.colorBuffer ? h.aColor : -1,
    ]) {
      if (loc < 0) continue;
      this.instSupport.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
    gl.deleteBuffer(idBuffer);
  }
}

/** `numSegments` sanitized to `[1, MAX_FLOWMAP_SEGMENTS]` integers. */
function clampSegments(segments: number): number {
  if (!Number.isFinite(segments)) return DEFAULT_SHAFT_SEGMENTS;
  return Math.max(1, Math.min(MAX_FLOWMAP_SEGMENTS, Math.floor(segments)));
}

/** `headSegments` sanitized to `[1, MAX_FLOWMAP_HEAD_SEGMENTS]` integers. */
function clampHeadSegments(segments: number): number {
  if (!Number.isFinite(segments)) return DEFAULT_HEAD_SEGMENTS;
  return Math.max(1, Math.min(MAX_FLOWMAP_HEAD_SEGMENTS, Math.floor(segments)));
}

/** WebGL2 detection that tolerates a non-browser (test) global scope. */
function isWebGL2(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  return (
    typeof WebGL2RenderingContext !== 'undefined' &&
    gl instanceof WebGL2RenderingContext
  );
}

/**
 * `gl.MAX_TEXTURE_SIZE`, or the WebGL floor worth assuming when the host does
 * not answer (the package's test recorder, a stubbed context).
 */
function maxTextureSizeOf(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): number {
  const enums = gl as unknown as { MAX_TEXTURE_SIZE?: number };
  const value = gl.getParameter(enums.MAX_TEXTURE_SIZE ?? GL_MAX_TEXTURE_SIZE);
  return typeof value === 'number' && value >= 1 ? value : 4096;
}
