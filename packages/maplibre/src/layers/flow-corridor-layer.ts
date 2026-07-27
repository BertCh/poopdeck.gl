// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * The FLOW CORRIDOR family — a static network (river reaches, street corridors,
 * channels) whose per-reach MAGNITUDE is a time series driving WIDTH and COLOUR.
 *
 * Two classes ship here because they are one machine with two dressings:
 *   - {@link STTFlowCorridorLayer} — one ground ribbon per reach, centred on the
 *     polyline (the NWM rivers / rain-flood substrate).
 *   - {@link STTFlowStrokeLayer} — the same ribbon pushed sideways by a multiple
 *     of its own live width, so A→B and B→A corridors sharing a street land on
 *     opposite sides and the pair "breathes" apart at rush hour and merges
 *     overnight (deck's `FlowStrokeLayer` twin-ribbon reading).
 * The stroke class is a thin subclass: same tile cache, same shaders, different
 * defaults.
 *
 * ── THE ONE INVARIANT ───────────────────────────────────────────────────────
 * **Geometry is tessellated ONCE per tile and is never rebuilt for a time
 * change.** Per frame this layer writes ONE scalar (`uFlowBucket`, the
 * continuous timestep position from `bucketPositionAt`) and draws. The width of
 * every reach is resolved on the GPU, in the vertex stage, from the packed
 * value matrix — `posM = path + aFlowExtrusion * halfWidth`, where the ribbon's
 * unit-width miter offset was baked at upload and only the scalar moves.
 *
 * | changes                | when                   | cost              |
 * | ---------------------- | ---------------------- | ----------------- |
 * | ribbon vertex buffers  | tile upload / eviction | once per tile     |
 * | value-matrix texture   | tile upload / eviction | once per tile     |
 * | `uFlowBucket`          | every frame            | one `uniform1f`   |
 * | magnitude per vertex   | every frame, ON THE GPU| 2 texture fetches |
 *
 * The deck backend's `FlowCorridorLayer` got this wrong in a way that cost a
 * ~6 Hz whole-network re-tessellation: its prepared-tile `styleKey` folded the
 * quantized playhead in (`gradientStyleSuffix` → `:fp{step}`), so every sub-step
 * minted a fresh `data` object and deck re-ran PathLayer tessellation over the
 * entire street network. The guard rail here is {@link flowTileKey}: the tile
 * cache key carries the tile, the layer and the GEOMETRY shape (globe
 * granularity) — never the playhead, never a bucket, never a sub-step. A
 * playhead in that key brings the bug back.
 *
 * ── Magnitude sources ───────────────────────────────────────────────────────
 * Resolved ONCE per GL context, and a shader permutation axis either way:
 *
 *  - **`'texture'`** (the design): the tile's `vertexValueMatrix` is packed by
 *    `packVertexValueMatrix` and uploaded as one texture; the vertex stage runs
 *    `sttFlowMagnitude(aFlowRow, uFlowBucket)`, interpolating between the two
 *    adjacent timesteps continuously — corridors breathe at frame rate rather
 *    than stepping at the CPU sub-step.
 *  - **`'attribute'`** (the fallback): WebGL1's minimum for
 *    `MAX_VERTEX_TEXTURE_IMAGE_UNITS` is ZERO, so a host may legally refuse
 *    vertex texture fetch. Then `expandFlowMagnitudes` writes one magnitude per
 *    ribbon vertex into a DYNAMIC buffer, gated on `CPU_FALLBACK_SUB_STEP` so it
 *    updates twice per timestep instead of per frame. GEOMETRY IS STILL NEVER
 *    REBUILT — only the magnitude attribute's contents change.
 *
 * A tile with no matrix falls through to the static `vertexValues` channel
 * (packed as a ONE-column matrix, so the sampler's clamp reads it at every
 * playhead); a tile with neither renders at a constant magnitude
 * (`uFlowConstant`), i.e. a plain network at `widthScale` — never blank.
 *
 * ── Why there is no elevation here ──────────────────────────────────────────
 * A corridor is a GROUND ribbon: the extrusion is applied in MERCATOR space
 * before projection, so the ribbon foreshortens with the ground under pitch and
 * curves with the globe. Nothing leaves the ground, so this layer projects
 * through `projectTile(vec2)` (which owns horizon clipping) and never touches
 * `projectTileFor3D` — and therefore never meets the metres-vs-mercator-z
 * elevation trap that `shaders/globe-elevation.glsl.ts` exists to solve. If a
 * future variant lifts corridors off the terrain it MUST route through
 * `buildElevatedProjection`, not hand-roll the unit conversion.
 *
 * ── Feature surface ─────────────────────────────────────────────────────────
 *  - four time modes (window default / wake / cumulative / trail), compiled in;
 *  - the DataFilter kernel (`filterProperty` + range/soft-range/transforms);
 *  - `colorRamp` — magnitude → colour through `sttFlowRampT`, the other half of
 *    "magnitude drives width AND colour";
 *  - `colorProperty` — categorical per-reach colour with keyed `colorMapping`;
 *  - id-FBO picking, where a REACH is a feature, gated exactly like the visual
 *    pass: a corridor whose `sttFlowWidth` collapsed to 0, whose time alpha is
 *    0, whose DataFilter hid it or whose colour alpha is 0 is NOT pickable.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_LINE_PALETTE } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTFilterableLayer,
  expandPickIdColors,
  resolveTrailFade,
  type DrawContext,
  type RGBA8,
  type STTFilterableLayerOptions,
  type STTTimeFilterMode,
  type TileGpuCache,
} from '../base-layer.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import {
  CPU_FALLBACK_SUB_STEP,
  bucketPositionAt,
  buildCorridorRibbon,
  chooseFlowMatrixFormat,
  createFlowMatrixUniforms,
  deriveFlowAxis,
  expandFlowMagnitudes,
  flowTileKey,
  mercatorPerPixel,
  packValueMatrix,
  packVertexValueMatrix,
  quantizeBucketPosition,
  resolveFlowMatrixUniforms,
  supportsVertexTextureFetch,
  type CorridorRibbon,
  type FlowBucketAxis,
  type FlowMatrixUniforms,
  type PackedValueMatrix,
  type VertexTextureProbe,
} from '../lib/flow-kernel.js';
import {
  FLOW_MAGNITUDE_CALL_GLSL,
  FLOW_MATRIX_TEXTURE_RECIPE,
  FLOW_MATRIX_UNIFORMS_GLSL,
  FLOW_NAMES,
  FLOW_RIBBON_ATTRIBUTES_GLSL,
  FLOW_WIDTH_GLSL,
  buildFlowMatrixSampler,
  flowSamplerCacheKey,
  flowWidthJS,
  type FlowMatrixFormat,
} from '../shaders/flow.glsl.js';
import {
  TIME_CUMULATIVE_GLSL,
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE,
  TIME_TRAIL_GLSL,
  TIME_WAKE_GLSL,
  TIME_WINDOW_GLSL,
  resolveTimeUniformLocations,
  resolveWakeTailScaleUniformLocation,
  type TimeUniformLocations,
  type WakeTailScaleUniformLocation,
} from '../shaders/time-window.glsl.js';
import { POSITION_DEQUANT_GLSL } from '../shaders/position-quantization.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  expandFilterValues,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type FilterTransformSizeUniformLocation,
} from '../shaders/data-filter.glsl.js';
import {
  lngLatToMercatorInto,
  metersToMercatorUnits,
  quantizePositionsToUint16,
  tileCenterLatitude,
} from '../lib/projection.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this family's name.
 *
 * A flow archive's corridors span the WHOLE time range (their
 * `[startTime, endTime]` is the tile's range, which is what makes the value
 * matrix meaningful), so the default `window` mode never hides the network —
 * exactly the guarantee deck's `timeBoundsForSublayer` hand-restores. The other
 * three exist for archives that DO carry per-reach lifetimes (a channel that
 * opens mid-run, a levee breach).
 */
export type FlowCorridorTimeFilterMode = STTTimeFilterMode;

/** Where the vertex stage reads a reach's magnitude from. */
export type FlowMagnitudeSource = 'texture' | 'attribute';

/** deck `FlowStrokeLayer` defaults, mirrored so a port reads identically. */
const DEFAULT_WIDTH_EXPONENT = 0.5;
const DEFAULT_WIDTH_SCALE = 1;
const DEFAULT_MIN_FLOW = 0;
const DEFAULT_WIDTH_MIN = 0;
/**
 * Upper width clamp when the caller sets none. A finite number rather than
 * `Infinity` so the uniform stays a plain float on every driver; 1e6 pixels is
 * ~15 screens wide at any dpr, i.e. "no clamp" in practice.
 */
const DEFAULT_WIDTH_MAX = 1e6;
/** deck's `FlowStrokeLayer.offsetWidths` default (twin-ribbon separation). */
const DEFAULT_OFFSET_WIDTHS = 0.6;
/** Miter cap: past this a hairpin bevels instead of spiking. */
const DEFAULT_MITER_LIMIT = 4;

/** Corridor palette shared with the deck line/trips family. */
const DEFAULT_CORRIDOR_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_LINE_PALETTE;

/**
 * Colour-ramp stops the shader declares. FIXED at compile time so the ramp
 * costs no program permutation: the live stop count rides `uFlowRampCount`, and
 * the lookup loop is constant-bounded (GLSL ES 1.00 requires a constant loop
 * bound; dynamic indexing of a uniform array is legal in the VERTEX stage,
 * which is where every flow computation happens).
 */
export const FLOW_RAMP_STOPS = 8;

// Immutable stand-in for callers with no host frame (hand-built test
// DrawContexts that omit `frame`). Never mutated — only normalizeRenderArgs
// mutates frames, and it never sees this one.
const LEGACY_FRAME: HostFrame = createHostFrame();

