// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) RUNTIME hexbin aggregation — the CPU builder behind
 * `STTHexbinLayer.setTiles` / `.setTime`.
 *
 * ## What this is, and what it is NOT
 *
 * This bins the **raw point tier at runtime**. It is emphatically NOT a
 * referral to `lib/summary-cells.ts`: that module DECODES a summary tier the
 * archive already baked (one row per H3 cell, the aggregate computed by
 * `stt-build`). This module takes an ordinary point/track archive that has no
 * summary tier at all and computes the aggregate in the browser, from whatever
 * features are resident right now, over whatever slice of time the playhead is
 * looking at. The two answer different questions and neither replaces the
 * other:
 *
 *   - `summary-cells` — "what did the whole archive look like, per H3 cell?"
 *     Cheap, planet-scale, fixed at build time, and BLIND to the playback
 *     window (it colours by a baked column).
 *   - `hexbin` (this) — "what do the features I can see RIGHT NOW, in the
 *     window I am playing, look like when piled into hexes?" Costs a pass over
 *     every resident point on every re-aggregation, but the aggregate is LIVE.
 *
 * ## The lattice
 *
 * A fixed-radius, pointy-top hex lattice (redblobgames axial coordinates), laid
 * out in a local equirectangular METRE plane and rounded with the standard
 * cube-rounding tie-break. `radiusMeters` (deck spells the same thing
 * `cellSize`) is the hex CIRCUMRADIUS — centre to corner — so the flat-to-flat
 * width is `sqrt(3) × radiusMeters` and the row pitch is `1.5 × radiusMeters`.
 *
 * The metre plane is anchored at `(lon 0, lat 0)` with a single
 * `latitudeReference` supplying the longitude convergence factor
 * (`cos(latRef)`). The lattice is therefore GLOBAL and stable — the same point
 * always lands in the same bin, across rebuilds and across window moves — at
 * the price of hexes stretching in ground-longitude as you leave `latRef`. The
 * layer pins `latitudeReference` on the first build (mean latitude of the data,
 * rounded to a whole degree) and carries it forever, exactly as the H3 layer
 * carries its colour domain; a caller who spans many latitudes should pin it
 * explicitly. **Documented deviation from deck:** deck's `HexagonLayer` bins in
 * Web-Mercator space via `viewport.getDistanceScales()`, so its bins are
 * screen-uniform and re-project as you pan; ours are ground-uniform near
 * `latRef` and never move. Ours is the right trade for a globe, where a
 * mercator lattice at 70°N would be a third of its nominal ground size.
 *
 * ## The geometry-kind guard (the reason this file exists at all)
 *
 * A hexbin over a POINT tile bins one entry per FEATURE. A hexbin over a
 * LINESTRING tile bins one entry per **VERTEX**. That distinction is the whole
 * point: on a trip archive, binning per feature would pile every track into the
 * single hex containing its first coordinate, and the resulting map would show
 * "where trips begin", brightly and wrongly labelled "track density". Binning
 * per vertex gives the density of the paths themselves. The owning feature's
 * weight, start and end ride every one of its vertices — so a weighted hexbin
 * over tracks weights by `weight × vertexCount`, which is honest for `'sum'`
 * (a long track really does occupy more of the map) and is why `'mean'` exists
 * for callers who want the per-vertex average instead.
 *
 * POLYGON tiles are SKIPPED, with one named warning from the layer. A polygon's
 * contribution to a density surface is its AREA, which needs a rasteriser, not
 * a point binner; binning its ring vertices would weight a polygon by how
 * finely it happens to be tessellated. Refusing loudly beats shipping that.
 *
 * ## Weight
 *
 * ONE baked property-column NAME drives BOTH the colour ramp and the extrusion
 * height, resolved `colorWeight` → `elevationWeight` → `weightProperty`
 * (legacy). Unset means every entry weighs 1 and the result is a COUNT hexbin.
 * **Documented deviation from deck:** deck takes `getColorWeight` /
 * `getElevationWeight` accessors and can drive colour and height from DIFFERENT
 * columns with DIFFERENT aggregations. This backend reads baked columns, not
 * accessors, and deliberately exposes a single weight: two independent
 * aggregations would double the per-re-aggregation pass over every resident
 * point for a styling nicety, and the CPU pass is this layer's entire cost
 * model. Callers who need two surfaces run two layers.
 *
 * ## Time
 *
 * The aggregate genuinely RE-AGGREGATES: {@link hexbinWindowFor} turns the
 * playhead plus the time-filter mode into an absolute-ms membership window, and
 * only entries whose `[start, end]` intersects it are binned. This is not a
 * cross-fade over one static set of bins — a hex that holds 400 points at noon
 * and 3 at midnight really reports 3 at midnight, and its colour and height
 * move with it. What the per-frame `timeFilterAlpha` pass then adds on top is
 * only the soft EDGE of the window (fade-in/fade-out, wake and trail decay).
 *
 * Re-binning every frame would be absurd, so the layer quantises the playhead
 * into buckets ({@link aggregationBucket}) and memoises on
 * {@link hexbinCacheKey} — see that function for the exact key.
 *
 * ## Purity
 *
 * ZERO `cesium` imports, by the same rule as `lib/points.ts` and
 * `lib/polylines.ts`; every ring is handed to the layer as absolute f64 ECEF
 * metres, projected through `lib/summary-cells.ts`'s `ringToEcef` (which owns
 * the package's `GlobeProjection({ datum: 'wgs84' })` — the WGS84 datum is
 * mandatory: the class default `'sphere'` mis-registers against Cesium's real
 * ellipsoid by up to ~20 km at mid-latitudes). No new projection code lives
 * here.
 */

