/**
 * Pure-logic tests for HeatmapLayer.
 *
 * The full pipeline now delegates the GPU splat/accumulate/ramp to the
 * canonical `@deck.gl/aggregation-layers` HeatmapLayer + DataFilterExtension,
 * which needs a real WebGL2 context and is exercised by `tools/render-test`.
 * Here we verify the CPU-side data path that feeds it:
 *
 *   - `buildConsolidatedChannelData` consolidates every visible tile's splats
 *     into one binary buffer set, applies the channel's `categoryFilter`,
 *     folds the per-channel `intensity` into the weight, relativizes each
 *     point's start time against the layer-wide offset, and reads LineString
 *     tiles per-VERTEX rather than per-feature (rejecting polygons outright).
 *   - Time relativization against the layer offset preserves f32 precision for
 *     absolute Unix-ms timestamps within the documented window.
 *   - `filterRange` identity is stable across a tick that doesn't move the
 *     window, and the archive's raw-weight `heatmapDomain` never reaches deck's
 *     accumulated-units `colorDomain`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { makePathTile, makePolygonTile } from './fake-tile';
import { buildConsolidatedChannelData } from '../src/layers/summary/heatmap-layer';

// ---------------------------------------------------------------------------
// deck.gl mocks — capture the canonical sublayer's constructor props so the
// composite's renderLayers() can be driven without a WebGL2 context.
// ---------------------------------------------------------------------------

vi.mock('@deck.gl/aggregation-layers', () => {
  class FakeHeatmapLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { HeatmapLayer: FakeHeatmapLayer };
});

vi.mock('@deck.gl/extensions', () => {
  class FakeDataFilterExtension {
    opts: any;
    constructor(opts: any) {
      this.opts = opts;
    }
  }
  return { DataFilterExtension: FakeDataFilterExtension };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/**
 * `AnimatedHeatmapLayer` driven through renderLayers() directly (Object.create
 * bypasses CompositeLayer's lifecycle, as in the sibling suites).
 */
async function makeHeatmapLayer(
  props: Record<string, any> = {},
  state: Record<string, any> = {},
) {
  const { AnimatedHeatmapLayer } =
    await import('../src/layers/summary/heatmap-layer');
  const layer: any = Object.create((AnimatedHeatmapLayer as any).prototype);
  layer.props = {
    id: 'heat',
    radiusPixels: 30,
    intensity: 1,
    threshold: 0.05,
    colorRange: [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ],
    colorDomain: null,
    channels: null,
    weightProperty: null,
    getWeight: null,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    aggregation: 'SUM',
    weightsTextureSize: 2048,
    debounceTimeout: 500,
    timeWindow: 1000,
    updateTriggers: {},
    extensions: [],
    ...props,
  };
  layer.state = { tiles: [], metadata: undefined, ...state };
  layer._currentTime = 0;
  layer._channelCache = new Map();
  layer._dataFilter = {};
  layer._lastFilterUpdateWall = 0;
  layer._filterRange = null;
  layer._filterSoftRange = null;
  return layer;
}

