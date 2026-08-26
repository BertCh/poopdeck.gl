// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) pooling + per-frame pose bake for the **mesh** kind — the
 * instance side of {@link import('../layers/mesh-layer.js').STTMeshLayer}, and
 * the MESH analogue of what `layers/box-tracks.ts` does for
 * {@link import('../layers/bounding-box-layer.js').STTBoundingBoxLayer}. Where
 * that layer draws twelve wireframe edges per tracked object, this one instances
 * an arbitrary model at the same interpolated pose.
 *
 * ── DATA: the AV `objects/` point archive, VERBATIM ──────────────────────────
 * One POINT feature per tracked object PER KEYFRAME (`track_id`, `category`,
 * `heading`, `length`/`width`/`height`, `speed`, timestamped). Nothing about the
 * archive is mesh-specific: the model is a STATIC per-layer prop (the analogue
 * of IconLayer's atlas), never a tile column.
 *
 * ── MOTION: one instance per ACTIVE TRACK, never one per keyframe ────────────
 * This is the defining constraint of the kind, and the bug deck's
 * `AnimatedMeshLayer` was rewritten to kill. A GPU time-WINDOW filter over this
 * archive shows N instances per object whenever the window spans N keyframes —
 * a "train" of models trailing every car. So there is NO time-window filter
 * here, and consequently no `sttStart`/`sttEnd` attributes and no time-filter
 * uniform in `../tsl/mesh-material.ts` at all:
 *
 *   1. {@link buildMeshTrackIndex} pools every loaded tile's snapshots by
 *      `track_id` — rebasing each keyframe to ABSOLUTE epoch-ms so cross-tile
 *      keyframes join ONE timeline — through the SHARED framework-free track
 *      kernel in `@poopdeck.gl/core` (`render/track-kernel.ts`), the same single
 *      implementation the deck, maplibre and three box layers run on. No second
 *      pooler is written here; this module adds only what the kernel does not
 *      carry (pick provenance and the optional attitude-quaternion index).
 *   2. {@link sampleMeshFrame} interpolates ONE pose per ACTIVE track at the
 *      playhead (binary-search + lerp, SHORTEST-ARC heading, appear/disappear
 *      fade) — inactive tracks return null and simply emit no instance, so
 *      visibility is IMPLICIT rather than shader-gated.
 *   3. {@link bakeMeshGroup} writes those poses into GROW-ONLY instance buffers
 *      the layer owns — sized to the high-water mark of active tracks and
 *      rewritten in place, never reallocated per tick.
 *
 * ── POSE: euler → the local ground frame ─────────────────────────────────────
 * The pose reaches the GPU as three per-instance BASIS columns (the idiom
 * `lib/column-buffers.ts` established), so one instance buffer covers the AV
 * Z-up plane, mercator and the ECEF globe with no shader branch:
 *   `world = centre + ox·basisX + oy·basisY + oz·basisZ`
 * Each basis column is `R[:,j]` — the model→ground rotation, expressed in the
 * projection's per-location east/north/up frame — scaled by the object's
 * dimension on that axis and converted metric→world.
 *
 * `R = Rz(yaw)·Ry(pitch)·Rx(roll)` is deck's `SimpleMeshLayer` convention
 * (`@deck.gl/mesh-layers/src/utils/matrix.ts`), and the euler triple is deck's
 * `[pitch, yaw, roll]` in DEGREES, so the same `orientationOffset` a caller
 * tuned against the deck layer is correct here. Model space is likewise deck's:
 * +x forward, +y left, +z up, a UNIT model that `scaleToDimensions` fits to the
 * object's `[length, width, height]` bbox.
 *
 * Heading (a yaw about local up) rides slot 1 alone. An optional per-feature
 * ATTITUDE QUATERNION column — an interleaved `FixedSizeList<f32,4>`
 * `[qx,qy,qz,qw]` in `vectorProps` — instead drives all three slots: it is
 * SLERPed (shortest-arc) between the keyframes bracketing the playhead and
 * converted to the same euler convention by {@link quatToMeshEuler}. That is
 * what lets a drone or aircraft archive bank and pitch instead of rendering
 * permanently wings-level, which a scalar heading cannot express.
 *
 * ── PICK IDENTITY ────────────────────────────────────────────────────────────
 * See {@link MeshTrackIndex.provenance}: the merged id a pick decodes is the
 * TRACK ORDINAL, not the draw slot — the one documented divergence from the
 * "provenance in draw order" rule, and the reason id colours are written per
 * instance during the bake instead of once via `buildIdColors`.
 *
 * Everything here is Three-free and GPU-free (typed arrays, core binary-tile
 * types and the projection interface only), so it unit-tests in plain Node with
 * no WebGPU device — this package's PURE-core convention.
 */

import { GeometryType } from '@poopdeck.gl/core';
import {
  buildTrackIndex,
  sampleTrack,
  SINGLETON_HOLD_MS,
} from '@poopdeck.gl/core';
import type {
  BinaryFeatures,
  Sample,
  Tile,
  Track,
  TrackFieldConfig,
  TrackSampleConfig,
} from '@poopdeck.gl/core';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { Projection } from '../projection/local-enu.js';
import type { RGBA } from './color.js';
import { featureTileKey } from './id-pick.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Render-group key when no `meshMapping` splits the objects by category. */
export const MESH_SINGLE_GROUP = 'all';

/**
 * Hold window (ms) granted to a track with a single (un-interpolatable)
 * keyframe. This is the KERNEL's 600, NOT `layers/box-tracks.ts`'s 400 — that
 * 400 is a documented historical divergence of the box layer, preserved there
 * precisely so it does not spread. A brand-new kind takes the shared default,
 * which is also what deck's `AnimatedMeshLayer` uses, so a lone object lingers
 * for the same ±300 ms on both backends.
 */
export const MESH_SINGLETON_HOLD_MS = SINGLETON_HOLD_MS;

// ─── Pooling ────────────────────────────────────────────────────────────────

/** Which tile columns the shared track kernel reads when pooling snapshots. */
export interface MeshTrackOptions {
  /** Categorical column grouping snapshots into one track. @default 'track_id' */
  trackIdProperty: string;
  /** Categorical column driving per-instance colour AND the per-category model ('' ⇒ constant). */
  colorProperty: string;
  /** `{ categoryLabel → RGBA(0–255) }`. */
  colorMapping: Record<string, RGBA>;
  /** Colour for unmapped / absent categories. */
  colorMappingDefault: RGBA;
  /** Column whose value becomes the track's label (carried to picking). */
  labelProperty: string;
  /** Yaw column (RADIANS, 0 = +x/east, CCW). */
  headingProperty: string;
  lengthProperty: string;
  widthProperty: string;
  heightProperty: string;
  speedProperty: string;
  /**
   * Interleaved `FixedSizeList<f32,4>` attitude column `[qx,qy,qz,qw]` in
   * `vectorProps`. `''` ⇒ the attitude path is off and heading drives yaw alone.
   */
  quaternionColumn: string;
}

/** One track's merged, time-sorted attitude keyframes (absolute epoch-ms). */
export interface MeshAttitudeTrack {
  /** Ascending absolute keyframe times (ms). */
  times: Float64Array;
  /** Flat `[qx,qy,qz,qw]` per keyframe, parallel to {@link times}. */
  quats: Float32Array;
}

/**
 * The pooled, draw-stable index one `setTiles` produces: every tracked object,
 * its pick identity, and (opt-in) its attitude keyframes.
 */
export interface MeshTrackIndex {
  /** The shared kernel's `track_id`-keyed pool (keys are the kernel's own). */
  tracks: Map<string, Track>;
  /**
   * ORDINAL → track, in `tracks` iteration order. The ordinal is this layer's
   * stable per-object identity: it is what the bake paints into `sttIdColor`
   * and therefore what a GPU pick readback decodes.
   */
  ordinals: Track[];
  /**
   * ORDINAL → the source `(tileKey, featureIndex)` of that track's FIRST pooled
   * snapshot — the "representative" keyframe a pick resolves through
   * `resolveIdPick`.
   *
   * ⚠ THE ONE DIVERGENCE from the picking catalog's "push provenance in EXACT
   * draw order" rule (authoring guide §8.8). Draw order here is the ACTIVE set
   * at the playhead, which changes every frame — indexing provenance by it would
   * mean rebuilding this array 60×/s. Instead the bake WRITES the ordinal into
   * each instance's `sttIdColor`, so the decoded id is an index into THIS array
   * by construction rather than by convention. The invariant the rule protects
   * (decoded id ⇒ correct feature) holds exactly; only the mechanism differs.
   *
   * A track whose snapshots carry no usable `track_id` (no column, or a NULL
   * index) gets a `('', -1)` placeholder so the array stays ordinal-aligned and
   * `provenance.length` still equals the track count — `resolveIdPick` finds no
   * such tileKey and returns `null`, i.e. an un-poolable snapshot is drawn but
   * not attributable.
   */
  provenance: InstanceProvenance;
  /** `tileKey` → source `BinaryFeatures`, for the provenance join. */
  binaryByTileKey: Map<string, BinaryFeatures>;
  /** `track_id` → attitude keyframes; empty unless `quaternionColumn` resolved. */
  attitude: Map<string, MeshAttitudeTrack>;
  /** True when at least one loaded tile LACKED the track-id column. */
  trackIdMissing: boolean;
  /** True when `quaternionColumn` was asked for but unusable on some tile. */
  attitudeMissing: boolean;
}

/** {@link MeshTrackOptions} → the shared kernel's pooling config. */
function trackFields(opts: MeshTrackOptions): TrackFieldConfig {
  return {
    trackIdProperty: opts.trackIdProperty,
    colorProperty: opts.colorProperty,
    labelProperty: opts.labelProperty,
    headingProperty: opts.headingProperty,
    lengthProperty: opts.lengthProperty,
    widthProperty: opts.widthProperty,
    heightProperty: opts.heightProperty,
    speedProperty: opts.speedProperty,
    colorMapping: opts.colorMapping,
    colorMappingDefault: opts.colorMappingDefault,
  };
}

/**
 * Keep only the tile layers this kind can read. The pooling pass indexes
 * `positions` by FEATURE index, so a linestring/polygon layer would silently
 * park a model on the first few paths' leading vertices. The all-Point case
 * (effectively always) returns the SAME array reference, so the caller's
 * tile-identity short-circuits stay intact.
 */
export function meshPointTiles(tiles: Tile[]): Tile[] {
  const accepts = (b: BinaryFeatures): boolean =>
    b.geometryType === GeometryType.Point;
  let ok = true;
  for (const tile of tiles) {
    for (const tl of tile.layers) if (!accepts(tl.features)) ok = false;
  }
  if (ok) return tiles;
  return tiles
    .map((tile) => ({
      ...tile,
      layers: tile.layers.filter((tl) => accepts(tl.features)),
    }))
    .filter((tile) => tile.layers.length > 0);
}

/**
 * Pool every loaded tile's object snapshots into the draw-stable
 * {@link MeshTrackIndex}. O(total snapshots); the layer runs it only when the
 * tile set changes, and re-interpolates (never re-pools) every frame.
 *
 * The keyframe pooling itself is the shared kernel's `buildTrackIndex` verbatim
 * — cross-tile rebasing to absolute epoch-ms, sort, de-dup, per-track colour
 * bake. The extra walk below adds only the two things the kernel does not model:
 * the pick provenance (§ {@link MeshTrackIndex.provenance}) and the optional
 * attitude-quaternion keyframes.
 */
export function buildMeshTrackIndex(
  tiles: Tile[],
  opts: MeshTrackOptions,
): MeshTrackIndex {
  const pointTiles = meshPointTiles(tiles);
  const pooled = buildTrackIndex(pointTiles, trackFields(opts));
  const tracks = pooled.tracks;

  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const firstByTrackId = new Map<
    string,
    { tileKey: string; featureIndex: number }
  >();
  const quatColumn = opts.quaternionColumn;
  const quatPool = quatColumn
    ? new Map<string, { times: number[]; quats: number[] }>()
    : null;
  let attitudeMissing = false;

  for (const tile of pointTiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount) continue;
      const tileKey = featureTileKey(tile.id, tl.name);
      binaryByTileKey.set(tileKey, b);
      const trackCol = b.categoricalProps[opts.trackIdProperty];
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
        if (idx === 0xffff) continue; // NULL id ⇒ un-poolable held singleton
        const id = trackCol.categories[idx];
        if (id === undefined) continue;
        if (!firstByTrackId.has(id)) {
          firstByTrackId.set(id, { tileKey, featureIndex: i });
        }
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

  const ordinals: Track[] = [];
  const provenance = new InstanceProvenance();
  for (const track of tracks.values()) {
    ordinals.push(track);
    const rep = track.trackId ? firstByTrackId.get(track.trackId) : undefined;
    if (rep) provenance.push(rep.tileKey, rep.featureIndex);
    else provenance.push('', -1);
  }

  const attitude = new Map<string, MeshAttitudeTrack>();
  if (quatPool) {
    for (const [id, g] of quatPool) {
      const n = g.times.length;
      if (n === 0) continue;
      // Cross-tile keyframes arrive tile-ordered; sort into one timeline exactly
      // as the kernel does for positions. Stable ⇒ equal stamps keep order.
      const order: number[] = new Array(n);
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
      attitude.set(id, { times, quats });
    }
  }

  return {
    tracks,
    ordinals,
    provenance,
    binaryByTileKey,
    attitude,
    trackIdMissing: pooled.trackIdMissing,
    attitudeMissing,
  };
}

/**
 * RTC origin for a pooled index: the FIRST track's FIRST keyframe, projected
 * (absolute world). `[0,0,0]` when nothing pooled. Every instance centre the
 * bake writes is relative to this, and the layer puts it on `object.position`
 * as an f64 CPU transform — the mandatory RTC discipline (authoring guide §8.1).
 * Under ENU it is ≈ `[0,0,0]`; under mercator/globe it is what keeps f32
 * precision from collapsing at large world coordinates.
 */
export function meshRtcOrigin(
  index: MeshTrackIndex,
  projection: Projection,
): [number, number, number] {
  for (const track of index.ordinals) {
    if (track.times.length === 0) continue;
    return projection.project(track.lon[0], track.lat[0], track.alt[0]);
  }
  return [0, 0, 0];
}

/**
 * RTC-local bbox over EVERY keyframe of every pooled track — the whole space the
 * models will ever occupy, not just this frame's. Static for the life of a tile
 * set, which is what the camera rig's bounds union wants (a per-frame box would
 * make the framing breathe with the traffic).
 */
export function meshTrackBbox(
  index: MeshTrackIndex,
  projection: Projection,
  origin: readonly [number, number, number],
): { min: [number, number, number]; max: [number, number, number] } | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const track of index.ordinals) {
    const n = track.times.length;
    for (let i = 0; i < n; i++) {
      const p = projection.project(track.lon[i], track.lat[i], track.alt[i]);
      const x = p[0] - origin[0];
      const y = p[1] - origin[1];
      const z = p[2] - origin[2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      any = true;
    }
  }
  if (!any) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

// ─── Attitude quaternions ───────────────────────────────────────────────────

/**
 * `[qx,qy,qz,qw]` attitude quaternion → the euler triple `[pitch, yaw, roll]` in
 * DEGREES this kind (and deck's `SimpleMeshLayer`) composes as
 * `R = Rz(yaw)·Ry(pitch)·Rx(roll)` — intrinsic Z-Y'-X'' with yaw about local up,
 * pitch about local north and roll about local east. Extracting that convention
 * from the quaternion's rotation matrix gives `pitch = asin(-R20)`,
 * `yaw = atan2(R10, R00)`, `roll = atan2(R21, R22)`, with the usual gimbal-lock
 * fallback folding roll into yaw when `cos(pitch) ≈ 0`.
 *
 * Byte-for-byte the same extraction as deck's `quatToDeckEuler`, deliberately:
 * one archive's quaternion column must pose a model identically on both
 * backends, and a hand-copied variant is exactly the CPU-logic drift this repo
 * keeps getting bitten by.
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

/** Scratch for the slerped quaternion — the attitude path allocates nothing. */
const SLERP_Q: [number, number, number, number] = [0, 0, 0, 1];

/**
 * Shortest-arc slerp of one track's attitude at absolute `now`, written to `out`
 * as euler DEGREES. Returns false when the track carries no attitude keyframes,
 * so the caller falls back to the scalar heading (yaw only).
 */
export function sampleMeshAttitude(
  index: MeshTrackIndex,
  trackId: string,
  now: number,
  out: [number, number, number],
): boolean {
  const track = trackId ? index.attitude.get(trackId) : undefined;
  if (!track || track.times.length === 0) return false;
  const { times, quats } = track;
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

/**
 * Shortest-arc slerp of two quaternions held in one flat buffer. `q` and `-q`
 * are the SAME rotation, so a negative dot is flipped before interpolating —
 * without that an aircraft banking through the antipodal representation would
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

// ─── Per-frame instance buffers ─────────────────────────────────────────────

/**
 * GROW-ONLY per-instance buffers for one render group, rewritten in place every
 * frame. A 300-object AV scene at 60 fps would otherwise mint five fresh typed
 * arrays per group per tick; capacity climbs geometrically to the high-water
 * mark of simultaneously-active tracks and then never moves again.
 *
 * Every array is a flat `Float32Array` in draw order sized `capacity × itemSize`
 * (no interleaving, no structs) so it binds straight to an
 * `InstancedBufferAttribute`; `count` is the prefix the LAST bake wrote and is
 * what the layer assigns to `geometry.instanceCount`. The tail beyond `count`
 * holds stale poses and is simply not drawn.
 */
export interface MeshPoseBuffers {
  /** Instances the buffers can hold. */
  capacity: number;
  /** Instances the last bake wrote (`geometry.instanceCount`). */
  count: number;
  /** vec3 RTC-local instance anchor. */
  centers: Float32Array;
  /** vec3 model +x (forward) → world, × length. */
  basisX: Float32Array;
  /** vec3 model +y (left) → world, × width. */
  basisY: Float32Array;
  /** vec3 model +z (up) → world, × height. */
  basisZ: Float32Array;
  /** vec4 colour 0..1, appear/disappear fade folded into alpha. */
  colors: Float32Array;
  /** vec3 normalised 24-bit pick id — the TRACK ORDINAL, not the draw slot. */
  idColors: Float32Array;
}

/** Allocate a fresh buffer set (capacity is a hint; at least 1). */
export function makeMeshPoseBuffers(capacity: number): MeshPoseBuffers {
  const cap = Math.max(1, Math.floor(capacity));
  return {
    capacity: cap,
    count: 0,
    centers: new Float32Array(cap * 3),
    basisX: new Float32Array(cap * 3),
    basisY: new Float32Array(cap * 3),
    basisZ: new Float32Array(cap * 3),
    colors: new Float32Array(cap * 4),
    idColors: new Float32Array(cap * 3),
  };
}

/**
 * Ensure `buf` can hold `n` instances, growing GEOMETRICALLY (so a scene ramping
 * up to N objects reallocates O(log N) times, never once per frame) and IN PLACE
 * — the same object comes back, so a caller holding the reference keeps it.
 *
 * @returns true when the arrays were reallocated, i.e. the layer must re-bind
 *   its `InstancedBufferAttribute`s. False (the steady state) means the existing
 *   attributes can be re-uploaded as-is.
 */
export function ensureMeshPoseCapacity(
  buf: MeshPoseBuffers,
  n: number,
): boolean {
  if (n <= buf.capacity) return false;
  const cap = Math.max(n, buf.capacity * 2);
  buf.capacity = cap;
  buf.centers = new Float32Array(cap * 3);
  buf.basisX = new Float32Array(cap * 3);
  buf.basisY = new Float32Array(cap * 3);
  buf.basisZ = new Float32Array(cap * 3);
  buf.colors = new Float32Array(cap * 4);
  buf.idColors = new Float32Array(cap * 3);
  return true;
}

/** One render group: the tracks drawn by ONE model, and their instance buffers. */
export interface MeshGroup {
  /** Group key — {@link MESH_SINGLE_GROUP}, or a category key from the caller. */
  key: string;
  /** This frame's active samples, in draw order. Reused across frames. */
  samples: Sample[];
  /** Global track ordinal per sample (the GPU pick id). Parallel to {@link samples}. */
  ordinals: number[];
  buffers: MeshPoseBuffers;
}

/** Geometric fallbacks, fades and pose options applied at interpolation time. */
export interface MeshPoseOptions {
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  fadeInDuration: number;
  fadeOutDuration: number;
  /** Hold window (ms) for a single-keyframe track. @default MESH_SINGLETON_HOLD_MS */
  singletonHoldMs?: number;
  /**
   * Largest bracket gap (ms) a pose is interpolated across; wider HOLDS the last
   * keyframe rather than gliding a line the object never travelled.
   * @default Infinity
   */
  maxGapMs?: number;
  /** Uniform multiplier on the whole model, on top of the dimension scale. */
  sizeScale: number;
  /**
   * Scale by `[length, width, height]` (fit a UNIT model to the object's bbox).
   * False renders the model at its native size × `sizeScale` — the right choice
   * for a pre-sized car/pedestrian model.
   */
  scaleToDimensions: boolean;
  /** Constant `[pitch, yaw, roll]` DEGREES added to every pose. */
  orientationOffset: readonly [number, number, number];
  /**
   * Constant anchor offset in MODEL units, applied through the instance basis —
   * so it scales with the object. `[0, 0, 0.5]` lifts a centre-origin model by
   * half of ITS OWN height, which a world-metre offset could not express.
   */
  modelOffset: readonly [number, number, number];
  /**
   * Category → render-group key, or `null` to draw nothing for that category
   * (no mapped model and no fallback). The layer owns the mapping; keeping it a
   * callback is what lets this module stay pure.
   */
  groupKey: (category: string) => string | null;
}

/** {@link MeshPoseOptions} → the shared kernel's per-frame sampling config. */
function sampleConfig(opts: MeshPoseOptions): TrackSampleConfig {
  return {
    defaultLength: opts.defaultLength,
    defaultWidth: opts.defaultWidth,
    defaultHeight: opts.defaultHeight,
    fadeInDuration: opts.fadeInDuration,
    fadeOutDuration: opts.fadeOutDuration,
    singletonHoldMs: opts.singletonHoldMs ?? MESH_SINGLETON_HOLD_MS,
    maxGapMs: opts.maxGapMs ?? Infinity,
    // The archive stores heading in RADIANS, so the kernel's shortest-arc lerp
    // must run in radians too — mixing units breaks the ±π seam handling.
    angleUnit: 'rad',
  };
}

/**
 * Interpolate every ACTIVE track to ONE pose at the playhead and file it into
 * its render group — the "no train of models" step. Inactive tracks (the
 * playhead outside their keyframe span) yield nothing at all: this kind has no
 * time-window uniform, so visibility IS membership of this frame's sample set.
 *
 * `groups` is REUSED across frames: existing groups are truncated in place (so
 * their grow-only buffers survive), new ones are created on demand, and a group
 * that goes quiet stays present with zero samples so its model/geometry is not
 * torn down and re-uploaded the moment its category reappears.
 *
 * @returns the total active instance count across every group.
 */
export function sampleMeshFrame(
  index: MeshTrackIndex,
  absoluteTimeMs: number,
  opts: MeshPoseOptions,
  groups: Map<string, MeshGroup>,
): number {
  for (const g of groups.values()) {
    g.samples.length = 0;
    g.ordinals.length = 0;
  }
  // Built ONCE per frame, not once per track: this runs over every resident
  // track on every tick.
  const cfg = sampleConfig(opts);
  const tracks = index.ordinals;
  let active = 0;
  for (let ord = 0; ord < tracks.length; ord++) {
    const track = tracks[ord];
    // Resolve the group BEFORE sampling so a category with no model costs
    // nothing at all (not even the sample allocation).
    const key = opts.groupKey(track.category);
    if (key === null) continue;
    const s = sampleTrack(track, absoluteTimeMs, cfg);
    if (!s) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        samples: [],
        ordinals: [],
        buffers: makeMeshPoseBuffers(16),
      };
      groups.set(key, g);
    }
    g.samples.push(s);
    g.ordinals.push(ord);
    active++;
  }
  return active;
}

