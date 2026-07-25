/**
 * Summary-tier cell adapter (maplibre parity campaign, Wave M4) — renders the
 * SERVER-AGGREGATED summary tier as filled H3 hexagons ({@link STTH3SummaryLayer})
 * or CARTO Quadbin quads ({@link STTQuadbinSummaryLayer}).
 *
 * The two classes differ in exactly ONE thing — how a `u64` cell id becomes a
 * mercator ring — so they are two three-line subclasses over one
 * {@link STTSummaryCellLayer} base. Everything else (geometry baking, the color
 * ramp, extrusion, the four time modes, DataFilter, picking, globe) is shared,
 * which is the whole reason they live in one file: deck's `H3SummaryLayer` and
 * `QuadbinSummaryLayer` are 731 and 718 lines of near-identical code that have
 * already drifted from each other once.
 *
 * ── What a summary tile is ──────────────────────────────────────────────────
 * One row per spatial CELL, geometry = the cell CENTROID as a Point (see
 * `crates/stt-build/src/summary.rs`), the cell id in the Arrow `id` column
 * (`BinaryFeatures.featureIds64` — the 32-bit `featureIds` mirror TRUNCATES the
 * mode/resolution/base-cell bits and must never be used), plus `count` and one
 * numeric column per aggregated attribute. The renderable polygon does not
 * exist in the archive at all: it is RECONSTRUCTED from the id by
 * `lib/cell-geometry.ts`, which is also where the antimeridian and pole
 * handling lives.
 *
 * ── Geometry is STATIC, style is not ────────────────────────────────────────
 * A cell's outline never moves — only its colour (ramp over the weight column)
 * and its height (extrusion by the same column) change. The cache is split to
 * match:
 *
 *   - **geometry** (`positionBuffer`, `indexBuffer`, `timeBuffer`, the filter
 *     column, the stroke edge stream) is built ONCE per tile and survives every
 *     `currentTime` advance, every `colorDomain` move and every
 *     `elevationScale` tweak. `test/summary-cell-layer.test.ts` pins that.
 *   - **style** (`colorBuffer`, `weightBuffer`) is re-uploaded when
 *     {@link STTSummaryCellLayerOptions.colorRange} / `colorDomain` /
 *     `weightProperty` move, tracked by a monotone `styleEpoch`.
 *   - `elevationScale`, `opacity`, `lineWidth`, `lineColor` and the whole
 *     DataFilter range surface are UNIFORMS — they move for free.
 *
 * Only `coverage`, `extruded`, `stroked`, `seamMode` and `poleMode` change the
 * baked vertices, and their setters say so by calling `rebuildTileCaches()`.
 *
 * ── Colour ──────────────────────────────────────────────────────────────────
 * `colorRange` + `colorDomain` drive `@poopdeck.gl/core`'s `expandRampColors`
 * (the shared kernel `rampColorAt` sits behind), so a cell shaded by the deck
 * backend and by this one lands on the same RGBA. Unlike deck's summary layers
 * — which QUANTISE into `range.length` buckets — the core kernel INTERPOLATES
 * between stops; the two agree at the stops and differ inside a bucket
 * (smoother here). See {@link STTSummaryCellLayerOptions.colorRange}.
 *
 * With `colorDomain` unset the layer fits the domain itself, MONOTONICALLY
 * WIDENING as tiles arrive (never narrowing, so an eviction can't make the
 * legend jump). deck re-fits across the visible set every render, which
 * flickers as tiles stream; this converges instead. Pinning the domain is still
 * the recommendation.
 *
 * ── Elevation units (D10) ───────────────────────────────────────────────────
 * `elevationScale` is METRES OF HEIGHT PER WEIGHT UNIT and the metres→shader
 * conversion is host-variant-dependent, exactly as in `STTColumnLayer` /
 * `STTPolygonLayer`:
 *   - legacy `uMatrix` and the v5 MERCATOR prelude both take mercator-z, so the
 *     latitude-correct `mercatorZFromAltitude` factor at the tile's own centre
 *     latitude rides in `uMercatorZPerMeter` and multiplies the metres;
 *   - the v5 GLOBE prelude takes METRES while its transition FALLBACK term
 *     wants mercator-z again.
 * Both branches come from the ONE `shaders/globe-elevation.glsl.ts` kernel.
 * Never re-adopt the pre-D10 flat `1e-7` factor (`DEPRECATED_ALTITUDE_SCALE`).
 *
 * ── Globe ───────────────────────────────────────────────────────────────────
 * A summary cell at low zoom is HUGE (an H3 res-2 hexagon spans hundreds of
 * km), so its edges are exactly the case chord subdivision exists for. GLOBE
 * frames refine each cell's fan and its outline to the host's subdivision
 * granularity (`lib/globe.ts`) under their own cache key, and force
 * `seamMode: 'unwrap'` — the ±1 seam twin projects onto the same place on a
 * sphere and would double-blend.
 *
 * ── Picking ─────────────────────────────────────────────────────────────────
 * A CELL is a feature. `drawPickTile` reproduces every gate of the visual pass
 * — the same compiled time mode, the same DataFilter range, the same `opacity`
 * and the same per-cell colour ALPHA — so a cell the user cannot see is never
 * pickable. When `extruded` puts the layer in `renderingMode: '3d'` the base's
 * pick FBO grows a depth attachment and the id pass runs depth-tested, so the
 * cell in FRONT wins the texel.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_SUMMARY_COLOR_RANGE } from '@poopdeck.gl/core';
import { expandRampColors } from '@poopdeck.gl/core/style';
import {
  STTBaseLayer,
  expandPickIdColors,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from '../base-layer.js';
import {
  buildSummaryCellRings,
  cellRingToTriangles,
  type CellRingBatch,
  type CellRingDiagnostics,
  type H3CellToBoundary,
  type PoleMode,
  type SeamMode,
} from '../lib/cell-geometry.js';
import {
  subdivideLineMercator,
  subdivideTrianglesMercator,
} from '../lib/globe.js';
import {
  mercatorZFromAltitude,
  tileCenterLatitude,
} from '../lib/projection.js';
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
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';

/** The four real time-filter modes under this family's name. */
export type SummaryCellTimeFilterMode = STTTimeFilterMode;

/**
 * Brightness multiplier applied to an extruded cell's SIDE WALLS so the prism
 * reads as a solid rather than a silhouette — the package-wide 25%-darker
 * convention (`STTPolygonLayer`'s extrusion walls, `STTColumnLayer.WALL_SHADE`).
 * Duplicated rather than imported so this file takes no dependency on a sibling
 * LAYER; see this wave's concerns for the extraction candidate.
 */
export const SUMMARY_WALL_SHADE = 0.75;

/** deck's STT summary-layer defaults, mirrored so a port reads identically. */
const DEFAULT_WEIGHT_PROPERTY = 'count';
const DEFAULT_COVERAGE = 0.92;
const DEFAULT_ELEVATION_SCALE = 1;
const DEFAULT_LINE_COLOR: RGBA8 = [0, 0, 0, 255];

/** Shared with deck's two summary layers via `@poopdeck.gl/core` (ColorBrewer YlGnBu). */
const DEFAULT_COLOR_RANGE: ReadonlyArray<RGBA8> =
  DEFAULT_SUMMARY_COLOR_RANGE as ReadonlyArray<RGBA8>;

/** Archive layer name the summary tier is baked under when metadata is silent. */
const FALLBACK_SUMMARY_LAYER_NAME = 'summary';

// Immutable stand-in for callers with no host frame: hand-built test
// DrawContexts that omit `frame`. Never mutated.
const LEGACY_FRAME: HostFrame = createHostFrame();

// ── CPU references the shaders mirror (unit-tested) ─────────────────────────

/**
 * Height of one cell vertex in METRES — the JS twin of the shader's
 * `aMercator.z * aWeight * uElevationScale`. `isTop` is 1 on the cap (and on
 * the wall band's upper ring) and 0 on the wall band's ground ring, so a flat
 * cell and every wall foot sit at 0 whatever the weight is.
 */
export function summaryCellElevationMeters(
  isTop: number,
  weight: number,
  elevationScale: number,
): number {
  return isTop * weight * elevationScale;
}

/**
 * Widen `[lo, hi]` by one observation, MONOTONICALLY. Seeded with
 * `[Infinity, -Infinity]`; a non-finite sample is ignored (a NaN weight must
 * not poison the whole legend). Returns the same tuple shape so a caller can
 * compare identity-free.
 *
 * The auto-fit domain never narrows: a tile evicting must not make every
 * remaining cell change colour, which is exactly what deck's re-fit-per-render
 * does when a hot tile scrolls off.
 */
