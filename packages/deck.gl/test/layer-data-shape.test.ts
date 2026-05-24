/**
 * Regression guard for the per-feature object allocation bug.
 *
 * A prior refactor consolidated tile data into single typed arrays but then
 * promptly built an `N`-length array of per-feature wrapper objects (with
 * inner `[x,y,z]` tuples) right before constructing the deck.gl layer. On
 * the AIS ship-traffic dataset (~1.3M points) that meant millions of object
 * allocations on every tile-set change, swamping the GC and undoing the
 * binary-tile gains.
 *
 * The fix:
 *   - Points: `data: {length: N}` — no per-feature wrapper. Accessors index
 *     into the consolidated typed arrays via `info.index`.
 *   - Paths / Trips: per-feature wrapper objects are kept (PathLayer's
 *     per-vertex accessor needs them) but `path` / `vertexTimes` are
 *     zero-copy `Float64Array`/`Float32Array` SUBARRAYS into the
 *     consolidated buffers — no `new Array(n * dims)` + per-vertex copy.
 *
 * This file exercises each layer's `createConsolidatedLayer` path with a
 * deck.gl mock that captures the constructor args, then asserts on the
 * `data` shape and accessor behaviour so future regressions surface here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile, makePathTile } from './fake-tile';

// ---------------------------------------------------------------------------
// deck.gl mocks
// ---------------------------------------------------------------------------
//
// We mock the deck.gl layer constructors before importing the @stt layers so
// `new ScatterplotLayer(props)` / `new PathLayer(props)` just stash the props
// on the returned instance. The @stt layers themselves are still real and run
// their full `createConsolidatedLayer` / `createConsolidatedPathLayer` paths.

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
  return { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer };
});

// `@deck.gl/core` is only used for `CompositeLayer` / `LayerExtension` base
// classes by the @stt layers. We stub them with empty classes so importing
// the @stt layers does not require a real deck.gl runtime / GPU.
vi.mock('@deck.gl/core', () => {
  class FakeCompositeLayer<P = any> {
    declare props: P;
    declare state: any;
    declare context: any;
    setState(_: any) {}
    setNeedsRedraw() {}
    getCurrentTime() { return 0; }
  }
  class FakeLayerExtension {}
  return {
    CompositeLayer: FakeCompositeLayer,
    LayerExtension: FakeLayerExtension,
    COORDINATE_SYSTEM: { LNGLAT: 1 },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake point tile of `n` features, all timestamped sequentially. */
function bigPointTile(n: number) {
  const positions: number[][] = new Array(n);
  const startTimes: number[] = new Array(n);
  const endTimes: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    positions[i] = [(i % 360) - 180, (i % 180) - 90];
    startTimes[i] = i;
    endTimes[i] = i + 1;
  }
  return makePointTile({ positions, startTimes, endTimes, timeOffset: 0 });
}

/** Build a fake path tile of `n` features × `v` vertices each. */
function bigPathTile(n: number, v: number) {
  const paths: number[][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ring: number[][] = new Array(v);
    for (let k = 0; k < v; k++) ring[k] = [k * 0.01, i * 0.01];
    paths[i] = ring;
  }
  const startTimes = new Array(n).fill(0);
  const endTimes = new Array(n).fill(1000);
  return makePathTile({ paths, startTimes, endTimes, timeOffset: 0 });
}

// ---------------------------------------------------------------------------
// AnimatedPointLayer
// ---------------------------------------------------------------------------

