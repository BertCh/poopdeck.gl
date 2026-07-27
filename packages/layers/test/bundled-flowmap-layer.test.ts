/**
 * BundledFlowmapLayer — FlowmapLayer with GPU force-directed edge bundling.
 *
 * The GPU bundler + GPU-resident renderer need a device, so these tests mock
 * {@link EdgeBundler} and the sublayers and exercise the device-free composite
 * logic via Object.create: that a supported tile builds the per-edge flow-matrix
 * texture + bundler and renders a (GPU-width) BundledFlowLinesLayer, that an
 * unsupported / oversized tile falls back to straight FlowLinesLayer arrows with
 * CPU widths, that the bundle is built once and reused, that node aggregation is
 * unchanged, and that pruning destroys the GPU resources.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { odMatrixTile, odStaticTile, TWO_PAIRS } from './fake-od';
import { _resetWarnOnce } from '../src/lib/log';

const h = vi.hoisted(() => ({
  supported: true as boolean,
  staticSupported: true as boolean,
  /** Device texture-size ceiling the mocked maxBundleEdges reports. */
  textureLimit: 16384 as number,
  bundlers: [] as any[],
  staticBundles: [] as any[],
}));

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { ScatterplotLayer: FakeScatterplotLayer };
});

vi.mock('../src/layers/internal/flow-lines-layer', () => {
  class FakeFlowLinesLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { FlowLinesLayer: FakeFlowLinesLayer };
});

vi.mock('../src/layers/internal/bundled-flow-lines-layer', () => {
  class FakeBundledFlowLinesLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { BundledFlowLinesLayer: FakeBundledFlowLinesLayer };
});

