import { LayerExtension } from '@deck.gl/core';
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
const defaultProps = {
    currentTime: 0,
    getTime: null, // Optional function, no default
    timeWindow: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    trailLength: 0,
    getInstanceStartTime: { type: 'accessor', value: 0 },
    getInstanceEndTime: { type: 'accessor', value: Infinity }
};
/**
 * Layer extension for GPU-based temporal filtering
 *
 * Filters and fades objects based on their time range relative to the current time.
 * Works with any layer that has temporal data.
 *
 * Supports two modes:
 * 1. Window mode (trailLength = 0): Show features whose time range overlaps with time window
 * 2. Trail mode (trailLength > 0): Progressive drawing with trailing fade for paths/trajectories
 *    - For trail mode, optionally provide instanceVertexProgress (0-1) for per-vertex time interpolation
 */
export class TimeFilterExtension extends LayerExtension {
    getShaders(_extension) {
        return {
            modules: [timeFilterUniforms],
            inject: {
                'vs:#decl': `
          in float instanceStartTime;
          in float instanceEndTime;
          // Optional: vertex progress along path (0-1), enables per-vertex time interpolation
          in float instanceVertexProgress;
          // Optional: actual vertex timestamp (when available, takes precedence over interpolation)
          // This enables accurate animation when per-vertex timestamps are stored in the data
          in float instanceVertexTime;
          out float vTimeAlpha;
        `,
                'vs:#main-start': `
          float timeStart = timeFilter.currentTime - timeFilter.windowHalf;
          float timeEnd = timeFilter.currentTime + timeFilter.windowHalf;
          
          vTimeAlpha = 1.0;

          // Trail mode: progressive drawing with trailing fade
          if (timeFilter.trailLength > 0.0) {
            // Compute the time at this vertex
            // Priority: 1) actual vertex timestamp, 2) interpolation from progress
            float vertexTime;
            if (instanceVertexTime > 0.0) {
              // Use actual per-vertex timestamp (accurate, from data)
              vertexTime = instanceVertexTime;
            } else {
              // Fall back to linear interpolation (assumes uniform speed)
              float progress = instanceVertexProgress;
              float featureDuration = instanceEndTime - instanceStartTime;
              vertexTime = instanceStartTime + featureDuration * progress;
            }
            
            // Trail window: show vertices from (currentTime - trailLength) to currentTime
            float trailStart = timeFilter.currentTime - timeFilter.trailLength;
            
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
            
            // Also check if feature is within the overall time window
            if (instanceEndTime < timeStart || instanceStartTime > timeEnd) {
              vTimeAlpha = 0.0;
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
          if (vTimeAlpha == 0.0) discard;
        `,
                'fs:DECKGL_FILTER_COLOR': `
          color.a *= vTimeAlpha;
        `
            }
        };
    }
    initializeState(_context, _extension) {
        const attributeManager = this.getAttributeManager();
        if (attributeManager) {
            attributeManager.addInstanced({
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
                },
                // Optional: vertex progress for trail rendering (0-1 along path)
                // If not provided, defaults to 0 and trail mode uses feature-level times
                instanceVertexProgress: {
                    size: 1,
                    accessor: 'getInstanceVertexProgress',
                    type: 'float32',
                    stepMode: 'dynamic',
                    defaultValue: 0
                },
                // Optional: actual per-vertex timestamp for accurate animation
                // When present (> 0), takes precedence over interpolation
                // This comes from data with per-vertex timestamps (like GPS tracks)
                instanceVertexTime: {
                    size: 1,
                    accessor: 'getInstanceVertexTime',
                    type: 'float32',
                    stepMode: 'dynamic',
                    defaultValue: 0
                }
            });
        }
    }
    updateState(_params, _extension) {
        // Trigger uniform update on prop changes
        // The draw method will handle setting the uniforms
    }
    draw(_params, _extension) {
        const { currentTime = 0, getTime, timeWindow = 0, fadeInDuration = 0, fadeOutDuration = 0, trailLength = 0 } = this.props;
        // PERFORMANCE: Use getTime() if provided for dynamic time updates
        // This allows the layer to be cached while time updates each frame
        const resolvedTime = typeof getTime === 'function' ? getTime() : currentTime;
        const timeFilterProps = {
            currentTime: resolvedTime,
            windowHalf: timeWindow / 2,
            fadeIn: fadeInDuration,
            fadeOut: fadeOutDuration,
            trailLength
        };
        this.setShaderModuleProps({ timeFilter: timeFilterProps });
    }
}
TimeFilterExtension.defaultProps = defaultProps;
TimeFilterExtension.extensionName = 'TimeFilterExtension';
//# sourceMappingURL=time-filter-extension.js.map