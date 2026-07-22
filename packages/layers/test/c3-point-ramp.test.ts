/**
 * C3 — continuous color ramp on AnimatedPointLayer.
 *
 * `rampProperty` / `rampDomain` / `rampColorRamp` map a baked NUMERIC column
 * to a per-point fill via the shared framework-free ramp kernel in
 * @poopdeck.gl/core (`expandRampColors`, the engine already behind the three
 * backend's `rampProperty` and the trips layers' `gradientProperty`).
 *
 * Covers:
 *  1. Ramp resolution — the named column expands to a normalized u8 RGBA
 *     `getFillColor` attribute with exact stop / midpoint colors.
 *  2. Domain clamping — values outside `rampDomain` clamp to the end colors.
 *  3. Precedence — the ramp WINS over the categorical fillColor/colorMapping
 *     paths (CPU and GPU), and LOSES to the baked per-point `rgbColorColumns`.
 *  4. Fall-through — a tile lacking the column (or an empty/categorical
 *     misconfiguration, which warns once) uses the normal color path.
 *  5. styleKey invalidation — changing property/domain/stops re-prepares.
 *
 * Same Object.create + deck-mock harness as data-filter-extension.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { ScatterplotLayer: FakeScatterplotLayer };
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

import { _resetWarnOnce } from '../src/lib/log';

// Blue → green → red, evenly spaced.
const RAMP: [number, number, number, number][] = [
  [0, 0, 255, 255],
  [0, 255, 0, 255],
  [255, 0, 0, 255],
];
const BLUE = [0, 0, 255, 255];
const TEAL = [0, 127, 127, 255]; // midpoint of blue→green (127.5 truncates)
const GREEN = [0, 255, 0, 255];
const RED = [255, 0, 0, 255];

/**
 * Point tile with a numeric `dbz` column (the ramp target) and a categorical
 * `band` column (the precedence foil). dbz values, with domain [0, 50]:
 * start, blue→green midpoint, mid stop, end, below-domain, above-domain.
 */
function rampTile() {
  const tile = makePointTile({
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ],
    startTimes: [0, 1, 2, 3, 4, 5],
    endTimes: [1, 2, 3, 4, 5, 6],
    timeOffset: 0,
  });
  tile.layers[0].features.numericProps['dbz'] = new Float32Array([
    0, 12.5, 25, 50, -10, 60,
  ]) as any;
  tile.layers[0].features.categoricalProps['band'] = {
    indices: new Uint16Array([0, 0, 0, 1, 1, 1]),
    categories: ['low', 'high'],
  } as any;
  return tile;
}

