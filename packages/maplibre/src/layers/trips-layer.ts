/**
 * Animated trips adapter — renders LINESTRING-type tiles with a trailing fade
 * effect anchored at the current time. Equivalent to
 * @poopdeck.gl/layers's AnimatedTripsLayer.
 *
 * Each segment is drawn as one instance of a shared 4-vertex unit quad; the
 * per-instance attributes carry the two endpoints and their (relative)
 * timestamps. Alpha is computed in the vertex shader against the current
 * tile-relative time, using the shared trail-mode snippet. This matches the
 * deck.gl extension's per-vertex fade math exactly.
 *
 * If `binary.vertexTimestamps` is present we use it for endpoint times;
 * otherwise we interpolate linearly between the feature's start/end times.
 */

import type { Tile, Layer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_TRIPS_PALETTE as CORE_TRIPS_PALETTE } from '@poopdeck.gl/core';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from '../base-layer';
import { lngLatToMercator } from '../lib/projection';
import { TIME_TRAIL_GLSL } from '../shaders/time-window.glsl';

// Shared with @poopdeck.gl/layers AnimatedTripsLayer (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_TRIPS_PALETTE: ReadonlyArray<RGBA8> = CORE_TRIPS_PALETTE;

export interface STTTripsLayerOptions extends STTBaseLayerOptions {
  /** Constant line colour (overridden by colorProperty). */
  color?: [number, number, number, number];
  /** Constant line width in pixels (overridden by widthProperty). */
  width?: number;
  /** Multiplier applied to per-feature widths. */
  widthScale?: number;
  /** Trail length, in milliseconds. Vertices older than this are clipped. */
  trailLength?: number;
  /**
   * If true, alpha within the trail ramps 1 → 0 linearly with age. If false,
   * the whole trail is rendered with constant alpha (snake mode). Default true.
   */
  fadeTrail?: boolean;
  /** Drive per-feature colour from a categorical property name. */
  colorProperty?: string;
  /** Palette used with colorProperty (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /** Drive per-feature width from a numeric property name. */
  widthProperty?: string;
}

const VS_SOURCE = `
  precision highp float;
  attribute vec2 aCorner;        // (side, along) ∈ {-1,1} × {0,1}, per-vertex
  attribute vec2 aPosA;          // segment start, per-instance
  attribute vec2 aPosB;          // segment end, per-instance
  attribute vec2 aVertexTimeAB;  // [timeA, timeB], per-instance, tile-relative
  attribute vec4 aColor;         // per-feature RGBA (when uUseFeatureColor=1)
  attribute float aWidth;        // per-feature width (when uUseFeatureWidth=1)
  uniform mat4 uMatrix;
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uUseFeatureWidth;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
  uniform float uCurrentTime;
  uniform float uTrailLength;
  uniform float uFadeTrail;
  varying float vAlpha;
  varying vec4 vColor;
${TIME_TRAIL_GLSL}
  void main() {
    vec2 posM = mix(aPosA, aPosB, aCorner.y);
    vec2 neighborM = mix(aPosB, aPosA, aCorner.y);
    vec4 here = uMatrix * vec4(posM, 0.0, 1.0);
    vec4 there = uMatrix * vec4(neighborM, 0.0, 1.0);
    vec2 hereNdc = here.xy / here.w;
    vec2 thereNdc = there.xy / there.w;
    vec2 dirPx = (thereNdc - hereNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    float sideSign = (aCorner.y > 0.5) ? -1.0 : 1.0;
    vec2 perp = vec2(-dirN.y, dirN.x) * sideSign;
    float widthPx = (uUseFeatureWidth > 0.5 ? aWidth : uWidth) * uWidthScale;
    vec2 offsetPx = perp * aCorner.x * widthPx * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;

    float vertexTime = mix(aVertexTimeAB.x, aVertexTimeAB.y, aCorner.y);
    vAlpha = sttTrailAlpha(vertexTime, uCurrentTime, uTrailLength, uFadeTrail);
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha);
  }
`;

interface TripsProgramHandles {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  aVertexTimeAB: number;
  aColor: number;
  aWidth: number;
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uUseFeatureWidth: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uTrailLength: WebGLUniformLocation | null;
  uFadeTrail: WebGLUniformLocation | null;
}

interface TripsGpuCache extends TileGpuCache {
  posABuffer: WebGLBuffer;
  posBBuffer: WebGLBuffer;
  vertexTimeABBuffer: WebGLBuffer;
  instanceCount: number;
  colorBuffer?: WebGLBuffer;
  widthBuffer?: WebGLBuffer;
}