export function widenDomain(
  lo: number,
  hi: number,
  sample: number,
): [number, number] {
  if (!Number.isFinite(sample)) return [lo, hi];
  return [sample < lo ? sample : lo, sample > hi ? sample : hi];
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set. Identical
 * rule to every other kind in this package; exported for the prop-default tests.
 */
export function resolveSummaryTimeFilterMode(
  mode: SummaryCellTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): SummaryCellTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

/** Distinct vertex count of a ring, ignoring a trailing duplicate first vertex. */
function openRingCount(ring: ArrayLike<number>): number {
  const n = ring.length >> 1;
  if (n < 2) return n;
  const closed =
    ring[0] === ring[(n - 1) * 2] && ring[1] === ring[(n - 1) * 2 + 1];
  return closed ? n - 1 : n;
}

// ── options ─────────────────────────────────────────────────────────────────

/** Props shared by both summary-cell kinds. */
export interface STTSummaryCellLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Numeric column driving BOTH the colour ramp and the extrusion height.
   * `'count'` is the implicit per-cell row count every summary tier bakes; any
   * aggregated column works too (`'mean_magnitude'`, `'sum_value'`, …). A tile
   * missing the column paints every cell the ramp's LOW stop and warns once —
   * it never blanks.
   * @default 'count'
   */
  weightProperty?: string;
  /**
   * Low→high gradient stops, each `[r, g, b, a]` in 0–255. Sampled by
   * `@poopdeck.gl/core`'s `rampColorAt`, which INTERPOLATES between stops;
   * deck's summary layers quantise into `colorRange.length` buckets instead, so
   * the two agree at the stops and this one is smoother between them.
   * @default the shared 6-stop YlGnBu summary ramp
   */
  colorRange?: ReadonlyArray<RGBA8>;
  /**
   * `[min, max]` the ramp spans. PIN THIS for a stable legend. Left unset, the
   * layer fits the domain from the cells it has seen, widening monotonically as
   * tiles arrive (never narrowing) — usable out of the box, still not stable
   * across a session.
   * @default null (auto-fit)
   */
  colorDomain?: readonly [number, number] | null;
  /**
   * Shrink each cell toward its own centroid, 0..1 — the heatmap-style gap
   * between neighbours. Applied in MERCATOR by the cell kernel. Geometry-baked:
   * changing it rebuilds the tile caches.
   * @default 0.92 (deck's STT summary-layer default)
   */
  coverage?: number;
  /**
   * Raise each cell into a prism whose top sits at
   * `weight × elevationScale` METRES, with side walls down to the ground.
   * Geometry-baked (the wall band is real vertices), so the setter rebuilds the
   * tile caches. Also decides the DEFAULT {@link renderingMode} — see there
   * before toggling this at runtime.
   * @default false
   */
  extruded?: boolean;
  /**
   * METRES of height per unit of {@link weightProperty}. Uniform-only, so
   * animating the relief is free. Inert while `extruded` is false.
   * @default 1
   */
  elevationScale?: number;
  /** Draw the cell fill. @default true */
  filled?: boolean;
  /**
   * Draw each cell's outline — the hex/quad-grid look. Geometry-baked (an edge
   * instance stream), so the setter rebuilds the tile caches.
   * @default true (deck's summary-layer default)
   */
  stroked?: boolean;
  /** Outline colour. 0–1 floats or 0–255 ints (auto-detected). @default black */
  lineColor?: RGBA8;
  /** Outline width in {@link lineWidthUnits}. Uniform-only. @default 1 */
  lineWidth?: number;
  /**
   * Unit for {@link lineWidth}. **Departs from deck deliberately**: deck's
   * summary layers default to `'meters'`, which at planet-scale summary zooms
   * collapses a 1 m border below one pixel and renders the "hex grid" invisible
   * unless the caller also sets `lineWidthMinPixels`. This backend expands
   * outlines in screen space, so `'pixels'` is both the natural unit and the
   * one that produces deck's INTENDED look out of the box.
   * @default 'pixels'
   */
  lineWidthUnits?: 'pixels' | 'meters';
  /**
   * Layer-wide opacity multiplier, 0..1, applied on top of the ramp's own
   * alpha. Gated in the pick pass too — an `opacity: 0` layer is invisible AND
   * unpickable.
   * @default 1
   */
  opacity?: number;
  /**
   * Name of the archive layer holding the summary rows. Defaults to the
   * archive metadata's `summaryTier.layerName`, then `'summary'`. Layers with a
   * different name are skipped, so a tile that also carries its raw tier does
   * not get decoded as cells.
   */
  summaryLayerName?: string;
  /**
   * Antimeridian policy for cells straddling ±180° (H3 only — a Quadbin cell is
   * an axis-aligned subdivision of the unit square and cannot cross the seam).
   * `'duplicate'` also emits the ∓1 twin so a flat map panned to the seam draws
   * both halves; `'unwrap'` emits one contiguous ring whose x leaves `[0, 1]`.
   * FORCED to `'unwrap'` on globe frames, where the twin lands on the same
   * place and double-blends. Geometry-baked.
   * @default 'duplicate'
   */
  seamMode?: SeamMode;
  /**
   * Policy for a cell that ENCLOSES a pole (H3 only). `'band'` substitutes the
   * full-width mercator rectangle from the pole edge to the cell's
   * equatorward-most vertex (deliberately over-covering: a gap reads as missing
   * data); `'skip'` drops the cell. Geometry-baked.
   * @default 'band'
   */
  poleMode?: PoleMode;
  /**
   * Time-filter mode. Unset ⇒ inferred in deck's precedence order
   * (`wakeLength > 0` ⇒ wake, else `trailLength > 0` ⇒ trail, else window).
   * `'wake'`/`'trail'` degrade to `'window'` when their length knob is
   * non-positive (a zero-length wake would light nothing).
   *
   * COMPILE-TIME and fixed for the layer's lifetime — construct a new layer to
   * change it. Summary cells carry per-FEATURE times, so every mode reveals a
   * whole cell.
   */
  timeFilterMode?: SummaryCellTimeFilterMode;
  /** `wake` mode: ms a cell stays lit after its own start time. @default 0 */
  wakeLength?: number;
  /** `trail` mode: ms a cell stays lit after its own start time. @default 0 */
  trailLength?: number;
  /**
   * `trail` mode head→tail fade: `1`/`true` (default) fades across
   * `trailLength`, `0`/`false` holds full alpha, intermediate numbers blend
   * (package-wide `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
  /**
   * MapLibre `CustomLayerInterface.renderingMode`. Defaults to `'3d'` when
   * {@link extruded} was set at CONSTRUCTION and `'2d'` otherwise, because
   * maplibre reads this once at `addLayer` time: a layer constructed flat and
   * later `setExtruded(true)`-ed keeps the always-on-top 2d depth slab and its
   * prisms will not occlude one another. Pass `'3d'` explicitly when planning
   * to toggle extrusion at runtime.
   */
  renderingMode?: '2d' | '3d';
}

/** {@link STTH3SummaryLayer} options — H3 needs h3-js's boundary resolver. */
export interface STTH3SummaryLayerOptions extends STTSummaryCellLayerOptions {
  /**
   * h3-js's `cellToBoundary`, passed in rather than imported: `h3-js` is not a
   * dependency of `@poopdeck.gl/maplibre` (this package ships zero extra deps
   * beyond `@poopdeck.gl/core` + `earcut`), and an H3 boundary is icosahedral
   * geometry only h3-js can produce.
   *
   * ```ts
   * import { cellToBoundary } from 'h3-js';
   * new STTH3SummaryLayer({ id, url, currentTime, timeWindow, cellToBoundary });
   * ```
   *
   * REQUIRED — omitting it throws from the constructor. That is a wiring bug,
   * not a data condition, and every data condition in this layer degrades
   * silently into {@link STTSummaryCellLayer.getCellDiagnostics} instead.
   */
  cellToBoundary: H3CellToBoundary;
}

/** {@link STTQuadbinSummaryLayer} options — the id decodes with no injection. */
export type STTQuadbinSummaryLayerOptions = STTSummaryCellLayerOptions;

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled summary-cell program supports. Both knobs are structural
 * (they add uniforms/attributes/statements), so each combination is its own
 * program and each must appear in the program-cache key —
 * {@link summaryCellProgramKey}.
 */
export interface SummaryCellShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: SummaryCellTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
}

/** The out-of-the-box configuration: window mode, no column filter. */
const DEFAULT_SHADER_CONFIG: SummaryCellShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

/** The four draw passes, each with its own compiled program. */
export type SummaryCellPass = 'fill' | 'stroke' | 'pick-fill' | 'pick-stroke';

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<SummaryCellTimeFilterMode, string>> =
  Object.freeze({
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  });

/**
 * Uniforms each mode reads. Only the active mode's block is declared, so an
 * unused uniform can never be silently mis-set.
 */
const MODE_UNIFORMS: Readonly<Record<SummaryCellTimeFilterMode, string>> =
  Object.freeze({
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
  });

/**
 * The `vAlpha = …` expression per mode. Every vertex of a cell carries that
 * cell's `aTime`, so `trail` reads `aTime.x` — a cell reveals whole, never
 * half-drawn. (Wake's FOOTPRINT taper has no analogue here: a summary cell's
 * size is its geographic footprint, not a style knob, so shrinking it would
 * lie about which ground the aggregate covers.)
 */
const MODE_ALPHA: Readonly<Record<SummaryCellTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
  });

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * DataFilter application. deck's split: a HARD-filtered feature (`0`) is hidden
 * whatever the transform flags say, while a soft-margin value only fades when
 * `filterTransformColor` is on. `filterTransformSize` is deliberately INERT —
 * a cell's extent is geography, and deck's own SolidPolygonLayer ignores the
 * size transform for the same reason.
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    vAlpha *= (uFilterTransformColor > 0.5) ? filterAlpha : (filterAlpha > 0.0 ? 1.0 : 0.0);
`;

/**
 * Declarations every summary-cell program shares. `aMercator.z` is the
 * static-geometry TOP FLAG (1 on the cap and the wall band's upper ring, 0 on
 * its ground ring) — never a coordinate — which is what lets `elevationScale`
 * stay a uniform while the wall band stays baked.
 */
function sharedDeclarations(
  usesPrelude: boolean,
  cfg: SummaryCellShaderConfig,
): string {
  const legacy = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  return `  attribute vec2 aTime;        // per-vertex [startTime, endTime], tile-relative
  attribute float aWeight;     // per-vertex cell weight (the extrusion driver)
${cfg.filter ? FILTER_ATTRIBUTE : ''}${legacy}  uniform float uElevationScale;    // METRES of height per weight unit (0 = flat)
  uniform float uMercatorZPerMeter; // METRES → mercator-z at this tile's latitude
  uniform float uOpacity;
