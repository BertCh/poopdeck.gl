// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) pooling + pose maths behind `STTBoundingBoxLayer`: the AV
 * `objects/` archive's per-keyframe point snapshots turned into ONE tracked
 * object per `track_id`, plus the ECEF model matrix that puts that object's
 * interpolated cuboid on the WGS84 globe.
 *
 * ── WHY THERE IS NO POOLER IN HERE ───────────────────────────────────────────
 * The pooling and the per-frame interpolation are `@poopdeck.gl/core`'s track
 * kernel (`buildTrackIndex` / `sampleTrack`), imported, not re-implemented. That
 * kernel exists precisely because this codebase has a documented CPU-logic-drift
 * problem, and it already carries the two things this layer's correctness rests
 * on: keyframes rebased to ABSOLUTE epoch-ms (so snapshots from tiles with
 * different `timeOffset`s sort into ONE timeline) and SHORTEST-ARC heading
 * interpolation (`lerpAngle` normalizes the delta into (-π, π] so a box crossing
 * the ±π seam turns the short way instead of spinning 359°). Everything this
 * module adds is the part the kernel deliberately does not know about: which
 * columns to read by default, where a track's pick provenance comes from, and
 * how a pose becomes a 4×4 in Cesium's frame.
 *
 * ── THE DEFINING CONSTRAINT: NO TIME-WINDOW FILTER ───────────────────────────
 * Every other animated layer in this package filters features by a time window
 * and animates ALPHA. This one must not. The objects archive stores one POINT
 * FEATURE PER KEYFRAME, so a window spanning N keyframes of one object would
 * draw N boxes for it — the "train of boxes" the deck layer was rewritten to
 * kill. {@link buildTrackedBoxes} therefore emits one entry per TRACK, never per
 * feature, and the layer emits one interpolated instance per ACTIVE track per
 * frame. Visibility is implicit: an inactive track returns `null` from
 * `sampleTrack` and is simply not drawn. The only alpha anywhere on this path is
 * the kernel's appear/disappear FADE (`Sample.alpha`), which is not a time
 * filter — hence this layer's `EXEMPT_SETTIME` entry in
 * `test/time-filter-oracle.test.ts`.
 *
 * ── THE FRAME ────────────────────────────────────────────────────────────────
 * {@link writeBoxModelMatrix} composes, in ECEF metres:
 *   • {@link enuBasis} — the local east/north/up frame at the pose's geodetic
 *     lon/lat. This reproduces Cesium's own `Transforms.eastNorthUpToFixedFrame`
 *     by construction (up IS the WGS84 geodetic normal, which is what makes the
 *     `{datum:'wgs84'}` projection below and this basis agree); it is spelled out
 *     here rather than called because this module must stay Cesium-free and
 *     unit-testable in plain Node.
 *   • a yaw about local up by `heading` (radians, 0 = +east, CCW toward north —
 *     the AV archive's convention, the same one deck's
 *     `AnimatedBoundingBoxLayer` puts on `getOrientation`'s YAW slot and three's
 *     `writeBoxEdges` uses), so the box's +x is its length axis.
 *   • a scale of [length, width, height] and a half-height lift along up, so the
 *     box BASE rests on the ground the way streetscape.gl / nuScenes boxes do.
 *
 * Output is a 16-element COLUMN-MAJOR array — Cesium `Matrix4`'s own storage
 * order — written into a caller-supplied buffer so the per-frame path allocates
 * nothing.
 *
 * Positions are ABSOLUTE f64 ECEF metres, no RTC: `Cartesian3`/`Matrix4` consume
 * CPU doubles, so there is no f32 buffer to protect.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  DEFAULT_TRACK_COLOR,
  SINGLETON_HOLD_MS,
  buildTrackIndex,
  type Track,
  type TrackFieldConfig,
  type TrackSampleConfig,
} from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX, type RGBA255 } from '@poopdeck.gl/core/style';

/**
 * One WGS84 globe for every build — Cesium's native frame (§5.2: datum matters;
 * the class default `'sphere'` mis-registers against Cesium's ellipsoid by up to
 * ~20 km at mid-latitudes). Byte-identical to the point/polyline builders'
 * GLOBE; `project` is anchor-independent, so the duplication is deliberate.
 */
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEG2RAD = Math.PI / 180;

/** Elements in a 4×4 model matrix (Cesium `Matrix4`'s packed length). */
export const MATRIX4_LENGTH = 16;

/** Geometric fallbacks used when a dimension column is absent (metres). */
export const DEFAULT_BOX_LENGTH = 4;
export const DEFAULT_BOX_WIDTH = 2;
export const DEFAULT_BOX_HEIGHT = 1.6;
/** Appear/disappear ramp (ms) — deck's `AnimatedBoundingBoxLayer` defaults. */
export const DEFAULT_BOX_FADE_MS = 200;

