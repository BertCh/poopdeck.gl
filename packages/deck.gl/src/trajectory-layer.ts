import { Layer, project32, picking, DefaultProps } from '@deck.gl/core';
import GL from '@luma.gl/constants';
import { Model, Geometry } from '@luma.gl/engine';
import { Texture } from '@luma.gl/core';
import type { TrajectoryData } from '@stt/core';

const vs = `\
#version 300 es
#define SHADER_NAME trajectory-layer-vertex-shader

in uint instanceIds;
in uint instanceStartIndices;
in uint instanceLengths;
in vec4 instanceColors;
in float instanceRadius;

uniform sampler2D pathPositionsTexture;
uniform sampler2D pathTimesTexture;
uniform int textureWidth;
uniform float currentTime;
uniform float fadeDuration;
uniform float sizeScale;

out vec4 vColor;

// Helper to read position from texture at index
vec2 getPathPosition(uint index) {
  int y = int(index) / textureWidth;
  int x = int(index) % textureWidth;
  return texelFetch(pathPositionsTexture, ivec2(x, y), 0).xy;
}

// Helper to read time from texture at index
float getPathTime(uint index) {
  int y = int(index) / textureWidth;
  int x = int(index) % textureWidth;
  return texelFetch(pathTimesTexture, ivec2(x, y), 0).x;
}

void main() {
  uint startIndex = instanceStartIndices;
  uint length = instanceLengths;
  
  if (length < 2u) {
    gl_Position = vec4(0.0);
    return;
  }

  // Binary search for the segment containing currentTime
  // Range [startIndex, startIndex + length - 1]
  
  uint left = startIndex;
  uint right = startIndex + length - 1u;
  uint idx = startIndex;
  bool found = false;
  
  // Get start and end times of the path
  float pathStartTime = getPathTime(left);
  float pathEndTime = getPathTime(right);
  
  // Check if we are out of bounds
  if (currentTime < pathStartTime || currentTime > pathEndTime) {
    // Logic for fading out? For now just clip
    gl_Position = vec4(0.0);
    return;
  }
  
  // Binary search
  // We want largest i such that time[i] <= currentTime
  while (left <= right) {
    uint mid = left + (right - left) / 2u;
    float t = getPathTime(mid);
    
    if (t <= currentTime) {
      idx = mid;
      left = mid + 1u;
    } else {
      right = mid - 1u;
    }
  }
  
  // Ensure we don't go past end
  if (idx >= startIndex + length - 1u) {
    idx = startIndex + length - 2u;
  }
  
  // Interpolate
  float t1 = getPathTime(idx);
  float t2 = getPathTime(idx + 1u);
  
  vec2 p1 = getPathPosition(idx);
  vec2 p2 = getPathPosition(idx + 1u);
  
  float ratio = (currentTime - t1) / (t2 - t1);
  // Clamp ratio to handle numerical issues
  ratio = clamp(ratio, 0.0, 1.0);
  
  vec2 currentPos = mix(p1, p2, ratio);
  
  // Calculate fading
  float alpha = 1.0;
  // Simple fade in/out at edges
  float timeFromStart = currentTime - pathStartTime;
  float timeToEnd = pathEndTime - currentTime;
  
  if (timeFromStart < fadeDuration) {
    alpha = smoothstep(0.0, fadeDuration, timeFromStart);
  } else if (timeToEnd < fadeDuration) {
    alpha = smoothstep(0.0, fadeDuration, timeToEnd);
  }
  
  vColor = vec4(instanceColors.rgb, instanceColors.a * alpha);
  
  // Project
  vec3 commonPos = project_position(vec3(currentPos, 0.0));
  gl_Position = project_common_position_to_clipspace(vec4(commonPos, 1.0));
  
  // Point size
  gl_PointSize = sizeScale * instanceRadius;
  
  // Apply offset to create a quad in fragment shader or just use gl_PointSize (squares)
  // For proper circles we use gl_PointCoord in fragment
}
`;

