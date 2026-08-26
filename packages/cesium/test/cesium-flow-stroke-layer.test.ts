// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTFlowStrokeLayer` against a REAL `PolylineCollection` under plain Node.
 *
 * Cesium's `Polyline` constructor mints a default `Color` material, and
 * `Material`'s uniform-type sniffing does bare `instanceof HTMLCanvasElement`
 * (and friends) with no `typeof` guard — so it throws a `ReferenceError` in a
 * `node` environment before it ever looks at a colour. Four empty class shims
 * are enough to make those `instanceof` checks answer `false`, which is the
 * correct answer for a `Color`. Nothing else in this file touches the DOM, and
 * nothing here needs WebGL: positions, widths, `show` and material uniforms are
 * all CPU state on the collection.
 *
 * Installed at module scope, which runs after the static imports are evaluated
 * but long before any `add()` — cesium only reaches these globals at material
 * construction time.
 */
for (const name of [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
] as const) {
  if (!(name in globalThis)) {
    (globalThis as Record<string, unknown>)[name] = class {};
  }
}

import { describe, expect, it } from 'vitest';
import { Cartesian3, PolylineCollection, type Scene } from 'cesium';
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
import { STTFlowStrokeLayer } from '../src/cesium-flow-stroke-layer.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  /** What the next `scene.pick` returns. */
  picked: unknown;
}

function stubScene(): StubScene {
  const state: StubScene = {
    added: [],
    removed: [],
    picked: undefined,
    scene: undefined as unknown as Scene,
  };
  state.scene = {
    primitives: {
      add<T>(p: T): T {
        state.added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        state.removed.push(p);
        return true;
      },
    },
    pick(): unknown {
      return state.picked;
    },
  } as unknown as Scene;
  return state;
}

/** The layer's collection: the REAL Cesium object it registered on construction. */
function collectionOf(s: StubScene): PolylineCollection {
  return s.added[0] as PolylineCollection;
}

const TIME_OFFSET = 1_700_000_000_000;

interface FlowTileSpec {
  /** One entry per corridor: `[lon, lat, lon, lat, ...]`. */
  paths: number[][];
  /** One entry per corridor: `vertexCount x numBuckets`, vertex-major. */
  values: number[][];
  numBuckets: number;
  startTimes?: number[];
  endTimes?: number[];
  timeOffset?: number;
}

/**
 * A LineString tile carrying a flow matrix. Every field the builder's
 * `isFlowLayer` predicate and `axisFor` read is hand-constructed: the global
 * bucket axis is derived from FEATURE 0's `[start, end]`, so the first corridor
 * always spans it.
 */
function flowTile(spec: FlowTileSpec): Tile {
  const timeOffset = spec.timeOffset ?? TIME_OFFSET;
  const featureCount = spec.paths.length;
  const positions: number[] = [];
  const startIndices: number[] = [];
  const matrix: number[] = [];
  for (let f = 0; f < featureCount; f++) {
    startIndices.push(positions.length / 2);
    positions.push(...spec.paths[f]);
    matrix.push(...spec.values[f]);
  }
  startIndices.push(positions.length / 2);

  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(
      spec.startTimes ?? new Array(featureCount).fill(0),
    ),
    endTimes: new Float32Array(
      spec.endTimes ?? new Array(featureCount).fill(1000),
    ),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    vertexValueBuckets: spec.numBuckets,
    vertexValueMatrix: new Float32Array(matrix),
  } as BinaryFeatures;

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
  } as unknown as Tile;
}

/**
 * Two corridors on the same street, three vertices each, four hourly buckets.
 * Corridor 0's busiest vertex MIGRATES between buckets (v1 peaks in bucket 1,
 * v0 in bucket 2), which is exactly the case a per-bucket column max would get
 * wrong; corridor 1 is flat.
 */
