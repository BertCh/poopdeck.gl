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

export type Vec3 = readonly [number, number, number];

/** Result of a successful pick — structurally a superset of the cockpit's PickedObject. */
export interface SttPickInfo {
  /** Id of the layer that owns the hit box. */
  layerId: string;
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
  /** World-space hit point (ENU metres). */
  worldPoint: Vec3;
}

/** A yaw-aligned oriented box to hit-test, plus the metadata to surface on a hit. */
export interface PickBox {
  /** Box centre in world ENU metres (vertical centre, i.e. cz + height/2). */
  center: Vec3;
  /** Yaw about Z (radians). */
  heading: number;
  /** Half-extents along the box's local (length, width, height) axes — scaled. */
  halfExtents: Vec3;
  /** Metadata returned when this box is the nearest hit. */
  meta: Omit<SttPickInfo, 'worldPoint'>;
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
export function rayObbHit(origin: Vec3, dir: Vec3, box: PickBox): number | null {
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
export function pickBoxes(origin: Vec3, dir: Vec3, boxes: readonly PickBox[]): SttPickInfo | null {
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
