// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTHexbinLayer` against a stub `Scene` and a REAL Cesium `Primitive`.
 *
 * `vitest.config.ts` runs `environment: 'node'` and real `@cesium/engine`
 * loads there — what does NOT work is anything needing a live WebGL context.
 * So the scene is stubbed down to `primitives.add/remove` + `pick`, while the
 * `Primitive`, `GeometryInstance` and `PolygonGeometry` the layer builds are
 * genuine. `armPrimitive` stands in for the batch table, which only exists
 * after a real GPU render.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Primitive, Scene } from 'cesium';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTHexbinLayer } from '../src/cesium-hexbin-layer.js';

// ── harness ─────────────────────────────────────────────────────────────────

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  /** What the next `scene.pick` returns. */
  picked: unknown;
}

function stubScene(): StubScene {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const s: StubScene = {
    added,
    removed,
    picked: undefined,
    scene: undefined as unknown as Scene,
  };
  s.scene = {
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
      return s.picked;
    },
  } as unknown as Scene;
  return s;
}

/**
 * Stand in for the batch table. `Primitive.getGeometryInstanceAttributes` only
 * exists after a real GPU render, and `setTime` bails on `!primitive.ready`.
 * The setter COPIES, like Cesium's — the layer writes ONE shared scratch
 * `Uint8Array` for every entry, so a stand-in storing the reference would
 * report the last write for all of them.
 */
function armPrimitive(prim: Primitive): {
  store: Map<unknown, Uint8Array>;
  writes: () => number;
} {
  const store = new Map<unknown, Uint8Array>();
  let writes = 0;
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    let bytes = store.get(id);
    if (!bytes) {
      bytes = new Uint8Array(4);
      store.set(id, bytes);
    }
    const target = bytes;
    return {
      get color(): Uint8Array {
        return target;
      },
      set color(v: Uint8Array) {
        writes++;
        target.set(v);
      },
    } as never;
  };
  return { store, writes: () => writes };
}

/** The most recently added Primitive, armed. */
function armLast(s: StubScene) {
  const prim = s.added[s.added.length - 1] as Primitive;
  return { prim, ...armPrimitive(prim) };
}

// ── fixtures ────────────────────────────────────────────────────────────────

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  numericProps: Record<string, Float32Array> = {},
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
    timeOffset: 0,
    numericProps,
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 4000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

function polygonTile(): Tile {
  const features: BinaryFeatures = {
    featureCount: 1,
    geometryType: GeometryType.Polygon,
    positionDimensions: 2,
    positions: new Float64Array([0, 0, 0.01, 0, 0.01, 0.01, 0, 0.01]),
    startIndices: new Uint32Array([0, 4]),
    featureIds: new Uint32Array(1),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([100]),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 1000 },
    layers: [
      {
        name: 'areas',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.polygon',
      },
    ],
  };
}

/** Two hexes 22 km apart: one with three members, one with a single member. */
const TWO_HEXES = () =>
  pointTile(
    [0, 0, 0.001, 0, 0, 0.001, 0.2, 0],
    [0, 0, 0, 0],
    [100, 100, 100, 100],
  );

/** Four members in ONE hex, one per second — the fixture for re-aggregation. */
const ONE_HEX_OVER_TIME = () =>
  pointTile(
    [0, 0, 0.001, 0, 0, 0.001, 0.001, 0.001],
    [0, 1000, 2000, 3000],
    [10, 1010, 2010, 3010],
  );

const OPTS = { radiusMeters: 5000, onDiagnostics: () => {} } as const;

/**
 * Read the aggregate the layer currently reports for its FIRST bin, by picking
 * it the way Cesium would: `scene.pick` hands back whatever `id` object was
 * attached to the hit `GeometryInstance`, so the stub reads that id straight
 * off the live Primitive. `pick` is the layer's only public window onto the
 * aggregate — and the surface a host actually reads — so the re-aggregation
 * tests probe through it rather than through private state.
 *
 * The id is re-read every call ON PURPOSE: the representative member changes as
 * the window moves, so a cached id would silently stop matching.
 */
