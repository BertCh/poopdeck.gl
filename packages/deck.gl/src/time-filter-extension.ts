import { LayerExtension } from '@deck.gl/core';
import type { Layer, LayerContext, Accessor, UpdateParameters } from '@deck.gl/core';

/**
 * Props for layers using TimeFilterExtension
 */
export type TimeFilterExtensionProps<DataT = any> = {
  /** Current time for filtering (Unix milliseconds) */
  currentTime?: number;
  /** Time window size in milliseconds */
  timeWindow?: number;
  /** Fade-in duration for appearing objects (ms) */
  fadeInDuration?: number;
  /** Fade-out duration for disappearing objects (ms) */
  fadeOutDuration?: number;
  /** Accessor to get start time from each data object */
  getInstanceStartTime?: Accessor<DataT, number>;
  /** Accessor to get end time from each data object */
  getInstanceEndTime?: Accessor<DataT, number>;
};

// Define uniform types for the shader module
type TimeFilterUniformProps = {
  currentTime: number;
  windowHalf: number;
  fadeIn: number;
  fadeOut: number;
};

// Uniform block for GLSL 3.0 (WebGL2)
const glslUniformBlock = `\
uniform timeFilterUniforms {
  float currentTime;
  float windowHalf;
  float fadeIn;
  float fadeOut;
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
    fadeOut: 'f32'
  }
};

const defaultProps: Required<TimeFilterExtensionProps> = {
  currentTime: 0,
  timeWindow: 0,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  getInstanceStartTime: { type: 'accessor', value: 0 } as any,
  getInstanceEndTime: { type: 'accessor', value: Infinity } as any
};

/**
 * Layer extension for GPU-based temporal filtering
 * 
 * Filters and fades objects based on their time range relative to the current time.
 * Works with any layer that has temporal data.
 */
export class TimeFilterExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'TimeFilterExtension';

  getShaders(this: Layer<TimeFilterExtensionProps>, _extension: TimeFilterExtension) {
    return {
      modules: [timeFilterUniforms],
      inject: {
        'vs:#decl': `
          in float instanceStartTime;
          in float instanceEndTime;
          out float vTimeAlpha;
        `,
        'vs:#main-start': `
          float timeStart = timeFilter.currentTime - timeFilter.windowHalf;
          float timeEnd = timeFilter.currentTime + timeFilter.windowHalf;
          
          vTimeAlpha = 1.0;

          // Check visibility
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

  initializeState(
    this: Layer<TimeFilterExtensionProps>,
    _context: LayerContext,
    _extension: TimeFilterExtension
  ): void {
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
        }
      });
    }
  }

  updateState(
    this: Layer<TimeFilterExtensionProps>,
    _params: UpdateParameters<Layer<TimeFilterExtensionProps>>,
    _extension: TimeFilterExtension
  ): void {
    // Trigger uniform update on prop changes
    // The draw method will handle setting the uniforms
  }

  draw(
    this: Layer<TimeFilterExtensionProps>,
    _params: unknown,
    _extension: TimeFilterExtension
  ): void {
    const {
      currentTime = 0,
      timeWindow = 0,
      fadeInDuration = 0,
      fadeOutDuration = 0
    } = this.props;
    
    const timeFilterProps: TimeFilterUniformProps = {
      currentTime,
      windowHalf: timeWindow / 2,
      fadeIn: fadeInDuration,
      fadeOut: fadeOutDuration
    };
    
    this.setShaderModuleProps({ timeFilter: timeFilterProps });
  }
}