describe('AnimatedPointLayer.createConsolidatedLayer', () => {
  let buildLayer: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    // Fresh import each test so vi.mock's are applied.
    vi.resetModules();
    const mod = await import('../src/animated-point-layer');
    const LayerCtor = mod.AnimatedPointLayer as any;

    buildLayer = (tile, opts = {}) => {
      // Construct via Object.create so we bypass CompositeLayer's lifecycle
      // and just exercise the data-building / layer-creation private path.
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
      const data = (layer as any).buildConsolidatedData([tile]);
      return (layer as any).createConsolidatedLayer(data);
    };
  });

  it('uses the binary {length, attributes} shape — no per-feature objects', () => {
    const N = 50_000;
    const layer = buildLayer(bigPointTile(N));
    const data = layer.props.data;

    // Specifically guard against the regression: data must NOT be a real
    // Array (which would imply N wrapper objects were allocated).
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(N);
    expect(data.attributes).toBeDefined();
  });

  it('feeds consolidated typed arrays directly through binary attributes', () => {
    const N = 100;
    const layer = buildLayer(bigPointTile(N));
    const attrs = layer.props.data.attributes;

    // ScatterplotLayer's own accessor: keyed by accessor name.
    expect(attrs.getPosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getPosition.size).toBe(3);
    expect(attrs.getPosition.value.length).toBe(N * 3);

    // TimeFilterExtension's instanced attributes: keyed by ATTRIBUTE name
    // (matches attribute-wiring.test.ts).
    expect(attrs.instanceStartTime.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceStartTime.size).toBe(1);
    expect(attrs.instanceEndTime.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceEndTime.size).toBe(1);

    // With constant color/radius (no property name), no per-feature buffer
    // is emitted — deck.gl falls back to the constant on getRadius/getFillColor.
    expect(attrs.getFillColor).toBeUndefined();
    expect(attrs.getRadius).toBeUndefined();
  });

  it('binary positions carry the actual lon/lat from the tile', () => {
    const tile = bigPointTile(3);
    const layer = buildLayer(tile);
    const positions = layer.props.data.attributes.getPosition.value;

    // Source positions: feature i = [i%360 - 180, i%180 - 90, 0]
    expect(positions[0]).toBe(-180);
    expect(positions[1]).toBe(-90);
    expect(positions[3]).toBe(-179);
    expect(positions[4]).toBe(-89);
  });
});

// ---------------------------------------------------------------------------
// AnimatedPathLayer
// ---------------------------------------------------------------------------

describe('AnimatedPathLayer per-tile sublayer architecture (v3)', () => {
  let buildSublayerForTile: (tile: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/animated-path-layer');
    const LayerCtor = mod.AnimatedPathLayer as any;

    buildSublayerForTile = (tile) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        pathColor: [31, 186, 214, 255],
        pathWidth: 2,
        widthUnits: 'pixels',
        timeWindow: 1000,
        opacity: 1,
        visible: true,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = {};
      layer.preparedTileCache = new Map();
      return (layer as any).buildSublayer(
        (layer as any).prepareTile(tile, tile.layers[0])
      );
    };
  });

  it('hands deck.gl the binary {length, startIndices, attributes} shape', () => {
    const N = 100;
    const V = 50;
    const built = buildSublayerForTile(bigPathTile(N, V));
    const data = built.props.data;

    // Regression guard: data must NOT be a plain Array (which would imply
    // per-feature wrapper allocations and accessor calls per tesselation).
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(N);
    expect(data.startIndices).toBeInstanceOf(Uint32Array);
    expect(data.attributes).toBeDefined();
  });

  it('binds positions as a zero-copy view of the tile buffer', () => {
    const tile = bigPathTile(8, 4);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;

    expect(attrs.getPath.value).toBeInstanceOf(Float64Array);
    expect(attrs.getPath.size).toBe(2);
    // Zero-copy: same buffer ref as the tile's BinaryFeatures.positions.
    expect(attrs.getPath.value).toBe(tile.layers[0].features.positions);
  });

  it('sets positionFormat:"XY" so 2D flat paths are not misread as XYZ', () => {
    // makePathTile produces 2D positions. Without an explicit positionFormat
    // PathLayer defaults to 'XYZ' and would slice flat [lon0, lat0, …] into
    // garbage 3-tuples — same bug as the trips layer.
    const built = buildSublayerForTile(bigPathTile(5, 4));
    expect(built.props.positionFormat).toBe('XY');
  });
});

// ---------------------------------------------------------------------------
// AnimatedTripsLayer
// ---------------------------------------------------------------------------

