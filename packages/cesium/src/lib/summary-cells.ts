// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of the SUMMARY TIER into drawable cell rings —
 * the CPU builder behind `STTH3SummaryLayer.setTiles`, and the shared kernel a
 * Quadbin sibling reuses unchanged.
 *
 * ## What a summary tile is
 *
 * A summary tile carries NO point/line geometry. `stt-build --summary-tier h3`
 * (`crates/stt-build/src/summary.rs`) aggregates the raw tier into one row per
 * spatial CELL and stores the cell's u64 id in the Arrow `id` column, which the
 * TS decoder copies into {@link BinaryFeatures.featureIds64}. The 32-bit
 * `featureIds` mirror TRUNCATES the high bits and must never be read here —
 * every H3 cell at resolution ≥ 7 needs the full 64. The aggregate values ride
 * the ordinary numeric columns (`count` is the implicit per-cell row count that
 * every summary tier bakes; `mean_*` / `sum_*` columns appear when asked for).
 *
 * So the geometry is RECONSTRUCTED client-side from the id, and this module is
 * where that happens:
 *
 *   cell id (u64) → boundary ring (lon/lat °) → ECEF ring (absolute f64 metres)
 *
 * ## Generic over the id → ring step, on purpose
 *
 * The only family-specific step is the first arrow. It is a parameter
 * ({@link CellBoundaryResolver}), not a branch, so the H3 and Quadbin backends
 * share one ring→ECEF→instance path:
 *
 *   - **H3** — the boundary is icosahedral geometry only `h3-js` can produce.
 *     We do NOT reimplement it. {@link h3BoundaryResolver} adapts an INJECTED
 *     `cellToBoundary` (see the layer's required `cellToBoundary` option). The
 *     u64 → 15-char index string step IS pure and lives here
 *     ({@link h3IndexFromU64}) — an H3 index string is simply the u64 in
 *     lowercase hex, which is exactly what h3-js's `splitLongToH3Index`
 *     produces from the two 32-bit halves.
 *   - **Quadbin** — a pure `(z, x, y)` bit layout with no external dependency;
 *     a resolver for it is a ~40-line function that plugs in right here.
 *
 * Injection rather than `import {cellToBoundary} from 'h3-js'` is deliberate
 * and matches `@poopdeck.gl/maplibre`: `h3-js` is NOT a dependency of this
 * package and must not become one. `@poopdeck.gl/cesium` has exactly one
 * runtime dependency (`@poopdeck.gl/core`) and `cesium` as a peer; a thin
 * backend stays thin.
 *
 * ## Why there is no antimeridian or pole handling here
 *
 * This is the load-bearing difference from `@poopdeck.gl/maplibre`'s
 * `lib/cell-geometry.ts`, which spends most of its length on the ±180° seam and
 * on pole-enclosing cells. Both problems are artefacts of the MERCATOR UNIT
 * SQUARE: a ring straddling the seam smears across the world, and a cell
 * containing a pole has no finite mercator y.
 *
 * ECEF has neither. It is a continuous 3-D frame with no cut and no
 * singularity — the north-pole cell `8001fffffffffff` projects to a perfectly
 * ordinary ring of Cartesian3 metres around the spin axis. So this module
 * carries NO `seamMode` and NO `poleMode`, and that is a correctness win, not
 * an omission. Longitudes are still unwrapped sequentially before the
 * {@link SummaryCellBuildOptions.coverage} shrink and before the centroid is
 * taken, because a centroid averaged over `[179.9, -179.9]` would otherwise
 * land on the far side of the planet — but the projected ring never depends on
 * the branch cut.
 *
 * ## Deliberate deviations
 *
 *   - `coverage` shrinks toward the cell centroid in **lon/lat**, like
 *     `@poopdeck.gl/three`, not in mercator like `@poopdeck.gl/maplibre`. On a
 *     globe there is no mercator to shrink in; lon/lat is the frame the ring
 *     arrives in and the one the ellipsoid consumes.
 *   - The colour ramp INTERPOLATES between stops (`core/style` `rampColorAt`),
 *     where deck's summary layers quantise into `colorRange.length` buckets.
 *     The two agree at the stops; this one is smoother between them. Identical
 *     choice to the maplibre backend, so a backend toggle does not change
 *     colour.
 *   - The auto-fit colour domain WIDENS MONOTONICALLY across rebuilds (seeded
 *     by the caller via {@link SummaryCellBuildOptions.domainSeed}). deck
 *     re-fits per render, which makes every remaining cell change colour when a
 *     hot tile scrolls off.
 *
 * Everything here is tile-upload-time work: no GL, no Cesium, no per-frame
 * cost, and unit-tested in plain Node.
 */

import { type BinaryFeatures, type Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { rampColorAt, type RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum
// matters; the class default 'sphere' mis-registers against Cesium's real
// ellipsoid by up to ~20 km at mid-latitudes). Byte-identical to the point and
// polyline builders' GLOBE; `project` is anchor-independent, so the shared
// module-level singleton is safe.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

// ── the family-specific step ────────────────────────────────────────────────

/**
 * `h3-js`'s `cellToBoundary`, structurally. Pass the real thing:
 *
 * ```ts
 * import { cellToBoundary } from 'h3-js';
 * new STTH3SummaryLayer(scene, { cellToBoundary });
 * ```
 *
 * With `formatAsGeoJson === true` h3-js returns `[lng, lat]` degree pairs and
 * CLOSES the ring (first vertex repeated at the end) — 6 entries for a
 * pentagon, 7 for a hexagon, up to 11 where a cell crosses an icosahedron edge
 * (`MAX_CELL_BNDRY_VERTS` is 10). {@link buildSummaryCells} drops a trailing
 * duplicate before doing anything, so it never depends on which convention a
 * caller's h3-js version uses.
 */
export type H3CellToBoundary = (
  h3Index: string,
  formatAsGeoJson?: boolean,
) => number[][];

/**
 * Turn a u64 cell id into its boundary ring as `[lng, lat]` degree pairs, or
 * `null` for an id this family cannot decode (the row is then skipped and
 * counted, never silently mis-drawn). The ring may be open or closed.
 */
export type CellBoundaryResolver = (
  cellId: bigint,
) => readonly (readonly number[])[] | null;

/**
 * The canonical 15-char H3 index string for a u64 cell id.
 *
 * An H3 index string IS the u64 in lowercase hex — h3-js's
 * `splitLongToH3Index(lower, upper)` just concatenates the hex of the two
 * 32-bit halves. Doing it with a `BigInt` here keeps the whole u64 intact
 * (`Number` would lose the low bits above 2^53) and keeps this module free of
 * `h3-js`, which is the point.
 */
export function h3IndexFromU64(cellId: bigint): string {
  return cellId.toString(16);
}

/**
 * Adapt an injected `h3-js` `cellToBoundary` into a {@link CellBoundaryResolver}.
 *
 * h3-js THROWS on a non-cell index (a row from a Quadbin archive, a corrupt
 * id); that throw is swallowed into `null` so one bad row skips one cell rather
 * than blanking the tile.
 */
export function h3BoundaryResolver(
  cellToBoundary: H3CellToBoundary,
): CellBoundaryResolver {
  return (cellId: bigint) => {
    try {
      // `true` → GeoJSON `[lng, lat]` order in degrees, the frame the
      // projection wants.
      const ring = cellToBoundary(h3IndexFromU64(cellId), true);
      return ring && ring.length >= 3 ? ring : null;
    } catch {
      return null;
    }
  };
}

// ── build shapes ────────────────────────────────────────────────────────────

/** One renderable summary cell: an absolute ECEF ring plus its animation state. */
export interface SummaryCell {
  /**
   * The cell's boundary as absolute f64 ECEF metres, flat `[x,y,z, x,y,z, …]`
   * at ellipsoid height 0 and OPEN (no repeated first vertex — Cesium's polygon
   * geometries close the ring themselves). NO RTC offset: `Cartesian3` consumes
   * CPU doubles natively, so there is no f32 buffer to protect.
   */
  positions: Float64Array;
  /** Base colour channels, pre-normalized to 0..1 so `setTime` never re-divides. */
  r: number;
  g: number;
  b: number;
  /** Base alpha (0..1), multiplied by the per-frame time-filter alpha. */
  a: number;
  /** Aggregate value that drove the ramp (and the extrusion). */
  weight: number;
  /**
   * Top of the extruded prism in METRES above the ellipsoid
   * (`weight × elevationScale`), or 0 when `extruded` is false. The layer hands
   * this to `PolygonGeometry`'s `extrudedHeight`, so the walls conform to the
   * ellipsoid instead of being hand-tessellated.
   */
  height: number;
  /** Window start/end, REBASED to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Cell centroid in degrees — the pick coordinate. */
  lon: number;
  lat: number;
  /** Provenance for picking and property lookup. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** What a build had to do to the data — surface these, never hide them. */
export interface SummaryCellDiagnostics {
  /** Rows whose id did not decode to a usable ring (wrong scheme, corrupt id). */
  skipped: number;
  /** True when a matched layer had no `featureIds64` column at all. */
  missingIds: boolean;
  /** True when the weight column was absent, so every cell fell back to 0. */
  missingWeight: boolean;
  /** True when no layer matched the requested name and a fallback was used. */
  layerNameMismatch: boolean;
}

export interface SummaryCellBuild {
  cells: SummaryCell[];
  /** Scene-wide time origin (the first summary layer's `timeOffset`). */
  timeOrigin: number;
  /** The colour domain actually used — feed it back as the next `domainSeed`. */
  domain: [number, number];
  diagnostics: SummaryCellDiagnostics;
}

export interface SummaryCellBuildOptions {
  /**
   * Numeric column driving BOTH the colour ramp and the extrusion height.
   * @default 'count' (the implicit per-cell row count every summary tier bakes)
   */
  weightProperty?: string;
  /** Low→high ramp stops, each `[r,g,b,a]` 0–255. @default 6-stop YlGnBu */
  colorRange?: readonly RGBA255[];
  /**
   * `[min, max]` the ramp spans. PIN THIS for a stable legend; left unset the
   * build fits from the cells it has, widened from {@link domainSeed}.
   * @default null (auto-fit)
   */
  colorDomain?: readonly [number, number] | null;
  /**
   * Previous auto-fit domain, so the fit WIDENS MONOTONICALLY across rebuilds
   * and an evicting tile never repaints the cells that remain. Seed with
   * `[Infinity, -Infinity]`. Ignored when {@link colorDomain} is pinned.
   */
  domainSeed?: readonly [number, number];
  /**
   * Escape hatch: colour by the shared constant/categorical/ramp trichotomy
   * instead of the weight ramp. When set, {@link colorRange} /
   * {@link colorDomain} are ignored for COLOUR (the weight is still read for
   * extrusion).
   */
  colorMode?: FeatureColorMode;
  /** Shrink each cell toward its own centroid, 0..1. @default 0.92 (deck's default) */
  coverage?: number;
  /** Raise each cell into a prism `weight × elevationScale` metres tall. @default false */
  extruded?: boolean;
  /** METRES of height per unit of {@link weightProperty}. @default 1 */
  elevationScale?: number;
  /**
   * Archive layer name the summary rows live under. Defaults to `'summary'`.
   * Layers with a different name are skipped so a tile that ALSO carries its
   * raw tier is not decoded as cells — unless no layer matches at all, in which
   * case any layer carrying `featureIds64` is used and the mismatch reported.
   */
  summaryLayerName?: string;
}

/** ColorBrewer YlGnBu, the 6-stop ramp deck's and maplibre's summary layers share. */
export const DEFAULT_SUMMARY_RAMP: readonly RGBA255[] = [
  [255, 255, 217, 255],
  [237, 248, 177, 255],
  [199, 233, 180, 255],
  [127, 205, 187, 255],
  [65, 182, 196, 255],
  [34, 94, 168, 255],
];

const DEFAULT_WEIGHT_PROPERTY = 'count';
const DEFAULT_COVERAGE = 0.92;
const DEFAULT_ELEVATION_SCALE = 1;
const FALLBACK_SUMMARY_LAYER_NAME = 'summary';

// ── layer selection ─────────────────────────────────────────────────────────

/**
 * Every summary layer across `tiles`, in tile/layer order. Prefers an exact
 * name match; falls back to "any layer carrying a u64 id column" so an archive
 * that baked its summary tier under a different name still renders (the caller
 * warns once via {@link SummaryCellDiagnostics.layerNameMismatch}).
 */
export function collectSummaryLayers(
  tiles: Tile[],
  layerName: string = FALLBACK_SUMMARY_LAYER_NAME,
): { layers: BinaryFeatures[]; nameMismatch: boolean } {
  const named: BinaryFeatures[] = [];
  const anyWithIds: BinaryFeatures[] = [];
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      if (layer.features.featureCount === 0) continue;
      if (!layer.features.featureIds64) continue;
      anyWithIds.push(layer.features);
      if (layer.name === layerName) named.push(layer.features);
    }
  }
  if (named.length > 0) return { layers: named, nameMismatch: false };
  return { layers: anyWithIds, nameMismatch: anyWithIds.length > 0 };
}

// ── ring maths (pure, frame-free) ───────────────────────────────────────────

/**
 * Copy `ring` into a flat `[lon, lat, …]` array, dropping a trailing duplicate
 * of the first vertex and UNWRAPPING longitudes sequentially so the ring is
 * continuous in longitude even across ±180°.
 *
 * The unwrap is not about the projection (ECEF has no seam) — it is what makes
 * the centroid and the `coverage` shrink correct for a cell straddling the
 * antimeridian, where a naive mean of `[179.9, -179.9]` lands at longitude 0,
 * on the far side of the planet.
 */
export function unwrapRing(
  ring: readonly (readonly number[])[],
): Float64Array | null {
  let n = ring.length;
  if (n >= 2) {
    const first = ring[0];
    const last = ring[n - 1];
    if (first[0] === last[0] && first[1] === last[1]) n -= 1;
  }
  if (n < 3) return null;
  const out = new Float64Array(n * 2);
  let prev = ring[0][0];
  out[0] = prev;
  out[1] = ring[0][1];
  for (let i = 1; i < n; i++) {
    let lon = ring[i][0];
    // Place each vertex within ±180° of its predecessor.
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out[i * 2] = lon;
    out[i * 2 + 1] = ring[i][1];
    prev = lon;
  }
  if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) return null;
  return out;
}

/** Arithmetic centroid of an unwrapped `[lon, lat, …]` ring, lon re-normalized. */
export function ringCentroid(unwrapped: Float64Array): [number, number] {
  const n = unwrapped.length >> 1;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += unwrapped[i * 2];
    sy += unwrapped[i * 2 + 1];
  }
  let lon = sx / n;
  // Fold the unwrapped mean back into [-180, 180) — the pick coordinate is a
  // real-world longitude, not a frame-local one.
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return [lon, sy / n];
}

