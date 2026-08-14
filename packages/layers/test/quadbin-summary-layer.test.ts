/**
 * QuadbinSummaryLayer render-path tests — the Quadbin counterpart of the
 * H3SummaryLayer coverage in sublayer-contract.test.ts.
 *
 * The full layer can't run under vitest (no WebGL context, no real archive),
 * so these tests drive `renderLayers()` directly through the `Object.create`
 * harness used by the sibling suites: `@deck.gl/core` is mocked with the
 * faithful getSubLayerProps/getSubLayerClass contract (fake-deck-core), and
 * `@deck.gl/geo-layers`' `QuadkeyLayer` is a capture-only fake so we can assert
 * the props the layer hands its sublayers (the cell quadkey accessor, the color
 * ramp, the per-tile sublayer-instance caching, and picking enrichment).
 *
 * The pure CARTO Quadbin u64 → quadkey conversion is asserted separately in
 * quadbin-cell.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface CapturedLayer {
  props: Record<string, any>;
}

// Faithful getSubLayerProps/getSubLayerClass contract — see fake-deck-core.ts.
vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  return core;
});

vi.mock('@deck.gl/geo-layers', () => {
  class FakeQuadkeyLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { QuadkeyLayer: FakeQuadkeyLayer };
});

/**
 * Canonical CARTO `tile → quadbin u64` encode, independent of the layer's
 * decoder — used to pack fixture cell ids into the Arrow `id` mirror.
 */
function tileToQuadbin(x: number, y: number, z: number): bigint {
  const interleave = (value: number): bigint => {
    let v = BigInt(value) & 0xffffffffn;
    v = (v | (v << 16n)) & 0x0000ffff0000ffffn;
    v = (v | (v << 8n)) & 0x00ff00ff00ff00ffn;
    v = (v | (v << 4n)) & 0x0f0f0f0f0f0f0f0fn;
    v = (v | (v << 2n)) & 0x3333333333333333n;
    v = (v | (v << 1n)) & 0x5555555555555555n;
    return v;
  };
  const interleaved = interleave(x) | (interleave(y) << 1n);
  const shift = BigInt(52 - 2 * z);
  const morton = (interleaved << shift) & ((1n << 52n) - 1n);
  const fill = (1n << shift) - 1n;
  return 0x4000000000000000n | (1n << 59n) | (BigInt(z) << 52n) | morton | fill;
}

/** Summary-tier tile with real Quadbin cell ids packed as u64. */
function makeSummaryTile(props?: Record<string, any>, tileT = 0) {
  // Two distinct z=5 cells; counts drive the ramp.
  const cells: Array<[number, number, number]> = [
    [9, 4, 5],
    [10, 6, 5],
  ];
  const ids = new BigUint64Array(cells.length);
  cells.forEach(([x, y, z], i) => {
    ids[i] = tileToQuadbin(x, y, z);
  });
  return {
    id: { z: 2, x: 0, y: 0, t: tileT },
    timeRange: { start: tileT, end: tileT },
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
          numericProps: {
            count: new Float32Array([3, 7]),
            mean_mag: new Float32Array([1.5, 4.5]),
          },
          categoricalProps: {},
          ...props,
        },
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  } as any;
}

async function makeQuadbinLayer(
  props: Record<string, any> = {},
  state: Record<string, any> = {},
) {
  const { QuadbinSummaryLayer } =
    await import('../src/layers/summary/quadbin-summary-layer');
  const layer: any = Object.create((QuadbinSummaryLayer as any).prototype);
  layer.props = {
    id: 'qb',
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
    ...state,
  };
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastTilesRef = null;
  layer.lastPruneKey = null;
  layer.lastSubBucketTick = null;
  layer._currentTime = 0;
  layer._lastTileIdSet = new Set();
  return layer;
}

beforeEach(async () => {
  vi.resetModules();
  (await import('../src/lib/log'))._resetWarnOnce();
});

/**
 * Longitude extent of the FIRST cell the sublayer actually draws. The ring
 * comes from `CoverageQuadkeyLayer.indexToBounds()`, the override that makes
 * `coverage` real — reading it here is what turns "the prop was forwarded" into
 * "the geometry changed".
 */
function cellWidth(sub: any): number {
  const ring = sub.indexToBounds().getPolygon(sub.props.data[0], {});
  return ring[0] - ring[4]; // east − west
}

