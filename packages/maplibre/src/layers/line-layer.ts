/**
 * Line geometry adapter — renders LINESTRING-type tiles as screen-space thick
 * lines (constant pixel width across zoom).
 *
 * Each segment is drawn as a single *instance* of a shared 4-vertex unit quad.
 * Per-instance attributes carry the segment endpoints, times, and (optional)
 * per-feature colour / width. This replaces the legacy CPU-side 4×-expansion
 * pass: the same N segments now occupy 1/4 the GPU memory and skip the per-
 * frame walk that copied positions into corner-major buffers.
 *
 * Instancing requires WebGL2 (core) or WebGL1 + `ANGLE_instanced_arrays`.
 * Layers on a runtime without instancing log a warning and drop the tile —
 * the only browsers without it are end-of-life Edge and IE, neither of which
 * the rest of the STT stack targets.
 */

import type { Tile, Layer as STTLayer } from '@poopdeck.gl/core';
import {
  GeometryType,
  DEFAULT_LINE_PALETTE as CORE_LINE_PALETTE,
} from '@poopdeck.gl/core';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from '../base-layer.js';
import { lngLatToMercator } from '../lib/projection.js';
import { TIME_WINDOW_GLSL } from '../shaders/time-window.glsl.js';

// Shared with @poopdeck.gl/layers AnimatedPathLayer (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_LINE_PALETTE: ReadonlyArray<RGBA8> = CORE_LINE_PALETTE;

export interface STTLineLayerOptions extends STTBaseLayerOptions {
  /** Line color as [r, g, b, a] in the 0–1 range. Ignored when `colorProperty` is set. */
  color?: [number, number, number, number];
  /** Line width in pixels. Ignored when `widthProperty` is set. */
  width?: number;
  /** Optional multiplier applied to per-feature widths. */
  widthScale?: number;
  /** Drive per-feature colour from a categorical property name. */
  colorProperty?: string;
  /** Palette used with `colorProperty` (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA color map (deck/three `colorMapping`
   * parity). When set, `colorProperty`'s category NAME is looked up here so a
   * category renders the same color in every tile regardless of per-tile
   * dictionary order. Unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional `colorPalette`.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Color for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /** Drive per-feature pixel width from a numeric property name. */
  widthProperty?: string;
}

// The instanced VS reads (side, along) ∈ {-1,1} × {0,1} from the unit-quad
// vertex attribute, then picks the segment endpoint and perpendicular offset.
// `aPosA`/`aPosB` are the *segment endpoints*, not the 4 corners; the 4×
// expansion happens in the GPU rasterizer — we're removing the redundant CPU
// broadcast that the v0.2 layer was doing on every tile load.
const VS_SOURCE = `
  precision highp float;
  attribute vec2 aCorner;      // (side, along) ∈ {-1,1} × {0,1}, per-vertex
  attribute vec2 aPosA;        // segment start, per-instance
  attribute vec2 aPosB;        // segment end, per-instance
  attribute vec2 aTime;        // [startTime, endTime], per-instance
  attribute vec4 aColor;       // per-feature RGBA (when uUseFeatureColor=1)
  attribute float aWidth;      // per-feature width (when uUseFeatureWidth=1)
  uniform mat4 uMatrix;
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uUseFeatureWidth;
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
    vec2 posM = mix(aPosA, aPosB, aCorner.y);     // pick A or B endpoint
    vec2 neighborM = mix(aPosB, aPosA, aCorner.y); // and its neighbour
    vec4 here = uMatrix * vec4(posM, 0.0, 1.0);
    vec4 there = uMatrix * vec4(neighborM, 0.0, 1.0);
    vec2 hereNdc = here.xy / here.w;
    vec2 thereNdc = there.xy / there.w;
    // Direction in pixels from here to there; offset perpendicular so the
    // line keeps a constant on-screen width across zooms.
    vec2 dirPx = (thereNdc - hereNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    // The B-end's neighbour is A → its perpendicular points the *other* way
    // along the segment. Flip the side so the quad winds consistently.
    float sideSign = (aCorner.y > 0.5) ? -1.0 : 1.0;
    vec2 perp = vec2(-dirN.y, dirN.x) * sideSign;
    float widthPx = (uUseFeatureWidth > 0.5 ? aWidth : uWidth) * uWidthScale;
    vec2 offsetPx = perp * aCorner.x * widthPx * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;

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
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha);
  }
`;

interface LineProgramHandles {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  aTime: number;
  aColor: number;
  aWidth: number;
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uUseFeatureWidth: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
}

interface LineGpuCache extends TileGpuCache {
  /** Per-instance segment-start positions, stride-2 Float32. */
  posABuffer: WebGLBuffer;
  /** Per-instance segment-end positions, stride-2 Float32. */
  posBBuffer: WebGLBuffer;
  /** Number of segments (= number of instances). */
  instanceCount: number;
  colorBuffer?: WebGLBuffer;
  widthBuffer?: WebGLBuffer;
}

export class STTLineLayer extends STTBaseLayer {
  protected lineOpts: {
    color: [number, number, number, number];
    width: number;
    widthScale: number;
    colorProperty?: string;
    widthProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
  };
  private handles?: LineProgramHandles;