async function makePointLayer(props: Record<string, any> = {}) {
  const { AnimatedPointLayer } =
    await import('../src/layers/core/animated-point-layer');
  const layer: any = Object.create((AnimatedPointLayer as any).prototype);
  layer.props = {
    id: 'pts',
    fillColor: [255, 128, 0, 255],
    radius: 5,
    radiusUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = { __k: 'time' };
  layer.categoryColorExtension = { __k: 'category' };
  layer.dataFilterExtension = { __k: 'filter' };
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

/** Build the single sublayer for `tile` through the real prepare/build path. */
function buildSub(layer: any, tile: any) {
  return layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
}

/** Slice feature `i`'s RGBA out of a u8 color buffer. */
function rgbaAt(buf: Uint8Array, i: number): number[] {
  return Array.from(buf.subarray(i * 4, i * 4 + 4));
}

beforeEach(() => {
  vi.resetModules();
  _resetWarnOnce();
  vi.restoreAllMocks();
});

describe('AnimatedPointLayer rampProperty — ramp color resolution', () => {
  it('expands the named numeric column to a normalized u8 RGBA getFillColor', async () => {
    const layer = await makePointLayer({
      rampProperty: 'dbz',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    const attr = sub.props.data.attributes.getFillColor;
    expect(attr).toBeDefined();
    expect(attr.value).toBeInstanceOf(Uint8Array);
    expect(attr.size).toBe(4);
    expect(attr.normalized).toBe(true);
    expect(rgbaAt(attr.value, 0)).toEqual(BLUE); // 0   → domain start
    expect(rgbaAt(attr.value, 1)).toEqual(TEAL); // 12.5 → blue→green midpoint
    expect(rgbaAt(attr.value, 2)).toEqual(GREEN); // 25  → middle stop exactly
    expect(rgbaAt(attr.value, 3)).toEqual(RED); // 50  → domain end
  });

  it('clamps values outside rampDomain to the end colors', async () => {
    const layer = await makePointLayer({
      rampProperty: 'dbz',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    const buf = sub.props.data.attributes.getFillColor.value as Uint8Array;
    expect(rgbaAt(buf, 4)).toEqual(BLUE); // -10 clamps to domain start
    expect(rgbaAt(buf, 5)).toEqual(RED); // 60 clamps to domain end
  });

  it('defaults rampDomain to [0,1] when explicitly passed undefined (defaultProps-shadow gotcha)', async () => {
    const layer = await makePointLayer({
      rampProperty: 'dbz',
      rampDomain: undefined,
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    const buf = sub.props.data.attributes.getFillColor.value as Uint8Array;
    expect(rgbaAt(buf, 0)).toEqual(BLUE); // 0  → start of [0,1]
    expect(rgbaAt(buf, 2)).toEqual(RED); // 25 ≫ 1 clamps to the end
  });
});

describe('AnimatedPointLayer rampProperty — precedence', () => {
  it('wins over the categorical fillColor + colorMapping (CPU) path', async () => {
    const layer = await makePointLayer({
      fillColor: 'band',
      colorMapping: { low: [1, 2, 3, 255], high: [4, 5, 6, 255] },
      rampProperty: 'dbz',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    const attrs = sub.props.data.attributes;
    expect(rgbaAt(attrs.getFillColor.value, 0)).toEqual(BLUE); // ramp, not mapping
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(sub.props.useCategoryColor).toBe(false);
  });

  it('wins over the GPU categorical palette path (no colorMapping)', async () => {
    const layer = await makePointLayer({
      fillColor: 'band',
      rampProperty: 'dbz',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    const attrs = sub.props.data.attributes;
    expect(rgbaAt(attrs.getFillColor.value, 3)).toEqual(RED);
    expect(attrs.instanceCategoryIndex).toBeUndefined();
    expect(sub.props.useCategoryColor).toBe(false);
    expect(sub.props.categoryPalette).toBeUndefined();
  });

  it('loses to rgbColorColumns (baked per-point colors win over the ramp)', async () => {
    const tile = rampTile();
    tile.layers[0].features.numericProps['r'] = new Float32Array([
      10, 20, 30, 40, 50, 60,
    ]) as any;
    tile.layers[0].features.numericProps['g'] = new Float32Array([
      11, 21, 31, 41, 51, 61,
    ]) as any;
    tile.layers[0].features.numericProps['b'] = new Float32Array([
      12, 22, 32, 42, 52, 62,
    ]) as any;
    const layer = await makePointLayer({
      rgbColorColumns: ['r', 'g', 'b'],
      rampProperty: 'dbz',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, tile);
    const buf = sub.props.data.attributes.getFillColor.value as Uint8Array;
    expect(rgbaAt(buf, 0)).toEqual([10, 11, 12, 255]); // rgb columns, not ramp
  });
});

describe('AnimatedPointLayer rampProperty — fall-through & misconfiguration', () => {
  it('falls through to the constant fill when the tile lacks the column', async () => {
    const layer = await makePointLayer({
      fillColor: [10, 20, 30, 255],
      rampProperty: 'not_a_column',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    expect(sub.props.data.attributes.getFillColor).toBeUndefined();
    expect(sub.props.getFillColor).toEqual([10, 20, 30, 255]);
  });

  it('falls through to the GPU categorical path when the tile lacks the column', async () => {
    const layer = await makePointLayer({
      fillColor: 'band',
      rampProperty: 'not_a_column',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    expect(sub.props.data.attributes.instanceCategoryIndex).toBeDefined();
    expect(sub.props.useCategoryColor).toBe(true);
  });

  it('an empty rampColorRamp leaves the ramp inert and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makePointLayer({
      rampProperty: 'dbz',
      rampColorRamp: [],
    });
    const sub = buildSub(layer, rampTile());
    expect(sub.props.data.attributes.getFillColor).toBeUndefined();
    // Second prepare must not re-warn (warnOnce contract).
    buildSub(layer, rampTile());
    const rampWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes('rampColorRamp is empty'),
    );
    expect(rampWarns).toHaveLength(1);
  });

  it('a categorical column named as rampProperty warns and is ignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makePointLayer({
      fillColor: [10, 20, 30, 255],
      rampProperty: 'band',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const sub = buildSub(layer, rampTile());
    expect(sub.props.data.attributes.getFillColor).toBeUndefined();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('categorical')),
    ).toBe(true);
  });
});

describe('AnimatedPointLayer rampProperty — styleKey invalidation', () => {
  it('re-prepares when rampDomain changes (and reuses the cache when it does not)', async () => {
    const layer = await makePointLayer({
      rampProperty: 'dbz',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const tile = rampTile();
    const p1 = layer.prepareTile(tile, tile.layers[0]);
    expect(layer.prepareTile(tile, tile.layers[0])).toBe(p1); // cache hit
    layer.props = { ...layer.props, rampDomain: [0, 100] };
    const p2 = layer.prepareTile(tile, tile.layers[0]);
    expect(p2).not.toBe(p1);
    // dbz=25 is now the quarter point of [0,100] → blue→green midpoint.
    expect(rgbaAt(p2.data.attributes.getFillColor.value, 2)).toEqual(TEAL);
  });

  it('re-prepares when rampColorRamp stops change', async () => {
    const layer = await makePointLayer({
      rampProperty: 'dbz',
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const tile = rampTile();
    const p1 = layer.prepareTile(tile, tile.layers[0]);
    layer.props = {
      ...layer.props,
      rampColorRamp: [
        [255, 255, 255, 255],
        [0, 0, 0, 255],
      ],
    };
    const p2 = layer.prepareTile(tile, tile.layers[0]);
    expect(p2).not.toBe(p1);
    expect(rgbaAt(p2.data.attributes.getFillColor.value, 0)).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it('re-prepares when rampProperty is set or cleared', async () => {
    const layer = await makePointLayer({
      fillColor: [10, 20, 30, 255],
      rampDomain: [0, 50],
      rampColorRamp: RAMP,
    });
    const tile = rampTile();
    const p1 = layer.prepareTile(tile, tile.layers[0]);
    expect(p1.data.attributes.getFillColor).toBeUndefined();
    layer.props = { ...layer.props, rampProperty: 'dbz' };
    const p2 = layer.prepareTile(tile, tile.layers[0]);
    expect(p2).not.toBe(p1);
    expect(rgbaAt(p2.data.attributes.getFillColor.value, 0)).toEqual(BLUE);
    layer.props = { ...layer.props, rampProperty: null };
    const p3 = layer.prepareTile(tile, tile.layers[0]);
    expect(p3).not.toBe(p2);
    expect(p3.data.attributes.getFillColor).toBeUndefined();
  });
});
