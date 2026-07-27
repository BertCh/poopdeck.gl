/**
 * Verifies the H3 cell-index → hex-string conversion at the heart of
 * H3SummaryLayer.prepareTile. The full layer is hard to instantiate
 * in a vitest environment (no WebGL context, no real archive), but the
 * pure conversion + weight pickup is what we actually need to assert.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { latLngToCell, cellToLatLng } from 'h3-js';
import { splitLongToH3Index, h3IndexToSplitLong } from 'h3-js';

// ─────────────────────────────────────────────────────────────────────────
// Render-path harness (mirrors quadbin-summary-layer.test.ts). The full layer
// can't run under vitest (no WebGL, no real archive), so `renderLayers()` is
// driven directly through an `Object.create` instance with `@deck.gl/core`
// mocked to the faithful getSubLayerProps/getSubLayerClass contract and
// `H3HexagonLayer` a capture-only fake — used here to assert the outline /
// stroke family props (audit deckgl-parity) are forwarded to the sublayer.
// ─────────────────────────────────────────────────────────────────────────

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  return core;
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

/** Summary-tier tile with real H3 cell ids packed as u64 — H3SummaryLayer input. */
function makeSummaryTile(
  opts: {
    resolution?: number;
    numericProps?: Record<string, Float32Array>;
    tileZ?: number;
    tileT?: number;
  } = {},
) {
  const res = opts.resolution ?? 5;
  const cells = [
    latLngToCell(40.7, -74.0, res),
    latLngToCell(40.8, -73.9, res),
  ];
  const ids = new BigUint64Array(cells.length);
  cells.forEach((cell, i) => {
    const [lo, hi] = h3IndexToSplitLong(cell);
    ids[i] = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  });
  return {
    id: { z: opts.tileZ ?? 2, x: 0, y: 0, t: opts.tileT ?? 0 },
    timeRange: { start: opts.tileT ?? 0, end: opts.tileT ?? 0 },
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
          numericProps: opts.numericProps ?? {
            count: new Float32Array([3, 7]),
          },
          categoricalProps: {},
        },
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  } as any;
}

/**
 * Build an H3SummaryLayer instance driven through renderLayers(). The base
 * props mirror deck's H3HexagonLayer defaults for the outline family (the
 * Object.create harness bypasses static defaultProps merging), so a test that
 * omits a prop sees its deck default forwarded; `...props` overrides win.
 */