import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import { rampColorAt, type RGBA255 } from '@poopdeck.gl/core/style';
import type {
  TimeFilterMode,
  TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { ringToEcef } from './summary-cells.js';

// ── constants ───────────────────────────────────────────────────────────────

/** IUGG mean Earth radius (m) — the plane is a local tangent approximation, not a datum. */
const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const SQRT3 = Math.sqrt(3);

/** ColorBrewer YlOrRd — the warm density ramp deck's `HexagonLayer` defaults to. */
export const DEFAULT_HEXBIN_RAMP: readonly RGBA255[] = [
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [240, 59, 32, 255],
  [189, 0, 38, 255],
];

const DEFAULT_RADIUS_M = 1000;
const DEFAULT_COVERAGE = 1;
const DEFAULT_ELEVATION_SCALE = 1;

// ── the lattice ─────────────────────────────────────────────────────────────

/** A pointy-top hex lattice pinned to one longitude-convergence latitude. */
export interface HexLattice {
  /** Hex circumradius (centre → corner) in metres. */
  radiusMeters: number;
  /** Latitude (deg) whose `cos` sets the metres-per-degree-longitude factor. */
  latitudeReference: number;
  /** Metres per degree of longitude at {@link latitudeReference}. */
  mPerDegLon: number;
  /** Metres per degree of latitude (constant on the sphere). */
  mPerDegLat: number;
}

/**
 * Build a lattice. `latitudeReference` is clamped away from the poles: at ±90°
 * `cos` is 0, the plane collapses, and every point on Earth falls in one bin.
 */
export function makeHexLattice(
  radiusMeters: number,
  latitudeReference: number,
): HexLattice {
  const r =
    Number.isFinite(radiusMeters) && radiusMeters > 0
      ? radiusMeters
      : DEFAULT_RADIUS_M;
  const latRef = Number.isFinite(latitudeReference)
    ? Math.max(-85, Math.min(85, latitudeReference))
    : 0;
  const mPerDegLat = EARTH_RADIUS_M * DEG;
  return {
    radiusMeters: r,
    latitudeReference: latRef,
    mPerDegLon: mPerDegLat * Math.cos(latRef * DEG),
    mPerDegLat,
  };
}

/** lon/lat (deg) → local equirectangular metres, anchored at (0, 0). */
export function lonLatToPlane(
  lattice: HexLattice,
  lon: number,
  lat: number,
): [number, number] {
  return [lon * lattice.mPerDegLon, lat * lattice.mPerDegLat];
}

/** Local equirectangular metres → lon/lat (deg). Inverse of {@link lonLatToPlane}. */
export function planeToLonLat(
  lattice: HexLattice,
  x: number,
  y: number,
): [number, number] {
  return [x / lattice.mPerDegLon, y / lattice.mPerDegLat];
}

/**
 * Cube-round a fractional axial coordinate to the nearest hex centre. The
 * tie-break (discard the axis that moved furthest, re-derive it from the other
 * two) is what keeps `q + r + s === 0` exact — plain per-axis rounding would
 * drop points into a lattice of triangles and squares near the cell corners.
 */
export function axialRound(qf: number, rf: number): [number, number] {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q, r];
}

