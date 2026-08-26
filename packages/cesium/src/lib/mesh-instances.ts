// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * PURE, Cesium-free assembly for the `mesh` kind: recognizable 3D MODELS that
 * move smoothly over an AV `objects/` archive — the Cesium analogue of deck's
 * `AnimatedMeshLayer`, and the mesh sibling of this package's `boundingBox`.
 *
 * ── THE DEFINING CONSTRAINT ──────────────────────────────────────────────────
 * The archive carries one POINT feature per tracked object PER KEYFRAME. A
 * time-WINDOW filter over that would draw N models whenever the window spans N
 * keyframes — the "train of cars" bug, the mesh form of the box layer's "train
 * of boxes". So this module does what the box builder does: it pools every
 * loaded tile's snapshots by `track_id` through `@poopdeck.gl/core`'s SHARED
 * track kernel ({@link buildTrackIndex}), rebasing each keyframe to ABSOLUTE
 * epoch-ms so cross-tile keyframes sort into one timeline, and emits ONE entry
 * per TRACK. The per-frame path then interpolates exactly ONE pose per ACTIVE
 * track ({@link sampleTrack}) — never one model per keyframe.
 *
 * The kernel is imported, not re-implemented: pooling/interpolation drift
 * between backends is a documented failure mode in this repo, and it is why the
 * kernel lives in framework-free core in the first place.
 *
 * ── WHAT THIS MODULE PRODUCES ────────────────────────────────────────────────
 *   • {@link buildMeshInstances} — tiles → one {@link MeshTrackedModel} per
 *     track, carrying its pooled keyframes, its resolved glTF URL (per
 *     CATEGORY), its base colour (already normalized to 0..1 so the per-frame
 *     path never re-divides by 255), its optional attitude keyframes, and its
 *     pick provenance.
 *   • {@link writeMeshModelMatrix} — one pose → a 16-element COLUMN-MAJOR ECEF
 *     model matrix (Cesium `Matrix4`'s own packing), composed from
 *     {@link enuBasis}, a yaw/pitch/roll rotation, and a non-uniform scale.
 *   • {@link sampleMeshAttitude} / {@link slerpQuat} / {@link quatToMeshEuler} —
 *     the optional full 3-axis attitude path, slerped between keyframes.
 *
 * ── THE ROTATION CONVENTION, AND WHY IT MATCHES CESIUM EXACTLY ───────────────
 * `writeMeshModelMatrix` composes, in ECEF metres:
 *   • {@link enuBasis} — the local east/north/up frame at the pose's geodetic
 *     lon/lat, where `up` IS the WGS84 geodetic normal. This reproduces Cesium's
 *     own `Transforms.eastNorthUpToFixedFrame` by construction (and is what
 *     makes it agree with the `{datum:'wgs84'}` projection's altitude term). It
 *     is spelled out here rather than called because this module must stay
 *     Cesium-free and unit-testable in plain Node.
 *   • a `Rz(yaw)·Ry(−pitch)·Rx(roll)` rotation in that frame. That is EXACTLY
 *     `Matrix3.fromHeadingPitchRoll(new HeadingPitchRoll(−yaw, pitch, roll))`:
 *     Cesium's heading is a rotation about NEGATIVE z measured from local east,
 *     while the AV archive's `heading` column is CCW-from-east about local UP,
 *     so `cesiumHeading = −yaw` and the two compositions are the same matrix.
 *     Building it here rather than calling `Transforms.headingPitchRollToFixedFrame`
 *     keeps the maths pure without diverging from it.
 *   • a scale of `[length, width, height] × sizeScale`, so a UNIT model (1 m
 *     cube, +x forward, +y left, +z up — which is the frame Cesium's glTF axis
 *     correction hands the model matrix) is fitted to each object's real
 *     dimensions.
 *
 * The model ORIGIN is placed at the sampled position, exactly like deck's
 * `AnimatedMeshLayer` — there is deliberately NO automatic half-height lift
 * (that is the box layer's behaviour, because a box is drawn around its centre).
 * A model authored centred instead of base-anchored is corrected with the
 * constant {@link MeshPoseOptions.translation}, the analogue of deck's
 * `getTranslation`.
 *
 * Positions are ABSOLUTE f64 ECEF metres, no RTC: `Cartesian3`/`Matrix4` consume
 * CPU doubles, so there is no f32 buffer to protect.
 *
 * ── DELIBERATE DUPLICATION ───────────────────────────────────────────────────
 * {@link enuBasis} and the fade/dimension defaults are byte-equivalent to
 * `lib/tracked-boxes.ts`'s. The two builders were written concurrently and are
 * kept separate on purpose for now: the box matrix half-lifts and the mesh
 * matrix does not, and the two kinds' option surfaces differ (per-category model
 * maps, attitude columns). A later pass could hoist `enuBasis` + the pooling
 * config resolver into one shared module; nothing here depends on their staying
 * apart.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  DEFAULT_TRACK_COLOR,
  GeometryType,
  SINGLETON_HOLD_MS,
  buildTrackIndex,
  type Sample,
  type Track,
  type TrackColor,
  type TrackFieldConfig,
  type TrackSampleConfig,
} from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX, type RGBA255 } from '@poopdeck.gl/core/style';

