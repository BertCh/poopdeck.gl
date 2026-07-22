/**
 * B5 prop-parity: DataFilterExtension + stable categorical colorMapping on the
 * arc / line / trips layers.
 *
 * Asserts, for each layer, that:
 *  - `filterProperty` binds a `filterValue` attribute and installs the shared
 *    DataFilterExtension, passing `filterRange` / `filterSoftRange` /
 *    `filterEnabled` through to the sublayer (soft + hard range wiring);
 *  - `colorMapping` resolves STABLE per-category colors across tiles whose
 *    category dictionaries differ in order/subset (arc + line; trips already
 *    had it, so it is exercised as a regression guard);
 *  - passing NONE of the new props leaves the sublayer byte-identical to the
 *    pre-B5 behavior — no `filterValue` attribute, no filter props on the
 *    sublayer (no explicit-`undefined` shadow), and the extension list
 *    unchanged.
 *
 * deck.gl layers need a GPU, so `@deck.gl/layers` / `@deck.gl/core` are mocked
 * (same harness as animated-arc-layer.test.ts) and the real prepareTile +
 * buildSublayer paths run via Object.create. Extensions are set as sentinel
 * objects so their identity can be checked in the composed list.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePathTile } from './fake-tile';

vi.mock('@deck.gl/layers', () => {
  class Fake {
    props: Record<string, any>;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return {
    ArcLayer: Fake,
    LineLayer: Fake,
    PathLayer: Fake,
    ScatterplotLayer: Fake,
    SolidPolygonLayer: Fake,
  };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { ...core, Layer: FakeLayer, project32: { name: 'project32' } };
});

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const MAPPING_DEFAULT: [number, number, number, number] = [120, 120, 120, 255];

/** Sentinel extension objects — identity is what the composed list is checked against. */
function extensionSentinels() {
  return {
    timeFilterExtension: { _kind: 'time' },
    categoryColorExtension: { _kind: 'category' },
    dataFilterExtension: { _kind: 'filter' },
  };
}

/** Build a fake OD tile: `n` features, each a 2-vertex LineString (source→target). */
function odTile(n: number) {
  const paths: number[][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    paths[i] = [
      [i * 0.1, i * 0.2],
      [i * 0.1 + 1, i * 0.2 + 1],
    ];
  }
  return makePathTile({
    paths,
    startTimes: new Array(n).fill(0),
    endTimes: new Array(n).fill(1000),
    timeOffset: 0,
  });
}

/** Attach a categorical column to a tile's features. */
function withCategory(
  tile: any,
  prop: string,
  categories: string[],
  indices: number[],
) {
  tile.layers[0].features.categoricalProps[prop] = {
    indices: new Uint16Array(indices),
    categories,
  };
  return tile;
}

/** Attach a numeric column to a tile's features. */
function withNumeric(tile: any, prop: string, values: number[]) {
  tile.layers[0].features.numericProps[prop] = new Float32Array(values);
  return tile;
}

// ---------------------------------------------------------------------------
// Shared assertions parameterized over the three layers.
// ---------------------------------------------------------------------------

interface LayerCase {
  name: string;
  modulePath: string;
  ctorName: string;
  /** Base props for the fake layer (color/width vocabulary differs per layer). */
  baseProps: Record<string, any>;
  /** Set the categorical color column name (sourceColor / color / tripColor). */
  colorProp: (col: string) => Record<string, any>;
  /** Whether the layer expands filterValue per-vertex (trips) vs per-feature (arc/line). */
  perVertexFilter: boolean;
  /**
   * Whether the (idle) CategoryColorExtension stays in the list when a filter is
   * installed. Arc/line have vertex-attribute headroom and keep both; the trips
   * PathLayer family sits at the WebGL2 16-attr floor, so it DROPS the idle
   * CategoryColorExtension to make room for `filterValue` (categorical color is
   * CPU-expanded there — dropping it loses nothing). Pins the 16-slot budget fix.
   */
  keepsCategoryWhenFiltering: boolean;
}

const ARC: LayerCase = {
  name: 'AnimatedArcLayer',
  modulePath: '../src/layers/core/animated-arc-layer',
  ctorName: 'AnimatedArcLayer',
  baseProps: {
    id: 'arcs',
    sourceColor: [0, 150, 255, 255],
    targetColor: [255, 127, 14, 255],
    width: 2,
    widthUnits: 'pixels',
    greatCircle: false,
    arcHeight: 1,
    arcTilt: 0,
    timeWindow: 1000,
    opacity: 1,
    visible: true,
  },
  colorProp: (col) => ({ sourceColor: col }),
  perVertexFilter: false,
  keepsCategoryWhenFiltering: true,
};

