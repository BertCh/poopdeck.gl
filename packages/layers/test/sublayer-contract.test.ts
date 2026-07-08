/**
 * CompositeLayer sublayer contract (audit item 8, sections B1 + B5).
 *
 * Pins the four behaviours that make the layer family feel like stock
 * deck.gl composites:
 *
 * 1. **getSubLayerProps inheritance** — composite-level `coordinateSystem`,
 *    `modelMatrix`, `autoHighlight`, `highlightColor`, `opacity`, … reach
 *    every sublayer's props, and a change to them invalidates the cached
 *    sublayer instances (the hand-rolled digests must cover the inherited
 *    surface or stale sublayers keep rendering with old values).
 * 2. **User `updateTriggers` honored** — bumping any trigger invalidates the
 *    cached prepared tiles + sublayers, and the triggers are forwarded into
 *    sublayer props; equal-content triggers in a fresh object do NOT thrash
 *    the cache.
 * 3. **`_subLayerProps`** — per-short-id `type` substitution swaps the
 *    rendered sublayer class (the CompositeLayer-native renderSubLayers-style
 *    override point) and styling overrides ride through; a `_subLayerProps`
 *    change invalidates cached sublayers.
 * 4. **Accessor-named aliases (B1)** — `getFillColor`/`getRadius`/`getColor`/
 *    `getWidth`/`getElevation`/`getWeight` accept the legacy constant-or-
 *    column-name domain, win over the legacy prop when set, and a function
 *    accessor warns once + falls back instead of crashing.
 *
 * Short ids under test: points / paths / trips / polygons / head / trail /
 * heatmap / hexagons.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { latLngToCell, h3IndexToSplitLong } from 'h3-js';
import { makePointTile, makePathTile, makePolygonTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakePathLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeSolidPolygonLayer implements CapturedLayer {
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
// contract — see fake-deck-core.ts. Extended here with the base `Layer` +
// `project32` exports that custom sublayers import.
vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer<P = any> {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return {
    ...core,
    Layer: FakeLayer,
    project32: { name: 'project32' },
  };
});

vi.mock('@deck.gl/geo-layers', () => {
  class FakeH3HexagonLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { H3HexagonLayer: FakeH3HexagonLayer };
});

vi.mock('@deck.gl/aggregation-layers', () => {
  class FakeDeckHeatmapLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { HeatmapLayer: FakeDeckHeatmapLayer };
});

vi.mock('@deck.gl/extensions', () => {
  class FakeDataFilterExtension {
    constructor(_opts?: any) {}
  }
  return { DataFilterExtension: FakeDataFilterExtension };
});

// SplatLayer's custom-Model primitive imports luma (no GPU here) — swap it for a
// prop-stashing stand-in so SplatLayer's prepare/build path runs without GPU.
vi.mock('../src/layers/internal/splat-primitive-layer', () => {
  class FakeSplatPrimitiveLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { SplatPrimitiveLayer: FakeSplatPrimitiveLayer };
});

/** A sublayer class for `_subLayerProps.<id>.type` substitution tests. */
class SwappedLayer implements CapturedLayer {
  props: Record<string, any>;
  constructor(props: Record<string, any>) {
    this.props = props;
  }
}

// ---------------------------------------------------------------------------
// Layer factories (Object.create harness — same pattern as the sibling suites)
// ---------------------------------------------------------------------------

function basePointTile() {
  const tile = makePointTile({
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    startTimes: [0, 1, 2],
    endTimes: [1, 2, 3],
    timeOffset: 0,
  });
  tile.layers[0].features.numericProps['mag'] = new Float32Array([
    1, 2, 3,
  ]) as any;
  tile.layers[0].features.categoricalProps['kind'] = {
    indices: new Uint16Array([0, 1, 0]),
    categories: ['a', 'b'],
  } as any;
  return tile;
}

