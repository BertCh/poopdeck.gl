/**
 * FlowCorridorLayer trailing persistence (`persistenceMs`).
 *
 * Generators bin a trip's whole route into its START bucket, so the default
 * two-bucket blend fades a corridor's highlight one bucket after departure —
 * long before the moving-heads overlay finishes the ride (bixi-live: 5-min
 * buckets vs 10–30-min rides). `persistenceMs` holds each vertex at the MAX of
 * the bucket signal over the trailing window [t − persistenceMs, t]: rise over
 * one bucket, HOLD for the window, fade over one bucket.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@deck.gl/layers', () => {
  class Fake {
    props: Record<string, any>;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { PathLayer: Fake, ScatterplotLayer: Fake, SolidPolygonLayer: Fake };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { ...core, Layer: FakeLayer, project32: { name: 'project32' } };
});

import { FlowCorridorLayer } from '../src/layers/trips/flow-corridor-layer';
import {
  bucketBlendAt,
  blendMatrixRow,
  trailingMaxMatrixRow,
} from '../src/lib/vertex-value-blend';

describe('trailingMaxMatrixRow', () => {
  // One row, 8 buckets, a single trip-start impulse at bucket 2.
  const NB = 8;
  const impulse = Float32Array.from([0, 0, 5, 0, 0, 0, 0, 0]);

  it('degenerates to the plain blend when the window is empty (lo === hi)', () => {
    for (const pos of [0, 1.5, 2, 2.5, 6]) {
      expect(trailingMaxMatrixRow(impulse, 0, NB, pos, pos)).toBe(
        blendMatrixRow(impulse, 0, bucketBlendAt(pos, NB)),
      );
    }
  });

  it('HOLDS the peak while the impulse bucket is inside the trailing window', () => {
    // Window of 3 buckets: for hi anywhere in [2, 5] the impulse stays lit.
    for (const hi of [2, 3, 4.5, 5]) {
      expect(trailingMaxMatrixRow(impulse, 0, NB, hi - 3, hi)).toBe(5);
    }
  });

  it('fades linearly over one bucket as the impulse slides out of the window', () => {
    // lo = hi − 3 crosses bucket 2 during hi ∈ (5, 6): the tail endpoint reads
    // the blend s(lo) between buckets 2 and 3.
    expect(trailingMaxMatrixRow(impulse, 0, NB, 2.5, 5.5)).toBeCloseTo(2.5);
    expect(trailingMaxMatrixRow(impulse, 0, NB, 3, 6)).toBe(0);
  });

  it('rises over one bucket as the playhead approaches the impulse (no lead)', () => {
    // hi ∈ (1, 2): the head endpoint dominates — same ramp as the plain blend,
    // so persistence never lights a corridor BEFORE its trips start.
    expect(trailingMaxMatrixRow(impulse, 0, NB, 0, 1.5)).toBeCloseTo(2.5);
    expect(trailingMaxMatrixRow(impulse, 0, NB, 0, 1)).toBe(0);
  });

  it('takes the largest of multiple peaks in the window', () => {
    const row = Float32Array.from([0, 2, 0, 7, 0, 3, 0, 0]);
    expect(trailingMaxMatrixRow(row, 0, NB, 1, 5)).toBe(7);
  });

  it('compares magnitudes under `absolute` (signed matrices)', () => {
    const row = Float32Array.from([0, 0, -5, 0, 3, 0, 0, 0]);
    expect(trailingMaxMatrixRow(row, 0, NB, 2, 5, true)).toBe(5);
  });

  it('respects rowBase for flattened multi-row matrices', () => {
    const two = Float32Array.from([
      ...Float32Array.from([0, 0, 5, 0, 0, 0, 0, 0]),
      ...Float32Array.from([0, 0, 0, 0, 0, 0, 3, 0]),
    ]);
    expect(trailingMaxMatrixRow(two, 0, NB, 2, 5)).toBe(5);
    expect(trailingMaxMatrixRow(two, NB, NB, 2, 5)).toBe(0);
  });
});

/**
 * A bare FlowCorridorLayer over a 2-vertex × 8-bucket matrix tile (1-second
 * buckets). Object.create skips the deck constructor; gradientValuesFor only
 * touches props/getCurrentTime and the per-tile matrix axis.
 */
function bareLayer(props: Record<string, any>, timeMs: number) {
  const layer: any = Object.create(FlowCorridorLayer.prototype);
  layer.props = props;
  layer.getCurrentTime = () => timeMs;
  return layer;
}

const TILE = {
  vertexValueBuckets: 8,
  // vertex 0: ride starts in bucket 2; vertex 1: ride starts in bucket 6.
  vertexValueMatrix: Float32Array.from([
    ...[0, 0, 5, 0, 0, 0, 0, 0],
    ...[0, 0, 0, 0, 0, 0, 3, 0],
  ]),
  startTimes: [0],
  endTimes: [8000],
  timeOffset: 0,
} as any;

describe('FlowCorridorLayer persistenceMs', () => {
  it('default (0) keeps the instantaneous two-bucket blend', () => {
    const layer = bareLayer({ persistenceMs: 0 }, 5000); // pos 5
    const out = layer.gradientValuesFor(TILE, 2)!;
    expect(Array.from(out)).toEqual([0, 0]); // both impulses outside buckets 5/6 blend at f=0
  });

  it('holds a start-bucket highlight for the trailing window', () => {
    const layer = bareLayer({ persistenceMs: 3000 }, 5000); // window [2, 5]
    const out = layer.gradientValuesFor(TILE, 2)!;
    expect(out[0]).toBe(5); // bucket-2 ride still lit 3 buckets later
    expect(out[1]).toBe(0); // bucket-6 ride has not started
  });

  it('fades the highlight once the window slides past the start bucket', () => {
    const layer = bareLayer({ persistenceMs: 3000 }, 5500); // window [2.5, 5.5]
    const out = layer.gradientValuesFor(TILE, 2)!;
    expect(out[0]).toBeCloseTo(2.5);
  });

  it('holds |value| under signedFlow (per-bucket direction matrices)', () => {
    const signedTile = {
      ...TILE,
      vertexValueMatrix: Float32Array.from([
        ...[0, 0, -5, 0, 0, 0, 0, 0],
        ...[0, 0, 0, 0, 0, 0, -3, 0],
      ]),
    };
    const layer = bareLayer({ persistenceMs: 3000, signedFlow: true }, 5000);
    const out = layer.gradientValuesFor(signedTile, 2)!;
    expect(out[0]).toBe(5);
  });
});
