/**
 * AnimatedTripsLayer — per-FEATURE `tripWidth` property expansion.
 *
 * Regression for the nwm-rivers crash: a string `tripWidth` selects a
 * per-feature numeric column (one width per corridor), but PathLayer's
 * `instanceStrokeWidths` is a per-SEGMENT-instanced attribute sized to the
 * tessellated vertex count. deck.gl's binary path binds a size-matched buffer
 * DIRECTLY, so a featureCount-length `getWidth` under-sizes the draw ("vertex
 * buffer is not big enough"). prepareTile must splat the feature scalar across
 * its vertices, exactly like the categorical-color / gradient paths.
 *
 * Drives the real private `prepareTile` via the Object.create harness shared by
 * the sibling trips-family suites; the GPU sublayers / deck core are mocked so
 * no luma shader loads.
 */

import { describe, it, expect, vi } from 'vitest';
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

import { AnimatedTripsLayer } from '../src/layers/trips/animated-trips-layer';

/**
 * Two corridors with DIFFERENT vertex counts (2 and 3 → totalVerts = 5) and a
 * per-feature `width` column. A correct expansion is length-5 with each
 * feature's width splatted onto its own vertices.
 */
function twoCorridorTile(widths: number[]): BinaryFeatures {
  // feature 0: verts [0,2), feature 1: verts [2,5)
  const startIndices = new Uint32Array([0, 2, 5]);
  const totalVerts = 5;
  return {
    featureCount: 2,
    geometryType: 1 as any,
    positionDimensions: 2,
    // Non-degenerate coords so synthesizeVertexTimes doesn't early-out.
    positions: new Float64Array([
      0,
      0,
      0.1,
      0.1, // feature 0
      1,
      1,
      1.1,
      1.1,
      1.2,
      1.2, // feature 1
    ]),
    startIndices,
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    timeOffset: 0,
    numericProps: { width: new Float32Array(widths) },
    categoricalProps: {},
  } as any;
}

function tripsLayer(props: Record<string, any>) {
  const layer: any = Object.create(AnimatedTripsLayer.prototype);
  layer.props = props;
  layer.preparedTileCache = new Map();
  layer.getCurrentTime = () => 0;
  return layer;
}

function prepare(layer: any, binary: BinaryFeatures) {
  const tileLayer = { name: 'default', features: binary };
  const tile = { id: { z: 4, x: 1, y: 2, t: 0 }, layers: [tileLayer] };
  return layer.prepareTile(tile, tileLayer);
}

describe('AnimatedTripsLayer per-feature tripWidth expansion', () => {
  it('splats a per-feature width column to one value per vertex', () => {
    const layer = tripsLayer({ tripWidth: 'width', gradientColorRamp: [] });
    const prepared = prepare(layer, twoCorridorTile([3, 7]));

    const getWidth = prepared.data.attributes.getWidth;
    expect(getWidth).toBeDefined();
    expect(getWidth.size).toBe(1);
    // Per-VERTEX (totalVerts = 5), NOT per-feature (2) — the under-size bug.
    expect(getWidth.value.length).toBe(5);
    // Feature 0's width on its 2 vertices, feature 1's on its 3.
    expect(Array.from(getWidth.value)).toEqual([3, 3, 7, 7, 7]);
  });

  it('never emits a getWidth shorter than the tessellated vertex count', () => {
    const layer = tripsLayer({ tripWidth: 'width', gradientColorRamp: [] });
    const binary = twoCorridorTile([2, 5]);
    const prepared = prepare(layer, binary);
    const totalVerts = binary.startIndices![binary.featureCount];
    expect(prepared.data.attributes.getWidth.value.length).toBe(totalVerts);
  });

  it('leaves getWidth unset when the width column is absent (constant fallback)', () => {
    const layer = tripsLayer({ tripWidth: 'width', gradientColorRamp: [] });
    const binary = twoCorridorTile([1, 1]);
    delete (binary as any).numericProps.width;
    const prepared = prepare(layer, binary);
    expect(prepared.data.attributes.getWidth).toBeUndefined();
  });
});
