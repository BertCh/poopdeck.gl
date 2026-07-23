/**
 * Polygon geometry adapter — renders POLYGON-type tiles as filled triangles,
 * with optional outline strokes and extruded side walls.
 *
 * Triangulation runs on the CPU at tile-load time via the shared
 * `tessellateFeature` kernel (@poopdeck.gl/core/geometry) — the same dispatch
 * deck and three use — then we upload the vertices + indices once and toggle
 * alpha per-feature in the vertex shader using the time-window uniforms.
 *
 * The kernel HONORS pre-baked `triangles`/`triangleOffsets` when the tile
 * carries them (built with `--pre-tessellate`), which is the holes-correct,
 * multi-ring-correct path. Otherwise it falls back to earcutting the feature's
 * SINGLE ring (`startIndices[f]…startIndices[f+1]`); multi-ring polygons that
 * arrive without pre-baked triangles are still treated as one ring, since STT
 * does not yet emit a `holeIndices` field for the runtime-earcut path.
 *
 * Host projection (campaign D3/D4): every program is built per shader variant
 * through the base `getOrCreateProgram` cache. Legacy hosts (maplibre ≤v4,
 * mapbox) keep the historical `uMatrix` shaders byte-for-byte; v5+ hosts get
 * the map-injected prelude prepended and project through `projectTile` (flat
 * fills + strokes, 2d — the host owns z for horizon clipping on globe) /
 * `projectTileFor3D` (extruded prisms, elevation in meters). On prelude hosts
 * the baked geometry is additionally refined to the host's subdivision
 * granularity (`lib/globe.ts`) so long chords don't horizon-clip on globe.
 * STT tiles are drawn once in the single 0..1 mercator world (there is no
 * per-tile `wrap`), so the globe "skip wrap ≠ 0 copies" rule holds
 * structurally.
 *
 * Stroked / extruded parity:
 *   - `stroked: true` adds an outline pass over each ring edge, drawn with the
 *     same screen-space quad expansion as STTLineLayer.
 *   - `extruded: true` raises the polygon top to a per-feature elevation (in
 *     mercator-z units, scaled by `altitudeScale`) and draws side walls down
 *     to z=0. Pair with `map.setPitch(...)` to actually see the relief.
 */

import type { Tile, Layer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_POLYGON_PALETTE } from '@poopdeck.gl/core';
import { tessellateFeature } from '@poopdeck.gl/core/geometry';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from '../base-layer.js';
import { lngLatToMercator } from '../lib/projection.js';
import {
  subdivideLineMercator,
  subdivideTrianglesMercator,
} from '../lib/globe.js';
import { createHostFrame, type HostFrame } from '../lib/host-adapter.js';
import { TIME_WINDOW_GLSL } from '../shaders/time-window.glsl.js';

// Shared with @poopdeck.gl/layers AnimatedPolygonLayer (single source of truth
// in @poopdeck.gl/core).
const DEFAULT_POLY_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_POLYGON_PALETTE;

/**
 * Meters per mercator-z unit at 45° latitude (2π·6371008.8 m mean-earth
 * circumference × cos 45°). The legacy (≤v4 / mapbox) path consumes
 * `elevation * altitudeScale` directly as mercator-z (default 1e-7 per metre —
 * the historical, ~4×-too-tall approximation); the v5+ prelude's
 * `projectTileFor3D` wants METERS above the sphere instead, so the draw path
 * converts the legacy mercator-z back through this mid-latitude factor to keep
 * the two hosts visually matched. D10 (elevation reconciliation) replaces both
 * sides with latitude-correct `mercatorZfromAltitude` math — do not retune
 * this constant separately from the legacy 1e-7 default.
 */
export const MERCATOR_Z_TO_METERS_MIDLAT = 40030228.88407185 * Math.SQRT1_2;

