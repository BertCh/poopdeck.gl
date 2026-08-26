// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTPointCloudLayer` driven for real — a stub `Scene` (the layer wants it only
 * for `scene.primitives` and `scene.pick`) plus the genuine
 * `PointPrimitiveCollection` the layer builds, which is constructible under Node
 * and stores real `Color`s. Same harness argument `time-filter-oracle.test.ts`
 * and `camera-apply.test.ts` make: only an actual render wants WebGL.
 *
 * Four things here are worth more than the line coverage:
 *
 *  - the **oracle sweep**. Cesium has no shader, so `setTime` IS the time
 *    filter; the sweep asserts the written alpha equals
 *    `timeFilterAlpha(mode, …)` for every mode at every playhead, which is what
 *    stops a local ramp from drifting in. (`test/time-filter-oracle.test.ts`
 *    owns the package-wide structural gate; this file owns the sweep for THIS
 *    layer, so the layer is covered whether or not it is later folded in there.)
 *  - **shade × alpha separation**: the per-frame alpha multiplies the baked
 *    shaded colour, and the RGB it rewrites is still the SHADED RGB. A layer
 *    that rebuilt the colour from the unshaded source every frame would pass
 *    every alpha assertion and silently un-light the cloud.
 *  - **build before teardown**: an empty rebuild must leave the previous cloud
 *    standing AND leave `timeOrigin` untouched.
 *  - **the shared scratch `Color` really is copied out** per point, and the
 *    skip-if-unchanged cache really does suppress redundant writes.
 */

import { describe, it, expect } from 'vitest';
import {
  Cartesian3,
  PointPrimitiveCollection,
  type PointPrimitive,
  type Scene,
} from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTPointCloudLayer } from '../src/cesium-point-cloud-layer';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const AMBIENT = 0.35;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function cloudTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const featureCount = startTimes.length;
  const features: BinaryFeatures = {
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
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'cloud',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

interface Stub {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  /** What the next `scene.pick` should return. */
  picked: unknown;
}

/** A `Scene` stub recording what the layer hands `scene.primitives`, plus pick. */
function stubScene(): Stub {
  const stub: Stub = {
    added: [],
    removed: [],
    picked: undefined,
    scene: undefined as unknown as Scene,
  };
  stub.scene = {
    primitives: {
      add<T>(p: T): T {
        stub.added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        stub.removed.push(p);
        return true;
      },
    },
    pick(): unknown {
      return stub.picked;
    },
  } as unknown as Scene;
  return stub;
}

/**
 * Wrap one primitive's `color` accessor so writes can be counted, delegating to
 * the prototype descriptor so Cesium's own clone-and-dirty semantics still run.
 * The count is what proves the `lastAlpha` cache suppresses redundant writes;
 * without it "skip when unchanged" is untestable from the outside, because the
 * observable colour is identical either way.
 */
function countColorWrites(pp: PointPrimitive): () => number {
  const desc = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(pp),
    'color',
  );
  expect(desc?.get && desc?.set).toBeTruthy(); // guards against a Cesium refactor
  let writes = 0;
  Object.defineProperty(pp, 'color', {
    configurable: true,
    get(): unknown {
      return desc!.get!.call(pp);
    },
    set(v: unknown) {
      writes++;
      desc!.set!.call(pp, v);
    },
  });
  return () => writes;
}

// ─── The mode matrix (same constants the package-wide oracle test sweeps) ────

const MODES: ReadonlyArray<{
  mode: TimeFilterMode;
  params: TimeFilterParams;
}> = [
  { mode: 'window', params: { windowHalf: 400 } },
  { mode: 'window', params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 } },
  { mode: 'wake', params: { wakeLength: 900 } },
  { mode: 'cumulative', params: { fadeIn: 0 } },
  { mode: 'cumulative', params: { fadeIn: 700 } },
  { mode: 'trail', params: { trailLength: 600, trailFade: 1 } },
  { mode: 'trail', params: { trailLength: 600, trailFade: 0.35 } },
  { mode: 'none', params: {} },
];

const TIME_OFFSET = 1_700_000_000_000;
const STARTS = [0, 120, 500, 999];
const ENDS = [40, 300, 900, 1200];
/**
 * A coprime stride across and beyond every feature, PLUS the exact boundary
 * instants — the stride alone never lands ON a `startTime`, the only place
 * `wake`/`trail` reach alpha 1.
 */
const PLAYHEADS: number[] = [];
for (let t = -600; t <= 1800; t += 37) PLAYHEADS.push(TIME_OFFSET + t);
for (const s of STARTS) PLAYHEADS.push(TIME_OFFSET + s);
for (const e of ENDS) PLAYHEADS.push(TIME_OFFSET + e);
for (const s of STARTS) PLAYHEADS.push(TIME_OFFSET + s + 900);