`;
}

/**
 * Emit the projection of one `(mercatorXY, elevationMetres)` pair into a fresh
 * `vec4 ${out}` clip-space position, via the shared elevated-projection kernel.
 * See the module header for the per-variant unit table.
 */
function projectBlock(
  usesPrelude: boolean,
  out: string,
  xy: string,
  elevM: string,
): string {
  return buildElevatedProjection({
    usesPrelude,
    xy,
    elevMeters: elevM,
    elevMercatorZ: `${elevM} * uMercatorZPerMeter`,
    // The stroke shader projects TWO points in one main(), so every declared
    // name is prefixed with the output's.
    names: {
      out,
      sphere: `${out}Sphere`,
      globe: `${out}Globe`,
      flat: `${out}Flat`,
    },
  });
}

/**
 * Assemble the cell-fill vertex shader.
 *
 * Legacy hosts (empty prelude) keep the `uMatrix` path; v5+ hosts get the
 * injected prelude + define prepended (maplibre's documented order) and project
 * through the elevated kernel — even a FLAT cell goes through it, because
 * `uElevationScale` is a uniform and a layer can be extruded between frames
 * without a relink.
 *
 * A fully-gated cell is dropped twice over: `gl_Position = vec4(0.0)` collapses
 * it at the vertex stage (the gate is per-FEATURE, so the cell collapses whole
 * — no corner left pinned at the origin) and the fragment shader's
 * `if (vAlpha <= 0.0) discard;` backs that up.
 */
function buildFillVs(
  shader: ShaderInjection,
  cfg: SummaryCellShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  // BOTH passes declare the colour attribute. The visual pass paints with it;
  // the id pass reads only its ALPHA, so a cell whose ramp stop is transparent
  // (the idiomatic "hide this bucket" spelling) is invisible AND unpickable —
  // deck's `picking_filterPickingColor` discards on the same condition.
  const idAttribute = isMain
    ? ''
    : '  attribute vec3 aIdColor;     // per-vertex encoded pick id (UNSIGNED_BYTE normalized)\n';
  const varying = isMain
    ? '  varying vec4 vColor;\n'
    : '  varying vec3 vIdColor;\n';
  const colorGate = isMain ? '' : '    vAlpha *= aColor.a;\n';
  const payload = isMain
    ? '    vColor = aColor;\n'
    : '    vIdColor = aIdColor;\n';

  return `${head}
  precision highp float;
  attribute vec3 aMercator;    // [mercatorX, mercatorY, isTop]
${sharedDeclarations(usesPrelude, cfg)}  attribute vec4 aColor;       // per-vertex ramp colour in 0..1 (id pass gates on its alpha)
${idAttribute}${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${varying}${MODE_GLSL[cfg.mode]}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vAlpha = ${MODE_ALPHA[cfg.mode]} * uOpacity;
${cfg.filter ? FILTER_BODY : ''}${colorGate}    float elevM = aMercator.z * aWeight * uElevationScale;
${projectBlock(usesPrelude, 'here', 'aMercator.xy', 'elevM')}    gl_Position = here;
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${payload}  }
`;
}

/**
 * Assemble the cell-outline vertex shader: instanced screen-space line
 * expansion (the `STTLineLayer` / polygon-stroke scheme), one instance per cell
 * edge. Both endpoints are projected at the cell's TOP elevation — the outline
 * has to ride the cap of an extruded cell, not the ground — and the
 * perpendicular offset is applied in screen pixels afterwards, so the expansion
 * math is variant-independent.
 */
function buildStrokeVs(
  shader: ShaderInjection,
  cfg: SummaryCellShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isId = kind === 'id';
  const idAttribute = isId
    ? '  attribute vec3 aIdColor;     // per-instance encoded pick id (UNSIGNED_BYTE normalized)\n'
    : '';
  const idVarying = isId ? '  varying vec3 vIdColor;\n' : '';
  const idAssign = isId ? '    vIdColor = aIdColor;\n' : '';
  // The outline's colour is a UNIFORM, so the id pass declares the same uniform
  // purely to gate on its alpha: an outline drawn `lineColor: [r,g,b,0]` paints
  // nothing and must not be pickable either.
  const colorGate = isId ? '    vAlpha *= uColor.a;\n' : '';

  return `${head}
  precision highp float;
  attribute vec2 aCorner;      // (side, along) per mesh vertex
  attribute vec2 aPosA;        // edge start in mercator, per-instance
  attribute vec2 aPosB;        // edge end in mercator, per-instance
${sharedDeclarations(usesPrelude, cfg)}${idAttribute}  uniform vec2 uViewport;
  uniform float uWidth;
  uniform vec4 uColor;         // outline colour (the FS paints it; the id pass gates on its alpha)
${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${idVarying}${MODE_GLSL[cfg.mode]}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vAlpha = ${MODE_ALPHA[cfg.mode]} * uOpacity;
${cfg.filter ? FILTER_BODY : ''}${colorGate}    float elevM = aWeight * uElevationScale;
    vec2 posM = mix(aPosA, aPosB, aCorner.y);
    vec2 neighborM = mix(aPosB, aPosA, aCorner.y);
${projectBlock(usesPrelude, 'here', 'posM', 'elevM')}${projectBlock(usesPrelude, 'there', 'neighborM', 'elevM')}    vec2 hereNdc = here.xy / here.w;
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
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${idAssign}  }
`;
}

/** Visual cell-fill vertex source for a host variant + feature configuration. */
export function buildSummaryCellVertexSource(
  shader: ShaderInjection,
  cfg: SummaryCellShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildFillVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildSummaryCellVertexSource}. */
export function buildSummaryCellIdVertexSource(
  shader: ShaderInjection,
  cfg: SummaryCellShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildFillVs(shader, cfg, 'id');
}

/** Visual cell-outline vertex source. */
export function buildSummaryCellStrokeVertexSource(
  shader: ShaderInjection,
  cfg: SummaryCellShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildStrokeVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildSummaryCellStrokeVertexSource}. */
export function buildSummaryCellStrokeIdVertexSource(
  shader: ShaderInjection,
  cfg: SummaryCellShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildStrokeVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `STTBaseLayer.getOrCreateProgram` appends `::${variantName}` (the HOST
 * variant) only, so two configurations sharing a base key would collide on one
 * program. The SCHEME is deliberately absent: H3 and Quadbin compile
 * byte-identical shaders (they differ only in CPU cell decoding), and the cache
 * is per layer INSTANCE anyway.
 */
export function summaryCellProgramKey(
  pass: SummaryCellPass,
  cfg: SummaryCellShaderConfig,
): string {
  return `summary-cell:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
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
 * Id-pick fragment stage, shared by the fill and outline pick programs. No
 * blending and no antialiasing: the readback must recover the byte triple
 * exactly. The `vAlpha` discard is what makes time-filtered, DataFilter-hidden,
 * transparent and `opacity: 0` cells unpickable.
 */
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // invisible cells are not pickable
    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;

// ── program handles ─────────────────────────────────────────────────────────

/** Locations every summary-cell program shares. */
interface SharedHandles {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aTime: number;
  aWeight: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uElevationScale: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uWakeLength: WebGLUniformLocation | null;
  uTrailLength: WebGLUniformLocation | null;
  uFadeTrail: WebGLUniformLocation | null;
  uFilterRange: WebGLUniformLocation | null;
  uFilterSoftRange: WebGLUniformLocation | null;
  uFilterEnabled: WebGLUniformLocation | null;
  uFilterTransformColor: WebGLUniformLocation | null;
}

interface FillHandles extends SharedHandles {
  aMercator: number;
  aColor: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
}

interface StrokeHandles extends SharedHandles {
  aCorner: number;
  aPosA: number;
  aPosB: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/** Per-tile stroke (outline) instance stream. */
interface StrokeStream {
  posABuffer: WebGLBuffer;
  posBBuffer: WebGLBuffer;
  timeBuffer: WebGLBuffer;
  /** STYLE buffer — rebuilt with the fill's colour/weight (see `styleEpoch`). */
  weightBuffer?: WebGLBuffer;
  instanceCount: number;
  /** Edge instances contributed by each source ROW (pick-id + filter expansion). */
  instanceCounts: Uint32Array;
  /** Source row per edge instance — drives the style rebuild. */
  sourceIndex: Uint32Array;
  /** Per-edge filter values; absent when the tile lacks the column. */
  filterBuffer?: WebGLBuffer;
}

/** Per-tile GPU cache: static geometry + swappable style buffers. */
interface SummaryCellGpuCache extends TileGpuCache {
  use32BitIndices: boolean;
  /**
   * Full-mercator-square subdivision granularity baked into this cache
   * (0 = unrefined — every mercator host).
   */
  subdivisionGranularity: number;
  /** METRES → mercator-z at this tile's centre latitude (D10), resolved once. */
  mercatorZScale: number;
  /** Rings emitted (cells drawn, seam twins included). */
  cellCount: number;
  /** What the cell kernel had to do to this tile's ids. */
  diagnostics: CellRingDiagnostics;
  /** Source ROW per fill vertex — drives the colour/weight style rebuild. */
  vertexSourceIndex: Uint32Array;
  /** 1 for a wall-band vertex (shaded darker), 0 for a cap vertex. */
  vertexIsWall: Uint8Array;
  /** Fill vertices contributed by each source ROW (pick-id + filter expansion). */
  vertexCounts: Uint32Array;
  /** True when this tile baked the configured filter column (the `enabled` gate). */
  hasFilterColumn: boolean;
  /** Per-fill-vertex filter values; absent when the tile lacks the column. */
  filterBuffer?: WebGLBuffer;
  /** STYLE: per-vertex ramp colour (Uint8 RGBA, wall shading baked in). */
  colorBuffer?: WebGLBuffer;
  /** STYLE: per-vertex cell weight (the extrusion driver). */
  weightBuffer?: WebGLBuffer;
  /** Style generation these buffers were built at; -1 = never built. */
  styleEpoch: number;
  /**
   * Host shader variant the cached VAOs' attribute locations were recorded
   * against — a variant flip may relocate attribute slots.
   */
  vaoVariant?: string;
  stroke?: StrokeStream;
}

/** Accumulator for one tile's geometry bake. */
interface CellMeshBuild {
  positions: number[];
  times: number[];
  indices: number[];
  sources: number[];
  isWall: number[];
  strokeA: number[];
  strokeB: number[];
  strokeTimes: number[];
  strokeSources: number[];
}

// ── the layer ───────────────────────────────────────────────────────────────

/**
 * Shared implementation of the two summary-cell kinds. Subclasses supply only
 * the {@link cellScheme} and (for H3) the injected boundary resolver; see
 * {@link STTH3SummaryLayer} / {@link STTQuadbinSummaryLayer}.
 */
export abstract class STTSummaryCellLayer extends STTBaseLayer {
  /**
   * Host depth participation, decided at CONSTRUCTION (maplibre reads it at
   * `addLayer` time) — see {@link STTSummaryCellLayerOptions.renderingMode}.
   */
  readonly renderingMode: '2d' | '3d';

