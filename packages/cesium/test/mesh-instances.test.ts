// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the PURE (Cesium-free) half of the `mesh` kind:
 * `src/lib/mesh-instances.ts`.
 *
 * Four things are being pinned here, and only the last is ordinary maths:
 *
 *   1. ONE ENTRY PER TRACK, NEVER PER KEYFRAME. The AV `objects/` archive holds
 *      one POINT feature per tracked object per KEYFRAME, so a builder that
 *      emitted per-feature would leave a "train of parked cars" behind every
 *      moving one. Every pooling test below counts meshes against TRACKS while
 *      `totalSnapshots` counts the features they came from — the two numbers
 *      differing IS the regression test.
 *   2. ABSOLUTE-EPOCH REBASING ACROSS TILES. `startTimes` is a Float32Array of
 *      TILE-RELATIVE ms and the absolute base is the tile's `timeOffset`, so
 *      keyframes of one object living in tiles with different offsets join one
 *      timeline only if `time + timeOffset` is what gets pooled. That applies to
 *      the ATTITUDE pool too, which this module builds itself rather than
 *      inheriting from the kernel.
 *   3. PER-CATEGORY MODEL DISPATCH. A `mesh` archive draws different glTFs for
 *      `car` / `truck` / `pedestrian`, and a category with no URL must resolve
 *      to the empty string — the layer's signal for "pooled, sampled, never
 *      drawn" — rather than to some silent placeholder.
 *   4. The LOCAL east-north-up frame and the model matrix built on it, including
 *      the deliberate non-finite collapse (a NaN dimension must not poison the
 *      model's bounding sphere) and the quaternion path's shortest-arc slerp.
 *
 * This file imports NO Cesium, mirroring the module it tests. The agreement
 * between that Cesium-free frame and Cesium's own `eastNorthUpToFixedFrame` is
 * cross-checked in `cesium-mesh-layer.test.ts`, which may import it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeometryType, sampleTrack } from '@poopdeck.gl/core';
import type { BinaryFeatures, Sample, Tile, Track } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX } from '@poopdeck.gl/core/style';
import {
  DEFAULT_MESH_FADE_MS,
  DEFAULT_MESH_HEIGHT,
  DEFAULT_MESH_LENGTH,
  DEFAULT_MESH_WIDTH,
  MATRIX4_LENGTH,
  MESH_SINGLETON_HOLD_MS,
  buildMeshInstances,
  enuBasis,
  meshPoseOptions,
  meshPointTiles,
  meshSampleConfig,
  quatToMeshEuler,
  resolveModelUrl,
  sampleMeshAttitude,
  slerpQuat,
  writeMeshModelMatrix,
} from '../src/lib/mesh-instances';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEG2RAD = Math.PI / 180;

// ─── fixtures ────────────────────────────────────────────────────────────────

interface Snapshot {
  lon: number;
  lat: number;
  /** TILE-RELATIVE ms (the archive stores these as f32 alongside `timeOffset`). */
  t: number;
  /** `null` ⇒ the NULL category sentinel, i.e. a row with no resolvable id. */
  trackId?: string | null;
  category?: string;
  heading?: number;
  length?: number;
  width?: number;
  height?: number;
  speed?: number;
  /** `[qx,qy,qz,qw]`, written into the interleaved `attitude` vector column. */
  quat?: [number, number, number, number];
}

type ColumnName =
  | 'track_id'
  | 'category'
  | 'heading'
  | 'length'
  | 'width'
  | 'height'
  | 'speed';

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

interface TileOptions {
  timeOffset?: number;
  omit?: readonly ColumnName[];
  /** Emit the `attitude` FixedSizeList column (f32 x 4 unless overridden). */
  attitude?: boolean;
  /** Emit `attitude` with a deliberately WRONG leaf type / width. */
  badAttitude?: 'u8' | 'size3';
  geometryType?: GeometryType;
}

