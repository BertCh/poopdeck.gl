/**
 * A3 render-parity coverage for AnimatedPolygonLayer's NEW props:
 *   - DataFilterExtension range filter (`filterProperty` / `filterRange` /
 *     `filterSoftRange` / `filterEnabled`);
 *   - `timeHeightScale` (space-time-cube lift) + `reducedMotion` gate.
 *
 * Plus three correctness guards on the tile-prepare path:
 *   - a MISSING elevation column falls back to this layer's own 0, never to
 *     deck's 1000 m `SolidPolygonLayer` default;
 *   - categorical fill on an EXTRUDED layer expands on the CPU (the GPU
 *     palette hook runs after lighting and would flatten every prism);
 *   - the geometry-kind guard keeps LineString tiles out of the polygon path.
 *
 * These exercise the layer's `prepareTile` / `buildSublayer` /
 * `buildOutlineSublayer` paths directly (via Object.create, which bypasses
 * CompositeLayer's lifecycle) with a deck.gl mock that captures constructor
 * args — the same harness shape as parity-animated-polygon-layer.test.ts.
 *
 * The load-bearing assertion is DEFAULT-OFF PARITY: with none of the new props
 * set, the fill sublayer is byte-identical to before — extensions stay exactly
 * [timeFilter, categoryColor], no `filterValue` attribute is bound, and
 * `timeHeightScale` rides through at the extension's own no-op default (0).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePolygonTile, makePathTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeSolidPolygonLayer implements CapturedLayer {
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
  return {
    SolidPolygonLayer: FakeSolidPolygonLayer,
    PathLayer: FakePathLayer,
  };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return {
    ...core,
    Layer: FakeLayer,
    project32: { name: 'project32' },
  };
});

/** Single closed-ring triangle polygon (4 verts, feature 0). */
function basePolygonTile() {
  return makePolygonTile({
    polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    startTimes: [0],
    endTimes: [100],
    timeOffset: 0,
  });
}

/** Two closed-ring polygons → featureCount 2, vertexCount 8, startIndices [0,4,8]. */
function twoPolygonTile() {
  return makePolygonTile({
    polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
      [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 2],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [100, 100],
    timeOffset: 0,
  });
}

