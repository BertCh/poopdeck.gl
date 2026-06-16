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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';

const h = vi.hoisted(() => ({
  supported: true as boolean,
  staticSupported: true as boolean,
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
  // (the real arc-length subdivide is unit-tested in edge-bundler.test.ts).
  const subdivide = (pts: number[][], n: number) => {
    const a = pts[0];
    const b = pts[pts.length - 1];
    return Array.from({ length: n }, (_, i) => {
      const f = n > 1 ? i / (n - 1) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    });
  };
  return {
    EdgeBundler: FakeEdgeBundler,
    StaticBundle: FakeStaticBundle,
    isBundlingSupported: () => h.supported,
    isStaticBundleSupported: () => h.staticSupported,
    subdivide,
  };
});

vi.mock('@deck.gl/core', async () => (await import('./fake-deck-core')).createDeckCoreMock());

function odMatrixTile(
  features: { source: [number, number]; target: [number, number]; flows: number[] }[],
  id: { z: number; x: number; y: number; t: number } = { z: 12, x: 1, y: 1, t: 0 },
): Tile {
  const n = features.length;
  const nb = features[0].flows.length;
  const positions = new Float64Array(n * 2 * 2);
  const startIndices = new Uint32Array(n + 1);
  const matrix = new Float32Array(n * 2 * nb);
  for (let i = 0; i < n; i++) {
    startIndices[i] = i * 2;
    positions[i * 4] = features[i].source[0];
    positions[i * 4 + 1] = features[i].source[1];
    positions[i * 4 + 2] = features[i].target[0];
    positions[i * 4 + 3] = features[i].target[1];
    for (let b = 0; b < nb; b++) {
      matrix[i * 2 * nb + b] = features[i].flows[b];
      matrix[(i * 2 + 1) * nb + b] = features[i].flows[b];
    }
  }
  startIndices[n] = n * 2;

  const binary: BinaryFeatures = {
    featureCount: n,
    geometryType: 1 as any,
    positionDimensions: 2,
    positions,
    startIndices,
    featureIds: new Uint32Array(n),
    startTimes: new Float32Array(n).fill(0),
    endTimes: new Float32Array(n).fill(nb * 1000),
    timeOffset: 0,
    vertexValueMatrix: matrix,
    vertexValueBuckets: nb,
    numericProps: {},
    categoricalProps: {},
  };
  return {
    id: id as any,
    timeRange: { start: 0, end: nb * 1000 } as any,
    layers: [
      {
        name: 'layer0',
        extent: 4096,
        features: binary,
        geometryExtensionName: 'geoarrow.linestring',
      } as any,
    ],
  } as any;
}

const TWO_PAIRS = [
  { source: [0, 0] as [number, number], target: [1, 1] as [number, number], flows: [10, 0, 5] },
  { source: [2, 2] as [number, number], target: [3, 3] as [number, number], flows: [0, 8, 0] },
];

describe('BundledFlowmapLayer', () => {
  let LayerCtor: any;
  let makeLayer: (time: number, opts?: any) => any;
  let createdTextures: any[];

  beforeEach(async () => {
    vi.resetModules();
    h.supported = true;
    h.staticSupported = true;
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
        greatCircle: false,
        arcHeight: 0.5,
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
      layer._bundleRafId = null;
      layer._bucket0Abs = 0;
      layer._bucketWidth = 0;
      layer._numBuckets = 0;
      layer._lastStep = -1;
      layer.context = { device: fakeDevice };
      layer.getCurrentTime = () => time;
      // Avoid scheduling real rAF timers in the test harness.
      layer.scheduleBundleStep = () => {};
      return layer;
    };
  });

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
    const nodes = layer.renderLayers()[1].props.data as { position: number[]; radius: number }[];
    expect(nodes.length).toBe(2);
    expect(nodes.map((n) => n.radius)).toEqual([Math.sqrt(10), Math.sqrt(10)]);
  });

  it('bundles the UNION of visible tiles in ONE bundler, rebuilding (and disposing) on change', () => {
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

    // Removing a tile changes the visible-set signature → rebuild for {b} (2
    // edges) and dispose the old bundle's GPU resources.
    layer.state = { tiles: [b] };
    layer.renderLayers();
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
});