const BUSY_TILE = flowTile({
  numBuckets: 4,
  paths: [
    [10, 45, 10.01, 45, 10.02, 45],
    [10.02, 45, 10.01, 45, 10, 45],
  ],
  values: [
    // v0            v1            v2
    [0, 4, 16, 0, 0, 9, 4, 0, 0, 1, 1, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  startTimes: [0, 0],
  endTimes: [1000, 1000],
});

// Axis: bucket0Abs = TIME_OFFSET, bucketWidth = 1000 / 4 = 250 ms.
const BUCKET = (i: number) => TIME_OFFSET + i * 250;

// ---------------------------------------------------------------------------

describe('STTFlowStrokeLayer — construction and tile publishing', () => {
  it('registers a PolylineCollection and builds one polyline per corridor', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { widthScale: 1 });
    expect(s.added).toHaveLength(1);
    expect(collectionOf(s)).toBeInstanceOf(PolylineCollection);

    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);
    expect(col.length).toBe(2);
    expect(col.get(0).positions).toHaveLength(3);
  });

  it('attaches the { layerId, binary, featureIndex } pick id to every polyline', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { id: 'flows' });
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);
    const binary = BUSY_TILE.layers[0].features;
    for (let i = 0; i < col.length; i++) {
      expect(col.get(i).id).toEqual({
        layerId: 'flows',
        binary,
        featureIndex: i,
      });
    }
  });

  it('single-vertex features are skipped — a stroke needs a tangent', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene);
    layer.setTiles([
      flowTile({
        numBuckets: 2,
        paths: [
          [10, 45, 10.01, 45],
          [11, 46],
        ],
        values: [
          [5, 5, 5, 5],
          [5, 5],
        ],
      }),
    ]);
    expect(collectionOf(s).length).toBe(1);
  });

  it('an empty publish holds the previous ribbons instead of blanking the frame', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene);
    layer.setTiles([BUSY_TILE]);
    const before = collectionOf(s).get(0);

    layer.setTiles([]); // the decode gap between a viewport change and the first tile

    expect(collectionOf(s).length).toBe(2);
    expect(collectionOf(s).get(0)).toBe(before);
  });

  it('a tile with no flow matrix is an empty build, not a partial one', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene);
    layer.setTiles([BUSY_TILE]);
    const plain = flowTile({
      numBuckets: 4,
      paths: [[20, 10, 20.01, 10]],
      values: [[1, 1, 1, 1, 1, 1, 1, 1]],
    });
    delete (plain.layers[0].features as { vertexValueMatrix?: unknown })
      .vertexValueMatrix;

    layer.setTiles([plain]);
    expect(collectionOf(s).length).toBe(2); // the BUSY_TILE ribbons still stand
  });
});

describe('STTFlowStrokeLayer — width breathing', () => {
  it('widths the busiest vertex at the active bucket, sqrt by default', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { mode: 'none' });
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);

    layer.setTime(BUCKET(1)); // corridor 0 peaks at v1 = 9 → sqrt = 3
    expect(col.get(0).width).toBeCloseTo(3, 10);
    expect(col.get(0).show).toBe(true);

    layer.setTime(BUCKET(2)); // the peak MIGRATES to v0 = 16 → sqrt = 4
    expect(col.get(0).width).toBeCloseTo(4, 10);
  });

  it('honours widthExponent, widthScale and the pixel clamps', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, {
      mode: 'none',
      widthExponent: 1,
      widthScale: 2,
      maxWidthPx: 20,
    });
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);

    layer.setTime(BUCKET(1)); // 9 ** 1 * 2 = 18
    expect(col.get(0).width).toBeCloseTo(18, 10);

    layer.setTime(BUCKET(2)); // 16 * 2 = 32, clamped to 20
    expect(col.get(0).width).toBeCloseTo(20, 10);
  });

  it('minFlow is the pulse: a quiet corridor goes invisible, not thin', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, {
      mode: 'none',
      minFlow: 10,
      minWidthPx: 2, // must NOT resurrect the quiet hour
    });
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);

    layer.setTime(BUCKET(1)); // peak 9 <= minFlow 10
    expect(col.get(0).show).toBe(false);

    layer.setTime(BUCKET(2)); // peak 16 > 10
    expect(col.get(0).show).toBe(true);
    expect(col.get(0).width).toBeCloseTo(4, 10);

    layer.setTime(BUCKET(1));
    expect(col.get(0).show).toBe(false); // and back off again
  });

  it('blends across the sub-step rather than snapping at bucket edges', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { mode: 'none' });
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);

    // Half a bucket past bucket 1 → blend f = 0.5 of buckets 1 and 2.
    // v0: 4*0.5 + 16*0.5 = 10; v1: 9*0.5 + 4*0.5 = 6.5 → peak 10.
    layer.setTime(BUCKET(1) + 125);
    expect(col.get(0).width).toBeCloseTo(Math.sqrt(10), 6);
  });

  it('recomputes widths only when the sub-step advances', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { mode: 'none' });
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);

    layer.setTime(BUCKET(1));
    const settled = col.get(0).width;
    col.get(0).width = 999; // a write the layer must NOT undo within the sub-step
    layer.setTime(BUCKET(1) + 1);
    expect(col.get(0).width).toBe(999);

    layer.setTime(BUCKET(2)); // crossing a sub-step reasserts the real width
    expect(col.get(0).width).not.toBe(999);
    expect(col.get(0).width).toBeGreaterThan(settled);
  });

  it('a rebuild forces the next frame to recompute widths', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { mode: 'none' });
    layer.setTiles([BUSY_TILE]);
    layer.setTime(BUCKET(2));
    layer.setTiles([BUSY_TILE]); // fresh polylines, same playhead
    layer.setTime(BUCKET(2));
    expect(collectionOf(s).get(0).width).toBeCloseTo(4, 10);
  });
});

