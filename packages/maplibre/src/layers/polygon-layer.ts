/**
 * Polygon geometry adapter — renders POLYGON-type tiles as filled triangles,
 * with optional outline strokes and extruded side walls.
 *
 * Triangulation runs on the CPU at tile-load time via the shared
 * `tessellateFeature` kernel (@poopdeck.gl/core/geometry) — the same dispatch
 * deck and three use — then we upload the vertices + indices once and toggle
 * alpha per-feature in the vertex shader using the time-filter uniforms.
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
 * `projectTileFor3D` (extruded prisms). On GLOBE frames the baked geometry is
 * additionally refined to the host's subdivision granularity (`lib/globe.ts`)
 * so long chords don't horizon-clip; mercator (legacy OR v5 prelude) is affine
 * in mercator, so chords there are exact and no subdivision runs. STT tiles
 * are drawn once in the single 0..1 mercator world (there is no per-tile
 * `wrap`), so the globe "skip wrap ≠ 0 copies" rule holds structurally.
 *
 * `projectTileFor3D`'s elevation UNIT is host-variant-dependent and this layer
 * is the only place in the package that has to care:
 *   - legacy `uMatrix` and the v5 MERCATOR prelude both take mercator-z
 *     (maplibre scales custom-layer z by `worldSize / pixelsPerMeter` on top of
 *     a view-projection whose z is already `pixelsPerMeter`, i.e. net worldSize
 *     — exactly v4's `customLayerMatrix`);
 *   - the v5 GLOBE prelude takes METRES (`spherePos * (1 + elevation /
 *     GLOBE_RADIUS)`), and its transition fallback term takes mercator-z again.
 * So the layer uploads the metres→mercator-z factor folded into
 * `uAltitudeScale` everywhere except globe, where it rides its own
 * `uMercatorZPerMeter` uniform for the fallback half.
 *
 * Stroked / extruded parity:
 *   - `stroked: true` adds an outline pass over each ring edge, drawn with the
 *     same screen-space quad expansion as STTLineLayer.
 *   - `extruded: true` raises the polygon top to a per-feature elevation in
 *     METRES and draws side walls down to ground. Pair with
 *     `map.setPitch(...)` to actually see the relief.
 *
 * ── Wave M2 feature parity ──────────────────────────────────────────────────
 *   - **Time modes (D8).** All four modes (`window`/`wake`/`cumulative`/
 *     `trail`) via `timeFilterMode`. Selection is COMPILE-TIME: the vertex
 *     source carries exactly one mode's kernel, and the program-cache key
 *     carries the mode so two modes can never share a program.
 *   - **DataFilter.** `filterProperty` + `filterRange`/`filterSoftRange`/
 *     `filterEnabled` gate features by a baked numeric column
 *     (`shaders/data-filter.glsl.ts`, deck `DataFilterExtension` semantics).
 *     The branch compiles only when `filterProperty` is set; polygons have no
 *     size hook, so `filterTransformSize` is inert here (deck's
 *     SolidPolygonLayer / PathLayer ignore it upstream too).
 *   - **Elevation (D10).** `elevation` is METRES and the layer converts with
 *     latitude-correct `mercatorZFromAltitude` at each tile's centre latitude;
 *     `altitudeScale` survives as a dimensionless exaggeration MULTIPLIER
 *     (default 1). See {@link STTPolygonLayerOptions.altitudeScale}.
 *   - **Picking (D11).** `drawPickTile` paints fill triangles and (when
 *     stroked) outline quads with each feature's encoded pick id, under the
 *     SAME visibility gates as the visual pass — an invisible polygon is
 *     unpickable.
 */

import type { Tile, Layer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_POLYGON_PALETTE } from '@poopdeck.gl/core';
import { tessellateFeature } from '@poopdeck.gl/core/geometry';
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
  mercatorZFromAltitude,
  tileCenterLatitude,
} from '../lib/projection.js';
import {
  subdivideLineMercator,
  subdivideTrianglesMercator,
} from '../lib/globe.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_TRAIL_GLSL,
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
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';

// Shared with @poopdeck.gl/layers AnimatedPolygonLayer (single source of truth
// in @poopdeck.gl/core).
const DEFAULT_POLY_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_POLYGON_PALETTE;

/**
 * The four animated time-filter modes this layer compiles — the package-wide
 * {@link STTTimeFilterMode} under this layer's historical name.
 */
export type PolygonTimeFilterMode = STTTimeFilterMode;