/**
 * Neutralize `SpatioTemporalLayer._handleTimeUpdate` (it drives the real
 * tileset, which the Object.create harness doesn't have) so a test can observe
 * ONLY the summary layer's sub-bucket override. Returns a restore fn.
 */
function stubBaseTimeUpdate(layer: any): () => void {
  const base = Object.getPrototypeOf(Object.getPrototypeOf(layer));
  const spy = vi.spyOn(base, '_handleTimeUpdate').mockImplementation(() => {});
  return () => spy.mockRestore();
}

describe('QuadbinSummaryLayer: cell decoding + sublayer wiring', () => {
  it('emits one QuadkeyLayer per summary tile, with rows carrying the quadkey', async () => {
    const layer = await makeQuadbinLayer();
    const subs = layer.renderLayers();
    expect(subs).toHaveLength(1);
    const sub = subs[0] as CapturedLayer;
    expect(sub.props.data).toHaveLength(2);
    // getQuadkey accessor resolves each row to its base-4 path string.
    expect(sub.props.getQuadkey(sub.props.data[0])).toBe(
      // z=5 cell (9,4): see quadbin-cell.test.ts for the digit derivation.
      sub.props.data[0].quadkey,
    );
    expect(typeof sub.props.data[0].quadkey).toBe('string');
    expect(sub.props.data[0].quadkey).toHaveLength(5); // z=5 → 5 digits
    // Per-tile sublayer ids stay unique + stable: parent-shortId-tileKey.
    expect(sub.props.id).toBe('qb-quadbins-2/0/0/0#0:count');
  });

  it('drives getFillColor from the weight column through colorRange/colorDomain', async () => {
    const layer = await makeQuadbinLayer({
      colorDomain: [0, 10],
      colorRange: [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ],
    });
    const [sub] = layer.renderLayers();
    // weight 3 → t=0.3 → bucket 0; weight 7 → t=0.7 → bucket 1.
    expect(sub.props.getFillColor(sub.props.data[0])).toEqual([0, 0, 0, 255]);
    expect(sub.props.getFillColor(sub.props.data[1])).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it('extrusion is off by default and getElevation is the constant 0', async () => {
    const layer = await makeQuadbinLayer();
    const [sub] = layer.renderLayers();
    expect(sub.props.extruded).toBe(false);
    expect(sub.props.getElevation).toBe(0);
  });

  it('extruded:true scales elevation by the weight × elevationScale', async () => {
    const layer = await makeQuadbinLayer({
      extruded: true,
      elevationScale: 10,
    });
    const [sub] = layer.renderLayers();
    expect(sub.props.extruded).toBe(true);
    expect(sub.props.getElevation(sub.props.data[1])).toBe(7 * 10);
  });

  it('a non-default weightProperty drives the rows + the cache key', async () => {
    const layer = await makeQuadbinLayer({ weightProperty: 'mean_mag' });
    const [sub] = layer.renderLayers();
    expect(sub.props.id).toBe('qb-quadbins-2/0/0/0#0:mean_mag');
    // colorDomain stays [0,10]; weight 4.5 → bucket index from mean_mag.
    expect(sub.props.data[1].weight).toBe(4.5);
  });
});

describe('QuadbinSummaryLayer: sublayer-instance caching', () => {
  it('returns the SAME QuadkeyLayer instance when nothing changed', async () => {
    const layer = await makeQuadbinLayer();
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first);
  });

  it('a coverage change invalidates the cached sublayer AND resizes the drawn cell', async () => {
    const layer = await makeQuadbinLayer({ coverage: 0.92 });
    const [first] = layer.renderLayers();
    layer.props.coverage = 0.5;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    // Assert the GEOMETRY, not the forwarded prop value: upstream QuadkeyLayer
    // has no `coverage` prop at all (GeoCellLayer.renderLayers destructures a
    // fixed list without it, and indexToBounds hardcodes `extruded ? 0.99 : 1`),
    // so "the prop was forwarded" is exactly the assertion that gave false
    // confidence while the cell stayed full-size.
    expect(cellWidth(second)).toBeCloseTo(cellWidth(first) * (0.5 / 0.92), 10);
  });

  it('a colorRange content swap (same length) invalidates the cached sublayer', async () => {
    const layer = await makeQuadbinLayer({
      colorRange: [
        [0, 0, 0, 255],
        [1, 1, 1, 255],
      ],
    });
    const [first] = layer.renderLayers();
    layer.props.colorRange = [
      [9, 9, 9, 255],
      [8, 8, 8, 255],
    ];
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
  });
});

describe('QuadbinSummaryLayer: inheritance + overrides', () => {
  it('inherits coordinateSystem into the QuadkeyLayer sublayers', async () => {
    const layer = await makeQuadbinLayer({ coordinateSystem: 7 });
    const [sub] = layer.renderLayers();
    expect(sub.props.coordinateSystem).toBe(7);
  });

  it('_subLayerProps.quadbins.type swaps the sublayer class', async () => {
    class SwappedLayer implements CapturedLayer {
      props: Record<string, any>;
      constructor(props: Record<string, any>) {
        this.props = props;
      }
    }
    const layer = await makeQuadbinLayer({
      _subLayerProps: { quadbins: { type: SwappedLayer } },
    });
    const [sub] = layer.renderLayers();
    expect(sub).toBeInstanceOf(SwappedLayer);
  });
});

describe('QuadbinSummaryLayer: getZoomLevel clamps to the tier band', () => {
  it('clamps the viewport zoom into [minZoom, maxZoom]', async () => {
    const layer = await makeQuadbinLayer();
    expect(layer.getZoomLevel({ zoom: 9.7 })).toBe(4); // above maxZoom → 4
    expect(layer.getZoomLevel({ zoom: 2.3 })).toBe(2);
  });
});

describe('QuadbinSummaryLayer: coverage is real geometry, not a stored prop', () => {
  it('coverage 1 draws the full cell; the 0.92 default insets it toward the centroid', async () => {
    const full = await makeQuadbinLayer({ coverage: 1 });
    const inset = await makeQuadbinLayer({ coverage: 0.92 });
    const [fullSub] = full.renderLayers();
    const [insetSub] = inset.renderLayers();
    const fullRing = fullSub.indexToBounds().getPolygon(fullSub.props.data[0]);
    const insetRing = insetSub
      .indexToBounds()
      .getPolygon(insetSub.props.data[0]);
    expect(cellWidth(insetSub)).toBeCloseTo(cellWidth(fullSub) * 0.92, 10);
    // Centroid-anchored: the inset cell sits inside the full one on BOTH sides
    // (deck's internal north-west-anchored inset would keep the west edge).
    expect(insetRing[4]).toBeGreaterThan(fullRing[4]); // west moved east
    expect(insetRing[0]).toBeLessThan(fullRing[0]); // east moved west
  });

  it('extruded cells never draw a full-size footprint (deck’s z-fighting guard)', async () => {
    const layer = await makeQuadbinLayer({ coverage: 1, extruded: true });
    const [sub] = layer.renderLayers();
    const flat = await makeQuadbinLayer({ coverage: 1 });
    expect(cellWidth(sub)).toBeCloseTo(
      cellWidth(flat.renderLayers()[0]) * 0.99,
      10,
    );
  });
});

describe('QuadbinSummaryLayer: sub-bucket animation within a tile', () => {
  const SUB_BUCKETS = 4;
  const BUCKET_MS = 4000; // → 1000 ms per sub-bucket

  /** Tile whose two cells are active in different sub-buckets. */
  function subBucketTile(tileT = 0) {
    return makeSummaryTile(
      {
        numericProps: {
          count: new Float32Array([3, 7]),
          mean_mag: new Float32Array([1.5, 4.5]),
          // cell 0 fires in sub-buckets 0 and 2; cell 1 only in sub-bucket 1.
          bucket_0: new Float32Array([2, 0]),
          bucket_1: new Float32Array([0, 5]),
          bucket_2: new Float32Array([9, 0]),
          bucket_3: new Float32Array([0, 0]),
        },
      },
      tileT,
    );
  }

  async function subBucketLayer(currentTime: number, props = {}) {
    const layer = await makeQuadbinLayer(props, {
      tiles: [subBucketTile()],
      metadata: {
        temporalBucketMs: BUCKET_MS,
        summaryTier: {
          layerName: 'summary',
          minZoom: 0,
          maxZoom: 4,
          subBuckets: SUB_BUCKETS,
        },
      },
    });
    layer._currentTime = currentTime;
    return layer;
  }

  it('drives the weight from the bucket_<k> column the play head is inside', async () => {
    const a = await subBucketLayer(500); // sub-bucket 0
    const [subA] = a.renderLayers();
    expect(subA.props.data).toHaveLength(1); // only cell 0 is active
    expect(subA.props.data[0].weight).toBe(2);

    const b = await subBucketLayer(1500); // sub-bucket 1
    const [subB] = b.renderLayers();
    expect(subB.props.data).toHaveLength(1); // only cell 1 is active
    expect(subB.props.data[0].weight).toBe(5);

    const c = await subBucketLayer(2500); // sub-bucket 2
    expect(c.renderLayers()[0].props.data[0].weight).toBe(9);
  });

  it('scrubbing inside one temporal tile changes what is drawn', async () => {
    const layer = await subBucketLayer(500);
    const first = layer.renderLayers()[0];
    expect(first.props.data[0].weight).toBe(2);
    // Same tile set, same props — only the play head moved.
    layer._currentTime = 2500;
    const second = layer.renderLayers()[0];
    expect(second).not.toBe(first);
    expect(second.props.data[0].weight).toBe(9);
    // …and back again, from a pruned cache.
    layer._currentTime = 500;
    expect(layer.renderLayers()[0].props.data[0].weight).toBe(2);
  });

  it('clamps a play head past the tile’s bucket to the last sub-bucket', async () => {
    const layer = await subBucketLayer(99_999);
    // bucket_3 is all zeros → every cell is filtered out.
    expect(layer.renderLayers()).toEqual([]);
  });

  it('indexes relative to the TILE’s bucket start, not the epoch', async () => {
    const layer = await makeQuadbinLayer(
      {},
      {
        tiles: [subBucketTile(100_000)],
        metadata: {
          temporalBucketMs: BUCKET_MS,
          summaryTier: {
            layerName: 'summary',
            minZoom: 0,
            maxZoom: 4,
            subBuckets: SUB_BUCKETS,
          },
        },
      },
    );
    layer._currentTime = 102_500; // 2500 ms into the bucket → sub-bucket 2
    expect(layer.renderLayers()[0].props.data[0].weight).toBe(9);
  });

  it('a non-count weightProperty keeps its bucket-wide value but is still gated by activity', async () => {
    const layer = await subBucketLayer(1500, { weightProperty: 'mean_mag' });
    const [sub] = layer.renderLayers();
    // Only cell 1 is active in sub-bucket 1; its aggregate is the whole-bucket
    // mean (no per-sub-bucket aggregates are baked for non-count columns).
    expect(sub.props.data).toHaveLength(1);
    expect(sub.props.data[0].weight).toBe(4.5);
  });

  it('_handleTimeUpdate re-renders only on a sub-bucket CROSSING', async () => {
    const layer = await subBucketLayer(0);
    const setState = vi.fn();
    layer.setState = setState;
    const restoreBase = stubBaseTimeUpdate(layer);
    layer._handleTimeUpdate(0);
    layer._handleTimeUpdate(500); // same sub-bucket
    layer._handleTimeUpdate(999);
    expect(setState).toHaveBeenCalledTimes(1); // the initial index latch only
    layer._handleTimeUpdate(1000); // crossing into sub-bucket 1
    expect(setState).toHaveBeenCalledTimes(2);
    restoreBase();
  });

  it('does nothing (and never re-renders on time) when the tier has no sub-buckets', async () => {
    const layer = await makeQuadbinLayer();
    const setState = vi.fn();
    layer.setState = setState;
    const restoreBase = stubBaseTimeUpdate(layer);
    layer._handleTimeUpdate(0);
    layer._handleTimeUpdate(10_000_000);
    expect(setState).not.toHaveBeenCalled();
    restoreBase();
    // Cache keys stay sub-bucket-free so nothing churns.
    const [sub] = layer.renderLayers();
    expect(sub.props.id).toBe('qb-quadbins-2/0/0/0#0:count');
  });

  it('warns once and falls back when the tier declares sub-buckets the tiles lack', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeQuadbinLayer(
      {},
      {
        tiles: [makeSummaryTile()], // no bucket_* columns
        metadata: {
          temporalBucketMs: BUCKET_MS,
          summaryTier: {
            layerName: 'summary',
            minZoom: 0,
            maxZoom: 4,
            subBuckets: SUB_BUCKETS,
          },
        },
      },
    );
    const [sub] = layer.renderLayers();
    expect(sub.props.data).toHaveLength(2); // whole-bucket fallback
    expect(sub.props.data[0].weight).toBe(3);
    expect(String(warn.mock.calls[0][0])).toMatch(/bucket_0/);
    warn.mockRestore();
  });
});

