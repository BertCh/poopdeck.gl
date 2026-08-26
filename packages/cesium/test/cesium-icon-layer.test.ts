// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTIconLayer` against a stub `Scene` and a REAL Cesium `BillboardCollection`.
 * Cesium loads fine under Node — what does not work is anything needing a live
 * WebGL context (a real Scene, a render pass, the texture-atlas bake). Collection
 * construction, `add`, the primitive setters and `removeAll` all work, so the
 * layer is exercised for real here; only the pixels are unverified.
 *
 * Two things are asserted through a thin wrapper rather than off the primitive:
 *  - `imageSubRegion` has no public getter in Cesium 26 (it moved inside
 *    `BillboardTexture`), so the options handed to `add` are captured;
 *  - per-frame WRITE COUNTS, via an own-property accessor shadowing the
 *    prototype's `color` — that is how "skip when the alpha is unchanged" is
 *    proven rather than assumed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BillboardCollection,
  BoundingRectangle,
  Cartesian3,
  Color,
  HorizontalOrigin,
  VerticalOrigin,
} from 'cesium';
import type { Billboard, Scene } from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { timeFilterAlpha } from '@poopdeck.gl/core/time-filter';
import { STTIconLayer } from '../src/cesium-icon-layer';
import type { IconMappingEntry } from '../src/lib/icons';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

// ── fixtures ────────────────────────────────────────────────────────────────

function pointFeatures(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): BinaryFeatures {
  const featureCount = startTimes.length;
  return {
    featureCount,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
}

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features: pointFeatures(
          positions,
          startTimes,
          endTimes,
          partial,
          timeOffset,
        ),
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  removeResult: { value: boolean };
  picked: { value: unknown };
}

function stubScene(): StubScene {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const removeResult = { value: true };
  const picked: { value: unknown } = { value: undefined };
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        removed.push(p);
        return removeResult.value;
      },
    },
    pick(): unknown {
      return picked.value;
    },
  } as unknown as Scene;
  return { scene, added, removed, removeResult, picked };
}

function collectionOf(s: StubScene): BillboardCollection {
  return s.added[0] as BillboardCollection;
}

/**
 * The caller-supplied atlas. A plain object standing in for a decoded image:
 * the layer never inspects it beyond `height`, and Cesium only needs it to be
 * *something* it can hand its texture atlas (which never bakes here — there is
 * no GL context).
 */
const ATLAS = {
  src: 'sprites.png',
  width: 128,
  height: 256,
} as unknown as HTMLImageElement;

/** 32×48 at the atlas top-left; 32×32 one row down. */
const MAPPING: Record<string, IconMappingEntry> = {
  marker: { x: 0, y: 0, width: 32, height: 48 },
  tug: { x: 32, y: 48, width: 32, height: 32 },
  pin: { x: 64, y: 0, width: 32, height: 48, anchorY: 48 },
};

const ATLAS_OPTS = { atlas: ATLAS, iconMapping: MAPPING, atlasHeight: 256 };

/**
 * Capture the options the layer hands `BillboardCollection.add` while still
 * building the REAL billboards — the only way to see `imageSubRegion`, which
 * Cesium 26 exposes no getter for.
 */
function captureAdds(
  collection: BillboardCollection,
): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  const real = collection.add.bind(collection);
  collection.add = ((options: Record<string, unknown>): Billboard => {
    calls.push(options);
    return real(options as never);
  }) as typeof collection.add;
  return calls;
}

/** Replace one billboard's `color` accessor with a counting own-property. */
function countColorWrites(bb: Billboard): { n: number; last: Color } {
  const state = { n: 0, last: new Color() };
  Object.defineProperty(bb, 'color', {
    configurable: true,
    get(): Color {
      return state.last;
    },
    set(v: Color): void {
      state.n += 1;
      state.last = Color.clone(v, state.last); // COPIES, like Cesium's setter
    },
  });
  return state;
}

// ── construction ────────────────────────────────────────────────────────────

describe('STTIconLayer construction', () => {
  it('registers one BillboardCollection into scene.primitives', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    expect(s.added).toHaveLength(1);
    expect(collectionOf(s)).toBeInstanceOf(BillboardCollection);
    expect(collectionOf(s).length).toBe(0);
    expect(layer.id).toBe('stt-cesium-icons');
  });

  it('honours an explicit id', () => {
    const s = stubScene();
    expect(new STTIconLayer(s.scene, { ...ATLAS_OPTS, id: 'vessels' }).id).toBe(
      'vessels',
    );
  });
});

