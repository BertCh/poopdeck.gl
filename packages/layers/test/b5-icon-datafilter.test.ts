/**
 * §5 capability-matrix completion: DataFilterExtension range-filter on the
 * AnimatedIconLayer discrete / window render path.
 *
 * Icon was the one layer that got interpolation / wake / stable colorMapping but
 * NOT the GPU column filter. This suite mirrors `b5-arc-line-trips-props.test.ts`
 * (the arc/line/trips DataFilter parity suite) for the icon layer, asserting:
 *  - `filterProperty` binds a zero-copy `filterValue` attribute and installs the
 *    shared DataFilterExtension on the discrete IconLayer sublayer;
 *  - `filterRange` / `filterSoftRange` / `filterEnabled` pass through to it;
 *  - a tile lacking the named column IDLES the filter (filterEnabled false) while
 *    keeping the extension installed (stable per-layer list);
 *  - DEFAULT-OFF PARITY: with no filter props the sublayer is byte-identical to
 *    the pre-change behaviour — no `filterValue` attribute, the DataFilterExtension
 *    ABSENT from the extension list, none of the filter keys present as an
 *    explicit-`undefined` shadow, and the glide/wake wiring untouched.
 *
 * deck.gl layers need a GPU, so `@deck.gl/layers` / `@deck.gl/core` are mocked
 * (the same harness as motion-icon-interpolation.test.ts) and the real
 * prepareTile + buildSublayer paths run via Object.create. Extensions are set as
 * sentinel objects so their identity is checkable in the composed list. The
 * layer is imported from its SPECIFIC module path (not the barrel).
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
    constructor(props: Record<string, any> = {}) {
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

/** Sentinel extension objects — identity is what the composed list is checked against. */
function extensionSentinels() {
  return {
    timeFilterExtension: { _kind: 'time' },
    categoryColorExtension: { _kind: 'category' },
    dataFilterExtension: { _kind: 'filter' },
  };
}

/** Base props matching the icon layer's discrete window path. */
function baseProps(): Record<string, any> {
  return {
    id: 'icons',
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
    fadeInDuration: 300,
    fadeOutDuration: 300,
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
  };
}

/** Build a point tile of `n` icon snapshots. */
function pointTile(n: number): Tile {
  const positions: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) positions[i] = [i * 0.1, i * 0.2];
  return makePointTile({
    positions,
    startTimes: new Array(n).fill(0),
    endTimes: new Array(n).fill(1000),
    timeOffset: 0,
  });
}

/** Attach a numeric column to a tile's features. */
function withNumeric(tile: any, prop: string, values: number[]) {
  tile.layers[0].features.numericProps[prop] = new Float32Array(values);
  return tile;
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

describe('AnimatedIconLayer DataFilter (§5 capability-matrix completion)', () => {
  let LayerCtor: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-icon-layer.js');
    LayerCtor = mod.AnimatedIconLayer;
  });

  /** Construct a fake layer + run prepareTile + buildSublayer, returning both. */
  function run(tile: any, extraProps: Record<string, any> = {}) {
    const layer: any = Object.create(LayerCtor.prototype);
    layer.props = { ...baseProps(), ...extraProps };
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

  // ── (1) filterProperty binds filterValue + installs DataFilterExtension ────

  it('binds a filterValue attribute + installs DataFilterExtension when filterProperty is set', () => {
    const tile = withNumeric(pointTile(3), 'speed', [5, 15, 25]);
    const { layer, prepared, built } = run(tile, {
      filterProperty: 'speed',
      filterRange: [10, 30],
    });

    const filterValue = prepared.data.attributes.filterValue;
    expect(filterValue).toBeDefined();
    expect(filterValue.size).toBe(1);
    // IconLayer is instanced one-per-feature → zero-copy per-feature bind.
    expect(filterValue.value).toBe(tile.layers[0].features.numericProps.speed);
    expect(filterValue.value.length).toBe(3);

    // The shared singleton is present in the composed extension list, and it
    // is INSTALLED ON THE DISCRETE sublayer (window path), NOT the glide path.
    expect(built.props.extensions).toContain(layer.dataFilterExtension);
    // Composes WITH the time filter — both are present.
    expect(built.props.extensions).toContain(layer.timeFilterExtension);
  });

  // ── (2) range + softRange + filterEnabled pass-through ─────────────────────

  it('passes soft + hard range and filterEnabled through to the sublayer', () => {
    const tile = withNumeric(pointTile(4), 'speed', [1, 2, 3, 4]);
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

  // ── (3) tile missing the column idles the filter, keeps the extension ──────

  it('idles the filter (enabled false) for a tile missing the named column', () => {
    const tile = pointTile(3); // no `speed` column
    const { layer, prepared, built } = run(tile, {
      filterProperty: 'speed',
      filterRange: [10, 30],
    });
    expect(prepared.data.attributes.filterValue).toBeUndefined();
    // Extension still installed (stable per-layer list), but disabled for this tile.
    expect(built.props.extensions).toContain(layer.dataFilterExtension);
    expect(built.props.filterEnabled).toBe(false);
  });

  it('ignores a CATEGORICAL filterProperty (numeric columns only in v1)', () => {
    const tile = withCategory(pointTile(2), 'kind', ['car', 'ship'], [0, 1]);
    const { prepared, built } = run(tile, {
      filterProperty: 'kind',
      filterRange: [0, 1],
    });
    // No numeric column → no attribute baked → idle for this tile.
    expect(prepared.data.attributes.filterValue).toBeUndefined();
    expect(built.props.filterEnabled).toBe(false);
  });

  // ── (4) default-off parity — byte-identical, glide/wake untouched ──────────

  it('leaves the sublayer untouched when no filter props are passed (no undefined shadow)', () => {
    const tile = pointTile(5);
    const { layer, prepared, built } = run(tile);

    // No filter attribute, no DataFilterExtension.
    expect(prepared.data.attributes.filterValue).toBeUndefined();
    expect(built.props.extensions).not.toContain(layer.dataFilterExtension);

    // The extension list is byte-identical to the pre-change list: exactly the
    // time filter + categorical color singletons, in order, and nothing else.
    expect(built.props.extensions).toEqual([
      layer.timeFilterExtension,
      layer.categoryColorExtension,
    ]);

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

    // Glide / wake wiring is untouched by the filter addition.
    expect(built.props.wakeLength).toBe(0);
    expect(built.props.wakeTailScale).toBe(0.15);
    expect(built.props.getIcon).toBeTypeOf('function');
  });
});
