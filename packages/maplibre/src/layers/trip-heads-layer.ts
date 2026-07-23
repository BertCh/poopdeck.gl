/**
 * Trip-heads adapter — the smooth moving DOT that sits at the live end of each
 * trip, the companion piece to {@link STTTripsLayer}'s trailing ribbon
 * (parity with `@poopdeck.gl/layers`'s `AnimatedTripHeadsLayer`).
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 * A trip is a LINESTRING whose vertices carry timestamps. The head is the
 * position the vehicle occupies at the playhead, which is a CPU interpolation
 * (binary-search the bracketing segment, lerp) — not something a time-window
 * shader can express, because a window that spans N vertices would light N
 * points, the "train of dots" bug. So:
 *
 *   1. **Tile upload** — every LineString feature is materialized as one
 *      {@link Track} (the hoisted `@poopdeck.gl/core` track kernel's keyframe
 *      shape): vertex times rebased to ABSOLUTE epoch-ms, positions
 *      de-interleaved into pooled `Float64Array`s that each track views a slice
 *      of. Per-vertex times come from the tile's own `vertexTimestamps` column
 *      when present, else from the shared `synthesizeVertexTimes` kernel
 *      (cumulative haversine distance — the same distribution deck, three and
 *      the Rust producer use, so a long leg does not advance at the rate of a
 *      short one).
 *   2. **Every frame** — core `sampleTrack` interpolates ONE pose per ACTIVE
 *      trip; inactive trips return null and simply are not emitted. The active
 *      poses are packed into a PERSISTENT, pre-sized instance buffer
 *      (`bufferSubData`, never a fresh allocation) and drawn as `GL_POINTS`
 *      billboards.
 *
 * This layer is the primary consumer of campaign D7 (the track-kernel hoist to
 * core): the interpolation, the shortest-arc/NaN-tolerant lerps, the CPU
 * appear/disappear fade and the `maxGapMs` integrity guard all come from ONE
 * implementation shared with deck, three and Cesium.
 *
 * ── TIME MODES ──────────────────────────────────────────────────────────────
 * A head is inherently a "where is it RIGHT NOW" primitive, so only two of the
 * four package modes carry meaning here (see
 * {@link resolveTripHeadsTimeFilterMode}):
 *   - `window` (default) — the trip's `[startTime, endTime]` must overlap the
 *     layer's half-window. For an emitted head that is always true (the head
 *     only exists while the playhead is inside the trip), so this is a no-op
 *     gate kept for family consistency and for callers narrowing `timeWindow`.
 *   - `wake` (`wakeLength > 0`) — the dot is lit only for `wakeLength` ms after
 *     its trip's own start, fading out and shrinking toward `wakeTailScale`:
 *     "recently departed" emphasis.
 * `cumulative` (appear-and-persist) and `trail` (a fading tail of past
 * vertices) describe a HISTORY, which is exactly what the trips ribbon already
 * draws — asking for either here degrades to `window` with one warning.
 *
 * The appear/disappear FADE is CPU-resolved by `sampleTrack` against the
 * TRIP's own keyframe span (`fadeInDuration` / `fadeOutDuration` /
 * `softTimeWindow`), reaching the shader as the per-instance `aFade` attribute.
 * The window-mode shader therefore runs with HARD edges (`uFadeIn`/`uFadeOut`
 * are 0) — the alternative double-applies the same ramp, once against the
 * trip's span and once against the layer's window edges. WAKE mode takes the
 * OTHER half of the same rule: its alpha IS an age ramp from the trip's start,
 * so the CPU fade is switched off there (`emitHeads`) and `aFade` never reaches
 * `vAlpha` (`MODE_ALPHA`) — otherwise a soft window's fade-in would both hide
 * the wake and invert its tail taper.
 *
 * ── DATA FILTER ─────────────────────────────────────────────────────────────
 * `filterProperty` + `filterRange`/`filterSoftRange` range-filter heads by one
 * baked numeric column (`shaders/data-filter.glsl.ts`, deck's
 * `DataFilterExtension` semantics). The column is EXTRACTED at tile upload; its
 * values ride the per-frame buffer because the emitted heads are compacted
 * (active-only), so a per-feature attribute cannot be bound directly. A tile
 * missing the column renders unfiltered, never blank.
 *
 * ── PICKING ─────────────────────────────────────────────────────────────────
 * deck's `AnimatedTripHeadsLayer` disables picking precisely because its
 * active-only buffer reorders indices. This layer records the source FEATURE
 * index of every emitted head (`activeFeatureIndex`), so the id pass paints
 * `encodePickId(idBase + featureIndex)` and the base `resolvePick` join lands
 * on the right row. Same projection, same sizing, same time + filter gates —
 * and the same COLOUR ALPHA — as the visual pass ⇒ a head the user cannot see
 * is not pickable.
 *
 * ── PROJECTION (campaign D3) ────────────────────────────────────────────────
 * Legacy hosts (maplibre ≤v4, mapbox v3) keep the positional `uMatrix` MVP;
 * v5+ hosts get the injected prelude and project via `projectTile(vec2)` —
 * a billboard is 2d content, so `projectTile`'s z overwrite (horizon clipping)
 * is exactly right, and a single point needs no globe edge subdivision.
 * Positions are RAW Float32 mercator, not the per-tile `UNSIGNED_SHORT`
 * quantization the point layer uses: heads MOVE every frame, so a per-tile
 * quantization envelope would have to be recomputed and re-uploaded every
 * frame. Final GPU precision is the same either way — both end at
 * `float32 small + float32 origin` (see `lib/projection.ts`).
 *
 * Altitude is deliberately NOT sampled: these are 2d billboards, like
 * `STTPointLayer`. A 3D archive's heads sit on the ground plane.
 */

import type {
  BinaryFeatures,
  Tile,
  Layer as STTLayer,
} from '@poopdeck.gl/core';
import {
  GeometryType,
  DEFAULT_TRIPS_PALETTE as CORE_TRIPS_PALETTE,
  sampleTrack,
  type Track,
  type TrackSampleConfig,
} from '@poopdeck.gl/core';
import { synthesizeVertexTimes } from '@poopdeck.gl/core/trips';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import { encodePickId } from '@poopdeck.gl/core/picking';
import {
  discMaskGLSL,
  DISC_EDGE_EXPR,
  buildBillboardIdFragmentSource,
} from '../shaders/billboard.glsl.js';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from '../base-layer.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import { lngLatToMercatorInto } from '../lib/projection.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
} from '../shaders/time-window.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  createDataFilterUniforms,
  extractFilterColumn,
  resolveDataFilterUniforms,
  type DataFilterRange,
  type DataFilterUniforms,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';

/**
 * The time-filter modes a trip-heads layer can COMPILE. A head is one moving
 * position, so `cumulative` and `trail` (both of which describe a history) are
 * not in the union — {@link resolveTripHeadsTimeFilterMode} degrades them.
 */
export type TripHeadsTimeFilterMode = Extract<
  STTTimeFilterMode,
  'window' | 'wake'
>;

// Shared with @poopdeck.gl/layers AnimatedTripsLayer (single source of truth in
// @poopdeck.gl/core) so the head dots default to the ribbon's own palette.
const DEFAULT_PALETTE: ReadonlyArray<RGBA8> = CORE_TRIPS_PALETTE;