// ── setTiles ────────────────────────────────────────────────────────────────

describe('STTIconLayer setTiles', () => {
  it('adds one billboard per Point feature at its absolute ECEF position', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    layer.setTiles([pointTile([10, 45, -30, -12], [0, 5], [10, 15])]);

    const c = collectionOf(s);
    expect(c.length).toBe(2);
    const expected = GLOBE.project(10, 45, 0);
    expect(c.get(0).position.x).toBeCloseTo(expected[0], 6);
    expect(c.get(0).position.y).toBeCloseTo(expected[1], 6);
    expect(c.get(0).position.z).toBeCloseTo(expected[2], 6);
    expect(c.get(0).position).toBeInstanceOf(Cartesian3);
  });

  it('points every billboard at the SAME atlas image', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    const calls = captureAdds(collectionOf(s));
    layer.setTiles([pointTile([0, 0, 1, 1], [0, 0], [1, 1])]);
    expect(calls.map((o) => o.image)).toEqual([ATLAS, ATLAS]);
  });

  it('addresses the sprite with a bottom-left BoundingRectangle (the y-flip)', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    const calls = captureAdds(collectionOf(s));
    layer.setTiles([pointTile([0, 0], [0], [1])]);

    const sub = calls[0].imageSubRegion as BoundingRectangle;
    expect(sub).toBeInstanceOf(BoundingRectangle);
    // marker is 32×48 with its TOP at y=0 in a 256-tall atlas ⇒ bottom at 208.
    expect([sub.x, sub.y, sub.width, sub.height]).toEqual([0, 208, 32, 48]);
  });

  it('scales by the sprite native size, honouring sizeBasis', () => {
    const s = stubScene();
    const byHeight = new STTIconLayer(s.scene, { ...ATLAS_OPTS, size: 24 });
    byHeight.setTiles([pointTile([0, 0], [0], [1])]);
    expect(collectionOf(s).get(0).scale).toBeCloseTo(24 / 48, 12);

    const s2 = stubScene();
    const byWidth = new STTIconLayer(s2.scene, {
      ...ATLAS_OPTS,
      size: 24,
      sizeBasis: 'width',
    });
    byWidth.setTiles([pointTile([0, 0], [0], [1])]);
    expect(collectionOf(s2).get(0).scale).toBeCloseTo(24 / 32, 12);
  });

  it('turns an off-centre anchor into a scaled pixelOffset', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      icon: 'pin', // anchorY = 48 (the sprite's foot)
      size: 24, // scale = 24/48 = 0.5
    });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    const bb = collectionOf(s).get(0);
    expect(bb.pixelOffset.x).toBeCloseTo(0, 12);
    // (48/2 − 48) sprite px × 0.5 scale = −12 screen px (up).
    expect(bb.pixelOffset.y).toBeCloseTo(-12, 12);
  });

  it('leaves a centre-anchored sprite at pixelOffset [0, 0]', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    const bb = collectionOf(s).get(0);
    expect(bb.pixelOffset.x).toBe(0);
    expect(bb.pixelOffset.y).toBe(0);
  });

  it('applies rotation in radians and defaults both origins to CENTER', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, { ...ATLAS_OPTS, angle: 90 });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    const bb = collectionOf(s).get(0);
    expect(bb.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(bb.horizontalOrigin).toBe(HorizontalOrigin.CENTER);
    expect(bb.verticalOrigin).toBe(VerticalOrigin.CENTER);
  });

  it('carries a per-feature rotation column (heading/COG) through to the quad', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      angleProperty: 'cog',
    });
    layer.setTiles([
      pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
        numericProps: { cog: new Float32Array([0, 180]) },
      }),
    ]);
    expect(collectionOf(s).get(0).rotation).toBeCloseTo(0, 12);
    expect(collectionOf(s).get(1).rotation).toBeCloseTo(Math.PI, 6);
  });

  it('tints white by default — the identity for Cesium texture modulation', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    const col = collectionOf(s).get(0).color;
    expect([col.red, col.green, col.blue, col.alpha]).toEqual([1, 1, 1, 1]);
  });

  it('selects the sprite per feature from a categorical column', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      iconProperty: 'vessel',
    });
    const calls = captureAdds(collectionOf(s));
    layer.setTiles([
      pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
        categoricalProps: {
          vessel: {
            indices: new Uint16Array([0, 1]),
            categories: ['marker', 'tug'],
          },
        },
      }),
    ]);
    const rects = calls.map((o) => o.imageSubRegion as BoundingRectangle);
    expect([rects[0].x, rects[0].y]).toEqual([0, 208]); // marker
    expect([rects[1].x, rects[1].y]).toEqual([32, 176]); // tug: 256 − (48 + 32)
  });

  it('forwards disableDepthTestDistance when asked', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect(collectionOf(s).get(0).disableDepthTestDistance).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('attaches the package-wide pick id to every billboard', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, { ...ATLAS_OPTS, id: 'vessels' });
    const tile = pointTile([0, 0, 1, 1], [0, 0], [1, 1]);
    layer.setTiles([tile]);
    expect(collectionOf(s).get(1).id).toEqual({
      layerId: 'vessels',
      binary: tile.layers[0].features,
      featureIndex: 1,
    });
  });

  it('replaces the previous sprite set wholesale on the next publish', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    layer.setTiles([pointTile([0, 0, 1, 1, 2, 2], [0, 0, 0], [1, 1, 1])]);
    expect(collectionOf(s).length).toBe(3);
    layer.setTiles([pointTile([5, 5], [0], [1])]);
    expect(collectionOf(s).length).toBe(1);
  });

  it('BUILDS BEFORE TEARING DOWN: an empty publish keeps the old sprites', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    layer.setTiles([pointTile([0, 0, 1, 1], [0, 0], [1, 1])]);
    layer.setTiles([]); // the decode-gap transient
    expect(collectionOf(s).length).toBe(2);
    layer.setTiles([
      // a tile with no Point layer is empty for THIS layer, same rule
      {
        id: { z: 5, x: 0, y: 0, t: 0 },
        timeRange: { start: 0, end: 1000 },
        layers: [
          {
            name: 'lines',
            extent: 0,
            features: pointFeatures([0, 0, 1, 1], [0], [1], {
              geometryType: GeometryType.LineString,
              startIndices: new Uint32Array([0, 2]),
            }),
            geometryExtensionName: 'geoarrow.linestring',
          },
        ],
      },
    ]);
    expect(collectionOf(s).length).toBe(2);
  });

  it('keeps the previous timeOrigin when a publish is empty', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 100 },
    });
    // origin 5000 ⇒ a feature live at relative t = 0.
    layer.setTiles([pointTile([0, 0], [0], [0], {}, 5_000)]);
    layer.setTiles([]);
    layer.setTime(5_000);
    expect(collectionOf(s).get(0).color.alpha).toBeCloseTo(1, 6);
  });
});

