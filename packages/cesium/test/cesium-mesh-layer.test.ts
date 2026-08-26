// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * Unit tests for `STTMeshLayer` — the Cesium-facing half of the `mesh` kind.
 *
 * What is genuinely testable in Node, and what is not: a real `Scene` needs a
 * WebGL context and a real `Model` needs that PLUS a glTF fetch, so the layer is
 * driven against a stub `Scene` (a primitives host, exactly the package's
 * `stubScene` idiom) and a stand-in model loader. Everything BETWEEN those two —
 * pooling, the async attach/discard lifecycle, model reuse across rebuilds, the
 * per-frame pose write, the skip-if-unchanged guard, picking, disposal — is the
 * layer's own logic and is exercised for real. The `PrimitiveCollection` the
 * layer manages IS the real Cesium class.
 *
 * The stand-in model is not a shortcut: it deliberately COPIES on the `color`
 * setter and CLONES the `modelMatrix` it is constructed with, because that is
 * what Cesium's `Model` does, and both behaviours are load-bearing —
 * the first makes one shared scratch `Color` safe, the second is why the layer
 * must re-point `model.modelMatrix` at the entry's own matrix on attach. A
 * stand-in that stored references instead would let both bugs pass.
 *
 * The five claims this file is really here to defend:
 *   1. ONE model per ACTIVE track per frame — never one per keyframe (the
 *      "train of parked cars").
 *   2. Build-before-teardown: an empty tile set must not blank the scene.
 *   3. A model that has not resolved does not draw, and starts drawing already
 *      correctly posed when it does — including while the clock is PAUSED.
 *   4. Every entry owns its own `Matrix4` (the shared-scratch bug would pose
 *      every vehicle at the last track's pose).
 *   5. Nothing in flight outlives its pool: a model resolving into a rebuilt or
 *      disposed layer is destroyed rather than leaked into the scene.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  Cartesian3,
  Color,
  ColorBlendMode,
  Matrix4,
  PrimitiveCollection,
  Transforms,
  type Model,
  type Scene,
} from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { NULL_CATEGORY_INDEX } from '@poopdeck.gl/core/style';
import {
  STTMeshLayer,
  type MeshModelLoader,
  type MeshModelRequest,
  type MeshPickId,
} from '../src/cesium-mesh-layer';

// ─── scene + GPU stand-ins ───────────────────────────────────────────────────

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  pickResult: unknown;
  renderRequests: number;
}

function stubScene(): StubScene {
  const state: StubScene = {
    scene: undefined as unknown as Scene,
    added: [],
    removed: [],
    pickResult: undefined,
    renderRequests: 0,
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
      return state.pickResult;
    },
    requestRender(): void {
      state.renderRequests++;
    },
  } as unknown as Scene;
  return state;
}

/**
 * A `Model` stand-in with Cesium's OWN aliasing semantics: `color` copies into
 * an internal instance (`Color.clone(value, this._color)`), `modelMatrix` is a
 * plain field, and the constructor clones whatever matrix it is handed.
 */
class FakeModel {
  modelMatrix: Matrix4;
  show = false;
  id: unknown = undefined;
  destroyed = false;
  colorWrites = 0;
  private readonly _color = new Color(0, 0, 0, 0);

