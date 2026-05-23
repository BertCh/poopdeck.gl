/**
 * Test helpers: build minimal fake STT tiles with binary features.
 */

import type { Tile, BinaryFeatures } from '@stt/core';

export interface FakePointTileOptions {
  /** [lon, lat] per feature */
  positions: number[][];
  /** Per-feature start times, RELATIVE to timeOffset */
  startTimes: number[];
  /** Per-feature end times, RELATIVE to timeOffset */
  endTimes: number[];
  timeOffset: number;
  tileId?: { z: number; x: number; y: number; t: number };
}

export function makePointTile(opts: FakePointTileOptions): Tile {
  const count = opts.positions.length;
  const positions = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = opts.positions[i][0];
    positions[i * 2 + 1] = opts.positions[i][1];
  }

  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: 0 as any,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(opts.startTimes),
    endTimes: new Float32Array(opts.endTimes),
    timeOffset: opts.timeOffset,
    numericProps: {},
    categoricalProps: {},
  };

  return {
    id: (opts.tileId ?? { z: 0, x: 0, y: 0, t: 0 }) as any,
    timeRange: { start: 0, end: 0 } as any,
    layers: [{ name: 'layer0', extent: 4096, features }],
  };
}

export interface FakePathTileOptions {
  /** Each path is an array of [lon, lat] vertices */
  paths: number[][][];
  /** Per-feature start times, RELATIVE to timeOffset */
  startTimes: number[];
  /** Per-feature end times, RELATIVE to timeOffset */
  endTimes: number[];
  timeOffset: number;
  tileId?: { z: number; x: number; y: number; t: number };
}

export function makePathTile(opts: FakePathTileOptions): Tile {
  const featureCount = opts.paths.length;
  let totalVertices = 0;
  for (const p of opts.paths) totalVertices += p.length;

  const positions = new Float64Array(totalVertices * 2);
  const startIndices = new Uint32Array(featureCount + 1);

  let v = 0;
  for (let f = 0; f < featureCount; f++) {
    startIndices[f] = v;
    for (const [lon, lat] of opts.paths[f]) {
      positions[v * 2] = lon;
      positions[v * 2 + 1] = lat;
      v++;
    }
  }
  startIndices[featureCount] = v;

  const features: BinaryFeatures = {
    featureCount,
    geometryType: 1 as any,
    positionDimensions: 2,
    positions,
    startIndices,
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(opts.startTimes),
    endTimes: new Float32Array(opts.endTimes),
    timeOffset: opts.timeOffset,
    numericProps: {},
    categoricalProps: {},
  };

  return {
    id: (opts.tileId ?? { z: 0, x: 0, y: 0, t: 0 }) as any,
    timeRange: { start: 0, end: 0 } as any,
    layers: [{ name: 'layer0', extent: 4096, features }],
  };
}
