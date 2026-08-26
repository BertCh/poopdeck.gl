// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTIsoLayer` — the `isoLines` kind.
 *
 * Two halves, and they are tested differently on purpose:
 *
 *   1. The LEVEL math (`isoLevelOf` / `isoLevelExtent` / `isMajorLevel` /
 *      `partitionIsoPolylines` / `applyLevelColors`) is pure and Cesium-free, so
 *      it is exercised directly on plain data.
 *   2. The LAYER is constructed for real against a stub `Scene` — the
 *      collections it builds are genuine Cesium `Primitive`s, which load and
 *      behave under Node; only a live WebGL context is missing. That is enough
 *      to assert the thing this kind exists for: two width buckets, level-ramped
 *      colour, and the build-before-teardown ordering.
 *
 * `setTime` is a pure delegation to `STTBatchedPolylineLayer` (the oracle sweep
 * for that lives in `time-filter-oracle.test.ts`), but the delegation is only
 * worth anything if BOTH buckets receive it — so the alpha assertions below
 * compare the batch-table bytes of each bucket against `timeFilterAlpha`
 * directly.
 */

import { describe, it, expect } from 'vitest';
import { Cartesian2, Primitive, type Scene } from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { rampColorAt, type RGBA255 } from '@poopdeck.gl/core/style';
import { timeFilterAlpha } from '@poopdeck.gl/core/time-filter';
import { buildPathPolylines } from '../src/lib/polylines';
import {
  STTIsoLayer,
  DEFAULT_LEVEL_RAMP,
  applyLevelColors,
  isMajorLevel,
  isoLevelExtent,
  isoLevelOf,
  partitionIsoPolylines,
} from '../src/cesium-iso-layer';

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * `n` two-vertex contours strung along the equator, one per level. Every field
 * a decoded LineString tile carries is hand-constructed; `level` rides in
 * `numericProps` exactly as a real iso archive stores it.
 */
function contourTile(
  levels: number[],
  startTimes: number[] = levels.map(() => 0),
  endTimes: number[] = levels.map(() => 1000),
  timeOffset = 0,
  levelKey = 'level',
): Tile {
  const featureCount = levels.length;
  const positions: number[] = [];
  const startIndices: number[] = [];
  for (let f = 0; f < featureCount; f++) {
    startIndices.push(f * 2);
    positions.push(f * 0.1, 0, f * 0.1 + 0.05, 0.05);
  }
  startIndices.push(featureCount * 2);
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: { [levelKey]: new Float32Array(levels) },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'iso',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  };
}

/** A tile with NO level column at all — the fallback path. */
function unlevelledTile(): Tile {
  const t = contourTile([1, 2]);
  t.layers[0].features.numericProps = {};
  return t;
}

function stubScene(): {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  setPicked: (v: unknown) => void;
} {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  let picked: unknown;
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        removed.push(p);
        return true;
      },
    },
    pick(_c: Cartesian2): unknown {
      return picked;
    },
  } as unknown as Scene;
  return {
    scene,
    added,
    removed,
    setPicked: (v: unknown) => {
      picked = v;
    },
  };
}

/**
 * Stand in for the batch table, which only exists after a real GPU render.
 * The setter COPIES, like Cesium's — the layer writes one shared scratch
 * `Uint8Array` for every entry, so a stand-in that stored the reference would
 * report the last write for all of them.
 */
function armPrimitive(prim: Primitive): Map<unknown, Uint8Array> {
  const store = new Map<unknown, Uint8Array>();
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const bytes = new Uint8Array(4);
    store.set(id, bytes);
    return {
      get color(): Uint8Array {
        return bytes;
      },
      set color(v: Uint8Array) {
        bytes.set(v);
      },
    } as never;
  };
  return store;
}

/** The width baked into a `PolylineGeometry` at construction. */
function bakedWidth(prim: Primitive, instance = 0): number {
  const geom = (prim.geometryInstances as { geometry: unknown }[])[instance]
    .geometry as { _width: number };
  return geom._width;
}

