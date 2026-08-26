// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTFlowCorridorLayer` — the `flowCorridor` kind for CesiumJS.
 *
 * Everything except the GPU render pass runs here against a stub `Scene` and
 * REAL Cesium value types (`PrimitiveCollection`, `Primitive`,
 * `GeometryInstance`, `PolylineGeometry`, `Cartesian3`), all of which load and
 * compute under Node.
 *
 * The cases carrying the weight:
 *
 *  - **"resolves the colour from the max OF the blend"** — the bug this layer is
 *    most likely to ship is the cheap reduction (blend the per-column maxima),
 *    which is a strict upper bound and looks entirely plausible on screen. It is
 *    pinned with a fixture whose argmax vertex MIGRATES between the two columns,
 *    plus a negative control against the upper-bound answer.
 *  - **"animates colour, per CORRIDOR"** — the standing documented deviation.
 *    Cesium's batch table has one RGBA per polyline instance, so a deck/three
 *    per-vertex gradient collapses to the busiest vertex. Asserted as a shape
 *    fact (one attribute handle per corridor, not per vertex).
 *  - **"bails on an empty publish before tearing down"** — the transient empty
 *    selection between a viewport change and the first decoded tile must not
 *    blank the network.
 *  - **"arms the batch table lazily and skips unchanged writes"** — the
 *    per-frame contract: nothing before `ready`, one shared scratch, and a
 *    static network that costs a compare rather than a write.
 */

import { describe, it, expect } from 'vitest';
import {
  Primitive,
  PrimitiveCollection,
  type GeometryInstance,
  type Scene,
} from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { rampColorAt, type RGBA255 } from '@poopdeck.gl/core/style';
import {
  timeFilterAlpha,
  type TimeFilterMode,
} from '@poopdeck.gl/core/time-filter';
import {
  bucketBlendAt,
  corridorPeakAt,
  type FlowStrokeCorridor,
} from '../src/lib/flow-strokes';
import { STTFlowCorridorLayer } from '../src/cesium-flow-corridor-layer';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const TIME_OFFSET = 1_700_000_000_000;
/** Two buckets over the feature-0 window => bucket0Abs = TIME_OFFSET, width 500. */
const BUCKET_MS = 500;

const RAMP = {
  domain: [0, 10] as const,
  range: [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ] as readonly RGBA255[],
};

// ---------------------------------------------------------------- fixtures

interface FlowTileSpec {
  lines: number[][];
  matrix: number[][];
  numBuckets: number;
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

  const flat = new Float32Array(total * spec.numBuckets);
  for (let v = 0; v < spec.matrix.length; v++) {
    for (let b = 0; b < spec.numBuckets; b++) {
      flat[v * spec.numBuckets + b] = spec.matrix[v][b];
    }
  }

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
    numericProps: {},
    categoricalProps: {
      route: { indices: new Uint8Array(featureCount), categories: ['a'] },
    },
    vectorProps: {},
    vertexValueMatrix: flat,
    vertexValueBuckets: spec.numBuckets,
  };

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

/**
 * The discriminating fixture: ONE two-vertex corridor whose busiest vertex
 * MIGRATES from vertex 0 (column 0) to vertex 1 (column 1). Halfway between the
 * columns every vertex reads 5, while the per-column maxima are 10 and 10.
 */
function migratingPeakTile(): Tile[] {
  return [
    flowTile({
      lines: [[0, 0, 0.01, 0]],
      matrix: [
        [10, 0],
        [0, 10],
      ],
      numBuckets: 2,
    }),
  ];
}

/**
 * The u8 RGB the layer should write for a corridor volume. `rampColorAt`
 * interpolates in continuous channel space; the batch table is u8, and the
 * layer rounds rather than letting a typed-array store truncate.
 */
function rampRgb(value: number): number[] {
  return [...rampColorAt(value, RAMP.domain, RAMP.range)]
    .slice(0, 3)
    .map((c) => Math.round(c));
}