function objectsFeatures(snaps: Snapshot[], o: TileOptions): BinaryFeatures {
  const n = snaps.length;
  const omit = o.omit ?? [];
  const positions = new Float64Array(n * 2);
  const startTimes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = snaps[i].lon;
    positions[i * 2 + 1] = snaps[i].lat;
    startTimes[i] = snaps[i].t;
  }
  const num = (k: 'heading' | 'length' | 'width' | 'height' | 'speed') =>
    new Float32Array(snaps.map((s) => s[k] ?? 0));

  const numericProps: Record<string, Float32Array> = {};
  if (!omit.includes('heading')) numericProps.heading = num('heading');
  if (!omit.includes('length')) numericProps.length = num('length');
  if (!omit.includes('width')) numericProps.width = num('width');
  if (!omit.includes('height')) numericProps.height = num('height');
  if (!omit.includes('speed')) numericProps.speed = num('speed');

  const categoricalProps: BinaryFeatures['categoricalProps'] = {};
  if (!omit.includes('track_id')) {
    categoricalProps.track_id = categorical(snaps.map((s) => s.trackId));
  }
  if (!omit.includes('category')) {
    categoricalProps.category = categorical(
      snaps.map((s) => s.category ?? 'car'),
    );
  }

  const vectorProps: BinaryFeatures['vectorProps'] = {};
  if (o.attitude) {
    const value = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const q = snaps[i].quat ?? [0, 0, 0, 1];
      value.set(q, i * 4);
    }
    vectorProps.attitude = { value, size: 4 };
  }
  if (o.badAttitude === 'u8') {
    vectorProps.attitude = { value: new Uint8Array(n * 4), size: 4 };
  }
  if (o.badAttitude === 'size3') {
    vectorProps.attitude = { value: new Float32Array(n * 3), size: 3 };
  }

  return {
    featureCount: n,
    geometryType: o.geometryType ?? GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(n),
    startTimes,
    endTimes: startTimes.slice(),
    timeOffset: o.timeOffset ?? 0,
    numericProps,
    categoricalProps,
    vectorProps,
  };
}

function objectsTile(snaps: Snapshot[], o: TileOptions = {}): Tile {
  const timeOffset = o.timeOffset ?? 0;
  return {
    id: { z: 16, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'objects',
        extent: 0,
        features: objectsFeatures(snaps, o),
        geometryExtensionName:
          (o.geometryType ?? GeometryType.Point) === GeometryType.Point
            ? 'geoarrow.point'
            : 'geoarrow.linestring',
      },
    ],
  };
}

/** A wall-clock-shaped base, so the f32 relative / f64 absolute split is real. */
const T0 = 1_700_000_000_000;

/** Hand-built pose, borrowing a real pooled track so the type is the real one. */
function sampleOf(track: Track, over: Partial<Sample>): Sample {
  return {
    lon: 0,
    lat: 0,
    alt: 0,
    heading: 0,
    length: 1,
    width: 1,
    height: 1,
    speed: 0,
    alpha: 1,
    track,
    ...over,
  };
}

function someTrack(): Track {
  return buildMeshInstances([
    objectsTile([{ lon: 0, lat: 0, t: 0, trackId: 'a' }], { timeOffset: T0 }),
  ]).meshes[0].track;
}

// ─── pooling: one mesh per TRACK ─────────────────────────────────────────────

