/**
 * Arc geometry adapter — renders origin→destination flows as raised 3D arcs.
 *
 * An arc is NOT a flat chord between its endpoints: one instanced ribbon per
 * OD pair, lifted off the ground along its path and (optionally) following the
 * great circle rather than the mercator chord.
 *
 * ── Topology ────────────────────────────────────────────────────────────────
 * One INSTANCE per feature, one shared strip of `2 * (segments + 1)` vertices
 * for the tessellation: vertex `(i, side)` samples the arc at `t = i /
 * segments` and offsets `side * width/2` perpendicular to the arc's SCREEN
 * direction, exactly like `STTLineLayer` extrudes a segment quad. The whole arc
 * therefore lives in the vertex shader — the tile only ever uploads two
 * endpoints, a distance and the per-feature style columns, so raising
 * `numSegments` costs vertices, never bytes or a tile rebuild.
 *
 * OD endpoints come from the shared core kernel: STT stores flows as LineString
 * features and `deriveSourceTargetPositions` collapses each to its first/last
 * vertex (the same reduction the deck `AnimatedArcLayer` feeds `ArcLayer`).
 *
 * ── Arc shape ───────────────────────────────────────────────────────────────
 * `height(t) = sqrt(t * (1 - t)) * distance * arcHeight` METRES — deck's
 * `ArcLayer` paraboloid with its peak ratio at the midpoint, so `arcHeight: 1`
 * peaks at half the ground distance (a semicircle-looking arc) and `0` is flat.
 * The distance is the GREAT-CIRCLE ground distance, resolved once per OD pair
 * at tile-upload time ({@link greatCircleMeters}), so an arc's height reads the
 * same at every latitude instead of inheriting mercator's stretch.
 *
 * `arcTilt` rotates the arc plane about the source→target axis, moving part of
 * the height into a lateral ground offset — the deck knob for separating arcs
 * that share endpoints.
 *
 * ── Elevation units (the projection kernel's one real trap) ─────────────────
 * `projectTileFor3D`'s elevation unit is host-variant dependent, exactly as the
 * polygon layer documents:
 *   - legacy `uMatrix` and the v5 MERCATOR prelude both take MERCATOR-Z;
 *   - the v5 GLOBE prelude takes METRES (`spherePos * (1 + elev/GLOBE_RADIUS)`)
 *     while its transition fallback term takes mercator-z again.
 * So the shader computes the arc height in METRES and multiplies by
 * `uMercatorZPerMeter` — the latitude-correct `mercatorZFromAltitude(1,
 * tileCentreLat)` — everywhere except the globe sphere term. The same factor
 * converts the tilt's lateral offset from metres to mercator units (mercator is
 * conformal: one factor scales x, y and z alike).
 *
 * ── Feature surface ─────────────────────────────────────────────────────────
 *   - all four time modes (`window`/`wake`/`cumulative`/`trail`), compiled in,
 *     never a uniform branch. `trail` is per-VERTEX along the arc: the reveal
 *     frontier walks source→target across `[startTime, endTime]`, the arc
 *     analogue of the line layer's progressive drawing (deck's ArcLayer is
 *     window-only, so this is a superset).
 *   - DataFilter (`filterProperty` + ranges), one per-FEATURE value bound
 *     directly (an arc is one instance per feature, so no expansion pass).
 *   - `colorProperty` + `colorMapping`/`colorPalette`, or the constant
 *     `sourceColor`→`targetColor` gradient.
 *   - `widthUnits: 'meters'` metric sizing with deck's min/max pixel clamps.
 *   - id-FBO picking under the IDENTICAL gates — time filter, DataFilter AND
 *     colour alpha (a gradient that ramps to alpha 0 is invisible at that end,
 *     so it is not a hit target there either), so an arc the user cannot see is
 *     never pickable.
 *
 * ── Globe ───────────────────────────────────────────────────────────────────
 * The arc is already subdivided (that is what `numSegments` is), so the globe
 * horizon-clipping rule is satisfied by RAISING the segment count on globe
 * frames until each piece is shorter than the host's subdivision granularity —
 * no second tile cache, no rebuild. STT tiles carry no `wrap` (Tile.id =
 * z/x/y/t) and this backend never draws world copies, so the wrap-skip rule is
 * vacuously satisfied.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_LINE_PALETTE } from '@poopdeck.gl/core';
import { deriveSourceTargetPositions } from '@poopdeck.gl/core/geometry';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from '../base-layer.js';
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
import {
  EARTH_RADIUS_M,
  lngLatToMercator,
  mercatorZFromAltitude,
  tileCenterLatitude,
} from '../lib/projection.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
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
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's name.
 */
export type ArcTimeFilterMode = STTTimeFilterMode;

/** Shared with the deck `AnimatedArcLayer` (single source of truth in core). */
const DEFAULT_ARC_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_LINE_PALETTE;

/** deck `ArcLayer` defaults, so a ported app sees the same arc. */
const DEFAULT_SOURCE_COLOR: [number, number, number, number] = [
  0, 150, 255, 255,
];
const DEFAULT_TARGET_COLOR: [number, number, number, number] = [
  255, 127, 14, 255,
];

/** deck `ArcLayer.numSegments` default. */
const DEFAULT_NUM_SEGMENTS = 50;

/**
 * Ceiling on the per-draw segment count, including the globe refinement bump.
 * 512 segments is 1026 vertices per instance — far beyond the point where an
 * arc reads as smooth, and the guard that keeps a hostile
 * `subdivisionGranularity` from demanding unbounded vertex work.
 */
export const MAX_ARC_SEGMENTS = 512;