// Hoisted uniform fallbacks: a cache whose positions skipped quantization would
// otherwise allocate these every draw.
const IDENTITY_POS_SCALE: readonly number[] = [1, 1, 1];
const ZERO_POS_OFFSET: readonly number[] = [0, 0, 0];

// ── CPU references the shaders mirror (unit-tested) ─────────────────────────

/**
 * Mercator units per ONE unit of corridor width — the CPU half of the ribbon's
 * ground-anchored sizing, and the whole reason `widthUnits` costs no shader
 * variant (`uWidthToMercator`).
 *
 *  - `'pixels'` (default): the inverse of maplibre's `512 · 2^zoom · dpr`
 *    DEVICE-pixel world, so a corridor holds its on-screen width. The DEVICE
 *    ratio is REQUIRED — maplibre's world is CSS pixels while every other pixel
 *    in this package (`gl_PointSize`, `uViewport`, `metersToPixelsAtLatitude`)
 *    is a device pixel, and dropping it makes a Retina corridor draw 2× the
 *    width of an equally-specified line beside it.
 *  - `'meters'`: the latitude-correct `metersToMercatorUnits` factor at the
 *    tile's centre latitude, so a corridor covers a fixed patch of ground.
 *
 * Constant-on-screen (`'pixels'`) is exact only for an UNPITCHED map: the
 * conversion is a world-space scale resolved once per tile, so under pitch a
 * ribbon near the horizon keeps its centre-of-view width. That is the correct
 * trade for a GROUND ribbon — see the module header.
 */
export function resolveCorridorWidthScale(
  widthUnits: 'pixels' | 'meters',
  latitudeDeg: number,
  zoom: number,
  devicePixelRatio = 1,
): number {
  return widthUnits === 'meters'
    ? metersToMercatorUnits(1, latitudeDeg)
    : mercatorPerPixel(zoom, 512 * devicePixelRatio);
}

/** Width-chain inputs shared by the shader and {@link corridorHalfWidthMercator}. */
export interface CorridorWidthParams {
  minFlow: number;
  widthScale: number;
  widthExponent: number;
  /** `[min, max]` in `widthUnits`; applied to ACTIVE corridors only. */
  widthClamp: ArrayLike<number>;
  /** {@link resolveCorridorWidthScale} for this tile + frame. */
  widthToMercator: number;
}

/**
 * JS twin of the shader's full width chain:
 * `sttFlowWidth(magnitude, …) * 0.5 * uWidthToMercator`.
 *
 * A corridor at or below `minFlow` returns 0 — both ribbon vertices then sit ON
 * the path, every triangle is degenerate and the reach is INVISIBLE, which is
 * the animation. Used by the parity tests, and by any CPU-side question about
 * what the GPU is drawing (a legend, a hover readout, a hit test).
 */
export function corridorHalfWidthMercator(
  magnitude: number,
  p: CorridorWidthParams,
): number {
  const w = flowWidthJS(
    magnitude,
    p.minFlow,
    p.widthScale,
    p.widthExponent,
    p.widthClamp,
  );
  return w * 0.5 * p.widthToMercator;
}

/**
 * JS twin of `sttFlowRampColor`: linear interpolation across `count` stops of a
 * {@link FLOW_RAMP_STOPS}-slot ramp at `t ∈ [0, 1]`. `stops` is the flat RGBA
 * uniform payload (0–1 floats, `FLOW_RAMP_STOPS * 4` long); the result is
 * written into `out` and returned, so the CPU path allocates nothing either.
 */
export function sampleFlowRampJS(
  out: [number, number, number, number],
  stops: ArrayLike<number>,
  count: number,
  t: number,
): [number, number, number, number] {
  const last = Math.max(count - 1, 0);
  const x = Math.min(Math.max(t, 0), 1) * last;
  const i0 = Math.floor(x);
  const f = x - i0;
  const a = i0 * 4;
  const b = Math.min(i0 + 1, last) * 4;
  for (let c = 0; c < 4; c++) {
    out[c] = stops[a + c] * (1 - f) + stops[b + c] * f;
  }
  return out;
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set. Exported
 * for the prop-default tests; identical rule to the column/point layers'.
 */
export function resolveFlowCorridorTimeFilterMode(
  mode: FlowCorridorTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): FlowCorridorTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

// ── options ─────────────────────────────────────────────────────────────────

export interface STTFlowCorridorLayerOptions extends STTFilterableLayerOptions {
  /**
   * Corridor colour when no ramp / categorical column drives it. Accepts 0–255
   * ints (the deck convention, and what `colorPalette` uses) OR 0–1 floats —
   * the range is auto-detected.
   * @default [45, 140, 255, 255]
   */
  color?: [number, number, number, number];
  /**
   * MAGNITUDE → colour ramp, 2–{@link FLOW_RAMP_STOPS} stops of 0–255 RGBA
   * (0–1 floats also accepted). Sampled at
   * `sttFlowRampT(magnitude, rampDomain, rampGamma)`, i.e. the SAME magnitude
   * that sets the width — this is the "drives width and colour" half of the
   * family. Unset ⇒ no ramp is compiled and {@link color} /
   * {@link colorProperty} own the colour.
   */
  colorRamp?: ReadonlyArray<RGBA8>;
  /** `[lo, hi]` magnitude mapped onto the ramp's 0..1. @default [0, 1] */
  rampDomain?: readonly [number, number];
  /**
   * Ramp shaping exponent: `<= 0` is linear, `0.5` lifts the low end (what a
   * long-tailed discharge distribution usually wants), `2` crushes it.
   * @default 0
   */
  rampGamma?: number;
  /** Drive per-reach colour from a categorical column name (ignored under {@link colorRamp}). */
  colorProperty?: string;
  /** Palette (0–255 RGBA) sampled by category index when {@link colorProperty} is set. */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA map (deck/three `colorMapping` parity):
   * a category renders the SAME colour in every tile regardless of per-tile
   * dictionary order. Unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional palette.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /**
   * Width multiplier applied to `magnitude ** widthExponent`, in
   * {@link widthUnits}.
   * @default 1
   */
  widthScale?: number;
  /**
   * Width exponent. `0.5` (√) is area-proportional and the cartographic
   * default; lower flattens the busy/quiet contrast, higher exaggerates it.
   * @default 0.5
   */
  widthExponent?: number;
  /**
   * Corridors whose live magnitude is at or below this render at width 0 —
   * INVISIBLE, which is the per-timestep pulse. The width clamp below applies
   * to ACTIVE corridors only, so {@link widthMin} never resurrects a dead one.
   * @default 0
   */
  minFlow?: number;
  /** Lower width clamp for ACTIVE corridors, in {@link widthUnits}. @default 0 */
  widthMin?: number;
  /** Upper width clamp, in {@link widthUnits}. @default 1e6 (effectively none) */
  widthMax?: number;
  /**
   * Unit for every width knob above. `'pixels'` (DEVICE pixels, the package
   * convention) holds on-screen width; `'meters'` is ground-metric at the
   * tile's centre latitude. See {@link resolveCorridorWidthScale}.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters';
  /**
   * STATIC per-reach width multiplier from a baked numeric column (a stream
   * order, a channel capacity). Folded into the ribbon's extrusion at UPLOAD —
   * it is a shape knob, not an animated one, so changing it rebuilds the tile
   * caches. Applied AFTER the width clamp: the clamp bounds the
   * magnitude-driven width, the profile scales the result.
   */
  widthProperty?: string;
  /**
   * Constant perpendicular offset in multiples of the corridor's LIVE width —
   * the twin-ribbon separation. `0` (the corridor default) centres the ribbon
   * on the path; {@link STTFlowStrokeLayer} defaults it to 0.6 so a directed
   * pair sharing a street sits side by side and the gap breathes with the flow.
   * @default 0
   */
  offsetWidths?: number;
  /**
   * The value matrix is SIGNED (STT's per-bucket-direction archives): the sign
   * is travel direction and `|value|` is the volume. Packs `|v|`, because width
   * and colour want the volume and blending signed values would dip through
   * zero at a direction flip.
   * @default false
   */
  signedFlow?: boolean;
  /**
   * Explicit `[min, max]` for the portable `unorm16` fixed-point packing. Pass a
   * DATASET-wide range when several tiles must decode identically; omitted, each
   * tile packs against its own min/max (which is exact, because the decode
   * uniforms travel with the tile's texture). Ignored on the `float32` path.
   */
  valueRange?: readonly [number, number];
  /**
   * Cap on miter lengthening at a sharp bend, in multiples of the width.
   * A shape knob: changing it rebuilds the tile caches.
   * @default 4
   */
  miterLimit?: number;
  /**
   * Time-filter mode. Unset ⇒ inferred in deck's precedence order
   * (`wakeLength > 0` ⇒ wake, else `trailLength > 0` ⇒ trail, else window).
   * COMPILE-TIME and fixed for the layer's lifetime.
   *
   * A flow archive's reaches span the whole range, so the default `window` never
   * hides the network however narrow `timeWindow` is.
   */
  timeFilterMode?: FlowCorridorTimeFilterMode;
  /** `wake` mode: ms a reach stays lit after its own start time. @default 0 */
  wakeLength?: number;
  /** `wake` mode trailing-edge width multiplier (head = 1.0). @default 0.15 */
  wakeTailScale?: number;
  /** `trail` mode: ms a reach stays lit after its start time. @default 0 */
  trailLength?: number;
  /**
   * `trail` mode head→tail fade: `1`/`true` (default) fades across
   * `trailLength`, `0`/`false` holds full alpha, intermediate numbers blend
   * (package-wide `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
}

/** {@link STTFlowStrokeLayer} accepts the corridor surface verbatim. */
export type STTFlowStrokeLayerOptions = STTFlowCorridorLayerOptions;

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled corridor program supports. Every knob is structural (each
 * adds uniforms / attributes / statements), so each combination is its own
 * program and each must appear in the cache key — {@link flowCorridorProgramKey}.
 */
export interface FlowCorridorShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: FlowCorridorTimeFilterMode;
  /** Value-matrix sampler vs. the CPU-expanded attribute. */
  magnitude: FlowMagnitudeSource;
  /** Matrix storage format — a sampler permutation (`'texture'` only). */
  format: FlowMatrixFormat;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
  /** Compile the magnitude → colour ramp. */
  ramp: boolean;
}

/** The out-of-the-box configuration: window mode, GPU sampler, no extras. */
const DEFAULT_SHADER_CONFIG: FlowCorridorShaderConfig = Object.freeze({
  mode: 'window',
  magnitude: 'texture',
  format: 'float32',
  filter: false,
  ramp: false,
});

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<FlowCorridorTimeFilterMode, string>> =
  Object.freeze({
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  });

/**
 * The `vAlpha = …` expression per mode. Every ribbon vertex carries its REACH's
 * `aTime`, so `trail` reads `aTime.x` — a corridor reveals whole (the
 * per-VERTEX trail is `STTTripsLayer`'s job, and a corridor has no travel
 * direction in time).
 */
const MODE_ALPHA: Readonly<Record<FlowCorridorTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
  });

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');
const RIBBON_ATTRIBUTES = FLOW_RIBBON_ATTRIBUTES_GLSL.replace(/^\n/, '');
const MATRIX_UNIFORMS = FLOW_MATRIX_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * Magnitude → colour ramp. Declared with the uniforms it reads so a layer
 * splices one block; the loop bound is the compile-time {@link FLOW_RAMP_STOPS}
 * (GLSL ES 1.00 forbids a dynamic bound) while the LIVE stop count rides
 * `uFlowRampCount`, so changing a ramp's length never relinks a program.
 *
 * At the top of the domain `i0` lands on the last stop and `f` is exactly 0, so
 * the unmatched `c1` (left at stop 0) is multiplied out rather than wrapping the
 * ramp around.
 *
 * EXTRACTION CANDIDATE: the GPU palette sampler the summary/hexbin family will
 * want too — `shaders/flow.glsl.ts` ships the ramp POSITION (`sttFlowRampT`) but
 * no colour lookup. Left private until a second caller exists.
 */