/** Which tile columns to pool from. Empty names fall back to the AV conventions. */
export interface TrackedBoxColumns {
  /** Categorical column grouping snapshots into one track. @default 'track_id' */
  trackIdProperty?: string;
  /** Categorical column driving per-track colour; `''` disables. @default 'category' */
  colorProperty?: string;
  /** Column whose value becomes the track's label. @default 'category' */
  labelProperty?: string;
  /** Heading column, RADIANS, 0 = +east, CCW. @default 'heading' */
  headingProperty?: string;
  /** Box dimension columns (metres). */
  lengthProperty?: string;
  widthProperty?: string;
  heightProperty?: string;
  /** Speed column (m/s) — pooled for picking, not used by the pose. @default 'speed' */
  speedProperty?: string;
}

export interface TrackedBoxBuildOptions extends TrackedBoxColumns {
  /** Category → colour (0–255). */
  colorMapping?: Record<string, RGBA255> | null;
  /** Colour for unmapped / absent categories. @default the kernel's grey */
  colorMappingDefault?: RGBA255;
}

/** Geometric fallbacks + fade ramps applied at interpolation time. */
export interface TrackedBoxSampleOptions {
  defaultLength?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  /** Hold window (ms) for a single-keyframe track. @default 600 (the kernel's) */
  singletonHoldMs?: number;
  /** Largest bracket gap (ms) interpolated across; wider HOLDS. @default Infinity */
  maxGapMs?: number;
}

/**
 * One tracked object, ready to become one Cesium `Primitive`. The keyframes
 * themselves live on {@link Track} in ABSOLUTE epoch-ms; the colour is a
 * per-TRACK constant the kernel baked from the track's `category`.
 */
export interface TrackedBox {
  /** The track index's key — the `track_id` value, or a synthetic `∅n`. */
  key: string;
  /** Pooled keyframes (absolute epoch-ms, sorted, de-duped). */
  track: Track;
  /** Base colour channels, 0–255 (batch-table colours are u8). */
  r: number;
  g: number;
  b: number;
  /** Base alpha 0..1; the per-frame alpha is `a × Sample.alpha`. */
  a: number;
  /**
   * Pick provenance — the tile layer and feature index of this track's FIRST
   * sighted keyframe, so a pick resolves to the archive's own decoded columns
   * via `getFeatureProperties`. `null` / `-1` when the track has no resolvable
   * id (no track-id column, or a NULL id): such a snapshot is its own held
   * singleton and the layer falls back to the kernel's interpolated pick row.
   */
  binary: BinaryFeatures | null;
  featureIndex: number;
}

/** A built tracked-box set. */
export interface TrackedBoxBuild {
  /** One entry per TRACK — never per keyframe. */
  boxes: TrackedBox[];
  /**
   * Absolute time origin (ms) the layer rebases `setTime` against.
   *
   * ALWAYS 0, and that is the point: the track kernel pools every keyframe to
   * ABSOLUTE epoch-ms so snapshots from tiles with different `timeOffset`s join
   * one timeline, which makes this layer's origin the epoch itself. It is
   * carried (and subtracted in `setTime`) anyway so this layer wears the same
   * shape as every other layer in the package — the rebase is the identity here,
   * visibly, rather than absent and having to be rediscovered.
   */
  timeOrigin: number;
  /** True when at least one loaded tile LACKED the track-id column. */
  trackIdMissing: boolean;
  /** Total snapshots pooled (telemetry / test instrumentation). */
  totalSnapshots: number;
}

/** Resolve the column names once, so pooling and provenance read the SAME ones. */
function resolveFields(opts: TrackedBoxBuildOptions): TrackFieldConfig {
  return {
    trackIdProperty: opts.trackIdProperty || 'track_id',
    // `??`, not `||`: '' is the kernel's documented "no category" and must
    // survive, where an unset prop should get the AV default.
    colorProperty: opts.colorProperty ?? 'category',
    labelProperty: opts.labelProperty || 'category',
    headingProperty: opts.headingProperty || 'heading',
    lengthProperty: opts.lengthProperty || 'length',
    widthProperty: opts.widthProperty || 'width',
    heightProperty: opts.heightProperty || 'height',
    speedProperty: opts.speedProperty || 'speed',
    colorMapping: opts.colorMapping ?? null,
    colorMappingDefault: opts.colorMappingDefault ?? DEFAULT_TRACK_COLOR,
  };
}

