/**
 * Runtime hexbin adapter — bins the RAW POINT tier into a world-space hexagonal
 * lattice and renders one instanced prism per occupied cell. The native twin of
 * `@poopdeck.gl/layers`'s `AnimatedHexagonLayer`.
 *
 * ── Why this is not the h3/quadbin path ─────────────────────────────────────
 * The first question this kind has to answer is whether the archive carries
 * pre-binned cells. It does not. `AnimatedHexagonLayer` wraps deck's canonical
 * `HexagonLayer`, which **aggregates raw points at runtime** (GPU by default):
 * every visible tile's points are consolidated into one buffer set and the bin
 * sorter re-runs whenever the time window moves. There is no stored cell id
 * anywhere — `cell-geometry.ts` says so in its own header ("hexbin — NOT a
 * stored cell id"), and the lattice constants there are copied from deck's
 * `hexbin.ts` precisely so a native layer can reproduce the same bins CPU-side.
 * So hexbin is genuinely a different machine from `h3Summary`/`quadbinSummary`
 * (which read a `SummaryScheme` cell id straight off `featureIds64`), and the
 * descriptor's `hexbin → h3Summary` fallback was never equivalent.
 *
 * ── The lattice, and why bins do not seam at tile borders ───────────────────
 * The bin address of a point is a pure function of `(mercatorXY, radiusMerc)` —
 * `hexBinKeyForPoint`, deck's `pointToHexbin` verbatim. It is a WORLD-space
 * grid: it does not move with the camera and it knows nothing about tiles. Two
 * points either side of a tile boundary that fall in the same hexagon produce
 * the SAME packed key.
 *
 * That gets us identical addresses; it does not by itself get us one cell. The
 * seam fix is the **union bin table** ({@link HexbinTable}), rebuilt whenever
 * the resident tile set / radius / weight column changes and NEVER per frame:
 *
 *   1. per TILE, at tile-upload time, each point's packed bin key is computed
 *      once and cached on the tile's GPU cache (`binKeys`); this is the only
 *      O(points) trigonometry-free pass and it survives every table rebuild;
 *   2. per TABLE build, every tile's keys are merged through one
 *      `Map<key, denseIndex>`, so a hexagon straddling a tile boundary
 *      collapses to ONE dense index fed by BOTH tiles' points;
 *   3. each tile then gets a per-point `aBinIndex` attribute (the dense index),
 *      re-uploaded into the SAME `WebGLBuffer` so per-tile VAOs stay valid;
 *   4. the draw is ONE instanced call over `binCount` prisms — a boundary cell
 *      is drawn once, with the summed weight of both tiles, never twice with
 *      half the weight each.
 *
 * The radius must be resolved at ONE latitude for the whole layer (deck uses
 * its data-bounds centroid). A per-tile latitude would make the lattice pitch
 * drift between tiles and the cells would not line up — `cell-geometry.ts`
 * documents that trap on {@link hexBinRadiusFromMeters}. This layer resolves it
 * once, from `radiusLatitude` → the archive's own `metadata.bounds` centre →
 * the map's bounds centre, and holds it (see {@link resolveLatitude}).
 *
 * ── Aggregation: on the GPU, per frame, for free ────────────────────────────
 * Binning is time-INDEPENDENT; only which points COUNT depends on the play
 * head. So the CPU work above is done once per tile set, and the windowed
 * aggregate is recomputed every frame on the GPU by a scatter pass:
 *
 *   pass 1 (aggregate)  every resident point is drawn as a 1-pixel `gl.POINTS`
 *                       primitive AT ITS OWN BIN'S TEXEL in a tiny float FBO,
 *                       additively blended, writing `vec2(weight·gate, gate)`.
 *                       `gate` is the compiled time-filter mode's alpha times
 *                       the DataFilter alpha — the SAME kernels every other
 *                       layer in this package uses, evaluated per POINT. The
 *                       pass needs no projection at all (the bin index already
 *                       encodes position), so it has no host variant.
 *   pass 2 (cells)      `binCount` instanced hexagonal prisms; each samples its
 *                       own texel (vertex texture fetch), maps the aggregate
 *                       through `colorDomain` → the palette and through
 *                       `elevationDomain` → `elevationRange` metres.
 *
 * Net cost per frame: one point-draw over the resident points (exactly what the
 * heatmap already pays) plus one instanced draw. Zero CPU. Cells genuinely
 * appear, re-colour and re-rise as the window slides, which is the whole point
 * of an animated hexbin — and all four time modes plus the DataFilter fall out
 * of the shared kernels rather than being reimplemented.
 *
 * ── CPU fallback ────────────────────────────────────────────────────────────
 * The GPU path needs a colour-renderable FLOAT texture (RGBA8 additive blending
 * clamps at 1.0, which is useless for a sum) and vertex texture fetch. Where
 * either is missing — or when `gpuAggregation: false` — the layer falls back to
 * a CPU aggregate computed at TABLE-BUILD time from the shared JS reference
 * kernels ({@link aggregateHexbinsCpu}), uploaded as a per-instance attribute.
 * That fallback does not track the play head between rebuilds, and it warns
 * once saying so: it is exactly the divergence deck documents for its own CPU
 * aggregator ("the CPU aggregator ignores the time window").
 *
 * ── Elevation units ─────────────────────────────────────────────────────────
 * `elevationRange` is METRES. Cells are not tied to one tile, so the
 * metres→mercator-z factor is resolved once per layer at {@link resolveLatitude}
 * (not per tile as in `STTColumnLayer`), and the globe branch is fed metres
 * while the mercator branch is fed mercator-z, through the shared
 * `buildElevatedProjection` kernel. A flat `1e-7` factor is latitude-blind and
 * ~4× too tall — never substitute one.
 *
 * ── Deliberate divergences from deck (all declared, none silent) ────────────
 *  - `MIN` / `MAX` aggregation degrade to `SUM` with a one-time warning: an
 *    extremum needs `blendEquation(MIN|MAX)` and its own channel, which is a
 *    second scatter pass for an operation no hexbin demo uses.
 *  - `colorScaleType` supports `'quantize'` (deck's default, baked into the
 *    palette texture with NEAREST sampling) and `'linear'`; `'quantile'` /
 *    `'ordinal'` need a CPU sort of the LIVE aggregate and degrade to quantize.
 *  - The auto colour domain is sampled from the CPU aggregate at table-build
 *    time and then HELD, instead of deck's per-window re-range. Holding it is
 *    the better default for playback (deck's hexbin visibly re-normalizes, and
 *    therefore flickers, every time the window slides); pin `colorDomain` to
 *    take the decision yourself.
 *  - No lighting `material` (nothing in this backend is lit) and no
 *    `colorMapping` (an aggregate has no category).
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import { MAX_PICK_ID, type SttPickResult } from '@poopdeck.gl/core/picking';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type STTFilterableLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type PickProvenanceEntry,
  type TileGpuCache,
  type RGBA8,
} from '../base-layer.js';
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
  TIME_MODE_UNIFORM_DECLS,
  resolveTimeUniformLocations,
  timeWindowAlphaJS,
  wakeAlphaJS,
  cumulativeAlphaJS,
  trailAlphaJS,
  type TimeUniformLocations,
} from '../shaders/time-window.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  createDataFilterUniforms,
  dataFilterAlphaJS,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  resolveDataFilterUniforms,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type DataFilterUniforms,
  type FilterTransformSizeUniformLocation,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
import {
  hexBinCentroidMercator,
  hexBinKeyForPoint,
  hexBinKeyI,
  hexBinKeyJ,
  hexBinRadiusFromMeters,
  hexBinToMercatorRing,
} from '../lib/cell-geometry.js';
import {
  lngLatToMercatorInto,
  mercatorZFromAltitude,
} from '../lib/projection.js';

/** The four real time-filter modes, under this layer's name. */
export type HexbinTimeFilterMode = STTTimeFilterMode;

/**
 * Aggregation vocabulary — deck's `AggregationOperation`. `'MIN'`/`'MAX'` are
 * accepted for API parity and degrade to `'SUM'` (module header).
 */
export type HexbinAggregation = 'SUM' | 'MEAN' | 'MIN' | 'MAX' | 'COUNT';

/** Colour-scale vocabulary. `'quantile'`/`'ordinal'` degrade to `'quantize'`. */
export type HexbinScaleType = 'quantize' | 'linear' | 'quantile' | 'ordinal';

/** The three ops that reach a compiled shader. */
type CompiledAggregation = 'SUM' | 'MEAN' | 'COUNT';

/** Which side of the scatter FBO the cell pass reads. */
type AggregateSource = 'gpu' | 'cpu';

// ── deck-parity defaults ────────────────────────────────────────────────────

/** deck `HexagonLayer.radius` — METRES. */
const DEFAULT_RADIUS_METERS = 1000;
/** deck `HexagonLayer.elevationRange` — METRES. */
const DEFAULT_ELEVATION_RANGE: readonly [number, number] = [0, 1000];

/**
 * deck's canonical `HexagonLayer` ramp — ColorBrewer 6-class YlOrRd, low →
 * high aggregated weight. Byte-identical to `AnimatedHexagonLayer`'s
 * `DEFAULT_COLOR_RANGE`, transcribed here because core's `palettes.ts` has no
 * hexbin entry yet (extraction candidate — see the package concerns).
 */
export const DEFAULT_HEXBIN_COLOR_RANGE: ReadonlyArray<RGBA8> = Object.freeze([
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [240, 59, 32, 255],
  [189, 0, 38, 255],
] as RGBA8[]);

/**
 * Brightness multiplier on the prism's SIDE WALLS. Same 25%-darker convention
 * `STTColumnLayer` and `STTPolygonLayer` use — one backend, one look.
 */
export const HEXBIN_WALL_SHADE = 0.75;

/** Widest scatter texture we allocate before wrapping to a second row block. */
const AGGREGATE_TEX_WIDTH = 1024;

/** Palette texture resolution (matches the heatmap's ramp texture). */
const PALETTE_SIZE = 256;

/** `MAX_TEXTURE_SIZE`, spelled as a literal (the test recorder has no enum). */
const GL_MAX_TEXTURE_SIZE = 0x0d33;
/** `MAX_VERTEX_TEXTURE_IMAGE_UNITS`, same reason. */
const GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8b4c;

// Immutable stand-in for callers with no host frame (hand-built test contexts).
const LEGACY_FRAME: HostFrame = createHostFrame();

// ── CPU geometry ────────────────────────────────────────────────────────────

