// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTFlowmapLayer` — the native `flowmap` kind.
 *
 * Cesium loads fine under Node; what does NOT is a real WebGL context, so the
 * scene is stubbed (`scene.primitives` + `scene.pick`) and the batch table —
 * which only exists after a real GPU render — is armed by hand. Everything
 * else is the REAL `PrimitiveCollection` / `Primitive` / `GeometryInstance` the
 * layer built.
 *
 * What is pinned, beyond the shared contract:
 *
 *  - **`setTiles` builds BEFORE it tears down** and bails on empty while the
 *    old arrows still stand — the "tiles genuinely in view flash out" rule.
 *  - **The TWO cadences.** Geometry is re-baked on a bucket sub-step crossing
 *    and NOT on every frame (a flowmap arrow's whole shape is value-driven, so
 *    the rebuild is the honest answer — and its cost is the thing that must not
 *    silently become per-frame). Alpha still moves every frame through the
 *    batch table.
 *  - **A quiet bucket draws NOTHING, and comes back.** Unlike `setTiles`, the
 *    bake tears down unconditionally: an all-below-`minFlow` hour is real data.
 *  - **A static (axis-free) archive bakes exactly once**, however far the
 *    playhead travels.
 *  - **The alpha IS the shared oracle.** `time-filter-oracle.test.ts` delegates
 *    this layer's proof here (its `PROVEN_IN_OWN_SUITE` map), so the sweep at
 *    the bottom pins every written batch-table byte to `timeFilterAlpha` across
 *    every mode, every window boundary and a coprime stride of playheads.
 */

import { describe, it, expect } from 'vitest';
import {
  GeometryInstance,
  Primitive,
  PrimitiveCollection,
  type Scene,
} from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTFlowmapLayer } from '../src/cesium-flowmap-layer';

const TIME_OFFSET = 1_700_000_000_000;

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  setPick(v: unknown): void;
}

function stubScene(): StubScene {
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
    pick(): unknown {
      return picked;
    },
  } as unknown as Scene;
  return {
    scene,
    added,
    removed,
    setPick(v: unknown) {
      picked = v;
    },
  };
}

interface ArmedAttr {
  bytes: Uint8Array;
  writes: number;
}

/**
 * Stand in for the batch table. The setter COPIES (like Cesium's), which
 * matters: the layer writes ONE shared scratch `Uint8Array` for every arrow, so
 * a stand-in storing the reference would report the last write for all of them.
 */
function armPrimitive(prim: Primitive): Map<unknown, ArmedAttr> {
  const store = new Map<unknown, ArmedAttr>();
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const slot: ArmedAttr = { bytes: new Uint8Array(4), writes: 0 };
    store.set(id, slot);
    return {
      get color(): Uint8Array {
        return slot.bytes;
      },
      set color(v: Uint8Array) {
        slot.bytes.set(v);
        slot.writes++;
      },
    } as never;
  };
  return store;
}

function collectionOf(layer: STTFlowmapLayer): PrimitiveCollection {
  return (layer as unknown as { collection: PrimitiveCollection }).collection;
}

/** The layer's single batched primitive, or null when the bucket is quiet. */
function primitiveOf(layer: STTFlowmapLayer): Primitive | null {
  const coll = collectionOf(layer);
  return coll.length === 0 ? null : (coll.get(0) as Primitive);
}

function instancesOf(layer: STTFlowmapLayer): GeometryInstance[] {
  const prim = primitiveOf(layer);
  if (!prim) return [];
  return (prim as unknown as { geometryInstances: GeometryInstance[] })
    .geometryInstances;
}

/** Arm whatever primitive is currently standing; returns its attribute store. */
function arm(layer: STTFlowmapLayer): Map<unknown, ArmedAttr> {
  const prim = primitiveOf(layer);
  expect(prim).not.toBeNull();
  return armPrimitive(prim as Primitive);
}

interface FlowTileSpec {
  lines: number[][];
  matrix?: number[][];
  numBuckets?: number;
  numericProps?: Record<string, Float32Array>;
  startTimes?: number[];
  endTimes?: number[];
  timeOffset?: number;
}