function instanceColors(prim: Primitive): number[][] {
  return (
    prim.geometryInstances as {
      attributes: { color: { value: Uint8Array } };
    }[]
  ).map((i) => Array.from(i.attributes.color.value));
}

const prims = (added: unknown[]): Primitive[] => added as Primitive[];

// ── the pure level math ─────────────────────────────────────────────────────

describe('isoLevelOf', () => {
  it('reads the feature’s own iso value out of numericProps', () => {
    const build = buildPathPolylines([contourTile([5, 10, 15])]);
    expect(build.polylines.map((p) => isoLevelOf(p, 'level'))).toEqual([
      5, 10, 15,
    ]);
  });

  it('is undefined when the column is missing or the value is not finite', () => {
    const none = buildPathPolylines([unlevelledTile()]);
    expect(isoLevelOf(none.polylines[0], 'level')).toBeUndefined();

    const build = buildPathPolylines([contourTile([Number.NaN, 3])]);
    expect(isoLevelOf(build.polylines[0], 'level')).toBeUndefined();
    expect(isoLevelOf(build.polylines[1], 'level')).toBe(3);
    // A different column name is also just "missing".
    expect(isoLevelOf(build.polylines[1], 'elevation')).toBeUndefined();
  });
});

describe('isoLevelExtent', () => {
  it('spans the levels present', () => {
    const build = buildPathPolylines([contourTile([12, -4, 7])]);
    expect(isoLevelExtent(build.polylines, 'level')).toEqual([-4, 12]);
  });

  it('widens a single-valued set instead of returning a zero-width domain', () => {
    // A zero-width ramp domain is a divide-by-zero waiting to happen.
    const build = buildPathPolylines([contourTile([9, 9, 9])]);
    expect(isoLevelExtent(build.polylines, 'level')).toEqual([9, 10]);
  });

  it('is null when nothing carries a level', () => {
    const build = buildPathPolylines([unlevelledTile()]);
    expect(isoLevelExtent(build.polylines, 'level')).toBeNull();
    expect(isoLevelExtent([], 'level')).toBeNull();
  });
});