/** deck `AnimatedTripHeadsLayer.headColor` default, in 0–255. */
const DEFAULT_HEAD_COLOR: [number, number, number, number] = [
  253, 128, 93, 255,
];

/** deck `headStrokeColor` default, in 0–255. */
const DEFAULT_STROKE_COLOR: [number, number, number, number] = [0, 0, 0, 255];

/**
 * Upper clamp when `radiusMaxPixels` is unset — far past any legible on-screen
 * radius, so the default clamp is a no-op (a real `Infinity` uniform is not
 * portable across drivers).
 */
const UNBOUNDED_RADIUS_PIXELS = 1e6;

// Hand-built test DrawContexts may omit `frame`; those behave as a legacy
// positional-matrix host. Never mutated — the real render/pick paths always
// pass the base scratch frame.
const FALLBACK_LEGACY_FRAME: HostFrame = createHostFrame();

/**
 * `Track.color` is a required field of the kernel's keyframe shape but this
 * layer never reads it (head colours come from the baked per-feature colour
 * buffer, or from the `uColor` uniform). ONE shared instance stands in for
 * every track rather than allocating a 4-tuple per trip.
 */
const UNUSED_TRACK_COLOR: [number, number, number, number] = [
  160, 160, 160, 255,
];

// ── CPU kernel: trips → track keyframes ─────────────────────────────────────

/** Per-tile trip tracks, ready for per-frame {@link sampleTrack} sampling. */
export interface TripTrackSet {
  /** One track per usable trip feature, in feature order. */
  tracks: Track[];
  /** `tracks[k]` was built from feature `featureIndex[k]` of the tile layer. */
  featureIndex: Uint32Array;
}

/**
 * Materialize every LineString feature of a tile as a track-kernel
 * {@link Track}: keyframes are the trip's own vertices, times are rebased to
 * ABSOLUTE epoch-ms (`vertexTime + timeOffset`) so `sampleTrack` can be handed
 * the playhead directly.
 *
 * Allocation shape (this runs once per tile, and the result is held for the
 * tile's whole residency, so it matters): times / lon / lat are pooled into
 * three `Float64Array`s and each track holds a `subarray` VIEW — three views
 * per trip instead of three JS arrays. The five columns the kernel wants but a
 * trip has no per-vertex answer for (`heading`, `length`, `width`, `height`,
 * `speed`) are ONE shared all-NaN array and `alt` ONE shared all-zero array,
 * reused by every track: `sampleTrack` only ever INDEXES those (it reads
 * `.length` from `times` alone) and NaN degrades through `lerpDim` to the
 * sample config's defaults, exactly as an absent column should.
 *
 * A 1-vertex trip cannot be interpolated. It is emitted as two identical
 * keyframes spanning the feature's own `[startTime, endTime]` (so the dot is
 * held for the whole trip, matching deck's feature-window activity test); when
 * that window is degenerate the track falls back to the kernel's singleton
 * hold (±`SINGLETON_HOLD_MS`/2).
 *
 * Returns null when the tile carries no usable trip geometry.
 */
export function buildTripTracks(f: BinaryFeatures): TripTrackSet | null {
  const startIndices = f.startIndices;
  if (!startIndices || !f.positions?.length) return null;
  const featureCount = f.featureCount;
  if (featureCount <= 0) return null;

  const dims = f.positionDimensions === 3 ? 3 : 2;
  const positions = f.positions;
  const totalVerts = startIndices[featureCount];
  const hasVertexTimestamps =
    !!f.vertexTimestamps && f.vertexTimestamps.length >= totalVerts;
  const vertexTimes = hasVertexTimestamps
    ? f.vertexTimestamps!
    : synthesizeVertexTimes(f);
  const offset = f.timeOffset;

  // `+ featureCount` reserves the duplicate keyframe a 1-vertex trip needs.
  const capacity = totalVerts + featureCount;
  const times = new Float64Array(capacity);
  const lons = new Float64Array(capacity);
  const lats = new Float64Array(capacity);
  // Shared read-only stand-ins for the columns a trip has no per-vertex value
  // for. Sized to `capacity` so every track's indices stay in range.
  const nan = new Float64Array(capacity).fill(Number.NaN);
  const zeros = new Float64Array(capacity);

  const tracks: Track[] = [];
  const featureIndex: number[] = [];
  let w = 0;

  for (let fi = 0; fi < featureCount; fi++) {
    const v0 = startIndices[fi];
    const v1 = startIndices[fi + 1];
    const nv = v1 - v0;
    if (nv <= 0) continue;
    const base = w;

    if (nv === 1) {
      const b = v0 * dims;
      const lon = positions[b];
      const lat = positions[b + 1];
      const start = f.startTimes[fi] + offset;
      const end = f.endTimes[fi] + offset;
      times[w] = start;
      lons[w] = lon;
      lats[w] = lat;
      w++;
      if (end > start) {
        times[w] = end;
        lons[w] = lon;
        lats[w] = lat;
        w++;
      }
    } else {
      for (let v = 0; v < nv; v++) {
        const b = (v0 + v) * dims;
        times[w] = vertexTimes[v0 + v] + offset;
        lons[w] = positions[b];
        lats[w] = positions[b + 1];
        w++;
      }
    }

    const n = w - base;
    tracks.push({
      // A trip IS its own track — the identity is the tile-local feature index
      // (carried in `featureIndex`, which is what picking joins on), so the
      // kernel's cross-tile pooling key is deliberately empty here. Pooling by
      // `track_id` across tiles is the POINT-snapshot glide model
      // (`buildTrackIndex` / `TrackIndexMaintainer`), not the trip model.
      trackId: '',
      // Float64Array is structurally what `sampleTrack` needs (indexed reads
      // plus `times.length`); the kernel's `number[]` typing exists for
      // `buildTrackIndex`, the only function that PUSHES. Views keep the
      // per-trip cost to three header objects instead of three JS arrays.
      times: times.subarray(base, w) as unknown as number[],
      lon: lons.subarray(base, w) as unknown as number[],
      lat: lats.subarray(base, w) as unknown as number[],
      alt: zeros as unknown as number[],
      heading: nan as unknown as number[],
      length: nan as unknown as number[],
      width: nan as unknown as number[],
      height: nan as unknown as number[],
      speed: nan as unknown as number[],
      color: UNUSED_TRACK_COLOR,
      label: '',
      category: '',
      singleton: n < 2,
    });
    featureIndex.push(fi);
  }

  if (tracks.length === 0) return null;
  return { tracks, featureIndex: Uint32Array.from(featureIndex) };
}

/**
 * Allocation-free `lngLatToMercator`: writes the unit-square mercator pair into
 * `out[at]`/`out[at + 1]` instead of returning a fresh 2-tuple.
 *
 * The emit loop runs per active head per frame, so the tuple-returning form
 * would allocate thousands of arrays a second. The maths now lives in
 * `lib/projection.ts` as {@link lngLatToMercatorInto} — the extraction this
 * function's own concerns note asked for, which the icon layer's glide emit
 * shares — and this stays as the layer-local name the trip-heads suite pins
 * against the tuple form.
 */
export function writeMercator(
  lon: number,
  lat: number,
  out: Float32Array,
  at: number,
): void {
  lngLatToMercatorInto(lon, lat, out, at);
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled trip-heads program supports. Both knobs are structural (they
 * add uniforms / attributes / statements), so each combination is its own
 * program and each must appear in the program-cache key —
 * {@link tripHeadsProgramKey}.
 */
export interface TripHeadsShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: TripHeadsTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
}