function flowTile(spec: FlowTileSpec): Tile {
  const timeOffset = spec.timeOffset ?? TIME_OFFSET;
  const featureCount = spec.lines.length;
  const startIndices = new Uint32Array(featureCount + 1);
  let total = 0;
  for (let f = 0; f < featureCount; f++) {
    startIndices[f] = total;
    total += spec.lines[f].length / 2;
  }
  startIndices[featureCount] = total;

  const positions = new Float64Array(total * 2);
  let p = 0;
  for (const line of spec.lines) for (const v of line) positions[p++] = v;

  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions,
    startIndices,
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(
      spec.startTimes ?? new Array(featureCount).fill(0),
    ),
    endTimes: new Float32Array(
      spec.endTimes ?? new Array(featureCount).fill(1000),
    ),
    timeOffset,
    numericProps: spec.numericProps ?? {},
    categoricalProps: {},
    vectorProps: {},
  };
  if (spec.matrix && spec.numBuckets) {
    const flat = new Float32Array(total * spec.numBuckets);
    for (let v = 0; v < spec.matrix.length; v++) {
      for (let b = 0; b < spec.numBuckets; b++) {
        flat[v * spec.numBuckets + b] = spec.matrix[v][b];
      }
    }
    features.vertexValueMatrix = flat;
    features.vertexValueBuckets = spec.numBuckets;
  }

  return {
    id: { z: 12, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'flows',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  } as Tile;
}

// Two OD flows over a 4-bucket day (bucketWidth = 250 ms).
//   flow 0 : [4, 9, 5, 0]   busy, then dead in the last bucket
//   flow 1 : [1, 0, 0, 0]   only in the first bucket
const ANIMATED = [
  flowTile({
    lines: [
      [10, 45, 10.4, 45.2],
      [12, 47, 12.4, 47.2],
    ],
    numBuckets: 4,
    matrix: [
      [4, 9, 1, 0],
      [2, 3, 5, 0],
      [1, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  }),
];

const STATIC = [
  flowTile({
    lines: [[10, 45, 10.4, 45.2]],
    numericProps: { trips: new Float32Array([9]) },
  }),
];

// Bucket b starts at TIME_OFFSET + b * 250. Default rebuildStep is 0.5.
const atBucket = (b: number): number => TIME_OFFSET + b * 250;

describe('STTFlowmapLayer — construction and lifecycle', () => {
  it('registers a PrimitiveCollection into scene.primitives immediately', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    expect(s.added).toHaveLength(1);
    expect(s.added[0]).toBeInstanceOf(PrimitiveCollection);
    expect(layer.id).toBe('stt-cesium-flowmap');
  });

  it('honours an explicit id', () => {
    const s = stubScene();
    expect(new STTFlowmapLayer(s.scene, { id: 'commutes' }).id).toBe(
      'commutes',
    );
  });

  it('dispose removes exactly the collection it added and drops its entries', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    layer.dispose();
    expect(s.removed).toEqual([s.added[0]]);
    expect(collectionOf(layer).length).toBe(0);
    // The pure build (the per-flow magnitude rows the collection cannot free)
    // is dropped too, so a stray setTime after dispose is inert.
    expect((layer as unknown as { build: unknown }).build).toBeNull();
    expect(() => layer.setTime(atBucket(1))).not.toThrow();
  });
});

describe('STTFlowmapLayer — setTiles', () => {
  it('bakes one arrow instance per flow that is moving at the current bucket', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    // Bucket 0: flow 0 (mag 4) and flow 1 (mag 1) both move.
    expect(instancesOf(layer)).toHaveLength(2);
  });

  it('builds real triangle geometry — a tapered ribbon, not a polyline', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, { shaftSegments: 4 });
    layer.setTiles(ANIMATED);
    const geom = instancesOf(layer)[0].geometry as {
      indices: Uint16Array;
      attributes: { position: { values: Float64Array } };
    };
    expect(geom.indices.length).toBe(4 * 6 + 3); // shaft quads + the head triangle
    expect(geom.attributes.position.values.length / 3).toBe(2 * 5 + 3);
  });

  it('bails on an empty build while the previous arrows are still standing', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    const before = primitiveOf(layer);
    layer.setTiles([]);
    // Same primitive object: nothing was torn down. A transient empty selection
    // between a viewport change and the first decoded tile must not blank the map.
    expect(primitiveOf(layer)).toBe(before);
    expect(instancesOf(layer)).toHaveLength(2);
  });

  it('attaches the { layerId, binary, featureIndex } pick id to every instance', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, { id: 'commutes' });
    layer.setTiles(ANIMATED);
    const ids = instancesOf(layer).map(
      (gi) => gi.id as { layerId: string; featureIndex: number },
    );
    expect(ids.map((i) => i.layerId)).toEqual(['commutes', 'commutes']);
    expect(ids.map((i) => i.featureIndex)).toEqual([0, 1]);
  });
});

