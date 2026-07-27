/**
 * Shared harness for the H3 / Quadbin summary layers.
 *
 * The two summary layers are copy-paste siblings for the outline / stroke prop
 * family (alias-wins, function-fallback, cache-invalidation). They differ in
 * their cell encoding (H3 u64 vs CARTO Quadbin u64) and their deck sublayer
 * (H3HexagonLayer vs QuadkeyLayer), so each keeps its own `makeLayer` factory +
 * fixture here; `summary-outline.test.ts` drives the shared assertions against
 * BOTH via `describe.each`.
 *
 * The full layer can't run under vitest (no WebGL, no real archive), so each
 * factory drives `renderLayers()` directly through an `Object.create` instance
 * (the test file mocks `@deck.gl/core` + `@deck.gl/geo-layers`).
 */

import { latLngToCell, h3IndexToSplitLong } from 'h3-js';

export interface SummaryHarness {
  name: string;
  makeLayer: (props?: Record<string, any>) => Promise<any>;
}

// ---------------------------------------------------------------------------
// H3
// ---------------------------------------------------------------------------

/** Summary-tier tile with real H3 cell ids packed as u64 — H3SummaryLayer input. */
function makeH3SummaryTile() {
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

export function h3SummaryHarness(): SummaryHarness {
  return {
    name: 'H3SummaryLayer',
    // The base props mirror deck's H3HexagonLayer defaults for the outline
    // family (Object.create bypasses static defaultProps merging).
    makeLayer: async (props: Record<string, any> = {}) => {
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
        tiles: [makeH3SummaryTile()],
        metadata: {
          summaryTier: { layerName: 'summary', minZoom: 0, maxZoom: 4 },
        },
      };
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastTilesRef = null;
      // Prune signature + sub-bucket tick latch (Object.create skips the field
      // initializers that would otherwise set these).
      layer.lastPruneKey = null;
      layer.lastSubBucketTick = null;
      layer._currentTime = 0;
      layer._lastTileIdSet = new Set();
      return layer;
    },
  };
}

// ---------------------------------------------------------------------------
// Quadbin
// ---------------------------------------------------------------------------

/** Canonical CARTO `tile → quadbin u64` encode, independent of the layer decoder. */
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
function makeQuadbinSummaryTile() {
  const cells: Array<[number, number, number]> = [
    [9, 4, 5],
    [10, 6, 5],
  ];
  const ids = new BigUint64Array(cells.length);
  cells.forEach(([x, y, z], i) => {
    ids[i] = tileToQuadbin(x, y, z);
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
          numericProps: {
            count: new Float32Array([3, 7]),
            mean_mag: new Float32Array([1.5, 4.5]),
          },
          categoricalProps: {},
        },
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  } as any;
}

export function quadbinSummaryHarness(): SummaryHarness {
  return {
    name: 'QuadbinSummaryLayer',
    makeLayer: async (props: Record<string, any> = {}) => {
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
        tiles: [makeQuadbinSummaryTile()],
        metadata: {
          summaryTier: { layerName: 'summary', minZoom: 0, maxZoom: 4 },
        },
      };
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastTilesRef = null;
      // Prune signature + sub-bucket tick latch (Object.create skips the field
      // initializers that would otherwise set these).
      layer.lastPruneKey = null;
      layer.lastSubBucketTick = null;
      layer._currentTime = 0;
      layer._lastTileIdSet = new Set();
      return layer;
    },
  };
}
