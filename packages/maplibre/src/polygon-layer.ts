/**
 * Polygon geometry adapter — renders POLYGON-type tiles as filled triangles,
 * with optional outline strokes and extruded side walls.
 *
 * Triangulation runs on the CPU at tile-load time via earcut, then we upload
 * the vertices + indices once and toggle alpha per-feature in the vertex
 * shader using the time-window uniforms.
 *
 * Each STT feature is treated as a single ring. Multi-ring polygons (holes)
 * are not yet supported — they need either an additional `holeIndices` field
 * in BinaryFeatures or a convention encoded in the existing `startIndices`.
 * The current STT-build pipeline only emits single rings, so this matches.
 *
 * Stroked / extruded parity:
 *   - `stroked: true` adds an outline pass over each ring edge, drawn with the
 *     same screen-space quad expansion as STTLineLayer.
 *   - `extruded: true` raises the polygon top to a per-feature elevation (in
 *     mercator-z units, scaled by `altitudeScale`) and draws side walls down
 *     to z=0. Pair with `map.setPitch(...)` to actually see the relief.
 */

import earcut from 'earcut';
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
import { TIME_WINDOW_GLSL } from './shaders/time-window.glsl';

// Categorical default palette (matches @stt/deck.gl AnimatedPolygonLayer).
const DEFAULT_POLY_PALETTE: ReadonlyArray<RGBA8> = [
  [255, 140, 0, 180],
  [31, 119, 180, 180],
  [44, 160, 44, 180],
  [214, 39, 40, 180],
  [148, 103, 189, 180],
  [140, 86, 75, 180],
  [227, 119, 194, 180],
  [127, 127, 127, 180],
  [188, 189, 34, 180],
  [23, 190, 207, 180],
];

export interface STTPolygonLayerOptions extends STTBaseLayerOptions {
  /** Fill color as [r, g, b, a] in the 0–1 range. Ignored when `fillColorProperty` is set. */
  color?: [number, number, number, number];
  /** Drive per-feature fill colour from a categorical property name. */
  fillColorProperty?: string;
  /** Palette used with `fillColorProperty` (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /** Whether the polygon is filled. Default true. */
  filled?: boolean;
  /** Whether each ring is also drawn as an outline. Default false. */
  stroked?: boolean;
  /** Outline color when `stroked: true`. */
  lineColor?: [number, number, number, number];
  /** Outline pixel width when `stroked: true`. Default 1. */
  lineWidth?: number;
  /**
   * Whether polygons should be extruded into 3D prisms. Requires the map to be
   * pitched (`map.setPitch`) for the relief to be visible. Default false.
   */
  extruded?: boolean;
  /**
   * Per-feature elevation height in metres (or any unit understood by your
   * `altitudeScale`). Either a constant or a numeric property name on the
   * tile's features. Default 0.
   */
  elevation?: number | string;
  /**
   * Conversion factor from `elevation` units to mercator-z units. The default
   * (`1e-7`) treats `elevation` as metres at low to mid latitudes — buildings
   * a few hundred metres tall remain visible at typical zoom levels. Override
   * if you're passing elevation in other units.
   */
  altitudeScale?: number;
}

const VS_SOURCE = `
  precision highp float;
  attribute vec3 aMercator;
  attribute vec2 aTime;
  attribute vec4 aColor;
  uniform mat4 uMatrix;
  uniform float uAltitudeScale;
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
    gl_Position = uMatrix * vec4(aMercator.x, aMercator.y, aMercator.z * uAltitudeScale, 1.0);
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

// Outline shader: same screen-space line expansion as STTLineLayer, kept
// inline here to avoid cross-layer coupling.
const STROKE_VS_SOURCE = `
  precision highp float;
  attribute vec3 aPos;
  attribute vec3 aNeighbor;
  attribute float aSide;
  attribute vec2 aTime;
  uniform mat4 uMatrix;
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
  void main() {
    vec4 a = uMatrix * vec4(aPos.x, aPos.y, 0.0, 1.0);
    vec4 b = uMatrix * vec4(aNeighbor.x, aNeighbor.y, 0.0, 1.0);
    vec2 aNdc = a.xy / a.w;
    vec2 bNdc = b.xy / b.w;
    vec2 dirPx = (bNdc - aNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    vec2 perp = vec2(-dirN.y, dirN.x);
    vec2 offsetPx = perp * aSide * uWidth * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = a;
    outClip.xy += offsetNdc * a.w;
    gl_Position = outClip;
    float inside = (aTime.y >= uWindowStart && aTime.x <= uWindowEnd) ? 1.0 : 0.0;
    float entering = (uFadeIn > 0.0) ? clamp((aTime.y - uWindowStart) / uFadeIn, 0.0, 1.0) : 1.0;
    float leaving = (uFadeOut > 0.0) ? clamp((uWindowEnd - aTime.x) / uFadeOut, 0.0, 1.0) : 1.0;
    vAlpha = inside * min(entering, leaving);
  }
`;

const STROKE_FS_SOURCE = `
  precision highp float;
  uniform vec4 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(uColor.rgb, uColor.a * vAlpha);
  }
