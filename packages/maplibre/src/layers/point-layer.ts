/**
 * Point geometry adapter — renders POINT-type tiles as circular billboards.
 */

import type { Tile, Layer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_CATEGORICAL_PALETTE } from '@poopdeck.gl/core';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from '../base-layer.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import { TIME_WINDOW_GLSL } from '../shaders/time-window.glsl.js';
import { POSITION_DEQUANT_GLSL } from '../shaders/position-quantization.glsl.js';

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
   * Keyed category-STRING → 0–255 RGBA color map (deck/three `colorMapping`
   * parity). When set, `colorProperty`'s category NAME is looked up here so a
   * category renders the same color in every tile regardless of per-tile
   * dictionary order — avoiding the positional `colorPalette` reorder hazard.
   * Unmapped categories fall back to {@link colorMappingDefault}, then to the
   * positional `colorPalette`.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Color for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /**
   * Drive per-feature radius (pixels) from a numeric property. Falls back to
   * the constant `radius` if the property is absent.
   */
  radiusProperty?: string;
  /** Optional radius scale multiplier applied to property-driven radii. */
  radiusScale?: number;
}

// Shared with the deck.gl adapter (single source of truth in
// @poopdeck.gl/core) so both backends paint identical default colours.
const DEFAULT_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_CATEGORICAL_PALETTE;

// Immutable stand-in for callers with no host frame: onContextReady's eager
// legacy link and hand-built test DrawContexts that omit `frame`. Never
// mutated (only normalizeRenderArgs mutates frames, and it never sees this one).
const LEGACY_FRAME: HostFrame = createHostFrame();