describe('buildMeshInstances — one model per TRACK, not per keyframe', () => {
  it('collapses many keyframes of the same object into a single entry', () => {
    const tile = objectsTile(
      [
        { lon: 4.9, lat: 52.37, t: 0, trackId: 'a' },
        { lon: 4.9001, lat: 52.37, t: 100, trackId: 'a' },
        { lon: 4.9002, lat: 52.37, t: 200, trackId: 'a' },
        { lon: 5.0, lat: 52.0, t: 0, trackId: 'b' },
        { lon: 5.0001, lat: 52.0, t: 100, trackId: 'b' },
      ],
      { timeOffset: T0 },
    );
    const build = buildMeshInstances([tile]);
    // 5 features in, 2 models out — the "train of cars" regression, in numbers.
    expect(build.totalSnapshots).toBe(5);
    expect(build.meshes).toHaveLength(2);
    expect(build.meshes.map((m) => m.key).sort()).toEqual(['a', 'b']);
    expect(build.meshes.find((m) => m.key === 'a')!.track.times).toHaveLength(
      3,
    );
  });

  it('reports timeOrigin 0 — the kernel already pooled to absolute epoch-ms', () => {
    const build = buildMeshInstances([
      objectsTile([{ lon: 0, lat: 0, t: 0, trackId: 'a' }], { timeOffset: T0 }),
    ]);
    expect(build.timeOrigin).toBe(0);
  });

  it('returns an empty build for no tiles, and for empty tiles', () => {
    expect(buildMeshInstances([]).meshes).toEqual([]);
    expect(buildMeshInstances([]).timeOrigin).toBe(0);
    expect(
      buildMeshInstances([objectsTile([], { timeOffset: T0 })]).meshes,
    ).toEqual([]);
  });

  it('carries pick provenance from each track FIRST sighted keyframe', () => {
    const tile = objectsTile(
      [
        { lon: 1, lat: 1, t: 0, trackId: 'a' },
        { lon: 2, lat: 2, t: 10, trackId: 'b' },
        { lon: 1.1, lat: 1, t: 100, trackId: 'a' },
      ],
      { timeOffset: T0 },
    );
    const build = buildMeshInstances([tile]);
    const a = build.meshes.find((m) => m.key === 'a')!;
    const b = build.meshes.find((m) => m.key === 'b')!;
    expect(a.binary).toBe(tile.layers[0].features);
    expect(a.featureIndex).toBe(0); // NOT 2 — the first sighting wins
    expect(b.featureIndex).toBe(1);
  });

  it('flags a tile with NO track-id column, and still pools it as singletons', () => {
    const build = buildMeshInstances([
      objectsTile(
        [
          { lon: 1, lat: 1, t: 0 },
          { lon: 2, lat: 2, t: 100 },
        ],
        { timeOffset: T0, omit: ['track_id'] },
      ),
    ]);
    expect(build.trackIdMissing).toBe(true);
    expect(build.meshes).toHaveLength(2); // no identity ⇒ no grouping
    for (const m of build.meshes) {
      expect(m.binary).toBeNull(); // nothing to join a pick to
      expect(m.featureIndex).toBe(-1);
    }
  });
});

describe('buildMeshInstances — absolute-epoch rebasing across tiles', () => {
  it('joins keyframes from tiles with DIFFERENT timeOffsets into one timeline', () => {
    const early = objectsTile(
      [
        { lon: 1, lat: 1, t: 0, trackId: 'a' },
        { lon: 1, lat: 1, t: 100, trackId: 'a' },
      ],
      { timeOffset: T0 },
    );
    const late = objectsTile(
      [
        { lon: 1, lat: 1, t: 0, trackId: 'a' },
        { lon: 1, lat: 1, t: 100, trackId: 'a' },
      ],
      { timeOffset: T0 + 1000 },
    );
    // Deliberately out of order: pooling must sort, not trust arrival order.
    const build = buildMeshInstances([late, early]);
    expect(build.meshes).toHaveLength(1);
    expect(build.meshes[0].track.times).toEqual([
      T0,
      T0 + 100,
      T0 + 1000,
      T0 + 1100,
    ]);
  });
});

// ─── per-category model dispatch ─────────────────────────────────────────────

describe('resolveModelUrl', () => {
  it('prefers the per-category URL', () => {
    expect(resolveModelUrl('truck', { truck: '/t.glb' }, '/d.glb')).toBe(
      '/t.glb',
    );
  });
  it('falls back for an unmapped category, an empty map, and no category', () => {
    expect(resolveModelUrl('bus', { truck: '/t.glb' }, '/d.glb')).toBe(
      '/d.glb',
    );
    expect(resolveModelUrl('truck', null, '/d.glb')).toBe('/d.glb');
    expect(resolveModelUrl('', { truck: '/t.glb' }, '/d.glb')).toBe('/d.glb');
  });
  it('treats an EMPTY mapped URL as absent, not as a model', () => {
    expect(resolveModelUrl('truck', { truck: '' }, '/d.glb')).toBe('/d.glb');
  });
  it('resolves to the empty string when nothing at all is configured', () => {
    // The layer reads '' as "pooled, sampled, never drawn" — no placeholder.
    expect(resolveModelUrl('truck', null, '')).toBe('');
  });
});

