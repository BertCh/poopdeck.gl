// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of instanced wide-line **segment** buffers for
 * animated TRIPS — the Three port of deck's `AnimatedTripsLayer` (trail mode).
 *
 * Identical segment geometry / RTC / colour pipeline as
 * {@link buildLineSegmentBuffers}, but it writes REAL per-vertex trail times
 * into `timeA`/`timeB` (one per segment endpoint) so the `trail` branch of
 * {@link createWideLineMaterial} fades each vertex behind the playhead over
 * `[cur - trailLength, cur]`.
 *
 * Per-vertex time scheme (verbatim from deck `AnimatedTripsLayer`):
 *   1. prefer the tile's own `vertexTimestamps` column (zero-copy from Arrow);
 *   2. else synthesize from each feature's `[startTime,endTime]` distributed
 *      across its vertices by cumulative haversine distance (matches the Rust
 *      `interpolate_vertex_times` and the deck `synthesizeVertexTimes`). The
 *      previous index-based fallback made long edges "flash".
 * Both columns are tile-relative (rebased to the tile `timeOffset` by the
 * decoder / synthesizer), so the same `timeOffset - timeOrigin` rebase that
 * applies to `[start,end]` is added to bring them onto the global playhead.
 *
 * **RTC**: positions are written f32 RELATIVE to a per-build `origin` (the first
 * projected vertex); the layer sets `object.position = origin`. AV/ENU origin is
 * tiny → no-op.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { synthesizeVertexTimes } from '@poopdeck.gl/core/trips';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  rampColorAt,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from './color.js';
import { featureTileKey } from './id-pick.js';

// Moved to the framework-free kernel (`core/trips`) when Cesium became its
// third consumer; re-exported so existing three importers keep resolving.
export { synthesizeVertexTimes };

export type TripsColorMode =
  | ({ type: 'categorical' } & CategoricalColorSpec)
  | ({ type: 'ramp' } & RampColorSpec)
  | { type: 'constant'; color: RGBA };

export interface TripsBufferOptions {
  colorMode: TripsColorMode;
  /** Altitude column (metres), per feature. @default null (use geometry z) */
  elevationProperty?: string | null;
  elevationScale?: number;
  /** Constant height lift (metres) — keeps ground decals off the basemap. @default 0 */
  zLift?: number;
  /**
   * Numeric column feeding the GPU DataFilter (`sttFilterValue`, per segment —
   * a trip's value repeated to each of its segments). When set, `filterValues`
   * is emitted (0 where a tile lacks the column, deck's constant fallback).
   * @default null (no filter attribute)
   */
  filterProperty?: string | null;
}

export interface TripsBuffers {
  count: number;
  posA: Float32Array; // vec3, RTC-local
  posB: Float32Array; // vec3, RTC-local
  colorA: Float32Array; // vec4 0..1
  colorB: Float32Array; // vec4 0..1
  starts: Float32Array; // float, relative to timeOrigin (feature start)
  ends: Float32Array; // float, relative to timeOrigin (feature end)
  timeA: Float32Array; // float, relative — per-vertex trail time at endpoint A
  timeB: Float32Array; // float, relative — per-vertex trail time at endpoint B
  /** float, per-segment DataFilter value; 0-length when no `filterProperty`. */
  filterValues: Float32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-instance provenance (the GPU picking-catalog identity buffer).
   * Merged segment instance `i` resolves via `provenance.resolve(i)` to its
   * source `(tileKey, featureIndex)`; a trip's several segment instances all point
   * at the same trip `featureIndex`, so a pick on any segment resolves to the
   * whole trip. Populated in draw order. Empty when `count === 0`.
   */
  provenance: InstanceProvenance;
  /**
   * `tileKey` → the source layer's {@link BinaryFeatures}, joined back to trips via
   * `getFeatureProperties(binary, featureIndex)`. Built from the SAME iteration
   * (and the same {@link featureTileKey}) as {@link provenance}.
   */
  binaryByTileKey: Map<string, BinaryFeatures>;
}

function featureColor(
  b: BinaryFeatures,
  f: number,
  mode: TripsColorMode,
): RGBA {
  if (mode.type === 'constant') return mode.color;
  if (mode.type === 'ramp') {
    const col = b.numericProps[mode.property];
    return col ? rampColorAt(col[f], mode.domain, mode.range) : mode.fallback;
  }
  const cat = b.categoricalProps[mode.property];
  const label =
    cat && cat.indices[f] !== 0xffff
      ? cat.categories[cat.indices[f]]
      : undefined;
  return resolveCategoryColor(label, mode.mapping, mode.fallback);
}

function collectLineLayers(tiles: Tile[]): {
  parts: Array<{ b: BinaryFeatures; tileKey: string }>;
  segCount: number;
} {
  const parts: Array<{ b: BinaryFeatures; tileKey: string }> = [];
  let segCount = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (
        !b.featureCount ||
        b.geometryType !== GeometryType.LineString ||
        !b.startIndices
      )
        continue;
      parts.push({ b, tileKey: featureTileKey(tile.id, tl.name) });
      for (let f = 0; f < b.featureCount; f++) {
        segCount += Math.max(0, b.startIndices[f + 1] - b.startIndices[f] - 1);
      }
    }
  }
  return { parts, segCount };
}