describe('QuadbinSummaryLayer: cache pruning', () => {
  it('prunes the old-weight entries when only weightProperty changes', async () => {
    const layer = await makeQuadbinLayer({ weightProperty: 'count' });
    layer.renderLayers();
    expect([...layer.preparedTileCache.keys()]).toEqual(['2/0/0/0#0:count']);
    // `state.tiles` keeps its identity, so a reference-only prune gate would
    // retain the count entry forever — one generation per column ever used.
    layer.props.weightProperty = 'mean_mag';
    layer.renderLayers();
    expect([...layer.preparedTileCache.keys()]).toEqual(['2/0/0/0#0:mean_mag']);
    expect([...layer.sublayerCache.keys()]).toEqual(['2/0/0/0#0:mean_mag']);
  });
});

describe('QuadbinSummaryLayer: blank-render diagnostics', () => {
  it('names the missing weight column, and lists what IS available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeQuadbinLayer({ weightProperty: 'typo' });
    expect(layer.renderLayers()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/'typo'/);
    expect(msg).toMatch(/count, mean_mag/);
    warn.mockRestore();
  });

  it('names an absent featureIds64 column (the UInt32-id archive)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeQuadbinLayer();
    layer.state.tiles[0].layers[0].features.featureIds64 = undefined;
    expect(layer.renderLayers()).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toMatch(/featureIds64/);
    warn.mockRestore();
  });

  it('names a tile with no matching summary layer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeQuadbinLayer();
    layer.state.tiles[0].layers[0].name = 'raw';
    expect(layer.renderLayers()).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toMatch(/no layer named 'summary'/);
    warn.mockRestore();
  });

  it('names cell ids that decode to nothing (wrong summary scheme)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeQuadbinLayer();
    // Zoom field 31 — outside the 0..26 Quadbin band, so every id is rejected.
    const bogus = 0x4000000000000000n | (1n << 59n) | (0x1fn << 52n);
    layer.state.tiles[0].layers[0].features.featureIds64 = new BigUint64Array([
      bogus,
      bogus,
    ]);
    expect(layer.renderLayers()).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toMatch(/decoded to a valid Quadbin/);
    warn.mockRestore();
  });
});