describe('buildMeshInstances — model + colour resolution', () => {
  it('dispatches each track glTF on its own category', () => {
    const build = buildMeshInstances(
      [
        objectsTile(
          [
            { lon: 1, lat: 1, t: 0, trackId: 'a', category: 'car' },
            { lon: 2, lat: 2, t: 0, trackId: 'b', category: 'truck' },
            { lon: 3, lat: 3, t: 0, trackId: 'c', category: 'llama' },
          ],
          { timeOffset: T0 },
        ),
      ],
      { models: { car: '/car.glb', truck: '/truck.glb' }, model: '/any.glb' },
    );
    const byKey = new Map(build.meshes.map((m) => [m.key, m]));
    expect(byKey.get('a')!.modelUrl).toBe('/car.glb');
    expect(byKey.get('b')!.modelUrl).toBe('/truck.glb');
    expect(byKey.get('c')!.modelUrl).toBe('/any.glb'); // unmapped → default
    expect(byKey.get('a')!.category).toBe('car');
  });

  it('leaves modelUrl empty when neither a map nor a default resolves', () => {
    const build = buildMeshInstances([
      objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], {
        timeOffset: T0,
      }),
    ]);
    expect(build.meshes[0].modelUrl).toBe('');
  });

  it('normalizes the category tint to 0..1 ONCE, so no per-frame divide', () => {
    const build = buildMeshInstances(
      [
        objectsTile(
          [{ lon: 1, lat: 1, t: 0, trackId: 'a', category: 'truck' }],
          { timeOffset: T0 },
        ),
      ],
      { colorMapping: { truck: [255, 128, 0, 204] } },
    );
    const m = build.meshes[0];
    expect(m.r).toBeCloseTo(1, 12);
    expect(m.g).toBeCloseTo(128 / 255, 12);
    expect(m.b).toBe(0);
    expect(m.a).toBeCloseTo(204 / 255, 12);
  });
});

// ─── tile filtering ──────────────────────────────────────────────────────────

describe('meshPointTiles', () => {
  it('returns the SAME array reference when every layer is Point', () => {
    const tiles = [objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }])];
    expect(meshPointTiles(tiles)).toBe(tiles); // caller identity short-circuits survive
  });

  it('drops non-Point layers, and tiles left with none', () => {
    const line = objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], {
      geometryType: GeometryType.LineString,
    });
    const point = objectsTile([{ lon: 2, lat: 2, t: 0, trackId: 'b' }]);
    const kept = meshPointTiles([line, point]);
    expect(kept).toHaveLength(1);
    expect(kept[0].layers[0].features.geometryType).toBe(GeometryType.Point);
  });

  it('keeps a linestring layer out of the POOL, not just out of the array', () => {
    const line = objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], {
      geometryType: GeometryType.LineString,
    });
    expect(buildMeshInstances([line]).meshes).toEqual([]);
  });
});

// ─── attitude pooling ────────────────────────────────────────────────────────

describe('buildMeshInstances — the opt-in attitude column', () => {
  const quats: [number, number, number, number][] = [
    [0, 0, 0, 1],
    [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  ];

  it('is OFF by default — the scalar heading drives yaw alone', () => {
    const build = buildMeshInstances([
      objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a', quat: quats[0] }], {
        timeOffset: T0,
        attitude: true,
      }),
    ]);
    expect(build.meshes[0].attitude).toBeNull();
    expect(build.attitudeMissing).toBe(false); // nothing was asked for
  });

  it('pools and SORTS quaternions to absolute epoch-ms across tiles', () => {
    const late = objectsTile(
      [{ lon: 1, lat: 1, t: 0, trackId: 'a', quat: quats[1] }],
      { timeOffset: T0 + 1000, attitude: true },
    );
    const early = objectsTile(
      [{ lon: 1, lat: 1, t: 500, trackId: 'a', quat: quats[0] }],
      { timeOffset: T0, attitude: true },
    );
    const build = buildMeshInstances([late, early], {
      quaternionColumn: 'attitude',
    });
    const att = build.meshes[0].attitude!;
    expect(Array.from(att.times)).toEqual([T0 + 500, T0 + 1000]);
    expect(att.quats[3]).toBeCloseTo(1, 6); // the T0+500 keyframe is identity
    expect(att.quats[6]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('flags an attitude column that is absent, u8, or the wrong width', () => {
    const absent = buildMeshInstances(
      [
        objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], {
          timeOffset: T0,
        }),
      ],
      { quaternionColumn: 'attitude' },
    );
    expect(absent.attitudeMissing).toBe(true);
    expect(absent.meshes[0].attitude).toBeNull();

    for (const bad of ['u8', 'size3'] as const) {
      const build = buildMeshInstances(
        [
          objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], {
            timeOffset: T0,
            badAttitude: bad,
          }),
        ],
        { quaternionColumn: 'attitude' },
      );
      // A u8 leaf against float components is a format mismatch, not a rescale.
      expect(build.attitudeMissing).toBe(true);
      expect(build.meshes[0].attitude).toBeNull();
    }
  });
});