async function makePolygonLayer(props: Record<string, any> = {}) {
  const { AnimatedPolygonLayer } =
    await import('../src/layers/core/animated-polygon-layer');
  const layer: any = Object.create((AnimatedPolygonLayer as any).prototype);
  layer.props = {
    id: 'poly',
    fillColor: [255, 140, 0, 180],
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    filled: true,
    extruded: false,
    elevation: 0,
    stroked: false,
    getLineColor: [0, 0, 0, 255],
    getLineWidth: 1,
    lineWidthUnits: 'meters',
    lineWidthMinPixels: 0,
    lineJointRounded: false,
    lineMiterLimit: 4,
    lineDashJustified: false,
    _full3d: false,
    fadeInDuration: 500,
    fadeOutDuration: 500,
    // New A3 props — concrete defaults (Object.create bypasses static
    // defaultProps, so mirror them here like the sibling harnesses).
    timeHeightScale: 0,
    timeHeightOrigin: 0,
    reducedMotion: false,
    filterProperty: null,
    filterRange: null,
    filterSoftRange: null,
    filterEnabled: true,
    // Geometry / palette knobs read by prepareTile.
    seamWalls: false,
    elevationScale: 1,
    baseElevation: 0,
    elevationThickness: null,
    colorMapping: null,
    colorMappingDefault: [0, 0, 0, 0],
    _normalize: false,
    _windingOrder: 'CCW',
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = { name: 'time' };
  layer.categoryColorExtension = { name: 'category' };
  layer.dataFilterExtension = { name: 'dataFilter' };
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  layer.lastTilesRef = null;
  return layer;
}

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// DEFAULT-OFF PARITY — the load-bearing byte-identical guarantee
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer new-prop default-off parity', () => {
  it('no filter + no lift ⇒ fill extensions are exactly [time, category]', async () => {
    const layer = await makePolygonLayer();
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props.extensions).toEqual([
      layer.timeFilterExtension,
      layer.categoryColorExtension,
    ]);
    // The column-filter extension is NOT installed when filterProperty is unset.
    expect(fill.props.extensions).not.toContain(layer.dataFilterExtension);
  });

  it('no filterProperty ⇒ no filterValue attribute is baked', async () => {
    const layer = await makePolygonLayer();
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.filterValue).toBeUndefined();
  });

  it('default-off ⇒ no filter props leak onto the fill sublayer', async () => {
    const layer = await makePolygonLayer();
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    // Guarded spreads: the keys must be entirely ABSENT (not undefined) so they
    // never shadow the DataFilterExtension defaultProps.
    expect('filterRange' in fill.props).toBe(false);
    expect('filterSoftRange' in fill.props).toBe(false);
    expect('filterEnabled' in fill.props).toBe(false);
    expect('getFilterValue' in fill.props).toBe(false);
  });

  it('timeHeightScale rides through at the no-op default (0)', async () => {
    const layer = await makePolygonLayer();
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props.timeHeightScale).toBe(0);
    expect(fill.props.timeHeightOrigin).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// timeHeightScale (space-time cube) + reducedMotion gate
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer timeHeightScale', () => {
  it('forwards timeHeightScale / timeHeightOrigin to the fill', async () => {
    const layer = await makePolygonLayer({
      timeHeightScale: 0.5,
      timeHeightOrigin: 1_700_000_000_000,
    });
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props.timeHeightScale).toBe(0.5);
    expect(fill.props.timeHeightOrigin).toBe(1_700_000_000_000);
  });

  it('forwards timeHeightScale to the stroked outline in lock-step', async () => {
    const layer = await makePolygonLayer({
      stroked: true,
      timeHeightScale: 0.25,
      timeHeightOrigin: 42,
    });
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props.timeHeightScale).toBe(0.25);
    expect(outline.props.timeHeightOrigin).toBe(42);
  });

  it('reducedMotion forces the lift to 0 (map stays flat)', async () => {
    const layer = await makePolygonLayer({
      timeHeightScale: 0.9,
      reducedMotion: true,
    });
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props.timeHeightScale).toBe(0);
  });

  it('reducedMotion also flattens the outline lift', async () => {
    const layer = await makePolygonLayer({
      stroked: true,
      timeHeightScale: 0.9,
      reducedMotion: true,
    });
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props.timeHeightScale).toBe(0);
  });

  it('a timeHeightScale change invalidates the cached sublayers', async () => {
    const layer = await makePolygonLayer({ timeHeightScale: 0 });
    layer.state = { tiles: [basePolygonTile()] };
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props.timeHeightScale = 0.5;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.timeHeightScale).toBe(0.5);
  });

  it('a reducedMotion toggle invalidates the cached sublayers', async () => {
    const layer = await makePolygonLayer({
      timeHeightScale: 0.5,
      reducedMotion: false,
    });
    layer.state = { tiles: [basePolygonTile()] };
    const [first] = layer.renderLayers();
    expect(first.props.timeHeightScale).toBe(0.5);
    layer.props.reducedMotion = true;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.timeHeightScale).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DataFilterExtension: filterProperty / filterRange pass-through
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer DataFilterExtension', () => {
  it('filterProperty numeric column bakes a PER-VERTEX filterValue buffer', async () => {
    const layer = await makePolygonLayer({ filterProperty: 'mag' });
    const tile = twoPolygonTile();
    // featureCount 2, vertexCount 8 — one value per FEATURE, expanded per vertex.
    tile.layers[0].features.numericProps['mag'] = new Float32Array([
      3, 7,
    ]) as any;
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const vertexCount = tile.layers[0].features.positions.length / 2;
    const attr = prepared.data.attributes.filterValue;
    expect(attr).toBeDefined();
    expect(attr.size).toBe(1);
    expect(attr.value).toBeInstanceOf(Float32Array);
    expect(attr.value.length).toBe(vertexCount);
    // Each ring's four vertices carry the feature's value.
    expect([...attr.value]).toEqual([3, 3, 3, 3, 7, 7, 7, 7]);
  });

  it('installs DataFilterExtension on the fill and passes range/enabled through', async () => {
    const layer = await makePolygonLayer({
      filterProperty: 'mag',
      filterRange: [2, 5],
      filterSoftRange: [3, 4],
      filterEnabled: true,
    });
    const tile = basePolygonTile();
    tile.layers[0].features.numericProps['mag'] = new Float32Array([4]) as any;
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    // Composed ALONGSIDE the time + category extensions (roomy fill budget).
    expect(fill.props.extensions).toEqual([
      layer.timeFilterExtension,
      layer.categoryColorExtension,
      layer.dataFilterExtension,
    ]);
    expect(fill.props.filterRange).toEqual([2, 5]);
    expect(fill.props.filterSoftRange).toEqual([3, 4]);
    expect(fill.props.filterEnabled).toBe(true);
    expect(fill.props.getFilterValue).toBe(0);
  });

  it('filterEnabled is gated off when the tile lacks the named column', async () => {
    const layer = await makePolygonLayer({
      filterProperty: 'mag',
      filterRange: [2, 5],
      filterEnabled: true,
    });
    // No numericProps['mag'] on this tile → filterValue was never baked.
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.filterValue).toBeUndefined();
    const fill = layer.buildSublayer(prepared);
    // Extension still installed (per-layer constant list) but disabled for
    // this tile so it renders unfiltered rather than clipping everything.
    expect(fill.props.extensions).toContain(layer.dataFilterExtension);
    expect(fill.props.filterEnabled).toBe(false);
  });

  it('filterEnabled:false idles the filter even when the column is present', async () => {
    const layer = await makePolygonLayer({
      filterProperty: 'mag',
      filterRange: [2, 5],
      filterEnabled: false,
    });
    const tile = basePolygonTile();
    tile.layers[0].features.numericProps['mag'] = new Float32Array([4]) as any;
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props.filterEnabled).toBe(false);
  });

  it('the stroked outline filters in lock-step with the fill', async () => {
    const layer = await makePolygonLayer({
      stroked: true,
      filterProperty: 'mag',
      filterRange: [2, 5],
      filterEnabled: true,
    });
    const tile = basePolygonTile();
    tile.layers[0].features.numericProps['mag'] = new Float32Array([4]) as any;
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    // Reuses the SAME per-vertex filterValue buffer as the fill (zero re-expand).
    expect(outline.props.data.attributes.filterValue).toBe(
      prepared.data.attributes.filterValue,
    );
    expect(outline.props.extensions).toEqual([
      layer.timeFilterExtension,
      layer.dataFilterExtension,
    ]);
    expect(outline.props.filterRange).toEqual([2, 5]);
    expect(outline.props.filterEnabled).toBe(true);
  });

  it('a filterRange change invalidates the cached sublayers (uniform-only)', async () => {
    const layer = await makePolygonLayer({
      filterProperty: 'mag',
      filterRange: [2, 5],
    });
    const tile = basePolygonTile();
    tile.layers[0].features.numericProps['mag'] = new Float32Array([4]) as any;
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props.filterRange = [0, 3];
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.filterRange).toEqual([0, 3]);
  });

  it('a categorical filterProperty warns once and bakes no attribute', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePolygonLayer({ filterProperty: 'kind' });
      const tile = basePolygonTile();
      // Present as CATEGORICAL, not numeric → v1 range-filter can't apply.
      tile.layers[0].features.categoricalProps['kind'] = {
        categories: ['a', 'b'],
        indices: new Uint16Array([0]),
      } as any;
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      expect(prepared.data.attributes.filterValue).toBeUndefined();
      const categoricalWarnings = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('categorical'),
      );
      expect(categoricalWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a function filterProperty warns once and installs no filter', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePolygonLayer({
        filterProperty: () => 5,
      });
      const tile = basePolygonTile();
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      expect(prepared.data.attributes.filterValue).toBeUndefined();
      const fill = layer.buildSublayer(prepared);
      // Falls back to "no filter": extension not installed, no filter props.
      expect(fill.props.extensions).not.toContain(layer.dataFilterExtension);
      expect('filterRange' in fill.props).toBe(false);
      const accessorWarnings = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('function accessor'),
      );
      expect(accessorWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// A missing elevation COLUMN must not fall through to deck's 1000 m default
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer missing elevation column', () => {
  it('falls back to elevation 0 and supplies the prop (never deck’s 1000)', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePolygonLayer({
        extruded: true,
        elevation: 'hieght', // typo'd column — the tile carries nothing
      });
      const tile = basePolygonTile();
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      // Neither a per-vertex buffer nor a null constant: null would leave the
      // sublayer prop unset, and SolidPolygonLayer.defaultProps.getElevation
      // is 1000 — every polygon a kilometre tall, with no visible cause.
      expect(prepared.data.attributes.getElevation).toBeUndefined();
      expect(prepared.elevationConstant).toBe(0);
      const fill = layer.buildSublayer(prepared);
      expect('getElevation' in fill.props).toBe(true);
      expect(fill.props.getElevation).toBe(0);

      const missingWarnings = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('elevation column'),
      );
      expect(missingWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns once even across many tiles missing the same column', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePolygonLayer({
        extruded: true,
        elevation: 'height',
      });
      layer.prepareTile(basePolygonTile(), basePolygonTile().layers[0]);
      const second = twoPolygonTile();
      layer.prepareTile(second, second.layers[0]);
      const missingWarnings = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('elevation column'),
      );
      expect(missingWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a column the tile DOES carry still wins (no fallback, no warning)', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePolygonLayer({
        extruded: true,
        elevation: 'height',
      });
      const tile = basePolygonTile();
      tile.layers[0].features.numericProps['height'] = new Float32Array([
        250,
      ]) as any;
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      expect(prepared.elevationConstant).toBeNull();
      expect([...prepared.data.attributes.getElevation.value]).toEqual([
        250, 250, 250, 250,
      ]);
      const fill = layer.buildSublayer(prepared);
      // Per-vertex buffer owns it → no constant shadowing the attribute.
      expect('getElevation' in fill.props).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a CONSTANT elevation is unaffected', async () => {
    const layer = await makePolygonLayer({ extruded: true, elevation: 42 });
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props.getElevation).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Categorical fill × extruded: the GPU palette hook runs AFTER lighting
// ---------------------------------------------------------------------------