/** Scratch euler triple — the bake allocates nothing per instance. */
const EULER: [number, number, number] = [0, 0, 0];

/**
 * Bake one group's sampled poses into its grow-only instance buffers.
 *
 * Per instance this writes the RTC-local anchor, the three model→world basis
 * columns (rotation × dimension scale × metric→world), the faded colour, and
 * the pick id. Nothing is allocated; the euler triple and slerp quaternion are
 * module scratch.
 *
 * @returns true when the buffers were REALLOCATED (the caller must re-bind its
 *   `InstancedBufferAttribute`s); false in the steady state.
 */
export function bakeMeshGroup(
  group: MeshGroup,
  index: MeshTrackIndex,
  projection: Projection,
  origin: readonly [number, number, number],
  absoluteTimeMs: number,
  opts: MeshPoseOptions,
): boolean {
  const n = group.samples.length;
  const grew = ensureMeshPoseCapacity(group.buffers, n);
  const buf = group.buffers;
  buf.count = n;
  if (n === 0) return grew;

  const {
    centers,
    basisX: bxOut,
    basisY: byOut,
    basisZ: bzOut,
    colors,
    idColors,
  } = buf;
  const pitchOff = opts.orientationOffset[0];
  const yawOff = opts.orientationOffset[1];
  const rollOff = opts.orientationOffset[2];
  const tx = opts.modelOffset[0];
  const ty = opts.modelOffset[1];
  const tz = opts.modelOffset[2];
  const sizeScale = opts.sizeScale;
  const scaleDims = opts.scaleToDimensions;
  const hasAttitude = index.attitude.size > 0;

  for (let i = 0; i < n; i++) {
    const s = group.samples[i];
    const o3 = i * 3;
    const o4 = i * 4;

    // A full 3-axis attitude (slerped quaternion) drives all three euler slots;
    // otherwise heading is a yaw about local up and rides slot 1 alone. Either
    // way the constant offset is ADDED — a NaN heading with no quaternion leaves
    // the offset alone, i.e. the model's base pose.
    if (
      hasAttitude &&
      sampleMeshAttitude(index, s.track.trackId, absoluteTimeMs, EULER)
    ) {
      EULER[0] += pitchOff;
      EULER[1] += yawOff;
      EULER[2] += rollOff;
    } else {
      EULER[0] = pitchOff;
      EULER[1] =
        (Number.isFinite(s.heading) ? s.heading * RAD2DEG : 0) + yawOff;
      EULER[2] = rollOff;
    }

    // R = Rz(yaw)·Ry(pitch)·Rx(roll), expressed COLUMN-WISE in the local
    // east/north/up frame: column j is where model axis j points on the ground.
    const p = EULER[0] * DEG2RAD;
    const y = EULER[1] * DEG2RAD;
    const r = EULER[2] * DEG2RAD;
    const cy = Math.cos(y);
    const sy = Math.sin(y);
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    const cr = Math.cos(r);
    const sr = Math.sin(r);
    const c0e = cy * cp;
    const c0n = sy * cp;
    const c0u = -sp;
    const c1e = cy * sp * sr - sy * cr;
    const c1n = sy * sp * sr + cy * cr;
    const c1u = cp * sr;
    const c2e = cy * sp * cr + sy * sr;
    const c2n = sy * sp * cr - cy * sr;
    const c2u = cp * cr;

    // metric → world: one world unit is `metersPerWorldUnit` ground metres, so a
    // 4 m car stays 4 m at any latitude (ENU = 1, mercator = cos(lat)).
    const inv = 1 / projection.metersPerWorldUnit(s.lon, s.lat);
    const kx = (scaleDims ? s.length : 1) * sizeScale * inv;
    const ky = (scaleDims ? s.width : 1) * sizeScale * inv;
    const kz = (scaleDims ? s.height : 1) * sizeScale * inv;

    const frame = projection.localFrame(s.lon, s.lat);
    const e = frame.east;
    const nn = frame.north;
    const u = frame.up;
    bxOut[o3] = (e[0] * c0e + nn[0] * c0n + u[0] * c0u) * kx;
    bxOut[o3 + 1] = (e[1] * c0e + nn[1] * c0n + u[1] * c0u) * kx;
    bxOut[o3 + 2] = (e[2] * c0e + nn[2] * c0n + u[2] * c0u) * kx;
    byOut[o3] = (e[0] * c1e + nn[0] * c1n + u[0] * c1u) * ky;
    byOut[o3 + 1] = (e[1] * c1e + nn[1] * c1n + u[1] * c1u) * ky;
    byOut[o3 + 2] = (e[2] * c1e + nn[2] * c1n + u[2] * c1u) * ky;
    bzOut[o3] = (e[0] * c2e + nn[0] * c2n + u[0] * c2u) * kz;
    bzOut[o3 + 1] = (e[1] * c2e + nn[1] * c2n + u[1] * c2u) * kz;
    bzOut[o3 + 2] = (e[2] * c2e + nn[2] * c2n + u[2] * c2u) * kz;

    // RTC: the absolute projected magnitude stays in the f64 CPU subtraction;
    // only the small local offset reaches the f32 buffer. The model anchor
    // offset rides the (already scaled + rotated) basis, so it tracks the
    // object's own size.
    const pos = projection.project(s.lon, s.lat, s.alt);
    centers[o3] =
      pos[0] - origin[0] + bxOut[o3] * tx + byOut[o3] * ty + bzOut[o3] * tz;
    centers[o3 + 1] =
      pos[1] -
      origin[1] +
      bxOut[o3 + 1] * tx +
      byOut[o3 + 1] * ty +
      bzOut[o3 + 1] * tz;
    centers[o3 + 2] =
      pos[2] -
      origin[2] +
      bxOut[o3 + 2] * tx +
      byOut[o3 + 2] * ty +
      bzOut[o3 + 2] * tz;

    // sRGB bytes → 0..1 floats (the shader converts to working space last), with
    // the CPU appear/disappear ramp folded into alpha.
    const c = s.track.color;
    colors[o4] = c[0] / 255;
    colors[o4 + 1] = c[1] / 255;
    colors[o4 + 2] = c[2] / 255;
    colors[o4 + 3] = ((c[3] ?? 255) / 255) * s.alpha;

    // 24-bit pick id = the TRACK ORDINAL (see MeshTrackIndex.provenance), packed
    // big-endian into RGB. Inlined rather than calling `encodePickId`, which
    // mints a fresh tuple per call and would allocate once per instance per
    // FRAME on this per-frame path; `mesh-instances.test.ts` pins the two
    // against each other so the duplication cannot drift.
    const ord = group.ordinals[i];
    idColors[o3] = ((ord >>> 16) & 0xff) / 255;
    idColors[o3 + 1] = ((ord >>> 8) & 0xff) / 255;
    idColors[o3 + 2] = (ord & 0xff) / 255;
  }
  return grew;
}

/**
 * Find the live sample currently drawn for track ordinal `ord`, or null when
 * that track is inactive this frame. O(active) and called only at pick time —
 * it exists so a hit can report the INTERPOLATED position the model is actually
 * drawn at, rather than the representative keyframe the provenance points to.
 */
export function findMeshSample(
  groups: Map<string, MeshGroup>,
  ord: number,
): Sample | null {
  for (const g of groups.values()) {
    for (let i = 0; i < g.ordinals.length; i++) {
      if (g.ordinals[i] === ord) return g.samples[i];
    }
  }
  return null;
}

export type { Sample, Track };