  constructor(matrix: Matrix4) {
    this.modelMatrix = Matrix4.clone(matrix, new Matrix4());
  }
  get color(): Color {
    return this._color;
  }
  set color(v: Color) {
    this.colorWrites++;
    Color.clone(v, this._color);
  }
  destroy(): void {
    this.destroyed = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  asModel(): Model {
    return this as unknown as Model;
  }
}

interface StubLoader {
  load: MeshModelLoader;
  requests: MeshModelRequest[];
  models: FakeModel[];
  /** Deferred mode only: resolve every outstanding load. */
  release(): void;
  /** Deferred mode only: reject the next outstanding load. */
  fail(): void;
}

function stubLoader(mode: 'immediate' | 'deferred' = 'immediate'): StubLoader {
  const requests: MeshModelRequest[] = [];
  const models: FakeModel[] = [];
  const waiting: {
    model: FakeModel;
    resolve: (m: Model) => void;
    reject: (e: Error) => void;
  }[] = [];
  const load: MeshModelLoader = (req) => {
    requests.push(req);
    const model = new FakeModel(req.modelMatrix);
    model.id = req.id;
    models.push(model);
    if (mode === 'immediate') return Promise.resolve(model.asModel());
    return new Promise<Model>((resolve, reject) => {
      waiting.push({ model, resolve, reject });
    });
  };
  return {
    load,
    requests,
    models,
    release(): void {
      const pending = waiting.splice(0, waiting.length);
      for (const w of pending) w.resolve(w.model.asModel());
    },
    fail(): void {
      const w = waiting.shift();
      w?.reject(new Error('404'));
    },
  };
}

// ─── tile fixture (self-contained; mirrors an AV `objects/` tile) ────────────

interface Snapshot {
  lon: number;
  lat: number;
  t: number;
  trackId?: string | null;
  category?: string;
  heading?: number;
  length?: number;
  width?: number;
  height?: number;
  speed?: number;
}

function categorical(values: (string | null | undefined)[]): {
  indices: Uint16Array;
  categories: string[];
} {
  const categories: string[] = [];
  const indices = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      indices[i] = NULL_CATEGORY_INDEX;
      continue;
    }
    let at = categories.indexOf(v);
    if (at < 0) {
      at = categories.length;
      categories.push(v);
    }
    indices[i] = at;
  }
  return { indices, categories };
}

function objectsTile(
  snaps: Snapshot[],
  timeOffset = 0,
  omit: readonly string[] = [],
): Tile {
  const n = snaps.length;
  const positions = new Float64Array(n * 2);
  const startTimes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = snaps[i].lon;
    positions[i * 2 + 1] = snaps[i].lat;
    startTimes[i] = snaps[i].t;
  }
  const num = (k: 'heading' | 'length' | 'width' | 'height' | 'speed') =>
    new Float32Array(snaps.map((s) => s[k] ?? 0));
  const categoricalProps: BinaryFeatures['categoricalProps'] = {};
  if (!omit.includes('track_id')) {
    categoricalProps.track_id = categorical(snaps.map((s) => s.trackId));
  }
  categoricalProps.category = categorical(
    snaps.map((s) => s.category ?? 'car'),
  );
  const features: BinaryFeatures = {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(n),
    startTimes,
    endTimes: startTimes.slice(),
    timeOffset,
    numericProps: {
      heading: num('heading'),
      length: num('length'),
      width: num('width'),
      height: num('height'),
      speed: num('speed'),
    },
    categoricalProps,
    vectorProps: {},
  };
  return {
    id: { z: 16, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'objects',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

const T0 = 1_700_000_000_000;

/** Two cars, three keyframes each — the shape the "train" bug shows up in. */
function twoCarTile(): Tile {
  return objectsTile(
    [
      {
        lon: 4.9,
        lat: 52.37,
        t: 0,
        trackId: 'a',
        length: 4,
        width: 2,
        height: 1.5,
      },
      {
        lon: 4.901,
        lat: 52.37,
        t: 500,
        trackId: 'a',
        length: 4,
        width: 2,
        height: 1.5,
      },
      {
        lon: 4.902,
        lat: 52.37,
        t: 1000,
        trackId: 'a',
        length: 4,
        width: 2,
        height: 1.5,
      },
      {
        lon: 5.0,
        lat: 52.0,
        t: 0,
        trackId: 'b',
        category: 'truck',
        length: 9,
        width: 3,
        height: 3,
      },
      {
        lon: 5.001,
        lat: 52.0,
        t: 500,
        trackId: 'b',
        category: 'truck',
        length: 9,
        width: 3,
        height: 3,
      },
      {
        lon: 5.002,
        lat: 52.0,
        t: 1000,
        trackId: 'b',
        category: 'truck',
        length: 9,
        width: 3,
        height: 3,
      },
    ],
    T0,
  );
}

const MODELS = { car: '/car.glb', truck: '/truck.glb' };

// ─── construction ────────────────────────────────────────────────────────────

describe('STTMeshLayer — construction', () => {
  it('registers ONE PrimitiveCollection into scene.primitives', () => {
    const { scene, added } = stubScene();
    const layer = new STTMeshLayer(scene, { models: MODELS });
    expect(added).toHaveLength(1);
    expect(added[0]).toBeInstanceOf(PrimitiveCollection);
    expect(layer.id).toBe('stt-cesium-meshes');
  });

  it('takes an explicit id', () => {
    const { scene } = stubScene();
    expect(new STTMeshLayer(scene, { id: 'fleet' }).id).toBe('fleet');
  });

  it('hands the loader deck-matching tint semantics by default', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    const req = loader.requests[0];
    // HIGHLIGHT is a multiply — the same thing deck's getColor tint does.
    expect(req.colorBlendMode).toBe(ColorBlendMode.HIGHLIGHT);
    expect(req.backFaceCulling).toBe(true);
    // Seeded transparent; the first setTime writes the real alpha.
    expect(req.color.alpha).toBe(0);
  });
});

// ─── one model per TRACK ─────────────────────────────────────────────────────

describe('STTMeshLayer — one model per TRACK, not per keyframe', () => {
  it('loads and shows exactly one model per tracked object', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    // 6 features in, 2 models out.
    expect(loader.requests).toHaveLength(2);
    expect(collection(layer).length).toBe(2);
    expect(loader.requests.map((r) => r.url).sort()).toEqual([
      '/car.glb',
      '/truck.glb',
    ]);
  });

  it('still emits ONE model per track when the window spans every keyframe', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500); // mid-span: all three keyframes are "near"
    expect(loader.models.filter((m) => m.show)).toHaveLength(2);
  });

  it('never loads anything for a category with no URL', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: { truck: '/truck.glb' }, // no `car`, and no default model
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    expect(loader.requests.map((r) => r.url)).toEqual(['/truck.glb']);
    // The car track is still pooled and sampled — it just never draws. No
    // placeholder cube stands in for it.
    layer.setTime(T0 + 500);
    expect(collection(layer).length).toBe(1);
  });
});