export interface STTPolygonLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
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
   * Per-feature extrusion height in METRES. Either a constant or the name of a
   * numeric property on the tile's features. Default 0.
   *
   * The metres→mercator-z conversion is the layer's job (campaign D10): it
   * resolves per tile at that tile's centre latitude, so the same building is
   * the same height in Oslo and in Quito.
   */
  elevation?: number | string;
  /**
   * Dimensionless exaggeration MULTIPLIER on {@link elevation}. Default 1
   * (true scale). 3 makes every prism three times as tall.
   *
   * **Behaviour change (campaign D10).** This prop used to be the raw
   * elevation-units→mercator-z factor, defaulting to `1e-7` — a flat,
   * latitude-blind approximation 4.003× larger than the correct equatorial
   * value, which is why extrusions stood ~4× too tall. The conversion is now
   * done from the tile's latitude by `mercatorZFromAltitude` (`lib/projection.ts`)
   * and this prop only exaggerates on top. An app that used to pass
   * `altitudeScale: 1e-7` with metre elevations must now drop the prop
   * entirely (or pass an exaggeration factor).
   */
  altitudeScale?: number;
  /**
   * Time-filter mode (deck `TimeFilterExtension` parity). Default `'window'`.
   *
   * COMPILE-TIME: the vertex source carries exactly one mode's kernel and the
   * program-cache key carries the mode, so switching modes means a new
   * program, not a uniform branch. Per-mode knobs:
   *   - `window` — `timeWindow` + `fadeInDuration`/`fadeOutDuration` (base opts).
   *   - `wake` — {@link wakeLength} behind the play-head; a non-positive
   *     wakeLength degrades to `window` (deck selects wake only when
   *     `wakeLength > 0`, and a degenerate wake would light nothing).
   *   - `cumulative` — draw-and-persist from each feature's start time;
   *     `fadeInDuration` doubles as the reveal ramp. CALLER OBLIGATION (deck's
   *     `TimeFilterExtension` states the same one): the shader does the reveal,
   *     the loader does not, so `timeWindow` must be wide enough to cover the
   *     played-through range or already-revealed tiles are evicted and the
   *     layer un-draws itself as playback advances.
   *   - `trail` — {@link trailLength} + {@link fadeTrail}. Polygon times are
   *     per-FEATURE, so this reveals whole polygons by their start time; the
   *     per-VERTEX trail lives in `STTTripsLayer`. A non-positive trailLength
   *     degrades to `window` on the same rule as wake (deck reaches its trail
   *     branch only when `trailLength > 0`).
   */
  timeFilterMode?: PolygonTimeFilterMode;
  /** `wake` mode: milliseconds a feature stays lit after its start time. Default 0. */
  wakeLength?: number;
  /**
   * `trail` mode: milliseconds a feature stays lit after its start time.
   * Default 0, which degrades `trail` to `window` (see {@link timeFilterMode}).
   */
  trailLength?: number;
  /**
   * `trail` mode head→tail fade: `1`/`true` (the default) fades, `0`/`false`
   * holds constant alpha for the whole trail (snake mode), and intermediate
   * numbers blend between them (package-wide `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
}

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * Compile-time shader configuration. `prelude`/`define` come from the host
 * frame (empty ⇒ the legacy `uMatrix` variant); `mode`, `filter` and `pick`
 * come from the layer's own options and MUST be mirrored in the program-cache
 * key — `getOrCreateProgram` only appends the host variant name.
 */
export interface PolygonShaderConfig extends ShaderInjection {
  /** Active time-filter mode. Default `'window'`. */
  mode?: PolygonTimeFilterMode;
  /** Splice the DataFilter kernel (only when a `filterProperty` is configured). */
  filter?: boolean;
  /** Build the id-pick variant: flat encoded-id colour instead of the fill colour. */
  pick?: boolean;
}

/** The four draw passes, each with its own compiled program. */
type PolygonPass = 'fill' | 'stroke' | 'pick-fill' | 'pick-stroke';

/** Per-mode uniform declarations, in the historical order for `window`. */
const MODE_UNIFORMS: Readonly<Record<PolygonTimeFilterMode, string>> = {
  window: `  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
`,
  wake: `  uniform float uCurrentTime;
  uniform float uWakeLength;
`,
  cumulative: `  uniform float uCurrentTime;
  uniform float uFadeIn;
`,
  trail: `  uniform float uCurrentTime;
  uniform float uTrailLength;
  uniform float uFadeTrail;
`,
};

/** Per-mode kernel from the shared time-filter GLSL module. */
const MODE_KERNEL: Readonly<Record<PolygonTimeFilterMode, string>> = {
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
};

/**
 * Per-mode `vAlpha` expression. Every vertex / ring edge of a feature carries
 * that feature's `aTime`, so `trail` reads `aTime.x` (the feature's start) as
 * its vertex time — a polygon reveals whole, never half-drawn.
 */
const MODE_ALPHA: Readonly<Record<PolygonTimeFilterMode, string>> = {
  window:
    'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
  wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
  cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
  trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
};

// The DataFilter declaration snippets open with a blank line (they splice at
// end-of-line elsewhere); these builders splice at line START, so drop it. The
// function kernels keep theirs — a blank line between GLSL functions is what
// the historical sources already look like.
const FILTER_ATTRIBUTE_DECL = DATA_FILTER_ATTRIBUTE_GLSL.slice(1);
const FILTER_UNIFORM_DECLS = DATA_FILTER_UNIFORMS_GLSL.slice(1);

/**
 * DataFilter application, spliced after the mode's alpha assignment.
 *
 * deck parity (`DECKGL_FILTER_COLOR` + the extension's `vs:#main-end`): a
 * PARTIAL (soft-band) value only lowers opacity when `filterTransformColor` is
 * on, a 0 always culls, and a culled vertex collapses to the origin so it
 * rasterizes nothing. The collapse is safe because the filter value is
 * per-FEATURE — a feature collapses as a whole, never leaving one corner
 * pinned at the origin.
 */
const filterApplyBlock = (on: boolean): string =>
  on
    ? `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    vAlpha *= (uFilterTransformColor > 0.5) ? filterAlpha : (filterAlpha > 0.0 ? 1.0 : 0.0);
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
`
    : '';