describe('QuadbinSummaryLayer: picking enrichment', () => {
  it('swaps the row object for the cell aggregated columns, keeping quadkey/weight', async () => {
    const layer = await makeQuadbinLayer();
    const [sub] = layer.renderLayers();
    const row = sub.props.data[1];
    const info: any = { index: 1, object: row };
    const out = layer.getPickingInfo({
      info,
      sourceLayer: { props: sub.props },
    });
    // Aggregated columns surface alongside the continuity keys.
    expect(out.object.quadkey).toBe(row.quadkey);
    expect(out.object.weight).toBe(row.weight);
    expect(out.object.count).toBe(7);
    expect(out.object.mean_mag).toBe(4.5);
    expect(out.tile).toBe(sub.props.tile);
  });

  it('exposes the u64 cell id as a JSON-safe string, losing no bits', async () => {
    const layer = await makeQuadbinLayer();
    const [sub] = layer.renderLayers();
    const row = sub.props.data[0];
    const out = layer.getPickingInfo({
      info: { index: 0, object: row } as any,
      sourceLayer: { props: sub.props },
    });
    // Summary tiles ALWAYS carry featureIds64, so `id` used to be a bigint and
    // the first getTooltip/devtools JSON.stringify threw.
    expect(typeof out.object.id).toBe('string');
    expect(() => JSON.stringify(out.object)).not.toThrow();
    expect(BigInt(out.object.id)).toBe(
      sub.props.sttFeatures.featureIds64[row.sourceIndex],
    );
    // The readable cell address is surfaced under a dedicated key too.
    expect(out.object.cell).toBe(row.quadkey);
  });
});