const fs = `\
#version 300 es
#define SHADER_NAME trajectory-layer-fragment-shader

precision highp float;

in vec4 vColor;
out vec4 fragColor;

void main() {
  // Circular shape
  vec2 cxy = 2.0 * gl_PointCoord - 1.0;
  float r = dot(cxy, cxy);
  if (r > 1.0) {
    discard;
  }
  
  // Antialiasing
  float alpha = vColor.a * (1.0 - smoothstep(0.8, 1.0, r));
  
  fragColor = vec4(vColor.rgb, alpha);
  
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export interface TrajectoryLayerProps {
  data: TrajectoryData;
  currentTime: number;
  getFillColor?: [number, number, number, number];
  getRadius?: number;
  radiusScale?: number;
  fadeDuration?: number;
}

const defaultProps: DefaultProps<TrajectoryLayerProps> = {
  currentTime: { type: 'number', value: 0, compare: true },
  getFillColor: { type: 'color', value: [255, 0, 0, 255] },
  getRadius: { type: 'number', value: 10, compare: true },
  radiusScale: { type: 'number', value: 1, compare: true },
  fadeDuration: { type: 'number', value: 0, compare: true },
};

export class TrajectoryLayer extends Layer<TrajectoryLayerProps> {
  static layerName = 'TrajectoryLayer';
  static defaultProps = defaultProps;

  getShaders() {
    return {
      vs,
      fs,
      modules: [project32, picking]
    };
  }

  initializeState() {
    const attributeManager = this.getAttributeManager();
    attributeManager!.add({
      instanceStartIndices: {
        size: 1,
        type: GL.UNSIGNED_INT,
        accessor: 'getStartIndices',
      },
      instanceLengths: {
        size: 1,
        type: GL.UNSIGNED_INT,
        accessor: 'getLengths',
      },
      instanceIds: {
        size: 1,
        type: GL.UNSIGNED_INT,
        accessor: 'getIds',
      },
      instanceColors: {
        size: 4,
        type: GL.UNSIGNED_BYTE,
        normalized: true,
        accessor: 'getFillColor',
        defaultValue: [0, 0, 0, 255],
      },
      instanceRadius: {
        size: 1,
        type: GL.FLOAT,
        accessor: 'getRadius',
        defaultValue: 1,
      },
    });
  }

  updateState({ props, oldProps, changeFlags }: any) {
    super.updateState({ props, oldProps, changeFlags });

    if (changeFlags.dataChanged) {
      this.updateTextures();
    }
  }

  finalizeState() {
    super.finalizeState();
    const { pathPositionsTexture, pathTimesTexture } = this.state;
    pathPositionsTexture?.delete();
    pathTimesTexture?.delete();
  }

  private updateTextures() {
    const data = this.props.data as TrajectoryData;
    if (!data || !data.positions || !data.timestamps) return;

    const totalPoints = data.timestamps.length;
    
    // Determine texture size (approx square)
    const width = Math.min(4096, Math.ceil(Math.sqrt(totalPoints)));
    const height = Math.ceil(totalPoints / width);
    const paddedLength = width * height;

    // Pad arrays to match texture size
    const paddedPositions = new Float32Array(paddedLength * 2);
    paddedPositions.set(data.positions);
    
    const paddedTimes = new Float32Array(paddedLength);
    paddedTimes.set(data.timestamps);

    // Create/Update textures
    const device = this.context.device; // luma.gl v9 device

    // Note: In v9, texture API is different. 
    // Assuming standard WebGL2 support via luma.gl
    
    if (this.state.pathPositionsTexture) {
        this.state.pathPositionsTexture.delete();
        this.state.pathTimesTexture.delete();
    }

    const pathPositionsTexture = new Texture(device, {
        data: paddedPositions,
        format: 'rg32float',
        width,
        height,
        sampler: {
            minFilter: 'nearest',
            magFilter: 'nearest',
        }
    });

    const pathTimesTexture = new Texture(device, {
        data: paddedTimes,
        format: 'r32float',
        width,
        height,
        sampler: {
            minFilter: 'nearest',
            magFilter: 'nearest',
        }
    });

    this.setState({
      pathPositionsTexture,
      pathTimesTexture,
      textureWidth: width,
      vertexCount: data.count
    });

    this.getAttributeManager()!.invalidateAll();
  }

  draw({ uniforms }: any) {
    const { pathPositionsTexture, pathTimesTexture, textureWidth, vertexCount } = this.state;
    
    if (!pathPositionsTexture || !pathTimesTexture || !vertexCount) return;

    this.state.model
      .setVertexCount(vertexCount)
      .setUniforms(uniforms)
      .setUniforms({
        pathPositionsTexture,
        pathTimesTexture,
        textureWidth,
        currentTime: this.props.currentTime,
        fadeDuration: this.props.fadeDuration,
        sizeScale: this.props.radiusScale,
      })
      .draw();
  }
}

