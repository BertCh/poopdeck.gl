// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * Unit tests for `STTBoundingBoxLayer` against REAL Cesium objects under Node.
 *
 * The package's `vitest.config.ts` runs in the `node` environment and the
 * comment there is explicit that `@cesium/engine` loads fine; what does not work
 * is anything needing a live WebGL context. So the layer is constructed for
 * real, against a `stubScene` that only stands in for `scene.primitives` and
 * `scene.pick`, and every assertion below reads the ACTUAL `PrimitiveCollection`
 * / `Primitive` / `Matrix4` the layer built. Two GPU-only facts are stubbed:
 * `Primitive.ready` (true only after a render pass) and
 * `getGeometryInstanceAttributes` (the batch table, which exists only after
 * one) — see `armPrimitive`.
 *
 * What is being pinned, in order of how badly it would hurt:
 *
 *   1. ONE PRIMITIVE PER TRACK. Feed 3 objects x 4 keyframes and get 3 boxes,
 *      not 12. This is the "train of boxes" regression that motivated the deck
 *      rewrite, and it is the reason this layer has no time-window filter.
 *   2. NO ALIASING OF `modelMatrix`. `Primitive.modelMatrix` is a plain FIELD,
 *      not a copying setter like `PointPrimitive.color`, so the package's usual
 *      one-shared-scratch idiom would leave every box wearing the last track's
 *      pose. Each entry must own its matrix.
 *   3. BUILD BEFORE TEARDOWN — an empty publish leaves the standing boxes alone.
 *   4. The batch-table alpha write, its skip-if-unchanged guard, and the rule
 *      that `lastAlpha` may not advance on a frame where the write could not
 *      land (no batch table before the first render).
 *   5. That the Cesium-free frame in `lib/tracked-boxes.ts` agrees with Cesium's
 *      OWN `Transforms.eastNorthUpToFixedFrame` and `Cartesian3.fromDegrees` —
 *      the cross-check `tracked-boxes.test.ts` deliberately cannot make,
 *      because that file must import no Cesium.
 */

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  BoxOutlineGeometry,
  Cartesian3,
  Ellipsoid,
  Matrix4,
  Primitive,
  PrimitiveCollection,
  Transforms,
  type Scene,
} from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { NULL_CATEGORY_INDEX } from '@poopdeck.gl/core/style';
import { STTBoundingBoxLayer } from '../src/cesium-bounding-box-layer';
import { DEFAULT_BOX_FADE_MS } from '../src/lib/tracked-boxes';

// ─── scene + GPU stand-ins ───────────────────────────────────────────────────

interface PickId {
  layerId: string;
  binary: BinaryFeatures | null;
  featureIndex: number;
  trackId: string;
}

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  /** What the next `scene.pick` returns; set per test. */
  pickResult: { id?: PickId } | undefined;
}

function stubScene(): StubScene {
  const state: StubScene = {
    added: [],
    removed: [],
    pickResult: undefined,
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
      return state.pickResult;
    },
  } as unknown as Scene;
  return state;
}

/**
 * Stand in for the two things that exist only after a real render pass:
 * `ready`, and the batch table `getGeometryInstanceAttributes` reads.
 *
 * The `color` setter COPIES, exactly like Cesium's. That matters: the layer
 * writes one shared scratch `Uint8Array` for every entry, so a stand-in that
 * stored the reference would report the last write for all of them and the
 * per-box colour assertions would pass vacuously.
 */
function armPrimitive(prim: Primitive): Uint8Array {
  const bytes = new Uint8Array(4);
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = () =>
    ({
      get color(): Uint8Array {
        return bytes;
      },
      set color(v: Uint8Array) {
        bytes.set(v);
      },
    }) as never;
  return bytes;
}

function armAll(collection: PrimitiveCollection): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < collection.length; i++) {
    out.push(armPrimitive(collection.get(i) as Primitive));
  }
  return out;
}