/**
 * First (tile layer, feature index) sighting of each resolvable track id.
 *
 * This is NOT a second pooler: it reads one categorical column, keeps the first
 * hit per id, and stops. It exists because the kernel's {@link Track} is
 * deliberately provenance-free (parallel numeric arrays, no back-reference to
 * the tile it came from) while this package's pick contract is
 * `{layerId, binary, featureIndex}` → `getFeatureProperties`. Rows with a NULL
 * id, and layers with no track-id column at all, are skipped: the kernel gives
 * those synthetic `∅n` keys which no real category string can collide with, so
 * a lookup for them simply misses and the layer picks by interpolated pose
 * instead.
 */
function indexProvenance(
  tiles: Tile[],
  trackIdProperty: string,
): Map<string, { binary: BinaryFeatures; featureIndex: number }> {
  const prov = new Map<
    string,
    { binary: BinaryFeatures; featureIndex: number }
  >();
  for (const tile of tiles) {
    for (const tileLayer of tile.layers) {
      const binary = tileLayer.features;
      if (binary.featureCount === 0) continue;
      const col = binary.categoricalProps[trackIdProperty];
      if (!col) continue;
      for (let i = 0; i < binary.featureCount; i++) {
        const idx = col.indices[i];
        if (idx === NULL_CATEGORY_INDEX) continue;
        const id = col.categories[idx];
        if (id === undefined || prov.has(id)) continue;
        prov.set(id, { binary, featureIndex: i });
      }
    }
  }
  return prov;
}

/**
 * Pool every loaded tile's object snapshots into ONE entry per tracked object.
 *
 * Uses the kernel's one-shot {@link buildTrackIndex} rather than the incremental
 * `TrackIndexMaintainer` the deck layer runs. Deliberate: `setTiles` here is a
 * REPLACE-ALL that tears down and rebuilds one Cesium `Primitive` per track, and
 * that primitive construction dominates a pool of the few hundred snapshots an
 * AV objects window holds by orders of magnitude — so incrementalising the pool
 * would optimise the cheap half. `TrackIndexMaintainer` is the escalation if an
 * archive ever arrives where pooling, not primitive construction, is the cost.
 *
 * Returns an empty build (and `timeOrigin: 0`) when nothing pooled; the layer
 * checks `boxes.length` BEFORE tearing anything down.
 */
export function buildTrackedBoxes(
  tiles: Tile[],
  opts: TrackedBoxBuildOptions = {},
): TrackedBoxBuild {
  const fields = resolveFields(opts);
  const index = buildTrackIndex(tiles, fields);
  const prov = indexProvenance(tiles, fields.trackIdProperty);

  const boxes: TrackedBox[] = [];
  for (const [key, track] of index.tracks) {
    const p = prov.get(key);
    const c = track.color;
    boxes.push({
      key,
      track,
      r: c[0],
      g: c[1],
      b: c[2],
      a: c[3] / 255,
      binary: p ? p.binary : null,
      featureIndex: p ? p.featureIndex : -1,
    });
  }

  return {
    boxes,
    timeOrigin: 0, // see TrackedBoxBuild.timeOrigin — absolute by construction
    trackIdMissing: index.trackIdMissing,
    totalSnapshots: index.totalSnapshots,
  };
}

/**
 * {@link TrackedBoxSampleOptions} → the kernel's per-frame sampling config.
 * `angleUnit` and `maxGapMs` are spelled out rather than left to the kernel's
 * defaults so the two decisions this layer makes about them are visible at the
 * call site: heading is RADIANS (the AV archive's unit — degrees would take the
 * `lerpAngleDeg` seam instead), and a bracket gap is interpolated across no
 * matter how wide unless the caller says otherwise, matching deck and three.
 */
export function trackedBoxSampleConfig(
  opts: TrackedBoxSampleOptions = {},
): TrackSampleConfig {
  return {
    defaultLength: opts.defaultLength ?? DEFAULT_BOX_LENGTH,
    defaultWidth: opts.defaultWidth ?? DEFAULT_BOX_WIDTH,
    defaultHeight: opts.defaultHeight ?? DEFAULT_BOX_HEIGHT,
    fadeInDuration: opts.fadeInDuration ?? DEFAULT_BOX_FADE_MS,
    fadeOutDuration: opts.fadeOutDuration ?? DEFAULT_BOX_FADE_MS,
    singletonHoldMs: opts.singletonHoldMs ?? SINGLETON_HOLD_MS,
    maxGapMs: opts.maxGapMs ?? Infinity,
    angleUnit: 'rad',
  };
}

/**
 * The interpolated pose a cuboid is built from. `Sample` from the track kernel
 * satisfies this structurally, so a kernel sample drops straight in.
 */