`;

interface PolygonProgramHandles {
  program: WebGLProgram;
  aMercator: number;
  aTime: number;
  aColor: number;
  uMatrix: WebGLUniformLocation | null;
  uAltitudeScale: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
}

interface StrokeProgramHandles {
  program: WebGLProgram;
  aPos: number;
  aNeighbor: number;
  aSide: number;
  aTime: number;
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
}

interface PolygonGpuCache extends TileGpuCache {
  use32BitIndices: boolean;
  /** Per-vertex RGBA colours (Uint8 normalized) when `fillColorProperty` is in use. */
  colorBuffer?: WebGLBuffer;
  /** Optional stroke pass: line-quad vertex / index buffers over the ring edges. */
  stroke?: {
    positionBuffer: WebGLBuffer;
    neighborBuffer: WebGLBuffer;
    sideBuffer: WebGLBuffer;
    timeBuffer: WebGLBuffer;
    indexBuffer: WebGLBuffer;
    indexCount: number;
    use32BitIndices: boolean;
  };
}

export class STTPolygonLayer extends STTBaseLayer {
  private polyOpts: {
    color: [number, number, number, number];
    fillColorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    filled: boolean;
    stroked: boolean;
    lineColor: [number, number, number, number];
    lineWidth: number;
    extruded: boolean;
    elevation: number | string;
    altitudeScale: number;
  };
  private handles?: PolygonProgramHandles;
  private strokeHandles?: StrokeProgramHandles;

  constructor(opts: STTPolygonLayerOptions) {
    super(opts);
    this.polyOpts = {
      color: opts.color ?? [0.99, 0.55, 0.2, 0.7],
      fillColorProperty: opts.fillColorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_POLY_PALETTE,
      filled: opts.filled ?? true,
      stroked: opts.stroked ?? false,
      lineColor: opts.lineColor ?? [0, 0, 0, 1],
      lineWidth: opts.lineWidth ?? 1,
      extruded: opts.extruded ?? false,
      elevation: opts.elevation ?? 0,
      altitudeScale: opts.altitudeScale ?? 1e-7,
    };
  }

  setColor(color: [number, number, number, number]): void {
    this.polyOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Toggle the polygon stroke at runtime. */
  setStroked(stroked: boolean): void {
    this.polyOpts.stroked = stroked;
    this.map?.triggerRepaint();
  }

  /** Toggle extrusion at runtime. */
  setExtruded(extruded: boolean): void {
    this.polyOpts.extruded = extruded;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Polygon;
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
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uAltitudeScale: gl.getUniformLocation(program, 'uAltitudeScale'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
    };

    // Stroke pass uses a small dedicated program. We compile it eagerly so we
    // can flip `stroked` on/off at runtime without re-linking.
    const sprogram = this.linkProgram(gl, STROKE_VS_SOURCE, STROKE_FS_SOURCE);
    this.strokeHandles = {
      program: sprogram,
      aPos: gl.getAttribLocation(sprogram, 'aPos'),
      aNeighbor: gl.getAttribLocation(sprogram, 'aNeighbor'),
      aSide: gl.getAttribLocation(sprogram, 'aSide'),
      aTime: gl.getAttribLocation(sprogram, 'aTime'),
      uMatrix: gl.getUniformLocation(sprogram, 'uMatrix'),
      uViewport: gl.getUniformLocation(sprogram, 'uViewport'),
      uWidth: gl.getUniformLocation(sprogram, 'uWidth'),
      uColor: gl.getUniformLocation(sprogram, 'uColor'),
      uWindowStart: gl.getUniformLocation(sprogram, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(sprogram, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(sprogram, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(sprogram, 'uFadeOut'),
    };
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.handles) {
      gl.deleteProgram(this.handles.program);
      this.handles = undefined;
    }
    if (this.strokeHandles) {
      gl.deleteProgram(this.strokeHandles.program);
      this.strokeHandles = undefined;
    }
  }

  /**
   * Resolve per-feature elevation. If `elevation` is a property name, use the
   * matching `numericProps[name]`; otherwise broadcast the constant.
   */
  private resolveFeatureElevations(layer: STTLayer): Float32Array {
    const featureCount = (layer.features.startIndices?.length ?? 1) - 1;
    const out = new Float32Array(featureCount);
    const e = this.polyOpts.elevation;
    if (typeof e === 'string') {
      const arr = this.getNumericProperty(layer.features, e);
      if (arr) {
        for (let i = 0; i < featureCount; i++) out[i] = arr[i] ?? 0;
        return out;
      }
    }
    const constant = typeof e === 'number' ? e : 0;
    out.fill(constant);
    return out;
  }

  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): PolygonGpuCache | null {
    const f = layer.features;
    if (!f.positions?.length || !f.startIndices) return null;

    const dims: 2 | 3 = f.positionDimensions === 3 ? 3 : 2;
    const featureCount = f.startIndices.length - 1;
    const extruded = this.polyOpts.extruded;
    const elevations = extruded
      ? this.resolveFeatureElevations(layer)
      : new Float32Array(featureCount);
    const featureColors = this.polyOpts.fillColorProperty
      ? this.expandCategoricalColors(
          f,
          this.polyOpts.fillColorProperty,
          this.polyOpts.colorPalette,
        )
      : null;

    // Stroke buffers — accumulated alongside the fill so we only walk the
    // ring positions once per tile.
    const wantStroke = this.polyOpts.stroked;
    const strokeSegments: Array<{
      a: [number, number];
      b: [number, number];
      ts: number;
      te: number;
    }> = [];

    // Per-feature pass: triangulate + emit fill vertices + (optionally) stroke
    // edges and side walls.
    const fillPositions: number[] = []; // tightly packed Float32 [x, y, z]
    const fillTimes: number[] = []; // tightly packed Float32 [start, end]
    const fillColors: number[] | null = featureColors ? [] : null; // tightly packed Uint8 RGBA
    const fillIndicesArr: number[] = [];
    let nextVertex = 0;

    for (let fi = 0; fi < featureCount; fi++) {
      const begin = f.startIndices[fi];
      const end = f.startIndices[fi + 1];
      const ringVertexCount = end - begin;
      if (ringVertexCount < 3) continue;

      const flat = new Float64Array(ringVertexCount * 2);
      const projected: Array<[number, number]> = new Array(ringVertexCount);
      for (let v = 0; v < ringVertexCount; v++) {
        const lon = f.positions[(begin + v) * dims];
        const lat = f.positions[(begin + v) * dims + 1];
        const [mx, my] = lngLatToMercator(lon, lat);
        flat[v * 2] = mx;
        flat[v * 2 + 1] = my;
        projected[v] = [mx, my];
      }
      const tris = earcut(flat as unknown as number[], undefined, 2);
      if (tris.length === 0) continue;

      const ts = f.startTimes[fi];
      const te = f.endTimes[fi];
      const elevation = elevations[fi] ?? 0;

      // ---- Fill: top of the prism (or the only face when not extruded) ----
      const topVertexBase = nextVertex;
      for (let v = 0; v < ringVertexCount; v++) {
        fillPositions.push(projected[v][0], projected[v][1], elevation);
        fillTimes.push(ts, te);
        if (fillColors && featureColors) {
          const base = fi * 4;
          fillColors.push(
            featureColors[base],
            featureColors[base + 1],
            featureColors[base + 2],
            featureColors[base + 3],
          );
        }
        nextVertex++;
      }
      for (let t = 0; t < tris.length; t++) {
        fillIndicesArr.push(topVertexBase + tris[t]);
      }

      // ---- Side walls when extruded ----
      if (extruded && elevation > 0) {
        // Emit one quad per ring edge (top vert i, top vert i+1, bottom
        // vert i, bottom vert i+1). Bottom verts share xy with top verts but
        // sit at z=0.
        const bottomBase = nextVertex;
        for (let v = 0; v < ringVertexCount; v++) {
          fillPositions.push(projected[v][0], projected[v][1], 0);
          fillTimes.push(ts, te);
          if (fillColors && featureColors) {
            const base = fi * 4;
            // Side walls render slightly darker by reducing brightness 25%.
            fillColors.push(
              Math.floor(featureColors[base] * 0.75),
              Math.floor(featureColors[base + 1] * 0.75),
              Math.floor(featureColors[base + 2] * 0.75),
              featureColors[base + 3],
            );
          }
          nextVertex++;
        }
        for (let v = 0; v < ringVertexCount; v++) {
          const next = (v + 1) % ringVertexCount;
          const tA = topVertexBase + v;
          const tB = topVertexBase + next;
          const bA = bottomBase + v;
          const bB = bottomBase + next;
          fillIndicesArr.push(tA, bA, tB, tB, bA, bB);
        }
      }

      // ---- Stroke: ring edges ----
      if (wantStroke) {
        for (let v = 0; v < ringVertexCount; v++) {
          const a = projected[v];
          const b = projected[(v + 1) % ringVertexCount];
          strokeSegments.push({ a, b, ts, te });
        }
      }
    }

    if (fillPositions.length === 0) return null;
    const totalVertices = fillPositions.length / 3;
    const use32 = totalVertices > 65535;
    if (use32 && !this.supports32BitIndices) {
      console.warn(
        `[${this.id}] tile has ${totalVertices} polygon vertices, but WebGL1 ` +
          `runtime lacks OES_element_index_uint; dropping tile.`,
      );
      return null;
    }

    const positionsArr = new Float32Array(fillPositions);
    const timesArr = new Float32Array(fillTimes);
    const indicesArr = use32
      ? new Uint32Array(fillIndicesArr)
      : new Uint16Array(fillIndicesArr);

    const positionBuffer = this.uploadArrayBuffer(gl, positionsArr);
    const timeBuffer = this.uploadArrayBuffer(gl, timesArr);
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indicesArr, gl.STATIC_DRAW);

    const extras: WebGLBuffer[] = [];
    let colorBuffer: WebGLBuffer | undefined;
    if (fillColors) {
      colorBuffer = this.uploadArrayBuffer(gl, new Uint8Array(fillColors));
      extras.push(colorBuffer);
    }

    // Stroke pass buffers (when stroked) — same screen-space quad layout as
    // STTLineLayer.
    let stroke: PolygonGpuCache['stroke'] = undefined;
    if (wantStroke && strokeSegments.length > 0) {
      const segCount = strokeSegments.length;
      const sVertCount = segCount * 4;
      const sUse32 = sVertCount > 65535;
      if (sUse32 && !this.supports32BitIndices) {
        // Fall back to no stroke rather than dropping the whole tile.
        stroke = undefined;
      } else {
        const sPos = new Float32Array(sVertCount * 3);
        const sNbr = new Float32Array(sVertCount * 3);
        const sSide = new Float32Array(sVertCount);
        const sTime = new Float32Array(sVertCount * 2);
        const sIdx = sUse32
          ? new Uint32Array(segCount * 6)
          : new Uint16Array(segCount * 6);
        let vW = 0;
        let iW = 0;
        for (let s = 0; s < segCount; s++) {
          const seg = strokeSegments[s];
          const [ax, ay] = seg.a;
          const [bx, by] = seg.b;
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
            sPos[vW * 3] = corners[c].p[0];
            sPos[vW * 3 + 1] = corners[c].p[1];
            sPos[vW * 3 + 2] = 0;
            sNbr[vW * 3] = corners[c].n[0];
            sNbr[vW * 3 + 1] = corners[c].n[1];
            sNbr[vW * 3 + 2] = 0;
            sSide[vW] = corners[c].s;
            sTime[vW * 2] = seg.ts;
            sTime[vW * 2 + 1] = seg.te;
            vW++;
          }
          const base = vW - 4;
          sIdx[iW++] = base + 0;
          sIdx[iW++] = base + 2;
          sIdx[iW++] = base + 1;
          sIdx[iW++] = base + 1;
          sIdx[iW++] = base + 2;
          sIdx[iW++] = base + 3;
        }
        const sPosBuf = this.uploadArrayBuffer(gl, sPos);
        const sNbrBuf = this.uploadArrayBuffer(gl, sNbr);
        const sSideBuf = this.uploadArrayBuffer(gl, sSide);
        const sTimeBuf = this.uploadArrayBuffer(gl, sTime);
        const sIdxBuf = gl.createBuffer()!;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIdxBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sIdx, gl.STATIC_DRAW);
        stroke = {
          positionBuffer: sPosBuf,
          neighborBuffer: sNbrBuf,
          sideBuffer: sSideBuf,
          timeBuffer: sTimeBuf,
          indexBuffer: sIdxBuf,
          indexCount: sIdx.length,
          use32BitIndices: sUse32,
        };
        extras.push(sPosBuf, sNbrBuf, sSideBuf, sTimeBuf, sIdxBuf);
      }
    }

    return {
      positionBuffer,
      timeBuffer,
      indexBuffer,
      vertexCount: totalVertices,
      indexCount: indicesArr.length,
      timeOffset: f.timeOffset,
      use32BitIndices: use32,
      extraBuffers: extras.length > 0 ? extras : undefined,
      colorBuffer,
      stroke,
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
    const c = cache as PolygonGpuCache;
    const { fadeIn, fadeOut } = this.resolveFadeDurations();

    if (this.polyOpts.filled) {
      gl.useProgram(h.program);
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
      gl.uniform1f(h.uAltitudeScale, this.polyOpts.altitudeScale);
      gl.uniform4fv(h.uColor, this.polyOpts.color);
      gl.uniform1f(h.uWindowStart, ctx.windowStart);
      gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
      gl.uniform1f(h.uFadeIn, fadeIn);
      gl.uniform1f(h.uFadeOut, fadeOut);
      gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);

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
        // VAOs capture the element-array binding too.
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, c.indexBuffer!);
      });

      const indexType = c.use32BitIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl.TRIANGLES, c.indexCount, indexType, 0);
    }

    if (this.polyOpts.stroked && c.stroke && this.strokeHandles) {
      const sh = this.strokeHandles;
      const s = c.stroke;
      gl.useProgram(sh.program);
      gl.uniformMatrix4fv(sh.uMatrix, false, ctx.matrix);
      gl.uniform2f(sh.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(sh.uWidth, this.polyOpts.lineWidth);
      gl.uniform4fv(sh.uColor, this.polyOpts.lineColor);
      gl.uniform1f(sh.uWindowStart, ctx.windowStart);
      gl.uniform1f(sh.uWindowEnd, ctx.windowEnd);
      gl.uniform1f(sh.uFadeIn, fadeIn);
      gl.uniform1f(sh.uFadeOut, fadeOut);

      gl.bindBuffer(gl.ARRAY_BUFFER, s.positionBuffer);
      gl.enableVertexAttribArray(sh.aPos);
      gl.vertexAttribPointer(sh.aPos, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, s.neighborBuffer);
      gl.enableVertexAttribArray(sh.aNeighbor);
      gl.vertexAttribPointer(sh.aNeighbor, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, s.sideBuffer);
      gl.enableVertexAttribArray(sh.aSide);
      gl.vertexAttribPointer(sh.aSide, 1, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, s.timeBuffer);
      gl.enableVertexAttribArray(sh.aTime);
      gl.vertexAttribPointer(sh.aTime, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.indexBuffer);
      const t = s.use32BitIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl.TRIANGLES, s.indexCount, t, 0);

      gl.disableVertexAttribArray(sh.aPos);
      gl.disableVertexAttribArray(sh.aNeighbor);
      gl.disableVertexAttribArray(sh.aSide);
      gl.disableVertexAttribArray(sh.aTime);
    }
  }
}