const SWEEP_TILE = (): Tile =>
  cloudTile([0, 0, 1, 1, 2, 2, 3, 3], STARTS, ENDS, {}, TIME_OFFSET);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('STTPointCloudLayer construction and teardown', () => {
  it('registers one PointPrimitiveCollection into scene.primitives immediately', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene);
    expect(stub.added).toHaveLength(1);
    expect(stub.added[0]).toBeInstanceOf(PointPrimitiveCollection);
    expect(layer.id).toBe('stt-cesium-point-cloud');
    expect(layer.hasNormals).toBe(false);
  });

  it('honours a caller-supplied id', () => {
    const stub = stubScene();
    expect(new STTPointCloudLayer(stub.scene, { id: 'lidar' }).id).toBe(
      'lidar',
    );
  });

  it('dispose removes exactly the collection it added and forgets its entries', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      normalColumn: 'normal',
    });
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: { normal: { value: new Float32Array([1, 0, 0]), size: 3 } },
    });
    layer.setTiles([tile]);
    expect(layer.hasNormals).toBe(true);
    layer.dispose();
    expect(stub.removed).toEqual([stub.added[0]]);
    expect(layer.hasNormals).toBe(false);
    // A pick after teardown still resolves the feature's PROPERTIES — those
    // come from the binary the scene handed back, which dispose has no say
    // over — but it can no longer resolve a COORDINATE, because that is the
    // one part of the answer the entry list owned and dispose dropped.
    stub.picked = {
      id: {
        layerId: layer.id,
        binary: tile.layers[0].features,
        featureIndex: 0,
      },
    };
    const after = layer.pick(1, 2);
    expect(after?.index).toBe(0);
    expect(after?.coordinate).toBeUndefined();
  });
});

describe('STTPointCloudLayer.setTiles', () => {
  it('builds one lit primitive per feature at its absolute ECEF position', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene);
    layer.setTiles([
      cloudTile([10, 20, 700, 30, 40, 0], [0, 0], [1, 1], {
        positionDimensions: 3,
        positions: new Float64Array([10, 20, 700, 30, 40, 0]),
      }),
    ]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    expect(collection.length).toBe(2);

    // Elevation is the whole point of this kind: the z column reaches the
    // position, not a uniform.
    const expected = GLOBE.project(10, 20, 700);
    const p = collection.get(0).position as Cartesian3;
    expect(p.x).toBeCloseTo(expected[0], 6);
    expect(p.y).toBeCloseTo(expected[1], 6);
    expect(p.z).toBeCloseTo(expected[2], 6);
    // …and it differs from the same lon/lat at ground level.
    const ground = GLOBE.project(10, 20, 0);
    expect(
      Math.hypot(p.x - ground[0], p.y - ground[1], p.z - ground[2]),
    ).toBeCloseTo(700, 3);
  });

  it('defaults pixelSize to 4 (a cloud is dense) and honours an override', () => {
    const a = stubScene();
    new STTPointCloudLayer(a.scene).setTiles([cloudTile([0, 0], [0], [1])]);
    expect((a.added[0] as PointPrimitiveCollection).get(0).pixelSize).toBe(4);

    const b = stubScene();
    new STTPointCloudLayer(b.scene, { pixelSize: 11 }).setTiles([
      cloudTile([0, 0], [0], [1]),
    ]);
    expect((b.added[0] as PointPrimitiveCollection).get(0).pixelSize).toBe(11);
  });

  it('attaches the { layerId, binary, featureIndex } pick id to every point', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, { id: 'lidar' });
    const tile = cloudTile([0, 0, 1, 1], [0, 0], [1, 1]);
    layer.setTiles([tile]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    for (let i = 0; i < 2; i++) {
      expect(collection.get(i).id).toEqual({
        layerId: 'lidar',
        binary: tile.layers[0].features,
        featureIndex: i,
      });
    }
  });

  it('bakes the Lambert shade into the primitive colour, alpha left to the filter', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      mode: 'none',
      color: { type: 'constant', color: [255, 255, 255, 255] },
    });
    layer.setTiles([
      cloudTile([0, 0, 1, 1], [0, 0], [1, 1], {
        vectorProps: {
          // up (fully lit) then east (perpendicular → the ambient floor)
          normal: { value: new Float32Array([0, 0, 1, 1, 0, 0]), size: 3 },
        },
      }),
    ]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    expect(collection.get(0).color.red).toBeCloseTo(1, 12);
    expect(collection.get(1).color.red).toBeCloseTo(AMBIENT, 12);
    expect(collection.get(1).color.alpha).toBe(1); // shading never touches A
    expect(layer.hasNormals).toBe(true);
  });

  it('REPLACES the cloud on a non-empty rebuild', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene);
    layer.setTiles([cloudTile([0, 0, 1, 1, 2, 2], [0, 0, 0], [1, 1, 1])]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    expect(collection.length).toBe(3);
    layer.setTiles([cloudTile([5, 5], [0], [1])]);
    expect(collection.length).toBe(1);
    expect(stub.added).toHaveLength(1); // never a second collection
  });

  it('bails on an empty rebuild BEFORE tearing down, keeping the old cloud and timeOrigin', () => {
    // The "tiles genuinely in view flash out" symptom: selection reports an
    // empty visible set between a viewport change and the first decoded tile.
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      mode: 'window',
      timeFilter: { windowHalf: 100 },
    });
    layer.setTiles([
      cloudTile([0, 0, 1, 1], [0, 0], [10, 10], {}, TIME_OFFSET),
    ]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    layer.setTime(TIME_OFFSET);
    expect(collection.get(0).color.alpha).toBe(1);

    layer.setTiles([]); // nothing decoded yet
    expect(collection.length).toBe(2); // old primitives still standing
    // …and the old origin survived: a rebased playhead still lights them.
    layer.setTime(TIME_OFFSET + 5);
    expect(collection.get(0).color.alpha).toBe(1);
    layer.setTime(TIME_OFFSET + 5000);
    expect(collection.get(0).color.alpha).toBe(0);

    // A tile set with no POINT features is empty for this layer too.
    layer.setTiles([
      cloudTile([0, 0, 1, 1], [0], [1], {
        geometryType: GeometryType.LineString,
      }),
    ]);
    expect(collection.length).toBe(2);
  });
});

