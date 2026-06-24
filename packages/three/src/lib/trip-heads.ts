// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) CPU index + interpolation for trip HEAD dots — the Three
 * port of deck's `AnimatedTripHeadsLayer`. Each LineString feature is a trip; the
 * head is the position the vehicle occupies at the playhead, found by a
 * binary-search + lerp along the trip's per-vertex times (mirroring the
 * box-tracks `sampleTrack` precedent, but along a polyline instead of across
 * keyframes).
 *
 * Tiles store geometry as lon/lat(+z). This builder PROJECTS every vertex once
 * (RTC: relative to a shared `origin` so the small f32 offsets stay precise on
 * the GPU) and rebases each feature's `[startTime,endTime]` + per-vertex times to
 * the scene's common `timeOrigin`. Per-frame `sampleHead` then only does the
 * search + a 3-float lerp — no projection, no allocation.
 *
 * Per-vertex times come from the tile's own `vertexTimestamps` column when
 * present (zero re-derivation); otherwise they are synthesized
 * distance-proportionally over the feature's `[start,end]`, mirroring deck's
 * `synthesizeVertexTimes` (but measured in projected world metres, which is the
 * frame the head positions are interpolated in).
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu';

/** One trip: a polyline of projected world vertices + monotonic vertex times. */
export interface Trip {
  /** Vertex world positions RELATIVE to the index `origin` (x,y,z interleaved). */
  positions: Float32Array;
  /** Per-vertex time (relative to `timeOrigin`), monotonic non-decreasing. */
  vertexTimes: Float32Array;
  /** Vertex count (`positions.length / 3`). */
  numVerts: number;
  /** Feature active window (relative to `timeOrigin`). */
  start: number;
  end: number;
}

/** A built trip index ready for per-frame head sampling. */
export interface TripIndex {
  trips: Trip[];
  /** f64 world origin all `Trip.positions` are relative to (RTC). */
  origin: [number, number, number];
}

/** One interpolated head position (relative to the index `origin`). */
export interface Head {
  x: number;
  y: number;
  z: number;
}

/**
 * Build the trip index from every LineString feature across the loaded tiles.
 * Non-line layers (points/polys) are skipped. Positions are projected RTC about
 * the first feature's first vertex (kept small for f32); for the AV/ENU frame the
 * origin is ~0 so the offsets equal absolute metres (byte-identical to a no-RTC
 * build).
 */
export function buildTripIndex(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
): TripIndex {
  // First pass: pick the RTC origin from the first usable vertex.
  let origin: [number, number, number] = [0, 0, 0];
  let foundOrigin = false;
  for (const tile of tiles) {
    if (foundOrigin) break;
    for (const tl of tile.layers) {
      const b = tl.features;
      if (b.geometryType !== GeometryType.LineString) continue;
      if (!b.featureCount || !b.startIndices) continue;
      const dims = b.positionDimensions ?? 2;
      const lon = b.positions[0];
      const lat = b.positions[1];
      const alt = dims > 2 ? b.positions[2] : 0;
      origin = projection.project(lon, lat, alt);
      foundOrigin = true;
      break;
    }
  }

  const trips: Trip[] = [];
  const [ox, oy, oz] = origin;

  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (b.geometryType !== GeometryType.LineString) continue;
      if (!b.featureCount || !b.startIndices) continue;
      buildTileTrips(b, projection, timeOrigin, ox, oy, oz, trips);
    }
  }

  return { trips, origin };
}