const FLOW_RAMP_GLSL = `
  uniform vec4 uFlowRamp[${FLOW_RAMP_STOPS}];
  uniform float uFlowRampCount;
  uniform vec2 uFlowRampDomain;
  uniform float uFlowRampGamma;
`;

const FLOW_RAMP_FN_GLSL = `
vec4 sttFlowRampColor(float t) {
  float last = max(uFlowRampCount - 1.0, 0.0);
  float x = clamp(t, 0.0, 1.0) * last;
  float i0 = floor(x);
  float f = x - i0;
  vec4 c0 = uFlowRamp[0];
  vec4 c1 = uFlowRamp[0];
  for (int i = 0; i < ${FLOW_RAMP_STOPS}; i++) {
    float fi = float(i);
    if (fi == i0) c0 = uFlowRamp[i];
    if (fi == i0 + 1.0) c1 = uFlowRamp[i];
  }
  return mix(c0, c1, f);
}
`;

/**
 * DataFilter application, shared by both passes. Deck's split: a HARD-filtered
 * reach (`0`) is hidden whatever the transform flags say, while a soft-margin
 * value only fades / thins when its flag is on. `DECKGL_FILTER_SIZE` maps onto
 * the corridor's WIDTH, which is the only size this kind has.
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) {
      width *= filterAlpha;
    }
`;

/**
 * Assemble a corridor vertex shader.
 *
 * Legacy hosts (empty prelude) keep the `uMatrix` path; v5+ hosts get the
 * injected prelude + define prepended (maplibre's documented order) and project
 * through `projectTile(vec2)`, which owns horizon clipping on globe. The ribbon
 * is a GROUND surface, so there is no elevation term and no
 * `projectTileFor3D` — see the module header.
 *
 * The two passes share ONE builder rather than forking the width maths: a hit
 * area that drifted from the drawn ribbon is exactly the bug an id-buffer picker
 * cannot detect from the CPU side. `kind: 'id'` swaps the colour payload for the
 * encoded id and folds the colour's ALPHA into `vAlpha`, so a corridor painted
 * transparent (a `colorMapping` entry with alpha 0, a ramp stop that fades out)
 * is invisible AND unpickable — deck's `picking_filterPickingColor` discards on
 * the same condition.
 */
function buildFlowCorridorVs(
  shader: ShaderInjection,
  cfg: FlowCorridorShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isId = kind === 'id';
  const legacyMatrix = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const project = usesPrelude
    ? 'projectTile(posM)'
    : 'uMatrix * vec4(posM, 0.0, 1.0)';

  const useTexture = cfg.magnitude === 'texture';
  // Only the active source's declarations exist, so an unused sampler can never
  // be silently mis-bound and the CPU path costs no texture unit at all.
  const magnitudeDecls = useTexture
    ? MATRIX_UNIFORMS
    : `  attribute float aFlowMagnitude;  // CPU-expanded magnitude (no vertex texture fetch)\n`;
  const sampler = useTexture
    ? buildFlowMatrixSampler({ format: cfg.format })
    : '';
  const magnitudeExpr = useTexture
    ? FLOW_MAGNITUDE_CALL_GLSL
    : 'aFlowMagnitude';

  // Wake narrows the tail with the SAME alpha the kernel returned, so the
  // thinning and the fade cannot drift apart (deck's DECKGL_FILTER_SIZE wake).
  const wakeSize =
    cfg.mode === 'wake'
      ? '    width *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';

  const colorDecls = isId
    ? '  attribute vec3 aIdColor;     // per-vertex encoded pick id (UNSIGNED_BYTE normalized)\n  varying vec3 vIdColor;\n'
    : '  varying vec4 vColor;\n';
  // The categorical attribute is declared in BOTH passes: the visual one paints
  // with it, the id one reads only its alpha.
  const categoricalDecls =
    '  attribute vec4 aColor;       // per-vertex RGBA in 0..1 (constant fallback when uUseFeatureColor=0)\n  uniform float uUseFeatureColor;\n  uniform vec4 uColor;\n';
  const rampDecls = cfg.ramp ? FLOW_RAMP_GLSL : '';

  // One colour resolution, used by both passes — the visual pass emits it, the
  // id pass multiplies its alpha into the gate. Two spellings here would be two
  // places for "invisible ⇒ unpickable" to drift.
  const colorResolve = cfg.ramp
    ? `    vec4 flowColor = sttFlowRampColor(sttFlowRampT(magnitude, uFlowRampDomain, uFlowRampGamma));\n`
    : `    vec4 flowColor = (uUseFeatureColor > 0.5) ? aColor : uColor;\n`;
  const colorAssign = isId
    ? '    vAlpha *= flowColor.a;\n    vIdColor = aIdColor;\n'
    : '    vColor = flowColor;\n';

  return `${head}
  precision highp float;
  attribute vec3 aMercator;    // ribbon vertex, per-tile-local UNSIGNED_SHORT — see sttDecodeMercatorPos
  attribute vec2 aTime;        // this reach's [startTime, endTime], tile-relative
${RIBBON_ATTRIBUTES}${cfg.filter ? FILTER_ATTRIBUTE : ''}${categoricalDecls}${colorDecls}${legacyMatrix}${magnitudeDecls}${rampDecls}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uFlowHasValues;  // 0 ⇒ this tile carries no value channel
  uniform float uFlowConstant;   // magnitude used when it doesn't
  uniform float uMinFlow;
  uniform float uWidthScale;
  uniform float uWidthExponent;
  uniform vec2 uWidthClamp;      // [min, max] in widthUnits, ACTIVE corridors only
  uniform float uWidthToMercator;// widthUnits → mercator (resolveCorridorWidthScale)
  uniform float uOffsetWidths;   // twin-ribbon separation, in live widths
${TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${MODE_GLSL[cfg.mode]}${POSITION_DEQUANT_GLSL}${sampler}${FLOW_WIDTH_GLSL}${cfg.ramp ? FLOW_RAMP_FN_GLSL : ''}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vec3 base = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    vAlpha = ${MODE_ALPHA[cfg.mode]};
    float magnitude = (uFlowHasValues > 0.5) ? ${magnitudeExpr} : uFlowConstant;
    float width = sttFlowWidth(magnitude, uMinFlow, uWidthScale, uWidthExponent, uWidthClamp);
${wakeSize}${cfg.filter ? FILTER_BODY : ''}    // Below the flow threshold the ribbon collapses onto its own centre line:
    // every triangle is degenerate AND the fragment stage discards, so a dead
    // corridor costs no pixels and is not a pick target.
    if (!(width > 0.0)) vAlpha = 0.0;
    float halfM = width * 0.5 * uWidthToMercator;
    // aFlowExtrusion is the SIGNED miter (opposite signs on the two edges) and
    // aFlowSide is ±1, so their product is one consistent side of travel — the
    // direction a twin ribbon is pushed along.
    vec2 offsetM = aFlowExtrusion * aFlowSide * (uOffsetWidths * width * uWidthToMercator);
    vec2 posM = base.xy + aFlowExtrusion * halfM + offsetM;
${colorResolve}${colorAssign}    gl_Position = ${project};
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
  }
`;
}

