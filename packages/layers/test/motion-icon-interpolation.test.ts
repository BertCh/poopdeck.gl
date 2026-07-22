/**
 * AnimatedIconLayer glide (B2 interpolation) + B3 (wake exposure, stable
 * colorMapping) tests.
 *
 * B2: the `interpolate` glide path pools the loaded tiles' samples by
 * `idProperty` (via the shared track kernel) and emits ONE IconLayer of each
 * active entity's pose — position AND heading CPU-interpolated between the two
 * samples bracketing the playhead — so a marker glides and rotates smoothly
 * instead of popping between samples. Heading rides `lerpAngleDeg` because
 * IconLayer.getAngle is DEGREES (the kernel's box path is radians).
 *
 * B3: the TimeFilterExtension wake mode is exposed on icons (per-layer alpha
 * tail), and a stable per-category `colorMapping` CPU-expands to a per-feature
 * RGBA getColor (stable across tiles with different category subsets).
 *
 * Exercised via Object.create with the deck.gl mock capturing constructed
 * sublayer props — the same harness as the sibling motion/icon tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

// ---------------------------------------------------------------------------
// deck.gl mocks — the IconLayer just stashes its props.
// ---------------------------------------------------------------------------

vi.mock('@deck.gl/layers', () => {
  class FakeIconLayer {
    static layerName = 'IconLayer';
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

const ATLAS = 'https://example.test/atlas.png';
const MAPPING = {
  vessel: { x: 0, y: 0, width: 64, height: 64, mask: true },
};

/** Unique sentinels so extension identity is assertable. */
const TIME_FILTER = { name: 'TimeFilterExtension' };
const CATEGORY_COLOR = { name: 'CategoryColorExtension' };

/** Degrees → radians, and a degrees literal alias for readability. */
const DEG = (d: number) => d;

function categorical(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
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
  return { indices, categories };
}

interface VesselRow {
  lon: number;
  lat: number;
  /** Time RELATIVE to the tile timeOffset. */
  t: number;
  id?: string;
  /** Heading / course over ground in DEGREES. */
  heading?: number;
  vtype?: string;
  sog?: number;
}

/** Build a point tile of vessel snapshots (id in `mmsi`, heading in `cog`). */
function makeVesselTile(
  rows: VesselRow[],
  opts: {
    timeOffset?: number;
    tileId?: { z: number; x: number; y: number; t: number };
  } = {},
): Tile {
  const tile = makePointTile({
    positions: rows.map((r) => [r.lon, r.lat]),
    startTimes: rows.map((r) => r.t),
    endTimes: rows.map((r) => r.t),
    timeOffset: opts.timeOffset ?? 0,
    tileId: opts.tileId,
  });
  const f = tile.layers[0].features;
  if (rows.some((r) => r.id !== undefined)) {
    f.categoricalProps['mmsi'] = categorical(rows.map((r) => r.id ?? ''));
  }
  if (rows.some((r) => r.vtype !== undefined)) {
    f.categoricalProps['vtype'] = categorical(rows.map((r) => r.vtype ?? ''));
  }
  if (rows.some((r) => r.heading !== undefined)) {
    f.numericProps['cog'] = new Float32Array(rows.map((r) => r.heading ?? NaN));
  }
  if (rows.some((r) => r.sog !== undefined)) {
    f.numericProps['sog'] = new Float32Array(rows.map((r) => r.sog ?? NaN));
  }
  return tile;
}