/** Plainest configuration: window mode, no column filter. */
const DEFAULT_SHADER_CONFIG: TripHeadsShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<TripHeadsTimeFilterMode, string>> =
  Object.freeze({
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
  });

/** Uniforms each mode reads. Only the active mode's block is declared. */
const MODE_UNIFORMS: Readonly<Record<TripHeadsTimeFilterMode, string>> =
  Object.freeze({
    window: `  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
`,
    wake: `  uniform float uCurrentTime;
  uniform float uWakeLength;
  uniform float uWakeTailScale;
`,
  });

/**
 * The `vAlpha = …` expression per mode.
 *
 * WINDOW folds in `aFade`, the CPU appear/disappear ramp `sampleTrack` resolved
 * against the TRIP's own span (and folds it into the ALPHA, not the colour, so
 * the id pass gates on exactly the same value). Its shader-side fade is then
 * driven to 0 (`setTimeUniforms`) — the two ramps describe the same event and
 * applying both would square it.
 *
 * WAKE deliberately does NOT: its whole alpha is the age ramp measured from the
 * trip's own start, i.e. from the same instant the CPU fade-IN ramps from, so
 * multiplying them compounds one effect with itself. Worse, `vAlpha` is what
 * feeds `sttWakeSizeScale`, whose contract is "a function of wake AGE" — with
 * the fade folded in, a `fadeInDuration` comparable to `wakeLength` would make
 * a just-departed head (which must be full size) the most SHRUNKEN one, running
 * the taper backwards. `emitHeads` zeroes the CPU fade durations in wake mode
 * for the same reason, so `aFade` is 1 there either way; deck's
 * `AnimatedTripHeadsLayer` applies no fade in wake mode at all.
 */
const MODE_ALPHA: Readonly<Record<TripHeadsTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut) * aFade',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
  });

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * DataFilter application, shared verbatim by the visual and id passes (deck's
 * split: a HARD-filtered head is hidden whatever the transform flags say, while
 * a soft-margin value only fades / shrinks when its flag is on).
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) {
      radiusPx *= filterAlpha;
    }
`;

/**
 * Assemble a trip-heads vertex shader.
 *
 * Legacy hosts (empty prelude) project through `uMatrix`; v5+ hosts get the
 * injected prelude + define prepended (maplibre's documented order) with
 * projection routed through `projectTile` — heads are 2d billboards, so the
 * prelude's z overwrite (horizon clipping) is exactly right.
 *
 * `vAlpha` is computed BEFORE the radius so wake mode's tail shrink and the
 * DataFilter size transform can both read it (deck's `vs:#main-start` →
 * `DECKGL_FILTER_SIZE` ordering).
 *
 * A fully-gated head is dropped by the fragment shader's
 * `if (vAlpha <= 0.0) discard;`, NOT by a `gl_Position = vec4(0.0)` collapse:
 * with `w == 0` a POINT primitive has no defined NDC position, so collapsing
 * could paint a stray disc.
 *
 * ── Colour alpha is a PICK gate too ─────────────────────────────────────────
 * The id pass carries the SAME colour surface as the visual one (attribute +
 * constant uniform) purely to fold its alpha into `vAlpha`, so a head painted
 * with a zero-alpha colour — `color: [r,g,b,0]`, or a `colorMapping` entry with
 * alpha 0, the idiomatic "hide this category" spelling — is not a hit target
 * for something the user cannot see. deck does the same in
 * `picking_filterPickingColor` (`if (color.a == 0.0) discard`). The fold
 * happens AFTER the radius is resolved: the size must follow the wake/filter
 * taper, never the tint's opacity.
 */
function buildTripHeadsVs(
  shader: ShaderInjection,
  cfg: TripHeadsShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  const projection = usesPrelude
    ? '    gl_Position = projectTile(aMercator);'
    : '    gl_Position = uMatrix * vec4(aMercator, 0.0, 1.0);';
  const idAttribute = isMain
    ? ''
    : '  attribute vec3 aIdColor;       // per-head encoded pick id (UNSIGNED_BYTE normalized)\n';
  const legacyUniforms = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const payloadVarying = isMain
    ? '  varying vec4 vColor;\n  varying float vRadiusPx;\n'
    : '  varying vec3 vIdColor;\n';
  const wakeSize =
    cfg.mode === 'wake'
      ? '    radiusPx *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';
  // Only the visual pass strokes a contrast ring, and only it needs the
  // resolved radius in the fragment stage to measure the ring's width.
  const radiusVarying = isMain ? '    vRadiusPx = radiusPx;\n' : '';
  const payloadAssign = isMain
    ? '    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;\n'
    : `    vIdColor = aIdColor;
    // A fully transparent head is invisible, so it must not be pickable.
    vAlpha *= ((uUseFeatureColor > 0.5) ? aColor.a : uColor.a);
`;

  return `${head}
  precision highp float;
  attribute vec2 aMercator;      // per-frame interpolated head, mercator unit square
  attribute vec2 aTime;          // owning trip's [startTime, endTime], tile-relative
  attribute float aRadius;       // per-head radius, in radiusUnits
  attribute float aFade;         // CPU appear/disappear ramp from sampleTrack
  attribute vec4 aColor;         // per-head RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
${idAttribute}${cfg.filter ? FILTER_ATTRIBUTE : ''}${legacyUniforms}  uniform float uRadiusScale;
  uniform vec2 uRadiusPixelRange; // [min, max] resolved radius, device px
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${payloadVarying}${MODE_GLSL[cfg.mode]}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
${projection}
    vAlpha = ${MODE_ALPHA[cfg.mode]};
    float radiusPx = clamp(
      aRadius * uRadiusScale,
      uRadiusPixelRange.x,
      uRadiusPixelRange.y
    );
${wakeSize}${cfg.filter ? FILTER_BODY : ''}${radiusVarying}    gl_PointSize = radiusPx * 2.0;
${payloadAssign}  }
`;
}

/** Visual vertex source for a host shader variant + feature configuration. */
export function buildTripHeadsVertexSource(
  shader: ShaderInjection,
  cfg: TripHeadsShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildTripHeadsVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildTripHeadsVertexSource}. */