/** Plane metres → the axial coordinate of the containing pointy-top hex. */
export function axialFromPlane(
  lattice: HexLattice,
  x: number,
  y: number,
): [number, number] {
  const R = lattice.radiusMeters;
  return axialRound(
    (SQRT3 / 3) * (x / R) - (1 / 3) * (y / R),
    (2 / 3) * (y / R),
  );
}

/** Axial coordinate → the hex CENTRE, in plane metres. */
export function planeFromAxial(
  lattice: HexLattice,
  q: number,
  r: number,
): [number, number] {
  const R = lattice.radiusMeters;
  return [R * SQRT3 * (q + r / 2), R * 1.5 * r];
}

/**
 * The six corners of hex `(q, r)` as a flat `[lon, lat, …]` ring in degrees,
 * counter-clockwise from the east-south-east corner. Already "unwrapped" in the
 * sense `summary-cells.unwrapRing` means it: a hex is metres across, so its
 * corners never straddle the antimeridian relative to each other, though the
 * ring's longitudes may run past ±180 near the seam — which is exactly what
 * `ringToEcef` wants.
 */
export function hexRingLonLat(
  lattice: HexLattice,
  q: number,
  r: number,
): Float64Array {
  const [cx, cy] = planeFromAxial(lattice, q, r);
  const R = lattice.radiusMeters;
  const out = new Float64Array(12);
  for (let i = 0; i < 6; i++) {
    const a = (60 * i - 30) * DEG;
    const [lon, lat] = planeToLonLat(
      lattice,
      cx + R * Math.cos(a),
      cy + R * Math.sin(a),
    );
    out[i * 2] = lon;
    out[i * 2 + 1] = lat;
  }
  return out;
}

// ── time ────────────────────────────────────────────────────────────────────

/** An absolute-ms membership window. Either bound may be infinite. */
export interface HexbinWindow {
  start: number;
  end: number;
}

/**
 * The slice of absolute time a hexbin should aggregate over, for a playhead at
 * `centreMs` under `mode`. Mirrors what `timeFilterAlpha` considers non-zero,
 * so the bins hold exactly the features the alpha pass can light up:
 *
 *   - `window`     → `[centre − half, centre + half]` (`windowHalf`, else
 *                    `fallbackSpanMs / 2`), widened by `fadeIn` / `fadeOut`
 *                    because a fading feature is still visible.
 *   - `wake`       → `[centre − wakeLength, centre]`
 *   - `trail`      → `[centre − trailLength, centre]`
 *   - `cumulative` → `(−∞, centre]`
 *   - `none`       → everything.
 */
export function hexbinWindowFor(
  mode: TimeFilterMode,
  centreMs: number,
  params: TimeFilterParams = {},
  fallbackSpanMs = 0,
): HexbinWindow {
  switch (mode) {
    case 'window': {
      const half = params.windowHalf ?? fallbackSpanMs / 2;
      if (!Number.isFinite(half) || half <= 0) {
        return { start: -Infinity, end: Infinity };
      }
      return {
        start: centreMs - half - (params.fadeIn ?? 0),
        end: centreMs + half + (params.fadeOut ?? 0),
      };
    }
    case 'wake': {
      const len = params.wakeLength ?? fallbackSpanMs;
      if (!Number.isFinite(len) || len <= 0)
        return { start: -Infinity, end: centreMs };
      return { start: centreMs - len, end: centreMs };
    }
    case 'trail': {
      const len = params.trailLength ?? fallbackSpanMs;
      if (!Number.isFinite(len) || len <= 0)
        return { start: -Infinity, end: centreMs };
      return { start: centreMs - len, end: centreMs };
    }
    case 'cumulative':
      return { start: -Infinity, end: centreMs };
    default:
      return { start: -Infinity, end: Infinity };
  }
}

/**
 * Quantise a playhead into an aggregation bucket. Re-aggregation happens when
 * — and only when — this integer changes, i.e. when the window centre crosses a
 * step boundary. A non-finite or non-positive step means "never re-aggregate":
 * bucket 0 forever.
 */
