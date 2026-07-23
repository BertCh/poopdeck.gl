// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * Fake point-tile harness for the track-kernel suites (hoisted from
 * `@poopdeck.gl/layers` test/fake-tile.ts alongside the kernel itself — campaign
 * D7). Builds the minimal decoded-tile shape the kernel reads: positions,
 * tile-relative start times + a `timeOffset`, and string-categorical columns.
 */

import { GeometryType } from '../../src/types';
import type { Tile, BinaryFeatures } from '../../src/types';

export interface FakePointTileOptions {
  /** [lon, lat] per feature. */
  positions: number[][];
  /** Per-feature start times, RELATIVE to timeOffset. */
  startTimes: number[];
  /** Per-feature end times, RELATIVE to timeOffset. */
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
    geometryType: GeometryType.Point,
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
    id: (opts.tileId ?? { z: 0, x: 0, y: 0, t: 0 }) as Tile['id'],
    timeRange: { start: 0, end: 0 },
    layers: [
      {
        name: 'layer0',
        extent: 4096,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  } as Tile;
}

/** Build a categorical `{indices, categories}` column from string values. */
export function categorical(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
  const categories: string[] = [];
  const map = new Map<string, number>();
  const indices = new Uint16Array(values.length);
  values.forEach((v, i) => {
    let idx = map.get(v);
    if (idx === undefined) {
      idx = categories.length;
      categories.push(v);
      map.set(v, idx);
    }
    indices[i] = idx;
  });
  return { indices, categories };
}
