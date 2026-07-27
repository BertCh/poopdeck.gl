// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Hardening suite for AnimatedPathLayer + AnimatedLineLayer.
 *
 * Pins the review fixes that the broader shared suites don't reach:
 *
 *   1. a runtime `pickable` flip must REPLACE the sublayer (deck matches by id
 *      alone, so reusing an id across the stock/stripped PathLayer pair leaves
 *      the wrong shader + attribute set resident and kills picking forever);
 *   2. `colorMappingDefault` is load-bearing in the CPU colour expansion, so it
 *      must invalidate the per-tile styleKey (this is what
 *      `style-key-invalidation.test.ts` covers for the point / trips layers);
 *   3. style-independent GPU buffers keep their DESCRIPTOR IDENTITY across a
 *      style-only change — deck's `setExternalBuffer` compares descriptors by
 *      object identity, so a fresh one forces a full fp64 re-upload;
 *   4. the idle CategoryColorExtension is gone from the path pipeline;
 *   5. `pathType` reaches PathLayer's `_pathType`, with the +2 wrap-vertex
 *      requirement of `'loop'` guarded;
 *   6. reveal-trail widens the tile LOAD window (finite) / warns (persist);
 *   7. the constant-width fallback matches the documented `pathWidth` default;
 *   9. the inert `positionFormat` pass-through is gone from both layers;
 *  11. both layers guard on LineString geometry.
 *
 * Exercises the real prepareTile / buildSublayer / getEffectiveTimeWindow paths
 * via `Object.create` (bypassing CompositeLayer's lifecycle), against the shared
 * deck.gl mocks that stash constructor props — no GPU. Imports the layers from
 * their SPECIFIC source paths (not the barrel, which is edited concurrently).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePathTile, makePolygonTile } from './fake-tile';
import { _resetWarnOnce } from '../src/lib/log';

// Stash-props mocks for the deck.gl layer constructors. NoPickingPathLayer is
// the REAL subclass (it extends this fake PathLayer), so the class-identity
// assertions below are meaningful.
vi.mock('@deck.gl/layers', () => {
  class FakePathLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeLineLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { PathLayer: FakePathLayer, LineLayer: FakeLineLayer };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two 3-vertex lines, no property columns. */
function plainTile() {
  return makePathTile({
    paths: [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
    ],
    startTimes: [0, 100],
    endTimes: [1000, 1100],
    timeOffset: 0,
  });
}

/**
 * Two lines carrying a categorical `kind` column whose categories are NOT both
 * present in the test `colorMapping` — the unmapped one is what
 * `colorMappingDefault` resolves.
 */
function categoryTile() {
  const tile = plainTile();
  tile.layers[0].features.categoricalProps['kind'] = {
    indices: new Uint16Array([0, 1]),
    categories: ['mapped', 'unmapped'],
  } as any;
  return tile;
}

/** Two lines carrying a numeric `w` column (per-feature width / filter value). */
function numericTile() {
  const tile = plainTile();
  tile.layers[0].features.numericProps['w'] = new Float32Array([5, 9]);
  return tile;
}

/**
 * A single ring in the layout deck.gl's tessellator expects for a CLOSED path
 * under `_pathType: 'loop'`: the ring's `n` points followed by a repeat of its
 * FIRST TWO (`B0 B1 B2 B3 B0 B1`, i.e. `n + 2` vertices).
 */
function loopPaddedTile() {
  return makePathTile({
    paths: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
        [1, 0],
      ],
    ],
    startTimes: [0],
    endTimes: [1000],
    timeOffset: 0,
  });
}

/** The same ring in the usual first-vertex-repeated-last form: NOT wrap-padded. */
function closedRingTile() {
  return makePathTile({
    paths: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    startTimes: [0],
    endTimes: [1000],
    timeOffset: 0,
  });
}

// ---------------------------------------------------------------------------
// Layer harnesses
// ---------------------------------------------------------------------------

