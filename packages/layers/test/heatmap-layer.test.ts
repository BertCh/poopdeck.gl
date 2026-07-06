/**
 * Pure-logic tests for HeatmapLayer.
 *
 * The full pipeline now delegates the GPU splat/accumulate/ramp to the
 * canonical `@deck.gl/aggregation-layers` HeatmapLayer + DataFilterExtension,
 * which needs a real WebGL2 context and is exercised by `tools/render-test`.
 * Here we verify the CPU-side data path that feeds it:
 *
 *   - `buildConsolidatedChannelData` consolidates every visible tile's points
 *     into one binary buffer set, applies the channel's `categoryFilter`,
 *     folds the per-channel `intensity` into the weight, and relativizes each
 *     point's start time against the layer-wide offset.
 *   - Time relativization against the layer offset preserves f32 precision for
 *     absolute Unix-ms timestamps within the documented window.
 */

import { describe, it, expect } from 'vitest';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { buildConsolidatedChannelData } from '../src/layers/summary/heatmap-layer';

function makeBinaryFixture(timeOffset = 1_700_000_000_000): BinaryFeatures {
  // 6 features: 3 pickup, 2 dropoff, 1 transit.
  // Positions are arbitrary lon/lat; times are relative to timeOffset.
  const positions = new Float64Array([
    -74, 40.7, // 0
    -74.01, 40.72, // 1
    -74.02, 40.74, // 2
    -73.98, 40.76, // 3
    -73.95, 40.78, // 4
    -73.99, 40.75, // 5
  ]);
  const startTimes = new Float32Array([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
  const endTimes = new Float32Array([500, 1_500, 2_500, 3_500, 4_500, 5_500]);
  const featureIds = new Uint32Array([1, 2, 3, 4, 5, 6]);
  const cat = {
    indices: new Uint16Array([0, 1, 0, 1, 0, 2]),
    categories: ['pickup', 'dropoff', 'transit'],
  };
  return {
    featureCount: 6,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds,
    startTimes,
    endTimes,
    timeOffset,
    numericProps: { fare: new Float32Array([10, 20, 30, 40, 50, 60]) },
    categoricalProps: { status: cat },
  } as BinaryFeatures;
}

function wrapTile(binary: BinaryFeatures, t = 0): Tile {
  return {
    id: { z: 12, x: 1, y: 1, t },
    timeRange: { start: 0, end: 1 },
    layers: [
      {
        name: 'points',
        extent: 4096,
        features: binary,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  } as Tile;
}

describe('buildConsolidatedChannelData: per-channel masking + packing', () => {
  it('keeps only features whose categorical value matches', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData(
      [tile],
      { categoryFilter: { property: 'status', values: ['pickup'] }, intensity: 1 },
      undefined,
      1_700_000_000_000,
    );
    expect(data).not.toBeNull();
    expect(data!.length).toBe(3); // indices 0, 2, 4
    expect(data!.attributes.getPosition.value.length).toBe(9); // 3 pts × 3
    expect(data!.attributes.getWeight.value.length).toBe(3);
    expect(data!.attributes.getFilterValue.value.length).toBe(3);
    // First retained point is feature 0 at [-74, 40.7].
    expect(data!.attributes.getPosition.value[0]).toBeCloseTo(-74);
    expect(data!.attributes.getPosition.value[1]).toBeCloseTo(40.7);
    expect(data!.attributes.getPosition.value[2]).toBe(0); // padded altitude
  });

  it('returns null when the tile is missing the filter property', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData(
      [tile],
      { categoryFilter: { property: 'nonexistent', values: ['x'] }, intensity: 1 },
      undefined,
      1_700_000_000_000,
    );
    expect(data).toBeNull();
  });

  it('returns null when no category matches', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData(
      [tile],
      { categoryFilter: { property: 'status', values: ['ghost'] }, intensity: 1 },
      undefined,
      1_700_000_000_000,
    );
    expect(data).toBeNull();
  });

  it('accepts multiple matching values', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData(
      [tile],
      {
        categoryFilter: { property: 'status', values: ['pickup', 'dropoff'] },
        intensity: 1,
      },
      undefined,
      1_700_000_000_000,
    );
    expect(data!.length).toBe(5);
  });

  it('defaults weight to 1 and folds the per-channel intensity in', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData([tile], { intensity: 2 }, undefined, 1_700_000_000_000);
    expect(data!.length).toBe(6);
    // weight = (no weightProperty → 1) × intensity(2)
    expect(Array.from(data!.attributes.getWeight.value)).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it('sources weight from weightProperty × intensity', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData([tile], { intensity: 0.5 }, 'fare', 1_700_000_000_000);
    // fare = [10..60] × 0.5
    expect(Array.from(data!.attributes.getWeight.value)).toEqual([5, 10, 15, 20, 25, 30]);
  });

  it('consolidates across tiles and relativizes times against the layer offset', () => {
    const layerOffset = 1_700_000_000_000;
    // Second tile sits 1 hour later — its per-feature times must be shifted by
    // the +3_600_000 ms delta so the consolidated filter values are comparable.
    const tileA = wrapTile(makeBinaryFixture(layerOffset), 0);
    const tileB = wrapTile(makeBinaryFixture(layerOffset + 3_600_000), 1);
    const data = buildConsolidatedChannelData([tileA, tileB], { intensity: 1 }, undefined, layerOffset);
    expect(data!.length).toBe(12); // 6 + 6
    // tileA feature 0 start=0 + delta 0 → 0
    expect(data!.attributes.getFilterValue.value[0]).toBe(0);
    // tileB feature 0 start=0 + delta 3_600_000 → 3_600_000
    expect(data!.attributes.getFilterValue.value[6]).toBe(3_600_000);
    // tileB feature 5 start=5_000 + delta 3_600_000 → 3_605_000
    expect(data!.attributes.getFilterValue.value[11]).toBe(3_605_000);
  });
});

describe('HeatmapLayer: time relativization (f32 precision)', () => {
  it('keeps relative times inside the f32 mantissa budget for typical windows', () => {
    // Tile offset = 2025-01-01 03:00, layer offset = 2025-01-01 00:00. The
    // delta is 3h = 10_800_000 ms — well inside f32's 16.7M-ms budget.
    const tileOffset = Date.parse('2025-01-01T03:00:00Z');
    const layerOffset = Date.parse('2025-01-01T00:00:00Z');
    const delta = tileOffset - layerOffset;

    const relativeStart = 12_345;
    const absStart = tileOffset + relativeStart;
    const layerRelStart = absStart - layerOffset;

    expect(layerRelStart).toBe(relativeStart + delta);
    expect(Math.fround(layerRelStart)).toBe(layerRelStart);
  });
});
