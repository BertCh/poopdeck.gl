/**
 * Line geometry adapter — renders LINESTRING-type tiles as screen-space thick
 * lines (constant pixel width across zoom, or metres-at-latitude when
 * `widthUnits: 'meters'`).
 *
 * Each segment is drawn as a single *instance* of a shared 4-vertex unit quad.
 * Per-instance attributes carry the segment endpoints, times, and (optional)
 * per-feature colour / width / filter value. This replaces the legacy CPU-side
 * 4×-expansion pass: the same N segments now occupy 1/4 the GPU memory and skip
 * the per-frame walk that copied positions into corner-major buffers.
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
 *
 * Wave M2 adds three orthogonal axes, all defaulting to the historical
 * behaviour (an app that sets none of them renders exactly as before):
 *   - **time modes** — `timeFilterMode` selects one of the four
 *     `shaders/time-window.glsl.ts` kernels at PROGRAM-BUILD time (there is no
 *     mode uniform); the mode is part of the program cache key.
 *   - **DataFilter** — the `shaders/data-filter.glsl.ts` kernel, compiled in
 *     only when a `filterProperty` is named, with the per-FEATURE column
 *     expanded across the segments each feature contributed.
 *   - **metric sizing** — `widthUnits: 'meters'` resolves the metres→device-px
 *     factor per tile (tile-centre latitude, fractional map zoom) and folds it
 *     into the width scale, so no shader branch is needed.
 * Picking (campaign D11) reuses the SAME vertex source through a `pick: true`
 * variant, so the id pass extrudes the identical screen-space quad the visual
 * pass drew and honours the identical time/filter gates.
 */

import type { Tile, Layer as STTLayer } from '@poopdeck.gl/core';
import { synthesizeVertexTimes } from '@poopdeck.gl/core/trips';
import {
  GeometryType,
  DEFAULT_LINE_PALETTE as CORE_LINE_PALETTE,
} from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTBaseLayer,
  expandPickIdColors,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from '../base-layer.js';
