/**
 * Animated trips adapter — renders LINESTRING-type tiles as a head-anchored,
 * time-animated ribbon. Equivalent to @poopdeck.gl/layers's AnimatedTripsLayer.
 *
 * Each segment is drawn as one instance of a shared 4-vertex unit quad; the
 * per-instance attributes carry the two endpoints and their (relative)
 * timestamps. Alpha is computed in the vertex shader against the current
 * tile-relative time, using the shared time-mode snippets. If
 * `binary.vertexTimestamps` is present we use it for endpoint times; otherwise
 * the shared `synthesizeVertexTimes` kernel (@poopdeck.gl/core/trips) spreads
 * `[startTime, endTime]` by cumulative DISTANCE — the same distribution deck,
 * three and the Rust producer use, so a long leg does not advance at the same
 * rate as a short one.
 *
 * ── TIME MODES (campaign D8) ────────────────────────────────────────────────
 * Both modes are PER-VERTEX (that is what makes a trip a trip) and are chosen
 * at PROGRAM-BUILD time, so the mode is part of the program cache key:
 *   - `trail` (default) — the classic comet: vertices inside
 *     `[currentTime - trailLength, currentTime]` render, with a NUMERIC
 *     head→tail fade (`fadeTrail`).
 *   - `wake` (`wakeLength > 0`, wins over trail per deck's precedence) — same
 *     window anchored on `wakeLength`, plus the tail WIDTH taper deck applies
 *     to wake-mode point sizes (`sttWakeSizeScale`). deck reaches this shape by
 *     feeding per-vertex times to its wake branch's `instanceStartTime`; core's
 *     `wakeAlpha` math is used verbatim.
 * `trailLength <= 0` with no wake means NO TRAIL: nothing renders and nothing
 * is pickable (see {@link STTTripsLayerOptions.trailLength}).
 *
 * ── DATA FILTER ─────────────────────────────────────────────────────────────
 * `filterProperty` + `filterRange`/`filterSoftRange` range-filter trips by one
 * baked numeric column (`shaders/data-filter.glsl.ts`, deck's
 * `DataFilterExtension` semantics). The value is per-FEATURE, splatted across
 * the segments that feature contributed, so a filtered-out trip collapses whole.
 *
 * ── SIZING ──────────────────────────────────────────────────────────────────
 * `widthUnits: 'meters'` resolves metric widths to device pixels per tile at
 * the tile's centre latitude (`lib/projection.ts`, campaign D10 scale), clamped
 * to `[widthMinPixels, widthMaxPixels]`.
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
import { synthesizeVertexTimes } from '@poopdeck.gl/core/trips';
import {
  GeometryType,
  DEFAULT_TRIPS_PALETTE as CORE_TRIPS_PALETTE,
} from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTBaseLayer,
  expandPickIdColors,
  resolveTrailFade,
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
import { subdivideLineMercator } from '../lib/globe.js';
import {
  lngLatToMercator,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../lib/projection.js';
import {
  TIME_TRAIL_GLSL,
  TIME_WAKE_GLSL,
} from '../shaders/time-window.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  createDataFilterUniforms,
  expandFilterValues,
  extractFilterColumn,
  resolveDataFilterUniforms,
  type DataFilterRange,
  type DataFilterUniforms,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';

// Shared with @poopdeck.gl/layers AnimatedTripsLayer (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_TRIPS_PALETTE: ReadonlyArray<RGBA8> = CORE_TRIPS_PALETTE;

/**
 * Upper clamp when `widthMaxPixels` is unset — far past any legible on-screen
 * width, so the default clamp is a no-op (a real `Infinity` uniform is not
 * portable across drivers).
 */
const UNBOUNDED_WIDTH_PIXELS = 1e6;

// Hand-built test DrawContexts may omit `frame`; those behave as a legacy
// positional-matrix host. Never mutated — real render/pick paths always pass
// the base scratch frame.
const FALLBACK_LEGACY_FRAME: HostFrame = createHostFrame();

/** Active per-vertex time mode; `off` draws (and picks) nothing. */
type TripsTimeMode = 'trail' | 'wake' | 'off';