export interface STTPolygonLayerOptions extends STTBaseLayerOptions {
  /** Fill color as [r, g, b, a] in the 0–1 range. Ignored when `fillColorProperty` is set. */
  color?: [number, number, number, number];
  /** Drive per-feature fill colour from a categorical property name. */
  fillColorProperty?: string;
  /** Palette used with `fillColorProperty` (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA color map (deck/three `colorMapping`
   * parity). When set, `fillColorProperty`'s category NAME is looked up here so
   * a category renders the same fill in every tile regardless of per-tile
   * dictionary order. Unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional `colorPalette`.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Fill color for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
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

/**
 * Variant-aware fill vertex source. Legacy frames (empty prelude) keep the
 * historical `uMatrix` shader VERBATIM; prelude frames (maplibre v5+) project
 * through the injected functions instead — `projectTile` for flat fills (2d:
 * the prelude owns z, giving horizon clipping on globe) and `projectTileFor3D`
 * for extruded prisms (elevation in meters — see
 * {@link MERCATOR_Z_TO_METERS_MIDLAT}). The branch is uniform-wide, matching
 * how the cache bakes geometry (`setExtruded` rebuilds the caches).
 * Exported for string-level variant tests.
 */
export const buildFillVertexSource = (shader: {
  prelude: string;
  define: string;
}): string => {
  if (shader.prelude === '') return VS_SOURCE;
  return `
${shader.prelude}
${shader.define}
  precision highp float;
  attribute vec3 aMercator;    // [mercX, mercY, elevation units]
  attribute vec2 aTime;
  attribute vec4 aColor;
  uniform float uAltitudeScale; // elevation units → METERS on this path
  uniform float uExtruded;
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
    gl_Position = (uExtruded > 0.5)
      ? projectTileFor3D(aMercator.xy, aMercator.z * uAltitudeScale)
      : projectTile(aMercator.xy);
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;
};

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha);
  }
`;

// Outline shader: instanced screen-space line expansion (same scheme as the
// STTLineLayer). One instance per ring edge; the static unit-quad VBO from
// the base layer provides the 4 corners.
const STROKE_VS_SOURCE = `
  precision highp float;
  attribute vec2 aCorner;       // (side, along) per-vertex
  attribute vec2 aPosA;         // edge start, per-instance
  attribute vec2 aPosB;         // edge end, per-instance
  attribute vec2 aTime;         // [startTime, endTime], per-instance
  uniform mat4 uMatrix;
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
${TIME_WINDOW_GLSL}
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
    vec2 offsetPx = perp * aCorner.x * uWidth * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
  }
`;

/**
 * Variant-aware stroke vertex source. Outlines hug the fill: 2d content →
 * `projectTile` (the prelude owns z for horizon clipping); the screen-space
 * quad expansion happens post-projection and is identical to the legacy path.
 * Exported for string-level variant tests.
 */
export const buildStrokeVertexSource = (shader: {
  prelude: string;
  define: string;
}): string => {
  if (shader.prelude === '') return STROKE_VS_SOURCE;
  return `
${shader.prelude}
${shader.define}
  precision highp float;
  attribute vec2 aCorner;       // (side, along) per-vertex
  attribute vec2 aPosA;         // edge start, per-instance
  attribute vec2 aPosB;         // edge end, per-instance
  attribute vec2 aTime;         // [startTime, endTime], per-instance
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
${TIME_WINDOW_GLSL}
  void main() {
    vec2 posM = mix(aPosA, aPosB, aCorner.y);
    vec2 neighborM = mix(aPosB, aPosA, aCorner.y);
    vec4 here = projectTile(posM);
    vec4 there = projectTile(neighborM);
    vec2 hereNdc = here.xy / here.w;
    vec2 thereNdc = there.xy / there.w;
    vec2 dirPx = (thereNdc - hereNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    float sideSign = (aCorner.y > 0.5) ? -1.0 : 1.0;
    vec2 perp = vec2(-dirN.y, dirN.x) * sideSign;
    vec2 offsetPx = perp * aCorner.x * uWidth * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
  }
`;
};

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
  /** Legacy variant only — null on prelude programs (their matrix comes from u_projection_*). */
  uMatrix: WebGLUniformLocation | null;
  uAltitudeScale: WebGLUniformLocation | null;
  /** Prelude variant only — null on the legacy program. */
  uExtruded: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
}

interface StrokeProgramHandles {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  aTime: number;
  /** Legacy variant only — null on prelude programs. */
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
  /**
   * Full-mercator-square subdivision granularity baked into this cache
   * (0 = unrefined — legacy hosts). Prelude hosts refine fill triangles, wall
   * bands and stroke edges to it at build time (D4).
   */
  subdivisionGranularity: number;
  /**
   * Shader variant the VAO recordings were captured under. VAOs record
   * attribute locations of the variant's linked program, so a variant flip
   * (v5 mercator ⇄ globe) invalidates them.
   */
  vaoVariant?: string;
  /** Per-vertex RGBA colours (Uint8 normalized) when `fillColorProperty` is in use. */
  colorBuffer?: WebGLBuffer;
  /**
   * Optional stroke pass: one instance per ring edge. Carries the two endpoints
   * and the feature's time range. The quad geometry comes from the base layer's
   * shared unit quad.
   */
  stroke?: {
    posABuffer: WebGLBuffer;
    posBBuffer: WebGLBuffer;
    timeBuffer: WebGLBuffer;
    instanceCount: number;
  };
}

/**
 * Refine a projected ring's edges (including the closing edge) so no piece
 * spans more than `1/granularity` mercator units per axis. Returns a flat
 * `[x, y, ...]` ring WITHOUT the duplicate closing vertex; consumers wrap
 * with modulo exactly like the unrefined ring.
 */
function refineRing(
  projected: ReadonlyArray<readonly [number, number]>,
  granularity: number,
): Float64Array {
  const n = projected.length;
  const closed = new Float64Array((n + 1) * 2);
  for (let v = 0; v < n; v++) {
    closed[v * 2] = projected[v][0];
    closed[v * 2 + 1] = projected[v][1];
  }
  closed[n * 2] = projected[0][0];
  closed[n * 2 + 1] = projected[0][1];
  const refined = subdivideLineMercator(closed, granularity).positions;
  return refined.subarray(0, refined.length - 2);
}

export class STTPolygonLayer extends STTBaseLayer {
  private polyOpts: {
    color: [number, number, number, number];
    fillColorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    filled: boolean;
    stroked: boolean;
    lineColor: [number, number, number, number];
    lineWidth: number;
    extruded: boolean;
    elevation: number | string;
    altitudeScale: number;
  };