// ---------------------------------------------------------------- harness

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

interface ArmedTable {
  /** Instance id -> its four batch-table bytes. */
  bytes: Map<unknown, Uint8Array>;
  /** Instance id -> how many times the layer wrote it. */
  writes: Map<unknown, number>;
  totalWrites(): number;
}

/**
 * `Primitive.getGeometryInstanceAttributes` only exists after a real GPU render
 * and `setTime` bails on `!primitive.ready`, so stand both in. The setter must
 * COPY like Cesium's: the layer writes ONE shared scratch for every corridor, so
 * a stand-in storing the reference would report the last write for all of them.
 */
function armPrimitive(prim: Primitive): ArmedTable {
  const bytes = new Map<unknown, Uint8Array>();
  const writes = new Map<unknown, number>();
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const store = bytes.get(id) ?? new Uint8Array(4);
    bytes.set(id, store);
    writes.set(id, writes.get(id) ?? 0);
    return {
      get color(): Uint8Array {
        return store;
      },
      set color(v: Uint8Array) {
        store.set(v);
        writes.set(id, (writes.get(id) ?? 0) + 1);
      },
    } as never;
  };
  return {
    bytes,
    writes,
    totalWrites: () => [...writes.values()].reduce((a, b) => a + b, 0),
  };
}

function collectionOf(s: StubScene): PrimitiveCollection {
  return s.added[0] as PrimitiveCollection;
}

function primitiveOf(s: StubScene): Primitive {
  return collectionOf(s).get(0) as Primitive;
}

function instancesOf(prim: Primitive): GeometryInstance[] {
  return prim.geometryInstances as GeometryInstance[];
}

/** The four bytes written for corridor `f`, in instance order. */
function bytesFor(table: ArmedTable, prim: Primitive, f: number): number[] {
  const id = instancesOf(prim)[f].id;
  return Array.from(table.bytes.get(id) ?? new Uint8Array(4));
}

// ---------------------------------------------------------------- tests

describe('STTFlowCorridorLayer — construction and geometry', () => {
  it('registers a collection into scene.primitives at construction', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene);
    expect(layer.id).toBe('stt-cesium-flow-corridors');
    expect(s.added).toHaveLength(1);
    expect(collectionOf(s)).toBeInstanceOf(PrimitiveCollection);
    // The Primitive cannot exist before the first tile.
    expect(collectionOf(s).length).toBe(0);
  });

  it('builds one polyline instance per corridor at absolute WGS84 ECEF metres', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, { id: 'flow' });
    layer.setTiles([
      flowTile({
        lines: [
          [0, 0, 0.01, 0],
          [4, 51, 4.01, 51, 4.02, 51],
        ],
        matrix: [
          [1, 1],
          [2, 2],
          [3, 3],
          [4, 4],
          [5, 5],
        ],
        numBuckets: 2,
      }),
    ]);

    const prim = primitiveOf(s);
    expect(prim).toBeInstanceOf(Primitive);
    const instances = instancesOf(prim);
    expect(instances).toHaveLength(2);

    // The centreline, not an offset ribbon: flowCorridor passes offsetWidths 0.
    const pos = (
      instances[0].geometry as {
        _positions: { x: number; y: number; z: number }[];
      }
    )._positions;
    const [x, y, z] = GLOBE.project(0, 0, 0);
    expect(pos[0].x).toBeCloseTo(x, 6);
    expect(pos[0].y).toBeCloseTo(y, 6);
    expect(pos[0].z).toBeCloseTo(z, 6);
    // Absolute ECEF, no RTC — an equatorial point is ~6.378e6 m from the centre.
    expect(Math.hypot(pos[0].x, pos[0].y, pos[0].z)).toBeGreaterThan(6_000_000);

    // Pick/attribute identity travels on every instance.
    expect(instances[1].id).toMatchObject({ layerId: 'flow', featureIndex: 1 });
  });

  it('seeds every instance fully transparent so the network cannot flash', () => {
    const s = stubScene();
    new STTFlowCorridorLayer(s.scene).setTiles(migratingPeakTile());
    const attr = instancesOf(primitiveOf(s))[0].attributes.color as {
      value: Uint8Array;
    };
    expect(attr.value[3]).toBe(0);
  });

  it('bails on an empty publish BEFORE tearing the standing network down', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene);
    layer.setTiles(migratingPeakTile());
    const standing = primitiveOf(s);

    layer.setTiles([]); // the transient empty selection during a viewport change
    expect(collectionOf(s).length).toBe(1);
    expect(primitiveOf(s)).toBe(standing);

    // A tile with no flow matrix is just as empty, and just as non-destructive.
    const plain = migratingPeakTile();
    plain[0].layers[0].features.vertexValueMatrix = undefined;
    layer.setTiles(plain);
    expect(primitiveOf(s)).toBe(standing);
  });

  it('replaces all on a real publish', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene);
    layer.setTiles(migratingPeakTile());
    const first = primitiveOf(s);
    layer.setTiles([
      flowTile({
        lines: [
          [1, 1, 1.01, 1],
          [2, 2, 2.01, 2],
        ],
        matrix: [
          [1, 1],
          [1, 1],
          [1, 1],
          [1, 1],
        ],
        numBuckets: 2,
      }),
    ]);
    expect(collectionOf(s).length).toBe(1);
    expect(primitiveOf(s)).not.toBe(first);
    expect(instancesOf(primitiveOf(s))).toHaveLength(2);
  });
});