  protected readonly cellOpts: {
    weightProperty: string;
    colorRange: ReadonlyArray<RGBA8>;
    colorDomain: readonly [number, number] | null;
    coverage: number;
    extruded: boolean;
    elevationScale: number;
    filled: boolean;
    stroked: boolean;
    lineColor: RGBA8;
    lineWidth: number;
    lineWidthUnits: 'pixels' | 'meters';
    opacity: number;
    summaryLayerName?: string;
    seamMode: SeamMode;
    poleMode: PoleMode;
    wakeLength: number;
    trailLength: number;
    fadeTrail: number;
  };

  /** Mutated in place by the filter setters; read by `resolveDataFilterUniforms`. */
  private readonly filterOpts: STTDataFilterOptions;
  /** Allocated once — the per-draw uniform payload never allocates. */
  private readonly filterUniforms = createDataFilterUniforms();

  /**
   * Compiled shader configuration. Both knobs are fixed for the layer's
   * lifetime, so the program-cache keys are built once and the draw path never
   * concatenates a key.
   */
  protected readonly shaderConfig: SummaryCellShaderConfig;
  private readonly programKeys: Readonly<Record<SummaryCellPass, string>>;

  /**
   * Handles of the most recently used host variant, memoized per `*Variant` so
   * the per-tile hot path skips the base cache's key-string build; the cache is
   * only consulted on a variant flip. Matches the sibling flow/column kinds
   * (`STTColumnLayer`); cleared together in {@link onContextLost}.
   */
  private fillHandles?: FillHandles;
  private fillVariant?: string;
  private strokeHandles?: StrokeHandles;
  private strokeVariant?: string;
  private pickFillHandles?: FillHandles;
  private pickFillVariant?: string;
  private pickStrokeHandles?: StrokeHandles;
  private pickStrokeVariant?: string;

  /**
   * True while the host is on (or transitioning to) the globe — the only
   * projection state BAKED geometry depends on (chord subdivision + the seam
   * policy). Observed in {@link beginFrame}, before any cache build.
   */
  private frameIsGlobe = false;

  /**
   * Style generation. Bumped by `colorRange` / `colorDomain` / `weightProperty`
   * moves AND by an auto-domain widening; a cache whose `styleEpoch` lags is
   * re-styled (colour + weight only) on its next draw.
   */
  private styleEpoch = 0;
  /** Auto-fit domain accumulator, monotone (see {@link widenDomain}). */
  private autoLo = Infinity;
  private autoHi = -Infinity;

  private warnedCategoricalFilter = false;
  private warnedMissingWeight = false;
  private warnedLayerName = false;
  private warnedMissingIds = false;
  private warnedUndecodable = false;
  private warnedScheme = false;

  constructor(opts: STTSummaryCellLayerOptions) {
    super(opts);
    const extruded = opts.extruded ?? false;
    // `??` (not a spread) so an explicitly passed `renderingMode: undefined`
    // still lands on the default.
    this.renderingMode = opts.renderingMode ?? (extruded ? '3d' : '2d');
    this.cellOpts = {
      weightProperty: opts.weightProperty ?? DEFAULT_WEIGHT_PROPERTY,
      colorRange: opts.colorRange ?? DEFAULT_COLOR_RANGE,
      colorDomain: opts.colorDomain ?? null,
      coverage: opts.coverage ?? DEFAULT_COVERAGE,
      extruded,
      elevationScale: opts.elevationScale ?? DEFAULT_ELEVATION_SCALE,
      filled: opts.filled ?? true,
      stroked: opts.stroked ?? true,
      lineColor: opts.lineColor ?? DEFAULT_LINE_COLOR,
      lineWidth: opts.lineWidth ?? 1,
      lineWidthUnits: opts.lineWidthUnits ?? 'pixels',
      opacity: opts.opacity ?? 1,
      summaryLayerName: opts.summaryLayerName,
      seamMode: opts.seamMode ?? 'duplicate',
      poleMode: opts.poleMode ?? 'band',
      wakeLength: opts.wakeLength ?? 0,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.filterOpts = {
      filterProperty: opts.filterProperty,
      filterRange: opts.filterRange,
      filterSoftRange: opts.filterSoftRange,
      filterEnabled: opts.filterEnabled,
      filterTransformSize: opts.filterTransformSize,
      filterTransformColor: opts.filterTransformColor,
    };
    this.shaderConfig = Object.freeze({
      mode: resolveSummaryTimeFilterMode(
        opts.timeFilterMode,
        this.cellOpts.wakeLength,
        this.cellOpts.trailLength,
      ),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
    });
    this.programKeys = Object.freeze({
      fill: summaryCellProgramKey('fill', this.shaderConfig),
      stroke: summaryCellProgramKey('stroke', this.shaderConfig),
      'pick-fill': summaryCellProgramKey('pick-fill', this.shaderConfig),
      'pick-stroke': summaryCellProgramKey('pick-stroke', this.shaderConfig),
    });
  }

  // ── subclass seam ─────────────────────────────────────────────────────────

  /** Which cell family this layer decodes (`'h3'` / `'quadbin'`). */
  protected abstract readonly cellScheme: 'h3' | 'quadbin';

  /** h3-js's `cellToBoundary`; undefined for the Quadbin kind. */
  protected readonly cellToBoundary?: H3CellToBoundary;

  /**
   * Summary tiles bake the cell CENTROID as the row's geometry, so the tier
   * arrives as POINT features and the ring is reconstructed from the id.
   */
  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  // ── runtime setters ───────────────────────────────────────────────────────

  /** Replace the colour ramp. Style-only: re-uploads colours, no geometry rebuild. */
  setColorRange(range: ReadonlyArray<RGBA8>): void {
    this.cellOpts.colorRange = range;
    this.invalidateStyle();
  }

  /**
   * Pin (or release, with `null`) the ramp domain. Style-only. Releasing it
   * restarts the monotone auto-fit from the next tile styled.
   */
  setColorDomain(domain: readonly [number, number] | null): void {
    this.cellOpts.colorDomain = domain;
    if (!domain) {
      this.autoLo = Infinity;
      this.autoHi = -Infinity;
    }
    this.invalidateStyle();
  }

  /**
   * Drive colour + height from a different aggregated column. Style-only (the
   * cell OUTLINES do not depend on the weight), and the auto-fit domain resets
   * because the old one describes a different quantity.
   */
  setWeightProperty(property: string): void {
    if (this.cellOpts.weightProperty === property) return;
    this.cellOpts.weightProperty = property;
    this.autoLo = Infinity;
    this.autoHi = -Infinity;
    this.warnedMissingWeight = false;
    this.invalidateStyle();
  }

  /** Metres of height per weight unit. Uniform-only. */
  setElevationScale(scale: number): void {
    this.cellOpts.elevationScale = scale;
    this.map?.triggerRepaint();
  }

  /** Layer-wide opacity multiplier, 0..1. Uniform-only. */
  setOpacity(opacity: number): void {
    this.cellOpts.opacity = opacity;
    this.map?.triggerRepaint();
  }

  /** Outline colour. Uniform-only. */
  setLineColor(color: RGBA8): void {
    this.cellOpts.lineColor = color;
    this.map?.triggerRepaint();
  }

  /** Outline width, in `lineWidthUnits`. Uniform-only. */
  setLineWidth(width: number): void {
    this.cellOpts.lineWidth = width;
    this.map?.triggerRepaint();
  }

  /** Toggle the cell fill. Uniform-free — it just skips a pass. */
  setFilled(filled: boolean): void {
    this.cellOpts.filled = filled;
    this.map?.triggerRepaint();
  }

  /**
   * Toggle the cell outline. The edge instance stream is BAKED per tile, so
   * this rebuilds the caches (which also triggers the repaint).
   */
  setStroked(stroked: boolean): void {
    if (this.cellOpts.stroked === stroked) return;
    this.cellOpts.stroked = stroked;
    this.rebuildTileCaches();
  }

  /**
   * Toggle extrusion. The wall band is BAKED vertices, so this rebuilds the
   * caches. NOTE it cannot change {@link renderingMode} — maplibre read that at
   * `addLayer` time; construct with `renderingMode: '3d'` when planning to
   * toggle.
   */
  setExtruded(extruded: boolean): void {
    if (this.cellOpts.extruded === extruded) return;
    this.cellOpts.extruded = extruded;
    this.rebuildTileCaches();
  }

  /** Shrink cells toward their centroid, 0..1. Geometry-baked ⇒ full rebuild. */
  setCoverage(coverage: number): void {
    if (this.cellOpts.coverage === coverage) return;
    this.cellOpts.coverage = coverage;
    this.rebuildTileCaches();
  }

  /**
   * Move the DataFilter's hard `[min, max]` bounds (the slider hot path).
   * Uniform-only: no relink, no tile rebuild. `null` idles the filter, which
   * renders everything. Passing `softRange` explicitly (including `null`)
   * replaces the soft margin; omitting it leaves the configured one alone.
   */
  setFilterRange(
    range: DataFilterRange | null,
    softRange?: DataFilterRange | null,
  ): void {
    this.filterOpts.filterRange = range;
    if (softRange !== undefined) this.filterOpts.filterSoftRange = softRange;
    this.map?.triggerRepaint();
  }

  /** Move the DataFilter's soft fade margin alone. Uniform-only. */
  setFilterSoftRange(range: DataFilterRange | null): void {
    this.filterOpts.filterSoftRange = range;
    this.map?.triggerRepaint();
  }

  /** Master DataFilter switch. `false` renders every cell unfiltered. */
  setFilterEnabled(enabled: boolean): void {
    this.filterOpts.filterEnabled = enabled;
    this.map?.triggerRepaint();
  }

  /**
   * What the cell kernel had to do to the currently-cached tiles, summed:
   * decoded cells, rows skipped (undecodable id / degenerate boundary), seam
   * crossings and their emitted twins, pole cells and pole drops. Surfaced (not
   * hidden) so an app can say "12 polar cells are drawn as bands" rather than
   * mis-drawing silently.
   */
  getCellDiagnostics(): CellRingDiagnostics {
    const out: CellRingDiagnostics = {
      cells: 0,
      skipped: 0,
      seamCells: 0,
      duplicated: 0,
      poleCells: 0,
      poleSkipped: 0,
    };
    for (const cache of this.tileGpuCache.values()) {
      const d = (cache as SummaryCellGpuCache | null)?.diagnostics;
      if (!d) continue;
      out.cells += d.cells;
      out.skipped += d.skipped;
      out.seamCells += d.seamCells;
      out.duplicated += d.duplicated;
      out.poleCells += d.poleCells;
      out.poleSkipped += d.poleSkipped;
    }
    return out;
  }

  /** The ramp domain in force right now (pinned, else the monotone auto-fit). */
  getColorDomain(): readonly [number, number] {
    if (this.cellOpts.colorDomain) return this.cellOpts.colorDomain;
    return [
      Number.isFinite(this.autoLo) ? this.autoLo : 0,
      Number.isFinite(this.autoHi) ? this.autoHi : 1,
    ];
  }

  /** Bump the style generation; every cache re-uploads colour + weight lazily. */
  private invalidateStyle(): void {
    this.styleEpoch++;
    this.map?.triggerRepaint();
  }

  // ── GL lifecycle ──────────────────────────────────────────────────────────

  protected onContextReady(): void {
    // Programs are linked lazily per shader variant through the base
    // `getOrCreateProgram` cache (a v5 host recompiles per projection variant;
    // after a context restore the cache is empty and relinks on the first draw).
  }

  protected onContextLost(): void {
    // Program handles live in the base variant cache, which the base layer
    // invalidates on context loss and dispose. This layer holds no GPU handle
    // of its own outside the per-tile caches (also base-owned) — only the
    // per-variant handle MEMOS, whose programs the base cache is dropping, so
    // release the references and let the next frame re-resolve them.
    this.fillHandles = undefined;
    this.fillVariant = undefined;
    this.strokeHandles = undefined;
    this.strokeVariant = undefined;
    this.pickFillHandles = undefined;
    this.pickFillVariant = undefined;
    this.pickStrokeHandles = undefined;
    this.pickStrokeVariant = undefined;
  }

  /**
   * GL state for the frame. Departs from the base in exactly one way: on a
   * `'3d'` layer (an extruded cell grid) the host has already installed its
   * LEQUAL read-write depth mode before calling us, so we LEAVE IT ALONE —
   * disabling `DEPTH_TEST` the way the flat layers do is what would make prisms
   * paint in tile order instead of by depth.
   */
  protected applySharedGlState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.renderingMode !== '3d') gl.disable(gl.DEPTH_TEST);
  }