export function aggregationBucket(absoluteMs: number, stepMs: number): number {
  if (!Number.isFinite(stepMs) || stepMs <= 0) return 0;
  if (!Number.isFinite(absoluteMs)) return 0;
  return Math.floor(absoluteMs / stepMs);
}

/**
 * The memo key an aggregate is cached under. Three independent parts, and all
 * three are load-bearing:
 *
 *   1. **the resident tile set** — `tileSetToken(tiles)`, the ids and feature
 *      counts of the tiles currently decoded. A pan or a zoom changes the
 *      population being binned, so it must invalidate.
 *   2. **the weight configuration** — `configToken(opts)`, the lattice radius,
 *      weight column, aggregation, coverage and elevation scale. These are the
 *      knobs that change what a bin MEANS.
 *   3. **the window bucket** — `aggregationBucket(centre, step)`, the quantised
 *      playhead. This is what makes the aggregate live without making it
 *      per-frame.
 *
 * Nothing that varies per FRAME is in the key — that is the entire point. Alpha
 * is not in the key (it is applied per frame on top of the cached bins), and
 * neither is the camera.
 */
export function hexbinCacheKey(
  tilesToken: string,
  configToken: string,
  bucket: number,
): string {
  return `${tilesToken}#${configToken}#${bucket}`;
}

/** Identity of the resident tile set: ids + feature counts, order-independent. */
export function tileSetToken(tiles: readonly Tile[]): string {
  const parts: string[] = [];
  for (const tile of tiles) {
    const { z, x, y, t } = tile.id;
    let n = 0;
    for (const layer of tile.layers) n += layer.features.featureCount;
    parts.push(`${z}/${x}/${y}/${t}:${n}`);
  }
  parts.sort();
  return parts.join(',');
}

/** Identity of everything that changes what a bin MEANS (never per-frame state). */
export function configToken(opts: HexbinBuildOptions = {}): string {
  return [
    resolveRadiusMeters(opts),
    resolveWeightProperty(opts) ?? '',
    opts.aggregation ?? 'sum',
    opts.coverage ?? DEFAULT_COVERAGE,
    opts.elevationScale ?? DEFAULT_ELEVATION_SCALE,
    opts.latitudeReference ?? '',
    opts.colorDomain ? `${opts.colorDomain[0]}..${opts.colorDomain[1]}` : '',
    // The ramp is baked INTO a cached build's bytes, so it belongs in the key:
    // swapping stops without invalidating would replay stale colours.
    (opts.colorRange ?? DEFAULT_HEXBIN_RAMP).map((c) => c.join(',')).join(';'),
  ].join('|');
}

// ── build ───────────────────────────────────────────────────────────────────

/** How members of a bin combine into its single reported value. */
export type HexbinAggregation = 'sum' | 'mean' | 'max' | 'min' | 'count';

