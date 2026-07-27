/**
 * AnimatedColumnLayer — B5 kind-parity additions.
 *
 * Pins the three parity props added to the column layer:
 *   1. DataFilterExtension support (`filterProperty` / `filterRange` /
 *      `filterSoftRange` / `filterEnabled`) — installs the extension and binds
 *      the named numeric column zero-copy to the `filterValue` attribute.
 *   2. `timeHeightScale` / `timeHeightOrigin` (space-time cube) — forwarded to
 *      the per-tile TimeFilterExtension for the flat↔cube lift.
 *   3. Stable per-category `colorMapping` — CPU-expands an explicit
 *      `{ category: Color }` map into a per-feature `getFillColor` buffer (a
 *      category string can't hash to a palette slot on the GPU), leaving the
 *      GPU CategoryColorExtension path idle.
 *
 * Plus a default-off byte-identity guard: with NONE of the additions set (and
 * with them explicitly `undefined`, exercising the defaultProps shadow gotcha)
 * the built sublayer is identical to the pre-addition shape — no filter
 * attribute, no DataFilterExtension, the GPU category/constant path unchanged.
 *
 * Exercises `prepareTile` + `buildSublayer` directly via Object.create (as the
 * sibling animated-column-layer.test.ts does), with a deck.gl mock capturing
 * the constructor args.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeColumnLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { ColumnLayer: FakeColumnLayer };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/** A fake point tile of `n` features with sequential timestamps. */
function pointTile(n: number) {
  const positions: number[][] = new Array(n);
  const startTimes: number[] = new Array(n);
  const endTimes: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    positions[i] = [(i % 360) - 180, (i % 180) - 90];
    startTimes[i] = i;
    endTimes[i] = i + 1;
  }
  return makePointTile({ positions, startTimes, endTimes, timeOffset: 0 });
}