export function buildTripHeadsIdVertexSource(
  shader: ShaderInjection,
  cfg: TripHeadsShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildTripHeadsVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `getOrCreateProgram` appends `::${variantName}` (the HOST variant) only, so
 * two configurations sharing a base key would collide on one program.
 */
export function tripHeadsProgramKey(
  pass: 'main' | 'pick',
  cfg: TripHeadsShaderConfig,
): string {
  return `tripHeads:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
}

/**
 * Resolve the compiled time-filter mode from the option surface.
 *
 * `wake` needs a positive `wakeLength` (a zero-length wake would light
 * nothing); `cumulative` and `trail` are not expressible for a single moving
 * position and degrade to `window` — see the module header. Unset infers from
 * the knobs, deck's precedence order minus the two dropped modes.
 *
 * `degraded` is true when the caller asked for something this layer cannot
 * honour, so the layer can warn exactly once. Exported for the prop tests.
 */
export function resolveTripHeadsTimeFilterMode(
  mode: STTTimeFilterMode | undefined,
  wakeLength: number,
): { mode: TripHeadsTimeFilterMode; degraded: boolean } {
  if (mode === 'cumulative' || mode === 'trail') {
    return { mode: 'window', degraded: true };
  }
  if (mode === 'wake') {
    return { mode: wakeLength > 0 ? 'wake' : 'window', degraded: false };
  }
  if (mode === 'window') return { mode: 'window', degraded: false };
  return { mode: wakeLength > 0 ? 'wake' : 'window', degraded: false };
}

/**
 * Visual fragment stage: an antialiased disc, optionally ringed by a contrast
 * stroke drawn INSIDE the radius (deck `ScatterplotLayer.stroked` semantics —
 * `headStroked` / `headStrokeColor` / `headStrokeWidth` upstream). `uStrokeWidth
 * <= 0` (the default) short-circuits to the plain disc, so the ring costs one
 * fully-coherent uniform branch and NO extra program variant.
 */
const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying float vRadiusPx;
  varying vec4 vColor;
  uniform float uStrokeWidth;   // device px; <= 0 disables the ring
  uniform vec4 uStrokeColor;
  void main() {
    if (vAlpha <= 0.0) discard;
${discMaskGLSL()}    // Antialiased disc: soften the last ~10% of the radius.
    float edge = ${DISC_EDGE_EXPR};
    vec4 c = vColor;
    if (uStrokeWidth > 0.0) {
      // |d| == 0.5 at the disc edge, so the distance from that edge in device
      // pixels is vRadiusPx * (1 - 2|d|).
      float edgePx = vRadiusPx * (1.0 - 2.0 * sqrt(r2));
      if (edgePx < uStrokeWidth) c = uStrokeColor;
    }
    gl_FragColor = vec4(c.rgb, c.a * vAlpha * edge);
  }
`;

/**
 * Id-pass fragment stage: the SAME visibility gate as the visual pass (time
 * mode × CPU fade × column filter), then the exact id bytes — no blending, no
 * antialiased edge, so a partially-covered edge texel still decodes to the
 * exact triple. The disc mask matches the visual one, so the hit area is the
 * circle the user sees (contrast ring included — it is inside the radius).
 */
const ID_FS_SOURCE = buildBillboardIdFragmentSource('heads');

/** Locations every trip-heads program shares. */
interface HeadsSharedHandles {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+). */
  usesPrelude: boolean;
  aMercator: number;
  aTime: number;
  aRadius: number;
  aFade: number;
  aFilterValue: number;
  /**
   * Per-head colour. On the VISUAL program it is the painted colour; on the ID
   * program it exists only so the pass can gate on the colour's ALPHA (an
   * invisible head must not be pickable) — hence shared, not per-pass.
   */
  aColor: number;
  uMatrix: WebGLUniformLocation | null;
  uRadiusScale: WebGLUniformLocation | null;
  uRadiusPixelRange: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uWakeLength: WebGLUniformLocation | null;
  uWakeTailScale: WebGLUniformLocation | null;
  uFilterRange: WebGLUniformLocation | null;
  uFilterSoftRange: WebGLUniformLocation | null;
  uFilterEnabled: WebGLUniformLocation | null;
  uFilterTransformSize: WebGLUniformLocation | null;
  uFilterTransformColor: WebGLUniformLocation | null;
}

interface HeadsProgramHandles extends HeadsSharedHandles {
  uStrokeWidth: WebGLUniformLocation | null;
  uStrokeColor: WebGLUniformLocation | null;
}

interface HeadsIdProgramHandles extends HeadsSharedHandles {
  aIdColor: number;
}

/**
 * Per-tile state. The GPU side is TWO persistent, pre-sized buffers rewritten
 * with `bufferSubData` every frame — the one place in this backend where
 * per-frame buffer writes are the design, because the heads MOVE.
 */
interface TripHeadsGpuCache extends TileGpuCache {
  /** Interleaved per-head instance data; `positionBuffer` aliases it. */
  instanceBuffer: WebGLBuffer;
  /** Per-head RGBA8; present only when the tile resolved a colour column. */
  colorBuffer?: WebGLBuffer;
  /** Trip tracks + their source feature indices. */
  trackSet: TripTrackSet;
  /**
   * The tile's per-feature `[startTime, endTime]` columns, TILE-RELATIVE —
   * zero-copy views of the decoded tile. Copied into the per-frame instance
   * buffer in the compacted active-head order, where they feed the GPU time
   * gate (whose `uWindowStart` / `uCurrentTime` are relativized the same way).
   */
  sourceStartTimes: Float32Array;
  sourceEndTimes: Float32Array;
  /** Per-feature baked RGBA8 from `colorProperty`, or null. */
  featureColors: Uint8Array | null;
  /** Per-feature radius column, or null (the constant radius is used then). */
  featureRadii: Float32Array | null;
  /** Per-feature filter column, or null. */
  filterValues: Float32Array | null;
  /** Whether this tile supplies a numeric filter column (the `enabled` gate). */
  hasFilterColumn: boolean;
  /** Source feature index of emitted head `i`, for the id pass. */
  activeFeatureIndex: Uint32Array;
  /** Heads emitted by the most recent {@link STTTripHeadsLayer.emitHeads}. */
  activeCount: number;
  /** Max heads the persistent buffers were sized for (= usable trip count). */
  capacity: number;
  /**
   * Program the cached VAO's attribute locations were recorded against, as
   * `${programKey}::${variantName}`. A VAO stores attribute SLOTS, which are
   * per-program.
   */
  vaoVariant?: string;
}

export interface STTTripHeadsLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Constant head colour as `[r, g, b, a]`. Accepts EITHER 0–255 ints (the
   * deck.gl `Color` convention, and what `colorPalette` uses) OR 0–1 floats —
   * the range is auto-detected. Ignored when `colorProperty` resolves.
   * @default [253, 128, 93, 255] (deck `headColor`)
   */
  color?: [number, number, number, number];
  /**
   * Head radius, in {@link radiusUnits}. deck spells this `headRadiusPixels` /
   * `headRadius`; this backend uses ONE prop plus a unit selector, matching
   * {@link STTPointLayer}.
   * @default 4
   */
  radius?: number;
  /**
   * Unit `radius` (and a `radiusProperty` column) is expressed in. `'pixels'`
   * (default) is screen-space — one size at every zoom. `'meters'` is
   * ground-metric (deck's `sizeUnits: 'meters'`): converted per tile at the
   * tile centre's latitude and the map's live fractional zoom.
   * @default 'pixels'
   */
  radiusUnits?: 'pixels' | 'meters';
  /** Multiplier applied to every head radius (deck `radiusScale`). @default 1 */
  radiusScale?: number;
  /**
   * Lower clamp on the resolved on-screen radius, in DEVICE pixels (deck
   * `headRadiusMinPixels`). Mainly for `radiusUnits: 'meters'`.
   * @default 0
   */
  radiusMinPixels?: number;
  /**
   * Upper clamp on the resolved on-screen radius, in DEVICE pixels (deck
   * `headRadiusMaxPixels`). Effectively unbounded by default.
   */
  radiusMaxPixels?: number;
  /** Drive per-head radius from a numeric per-FEATURE property. */
  radiusProperty?: string;
  /**
   * Drive per-head colour from a categorical per-FEATURE property. Falls back
   * to the constant `color` on tiles that lack it.
   */
  colorProperty?: string;
  /**
   * Palette used with `colorProperty`, as 0–255 RGBA tuples.
   * @default the shared trips palette
   */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA map (deck/three `colorMapping` parity),
   * so a category renders the same colour in every tile regardless of per-tile
   * dictionary order.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /**
   * Draw a contrast ring inside each head (deck `headStroked`), keeping the dot
   * legible over a busy basemap.
   * @default false
   */
  stroked?: boolean;
  /** Ring colour, 0–255 or 0–1 (deck `headStrokeColor`). @default [0,0,0,255] */
  strokeColor?: [number, number, number, number];
  /**
   * Ring width in DEVICE pixels (deck `headStrokeWidth`, pixels only here).
   * @default 1
   */
  strokeWidth?: number;
  /**
   * Which temporal alpha the shader computes — `'window'` (default) or
   * `'wake'`. `'cumulative'` / `'trail'` describe a HISTORY, which is what
   * {@link STTTripsLayer} draws; asking for either here degrades to `'window'`
   * with one warning. Unset infers `'wake'` from a positive `wakeLength`.
   *
   * The mode is compiled into the shader, so flipping it at runtime
   * ({@link STTTripHeadsLayer.setTimeFilterMode}) links a second program.
   */
  timeFilterMode?: STTTimeFilterMode;
  /**
   * Wake mode: a head is lit only for this many ms AFTER its trip's own
   * `startTime`, fading to 0 and shrinking toward `wakeTailScale`.
   * @default 0 (window mode)
   */
  wakeLength?: number;
  /**
   * Wake-mode trailing-edge radius multiplier (head = 1.0).
   * @default 0.15 (core `DEFAULT_WAKE_TAIL_SCALE`)
   */
  wakeTailScale?: number;
  /**
   * Integrity guard (core `TrackSampleConfig.maxGapMs`): when the two vertices
   * bracketing the playhead are farther apart in TIME than this, the head HOLDS
   * its last vertex instead of gliding a straight line through a data hole. A
   * silent vehicle should stop, not teleport smoothly.
   *
   * Spelled `maxInterpolationGap` — deck's name, and the same name
   * {@link STTIconLayer} gives its glide guard — so the one knob reads
   * identically on both interpolating layers of this package. The core kernel's
   * own field stays `maxGapMs`; this is the option surface.
   * @default Infinity (never holds — deck's behaviour)
   */
  maxInterpolationGap?: number;
}