export class STTTripsLayer extends STTBaseLayer {
  private tripsOpts: {
    color: [number, number, number, number];
    width: number;
    widthScale: number;
    trailLength: number;
    fadeTrail: boolean;
    colorProperty?: string;
    widthProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
  };
  private handles?: TripsProgramHandles;

  constructor(opts: STTTripsLayerOptions) {
    super(opts);
    this.tripsOpts = {
      color: opts.color ?? [0.99, 0.5, 0.36, 1.0],
      width: opts.width ?? 2,
      widthScale: opts.widthScale ?? 1,
      trailLength: opts.trailLength ?? 180_000, // 3 minutes default, matches deck.gl
      fadeTrail: opts.fadeTrail ?? true,
      colorProperty: opts.colorProperty,
      widthProperty: opts.widthProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_TRIPS_PALETTE,
    };
  }

  /** Update the trail length (ms) at runtime. */
  setTrailLength(ms: number): void {
    this.tripsOpts.trailLength = ms;
    this.map?.triggerRepaint();
  }

  setColor(color: [number, number, number, number]): void {
    this.tripsOpts.color = color;
    this.map?.triggerRepaint();
  }

  setWidth(width: number): void {
    this.tripsOpts.width = width;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.LineString;
  }

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const program = this.linkProgram(gl, VS_SOURCE, FS_SOURCE);
    this.handles = {
      program,
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aPosA: gl.getAttribLocation(program, 'aPosA'),
      aPosB: gl.getAttribLocation(program, 'aPosB'),
      aVertexTimeAB: gl.getAttribLocation(program, 'aVertexTimeAB'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aWidth: gl.getAttribLocation(program, 'aWidth'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uWidth: gl.getUniformLocation(program, 'uWidth'),
      uWidthScale: gl.getUniformLocation(program, 'uWidthScale'),
      uUseFeatureWidth: gl.getUniformLocation(program, 'uUseFeatureWidth'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
      uTrailLength: gl.getUniformLocation(program, 'uTrailLength'),
      uFadeTrail: gl.getUniformLocation(program, 'uFadeTrail'),
    };
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.handles) {
      gl.deleteProgram(this.handles.program);
      this.handles = undefined;
    }
  }

  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): TripsGpuCache | null {
    if (!this.instSupport.enabled) {
      console.warn(
        `[${this.id}] runtime lacks ANGLE_instanced_arrays / WebGL2; ` +
          `STTTripsLayer requires instancing.`,
      );
      return null;
    }
    const f = layer.features;
    if (!f.positions?.length || !f.startIndices) return null;

    const dims: 2 | 3 = f.positionDimensions === 3 ? 3 : 2;
    const startIndices = f.startIndices;
    const featureCount = startIndices.length - 1;
    const hasVertexTimestamps =
      !!f.vertexTimestamps && f.vertexTimestamps.length > 0;

    let segmentCount = 0;
    for (let i = 0; i < featureCount; i++) {
      const vs = startIndices[i + 1] - startIndices[i];
      if (vs >= 2) segmentCount += vs - 1;
    }
    if (segmentCount === 0) return null;

    const posA = new Float32Array(segmentCount * 2);
    const posB = new Float32Array(segmentCount * 2);
    const vTimeAB = new Float32Array(segmentCount * 2);

    const featureColors = this.tripsOpts.colorProperty
      ? this.expandCategoricalColors(
          f,
          this.tripsOpts.colorProperty,
          this.tripsOpts.colorPalette,
        )
      : null;
    const featureWidths = this.tripsOpts.widthProperty
      ? this.getNumericProperty(f, this.tripsOpts.widthProperty)
      : null;
    const colorAttr = featureColors ? new Uint8Array(segmentCount * 4) : null;
    const widthAttr = featureWidths ? new Float32Array(segmentCount) : null;

    let s = 0;
    for (let fi = 0; fi < featureCount; fi++) {
      const begin = startIndices[fi];
      const end = startIndices[fi + 1];
      const numVerts = end - begin;
      if (numVerts < 2) continue;

      const ts = f.startTimes[fi];
      const te = f.endTimes[fi];
      const duration = te - ts;
      const fr = featureColors ? featureColors[fi * 4] : 0;
      const fg = featureColors ? featureColors[fi * 4 + 1] : 0;
      const fb = featureColors ? featureColors[fi * 4 + 2] : 0;
      const fa = featureColors ? featureColors[fi * 4 + 3] : 255;
      const fw = featureWidths ? featureWidths[fi] : 0;

      for (let v = begin; v < end - 1; v++) {
        const [ax, ay] = lngLatToMercator(
          f.positions[v * dims],
          f.positions[v * dims + 1],
        );
        const [bx, by] = lngLatToMercator(
          f.positions[(v + 1) * dims],
          f.positions[(v + 1) * dims + 1],
        );
        const localIdxA = v - begin;
        const localIdxB = localIdxA + 1;
        const tA = hasVertexTimestamps
          ? f.vertexTimestamps![v]
          : numVerts > 1
            ? ts + (localIdxA / (numVerts - 1)) * duration
            : ts;
        const tB = hasVertexTimestamps
          ? f.vertexTimestamps![v + 1]
          : numVerts > 1
            ? ts + (localIdxB / (numVerts - 1)) * duration
            : te;
        posA[s * 2] = ax;
        posA[s * 2 + 1] = ay;
        posB[s * 2] = bx;
        posB[s * 2 + 1] = by;
        vTimeAB[s * 2] = tA;
        vTimeAB[s * 2 + 1] = tB;
        if (colorAttr) {
          colorAttr[s * 4] = fr;
          colorAttr[s * 4 + 1] = fg;
          colorAttr[s * 4 + 2] = fb;
          colorAttr[s * 4 + 3] = fa;
        }
        if (widthAttr) widthAttr[s] = fw;
        s++;
      }
    }

    const posABuffer = this.uploadArrayBuffer(gl, posA);
    const posBBuffer = this.uploadArrayBuffer(gl, posB);
    const vertexTimeABBuffer = this.uploadArrayBuffer(gl, vTimeAB);
    // Keep a dummy timeBuffer to satisfy the base TileGpuCache contract — the
    // trail shader doesn't read [startTime,endTime] (that's window mode), so
    // we point it at a zero-length buffer rather than the per-instance times.
    const timeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);