// Program-cache keys, enumerated rather than templated: `getHandles` runs once
// per tile per frame and the base appends the host variant itself, so building
// the string there was pure GC churn during playback.
const VISUAL_PROGRAM_KEY: Readonly<Record<'trail' | 'wake', string>> = {
  trail: 'trips:trail',
  wake: 'trips:wake',
};
const PICK_PROGRAM_KEY: Readonly<Record<'trail' | 'wake', string>> = {
  trail: 'trips:pick:trail',
  wake: 'trips:pick:wake',
};

export interface STTTripsLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /** Constant line colour (overridden by colorProperty). */
  color?: [number, number, number, number];
  /**
   * Constant line width, in `widthUnits` (overridden by widthProperty).
   * @default 2
   */
  width?: number;
  /** Multiplier applied to per-feature widths. */
  widthScale?: number;
  /**
   * Units for `width` / `widthProperty` values. `'pixels'` (default) is
   * screen-space; `'meters'` resolves the width against the tile's centre
   * latitude and the live zoom, so trails thicken with zoom like real objects.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters';
  /**
   * Lower clamp on the resolved on-screen width, in DEVICE pixels. Mainly for
   * `widthUnits: 'meters'`, where a metric width vanishes when zoomed out.
   * @default 0
   */
  widthMinPixels?: number;
  /**
   * Upper clamp on the resolved on-screen width, in DEVICE pixels. Defaults to
   * effectively unbounded (NOT deck's 10) so existing pixel-sized layers are
   * untouched by the clamp's introduction.
   */
  widthMaxPixels?: number;
  /**
   * Trail length, in milliseconds: vertices older than this are clipped.
   *
   * `<= 0` means NO TRAIL — nothing renders (and nothing is pickable) unless a
   * `wakeLength` is set. This matches deck (`TimeFilterExtension` only enters
   * trail mode when `trailLength > 0`) and core `trailAlpha` (which returns 0
   * once the window has collapsed). Before this wave a non-positive
   * `trailLength` here revealed the ENTIRE past trip at full alpha.
   * @default 180000
   */
  trailLength?: number;
  /**
   * Head→tail fade INSIDE the trail: `1` (default) is the classic comet, `0` a
   * solid snake, and intermediate values blend between them
   * (`mix(1.0, faded, fadeTrail)` — deck's `trailFade` uniform / core
   * `trailAlpha`). Booleans are accepted for back-compat (`true` → 1,
   * `false` → 0); anything outside 0..1 is clamped.
   * @default 1
   */
  fadeTrail?: boolean | number;
  /**
   * Wake length, in milliseconds. When > 0 the layer switches from trail mode
   * to WAKE mode (deck's precedence: cumulative > wake > trail > window): the
   * same per-vertex window, plus a width taper toward the tail.
   * @default 0 (trail mode)
   */
  wakeLength?: number;
  /**
   * Tail width multiplier in wake mode; the head always keeps full width.
   * @default 0.15 (core `DEFAULT_WAKE_TAIL_SCALE`)
   */
  wakeTailScale?: number;
  /** Drive per-feature colour from a categorical property name. */
  colorProperty?: string;
  /** Palette used with colorProperty (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA map (deck/three `colorMapping` parity).
   * A category then renders the same colour in every tile regardless of
   * per-tile dictionary order; unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional `colorPalette`.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /** Drive per-feature width from a numeric property name. */
  widthProperty?: string;
}

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * Trail alpha. `uFadeTrail` is the shared kernel's CONTINUOUS 0..1 weight
 * (`resolveTrailFade`), so a single call is exactly core
 * `trailAlpha(currentTime, vertexTime, trailLength, fade)`; no per-layer blend.
 */
const TRAIL_ALPHA_BODY = `
    float timeAlpha = sttTrailAlpha(vertexTime, uCurrentTime, uTrailLength, uFadeTrail);
    float sizeScale = 1.0;`;

/**
 * Wake alpha + the matching tail taper. `sttWakeAlpha` reads only `.x` of its
 * time pair, so the per-vertex time is passed in both lanes.
 */
const WAKE_ALPHA_BODY = `
    float timeAlpha = sttWakeAlpha(vec2(vertexTime, vertexTime), uCurrentTime, uWakeLength);
    float sizeScale = sttWakeSizeScale(timeAlpha, uWakeTailScale);`;

