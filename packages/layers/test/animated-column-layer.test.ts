/**
 * AnimatedColumnLayer tests.
 *
 * ColumnLayer is instanced at points exactly like ScatterplotLayer, so the
 * column layer mirrors AnimatedPointLayer's WINDOW-mode binary-sublayer path:
 * one ColumnLayer per (tile, layer), zero-copy positions/times, a per-feature
 * numeric column baked into the size-1 `getElevation` attribute, categorical
 * fill driven by the GPU `instanceCategoryIndex` path.
 *
 * These tests exercise the layer's `prepareTile` + `buildSublayer` paths
 * directly (via Object.create, which bypasses CompositeLayer's lifecycle) with
 * a deck.gl mock that captures the constructor args. They pin: the elevation
 * column is baked per-feature, categorical fill builds instanceCategoryIndex,
 * the time attributes reach the GPU under the registered names, and
 * elevationScale flows through to the sublayer.
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

  it('hands category indices to the GPU (no per-feature RGBA buffer) for categorical fill', () => {
    const N = 1000;
    const tile = bigPointTile(N);
    const binary = tile.layers[0].features;
    binary.categoricalProps['vtype'] = {
      indices: new Uint16Array(N).fill(2),
      categories: ['a', 'b', 'c', 'd'],
    };

    const built = buildSublayerForTile(tile, {
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
});
