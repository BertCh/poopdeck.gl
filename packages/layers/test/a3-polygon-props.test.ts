/**
 * A3 render-parity coverage for AnimatedPolygonLayer's NEW props:
 *   - DataFilterExtension range filter (`filterProperty` / `filterRange` /
 *     `filterSoftRange` / `filterEnabled`);
 *   - `timeHeightScale` (space-time-cube lift) + `reducedMotion` gate.
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
import { makePolygonTile } from './fake-tile';

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
