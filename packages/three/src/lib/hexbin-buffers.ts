// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of a RUNTIME hexbin over the **raw point tier** —
 * the Three analogue of deck's `AnimatedHexagonLayer` and of maplibre's
 * `STTHexbinLayer`, and the discrete / pickable / extruded counterpart of the
 * smooth heatmap.
 *
 * ── This is NOT the h3Summary path ──────────────────────────────────────────
 * `h3-buffers.ts` DECODES a precomputed summary tier: every cell already exists
 * in the archive, keyed by an H3 `featureIds64`, and the builder only has to
 * turn an id into a boundary ring. Nothing here decodes anything. This builder
 * BINS raw features into a world-space hexagonal lattice at runtime and
 * aggregates their weights per cell, exactly as deck's `HexagonLayer` does — so
 * an archive with no summary tier at all still gets the iconic hexagon look,
 * and the cells re-aggregate as the play head moves. The two are genuinely
 * different machines; the descriptor's old `hexbin → h3Summary` fallback was
 * never equivalent.
 *
 * ── The lattice, and why it lives in MERCATOR and not in world space ────────
 * The bin address of a feature is a pure function of `(mercatorXY, radiusMerc)`
 * — {@link hexbinKeyForPoint}, deck's `pointToHexbin` verbatim (itself adapted
 * from d3-hexbin), evaluated in the mercator unit square. Binning there rather
 * than in the layer's own projected world space buys three things at once:
 *
 *  1. **Projection independence.** ENU, Mercator and the ECEF globe are the
 *     three frames this backend renders in, and only one of them is planar in
 *     ground metres. A lattice pitched in ECEF world units would be a lattice
 *     of chords through the earth. The mercator unit square is the one flat
 *     frame all three share, and the CELL is then projected through
 *     `projection.project` like any other geometry — so the same bins render
 *     correctly on the globe.
 *  2. **Cross-backend identity.** The kernel is byte-for-byte the one
 *     `@poopdeck.gl/maplibre`'s `lib/cell-geometry.ts` ships (and deck's own),
 *     so the same archive at the same radius produces the SAME cells in all
 *     three backends. One kind, one lattice.
 *  3. **No tile seams.** The grid is world-anchored, not camera- or
 *     tile-anchored: two features either side of a tile boundary that fall in
 *     the same hexagon produce the same packed key and collapse into ONE cell
 *     fed by both tiles.
 *
 * The metric radius must be resolved at ONE latitude for the whole layer, or
 * the lattice pitch drifts between tiles and cells stop lining up. deck uses
 * its data-bounds centroid; so does this builder ({@link resolveHexbinLatitude}
 * — `radiusLatitude` if pinned, else the centre of the collected features' own
 * latitude span).
 *
 * ── The geometry-kind guard ────────────────────────────────────────────────
 * Which ENTRIES a tile layer contributes depends on its geometry kind, and
 * getting this wrong is silent:
 *  - **Point** tiles bin ONE entry per FEATURE;
 *  - **LineString** tiles bin one entry per **VERTEX**, so a trip archive
 *    hexbins TRACK DENSITY rather than the head of the first few tracks
 *    (feature indices are not vertex indices — reading `positions[i]` for
 *    feature `i` on a path tile lands on the first few tracks' first vertices);
 *  - **Polygon** tiles are SKIPPED with one named warning. A polygon's
 *    positions are ring vertices whose density says more about the digitiser
 *    than about the phenomenon, so binning them would be a plausible-looking
 *    lie. Point a polygon-shaped layer at `STTPolygonLayer` instead.
 * This mirrors `@poopdeck.gl/layers`' `buildConsolidatedChannelData`, which owns
 * the same guard for the deck heatmap/hexbin pair.
 *
 * ── The weight column (accessor-alias convention) ──────────────────────────
 * There are no per-feature JS accessors anywhere in this stack — tiles arrive
 * as binary columns. The weight is therefore a baked property-column NAME,
 * resolved through the package-wide accessor-alias convention by
 * {@link resolveHexbinWeightProperty}: `colorWeight` wins, then
 * `elevationWeight`, then the legacy `weightProperty`. A function-valued alias
 * warns ONCE and falls through to the next candidate. Unset ⇒ every entry
 * weighs 1, i.e. a pure COUNT hexbin. ONE weight column drives BOTH colour and
 * elevation (deck aliases its `getColorWeight`/`getElevationWeight` onto the
 * same consolidated buffer for exactly this reason).
 *
 * ── The static/dynamic split, and why it is a split ────────────────────────
 * {@link buildHexbinBuffers} produces everything that does NOT depend on the
 * play head: the lattice, the occupied cells, their projected centroids and
 * orientation bases, the per-cell provenance, and a CSR membership table
 * (`memberOffsets` + `memberWeights`/`memberStarts`/`memberEnds`) listing every
 * entry that landed in each cell. {@link aggregateHexbins} is the play-head half
 * — a pure reduction over that table that re-runs when the window moves and
 * emits the per-cell colour, height, visibility and temporal span the GPU
 * attributes carry. Binning is expensive and time-independent; aggregating is
 * cheap and time-dependent, so they are separated along exactly that seam and
 * the expensive half never re-runs for an unchanged tile set.
 *
 * ── RTC ────────────────────────────────────────────────────────────────────
 * Cell centroids are written f32 RELATIVE to `origin` (the first occupied
 * cell's projected centroid); the layer sets `object.position = origin` so the
 * large mercator/globe magnitudes stay in the f64 CPU transform. Basis vectors
 * are directions and stay absolute. Times are rebased against `timeOrigin`
 * exactly as every other builder here does.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { EARTH_RADIUS } from '@poopdeck.gl/core/geo';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { Projection } from '../projection/local-enu.js';
import { windowAlpha, type TimeFilterParams } from '../tsl/time-filter-math.js';
import { rampColorAt, type RGBA } from './color.js';
import { rampBucketColor } from './quadbin-buffers.js';
import { featureTileKey } from './id-pick.js';

// ── deck-parity defaults ────────────────────────────────────────────────────

/** deck `HexagonLayer.radius` — the cell CIRCUMRADIUS, in METRES. */
export const DEFAULT_HEXBIN_RADIUS_METERS = 1000;

/** deck `HexagonLayer.elevationRange` — METRES, low → high aggregate. */
export const DEFAULT_HEXBIN_ELEVATION_RANGE: [number, number] = [0, 1000];

/**
 * deck's canonical `HexagonLayer` ramp — ColorBrewer 6-class YlOrRd, low → high
 * aggregated weight. The same six stops `AnimatedHexagonLayer` and maplibre's
 * `DEFAULT_HEXBIN_COLOR_RANGE` carry, so one archive looks the same in every
 * backend; alpha is opaque because a hexbin cell is a solid prism, not a splat.
 */
export const DEFAULT_HEXBIN_COLOR_RANGE: RGBA[] = [
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [240, 59, 32, 255],
  [189, 0, 38, 255],
];

/**
 * Aggregation vocabulary — deck's `AggregationOperation`.
 *
 * Unlike maplibre (whose GPU scatter pass would need a second `blendEquation`
 * channel for an extremum, so it degrades `MIN`/`MAX` to `SUM`), this backend
 * aggregates on the CPU and can honour all five exactly.
 */
export type HexbinAggregation = 'SUM' | 'MEAN' | 'MIN' | 'MAX' | 'COUNT';

/**
 * Colour-scale vocabulary. `'quantize'` (deck's default) buckets the domain into
 * `colorRange.length` discrete bands; `'linear'` interpolates between the stops.
 * `'quantile'`/`'ordinal'` degrade to `'quantize'` with one warning — matching
 * maplibre, so the two backends cannot drift apart on the same prop.
 */
export type HexbinScaleType = 'quantize' | 'linear' | 'quantile' | 'ordinal';

/**
 * Value domain of the weight accessor aliases: a property-column NAME. The
 * function member exists only so upstream-shaped code compiles — a function
 * value warns once at runtime and is ignored (binary tiles cannot run
 * per-feature JS).
 */
export type HexbinWeightAccessor =
  | string
  | ((d: unknown) => unknown)
  | null
  | undefined;

// ── One-shot diagnostics ────────────────────────────────────────────────────

const WARNED = new Set<string>();

/** Emit `message` at most once per `key` for the life of the module. */
function warnOnce(key: string, message: string): void {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(message);
}

/**
 * Clear the one-shot warning ledger. TEST-ONLY: a suite that asserts on the
 * geometry-kind skip or the function-accessor fallback needs each case to warn
 * again in isolation. Production code never calls this.
 */
export function resetHexbinWarnings(): void {
  WARNED.clear();
}

// ── The mercator frame the lattice lives in ─────────────────────────────────
//
// The unit square (x, y ∈ [0,1], y increasing SOUTH) — deck's common space
// divided by 512, and maplibre's native tile frame. Kept local and tiny rather
// than pulled from `MercatorProjection`, whose `project` returns mercator METRES
// (±2e7) in whatever frame the layer happens to render in: the lattice must not
// move when the render projection changes.

/** Ground metres spanned by one full turn of the mercator x axis at the equator. */
const MERCATOR_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;

/** Latitude beyond which mercator `y` diverges; the standard clamp. */
const MAX_LAT = 85.051_128_779_806_59;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function clampLat(lat: number): number {
  return lat < -MAX_LAT ? -MAX_LAT : lat > MAX_LAT ? MAX_LAT : lat;
}

/** lon/lat (deg) → the mercator UNIT square, `y` increasing south. */
export function lngLatToMercatorUnit(
  longitude: number,
  latitude: number,
): [number, number] {
  const lat = clampLat(latitude) * DEG2RAD;
  return [
    (longitude + 180) / 360,
    0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI),
  ];
}

/** The exact inverse of {@link lngLatToMercatorUnit}. */
export function mercatorUnitToLngLat(x: number, y: number): [number, number] {
  const lat = 2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2;
  return [x * 360 - 180, lat * RAD2DEG];
}

/**
 * Ground metres → the mercator-unit hex CIRCUMRADIUS the lattice kernels take.
 *
 * `radius / (circumference · cos lat)` — the horizontal twin of the elevation
 * conversion, and exactly deck's `radiusCommon / 512`. Resolve it at ONE
 * latitude per layer (see the module header): a per-tile latitude makes the
 * pitch drift between tiles and the cells stop lining up.
 */
export function hexbinRadiusFromMeters(
  radiusMeters: number,
  latDeg: number,
): number {
  const denom = MERCATOR_CIRCUMFERENCE * Math.cos(clampLat(latDeg) * DEG2RAD);
  return denom > 0 ? radiusMeters / denom : 0;
}

// ── The lattice kernel (deck's `pointToHexbin`, verbatim) ───────────────────
//
// Row pitch is `1.5 · radius`, column pitch is `2 · sin(60°) · radius`, odd rows
// are offset half a column. deck bins in its 512-unit common space whose y
// points NORTH; this kernel flips y (`1 - my`) and works in unit-square units,
// so for `radiusMerc = radiusCommon / 512` the lattice, its origin and therefore
// its BIN IDS are identical to deck's.

const THIRD_PI = Math.PI / 3;
const HEX_DIST_X = 2 * Math.sin(THIRD_PI);
const HEX_DIST_Y = 1.5;

/**
 * Axial addresses pack into ONE exact double so binning can use a plain
 * `Map<number, …>` with no per-entry allocation: `key = (i + OFF) · STRIDE +
 * (j + OFF)`, `OFF = STRIDE / 2 = 2²⁵`. Exact in a double while `|i|, |j| < 2²⁵`
 * (max key ≈ 4.5e15 < 2⁵³), a bound a mercator radius only reaches below roughly
 * 0.6 m of ground radius.
 */
const HEX_KEY_STRIDE = 1 << 26;
const HEX_KEY_OFFSET = 1 << 25;

/**
 * Which hex cell a mercator-unit point falls into, as an axial `(i, j)` pair.
 * Rounds to the nearest lattice node, then corrects across the row boundary by
 * comparing squared distances to the two candidate centres — d3-hexbin's
 * rounding, which is what makes the partition exact rather than "close enough".
 *
 * Allocates a pair; use {@link hexbinKeyForPoint} in per-entry loops.
 */
export function pointToHexbinAxial(
  mx: number,
  my: number,
  radiusMerc: number,
): [number, number] {
  const py0 = (1 - my) / radiusMerc / HEX_DIST_Y;
  const pxRaw = mx / radiusMerc / HEX_DIST_X;
  let pj = Math.round(py0);
  const px0 = pxRaw - (pj & 1) / 2;
  let pi = Math.round(px0);
  const py1 = py0 - pj;
  if (Math.abs(py1) * 3 > 1) {
    const px1 = px0 - pi;
    const pi2 = pi + (px0 < pi ? -1 : 1) / 2;
    const pj2 = pj + (py0 < pj ? -1 : 1);
    const px2 = px0 - pi2;
    const py2 = py0 - pj2;
    if (px1 * px1 + py1 * py1 > px2 * px2 + py2 * py2) {
      pi = pi2 + (pj & 1 ? 1 : -1) / 2;
      pj = pj2;
    }
  }
  return [pi, pj];
}

/** Pack an axial address into one exact double; `NaN` outside the safe range. */
export function hexbinKey(i: number, j: number): number {
  if (
    i < -HEX_KEY_OFFSET ||
    i >= HEX_KEY_OFFSET ||
    j < -HEX_KEY_OFFSET ||
    j >= HEX_KEY_OFFSET
  ) {
    return NaN;
  }
  return (i + HEX_KEY_OFFSET) * HEX_KEY_STRIDE + (j + HEX_KEY_OFFSET);
}

/** `i` component of a {@link hexbinKey}. */
export function hexbinKeyI(key: number): number {
  return Math.floor(key / HEX_KEY_STRIDE) - HEX_KEY_OFFSET;
}

/** `j` component of a {@link hexbinKey}. */
export function hexbinKeyJ(key: number): number {
  return (key % HEX_KEY_STRIDE) - HEX_KEY_OFFSET;
}

/**
 * Allocation-free {@link pointToHexbinAxial} + {@link hexbinKey} — the form the
 * per-entry binning loop uses. Returns `NaN` for an address outside the packable
 * range; the caller DROPS those entries rather than letting them collapse into
 * one bucket.
 */
export function hexbinKeyForPoint(
  mx: number,
  my: number,
  radiusMerc: number,
): number {
  const [i, j] = pointToHexbinAxial(mx, my, radiusMerc);
  return hexbinKey(i, j);
}

/** Centre of hex cell `(i, j)` in the mercator unit square — deck's centroid. */
export function hexbinCentroidMercator(
  i: number,
  j: number,
  radiusMerc: number,
): [number, number] {
  return [
    (i + (j & 1) / 2) * radiusMerc * HEX_DIST_X,
    1 - j * radiusMerc * HEX_DIST_Y,
  ];
}

// ── Weight resolution ───────────────────────────────────────────────────────

/** The weight-alias subset of {@link HexbinBufferOptions}. */
export interface HexbinWeightOptions {
  /** Upstream alias for the colour weight column NAME. Wins over the rest. */
  colorWeight?: HexbinWeightAccessor;
  /** Upstream alias for the elevation weight column NAME. Second in line. */
  elevationWeight?: HexbinWeightAccessor;
  /** Legacy weight column name. Last in line; unset ⇒ a pure COUNT hexbin. */
  weightProperty?: string | null;
}

/**
 * Resolve the ONE baked column that weights every entry, in the documented
 * precedence: `colorWeight` → `elevationWeight` → `weightProperty` → `null`
 * (a pure COUNT hexbin, every entry weighing 1).
 *
 * A FUNCTION-valued alias warns once (per layer + prop) and falls through to the
 * next candidate rather than throwing: STT tiles are binary columns and a
 * per-feature accessor can never run, but a caller porting deck code should get
 * a working count hexbin plus a diagnostic, not a crash.
 */
export function resolveHexbinWeightProperty(
  opts: HexbinWeightOptions,
  layerId = 'STTHexbinLayer',
): string | null {
  const candidates: Array<[string, HexbinWeightAccessor]> = [
    ['colorWeight', opts.colorWeight],
    ['elevationWeight', opts.elevationWeight],
    ['weightProperty', opts.weightProperty],
  ];
  for (const [name, value] of candidates) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'function') {
      warnOnce(
        `${layerId}:${name}:functionAccessor`,
        `[${layerId}] ${name} received a function accessor. STT tiles are ` +
          'binary columns — per-feature accessors cannot run. Pass a ' +
          'property-column name instead; falling back to the next weight ' +
          'alias (or to a pure COUNT hexbin).',
      );
      continue;
    }
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// ── Build inputs / outputs ──────────────────────────────────────────────────

export interface HexbinBufferOptions extends HexbinWeightOptions {
  /** Cell CIRCUMRADIUS in true metres (deck `radius`). @default 1000 */
  radius?: number;
  /**
   * Latitude (degrees) the metric radius is resolved at. Unset ⇒ the centre of
   * the collected features' own latitude span (deck's data-bounds centroid
   * rule). Pin it to keep the lattice frozen while the visible tile set moves.
   */
  radiusLatitude?: number;
  /** Cell size multiplier, clamped 0..1 (deck pass-through). @default 1 */
  coverage?: number;
  /** Base altitude (metres) the cell footprints sit at. @default 0 */
  zLift?: number;
  /** Layer id used in the one-shot warnings. @default 'STTHexbinLayer' */
  layerId?: string;
}

export interface HexbinBuffers {
  /** Occupied cell count — the instance count, and the id space a pick decodes. */
  count: number;
  /** vec3 cell centroid, RTC-local (the footprint centre, on the ground). */
  bases: Float32Array;
  /** vec3 east × cellRadiusWorld × coverage (unit-prism X → ground east). */
  basisX: Float32Array;
  /** vec3 north × cellRadiusWorld × coverage (unit-prism Y → ground north). */
  basisY: Float32Array;
  /** vec3 local up ÷ metersPerWorldUnit — WORLD units per METRE of elevation. */
  basisZ: Float32Array;
  /** Packed lattice key per cell ({@link hexbinKey}). */
  cellKeys: Float64Array;
  /** Axial `(i, j)` per cell, interleaved. */
  cellIJ: Int32Array;
  /** Cell centroid lon/lat per cell, interleaved — what a pick reports. */
  cellLngLat: Float64Array;
  /** CSR row starts into the member arrays; length `count + 1`. */
  memberOffsets: Uint32Array;
  /** Per-member weight (1s when there is no weight column). */
  memberWeights: Float32Array;
  /** Per-member start time, rebased against `timeOrigin`. */
  memberStarts: Float32Array;
  /** Per-member end time, rebased against `timeOrigin`. */
  memberEnds: Float32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-CELL provenance — and per-cell is the point. Every other id-pickable
   * kind in this package is 1 instance ⇄ 1 source feature; a hexbin cell
   * aggregates MANY features, so the entry recorded here is its FIRST
   * contributing feature in merge order, a deterministic REPRESENTATIVE rather
   * than the identity of the whole cell. `memberOffsets` gives the real
   * contributor count. Pushed in dense-cell-index order, which IS draw order, so
   * a decoded GPU id indexes it directly.
   */
  provenance: InstanceProvenance;
  /** `tileKey` → source {@link BinaryFeatures}, for the provenance join. */
  binaryByTileKey: Map<string, BinaryFeatures>;
  /** Mercator-unit circumradius the lattice was pitched at (diagnostic). */
  radiusMerc: number;
  /** Latitude the metric radius was resolved at (diagnostic). */
  latitude: number;
  /** Entries offered to the lattice (features for points, vertices for paths). */
  entryCount: number;
  /** Entries dropped for an unpackable lattice address. */
  droppedEntries: number;
  /** Tile layers skipped by the geometry-kind guard. */
  skippedLayers: number;
  /** The resolved weight column, or `null` for a pure COUNT hexbin. */
  weightProperty: string | null;
}

function emptyBuffers(
  weightProperty: string | null,
  latitude: number,
  radiusMerc: number,
  skippedLayers = 0,
): HexbinBuffers {
  return {
    count: 0,
    bases: new Float32Array(0),
    basisX: new Float32Array(0),
    basisY: new Float32Array(0),
    basisZ: new Float32Array(0),
    cellKeys: new Float64Array(0),
    cellIJ: new Int32Array(0),
    cellLngLat: new Float64Array(0),
    memberOffsets: new Uint32Array(1),
    memberWeights: new Float32Array(0),
    memberStarts: new Float32Array(0),
    memberEnds: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
    provenance: new InstanceProvenance(),
    binaryByTileKey: new Map(),
    radiusMerc,
    latitude,
    entryCount: 0,
    droppedEntries: 0,
    skippedLayers,
    weightProperty,
  };
}

/** One tile layer's contribution, with the geometry-kind decision baked in. */
interface HexbinPart {
  b: BinaryFeatures;
  tileKey: string;
  /** Walk VERTICES via `startIndices` instead of one entry per feature. */
  isPath: boolean;
  /** Entries this part offers (vertices for paths, features otherwise). */
  entries: number;
}

/**
 * Collect the tile layers this kind reads, applying the geometry-kind guard
 * documented in the module header. Polygon (and any unknown) geometry is skipped
 * with ONE named warning rather than mis-read as points.
 */
function collectHexbinParts(
  tiles: Tile[],
  layerId: string,
): { parts: HexbinPart[]; total: number; skipped: number } {
  const parts: HexbinPart[] = [];
  let total = 0;
  let skipped = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount) continue;
      const gt = b.geometryType;
      if (gt !== GeometryType.Point && gt !== GeometryType.LineString) {
        skipped++;
        warnOnce(
          `${layerId}:geometryKind:${gt}`,
          `[${layerId}] tile layer ${JSON.stringify(tl.name)} carries ` +
            'Polygon geometry, but a runtime hexbin bins POINT or LineString ' +
            "tiers. Skipping it — a polygon ring's vertex density describes " +
            'the digitiser, not the phenomenon, so binning it would be a ' +
            'plausible-looking lie. Use STTPolygonLayer for this layer.',
        );
        continue;
      }
      // A LineString layer with no startIndices cannot be walked as vertices;
      // the decoder always emits them, so this is a fixtures-only fallback and
      // it degrades to the point-shaped reading rather than throwing.
      const isPath = gt === GeometryType.LineString && b.startIndices != null;
      let entries = b.featureCount;
      if (isPath) {
        const si = b.startIndices!;
        entries = si[b.featureCount] - si[0];
      }
      if (entries <= 0) continue;
      parts.push({
        b,
        tileKey: featureTileKey(tile.id, tl.name),
        isPath,
        entries,
      });
      total += entries;
    }
  }
  return { parts, total, skipped };
}