/**
 * One WGS84 globe for every build — Cesium's native frame. The class default is
 * `'sphere'`, which mis-registers against Cesium's real ellipsoid by up to
 * ~20 km at mid-latitudes, so the datum is always stated. Byte-identical to the
 * point/polyline/box builders' GLOBE; `project` is anchor-independent, so the
 * duplication is deliberate and harmless.
 */
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Elements in a 4×4 model matrix (Cesium `Matrix4`'s packed length). */
export const MATRIX4_LENGTH = 16;

/** Geometric fallbacks used when a dimension column is absent (metres). */
export const DEFAULT_MESH_LENGTH = 4;
export const DEFAULT_MESH_WIDTH = 2;
export const DEFAULT_MESH_HEIGHT = 1.6;

/** Appear/disappear ramp (ms) — deck's `AnimatedMeshLayer` defaults. */
export const DEFAULT_MESH_FADE_MS = 200;

/**
 * Hold window (ms) granted to a track with a single (un-interpolatable)
 * keyframe. This is the KERNEL's 600 — the same value deck's `AnimatedMeshLayer`
 * gets — so a lone object lingers for the same ±300 ms on both backends.
 */
export const MESH_SINGLETON_HOLD_MS = SINGLETON_HOLD_MS;

/** One track's merged, time-sorted attitude keyframes (absolute epoch-ms). */
export interface MeshAttitudeTrack {
  /** Ascending absolute keyframe times (ms). */
  times: Float64Array;
  /** Flat `[qx,qy,qz,qw]` per keyframe, parallel to {@link times}. */
  quats: Float32Array;
}

/** One tracked object, ready to be given a Cesium `Model`. */
export interface MeshTrackedModel {
  /** The track index's key — the `track_id` value, or a synthetic one. */
  key: string;
  /** Pooled keyframes (absolute epoch-ms, sorted, de-duped). */
  track: Track;
  /** The track's `colorProperty` value, and the per-category model key. */
  category: string;
  /**
   * glTF/glb URL for this track, resolved from the per-category map with the
   * default model as fallback. `''` when neither resolved — such a track is
   * pooled and pickable-by-nothing but simply never drawn (there is no
   * placeholder; see the layer header).
   */
  modelUrl: string;
  /** Base colour channels, pre-normalized to 0..1 (Cesium `Color`'s range). */
  r: number;
  g: number;
  b: number;
  /** Base alpha 0..1; the per-frame alpha is `a × Sample.alpha × opacity`. */
  a: number;
  /** Attitude keyframes, or `null` when the quaternion column is off/absent. */
  attitude: MeshAttitudeTrack | null;
  /**
   * Pick provenance — the tile layer and feature index of this track's FIRST
   * sighted keyframe, so a pick resolves to the archive's own decoded columns.
   * `null` / `-1` when the track has no resolvable id.
   */
  binary: BinaryFeatures | null;
  featureIndex: number;
}

/** A built mesh set. */
export interface MeshBuild {
  /** One entry per TRACK — never per keyframe. */
  meshes: MeshTrackedModel[];
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
  /** True when a quaternion column was asked for but unusable on some tile. */
  attitudeMissing: boolean;
  /** Total snapshots pooled (telemetry / test instrumentation). */
  totalSnapshots: number;
}

/** Which tile columns to pool from. Empty names fall back to AV conventions. */
export interface MeshColumns {
  /** Categorical column grouping snapshots into one track. @default 'track_id' */
  trackIdProperty?: string;
  /**
   * Categorical column driving per-track colour AND the per-category model
   * lookup; `''` disables both (one colour, one model). @default 'category'
   */
  colorProperty?: string;
  /** Column whose value becomes the track's label. @default 'category' */
  labelProperty?: string;
  /** Yaw column, RADIANS, 0 = +x/east, CCW. @default 'heading' */
  headingProperty?: string;
  /** Dimension columns, metres. @default 'length' / 'width' / 'height' */
  lengthProperty?: string;
  widthProperty?: string;
  heightProperty?: string;
  /** Speed column, m/s (carried to picking). @default 'speed' */
  speedProperty?: string;
  /**
   * Interleaved `FixedSizeList<f32,4>` attitude column `[qx,qy,qz,qw]` in
   * `vectorProps`. `''` (the default) ⇒ the attitude path is OFF and the scalar
   * heading drives yaw alone.
   * @default ''
   */
  quaternionColumn?: string;
}

/** Everything {@link buildMeshInstances} reads. */
export interface MeshBuildOptions extends MeshColumns {
  /** `{ categoryLabel → RGBA(0–255) }` tint applied to that category's model. */
  colorMapping?: Record<string, RGBA255> | null;
  /** Tint for unmapped / absent categories. @default DEFAULT_TRACK_COLOR */
  colorMappingDefault?: RGBA255;
  /** `{ categoryLabel → glTF/glb URL }`. */
  models?: Record<string, string> | null;
  /** URL for categories absent from {@link models}. @default '' (never drawn) */
  model?: string;
}

/** Resolve the column names once, so pooling and provenance read the SAME ones. */
function resolveFields(opts: MeshBuildOptions): TrackFieldConfig {
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

/** Fade/dimension fallbacks the per-frame sampler applies. */
export interface MeshSampleOptions {
  defaultLength?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  /** Appear/disappear ramp, ms. @default DEFAULT_MESH_FADE_MS */
  fadeInDuration?: number;
  fadeOutDuration?: number;
}

/** {@link MeshSampleOptions} → the shared kernel's per-frame config. */
export function meshSampleConfig(
  opts: MeshSampleOptions = {},
): TrackSampleConfig {
  return {
    defaultLength: opts.defaultLength ?? DEFAULT_MESH_LENGTH,
    defaultWidth: opts.defaultWidth ?? DEFAULT_MESH_WIDTH,
    defaultHeight: opts.defaultHeight ?? DEFAULT_MESH_HEIGHT,
    fadeInDuration: opts.fadeInDuration ?? DEFAULT_MESH_FADE_MS,
    fadeOutDuration: opts.fadeOutDuration ?? DEFAULT_MESH_FADE_MS,
    // Explicit, not inherited: the mesh kind takes the kernel's hold, and
    // saying so pins it against three's 400 ms box fork drifting in here.
    singletonHoldMs: MESH_SINGLETON_HOLD_MS,
  };
}

/**
 * Keep only the tile layers this kind can read. The pooling pass indexes
 * `positions` by FEATURE index, so a linestring/polygon layer would silently
 * park a model on the first few paths' leading vertices. The all-Point case
 * (effectively always, for an AV `objects/` archive) returns the SAME array
 * reference, so a caller's tile-identity short-circuits stay intact.
 */
export function meshPointTiles(tiles: Tile[]): Tile[] {
  let allPoint = true;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      if (tl.features.geometryType !== GeometryType.Point) {
        allPoint = false;
        break;
      }
    }
    if (!allPoint) break;
  }
  if (allPoint) return tiles;
  const out: Tile[] = [];
  for (const tile of tiles) {
    const layers = tile.layers.filter(
      (tl) => tl.features.geometryType === GeometryType.Point,
    );
    if (layers.length > 0) out.push({ ...tile, layers });
  }
  return out;
}