/**
 * Variant- and mode-aware vertex source (base program-cache contract): with an
 * injected prelude (v5+ host) the endpoints project via `projectTile(vec2)`;
 * without one (the 'legacy' variant) the projection block is the historical
 * `uMatrix` shader. The variant block sits exactly where `uniform mat4 uMatrix;`
 * otherwise would — GLSL only needs declarations before `main`. The
 * screen-space quad extrusion happens post-projection in NDC, so it is
 * identical for both variants, and both carry the same time/filter math.
 *
 * `pass: 'pick'` swaps the colour attribute/varying for the flat id colour and
 * keeps every visibility gate, so a feature the user cannot see cannot be
 * picked either.
 */
function buildVertexSource(
  shader: ShaderInjection,
  mode: 'trail' | 'wake',
  pass: 'draw' | 'pick',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const projectionDecls = usesPrelude
    ? `${shader.prelude}\n${shader.define}`
    : '  uniform mat4 uMatrix;';
  const project = (pos: string) =>
    usesPrelude ? `projectTile(${pos})` : `uMatrix * vec4(${pos}, 0.0, 1.0)`;
  const isPick = pass === 'pick';
  return `
  precision highp float;
  attribute vec2 aCorner;        // (side, along) ∈ {-1,1} × {0,1}, per-vertex
  attribute vec2 aPosA;          // segment start, per-instance
  attribute vec2 aPosB;          // segment end, per-instance
  attribute vec2 aVertexTimeAB;  // [timeA, timeB], per-instance, tile-relative
${
  isPick
    ? '  attribute vec3 aIdColor;       // per-instance encoded pick id'
    : '  attribute vec4 aColor;         // per-feature RGBA (when uUseFeatureColor=1)'
}
  attribute float aWidth;        // per-feature width (when uUseFeatureWidth=1)
${DATA_FILTER_ATTRIBUTE_GLSL}
${projectionDecls}
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWidthScale;    // widthScale × (metres→device px when metric)
  uniform vec2 uWidthPixelRange; // [min, max] resolved width, device px
  uniform float uUseFeatureWidth;
${isPick ? '' : '  uniform float uUseFeatureColor;\n  uniform vec4 uColor;'}
  uniform float uCurrentTime;
  uniform float uTrailLength;
  uniform float uFadeTrail;
  uniform float uWakeLength;
  uniform float uWakeTailScale;
${DATA_FILTER_UNIFORMS_GLSL}
  varying float vAlpha;
${isPick ? '  varying vec3 vIdColor;' : '  varying vec4 vColor;'}
${mode === 'wake' ? TIME_WAKE_GLSL : TIME_TRAIL_GLSL}
${DATA_FILTER_GLSL}
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

    float vertexTime = mix(aVertexTimeAB.x, aVertexTimeAB.y, aCorner.y);
${mode === 'wake' ? WAKE_ALPHA_BODY : TRAIL_ALPHA_BODY}
    float filterAlpha = ${DATA_FILTER_CALL_GLSL};

    float widthPx = clamp(
      (uUseFeatureWidth > 0.5 ? aWidth : uWidth) * uWidthScale,
      uWidthPixelRange.x,
      uWidthPixelRange.y
    ) * sizeScale;
    // deck 'vs:DECKGL_FILTER_SIZE': shrink features fading out of the soft band.
    if (uFilterTransformSize > 0.5) widthPx *= filterAlpha;
    vec2 offsetPx = perp * aCorner.x * widthPx * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;
    // deck 'vs:#main-end': collapse a fully filtered-out FEATURE. Gate on
    // filterAlpha only — it is feature-constant, so every segment collapses
    // together; vAlpha varies per vertex in trail mode and would tear the quad.
    if (filterAlpha <= 0.0) gl_Position = vec4(0.0);

    // Hard filter cuts unconditionally; the partial soft-band fade applies only
    // under filterTransformColor (deck 'fs:DECKGL_FILTER_COLOR').
    vAlpha = (filterAlpha <= 0.0)
      ? 0.0
      : timeAlpha * ((uFilterTransformColor > 0.5) ? filterAlpha : 1.0);
${isPick ? '    vIdColor = aIdColor;' : '    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;'}
  }
`;
}