describe('STTFlowStrokeLayer — the twin ribbon', () => {
  it('offsets A→B and B→A to opposite sides of the shared centreline', () => {
    const build = (offsetWidths: number): Cartesian3[][] => {
      const s = stubScene();
      const layer = new STTFlowStrokeLayer(s.scene, {
        offsetWidths,
        offsetMetersPerPixel: 10,
        widthScale: 4,
      });
      layer.setTiles([BUSY_TILE]);
      const col = collectionOf(s);
      return [col.get(0).positions, col.get(1).positions];
    };

    const [centreA, centreB] = build(0);
    const [offA, offB] = build(1);

    // Corridor 0 runs west→east and corridor 1 east→west over the SAME three
    // vertices, so corridor 0's vertex 0 and corridor 1's LAST vertex are the
    // same street point.
    expect(Cartesian3.distance(centreA[0], centreB[2])).toBeLessThan(1e-6);

    const vecA = Cartesian3.subtract(offA[0], centreA[0], new Cartesian3());
    const vecB = Cartesian3.subtract(offB[2], centreB[2], new Cartesian3());
    const shiftA = Cartesian3.magnitude(vecA);
    const shiftB = Cartesian3.magnitude(vecB);
    expect(shiftA).toBeGreaterThan(1); // metres — a real, visible gap
    expect(shiftB).toBeGreaterThan(1);

    // OPPOSITE SIDES: the two shifts are anti-parallel. Nothing pairs the
    // corridors — reversing the vertex order flips the tangent, which flips the
    // left normal. That is the whole twin-ribbon mechanism.
    const dot = Cartesian3.dot(
      Cartesian3.normalize(vecA, new Cartesian3()),
      Cartesian3.normalize(vecB, new Cartesian3()),
    );
    expect(dot).toBeCloseTo(-1, 6);

    // Magnitudes are NOT equal: each corridor's gap is sized by its OWN
    // rush-hour width (refPeak 16 → sqrt 4, vs refPeak 1 → 1), so the busy
    // direction sits further out. That is the baked-offset deviation from
    // deck's per-frame shader offset, made visible.
    // (precision 5: the metre delta uses a MEAN metres-per-degree, so the two
    // shifts differ from the exact ratio by sub-micrometre ellipsoid curvature.)
    expect(shiftA / shiftB).toBeCloseTo(4, 5);
  });

  it('offsetWidths 0 puts both directions on the centreline', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, {
      offsetWidths: 0,
      widthScale: 4,
    });
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);
    expect(
      Cartesian3.distance(col.get(0).positions[0], col.get(1).positions[2]),
    ).toBeLessThan(1e-6);
  });

  it('picks report the street point, not the shifted ribbon', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, {
      id: 'flows',
      offsetWidths: 2,
      offsetMetersPerPixel: 10,
      widthScale: 4,
    });
    layer.setTiles([BUSY_TILE]);
    s.picked = {
      id: {
        layerId: 'flows',
        binary: BUSY_TILE.layers[0].features,
        featureIndex: 0,
      },
    };
    expect(layer.pick(4, 5)?.coordinate).toEqual([10, 45]);
  });
});

// ---------------------------------------------------------------------------
// The time-filter oracle sweep (mirrors test/time-filter-oracle.test.ts)
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

// A coprime stride across and beyond every feature, PLUS the exact boundary
// instants — the stride alone never lands ON a startTime, the only place
// wake/trail reach alpha 1.
const PLAYHEADS: number[] = [];
for (let t = -200; t <= 1600; t += 37) PLAYHEADS.push(t);
for (const b of [...STARTS, ...ENDS]) PLAYHEADS.push(b - 1, b, b + 1);