describe('STTFlowCorridorLayer — the per-frame colour reduction', () => {
  it('does nothing at all before the primitive is ready', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, { valueRamp: RAMP });
    layer.setTiles(migratingPeakTile());
    // The batch table exists only after the first render; touching it earlier
    // throws inside Cesium, so a bail is the contract, not an optimisation.
    expect(() => layer.setTime(TIME_OFFSET)).not.toThrow();
    expect(instancesOf(primitiveOf(s))[0].attributes.color).toBeDefined();
  });

  it('resolves the colour from the max OF the blend, not the blend of the maxima', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      valueRamp: RAMP,
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);

    // Halfway between the columns the argmax vertex has migrated: every vertex
    // reads 5, so the corridor's value is 5 — NOT the 10 the per-column maxima
    // would blend to.
    layer.setTime(TIME_OFFSET + BUCKET_MS / 2);
    expect(bytesFor(table, prim, 0).slice(0, 3)).toEqual(rampRgb(5));
    expect(bytesFor(table, prim, 0).slice(0, 3)).not.toEqual(rampRgb(10));

    // Cross-check against the pure reduction the layer is supposed to be using.
    const build = {
      values: new Float32Array([10, 0, 0, 10]),
      vertexCount: 2,
    } as FlowStrokeCorridor;
    expect(corridorPeakAt(build, 2, bucketBlendAt(0.5, 2))).toBe(5);
  });

  it('animates: the same static corridor takes a different colour per bucket', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      valueRamp: RAMP,
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);

    layer.setTime(TIME_OFFSET); // column 0 alone: peak 10
    const atZero = bytesFor(table, prim, 0);
    layer.setTime(TIME_OFFSET + BUCKET_MS / 2); // the blend: peak 5
    const atHalf = bytesFor(table, prim, 0);
    expect(atZero.slice(0, 3)).toEqual([255, 255, 255]);
    expect(atHalf).not.toEqual(atZero);
    // Geometry never moved — this kind animates COLOUR over a static network.
    expect(instancesOf(prim)).toHaveLength(1);
  });

  it('animates per CORRIDOR, not per vertex — the documented Cesium deviation', () => {
    // One batch-table handle per corridor, whatever its vertex count: Cesium has
    // no per-vertex colour on this path, so a deck/three gradient down a long
    // corridor collapses to its busiest vertex.
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      valueRamp: RAMP,
    });
    layer.setTiles([
      flowTile({
        lines: [[0, 0, 0.01, 0, 0.02, 0, 0.03, 0]],
        matrix: [
          [1, 1],
          [2, 2],
          [9, 9],
          [3, 3],
        ],
        numBuckets: 2,
      }),
    ]);
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);
    layer.setTime(TIME_OFFSET);
    expect(table.bytes.size).toBe(1);
    // The busiest vertex (9), not the mean (3.75) and not the first (1).
    expect(bytesFor(table, prim, 0).slice(0, 3)).toEqual(rampRgb(9));
  });

  it('clamps a playhead outside the axis to the end columns', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      valueRamp: RAMP,
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);

    layer.setTime(TIME_OFFSET - 10 * BUCKET_MS); // before the data
    expect(bytesFor(table, prim, 0).slice(0, 3)).toEqual(rampRgb(10));
    layer.setTime(TIME_OFFSET + 99 * BUCKET_MS); // after it
    expect(bytesFor(table, prim, 0).slice(0, 3)).toEqual(rampRgb(10));
  });

  it('keeps the identity colour when no ramp is configured', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      color: { type: 'constant', color: [12, 34, 56, 255] },
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);
    layer.setTime(TIME_OFFSET + BUCKET_MS / 2);
    expect(bytesFor(table, prim, 0)).toEqual([12, 34, 56, 255]);
  });
});