function basePathTile() {
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
  tile.layers[0].features.numericProps['speed'] = new Float32Array([
    4, 8,
  ]) as any;
  tile.layers[0].features.categoricalProps['kind'] = {
    indices: new Uint16Array([0, 1]),
    categories: ['a', 'b'],
  } as any;
  return tile;
}

async function makePointLayer(props: Record<string, any> = {}) {
  const { AnimatedPointLayer } =
    await import('../src/layers/core/animated-point-layer');
  const layer: any = Object.create((AnimatedPointLayer as any).prototype);
  layer.props = {
    id: 'pts',
    fillColor: [255, 128, 0, 255],
    radius: 5,
    radiusUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
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

async function makePathLayer(props: Record<string, any> = {}) {
  const { AnimatedPathLayer } =
    await import('../src/layers/core/animated-path-layer');
  const layer: any = Object.create((AnimatedPathLayer as any).prototype);
  layer.props = {
    id: 'paths',
    pathColor: [0, 150, 255, 255],
    pathWidth: 3,
    widthUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
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

async function makeTripsLayer(props: Record<string, any> = {}) {
  const { AnimatedTripsLayer } =
    await import('../src/layers/trips/animated-trips-layer');
  const layer: any = Object.create((AnimatedTripsLayer as any).prototype);
  layer.props = {
    id: 'trips',
    tripColor: [253, 128, 93, 255],
    tripWidth: 2,
    timeWindow: 1000,
    trailLength: 500,
    opacity: 1,
    visible: true,
    ...props,
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

async function makePolygonLayer(props: Record<string, any> = {}) {
  const { AnimatedPolygonLayer } =
    await import('../src/layers/core/animated-polygon-layer');
  const layer: any = Object.create((AnimatedPolygonLayer as any).prototype);
  layer.props = {
    id: 'poly',
    fillColor: [255, 140, 0, 180],
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    filled: true,
    extruded: false,
    elevation: 0,
    ...props,
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

async function makeHeadsLayer(props: Record<string, any> = {}) {
  const { AnimatedTripHeadsLayer } =
    await import('../src/layers/trips/animated-trip-heads-layer');
  const layer: any = Object.create((AnimatedTripHeadsLayer as any).prototype);
  layer.props = {
    id: 'heads',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    headColor: [253, 128, 93, 255],
    sizeUnits: 'pixels',
    headRadiusPixels: 4,
    headRadius: 0,
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 1e9,
    ...props,
  };
  layer._currentTime = 50; // mid-trip for basePathTile's [0,100] windows
  layer.preparedTileCache = new Map();
  layer.lastTilesRef = null;
  return layer;
}

async function makeHeatmapLayer(props: Record<string, any> = {}) {
  const { AnimatedHeatmapLayer } =
    await import('../src/layers/summary/heatmap-layer');
  const layer: any = Object.create((AnimatedHeatmapLayer as any).prototype);
  layer.props = {
    id: 'hm',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer._dataFilter = {};
  layer._channelCache = new Map();
  layer._lastFilterUpdateWall = 0;
  return layer;
}

/** Summary-tier tile with real H3 cell ids packed as u64 — H3SummaryLayer input. */
function makeSummaryTile() {
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

async function makeH3Layer(props: Record<string, any> = {}) {
  const { H3SummaryLayer } =
    await import('../src/layers/summary/h3-summary-layer');
  const layer: any = Object.create((H3SummaryLayer as any).prototype);
  layer.props = {
    id: 'h3',
    weightProperty: 'count',
    colorDomain: [0, 10],
    coverage: 0.92,
    opacity: 1,
    pickable: false,
    ...props,
  };
  layer.state = {
    tiles: [makeSummaryTile()],
    metadata: { summaryTier: { layerName: 'summary', minZoom: 0, maxZoom: 4 } },
  };
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastTilesRef = null;
  layer._lastTileIdSet = new Set();
  return layer;
}

/** A surfel point tile; `dynamic` (if given) populates the `is_dynamic` column. */
function baseSurfelTile(dynamic?: number[]) {
  const n = 3;
  const tile = makePointTile({
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    startTimes: [0, 100, 200],
    endTimes: [0, 100, 200],
    timeOffset: 0,
  });
  const f = tile.layers[0].features;
  const quat = new Float32Array(n * 4);
  const scale = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    quat[i * 4 + 3] = 1;
    scale[i * 2] = 0.3;
    scale[i * 2 + 1] = 0.15;
  }
  f.vectorProps = {
    surfel_quat: { value: quat, size: 4 },
    surfel_scale: { value: scale, size: 2 },
  } as any;
  if (dynamic) f.numericProps['is_dynamic'] = new Float32Array(dynamic) as any;
  return tile;
}

async function makeSplatLayer(props: Record<string, any> = {}) {
  const { SplatLayer } = await import('../src/layers/core/splat-layer');
  const layer: any = Object.create((SplatLayer as any).prototype);
  layer.props = {
    id: 'splat',
    quaternionColumn: 'surfel_quat',
    scaleColumn: 'surfel_scale',
    colorColumn: null,
    elevationProperty: 'z',
    elevationScale: 1,
    fallbackColor: [200, 205, 215, 255],
    temporalSigma: 180,
    cumulative: false,
    revealFade: 0,
    temporalSigmaDynamic: 0,
    sizeScale: 1,
    gaussianFalloff: 3,
    alphaCutoff: 0.04,
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer.boundGetTime = () => 0;
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  layer.lastTilesRef = null;
  return layer;
}

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 1. getSubLayerProps inheritance
// ---------------------------------------------------------------------------

describe('getSubLayerProps inheritance (composite props reach sublayers)', () => {
  const MODEL_MATRIX = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];

  it('AnimatedPointLayer: coordinateSystem/modelMatrix/autoHighlight/highlightColor inherit', async () => {
    const layer = await makePointLayer({
      coordinateSystem: 2,
      modelMatrix: MODEL_MATRIX,
      autoHighlight: true,
      highlightColor: [0, 255, 0, 128],
      opacity: 0.4,
      pickable: true,
    });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect(sub.props.coordinateSystem).toBe(2);
    expect(sub.props.modelMatrix).toBe(MODEL_MATRIX);
    expect(sub.props.autoHighlight).toBe(true);
    expect(sub.props.highlightColor).toEqual([0, 255, 0, 128]);
    expect(sub.props.opacity).toBe(0.4);
    expect(sub.props.pickable).toBe(true);
    // Per-tile sublayer ids stay unique and stable: parent-shortId-tileKey.
    expect(sub.props.id).toBe('pts-points-0/0/0/0:layer0');
  });

  it('AnimatedPointLayer: a coordinateSystem change invalidates cached sublayers', async () => {
    const layer = await makePointLayer({ coordinateSystem: 1 });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    // Unchanged props → the SAME cached instance (the perf invariant).
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props.coordinateSystem = 2;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.coordinateSystem).toBe(2);
  });

  it('AnimatedTripsLayer: inherits wrapLongitude but keeps its explicit positionFormat', async () => {
    const layer = await makeTripsLayer({
      wrapLongitude: true,
      positionFormat: 'XYZ',
    });
    const tile = basePathTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.wrapLongitude).toBe(true);
    // sublayerProps beat inheritance: 2D tiles MUST stay 'XY' even though the
    // composite's positionFormat would inherit as 'XYZ'.
    expect(sub.props.positionFormat).toBe('XY');
  });

  it('AnimatedPolygonLayer: inherits coordinateSystem into SolidPolygonLayer sublayers', async () => {
    const layer = await makePolygonLayer({ coordinateSystem: 3 });
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
      endTimes: [100],
      timeOffset: 0,
    });
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.coordinateSystem).toBe(3);
  });

  it('AnimatedTripHeadsLayer: inherits coordinateSystem but forces pickable:false (active-only buffer)', async () => {
    const layer = await makeHeadsLayer({ coordinateSystem: 3, pickable: true });
    const tile = basePathTile();
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect(sub.props.coordinateSystem).toBe(3);
    expect(sub.props.pickable).toBe(false);
  });

  it('HeatmapLayer: inherits modelMatrix into channel sublayers, forces pickable:false', async () => {
    const layer = await makeHeatmapLayer({
      modelMatrix: MODEL_MATRIX,
      pickable: true,
    });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect(sub.props.modelMatrix).toBe(MODEL_MATRIX);
    expect(sub.props.pickable).toBe(false);
  });

  it('H3SummaryLayer: inherits coordinateSystem into H3HexagonLayer sublayers', async () => {
    const layer = await makeH3Layer({ coordinateSystem: 7 });
    const [sub] = layer.renderLayers();
    expect(sub.props.coordinateSystem).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 2. User updateTriggers honored
// ---------------------------------------------------------------------------

describe('user updateTriggers invalidate caches and forward into sublayers', () => {
  it('AnimatedPointLayer: a trigger bump rebuilds the prepared tile AND the sublayer', async () => {
    const layer = await makePointLayer({
      updateTriggers: { getFillColor: 1 },
    });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    const firstPrepared = layer.preparedTileCache.values().next().value;

    layer.props.updateTriggers = { getFillColor: 2 };
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(layer.preparedTileCache.values().next().value).not.toBe(
      firstPrepared,
    );
    // Forwarding: the merged updateTriggers reach the sublayer props.
    expect(second.props.updateTriggers.getFillColor).toBe(2);
  });

  it('AnimatedPointLayer: equal-content triggers in a fresh object do NOT thrash the cache', async () => {
    const layer = await makePointLayer({
      updateTriggers: { getFillColor: [1, 'a'] },
    });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    // Fresh object, same content — content digest keeps the cache hit.
    layer.props.updateTriggers = { getFillColor: [1, 'a'] };
    expect(layer.renderLayers()[0]).toBe(first);
  });

  it('AnimatedPathLayer: a trigger bump produces a new prepared styleKey', async () => {
    const layer = await makePathLayer({ updateTriggers: { getColor: 'v1' } });
    const tile = basePathTile();
    const first = layer.prepareTile(tile, tile.layers[0]);
    layer.props.updateTriggers = { getColor: 'v2' };
    const second = layer.prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect(second).not.toBe(first);
  });

  it('AnimatedTripsLayer: a trigger bump rebuilds the cached sublayer', async () => {
    const layer = await makeTripsLayer();
    const tile = basePathTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    layer.props.updateTriggers = { getColor: Date.now() };
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
  });

  it('AnimatedPolygonLayer: a trigger bump rebuilds the cached sublayer', async () => {
    const layer = await makePolygonLayer();
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
      endTimes: [100],
      timeOffset: 0,
    });
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    layer.props.updateTriggers = { getFillColor: 'bump' };
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
  });

  it('AnimatedTripHeadsLayer: emits interpolated active heads and culls inactive trips', async () => {
    const layer = await makeHeadsLayer();
    const tile = basePathTile();
    layer.state = { tiles: [tile] };
    // Mid-trip: both trips active → one ScatterplotLayer with 2 heads at the
    // segment midpoints (2-vertex paths, linear in time over [0,100]).
    layer._currentTime = 50;
    const [sub] = layer.renderLayers();
    expect(sub.props.data.length).toBe(2);
    const pos = sub.props.data.attributes.getPosition.value;
    expect(pos[0]).toBeCloseTo(0.5);
    expect(pos[1]).toBeCloseTo(0.5);
    expect(pos[3]).toBeCloseTo(2.5);
    expect(pos[4]).toBeCloseTo(2.5);
    // Past both trips' end → no active heads → no sublayer emitted.
    layer._currentTime = 200;
    expect(layer.renderLayers().length).toBe(0);
  });

  it('HeatmapLayer: a trigger bump re-consolidates the channel buffers', async () => {
    const layer = await makeHeatmapLayer();
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    layer.props.updateTriggers = { getWeight: 2 };
    const [second] = layer.renderLayers();
    expect(second.props.data).not.toBe(first.props.data);
    expect(second.props.updateTriggers.getWeight).toBe(2);
  });

  it('H3SummaryLayer: user triggers merge into the computed accessor triggers', async () => {
    const layer = await makeH3Layer({
      updateTriggers: { getFillColor: 'user-v1' },
    });
    const [first] = layer.renderLayers();
    expect(first.props.updateTriggers.getFillColor).toContain('user-v1');

    layer.props.updateTriggers = { getFillColor: 'user-v2' };
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.updateTriggers.getFillColor).toContain('user-v2');
  });
});

// ---------------------------------------------------------------------------
// 3. _subLayerProps: type substitution + styling overrides
// ---------------------------------------------------------------------------

describe('_subLayerProps overrides (renderSubLayers-style override point)', () => {
  it('AnimatedPointLayer: { points: { type } } swaps the sublayer class; styling rides through', async () => {
    const layer = await makePointLayer({
      _subLayerProps: { points: { type: SwappedLayer, radiusScale: 99 } },
    });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect(sub).toBeInstanceOf(SwappedLayer);
    expect(sub.props.radiusScale).toBe(99);
    // Non-overridden props still arrive.
    expect(sub.props.data.length).toBe(3);
  });

  it('AnimatedPointLayer: a styling-only override (no type) reaches the stock sublayer', async () => {
    const { ScatterplotLayer } = await import('@deck.gl/layers');
    const layer = await makePointLayer({
      opacity: 1,
      _subLayerProps: { points: { opacity: 0.25 } },
    });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect(sub).toBeInstanceOf(ScatterplotLayer as any);
    // User override beats both the inherited opacity and our sublayerProps.
    expect(sub.props.opacity).toBe(0.25);
  });

  it('AnimatedPointLayer: a _subLayerProps change invalidates cached sublayers', async () => {
    const layer = await makePointLayer();
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    layer.props._subLayerProps = { points: { opacity: 0.5 } };
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.opacity).toBe(0.5);
  });

  it('AnimatedPathLayer: { paths: { type } } swaps the class (non-pickable default path)', async () => {
    const layer = await makePathLayer({
      _subLayerProps: { paths: { type: SwappedLayer } },
    });
    const tile = basePathTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub).toBeInstanceOf(SwappedLayer);
  });

  it('HeatmapLayer: { heatmap: { type } } swaps the channel sublayer class', async () => {
    const layer = await makeHeatmapLayer({
      _subLayerProps: { heatmap: { type: SwappedLayer } },
    });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect(sub).toBeInstanceOf(SwappedLayer);
  });

  it('H3SummaryLayer: { hexagons: { type } } swaps the sublayer class', async () => {
    const layer = await makeH3Layer({
      _subLayerProps: { hexagons: { type: SwappedLayer } },
    });
    const [sub] = layer.renderLayers();
    expect(sub).toBeInstanceOf(SwappedLayer);
  });
});

// ---------------------------------------------------------------------------
// 4. Accessor-named aliases (B1)
// ---------------------------------------------------------------------------

describe('accessor-named prop aliases (column-name semantics)', () => {
  it('AnimatedPointLayer: getFillColor constant wins over fillColor', async () => {
    const layer = await makePointLayer({
      fillColor: [1, 1, 1, 255],
      getFillColor: [9, 9, 9, 255],
    });
    const tile = basePointTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.getFillColor).toEqual([9, 9, 9, 255]);
  });

  it('AnimatedPointLayer: getFillColor accepts a column name (categorical GPU path)', async () => {
    const layer = await makePointLayer({ getFillColor: 'kind' });
    const tile = basePointTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.instanceCategoryIndex).toBeDefined();
    expect(prepared.gpuPalette).not.toBeNull();
  });

  it('AnimatedPointLayer: getRadius accepts a column name (per-feature radius buffer)', async () => {
    const layer = await makePointLayer({ getRadius: 'mag' });
    const tile = basePointTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.getRadius).toBeDefined();
    expect([...prepared.data.attributes.getRadius.value]).toEqual([1, 2, 3]);
  });

  it('AnimatedPointLayer: legacy props alone still work (no alias set)', async () => {
    const layer = await makePointLayer({
      fillColor: [7, 7, 7, 255],
      radius: 11,
    });
    const tile = basePointTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.getFillColor).toEqual([7, 7, 7, 255]);
    expect(sub.props.getRadius).toBe(11);
  });

  it('AnimatedPointLayer: getLineColor wins over strokeColor', async () => {
    const layer = await makePointLayer({
      strokeColor: [1, 1, 1, 255],
      getLineColor: [4, 5, 6, 255],
    });
    const tile = basePointTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.getLineColor).toEqual([4, 5, 6, 255]);
  });

  it('AnimatedPointLayer: a function accessor warns once and falls back to the legacy prop', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePointLayer({
        fillColor: [1, 1, 1, 255],
        getFillColor: () => [255, 0, 0, 255],
      });
      const tile = basePointTile();
      const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
      // Fallback: the legacy constant, not a crash, not the function.
      expect(sub.props.getFillColor).toEqual([1, 1, 1, 255]);
      const accessorWarnings = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('function accessor'),
      );
      expect(accessorWarnings.length).toBe(1); // warnOnce — repeated resolution stays quiet
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('AnimatedPathLayer: getWidth constant wins over pathWidth; getColor column expands per-vertex', async () => {
    const layer = await makePathLayer({
      pathWidth: 3,
      getWidth: 12,
      getColor: 'kind',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
      ],
    });
    const tile = basePathTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const sub = layer.buildSublayer(prepared);
    expect(sub.props.getWidth).toBe(12);
    // Categorical color now expands PER-VERTEX into `getColor` (not a per-feature
    // `instanceCategoryIndex`, which under-sizes the instanced draw on
    // multi-vertex paths — "vertex buffer is not big enough" on strict ANGLE).
    expect(prepared.data.attributes.getColor).toBeDefined();
    expect([...prepared.data.attributes.getColor.value.slice(0, 4)]).toEqual([
      10, 20, 30, 255,
    ]);
    expect(prepared.data.attributes.instanceCategoryIndex).toBeUndefined();
  });

  it('AnimatedTripsLayer: getColor AND getWidth columns expand per-vertex', async () => {
    const layer = await makeTripsLayer({
      getColor: 'kind',
      getWidth: 'speed',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
      ],
    });
    const tile = basePathTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.getColor).toBeDefined();
    expect([...prepared.data.attributes.getColor.value.slice(0, 4)]).toEqual([
      10, 20, 30, 255,
    ]);
    // getWidth must be PER-VERTEX (totalVerts=4), not the per-feature `speed`
    // column (length 2). PathLayer's binary path binds the size-1 buffer
    // directly, so a featureCount-length buffer under-sizes the instanced draw
    // ("vertex buffer is not big enough"). Each feature's speed splats onto its
    // own vertices: features [4,8] over 2+2 verts → [4,4,8,8].
    const speed = tile.layers[0].features.numericProps['speed'];
    const totalVerts =
      tile.layers[0].features.startIndices[
        tile.layers[0].features.featureCount
      ];
    expect(prepared.data.attributes.getWidth.value.length).toBe(totalVerts);
    expect(Array.from(prepared.data.attributes.getWidth.value)).toEqual([
      4, 4, 8, 8,
    ]);
    // Not the zero-copy per-feature buffer.
    expect(prepared.data.attributes.getWidth.value).not.toBe(speed);
  });

  it('AnimatedPolygonLayer: getElevation column expands per-vertex; constant feeds extrusion', async () => {
    const tile = makePolygonTile({
      polygons: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
        [
          [2, 2],
          [3, 2],
          [3, 3],
          [2, 2],
        ],
      ],
      startTimes: [0, 0],
      endTimes: [100, 100],
      timeOffset: 0,
    });
    tile.layers[0].features.numericProps['height'] = new Float32Array([
      10, 20,
    ]) as any;

    const columnLayer = await makePolygonLayer({
      getElevation: 'height',
      extruded: true,
    });
    const prepared = columnLayer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.getElevation).toBeDefined();
    expect(prepared.data.attributes.getElevation.value[0]).toBe(10);

    const constLayer = await makePolygonLayer({
      getElevation: 44,
      extruded: true,
      elevation: 7,
    });
    const sub = constLayer.buildSublayer(
      constLayer.prepareTile(tile, tile.layers[0]),
    );
    expect(sub.props.getElevation).toBe(44); // alias beats legacy `elevation`
  });

  it('HeatmapLayer: getWeight column wins over weightProperty', async () => {
    const tile = basePointTile();
    tile.layers[0].features.numericProps['fare'] = new Float32Array([
      2, 4, 6,
    ]) as any;
    const layer = await makeHeatmapLayer({
      weightProperty: 'mag',
      getWeight: 'fare',
    });
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect([...sub.props.data.attributes.getWeight.value]).toEqual([2, 4, 6]);
  });

  it('HeatmapLayer: a function getWeight warns and falls back to weightProperty', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tile = basePointTile();
      const layer = await makeHeatmapLayer({
        weightProperty: 'mag',
        getWeight: () => 1,
      });
      layer.state = { tiles: [tile] };
      const [sub] = layer.renderLayers();
      expect([...sub.props.data.attributes.getWeight.value]).toEqual([1, 2, 3]); // 'mag'
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes('function accessor'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('alias changes invalidate the caches like legacy-prop changes', async () => {
    const layer = await makePointLayer({ getRadius: 4 });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    layer.props.getRadius = 9;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.getRadius).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// SplatLayer Worldbuild contract (props inheritance + graceful is_dynamic degrade)
// ---------------------------------------------------------------------------

describe('SplatLayer Worldbuild sublayer contract', () => {
  it('inherits composite props AND forwards the worldbuild props into the splat sublayer', async () => {
    const layer = await makeSplatLayer({
      coordinateSystem: 2,
      opacity: 0.6,
      pickable: true,
      cumulative: true,
      revealFade: 900,
      temporalSigmaDynamic: 250,
    });
    const tile = baseSurfelTile([0, 1, 0]);
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    // Composite inheritance still flows through composeSubLayerProps.
    expect(sub.props.coordinateSystem).toBe(2);
    expect(sub.props.opacity).toBe(0.6);
    expect(sub.props.pickable).toBe(true);
    // Worldbuild props reach the primitive.
    expect(sub.props.cumulative).toBe(true);
    expect(sub.props.revealFade).toBe(900);
    expect(sub.props.temporalSigmaDynamic).toBe(250);
    // Per-tile sublayer id stays parent-shortId-tileKey.
    expect(sub.props.id).toBe('splat-splats-0/0/0/0:layer0');
    // The dynamic flag was baked.
    expect([...sub.props.data.attributes.instanceIsDynamic.value]).toEqual([
      0, 1, 0,
    ]);
  });

  it('a worldbuild prop change invalidates the cached splat sublayer', async () => {
    const layer = await makeSplatLayer({ cumulative: true, revealFade: 0 });
    const tile = baseSurfelTile([1, 0, 1]);
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first); // unchanged props → same instance
    layer.props.revealFade = 1500;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.revealFade).toBe(1500);
  });
});