/**
 * Build instanced trip-segment buffers with per-vertex trail times. One segment
 * instance per consecutive vertex pair; `timeA`/`timeB` carry the (rebased)
 * per-vertex trail times of the two endpoints.
 */
export function buildTripsBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: TripsBufferOptions,
): TripsBuffers {
  const { parts, segCount } = collectLineLayers(tiles);
  const provenance = new InstanceProvenance();
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const empty = (): TripsBuffers => ({
    count: 0,
    posA: new Float32Array(0),
    posB: new Float32Array(0),
    colorA: new Float32Array(0),
    colorB: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    timeA: new Float32Array(0),
    timeB: new Float32Array(0),
    filterValues: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
    provenance,
    binaryByTileKey,
  });
  if (segCount === 0) return empty();

  const zLift = opts.zLift ?? 0;
  const elevScale = opts.elevationScale ?? 1;
  const wantFilter = !!opts.filterProperty;

  // RTC origin = first vertex of the first feature, projected (absolute world).
  const first = parts[0].b;
  const fdims = first.positionDimensions ?? 2;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    zLift,
  );

  const posA = new Float32Array(segCount * 3);
  const posB = new Float32Array(segCount * 3);
  const colorA = new Float32Array(segCount * 4);
  const colorB = new Float32Array(segCount * 4);
  const starts = new Float32Array(segCount);
  const ends = new Float32Array(segCount);
  const timeA = new Float32Array(segCount);
  const timeB = new Float32Array(segCount);
  const filterValues = wantFilter
    ? new Float32Array(segCount)
    : new Float32Array(0);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let s = 0; // segment index
  for (const part of parts) {
    const b = part.b;
    binaryByTileKey.set(part.tileKey, b);
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const filterCol =
      wantFilter && opts.filterProperty
        ? b.numericProps[opts.filterProperty]
        : undefined;
    const rebase = b.timeOffset - timeOrigin;
    const startIndices = b.startIndices!;
    const totalVerts = startIndices[b.featureCount];

    // Per-vertex trail times: prefer the tile's own column (zero-copy),
    // else synthesize by cumulative haversine distance. Both are tile-relative,
    // so `rebase` lifts them onto the global playhead — same as [start,end].
    const vertexTimes: Float32Array =
      b.vertexTimestamps && b.vertexTimestamps.length >= totalVerts
        ? b.vertexTimestamps
        : synthesizeVertexTimes(b);

    for (let f = 0; f < b.featureCount; f++) {
      const rgba = featureColor(b, f, opts.colorMode);
      const cr = rgba[0] / 255,
        cg = rgba[1] / 255,
        cb = rgba[2] / 255,
        ca = (rgba[3] ?? 255) / 255;
      const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      const fval = wantFilter && filterCol ? filterCol[f] : 0;
      const baseZ = elev ? elev[f] * elevScale : null;
      const v0 = startIndices[f];
      const v1 = startIndices[f + 1];
      for (let v = v0; v < v1 - 1; v++) {
        // One provenance entry per SEGMENT instance (merged index = s), all of a
        // trip's segments pointing at the same trip `featureIndex` f. Draw order.
        provenance.push(part.tileKey, f);
        const z0 =
          (baseZ ?? (dims > 2 ? b.positions[v * dims + 2] : 0)) + zLift;
        const z1 =
          (baseZ ?? (dims > 2 ? b.positions[(v + 1) * dims + 2] : 0)) + zLift;
        const a = projection.project(
          b.positions[v * dims],
          b.positions[v * dims + 1],
          z0,
        );
        const c = projection.project(
          b.positions[(v + 1) * dims],
          b.positions[(v + 1) * dims + 1],
          z1,
        );
        const ax = a[0] - origin[0],
          ay = a[1] - origin[1],
          az = a[2] - origin[2];
        const bx = c[0] - origin[0],
          by = c[1] - origin[1],
          bz = c[2] - origin[2];
        posA[s * 3] = ax;
        posA[s * 3 + 1] = ay;
        posA[s * 3 + 2] = az;
        posB[s * 3] = bx;
        posB[s * 3 + 1] = by;
        posB[s * 3 + 2] = bz;
        colorA[s * 4] = cr;
        colorA[s * 4 + 1] = cg;
        colorA[s * 4 + 2] = cb;
        colorA[s * 4 + 3] = ca;
        colorB[s * 4] = cr;
        colorB[s * 4 + 1] = cg;
        colorB[s * 4 + 2] = cb;
        colorB[s * 4 + 3] = ca;
        starts[s] = start;
        ends[s] = end;
        // Per-vertex trail times of the two endpoints (rebased to global playhead).
        timeA[s] = vertexTimes[v] + rebase;
        timeB[s] = vertexTimes[v + 1] + rebase;
        if (wantFilter) filterValues[s] = fval;
        for (const [x, y, zz] of [
          [ax, ay, az],
          [bx, by, bz],
        ] as const) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (zz < minZ) minZ = zz;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (zz > maxZ) maxZ = zz;
        }
        s++;
      }
    }
  }

  return {
    count: segCount,
    posA,
    posB,
    colorA,
    colorB,
    starts,
    ends,
    timeA,
    timeB,
    filterValues,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}
