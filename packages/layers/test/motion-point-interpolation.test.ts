/**
 * AnimatedPointLayer glide (B2 motion-interpolation) tests.
 *
 * Point archives carry one row per entity PER SAMPLE; the GPU time-window path
 * shows every in-window sample at once, so a moving entity POPS between its
 * samples. The `interpolate` glide path instead pools the loaded tiles' samples
 * by `idProperty` (via the shared track kernel) and emits ONE ScatterplotLayer
 * of each active entity's pose CPU-interpolated between the two samples
 * bracketing the playhead. These tests pin: cross-tile glide (no pop), max-gap
 * hold-last, default-off invariance (same window sublayer count + a time filter
 * present, and no interp-frame bump when off), reduced-motion fallback to the
 * window path, and picking that maps to the decoded source feature.
 *
 * Exercised via Object.create (bypassing CompositeLayer's lifecycle) with the
 * deck.gl mocks capturing constructed sublayer props — the same harness shape as
 * animated-bounding-box-layer.test.ts / animated-icon-layer.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

// ---------------------------------------------------------------------------
// deck.gl mocks — the ScatterplotLayer just stashes its props.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique per-instance sentinels so extension identity is assertable. */
const TIME_FILTER = { name: 'TimeFilterExtension' };
const CATEGORY_COLOR = { name: 'CategoryColorExtension' };

/** Build a categorical {indices, categories} column from string values. */
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

interface IdRow {
  lon: number;
  lat: number;
  /** Time RELATIVE to the tile timeOffset. */
  t: number;
  id?: string;
  alt?: number;
}

/** Build a point tile whose entity id lives in an `icao24` categorical column. */
function makeIdTile(
  rows: IdRow[],
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
    f.categoricalProps['icao24'] = categorical(rows.map((r) => r.id ?? ''));
  }
  if (rows.some((r) => r.alt !== undefined)) {
    f.numericProps['alt'] = new Float32Array(rows.map((r) => r.alt ?? NaN));
  }
  return tile;
}

