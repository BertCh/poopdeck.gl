// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

import { LayerExtension } from '@deck.gl/core';
import type {
  Layer,
  LayerContext,
  Accessor,
  DefaultProps,
} from '@deck.gl/core';
// Relativization scheme moved to the framework-free kernel; imported for internal
// use here and re-exported below so the `@poopdeck.gl/layers` barrel is unchanged.
import {
  relativizeTime,
  assertRelTimeInRange,
  MAX_RELATIVE_TIME_MS,
  DEFAULT_WAKE_TAIL_SCALE,
} from '@poopdeck.gl/core/time-filter';
import { warnOnce } from '../lib/log.js';

/**
 * "This feature never stops being visible", expressed as the largest FINITE
 * Float32.
 *
 * `Infinity` cannot be used, and that is not a style preference. deck runs
 * every constant attribute value through `DataColumn._normalizeValue`
 * (core/lib/attribute/data-column.ts), which for a size-1 attribute evaluates
 * `Number.isFinite(value[0]) ? value[0] : defaultValue[0]`. `Infinity[0]` is
 * `undefined`, so a literal `Infinity` writes the descriptor's `defaultValue`
 * — `0` when none is declared. The shader's window test then reads an end time
 * of 0 and hides the feature as soon as the playhead passes `timeWindow / 2`:
 * a silently blank layer with no warning. `defaultValue: Infinity` fails the
 * same way one level down (the raw non-finite number is kept and the buffer
 * fills with NaN).
 *
 * Exported so callers writing their own `getInstanceEndTime` accessor have the
 * sentinel to return instead of reaching for `Infinity`.
 *
 * The literal is the EXACT f32 maximum as a JS double
 * (`(2 - 2^-23) * 2^127`), not the rounded `3.4028235e38` — so the value
 * survives the Float32Array store unchanged and the CPU-side and GPU-side
 * comparisons agree bit for bit.
 */
export const NEVER_ENDS = 3.4028234663852886e38;

/**
 * Props for layers using TimeFilterExtension
 */