export interface BoxPose {
  lon: number;
  lat: number;
  /** Geodetic altitude (metres); 0 for a 2-D point archive. */
  alt: number;
  /** Radians, 0 = +east, CCW toward north. NaN ⇒ axis-aligned (east-facing). */
  heading: number;
  /** Metres, along the heading axis. */
  length: number;
  /** Metres, across it. */
  width: number;
  /** Metres, from the ground up. */
  height: number;
}

/**
 * Local east/north/up basis (unit ECEF vectors) at geodetic `lon`/`lat`, packed
 * into `out` as `[ex,ey,ez, nx,ny,nz, ux,uy,uz]`.
 *
 * `up` is the WGS84 GEODETIC normal — the direction geodetic altitude is
 * measured along — which is why it agrees exactly with `GLOBE.project`'s
 * `{datum:'wgs84'}` altitude term and with Cesium's
 * `Transforms.eastNorthUpToFixedFrame`. The basis is right-handed and
 * orthonormal at every latitude, including the poles, where `east` stays the
 * (well-defined) meridian-tangent limit.
 */
export function enuBasis(lon: number, lat: number, out: number[]): number[] {
  const lam = lon * DEG2RAD;
  const phi = lat * DEG2RAD;
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  out[0] = -sl; // east
  out[1] = cl;
  out[2] = 0;
  out[3] = -sp * cl; // north
  out[4] = -sp * sl;
  out[5] = cp;
  out[6] = cp * cl; // up (geodetic normal)
  out[7] = cp * sl;
  out[8] = sp;
  return out;
}

/**
 * Shared basis scratch. Safe for the same reason the layers' Cesium scratches
 * are: JS is single-threaded and {@link writeBoxModelMatrix} consumes it fully
 * before returning, so no two calls can interleave.
 */
const SCRATCH_BASIS: number[] = new Array(9).fill(0);

/** A non-finite extent renders as nothing rather than poisoning the frame. */
function finiteExtent(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Write the ECEF model matrix for one box pose into `out` (16 elements,
 * COLUMN-MAJOR — Cesium `Matrix4`'s own packing, so
 * `Matrix4.fromColumnMajorArray(out, m)` consumes it directly).
 *
 * The matrix maps a UNIT cuboid spanning ±0.5 on each axis (Cesium's
 * `BoxGeometry.fromDimensions({dimensions: (1,1,1)})`) to the posed box, so the
 * drawn extent is exactly `length × width × height × sizeScale` metres:
 *   • column 0 = local +x, the LENGTH axis, = `east·cosθ + north·sinθ`, scaled by
 *     length. θ = heading.
 *   • column 1 = local +y, the WIDTH axis, = `−east·sinθ + north·cosθ`
 *     (90° CCW from +x, keeping the frame right-handed), scaled by width.
 *   • column 2 = local +z = `up`, scaled by height.
 *   • column 3 = the pose's ECEF position lifted half a height along `up`, so
 *     the box BASE sits on the ground rather than its centre.
 *
 * A non-finite dimension collapses that axis to 0 (an invisible box) instead of
 * writing NaN: NaN would propagate into Cesium's bounding-sphere transform and
 * take the whole primitive's culling with it, silently. A non-finite heading is
 * treated as 0 — an east-aligned box — matching deck and three.
 */
export function writeBoxModelMatrix(
  out: number[],
  pose: BoxPose,
  sizeScale = 1,
): number[] {
  const b = enuBasis(pose.lon, pose.lat, SCRATCH_BASIS);
  const ex = b[0];
  const ey = b[1];
  const ez = b[2];
  const nx = b[3];
  const ny = b[4];
  const nz = b[5];
  const ux = b[6];
  const uy = b[7];
  const uz = b[8];

  const yaw = Number.isFinite(pose.heading) ? pose.heading : 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const l = finiteExtent(pose.length * sizeScale);
  const w = finiteExtent(pose.width * sizeScale);
  const h = finiteExtent(pose.height * sizeScale);

  out[0] = (ex * c + nx * s) * l;
  out[1] = (ey * c + ny * s) * l;
  out[2] = (ez * c + nz * s) * l;
  out[3] = 0;
  out[4] = (-ex * s + nx * c) * w;
  out[5] = (-ey * s + ny * c) * w;
  out[6] = (-ez * s + nz * c) * w;
  out[7] = 0;
  out[8] = ux * h;
  out[9] = uy * h;
  out[10] = uz * h;
  out[11] = 0;

  const [px, py, pz] = GLOBE.project(pose.lon, pose.lat, pose.alt);
  const lift = h * 0.5;
  out[12] = px + ux * lift;
  out[13] = py + uy * lift;
  out[14] = pz + uz * lift;
  out[15] = 1;
  return out;
}
