/**
 * Point geometry adapter — renders POINT-type tiles as circular billboards.
 */

import type { Tile, Layer as STTLayer } from '@stt/core';
import { GeometryType } from '@stt/core';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from './base-layer';
import { TIME_WINDOW_GLSL } from './shaders/time-window.glsl';

export interface STTPointLayerOptions extends STTBaseLayerOptions {
  /**
   * Point color as `[r, g, b, a]`. Accepts EITHER 0–255 ints (the deck.gl
   * `Color` convention, and what `colorPalette` uses) OR 0–1 floats — the
   * range is auto-detected. Ignored when `colorProperty` is set.
   */
  color?: [number, number, number, number];
  /** Point radius in pixels. Clamped to GPU `gl_PointSize` range at draw time. */
  radius?: number;
  /**
   * Drive per-feature colour from a categorical property name (looked up in
   * `binary.categoricalProps[colorProperty]`). The palette is sampled by the
   * category index. Falls back to the constant `color` if the property is
   * absent from a tile.
   */
  colorProperty?: string;
  /**
   * Colour palette used when `colorProperty` is set, expressed as 0–255 RGBA
   * tuples (matches the deck.gl adapter). Defaults to a 10-colour categorical
   * palette.
   */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Drive per-feature radius (pixels) from a numeric property. Falls back to
   * the constant `radius` if the property is absent.
   */
  radiusProperty?: string;
  /** Optional radius scale multiplier applied to property-driven radii. */
  radiusScale?: number;
}