// ─── build before teardown ───────────────────────────────────────────────────

describe('STTMeshLayer — build BEFORE teardown', () => {
  it('keeps the previous models when the new tile set is empty', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    const before = loader.models.slice();

    layer.setTiles([]); // the decode-gap transient
    layer.setTiles([objectsTile([], T0)]);

    expect(collection(layer).length).toBe(2);
    expect(before.every((m) => !m.destroyed)).toBe(true);
    expect(loader.requests).toHaveLength(2); // nothing re-fetched either
    // The prior timeOrigin survived, so the playhead still resolves.
    layer.setTime(T0 + 500);
    expect(loader.models.filter((m) => m.show)).toHaveLength(2);
  });
});

// ─── model reuse across rebuilds ─────────────────────────────────────────────

describe('STTMeshLayer — models are reused, not re-fetched', () => {
  it('keeps each track model across a rebuild of the same pool', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    const first = loader.models.slice();

    layer.setTiles([twoCarTile()]); // tile churn: same tracks, same URLs
    await layer.modelsSettled();

    expect(loader.requests).toHaveLength(2); // NOT 4
    expect(first.every((m) => !m.destroyed)).toBe(true);
    expect(collection(layer).length).toBe(2);
  });

  it('keeps a reused model standing where it was, not at the earth centre', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);
    const posed = Matrix4.clone(loader.models[0].modelMatrix, new Matrix4());

    layer.setTiles([twoCarTile()]);
    // No setTime yet — a frame rendered right now must not draw at (0,0,0).
    expect(Matrix4.equals(loader.models[0].modelMatrix, posed)).toBe(true);
  });

  it('destroys a track that LEFT the pool', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    const truck = loader.models.find(
      (m) => (m.id as MeshPickId).trackId === 'b',
    )!;

    layer.setTiles([
      objectsTile([{ lon: 4.9, lat: 52.37, t: 0, trackId: 'a' }], T0),
    ]);
    await layer.modelsSettled();

    expect(truck.destroyed).toBe(true);
    expect(collection(layer).length).toBe(1);
  });

  it('replaces a model whose category now resolves to a different URL', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    const tile = objectsTile(
      [{ lon: 4.9, lat: 52.37, t: 0, trackId: 'a', category: 'car' }],
      T0,
    );
    layer.setTiles([tile]);
    await layer.modelsSettled();
    const original = loader.models[0];

    // Same track id, now a truck — a different glTF entirely.
    layer.setTiles([
      objectsTile(
        [{ lon: 4.9, lat: 52.37, t: 0, trackId: 'a', category: 'truck' }],
        T0,
      ),
    ]);
    await layer.modelsSettled();

    expect(original.destroyed).toBe(true);
    expect(loader.requests.map((r) => r.url)).toEqual([
      '/car.glb',
      '/truck.glb',
    ]);
  });
});

