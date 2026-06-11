/**
 * `getFeatureProperties` — the event-driven row decode behind deck.gl
 * picking (`info.object`). The render path never materializes per-feature
 * objects; this helper does it for exactly one feature at pick time.
 */

import { describe, it, expect } from 'vitest';
import { getFeatureProperties } from '../src/tile';
import { GeometryType, type BinaryFeatures } from '../src/types';

function makeFeatures(overrides: Partial<BinaryFeatures> = {}): BinaryFeatures {
  return {
    featureCount: 3,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(6),
    featureIds: new Uint32Array([7, 8, 9]),
    startTimes: new Float32Array([10, 20, 30]),
    endTimes: new Float32Array([15, 25, 35]),
    timeOffset: 1_000_000,
    numericProps: {
      speed: new Float32Array([1.5, 2.5, 3.5]),
    },
    categoricalProps: {
      kind: {
        indices: new Uint16Array([1, 0, 0xffff]),
        categories: ['car', 'bus'],
      },
    },
    ...overrides,
  };
}

describe('getFeatureProperties', () => {
  it('decodes numeric + categorical columns and the reserved columns', () => {
    const props = getFeatureProperties(makeFeatures(), 0)!;
    expect(props).toEqual({
      id: 7,
      start_time: 1_000_010,
      end_time: 1_000_015,
      speed: 1.5,
      kind: 'bus',
    });
  });

  it('decodes the categorical null sentinel (0xffff) to null', () => {
    const props = getFeatureProperties(makeFeatures(), 2)!;
    expect(props.kind).toBeNull();
    expect(props.speed).toBe(3.5);
  });

  it('prefers the full 64-bit id when the archive carried one (H3 cells)', () => {
    const big = (1n << 40n) | 5n; // does not fit in 32 bits
    const features = makeFeatures({
      featureIds64: new BigUint64Array([big, 2n, 3n]),
    });
    expect(getFeatureProperties(features, 0)!.id).toBe(big);
  });

  it('returns null for out-of-range or non-integer indices', () => {
    const features = makeFeatures();
    expect(getFeatureProperties(features, -1)).toBeNull();
    expect(getFeatureProperties(features, 3)).toBeNull();
    expect(getFeatureProperties(features, 1.5)).toBeNull();
  });
});