describe('QuadbinSummaryLayer: stroke / fill / material pass-throughs', () => {
  it('forwards a default black 1px outline (getLineColor / getLineWidth) even when the layer-level line props are unset', async () => {
    const layer = await makeQuadbinLayer();
    const [sub] = layer.renderLayers();
    // PolygonLayer's own defaults, surfaced so a caller can see them.
    expect(sub.props.getLineColor).toEqual([0, 0, 0, 255]);
    expect(sub.props.getLineWidth).toBe(1);
  });

  it('stroked:false forwards to the sublayer (the un-disable-able border escape hatch)', async () => {
    const layer = await makeQuadbinLayer({ stroked: false });
    const [sub] = layer.renderLayers();
    expect(sub.props.stroked).toBe(false);
  });

  it('filled:false forwards to the sublayer (outline-only cells)', async () => {
    const layer = await makeQuadbinLayer({ filled: false });
    const [sub] = layer.renderLayers();
    expect(sub.props.filled).toBe(false);
  });

  it('lineWidth constant drives getLineWidth; getLineWidth alias wins; a column name falls back to 1', async () => {
    const a = await makeQuadbinLayer({ lineWidth: 4 });
    expect(a.renderLayers()[0].props.getLineWidth).toBe(4);

    const b = await makeQuadbinLayer({ lineWidth: 4, getLineWidth: 9 });
    expect(b.renderLayers()[0].props.getLineWidth).toBe(9);

    // No per-cell width column is baked → a column-name string falls back to 1.
    const c = await makeQuadbinLayer({ getLineWidth: 'some_col' });
    expect(c.renderLayers()[0].props.getLineWidth).toBe(1);

    // The LEGACY `lineWidth` prop is a CONSTANT only (summary cells bake no
    // per-cell width column). A column-name string is not honored — it falls
    // back to the constant 1, matching the corrected prop doc/type (no
    // `| string`). Pins that the prop never silently reads a per-cell column.
    const d = await makeQuadbinLayer({ lineWidth: 'my_width_col' as any });
    expect(d.renderLayers()[0].props.getLineWidth).toBe(1);
  });

  it('forwards the line-width styling group (units / scale / min / max / joint / miter / dash)', async () => {
    const layer = await makeQuadbinLayer({
      lineWidthUnits: 'pixels',
      lineWidthScale: 2,
      lineWidthMinPixels: 3,
      lineWidthMaxPixels: 40,
      lineJointRounded: true,
      lineMiterLimit: 6,
      lineDashJustified: true,
    });
    const [sub] = layer.renderLayers();
    expect(sub.props.lineWidthUnits).toBe('pixels');
    expect(sub.props.lineWidthScale).toBe(2);
    expect(sub.props.lineWidthMinPixels).toBe(3);
    expect(sub.props.lineWidthMaxPixels).toBe(40);
    expect(sub.props.lineJointRounded).toBe(true);
    expect(sub.props.lineMiterLimit).toBe(6);
    expect(sub.props.lineDashJustified).toBe(true);
  });

  it('forwards wireframe + material for extruded-cell lighting', async () => {
    const material = { ambient: 0.5, diffuse: 0.4, shininess: 12 };
    const layer = await makeQuadbinLayer({
      extruded: true,
      wireframe: true,
      material,
    });
    const [sub] = layer.renderLayers();
    expect(sub.props.wireframe).toBe(true);
    expect(sub.props.material).toBe(material);
  });
});

describe('QuadbinSummaryLayer: defensive empty cases', () => {
  it('renders nothing when there are no tiles', async () => {
    const layer = await makeQuadbinLayer();
    layer.state = { ...layer.state, tiles: [] };
    expect(layer.renderLayers()).toEqual([]);
  });

  it('skips a tile that has no summary layer', async () => {
    const layer = await makeQuadbinLayer();
    const tile = makeSummaryTile();
    tile.layers[0].name = 'raw'; // not the summary layer
    layer.state = { ...layer.state, tiles: [tile] };
    expect(layer.renderLayers()).toEqual([]);
  });

  it('skips a tile missing the weight column', async () => {
    const layer = await makeQuadbinLayer({ weightProperty: 'nope' });
    expect(layer.renderLayers()).toEqual([]);
  });
});
