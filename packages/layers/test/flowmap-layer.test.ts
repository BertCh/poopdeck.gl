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
import { odMatrixTile, odStaticTile, TWO_PAIRS } from './fake-od';
import { _resetWarnOnce } from '../src/lib/log';

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
    _resetWarnOnce();
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
        flowProperty: null,
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
      layer.tileSetKey = '';
      layer.nodeTable = null;
      layer._bucket0Abs = 0;
      layer._bucketWidth = 0;
      layer._numBuckets = 0;
      layer._lastStep = -1;
      // Stub the playhead (base getCurrentTime needs full layer state we omit).
      layer.getCurrentTime = () => time;
      return layer;
    };
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

  it('emits one FlowLinesLayer per tile plus one node ScatterplotLayer overlay', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const sublayers = layer.renderLayers();
    expect(sublayers.length).toBe(2); // 1 flow tile + 1 node overlay
    // Flow layer carries the binary {length, attributes} shape.
    const flow = sublayers[0];
    expect(flow.props.data.length).toBe(2);
    expect(flow.props.data.attributes.getSourcePosition.value).toBeInstanceOf(
      Float64Array,
    );
    expect(flow.props.data.attributes.getWidth.size).toBe(1);
    // Per-instance endpoint insets (source/target node radii in px).
    expect(flow.props.data.attributes.getEndpointOffsets.size).toBe(2);
    expect(flow.props.data.attributes.getEndpointOffsets.value).toBeInstanceOf(
      Float32Array,
    );
  });

  it('drives arrow width from the active bucket; zero-flow arrows collapse to width 0', () => {
    // t=0 → bucket 0: pair0 flow 10 (visible), pair1 flow 0 (hidden).
    const widthsAt = (time: number) => {
      const layer = makeLayer(time);
      layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
      return layer.renderLayers()[0].props.data.attributes.getWidth
        .value as Float32Array;
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
    const nodes = nodeRows(layer.renderLayers()[1]);
    // Two endpoints of the single active arc: A(0,0) and B(1,1).
    expect(nodes.length).toBe(2);
    const radii = nodes.map((n) => n.radius).sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(Math.sqrt(10)); // nodeRadiusScale 1 · sqrt(incident)
    expect(radii[1]).toBeCloseTo(Math.sqrt(10));
    // Positions ride binary XYZ attributes, not per-node JS objects.
    expect(nodes.map((n) => n.position)).toEqual([
      [0, 0, 0],
      [1, 1, 0],
    ]);
  });

  it('interns node identity ONCE per tile set, not per playhead sub-step', () => {
    // The ~1 m coordinate keys are the expensive half of node aggregation and
    // depend only on the tile set — re-running them at 5–10 Hz was the churn.
    const layer = makeLayer(0);
    const tiles = [odMatrixTile(TWO_PAIRS)];
    layer.state = { tiles };
    layer.renderLayers();
    const table = layer.nodeTable;
    expect(table).toBeTruthy();
    expect(table.count).toBe(4); // 2 corridors × 2 endpoints, all distinct

    // Advance the playhead (new sub-step, same tiles) — same table object.
    layer.getCurrentTime = () => 1000;
    layer.renderLayers();
    expect(layer.nodeTable).toBe(table);

    // A different tile SET re-interns.
    layer.state = {
      tiles: [odMatrixTile(TWO_PAIRS, { z: 12, x: 9, y: 9, t: 0 })],
    };
    layer.renderLayers();
    expect(layer.nodeTable).not.toBe(table);
  });

  it('gives the node overlay a single-namespaced id', () => {
    const layer = makeLayer(0);
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    // Not `flow-nodes-flow-nodes` — the instanceKey is a short constant.
    expect(layer.renderLayers()[1].props.id).toBe('flow-nodes-all');
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
    const layer = makeLayer(0, {
      sourceColor: [1, 2, 3, 255],
      targetColor: [4, 5, 6, 255],
      gap: 0.8,
    });
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

  describe('sublayer cache invalidation', () => {
    // Everything getSubLayerProps() bakes into a sublayer at construction time
    // has to be in the cache digest, or the change never reaches the layer tree.
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
      ['highlightColor', (p: any) => (p.highlightColor = [1, 2, 3, 4])],
      ['coordinateSystem', (p: any) => (p.coordinateSystem = 2)],
      ['modelMatrix', (p: any) => (p.modelMatrix = [1, 0, 0, 0])],
      ['parameters', (p: any) => (p.parameters = { depthTest: false })],
      ['operation', (p: any) => (p.operation = 'mask')],
      [
        '_subLayerProps',
        (p: any) => (p._subLayerProps = { flows: { gap: 3 } }),
      ],
      ['updateTriggers', (p: any) => (p.updateTriggers = { all: 7 })],
      ['widthScale', (p: any) => (p.widthScale = 4)],
      ['minFlow', (p: any) => (p.minFlow = 9)],
      ['nodeRadiusScale', (p: any) => (p.nodeRadiusScale = 4)],
    ])('rebuilds the arrow sublayers when %s changes', (_name, mutate) => {
      expect(rebuildsOn(mutate as (p: any) => void)).toBe(true);
    });

    it('rebuilds cached arrows when a NEW tile grows a shared hub', () => {
      // Endpoint insets are the node radii aggregated across ALL visible tiles,
      // so a new tile feeding an already-visible station must invalidate the
      // pre-existing tile's arrows — otherwise its arrowheads stay buried under
      // the (now larger) node circle.
      const a = odMatrixTile(TWO_PAIRS, { z: 12, x: 1, y: 1, t: 0 });
      // Same origin station A(0,0) → a third destination, also active at t=0.
      const b = odMatrixTile(
        [{ source: [0, 0], target: [5, 5], flows: [90, 0, 0] }],
        { z: 12, x: 2, y: 2, t: 0 },
      );

      const layer = makeLayer(0);
      layer.state = { tiles: [a] };
      const alone = layer.renderLayers();
      const insetAlone = alone[0].props.data.attributes.getEndpointOffsets
        .value[0] as number;

      layer.state = { tiles: [a, b] };
      const together = layer.renderLayers();
      expect(together[0]).not.toBe(alone[0]); // NOT a stale cache hit
      const insetTogether = together[0].props.data.attributes.getEndpointOffsets
        .value[0] as number;
      // A's circle grew (10 → 100 incident flow), so its arrows inset further.
      expect(insetTogether).toBeGreaterThan(insetAlone);
    });
  });

  describe('flow magnitude fallback', () => {
    it('reads a per-feature numeric column when the tile has no bucket matrix', () => {
      // An OD archive built WITHOUT the value matrix used to render every
      // corridor at width 0 — indistinguishable from a failed load.
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
      const w = sublayers[0].props.data.attributes.getWidth
        .value as Float32Array;
      expect(w[0]).toBeCloseTo(4); // widthScale 1 · sqrt(16)
      expect(w[1]).toBe(0); // below minFlow → still invisible
      // Node circles come along for the ride.
      expect(nodeRows(sublayers[1]).length).toBe(2);
    });

    it('honors an explicit flowProperty over the auto-probe', () => {
      const layer = makeLayer(0, { flowProperty: 'volume' });
      layer.state = {
        tiles: [
          odStaticTile([{ source: [0, 0], target: [1, 1] }], [25], 'volume'),
        ],
      };
      const w = layer.renderLayers()[0].props.data.attributes.getWidth.value;
      expect(w[0]).toBeCloseTo(5);
    });

    it('warns once when neither a matrix nor a magnitude column is present', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const layer = makeLayer(0);
      layer.state = {
        tiles: [odStaticTile([{ source: [0, 0], target: [1, 1] }], [], null)],
      };
      const sublayers = layer.renderLayers();
      expect(sublayers[0].props.data.attributes.getWidth.value[0]).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/neither a per-bucket/);
      warn.mockRestore();
    });
  });

  it('strips forwarded extensions (they can never reach the custom shaders)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class FakeDataFilterExtension {}
    const layer = makeLayer(0, { extensions: [new FakeDataFilterExtension()] });
    layer.state = { tiles: [odMatrixTile(TWO_PAIRS)] };
    const flow = layer.renderLayers()[0];
    expect(flow.props.extensions).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/FakeDataFilterExtension/);
    warn.mockRestore();
  });
});