/**
 * MapLibre custom layer that renders the moving head dot of each STT trip.
 *
 * ```ts
 * const trips = new STTTripsLayer({ id: 'bixi', url, currentTime, timeWindow });
 * const heads = new STTTripHeadsLayer({
 *   id: 'bixi-heads',
 *   url,
 *   currentTime,
 *   timeWindow,
 *   radius: 5,
 *   stroked: true,
 * });
 * trips.attach(map);
 * heads.attach(map); // drawn after, so the dots sit on top of the ribbons
 * ```
 *
 * Pass both layers one {@link SharedTilesetSource} (`{ source }` instead of
 * `{ url }`) to read the archive once.
 */
export class STTTripHeadsLayer extends STTBaseLayer {
  private headOpts: {
    color: [number, number, number, number];
    radius: number;
    radiusUnits: 'pixels' | 'meters';
    radiusScale: number;
    radiusMinPixels: number;
    radiusMaxPixels: number;
    radiusProperty?: string;
    colorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    stroked: boolean;
    strokeColor: [number, number, number, number];
    strokeWidth: number;
    timeFilterMode?: STTTimeFilterMode;
    wakeLength: number;
    wakeTailScale: number;
    maxInterpolationGap: number;
  };
  /** Mutated in place by the filter setters; read by `resolveDataFilterUniforms`. */
  private filterOpts: STTDataFilterOptions;
  /** Allocated once — the per-draw uniform payload never allocates. */
  private readonly filterUniforms: DataFilterUniforms =
    createDataFilterUniforms();
  /**
   * Sample config handed to `sampleTrack`, refilled in place each emit so the
   * per-frame path allocates nothing. The three `default*` dimensions are
   * unused (a trip carries no per-vertex extent) but are part of the kernel's
   * contract.
   */
  private readonly sampleCfg: TrackSampleConfig = {
    defaultLength: 0,
    defaultWidth: 0,
    defaultHeight: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    maxGapMs: Number.POSITIVE_INFINITY,
  };
  /** Compiled feature configuration; drives the program-cache keys. */
  private shaderConfig: TripHeadsShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /** `${mainKey}::${variantName}` — the tile-VAO staleness key. */
  private mainVaoKey = '';
  /** Floats per emitted head (see {@link emitHeads}); fixed at construction. */
  private readonly stride: number;
  /** Grow-only per-frame scratch, shared by every tile of this layer. */
  private floatScratch = new Float32Array(0);
  private colorScratch = new Uint8Array(0);
  private idScratch = new Uint8Array(0);
  private warnedCategoricalFilter = false;
  private warnedUnsupportedMode = false;
  /**
   * Handles of the most recently used variant, memoized per `*Variant` so the
   * per-tile hot path skips the base cache's key-string build.
   */
  private handles?: HeadsProgramHandles;
  private handlesVariant?: string;
  private idHandles?: HeadsIdProgramHandles;
  private idHandlesVariant?: string;

  constructor(opts: STTTripHeadsLayerOptions) {
    super(opts);
    this.headOpts = {
      color: opts.color ?? DEFAULT_HEAD_COLOR,
      radius: opts.radius ?? 4,
      radiusUnits: opts.radiusUnits ?? 'pixels',
      radiusScale: opts.radiusScale ?? 1,
      radiusMinPixels: opts.radiusMinPixels ?? 0,
      radiusMaxPixels: opts.radiusMaxPixels ?? UNBOUNDED_RADIUS_PIXELS,
      radiusProperty: opts.radiusProperty,
      colorProperty: opts.colorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      stroked: opts.stroked ?? false,
      strokeColor: opts.strokeColor ?? DEFAULT_STROKE_COLOR,
      strokeWidth: opts.strokeWidth ?? 1,
      timeFilterMode: opts.timeFilterMode,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      maxInterpolationGap: opts.maxInterpolationGap ?? Number.POSITIVE_INFINITY,
    };
    this.filterOpts = {
      filterProperty: opts.filterProperty,
      filterRange: opts.filterRange,
      filterSoftRange: opts.filterSoftRange,
      filterEnabled: opts.filterEnabled,
      filterTransformSize: opts.filterTransformSize,
      filterTransformColor: opts.filterTransformColor,
    };
    this.shaderConfig = {
      mode: this.resolveMode(),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
    };
    // [mercX, mercY, startTime, endTime, radius, fade] (+ filterValue).
    this.stride = this.shaderConfig.filter ? 7 : 6;
    this.mainKey = tripHeadsProgramKey('main', this.shaderConfig);
    this.pickKey = tripHeadsProgramKey('pick', this.shaderConfig);
  }

  private resolveMode(): TripHeadsTimeFilterMode {
    const { mode, degraded } = resolveTripHeadsTimeFilterMode(
      this.headOpts.timeFilterMode,
      this.headOpts.wakeLength,
    );
    if (degraded && !this.warnedUnsupportedMode) {
      this.warnedUnsupportedMode = true;
      console.warn(
        `[${this.id}] timeFilterMode '${this.headOpts.timeFilterMode}' describes a ` +
          `history, which a single moving head cannot express — use STTTripsLayer ` +
          `for that; rendering in 'window' mode.`,
      );
    }
    return mode;
  }