function aggregateOf(
  s: StubScene,
  layer: STTHexbinLayer,
): { count: number; weight: number } {
  const prim = s.added[s.added.length - 1] as {
    geometryInstances?: { id: unknown }[];
  };
  const instance = prim?.geometryInstances?.[0];
  if (!instance) return { count: 0, weight: 0 };
  s.picked = { id: instance.id };
  const hit = layer.pick(0, 0);
  if (!hit) return { count: 0, weight: 0 };
  const agg = hit.object as { count: number; weight: number };
  return { count: agg.count, weight: agg.weight };
}

// ── construction & lifecycle ────────────────────────────────────────────────

describe('construction', () => {
  it('takes (scene, options = {}) and registers nothing until the first build', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene);
    expect(layer.id).toBe('stt-cesium-hexbin');
    // A Primitive is immutable once constructed, so there is nothing to add
    // before there is geometry.
    expect(s.added).toEqual([]);
  });

  it('honours a caller id', () => {
    const s = stubScene();
    expect(new STTHexbinLayer(s.scene, { id: 'density' }).id).toBe('density');
  });
});

describe('setTiles', () => {
  it('builds one batched Primitive for the whole lattice', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([TWO_HEXES()]);
    expect(s.added.length).toBe(1);
    layer.dispose();
  });

  it('bails on an empty result BEFORE any teardown', () => {
    // The hard rule: selection reports an empty visible set for the frames
    // between a viewport change and the first decoded tile of the new set.
    // Tearing down first turns that transient into a blank frame.
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([TWO_HEXES()]);
    const standing = s.added[0];
    layer.setTiles([]);
    expect(s.removed).toEqual([]); // nothing torn down
    expect(s.added.length).toBe(1);
    expect(s.added[0]).toBe(standing); // the same primitive is still up
    layer.dispose();
  });

  it('bails on a polygon-only tile set too, and warns ONCE by name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = stubScene();
      const layer = new STTHexbinLayer(s.scene, { radiusMeters: 5000 });
      layer.setTiles([polygonTile()]);
      layer.setTiles([polygonTile()]);
      expect(s.added).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('STTHexbinLayer');
      expect(String(warn.mock.calls[0][0])).toContain('Polygon');
      layer.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it('replaces the previous primitive on a real rebuild', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([TWO_HEXES()]);
    const first = s.added[0];
    layer.setTiles([pointTile([1, 1], [0], [100])]);
    expect(s.removed).toContain(first);
    expect(s.added.length).toBe(2);
    layer.dispose();
  });
});

describe('dispose', () => {
  it('removes the collection from the scene', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([TWO_HEXES()]);
    const prim = s.added[0];
    layer.dispose();
    expect(s.removed).toContain(prim);
  });

  it('DESTROYS a primitive the scene refused to remove', () => {
    // `PrimitiveCollection.remove` returns false for a primitive it does not
    // hold — a double dispose, or a host running `destroyPrimitives: false`.
    // Leaving that case alone leaks every hex's GPU buffers, and this layer
    // re-batches on every bucket crossing, so the leak would be continuous.
    const s = stubScene();
    (s.scene.primitives as unknown as { remove: () => boolean }).remove = () =>
      false;
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([TWO_HEXES()]);
    const prim = s.added[0] as Primitive;
    const destroy = vi
      .spyOn(prim, 'destroy')
      .mockImplementation(() => undefined);
    layer.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
  });

  it('is idempotent', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([TWO_HEXES()]);
    layer.dispose();
    expect(() => layer.dispose()).not.toThrow();
  });
});

// ── the per-frame alpha pass ────────────────────────────────────────────────

