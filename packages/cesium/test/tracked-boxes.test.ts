// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the PURE (Cesium-free) half of the `boundingBox` kind:
 * `src/lib/tracked-boxes.ts`.
 *
 * Three things are being pinned here, and only the third is ordinary geometry
 * maths:
 *
 *   1. ONE ENTRY PER TRACK, NEVER PER KEYFRAME. The AV `objects/` archive holds
 *      one POINT feature per tracked object per KEYFRAME, so a builder that
 *      emitted per-feature would draw the "train of boxes" the deck layer was
 *      rewritten to kill. Every pooling test below counts boxes against TRACKS
 *      while `totalSnapshots` counts the features they came from — the two
 *      numbers differing is the whole point.
 *   2. ABSOLUTE-EPOCH REBASING ACROSS TILES. `startTimes` is a Float32Array of
 *      TILE-RELATIVE ms and the absolute base is the tile's `timeOffset`, so
 *      keyframes of one object living in tiles with different offsets only join
 *      one timeline if `time + timeOffset` is what gets pooled. The cross-tile
 *      tests interleave two offsets and assert the merged, sorted result.
 *   3. The ENU frame + model matrix, including the deliberate non-finite
 *      collapse (a NaN dimension must not poison the primitive's bounding
 *      sphere) and shortest-arc heading across the ±pi seam.
 *
 * This file imports NO Cesium, mirroring the module it tests; the agreement
 * between that Cesium-free frame and Cesium's own `eastNorthUpToFixedFrame` is
 * cross-checked in `cesium-bounding-box-layer.test.ts`, which may import it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeometryType, sampleTrack } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX } from '@poopdeck.gl/core/style';
import {
  DEFAULT_BOX_FADE_MS,
  DEFAULT_BOX_HEIGHT,
  DEFAULT_BOX_LENGTH,
  DEFAULT_BOX_WIDTH,
  MATRIX4_LENGTH,
  buildTrackedBoxes,
  enuBasis,
  trackedBoxSampleConfig,
  writeBoxModelMatrix,
} from '../src/lib/tracked-boxes';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

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

function objectsFeatures(
  snaps: Snapshot[],
  timeOffset: number,
  omit: readonly ColumnName[],
): BinaryFeatures {
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

  return {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(n),
    startTimes,
    endTimes: startTimes.slice(),
    timeOffset,
    numericProps,
    categoricalProps,
    vectorProps: {},
  };
}

export function objectsTile(
  snaps: Snapshot[],
  timeOffset = 0,
  omit: readonly ColumnName[] = [],
): Tile {
  return {
    id: { z: 16, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'objects',
        extent: 0,
        features: objectsFeatures(snaps, timeOffset, omit),
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

/** A wall-clock-shaped base, so the f32 relative / f64 absolute split is real. */
const T0 = 1_700_000_000_000;

// ─── pooling ─────────────────────────────────────────────────────────────────

describe('buildTrackedBoxes — one box per TRACK, not per keyframe', () => {
  it('collapses many keyframes of the same object into a single entry', () => {
    const tile = objectsTile(
      [
        { lon: 4.9, lat: 52.37, t: 0, trackId: 'a' },
        { lon: 4.9001, lat: 52.37, t: 100, trackId: 'a' },
        { lon: 4.9002, lat: 52.37, t: 200, trackId: 'a' },
        { lon: 5.0, lat: 52.0, t: 0, trackId: 'b' },
        { lon: 5.0001, lat: 52.0, t: 100, trackId: 'b' },
      ],
      T0,
    );
    const build = buildTrackedBoxes([tile]);
    // 5 features in, 2 boxes out — the "train of boxes" regression, in numbers.
    expect(build.totalSnapshots).toBe(5);
    expect(build.boxes).toHaveLength(2);
    expect(build.boxes.map((b) => b.key).sort()).toEqual(['a', 'b']);
    expect(build.boxes.find((b) => b.key === 'a')!.track.times).toHaveLength(3);
  });

  it('reports timeOrigin 0 — the kernel already pooled to absolute epoch-ms', () => {
    const build = buildTrackedBoxes([
      objectsTile([{ lon: 0, lat: 0, t: 0, trackId: 'a' }], T0),
    ]);
    expect(build.timeOrigin).toBe(0);
  });

  it('returns an empty build for no tiles, and for empty tiles', () => {
    expect(buildTrackedBoxes([]).boxes).toEqual([]);
    expect(buildTrackedBoxes([]).timeOrigin).toBe(0);
    expect(buildTrackedBoxes([objectsTile([], T0)]).boxes).toEqual([]);
  });
});

describe('buildTrackedBoxes — absolute-epoch rebasing across tiles', () => {
  it('joins keyframes from tiles with DIFFERENT timeOffsets into one timeline', () => {
    const early = objectsTile(
      [
        { lon: 1, lat: 1, t: 0, trackId: 'a' },
        { lon: 1, lat: 1, t: 100, trackId: 'a' },
      ],
      T0,
    );
    const late = objectsTile(
      [
        { lon: 1, lat: 1, t: 0, trackId: 'a' },
        { lon: 1, lat: 1, t: 100, trackId: 'a' },
      ],
      T0 + 200,
    );
    const build = buildTrackedBoxes([early, late]);
    expect(build.boxes).toHaveLength(1);
    expect(build.boxes[0].track.times).toEqual([
      T0,
      T0 + 100,
      T0 + 200,
      T0 + 300,
    ]);
  });

  it('sorts ascending even when the tiles arrive out of order', () => {
    const early = objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], T0);
    const late = objectsTile(
      [{ lon: 1, lat: 1, t: 0, trackId: 'a' }],
      T0 + 500,
    );
    const forward = buildTrackedBoxes([early, late]).boxes[0].track.times;
    const backward = buildTrackedBoxes([late, early]).boxes[0].track.times;
    expect(forward).toEqual([T0, T0 + 500]);
    expect(backward).toEqual(forward);
  });

  it('drops exact-duplicate timestamps (the same keyframe in two tiles)', () => {
    const a = objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], T0);
    const b = objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], T0);
    const track = buildTrackedBoxes([a, b]).boxes[0].track;
    expect(track.times).toEqual([T0]);
    expect(track.singleton).toBe(true);
  });
});

