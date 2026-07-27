/**
 * AnimatedPointLayer hardening: cache residency, geometry guard, vector-column
 * leaf types, glide-path prop coverage, and styleKey hoisting.
 *
 * Each of these is a "renders something plausible instead of failing" class:
 *
 *  - CACHE RESIDENCY — deck constructs a NEW layer object per render and moves
 *    only `state`/`internalState` across (`Layer._transferState`), so caches
 *    held in class fields are wiped by any unmemoized `new AnimatedPointLayer`
 *    in a React render. The symptom is a frame-time cliff, not an error.
 *  - GEOMETRY GUARD — a linestring tile decodes into the same fields as a point
 *    tile with different MEANINGS; indexing `positions` by feature index then
 *    bunches every marker onto the first few paths.
 *  - VECTOR LEAF TYPE — deck derives the GPU format from the typed array, so an
 *    f32 leaf bound as a "size 4 normalized colour" becomes a `float32x4`
 *    (16-byte stride) buffer and blows every point out to white.
 *  - GLIDE — the `interpolate` path emits one instance per ENTITY, so per-sample
 *    styling has nowhere to attach; it must SAY so rather than ignore it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile, makePathTile } from './fake-tile';
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

const TIME_FILTER = { name: 'TimeFilterExtension' };
const CATEGORY_COLOR = { name: 'CategoryColorExtension' };
const SPLAT = { name: 'SplatExtension' };
const DATA_FILTER = { name: 'STTDataFilterExtension' };

/** `n` points in one tile, sequential relative times. */
function pointTile(
  n: number,
  tileId = { z: 6, x: 0, y: 0, t: 0 },
  timeOffset = 0,
): Tile {
  return makePointTile({
    positions: Array.from({ length: n }, (_, i) => [i * 0.01, 40 + i * 0.01]),
    startTimes: Array.from({ length: n }, (_, i) => i * 100),
    endTimes: Array.from({ length: n }, (_, i) => i * 100 + 50),
    timeOffset,
    tileId,
  });
}