describe('STTFlowmapLayer — the two cadences', () => {
  it('re-bakes the geometry when the playhead crosses a bucket sub-step', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    const atZero = primitiveOf(layer);

    layer.setTime(atBucket(0)); // same sub-step as the setTiles bake
    expect(primitiveOf(layer)).toBe(atZero);

    layer.setTime(atBucket(1)); // crossed two sub-steps → a fresh Primitive
    const atOne = primitiveOf(layer);
    expect(atOne).not.toBe(atZero);
    // Bucket 1: only flow 0 is still moving (flow 1 has fallen to zero).
    expect(instancesOf(layer)).toHaveLength(1);
  });

  it('does NOT re-bake for a sub-bucket frame — the rebuild is not per frame', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    layer.setTime(atBucket(1));
    const baked = primitiveOf(layer);
    // 250 ms per bucket, 0.5-bucket step → anything inside ±62 ms is the same step.
    for (const dt of [1, 10, 30, 60]) {
      layer.setTime(atBucket(1) + dt);
      expect(primitiveOf(layer)).toBe(baked);
    }
  });

  it('rebuildStep widens the gate: a whole-bucket step ignores the half-bucket crossing', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, { rebuildStep: 1 });
    layer.setTiles(ANIMATED);
    layer.setTime(atBucket(0));
    const baked = primitiveOf(layer);
    // 100 ms is 0.4 of a bucket: a crossing at the 0.5 step, not at the 1 step.
    layer.setTime(atBucket(0) + 100);
    expect(primitiveOf(layer)).toBe(baked);
    layer.setTime(atBucket(1));
    expect(primitiveOf(layer)).not.toBe(baked);
  });

  it('bakes exactly ONCE for a static, axis-free archive', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(STATIC);
    const baked = primitiveOf(layer);
    for (const t of [0, TIME_OFFSET, TIME_OFFSET + 86_400_000]) {
      layer.setTime(t);
      expect(primitiveOf(layer)).toBe(baked);
    }
  });

  it('draws nothing through a genuinely quiet bucket, and brings the arrows back', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    layer.setTime(atBucket(3)); // every flow is 0 here
    expect(collectionOf(layer).length).toBe(0);
    expect(primitiveOf(layer)).toBeNull();
    // The bucket gate is checked BEFORE the ready guard, so a null primitive
    // does not wedge the layer.
    layer.setTime(atBucket(1));
    expect(instancesOf(layer)).toHaveLength(1);
  });
});

describe('STTFlowmapLayer — per-frame alpha through the batch table', () => {
  it('writes the base RGB with the oracle alpha, once per changed frame', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, {
      mode: 'window',
      timeFilter: { windowHalf: 400 },
    });
    layer.setTiles(ANIMATED);
    const store = arm(layer);
    layer.setTime(atBucket(0)); // cur = 0, inside every feature's [0, 1000]
    const slots = instancesOf(layer).map((gi) => store.get(gi.id) as ArmedAttr);
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.writes).toBe(1);
      expect(slot.bytes[3]).toBeGreaterThan(0);
    }
  });

  it('skips an unchanged alpha rather than dirtying the GPU buffer', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, { mode: 'none' });
    layer.setTiles(ANIMATED);
    const store = arm(layer);
    layer.setTime(atBucket(0));
    const slot = store.get(instancesOf(layer)[0].id) as ArmedAttr;
    expect(slot.writes).toBe(1);
    layer.setTime(atBucket(0) + 5); // same sub-step, same alpha
    expect(slot.writes).toBe(1);
  });

  it('gives a busier bucket a stronger alpha than a quieter one', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, { mode: 'none' });
    layer.setTiles(ANIMATED);
    const atZero = arm(layer);
    layer.setTime(atBucket(0));
    const quiet = (atZero.get(instancesOf(layer)[0].id) as ArmedAttr).bytes[3];

    layer.setTime(atBucket(1)); // flow 0 peaks at 9 here vs 4 at bucket 0
    const atOne = arm(layer); // a fresh Primitive needs a fresh batch table
    layer.setTime(atBucket(1) + 1);
    const busy = (atOne.get(instancesOf(layer)[0].id) as ArmedAttr).bytes[3];
    expect(busy).toBeGreaterThan(quiet);
  });

  it('is inert before the primitive is ready — no batch table to write into', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    expect(() => layer.setTime(atBucket(0))).not.toThrow();
  });
});

