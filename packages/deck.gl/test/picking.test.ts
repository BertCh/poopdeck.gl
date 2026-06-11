/**
 * Picking parity (audit item 6) + onViewportLoad settle latch (item 7).
 *
 * The GPU half of picking (picking-color attributes → info.index) is
 * upstream deck.gl; what STT owns — and what these tests lock in — is the
 * enrichment layer:
 *
 * - every animated sublayer carries its source `tile` (TileLayer convention)
 *   plus the (tile, layer) pair's decoded columns as `sttFeatures`;
 * - `SpatioTemporalLayer.getPickingInfo` decodes the picked index's binary
 *   columns into a plain `info.object` and sets `info.tile`/`info.sourceTile`;
 * - cumulative point slabs (many tiles → one sublayer) map the picked index
 *   back through per-tile provenance ranges, resolving the tile from the
 *   CURRENT visible set so evicted tiles are never pinned;
 * - `_maybeFireViewportLoad` fires `onViewportLoad` exactly once per settled
 *   selection version.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile, makePathTile } from './fake-tile';

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
// contract — see fake-deck-core.ts.
vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// H3SummaryLayer pulls in @deck.gl/geo-layers, whose real import would drag
// the (mocked-away) core internals along — stub the one class it needs.
vi.mock('@deck.gl/geo-layers', () => {
  class FakeH3HexagonLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { H3HexagonLayer: FakeH3HexagonLayer };
});

/** A tile with numeric + categorical columns for decode assertions. */
function richPointTile(tileId = { z: 1, x: 0, y: 0, t: 0 }) {
  const tile = makePointTile({
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    startTimes: [10, 20, 30],
    endTimes: [15, 25, 35],
    timeOffset: 1000,
    tileId,
  });
  const f = tile.layers[0].features;
  f.numericProps.speed = new Float32Array([1.5, 2.5, 3.5]);
  f.categoricalProps.kind = {
    indices: new Uint16Array([0, 1, 0xffff]),
    categories: ['car', 'bus'],
  };
  return tile;
}

function pickParams(index: number, sourceProps: Record<string, any> | null) {
  return {
    info: { index, picked: index >= 0 } as any,
    mode: 'query',
    sourceLayer: sourceProps ? ({ props: sourceProps } as any) : null,
  } as any;
}

// ---------------------------------------------------------------------------
// Base SpatioTemporalLayer.getPickingInfo
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer.getPickingInfo', () => {
  let layer: any;
  let tile: ReturnType<typeof richPointTile>;

  beforeEach(async () => {
    vi.resetModules();
    const { SpatioTemporalLayer } = await import('../src/spatiotemporal-layer');
    layer = Object.create((SpatioTemporalLayer as any).prototype);
    tile = richPointTile();
  });

  it('decodes the picked feature into info.object and sets tile/sourceTile', () => {
    const info = layer.getPickingInfo(
      pickParams(1, { tile, sttFeatures: tile.layers[0].features }),
    );
    expect(info.tile).toBe(tile);
    expect(info.sourceTile).toBe(tile);
    expect(info.object).toMatchObject({
      speed: 2.5,
      kind: 'bus',
      // Reserved columns reconstructed: absolute Unix ms + feature id.
      start_time: 1020,
      end_time: 1025,
      id: 0,
    });
  });

  it('decodes the categorical null sentinel (0xffff) to null', () => {
    const info = layer.getPickingInfo(
      pickParams(2, { tile, sttFeatures: tile.layers[0].features }),
    );
    expect(info.object.kind).toBeNull();
    expect(info.object.speed).toBe(3.5);
  });

  it('hover-off (index -1) leaves object/tile unset but reports sourceTile', () => {
    const info = layer.getPickingInfo(
      pickParams(-1, { tile, sttFeatures: tile.layers[0].features }),
    );
    expect(info.object).toBeUndefined();
    expect(info.tile).toBeUndefined();
    expect(info.sourceTile).toBe(tile);
  });

  it('is a safe no-op for sublayers without a tile prop', () => {
    const info = layer.getPickingInfo(pickParams(1, {}));
    expect(info.object).toBeUndefined();
    expect(info.tile).toBeUndefined();
    expect(info.sourceTile).toBeNull();
  });

  it('is a safe no-op without a sourceLayer at all', () => {
    const info = layer.getPickingInfo(pickParams(1, null));
    expect(info.object).toBeUndefined();
    expect(info.sourceTile).toBeNull();
  });

  it('returns no object for an out-of-range index (stale picking buffer)', () => {
    const info = layer.getPickingInfo(
      pickParams(99, { tile, sttFeatures: tile.layers[0].features }),
    );
    expect(info.tile).toBe(tile);
    expect(info.object).toBeUndefined();
  });

  it('respects an object a sublayer already resolved', () => {
    const params = pickParams(1, { tile, sttFeatures: tile.layers[0].features });
    const preResolved = { already: 'here' };
    params.info.object = preResolved;
    const info = layer.getPickingInfo(params);
    expect(info.object).toBe(preResolved);
  });
});

