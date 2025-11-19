
import { LayerExtension, Layer } from '@deck.gl/core';

export type TimeFilterProps = {
  currentTime: number;
  timeWindow: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
};

export class TimeFilterExtension extends LayerExtension {
  static defaultProps = {
    currentTime: 0,
    timeWindow: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0
  };

  getShaders() {
    return {
      inject: {
        'vs:#decl': `
          uniform float timeFilter_currentTime;
          uniform float timeFilter_windowHalf;
          uniform float timeFilter_fadeIn;
          uniform float timeFilter_fadeOut;
          attribute float instanceStartTime;
          attribute float instanceEndTime;
          varying float vTimeAlpha;
        `,
        'vs:#main-start': `
          float timeStart = timeFilter_currentTime - timeFilter_windowHalf;
          float timeEnd = timeFilter_currentTime + timeFilter_windowHalf;
          
          vTimeAlpha = 1.0;

          // Check visibility
          if (instanceEndTime < timeStart || instanceStartTime > timeEnd) {
            vTimeAlpha = 0.0;
            gl_Position = vec4(0.0); // Cull vertex
            return;
          }
          
          // Fade logic (optional)
          if (timeFilter_fadeIn > 0.0) {
            float age = timeEnd - instanceStartTime;
            if (age < timeFilter_fadeIn) {
              vTimeAlpha *= (age / timeFilter_fadeIn);
            }
          }
          
          if (timeFilter_fadeOut > 0.0) {
             float remaining = instanceEndTime - timeStart;
             if (remaining < timeFilter_fadeOut) {
               vTimeAlpha *= (remaining / timeFilter_fadeOut);
             }
          }
        `,
        'fs:#decl': `
          varying float vTimeAlpha;
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
      attributeManager.add({
        instanceStartTime: {
          size: 1,
          accessor: 'getInstanceStartTime',
          type: 0x1406, // GL.FLOAT
          shaderAttributes: {
            instanceStartTime: {
              divisor: 1
            }
          }
        },
        instanceEndTime: {
          size: 1,
          accessor: 'getInstanceEndTime',
          type: 0x1406, // GL.FLOAT
          shaderAttributes: {
            instanceEndTime: {
              divisor: 1
            }
          }
        }
      });
    }
  }

  draw(this: any, {uniforms}: any) {
    const {currentTime, timeWindow, fadeInDuration = 0, fadeOutDuration = 0} = this.props;
    this.state.model.setUniforms({
      timeFilter_currentTime: currentTime,
      timeFilter_windowHalf: timeWindow / 2,
      timeFilter_fadeIn: fadeInDuration,
      timeFilter_fadeOut: fadeOutDuration
    });
  }
}