describe('AnimatedTripsLayer per-tile sublayer architecture (v3)', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/animated-trips-layer');
    LayerCtor = mod.AnimatedTripsLayer as any;

    makeLayer = (opts = {}) => {
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
      // boundGetTime is normally an instance-field initializer; Object.create
      // bypasses that, so re-create the shape the constructor would set up.
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = {};
      layer.preparedTileCache = new Map();
      // Sublayer-instance cache + last-props digest: also class fields, so
      // Object.create misses them. Initialize to the same empty shape the
      // constructor would.
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      (layer as any).getEffectiveTimeWindow = () => 1000;
      return layer;
    };
  });

  it('builds one PathLayer per tile (no cross-tile consolidation)', () => {
    const layer = makeLayer();
    layer.state = { tiles: [bigPathTile(20, 5), bigPathTile(15, 4)] };
    // Give the two tiles distinct ids so makeTileKey doesn't collide.
    layer.state.tiles[0].id = { z: 14, x: 1, y: 2, t: 0 };
    layer.state.tiles[1].id = { z: 14, x: 1, y: 3, t: 0 };
    const sublayers = (layer as any).renderLayers();
    // Each tile has 1 layer; expect 1 sublayer per tile.
    expect(sublayers.length).toBe(2);
  });

  it('hands deck.gl the binary {length, startIndices, attributes} shape', () => {
    const layer = makeLayer();
    const tile = bigPathTile(50, 4);
    const built = (layer as any).buildSublayer((layer as any).prepareTile(tile, tile.layers[0]));
    const data = built.props.data;

    // Regression guard: data must NOT be a plain Array (i.e. no per-feature
    // wrappers). On the NYC taxi dataset that meant ~500K small allocations
    // per tile and matching accessor calls during PathLayer's tesselation.
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(50);
    expect(data.startIndices).toBeInstanceOf(Uint32Array);
    expect(data.attributes).toBeDefined();
  });

  it('binds positions + instanceVertexTime as zero-copy typed arrays', () => {
    const layer = makeLayer();
    const tile = bigPathTile(8, 4);
    const built = (layer as any).buildSublayer((layer as any).prepareTile(tile, tile.layers[0]));
    const attrs = built.props.data.attributes;

    // PathLayer's geometry accessor: keyed by ACCESSOR NAME `getPath`.
    expect(attrs.getPath.value).toBeInstanceOf(Float64Array);
    expect(attrs.getPath.size).toBe(2);
    // Zero-copy: same buffer ref as the tile's BinaryFeatures.positions.
    expect(attrs.getPath.value).toBe(tile.layers[0].features.positions);

    // TimeFilterExtension per-vertex attribute: keyed by ATTRIBUTE NAME
    // `instanceVertexTime` (the name registered in addInstanced()).
    expect(attrs.instanceVertexTime).toBeDefined();
    expect(attrs.instanceVertexTime.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceVertexTime.size).toBe(1);

    // With constant color/width (no property name), no per-feature buffer is
    // emitted — deck.gl falls back to the constant `getColor`/`getWidth`.
    expect(attrs.getColor).toBeUndefined();
    expect(attrs.getWidth).toBeUndefined();
  });

  it('caches PreparedTile so the data object reference is stable across renders', () => {
    const layer = makeLayer();
    const tile = bigPathTile(5, 4);
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    // Stable identity is what lets deck.gl skip re-tesselation / GPU
    // re-upload on the next render when nothing changed.
    expect(second).toBe(first);
    expect(second.data).toBe(first.data);
  });

  it('sets positionFormat from tile dims so 2D paths are not misread as XYZ', () => {
    const layer = makeLayer();
    const tile = bigPathTile(3, 4);
    const built = (layer as any).buildSublayer((layer as any).prepareTile(tile, tile.layers[0]));
    // PathLayer defaults positionFormat to 'XYZ', which would slice a flat
    // 2D buffer into garbage 3-tuples. Both AnimatedPathLayer and the trips
    // layer have to opt out explicitly.
    expect(built.props.positionFormat).toBe('XY');
  });

  it('passes the bound getTime getter so the trail uniform advances each draw', () => {
    const layer = makeLayer();
    const tile = bigPathTile(3, 4);
    const built = (layer as any).buildSublayer((layer as any).prepareTile(tile, tile.layers[0]));
    // Without this, the trail uniform would freeze at the snapshot value
    // between layer rebuilds — visible as "freeze then jump" stutter.
    expect(typeof built.props.getTime).toBe('function');
  });

  it("uses each tile's own timeOffset (no cross-tile rebasing)", () => {
    // Independence is the architectural promise of the v3 design: every tile
    // is rendered through its own sublayer with its own TimeFilterExtension
    // uniforms. The v2 consolidation pass rebased every tile onto a single
    // layer-wide offset, defeating zero-copy on the time arrays.
    const layer = makeLayer();
    const a = bigPathTile(3, 4);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    a.layers[0].features.timeOffset = 1_700_000_000_000;
    const b = bigPathTile(3, 4);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    b.layers[0].features.timeOffset = 1_700_086_400_000; // +1 day
    layer.state = { tiles: [a, b] };
    const [subA, subB] = (layer as any).renderLayers();
    expect(subA.props.timeOffset).toBe(1_700_000_000_000);
    expect(subB.props.timeOffset).toBe(1_700_086_400_000);
  });

  it('uses tile.vertexTimestamps directly (zero copy) when present', () => {
    const layer = makeLayer();
    const tile = bigPathTile(3, 4);
    const totalVerts = tile.layers[0].features.startIndices[3];
    const vt = new Float32Array(totalVerts);
    for (let i = 0; i < totalVerts; i++) vt[i] = i * 10;
    tile.layers[0].features.vertexTimestamps = vt;
    const built = (layer as any).buildSublayer((layer as any).prepareTile(tile, tile.layers[0]));
    // The very point of carrying per-vertex times in the tile is that the
    // layer can hand them straight to deck.gl without allocating a fresh
    // Float32Array per render.
    expect(built.props.data.attributes.instanceVertexTime.value).toBe(vt);
  });

  it('synthesizes per-vertex times from start/end when vertexTimestamps absent', () => {
    // bigPathTile leaves vertexTimestamps unset, so the synth path runs.
    // Each feature interpolates startTime..endTime linearly across its vertices.
    const layer = makeLayer();
    const tile = bigPathTile(1, 4);
    tile.layers[0].features.startTimes = new Float32Array([0]);
    tile.layers[0].features.endTimes = new Float32Array([300]);
    const built = (layer as any).buildSublayer((layer as any).prepareTile(tile, tile.layers[0]));
    const vt = built.props.data.attributes.instanceVertexTime.value;
    expect(vt.length).toBe(4);
    expect(vt[0]).toBe(0);
    expect(vt[3]).toBe(300);
    expect(vt[1]).toBeCloseTo(100);
    expect(vt[2]).toBeCloseTo(200);
  });

  it('prunes prepared-data cache when a tile drops out of the visible set', () => {
    // Cache growth would be a slow memory leak under panning/animation; the
    // prune step at the top of renderLayers() keeps it bounded to the live set.
    const layer = makeLayer();
    const a = bigPathTile(3, 4);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPathTile(3, 4);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    (layer as any).renderLayers();
    expect((layer as any).preparedTileCache.size).toBe(2);

    layer.state = { tiles: [a] };
    (layer as any).renderLayers();
    expect((layer as any).preparedTileCache.size).toBe(1);
  });

  it('returns the SAME PathLayer instance per tile across renders when nothing changed', () => {
    // Reference stability is the whole point of the sublayer cache: deck.gl's
    // matcher short-circuits the entire updateState / prop-diff pass when the
    // same instance comes back. Per-frame `new PathLayer(...)` was 30-60% of
    // frame time once 50+ tiles were on screen.
    const layer = makeLayer();
    const a = bigPathTile(3, 4);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPathTile(3, 4);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    const first = (layer as any).renderLayers();
    const second = (layer as any).renderLayers();
    expect(second.length).toBe(2);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('rebuilds the cached PathLayer when a tile-level prop changes', () => {
    // Layer-prop changes (trailLength, widthScale, …) must invalidate every
    // cached sublayer; otherwise the new prop would apply only to newly
    // arriving tiles and produce a visible split-render.
    const layer = makeLayer();
    const tile = bigPathTile(3, 4);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    // Mutate a baked layer-level prop and re-render.
    layer.props.trailLength = 12345;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.trailLength).toBe(12345);
  });

  it('drops sublayer-cache entries for tiles that leave the visible set', () => {
    const layer = makeLayer();
    const a = bigPathTile(3, 4);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPathTile(3, 4);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    (layer as any).renderLayers();
    expect((layer as any).sublayerCache.size).toBe(2);

    layer.state = { tiles: [a] };
    (layer as any).renderLayers();
    expect((layer as any).sublayerCache.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AnimatedPointLayer with categorical color (AIS-style "fillColor: 'VesselType'")
// ---------------------------------------------------------------------------

describe('AnimatedPointLayer with categorical color', () => {
  it('emits a per-feature color binary attribute when fillColor is a property name', async () => {
    vi.resetModules();
    const mod = await import('../src/animated-point-layer');
    const LayerCtor = mod.AnimatedPointLayer as any;

    const N = 1000;
    const tile = bigPointTile(N);
    // Inject a fake categorical property on the binary features so the
    // property-color path actually runs.
    const binary = tile.layers[0].features;
    binary.categoricalProps['vtype'] = {
      indices: new Uint16Array(N).fill(2),
      categories: ['a', 'b', 'c', 'd'],
    };

    const layer = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'cat',
      fillColor: 'vtype',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
      radius: 5,
      radiusUnits: 'pixels',
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    };
    layer._currentTime = 0;

    const data = (layer as any).buildConsolidatedData([tile]);
    const built = (layer as any).createConsolidatedLayer(data);
    const attrs = built.props.data.attributes;

    expect(built.props.data.length).toBe(N);
    // Color binary attribute is emitted when fillColor is a property name.
    expect(attrs.getFillColor).toBeDefined();
    expect(attrs.getFillColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getFillColor.size).toBe(4);
    expect(attrs.getFillColor.normalized).toBe(true);
    // With indices=2 the palette entry is [70,80,90,255]; check the first
    // feature's color in the consolidated buffer.
    expect([
      attrs.getFillColor.value[0],
      attrs.getFillColor.value[1],
      attrs.getFillColor.value[2],
      attrs.getFillColor.value[3],
    ]).toEqual([70, 80, 90, 255]);
  });
});

// ---------------------------------------------------------------------------
// Perf budget: end-to-end consolidation + layer build for an AIS-sized set
// ---------------------------------------------------------------------------

describe('AIS-sized perf budget', () => {
  it('point layer: consolidate + build 200k features under a generous budget', async () => {
    vi.resetModules();
    const mod = await import('../src/animated-point-layer');
    const LayerCtor = mod.AnimatedPointLayer as any;

    const N = 200_000;
    const tile = bigPointTile(N);

    const layer = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'perf',
      fillColor: [255, 128, 0, 255],
      radius: 5,
      radiusUnits: 'pixels',
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    };
    layer._currentTime = 0;

    const t0 = performance.now();
    const data = (layer as any).buildConsolidatedData([tile]);
    const built = (layer as any).createConsolidatedLayer(data);
    const elapsed = performance.now() - t0;

    // Log the actual number so a re-regression is easy to debug from CI.
    // Leave the floor loose: the OLD code allocated N Feat objects +
    // N position triples per build (several hundred ms for 200k locally).
    // 250ms catches the regression without being flaky on slow CI workers.
    // eslint-disable-next-line no-console
    console.log(`[perf] point-layer consolidate+build for ${N} features: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(250);
    expect(built.props.data.length).toBe(N);
    expect(Array.isArray(built.props.data)).toBe(false);
  });
});