  // ── runtime setters ───────────────────────────────────────────────────────

  /** Update the constant head colour. */
  setColor(color: [number, number, number, number]): void {
    this.headOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Update the head radius (in `radiusUnits`). */
  setRadius(radius: number): void {
    this.headOpts.radius = radius;
    this.map?.triggerRepaint();
  }

  /** Toggle the contrast ring. */
  setStroked(stroked: boolean): void {
    this.headOpts.stroked = stroked;
    this.map?.triggerRepaint();
  }

  /**
   * Switch time-filter mode at runtime. The mode is compiled in, so this links
   * a second program on the next frame (cached from then on) and re-records
   * every tile VAO against it.
   */
  setTimeFilterMode(mode: STTTimeFilterMode): void {
    this.headOpts.timeFilterMode = mode;
    this.applyShaderConfig();
  }

  /** Update the wake length (ms) — selects wake mode when it goes positive. */
  setWakeLength(wakeLength: number): void {
    this.headOpts.wakeLength = wakeLength;
    this.applyShaderConfig();
  }

  /**
   * Update the interpolation integrity guard (ms). CPU-only — no relink, no
   * tile rebuild: the next frame's `sampleTrack` reads it.
   */
  setMaxInterpolationGap(maxInterpolationGap: number): void {
    this.headOpts.maxInterpolationGap = maxInterpolationGap;
    this.map?.triggerRepaint();
  }

  /**
   * Move the DataFilter's hard `[min, max]` bounds (the slider hot path).
   * Uniform-only: no relink, no tile rebuild. `null` idles the filter.
   */
  setFilterRange(range: DataFilterRange | null): void {
    this.filterOpts.filterRange = range;
    this.map?.triggerRepaint();
  }

  /** Move the DataFilter's soft fade margin. Uniform-only. */
  setFilterSoftRange(range: DataFilterRange | null): void {
    this.filterOpts.filterSoftRange = range;
    this.map?.triggerRepaint();
  }

  /** Master DataFilter switch. `false` renders every head unfiltered. */
  setFilterEnabled(enabled: boolean): void {
    this.filterOpts.filterEnabled = enabled;
    this.map?.triggerRepaint();
  }

  /**
   * Recompute the compiled configuration after a mode knob moved, dropping the
   * memoized handles so the next draw resolves (and links, once) the program
   * for the new key. Tile VAOs carry the key in `vaoVariant` and rebuild
   * themselves on the same draw.
   */
  private applyShaderConfig(): void {
    const mode = this.resolveMode();
    if (mode === this.shaderConfig.mode) {
      this.map?.triggerRepaint();
      return;
    }
    this.shaderConfig = { ...this.shaderConfig, mode };
    this.mainKey = tripHeadsProgramKey('main', this.shaderConfig);
    this.pickKey = tripHeadsProgramKey('pick', this.shaderConfig);
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
    this.map?.triggerRepaint();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.LineString;
  }

  // Programs are built lazily per (host shader variant × time mode) through
  // the base program cache; nothing to allocate eagerly. The base invalidates
  // that cache on context loss and dispose.
  protected onContextReady(): void {}

  protected onContextLost(): void {
    // Program lifetimes are owned by the base per-variant cache; only the
    // handle references are ours to clear.
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  // ── tile upload ───────────────────────────────────────────────────────────

  /**
   * Build the per-tile state: the trip tracks (CPU) plus the two persistent
   * instance buffers, allocated ONCE at the tile's maximum possible head count
   * (its usable trip count) and rewritten with `bufferSubData` each frame.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): TripHeadsGpuCache | null {
    const f = layer.features;
    const trackSet = buildTripTracks(f);
    if (!trackSet) return null;
    const capacity = trackSet.tracks.length;

    const featureColors = this.headOpts.colorProperty
      ? this.expandCategoricalColors(
          f,
          this.headOpts.colorProperty,
          this.headOpts.colorPalette,
          this.headOpts.colorMapping,
          this.headOpts.colorMappingDefault,
        )
      : null;
    const featureRadii = this.headOpts.radiusProperty
      ? this.getNumericProperty(f, this.headOpts.radiusProperty)
      : null;

    let filterValues: Float32Array | null = null;
    let hasFilterColumn = false;
    if (this.shaderConfig.filter) {
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical && !this.warnedCategoricalFilter) {
        this.warnedCategoricalFilter = true;
        console.warn(
          `[${this.id}] filterProperty '${this.filterOpts.filterProperty}' is a ` +
            `categorical column; range filtering needs a numeric one — rendering unfiltered`,
        );
      }
      filterValues = col.values;
      hasFilterColumn = col.hasColumn;
    }

    // Persistent instance storage. `bufferData(target, size, usage)` allocates
    // without an upload; every frame writes a prefix of it via bufferSubData.
    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * this.stride * 4, gl.DYNAMIC_DRAW);

    const extras: WebGLBuffer[] = [];
    let colorBuffer: WebGLBuffer | undefined;
    if (featureColors) {
      colorBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, capacity * 4, gl.DYNAMIC_DRAW);
      extras.push(colorBuffer);
    }

    // The base TileGpuCache contract wants a `timeBuffer`; the per-feature
    // [start,end] pair rides the per-frame instance buffer here (it must follow
    // the compacted active-head order), so this is a zero-length placeholder —
    // the same shape STTTripsLayer uses.
    const timeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);

    return {
      positionBuffer: instanceBuffer,
      instanceBuffer,
      colorBuffer,
      timeBuffer,
      extraBuffers: extras.length > 0 ? extras : undefined,
      vertexCount: 0,
      indexCount: 0,
      timeOffset: f.timeOffset,
      trackSet,
      sourceStartTimes: f.startTimes,
      sourceEndTimes: f.endTimes,
      featureColors,
      featureRadii,
      filterValues,
      hasFilterColumn,
      activeFeatureIndex: new Uint32Array(capacity),
      activeCount: 0,
      capacity,
    };
  }

  // ── per-frame head emit ───────────────────────────────────────────────────

  /** Grow the shared per-frame scratch to hold `capacity` heads. */
  private ensureScratch(capacity: number): void {
    const floats = capacity * this.stride;
    if (this.floatScratch.length < floats) {
      this.floatScratch = new Float32Array(floats);
    }
    if (this.colorScratch.length < capacity * 4) {
      this.colorScratch = new Uint8Array(capacity * 4);
    }
  }

  /**
   * Interpolate every ACTIVE trip's head at `ctx.currentTime` and upload the
   * result into the tile's persistent instance buffer(s). Returns the head
   * count, which is also the draw's vertex count.
   *
   * This is the one per-frame buffer write in the backend, and it is the
   * design: the heads move continuously, so their positions cannot be baked.
   * Everything else stays allocation-free — the scratch arrays are per-LAYER
   * and grow-only, and the sample config is refilled in place. `sampleTrack`
   * itself allocates one small `Sample` per ACTIVE head per frame (unchanged
   * upstream behaviour; see the layer's concerns).
   *
   * Track times are ABSOLUTE epoch-ms, so the playhead goes in unmodified; the
   * `[startTime, endTime]` pair written for the GPU time gate stays
   * TILE-RELATIVE, matching `uWindowStart` / `uCurrentTime`.
   */
  private emitHeads(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    cache: TripHeadsGpuCache,
    ctx: DrawContext,
  ): number {
    this.ensureScratch(cache.capacity);
    const F = this.floatScratch;
    const C = this.colorScratch;
    const stride = this.stride;
    const { tracks, featureIndex } = cache.trackSet;
    const { featureColors, featureRadii, filterValues, activeFeatureIndex } =
      cache;
    const constRadius = this.headOpts.radius;
    const now = ctx.currentTime;

    // Frame-constant sample knobs, refilled in place (never re-allocated).
    // WAKE mode takes NO CPU fade: `sttWakeAlpha` already ramps from the trip's
    // own start, which is the same instant `sampleTrack`'s fade-in measures
    // from, so keeping both would apply one ramp twice — and the doubled value
    // also drives `sttWakeSizeScale`, inverting the tail taper. See MODE_ALPHA.
    const wake = this.shaderConfig.mode === 'wake';
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    const cfg = this.sampleCfg;
    cfg.fadeInDuration = wake ? 0 : fadeIn;
    cfg.fadeOutDuration = wake ? 0 : fadeOut;
    cfg.maxGapMs = this.headOpts.maxInterpolationGap;

    const startTimes = cache.sourceStartTimes;
    const endTimes = cache.sourceEndTimes;

    let n = 0;
    for (let k = 0; k < tracks.length; k++) {
      const s = sampleTrack(tracks[k], now, cfg);
      if (!s) continue; // playhead outside this trip ⇒ no dot (deck parity)
      const fi = featureIndex[k];
      const o = n * stride;
      writeMercator(s.lon, s.lat, F, o);
      F[o + 2] = startTimes[fi];
      F[o + 3] = endTimes[fi];
      F[o + 4] = featureRadii ? featureRadii[fi] : constRadius;
      F[o + 5] = s.alpha;
      if (stride > 6) F[o + 6] = filterValues ? filterValues[fi] : 0;
      if (featureColors) {
        const c = n * 4;
        const b = fi * 4;
        C[c] = featureColors[b];
        C[c + 1] = featureColors[b + 1];
        C[c + 2] = featureColors[b + 2];
        C[c + 3] = featureColors[b + 3];
      }
      activeFeatureIndex[n] = fi;
      n++;
    }

    cache.activeCount = n;
    if (n === 0) return 0;

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, F.subarray(0, n * stride));
    if (featureColors && cache.colorBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.colorBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, C.subarray(0, n * 4));
    }
    return n;
  }