describe('setTime — the per-frame alpha pass', () => {
  it('seeds each instance at the CURRENT playhead alpha, not transparent', () => {
    // This layer re-batches on every bucket crossing and a fresh Primitive is
    // `!ready` for one render pass; a transparent seed would flash the whole
    // lattice out each time.
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 50 },
      reaggregate: false,
    });
    layer.setTime(50); // playhead lands inside the fixture's window
    layer.setTiles([TWO_HEXES()]);
    const prim = s.added[0] as {
      geometryInstances: { attributes: { color: { value: Uint8Array } } }[];
    };
    for (const inst of prim.geometryInstances) {
      expect(inst.attributes.color.value[3]).toBe(255);
    }
    layer.dispose();
  });

  it('does nothing before the primitive is ready (no batch table yet)', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'none',
    });
    layer.setTiles([TWO_HEXES()]);
    expect(() => layer.setTime(0)).not.toThrow();
    layer.dispose();
  });

  it('writes the base colour with the oracle alpha into the batch table', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, { ...OPTS, mode: 'none' });
    layer.setTiles([TWO_HEXES()]);
    const { store } = armLast(s);
    layer.setTime(50);
    expect(store.size).toBe(2);
    for (const bytes of store.values()) {
      expect(bytes[3]).toBe(255); // mode 'none' → alpha 1
      // Colour survived as BYTES; the ramp's low stop is (255, 255, 178).
      expect(bytes[0]).toBeGreaterThan(0);
    }
    layer.dispose();
  });

  it('fades to nothing outside a window, and back inside it', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 50 },
      reaggregate: false, // isolate the alpha pass from re-binning
    });
    layer.setTiles([TWO_HEXES()]);
    const { store } = armLast(s);
    layer.setTime(50);
    expect([...store.values()].every((b) => b[3] === 255)).toBe(true);
    layer.setTime(100_000);
    expect([...store.values()].every((b) => b[3] === 0)).toBe(true);
    layer.dispose();
  });

  it('SKIPS the write when the alpha has not moved', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'none',
      reaggregate: false,
    });
    layer.setTiles([TWO_HEXES()]);
    const { writes } = armLast(s);
    layer.setTime(10);
    const afterFirst = writes();
    expect(afterFirst).toBe(2); // lastAlpha starts at NaN → the first frame writes
    layer.setTime(20);
    expect(writes()).toBe(afterFirst); // unchanged alpha costs a compare, not a dirty
    layer.dispose();
  });
});

// ── re-aggregation ──────────────────────────────────────────────────────────