  constructor(opts: STTLineLayerOptions) {
    super(opts);
    this.lineOpts = {
      color: opts.color ?? [0.31, 0.76, 0.97, 1.0],
      width: opts.width ?? 2,
      widthScale: opts.widthScale ?? 1,
      colorProperty: opts.colorProperty,
      widthProperty: opts.widthProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_LINE_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
    };
  }

  setColor(color: [number, number, number, number]): void {
    this.lineOpts.color = color;
    this.map?.triggerRepaint();
  }

  setWidth(width: number): void {
    this.lineOpts.width = width;
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
      aTime: gl.getAttribLocation(program, 'aTime'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aWidth: gl.getAttribLocation(program, 'aWidth'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uWidth: gl.getUniformLocation(program, 'uWidth'),
      uWidthScale: gl.getUniformLocation(program, 'uWidthScale'),
      uUseFeatureWidth: gl.getUniformLocation(program, 'uUseFeatureWidth'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
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
  ): LineGpuCache | null {
    if (!this.instSupport.enabled) {
      // No instancing → no line rendering. Logged so hosts can detect and
      // swap to a different renderer / runtime.
      console.warn(
        `[${this.id}] runtime lacks ANGLE_instanced_arrays / WebGL2; ` +
          `STTLineLayer requires instancing.`,
      );
      return null;
    }
    const f = layer.features;
    if (!f.positions?.length || !f.startIndices) return null;

    const dims: 2 | 3 = f.positionDimensions === 3 ? 3 : 2;
    const startIndices = f.startIndices;
    const featureCount = startIndices.length - 1;

    // Count segments across all features.
    let segmentCount = 0;
    for (let i = 0; i < featureCount; i++) {
      const vs = startIndices[i + 1] - startIndices[i];
      if (vs >= 2) segmentCount += vs - 1;
    }
    if (segmentCount === 0) return null;

    // Per-instance buffers — one row per segment, not per quad corner. This
    // is the core memory win vs. v0.2: 4× less data uploaded per tile and no
    // main-thread expansion pass.
    const posA = new Float32Array(segmentCount * 2);
    const posB = new Float32Array(segmentCount * 2);
    const times = new Float32Array(segmentCount * 2);

    const featureColors = this.lineOpts.colorProperty
      ? this.expandCategoricalColors(
          f,
          this.lineOpts.colorProperty,
          this.lineOpts.colorPalette,
          this.lineOpts.colorMapping,
          this.lineOpts.colorMappingDefault,
        )
      : null;
    const featureWidths = this.lineOpts.widthProperty
      ? this.getNumericProperty(f, this.lineOpts.widthProperty)
      : null;
    const colorAttr = featureColors ? new Uint8Array(segmentCount * 4) : null;
    const widthAttr = featureWidths ? new Float32Array(segmentCount) : null;

    let s = 0;
    for (let fi = 0; fi < featureCount; fi++) {
      const begin = startIndices[fi];
      const end = startIndices[fi + 1];
      const ts = f.startTimes[fi];
      const te = f.endTimes[fi];
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
        posA[s * 2] = ax;
        posA[s * 2 + 1] = ay;
        posB[s * 2] = bx;
        posB[s * 2 + 1] = by;
        times[s * 2] = ts;
        times[s * 2 + 1] = te;
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
    const timeBuffer = this.uploadArrayBuffer(gl, times);
    // The base TileGpuCache type expects `positionBuffer`. We keep posA there
    // (the "primary" data) so the inherited cleanup walks delete it.
    const positionBuffer = posABuffer;

    const extras: WebGLBuffer[] = [posBBuffer];
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
      // `vertexCount` here is the number of segments — old tests assert
      // 4 verts/segment (legacy 12), which no longer applies. The replacement
      // assertion is `instanceCount`.
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
    const c = cache as LineGpuCache;

    gl.useProgram(h.program);
    gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uWidth, this.lineOpts.width);
    gl.uniform1f(h.uWidthScale, this.lineOpts.widthScale);
    gl.uniform4fv(h.uColor, toRgba01(this.lineOpts.color));
    gl.uniform1f(h.uWindowStart, ctx.windowStart);
    gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    gl.uniform1f(h.uFadeIn, fadeIn);
    gl.uniform1f(h.uFadeOut, fadeOut);
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);
    gl.uniform1f(h.uUseFeatureWidth, c.widthBuffer && h.aWidth >= 0 ? 1 : 0);

    const quad = this.getUnitQuad(gl);
    this.bindVaoOrSetup(c, () => {
      // Per-vertex quad corner (divisor 0).
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(h.aCorner);
      gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aCorner, 0);

      // Per-instance attributes (divisor 1).
      gl.bindBuffer(gl.ARRAY_BUFFER, c.posABuffer);
      gl.enableVertexAttribArray(h.aPosA);
      gl.vertexAttribPointer(h.aPosA, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aPosA, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.posBBuffer);
      gl.enableVertexAttribArray(h.aPosB);
      gl.vertexAttribPointer(h.aPosB, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aPosB, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
      gl.enableVertexAttribArray(h.aTime);
      gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aTime, 1);

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

    // 4 verts per quad × N segment instances, drawn as TRIANGLE_STRIP. No
    // gl_VertexID needed so this works on WebGL1 + ANGLE_instanced_arrays.
    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );
  }
}