// ── the missing-atlas contract ──────────────────────────────────────────────

describe('STTIconLayer without an atlas', () => {
  it('draws NOTHING and warns ONCE when no atlas is supplied', () => {
    const s = stubScene();
    const onWarn = vi.fn();
    const layer = new STTIconLayer(s.scene, { iconMapping: MAPPING, onWarn });
    layer.setTiles([pointTile([0, 0, 1, 1], [0, 0], [1, 1])]);
    layer.setTiles([pointTile([2, 2], [0], [1])]);
    expect(collectionOf(s).length).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain('no `atlas`');
  });

  it('draws NOTHING and warns ONCE when no iconMapping is supplied', () => {
    const s = stubScene();
    const onWarn = vi.fn();
    const layer = new STTIconLayer(s.scene, {
      atlas: ATLAS,
      atlasHeight: 256,
      onWarn,
    });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect(collectionOf(s).length).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain('no `iconMapping`');
  });

  it('names both halves when both are missing', () => {
    const s = stubScene();
    const onWarn = vi.fn();
    new STTIconLayer(s.scene, { onWarn }).setTiles([
      pointTile([0, 0], [0], [1]),
    ]);
    expect(onWarn.mock.calls[0][0]).toContain('no `atlas`');
    expect(onWarn.mock.calls[0][0]).toContain('no `iconMapping`');
  });

  it('requires atlasHeight when the atlas is a URL it cannot measure', () => {
    const s = stubScene();
    const onWarn = vi.fn();
    const layer = new STTIconLayer(s.scene, {
      atlas: 'https://example.invalid/sprites.png',
      iconMapping: MAPPING,
      onWarn,
    });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect(collectionOf(s).length).toBe(0);
    expect(onWarn.mock.calls[0][0]).toContain('atlasHeight');
  });

  it('measures a decoded image itself, so atlasHeight is optional there', () => {
    const s = stubScene();
    const onWarn = vi.fn();
    const layer = new STTIconLayer(s.scene, {
      atlas: ATLAS,
      iconMapping: MAPPING,
      onWarn,
    });
    const calls = captureAdds(collectionOf(s));
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect(onWarn).not.toHaveBeenCalled();
    expect((calls[0].imageSubRegion as BoundingRectangle).y).toBe(208);
  });

  it('measures an un-laid-out <img> by naturalHeight, not its layout height', () => {
    // A decoded but never-rendered <img> reports height 0; the mapping is
    // measured against the DECODED pixel grid, so naturalHeight is the only
    // right answer and a 0 there would silently flip every sprite off the atlas.
    const s = stubScene();
    const onWarn = vi.fn();
    const layer = new STTIconLayer(s.scene, {
      atlas: {
        src: 'sprites.png',
        naturalHeight: 256,
        height: 0,
      } as unknown as HTMLImageElement,
      iconMapping: MAPPING,
      onWarn,
    });
    const calls = captureAdds(collectionOf(s));
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect(onWarn).not.toHaveBeenCalled();
    expect((calls[0].imageSubRegion as BoundingRectangle).y).toBe(208);
  });

  it('lets an explicit atlasHeight override what the image reports', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      atlas: ATLAS, // height 256
      iconMapping: MAPPING,
      atlasHeight: 512,
      onWarn: () => {},
    });
    const calls = captureAdds(collectionOf(s));
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect((calls[0].imageSubRegion as BoundingRectangle).y).toBe(464);
  });

  it('does not tear down previously drawn sprites when the atlas is absent', () => {
    // A layer built WITH an atlas never loses it (options are read-only), so
    // this is really a statement about ordering: the atlas gate returns before
    // `removeAll`, exactly like the empty-build gate above it.
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, { onWarn: () => {} });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect(collectionOf(s).length).toBe(0);
  });
});

