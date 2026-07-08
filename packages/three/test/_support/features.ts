// @poopdeck.gl/three — test support
// SPDX-License-Identifier: MIT
//
// Shared `BinaryFeatures`/`Tile` factories for the buffer/pick/color/cell suites.
// Every buffer test used to hand-roll a near-identical ~25-line skeleton; these
// three builders own that boilerplate so the tests keep only their per-builder
// payload + assertions. Overridable fields (timeOffset, layerName, geometryType,
// geometryExtensionName, id) travel through `opts`; anything else rides `partial`
// and shadows the defaults via spread, exactly as the inline factories did.

import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile, TileId } from '@poopdeck.gl/core';

export interface TileOpts {
  timeOffset?: number;
  layerName?: string;
  geometryType?: GeometryType;
  geometryExtensionName?: string;
  /** Tile-address zoom (inert for the buffer builders; only pointTileKey reads id). */
  z?: number;
  /** Full tile id override (used by the point-pick provenance fixtures). */
  id?: TileId;
}

/**
 * A point-geometry tile with `count` features and an interleaved lon/lat buffer.
 * No `startIndices` (points are one vertex each). Matches the inline `pointTile`
 * shared by point/column/icon/surfel/provenance tests.
 */
export function makePointTile(
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures> = {},
  opts: TileOpts = {},
): Tile {
  const timeOffset = opts.timeOffset ?? 0;
  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: opts.geometryType ?? GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(count),
    endTimes: new Float32Array(count),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: opts.id ?? { z: opts.z ?? 12, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: opts.layerName ?? 'points',
        extent: 0,
        features,
        geometryExtensionName: opts.geometryExtensionName ?? 'geoarrow.point',
      },
    ],
  };
}

/**
 * A LineString (or, via `opts.geometryType`, Polygon) tile. Base skeleton is
 * sized for one feature with an empty position buffer + `startIndices [0,0]`;
 * callers override the real geometry through `partial`. Matches the inline
 * `arcTile`/`flowTile`/`lineTile`/`odTile`/`tripTile`/`polyTile` factories.
 */
export function makeLineTile(
  partial: Partial<BinaryFeatures>,
  opts: TileOpts = {},
): Tile {
  const timeOffset = opts.timeOffset ?? 0;
  const features: BinaryFeatures = {
    featureCount: 1,
    geometryType: opts.geometryType ?? GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(1),
    startTimes: new Float32Array(1),
    endTimes: new Float32Array(1),
    startIndices: new Uint32Array([0, 0]),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: opts.id ?? { z: opts.z ?? 14, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: opts.layerName ?? 'lines',
        extent: 0,
        features,
        geometryExtensionName:
          opts.geometryExtensionName ?? 'geoarrow.linestring',
      },
    ],
  };
}

/**
 * A vector-summary point tile carrying a `featureIds64` (u64 cell id) column and
 * a `count` numeric column — the payload the H3/Quadbin summary builders decode.
 * Matches the inline `summaryTile` shared by h3-cell/quadbin-cell.
 */
export function makeVectorTile(
  ids: bigint[],
  counts: number[],
  layerName = 'summary',
): Tile {
  const n = ids.length;
  const features: BinaryFeatures = {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(n * 2),
    featureIds: new Uint32Array(n),
    featureIds64: BigUint64Array.from(ids),
    startTimes: new Float32Array(n),
    endTimes: new Float32Array(n),
    timeOffset: 0,
    numericProps: { count: new Float32Array(counts) },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 4, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 1 },
    layers: [
      {
        name: layerName,
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}