/**
 * The latitude the metric radius resolves at: `radiusLatitude` when pinned, else
 * the CENTRE of the collected features' latitude span (deck's data-bounds rule).
 * Exported so a caller can pin the value the first frame resolved and stop the
 * lattice from breathing as tiles come and go.
 */
export function resolveHexbinLatitude(
  latMin: number,
  latMax: number,
  pinned?: number,
): number {
  if (pinned != null && Number.isFinite(pinned)) return pinned;
  if (!Number.isFinite(latMin) || !Number.isFinite(latMax)) return 0;
  return (latMin + latMax) / 2;
}

/**
 * Bin every visible feature into the hexagonal lattice and emit the per-cell
 * static geometry + the CSR membership table {@link aggregateHexbins} reduces.
 *
 * @param tiles       visible tiles (any mix of point and path tiers).
 * @param projection  the render projection — used ONLY to place a cell, never to
 *                    address one (see the module header).
 * @param timeOrigin  layer time origin; every member time is rebased against it.
 */
export function buildHexbinBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: HexbinBufferOptions = {},
): HexbinBuffers {
  const layerId = opts.layerId ?? 'STTHexbinLayer';
  const weightProperty = resolveHexbinWeightProperty(opts, layerId);
  const radiusMeters = opts.radius ?? DEFAULT_HEXBIN_RADIUS_METERS;
  const coverage = Math.max(0, Math.min(1, opts.coverage ?? 1));
  const zLift = opts.zLift ?? 0;

  const { parts, total, skipped } = collectHexbinParts(tiles, layerId);
  if (total === 0) {
    const lat = resolveHexbinLatitude(NaN, NaN, opts.radiusLatitude);
    return emptyBuffers(
      weightProperty,
      lat,
      hexbinRadiusFromMeters(radiusMeters, lat),
      skipped,
    );
  }

  // ── Pass A: the latitude span, so the lattice pitch is resolved ONCE. ──────
  let latMin = Infinity;
  let latMax = -Infinity;
  for (const part of parts) {
    const b = part.b;
    const dims = b.positionDimensions ?? 2;
    const lo = part.isPath ? b.startIndices![0] : 0;
    const hi = part.isPath ? b.startIndices![b.featureCount] : b.featureCount;
    for (let v = lo; v < hi; v++) {
      const lat = b.positions[v * dims + 1];
      if (lat < latMin) latMin = lat;
      if (lat > latMax) latMax = lat;
    }
  }
  const latitude = resolveHexbinLatitude(latMin, latMax, opts.radiusLatitude);
  const radiusMerc = hexbinRadiusFromMeters(radiusMeters, latitude);
  if (!(radiusMerc > 0)) {
    return emptyBuffers(weightProperty, latitude, radiusMerc, skipped);
  }

  // ── Pass B: bin every entry, interning cells in first-seen (merge) order. ──
  const entryCell = new Int32Array(total);
  const entryWeight = new Float32Array(total);
  const entryStart = new Float32Array(total);
  const entryEnd = new Float32Array(total);
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const denseByKey = new Map<number, number>();
  const cellKeyList: number[] = [];
  // The representative feature per cell: the FIRST entry that opened it.
  const repPart: number[] = [];
  const repFeature: number[] = [];
  let dropped = 0;
  let e = 0;

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const b = part.b;
    binaryByTileKey.set(part.tileKey, b);
    const dims = b.positionDimensions ?? 2;
    const weights = weightProperty ? b.numericProps[weightProperty] : undefined;
    const rebase = b.timeOffset - timeOrigin;
    const startIndices = part.isPath ? b.startIndices! : null;
    const vertexTimes = part.isPath ? b.vertexTimestamps : undefined;

    for (let f = 0; f < b.featureCount; f++) {
      const w = weights ? weights[f] : 1;
      const fs = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const fe = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      const vLo = startIndices ? startIndices[f] : f;
      const vHi = startIndices ? startIndices[f + 1] : f + 1;
      for (let v = vLo; v < vHi; v++) {
        const lon = b.positions[v * dims];
        const lat = b.positions[v * dims + 1];
        // Per-vertex timestamps make a path's members land in the window at the
        // moment the track passed through them, which is what "track density
        // right now" means; without them the whole track shares its feature
        // span (deck's `buildConsolidatedChannelData` makes the same choice).
        const s = vertexTimes ? vertexTimes[v] + rebase : fs;
        const t = vertexTimes ? s : fe;
        const [mx, my] = lngLatToMercatorUnit(lon, lat);
        const key = hexbinKeyForPoint(mx, my, radiusMerc);
        if (Number.isNaN(key)) {
          entryCell[e] = -1;
          dropped++;
          e++;
          continue;
        }
        let dense = denseByKey.get(key);
        if (dense === undefined) {
          dense = cellKeyList.length;
          denseByKey.set(key, dense);
          cellKeyList.push(key);
          repPart.push(p);
          repFeature.push(f);
        }
        entryCell[e] = dense;
        entryWeight[e] = w;
        entryStart[e] = s;
        entryEnd[e] = t;
        e++;
      }
    }
  }

  const count = cellKeyList.length;
  if (count === 0) {
    return emptyBuffers(weightProperty, latitude, radiusMerc, skipped);
  }

  // ── CSR: counting sort of the entries by dense cell index. ────────────────
  const memberOffsets = new Uint32Array(count + 1);
  for (let i = 0; i < total; i++) {
    const c = entryCell[i];
    if (c >= 0) memberOffsets[c + 1]++;
  }
  for (let c = 0; c < count; c++) memberOffsets[c + 1] += memberOffsets[c];
  const memberCount = memberOffsets[count];
  const memberWeights = new Float32Array(memberCount);
  const memberStarts = new Float32Array(memberCount);
  const memberEnds = new Float32Array(memberCount);
  const cursor = Uint32Array.from(memberOffsets.subarray(0, count));
  for (let i = 0; i < total; i++) {
    const c = entryCell[i];
    if (c < 0) continue;
    const slot = cursor[c]++;
    memberWeights[slot] = entryWeight[i];
    memberStarts[slot] = entryStart[i];
    memberEnds[slot] = entryEnd[i];
  }

  // ── Cell geometry (RTC) + provenance. ─────────────────────────────────────
  const provenance = new InstanceProvenance();
  const bases = new Float32Array(count * 3);
  const basisX = new Float32Array(count * 3);
  const basisY = new Float32Array(count * 3);
  const basisZ = new Float32Array(count * 3);
  const cellKeys = Float64Array.from(cellKeyList);
  const cellIJ = new Int32Array(count * 2);
  const cellLngLat = new Float64Array(count * 2);

  // The unit prism (`makeColumnPrismGeometry(6, …)`) has an INCIRCLE of 1, while
  // deck's `radius` is the CIRCUMRADIUS — so the ground scale is `R · cos(30°)`.
  const INCIRCLE_PER_CIRCUMRADIUS = Math.sqrt(3) / 2;
  const groundScale = radiusMeters * INCIRCLE_PER_CIRCUMRADIUS * coverage;

  let origin: [number, number, number] | null = null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let c = 0; c < count; c++) {
    const key = cellKeys[c];
    const i = hexbinKeyI(key);
    const j = hexbinKeyJ(key);
    cellIJ[c * 2] = i;
    cellIJ[c * 2 + 1] = j;
    const [mx, my] = hexbinCentroidMercator(i, j, radiusMerc);
    const [lon, lat] = mercatorUnitToLngLat(mx, my);
    cellLngLat[c * 2] = lon;
    cellLngLat[c * 2 + 1] = lat;

    const world = projection.project(lon, lat, zLift);
    if (!origin) origin = world;
    bases[c * 3] = world[0] - origin[0];
    bases[c * 3 + 1] = world[1] - origin[1];
    bases[c * 3 + 2] = world[2] - origin[2];

    // metric → world: 1 world unit is `metersPerWorldUnit` ground metres.
    const inv = 1 / projection.metersPerWorldUnit(lon, lat);
    const rWorld = groundScale * inv;
    const frame = projection.localFrame(lon, lat);
    const east = frame.east;
    const north = frame.north;
    const up = frame.up;
    basisX[c * 3] = east[0] * rWorld;
    basisX[c * 3 + 1] = east[1] * rWorld;
    basisX[c * 3 + 2] = east[2] * rWorld;
    basisY[c * 3] = north[0] * rWorld;
    basisY[c * 3 + 1] = north[1] * rWorld;
    basisY[c * 3 + 2] = north[2] * rWorld;
    // Elevation is a per-cell METRE height the material scales this by, so the
    // basis carries world units per metre of altitude (not a baked height) —
    // that is what lets a re-aggregation move only a 1-float attribute.
    basisZ[c * 3] = up[0] * inv;
    basisZ[c * 3 + 1] = up[1] * inv;
    basisZ[c * 3 + 2] = up[2] * inv;

    // The footprint's own axis-aligned extent; the elevation half is added once
    // below, since the height is a play-head quantity the builder does not own.
    const bx = bases[c * 3];
    const by = bases[c * 3 + 1];
    const bz = bases[c * 3 + 2];
    const ex = Math.abs(basisX[c * 3]) + Math.abs(basisY[c * 3]);
    const ey = Math.abs(basisX[c * 3 + 1]) + Math.abs(basisY[c * 3 + 1]);
    const ez = Math.abs(basisX[c * 3 + 2]) + Math.abs(basisY[c * 3 + 2]);
    if (bx - ex < minX) minX = bx - ex;
    if (by - ey < minY) minY = by - ey;
    if (bz - ez < minZ) minZ = bz - ez;
    if (bx + ex > maxX) maxX = bx + ex;
    if (by + ey > maxY) maxY = by + ey;
    if (bz + ez > maxZ) maxZ = bz + ez;

    provenance.push(parts[repPart[c]].tileKey, repFeature[c]);
  }

  return {
    count,
    bases,
    basisX,
    basisY,
    basisZ,
    cellKeys,
    cellIJ,
    cellLngLat,
    memberOffsets,
    memberWeights,
    memberStarts,
    memberEnds,
    origin: origin ?? [0, 0, 0],
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
    radiusMerc,
    latitude,
    entryCount: total,
    droppedEntries: dropped,
    skippedLayers: skipped,
    weightProperty,
  };
}