describe('buildTrackedBoxes — colour + provenance', () => {
  const tiles = () => [
    objectsTile(
      [
        { lon: 1, lat: 1, t: 0, trackId: 'a', category: 'car' },
        { lon: 1, lat: 1, t: 100, trackId: 'a', category: 'car' },
        { lon: 2, lat: 2, t: 0, trackId: 'b', category: 'pedestrian' },
      ],
      T0,
    ),
  ];

  it('bakes one colour per TRACK from its category, alpha normalized to 0..1', () => {
    const build = buildTrackedBoxes(tiles(), {
      colorMapping: { car: [10, 20, 30, 255], pedestrian: [40, 50, 60, 128] },
    });
    const a = build.boxes.find((b) => b.key === 'a')!;
    const b = build.boxes.find((b) => b.key === 'b')!;
    expect([a.r, a.g, a.b]).toEqual([10, 20, 30]);
    expect(a.a).toBe(1);
    expect([b.r, b.g, b.b]).toEqual([40, 50, 60]);
    expect(b.a).toBeCloseTo(128 / 255, 12);
  });

  it('falls back to colorMappingDefault for an unmapped category', () => {
    const build = buildTrackedBoxes(tiles(), {
      colorMapping: { car: [10, 20, 30, 255] },
      colorMappingDefault: [7, 7, 7, 255],
    });
    const b = build.boxes.find((x) => x.key === 'b')!;
    expect([b.r, b.g, b.b]).toEqual([7, 7, 7]);
  });

  it("honours colorProperty: '' as 'no category' rather than as unset", () => {
    // `resolveFields` uses `??`, not `||`, precisely for this: '' is the
    // kernel's documented "constant colour" and must not be replaced by the AV
    // default column name.
    const build = buildTrackedBoxes(tiles(), {
      colorProperty: '',
      colorMapping: { car: [10, 20, 30, 255] },
      colorMappingDefault: [9, 9, 9, 255],
    });
    for (const box of build.boxes) {
      expect(box.track.category).toBe('');
      expect([box.r, box.g, box.b]).toEqual([9, 9, 9]);
    }
  });

  it('records the FIRST sighting of each track id as its pick provenance', () => {
    const tile = objectsTile(
      [
        { lon: 1, lat: 1, t: 0, trackId: 'a' },
        { lon: 2, lat: 2, t: 0, trackId: 'b' },
        { lon: 1, lat: 1, t: 100, trackId: 'a' },
      ],
      T0,
    );
    const build = buildTrackedBoxes([tile]);
    const binary = tile.layers[0].features;
    const a = build.boxes.find((x) => x.key === 'a')!;
    const b = build.boxes.find((x) => x.key === 'b')!;
    expect(a.binary).toBe(binary);
    expect(a.featureIndex).toBe(0); // NOT 2, its later keyframe
    expect(b.binary).toBe(binary);
    expect(b.featureIndex).toBe(1);
  });

  it('leaves a NULL track id with no provenance and its own held singleton', () => {
    const build = buildTrackedBoxes([
      objectsTile(
        [
          { lon: 1, lat: 1, t: 0, trackId: null },
          { lon: 2, lat: 2, t: 100, trackId: null },
        ],
        T0,
      ),
    ]);
    expect(build.boxes).toHaveLength(2); // two synthetic keys, never merged
    for (const box of build.boxes) {
      expect(box.binary).toBeNull();
      expect(box.featureIndex).toBe(-1);
      expect(box.track.singleton).toBe(true);
      expect(box.key.startsWith('∅')).toBe(true);
    }
  });

  it('flags trackIdMissing when a tile carries no track-id column at all', () => {
    const build = buildTrackedBoxes([
      objectsTile(
        [
          { lon: 1, lat: 1, t: 0 },
          { lon: 2, lat: 2, t: 100 },
        ],
        T0,
        ['track_id'],
      ),
    ]);
    expect(build.trackIdMissing).toBe(true);
    expect(build.boxes).toHaveLength(2);
    expect(build.boxes.every((b) => b.binary === null)).toBe(true);
  });

  it('does not flag trackIdMissing when every tile has the column', () => {
    const build = buildTrackedBoxes([
      objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], T0),
    ]);
    expect(build.trackIdMissing).toBe(false);
  });

  it('reads a caller-renamed track-id column for BOTH pooling and provenance', () => {
    const tile = objectsTile([{ lon: 1, lat: 1, t: 0, trackId: 'a' }], T0);
    // Rename the column in place; the two lookups must follow it together.
    tile.layers[0].features.categoricalProps.uuid =
      tile.layers[0].features.categoricalProps.track_id;
    delete tile.layers[0].features.categoricalProps.track_id;
    const build = buildTrackedBoxes([tile], { trackIdProperty: 'uuid' });
    expect(build.trackIdMissing).toBe(false);
    expect(build.boxes[0].key).toBe('a');
    expect(build.boxes[0].featureIndex).toBe(0);
  });
});