describe('AnimatedColumnLayer — B5 parity props', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;
  // Sentinel objects so we can assert extension INSTALL by reference identity.
  const timeExt = { __ext: 'time' };
  const catExt = { __ext: 'category' };
  const filterExt = { __ext: 'dataFilter' };

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-column-layer');
    LayerCtor = mod.AnimatedColumnLayer as any;

    makeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        fillColor: [255, 140, 0, 255],
        elevation: 1000,
        elevationScale: 1,
        radius: 100,
        radiusUnits: 'meters',
        diskResolution: 20,
        extruded: true,
        filled: true,
        stroked: false,
        lineColor: [0, 0, 0, 255],
        lineWidth: 1,
        lineWidthUnits: 'meters',
        lineWidthScale: 1,
        lineWidthMinPixels: 0,
        lineWidthMaxPixels: Number.MAX_SAFE_INTEGER,
        material: true,
        timeWindow: 1000,
        fadeInDuration: 300,
        fadeOutDuration: 300,
        // Real defaultProps values for the props buildSublayer always reads.
        colorMappingDefault: [0, 0, 0, 0],
        filterEnabled: true,
        timeHeightScale: 0,
        timeHeightOrigin: 0,
        reducedMotion: false,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = timeExt;
      layer.categoryColorExtension = catExt;
      layer.dataFilterExtension = filterExt;
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      return layer;
    };

    buildSublayerForTile = (tile, opts = {}) => {
      const layer = makeLayer(opts);
      return (layer as any).buildSublayer(
        (layer as any).prepareTile(tile, tile.layers[0]),
      );
    };
  });

  // -------------------------------------------------------------------------
  // 1. DataFilterExtension
  // -------------------------------------------------------------------------

  it('binds a numeric filterProperty column zero-copy to the filterValue attribute', () => {
    const N = 6;
    const tile = pointTile(N);
    const speed = new Float32Array([1, 2, 3, 4, 5, 6]);
    tile.layers[0].features.numericProps['speed'] = speed;

    const built = buildSublayerForTile(tile, {
      filterProperty: 'speed',
      filterRange: [2, 5],
    });
    const attrs = built.props.data.attributes;

    // Zero-copy: the same Float32Array reference the tile carries, size 1.
    expect(attrs.filterValue).toBeDefined();
    expect(attrs.filterValue.value).toBe(speed);
    expect(attrs.filterValue.size).toBe(1);
  });

  it('installs DataFilterExtension and forwards the filter uniforms only when filterProperty is set', () => {
    const tile = pointTile(4);
    tile.layers[0].features.numericProps['speed'] = new Float32Array([
      1, 2, 3, 4,
    ]);
    const built = buildSublayerForTile(tile, {
      filterProperty: 'speed',
      filterRange: [1, 3],
      filterSoftRange: [1.5, 2.5],
      filterEnabled: true,
    });

    expect(built.props.extensions).toContain(filterExt);
    expect(built.props.filterRange).toEqual([1, 3]);
    expect(built.props.filterSoftRange).toEqual([1.5, 2.5]);
    // Enabled is gated on THIS tile having baked the column (it did).
    expect(built.props.filterEnabled).toBe(true);
    // Constant fallback for tiles missing the column.
    expect(built.props.getFilterValue).toBe(0);
  });

  it('gates filterEnabled off for a tile that lacks the named column', () => {
    // No `speed` column on this tile → the filter idles (renders everything).
    const built = buildSublayerForTile(pointTile(4), {
      filterProperty: 'speed',
      filterRange: [1, 3],
      filterEnabled: true,
    });
    expect(built.props.data.attributes.filterValue).toBeUndefined();
    // Extension still installed (per-layer constant list), but disabled here.
    expect(built.props.extensions).toContain(filterExt);
    expect(built.props.filterEnabled).toBe(false);
  });

  it('warns and skips the filter when filterProperty names a categorical column', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = pointTile(4);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 0, 1]),
      categories: ['a', 'b'],
    };
    const built = buildSublayerForTile(tile, {
      filterProperty: 'kind',
      filterRange: [0, 1],
    });
    expect(built.props.data.attributes.filterValue).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 2. timeHeightScale
  // -------------------------------------------------------------------------

  it('forwards timeHeightScale / timeHeightOrigin to the sublayer (space-time cube)', () => {
    const built = buildSublayerForTile(pointTile(5), {
      timeHeightScale: 0.5,
      timeHeightOrigin: 1000,
    });
    expect(built.props.timeHeightScale).toBe(0.5);
    expect(built.props.timeHeightOrigin).toBe(1000);
  });

  it('rebuilds the cached ColumnLayer when timeHeightScale changes', () => {
    const layer = makeLayer();
    const tile = pointTile(3);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    layer.props.timeHeightScale = 0.25;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.timeHeightScale).toBe(0.25);
  });

  // -------------------------------------------------------------------------
  // 2b. reducedMotion gate (space-time cube stays flat)
  // -------------------------------------------------------------------------

  it('forces timeHeightScale to 0 under reducedMotion (columns stay flat)', () => {
    const built = buildSublayerForTile(pointTile(5), {
      timeHeightScale: 0.5,
      timeHeightOrigin: 1000,
      reducedMotion: true,
    });
    // The lift is suppressed; the origin still rides through (a no-op at scale 0).
    expect(built.props.timeHeightScale).toBe(0);
    expect(built.props.timeHeightOrigin).toBe(1000);
  });

  it('rebuilds the cached ColumnLayer when reducedMotion toggles', () => {
    const layer = makeLayer({ timeHeightScale: 0.5 });
    const tile = pointTile(3);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    expect(first[0].props.timeHeightScale).toBe(0.5);
    layer.props.reducedMotion = true;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.timeHeightScale).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Stable per-category colorMapping
  // -------------------------------------------------------------------------

  it('CPU-expands a stable per-category colorMapping into a getFillColor buffer', () => {
    const N = 4;
    const tile = pointTile(N);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 2, 0]),
      categories: ['car', 'bus', 'bike'],
    };

    const built = buildSublayerForTile(tile, {
      fillColor: 'kind',
      colorMapping: {
        car: [10, 0, 0, 255],
        bus: [0, 20, 0, 255],
        bike: [0, 0, 30, 255],
      },
    });
    const attrs = built.props.data.attributes;

    // CPU branch: a per-feature RGBA buffer, NOT the GPU index path.
    expect(attrs.getFillColor).toBeDefined();
    expect(attrs.getFillColor.size).toBe(4);
    expect(attrs.getFillColor.normalized).toBe(true);
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    // GPU category path idles.
    expect(built.props.useCategoryColor).toBe(false);
    expect(built.props.categoryPalette).toBeUndefined();

    // Stable per-category: feature 0 (car) and feature 3 (car) share the color,
    // regardless of their index within the tile.
    const buf = attrs.getFillColor.value as Uint8Array;
    expect(Array.from(buf.slice(0, 4))).toEqual([10, 0, 0, 255]);
    expect(Array.from(buf.slice(4, 8))).toEqual([0, 20, 0, 255]);
    expect(Array.from(buf.slice(8, 12))).toEqual([0, 0, 30, 255]);
    expect(Array.from(buf.slice(12, 16))).toEqual([10, 0, 0, 255]);
  });

  it('falls back to colorMappingDefault for categories absent from colorMapping', () => {
    const N = 2;
    const tile = pointTile(N);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1]),
      categories: ['car', 'boat'],
    };
    const built = buildSublayerForTile(tile, {
      fillColor: 'kind',
      colorMapping: { car: [10, 0, 0, 255] },
      colorMappingDefault: [7, 7, 7, 255],
    });
    const buf = built.props.data.attributes.getFillColor.value as Uint8Array;
    expect(Array.from(buf.slice(0, 4))).toEqual([10, 0, 0, 255]);
    // 'boat' is unmapped → the fallback.
    expect(Array.from(buf.slice(4, 8))).toEqual([7, 7, 7, 255]);
  });

  // -------------------------------------------------------------------------
  // 4. Default-off byte-identity
  // -------------------------------------------------------------------------

  /** Serialize only the prop surface the additions could perturb. */
  function fingerprint(built: any) {
    const attrs = built.props.data.attributes;
    return {
      attrKeys: Object.keys(attrs).sort(),
      installsDataFilter: built.props.extensions.includes(filterExt),
      useCategoryColor: built.props.useCategoryColor,
      categoryPalette: built.props.categoryPalette,
      getFillColor: built.props.getFillColor,
      getElevation: built.props.getElevation,
      filterRange: built.props.filterRange,
      filterSoftRange: built.props.filterSoftRange,
      filterEnabled: built.props.filterEnabled,
      getFilterValue: built.props.getFilterValue,
      timeHeightScale: built.props.timeHeightScale,
      timeHeightOrigin: built.props.timeHeightOrigin,
    };
  }

  it('is byte-identical with the additions unset vs explicitly undefined', () => {
    const N = 8;
    // Categorical fill on FLAT disks so the GPU category path is live —
    // proving the colorMapping addition leaves it untouched when the map is
    // absent. (Extruded columns deliberately CPU-expand instead, so the lit
    // color survives DECKGL_FILTER_COLOR — see animated-column-layer.test.ts.)
    const withCat = () => {
      const tile = pointTile(N);
      tile.layers[0].features.categoricalProps['kind'] = {
        indices: new Uint16Array(N).fill(1),
        categories: ['a', 'b', 'c'],
      };
      tile.layers[0].features.numericProps['h'] = new Float32Array(N).fill(5);
      return tile;
    };

    const omitted = buildSublayerForTile(withCat(), {
      extruded: false,
      fillColor: 'kind',
      elevation: 'h',
    });
    // The defaultProps shadow gotcha: an explicit `undefined` must behave
    // exactly like omission — the layer never spreads it into the sublayer.
    const explicitUndefined = buildSublayerForTile(withCat(), {
      extruded: false,
      fillColor: 'kind',
      elevation: 'h',
      colorMapping: undefined,
      colorMappingDefault: [0, 0, 0, 0],
      filterProperty: undefined,
      filterRange: undefined,
      filterSoftRange: undefined,
      filterEnabled: true,
      timeHeightScale: 0,
      timeHeightOrigin: 0,
    });

    expect(fingerprint(explicitUndefined)).toEqual(fingerprint(omitted));

    // And the concrete default-off invariants: no filter surface, GPU category
    // path intact, height column still baked.
    const fp = fingerprint(omitted);
    expect(fp.installsDataFilter).toBe(false);
    expect(fp.filterRange).toBeUndefined();
    expect(fp.filterEnabled).toBeUndefined();
    expect(fp.getFilterValue).toBeUndefined();
    expect(fp.useCategoryColor).toBe(true);
    expect(fp.attrKeys).not.toContain('filterValue');
    expect(fp.attrKeys).toContain('instanceCategoryIndex');
    expect(fp.attrKeys).toContain('getElevation');
    // Space-time cube off by default (a static 0 lift == flat map).
    expect(fp.timeHeightScale).toBe(0);
    expect(fp.timeHeightOrigin).toBe(0);
  });
});