function prims(added: unknown[]): PrimitiveCollection {
  return added[0] as PrimitiveCollection;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

interface Snapshot {
  lon: number;
  lat: number;
  /** TILE-RELATIVE ms; the absolute base is the tile's `timeOffset`. */
  t: number;
  trackId?: string | null;
  category?: string;
  heading?: number;
  length?: number;
  width?: number;
  height?: number;
  speed?: number;
}

function categorical(values: (string | null | undefined)[]) {
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
  omitTrackId = false,
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
  const categoricalProps: BinaryFeatures['categoricalProps'] = {
    category: categorical(snaps.map((s) => s.category ?? 'car')),
  };
  if (!omitTrackId) {
    categoricalProps.track_id = categorical(snaps.map((s) => s.trackId));
  }
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

/** 3 tracked objects x 4 keyframes = 12 features, spanning [T0, T0+3000]. */
function threeTracksFourKeyframes(): Tile {
  const snaps: Snapshot[] = [];
  const tracks = [
    { id: 'a', lon: 4.9, lat: 52.37, category: 'car' },
    { id: 'b', lon: 5.0, lat: 52.4, category: 'pedestrian' },
    { id: 'c', lon: 5.1, lat: 52.45, category: 'bicycle' },
  ];
  for (const tr of tracks) {
    for (let k = 0; k < 4; k++) {
      snaps.push({
        lon: tr.lon + k * 0.001,
        lat: tr.lat,
        t: k * 1000,
        trackId: tr.id,
        category: tr.category,
        heading: 0,
        length: 4.5,
        width: 1.9,
        height: 1.6,
        speed: 10,
      });
    }
  }
  return objectsTile(snaps, T0);
}

const COLORS = {
  car: [200, 30, 40, 255],
  pedestrian: [30, 200, 40, 255],
  bicycle: [30, 40, 200, 255],
} as const;

function makeLayer(options = {}) {
  const stub = stubScene();
  const layer = new STTBoundingBoxLayer(stub.scene, {
    colorMapping: COLORS as never,
    ...options,
  });
  return { stub, layer, collection: () => prims(stub.added) };
}

// ─── construction ────────────────────────────────────────────────────────────

describe('STTBoundingBoxLayer — construction', () => {
  it('registers a PrimitiveCollection into scene.primitives immediately', () => {
    const { stub } = makeLayer();
    expect(stub.added).toHaveLength(1);
    expect(stub.added[0]).toBeInstanceOf(PrimitiveCollection);
  });

  it('defaults its id and honours an override', () => {
    expect(makeLayer().layer.id).toBe('stt-cesium-boxes');
    expect(makeLayer({ id: 'boxes-2' }).layer.id).toBe('boxes-2');
  });

  it('draws solid BoxGeometry by default and outlines when asked', () => {
    const solid = makeLayer();
    solid.layer.setTiles([threeTracksFourKeyframes()]);
    const g = (solid.collection().get(0) as Primitive).geometryInstances as {
      geometry: unknown;
    };
    expect(g.geometry).toBeInstanceOf(BoxGeometry);

    const wire = makeLayer({ outline: true });
    wire.layer.setTiles([threeTracksFourKeyframes()]);
    const gw = (wire.collection().get(0) as Primitive).geometryInstances as {
      geometry: unknown;
    };
    expect(gw.geometry).toBeInstanceOf(BoxOutlineGeometry);
  });
});

// ─── the defining constraint ─────────────────────────────────────────────────

describe('STTBoundingBoxLayer — one primitive per TRACK', () => {
  it('draws 3 boxes for 3 objects x 4 keyframes, not 12', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    expect(collection().length).toBe(3);
  });

  it('stays at one box per object as more keyframes stream in', () => {
    // The "train of boxes" bug grew with the window; this one must not move.
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    const more = objectsTile(
      [0, 1, 2, 3].map((k) => ({
        lon: 4.91 + k * 0.001,
        lat: 52.37,
        t: k * 1000,
        trackId: 'a',
        category: 'car',
      })),
      T0 + 4000,
    );
    layer.setTiles([threeTracksFourKeyframes(), more]);
    expect(collection().length).toBe(3);
  });

  it('gives every un-grouped snapshot its own held box and flags the gap', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([
      objectsTile(
        [
          { lon: 1, lat: 1, t: 0 },
          { lon: 2, lat: 2, t: 100 },
        ],
        T0,
        true,
      ),
    ]);
    expect(collection().length).toBe(2);
    expect(layer.trackIdMissing).toBe(true);
  });

  it('seeds every box hidden and fully transparent until the first setTime', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    for (let i = 0; i < collection().length; i++) {
      const p = collection().get(i) as Primitive;
      expect(p.show).toBe(false);
      const inst = p.geometryInstances as {
        attributes: { color: { value: Uint8Array } };
      };
      expect(inst.attributes.color.value[3]).toBe(0);
    }
  });
});