// ─── quaternion maths ────────────────────────────────────────────────────────

describe('quatToMeshEuler', () => {
  const out: [number, number, number] = [0, 0, 0];

  it('maps the identity quaternion to a flat pose', () => {
    quatToMeshEuler(0, 0, 0, 1, out);
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(0, 10);
    expect(out[2]).toBeCloseTo(0, 10);
  });

  it('extracts a 90 degree yaw about local up', () => {
    quatToMeshEuler(0, 0, Math.SQRT1_2, Math.SQRT1_2, out);
    expect(out[1]).toBeCloseTo(90, 6);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });

  it('extracts roll and pitch on their own axes', () => {
    // 90 degrees about +x is pure roll; about +y is pure pitch.
    quatToMeshEuler(Math.SQRT1_2, 0, 0, Math.SQRT1_2, out);
    expect(out[2]).toBeCloseTo(90, 6);
    quatToMeshEuler(0, Math.SQRT1_2, 0, Math.SQRT1_2, out);
    expect(out[0]).toBeCloseTo(90, 6);
  });

  it('normalizes an un-normalized input rather than skewing the angles', () => {
    quatToMeshEuler(0, 0, 3 * Math.SQRT1_2, 3 * Math.SQRT1_2, out);
    expect(out[1]).toBeCloseTo(90, 6);
  });

  it('resolves gimbal lock to roll 0 instead of NaN', () => {
    // Nose straight up: pitch 90, where yaw and roll are the same DOF.
    quatToMeshEuler(0, Math.SQRT1_2, 0, Math.SQRT1_2, out);
    expect(out[0]).toBeCloseTo(90, 6);
    expect(out[2]).toBe(0);
    expect(Number.isNaN(out[1])).toBe(false);
  });
});