/** Build a categorical {indices, categories} column from string values. */
function categorical(values: string[]) {
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

describe('AnimatedPointLayer hardening', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: Record<string, any>) => any;

  beforeEach(async () => {
    vi.resetModules();
    LayerCtor = (await import('../src/layers/core/animated-point-layer'))
      .AnimatedPointLayer as any;

    makeLayer = (opts: Record<string, any> = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'pts',
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
        cumulative: false,
        use3D: false,
        elevationProperty: null,
        elevationScale: 1,
        filterProperty: null,
        filterRange: null,
        filterSoftRange: null,
        filterEnabled: true,
        interpolate: false,
        idProperty: null,
        maxInterpolationGap: Infinity,
        reducedMotion: false,
        timeWindow: 1000,
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
      layer.splatExtension = SPLAT;
      layer.dataFilterExtension = DATA_FILTER;
      return layer;
    };
  });

  // ── Caches survive deck's layer matching ────────────────────────────────

  it('keeps the prepared + sublayer caches across a simulated _transferState', () => {
    // deck.gl's Layer._transferState moves ONLY state/internalState onto the
    // freshly constructed layer; class fields re-run their initializers.
    const first = makeLayer();
    const tile = pointTile(4);
    first.state = { tiles: [tile] };
    const [before] = first.renderLayers();
    expect(first.preparedTileCache.size).toBe(1);

    const next = makeLayer();
    next.state = first.state; // ← exactly what _transferState does
    const [after] = next.renderLayers();

    expect(after).toBe(before); // same sublayer instance ⇒ no GPU re-upload
    expect(after.props.data).toBe(before.props.data);
    expect(next.preparedTileCache.size).toBe(1);
  });

  it('keeps cumulative slabs across a simulated _transferState (no full re-absorb)', () => {
    // Cumulative widens the loader window to 2 × span, so EVERY tile is
    // resident: dropping the slabs re-packs the whole dataset synchronously.
    const first = makeLayer({ cumulative: true, timeRange: null });
    first.state = {
      tiles: [
        pointTile(3, { z: 11, x: 0, y: 0, t: 0 }),
        pointTile(3, { z: 11, x: 1, y: 0, t: 0 }),
      ],
    };
    const [before] = first.renderLayers();
    expect(first.absorbedTileKeys.size).toBe(2);
    expect(before.props.data.length).toBe(6);

    const next = makeLayer({ cumulative: true, timeRange: null });
    next.state = first.state;
    const [after] = next.renderLayers();

    expect(next.absorbedTileKeys.size).toBe(2); // nothing re-absorbed
    expect(after.props.data.length).toBe(6); // NOT 12 (no double-pack)
    expect(after).toBe(before); // slab version unchanged ⇒ layer reused
  });

  it('drops every cache on finalizeState', () => {
    const layer = makeLayer({ cumulative: true, timeRange: null });
    layer.state = { tiles: [pointTile(3, { z: 11, x: 0, y: 0, t: 0 })] };
    layer.renderLayers();
    expect(layer.absorbedTileKeys.size).toBe(1);

    // The base finalizeState needs a context; a bare object is enough here.
    Object.getPrototypeOf(LayerCtor.prototype).finalizeState = () => {};
    layer.finalizeState({} as any);

    expect(layer.absorbedTileKeys.size).toBe(0);
    expect(layer.slabs).toHaveLength(0);
    expect(layer.preparedTileCache.size).toBe(0);
    expect(layer.slabBaseOffset).toBeNull();
  });

  // ── Geometry guard ──────────────────────────────────────────────────────

  it('skips a LineString tile layer instead of bunching markers onto path vertices', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const paths = makePathTile({
        paths: [
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          [
            [5, 5],
            [6, 6],
          ],
        ],
        startTimes: [0, 0],
        endTimes: [1000, 1000],
        timeOffset: 0,
      });
      const layer = makeLayer();
      layer.state = { tiles: [paths] };
      expect(layer.renderLayers()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('LineString geometry'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('still renders tiles that predate the geometry-kind tag', () => {
    const layer = makeLayer();
    const tile = pointTile(3);
    (tile.layers[0].features as any).geometryType = undefined;
    layer.state = { tiles: [tile] };
    expect(layer.renderLayers()).toHaveLength(1);
  });

  // ── colorVectorColumn leaf type ─────────────────────────────────────────

  it('binds a u8 colour vector column ZERO-COPY', () => {
    const layer = makeLayer({ colorVectorColumn: 'point_rgba' });
    const tile = pointTile(2);
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    tile.layers[0].features.vectorProps = {
      point_rgba: { value: rgba, size: 4 },
    };
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    const attr = sub.props.data.attributes.getFillColor;
    expect(attr.value).toBe(rgba); // same reference — no re-pack
    expect(attr.normalized).toBe(true);
    expect(attr.size).toBe(4);
  });

  it('converts an f32 colour-vector leaf (and warns) instead of binding float32x4', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = makeLayer({ colorVectorColumn: 'point_rgba' });
      const tile = pointTile(2);
      tile.layers[0].features.vectorProps = {
        // An f32 leaf carrying 0–255 values: gating on `size === 4` alone used
        // to bind this straight through as float32x4 → every point white.
        point_rgba: {
          value: new Float32Array([1, 2, 3, 255, 4, 5, 6, 255]),
          size: 4,
        },
      };
      layer.state = { tiles: [tile] };
      const [sub] = layer.renderLayers();
      const attr = sub.props.data.attributes.getFillColor;
      expect(attr.value).toBeInstanceOf(Uint8Array);
      expect([...attr.value]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
      expect(attr.normalized).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('float32 leaf'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores a mis-sized colour vector column and falls through to the normal path', () => {
    const layer = makeLayer({ colorVectorColumn: 'point_rgba' });
    const tile = pointTile(2);
    tile.layers[0].features.vectorProps = {
      point_rgba: { value: new Uint8Array([1, 2, 3, 4, 5, 6]), size: 3 },
    };
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    expect(sub.props.data.attributes.getFillColor).toBeUndefined();
    expect(sub.props.getFillColor).toEqual([255, 128, 0, 255]);
  });

  // ── styleKey hoisting ───────────────────────────────────────────────────

  it('computes the styleKey ONCE per render, not once per tile plus once per miss', () => {
    const layer = makeLayer();
    layer.state = {
      tiles: [
        pointTile(2, { z: 6, x: 0, y: 0, t: 0 }),
        pointTile(2, { z: 6, x: 1, y: 0, t: 0 }),
        pointTile(2, { z: 6, x: 2, y: 0, t: 0 }),
      ],
    };
    const spy = vi.spyOn(layer, 'computeStyleKey' as any);
    layer.renderLayers();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still accepts the two-argument prepareTile/buildTileData form', () => {
    const layer = makeLayer();
    const tile = pointTile(2);
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.styleKey).toBe(layer.computeStyleKey());
    expect(layer.buildTileData(tile, tile.layers[0]).styleKey).toBe(
      prepared.styleKey,
    );
  });

  // ── Glide path prop coverage ────────────────────────────────────────────

  describe('glide (interpolate) path', () => {
    function glideTile() {
      const tile = makePointTile({
        positions: [
          [0, 0],
          [10, 0],
        ],
        startTimes: [0, 1000],
        endTimes: [0, 1000],
        timeOffset: 0,
      });
      const f = tile.layers[0].features;
      f.categoricalProps['icao24'] = categorical(['A', 'A']);
      f.numericProps['mag'] = new Float32Array([1, 2]);
      f.numericProps['z'] = new Float32Array([100, 200]);
      return tile;
    }

    function renderGlide(opts: Record<string, any> = {}) {
      const layer = makeLayer({
        interpolate: true,
        idProperty: 'icao24',
        ...opts,
      });
      layer.state = { tiles: [glideTile()] };
      layer._currentTime = 500;
      return layer.renderLayers();
    }

    it('forwards `splat` (a pure fragment effect) onto the glide sublayer', () => {
      const [sub] = renderGlide({ splat: true });
      expect(sub.props.extensions).toContain(SPLAT);
      // Still no time filter — visibility is implicit on this path.
      expect(sub.props.extensions).not.toContain(TIME_FILTER);
    });

    it('leaves the glide extension list empty when `splat` is off', () => {
      const [sub] = renderGlide();
      expect(sub.props.extensions).toEqual([]);
    });

    it.each([
      ['radius', { radius: 'mag' }, 'radius/getRadius (column)'],
      ['filterProperty', { filterProperty: 'mag' }, 'filterProperty'],
      ['elevationProperty', { elevationProperty: 'z' }, 'elevationProperty'],
      [
        'timeHeightScale',
        { timeHeightScale: 3 },
        'timeHeightScale/timeHeightOrigin',
      ],
      [
        'rampProperty',
        { rampProperty: 'mag', rampColorRamp: [[1, 2, 3, 255]] },
        'rampProperty',
      ],
      [
        'rgbColorColumns',
        { rgbColorColumns: ['mag', 'mag', 'mag'] },
        'rgbColorColumns',
      ],
      [
        'colorVectorColumn',
        { colorVectorColumn: 'point_rgba' },
        'colorVectorColumn',
      ],
    ])(
      'names %s in a one-shot warning instead of dropping it silently',
      (_name, props, expected) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          renderGlide(props);
          expect(warn).toHaveBeenCalledWith(expect.stringContaining(expected));
        } finally {
          warn.mockRestore();
        }
      },
    );

    it('says nothing when the glide path can honour every prop that is set', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        renderGlide({ splat: true });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