export type TimeFilterExtensionProps<DataT = unknown> = {
  /**
   * Current time for filtering (Unix milliseconds).
   * @default 0
   */
  currentTime?: number;
  /**
   * Dynamic time getter — called every `draw()` so the layer instance can
   * stay cached across animation ticks (only uniforms update each frame).
   * Takes priority over `currentTime` when set.
   * @default null
   */
  getTime?: (() => number) | null;
  /**
   * CRITICAL - float32 precision.
   *
   * Per-feature/per-vertex times supplied as attributes (instanceStartTime etc.) are
   * stored RELATIVE to this offset (i.e. the values as they come from the binary tile,
   * relative to `binary.timeOffset`). Absolute epoch-ms (~1.7e12) cannot be represented
   * in a Float32Array / f32 uniform without ~131s quantization.
   *
   * This extension subtracts `timeOffset` from the resolved current time on the CPU
   * before uploading the `currentTime` uniform, so BOTH sides of every shader
   * comparison are small relative numbers that fit exactly in f32.
   *
   * The layer MUST pass the SAME offset it used to relativize the attributes.
   * @default 0
   */
  timeOffset?: number;
  /**
   * Time window size in milliseconds.
   * @default 0
   */
  timeWindow?: number;
  /**
   * Fade-in duration for appearing objects (ms).
   * @default 0
   */
  fadeInDuration?: number;
  /**
   * Fade-out duration for disappearing objects (ms).
   * @default 0
   */
  fadeOutDuration?: number;
  /**
   * Trail length in milliseconds (path/trips effect). When > 0, progressive
   * drawing with trailing fade: the path renders from
   * `(currentTime - trailLength)` to `currentTime`.
   * @default 0
   */
  trailLength?: number;
  /**
   * In trail mode, whether the trail fades head→tail (`true`, the classic
   * comet trail) or renders at constant opacity along its whole length
   * (`false`, a solid snake). Has no effect outside trail mode.
   *
   * DIVERGES from upstream `TripsLayer` under `fadeTrail: false`. Upstream
   * discards a vertex only when
   * `vTime > currentTime || (fadeTrail && vTime < currentTime - trailLength)`,
   * so switching the fade off ALSO switches the tail cull off: the whole
   * traversed path stays drawn ("ink the route as it is driven"). Here the
   * tail is ALWAYS culled at `currentTime - trailLength` and `fadeTrail` only
   * selects the ramped-vs-flat alpha, so `fadeTrail: false` is a fixed-length
   * SOLID SNAKE, not an ever-growing inked route. Use `cumulative: true` for
   * the draw-and-persist look. The cull is deliberate and shared: it mirrors
   * `trailAlpha()` in `@poopdeck.gl/core/time-filter` — the kernel oracle the
   * three and maplibre backends are pinned against — so it cannot be changed
   * in deck alone.
   * @default true
   */
  fadeTrail?: boolean;
  /**
   * Wake length in milliseconds (point-layer "ship wake" aesthetic).
   * When > 0, takes precedence over window/trail mode: features are shown
   * only when `0 <= currentTime - instanceStartTime <= wakeLength`, alpha
   * fades linearly to zero at the trailing edge, and point size shrinks to
   * `wakeTailScale` of the head radius at the trailing edge.
   *
   * The host layer is responsible for setting `timeWindow >= 2 * wakeLength`
   * so the tile loader actually loads the past half of the wake — the shader
   * filter is independent of the tile-loading window.
   */
  wakeLength?: number;
  /**
   * Trailing-edge size multiplier in wake mode (0..1). Head = 1.0, tail =
   * `wakeTailScale`. Defaults to 0.15 — the "barely visible dot" end of a
   * comet tail.
   */
  wakeTailScale?: number;
  /**
   * Cumulative ("draw and persist") mode. When true, takes precedence over
   * window/wake/trail: a feature becomes visible once `instanceStartTime <=
   * currentTime` and then stays visible for the rest of playback (it is never
   * hidden as the play head advances). Ideal for "watch it get built" datasets
   * — e.g. OSM node creations inking a city in over time. `fadeInDuration`
   * still applies as an "appear" ramp; `instanceEndTime` is ignored.
   *
   * The host layer must keep already-revealed tiles resident — set the tile
   * loader's window wide enough to cover the played-through range (the shader
   * filter does the progressive reveal, not the loader).
   * @default false
   */
  cumulative?: boolean;
  /**
   * Time-as-height ("space-time cube"): meters of altitude per simulation
   * millisecond. When non-zero, every vertex is lifted vertically by
   * `(featureTime - timeHeightOrigin) * timeHeightScale` meters — per-VERTEX
   * time in trail mode (`trailLength > 0`), per-FEATURE start time otherwise.
   * A single uniform, so animating it (the "squash" morph between flat map
   * and cube) costs nothing per frame.
   * @default 0 (off)
   */
  timeHeightScale?: number;
  /**
   * Absolute time (Unix ms) mapped to altitude 0 in time-as-height mode —
   * typically the dataset's `timeRange.start`. Relativized against
   * `timeOffset` on the CPU like every other time in this extension.
   *
   * UNSET SENTINEL — `null` (the default) means "anchor altitude 0 at this
   * tile's own `timeOffset`", i.e. the shader subtracts a relative origin of
   * exactly `0`. A literal `0` is treated the SAME way: altitude 0 at the Unix
   * epoch is never a real request, and taking it literally is catastrophic —
   * with `timeOffset ≈ 1.7e12` the `heightOrigin` uniform becomes ≈ -1.7e12,
   * whose f32 ULP is 131,072, so every feature within ~131 s collapses to one
   * altitude AND the whole layer lifts `1.7e12 * timeHeightScale` metres off
   * the planet. Both spellings therefore idle to the tile-local anchor.
   *
   * Pass the dataset's `timeRange.start` for a cube whose altitudes agree
   * ACROSS temporal chunks — the tile-local fallback anchors each chunk at its
   * own zero, which is exact for single-chunk datasets and a per-chunk rebase
   * otherwise.
   * @default null (anchor at the tile's `timeOffset`)
   */
  timeHeightOrigin?: number | null;
  /**
   * Accessor returning a feature's start time.
   * @default 0
   */
  getInstanceStartTime?: Accessor<DataT, number>;
  /**
   * Accessor returning a feature's end time.
   *
   * Defaults to {@link NEVER_ENDS} (the largest finite f32), NOT
   * `Infinity`. deck normalizes every constant attribute value through
   * `DataColumn._normalizeValue`, which rejects non-finite numbers and falls
   * back to the descriptor's `defaultValue` — so a literal `Infinity` here
   * silently becomes `0` and the shader hides every feature the moment the
   * playhead passes `timeWindow / 2`. Return a large finite number from a
   * custom accessor for the same reason.
   *
   * @default 3.4028234663852886e38 (the f32 maximum)
   */
  getInstanceEndTime?: Accessor<DataT, number>;
  /**
   * Accessor for the per-vertex timestamp used in trail mode. Layers that
   * don't use trail mode never supply this; default `0` keeps deck.gl happy
   * because the attribute is always registered.
   * @default 0
   */
  getInstanceVertexTime?: Accessor<DataT, number>;
  /**
   * Re-points `instanceEndTime` from "this FEATURE's end time" to "the NEXT
   * VERTEX's time", which is what lets a trail glide instead of stepping.
   *
   * Trail mode reads one time per segment instance (`instanceVertexTime`, the
   * segment's START vertex), so `vTimeAlpha` is constant across the whole
   * segment quad: the head jumps a whole segment at a time and the fade is a
   * staircase. Upstream `TripsLayer` avoids that by binding a SECOND shader
   * view of the timestamp buffer at `vertexOffset: 1` and interpolating along
   * the segment — but a second view costs its own vertex-attribute slot, and
   * this pipeline already sits at WebGL2's guaranteed 16-slot floor (see
   * {@link AnimatedTripsLayer}'s attribute-budget note).
   *
   * `instanceEndTime` is the slot that pays for itself here: in TRAIL mode the
   * shader never reads it (only window mode does), so a trail-only layer can
   * hand it the next vertex's time and get the interpolation for free. Setting
   * this flag tells the shader about the reinterpretation, and window mode
   * falls back to {@link NEVER_ENDS} — exactly the constant a trail layer's
   * unset `getInstanceEndTime` accessor would have supplied anyway.
   *
   * The interpolation itself is injected only for PATH-family layers (it reads
   * PathLayer's `vPathPosition` / `vPathLength` varyings) — see the extension's
   * `pathSegmentTime` option. This prop without that option still culls whole
   * segments by both endpoints, it just doesn't glide.
   * @default false
   */
  segmentTime?: boolean;
};

