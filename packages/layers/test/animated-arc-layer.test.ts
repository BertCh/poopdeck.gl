/**
 * Per-tile sublayer architecture tests for the OD flow layers
 * (AnimatedArcLayer / AnimatedLineLayer).
 *
 * Both render deck.gl's instanced source→target layers (ArcLayer / LineLayer)
 * one sublayer per tile. The structural contract mirrors the path family
 * (see layer-data-shape.test.ts): binary `data: { length, attributes }` with no
 * per-feature wrapper objects, zero-copy time attributes, per-tile timeOffset,
 * and a stable sublayer instance across renders. The OD-specific piece is the
 * source/target endpoint derivation: a 2-vertex LineString feature must produce
 * getSourcePosition = vertex 0 and getTargetPosition = vertex 1.
 *
 * deck.gl layers need a GPU to instantiate, so we mock `@deck.gl/layers`
 * (ArcLayer / LineLayer just stash props) and `@deck.gl/core` (the shared
 * getSubLayerProps/getSubLayerClass contract), then exercise the real
 * prepareTile + buildSublayer paths via Object.create.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePathTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeArcLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeLineLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return {
    ArcLayer: FakeArcLayer,
    LineLayer: FakeLineLayer,
  };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/** Build a fake OD tile: `n` features, each a 2-vertex LineString (source→target). */
function odTile(n: number) {
  const paths: number[][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    paths[i] = [
      [i * 0.1, i * 0.2], // source
      [i * 0.1 + 1, i * 0.2 + 1], // target
    ];
  }
  const startTimes = new Array(n).fill(0);
  const endTimes = new Array(n).fill(1000);
  return makePathTile({ paths, startTimes, endTimes, timeOffset: 0 });
}

// ---------------------------------------------------------------------------
// AnimatedArcLayer
// ---------------------------------------------------------------------------