describe('setTime — re-aggregation', () => {
  const WINDOWED = {
    ...OPTS,
    mode: 'window' as const,
    timeFilter: { windowHalf: 500 },
    aggregationStepMs: 1000,
  };

  it('does NOT rebuild while the playhead stays inside one bucket', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, WINDOWED);
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    const count = s.added.length;
    layer.setTime(10);
    layer.setTime(200);
    layer.setTime(999);
    expect(s.added.length).toBe(count); // one bucket, one aggregate
    layer.dispose();
  });

  it('RE-BINS when the window centre crosses the aggregation step', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, WINDOWED);
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    layer.setTime(0);
    const before = s.added.length;
    layer.setTime(2000); // bucket 0 → bucket 2
    expect(s.added.length).toBeGreaterThan(before);
    layer.dispose();
  });

  it('reports the RE-COUNTED aggregate, not a cross-faded one', () => {
    // The fixture puts four members in ONE hex, one per second. Under a ±500 ms
    // window that hex must report exactly ONE member at each whole second —
    // and a cumulative window over the same hex must report all four. A
    // cross-fade over a static aggregate would report 4 every time.
    const s = stubScene();
    const tile = ONE_HEX_OVER_TIME();
    const layer = new STTHexbinLayer(s.scene, WINDOWED);
    layer.setTiles([tile]);
    for (const t of [0, 1000, 2000, 3000]) {
      layer.setTime(t);
      expect(aggregateOf(s, layer).count).toBe(1);
    }
    layer.dispose();

    const cumulative = stubScene();
    const all = new STTHexbinLayer(cumulative.scene, {
      ...OPTS,
      mode: 'cumulative',
      aggregationStepMs: 1000,
    });
    all.setTiles([tile]);
    all.setTime(3500);
    expect(aggregateOf(cumulative, all).count).toBe(4);
    all.dispose();
  });

  it('adopts an EMPTY aggregate when the playhead leaves the data', () => {
    // Unlike `setTiles`, an empty RE-aggregation is real: holding stale hexes
    // here would be exactly the cross-fade lie this layer exists to avoid.
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, WINDOWED);
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    layer.setTime(0);
    const standing = s.added[s.added.length - 1];
    layer.setTime(900_000);
    expect(s.removed).toContain(standing);
    expect(s.added[s.added.length - 1]).toBe(standing); // nothing new was added
    layer.dispose();
  });

  it('does not recompute the same empty bucket every frame', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, WINDOWED);
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    layer.setTime(900_000);
    const removals = s.removed.length;
    layer.setTime(900_100);
    layer.setTime(900_200);
    expect(s.removed.length).toBe(removals);
    layer.dispose();
  });

  it('replays a memoised bucket rather than drifting on the way back', () => {
    // Scrubbing back to a visited bucket must reproduce that bucket's aggregate
    // EXACTLY: the (tiles, config, bucket) key is unchanged, so the memoised
    // pure build is what comes out. The Primitive is still re-batched — the
    // cache elides the BINNING, not the GPU upload — so the observable is the
    // aggregate, not the absence of work.
    const s = stubScene();
    const tile = ONE_HEX_OVER_TIME();
    const layer = new STTHexbinLayer(s.scene, WINDOWED);
    layer.setTiles([tile]);

    layer.setTime(0);
    const first = aggregateOf(s, layer);
    expect(first.count).toBe(1);
    layer.setTime(2000);
    expect(aggregateOf(s, layer).count).toBe(1);
    layer.setTime(0);
    expect(aggregateOf(s, layer)).toEqual(first);
    layer.dispose();
  });

  it('freezes the aggregate under reaggregate: false', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 500 },
      reaggregate: false,
    });
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    const count = s.added.length;
    layer.setTime(0);
    layer.setTime(2000);
    layer.setTime(900_000);
    expect(s.added.length).toBe(count);
    layer.dispose();
  });

  it('derives a cumulative step from the RESIDENT DATA SPAN', () => {
    // `cumulative` carries no length parameter, so without this it would bin
    // the whole archive at every playhead and report the final total from the
    // very first frame. The fixture's tiles span 0–4000 ms.
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, { ...OPTS, mode: 'cumulative' });
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    layer.setTime(500);
    expect(aggregateOf(s, layer).count).toBe(1);
    layer.setTime(2500);
    expect(aggregateOf(s, layer).count).toBe(3);
    layer.setTime(3500);
    expect(aggregateOf(s, layer).count).toBe(4);
    layer.dispose();
  });

  it('never re-aggregates a mode with no span (nothing to bucket)', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, { ...OPTS, mode: 'none' });
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    const count = s.added.length;
    layer.setTime(0);
    layer.setTime(99_999);
    expect(s.added.length).toBe(count);
    layer.dispose();
  });

  it('derives a step of one eighth of the mode span when none is given', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 4000 }, // span 8000 → step 1000
    });
    layer.setTiles([ONE_HEX_OVER_TIME()]);
    layer.setTime(0);
    const before = s.added.length;
    layer.setTime(500); // same bucket
    expect(s.added.length).toBe(before);
    layer.setTime(1500); // bucket 1
    expect(s.added.length).toBe(before + 1);
    layer.dispose();
  });
});

// ── picking ─────────────────────────────────────────────────────────────────