// Define uniform types for the shader module
type TimeFilterUniformProps = {
  currentTime: number;
  windowHalf: number;
  fadeIn: number;
  fadeOut: number;
  trailLength: number;
  /** 1.0 = fade trail head→tail; 0.0 = solid trail at constant opacity. */
  trailFade: number;
  wakeLength: number;
  wakeTailScale: number;
  /** 1.0 = cumulative "draw and persist" mode; 0.0 = off. */
  cumulative: number;
  /** Meters of altitude per sim-ms in time-as-height mode; 0 = off. */
  heightScale: number;
  /**
   * Relative time (vs the layer timeOffset) mapped to altitude 0. `0` — the
   * resolved "unset" default — anchors the cube at the tile's own timeOffset.
   */
  heightOrigin: number;
  /**
   * 1.0 = `instanceEndTime` carries the NEXT VERTEX's time rather than the
   * feature's end time (see the `segmentTime` prop); 0.0 = off.
   */
  segmentTime: number;
};

// Uniform block for GLSL 3.0 (WebGL2). layout(std140) matches upstream
// extension convention and the std140 packing luma's UniformStore writes.
// Scalar-only blocks happen to pack identically either way, but an explicit
// layout keeps the block safe the day someone adds a vec3.
const glslUniformBlock = `\
layout(std140) uniform timeFilterUniforms {
  float currentTime;
  float windowHalf;
  float fadeIn;
  float fadeOut;
  float trailLength;
  float trailFade;
  float wakeLength;
  float wakeTailScale;
  float cumulative;
  float heightScale;
  float heightOrigin;
  float segmentTime;
} timeFilter;
`;

// Attribute + varying declarations live in the shader MODULE source, NOT in a
// `vs:#decl` / `fs:#decl` injection. deck's `mergeShaders` concatenates
// same-key injections with NO dedup, so a layer that ends up with two
// TimeFilterExtension instances — e.g. `new AnimatedPointLayer({extensions:
// [new TimeFilterExtension()]})`, which appends the caller's instance to the
// internal one — would emit these `in`/`out` lines TWICE and fail to link, and
// the layer would render nothing. luma dedupes shader MODULES by name
// (`getShaderModuleDependencies` keys a map on `module.name`), so declaring
// them here makes a duplicated extension harmless. Module sources are emitted
// ahead of every `#decl` injection and the layer's own source, so everything
// downstream still sees them. Same placement as upstream
// `@deck.gl/extensions`' data-filter shader module.
const glslVertexDecl = `\
// Per-vertex timestamp, RELATIVE to the layer timeOffset (trail mode).
in float instanceVertexTime;
// Feature-level times, RELATIVE to the layer timeOffset. Under segmentTime,
// instanceEndTime is re-pointed at the NEXT VERTEX's time instead; see the
// prop docstring. (Shader sources stay ASCII: this string is concatenated
// straight into GLSL, and a compile failure here blanks the layer.)
in float instanceStartTime;
in float instanceEndTime;
out float vTimeAlpha;
// Time at THIS FRAGMENT, interpolated along the segment under \`segmentTime\`
// (else a constant copy of instanceVertexTime). Always written, so the
// varying is never read undefined on layers that don't interpolate.
out float vSegTime;
`;

const glslFragmentDecl = `\
in float vTimeAlpha;
in float vSegTime;
`;

// Trail fade evaluated PER FRAGMENT from the interpolated \`vSegTime\`, so the
// head glides along a segment and the fade is continuous. Lives in the module
// (not an injection) so both the discard and the color hook can call it — GLSL
// locals don't cross injection points, and re-deriving it in each hook is a few
// ALU ops on an already fragment-bound path.
const glslFragmentHelpers = `\
float sttSegmentTrailAlpha() {
  float age = timeFilter.currentTime - vSegTime;
  if (age < 0.0 || age > timeFilter.trailLength) return 0.0;
  float faded = clamp(1.0 - age / timeFilter.trailLength, 0.0, 1.0);
  // trailFade == 1.0 -> classic head-to-tail fade; 0.0 -> solid trail.
  return mix(1.0, faded, timeFilter.trailFade);
}
`;

/**
 * `vs:#main-end` injection, in two flavours.
 *
 * BOTH collapse fully-hidden geometry at the VERTEX stage (upstream
 * DataFilterExtension does the same): a degenerate clip-space position
 * rasterizes zero fragments, so off-window features stop paying fragment cost —
 * at low zoom most features in a tile are outside the window. The collapse is
 * gated IN-SHADER on trail mode because window/wake/cumulative alphas are
 * whole-feature (every vertex agrees) while a STAIRCASE trail fades per-vertex,
 * and collapsing one end of a still-visible segment would drag its geometry to
 * the origin. `segmentTime` re-opens the door for trails: there `vTimeAlpha` is
 * a whole-SEGMENT flag derived from both endpoints, so a zero really does mean
 * "no part of this segment is in the trail" — and a trail lights a small slice
 * of a tile at any instant, so that reclaims the fragment cost of all the rest.
 *
 * The `pathSegmentTime` flavour additionally interpolates the segment's time.
 * `vPathPosition.y` is the distance along the segment from its start vertex and
 * `vPathLength` the segment's length, both written by PathLayer's
 * `getLineJoinOffset()` — hence #main-end (they are not set yet at #main-start,
 * and do not exist AT ALL on non-path layers, which is why this is an option
 * rather than shared). Same interpolation upstream `TripsLayer` does, minus the
 * second attribute slot: the head glides along the segment instead of jumping
 * from vertex to vertex.
 */
function glslMainEnd(pathSegmentTime: boolean): string {
  const interpolate = pathSegmentTime
    ? `
          if (timeFilter.segmentTime > 0.5) {
            float segT = vPathLength > 0.0
              ? clamp(vPathPosition.y / vPathLength, 0.0, 1.0)
              : 0.0;
            vSegTime = mix(instanceVertexTime, instanceEndTime, segT);
          }`
    : '';
  return `${interpolate}
          if (vTimeAlpha <= 0.0 &&
              (timeFilter.trailLength <= 0.0 || timeFilter.segmentTime > 0.5)) {
            gl_Position = vec4(0.);
          }
        `;
}

