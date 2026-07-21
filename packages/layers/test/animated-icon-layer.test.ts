/**
 * AnimatedIconLayer per-tile sublayer tests.
 *
 * AnimatedIconLayer renders deck.gl's IconLayer (instanced at points, exactly
 * like ScatterplotLayer) one binary sublayer per tile, animated by the shared
 * TimeFilterExtension in WINDOW mode. These tests pin the binary-data contract
 * the same way layer-data-shape.test.ts does for the point/path/trips layers:
 *  - the {length, attributes} shape (no per-feature wrapper objects);
 *  - per-feature heading baked from a numeric column into the getAngle attr;
 *  - a single constant icon flowing to a constant getIcon accessor;
 *  - categorical color lifting category indices to instanceCategoryIndex (GPU);
 *  - the TimeFilterExtension attribute names present and zero-copy.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';

// ---------------------------------------------------------------------------
// deck.gl mocks (mirror layer-data-shape.test.ts — stash props on the instance)
// ---------------------------------------------------------------------------

vi.mock('@deck.gl/layers', () => {
  class FakeIconLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { IconLayer: FakeIconLayer };
});

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

const ATLAS = 'https://example.test/atlas.png';
const MAPPING = {
  vessel: {
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    anchorX: 32,
    anchorY: 32,
    mask: true,
  },
};

describe('AnimatedIconLayer per-tile sublayer architecture', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    // Fresh import each test so vi.mock's are applied.
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-icon-layer');
    LayerCtor = mod.AnimatedIconLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — we exercise the
      // per-tile prepare + sublayer-build path directly.
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        icon: 'vessel',
        iconAtlas: ATLAS,
        iconMapping: MAPPING,
        angle: 0,
        color: [255, 255, 255, 255],
        size: 12,
        pixelOffset: [0, 0],
        sizeUnits: 'pixels',
        sizeBasis: 'height',
        alphaCutoff: 0.05,
        textureParameters: null,
        fadeInDuration: 300,
        fadeOutDuration: 300,
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

  it('uses the binary {length, attributes} shape — no per-feature objects', () => {
    const N = 5000;
    const built = buildSublayerForTile(bigPointTile(N));
    const data = built.props.data;
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(N);
    expect(data.attributes).toBeDefined();
  });

  it('feeds zero-copy time attributes under the extension-registered names', () => {
    const N = 100;
    const tile = bigPointTile(N);
    const built = buildSublayerForTile(tile);
    const attrs = built.props.data.attributes;

    expect(attrs.getPosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getPosition.size).toBe(3);
    expect(attrs.getPosition.value.length).toBe(N * 3);

    // Zero-copy: same Float32Array references the tile carries, under the
    // exact keys TimeFilterExtension.initializeState registers.
    expect(attrs.instanceStartTime.value).toBe(
      tile.layers[0].features.startTimes,
    );
    expect(attrs.instanceStartTime.size).toBe(1);
    expect(attrs.instanceEndTime.value).toBe(tile.layers[0].features.endTimes);
    expect(attrs.instanceEndTime.size).toBe(1);

    // With constant angle/color/size (no property name), no per-feature buffer
    // is emitted — deck.gl falls back to the constant accessors.
    expect(attrs.getAngle).toBeUndefined();
    expect(attrs.getSize).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeUndefined();
  });

  it('bakes a numeric heading column into the getAngle instanced attribute (zero-copy)', () => {
    const N = 8;
    const tile = bigPointTile(N);
    const heading = new Float32Array([0, 45, 90, 135, 180, 225, 270, 315]);
    tile.layers[0].features.numericProps['heading'] = heading;

    // `angle: 'heading'` names the column — it gets baked into getAngle.
    const built = buildSublayerForTile(tile, { angle: 'heading' });
    const attrs = built.props.data.attributes;

    expect(attrs.getAngle).toBeDefined();
    expect(attrs.getAngle.value).toBe(heading); // zero-copy ride-along
    expect(attrs.getAngle.size).toBe(1);
    expect(attrs.getAngle.value[2]).toBe(90);
    // The constant getAngle fallback (0) is still set on the layer props.
    expect(built.props.getAngle).toBe(0);
  });

  it('bakes the heading column via the upstream getAngle alias (column name, not function)', () => {
    const N = 4;
    const tile = bigPointTile(N);
    const cog = new Float32Array([10, 20, 30, 40]);
    tile.layers[0].features.numericProps['cog'] = cog;

    // getAngle alias holds a COLUMN NAME (not a function) — it wins over angle.
    const built = buildSublayerForTile(tile, { getAngle: 'cog', angle: 5 });
    const attrs = built.props.data.attributes;
    expect(attrs.getAngle.value).toBe(cog);
    expect(attrs.getAngle.value[3]).toBe(40);
  });

  it('bakes a numeric size column into the getSize instanced attribute', () => {
    const N = 3;
    const tile = bigPointTile(N);
    const mag = new Float32Array([8, 16, 24]);
    tile.layers[0].features.numericProps['mag'] = mag;

    const built = buildSublayerForTile(tile, { size: 'mag' });
    const attrs = built.props.data.attributes;
    expect(attrs.getSize.value).toBe(mag);
    expect(attrs.getSize.size).toBe(1);
    // Constant size fallback unchanged for layers that need it.
    expect(built.props.getSize).toBe(12);
  });

  it('flows the single constant icon name to a constant getIcon accessor', () => {
    const built = buildSublayerForTile(bigPointTile(3), { icon: 'vessel' });
    expect(typeof built.props.getIcon).toBe('function');
    // Same icon for EVERY feature — binary tiles can't run a per-row accessor.
    expect(built.props.getIcon({}, { index: 0 })).toBe('vessel');
    expect(built.props.getIcon({}, { index: 42 })).toBe('vessel');
    // Atlas + mapping forwarded verbatim.
    expect(built.props.iconAtlas).toBe(ATLAS);
    expect(built.props.iconMapping).toBe(MAPPING);
  });

  it('hands category color indices to the GPU (no per-feature RGBA buffer)', () => {
    const N = 1000;
    const tile = bigPointTile(N);
    tile.layers[0].features.categoricalProps['vtype'] = {
      indices: new Uint16Array(N).fill(2),
      categories: ['a', 'b', 'c', 'd'],
    };

    const built = buildSublayerForTile(tile, {
      color: 'vtype',
      colorPalette: [
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
      ],
    });
    const attrs = built.props.data.attributes;

    // GPU path: no per-feature RGBA buffer — category id rides
    // instanceCategoryIndex; the extension samples the palette texture in the
    // fragment shader.
    expect(attrs.getColor).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(attrs.instanceCategoryIndex.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceCategoryIndex.value[0]).toBe(2);
    expect(attrs.instanceCategoryIndex.size).toBe(1);

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

  it('leaves useCategoryColor false and emits no category index for constant color', () => {
    const built = buildSublayerForTile(bigPointTile(10));
    const attrs = built.props.data.attributes;
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(built.props.useCategoryColor).toBe(false);
    expect(built.props.getColor).toEqual([255, 255, 255, 255]);
  });

  it('passes the bound getTime getter so the window uniform advances each draw', () => {
    const built = buildSublayerForTile(bigPointTile(3));
    expect(typeof built.props.getTime).toBe('function');
    // Window-mode fade ramps are forwarded to the TimeFilterExtension.
    expect(built.props.fadeInDuration).toBe(300);
    expect(built.props.fadeOutDuration).toBe(300);
  });

  it('forwards a constant [x,y] pixelOffset to the getPixelOffset accessor (no attribute)', () => {
    const built = buildSublayerForTile(bigPointTile(3), {
      pixelOffset: [4, -8],
    });
    const attrs = built.props.data.attributes;
    // Constant offset → no per-feature buffer; rides the scalar accessor.
    expect(attrs.getPixelOffset).toBeUndefined();
    expect(built.props.getPixelOffset).toEqual([4, -8]);
  });

  it('defaults getPixelOffset to [0,0] (deck default) when unset', () => {
    const built = buildSublayerForTile(bigPointTile(3));
    expect(built.props.getPixelOffset).toEqual([0, 0]);
  });

  it('bakes a size-2 vector column into the getPixelOffset instanced attribute (zero-copy)', () => {
    const N = 3;
    const tile = bigPointTile(N);
    // Interleaved [x0,y0, x1,y1, x2,y2] size-2 column.
    const off = new Float32Array([1, 2, 3, 4, 5, 6]);
    tile.layers[0].features.vectorProps = {
      screenOff: { value: off, size: 2 },
    };

    const built = buildSublayerForTile(tile, { pixelOffset: 'screenOff' });
    const attrs = built.props.data.attributes;
    expect(attrs.getPixelOffset.value).toBe(off); // zero-copy ride-along
    expect(attrs.getPixelOffset.size).toBe(2);
    expect(attrs.getPixelOffset.value[4]).toBe(5);
    // Constant fallback still present for features without the buffer.
    expect(built.props.getPixelOffset).toEqual([0, 0]);
  });

  it('resolves the getPixelOffset alias (column name) over pixelOffset', () => {
    const N = 2;
    const tile = bigPointTile(N);
    const off = new Float32Array([7, 8, 9, 10]);
    tile.layers[0].features.vectorProps = { po: { value: off, size: 2 } };

    // getPixelOffset alias holds a COLUMN NAME (not a function) — it wins.
    const built = buildSublayerForTile(tile, {
      getPixelOffset: 'po',
      pixelOffset: [1, 1],
    });
    const attrs = built.props.data.attributes;
    expect(attrs.getPixelOffset.value).toBe(off);
    expect(attrs.getPixelOffset.value[3]).toBe(10);
  });

  it('ignores a non-size-2 vector column for pixelOffset (falls back to constant)', () => {
    const N = 2;
    const tile = bigPointTile(N);
    // size-4 column is not a valid pixel offset — must not bind.
    tile.layers[0].features.vectorProps = {
      rgba: { value: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), size: 4 },
    };
    const built = buildSublayerForTile(tile, { pixelOffset: 'rgba' });
    expect(built.props.data.attributes.getPixelOffset).toBeUndefined();
    expect(built.props.getPixelOffset).toEqual([0, 0]);
  });

  it('forwards alphaCutoff (default 0.05) and an override', () => {
    const dflt = buildSublayerForTile(bigPointTile(3));
    expect(dflt.props.alphaCutoff).toBe(0.05);
    const over = buildSublayerForTile(bigPointTile(3), { alphaCutoff: 0.5 });
    expect(over.props.alphaCutoff).toBe(0.5);
  });

  it('forwards sizeBasis (default height) and a width override', () => {
    const dflt = buildSublayerForTile(bigPointTile(3));
    expect(dflt.props.sizeBasis).toBe('height');
    const over = buildSublayerForTile(bigPointTile(3), { sizeBasis: 'width' });
    expect(over.props.sizeBasis).toBe('width');
  });

  it('forwards textureParameters verbatim to the sublayer', () => {
    const dflt = buildSublayerForTile(bigPointTile(3));
    expect(dflt.props.textureParameters).toBeNull();
    const params = { minFilter: 'nearest', magFilter: 'nearest' };
    const over = buildSublayerForTile(bigPointTile(3), {
      textureParameters: params,
    });
    expect(over.props.textureParameters).toBe(params);
  });

  it('rebuilds the cached IconLayer when alphaCutoff / sizeBasis change', () => {
    const layer = makeLayer();
    const tile = bigPointTile(3);
    layer.state = { tiles: [tile] };
    const first = (layer as any).renderLayers();
    layer.props.alphaCutoff = 0.3;
    const second = (layer as any).renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props.alphaCutoff).toBe(0.3);
    layer.props.sizeBasis = 'width';
    const third = (layer as any).renderLayers();
    expect(third[0]).not.toBe(second[0]);
    expect(third[0].props.sizeBasis).toBe('width');
  });
});