function buildTileTrips(
  b: BinaryFeatures,
  projection: Projection,
  timeOrigin: number,
  ox: number,
  oy: number,
  oz: number,
  out: Trip[],
): void {
  const startIndices = b.startIndices!;
  const dims = b.positionDimensions ?? 2;
  const positions = b.positions;
  const rebase = b.timeOffset - timeOrigin;
  const totalVerts = startIndices[b.featureCount];
  const haveTimes =
    !!b.vertexTimestamps && b.vertexTimestamps.length >= totalVerts;

  for (let i = 0; i < b.featureCount; i++) {
    const v0 = startIndices[i];
    const v1 = startIndices[i + 1];
    const nv = v1 - v0;
    if (nv <= 0) continue;

    const start = b.startTimes[i] + rebase;
    const end = b.endTimes[i] + rebase;

    const pos = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const base = (v0 + v) * dims;
      const lon = positions[base];
      const lat = positions[base + 1];
      const alt = dims > 2 ? positions[base + 2] : 0;
      const [x, y, z] = projection.project(lon, lat, alt);
      pos[v * 3] = x - ox;
      pos[v * 3 + 1] = y - oy;
      pos[v * 3 + 2] = z - oz;
    }

    const vertexTimes = new Float32Array(nv);
    if (haveTimes) {
      const src = b.vertexTimestamps!;
      for (let v = 0; v < nv; v++) vertexTimes[v] = src[v0 + v] + rebase;
    } else {
      synthesizeTimes(pos, nv, start, end, vertexTimes);
    }

    out.push({ positions: pos, vertexTimes, numVerts: nv, start, end });
  }
}

/**
 * Distance-proportional per-vertex times over `[start,end]` (relative-frame),
 * measured in projected world metres — the port of deck's `synthesizeVertexTimes`
 * for tiles without a `vertexTimestamps` column. A single long edge no longer
 * gets the same time delta as a short one (that produced the trips "flash").
 */
function synthesizeTimes(
  pos: Float32Array,
  nv: number,
  start: number,
  end: number,
  out: Float32Array,
): void {
  const duration = end - start;
  if (nv === 1) {
    out[0] = start;
    return;
  }
  if (duration <= 0) {
    for (let v = 0; v < nv; v++) out[v] = start;
    return;
  }
  let total = 0;
  out[0] = 0; // reuse as cumulative-distance scratch
  for (let v = 1; v < nv; v++) {
    const ax = pos[(v - 1) * 3];
    const ay = pos[(v - 1) * 3 + 1];
    const az = pos[(v - 1) * 3 + 2];
    const bx = pos[v * 3];
    const by = pos[v * 3 + 1];
    const bz = pos[v * 3 + 2];
    total += Math.hypot(bx - ax, by - ay, bz - az);
    out[v] = total;
  }
  if (total <= 0) {
    for (let v = 0; v < nv; v++) out[v] = start;
    return;
  }
  for (let v = 0; v < nv; v++) out[v] = start + (out[v] / total) * duration;
}

/**
 * Interpolate the head position of one trip at relative time `t` (relative to
 * `timeOrigin`), or `null` when the trip is inactive (before its start / after
 * its end). Binary-search the segment whose vertex-time interval brackets `t`,
 * then lerp. Mirrors box-tracks `sampleTrack` and the deck head interpolation.
 */
export function sampleHead(trip: Trip, t: number): Head | null {
  if (t < trip.start || t > trip.end) return null;
  const { positions, vertexTimes, numVerts } = trip;

  if (numVerts === 1) {
    return { x: positions[0], y: positions[1], z: positions[2] };
  }

  // Binary-search: largest lo with vertexTimes[lo] <= t.
  let lo = 0;
  let hi = numVerts - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (vertexTimes[mid] <= t) lo = mid;
    else hi = mid;
  }
  const ta = vertexTimes[lo];
  const tb = vertexTimes[hi];
  const denom = tb - ta;
  const frac = denom > 0 ? Math.min(1, Math.max(0, (t - ta) / denom)) : 0;
  const g = 1 - frac;
  const a = lo * 3;
  const c = hi * 3;
  return {
    x: positions[a] * g + positions[c] * frac,
    y: positions[a + 1] * g + positions[c + 1] * frac,
    z: positions[a + 2] * g + positions[c + 2] * frac,
  };
}

/**
 * Interpolate every active head at relative time `t`, writing world-relative
 * vec3 centres into `out` (grown by the caller). Returns the active head count.
 */
export function sampleHeads(index: TripIndex, t: number, out: Float32Array): number {
  let n = 0;
  for (const trip of index.trips) {
    const h = sampleHead(trip, t);
    if (!h) continue;
    out[n * 3] = h.x;
    out[n * 3 + 1] = h.y;
    out[n * 3 + 2] = h.z;
    n++;
  }
  return n;
}