describe('STTIconLayer with an unmapped sprite', () => {
  it('skips the feature, keeps the rest, and warns once per name', () => {
    const s = stubScene();
    const onWarn = vi.fn();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      iconProperty: 'vessel',
      onWarn,
    });
    const tile = pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
      categoricalProps: {
        vessel: {
          indices: new Uint16Array([0, 1]),
          categories: ['marker', 'ghost'], // 'ghost' is absent from MAPPING
        },
      },
    });
    layer.setTiles([tile]);
    expect(collectionOf(s).length).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain("'ghost'");

    layer.setTiles([tile]); // same offender — no second warning
    expect(collectionOf(s).length).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });
});

// ── setTime ─────────────────────────────────────────────────────────────────

describe('STTIconLayer setTime', () => {
  it('drives the tint alpha from the shared time-filter oracle', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 100, fadeOut: 100 },
    });
    layer.setTiles([pointTile([0, 0, 1, 1], [0, 300], [0, 300])]);
    const c = collectionOf(s);

    for (const t of [0, 50, 150, 300, 380]) {
      layer.setTime(t);
      for (const [i, start] of [0, 300].entries()) {
        const expected = timeFilterAlpha('window', t, start, start, {
          windowHalf: 100,
          fadeOut: 100,
        });
        expect(c.get(i).color.alpha).toBeCloseTo(expected, 6);
      }
    }
  });

  it('rebases the absolute playhead onto the build time origin', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 50 },
    });
    layer.setTiles([pointTile([0, 0], [0], [0], {}, 1_700_000_000_000)]);
    layer.setTime(1_700_000_000_000);
    expect(collectionOf(s).get(0).color.alpha).toBe(1);
    layer.setTime(1_700_000_000_000 + 500);
    expect(collectionOf(s).get(0).color.alpha).toBe(0);
  });

  it('multiplies the base tint alpha rather than replacing it', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      mode: 'none',
      color: { type: 'constant', color: [255, 255, 255, 128] },
    });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    layer.setTime(0);
    expect(collectionOf(s).get(0).color.alpha).toBeCloseTo(128 / 255, 6);
  });

  it('leaves the RGB channels alone while animating alpha', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      color: { type: 'constant', color: [10, 20, 30, 255] },
      mode: 'window',
      timeFilter: { windowHalf: 10 },
    });
    layer.setTiles([pointTile([0, 0], [0], [0])]);
    layer.setTime(1_000); // far outside the window
    const col = collectionOf(s).get(0).color;
    expect(col.red).toBeCloseTo(10 / 255, 6);
    expect(col.green).toBeCloseTo(20 / 255, 6);
    expect(col.blue).toBeCloseTo(30 / 255, 6);
    expect(col.alpha).toBe(0);
  });

  it('writes on the FIRST frame (lastAlpha starts NaN) then skips unchanged alphas', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 100 },
    });
    layer.setTiles([pointTile([0, 0], [0], [0])]);
    const counter = countColorWrites(collectionOf(s).get(0));

    layer.setTime(0); // alpha 1 — first frame always writes
    expect(counter.n).toBe(1);
    layer.setTime(10); // still inside the window: same alpha, no write
    layer.setTime(50);
    expect(counter.n).toBe(1);
    layer.setTime(1_000); // outside: alpha 0, one write
    expect(counter.n).toBe(2);
    layer.setTime(2_000); // still outside: unchanged, no write
    expect(counter.n).toBe(2);
  });

  it('keeps each billboard on its OWN colour — the scratch is never aliased', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, {
      ...ATLAS_OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 50 },
    });
    layer.setTiles([pointTile([0, 0, 1, 1], [0, 500], [0, 500])]);
    layer.setTime(0);
    const c = collectionOf(s);
    // If the layer handed both billboards the same Color object (or mutated
    // their internal `_color` in place) these would be equal — and the
    // animation would be frozen at whatever the last feature wrote.
    expect(c.get(0).color).not.toBe(c.get(1).color);
    expect(c.get(0).color.alpha).toBe(1);
    expect(c.get(1).color.alpha).toBe(0);
  });

  it('is a no-op before any tiles arrive', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    expect(() => layer.setTime(1_700_000_000_000)).not.toThrow();
    expect(collectionOf(s).length).toBe(0);
  });
});