  /**
   * Track whether the host is on the globe BEFORE any tile cache is (re)built
   * this frame — the only projection state baked cell geometry depends on
   * (chord subdivision, and the seam policy that goes with it).
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
   * Subdivided globe geometry lives under its own key (the polygon/line scheme)
   * so the flat mercator entry stays unpolluted and a globe ⇄ mercator flip
   * reuses either side without rebuilds. The key carries the baked granularity,
   * so a runtime `setProjection` that moves the host's subdivision curve
   * rebuilds under a new key instead of keeping chords that horizon-clip. The
   * `z/x/y/t::` prefix matches the base tileKey format so the base unload sweep
   * frees every variant.
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

  // ── tile geometry (STATIC) ────────────────────────────────────────────────

  /** Archive layer name the summary rows live under for this archive. */
  private resolveSummaryLayerName(): string {
    return (
      this.cellOpts.summaryLayerName ??
      this.metadata?.summaryTier?.layerName ??
      FALLBACK_SUMMARY_LAYER_NAME
    );
  }

  /**
   * Should this (tile, layer) be decoded as summary cells? Rejects the raw tier
   * by NAME, and warns once about the two configuration mistakes that otherwise
   * present as a silently empty map: a cell-looking layer under an unexpected
   * name, and the right layer with no u64 id column.
   */
  private acceptsSummaryLayer(layer: STTLayer): boolean {
    const want = this.resolveSummaryLayerName();
    if (layer.name !== want) {
      if (layer.features.featureIds64 && !this.warnedLayerName) {
        this.warnedLayerName = true;
        console.warn(
          `[${this.id}] skipping layer '${layer.name}': it carries a u64 id column but ` +
            `this layer decodes '${want}' — pass summaryLayerName to override`,
        );
      }
      return false;
    }
    if (!layer.features.featureIds64) {
      if (!this.warnedMissingIds) {
        this.warnedMissingIds = true;
        console.warn(
          `[${this.id}] summary layer '${want}' has no u64 id column ` +
            `(BinaryFeatures.featureIds64); rebuild with \`stt-build --summary-tier ${this.cellScheme}\``,
        );
      }
      return false;
    }
    if (
      !this.warnedScheme &&
      this.metadata?.summaryTier &&
      this.metadata.summaryTier.scheme !== this.cellScheme
    ) {
      this.warnedScheme = true;
      console.warn(
        `[${this.id}] archive summary tier is '${this.metadata.summaryTier.scheme}' but this ` +
          `layer decodes '${this.cellScheme}' cells — every cell id will fail to decode`,
      );
    }
    return true;
  }