// ─── sampling config ─────────────────────────────────────────────────────────

describe('trackedBoxSampleConfig', () => {
  it('defaults to the AV box geometry + deck fade, in RADIANS', () => {
    const cfg = trackedBoxSampleConfig();
    expect(cfg.defaultLength).toBe(DEFAULT_BOX_LENGTH);
    expect(cfg.defaultWidth).toBe(DEFAULT_BOX_WIDTH);
    expect(cfg.defaultHeight).toBe(DEFAULT_BOX_HEIGHT);
    expect(cfg.fadeInDuration).toBe(DEFAULT_BOX_FADE_MS);
    expect(cfg.fadeOutDuration).toBe(DEFAULT_BOX_FADE_MS);
    expect(cfg.angleUnit).toBe('rad');
    expect(cfg.maxGapMs).toBe(Infinity); // interpolate any gap, matching deck/three
    expect(cfg.motion).toBeUndefined(); // never the extended sampler by default
  });

  it('passes every override through', () => {
    const cfg = trackedBoxSampleConfig({
      defaultLength: 9,
      defaultWidth: 8,
      defaultHeight: 7,
      fadeInDuration: 0,
      fadeOutDuration: 6,
      singletonHoldMs: 400,
      maxGapMs: 500,
    });
    expect(cfg.defaultLength).toBe(9);
    expect(cfg.defaultWidth).toBe(8);
    expect(cfg.defaultHeight).toBe(7);
    expect(cfg.fadeInDuration).toBe(0);
    expect(cfg.fadeOutDuration).toBe(6);
    expect(cfg.singletonHoldMs).toBe(400);
    expect(cfg.maxGapMs).toBe(500);
  });
});

