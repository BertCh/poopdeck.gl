/**
 * AnimatedPointLayer cumulative-slab hardening.
 *
 * Cumulative mode packs many tiles into a few consolidated ScatterplotLayer
 * "slabs" instead of one sublayer per resident tile. That consolidation makes
 * three things easy to get silently wrong, and each of them renders a plausible
 * map rather than an error:
 *
 *  1. TIME REBASE — slab times are Float32. Rebasing against 0 stores
 *     epoch-absolute milliseconds (~1.7e12), where one ULP is ~131 s, so every
 *     start time snaps onto a ~2-minute grid and `fadeInDuration` becomes a
 *     no-op. Cumulative is the one mode `TimeFilterExtension` skips its
 *     rel-time range assertion for, so nothing warns.
 *  2. OPTIONAL COLUMNS — slab arrays are zero-filled and the schema is seeded
 *     from the FIRST absorbed tile, while deck skips an accessor's constant
 *     fallback whenever a binary buffer exists for it
 *     (`attribute-manager.ts`). A later tile without the column therefore used
 *     to render RGBA [0,0,0,0] / radius 0 — invisible.
 *  3. SCHEMA KEY — it decides when every slab is thrown away and re-absorbed.
 *
 * Plus: the slab path must install the same SplatExtension the per-tile path
 * does, or `splat: true` silently degrades to hard discs in cumulative mode.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer {
    static layerName = 'ScatterplotLayer';
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { ScatterplotLayer: FakeScatterplotLayer };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/** Unique per-instance sentinels so extension identity is assertable. */
const TIME_FILTER = { name: 'TimeFilterExtension' };
const CATEGORY_COLOR = { name: 'CategoryColorExtension' };
const SPLAT = { name: 'SplatExtension' };

interface PointRow {
  lon: number;
  lat: number;
  /** Time RELATIVE to the tile's timeOffset. */
  t: number;
}

function pointTile(
  rows: PointRow[],
  opts: {
    timeOffset?: number;
    tileId?: { z: number; x: number; y: number; t: number };
    numericProps?: Record<string, number[]>;
  } = {},
): Tile {
  const tile = makePointTile({
    positions: rows.map((r) => [r.lon, r.lat]),
    startTimes: rows.map((r) => r.t),
    endTimes: rows.map((r) => r.t + 1),
    timeOffset: opts.timeOffset ?? 0,
    tileId: opts.tileId ?? { z: 11, x: 0, y: 0, t: 0 },
  });
  const f = tile.layers[0].features;
  for (const [name, values] of Object.entries(opts.numericProps ?? {})) {
    f.numericProps[name] = new Float32Array(values);
  }
  return tile;
}

/** `n` points at distinct lon/lat, all in one tile. */
function rows(n: number, base = 0): PointRow[] {
  return Array.from({ length: n }, (_, i) => ({
    lon: base + i * 0.001,
    lat: 40 + i * 0.001,
    t: i * 100,
  }));
}

