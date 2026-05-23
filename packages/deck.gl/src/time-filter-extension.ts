import { LayerExtension } from '@deck.gl/core';
import type { Layer, LayerContext, Accessor } from '@deck.gl/core';

/**
 * Props for layers using TimeFilterExtension
 */
export type TimeFilterExtensionProps<DataT = any> = {
  /** Current time for filtering (Unix milliseconds) */
  currentTime?: number;
  /**
   * PERFORMANCE OPTIMIZATION: Time getter function for dynamic time updates.
   * When provided, this is called in draw() to get the current time.
   * This allows the layer to be cached and reused - only uniforms are updated each frame.
   * Takes priority over currentTime prop.
   */
  getTime?: () => number;
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
   */
  timeOffset?: number;
  /** Time window size in milliseconds */
  timeWindow?: number;
  /** Fade-in duration for appearing objects (ms) */
  fadeInDuration?: number;
  /** Fade-out duration for disappearing objects (ms) */
  fadeOutDuration?: number;
  /**
   * Trail length in milliseconds (for path/trips effect).
   * When set > 0, enables progressive drawing with trailing fade.
   * The path is drawn from (currentTime - trailLength) to currentTime.
   */
  trailLength?: number;
  /** Accessor to get start time from each data object */
  getInstanceStartTime?: Accessor<DataT, number>;
  /** Accessor to get end time from each data object */
  getInstanceEndTime?: Accessor<DataT, number>;
  /**
   * Accessor for the per-vertex timestamp used in trail mode. Layers that do
   * not use trail mode never supply this; it defaults to a constant `0` so
   * deck.gl always has a valid accessor for the registered attribute.
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
};

// Uniform block for GLSL 3.0 (WebGL2)
const glslUniformBlock = `\
uniform timeFilterUniforms {
  float currentTime;
  float windowHalf;
  float fadeIn;
  float fadeOut;
  float trailLength;
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
    trailLength: 'f32'
  }
};

const defaultProps: Required<TimeFilterExtensionProps> = {
  currentTime: 0,
  getTime: null as any, // Optional function, no default
  timeOffset: 0,
  timeWindow: 0,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  trailLength: 0,
  getInstanceStartTime: { type: 'accessor', value: 0 } as any,
  getInstanceEndTime: { type: 'accessor', value: Infinity } as any,
  // Constant default: window-mode layers never set a per-vertex time, but the
  // attribute is always registered so deck.gl requires a valid accessor.
  getInstanceVertexTime: { type: 'accessor', value: 0 } as any
};

/**
 * Largest relative-time magnitude that survives a Float32 round-trip with
 * full millisecond precision. f32 has a 24-bit mantissa, so integers up to
 * 2^24 (16,777,216) are exact. Relative spans beyond this lose ms precision.
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
export class TimeFilterExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'TimeFilterExtension';

  getShaders(this: Layer<TimeFilterExtensionProps>, _extension: TimeFilterExtension) {
    return {
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
          float timeStart = timeFilter.currentTime - timeFilter.windowHalf;
          float timeEnd = timeFilter.currentTime + timeFilter.windowHalf;

          vTimeAlpha = 1.0;

          // Trail mode: progressive drawing with trailing fade
          if (timeFilter.trailLength > 0.0) {
            // Trail window: show vertices from (currentTime - trailLength) to currentTime
            float trailStart = timeFilter.currentTime - timeFilter.trailLength;

            // Per-vertex timestamp (relative). Note: 0.0 is a valid relative
            // time, so we no longer treat it as a "missing" sentinel - layers
            // always supply instanceVertexTime in trail mode.
            float vertexTime = instanceVertexTime;

            if (vertexTime > timeFilter.currentTime) {
              // Vertex is in the future - hide it
              vTimeAlpha = 0.0;
            } else if (vertexTime < trailStart) {
              // Vertex is before trail start - hide it
              vTimeAlpha = 0.0;
            } else {
              // Vertex is in trail window - compute fade based on age
              float age = timeFilter.currentTime - vertexTime;
              vTimeAlpha = 1.0 - (age / timeFilter.trailLength);
              vTimeAlpha = clamp(vTimeAlpha, 0.0, 1.0);
            }
          } else {
            // Standard window mode: check if feature overlaps with time window
            if (instanceEndTime < timeStart || instanceStartTime > timeEnd) {
              vTimeAlpha = 0.0;
            }

            // Fade logic (optional)
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
  }

  initializeState(
    this: Layer<TimeFilterExtensionProps>,
    _context: LayerContext,
    _extension: TimeFilterExtension
  ): void {
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        // Per-vertex timestamp, relative to layer timeOffset (trail mode).
        instanceVertexTime: {
          size: 1,
          accessor: 'getInstanceVertexTime',
          type: 'float32',
          stepMode: 'dynamic',
          defaultValue: 0
        },
        // Feature-level times, relative to layer timeOffset (window mode).
        instanceStartTime: {
          size: 1,
          accessor: 'getInstanceStartTime',
          type: 'float32',
          stepMode: 'dynamic'
        },
        instanceEndTime: {
          size: 1,
          accessor: 'getInstanceEndTime',
          type: 'float32',
          stepMode: 'dynamic'
        }
      });
    }
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
      trailLength = 0
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
    const extState = this.state as { _timePrecisionWarned?: boolean };
    if (Math.abs(relativeTime) > MAX_RELATIVE_TIME_MS && !extState._timePrecisionWarned) {
      extState._timePrecisionWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[TimeFilterExtension] relative time ${relativeTime} exceeds ` +
          `${MAX_RELATIVE_TIME_MS} ms — Float32 precision is degraded; ` +
          'check that `timeOffset` matches the tile data.'
      );
    }

    const timeFilterProps: TimeFilterUniformProps = {
      currentTime: relativeTime,
      windowHalf: timeWindow / 2,
      fadeIn: fadeInDuration,
      fadeOut: fadeOutDuration,
      trailLength
    };

    this.setShaderModuleProps({ timeFilter: timeFilterProps });
  }
}