describe('pooled track + config → the kernel sampler', () => {
  const cfg = trackedBoxSampleConfig({ fadeInDuration: 0, fadeOutDuration: 0 });

  function oneTrack(snaps: Snapshot[], omit: readonly ColumnName[] = []) {
    return buildTrackedBoxes([objectsTile(snaps, T0, omit)]).boxes[0].track;
  }

  it('emits exactly ONE pose per active track and null when inactive', () => {
    const track = oneTrack([
      { lon: 0, lat: 0, t: 0, trackId: 'a' },
      { lon: 2, lat: 0, t: 1000, trackId: 'a' },
    ]);
    expect(sampleTrack(track, T0 + 500, cfg)!.lon).toBeCloseTo(1, 9);
    expect(sampleTrack(track, T0 - 1, cfg)).toBeNull();
    expect(sampleTrack(track, T0 + 1001, cfg)).toBeNull();
  });

  it('turns the SHORT way across the +-pi heading seam', () => {
    const track = oneTrack([
      { lon: 0, lat: 0, t: 0, trackId: 'a', heading: 3.0 },
      { lon: 0, lat: 0, t: 1000, trackId: 'a', heading: -3.0 },
    ]);
    const mid = sampleTrack(track, T0 + 500, cfg)!.heading;
    // Naive lerp would pass through 0 (a 344-degree spin). Shortest-arc goes the
    // other way and passes through +-pi.
    expect(Math.abs(mid)).toBeCloseTo(Math.PI, 6);
  });

  it('falls back to the default dimensions when the columns are absent', () => {
    const track = oneTrack(
      [
        { lon: 0, lat: 0, t: 0, trackId: 'a' },
        { lon: 0, lat: 0, t: 1000, trackId: 'a' },
      ],
      ['length', 'width', 'height'],
    );
    const s = sampleTrack(track, T0 + 500, cfg)!;
    expect(s.length).toBe(DEFAULT_BOX_LENGTH);
    expect(s.width).toBe(DEFAULT_BOX_WIDTH);
    expect(s.height).toBe(DEFAULT_BOX_HEIGHT);
  });

  it('holds a singleton for +-singletonHoldMs/2 around its lone keyframe', () => {
    const track = oneTrack([{ lon: 0, lat: 0, t: 0, trackId: 'a' }]);
    const held = trackedBoxSampleConfig({ singletonHoldMs: 400 });
    expect(sampleTrack(track, T0 + 199, held)).not.toBeNull();
    expect(sampleTrack(track, T0 + 201, held)).toBeNull();
  });
});