// ---------------------------------------------------------------------------
// Sublayers carry the tile context
// ---------------------------------------------------------------------------

describe('sublayers carry tile + sttFeatures (TileLayer convention)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('AnimatedPointLayer per-tile sublayer', async () => {
    const { AnimatedPointLayer } = await import('../src/animated-point-layer');
    const layer: any = Object.create((AnimatedPointLayer as any).prototype);
    layer.props = {
      id: 'pts',
      fillColor: [255, 128, 0, 255],
      radius: 5,
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    };
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastLayerPropsKey = '';

    const tile = richPointTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.tile).toBe(tile);
    expect(sub.props.sttFeatures).toBe(tile.layers[0].features);
  });

  it.each([
    ['pickable (stock PathLayer)', true],
    ['non-pickable (NoPickingPathLayer)', false],
  ])('AnimatedPathLayer sublayer, %s', async (_name, pickable) => {
    const { AnimatedPathLayer } = await import('../src/animated-path-layer');
    const layer: any = Object.create((AnimatedPathLayer as any).prototype);
    layer.props = {
      id: 'paths',
      pathColor: [0, 150, 255, 255],
      pathWidth: 3,
      timeWindow: 1000,
      opacity: 1,
      visible: true,
      pickable,
    };
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastLayerPropsKey = '';

    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      startTimes: [0],
      endTimes: [100],
      timeOffset: 0,
    });
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.tile).toBe(tile);
    expect(sub.props.sttFeatures).toBe(tile.layers[0].features);
  });
});

// ---------------------------------------------------------------------------
// Cumulative slab provenance
// ---------------------------------------------------------------------------

describe('AnimatedPointLayer cumulative slab picking', () => {
  function makeCumulativeLayer(LayerCtor: any) {
    const layer: any = Object.create(LayerCtor.prototype);
    layer.props = {
      id: 'cum',
      cumulative: true,
      fillColor: [255, 128, 0, 255],
      radius: 5,
      timeWindow: 1000,
      timeRange: { start: 0, end: 10_000 },
      opacity: 1,
      visible: true,
    };
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastLayerPropsKey = '';
    layer.lastSlabLayerPropsKey = '';
    layer.slabs = [];
    layer.absorbedTileKeys = new Set();
    layer.slabBaseOffset = 0;
    layer.slabSchemaKey = null;
    layer.slabSchema = null;
    return layer;
  }

  it('maps a slab pick back to its source tile and decodes its columns', async () => {
    const { AnimatedPointLayer } = await import('../src/animated-point-layer');
    const layer = makeCumulativeLayer(AnimatedPointLayer);

    const a = makePointTile({
      positions: [
        [0, 0],
        [1, 0],
      ],
      startTimes: [1, 2],
      endTimes: [3, 4],
      timeOffset: 100,
      tileId: { z: 1, x: 0, y: 0, t: 0 },
    });
    const b = richPointTile({ z: 1, x: 1, y: 0, t: 0 });

    layer.state = { tiles: [a, b] };
    const slabLayers = layer.renderConsolidated();
    expect(slabLayers.length).toBe(1);
    const sprops = slabLayers[0].props;
    expect(sprops.tile).toBeNull();
    expect(sprops.sttSlabProvenance).toHaveLength(2);

    // Tile a holds slab indices [0, 2); tile b holds [2, 5). Index 3 is
    // feature 1 of tile b.
    const info = layer.getPickingInfo(pickParams(3, sprops));
    expect(info.tile).toBe(b);
    expect(info.sourceTile).toBe(b);
    expect(info.object).toMatchObject({ speed: 2.5, kind: 'bus', start_time: 1020 });
  });

  it('reports tile: null for a pick whose absorbed tile was evicted', async () => {
    const { AnimatedPointLayer } = await import('../src/animated-point-layer');
    const layer = makeCumulativeLayer(AnimatedPointLayer);

    const a = makePointTile({
      positions: [
        [0, 0],
        [1, 0],
      ],
      startTimes: [1, 2],
      endTimes: [3, 4],
      timeOffset: 100,
      tileId: { z: 1, x: 0, y: 0, t: 0 },
    });
    const b = richPointTile({ z: 1, x: 1, y: 0, t: 0 });

    layer.state = { tiles: [a, b] };
    const slabLayers = layer.renderConsolidated();
    const sprops = slabLayers[0].props;

    // Tile b leaves the visible set; the slab still renders its points but
    // provenance can no longer resolve them — by design (no pinning).
    layer.state = { tiles: [a] };
    const info = layer.getPickingInfo(pickParams(3, sprops));
    expect(info.tile).toBeNull();
    expect(info.object).toBeUndefined();

    // Tile a is still resident and resolves normally.
    const infoA = layer.getPickingInfo(pickParams(1, sprops));
    expect(infoA.tile).toBe(a);
    expect(infoA.object).toMatchObject({ start_time: 102, end_time: 104 });
  });
});