/**
 * Variant-aware fill vertex source. Legacy frames (empty prelude) in the
 * DEFAULT configuration (`window`, no filter, visual) emit the historical
 * `uMatrix` shader VERBATIM — pinned byte-for-byte by the variants test.
 * Prelude frames (maplibre v5+) project through the injected functions
 * instead: `projectTile` for flat fills (2d: the prelude owns z, giving
 * horizon clipping on globe) and `projectTileFor3D` for extruded prisms, with
 * the globe variant re-deriving the horizon-clip z itself (see the module
 * header for the elevation-unit table). The extrusion branch is uniform-wide,
 * matching how the cache bakes geometry (`setExtruded` rebuilds the caches).
 * Exported for string-level variant tests.
 */
export const buildFillVertexSource = (cfg: PolygonShaderConfig): string => {
  const mode = cfg.mode ?? 'window';
  const filter = cfg.filter === true;
  const pick = cfg.pick === true;
  const usesPrelude = cfg.prelude !== '';
  // Every slot below is either empty or newline-terminated, so the DEFAULT
  // legacy configuration reproduces the historical source exactly.
  const preludeBlock = usesPrelude ? `${cfg.prelude}\n${cfg.define}\n` : '';
  const colorAttr = pick
    ? '  attribute vec3 aIdColor;     // per-vertex encoded pick id (UNSIGNED_BYTE normalized)\n'
    : '  attribute vec4 aColor;\n';
  const projectionUniforms = usesPrelude
    ? '  uniform float uAltitudeScale; // mercator-z on the mercator variant, METRES on globe\n  uniform float uMercatorZPerMeter; // GLOBE only: metres → mercator-z for the transition fallback\n  uniform float uExtruded;\n'
    : '  uniform mat4 uMatrix;\n  uniform float uAltitudeScale;\n';
  const colorUniforms = pick
    ? ''
    : '  uniform float uUseFeatureColor;\n  uniform vec4 uColor;\n';
  const varyings = pick
    ? '  varying vec3 vIdColor;\n'
    : '  varying vec4 vColor;\n';
  const position = usesPrelude
    ? `    if (uExtruded > 0.5) {
      float elev = aMercator.z * uAltitudeScale;
#ifdef GLOBE
      // projectTileFor3D deliberately PRESERVES z on globe ("Unlike
      // interpolateProjection, this variant preserves the Z value",
      // maplibre _projection_globe.vertex.glsl), so a prism would lose the
      // horizon clipping the flat branch inherits and the back hemisphere
      // would draw over the front. Its transition fallback also wants
      // mercator-z while its sphere term wants metres — one call cannot feed
      // both. Mirror interpolateProjection here with the right unit on each
      // side; the 0.2 constant is maplibre's own z_globeness_threshold.
      vec3 elevated = projectToSphere(aMercator.xy) * (1.0 + elev / GLOBE_RADIUS);
      vec4 globePos = u_projection_matrix * vec4(elevated, 1.0);
      globePos.z = globeComputeClippingZ(elevated) * globePos.w;
      vec4 result = globePos;
      if (u_projection_transition <= 0.999) {
        vec4 flatPos = u_projection_fallback_matrix *
          vec4(aMercator.xy, elev * uMercatorZPerMeter, 1.0);
        result.z = mix(0.0, globePos.z,
          clamp((u_projection_transition - 0.2) / 0.8, 0.0, 1.0));
        result.xyw = mix(flatPos.xyw, globePos.xyw, u_projection_transition);
      }
      gl_Position = result;
#else
      gl_Position = projectTileFor3D(aMercator.xy, elev);
#endif
    } else {
      gl_Position = projectTile(aMercator.xy);
    }
`
    : '    gl_Position = uMatrix * vec4(aMercator.x, aMercator.y, aMercator.z * uAltitudeScale, 1.0);\n';
  const colorAssign = pick
    ? '    vIdColor = aIdColor;\n'
    : '    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;\n';
  return `
${preludeBlock}  precision highp float;
  attribute vec3 aMercator;
  attribute vec2 aTime;
${colorAttr}${filter ? FILTER_ATTRIBUTE_DECL : ''}${projectionUniforms}${colorUniforms}${MODE_UNIFORMS[mode]}${filter ? FILTER_UNIFORM_DECLS : ''}  varying float vAlpha;
${varyings}${MODE_KERNEL[mode]}${filter ? DATA_FILTER_GLSL : ''}
  void main() {
${position}    vAlpha = ${MODE_ALPHA[mode]};
${filterApplyBlock(filter)}${colorAssign}  }
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

/**
 * Id-pick fragment stage, shared by the fill and stroke pick programs. No
 * blending and no antialiasing: the readback must recover the byte triple
 * exactly. The `vAlpha` discard is what makes time-filtered and
 * DataFilter-hidden polygons unpickable.
 */
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // invisible features are not pickable
    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;

/**
 * Variant-aware stroke vertex source: instanced screen-space line expansion
 * (same scheme as STTLineLayer), one instance per ring edge, with the 4
 * corners coming from the base layer's shared unit quad. Outlines hug the
 * fill, so they are 2d content — prelude frames project through `projectTile`
 * (the prelude owns z for horizon clipping) and the screen-space expansion,
 * which happens post-projection, is identical across variants. The default
 * legacy configuration emits the historical shader VERBATIM.
 * Exported for string-level variant tests.
 */
export const buildStrokeVertexSource = (cfg: PolygonShaderConfig): string => {
  const mode = cfg.mode ?? 'window';
  const filter = cfg.filter === true;
  const pick = cfg.pick === true;
  const usesPrelude = cfg.prelude !== '';
  const project = (pos: string) =>
    usesPrelude ? `projectTile(${pos})` : `uMatrix * vec4(${pos}, 0.0, 1.0)`;
  // Slots are empty or newline-terminated (see buildFillVertexSource).
  const preludeBlock = usesPrelude ? `${cfg.prelude}\n${cfg.define}\n` : '';
  const idAttr = pick
    ? '  attribute vec3 aIdColor;      // per-instance encoded pick id (UNSIGNED_BYTE normalized)\n'
    : '';
  const matrixUniform = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const idVarying = pick ? '  varying vec3 vIdColor;\n' : '';
  return `
${preludeBlock}  precision highp float;
  attribute vec2 aCorner;       // (side, along) per-vertex
  attribute vec2 aPosA;         // edge start, per-instance
  attribute vec2 aPosB;         // edge end, per-instance
  attribute vec2 aTime;         // [startTime, endTime], per-instance
${idAttr}${filter ? FILTER_ATTRIBUTE_DECL : ''}${matrixUniform}  uniform vec2 uViewport;
  uniform float uWidth;
${MODE_UNIFORMS[mode]}${filter ? FILTER_UNIFORM_DECLS : ''}  varying float vAlpha;
${idVarying}${MODE_KERNEL[mode]}${filter ? DATA_FILTER_GLSL : ''}
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
    vec2 offsetPx = perp * aCorner.x * uWidth * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;
    vAlpha = ${MODE_ALPHA[mode]};
${filterApplyBlock(filter)}${pick ? '    vIdColor = aIdColor;\n' : ''}  }
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