/** `TrackColor` (tuple | byte array) → the 0..1 channels Cesium `Color` wants. */
function normalizeColor(c: TrackColor): [number, number, number, number] {
  const r = (c[0] ?? 0) / 255;
  const g = (c[1] ?? 0) / 255;
  const b = (c[2] ?? 0) / 255;
  const a = (c[3] ?? 255) / 255;
  return [r, g, b, a];
}

/** Per-category model lookup, with the single-model default as the fallback. */
export function resolveModelUrl(
  category: string,
  models: Record<string, string> | null | undefined,
  fallback: string,
): string {
  if (models && category) {
    const hit = models[category];
    if (typeof hit === 'string' && hit.length > 0) return hit;
  }
  return fallback;
}

/**
 * Pool every loaded tile's object snapshots into ONE entry per tracked object,
 * resolving each track's tint, its per-category glTF URL, its pick provenance
 * and (opt-in) its attitude keyframes.
 *
 * Returns an empty build (and `timeOrigin: 0`) when nothing pooled; the layer
 * treats that as "keep what is already drawn" (build-before-teardown).
 */
export function buildMeshInstances(
  tiles: Tile[],
  opts: MeshBuildOptions = {},
): MeshBuild {
  const fields = resolveFields(opts);
  const pointTiles = meshPointTiles(tiles);
  const pooled = buildTrackIndex(pointTiles, fields);

  const quatColumn = opts.quaternionColumn ?? '';
  const fallbackUrl = opts.model ?? '';
  const models = opts.models ?? null;

  // First sighting of each resolvable track id → pick provenance, plus the
  // per-track attitude pool. One pass over the same tiles the kernel pooled.
  const firstSeen = new Map<
    string,
    { binary: BinaryFeatures; featureIndex: number }
  >();
  const quatPool = quatColumn
    ? new Map<string, { times: number[]; quats: number[] }>()
    : null;
  let attitudeMissing = false;

  for (const tile of pointTiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (b.featureCount === 0) continue;
      const trackCol = b.categoricalProps[fields.trackIdProperty];
      if (!trackCol) {
        // No ids on this tile: every snapshot is its own held singleton, with
        // no stable identity to hang provenance or attitude off.
        if (quatPool) attitudeMissing = true;
        continue;
      }
      // The leaf type is load-bearing: a u8 leaf against float quaternion
      // components is a format mismatch, not a rescale — refuse it.
      const quatCol = quatPool ? b.vectorProps?.[quatColumn] : undefined;
      const quats =
        quatCol && quatCol.size === 4 && quatCol.value instanceof Float32Array
          ? quatCol.value
          : null;
      if (quatPool && !quats) attitudeMissing = true;

      for (let i = 0; i < b.featureCount; i++) {
        const idx = trackCol.indices[i];
        if (idx === NULL_CATEGORY_INDEX) continue; // NULL id ⇒ held singleton
        const id = trackCol.categories[idx];
        if (id === undefined) continue;
        if (!firstSeen.has(id))
          firstSeen.set(id, { binary: b, featureIndex: i });
        if (quatPool && quats) {
          let g = quatPool.get(id);
          if (!g) {
            g = { times: [], quats: [] };
            quatPool.set(id, g);
          }
          g.times.push(b.startTimes[i] + b.timeOffset); // → absolute epoch-ms
          const o = i * 4;
          g.quats.push(quats[o], quats[o + 1], quats[o + 2], quats[o + 3]);
        }
      }
    }
  }

  const attitude = quatPool ? sortAttitudePool(quatPool) : null;

  const meshes: MeshTrackedModel[] = [];
  for (const [key, track] of pooled.tracks) {
    const [r, g, b, a] = normalizeColor(track.color);
    const rep = track.trackId ? firstSeen.get(track.trackId) : undefined;
    meshes.push({
      key,
      track,
      category: track.category,
      modelUrl: resolveModelUrl(track.category, models, fallbackUrl),
      r,
      g,
      b,
      a,
      attitude:
        attitude && track.trackId
          ? (attitude.get(track.trackId) ?? null)
          : null,
      binary: rep ? rep.binary : null,
      featureIndex: rep ? rep.featureIndex : -1,
    });
  }

  return {
    meshes,
    timeOrigin: 0, // see MeshBuild.timeOrigin — absolute by construction
    trackIdMissing: pooled.trackIdMissing,
    attitudeMissing,
    totalSnapshots: pooled.totalSnapshots,
  };
}