describe('pick', () => {
  it('returns null for a miss and for another layer’s id', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([TWO_HEXES()]);
    expect(layer.pick(1, 2)).toBeNull();
    s.picked = { id: { layerId: 'someone-else', binary: {}, featureIndex: 0 } };
    expect(layer.pick(1, 2)).toBeNull();
    layer.dispose();
  });

  it('reports the AGGREGATE, the hex CENTRE, and a labelled sample', () => {
    const s = stubScene();
    const tile = TWO_HEXES();
    const binary = tile.layers[0].features;
    const layer = new STTHexbinLayer(s.scene, OPTS);
    layer.setTiles([tile]);
    s.picked = { id: { layerId: layer.id, binary, featureIndex: 0 } };

    const hit = layer.pick(11, 22)!;
    expect(hit).not.toBeNull();
    expect(hit.layerId).toBe(layer.id);
    expect(hit.screen).toEqual([11, 22]);
    const agg = hit.object as {
      count: number;
      weight: number;
      weightProperty: string | null;
      aggregation: string;
      sampleProperties: unknown;
    };
    // A hex describes a POPULATION, not a row: three members went into the one
    // containing feature 0.
    expect(agg.count).toBe(3);
    expect(agg.weight).toBe(3);
    expect(agg.weightProperty).toBeNull();
    expect(agg.aggregation).toBe('sum');
    expect(agg.sampleProperties).toBeTypeOf('object');
    // The centre, not the hit point — reporting a corner would misstate where
    // the aggregate lives.
    expect(hit.coordinate).toBeDefined();
    expect(Math.abs(hit.coordinate![0])).toBeLessThan(1);
    layer.dispose();
  });

  it('names the weight column and aggregation it actually used', () => {
    const s = stubScene();
    const tile = pointTile([0, 0, 0.001, 0], [0, 0], [100, 100], {
      mag: new Float32Array([4, 6]),
    });
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      colorWeight: 'mag',
      aggregation: 'mean',
    });
    layer.setTiles([tile]);
    s.picked = {
      id: {
        layerId: layer.id,
        binary: tile.layers[0].features,
        featureIndex: 0,
      },
    };
    const agg = layer.pick(0, 0)!.object as {
      weight: number;
      weightProperty: string | null;
      aggregation: string;
    };
    expect(agg.weight).toBe(5);
    expect(agg.weightProperty).toBe('mag');
    expect(agg.aggregation).toBe('mean');
    layer.dispose();
  });
});

// ── diagnostics ─────────────────────────────────────────────────────────────