// ─── the per-frame pose ──────────────────────────────────────────────────────

describe('STTMeshLayer — setTime poses one instance per active track', () => {
  it('writes the LOCAL east-north-up frame, matching Cesium own transform', async () => {
    // A unit-dimensioned, heading-0 pose IS eastNorthUpToFixedFrame. This is the
    // cross-check for the Cesium-free `enuBasis`: an identity rotation would
    // aim the model at the ECEF pole, which is visibly wrong away from (0,0).
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([
      objectsTile(
        [
          {
            lon: 4.9,
            lat: 52.37,
            t: 0,
            trackId: 'a',
            length: 1,
            width: 1,
            height: 1,
          },
          {
            lon: 4.9,
            lat: 52.37,
            t: 1000,
            trackId: 'a',
            length: 1,
            width: 1,
            height: 1,
          },
        ],
        T0,
      ),
    ]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);

    const expected = Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(4.9, 52.37, 0),
    );
    const got = loader.models[0].modelMatrix;
    for (let i = 0; i < 12; i++) {
      expect(got[i]).toBeCloseTo(expected[i], 9); // rotation columns
    }
    for (let i = 12; i < 15; i++) {
      expect(got[i]).toBeCloseTo(expected[i], 3); // metres
    }
  });

  it('interpolates BETWEEN keyframes rather than snapping to one', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([
      objectsTile(
        [
          {
            lon: 0,
            lat: 0,
            t: 0,
            trackId: 'a',
            length: 1,
            width: 1,
            height: 1,
          },
          {
            lon: 1,
            lat: 0,
            t: 1000,
            trackId: 'a',
            length: 1,
            width: 1,
            height: 1,
          },
        ],
        T0,
      ),
    ]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);
    const mid = Cartesian3.fromDegrees(0.5, 0, 0);
    const m = loader.models[0].modelMatrix;
    expect(m[12]).toBeCloseTo(mid.x, 3);
    expect(m[13]).toBeCloseTo(mid.y, 3);
    expect(m[14]).toBeCloseTo(mid.z, 3);
  });

  it('gives every entry its OWN matrix (a shared scratch would alias them)', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);
    const [a, b] = loader.models;
    expect(a.modelMatrix).not.toBe(b.modelMatrix);
    // The two cars are ~40 km apart; a shared scratch would put them together.
    expect(Math.abs(a.modelMatrix[13] - b.modelMatrix[13])).toBeGreaterThan(
      1000,
    );
  });

  it('hides a track whose span the playhead has left', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);
    expect(loader.models.every((m) => m.show)).toBe(true);
    layer.setTime(T0 + 60_000);
    expect(loader.models.some((m) => m.show)).toBe(false);
  });

  it('is a no-op at a playhead that did not move', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);
    // Vandalize the matrix; a resample would overwrite it, the early return
    // leaves it alone. (A paused clock renders every frame.)
    Matrix4.clone(Matrix4.IDENTITY, loader.models[0].modelMatrix);
    layer.setTime(T0 + 500);
    expect(Matrix4.equals(loader.models[0].modelMatrix, Matrix4.IDENTITY)).toBe(
      true,
    );
  });

  it('skips the colour write when alpha is unchanged', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
      // No fade ramp, so alpha is a flat 1 across the whole span.
      fadeInDuration: 0,
      fadeOutDuration: 0,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 400);
    const writes = loader.models[0].colorWrites;
    expect(writes).toBe(1);
    layer.setTime(T0 + 600);
    layer.setTime(T0 + 700);
    // Cesium Model.color setter resets draw commands across the translucency
    // boundary, so an unguarded write would be expensive as well as pointless.
    expect(loader.models[0].colorWrites).toBe(writes);
  });

  it('ramps the colour again when the fade moves', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
      fadeInDuration: 400,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 100);
    const early = loader.models[0].color.alpha;
    layer.setTime(T0 + 300);
    expect(loader.models[0].color.alpha).toBeGreaterThan(early);
    expect(loader.models[0].colorWrites).toBe(2);
  });

  it('multiplies the category alpha by opacity', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      opacity: 0.25,
      colorMapping: { car: [10, 20, 30, 200] },
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);
    const c = loader.models[0].color;
    expect(c.alpha).toBeCloseTo((200 / 255) * 0.25, 6);
    expect(c.red).toBeCloseTo(10 / 255, 6);
    expect(c.blue).toBeCloseTo(30 / 255, 6);
  });
});