// Shader module definition for deck.gl 9.x
const timeFilterUniforms = {
  name: 'timeFilter',
  vs: `${glslUniformBlock}${glslVertexDecl}`,
  fs: `${glslUniformBlock}${glslFragmentDecl}${glslFragmentHelpers}`,
  uniformTypes: {
    currentTime: 'f32',
    windowHalf: 'f32',
    fadeIn: 'f32',
    fadeOut: 'f32',
    trailLength: 'f32',
    trailFade: 'f32',
    wakeLength: 'f32',
    wakeTailScale: 'f32',
    cumulative: 'f32',
    heightScale: 'f32',
    heightOrigin: 'f32',
    segmentTime: 'f32',
  },
};

const defaultProps: DefaultProps<TimeFilterExtensionProps> = {
  currentTime: 0,
  getTime: { type: 'function', value: null, optional: true },
  timeOffset: 0,
  timeWindow: 0,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  trailLength: 0,
  fadeTrail: true,
  wakeLength: 0,
  wakeTailScale: DEFAULT_WAKE_TAIL_SCALE,
  cumulative: false,
  timeHeightScale: 0,
  // Permissive {type:'object'} descriptor: holds a number OR the `null` "unset"
  // sentinel, which the 'number' validator would reject in deck's debug mode.
  timeHeightOrigin: { type: 'object', value: null, optional: true },
  getInstanceStartTime: { type: 'accessor', value: 0 },
  // NEVER_ENDS, not Infinity — see the prop doc and the constant's own note.
  getInstanceEndTime: { type: 'accessor', value: NEVER_ENDS },
  // Constant default: window-mode layers never set a per-vertex time, but the
  // attribute is always registered so deck.gl requires a valid accessor.
  getInstanceVertexTime: { type: 'accessor', value: 0 },
  segmentTime: false,
};

/**
 * Largest relative-time magnitude that survives a Float32 round-trip with
 * full millisecond precision. f32 has a 24-bit mantissa, so integers up to
 * 2^24 (16,777,216) are exact — i.e. ±~4.66 HOURS around `timeOffset`. Beyond
 * that, granularity doubles each octave (2 ms at 2^25 ≈ 9.3 h, 4 ms at 2^26 ≈
 * 18.6 h, …), staying under one 60 fps frame (16 ms) of error out to ~3 days.
 * So the practical contract: pick `timeOffset` PER TEMPORAL CHUNK (not once per
 * dataset) so the animated relative span stays inside this window; a mismatched
 * offset silently shifts every feature's time (the draw() guard warns once when
 * the resolved relative time crosses 2^24 in non-cumulative mode). Cumulative
 * mode intentionally spans years and accepts the coarser quantization (its
 * reveal steps by days, far above the millisecond floor).
 */
// `MAX_RELATIVE_TIME_MS` + `relativizeTime` now live in the framework-free kernel
// (`@poopdeck.gl/core/time-filter`) so all three renderer backends share ONE copy
// of the relativization scheme. Re-exported here to preserve this module's (and
// the `@poopdeck.gl/layers` barrel's) public API. See renderer-architecture.md.
export { relativizeTime, MAX_RELATIVE_TIME_MS };

/**
 * Distance between adjacent Float32 values at magnitude `x` (its ULP). f32
 * carries a 24-bit mantissa, so within the binade `[2^e, 2^(e+1))` the spacing
 * is `2^(e-23)`. Used to price the space-time-cube altitude error a far-away
 * `timeHeightOrigin` costs.
 */
function float32Ulp(x: number): number {
  const magnitude = Math.abs(x);
  if (!Number.isFinite(magnitude) || magnitude === 0) return 0;
  return 2 ** (Math.floor(Math.log2(magnitude)) - 23);
}

/** Altitude error (metres) above which a bad `timeHeightOrigin` is reported. */
const HEIGHT_ORIGIN_WARN_METERS = 1;

/**
 * Resolve `timeHeightOrigin` into the RELATIVE origin the shader subtracts
 * from each vertex's (already relative) time.
 *
 * `null` / `0` are both the "unset" sentinel → relative origin `0`, i.e.
 * altitude 0 sits at the tile's own `timeOffset`. See the prop docstring for
 * why a literal `0` cannot be taken at face value.
 *
 * The 2^24 rule that guards `currentTime` is the WRONG threshold here: a
 * legitimate multi-day `timeRange.start` is routinely millions of ms away from
 * a per-chunk `timeOffset` and costs only millimetres of altitude at realistic
 * height scales. What actually matters is the f32 quantization of
 * `heightTime - heightOrigin` PRICED IN METRES, so that is what we check.
 */
function resolveHeightOrigin(
  timeHeightOrigin: number | null | undefined,
  timeOffset: number,
  heightScale: number,
  warnKey: string,
): number {
  if (timeHeightOrigin == null || timeHeightOrigin === 0) return 0;
  const relativeOrigin = relativizeTime(timeHeightOrigin, timeOffset);
  if (heightScale !== 0) {
    const altitudeErrorM = float32Ulp(relativeOrigin) * Math.abs(heightScale);
    if (altitudeErrorM > HEIGHT_ORIGIN_WARN_METERS) {
      warnOnce(
        `TimeFilterExtension:timeHeightOrigin:${warnKey}`,
        `[TimeFilterExtension] timeHeightOrigin ${timeHeightOrigin} is ` +
          `${Math.abs(relativeOrigin)} ms from this tile's timeOffset ` +
          `${timeOffset}; the f32 space-time-cube lift quantizes to ` +
          `~${altitudeErrorM.toFixed(0)} m and the whole layer is offset by ` +
          `${Math.abs(relativeOrigin * heightScale).toFixed(0)} m. Set ` +
          "timeHeightOrigin to the dataset's timeRange.start (or leave it " +
          'null to anchor at the tile timeOffset).',
      );
    }
  }
  return relativeOrigin;
}