// ─── setTiles ordering ───────────────────────────────────────────────────────

describe('STTBoundingBoxLayer — setTiles builds before it tears down', () => {
  it('holds the standing boxes when the new publish is empty', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    const before = collection().get(0);
    layer.setTiles([]);
    expect(collection().length).toBe(3);
    expect(collection().get(0)).toBe(before); // the very same primitives
  });

  it('holds them when the new tiles decode to no tracked object', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    layer.setTiles([objectsTile([], T0)]);
    expect(collection().length).toBe(3);
  });

  it('replaces everything when the new publish is non-empty', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    const before = collection().get(0);
    layer.setTiles([objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'z' }], T0)]);
    expect(collection().length).toBe(1);
    expect(collection().get(0)).not.toBe(before);
  });
});

// ─── pose ────────────────────────────────────────────────────────────────────

function translation(p: Primitive): Cartesian3 {
  return Matrix4.getTranslation(p.modelMatrix, new Cartesian3());
}

describe('STTBoundingBoxLayer — setTime poses one instance per ACTIVE track', () => {
  it('leaves each entry with its OWN Matrix4 — no shared-scratch aliasing', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    layer.setTime(T0 + 1500);
    const m0 = (collection().get(0) as Primitive).modelMatrix;
    const m1 = (collection().get(1) as Primitive).modelMatrix;
    const m2 = (collection().get(2) as Primitive).modelMatrix;
    expect(m0).not.toBe(m1);
    expect(m1).not.toBe(m2);
    // Three tracks 0.1 deg apart: if a shared scratch had leaked they would all
    // sit at the last one's pose.
    expect(Matrix4.equals(m0, m1)).toBe(false);
    expect(Matrix4.equals(m1, m2)).toBe(false);
  });

  it('poses the box where Cesium itself puts that lon/lat, lifted half a height', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([
      objectsTile(
        [
          { lon: 4.9, lat: 52.37, t: 0, trackId: 'a', height: 2 },
          { lon: 4.9, lat: 52.37, t: 2000, trackId: 'a', height: 2 },
        ],
        T0,
      ),
    ]);
    layer.setTime(T0 + 1000);
    const got = translation(collection().get(0) as Primitive);
    const ground = Cartesian3.fromDegrees(4.9, 52.37, 0);
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(ground, new Cartesian3());
    const want = Cartesian3.add(
      ground,
      Cartesian3.multiplyByScalar(up, 1, new Cartesian3()), // half of height 2
      new Cartesian3(),
    );
    expect(Cartesian3.distance(got, want)).toBeLessThan(1e-3); // sub-millimetre
  });

  it("agrees with Cesium's own eastNorthUpToFixedFrame at heading 0", () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([
      objectsTile(
        [
          {
            lon: -122.4,
            lat: 37.79,
            t: 0,
            trackId: 'a',
            length: 4,
            width: 2,
            height: 1,
          },
          {
            lon: -122.4,
            lat: 37.79,
            t: 2000,
            trackId: 'a',
            length: 4,
            width: 2,
            height: 1,
          },
        ],
        T0,
      ),
    ]);
    layer.setTime(T0 + 1000);
    const m = (collection().get(0) as Primitive).modelMatrix;
    const enu = Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(-122.4, 37.79, 0),
      Ellipsoid.WGS84,
      new Matrix4(),
    );
    // Cesium packs Matrix4 column-major, so columns 0/1/2 are east/north/up.
    const axes: [number, number][] = [
      [0, 4], // our LENGTH axis vs east
      [4, 4 + 4], // our WIDTH axis vs north
      [8, 8 + 4], // our HEIGHT axis vs up
    ];
    const dims = [4, 2, 1];
    axes.forEach(([o], k) => {
      const ours = new Cartesian3(m[o], m[o + 1], m[o + 2]);
      Cartesian3.normalize(ours, ours);
      const theirs = new Cartesian3(enu[o], enu[o + 1], enu[o + 2]);
      expect(Cartesian3.dot(ours, theirs)).toBeCloseTo(1, 9);
      // ...and the un-normalized magnitude is the metric dimension.
      expect(Math.hypot(m[o], m[o + 1], m[o + 2])).toBeCloseTo(dims[k], 6);
    });
  });

  it('shows a track only while it is active, and never draws an inactive one', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([
      objectsTile(
        [
          { lon: 1, lat: 1, t: 0, trackId: 'a' },
          { lon: 1, lat: 1, t: 1000, trackId: 'a' },
          { lon: 2, lat: 2, t: 2000, trackId: 'b' },
          { lon: 2, lat: 2, t: 3000, trackId: 'b' },
        ],
        T0,
      ),
    ]);
    armAll(collection());
    const a = collection().get(0) as Primitive;
    const b = collection().get(1) as Primitive;

    layer.setTime(T0 + 500);
    expect(a.show).toBe(true);
    expect(b.show).toBe(false); // outside b's span: not emitted at all

    layer.setTime(T0 + 2500);
    expect(a.show).toBe(false);
    expect(b.show).toBe(true);
  });

  it('does not resample when the playhead has not moved', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    layer.setTime(T0 + 1500);
    const p = collection().get(0) as Primitive;
    Matrix4.clone(Matrix4.IDENTITY, p.modelMatrix); // vandalise the pose in place
    layer.setTime(T0 + 1500);
    // Untouched — the whole frame was skipped, not just the colour write.
    expect(Matrix4.equals(p.modelMatrix, Matrix4.IDENTITY)).toBe(true);
    layer.setTime(T0 + 1501);
    expect(Matrix4.equals(p.modelMatrix, Matrix4.IDENTITY)).toBe(false);
  });

  it('re-arms the resample after setTiles, even at the same playhead', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    layer.setTime(T0 + 1500);
    layer.setTiles([threeTracksFourKeyframes()]); // brand-new primitives
    const p = collection().get(0) as Primitive;
    expect(Matrix4.equals(p.modelMatrix, Matrix4.IDENTITY)).toBe(true);
    layer.setTime(T0 + 1500);
    expect(Matrix4.equals(p.modelMatrix, Matrix4.IDENTITY)).toBe(false);
  });

  it('interpolates BETWEEN keyframes rather than snapping to one', () => {
    const { layer, collection } = makeLayer();
    layer.setTiles([
      objectsTile(
        [
          { lon: 0, lat: 0, t: 0, trackId: 'a' },
          { lon: 0.02, lat: 0, t: 1000, trackId: 'a' },
        ],
        T0,
      ),
    ]);
    const p = collection().get(0) as Primitive;
    layer.setTime(T0);
    const at0 = translation(p).clone();
    layer.setTime(T0 + 500);
    const mid = translation(p).clone();
    layer.setTime(T0 + 1000);
    const at1 = translation(p).clone();
    const half = Cartesian3.distance(at0, mid);
    const whole = Cartesian3.distance(at0, at1);
    expect(half).toBeGreaterThan(0);
    expect(half / whole).toBeCloseTo(0.5, 3);
  });

  it('scales every dimension by sizeScale', () => {
    const snaps: Snapshot[] = [
      { lon: 0, lat: 0, t: 0, trackId: 'a', length: 4, width: 2, height: 1 },
      { lon: 0, lat: 0, t: 2000, trackId: 'a', length: 4, width: 2, height: 1 },
    ];
    const big = makeLayer({ sizeScale: 3 });
    big.layer.setTiles([objectsTile(snaps, T0)]);
    big.layer.setTime(T0 + 1000);
    const m = (big.collection().get(0) as Primitive).modelMatrix;
    expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(12, 6);
    expect(Math.hypot(m[4], m[5], m[6])).toBeCloseTo(6, 6);
    expect(Math.hypot(m[8], m[9], m[10])).toBeCloseTo(3, 6);
  });
});