// ─── asynchronous arrival ────────────────────────────────────────────────────

describe('STTMeshLayer — models arrive asynchronously', () => {
  it('does not draw a track whose model has not resolved', () => {
    const { scene } = stubScene();
    const loader = stubLoader('deferred');
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    layer.setTime(T0 + 500); // the frame loop keeps running regardless
    expect(collection(layer).length).toBe(0);
    expect(loader.models.every((m) => !m.show)).toBe(true);
  });

  it('draws it, already posed, the moment it resolves — with the clock PAUSED', async () => {
    const { scene } = stubScene();
    const loader = stubLoader('deferred');
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
      fadeInDuration: 0,
      fadeOutDuration: 0,
    });
    layer.setTiles([twoCarTile()]);
    layer.setTime(T0 + 500);
    // No further setTime: a paused clock short-circuits it, so the attach path
    // itself has to apply the current pose and appearance.
    loader.release();
    await layer.modelsSettled();

    expect(collection(layer).length).toBe(2);
    for (const m of loader.models) {
      expect(m.show).toBe(true);
      expect(Matrix4.equals(m.modelMatrix, Matrix4.IDENTITY)).toBe(false);
    }
  });

  it('asks a requestRenderMode scene to redraw when a model lands', async () => {
    const state = stubScene();
    const loader = stubLoader('deferred');
    const layer = new STTMeshLayer(state.scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    loader.release();
    await layer.modelsSettled();
    expect(state.renderRequests).toBe(2);
  });

  it('DESTROYS a model that resolves into a pool that no longer exists', async () => {
    const { scene } = stubScene();
    const loader = stubLoader('deferred');
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    const orphans = loader.models.slice();
    // A rebuild lands before the glTFs do.
    layer.setTiles([twoCarTile()]);
    loader.release();
    await layer.modelsSettled();

    expect(orphans.every((m) => m.destroyed)).toBe(true);
    // ...and the collection holds only the models of the CURRENT generation.
    expect(collection(layer).length).toBe(2);
    expect(loader.models.slice(2).every((m) => !m.destroyed)).toBe(true);
  });

  it('records a failed load instead of throwing it into the frame loop', async () => {
    const { scene } = stubScene();
    const loader = stubLoader('deferred');
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    loader.fail(); // one 404
    loader.release(); // the other resolves fine
    await layer.modelsSettled();

    expect(layer.modelErrors).toBe(1);
    expect(collection(layer).length).toBe(1);
    // The failed track is still pooled and sampled; it just never draws.
    expect(() => layer.setTime(T0 + 500)).not.toThrow();
  });
});

// ─── telemetry ───────────────────────────────────────────────────────────────

describe('STTMeshLayer — surfaced build warnings', () => {
  it('reports a missing track-id column as a field, not a console warning', () => {
    const { scene } = stubScene();
    const layer = new STTMeshLayer(scene, { model: '/car.glb' });
    layer.setTiles([
      objectsTile(
        [
          { lon: 4.9, lat: 52.37, t: 0 },
          { lon: 4.91, lat: 52.37, t: 100 },
        ],
        T0,
        ['track_id'],
      ),
    ]);
    expect(layer.trackIdMissing).toBe(true);
    expect(layer.attitudeMissing).toBe(false);
  });

  it('reports an unusable attitude column when one was asked for', () => {
    const { scene } = stubScene();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      quaternionColumn: 'attitude',
    });
    layer.setTiles([twoCarTile()]);
    expect(layer.attitudeMissing).toBe(true);
  });
});

