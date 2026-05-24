/**
 * Animated trips adapter — renders LINESTRING-type tiles with a trailing fade
 * effect anchored at the current time. Equivalent to
 * `@stt/deck.gl`'s `AnimatedTripsLayer`.
 *
 * Each line segment is expanded into a screen-space quad (same layout as
 * STTLineLayer). Per-vertex timestamps come from `binary.vertexTimestamps`
 * when present; otherwise we interpolate linearly between the feature's
 * `startTimes`/`endTimes`. Alpha drops to 0 for vertices older than
 * `currentTime - trailLength`, ramps to 1 at `currentTime`, and is clipped to
 * 0 for vertices in the future.
 *
 * For static-window line rendering, use STTLineLayer instead.
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

const DEFAULT_TRIPS_PALETTE: ReadonlyArray<RGBA8> = [
  [253, 128, 93, 255],
  [0, 150, 255, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
];

export interface STTTripsLayerOptions extends STTBaseLayerOptions {
  /** Constant line colour (overridden by `colorProperty`). */
  color?: [number, number, number, number];
  /** Constant line width in pixels (overridden by `widthProperty`). */
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
  /** Palette used with `colorProperty` (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /** Drive per-feature width from a numeric property name. */
  widthProperty?: string;
}

const VS_SOURCE = `
  precision highp float;
  attribute vec3 aPos;
  attribute vec3 aNeighbor;
  attribute float aSide;
  attribute float aVertexTime; // relative to tile timeOffset
  attribute vec4 aColor;
  attribute float aWidth;
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

    // Trail logic: hide vertices in the future or older than trailLength.
    if (aVertexTime > uCurrentTime) {
      vAlpha = 0.0;
    } else {
      float age = uCurrentTime - aVertexTime;
      if (age > uTrailLength) {
        vAlpha = 0.0;
      } else if (uFadeTrail > 0.5 && uTrailLength > 0.0) {
        vAlpha = clamp(1.0 - age / uTrailLength, 0.0, 1.0);
      } else {
        vAlpha = 1.0;
      }
    }
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
  aPos: number;
  aNeighbor: number;
  aSide: number;
  aVertexTime: number;
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
  neighborBuffer: WebGLBuffer;
  sideBuffer: WebGLBuffer;
  vertexTimeBuffer: WebGLBuffer;
  use32BitIndices: boolean;
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
      aPos: gl.getAttribLocation(program, 'aPos'),
      aNeighbor: gl.getAttribLocation(program, 'aNeighbor'),
      aSide: gl.getAttribLocation(program, 'aSide'),
      aVertexTime: gl.getAttribLocation(program, 'aVertexTime'),
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

    const vertexCount = segmentCount * 4;
    if (vertexCount > 65535 && !this.supports32BitIndices) {
      console.warn(
        `[${this.id}] trips tile has ${vertexCount} vertices, but WebGL1 ` +
          `runtime lacks OES_element_index_uint; dropping tile.`,
      );
      return null;
    }

    const pos = new Float32Array(vertexCount * 3);
    const nbr = new Float32Array(vertexCount * 3);
    const side = new Float32Array(vertexCount);
    // Per-vertex time (relative to tile timeOffset). Two GPU-shared per quad
    // corner pair — we set both endpoints' times so the GPU interpolates
    // alpha across the segment naturally.
    const vTime = new Float32Array(vertexCount);
    // Per-feature start/end time (only used as part of the per-vertex
    // interpolation when vertexTimestamps is missing).
    const use32 = vertexCount > 65535;
    const idx = use32
      ? new Uint32Array(segmentCount * 6)
      : new Uint16Array(segmentCount * 6);

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
    const colorAttr = featureColors ? new Uint8Array(vertexCount * 4) : null;
    const widthAttr = featureWidths ? new Float32Array(vertexCount) : null;

    let vWrite = 0;
    let iWrite = 0;
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
        const aLon = f.positions[v * dims];
        const aLat = f.positions[v * dims + 1];
        const bLon = f.positions[(v + 1) * dims];
        const bLat = f.positions[(v + 1) * dims + 1];
        const [ax, ay] = lngLatToMercator(aLon, aLat);
        const [bx, by] = lngLatToMercator(bLon, bLat);

        // Per-vertex time for each endpoint.
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

        const corners: Array<{
          p: [number, number];
          n: [number, number];
          s: number;
          t: number;
        }> = [
          { p: [ax, ay], n: [bx, by], s: -1, t: tA },
          { p: [ax, ay], n: [bx, by], s: 1, t: tA },
          { p: [bx, by], n: [ax, ay], s: 1, t: tB },
          { p: [bx, by], n: [ax, ay], s: -1, t: tB },
        ];
        for (let c = 0; c < 4; c++) {
          pos[vWrite * 3] = corners[c].p[0];
          pos[vWrite * 3 + 1] = corners[c].p[1];
          pos[vWrite * 3 + 2] = 0;
          nbr[vWrite * 3] = corners[c].n[0];
          nbr[vWrite * 3 + 1] = corners[c].n[1];
          nbr[vWrite * 3 + 2] = 0;
          side[vWrite] = corners[c].s;
          vTime[vWrite] = corners[c].t;
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

    const positionBuffer = this.uploadArrayBuffer(gl, pos);
    const neighborBuffer = this.uploadArrayBuffer(gl, nbr);
    const sideBuffer = this.uploadArrayBuffer(gl, side);
    const vertexTimeBuffer = this.uploadArrayBuffer(gl, vTime);
    // We keep a dummy 0-length time buffer to satisfy the base TileGpuCache
    // type — trips don't use the per-feature time attribute, but the base
    // class lifecycle expects to own a `timeBuffer`.
    const timeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);

    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    const extras: WebGLBuffer[] = [
      neighborBuffer,
      sideBuffer,
      vertexTimeBuffer,
    ];
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
      vertexTimeBuffer,
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
    const c = cache as TripsGpuCache;

    gl.useProgram(h.program);
    gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uWidth, this.tripsOpts.width);
    gl.uniform1f(h.uWidthScale, this.tripsOpts.widthScale);
    gl.uniform4fv(h.uColor, this.tripsOpts.color);
    // currentTime relative to this tile's timeOffset (same convention as the
    // window-mode shaders).
    gl.uniform1f(h.uCurrentTime, ctx.currentTime - c.timeOffset);
    gl.uniform1f(h.uTrailLength, this.tripsOpts.trailLength);
    gl.uniform1f(h.uFadeTrail, this.tripsOpts.fadeTrail ? 1 : 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.positionBuffer);
    gl.enableVertexAttribArray(h.aPos);
    gl.vertexAttribPointer(h.aPos, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.neighborBuffer);
    gl.enableVertexAttribArray(h.aNeighbor);
    gl.vertexAttribPointer(h.aNeighbor, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.sideBuffer);
    gl.enableVertexAttribArray(h.aSide);
    gl.vertexAttribPointer(h.aSide, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.vertexTimeBuffer);
    gl.enableVertexAttribArray(h.aVertexTime);
    gl.vertexAttribPointer(h.aVertexTime, 1, gl.FLOAT, false, 0, 0);

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
    gl.disableVertexAttribArray(h.aVertexTime);
    if (c.colorBuffer && h.aColor >= 0) gl.disableVertexAttribArray(h.aColor);
    if (c.widthBuffer && h.aWidth >= 0) gl.disableVertexAttribArray(h.aWidth);
  }
}
