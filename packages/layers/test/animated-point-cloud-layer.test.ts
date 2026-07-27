/**
 * AnimatedPointCloudLayer tests.
 *
 * PointCloudLayer is instanced at points exactly like ScatterplotLayer, so this
 * layer mirrors AnimatedPointLayer's WINDOW-mode binary-sublayer path: one
 * PointCloudLayer per (tile, layer), zero-copy positions/times, the four-way
 * colour resolution (interleaved RGBA vector column / three RGB numeric columns
 * / CPU-expanded categorical palette — this layer is phong-LIT, so it never
 * lifts categories to the post-lighting CategoryColorExtension / constant), a
 * zero-copy [nx,ny,nz] normal vector column, and per-tile timeOffset.
 *
 * These tests exercise `prepareTile` + `buildSublayer` directly (via
 * Object.create, bypassing CompositeLayer's lifecycle) with a deck.gl mock that
 * captures the constructor args.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';

// ---------------------------------------------------------------------------
// deck.gl mocks
// ---------------------------------------------------------------------------

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakePointCloudLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { PointCloudLayer: FakePointCloudLayer };
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
// AnimatedPointCloudLayer per-tile sublayer architecture
// ---------------------------------------------------------------------------

describe('AnimatedPointCloudLayer per-tile sublayer architecture', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-point-cloud-layer');
    LayerCtor = mod.AnimatedPointCloudLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — we exercise the
      // per-tile prepare + sublayer-build path directly.
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        sizeUnits: 'pixels',
        pointSize: 10,
        material: true,
        color: [255, 255, 255, 255],
        getColor: null,
        colorPalette: undefined,
        colorMapping: null,
        colorMappingDefault: [0, 0, 0, 0],
        rgbColorColumns: null,
        colorVectorColumn: 'point_rgba',
        normalColumn: 'normal',
        elevationProperty: null,
        elevationScale: 1,
        timeWindow: 1000,
        timeHeightScale: 0,
        timeHeightOrigin: 0,
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
      layer.lastTilesRef = null;
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
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(N);
    expect(data.attributes).toBeDefined();
  });

  it('feeds zero-copy binary time attributes under the registered names', () => {
    const N = 100;
    const tile = bigPointTile(N);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;

    // PointCloudLayer position accessor — keyed by accessor name, padded 3D.
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

    // With a constant colour and no columns, no per-feature colour/normal
    // buffer is emitted — deck falls back to the constant getColor / [0,0,1].
    expect(attrs.getColor).toBeUndefined();
    expect(attrs.getNormal).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeUndefined();
  });

  it('pads 2D positions to size-3 once per tile (z = 0)', () => {
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

  it('binds getColor zero-copy from an interleaved RGBA vector column', () => {
    const N = 4;
    const tile = bigPointTile(N);
    const rgba = new Uint8Array(N * 4);
    for (let i = 0; i < N * 4; i++) rgba[i] = i;
    tile.layers[0].features.vectorProps = {
      point_rgba: { value: rgba, size: 4 },
    };

    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;
    // Zero-copy: same buffer reference, normalized u8 RGBA.
    expect(attrs.getColor.value).toBe(rgba);
    expect(attrs.getColor.size).toBe(4);
    expect(attrs.getColor.normalized).toBe(true);
    // No GPU category surface at all on this layer (see the extension-removal
    // test below).
    expect(built.props.useCategoryColor).toBeUndefined();
  });

  it('expands getColor from three RGB numeric columns', () => {
    const N = 3;
    const tile = bigPointTile(N);
    const binary = tile.layers[0].features;
    binary.numericProps['r'] = new Float32Array([10, 20, 30]);
    binary.numericProps['g'] = new Float32Array([40, 50, 60]);
    binary.numericProps['b'] = new Float32Array([70, 80, 90]);

    const built = buildSublayerForTile(tile, {
      // no vector column present, so the RGB triple wins
      colorVectorColumn: null,
      rgbColorColumns: ['r', 'g', 'b'],
    });
    const attrs = built.props.data.attributes;
    expect(attrs.getColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getColor.size).toBe(4);
    expect(attrs.getColor.normalized).toBe(true);
    expect(Array.from(attrs.getColor.value.slice(0, 4))).toEqual([
      10, 40, 70, 255,
    ]);
  });

  it('CPU-expands the palette into a LIT per-point RGBA getColor for categorical colour', () => {
    const N = 1000;
    const tile = bigPointTile(N);
    const binary = tile.layers[0].features;
    binary.categoricalProps['vtype'] = {
      indices: new Uint16Array(N).fill(2),
      categories: ['a', 'b', 'c', 'd'],
    };

    const built = buildSublayerForTile(tile, {
      color: 'vtype',
      colorVectorColumn: null,
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const attrs = built.props.data.attributes;

    // Categorical colour rides getColor (instanceColors) so it is Gouraud-LIT
    // like every other colour path — NOT the GPU CategoryColorExtension, which
    // replaces colour after lighting (flat/unshaded), inconsistent with this
    // phong-lit layer.
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(attrs.getColor).toBeDefined();
    expect(attrs.getColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getColor.size).toBe(4);
    expect(attrs.getColor.normalized).toBe(true);
    // Every point is category index 2 → palette[2] = [70, 80, 90, 255].
    expect(Array.from(attrs.getColor.value.slice(0, 4))).toEqual([
      70, 80, 90, 255,
    ]);
    // No GPU category surface at all (no unlit fragment replace).
    expect(built.props.useCategoryColor).toBeUndefined();
    expect(built.props.categoryPalette).toBeUndefined();
  });

  it('passes the constant colour fallback with no category surface', () => {
    const built = buildSublayerForTile(bigPointTile(10));
    expect(built.props.useCategoryColor).toBeUndefined();
    expect(built.props.categoryPalette).toBeUndefined();
    // Constant colour fallback reaches the sublayer.
    expect(built.props.getColor).toEqual([255, 255, 255, 255]);
  });

  it('binds getNormal zero-copy from a [nx,ny,nz] vector column when present', () => {
    const N = 3;
    const tile = bigPointTile(N);
    const normals = new Float32Array([0, 0, 1, 1, 0, 0, 0, 1, 0]);
    tile.layers[0].features.vectorProps = {
      normal: { value: normals, size: 3 },
    };

    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;
    expect(attrs.getNormal.value).toBe(normals);
    expect(attrs.getNormal.size).toBe(3);
  });

  it('omits getNormal (deck default [0,0,1]) when no normal column is present', () => {
    const built = buildSublayerForTile(bigPointTile(5));
    expect(built.props.data.attributes.getNormal).toBeUndefined();
  });

  it('bakes per-point z from an elevation column', () => {
    const N = 3;
    const tile = bigPointTile(N);
    tile.layers[0].features.numericProps['alt'] = new Float32Array([5, 10, 15]);

    const built = buildSublayerForTile(tile, {
      elevationProperty: 'alt',
      elevationScale: 2,
    });
    const positions = built.props.data.attributes.getPosition.value;
    expect(positions[2]).toBe(10);
    expect(positions[5]).toBe(20);
    expect(positions[8]).toBe(30);
  });

  it('forwards sizeUnits / pointSize / material to the sublayer', () => {
    const built = buildSublayerForTile(bigPointTile(5), {
      sizeUnits: 'meters',
      pointSize: 42,
      material: false,
    });
    expect(built.props.sizeUnits).toBe('meters');
    expect(built.props.pointSize).toBe(42);
    expect(built.props.material).toBe(false);
  });

  it('accepts the getColor alias (upstream vocabulary) as a constant', () => {
    const built = buildSublayerForTile(bigPointTile(3), {
      getColor: [1, 2, 3, 255],
    });
    expect(built.props.getColor).toEqual([1, 2, 3, 255]);
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

  // ── colorMappingDefault is baked, so it must key the tile (review fix 8) ────

  /** A tile whose `vtype` column has one mapped and one NULL feature. */
  function mappedTile() {
    const tile = bigPointTile(2);
    tile.layers[0].features.categoricalProps['vtype'] = {
      indices: new Uint16Array([0, 0xffff]),
      categories: ['a'],
    };
    return tile;
  }

  it('re-prepares the tile when colorMappingDefault changes (palette branch)', () => {
    // The fallback is baked into the prepared getColor buffer TWICE (unmapped
    // category + the 0xffff NULL slot), so flipping it to make unmapped points
    // visible used to do nothing until the tile was evicted.
    const layer = makeLayer({
      color: 'vtype',
      colorVectorColumn: null,
      colorPalette: [[1, 2, 3, 255]],
      colorMappingDefault: [0, 0, 0, 0],
    });
    const tile = mappedTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(
      Array.from(first.data.attributes.getColor.value.slice(4, 8)),
    ).toEqual([0, 0, 0, 0]);

    layer.props.colorMappingDefault = [200, 0, 200, 255];
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).not.toBe(first);
    expect(
      Array.from(second.data.attributes.getColor.value.slice(4, 8)),
    ).toEqual([200, 0, 200, 255]);
  });

  it('re-prepares the tile when colorMappingDefault changes (colorMapping branch)', () => {
    const layer = makeLayer({
      color: 'vtype',
      colorVectorColumn: null,
      colorMapping: { a: [1, 2, 3, 255] },
      colorMappingDefault: [0, 0, 0, 0],
    });
    const tile = mappedTile();
    const first = (layer as any).prepareTile(tile, tile.layers[0]);
    layer.props.colorMappingDefault = [7, 7, 7, 255];
    const second = (layer as any).prepareTile(tile, tile.layers[0]);
    expect(second).not.toBe(first);
    expect(
      Array.from(second.data.attributes.getColor.value.slice(4, 8)),
    ).toEqual([7, 7, 7, 255]);
  });

  // ── No CategoryColorExtension at all (review fix 9) ────────────────────────

  it('installs ONLY the time-filter extension (no idle category attribute/UBO)', () => {
    // The GPU category path was unreachable dead code (gpuPalette was never
    // assigned), yet the extension was installed on every sublayer —
    // registering instanceCategoryIndex, a UBO, an fs:DECKGL_FILTER_COLOR
    // branch and a palette-texture acquire/release for nothing.
    const layer = makeLayer();
    const sentinel = { __ext: 'time' };
    layer.timeFilterExtension = sentinel;
    const tile = bigPointTile(3);
    const built = (layer as any).buildSublayer(
      (layer as any).prepareTile(tile, tile.layers[0]),
    );
    expect(built.props.extensions).toEqual([sentinel]);
  });

  // ── vectorProps bind by LEAF TYPE, not size (review fix 10) ────────────────

  it('converts an f32 colour vector column instead of binding float32x4', () => {
    // deck derives the buffer format from the typed array and `normalized` only
    // upgrades uint8→unorm8, so binding an f32 leaf by size alone produced a
    // float32x4 buffer of 0–255 values → every point blown out white.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = bigPointTile(2);
    tile.layers[0].features.vectorProps = {
      point_rgba: {
        value: new Float32Array([255, 128, 0, 255, 0, 64, 255, 255]),
        size: 4,
      },
    };
    const built = buildSublayerForTile(tile);
    const color = built.props.data.attributes.getColor;
    expect(color.value).toBeInstanceOf(Uint8Array);
    expect(color.normalized).toBe(true);
    expect(Array.from(color.value.slice(0, 4))).toEqual([255, 128, 0, 255]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/float32 leaf/);
    warn.mockRestore();
  });

  it('ignores a u8 normal column rather than binding uint8x3 to a float vec3', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = bigPointTile(2);
    tile.layers[0].features.vectorProps = {
      normal: { value: new Uint8Array([0, 0, 1, 1, 0, 0]), size: 3 },
    };
    const built = buildSublayerForTile(tile);
    expect(built.props.data.attributes.getNormal).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/u8 leaf/);
    warn.mockRestore();
  });

  // ── Geometry-kind guard (review fix 11) ────────────────────────────────────

  it('skips (and warns once about) a non-Point tile instead of misreading it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = bigPointTile(4);
    tile.layers[0].features.geometryType = 2 as any; // Polygon
    const layer = makeLayer();
    expect((layer as any).prepareTile(tile, tile.layers[0])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Polygon.*reads Point/);
    warn.mockRestore();
  });

  // ── Empty tile set releases derived buffers (review fix 12) ────────────────

  it('clears the prepared/sublayer caches when the tile set empties', () => {
    const layer = makeLayer();
    layer.state = { tiles: [bigPointTile(3)] };
    expect((layer as any).renderLayers().length).toBe(1);
    expect(layer.preparedTileCache.size).toBe(1);
    expect(layer.sublayerCache.size).toBe(1);

    layer.state = { tiles: [] };
    expect((layer as any).renderLayers()).toEqual([]);
    expect(layer.preparedTileCache.size).toBe(0);
    expect(layer.sublayerCache.size).toBe(0);
  });
});