describe('AnimatedPointLayer glide (motion interpolation)', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let render: (tiles: Tile[], time: number, opts?: any) => any[];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-point-layer');
    LayerCtor = mod.AnimatedPointLayer as any;

    makeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
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
        radiusTransform: null,
        splat: false,
        fadeInDuration: 0,
        fadeOutDuration: 0,
        wakeLength: 0,
        wakeTailScale: 0.15,
        cumulative: false,
        use3D: false,
        elevationProperty: null,
        elevationScale: 1,
        filterProperty: null,
        filterRange: null,
        filterSoftRange: null,
        filterEnabled: true,
        timeWindow: 1000,
        timeHeightScale: 0,
        timeHeightOrigin: 0,
        // Glide props (off by default in this harness).
        interpolate: false,
        idProperty: null,
        maxInterpolationGap: Infinity,
        reducedMotion: false,
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
      layer.slabs = [];
      layer.absorbedTileKeys = new Set();
      return layer;
    };

    render = (tiles, time, opts = {}) => {
      const layer = makeLayer(opts);
      layer.state = { tiles };
      layer._currentTime = time;
      return (layer as any).renderLayers();
    };
  });

  // ── Cross-tile glide (no pop) ────────────────────────────────────────────

  it('glides one entity smoothly across a tile seam — ONE instance, no pop', () => {
    // Entity A's two samples live in DIFFERENT tiles (a cross-tile seam). The
    // window path would show BOTH samples at once whenever they fall in the
    // window (the "train"/pop); glide pools them into one interpolated marker.
    const a = makeIdTile([{ id: 'A', lon: 0, lat: 0, t: 0 }], {
      timeOffset: 0,
      tileId: { z: 6, x: 1, y: 2, t: 0 },
    });
    const b = makeIdTile([{ id: 'A', lon: 10, lat: 0, t: 1000 }], {
      timeOffset: 0,
      tileId: { z: 6, x: 1, y: 2, t: 1 },
    });
    const layers = render([a, b], 500, {
      interpolate: true,
      idProperty: 'icao24',
    });
    expect(layers.length).toBe(1); // one glide sublayer
    const data = layers[0].props.data;
    expect(data.length).toBe(1); // ONE interpolated marker, not two samples
    // Halfway between the t=0 (lon 0) and t=1000 (lon 10) cross-tile samples.
    expect(data.attributes.getPosition.value[0]).toBeCloseTo(5, 6);
    expect(data.attributes.getPosition.value[1]).toBeCloseTo(0, 6);
  });

  it('renders one marker PER entity (distinct entities stay distinct)', () => {
    const tile = makeIdTile([
      { id: 'A', lon: 0, lat: 0, t: 0 },
      { id: 'B', lon: 50, lat: 0, t: 0 },
      { id: 'A', lon: 10, lat: 0, t: 1000 },
      { id: 'B', lon: 60, lat: 0, t: 1000 },
    ]);
    const data = render([tile], 500, {
      interpolate: true,
      idProperty: 'icao24',
    })[0].props.data;
    expect(data.length).toBe(2);
  });

  // ── Max-gap hold-last ────────────────────────────────────────────────────

  it('holds the last sample across a gap wider than maxInterpolationGap (no fabricated motion)', () => {
    const tile = makeIdTile([
      { id: 'A', lon: 0, lat: 0, t: 0 },
      { id: 'A', lon: 100, lat: 0, t: 10_000 }, // 10 s gap
    ]);
    // Gap 10 000 ms > maxInterpolationGap 1 000 ⇒ HOLD at the last sample (lon 0),
    // NOT the straight-line midpoint (lon 50).
    const held = render([tile], 5000, {
      interpolate: true,
      idProperty: 'icao24',
      maxInterpolationGap: 1000,
    })[0].props.data;
    expect(held.attributes.getPosition.value[0]).toBeCloseTo(0, 6);
  });

  it('interpolates across the same gap when maxInterpolationGap admits it', () => {
    const tile = makeIdTile([
      { id: 'A', lon: 0, lat: 0, t: 0 },
      { id: 'A', lon: 100, lat: 0, t: 10_000 },
    ]);
    // Default Infinity gap ⇒ glide the midpoint (lon 50).
    const glid = render([tile], 5000, {
      interpolate: true,
      idProperty: 'icao24',
    })[0].props.data;
    expect(glid.attributes.getPosition.value[0]).toBeCloseTo(50, 6);
  });

  // ── Default-off invariance ───────────────────────────────────────────────

  it('is byte-identical to the GPU window path when interpolate is OFF (same sublayer count + a time filter present)', () => {
    const a = makeIdTile([{ id: 'A', lon: 0, lat: 0, t: 0 }], {
      tileId: { z: 6, x: 1, y: 2, t: 0 },
    });
    const b = makeIdTile([{ id: 'A', lon: 10, lat: 0, t: 500 }], {
      tileId: { z: 6, x: 1, y: 3, t: 0 },
    });
    // Off (the default): the window path emits one sublayer PER tile...
    const off = render([a, b], 250, { interpolate: false });
    expect(off.length).toBe(2);
    // ...each carrying the TimeFilterExtension (GPU window filtering).
    for (const sub of off) {
      expect(sub.props.extensions).toContain(TIME_FILTER);
    }
    // Glide instead collapses to ONE sublayer with NO time filter (the contrast
    // that proves "off" took the untouched window path).
    const on = render([a, b], 250, {
      interpolate: true,
      idProperty: 'icao24',
    });
    expect(on.length).toBe(1);
    expect(on[0].props.extensions).not.toContain(TIME_FILTER);
  });

  it('bumps the interp-frame counter only when glide is active and time advanced', () => {
    const tile = makeIdTile([
      { id: 'A', lon: 0, lat: 0, t: 0 },
      { id: 'A', lon: 10, lat: 0, t: 1000 },
    ]);

    // OFF ⇒ no counter bump (the GPU path animates via a uniform, not
    // renderLayers), so _handleTimeUpdate never setStates a frame counter.
    const off = makeLayer({ interpolate: false });
    off.state = { tiles: [tile] };
    off.setState = vi.fn();
    (off as any)._handleTimeUpdate(1000);
    expect(off.setState).not.toHaveBeenCalled();

    // ON ⇒ bump once when sim-time advances...
    const on = makeLayer({ interpolate: true, idProperty: 'icao24' });
    on.state = { tiles: [tile] };
    on.setState = vi.fn();
    (on as any)._handleTimeUpdate(1000);
    expect(on.setState).toHaveBeenCalledWith(
      expect.objectContaining({ interpFrame: expect.anything() }),
    );
    // ...and NOT again on a repeated/identical tick (paused clock, dup tick).
    on.setState.mockClear();
    (on as any)._handleTimeUpdate(1000);
    expect(on.setState).not.toHaveBeenCalled();
  });

  // ── Reduced-motion fallback ──────────────────────────────────────────────

  it('degrades to the GPU window path when reducedMotion is set', () => {
    const a = makeIdTile([{ id: 'A', lon: 0, lat: 0, t: 0 }], {
      tileId: { z: 6, x: 1, y: 2, t: 0 },
    });
    const b = makeIdTile([{ id: 'A', lon: 10, lat: 0, t: 500 }], {
      tileId: { z: 6, x: 1, y: 3, t: 0 },
    });
    // interpolate ON but reducedMotion ON ⇒ the window path (per-tile sublayers
    // with the time filter), NOT the single glide sublayer.
    const layers = render([a, b], 250, {
      interpolate: true,
      idProperty: 'icao24',
      reducedMotion: true,
    });
    expect(layers.length).toBe(2);
    for (const sub of layers) {
      expect(sub.props.extensions).toContain(TIME_FILTER);
    }
  });

  // ── Picking ──────────────────────────────────────────────────────────────

  it('picks a glided marker back to its decoded source feature', () => {
    const tile = makeIdTile([
      { id: 'ABC123', lon: 0, lat: 0, t: 0, alt: 900 },
      { id: 'ABC123', lon: 10, lat: 0, t: 1000, alt: 900 },
      { id: 'XYZ789', lon: 5, lat: 5, t: 0, alt: 300 },
      { id: 'XYZ789', lon: 6, lat: 5, t: 1000, alt: 300 },
    ]);
    const layer = makeLayer({ interpolate: true, idProperty: 'icao24' });
    layer.state = { tiles: [tile] };
    layer._currentTime = 500;
    const built = (layer as any).renderLayers()[0];
    // One instance per active entity, stride 1.
    expect(built.props.sttPickStride).toBe(1);
    expect(built.props.sttPickRows.length).toBe(2);

    // Insertion order (A then B): index 0 → the first entity's source feature.
    const info: any = { index: 0 };
    const out = (layer as any).getPickingInfo({ info, sourceLayer: built });
    // The pick maps to the decoded source feature: its id + a source column.
    expect(out.object.icao24).toBe('ABC123');
    expect(out.object.alt).toBe(900);
  });

  // ── Bounded glide pick-row caches ────────────────────────────────────────

  describe('glide pick-row caches are bounded to the resident set', () => {
    /**
     * Two samples of one entity in a tile of its own, so each tile can enter and
     * leave the resident set independently. The entity id doubles as the tile's
     * x coordinate seed, keeping (tile, layer) keys distinct across the churn.
     */
    function entityTile(id: string, x: number): Tile {
      return makeIdTile(
        [
          { id, lon: x, lat: 0, t: 0 },
          { id, lon: x + 1, lat: 0, t: 1000 },
        ],
        { tileId: { z: 6, x, y: 0, t: 0 } },
      );
    }

    /**
     * Drive a real render pass over a NEW tile array (a fresh array ref is what
     * the layer treats as a tile-set change) against ONE persistent layer, so
     * the caches live in `state.sttPointCache` across the churn the way they do
     * under deck's layer matching.
     */
    function renderTiles(layer: any, tiles: Tile[]): void {
      layer.state.tiles = tiles;
      layer._currentTime = 500;
      layer.renderLayers();
    }

    it('returns the pick-row count to its starting value across a load → evict → reload churn cycle', () => {
      const layer = makeLayer({ interpolate: true, idProperty: 'icao24' });

      // Baseline: two entities resident.
      const home = [entityTile('A', 0), entityTile('B', 2)];
      renderTiles(layer, [...home]);
      const startRows = layer.interpPickRows.size;
      const startScanned = layer.interpPickRowsScanned.size;
      expect(startRows).toBe(2);
      expect(startScanned).toBe(2);

      // Pan away and back, ten times, over entirely disjoint tiles/entities —
      // the accumulate-only version grew to 22 rows here and never shrank.
      for (let i = 0; i < 10; i++) {
        renderTiles(layer, [
          entityTile(`away-${i}-1`, 10 + i * 2),
          entityTile(`away-${i}-2`, 11 + i * 2),
        ]);
        expect(layer.interpPickRows.size).toBe(2);
      }

      // Back home: the count is exactly where it started, not the session total.
      renderTiles(layer, [...home]);
      expect(layer.interpPickRows.size).toBe(startRows);
      expect(layer.interpPickRowsScanned.size).toBe(startScanned);
      expect([...layer.interpPickRows.keys()].sort()).toEqual(['A', 'B']);
    });

    it('still resolves a pick to the decoded source feature after the churn', () => {
      // Pruning must not cost the retained rows their purpose: a re-entering
      // tile is re-scanned, so picking a resident entity still works.
      const layer = makeLayer({ interpolate: true, idProperty: 'icao24' });
      const home = makeIdTile(
        [
          { id: 'ABC123', lon: 0, lat: 0, t: 0, alt: 900 },
          { id: 'ABC123', lon: 10, lat: 0, t: 1000, alt: 900 },
        ],
        { tileId: { z: 6, x: 0, y: 0, t: 0 } },
      );
      renderTiles(layer, [home]);
      renderTiles(layer, [entityTile('OTHER', 40)]);
      expect(layer.interpPickRows.has('ABC123')).toBe(false); // evicted

      layer.state.tiles = [home];
      layer._currentTime = 500;
      const built = layer.renderLayers()[0];
      const out = layer.getPickingInfo({
        info: { index: 0 },
        sourceLayer: built,
      });
      expect(out.object.icao24).toBe('ABC123');
      expect(out.object.alt).toBe(900);
    });

    it('does not re-decode an id that stayed resident', () => {
      const layer = makeLayer({ interpolate: true, idProperty: 'icao24' });
      const a = entityTile('A', 0);
      renderTiles(layer, [a]);
      const rowA = layer.interpPickRows.get('A');
      // A new array ref forces a re-sync, but `a` is still live and still
      // scanned, so its row object must be the SAME instance.
      renderTiles(layer, [a]);
      expect(layer.interpPickRows.get('A')).toBe(rowA);
    });
  });
});
