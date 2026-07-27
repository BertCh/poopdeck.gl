/**
 * AnimatedColumnLayer tests.
 *
 * ColumnLayer is instanced at points exactly like ScatterplotLayer, so the
 * column layer mirrors AnimatedPointLayer's WINDOW-mode binary-sublayer path:
 * one ColumnLayer per (tile, layer), zero-copy positions/times, a per-feature
 * numeric column baked into the size-1 `getElevation` attribute, and a
 * categorical fill that CPU-expands into `instanceFillColors` when EXTRUDED
 * (so the lit color survives DECKGL_FILTER_COLOR) and only lifts to the GPU
 * `instanceCategoryIndex` path for unlit flat disks.
 *
 * These tests exercise the layer's `prepareTile` + `buildSublayer` paths
 * directly (via Object.create, which bypasses CompositeLayer's lifecycle) with
 * a deck.gl mock that captures the constructor args. They pin: the elevation
 * column is baked per-feature, both categorical-fill branches agree on color,
 * the time attributes reach the GPU under the registered names, elevationScale
 * flows through to the sublayer, the getLineWidth alias invalidates cached
 * sublayers, and a non-Point tile is skipped with one named warning.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';

// ---------------------------------------------------------------------------
// deck.gl mocks
// ---------------------------------------------------------------------------
//
// Mock the layer constructor before importing the @stt layer so
// `new ColumnLayer(props)` just stashes the props on the instance. The @stt
// layer itself is real and runs its full prepareTile / buildSublayer path.

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

// Shared `@deck.gl/core` mock reproduces the real
// getSubLayerProps/getSubLayerClass contract without a deck.gl runtime / GPU.
vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake point tile of `n` features, all timestamped sequentially. */
function bigPointTile(n: number) {
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

// ---------------------------------------------------------------------------
// AnimatedColumnLayer per-tile sublayer architecture
// ---------------------------------------------------------------------------

describe('AnimatedColumnLayer per-tile sublayer architecture', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    // Fresh import each test so vi.mock's are applied.
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-column-layer');
    LayerCtor = mod.AnimatedColumnLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — we exercise the
      // per-tile prepare + sublayer-build path directly.
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

  it('uses the binary {length, attributes} shape — no per-feature objects', () => {
    const N = 5000;
    const built = buildSublayerForTile(bigPointTile(N));
    const data = built.props.data;

    // Regression guard: data must NOT be a real Array (which would imply N
    // wrapper objects were allocated).
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(N);
    expect(data.attributes).toBeDefined();
  });

  it('feeds zero-copy binary time attributes under the registered names', () => {
    const N = 100;
    const tile = bigPointTile(N);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;

    // ColumnLayer's own position accessor — keyed by accessor name, padded 3D.
    expect(attrs.getPosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getPosition.size).toBe(3);
    expect(attrs.getPosition.value.length).toBe(N * 3);

    // TimeFilterExtension instanced attributes — keyed by ATTRIBUTE name.
    // Zero-copy: the same Float32Array reference the tile carries.
    expect(attrs.instanceStartTime.value).toBe(
      tile.layers[0].features.startTimes,
    );
    expect(attrs.instanceStartTime.size).toBe(1);
    expect(attrs.instanceEndTime.value).toBe(tile.layers[0].features.endTimes);
    expect(attrs.instanceEndTime.size).toBe(1);

    // With constant elevation/color (no property name), no per-feature buffer
    // is emitted — deck.gl falls back to the constant getElevation/getFillColor.
    expect(attrs.getElevation).toBeUndefined();
    expect(attrs.getFillColor).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeUndefined();
  });

  it('pads 2D positions to size-3 once per tile (z = column base altitude)', () => {
    const tile = bigPointTile(3);
    const built = buildSublayerForTile(tile);
    const positions = built.props.data.attributes.getPosition.value;

    expect(positions[0]).toBe(-180);
    expect(positions[1]).toBe(-90);
    expect(positions[2]).toBe(0);
    expect(positions[3]).toBe(-179);
    expect(positions[4]).toBe(-89);
    expect(positions[5]).toBe(0);
  });

  it('bakes getElevation from a numeric column (per-feature, zero-copy)', () => {
    const N = 6;
    const tile = bigPointTile(N);
    const heights = new Float32Array([10, 20, 30, 40, 50, 60]);
    tile.layers[0].features.numericProps['height'] = heights;

    const built = buildSublayerForTile(tile, { elevation: 'height' });
    const attrs = built.props.data.attributes;

    // ColumnLayer is instanced at points → one elevation value per FEATURE
    // (size 1), not per-vertex. Zero-copy ride-along of the numericProps array.
    expect(attrs.getElevation).toBeDefined();
    expect(attrs.getElevation.value).toBe(heights);
    expect(attrs.getElevation.size).toBe(1);
    expect(attrs.getElevation.value.length).toBe(N);
    expect(attrs.getElevation.value[2]).toBe(30);
  });

  it('accepts getElevation alias (upstream vocabulary) for the height column', () => {
    const tile = bigPointTile(3);
    tile.layers[0].features.numericProps['mag'] = new Float32Array([1, 2, 3]);

    const built = buildSublayerForTile(tile, { getElevation: 'mag' });
    const attrs = built.props.data.attributes;
    expect(attrs.getElevation).toBeDefined();
    expect(attrs.getElevation.value[1]).toBe(2);
  });

  it('hands category indices to the GPU (no per-feature RGBA buffer) for FLAT disks', () => {
    const N = 1000;
    const tile = bigPointTile(N);
    const binary = tile.layers[0].features;
    binary.categoricalProps['vtype'] = {
      indices: new Uint16Array(N).fill(2),
      categories: ['a', 'b', 'c', 'd'],
    };

    const built = buildSublayerForTile(tile, {
      // Flat disks are UNLIT, so the GPU palette write is safe there.
      extruded: false,
      fillColor: 'vtype',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const attrs = built.props.data.attributes;

    // GPU path: no per-feature RGBA — instanceCategoryIndex carries the
    // category id; CategoryColorExtension samples the palette texture.
    expect(attrs.getFillColor).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(attrs.instanceCategoryIndex.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceCategoryIndex.value[0]).toBe(2);
    expect(attrs.instanceCategoryIndex.size).toBe(1);

    // Layer carries the resolved palette + useCategoryColor toggle.
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

  it('leaves the GPU category path idle (useCategoryColor false) for constant fill', () => {
    const built = buildSublayerForTile(bigPointTile(10));
    expect(built.props.useCategoryColor).toBe(false);
    expect(built.props.categoryPalette).toBeUndefined();
  });

  it('flows elevationScale and geometry props through to the sublayer', () => {
    const built = buildSublayerForTile(bigPointTile(5), {
      elevationScale: 7,
      radius: 250,
      diskResolution: 12,
      coverage: 0.8,
      extruded: false,
    });
    expect(built.props.elevationScale).toBe(7);
    expect(built.props.radius).toBe(250);
    expect(built.props.diskResolution).toBe(12);
    expect(built.props.coverage).toBe(0.8);
    expect(built.props.extruded).toBe(false);
  });

  it('forwards the outline-width scale/clamp trio to the sublayer', () => {
    // Symmetric with lineWidthUnits + constant lineWidth/lineColor — the
    // outline-width scale/min/max only bite when stroked:true, but they must
    // reach the ColumnLayer sublayer unconditionally.
    const built = buildSublayerForTile(bigPointTile(5), {
      stroked: true,
      lineWidthScale: 3,
      lineWidthMinPixels: 2,
      lineWidthMaxPixels: 40,
    });
    expect(built.props.lineWidthScale).toBe(3);
    expect(built.props.lineWidthMinPixels).toBe(2);
    expect(built.props.lineWidthMaxPixels).toBe(40);
  });

  it('forwards the outline-width trio defaults (matching deck ColumnLayer)', () => {
    const built = buildSublayerForTile(bigPointTile(5));
    expect(built.props.lineWidthScale).toBe(1);
    expect(built.props.lineWidthMinPixels).toBe(0);
    expect(built.props.lineWidthMaxPixels).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rebuilds the cached ColumnLayer when an outline-width prop changes', () => {
    // The trio changes GPU output, so it must be folded into the layer-props
    // digest — otherwise a cached sublayer would ignore the change.
    const layer = makeLayer();
    const tile = bigPointTile(3);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    layer.props.lineWidthMinPixels = 5;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.lineWidthMinPixels).toBe(5);
  });

  it('forwards constant elevation/fillColor fallbacks for the no-column case', () => {
    const built = buildSublayerForTile(bigPointTile(5), {
      elevation: 500,
      fillColor: [1, 2, 3, 255],
    });
    expect(built.props.getElevation).toBe(500);
    expect(built.props.getFillColor).toEqual([1, 2, 3, 255]);
  });

  it('forwards tile + sttFeatures for picking enrichment', () => {
    const tile = bigPointTile(4);
    const built = buildSublayerForTile(tile);
    expect(built.props.tile).toBe(tile);
    expect(built.props.sttFeatures).toBe(tile.layers[0].features);
  });

  it('passes the bound getTime getter so the time uniform advances each draw', () => {
    const built = buildSublayerForTile(bigPointTile(3));
    expect(typeof built.props.getTime).toBe('function');
  });

  // ── Categorical fill vs. lighting (review fix 1) ────────────────────────────
  //
  // ColumnLayer computes lighting BEFORE DECKGL_FILTER_COLOR (gouraud into
  // vColor, phong into fragColor under flatShading), and
  // CategoryColorExtension's hook REPLACES rgb — so on an EXTRUDED column the
  // GPU palette write discards the lit color and every bar renders as a flat
  // single-tone silhouette. Extruded columns must therefore CPU-expand the
  // palette into instanceFillColors, exactly like the colorMapping path.

  /** A tile whose `vtype` column cycles through `categories`. */
  function categoricalTile(n: number, categories: string[]) {
    const tile = bigPointTile(n);
    const indices = new Uint16Array(n);
    for (let i = 0; i < n; i++) indices[i] = i % categories.length;
    tile.layers[0].features.categoricalProps['vtype'] = { indices, categories };
    return tile;
  }

  const PALETTE = [
    [10, 20, 30, 255],
    [40, 50, 60, 255],
    [70, 80, 90, 255],
  ];

  it('CPU-expands the categorical palette when extruded (the DEFAULT) so lighting survives', () => {
    const built = buildSublayerForTile(categoricalTile(6, ['a', 'b', 'c']), {
      extruded: true,
      fillColor: 'vtype',
      colorPalette: PALETTE,
    });
    const attrs = built.props.data.attributes;

    // Per-feature RGBA rides instanceFillColors → `color` is lit in the vertex
    // stage and the extension never overwrites it.
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(built.props.useCategoryColor).toBe(false);
    expect(built.props.categoryPalette).toBeUndefined();

    expect(attrs.getFillColor).toBeDefined();
    expect(attrs.getFillColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getFillColor.size).toBe(4);
    expect(attrs.getFillColor.normalized).toBe(true);
    expect(Array.from(attrs.getFillColor.value.slice(0, 4))).toEqual(
      PALETTE[0],
    );
    expect(Array.from(attrs.getFillColor.value.slice(4, 8))).toEqual(
      PALETTE[1],
    );
    expect(Array.from(attrs.getFillColor.value.slice(8, 12))).toEqual(
      PALETTE[2],
    );
  });

  it('gives the SAME colors CPU-expanded (extruded) as GPU-sampled (flat)', () => {
    // NULL sentinel + palette overflow are the two cases the two paths could
    // disagree on; the CPU expansion reuses categoryIndicesToFloat32 +
    // appendNullCategorySlot so flipping `extruded` never restyles anything.
    const tile = bigPointTile(3);
    tile.layers[0].features.categoricalProps['vtype'] = {
      // slot 1, palette OVERFLOW (index 5 of a 3-color palette), NULL.
      indices: new Uint16Array([1, 5, 0xffff]),
      categories: ['a', 'b', 'c', 'd', 'e', 'f'],
    };
    const opts = {
      fillColor: 'vtype',
      colorPalette: PALETTE,
      colorMappingDefault: [9, 9, 9, 0],
    };

    const flat = buildSublayerForTile(tile, { ...opts, extruded: false });
    const flatSlots = flat.props.categoryPalette;
    const flatIdx = flat.props.data.attributes.instanceCategoryIndex.value;

    const lit = buildSublayerForTile(tile, { ...opts, extruded: true });
    const rgba = lit.props.data.attributes.getFillColor.value;

    for (let i = 0; i < 3; i++) {
      expect(Array.from(rgba.slice(i * 4, i * 4 + 4))).toEqual(
        flatSlots[flatIdx[i]],
      );
    }
    // Spot-check the intent: overflow clamps to the last real color, NULL takes
    // the appended default slot.
    expect(Array.from(rgba.slice(4, 8))).toEqual(PALETTE[2]);
    expect(Array.from(rgba.slice(8, 12))).toEqual([9, 9, 9, 0]);
  });

  it('re-prepares the tile when `extruded` flips (it selects the color branch)', () => {
    const layer = makeLayer({ fillColor: 'vtype', colorPalette: PALETTE });
    const tile = categoricalTile(4, ['a', 'b']);
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(first.data.attributes.getFillColor).toBeDefined();
    layer.props.extruded = false;
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).not.toBe(first);
    expect(second.data.attributes.getFillColor).toBeUndefined();
    expect(second.data.attributes.instanceCategoryIndex).toBeDefined();
  });

  it('still CPU-expands an explicit colorMapping regardless of `extruded`', () => {
    for (const extruded of [true, false]) {
      const built = buildSublayerForTile(categoricalTile(2, ['a', 'b']), {
        extruded,
        fillColor: 'vtype',
        colorMapping: { a: [1, 2, 3, 255], b: [4, 5, 6, 255] },
      });
      const attrs = built.props.data.attributes;
      expect(attrs.instanceCategoryIndex).toBeUndefined();
      expect(Array.from(attrs.getFillColor.value.slice(0, 4))).toEqual([
        1, 2, 3, 255,
      ]);
    }
  });

  // ── getLineWidth alias reaches the sublayer (review fix 2) ──────────────────

  it('rebuilds the cached ColumnLayer when the getLineWidth ALIAS changes', () => {
    // computeLayerPropsKey used to hash the RAW `lineWidth`, so an alias-only
    // edit left every cached sublayer at the old width (lineColor, two lines
    // below it, always used its resolver — this was a slip, not a convention).
    const layer = makeLayer({ stroked: true });
    const tile = bigPointTile(3);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    expect(first[0].props.getLineWidth).toBe(1);
    layer.props.getLineWidth = 6;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.getLineWidth).toBe(6);
  });

  // ── Geometry-kind guard (review fix 11) ────────────────────────────────────

  it('skips (and warns once about) a non-Point tile instead of misreading it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = bigPointTile(4);
    tile.layers[0].features.geometryType = 1 as any; // LineString
    const layer = makeLayer();
    expect((layer as any).prepareTile(tile, tile.layers[0])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/LineString.*reads Point/);
    warn.mockRestore();
  });

  // ── Documented default divergence (review fix 15) ──────────────────────────

  it('keeps the documented radius divergence from deck ColumnLayer (100, not 1000)', () => {
    expect(LayerCtor.defaultProps.radius.value).toBe(100);
  });
});
