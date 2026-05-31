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
import { makePointTile, makePathTile, makePolygonTile } from './fake-tile';

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

describe('AnimatedPointLayer per-tile sublayer architecture (v3)', () => {
  let buildSublayerForTile: (tile: any, opts?: any) => any;
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;

  beforeEach(async () => {
    // Fresh import each test so vi.mock's are applied.
    vi.resetModules();
    const mod = await import('../src/animated-point-layer');
    LayerCtor = mod.AnimatedPointLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — we exercise the
      // per-tile prepare + sublayer-build path directly.
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
    };

    buildSublayerForTile = (tile, opts = {}) => {
      const layer = makeLayer(opts);
      return (layer as any).buildSublayer(
        (layer as any).prepareTile(tile, tile.layers[0]),
      );
    };
  });

  it('uses the binary {length, attributes} shape — no per-feature objects', () => {
    const N = 50_000;
    const built = buildSublayerForTile(bigPointTile(N));
    const data = built.props.data;

    // Regression guard: data must NOT be a real Array (which would imply N
    // wrapper objects were allocated).
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(N);
    expect(data.attributes).toBeDefined();
  });

  it('feeds zero-copy binary attributes (positions / startTimes / endTimes)', () => {
    const N = 100;
    const tile = bigPointTile(N);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;

    // ScatterplotLayer's own position accessor — keyed by accessor name.
    expect(attrs.getPosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getPosition.size).toBe(3);
    expect(attrs.getPosition.value.length).toBe(N * 3);

    // TimeFilterExtension instanced attributes — keyed by ATTRIBUTE name.
    // Zero-copy: the same Float32Array reference the tile carries.
    expect(attrs.instanceStartTime.value).toBe(tile.layers[0].features.startTimes);
    expect(attrs.instanceStartTime.size).toBe(1);
    expect(attrs.instanceEndTime.value).toBe(tile.layers[0].features.endTimes);
    expect(attrs.instanceEndTime.size).toBe(1);

    // With constant color/radius (no property name), no per-feature buffer is
    // emitted — deck.gl falls back to the constant on getRadius / getFillColor.
    expect(attrs.getFillColor).toBeUndefined();
    expect(attrs.getRadius).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeUndefined();
  });

  it('pads 2D positions to size-3 once per tile (covers ScatterplotLayer instancePositions)', () => {
    const tile = bigPointTile(3);
    const built = buildSublayerForTile(tile);
    const positions = built.props.data.attributes.getPosition.value;

    // Source positions: feature i = [i%360 - 180, i%180 - 90]; padded to 3D.
    expect(positions[0]).toBe(-180);
    expect(positions[1]).toBe(-90);
    expect(positions[2]).toBe(0);
    expect(positions[3]).toBe(-179);
    expect(positions[4]).toBe(-89);
    expect(positions[5]).toBe(0);
  });

  it('builds one ScatterplotLayer per tile (no cross-tile consolidation)', () => {
    const layer = makeLayer();
    const a = bigPointTile(20);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPointTile(15);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    const sublayers = (layer as any).renderLayers();
    expect(sublayers.length).toBe(2);
  });

  it("uses each tile's own timeOffset (no cross-tile rebasing)", () => {
    // The v3 promise: every tile renders through its own sublayer with its
    // own TimeFilterExtension uniforms. v2 rebased onto a single offset and
    // had to copy startTimes / endTimes into a fresh consolidated buffer.
    const layer = makeLayer();
    const a = bigPointTile(3);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    a.layers[0].features.timeOffset = 1_700_000_000_000;
    const b = bigPointTile(3);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    b.layers[0].features.timeOffset = 1_700_086_400_000;
    layer.state = { tiles: [a, b] };
    const [subA, subB] = (layer as any).renderLayers();
    expect(subA.props.timeOffset).toBe(1_700_000_000_000);
    expect(subB.props.timeOffset).toBe(1_700_086_400_000);
  });

  it('caches PreparedTile so the data object reference is stable across renders', () => {
    const layer = makeLayer();
    const tile = bigPointTile(5);
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).toBe(first);
    expect(second.data).toBe(first.data);
  });

  it('returns the SAME ScatterplotLayer instance per tile across renders when nothing changed', () => {
    const layer = makeLayer();
    const a = bigPointTile(3);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPointTile(3);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    const first = (layer as any).renderLayers();
    const second = (layer as any).renderLayers();
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('rebuilds the cached ScatterplotLayer when a tile-level prop changes', () => {
    const layer = makeLayer();
    const tile = bigPointTile(3);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    layer.props.radiusScale = 7;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.radiusScale).toBe(7);
  });

  it('drops sublayer-cache entries for tiles that leave the visible set', () => {
    const layer = makeLayer();
    const a = bigPointTile(3);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPointTile(3);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    (layer as any).renderLayers();
    expect((layer as any).sublayerCache.size).toBe(2);

    layer.state = { tiles: [a] };
    (layer as any).renderLayers();
    expect((layer as any).sublayerCache.size).toBe(1);
  });

  it('passes the bound getTime getter so the time uniform advances each draw', () => {
    const built = buildSublayerForTile(bigPointTile(3));
    expect(typeof built.props.getTime).toBe('function');
  });

  it('declares dataComparator that skips deck.gl prop diff on identical references', () => {
    const built = buildSublayerForTile(bigPointTile(3));
    const cmp = built.props.dataComparator;
    expect(typeof cmp).toBe('function');
    const ref = {};
    expect(cmp(ref, ref)).toBe(true);
    expect(cmp(ref, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnimatedPointLayer cumulative consolidation ("draws itself")
// ---------------------------------------------------------------------------
//
// In cumulative mode the loader keeps the whole span resident, so the per-tile
// path would accumulate thousands of sublayers (one draw call each) and tank
// pan/zoom FPS late in playback. The consolidation path packs resident tiles
// append-only into a few "slab" ScatterplotLayers. These tests pin: the slab
// count stays tiny, frozen slabs keep a stable layer reference (no re-upload),
// times rebase onto one common offset, restyle/zoom invalidation behaves, and
// the cap rolls over into a second slab.

describe('AnimatedPointLayer cumulative consolidation', () => {
  let LayerCtor: any;
  let makeCumulativeLayer: (opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/animated-point-layer');
    LayerCtor = mod.AnimatedPointLayer as any;

    makeCumulativeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'cum',
        fillColor: [255, 128, 0, 255],
        radius: 5,
        radiusUnits: 'pixels',
        timeWindow: 1000,
        opacity: 1,
        visible: true,
        cumulative: true,
        timeRange: { start: 1_000_000, end: 2_000_000 },
        fadeInDuration: 100,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = {};
      layer.categoryColorExtension = {};
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      // Cumulative-path fields (constructor doesn't run under Object.create).
      layer.slabs = [];
      layer.absorbedTileKeys = new Set();
      layer.slabBaseOffset = 0;
      layer.slabSchemaKey = null;
      layer.slabSchema = null;
      layer.lastSlabLayerPropsKey = '';
      return layer;
    };
  });

  /** `count` small point tiles at zoom 11, each a distinct (x) tile. */
  function metroTiles(count: number, features = 50) {
    const tiles = [];
    for (let i = 0; i < count; i++) {
      const t = bigPointTile(features);
      t.id = { z: 11, x: i, y: 0, t: 0 };
      tiles.push(t);
    }
    return tiles;
  }

  it('packs many resident tiles into a single slab layer (not one sublayer per tile)', () => {
    const layer = makeCumulativeLayer();
    layer.state = { tiles: metroTiles(20) }; // 20 tiles × 50 = 1000 pts ≪ cap
    const sublayers = (layer as any).renderLayers();
    expect(sublayers.length).toBe(1);
    expect(sublayers[0].props.data.length).toBe(1000);
  });

  it('returns the SAME slab layer instance across renders when no new tiles arrived', () => {
    const layer = makeCumulativeLayer();
    layer.state = { tiles: metroTiles(8) };
    const first = (layer as any).renderLayers();
    const second = (layer as any).renderLayers();
    // Frozen/unchanged slab ⇒ stable reference ⇒ deck.gl skips GPU re-upload.
    expect(second[0]).toBe(first[0]);
  });

  it('grows the open slab and rebuilds its layer when a new tile arrives', () => {
    const layer = makeCumulativeLayer();
    const tiles = metroTiles(8);
    layer.state = { tiles };
    const before = (layer as any).renderLayers();
    expect(before[0].props.data.length).toBe(400);

    const extra = bigPointTile(50);
    extra.id = { z: 11, x: 99, y: 0, t: 0 };
    layer.state = { tiles: [...tiles, extra] };
    const after = (layer as any).renderLayers();

    expect(after.length).toBe(1);
    expect(after[0]).not.toBe(before[0]); // version bumped → new data ref → re-upload
    expect(after[0].props.data.length).toBe(450);
  });

  it('rebases per-tile times onto the dataset-start offset (one shared timeOffset)', () => {
    const layer = makeCumulativeLayer();
    const tile = makePointTile({
      positions: [
        [0, 0],
        [1, 1],
      ],
      startTimes: [10, 20],
      endTimes: [30, 40],
      timeOffset: 1_500_000,
      tileId: { z: 11, x: 1, y: 2, t: 0 },
    });
    layer.state = { tiles: [tile] };
    const [slab] = (layer as any).renderLayers();
    const attrs = slab.props.data.attributes;

    // Common offset = timeRange.start; delta = 1_500_000 − 1_000_000 = 500_000.
    expect(slab.props.timeOffset).toBe(1_000_000);
    expect(attrs.instanceStartTime.value[0]).toBeCloseTo(500_010, 0);
    expect(attrs.instanceStartTime.value[1]).toBeCloseTo(500_020, 0);
    expect(attrs.instanceEndTime.value[0]).toBeCloseTo(500_030, 0);
    expect(typeof slab.props.getTime).toBe('function');
  });

  it('consolidates CPU colorMapping fill colors across tiles into one buffer', () => {
    const layer = makeCumulativeLayer({
      fillColor: 'year',
      colorMapping: { '2008': [1, 2, 3, 255] as any },
      colorMappingDefault: [9, 9, 9, 255] as any,
    });
    const mkYearTile = (n: number, x: number) => {
      const t = bigPointTile(n);
      t.id = { z: 11, x, y: 0, t: 0 };
      t.layers[0].features.categoricalProps['year'] = {
        indices: new Uint16Array(n).fill(1), // → category '2008'
        categories: ['2007', '2008', '2009'],
      };
      return t;
    };
    layer.state = { tiles: [mkYearTile(4, 0), mkYearTile(6, 1)] };
    const [slab] = (layer as any).renderLayers();
    const fill = slab.props.data.attributes.getFillColor;

    expect(slab.props.data.length).toBe(10);
    expect(fill.value).toBeInstanceOf(Uint8Array);
    expect(fill.value.length).toBe(10 * 4);
    // First feature of tile A and a feature from tile B both resolve to [1,2,3,255].
    expect([fill.value[0], fill.value[1], fill.value[2], fill.value[3]]).toEqual([1, 2, 3, 255]);
    expect([fill.value[36], fill.value[37], fill.value[38], fill.value[39]]).toEqual([1, 2, 3, 255]);
  });

  it('rebuilds slabs from scratch when the zoom (tile z) changes', () => {
    const layer = makeCumulativeLayer();
    layer.state = { tiles: metroTiles(4) };
    (layer as any).renderLayers();
    expect((layer as any).slabSchemaKey).toContain('|11');
    expect((layer as any).absorbedTileKeys.size).toBe(4);

    const deeper = bigPointTile(50);
    deeper.id = { z: 12, x: 0, y: 0, t: 0 };
    layer.state = { tiles: [deeper] };
    (layer as any).renderLayers();
    // Old-zoom tiles dropped; only the new-zoom tile is packed.
    expect((layer as any).slabSchemaKey).toContain('|12');
    expect((layer as any).absorbedTileKeys.size).toBe(1);
  });

  it('rebuilds slab layers (but keeps packed data) on a visual-only prop change', () => {
    const layer = makeCumulativeLayer();
    layer.state = { tiles: metroTiles(6) };
    const first = (layer as any).renderLayers();
    const firstData = first[0].props.data;

    layer.props.radiusScale = 9;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]); // layer rebuilt with new style…
    expect(second[0].props.radiusScale).toBe(9);
    expect(second[0].props.data).toBe(firstData); // …but the packed data is reused
  });

  it('rolls a full slab over into a second slab past the point cap', () => {
    const layer = makeCumulativeLayer();
    const a = bigPointTile(200_000);
    a.id = { z: 11, x: 0, y: 0, t: 0 };
    const b = bigPointTile(60_000); // 200k + 60k > 250k cap → opens a 2nd slab
    b.id = { z: 11, x: 1, y: 0, t: 0 };
    layer.state = { tiles: [a, b] };
    const subs = (layer as any).renderLayers();
    expect(subs.length).toBe(2);
    expect(subs[0].props.data.length).toBe(200_000);
    expect(subs[1].props.data.length).toBe(60_000);
  });

  it('collapses slabs when the tile set empties (data switch)', () => {
    const layer = makeCumulativeLayer();
    layer.state = { tiles: metroTiles(5) };
    (layer as any).renderLayers();
    expect((layer as any).slabs.length).toBeGreaterThan(0);

    layer.state = { tiles: [] };
    const subs = (layer as any).renderLayers();
    expect(subs).toEqual([]);
    expect((layer as any).slabs.length).toBe(0);
    expect((layer as any).absorbedTileKeys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AnimatedPathLayer
// ---------------------------------------------------------------------------

describe('AnimatedPathLayer per-tile sublayer architecture (v3)', () => {
  let buildSublayerForTile: (tile: any, opts?: any) => any;
  let LayerCtor: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/animated-path-layer');
    LayerCtor = mod.AnimatedPathLayer as any;

    buildSublayerForTile = (tile, opts = {}) => {
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

  it('hands categorical color indices to the GPU (no per-feature RGBA buffer)', () => {
    // Wire a categorical column on a path tile and assert the layer carries
    // instanceCategoryIndex + useCategoryColor instead of allocating a
    // 4n-byte Uint8Array.
    const tile = bigPathTile(8, 4);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 2, 1, 0, 2, 1, 0]),
      categories: ['a', 'b', 'c'],
    };
    const built = buildSublayerForTile(tile, {
      pathColor: 'kind',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const attrs = built.props.data.attributes;
    expect(attrs.getColor).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(attrs.instanceCategoryIndex.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceCategoryIndex.value[2]).toBe(2);
    expect(built.props.useCategoryColor).toBe(true);
  });

  it('declares dataComparator that skips deck.gl prop diff on identical references', () => {
    const built = buildSublayerForTile(bigPathTile(3, 4));
    const cmp = built.props.dataComparator;
    expect(typeof cmp).toBe('function');
    const ref = {};
    expect(cmp(ref, ref)).toBe(true);
    expect(cmp(ref, {})).toBe(false);
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
      layer.categoryColorExtension = {};
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

  it('expands trip categorical color to a per-vertex getColor buffer (PathLayer segment instances)', () => {
    // PathLayer instances are SEGMENTS, not features, so the GPU per-feature
    // `instanceCategoryIndex` path (used by the point layer) under-sizes the
    // instanced buffer and throws "vertex buffer is not big enough". The trips
    // layer resolves the color on the CPU and expands it per-vertex, which
    // PathLayer's tessellator maps onto its segment instances.
    const layer = makeLayer({
      tripColor: 'kind',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const tile = bigPathTile(8, 4);
    const binary = tile.layers[0].features;
    binary.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 2, 1, 0, 2, 1, 0]),
      categories: ['a', 'b', 'c'],
    };
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const attrs = built.props.data.attributes;

    // No GPU per-feature index, no useCategoryColor — color rides getColor.
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(built.props.useCategoryColor).toBe(false);

    // getColor is one RGBA per VERTEX (matches getPath / instanceVertexTime
    // granularity), so the draw call's instanced buffer is correctly sized.
    expect(attrs.getColor).toBeDefined();
    expect(attrs.getColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getColor.size).toBe(4);
    expect(attrs.getColor.normalized).toBe(true);
    const totalVerts = binary.startIndices[binary.featureCount];
    expect(attrs.getColor.value.length).toBe(totalVerts * 4);

    // Feature 0 (category index 0 → [10,20,30]) colors all its vertices…
    const col = attrs.getColor.value;
    const v0 = binary.startIndices[0] * 4;
    expect([col[v0], col[v0 + 1], col[v0 + 2], col[v0 + 3]]).toEqual([10, 20, 30, 255]);
    // …and feature 2 (category index 2 → [70,80,90]) gets the third palette entry.
    const v2 = binary.startIndices[2] * 4;
    expect([col[v2], col[v2 + 1], col[v2 + 2]]).toEqual([70, 80, 90]);
  });

  it('maps a per-vertex scalar (vertexValues) through the gradient ramp; NaN → fallback', () => {
    // The ocean-drifter feature: each vertex's SST is mapped through a low→high
    // ramp so the line shades ALONG its length. Built per-vertex (same
    // granularity as getPath) so PathLayer's segment instances are sized right.
    const layer = makeLayer({
      gradientProperty: 'vertexValues',
      gradientDomain: [0, 30],
      gradientColorRamp: [
        [0, 0, 255, 255], // cold → blue
        [255, 0, 0, 255], // hot → red
      ],
      colorMappingDefault: [9, 9, 9, 99], // NaN / no-value fallback
    });
    const tile = bigPathTile(1, 3);
    const binary = tile.layers[0].features;
    // 1 feature × 3 vertices: cold endpoint, hot endpoint, missing value.
    binary.vertexValues = new Float32Array([0, 30, NaN]);
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const attrs = built.props.data.attributes;

    expect(attrs.getColor).toBeDefined();
    expect(attrs.getColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getColor.size).toBe(4);
    const totalVerts = binary.startIndices[binary.featureCount];
    expect(attrs.getColor.value.length).toBe(totalVerts * 4);

    const col = attrs.getColor.value;
    // Distinct per-vertex values → distinct colors along the path.
    expect([col[0], col[1], col[2], col[3]]).toEqual([0, 0, 255, 255]); // cold → blue
    expect([col[4], col[5], col[6], col[7]]).toEqual([255, 0, 0, 255]); // hot → red
    expect([col[8], col[9], col[10], col[11]]).toEqual([9, 9, 9, 99]); // missing → fallback
  });

  it('gradient color takes precedence over categorical tripColor', () => {
    const layer = makeLayer({
      tripColor: 'kind', // categorical would normally drive color…
      colorPalette: [[10, 20, 30, 255]],
      gradientProperty: 'vertexValues', // …but the gradient wins.
      gradientDomain: [0, 10],
      gradientColorRamp: [[1, 2, 3, 255]],
    });
    const tile = bigPathTile(1, 2);
    const binary = tile.layers[0].features;
    binary.categoricalProps['kind'] = {
      indices: new Uint16Array([0]),
      categories: ['a'],
    };
    binary.vertexValues = new Float32Array([5, 5]);
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const col = built.props.data.attributes.getColor.value;
    // Single-stop ramp → every vertex is the ramp color, not the palette color.
    expect([col[0], col[1], col[2], col[3]]).toEqual([1, 2, 3, 255]);
  });

  it('declares dataComparator that skips deck.gl prop diff on identical references', () => {
    const layer = makeLayer();
    const tile = bigPathTile(3, 4);
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const cmp = built.props.dataComparator;
    expect(typeof cmp).toBe('function');
    const ref = {};
    expect(cmp(ref, ref)).toBe(true);
    expect(cmp(ref, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnimatedPointLayer with categorical color (AIS-style "fillColor: 'VesselType'")
// ---------------------------------------------------------------------------

describe('AnimatedPointLayer with categorical color', () => {
  function makePointLayerForTile() {
    const layer: any = {
      props: {
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
      },
      _currentTime: 0,
      boundGetTime: () => 0,
      timeFilterExtension: {},
      categoryColorExtension: {},
      preparedTileCache: new Map(),
      sublayerCache: new Map(),
      lastLayerPropsKey: '',
    };
    return layer;
  }

  it('hands category indices to the GPU (no per-feature RGBA buffer) when colorMapping is unset', async () => {
    vi.resetModules();
    const mod = await import('../src/animated-point-layer');
    const LayerCtor = mod.AnimatedPointLayer as any;

    const N = 1000;
    const tile = bigPointTile(N);
    const binary = tile.layers[0].features;
    binary.categoricalProps['vtype'] = {
      indices: new Uint16Array(N).fill(2),
      categories: ['a', 'b', 'c', 'd'],
    };

    const layer = Object.create(LayerCtor.prototype);
    Object.assign(layer, makePointLayerForTile());

    const prepared = (layer as any).prepareTile(tile, tile.layers[0]);
    const built = (layer as any).buildSublayer(prepared);
    const attrs = built.props.data.attributes;

    // GPU path: no per-feature RGBA — instanceCategoryIndex carries the
    // category id; CategoryColorExtension samples the palette texture.
    expect(attrs.getFillColor).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(attrs.instanceCategoryIndex.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceCategoryIndex.value[0]).toBe(2);
    expect(attrs.instanceCategoryIndex.size).toBe(1);

    // Layer carries the resolved palette + useCategoryColor toggle.
    expect(built.props.useCategoryColor).toBe(true);
    expect(built.props.categoryPalette).toEqual([
      [10, 20, 30, 255],
      [40, 50, 60, 255],
      [70, 80, 90, 255],
    ]);
  });

  it('falls back to the CPU RGBA expansion when colorMapping is provided (string-keyed lookup)', async () => {
    vi.resetModules();
    const mod = await import('../src/animated-point-layer');
    const LayerCtor = mod.AnimatedPointLayer as any;

    const N = 100;
    const tile = bigPointTile(N);
    const binary = tile.layers[0].features;
    binary.categoricalProps['vtype'] = {
      indices: new Uint16Array(N).fill(2),
      categories: ['a', 'b', 'c', 'd'],
    };

    const layer = Object.create(LayerCtor.prototype);
    Object.assign(layer, makePointLayerForTile());
    layer.props = {
      ...layer.props,
      colorMapping: { c: [11, 22, 33, 255] as any },
      colorMappingDefault: [0, 0, 0, 255] as any,
    };

    const prepared = (layer as any).prepareTile(tile, tile.layers[0]);
    const built = (layer as any).buildSublayer(prepared);
    const attrs = built.props.data.attributes;

    // CPU path: getFillColor RGBA is emitted; GPU category-index attribute is absent.
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(attrs.getFillColor).toBeDefined();
    expect(attrs.getFillColor.value).toBeInstanceOf(Uint8Array);
    expect([
      attrs.getFillColor.value[0],
      attrs.getFillColor.value[1],
      attrs.getFillColor.value[2],
      attrs.getFillColor.value[3],
    ]).toEqual([11, 22, 33, 255]);
    expect(built.props.useCategoryColor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Perf budget: end-to-end consolidation + layer build for an AIS-sized set
// ---------------------------------------------------------------------------

describe('AIS-sized perf budget', () => {
  it('point layer: prepare + build 200k features per tile under a generous budget', async () => {
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
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastLayerPropsKey = '';

    const t0 = performance.now();
    const prepared = (layer as any).prepareTile(tile, tile.layers[0]);
    const built = (layer as any).buildSublayer(prepared);
    const elapsed = performance.now() - t0;

    // v3 prepare+build is one position-pad pass (2D → 3D) + zero-copy time
    // attribute references. The v2 consolidation copied positions+times
    // AND re-rebased timestamps; in CI it took ~20ms for 200k features.
    // Budget held loose at 250ms to absorb slow CI runners.
    // eslint-disable-next-line no-console
    console.log(`[perf] point-layer prepare+build for ${N} features: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(250);
    expect(built.props.data.length).toBe(N);
    expect(Array.isArray(built.props.data)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnimatedPolygonLayer (v3 — GPU time filter + per-tile sublayers)
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer per-tile sublayer architecture (v3)', () => {
  /** A tile with 3 square polygons at distinct lon/lat. */
  function bigPolygonTile(n: number) {
    const polygons: number[][][] = new Array(n);
    const startTimes: number[] = new Array(n);
    const endTimes: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * 0.1;
      polygons[i] = [
        [x, 0],
        [x + 0.05, 0],
        [x + 0.05, 0.05],
        [x, 0.05],
        [x, 0],
      ];
      startTimes[i] = i * 100;
      endTimes[i] = i * 100 + 500;
    }
    return makePolygonTile({ polygons, startTimes, endTimes, timeOffset: 0 });
  }

  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/animated-polygon-layer');
    LayerCtor = mod.AnimatedPolygonLayer as any;

    makeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'poly',
        fillColor: [255, 140, 0, 180],
        timeWindow: 1000,
        opacity: 1,
        visible: true,
        filled: true,
        extruded: false,
        elevation: 0,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.polygonTimeFilterExtension = {};
      layer.categoryColorExtension = {};
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      return layer;
    };
  });

  it('hands deck.gl the binary {length, startIndices, attributes} shape (no per-feature wrappers)', () => {
    const layer = makeLayer();
    const tile = bigPolygonTile(20);
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const data = built.props.data;
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(20);
    expect(data.startIndices).toBeInstanceOf(Uint32Array);
  });

  it('zero-copies positions / startTime / endTime from the tile (no CPU filter pass)', () => {
    // The whole point of lifting the time filter to the GPU: positions and
    // per-feature times ride straight from the Arrow-backed tile buffers to
    // the GPU. The v2 layer copied positions into a fresh Float64Array via
    // extractVisiblePolygons() on every render.
    const layer = makeLayer();
    const tile = bigPolygonTile(8);
    const binary = tile.layers[0].features;
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const attrs = built.props.data.attributes;
    expect(attrs.getPolygon.value).toBe(binary.positions);
    expect(attrs.startTime.value).toBe(binary.startTimes);
    expect(attrs.endTime.value).toBe(binary.endTimes);
    expect(attrs.startTime.size).toBe(1);
    expect(attrs.endTime.size).toBe(1);
  });

  it('builds one SolidPolygonLayer per tile (no cross-tile consolidation)', () => {
    const layer = makeLayer();
    const a = bigPolygonTile(3);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPolygonTile(4);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    const sublayers = (layer as any).renderLayers();
    expect(sublayers.length).toBe(2);
  });

  it("uses each tile's own timeOffset (no layer-wide rebasing)", () => {
    const layer = makeLayer();
    const a = bigPolygonTile(2);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    a.layers[0].features.timeOffset = 1_700_000_000_000;
    const b = bigPolygonTile(2);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    b.layers[0].features.timeOffset = 1_700_086_400_000;
    layer.state = { tiles: [a, b] };
    const [subA, subB] = (layer as any).renderLayers();
    expect(subA.props.timeOffset).toBe(1_700_000_000_000);
    expect(subB.props.timeOffset).toBe(1_700_086_400_000);
  });

  it('caches PreparedTile so the data object reference is stable across renders', () => {
    const layer = makeLayer();
    const tile = bigPolygonTile(3);
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).toBe(first);
    expect(second.data).toBe(first.data);
  });

  it('returns the SAME SolidPolygonLayer per tile across renders when nothing changed', () => {
    const layer = makeLayer();
    const a = bigPolygonTile(3);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    layer.state = { tiles: [a] };
    const [first] = (layer as any).renderLayers();
    const [second] = (layer as any).renderLayers();
    expect(second).toBe(first);
  });

  it('polygons fade/visibility-toggle via uniform updates only (no rebuild)', () => {
    // The architectural promise of lifting filtering to the GPU: changing
    // the play head (via getTime) must NOT rebuild the SolidPolygonLayer.
    // We verify by mutating the bound time getter, calling renderLayers,
    // and asserting the same layer instance comes back.
    let now = 0;
    const layer = makeLayer();
    layer.boundGetTime = () => now;
    const tile = bigPolygonTile(5);
    layer.state = { tiles: [tile] };
    const [first] = (layer as any).renderLayers();
    now = 50_000; // big jump in sim time
    const [second] = (layer as any).renderLayers();
    expect(second).toBe(first);
    // The dynamic getter is still wired in.
    expect(typeof first.props.getTime).toBe('function');
  });

  it('hands category indices to the GPU for categorical fill colors', () => {
    const layer = makeLayer({
      fillColor: 'kind',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const tile = bigPolygonTile(6);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 2, 1, 0, 2]),
      categories: ['a', 'b', 'c'],
    };
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const attrs = built.props.data.attributes;
    expect(attrs.getFillColor).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(attrs.instanceCategoryIndex.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceCategoryIndex.value[2]).toBe(2);
    expect(built.props.useCategoryColor).toBe(true);
  });

  it('declares dataComparator that skips deck.gl prop diff on identical references', () => {
    const layer = makeLayer();
    const tile = bigPolygonTile(2);
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const cmp = built.props.dataComparator;
    expect(typeof cmp).toBe('function');
    const ref = {};
    expect(cmp(ref, ref)).toBe(true);
    expect(cmp(ref, {})).toBe(false);
  });

  it('rebuilds the cached SolidPolygonLayer when a tile-level prop changes', () => {
    const layer = makeLayer();
    const tile = bigPolygonTile(3);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    layer.props.extruded = true;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.extruded).toBe(true);
  });

  it('drops sublayer-cache entries for tiles that leave the visible set', () => {
    const layer = makeLayer();
    const a = bigPolygonTile(2);
    a.id = { z: 14, x: 1, y: 2, t: 0 };
    const b = bigPolygonTile(2);
    b.id = { z: 14, x: 1, y: 3, t: 0 };
    layer.state = { tiles: [a, b] };
    (layer as any).renderLayers();
    expect((layer as any).sublayerCache.size).toBe(2);
    layer.state = { tiles: [a] };
    (layer as any).renderLayers();
    expect((layer as any).sublayerCache.size).toBe(1);
  });

  it('passes pre-baked triangle indices to SolidPolygonLayer when present', () => {
    // MLT-style pre-tessellation: when the tile carries `triangles`, the
    // sublayer's `data.attributes.indices` slot must be wired up so the
    // PolygonTesselator skips its CPU earcut pass. The legacy path (no
    // triangles) must not allocate this attribute.
    const layer = makeLayer();
    const tile = bigPolygonTile(3);
    const f = tile.layers[0].features;
    // 3 features × 6 indices each (a square earcuts to 2 tris).
    // Indices reference global vertex positions (already shifted by the
    // decoder before reaching the layer).
    const tris = new Uint32Array([
      // feature 0: verts 0..4
      0, 1, 2, 0, 2, 3,
      // feature 1: verts 5..9
      5, 6, 7, 5, 7, 8,
      // feature 2: verts 10..14
      10, 11, 12, 10, 12, 13,
    ]);
    f.triangles = tris;
    f.triangleOffsets = new Uint32Array([0, 6, 12, 18]);
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    const attrs = built.props.data.attributes;
    expect(attrs.indices).toBeDefined();
    // Zero-copy: same Uint32Array reference as the tile carries.
    expect(attrs.indices.value).toBe(tris);
    expect(attrs.indices.size).toBe(1);
    // _normalize must remain false so deck.gl bypasses the PolygonTesselator.
    expect(built.props._normalize).toBe(false);
  });

  it('omits the indices attribute when triangles are absent (legacy CPU earcut path)', () => {
    const layer = makeLayer();
    const tile = bigPolygonTile(3);
    // tile.features.triangles is unset → CPU fallback path stays in play.
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    expect(built.props.data.attributes.indices).toBeUndefined();
  });
});