// ─── colour ──────────────────────────────────────────────────────────────────

describe('STTBoundingBoxLayer — batch-table colour', () => {
  function fadeless() {
    const { layer, collection } = makeLayer({
      fadeInDuration: 0,
      fadeOutDuration: 0,
    });
    layer.setTiles([threeTracksFourKeyframes()]);
    return { layer, collection, bytes: armAll(collection()) };
  }

  it('writes each track its OWN category colour at full alpha', () => {
    const { layer, bytes } = fadeless();
    layer.setTime(T0 + 1500);
    // Distinct per box — proof the shared scratch Uint8Array is copied out.
    expect([...bytes[0]]).toEqual([...COLORS.car]);
    expect([...bytes[1]]).toEqual([...COLORS.pedestrian]);
    expect([...bytes[2]]).toEqual([...COLORS.bicycle]);
  });

  it('folds the opacity option into the alpha byte', () => {
    const { layer, collection } = makeLayer({
      fadeInDuration: 0,
      fadeOutDuration: 0,
      opacity: 0.5,
    });
    layer.setTiles([threeTracksFourKeyframes()]);
    const bytes = armAll(collection());
    layer.setTime(T0 + 1500);
    expect(bytes[0][3]).toBe(128);
  });

  it("ramps the kernel's appear fade, which is NOT a time filter", () => {
    const { layer, collection } = makeLayer(); // default 200 ms fade
    layer.setTiles([threeTracksFourKeyframes()]);
    const bytes = armAll(collection());
    layer.setTime(T0 + DEFAULT_BOX_FADE_MS / 2);
    expect(bytes[0][3]).toBe(128); // half way up the appear ramp
    layer.setTime(T0 + 1500);
    expect(bytes[0][3]).toBe(255); // fully in, long before the last keyframe
  });

  it('skips the write when the alpha has not changed since the last frame', () => {
    const { layer, bytes } = fadeless();
    layer.setTime(T0 + 1200);
    expect(bytes[0][3]).toBe(255);
    bytes[0].fill(0); // if the layer wrote again we would see it come back
    layer.setTime(T0 + 1800); // pose moves, alpha does not
    expect([...bytes[0]]).toEqual([0, 0, 0, 0]);
  });

  it('poses on a frame it cannot colour, and colours on the next one', () => {
    // The batch table exists only after the primitive's first render, so an
    // early frame must not record a write it could not make: `lastAlpha` stays
    // NaN and the very next frame, at the SAME alpha, still writes.
    const { layer, collection } = makeLayer({
      fadeInDuration: 0,
      fadeOutDuration: 0,
    });
    layer.setTiles([threeTracksFourKeyframes()]);
    const p = collection().get(0) as Primitive;
    expect(() => layer.setTime(T0 + 1200)).not.toThrow();
    expect(p.show).toBe(true); // shown and posed regardless
    expect(Matrix4.equals(p.modelMatrix, Matrix4.IDENTITY)).toBe(false);
    const bytes = armPrimitive(p);
    layer.setTime(T0 + 1300); // same alpha as the frame that could not write
    expect([...bytes]).toEqual([...COLORS.car]);
  });
});