// ── The play-head half: aggregation ─────────────────────────────────────────

/** Per-cell value of one aggregation over its gated members. */
export function hexbinCellValue(
  sum: number,
  count: number,
  min: number,
  max: number,
  op: HexbinAggregation,
): number {
  switch (op) {
    case 'COUNT':
      return count;
    case 'MEAN':
      return sum / Math.max(count, 1e-6);
    case 'MIN':
      return min;
    case 'MAX':
      return max;
    default:
      return sum;
  }
}

export interface HexbinAggregateParams {
  /** Play head, RELATIVE to the layer `timeOrigin`. */
  relativeCurrentTime: number;
  /** Gate members by the window filter. `false` aggregates everything. @default true */
  timeFiltered?: boolean;
  /** Window half-width + fade ramps (from `resolveTimeWindow`). */
  params?: TimeFilterParams;
  /** Aggregation driving the COLOUR channel. @default 'SUM' */
  colorAggregation?: HexbinAggregation;
  /** Aggregation driving the ELEVATION channel. @default 'SUM' */
  elevationAggregation?: HexbinAggregation;
  /** Low→high RGBA ramp (0–255). @default {@link DEFAULT_HEXBIN_COLOR_RANGE} */
  colorRange?: RGBA[];
  /** Pinned colour domain; `null` auto-ranges over the occupied cells. */
  colorDomain?: [number, number] | null;
  /** Pinned elevation input domain; `null` auto-ranges. */
  elevationDomain?: [number, number] | null;
  /** Elevation output range in METRES. @default [0, 1000] */
  elevationRange?: [number, number];
  /** Colour scale. @default 'quantize' */
  colorScaleType?: HexbinScaleType;
  /** Hide cells below this colour percentile (0–100). @default 0 */
  lowerPercentile?: number;
  /** Hide cells above this colour percentile (0–100). @default 100 */
  upperPercentile?: number;
  /** Extrude by the elevation aggregate. `false` pins every height to 0. @default true */
  extruded?: boolean;
  /** Layer id used in the one-shot warnings. @default 'STTHexbinLayer' */
  layerId?: string;
}