const LINE: LayerCase = {
  name: 'AnimatedLineLayer',
  modulePath: '../src/layers/core/animated-line-layer',
  ctorName: 'AnimatedLineLayer',
  baseProps: {
    id: 'lines',
    color: [0, 150, 255, 255],
    width: 1,
    widthUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
  },
  colorProp: (col) => ({ color: col }),
  perVertexFilter: false,
  keepsCategoryWhenFiltering: true,
};

const TRIPS: LayerCase = {
  name: 'AnimatedTripsLayer',
  modulePath: '../src/layers/trips/animated-trips-layer',
  ctorName: 'AnimatedTripsLayer',
  baseProps: {
    id: 'trips',
    tripColor: [253, 128, 93, 255],
    tripWidth: 3,
    widthUnits: 'pixels',
    trailLength: 1000,
    fadeTrail: true,
    gradientColorRamp: [],
    timeWindow: 1000,
    opacity: 1,
    visible: true,
  },
  colorProp: (col) => ({ tripColor: col }),
  perVertexFilter: true,
  keepsCategoryWhenFiltering: false,
};

for (const CASE of [ARC, LINE, TRIPS]) {
  describe(`${CASE.name} B5 props`, () => {
    let LayerCtor: any;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import(/* @vite-ignore */ CASE.modulePath);
      LayerCtor = mod[CASE.ctorName];
    });

    /** Construct a fake layer + run prepareTile + buildSublayer, returning both. */
    function run(tile: any, extraProps: Record<string, any> = {}) {
      const layer: any = Object.create(LayerCtor.prototype);
      layer.props = { ...CASE.baseProps, ...extraProps };
      Object.assign(layer, extensionSentinels());
      layer.boundGetTime = () => 0;
      layer.getCurrentTime = () => 0;
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      const built = layer.buildSublayer(prepared);
      return { layer, prepared, built };
    }

    // ── DataFilterExtension ────────────────────────────────────────────────

    it('binds a filterValue attribute + installs DataFilterExtension when filterProperty is set', () => {
      const tile = withNumeric(odTile(3), 'speed', [5, 15, 25]);
      const { layer, prepared, built } = run(tile, {
        filterProperty: 'speed',
        filterRange: [10, 30],
      });

      const filterValue = prepared.data.attributes.filterValue;
      expect(filterValue).toBeDefined();
      expect(filterValue.size).toBe(1);
      if (CASE.perVertexFilter) {
        // PathLayer's filterValue is per-SEGMENT-instanced — splatted per vertex.
        const totalVerts =
          tile.layers[0].features.startIndices[
            tile.layers[0].features.featureCount
          ];
        expect(filterValue.value.length).toBe(totalVerts);
        // feature 1 (verts 2..3) carries speed 15.
        expect(filterValue.value[2]).toBe(15);
      } else {
        // Arc/Line are instanced one-per-feature → zero-copy per-feature bind.
        expect(filterValue.value).toBe(
          tile.layers[0].features.numericProps.speed,
        );
        expect(filterValue.value.length).toBe(3);
      }

      // The shared singleton is present in the composed extension list.
      expect(built.props.extensions).toContain(layer.dataFilterExtension);

      // ATTRIBUTE-BUDGET (WebGL2 16-slot floor): the trips PathLayer family sits
      // AT the floor once a filter is installed, so it DROPS the idle
      // CategoryColorExtension to make room for `filterValue` (12 NoPickingPath +
      // 3 TimeFilter + 1 filter = 16; keeping category would be 17 → a fatal
      // shader-link failure / blank render on 16-attr GPUs). Arc/line have
      // headroom and keep both. Pins the trips overflow regression.
      if (CASE.keepsCategoryWhenFiltering) {
        expect(built.props.extensions).toContain(layer.categoryColorExtension);
      } else {
        expect(built.props.extensions).not.toContain(
          layer.categoryColorExtension,
        );
      }
    });

    it('passes soft + hard range and filterEnabled through to the sublayer', () => {
      const tile = withNumeric(odTile(4), 'speed', [1, 2, 3, 4]);
      const { built } = run(tile, {
        filterProperty: 'speed',
        filterRange: [1, 4],
        filterSoftRange: [2, 3],
        filterEnabled: true,
      });
      expect(built.props.filterRange).toEqual([1, 4]);
      expect(built.props.filterSoftRange).toEqual([2, 3]);
      // Gated on the tile having baked the attribute AND the enabled flag.
      expect(built.props.filterEnabled).toBe(true);
      // Constant fallback for tiles missing the column.
      expect(built.props.getFilterValue).toBe(0);
    });

    it('idles the filter (enabled false) for a tile missing the named column', () => {
      const tile = odTile(3); // no `speed` column
      const { prepared, built } = run(tile, {
        filterProperty: 'speed',
        filterRange: [10, 30],
      });
      expect(prepared.data.attributes.filterValue).toBeUndefined();
      // Extension still installed (stable list), but disabled for this tile.
      expect(built.props.filterEnabled).toBe(false);
    });

    // ── Byte-identical when none of the new props are passed ────────────────

    it('leaves the sublayer untouched when no new props are passed (no undefined shadow)', () => {
      const tile = odTile(5);
      const { layer, prepared, built } = run(tile);

      // No filter attribute, no DataFilterExtension.
      expect(prepared.data.attributes.filterValue).toBeUndefined();
      expect(built.props.extensions).not.toContain(layer.dataFilterExtension);

      // No filter props leak onto the sublayer as explicit undefined — the keys
      // must be ABSENT (a defaultProps default would otherwise be shadowed).
      for (const key of [
        'filterRange',
        'filterSoftRange',
        'filterEnabled',
        'getFilterValue',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(built.props, key)).toBe(
          false,
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Stable categorical colorMapping — arc + line only. These color on the GPU
// (one per-feature category index → a per-tile palette texture), so a
// mapping-resolved `categoryPalette` is the observable contract. Trips colors
// via a CPU per-vertex getColor buffer (no `categoryPalette`) and is covered by
// its own palette-parity suite.
// ---------------------------------------------------------------------------

const COLOR_CASES: Array<{
  name: string;
  modulePath: string;
  ctorName: string;
  baseProps: Record<string, any>;
  colorCol: string;
}> = [
  { ...ARC, colorCol: 'sourceColor' },
  { ...LINE, colorCol: 'color' },
].map((c) => ({
  name: c.name,
  modulePath: c.modulePath,
  ctorName: c.ctorName,
  baseProps: c.baseProps,
  colorCol: c.colorCol,
}));

for (const CASE of COLOR_CASES) {
  describe(`${CASE.name} B5 stable colorMapping`, () => {
    let LayerCtor: any;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import(/* @vite-ignore */ CASE.modulePath);
      LayerCtor = mod[CASE.ctorName];
    });

    function prepareWithMapping(tile: any) {
      const layer: any = Object.create(LayerCtor.prototype);
      layer.props = {
        ...CASE.baseProps,
        [CASE.colorCol]: 'kind',
        colorMapping: { car: RED, ship: BLUE },
        colorMappingDefault: MAPPING_DEFAULT,
      };
      Object.assign(layer, extensionSentinels());
      layer.boundGetTime = () => 0;
      layer.getCurrentTime = () => 0;
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      return { layer, built: layer.buildSublayer(prepared) };
    }

    it('resolves a category to the SAME color regardless of per-tile dictionary order', () => {
      // Tile A dictionary: car=0, ship=1. Tile B: ship=0, car=1 (reversed).
      const tileA = withCategory(odTile(2), 'kind', ['car', 'ship'], [0, 1]);
      const tileB = withCategory(odTile(2), 'kind', ['ship', 'car'], [0, 1]);

      const a = prepareWithMapping(tileA);
      const b = prepareWithMapping(tileB);

      expect(a.built.props.useCategoryColor).toBe(true);
      expect(b.built.props.useCategoryColor).toBe(true);

      // Per-tile palette follows each tile's own dictionary order, so the raw
      // arrays differ...
      const paletteA = a.built.props.categoryPalette;
      const paletteB = b.built.props.categoryPalette;
      expect(paletteA).toEqual([RED, BLUE, MAPPING_DEFAULT]);
      expect(paletteB).toEqual([BLUE, RED, MAPPING_DEFAULT]);

      // ...but a given category resolves to the SAME color in both tiles: the
      // whole point of colorMapping. 'ship' is index 1 in A, index 0 in B.
      const catsA = tileA.layers[0].features.categoricalProps.kind.categories;
      const catsB = tileB.layers[0].features.categoricalProps.kind.categories;
      expect(paletteA[catsA.indexOf('ship')]).toEqual(BLUE);
      expect(paletteB[catsB.indexOf('ship')]).toEqual(BLUE);
      expect(paletteA[catsA.indexOf('car')]).toEqual(RED);
      expect(paletteB[catsB.indexOf('car')]).toEqual(RED);
    });

    it('maps categories absent from colorMapping to the fallback color', () => {
      // 'plane' is not in the mapping → the fallback (colorMappingDefault).
      const tile = withCategory(odTile(2), 'kind', ['car', 'plane'], [0, 1]);
      const { built } = prepareWithMapping(tile);
      const palette = built.props.categoryPalette;
      expect(palette[0]).toEqual(RED); // car
      expect(palette[1]).toEqual(MAPPING_DEFAULT); // plane → fallback
    });
  });
}