  /**
   * Bake one summary tile's cells: ids → mercator rings → a centroid-fan mesh
   * (plus the wall band when extruded and the edge stream when stroked). Runs
   * ONCE per tile per projection variant; nothing here is per-frame.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): SummaryCellGpuCache | null {
    if (!this.acceptsSummaryLayer(layer)) return null;
    const f = layer.features;

    // Globe correctness (D4): refine long chords to the host's subdivision
    // granularity, and drop the seam twin (it projects onto the same place on a
    // sphere and would double-blend). Mercator — legacy OR the v5 prelude — is
    // affine, so chords there are exact and no subdivision runs.
    const granularity = this.frameIsGlobe
      ? this.tileSubdivisionGranularity(tile.id.z)
      : 0;

    const batch = buildSummaryCellRings(
      this.cellScheme,
      f.featureIds64,
      f.featureCount,
      {
        coverage: this.cellOpts.coverage,
        seamMode: this.frameIsGlobe ? 'unwrap' : this.cellOpts.seamMode,
        poleMode: this.cellOpts.poleMode,
        cellToBoundary: this.cellToBoundary,
      },
    );
    if (batch.ringCount === 0) {
      this.warnUndecodable(batch.diagnostics, f.featureCount);
      return null;
    }
    this.warnUndecodable(batch.diagnostics, f.featureCount);

    // DataFilter column (deck DataFilterExtension parity): a missing or
    // categorical column resolves to hasColumn=false, which the uniform
    // resolver turns into `enabled: 0` — the tile renders UNFILTERED, never
    // blank.
    const filterColumn = extractFilterColumn(f, this.filterOpts.filterProperty);
    if (filterColumn.categorical && !this.warnedCategoricalFilter) {
      this.warnedCategoricalFilter = true;
      console.warn(
        `[${this.id}] filterProperty '${this.filterOpts.filterProperty}' is a ` +
          'categorical column; range filtering needs a numeric one — rendering unfiltered',
      );
    }

    const build = this.bakeCellMesh(batch, f, granularity);
    const totalVertices = build.positions.length / 3;
    if (totalVertices === 0) return null;

    const use32 = totalVertices > 65535;
    if (use32 && !this.supports32BitIndices) {
      console.warn(
        `[${this.id}] summary tile has ${totalVertices} cell vertices, but this WebGL1 ` +
          'runtime lacks OES_element_index_uint; dropping tile',
      );
      return null;
    }

    const vertexCounts = new Uint32Array(f.featureCount);
    for (const source of build.sources) vertexCounts[source]++;
    const strokeCounts = new Uint32Array(f.featureCount);
    for (const source of build.strokeSources) strokeCounts[source]++;

    const extras: WebGLBuffer[] = [];
    const positionBuffer = this.uploadArrayBuffer(
      gl,
      new Float32Array(build.positions),
    );
    const timeBuffer = this.uploadArrayBuffer(
      gl,
      new Float32Array(build.times),
    );
    const indicesArr = use32
      ? new Uint32Array(build.indices)
      : new Uint16Array(build.indices);
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indicesArr, gl.STATIC_DRAW);

    // Per-ROW filter values → per fill VERTEX (this layer's draw unit). Cells
    // are emitted in row order (seam twins immediately after their original),
    // so the sequential expansion lines up exactly.
    let filterBuffer: WebGLBuffer | undefined;
    if (filterColumn.values) {
      filterBuffer = this.uploadArrayBuffer(
        gl,
        expandFilterValues(filterColumn.values, vertexCounts, totalVertices),
      );
      extras.push(filterBuffer);
    }

    let stroke: StrokeStream | undefined;
    if (
      this.cellOpts.stroked &&
      build.strokeSources.length > 0 &&
      this.instSupport.enabled
    ) {
      const count = build.strokeSources.length;
      const posABuffer = this.uploadArrayBuffer(
        gl,
        new Float32Array(build.strokeA),
      );
      const posBBuffer = this.uploadArrayBuffer(
        gl,
        new Float32Array(build.strokeB),
      );
      const strokeTimeBuffer = this.uploadArrayBuffer(
        gl,
        new Float32Array(build.strokeTimes),
      );
      extras.push(posABuffer, posBBuffer, strokeTimeBuffer);
      let strokeFilter: WebGLBuffer | undefined;
      if (filterColumn.values) {
        strokeFilter = this.uploadArrayBuffer(
          gl,
          expandFilterValues(filterColumn.values, strokeCounts, count),
        );
        extras.push(strokeFilter);
      }
      stroke = {
        posABuffer,
        posBBuffer,
        timeBuffer: strokeTimeBuffer,
        instanceCount: count,
        instanceCounts: strokeCounts,
        sourceIndex: Uint32Array.from(build.strokeSources),
        filterBuffer: strokeFilter,
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
      mercatorZScale: mercatorZFromAltitude(
        1,
        tileCenterLatitude(tile.id.z, tile.id.y),
      ),
      cellCount: batch.ringCount,
      diagnostics: batch.diagnostics,
      vertexSourceIndex: Uint32Array.from(build.sources),
      vertexIsWall: Uint8Array.from(build.isWall),
      vertexCounts,
      hasFilterColumn: filterColumn.hasColumn,
      filterBuffer,
      styleEpoch: -1,
      extraBuffers: extras,
      stroke,
    };
  }

  private warnUndecodable(
    diagnostics: CellRingDiagnostics,
    rows: number,
  ): void {
    if (this.warnedUndecodable || rows === 0) return;
    if (diagnostics.cells > 0 || diagnostics.skipped === 0) return;
    this.warnedUndecodable = true;
    console.warn(
      `[${this.id}] no cell id in this summary tile decoded as ${this.cellScheme}; ` +
        'is the archive built with a different --summary-tier scheme?',
    );
  }

  /**
   * The bake itself, ring by ring. Per ring: a CENTROID fan for the cap
   * (subdivided on globe), then — when extruded — a self-contained wall band
   * over the ring outline, then — when stroked — that outline's edges as
   * instances.
   *
   * Per-RING (rather than one merged `triangulateCellRings` call) because both
   * the wall band and the globe subdivision need to stay inside one cell: the
   * mesh subdivider appends midpoints at the END of its output, so a merged
   * refine would produce vertices with no cell to attribute — and the
   * per-vertex source row is the only path back to a cell's colour, weight,
   * filter value and pick id.
   */
  private bakeCellMesh(
    batch: CellRingBatch,
    features: STTLayer['features'],
    granularity: number,
  ): CellMeshBuild {
    const build: CellMeshBuild = {
      positions: [],
      times: [],
      indices: [],
      sources: [],
      isWall: [],
      strokeA: [],
      strokeB: [],
      strokeTimes: [],
      strokeSources: [],
    };
    const extruded = this.cellOpts.extruded;
    const stroked = this.cellOpts.stroked;
    let vertexCount = 0;

    const emit = (
      x: number,
      y: number,
      isTop: number,
      wall: number,
      source: number,
      ts: number,
      te: number,
    ): void => {
      build.positions.push(x, y, isTop);
      build.times.push(ts, te);
      build.sources.push(source);
      build.isWall.push(wall);
      vertexCount++;
    };

    for (let r = 0; r < batch.ringCount; r++) {
      const start = batch.ringOffsets[r];
      const end = batch.ringOffsets[r + 1];
      const ring = batch.positions.subarray(start * 2, end * 2);
      const openCount = openRingCount(ring);
      if (openCount < 3) continue;
      const source = batch.sourceIndices[r];
      const ts = features.startTimes[source] ?? 0;
      const te = features.endTimes[source] ?? 0;

      // ---- cap: a centroid fan, refined on globe ----
      const fan = cellRingToTriangles(ring);
      if (!fan) continue;
      let capPositions = fan.positions;
      let capIndices: Uint32Array = fan.indices;
      if (granularity > 0) {
        const sub = subdivideTrianglesMercator(
          fan.positions,
          fan.indices,
          granularity,
        );
        capPositions = sub.positions;
        capIndices = sub.indices;
      }
      const capBase = vertexCount;
      const capVertices = capPositions.length / 2;
      for (let v = 0; v < capVertices; v++) {
        emit(
          capPositions[v * 2],
          capPositions[v * 2 + 1],
          1,
          0,
          source,
          ts,
          te,
        );
      }
      for (let i = 0; i < capIndices.length; i++) {
        build.indices.push(capBase + capIndices[i]);
      }

      if (!extruded && !stroked) continue;

      // ---- the outline both the wall band and the stroke pass ride ----
      const outline = this.ringOutline(ring, openCount, granularity);
      const m = outline.length / 2;
      if (m < 3) continue;

      if (extruded) {
        // Self-contained band: its own duplicated top ring so the walls can
        // carry SUMMARY_WALL_SHADE without darkening the cap, plus a ground
        // ring at isTop = 0.
        const wallTop = vertexCount;
        for (let v = 0; v < m; v++) {
          emit(outline[v * 2], outline[v * 2 + 1], 1, 1, source, ts, te);
        }
        const wallBottom = vertexCount;
        for (let v = 0; v < m; v++) {
          emit(outline[v * 2], outline[v * 2 + 1], 0, 1, source, ts, te);
        }
        for (let v = 0; v < m; v++) {
          const next = (v + 1) % m;
          const tA = wallTop + v;
          const tB = wallTop + next;
          const bA = wallBottom + v;
          const bB = wallBottom + next;
          build.indices.push(tA, bA, tB, tB, bA, bB);
        }
      }

      if (stroked) {
        for (let v = 0; v < m; v++) {
          const next = (v + 1) % m;
          build.strokeA.push(outline[v * 2], outline[v * 2 + 1]);
          build.strokeB.push(outline[next * 2], outline[next * 2 + 1]);
          build.strokeTimes.push(ts, te);
          build.strokeSources.push(source);
        }
      }
    }

    return build;
  }

  /**
   * The cell's OPEN outline (no repeated closing vertex), refined to
   * `granularity` on globe. Consumers wrap with modulo exactly like the
   * unrefined ring.
   */
  private ringOutline(
    ring: Float64Array,
    openCount: number,
    granularity: number,
  ): Float64Array {
    if (granularity <= 0) return ring.subarray(0, openCount * 2);
    const closed = new Float64Array((openCount + 1) * 2);
    closed.set(ring.subarray(0, openCount * 2));
    closed[openCount * 2] = ring[0];
    closed[openCount * 2 + 1] = ring[1];
    const refined = subdivideLineMercator(closed, granularity).positions;
    return refined.subarray(0, refined.length - 2);
  }

  // ── tile style (colour + weight) ──────────────────────────────────────────

  /**
   * Re-upload this tile's STYLE buffers when the style generation moved (a
   * ramp/domain/weight-column change, or another tile widening the auto-fit
   * domain). Geometry, times and the filter column are untouched — that is the
   * whole point of the split.
   */
  private ensureTileStyle(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    layer: STTLayer,
    cache: SummaryCellGpuCache,
  ): void {
    if (cache.styleEpoch === this.styleEpoch) return;
    const f = layer.features;
    const weights = this.getNumericProperty(f, this.cellOpts.weightProperty);
    if (!weights && !this.warnedMissingWeight) {
      this.warnedMissingWeight = true;
      console.warn(
        `[${this.id}] summary tile has no numeric column '${this.cellOpts.weightProperty}'; ` +
          "cells render at the ramp's low stop — check weightProperty against the tier's columns",
      );
    }

    // Widen the auto-fit domain from the cells this tile actually drew, BEFORE
    // resolving it. Widening bumps the epoch so every other cache re-styles;
    // it is monotone and bounded, so the cascade terminates.
    if (!this.cellOpts.colorDomain && weights) {
      let lo = this.autoLo;
      let hi = this.autoHi;
      for (let row = 0; row < cache.vertexCounts.length; row++) {
        if (cache.vertexCounts[row] === 0) continue;
        [lo, hi] = widenDomain(lo, hi, weights[row]);
      }
      if (lo !== this.autoLo || hi !== this.autoHi) {
        this.autoLo = lo;
        this.autoHi = hi;
        this.styleEpoch++;
        this.map?.triggerRepaint();
      }
    }

    const domain = this.getColorDomain();
    const range = this.cellOpts.colorRange;
    // Per-ROW ramp colours from the shared core kernel (`rampColorAt` behind
    // `expandRampColors`), so a cell shaded here and by the deck backend lands
    // on the same RGBA.
    const cellColors = expandRampColors(
      f,
      {
        property: this.cellOpts.weightProperty,
        domain,
        range,
        fallback: range.length > 0 ? range[0] : [0, 0, 0, 255],
      },
      'u8',
    ) as Uint8Array;

    const n = cache.vertexCount;
    const colors = new Uint8Array(n * 4);
    const vertexWeights = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      const source = cache.vertexSourceIndex[v];
      const base = source * 4;
      const shade = cache.vertexIsWall[v] ? SUMMARY_WALL_SHADE : 1;
      colors[v * 4] = cellColors[base] * shade;
      colors[v * 4 + 1] = cellColors[base + 1] * shade;
      colors[v * 4 + 2] = cellColors[base + 2] * shade;
      colors[v * 4 + 3] = cellColors[base + 3];
      vertexWeights[v] = weights ? weights[source] : 0;
    }