/** A unit-space hexagonal prism mesh, shared by every instance of one layer. */
export interface HexbinMesh {
  /** Stride-4 vertices: `[unitX, unitY, unitZ (0|1), shade]`. */
  vertices: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

/**
 * The unit hexagon: `hexBinToMercatorRing(0, 0, 1)` re-centred on the origin.
 *
 * Deriving it from the kernel rather than re-deriving the trigonometry is the
 * point — bin `(0, 0)` at radius 1 has centroid `(0, 1)`
 * ({@link hexBinCentroidMercator}), so subtracting that centroid turns the
 * kernel's own ring into the unit shape the instanced mesh scales by
 * `radiusMerc`. Winding, the pointy-top orientation and the closing-vertex
 * convention therefore cannot drift from the CPU ring builder.
 *
 * Returns 6 OPEN vertices (the closing duplicate is stripped) as a flat
 * `[x0, y0, …]` `Float64Array`.
 */
export function hexbinUnitRing(): Float64Array {
  const ring = hexBinToMercatorRing(0, 0, 1);
  const [cx, cy] = hexBinCentroidMercator(0, 0, 1);
  // 7 closed vertices in, 6 open out.
  const out = new Float64Array(12);
  for (let k = 0; k < 6; k++) {
    out[k * 2] = ring[k * 2] - cx;
    out[k * 2 + 1] = ring[k * 2 + 1] - cy;
  }
  return out;
}

/** CPU mesh cache, keyed by `extruded` — pure geometry, so one entry per page. */
const HEXBIN_MESH_CACHE = new Map<0 | 1, HexbinMesh>();

/**
 * Build (or fetch) the unit hexagonal prism.
 *
 * `extruded: false` emits the top cap alone (a flat hexagon on the ground, with
 * `uElevationScale` folded to 0 by the draw path); `extruded: true` adds a
 * self-contained wall band carrying {@link HEXBIN_WALL_SHADE}, so the cap can
 * stay at full brightness. Structurally identical to `STTColumnLayer`'s
 * `buildColumnMesh`; a third prism kind is the trigger to hoist both into a
 * shared `lib/prism-mesh.ts`.
 */
export function buildHexbinMesh(extruded: boolean): HexbinMesh {
  const key: 0 | 1 = extruded ? 1 : 0;
  const hit = HEXBIN_MESH_CACHE.get(key);
  if (hit) return hit;

  const ring = hexbinUnitRing();
  const n = 6;
  const vertexCount = extruded ? n * 3 : n;
  const out = new Float32Array(vertexCount * 4);
  const idx: number[] = [];

  for (let i = 0; i < n; i++) {
    out[i * 4] = ring[i * 2];
    out[i * 4 + 1] = ring[i * 2 + 1];
    out[i * 4 + 2] = 1;
    out[i * 4 + 3] = 1;
  }
  // A hexagon is convex ⇒ a fan from vertex 0 triangulates it exactly.
  for (let i = 1; i < n - 1; i++) idx.push(0, i, i + 1);

  if (extruded) {
    const wallTop = n;
    const wallBottom = n * 2;
    for (let i = 0; i < n; i++) {
      const t = (wallTop + i) * 4;
      out[t] = ring[i * 2];
      out[t + 1] = ring[i * 2 + 1];
      out[t + 2] = 1;
      out[t + 3] = HEXBIN_WALL_SHADE;
      const b = (wallBottom + i) * 4;
      out[b] = ring[i * 2];
      out[b + 1] = ring[i * 2 + 1];
      out[b + 2] = 0;
      out[b + 3] = HEXBIN_WALL_SHADE;
    }
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const tA = wallTop + i;
      const tB = wallTop + next;
      const bA = wallBottom + i;
      const bB = wallBottom + next;
      idx.push(tA, bA, tB, tB, bA, bB);
    }
  }

  const mesh: HexbinMesh = {
    vertices: out,
    indices: Uint16Array.from(idx),
    vertexCount,
    indexCount: idx.length,
  };
  HEXBIN_MESH_CACHE.set(key, mesh);
  return mesh;
}

// ── CPU references the shaders mirror (unit-tested) ─────────────────────────

/**
 * Scatter-texture dimensions for `binCount` bins. Width is capped at
 * {@link AGGREGATE_TEX_WIDTH} so a small table stays a single short row block
 * and a big one grows downwards; texel `k` lives at
 * `(k % width, floor(k / width))`.
 */
export function hexbinTextureSize(binCount: number): {
  width: number;
  height: number;
} {
  if (binCount <= 0) return { width: 0, height: 0 };
  const width = Math.min(binCount, AGGREGATE_TEX_WIDTH);
  return { width, height: Math.ceil(binCount / width) };
}

/**
 * Texel CENTRE uv of dense bin `index` — the JS twin of the scatter shader's
 * `(vec2(col, row) + 0.5) / uBinTexSize` and of the value the cell pass binds
 * as `aBinCoord`. One implementation, so scatter and gather cannot disagree
 * about which texel a bin owns.
 */
export function hexbinTexelUv(
  index: number,
  width: number,
  height: number,
): [number, number] {
  const col = index % width;
  const row = Math.floor(index / width);
  return [(col + 0.5) / width, (row + 0.5) / height];
}

/**
 * The aggregated value of one cell — the JS twin of the shader's compiled
 * aggregation expression. `sum` is `Σ weight·gate` and `count` is `Σ gate`
 * (both fractional under a fading time mode), exactly what the scatter pass
 * accumulates into the R and G channels.
 */
export function hexbinCellValue(
  sum: number,
  count: number,
  op: HexbinAggregation,
): number {
  switch (compileAggregation(op)) {
    case 'COUNT':
      return count;
    case 'MEAN':
      return sum / Math.max(count, 1e-6);
    default:
      return sum;
  }
}