/**
 * Layer extension for GPU-based temporal filtering
 *
 * Filters and fades objects based on their time range relative to the current time.
 * Works with any layer that has temporal data.
 *
 * Float32 precision: all per-feature/per-vertex times are kept RELATIVE to a
 * per-layer `timeOffset`. The extension subtracts the same `timeOffset` from the
 * current time before setting the `currentTime` uniform. See `relativizeTime`.
 *
 * Supports two modes:
 * 1. Window mode (trailLength = 0): Show features whose time range overlaps with time window
 * 2. Trail mode (trailLength > 0): Progressive drawing with trailing fade for paths/trajectories
 *    - Uses instanceVertexTime (actual per-vertex timestamp) for smooth animation
 *    - Falls back to instanceStartTime/instanceEndTime for feature-level filtering
 *    - With the `segmentTime` prop (+ the `pathSegmentTime` option on path
 *      layers), instanceEndTime carries the NEXT VERTEX's time and the fade is
 *      interpolated ACROSS each segment in the fragment stage — a glide rather
 *      than one alpha per segment. See that prop's docstring.
 */
/**
 * Compatibility-mode placeholder. Earlier sprint iterations explored gating
 * the per-pipeline attribute count via mode-specific registration (drop
 * `instanceVertexTime` for window-only layers, drop `instanceStartTime`
 * + `instanceEndTime` for trail-only layers) to dodge the
 * `Too many attributes (instancePickingColors)` WebGL2 link error.
 * That path interacted badly with deck.gl 9.3's accessor fallback machinery
 * and tanked FPS on the per-tile sublayer demos (nyc-taxi-trips, hero-trips).
 *
 * The clean fix lives upstream in deck.gl 9.4 (which removes the picking
 * vertex attribute via `gl_InstanceID`). For 9.3, the link warning appears
 * on GPUs that report exactly 16 attribute slots but deck.gl falls back to a
 * non-picking shader and rendering proceeds — the warning is non-fatal.
 * The option exists for forward-compat with the 9.4 migration; today it
 * does not change behaviour.
 */
export type TimeFilterMode = 'auto' | 'window' | 'trail' | 'both';

export interface TimeFilterExtensionOptions {
  /**
   * Reserved for forward-compat with deck.gl 9.4's gl_InstanceID picking
   * path. Today all values behave identically.
   */
  mode?: TimeFilterMode;
  /**
   * Inject the per-segment time INTERPOLATION that turns the staircase trail
   * into a glide. Reads PathLayer's `vPathPosition` / `vPathLength` varyings,
   * so it is only legal on PATH-family layers (PathLayer and its subclasses) —
   * on a ScatterplotLayer or an ArcLayer those identifiers don't exist and the
   * shader fails to compile. Pair it with the layer prop `segmentTime: true`,
   * which is what actually arms the branch at draw time.
   *
   * Unlike {@link mode}, this genuinely changes the emitted GLSL. It is an
   * option (per-extension-INSTANCE `inject`) rather than a prop because deck
   * bakes shaders per extension instance, and the shared `timeFilterUniforms`
   * MODULE must stay byte-identical across every layer type — luma dedupes
   * modules by name, so a per-layer module variant would silently hand one
   * layer's source to another.
   * @default false
   */
  pathSegmentTime?: boolean;
}

const defaultOptions: Required<TimeFilterExtensionOptions> = {
  mode: 'auto',
  pathSegmentTime: false,
};

export class TimeFilterExtension extends LayerExtension<
  Required<TimeFilterExtensionOptions>
