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
   * @default Infinity
   */
  getInstanceEndTime?: Accessor<DataT, number>;
  /**
   * Accessor for the per-vertex timestamp used in trail mode. Layers that
   * don't use trail mode never supply this; default `0` keeps deck.gl happy
   * because the attribute is always registered.
   * @default 0
   */
  getInstanceVertexTime?: Accessor<DataT, number>;
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
// Feature-level times, RELATIVE to the layer timeOffset.
in float instanceStartTime;
in float instanceEndTime;
out float vTimeAlpha;
`;

const glslFragmentDecl = `\
in float vTimeAlpha;
`;

// Shader module definition for deck.gl 9.x
const timeFilterUniforms = {
  name: 'timeFilter',
  vs: `${glslUniformBlock}${glslVertexDecl}`,
  fs: `${glslUniformBlock}${glslFragmentDecl}`,
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
  getInstanceEndTime: { type: 'accessor', value: Infinity },
  // Constant default: window-mode layers never set a per-vertex time, but the
  // attribute is always registered so deck.gl requires a valid accessor.
  getInstanceVertexTime: { type: 'accessor', value: 0 },
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
}

const defaultOptions: Required<TimeFilterExtensionOptions> = {
  mode: 'auto',
};

export class TimeFilterExtension extends LayerExtension<
  Required<TimeFilterExtensionOptions>
> {
  static defaultProps = defaultProps;
  static extensionName = 'TimeFilterExtension';

  /**
   * Memoized shader-injection object. deck.gl calls `getShaders()` on every
   * sublayer construction; returning a NEW object literal each time would
   * trigger a fresh shader-cache miss and pipeline re-link per tile.
   * Building once per extension instance preserves object identity across
   * all sublayers that share the singleton.
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
          } else {
            float timeStart = timeFilter.currentTime - timeFilter.windowHalf;
            float timeEnd = timeFilter.currentTime + timeFilter.windowHalf;
            if (instanceEndTime < timeStart || instanceStartTime > timeEnd) {
              vTimeAlpha = 0.0;
            }
            if (vTimeAlpha > 0.0 && timeFilter.fadeIn > 0.0) {
              float age = timeEnd - instanceStartTime;
              if (age < timeFilter.fadeIn) {
                vTimeAlpha *= (age / timeFilter.fadeIn);
              }
            }
            if (vTimeAlpha > 0.0 && timeFilter.fadeOut > 0.0) {
              float remaining = instanceEndTime - timeStart;
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
        // Collapse fully-hidden features at the VERTEX stage (upstream
        // DataFilterExtension does the same): degenerate clip-space position
        // ⇒ zero fragments rasterized, so off-window features stop paying
        // fragment cost (at low zoom most features in a tile are outside the
        // window). Gated IN-SHADER on trail mode: window/wake/cumulative
        // alphas are whole-feature (every vertex of a feature agrees), but a
        // trail fades per-vertex — collapsing one end of a still-visible
        // segment would drag its geometry to the origin.
        'vs:#main-end': `
          if (vTimeAlpha <= 0.0 && timeFilter.trailLength <= 0.0) {
            gl_Position = vec4(0.);
          }
        `,
        'fs:#main-start': `
          if (vTimeAlpha <= 0.0) discard;
        `,
        'fs:DECKGL_FILTER_COLOR': `
          color.a *= vTimeAlpha;
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
    };

    this.setShaderModuleProps({ timeFilter: timeFilterProps });
  }
}