/** Attach a categorical column to a polygon tile (fake-tile bakes none). */
function withCategory(
  tile: ReturnType<typeof makePolygonTile>,
  column: string,
  categories: string[],
  indices: number[],
) {
  (tile.layers[0].features.categoricalProps as any)[column] = {
    categories,
    indices: new Uint16Array(indices),
  };
  return tile;
}

describe('AnimatedPolygonLayer categorical fill × extruded', () => {
  const PALETTE = [
    [10, 20, 30, 255],
    [40, 50, 60, 128],
  ];

  it('FLAT keeps the GPU palette path (no lighting to lose)', async () => {
    const layer = await makePolygonLayer({
      extruded: false,
      fillColor: 'kind',
      colorPalette: PALETTE,
    });
    const tile = withCategory(twoPolygonTile(), 'kind', ['a', 'b'], [0, 1]);
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.instanceCategoryIndex).toBeDefined();
    expect(prepared.data.attributes.getFillColor).toBeUndefined();
    expect(prepared.gpuPalette).not.toBeNull();
    const fill = layer.buildSublayer(prepared);
    expect(fill.props.useCategoryColor).toBe(true);
  });

  it('EXTRUDED expands the palette on the CPU into per-vertex getFillColor', async () => {
    // CategoryColorExtension injects at fs:DECKGL_FILTER_COLOR and REPLACES
    // rgb, but SolidPolygonLayer already applied phong lighting in the vertex
    // shader (`vColor`, forwarded verbatim by its fragment shader) — so the
    // GPU path would flatten every prism into an unlit silhouette.
    const layer = await makePolygonLayer({
      extruded: true,
      fillColor: 'kind',
      colorPalette: PALETTE,
    });
    const tile = withCategory(twoPolygonTile(), 'kind', ['a', 'b'], [0, 1]);
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(prepared.data.attributes.instanceCategoryIndex).toBeUndefined();
    expect(prepared.gpuPalette).toBeNull();
    const attr = prepared.data.attributes.getFillColor;
    expect(attr.size).toBe(4);
    expect(attr.normalized).toBe(true);
    expect(attr.value).toBeInstanceOf(Uint8Array);
    // 8 vertices (2 rings of 4); each feature's 4 vertices carry its color.
    expect(attr.value.length).toBe(8 * 4);
    expect([...attr.value.slice(0, 8)]).toEqual([
      10, 20, 30, 255, 10, 20, 30, 255,
    ]);
    expect([...attr.value.slice(16, 24)]).toEqual([
      40, 50, 60, 128, 40, 50, 60, 128,
    ]);

    const fill = layer.buildSublayer(prepared);
    // The GPU branch stays OFF, so the extension's filter hook can't run and
    // the lit color survives to the framebuffer.
    expect(fill.props.useCategoryColor).toBe(false);
    expect(fill.props.categoryPalette).toEqual([]);
  });

  it('NULL categories take colorMappingDefault on the extruded CPU path', async () => {
    const layer = await makePolygonLayer({
      extruded: true,
      fillColor: 'kind',
      colorPalette: PALETTE,
      colorMappingDefault: [1, 2, 3, 4],
    });
    // 0xffff is the NULL sentinel — it must land on the appended default slot,
    // not clamp onto the last real palette entry.
    const tile = withCategory(
      twoPolygonTile(),
      'kind',
      ['a', 'b'],
      [0xffff, 1],
    );
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const value = prepared.data.attributes.getFillColor.value;
    expect([...value.slice(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...value.slice(16, 20)]).toEqual([40, 50, 60, 128]);
  });

  it('toggling extruded re-prepares the tile (the two paths bake different attributes)', async () => {
    const layer = await makePolygonLayer({
      extruded: false,
      fillColor: 'kind',
      colorPalette: PALETTE,
    });
    const tile = withCategory(twoPolygonTile(), 'kind', ['a', 'b'], [0, 1]);
    const flat = layer.prepareTile(tile, tile.layers[0]);
    layer.props = { ...layer.props, extruded: true };
    const extruded = layer.prepareTile(tile, tile.layers[0]);
    expect(extruded.styleKey).not.toBe(flat.styleKey);
    expect(extruded.data.attributes.getFillColor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Geometry-kind guard
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer geometry guard', () => {
  it('skips a LineString tile (which also carries startIndices) with one warning', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePolygonLayer();
      const tile = makePathTile({
        paths: [
          [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
        ],
        startTimes: [0],
        endTimes: [100],
        timeOffset: 0,
      });
      expect(layer.prepareTile(tile, tile.layers[0])).toBeNull();
      layer.state = { tiles: [tile] };
      expect(layer.renderLayers()).toEqual([]);
      const geomWarnings = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('LineString geometry'),
      );
      expect(geomWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts a Polygon tile, and a tile with no geometry tag at all', async () => {
    const layer = await makePolygonLayer();
    const tile = basePolygonTile();
    expect(layer.prepareTile(tile, tile.layers[0])).not.toBeNull();

    // Pre-tag archives / hand-built fixtures: trust the caller.
    const untagged = basePolygonTile();
    (untagged.layers[0].features as any).geometryType = undefined;
    expect(layer.prepareTile(untagged, untagged.layers[0])).not.toBeNull();
  });
});