/**
 * Project an unwrapped `[lon, lat, …]` ring to absolute f64 ECEF metres,
 * shrinking each vertex toward `centre` by `coverage` first.
 *
 * The shrink happens in lon/lat (the frame the ring arrives in), matching
 * `@poopdeck.gl/three`; `@poopdeck.gl/maplibre` shrinks in mercator because
 * that is the only frame IT has. The two differ only by mercator's latitude
 * stretch ACROSS ONE CELL — second order everywhere a cell is legible.
 */
export function ringToEcef(
  unwrapped: Float64Array,
  centreLon: number,
  centreLat: number,
  coverage: number,
  height = 0,
): Float64Array {
  const n = unwrapped.length >> 1;
  const out = new Float64Array(n * 3);
  const k = coverage;
  for (let i = 0; i < n; i++) {
    const lon = centreLon + (unwrapped[i * 2] - centreLon) * k;
    const lat = centreLat + (unwrapped[i * 2 + 1] - centreLat) * k;
    const [x, y, z] = GLOBE.project(lon, lat, height);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

// ── the build ───────────────────────────────────────────────────────────────

/**
 * Build one {@link SummaryCell} per summary row across `tiles`.
 *
 * Two passes over the rows: the first fits the colour domain (widening the
 * caller's seed, never narrowing), the second assembles geometry and colour.
 * The split is what lets a pinned and an auto-fit domain share one code path.
 *
 * Returns an empty build (`cells: []`, `timeOrigin: 0`) when there is nothing
 * to draw — the layer checks `cells.length` BEFORE adopting `timeOrigin`, so an
 * empty rebuild leaves the previous origin untouched.
 */
export function buildSummaryCells(
  tiles: Tile[],
  resolve: CellBoundaryResolver,
  opts: SummaryCellBuildOptions = {},
): SummaryCellBuild {
  const weightProperty = opts.weightProperty ?? DEFAULT_WEIGHT_PROPERTY;
  const coverage = opts.coverage ?? DEFAULT_COVERAGE;
  const extruded = opts.extruded ?? false;
  const elevationScale = opts.elevationScale ?? DEFAULT_ELEVATION_SCALE;
  const range = opts.colorRange ?? DEFAULT_SUMMARY_RAMP;
  const seed = opts.domainSeed ?? [Infinity, -Infinity];

  const diagnostics: SummaryCellDiagnostics = {
    skipped: 0,
    missingIds: false,
    missingWeight: false,
    layerNameMismatch: false,
  };

  const { layers, nameMismatch } = collectSummaryLayers(
    tiles,
    opts.summaryLayerName ?? FALLBACK_SUMMARY_LAYER_NAME,
  );
  diagnostics.layerNameMismatch = nameMismatch;
  if (layers.length === 0) {
    // Distinguish "no tiles" from "tiles, but none carry a u64 id column" —
    // the second is a build-flag mistake the layer should shout about.
    diagnostics.missingIds = tiles.some((t) =>
      t.layers.some((l) => l.features.featureCount > 0),
    );
    return {
      cells: [],
      timeOrigin: 0,
      domain: [seed[0], seed[1]],
      diagnostics,
    };
  }

  const timeOrigin = layers[0].timeOffset;

  // Pass 1 — fit the domain. Non-finite samples are ignored so one NaN weight
  // cannot poison the whole legend.
  let lo = seed[0];
  let hi = seed[1];
  if (!opts.colorDomain) {
    for (const b of layers) {
      const col = b.numericProps[weightProperty];
      if (!col) continue;
      for (let i = 0; i < b.featureCount; i++) {
        const w = col[i];
        if (!Number.isFinite(w)) continue;
        if (w < lo) lo = w;
        if (w > hi) hi = w;
      }
    }
  }
  const domain: [number, number] = opts.colorDomain
    ? [opts.colorDomain[0], opts.colorDomain[1]]
    : [lo, hi];
  // A degenerate or unseeded fit would make `rampColorAt` divide by zero; fall
  // back to a unit span so every cell paints the ramp's LOW stop rather than
  // NaN. This never blanks the layer.
  const rampDomain: readonly [number, number] =
    Number.isFinite(domain[0]) &&
    Number.isFinite(domain[1]) &&
    domain[1] > domain[0]
      ? domain
      : [0, 1];

  // Pass 2 — geometry + colour.
  const cells: SummaryCell[] = [];
  for (const b of layers) {
    const ids = b.featureIds64;
    if (!ids) {
      diagnostics.missingIds = true;
      continue;
    }
    const col = b.numericProps[weightProperty];
    if (!col) diagnostics.missingWeight = true;
    const rebase = b.timeOffset - timeOrigin;

    for (let i = 0; i < b.featureCount && i < ids.length; i++) {
      const ring = resolve(ids[i]);
      if (!ring) {
        diagnostics.skipped++;
        continue;
      }
      const unwrapped = unwrapRing(ring);
      if (!unwrapped) {
        diagnostics.skipped++;
        continue;
      }
      const [lon, lat] = ringCentroid(unwrapped);
      const rawWeight = col ? col[i] : 0;
      const weight = Number.isFinite(rawWeight) ? rawWeight : 0;
      const height = extruded ? weight * elevationScale : 0;
      const rgba: RGBA255 = opts.colorMode
        ? featureColor(b, i, opts.colorMode)
        : rampColorAt(weight, rampDomain, range);
      cells.push({
        // Rings are built at height 0; extrusion rides `PolygonGeometry`'s
        // `extrudedHeight` so the prism conforms to the ellipsoid rather than
        // being hand-tessellated in a locally-flat frame.
        positions: ringToEcef(unwrapped, lon, lat, coverage, 0),
        // Normalize ONCE here so the per-frame setTime never re-divides by 255.
        r: rgba[0] / 255,
        g: rgba[1] / 255,
        b: rgba[2] / 255,
        a: (rgba[3] ?? 255) / 255,
        weight,
        height,
        start: b.startTimes[i] + rebase,
        end: b.endTimes[i] + rebase,
        lon,
        lat,
        binary: b,
        featureIndex: i,
      });
    }
  }

  return { cells, timeOrigin, domain, diagnostics };
}