/** One renderable hex: an ECEF ring, an aggregate, a colour and a window. */
export interface HexBin {
  /** Axial lattice coordinate — stable across rebuilds; the bin's true identity. */
  q: number;
  r: number;
  /** Ring vertices as absolute ECEF metres at height 0, `n × 3`, CCW. */
  positions: Float64Array;
  /** Bin centre lon/lat (deg) — the pick coordinate. */
  lon: number;
  lat: number;
  /** Members binned here (features for point tiles, VERTICES for line tiles). */
  count: number;
  /** The aggregate value: what drove both the ramp and the height. */
  weight: number;
  /** Extrusion height in metres (`weight × elevationScale`); 0 when flat. */
  height: number;
  /** Base colour, channels pre-normalized to 0..1 so `setTime` never re-divides. */
  r255: number;
  g255: number;
  b255: number;
  /** Base alpha 0..1, multiplied by the per-frame time-filter alpha. */
  a: number;
  /** Union of member windows, rebased to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Picking provenance: ONE representative member (see `HexbinBuild` notes). */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** What the build had to do to the data. Never hidden; the layer reports it. */
export interface HexbinDiagnostics {
  /** Polygon layers refused outright (see the file header). */
  skippedPolygonLayers: number;
  /** Point FEATURES offered to the binner. */
  pointEntries: number;
  /** LineString VERTICES offered to the binner. */
  vertexEntries: number;
  /** Entries dropped for a non-finite coordinate. */
  skippedNonFinite: number;
  /** Entries dropped because their window missed the aggregation window. */
  skippedOutOfWindow: number;
  /** True when a weight column was requested but no layer carried it. */
  weightPropertyMissing: boolean;
}

/** A built hexbin set, rebased to one scene-wide time origin. */
export interface HexbinBuild {
  bins: HexBin[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
  /** The ramp domain actually used — carry it back in as `domainSeed`. */
  domain: [number, number];
  /** The lattice that produced these bins; pin it to keep the lattice stable. */
  lattice: HexLattice;
  diagnostics: HexbinDiagnostics;
}

export interface HexbinBuildOptions {
  /** Hex circumradius in metres. @default 1000 */
  radiusMeters?: number;
  /** deck's spelling of {@link radiusMeters}; `radiusMeters` wins if both are set. */
  cellSize?: number;
  /** Numeric column driving BOTH colour and elevation. Unset → a COUNT hexbin. */
  colorWeight?: string;
  /** Fallback name for the same single column (see the header's deviation note). */
  elevationWeight?: string;
  /** Legacy name for the same single column, matched last. */
  weightProperty?: string;
  /** How members combine. @default 'sum' (which, unweighted, IS the count) */
  aggregation?: HexbinAggregation;
  /** Low→high ramp stops, each `[r,g,b,a]` 0–255. @default 6-stop YlOrRd */
  colorRange?: readonly RGBA255[];
  /** `[min, max]` the ramp spans. PIN THIS for a stable legend. */
  colorDomain?: readonly [number, number];
  /** Running auto-fit domain to widen (never narrow). */
  domainSeed?: readonly [number, number];
  /** Hex shrink toward its centre, 0–1. @default 1 (hexes tile with no gutter) */
  coverage?: number;
  /** METRES of height per unit of aggregate. @default 1 */
  elevationScale?: number;
  /** Pin the lattice's longitude-convergence latitude (deg). */
  latitudeReference?: number;
  /** Absolute-ms membership window; omit to bin everything. */
  window?: HexbinWindow | null;
}

/** `colorWeight` → `elevationWeight` → `weightProperty`; `null` means COUNT. */
export function resolveWeightProperty(
  opts: HexbinBuildOptions = {},
): string | null {
  return (
    opts.colorWeight ?? opts.elevationWeight ?? opts.weightProperty ?? null
  );
}

/** `radiusMeters` wins over deck's `cellSize` spelling; both unset → 1000 m. */
export function resolveRadiusMeters(opts: HexbinBuildOptions = {}): number {
  const r = opts.radiusMeters ?? opts.cellSize ?? DEFAULT_RADIUS_M;
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_RADIUS_M;
}

/** Point and LineString layers worth binning, plus the polygon layers refused. */
export function collectHexbinLayers(tiles: readonly Tile[]): {
  layers: BinaryFeatures[];
  skippedPolygonLayers: number;
} {
  const layers: BinaryFeatures[] = [];
  let skippedPolygonLayers = 0;
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      const f = layer.features;
      if (f.featureCount === 0) continue;
      if (f.geometryType === GeometryType.Polygon) {
        // Refused, not approximated — a polygon's density contribution is its
        // AREA, and binning its ring vertices would weight it by tessellation
        // detail. The layer surfaces this once, by name.
        skippedPolygonLayers++;
        continue;
      }
      if (
        f.geometryType === GeometryType.Point ||
        (f.geometryType === GeometryType.LineString && f.startIndices)
      ) {
        layers.push(f);
      }
    }
  }
  return { layers, skippedPolygonLayers };
}