import {
  lngLatToMercator,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../lib/projection.js';
import { subdivideLineMercator } from '../lib/globe.js';
import { createHostFrame, type HostFrame } from '../lib/host-adapter.js';
import {
  TIME_WINDOW_GLSL,
  TIME_TRAIL_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
} from '../shaders/time-window.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_UNIFORMS_GLSL,
  createDataFilterUniforms,
  expandFilterValues,
  extractFilterColumn,
  resolveDataFilterUniforms,
  type DataFilterRange,
  type DataFilterUniforms,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';

// Shared with @poopdeck.gl/layers AnimatedPathLayer (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_LINE_PALETTE: ReadonlyArray<RGBA8> = CORE_LINE_PALETTE;

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's historical name.
 */
export type STTLineTimeFilterMode = STTTimeFilterMode;

export interface STTLineLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /** Line color as [r, g, b, a] in the 0–1 range. Ignored when `colorProperty` is set. */
  color?: [number, number, number, number];
  /** Line width, in `widthUnits`. Ignored when `widthProperty` is set. */
  width?: number;
  /** Optional multiplier applied to per-feature widths. */
  widthScale?: number;
  /**
   * Unit `width` / `widthProperty` values are expressed in. `'pixels'` (the
   * default) keeps the historical constant-on-screen width; `'meters'` sizes
   * the line on the ground, resolved per tile at the tile's centre latitude
   * and the map's fractional zoom (deck `widthUnits` parity).
   *
   * The quad is still extruded in SCREEN space from one per-draw factor, so a
   * metric width is constant-on-screen within a tile: under pitch, geometry
   * near the horizon keeps its tile-centre width instead of shrinking with
   * depth. Correct at the tile scale, approximate across a tilted tile.
   */
  widthUnits?: 'pixels' | 'meters';
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
  /** Drive per-feature width (in `widthUnits`) from a numeric property name. */
  widthProperty?: string;
  /**
   * Which temporal filter the shader applies. Defaults to `'window'` — the
   * historical behaviour, driven by `timeWindow` + the fade durations.
   *
   *   - `'window'` — lit while `[startTime, endTime]` overlaps the window.
   *   - `'wake'` — lit for {@link wakeLength} ms after `startTime`, fading AND
   *     narrowing toward {@link wakeTailScale} at the tail.
   *   - `'cumulative'` — appears at `startTime` and persists (draw-and-persist),
   *     with `fadeInDuration` as the appear ramp. CALLER OBLIGATION (the same
   *     one deck's `TimeFilterExtension` states): the shader does the reveal,
   *     the loader does not, so `timeWindow` must be wide enough to cover the
   *     played-through range or already-revealed tiles are evicted and the
   *     layer un-draws itself as playback advances.
   *   - `'trail'` — per-VERTEX reveal along each path (progressive drawing),
   *     using baked `vertexTimestamps` when the tile has them and the shared
   *     `synthesizeVertexTimes` kernel (cumulative-distance interpolation)
   *     when it does not.
   *
   * `'wake'`/`'trail'` with a non-positive length knob degrade to `'window'`,
   * matching deck (whose extension enters those branches only for a positive
   * length and otherwise falls through to the window branch).
   *
   * The mode is a compile-time shader choice, so switching it relinks one
   * program per host variant; `'trail'` additionally rebuilds tile caches (it
   * is the only mode needing per-vertex times).
   */
  timeFilterMode?: STTLineTimeFilterMode;
  /**
   * Wake length in ms (`'wake'` mode). Defaults to HALF the layer's
   * `timeWindow`, which is the widest wake the loading window actually covers
   * (deck's `timeWindow >= 2 * wakeLength` rule) — so selecting the mode alone
   * never yields a blank layer. The default TRACKS `setTimeWindow`; an
   * explicit value is the caller's and is never re-derived.
   */
  wakeLength?: number;
  /** Trailing-edge width multiplier in wake mode (0..1). Defaults to core's 0.15. */
  wakeTailScale?: number;
  /**
   * Trail length in ms (`'trail'` mode). Defaults to half the layer's
   * `timeWindow` and tracks `setTimeWindow` the same way {@link wakeLength}
   * does. An explicit non-positive value degrades the mode to `'window'`.
   */
  trailLength?: number;
  /**
   * Trail head→tail fade: `1`/`true` (default) is the classic comet, `0`/`false`
   * a solid snake, intermediate numbers blend between them (package-wide
   * `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
}

// The instanced VS reads (side, along) ∈ {-1,1} × {0,1} from the unit-quad
// vertex attribute, then picks the segment endpoint and perpendicular offset.
// `aPosA`/`aPosB` are the *segment endpoints*, not the 4 corners; the 4×
// expansion happens in the GPU rasterizer — we're removing the redundant CPU
// broadcast that the v0.2 layer was doing on every tile load.

/** Kernel snippet compiled in per time mode (exactly one per program). */
const MODE_KERNEL: Record<STTLineTimeFilterMode, string> = {
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
};

/** Per-mode time attribute: trail is the only per-VERTEX mode. */
const MODE_TIME_ATTRIBUTE: Record<STTLineTimeFilterMode, string> = {
  window:
    '  attribute vec2 aTime;        // [startTime, endTime], per-instance',
  wake: '  attribute vec2 aTime;        // [startTime, endTime], per-instance',
  cumulative:
    '  attribute vec2 aTime;        // [startTime, endTime], per-instance',
  trail:
    '  attribute vec2 aVertexTimeAB; // [timeA, timeB], per-instance, tile-relative',
};

const MODE_UNIFORMS: Record<STTLineTimeFilterMode, string> = {
  window: `  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;`,
  wake: `  uniform float uCurrentTime;
  uniform float uWakeLength;
  uniform float uWakeTailScale;`,
  cumulative: `  uniform float uCurrentTime;
  uniform float uFadeIn;`,
  trail: `  uniform float uCurrentTime;
  uniform float uTrailLength;
  uniform float uFadeTrail;`,
};

const MODE_ALPHA: Record<STTLineTimeFilterMode, string> = {
  window:
    'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
  wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
  cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
  // The segment's two endpoint times interpolate with the quad's `along`
  // coordinate, so the reveal front crosses a segment continuously.
  trail:
    'sttTrailAlpha(mix(aVertexTimeAB.x, aVertexTimeAB.y, aCorner.y), uCurrentTime, uTrailLength, uFadeTrail)',
};

/** Compile-time shader configuration — every field is part of the cache key. */
export interface LineVertexVariant {
  /** Active time-filter mode. Defaults to `'window'`. */
  mode?: STTLineTimeFilterMode;
  /** Compile the DataFilter branch in (only when a `filterProperty` is named). */
  filter?: boolean;
  /** Emit the flat id-colour pick pass instead of the visual one. */
  pick?: boolean;
}

/**
 * Variant-aware vertex source (D3/D8/D11). An empty `prelude` yields the legacy
 * `uMatrix` shader (maplibre ≤v4 / mapbox — behaviour-identical to the
 * pre-campaign shader whenever the new knobs are left at their defaults); a v5+
 * host's prelude + define are prepended (maplibre's documented injection order)
 * and BOTH segment endpoints project through its `projectTile(vec2)`.
 * projectTile overwrites z for horizon clipping — correct for this 2d
 * screen-space quad; the NDC extrusion math is identical across variants.
 *
 * The pick pass shares this builder rather than forking a second copy of the
 * extrusion math: a hit box that drifted from the drawn quad is exactly the
 * bug an id-buffer picker cannot detect from the CPU side.
 */
export function buildLineVertexSource(
  shader: {
    prelude: string;
    define: string;
  },
  variant: LineVertexVariant = {},
): string {
  const mode = variant.mode ?? 'window';
  const pick = variant.pick === true;
  const filter = variant.filter === true;
  const v5 = shader.prelude.length > 0;
  const header = v5 ? `${shader.prelude}\n${shader.define}` : '';
  const matrixDecl = v5 ? '' : 'uniform mat4 uMatrix;\n  ';
  const projectHere = v5
    ? 'projectTile(posM)'
    : 'uMatrix * vec4(posM, 0.0, 1.0)';
  const projectThere = v5
    ? 'projectTile(neighborM)'
    : 'uMatrix * vec4(neighborM, 0.0, 1.0)';
  const colorDecls = pick
    ? `  attribute vec3 aIdColor;     // per-feature encoded id (UNSIGNED_BYTE normalized)
  varying vec3 vIdColor;`
    : `  attribute vec4 aColor;       // per-feature RGBA (when uUseFeatureColor=1)
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
  varying vec4 vColor;`;
  const colorAssign = pick
    ? 'vIdColor = aIdColor;'
    : 'vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;';
  // Wake shrinks the tail with the SAME alpha the kernel returned, so the
  // narrowing and the fade cannot drift apart.
  const wakeSize =
    mode === 'wake' ? ' * sttWakeSizeScale(timeAlpha, uWakeTailScale)' : '';
  return `${header}
  precision highp float;
  attribute vec2 aCorner;      // (side, along) ∈ {-1,1} × {0,1}, per-vertex
  attribute vec2 aPosA;        // segment start, per-instance
  attribute vec2 aPosB;        // segment end, per-instance
${MODE_TIME_ATTRIBUTE[mode]}
  attribute float aWidth;      // per-feature width (when uUseFeatureWidth=1)
${colorDecls}
${filter ? DATA_FILTER_ATTRIBUTE_GLSL.trimEnd() : ''}
  ${matrixDecl}uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uUseFeatureWidth;
${MODE_UNIFORMS[mode]}
${filter ? DATA_FILTER_UNIFORMS_GLSL.trimEnd() : ''}
  varying float vAlpha;
${MODE_KERNEL[mode]}${filter ? DATA_FILTER_GLSL : ''}
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
    float timeAlpha = ${MODE_ALPHA[mode]};
${filter ? `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};\n` : ''}    float widthPx = (uUseFeatureWidth > 0.5 ? aWidth : uWidth) * uWidthScale${wakeSize};
${filter ? '    if (uFilterTransformSize > 0.5) widthPx *= filterAlpha;\n' : ''}    vec2 offsetPx = perp * aCorner.x * widthPx * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;
${
  filter
    ? `    // deck's vs:#main-end collapse. Keyed on the FILTER factor only —
    // that one is per-FEATURE, so the whole feature collapses; the time alpha
    // varies per vertex in trail mode and would strand one end at the origin.
    if (filterAlpha <= 0.0) gl_Position = vec4(0.0);
    float filterMask = (uFilterTransformColor > 0.5)
      ? filterAlpha
      : (filterAlpha > 0.0 ? 1.0 : 0.0);
    vAlpha = timeAlpha * filterMask;
`
    : '    vAlpha = timeAlpha;\n'
}    ${colorAssign}
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

// Id-pick fragment stage: the readback must recover the byte triple exactly,
// so the id colour is written flat and opaque with no blending or coverage
// term. The `vAlpha` discard is what makes time-filtered / range-filtered
// geometry unpickable rather than an invisible hit box.
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

interface LineProgramHandles {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  /** -1 in trail mode (that program reads `aVertexTimeAB` instead). */
  aTime: number;
  /** -1 outside trail mode. */
  aVertexTimeAB: number;
  aColor: number;
  aWidth: number;
  /** -1 on the visual variants. */
  aIdColor: number;
  /** -1 unless the DataFilter branch was compiled in. */
  aFilterValue: number;
  /** null on prelude-built variants (they project via `u_projection_*`). */
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uUseFeatureWidth: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  // Mode uniforms: only the active mode's are non-null.
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uWakeLength: WebGLUniformLocation | null;
  uWakeTailScale: WebGLUniformLocation | null;
  uTrailLength: WebGLUniformLocation | null;
  uFadeTrail: WebGLUniformLocation | null;
  // DataFilter uniforms: null unless the branch was compiled in.
  uFilterRange: WebGLUniformLocation | null;
  uFilterSoftRange: WebGLUniformLocation | null;
  uFilterEnabled: WebGLUniformLocation | null;
  uFilterTransformSize: WebGLUniformLocation | null;
  uFilterTransformColor: WebGLUniformLocation | null;
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
  /** Per-instance [timeA, timeB]; built in trail mode only. */
  vertexTimeBuffer?: WebGLBuffer;
  /** Per-instance filter value; absent when the tile lacks the column. */
  filterBuffer?: WebGLBuffer;
  /** Third argument to `resolveDataFilterUniforms` for THIS tile. */
  hasFilterColumn: boolean;
  /** Feature count this cache was built from (= id-space size for picking). */
  featureCount: number;
  /** Segments contributed per feature — the expansion map for ids and filters. */
  featureSegmentCounts: Uint32Array;
  /**
   * Shader variant the cached VAO's attribute locations were recorded
   * against. A variant flip may relocate attributes, so a mismatched VAO is
   * dropped and re-recorded (buffers stay valid).
   */
  vaoVariant?: string;
  /** Time mode the cached VAO was recorded against (a different program). */
  vaoMode?: STTLineTimeFilterMode;
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
    widthUnits: 'pixels' | 'meters';
    colorProperty?: string;
    widthProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    timeFilterMode: STTLineTimeFilterMode;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
    filterProperty?: string;
    filterRange?: DataFilterRange | null;
    filterSoftRange?: DataFilterRange | null;
    filterEnabled?: boolean;
    filterTransformSize?: boolean;
    filterTransformColor?: boolean;
  };
  /**
   * Globe frames need subdivided tile geometry, but the base render loop
   * resolves caches before drawTile ever sees the frame — beginFrame stashes
   * the flag so ensure/buildTileGpuCache key and build for the CURRENT
   * projection. Also read by the pick path (a pick follows a render).
   */
  private frameIsGlobe = false;
  /**
   * Per-draw DataFilter uniform payload, allocated ONCE: `resolveDataFilterUniforms`
   * refills it in place so the hot path allocates nothing.
   */
  private readonly filterUniforms: DataFilterUniforms =
    createDataFilterUniforms();
  /** A named `filterProperty` is what compiles the filter branch into the shaders. */
  private readonly filterCompiled: boolean;
  /** Categorical columns aren't range-filterable; warn once, render unfiltered. */
  private warnedCategoricalFilter = false;
  /**
   * Tail lengths AS PASSED (undefined ⇒ defaulted off `timeWindow`), and the
   * mode as REQUESTED — `lineOpts.timeFilterMode` holds the DEGRADED one.
   * Together these let {@link resolveTimeConfig} re-derive both after a
   * `setTimeWindow` without ever overwriting a caller's explicit value.
   */
  private readonly wakeLengthOpt?: number;
  private readonly trailLengthOpt?: number;
  private requestedMode: STTLineTimeFilterMode;
  /**
   * Program-cache keys, `line[:pick]:<mode>[:filter]`. The mode and filter axes
   * are the only ones this layer owns (the base appends the host variant), so
   * both are rebuilt on a mode flip — never per tile per frame.
   */
  private mainProgramKey = '';
  private pickProgramKey = '';
  /** Reused {@link LineVertexVariant} — the source builder reads it and never retains it. */
  private readonly variantScratch: LineVertexVariant = {
    mode: 'window',
    filter: false,
    pick: false,
  };

  constructor(opts: STTLineLayerOptions) {
    super(opts);
    // Wake/trail lengths default to the trailing half of the loading window:
    // the widest tail the tiles actually cover (deck's `timeWindow >= 2 *
    // wakeLength` rule), so selecting a mode alone can never blank the layer.
    // Kept as OPTIONS, not a snapshot — `setTimeWindow` re-derives the
    // defaulted ones (see `setTimeWindow`), or the shader would keep lighting
    // features for a tail the loader no longer covers.
    this.wakeLengthOpt = opts.wakeLength;
    this.trailLengthOpt = opts.trailLength;
    this.requestedMode = opts.timeFilterMode ?? 'window';
    const halfWindow = Math.max(0, opts.timeWindow / 2);
    this.lineOpts = {
      color: opts.color ?? [0.31, 0.76, 0.97, 1.0],
      width: opts.width ?? 2,
      widthScale: opts.widthScale ?? 1,
      widthUnits: opts.widthUnits ?? 'pixels',
      colorProperty: opts.colorProperty,
      widthProperty: opts.widthProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_LINE_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      // Placeholder — `resolveTimeConfig()` below owns all three.
      timeFilterMode: 'window',
      wakeLength: opts.wakeLength ?? halfWindow,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? halfWindow,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
      filterProperty: opts.filterProperty,
      filterRange: opts.filterRange,
      filterSoftRange: opts.filterSoftRange,
      filterEnabled: opts.filterEnabled,
      filterTransformSize: opts.filterTransformSize,
      filterTransformColor: opts.filterTransformColor,
    };
    this.filterCompiled = !!opts.filterProperty;
    this.resolveTimeConfig();
    this.rebuildProgramKeys();
  }

  /**
   * Re-derive the defaulted tail lengths from the CURRENT `timeWindow` and the
   * compiled mode from those lengths. Returns true when the compiled mode
   * moved, so callers know whether a relink/rebuild is due.
   *
   * The degrade rule is deck's: `TimeFilterExtension` enters its wake branch
   * only for `wakeLength > 0` and its trail branch only for `trailLength > 0`,
   * otherwise falling through to the window branch. Both degenerate kernels
   * here return 0 (shaders/time-window.glsl.ts), so a mode kept in that state
   * would draw nothing at all.
   */
  private resolveTimeConfig(): boolean {
    const half = Math.max(0, this.opts.timeWindow / 2);
    const wake = this.wakeLengthOpt ?? half;
    const trail = this.trailLengthOpt ?? half;
    this.lineOpts.wakeLength = wake;
    this.lineOpts.trailLength = trail;
    const requested = this.requestedMode;
    const resolved =
      (requested === 'wake' && !(wake > 0)) ||
      (requested === 'trail' && !(trail > 0))
        ? 'window'
        : requested;
    const changed = this.lineOpts.timeFilterMode !== resolved;
    this.lineOpts.timeFilterMode = resolved;
    return changed;
  }

  /**
   * Widen/narrow the loading window. Overridden because the defaulted
   * `wakeLength`/`trailLength` are DERIVED from it: leaving them behind would
   * light features for a tail the loader no longer covers (or a tail far
   * shorter than the data it now pays for).
   */
  setTimeWindow(ms: number): void {
    super.setTimeWindow(ms);
    const prev = this.lineOpts.timeFilterMode;
    if (!this.resolveTimeConfig()) return;
    this.rebuildProgramKeys();
    if (prev === 'trail' || this.lineOpts.timeFilterMode === 'trail') {
      this.rebuildTileCaches();
    }
  }

  /** See {@link mainProgramKey}. */
  private rebuildProgramKeys(): void {
    const tail = `${this.lineOpts.timeFilterMode}${this.filterCompiled ? ':filter' : ''}`;
    this.mainProgramKey = `line:${tail}`;
    this.pickProgramKey = `line:pick:${tail}`;
  }

  setColor(color: [number, number, number, number]): void {
    this.lineOpts.color = color;
    this.map?.triggerRepaint();
  }

  setWidth(width: number): void {
    this.lineOpts.width = width;
    this.map?.triggerRepaint();
  }

  /**
   * Switch the temporal filter. Relinks one program per host variant (the mode
   * is compiled in) and, when trail-ness flips, rebuilds the tile caches —
   * per-vertex times are only baked for trail mode.
   */
  setTimeFilterMode(mode: STTLineTimeFilterMode): void {
    if (this.requestedMode === mode) return;
    this.requestedMode = mode;
    const prev = this.lineOpts.timeFilterMode;
    if (!this.resolveTimeConfig()) return;
    this.rebuildProgramKeys();
    if (prev === 'trail' || this.lineOpts.timeFilterMode === 'trail') {
      this.rebuildTileCaches();
      return;
    }
    this.map?.triggerRepaint();
  }

  /**
   * Move the DataFilter bounds (the slider path). Uniform-only — no relink, no
   * tile rebuild — so it is safe to call every animation frame.
   */
  setFilterRange(range: DataFilterRange | null): void {
    this.lineOpts.filterRange = range;
    this.map?.triggerRepaint();
  }

  /** Move the DataFilter's soft fade margin. Uniform-only, like `setFilterRange`. */
  setFilterSoftRange(range: DataFilterRange | null): void {
    this.lineOpts.filterSoftRange = range;
    this.map?.triggerRepaint();
  }

  /** Toggle the DataFilter off (everything renders) / on. Uniform-only. */
  setFilterEnabled(enabled: boolean): void {
    this.lineOpts.filterEnabled = enabled;
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

  /**
   * Fetch (or link) the program for this frame's host variant, the active time
   * mode and this pass (visual / id). The base cache appends the host variant
   * name, so the mode + pass + filter axes must all be in OUR key or two
   * different programs would collide on one entry.
   */
  private programFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    pick: boolean,
  ): LineProgramHandles {
    // Both halves are per-layer constants (rebuilt only on a mode flip), so
    // this runs once per tile per frame WITHOUT allocating.
    const key = pick ? this.pickProgramKey : this.mainProgramKey;
    return this.getOrCreateProgram(gl, key, frame, (glc, shader) => {
      const variant = this.variantScratch;
      variant.mode = this.lineOpts.timeFilterMode;
      variant.filter = this.filterCompiled;
      variant.pick = pick;
      const program = this.linkProgram(
        glc,
        buildLineVertexSource(shader, variant),
        pick ? ID_FS_SOURCE : FS_SOURCE,
      );
      return {
        program,
        aCorner: glc.getAttribLocation(program, 'aCorner'),
        aPosA: glc.getAttribLocation(program, 'aPosA'),
        aPosB: glc.getAttribLocation(program, 'aPosB'),
        aTime: glc.getAttribLocation(program, 'aTime'),
        aVertexTimeAB: glc.getAttribLocation(program, 'aVertexTimeAB'),
        aColor: glc.getAttribLocation(program, 'aColor'),
        aWidth: glc.getAttribLocation(program, 'aWidth'),
        aIdColor: glc.getAttribLocation(program, 'aIdColor'),
        aFilterValue: glc.getAttribLocation(program, 'aFilterValue'),
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
        uCurrentTime: glc.getUniformLocation(program, 'uCurrentTime'),
        uWakeLength: glc.getUniformLocation(program, 'uWakeLength'),
        uWakeTailScale: glc.getUniformLocation(program, 'uWakeTailScale'),
        uTrailLength: glc.getUniformLocation(program, 'uTrailLength'),
        uFadeTrail: glc.getUniformLocation(program, 'uFadeTrail'),
        uFilterRange: glc.getUniformLocation(program, 'uFilterRange'),
        uFilterSoftRange: glc.getUniformLocation(program, 'uFilterSoftRange'),
        uFilterEnabled: glc.getUniformLocation(program, 'uFilterEnabled'),
        uFilterTransformSize: glc.getUniformLocation(
          program,
          'uFilterTransformSize',
        ),
        uFilterTransformColor: glc.getUniformLocation(
          program,
          'uFilterTransformColor',
        ),
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
    // Per-vertex times are trail mode's input and nothing else's — bake them
    // only for that mode (setTimeFilterMode rebuilds caches when it flips).
    const wantsVertexTimes = this.lineOpts.timeFilterMode === 'trail';
    const hasVertexTimestamps =
      !!f.vertexTimestamps && f.vertexTimestamps.length > 0;
    // Tiles without a baked `vertex_time` column get the SHARED synthesis
    // kernel, which spreads [startTime, endTime] by cumulative haversine
    // DISTANCE — the same thing three/deck do and the same thing the Rust
    // producer's `interpolate_vertex_times` bakes. Interpolating by vertex
    // INDEX instead makes a single long edge advance at the same rate as a
    // 100 m urban stub, which is the "flash" the deck side already fixed.
    // One call per tile (it walks every feature), not one per feature.
    const synthesizedTimes =
      wantsVertexTimes && !hasVertexTimestamps
        ? synthesizeVertexTimes(f)
        : null;

    // Pass 1: project each feature's polyline to mercator (subdividing on
    // globe) so segment counts are known before the per-instance buffers are
    // allocated. Times / colors / widths are per-FEATURE constants — only
    // positions and (trail) per-vertex times interpolate. Tile-upload time
    // only, never per frame.
    const polylines: Float64Array[] = new Array(featureCount);
    const vertexTimes: (Float32Array | null)[] = new Array(featureCount);
    // Indexed by ORIGINAL feature index (0 for degenerate 1-vertex features),
    // so picking's id expansion and the filter expansion stay joined to the
    // feature order `getFeatureProperties` uses.
    const segCounts = new Uint32Array(featureCount);
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
      let times: Float32Array | null = null;
      if (wantsVertexTimes) {
        const src = hasVertexTimestamps
          ? f.vertexTimestamps!
          : synthesizedTimes!;
        times = new Float32Array(count);
        for (let v = 0; v < count; v++) times[v] = src[begin + v];
      }
      if (granularity > 0) {
        const sub = subdivideLineMercator(
          merc,
          granularity,
          times ? { arrays: [times], components: [1] } : undefined,
        );
        merc = sub.positions;
        // Interpolated in lock-step so the reveal keeps its linear time map.
        if (times) times = sub.attrs!.arrays[0] as Float32Array;
      }
      polylines[fi] = merc;
      vertexTimes[fi] = times;
      const segs = merc.length >= 4 ? merc.length / 2 - 1 : 0;
      segCounts[fi] = segs;
      segmentCount += segs;
    }
    if (segmentCount === 0) return null;

    // Per-instance buffers — one row per segment, not per quad corner. This
    // is the core memory win vs. v0.2: 4× less data uploaded per tile and no
    // main-thread expansion pass.
    const posA = new Float32Array(segmentCount * 2);
    const posB = new Float32Array(segmentCount * 2);
    const times = new Float32Array(segmentCount * 2);
    const vTimeAB = wantsVertexTimes
      ? new Float32Array(segmentCount * 2)
      : null;

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
      const segs = segCounts[fi];
      const vt = vertexTimes[fi];
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
        if (vTimeAB && vt) {
          vTimeAB[s * 2] = vt[v];
          vTimeAB[s * 2 + 1] = vt[v + 1];
        }
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

    // Range filter: a per-FEATURE column expanded across the segments each
    // feature contributed. A missing / categorical column resolves to
    // `hasFilterColumn: false`, which the uniform resolver turns into
    // `enabled: 0` — an UNFILTERED tile, never a blank one.
    const filterColumn = extractFilterColumn(f, this.lineOpts.filterProperty);
    if (filterColumn.categorical && !this.warnedCategoricalFilter) {
      this.warnedCategoricalFilter = true;
      console.warn(
        `[${this.id}] filterProperty '${this.lineOpts.filterProperty}' is a ` +
          `categorical column; range filtering needs a numeric one — rendering unfiltered.`,
      );
    }
    const filterAttr = filterColumn.values
      ? expandFilterValues(filterColumn.values, segCounts, segmentCount)
      : null;

    const posABuffer = this.uploadArrayBuffer(gl, posA);
    const posBBuffer = this.uploadArrayBuffer(gl, posB);
    const timeBuffer = this.uploadArrayBuffer(gl, times);
    // The base TileGpuCache type expects `positionBuffer`. We keep posA there
    // (the "primary" data) so the inherited cleanup walks delete it.
    const positionBuffer = posABuffer;

    const extras: WebGLBuffer[] = [posBBuffer];
    let colorBuffer: WebGLBuffer | undefined;
    let widthBuffer: WebGLBuffer | undefined;
    let vertexTimeBuffer: WebGLBuffer | undefined;
    let filterBuffer: WebGLBuffer | undefined;
    if (vTimeAB) {
      vertexTimeBuffer = this.uploadArrayBuffer(gl, vTimeAB);
      extras.push(vertexTimeBuffer);
    }
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
      vertexTimeBuffer,
      filterBuffer,
      hasFilterColumn: filterColumn.hasColumn,
      featureCount,
      featureSegmentCounts: segCounts,
    };
  }

  /**
   * The `uWidthScale` uniform for one tile. In `'pixels'` it is the raw option;
   * in `'meters'` it additionally carries metres→device-px at the TILE's centre
   * latitude and the map's FRACTIONAL zoom (`ctx.zoom` is floored, which would
   * make metric widths jump a factor of 2 per zoom level). Folding the factor
   * into the scale keeps both the constant `uWidth` and the per-feature
   * `aWidth` metric with no extra uniform or shader branch.
   */
  private widthScaleFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { widthScale, widthUnits } = this.lineOpts;
    if (widthUnits !== 'meters') return widthScale;
    // Frame-hoisted (beginFrame); the live getter is the fallback for draws
    // issued outside a render pass, and ctx.zoom (floored) the last resort.
    const zoom = this.frameZoom ?? this.map?.getZoom() ?? ctx.zoom;
    const lat = tileCenterLatitude(tile.id.z, tile.id.y);
    return (
      widthScale *
      metersToPixelsAtLatitude(
        1,
        lat,
        zoom,
        512 * this.resolveDevicePixelRatio(gl),
      )
    );
  }

  /** Upload the active mode's time uniforms (only those exist in the program). */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: LineProgramHandles,
    cache: LineGpuCache,
    ctx: DrawContext,
  ): void {
    // Tile-relative, the convention every time kernel here compares in.
    const relTime = ctx.currentTime - cache.timeOffset;
    switch (this.lineOpts.timeFilterMode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uWakeLength, this.lineOpts.wakeLength);
        gl.uniform1f(h.uWakeTailScale, this.lineOpts.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uTrailLength, this.lineOpts.trailLength);
        gl.uniform1f(h.uFadeTrail, this.lineOpts.fadeTrail);
        break;
      default: {
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  /**
   * Upload the DataFilter uniforms for one tile. No-op unless a
   * `filterProperty` compiled the branch in. The vec2 pairs go up as
   * `uniform2fv` (the kernel's documented form, shared by all five kinds) so
   * the `Float32Array` payload is uploaded without unpacking.
   */
  private setFilterUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: LineProgramHandles,
    cache: LineGpuCache,
  ): void {
    if (!this.filterCompiled) return;
    const u = resolveDataFilterUniforms(
      this.filterUniforms,
      this.lineOpts,
      cache.hasFilterColumn,
    );
    gl.uniform2fv(h.uFilterRange, u.range);
    gl.uniform2fv(h.uFilterSoftRange, u.softRange);
    gl.uniform1f(h.uFilterEnabled, u.enabled);
    gl.uniform1f(h.uFilterTransformSize, u.transformSize);
    gl.uniform1f(h.uFilterTransformColor, u.transformColor);
  }

  /**
   * Bind the per-instance attributes shared by the visual and id passes. The
   * time attribute is mode-dependent (`aVertexTimeAB` in trail mode); colour /
   * width / filter bind only when the tile carries that buffer AND the program
   * kept the attribute.
   */
  private bindInstanceAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: LineProgramHandles,
    c: LineGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, c.posABuffer);
    gl.enableVertexAttribArray(h.aPosA);
    gl.vertexAttribPointer(h.aPosA, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aPosA, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.posBBuffer);
    gl.enableVertexAttribArray(h.aPosB);
    gl.vertexAttribPointer(h.aPosB, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aPosB, 1);

    if (this.lineOpts.timeFilterMode === 'trail') {
      if (c.vertexTimeBuffer && h.aVertexTimeAB >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.vertexTimeBuffer);
        gl.enableVertexAttribArray(h.aVertexTimeAB);
        gl.vertexAttribPointer(h.aVertexTimeAB, 2, gl.FLOAT, false, 0, 0);
        this.instSupport.vertexAttribDivisor(h.aVertexTimeAB, 1);
      }
    } else if (h.aTime >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
      gl.enableVertexAttribArray(h.aTime);
      gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aTime, 1);
    }

    if (c.widthBuffer && h.aWidth >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.widthBuffer);
      gl.enableVertexAttribArray(h.aWidth);
      gl.vertexAttribPointer(h.aWidth, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aWidth, 1);
    }
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
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const h = this.programFor(gl, frame, false);
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
    gl.uniform1f(h.uWidthScale, this.widthScaleFor(gl, tile, ctx));
    gl.uniform4fv(h.uColor, toRgba01(this.lineOpts.color));
    this.setTimeUniforms(gl, h, c, ctx);
    this.setFilterUniforms(gl, h, c);
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);
    gl.uniform1f(h.uUseFeatureWidth, c.widthBuffer && h.aWidth >= 0 ? 1 : 0);

    // A VAO records attribute LOCATIONS of the program it was built against —
    // a variant OR mode flip may relocate them (a different program either
    // way), so a mismatched VAO is re-recorded (the buffers stay valid).
    if (
      c.vao &&
      (c.vaoVariant !== frame.shader.variantName ||
        c.vaoMode !== this.lineOpts.timeFilterMode)
    ) {
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
      this.bindInstanceAttributes(gl, h, c);

      if (c.colorBuffer && h.aColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
        gl.enableVertexAttribArray(h.aColor);
        gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        this.instSupport.vertexAttribDivisor(h.aColor, 1);
      }
    });
    c.vaoVariant = frame.shader.variantName;
    c.vaoMode = this.lineOpts.timeFilterMode;

    // 4 verts per quad × N segment instances, drawn as TRIANGLE_STRIP. No
    // gl_VertexID needed so this works on WebGL1 + ANGLE_instanced_arrays.
    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );
  }

  /**
   * Draw this line tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)` (campaign D11). The id program is built
   * from the SAME vertex source as the visual pass — same projection variant,
   * same time mode, same DataFilter branch — so the pickable area is exactly
   * the extruded quad the user sees, and time- or range-filtered geometry
   * discards instead of leaving an invisible hit box.
   *
   * Ids are per FEATURE while instances are SEGMENTS, so the id colours are
   * expanded through the cache's per-feature segment counts. That buffer is
   * rebuilt each pick and freed immediately: `idBase` shifts with whatever
   * tiles are loaded this frame, and picks are rare user-initiated events.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const h = this.programFor(gl, frame, true);
    const c = cache as LineGpuCache;

    const perFeature = this.buildPickIdColors(c.featureCount, idBase);
    const idBuffer = this.uploadArrayBuffer(
      gl,
      expandPickIdColors(perFeature, c.featureSegmentCounts, c.instanceCount),
    );

    gl.useProgram(h.program);
    if (frame.shader.prelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uWidth, this.lineOpts.width);
    gl.uniform1f(h.uWidthScale, this.widthScaleFor(gl, tile, ctx));
    this.setTimeUniforms(gl, h, c, ctx);
    this.setFilterUniforms(gl, h, c);
    gl.uniform1f(h.uUseFeatureWidth, c.widthBuffer && h.aWidth >= 0 ? 1 : 0);

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass, and
    // the temp id buffer is per-pass, so a cached VAO would just go stale.
    const quad = this.getUnitQuad(gl);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(h.aCorner);
    gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCorner, 0);

    this.bindInstanceAttributes(gl, h, c);

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

    // Leave the default-VAO attribute slate clean (and every divisor back at
    // 0) so the next visual frame's VAO recording starts from a known state,
    // then drop the one-shot id buffer.
    for (const loc of [
      h.aCorner,
      h.aPosA,
      h.aPosB,
      h.aTime,
      h.aVertexTimeAB,
      h.aWidth,
      h.aFilterValue,
      h.aIdColor,
    ]) {
      if (loc < 0) continue;
      this.instSupport.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
    gl.deleteBuffer(idBuffer);
  }
}
