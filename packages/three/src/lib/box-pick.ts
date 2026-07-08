// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * CPU ray-vs-oriented-box picking for the click-to-inspect cockpit feature.
 *
 * Like the deck path, only the small set of object boxes + the ego box are
 * pickable (the GPU-instanced surfel/point clouds are not — three's Raycaster
 * can't hit shader-built instanced geometry, and deck doesn't pick points
 * either). Boxes are `LineSegments`, whose interiors a Raycaster can't hit
 * reliably, so we test the camera ray against each active box's yaw-aligned OBB
 * directly. The pickable set is tens of boxes, already CPU-resident per frame,
 * so this is cheap.
 *
 * Boxes are yaw-only (heading about Z), spanning `cz..cz+height` vertically and
 * `±length/2 × ±width/2` in the footprint — i.e. centre = `[cx, cy, cz +
 * height/2]`, half-extents = `[length/2, width/2, height/2]` (all in the local
 * ENU metric world). This matches `geometry/box-edges.ts`.
 */

import type { TileId } from '@poopdeck.gl/core';

export type Vec3 = readonly [number, number, number];

/** Fields shared by every pick-hit variant surfaced to `onPick` (click) / `onHover`. */
export interface SttPickInfoBase {
  /** Id of the STT layer that owns the hit. */
  layerId: string;
  /** World-space hit point (ENU metres), when the pick resolves one. */
  worldPoint?: Vec3;
}

/**
 * A hit on a CPU oriented object/ego box (ray-OBB) — the shape {@link pickBoxes}
 * returns. `worldPoint` is always the ray/box entry point. Structurally a superset
 * of the cockpit's PickedObject.
 */
export interface SttBoxPickInfo extends SttPickInfoBase {
  kind: 'object' | 'ego';
  category?: string;
  trackId?: string | number;
  /** Ground speed (m/s). */
  speed?: number;
  /** Box dimensions (metres, unscaled — the true object size). */
  length?: number;
  width?: number;
  height?: number;
  /** Heading (radians, CCW from +x). */
  heading?: number;
  /** World-space hit point (ENU metres) — the ray/box entry. */
  worldPoint: Vec3;
}

/**
 * A hit on a GPU-instanced point-cloud feature (id-buffer readback → provenance
 * resolve). Mapped from a core `SttPickResult` by `pointPickToInfo` in
 * `./point-pick.ts`, so the same `onPick` / `onHover` callback receives both box
 * and point hits, discriminated by `kind`.
 */
export interface SttPointPickInfo extends SttPickInfoBase {
  kind: 'point';
  /** Feature index within its `(tile, layer)` `BinaryFeatures`. */
  index: number;
  /** Decoded feature properties, or null when unresolved. */
  object: Record<string, unknown> | null;
  /** Geographic `[lng, lat]` of the picked feature. */
  coordinate?: [number, number];
  /** The picked tile, when the provenance key parses. */
  tileId?: TileId;
}

/**
 * Any hit surfaced by the pick controller: a CPU box hit ({@link SttBoxPickInfo})
 * or a GPU point-cloud hit ({@link SttPointPickInfo}), discriminated by `kind`.
 *
 * Widened from the old box-only shape — a consumer that narrows on `kind` (the
 * idiomatic pattern) keeps working unchanged; the `'point'` arm is purely
 * additive (GPU cloud picking).
 */
export type SttPickInfo = SttBoxPickInfo | SttPointPickInfo;

/** A yaw-aligned oriented box to hit-test, plus the metadata to surface on a hit. */
export interface PickBox {
  /** Box centre in world ENU metres (vertical centre, i.e. cz + height/2). */
  center: Vec3;
  /** Yaw about Z (radians). */
  heading: number;
  /** Half-extents along the box's local (length, width, height) axes — scaled. */
  halfExtents: Vec3;
  /** Metadata returned when this box is the nearest hit. */
  meta: Omit<SttBoxPickInfo, 'worldPoint'>;
}

/** A layer that contributes pickable boxes for the current frame. */
export interface SttPickable {
  /** Current-frame world-space oriented boxes to hit-test (cheap; few). */
  getPickBoxes(): PickBox[];
}

const PARALLEL_EPS = 1e-9;

/**
 * Ray vs yaw-aligned OBB. Returns the entry distance `t ≥ 0` along `dir`
 * (0 if the origin is inside), or `null` for a miss. `dir` need not be
 * normalised; `t` is in units of `dir`'s length.
 */
export function rayObbHit(
  origin: Vec3,
  dir: Vec3,
  box: PickBox,
): number | null {
  const [cx, cy, cz] = box.center;
  const cosH = Math.cos(box.heading);
  const sinH = Math.sin(box.heading);

  // Translate into the box frame, then rotate by -heading about Z so the OBB
  // becomes axis-aligned (a slab test).
  const tx = origin[0] - cx;
  const ty = origin[1] - cy;
  const lo: [number, number, number] = [
    cosH * tx + sinH * ty,
    -sinH * tx + cosH * ty,
    origin[2] - cz,
  ];
  const ld: [number, number, number] = [
    cosH * dir[0] + sinH * dir[1],
    -sinH * dir[0] + cosH * dir[1],
    dir[2],
  ];
  const he = box.halfExtents;

  let tmin = -Infinity;
  let tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = lo[a];
    const d = ld[a];
    const h = he[a];
    if (Math.abs(d) < PARALLEL_EPS) {
      if (o < -h || o > h) return null; // parallel to the slab and outside it
    } else {
      let t1 = (-h - o) / d;
      let t2 = (h - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null; // box is entirely behind the ray origin
  return tmin >= 0 ? tmin : 0;
}

/** Nearest box hit along the ray, or `null` if nothing is hit. */
export function pickBoxes(
  origin: Vec3,
  dir: Vec3,
  boxes: readonly PickBox[],
): SttBoxPickInfo | null {
  let best: PickBox | null = null;
  let bestT = Infinity;
  for (const box of boxes) {
    const t = rayObbHit(origin, dir, box);
    if (t !== null && t < bestT) {
      bestT = t;
      best = box;
    }
  }
  if (!best) return null;
  return {
    ...best.meta,
    worldPoint: [
      origin[0] + dir[0] * bestT,
      origin[1] + dir[1] * bestT,
      origin[2] + dir[2] * bestT,
    ],
  };
}