/**
 * Mode-uniform locations. Only the active mode's members resolve to a real
 * location; the rest are null, which `gl.uniform1f` ignores.
 */
interface TimeUniformLocs {
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uWakeLength: WebGLUniformLocation | null;
  uTrailLength: WebGLUniformLocation | null;
  uFadeTrail: WebGLUniformLocation | null;
}

/** DataFilter uniform locations; all null when the filter branch is absent. */
interface FilterUniformLocs {
  uFilterRange: WebGLUniformLocation | null;
  uFilterSoftRange: WebGLUniformLocation | null;
  uFilterEnabled: WebGLUniformLocation | null;
  uFilterTransformColor: WebGLUniformLocation | null;
}

interface PolygonProgramHandles extends TimeUniformLocs, FilterUniformLocs {
  program: WebGLProgram;
  aMercator: number;
  aTime: number;
  /** Visual variant only (-1 on the id program). */
  aColor: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
  /** -1 unless the DataFilter kernel was spliced in. */
  aFilterValue: number;
  /** Legacy variant only — null on prelude programs (their matrix comes from u_projection_*). */
  uMatrix: WebGLUniformLocation | null;
  uAltitudeScale: WebGLUniformLocation | null;
  /** GLOBE prelude variant only — null everywhere else (see altitudeScaleFor). */
  uMercatorZPerMeter: WebGLUniformLocation | null;
  /** Prelude variant only — null on the legacy program. */
  uExtruded: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

interface StrokeProgramHandles extends TimeUniformLocs, FilterUniformLocs {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  aTime: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
  /** -1 unless the DataFilter kernel was spliced in. */
  aFilterValue: number;
  /** Legacy variant only — null on prelude programs. */
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

interface PolygonGpuCache extends TileGpuCache {
  use32BitIndices: boolean;
  /**
   * Full-mercator-square subdivision granularity baked into this cache
   * (0 = unrefined — every mercator host). GLOBE frames refine fill triangles,
   * wall bands and stroke edges to it at build time (D4).
   */
  subdivisionGranularity: number;
  /**
   * Metres → mercator-z at this tile's centre latitude (D10), resolved once at
   * build time so the draw path pays no transcendentals per frame. The legacy
   * (`uMatrix`) shader and the v5 MERCATOR prelude both consume `elevation *
   * uAltitudeScale` as mercator-z, so this is folded into that uniform there;
   * the GLOBE prelude wants METRES and gets this as `uMercatorZPerMeter`.
   */
  mercatorZScale: number;
  /**
   * Fill vertices contributed by each feature, index-aligned with the tile's
   * features (0 for features dropped as degenerate). Drives both the
   * per-feature → per-vertex DataFilter expansion and the pick-id expansion.
   */
  fillVertexCounts: Uint32Array;
  /** True when this tile baked the configured filter column (the `enabled` gate). */
  hasFilterColumn: boolean;
  /** Per-fill-vertex filter values; absent when the tile lacks the column. */
  filterBuffer?: WebGLBuffer;
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
    /** Ring edges contributed by each feature (pick-id + filter expansion). */
    instanceCounts: Uint32Array;
    /** Per-edge filter values; absent when the tile lacks the column. */
    filterBuffer?: WebGLBuffer;
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

// The per-feature → per-draw-unit id-colour expansion now lives on the base
// (line and trips need the identical loop). Re-exported here because this is
// where it was introduced and where its tests import it from.
export { expandPickIdColors };

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
    wakeLength: number;
    trailLength: number;
    fadeTrail: number;
  } & STTDataFilterOptions;

  /**
   * Compiled time-filter mode — constant for the layer's lifetime, and part of
   * every program-cache key (`getOrCreateProgram` only appends the HOST
   * variant, so two modes sharing a base key would collide).
   */
  private readonly timeMode: PolygonTimeFilterMode;
  /** True when a `filterProperty` was configured, so the filter branch compiles. */
  private readonly filterCompiled: boolean;
  /** Reusable DataFilter uniform payload — resolved in place, never per-draw allocated. */
  private readonly filterUniforms = createDataFilterUniforms();
  /** One warning per layer for a categorical (non-range-filterable) filter column. */
  private filterCategoricalWarned = false;

