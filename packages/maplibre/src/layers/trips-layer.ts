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
 *
 * Projection is variant-aware (campaign D3): legacy hosts (maplibre ≤v4,
 * mapbox v3) keep the positional `uMatrix` MVP shader; v5+ hosts get the
 * injected projection prelude and project endpoints via `projectTile(vec2)`
 * (0..1 mercator in, clip out — z overwritten for horizon clipping, which is
 * correct for these 2d screen-extruded quads). On globe frames segment
 * geometry is subdivided to the host's granularity WITH vertex-time
 * interpolation, so long chords neither pierce the sphere nor distort the
 * trail's time mapping. STT tiles are z/x/y/t-addressed with no wrap
 * dimension and the host hands custom layers a single per-frame projection,
 * so there are no wrap ≠ 0 world-copy draws to skip.
 */

import type { Tile, Layer as STTLayer } from '@poopdeck.gl/core';
import {
  GeometryType,
  DEFAULT_TRIPS_PALETTE as CORE_TRIPS_PALETTE,
} from '@poopdeck.gl/core';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from '../base-layer.js';
import { createHostFrame, type HostFrame } from '../lib/host-adapter.js';
import { subdivideLineMercator } from '../lib/globe.js';
import { lngLatToMercator } from '../lib/projection.js';
import { TIME_TRAIL_GLSL } from '../shaders/time-window.glsl.js';

// Shared with @poopdeck.gl/layers AnimatedTripsLayer (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_TRIPS_PALETTE: ReadonlyArray<RGBA8> = CORE_TRIPS_PALETTE;

// Hand-built test DrawContexts may omit `frame`; those behave as a legacy
// positional-matrix host. Never mutated — real render/pick paths always pass
// the base scratch frame.
const FALLBACK_LEGACY_FRAME: HostFrame = createHostFrame();

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

/**
 * Variant-aware vertex source (base program-cache contract): with an injected
 * prelude (v5+ host) the endpoints project via `projectTile(vec2)`; without
 * one (the 'legacy' variant) the source is the historical `uMatrix` shader,
 * unchanged. The variant block sits exactly where `uniform mat4 uMatrix;`
 * otherwise would — GLSL only needs declarations before `main`. The
 * screen-space quad extrusion happens post-projection in NDC, so it is
 * identical for both variants.
 */