// ---------------------------------------------------------------------------
// H3SummaryLayer picking
// ---------------------------------------------------------------------------

describe('H3SummaryLayer.getPickingInfo', () => {
  it('enriches the picked row with the full aggregated columns', async () => {
    vi.resetModules();
    const { H3SummaryLayer } = await import('../src/h3-summary-layer');
    const layer: any = Object.create((H3SummaryLayer as any).prototype);

    const tile = richPointTile();
    const f = tile.layers[0].features;
    // Rows skip undecodable cells, so sourceIndex ≠ row index in general.
    const row = { hex: '85283473fffffff', weight: 42, sourceIndex: 2 };
    const params = pickParams(0, { tile, sttFeatures: f });
    params.info.object = row;

    const info = layer.getPickingInfo(params);
    expect(info.tile).toBe(tile);
    expect(info.object).toMatchObject({
      hex: row.hex,
      weight: 42,
      speed: 3.5,
      kind: null,
    });
  });
});

// ---------------------------------------------------------------------------
// onViewportLoad settle latch
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer._maybeFireViewportLoad', () => {
  let layer: any;
  let calls: unknown[][];

  beforeEach(async () => {
    vi.resetModules();
    const { SpatioTemporalLayer } = await import('../src/spatiotemporal-layer');
    layer = Object.create((SpatioTemporalLayer as any).prototype);
    calls = [];
    layer.props = { onViewportLoad: (tiles: unknown[]) => calls.push(tiles) };
    layer._viewportLoadVersion = -1;
  });

  it('fires once per settled selection version', () => {
    const tiles = ['tile'];
    const tileset = { selectionVersion: 1, isLoaded: false, getVisibleTiles: () => tiles };

    layer._maybeFireViewportLoad(tileset);
    expect(calls).toHaveLength(0); // still loading

    tileset.isLoaded = true;
    layer._maybeFireViewportLoad(tileset);
    expect(calls).toEqual([tiles]); // settled → fire

    layer._maybeFireViewportLoad(tileset);
    layer._maybeFireViewportLoad(tileset);
    expect(calls).toHaveLength(1); // deduped per version

    tileset.selectionVersion = 2; // new selection (e.g. all cache hits)
    layer._maybeFireViewportLoad(tileset);
    expect(calls).toHaveLength(2); // re-fires on the next settle
  });

  it('never fires before the first real selection (version 0)', () => {
    const tileset = { selectionVersion: 0, isLoaded: true, getVisibleTiles: () => [] };
    layer._maybeFireViewportLoad(tileset);
    expect(calls).toHaveLength(0);
  });

  it('does nothing when onViewportLoad is not set', () => {
    layer.props = {};
    const tileset = { selectionVersion: 1, isLoaded: true, getVisibleTiles: () => [] };
    expect(() => layer._maybeFireViewportLoad(tileset)).not.toThrow();
  });
});