describe('AnimatedArcLayer per-tile sublayer architecture (v3)', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-arc-layer');
    LayerCtor = mod.AnimatedArcLayer as any;

    makeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'arcs',
        sourceColor: [0, 150, 255, 255],
        targetColor: [255, 127, 14, 255],
        width: 2,
        widthUnits: 'pixels',
        greatCircle: false,
        arcHeight: 1,
        arcTilt: 0,
        timeWindow: 1000,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = {};
      layer.categoryColorExtension = {};
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

  it('hands deck.gl the binary {length, attributes} shape — no startIndices, no wrappers', () => {
    const N = 100;
    const built = buildSublayerForTile(odTile(N));
    const data = built.props.data;

    // Regression guard: data must NOT be a plain Array.
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(N);
    expect(data.attributes).toBeDefined();
    // ArcLayer is instanced source→target — NOT path-based — so no startIndices.
    expect(data.startIndices).toBeUndefined();
  });

  it('derives getSourcePosition (first vertex) / getTargetPosition (last vertex)', () => {
    const tile = odTile(3);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;

    expect(attrs.getSourcePosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getTargetPosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getSourcePosition.size).toBe(2);
    expect(attrs.getTargetPosition.size).toBe(2);
    expect(attrs.getSourcePosition.value.length).toBe(3 * 2);

    // Feature 1: source = [0.1, 0.2], target = [1.1, 1.2].
    expect(attrs.getSourcePosition.value[2]).toBeCloseTo(0.1);
    expect(attrs.getSourcePosition.value[3]).toBeCloseTo(0.2);
    expect(attrs.getTargetPosition.value[2]).toBeCloseTo(1.1);
    expect(attrs.getTargetPosition.value[3]).toBeCloseTo(1.2);
  });

  it('feeds zero-copy instanceStartTime / instanceEndTime (one per feature)', () => {
    const tile = odTile(5);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;

    // Same Float32Array references the tile carries — ArcLayer is instanced, so
    // one start/end per feature (no per-vertex expansion).
    expect(attrs.instanceStartTime.value).toBe(
      tile.layers[0].features.startTimes,
    );
    expect(attrs.instanceStartTime.size).toBe(1);
    expect(attrs.instanceEndTime.value).toBe(tile.layers[0].features.endTimes);
    expect(attrs.instanceEndTime.size).toBe(1);
  });

  it('carries 2D endpoints via attribute `size`, NOT a positionFormat override', () => {
    // ArcLayer has no tesselator and never reads `positionFormat` (only the
    // path / polygon families do), so the layer must not pass one — what makes
    // a 2D tile buffer read correctly is `size: dims` on the endpoint
    // attributes. Passing 'XY' shadowed the inherited value for nothing.
    const built = buildSublayerForTile(odTile(4));
    expect(built.props.positionFormat).toBeUndefined();
    expect(built.props.data.attributes.getSourcePosition.size).toBe(2);
    expect(built.props.data.attributes.getTargetPosition.size).toBe(2);
  });

  it('forwards the greatCircle prop to ArcLayer', () => {
    const flat = buildSublayerForTile(odTile(3), { greatCircle: false });
    expect(flat.props.greatCircle).toBe(false);
    const gc = buildSublayerForTile(odTile(3), { greatCircle: true });
    expect(gc.props.greatCircle).toBe(true);
  });

  it('forwards the numSegments arc-tessellation prop to ArcLayer', () => {
    const built = buildSublayerForTile(odTile(3), { numSegments: 12 });
    expect(built.props.numSegments).toBe(12);
  });

  it('forwards arcHeight / arcTilt as ArcLayer getHeight / getTilt constants', () => {
    const built = buildSublayerForTile(odTile(3), {
      arcHeight: 0.5,
      arcTilt: 30,
    });
    expect(built.props.getHeight).toBe(0.5);
    expect(built.props.getTilt).toBe(30);
  });

  it('passes constant source/target colors when no category column is named', () => {
    const built = buildSublayerForTile(odTile(3), {
      sourceColor: [1, 2, 3, 255],
      targetColor: [4, 5, 6, 255],
    });
    const attrs = built.props.data.attributes;
    expect(built.props.getSourceColor).toEqual([1, 2, 3, 255]);
    expect(built.props.getTargetColor).toEqual([4, 5, 6, 255]);
    // Constant path: no GPU category index, useCategoryColor off.
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(built.props.useCategoryColor).toBe(false);
  });

  it('builds instanceCategoryIndex for the GPU when sourceColor names a column', () => {
    const tile = odTile(8);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 2, 1, 0, 2, 1, 0]),
      categories: ['a', 'b', 'c'],
    };
    const built = buildSublayerForTile(tile, {
      sourceColor: 'kind',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const attrs = built.props.data.attributes;
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(attrs.instanceCategoryIndex.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceCategoryIndex.size).toBe(1);
    expect(attrs.instanceCategoryIndex.value[2]).toBe(2);
    expect(built.props.useCategoryColor).toBe(true);
    expect(built.props.categoryPalette).toEqual([
      [10, 20, 30, 255],
      [40, 50, 60, 255],
      [70, 80, 90, 255],
      // Appended NULL slot: 0xffff features render transparent, not the
      // last palette color (see appendNullCategorySlot).
      [0, 0, 0, 0],
    ]);
  });

  it('also drives the GPU category path when only targetColor names a column', () => {
    const tile = odTile(4);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 2, 1]),
      categories: ['a', 'b', 'c'],
    };
    const built = buildSublayerForTile(tile, {
      targetColor: 'kind',
      colorPalette: [[10, 20, 30, 255]],
    });
    expect(built.props.data.attributes.instanceCategoryIndex).toBeDefined();
    expect(built.props.useCategoryColor).toBe(true);
  });

  it('binds a per-feature width column when width names a numeric property', () => {
    const tile = odTile(3);
    tile.layers[0].features.numericProps['vol'] = new Float32Array([5, 10, 15]);
    const built = buildSublayerForTile(tile, { width: 'vol' });
    const attrs = built.props.data.attributes;
    expect(attrs.getWidth.value).toBe(
      tile.layers[0].features.numericProps['vol'],
    );
    expect(attrs.getWidth.size).toBe(1);
  });

  it('passes the bound getTime getter so the window uniform advances each draw', () => {
    const built = buildSublayerForTile(odTile(3));
    expect(typeof built.props.getTime).toBe('function');
  });

  it('resolves the getSourceColor accessor alias over the legacy sourceColor', () => {
    const built = buildSublayerForTile(odTile(3), {
      sourceColor: [0, 0, 0, 255],
      getSourceColor: [9, 9, 9, 255],
    });
    expect(built.props.getSourceColor).toEqual([9, 9, 9, 255]);
  });

  // ── Per-feature arc height / tilt (review fix 7) ───────────────────────────
  //
  // Upstream registers instanceHeights / instanceTilts as ordinary per-instance
  // accessors (arc-layer.ts), so a baked numeric column rides them zero-copy
  // exactly like getWidth. Constants-only meant overlapping flows on the same
  // OD pair could not be separated — the documented purpose of getTilt.

  it('binds per-feature arcHeight / arcTilt columns zero-copy', () => {
    const tile = odTile(3);
    const nums = tile.layers[0].features.numericProps;
    nums['h'] = new Float32Array([0.2, 0.6, 1.4]);
    nums['tilt'] = new Float32Array([-30, 0, 30]);
    const built = buildSublayerForTile(tile, {
      arcHeight: 'h',
      arcTilt: 'tilt',
    });
    const attrs = built.props.data.attributes;

    expect(attrs.getHeight.value).toBe(nums['h']);
    expect(attrs.getHeight.size).toBe(1);
    expect(attrs.getTilt.value).toBe(nums['tilt']);
    expect(attrs.getTilt.size).toBe(1);
  });

  it('accepts the getHeight / getTilt aliases for the column arm too', () => {
    const tile = odTile(3);
    tile.layers[0].features.numericProps['h'] = new Float32Array([1, 2, 3]);
    const built = buildSublayerForTile(tile, {
      arcHeight: 9, // legacy constant loses to the alias
      getHeight: 'h',
      getTilt: 'missing', // absent column → constant fallback, no attribute
    });
    expect(built.props.data.attributes.getHeight.value).toBe(
      tile.layers[0].features.numericProps['h'],
    );
    expect(built.props.data.attributes.getTilt).toBeUndefined();
    // Constant fallbacks for tiles lacking the column: the layer defaults, not
    // the column-name string.
    expect(built.props.getHeight).toBe(1);
    expect(built.props.getTilt).toBe(0);
  });

  it('keeps passing constants when arcHeight / arcTilt are numbers', () => {
    const built = buildSublayerForTile(odTile(3), {
      arcHeight: 0.5,
      arcTilt: 30,
    });
    expect(built.props.getHeight).toBe(0.5);
    expect(built.props.getTilt).toBe(30);
    expect(built.props.data.attributes.getHeight).toBeUndefined();
    expect(built.props.data.attributes.getTilt).toBeUndefined();
  });

  it('re-prepares tiles when the arcHeight COLUMN name changes', () => {
    const layer = makeLayer({ arcHeight: 'a' });
    const tile = odTile(3);
    tile.layers[0].features.numericProps['a'] = new Float32Array([1, 2, 3]);
    tile.layers[0].features.numericProps['b'] = new Float32Array([4, 5, 6]);
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    layer.props.arcHeight = 'b';
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).not.toBe(first);
    expect(second.data.attributes.getHeight.value).toBe(
      tile.layers[0].features.numericProps['b'],
    );
  });

  // ── Geometry-kind guard (review fix 11) ────────────────────────────────────

  it('skips (and warns once about) a non-LineString tile instead of rendering nothing silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = odTile(3);
    tile.layers[0].features.geometryType = 0 as any; // Point
    const layer = makeLayer();
    expect((layer as any).prepareTile(tile, tile.layers[0])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Point.*reads LineString/);
    warn.mockRestore();
  });

  // ── Empty tile set releases derived buffers (review fix 12) ────────────────

  it('clears the prepared/sublayer caches when the tile set empties', () => {
    const layer = makeLayer();
    layer.state = { tiles: [odTile(3)] };
    expect((layer as any).renderLayers().length).toBe(1);
    expect(layer.preparedTileCache.size).toBe(1);
    expect(layer.sublayerCache.size).toBe(1);

    // Scrubbing to an empty range must not pin the derived endpoint buffers —
    // nor the references they hold into already-evicted tiles.
    layer.state = { tiles: [] };
    expect((layer as any).renderLayers()).toEqual([]);
    expect(layer.preparedTileCache.size).toBe(0);
    expect(layer.sublayerCache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AnimatedLineLayer
// ---------------------------------------------------------------------------

describe('AnimatedLineLayer per-tile sublayer architecture (v3)', () => {
  let LayerCtor: any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-line-layer');
    LayerCtor = mod.AnimatedLineLayer as any;

    buildSublayerForTile = (tile, opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'lines',
        color: [0, 150, 255, 255],
        width: 1,
        widthUnits: 'pixels',
        timeWindow: 1000,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = {};
      layer.categoryColorExtension = {};
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      return (layer as any).buildSublayer(
        (layer as any).prepareTile(tile, tile.layers[0]),
      );
    };
  });

  it('hands deck.gl the binary {length, attributes} shape — no startIndices', () => {
    const built = buildSublayerForTile(odTile(50));
    const data = built.props.data;
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(50);
    expect(data.startIndices).toBeUndefined();
  });

  it('derives source/target endpoints and zero-copy time attributes', () => {
    const tile = odTile(4);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;
    expect(attrs.getSourcePosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getTargetPosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.instanceStartTime.value).toBe(
      tile.layers[0].features.startTimes,
    );
    expect(attrs.instanceEndTime.value).toBe(tile.layers[0].features.endTimes);
  });

  it('carries 2D endpoints via attribute `size` (LineLayer ignores positionFormat too)', () => {
    const built = buildSublayerForTile(odTile(3));
    expect(built.props.positionFormat).toBeUndefined();
    expect(built.props.data.attributes.getSourcePosition.size).toBe(2);
    expect(built.props.data.attributes.getTargetPosition.size).toBe(2);
  });

  it('passes a constant color when no category column is named', () => {
    const built = buildSublayerForTile(odTile(3), { color: [7, 8, 9, 255] });
    expect(built.props.getColor).toEqual([7, 8, 9, 255]);
    expect(built.props.data.attributes.instanceCategoryIndex).toBeUndefined();
    expect(built.props.useCategoryColor).toBe(false);
  });

  it('builds instanceCategoryIndex for the GPU when color names a column', () => {
    const tile = odTile(6);
    tile.layers[0].features.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1, 2, 1, 0, 2]),
      categories: ['a', 'b', 'c'],
    };
    const built = buildSublayerForTile(tile, {
      color: 'kind',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const attrs = built.props.data.attributes;
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(attrs.instanceCategoryIndex.value[2]).toBe(2);
    expect(built.props.useCategoryColor).toBe(true);
  });
});
