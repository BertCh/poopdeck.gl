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
function makeSummaryTile(props?: Record<string, any>) {
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
          ...props,
        },
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  } as any;
}

async function makeQuadbinLayer(props: Record<string, any> = {}) {
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
    expect(sub.props.id).toBe('qb-quadbins-2/0/0/0:count');
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
    expect(sub.props.id).toBe('qb-quadbins-2/0/0/0:mean_mag');
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

  it('a coverage change invalidates the cached sublayer', async () => {
    const layer = await makeQuadbinLayer({ coverage: 0.92 });
    const [first] = layer.renderLayers();
    layer.props.coverage = 0.5;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.coverage).toBe(0.5);
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