describe('STTFlowCorridorLayer — the minFlow pulse', () => {
  it('makes a corridor at or below minFlow invisible, whatever the time filter says', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      valueRamp: RAMP,
      minFlow: 6,
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);

    layer.setTime(TIME_OFFSET); // peak 10 > 6 — the rush hour
    expect(bytesFor(table, prim, 0)[3]).toBe(255);
    layer.setTime(TIME_OFFSET + BUCKET_MS / 2); // peak 5 <= 6 — off-peak
    expect(bytesFor(table, prim, 0)[3]).toBe(0);
  });

  it('hides a zero-volume corridor at the default minFlow of 0', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, { mode: 'none' });
    layer.setTiles([
      flowTile({
        lines: [
          [0, 0, 0.01, 0],
          [1, 0, 1.01, 0],
        ],
        matrix: [
          [0, 0],
          [0, 0],
          [4, 4],
          [4, 4],
        ],
        numBuckets: 2,
      }),
    ]);
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);
    layer.setTime(TIME_OFFSET);
    expect(bytesFor(table, prim, 0)[3]).toBe(0);
    expect(bytesFor(table, prim, 1)[3]).toBe(255);
  });
});

describe('STTFlowCorridorLayer — the time-filter oracle', () => {
  // Mirrors test/time-filter-oracle.test.ts's sweep constants.
  const MODES: { mode: TimeFilterMode; params: Record<string, number> }[] = [
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

  it('drives alpha through timeFilterAlpha for every mode and playhead', () => {
    for (const { mode, params } of MODES) {
      const s = stubScene();
      const layer = new STTFlowCorridorLayer(s.scene, {
        mode,
        timeFilter: params,
        color: { type: 'constant', color: [10, 20, 30, 255] },
      });
      layer.setTiles([
        flowTile({
          lines: STARTS.map((_, i) => [i, 0, i + 0.01, 0]),
          matrix: STARTS.flatMap(() => [
            [7, 7],
            [7, 7],
          ]),
          numBuckets: 2,
          startTimes: STARTS,
          endTimes: ENDS,
        }),
      ]);
      const prim = primitiveOf(s);
      const table = armPrimitive(prim);

      // A coprime stride across and beyond every feature, PLUS the exact
      // boundary instants — the stride alone never lands ON a startTime, the
      // only place wake/trail reach alpha 1.
      const playheads = [...STARTS, ...ENDS];
      for (let t = -200; t <= 1600; t += 37) playheads.push(t);

      for (const rel of playheads) {
        layer.setTime(TIME_OFFSET + rel);
        for (let f = 0; f < STARTS.length; f++) {
          const expected = Math.round(
            timeFilterAlpha(mode, rel, STARTS[f], ENDS[f], params) * 255,
          );
          expect(bytesFor(table, prim, f)[3]).toBe(expected);
        }
      }
    }
  });
});

describe('STTFlowCorridorLayer — per-frame cost', () => {
  it('skips a corridor whose colour and alpha are both unchanged', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      color: { type: 'constant', color: [1, 2, 3, 255] },
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);

    layer.setTime(TIME_OFFSET); // first frame always writes (lastAlpha is NaN)
    expect(table.totalWrites()).toBe(1);
    // A static network with no ramp: crossing a sub-step must NOT force a write.
    layer.setTime(TIME_OFFSET + BUCKET_MS / 2);
    layer.setTime(TIME_OFFSET + BUCKET_MS);
    expect(table.totalWrites()).toBe(1);
  });

  it('writes again when the ramp actually moves the RGB', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      valueRamp: RAMP,
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);

    layer.setTime(TIME_OFFSET);
    layer.setTime(TIME_OFFSET + BUCKET_MS / 2); // peak 10 -> 5: the RGB moved
    expect(table.totalWrites()).toBe(2);
    // Within the same sub-step nothing is recomputed and nothing is written.
    layer.setTime(TIME_OFFSET + BUCKET_MS / 2 + 1);
    expect(table.totalWrites()).toBe(2);
  });

  it('honours a finer subStep', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, {
      mode: 'none',
      valueRamp: RAMP,
      subStep: 0.25,
    });
    layer.setTiles(migratingPeakTile());
    const prim = primitiveOf(s);
    const table = armPrimitive(prim);
    layer.setTime(TIME_OFFSET);
    layer.setTime(TIME_OFFSET + BUCKET_MS * 0.25); // a quarter-bucket recolour
    expect(table.totalWrites()).toBe(2);
    expect(bytesFor(table, prim, 0).slice(0, 3)).toEqual(rampRgb(7.5));
  });
});