/** Mutable accumulator for one hex while the single binning pass runs. */
interface Accumulator {
  q: number;
  r: number;
  count: number;
  sum: number;
  max: number;
  min: number;
  start: number;
  end: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

function aggregateOf(acc: Accumulator, how: HexbinAggregation): number {
  switch (how) {
    case 'count':
      return acc.count;
    case 'mean':
      return acc.count > 0 ? acc.sum / acc.count : 0;
    case 'max':
      return acc.max;
    case 'min':
      return acc.min;
    default:
      return acc.sum;
  }
}

/**
 * Bin every resident raw point (or track VERTEX) into a fixed-radius hex
 * lattice and colour the result by the aggregate.
 *
 * One pass, `O(entries)`: each entry is projected to the metre plane, rounded to
 * an axial coordinate, and folded into that hex's accumulator. A second, tiny
 * pass over the hexes (never the points) fits the ramp domain and builds the
 * rings — so a pinned domain and an auto-fit domain share one code path, exactly
 * as `buildSummaryCells` does.
 *
 * Returns an empty build (`bins: []`, `timeOrigin: 0`) when there is nothing to
 * draw — the layer checks `bins.length` BEFORE adopting `timeOrigin`, so an
 * empty rebuild leaves the previous origin untouched.
 */
export function buildHexbins(
  tiles: readonly Tile[],
  opts: HexbinBuildOptions = {},
): HexbinBuild {
  const { layers, skippedPolygonLayers } = collectHexbinLayers(tiles);
  const diagnostics: HexbinDiagnostics = {
    skippedPolygonLayers,
    pointEntries: 0,
    vertexEntries: 0,
    skippedNonFinite: 0,
    skippedOutOfWindow: 0,
    weightPropertyMissing: false,
  };
  const radiusMeters = resolveRadiusMeters(opts);
  const emptyLattice = makeHexLattice(
    radiusMeters,
    opts.latitudeReference ?? 0,
  );
  if (layers.length === 0) {
    return {
      bins: [],
      timeOrigin: 0,
      domain: seedDomain(opts.domainSeed),
      lattice: emptyLattice,
      diagnostics,
    };
  }

  const timeOrigin = layers[0].timeOffset;
  const weightProp = resolveWeightProperty(opts);
  // Unweighted, 'sum' IS the count — every entry weighs 1 — so one default
  // serves both cases and `'count'` stays available as an explicit override
  // that ignores a weight column on purpose.
  const how: HexbinAggregation = opts.aggregation ?? 'sum';
  const win = opts.window ?? null;

  // Pin the lattice BEFORE binning: it must not depend on which subset of the
  // data survived the window filter, or the bins would migrate as time moves.
  const lattice = makeHexLattice(
    radiusMeters,
    opts.latitudeReference ?? meanLatitude(layers),
  );

  let sawWeightColumn = false;
  const acc = new Map<string, Accumulator>();

  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const weights = weightProp ? b.numericProps[weightProp] : undefined;
    if (weightProp && weights) sawWeightColumn = true;
    const isLine = b.geometryType === GeometryType.LineString;
    const si = isLine ? b.startIndices : undefined;
    const vertexCount = b.positions.length / dims;

    for (let f = 0; f < b.featureCount; f++) {
      // Times and weight are PER FEATURE in this format — for a track they ride
      // every one of its vertices (see the header's geometry-kind guard).
      const absStart = b.startTimes[f] + b.timeOffset;
      const absEnd = b.endTimes[f] + b.timeOffset;
      const w = weights ? weights[f] : 1;

      const lo = isLine && si ? si[f] : f;
      const hi =
        isLine && si
          ? f + 1 < b.featureCount
            ? si[f + 1]
            : vertexCount
          : f + 1;
      if (isLine) diagnostics.vertexEntries += Math.max(0, hi - lo);
      else diagnostics.pointEntries += 1;

      if (win && !(absStart <= win.end && absEnd >= win.start)) {
        diagnostics.skippedOutOfWindow += Math.max(0, hi - lo);
        continue;
      }

      for (let v = lo; v < hi; v++) {
        const lon = b.positions[v * dims];
        const lat = b.positions[v * dims + 1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          diagnostics.skippedNonFinite++;
          continue;
        }
        const [px, py] = lonLatToPlane(lattice, lon, lat);
        const [q, r] = axialFromPlane(lattice, px, py);
        const key = `${q}:${r}`;
        let a = acc.get(key);
        if (!a) {
          a = {
            q,
            r,
            count: 0,
            sum: 0,
            max: -Infinity,
            min: Infinity,
            start: Infinity,
            end: -Infinity,
            binary: b,
            featureIndex: f,
          };
          acc.set(key, a);
        }
        a.count++;
        a.sum += w;
        if (w > a.max) a.max = w;
        if (w < a.min) a.min = w;
        if (absStart < a.start) a.start = absStart;
        if (absEnd > a.end) a.end = absEnd;
      }
    }
  }

  diagnostics.weightPropertyMissing = weightProp !== null && !sawWeightColumn;

