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
function makeSummaryTile() {
  const cells = [latLngToCell(40.7, -74.0, 5), latLngToCell(40.8, -73.9, 5)];
  const ids = new BigUint64Array(cells.length);
  cells.forEach((cell, i) => {
    const [lo, hi] = h3IndexToSplitLong(cell);
    ids[i] = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  });
  return {
    id: { z: 2, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 0 },
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
          numericProps: { count: new Float32Array([3, 7]) },
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
async function makeH3Layer(props: Record<string, any> = {}) {
  const { H3SummaryLayer } = await import('../src/layers/summary/h3-summary-layer');
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
    ...props,
  };
  layer.state = {
    tiles: [makeSummaryTile()],
    metadata: { summaryTier: { layerName: 'summary', minZoom: 0, maxZoom: 4 } },
  };
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastTilesRef = null;
  layer._lastTileIdSet = new Set();
  return layer;
}

beforeEach(() => {
  vi.resetModules();
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
    const cell = latLngToCell(40.7128, -74.0060, 6); // NYC
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

  it('lineColor recolors the outline (the sublayer was stuck at black)', async () => {
    const layer = await makeH3Layer({ lineColor: [10, 20, 30, 200] });
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.getLineColor).toEqual([10, 20, 30, 200]);
  });

  it('getLineColor alias wins over lineColor', async () => {
    const layer = await makeH3Layer({
      lineColor: [10, 20, 30, 200],
      getLineColor: [1, 2, 3, 255],
    });
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.getLineColor).toEqual([1, 2, 3, 255]);
  });

  it('lineWidth / getLineWidth alias resolve to a constant width', async () => {
    const legacy = await makeH3Layer({ lineWidth: 4 });
    expect((legacy.renderLayers()[0] as CapturedLayer).props.getLineWidth).toBe(4);

    const aliased = await makeH3Layer({ lineWidth: 4, getLineWidth: 9 });
    expect((aliased.renderLayers()[0] as CapturedLayer).props.getLineWidth).toBe(9);
  });

  it('a function-valued getLineColor accessor falls back to lineColor (no crash)', async () => {
    const layer = await makeH3Layer({
      lineColor: [7, 8, 9, 255],
      getLineColor: () => [255, 0, 0, 255],
    });
    const [sub] = layer.renderLayers() as CapturedLayer[];
    // Binary summary tiles can't run per-feature JS — the alias is ignored and
    // the constant `lineColor` is forwarded instead.
    expect(sub.props.getLineColor).toEqual([7, 8, 9, 255]);
  });

  it('the outline props ride the updateTriggers surface', async () => {
    const layer = await makeH3Layer({ lineColor: [5, 6, 7, 255], lineWidth: 2 });
    const [sub] = layer.renderLayers() as CapturedLayer[];
    expect(sub.props.updateTriggers.getLineColor).toContain('5,6,7,255');
    expect(sub.props.updateTriggers.getLineWidth).toContain(2);
  });
});

describe('H3SummaryLayer: outline restyle invalidates the sublayer cache', () => {
  it('a lineColor change rebuilds the cached H3HexagonLayer', async () => {
    const layer = await makeH3Layer({ lineColor: [0, 0, 0, 255] });
    const [first] = layer.renderLayers() as CapturedLayer[];
    // Unchanged props → same cached instance.
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props.lineColor = [1, 1, 1, 255];
    const [second] = layer.renderLayers() as CapturedLayer[];
    expect(second).not.toBe(first);
    expect(second.props.getLineColor).toEqual([1, 1, 1, 255]);
  });

  it('a stroked toggle rebuilds the cached H3HexagonLayer', async () => {
    const layer = await makeH3Layer({ stroked: true });
    const [first] = layer.renderLayers() as CapturedLayer[];
    layer.props.stroked = false;
    const [second] = layer.renderLayers() as CapturedLayer[];
    expect(second).not.toBe(first);
    expect(second.props.stroked).toBe(false);
  });
});