const PATH_PROPS: Record<string, any> = {
  id: 'test',
  pathColor: [31, 186, 214, 255],
  pathWidth: 3,
  getColor: null,
  getWidth: null,
  colorPalette: [
    [1, 2, 3, 255],
    [4, 5, 6, 255],
  ],
  colorMapping: null,
  colorMappingDefault: [120, 120, 120, 255],
  widthUnits: 'pixels',
  widthScale: 1,
  widthMinPixels: 0,
  widthMaxPixels: Number.MAX_SAFE_INTEGER,
  capRounded: false,
  jointRounded: false,
  miterLimit: 4,
  billboard: false,
  pathType: 'open',
  elevationProperty: null,
  elevationMapping: null,
  elevationScale: 1,
  elevationOpacityRange: null,
  elevationOpacityNear: 1,
  elevationOpacityFar: 1,
  filterProperty: null,
  filterRange: null,
  filterSoftRange: null,
  filterEnabled: true,
  timeWindow: 1000,
  tileLoadTimeWindow: 0,
  fadeInDuration: 300,
  fadeOutDuration: 300,
  timeHeightScale: 0,
  timeHeightOrigin: 0,
  revealTrail: false,
  revealDuration: 0,
  fadeTrail: true,
  reducedMotion: false,
  opacity: 1,
  visible: true,
  pickable: false,
};

const LINE_PROPS: Record<string, any> = {
  id: 'test',
  color: [31, 186, 214, 255],
  width: 1,
  getColor: null,
  getWidth: null,
  colorPalette: [],
  colorMapping: null,
  colorMappingDefault: [120, 120, 120, 255],
  widthUnits: 'pixels',
  widthScale: 1,
  widthMinPixels: 0,
  widthMaxPixels: Number.MAX_SAFE_INTEGER,
  filterProperty: null,
  filterRange: null,
  filterSoftRange: null,
  filterEnabled: true,
  timeWindow: 1000,
  fadeInDuration: 300,
  fadeOutDuration: 300,
  timeHeightScale: 0,
  timeHeightOrigin: 0,
  opacity: 1,
  visible: true,
  pickable: false,
};