  /**
   * True once a prelude-projected (maplibre v5+) frame has been seen —
   * geometry then bakes with globe subdivision. Constant per host after the
   * first frame; observed in {@link beginFrame} BEFORE any cache build.
   */
  private preludeProjected = false;

  /** Legacy stand-in for hand-built test DrawContexts that omit `frame`. */
  private readonly fallbackFrame = createHostFrame();

  constructor(opts: STTPolygonLayerOptions) {
    super(opts);
    this.polyOpts = {
      color: opts.color ?? [0.99, 0.55, 0.2, 0.7],
      fillColorProperty: opts.fillColorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_POLY_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
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

  /**
   * Toggle the polygon stroke at runtime. The stroke instance buffers are
   * baked into each tile's GPU cache at build time, so the caches must be
   * rebuilt (rebuildTileCaches also triggers the repaint).
   */
  setStroked(stroked: boolean): void {
    if (this.polyOpts.stroked === stroked) return;
    this.polyOpts.stroked = stroked;
    this.rebuildTileCaches();
  }

  /**
   * Toggle extrusion at runtime. Side walls + raised tops are baked into each
   * tile's vertex/index buffers at build time, so the caches must be rebuilt
   * (rebuildTileCaches also triggers the repaint).
   */
  setExtruded(extruded: boolean): void {
    if (this.polyOpts.extruded === extruded) return;
    this.polyOpts.extruded = extruded;
    this.rebuildTileCaches();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Polygon;
  }

  /**
   * Track the host's projection family BEFORE any tile cache is (re)built
   * this frame: prelude hosts need geometry refined for globe at upload time,
   * legacy hosts must keep the exact unrefined buffers. A flip (first v5
   * frame, or a defensive shaderData-less host) invalidates the baked caches;
   * they rebuild with the right granularity later in this same render.
   * Granularity changes WITHIN the prelude family (runtime mercator ⇄ globe
   * projection switch) ride the granularity-keyed {@link ensureTileGpuCache}
   * instead — no wholesale rebuild.
   */
  protected beginFrame(
    matrixOrArgs: unknown,
    options?: unknown,
  ): HostFrame | null {
    const frame = super.beginFrame(matrixOrArgs, options);
    if (frame) {
      const preludeProjected = frame.shader.prelude !== '';
      if (preludeProjected !== this.preludeProjected) {
        this.preludeProjected = preludeProjected;
        this.rebuildTileCaches();
      }
    }
    return frame;
  }

  /**
   * Prelude hosts bake the host's subdivision granularity into the cached
   * geometry, and a runtime projection switch (v5 `setProjection` mercator ⇄
   * globe) changes that granularity WITHOUT flipping `preludeProjected` — so
   * the cache key carries the baked granularity (the line layer's scheme): a
   * switch lazily rebuilds each tile under its new key instead of keeping
   * unsubdivided chords that horizon-clip on globe, and switching back
   * reuses whichever variant already exists. The `z/x/y/t::` prefix matches
   * the base tileKey format so the base unload sweep frees every variant.
   */
  protected ensureTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): TileGpuCache | null {
    if (!this.preludeProjected)
      return super.ensureTileGpuCache(gl, tile, layer);
    const { z, x, y, t } = tile.id;
    const key = `${z}/${x}/${y}/${t}::${layer.name}::${layer.features.geometryType}::gran:${this.tileSubdivisionGranularity(z)}`;
    const existing = this.tileGpuCache.get(key);
    if (existing !== undefined) return existing;
    const cache = this.buildTileGpuCache(gl, tile, layer);
    this.tileGpuCache.set(key, cache);
    return cache;
  }

  protected onContextReady(): void {
    // Programs are linked lazily per shader variant through the base
    // `getOrCreateProgram` cache (a v5 host recompiles per projection
    // variant; after a context restore the cache is empty and relinks on the
    // first draw).
  }

  protected onContextLost(): void {
    // Program handles live in the base variant cache, which the base layer
    // invalidates on context loss and dispose.
  }

  /** Build fill program handles for the frame's shader variant. */
  private readonly fillProgramFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: { prelude: string; define: string },
  ): PolygonProgramHandles => {
    const program = this.linkProgram(
      gl,
      buildFillVertexSource(shader),
      FS_SOURCE,
    );
    return {
      program,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uAltitudeScale: gl.getUniformLocation(program, 'uAltitudeScale'),
      uExtruded: gl.getUniformLocation(program, 'uExtruded'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
    };
  };

  /** Build stroke program handles for the frame's shader variant. */
  private readonly strokeProgramFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: { prelude: string; define: string },
  ): StrokeProgramHandles => {
    const program = this.linkProgram(
      gl,
      buildStrokeVertexSource(shader),
      STROKE_FS_SOURCE,
    );
    return {
      program,
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aPosA: gl.getAttribLocation(program, 'aPosA'),
      aPosB: gl.getAttribLocation(program, 'aPosB'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uWidth: gl.getUniformLocation(program, 'uWidth'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
    };
  };

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
    tile: Tile,
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
          this.polyOpts.colorMapping,
          this.polyOpts.colorMappingDefault,
        )
      : null;

    // Globe correctness (D4): prelude hosts get long edges refined to the
    // host's subdivision granularity so chords don't horizon-clip on globe
    // (base helper: per-tile granularity × 2^z per the lib/globe.ts
    // convention). Legacy hosts bake no subdivision — the unrefined geometry
    // stays byte-identical to the historical path.
    const granularity = this.preludeProjected
      ? this.tileSubdivisionGranularity(tile.id.z)
      : 0;

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

      // Pre-project the ring once — the projected coords feed the fill emit
      // loop and the stroke/side-wall passes. (Triangulation runs on the raw
      // lon/lat positions inside the shared kernel; a valid triangulation of a
      // simple ring is topology-invariant under the mercator map, so the fill
      // is identical.)
      const projected: Array<[number, number]> = new Array(ringVertexCount);
      for (let v = 0; v < ringVertexCount; v++) {
        const lon = f.positions[(begin + v) * dims];
        const lat = f.positions[(begin + v) * dims + 1];
        const [mx, my] = lngLatToMercator(lon, lat);
        projected[v] = [mx, my];
      }

      // Resolve the triangle indices for this feature via the shared kernel:
      // pre-baked `triangles` when the tile carries them, else a single-ring
      // earcut. Either way the kernel returns GLOBAL indices (into the tile's
      // `positions` buffer); we shift them down to feature-local (`- begin`) at
      // emit so the existing loop that adds `topVertexBase` works unchanged.
      const tris = tessellateFeature(f, fi, { preferPrebaked: true });
      if (!tris || tris.length === 0) continue;

      const ts = f.startTimes[fi];
      const te = f.endTimes[fi];
      const elevation = elevations[fi] ?? 0;

      // Refined ring shared by the wall + stroke passes on prelude hosts.
      // Computed lazily so flat, unstroked features skip the work. Evenly
      // spaced (vs the fill's dyadic bisection) — both sample the same
      // straight mercator segments, so any boundary mismatch is sub-pixel at
      // real granularities.
      let refinedRing: Float64Array | undefined;
      const ringOutline = (): Float64Array =>
        (refinedRing ??= refineRing(projected, granularity));

      // ---- Fill: top of the prism (or the only face when not extruded) ----
      const topVertexBase = nextVertex;
      if (granularity > 0) {
        const ringXY = new Float64Array(ringVertexCount * 2);
        for (let v = 0; v < ringVertexCount; v++) {
          ringXY[v * 2] = projected[v][0];
          ringXY[v * 2 + 1] = projected[v][1];
        }
        const localTris = new Uint32Array(tris.length);
        for (let t = 0; t < tris.length; t++) localTris[t] = tris[t] - begin;
        const sub = subdivideTrianglesMercator(ringXY, localTris, granularity);
        const subCount = sub.positions.length / 2;
        for (let v = 0; v < subCount; v++) {
          fillPositions.push(
            sub.positions[v * 2],
            sub.positions[v * 2 + 1],
            elevation,
          );
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
        for (let t = 0; t < sub.indices.length; t++) {
          fillIndicesArr.push(topVertexBase + sub.indices[t]);
        }
      } else {
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
          fillIndicesArr.push(topVertexBase + (tris[t] - begin));
        }
      }

      // ---- Side walls when extruded ----
      if (extruded && elevation > 0) {
        if (granularity > 0) {
          // Self-contained wall band over the refined ring: duplicated top
          // verts (fill colour) + bottom verts (darker), one quad per refined
          // edge. Duplication keeps the band independent of the fill mesh's
          // bisection points.
          const ring = ringOutline();
          const m = ring.length / 2;
          const wallTopBase = nextVertex;
          for (let v = 0; v < m; v++) {
            fillPositions.push(ring[v * 2], ring[v * 2 + 1], elevation);
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
          const bottomBase = nextVertex;
          for (let v = 0; v < m; v++) {
            fillPositions.push(ring[v * 2], ring[v * 2 + 1], 0);
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
          for (let v = 0; v < m; v++) {
            const next = (v + 1) % m;
            const tA = wallTopBase + v;
            const tB = wallTopBase + next;
            const bA = bottomBase + v;
            const bB = bottomBase + next;
            fillIndicesArr.push(tA, bA, tB, tB, bA, bB);
          }
        } else {
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
      }

      // ---- Stroke: ring edges ----
      if (wantStroke) {
        if (granularity > 0) {
          const ring = ringOutline();
          const m = ring.length / 2;
          for (let v = 0; v < m; v++) {
            const next = (v + 1) % m;
            strokeSegments.push({
              a: [ring[v * 2], ring[v * 2 + 1]],
              b: [ring[next * 2], ring[next * 2 + 1]],
              ts,
              te,
            });
          }
        } else {
          for (let v = 0; v < ringVertexCount; v++) {
            const a = projected[v];
            const b = projected[(v + 1) % ringVertexCount];
            strokeSegments.push({ a, b, ts, te });
          }
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

    // Stroke pass buffers (when stroked) — instanced, one row per edge. No
    // 32-bit index dance: with instancing the draw call only consumes the 4
    // shared quad verts so the per-segment count is unbounded.
    let stroke: PolygonGpuCache['stroke'] = undefined;
    if (wantStroke && strokeSegments.length > 0 && this.instSupport.enabled) {
      const segCount = strokeSegments.length;
      const sPosA = new Float32Array(segCount * 2);
      const sPosB = new Float32Array(segCount * 2);
      const sTime = new Float32Array(segCount * 2);
      for (let i = 0; i < segCount; i++) {
        const seg = strokeSegments[i];
        sPosA[i * 2] = seg.a[0];
        sPosA[i * 2 + 1] = seg.a[1];
        sPosB[i * 2] = seg.b[0];
        sPosB[i * 2 + 1] = seg.b[1];
        sTime[i * 2] = seg.ts;
        sTime[i * 2 + 1] = seg.te;
      }
      const sPosABuf = this.uploadArrayBuffer(gl, sPosA);
      const sPosBBuf = this.uploadArrayBuffer(gl, sPosB);
      const sTimeBuf = this.uploadArrayBuffer(gl, sTime);
      stroke = {
        posABuffer: sPosABuf,
        posBBuffer: sPosBBuf,
        timeBuffer: sTimeBuf,
        instanceCount: segCount,
      };
      extras.push(sPosABuf, sPosBBuf, sTimeBuf);
    }

    return {
      positionBuffer,
      timeBuffer,
      indexBuffer,
      vertexCount: totalVertices,
      indexCount: indicesArr.length,
      timeOffset: f.timeOffset,
      use32BitIndices: use32,
      subdivisionGranularity: granularity,
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
    const c = cache as PolygonGpuCache;
    // Hand-built test contexts may omit the frame — treat them as legacy.
    const frame = ctx.frame ?? this.fallbackFrame;
    const preludeProjected = frame.shader.prelude !== '';
    // VAO recordings capture attribute locations of the variant's linked
    // program; a variant flip (v5 mercator ⇄ globe transition) may relocate
    // them, so drop the recordings and re-capture under the new programs.
    if (c.vaoVariant !== frame.shader.variantName) {
      if (c.vao) this.vaoSupport.delete(c.vao);
      if (c.strokeVao) this.vaoSupport.delete(c.strokeVao);
      c.vao = undefined;
      c.strokeVao = undefined;
      c.vaoVariant = frame.shader.variantName;
    }
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    // Legacy consumes `elevation * uAltitudeScale` as mercator-z; the
    // prelude's projectTileFor3D wants meters — same uniform, mid-latitude
    // conversion factor (see MERCATOR_Z_TO_METERS_MIDLAT / D10).
    const altitudeScale = preludeProjected
      ? this.polyOpts.altitudeScale * MERCATOR_Z_TO_METERS_MIDLAT
      : this.polyOpts.altitudeScale;

    if (this.polyOpts.filled) {
      const h = this.getOrCreateProgram(
        gl,
        'fill',
        frame,
        this.fillProgramFactory,
      );
      gl.useProgram(h.program);
      if (preludeProjected) {
        // Prelude-built variant: projection rides the injected u_projection_*
        // uniforms (no uMatrix in this program).
        this.setPreludeProjectionUniforms(gl, h.program, frame);
        gl.uniform1f(h.uExtruded, this.polyOpts.extruded ? 1 : 0);
      } else {
        gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
      }
      gl.uniform1f(h.uAltitudeScale, altitudeScale);
      gl.uniform4fv(h.uColor, toRgba01(this.polyOpts.color));
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

    if (this.polyOpts.stroked && c.stroke && this.instSupport.enabled) {
      const sh = this.getOrCreateProgram(
        gl,
        'stroke',
        frame,
        this.strokeProgramFactory,
      );
      const s = c.stroke;
      gl.useProgram(sh.program);
      if (preludeProjected) {
        this.setPreludeProjectionUniforms(gl, sh.program, frame);
      } else {
        gl.uniformMatrix4fv(sh.uMatrix, false, ctx.matrix);
      }
      gl.uniform2f(sh.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(sh.uWidth, this.polyOpts.lineWidth);
      gl.uniform4fv(sh.uColor, toRgba01(this.polyOpts.lineColor));
      gl.uniform1f(sh.uWindowStart, ctx.windowStart);
      gl.uniform1f(sh.uWindowEnd, ctx.windowEnd);
      gl.uniform1f(sh.uFadeIn, fadeIn);
      gl.uniform1f(sh.uFadeOut, fadeOut);

      const quad = this.getUnitQuad(gl);
      this.bindVaoOrSetup(
        c,
        () => {
          gl.bindBuffer(gl.ARRAY_BUFFER, quad);
          gl.enableVertexAttribArray(sh.aCorner);
          gl.vertexAttribPointer(sh.aCorner, 2, gl.FLOAT, false, 0, 0);
          this.instSupport.vertexAttribDivisor(sh.aCorner, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, s.posABuffer);
          gl.enableVertexAttribArray(sh.aPosA);
          gl.vertexAttribPointer(sh.aPosA, 2, gl.FLOAT, false, 0, 0);
          this.instSupport.vertexAttribDivisor(sh.aPosA, 1);

          gl.bindBuffer(gl.ARRAY_BUFFER, s.posBBuffer);
          gl.enableVertexAttribArray(sh.aPosB);
          gl.vertexAttribPointer(sh.aPosB, 2, gl.FLOAT, false, 0, 0);
          this.instSupport.vertexAttribDivisor(sh.aPosB, 1);

          gl.bindBuffer(gl.ARRAY_BUFFER, s.timeBuffer);
          gl.enableVertexAttribArray(sh.aTime);
          gl.vertexAttribPointer(sh.aTime, 2, gl.FLOAT, false, 0, 0);
          this.instSupport.vertexAttribDivisor(sh.aTime, 1);
        },
        'stroke',
      );

      this.instSupport.drawArraysInstanced(
        0x0005 /* TRIANGLE_STRIP */,
        0,
        4,
        s.instanceCount,
      );
    }
  }
}