  /**
   * True while the host is on (or transitioning to) the globe — the ONLY case
   * where baked geometry needs chord subdivision, since both `uMatrix` and the
   * v5 mercator `projectTile` are affine in mercator. Observed in
   * {@link beginFrame} BEFORE any cache build; the line/trips layers gate the
   * identical way.
   */
  private frameIsGlobe = false;

  /**
   * Program-cache keys per pass, built ONCE. The mode and filter branch are
   * compile-time and constant for the layer's lifetime, and
   * `getOrCreateProgram` appends the host variant itself — so nothing here
   * needs rebuilding, least of all once per tile per frame.
   */
  private readonly programKeys: Record<PolygonPass, string>;

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
      // D10: a dimensionless exaggeration now — the metres→mercator-z factor
      // is resolved per tile from its own latitude.
      altitudeScale: opts.altitudeScale ?? 1,
      wakeLength: opts.wakeLength ?? 0,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
      filterProperty: opts.filterProperty,
      filterRange: opts.filterRange,
      filterSoftRange: opts.filterSoftRange,
      filterEnabled: opts.filterEnabled,
      filterTransformSize: opts.filterTransformSize,
      filterTransformColor: opts.filterTransformColor,
    };
    const mode = opts.timeFilterMode ?? 'window';
    // deck's precedence enters the wake branch only for `wakeLength > 0` and
    // the trail branch only for `trailLength > 0`, otherwise falling through
    // to the window branch. Both degenerate kernels here light NOTHING
    // (shaders/time-window.glsl.ts), so a mode whose length knob is
    // non-positive resolves to `window` — never to a silently blank layer, and
    // never to the "whole past at full alpha" the old trail guard produced.
    this.timeMode =
      (mode === 'wake' && !(this.polyOpts.wakeLength > 0)) ||
      (mode === 'trail' && !(this.polyOpts.trailLength > 0))
        ? 'window'
        : mode;
    this.filterCompiled = Boolean(opts.filterProperty);
    this.programKeys = {
      fill: this.buildProgramKey('fill'),
      stroke: this.buildProgramKey('stroke'),
      'pick-fill': this.buildProgramKey('pick-fill'),
      'pick-stroke': this.buildProgramKey('pick-stroke'),
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

  /**
   * Move the DataFilter range at runtime (the slider case). Uniform-only: the
   * filter attribute is already uploaded, so no tile rebuild and no relink.
   * `null` idles the filter and every feature renders. Passing `softRange`
   * explicitly (including `null`) replaces the soft margin; omitting it leaves
   * the configured one alone.
   */
  setFilterRange(
    range: DataFilterRange | null,
    softRange?: DataFilterRange | null,
  ): void {
    this.polyOpts.filterRange = range;
    if (softRange !== undefined) this.polyOpts.filterSoftRange = softRange;
    this.map?.triggerRepaint();
  }

  /** Move the DataFilter's soft fade margin alone. Uniform-only. */
  setFilterSoftRange(range: DataFilterRange | null): void {
    this.polyOpts.filterSoftRange = range;
    this.map?.triggerRepaint();
  }

  /** Master DataFilter switch. `false` renders every feature unfiltered. */
  setFilterEnabled(enabled: boolean): void {
    this.polyOpts.filterEnabled = enabled;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Polygon;
  }

  /**
   * Track whether the host is on the globe BEFORE any tile cache is (re)built
   * this frame — that is the only projection state baked geometry depends on
   * (subdivision). Mercator, legacy or v5, keeps the exact unrefined buffers,
   * so a legacy ⇄ v5-mercator host change needs NO cache invalidation; the
   * globe side lives under its own cache key instead of triggering a
   * wholesale rebuild.
   */
  protected beginFrame(
    matrixOrArgs: unknown,
    options?: unknown,
  ): HostFrame | null {
    const frame = super.beginFrame(matrixOrArgs, options);
    if (frame) this.frameIsGlobe = frame.isGlobe;
    return frame;
  }

  /**
   * Subdivided globe geometry lives under its own key (the line/trips scheme)
   * so the flat mercator entry stays unpolluted and a globe ⇄ mercator flip
   * reuses either side without rebuilds. The key also carries the baked
   * granularity, so a runtime `setProjection` that moves the host's
   * subdivision curve rebuilds under a new key instead of keeping chords that
   * horizon-clip. The `z/x/y/t::` prefix matches the base tileKey format so
   * the base unload sweep frees every variant.
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

  /**
   * Program-cache key for one pass. The mode and the filter branch are
   * compile-time, so they MUST be part of the key —
   * {@link STTBaseLayer.getOrCreateProgram} only appends the host's shader
   * variant name. Called once per pass from the constructor into
   * {@link programKeys}; the draw path reads that record.
   */
  private buildProgramKey(pass: PolygonPass): string {
    return `${pass}:${this.timeMode}${this.filterCompiled ? ':filter' : ''}`;
  }

  /** Link a fill program (visual or id-pick) for the frame's shader variant. */
  private buildFillHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): PolygonProgramHandles {
    const program = this.linkProgram(
      gl,
      buildFillVertexSource({
        prelude: shader.prelude,
        define: shader.define,
        mode: this.timeMode,
        filter: this.filterCompiled,
        pick,
      }),
      pick ? ID_FS_SOURCE : FS_SOURCE,
    );
    return {
      program,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
      aFilterValue: gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uAltitudeScale: gl.getUniformLocation(program, 'uAltitudeScale'),
      uMercatorZPerMeter: gl.getUniformLocation(program, 'uMercatorZPerMeter'),
      uExtruded: gl.getUniformLocation(program, 'uExtruded'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      ...this.resolveTimeUniformLocs(gl, program),
      ...this.resolveFilterUniformLocs(gl, program),
    };
  }

  /** Link a stroke program (visual or id-pick) for the frame's shader variant. */
  private buildStrokeHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): StrokeProgramHandles {
    const program = this.linkProgram(
      gl,
      buildStrokeVertexSource({
        prelude: shader.prelude,
        define: shader.define,
        mode: this.timeMode,
        filter: this.filterCompiled,
        pick,
      }),
      pick ? ID_FS_SOURCE : STROKE_FS_SOURCE,
    );
    return {
      program,
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aPosA: gl.getAttribLocation(program, 'aPosA'),
      aPosB: gl.getAttribLocation(program, 'aPosB'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
      aFilterValue: gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uWidth: gl.getUniformLocation(program, 'uWidth'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      ...this.resolveTimeUniformLocs(gl, program),
      ...this.resolveFilterUniformLocs(gl, program),
    };
  }

  private resolveTimeUniformLocs(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
  ): TimeUniformLocs {
    return {
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
      uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
      uWakeLength: gl.getUniformLocation(program, 'uWakeLength'),
      uTrailLength: gl.getUniformLocation(program, 'uTrailLength'),
      uFadeTrail: gl.getUniformLocation(program, 'uFadeTrail'),
    };
  }

  private resolveFilterUniformLocs(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
  ): FilterUniformLocs {
    return {
      uFilterRange: gl.getUniformLocation(program, DATA_FILTER_NAMES.range),
      uFilterSoftRange: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.softRange,
      ),
      uFilterEnabled: gl.getUniformLocation(program, DATA_FILTER_NAMES.enabled),
      uFilterTransformColor: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.transformColor,
      ),
    };
  }