> {
  static defaultProps = defaultProps;
  static extensionName = 'TimeFilterExtension';

  /**
   * Memoized shader-injection object. deck.gl calls `getShaders()` on every
   * sublayer construction — one per visible tile. luma 9.3.3 keys its shader
   * and pipeline caches on SOURCE TEXT, so a NEW object literal carrying the
   * same strings still hits both caches (there is no re-link per tile); what
   * the memo saves is the per-sublayer allocation of the modules array +
   * inject strings and deck's `mergeShaders` pass over them. Cheap, and it
   * keeps object identity stable across all sublayers sharing the singleton.
   */
  private cachedShaders: {
    modules: unknown[];
    inject: Record<string, string>;
  } | null = null;

  // The `mode` option is currently a no-op (forward-compat hook for deck.gl
  // 9.4's `gl_InstanceID` picking path — see the type docstring above), but
  // it MUST still flow to super(): `LayerExtension.equals()` compares
  // `this.opts`, and dropping the options would make differently-configured
  // instances compare equal — deck would then skip shader regeneration the
  // day `mode` changes real behaviour. Same `{...defaults, ...opts}` pattern
  // as upstream DataFilterExtension. Singleton usage is unaffected: each
  // animated layer keeps reusing its one instance (identity short-circuit).
  constructor(options: TimeFilterExtensionOptions = {}) {
    super({ ...defaultOptions, ...options });
  }

  getShaders(
    this: Layer<TimeFilterExtensionProps>,
    extension: TimeFilterExtension,
  ) {
    if (extension.cachedShaders) return extension.cachedShaders;
    const shaders = {
      modules: [timeFilterUniforms],
      // NOTE: no `vs:#decl` / `fs:#decl` entries — the attribute and varying
      // declarations live in `timeFilterUniforms.vs/fs` so luma's name-based
      // module dedup protects a duplicated extension. See `glslVertexDecl`.
      // Every injection below is written to be idempotent under duplication:
      // locals are block-scoped, so a doubled injection re-links cleanly.
      inject: {
        'vs:#main-start': `
          vTimeAlpha = 1.0;
          // Default: every corner of the quad carries the segment's START
          // vertex time (today's staircase). Path layers built with
          // \`pathSegmentTime\` overwrite this at #main-end with the true
          // interpolated time along the segment.
          vSegTime = instanceVertexTime;

          if (timeFilter.cumulative > 0.0) {
            // "Draw and persist": visible once created, then stays forever.
            if (instanceStartTime > timeFilter.currentTime) {
              vTimeAlpha = 0.0;
            } else if (timeFilter.fadeIn > 0.0) {
              float age = timeFilter.currentTime - instanceStartTime;
              if (age < timeFilter.fadeIn) {
                vTimeAlpha = age / timeFilter.fadeIn;
              }
            }
          } else if (timeFilter.wakeLength > 0.0) {
            float age = timeFilter.currentTime - instanceStartTime;
            if (age < 0.0 || age > timeFilter.wakeLength) {
              vTimeAlpha = 0.0;
            } else {
              vTimeAlpha = 1.0 - (age / timeFilter.wakeLength);
            }
          } else if (timeFilter.trailLength > 0.0) {
            float trailStart = timeFilter.currentTime - timeFilter.trailLength;
            if (timeFilter.segmentTime > 0.5) {
              // instanceEndTime is the NEXT vertex's time, so the segment spans
              // [min, max] of the two and vTimeAlpha degrades to a whole-segment
              // VISIBILITY flag — the fade itself is per-fragment, off vSegTime.
              // Culling on the span (not just the start vertex) is what stops a
              // segment blinking out while the head is still crossing it.
              float segLo = min(instanceVertexTime, instanceEndTime);
              float segHi = max(instanceVertexTime, instanceEndTime);
              vTimeAlpha =
                (segHi < trailStart || segLo > timeFilter.currentTime) ? 0.0 : 1.0;
            } else {
              float vertexTime = instanceVertexTime;
              if (vertexTime > timeFilter.currentTime) {
                vTimeAlpha = 0.0;
              } else if (vertexTime < trailStart) {
                vTimeAlpha = 0.0;
              } else {
                float age = timeFilter.currentTime - vertexTime;
                float faded = clamp(1.0 - (age / timeFilter.trailLength), 0.0, 1.0);
                // trailFade == 1.0 -> classic head→tail fade; 0.0 -> solid trail.
                vTimeAlpha = mix(1.0, faded, timeFilter.trailFade);
              }
            }
          } else {
            float timeStart = timeFilter.currentTime - timeFilter.windowHalf;
            float timeEnd = timeFilter.currentTime + timeFilter.windowHalf;
            // Under segmentTime the end slot holds a per-VERTEX time, not the
            // feature's end, so window mode must not read it: NEVER_ENDS is
            // exactly what a trail layer's unset accessor would have supplied.
            float featureEnd =
              timeFilter.segmentTime > 0.5 ? 3.4028235e38 : instanceEndTime;
            if (featureEnd < timeStart || instanceStartTime > timeEnd) {
              vTimeAlpha = 0.0;
            }
            if (vTimeAlpha > 0.0 && timeFilter.fadeIn > 0.0) {
              float age = timeEnd - instanceStartTime;
              if (age < timeFilter.fadeIn) {
                vTimeAlpha *= (age / timeFilter.fadeIn);
              }
            }
            if (vTimeAlpha > 0.0 && timeFilter.fadeOut > 0.0) {
              float remaining = featureEnd - timeStart;
              if (remaining < timeFilter.fadeOut) {
                vTimeAlpha *= (remaining / timeFilter.fadeOut);
              }
            }
          }
        `,
        // ScatterplotLayer-only hook (silently ignored where absent). The
        // inout parameter in the hook signature is named `size` regardless of
        // what the calling layer passes at the call site — see deck.gl/core
        // DECKGL_FILTER_SIZE registration. Shrinks point geometry toward the
        // trailing edge of the wake by reusing vTimeAlpha as the head→tail
        // factor.
        'vs:DECKGL_FILTER_SIZE': `
          if (timeFilter.wakeLength > 0.0) {
            float wakeScale = mix(timeFilter.wakeTailScale, 1.0, vTimeAlpha);
            size *= wakeScale;
          }
        `,
        // Time-as-height ("space-time cube"): lift each vertex vertically by
        // its time since heightOrigin. Computed as a CLIP-SPACE DELTA between
        // the lifted and unlifted common-space positions, so whatever screen-
        // space offsets the host layer already baked into `position` (path
        // width quads, scatterplot billboards) are preserved. The clipspace
        // projection is affine, so the +center terms cancel in the difference.
        // Trail mode carries true per-vertex times (the thread climbs along
        // its length); window/wake/cumulative layers lift whole features by
        // their start time.
        'vs:DECKGL_FILTER_GL_POSITION': `
          if (timeFilter.heightScale != 0.0) {
            float heightTime = timeFilter.trailLength > 0.0 ? instanceVertexTime : instanceStartTime;
            float heightMeters = (heightTime - timeFilter.heightOrigin) * timeFilter.heightScale;
            vec4 liftedCommon = geometry.position;
            liftedCommon.z += project_size(heightMeters);
            position += project_common_position_to_clipspace(liftedCommon)
              - project_common_position_to_clipspace(geometry.position);
          }
        `,
        'vs:#main-end': glslMainEnd(extension.opts.pathSegmentTime),
        'fs:#main-start': `
          if (vTimeAlpha <= 0.0) discard;
          if (timeFilter.segmentTime > 0.5 && timeFilter.trailLength > 0.0 &&
              sttSegmentTrailAlpha() <= 0.0) discard;
        `,
        'fs:DECKGL_FILTER_COLOR': `
          color.a *= (timeFilter.segmentTime > 0.5 && timeFilter.trailLength > 0.0)
            ? sttSegmentTrailAlpha()
            : vTimeAlpha;
        `,
      },
    };
    extension.cachedShaders = shaders;
    return shaders;
  }

  initializeState(
    this: Layer<TimeFilterExtensionProps>,
    _context: LayerContext,
    _extension: TimeFilterExtension,
  ): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    // Three float attributes, ALWAYS registered regardless of mode:
    // instanceVertexTime (trail) + instanceStartTime/instanceEndTime (window).
    // The shader's wake/trail/window branch picks which to read at draw time
    // via the trailLength/wakeLength uniforms. Mode-specific registration
    // (dropping the unused pair to reclaim slots) was tried and tanked FPS on
    // the per-tile sublayers — see the TimeFilterMode docstring above. What
    // actually keeps the fp64-position + time + category combo under WebGL2's
    // 16-attribute floor is NoPickingPathLayer freeing the picking slot.
    //
    // Registered via add() + stepMode:'dynamic' — NOT addInstanced(), which
    // unconditionally overrides stepMode to 'instance' (deck.gl core
    // attribute-manager.ts) and hard-locks the extension to instanced layers.
    // 'dynamic' resolves per model at bufferLayout time: 'instance' on
    // instanced models (Scatterplot/Path — behaviour unchanged) and 'vertex'
    // on non-instanced ones (SolidPolygonLayer's fill model), which is
    // exactly how upstream DataFilterExtension registers filterValues and
    // why one class serves every layer type.
    attributeManager.add({
      instanceVertexTime: {
        size: 1,
        accessor: 'getInstanceVertexTime',
        type: 'float32',
        stepMode: 'dynamic',
        defaultValue: 0,
      },
      instanceStartTime: {
        size: 1,
        accessor: 'getInstanceStartTime',
        type: 'float32',
        stepMode: 'dynamic',
      },
      instanceEndTime: {
        size: 1,
        accessor: 'getInstanceEndTime',
        type: 'float32',
        stepMode: 'dynamic',
        // DOUBLE DUTY: under the `segmentTime` prop this slot carries the NEXT
        // VERTEX's time instead of the feature's end, which is how a trail
        // layer buys upstream TripsLayer's per-segment interpolation without a
        // 17th attribute. See the prop docstring — the registration is the same
        // either way, only the meaning of the bytes changes.
        //
        // Without an explicit defaultValue, DataColumn synthesizes `[0]`
        // (data-column.ts: `defaultValue || new Array(size).fill(0)`), which is
        // what `_normalizeValue` writes for ANY non-finite accessor result —
        // turning "never ends" into "ended at the epoch" and blanking the
        // layer. `defaultValue: Infinity` does not work either: the raw
        // non-finite number is kept, `defaultValue[0]` is `undefined`, and the
        // attribute fills with NaN.
        defaultValue: NEVER_ENDS,
      },
      // KNOWN LIMITATION (deck.gl ≤ 9.3): The 3 attributes above + PathLayer's
      // fp64 position split (8 slots) + instancePickingColors + instanceColors
      // + instanceWidths + instanceTypes + CategoryColorExtension's index = 16
      // attributes — right at WebGL2's guaranteed minimum. Some GPUs report
      // the cap as 16 and emit
      //   `WebGL Link error: Too many attributes (instancePickingColors)`.
      // deck.gl falls back to a non-picking shader and rendering proceeds
      // unchanged — the error is non-fatal.
      // Proper fix landing in deck.gl 9.4 (gl_InstanceID picking, removes
      // instancePickingColors as a vertex attribute). For now, set
      // `pickable: false` on the parent layer to avoid the warning.
    });
  }

  draw(
    this: Layer<TimeFilterExtensionProps>,
    _params: unknown,
    _extension: TimeFilterExtension,
  ): void {
    const {
      currentTime = 0,
      getTime,
      timeOffset = 0,
      timeWindow = 0,
      fadeInDuration = 0,
      fadeOutDuration = 0,
      trailLength = 0,
      fadeTrail = true,
      wakeLength = 0,
      wakeTailScale = DEFAULT_WAKE_TAIL_SCALE,
      cumulative = false,
      timeHeightScale = 0,
      timeHeightOrigin = null,
      segmentTime = false,
    } = this.props;

    // Warn-once key. `this.id` is a PER-TILE sublayer id, so it would let one
    // dataset spam (and, with a constant key, let one dataset permanently mute
    // every other one). The ROOT composite id is the right granularity: one
    // warning per STT layer on the map, so a second dataset with a genuinely
    // mismatched `timeOffset` still reports.
    const warnKey = (this.root ?? this)?.id ?? 'TimeFilterExtension';

    // PERFORMANCE: Use getTime() if provided for dynamic time updates
    // This allows the layer to be cached while time updates each frame
    const resolvedTime =
      typeof getTime === 'function' ? getTime() : currentTime;

    // CRITICAL float32 fix: subtract the layer's timeOffset so the uniform
    // matches the relative attribute values. Both sides of the shader
    // comparison are now small numbers that fit exactly in f32.
    const relativeTime = relativizeTime(resolvedTime, timeOffset);

    // Guard the f32 precision contract via the shared kernel diagnostic
    // (warn-once; skipped in cumulative mode, which intentionally spans years).
    // Fires when `timeOffset` doesn't match the tile data.
    assertRelTimeInRange(
      relativeTime,
      cumulative ? 'cumulative' : 'window',
      warnKey,
    );

    const timeFilterProps: TimeFilterUniformProps = {
      currentTime: relativeTime,
      windowHalf: timeWindow / 2,
      fadeIn: fadeInDuration,
      fadeOut: fadeOutDuration,
      trailLength,
      trailFade: fadeTrail ? 1.0 : 0.0,
      wakeLength,
      wakeTailScale,
      cumulative: cumulative ? 1.0 : 0.0,
      heightScale: timeHeightScale,
      // Same relativization scheme as currentTime, plus the "unset" sentinel
      // and an altitude-priced precision guard — see resolveHeightOrigin().
      // (A multi-day span overflows ms precision in f32, but at realistic
      // metres-per-ms height scales the error is millimetres of altitude.)
      heightOrigin: resolveHeightOrigin(
        timeHeightOrigin,
        timeOffset,
        timeHeightScale,
        warnKey,
      ),
      segmentTime: segmentTime ? 1.0 : 0.0,
    };

    // ── Push the DELTA, not the whole block ──────────────────────────────
    // `draw()` runs once per MODEL per FRAME — on a tiled layer that is one
    // call per visible tile, so a busy composite makes this a few hundred
    // calls a frame. `setShaderModuleProps` walks every key it is handed:
    // luma splits uniforms from bindings and re-merges them into a fresh
    // object, cloning each value (`ShaderInputs.setProps`). Eleven of these
    // twelve uniforms are constants for the layer's lifetime — only
    // `currentTime` moves — so pushing the full block every frame paid that
    // twelve times over for one changed float, and `ShaderInputs.setProps`
    // measured as the single hottest JS frame on the storm4d composite.
    //
    // Correctness rests on luma MERGING partial module props into the values
    // already held for the module, so an unsent key keeps its value rather
    // than reverting to a default. That is only true for models that have
    // already been pushed the full block, hence the `models[0]` identity
    // check: deck rebuilds a layer's models on a shader change (it uses this
    // exact test for its own `modelChanged`), and a fresh model starts from
    // the module DEFAULTS. Skipping the full push for one would silently
    // render it with `windowHalf: 0` / `trailLength: 0` — a blank layer.
    const models = this.getModels();
    const cache = this.state?.timeFilterPush as TimeFilterPushCache | undefined;
    if (
      cache &&
      cache.model === models[0] &&
      cache.modelCount === models.length &&
      staticUniformsEqual(cache.uniforms, timeFilterProps)
    ) {
      // Steady state: nothing but the playhead moved.
      if (cache.uniforms.currentTime === timeFilterProps.currentTime) return;
      cache.uniforms = timeFilterProps;
      this.setShaderModuleProps({
        timeFilter: { currentTime: timeFilterProps.currentTime },
      });
      return;
    }

    if (this.state) {
      this.state.timeFilterPush = {
        model: models[0],
        modelCount: models.length,
        uniforms: timeFilterProps,
      } satisfies TimeFilterPushCache;
    }
    this.setShaderModuleProps({ timeFilter: timeFilterProps });
  }
}