// ─── picking ─────────────────────────────────────────────────────────────────

describe('STTMeshLayer — picking', () => {
  async function picked(): Promise<{
    layer: STTMeshLayer;
    state: StubScene;
    loader: StubLoader;
  }> {
    const state = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(state.scene, {
      models: MODELS,
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.setTime(T0 + 500);
    return { layer, state, loader };
  }

  it('joins the archive own columns and the LIVE pose', async () => {
    const { layer, state, loader } = await picked();
    state.pickResult = { id: loader.models[0].id };
    const hit = layer.pick(10, 20)!;
    expect(hit).not.toBeNull();
    expect(hit.layerId).toBe('stt-cesium-meshes');
    expect(hit.screen).toEqual([10, 20]);
    expect((hit.object as Record<string, unknown>).track_id).toBe('a');
    // meta is the AV inspector row, interpolated at the playhead.
    expect(hit.meta!.track_id).toBe('a');
    expect(hit.coordinate![0]).toBeCloseTo(4.901, 6);
  });

  it('ignores a hit belonging to another layer, and a miss', async () => {
    const { layer, state } = await picked();
    state.pickResult = { id: { layerId: 'someone-else' } };
    expect(layer.pick(1, 1)).toBeNull();
    state.pickResult = undefined;
    expect(layer.pick(1, 1)).toBeNull();
    state.pickResult = {};
    expect(layer.pick(1, 1)).toBeNull();
  });

  it('reports meta alone for a track with no resolvable id', async () => {
    const state = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(state.scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([
      objectsTile([{ lon: 4.9, lat: 52.37, t: 0 }], T0, ['track_id']),
    ]);
    await layer.modelsSettled();
    layer.setTime(T0);
    state.pickResult = { id: loader.models[0].id };
    const hit = layer.pick(3, 4)!;
    expect(hit.object).toBeNull();
    expect(hit.index).toBe(-1);
    expect(hit.meta).toBeDefined();
  });
});

// ─── disposal ────────────────────────────────────────────────────────────────

describe('STTMeshLayer — dispose', () => {
  it('removes the collection it added', async () => {
    const state = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(state.scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.dispose();
    expect(state.removed).toHaveLength(1);
    expect(state.removed[0]).toBe(state.added[0]);
  });

  it('destroys a model that resolves AFTER disposal', async () => {
    const { scene } = stubScene();
    const loader = stubLoader('deferred');
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    layer.dispose();
    loader.release();
    await layer.modelsSettled();
    // The collection never held these, so nothing else would ever free them.
    expect(loader.models.every((m) => m.destroyed)).toBe(true);
  });

  it('leaves setTime harmless afterwards', async () => {
    const { scene } = stubScene();
    const loader = stubLoader();
    const layer = new STTMeshLayer(scene, {
      model: '/car.glb',
      loadModel: loader.load,
    });
    layer.setTiles([twoCarTile()]);
    await layer.modelsSettled();
    layer.dispose();
    expect(() => layer.setTime(T0 + 500)).not.toThrow();
  });
});

// ─── the structural claim: no time-filter oracle on this path ────────────────

describe('STTMeshLayer — EXEMPT_SETTIME, and honestly so', () => {
  it('never calls the time-filter oracle', () => {
    // One feature per KEYFRAME means a window alpha would draw N models for one
    // object. This layer animates POSE instead, which is exactly the exemption
    // `test/time-filter-oracle.test.ts` records for it.
    const src = readFileSync(
      new URL('../src/cesium-mesh-layer.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain('timeFilterAlpha(');
    expect(/from\s+'@poopdeck\.gl\/core\/time-filter'/.test(src)).toBe(false);
    expect(src).toContain('sampleTrack(');
  });
});

/** The real Cesium collection the layer registered — `added[0]`. */
function collection(layer: STTMeshLayer): PrimitiveCollection {
  return (layer as unknown as { collection: PrimitiveCollection }).collection;
}