/**
 * Sort each track's pooled quaternions into ONE ascending timeline. Cross-tile
 * keyframes arrive tile-ordered, exactly as positions do before the kernel sorts
 * them; a stable sort keeps equal stamps in arrival order so the attitude
 * timeline lines up with the position timeline the kernel produced.
 */
function sortAttitudePool(
  pool: Map<string, { times: number[]; quats: number[] }>,
): Map<string, MeshAttitudeTrack> {
  const out = new Map<string, MeshAttitudeTrack>();
  for (const [id, g] of pool) {
    const n = g.times.length;
    if (n === 0) continue;
    const order = new Array<number>(n);
    for (let k = 0; k < n; k++) order[k] = k;
    order.sort((a, c) => g.times[a] - g.times[c]);
    const times = new Float64Array(n);
    const quats = new Float32Array(n * 4);
    for (let w = 0; w < n; w++) {
      const r = order[w];
      times[w] = g.times[r];
      quats[w * 4] = g.quats[r * 4];
      quats[w * 4 + 1] = g.quats[r * 4 + 1];
      quats[w * 4 + 2] = g.quats[r * 4 + 2];
      quats[w * 4 + 3] = g.quats[r * 4 + 3];
    }
    out.set(id, { times, quats });
  }
  return out;
}

// ─── Attitude: quaternion → euler, slerped between keyframes ────────────────