/**
 * What the last full uniform push covered, cached on the host layer's state.
 * `model`/`modelCount` pin the push to the model set it was applied to — see
 * the note in `draw()` for why a partial push is unsafe across a model swap.
 */
interface TimeFilterPushCache {
  model: unknown;
  modelCount: number;
  uniforms: TimeFilterUniformProps;
}

/**
 * Every uniform in the block that is a CONSTANT for the layer's lifetime —
 * i.e. all of {@link TimeFilterUniformProps} except `currentTime`, the one
 * value the playhead moves each frame.
 *
 * The `satisfies Record<…, true>` is the load-bearing part, not decoration:
 * adding a uniform to `TimeFilterUniformProps` without listing it here is a
 * COMPILE error. Miss one and `staticUniformsEqual` would report "unchanged"
 * after that prop moved, the delta push would send only `currentTime`, and
 * the uniform would silently stick at its previous value — a wrong render
 * with no error anywhere. `STATIC_UNIFORM_KEYS` is derived from this object
 * (rather than spelled a second time) so the comparison can never cover a
 * different set than the one the type check enforces.
 */
const STATIC_UNIFORM_FIELDS = {
  windowHalf: true,
  fadeIn: true,
  fadeOut: true,
  trailLength: true,
  trailFade: true,
  wakeLength: true,
  wakeTailScale: true,
  cumulative: true,
  heightScale: true,
  heightOrigin: true,
  segmentTime: true,
} satisfies Record<Exclude<keyof TimeFilterUniformProps, 'currentTime'>, true>;

const STATIC_UNIFORM_KEYS = Object.keys(
  STATIC_UNIFORM_FIELDS,
) as (keyof TimeFilterUniformProps)[];

/**
 * Do the lifetime-constant uniforms agree? Allocation-free: it walks the
 * module-scope key array, so it adds no garbage to a path that runs once per
 * visible tile per frame.
 */
function staticUniformsEqual(
  a: TimeFilterUniformProps,
  b: TimeFilterUniformProps,
): boolean {
  for (let i = 0; i < STATIC_UNIFORM_KEYS.length; i++) {
    const key = STATIC_UNIFORM_KEYS[i];
    if (a[key] !== b[key]) return false;
  }
  return true;
}