  // ── uniforms ──────────────────────────────────────────────────────────────

  /**
   * The `uRadiusScale` value for this tile. In `'pixels'` mode it is the plain
   * `radiusScale` multiplier. In `'meters'` mode the metres→device-pixels
   * factor at the TILE CENTRE's latitude and the map's FRACTIONAL zoom is
   * folded in, so the dot covers a fixed patch of ground and grows continuously
   * with zoom rather than stepping at integer zooms.
   */
  private resolveRadiusScale(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const scale = this.headOpts.radiusScale;
    if (this.headOpts.radiusUnits !== 'meters') return scale;
    // Shared base helper (fractional zoom + dpr + tile-centre latitude).
    return scale * this.metricPixelScale(gl, tile, ctx);
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode.
   *
   * Window mode runs with HARD edges: the appear/disappear ramp is already
   * applied on the CPU by `sampleTrack` against the TRIP's own span and reaches
   * the shader as `aFade`, so pushing the same `fadeIn`/`fadeOut` here would
   * square it. See the module header.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: HeadsSharedHandles,
    cache: TripHeadsGpuCache,
    ctx: DrawContext,
  ): void {
    if (this.shaderConfig.mode === 'wake') {
      gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
      gl.uniform1f(h.uWakeLength, this.headOpts.wakeLength);
      gl.uniform1f(h.uWakeTailScale, this.headOpts.wakeTailScale);
      return;
    }
    gl.uniform1f(h.uWindowStart, ctx.windowStart);
    gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
    gl.uniform1f(h.uFadeIn, 0);
    gl.uniform1f(h.uFadeOut, 0);
  }