describe('AnimatedPathLayer / AnimatedLineLayer hardening', () => {
  let PathCtor: any;
  let LineCtor: any;
  let NoPickingPathLayer: any;
  let StockPathLayer: any;
  let makePathLayer: (opts?: any) => any;
  let makeLineLayer: (opts?: any) => any;
  let buildPath: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    _resetWarnOnce();
    PathCtor = (await import('../src/layers/core/animated-path-layer'))
      .AnimatedPathLayer;
    LineCtor = (await import('../src/layers/core/animated-line-layer'))
      .AnimatedLineLayer;
    NoPickingPathLayer = (
      await import('../src/layers/internal/no-picking-path-layer')
    ).NoPickingPathLayer;
    StockPathLayer = (await import('@deck.gl/layers')).PathLayer;

    const bare = (Ctor: any, defaults: Record<string, any>) => (opts: any) => {
      const layer = Object.create(Ctor.prototype);
      layer.props = { ...defaults, ...opts };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = { __id: 'time-filter' };
      layer.categoryColorExtension = { __id: 'category-color' };
      layer.dataFilterExtension = { __id: 'data-filter' };
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      layer.lastTilesRef = null;
      return layer;
    };
    makePathLayer = bare(PathCtor, PATH_PROPS);
    makeLineLayer = bare(LineCtor, LINE_PROPS);
    buildPath = (tile, opts = {}) => {
      const layer = makePathLayer(opts);
      return layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    };
  });

  // -------------------------------------------------------------------------
  // 1. pickable toggle must change the sublayer IDENTITY, not just its props
  // -------------------------------------------------------------------------

  describe('pickable toggle (fix 1)', () => {
    it('false → true swaps the class AND the sublayer id', () => {
      const tile = plainTile();
      const off = buildPath(tile, { pickable: false });
      const on = buildPath(tile, { pickable: true });

      expect(off).toBeInstanceOf(NoPickingPathLayer);
      expect(on).toBeInstanceOf(StockPathLayer);
      expect(on).not.toBeInstanceOf(NoPickingPathLayer);
      // Distinct ids ⇒ deck cannot match them and MUST run _initialize on the
      // replacement, which is the only path that re-registers
      // instancePickingColors and recompiles the model.
      expect(off.props.id).not.toBe(on.props.id);
      expect(off.props.id).toMatch(/:np$/);
      expect(on.props.id).toMatch(/:pk$/);
    });

    it('true → false is the mirror image (same distinct-id guarantee)', () => {
      const tile = plainTile();
      const on = buildPath(tile, { pickable: true });
      const off = buildPath(tile, { pickable: false });
      expect(on.props.id).not.toBe(off.props.id);
      expect(on.props.pickable).toBe(true);
      expect(off.props.pickable).toBe(false);
    });

    it('the id is otherwise STABLE frame to frame (cache matching still works)', () => {
      const tile = plainTile();
      expect(buildPath(tile).props.id).toBe(buildPath(tile).props.id);
    });

    it('a _subLayerProps type override keeps ONE stable id across the flip', () => {
      // The class is then the user's in both branches, so there is no stripped
      // shader to strand — and churning the id would needlessly recreate GPU
      // state on every pickable change.
      class Swapped {
        props: Record<string, any>;
        constructor(props: Record<string, any>) {
          this.props = props;
        }
      }
      const tile = plainTile();
      const sub = { paths: { type: Swapped } };
      const off = buildPath(tile, { pickable: false, _subLayerProps: sub });
      const on = buildPath(tile, { pickable: true, _subLayerProps: sub });
      expect(off).toBeInstanceOf(Swapped);
      expect(on).toBeInstanceOf(Swapped);
      expect(off.props.id).toBe(on.props.id);
    });
  });

  // -------------------------------------------------------------------------
  // 2. colorMappingDefault must invalidate the prepared tile
  // -------------------------------------------------------------------------

  describe('colorMappingDefault invalidation (fix 2)', () => {
    it('a change re-prepares the tile and re-expands getColor', () => {
      const layer = makePathLayer({
        pathColor: 'kind',
        colorMapping: { mapped: [10, 20, 30, 255] },
        colorMappingDefault: [1, 1, 1, 255],
      });
      const tile = categoryTile();
      const first = layer.prepareTile(tile, tile.layers[0]);
      // Same props ⇒ cached object back.
      expect(layer.prepareTile(tile, tile.layers[0])).toBe(first);

      layer.props.colorMappingDefault = [200, 100, 50, 255];
      const second = layer.prepareTile(tile, tile.layers[0]);
      expect(second.styleKey).not.toBe(first.styleKey);
      expect(second).not.toBe(first);

      // Feature 1 ('unmapped') resolves through colorMappingDefault; feature 0
      // ('mapped') is unchanged. Vertices 3-5 belong to feature 1.
      const before = Array.from(first.data.attributes.getColor.value as any);
      const after = Array.from(second.data.attributes.getColor.value as any);
      expect(before.slice(12, 16)).toEqual([1, 1, 1, 255]);
      expect(after.slice(12, 16)).toEqual([200, 100, 50, 255]);
      expect(after.slice(0, 4)).toEqual([10, 20, 30, 255]);
    });

    it('the rebuilt tile also rebuilds the cached SUBLAYER', () => {
      const layer = makePathLayer({
        pathColor: 'kind',
        colorMapping: { mapped: [10, 20, 30, 255] },
        colorMappingDefault: [1, 1, 1, 255],
      });
      const tile = categoryTile();
      layer.state = { tiles: [tile] };
      const [first] = layer.renderLayers();
      expect(layer.renderLayers()[0]).toBe(first); // cached
      layer.props.colorMappingDefault = [9, 9, 9, 255];
      const [second] = layer.renderLayers();
      expect(second).not.toBe(first);
    });
  });

  // -------------------------------------------------------------------------
  // 3. style-independent descriptors keep their identity
  // -------------------------------------------------------------------------

  describe('per-tile attribute memo (fix 3)', () => {
    it('a palette-only change keeps the SAME getPath descriptor object', () => {
      const layer = makePathLayer({
        pathColor: 'kind',
        colorPalette: [
          [1, 2, 3, 255],
          [4, 5, 6, 255],
        ],
      });
      const tile = categoryTile();
      const first = layer.prepareTile(tile, tile.layers[0]);
      layer.props.colorPalette = [
        [9, 9, 9, 255],
        [4, 5, 6, 255],
      ];
      const second = layer.prepareTile(tile, tile.layers[0]);

      // The tile really was re-prepared …
      expect(second).not.toBe(first);
      expect(second.data.attributes.getColor).not.toBe(
        first.data.attributes.getColor,
      );
      // … but the style-independent buffers came back by IDENTITY, so deck's
      // setExternalBuffer short-circuits instead of re-uploading fp64 positions.
      expect(second.data.attributes.getPath).toBe(
        first.data.attributes.getPath,
      );
      expect(second.data.attributes.instanceStartTime).toBe(
        first.data.attributes.instanceStartTime,
      );
      expect(second.data.attributes.instanceEndTime).toBe(
        first.data.attributes.instanceEndTime,
      );
    });

    it('getPath stays zero-copy over the tile buffer when flat', () => {
      const tile = plainTile();
      const prepared = makePathLayer({}).prepareTile(tile, tile.layers[0]);
      expect(prepared.data.attributes.getPath.value).toBe(
        tile.layers[0].features.positions,
      );
      expect(prepared.data.attributes.getPath.size).toBe(2);
    });

    it('memoizes the synthesized per-vertex trail times across style changes', () => {
      const layer = makePathLayer({ revealTrail: true, pathColor: 'kind' });
      const tile = categoryTile();
      const first = layer.prepareTile(tile, tile.layers[0]);
      layer.props.colorMappingDefault = [7, 7, 7, 255];
      const second = layer.prepareTile(tile, tile.layers[0]);
      expect(second).not.toBe(first);
      expect(second.data.attributes.instanceVertexTime).toBe(
        first.data.attributes.instanceVertexTime,
      );
    });

    it('memoizes the per-vertex width / filter expansions by column name', () => {
      const tile = numericTile();
      const layer = makePathLayer({
        pathWidth: 'w',
        filterProperty: 'w',
        pathColor: 'kind',
      });
      tile.layers[0].features.categoricalProps['kind'] = {
        indices: new Uint16Array([0, 1]),
        categories: ['a', 'b'],
      } as any;
      const first = layer.prepareTile(tile, tile.layers[0]);
      layer.props.colorPalette = [
        [7, 7, 7, 255],
        [8, 8, 8, 255],
      ];
      const second = layer.prepareTile(tile, tile.layers[0]);
      expect(second).not.toBe(first);
      expect(second.data.attributes.getWidth).toBe(
        first.data.attributes.getWidth,
      );
      expect(second.data.attributes.filterValue).toBe(
        first.data.attributes.filterValue,
      );
      // Still per-VERTEX (6 vertices), not per-feature.
      expect(second.data.attributes.getWidth.value.length).toBe(6);
    });

    it('an ELEVATION change DOES rebuild the path descriptor (content differs)', () => {
      const tile = numericTile();
      const layer = makePathLayer({
        elevationProperty: 'w',
        elevationScale: 1,
      });
      const first = layer.prepareTile(tile, tile.layers[0]);
      expect(first.data.attributes.getPath.size).toBe(3);
      layer.props.elevationScale = 10;
      const second = layer.prepareTile(tile, tile.layers[0]);
      expect(second.data.attributes.getPath).not.toBe(
        first.data.attributes.getPath,
      );
      expect(second.data.attributes.getPath.value[2]).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // 4. the idle CategoryColorExtension is gone
  // -------------------------------------------------------------------------

  describe('attribute budget (fix 4)', () => {
    it('installs the time filter ALONE by default (no CategoryColorExtension)', () => {
      const layer = makePathLayer({});
      const tile = plainTile();
      const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
      expect(sub.props.extensions).toEqual([layer.timeFilterExtension]);
      expect(sub.props.extensions).not.toContain(layer.categoryColorExtension);
    });

    it('still drops nothing when a column filter is installed (time + filter)', () => {
      const layer = makePathLayer({
        filterProperty: 'w',
        filterRange: [0, 10],
      });
      const tile = numericTile();
      const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
      expect(sub.props.extensions).toEqual([
        layer.timeFilterExtension,
        layer.dataFilterExtension,
      ]);
    });

    it('categorical colour is unaffected — it is CPU-expanded into getColor', () => {
      const layer = makePathLayer({ pathColor: 'kind' });
      const tile = categoryTile();
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      expect(prepared.data.attributes.instanceCategoryIndex).toBeUndefined();
      // 6 vertices × RGBA.
      expect(prepared.data.attributes.getColor.value.length).toBe(24);
      const sub = layer.buildSublayer(prepared);
      expect(sub.props.useCategoryColor).toBeUndefined();
      expect(sub.props.categoryPalette).toBeUndefined();
    });

    it('warns ONLY for the pickable + filter combination (17 slots)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        buildPath(numericTile(), { pickable: true });
        buildPath(numericTile(), {
          filterProperty: 'w',
          filterRange: [0, 10],
        });
        expect(
          warn.mock.calls.filter((c) => /vertex attributes/.test(String(c[0]))),
        ).toHaveLength(0);

        buildPath(numericTile(), {
          pickable: true,
          filterProperty: 'w',
          filterRange: [0, 10],
        });
        expect(
          warn.mock.calls.filter((c) => /vertex attributes/.test(String(c[0]))),
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. pathType
  // -------------------------------------------------------------------------

  describe('pathType (fix 5)', () => {
    it("defaults to 'open' and forwards it as _pathType", () => {
      expect(buildPath(plainTile()).props._pathType).toBe('open');
    });

    it("forwards 'loop' to PathLayer's _pathType", () => {
      expect(
        buildPath(loopPaddedTile(), { pathType: 'loop' }).props._pathType,
      ).toBe('loop');
    });

    it('a pathType change invalidates the sublayer cache', () => {
      const layer = makePathLayer({});
      layer.state = { tiles: [loopPaddedTile()] };
      const [first] = layer.renderLayers();
      layer.props.pathType = 'loop';
      const [second] = layer.renderLayers();
      expect(second).not.toBe(first);
      expect(second.props._pathType).toBe('loop');
    });

    it("warns when 'loop' is asked for on tiles WITHOUT the +2 wrap vertices", () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        buildPath(closedRingTile(), { pathType: 'loop' });
        expect(
          warn.mock.calls.filter((c) =>
            /FIRST TWO vertices/.test(String(c[0])),
          ),
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('stays silent on a correctly wrap-padded tile', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        buildPath(loopPaddedTile(), { pathType: 'loop' });
        expect(
          warn.mock.calls.filter((c) =>
            /FIRST TWO vertices/.test(String(c[0])),
          ),
        ).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });

    it("does not check padding at all for 'open'", () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        buildPath(closedRingTile(), { pathType: 'open' });
        expect(
          warn.mock.calls.filter((c) =>
            /FIRST TWO vertices/.test(String(c[0])),
          ),
        ).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. reveal-trail vs the tile LOAD window
  // -------------------------------------------------------------------------

  describe('reveal trail load window (fix 6)', () => {
    it('widens the load window to 2× a FINITE revealDuration', () => {
      const layer = makePathLayer({
        revealTrail: true,
        revealDuration: 5000,
        timeWindow: 1000,
      });
      expect(layer.getEffectiveTimeWindow()).toBe(10000);
    });

    it('never NARROWS an explicit tileLoadTimeWindow', () => {
      const layer = makePathLayer({
        revealTrail: true,
        revealDuration: 5000,
        timeWindow: 1000,
        tileLoadTimeWindow: 60000,
      });
      expect(layer.getEffectiveTimeWindow()).toBe(60000);
    });

    it('leaves the window alone when reveal is off', () => {
      const layer = makePathLayer({ revealDuration: 5000, timeWindow: 1000 });
      expect(layer.getEffectiveTimeWindow()).toBe(1000);
    });

    it('warns for reveal-PERSIST with no tileLoadTimeWindow', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const layer = makePathLayer({ revealTrail: true, revealDuration: 0 });
        expect(layer.getEffectiveTimeWindow()).toBe(1000);
        expect(
          warn.mock.calls.filter((c) =>
            /tileLoadTimeWindow/.test(String(c[0])),
          ),
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('stays silent when reveal-persist is paired with a load window', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const layer = makePathLayer({
          revealTrail: true,
          revealDuration: 0,
          tileLoadTimeWindow: 86400000,
        });
        expect(layer.getEffectiveTimeWindow()).toBe(86400000);
        expect(
          warn.mock.calls.filter((c) =>
            /tileLoadTimeWindow/.test(String(c[0])),
          ),
        ).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7 / 8 / 9. constant fallbacks, widthUnits, positionFormat
  // -------------------------------------------------------------------------

  describe('constant fallbacks and pass-throughs (fixes 7-9)', () => {
    it('falls back to the documented pathWidth default (3) on a tile without the column', () => {
      // `pathWidth` names a column this tile never baked: the sublayer constant
      // is the "no data" width, and it must equal the documented default so a
      // partially-baked dataset renders ONE width, not two.
      const sub = buildPath(plainTile(), { pathWidth: 'missing' });
      expect(sub.props.data.attributes.getWidth).toBeUndefined();
      expect(sub.props.getWidth).toBe(3);
      // …and it agrees with the layer's own default prop value.
      expect((PathCtor as any).defaultProps.pathWidth.value).toBe(3);
    });

    it('falls back to the documented pathColor default on a tile without the column', () => {
      const sub = buildPath(plainTile(), { pathColor: 'missing' });
      expect(sub.props.getColor).toEqual([0, 150, 255, 255]);
    });

    it("accepts widthUnits: 'common' and forwards it", () => {
      expect(
        buildPath(plainTile(), { widthUnits: 'common' }).props.widthUnits,
      ).toBe('common');
    });

    it('passes NO positionFormat (path): deck reads the stride from getPath.size', () => {
      const flat = buildPath(plainTile());
      expect(flat.props.positionFormat).toBeUndefined();
      expect(flat.props.data.attributes.getPath.size).toBe(2);

      const lifted = buildPath(numericTile(), { elevationProperty: 'w' });
      expect(lifted.props.positionFormat).toBeUndefined();
      expect(lifted.props.data.attributes.getPath.size).toBe(3);
    });

    it('passes NO positionFormat (line): LineLayer never reads it', () => {
      const layer = makeLineLayer({});
      const tile = plainTile();
      const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
      expect(sub.props.positionFormat).toBeUndefined();
      expect(sub.props.data.attributes.getSourcePosition.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 11. geometry guard
  // -------------------------------------------------------------------------

  describe('geometry guard (fix 11)', () => {
    const polygonTile = () =>
      makePolygonTile({
        polygons: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        startTimes: [0],
        endTimes: [1000],
        timeOffset: 0,
      });

    it('path: skips a POLYGON tile layer and warns once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const layer = makePathLayer({});
        const tile = polygonTile();
        expect(layer.prepareTile(tile, tile.layers[0])).toBeNull();
        expect(
          warn.mock.calls.filter((c) => /LineString/.test(String(c[0]))),
        ).toHaveLength(1);
        // Warned ONCE, not per tile.
        expect(layer.prepareTile(tile, tile.layers[0])).toBeNull();
        expect(
          warn.mock.calls.filter((c) => /LineString/.test(String(c[0]))),
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('line: skips a POLYGON tile layer', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const layer = makeLineLayer({});
        const tile = polygonTile();
        expect(layer.prepareTile(tile, tile.layers[0])).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });

    it('both accept LineString tiles', () => {
      const tile = plainTile();
      expect(
        makePathLayer({}).prepareTile(tile, tile.layers[0]),
      ).not.toBeNull();
      expect(
        makeLineLayer({}).prepareTile(tile, tile.layers[0]),
      ).not.toBeNull();
    });

    it('both accept an UNTAGGED tile (pre-geometry-kind archives / fixtures)', () => {
      const tile = plainTile();
      (tile.layers[0].features as any).geometryType = undefined;
      expect(
        makePathLayer({}).prepareTile(tile, tile.layers[0]),
      ).not.toBeNull();
      expect(
        makeLineLayer({}).prepareTile(tile, tile.layers[0]),
      ).not.toBeNull();
    });

    it('renderLayers skips the mismatched layer instead of throwing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const layer = makePathLayer({});
        layer.state = { tiles: [polygonTile()] };
        expect(layer.renderLayers()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