function buildTripsVertexSource(shader: {
  prelude: string;
  define: string;
}): string {
  const usesPrelude = shader.prelude.length > 0;
  const projectionDecls = usesPrelude
    ? `${shader.prelude}\n${shader.define}`
    : '  uniform mat4 uMatrix;';
  const project = (pos: string) =>
    usesPrelude ? `projectTile(${pos})` : `uMatrix * vec4(${pos}, 0.0, 1.0)`;
  return `
  precision highp float;
  attribute vec2 aCorner;        // (side, along) ∈ {-1,1} × {0,1}, per-vertex
  attribute vec2 aPosA;          // segment start, per-instance
  attribute vec2 aPosB;          // segment end, per-instance
  attribute vec2 aVertexTimeAB;  // [timeA, timeB], per-instance, tile-relative
  attribute vec4 aColor;         // per-feature RGBA (when uUseFeatureColor=1)
  attribute float aWidth;        // per-feature width (when uUseFeatureWidth=1)
${projectionDecls}
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
    vec4 here = ${project('posM')};
    vec4 there = ${project('neighborM')};
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
}

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
  /**
   * Shader variant the cached VAO's attribute locations belong to. A variant
   * flip (mercator ↔ globe) relinks the program and may re-assign attribute
   * locations, so a VAO recorded against the old ones must be rebuilt.
   */
  vaoVariant?: string;
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
  /**
   * Globe frames need subdivided tile geometry, but the base render loop
   * resolves caches before drawTile ever sees the frame — beginFrame stashes
   * the flag so ensure/buildTileGpuCache key and build for the CURRENT
   * projection. Flat and globe geometry cache under SEPARATE keys (the line
   * layer's scheme), so the v5 globe transition crossing (projectionTransition
   * hits 0 around z≈11) swaps buffers per tile instead of re-tessellating
   * every resident tile in one frame; the cost is transiently holding both
   * variants. Also read by the pick path (a pick follows a render).
   */
  private frameIsGlobe = false;

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

  protected beginFrame(
    matrixOrArgs: unknown,
    options?: unknown,
  ): HostFrame | null {
    const frame = super.beginFrame(matrixOrArgs, options);
    if (frame) this.frameIsGlobe = frame.isGlobe;
    return frame;
  }

  /**
   * Globe geometry (subdivided, time-interpolated) lives under its own key so
   * the flat mercator entry stays unpolluted and a globe ⇄ mercator flip
   * reuses either side without rebuilds. The `z/x/y/t::` prefix must match
   * the base tileKey format — the base unload sweep frees entries by that
   * prefix.
   */
  protected ensureTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): TileGpuCache | null {
    if (!this.frameIsGlobe) return super.ensureTileGpuCache(gl, tile, layer);
    const { z, x, y, t } = tile.id;
    const key = `${z}/${x}/${y}/${t}::${layer.name}::${layer.features.geometryType}::globe:${this.tileSubdivisionGranularity(z)}`;
    const existing = this.tileGpuCache.get(key);
    if (existing !== undefined) return existing;
    const cache = this.buildTileGpuCache(gl, tile, layer);
    this.tileGpuCache.set(key, cache);
    return cache;
  }

  // Programs are built lazily per host shader variant through the base
  // program cache ({@link getHandles}); nothing to allocate eagerly. The
  // base invalidates that cache on context loss and dispose.
  protected onContextReady(): void {}

  protected onContextLost(): void {}

  /** Program handles for the frame's shader variant (cached by the base). */
  private getHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
  ): TripsProgramHandles {
    return this.getOrCreateProgram(gl, 'trips', frame, (pgl, shader) => {
      const usesPrelude = shader.prelude.length > 0;
      const program = this.linkProgram(
        pgl,
        buildTripsVertexSource(shader),
        FS_SOURCE,
      );
      return {
        program,
        aCorner: pgl.getAttribLocation(program, 'aCorner'),
        aPosA: pgl.getAttribLocation(program, 'aPosA'),
        aPosB: pgl.getAttribLocation(program, 'aPosB'),
        aVertexTimeAB: pgl.getAttribLocation(program, 'aVertexTimeAB'),
        aColor: pgl.getAttribLocation(program, 'aColor'),
        aWidth: pgl.getAttribLocation(program, 'aWidth'),
        // uMatrix is undeclared on prelude variants — never look it up there
        // so the legacy MVP can't be pushed to a projectTile program.
        uMatrix: usesPrelude
          ? null
          : pgl.getUniformLocation(program, 'uMatrix'),
        uViewport: pgl.getUniformLocation(program, 'uViewport'),
        uWidth: pgl.getUniformLocation(program, 'uWidth'),
        uWidthScale: pgl.getUniformLocation(program, 'uWidthScale'),
        uUseFeatureWidth: pgl.getUniformLocation(program, 'uUseFeatureWidth'),
        uUseFeatureColor: pgl.getUniformLocation(program, 'uUseFeatureColor'),
        uColor: pgl.getUniformLocation(program, 'uColor'),
        uCurrentTime: pgl.getUniformLocation(program, 'uCurrentTime'),
        uTrailLength: pgl.getUniformLocation(program, 'uTrailLength'),
        uFadeTrail: pgl.getUniformLocation(program, 'uFadeTrail'),
      };
    });
  }

  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
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

    // Globe frames need chord subdivision or long segments get
    // horizon-clipped (base helper: host per-tile granularity × 2^z per the
    // lib/globe.ts convention); 0 disables subdivision off-globe.
    const granularity = this.frameIsGlobe
      ? this.tileSubdivisionGranularity(tile.id.z)
      : 0;

    // Pass 1: per-feature mercator polyline + tile-relative vertex times,
    // subdivided on globe with the times interpolated in lock-step so the
    // trail's linear time mapping survives the inserted vertices.
    const polylines: {
      fi: number;
      positions: Float64Array;
      times: Float32Array;
    }[] = [];
    let segmentCount = 0;
    for (let fi = 0; fi < featureCount; fi++) {
      const begin = startIndices[fi];
      const end = startIndices[fi + 1];
      const numVerts = end - begin;
      if (numVerts < 2) continue;

      const ts = f.startTimes[fi];
      const te = f.endTimes[fi];
      const duration = te - ts;
      let merc: Float64Array = new Float64Array(numVerts * 2);
      let times: Float32Array = new Float32Array(numVerts);
      for (let v = 0; v < numVerts; v++) {
        const [mx, my] = lngLatToMercator(
          f.positions[(begin + v) * dims],
          f.positions[(begin + v) * dims + 1],
        );
        merc[v * 2] = mx;
        merc[v * 2 + 1] = my;
        times[v] = hasVertexTimestamps
          ? f.vertexTimestamps![begin + v]
          : ts + (v / (numVerts - 1)) * duration;
      }
      if (granularity > 0) {
        const sub = subdivideLineMercator(merc, granularity, {
          arrays: [times],
          components: [1],
        });
        merc = sub.positions;
        times = sub.attrs!.arrays[0] as Float32Array;
      }
      polylines.push({ fi, positions: merc, times });
      segmentCount += merc.length / 2 - 1;
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

    // Pass 2: one instance per (possibly subdivided) segment. Colors/widths
    // are feature-constant, so subdivision just repeats them per instance.
    let s = 0;
    for (const { fi, positions, times } of polylines) {
      const segs = positions.length / 2 - 1;
      const fr = featureColors ? featureColors[fi * 4] : 0;
      const fg = featureColors ? featureColors[fi * 4 + 1] : 0;
      const fb = featureColors ? featureColors[fi * 4 + 2] : 0;
      const fa = featureColors ? featureColors[fi * 4 + 3] : 255;
      const fw = featureWidths ? featureWidths[fi] : 0;

      for (let v = 0; v < segs; v++) {
        posA[s * 2] = positions[v * 2];
        posA[s * 2 + 1] = positions[v * 2 + 1];
        posB[s * 2] = positions[(v + 1) * 2];
        posB[s * 2 + 1] = positions[(v + 1) * 2 + 1];
        vTimeAB[s * 2] = times[v];
        vTimeAB[s * 2 + 1] = times[v + 1];
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
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const c = cache as TripsGpuCache;
    const h = this.getHandles(gl, frame);

    gl.useProgram(h.program);
    this.setPreludeProjectionUniforms(gl, h.program, frame);
    if (h.uMatrix) gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
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

    // The VAO records attribute locations belonging to one variant's program;
    // a flip relinked, so a stale recording must be rebuilt.
    if (c.vao && c.vaoVariant !== frame.shader.variantName) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    c.vaoVariant = frame.shader.variantName;

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