// ─── picking ─────────────────────────────────────────────────────────────────

describe('STTBoundingBoxLayer — pick', () => {
  function picked(stub: StubScene, collection: PrimitiveCollection, i: number) {
    const inst = (collection.get(i) as Primitive).geometryInstances as {
      id: PickId;
    };
    stub.pickResult = { id: inst.id };
  }

  it('joins the picked box to the archive columns and the LIVE pose', () => {
    const { stub, layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    layer.setTime(T0 + 1500);
    picked(stub, collection(), 1);
    const res = layer.pick(11, 22)!;
    expect(res).not.toBeNull();
    expect(res.layerId).toBe('stt-cesium-boxes');
    expect(res.screen).toEqual([11, 22]);
    expect((res.object as Record<string, unknown>).track_id).toBe('b');
    expect((res.object as Record<string, unknown>).category).toBe('pedestrian');
    // meta is the AV inspector row off the INTERPOLATED sample. Dimensions
    // come back through a Float32Array column, so they are compared to f32
    // precision rather than to the literal that was written.
    const meta = res.meta as Record<string, number | string>;
    expect(meta.track_id).toBe('b');
    expect(meta.category).toBe('pedestrian');
    expect(meta.length as number).toBeCloseTo(4.5, 5);
    expect(meta.width as number).toBeCloseTo(1.9, 5);
    expect(meta.height as number).toBeCloseTo(1.6, 5);
    expect(meta.speed as number).toBeCloseTo(10, 5);
    expect(meta.heading as number).toBeCloseTo(0, 9);
    // coordinate is where the user clicked (the interpolated pose), between the
    // 2nd and 3rd keyframes rather than on either.
    const [lon] = res.coordinate!;
    expect(lon).toBeGreaterThan(5.001);
    expect(lon).toBeLessThan(5.002);
  });

  it("returns null for a miss and for another layer's primitive", () => {
    const { stub, layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    layer.setTime(T0 + 1500);
    stub.pickResult = undefined;
    expect(layer.pick(1, 1)).toBeNull();
    stub.pickResult = {
      id: {
        layerId: 'someone-else',
        binary: null,
        featureIndex: 0,
        trackId: 'x',
      },
    };
    expect(layer.pick(1, 1)).toBeNull();
    // and a picked object with no id at all
    stub.pickResult = {};
    expect(layer.pick(1, 1)).toBeNull();
    void collection;
  });

  it('reports meta alone for a track with no resolvable feature', () => {
    const { stub, layer, collection } = makeLayer();
    layer.setTiles([
      objectsTile([{ lon: 1, lat: 1, t: 0 }], T0, true), // no track-id column
    ]);
    layer.setTime(T0);
    picked(stub, collection(), 0);
    const res = layer.pick(3, 4)!;
    expect(res.object).toBeNull();
    expect(res.index).toBe(-1);
    expect(res.meta).toBeTruthy();
  });
});

// ─── lifecycle ───────────────────────────────────────────────────────────────

describe('STTBoundingBoxLayer — dispose', () => {
  it('removes its collection from the scene and drops every entry', () => {
    const { stub, layer, collection } = makeLayer();
    layer.setTiles([threeTracksFourKeyframes()]);
    const c = collection();
    layer.dispose();
    expect(stub.removed).toEqual([c]);
    // No externally-supplied GPU resource rides along: the shared
    // PerInstanceColorAppearance is a description, and each Primitive's
    // compiled program dies with the primitive PrimitiveCollection destroys.
    layer.setTime(T0 + 1500); // no entries left → a no-op, not a throw
    expect(() => layer.setTime(T0 + 1600)).not.toThrow();
  });
});