/**
 * Unit quaternion → intrinsic Z-Y-X euler `[pitch, yaw, roll]` in DEGREES.
 *
 * Byte-for-byte the same extraction as deck's `quatToDeckEuler` and three's
 * `quatToMeshEuler`, deliberately: one archive's quaternion column must pose a
 * model identically on every backend, and a hand-copied variant is exactly the
 * CPU-logic drift this repo keeps getting bitten by.
 */
export function quatToMeshEuler(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: [number, number, number],
): void {
  const n = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  const w = qw / n;

  // R20 = 2(xz - yw) = -sin(pitch)
  const sp = Math.min(1, Math.max(-1, -2 * (x * z - y * w)));
  const pitch = Math.asin(sp);
  const cp = Math.sqrt(1 - sp * sp);

  let yaw: number;
  let roll: number;
  if (cp < 1e-6) {
    // Gimbal lock (nose straight up/down): yaw and roll are the same DOF.
    roll = 0;
    yaw = Math.atan2(-2 * (x * y - z * w), 1 - 2 * (x * x + z * z));
  } else {
    yaw = Math.atan2(2 * (x * y + z * w), 1 - 2 * (y * y + z * z));
    roll = Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + y * y));
  }
  out[0] = pitch * RAD2DEG;
  out[1] = yaw * RAD2DEG;
  out[2] = roll * RAD2DEG;
}

/**
 * Shortest-arc slerp of two quaternions held in one flat buffer. `q` and `−q`
 * are the SAME rotation, so a negative dot is flipped before interpolating —
 * without that, a vehicle turning through the antipodal representation would
 * take the long way round (the quaternion analogue of the heading seam).
 */
export function slerpQuat(
  q: Float32Array,
  ia: number,
  ib: number,
  t: number,
  out: [number, number, number, number],
): void {
  const ax = q[ia];
  const ay = q[ia + 1];
  const az = q[ia + 2];
  const aw = q[ia + 3];
  let bx = q[ib];
  let by = q[ib + 1];
  let bz = q[ib + 2];
  let bw = q[ib + 3];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  let s0: number;
  let s1: number;
  if (dot > 0.9995) {
    // Nearly parallel — lerp (re-normalized in quatToMeshEuler) to dodge 0/0.
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }
  out[0] = s0 * ax + s1 * bx;
  out[1] = s0 * ay + s1 * by;
  out[2] = s0 * az + s1 * bz;
  out[3] = s0 * aw + s1 * bw;
}

