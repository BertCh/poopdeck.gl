// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// The pure pooling + per-frame pose bake behind the MESH kind. Everything here
// is Node-only typed-array math — no WebGPU device, no shader — per this
// package's test policy.
//
// The load-bearing assertion of the whole kind is the first one: an archive
// carrying N keyframes per object must yield ONE instance per ACTIVE TRACK, not
// N. A time-WINDOW filter over this data draws a "train" of models behind every
// car, which is the bug deck's AnimatedMeshLayer was rewritten to kill; the
// three port has to be pinned against the same regression. The rest covers the
// pieces that make that one instance CORRECT: cross-tile keyframe joining,
// shortest-arc heading through the 350°→10° seam, quaternion slerp (including
// the antipodal representation), appear/disappear, the RTC contract, and the
// grow-only buffers that keep the per-frame bake allocation-free.

import { describe, it, expect } from 'vitest';
import type { BinaryFeatures, Tile, TileId } from '@poopdeck.gl/core';
import { decodePickId, encodePickId } from '@poopdeck.gl/core/picking';
import {
  bakeMeshGroup,
  buildMeshTrackIndex,
  ensureMeshPoseCapacity,
  findMeshSample,
  makeMeshPoseBuffers,
  meshRtcOrigin,
  meshTrackBbox,
  quatToMeshEuler,
  sampleMeshAttitude,
  sampleMeshFrame,
  MESH_SINGLE_GROUP,
  type MeshGroup,
  type MeshPoseOptions,
  type MeshTrackIndex,
  type MeshTrackOptions,
} from '../src/lib/mesh-instances';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import { featureTileKey } from '../src/lib/id-pick';
import { makeLineTile, makePointTile } from './_support/features';
import { expectEmptyBuffers } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const DEG = Math.PI / 180;
/** ENU metres per degree of longitude at the anchor — one lon step in world x. */
const M_PER_LON = 111_320 * Math.cos(anchor.latitude * DEG);

const TRACK_OPTS: MeshTrackOptions = {
  trackIdProperty: 'track_id',
  colorProperty: 'category',
  colorMapping: { car: [255, 0, 0, 255], ped: [0, 255, 0, 255] },
  colorMappingDefault: [255, 255, 255, 255],
  labelProperty: 'category',
  headingProperty: 'heading',
  lengthProperty: 'length',
  widthProperty: 'width',
  heightProperty: 'height',
  speedProperty: 'speed',
  quaternionColumn: '',
};

const POSE_OPTS: MeshPoseOptions = {
  defaultLength: 4,
  defaultWidth: 2,
  defaultHeight: 1.6,
  // Fades off by default so the alpha assertions below are about colour, not
  // about where in the ramp the playhead happens to sit.
  fadeInDuration: 0,
  fadeOutDuration: 0,
  sizeScale: 1,
  scaleToDimensions: true,
  orientationOffset: [0, 0, 0],
  modelOffset: [0, 0, 0],
  groupKey: () => MESH_SINGLE_GROUP,
};

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Row {
  /** `track_id` value. */
  id: string;
  /** Tile-relative start time (ms); the tile's `timeOffset` rebases it. */
  t: number;
  lon: number;
  lat: number;
  /** Heading in RADIANS (the archive's unit). */
  heading?: number;
  category?: string;
  length?: number;
  width?: number;
  height?: number;
  speed?: number;
  quat?: [number, number, number, number];
}

/** Build a dictionary-encoded categorical column from raw label values. */
function catProp(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
  const categories: string[] = [];
  const indices = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let k = categories.indexOf(values[i]);
    if (k < 0) {
      k = categories.length;
      categories.push(values[i]);
    }
    indices[i] = k;
  }
  return { indices, categories };
}

/** An AV `objects/`-shaped point tile: one snapshot per row. */
function trackTile(
  rows: Row[],
  opts: {
    id?: TileId;
    layerName?: string;
    timeOffset?: number;
    quaternionColumn?: string;
    /** Omit the track-id column entirely (the un-poolable archive). */
    noTrackId?: boolean;
  } = {},
): Tile {
  const positions: number[] = [];
  for (const r of rows) positions.push(r.lon, r.lat);
  const partial: Partial<BinaryFeatures> = {
    startTimes: new Float32Array(rows.map((r) => r.t)),
    endTimes: new Float32Array(rows.map((r) => r.t)),
    categoricalProps: {
      ...(opts.noTrackId ? {} : { track_id: catProp(rows.map((r) => r.id)) }),
      category: catProp(rows.map((r) => r.category ?? 'car')),
    },
    numericProps: {
      heading: new Float32Array(rows.map((r) => r.heading ?? 0)),
      length: new Float32Array(rows.map((r) => r.length ?? 4)),
      width: new Float32Array(rows.map((r) => r.width ?? 2)),
      height: new Float32Array(rows.map((r) => r.height ?? 1.6)),
      speed: new Float32Array(rows.map((r) => r.speed ?? 0)),
    },
  };
  if (opts.quaternionColumn) {
    const q = new Float32Array(rows.length * 4);
    rows.forEach((r, i) => q.set(r.quat ?? [0, 0, 0, 1], i * 4));
    partial.vectorProps = { [opts.quaternionColumn]: { value: q, size: 4 } };
  }
  return makePointTile(rows.length, positions, partial, {
    id: opts.id,
    layerName: opts.layerName ?? 'objects',
    timeOffset: opts.timeOffset ?? 0,
  });
}

