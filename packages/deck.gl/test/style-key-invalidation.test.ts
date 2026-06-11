/**
 * Regression guard for the stale-render cache-key class of bugs.
 *
 * The animated layers cache per-tile prepared data keyed by a styleKey
 * digest of the style props. The keys originally under-approximated content:
 * `colorPalette` / `gradientColorRamp` were keyed by LENGTH, `colorMapping`
 * by key-count or a boolean, and `radiusTransform` appeared in no key at all
 * — so swapping a same-size palette (or the transform function) kept serving
 * stale tiles. These tests pin the content-digest behaviour: same-shape,
 * different-content props must produce a different styleKey (cache miss),
 * while identical references must keep the cache hit (reference-stable
 * prepared data is a perf invariant).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { latLngToCell, h3IndexToSplitLong } from 'h3-js';
import { makePointTile, makePathTile } from './fake-tile';

// Mocks mirror layer-data-shape.test.ts: stub deck.gl constructors/base
// classes so the @stt layers run their real prepare/build paths without a
// GPU runtime.

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakePathLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeSolidPolygonLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return {
    ScatterplotLayer: FakeScatterplotLayer,
    PathLayer: FakePathLayer,
    SolidPolygonLayer: FakeSolidPolygonLayer,
  };
});

// Shared mock reproducing the real getSubLayerProps/getSubLayerClass
// contract — see fake-deck-core.ts.
vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// H3SummaryLayer's sublayer class — stub like the other fakes so its real
// import doesn't drag the (mocked-away) core internals along.
vi.mock('@deck.gl/geo-layers', () => {
  class FakeH3HexagonLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { H3HexagonLayer: FakeH3HexagonLayer };
});

// ---------------------------------------------------------------------------
// AnimatedPointLayer
// ---------------------------------------------------------------------------

describe('AnimatedPointLayer styleKey content invalidation', () => {
  let LayerCtor: any;

  beforeEach(async () => {
    vi.resetModules();
    LayerCtor = (await import('../src/animated-point-layer')).AnimatedPointLayer as any;
  });

  function makeLayer(opts: Record<string, any> = {}) {
    const layer = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'test',
      fillColor: [255, 128, 0, 255],
      radius: 5,
      radiusUnits: 'pixels',
      timeWindow: 1000,
      opacity: 1,
      visible: true,
      ...opts,
    };
    layer._currentTime = 0;
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastLayerPropsKey = '';
    return layer;
  }

  function catTile() {
    const tile = makePointTile({
      positions: [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      startTimes: [0, 1, 2, 3],
      endTimes: [1, 2, 3, 4],
      timeOffset: 0,
    });
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 0, 1]),
      categories: ['a', 'b'],
    } as any;
    return tile;
  }

  it('invalidates on a same-length, different-content colorPalette swap', () => {
    const layer = makeLayer({
      fillColor: 'kind',
      colorPalette: [
        [1, 2, 3, 255],
        [4, 5, 6, 255],
      ],
    });
    const tile = catTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    // Same length (2), different content — the length-keyed bug served `first`.
    layer.props.colorPalette = [
      [9, 9, 9, 255],
      [4, 5, 6, 255],
    ];
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect(second).not.toBe(first);
    // The rebuilt tile carries the new palette to the GPU extension.
    expect(second.gpuPalette).toBe(layer.props.colorPalette);
  });

  it('keeps the cache hit when the palette reference is unchanged', () => {
    const layer = makeLayer({
      fillColor: 'kind',
      colorPalette: [
        [1, 2, 3, 255],
        [4, 5, 6, 255],
      ],
    });
    const tile = catTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).toBe(first);
  });

  it('invalidates on a colorMapping content change with the same key-count', () => {
    const layer = makeLayer({
      fillColor: 'kind',
      colorMapping: { a: [1, 1, 1, 255], b: [2, 2, 2, 255] },
      colorMappingDefault: [0, 0, 0, 0],
    });
    const tile = catTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    expect([...first.data.attributes.getFillColor.value.slice(0, 4)]).toEqual([1, 1, 1, 255]);

    // Same key-count (2) — the key-count/boolean-keyed bug served stale RGBA.
    layer.props.colorMapping = { a: [7, 7, 7, 255], b: [2, 2, 2, 255] };
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect([...second.data.attributes.getFillColor.value.slice(0, 4)]).toEqual([7, 7, 7, 255]);
  });

  it('invalidates when radiusTransform is swapped for a different function', () => {
    const tile = catTile();
    tile.layers[0].features.numericProps['mag'] = new Float32Array([1, 2, 3, 4]) as any;
    const layer = makeLayer({
      radius: 'mag',
      radiusTransform: (v: number) => v * 2,
    });
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    expect([...first.data.attributes.getRadius.value]).toEqual([2, 4, 6, 8]);

    // No key carried the transform at all — swapping it left stale radii.
    layer.props.radiusTransform = (v: number) => v * 10;
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect([...second.data.attributes.getRadius.value]).toEqual([10, 20, 30, 40]);
  });

  it('keeps the cache hit when the radiusTransform reference is unchanged', () => {
    const tile = catTile();
    tile.layers[0].features.numericProps['mag'] = new Float32Array([1, 2, 3, 4]) as any;
    const transform = (v: number) => v * 2;
    const layer = makeLayer({ radius: 'mag', radiusTransform: transform });
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// AnimatedPathLayer
// ---------------------------------------------------------------------------

describe('AnimatedPathLayer styleKey content invalidation', () => {
  let LayerCtor: any;

  beforeEach(async () => {
    vi.resetModules();
    LayerCtor = (await import('../src/animated-path-layer')).AnimatedPathLayer as any;
  });

  function makeLayer(opts: Record<string, any> = {}) {
    const layer = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'test',
      pathColor: [31, 186, 214, 255],
      pathWidth: 2,
      widthUnits: 'pixels',
      timeWindow: 1000,
      opacity: 1,
      visible: true,
      ...opts,
    };
    layer._currentTime = 0;
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    return layer;
  }

  function catPathTile() {
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
      startTimes: [0, 0],
      endTimes: [100, 100],
      timeOffset: 0,
    });
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1]),
      categories: ['a', 'b'],
    } as any;
    return tile;
  }

  it('invalidates on a same-length, different-content colorPalette swap', () => {
    const layer = makeLayer({
      pathColor: 'kind',
      colorPalette: [
        [1, 2, 3, 255],
        [4, 5, 6, 255],
      ],
    });
    const tile = catPathTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    layer.props.colorPalette = [
      [9, 9, 9, 255],
      [4, 5, 6, 255],
    ];
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect(second).not.toBe(first);
    expect(second.gpuPalette).toBe(layer.props.colorPalette);
  });

  it('keeps the cache hit when the palette reference is unchanged', () => {
    const palette = [
      [1, 2, 3, 255],
      [4, 5, 6, 255],
    ];
    const layer = makeLayer({ pathColor: 'kind', colorPalette: palette });
    const tile = catPathTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// AnimatedTripsLayer
// ---------------------------------------------------------------------------

describe('AnimatedTripsLayer styleKey content invalidation', () => {
  let LayerCtor: any;

  beforeEach(async () => {
    vi.resetModules();
    LayerCtor = (await import('../src/animated-trips-layer')).AnimatedTripsLayer as any;
  });

  function makeLayer(opts: Record<string, any> = {}) {
    const layer = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'trips',
      tripColor: [253, 128, 93, 255],
      tripWidth: 2,
      timeWindow: 1000,
      trailLength: 500,
      opacity: 1,
      visible: true,
      ...opts,
    };
    layer._currentTime = 0;
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastLayerPropsKey = '';
    (layer as any).getEffectiveTimeWindow = () => 1000;
    return layer;
  }

  function catTripsTile() {
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
      startTimes: [0, 0],
      endTimes: [100, 100],
      timeOffset: 0,
    });
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1]),
      categories: ['a', 'b'],
    } as any;
    return tile;
  }

  it('invalidates the CPU-expanded per-vertex colors on a same-length palette swap', () => {
    const layer = makeLayer({
      tripColor: 'kind',
      colorPalette: [
        [1, 2, 3, 255],
        [4, 5, 6, 255],
      ],
    });
    const tile = catTripsTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    expect([...first.data.attributes.getColor.value.slice(0, 4)]).toEqual([1, 2, 3, 255]);

    layer.props.colorPalette = [
      [9, 9, 9, 255],
      [4, 5, 6, 255],
    ];
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect([...second.data.attributes.getColor.value.slice(0, 4)]).toEqual([9, 9, 9, 255]);
  });

  it('invalidates on a colorMapping content change with the same key-count', () => {
    const layer = makeLayer({
      tripColor: 'kind',
      colorMapping: { a: [1, 1, 1, 255], b: [2, 2, 2, 255] },
    });
    const tile = catTripsTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    expect([...first.data.attributes.getColor.value.slice(0, 4)]).toEqual([1, 1, 1, 255]);

    layer.props.colorMapping = { a: [7, 7, 7, 255], b: [2, 2, 2, 255] };
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect([...second.data.attributes.getColor.value.slice(0, 4)]).toEqual([7, 7, 7, 255]);
  });

  it('invalidates on a same-length gradientColorRamp content swap', () => {
    const tile = catTripsTile();
    const binary = tile.layers[0].features;
    binary.vertexValues = new Float32Array([0, 30, 0, 30]) as any;
    const layer = makeLayer({
      gradientProperty: 'vertexValues',
      gradientDomain: [0, 30],
      gradientColorRamp: [
        [0, 0, 255, 255],
        [255, 0, 0, 255],
      ],
    });
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    expect([...first.data.attributes.getColor.value.slice(0, 4)]).toEqual([0, 0, 255, 255]);

    // Same length (2), different stops.
    layer.props.gradientColorRamp = [
      [0, 255, 0, 255],
      [255, 0, 0, 255],
    ];
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect([...second.data.attributes.getColor.value.slice(0, 4)]).toEqual([0, 255, 0, 255]);
  });

  it('keeps the cache hit when palette / mapping / ramp references are unchanged', () => {
    const layer = makeLayer({
      tripColor: 'kind',
      colorMapping: { a: [1, 1, 1, 255], b: [2, 2, 2, 255] },
    });
    const tile = catTripsTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// H3SummaryLayer
// ---------------------------------------------------------------------------

describe('H3SummaryLayer styleKey content invalidation', () => {
  let LayerCtor: any;

  beforeEach(async () => {
    vi.resetModules();
    LayerCtor = (await import('../src/h3-summary-layer')).H3SummaryLayer as any;
  });

  /** Summary-tier tile with real H3 cell ids packed as u64. */
  function summaryTile() {
    const cells = [latLngToCell(40.7, -74.0, 5), latLngToCell(40.8, -73.9, 5)];
    const ids = new BigUint64Array(cells.length);
    cells.forEach((cell, i) => {
      const [lo, hi] = h3IndexToSplitLong(cell);
      ids[i] = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    });
    return {
      id: { z: 2, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 0 },
      layers: [
        {
          name: 'summary',
          extent: 4096,
          features: {
            featureCount: cells.length,
            geometryType: 0,
            positionDimensions: 2,
            positions: new Float64Array(cells.length * 2),
            featureIds: new Uint32Array(cells.length),
            featureIds64: ids,
            startTimes: new Float32Array(cells.length),
            endTimes: new Float32Array(cells.length),
            timeOffset: 0,
            numericProps: { count: new Float32Array([3, 7]) },
            categoricalProps: {},
          },
          geometryExtensionName: 'geoarrow.point',
        },
      ],
    } as any;
  }

  function makeLayer(opts: Record<string, any> = {}) {
    const layer = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'h3',
      weightProperty: 'count',
      colorDomain: [0, 10],
      coverage: 0.92,
      opacity: 1,
      pickable: false,
      ...opts,
    };
    layer.state = {
      tiles: [summaryTile()],
      metadata: { summaryTier: { layerName: 'summary', minZoom: 0, maxZoom: 4 } },
    };
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastTilesRef = null;
    return layer;
  }

  it('invalidates the cached sublayer on a same-length colorRange content swap', () => {
    const layer = makeLayer({
      colorRange: [
        [1, 2, 3, 255],
        [4, 5, 6, 255],
      ],
    });
    const [first] = layer.renderLayers();
    // Same length (2), different stops — the length-keyed bug served `first`.
    layer.props.colorRange = [
      [9, 9, 9, 255],
      [4, 5, 6, 255],
    ];
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
  });

  it('keeps the cache hit when the colorRange reference is unchanged', () => {
    const layer = makeLayer({
      colorRange: [
        [1, 2, 3, 255],
        [4, 5, 6, 255],
      ],
    });
    const [first] = layer.renderLayers();
    const [second] = layer.renderLayers();
    expect(second).toBe(first);
  });
});
