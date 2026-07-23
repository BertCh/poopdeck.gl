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
 *
 * Projection variants (parity campaign D3/D4): legacy hosts (maplibre ≤v4,
 * mapbox v3) project endpoints through the positional `uMatrix`; v5+ hosts
 * get the host's injected prelude prepended and endpoints go through its
 * `projectTile(vec2)` — same 0..1-mercator input our decode produces. On
 * globe frames, segments are subdivided at tile-upload time so chords don't
 * get horizon-clipped, cached under their own key so flat mercator entries
 * survive projection flips. STT tiles carry no `wrap` (Tile.id = z/x/y/t)
 * and this backend never draws world copies, so the globe wrap-skip rule is
 * vacuously satisfied.
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
import { subdivideLineMercator } from '../lib/globe.js';
import { createHostFrame, type HostFrame } from '../lib/host-adapter.js';
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

/**
 * Variant-aware vertex source (D3). An empty `prelude` yields the legacy
 * `uMatrix` shader (maplibre ≤v4 / mapbox — unchanged behavior); a v5+ host's
 * prelude + define are prepended (maplibre's documented injection order) and
 * BOTH segment endpoints project through its `projectTile(vec2)`. projectTile
 * overwrites z for horizon clipping — correct for this 2d screen-space quad;
 * the NDC extrusion math is identical across variants.
 */
