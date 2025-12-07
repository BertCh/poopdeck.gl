import { LayerExtension, Layer } from '@deck.gl/core';

export type TimeFilterProps = {
  currentTime: number;
  timeWindow: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
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

export class TimeFilterExtension extends LayerExtension {
  static defaultProps = {
    currentTime: 0,
    timeWindow: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    getInstanceStartTime: { type: 'accessor', value: 0 },
    getInstanceEndTime: { type: 'accessor', value: Infinity }
  };

  static extensionName = 'TimeFilterExtension';

  getShaders() {
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

  initializeState(this: Layer, context: any, extension: any) {
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        instanceStartTime: {
          size: 1,
          accessor: 'getInstanceStartTime',
          type: 'float32'
        },
        instanceEndTime: {
          size: 1,
          accessor: 'getInstanceEndTime',
          type: 'float32'
        }
      });
    }
  }

  draw(this: Layer, params: any, extension: any) {
    const { currentTime, timeWindow, fadeInDuration = 0, fadeOutDuration = 0 } = this.props as any;
    const timeFilterProps: TimeFilterUniformProps = {
      currentTime,
      windowHalf: timeWindow / 2,
      fadeIn: fadeInDuration,
      fadeOut: fadeOutDuration
    };
    this.setShaderModuleProps({ timeFilter: timeFilterProps });
  }
}