// ── picking ─────────────────────────────────────────────────────────────────

describe('STTIconLayer pick', () => {
  it('resolves a hit to the shared SttPickResult, with the source lon/lat', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, { ...ATLAS_OPTS, id: 'vessels' });
    const tile = pointTile([10, 45, -30, -12], [0, 0], [1, 1], {
      numericProps: { mmsi: new Float32Array([111, 222]) },
    });
    layer.setTiles([tile]);
    s.picked.value = {
      id: {
        layerId: 'vessels',
        binary: tile.layers[0].features,
        featureIndex: 1,
      },
    };

    const hit = layer.pick(12, 34);
    expect(hit).not.toBeNull();
    expect(hit?.index).toBe(1);
    expect(hit?.layerId).toBe('vessels');
    expect(hit?.coordinate).toEqual([-30, -12]);
    expect(hit?.screen).toEqual([12, 34]);
    expect(hit?.object).toMatchObject({ mmsi: 222 });
  });

  it('returns null on a miss and on another layer’s primitive', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, { ...ATLAS_OPTS, id: 'vessels' });
    const tile = pointTile([0, 0], [0], [1]);
    layer.setTiles([tile]);

    s.picked.value = undefined;
    expect(layer.pick(1, 2)).toBeNull();
    s.picked.value = {};
    expect(layer.pick(1, 2)).toBeNull();
    s.picked.value = {
      id: {
        layerId: 'somebody-else',
        binary: tile.layers[0].features,
        featureIndex: 0,
      },
    };
    expect(layer.pick(1, 2)).toBeNull();
  });
});

// ── dispose ─────────────────────────────────────────────────────────────────

describe('STTIconLayer dispose', () => {
  it('removes the collection from the scene and drops its entries', () => {
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    layer.dispose();
    expect(s.removed).toEqual([collectionOf(s)]);
    // Entries are gone, so a later frame touches nothing (and does not throw).
    expect(() => layer.setTime(0)).not.toThrow();
  });

  it('destroys the collection itself when the scene no longer holds it', () => {
    // `primitives.remove` returning false means the collection was already
    // detached — nobody else will release the texture atlas Cesium built from
    // the caller's image, so the layer must.
    const s = stubScene();
    const layer = new STTIconLayer(s.scene, ATLAS_OPTS);
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    const collection = collectionOf(s);
    s.removeResult.value = false;
    layer.dispose();
    expect(collection.isDestroyed()).toBe(true);
  });

  it('never destroys the caller-owned atlas image', () => {
    const s = stubScene();
    const atlas = { src: 'sprites.png', width: 128, height: 256 };
    const layer = new STTIconLayer(s.scene, {
      atlas: atlas as unknown as HTMLImageElement,
      iconMapping: MAPPING,
    });
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    layer.dispose();
    expect(atlas).toEqual({ src: 'sprites.png', width: 128, height: 256 });
  });
});