  /**
   * Upload the DataFilter uniforms for this tile. No-op unless the filter was
   * compiled in. A tile that didn't bake the column resolves to `enabled: 0`,
   * which the kernel reads as "render everything" — never as "hide everything".
   */
  private setFilterUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: HeadsSharedHandles,
    cache: TripHeadsGpuCache,
  ): void {
    if (!this.shaderConfig.filter) return;
    const u = resolveDataFilterUniforms(
      this.filterUniforms,
      this.filterOpts,
      cache.hasFilterColumn && h.aFilterValue >= 0,
    );
    gl.uniform2fv(h.uFilterRange, u.range);
    gl.uniform2fv(h.uFilterSoftRange, u.softRange);
    gl.uniform1f(h.uFilterEnabled, u.enabled);
    gl.uniform1f(h.uFilterTransformSize, u.transformSize);
    gl.uniform1f(h.uFilterTransformColor, u.transformColor);
  }

  /**
   * Projection + sizing + time + filter uniforms — everything the visual and id
   * passes set identically, so the pickable disc always matches the drawn one
   * (including on globe, where the prelude owns projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: HeadsSharedHandles,
    tile: Tile,
    cache: TripHeadsGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude's projectTile owns projection.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform1f(h.uRadiusScale, this.resolveRadiusScale(gl, tile, ctx));
    gl.uniform2f(
      h.uRadiusPixelRange,
      this.headOpts.radiusMinPixels,
      this.headOpts.radiusMaxPixels,
    );
    // Colour is shared because its ALPHA gates the id pass as well as painting
    // the visual one — set here so neither pass can resolve it differently.
    gl.uniform4fv(h.uColor, this.rgba01Uniform('Color', this.headOpts.color));
    gl.uniform1f(
      h.uUseFeatureColor,
      cache.colorBuffer && h.aColor >= 0 ? 1 : 0,
    );
    this.setTimeUniforms(gl, h, cache, ctx);
    this.setFilterUniforms(gl, h, cache);
  }

  // ── attribute binding ─────────────────────────────────────────────────────

  /**
   * Bind the interleaved per-head attributes both passes share — INCLUDING the
   * per-head colour, which the id pass needs to gate on its alpha (see
   * `buildTripHeadsVs`), so the two passes can never disagree about which heads
   * are visible.
   */
  private bindSharedAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: HeadsSharedHandles,
    cache: TripHeadsGpuCache,
  ): void {
    const bytes = this.stride * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.instanceBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 2, gl.FLOAT, false, bytes, 0);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, bytes, 8);
    gl.enableVertexAttribArray(h.aRadius);
    gl.vertexAttribPointer(h.aRadius, 1, gl.FLOAT, false, bytes, 16);
    gl.enableVertexAttribArray(h.aFade);
    gl.vertexAttribPointer(h.aFade, 1, gl.FLOAT, false, bytes, 20);
    if (this.shaderConfig.filter && h.aFilterValue >= 0) {
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, bytes, 24);
    }
    if (cache.colorBuffer && h.aColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.colorBuffer);
      gl.enableVertexAttribArray(h.aColor);
      gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    }
  }

  /** Resolve the locations every trip-heads program declares. */
  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): HeadsSharedHandles {
    const usesPrelude = shader.prelude.length > 0;
    return {
      program,
      usesPrelude,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aRadius: gl.getAttribLocation(program, 'aRadius'),
      aFade: gl.getAttribLocation(program, 'aFade'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      aColor: gl.getAttribLocation(program, 'aColor'),
      // uMatrix is undeclared on prelude variants — never look it up there so
      // the legacy MVP cannot be pushed to a projectTile program.
      uMatrix: usesPrelude ? null : gl.getUniformLocation(program, 'uMatrix'),
      uRadiusScale: gl.getUniformLocation(program, 'uRadiusScale'),
      uRadiusPixelRange: gl.getUniformLocation(program, 'uRadiusPixelRange'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
      uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
      uWakeLength: gl.getUniformLocation(program, 'uWakeLength'),
      uWakeTailScale: gl.getUniformLocation(program, 'uWakeTailScale'),
      uFilterRange: gl.getUniformLocation(program, DATA_FILTER_NAMES.range),
      uFilterSoftRange: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.softRange,
      ),
      uFilterEnabled: gl.getUniformLocation(program, DATA_FILTER_NAMES.enabled),
      uFilterTransformSize: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.transformSize,
      ),
      uFilterTransformColor: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.transformColor,
      ),
    };
  }

  /** Link the visual program for a variant and resolve its locations. */
  private buildMainHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): HeadsProgramHandles {
    const program = this.linkProgram(
      gl,
      buildTripHeadsVertexSource(shader, this.shaderConfig),
      FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      uStrokeWidth: gl.getUniformLocation(program, 'uStrokeWidth'),
      uStrokeColor: gl.getUniformLocation(program, 'uStrokeColor'),
    };
  }

  /** Link the id-pick program for a variant and resolve its locations. */
  private buildIdHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): HeadsIdProgramHandles {
    const program = this.linkProgram(
      gl,
      buildTripHeadsIdVertexSource(shader, this.shaderConfig),
      ID_FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
    };
  }

  // ── draw ──────────────────────────────────────────────────────────────────

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const c = cache as TripHeadsGpuCache;
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const variant = frame.shader.variantName;
    let h = this.handles;
    if (!h || this.handlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.mainKey, frame, (g, s) =>
        this.buildMainHandles(g, s),
      );
      this.handles = h;
      this.handlesVariant = variant;
      // `mainKey` and `variant` are the only two inputs, and `applyShaderConfig`
      // clears `handlesVariant` whenever `mainKey` moves — so this branch is the
      // exact set of frames where the key can change. Never rebuilt per tile.
      this.mainVaoKey = `${this.mainKey}::${variant}`;
    }

    // Interpolate + upload FIRST: the buffer contents change every frame, but
    // the VAO records only bindings/pointers, so a bufferSubData never
    // invalidates it.
    const count = this.emitHeads(gl, c, ctx);
    if (count === 0) return; // no trip is active at the playhead

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);
    gl.uniform1f(
      h.uStrokeWidth,
      this.headOpts.stroked ? this.headOpts.strokeWidth : 0,
    );
    gl.uniform4fv(
      h.uStrokeColor,
      this.rgba01Uniform('StrokeColor', this.headOpts.strokeColor),
    );

    // A VAO records attribute locations against ONE program — drop it when the
    // host flipped shader variants, or the layer flipped time-filter mode, so
    // it re-records against `h`.
    const vaoKey = this.mainVaoKey;
    if (c.vao && c.vaoVariant !== vaoKey) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    this.bindVaoOrSetup(c, () => this.bindSharedAttributes(gl, h!, c));
    c.vaoVariant = vaoKey;

    gl.drawArrays(gl.POINTS, 0, count);
  }

  /**
   * Per-head id colours. Unlike every other layer in this backend the draw
   * order is NOT feature order — heads are emitted active-only — so each id is
   * built from the recorded SOURCE feature index rather than the loop counter.
   * That is what makes this layer pickable at all where deck's equivalent gives
   * up (`pickable: false`, "the active-only buffer reorders indices").
   *
   * `featureCount` is the width the base RESERVED for this (tile, layer); a
   * head whose feature index falls outside it stays id 0 (background) rather
   * than borrowing the next entry's ids and mis-resolving the pick.
   */
  private buildActiveIdColors(
    cache: TripHeadsGpuCache,
    idBase: number,
    count: number,
    featureCount: number,
  ): Uint8Array {
    if (!Number.isInteger(idBase) || idBase < 1) {
      throw new RangeError(
        `buildActiveIdColors: idBase must be a positive integer (1-based), got ${idBase}`,
      );
    }
    if (this.idScratch.length < count * 3) {
      this.idScratch = new Uint8Array(count * 3);
    }
    const out = this.idScratch;
    for (let i = 0; i < count; i++) {
      const fi = cache.activeFeatureIndex[i];
      if (fi >= featureCount) {
        out[i * 3] = 0;
        out[i * 3 + 1] = 0;
        out[i * 3 + 2] = 0;
        continue;
      }
      const [r, g, b] = encodePickId(idBase + fi);
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    return out;
  }

  /**
   * Draw this tile's heads into the id-pick FBO. Mirrors {@link drawTile}'s
   * projection variant, sizing and — critically — its ALPHA GATES (same time
   * mode, same CPU fade attribute, same DataFilter range), so a head the user
   * cannot see is never pickable. Browser-verify-only (the enclosing FBO
   * round-trip needs a live GPU); the id-colour build + decode join are
   * unit-tested.
   *
   * The heads are re-interpolated here rather than reusing the last frame's
   * buffer: a pick is issued from a `mousemove` handler, so the playhead may
   * have advanced since the last paint, and picking a stale position would
   * hit-test geometry that is no longer on screen.
   *
   * Raw attribute binds, no VAO: the id buffer is per-pass and picking is a
   * rare user-initiated event, so a cached VAO would only go stale.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const c = cache as TripHeadsGpuCache;
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const variant = frame.shader.variantName;
    let h = this.idHandles;
    if (!h || this.idHandlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.pickKey, frame, (g, s) =>
        this.buildIdHandles(g, s),
      );
      this.idHandles = h;
      this.idHandlesVariant = variant;
    }

    const count = this.emitHeads(gl, c, ctx);
    if (count === 0) return; // nothing visible ⇒ nothing pickable

    const idBuffer = this.uploadArrayBuffer(
      gl,
      this.buildActiveIdColors(
        c,
        idBase,
        count,
        layer.features.featureCount,
      ).subarray(0, count * 3),
    );

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);
    this.bindSharedAttributes(gl, h, c);

    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawArrays(gl.POINTS, 0, count);

    // Leave the default-VAO attribute slate clean so the next visual frame's
    // VAO setup starts fresh, and drop the one-shot id buffer. Nothing here is
    // instanced, so there are no divisors to reset.
    for (const loc of [
      h.aMercator,
      h.aTime,
      h.aRadius,
      h.aFade,
      h.aIdColor,
      h.aFilterValue,
      // Mirrors bindSharedAttributes' own condition — disabling a slot that was
      // never enabled would leave the two out of step.
      c.colorBuffer ? h.aColor : -1,
    ]) {
      if (loc < 0) continue;
      gl.disableVertexAttribArray(loc);
    }
    gl.deleteBuffer(idBuffer);
  }
}