/** Pool + sample + bake one frame; returns the single render group. */
function bakeFrame(
  index: MeshTrackIndex,
  now: number,
  opts: MeshPoseOptions = POSE_OPTS,
  groups = new Map<string, MeshGroup>(),
  projection = proj,
  origin: [number, number, number] = [0, 0, 0],
): { groups: Map<string, MeshGroup>; active: number; group?: MeshGroup } {
  const active = sampleMeshFrame(index, now, opts, groups);
  for (const g of groups.values()) {
    bakeMeshGroup(g, index, projection, origin, now, opts);
  }
  return { groups, active, group: groups.get(MESH_SINGLE_GROUP) };
}

// ── ONE INSTANCE PER ACTIVE TRACK ───────────────────────────────────────────

describe('mesh pooling: one instance per ACTIVE TRACK, never one per keyframe', () => {
  it('collapses a 4-keyframe track to a SINGLE interpolated instance', () => {
    const tile = trackTile([
      { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
      { id: 'A', t: 1000, lon: anchor.longitude + 0.001, lat: anchor.latitude },
      { id: 'A', t: 2000, lon: anchor.longitude + 0.002, lat: anchor.latitude },
      { id: 'A', t: 3000, lon: anchor.longitude + 0.003, lat: anchor.latitude },
    ]);
    const index = buildMeshTrackIndex([tile], TRACK_OPTS);

    // Four snapshots pooled into ONE track...
    expect(index.tracks.size).toBe(1);
    expect(index.ordinals.length).toBe(1);
    expect(index.ordinals[0].times.length).toBe(4);

    // ...and at any playhead inside the span, exactly ONE instance is drawn.
    // A time-window filter spanning ≥2 keyframes would emit 2+ here — the
    // "train of models" regression this whole kind exists to avoid.
    for (const now of [0, 500, 1000, 1500, 2999, 3000]) {
      const { active, group } = bakeFrame(index, now);
      expect(active).toBe(1);
      expect(group!.samples.length).toBe(1);
      expect(group!.buffers.count).toBe(1);
    }
  });

  it('emits one instance per track for a 2-track × 3-keyframe archive (6 features)', () => {
    const rows: Row[] = [];
    for (const id of ['A', 'B']) {
      for (let k = 0; k < 3; k++) {
        rows.push({
          id,
          t: k * 1000,
          lon: anchor.longitude + (id === 'A' ? 0 : 0.01) + k * 0.001,
          lat: anchor.latitude,
        });
      }
    }
    const index = buildMeshTrackIndex([trackTile(rows)], TRACK_OPTS);
    expect(index.ordinals.length).toBe(2);
    const { active, group } = bakeFrame(index, 1500);
    expect(active).toBe(2);
    expect(group!.buffers.count).toBe(2);
  });

  it('places the single instance BETWEEN its bracketing keyframes', () => {
    const index = buildMeshTrackIndex(
      [
        trackTile([
          { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
          {
            id: 'A',
            t: 1000,
            lon: anchor.longitude + 0.002,
            lat: anchor.latitude,
          },
        ]),
      ],
      TRACK_OPTS,
    );
    const { group } = bakeFrame(index, 500);
    // Halfway in time ⇒ halfway in space (0.001° east of the anchor).
    expect(group!.samples[0].lon).toBeCloseTo(anchor.longitude + 0.001, 9);
    expect(group!.buffers.centers[0]).toBeCloseTo(0.001 * M_PER_LON, 3);
    expect(group!.buffers.centers[1]).toBeCloseTo(0, 6);
  });
});

// ── CROSS-TILE KEYFRAME JOINING ─────────────────────────────────────────────

describe('mesh pooling: cross-tile keyframes join ONE absolute timeline', () => {
  const tileA = trackTile(
    [
      { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
      { id: 'A', t: 1000, lon: anchor.longitude + 0.001, lat: anchor.latitude },
    ],
    { id: { z: 14, x: 1, y: 2, t: 0 }, timeOffset: 0 },
  );
  const tileB = trackTile(
    [
      { id: 'A', t: 0, lon: anchor.longitude + 0.002, lat: anchor.latitude },
      { id: 'A', t: 1000, lon: anchor.longitude + 0.003, lat: anchor.latitude },
    ],
    { id: { z: 14, x: 1, y: 2, t: 2000 }, timeOffset: 2000 },
  );

  it('rebases each tile-relative keyframe by its tile timeOffset', () => {
    const index = buildMeshTrackIndex([tileA, tileB], TRACK_OPTS);
    expect(index.ordinals.length).toBe(1); // ONE track, not one per tile
    expect(Array.from(index.ordinals[0].times)).toEqual([0, 1000, 2000, 3000]);
  });

  it('interpolates ACROSS the tile boundary (a bracket spanning two tiles)', () => {
    const index = buildMeshTrackIndex([tileA, tileB], TRACK_OPTS);
    // 1500 brackets tile A's last keyframe and tile B's first — only possible
    // because both were rebased into one timeline before sorting.
    const { group } = bakeFrame(index, 1500);
    expect(group!.samples[0].lon).toBeCloseTo(anchor.longitude + 0.0015, 9);
  });

  it('joins tiles supplied in REVERSE order (the pool sorts, it does not trust order)', () => {
    const index = buildMeshTrackIndex([tileB, tileA], TRACK_OPTS);
    expect(Array.from(index.ordinals[0].times)).toEqual([0, 1000, 2000, 3000]);
    const { group } = bakeFrame(index, 1500);
    expect(group!.samples[0].lon).toBeCloseTo(anchor.longitude + 0.0015, 9);
  });
});

// ── SHORTEST-ARC HEADING ────────────────────────────────────────────────────

describe('mesh pose: heading interpolates SHORTEST-ARC through the 350°→10° seam', () => {
  const seamIndex = buildMeshTrackIndex(
    [
      trackTile([
        {
          id: 'A',
          t: 0,
          lon: anchor.longitude,
          lat: anchor.latitude,
          heading: 350 * DEG,
        },
        {
          id: 'A',
          t: 1000,
          lon: anchor.longitude,
          lat: anchor.latitude,
          heading: 10 * DEG,
        },
      ]),
    ],
    TRACK_OPTS,
  );

  it('crosses the wrap forwards (350° → 0° → 10°), never backwards through 180°', () => {
    const { group } = bakeFrame(seamIndex, 500);
    // Midpoint of the SHORT arc is 360° ≡ 0° (due east). The naive lerp would
    // land on 180° (due west) — the classic spinning-marker bug.
    const bx = group!.buffers.basisX;
    expect(bx[0]).toBeCloseTo(4, 3); // model +x → east, × length 4
    expect(Math.abs(bx[1])).toBeLessThan(1e-3);
    expect(Math.abs(bx[2])).toBeLessThan(1e-6);
  });

  it('is monotone across the seam (355° at ¼, 5° at ¾)', () => {
    const quarter = bakeFrame(seamIndex, 250).group!.buffers.basisX;
    const threeQ = bakeFrame(seamIndex, 750).group!.buffers.basisX;
    // 355° ⇒ just south of east; 5° ⇒ just north of east. Both still east-ish.
    expect(quarter[0]).toBeGreaterThan(3.9);
    expect(quarter[1]).toBeLessThan(0);
    expect(threeQ[0]).toBeGreaterThan(3.9);
    expect(threeQ[1]).toBeGreaterThan(0);
  });

  it('orients the basis columns as +x forward / +y left / +z up at heading 0', () => {
    const index = buildMeshTrackIndex(
      [
        trackTile([
          {
            id: 'A',
            t: 0,
            lon: anchor.longitude,
            lat: anchor.latitude,
            heading: 0,
            length: 4,
            width: 2,
            height: 1.6,
          },
          {
            id: 'A',
            t: 1000,
            lon: anchor.longitude,
            lat: anchor.latitude,
            heading: 0,
            length: 4,
            width: 2,
            height: 1.6,
          },
        ]),
      ],
      TRACK_OPTS,
    );
    const b = bakeFrame(index, 500).group!.buffers;
    expect(Array.from(b.basisX.slice(0, 3)).map(round)).toEqual([4, 0, 0]);
    expect(Array.from(b.basisY.slice(0, 3)).map(round)).toEqual([0, 2, 0]);
    expect(Array.from(b.basisZ.slice(0, 3)).map(round)).toEqual([0, 0, 1.6]);
  });

  it('adds the constant orientationOffset yaw on top of the heading', () => {
    const index = buildMeshTrackIndex(
      [
        trackTile([
          {
            id: 'A',
            t: 0,
            lon: anchor.longitude,
            lat: anchor.latitude,
            heading: 0,
          },
          {
            id: 'A',
            t: 1000,
            lon: anchor.longitude,
            lat: anchor.latitude,
            heading: 0,
          },
        ]),
      ],
      TRACK_OPTS,
    );
    // A model whose native forward axis is +y is corrected with a −90° yaw.
    const b = bakeFrame(index, 500, {
      ...POSE_OPTS,
      orientationOffset: [0, -90, 0],
    }).group!.buffers;
    expect(b.basisX[0]).toBeCloseTo(0, 6);
    expect(b.basisX[1]).toBeCloseTo(-4, 6);
  });
});

// ── ATTITUDE QUATERNIONS ────────────────────────────────────────────────────

/** Quaternion for a rotation of `deg` about +z (yaw). */
function yawQuat(deg: number): [number, number, number, number] {
  const h = (deg * DEG) / 2;
  return [0, 0, Math.sin(h), Math.cos(h)];
}

describe('mesh pose: quaternion attitude (slerped, 3-axis) overrides the scalar heading', () => {
  const QUAT_TRACK: MeshTrackOptions = {
    ...TRACK_OPTS,
    quaternionColumn: 'attitude',
  };
  const quatRows = (qb: [number, number, number, number]): Tile =>
    trackTile(
      [
        {
          id: 'A',
          t: 0,
          lon: anchor.longitude,
          lat: anchor.latitude,
          // A deliberately WRONG heading: the quaternion must win.
          heading: Math.PI,
          quat: yawQuat(0),
        },
        {
          id: 'A',
          t: 1000,
          lon: anchor.longitude,
          lat: anchor.latitude,
          heading: Math.PI,
          quat: qb,
        },
      ],
      { quaternionColumn: 'attitude' },
    );

  it('slerps 0° → 90° yaw to 45° at the midpoint', () => {
    const index = buildMeshTrackIndex([quatRows(yawQuat(90))], QUAT_TRACK);
    expect(index.attitude.size).toBe(1);
    expect(index.attitudeMissing).toBe(false);
    const b = bakeFrame(index, 500).group!.buffers;
    const s = Math.SQRT1_2;
    expect(b.basisX[0]).toBeCloseTo(4 * s, 4);
    expect(b.basisX[1]).toBeCloseTo(4 * s, 4);
    expect(Math.abs(b.basisX[2])).toBeLessThan(1e-5);
  });

  it('takes the SHORT way through an ANTIPODAL representation (q ≡ −q)', () => {
    // −q is the same rotation; without the dot-flip the slerp would travel the
    // long way round and land on the opposite side.
    const negated = yawQuat(90).map((v) => -v) as [
      number,
      number,
      number,
      number,
    ];
    const index = buildMeshTrackIndex([quatRows(negated)], QUAT_TRACK);
    const b = bakeFrame(index, 500).group!.buffers;
    const s = Math.SQRT1_2;
    expect(b.basisX[0]).toBeCloseTo(4 * s, 4);
    expect(b.basisX[1]).toBeCloseTo(4 * s, 4);
  });

  it('clamps outside the attitude keyframe span instead of extrapolating', () => {
    const index = buildMeshTrackIndex([quatRows(yawQuat(90))], QUAT_TRACK);
    const out: [number, number, number] = [0, 0, 0];
    expect(sampleMeshAttitude(index, 'A', -5000, out)).toBe(true);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(sampleMeshAttitude(index, 'A', 99999, out)).toBe(true);
    expect(out[1]).toBeCloseTo(90, 4);
  });

  it('reports a missing / mis-shaped attitude column and falls back to heading', () => {
    // The column is simply absent from these tiles.
    const index = buildMeshTrackIndex(
      [
        trackTile([
          {
            id: 'A',
            t: 0,
            lon: anchor.longitude,
            lat: anchor.latitude,
            heading: 0,
          },
          {
            id: 'A',
            t: 1000,
            lon: anchor.longitude,
            lat: anchor.latitude,
            heading: 0,
          },
        ]),
      ],
      QUAT_TRACK,
    );
    expect(index.attitudeMissing).toBe(true);
    expect(index.attitude.size).toBe(0);
    // Heading 0 ⇒ +x still points east, i.e. the scalar path took over.
    const b = bakeFrame(index, 500).group!.buffers;
    expect(b.basisX[0]).toBeCloseTo(4, 6);
  });

  it('quatToMeshEuler extracts [pitch, yaw, roll] degrees in the Rz·Ry·Rx convention', () => {
    const out: [number, number, number] = [0, 0, 0];
    quatToMeshEuler(0, 0, 0, 1, out);
    expect(out.map(round)).toEqual([0, 0, 0]);
    // 90° about +z is pure yaw.
    const [qx, qy, qz, qw] = yawQuat(90);
    quatToMeshEuler(qx, qy, qz, qw, out);
    expect(round(out[0])).toBe(0);
    expect(out[1]).toBeCloseTo(90, 4);
    expect(round(out[2])).toBe(0);
    // 30° about +x is pure roll.
    const h = (30 * DEG) / 2;
    quatToMeshEuler(Math.sin(h), 0, 0, Math.cos(h), out);
    expect(out[2]).toBeCloseTo(30, 4);
  });
});

// ── APPEAR / DISAPPEAR ──────────────────────────────────────────────────────

describe('mesh pose: a track is drawn only while the playhead is inside its span', () => {
  const index = buildMeshTrackIndex(
    [
      trackTile([
        { id: 'A', t: 1000, lon: anchor.longitude, lat: anchor.latitude },
        {
          id: 'A',
          t: 2000,
          lon: anchor.longitude + 0.001,
          lat: anchor.latitude,
        },
      ]),
    ],
    TRACK_OPTS,
  );

  it('emits nothing before the first keyframe or after the last', () => {
    expect(bakeFrame(index, 500).active).toBe(0);
    expect(bakeFrame(index, 2500).active).toBe(0);
  });

  it('emits one instance on the span, endpoints INCLUSIVE', () => {
    for (const now of [1000, 1500, 2000]) {
      expect(bakeFrame(index, now).active).toBe(1);
    }
  });

  it('keeps a group present-but-empty when it goes quiet (no model teardown)', () => {
    const groups = new Map<string, MeshGroup>();
    bakeFrame(index, 1500, POSE_OPTS, groups);
    expect(groups.get(MESH_SINGLE_GROUP)!.buffers.count).toBe(1);
    bakeFrame(index, 5000, POSE_OPTS, groups);
    // The group survives with zero instances rather than vanishing — that is
    // what stops a category's model from being re-uploaded on every reappearance.
    expect(groups.has(MESH_SINGLE_GROUP)).toBe(true);
    expect(groups.get(MESH_SINGLE_GROUP)!.buffers.count).toBe(0);
    expect(groups.get(MESH_SINGLE_GROUP)!.samples.length).toBe(0);
  });

  it('folds the CPU appear ramp into the instance alpha', () => {
    const faded = bakeFrame(index, 1100, {
      ...POSE_OPTS,
      fadeInDuration: 200,
    }).group!.buffers;
    // 100 ms into a 200 ms ramp ⇒ half alpha; RGB is the mapped `car` red.
    expect(faded.colors[0]).toBeCloseTo(1, 6);
    expect(faded.colors[1]).toBeCloseTo(0, 6);
    expect(faded.colors[3]).toBeCloseTo(0.5, 5);
  });

  it('holds a SINGLE-keyframe track for the singleton window, then drops it', () => {
    const lone = buildMeshTrackIndex(
      [
        trackTile([
          { id: 'S', t: 1000, lon: anchor.longitude, lat: anchor.latitude },
        ]),
      ],
      TRACK_OPTS,
    );
    expect(lone.ordinals[0].singleton).toBe(true);
    // Kernel default: ±300 ms around the lone keyframe.
    expect(bakeFrame(lone, 1200).active).toBe(1);
    expect(bakeFrame(lone, 1400).active).toBe(0);
  });
});

// ── GROUPING ────────────────────────────────────────────────────────────────

describe('mesh grouping: per-category render groups', () => {
  const mixed = buildMeshTrackIndex(
    [
      trackTile([
        {
          id: 'A',
          t: 0,
          lon: anchor.longitude,
          lat: anchor.latitude,
          category: 'car',
        },
        {
          id: 'A',
          t: 1000,
          lon: anchor.longitude,
          lat: anchor.latitude,
          category: 'car',
        },
        {
          id: 'B',
          t: 0,
          lon: anchor.longitude + 0.01,
          lat: anchor.latitude,
          category: 'ped',
        },
        {
          id: 'B',
          t: 1000,
          lon: anchor.longitude + 0.01,
          lat: anchor.latitude,
          category: 'ped',
        },
      ]),
    ],
    TRACK_OPTS,
  );

  it('files each track into the group its category resolves to', () => {
    const { groups, active } = bakeFrame(mixed, 500, {
      ...POSE_OPTS,
      groupKey: (c) => `cat:${c}`,
    });
    expect(active).toBe(2);
    expect([...groups.keys()].sort()).toEqual(['cat:car', 'cat:ped']);
    expect(groups.get('cat:car')!.buffers.count).toBe(1);
    expect(groups.get('cat:ped')!.buffers.count).toBe(1);
  });

  it('skips a category the caller has no model for (no sample, no instance)', () => {
    const { groups, active } = bakeFrame(mixed, 500, {
      ...POSE_OPTS,
      groupKey: (c) => (c === 'car' ? 'cat:car' : null),
    });
    expect(active).toBe(1);
    expect([...groups.keys()]).toEqual(['cat:car']);
  });

  it('bakes the mapped per-category colour into each instance', () => {
    const { groups } = bakeFrame(mixed, 500, {
      ...POSE_OPTS,
      groupKey: (c) => `cat:${c}`,
    });
    expect(
      Array.from(groups.get('cat:car')!.buffers.colors.slice(0, 4)),
    ).toEqual([1, 0, 0, 1]);
    expect(
      Array.from(groups.get('cat:ped')!.buffers.colors.slice(0, 4)),
    ).toEqual([0, 1, 0, 1]);
  });
});

// ── GROW-ONLY BUFFERS ───────────────────────────────────────────────────────

describe('mesh instance buffers: grow-only, never reallocated per tick', () => {
  it('grows geometrically in place and never shrinks', () => {
    const buf = makeMeshPoseBuffers(2);
    const first = buf.centers;
    expect(ensureMeshPoseCapacity(buf, 2)).toBe(false);
    expect(buf.centers).toBe(first);

    expect(ensureMeshPoseCapacity(buf, 3)).toBe(true);
    expect(buf.capacity).toBe(4); // max(3, 2×2) — O(log N) reallocations
    const grown = buf.centers;
    expect(grown).not.toBe(first);
    expect(buf.basisX.length).toBe(4 * 3);
    expect(buf.colors.length).toBe(4 * 4);
    expect(buf.idColors.length).toBe(4 * 3);

    // Falling back to one instance must NOT reallocate.
    expect(ensureMeshPoseCapacity(buf, 1)).toBe(false);
    expect(buf.centers).toBe(grown);
  });

  it('reuses the SAME typed arrays across frames as the active count changes', () => {
    const rows: Row[] = [];
    // 24 tracks, staggered so only some are active at any playhead.
    for (let k = 0; k < 24; k++) {
      rows.push({
        id: `T${k}`,
        t: k * 100,
        lon: anchor.longitude + k * 0.0001,
        lat: anchor.latitude,
      });
      rows.push({
        id: `T${k}`,
        t: k * 100 + 1000,
        lon: anchor.longitude + k * 0.0001,
        lat: anchor.latitude,
      });
    }
    const index = buildMeshTrackIndex([trackTile(rows)], TRACK_OPTS);
    const groups = new Map<string, MeshGroup>();

    // A busy frame sets the high-water mark.
    const busy = bakeFrame(index, 1200, POSE_OPTS, groups).group!;
    const busyCount = busy.buffers.count;
    expect(busyCount).toBeGreaterThan(8);
    const arrays = [
      busy.buffers.centers,
      busy.buffers.basisX,
      busy.buffers.basisY,
      busy.buffers.basisZ,
      busy.buffers.colors,
      busy.buffers.idColors,
    ];
    const capacity = busy.buffers.capacity;

    // A quiet frame, then a busy one again — identical arrays throughout.
    const quiet = bakeFrame(index, 100, POSE_OPTS, groups).group!;
    expect(quiet.buffers.count).toBeLessThan(busyCount);
    const again = bakeFrame(index, 1200, POSE_OPTS, groups).group!;
    expect(again.buffers.count).toBe(busyCount);
    expect(again.buffers.capacity).toBe(capacity);
    expect([
      again.buffers.centers,
      again.buffers.basisX,
      again.buffers.basisY,
      again.buffers.basisZ,
      again.buffers.colors,
      again.buffers.idColors,
    ]).toEqual(arrays);
  });

  it('reports reallocation so the layer knows when to re-bind attributes', () => {
    const index = buildMeshTrackIndex(
      [
        trackTile([
          { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
          { id: 'A', t: 1000, lon: anchor.longitude, lat: anchor.latitude },
        ]),
      ],
      TRACK_OPTS,
    );
    const group: MeshGroup = {
      key: MESH_SINGLE_GROUP,
      samples: [],
      ordinals: [],
      buffers: makeMeshPoseBuffers(1),
    };
    const groups = new Map([[MESH_SINGLE_GROUP, group]]);
    sampleMeshFrame(index, 500, POSE_OPTS, groups);
    expect(bakeMeshGroup(group, index, proj, [0, 0, 0], 500, POSE_OPTS)).toBe(
      false,
    );
    // Second bake at the same size: still no reallocation.
    expect(bakeMeshGroup(group, index, proj, [0, 0, 0], 500, POSE_OPTS)).toBe(
      false,
    );
  });
});

// ── PICK IDENTITY ───────────────────────────────────────────────────────────

describe('mesh pick identity: provenance is ordinal-keyed, ids are track ordinals', () => {
  const idA: TileId = { z: 14, x: 1, y: 2, t: 0 };
  const idB: TileId = { z: 14, x: 1, y: 2, t: 2000 };
  const tileA = trackTile(
    [
      { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
      { id: 'A', t: 1000, lon: anchor.longitude + 0.001, lat: anchor.latitude },
    ],
    { id: idA, timeOffset: 0 },
  );
  const tileB = trackTile(
    [
      { id: 'A', t: 0, lon: anchor.longitude + 0.002, lat: anchor.latitude },
      { id: 'B', t: 0, lon: anchor.longitude + 0.01, lat: anchor.latitude },
      { id: 'B', t: 1000, lon: anchor.longitude + 0.011, lat: anchor.latitude },
    ],
    { id: idB, timeOffset: 2000 },
  );

  it('records one entry per TRACK, pointing at that track’s first snapshot', () => {
    const index = buildMeshTrackIndex([tileA, tileB], TRACK_OPTS);
    expect(index.ordinals.length).toBe(2);
    expect(index.provenance.length).toBe(2);
    // Track A's representative is its FIRST pooled snapshot (tile A, feature 0)
    // even though it also appears in tile B.
    expect(index.provenance.resolve(0)).toEqual({
      tileKey: featureTileKey(idA, 'objects'),
      featureIndex: 0,
    });
    // Track B is only in tile B, at feature index 1.
    expect(index.provenance.resolve(1)).toEqual({
      tileKey: featureTileKey(idB, 'objects'),
      featureIndex: 1,
    });
    expect(index.provenance.resolve(2)).toBeNull();
    expect(index.binaryByTileKey.get(featureTileKey(idA, 'objects'))).toBe(
      tileA.layers[0].features,
    );
    expect(index.binaryByTileKey.get(featureTileKey(idB, 'objects'))).toBe(
      tileB.layers[0].features,
    );
  });

  it('paints the TRACK ORDINAL (not the draw slot) into sttIdColor', () => {
    const index = buildMeshTrackIndex([tileA, tileB], TRACK_OPTS);
    // At 2500 only track B is active, so it draws at SLOT 0 — but its id must
    // still be its ordinal (1), or the pick would resolve to track A.
    const { group } = bakeFrame(index, 2500);
    expect(group!.buffers.count).toBe(1);
    expect(group!.ordinals).toEqual([1]);
    expect(decodeSlot(group!.buffers.idColors, 0)).toBe(1);
  });

  it('agrees with the shared encodePickId/decodePickId across the byte boundary', () => {
    const rows: Row[] = [];
    for (let k = 0; k < 260; k++) {
      rows.push({
        id: `T${k}`,
        t: 0,
        lon: anchor.longitude,
        lat: anchor.latitude,
      });
      rows.push({
        id: `T${k}`,
        t: 1000,
        lon: anchor.longitude,
        lat: anchor.latitude,
      });
    }
    const index = buildMeshTrackIndex([trackTile(rows)], TRACK_OPTS);
    expect(index.ordinals.length).toBe(260);
    const { group } = bakeFrame(index, 500);
    expect(group!.buffers.count).toBe(260);
    for (let i = 0; i < 260; i++) {
      const ord = group!.ordinals[i];
      // The inlined big-endian pack in `bakeMeshGroup` must match the shared
      // kernel byte for byte — this is what lets it skip the allocating call.
      const expected = encodePickId(ord);
      for (let c = 0; c < 3; c++) {
        // f32 stores the /255 quotient, so compare within f32 dust rather than
        // exactly — the readback rounds back to the byte either way.
        expect(group!.buffers.idColors[i * 3 + c]).toBeCloseTo(
          expected[c] / 255,
          6,
        );
      }
      expect(decodeSlot(group!.buffers.idColors, i)).toBe(ord);
    }
  });

  it('emits a null-resolving placeholder for an un-poolable (id-less) archive', () => {
    const index = buildMeshTrackIndex(
      [
        trackTile(
          [
            { id: '', t: 0, lon: anchor.longitude, lat: anchor.latitude },
            { id: '', t: 1000, lon: anchor.longitude, lat: anchor.latitude },
          ],
          { noTrackId: true },
        ),
      ],
      TRACK_OPTS,
    );
    expect(index.trackIdMissing).toBe(true);
    // Each snapshot became its own held instance; every one is un-attributable,
    // but the array stays ordinal-aligned so the pick range check still works.
    expect(index.provenance.length).toBe(index.ordinals.length);
    expect(index.provenance.resolve(0)).toEqual({
      tileKey: '',
      featureIndex: -1,
    });
  });

  it('finds the LIVE sample for an ordinal (and null when it is inactive)', () => {
    const index = buildMeshTrackIndex([tileA, tileB], TRACK_OPTS);
    const { groups } = bakeFrame(index, 2500);
    expect(findMeshSample(groups, 1)!.track.trackId).toBe('B');
    expect(findMeshSample(groups, 0)).toBeNull(); // track A ended at 2000
  });
});

// ── GEOMETRY GUARD + RTC ────────────────────────────────────────────────────

describe('mesh pooling: geometry guard, RTC and bounds', () => {
  it('silently SKIPS non-Point tile layers instead of misreading their vertices', () => {
    const line = makeLineTile({}, { layerName: 'roads' });
    expect(buildMeshTrackIndex([line], TRACK_OPTS).ordinals.length).toBe(0);
  });

  it('keeps the Point layers of a mixed tile set', () => {
    const line = makeLineTile({}, { layerName: 'roads' });
    const points = trackTile([
      { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
      { id: 'A', t: 1000, lon: anchor.longitude, lat: anchor.latitude },
    ]);
    const index = buildMeshTrackIndex([line, points], TRACK_OPTS);
    expect(index.ordinals.length).toBe(1);
    expect(index.binaryByTileKey.size).toBe(1); // the linestring layer is gone
  });

  it('emits an empty index (never null) when nothing pools', () => {
    const index = buildMeshTrackIndex([], TRACK_OPTS);
    expect(index.ordinals.length).toBe(0);
    expect(index.provenance.length).toBe(0);
    expect(index.binaryByTileKey.size).toBe(0);
    expect(meshRtcOrigin(index, proj)).toEqual([0, 0, 0]);
    expectEmptyBuffers({
      count: 0,
      bbox: meshTrackBbox(index, proj, [0, 0, 0]),
    });
    expect(bakeFrame(index, 0).active).toBe(0);
  });

  it('keeps RTC offsets tiny under mercator (the origin carries the magnitude)', () => {
    const merc = new MercatorProjection();
    const index = buildMeshTrackIndex(
      [
        trackTile([
          { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
          {
            id: 'A',
            t: 1000,
            lon: anchor.longitude + 0.002,
            lat: anchor.latitude,
          },
        ]),
      ],
      TRACK_OPTS,
    );
    const origin = meshRtcOrigin(index, merc);
    expect(Math.abs(origin[0])).toBeGreaterThan(1e6); // huge absolute mercator x
    const { group } = bakeFrame(
      index,
      1000,
      POSE_OPTS,
      new Map<string, MeshGroup>(),
      merc,
      origin,
    );
    // The far keyframe is ~165 m east; only that offset reaches the f32 buffer.
    expect(Math.abs(group!.buffers.centers[0])).toBeLessThan(500);
    expect(Math.abs(group!.buffers.centers[0])).toBeGreaterThan(1);
  });

  it('bounds every keyframe, not just the current pose', () => {
    const index = buildMeshTrackIndex(
      [
        trackTile([
          { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
          {
            id: 'A',
            t: 1000,
            lon: anchor.longitude + 0.002,
            lat: anchor.latitude,
          },
        ]),
      ],
      TRACK_OPTS,
    );
    const origin = meshRtcOrigin(index, proj);
    const bbox = meshTrackBbox(index, proj, origin)!;
    expect(bbox.min[0]).toBeCloseTo(0, 6);
    expect(bbox.max[0]).toBeCloseTo(0.002 * M_PER_LON, 3);
  });
});

// ── SCALE + ANCHOR ──────────────────────────────────────────────────────────

describe('mesh pose: scaleToDimensions, sizeScale and the model anchor offset', () => {
  const index = buildMeshTrackIndex(
    [
      trackTile([
        {
          id: 'A',
          t: 0,
          lon: anchor.longitude,
          lat: anchor.latitude,
          heading: 0,
          length: 5,
          width: 2,
          height: 3,
        },
        {
          id: 'A',
          t: 1000,
          lon: anchor.longitude,
          lat: anchor.latitude,
          heading: 0,
          length: 5,
          width: 2,
          height: 3,
        },
      ]),
    ],
    TRACK_OPTS,
  );

  it('fits a unit model to [length, width, height]', () => {
    const b = bakeFrame(index, 500).group!.buffers;
    expect(b.basisX[0]).toBeCloseTo(5, 6);
    expect(b.basisY[1]).toBeCloseTo(2, 6);
    expect(b.basisZ[2]).toBeCloseTo(3, 6);
  });

  it('renders at native size (× sizeScale) when scaleToDimensions is off', () => {
    const b = bakeFrame(index, 500, {
      ...POSE_OPTS,
      scaleToDimensions: false,
      sizeScale: 2,
    }).group!.buffers;
    expect(b.basisX[0]).toBeCloseTo(2, 6);
    expect(b.basisY[1]).toBeCloseTo(2, 6);
    expect(b.basisZ[2]).toBeCloseTo(2, 6);
  });

  it('applies modelOffset THROUGH the basis, so it scales with the object', () => {
    const b = bakeFrame(index, 500, {
      ...POSE_OPTS,
      modelOffset: [0, 0, 0.5],
    }).group!.buffers;
    // Half of THIS object's 3 m height, not a constant metre offset.
    expect(b.centers[2]).toBeCloseTo(1.5, 6);
  });
});

/** Round away f32 dust so an exact-equality assertion reads cleanly. */
function round(v: number): number {
  return Math.abs(v) < 1e-6 ? 0 : Math.round(v * 1e6) / 1e6;
}

/** Decode one instance's `sttIdColor` triple back to its integer id. */
function decodeSlot(idColors: Float32Array, slot: number): number {
  return decodePickId([
    Math.round(idColors[slot * 3] * 255),
    Math.round(idColors[slot * 3 + 1] * 255),
    Math.round(idColors[slot * 3 + 2] * 255),
  ]);
}
