/**
 * Line geometry adapter — renders LINESTRING-type tiles as screen-space thick
 * lines (constant pixel width across zoom).
 *
 * Each segment is expanded to a quad (two triangles) on the CPU and offset
 * along its screen-space normal in the vertex shader. This is the same
 * approach deck.gl's PathLayer uses, kept minimal: no rounded joints, no
 * dashes, no per-vertex width — just a single solid stroke per layer.
 */

import type { Tile, Layer as STTLayer } from '@stt/core';
import { GeometryType } from '@stt/core';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from './base-layer';
import { lngLatToMercator } from './projection';

// Default categorical palette (matches @stt/deck.gl AnimatedPathLayer's).
const DEFAULT_LINE_PALETTE: ReadonlyArray<RGBA8> = [
  [0, 150, 255, 255],
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
  /** Drive per-feature pixel width from a numeric property name. */
  widthProperty?: string;
}

const VS_SOURCE = `
  precision highp float;
  attribute vec3 aPos;
  attribute vec3 aNeighbor;
  attribute float aSide;
  attribute vec2 aTime;
  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
  attribute float aWidth;      // per-feature width in pixels (when uUseFeatureWidth=1)
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
  void main() {
    vec4 a = uMatrix * vec4(aPos.x, aPos.y, 0.0, 1.0);
    vec4 b = uMatrix * vec4(aNeighbor.x, aNeighbor.y, 0.0, 1.0);
    vec2 aNdc = a.xy / a.w;
    vec2 bNdc = b.xy / b.w;
    vec2 dirPx = (bNdc - aNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    vec2 perp = vec2(-dirN.y, dirN.x);
    float widthPx = (uUseFeatureWidth > 0.5 ? aWidth : uWidth) * uWidthScale;
    vec2 offsetPx = perp * aSide * widthPx * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = a;
    outClip.xy += offsetNdc * a.w;
    gl_Position = outClip;

    float inside = (aTime.y >= uWindowStart && aTime.x <= uWindowEnd) ? 1.0 : 0.0;
    float entering = (uFadeIn > 0.0) ? clamp((aTime.y - uWindowStart) / uFadeIn, 0.0, 1.0) : 1.0;
    float leaving = (uFadeOut > 0.0) ? clamp((uWindowEnd - aTime.x) / uFadeOut, 0.0, 1.0) : 1.0;
    vAlpha = inside * min(entering, leaving);
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
  aPos: number;
  aNeighbor: number;
  aSide: number;
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
  neighborBuffer: WebGLBuffer;
  sideBuffer: WebGLBuffer;
  use32BitIndices: boolean;
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
      aPos: gl.getAttribLocation(program, 'aPos'),
      aNeighbor: gl.getAttribLocation(program, 'aNeighbor'),
      aSide: gl.getAttribLocation(program, 'aSide'),
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

    const vertexCount = segmentCount * 4;
    if (vertexCount > 65535 && !this.supports32BitIndices) {
      console.warn(
        `[${this.id}] tile has ${vertexCount} line vertices, but WebGL1 ` +
          `runtime lacks OES_element_index_uint; dropping tile.`,
      );
      return null;
    }
    const pos = new Float32Array(vertexCount * 3);
    const nbr = new Float32Array(vertexCount * 3);
    const side = new Float32Array(vertexCount);
    const times = new Float32Array(vertexCount * 2);
    const use32 = vertexCount > 65535;
    const idx = use32
      ? new Uint32Array(segmentCount * 6)
      : new Uint16Array(segmentCount * 6);

    // Per-feature attribute expansion (one value broadcast to all 4 verts of
    // each segment of that feature). Built only when properties are configured
    // AND present in the binary tile.
    const featureColors = this.lineOpts.colorProperty
      ? this.expandCategoricalColors(
          f,
          this.lineOpts.colorProperty,
          this.lineOpts.colorPalette,
        )
      : null;
    const featureWidths = this.lineOpts.widthProperty
      ? this.getNumericProperty(f, this.lineOpts.widthProperty)
      : null;
    const colorAttr = featureColors ? new Uint8Array(vertexCount * 4) : null;
    const widthAttr = featureWidths ? new Float32Array(vertexCount) : null;

    let vWrite = 0; // vertex index
    let iWrite = 0; // index buffer write head
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
        const aLon = f.positions[v * dims];
        const aLat = f.positions[v * dims + 1];
        const bLon = f.positions[(v + 1) * dims];
        const bLat = f.positions[(v + 1) * dims + 1];
        const [ax, ay] = lngLatToMercator(aLon, aLat);
        const [bx, by] = lngLatToMercator(bLon, bLat);

        // 4 verts per segment: (A,-1), (A,+1), (B,+1), (B,-1) — sides
        // chosen so the resulting quad winds (0,2,1)+(1,2,3).
        const corners: Array<{
          p: [number, number];
          n: [number, number];
          s: number;
        }> = [
          { p: [ax, ay], n: [bx, by], s: -1 },
          { p: [ax, ay], n: [bx, by], s: 1 },
          { p: [bx, by], n: [ax, ay], s: 1 },
          { p: [bx, by], n: [ax, ay], s: -1 },
        ];
        for (let c = 0; c < 4; c++) {
          pos[vWrite * 3] = corners[c].p[0];
          pos[vWrite * 3 + 1] = corners[c].p[1];
          pos[vWrite * 3 + 2] = 0;
          nbr[vWrite * 3] = corners[c].n[0];
          nbr[vWrite * 3 + 1] = corners[c].n[1];
          nbr[vWrite * 3 + 2] = 0;
          side[vWrite] = corners[c].s;
          times[vWrite * 2] = ts;
          times[vWrite * 2 + 1] = te;
          if (colorAttr) {
            colorAttr[vWrite * 4] = fr;
            colorAttr[vWrite * 4 + 1] = fg;
            colorAttr[vWrite * 4 + 2] = fb;
            colorAttr[vWrite * 4 + 3] = fa;
          }
          if (widthAttr) widthAttr[vWrite] = fw;
          vWrite++;
        }
        const base = vWrite - 4;
        idx[iWrite++] = base + 0;
        idx[iWrite++] = base + 2;
        idx[iWrite++] = base + 1;
        idx[iWrite++] = base + 1;
        idx[iWrite++] = base + 2;
        idx[iWrite++] = base + 3;
      }
    }

    const positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);

    const neighborBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, neighborBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, nbr, gl.STATIC_DRAW);

    const sideBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, sideBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, side, gl.STATIC_DRAW);

    const timeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, times, gl.STATIC_DRAW);

    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    const extras: WebGLBuffer[] = [neighborBuffer, sideBuffer];
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
      neighborBuffer,
      sideBuffer,
      indexBuffer,
      vertexCount,
      indexCount: idx.length,
      timeOffset: f.timeOffset,
      use32BitIndices: use32,
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
    gl.uniform4fv(h.uColor, this.lineOpts.color);
    gl.uniform1f(h.uWindowStart, ctx.windowStart);
    gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    gl.uniform1f(h.uFadeIn, fadeIn);
    gl.uniform1f(h.uFadeOut, fadeOut);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.positionBuffer);
    gl.enableVertexAttribArray(h.aPos);
    gl.vertexAttribPointer(h.aPos, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.neighborBuffer);
    gl.enableVertexAttribArray(h.aNeighbor);
    gl.vertexAttribPointer(h.aNeighbor, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.sideBuffer);
    gl.enableVertexAttribArray(h.aSide);
    gl.vertexAttribPointer(h.aSide, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

    if (c.colorBuffer && h.aColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
      gl.enableVertexAttribArray(h.aColor);
      gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.uniform1f(h.uUseFeatureColor, 1);
    } else {
      gl.uniform1f(h.uUseFeatureColor, 0);
    }
    if (c.widthBuffer && h.aWidth >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.widthBuffer);
      gl.enableVertexAttribArray(h.aWidth);
      gl.vertexAttribPointer(h.aWidth, 1, gl.FLOAT, false, 0, 0);
      gl.uniform1f(h.uUseFeatureWidth, 1);
    } else {
      gl.uniform1f(h.uUseFeatureWidth, 0);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, c.indexBuffer!);
    const indexType = c.use32BitIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.drawElements(gl.TRIANGLES, c.indexCount, indexType, 0);

    gl.disableVertexAttribArray(h.aPos);
    gl.disableVertexAttribArray(h.aNeighbor);
    gl.disableVertexAttribArray(h.aSide);
    gl.disableVertexAttribArray(h.aTime);
    if (c.colorBuffer && h.aColor >= 0) gl.disableVertexAttribArray(h.aColor);
    if (c.widthBuffer && h.aWidth >= 0) gl.disableVertexAttribArray(h.aWidth);
  }
}