describe('slerpQuat', () => {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const euler: [number, number, number] = [0, 0, 0];

  it('returns the endpoints at t=0 and t=1', () => {
    const q = new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    slerpQuat(q, 0, 4, 0, out);
    expect(out[3]).toBeCloseTo(1, 6);
    slerpQuat(q, 0, 4, 1, out);
    expect(out[2]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('takes the SHORT way through the antipodal representation', () => {
    // -q is the SAME rotation as q: halfway between 0 and (-1 * yaw 90) must be
    // yaw 45, not the 135-degree long way round.
    const q = new Float32Array([
      0,
      0,
      0,
      1,
      -0,
      -0,
      -Math.SQRT1_2,
      -Math.SQRT1_2,
    ]);
    slerpQuat(q, 0, 4, 0.5, out);
    quatToMeshEuler(out[0], out[1], out[2], out[3], euler);
    expect(euler[1]).toBeCloseTo(45, 4);
  });

  it('lerps through the nearly-parallel branch without dividing by zero', () => {
    const tiny = 1e-4;
    const q = new Float32Array([
      0,
      0,
      0,
      1,
      0,
      0,
      tiny,
      Math.sqrt(1 - tiny * tiny),
    ]);
    slerpQuat(q, 0, 4, 0.5, out);
    expect(Number.isFinite(out[0] + out[1] + out[2] + out[3])).toBe(true);
    expect(out[3]).toBeGreaterThan(0.99);
  });
});

describe('sampleMeshAttitude', () => {
  const out: [number, number, number] = [0, 0, 0];
  const attitude = {
    times: new Float64Array([T0, T0 + 1000]),
    quats: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
  };

  it('reports false with no keyframes, so the caller falls back to heading', () => {
    expect(sampleMeshAttitude(null, T0, out)).toBe(false);
    expect(
      sampleMeshAttitude(
        { times: new Float64Array(0), quats: new Float32Array(0) },
        T0,
        out,
      ),
    ).toBe(false);
  });

  it('interpolates between keyframes', () => {
    expect(sampleMeshAttitude(attitude, T0 + 500, out)).toBe(true);
    expect(out[1]).toBeCloseTo(45, 4);
  });

  it('HOLDS the terminal attitude rather than extrapolating a spin', () => {
    // An orientation is a measurement; rotating past the last one is fabrication.
    sampleMeshAttitude(attitude, T0 - 5000, out);
    expect(out[1]).toBeCloseTo(0, 6);
    sampleMeshAttitude(attitude, T0 + 50_000, out);
    expect(out[1]).toBeCloseTo(90, 6);
  });

  it('holds a single keyframe for all time', () => {
    const one = {
      times: new Float64Array([T0]),
      quats: new Float32Array([0, 0, Math.SQRT1_2, Math.SQRT1_2]),
    };
    for (const t of [T0 - 1e6, T0, T0 + 1e6]) {
      expect(sampleMeshAttitude(one, t, out)).toBe(true);
      expect(out[1]).toBeCloseTo(90, 6);
    }
  });
});

// ─── the ENU frame ───────────────────────────────────────────────────────────

describe('enuBasis', () => {
  it('is the textbook frame at the prime-meridian equator', () => {
    const b = enuBasis(0, 0, new Array(9).fill(0));
    expect(b.slice(0, 3).map(round)).toEqual([0, 1, 0]); // east  = +Y
    expect(b.slice(3, 6).map(round)).toEqual([0, 0, 1]); // north = +Z
    expect(b.slice(6, 9).map(round)).toEqual([1, 0, 0]); // up    = +X
  });

  it('stays orthonormal and right-handed at every latitude', () => {
    for (const [lon, lat] of [
      [0, 0],
      [4.9, 52.37],
      [-122.4, 37.8],
      [151.2, -33.9],
      [0, 90],
      [0, -90],
    ]) {
      const b = enuBasis(lon, lat, new Array(9).fill(0));
      const e = b.slice(0, 3);
      const n = b.slice(3, 6);
      const u = b.slice(6, 9);
      expect(len(e)).toBeCloseTo(1, 12);
      expect(len(n)).toBeCloseTo(1, 12);
      expect(len(u)).toBeCloseTo(1, 12);
      expect(dot(e, n)).toBeCloseTo(0, 12);
      expect(dot(n, u)).toBeCloseTo(0, 12);
      expect(dot(e, u)).toBeCloseTo(0, 12);
      // east x north = up ⇒ right-handed.
      const c = cross(e, n);
      expect(dot(c, u)).toBeCloseTo(1, 12);
    }
  });
});

// ─── the model matrix ────────────────────────────────────────────────────────

describe('writeMeshModelMatrix', () => {
  const POSE = meshPoseOptions();

  it('writes a COLUMN-MAJOR matrix whose translation is the projected pose', () => {
    const track = someTrack();
    const s = sampleOf(track, { lon: 4.9, lat: 52.37, alt: 12 });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      POSE,
    );
    expect(m).toHaveLength(MATRIX4_LENGTH);
    const [x, y, z] = GLOBE.project(4.9, 52.37, 12);
    expect(m[12]).toBeCloseTo(x, 6);
    expect(m[13]).toBeCloseTo(y, 6);
    expect(m[14]).toBeCloseTo(z, 6);
    expect(m[15]).toBe(1);
    expect([m[3], m[7], m[11]]).toEqual([0, 0, 0]);
  });

  it('places the origin AT the pose — no automatic half-height lift', () => {
    // Deliberate departure from the box layer: a box is drawn around its
    // centre, a model is authored on its base (as deck's AnimatedMeshLayer
    // assumes). A centred model is corrected with `translation`, not silently.
    const track = someTrack();
    const s = sampleOf(track, { lon: 0, lat: 0, height: 4 });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      POSE,
    );
    const [x] = GLOBE.project(0, 0, 0);
    expect(m[12]).toBeCloseTo(x, 6); // up is +X here; no 2 m offset
  });

  it('builds the frame on LOCAL east-north-up, not the ECEF axes', () => {
    // The whole point of enuBasis: at 52 N an identity rotation would aim the
    // model at the ECEF pole. The forward column must be the local EAST vector.
    const track = someTrack();
    const s = sampleOf(track, { lon: 4.9, lat: 52.37 });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      POSE,
    );
    const b = enuBasis(4.9, 52.37, new Array(9).fill(0));
    expect(m[0]).toBeCloseTo(b[0], 12);
    expect(m[1]).toBeCloseTo(b[1], 12);
    expect(m[2]).toBeCloseTo(b[2], 12);
    // ...and is emphatically NOT the identity rotation.
    expect(Math.abs(m[0] - 1)).toBeGreaterThan(0.1);
  });

  it('scales the columns to length/width/height x sizeScale', () => {
    const track = someTrack();
    const s = sampleOf(track, {
      lon: 0,
      lat: 0,
      length: 4.5,
      width: 2,
      height: 1.6,
    });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      meshPoseOptions({ sizeScale: 2 }),
    );
    expect(len([m[0], m[1], m[2]])).toBeCloseTo(9, 9);
    expect(len([m[4], m[5], m[6]])).toBeCloseTo(4, 9);
    expect(len([m[8], m[9], m[10]])).toBeCloseTo(3.2, 9);
  });

  it('uses modelScale instead when scaleToDimensions is off', () => {
    const track = someTrack();
    const s = sampleOf(track, {
      lon: 0,
      lat: 0,
      length: 40,
      width: 40,
      height: 40,
    });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      meshPoseOptions({ scaleToDimensions: false, modelScale: 3 }),
    );
    expect(len([m[0], m[1], m[2]])).toBeCloseTo(3, 9);
    expect(len([m[8], m[9], m[10]])).toBeCloseTo(3, 9);
  });

  it('collapses a NON-FINITE dimension to 0 instead of poisoning the frame', () => {
    // NaN would propagate into Cesium bounding-sphere transform and break
    // culling for the WHOLE frame; one invisible model is far cheaper.
    const track = someTrack();
    const s = sampleOf(track, { lon: 0, lat: 0, length: Number.NaN, width: 2 });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      POSE,
    );
    expect(m.every((v) => Number.isFinite(v))).toBe(true);
    expect(len([m[0], m[1], m[2]])).toBe(0);
    expect(len([m[4], m[5], m[6]])).toBeCloseTo(2, 9);
  });

  it('treats a non-finite altitude as ground level', () => {
    const track = someTrack();
    const s = sampleOf(track, { lon: 0, lat: 0, alt: Number.NaN });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      POSE,
    );
    const [x] = GLOBE.project(0, 0, 0);
    expect(m[12]).toBeCloseTo(x, 6);
  });

  it('turns the forward axis with the scalar heading (radians, CCW from east)', () => {
    const track = someTrack();
    const s = sampleOf(track, { lon: 0, lat: 0, heading: Math.PI / 2 });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      POSE,
    );
    // At (0,0): east = +Y, north = +Z. A 90 degree CCW yaw points forward north.
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[1]).toBeCloseTo(0, 9);
    expect(m[2]).toBeCloseTo(1, 9);
  });

  it('lets the attitude triple override the scalar heading', () => {
    const track = someTrack();
    const s = sampleOf(track, { lon: 0, lat: 0, heading: 0 });
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      [0, 90, 0],
      POSE,
    );
    expect(m[2]).toBeCloseTo(1, 9); // yaw 90 wins over heading 0
  });

  it('adds orientationOffset in DEGREES on both paths', () => {
    const track = someTrack();
    const s = sampleOf(track, { lon: 0, lat: 0, heading: 0 });
    const pose = meshPoseOptions({ orientationOffset: [0, 90, 0] });
    const scalar = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      s,
      null,
      pose,
    );
    const attitude = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      sampleOf(track, { lon: 0, lat: 0, heading: 90 * DEG2RAD }),
      [0, 0, 0],
      pose,
    );
    expect(scalar[2]).toBeCloseTo(1, 9);
    expect(attitude[2]).toBeCloseTo(1, 9);
  });

  it('applies translation in the LOCAL ENU frame, unrotated by heading', () => {
    const track = someTrack();
    const base = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      sampleOf(track, { lon: 0, lat: 0 }),
      null,
      meshPoseOptions(),
    );
    const lifted = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      // A yaw that would rotate the offset if translation rode the rotation.
      sampleOf(track, { lon: 0, lat: 0, heading: Math.PI / 2 }),
      null,
      meshPoseOptions({ translation: [0, 0, 10] }),
    );
    // up = +X at (0,0), so a 10 m lift is +10 on X and nothing else.
    expect(lifted[12] - base[12]).toBeCloseTo(10, 6);
    expect(lifted[13] - base[13]).toBeCloseTo(0, 6);
    expect(lifted[14] - base[14]).toBeCloseTo(0, 6);
  });

  it('pitches nose-UP for a positive pitch, matching Cesium HeadingPitchRoll', () => {
    const track = someTrack();
    const m = writeMeshModelMatrix(
      new Array(MATRIX4_LENGTH).fill(0),
      sampleOf(track, { lon: 0, lat: 0 }),
      [30, 0, 0],
      meshPoseOptions(),
    );
    // up = +X at (0,0): a nose-up pitch tilts the forward column toward up.
    expect(m[0]).toBeCloseTo(Math.sin(30 * DEG2RAD), 9);
  });
});