async function makeH3Layer(
  props: Record<string, any> = {},
  state: Record<string, any> = {},
) {
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
    // Outline / stroke family — deck H3HexagonLayer (→ PolygonLayer) defaults.
    stroked: true,
    filled: true,
    wireframe: false,
    lineColor: [0, 0, 0, 255],
    getLineColor: null,
    lineWidth: 1,
    getLineWidth: null,
    lineWidthUnits: 'meters',
    lineWidthScale: 1,
    lineWidthMinPixels: 0,
    lineWidthMaxPixels: Number.MAX_SAFE_INTEGER,
    material: true,
    highPrecision: 'auto',
    centerHexagon: null,
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

describe('H3SummaryLayer: cell ID round-trip', () => {
  it('splitLong roundtrips a real H3 cell through u64-as-two-u32', () => {
    // At H3 resolution 5 a real cell encodes to a u64 with non-zero high
    // bits. We pick a cell over SF and roundtrip via the split-long form
    // — the same path the layer uses against the Arrow `id` column.
    const cell = latLngToCell(37.7749, -122.4194, 5);
    const split = h3IndexToSplitLong(cell);
    const lower = split[0] >>> 0;
    const upper = split[1] >>> 0;
    // Recompose the way the layer does it.
    const recombined = splitLongToH3Index(lower, upper);
    expect(recombined).toBe(cell);

    // The recovered cell still resolves to a centroid in the same
    // bounding region. At resolution 5 the cell edge is ~9 km, so the
    // centroid will be within a fraction of a degree of the input.
    const [lat, lng] = cellToLatLng(recombined);
    expect(Math.abs(lat - 37.7749)).toBeLessThan(0.5);
    expect(Math.abs(lng - -122.4194)).toBeLessThan(0.5);
  });

  it('roundtrips via BigUint64 mask + shift identical to the layer path', () => {
    const cell = latLngToCell(40.7128, -74.006, 6); // NYC
    const split = h3IndexToSplitLong(cell);
    const u64 = (BigInt(split[1] >>> 0) << 32n) | BigInt(split[0] >>> 0);

    // Layer code:
    const lower = Number(u64 & 0xffffffffn) >>> 0;
    const upper = Number((u64 >> 32n) & 0xffffffffn) >>> 0;
    const recombined = splitLongToH3Index(lower, upper);
    expect(recombined).toBe(cell);
  });
});

describe('H3SummaryLayer: outline / stroke family forwarding (deckgl parity)', () => {
  it('forwards the deck-default outline family to the H3HexagonLayer sublayer', async () => {
    const layer = await makeH3Layer();
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.stroked).toBe(true);
    expect(sub.props.filled).toBe(true);
    expect(sub.props.wireframe).toBe(false);
    // getLineColor resolves to the `lineColor` constant (default black).
    expect(sub.props.getLineColor).toEqual([0, 0, 0, 255]);
    expect(sub.props.getLineWidth).toBe(1);
    expect(sub.props.lineWidthUnits).toBe('meters');
    expect(sub.props.lineWidthScale).toBe(1);
    expect(sub.props.lineWidthMinPixels).toBe(0);
    expect(sub.props.lineWidthMaxPixels).toBe(Number.MAX_SAFE_INTEGER);
    expect(sub.props.material).toBe(true);
    expect(sub.props.highPrecision).toBe('auto');
  });

  it('forwards overridden boolean + numeric outline props verbatim', async () => {
    const layer = await makeH3Layer({
      stroked: false,
      filled: false,
      wireframe: true,
      lineWidthUnits: 'pixels',
      lineWidthScale: 2,
      lineWidthMinPixels: 3,
      lineWidthMaxPixels: 20,
      material: false,
      highPrecision: true,
    });
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.stroked).toBe(false);
    expect(sub.props.filled).toBe(false);
    expect(sub.props.wireframe).toBe(true);
    expect(sub.props.lineWidthUnits).toBe('pixels');
    expect(sub.props.lineWidthScale).toBe(2);
    expect(sub.props.lineWidthMinPixels).toBe(3);
    expect(sub.props.lineWidthMaxPixels).toBe(20);
    expect(sub.props.material).toBe(false);
    expect(sub.props.highPrecision).toBe(true);
  });

  it('honors a highPrecision:false boolean (not just the auto default)', async () => {
    const layer = await makeH3Layer({ highPrecision: false });
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.highPrecision).toBe(false);
  });

  it('lineWidth / getLineWidth alias resolve to a constant width', async () => {
    const legacy = await makeH3Layer({ lineWidth: 4 });
    expect((legacy.renderLayers()[0] as CapturedLayer).props.getLineWidth).toBe(
      4,
    );

    const aliased = await makeH3Layer({ lineWidth: 4, getLineWidth: 9 });
    expect(
      (aliased.renderLayers()[0] as CapturedLayer).props.getLineWidth,
    ).toBe(9);
  });

  it('the outline props ride the updateTriggers surface', async () => {
    const layer = await makeH3Layer({
      lineColor: [5, 6, 7, 255],
      lineWidth: 2,
    });
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.updateTriggers.getLineColor).toContain('5,6,7,255');
    expect(sub.props.updateTriggers.getLineWidth).toContain(2);
  });

  it('forwards centerHexagon (the instanced-column shape pin)', async () => {
    const hex = latLngToCell(40.7, -74.0, 5);
    const layer = await makeH3Layer({ centerHexagon: hex });
    expect((layer.renderLayers()[0] as CapturedLayer).props.centerHexagon).toBe(
      hex,
    );
    const unset = await makeH3Layer();
    expect(
      (unset.renderLayers()[0] as CapturedLayer).props.centerHexagon,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// highPrecision: 'auto' is RESOLVED here, not forwarded
// ---------------------------------------------------------------------------

/** Tier metadata with a per-zoom resolution table, as the builder bakes it. */
function tierWithResolutions(resolutions: number[], minZoom = 0) {
  return {
    layerName: 'summary',
    minZoom,
    maxZoom: minZoom + resolutions.length - 1,
    cellResolutionPerZoom: resolutions,
  };
}

describe("H3SummaryLayer: highPrecision 'auto' resolution", () => {
  it('resolves to false for a fine tier resolution (> 5), killing the per-row WASM scan', async () => {
    // H3HexagonLayer._calculateH3DataProps breaks early only when
    // `!this.props.highPrecision` — the string 'auto' is truthy, so forwarding
    // it calls getResolution() AND isPentagon() for every cell in every tile.
    const layer = await makeH3Layer(
      {},
      {
        tiles: [makeSummaryTile({ tileZ: 3 })],
        metadata: { summaryTier: tierWithResolutions([2, 3, 5, 7, 8]) },
      },
    );
    expect((layer.renderLayers()[0] as CapturedLayer).props.highPrecision).toBe(
      false,
    );
  });

  it('resolves to true at resolution <= 5 (matching _shouldUseHighPrecision)', async () => {
    const layer = await makeH3Layer(
      {},
      {
        tiles: [makeSummaryTile({ tileZ: 1 })],
        metadata: { summaryTier: tierWithResolutions([2, 3, 5, 7, 8]) },
      },
    );
    expect((layer.renderLayers()[0] as CapturedLayer).props.highPrecision).toBe(
      true,
    );
  });

  it('clamps the zoom into the tier band the way resolution_for_zoom does', async () => {
    const meta = { summaryTier: tierWithResolutions([4, 6], 3) }; // z3→4, z4→6
    const below = await makeH3Layer(
      {},
      { tiles: [makeSummaryTile({ tileZ: 0 })], metadata: meta },
    );
    expect((below.renderLayers()[0] as CapturedLayer).props.highPrecision).toBe(
      true, // clamped to the table's first entry (4)
    );
    const above = await makeH3Layer(
      {},
      { tiles: [makeSummaryTile({ tileZ: 9 })], metadata: meta },
    );
    expect((above.renderLayers()[0] as CapturedLayer).props.highPrecision).toBe(
      false, // clamped to the last entry (6)
    );
  });

  it('forces true on a globe / non-Mercator viewport regardless of resolution', async () => {
    const layer = await makeH3Layer(
      {},
      {
        tiles: [makeSummaryTile({ tileZ: 3 })],
        metadata: { summaryTier: tierWithResolutions([2, 3, 5, 7, 8]) },
      },
    );
    layer.context = { viewport: { resolution: 10 } };
    expect((layer.renderLayers()[0] as CapturedLayer).props.highPrecision).toBe(
      true,
    );
  });

  it("leaves 'auto' alone when the archive baked no resolution table", async () => {
    const layer = await makeH3Layer(); // harness tier has no table
    expect((layer.renderLayers()[0] as CapturedLayer).props.highPrecision).toBe(
      'auto',
    );
  });

  it('an explicit boolean is never second-guessed', async () => {
    const forced = await makeH3Layer(
      { highPrecision: true },
      {
        tiles: [makeSummaryTile({ tileZ: 3 })],
        metadata: { summaryTier: tierWithResolutions([2, 3, 5, 7, 8]) },
      },
    );
    expect(
      (forced.renderLayers()[0] as CapturedLayer).props.highPrecision,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-buckets — the only per-feature time signal the summary tier carries
// ---------------------------------------------------------------------------

describe('H3SummaryLayer: sub-bucket animation within a tile', () => {
  const BUCKET_MS = 4000; // 4 sub-buckets → 1000 ms each

  function subBucketState(tileT = 0) {
    return {
      tiles: [
        makeSummaryTile({
          tileT,
          numericProps: {
            count: new Float32Array([3, 7]),
            bucket_0: new Float32Array([2, 0]),
            bucket_1: new Float32Array([0, 5]),
            bucket_2: new Float32Array([9, 0]),
            bucket_3: new Float32Array([0, 0]),
          },
        }),
      ],
      metadata: {
        temporalBucketMs: BUCKET_MS,
        summaryTier: {
          layerName: 'summary',
          minZoom: 0,
          maxZoom: 4,
          subBuckets: 4,
        },
      },
    };
  }

  it('selects the bucket_<k> column the play head is inside and hides idle cells', async () => {
    const layer = await makeH3Layer({}, subBucketState());
    layer._currentTime = 500; // sub-bucket 0
    const first = layer.renderLayers()[0] as CapturedLayer;
    expect(first.props.data).toHaveLength(1);
    expect(first.props.data[0].weight).toBe(2);

    layer._currentTime = 1500; // sub-bucket 1 → the OTHER cell
    const second = layer.renderLayers()[0] as CapturedLayer;
    expect(second).not.toBe(first);
    expect(second.props.data).toHaveLength(1);
    expect(second.props.data[0].weight).toBe(5);
    expect(second.props.data[0].hex).not.toBe(first.props.data[0].hex);
  });

  it('indexes from the TILE bucket start, matching summary.rs’s binning', async () => {
    const layer = await makeH3Layer({}, subBucketState(100_000));
    layer._currentTime = 102_500; // 2500 ms in → sub-bucket 2
    expect(
      (layer.renderLayers()[0] as CapturedLayer).props.data[0].weight,
    ).toBe(9);
  });

  it('is inert on an archive without sub-buckets (cache key unchanged)', async () => {
    const layer = await makeH3Layer();
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.id).toBe('h3-hexagons-2/0/0/0:count');
    expect(sub.props.data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics + picking
// ---------------------------------------------------------------------------

describe('H3SummaryLayer: blank-render diagnostics', () => {
  it('names a missing weight column and lists what IS available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeH3Layer({ weightProperty: 'typo' });
    expect(layer.renderLayers()).toEqual([]);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/'typo'/);
    expect(msg).toMatch(/count/);
    warn.mockRestore();
  });

  it('names an absent featureIds64 column (the UInt32-id archive)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeH3Layer();
    layer.state.tiles[0].layers[0].features.featureIds64 = undefined;
    expect(layer.renderLayers()).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toMatch(/featureIds64/);
    warn.mockRestore();
  });

  it('names a tile with no matching summary layer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeH3Layer();
    layer.state.tiles[0].layers[0].name = 'raw';
    expect(layer.renderLayers()).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toMatch(/no layer named 'summary'/);
    warn.mockRestore();
  });

  it('names an id column too short to cover featureCount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeH3Layer();
    // A truncated id column: every h3IndexFromTile falls off the end, so the
    // rows array comes out empty and the map is blank with nothing else logged.
    layer.state.tiles[0].layers[0].features.featureIds64 = new BigUint64Array(
      0,
    );
    expect(layer.renderLayers()).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toMatch(/yielded an H3 index/);
    warn.mockRestore();
  });
});

describe('H3SummaryLayer: cache pruning + trigger stability', () => {
  it('prunes the old-weight entries when only weightProperty changes', async () => {
    const layer = await makeH3Layer(
      {},
      {
        tiles: [
          makeSummaryTile({
            numericProps: {
              count: new Float32Array([3, 7]),
              mean_mag: new Float32Array([1.5, 4.5]),
            },
          }),
        ],
        metadata: {
          summaryTier: { layerName: 'summary', minZoom: 0, maxZoom: 4 },
        },
      },
    );
    layer.renderLayers();
    expect([...layer.preparedTileCache.keys()]).toEqual(['2/0/0/0:count']);
    layer.props.weightProperty = 'mean_mag';
    layer.renderLayers();
    expect([...layer.preparedTileCache.keys()]).toEqual(['2/0/0/0:mean_mag']);
    expect([...layer.sublayerCache.keys()]).toEqual(['2/0/0/0:mean_mag']);
  });

  it('keys getFillColor on the colorRange CONTENT, so an equal fresh array is a no-op', async () => {
    const layer = await makeH3Layer({
      colorRange: [
        [0, 0, 0, 255],
        [1, 2, 3, 255],
      ],
    });
    const first = (layer.renderLayers()[0] as CapturedLayer).props
      .updateTriggers.getFillColor;
    // The ordinary React idiom: a fresh-but-equal literal every render. Trigger
    // elements are strict-compared, so passing the array itself flipped the
    // trigger and rebuilt every cell's fill-colour attribute every frame.
    layer.props.colorRange = [
      [0, 0, 0, 255],
      [1, 2, 3, 255],
    ];
    const second = (layer.renderLayers()[0] as CapturedLayer).props
      .updateTriggers.getFillColor;
    expect(second).toEqual(first);
    // A real content change still flips it.
    layer.props.colorRange = [
      [9, 9, 9, 255],
      [1, 2, 3, 255],
    ];
    const third = (layer.renderLayers()[0] as CapturedLayer).props
      .updateTriggers.getFillColor;
    expect(third).not.toEqual(first);
  });
});

describe('H3SummaryLayer: picking enrichment', () => {
  it('exposes the u64 cell id as a JSON-safe string, losing no bits', async () => {
    const layer = await makeH3Layer();
    const [sub] = layer.renderLayers() as CapturedLayer[];
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
    expect(out.object.cell).toBe(row.hex);
    expect(out.object.hex).toBe(row.hex);
    expect(out.object.weight).toBe(row.weight);
  });
});

describe('H3SummaryLayer: tileset options survive a props change', () => {
  /**
   * `_pushTilesetOptions` used to send the base chassis bag verbatim, and
   * `setOptions` treats every key PRESENT in the bag as an instruction — so
   * the FIRST `propsChanged` pass (any prop at all) reverted this layer from
   * the summary tier's `'no-overlap'` back to `'best-available'` and from the
   * tier's zoom band back to the raw tier's, silently, forever. A parent
   * SUMMARY tile drawn under a finer view double-draws aggregated cells,
   * which is exactly what `no-overlap` is set at construction to prevent.
   */
  async function pushOptions(props: Record<string, any> = {}) {
    const layer = await makeH3Layer(
      {
        tier: 'auto',
        refinementStrategy: 'best-available',
        lodMode: 'parent-fallback',
        maxCacheSize: 2000,
        maxCacheByteSize: 1024,
        maxRequests: 8,
        debounceTime: 0,
        enablePrefetch: true,
        prefetchAhead: 30_000,
        prefetchSteps: 4,
        scrubLod: null,
        loadOptions: {},
        ...props,
      },
      {
        tileset: { setOptions: vi.fn() },
        archive: { setLoadOptions: vi.fn() },
        metadata: {
          minZoom: 0,
          maxZoom: 9,
          summaryTier: { layerName: 'summary', minZoom: 0, maxZoom: 4 },
        },
      },
    );
    layer._pushTilesetOptions();
    return layer.state.tileset.setOptions.mock.calls[0][0];
  }

  it('re-applies the summary-tier overrides over the base bag', async () => {
    const pushed = await pushOptions();
    expect(pushed.refinementStrategy).toBe('no-overlap');
    expect(pushed.tier).toBe('summary');
    // The tier's zoom band, not the raw tier's 0–9.
    expect(pushed.minZoom).toBe(0);
    expect(pushed.maxZoom).toBe(4);
  });

  it('still forwards the mutable knobs the overrides do not claim', async () => {
    const pushed = await pushOptions({ maxCacheSize: 42 });
    expect(pushed.maxCacheSize).toBe(42);
    expect(pushed.prefetchAhead).toBe(30_000);
  });
});