  if (acc.size === 0) {
    return {
      bins: [],
      timeOrigin: 0,
      domain: seedDomain(opts.domainSeed),
      lattice,
      diagnostics,
    };
  }

  // Pass 1 over the HEXES (not the points): fit the domain, widening the seed.
  const domain = seedDomain(opts.domainSeed);
  for (const a of acc.values()) {
    const value = aggregateOf(a, how);
    if (value < domain[0]) domain[0] = value;
    if (value > domain[1]) domain[1] = value;
  }
  // A degenerate or unseeded fit would make `rampColorAt` divide by zero; fall
  // back to a unit span so every hex paints the ramp's LOW stop rather than NaN.
  const rampDomain: readonly [number, number] =
    opts.colorDomain ?? degenerateSafeDomain(domain);

  const range = opts.colorRange ?? DEFAULT_HEXBIN_RAMP;
  const coverage = opts.coverage ?? DEFAULT_COVERAGE;
  const elevationScale = opts.elevationScale ?? DEFAULT_ELEVATION_SCALE;

  // Pass 2: geometry + colour. Sorted by axial coordinate so a rebuild with an
  // unchanged population produces a byte-identical bin ORDER — Map iteration is
  // insertion-ordered, and insertion order follows whichever tile decoded first.
  const bins: HexBin[] = [];
  const sorted = [...acc.values()].sort((x, y) => x.q - y.q || x.r - y.r);
  for (const a of sorted) {
    const value = aggregateOf(a, how);
    const [cx, cy] = planeFromAxial(lattice, a.q, a.r);
    const [lon, lat] = planeToLonLat(lattice, cx, cy);
    const ring = hexRingLonLat(lattice, a.q, a.r);
    // Reuse the package's ring→ECEF helper (which owns the wgs84 GlobeProjection)
    // rather than writing new projection code. Height stays 0: an extruded hex
    // rides Cesium's own height/extrudedHeight so its walls follow the ellipsoid
    // normal instead of a chord.
    const positions = ringToEcef(ring, lon, lat, coverage, 0);
    const [cr, cg, cb, ca] = rampColorAt(value, rampDomain, range);
    bins.push({
      q: a.q,
      r: a.r,
      positions,
      lon: normalizeLon(lon),
      lat,
      count: a.count,
      weight: value,
      height: value * elevationScale,
      r255: toByte(cr),
      g255: toByte(cg),
      b255: toByte(cb),
      a: ca / 255,
      start: a.start - timeOrigin,
      end: a.end - timeOrigin,
      binary: a.binary,
      featureIndex: a.featureIndex,
    });
  }

  return { bins, timeOrigin, domain, lattice, diagnostics };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * A ramp domain `rampColorAt` can actually divide by. A single-valued set
 * (every hex holding the same aggregate — one bin, or a perfectly uniform
 * field) fits to `[v, v]`, which would divide by zero; widening it UPWARD makes
 * every hex paint the ramp's LOW stop, which is the honest reading of "no
 * variation to show". An unseeded, non-finite fit falls back to `[0, 1]`.
 */
function degenerateSafeDomain(
  fit: readonly [number, number],
): [number, number] {
  const [lo, hi] = fit;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** Clamp a ramp channel to a u8 — the batch table takes bytes, not floats. */
function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function seedDomain(seed?: readonly [number, number]): [number, number] {
  return seed ? [seed[0], seed[1]] : [Infinity, -Infinity];
}

/** Fold an unwrapped longitude back into [-180, 180) for the pick coordinate. */
function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Mean latitude of the first coordinate of every feature across `layers` —
 * the default longitude-convergence latitude, rounded to a whole degree so a
 * one-tile pan does not shift the lattice. Rounding is what makes this usable
 * as a DEFAULT; the layer still pins the first value it computes.
 */
export function meanLatitude(layers: readonly BinaryFeatures[]): number {
  let sum = 0;
  let n = 0;
  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const si =
      b.geometryType === GeometryType.LineString ? b.startIndices : undefined;
    for (let f = 0; f < b.featureCount; f++) {
      const v = si ? si[f] : f;
      const lat = b.positions[v * dims + 1];
      if (!Number.isFinite(lat)) continue;
      sum += lat;
      n++;
    }
  }
  return n === 0 ? 0 : Math.round(sum / n);
}
