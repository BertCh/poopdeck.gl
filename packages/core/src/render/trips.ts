// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT trips kernel — framework-free CPU trip indexing + head interpolation the
 * renderers share, lifted verbatim from `@poopdeck.gl/three`'s pure
 * `lib/trip-heads.ts` + `synthesizeVertexTimes` when the Cesium backend became
 * their third consumer (deck carries the original copies; three now re-export
 * shims onto this module). See docs/roadmap/renderer-abstraction-2026-06.md —
 * CPU logic lives in exactly one place, backends keep their render models.
 *
 * Each LineString feature is a trip; the head is the position the vehicle
 * occupies at the playhead, found by a binary-search + lerp along the trip's
 * per-vertex times. Per-vertex times come from the tile's own
 * `vertexTimestamps` column when present; otherwise they are synthesized
 * distance-proportionally over the feature's `[start,end]`.
 *
 * `buildTripIndex` PROJECTS every vertex once (RTC: relative to a shared
 * `origin` so small f32 offsets stay precise on a GPU) and rebases each
 * feature's `[startTime,endTime]` + per-vertex times to the scene's common
 * `timeOrigin`. Per-frame `sampleHead` then only does the search + a 3-float
 * lerp — no projection, no allocation.
 *
 * Precision: GPU-buffer consumers (three) keep the default `'f32'`
 * (byte-identical to the pre-lift build); CPU-double consumers (Cesium
 * Cartesian3) pass `precision: 'f64'` so a globe-spanning RTC offset does not
 * quantize to metres.
 */

import type { BinaryFeatures, Tile } from '../types.js';
import { GeometryType } from '../types.js';
import type { Projection } from '../geo/index.js';

const EARTH_RADIUS_M = 6_371_000;

/** Haversine distance in metres. Inputs in degrees. */
function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a = sinDLat * sinDLat + Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Per-vertex time fallback when the tile lacks `vertexTimestamps`. Distributes
 * each feature's `[startTime,endTime]` across its vertices by cumulative
 * haversine distance. Verbatim port of deck `synthesizeVertexTimes` — output is
 * tile-relative (same frame as `startTimes`/`endTimes`).
 */
export function synthesizeVertexTimes(binary: BinaryFeatures): Float32Array {
  const startIndices = binary.startIndices!;
  const totalVerts = startIndices[binary.featureCount];
  const out = new Float32Array(totalVerts);
  const dims = binary.positionDimensions ?? 2;
  const positions = binary.positions;

  // Reused per-feature distance buffer (grow-only) — one allocation per tile.
  let cum = new Float64Array(0);

  for (let i = 0; i < binary.featureCount; i++) {
    const v0 = startIndices[i];
    const v1 = startIndices[i + 1];
    const numVerts = v1 - v0;
    const featureStart = binary.startTimes ? binary.startTimes[i] : 0;
    const featureEnd = binary.endTimes ? binary.endTimes[i] : 0;
    const duration = featureEnd - featureStart;

    if (numVerts <= 1) {
      if (numVerts === 1) out[v0] = featureStart;
      continue;
    }
    if (duration <= 0) {
      for (let v = 0; v < numVerts; v++) out[v0 + v] = featureStart;
      continue;
    }

    if (cum.length < numVerts) cum = new Float64Array(numVerts);
    cum[0] = 0;
    let total = 0;
    for (let v = 1; v < numVerts; v++) {
      const aBase = (v0 + v - 1) * dims;
      const bBase = (v0 + v) * dims;
      total += haversineMeters(
        positions[aBase],
        positions[aBase + 1],
        positions[bBase],
        positions[bBase + 1],
      );
      cum[v] = total;
    }

    if (total <= 0) {
      for (let v = 0; v < numVerts; v++) out[v0 + v] = featureStart;
      continue;
    }
    for (let v = 0; v < numVerts; v++) {
      out[v0 + v] = featureStart + (cum[v] / total) * duration;
    }
  }
  return out;
}

/** Position/time array element width for a built index. */
export type TripPrecision = 'f32' | 'f64';