/** Visual corridor vertex source for a host variant + feature configuration. */
export function buildFlowCorridorVertexSource(
  shader: ShaderInjection,
  cfg: FlowCorridorShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildFlowCorridorVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildFlowCorridorVertexSource}. */
export function buildFlowCorridorIdVertexSource(
  shader: ShaderInjection,
  cfg: FlowCorridorShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildFlowCorridorVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `STTBaseLayer.getOrCreateProgram` appends `::${variantName}` (the HOST
 * variant) only, so two configurations sharing a base key would collide on one
 * program. The magnitude source rides `flowSamplerCacheKey` exactly as the flow
 * kernel prescribes.
 */
export function flowCorridorProgramKey(
  pass: 'main' | 'pick',
  cfg: FlowCorridorShaderConfig,
): string {
  const sampler =
    cfg.magnitude === 'texture' ? flowSamplerCacheKey(cfg.format) : 'flow-cpu';
  return `flow-corridor:${pass}:${cfg.mode}:${sampler}${cfg.filter ? ':filter' : ''}${cfg.ramp ? ':ramp' : ''}`;
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

/**
 * Id-pick fragment stage. No blending and no antialiasing: the readback must
 * recover the byte triple exactly. The `vAlpha` discard is what makes
 * time-filtered, DataFilter-hidden, below-threshold and transparent corridors
 * unpickable.
 */
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // invisible corridors are not pickable
    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;

// ── program handles ─────────────────────────────────────────────────────────

/**
 * Locations a corridor program declares. Resolved once per program; absent
 * uniforms come back null (a no-op for `gl.uniform*`) and absent attributes come
 * back -1, which is exactly how a configuration that doesn't declare them reads.
 */
interface FlowCorridorHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aMercator: number;
  aTime: number;
  aFlowRow: number;
  aFlowExtrusion: number;
  aFlowSide: number;
  aFlowMagnitude: number;
  aColor: number;
  aFilterValue: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uFlowMatrix: WebGLUniformLocation | null;
  uFlowMatrixSize: WebGLUniformLocation | null;
  uFlowMatrixDims: WebGLUniformLocation | null;
  uFlowValueScale: WebGLUniformLocation | null;
  uFlowBucket: WebGLUniformLocation | null;
  uFlowHasValues: WebGLUniformLocation | null;
  uFlowConstant: WebGLUniformLocation | null;
  uMinFlow: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uWidthExponent: WebGLUniformLocation | null;
  uWidthClamp: WebGLUniformLocation | null;
  uWidthToMercator: WebGLUniformLocation | null;
  uOffsetWidths: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uFlowRamp: WebGLUniformLocation | null;
  uFlowRampCount: WebGLUniformLocation | null;
  uFlowRampDomain: WebGLUniformLocation | null;
  uFlowRampGamma: WebGLUniformLocation | null;
}

/** Host capabilities that decide the magnitude path. Probed once per context. */
interface FlowCaps {
  webgl2: boolean;
  source: FlowMagnitudeSource;
  format: FlowMatrixFormat;
  maxTextureSize: number;
}

/** Per-tile GPU state, on top of the standard {@link TileGpuCache}. */
interface FlowGpuCache extends TileGpuCache {
  /**
   * The key this cache is filed under in the base `tileGpuCache`. Read ONLY by
   * {@link STTFlowCorridorLayer.sweepEvictedTextures}, which needs an O(1),
   * allocation-free liveness test for the tile textures the base's
   * buffer-oriented eviction cannot free.
   */
  cacheKey: string;
  /** Ribbon vertices contributed by each REACH — pick-id / filter expansion. */
  ribbonCounts: Uint32Array;
  featureCount: number;
  /** `gl.UNSIGNED_INT` or `gl.UNSIGNED_SHORT`, matching `indexBuffer`. */
  indexType: number;
  extrusionBuffer: WebGLBuffer;
  sideBuffer: WebGLBuffer;
  /** Value-matrix row per ribbon vertex — `'texture'` source only. */
  rowBuffer?: WebGLBuffer;
  /** CPU-expanded magnitude per ribbon vertex — `'attribute'` source only. */
  magnitudeBuffer?: WebGLBuffer;
  colorBuffer?: WebGLBuffer;
  filterBuffer?: WebGLBuffer;
  hasFilterColumn?: boolean;
  /** The tile's timestep axis; null when it carries no matrix. */
  axis: FlowBucketAxis | null;
  /**
   * The packed matrix. On the `'texture'` path this is a DESCRIPTOR — the
   * lookup metadata `resolveFlowMatrixUniforms` reads, with the payload dropped
   * once the texture owns it (a 50k-vertex × 24-timestep tile is 4.8 MB that
   * nothing would ever read again). On the `'attribute'` path the payload stays,
   * because `expandFlowMagnitudes` re-reads it every sub-step.
   */
  matrix: PackedValueMatrix | null;
  matrixTexture?: WebGLTexture;
  /** CPU rows + scratch — `'attribute'` source only. */
  vertexRows?: Float32Array;
  cpuMagnitudes?: Float32Array;
  /** Last quantized sub-step uploaded to {@link magnitudeBuffer}; NaN = never. */
  cpuStep: number;
  /** Metres → mercator at this tile's centre latitude, resolved at build. */
  mercatorPerMeter: number;
  /**
   * Host shader variant the cached VAO's attribute locations were recorded
   * against. A VAO stores attribute SLOTS, which are per-program — when the host
   * flips variants (mercator ⇄ globe) the relinked program may assign different
   * slots, so the VAO must be rebuilt against it.
   */
  vaoVariant?: string;
}

/** Read a GL enum by NAME — `shaders/flow.glsl.ts` stays GL-free by design. */
function glEnum(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  name: string,
): number {
  return (gl as unknown as Record<string, number>)[name];
}

/**
 * The lookup metadata of a packed matrix without its payload. Everything
 * `resolveFlowMatrixUniforms` reads is here; `data` is emptied so a tile that
 * handed its values to a texture does not also keep them on the heap.
 */
function matrixDescriptor(packed: PackedValueMatrix): PackedValueMatrix {
  return {
    ...packed,
    data: packed.format === 'float32' ? new Float32Array(0) : new Uint8Array(0),
  };
}

/**
 * MapLibre custom layer rendering STT LineString tiles as time-varying flow
 * corridors: static ribbons whose width and colour follow a per-reach value
 * matrix at the live playhead.
 *
 * ```ts
 * const rivers = new STTFlowCorridorLayer({
 *   id: 'nwm',
 *   url: '/data/nwm-rivers.stt',
 *   currentTime: t0,
 *   timeWindow: 6 * 3600_000,
 *   widthScale: 1.6,
 *   widthExponent: 0.5,     // area-proportional
 *   minFlow: 0.5,           // below this a reach is invisible
 *   widthMax: 24,
 *   colorRamp: [
 *     [40, 70, 140, 200],
 *     [60, 160, 220, 230],
 *     [250, 220, 90, 255],
 *     [220, 70, 40, 255],
 *   ],
 *   rampDomain: [0, 120],   // cubic metres per second
 * });
 * rivers.attach(map);
 * ```
 */
export class STTFlowCorridorLayer extends STTFilterableLayer {
  protected readonly flowOpts: {
    color: [number, number, number, number];
    colorRamp?: ReadonlyArray<RGBA8>;
    rampDomain: readonly [number, number];
    rampGamma: number;
    colorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    widthScale: number;
    widthExponent: number;
    minFlow: number;
    widthMin: number;
    widthMax: number;
    widthUnits: 'pixels' | 'meters';
    widthProperty?: string;
    offsetWidths: number;
    signedFlow: boolean;
    valueRange?: readonly [number, number];
    miterLimit: number;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };

  /** Allocated once — the per-draw uniform payload never allocates. */
  private readonly flowUniforms: FlowMatrixUniforms =
    createFlowMatrixUniforms();
  /** `[min, max]` width clamp, refilled in place. */
  private readonly widthClamp = new Float32Array(2);
  /** Flat `FLOW_RAMP_STOPS × RGBA` payload in 0..1, built once from `colorRamp`. */
  private readonly rampStops = new Float32Array(FLOW_RAMP_STOPS * 4);
  private rampCount = 0;

  /**
   * Compiled shader configuration. The mode, filter and ramp axes are fixed for
   * the layer's lifetime; the magnitude source is fixed once the GL context has
   * been probed, so the program keys are built at most twice and the draw path
   * never concatenates a key.
   */
  private shaderConfig: FlowCorridorShaderConfig;
  private programKeys: { main: string; pick: string };

  /** Host capabilities, probed on first tile build (see {@link resolveFlowCaps}). */
  private caps?: FlowCaps;

  /**
   * Globe frames need subdivided tile geometry, but the base render loop
   * resolves caches before drawTile ever sees the frame — beginFrame stashes the
   * flag so ensure/buildTileGpuCache key and build for the CURRENT projection.
   * Also read by the pick path (a pick necessarily follows a render).
   */
  private frameIsGlobe = false;

  /**
   * Handles of the most recently used host variant, memoized per `*Variant` so
   * the per-tile hot path skips the base cache's key-string build; the cache is
   * only consulted on a variant flip.
   */
  private mainHandles?: FlowCorridorHandles;
  private mainVariant?: string;
  private pickHandles?: FlowCorridorHandles;
  private pickVariant?: string;

  /**
   * Tile caches that own a value-matrix TEXTURE. The base's per-tile eviction
   * frees buffers and VAOs but knows nothing about textures, so this layer
   * reconciles them itself — see {@link sweepEvictedTextures}.
   */
  private readonly texturedCaches = new Set<FlowGpuCache>();

  private warnedIndexOverflow = false;

  constructor(opts: STTFlowCorridorLayerOptions) {
    super(opts);
    this.flowOpts = {
      color: opts.color ?? [45, 140, 255, 255],
      colorRamp: opts.colorRamp,
      rampDomain: opts.rampDomain ?? [0, 1],
      rampGamma: opts.rampGamma ?? 0,
      colorProperty: opts.colorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_CORRIDOR_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      widthScale: opts.widthScale ?? DEFAULT_WIDTH_SCALE,
      widthExponent: opts.widthExponent ?? DEFAULT_WIDTH_EXPONENT,
      minFlow: opts.minFlow ?? DEFAULT_MIN_FLOW,
      widthMin: opts.widthMin ?? DEFAULT_WIDTH_MIN,
      widthMax: opts.widthMax ?? DEFAULT_WIDTH_MAX,
      widthUnits: opts.widthUnits ?? 'pixels',
      widthProperty: opts.widthProperty,
      offsetWidths: opts.offsetWidths ?? 0,
      signedFlow: opts.signedFlow ?? false,
      valueRange: opts.valueRange,
      miterLimit: opts.miterLimit ?? DEFAULT_MITER_LIMIT,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.widthClamp[0] = this.flowOpts.widthMin;
    this.widthClamp[1] = this.flowOpts.widthMax;
    this.rampCount = this.loadRamp(opts.colorRamp);
    this.shaderConfig = Object.freeze({
      mode: resolveFlowCorridorTimeFilterMode(
        opts.timeFilterMode,
        this.flowOpts.wakeLength,
        this.flowOpts.trailLength,
      ),
      // Optimistic until the context is probed: a texture-capable host is the
      // overwhelmingly common case, and `applyCaps` relinks (once) if not.
      magnitude: 'texture',
      format: 'float32',
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
      ramp: this.rampCount >= 2,
    });
    this.programKeys = this.buildProgramKeys(this.shaderConfig);
  }

  /**
   * Normalize `colorRamp` into the flat 0..1 uniform payload, returning the stop
   * count actually loaded. Fewer than two stops is not a ramp (there is nothing
   * to interpolate), and stops past {@link FLOW_RAMP_STOPS} are dropped rather
   * than silently resampled — the shader's array is a compile-time size.
   */
  private loadRamp(ramp: ReadonlyArray<RGBA8> | undefined): number {
    if (!ramp || ramp.length < 2) return 0;
    const count = Math.min(ramp.length, FLOW_RAMP_STOPS);
    if (ramp.length > FLOW_RAMP_STOPS) {
      console.warn(
        `[${this.id}] colorRamp has ${ramp.length} stops; only the first ` +
          `${FLOW_RAMP_STOPS} are used`,
      );
    }
    for (let i = 0; i < count; i++) {
      const c = ramp[i];
      // 0–255 ints vs 0–1 floats, auto-detected exactly as `toRgba01` does.
      const k = c[0] > 1 || c[1] > 1 || c[2] > 1 || c[3] > 1 ? 1 / 255 : 1;
      for (let j = 0; j < 4; j++) this.rampStops[i * 4 + j] = c[j] * k;
    }
    return count;
  }

  private buildProgramKeys(cfg: FlowCorridorShaderConfig): {
    main: string;
    pick: string;
  } {
    return {
      main: flowCorridorProgramKey('main', cfg),
      pick: flowCorridorProgramKey('pick', cfg),
    };
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.LineString;
  }

  // ── runtime setters ───────────────────────────────────────────────────────

  /** Update the constant corridor colour (0–1 floats or 0–255 ints). Uniform-only. */
  setColor(color: [number, number, number, number]): void {
    this.flowOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Move the width multiplier. Uniform-only — no relink, no tile rebuild. */
  setWidthScale(scale: number): void {
    this.flowOpts.widthScale = scale;
    this.map?.triggerRepaint();
  }

  /**
   * Move the "invisible below this" threshold — the knob that decides which
   * corridors are lit at all. Uniform-only.
   */
  setMinFlow(minFlow: number): void {
    this.flowOpts.minFlow = minFlow;
    this.map?.triggerRepaint();
  }

  /** Move the `[min, max]` width clamp, in `widthUnits`. Uniform-only. */
  setWidthClamp(min: number, max: number): void {
    this.flowOpts.widthMin = min;
    this.flowOpts.widthMax = max;
    this.widthClamp[0] = min;
    this.widthClamp[1] = max;
    this.map?.triggerRepaint();
  }

  /** Move the magnitude window the colour ramp spans. Uniform-only. */
  setRampDomain(domain: readonly [number, number]): void {
    this.flowOpts.rampDomain = domain;
    this.map?.triggerRepaint();
  }

  /**
   * Move the twin-ribbon separation, in multiples of the LIVE width.
   * Uniform-only — the offset term is always compiled, so a corridor layer can
   * become a stroke layer at runtime and back.
   */
  setOffsetWidths(offsetWidths: number): void {
    this.flowOpts.offsetWidths = offsetWidths;
    this.map?.triggerRepaint();
  }

  /**
   * Replace the STATIC per-reach width profile column. This is a SHAPE knob —
   * the profile is folded into the ribbon's extrusion at upload — so it rebuilds
   * the tile caches. The animated magnitude never goes through here.
   */
  setWidthProperty(property: string | undefined): void {
    if (this.flowOpts.widthProperty === property) return;
    this.flowOpts.widthProperty = property;
    this.rebuildTileCaches();
  }

  // ── GL lifecycle ──────────────────────────────────────────────────────────

  protected beginFrame(
    matrixOrArgs: unknown,
    options?: unknown,
  ): HostFrame | null {
    const frame = super.beginFrame(matrixOrArgs, options);
    if (frame) this.frameIsGlobe = frame.isGlobe;
    return frame;
  }

  /**
   * The base render loop plus the value-matrix texture reconcile. Textures are
   * the one GPU resource the base's per-tile eviction does not own, so this is
   * where a tile that left the resident set gives its texture back.
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ): void {
    super.render(gl, matrixOrArgs, options);
    this.sweepEvictedTextures(gl);
  }

  protected onContextReady(): void {
    // Programs are linked lazily, one per host shader variant, through the base
    // getOrCreateProgram cache — nothing to allocate eagerly. The magnitude
    // source is probed on the first tile build, where a `gl` is in hand.
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Program lifetimes are owned by the base per-variant cache (deleted on
    // dispose, dropped on context loss — both before this hook runs); the
    // handles and the value-matrix textures are ours. Deletes on an
    // already-lost context are silently ignored, which is exactly the
    // reference-release this needs.
    this.mainHandles = undefined;
    this.mainVariant = undefined;
    this.pickHandles = undefined;
    this.pickVariant = undefined;
    this.releaseAllTextures(gl);
    // Extensions and caps do not survive a restore.
    this.caps = undefined;
  }

  /**
   * Drop every per-tile cache, freeing the value-matrix textures first — the
   * base clears its map without knowing they exist.
   */
  protected rebuildTileCaches(): void {
    this.releaseAllTextures(this.gl);
    super.rebuildTileCaches();
  }

  private releaseAllTextures(
    gl?: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    for (const cache of this.texturedCaches) {
      if (gl && cache.matrixTexture) gl.deleteTexture(cache.matrixTexture);
      cache.matrixTexture = undefined;
    }
    this.texturedCaches.clear();
  }

  /**
   * Free the value-matrix texture of every cache the base has evicted.
   *
   * Liveness is an O(1) map lookup per TEXTURED tile (tens, not thousands) keyed
   * by the cache's own `cacheKey`, and the identity check catches a rebuild that
   * reused the key — so the sweep allocates nothing and can safely run every
   * frame. A size-based trigger would be wrong: evicting one textured tile while
   * two untextured ones load leaves the counts looking healthy.
   */
  private sweepEvictedTextures(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.texturedCaches.size === 0) return;
    for (const cache of this.texturedCaches) {
      if (this.tileGpuCache.get(cache.cacheKey) === cache) continue;
      if (cache.matrixTexture) gl.deleteTexture(cache.matrixTexture);
      cache.matrixTexture = undefined;
      this.texturedCaches.delete(cache);
    }
  }

  // ── host capabilities ─────────────────────────────────────────────────────

  /**
   * Probe (once per context) how this host can deliver magnitudes.
   *
   * WebGL2 guarantees at least 16 vertex texture units; the WebGL1 minimum is
   * ZERO, so a WebGL1 host may legally refuse the GPU path and must fall back to
   * the CPU-expanded attribute. The float-texture probe decides the packing
   * format, which is a sampler permutation — both land in the program key.
   */
  private resolveFlowCaps(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): FlowCaps {
    if (this.caps) return this.caps;
    const webgl2 =
      typeof WebGL2RenderingContext !== 'undefined' &&
      gl instanceof WebGL2RenderingContext;
    const floatTextures = webgl2 || !!gl.getExtension('OES_texture_float');
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const caps: FlowCaps = {
      webgl2,
      source: supportsVertexTextureFetch(gl as unknown as VertexTextureProbe)
        ? 'texture'
        : 'attribute',
      format: chooseFlowMatrixFormat({ webgl2, floatTextures }),
      maxTextureSize:
        typeof maxTexture === 'number' && maxTexture > 0 ? maxTexture : 4096,
    };
    this.caps = caps;
    this.applyCaps(caps);
    return caps;
  }

  /**
   * Fold the probed capabilities into the compiled configuration. Runs at most
   * once per context, BEFORE any program is linked, so a host that turns out to
   * lack vertex texture fetch never compiles (or caches) a sampler it cannot
   * run.
   */
  private applyCaps(caps: FlowCaps): void {
    if (
      this.shaderConfig.magnitude === caps.source &&
      this.shaderConfig.format === caps.format
    ) {
      return;
    }
    this.shaderConfig = Object.freeze({
      ...this.shaderConfig,
      magnitude: caps.source,
      format: caps.format,
    });
    this.programKeys = this.buildProgramKeys(this.shaderConfig);
    this.mainHandles = undefined;
    this.mainVariant = undefined;
    this.pickHandles = undefined;
    this.pickVariant = undefined;
  }

  // ── tile cache ────────────────────────────────────────────────────────────

  /**
   * Cache lookup keyed through the flow kernel's own {@link flowTileKey}, whose
   * whole reason to exist is the contract this family lives by: the key carries
   * the tile, the layer and the GEOMETRY shape — the globe subdivision
   * granularity — and NEVER the playhead. A subdivided globe build lives under
   * its own key so a globe⇄mercator flip reuses either side without a rebuild,
   * and both keys keep the base's `z/x/y/t::` prefix so its unload sweep frees
   * them.
   */
  protected ensureTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): TileGpuCache | null {
    const shape = this.frameIsGlobe
      ? `globe:${this.tileSubdivisionGranularity(tile.id.z)}`
      : '';
    const key = flowTileKey(tile.id, layer.name, shape);
    const existing = this.tileGpuCache.get(key);
    if (existing !== undefined) return existing;
    const cache = this.buildTileGpuCache(gl, tile, layer);
    if (cache) cache.cacheKey = key;
    this.tileGpuCache.set(key, cache);
    return cache;
  }

  /**
   * Tessellate the tile's reaches into ONE merged ribbon and upload everything
   * the animation will ever need. Called once per (tile, geometry shape) and
   * never again — the playhead is not an input here, and any change that made it
   * one would be the deck-side 6 Hz re-tessellation bug reintroduced.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): FlowGpuCache | null {
    const f = layer.features;
    if (!f.positions?.length || !f.startIndices) return null;
    const caps = this.resolveFlowCaps(gl);
    const startIndices = f.startIndices;
    const featureCount = Math.min(f.featureCount, startIndices.length - 1);
    if (featureCount <= 0) return null;
    const dims: 2 | 3 = f.positionDimensions === 3 ? 3 : 2;
    // Rows address ORIGINAL tile vertices (`startIndices[fi] + i`), which is the
    // layout `vertexValueMatrix` is baked in — subdivision snaps interpolated
    // rows back to the nearest integer, so a globe build reads the same texels.
    const originalVertexCount = startIndices[featureCount];
    // 0 ⇒ no subdivision: off-globe both uMatrix and projectTile are affine in
    // mercator, so chords are exact. On globe, chords longer than the host's
    // granularity get horizon-clipped — split at upload time.
    const granularity = this.frameIsGlobe
      ? this.tileSubdivisionGranularity(tile.id.z)
      : 0;

    const widthColumn = this.flowOpts.widthProperty
      ? this.getNumericProperty(f, this.flowOpts.widthProperty)
      : null;

    // Pass 1: one ribbon per reach, so the merged buffer sizes are known before
    // anything is allocated. Tile-upload time only, never per frame.
    const ribbons: (CorridorRibbon | null)[] = new Array(featureCount);
    const ribbonCounts = new Uint32Array(featureCount);
    let vertexTotal = 0;
    let indexTotal = 0;
    for (let fi = 0; fi < featureCount; fi++) {
      const begin = startIndices[fi];
      const count = startIndices[fi + 1] - begin;
      if (count < 2) {
        ribbons[fi] = null;
        continue;
      }
      const merc = new Float64Array(count * 2);
      for (let v = 0; v < count; v++) {
        lngLatToMercatorInto(
          f.positions[(begin + v) * dims],
          f.positions[(begin + v) * dims + 1],
          merc,
          v * 2,
        );
      }
      let profile: Float32Array | undefined;
      if (widthColumn) {
        const w = widthColumn[fi];
        profile = new Float32Array(count);
        profile.fill(Number.isFinite(w) && w > 0 ? w : 1);
      }
      const ribbon = buildCorridorRibbon({
        positions: merc,
        firstRow: begin,
        widthProfile: profile,
        granularity,
        miterLimit: this.flowOpts.miterLimit,
      });
      ribbons[fi] = ribbon;
      if (!ribbon) continue;
      ribbonCounts[fi] = ribbon.vertexCount;
      vertexTotal += ribbon.vertexCount;
      indexTotal += ribbon.triangleCount * 3;
    }
    if (vertexTotal === 0 || indexTotal === 0) return null;
    if (vertexTotal > 65535 && !this.supports32BitIndices) {
      if (!this.warnedIndexOverflow) {
        this.warnedIndexOverflow = true;
        console.warn(
          `[${this.id}] tile needs ${vertexTotal} ribbon vertices but the ` +
            `runtime has no 32-bit element indices (no WebGL2, no ` +
            `OES_element_index_uint); the tile is skipped`,
        );
      }
      return null;
    }

    // Pass 2: merge. Positions go through the package's per-tile UNSIGNED_SHORT
    // quantization like every other geometry here; the width lives entirely in
    // the extrusion attribute, which is what lets one buffer serve every
    // playhead position.
    const positions = new Float32Array(vertexTotal * 3);
    const extrusions = new Float32Array(vertexTotal * 2);
    const sides = new Float32Array(vertexTotal);
    const rows = new Float32Array(vertexTotal);
    const times = new Float32Array(vertexTotal * 2);
    const indices = new Uint32Array(indexTotal);

    const featureColors = this.flowOpts.colorProperty
      ? this.expandCategoricalColors(
          f,
          this.flowOpts.colorProperty,
          this.flowOpts.colorPalette,
          this.flowOpts.colorMapping,
          this.flowOpts.colorMappingDefault,
        )
      : null;
    const colors = featureColors ? new Uint8Array(vertexTotal * 4) : null;

    let vOff = 0;
    let iOff = 0;
    for (let fi = 0; fi < featureCount; fi++) {
      const ribbon = ribbons[fi];
      if (!ribbon) continue;
      const n = ribbon.vertexCount;
      positions.set(ribbon.positions, vOff * 3);
      extrusions.set(ribbon.extrusions, vOff * 2);
      sides.set(ribbon.sides, vOff);
      rows.set(ribbon.rows, vOff);
      const ts = f.startTimes[fi];
      const te = f.endTimes[fi];
      for (let v = 0; v < n; v++) {
        times[(vOff + v) * 2] = ts;
        times[(vOff + v) * 2 + 1] = te;
      }
      if (colors && featureColors) {
        const r = featureColors[fi * 4];
        const g = featureColors[fi * 4 + 1];
        const b = featureColors[fi * 4 + 2];
        const a = featureColors[fi * 4 + 3];
        for (let v = 0; v < n; v++) {
          colors[(vOff + v) * 4] = r;
          colors[(vOff + v) * 4 + 1] = g;
          colors[(vOff + v) * 4 + 2] = b;
          colors[(vOff + v) * 4 + 3] = a;
        }
      }
      const triIdx = ribbon.triangleCount * 3;
      for (let i = 0; i < triIdx; i++)
        indices[iOff + i] = ribbon.indices[i] + vOff;
      vOff += n;
      iOff += triIdx;
    }

    // Range filter: a per-REACH column expanded across the ribbon vertices each
    // reach contributed. A missing / categorical column resolves to
    // `hasColumn: false`, which the uniform resolver turns into `enabled: 0` —
    // an UNFILTERED tile, never a blank one.
    const filterColumn = extractFilterColumn(f, this.filterOpts.filterProperty);
    if (filterColumn.categorical) this.warnCategoricalFilterOnce();
    const filterValues = filterColumn.values
      ? expandFilterValues(filterColumn.values, ribbonCounts, vertexTotal)
      : null;

    // The value matrix, or the STATIC `vertexValues` channel packed as a ONE-
    // column matrix (the sampler's clamp then reads it at every playhead), or
    // nothing at all — in which case `uFlowHasValues` is 0 and the network draws
    // at a constant magnitude rather than vanishing.
    const packOpts = {
      format: caps.format,
      absolute: this.flowOpts.signedFlow,
      valueRange: this.flowOpts.valueRange,
      maxTextureSize: caps.maxTextureSize,
    };
    let packed = packVertexValueMatrix(f, originalVertexCount, packOpts);
    if (
      !packed &&
      f.vertexValues &&
      f.vertexValues.length >= originalVertexCount
    ) {
      packed = packValueMatrix(
        f.vertexValues,
        originalVertexCount,
        1,
        packOpts,
      );
    }

    const { quantized, scale, offset } = quantizePositionsToUint16(positions);
    const positionBuffer = this.uploadArrayBuffer(gl, quantized);
    const timeBuffer = this.uploadArrayBuffer(gl, times);
    const extrusionBuffer = this.uploadArrayBuffer(gl, extrusions);
    const sideBuffer = this.uploadArrayBuffer(gl, sides);
    const indexData = this.supports32BitIndices
      ? indices
      : Uint16Array.from(indices);
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

    const extras: WebGLBuffer[] = [extrusionBuffer, sideBuffer];
    const cache: FlowGpuCache = {
      cacheKey: '',
      positionBuffer,
      posScale: scale,
      posOffset: offset,
      timeBuffer,
      indexBuffer,
      vertexCount: vertexTotal,
      indexCount: indexTotal,
      timeOffset: f.timeOffset,
      indexType: this.supports32BitIndices
        ? gl.UNSIGNED_INT
        : gl.UNSIGNED_SHORT,
      ribbonCounts,
      featureCount,
      extrusionBuffer,
      sideBuffer,
      axis: deriveFlowAxis(f),
      matrix: packed,
      cpuStep: Number.NaN,
      mercatorPerMeter: metersToMercatorUnits(
        1,
        tileCenterLatitude(tile.id.z, tile.id.y),
      ),
      hasFilterColumn: filterColumn.hasColumn,
    };

    if (colors) {
      cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
      extras.push(cache.colorBuffer);
    }
    if (filterValues) {
      cache.filterBuffer = this.uploadArrayBuffer(gl, filterValues);
      extras.push(cache.filterBuffer);
    }

    if (packed && caps.source === 'texture') {
      cache.rowBuffer = this.uploadArrayBuffer(gl, rows);
      extras.push(cache.rowBuffer);
      cache.matrixTexture = this.uploadMatrixTexture(gl, packed, caps);
      this.texturedCaches.add(cache);
      // The texture owns the payload now; keep only the lookup metadata.
      cache.matrix = matrixDescriptor(packed);
    } else if (packed) {
      // CPU fallback: rows stay on the HEAP (they address the matrix, not a
      // vertex attribute) and the magnitudes ride a DYNAMIC buffer refilled on
      // sub-step boundaries. The geometry buffers above are still built once.
      cache.vertexRows = rows;
      cache.cpuMagnitudes = new Float32Array(vertexTotal);
      const magnitudeBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, magnitudeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, cache.cpuMagnitudes, gl.DYNAMIC_DRAW);
      cache.magnitudeBuffer = magnitudeBuffer;
      extras.push(magnitudeBuffer);
    }

    cache.extraBuffers = extras;
    return cache;
  }

  /**
   * Upload one tile's packed matrix. NEAREST + CLAMP_TO_EDGE on both formats:
   * the shader must read exact texels (the interpolation between timesteps is
   * done in GLSL, where it is defined), and a float texture is not linearly
   * filterable without `OES_texture_float_linear` anyway.
   *
   * The pixel-store resets are not defensive tidiness. A host that left
   * `UNPACK_PREMULTIPLY_ALPHA_WEBGL` or `UNPACK_FLIP_Y_WEBGL` enabled would
   * silently corrupt the payload — premultiply zeroes an RGBA fixed-point texel
   * whose alpha is not 255 (why the packer pins alpha), and flip-Y reverses the
   * texel ROW order, which reads the matrix upside down. The guards let a
   * subset-implementing test double through unharmed.
   */
  private uploadMatrixTexture(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    packed: PackedValueMatrix,
    caps: FlowCaps,
  ): WebGLTexture {
    const recipe =
      FLOW_MATRIX_TEXTURE_RECIPE[packed.format][
        caps.webgl2 ? 'webgl2' : 'webgl1'
      ];
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const store = gl as Partial<WebGLRenderingContext>;
    if (typeof store.pixelStorei === 'function') {
      if (store.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== undefined) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
      if (store.UNPACK_FLIP_Y_WEBGL !== undefined) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      if (store.UNPACK_ALIGNMENT !== undefined) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, recipe.unpackAlignment);
      }
    }
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      glEnum(gl, recipe.internalFormat),
      packed.texWidth,
      packed.texHeight,
      0,
      glEnum(gl, recipe.format),
      glEnum(gl, recipe.type),
      packed.data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // ── uniforms ──────────────────────────────────────────────────────────────

  /**
   * The continuous timestep position for this frame — THE per-frame value, and
   * the only thing about a corridor that moves. A tile with no axis (static
   * values, or none) pins at column 0, which its one-column matrix reads
   * regardless.
   */
  private bucketFor(cache: FlowGpuCache, ctx: DrawContext): number {
    return cache.axis ? bucketPositionAt(cache.axis, ctx.currentTime) : 0;
  }

  /**
   * Width units → mercator for this tile and frame. Resolved at the TILE
   * CENTRE's latitude and the map's FRACTIONAL zoom (so a pixel width does not
   * step at integer zooms) and across the DEVICE-pixel ratio (memoized in the
   * base — this runs once per tile per frame).
   */
  private resolveWidthToMercator(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    cache: FlowGpuCache,
    ctx: DrawContext,
  ): number {
    if (this.flowOpts.widthUnits === 'meters') return cache.mercatorPerMeter;
    const zoom = this.frameZoom ?? this.map?.getZoom() ?? ctx.zoom;
    return mercatorPerPixel(zoom, 512 * this.resolveDevicePixelRatio(gl));
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active mode's
   * uniforms exist in the program, so the switch is also what keeps a stale
   * mode's uniform from being written to a null location every draw.
   * `uCurrentTime` follows the package convention: absolute time minus the
   * tile's own `timeOffset`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowCorridorHandles,
    cache: FlowGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.flowOpts;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
        gl.uniform1f(h.uWakeTailScale, o.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uTrailLength, o.trailLength);
        gl.uniform1f(h.uFadeTrail, o.fadeTrail);
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
   * Everything the visual and id passes set identically — projection, the width
   * chain, the flow matrix + bucket, the time mode and the DataFilter — so the
   * pickable ribbon is always the drawn ribbon, including on globe where the
   * prelude owns projection.
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowCorridorHandles,
    cache: FlowGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    const o = this.flowOpts;
    gl.uniform3fv(h.uPosScale, cache.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, cache.posOffset ?? ZERO_POS_OFFSET);
    gl.uniform1f(h.uMinFlow, o.minFlow);
    gl.uniform1f(h.uWidthScale, o.widthScale);
    gl.uniform1f(h.uWidthExponent, o.widthExponent);
    gl.uniform2fv(h.uWidthClamp, this.widthClamp);
    gl.uniform1f(
      h.uWidthToMercator,
      this.resolveWidthToMercator(gl, cache, ctx),
    );
    gl.uniform1f(h.uOffsetWidths, o.offsetWidths);
    gl.uniform1f(h.uFlowConstant, 1);
    gl.uniform1f(h.uFlowHasValues, cache.matrix ? 1 : 0);
    this.setMagnitudeState(gl, h, cache, ctx);
    this.setTimeUniforms(gl, h, cache, ctx);
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn === true);
    }
    if (this.shaderConfig.ramp) {
      gl.uniform4fv(h.uFlowRamp, this.rampStops);
      gl.uniform1f(h.uFlowRampCount, this.rampCount);
      gl.uniform2f(
        h.uFlowRampDomain,
        this.flowOpts.rampDomain[0],
        this.flowOpts.rampDomain[1],
      );
      gl.uniform1f(h.uFlowRampGamma, this.flowOpts.rampGamma);
    }
  }

  /**
   * Point the magnitude source at this frame's playhead.
   *
   * On the GPU path that is: bind the tile's texture, push its three lookup
   * uniforms (they belong to the TILE — a `unorm16` decode from tile A applied
   * to tile B's texture is a silent value error) and one scalar bucket. Nothing
   * else, ever.
   *
   * On the CPU path the same playhead is quantized to `CPU_FALLBACK_SUB_STEP`
   * and, only when it CROSSES a sub-step, the magnitudes are re-expanded into
   * the tile's own reusable scratch and pushed with `bufferSubData`. The vertex
   * buffers are not touched either way.
   */
  private setMagnitudeState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowCorridorHandles,
    cache: FlowGpuCache,
    ctx: DrawContext,
  ): void {
    const packed = cache.matrix;
    if (!packed) return;
    const bucket = this.bucketFor(cache, ctx);
    if (this.shaderConfig.magnitude === 'texture') {
      if (!cache.matrixTexture) return;
      // The three array uniforms belong to the TILE (they travel with the bound
      // texture); `bucket` belongs to the FRAME — resolve both together.
      const u = resolveFlowMatrixUniforms(this.flowUniforms, packed, bucket);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cache.matrixTexture);
      gl.uniform1i(h.uFlowMatrix, 0);
      gl.uniform4fv(h.uFlowMatrixSize, u.texSize);
      gl.uniform2fv(h.uFlowMatrixDims, u.dims);
      gl.uniform2fv(h.uFlowValueScale, u.valueScale);
      gl.uniform1f(h.uFlowBucket, u.bucket);
      return;
    }
    if (!cache.magnitudeBuffer || !cache.cpuMagnitudes || !cache.vertexRows) {
      return;
    }
    const step = quantizeBucketPosition(bucket, CPU_FALLBACK_SUB_STEP);
    if (step === cache.cpuStep) return;
    cache.cpuStep = step;
    expandFlowMagnitudes(cache.cpuMagnitudes, packed, cache.vertexRows, step);
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.magnitudeBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, cache.cpuMagnitudes);
  }

  /** The colour uniforms both passes set — one resolution point, no drift. */
  private setColorUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowCorridorHandles,
    cache: FlowGpuCache,
  ): void {
    gl.uniform4fv(h.uColor, this.rgba01Uniform('Color', this.flowOpts.color));
    gl.uniform1f(
      h.uUseFeatureColor,
      cache.colorBuffer && h.aColor >= 0 ? 1 : 0,
    );
  }

  // ── attribute binding ─────────────────────────────────────────────────────

  /**
   * Bind the merged ribbon stream. Every optional slot is guarded on its
   * location: a configuration that compiled the attribute out reads -1, which is
   * exactly how "this program does not use it" should behave.
   */
  private bindRibbonAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowCorridorHandles,
    cache: FlowGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 3, gl.UNSIGNED_SHORT, true, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.extrusionBuffer);
    gl.enableVertexAttribArray(h.aFlowExtrusion);
    gl.vertexAttribPointer(h.aFlowExtrusion, 2, gl.FLOAT, false, 0, 0);

    if (h.aFlowSide >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.sideBuffer);
      gl.enableVertexAttribArray(h.aFlowSide);
      gl.vertexAttribPointer(h.aFlowSide, 1, gl.FLOAT, false, 0, 0);
    }
    if (cache.rowBuffer && h.aFlowRow >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.rowBuffer);
      gl.enableVertexAttribArray(h.aFlowRow);
      gl.vertexAttribPointer(h.aFlowRow, 1, gl.FLOAT, false, 0, 0);
    }
    if (cache.magnitudeBuffer && h.aFlowMagnitude >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.magnitudeBuffer);
      gl.enableVertexAttribArray(h.aFlowMagnitude);
      gl.vertexAttribPointer(h.aFlowMagnitude, 1, gl.FLOAT, false, 0, 0);
    }
    if (cache.colorBuffer && h.aColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.colorBuffer);
      gl.enableVertexAttribArray(h.aColor);
      gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    }
    if (cache.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cache.indexBuffer!);
  }

  /**
   * Undo {@link bindRibbonAttributes} on the DEFAULT VAO after a pick pass. A
   * pick runs OUTSIDE the host's render pass, so nothing else will tidy the
   * attribute slate before the basemap's next draw.
   */
  private releaseRibbonAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FlowCorridorHandles,
    cache: FlowGpuCache,
  ): void {
    gl.disableVertexAttribArray(h.aMercator);
    gl.disableVertexAttribArray(h.aTime);
    gl.disableVertexAttribArray(h.aFlowExtrusion);
    if (h.aFlowSide >= 0) gl.disableVertexAttribArray(h.aFlowSide);
    if (cache.rowBuffer && h.aFlowRow >= 0) {
      gl.disableVertexAttribArray(h.aFlowRow);
    }
    if (cache.magnitudeBuffer && h.aFlowMagnitude >= 0) {
      gl.disableVertexAttribArray(h.aFlowMagnitude);
    }
    if (cache.colorBuffer && h.aColor >= 0) {
      gl.disableVertexAttribArray(h.aColor);
    }
    if (cache.filterBuffer && h.aFilterValue >= 0) {
      gl.disableVertexAttribArray(h.aFilterValue);
    }
  }

  // ── program resolution ────────────────────────────────────────────────────

  private resolveHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
    pick: boolean,
  ): FlowCorridorHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aFlowRow: gl.getAttribLocation(program, FLOW_NAMES.row),
      aFlowExtrusion: gl.getAttribLocation(program, FLOW_NAMES.extrusion),
      aFlowSide: gl.getAttribLocation(program, FLOW_NAMES.side),
      aFlowMagnitude: gl.getAttribLocation(program, 'aFlowMagnitude'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      aIdColor: pick ? gl.getAttribLocation(program, 'aIdColor') : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uFlowMatrix: gl.getUniformLocation(program, FLOW_NAMES.matrix),
      uFlowMatrixSize: gl.getUniformLocation(program, FLOW_NAMES.texSize),
      uFlowMatrixDims: gl.getUniformLocation(program, FLOW_NAMES.dims),
      uFlowValueScale: gl.getUniformLocation(program, FLOW_NAMES.valueScale),
      uFlowBucket: gl.getUniformLocation(program, FLOW_NAMES.bucket),
      uFlowHasValues: gl.getUniformLocation(program, 'uFlowHasValues'),
      uFlowConstant: gl.getUniformLocation(program, 'uFlowConstant'),
      uMinFlow: gl.getUniformLocation(program, 'uMinFlow'),
      uWidthScale: gl.getUniformLocation(program, 'uWidthScale'),
      uWidthExponent: gl.getUniformLocation(program, 'uWidthExponent'),
      uWidthClamp: gl.getUniformLocation(program, 'uWidthClamp'),
      uWidthToMercator: gl.getUniformLocation(program, 'uWidthToMercator'),
      uOffsetWidths: gl.getUniformLocation(program, 'uOffsetWidths'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uFlowRamp: gl.getUniformLocation(program, 'uFlowRamp'),
      uFlowRampCount: gl.getUniformLocation(program, 'uFlowRampCount'),
      uFlowRampDomain: gl.getUniformLocation(program, 'uFlowRampDomain'),
      uFlowRampGamma: gl.getUniformLocation(program, 'uFlowRampGamma'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveWakeTailScaleUniformLocation(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
      ...resolveFilterTransformSizeUniformLocation(gl, program),
    };
  }

  private readonly mainFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): FlowCorridorHandles =>
    this.resolveHandles(
      gl,
      this.linkProgram(
        gl,
        buildFlowCorridorVertexSource(shader, this.shaderConfig),
        FS_SOURCE,
      ),
      shader,
      false,
    );

  private readonly pickFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): FlowCorridorHandles =>
    this.resolveHandles(
      gl,
      this.linkProgram(
        gl,
        buildFlowCorridorIdVertexSource(shader, this.shaderConfig),
        ID_FS_SOURCE,
      ),
      shader,
      true,
    );

  // ── draw ──────────────────────────────────────────────────────────────────

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const c = cache as FlowGpuCache;
    if (c.indexCount <= 0) return;
    this.resolveFlowCaps(gl);
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;

    // A VAO records attribute SLOTS, which are per-program; a host variant flip
    // (v5 mercator ⇄ globe) relinks and may relocate them.
    if (c.vaoVariant !== variant) {
      if (c.vao) this.vaoSupport.delete(c.vao);
      c.vao = undefined;
      c.vaoVariant = variant;
    }

    let h = this.mainHandles;
    if (!h || this.mainVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        this.programKeys.main,
        frame,
        this.mainFactory,
      );
      this.mainHandles = h;
      this.mainVariant = variant;
    }
    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, c, ctx, frame);
    this.setColorUniforms(gl, h, c);

    this.bindVaoOrSetup(c, () => this.bindRibbonAttributes(gl, h!, c));

    gl.drawElements(gl.TRIANGLES, c.indexCount, c.indexType, 0);
  }

  /**
   * Draw this corridor tile into the id-pick FBO, painting reach `i` the flat
   * colour `encodePickId(idBase + i)`.
   *
   * A reach contributes many ribbon vertices, so the per-FEATURE id colours are
   * expanded across them with the shared `expandPickIdColors` kernel — the same
   * provenance join the line and polygon families use. Every visibility gate of
   * {@link drawTile} is reproduced by construction (the two passes share one
   * vertex-source builder): the time mode, the DataFilter, the below-`minFlow`
   * collapse and the colour's alpha. Browser-verify-only (the enclosing FBO
   * round-trip needs a live GPU); the id-colour build + decode join are
   * unit-tested in the base.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const c = cache as FlowGpuCache;
    if (c.indexCount <= 0) return;
    this.resolveFlowCaps(gl);
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    // `featureCount` — not the cache's — is what the base sized the id range
    // from, so painting can never spill past `idBase + count`.
    const count = Math.min(layer.features.featureCount, c.featureCount);
    if (count <= 0) return;

    let h = this.pickHandles;
    if (!h || this.pickVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        this.programKeys.pick,
        frame,
        this.pickFactory,
      );
      this.pickHandles = h;
      this.pickVariant = variant;
    }
    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, c, ctx, frame);
    // The colour reaches the id program too — only its ALPHA is read, and it is
    // what keeps a transparent corridor out of the hit test.
    this.setColorUniforms(gl, h, c);

    // Rebuilt per pick and freed immediately: `idBase` shifts with whatever
    // tiles are loaded this frame, and picks are rare user-initiated events.
    const idColors = expandPickIdColors(
      this.buildPickIdColors(count, idBase),
      c.ribbonCounts,
      c.vertexCount,
    );
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    // Raw attribute binds (no VAO): the temp id buffer is per-pass, so a cached
    // VAO would just go stale.
    this.bindRibbonAttributes(gl, h, c);
    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawElements(gl.TRIANGLES, c.indexCount, c.indexType, 0);

    gl.disableVertexAttribArray(h.aIdColor);
    this.releaseRibbonAttributes(gl, h, c);
    gl.deleteBuffer(idBuffer);
  }
}

/**
 * The twin-ribbon flow stroke: {@link STTFlowCorridorLayer} with the corridor
 * pushed sideways by a multiple of its own LIVE width.
 *
 * Why that reads as a different layer rather than a prop: a directed corridor
 * archive stores A→B and B→A as SEPARATE reaches traversing the shared street in
 * opposite vertex order, so a constant signed offset lands them on opposite
 * sides. The pair then exposes directional asymmetry directly — inbound swells
 * while outbound thins, and the gap between the ribbons breathes with the total.
 * One-way pairs already sit on different streets and simply shift a little.
 *
 * Everything else — the ribbon tessellation, the value-matrix sampling, the
 * time modes, the DataFilter, picking — is inherited unchanged; only the
 * defaults move. `offsetWidths: 0` turns it back into a plain corridor.
 *
 * ```ts
 * const strokes = new STTFlowStrokeLayer({
 *   id: 'bixi-corridors',
 *   url: '/data/bixi-corridors.stt',
 *   currentTime: t0,
 *   timeWindow: 3600_000,
 *   signedFlow: true,      // per-bucket direction archives: width follows |v|
 *   minFlow: 1,            // quiet corridors go dark rather than hairline
 *   widthScale: 2,
 * });
 * ```
 */
export class STTFlowStrokeLayer extends STTFlowCorridorLayer {
  constructor(opts: STTFlowStrokeLayerOptions) {
    super({
      // `??` per option (not a spread over defaults): an EXPLICIT `undefined` —
      // the React `{...base, offsetWidths: props.offsetWidths}` shape — must
      // fall through to the default instead of shadowing it.
      ...opts,
      offsetWidths: opts.offsetWidths ?? DEFAULT_OFFSET_WIDTHS,
      widthExponent: opts.widthExponent ?? DEFAULT_WIDTH_EXPONENT,
    });
  }
}