describe('AnimatedPointLayer cumulative slabs', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: Record<string, any>) => any;

  beforeEach(async () => {
    vi.resetModules();
    LayerCtor = (await import('../src/layers/core/animated-point-layer'))
      .AnimatedPointLayer as any;

    makeLayer = (opts: Record<string, any> = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'cum',
        cumulative: true,
        fillColor: [255, 128, 0, 255],
        radius: 5,
        radiusUnits: 'pixels',
        radiusScale: 1,
        radiusMinPixels: 0,
        radiusMaxPixels: Number.MAX_SAFE_INTEGER,
        stroked: false,
        filled: true,
        billboard: false,
        antialiasing: true,
        strokeColor: [0, 0, 0, 255],
        strokeWidth: 1,
        lineWidthUnits: 'meters',
        lineWidthScale: 1,
        lineWidthMinPixels: 0,
        lineWidthMaxPixels: Number.MAX_SAFE_INTEGER,
        colorPalette: [
          [10, 20, 30, 255],
          [40, 50, 60, 255],
        ],
        colorMapping: null,
        colorMappingDefault: [0, 0, 0, 0],
        rgbColorColumns: null,
        colorVectorColumn: null,
        rampProperty: null,
        rampDomain: [0, 1],
        rampColorRamp: [],
        radiusTransform: null,
        splat: false,
        fadeInDuration: 300,
        fadeOutDuration: 300,
        wakeLength: 0,
        wakeTailScale: 0.15,
        use3D: false,
        elevationProperty: null,
        elevationScale: 1,
        filterProperty: null,
        filterRange: null,
        filterSoftRange: null,
        filterEnabled: true,
        interpolate: false,
        idProperty: null,
        timeWindow: 1000,
        timeHeightScale: 0,
        timeHeightOrigin: 0,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = TIME_FILTER;
      layer.categoryColorExtension = CATEGORY_COLOR;
      layer.splatExtension = SPLAT;
      return layer;
    };
  });

  // ── 1. Float32-safe time rebase ─────────────────────────────────────────

  it('rebases onto the FIRST absorbed tile when no timeRange is set (not epoch 0)', () => {
    // Real archives carry epoch-ms timeOffsets. Rebasing against 0 would store
    // 1.7e12 + t into a Float32Array; the assertion below pins that the layer
    // does NOT do that.
    const EPOCH = 1_700_000_000_000;
    const layer = makeLayer({ timeRange: null });
    layer.state = {
      tiles: [pointTile([{ lon: 0, lat: 0, t: 0 }], { timeOffset: EPOCH })],
    };
    const [slab] = layer.renderLayers();

    expect(slab.props.timeOffset).toBe(EPOCH);
    expect([...slab.props.data.attributes.instanceStartTime.value]).toEqual([
      0,
    ]);
  });

  it('keeps sub-second start times exact where an epoch base would quantize them away', () => {
    const EPOCH = 1_700_000_000_000;
    // Control: Float32 at epoch magnitude cannot represent a 250 ms step at
    // all — it is the failure this rebase exists to prevent.
    expect(Math.fround(EPOCH + 250) - Math.fround(EPOCH)).toBe(0);

    const layer = makeLayer({ timeRange: null });
    layer.state = {
      tiles: [
        pointTile(
          [
            { lon: 0, lat: 0, t: 0 },
            { lon: 1, lat: 0, t: 250 },
            { lon: 2, lat: 0, t: 500 },
          ],
          { timeOffset: EPOCH },
        ),
      ],
    };
    const [slab] = layer.renderLayers();
    // Distinct to the millisecond ⇒ fadeInDuration still ramps per point.
    expect([...slab.props.data.attributes.instanceStartTime.value]).toEqual([
      0, 250, 500,
    ]);
  });

  it('rebases later tiles onto the first tile’s offset (one shared base)', () => {
    const EPOCH = 1_700_000_000_000;
    const HOUR = 3_600_000;
    const layer = makeLayer({ timeRange: null });
    layer.state = {
      tiles: [
        pointTile([{ lon: 0, lat: 0, t: 10 }], {
          timeOffset: EPOCH,
          tileId: { z: 11, x: 0, y: 0, t: 0 },
        }),
        pointTile([{ lon: 1, lat: 0, t: 20 }], {
          timeOffset: EPOCH + HOUR,
          tileId: { z: 11, x: 1, y: 0, t: 0 },
        }),
      ],
    };
    const [slab] = layer.renderLayers();
    expect(slab.props.timeOffset).toBe(EPOCH);
    expect([...slab.props.data.attributes.instanceStartTime.value]).toEqual([
      10,
      HOUR + 20,
    ]);
  });

  it('still prefers an explicit timeRange.start as the shared base', () => {
    const layer = makeLayer({
      timeRange: { start: 1_000_000, end: 2_000_000 },
    });
    layer.state = {
      tiles: [
        pointTile([{ lon: 0, lat: 0, t: 10 }], { timeOffset: 1_500_000 }),
      ],
    };
    const [slab] = layer.renderLayers();
    expect(slab.props.timeOffset).toBe(1_000_000);
    expect(slab.props.data.attributes.instanceStartTime.value[0]).toBeCloseTo(
      500_010,
      0,
    );
  });

  it('re-bases when a timeRange arrives AFTER the first render', () => {
    // Archive metadata is async: the first render can legitimately happen with
    // timeRange still null. `timeRange` therefore has to key the slabs, or the
    // packed times stay rebased against the old base with no path back.
    const layer = makeLayer({ timeRange: null });
    const tile = pointTile([{ lon: 0, lat: 0, t: 10 }], {
      timeOffset: 1_500_000,
    });
    layer.state = { tiles: [tile] };
    const [before] = layer.renderLayers();
    expect(before.props.timeOffset).toBe(1_500_000);

    layer.props.timeRange = { start: 1_000_000, end: 2_000_000 };
    const [after] = layer.renderLayers();
    expect(after.props.timeOffset).toBe(1_000_000);
    expect(after.props.data.attributes.instanceStartTime.value[0]).toBeCloseTo(
      500_010,
      0,
    );
  });

  // ── 2. Optional columns across a heterogeneous slab ──────────────────────

  it('falls back to the CONSTANT radius for a tile that lacks the radius column', () => {
    // Column present on tile A, absent on tile B. B's slab range used to stay
    // zero-filled ⇒ radius 0 ⇒ B invisible for the rest of the session.
    const layer = makeLayer({ radius: 'mag' });
    layer.state = {
      tiles: [
        pointTile(rows(2), {
          numericProps: { mag: [3, 4] },
          tileId: { z: 11, x: 0, y: 0, t: 0 },
        }),
        pointTile(rows(2, 10), { tileId: { z: 11, x: 1, y: 0, t: 0 } }),
      ],
    };
    const [slab] = layer.renderLayers();
    const radii = [...slab.props.data.attributes.getRadius.value];
    expect(radii).toEqual([3, 4, 5, 5]); // 5 = the constant fallback, not 0
    // Same constant deck would have used for the missing-column tile.
    expect(slab.props.getRadius).toBe(5);
  });

  it('falls back to the CONSTANT fill colour for a tile that lacks the colour columns', () => {
    const layer = makeLayer({
      rgbColorColumns: ['r', 'g', 'b'],
      fillColor: [9, 8, 7, 255],
    });
    layer.state = {
      tiles: [
        pointTile(rows(1), {
          numericProps: { r: [200], g: [100], b: [50] },
          tileId: { z: 11, x: 0, y: 0, t: 0 },
        }),
        pointTile(rows(1, 10), { tileId: { z: 11, x: 1, y: 0, t: 0 } }),
      ],
    };
    const [slab] = layer.renderLayers();
    const fill = [...slab.props.data.attributes.getFillColor.value];
    expect(fill.slice(0, 4)).toEqual([200, 100, 50, 255]);
    // NOT [0,0,0,0] — the second tile renders the layer's constant colour.
    expect(fill.slice(4, 8)).toEqual([9, 8, 7, 255]);
  });

  it('promotes the slab when the colour column only appears on a LATER tile', () => {
    // Reverse ordering: the schema seeded from tile A had no colour buffer, so
    // tile B's baked colours used to be dropped for the whole slab.
    const layer = makeLayer({
      rgbColorColumns: ['r', 'g', 'b'],
      fillColor: [9, 8, 7, 255],
    });
    layer.state = {
      tiles: [
        pointTile(rows(1), { tileId: { z: 11, x: 0, y: 0, t: 0 } }),
        pointTile(rows(1, 10), {
          numericProps: { r: [200], g: [100], b: [50] },
          tileId: { z: 11, x: 1, y: 0, t: 0 },
        }),
      ],
    };
    const [slab] = layer.renderLayers();
    const fill = [...slab.props.data.attributes.getFillColor.value];
    expect(fill.slice(0, 4)).toEqual([9, 8, 7, 255]); // backfilled constant
    expect(fill.slice(4, 8)).toEqual([200, 100, 50, 255]); // the late column
  });

  it('promotes the slab when the radius column only appears on a LATER tile', () => {
    const layer = makeLayer({ radius: 'mag' });
    layer.state = {
      tiles: [
        pointTile(rows(2), { tileId: { z: 11, x: 0, y: 0, t: 0 } }),
        pointTile(rows(2, 10), {
          numericProps: { mag: [3, 4] },
          tileId: { z: 11, x: 1, y: 0, t: 0 },
        }),
      ],
    };
    const [slab] = layer.renderLayers();
    expect([...slab.props.data.attributes.getRadius.value]).toEqual([
      5, 5, 3, 4,
    ]);
  });

  it('points a category-less tile at the NULL palette slot, not palette entry 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = makeLayer({ fillColor: 'kind' });
      const a = pointTile(rows(2), { tileId: { z: 11, x: 0, y: 0, t: 0 } });
      a.layers[0].features.categoricalProps['kind'] = {
        indices: new Uint16Array([0, 1]),
        categories: ['bus', 'tram'],
      };
      layer.state = {
        tiles: [
          a,
          pointTile(rows(1, 10), { tileId: { z: 11, x: 1, y: 0, t: 0 } }),
        ],
      };
      const [slab] = layer.renderLayers();
      // colorPalette has 2 entries ⇒ slot 2 is the appended default slot.
      expect([
        ...slab.props.data.attributes.instanceCategoryIndex.value,
      ]).toEqual([0, 1, 2]);
      expect(slab.props.categoryPalette).toHaveLength(3);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('colorMappingDefault'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // ── 3. Schema key ────────────────────────────────────────────────────────

  it('keys the slabs on the DEEPEST resident zoom, independent of tile order', () => {
    // The tileset hands back a Set-ordered union; `tiles[0].id.z` was therefore
    // arbitrary and churned, throwing away every slab on each render.
    const mixed = () => [
      pointTile(rows(1), { tileId: { z: 11, x: 0, y: 0, t: 0 } }),
      pointTile(rows(1, 10), { tileId: { z: 12, x: 0, y: 0, t: 0 } }),
    ];

    const coarseFirst = makeLayer();
    coarseFirst.state = { tiles: mixed() };
    coarseFirst.renderLayers();

    const fineFirst = makeLayer();
    fineFirst.state = { tiles: mixed().reverse() };
    fineFirst.renderLayers();

    expect(coarseFirst.slabSchemaKey).toBe(fineFirst.slabSchemaKey);
    expect(coarseFirst.slabSchemaKey).toContain('|12|');
  });

  it('does NOT repack when only the tile-array ORDER changes', () => {
    const layer = makeLayer();
    const a = pointTile(rows(1), { tileId: { z: 11, x: 0, y: 0, t: 0 } });
    const b = pointTile(rows(1, 10), { tileId: { z: 12, x: 0, y: 0, t: 0 } });
    layer.state = { tiles: [a, b] };
    const [first] = layer.renderLayers();
    expect(layer.absorbedTileKeys.size).toBe(2);

    // Same tiles, different iteration order (a Set-backed union re-ordering).
    layer.state.tiles = [b, a];
    const [second] = layer.renderLayers();
    expect(second).toBe(first); // nothing re-absorbed, nothing re-uploaded
    expect(layer.absorbedTileKeys.size).toBe(2);
    expect(second.props.data.length).toBe(2);
  });

  // ── 4. SplatExtension parity with the per-tile path ─────────────────────

  it('installs SplatExtension on slab layers when `splat` is set', () => {
    const layer = makeLayer({ splat: true });
    layer.state = { tiles: [pointTile(rows(3))] };
    const [slab] = layer.renderLayers();
    expect(slab.props.extensions).toContain(SPLAT);
    expect(slab.props.extensions).toContain(TIME_FILTER);
  });

  it('omits SplatExtension when `splat` is off (byte-identical default)', () => {
    const layer = makeLayer();
    layer.state = { tiles: [pointTile(rows(3))] };
    const [slab] = layer.renderLayers();
    expect(slab.props.extensions).not.toContain(SPLAT);
  });
});
