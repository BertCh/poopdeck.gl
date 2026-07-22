/**
 * FlowStrokeLayer — breathing per-PATH width + twin-ribbon offset on top of
 * FlowCorridorLayer's per-vertex × per-bucket matrix decode.
 *
 * Exercises the real `widthsFor` (per-path active-bucket peak ** widthExponent,
 * 0 below minFlow) and the offset hooks via the Object.create harness shared by
 * the sibling trips-family suites. The GPU sublayers / deck core / extensions are
 * mocked so no luma shader loads.
 */

import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import type { BinaryFeatures } from '@poopdeck.gl/core';

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

vi.mock('@deck.gl/extensions', () => {
  class FakePathStyleExtension {
    opts: any;
    constructor(opts?: any) {
      this.opts = opts;
    }
  }
  return {
    PathStyleExtension: FakePathStyleExtension,
    DataFilterExtension: class {},
  };
});

import { FlowStrokeLayer } from '../src/layers/trips/flow-stroke-layer';

const MS_PER_BUCKET = 1000;

/**
 * One corridor feature with `peakPerBucket[b]` as its busiest-vertex value in
 * bucket `b`. Three vertices; vertex 1 carries the peak, the endpoints half it,
 * so `widthsFor`'s per-path max reduction must pick the peak.
 */
function corridorTile(peakPerBucket: number[]): BinaryFeatures {
  const nb = peakPerBucket.length;
  const nv = 3;
  const matrix = new Float32Array(nv * nb);
  for (let b = 0; b < nb; b++) {
    const peak = peakPerBucket[b];
    matrix[b] = peak / 2; // vertex 0
    matrix[nb + b] = peak; // vertex 1
    matrix[2 * nb + b] = peak / 2; // vertex 2
  }
  return {
    featureCount: 1,
    geometryType: 1 as any,
    positionDimensions: 2,
    positions: new Float64Array(nv * 2),
    startIndices: new Uint32Array([0, nv]),
    featureIds: new Uint32Array(1),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([nb * MS_PER_BUCKET]),
    timeOffset: 0,
    vertexValueMatrix: matrix,
    vertexValueBuckets: nb,
    numericProps: {},
    categoricalProps: {},
  } as any;
}

function strokeLayer(props: Record<string, any>, timeMs: number) {
  const layer: any = Object.create(FlowStrokeLayer.prototype);
  layer.props = props;
  layer.getCurrentTime = () => timeMs;
  return layer;
}

describe('FlowStrokeLayer.widthsFor (breathing + tapering width)', () => {
  // corridorTile puts the peak on the MIDDLE vertex (v1) and half on the ends
  // (v0,v2), so widthsFor must return a PER-VERTEX buffer (length totalVerts=3)
  // that tapers — NOT a single per-feature value.
  it('is per-vertex at the active bucket (exponent 1 = identity)', () => {
    const binary = corridorTile([100, 9]); // bucket0 busy, bucket1 quiet
    const w0 = strokeLayer({ widthExponent: 1, minFlow: 0 }, 0).widthsFor(
      binary,
      1,
    );
    expect(w0.length).toBe(3);
    expect(w0[1]).toBeCloseTo(100, 5); // peak vertex
    expect(w0[0]).toBeCloseTo(50, 5); // endpoint = half (taper)
    // Active bucket 1 (clamped at range end).
    const w1 = strokeLayer(
      { widthExponent: 1, minFlow: 0 },
      2 * MS_PER_BUCKET,
    ).widthsFor(binary, 1);
    expect(w1[1]).toBeCloseTo(9, 5);
  });

  it('√-scales by default so width is area-proportional', () => {
    const binary = corridorTile([100, 16]);
    expect(
      strokeLayer({ widthExponent: 0.5, minFlow: 0 }, 0).widthsFor(
        binary,
        1,
      )[1],
    ).toBeCloseTo(10, 5);
    expect(
      strokeLayer(
        { widthExponent: 0.5, minFlow: 0 },
        2 * MS_PER_BUCKET,
      ).widthsFor(binary, 1)[1],
    ).toBeCloseTo(4, 5);
  });

  it('collapses vertices at/under minFlow to width 0 (the pulse)', () => {
    const binary = corridorTile([100, 9]);
    const w = strokeLayer(
      { widthExponent: 1, minFlow: 10 },
      2 * MS_PER_BUCKET,
    ).widthsFor(binary, 1);
    expect(w[1]).toBe(0); // bucket1 peak 9 ≤ minFlow 10
  });

  it('returns undefined for a non-matrix tile (falls back to static width)', () => {
    const binary = {
      vertexValueBuckets: 0,
      startIndices: new Uint32Array([0, 2]),
    } as any;
    expect(
      strokeLayer({ widthExponent: 0.5, minFlow: 0 }, 0).widthsFor(binary, 1),
    ).toBeUndefined();
  });
});

describe('FlowStrokeLayer twin-ribbon offset (opt-in render-time extension)', () => {
  it('exposes a constant getOffset only when offsetWidths > 0', () => {
    expect(
      strokeLayer({ offsetWidths: 0.6 }, 0).extraTripsSubLayerProps(),
    ).toEqual({ getOffset: 0.6 });
    expect(
      strokeLayer({ offsetWidths: 0 }, 0).extraTripsSubLayerProps(),
    ).toEqual({});
  });

  it('only drops the category extension when the offset extension is active', () => {
    expect(
      strokeLayer({ offsetWidths: 0.6 }, 0).includeCategoryColorExtension(),
    ).toBe(false);
    expect(
      strokeLayer({ offsetWidths: 0 }, 0).includeCategoryColorExtension(),
    ).toBe(true);
  });
});