// Matches the deck.gl adapter's default palette so the two backends paint the
// same colours given the same data without extra wiring.
const DEFAULT_PALETTE: ReadonlyArray<RGBA8> = [
  [31, 119, 180, 255],
  [255, 127, 14, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

const VS_SOURCE = `
  precision highp float;
  attribute vec3 aMercator;
  attribute vec2 aTime;
  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
  attribute float aRadius;     // per-feature radius in pixels (when uUseFeatureRadius=1)
  uniform mat4 uMatrix;
  uniform float uAltitudeScale;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
  varying vec4 vColor;
${TIME_WINDOW_GLSL}
  void main() {
    vec4 pos = uMatrix * vec4(aMercator.x, aMercator.y, aMercator.z * uAltitudeScale, 1.0);
    gl_Position = pos;
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    gl_PointSize = radiusPx * 2.0;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    // Antialiased disc: soften the last ~10% of the radius.
    float edge = smoothstep(0.25, 0.20, r);
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha * edge);
  }
`;

interface PointProgramHandles {
  program: WebGLProgram;
  aMercator: number;
  aTime: number;
  aColor: number;
  aRadius: number;
  uMatrix: WebGLUniformLocation | null;
  uAltitudeScale: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uRadiusScale: WebGLUniformLocation | null;
  uUseFeatureRadius: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
}

/** Per-feature attribute buffers held alongside the standard TileGpuCache. */
interface PointGpuCache extends TileGpuCache {
  colorBuffer?: WebGLBuffer;
  radiusBuffer?: WebGLBuffer;
}

/**
 * MapLibre custom layer that renders STT point tiles.
 *
 * ```ts
 * const layer = new STTPointLayer({
 *   id: 'eq',
 *   url: '/data/earthquakes.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 60_000,
 *   color: [0.99, 0.5, 0.2, 1.0],
 *   radius: 5,
 * });
 * map.addLayer(layer);
 * setInterval(() => layer.setCurrentTime(Date.now()), 16);
 * ```
 */
export class STTPointLayer extends STTBaseLayer {
  private pointOpts: {
    color: [number, number, number, number];
    radius: number;
    radiusScale: number;
    colorProperty?: string;
    radiusProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
  };
  private handles?: PointProgramHandles;

  constructor(opts: STTPointLayerOptions) {
    super(opts);
    this.pointOpts = {
      color: opts.color ?? [0.31, 0.76, 0.97, 1.0],
      radius: opts.radius ?? 4,
      radiusScale: opts.radiusScale ?? 1,
      colorProperty: opts.colorProperty,
      radiusProperty: opts.radiusProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_PALETTE,
    };
  }

  /** Update the point colour at runtime. */
  setColor(color: [number, number, number, number]): void {
    this.pointOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Update the point radius (pixels) at runtime. */
  setRadius(radius: number): void {
    this.pointOpts.radius = radius;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const program = this.linkProgram(gl, VS_SOURCE, FS_SOURCE);
    this.handles = {
      program,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aRadius: gl.getAttribLocation(program, 'aRadius'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uAltitudeScale: gl.getUniformLocation(program, 'uAltitudeScale'),
      uRadius: gl.getUniformLocation(program, 'uRadius'),
      uRadiusScale: gl.getUniformLocation(program, 'uRadiusScale'),
      uUseFeatureRadius: gl.getUniformLocation(program, 'uUseFeatureRadius'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
    };
  }

  /**
   * Build the per-tile cache. Adds optional per-feature colour / radius
   * attribute buffers when `colorProperty` / `radiusProperty` are set and the
   * named property exists in the binary tile.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): PointGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, _tile, layer);
    if (!baseCache) return null;
    const cache: PointGpuCache = baseCache as PointGpuCache;
    const f = layer.features;
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];

    if (this.pointOpts.colorProperty) {
      const colors = this.expandCategoricalColors(
        f,
        this.pointOpts.colorProperty,
        this.pointOpts.colorPalette,
      );
      if (colors) {
        cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
        extras.push(cache.colorBuffer);
      }
    }

    if (this.pointOpts.radiusProperty) {
      const radii = this.getNumericProperty(f, this.pointOpts.radiusProperty);
      if (radii) {
        cache.radiusBuffer = this.uploadArrayBuffer(gl, radii);
        extras.push(cache.radiusBuffer);
      }
    }

    cache.extraBuffers = extras.length > 0 ? extras : undefined;
    return cache;
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.handles) {
      gl.deleteProgram(this.handles.program);
      this.handles = undefined;
    }
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const h = this.handles;
    if (!h) return;
    const c = cache as PointGpuCache;

    gl.useProgram(h.program);
    gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    gl.uniform1f(h.uAltitudeScale, 0); // 2D points; altitudes are ignored.
    gl.uniform1f(h.uRadius, this.pointOpts.radius);
    gl.uniform1f(h.uRadiusScale, this.pointOpts.radiusScale);
    gl.uniform4fv(h.uColor, toRgba01(this.pointOpts.color));
    gl.uniform1f(h.uWindowStart, ctx.windowStart);
    gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    gl.uniform1f(h.uFadeIn, fadeIn);
    gl.uniform1f(h.uFadeOut, fadeOut);
    // useFeature* uniforms are program-level, not VAO-recorded; set them every
    // draw so toggling colourProperty/radiusProperty at runtime takes effect.
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);
    gl.uniform1f(h.uUseFeatureRadius, c.radiusBuffer && h.aRadius >= 0 ? 1 : 0);

    // First-frame VAO setup: capture every attribute binding. Subsequent
    // frames just `bindVertexArray` and reuse all the state we recorded.
    this.bindVaoOrSetup(c, () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.positionBuffer);
      gl.enableVertexAttribArray(h.aMercator);
      gl.vertexAttribPointer(h.aMercator, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
      gl.enableVertexAttribArray(h.aTime);
      gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

      if (c.colorBuffer && h.aColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
        gl.enableVertexAttribArray(h.aColor);
        gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      }
      if (c.radiusBuffer && h.aRadius >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.radiusBuffer);
        gl.enableVertexAttribArray(h.aRadius);
        gl.vertexAttribPointer(h.aRadius, 1, gl.FLOAT, false, 0, 0);
      }
    });

    gl.drawArrays(gl.POINTS, 0, cache.vertexCount);
  }
}