/** One trip: a polyline of projected world vertices + monotonic vertex times. */
export interface Trip {
  /** Vertex world positions RELATIVE to the index `origin` (x,y,z interleaved). */
  positions: Float32Array | Float64Array;
  /** Per-vertex time (relative to `timeOrigin`), monotonic non-decreasing. */
  vertexTimes: Float32Array | Float64Array;
  /** Vertex count (`positions.length / 3`). */
  numVerts: number;
  /** Feature active window (relative to `timeOrigin`). */
  start: number;
  end: number;
  /** Tile layer + feature this trip came from (picking provenance). */
  binary: BinaryFeatures;
  featureIndex: number;
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

export interface TripIndexOptions {
  /**
   * Element width of the per-trip position/time arrays. `'f32'` for GPU-buffer
   * consumers (small RTC offsets); `'f64'` for CPU-double consumers where the
   * RTC offset itself can span the globe. @default 'f32'
   */
  precision?: TripPrecision;
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
  options: TripIndexOptions = {},
): TripIndex {
  const f64 = options.precision === 'f64';

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
      buildTileTrips(b, projection, timeOrigin, ox, oy, oz, f64, trips);
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
  f64: boolean,
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

    const pos = f64 ? new Float64Array(nv * 3) : new Float32Array(nv * 3);
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

    const vertexTimes = f64 ? new Float64Array(nv) : new Float32Array(nv);
    if (haveTimes) {
      const src = b.vertexTimestamps!;
      for (let v = 0; v < nv; v++) vertexTimes[v] = src[v0 + v] + rebase;
    } else {
      synthesizeTimes(pos, nv, start, end, vertexTimes);
    }

    out.push({
      positions: pos,
      vertexTimes,
      numVerts: nv,
      start,
      end,
      binary: b,
      featureIndex: i,
    });
  }
}

/**
 * Distance-proportional per-vertex times over `[start,end]` (relative-frame),
 * measured in projected world metres — the port of deck's `synthesizeVertexTimes`
 * for tiles without a `vertexTimestamps` column. A single long edge no longer
 * gets the same time delta as a short one (that produced the trips "flash").
 */
function synthesizeTimes(
  pos: Float32Array | Float64Array,
  nv: number,
  start: number,
  end: number,
  out: Float32Array | Float64Array,
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

/**
 * Trim one trip to the trail window `[t - trailLength, t]` (relative frame):
 * the sub-polyline currently visible behind the head, with an interpolated
 * head vertex at `t` and an interpolated tail vertex at `t - trailLength`.
 * Writes interleaved x,y,z into `out` (caller-grown; needs room for
 * `numVerts + 2` vertices) and returns the vertex count written, tail→head.
 * Returns 0 when the trip is inactive at `t`.
 *
 * This is the CPU analogue of the GPU `trail` vertex fade — for hosts whose
 * stock polyline primitive has no per-vertex shader hook (Cesium), the trail
 * is realized as geometry (trim) instead of alpha.
 */
export function trimTrail(
  trip: Trip,
  t: number,
  trailLength: number,
  out: Float64Array | Float32Array,
): number {
  if (t < trip.start || t > trip.end + trailLength) return 0;
  const { positions, vertexTimes, numVerts } = trip;
  if (numVerts === 1) {
    out[0] = positions[0];
    out[1] = positions[1];
    out[2] = positions[2];
    return 1;
  }

  const headT = Math.min(t, trip.end);
  const tailT = Math.max(t - trailLength, trip.start);
  if (headT < tailT) return 0;

  // First vertex strictly after the tail; last vertex strictly before the head.
  let n = 0;
  const pushLerp = (time: number): void => {
    // Binary-search: largest lo with vertexTimes[lo] <= time.
    let lo = 0;
    let hi = numVerts - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (vertexTimes[mid] <= time) lo = mid;
      else hi = mid;
    }
    const ta = vertexTimes[lo];
    const tb = vertexTimes[hi];
    const denom = tb - ta;
    const frac = denom > 0 ? Math.min(1, Math.max(0, (time - ta) / denom)) : 0;
    const g = 1 - frac;
    const a = lo * 3;
    const c = hi * 3;
    out[n * 3] = positions[a] * g + positions[c] * frac;
    out[n * 3 + 1] = positions[a + 1] * g + positions[c + 1] * frac;
    out[n * 3 + 2] = positions[a + 2] * g + positions[c + 2] * frac;
    n++;
  };

  pushLerp(tailT); // interpolated tail
  for (let v = 0; v < numVerts; v++) {
    const vt = vertexTimes[v];
    if (vt > tailT && vt < headT) {
      const base = v * 3;
      out[n * 3] = positions[base];
      out[n * 3 + 1] = positions[base + 1];
      out[n * 3 + 2] = positions[base + 2];
      n++;
    }
  }
  pushLerp(headT); // interpolated head
  return n;
}