const VS_SOURCE = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
  attribute float aRadius;     // per-feature radius in pixels (when uUseFeatureRadius=1)
  uniform mat4 uMatrix;
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
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
${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    vec4 pos = uMatrix * vec4(mercator.x, mercator.y, mercator.z * uAltitudeScale, 1.0);
    gl_Position = pos;
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    gl_PointSize = radiusPx * 2.0;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;

// ── v5+ prelude variant body (D3) ───────────────────────────────────────────
// Same attributes/uniforms/varyings as VS_SOURCE minus uMatrix/uAltitudeScale:
// the host-injected prelude owns projection. Billboards are 2d content, so
// positions route through projectTile(vec2) — it overwrites z for horizon
// clipping, which is exactly right for screen-facing discs (real 3D content
// would need projectTileFor3D). Single-vertex geometry needs no globe edge
// subdivision, and STT tiles are world-absolute (no wrap copies to skip).
// gl_PointSize math is unchanged from the legacy variant.
const VS_V5_BODY = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
  attribute float aRadius;     // per-feature radius in pixels (when uUseFeatureRadius=1)
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
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
${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    gl_Position = projectTile(mercator.xy);
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

// ── id-buffer picking variant (browser-verify-only) ─────────────────────────
// Same projection + billboard sizing + time-window gating as the visual pass,
// but each feature paints its flat opaque `encodePickId` colour so a readback
// recovers the feature index. The disc mask matches the visual FS so only the
// visible circle is pickable (no square hit box); no antialiased edge — a
// partially-covered edge texel must still decode to the exact id byte triple.
const ID_VS_SOURCE = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec3 aIdColor;     // per-feature encoded id (UNSIGNED_BYTE normalized)
  attribute float aRadius;
  uniform mat4 uMatrix;
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uAltitudeScale;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
  varying vec3 vIdColor;
${TIME_WINDOW_GLSL}
${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    gl_Position = uMatrix * vec4(mercator.x, mercator.y, mercator.z * uAltitudeScale, 1.0);
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    gl_PointSize = radiusPx * 2.0;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    vIdColor = aIdColor;
  }
`;

// v5+ prelude body for the id pass — mirrors VS_V5_BODY's projectTile routing
// so the pickable disc lands on the same pixels the visual pass painted (on
// globe as well as mercator).
const ID_VS_V5_BODY = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec3 aIdColor;     // per-feature encoded id (UNSIGNED_BYTE normalized)
  attribute float aRadius;
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
  varying vec3 vIdColor;
${TIME_WINDOW_GLSL}
${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    gl_Position = projectTile(mercator.xy);
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    gl_PointSize = radiusPx * 2.0;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    vIdColor = aIdColor;
  }
`;

const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // time-filtered points are not pickable
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;      // circular hit area, matches the visual disc
    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * Assemble the visual vertex shader for a host shader variant. Legacy hosts
 * (empty prelude) get {@link VS_SOURCE} verbatim — the `uMatrix` path,
 * behaviour-identical to the pre-v5 shader. v5+ hosts get the injected
 * prelude + define prepended (maplibre's documented order) with projection
 * routed through the prelude's `projectTile`.
 */
export function buildPointVertexSource(shader: ShaderInjection): string {
  if (!shader.prelude) return VS_SOURCE;
  return `${shader.prelude}\n${shader.define}\n${VS_V5_BODY}`;
}

/** Id-pick counterpart of {@link buildPointVertexSource}. */
export function buildPointIdVertexSource(shader: ShaderInjection): string {
  if (!shader.prelude) return ID_VS_SOURCE;
  return `${shader.prelude}\n${shader.define}\n${ID_VS_V5_BODY}`;
}

interface PointIdProgramHandles {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aMercator: number;
  aTime: number;
  aIdColor: number;
  aRadius: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uAltitudeScale: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uRadiusScale: WebGLUniformLocation | null;
  uUseFeatureRadius: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
}

interface PointProgramHandles {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aMercator: number;
  aTime: number;
  aColor: number;
  aRadius: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
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
  /**
   * Shader variant the cached VAO's attribute locations were recorded
   * against. A VAO stores attribute SLOTS, which are per-program — when the
   * host flips variants (mercator ⇄ globe) the relinked program may assign
   * different slots, so the VAO must be rebuilt against it.
   */
  vaoVariant?: string;
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
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
  };
  /**
   * Handles of the most recently used variant (legacy seeded eagerly in
   * onContextReady), memoized per `*Variant` so the per-tile hot path skips
   * the base cache's key-string build; the cache is only consulted on a
   * variant flip. Cleared together in onContextLost.
   */
  private handles?: PointProgramHandles;
  private handlesVariant?: string;
  private idHandles?: PointIdProgramHandles;
  private idHandlesVariant?: string;

  constructor(opts: STTPointLayerOptions) {
    super(opts);
    this.pointOpts = {
      color: opts.color ?? [0.31, 0.76, 0.97, 1.0],
      radius: opts.radius ?? 4,
      radiusScale: opts.radiusScale ?? 1,
      colorProperty: opts.colorProperty,
      radiusProperty: opts.radiusProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
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

  /** Link the visual program for a variant and resolve its locations. */
  private buildMainHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): PointProgramHandles {
    const program = this.linkProgram(
      gl,
      buildPointVertexSource(shader),
      FS_SOURCE,
    );
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aRadius: gl.getAttribLocation(program, 'aRadius'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
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

  /** Link the id-pick program for a variant and resolve its locations. */
  private buildIdHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): PointIdProgramHandles {
    const program = this.linkProgram(
      gl,
      buildPointIdVertexSource(shader),
      ID_FS_SOURCE,
    );
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
      aRadius: gl.getAttribLocation(program, 'aRadius'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uAltitudeScale: gl.getUniformLocation(program, 'uAltitudeScale'),
      uRadius: gl.getUniformLocation(program, 'uRadius'),
      uRadiusScale: gl.getUniformLocation(program, 'uRadiusScale'),
      uUseFeatureRadius: gl.getUniformLocation(program, 'uUseFeatureRadius'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
    };
  }

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Eagerly link the legacy variants (what a ≤v4 host uses from its first
    // frame; a v5 host links its own variant lazily through the base
    // per-variant program cache on first draw, then reuses it). The id
    // program is compiled up-front alongside the visual one (as before) so
    // the first `pick()` doesn't stall; it's a tiny flat-colour shader.
    this.handles = this.getOrCreateProgram(gl, 'main', LEGACY_FRAME, (g, s) =>
      this.buildMainHandles(g, s),
    );
    this.handlesVariant = LEGACY_FRAME.shader.variantName;
    this.idHandles = this.getOrCreateProgram(gl, 'pick', LEGACY_FRAME, (g, s) =>
      this.buildIdHandles(g, s),
    );
    this.idHandlesVariant = LEGACY_FRAME.shader.variantName;
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
        this.pointOpts.colorMapping,
        this.pointOpts.colorMappingDefault,
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
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Program lifetimes are owned by the base per-variant cache (deleted on
    // dispose, dropped on context loss — both before this hook runs); only
    // the handle references are ours to clear.
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    let h = this.handles;
    if (!h || this.handlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, 'main', frame, (g, s) =>
        this.buildMainHandles(g, s),
      );
      this.handles = h;
      this.handlesVariant = variant;
    }
    const c = cache as PointGpuCache;

    gl.useProgram(h.program);
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude's projectTile owns projection.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
      gl.uniform1f(h.uAltitudeScale, 0); // 2D points; altitudes are ignored.
    }
    gl.uniform3fv(h.uPosScale, c.posScale ?? [1, 1, 1]);
    gl.uniform3fv(h.uPosOffset, c.posOffset ?? [0, 0, 0]);
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

    // A VAO records attribute locations against ONE program — drop it when
    // the host flipped shader variants so it re-records against `h`.
    if (c.vao && c.vaoVariant !== frame.shader.variantName) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }

    // First-frame VAO setup: capture every attribute binding. Subsequent
    // frames just `bindVertexArray` and reuse all the state we recorded.
    this.bindVaoOrSetup(c, () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.positionBuffer);
      gl.enableVertexAttribArray(h.aMercator);
      gl.vertexAttribPointer(h.aMercator, 3, gl.UNSIGNED_SHORT, true, 0, 0);

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
    c.vaoVariant = frame.shader.variantName;

    gl.drawArrays(gl.POINTS, 0, cache.vertexCount);
  }

  /**
   * Draw this point tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)`. Mirrors {@link drawTile}'s projection
   * (including the v5+ prelude variant, resolved from the same host frame),
   * billboard sizing and time-window gating so the pickable disc matches what
   * the user sees. Browser-verify-only (the enclosing FBO round-trip needs a
   * live GPU); the id-colour build + decode join are unit-tested in the base.
   *
   * The per-feature id-colour buffer is rebuilt each pick and freed immediately:
   * `idBase` shifts with whatever tiles are loaded this frame, and picks are
   * rare user-initiated events, so a persistent per-tile buffer would be stale
   * cache for no win.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    let h = this.idHandles;
    if (!h || this.idHandlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, 'pick', frame, (g, s) =>
        this.buildIdHandles(g, s),
      );
      this.idHandles = h;
      this.idHandlesVariant = variant;
    }
    const c = cache as PointGpuCache;
    // One point == one feature, so vertexCount is the feature count here.
    const count = cache.vertexCount;
    const idColors = this.buildPickIdColors(count, idBase);
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    gl.useProgram(h.program);
    if (h.usesPrelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
      gl.uniform1f(h.uAltitudeScale, 0);
    }
    gl.uniform3fv(h.uPosScale, c.posScale ?? [1, 1, 1]);
    gl.uniform3fv(h.uPosOffset, c.posOffset ?? [0, 0, 0]);
    gl.uniform1f(h.uRadius, this.pointOpts.radius);
    gl.uniform1f(h.uRadiusScale, this.pointOpts.radiusScale);
    gl.uniform1f(h.uWindowStart, ctx.windowStart);
    gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    gl.uniform1f(h.uFadeIn, fadeIn);
    gl.uniform1f(h.uFadeOut, fadeOut);
    const useFeatureRadius = c.radiusBuffer && h.aRadius >= 0 ? 1 : 0;
    gl.uniform1f(h.uUseFeatureRadius, useFeatureRadius);

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass, and
    // the temp id buffer is per-pass, so a cached VAO would just go stale.
    gl.bindBuffer(gl.ARRAY_BUFFER, c.positionBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 3, gl.UNSIGNED_SHORT, true, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    if (useFeatureRadius && c.radiusBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.radiusBuffer);
      gl.enableVertexAttribArray(h.aRadius);
      gl.vertexAttribPointer(h.aRadius, 1, gl.FLOAT, false, 0, 0);
    }

    gl.drawArrays(gl.POINTS, 0, count);

    // Leave the default-VAO attribute slate clean so the next visual frame's
    // VAO setup starts fresh, and drop the one-shot id buffer.
    gl.disableVertexAttribArray(h.aMercator);
    gl.disableVertexAttribArray(h.aTime);
    gl.disableVertexAttribArray(h.aIdColor);
    if (useFeatureRadius && c.radiusBuffer) {
      gl.disableVertexAttribArray(h.aRadius);
    }
    gl.deleteBuffer(idBuffer);
  }
}