function makeBinaryFixture(timeOffset = 1_700_000_000_000): BinaryFeatures {
  // 6 features: 3 pickup, 2 dropoff, 1 transit.
  // Positions are arbitrary lon/lat; times are relative to timeOffset.
  const positions = new Float64Array([
    -74,
    40.7, // 0
    -74.01,
    40.72, // 1
    -74.02,
    40.74, // 2
    -73.98,
    40.76, // 3
    -73.95,
    40.78, // 4
    -73.99,
    40.75, // 5
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
      {
        categoryFilter: { property: 'status', values: ['pickup'] },
        intensity: 1,
      },
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
      {
        categoryFilter: { property: 'nonexistent', values: ['x'] },
        intensity: 1,
      },
      undefined,
      1_700_000_000_000,
    );
    expect(data).toBeNull();
  });

  it('returns null when no category matches', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData(
      [tile],
      {
        categoryFilter: { property: 'status', values: ['ghost'] },
        intensity: 1,
      },
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
    const data = buildConsolidatedChannelData(
      [tile],
      { intensity: 2 },
      undefined,
      1_700_000_000_000,
    );
    expect(data!.length).toBe(6);
    // weight = (no weightProperty → 1) × intensity(2)
    expect(Array.from(data!.attributes.getWeight.value)).toEqual([
      2, 2, 2, 2, 2, 2,
    ]);
  });

  it('sources weight from weightProperty × intensity', () => {
    const tile = wrapTile(makeBinaryFixture());
    const data = buildConsolidatedChannelData(
      [tile],
      { intensity: 0.5 },
      'fare',
      1_700_000_000_000,
    );
    // fare = [10..60] × 0.5
    expect(Array.from(data!.attributes.getWeight.value)).toEqual([
      5, 10, 15, 20, 25, 30,
    ]);
  });

  it('consolidates across tiles and relativizes times against the layer offset', () => {
    const layerOffset = 1_700_000_000_000;
    // Second tile sits 1 hour later — its per-feature times must be shifted by
    // the +3_600_000 ms delta so the consolidated filter values are comparable.
    const tileA = wrapTile(makeBinaryFixture(layerOffset), 0);
    const tileB = wrapTile(makeBinaryFixture(layerOffset + 3_600_000), 1);
    const data = buildConsolidatedChannelData(
      [tileA, tileB],
      { intensity: 1 },
      undefined,
      layerOffset,
    );
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

// ---------------------------------------------------------------------------
// Geometry kinds (the consolidator used to assume points)
// ---------------------------------------------------------------------------

describe('buildConsolidatedChannelData: geometry kinds', () => {
  beforeEach(async () => {
    (await import('../src/lib/log'))._resetWarnOnce();
  });

  it('splats LineString tiles per VERTEX, not per feature', () => {
    // 2 paths × 3 vertices. `featureCount` is 2 but `positions` holds 6 points:
    // the old feature-indexed read emitted the first 2 VERTICES of path #1 and
    // called it a two-track density map.
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        [
          [10, 10],
          [11, 11],
          [12, 12],
        ],
      ],
      startTimes: [100, 500],
      endTimes: [200, 600],
      timeOffset: 0,
    });
    const data = buildConsolidatedChannelData(
      [tile],
      { intensity: 1 },
      undefined,
      0,
    );
    expect(data!.length).toBe(6);
    expect(Array.from(data!.attributes.getPosition.value)).toEqual([
      0, 0, 0, 1, 1, 0, 2, 2, 0, 10, 10, 0, 11, 11, 0, 12, 12, 0,
    ]);
    // Every vertex of a path carries that path's start time…
    expect(Array.from(data!.attributes.getFilterValue.value)).toEqual([
      100, 100, 100, 500, 500, 500,
    ]);
    // …and its weight (here the default 1).
    expect(Array.from(data!.attributes.getWeight.value)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
  });

  it('prefers per-vertex times when the archive baked vertexTimestamps', () => {
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      ],
      startTimes: [100],
      endTimes: [400],
      timeOffset: 0,
    });
    (tile.layers[0].features as any).vertexTimestamps = new Float32Array([
      100, 250, 400,
    ]);
    const data = buildConsolidatedChannelData(
      [tile],
      { intensity: 1 },
      undefined,
      0,
    );
    expect(Array.from(data!.attributes.getFilterValue.value)).toEqual([
      100, 250, 400,
    ]);
  });

  it('applies the category mask per FEATURE while counting vertices', () => {
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [10, 10],
          [11, 11],
          [12, 12],
        ],
      ],
      startTimes: [0, 0],
      endTimes: [1, 1],
      timeOffset: 0,
    });
    (tile.layers[0].features as any).categoricalProps = {
      kind: {
        indices: new Uint16Array([0, 1]),
        categories: ['ferry', 'cargo'],
      },
    };
    const data = buildConsolidatedChannelData(
      [tile],
      { intensity: 1, categoryFilter: { property: 'kind', values: ['cargo'] } },
      undefined,
      0,
    );
    // Only path #2 survives — 3 vertices, not 1 "feature".
    expect(data!.length).toBe(3);
    expect(data!.attributes.getPosition.value[0]).toBe(10);
  });

  it('relativizes path vertex times across tiles with different offsets', () => {
    const layerOffset = 1_700_000_000_000;
    const a = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      startTimes: [10],
      endTimes: [20],
      timeOffset: layerOffset,
      tileId: { z: 1, x: 0, y: 0, t: 0 },
    });
    const b = makePathTile({
      paths: [
        [
          [2, 2],
          [3, 3],
        ],
      ],
      startTimes: [10],
      endTimes: [20],
      timeOffset: layerOffset + 3_600_000,
      tileId: { z: 1, x: 1, y: 0, t: 1 },
    });
    const data = buildConsolidatedChannelData(
      [a, b],
      { intensity: 1 },
      undefined,
      layerOffset,
    );
    expect(Array.from(data!.attributes.getFilterValue.value)).toEqual([
      10, 10, 3_600_010, 3_600_010,
    ]);
  });

  it('skips polygon tiles with ONE named warning instead of mis-reading them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = makePolygonTile({
      polygons: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      startTimes: [0],
      endTimes: [1],
      timeOffset: 0,
    });
    expect(
      buildConsolidatedChannelData(
        [tile],
        { intensity: 1 },
        undefined,
        0,
        'heat',
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Polygon geometry/);
    warn.mockRestore();
  });

  it('still treats an untagged (legacy/fixture) tile as points', () => {
    const tile = wrapTile(makeBinaryFixture());
    (tile.layers[0].features as any).geometryType = undefined;
    const data = buildConsolidatedChannelData(
      [tile],
      { intensity: 1 },
      undefined,
      0,
    );
    expect(data!.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// filterRange reference stability (the TextureTransform rebuild)
// ---------------------------------------------------------------------------

describe('AnimatedHeatmapLayer: filterRange identity', () => {
  it('reuses the SAME array when a tick does not move the window', async () => {
    const layer = await makeHeatmapLayer({ timeWindow: 1000 });
    layer.state = { ...layer.state, tiles: [wrapTile(makeBinaryFixture(0))] };
    layer._currentTime = 5_000;
    const first = layer.renderLayers()[0].props.filterRange;
    expect(first).toEqual([4_500, 5_500]);
    // A second render at the same play head is what the ~30 Hz tick produces
    // between window moves. A fresh literal here read as `dataChanged` to the
    // aggregation layer, which destroys and re-links the weights
    // TextureTransform (`filterRange` is an extension prop, so it is absent
    // from HeatmapLayer._propTypes and therefore from `ignoreProps`).
    expect(layer.renderLayers()[0].props.filterRange).toBe(first);
  });

  it('hands over a FRESH array as soon as the window actually moves', async () => {
    const layer = await makeHeatmapLayer({ timeWindow: 1000 });
    layer.state = { ...layer.state, tiles: [wrapTile(makeBinaryFixture(0))] };
    layer._currentTime = 5_000;
    const first = layer.renderLayers()[0].props.filterRange;
    layer._currentTime = 6_000;
    const second = layer.renderLayers()[0].props.filterRange;
    // Re-aggregation depends on this: a stable reference would freeze the map.
    expect(second).not.toBe(first);
    expect(second).toEqual([5_500, 6_500]);
  });

  it('memoizes filterSoftRange the same way', async () => {
    const layer = await makeHeatmapLayer({
      timeWindow: 1000,
      fadeInDuration: 100,
      fadeOutDuration: 100,
    });
    layer.state = { ...layer.state, tiles: [wrapTile(makeBinaryFixture(0))] };
    layer._currentTime = 5_000;
    const first = layer.renderLayers()[0].props.filterSoftRange;
    expect(first).toEqual([4_600, 5_400]);
    expect(layer.renderLayers()[0].props.filterSoftRange).toBe(first);
    layer._currentTime = 6_000;
    expect(layer.renderLayers()[0].props.filterSoftRange).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// The units contract: archive heatmapDomain ≠ deck colorDomain
// ---------------------------------------------------------------------------

describe('AnimatedHeatmapLayer: heatmapDomain units', () => {
  const archive = (classes: any[]) => ({
    metadata: { heatmapDomain: { classes } },
  });

  /** Compare a Float32 weight buffer against exact values at f32 precision. */
  function expectF32(actual: Float32Array, expected: number[]): void {
    expect(Array.from(actual)).toEqual(expected.map((v) => Math.fround(v)));
  }

  function tileWithWeights() {
    return wrapTile(makeBinaryFixture(0));
  }

  it('never routes the archive raw-weight domain into deck colorDomain', async () => {
    const layer = await makeHeatmapLayer(
      { weightProperty: 'fare' },
      archive([{ id: 'default', min: 10, max: 50, property: 'fare' }]),
    );
    layer.state.tiles = [tileWithWeights()];
    const [sub] = layer.renderLayers();
    // colorDomain is compared against an ACCUMULATED per-texel value that deck
    // further rescales by metersPerPixel — a per-feature [min, p95] there put
    // the ramp top 10³–10⁴× above any real texel and also killed `threshold`.
    expect(sub.props.colorDomain).toBeNull();
    expect(sub.props.threshold).toBe(0.05);
  });

  it('applies it as a per-point weight scale of 1 / p95 instead', async () => {
    const layer = await makeHeatmapLayer(
      { weightProperty: 'fare' },
      archive([{ id: 'default', min: 10, max: 50, property: 'fare' }]),
    );
    layer.state.tiles = [tileWithWeights()];
    const weights =
      layer.renderLayers()[0].props.data.attributes.getWeight.value;
    // fare = [10..60] → weight = fare / 50, i.e. "how many p95 features".
    // (Float32 storage, so compare at f32 precision.)
    expectF32(weights, [0.2, 0.4, 0.6, 0.8, 1, 1.2]);
  });

  it('is a no-op without a weight column (every point already weighs 1)', async () => {
    const layer = await makeHeatmapLayer(
      {},
      archive([{ id: 'default', min: 1, max: 1 }]),
    );
    layer.state.tiles = [tileWithWeights()];
    const weights =
      layer.renderLayers()[0].props.data.attributes.getWeight.value;
    expect(Array.from(weights)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('is a no-op for a degenerate or absent domain', async () => {
    const zero = await makeHeatmapLayer(
      { weightProperty: 'fare' },
      archive([{ id: 'default', min: 0, max: 0, property: 'fare' }]),
    );
    zero.state.tiles = [tileWithWeights()];
    expect(
      Array.from(zero.renderLayers()[0].props.data.attributes.getWeight.value),
    ).toEqual([10, 20, 30, 40, 50, 60]);

    const none = await makeHeatmapLayer({ weightProperty: 'fare' });
    none.state.tiles = [tileWithWeights()];
    expect(
      Array.from(none.renderLayers()[0].props.data.attributes.getWeight.value),
    ).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('ignores (and names) a domain measured from a different column', async () => {
    (await import('../src/lib/log'))._resetWarnOnce();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeHeatmapLayer(
      { weightProperty: 'fare' },
      archive([{ id: 'default', min: 1, max: 20, property: 'speed' }]),
    );
    layer.state.tiles = [tileWithWeights()];
    const weights =
      layer.renderLayers()[0].props.data.attributes.getWeight.value;
    expect(Array.from(weights)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(String(warn.mock.calls[0][0])).toMatch(/measured from 'speed'/);
    warn.mockRestore();
  });

  it('an explicitly pinned colorDomain still passes through verbatim', async () => {
    const layer = await makeHeatmapLayer(
      { colorDomain: [0, 4], weightProperty: 'fare' },
      archive([{ id: 'default', min: 10, max: 50, property: 'fare' }]),
    );
    layer.state.tiles = [tileWithWeights()];
    expect(layer.renderLayers()[0].props.colorDomain).toEqual([0, 4]);
  });

  it('folds the channel intensity and the archive scale into one multiply', async () => {
    const layer = await makeHeatmapLayer(
      {
        weightProperty: 'fare',
        channels: [{ id: 'a', intensity: 2 }],
      },
      archive([{ id: 'a', min: 10, max: 50, property: 'fare' }]),
    );
    layer.state.tiles = [tileWithWeights()];
    const weights =
      layer.renderLayers()[0].props.data.attributes.getWeight.value;
    // fare / 50 × intensity 2.
    expectF32(weights, [0.4, 0.8, 1.2, 1.6, 2, 2.4]);
  });
});