    let strokeWeights: Float32Array | undefined;
    if (cache.stroke) {
      strokeWeights = new Float32Array(cache.stroke.instanceCount);
      for (let i = 0; i < strokeWeights.length; i++) {
        strokeWeights[i] = weights ? weights[cache.stroke.sourceIndex[i]] : 0;
      }
    }

    this.releaseStyleBuffers(gl, cache);
    const extras = cache.extraBuffers ?? (cache.extraBuffers = []);
    cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
    cache.weightBuffer = this.uploadArrayBuffer(gl, vertexWeights);
    extras.push(cache.colorBuffer, cache.weightBuffer);
    if (cache.stroke && strokeWeights) {
      cache.stroke.weightBuffer = this.uploadArrayBuffer(gl, strokeWeights);
      extras.push(cache.stroke.weightBuffer);
    }
    cache.styleEpoch = this.styleEpoch;
  }

  /**
   * Free the previous style buffers and every VAO that recorded them. A VAO
   * captures the BUFFER a `vertexAttribPointer` was bound to, so leaving one
   * alive after a colour re-upload would keep drawing the freed handle.
   */
  private releaseStyleBuffers(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    cache: SummaryCellGpuCache,
  ): void {
    const drop: WebGLBuffer[] = [];
    if (cache.colorBuffer) drop.push(cache.colorBuffer);
    if (cache.weightBuffer) drop.push(cache.weightBuffer);
    if (cache.stroke?.weightBuffer) drop.push(cache.stroke.weightBuffer);
    cache.colorBuffer = undefined;
    cache.weightBuffer = undefined;
    if (cache.stroke) cache.stroke.weightBuffer = undefined;
    if (drop.length === 0) return;
    if (cache.extraBuffers) {
      cache.extraBuffers = cache.extraBuffers.filter((b) => !drop.includes(b));
    }
    for (const b of drop) gl.deleteBuffer(b);
    if (cache.vao) this.vaoSupport.delete(cache.vao);
    if (cache.strokeVao) this.vaoSupport.delete(cache.strokeVao);
    cache.vao = undefined;
    cache.strokeVao = undefined;
  }

  // ── uniforms ──────────────────────────────────────────────────────────────

  /** METRES of height per weight unit — 0 collapses the prism to a flat cell. */
  private effectiveElevationScale(): number {
    return this.cellOpts.extruded ? this.cellOpts.elevationScale : 0;
  }

  /**
   * Outline width in DEVICE pixels (what the screen-space expansion offsets
   * in). `'meters'` converts at the tile's centre latitude and the FRACTIONAL
   * zoom, crossing the device-pixel ratio exactly like the line layer's
   * `widthUnits`.
   */
  private resolveLineWidth(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { lineWidth, lineWidthUnits } = this.cellOpts;
    if (lineWidthUnits !== 'meters') return lineWidth;
    return this.metricPixelScale(gl, tile, ctx, lineWidth);
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active
   * mode's uniforms exist in the program, so the switch is also what keeps a
   * stale mode's uniform from being written to a null location every draw.
   * `uCurrentTime` follows the package convention: absolute time minus the
   * tile's own `timeOffset`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: SharedHandles,
    cache: SummaryCellGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.cellOpts;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uTrailLength, o.trailLength);
        gl.uniform1f(h.uFadeTrail, o.fadeTrail);
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
   * Upload the DataFilter uniforms for this tile. No-op unless the filter was
   * compiled in. A tile that didn't bake the column resolves to `enabled: 0`,
   * which the kernel reads as "render everything" — never as "hide everything".
   * `transformSize` is intentionally unset (see {@link FILTER_BODY}).
   */
  private setFilterUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: SharedHandles,
    cache: SummaryCellGpuCache,
  ): void {
    if (!this.shaderConfig.filter) return;
    const u = resolveDataFilterUniforms(
      this.filterUniforms,
      this.filterOpts,
      cache.hasFilterColumn,
    );
    gl.uniform2fv(h.uFilterRange, u.range);
    gl.uniform2fv(h.uFilterSoftRange, u.softRange);
    gl.uniform1f(h.uFilterEnabled, u.enabled);
    gl.uniform1f(h.uFilterTransformColor, u.transformColor);
  }

  /**
   * Projection + elevation + opacity + time + filter uniforms — everything the
   * visual and id passes set identically, so the pickable cell always matches
   * the drawn one (including on globe, where the prelude owns projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: SharedHandles,
    cache: SummaryCellGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform1f(h.uElevationScale, this.effectiveElevationScale());
    gl.uniform1f(h.uMercatorZPerMeter, cache.mercatorZScale);
    gl.uniform1f(h.uOpacity, this.cellOpts.opacity);
    this.setTimeUniforms(gl, h, cache, ctx);
    this.setFilterUniforms(gl, h, cache);
  }

  // ── program resolution ────────────────────────────────────────────────────

  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): SharedHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aTime: gl.getAttribLocation(program, 'aTime'),
      aWeight: gl.getAttribLocation(program, 'aWeight'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uElevationScale: gl.getUniformLocation(program, 'uElevationScale'),
      uMercatorZPerMeter: gl.getUniformLocation(program, 'uMercatorZPerMeter'),
      uOpacity: gl.getUniformLocation(program, 'uOpacity'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
      uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
      uWakeLength: gl.getUniformLocation(program, 'uWakeLength'),
      uTrailLength: gl.getUniformLocation(program, 'uTrailLength'),
      uFadeTrail: gl.getUniformLocation(program, 'uFadeTrail'),
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

  private buildFillHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): FillHandles {
    const program = this.linkProgram(
      gl,
      pick
        ? buildSummaryCellIdVertexSource(shader, this.shaderConfig)
        : buildSummaryCellVertexSource(shader, this.shaderConfig),
      pick ? ID_FS_SOURCE : FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      // Both passes declare it: the visual pass paints with it, the id pass
      // gates on its alpha (see buildFillVs).
      aColor: gl.getAttribLocation(program, 'aColor'),
      aIdColor: pick ? gl.getAttribLocation(program, 'aIdColor') : -1,
    };
  }

  private buildStrokeHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): StrokeHandles {
    const program = this.linkProgram(
      gl,
      pick
        ? buildSummaryCellStrokeIdVertexSource(shader, this.shaderConfig)
        : buildSummaryCellStrokeVertexSource(shader, this.shaderConfig),
      pick ? ID_FS_SOURCE : STROKE_FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aPosA: gl.getAttribLocation(program, 'aPosA'),
      aPosB: gl.getAttribLocation(program, 'aPosB'),
      aIdColor: pick ? gl.getAttribLocation(program, 'aIdColor') : -1,
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uWidth: gl.getUniformLocation(program, 'uWidth'),
      uColor: gl.getUniformLocation(program, 'uColor'),
    };
  }

  private readonly fillFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): FillHandles => this.buildFillHandles(gl, shader, false);

  private readonly pickFillFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): FillHandles => this.buildFillHandles(gl, shader, true);

  private readonly strokeFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): StrokeHandles => this.buildStrokeHandles(gl, shader, false);

  private readonly pickStrokeFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): StrokeHandles => this.buildStrokeHandles(gl, shader, true);

  // ── attribute binding ─────────────────────────────────────────────────────

  /** Bind the per-vertex stream the fill passes share. */
  private bindFillAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: FillHandles,
    cache: SummaryCellGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

    if (cache.weightBuffer && h.aWeight >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.weightBuffer);
      gl.enableVertexAttribArray(h.aWeight);
      gl.vertexAttribPointer(h.aWeight, 1, gl.FLOAT, false, 0, 0);
    }
    if (cache.colorBuffer && h.aColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.colorBuffer);
      gl.enableVertexAttribArray(h.aColor);
      gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    }
    if (cache.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
    }
    // VAOs capture the element-array binding too.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cache.indexBuffer!);
  }

  /** Bind the per-edge instance stream the stroke passes share. */
  private bindStrokeAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: StrokeHandles,
    stroke: StrokeStream,
    quad: WebGLBuffer,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(h.aCorner);
    gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCorner, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, stroke.posABuffer);
    gl.enableVertexAttribArray(h.aPosA);
    gl.vertexAttribPointer(h.aPosA, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aPosA, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, stroke.posBBuffer);
    gl.enableVertexAttribArray(h.aPosB);
    gl.vertexAttribPointer(h.aPosB, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aPosB, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, stroke.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aTime, 1);

    if (stroke.weightBuffer && h.aWeight >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, stroke.weightBuffer);
      gl.enableVertexAttribArray(h.aWeight);
      gl.vertexAttribPointer(h.aWeight, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aWeight, 1);
    }
    if (stroke.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, stroke.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 1);
    }
  }

  /**
   * Undo {@link bindStrokeAttributes} on the DEFAULT VAO after a pick pass.
   * Attribute divisors are per-VAO state and a pick runs outside the host's
   * render pass, so every per-instance slot must go back to 0 — otherwise the
   * next non-instanced draw that lands on the same slot reads one element per
   * INSTANCE instead of per vertex.
   */
  private releaseStrokeAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: StrokeHandles,
    stroke: StrokeStream,
  ): void {
    gl.disableVertexAttribArray(h.aCorner);
    gl.disableVertexAttribArray(h.aPosA);
    this.instSupport.vertexAttribDivisor(h.aPosA, 0);
    gl.disableVertexAttribArray(h.aPosB);
    this.instSupport.vertexAttribDivisor(h.aPosB, 0);
    gl.disableVertexAttribArray(h.aTime);
    this.instSupport.vertexAttribDivisor(h.aTime, 0);
    if (stroke.weightBuffer && h.aWeight >= 0) {
      gl.disableVertexAttribArray(h.aWeight);
      this.instSupport.vertexAttribDivisor(h.aWeight, 0);
    }
    if (stroke.filterBuffer && h.aFilterValue >= 0) {
      gl.disableVertexAttribArray(h.aFilterValue);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 0);
    }
  }

  // ── draw ──────────────────────────────────────────────────────────────────

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const c = cache as SummaryCellGpuCache;
    if (c.vertexCount === 0) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;

    // A style re-upload replaces the colour/weight buffers AND drops the VAOs
    // that recorded them, so it has to run before any binding decision.
    this.ensureTileStyle(gl, layer, c);

    // VAO recordings capture attribute locations of the variant's linked
    // program; a variant flip (v5 mercator ⇄ globe) may relocate them, so drop
    // the recordings and re-capture under the new programs.
    if (c.vaoVariant !== variant) {
      if (c.vao) this.vaoSupport.delete(c.vao);
      if (c.strokeVao) this.vaoSupport.delete(c.strokeVao);
      c.vao = undefined;
      c.strokeVao = undefined;
      c.vaoVariant = variant;
    }

    if (this.cellOpts.filled) {
      // Per-variant memo: the base cache is consulted only on a variant flip,
      // so the steady per-tile path never rebuilds a program-cache key string.
      let h = this.fillHandles;
      if (!h || this.fillVariant !== variant) {
        h = this.getOrCreateProgram(
          gl,
          this.programKeys.fill,
          frame,
          this.fillFactory,
        );
        this.fillHandles = h;
        this.fillVariant = variant;
      }
      gl.useProgram(h.program);
      this.setSharedUniforms(gl, h, c, ctx, frame);
      this.bindVaoOrSetup(c, () => this.bindFillAttributes(gl, h!, c));
      const indexType = c.use32BitIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl.TRIANGLES, c.indexCount, indexType, 0);
    }

    if (this.cellOpts.stroked && c.stroke && this.instSupport.enabled) {
      const s = c.stroke;
      let sh = this.strokeHandles;
      if (!sh || this.strokeVariant !== variant) {
        sh = this.getOrCreateProgram(
          gl,
          this.programKeys.stroke,
          frame,
          this.strokeFactory,
        );
        this.strokeHandles = sh;
        this.strokeVariant = variant;
      }
      gl.useProgram(sh.program);
      this.setSharedUniforms(gl, sh, c, ctx, frame);
      gl.uniform2f(sh.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(sh.uWidth, this.resolveLineWidth(gl, tile, ctx));
      gl.uniform4fv(
        sh.uColor,
        this.rgba01Uniform('LineColor', this.cellOpts.lineColor),
      );
      const quad = this.getUnitQuad(gl);
      this.bindVaoOrSetup(
        c,
        () => this.bindStrokeAttributes(gl, sh!, s, quad),
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
   * Draw this summary tile into the id-pick FBO, painting cell `i` the flat
   * colour `encodePickId(idBase + i)`. Mirrors {@link drawTile}'s projection
   * (including the v5+ prelude variant), its elevation maths and — critically —
   * its ALPHA GATES: the same compiled time mode, the same DataFilter range,
   * the same `opacity` and the same per-cell colour alpha, so a cell the user
   * cannot see is never pickable. Browser-verify-only (the enclosing FBO
   * round-trip needs a live GPU); the id-colour build + decode join are
   * unit-tested in the base.
   *
   * The id attributes are rebuilt per pick and freed immediately: `idBase`
   * shifts with whatever tiles are loaded this frame, and picks are rare
   * user-initiated events, so a persistent per-tile buffer would be stale cache
   * for no win. Raw attribute binds (no VAO) for the same reason.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const c = cache as SummaryCellGpuCache;
    if (c.vertexCount === 0) return;
    const { filled, stroked } = this.cellOpts;
    // Nothing drawn is nothing pickable — and nothing to allocate for either.
    if (!filled && !stroked) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    this.ensureTileStyle(gl, layer, c);
    // `featureCount` — not the cache's count-array length — is what the base
    // sized the id range from, so painting can never spill past
    // `idBase + count`. `expandPickIdColors` clamps the other direction.
    const featureIds = this.buildPickIdColors(
      layer.features.featureCount,
      idBase,
    );

    if (filled) {
      let h = this.pickFillHandles;
      if (!h || this.pickFillVariant !== variant) {
        h = this.getOrCreateProgram(
          gl,
          this.programKeys['pick-fill'],
          frame,
          this.pickFillFactory,
        );
        this.pickFillHandles = h;
        this.pickFillVariant = variant;
      }
      const idBuffer = this.uploadArrayBuffer(
        gl,
        expandPickIdColors(featureIds, c.vertexCounts, c.vertexCount),
      );
      gl.useProgram(h.program);
      this.setSharedUniforms(gl, h, c, ctx, frame);
      this.bindFillAttributes(gl, h, c);
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.enableVertexAttribArray(h.aIdColor);
      gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);

      const indexType = c.use32BitIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl.TRIANGLES, c.indexCount, indexType, 0);

      // Leave the default-VAO attribute slate clean for the next visual frame.
      gl.disableVertexAttribArray(h.aMercator);
      gl.disableVertexAttribArray(h.aTime);
      gl.disableVertexAttribArray(h.aIdColor);
      if (c.weightBuffer && h.aWeight >= 0) {
        gl.disableVertexAttribArray(h.aWeight);
      }
      if (c.colorBuffer && h.aColor >= 0) gl.disableVertexAttribArray(h.aColor);
      if (c.filterBuffer && h.aFilterValue >= 0) {
        gl.disableVertexAttribArray(h.aFilterValue);
      }
      gl.deleteBuffer(idBuffer);
    }

    if (stroked && c.stroke && this.instSupport.enabled) {
      const s = c.stroke;
      let sh = this.pickStrokeHandles;
      if (!sh || this.pickStrokeVariant !== variant) {
        sh = this.getOrCreateProgram(
          gl,
          this.programKeys['pick-stroke'],
          frame,
          this.pickStrokeFactory,
        );
        this.pickStrokeHandles = sh;
        this.pickStrokeVariant = variant;
      }
      const idBuffer = this.uploadArrayBuffer(
        gl,
        expandPickIdColors(featureIds, s.instanceCounts, s.instanceCount),
      );
      gl.useProgram(sh.program);
      this.setSharedUniforms(gl, sh, c, ctx, frame);
      gl.uniform2f(sh.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(sh.uWidth, this.resolveLineWidth(gl, tile, ctx));
      // Same outline colour as the visual pass — the id stage reads its alpha,
      // so a fully transparent outline is not a hit target.
      gl.uniform4fv(
        sh.uColor,
        this.rgba01Uniform('LineColor', this.cellOpts.lineColor),
      );
      const quad = this.getUnitQuad(gl);
      this.bindStrokeAttributes(gl, sh, s, quad);
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.enableVertexAttribArray(sh.aIdColor);
      gl.vertexAttribPointer(sh.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      this.instSupport.vertexAttribDivisor(sh.aIdColor, 1);

      this.instSupport.drawArraysInstanced(
        0x0005 /* TRIANGLE_STRIP */,
        0,
        4,
        s.instanceCount,
      );

      gl.disableVertexAttribArray(sh.aIdColor);
      this.instSupport.vertexAttribDivisor(sh.aIdColor, 0);
      this.releaseStrokeAttributes(gl, sh, s);
      gl.deleteBuffer(idBuffer);
    }
  }
}

/**
 * Render an STT archive's summary tier as H3 hexagons — the native-maplibre
 * counterpart of deck's `H3SummaryLayer`.
 *
 * ```ts
 * import { cellToBoundary } from 'h3-js';
 *
 * const layer = new STTH3SummaryLayer({
 *   id: 'quakes-summary',
 *   url: '/data/earthquakes-summary.stt',
 *   currentTime: t0,
 *   timeWindow: 86_400_000,
 *   cellToBoundary,          // REQUIRED — see the option's doc
 *   weightProperty: 'count',
 *   colorDomain: [0, 500],   // pin it: the auto-fit is only a starting point
 * });
 * layer.attach(map);
 * ```
 *
 * `cellToBoundary` is injected rather than imported because `h3-js` is not a
 * dependency of this package; the same function `@poopdeck.gl/layers` and
 * `@poopdeck.gl/three` use, so all three backends resolve identical cells.
 */
export class STTH3SummaryLayer extends STTSummaryCellLayer {
  protected readonly cellScheme = 'h3' as const;
  protected readonly cellToBoundary: H3CellToBoundary;

  constructor(opts: STTH3SummaryLayerOptions) {
    super(opts);
    if (typeof opts.cellToBoundary !== 'function') {
      throw new Error(
        `[${opts.id}] STTH3SummaryLayer requires opts.cellToBoundary ` +
          "(pass h3-js's cellToBoundary); an H3 boundary is icosahedral geometry " +
          'this package cannot derive on its own',
      );
    }
    this.cellToBoundary = opts.cellToBoundary;
  }
}

/**
 * Render an STT archive's summary tier as CARTO Quadbin cells — the
 * native-maplibre counterpart of deck's `QuadbinSummaryLayer`.
 *
 * ```ts
 * const layer = new STTQuadbinSummaryLayer({
 *   id: 'trips-summary',
 *   url: '/data/trips-summary.stt',
 *   currentTime: t0,
 *   timeWindow: 3_600_000,
 *   extruded: true,
 *   elevationScale: 20,      // metres per ride
 * });
 * layer.attach(map);
 * ```
 *
 * A Quadbin id decodes to an axis-aligned `(z, x, y)` mercator quad with no
 * trigonometry and no injected resolver, so this kind needs nothing beyond the
 * shared option surface — and neither the antimeridian nor the pole machinery
 * can ever fire for it.
 */
export class STTQuadbinSummaryLayer extends STTSummaryCellLayer {
  protected readonly cellScheme = 'quadbin' as const;

  constructor(opts: STTQuadbinSummaryLayerOptions) {
    super(opts);
  }
}