describe('diagnostics', () => {
  it('routes everything to onDiagnostics when supplied, instead of the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seen: { skippedPolygonLayers: number }[] = [];
      const s = stubScene();
      const layer = new STTHexbinLayer(s.scene, {
        radiusMeters: 5000,
        onDiagnostics: (d) => seen.push(d),
      });
      layer.setTiles([polygonTile()]);
      expect(seen.length).toBe(1);
      expect(seen[0].skippedPolygonLayers).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      layer.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('STTHexbinLayer.setTime derives alpha from the core oracle', () => {
  /**
   * `time-filter-oracle.test.ts`'s `PROVEN_IN_OWN_SUITE` map points at THIS
   * file for this layer, and its companion case asserts this file really does
   * assert against `timeFilterAlpha` — so deleting or weakening this block
   * breaks the package-level gate, not just this suite.
   *
   * The re-aggregation cases above prove the layer bins correctly. This proves
   * the other half: whatever the bins are, their per-frame ALPHA is the shared
   * CPU oracle's answer and nothing else. A hexbin is the one kind where those
   * two could plausibly drift, because the aggregate is recomputed on a bucket
   * boundary while alpha moves every frame.
   */
  const MODES: ReadonlyArray<{
    mode: TimeFilterMode;
    params: TimeFilterParams;
  }> = [
    { mode: 'window', params: { windowHalf: 40 } },
    { mode: 'window', params: { windowHalf: 40, fadeIn: 25, fadeOut: 15 } },
    { mode: 'wake', params: { wakeLength: 90 } },
    { mode: 'cumulative', params: { fadeIn: 70 } },
    { mode: 'trail', params: { trailLength: 60, trailFade: 1 } },
    { mode: 'none', params: {} },
  ];

  // A coprime stride across and beyond the fixture's [0, 100] span, plus the
  // exact boundary instants — the stride alone never lands ON a startTime,
  // which is the only place wake/trail reach alpha 1.
  const PLAYHEADS: number[] = [];
  for (let t = -60; t <= 180; t += 7) PLAYHEADS.push(t);
  PLAYHEADS.push(0, 100, 90);

  it('writes exactly the oracle byte for every bin, in every mode', () => {
    for (const { mode, params } of MODES) {
      const s = stubScene();
      const layer = new STTHexbinLayer(s.scene, {
        ...OPTS,
        mode,
        timeFilter: params,
      });
      layer.setTiles([TWO_HEXES()]);
      const { store } = armLast(s);

      for (const t of PLAYHEADS) {
        layer.setTime(t);
        // Every member of this fixture spans [0, 100], so one expected value
        // covers whatever bins exist.
        const want = Math.round(timeFilterAlpha(mode, t, 0, 100, params) * 255);
        for (const [, bytes] of store) {
          expect(
            Math.abs(bytes[3] - want),
            `mode=${mode} t=${t}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('bin MEMBERSHIP is time-dependent too — a hexbin can go legitimately empty', () => {
    // Why the case above asserts only "every bin that exists carries the oracle
    // byte" and never "some bin is lit": unlike a per-feature layer, a hexbin
    // filters the raw points that FORM the bins, so far outside the window
    // there is nothing to draw rather than something drawn faded. That is the
    // kind's semantics, and a sweep that demanded a lit bin at every playhead
    // would be asserting a property this kind does not have.
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 10 },
    });
    layer.setTiles([TWO_HEXES()]);
    const { store } = armLast(s);

    layer.setTime(50);
    const inside = [...store.values()].filter((b) => b[3] > 0).length;
    layer.setTime(100_000);
    const outside = [...store.values()].filter((b) => b[3] > 0).length;
    expect(outside).toBeLessThanOrEqual(inside);
    expect(outside).toBe(0);
  });

  it('is exact for a fully-opaque bin — the oracle byte, not an approximation', () => {
    const s = stubScene();
    const layer = new STTHexbinLayer(s.scene, {
      ...OPTS,
      mode: 'window',
      timeFilter: { windowHalf: 40, fadeIn: 25, fadeOut: 15 },
    });
    layer.setTiles([TWO_HEXES()]);
    const { store } = armLast(s);

    // Pick a playhead where the oracle is fractional, so an implementation that
    // rounded differently (or skipped the fade) would disagree visibly.
    for (const t of [0, 12, 37, 88, 100]) {
      layer.setTime(t);
      const a = timeFilterAlpha('window', t, 0, 100, {
        windowHalf: 40,
        fadeIn: 25,
        fadeOut: 15,
      });
      for (const [, bytes] of store) {
        // base alpha is 1 for the default ramp's opaque stop; assert the byte is
        // the oracle's rounding of it.
        expect(Math.abs(bytes[3] - Math.round(a * 255))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is not vacuous: the sweep produces 0, 1 and a fractional alpha', () => {
    const seen = new Set<string>();
    for (const t of PLAYHEADS) {
      const a = timeFilterAlpha('window', t, 0, 100, {
        windowHalf: 40,
        fadeIn: 25,
        fadeOut: 15,
      });
      seen.add(a === 0 ? 'zero' : a === 1 ? 'one' : 'frac');
    }
    expect(seen).toEqual(new Set(['zero', 'one', 'frac']));
  });
});