// ─── sampling config ─────────────────────────────────────────────────────────

describe('meshSampleConfig / meshPoseOptions defaults', () => {
  it('spells the deck-matching fade, dimension and hold defaults', () => {
    const cfg = meshSampleConfig();
    expect(cfg.defaultLength).toBe(DEFAULT_MESH_LENGTH);
    expect(cfg.defaultWidth).toBe(DEFAULT_MESH_WIDTH);
    expect(cfg.defaultHeight).toBe(DEFAULT_MESH_HEIGHT);
    expect(cfg.fadeInDuration).toBe(DEFAULT_MESH_FADE_MS);
    expect(cfg.fadeOutDuration).toBe(DEFAULT_MESH_FADE_MS);
    // Pinned against three's 400 ms box fork drifting in here.
    expect(cfg.singletonHoldMs).toBe(MESH_SINGLETON_HOLD_MS);
    expect(MESH_SINGLETON_HOLD_MS).toBe(600);
  });

  it('passes overrides through', () => {
    const cfg = meshSampleConfig({ fadeInDuration: 0, defaultLength: 9 });
    expect(cfg.fadeInDuration).toBe(0);
    expect(cfg.defaultLength).toBe(9);
    expect(cfg.fadeOutDuration).toBe(DEFAULT_MESH_FADE_MS);
  });

  it('defaults the pose to dimension-fitted, unrotated, untranslated', () => {
    expect(meshPoseOptions()).toEqual({
      scaleToDimensions: true,
      modelScale: 1,
      sizeScale: 1,
      orientationOffset: [0, 0, 0],
      translation: [0, 0, 0],
    });
  });
});