vi.mock('../src/lib/edge-bundler', () => {
  class FakeEdgeBundler {
    opts: any;
    cosLat0: number;
    edgeCount: number;
    pointCount: number;
    positionTexture = { __tag: 'postex' };
    destroyed = false;
    private done = false;
    originX = 0;
    originY = 0;
    scale = 1;
    constructor(opts: any) {
      this.opts = opts;
      this.cosLat0 = opts.cosLat0;
      this.edgeCount = opts.edgeCount;
      this.pointCount = opts.pointCount;
      h.bundlers.push(this);
    }
    stepCycle() {
      this.done = true;
      return true;
    }
    isDone() {
      return this.done;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  // Baked counterpart: holds control points, never relaxes. Records itself so a
  // test can assert the composite chose the static (not live) path.
  class FakeStaticBundle {
    opts: any;
    cosLat0: number;
    edgeCount: number;
    pointCount: number;
    positionTexture = { __tag: 'static-postex' };
    destroyed = false;
    originX = 0;
    originY = 0;
    scale = 1;
    constructor(opts: any) {
      this.opts = opts;
      this.cosLat0 = opts.cosLat0;
      this.edgeCount = opts.edgeCount;
      this.pointCount = opts.pointCount;
      h.staticBundles.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  // Simple linear resampler — enough for the straight 2-vertex OD fixtures here
  // (the real arc-length resampleInto is unit-tested in edge-bundler.test.ts).
  const resampleInto = (
    positions: ArrayLike<number>,
    dims: number,
    v0: number,
    v1: number,
    count: number,
    out: Float64Array,
    outPoint0: number,
  ) => {
    const ax = positions[v0 * dims];
    const ay = positions[v0 * dims + 1];
    const bx = positions[(v1 - 1) * dims];
    const by = positions[(v1 - 1) * dims + 1];
    for (let i = 0; i < count; i++) {
      const f = count > 1 ? i / (count - 1) : 0;
      const o = (outPoint0 + i) * dims;
      out[o] = ax + (bx - ax) * f;
      out[o + 1] = ay + (by - ay) * f;
    }
  };
  return {
    EdgeBundler: FakeEdgeBundler,
    StaticBundle: FakeStaticBundle,
    isBundlingSupported: () => h.supported,
    isStaticBundleSupported: () => h.staticSupported,
    maxBundleEdges: (_device: any, P: number, nb: number) =>
      P > h.textureLimit || nb > h.textureLimit ? 0 : h.textureLimit,
    resampleInto,
  };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

describe('BundledFlowmapLayer', () => {
  let LayerCtor: any;
  let makeLayer: (time: number, opts?: any) => any;
  let createdTextures: any[];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    _resetWarnOnce();
    h.supported = true;
    h.staticSupported = true;
    h.textureLimit = 16384;
    h.bundlers = [];
    h.staticBundles = [];
    createdTextures = [];
    const mod = await import('../src/layers/summary/bundled-flowmap-layer');
    LayerCtor = mod.BundledFlowmapLayer as any;

    const fakeDevice = {
      createTexture: (props: any) => {
        const tex = {
          ...props,
          data: null as Float32Array | null,
          destroyed: false,
          copyImageData({ data }: { data: Float32Array }) {
            this.data = data;
          },
          destroy() {
            this.destroyed = true;
          },
        };
        createdTextures.push(tex);
        return tex;
      },
    };

    makeLayer = (time: number, opts: any = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'bf',
        widthScale: 1,
        widthMinPixels: 1,
        widthMaxPixels: 12,
        gap: 0.5,
        nodeRadiusScale: 1,
        nodeRadiusMinPixels: 1.5,
        nodeRadiusMaxPixels: 28,
        minFlow: 0.25,
        sourceColor: [56, 196, 232, 235],
        targetColor: [255, 142, 64, 245],
        nodeColor: [232, 238, 255, 170],
        nodeLineColor: [255, 255, 255, 220],
        subdivisionPoints: 24,
        kernelRadius: 0.05,
        bundlingIterations: 15,
        smoothingStrength: 0.5,
        maxBundledEdges: 4000,
        preBundled: false,
        flowProperty: null,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer.geomCache = new Map();
      layer.bundle = null;
      layer.bundleSig = '';
      layer.bundledLayer = null;
      layer.bundledLayerKey = '';
      layer.fallbackCache = new Map();
      layer.lastTilesRef = null;
      layer.lastPropsKey = '';
      layer.tileSetKey = '';
      layer.nodeTable = null;
      layer.pendingSig = '';
      layer._rebuildTimer = null;
      layer._bundleEpoch = 0;
      layer._bundleRafId = null;
      layer._bucket0Abs = 0;
      layer._bucketWidth = 0;
      layer._numBuckets = 0;
      layer._lastStep = -1;
      layer.context = { device: fakeDevice };
      layer.getCurrentTime = () => time;
      // Avoid scheduling real rAF timers in the test harness.
      layer.scheduleBundleStep = () => {};
      layer.setState = () => {};
      return layer;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Node overlay rows, decoded from the binary attributes it now carries. */
  const nodeRows = (
    nodeLayer: any,
  ): { position: [number, number, number]; radius: number }[] => {
    const { length, attributes } = nodeLayer.props.data;
    const pos = attributes.getPosition.value as Float64Array;
    const rad = attributes.getRadius.value as Float32Array;
    return Array.from({ length }, (_, i) => ({
      position: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as [
        number,
        number,
        number,
      ],
      radius: rad[i],
    }));
  };

  it('renders one merged GPU BundledFlowLinesLayer for the visible set + a node overlay', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const sublayers = layer.renderLayers();
    expect(sublayers.length).toBe(2);
    const flow = sublayers[0];
    // GPU-resident: driven by edge/segment indices, NOT a CPU width buffer.
    expect(flow.props.data.attributes.getEdgeIndex.size).toBe(1);
    expect(flow.props.data.attributes.getSegmentIndex.size).toBe(1);
    expect(flow.props.data.attributes.getWidth).toBeUndefined();
    // segments = P - 1; instance count = E * segments.
    expect(flow.props.segments).toBe(23);
    expect(flow.props.data.length).toBe(2 * 23);
    // Carries the live bundler + flow-matrix texture + a live-time closure.
    expect(flow.props.bundler).toBe(h.bundlers[0]);
    expect(flow.props.matrixTexture).toBeTruthy();
    expect(typeof flow.props.getCurrentTime).toBe('function');
  });

  it('builds a per-edge flow-matrix texture spanning ALL buckets (GPU width animation)', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    layer.renderLayers();
    const matrixTex = createdTextures.find((t) => t.format === 'r32float');
    expect(matrixTex).toBeTruthy();
    // numBuckets × edgeCount, row-major by edge.
    expect(matrixTex.width).toBe(3); // buckets
    expect(matrixTex.height).toBe(2); // edges
    // Row 0 = edge 0's series [10,0,5]; row 1 = edge 1's series [0,8,0].
    expect(Array.from(matrixTex.data.slice(0, 3))).toEqual([10, 0, 5]);
    expect(Array.from(matrixTex.data.slice(3, 6))).toEqual([0, 8, 0]);
  });

  it('passes the KDEEB tuning props through to the bundler', () => {
    const layer = makeLayer(0, {
      subdivisionPoints: 16,
      kernelRadius: 0.1,
      bundlingIterations: 20,
      smoothingStrength: 0.7,
    });
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    layer.renderLayers();
    const b = h.bundlers[0];
    expect(b.opts.pointCount).toBe(16);
    expect(b.opts.kernelRadiusFraction).toBe(0.1);
    expect(b.opts.iterations).toBe(20);
    expect(b.opts.smoothingStrength).toBe(0.7);
    expect(b.edgeCount).toBe(2);
    // Control points are resampled per edge: E * P * dims.
    const cp = b.opts.controlPoints as Float64Array;
    expect(cp.length).toBe(2 * 16 * 2);
    // Edge 0 = OD pair [0,0]→[1,1]: endpoints preserved, interior collinear.
    expect([cp[0], cp[1]]).toEqual([0, 0]); // point 0
    expect([cp[30], cp[31]]).toEqual([1, 1]); // point 15 (last)
    expect(cp[16]).toBeCloseTo(cp[17], 9); // point 8 lies on the x=y diagonal
    // cosLat0 ∈ (0,1], computed from the tile's mean latitude.
    expect(b.cosLat0).toBeGreaterThan(0);
    expect(b.cosLat0).toBeLessThanOrEqual(1);
  });

  it('renders a baked StaticBundle (no live relaxation) when preBundled, even with the live bundler unsupported', () => {
    // The live GPU bundler is unsupported here; the baked path must still render
    // because it gates on the laxer isStaticBundleSupported (no float blend).
    h.supported = false;
    h.staticSupported = true;
    const layer = makeLayer(0, { preBundled: true });
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const sublayers = layer.renderLayers();
    expect(sublayers.length).toBe(2);
    // Chose the static bundle, not a live EdgeBundler.
    expect(h.staticBundles.length).toBe(1);
    expect(h.bundlers.length).toBe(0);
    // Final immediately — no relaxation frames scheduled.
    expect(layer.bundle.status).toBe('ready');
    const flow = sublayers[0];
    expect(flow.props.bundler).toBe(h.staticBundles[0]);
    // Still GPU-resident geometry (edge/segment indices, no CPU width buffer).
    expect(flow.props.data.attributes.getEdgeIndex.size).toBe(1);
    expect(flow.props.data.attributes.getWidth).toBeUndefined();
    expect(flow.props.segments).toBe(23); // P - 1
    // Baked control points resampled per edge: E * P * dims.
    const cp = h.staticBundles[0].opts.controlPoints as Float64Array;
    expect(cp.length).toBe(2 * 24 * 2);
  });

  it('falls back to straight arrows when preBundled but no float texture is available', () => {
    h.supported = false;
    h.staticSupported = false;
    const layer = makeLayer(0, { preBundled: true });
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const flow = layer.renderLayers()[0];
    expect(h.staticBundles.length).toBe(0);
    expect(layer.bundle.status).toBe('fallback');
    // Degrades to endpoint-to-endpoint straight arrows with CPU widths.
    expect(flow.props.data.attributes.getWidth.size).toBe(1);
    expect(flow.props.bundler).toBeUndefined();
  });

  it('falls back to straight FlowLinesLayer arrows (CPU widths) when bundling is unsupported', () => {
    h.supported = false;
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const flow = layer.renderLayers()[0];
    // Straight-arrow path carries the CPU width buffer; no bundler.
    expect(flow.props.data.attributes.getWidth.size).toBe(1);
    expect(flow.props.bundler).toBeUndefined();
    const w = flow.props.data.attributes.getWidth.value as Float32Array;
    // t=0 bucket 0: edge 0 flow 10 (visible), edge 1 flow 0 (collapsed to 0).
    expect(w[0]).toBeCloseTo(Math.sqrt(10));
    expect(w[1]).toBe(0);
    expect(h.bundlers.length).toBe(0);
  });

  it('falls back when a tile exceeds maxBundledEdges', () => {
    const layer = makeLayer(0, { maxBundledEdges: 1 });
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const flow = layer.renderLayers()[0];
    expect(flow.props.data.attributes.getWidth).toBeTruthy();
    expect(h.bundlers.length).toBe(0);
  });

  it('builds the bundle once and reuses the sublayer across renders', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const first = layer.renderLayers();
    const second = layer.renderLayers();
    expect(second[0]).toBe(first[0]); // cached bundled sublayer reused
    expect(h.bundlers.length).toBe(1); // bundler constructed exactly once
  });

  it('aggregates incident flow into node circles (CPU path unchanged)', () => {
    const layer = makeLayer(0); // bucket 0: only edge 0 active at flow 10
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const nodes = nodeRows(layer.renderLayers()[1]);
    expect(nodes.length).toBe(2);
    // f32 attribute — compare with tolerance, not bit equality.
    expect(nodes[0].radius).toBeCloseTo(Math.sqrt(10), 6);
    expect(nodes[1].radius).toBeCloseTo(Math.sqrt(10), 6);
    expect(layer.renderLayers()[1].props.id).toBe('bf-nodes-all');
  });

  it('bundles the UNION of visible tiles in ONE bundler, rebuilding (and disposing) once the set settles', () => {
    const layer = makeLayer(0);
    const a = odMatrixTile(TWO_PAIRS, { z: 12, x: 1, y: 1, t: 0 });
    const b = odMatrixTile(TWO_PAIRS, { z: 12, x: 2, y: 2, t: 0 });
    layer.state = { tiles: [a, b] };
    const sublayers = layer.renderLayers();
    // ONE merged bundle (2 tiles × 2 edges = 4) + node overlay — NOT one per tile.
    expect(h.bundlers.length).toBe(1);
    expect(h.bundlers[0].edgeCount).toBe(4);
    expect(sublayers.length).toBe(2);
    const bundlerA = h.bundlers[0];
    const matrixA = createdTextures.find((t) => t.format === 'r32float');

    // Removing a tile changes the visible-set signature. The rebuild is
    // DEBOUNCED (see below), so the old bundle keeps rendering until the set
    // has been quiet — then it rebuilds for {b} (2 edges) and disposes the old
    // bundle's GPU resources.
    layer.state = { tiles: [b] };
    layer.renderLayers();
    expect(bundlerA.destroyed).toBe(false);
    vi.advanceTimersByTime(200);
    expect(bundlerA.destroyed).toBe(true);
    expect(matrixA!.destroyed).toBe(true);
    expect(h.bundlers.length).toBe(2);
    expect(h.bundlers[1].edgeCount).toBe(2);
  });

  it('returns [] when there are no tiles', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [] };
    expect(layer.renderLayers()).toEqual([]);
  });

  describe('device texture limits', () => {
    it('falls back rather than allocating a texture taller than the device allows', () => {
      // Both bundle textures are `edgeCount` rows tall. A 30k-edge corridor
      // tier asked for a 48×30000 texture — over the 8192/16384 limit on
      // essentially every GPU — and luma threw from inside renderLayers, which
      // blanked the whole layer tree (after a ~23 MB Float64Array).
      h.textureLimit = 1;
      const layer = makeLayer(0);
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      const flow = layer.renderLayers()[0];
      expect(layer.bundle.status).toBe('fallback');
      expect(h.bundlers.length).toBe(0);
      expect(flow.props.data.attributes.getWidth.size).toBe(1); // straight arrows
    });

    it('applies the ceiling to the preBundled path too', () => {
      // The maxBundledEdges guard was explicitly skipped for baked bundles, so
      // `preBundled: true` walked straight into createTexture.
      h.textureLimit = 1;
      const layer = makeLayer(0, { preBundled: true });
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      const flow = layer.renderLayers()[0];
      expect(h.staticBundles.length).toBe(0);
      expect(layer.bundle.status).toBe('fallback');
      expect(flow.props.data.attributes.getWidth.size).toBe(1);
    });

    it('says the ceiling is hardware, not a prop to raise', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.textureLimit = 1;
      const layer = makeLayer(0);
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      layer.renderLayers();
      expect(warn.mock.calls[0][0]).toMatch(/hardware ceiling/);
      expect(warn.mock.calls[0][0]).not.toMatch(/Raise maxBundledEdges/);
      warn.mockRestore();
    });

    it('degrades to straight arrows when GPU allocation throws', () => {
      // Belt and braces: this all runs inside deck's synchronous render
      // callback, so ANY driver-side refusal must not escape renderLayers.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const layer = makeLayer(0);
      layer.context = {
        device: {
          createTexture: () => {
            throw new Error('out of memory');
          },
        },
      };
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      const sublayers = layer.renderLayers();
      expect(layer.bundle.status).toBe('fallback');
      expect(sublayers[0].props.data.attributes.getWidth.size).toBe(1);
      expect(warn.mock.calls[0][0]).toMatch(/out of memory/);
      warn.mockRestore();
    });
  });

  describe('bundle rebuild scheduling', () => {
    it('debounces rebuilds across a stream of tile arrivals', () => {
      // bundleSignature hashes every live tile key, so ANY arrival invalidated
      // it and re-derived the whole union synchronously inside renderLayers —
      // restarting the 15-iteration relaxation, so the rivers never converged
      // while panning.
      const layer = makeLayer(0);
      const tiles = [odMatrixTile(TWO_PAIRS, { z: 12, x: 0, y: 0, t: 0 })];
      layer.state = { tiles };
      layer.renderLayers();
      expect(h.bundlers.length).toBe(1); // first bundle is inline

      // Five tiles stream in over 5 × 50 ms — well inside the settle window.
      for (let i = 1; i <= 5; i++) {
        tiles.push(odMatrixTile(TWO_PAIRS, { z: 12, x: i, y: 0, t: 0 }));
        layer.state = { tiles: [...tiles] };
        layer.renderLayers();
        vi.advanceTimersByTime(50);
      }
      expect(h.bundlers.length).toBe(1); // still ONE — no restart per arrival

      // Once the view settles, exactly one rebuild covers the whole union.
      vi.advanceTimersByTime(200);
      expect(h.bundlers.length).toBe(2);
      expect(h.bundlers[1].edgeCount).toBe(12); // 6 tiles × 2 edges
    });

    it('does NOT rebuild on a playhead tick (the signature excludes time)', () => {
      const layer = makeLayer(0);
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      layer.renderLayers();
      expect(h.bundlers.length).toBe(1);
      for (const t of [500, 1000, 1500, 2000]) {
        layer.getCurrentTime = () => t;
        layer.renderLayers();
        vi.advanceTimersByTime(60);
      }
      vi.advanceTimersByTime(500);
      expect(h.bundlers.length).toBe(1);
      expect(layer._rebuildTimer).toBeNull();
    });
  });

  describe('sublayer cache invalidation', () => {
    const rebuildsOn = (mutate: (props: any) => void): boolean => {
      const layer = makeLayer(0);
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      const first = layer.renderLayers();
      mutate(layer.props);
      const second = layer.renderLayers();
      return second[0] !== first[0];
    };

    it.each([
      ['pickable', (p: any) => (p.pickable = true)],
      ['autoHighlight', (p: any) => (p.autoHighlight = true)],
      ['coordinateSystem', (p: any) => (p.coordinateSystem = 2)],
      ['modelMatrix', (p: any) => (p.modelMatrix = [1, 0, 0, 0])],
      ['parameters', (p: any) => (p.parameters = { depthTest: false })],
      [
        '_subLayerProps',
        (p: any) => (p._subLayerProps = { flows: { gap: 3 } }),
      ],
      ['updateTriggers', (p: any) => (p.updateTriggers = { all: 7 })],
      ['nodeRadiusScale', (p: any) => (p.nodeRadiusScale = 4)],
    ])('rebuilds the bundled sublayer when %s changes', (_name, mutate) => {
      expect(rebuildsOn(mutate as (p: any) => void)).toBe(true);
    });

    it('rebuilds cached fallback arrows when a NEW tile grows a shared hub', () => {
      h.supported = false; // force the straight-arrow path
      const a = odMatrixTile(TWO_PAIRS, { z: 12, x: 1, y: 1, t: 0 });
      const b = odMatrixTile(
        [{ source: [0, 0], target: [5, 5], flows: [90, 0, 0] }],
        {
          z: 12,
          x: 2,
          y: 2,
          t: 0,
        },
      );
      const layer = makeLayer(0);
      layer.state = { tiles: [a] };
      const alone = layer.renderLayers();
      const insetAlone = alone[0].props.data.attributes.getEndpointOffsets
        .value[0] as number;

      layer.state = { tiles: [a, b] };
      const together = layer.renderLayers();
      expect(together[0]).not.toBe(alone[0]);
      expect(
        together[0].props.data.attributes.getEndpointOffsets.value[0],
      ).toBeGreaterThan(insetAlone);
    });
  });

  it('reads a per-feature numeric column when the tile has no bucket matrix', () => {
    // No bucket axis → no GPU bundle (nothing to sample); the straight-arrow
    // fallback must still show the corridors rather than an all-zero blank map.
    const layer = makeLayer(0);
    layer.state = {
      tiles: [
        odStaticTile(
          [
            { source: [0, 0], target: [1, 1] },
            { source: [2, 2], target: [3, 3] },
          ],
          [16, 0],
        ),
      ],
    };
    const sublayers = layer.renderLayers();
    expect(layer.bundle.status).toBe('fallback');
    const w = sublayers[0].props.data.attributes.getWidth.value as Float32Array;
    expect(w[0]).toBeCloseTo(4);
    expect(w[1]).toBe(0);
    expect(nodeRows(sublayers[1]).length).toBe(2);
  });

  it('strips forwarded extensions (they can never reach the custom shaders)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class FakeDataFilterExtension {}
    const layer = makeLayer(0, { extensions: [new FakeDataFilterExtension()] });
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    expect(layer.renderLayers()[0].props.extensions).toEqual([]);
    expect(warn.mock.calls[0][0]).toMatch(/FakeDataFilterExtension/);
    warn.mockRestore();
  });
});