// ─── the frame ───────────────────────────────────────────────────────────────

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
function col(m: number[], c: 0 | 1 | 2 | 3): number[] {
  return [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
}
function norm(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

describe('enuBasis', () => {
  it('is orthonormal and right-handed everywhere, poles included', () => {
    const out: number[] = new Array(9).fill(0);
    for (const [lon, lat] of [
      [0, 0],
      [4.9, 52.37],
      [-122.4, 37.8],
      [179.99, -45],
      [0, 89.999],
      [0, -89.999],
    ] as const) {
      const b = enuBasis(lon, lat, out);
      const e = b.slice(0, 3);
      const n = b.slice(3, 6);
      const u = b.slice(6, 9);
      expect(norm(e)).toBeCloseTo(1, 12);
      expect(norm(n)).toBeCloseTo(1, 12);
      expect(norm(u)).toBeCloseTo(1, 12);
      expect(dot(e, n)).toBeCloseTo(0, 12);
      expect(dot(n, u)).toBeCloseTo(0, 12);
      expect(dot(e, u)).toBeCloseTo(0, 12);
      const en = cross(e, n);
      expect(en[0]).toBeCloseTo(u[0], 12);
      expect(en[1]).toBeCloseTo(u[1], 12);
      expect(en[2]).toBeCloseTo(u[2], 12);
    }
  });

  it('lands on the known frame at (0, 0)', () => {
    const b = enuBasis(0, 0, new Array(9).fill(0));
    // `+ 0` normalizes the -0 that `-Math.sin(0)` legitimately produces.
    const round = (v: number[]) => v.map((x) => Math.round(x) + 0);
    expect(round(b.slice(0, 3))).toEqual([0, 1, 0]); // east = +Y
    expect(round(b.slice(3, 6))).toEqual([0, 0, 1]); // north = +Z
    expect(round(b.slice(6, 9))).toEqual([1, 0, 0]); // up = +X
  });

  it('writes into the caller-supplied buffer and returns it (no allocation)', () => {
    const out: number[] = new Array(9).fill(0);
    expect(enuBasis(10, 20, out)).toBe(out);
  });
});

describe('writeBoxModelMatrix', () => {
  const pose = {
    lon: 4.9,
    lat: 52.37,
    alt: 0,
    heading: 0,
    length: 4.5,
    width: 1.9,
    height: 1.6,
  };

  it('makes each column magnitude the box dimension in metres', () => {
    const m = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), pose);
    expect(norm(col(m, 0))).toBeCloseTo(4.5, 9);
    expect(norm(col(m, 1))).toBeCloseTo(1.9, 9);
    expect(norm(col(m, 2))).toBeCloseTo(1.6, 9);
  });

  it('scales every axis by sizeScale', () => {
    const m = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), pose, 2);
    expect(norm(col(m, 0))).toBeCloseTo(9.0, 9);
    expect(norm(col(m, 1))).toBeCloseTo(3.8, 9);
    expect(norm(col(m, 2))).toBeCloseTo(3.2, 9);
  });

  it('is affine: the 4th row is [0, 0, 0, 1]', () => {
    const m = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), pose);
    expect([m[3], m[7], m[11], m[15]]).toEqual([0, 0, 0, 1]);
  });

  it('puts the LENGTH axis along east at heading 0 and north at heading pi/2', () => {
    const basis = enuBasis(pose.lon, pose.lat, new Array(9).fill(0));
    const east = basis.slice(0, 3);
    const north = basis.slice(3, 6);

    const m0 = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), pose);
    const x0 = col(m0, 0).map((v) => v / pose.length);
    expect(dot(x0, east)).toBeCloseTo(1, 9);

    const m90 = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), {
      ...pose,
      heading: Math.PI / 2,
    });
    const x90 = col(m90, 0).map((v) => v / pose.length);
    expect(dot(x90, north)).toBeCloseTo(1, 9);
  });

  it('keeps the posed frame right-handed at any heading', () => {
    const m = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), {
      ...pose,
      heading: 1.234,
    });
    const x = col(m, 0).map((v) => v / pose.length);
    const y = col(m, 1).map((v) => v / pose.width);
    const z = col(m, 2).map((v) => v / pose.height);
    const xy = cross(x, y);
    expect(xy[0]).toBeCloseTo(z[0], 9);
    expect(xy[1]).toBeCloseTo(z[1], 9);
    expect(xy[2]).toBeCloseTo(z[2], 9);
  });

  it('rests the box BASE on the ground: the origin is lifted half a height', () => {
    const m = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), pose);
    const ground = GLOBE.project(pose.lon, pose.lat, pose.alt);
    const up = enuBasis(pose.lon, pose.lat, new Array(9).fill(0)).slice(6, 9);
    const t = col(m, 3);
    for (let i = 0; i < 3; i++) {
      expect(t[i]).toBeCloseTo(ground[i] + up[i] * (pose.height / 2), 6);
    }
  });

  it('honours geodetic altitude along the same up the lift uses', () => {
    const flat = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), pose);
    const high = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), {
      ...pose,
      alt: 100,
    });
    const up = enuBasis(pose.lon, pose.lat, new Array(9).fill(0)).slice(6, 9);
    const d = [
      col(high, 3)[0] - col(flat, 3)[0],
      col(high, 3)[1] - col(flat, 3)[1],
      col(high, 3)[2] - col(flat, 3)[2],
    ];
    expect(norm(d)).toBeCloseTo(100, 4);
    expect(dot(d, up)).toBeCloseTo(100, 4);
  });

  it('treats a non-finite HEADING as east-aligned rather than as NaN', () => {
    const nan = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), {
      ...pose,
      heading: NaN,
    });
    const zero = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), pose);
    expect(nan).toEqual(zero);
  });

  it('collapses a non-finite DIMENSION to zero, never writing NaN', () => {
    // A NaN anywhere in the matrix propagates into Cesium's bounding-sphere
    // transform and silently takes the whole primitive's culling with it, so
    // the invisible box is the deliberate outcome.
    for (const key of ['length', 'width', 'height'] as const) {
      const m = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), {
        ...pose,
        [key]: NaN,
      });
      expect(m.every((v) => Number.isFinite(v))).toBe(true);
      const axis = key === 'length' ? 0 : key === 'width' ? 1 : 2;
      expect(norm(col(m, axis as 0 | 1 | 2))).toBe(0);
    }
    const inf = writeBoxModelMatrix(new Array(MATRIX4_LENGTH).fill(0), {
      ...pose,
      length: Infinity,
    });
    expect(inf.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('writes into the caller-supplied buffer and returns it (no allocation)', () => {
    const out: number[] = new Array(MATRIX4_LENGTH).fill(0);
    expect(writeBoxModelMatrix(out, pose)).toBe(out);
    expect(out).toHaveLength(MATRIX4_LENGTH);
  });
});

// ─── purity ──────────────────────────────────────────────────────────────────

describe('module purity', () => {
  it('imports no Cesium — the builder must stay unit-testable in plain Node', () => {
    const src = readFileSync(
      new URL('../src/lib/tracked-boxes.ts', import.meta.url),
      'utf8',
    );
    expect(/from\s+'cesium'/.test(src)).toBe(false);
    expect(/from\s+'@cesium\//.test(src)).toBe(false);
  });

  it('projects with the WGS84 datum, not the class-default sphere', () => {
    // The default 'sphere' mis-registers against Cesium's real ellipsoid by up
    // to ~20 km at mid-latitudes, so the explicit datum is load-bearing.
    const src = readFileSync(
      new URL('../src/lib/tracked-boxes.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("datum: 'wgs84'");
  });
});