export interface STTArcLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Colour at the SOURCE endpoint, `[r, g, b, a]`. Accepts 0–255 ints (the
   * deck `Color` convention, and what `colorPalette` uses) or 0–1 floats — the
   * range is auto-detected. Ignored when `colorProperty` is set.
   * @default [0, 150, 255, 255]
   */
  sourceColor?: [number, number, number, number];
  /**
   * Colour at the TARGET endpoint; the arc interpolates between the two along
   * its length. Ignored when `colorProperty` is set.
   * @default [255, 127, 14, 255]
   */
  targetColor?: [number, number, number, number];
  /**
   * Drive per-feature colour from a categorical property name. Like deck's
   * `AnimatedArcLayer`, a categorical column colours the WHOLE arc (both
   * endpoints the same colour) — the source→target gradient is the constant
   * path only.
   */
  colorProperty?: string;
  /** Palette used with {@link colorProperty} (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA colour map (deck/three `colorMapping`
   * parity). When set, {@link colorProperty}'s category NAME is looked up here
   * so a category renders the same colour in every tile regardless of per-tile
   * dictionary order. Unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional {@link colorPalette}.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /** Arc width, in {@link widthUnits}. Ignored when `widthProperty` is set. */
  width?: number;
  /** Drive per-feature width (in {@link widthUnits}) from a numeric column. */
  widthProperty?: string;
  /** Multiplier applied to both the constant and the per-feature width. */
  widthScale?: number;
  /**
   * Unit `width` / `widthProperty` values are expressed in. `'pixels'` (the
   * default) is constant-on-screen; `'meters'` sizes the ribbon on the ground,
   * resolved per tile at the tile's centre latitude and the map's fractional
   * zoom (deck `widthUnits` parity, same screen-space caveat under pitch as
   * `STTLineLayer`).
   */
  widthUnits?: 'pixels' | 'meters';
  /** Lower clamp on the final on-screen width, in device pixels. @default 0 */
  widthMinPixels?: number;
  /**
   * Upper clamp on the final on-screen width, in device pixels. Defaults to
   * effectively unbounded, matching deck.
   */
  widthMaxPixels?: number;
  /**
   * Arc height multiplier. The apex sits `arcHeight * distance / 2` metres
   * above the ground (deck `getHeight` semantics), so `1` is a semicircle-ish
   * arc and `0` is flat.
   * @default 1
   */
  arcHeight?: number;
  /**
   * Tilt the arc plane sideways, in DEGREES (deck `getTilt`). `0` keeps the arc
   * vertical; ±90 lays it flat on the ground, bulging to the right-hand
   * (respectively left-hand) side of the source→target direction seen north-up.
   * Useful for separating arcs that share both endpoints.
   * @default 0
   */
  arcTilt?: number;
  /**
   * Segments the arc is tessellated into. Higher is smoother and costs
   * vertices only — no extra bytes and no tile rebuild. On globe frames the
   * effective count is raised (never lowered) until each piece is shorter than
   * the host's subdivision granularity.
   * @default 50
   */
  numSegments?: number;
  /**
   * Follow the great circle between the endpoints instead of the straight
   * mercator chord (deck `greatCircle`). Costs one extra per-instance lon/lat
   * attribute and a spherical interpolation per vertex, compiled in only when
   * enabled. Long-haul flows are visibly wrong without it; city-scale flows are
   * indistinguishable, so it stays off by default.
   * @default false
   */
  greatCircle?: boolean;
  /**
   * Which temporal filter the shader applies. Defaults to `'window'`.
   *
   *   - `'window'` — lit while `[startTime, endTime]` overlaps the window.
   *   - `'wake'` — lit for {@link wakeLength} ms after `startTime`, fading AND
   *     narrowing toward {@link wakeTailScale}.
   *   - `'cumulative'` — appears at `startTime` and persists. CALLER
   *     OBLIGATION (deck's `TimeFilterExtension` states the same one): the
   *     shader does the reveal, the loader does not, so `timeWindow` must
   *     cover the played-through range or revealed tiles are evicted.
   *   - `'trail'` — per-VERTEX along the arc: the reveal frontier walks from
   *     the source at `startTime` to the target at `endTime`, with
   *     {@link trailLength} of tail behind it.
   *
   * `'wake'`/`'trail'` with a non-positive length knob degrade to `'window'`,
   * matching deck (whose extension enters those branches only for a positive
   * length). The mode is a compile-time shader choice, so switching it relinks
   * one program per host variant — no tile rebuild (unlike the line layer,
   * this layer bakes no per-vertex times: the frontier is interpolated).
   */
  timeFilterMode?: ArcTimeFilterMode;
  /**
   * Wake length in ms (`'wake'` mode). Defaults to HALF the layer's
   * `timeWindow` — the widest wake the loading window actually covers (deck's
   * `timeWindow >= 2 * wakeLength` rule) — so selecting the mode alone never
   * yields a blank layer. The default TRACKS `setTimeWindow`; an explicit
   * value is the caller's and is never re-derived.
   */
  wakeLength?: number;
  /** Trailing-edge width multiplier in wake mode (0..1). Defaults to core's 0.15. */
  wakeTailScale?: number;
  /**
   * Trail length in ms (`'trail'` mode). Defaults to half the layer's
   * `timeWindow` and tracks `setTimeWindow` the same way {@link wakeLength}
   * does. An explicit non-positive value degrades the mode to `'window'`.
   */
  trailLength?: number;
  /**
   * Trail head→tail fade: `1`/`true` (default) is the classic comet, `0`/
   * `false` a solid snake, intermediate numbers blend between them
   * (package-wide `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
}

// ── CPU arc math (JS references for the compiled GLSL) ──────────────────────

const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * `sin(85.0511287798°)` — the Web Mercator latitude cutoff expressed as a sine,
 * which is the form both this module's shader and {@link lngLatToMercator}'s
 * `log((1+sin)/(1-sin))` need. Clamping here is what keeps a great-circle arc
 * that passes near a pole from projecting to ±Infinity.
 */
export const MAX_MERCATOR_SIN = 0.99627207622;

/**
 * Great-circle ground distance in METRES between two lon/lat pairs (haversine
 * on {@link EARTH_RADIUS_M}, the radius the rest of this backend's metres are
 * anchored to). This is the `d` in the arc height formula, resolved once per OD
 * pair at tile-upload time so the shader never runs trigonometry per vertex.
 */
export function greatCircleMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      sinDLon *
      sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Shift `x` by whole worlds so it lands within half a world of `referenceX` —
 * the antimeridian fix. Mercator x is periodic with period 1, so an OD pair
 * whose endpoints straddle ±180° (e.g. 0.98 → 0.02) would otherwise interpolate
 * the LONG way across the entire map. The unwrapped target (here 1.02) keeps
 * the arc short and continuous; coordinates outside `[0, 1]` project fine (the
 * host matrix is affine in mercator, and on globe x simply reads as a
 * longitude past ±180°).
 *
 * Exactly halfway (`|x - referenceX| == 0.5`) resolves eastward, which is
 * arbitrary but deterministic.
 */
export function unwrapMercatorX(referenceX: number, x: number): number {
  return x - Math.floor(x - referenceX + 0.5);
}

/**
 * Arc height in METRES at parameter `t ∈ [0, 1]` — deck's `ArcLayer`
 * paraboloid with its peak ratio at the midpoint:
 * `sqrt(t * (1 - t)) * distance * arcHeight`.
 *
 * Zero at both endpoints, apex `arcHeight * distance / 2` at `t = 0.5`, and
 * symmetric about it. Values outside `[0, 1]` clamp to 0 rather than taking the
 * square root of a negative.
 */
export function arcHeightMeters(
  t: number,
  distanceMeters: number,
  arcHeight: number,
): number {
  return Math.sqrt(Math.max(t * (1 - t), 0)) * distanceMeters * arcHeight;
}

/**
 * The reveal frontier of `'trail'` mode: the time at which the arc's own
 * drawing reaches parameter `t`, interpolated across the feature's
 * `[startTime, endTime]`. A flow that takes an hour therefore draws itself over
 * that hour rather than blinking on whole.
 */
export function arcVertexTime(
  startTime: number,
  endTime: number,
  t: number,
): number {
  return startTime + (endTime - startTime) * t;
}

/** Options for {@link sampleArcMercator} — the JS mirror of the arc uniforms. */
export interface ArcSampleOptions {
  /** {@link STTArcLayerOptions.arcHeight}. */
  arcHeight: number;
  /** {@link STTArcLayerOptions.arcTilt}, in degrees. */
  tiltDegrees: number;
  /** `mercatorZFromAltitude(1, lat)` — metres → mercator units at this tile. */
  mercatorZPerMeter: number;
  /** Interpolate along the great circle instead of the mercator chord. */
  greatCircle?: boolean;
  /** Source lon/lat in degrees; required when `greatCircle` is set. */
  sourceLngLat?: readonly [number, number];
  /** Target lon/lat in degrees; required when `greatCircle` is set. */
  targetLngLat?: readonly [number, number];
}

