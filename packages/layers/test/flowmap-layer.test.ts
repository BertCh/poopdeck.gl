/**
 * FlowmapLayer — animated OD flowmap on the vertexValueMatrix decode.
 *
 * Each OD-pair feature carries a `[2 × numBuckets]` per-bucket count matrix.
 * The layer reads the active bucket (blended across a sub-step) as the per-arc
 * flow → arc width, and sums incident flow at endpoints → node-circle radius.
 * These tests exercise the real renderLayers / widthsFor / node-aggregation
 * paths via Object.create, mocking the GPU sublayers (FlowLinesLayer /
 * ScatterplotLayer just stash props) and deck's CompositeLayer contract. The
 * FlowLinesLayer module is mocked here so its real luma.gl shader/Model import
 * never loads under the test harness.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { odMatrixTile, TWO_PAIRS } from './fake-od';

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

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

describe('FlowmapLayer', () => {
  let LayerCtor: any;
  let makeLayer: (time: number, opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/summary/flowmap-layer');
    LayerCtor = mod.FlowmapLayer as any;

    makeLayer = (time: number, opts: any = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'flow',
        widthScale: 1,
        widthMinPixels: 1,
        widthMaxPixels: 12,
        nodeRadiusScale: 1,
        nodeRadiusMinPixels: 1.5,
        nodeRadiusMaxPixels: 28,
        minFlow: 0.25,
        sourceColor: [56, 196, 232, 235],
        targetColor: [255, 142, 64, 245],
        nodeColor: [232, 238, 255, 170],
        nodeLineColor: [255, 255, 255, 220],
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer.geomCache = new Map();
      layer.arcCache = new Map();
      layer.lastTilesRef = null;
      layer.lastPropsKey = '';
      layer._bucket0Abs = 0;
      layer._bucketWidth = 0;
      layer._numBuckets = 0;
      layer._lastStep = -1;
      // Stub the playhead (base getCurrentTime needs full layer state we omit).
      layer.getCurrentTime = () => time;
      return layer;
    };
  });

  it('emits one FlowLinesLayer per tile plus one node ScatterplotLayer overlay', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const sublayers = layer.renderLayers();
    expect(sublayers.length).toBe(2); // 1 flow tile + 1 node overlay
    // Flow layer carries the binary {length, attributes} shape.
    const flow = sublayers[0];
    expect(flow.props.data.length).toBe(2);
    expect(flow.props.data.attributes.getSourcePosition.value).toBeInstanceOf(Float64Array);
    expect(flow.props.data.attributes.getWidth.size).toBe(1);
    // Per-instance endpoint insets (source/target node radii in px).
    expect(flow.props.data.attributes.getEndpointOffsets.size).toBe(2);
    expect(flow.props.data.attributes.getEndpointOffsets.value).toBeInstanceOf(Float32Array);
  });

  it('drives arrow width from the active bucket; zero-flow arrows collapse to width 0', () => {
    // t=0 → bucket 0: pair0 flow 10 (visible), pair1 flow 0 (hidden).
    const widthsAt = (time: number) => {
      const layer = makeLayer(time);
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      return layer.renderLayers()[0].props.data.attributes.getWidth.value as Float32Array;
    };
    const w0 = widthsAt(0);
    expect(w0[0]).toBeCloseTo(Math.sqrt(10)); // widthScale 1 · sqrt(flow)
    expect(w0[1]).toBe(0);

    // t=1000 → bucket 1: pair0 flow 0 (hidden), pair1 flow 8 (visible).
    const w1 = widthsAt(1000);
    expect(w1[0]).toBe(0);
    expect(w1[1]).toBeCloseTo(Math.sqrt(8));

    // t=2000 → bucket 2: pair0 flow 5, pair1 flow 0.
    const w2 = widthsAt(2000);
    expect(w2[0]).toBeCloseTo(Math.sqrt(5));
    expect(w2[1]).toBe(0);
  });

  it('aggregates incident flow into node circles (only active stations appear)', () => {
    const layer = makeLayer(0); // bucket 0: only pair0 (A→B) active at flow 10
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const nodeLayer = layer.renderLayers()[1];
    const nodes = nodeLayer.props.data as { position: number[]; radius: number }[];
    // Two endpoints of the single active arc: A(0,0) and B(1,1).
    expect(nodes.length).toBe(2);
    const radii = nodes.map((n) => n.radius).sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(Math.sqrt(10)); // nodeRadiusScale 1 · sqrt(incident)
    expect(radii[1]).toBeCloseTo(Math.sqrt(10));
  });

  it('caches the FlowLinesLayer instance across renders at the same playhead', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const first = layer.renderLayers();
    const second = layer.renderLayers();
    expect(second[0]).toBe(first[0]); // same sub-step → cached arrow reused
  });

  it('prunes caches for tiles that leave the visible set', () => {
    const layer = makeLayer(0);
    const a = odMatrixTile(TWO_PAIRS);
    a.id = { z: 12, x: 1, y: 1, t: 0 } as any;
    const b = odMatrixTile(TWO_PAIRS);
    b.id = { z: 12, x: 2, y: 2, t: 0 } as any;
    layer.state = { tiles: [a, b] };
    layer.renderLayers();
    expect(layer.geomCache.size).toBe(2);
    layer.state = { tiles: [a] };
    layer.renderLayers();
    expect(layer.geomCache.size).toBe(1);
  });

  it('passes constant source/target colors and gap through to the sublayer', () => {
    const layer = makeLayer(0, { sourceColor: [1, 2, 3, 255], targetColor: [4, 5, 6, 255], gap: 0.8 });
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const flow = layer.renderLayers()[0];
    expect(flow.props.sourceColor).toEqual([1, 2, 3, 255]);
    expect(flow.props.targetColor).toEqual([4, 5, 6, 255]);
    expect(flow.props.gap).toBe(0.8);
    expect(flow.props.positionFormat).toBe('XY');
  });

  it('returns [] when there are no tiles', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [] };
    expect(layer.renderLayers()).toEqual([]);
  });
});