describe('isMajorLevel', () => {
  it('marks integer multiples of the interval', () => {
    expect(isMajorLevel(0, 5)).toBe(true);
    expect(isMajorLevel(10, 5)).toBe(true);
    expect(isMajorLevel(-15, 5)).toBe(true);
    expect(isMajorLevel(7, 5)).toBe(false);
  });

  it('tolerates f32 drift around an exact multiple', () => {
    // Levels ride in a Float32Array; an equality test would call this minor.
    const drifted = new Float32Array([25.000002])[0];
    expect(drifted).not.toBe(25);
    expect(isMajorLevel(drifted, 5)).toBe(true);
    // …but the tolerance is a FRACTION of the interval, not a free pass.
    expect(isMajorLevel(25.5, 5)).toBe(false);
    expect(isMajorLevel(25.5, 5, 0.2)).toBe(true);
  });

  it('never reports major without a usable level and interval', () => {
    expect(isMajorLevel(undefined, 5)).toBe(false);
    expect(isMajorLevel(Number.NaN, 5)).toBe(false);
    expect(isMajorLevel(10, 0)).toBe(false); // 0 = emphasis disabled
    expect(isMajorLevel(10, -5)).toBe(false);
    expect(isMajorLevel(10, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('partitionIsoPolylines', () => {
  it('splits into the two width buckets and keeps ONE time origin', () => {
    const build = buildPathPolylines([
      contourTile([0, 5, 10, 12, 20], undefined, undefined, 4_000),
    ]);
    const split = partitionIsoPolylines(build, {
      levelProperty: 'level',
      majorInterval: 10,
    });
    expect(split.major.polylines.map((p) => isoLevelOf(p, 'level'))).toEqual([
      0, 10, 20,
    ]);
    expect(split.minor.polylines.map((p) => isoLevelOf(p, 'level'))).toEqual([
      5, 12,
    ]);
    // Both primitives must animate off the same clock or they would drift apart.
    expect(split.minor.timeOrigin).toBe(build.timeOrigin);
    expect(split.major.timeOrigin).toBe(build.timeOrigin);
  });

  it('puts everything in minor when emphasis is off', () => {
    const build = buildPathPolylines([contourTile([0, 5, 10])]);
    const split = partitionIsoPolylines(build, {
      levelProperty: 'level',
      majorInterval: 0,
    });
    expect(split.minor.polylines).toHaveLength(3);
    expect(split.major.polylines).toHaveLength(0);
  });
});

describe('applyLevelColors', () => {
  it('maps each contour’s level through the ramp', () => {
    const build = buildPathPolylines([contourTile([0, 10, 20])]);
    const domain = [0, 20] as const;
    applyLevelColors(build.polylines, {
      type: 'ramp',
      property: 'level',
      domain,
      range: DEFAULT_LEVEL_RAMP,
      fallback: [0, 0, 0, 0],
    });
    for (const [i, level] of [0, 10, 20].entries()) {
      expect(build.polylines[i].color).toEqual(
        rampColorAt(level, domain, DEFAULT_LEVEL_RAMP),
      );
    }
    // The ends of the ramp really are different — otherwise this asserts nothing.
    expect(build.polylines[0].color).not.toEqual(build.polylines[2].color);
  });

  it('falls back when the level column is absent', () => {
    const build = buildPathPolylines([unlevelledTile()]);
    const fallback: RGBA255 = [1, 2, 3, 4];
    applyLevelColors(build.polylines, {
      type: 'ramp',
      property: 'level',
      domain: [0, 1],
      range: DEFAULT_LEVEL_RAMP,
      fallback,
    });
    expect(build.polylines[0].color).toEqual(fallback);
  });

  it('REPLACES the colour array rather than writing through it', () => {
    // buildPathPolylines' constant default hands every polyline the SAME array
    // instance; a colour pass that mutated in place would scribble on it (and,
    // with a caller-supplied constant mode, on the caller's own options object).
    const build = buildPathPolylines([contourTile([1, 2])]);
    const shared = build.polylines[0].color;
    expect(build.polylines[1].color).toBe(shared);
    const before = [...shared];

    applyLevelColors(build.polylines, {
      type: 'ramp',
      property: 'level',
      domain: [1, 2],
      range: DEFAULT_LEVEL_RAMP,
      fallback: [0, 0, 0, 0],
    });
    expect([...shared]).toEqual(before);
    expect(build.polylines[0].color).not.toBe(shared);
  });
});

// ── the layer ───────────────────────────────────────────────────────────────

describe('STTIsoLayer.setTiles', () => {
  it('builds ONE primitive per width bucket, each at its own baked width', () => {
    const { scene, added } = stubScene();
    const layer = new STTIsoLayer(scene, {
      majorInterval: 10,
      width: 2,
      majorWidth: 6,
    });
    layer.setTiles([contourTile([0, 5, 10, 12, 20])]);

    expect(added).toHaveLength(2);
    const [minor, major] = prims(added);
    expect(minor.geometryInstances).toHaveLength(2); // 5, 12
    expect(major.geometryInstances).toHaveLength(3); // 0, 10, 20
    // Width is baked into PolylineGeometry, which is the entire reason there
    // are two primitives instead of one.
    expect(bakedWidth(minor)).toBe(2);
    expect(bakedWidth(major)).toBe(6);
  });

  it('defaults major contours to twice the minor width', () => {
    const { scene, added } = stubScene();
    new STTIsoLayer(scene, { majorInterval: 10, width: 3 }).setTiles([
      contourTile([5, 10]),
    ]);
    expect(bakedWidth(prims(added)[1])).toBe(6);
  });

  it('builds a single bucket when emphasis is off (the default)', () => {
    const { scene, added } = stubScene();
    new STTIsoLayer(scene).setTiles([contourTile([0, 5, 10])]);
    expect(added).toHaveLength(1);
    expect(prims(added)[0].geometryInstances).toHaveLength(3);
  });

  it('colours each contour by its LEVEL, not by its identity', () => {
    const { scene, added } = stubScene();
    new STTIsoLayer(scene, { levelDomain: [0, 20] }).setTiles([
      contourTile([0, 10, 20]),
    ]);
    const colors = instanceColors(prims(added)[0]);
    for (const [i, level] of [0, 10, 20].entries()) {
      const want = rampColorAt(level, [0, 20], DEFAULT_LEVEL_RAMP);
      // Alpha is seeded to 0 — the first setTime writes the real one.
      expect(colors[i]).toEqual([want[0], want[1], want[2], 0]);
    }
    expect(colors[0].slice(0, 3)).not.toEqual(colors[2].slice(0, 3));
  });

  it('honours an explicit colour mode over the level ramp', () => {
    const { scene, added } = stubScene();
    new STTIsoLayer(scene, {
      color: { type: 'constant', color: [11, 22, 33, 255] },
      majorInterval: 10,
    }).setTiles([contourTile([5, 10])]);
    expect(instanceColors(prims(added)[0])[0]).toEqual([11, 22, 33, 0]);
    // …and the width split still follows the level.
    expect(instanceColors(prims(added)[1])[0]).toEqual([11, 22, 33, 0]);
    expect(prims(added)[1].geometryInstances).toHaveLength(1);
  });

  it('LATCHES an auto-domain so streaming tiles do not re-colour the map', () => {
    const { scene, added } = stubScene();
    const layer = new STTIsoLayer(scene); // no levelDomain → latch on first build
    layer.setTiles([contourTile([0, 10])]);
    const first = instanceColors(prims(added)[0]);
    expect(first[0].slice(0, 3)).toEqual(
      rampColorAt(0, [0, 10], DEFAULT_LEVEL_RAMP).slice(0, 3),
    );

    // A later tile widens the observed range; a recomputed domain would remap
    // level 10 from the ramp's TOP to its MIDDLE and visibly re-colour
    // everything already on screen.
    layer.setTiles([contourTile([0, 10, 20])]);
    const second = instanceColors(prims(added)[1]);
    expect(second[1].slice(0, 3)).toEqual(first[1].slice(0, 3));
    // 20 is off the latched top of the ramp, so it clamps to level 10's colour.
    expect(second[2].slice(0, 3)).toEqual(first[1].slice(0, 3));
  });

  it('keeps the standing contours when a build comes back EMPTY', () => {
    // Selection reports an empty visible set between a viewport change and the
    // first decoded tile of the new set; tearing down first turns that transient
    // into a blank frame.
    const { scene, added, removed } = stubScene();
    const layer = new STTIsoLayer(scene, { majorInterval: 10 });
    layer.setTiles([contourTile([5, 10])]);
    expect(added).toHaveLength(2);

    layer.setTiles([]);
    expect(added).toHaveLength(2); // nothing rebuilt
    expect(removed).toHaveLength(0); // and nothing torn down
  });

  it('CLEARS a bucket that a real, non-empty build left empty', () => {
    // The empty-bail is a layer-level rule about decode gaps. Once the overall
    // build is known non-empty, an empty bucket is the truth: this viewport has
    // no contours of that weight, and holding the old ones would draw stale
    // geometry the camera is still pointed at.
    const { scene, added, removed } = stubScene();
    const layer = new STTIsoLayer(scene, { majorInterval: 10 });
    layer.setTiles([contourTile([5, 10])]);
    const major = prims(added)[1];
    expect(major.geometryInstances).toHaveLength(1);

    layer.setTiles([contourTile([3, 7])]); // minor only
    expect(removed).toContain(major);
    expect(added).toHaveLength(3); // the rebuilt minor bucket, no new major
    expect(prims(added)[2].geometryInstances).toHaveLength(2);
  });

  it('survives tiles with no level column at all', () => {
    const { scene, added } = stubScene();
    new STTIsoLayer(scene, {
      majorInterval: 10,
      levelFallback: [9, 8, 7, 255],
    }).setTiles([unlevelledTile()]);
    expect(added).toHaveLength(1); // nothing can be major without a level
    expect(instanceColors(prims(added)[0])[0]).toEqual([9, 8, 7, 0]);
  });
});

describe('STTIsoLayer.setTime', () => {
  it('drives BOTH buckets through the shared time-filter oracle', () => {
    const { scene, added } = stubScene();
    // A constant colour with a NON-opaque base alpha, so the assertion pins
    // both halves of the batched layer's `base.a × timeFilterAlpha` product.
    const BASE_A = 204;
    const layer = new STTIsoLayer(scene, {
      majorInterval: 10,
      mode: 'window',
      timeFilter: { windowHalf: 400 },
      color: { type: 'constant', color: [10, 20, 30, BASE_A] },
    });
    const timeOffset = 1_700_000_000_000;
    layer.setTiles([contourTile([5, 10], [100, 100], [300, 300], timeOffset)]);
    const [minor, major] = prims(added);
    const minorStore = armPrimitive(minor);
    const majorStore = armPrimitive(major);

    for (const cur of [0, 120, 500, 999]) {
      layer.setTime(timeOffset + cur);
      const want = Math.round(
        (BASE_A / 255) *
          timeFilterAlpha('window', cur, 100, 300, { windowHalf: 400 }) *
          255,
      );
      for (const store of [minorStore, majorStore]) {
        expect(store.size).toBe(1);
        const [bytes] = [...store.values()];
        expect(bytes[3]).toBe(want);
      }
    }
    // Non-vacuous: the sweep really passed through a fractional alpha.
    expect(
      timeFilterAlpha('window', 999, 100, 300, { windowHalf: 400 }),
    ).toBeLessThan(1);
  });

  it('is inert before either primitive is ready', () => {
    const { scene } = stubScene();
    const layer = new STTIsoLayer(scene, { majorInterval: 10 });
    layer.setTiles([contourTile([5, 10])]);
    expect(() => layer.setTime(500)).not.toThrow();
  });
});

describe('STTIsoLayer.pick', () => {
  it('resolves a hit in either bucket and reports the PUBLIC layer id', () => {
    const { scene, added, setPicked } = stubScene();
    const layer = new STTIsoLayer(scene, { id: 'iso', majorInterval: 10 });
    layer.setTiles([contourTile([5, 10])]);

    // Level 5 is feature 0 (minor bucket), level 10 is feature 1 (major): the
    // reported index is the TILE feature index, not a position within a bucket.
    for (const [bucket, prim] of prims(added).entries()) {
      const id = (prim.geometryInstances as { id: unknown }[])[0].id;
      setPicked({ id });
      const hit = layer.pick(12, 34);
      expect(hit).not.toBeNull();
      // The `:minor` / `:major` sub-ids are an internal bucketing detail.
      expect(hit?.layerId).toBe('iso');
      expect(hit?.index).toBe(bucket);
      expect(hit?.screen).toEqual([12, 34]);
      expect(hit?.coordinate?.[0]).toBeCloseTo(bucket * 0.1, 10); // 1st vertex lon
      expect(hit?.coordinate?.[1]).toBeCloseTo(0, 10);
    }
  });

  it('returns null for nothing picked, and for another layer’s instance', () => {
    const { scene, setPicked } = stubScene();
    const layer = new STTIsoLayer(scene, { id: 'iso' });
    layer.setTiles([contourTile([5])]);

    setPicked(undefined);
    expect(layer.pick(1, 1)).toBeNull();
    setPicked({
      id: { layerId: 'somebody-else', binary: {}, featureIndex: 0 },
    });
    expect(layer.pick(1, 1)).toBeNull();
  });
});

describe('STTIsoLayer.dispose', () => {
  it('removes every primitive it put in the scene', () => {
    const { scene, added, removed } = stubScene();
    const layer = new STTIsoLayer(scene, { majorInterval: 10 });
    layer.setTiles([contourTile([5, 10])]);
    layer.dispose();
    expect(removed).toEqual(added);
  });

  it('is idempotent and leaves the layer re-usable', () => {
    const { scene, added } = stubScene();
    const layer = new STTIsoLayer(scene, { majorInterval: 10 });
    layer.setTiles([contourTile([5, 10])]);
    layer.dispose();
    expect(() => layer.dispose()).not.toThrow();
    layer.setTiles([contourTile([5, 10])]);
    expect(added).toHaveLength(4);
  });
});
