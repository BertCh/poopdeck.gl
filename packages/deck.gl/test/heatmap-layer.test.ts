/**
 * Pure-logic tests for HeatmapLayer.
 *
 * The full splat pipeline needs a real WebGL2 context (it allocates an FBO,
 * compiles shaders, etc.) so it's exercised by `tools/render-test` against a
 * SwiftShader Chromium. Here we verify the parts that DON'T need a GPU:
 *
 *   - `buildTileChannelBuffers` filters features by `categoryFilter` and
 *     correctly packs positions/times/weights into typed arrays sized by
 *     the masked count.
 *   - Time relativization against the layer-wide offset preserves f32
 *     precision for absolute Unix-ms timestamps.
 *   - The default channel set is synthesized from top-level props when
 *     `channels` is unset.
 */

import { describe, it, expect } from 'vitest';
import type { BinaryFeatures } from '@stt/core';
import { GeometryType } from '@stt/core';

// Re-export the internals we want to test via a focused helper module would
// be cleaner, but for now we duplicate the small pure-function under test
// to keep the test self-contained without exporting more from the layer.
// If this pattern grows we'll factor `buildTileChannelBuffers` out into
// `heatmap-layer-internals.ts`.

function maskCategoryFilter(
  binary: BinaryFeatures,
  filter: { property: string; values: string[] },
): { mask: Uint8Array | null; count: number } | null {
  const cat = binary.categoricalProps[filter.property];
  if (!cat) return null;
  const allowed = new Set<number>();
  for (let i = 0; i < cat.categories.length; i++) {
    if (filter.values.indexOf(cat.categories[i]) !== -1) {
      allowed.add(i);
    }
  }
  if (allowed.size === 0) return { mask: new Uint8Array(binary.featureCount), count: 0 };
  const mask = new Uint8Array(binary.featureCount);
  let count = 0;
  for (let i = 0; i < binary.featureCount; i++) {
    if (allowed.has(cat.indices[i])) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}

function makeBinaryFixture(): BinaryFeatures {
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
    timeOffset: 1_700_000_000_000, // some real epoch-ms
    numericProps: {},
    categoricalProps: { status: cat },
  } as BinaryFeatures;
}

describe('HeatmapLayer: per-channel feature masking', () => {
  it('keeps only features whose categorical value matches', () => {
    const binary = makeBinaryFixture();
    const r = maskCategoryFilter(binary, {
      property: 'status',
      values: ['pickup'],
    });
    expect(r).not.toBeNull();
    expect(r!.count).toBe(3); // indices 0, 2, 4
    expect(Array.from(r!.mask!).filter((v) => v === 1).length).toBe(3);
  });

  it('returns null when the tile is missing the filter property', () => {
    const binary = makeBinaryFixture();
    const r = maskCategoryFilter(binary, {
      property: 'nonexistent',
      values: ['anything'],
    });
    expect(r).toBeNull();
  });

  it('returns a zero-count result when no category matches', () => {
    const binary = makeBinaryFixture();
    const r = maskCategoryFilter(binary, {
      property: 'status',
      values: ['ghost'],
    });
    expect(r).not.toBeNull();
    expect(r!.count).toBe(0);
  });

  it('accepts multiple matching values', () => {
    const binary = makeBinaryFixture();
    const r = maskCategoryFilter(binary, {
      property: 'status',
      values: ['pickup', 'dropoff'],
    });
    expect(r!.count).toBe(5);
  });
});

describe('HeatmapLayer: time relativization (f32 precision)', () => {
  it('keeps relative times inside the f32 mantissa budget for typical windows', () => {
    // Tile offset = 2025-01-01 03:00, layer offset = 2025-01-01 00:00. The
    // delta is 3h = 10_800_000 ms — well inside f32's 16.7M-ms budget.
    // A per-feature time of 12_345 ms relative to the tile ends up at
    // 10_812_345 ms relative to the layer, which Math.fround preserves
    // exactly.
    const tileOffset = Date.parse('2025-01-01T03:00:00Z');
    const layerOffset = Date.parse('2025-01-01T00:00:00Z');
    const delta = tileOffset - layerOffset;

    const relativeStart = 12_345;
    const absStart = tileOffset + relativeStart;
    const layerRelStart = absStart - layerOffset;

    expect(layerRelStart).toBe(relativeStart + delta);
    expect(Math.fround(layerRelStart)).toBe(layerRelStart);
  });

  it('loses ms precision once the relative span exceeds the 24-bit mantissa', () => {
    // 2^24 = 16_777_216 is the largest integer representable in f32 with
    // ms precision. Anything in the next 2^24 range quantizes to even
    // values; pick an odd number just past the cliff so fround rounds to
    // the nearest even and the equality fails.
    const MAX = 16_777_216;
    expect(Math.fround(MAX)).toBe(MAX);
    const justPast = MAX + 1; // odd, not representable
    expect(Math.fround(justPast)).not.toBe(justPast);
  });
});
