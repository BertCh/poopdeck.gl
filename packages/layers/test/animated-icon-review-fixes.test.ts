/**
 * AnimatedIconLayer — review-fix regressions.
 *
 * Each block pins ONE finding from the layers review:
 *  1. iconAtlas / iconMapping swaps must invalidate the sublayer-instance cache
 *     (it hands the SAME IconLayer back every render, so deck never diffs its
 *     props — a stale atlas/mapping otherwise persists forever);
 *  2. `getPixelOffset` binds through `bindFloatVector`, so a u8 leaf is refused
 *     instead of producing a `uint8x2` buffer against a float attribute;
 *  3. per-CATEGORY icons bake deck's size-7 `instanceIconDefs` buffer directly,
 *     bypassing the per-ROW `getIcon` accessor + `getInstanceIconDef` transform;
 *  9. the glide pick-row caches are bounded to the RESIDENT set, not
 *     accumulate-only;
 * 11. `onIconError` + an icon-side `loadOptions` reach the sublayer;
 * 13. a non-point tile layer is skipped rather than misread.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile, makePathTile } from './fake-tile';

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
// Fixtures
// ---------------------------------------------------------------------------

const ATLAS = 'https://example.test/atlas.png';

/** Two distinct sprites so a per-category buffer is observable. */
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
  plane: { x: 64, y: 0, width: 32, height: 16, anchorX: 8, anchorY: 4 },
};

function pointTile(n: number, tileId?: any) {
  const positions: number[][] = new Array(n);
  const startTimes: number[] = new Array(n);
  const endTimes: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    positions[i] = [i * 0.1, i * 0.1];
    startTimes[i] = i;
    endTimes[i] = i + 1;
  }
  return makePointTile({
    positions,
    startTimes,
    endTimes,
    timeOffset: 0,
    tileId,
  });
}

/** Attach a categorical column to a fake tile's first layer. */
function withCategory(tile: any, name: string, values: string[]) {
  const categories: string[] = [];
  const map = new Map<string, number>();
  const indices = new Uint16Array(values.length);
  values.forEach((v, i) => {
    let idx = map.get(v);
    if (idx === undefined) {
      idx = categories.length;
      categories.push(v);
      map.set(v, idx);
    }
    indices[i] = idx;
  });
  tile.layers[0].features.categoricalProps[name] = { indices, categories };
  return tile;
}