describe('AnimatedIconLayer glide + wake + stable colorMapping', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let render: (tiles: Tile[], time: number, opts?: any) => any[];
  let buildSublayerForTile: (tile: Tile, opts?: any) => any;

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
        angle: 0,
        color: [255, 255, 255, 255],
        size: 12,
        pixelOffset: [0, 0],
        colorPalette: [
          [10, 20, 30, 255],
          [40, 50, 60, 255],
          [70, 80, 90, 255],
        ],
        colorMapping: null,
        colorMappingDefault: [0, 0, 0, 0],
        sizeUnits: 'pixels',
        sizeScale: 1,
        sizeMinPixels: 0,
        sizeMaxPixels: Number.MAX_SAFE_INTEGER,
        sizeBasis: 'height',
        billboard: true,
        alphaCutoff: 0.05,
        textureParameters: null,
        fadeInDuration: 0,
        fadeOutDuration: 0,
        wakeLength: 0,
        wakeTailScale: 0.15,
        interpolate: false,
        idProperty: null,
        maxInterpolationGap: Infinity,
        reducedMotion: false,
        timeWindow: 1000,
        tileLoadTimeWindow: 0,
        timeHeightScale: 0,
        timeHeightOrigin: 0,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => layer._currentTime;
      layer.timeFilterExtension = TIME_FILTER;
      layer.categoryColorExtension = CATEGORY_COLOR;
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      layer.lastTilesRef = null;
      layer.interpTrackIndex = null;
      layer.interpTrackIndexKey = '';
      layer.interpPickRows = null;
      layer.lastInterpFrameTime = NaN;
      return layer;
    };

    render = (tiles, time, opts = {}) => {
      const layer = makeLayer(opts);
      layer.state = { tiles };
      layer._currentTime = time;
      return (layer as any).renderLayers();
    };

    buildSublayerForTile = (tile, opts = {}) => {
      const layer = makeLayer(opts);
      return (layer as any).buildSublayer(
        (layer as any).prepareTile(tile, tile.layers[0]),
      );
    };
  });

  // ── Cross-tile glide (no pop) ────────────────────────────────────────────

  it('glides one vessel across a tile seam — ONE icon instance, no pop', () => {
    const a = makeVesselTile([{ id: 'A', lon: 0, lat: 0, t: 0 }], {
      tileId: { z: 8, x: 1, y: 2, t: 0 },
    });
    const b = makeVesselTile([{ id: 'A', lon: 10, lat: 0, t: 1000 }], {
      tileId: { z: 8, x: 1, y: 2, t: 1 },
    });
    const layers = render([a, b], 500, {
      interpolate: true,
      idProperty: 'mmsi',
    });
    expect(layers.length).toBe(1);
    const data = layers[0].props.data;
    expect(data.length).toBe(1); // ONE interpolated icon, not two samples
    expect(data.attributes.getPosition.value[0]).toBeCloseTo(5, 6);
  });

  // ── Degrees-heading shortest-arc ─────────────────────────────────────────

  it('interpolates a DEGREES heading column the SHORT way across the 360/0 seam', () => {
    // cog 350°→10° must pass through 360°, not spin back through 180°.
    const tile = makeVesselTile([
      { id: 'A', lon: 0, lat: 0, t: 0, heading: DEG(350) },
      { id: 'A', lon: 1, lat: 0, t: 1000, heading: DEG(10) },
    ]);
    const data = render([tile], 500, {
      interpolate: true,
      idProperty: 'mmsi',
      angle: 'cog',
    })[0].props.data;
    const ang = data.attributes.getAngle.value[0];
    // Short arc (+20°): midpoint 350°+10° = 360°. The long way lands on 180°.
    expect(ang).toBeCloseTo(360, 3);
    expect(Math.abs(ang - 180)).toBeGreaterThan(100);
    // getAngle is fed as a per-instance DEGREES attribute (size 1).
    expect(data.attributes.getAngle.size).toBe(1);
  });

  it('falls back to a bearing-from-motion angle when there is no heading column', () => {
    // No cog column: a vessel moving due east yields a finite travel bearing.
    const tile = makeVesselTile([
      { id: 'A', lon: 0, lat: 0, t: 0 },
      { id: 'A', lon: 10, lat: 0, t: 1000 },
    ]);
    const ang = render([tile], 500, {
      interpolate: true,
      idProperty: 'mmsi',
    })[0].props.data.attributes.getAngle.value[0];
    expect(Number.isFinite(ang)).toBe(true);
    // North-up icon facing due-east travel ⇒ a -90° (≡ 270°) CCW getAngle.
    expect(ang).toBeCloseTo(-90, 3);
  });

  // ── Max-gap hold-last ────────────────────────────────────────────────────

  it('holds the last sample across a gap wider than maxInterpolationGap', () => {
    const tile = makeVesselTile([
      { id: 'A', lon: 0, lat: 0, t: 0 },
      { id: 'A', lon: 100, lat: 0, t: 10_000 },
    ]);
    const held = render([tile], 5000, {
      interpolate: true,
      idProperty: 'mmsi',
      maxInterpolationGap: 1000,
    })[0].props.data;
    expect(held.attributes.getPosition.value[0]).toBeCloseTo(0, 6);
  });

  // ── Default-off invariance ───────────────────────────────────────────────

  it('is byte-identical to the window path when interpolate is OFF (same sublayer count + a time filter present)', () => {
    const a = makeVesselTile([{ id: 'A', lon: 0, lat: 0, t: 0 }], {
      tileId: { z: 8, x: 1, y: 2, t: 0 },
    });
    const b = makeVesselTile([{ id: 'A', lon: 10, lat: 0, t: 500 }], {
      tileId: { z: 8, x: 1, y: 3, t: 0 },
    });
    const off = render([a, b], 250, { interpolate: false });
    expect(off.length).toBe(2); // one IconLayer per tile
    for (const sub of off) {
      expect(sub.props.extensions).toContain(TIME_FILTER);
    }
    // Glide collapses to ONE sublayer with NO time filter (the contrast).
    const on = render([a, b], 250, { interpolate: true, idProperty: 'mmsi' });
    expect(on.length).toBe(1);
    expect(on[0].props.extensions).not.toContain(TIME_FILTER);
  });

  it('bumps the interp-frame counter only when glide is active and time advanced', () => {
    const tile = makeVesselTile([
      { id: 'A', lon: 0, lat: 0, t: 0 },
      { id: 'A', lon: 10, lat: 0, t: 1000 },
    ]);
    const off = makeLayer({ interpolate: false });
    off.state = { tiles: [tile] };
    off.setState = vi.fn();
    (off as any)._handleTimeUpdate(1000);
    expect(off.setState).not.toHaveBeenCalled();

    const on = makeLayer({ interpolate: true, idProperty: 'mmsi' });
    on.state = { tiles: [tile] };
    on.setState = vi.fn();
    (on as any)._handleTimeUpdate(1000);
    expect(on.setState).toHaveBeenCalledWith(
      expect.objectContaining({ interpFrame: expect.anything() }),
    );
    on.setState.mockClear();
    (on as any)._handleTimeUpdate(1000);
    expect(on.setState).not.toHaveBeenCalled();
  });

  // ── Reduced-motion fallback ──────────────────────────────────────────────

  it('degrades to the window path when reducedMotion is set', () => {
    const a = makeVesselTile([{ id: 'A', lon: 0, lat: 0, t: 0 }], {
      tileId: { z: 8, x: 1, y: 2, t: 0 },
    });
    const b = makeVesselTile([{ id: 'A', lon: 10, lat: 0, t: 500 }], {
      tileId: { z: 8, x: 1, y: 3, t: 0 },
    });
    const layers = render([a, b], 250, {
      interpolate: true,
      idProperty: 'mmsi',
      reducedMotion: true,
    });
    expect(layers.length).toBe(2);
    for (const sub of layers) {
      expect(sub.props.extensions).toContain(TIME_FILTER);
    }
  });

  // ── Picking ──────────────────────────────────────────────────────────────

  it('picks a glided icon back to its decoded source feature', () => {
    const tile = makeVesselTile([
      { id: 'A11', lon: 0, lat: 0, t: 0, sog: 12 },
      { id: 'A11', lon: 10, lat: 0, t: 1000, sog: 12 },
      { id: 'B22', lon: 5, lat: 5, t: 0, sog: 3 },
      { id: 'B22', lon: 6, lat: 5, t: 1000, sog: 3 },
    ]);
    const layer = makeLayer({ interpolate: true, idProperty: 'mmsi' });
    layer.state = { tiles: [tile] };
    layer._currentTime = 500;
    const built = (layer as any).renderLayers()[0];
    expect(built.props.sttPickStride).toBe(1);
    expect(built.props.sttPickRows.length).toBe(2);
    const out = (layer as any).getPickingInfo({
      info: { index: 0 },
      sourceLayer: built,
    });
    expect(out.object.mmsi).toBe('A11');
    expect(out.object.sog).toBe(12);
  });

  // ── B3: wake exposure ─────────────────────────────────────────────────────

  it('forwards wakeLength / wakeTailScale to the sublayer TimeFilterExtension (window path)', () => {
    const built = buildSublayerForTile(
      makeVesselTile([{ id: 'A', lon: 0, lat: 0, t: 0 }]),
      { wakeLength: 5000, wakeTailScale: 0.2 },
    );
    expect(built.props.wakeLength).toBe(5000);
    expect(built.props.wakeTailScale).toBe(0.2);
  });

  it('widens the effective load window to 2× wakeLength in wake mode', () => {
    const layer = makeLayer({ wakeLength: 5000, timeWindow: 1000 });
    // Wake off (default) leaves the base window untouched...
    const base = makeLayer({ wakeLength: 0, timeWindow: 1000 });
    expect((base as any).getEffectiveTimeWindow()).toBe(1000);
    // ...on ⇒ max(timeWindow, 2 × wakeLength).
    expect((layer as any).getEffectiveTimeWindow()).toBe(10_000);
  });

  // ── B3: stable per-category colorMapping ──────────────────────────────────

  it('CPU-expands a stable per-category colorMapping into a per-feature getColor', () => {
    const tile = makeVesselTile([
      { id: 'A', lon: 0, lat: 0, t: 0, vtype: 'cargo' },
      { id: 'B', lon: 1, lat: 0, t: 0, vtype: 'tanker' },
    ]);
    const built = buildSublayerForTile(tile, {
      color: 'vtype',
      colorMapping: {
        cargo: [80, 170, 255, 255],
        tanker: [255, 90, 90, 255],
      },
      colorMappingDefault: [10, 20, 30, 255],
    });
    const attrs = built.props.data.attributes;
    // Stable CPU path: per-feature RGBA getColor, NO GPU category index.
    expect(attrs.getColor).toBeDefined();
    expect(attrs.getColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getColor.normalized).toBe(true);
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(built.props.useCategoryColor).toBe(false);
    expect(Array.from(attrs.getColor.value.slice(0, 4))).toEqual([
      80, 170, 255, 255,
    ]);
    expect(Array.from(attrs.getColor.value.slice(4, 8))).toEqual([
      255, 90, 90, 255,
    ]);
  });

  it('uses colorMappingDefault for categories absent from the map', () => {
    const tile = makeVesselTile([
      { id: 'A', lon: 0, lat: 0, t: 0, vtype: 'fishing' },
    ]);
    const built = buildSublayerForTile(tile, {
      color: 'vtype',
      colorMapping: { cargo: [80, 170, 255, 255] },
      colorMappingDefault: [50, 50, 50, 255],
    });
    const color = built.props.data.attributes.getColor.value;
    expect(Array.from(color.slice(0, 4))).toEqual([50, 50, 50, 255]);
  });

  it('keeps the GPU category-index path when NO colorMapping is set', () => {
    const tile = makeVesselTile([
      { id: 'A', lon: 0, lat: 0, t: 0, vtype: 'cargo' },
    ]);
    const built = buildSublayerForTile(tile, { color: 'vtype' });
    const attrs = built.props.data.attributes;
    expect(attrs.getColor).toBeUndefined();
    expect(attrs.instanceCategoryIndex).toBeDefined();
    expect(built.props.useCategoryColor).toBe(true);
  });
});
