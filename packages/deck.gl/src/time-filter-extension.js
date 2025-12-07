import { LayerExtension } from '@deck.gl/core';
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
const defaultProps = {
    currentTime: 0,
    timeWindow: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    getInstanceStartTime: { type: 'accessor', value: 0 },
    getInstanceEndTime: { type: 'accessor', value: Infinity }
};
/**
 * Layer extension for GPU-based temporal filtering
 *
 * Filters and fades objects based on their time range relative to the current time.
 * Works with any layer that has temporal data.
 */
export class TimeFilterExtension extends LayerExtension {
    getShaders(_extension) {
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
                }
            });
        }
    }
    updateState(_params, _extension) {
        // Trigger uniform update on prop changes
        // The draw method will handle setting the uniforms
    }
    draw(_params, _extension) {
        const { currentTime = 0, timeWindow = 0, fadeInDuration = 0, fadeOutDuration = 0 } = this.props;
        const timeFilterProps = {
            currentTime,
            windowHalf: timeWindow / 2,
            fadeIn: fadeInDuration,
            fadeOut: fadeOutDuration
        };
        this.setShaderModuleProps({ timeFilter: timeFilterProps });
    }
}
TimeFilterExtension.defaultProps = defaultProps;
TimeFilterExtension.extensionName = 'TimeFilterExtension';
//# sourceMappingURL=time-filter-extension.js.map