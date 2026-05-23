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

describe('AnimatedPathLayer.createConsolidatedPathLayer', () => {
  let buildLayer: (tile: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/animated-path-layer');
    const LayerCtor = mod.AnimatedPathLayer as any;

    buildLayer = (tile) => {
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
      const data = (layer as any).buildConsolidatedData([tile]);
      return (layer as any).createConsolidatedPathLayer(data);
    };
  });

  it('path accessor returns a zero-copy SUBARRAY view, not a fresh number[]', () => {
    const N = 100;
    const V = 50; // 50 vertices per path
    const layer = buildLayer(bigPathTile(N, V));
    const features = layer.props.data;

    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBe(N);

    // Every per-feature path must be a typed array (subarray view), not a
    // freshly-allocated number[] of length n*dims. The previous code
    // allocated `new Array(n * dims)` and copied every vertex per feature.
    for (const f of features) {
      expect(f.path).toBeInstanceOf(Float64Array);
      // The view's byteLength corresponds to V*dims*8 bytes (Float64Array).
      expect(f.path.length % V).toBe(0); // n*dims, dims is 2 or 3
    }

    // All subarrays should share the same underlying buffer as the
    // consolidated positions array — that is the "zero-copy" guarantee.
    const sharedBuffer = features[0].path.buffer;
    for (const f of features) {
      expect(f.path.buffer).toBe(sharedBuffer);
    }
  });

  it('sets positionFormat:"XY" so 2D flat paths are not misread as 3D', () => {
    // makePathTile produces 2D positions (positionDimensions=2). Without an
    // explicit positionFormat, PathLayer defaults to 'XYZ', which would slice
    // a flat [lon0, lat0, lon1, lat1] array into garbage 3-tuples.
    const layer = buildLayer(bigPathTile(5, 4));
    expect(layer.props.positionFormat).toBe('XY');
    // Sanity: every path subarray length is divisible by 2 (the matching stride).
    for (const f of layer.props.data) {
      expect(f.path.length % 2).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AnimatedTripsLayer
// ---------------------------------------------------------------------------

describe('AnimatedTripsLayer.createConsolidatedPathLayer', () => {
  it('sets positionFormat from consolidated dims so 2D paths render correctly', async () => {
    vi.resetModules();
    const mod = await import('../src/animated-trips-layer');
    const LayerCtor = mod.AnimatedTripsLayer as any;

    const layer = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'trips',
      tripColor: [253, 128, 93, 255],
      tripWidth: 2,
      timeWindow: 1000,
      trailLength: 500,
      opacity: 1,
      visible: true,
    };
    layer._currentTime = 0;
    layer.timeFilterExtension = {}; // unused by the path under test
    (layer as any).getEffectiveTimeWindow = () => 1000;

    const tile = bigPathTile(3, 4);
    const data = (layer as any).buildConsolidatedData([tile]);
    const built = (layer as any).createConsolidatedPathLayer(data);

    // Same root cause as AnimatedPathLayer: PathLayer defaults positionFormat
    // to 'XYZ' and would misread 2D flat paths without an override.
    expect(built.props.positionFormat).toBe('XY');
    // Every per-feature path/vertexTimes is a zero-copy subarray view.
    for (const f of built.props.data) {
      expect(f.path).toBeInstanceOf(Float64Array);
      expect(f.vertexTimes).toBeInstanceOf(Float32Array);
    }

    // getInstanceVertexTime must return the WHOLE per-feature vertex-times
    // array. If it returns a single number (e.g. `d.vertexTimes[info.index]`),
    // deck.gl applies that one value to every vertex of the feature, which
    // makes entire paths flash on/off instead of producing a trailing animation.
    const accessor = built.props.getInstanceVertexTime;
    const sample = built.props.data[0];
    const result = accessor(sample, { index: 0 });
    expect(result).toBeInstanceOf(Float32Array);
    expect(result).toBe(sample.vertexTimes);
    // Different vertex times across the feature — trail interpolation relies
    // on this. (4 vertices over [0, 1000] gives 0, 333.33, 666.66, 1000.)
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).not.toBe(result[result.length - 1]);
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