  private readonly fillProgramFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): PolygonProgramHandles => this.buildFillHandles(gl, shader, false);

  private readonly pickFillProgramFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): PolygonProgramHandles => this.buildFillHandles(gl, shader, true);

  private readonly strokeProgramFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): StrokeProgramHandles => this.buildStrokeHandles(gl, shader, false);

  private readonly pickStrokeProgramFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): StrokeProgramHandles => this.buildStrokeHandles(gl, shader, true);

  /**
   * Resolve per-feature elevation in METRES. If `elevation` is a property name,
   * use the matching `numericProps[name]`; otherwise broadcast the constant.
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

    // DataFilter column (deck DataFilterExtension parity): a missing or
    // categorical column resolves to hasColumn=false, which the uniform
    // resolver turns into `enabled: 0` — the tile renders UNFILTERED rather
    // than blank.
    const filterColumn = extractFilterColumn(f, this.polyOpts.filterProperty);
    if (filterColumn.categorical && !this.filterCategoricalWarned) {
      this.filterCategoricalWarned = true;
      console.warn(
        `[${this.id}] filterProperty "${this.polyOpts.filterProperty}" is a ` +
          'categorical column; range filtering needs a numeric one — rendering unfiltered.',
      );
    }

    // Globe correctness (D4): GLOBE frames get long edges refined to the
    // host's subdivision granularity so chords don't horizon-clip (base
    // helper: per-tile granularity × 2^z per the lib/globe.ts convention).
    // Mercator bakes no subdivision — both `uMatrix` and the v5 mercator
    // `projectTile` are affine in mercator, so chords are already exact and
    // the geometry stays byte-identical to the historical path.
    const granularity = this.frameIsGlobe
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
    // Draw units per feature: the join key for the per-FEATURE filter column
    // and pick ids. Zero-filled, so a feature dropped below contributes none.
    const fillVertexCounts = new Uint32Array(featureCount);
    const strokeInstanceCounts = new Uint32Array(featureCount);
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

      const featureVertexBase = nextVertex;
      const featureEdgeBase = strokeSegments.length;
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

      fillVertexCounts[fi] = nextVertex - featureVertexBase;
      strokeInstanceCounts[fi] = strokeSegments.length - featureEdgeBase;
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

    // Per-FEATURE filter values → per fill VERTEX (the polygon's draw unit).
    let filterBuffer: WebGLBuffer | undefined;
    if (filterColumn.values) {
      filterBuffer = this.uploadArrayBuffer(
        gl,
        expandFilterValues(
          filterColumn.values,
          fillVertexCounts,
          totalVertices,
        ),
      );
      extras.push(filterBuffer);
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
      extras.push(sPosABuf, sPosBBuf, sTimeBuf);
      let sFilterBuf: WebGLBuffer | undefined;
      if (filterColumn.values) {
        sFilterBuf = this.uploadArrayBuffer(
          gl,
          expandFilterValues(
            filterColumn.values,
            strokeInstanceCounts,
            segCount,
          ),
        );
        extras.push(sFilterBuf);
      }
      stroke = {
        posABuffer: sPosABuf,
        posBBuffer: sPosBBuf,
        timeBuffer: sTimeBuf,
        instanceCount: segCount,
        instanceCounts: strokeInstanceCounts,
        filterBuffer: sFilterBuf,
      };
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
      // D10: metres → mercator-z at THIS tile's centre latitude, resolved once.
      mercatorZScale: mercatorZFromAltitude(
        1,
        tileCenterLatitude(tile.id.z, tile.id.y),
      ),
      fillVertexCounts,
      hasFilterColumn: filterColumn.hasColumn,
      extraBuffers: extras.length > 0 ? extras : undefined,
      colorBuffer,
      filterBuffer,
      stroke,
    };
  }

  /**
   * Elevation scale for one tile (D10), keyed by the host's projection.
   *
   * Both the legacy `uMatrix` shader AND the v5 MERCATOR prelude consume
   * `aMercator.z * uAltitudeScale` as MERCATOR-Z — maplibre's
   * `getProjectionDataForCustomLayer` scales custom-layer z by
   * `worldSize / pixelsPerMeter` on top of a view-projection whose z is
   * already `pixelsPerMeter`, i.e. net `worldSize`, exactly like v4's
   * `customLayerMatrix` — so the metres→mercator-z factor at the tile's centre
   * latitude is folded in there.
   *
   * Only the GLOBE prelude wants METRES (`spherePos * (1 + elevation /
   * GLOBE_RADIUS)`), where the exaggeration alone applies and the shader picks
   * the mercator-z factor back up from `uMercatorZPerMeter` for the
   * transition's fallback term. All three paths draw the same prism at the
   * same true height.
   */
  private altitudeScaleFor(cache: PolygonGpuCache, isGlobe: boolean): number {
    return isGlobe
      ? this.polyOpts.altitudeScale
      : this.polyOpts.altitudeScale * cache.mercatorZScale;
  }

  /** Upload the active mode's time uniforms (the others resolve to null). */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TimeUniformLocs,
    ctx: DrawContext,
    cache: TileGpuCache,
    fadeIn: number,
    fadeOut: number,
  ): void {
    switch (this.timeMode) {
      case 'window':
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
        return;
      case 'wake':
        // Tile-relative now — the trips-layer convention (f32-exact).
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uWakeLength, this.polyOpts.wakeLength);
        return;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uFadeIn, fadeIn);
        return;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uTrailLength, this.polyOpts.trailLength);
        gl.uniform1f(h.uFadeTrail, this.polyOpts.fadeTrail);
    }
  }

  /**
   * Upload the DataFilter uniforms for this tile. No-op when no filter branch
   * was compiled. `hasColumn: false` (tile without the column) resolves to
   * `enabled: 0`, i.e. an UNFILTERED tile — never a blank one.
   */
  private setFilterUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FilterUniformLocs,
    cache: PolygonGpuCache,
  ): void {
    if (!this.filterCompiled) return;
    const u = resolveDataFilterUniforms(
      this.filterUniforms,
      this.polyOpts,
      cache.hasFilterColumn,
    );
    gl.uniform2fv(h.uFilterRange, u.range);
    gl.uniform2fv(h.uFilterSoftRange, u.softRange);
    gl.uniform1f(h.uFilterEnabled, u.enabled);
    // `transformSize` is intentionally unset: a polygon has no size hook
    // (deck's SolidPolygonLayer / PathLayer ignore it upstream too).
    gl.uniform1f(h.uFilterTransformColor, u.transformColor);
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
    const altitudeScale = this.altitudeScaleFor(c, frame.isGlobe);

    if (this.polyOpts.filled) {
      const h = this.getOrCreateProgram(
        gl,
        this.programKeys['fill'],
        frame,
        this.fillProgramFactory,
      );
      gl.useProgram(h.program);
      if (preludeProjected) {
        // Prelude-built variant: projection rides the injected u_projection_*
        // uniforms (no uMatrix in this program).
        this.setPreludeProjectionUniforms(gl, h.program, frame);
        gl.uniform1f(h.uExtruded, this.polyOpts.extruded ? 1 : 0);
        // GLOBE only (null location elsewhere): the transition's fallback term
        // reads elevation in mercator-z while the sphere term reads metres.
        gl.uniform1f(h.uMercatorZPerMeter, c.mercatorZScale);
      } else {
        gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
      }
      gl.uniform1f(h.uAltitudeScale, altitudeScale);
      gl.uniform4fv(h.uColor, toRgba01(this.polyOpts.color));
      this.setTimeUniforms(gl, h, ctx, c, fadeIn, fadeOut);
      this.setFilterUniforms(gl, h, c);
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
        if (c.filterBuffer && h.aFilterValue >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, c.filterBuffer);
          gl.enableVertexAttribArray(h.aFilterValue);
          gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
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
        this.programKeys['stroke'],
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
      this.setTimeUniforms(gl, sh, ctx, c, fadeIn, fadeOut);
      this.setFilterUniforms(gl, sh, c);

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

          if (s.filterBuffer && sh.aFilterValue >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, s.filterBuffer);
            gl.enableVertexAttribArray(sh.aFilterValue);
            gl.vertexAttribPointer(sh.aFilterValue, 1, gl.FLOAT, false, 0, 0);
            this.instSupport.vertexAttribDivisor(sh.aFilterValue, 1);
          }
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

  /**
   * Draw this polygon tile into the id-pick FBO (D11), painting feature `i`
   * the flat colour `encodePickId(idBase + i)`. Both passes of the visual
   * draw are reproduced under the SAME gates — `filled`/`stroked`, the
   * projection variant, the extrusion branch, the time mode and the
   * DataFilter — so a polygon the user cannot see is a polygon they cannot
   * pick. Browser-verify-only (the enclosing FBO round-trip needs a live GPU);
   * the id-colour expansion + decode join are unit-tested.
   *
   * The id-colour attributes are rebuilt per pick and freed immediately:
   * `idBase` shifts with whatever tiles are loaded this frame, and picks are
   * rare user-initiated events, so a persistent per-tile buffer would be stale
   * cache for no win. Raw attribute binds (no VAO) for the same reason.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const c = cache as PolygonGpuCache;
    const frame = ctx.frame ?? this.fallbackFrame;
    const preludeProjected = frame.shader.prelude !== '';
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    const altitudeScale = this.altitudeScaleFor(c, frame.isGlobe);
    // `featureCount` — not the cache's count-array length — is what the base
    // sized the id range from, so painting can never spill past
    // `idBase + count` into the next layer's range. `expandPickIdColors`
    // clamps the other direction.
    const featureIds = this.buildPickIdColors(
      layer.features.featureCount,
      idBase,
    );

    if (this.polyOpts.filled) {
      const h = this.getOrCreateProgram(
        gl,
        this.programKeys['pick-fill'],
        frame,
        this.pickFillProgramFactory,
      );
      const idBuffer = this.uploadArrayBuffer(
        gl,
        expandPickIdColors(featureIds, c.fillVertexCounts, c.vertexCount),
      );

      gl.useProgram(h.program);
      if (preludeProjected) {
        this.setPreludeProjectionUniforms(gl, h.program, frame);
        gl.uniform1f(h.uExtruded, this.polyOpts.extruded ? 1 : 0);
        // GLOBE only (null location elsewhere): the transition's fallback term
        // reads elevation in mercator-z while the sphere term reads metres.
        gl.uniform1f(h.uMercatorZPerMeter, c.mercatorZScale);
      } else {
        gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
      }
      gl.uniform1f(h.uAltitudeScale, altitudeScale);
      this.setTimeUniforms(gl, h, ctx, c, fadeIn, fadeOut);
      this.setFilterUniforms(gl, h, c);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.positionBuffer);
      gl.enableVertexAttribArray(h.aMercator);
      gl.vertexAttribPointer(h.aMercator, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
      gl.enableVertexAttribArray(h.aTime);
      gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.enableVertexAttribArray(h.aIdColor);
      gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);

      const useFilter = c.filterBuffer && h.aFilterValue >= 0;
      if (useFilter) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.filterBuffer!);
        gl.enableVertexAttribArray(h.aFilterValue);
        gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      }

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, c.indexBuffer!);
      const indexType = c.use32BitIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl.TRIANGLES, c.indexCount, indexType, 0);

      // Leave the default-VAO attribute slate clean for the next visual frame.
      gl.disableVertexAttribArray(h.aMercator);
      gl.disableVertexAttribArray(h.aTime);
      gl.disableVertexAttribArray(h.aIdColor);
      if (useFilter) gl.disableVertexAttribArray(h.aFilterValue);
      gl.deleteBuffer(idBuffer);
    }

    if (this.polyOpts.stroked && c.stroke && this.instSupport.enabled) {
      const sh = this.getOrCreateProgram(
        gl,
        this.programKeys['pick-stroke'],
        frame,
        this.pickStrokeProgramFactory,
      );
      const s = c.stroke;
      const idBuffer = this.uploadArrayBuffer(
        gl,
        expandPickIdColors(featureIds, s.instanceCounts, s.instanceCount),
      );

      gl.useProgram(sh.program);
      if (preludeProjected) {
        this.setPreludeProjectionUniforms(gl, sh.program, frame);
      } else {
        gl.uniformMatrix4fv(sh.uMatrix, false, ctx.matrix);
      }
      gl.uniform2f(sh.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(sh.uWidth, this.polyOpts.lineWidth);
      this.setTimeUniforms(gl, sh, ctx, c, fadeIn, fadeOut);
      this.setFilterUniforms(gl, sh, c);

      const quad = this.getUnitQuad(gl);
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

      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.enableVertexAttribArray(sh.aIdColor);
      gl.vertexAttribPointer(sh.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      this.instSupport.vertexAttribDivisor(sh.aIdColor, 1);

      const useFilter = s.filterBuffer && sh.aFilterValue >= 0;
      if (useFilter) {
        gl.bindBuffer(gl.ARRAY_BUFFER, s.filterBuffer!);
        gl.enableVertexAttribArray(sh.aFilterValue);
        gl.vertexAttribPointer(sh.aFilterValue, 1, gl.FLOAT, false, 0, 0);
        this.instSupport.vertexAttribDivisor(sh.aFilterValue, 1);
      }

      this.instSupport.drawArraysInstanced(
        0x0005 /* TRIANGLE_STRIP */,
        0,
        4,
        s.instanceCount,
      );

      // Attribute divisors are per-VAO state and this pass ran on the DEFAULT
      // VAO — leave every per-instance slot back at 0 so a non-instanced draw
      // that lands on the same slot (the fill pass on a runtime without VAOs)
      // still reads one element per vertex.
      gl.disableVertexAttribArray(sh.aCorner);
      gl.disableVertexAttribArray(sh.aPosA);
      this.instSupport.vertexAttribDivisor(sh.aPosA, 0);
      gl.disableVertexAttribArray(sh.aPosB);
      this.instSupport.vertexAttribDivisor(sh.aPosB, 0);
      gl.disableVertexAttribArray(sh.aTime);
      this.instSupport.vertexAttribDivisor(sh.aTime, 0);
      gl.disableVertexAttribArray(sh.aIdColor);
      this.instSupport.vertexAttribDivisor(sh.aIdColor, 0);
      if (useFilter) {
        gl.disableVertexAttribArray(sh.aFilterValue);
        this.instSupport.vertexAttribDivisor(sh.aFilterValue, 0);
      }
      gl.deleteBuffer(idBuffer);
    }
  }
}
