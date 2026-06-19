// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

import { LayerExtension } from '@deck.gl/core';
import type { Layer, LayerContext, Accessor, DefaultProps } from '@deck.gl/core';
import { warnOnce } from '../lib/log';

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
   * typically the dataset's timeRange.start. Relativized against `timeOffset`
   * on the CPU like every other time in this extension.
   * @default 0
   */
  timeHeightOrigin?: number;
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
  /** Relative time (vs the layer timeOffset) mapped to altitude 0. */
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

// Shader module definition for deck.gl 9.x
const timeFilterUniforms = {
  name: 'timeFilter',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
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
    heightOrigin: 'f32'
  }
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
  wakeTailScale: 0.15,
  cumulative: false,
  timeHeightScale: 0,
  timeHeightOrigin: 0,
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
export const MAX_RELATIVE_TIME_MS = 16_777_216;

/**
 * Pure helper: relativize an absolute time against a layer's time offset.
 *
 * This is the SINGLE source of truth for the time-relativization scheme.
 * - Attributes (instanceStartTime / instanceEndTime / instanceVertexTime) store
 *   `absoluteTime - layerTimeOffset`.
 * - The `currentTime` shader uniform stores `currentTime - layerTimeOffset`.
 * Both sides are therefore small numbers that fit exactly in f32.
 *
 * Exported so it can be unit-tested for Float32 precision.
 */
export function relativizeTime(absoluteTime: number, layerTimeOffset: number): number {
  return absoluteTime - layerTimeOffset;
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

  getShaders(this: Layer<TimeFilterExtensionProps>, extension: TimeFilterExtension) {
    if (extension.cachedShaders) return extension.cachedShaders;
    const shaders = {
      modules: [timeFilterUniforms],
      inject: {
        'vs:#decl': `
          // Per-vertex timestamp, RELATIVE to the layer timeOffset (trail mode).
          in float instanceVertexTime;
          // Feature-level times, RELATIVE to the layer timeOffset.
          in float instanceStartTime;
          in float instanceEndTime;
          out float vTimeAlpha;
        `,
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
        'fs:#decl': `
          in float vTimeAlpha;
        `,
        'fs:#main-start': `
          if (vTimeAlpha <= 0.0) discard;
        `,
        'fs:DECKGL_FILTER_COLOR': `
          color.a *= vTimeAlpha;
        `
      }
    };
    extension.cachedShaders = shaders;
    return shaders;
  }

  initializeState(
    this: Layer<TimeFilterExtensionProps>,
    _context: LayerContext,
    _extension: TimeFilterExtension
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
    _extension: TimeFilterExtension
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
      wakeTailScale = 0.15,
      cumulative = false,
      timeHeightScale = 0,
      timeHeightOrigin = 0
    } = this.props;

    // PERFORMANCE: Use getTime() if provided for dynamic time updates
    // This allows the layer to be cached while time updates each frame
    const resolvedTime = typeof getTime === 'function' ? getTime() : currentTime;

    // CRITICAL float32 fix: subtract the layer's timeOffset so the uniform
    // matches the relative attribute values. Both sides of the shader
    // comparison are now small numbers that fit exactly in f32.
    const relativeTime = relativizeTime(resolvedTime, timeOffset);

    // Guard the f32 precision contract: a relative time past 2^24 ms loses
    // millisecond precision in the shader. Warn once if `timeOffset` is wrong.
    // Cumulative mode intentionally spans years (the reveal steps by days, so
    // ~tens-of-seconds quantization at that magnitude is irrelevant) — skip the
    // warning there to avoid a misleading console message.
    if (!cumulative && Math.abs(relativeTime) > MAX_RELATIVE_TIME_MS) {
      warnOnce(
        'TimeFilterExtension:precision',
        `[TimeFilterExtension] relative time ${relativeTime} exceeds ` +
          `${MAX_RELATIVE_TIME_MS} ms — Float32 precision is degraded; ` +
          'check that `timeOffset` matches the tile data.',
      );
    }

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
      // Same relativization scheme as currentTime: both sides of the shader
      // subtraction are small f32-exact numbers. (A multi-day span overflows
      // ms precision in f32, but at meters-per-hour height scales the error
      // is micrometers of altitude — irrelevant.)
      heightOrigin: relativizeTime(timeHeightOrigin, timeOffset)
    };

    this.setShaderModuleProps({ timeFilter: timeFilterProps });
  }
}