/** Scratch for the slerped quaternion — the attitude path allocates nothing. */
const SLERP_Q: [number, number, number, number] = [0, 0, 0, 1];

/**
 * Slerp one track's attitude at absolute `now`, written to `out` as euler
 * DEGREES `[pitch, yaw, roll]`. Returns false when there are no attitude
 * keyframes, so the caller falls back to the scalar heading (yaw only).
 *
 * Outside the keyframe span the terminal attitude is HELD rather than
 * extrapolated: an orientation is a measurement, and spinning a model past the
 * last one it was measured at would be fabrication.
 */
export function sampleMeshAttitude(
  attitude: MeshAttitudeTrack | null,
  now: number,
  out: [number, number, number],
): boolean {
  if (!attitude || attitude.times.length === 0) return false;
  const { times, quats } = attitude;
  const n = times.length;

  if (n === 1 || now <= times[0]) {
    quatToMeshEuler(quats[0], quats[1], quats[2], quats[3], out);
    return true;
  }
  if (now >= times[n - 1]) {
    const o = (n - 1) * 4;
    quatToMeshEuler(quats[o], quats[o + 1], quats[o + 2], quats[o + 3], out);
    return true;
  }

  // Largest lo with times[lo] <= now (times ascending).
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= now) lo = mid;
    else hi = mid;
  }
  const dt = times[hi] - times[lo];
  const t = dt > 0 ? (now - times[lo]) / dt : 0;
  slerpQuat(quats, lo * 4, hi * 4, t, SLERP_Q);
  quatToMeshEuler(SLERP_Q[0], SLERP_Q[1], SLERP_Q[2], SLERP_Q[3], out);
  return true;
}

// ─── The per-frame model matrix ─────────────────────────────────────────────

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

/** How a pose becomes a matrix. All angles that reach here are degrees. */
export interface MeshPoseOptions {
  /**
   * Fit the model to each object's `length`/`width`/`height` columns (a UNIT
   * model, +x forward, +y left, +z up, becomes exactly that many metres).
   * @default true
   */
  scaleToDimensions: boolean;
  /** Uniform scale used when {@link scaleToDimensions} is off. @default 1 */
  modelScale: number;
  /** Multiplies whichever of the two scales applies. @default 1 */
  sizeScale: number;
  /**
   * Constant `[pitch, yaw, roll]` DEGREES added to every pose — the same tuple
   * ORDER and the same numbers as deck's `orientationOffset`, for a model whose
   * native forward axis is not +x (a −y-forward car needs `yaw: 90`).
   */
  orientationOffset: [number, number, number];
  /**
   * Constant `[east, north, up]` METRES added in the pose's LOCAL ENU frame
   * (unrotated), the analogue of deck's `getTranslation`. A model authored
   * centred rather than base-anchored is corrected with `up: height/2`; the
   * layer applies no automatic lift.
   */
  translation: [number, number, number];
}

/** Defaults for {@link MeshPoseOptions}, spelled once. */
export function meshPoseOptions(
  partial: Partial<MeshPoseOptions> = {},
): MeshPoseOptions {
  return {
    scaleToDimensions: partial.scaleToDimensions ?? true,
    modelScale: partial.modelScale ?? 1,
    sizeScale: partial.sizeScale ?? 1,
    orientationOffset: partial.orientationOffset ?? [0, 0, 0],
    translation: partial.translation ?? [0, 0, 0],
  };
}

/**
 * Shared basis scratch. Safe for the same reason the layers' Cesium scratches
 * are: JS is single-threaded and {@link writeMeshModelMatrix} consumes it fully
 * before returning, so no two calls can interleave.
 */
const SCRATCH_BASIS: number[] = new Array(9).fill(0);