describe('AnimatedIconLayer review fixes', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-icon-layer');
    LayerCtor = mod.AnimatedIconLayer as any;

    makeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        icon: 'vessel',
        iconAtlas: ATLAS,
        iconMapping: MAPPING,
        iconProperty: null,
        iconCategoryMapping: null,
        onIconError: null,
        iconLoadOptions: null,
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
      layer.lastTilesRef = null;
      return layer;
    };

    buildSublayerForTile = (tile, opts = {}) => {
      const layer = makeLayer(opts);
      return layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    };
  });

  // ── 1. atlas / mapping invalidation ──────────────────────────────────────

  describe('HIGH — iconAtlas / iconMapping swaps invalidate the sublayer cache', () => {
    it('rebuilds every sublayer when a NEW iconMapping object with the same atlas URL arrives', () => {
      const layer = makeLayer();
      layer.state = { tiles: [pointTile(3)] };
      const first = layer.renderLayers();
      // Same atlas URL, same keys — but a different mapping OBJECT with a
      // different sprite rect. The old digest (which ignored iconMapping
      // entirely) produced a byte-identical key and rendered the stale mapping.
      layer.props.iconMapping = {
        ...MAPPING,
        vessel: { ...MAPPING.vessel, x: 128, y: 128 },
      };
      const second = layer.renderLayers();
      expect(second[0]).not.toBe(first[0]);
      expect(second[0].props.iconMapping.vessel.x).toBe(128);
    });

    it('does NOT rebuild for an equal-content mapping literal (content digest, not identity)', () => {
      const layer = makeLayer();
      layer.state = { tiles: [pointTile(3)] };
      const first = layer.renderLayers();
      layer.props.iconMapping = JSON.parse(JSON.stringify(MAPPING));
      const second = layer.renderLayers();
      expect(second[0]).toBe(first[0]);
    });

    it('rebuilds when a non-string atlas (Texture) is swapped for another', () => {
      // Two distinct "Texture"-like objects: the old key collapsed BOTH to ''.
      const texA = { width: 64, height: 64 } as any;
      const texB = { width: 128, height: 128 } as any;
      const layer = makeLayer({ iconAtlas: texA });
      layer.state = { tiles: [pointTile(3)] };
      const first = layer.renderLayers();
      expect(first[0].props.iconAtlas).toBe(texA);
      layer.props.iconAtlas = texB;
      const second = layer.renderLayers();
      expect(second[0]).not.toBe(first[0]);
      expect(second[0].props.iconAtlas).toBe(texB);
    });

    it('rebuilds when a URL atlas is swapped', () => {
      const layer = makeLayer();
      layer.state = { tiles: [pointTile(3)] };
      const first = layer.renderLayers();
      layer.props.iconAtlas = 'https://example.test/atlas@2x.png';
      const second = layer.renderLayers();
      expect(second[0]).not.toBe(first[0]);
    });
  });

  // ── 2. getPixelOffset leaf type ──────────────────────────────────────────

  describe('MED — getPixelOffset binds only a FLOAT vector column', () => {
    it('binds an f32 size-2 column zero-copy with no `normalized` flag', () => {
      const tile = pointTile(3);
      const off = new Float32Array([1, 2, 3, 4, 5, 6]);
      tile.layers[0].features.vectorProps = { po: { value: off, size: 2 } };
      const built = buildSublayerForTile(tile, { pixelOffset: 'po' });
      const attr = built.props.data.attributes.getPixelOffset;
      expect(attr.value).toBe(off);
      expect(attr.size).toBe(2);
      // instancePixelOffset is float-valued — `normalized` would upgrade the
      // buffer to unorm and rescale the values.
      expect(attr.normalized).toBeUndefined();
    });

    it('REFUSES a u8 size-2 leaf (uint8x2 against a float attribute) and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tile = pointTile(3);
      tile.layers[0].features.vectorProps = {
        po: { value: new Uint8Array([1, 2, 3, 4, 5, 6]), size: 2 },
      };
      const built = buildSublayerForTile(tile, { pixelOffset: 'po' });
      expect(built.props.data.attributes.getPixelOffset).toBeUndefined();
      expect(built.props.getPixelOffset).toEqual([0, 0]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // ── 3. per-category icons ────────────────────────────────────────────────

  describe('MED — per-CATEGORY icons bake instanceIconDefs directly', () => {
    it('bakes a size-7 instanceIconDefs buffer matching getInstanceIconDef', () => {
      const tile = withCategory(pointTile(4), 'kind', [
        'vessel',
        'plane',
        'vessel',
        'plane',
      ]);
      const built = buildSublayerForTile(tile, { iconProperty: 'kind' });
      const attr = built.props.data.attributes.instanceIconDefs;
      expect(attr.size).toBe(7);
      expect(attr.value).toBeInstanceOf(Float32Array);
      expect(attr.value.length).toBe(4 * 7);
      // deck: [width/2 - anchorX, height/2 - anchorY, x, y, w, h, mask?1:0]
      expect(Array.from(attr.value.subarray(0, 7))).toEqual([
        0, 0, 0, 0, 64, 64, 1,
      ]);
      // plane: 32/2-8 = 8, 16/2-4 = 4, mask absent → 0
      expect(Array.from(attr.value.subarray(7, 14))).toEqual([
        8, 4, 64, 0, 32, 16, 0,
      ]);
      // Row 2 repeats vessel, row 3 repeats plane — one table lookup per
      // CATEGORY, a scalar fill per feature.
      expect(Array.from(attr.value.subarray(14, 21))).toEqual([
        0, 0, 0, 0, 64, 64, 1,
      ]);
      expect(Array.from(attr.value.subarray(21, 28))).toEqual([
        8, 4, 64, 0, 32, 16, 0,
      ]);
    });

    it('routes the category value through iconCategoryMapping when supplied', () => {
      const tile = withCategory(pointTile(2), 'kind', ['boat', 'jet']);
      const built = buildSublayerForTile(tile, {
        iconProperty: 'kind',
        iconCategoryMapping: { boat: 'vessel', jet: 'plane' },
      });
      const v = built.props.data.attributes.instanceIconDefs.value;
      expect(Array.from(v.subarray(0, 7))).toEqual([0, 0, 0, 0, 64, 64, 1]);
      expect(Array.from(v.subarray(7, 14))).toEqual([8, 4, 64, 0, 32, 16, 0]);
    });

    it('falls back to the constant `icon` for the NULL sentinel and unmapped categories', () => {
      const tile = pointTile(2);
      tile.layers[0].features.categoricalProps['kind'] = {
        indices: new Uint16Array([0, 0xffff]),
        categories: ['plane'],
      };
      const built = buildSublayerForTile(tile, { iconProperty: 'kind' });
      const v = built.props.data.attributes.instanceIconDefs.value;
      expect(Array.from(v.subarray(0, 7))).toEqual([8, 4, 64, 0, 32, 16, 0]);
      // NULL → the fallback `icon` ('vessel').
      expect(Array.from(v.subarray(7, 14))).toEqual([0, 0, 0, 0, 64, 64, 1]);
    });

    it('bakes NO attribute when iconProperty is unset (byte-identical constant path)', () => {
      const built = buildSublayerForTile(
        withCategory(pointTile(2), 'kind', ['a', 'b']),
      );
      expect(built.props.data.attributes.instanceIconDefs).toBeUndefined();
      expect(typeof built.props.getIcon).toBe('function');
      expect(built.props.getIcon()).toBe('vessel');
    });

    it('re-prepares tiles when the iconMapping CONTENT feeding the defs changes', () => {
      const layer = makeLayer({ iconProperty: 'kind' });
      const tile = withCategory(pointTile(2), 'kind', ['vessel', 'plane']);
      layer.state = { tiles: [tile] };
      const first = layer.renderLayers()[0];
      layer.props.iconMapping = {
        ...MAPPING,
        vessel: { ...MAPPING.vessel, x: 200 },
      };
      const second = layer.renderLayers()[0];
      expect(second.props.data).not.toBe(first.props.data);
      expect(second.props.data.attributes.instanceIconDefs.value[2]).toBe(200);
    });

    it('falls back (with a warning) when iconMapping is a URL string', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tile = withCategory(pointTile(2), 'kind', ['vessel', 'plane']);
      const built = buildSublayerForTile(tile, {
        iconProperty: 'kind',
        iconMapping: 'https://example.test/mapping.json',
      });
      expect(built.props.data.attributes.instanceIconDefs).toBeUndefined();
      expect(built.props.iconMapping).toBe('https://example.test/mapping.json');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // ── 11. onIconError + iconLoadOptions ────────────────────────────────────

  describe('MED — IconLayer prop gaps', () => {
    it('forwards onIconError to the sublayer', () => {
      const onIconError = vi.fn();
      const built = buildSublayerForTile(pointTile(2), { onIconError });
      expect(built.props.onIconError).toBe(onIconError);
    });

    it('forwards iconLoadOptions as the sublayer `loadOptions` (IconManager)', () => {
      const iconLoadOptions = { fetch: { credentials: 'include' } };
      const built = buildSublayerForTile(pointTile(2), { iconLoadOptions });
      expect(built.props.loadOptions).toBe(iconLoadOptions);
    });

    it('omits `loadOptions` entirely when iconLoadOptions is unset (never leaks the archive options)', () => {
      const built = buildSublayerForTile(pointTile(2), {
        loadOptions: { fetch: { headers: { authorization: 'secret' } } },
      });
      expect(built.props.loadOptions).toBeUndefined();
    });

    it('rebuilds sublayers when onIconError / iconLoadOptions change', () => {
      const layer = makeLayer();
      layer.state = { tiles: [pointTile(2)] };
      const first = layer.renderLayers();
      layer.props.onIconError = () => {};
      const second = layer.renderLayers();
      expect(second[0]).not.toBe(first[0]);
      layer.props.iconLoadOptions = { fetch: {} };
      const third = layer.renderLayers();
      expect(third[0]).not.toBe(second[0]);
    });
  });

  // ── 13. geometry guard ───────────────────────────────────────────────────

  describe('geometry guard', () => {
    it('skips a LineString tile layer instead of misreading the vertex run', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tile = makePathTile({
        paths: [
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          [
            [3, 3],
            [4, 4],
          ],
        ],
        startTimes: [0, 0],
        endTimes: [1000, 1000],
        timeOffset: 0,
      });
      const layer = makeLayer();
      layer.state = { tiles: [tile] };
      expect(layer.renderLayers()).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('still renders a Point tile layer', () => {
      const layer = makeLayer();
      layer.state = { tiles: [pointTile(3)] };
      expect(layer.renderLayers().length).toBe(1);
    });
  });

  // ── 9. bounded glide pick-row caches ─────────────────────────────────────

  describe('MED — glide pick-row caches are bounded to the resident set', () => {
    /** Drive scanInterpPickRows against a synthetic track index. */
    function scan(layer: any, tiles: any[], residentIds: string[]) {
      layer.interpTrackIndex = new Map(residentIds.map((id) => [id, {}]));
      layer.scanInterpPickRows(tiles, 'mmsi');
    }

    it('drops rows for entities that left the resident track index', () => {
      const layer = makeLayer({ interpolate: true, idProperty: 'mmsi' });
      layer.interpPickRows = new Map();
      layer.interpPickRowsScanned = new Set();

      const a = withCategory(pointTile(2, { z: 1, x: 0, y: 0, t: 0 }), 'mmsi', [
        'A',
        'B',
      ]);
      scan(layer, [a], ['A', 'B']);
      expect([...layer.interpPickRows.keys()].sort()).toEqual(['A', 'B']);

      // Tile A evicted; a new tile brings C. Only C is resident now.
      const c = withCategory(pointTile(1, { z: 1, x: 1, y: 0, t: 0 }), 'mmsi', [
        'C',
      ]);
      scan(layer, [c], ['C']);
      expect([...layer.interpPickRows.keys()]).toEqual(['C']);
      // …and the scanned-tile set is pruned to the live tiles too.
      expect(layer.interpPickRowsScanned.size).toBe(1);
    });

    it('does not re-decode an id that is still resident', () => {
      const layer = makeLayer({ interpolate: true, idProperty: 'mmsi' });
      layer.interpPickRows = new Map();
      layer.interpPickRowsScanned = new Set();
      const a = withCategory(pointTile(2, { z: 1, x: 0, y: 0, t: 0 }), 'mmsi', [
        'A',
        'B',
      ]);
      scan(layer, [a], ['A', 'B']);
      const rowA = layer.interpPickRows.get('A');
      scan(layer, [a], ['A', 'B']);
      expect(layer.interpPickRows.get('A')).toBe(rowA);
    });
  });
});