/** Visual vertex source for a host shader variant + time mode. */
export function buildTripsVertexSource(
  shader: ShaderInjection,
  mode: 'trail' | 'wake',
): string {
  return buildVertexSource(shader, mode, 'draw');
}

/** Id-pick counterpart of {@link buildTripsVertexSource}. */
export function buildTripsIdVertexSource(
  shader: ShaderInjection,
  mode: 'trail' | 'wake',
): string {
  return buildVertexSource(shader, mode, 'pick');
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

// Id-pass fragment stage: same visibility gate as the visual pass (time filter
// AND column filter), then the exact id bytes — no blending, no antialiasing,
// so the readback recovers the triple.
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

/** Locations shared by the visual and id programs. */
interface TripsCommonHandles {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  aVertexTimeAB: number;
  aWidth: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uWidthPixelRange: WebGLUniformLocation | null;
  uUseFeatureWidth: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uTrailLength: WebGLUniformLocation | null;
  uFadeTrail: WebGLUniformLocation | null;
  uWakeLength: WebGLUniformLocation | null;
  uWakeTailScale: WebGLUniformLocation | null;
  uFilterRange: WebGLUniformLocation | null;
  uFilterSoftRange: WebGLUniformLocation | null;
  uFilterEnabled: WebGLUniformLocation | null;
  uFilterTransformSize: WebGLUniformLocation | null;
  uFilterTransformColor: WebGLUniformLocation | null;
}

interface TripsProgramHandles extends TripsCommonHandles {
  aColor: number;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

interface TripsIdProgramHandles extends TripsCommonHandles {
  aIdColor: number;
}

interface TripsGpuCache extends TileGpuCache {
  posABuffer: WebGLBuffer;
  posBBuffer: WebGLBuffer;
  vertexTimeABBuffer: WebGLBuffer;
  instanceCount: number;
  colorBuffer?: WebGLBuffer;
  widthBuffer?: WebGLBuffer;
  /** Per-instance filter values, splatted from the per-feature column. */
  filterBuffer?: WebGLBuffer;
  /** True when THIS tile baked the named numeric filter column. */
  hasFilterColumn: boolean;
  /**
   * Instances (segments) contributed by each FEATURE, indexed by feature — the
   * expansion map for both the filter column and the per-feature pick ids.
   * Features with < 2 vertices contribute 0.
   */
  segmentCounts: Uint32Array;
  /**
   * Program the cached VAO's attribute locations were recorded against. Both a
   * host-variant flip (mercator ⇄ globe) and a time-mode flip (trail ⇄ wake)
   * swap programs and may re-assign locations, so program IDENTITY — not the
   * variant name alone — is what a recorded VAO must be checked against.
   */
  vaoProgram?: WebGLProgram | null;
}

export class STTTripsLayer extends STTBaseLayer {
  private tripsOpts: {
    color: [number, number, number, number];
    width: number;
    widthScale: number;
    widthUnits: 'pixels' | 'meters';
    widthMinPixels: number;
    widthMaxPixels: number;
    trailLength: number;
    fadeTrail: number;
    wakeLength: number;
    wakeTailScale: number;
    colorProperty?: string;
    widthProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
  };
  /** Column-filter props, resolved into {@link filterUniforms} per draw. */
  private filterOpts: STTDataFilterOptions;
  /** Allocated once — the draw path re-resolves it in place, never allocates. */
  private readonly filterUniforms: DataFilterUniforms =
    createDataFilterUniforms();
  /** One warning per layer for a categorical `filterProperty`. */
  private warnedCategoricalFilter = false;
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
      widthUnits: opts.widthUnits ?? 'pixels',
      widthMinPixels: opts.widthMinPixels ?? 0,
      widthMaxPixels: opts.widthMaxPixels ?? UNBOUNDED_WIDTH_PIXELS,
      trailLength: opts.trailLength ?? 180_000, // 3 minutes default, matches deck.gl
      fadeTrail: resolveTrailFade(opts.fadeTrail),
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      colorProperty: opts.colorProperty,
      widthProperty: opts.widthProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_TRIPS_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
    };
    this.filterOpts = {
      filterProperty: opts.filterProperty,
      filterRange: opts.filterRange,
      filterSoftRange: opts.filterSoftRange,
      filterEnabled: opts.filterEnabled,
      filterTransformSize: opts.filterTransformSize,
      filterTransformColor: opts.filterTransformColor,
    };
  }

  /** Update the trail length (ms) at runtime. */
  setTrailLength(ms: number): void {
    this.tripsOpts.trailLength = ms;
    this.map?.triggerRepaint();
  }

  /** Update the head→tail fade (boolean or 0..1) at runtime. */
  setFadeTrail(fade: boolean | number): void {
    this.tripsOpts.fadeTrail = resolveTrailFade(fade);
    this.map?.triggerRepaint();
  }

  /** Update the wake length (ms); > 0 switches the layer to wake mode. */
  setWakeLength(ms: number): void {
    this.tripsOpts.wakeLength = ms;
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

  /** Animate the filter bounds — uniform-only, no tile re-upload. */
  setFilterRange(range: DataFilterRange | null): void {
    this.filterOpts.filterRange = range;
    this.map?.triggerRepaint();
  }

  /** Animate the soft margin — uniform-only, no tile re-upload. */
  setFilterSoftRange(range: DataFilterRange | null): void {
    this.filterOpts.filterSoftRange = range;
    this.map?.triggerRepaint();
  }

  /** Toggle the filter without dropping the bound column. */
  setFilterEnabled(enabled: boolean): void {
    this.filterOpts.filterEnabled = enabled;
    this.map?.triggerRepaint();
  }

  /**
   * Point the filter at a different baked column. The values are a per-tile
   * ATTRIBUTE, so this rebuilds the tile caches (unlike the range setters).
   */
  setFilterProperty(property?: string): void {
    if (this.filterOpts.filterProperty === property) return;
    this.filterOpts.filterProperty = property;
    this.warnedCategoricalFilter = false;
    this.rebuildTileCaches();
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
   * Active time mode (deck's precedence: wake before trail). `off` means the
   * knobs describe an empty window — the layer then draws nothing and reports
   * nothing pickable, matching deck (whose trail branch needs
   * `trailLength > 0`) and core `trailAlpha`.
   */
  private resolveTimeMode(): TripsTimeMode {
    if (this.tripsOpts.wakeLength > 0) return 'wake';
    if (this.tripsOpts.trailLength > 0) return 'trail';
    return 'off';
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

  // Programs are built lazily per (host shader variant × time mode) through
  // the base program cache ({@link getHandles}); nothing to allocate eagerly.
  // The base invalidates that cache on context loss and dispose.
  protected onContextReady(): void {}

  protected onContextLost(): void {}

  /** Resolve the locations both programs share. */
  private commonHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    usesPrelude: boolean,
  ): TripsCommonHandles {
    return {
      program,
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aPosA: gl.getAttribLocation(program, 'aPosA'),
      aPosB: gl.getAttribLocation(program, 'aPosB'),
      aVertexTimeAB: gl.getAttribLocation(program, 'aVertexTimeAB'),
      aWidth: gl.getAttribLocation(program, 'aWidth'),
      aFilterValue: gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute),
      // uMatrix is undeclared on prelude variants — never look it up there
      // so the legacy MVP can't be pushed to a projectTile program.
      uMatrix: usesPrelude ? null : gl.getUniformLocation(program, 'uMatrix'),
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uWidth: gl.getUniformLocation(program, 'uWidth'),
      uWidthScale: gl.getUniformLocation(program, 'uWidthScale'),
      uWidthPixelRange: gl.getUniformLocation(program, 'uWidthPixelRange'),
      uUseFeatureWidth: gl.getUniformLocation(program, 'uUseFeatureWidth'),
      uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
      uTrailLength: gl.getUniformLocation(program, 'uTrailLength'),
      uFadeTrail: gl.getUniformLocation(program, 'uFadeTrail'),
      uWakeLength: gl.getUniformLocation(program, 'uWakeLength'),
      uWakeTailScale: gl.getUniformLocation(program, 'uWakeTailScale'),
      uFilterRange: gl.getUniformLocation(program, DATA_FILTER_NAMES.range),
      uFilterSoftRange: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.softRange,
      ),
      uFilterEnabled: gl.getUniformLocation(program, DATA_FILTER_NAMES.enabled),
      uFilterTransformSize: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.transformSize,
      ),
      uFilterTransformColor: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.transformColor,
      ),
    };
  }

  /**
   * Visual program handles for the frame's shader variant AND the active time
   * mode. The mode is part of the cache key: the base only appends
   * `::variantName`, so two modes under one key would collide.
   */
  private getHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    mode: 'trail' | 'wake',
  ): TripsProgramHandles {
    return this.getOrCreateProgram(
      gl,
      VISUAL_PROGRAM_KEY[mode],
      frame,
      (pgl, shader) => {
        const usesPrelude = shader.prelude.length > 0;
        const program = this.linkProgram(
          pgl,
          buildTripsVertexSource(shader, mode),
          FS_SOURCE,
        );
        return {
          ...this.commonHandles(pgl, program, usesPrelude),
          aColor: pgl.getAttribLocation(program, 'aColor'),
          uUseFeatureColor: pgl.getUniformLocation(program, 'uUseFeatureColor'),
          uColor: pgl.getUniformLocation(program, 'uColor'),
        };
      },
    );
  }

  /** Id-pick counterpart of {@link getHandles}. */
  private getIdHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    mode: 'trail' | 'wake',
  ): TripsIdProgramHandles {
    return this.getOrCreateProgram(
      gl,
      PICK_PROGRAM_KEY[mode],
      frame,
      (pgl, shader) => {
        const usesPrelude = shader.prelude.length > 0;
        const program = this.linkProgram(
          pgl,
          buildTripsIdVertexSource(shader, mode),
          ID_FS_SOURCE,
        );
        return {
          ...this.commonHandles(pgl, program, usesPrelude),
          aIdColor: pgl.getAttribLocation(program, 'aIdColor'),
        };
      },
    );
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
    // Tiles without a baked `vertex_time` column go through the SHARED
    // synthesis kernel (cumulative haversine distance), not a per-index ramp:
    // an index ramp gives a 10 km leg the same time delta as a 100 m stub, so
    // the head flashes across the long one. Same kernel three/deck use and the
    // same distribution the Rust producer's `interpolate_vertex_times` bakes.
    const synthesizedTimes = hasVertexTimestamps
      ? null
      : synthesizeVertexTimes(f);

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
    // Instances contributed per FEATURE — the expansion map for the filter
    // column and the pick ids (0 for features too short to make a segment).
    const segmentCounts = new Uint32Array(featureCount);
    let segmentCount = 0;
    for (let fi = 0; fi < featureCount; fi++) {
      const begin = startIndices[fi];
      const end = startIndices[fi + 1];
      const numVerts = end - begin;
      if (numVerts < 2) continue;

      const srcTimes = hasVertexTimestamps
        ? f.vertexTimestamps!
        : synthesizedTimes!;
      let merc: Float64Array = new Float64Array(numVerts * 2);
      let times: Float32Array = new Float32Array(numVerts);
      for (let v = 0; v < numVerts; v++) {
        const [mx, my] = lngLatToMercator(
          f.positions[(begin + v) * dims],
          f.positions[(begin + v) * dims + 1],
        );
        merc[v * 2] = mx;
        merc[v * 2 + 1] = my;
        times[v] = srcTimes[begin + v];
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
      const segs = merc.length / 2 - 1;
      segmentCounts[fi] = segs;
      segmentCount += segs;
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
          this.tripsOpts.colorMapping,
          this.tripsOpts.colorMappingDefault,
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

    // Column filter: per-FEATURE values splatted across that feature's
    // segments. A missing (or categorical) column leaves the tile unfiltered —
    // never blank.
    const filterColumn = extractFilterColumn(f, this.filterOpts.filterProperty);
    if (filterColumn.categorical && !this.warnedCategoricalFilter) {
      this.warnedCategoricalFilter = true;
      console.warn(
        `[${this.id}] filterProperty "${this.filterOpts.filterProperty}" is a ` +
          `categorical column; v1 range-filters NUMERIC columns only — ` +
          `rendering unfiltered.`,
      );
    }
    const filterAttr = filterColumn.values
      ? expandFilterValues(filterColumn.values, segmentCounts, segmentCount)
      : null;

    const posABuffer = this.uploadArrayBuffer(gl, posA);
    const posBBuffer = this.uploadArrayBuffer(gl, posB);
    const vertexTimeABBuffer = this.uploadArrayBuffer(gl, vTimeAB);
    // Keep a dummy timeBuffer to satisfy the base TileGpuCache contract — the
    // per-vertex shaders don't read [startTime,endTime] (that's window mode),
    // so we point it at a zero-length buffer rather than the per-instance times.
    const timeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);

    const positionBuffer = posABuffer;
    const extras: WebGLBuffer[] = [posBBuffer, vertexTimeABBuffer];
    let colorBuffer: WebGLBuffer | undefined;
    let widthBuffer: WebGLBuffer | undefined;
    let filterBuffer: WebGLBuffer | undefined;
    if (colorAttr) {
      colorBuffer = this.uploadArrayBuffer(gl, colorAttr);
      extras.push(colorBuffer);
    }
    if (widthAttr) {
      widthBuffer = this.uploadArrayBuffer(gl, widthAttr);
      extras.push(widthBuffer);
    }
    if (filterAttr) {
      filterBuffer = this.uploadArrayBuffer(gl, filterAttr);
      extras.push(filterBuffer);
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
      filterBuffer,
      hasFilterColumn: filterColumn.hasColumn,
      segmentCounts,
    };
  }

  /**
   * Metres → DEVICE pixels for this tile, or 1 in pixel mode. Resolved at the
   * tile's centre latitude and the live (fractional) zoom, folded into
   * `uWidthScale` so the constant AND the per-feature width column share it.
   */
  private widthUnitScale(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    if (this.tripsOpts.widthUnits !== 'meters') return 1;
    // Shared base helper (memoized against the drawing-buffer width, so the
    // layout-forcing `canvas.clientWidth` read does not repeat per tile).
    const dpr = this.resolveDevicePixelRatio(gl);
    // Fractional zoom keeps metric widths continuous across zoom levels;
    // ctx.zoom is floored (tile-selection granularity).
    const zoom = this.frameZoom ?? this.map?.getZoom() ?? ctx.zoom;
    return metersToPixelsAtLatitude(
      1,
      tileCenterLatitude(tile.id.z, tile.id.y),
      zoom,
      512 * dpr,
    );
  }

  /**
   * Bind the program and push every uniform the visual and id passes share:
   * projection, sizing (with metric resolution), the active mode's time knobs
   * and the column filter. Allocation-free.
   */
  private setCommonUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TripsCommonHandles,
    cache: TripsGpuCache,
    tile: Tile,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    gl.useProgram(h.program);
    this.setPreludeProjectionUniforms(gl, h.program, frame);
    if (h.uMatrix) gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uWidth, this.tripsOpts.width);
    gl.uniform1f(
      h.uWidthScale,
      this.tripsOpts.widthScale * this.widthUnitScale(gl, tile, ctx),
    );
    gl.uniform2f(
      h.uWidthPixelRange,
      this.tripsOpts.widthMinPixels,
      this.tripsOpts.widthMaxPixels,
    );
    // currentTime relative to this tile's timeOffset (same convention as the
    // window-mode shaders).
    gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
    gl.uniform1f(h.uTrailLength, this.tripsOpts.trailLength);
    gl.uniform1f(h.uFadeTrail, this.tripsOpts.fadeTrail);
    gl.uniform1f(h.uWakeLength, this.tripsOpts.wakeLength);
    gl.uniform1f(h.uWakeTailScale, this.tripsOpts.wakeTailScale);
    gl.uniform1f(
      h.uUseFeatureWidth,
      cache.widthBuffer && h.aWidth >= 0 ? 1 : 0,
    );

    const fu = resolveDataFilterUniforms(
      this.filterUniforms,
      this.filterOpts,
      cache.hasFilterColumn && !!cache.filterBuffer && h.aFilterValue >= 0,
    );
    gl.uniform2fv(h.uFilterRange, fu.range);
    gl.uniform2fv(h.uFilterSoftRange, fu.softRange);
    gl.uniform1f(h.uFilterEnabled, fu.enabled);
    gl.uniform1f(h.uFilterTransformSize, fu.transformSize);
    gl.uniform1f(h.uFilterTransformColor, fu.transformColor);
  }

  /**
   * Bind the per-instance geometry attributes both passes share. Runs inside
   * the VAO recording scope on the visual path and raw on the pick path.
   */
  private bindGeometryAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TripsCommonHandles,
    c: TripsGpuCache,
    quad: WebGLBuffer,
  ): void {
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

    if (c.widthBuffer && h.aWidth >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.widthBuffer);
      gl.enableVertexAttribArray(h.aWidth);
      gl.vertexAttribPointer(h.aWidth, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aWidth, 1);
    }
    // Unbound when the tile lacks the column: the generic attribute reads 0 and
    // uFilterEnabled is resolved to 0, so the tile renders unfiltered.
    if (c.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 1);
    }
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const mode = this.resolveTimeMode();
    if (mode === 'off') return; // empty time window ⇒ nothing to draw
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const c = cache as TripsGpuCache;
    const h = this.getHandles(gl, frame, mode);

    this.setCommonUniforms(gl, h, c, tile, ctx, frame);
    gl.uniform4fv(h.uColor, toRgba01(this.tripsOpts.color));
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);

    // The VAO records attribute locations belonging to ONE program; a host
    // variant flip or a time-mode flip relinked, so a stale recording must be
    // rebuilt against the program actually in use.
    if (c.vao && c.vaoProgram !== h.program) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    c.vaoProgram = h.program;

    const quad = this.getUnitQuad(gl);
    this.bindVaoOrSetup(c, () => {
      this.bindGeometryAttributes(gl, h, c, quad);
      if (c.colorBuffer && h.aColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
        gl.enableVertexAttribArray(h.aColor);
        gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        this.instSupport.vertexAttribDivisor(h.aColor, 1);
      }
    });

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );
  }

  /**
   * Per-INSTANCE id colours: feature `fi` owns `idBase + fi` (the base
   * provenance allocation) and paints every segment it contributed. Rebuilt per
   * pick — `idBase` shifts with whatever tiles are resident this frame.
   *
   * `featureCount` is the width the base RESERVED for this (tile, layer); any
   * geometry past it stays id 0 (background) rather than borrowing the next
   * entry's ids and mis-resolving the pick.
   */
  private buildInstanceIdColors(
    c: TripsGpuCache,
    idBase: number,
    featureCount: number,
  ): Uint8Array {
    const idCount = Math.min(c.segmentCounts.length, featureCount);
    return expandPickIdColors(
      this.buildPickIdColors(idCount, idBase),
      c.segmentCounts,
      c.instanceCount,
    );
  }

  /**
   * Draw this trips tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)`. Same projection variant, same quad
   * expansion, same time-mode and column-filter gates as {@link drawTile}, so
   * anything the user cannot see is not pickable either. Browser-verify-only
   * (the enclosing FBO round-trip needs a live GPU); the id-colour build and
   * the decode join are unit-tested.
   *
   * Raw attribute binds, no VAO: the id buffer is per-pass (freed at the end)
   * and picking is a rare user-initiated event, so a cached VAO would only go
   * stale. The base unbinds any VAO at the end of every render pass, so these
   * binds land on the default vertex array.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const mode = this.resolveTimeMode();
    if (mode === 'off') return; // invisible ⇒ unpickable
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const c = cache as TripsGpuCache;
    const h = this.getIdHandles(gl, frame, mode);

    const idBuffer = this.uploadArrayBuffer(
      gl,
      this.buildInstanceIdColors(c, idBase, layer.features.featureCount),
    );
    this.setCommonUniforms(gl, h, c, tile, ctx, frame);

    const quad = this.getUnitQuad(gl);
    this.bindGeometryAttributes(gl, h, c, quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aIdColor, 1);

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );

    // Leave the default-VAO attribute slate clean for the next visual frame's
    // VAO recording, and drop the one-shot id buffer. Divisors are per-VAO
    // state that SURVIVES disableVertexAttribArray, so every per-instance slot
    // goes back to 0 too — otherwise a non-instanced draw landing on the same
    // location (a sibling layer's fill pass on a runtime without VAOs) would
    // read element 0 for every vertex and collapse to a degenerate triangle.
    for (const loc of [
      h.aCorner,
      h.aPosA,
      h.aPosB,
      h.aVertexTimeAB,
      h.aIdColor,
      h.aWidth,
      h.aFilterValue,
    ]) {
      if (loc < 0) continue;
      this.instSupport.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
    gl.deleteBuffer(idBuffer);
  }
}