/** A non-finite extent renders as nothing rather than poisoning the frame. */
function finiteExtent(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Write the ECEF model matrix for one interpolated pose into `out` (16 elements,
 * COLUMN-MAJOR — Cesium `Matrix4`'s own packing, so
 * `Matrix4.fromColumnMajorArray(out, m)` consumes it directly).
 *
 * `attitudeDeg` is the slerped `[pitch, yaw, roll]` from
 * {@link sampleMeshAttitude}, or `null` to take yaw from the scalar `heading`
 * column with pitch and roll flat. Either way
 * {@link MeshPoseOptions.orientationOffset} is added afterwards, so a model with
 * an odd native axis is corrected identically on both paths.
 *
 * A non-finite dimension collapses that axis to 0 (an invisible model) instead
 * of writing NaN: NaN would propagate into Cesium's bounding-sphere transform
 * and poison culling for the whole frame, which is far worse than one object
 * silently missing.
 */
export function writeMeshModelMatrix(
  out: number[],
  s: Sample,
  attitudeDeg: [number, number, number] | null,
  o: MeshPoseOptions,
): number[] {
  const [x, y, z] = GLOBE.project(
    s.lon,
    s.lat,
    Number.isFinite(s.alt) ? s.alt : 0,
  );
  const B = enuBasis(s.lon, s.lat, SCRATCH_BASIS);

  // Angles, in the AV convention: yaw CCW-from-east about local up.
  const yaw =
    (attitudeDeg
      ? attitudeDeg[1] * DEG2RAD
      : Number.isFinite(s.heading)
        ? s.heading
        : 0) +
    o.orientationOffset[1] * DEG2RAD;
  const pitch =
    (attitudeDeg ? attitudeDeg[0] * DEG2RAD : 0) +
    o.orientationOffset[0] * DEG2RAD;
  const roll =
    (attitudeDeg ? attitudeDeg[2] * DEG2RAD : 0) +
    o.orientationOffset[2] * DEG2RAD;

  // Rz(yaw)·Ry(−pitch)·Rx(roll) — see the module header: this IS Cesium's
  // `HeadingPitchRoll(−yaw, pitch, roll)`, so pitch is nose-UP positive.
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ct = Math.cos(pitch);
  const st = -Math.sin(pitch); // theta = −pitch
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);

  // Columns of the rotation, expressed in the LOCAL east/north/up frame.
  const fx = cy * ct; // +x, forward
  const fy = sy * ct;
  const fz = -st;
  const lx = cy * st * sr - sy * cr; // +y, left
  const ly = sy * st * sr + cy * cr;
  const lz = ct * sr;
  const ux = cy * st * cr + sy * sr; // +z, up
  const uy = sy * st * cr - cy * sr;
  const uz = ct * cr;

  const scale = o.sizeScale;
  const sxRaw = o.scaleToDimensions ? s.length : o.modelScale;
  const syRaw = o.scaleToDimensions ? s.width : o.modelScale;
  const szRaw = o.scaleToDimensions ? s.height : o.modelScale;
  const sx = finiteExtent(sxRaw) * scale;
  const sw = finiteExtent(syRaw) * scale;
  const sh = finiteExtent(szRaw) * scale;

  // column 0 — forward axis, scaled by length
  out[0] = (B[0] * fx + B[3] * fy + B[6] * fz) * sx;
  out[1] = (B[1] * fx + B[4] * fy + B[7] * fz) * sx;
  out[2] = (B[2] * fx + B[5] * fy + B[8] * fz) * sx;
  out[3] = 0;
  // column 1 — left axis, scaled by width
  out[4] = (B[0] * lx + B[3] * ly + B[6] * lz) * sw;
  out[5] = (B[1] * lx + B[4] * ly + B[7] * lz) * sw;
  out[6] = (B[2] * lx + B[5] * ly + B[8] * lz) * sw;
  out[7] = 0;
  // column 2 — up axis, scaled by height
  out[8] = (B[0] * ux + B[3] * uy + B[6] * uz) * sh;
  out[9] = (B[1] * ux + B[4] * uy + B[7] * uz) * sh;
  out[10] = (B[2] * ux + B[5] * uy + B[8] * uz) * sh;
  out[11] = 0;
  // column 3 — the pose, plus the constant ENU translation (metres, unrotated)
  const [te, tn, tu] = o.translation;
  out[12] = x + B[0] * te + B[3] * tn + B[6] * tu;
  out[13] = y + B[1] * te + B[4] * tn + B[7] * tu;
  out[14] = z + B[2] * te + B[5] * tn + B[8] * tu;
  out[15] = 1;
  return out;
}

export type { Sample, Track };