export function buildLineVertexSource(shader: {
  prelude: string;
  define: string;
}): string {
  const v5 = shader.prelude.length > 0;
  const header = v5 ? `${shader.prelude}\n${shader.define}` : '';
  const matrixDecl = v5 ? '' : 'uniform mat4 uMatrix;\n  ';
  const projectHere = v5
    ? 'projectTile(posM)'
    : 'uMatrix * vec4(posM, 0.0, 1.0)';
  const projectThere = v5
    ? 'projectTile(neighborM)'
    : 'uMatrix * vec4(neighborM, 0.0, 1.0)';
  return `${header}
  precision highp float;
  attribute vec2 aCorner;      // (side, along) ∈ {-1,1} × {0,1}, per-vertex
  attribute vec2 aPosA;        // segment start, per-instance
  attribute vec2 aPosB;        // segment end, per-instance
  attribute vec2 aTime;        // [startTime, endTime], per-instance
  attribute vec4 aColor;       // per-feature RGBA (when uUseFeatureColor=1)
  attribute float aWidth;      // per-feature width (when uUseFeatureWidth=1)
  ${matrixDecl}uniform vec2 uViewport;
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
    vec4 here = ${projectHere};
    vec4 there = ${projectThere};
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

interface LineProgramHandles {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  aTime: number;
  aColor: number;
  aWidth: number;
  /** null on prelude-built variants (they project via `u_projection_*`). */
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
  /**
   * Shader variant the cached VAO's attribute locations were recorded
   * against. A variant flip may relocate attributes, so a mismatched VAO is
   * dropped and re-recorded (buffers stay valid).
   */
  vaoVariant?: string;
}

/**
 * Hand-built test DrawContexts may omit `frame`; treat them as a legacy
 * uMatrix host. Read-only — never handed to normalizeRenderArgs.
 */
const FALLBACK_LEGACY_FRAME: HostFrame = createHostFrame();

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
  /**
   * Globe frames need subdivided tile geometry, but the base render loop
   * resolves caches before drawTile ever sees the frame — beginFrame stashes
   * the flag so ensure/buildTileGpuCache key and build for the CURRENT
   * projection. Also read by the pick path (a pick follows a render).
   */
  private frameIsGlobe = false;

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

  protected beginFrame(
    matrixOrArgs: unknown,
    options?: unknown,
  ): HostFrame | null {
    const frame = super.beginFrame(matrixOrArgs, options);
    if (frame) this.frameIsGlobe = frame.isGlobe;
    return frame;
  }

  protected onContextReady(): void {
    // Programs are linked lazily, one per host shader variant, through the
    // base getOrCreateProgram cache — nothing to allocate eagerly.
  }

  protected onContextLost(): void {
    // Per-variant programs live in the base program cache, which the base
    // layer invalidates on context loss and removal.
  }

  /** Fetch (or link) this frame's variant of the line program. */
  private programFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
  ): LineProgramHandles {
    return this.getOrCreateProgram(gl, 'line', frame, (glc, shader) => {
      const program = this.linkProgram(
        glc,
        buildLineVertexSource(shader),
        FS_SOURCE,
      );
      return {
        program,
        aCorner: glc.getAttribLocation(program, 'aCorner'),
        aPosA: glc.getAttribLocation(program, 'aPosA'),
        aPosB: glc.getAttribLocation(program, 'aPosB'),
        aTime: glc.getAttribLocation(program, 'aTime'),
        aColor: glc.getAttribLocation(program, 'aColor'),
        aWidth: glc.getAttribLocation(program, 'aWidth'),
        uMatrix: glc.getUniformLocation(program, 'uMatrix'),
        uViewport: glc.getUniformLocation(program, 'uViewport'),
        uWidth: glc.getUniformLocation(program, 'uWidth'),
        uWidthScale: glc.getUniformLocation(program, 'uWidthScale'),
        uUseFeatureWidth: glc.getUniformLocation(program, 'uUseFeatureWidth'),
        uUseFeatureColor: glc.getUniformLocation(program, 'uUseFeatureColor'),
        uColor: glc.getUniformLocation(program, 'uColor'),
        uWindowStart: glc.getUniformLocation(program, 'uWindowStart'),
        uWindowEnd: glc.getUniformLocation(program, 'uWindowEnd'),
        uFadeIn: glc.getUniformLocation(program, 'uFadeIn'),
        uFadeOut: glc.getUniformLocation(program, 'uFadeOut'),
      };
    });
  }

  protected ensureTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): TileGpuCache | null {
    if (!this.frameIsGlobe) return super.ensureTileGpuCache(gl, tile, layer);
    // Subdivided globe geometry lives under its own key so the flat mercator
    // entry stays unpolluted and a globe→mercator flip reuses either side
    // without rebuilds. The `z/x/y/t::` prefix must match the base tileKey
    // format — the base unload sweep frees entries by that prefix.
    const { z, x, y, t } = tile.id;
    const key = `${z}/${x}/${y}/${t}::${layer.name}::${layer.features.geometryType}::globe:${this.tileSubdivisionGranularity(z)}`;
    const existing = this.tileGpuCache.get(key);
    if (existing !== undefined) return existing;
    const cache = this.buildTileGpuCache(gl, tile, layer);
    this.tileGpuCache.set(key, cache);
    return cache;
  }

  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
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
    // 0 ⇒ no subdivision: off-globe both uMatrix and projectTile are affine
    // in mercator, so chords are exact. On globe, chords longer than the
    // host's granularity get horizon-clipped — split at upload time.
    const granularity = this.frameIsGlobe
      ? this.tileSubdivisionGranularity(tile.id.z)
      : 0;

    // Pass 1: project each feature's polyline to mercator (subdividing on
    // globe) so segment counts are known before the per-instance buffers are
    // allocated. Times / colors / widths are per-FEATURE constants — only
    // positions interpolate. Tile-upload time only, never per frame.
    const polylines: Float64Array[] = new Array(featureCount);
    let segmentCount = 0;
    for (let fi = 0; fi < featureCount; fi++) {
      const begin = startIndices[fi];
      const count = startIndices[fi + 1] - begin;
      let merc: Float64Array = new Float64Array(count * 2);
      for (let v = 0; v < count; v++) {
        const [mx, my] = lngLatToMercator(
          f.positions[(begin + v) * dims],
          f.positions[(begin + v) * dims + 1],
        );
        merc[v * 2] = mx;
        merc[v * 2 + 1] = my;
      }
      if (granularity > 0) {
        merc = subdivideLineMercator(merc, granularity).positions;
      }
      polylines[fi] = merc;
      if (merc.length >= 4) segmentCount += merc.length / 2 - 1;
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
      const line = polylines[fi];
      const segs = line.length >= 4 ? line.length / 2 - 1 : 0;
      const ts = f.startTimes[fi];
      const te = f.endTimes[fi];
      const fr = featureColors ? featureColors[fi * 4] : 0;
      const fg = featureColors ? featureColors[fi * 4 + 1] : 0;
      const fb = featureColors ? featureColors[fi * 4 + 2] : 0;
      const fa = featureColors ? featureColors[fi * 4 + 3] : 255;
      const fw = featureWidths ? featureWidths[fi] : 0;
      for (let v = 0; v < segs; v++) {
        posA[s * 2] = line[v * 2];
        posA[s * 2 + 1] = line[v * 2 + 1];
        posB[s * 2] = line[v * 2 + 2];
        posB[s * 2 + 1] = line[v * 2 + 3];
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
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const h = this.programFor(gl, frame);
    const c = cache as LineGpuCache;

    gl.useProgram(h.program);
    if (frame.shader.prelude) {
      // Prelude-built variant: projection rides the injected u_projection_*
      // uniforms (no uMatrix in this program).
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
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

    // A VAO records attribute LOCATIONS of the program it was built against —
    // a variant flip may relocate them, so a mismatched VAO is re-recorded
    // (the underlying buffers stay valid).
    if (c.vao && c.vaoVariant !== frame.shader.variantName) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
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
    c.vaoVariant = frame.shader.variantName;

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