/** One tessellated arc sample: ground position plus its height. */
export interface ArcSample {
  /** Mercator unit-square x (may fall outside `[0, 1]`; see {@link unwrapMercatorX}). */
  x: number;
  /** Mercator unit-square y. */
  y: number;
  /** Height above the ground in METRES, after the tilt split. */
  elevationMeters: number;
}

/** Unit-sphere direction for a lon/lat pair (degrees). */
function lngLatToUnitVector(
  lon: number,
  lat: number,
): [number, number, number] {
  const lonR = lon * DEG_TO_RAD;
  const latR = lat * DEG_TO_RAD;
  const c = Math.cos(latR);
  return [c * Math.cos(lonR), c * Math.sin(lonR), Math.sin(latR)];
}

/**
 * Mercator unit-square position of a sphere direction. The vector is
 * re-normalized first: the slerp's degenerate fallback blends linearly and
 * therefore returns a CHORD point, whose length is < 1.
 */
function unitVectorToMercator(v: readonly [number, number, number]): {
  x: number;
  y: number;
} {
  const lon = Math.atan2(v[1], v[0]);
  const len = Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9);
  const sinLat = Math.max(
    -MAX_MERCATOR_SIN,
    Math.min(MAX_MERCATOR_SIN, v[2] / len),
  );
  return {
    x: lon / TWO_PI + 0.5,
    y: 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI),
  };
}

/**
 * JS reference for the compiled arc tessellation: the ground position and
 * height the vertex shader computes at parameter `t`, in the SAME order of
 * operations (interpolate → height → tilt split → lateral offset). Kept beside
 * the GLSL so the two cannot drift, and the substrate for the parity tests.
 *
 * `source`/`target` are mercator unit-square positions with `target` already
 * antimeridian-unwrapped against `source` ({@link unwrapMercatorX}).
 */
export function sampleArcMercator(
  source: readonly [number, number],
  target: readonly [number, number],
  distanceMeters: number,
  t: number,
  opts: ArcSampleOptions,
): ArcSample {
  let gx: number;
  let gy: number;
  if (opts.greatCircle && opts.sourceLngLat && opts.targetLngLat) {
    const a = lngLatToUnitVector(opts.sourceLngLat[0], opts.sourceLngLat[1]);
    const b = lngLatToUnitVector(opts.targetLngLat[0], opts.targetLngLat[1]);
    const dot = Math.max(
      -1,
      Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
    );
    const omega = Math.acos(dot);
    const sinOmega = Math.sin(omega);
    let p: [number, number, number];
    if (sinOmega < 1e-6) {
      // Coincident or antipodal endpoints: slerp is undefined, fall back to the
      // straight-line blend (the shader takes the identical branch).
      p = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
    } else {
      const wa = Math.sin((1 - t) * omega) / sinOmega;
      const wb = Math.sin(t * omega) / sinOmega;
      p = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
    }
    const m = unitVectorToMercator(p);
    gx = unwrapMercatorX(source[0], m.x);
    gy = m.y;
  } else {
    gx = source[0] + (target[0] - source[0]) * t;
    gy = source[1] + (target[1] - source[1]) * t;
  }

  const h = arcHeightMeters(t, distanceMeters, opts.arcHeight);
  const tiltR = opts.tiltDegrees * DEG_TO_RAD;
  const ax = target[0] - source[0];
  const ay = target[1] - source[1];
  // Right-hand normal of the travel direction seen north-up (mercator y grows
  // southward, so (-dy, dx) points to the right of the direction of travel).
  const axisLen = Math.max(Math.hypot(ax, ay), 1e-12);
  const lateral = (h * Math.sin(tiltR) * opts.mercatorZPerMeter) / axisLen;
  return {
    x: gx + -ay * lateral,
    y: gy + ax * lateral,
    elevationMeters: h * Math.cos(tiltR),
  };
}

/**
 * The shared strip's per-VERTEX attribute stream for `segments` segments:
 * `(index, side)` pairs walking `index = 0…segments` twice over, `side`
 * alternating `-1`/`+1`, so a `TRIANGLE_STRIP` of `2 * (segments + 1)`
 * vertices covers the whole ribbon with no index buffer.
 */