describe('STTPointCloudLayer.setTime derives alpha from the core oracle', () => {
  it('writes exactly `timeFilterAlpha` into every point, for every mode', () => {
    for (const { mode, params } of MODES) {
      const stub = stubScene();
      const layer = new STTPointCloudLayer(stub.scene, {
        mode,
        timeFilter: params,
      });
      layer.setTiles([SWEEP_TILE()]);
      const collection = stub.added[0] as PointPrimitiveCollection;
      expect(collection.length).toBe(STARTS.length);

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        for (let i = 0; i < STARTS.length; i++) {
          // The default colour is opaque, so the written alpha IS the oracle's
          // value — no tolerance. An inlined ramp goes red on the first
          // fractional sample, not only at the extremes.
          expect(collection.get(i).color.alpha).toBe(
            timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
          );
        }
      }
    }
  });

  it('multiplies the oracle alpha by the BASE alpha — and by nothing else', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      mode: 'window',
      timeFilter: { windowHalf: 400, fadeIn: 250 },
      color: { type: 'constant', color: [10, 20, 30, 128] },
    });
    layer.setTiles([cloudTile([0, 0], [200], [600], {}, TIME_OFFSET)]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    const base = 128 / 255;
    for (const absoluteMs of PLAYHEADS) {
      layer.setTime(absoluteMs);
      expect(collection.get(0).color.alpha).toBe(
        base *
          timeFilterAlpha('window', absoluteMs - TIME_OFFSET, 200, 600, {
            windowHalf: 400,
            fadeIn: 250,
          }),
      );
    }
  });

  it('does NOT let the shade dim the alpha — a dark point is opaque, not faded', () => {
    // shade × alpha would look like a plausible "lit" formula and is wrong:
    // an unlit surface is still there.
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, { mode: 'none' });
    layer.setTiles([
      cloudTile([0, 0], [0], [1], {
        vectorProps: {
          normal: { value: new Float32Array([0, 0, -1]), size: 3 }, // back-facing
        },
      }),
    ]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    layer.setTime(500);
    expect(collection.get(0).color.red).toBeCloseTo((200 / 255) * AMBIENT, 12);
    expect(collection.get(0).color.alpha).toBe(1);
  });

  it('rewrites the SHADED rgb every frame, never the unshaded source colour', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      mode: 'window',
      timeFilter: { windowHalf: 400, fadeIn: 200 },
      color: { type: 'constant', color: [255, 255, 255, 255] },
    });
    layer.setTiles([
      cloudTile([0, 0], [0], [1000], {
        vectorProps: {
          normal: { value: new Float32Array([1, 0, 0]), size: 3 },
        },
      }),
    ]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    for (const t of [0, 137, 400, 900]) {
      layer.setTime(t);
      expect(collection.get(0).color.red).toBeCloseTo(AMBIENT, 12);
      expect(collection.get(0).color.green).toBeCloseTo(AMBIENT, 12);
      expect(collection.get(0).color.blue).toBeCloseTo(AMBIENT, 12);
    }
  });

  it('rebases the playhead through the build timeOrigin, not the raw epoch', () => {
    // A layer that forgot the rebase would still "use the oracle" while feeding
    // it absolute ms — every point permanently dark.
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      mode: 'wake',
      timeFilter: { wakeLength: 1000 },
    });
    layer.setTiles([
      cloudTile([0, 0], [0], [100], {}, TIME_OFFSET),
      cloudTile([1, 1], [0], [100], {}, TIME_OFFSET + 3000),
    ]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    layer.setTime(TIME_OFFSET + 3500);
    expect(collection.get(1).color.alpha).toBe(0.5); // rebased to start 3000
    expect(collection.get(0).color.alpha).toBe(0); // 3500 ms old, past the wake
  });

  it('copies the shared scratch Color out per point, so alphas do not collapse', () => {
    // One module-level scratch is reused for every write; a primitive that
    // stored the REFERENCE would report the last point's alpha for all of them.
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      mode: 'window',
      // fadeIn must outrun the window's LEADING edge for the three points to
      // land on three DISTINCT alphas: `windowAlpha` ages a feature from
      // `cur + windowHalf`, not from `cur`, so a fadeIn <= 2 x windowHalf
      // would have every one of them already fully faded in — and the test
      // would pass its scratch-aliasing check vacuously.
      timeFilter: { windowHalf: 400, fadeIn: 1000 },
    });
    layer.setTiles([
      cloudTile([0, 0, 1, 1, 2, 2], [0, 200, 400], [0, 200, 400], {}, 0),
    ]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    layer.setTime(400);
    const alphas = [0, 1, 2].map((i) => collection.get(i).color.alpha);
    expect(new Set(alphas).size).toBe(3);
    // (800 - start) / 1000 — the YOUNGEST point is the dimmest, and the last
    // one written is not the one every primitive reports.
    expect(alphas[0]).toBeCloseTo(0.8, 12);
    expect(alphas[1]).toBeCloseTo(0.6, 12);
    expect(alphas[2]).toBeCloseTo(0.4, 12);
  });

  it('skips the colour setter for a point whose alpha is unchanged', () => {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, {
      mode: 'window',
      timeFilter: { windowHalf: 100 },
    });
    layer.setTiles([cloudTile([0, 0], [500], [500])]);
    const collection = stub.added[0] as PointPrimitiveCollection;
    const writes = countColorWrites(collection.get(0));

    layer.setTime(5000); // far outside → alpha 0, and lastAlpha starts NaN
    expect(writes()).toBe(1); // the first frame always writes
    layer.setTime(5100); // still 0
    layer.setTime(5200);
    expect(writes()).toBe(1); // …and never re-dirties the GPU buffer
    layer.setTime(500); // inside the window → a real change
    expect(writes()).toBe(2);
    expect(collection.get(0).color.alpha).toBe(1);
  });
});