export interface HexbinAggregate {
  /** Cell count — always `buffers.count`, including the empty cells. */
  count: number;
  /** vec4 cell colour 0..1 (the ramp sample; `[0,0,0,0]` for an empty cell). */
  colors: Float32Array;
  /** Cell height in METRES, before the layer's `elevationScale` uniform. */
  heights: Float32Array;
  /** Hard `0 | 1` draw gate: occupied AND inside the percentile band. */
  visible: Float32Array;
  /** Earliest contributing member start per cell, rebased (0 when empty). */
  starts: Float32Array;
  /** Latest contributing member end per cell, rebased (0 when empty). */
  ends: Float32Array;
  /** The COLOUR aggregate per cell. */
  values: Float64Array;
  /** The ELEVATION aggregate per cell. */
  elevationValues: Float64Array;
  /** `Σ gate` per cell — fractional under a fading window. */
  gateSums: Float64Array;
  /** How many source features actually contributed to each cell THIS frame. */
  contributors: Uint32Array;
  /** Cells that survived the occupancy + percentile gate. */
  occupiedCells: number;
  /** The colour domain actually used (pinned or auto-ranged). */
  colorDomain: [number, number];
  /** The elevation domain actually used. */
  elevationDomain: [number, number];
}

function clampPercentile(v: number | undefined, fallback: number): number {
  if (v == null || !Number.isFinite(v)) return fallback;
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

/**
 * `[min, max]` of the occupied cells' values inside the
 * `[lowerPercentile, upperPercentile]` band — deck's percentile clipping. EMPTY
 * cells never participate: an empty cell is absence, not a zero sample, and
 * folding it in would drag every auto domain to 0. `null` when nothing is
 * occupied, which the caller reads as "hold the previous domain" rather than
 * collapsing the ramp onto `[0, 0]`.
 */
export function hexbinValueDomain(
  values: ArrayLike<number>,
  contributors: ArrayLike<number>,
  count: number,
  lowerPercentile = 0,
  upperPercentile = 100,
): [number, number] | null {
  const occupied: number[] = [];
  for (let c = 0; c < count; c++) {
    if (contributors[c] > 0) occupied.push(values[c]);
  }
  if (occupied.length === 0) return null;
  occupied.sort((a, b) => a - b);
  const last = occupied.length - 1;
  const lo = clampPercentile(lowerPercentile, 0) / 100;
  const hi = clampPercentile(upperPercentile, 100) / 100;
  const loIdx = Math.min(last, Math.max(0, Math.round(lo * last)));
  const hiIdx = Math.min(last, Math.max(loIdx, Math.round(hi * last)));
  return [occupied[loIdx], occupied[hiIdx]];
}

/**
 * Reduce the CSR membership table into the per-cell attributes the GPU draws.
 *
 * This is the half that RE-RUNS as the play head moves, and it genuinely
 * re-aggregates: a member's contribution is `weight × gate` where `gate` is the
 * shared {@link windowAlpha} evaluated at `relativeCurrentTime`, so a cell
 * appears, re-colours, rises and disappears as its own members enter and leave
 * the window. It is not a cross-fade between two static aggregates and it is not
 * a static aggregate with a global opacity.
 *
 * `count` (the MEAN/COUNT denominator) is `Σ gate`, so a half-faded member
 * counts a half — the same arithmetic the maplibre scatter pass accumulates,
 * which keeps the two backends' cell values comparable.
 */
export function aggregateHexbins(
  buf: HexbinBuffers,
  params: HexbinAggregateParams,
): HexbinAggregate {
  const n = buf.count;
  const colors = new Float32Array(n * 4);
  const heights = new Float32Array(n);
  const visible = new Float32Array(n);
  const starts = new Float32Array(n);
  const ends = new Float32Array(n);
  const values = new Float64Array(n);
  const elevationValues = new Float64Array(n);
  const gateSums = new Float64Array(n);
  const contributors = new Uint32Array(n);

  const layerId = params.layerId ?? 'STTHexbinLayer';
  const colorAgg = params.colorAggregation ?? 'SUM';
  const elevAgg = params.elevationAggregation ?? 'SUM';
  const range = params.colorRange ?? DEFAULT_HEXBIN_COLOR_RANGE;
  const elevRange = params.elevationRange ?? DEFAULT_HEXBIN_ELEVATION_RANGE;
  const extruded = params.extruded ?? true;
  const timeFiltered = params.timeFiltered ?? true;
  const tp = params.params ?? {};
  const windowHalf = tp.windowHalf ?? 0;
  const fadeIn = tp.fadeIn ?? 0;
  const fadeOut = tp.fadeOut ?? 0;
  const cur = params.relativeCurrentTime;

  let scale = params.colorScaleType ?? 'quantize';
  if (scale === 'quantile' || scale === 'ordinal') {
    warnOnce(
      `${layerId}:colorScaleType:${scale}`,
      `[${layerId}] colorScaleType '${scale}' needs a rank of the LIVE ` +
        "aggregate that this backend does not compute; using 'quantize' " +
        "(deck's default). Pin `colorDomain` if you need a specific banding.",
    );
    scale = 'quantize';
  }

  for (let c = 0; c < n; c++) {
    let sum = 0;
    let gate = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let sLo = Infinity;
    let eHi = -Infinity;
    let contrib = 0;
    const from = buf.memberOffsets[c];
    const to = buf.memberOffsets[c + 1];
    for (let m = from; m < to; m++) {
      const s = buf.memberStarts[m];
      const e = buf.memberEnds[m];
      const g = timeFiltered
        ? windowAlpha(cur, s, e, windowHalf, fadeIn, fadeOut)
        : 1;
      if (g <= 0) continue;
      const w = buf.memberWeights[m];
      sum += w * g;
      gate += g;
      contrib++;
      if (w < lo) lo = w;
      if (w > hi) hi = w;
      if (s < sLo) sLo = s;
      if (e > eHi) eHi = e;
    }
    gateSums[c] = gate;
    contributors[c] = contrib;
    starts[c] = contrib > 0 ? sLo : 0;
    ends[c] = contrib > 0 ? eHi : 0;
    if (contrib === 0) {
      lo = 0;
      hi = 0;
    }
    values[c] = hexbinCellValue(sum, gate, lo, hi, colorAgg);
    elevationValues[c] = hexbinCellValue(sum, gate, lo, hi, elevAgg);
  }

  const band = hexbinValueDomain(
    values,
    contributors,
    n,
    params.lowerPercentile,
    params.upperPercentile,
  );
  const colorDomain: [number, number] = params.colorDomain ?? band ?? [0, 1];
  const elevBand = params.elevationDomain ??
    hexbinValueDomain(elevationValues, contributors, n) ?? [0, 1];
  const elevationDomain: [number, number] = elevBand;
  const clipLo = band ? band[0] : -Infinity;
  const clipHi = band ? band[1] : Infinity;
  const eSpan = elevationDomain[1] - elevationDomain[0];

  let occupied = 0;
  for (let c = 0; c < n; c++) {
    const on =
      contributors[c] > 0 && values[c] >= clipLo && values[c] <= clipHi ? 1 : 0;
    visible[c] = on;
    if (!on) continue;
    occupied++;
    const rgba =
      scale === 'linear'
        ? rampColorAt(values[c], colorDomain, range)
        : rampBucketColor(values[c], colorDomain, range);
    colors[c * 4] = rgba[0] / 255;
    colors[c * 4 + 1] = rgba[1] / 255;
    colors[c * 4 + 2] = rgba[2] / 255;
    colors[c * 4 + 3] = (rgba[3] ?? 255) / 255;
    if (extruded) {
      const t =
        eSpan > 0
          ? Math.max(
              0,
              Math.min(1, (elevationValues[c] - elevationDomain[0]) / eSpan),
            )
          : 0;
      heights[c] = elevRange[0] + (elevRange[1] - elevRange[0]) * t;
    }
  }

  return {
    count: n,
    colors,
    heights,
    visible,
    starts,
    ends,
    values,
    elevationValues,
    gateSums,
    contributors,
    occupiedCells: occupied,
    colorDomain,
    elevationDomain,
  };
}

/**
 * The window BUCKET a play head falls in — the third component of the
 * aggregation cache key (see {@link STTHexbinLayer}'s header).
 *
 * A hexbin cannot re-aggregate every frame (the reduction is O(members)), and it
 * must not re-aggregate never (that is a static aggregate wearing an animation).
 * Quantising the play head to a fixed step is the compromise: the aggregate is a
 * pure function of the bucket, so scrubbing back into a bucket reproduces the
 * identical cells, and an unmoved play head is a cache HIT by construction.
 * `step <= 0` pins everything to bucket 0 (one aggregate for the tile set).
 */
export function hexbinWindowBucket(
  relativeCurrentTime: number,
  step: number,
): number {
  if (!(step > 0) || !Number.isFinite(relativeCurrentTime)) return 0;
  return Math.floor(relativeCurrentTime / step);
}

/**
 * The time a bucket's aggregate is evaluated at — the bucket CENTRE, which is
 * what makes the aggregate a pure function of the bucket rather than of
 * whichever frame happened to cross the boundary. With re-aggregation disabled
 * (`step <= 0`) there is no bucket to centre on and the live play head is used,
 * so the single aggregate reflects the moment the tiles arrived.
 */
export function hexbinBucketTime(
  bucket: number,
  step: number,
  liveRelativeTime: number,
): number {
  return step > 0 ? (bucket + 0.5) * step : liveRelativeTime;
}