describe('the pooled track feeds the shared kernel sampler', () => {
  it('emits ONE pose while active and null outside the span', () => {
    const build = buildMeshInstances([
      objectsTile(
        [
          { lon: 0, lat: 0, t: 0, trackId: 'a', length: 4 },
          { lon: 1, lat: 0, t: 1000, trackId: 'a', length: 4 },
        ],
        { timeOffset: T0 },
      ),
    ]);
    const cfg = meshSampleConfig();
    const track = build.meshes[0].track;
    expect(sampleTrack(track, T0 - 1, cfg)).toBeNull();
    expect(sampleTrack(track, T0 + 1001, cfg)).toBeNull();
    const mid = sampleTrack(track, T0 + 500, cfg)!;
    expect(mid.lon).toBeCloseTo(0.5, 9);
    expect(mid.length).toBeCloseTo(4, 6);
  });

  it('holds a singleton for the kernel window, not forever', () => {
    const build = buildMeshInstances([
      objectsTile([{ lon: 0, lat: 0, t: 0, trackId: 'a' }], { timeOffset: T0 }),
    ]);
    const cfg = meshSampleConfig();
    const track = build.meshes[0].track;
    expect(sampleTrack(track, T0, cfg)).not.toBeNull();
    expect(
      sampleTrack(track, T0 + MESH_SINGLETON_HOLD_MS / 2 - 1, cfg),
    ).not.toBeNull();
    expect(
      sampleTrack(track, T0 + MESH_SINGLETON_HOLD_MS / 2 + 1, cfg),
    ).toBeNull();
  });
});

// ─── purity ──────────────────────────────────────────────────────────────────

describe('the builder stays PURE', () => {
  it('imports no Cesium, so it is unit-testable in plain Node', () => {
    const src = readFileSync(
      new URL('../src/lib/mesh-instances.ts', import.meta.url),
      'utf8',
    );
    expect(/from\s+'cesium'/.test(src)).toBe(false);
    expect(/from\s+'@cesium\//.test(src)).toBe(false);
  });

  it('projects with the WGS84 datum, not the class-default sphere', () => {
    // The default 'sphere' mis-registers against Cesium's real ellipsoid by up
    // to ~20 km at mid-latitudes, so the explicit datum is load-bearing.
    const src = readFileSync(
      new URL('../src/lib/mesh-instances.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("datum: 'wgs84'");
  });
});

// ─── tiny vector helpers ─────────────────────────────────────────────────────

function len(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function round(v: number): number {
  return Math.abs(v) < 1e-12 ? 0 : Number(v.toFixed(12));
}