describe('STTPointCloudLayer.pick', () => {
  function pickable(): { stub: Stub; layer: STTPointCloudLayer; tile: Tile } {
    const stub = stubScene();
    const layer = new STTPointCloudLayer(stub.scene, { id: 'lidar' });
    const tile = cloudTile([10, 20, 30, 40], [0, 0], [1, 1], {
      numericProps: { intensity: new Float32Array([7, 9]) },
    });
    layer.setTiles([tile]);
    return { stub, layer, tile };
  }

  it('resolves the feature properties and the source lon/lat', () => {
    const { stub, layer, tile } = pickable();
    stub.picked = {
      id: {
        layerId: 'lidar',
        binary: tile.layers[0].features,
        featureIndex: 1,
      },
    };
    const result = layer.pick(12, 34);
    expect(result).not.toBeNull();
    expect(result!.layerId).toBe('lidar');
    expect(result!.index).toBe(1);
    expect(result!.coordinate).toEqual([30, 40]); // lon/lat, not ECEF
    expect(result!.screen).toEqual([12, 34]);
    expect(result!.object).toMatchObject({ intensity: 9 });
  });

  it('returns null for nothing picked and for another layer id', () => {
    const { stub, layer, tile } = pickable();
    stub.picked = undefined;
    expect(layer.pick(1, 1)).toBeNull();
    stub.picked = {
      id: {
        layerId: 'some-other-layer',
        binary: tile.layers[0].features,
        featureIndex: 0,
      },
    };
    expect(layer.pick(1, 1)).toBeNull();
    stub.picked = { primitive: {} }; // a Cesium hit with no STT id
    expect(layer.pick(1, 1)).toBeNull();
  });
});