    const positionBuffer = posABuffer;
    const extras: WebGLBuffer[] = [posBBuffer, vertexTimeABBuffer];
    let colorBuffer: WebGLBuffer | undefined;
    let widthBuffer: WebGLBuffer | undefined;
    if (colorAttr) {
      colorBuffer = this.uploadArrayBuffer(gl, colorAttr);
      extras.push(colorBuffer);
    }
    if (widthAttr) {
      widthBuffer = this.uploadArrayBuffer(gl, widthAttr);
      extras.push(widthBuffer);
    }

    return {
      positionBuffer,
      timeBuffer,
      posABuffer,
      posBBuffer,
      vertexTimeABBuffer,
      vertexCount: segmentCount,
      indexCount: 0,
      instanceCount: segmentCount,
      timeOffset: f.timeOffset,
      extraBuffers: extras,
      colorBuffer,
      widthBuffer,
    };
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
    const c = cache as TripsGpuCache;

    gl.useProgram(h.program);
    gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uWidth, this.tripsOpts.width);
    gl.uniform1f(h.uWidthScale, this.tripsOpts.widthScale);
    gl.uniform4fv(h.uColor, toRgba01(this.tripsOpts.color));
    // currentTime relative to this tile's timeOffset (same convention as the
    // window-mode shaders).
    gl.uniform1f(h.uCurrentTime, ctx.currentTime - c.timeOffset);
    gl.uniform1f(h.uTrailLength, this.tripsOpts.trailLength);
    gl.uniform1f(h.uFadeTrail, this.tripsOpts.fadeTrail ? 1 : 0);
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);
    gl.uniform1f(h.uUseFeatureWidth, c.widthBuffer && h.aWidth >= 0 ? 1 : 0);

    const quad = this.getUnitQuad(gl);
    this.bindVaoOrSetup(c, () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(h.aCorner);
      gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aCorner, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.posABuffer);
      gl.enableVertexAttribArray(h.aPosA);
      gl.vertexAttribPointer(h.aPosA, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aPosA, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.posBBuffer);
      gl.enableVertexAttribArray(h.aPosB);
      gl.vertexAttribPointer(h.aPosB, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aPosB, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.vertexTimeABBuffer);
      gl.enableVertexAttribArray(h.aVertexTimeAB);
      gl.vertexAttribPointer(h.aVertexTimeAB, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aVertexTimeAB, 1);

      if (c.colorBuffer && h.aColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
        gl.enableVertexAttribArray(h.aColor);
        gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        this.instSupport.vertexAttribDivisor(h.aColor, 1);
      }
      if (c.widthBuffer && h.aWidth >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.widthBuffer);
        gl.enableVertexAttribArray(h.aWidth);
        gl.vertexAttribPointer(h.aWidth, 1, gl.FLOAT, false, 0, 0);
        this.instSupport.vertexAttribDivisor(h.aWidth, 1);
      }
    });

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );
  }
}