describe('STTFlowCorridorLayer — picking and lifecycle', () => {
  it('returns a SttPickResult carrying the corridor’s first vertex', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, { id: 'flow' });
    const tile = flowTile({
      lines: [
        [0, 0, 0.01, 0],
        [4, 51, 4.01, 51],
      ],
      matrix: [
        [1, 1],
        [1, 1],
        [2, 2],
        [2, 2],
      ],
      numBuckets: 2,
    });
    layer.setTiles([tile]);
    const binary = tile.layers[0].features;

    s.setPick({ id: { layerId: 'flow', binary, featureIndex: 1 } });
    const hit = layer.pick(12, 34);
    expect(hit).toMatchObject({
      index: 1,
      layerId: 'flow',
      coordinate: [4, 51],
      screen: [12, 34],
    });
    expect(hit?.object).toBeTruthy();
  });

  it('ignores a hit belonging to another layer, and a miss', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene, { id: 'flow' });
    layer.setTiles(migratingPeakTile());
    s.setPick({ id: { layerId: 'other', binary: {}, featureIndex: 0 } });
    expect(layer.pick(1, 1)).toBeNull();
    s.setPick(undefined);
    expect(layer.pick(1, 1)).toBeNull();
  });

  it('disposes symmetrically — primitives destroyed, then the collection removed', () => {
    const s = stubScene();
    const layer = new STTFlowCorridorLayer(s.scene);
    layer.setTiles(migratingPeakTile());
    const collection = collectionOf(s);
    layer.dispose();
    // removeAll() runs FIRST (it destroys the primitive while the collection is
    // still alive); scene.primitives.remove then takes the collection itself.
    expect(collection.length).toBe(0);
    expect(s.removed).toEqual([collection]);
    expect(() => layer.setTime(TIME_OFFSET)).not.toThrow();
  });
});