describe('STTFlowmapLayer — picking', () => {
  it('resolves a hit to the shared SttPickResult, coordinate at the ORIGIN', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, { id: 'commutes' });
    layer.setTiles(ANIMATED);
    s.setPick({ id: instancesOf(layer)[1].id });
    const hit = layer.pick(12, 34);
    expect(hit).not.toBeNull();
    expect(hit!.layerId).toBe('commutes');
    expect(hit!.index).toBe(1);
    expect(hit!.coordinate).toEqual([12, 47]);
    expect(hit!.screen).toEqual([12, 34]);
  });

  it('ignores a hit belonging to another layer', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene, { id: 'commutes' });
    layer.setTiles(ANIMATED);
    s.setPick({
      id: { layerId: 'somebody-else', binary: {}, featureIndex: 0 },
    });
    expect(layer.pick(1, 1)).toBeNull();
  });

  it('returns null on a miss', () => {
    const s = stubScene();
    const layer = new STTFlowmapLayer(s.scene);
    layer.setTiles(ANIMATED);
    s.setPick(undefined);
    expect(layer.pick(1, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The oracle sweep. `time-filter-oracle.test.ts` names this file as this
// layer's proof, so the agreement has to be asserted HERE and it has to be
// non-vacuous: four windows that variously start before, inside and after the
// playhead range, every shipped mode, and a coprime stride that walks past both
// ends plus the exact boundary instants (the stride alone never lands ON a
// startTime, which is the only place wake/trail reach alpha 1).
// ---------------------------------------------------------------------------

const MODES: { mode: TimeFilterMode; params: TimeFilterParams }[] = [
  { mode: 'window', params: { windowHalf: 400 } },
  { mode: 'window', params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 } },
  { mode: 'wake', params: { wakeLength: 900 } },
  { mode: 'cumulative', params: { fadeIn: 0 } },
  { mode: 'cumulative', params: { fadeIn: 700 } },
  { mode: 'trail', params: { trailLength: 600, trailFade: 1 } },
  { mode: 'trail', params: { trailLength: 600, trailFade: 0.35 } },
  { mode: 'none', params: {} },
];
const STARTS = [0, 120, 500, 999];
const ENDS = [40, 300, 900, 1200];
const PLAYHEADS: number[] = [];
for (let t = -220; t <= 1600; t += 37) PLAYHEADS.push(TIME_OFFSET + t);
for (const s of STARTS) PLAYHEADS.push(TIME_OFFSET + s);
for (const e of ENDS) PLAYHEADS.push(TIME_OFFSET + e);

// A STATIC (axis-free) archive on purpose: no bucket axis means the geometry is
// baked exactly once, so one armed batch table survives the whole sweep and the
// only thing moving is the alpha.
const SWEEP_TILES = [
  flowTile({
    lines: [
      [10, 45, 10.4, 45.2],
      [12, 47, 12.4, 47.2],
      [14, 49, 14.4, 49.2],
      [16, 51, 16.4, 51.2],
    ],
    numericProps: { trips: new Float32Array([1, 1, 1, 1]) },
    startTimes: STARTS,
    endTimes: ENDS,
  }),
];

describe('STTFlowmapLayer — alpha is the shared core/time-filter oracle', () => {
  for (const { mode, params } of MODES) {
    it(`matches timeFilterAlpha for ${mode} ${JSON.stringify(params)}`, () => {
      const s = stubScene();
      const layer = new STTFlowmapLayer(s.scene, {
        mode,
        timeFilter: params,
        // Opaque base colour and no magnitude dimming, so the written byte is
        // the oracle alone — nothing here can pass by cancelling out.
        color: { type: 'constant', color: [10, 20, 30, 255] },
        minMagnitudeAlpha: 1,
      });
      layer.setTiles(SWEEP_TILES);
      const store = arm(layer);
      // The stand-in batch table fills lazily, on the layer's first
      // getGeometryInstanceAttributes pass — so tick once before binding slots.
      layer.setTime(PLAYHEADS[0]);
      const slots = instancesOf(layer).map(
        (gi) => store.get(gi.id) as ArmedAttr,
      );
      expect(slots).toHaveLength(4);
      expect(slots.every((slot) => slot !== undefined)).toBe(true);

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        for (let i = 0; i < 4; i++) {
          const expected = Math.round(
            timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params) * 255,
          );
          expect(slots[i].bytes[3], `${mode} @ ${cur} feature ${i}`).toBe(
            expected,
          );
          // The RGB never moves — only the alpha animates.
          expect([
            slots[i].bytes[0],
            slots[i].bytes[1],
            slots[i].bytes[2],
          ]).toEqual([10, 20, 30]);
        }
      }
    });
  }

  it('the sweep is not vacuous — fractional alphas really occur', () => {
    let fractional = 0;
    for (const { mode, params } of MODES) {
      if (mode === 'none') continue;
      for (const absoluteMs of PLAYHEADS) {
        const cur = absoluteMs - TIME_OFFSET;
        for (let i = 0; i < STARTS.length; i++) {
          const a = timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params);
          if (a > 0 && a < 1) fractional++;
        }
      }
    }
    expect(fractional).toBeGreaterThan(50);
  });
});