export function buildArcStripVertices(segments: number): Float32Array {
  const n = Math.max(1, Math.floor(segments));
  const out = new Float32Array((n + 1) * 4);
  for (let i = 0; i <= n; i++) {
    out[i * 4] = i;
    out[i * 4 + 1] = -1;
    out[i * 4 + 2] = i;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** Vertices a `segments`-segment strip draws — `2 * (segments + 1)`. */
export function arcStripVertexCount(segments: number): number {
  return (Math.max(1, Math.floor(segments)) + 1) * 2;
}

/**
 * Resolve the COMPILED time mode from the requested one and the two length
 * knobs, applying deck's rule: `TimeFilterExtension` enters its wake branch
 * only for `wakeLength > 0` and its trail branch only for `trailLength > 0`,
 * otherwise falling through to the window branch. Both degenerate kernels here
 * return 0, so a mode left in that state would draw nothing at all.
 */
export function resolveArcTimeFilterMode(
  requested: ArcTimeFilterMode,
  wakeLength: number,
  trailLength: number,
): ArcTimeFilterMode {
  if (requested === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (requested === 'trail') return trailLength > 0 ? 'trail' : 'window';
  return requested;
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builder consumes. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled arc program supports. Every field is structural (it adds
 * attributes / uniforms / statements), so each combination is its own program
 * and each must appear in the program-cache key — {@link arcProgramKey}.
 */
export interface ArcShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: ArcTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
  /** Compile the spherical-interpolation path instead of the mercator chord. */
  greatCircle: boolean;
  /** Emit the flat id-colour pick pass instead of the visual one. */
  pick: boolean;
}

/** Baseline: window mode, no filter, mercator chord, visual pass. */
const DEFAULT_SHADER_CONFIG: ArcShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
  greatCircle: false,
  pick: false,
});

/** Kernel snippet compiled in per time mode (exactly one per program). */
const MODE_KERNEL: Readonly<Record<ArcTimeFilterMode, string>> = Object.freeze({
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
});

/**
 * Uniforms each mode reads; only the active mode's block is declared. The
 * ribbon narrows toward the tail in wake mode, so this is the record carrying
 * `uWakeTailScale`.
 */
const MODE_UNIFORMS = TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE;

/**
 * The `timeAlpha = …` expression per mode. `trail` is the only per-VERTEX one:
 * the frontier time at this vertex is the feature's `[start, end]` sampled at
 * the arc parameter `t` ({@link arcVertexTime}), so the arc draws itself from
 * source to target instead of appearing whole.
 */
const MODE_ALPHA: Readonly<Record<ArcTimeFilterMode, string>> = Object.freeze({
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

/**
 * Spherical-interpolation helpers, compiled in only for `greatCircle`. The
 * mercator formula matches `lib/projection.ts`'s `lngLatToMercator` exactly
 * (same `log((1+sin)/(1-sin))/(4π)` form, same latitude clamp) so the shader's
 * endpoints coincide with the CPU-projected ones.
 */
const GREAT_CIRCLE_GLSL = `
const float STT_TWO_PI = 6.283185307179586;
const float STT_MAX_MERCATOR_SIN = ${MAX_MERCATOR_SIN};

vec3 sttLngLatToUnit(vec2 lngLat) {
  float lon = radians(lngLat.x);
  float lat = radians(lngLat.y);
  float c = cos(lat);
  return vec3(c * cos(lon), c * sin(lon), sin(lat));
}

vec2 sttUnitToMercator(vec3 v) {
  float lon = atan(v.y, v.x);
  // Re-normalize: the slerp's degenerate fallback blends linearly and returns a
  // CHORD point, whose length is < 1 (and ~0 for antipodal endpoints at t=0.5).
  float s = clamp(v.z / max(length(v), 1e-9),
    -STT_MAX_MERCATOR_SIN, STT_MAX_MERCATOR_SIN);
  return vec2(
    lon / STT_TWO_PI + 0.5,
    0.5 - log((1.0 + s) / (1.0 - s)) / (2.0 * STT_TWO_PI)
  );
}

// Shortest-arc slerp; coincident/antipodal endpoints (sin(omega) ~ 0) fall back
// to the straight blend, matching the JS reference's branch.
vec3 sttSlerp(vec3 a, vec3 b, float t) {
  float omega = acos(clamp(dot(a, b), -1.0, 1.0));
  float s = sin(omega);
  if (s < 1e-6) return mix(a, b, t);
  return (sin((1.0 - t) * omega) * a + sin(t * omega) * b) / s;
}
`;

/**
 * Assemble the arc vertex shader.
 *
 * An empty `prelude` yields the legacy `uMatrix` source (maplibre ≤v4 /
 * mapbox); a v5+ host's prelude + define are prepended (maplibre's documented
 * injection order) and the arc projects through `projectTileFor3D` — the 3D
 * entry point, because an arc's whole point is that it leaves the ground. On
 * GLOBE the sphere term wants METRES while the transition fallback wants
 * mercator-z, so that branch is spelled out the same way the polygon layer's
 * extrusion is (including maplibre's own `z_globeness_threshold` of 0.2).
 *
 * The pick pass shares this builder rather than forking the tessellation: a hit
 * ribbon that drifted from the drawn one is exactly the bug an id-buffer picker
 * cannot detect from the CPU side.
 */
export function buildArcVertexSource(
  shader: ShaderInjection,
  cfg: ArcShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  const { mode, filter, greatCircle, pick } = cfg;
  const usesPrelude = shader.prelude.length > 0;
  const header = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const matrixUniform = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  // The colour surface is declared by BOTH passes. The visual one paints with
  // it; the id one reads only its ALPHA, so an arc the user cannot see — a
  // `sourceColor` with alpha 0 (the idiomatic "fade in from the origin"
  // gradient), or a `colorMapping` entry with alpha 0 — is not a hit target.
  // deck's `picking_filterPickingColor` discards the same way. Without it the
  // invisible half of a gradient would not just be pickable, it would OVERWRITE
  // the ids of visible features drawn earlier at those pixels (the pick pass is
  // unblended), turning their hits into misses.
  const colorDecls = `  attribute vec4 aColor;       // per-feature RGBA (when uUseFeatureColor=1)
  uniform float uUseFeatureColor;
  uniform vec4 uSourceColor;
  uniform vec4 uTargetColor;
${
  pick
    ? '  attribute vec3 aIdColor;     // per-feature encoded id (UNSIGNED_BYTE normalized)\n  varying vec3 vIdColor;\n'
    : '  varying vec4 vColor;\n'
}`;
  const colorAssign = pick
    ? `    vIdColor = aIdColor;
    vAlpha *= ((uUseFeatureColor > 0.5) ? aColor : mix(uSourceColor, uTargetColor, t)).a;
`
    : '    vColor = (uUseFeatureColor > 0.5) ? aColor : mix(uSourceColor, uTargetColor, t);\n';
  const groundBody = greatCircle
    ? `    vec3 p = sttSlerp(sttLngLatToUnit(aLngLat.xy), sttLngLatToUnit(aLngLat.zw), t);
    vec2 ground = sttUnitToMercator(p);
    // Keep the path within half a world of the source (antimeridian).
    ground.x -= floor(ground.x - aSource.x + 0.5);
`
    : '    vec2 ground = mix(aSource, aTarget, t);\n';
  // The shared elevated-projection kernel (shaders/globe-elevation.glsl.ts):
  // metres feed the globe sphere term, mercator-z feeds every flat matrix, and
  // the globe branch re-derives the horizon-clip z projectTileFor3D drops.
  const projectBody = `${buildElevatedProjection({
    usesPrelude,
    xy: 'posM',
    elevMeters: 'elevM',
    elevMercatorZ: 'elevM * uMercatorZPerMeter',
    names: {
      out: 'result',
      sphere: 'elevated',
      globe: 'globePos',
      flat: 'flatPos',
    },
  })}    return result;\n`;
  const wakeSize =
    mode === 'wake'
      ? '    widthPx *= sttWakeSizeScale(timeAlpha, uWakeTailScale);\n'
      : '';
  const filterSize = filter
    ? '    if (uFilterTransformSize > 0.5) widthPx *= filterAlpha;\n'
    : '';
  const filterAlphaDecl = filter
    ? `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};\n`
    : '';
  // deck's vs:#main-end collapse, keyed on the FILTER factor ONLY — that one is
  // per-FEATURE so the whole arc collapses, while the time alpha varies per
  // vertex in trail mode and would strand the revealed end at the origin.
  const alphaCommit = filter
    ? `    if (filterAlpha <= 0.0) gl_Position = vec4(0.0);
    float filterMask = (uFilterTransformColor > 0.5)
      ? filterAlpha
      : (filterAlpha > 0.0 ? 1.0 : 0.0);
    vAlpha = timeAlpha * filterMask;
`
    : '    vAlpha = timeAlpha;\n';

  return `${header}  precision highp float;
  attribute vec2 aVertex;      // (segment index, side ∈ {-1,+1}), per-vertex
  attribute vec2 aSource;      // mercator source endpoint, per-instance
  attribute vec2 aTarget;      // mercator target endpoint (unwrapped), per-instance
  attribute vec2 aTime;        // [startTime, endTime], per-instance, tile-relative
  attribute float aDistance;   // great-circle ground distance in METRES, per-instance
  attribute float aWidth;      // per-feature width (when uUseFeatureWidth=1)
${greatCircle ? '  attribute vec4 aLngLat;      // (srcLon, srcLat, tgtLon, tgtLat) degrees, per-instance\n' : ''}${colorDecls}${filter ? FILTER_ATTRIBUTE : ''}${matrixUniform}  uniform vec2 uViewport;
  uniform float uNumSegments;
  uniform float uArcHeight;
  uniform float uTiltCos;
  uniform float uTiltSin;
  uniform float uMercatorZPerMeter;
  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uWidthMinPixels;
  uniform float uWidthMaxPixels;
  uniform float uUseFeatureWidth;
${MODE_UNIFORMS[mode]}${filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${MODE_KERNEL[mode]}${filter ? DATA_FILTER_GLSL : ''}${greatCircle ? GREAT_CIRCLE_GLSL : ''}
  // Height above the ground in METRES at arc parameter t: deck's ArcLayer
  // paraboloid with its peak ratio at the midpoint.
  float sttArcHeightMeters(float t) {
    return sqrt(max(t * (1.0 - t), 0.0)) * aDistance * uArcHeight;
  }

  vec4 sttArcProject(float t) {
${groundBody}    float h = sttArcHeightMeters(t);
    // Tilt splits the height between "up" and "sideways"; the lateral axis is
    // the right-hand normal of the travel direction seen north-up (mercator y
    // grows southward). Metres → mercator units is the SAME conformal factor
    // the elevation uses.
    vec2 axis = aTarget - aSource;
    float axisLen = max(length(axis), 1e-12);
    vec2 posM = ground +
      vec2(-axis.y, axis.x) * (h * uTiltSin * uMercatorZPerMeter / axisLen);
    float elevM = h * uTiltCos;
${projectBody}  }

  void main() {
    float lastIndex = uNumSegments;
    float i = clamp(aVertex.x, 0.0, lastIndex);
    // The final sample has no forward neighbour, so it looks BACKWARD and flips
    // the side sign to keep the strip winding consistent (STTLineLayer's rule).
    float atEnd = step(lastIndex - 0.5, i);
    float sideSign = mix(1.0, -1.0, atEnd);
    float invSegments = 1.0 / max(lastIndex, 1.0);
    float t = i * invSegments;
    float tNeighbor = clamp(mix(i + 1.0, i - 1.0, atEnd) * invSegments, 0.0, 1.0);

    vec4 here = sttArcProject(t);
    vec4 there = sttArcProject(tNeighbor);
    vec2 hereNdc = here.xy / here.w;
    vec2 thereNdc = there.xy / there.w;
    vec2 dirPx = (thereNdc - hereNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    vec2 perp = vec2(-dirN.y, dirN.x) * sideSign;

    float timeAlpha = ${MODE_ALPHA[mode]};
${filterAlphaDecl}    float widthPx = (uUseFeatureWidth > 0.5 ? aWidth : uWidth) * uWidthScale;
    widthPx = clamp(widthPx, uWidthMinPixels, uWidthMaxPixels);
${wakeSize}${filterSize}    vec2 offsetPx = perp * aVertex.y * widthPx * 0.5;
    vec4 outClip = here;
    outClip.xy += (offsetPx / (0.5 * uViewport)) * here.w;
    gl_Position = outClip;
${alphaCommit}${colorAssign}  }
`;
}

/**
 * Program-cache key for one compiled configuration. `getOrCreateProgram`
 * appends `::${variantName}` (the HOST variant) only, so two configurations
 * sharing a base key would collide on one program.
 */
export function arcProgramKey(cfg: ArcShaderConfig): string {
  return `arc:${cfg.pick ? 'pick:' : ''}${cfg.mode}${cfg.filter ? ':filter' : ''}${
    cfg.greatCircle ? ':gc' : ''
  }`;
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
// The `vAlpha` discard is what makes time-filtered / range-filtered geometry
// unpickable rather than an invisible hit box — including, in trail mode, the
// not-yet-revealed part of an arc.
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

interface ArcProgramHandles
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
  aTime: number;
  aDistance: number;
  aWidth: number;
  /** -1 unless `greatCircle` compiled the spherical path in. */
  aLngLat: number;
  /** -1 on the id pass. */
  aColor: number;
  /** -1 on the visual passes. */
  aIdColor: number;
  /** -1 unless the DataFilter branch was compiled in. */
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uNumSegments: WebGLUniformLocation | null;
  uArcHeight: WebGLUniformLocation | null;
  uTiltCos: WebGLUniformLocation | null;
  uTiltSin: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uWidthMinPixels: WebGLUniformLocation | null;
  uWidthMaxPixels: WebGLUniformLocation | null;
  uUseFeatureWidth: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uSourceColor: WebGLUniformLocation | null;
  uTargetColor: WebGLUniformLocation | null;
}

interface ArcGpuCache extends TileGpuCache {
  /** Per-instance mercator source endpoints, stride-2 Float32. */
  sourceBuffer: WebGLBuffer;
  /** Per-instance mercator target endpoints (antimeridian-unwrapped). */
  targetBuffer: WebGLBuffer;
  /** Per-instance great-circle ground distance in metres. */
  distanceBuffer: WebGLBuffer;
  /** Per-instance (srcLon, srcLat, tgtLon, tgtLat); only when `greatCircle`. */
  lngLatBuffer?: WebGLBuffer;
  colorBuffer?: WebGLBuffer;
  widthBuffer?: WebGLBuffer;
  /** Per-instance filter value; absent when the tile lacks the column. */
  filterBuffer?: WebGLBuffer;
  /** Third argument to `resolveDataFilterUniforms` for THIS tile. */
  hasFilterColumn: boolean;
  /** One instance per FEATURE — also the pick-id space size for this tile. */
  instanceCount: number;
  /** Metres → mercator-z at this tile's centre latitude. */
  mercatorZPerMeter: number;
  /**
   * Widest per-axis mercator span of any OD pair in this tile. Globe frames
   * raise the segment count until each piece fits the host's granularity.
   */
  maxSpan: number;
  /**
   * The two axes the cached VAO was recorded against: the HOST variant (whose
   * program owns the attribute slots) and the SEGMENT count (which selects the
   * bound strip buffer). Either moving invalidates the recording; the layer's
   * own program key is constant for its lifetime, so it is not an axis.
   *
   * Deliberately two fields rather than one `${variant}::${segments}` string:
   * `drawTile` runs per resident tile per frame, and building that key there
   * would allocate a short-lived string per tile per frame purely to compare it
   * (the sibling kinds rebuild their VAO keys only inside the variant-flip
   * branch for exactly this reason).
   */
  vaoVariant?: string;
  vaoSegments?: number;
}

/**
 * Hand-built test DrawContexts may omit `frame`; treat them as a legacy
 * uMatrix host. Read-only — never handed to normalizeRenderArgs.
 */
const FALLBACK_LEGACY_FRAME: HostFrame = createHostFrame();

/**
 * MapLibre custom layer rendering STT OD-flow tiles as real 3D arcs.
 *
 * ```ts
 * const arcs = new STTArcLayer({
 *   id: 'flows',
 *   url: '/data/od.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 3_600_000,
 *   greatCircle: true,
 *   arcHeight: 0.6,
 *   width: 2,
 * });
 * arcs.attach(map);
 * ```
 */
export class STTArcLayer extends STTFilterableLayer {
  private arcOpts: {
    sourceColor: [number, number, number, number];
    targetColor: [number, number, number, number];
    colorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    width: number;
    widthProperty?: string;
    widthScale: number;
    widthUnits: 'pixels' | 'meters';
    widthMinPixels: number;
    widthMaxPixels: number;
    arcHeight: number;
    arcTilt: number;
    numSegments: number;
    greatCircle: boolean;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };
  /** Compiled configuration; drives both program-cache keys. */
  private shaderConfig: ArcShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /**
   * Tail lengths AS PASSED (undefined ⇒ derived from `timeWindow`) and the mode
   * as REQUESTED — `shaderConfig.mode` holds the DEGRADED one. Together these
   * let {@link resolveTimeConfig} re-derive both after a `setTimeWindow`
   * without ever overwriting a caller's explicit value.
   */
  private readonly wakeLengthOpt?: number;
  private readonly trailLengthOpt?: number;
  private requestedMode: ArcTimeFilterMode;
  /**
   * Shared strip vertex buffers, keyed by segment count. Two entries at most in
   * practice (the configured count and the globe-refined one); rebuilt lazily
   * and released with the context.
   */
  private readonly stripBuffers = new Map<number, WebGLBuffer>();
  /** Memoized handles per pass, refreshed only on a variant / config flip. */
  private handles?: ArcProgramHandles;
  private handlesVariant?: string;
  private idHandles?: ArcProgramHandles;
  private idHandlesVariant?: string;

  constructor(opts: STTArcLayerOptions) {
    super(opts);
    // Wake/trail lengths default to the trailing half of the loading window —
    // the widest tail the tiles actually cover (deck's `timeWindow >= 2 *
    // wakeLength` rule) — so selecting a mode alone can never blank the layer.
    // Kept as OPTIONS, not a snapshot: `setTimeWindow` re-derives the defaulted
    // ones, or the shader would light arcs for a tail the loader dropped.
    this.wakeLengthOpt = opts.wakeLength;
    this.trailLengthOpt = opts.trailLength;
    this.requestedMode = opts.timeFilterMode ?? 'window';
    const halfWindow = Math.max(0, opts.timeWindow / 2);
    this.arcOpts = {
      sourceColor: opts.sourceColor ?? DEFAULT_SOURCE_COLOR,
      targetColor: opts.targetColor ?? DEFAULT_TARGET_COLOR,
      colorProperty: opts.colorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_ARC_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      width: opts.width ?? 2,
      widthProperty: opts.widthProperty,
      widthScale: opts.widthScale ?? 1,
      widthUnits: opts.widthUnits ?? 'pixels',
      widthMinPixels: opts.widthMinPixels ?? 0,
      widthMaxPixels: opts.widthMaxPixels ?? Number.MAX_SAFE_INTEGER,
      arcHeight: opts.arcHeight ?? 1,
      arcTilt: opts.arcTilt ?? 0,
      numSegments: clampSegments(opts.numSegments ?? DEFAULT_NUM_SEGMENTS),
      greatCircle: opts.greatCircle === true,
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
      greatCircle: this.arcOpts.greatCircle,
      pick: false,
    };
    this.mainKey = '';
    this.pickKey = '';
    this.resolveTimeConfig();
    this.rebuildProgramKeys();
  }

  /**
   * Re-derive the defaulted tail lengths from the CURRENT `timeWindow` and the
   * compiled mode from those lengths. Returns true when the compiled mode
   * moved, so callers know whether a relink is due.
   */
  private resolveTimeConfig(): boolean {
    const half = Math.max(0, this.opts.timeWindow / 2);
    const wake = this.wakeLengthOpt ?? half;
    const trail = this.trailLengthOpt ?? half;
    this.arcOpts.wakeLength = wake;
    this.arcOpts.trailLength = trail;
    const resolved = resolveArcTimeFilterMode(this.requestedMode, wake, trail);
    const changed = this.shaderConfig.mode !== resolved;
    this.shaderConfig.mode = resolved;
    return changed;
  }

  /** Rebuild both program-cache keys after the compiled config moved. */
  private rebuildProgramKeys(): void {
    this.mainKey = arcProgramKey(this.shaderConfig);
    this.pickKey = arcProgramKey({ ...this.shaderConfig, pick: true });
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /**
   * Widen/narrow the loading window. Overridden because the defaulted
   * `wakeLength`/`trailLength` are DERIVED from it: leaving them behind would
   * light arcs for a tail the loader no longer covers.
   */
  setTimeWindow(ms: number): void {
    super.setTimeWindow(ms);
    if (!this.resolveTimeConfig()) return;
    this.rebuildProgramKeys();
    this.map?.triggerRepaint();
  }

  /**
   * Switch the temporal filter. The mode is compiled in, so this relinks one
   * program per host variant on the next frame — no tile rebuild (the trail
   * frontier is interpolated, not baked).
   */
  setTimeFilterMode(mode: ArcTimeFilterMode): void {
    if (this.requestedMode === mode) return;
    this.requestedMode = mode;
    if (!this.resolveTimeConfig()) {
      this.map?.triggerRepaint();
      return;
    }
    this.rebuildProgramKeys();
    this.map?.triggerRepaint();
  }

  /** Source-endpoint colour of the constant gradient. */
  setSourceColor(color: [number, number, number, number]): void {
    this.arcOpts.sourceColor = color;
    this.map?.triggerRepaint();
  }

  /** Target-endpoint colour of the constant gradient. */
  setTargetColor(color: [number, number, number, number]): void {
    this.arcOpts.targetColor = color;
    this.map?.triggerRepaint();
  }

  /** Constant arc width, in `widthUnits`. Uniform-only. */
  setWidth(width: number): void {
    this.arcOpts.width = width;
    this.map?.triggerRepaint();
  }

  /** Arc height multiplier (0 = flat). Uniform-only — no relink, no rebuild. */
  setArcHeight(arcHeight: number): void {
    this.arcOpts.arcHeight = arcHeight;
    this.map?.triggerRepaint();
  }

  /** Arc tilt in degrees. Uniform-only. */
  setArcTilt(degrees: number): void {
    this.arcOpts.arcTilt = degrees;
    this.map?.triggerRepaint();
  }

  /**
   * Tessellation density. Costs vertices only: the strip buffer for the new
   * count is built once and cached, and no tile cache is touched.
   */
  setNumSegments(segments: number): void {
    this.arcOpts.numSegments = clampSegments(segments);
    this.map?.triggerRepaint();
  }

  /** STT stores OD flows as LineString features (first vertex → last vertex). */
  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.LineString;
  }

  protected onContextReady(): void {
    // Programs are linked lazily, one per host shader variant, through the base
    // getOrCreateProgram cache — nothing to allocate eagerly.
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Per-variant programs live in the base program cache, which the base layer
    // invalidates for us. The strip buffers are this layer's own: delete them
    // when the context is alive (dispose) and drop the references either way
    // (deletes on a lost context are silently ignored).
    for (const buf of this.stripBuffers.values()) gl.deleteBuffer(buf);
    this.stripBuffers.clear();
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /**
   * The shared `(segmentIndex, side)` strip for `segments` segments, uploaded
   * once per distinct count. Per-vertex (divisor 0) — every instance reuses it.
   */
  private getStripBuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    segments: number,
  ): WebGLBuffer {
    const existing = this.stripBuffers.get(segments);
    if (existing) return existing;
    const buf = this.uploadArrayBuffer(gl, buildArcStripVertices(segments));
    this.stripBuffers.set(segments, buf);
    return buf;
  }

  /**
   * Segments to draw this tile with. Off globe it is the configured count. On
   * globe the arc's own tessellation IS the subdivision that keeps chords from
   * being horizon-clipped, so the count is raised (never lowered) until each
   * piece is shorter than the host's granularity — a uniform + a different
   * shared strip buffer, never a tile rebuild.
   */
  private segmentsFor(
    frame: HostFrame,
    tile: Tile,
    cache: ArcGpuCache,
  ): number {
    const base = this.arcOpts.numSegments;
    if (!frame.isGlobe) return base;
    const granularity = this.tileSubdivisionGranularity(tile.id.z);
    const needed = Math.ceil(cache.maxSpan * granularity);
    if (!Number.isFinite(needed) || needed <= base) return base;
    // Round UP to a power of two. Over-tessellating is always safe, and it caps
    // the shared strip cache at ~10 entries however many distinct tile spans
    // are resident — otherwise every tile with its own `maxSpan` would mint (and
    // hold, until context loss) its own strip buffer.
    return Math.min(MAX_ARC_SEGMENTS, 2 ** Math.ceil(Math.log2(needed)));
  }

  /**
   * Build the per-tile cache: two endpoints, a distance and the style columns
   * per OD pair. The arc itself is never uploaded — `numSegments` is a uniform,
   * so tessellation density costs no bytes and no rebuild.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): ArcGpuCache | null {
    if (!this.instSupport.enabled) {
      // No instancing → no arcs. Logged so hosts can detect and swap runtime.
      console.warn(
        `[${this.id}] runtime lacks ANGLE_instanced_arrays / WebGL2; ` +
          `STTArcLayer requires instancing.`,
      );
      return null;
    }
    const f = layer.features;
    const featureCount = f.featureCount;
    if (featureCount === 0 || !f.positions?.length || !f.startIndices) {
      return null;
    }

    // First/last vertex of each LineString — the shared core reduction the deck
    // arc layer feeds ArcLayer with.
    const { source, target, dims } = deriveSourceTargetPositions(f);

    const srcM = new Float32Array(featureCount * 2);
    const tgtM = new Float32Array(featureCount * 2);
    const distances = new Float32Array(featureCount);
    const lngLat = this.arcOpts.greatCircle
      ? new Float32Array(featureCount * 4)
      : null;
    let maxSpan = 0;
    for (let i = 0; i < featureCount; i++) {
      const sLon = source[i * dims];
      const sLat = source[i * dims + 1];
      const tLon = target[i * dims];
      const tLat = target[i * dims + 1];
      const [sx, sy] = lngLatToMercator(sLon, sLat);
      const [txRaw, ty] = lngLatToMercator(tLon, tLat);
      // Antimeridian: take the short way round, or a Tokyo→Los Angeles flow
      // would sweep back across the entire map.
      const tx = unwrapMercatorX(sx, txRaw);
      srcM[i * 2] = sx;
      srcM[i * 2 + 1] = sy;
      tgtM[i * 2] = tx;
      tgtM[i * 2 + 1] = ty;
      distances[i] = greatCircleMeters(sLon, sLat, tLon, tLat);
      if (lngLat) {
        lngLat[i * 4] = sLon;
        lngLat[i * 4 + 1] = sLat;
        lngLat[i * 4 + 2] = tLon;
        lngLat[i * 4 + 3] = tLat;
      }
      const span = Math.max(Math.abs(tx - sx), Math.abs(ty - sy));
      if (span > maxSpan) maxSpan = span;
    }

    const featureColors = this.arcOpts.colorProperty
      ? this.expandCategoricalColors(
          f,
          this.arcOpts.colorProperty,
          this.arcOpts.colorPalette,
          this.arcOpts.colorMapping,
          this.arcOpts.colorMappingDefault,
        )
      : null;
    const featureWidths = this.arcOpts.widthProperty
      ? this.getNumericProperty(f, this.arcOpts.widthProperty)
      : null;

    // Range filter: an arc is ONE instance per feature, so the per-FEATURE
    // column binds directly (no expandFilterValues). A missing / categorical
    // column resolves to `hasFilterColumn: false`, which the uniform resolver
    // turns into `enabled: 0` — an UNFILTERED tile, never a blank one.
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
    const distanceBuffer = this.uploadArrayBuffer(gl, distances);
    const timeBuffer = this.uploadFeatureTimes(gl, f.startTimes, f.endTimes);
    const extras: WebGLBuffer[] = [targetBuffer, distanceBuffer];
    let lngLatBuffer: WebGLBuffer | undefined;
    let colorBuffer: WebGLBuffer | undefined;
    let widthBuffer: WebGLBuffer | undefined;
    let filterBuffer: WebGLBuffer | undefined;
    if (lngLat) {
      lngLatBuffer = this.uploadArrayBuffer(gl, lngLat);
      extras.push(lngLatBuffer);
    }
    if (featureColors) {
      colorBuffer = this.uploadArrayBuffer(gl, featureColors);
      extras.push(colorBuffer);
    }
    if (featureWidths) {
      widthBuffer = this.uploadArrayBuffer(gl, featureWidths);
      extras.push(widthBuffer);
    }
    if (filterValues) {
      filterBuffer = this.uploadArrayBuffer(gl, filterValues);
      extras.push(filterBuffer);
    }

    return {
      // The base cleanup walk deletes `positionBuffer`/`timeBuffer`/`extraBuffers`,
      // so the source endpoints ride in the "primary" slot.
      positionBuffer: sourceBuffer,
      sourceBuffer,
      targetBuffer,
      distanceBuffer,
      timeBuffer,
      lngLatBuffer,
      colorBuffer,
      widthBuffer,
      filterBuffer,
      hasFilterColumn,
      // One instance per feature; the strip's own vertex count is a per-draw
      // uniform, so it is deliberately NOT baked here.
      vertexCount: featureCount,
      indexCount: 0,
      instanceCount: featureCount,
      timeOffset: f.timeOffset,
      mercatorZPerMeter: mercatorZFromAltitude(
        1,
        tileCenterLatitude(tile.id.z, tile.id.y),
      ),
      maxSpan,
      extraBuffers: extras,
    };
  }

  /**
   * Fetch (or link) the program for this frame's host variant, the active
   * compiled configuration and this pass. The base cache appends the host
   * variant name, so the mode / filter / greatCircle / pass axes must all be in
   * OUR key or two different programs would collide on one entry.
   */
  private programFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    pick: boolean,
  ): ArcProgramHandles {
    const variant = frame.shader.variantName;
    const memo = pick ? this.idHandles : this.handles;
    const memoVariant = pick ? this.idHandlesVariant : this.handlesVariant;
    if (memo && memoVariant === variant) return memo;
    const handles = this.getOrCreateProgram(
      gl,
      pick ? this.pickKey : this.mainKey,
      frame,
      (glc, shader) => {
        const program = this.linkProgram(
          glc,
          buildArcVertexSource(shader, { ...this.shaderConfig, pick }),
          pick ? ID_FS_SOURCE : FS_SOURCE,
        );
        return {
          program,
          usesPrelude: shader.prelude.length > 0,
          aVertex: glc.getAttribLocation(program, 'aVertex'),
          aSource: glc.getAttribLocation(program, 'aSource'),
          aTarget: glc.getAttribLocation(program, 'aTarget'),
          aTime: glc.getAttribLocation(program, 'aTime'),
          aDistance: glc.getAttribLocation(program, 'aDistance'),
          aWidth: glc.getAttribLocation(program, 'aWidth'),
          aLngLat: this.shaderConfig.greatCircle
            ? glc.getAttribLocation(program, 'aLngLat')
            : -1,
          // Both passes declare it: the visual pass paints with it, the id pass
          // gates on its alpha.
          aColor: glc.getAttribLocation(program, 'aColor'),
          aIdColor: pick ? glc.getAttribLocation(program, 'aIdColor') : -1,
          aFilterValue: this.shaderConfig.filter
            ? glc.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
            : -1,
          uMatrix: glc.getUniformLocation(program, 'uMatrix'),
          uViewport: glc.getUniformLocation(program, 'uViewport'),
          uNumSegments: glc.getUniformLocation(program, 'uNumSegments'),
          uArcHeight: glc.getUniformLocation(program, 'uArcHeight'),
          uTiltCos: glc.getUniformLocation(program, 'uTiltCos'),
          uTiltSin: glc.getUniformLocation(program, 'uTiltSin'),
          uMercatorZPerMeter: glc.getUniformLocation(
            program,
            'uMercatorZPerMeter',
          ),
          uWidth: glc.getUniformLocation(program, 'uWidth'),
          uWidthScale: glc.getUniformLocation(program, 'uWidthScale'),
          uWidthMinPixels: glc.getUniformLocation(program, 'uWidthMinPixels'),
          uWidthMaxPixels: glc.getUniformLocation(program, 'uWidthMaxPixels'),
          uUseFeatureWidth: glc.getUniformLocation(program, 'uUseFeatureWidth'),
          uUseFeatureColor: glc.getUniformLocation(program, 'uUseFeatureColor'),
          uSourceColor: glc.getUniformLocation(program, 'uSourceColor'),
          uTargetColor: glc.getUniformLocation(program, 'uTargetColor'),
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
   * make metric widths jump a factor of 2 per zoom level). Folding the factor
   * into the scale keeps both `uWidth` and the per-feature `aWidth` metric with
   * no extra uniform or shader branch.
   */
  private widthScaleFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { widthScale, widthUnits } = this.arcOpts;
    if (widthUnits !== 'meters') return widthScale;
    // Shared base helper (fractional zoom + dpr + tile-centre latitude).
    return widthScale * this.metricPixelScale(gl, tile, ctx);
  }

  /** Upload the active mode's time uniforms (only those exist in the program). */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ArcProgramHandles,
    cache: ArcGpuCache,
    ctx: DrawContext,
  ): void {
    // Tile-relative, the convention every time kernel here compares in.
    const relTime = ctx.currentTime - cache.timeOffset;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uWakeLength, this.arcOpts.wakeLength);
        gl.uniform1f(h.uWakeTailScale, this.arcOpts.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uTrailLength, this.arcOpts.trailLength);
        gl.uniform1f(h.uFadeTrail, this.arcOpts.fadeTrail);
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
   * Projection + tessellation + sizing + time + filter uniforms — everything
   * the visual and id passes set IDENTICALLY, so the pickable ribbon always
   * matches the drawn one (including on globe, where the prelude owns
   * projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ArcProgramHandles,
    tile: Tile,
    cache: ArcGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
    segments: number,
  ): void {
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude owns projection.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uNumSegments, segments);
    gl.uniform1f(h.uArcHeight, this.arcOpts.arcHeight);
    const tiltRadians = this.arcOpts.arcTilt * DEG_TO_RAD;
    gl.uniform1f(h.uTiltCos, Math.cos(tiltRadians));
    gl.uniform1f(h.uTiltSin, Math.sin(tiltRadians));
    gl.uniform1f(h.uMercatorZPerMeter, cache.mercatorZPerMeter);
    gl.uniform1f(h.uWidth, this.arcOpts.width);
    gl.uniform1f(h.uWidthScale, this.widthScaleFor(gl, tile, ctx));
    gl.uniform1f(h.uWidthMinPixels, this.arcOpts.widthMinPixels);
    gl.uniform1f(h.uWidthMaxPixels, this.arcOpts.widthMaxPixels);
    gl.uniform1f(
      h.uUseFeatureWidth,
      cache.widthBuffer && h.aWidth >= 0 ? 1 : 0,
    );
    // Colour is shared because its ALPHA gates the id pass as well as painting
    // the visual one — resolving it in one place is what keeps "invisible ⇒
    // unpickable" true for a gradient that ramps to alpha 0.
    gl.uniform4fv(
      h.uSourceColor,
      this.rgba01Uniform('SourceColor', this.arcOpts.sourceColor),
    );
    gl.uniform4fv(
      h.uTargetColor,
      this.rgba01Uniform('TargetColor', this.arcOpts.targetColor),
    );
    gl.uniform1f(
      h.uUseFeatureColor,
      cache.colorBuffer && h.aColor >= 0 ? 1 : 0,
    );
    this.setTimeUniforms(gl, h, cache, ctx);
    // A tile that didn't bake the column resolves to `enabled: 0`, which the
    // kernel reads as "render everything".
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn);
    }
  }

  /**
   * Bind the per-vertex strip and the per-instance attributes both passes
   * share — INCLUDING the per-feature colour, which the id pass needs for its
   * alpha gate (see `buildArcVertexSource`). Only the id colour itself is bound
   * by the caller, since only one pass has it.
   */
  private bindSharedAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ArcProgramHandles,
    c: ArcGpuCache,
    strip: WebGLBuffer,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, strip);
    gl.enableVertexAttribArray(h.aVertex);
    gl.vertexAttribPointer(h.aVertex, 2, gl.FLOAT, false, 0, 0);
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

    gl.bindBuffer(gl.ARRAY_BUFFER, c.distanceBuffer);
    gl.enableVertexAttribArray(h.aDistance);
    gl.vertexAttribPointer(h.aDistance, 1, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aDistance, 1);

    if (c.lngLatBuffer && h.aLngLat >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.lngLatBuffer);
      gl.enableVertexAttribArray(h.aLngLat);
      gl.vertexAttribPointer(h.aLngLat, 4, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aLngLat, 1);
    }
    if (c.widthBuffer && h.aWidth >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.widthBuffer);
      gl.enableVertexAttribArray(h.aWidth);
      gl.vertexAttribPointer(h.aWidth, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aWidth, 1);
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
    const h = this.programFor(gl, frame, false);
    const c = cache as ArcGpuCache;
    const segments = this.segmentsFor(frame, tile, c);
    const strip = this.getStripBuffer(gl, segments);

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame, segments);

    // A VAO records attribute LOCATIONS (per program) AND the bound strip
    // buffer (per segment count), so either the host variant or the segment
    // count moving invalidates it. Buffers stay valid. Compared field-by-field:
    // this is the per-tile hot path, and concatenating a key here would
    // allocate one string per tile per frame to prove nothing changed.
    const variant = frame.shader.variantName;
    if (c.vao && (c.vaoVariant !== variant || c.vaoSegments !== segments)) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    this.bindVaoOrSetup(c, () => this.bindSharedAttributes(gl, h, c, strip));
    c.vaoVariant = variant;
    c.vaoSegments = segments;

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      arcStripVertexCount(segments),
      c.instanceCount,
    );
  }

  /**
   * Draw this arc tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)`. The id program is built
   * from the SAME vertex source as the visual pass — same projection variant,
   * same tessellation, same time mode, same DataFilter branch — so the pickable
   * area is exactly the ribbon the user sees, and time- or range-filtered arcs
   * discard instead of leaving an invisible hit box. In trail mode that extends
   * to the not-yet-revealed part of an arc.
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
    const h = this.programFor(gl, frame, true);
    const c = cache as ArcGpuCache;
    const segments = this.segmentsFor(frame, tile, c);
    const strip = this.getStripBuffer(gl, segments);
    const idBuffer = this.uploadArrayBuffer(
      gl,
      this.buildPickIdColors(c.instanceCount, idBase),
    );

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame, segments);

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass, and
    // the temp id buffer is per-pass, so a cached VAO would just go stale.
    this.bindSharedAttributes(gl, h, c, strip);
    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aIdColor, 1);

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      arcStripVertexCount(segments),
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
      h.aDistance,
      h.aLngLat,
      h.aWidth,
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

/** `numSegments` sanitized to `[1, MAX_ARC_SEGMENTS]` integers. */
function clampSegments(segments: number): number {
  if (!Number.isFinite(segments)) return DEFAULT_NUM_SEGMENTS;
  return Math.max(1, Math.min(MAX_ARC_SEGMENTS, Math.floor(segments)));
}