/** Collapse the deck vocabulary onto the three ops the shader compiles. */
function compileAggregation(op: HexbinAggregation): CompiledAggregation {
  if (op === 'COUNT') return 'COUNT';
  if (op === 'MEAN') return 'MEAN';
  // MIN / MAX degrade to SUM — see the module header.
  return 'SUM';
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set. Identical
 * rule to every other layer in the package.
 */
export function resolveHexbinTimeFilterMode(
  mode: HexbinTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): HexbinTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

/** Time-gate parameters shared by the CPU aggregator and the scatter uniforms. */
export interface HexbinTimeGate {
  mode: HexbinTimeFilterMode;
  /** Tile-RELATIVE current time. */
  currentTime: number;
  /** Tile-RELATIVE window bounds (window mode). */
  windowStart: number;
  windowEnd: number;
  fadeIn: number;
  fadeOut: number;
  wakeLength: number;
  trailLength: number;
  fadeTrail: number;
}

/**
 * One point's temporal gate — the JS twin of the scatter shader's
 * `<MODE_ALPHA>` expression, routed through the SAME reference implementations
 * (`timeWindowAlphaJS` / `wakeAlphaJS` / `cumulativeAlphaJS` / `trailAlphaJS`)
 * the shared GLSL kernels ship. Both times are tile-relative.
 */
export function hexbinTimeAlphaJS(
  startTime: number,
  endTime: number,
  gate: HexbinTimeGate,
): number {
  switch (gate.mode) {
    case 'wake':
      return wakeAlphaJS(startTime, gate.currentTime, gate.wakeLength);
    case 'cumulative':
      return cumulativeAlphaJS(startTime, gate.currentTime, gate.fadeIn);
    case 'trail':
      return trailAlphaJS(
        startTime,
        gate.currentTime,
        gate.trailLength,
        gate.fadeTrail,
      );
    default:
      return timeWindowAlphaJS(
        startTime,
        endTime,
        gate.windowStart,
        gate.windowEnd,
        gate.fadeIn,
        gate.fadeOut,
      );
  }
}

/** One tile's contribution to a CPU aggregate pass. */
export interface HexbinContribution {
  /** Dense bin index per point; `-1` drops the point. */
  binIndex: Int32Array;
  /** Per-point weight (1s when no weight column). */
  weights: Float32Array;
  /** Per-point tile-relative start times. */
  startTimes: Float32Array;
  /** Per-point tile-relative end times. */
  endTimes: Float32Array;
  /** Per-point DataFilter column, or null when this tile didn't bake one. */
  filterValues: Float32Array | null;
  /** Time gate resolved against THIS tile's `timeOffset`. */
  gate: HexbinTimeGate;
}

/** Per-bin `Σ weight·gate` / `Σ gate`, interleaved `[sum0, count0, sum1, …]`. */
export type HexbinAggregate = Float32Array;

/**
 * The CPU aggregator — the exact arithmetic the GPU scatter pass performs,
 * written once in JS.
 *
 * It has two jobs, and being one function is what keeps them consistent:
 *  - it samples the auto colour / elevation domain at table-build time on the
 *    GPU path (which never reads back its own FBO), and
 *  - it IS the aggregate on the CPU fallback path.
 *
 * Both gates multiply into the contribution exactly as they do in the shader: a
 * point half-faded by a wake counts half. Points whose `binIndex` is negative
 * (unpackable lattice address) are dropped, never folded into bin 0.
 */
export function aggregateHexbinsCpu(
  binCount: number,
  contributions: readonly HexbinContribution[],
  filter: STTDataFilterOptions | null,
  filterUniforms: DataFilterUniforms,
): HexbinAggregate {
  const out = new Float32Array(binCount * 2);
  for (const c of contributions) {
    const hasFilter = Boolean(filter && c.filterValues);
    if (hasFilter) {
      resolveDataFilterUniforms(filterUniforms, filter!, true);
    }
    const n = c.binIndex.length;
    for (let i = 0; i < n; i++) {
      const bin = c.binIndex[i];
      if (bin < 0 || bin >= binCount) continue;
      let gate = hexbinTimeAlphaJS(c.startTimes[i], c.endTimes[i], c.gate);
      if (gate <= 0) continue;
      if (hasFilter) {
        gate *= dataFilterAlphaJS(
          c.filterValues![i],
          filterUniforms.range,
          filterUniforms.softRange,
          filterUniforms.enabled > 0.5,
        );
        if (gate <= 0) continue;
      }
      out[bin * 2] += c.weights[i] * gate;
      out[bin * 2 + 1] += gate;
    }
  }
  return out;
}

/**
 * `[min, max]` of the cell values in an aggregate, restricted to the
 * `[lowerPercentile, upperPercentile]` band of the OCCUPIED cells (deck's
 * percentile clipping). Empty cells (`count <= 0`) never participate — they are
 * absence, not a zero sample.
 *
 * Returns `null` when nothing is occupied, which the caller reads as "keep the
 * previous domain" rather than collapsing the ramp onto `[0, 0]`.
 */
export function hexbinValueDomain(
  aggregate: HexbinAggregate,
  op: HexbinAggregation,
  lowerPercentile = 0,
  upperPercentile = 100,
): [number, number] | null {
  const binCount = aggregate.length / 2;
  const values: number[] = [];
  for (let b = 0; b < binCount; b++) {
    if (aggregate[b * 2 + 1] <= 0) continue;
    values.push(hexbinCellValue(aggregate[b * 2], aggregate[b * 2 + 1], op));
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const lo = clamp01((lowerPercentile ?? 0) / 100);
  const hi = clamp01((upperPercentile ?? 100) / 100);
  const last = values.length - 1;
  const loIdx = Math.min(last, Math.max(0, Math.round(lo * last)));
  const hiIdx = Math.min(last, Math.max(loIdx, Math.round(hi * last)));
  return [values[loIdx], values[hiIdx]];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/** What a compiled SCATTER program supports (no projection ⇒ no host variant). */
export interface HexbinScatterConfig {
  /** Time-filter mode compiled into the gate. */
  mode: HexbinTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
}

/** What a compiled CELL program supports. */
export interface HexbinCellConfig {
  /** Aggregation driving the COLOUR channel. */
  colorAggregation: HexbinAggregation;
  /** Aggregation driving the ELEVATION channel. */
  elevationAggregation: HexbinAggregation;
  /** Where the per-cell aggregate comes from. */
  source: AggregateSource;
}

const DEFAULT_SCATTER_CONFIG: HexbinScatterConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

const DEFAULT_CELL_CONFIG: HexbinCellConfig = Object.freeze({
  colorAggregation: 'SUM',
  elevationAggregation: 'SUM',
  source: 'gpu',
});

/** Draw passes, each with its own compiled program. */
export type HexbinPass = 'scatter' | 'cell' | 'pick-cell';

const MODE_GLSL: Readonly<Record<HexbinTimeFilterMode, string>> = Object.freeze(
  {
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  },
);

/**
 * The gate expression per mode. A hexbin point contributes `weight · gate`, so
 * unlike the geometry layers there is no separate size transform — the wake's
 * taper shows up as a lighter contribution rather than a smaller cell, which is
 * the only thing a bin CAN do with a fading member.
 */
const MODE_ALPHA: Readonly<Record<HexbinTimeFilterMode, string>> =
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
 * Assemble the SCATTER vertex source: one point per raw feature, positioned at
 * its bin's texel rather than at its own location.
 *
 * There is no projection here at all — the dense bin index already encodes
 * where the point is — so this program has NO host variant and is identical on
 * v3, v5-mercator, v5-globe and mapbox. That is also why the whole aggregate
 * survives a projection-variant flip untouched.
 *
 * A gated-out point (outside the time window, hard-filtered, or carrying an
 * unpackable lattice address) is pushed outside the clip volume with
 * `gl_PointSize = 0.0`, so it costs no fragment and contributes nothing.
 */
export function buildHexbinScatterVertexSource(
  cfg: HexbinScatterConfig = DEFAULT_SCATTER_CONFIG,
): string {
  const filterAlpha = cfg.filter
    ? `    gate *= ${DATA_FILTER_CALL_GLSL};\n`
    : '';
  return `
  precision highp float;
  attribute float aBinIndex;   // dense bin index into the union table; < 0 drops the point
  attribute vec2 aTime;        // [startTime, endTime], tile-relative
  attribute float aWeight;     // per-point weight (1.0 when no weight column)
${cfg.filter ? FILTER_ATTRIBUTE : ''}  uniform vec2 uBinTexSize;    // scatter target size, in texels
${TIME_MODE_UNIFORM_DECLS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying vec2 vContribution;  // (weight * gate, gate)
${MODE_GLSL[cfg.mode]}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    float gate = ${MODE_ALPHA[cfg.mode]};
${filterAlpha}    if (gate <= 0.0 || aBinIndex < 0.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // outside the clip volume
      gl_PointSize = 0.0;
      vContribution = vec2(0.0);
      return;
    }
    float col = mod(aBinIndex, uBinTexSize.x);
    float row = floor(aBinIndex / uBinTexSize.x);
    vec2 uv = (vec2(col, row) + 0.5) / uBinTexSize;
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = 1.0;
    vContribution = vec2(aWeight * gate, gate);
  }
`;
}

/**
 * Scatter fragment stage. Additively blended into a FLOAT target, so R
 * accumulates `Σ weight·gate` and G accumulates `Σ gate` — SUM, COUNT and MEAN
 * all read off that one pair.
 */
export const HEXBIN_SCATTER_FS = `
  precision highp float;
  varying vec2 vContribution;
  void main() {
    gl_FragColor = vec4(vContribution, 0.0, 0.0);
  }
`;

/** The compiled per-cell value expression for one aggregation. */
function aggregationExpr(op: HexbinAggregation): string {
  switch (compileAggregation(op)) {
    case 'COUNT':
      return 'agg.y';
    case 'MEAN':
      return 'agg.x / max(agg.y, 1e-6)';
    default:
      return 'agg.x';
  }
}

/**
 * Emit the projection of one `(mercatorXY, elevationMetres)` pair into a fresh
 * `vec4 here`, through the shared elevated-projection kernel: legacy hosts and
 * the v5 MERCATOR prelude take mercator-z, the v5 GLOBE prelude takes METRES.
 * `uMercatorZPerMeter` is a LAYER-level factor here (cells are not tied to a
 * tile) — see {@link STTHexbinLayer.resolveLatitude}.
 */
function cellProjectBlock(usesPrelude: boolean): string {
  return buildElevatedProjection({
    usesPrelude,
    xy: 'posM',
    elevMeters: 'elevM',
    elevMercatorZ: 'elevM * uMercatorZPerMeter',
    names: {
      out: 'here',
      sphere: 'hereSphere',
      globe: 'hereGlobe',
      flat: 'hereFlat',
    },
  });
}

/**
 * Assemble the CELL vertex source — one instanced hexagonal prism per occupied
 * bin.
 *
 * The aggregate reaches the vertex stage one of two ways, compiled in:
 *  - `source: 'gpu'` — a vertex texture fetch of this instance's own texel,
 *    which is what makes the cell follow the play head every frame for free;
 *  - `source: 'cpu'` — a per-instance attribute filled at table-build time (the
 *    documented no-float-buffer / no-VTF fallback).
 *
 * Both id and visual variants run the IDENTICAL value, clip and elevation
 * maths: a cell with no in-window points, or one clipped out by the percentile
 * band, collapses to `gl_Position = vec4(0.0)` in both, so what the user cannot
 * see is never pickable. The palette's own alpha gate lives in the fragment
 * stage, which both variants also share (see {@link HEXBIN_ID_FS}).
 */
function buildHexbinCellVs(
  shader: ShaderInjection,
  cfg: HexbinCellConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isId = kind === 'id';
  const gpu = cfg.source === 'gpu';

  const aggregateDecl = gpu
    ? '  attribute vec2 aBinCoord;    // per-instance texel centre in the scatter target\n' +
      '  uniform sampler2D uAggregate;\n'
    : '  attribute vec2 aBinValue;    // per-instance (sum, count), CPU fallback\n';
  const aggregateRead = gpu
    ? '    vec2 agg = texture2D(uAggregate, aBinCoord).rg;\n'
    : '    vec2 agg = aBinValue;\n';
  const idAttribute = isId
    ? '  attribute vec3 aIdColor;     // per-instance encoded pick id (UNSIGNED_BYTE normalized)\n'
    : '';
  const idVarying = isId ? '  varying vec3 vIdColor;\n' : '';
  const idAssign = isId ? '    vIdColor = aIdColor;\n' : '';
  const shadeVarying = isId ? '' : '  varying float vShade;\n';
  const shadeAssign = isId ? '' : '    vShade = aUnit.w;\n';

  return `${head}
  precision highp float;
  attribute vec4 aUnit;        // unit hexagonal prism vertex: (x, y, zUnit 0|1, shade)
  attribute vec2 aCenter;      // per-instance bin centroid, mercator unit square
${aggregateDecl}${idAttribute}${usesPrelude ? '' : '  uniform mat4 uMatrix;\n'}  uniform float uRadiusMerc;   // hex circumradius in mercator units (coverage folded in)
  uniform vec2 uColorDomain;
  uniform vec2 uElevationDomain;
  uniform vec2 uValueClip;     // percentile band on the COLOUR value; outside ⇒ hidden
  uniform vec2 uElevationRange;// [low, high] in METRES
  uniform float uElevationScale;
  uniform float uMercatorZPerMeter; // METRES → mercator-z at the LAYER's latitude
  varying float vAlpha;
  varying float vT;            // normalized colour value, sampled by the fragment stage
${shadeVarying}${idVarying}
  void main() {
${aggregateRead}    float count = agg.y;
    float colorValue = ${aggregationExpr(cfg.colorAggregation)};
    float elevValue = ${aggregationExpr(cfg.elevationAggregation)};
    // An EMPTY bin is absence, not a zero sample: nothing drawn, nothing picked.
    vAlpha = (count > 0.0 && colorValue >= uValueClip.x && colorValue <= uValueClip.y)
      ? 1.0 : 0.0;
    vT = clamp(
      (colorValue - uColorDomain.x) / max(uColorDomain.y - uColorDomain.x, 1e-9),
      0.0, 1.0);
    float e = clamp(
      (elevValue - uElevationDomain.x) / max(uElevationDomain.y - uElevationDomain.x, 1e-9),
      0.0, 1.0);
    float heightM = mix(uElevationRange.x, uElevationRange.y, e) * uElevationScale;
    vec2 posM = aCenter + aUnit.xy * uRadiusMerc;
    float elevM = aUnit.z * heightM;
${cellProjectBlock(usesPrelude)}    gl_Position = here;
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${shadeAssign}${idAssign}  }
`;
}

/** Visual cell vertex source for a host variant + feature configuration. */
export function buildHexbinCellVertexSource(
  shader: ShaderInjection,
  cfg: HexbinCellConfig = DEFAULT_CELL_CONFIG,
): string {
  return buildHexbinCellVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildHexbinCellVertexSource}. */
export function buildHexbinCellIdVertexSource(
  shader: ShaderInjection,
  cfg: HexbinCellConfig = DEFAULT_CELL_CONFIG,
): string {
  return buildHexbinCellVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + configuration. `getOrCreateProgram` appends
 * `::${variantName}` (the HOST variant) only, so every shader permutation axis
 * this layer compiles — time mode, DataFilter, both aggregations and the
 * aggregate source — has to appear here or two shapes would share one program.
 */
export function hexbinProgramKey(
  pass: HexbinPass,
  cfg: HexbinScatterConfig | HexbinCellConfig,
): string {
  if (pass === 'scatter') {
    const s = cfg as HexbinScatterConfig;
    return `hexbin:scatter:${s.mode}${s.filter ? ':filter' : ''}`;
  }
  const c = cfg as HexbinCellConfig;
  return (
    `hexbin:${pass}:${compileAggregation(c.colorAggregation)}` +
    `:${compileAggregation(c.elevationAggregation)}:${c.source}`
  );
}

/**
 * Visual cell fragment stage. The palette lookup lives here (not in the vertex
 * stage) so the GPU path spends exactly ONE vertex texture unit — the one the
 * aggregate needs.
 */
export const HEXBIN_CELL_FS = `
  precision highp float;
  uniform sampler2D uPalette;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vT;
  varying float vShade;
  void main() {
    if (vAlpha <= 0.0) discard;
    vec4 ramp = texture2D(uPalette, vec2(vT, 0.5));
    float a = ramp.a * uOpacity;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(ramp.rgb * vShade, a);
  }
`;

/**
 * Id-pick fragment stage. No blending and no antialiasing — the readback must
 * recover the byte triple exactly.
 *
 * It samples the SAME palette and applies the SAME alpha gate as
 * {@link HEXBIN_CELL_FS}: a cell painted by a fully transparent ramp stop (or a
 * layer at `opacity: 0`) is invisible AND unpickable, which is the rule every
 * other kind in this package follows.
 */
export const HEXBIN_ID_FS = `
  precision highp float;
  uniform sampler2D uPalette;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vT;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;             // empty / clipped cells are not pickable
    vec4 ramp = texture2D(uPalette, vec2(vT, 0.5));
    if (ramp.a * uOpacity <= 0.0) discard;  // invisible ⇒ unpickable
    gl_FragColor = vec4(vIdColor, 1.0);     // exact id bytes, fully opaque
  }
`;

// ── options ─────────────────────────────────────────────────────────────────

export interface STTHexbinLayerOptions extends STTFilterableLayerOptions {
  /**
   * Hexagon radius in METRES (deck `HexagonLayer.radius`). Resolved to a
   * mercator radius ONCE for the layer at {@link radiusLatitude}, which is what
   * keeps the lattice identical across tiles.
   * @default 1000
   */
  radius?: number;
  /**
   * Latitude (degrees) the metric radius and every metres→mercator conversion
   * is resolved at. Unset ⇒ the archive's own `metadata.bounds` centre, then
   * the map's current bounds centre. Changing it moves the whole lattice, so it
   * is captured once and only a `setRadiusLatitude` call moves it afterwards.
   */
  radiusLatitude?: number;
  /** Cell size multiplier, clamped 0–1 (deck pass-through). @default 1 */
  coverage?: number;
  /**
   * Extrude cells by their aggregated weight. `false` draws flat hexagons on
   * the ground. Pair with `map.setPitch(...)` for the relief to be visible.
   * @default true
   */
  extruded?: boolean;
  /** Cell elevation multiplier. @default 1 */
  elevationScale?: number;
  /** Elevation output range in METRES, low → high aggregate. @default [0, 1000] */
  elevationRange?: readonly [number, number];
  /** Cell colour ramp (0–255 RGBA), low → high aggregate. @default 6-class YlOrRd */
  colorRange?: ReadonlyArray<RGBA8>;
  /**
   * Pinned colour-scale domain. `null` (default) auto-ranges from a CPU sample
   * of the aggregate taken when the bin table is (re)built, and then HOLDS —
   * see the module header for why that beats deck's per-window re-range.
   */
  colorDomain?: readonly [number, number] | null;
  /** Pinned elevation-scale input domain. `null` (default) auto-ranges. */
  elevationDomain?: readonly [number, number] | null;
  /**
   * Colour scale. `'quantize'` (deck's default) bakes discrete bands into the
   * palette texture; `'linear'` interpolates. `'quantile'`/`'ordinal'` need a
   * sort of the LIVE aggregate and degrade to `'quantize'` with one warning.
   * @default 'quantize'
   */
  colorScaleType?: HexbinScaleType;
  /** Hide cells below this colour percentile (0–100). @default 0 */
  lowerPercentile?: number;
  /** Hide cells above this colour percentile (0–100). @default 100 */
  upperPercentile?: number;
  /**
   * Aggregation for BOTH channels unless a specific override is set.
   * `'MIN'`/`'MAX'` degrade to `'SUM'` (module header).
   * @default 'SUM'
   */
  hexagonAggregation?: HexbinAggregation;
  /** Colour aggregation override. `null` inherits {@link hexagonAggregation}. */
  colorAggregation?: HexbinAggregation | null;
  /** Elevation aggregation override. `null` inherits {@link hexagonAggregation}. */
  elevationAggregation?: HexbinAggregation | null;
  /**
   * Aggregate on the GPU when the runtime allows it. `false` forces the
   * CPU fallback, which does NOT track the play head between table rebuilds.
   * @default true
   */
  gpuAggregation?: boolean;
  /**
   * Name of the baked numeric column each point contributes. Unset ⇒ every
   * point weighs 1, i.e. a pure COUNT hexbin (deck's `weightProperty`).
   */
  weightProperty?: string;
  /** Layer opacity multiplier applied to the ramp's own alpha. @default 1 */
  opacity?: number;
  /**
   * Time-filter mode gating which points reach the aggregate. Unset ⇒ inferred
   * in deck's precedence order (`wakeLength > 0` ⇒ wake, else `trailLength > 0`
   * ⇒ trail, else window). COMPILE-TIME and fixed for the layer's lifetime.
   *
   * `'cumulative'` carries the usual CALLER OBLIGATION: the shader does the
   * progressive reveal, the loader does not, so `timeWindow` must be wide
   * enough to keep already-revealed tiles resident.
   */
  timeFilterMode?: HexbinTimeFilterMode;
  /**
   * `wake` mode: milliseconds a point keeps contributing after its own start
   * time, its contribution fading linearly to 0 at the tail.
   * @default 0
   */
  wakeLength?: number;
  /**
   * `wake` mode tail multiplier. Accepted for prop parity with the rest of the
   * package; a bin cannot shrink the way a glyph can, so the taper shows up as
   * a lighter contribution instead. @default 0.15
   */
  wakeTailScale?: number;
  /** `trail` mode: milliseconds behind the play head points keep contributing. @default 0 */
  trailLength?: number;
  /**
   * `trail` mode head→tail fade: `1`/`true` (default) fades the contribution
   * with age, `0`/`false` holds it (package-wide `resolveTrailFade`).
   */
  fadeTrail?: boolean | number;
  /**
   * MapLibre `CustomLayerInterface.renderingMode`. `'3d'` (the default, as on
   * `STTColumnLayer`) lets the host install its LEQUAL read-write depth mode so
   * prisms occlude each other and the basemap's buildings; `'2d'` restores the
   * package's always-on-top behaviour, which is what a flat (`extruded: false`)
   * hexbin over a 2D basemap wants. Read by the host at `addLayer` time.
   * @default '3d'
   */
  renderingMode?: '2d' | '3d';
}

// ── GPU handles ─────────────────────────────────────────────────────────────

interface ScatterHandles
  extends
    TimeUniformLocations,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  aBinIndex: number;
  aTime: number;
  aWeight: number;
  aFilterValue: number;
  uBinTexSize: WebGLUniformLocation | null;
}

interface CellHandles {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aUnit: number;
  aCenter: number;
  /** GPU path only (-1 on the CPU variant). */
  aBinCoord: number;
  /** CPU path only (-1 on the GPU variant). */
  aBinValue: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
  uMatrix: WebGLUniformLocation | null;
  uAggregate: WebGLUniformLocation | null;
  uPalette: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uRadiusMerc: WebGLUniformLocation | null;
  uColorDomain: WebGLUniformLocation | null;
  uElevationDomain: WebGLUniformLocation | null;
  uValueClip: WebGLUniformLocation | null;
  uElevationRange: WebGLUniformLocation | null;
  uElevationScale: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
}

/** Per-tile cache: the base's positions/times plus this layer's own columns. */
interface HexbinGpuCache extends TileGpuCache {
  /** Points in this tile — the length of every per-point array below. */
  pointCount: number;
  /**
   * Packed lattice address per point, computed ONCE at tile upload. `NaN` for a
   * point outside the packable bin range. Survives every table rebuild — this
   * is the expensive half of binning and it never re-runs for a resident tile.
   */
  binKeys: Float64Array;
  /** Per-point weight (1s when no `weightProperty`). */
  weights: Float32Array;
  /** Per-point DataFilter column, or null when this tile didn't bake one. */
  filterValues: Float32Array | null;
  hasFilterColumn: boolean;
  /** Dense bin index per point, refilled on every table rebuild. */
  binIndices: Int32Array;
  /** GPU mirror of {@link binIndices}. Re-`bufferData`'d in place so VAOs live. */
  binIndexBuffer?: WebGLBuffer;
  weightBuffer?: WebGLBuffer;
  filterBuffer?: WebGLBuffer;
  /** Scatter-program key the VAO was recorded under. */
  vaoProgramKey?: string;
  /** Radius the {@link binKeys} were computed at — a change invalidates them. */
  binRadiusMerc: number;
}

/** The union bin table: the seam fix, rebuilt only when its inputs move. */
interface HexbinTable {
  /** Occupied bins across every resident tile. */
  binCount: number;
  /** Per-bin centroid, mercator, interleaved `[x0, y0, x1, y1, …]`. */
  centers: Float32Array;
  /** Per-bin scatter-texel centre uv, interleaved. */
  coords: Float32Array;
  /** Scatter target dimensions. */
  texWidth: number;
  texHeight: number;
  /** Packed lattice key per dense index — what a pick reports. */
  keys: Float64Array;
  /** Radius the table was built at. */
  radiusMerc: number;
  /** Tile-cache keys the table covers; a mismatch triggers a rebuild. */
  tileKeys: Set<string>;
  /** Bump per rebuild — the diagnostic a "not rebuilt on a time change" test reads. */
  generation: number;
}

/** Diagnostics surfaced by {@link STTHexbinLayer.getBinTableStats}. */
export interface HexbinTableStats {
  /** Rebuild counter. A time-only change must NOT move this. */
  generation: number;
  /** Occupied bins in the current table. */
  binCount: number;
  /** Points feeding the table. */
  pointCount: number;
  /** Points dropped for an unpackable lattice address. */
  droppedPoints: number;
  /** Mercator hexagon radius the lattice is pitched at. */
  radiusMerc: number;
  /** Latitude the metric radius / elevation factor were resolved at. */
  latitude: number;
  /** Which side computed the aggregate the last frame drew. */
  source: AggregateSource;
}

/**
 * MapLibre custom layer that bins STT POINT tiles into a world-space hexagonal
 * lattice and draws one instanced prism per occupied cell.
 *
 * ```ts
 * const layer = new STTHexbinLayer({
 *   id: 'rides',
 *   url: '/data/taxi.stt',
 *   currentTime: t0,
 *   timeWindow: 3_600_000,
 *   radius: 250,               // metres
 *   weightProperty: 'fare',    // omit for a pure COUNT hexbin
 *   elevationRange: [0, 4000], // metres
 * });
 * layer.attach(map);
 * ```
 */
export class STTHexbinLayer extends STTFilterableLayer {
  /** Host depth participation — `'3d'` by default (this kind extrudes). */
  readonly renderingMode: '2d' | '3d';

  private readonly hexOpts: {
    radius: number;
    radiusLatitude?: number;
    coverage: number;
    extruded: boolean;
    elevationScale: number;
    elevationRange: readonly [number, number];
    colorRange: ReadonlyArray<RGBA8>;
    colorDomain: readonly [number, number] | null;
    elevationDomain: readonly [number, number] | null;
    colorScaleType: HexbinScaleType;
    lowerPercentile: number;
    upperPercentile: number;
    hexagonAggregation: HexbinAggregation;
    colorAggregation: HexbinAggregation | null;
    elevationAggregation: HexbinAggregation | null;
    gpuAggregation: boolean;
    weightProperty?: string;
    opacity: number;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };

  /** Second payload so the CPU aggregator never clobbers the draw path's. */
  private readonly cpuFilterUniforms: DataFilterUniforms =
    createDataFilterUniforms();

  private readonly scatterConfig: HexbinScatterConfig;
  private cellConfig: HexbinCellConfig;
  private scatterKey: string;
  private cellKey: string;
  private pickCellKey: string;

  // Program handles, memoized per host variant (the scatter pass has none, but
  // it rides the same per-variant cache so context loss invalidates it too).
  private scatterHandles?: ScatterHandles;
  private scatterVariant?: string;
  private cellHandles?: CellHandles;
  private cellVariant?: string;
  private pickHandles?: CellHandles;
  private pickVariant?: string;

  // Shared unit mesh.
  private mesh?: HexbinMesh;
  private meshVertexBuffer?: WebGLBuffer;
  private meshIndexBuffer?: WebGLBuffer;

  // Per-bin instance buffers (layer-level, not per-tile).
  private centerBuffer?: WebGLBuffer;
  private coordBuffer?: WebGLBuffer;
  private valueBuffer?: WebGLBuffer;

  // Scatter target.
  private aggregateFbo?: WebGLFramebuffer;
  private aggregateTexture?: WebGLTexture;
  private aggregateWidth = 0;
  private aggregateHeight = 0;
  private aggregateFormat: {
    internalFormat: number;
    format: number;
    type: number;
    label: 'RGBA32F' | 'RGBA16F' | 'none';
  } | null = null;

  private paletteTexture?: WebGLTexture;
  private paletteDirty = true;

  // Bin table + CPU aggregate.
  private table: HexbinTable | null = null;
  private cpuAggregate: HexbinAggregate | null = null;
  private resolvedColorDomain: [number, number] = [0, 1];
  private resolvedElevationDomain: [number, number] = [0, 1];
  private resolvedValueClip: [number, number] = [
    -Number.MAX_VALUE,
    Number.MAX_VALUE,
  ];
  private tablePointCount = 0;
  private tableDroppedPoints = 0;
  private tableGeneration = 0;

  /** Layer-wide latitude — resolved once, then held (see the module header). */
  private latitudeDeg: number | null = null;
  private radiusMerc = 0;
  private mercatorZPerMeter = 0;

  private warnedExtremum = false;
  private warnedScaleType = false;
  private warnedNoInstancing = false;
  private warnedCpuFallback = false;

  constructor(opts: STTHexbinLayerOptions) {
    super(opts);
    // `??` (not a spread) so an explicitly passed `undefined` still defaults.
    this.renderingMode = opts.renderingMode ?? '3d';
    this.hexOpts = {
      radius: opts.radius ?? DEFAULT_RADIUS_METERS,
      radiusLatitude: opts.radiusLatitude,
      coverage: opts.coverage ?? 1,
      extruded: opts.extruded ?? true,
      elevationScale: opts.elevationScale ?? 1,
      elevationRange: opts.elevationRange ?? DEFAULT_ELEVATION_RANGE,
      colorRange: opts.colorRange ?? DEFAULT_HEXBIN_COLOR_RANGE,
      colorDomain: opts.colorDomain ?? null,
      elevationDomain: opts.elevationDomain ?? null,
      colorScaleType: opts.colorScaleType ?? 'quantize',
      lowerPercentile: opts.lowerPercentile ?? 0,
      upperPercentile: opts.upperPercentile ?? 100,
      hexagonAggregation: opts.hexagonAggregation ?? 'SUM',
      colorAggregation: opts.colorAggregation ?? null,
      elevationAggregation: opts.elevationAggregation ?? null,
      gpuAggregation: opts.gpuAggregation ?? true,
      weightProperty: opts.weightProperty,
      opacity: opts.opacity ?? 1,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.scatterConfig = Object.freeze({
      mode: resolveHexbinTimeFilterMode(
        opts.timeFilterMode,
        this.hexOpts.wakeLength,
        this.hexOpts.trailLength,
      ),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and contributes unfiltered.
      filter: Boolean(opts.filterProperty),
    });
    this.cellConfig = {
      colorAggregation: this.colorAggregation(),
      elevationAggregation: this.elevationAggregation(),
      source: 'gpu',
    };
    this.scatterKey = hexbinProgramKey('scatter', this.scatterConfig);
    this.cellKey = hexbinProgramKey('cell', this.cellConfig);
    this.pickCellKey = hexbinProgramKey('pick-cell', this.cellConfig);
    this.warnOnUnsupportedOptions();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  /** One warning per degraded option, at construction rather than mid-playback. */
  private warnOnUnsupportedOptions(): void {
    const ops = [
      this.hexOpts.hexagonAggregation,
      this.hexOpts.colorAggregation,
      this.hexOpts.elevationAggregation,
    ];
    if (!this.warnedExtremum && ops.some((o) => o === 'MIN' || o === 'MAX')) {
      this.warnedExtremum = true;
      console.warn(
        `[${this.id}] MIN/MAX aggregation needs blendEquation(MIN|MAX) and a ` +
          'second scatter pass; falling back to SUM',
      );
    }
    const scale = this.hexOpts.colorScaleType;
    if (
      !this.warnedScaleType &&
      (scale === 'quantile' || scale === 'ordinal')
    ) {
      this.warnedScaleType = true;
      console.warn(
        `[${this.id}] colorScaleType '${scale}' needs a sort of the live ` +
          "aggregate; falling back to 'quantize'",
      );
    }
  }

  private colorAggregation(): HexbinAggregation {
    return this.hexOpts.colorAggregation ?? this.hexOpts.hexagonAggregation;
  }

  private elevationAggregation(): HexbinAggregation {
    return this.hexOpts.elevationAggregation ?? this.hexOpts.hexagonAggregation;
  }

  // ── runtime setters ───────────────────────────────────────────────────────

  /**
   * Move the hexagon radius (METRES). Re-pitches the lattice, so every tile's
   * cached bin keys AND the union table are invalidated — the one setter on
   * this layer that is not uniform-only.
   */
  setRadius(radiusMeters: number): void {
    if (this.hexOpts.radius === radiusMeters) return;
    this.hexOpts.radius = radiusMeters;
    this.radiusMerc = 0;
    this.invalidateTable();
    this.rebuildTileCaches();
  }

  /**
   * Pin the latitude the metric radius resolves at. Same cost as
   * {@link setRadius}: the lattice pitch moves.
   */
  setRadiusLatitude(latitudeDeg: number | undefined): void {
    this.hexOpts.radiusLatitude = latitudeDeg;
    this.latitudeDeg = null;
    this.radiusMerc = 0;
    this.invalidateTable();
    this.rebuildTileCaches();
  }

  /** Replace the colour ramp. Uniform/texture-only. */
  setColorRange(range: ReadonlyArray<RGBA8>): void {
    this.hexOpts.colorRange = range;
    this.paletteDirty = true;
    this.map?.triggerRepaint();
  }

  /** Pin (or release, with `null`) the colour-scale domain. */
  setColorDomain(domain: readonly [number, number] | null): void {
    this.hexOpts.colorDomain = domain;
    this.refreshDomains();
    this.map?.triggerRepaint();
  }

  /** Pin (or release, with `null`) the elevation-scale domain. */
  setElevationDomain(domain: readonly [number, number] | null): void {
    this.hexOpts.elevationDomain = domain;
    this.refreshDomains();
    this.map?.triggerRepaint();
  }

  /** Update the height exaggeration. Uniform-only. */
  setElevationScale(scale: number): void {
    this.hexOpts.elevationScale = scale;
    this.map?.triggerRepaint();
  }

  /** Toggle extrusion. Uniform-only — the wall band always rides the mesh. */
  setExtruded(extruded: boolean): void {
    this.hexOpts.extruded = extruded;
    this.map?.triggerRepaint();
  }

  /** Update the layer opacity multiplier. Uniform-only. */
  setOpacity(opacity: number): void {
    this.hexOpts.opacity = opacity;
    this.map?.triggerRepaint();
  }

  /**
   * A bin's total is a function of the filter, so a repaint alone would draw
   * stale cells: the CPU path re-aggregates, and the GPU path — whose auto
   * colour / elevation domains are sampled from a CPU aggregate — re-resolves
   * those.
   */
  protected onFilterChanged(): void {
    if (this.cellConfig.source === 'cpu') this.refreshCpuAggregate();
    else this.refreshDomains();
    this.map?.triggerRepaint();
  }

  /**
   * Bin-table diagnostics. `generation` is the contract a caller (or a test)
   * uses to prove the table survives a time-only change: advancing
   * `setCurrentTime` and rendering must NOT move it.
   */
  getBinTableStats(): HexbinTableStats {
    return {
      generation: this.tableGeneration,
      binCount: this.table?.binCount ?? 0,
      pointCount: this.tablePointCount,
      droppedPoints: this.tableDroppedPoints,
      radiusMerc: this.radiusMerc,
      latitude: this.latitudeDeg ?? 0,
      source: this.cellConfig.source,
    };
  }

  // ── GL lifecycle ──────────────────────────────────────────────────────────

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Programs are linked lazily per host variant on the first draw; only the
    // projection-agnostic palette is worth allocating up front.
    this.paletteTexture = gl.createTexture()!;
    this.paletteDirty = true;
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Programs belong to the base per-variant cache (already invalidated);
    // everything here is ours. Deletes on a lost context are ignored, which is
    // exactly the reference release this needs.
    this.scatterHandles = undefined;
    this.scatterVariant = undefined;
    this.cellHandles = undefined;
    this.cellVariant = undefined;
    this.pickHandles = undefined;
    this.pickVariant = undefined;
    if (this.meshVertexBuffer) gl.deleteBuffer(this.meshVertexBuffer);
    if (this.meshIndexBuffer) gl.deleteBuffer(this.meshIndexBuffer);
    if (this.centerBuffer) gl.deleteBuffer(this.centerBuffer);
    if (this.coordBuffer) gl.deleteBuffer(this.coordBuffer);
    if (this.valueBuffer) gl.deleteBuffer(this.valueBuffer);
    if (this.aggregateFbo) gl.deleteFramebuffer(this.aggregateFbo);
    if (this.aggregateTexture) gl.deleteTexture(this.aggregateTexture);
    if (this.paletteTexture) gl.deleteTexture(this.paletteTexture);
    this.meshVertexBuffer = undefined;
    this.meshIndexBuffer = undefined;
    this.centerBuffer = undefined;
    this.coordBuffer = undefined;
    this.valueBuffer = undefined;
    this.aggregateFbo = undefined;
    this.aggregateTexture = undefined;
    this.paletteTexture = undefined;
    this.aggregateWidth = 0;
    this.aggregateHeight = 0;
    // Extension probes and format verdicts do not survive a restore.
    this.aggregateFormat = null;
    this.paletteDirty = true;
    // The table's GPU mirrors are gone; its CPU half is rebuilt with them.
    this.invalidateTable();
  }

  /**
   * GL state for the frame. Same departure as `STTColumnLayer`: on a `'3d'`
   * layer the host has already installed its LEQUAL read-write depth mode, so
   * we leave it alone rather than forcing the flat layers' always-on-top.
   */
  protected applySharedGlState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.renderingMode !== '3d') gl.disable(gl.DEPTH_TEST);
  }

  // ── per-tile cache ────────────────────────────────────────────────────────

  /**
   * Build the per-tile cache. The load-bearing part is {@link binKeys}: every
   * point's world-lattice address, computed ONCE here and never again for as
   * long as the tile and the radius are alive. A table rebuild re-maps those
   * keys to dense indices (a `Map` lookup per point) but never recomputes them.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): HexbinGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, _tile, layer);
    if (!baseCache) return null;
    const f = layer.features;
    const cache = baseCache as HexbinGpuCache;
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];

    const radiusMerc = this.ensureRadius();
    const dims = f.positionDimensions === 3 ? 3 : 2;
    const n = Math.min(f.featureCount, baseCache.vertexCount);
    cache.pointCount = n;
    cache.binRadiusMerc = radiusMerc;

    // The one O(points) geometry pass. `hexBinKeyForPoint` is allocation-free,
    // so this is a flat loop over the tile's own lon/lat buffer.
    const keys = new Float64Array(n);
    const merc = new Float64Array(2);
    for (let i = 0; i < n; i++) {
      lngLatToMercatorInto(
        f.positions[i * dims],
        f.positions[i * dims + 1],
        merc,
        0,
      );
      keys[i] =
        radiusMerc > 0
          ? hexBinKeyForPoint(merc[0], merc[1], radiusMerc)
          : Number.NaN;
    }
    cache.binKeys = keys;
    cache.binIndices = new Int32Array(n);

    const weights = new Float32Array(n);
    if (this.hexOpts.weightProperty) {
      const src = this.getNumericProperty(f, this.hexOpts.weightProperty);
      if (src) for (let i = 0; i < n; i++) weights[i] = src[i];
      else weights.fill(1);
    } else {
      weights.fill(1);
    }
    cache.weights = weights;
    cache.weightBuffer = this.uploadArrayBuffer(gl, weights);
    extras.push(cache.weightBuffer);

    cache.filterValues = null;
    cache.hasFilterColumn = false;
    if (this.scatterConfig.filter) {
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical)
        this.warnCategoricalFilterOnce('aggregating unfiltered');
      cache.hasFilterColumn = col.hasColumn;
      if (col.values) {
        // One point == one scatter primitive, so the per-FEATURE column binds
        // directly (no expandFilterValues — that is for segment instancing).
        cache.filterValues = col.values;
        cache.filterBuffer = this.uploadArrayBuffer(gl, col.values);
        extras.push(cache.filterBuffer);
      }
    }

    // Allocated empty and refilled by every table rebuild. Creating it HERE
    // (not at rebuild time) is what lets the rebuild re-`bufferData` the same
    // handle, so a per-tile VAO recorded against it never goes stale.
    cache.binIndexBuffer = this.uploadArrayBuffer(gl, cache.binIndices);
    extras.push(cache.binIndexBuffer);

    cache.extraBuffers = extras;
    // A tile arriving mid-playback changes the union — force a rebuild.
    this.invalidateTable();
    return cache;
  }

  // ── lattice scale ─────────────────────────────────────────────────────────

  /**
   * The layer's latitude, resolved ONCE. `radiusLatitude` wins, then the
   * archive's own data bounds (deck resolves its lattice at the data-bounds
   * centroid — this is the same choice), then the map's current bounds centre.
   *
   * Holding it is not laziness: the mercator radius is what pitches the
   * lattice, so a latitude that drifted with the camera would silently re-bin
   * everything mid-pan and cells would swim.
   */
  private resolveLatitude(): number {
    if (this.latitudeDeg !== null) return this.latitudeDeg;
    const explicit = this.hexOpts.radiusLatitude;
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      this.latitudeDeg = explicit;
      return explicit;
    }
    const bounds = this.metadata?.bounds;
    if (
      bounds &&
      Number.isFinite(bounds.minLat) &&
      Number.isFinite(bounds.maxLat)
    ) {
      this.latitudeDeg = (bounds.minLat + bounds.maxLat) / 2;
      return this.latitudeDeg;
    }
    const mapBounds = this.map?.getBounds?.();
    if (mapBounds) {
      this.latitudeDeg = (mapBounds.getSouth() + mapBounds.getNorth()) / 2;
      return this.latitudeDeg;
    }
    // Nothing to go on yet — do NOT memoize 0, or the first frame would pin the
    // lattice to the equator for the layer's whole life.
    return 0;
  }

  /** Mercator hexagon radius, resolved once per latitude/radius change. */
  private ensureRadius(): number {
    if (this.radiusMerc > 0) return this.radiusMerc;
    const lat = this.resolveLatitude();
    if (this.latitudeDeg === null) return 0; // latitude not resolvable yet.
    this.radiusMerc = hexBinRadiusFromMeters(this.hexOpts.radius, lat);
    this.mercatorZPerMeter = mercatorZFromAltitude(1, lat);
    return this.radiusMerc;
  }

  // ── union bin table ───────────────────────────────────────────────────────

  private invalidateTable(): void {
    this.table = null;
    this.cpuAggregate = null;
  }

  /**
   * Is the cached table still the right one for the resident tile set? Cheap
   * enough to run every frame: a size compare plus a `Set` probe per tile
   * (there are tens of tiles, not thousands), and no allocation beyond the
   * `Map` iterator the base's own render loop already pays for.
   */
  private tableMatchesTiles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): boolean {
    const table = this.table;
    if (!table) return false;
    if (table.radiusMerc !== this.ensureRadius()) return false;
    let seen = 0;
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const key = this.tileCacheKey(tile, layer);
        if (!table.tileKeys.has(key)) return false;
        seen++;
        // Touch the cache so a tile whose GPU buffers were swept re-enters the
        // table rather than silently drawing from a dead handle.
        if (!this.ensureTileGpuCache(gl, tile, layer)) return false;
      }
    }
    return seen === table.tileKeys.size;
  }

  /** The key the base's `ensureTileGpuCache` stores a (tile, layer) cache under. */
  private tileCacheKey(tile: Tile, layer: STTLayer): string {
    const { z, x, y, t } = tile.id;
    return `${z}/${x}/${y}/${t}::${layer.name}::${layer.features.geometryType}`;
  }

  /**
   * Rebuild the union bin table — the seam fix (module header, step 2).
   *
   * Every resident tile's cached keys are merged through ONE map, so a hexagon
   * touched by several tiles resolves to a single dense index and therefore a
   * single instance. Runs when the resident tile set, the radius or the weight
   * column moves; never on a time change.
   */
  private rebuildTable(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): HexbinTable | null {
    const radiusMerc = this.ensureRadius();
    if (radiusMerc <= 0) return null;

    const keyToIndex = new Map<number, number>();
    const tileKeys = new Set<string>();
    const caches: HexbinGpuCache[] = [];
    let pointCount = 0;
    let dropped = 0;

    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(
          gl,
          tile,
          layer,
        ) as HexbinGpuCache | null;
        if (!cache) continue;
        tileKeys.add(this.tileCacheKey(tile, layer));
        caches.push(cache);
        const n = cache.pointCount;
        pointCount += n;
        for (let i = 0; i < n; i++) {
          const key = cache.binKeys[i];
          // NaN ⇒ the lattice address left the packable range. Drop the point
          // rather than let every out-of-range row collapse into bin 0.
          if (Number.isNaN(key)) {
            cache.binIndices[i] = -1;
            dropped++;
            continue;
          }
          let idx = keyToIndex.get(key);
          if (idx === undefined) {
            idx = keyToIndex.size;
            keyToIndex.set(key, idx);
          }
          cache.binIndices[i] = idx;
        }
      }
    }

    let binCount = keyToIndex.size;
    if (binCount === 0) {
      this.tablePointCount = pointCount;
      this.tableDroppedPoints = dropped;
      return null;
    }
    binCount = this.clampBinCount(gl, binCount);

    const { width, height } = hexbinTextureSize(binCount);
    const centers = new Float32Array(binCount * 2);
    const coords = new Float32Array(binCount * 2);
    const keys = new Float64Array(binCount);
    for (const [key, idx] of keyToIndex) {
      if (idx >= binCount) continue; // clamped away.
      const [cx, cy] = hexBinCentroidMercator(
        hexBinKeyI(key),
        hexBinKeyJ(key),
        radiusMerc,
      );
      centers[idx * 2] = cx;
      centers[idx * 2 + 1] = cy;
      const [u, v] = hexbinTexelUv(idx, width, height);
      coords[idx * 2] = u;
      coords[idx * 2 + 1] = v;
      keys[idx] = key;
    }
    // Points that fell into a clamped-away bin must not paint bin 0.
    if (binCount < keyToIndex.size) {
      for (const cache of caches) {
        for (let i = 0; i < cache.pointCount; i++) {
          if (cache.binIndices[i] >= binCount) {
            cache.binIndices[i] = -1;
            dropped++;
          }
        }
      }
    }

    // Push the dense indices into the buffers the caches already own, so the
    // per-tile scatter VAOs stay valid across the rebuild.
    for (const cache of caches) {
      if (!cache.binIndexBuffer) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.binIndexBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        toFloat32(cache.binIndices),
        gl.STATIC_DRAW,
      );
    }

    this.tablePointCount = pointCount;
    this.tableDroppedPoints = dropped;
    this.tableGeneration++;
    const table: HexbinTable = {
      binCount,
      centers,
      coords,
      texWidth: width,
      texHeight: height,
      keys,
      radiusMerc,
      tileKeys,
      generation: this.tableGeneration,
    };
    this.table = table;
    this.uploadInstanceBuffers(gl, table);
    return table;
  }

  /** Cap the table at what the runtime can actually address. */
  private clampBinCount(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    binCount: number,
  ): number {
    const raw = gl.getParameter(GL_MAX_TEXTURE_SIZE);
    const maxTex = typeof raw === 'number' && raw > 0 ? raw : 4096;
    const maxBins = Math.min(
      AGGREGATE_TEX_WIDTH * maxTex,
      MAX_PICK_ID, // ids are 1-based and 24-bit — never alias two cells.
    );
    if (binCount <= maxBins) return binCount;
    console.warn(
      `[${this.id}] ${binCount} hex bins exceeds the addressable ${maxBins}; ` +
        'the excess is dropped — raise `radius`',
    );
    return maxBins;
  }

  private uploadInstanceBuffers(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    table: HexbinTable,
  ): void {
    this.centerBuffer = writeBuffer(gl, this.centerBuffer, table.centers);
    this.coordBuffer = writeBuffer(gl, this.coordBuffer, table.coords);
  }

  // ── domains + CPU aggregate ───────────────────────────────────────────────

  /**
   * Snapshot the aggregate on the CPU and re-resolve every value-space uniform.
   * Runs at table-build time only. On the GPU path this is a domain SAMPLE (the
   * shader reads its own live texture); on the CPU path it IS the aggregate.
   */
  private refreshCpuAggregate(): void {
    const table = this.table;
    if (!table) return;
    const needsCpuValues = this.cellConfig.source === 'cpu';
    const needsDomain =
      this.hexOpts.colorDomain === null ||
      this.hexOpts.elevationDomain === null ||
      this.hexOpts.lowerPercentile > 0 ||
      this.hexOpts.upperPercentile < 100;
    if (!needsCpuValues && !needsDomain) {
      this.cpuAggregate = null;
      this.refreshDomains();
      return;
    }

    const contributions: HexbinContribution[] = [];
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.tileGpuCache.get(this.tileCacheKey(tile, layer)) as
          | HexbinGpuCache
          | null
          | undefined;
        if (!cache) continue;
        const f = layer.features;
        contributions.push({
          binIndex: cache.binIndices,
          weights: cache.weights,
          startTimes: f.startTimes,
          endTimes: f.endTimes,
          filterValues: cache.hasFilterColumn ? cache.filterValues : null,
          gate: this.resolveTimeGate(cache.timeOffset),
        });
      }
    }
    this.cpuAggregate = aggregateHexbinsCpu(
      table.binCount,
      contributions,
      this.scatterConfig.filter ? this.filterOpts : null,
      this.cpuFilterUniforms,
    );
    this.refreshDomains();
    if (needsCpuValues && this.gl) {
      const values = new Float32Array(table.binCount * 2);
      values.set(this.cpuAggregate);
      this.valueBuffer = writeBuffer(this.gl, this.valueBuffer, values);
    }
  }

  /**
   * Re-resolve the colour / elevation domains and the percentile clip band from
   * whatever CPU sample is current. A pinned domain wins outright; an auto
   * domain with no occupied cell KEEPS the previous value rather than collapsing
   * the ramp.
   */
  private refreshDomains(): void {
    const agg = this.cpuAggregate;
    const o = this.hexOpts;
    if (o.colorDomain) {
      this.resolvedColorDomain = [o.colorDomain[0], o.colorDomain[1]];
    } else if (agg) {
      const d = hexbinValueDomain(
        agg,
        this.colorAggregation(),
        o.lowerPercentile,
        o.upperPercentile,
      );
      if (d) this.resolvedColorDomain = d;
    }
    if (o.elevationDomain) {
      this.resolvedElevationDomain = [
        o.elevationDomain[0],
        o.elevationDomain[1],
      ];
    } else if (agg) {
      const d = hexbinValueDomain(agg, this.elevationAggregation());
      if (d) this.resolvedElevationDomain = d;
    }
    // Percentile clipping hides cells outside the band (deck's behaviour); with
    // no sample to derive it from, everything stays visible.
    const clipping = o.lowerPercentile > 0 || o.upperPercentile < 100;
    if (clipping && agg) {
      const band = hexbinValueDomain(
        agg,
        this.colorAggregation(),
        o.lowerPercentile,
        o.upperPercentile,
      );
      this.resolvedValueClip = band ?? [-Number.MAX_VALUE, Number.MAX_VALUE];
    } else {
      this.resolvedValueClip = [-Number.MAX_VALUE, Number.MAX_VALUE];
    }
  }

  /** The tile-relative time gate the scatter uniforms and the CPU twin share. */
  private resolveTimeGate(timeOffset: number): HexbinTimeGate {
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    const current = this.opts.currentTime - timeOffset;
    const half = this.opts.timeWindow / 2;
    return {
      mode: this.scatterConfig.mode,
      currentTime: current,
      windowStart: current - half,
      windowEnd: current + half,
      fadeIn,
      fadeOut,
      wakeLength: this.hexOpts.wakeLength,
      trailLength: this.hexOpts.trailLength,
      fadeTrail: this.hexOpts.fadeTrail,
    };
  }

  // ── scatter target ────────────────────────────────────────────────────────

  /**
   * Resolve the best colour-renderable FLOAT format. RGBA8 is deliberately NOT
   * a fallback: additive blending into it clamps at 1.0, so a sum of anything
   * would saturate on the second point. No float target ⇒ the CPU path.
   *
   * RGBA32F first (a COUNT stays integer-exact past 2048, where RGBA16F's
   * 11-bit mantissa starts rounding), RGBA16F second.
   */
  private probeAggregateFormat(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): NonNullable<STTHexbinLayer['aggregateFormat']> {
    const isWebGL2 =
      typeof WebGL2RenderingContext !== 'undefined' &&
      gl instanceof WebGL2RenderingContext;
    if (isWebGL2) {
      const gl2 = gl as unknown as {
        RGBA32F: number;
        RGBA16F: number;
        HALF_FLOAT: number;
      };
      if (gl.getExtension('EXT_color_buffer_float')) {
        return {
          internalFormat: gl2.RGBA32F,
          format: gl.RGBA,
          type: gl.FLOAT,
          label: 'RGBA32F',
        };
      }
      if (gl.getExtension('EXT_color_buffer_half_float')) {
        return {
          internalFormat: gl2.RGBA16F,
          format: gl.RGBA,
          type: gl2.HALF_FLOAT,
          label: 'RGBA16F',
        };
      }
      return { internalFormat: 0, format: 0, type: 0, label: 'none' };
    }
    // WebGL1: the texture type comes from OES_texture_(half_)float and the
    // colour-renderable property from the matching EXT_color_buffer_* .
    const float32 = gl.getExtension('OES_texture_float');
    if (float32 && gl.getExtension('EXT_color_buffer_float')) {
      return {
        internalFormat: gl.RGBA,
        format: gl.RGBA,
        type: gl.FLOAT,
        label: 'RGBA32F',
      };
    }
    const half = gl.getExtension('OES_texture_half_float') as {
      HALF_FLOAT_OES: number;
    } | null;
    if (
      half &&
      (gl.getExtension('EXT_color_buffer_half_float') ||
        gl.getExtension('EXT_color_buffer_float'))
    ) {
      return {
        internalFormat: gl.RGBA,
        format: gl.RGBA,
        type: half.HALF_FLOAT_OES,
        label: 'RGBA16F',
      };
    }
    return { internalFormat: 0, format: 0, type: 0, label: 'none' };
  }

  /**
   * Can the VERTEX stage sample a texture? WebGL2 guarantees ≥16 units; WebGL1
   * allows 0, and a runtime reporting 0 cannot run the gather.
   *
   * A context that answers with a NON-NUMBER (only a recorder/mock does; every
   * real GL returns an integer) is treated as capable — refusing there would
   * push every unit test onto the fallback path and leave the primary one
   * uncovered.
   */
  private supportsVertexTextures(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): boolean {
    const units = gl.getParameter(GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS);
    return typeof units !== 'number' || units > 0;
  }

  /** Decide (once per context) which side computes the aggregate. */
  private resolveAggregateSource(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): AggregateSource {
    if (!this.hexOpts.gpuAggregation) return 'cpu';
    if (!this.aggregateFormat) {
      this.aggregateFormat = this.probeAggregateFormat(gl);
    }
    if (this.aggregateFormat.label === 'none') return 'cpu';
    if (!this.supportsVertexTextures(gl)) return 'cpu';
    return 'gpu';
  }

  /** Adopt the resolved source, relinking the cell programs if it moved. */
  private applyAggregateSource(source: AggregateSource): void {
    if (this.cellConfig.source === source) return;
    this.cellConfig = { ...this.cellConfig, source };
    this.cellKey = hexbinProgramKey('cell', this.cellConfig);
    this.pickCellKey = hexbinProgramKey('pick-cell', this.cellConfig);
    this.cellHandles = undefined;
    this.cellVariant = undefined;
    this.pickHandles = undefined;
    this.pickVariant = undefined;
    if (source === 'cpu' && !this.warnedCpuFallback) {
      this.warnedCpuFallback = true;
      console.warn(
        `[${this.id}] hexbin aggregation fell back to the CPU (no ` +
          'colour-renderable float texture, no vertex texture units, or ' +
          '`gpuAggregation: false`). The aggregate is recomputed when the ' +
          'resident tile set changes, NOT as the play head moves — the same ' +
          "divergence deck documents for HexagonLayer's CPU aggregator.",
      );
    }
  }

  /** Allocate / resize the scatter target for the current table. */
  private ensureAggregateTarget(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    width: number,
    height: number,
  ): boolean {
    const fmt = this.aggregateFormat;
    if (!fmt || fmt.label === 'none' || width <= 0 || height <= 0) return false;
    if (
      this.aggregateFbo &&
      this.aggregateWidth === width &&
      this.aggregateHeight === height
    ) {
      return true;
    }
    if (this.aggregateFbo) gl.deleteFramebuffer(this.aggregateFbo);
    if (this.aggregateTexture) gl.deleteTexture(this.aggregateTexture);
    this.aggregateFbo = gl.createFramebuffer()!;
    this.aggregateTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.aggregateTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      fmt.internalFormat,
      width,
      height,
      0,
      fmt.format,
      fmt.type,
      null,
    );
    // NEAREST + CLAMP: a bin owns exactly one texel and must read it exactly.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.aggregateFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.aggregateTexture,
      0,
    );
    // Drivers advertise float colour buffers they then refuse to attach —
    // verify, and demote to the CPU path rather than scattering into nothing.
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(this.aggregateFbo);
      gl.deleteTexture(this.aggregateTexture);
      this.aggregateFbo = undefined;
      this.aggregateTexture = undefined;
      this.aggregateWidth = 0;
      this.aggregateHeight = 0;
      this.aggregateFormat = { ...fmt, label: 'none' };
      return false;
    }
    this.aggregateWidth = width;
    this.aggregateHeight = height;
    return true;
  }

  // ── palette ───────────────────────────────────────────────────────────────

  /**
   * Bake the ramp into a 256×1 RGBA texture. `'quantize'` (deck's default)
   * writes flat bands — with NEAREST sampling that reproduces deck's discrete
   * `quantizeScale` exactly, at zero shader cost — while `'linear'` blends
   * between stops.
   */
  private uploadPalette(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (!this.paletteTexture) return;
    const range = this.hexOpts.colorRange;
    const data = new Uint8Array(PALETTE_SIZE * 4);
    const linear = this.hexOpts.colorScaleType === 'linear';
    const stops = Math.max(1, range.length);
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const u = i / (PALETTE_SIZE - 1);
      let r: number, g: number, b: number, a: number;
      if (linear) {
        const t = u * (stops - 1);
        const lo = Math.floor(t);
        const hi = Math.min(stops - 1, lo + 1);
        const f = t - lo;
        const ca = range[lo];
        const cb = range[hi];
        r = ca[0] * (1 - f) + cb[0] * f;
        g = ca[1] * (1 - f) + cb[1] * f;
        b = ca[2] * (1 - f) + cb[2] * f;
        a = (ca[3] ?? 255) * (1 - f) + (cb[3] ?? 255) * f;
      } else {
        const band = Math.min(stops - 1, Math.floor(u * stops));
        const c = range[band];
        [r, g, b] = [c[0], c[1], c[2]];
        a = c[3] ?? 255;
      }
      data[i * 4] = Math.round(r);
      data[i * 4 + 1] = Math.round(g);
      data[i * 4 + 2] = Math.round(b);
      data[i * 4 + 3] = Math.round(a);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      PALETTE_SIZE,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    // NEAREST: `quantize` bands must not bleed into each other, and `linear` is
    // already resolved at 256 samples.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.paletteDirty = false;
  }

  // ── programs ──────────────────────────────────────────────────────────────

  private buildScatterHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): ScatterHandles {
    const program = this.linkProgram(
      gl,
      buildHexbinScatterVertexSource(this.scatterConfig),
      HEXBIN_SCATTER_FS,
    );
    return {
      program,
      aBinIndex: gl.getAttribLocation(program, 'aBinIndex'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aWeight: gl.getAttribLocation(program, 'aWeight'),
      aFilterValue: this.scatterConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      uBinTexSize: gl.getUniformLocation(program, 'uBinTexSize'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
      ...resolveFilterTransformSizeUniformLocation(gl, program),
    };
  }

  private buildCellHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): CellHandles {
    const program = this.linkProgram(
      gl,
      pick
        ? buildHexbinCellIdVertexSource(shader, this.cellConfig)
        : buildHexbinCellVertexSource(shader, this.cellConfig),
      pick ? HEXBIN_ID_FS : HEXBIN_CELL_FS,
    );
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aUnit: gl.getAttribLocation(program, 'aUnit'),
      aCenter: gl.getAttribLocation(program, 'aCenter'),
      aBinCoord:
        this.cellConfig.source === 'gpu'
          ? gl.getAttribLocation(program, 'aBinCoord')
          : -1,
      aBinValue:
        this.cellConfig.source === 'cpu'
          ? gl.getAttribLocation(program, 'aBinValue')
          : -1,
      aIdColor: pick ? gl.getAttribLocation(program, 'aIdColor') : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uAggregate: gl.getUniformLocation(program, 'uAggregate'),
      uPalette: gl.getUniformLocation(program, 'uPalette'),
      uOpacity: gl.getUniformLocation(program, 'uOpacity'),
      uRadiusMerc: gl.getUniformLocation(program, 'uRadiusMerc'),
      uColorDomain: gl.getUniformLocation(program, 'uColorDomain'),
      uElevationDomain: gl.getUniformLocation(program, 'uElevationDomain'),
      uValueClip: gl.getUniformLocation(program, 'uValueClip'),
      uElevationRange: gl.getUniformLocation(program, 'uElevationRange'),
      uElevationScale: gl.getUniformLocation(program, 'uElevationScale'),
      uMercatorZPerMeter: gl.getUniformLocation(program, 'uMercatorZPerMeter'),
    };
  }

  private readonly scatterFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): ScatterHandles => this.buildScatterHandles(gl);

  private readonly cellFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): CellHandles => this.buildCellHandles(gl, shader, false);

  private readonly pickCellFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): CellHandles => this.buildCellHandles(gl, shader, true);

  /** The draw model is one shared mesh × N instances; instancing is mandatory. */
  private ensureInstancing(): boolean {
    if (this.instSupport.enabled) return true;
    if (!this.warnedNoInstancing) {
      this.warnedNoInstancing = true;
      console.warn(
        `[${this.id}] instanced drawing is unavailable (no WebGL2 and no ` +
          `ANGLE_instanced_arrays); the hexbin layer renders nothing`,
      );
    }
    return false;
  }

  private ensureMesh(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!this.mesh) this.mesh = buildHexbinMesh(true);
    if (!this.meshVertexBuffer) {
      this.meshVertexBuffer = this.uploadArrayBuffer(gl, this.mesh.vertices);
      const indexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);
      this.meshIndexBuffer = indexBuffer;
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  /**
   * Hexbin rendering replaces the base `render()` entirely: the draw is
   * layer-level (one instanced call over the union table), not per tile, and
   * the scatter pass has to wrap the per-tile point draws in an FBO
   * bind/unbind. `beginFrame` still runs FIRST (base contract).
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ): void {
    const frame = this.beginFrame(matrixOrArgs, options);
    if (!frame) return;
    if (!this.ensureInstancing()) return;

    this.applyAggregateSource(this.resolveAggregateSource(gl));

    // The table is the ONLY thing a frame can rebuild, and only when the
    // resident tile set / radius moved. A time change never reaches here.
    if (!this.tableMatchesTiles(gl)) {
      this.rebuildTable(gl);
      this.refreshCpuAggregate();
    }
    const table = this.table;
    if (!table || table.binCount === 0) return;

    if (this.paletteDirty) this.uploadPalette(gl);

    if (this.cellConfig.source === 'gpu') {
      this.runScatterPass(gl, frame, table);
    }

    this.applySharedGlState(gl);
    this.drawCells(gl, frame, table, null);
    this.unbindVao();
  }

  /**
   * Pass 1 — scatter every resident point into its bin's texel, additively.
   *
   * The host's render target and viewport are captured and restored (maplibre
   * may be draping into an offscreen target under terrain/globe), as is the
   * depth-test enable: on a `'3d'` layer the host installed a read-write depth
   * mode before calling us and the scatter must not be depth-tested against it.
   */
  private runScatterPass(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    table: HexbinTable,
  ): void {
    if (!this.ensureAggregateTarget(gl, table.texWidth, table.texHeight)) {
      // The format probe demoted itself mid-flight — take the CPU path from
      // the next frame on, and skip this one's aggregate rather than drawing
      // cells against a target that was never written.
      this.applyAggregateSource('cpu');
      this.refreshCpuAggregate();
      return;
    }

    const prevFramebuffer = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.aggregateFbo!);
    gl.viewport(0, 0, table.texWidth, table.texHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive: R = Σ w·gate, G = Σ gate
    gl.disable(gl.DEPTH_TEST);

    const variant = frame.shader.variantName;
    let h = this.scatterHandles;
    if (!h || this.scatterVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        this.scatterKey,
        frame,
        this.scatterFactory,
      );
      this.scatterHandles = h;
      this.scatterVariant = variant;
    }
    gl.useProgram(h.program);
    // No projection uniforms: the scatter pass is position-free by
    // construction (the bin index is the position), which is also why it is
    // identical on every host variant.
    gl.uniform2f(h.uBinTexSize, table.texWidth, table.texHeight);
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    gl.uniform1f(h.uFadeIn, fadeIn);
    gl.uniform1f(h.uFadeOut, fadeOut);
    gl.uniform1f(h.uWakeLength, this.hexOpts.wakeLength);
    gl.uniform1f(h.uTrailLength, this.hexOpts.trailLength);
    gl.uniform1f(h.uFadeTrail, this.hexOpts.fadeTrail);

    const half = this.opts.timeWindow / 2;
    const currentTime = this.opts.currentTime;
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.tileGpuCache.get(this.tileCacheKey(tile, layer)) as
          | HexbinGpuCache
          | null
          | undefined;
        if (!cache || cache.pointCount <= 0) continue;
        // Every time uniform is TILE-RELATIVE (the package-wide convention).
        const rel = currentTime - cache.timeOffset;
        gl.uniform1f(h.uCurrentTime, rel);
        gl.uniform1f(h.uWindowStart, rel - half);
        gl.uniform1f(h.uWindowEnd, rel + half);
        if (this.scatterConfig.filter) {
          this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn);
        }

        // A VAO records locations belonging to ONE linked program; the scatter
        // program is variant-independent but a runtime relink still changes it.
        if (cache.vao && cache.vaoProgramKey !== this.scatterKey) {
          this.vaoSupport.delete(cache.vao);
          cache.vao = null;
        }
        this.bindVaoOrSetup(cache, () => {
          gl.bindBuffer(gl.ARRAY_BUFFER, cache.binIndexBuffer!);
          gl.enableVertexAttribArray(h!.aBinIndex);
          gl.vertexAttribPointer(h!.aBinIndex, 1, gl.FLOAT, false, 0, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
          gl.enableVertexAttribArray(h!.aTime);
          gl.vertexAttribPointer(h!.aTime, 2, gl.FLOAT, false, 0, 0);

          if (cache.weightBuffer && h!.aWeight >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, cache.weightBuffer);
            gl.enableVertexAttribArray(h!.aWeight);
            gl.vertexAttribPointer(h!.aWeight, 1, gl.FLOAT, false, 0, 0);
          }
          if (cache.filterBuffer && h!.aFilterValue >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, cache.filterBuffer);
            gl.enableVertexAttribArray(h!.aFilterValue);
            gl.vertexAttribPointer(h!.aFilterValue, 1, gl.FLOAT, false, 0, 0);
          }
        });
        cache.vaoProgramKey = this.scatterKey;

        gl.drawArrays(gl.POINTS, 0, cache.pointCount);
      }
    }
    this.unbindVao();

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.viewport(
      prevViewport[0],
      prevViewport[1],
      prevViewport[2],
      prevViewport[3],
    );
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
  }

  /**
   * Pass 2 — one instanced draw over the whole union table.
   *
   * `idBuffer` non-null selects the id-pick program; every value, clip and
   * elevation uniform is set identically in both, which is what makes "a cell
   * the user cannot see is not pickable" structural rather than a convention.
   */
  private drawCells(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    table: HexbinTable,
    idBuffer: WebGLBuffer | null,
  ): void {
    this.ensureMesh(gl);
    const pick = idBuffer !== null;
    const variant = frame.shader.variantName;
    let h = pick ? this.pickHandles : this.cellHandles;
    const cachedVariant = pick ? this.pickVariant : this.cellVariant;
    if (!h || cachedVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        pick ? this.pickCellKey : this.cellKey,
        frame,
        pick ? this.pickCellFactory : this.cellFactory,
      );
      if (pick) {
        this.pickHandles = h;
        this.pickVariant = variant;
      } else {
        this.cellHandles = h;
        this.cellVariant = variant;
      }
    }

    gl.useProgram(h.program);
    if (h.usesPrelude) this.setPreludeProjectionUniforms(gl, h.program, frame);
    else gl.uniformMatrix4fv(h.uMatrix, false, frame.matrix);

    const o = this.hexOpts;
    gl.uniform1f(h.uRadiusMerc, table.radiusMerc * clamp01(o.coverage));
    gl.uniform2f(
      h.uColorDomain,
      this.resolvedColorDomain[0],
      this.resolvedColorDomain[1],
    );
    gl.uniform2f(
      h.uElevationDomain,
      this.resolvedElevationDomain[0],
      this.resolvedElevationDomain[1],
    );
    gl.uniform2f(
      h.uValueClip,
      this.resolvedValueClip[0],
      this.resolvedValueClip[1],
    );
    gl.uniform2f(h.uElevationRange, o.elevationRange[0], o.elevationRange[1]);
    // `extruded: false` flattens by scaling every height to 0 — the cap then
    // lands on the ground, which is the flat-hexagon primitive.
    gl.uniform1f(h.uElevationScale, o.extruded ? o.elevationScale : 0);
    gl.uniform1f(h.uMercatorZPerMeter, this.mercatorZPerMeter);
    gl.uniform1f(h.uOpacity, clamp01(o.opacity));

    if (this.cellConfig.source === 'gpu' && this.aggregateTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.aggregateTexture);
      gl.uniform1i(h.uAggregate, 0);
    }
    if (this.paletteTexture) {
      gl.activeTexture(gl.TEXTURE0 + 1);
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.uniform1i(h.uPalette, 1);
      gl.activeTexture(gl.TEXTURE0);
    }

    // The cell pass is ONE draw per frame, so binding four attributes beats
    // carrying a layer-level VAO that a table rebuild would have to invalidate.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVertexBuffer!);
    gl.enableVertexAttribArray(h.aUnit);
    gl.vertexAttribPointer(h.aUnit, 4, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aUnit, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndexBuffer!);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuffer!);
    gl.enableVertexAttribArray(h.aCenter);
    gl.vertexAttribPointer(h.aCenter, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCenter, 1);

    if (h.aBinCoord >= 0 && this.coordBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.coordBuffer);
      gl.enableVertexAttribArray(h.aBinCoord);
      gl.vertexAttribPointer(h.aBinCoord, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aBinCoord, 1);
    }
    if (h.aBinValue >= 0 && this.valueBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer);
      gl.enableVertexAttribArray(h.aBinValue);
      gl.vertexAttribPointer(h.aBinValue, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aBinValue, 1);
    }
    if (pick && h.aIdColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer!);
      gl.enableVertexAttribArray(h.aIdColor);
      gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aIdColor, 1);
    }

    this.instSupport.drawElementsInstanced(
      gl.TRIANGLES,
      this.mesh!.indexCount,
      gl.UNSIGNED_SHORT,
      0,
      table.binCount,
    );

    // Leave the attribute slate — and every divisor — clean. A pick runs
    // OUTSIDE the host's render pass, so nothing else will do it for us.
    gl.disableVertexAttribArray(h.aUnit);
    gl.disableVertexAttribArray(h.aCenter);
    this.instSupport.vertexAttribDivisor(h.aCenter, 0);
    if (h.aBinCoord >= 0 && this.coordBuffer) {
      gl.disableVertexAttribArray(h.aBinCoord);
      this.instSupport.vertexAttribDivisor(h.aBinCoord, 0);
    }
    if (h.aBinValue >= 0 && this.valueBuffer) {
      gl.disableVertexAttribArray(h.aBinValue);
      this.instSupport.vertexAttribDivisor(h.aBinValue, 0);
    }
    if (pick && h.aIdColor >= 0) {
      gl.disableVertexAttribArray(h.aIdColor);
      this.instSupport.vertexAttribDivisor(h.aIdColor, 0);
    }
  }

  /** Unused — hexbin overrides `render()` entirely (see the heatmap layer). */
  protected drawTile(): void {
    /* no-op */
  }

  // ── picking ───────────────────────────────────────────────────────────────

  /**
   * Pick CELLS, not source points.
   *
   * The base's default provenance allocates one id per FEATURE per (tile,
   * layer) — the right model for every kind whose draw unit is a feature. A
   * hexbin's draw unit is an aggregate of many features from many tiles, so the
   * whole layer contributes ONE entry covering `[1, binCount]`; a decoded id is
   * a dense bin index, which {@link resolvePick} turns into cell statistics
   * rather than a row join.
   *
   * The `tile`/`layer`/`cache` fields are carried purely to satisfy the entry
   * shape (the base hands them straight back to {@link drawPickTile}, which
   * ignores them) — the first resident point layer stands in.
   */
  protected buildPickProvenance(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): PickProvenanceEntry[] {
    if (!this.tableMatchesTiles(gl)) {
      this.rebuildTable(gl);
      this.refreshCpuAggregate();
    }
    const table = this.table;
    if (!table || table.binCount === 0) return [];
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(gl, tile, layer);
        if (!cache) continue;
        return [{ tile, layer, cache, idBase: 1, count: table.binCount }];
      }
    }
    return [];
  }

  /**
   * Decode a read-back id triple into one CELL. The reported `object` is the
   * cell's own statistics — its lattice address, centre, contributing count and
   * aggregated value — because there is no single source row to join to.
   * `index` is the dense bin index.
   *
   * The value comes from the CPU sample, which is exact on the CPU path and a
   * table-build-time snapshot on the GPU path (a pick cannot read back the
   * live scatter target without stalling the frame); `count`/`value` are
   * therefore reported as `null` when no sample exists.
   */
  protected resolvePick(
    rgb: readonly [number, number, number],
    provenance: readonly PickProvenanceEntry[],
  ): SttPickResult | null {
    const base = super.resolvePick(rgb, provenance);
    if (!base) return null;
    const table = this.table;
    if (!table || base.index < 0 || base.index >= table.binCount) return null;
    const key = table.keys[base.index];
    const agg = this.cpuAggregate;
    const sum = agg ? agg[base.index * 2] : null;
    const count = agg ? agg[base.index * 2 + 1] : null;
    return {
      ...base,
      object: {
        binIndex: base.index,
        i: hexBinKeyI(key),
        j: hexBinKeyJ(key),
        centerMercator: [
          table.centers[base.index * 2],
          table.centers[base.index * 2 + 1],
        ],
        radiusMeters: this.hexOpts.radius,
        count,
        value:
          sum !== null && count !== null
            ? hexbinCellValue(sum, count, this.colorAggregation())
            : null,
        aggregation: compileAggregation(this.colorAggregation()),
      },
    };
  }

  /**
   * Draw the whole table into the id-pick FBO. Called once (the provenance has
   * one entry), so the tile/layer/cache arguments are ignored — the cells being
   * painted belong to the union table, not to any single tile.
   *
   * The pick program reproduces every visibility gate the visual pass applies:
   * the same aggregate source, the same empty-bin test, the same percentile
   * clip and the same palette-alpha discard. Because this kind renders
   * depth-TESTED by default, the base runs the pass against a depth attachment,
   * so the cell the user can SEE wins the texel.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: STTLayer,
    _cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const table = this.table;
    if (!table || table.binCount === 0 || !this.ensureInstancing()) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    if (this.paletteDirty) this.uploadPalette(gl);
    const idColors = this.buildPickIdColors(table.binCount, idBase);
    const idBuffer = this.uploadArrayBuffer(gl, idColors);
    this.drawCells(gl, frame, table, idBuffer);
    gl.deleteBuffer(idBuffer);
  }
}

// ── small helpers ───────────────────────────────────────────────────────────

/**
 * Create-or-overwrite an ARRAY_BUFFER. Reusing the handle is what lets a table
 * rebuild refresh per-instance data without invalidating anything that recorded
 * the binding.
 */
function writeBuffer(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  buffer: WebGLBuffer | undefined,
  data: ArrayBufferView,
): WebGLBuffer {
  const buf = buffer ?? gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buf;
}

/**
 * Dense bin indices as floats. GLSL ES 1.00 has no integer attributes, so the
 * scatter shader reads `aBinIndex` as a float; `-1` (the drop sentinel) and
 * every index below 2^24 survive the conversion exactly, and the table is
 * clamped well below that.
 */
function toFloat32(indices: Int32Array): Float32Array {
  const out = new Float32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = indices[i];
  return out;
}