const SWEEP_TILE = flowTile({
  numBuckets: 4,
  paths: STARTS.map((_, i) => [10 + i * 0.01, 45, 10 + i * 0.01, 45.01]),
  values: STARTS.map((_, i) => [1 + i, 2, 3, 4, 2, 3, 4, 1 + i]),
  startTimes: STARTS,
  endTimes: ENDS,
});

describe('STTFlowStrokeLayer — alpha is the shared timeFilterAlpha oracle', () => {
  for (const { mode, params } of MODES) {
    it(`${mode} ${JSON.stringify(params)} matches the oracle at every playhead`, () => {
      const s = stubScene();
      const layer = new STTFlowStrokeLayer(s.scene, {
        mode,
        timeFilter: params,
        color: { type: 'constant', color: [10, 20, 30, 255] },
      });
      layer.setTiles([SWEEP_TILE]);
      const col = collectionOf(s);
      expect(col.length).toBe(STARTS.length);

      for (const p of PLAYHEADS) {
        layer.setTime(TIME_OFFSET + p);
        for (let f = 0; f < STARTS.length; f++) {
          const expected = timeFilterAlpha(mode, p, STARTS[f], ENDS[f], params);
          expect(col.get(f).material.uniforms.color.alpha).toBeCloseTo(
            expected,
            6,
          );
        }
      }
    });
  }

  it('scales the oracle by the base colour alpha', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, {
      mode: 'none',
      color: { type: 'constant', color: [10, 20, 30, 128] },
    });
    layer.setTiles([BUSY_TILE]);
    const c = collectionOf(s).get(0).material.uniforms.color;
    layer.setTime(BUCKET(1));
    expect(c.alpha).toBeCloseTo(128 / 255, 10);
    expect(c.red).toBeCloseTo(10 / 255, 10);
    expect(c.green).toBeCloseTo(20 / 255, 10);
    expect(c.blue).toBeCloseTo(30 / 255, 10);
  });

  it('every corridor gets its OWN material uniform — no shared scratch aliasing', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, {
      mode: 'window',
      timeFilter: { windowHalf: 50 },
    });
    layer.setTiles([SWEEP_TILE]);
    const col = collectionOf(s);
    layer.setTime(TIME_OFFSET + 130); // inside feature 1's window, outside feature 3's
    const alphas = [0, 1, 2, 3].map(
      (i) => col.get(i).material.uniforms.color.alpha as number,
    );
    expect(new Set(alphas).size).toBeGreaterThan(1);
    expect(col.get(0).material).not.toBe(col.get(1).material);
  });

  it('skips the write when alpha is unchanged since the last frame', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, {
      mode: 'cumulative',
      timeFilter: { fadeIn: 0 },
    });
    layer.setTiles([BUSY_TILE]);
    const c = collectionOf(s).get(0).material.uniforms.color;

    layer.setTime(BUCKET(3));
    expect(c.alpha).toBeCloseTo(1, 10);
    c.alpha = 0.123; // a write the layer must not undo while alpha is unchanged
    layer.setTime(BUCKET(3) + 1);
    expect(c.alpha).toBe(0.123);
  });
});

describe('STTFlowStrokeLayer — picking and teardown', () => {
  it('returns null for a miss or another layer’s id', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { id: 'flows' });
    layer.setTiles([BUSY_TILE]);

    s.picked = undefined;
    expect(layer.pick(1, 2)).toBeNull();
    s.picked = {
      id: { layerId: 'someone-else', binary: null, featureIndex: 0 },
    };
    expect(layer.pick(1, 2)).toBeNull();
  });

  it('reports the feature index, layer id and screen point on a hit', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene, { id: 'flows' });
    layer.setTiles([BUSY_TILE]);
    s.picked = {
      id: {
        layerId: 'flows',
        binary: BUSY_TILE.layers[0].features,
        featureIndex: 1,
      },
    };
    const hit = layer.pick(7, 9);
    expect(hit).not.toBeNull();
    expect(hit?.index).toBe(1);
    expect(hit?.layerId).toBe('flows');
    expect(hit?.screen).toEqual([7, 9]);
    expect(hit?.coordinate).toEqual([10.02, 45]);
  });

  it('dispose removes the collection it registered', () => {
    const s = stubScene();
    const layer = new STTFlowStrokeLayer(s.scene);
    layer.setTiles([BUSY_TILE]);
    const col = collectionOf(s);
    layer.dispose();
    expect(s.removed).toEqual([col]);
    expect(layer.pick(1, 1)).toBeNull();
  });
});
