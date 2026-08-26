// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) **KDEEB edge bundling** for the `flowmap` kind — the
 * `liveBundling` capability for a backend that has no compute path of its own.
 *
 * Kernel-density edge bundling (Hurter, Ersoy & Telea 2012, CUBu pipeline) pulls
 * geometrically-close OD flows into smooth rivers by advecting each edge's
 * control points up the gradient of an edge-DENSITY field. A hundred straight
 * arrows radiating out of a city centre are an unreadable hairball; the same
 * hundred bundled are three or four legible corridors that fan out at the ends.
 *
 * ## This module does NOT re-implement KDEEB
 * The kernel math AND the whole splat → advect → resample → smooth → anneal
 * schedule live in `@poopdeck.gl/core/edge-bundling` and are shared by every
 * backend. What is here is only the two mappings a renderer has to supply:
 *
 * ```text
 *   flows (lon/lat endpoints)
 *     → resampleInto()  P control points per edge, cosLat-corrected
 *     → normalize into the shared BUNDLING_WORK_SIZE box
 *     → bundleEdges()   ← @poopdeck.gl/core/edge-bundling, the ONLY iteration
 *     → un-normalize back to lon/lat
 *     → buildBundledArrowRibbon()  extrude a tapered ribbon along each river
 * ```
 *
 * The work-box normalization is deck's `lib/edge-bundler.ts` `toWorkBox`
 * (isotropic scale off the LARGER axis, min-anchored, `x` pre-multiplied by
 * `cos(meanLat)`), so a bundle relaxed here and a bundle relaxed on deck's GPU
 * are the same curve rather than two lookalikes — with ONE deliberate
 * correction, {@link workBoxMargin}, forced by a real difference between the two
 * kernels. See that function: without it the outermost edges of every dataset
 * never move at all.
 *
 * ## Why the CPU, and what that costs
 * This package has no shader of its own — it is CPU-animated throughout, and
 * that is its documented posture (`src/shaders.ts` was deleted; every layer's
 * per-frame work is JS). There is nowhere to run a density splat but the main
 * thread. That is legitimate *because a bundle is STATIC GEOMETRY*: the relaxed
 * control points depend only on the flow endpoints, never on the playhead, so
 * the bundle is computed ONCE per tile-set change and the per-bucket re-bake
 * only re-extrudes ribbons along paths that are already settled.
 *
 * It is still `O(iterations × edges × pointsPerEdge)` on the main thread, and the
 * cost is real. Measured (node 22 / M-series, `bundleEdges` defaults as set
 * below — `subdivisionPoints` 24, `densityResolution` 128, 15 iterations,
 * `kernelRadius` 0.03), the relaxation is LINEAR in the edge count at
 * **≈0.28 ms per edge**:
 *
 * ```text
 *      50 edges →   14 ms        1000 edges →  276 ms   ← the default cap
 *     100 edges →   28 ms        2000 edges →  544 ms
 *     250 edges →   67 ms        1000 edges @ P=48 → 546 ms  (linear in P too)
 *     500 edges →  140 ms
 * ```
 *
 * Raising `densityResolution` to core's own 256 default costs 2.4× that (276 →
 * 666 ms at 1000 edges, measured): the splat stamps a `(2⌈h/cell⌉+1)²` stencil
 * per point, so halving the cell size quadruples the stencil, and only the
 * anneal claws some of it back. 128 is the measured knee, and is why this module
 * overrides core's default rather than inheriting it.
 *
 * ## The cap, and what happens past it
 * {@link DEFAULT_MAX_BUNDLED_EDGES} = 1000 edges ≈ a 280 ms hitch on a tile-set
 * change. Past the cap {@link bundleFlows} returns `null` and the caller draws
 * ORDINARY STRAIGHT ARROWS — every one of them, not a bundled subset.
 * All-or-nothing is not laziness, it is the only honest option: an edge that is
 * not in the bundle contributes nothing to the density field, so bundling the
 * top-N by volume would relax those N into rivers carved by a field that omits
 * most of the data — confident curves in demonstrably the wrong place. deck's
 * `BundledFlowmapLayer` degrades the same way when a tile exceeds
 * `maxBundledEdges`. The lever past the cap is to reduce the visible edge count
 * (zoom in, or build a coarser summary tier), not to raise the cap and eat a
 * multi-second freeze.
 *
 * A single edge is also refused (`edgeCount < 2`): one edge has nothing to
 * bundle toward, `bundleEdges` is an identity on it, and the whole relaxation
 * would be paid for no visible change.
 *
 * ## Deliberate deviations (documented, not silent)
 * - **Edges are the OD CHORD, not the routed polyline.** deck's
 *   `controlPointsFor` resamples the feature's real LineString vertices; a
 *   {@link FlowEndpoints} carries only origin and destination, because that is
 *   already what the kind draws — `buildArrowRibbon` extrudes a straight chord
 *   and ignores interior vertices. Bundling the route while the straight
 *   fallback ignores it would make the two paths disagree about what the flow
 *   IS, so toggling `bundling` would move geometry for reasons that have nothing
 *   to do with bundling. For the 2-vertex OD-pair archives this kind is built
 *   for (bixi and friends) the two are identical anyway.
 * - **`subdivisionPoints` defaults to 24, half deck's GPU default of 48.** Cost
 *   is linear in P (measured above), and on a GPU 48 is free while here it is
 *   another 270 ms. Set it to 48 for byte-parity with deck's curve when the edge
 *   count is small.
 * - **`kernelRadius` defaults to 0.03, not deck's 0.05.** The splat cost grows
 *   with the square of the bandwidth, and on the CPU that is the difference
 *   between 268 ms and 503 ms at 1000 edges — measured. 0.03 still bundles a
 *   realistic converging OD fan essentially completely (an 11-edge fan's
 *   midpoint spread collapses by 99%); what it costs is the FRINGE, where sparse
 *   edges with no near neighbour stay straighter than deck would draw them. A
 *   caller who wants deck's exact tightness sets `kernelRadius: 0.05` and should
 *   halve `maxBundledEdges` with it.
 * - **The ribbon offsets on the LOCAL tangent, not the global chord direction.**
 *   {@link buildArrowRibbon} can use the chord because its path is the chord; a
 *   river bends, and a constant-direction offset would make it self-intersect
 *   through the turns. The twin-ribbon trick survives unchanged: A→B and B→A
 *   relax onto the same river in reversed point order, so their tangents — and
 *   therefore their left-normals, and therefore their gaps — still oppose.
 *
 * Zero Cesium imports: unit-testable in plain Node.
 */

import { GlobeProjection } from '@poopdeck.gl/core/geo';
import {
  BUNDLING_EPS,
  BUNDLING_WORK_SIZE,
  bundleEdges,
  resampleInto,
} from '@poopdeck.gl/core/edge-bundling';
import {
  DEFAULT_HEAD_LENGTH_RATIO,
  DEFAULT_HEAD_WIDTH_RATIO,
  DEFAULT_MAX_HEAD_FRACTION,
  DEFAULT_SHAFT_SEGMENTS,
  DEFAULT_TAIL_WIDTH_RATIO,
  type ArrowRibbon,
  type FlowmapBuildOptions,
} from './flowmap.js';
import { M_PER_DEG_LAT, enuPerpendicularShift } from './flow-strokes.js';

// One WGS84 globe for every build. Byte-identical to the polyline/flowmap
// builders' GLOBE — `project` is anchor-independent, so the duplication is
// intentional (each pure module stays self-contained). The class default is
// 'sphere', which mis-registers against Cesium's real ellipsoid by up to ~20 km
// at mid-latitudes, so the datum is always spelled out.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

/** Control points per bundled edge. Half deck's GPU default — see the header. */
export const DEFAULT_SUBDIVISION_POINTS = 24;
/** Edges past which bundling is refused outright (≈280 ms of CPU at this count). */
export const DEFAULT_MAX_BUNDLED_EDGES = 1000;
/** KDEEB advection/anneal rounds (CUBu's value, and core's default). */
export const DEFAULT_BUNDLING_ITERATIONS = 15;
/** Initial kernel bandwidth as a fraction of the work box (also the advection step). */
export const DEFAULT_KERNEL_RADIUS = 0.03;
/** 1D Laplacian smoothing strength per round. */
export const DEFAULT_SMOOTHING_STRENGTH = 0.5;
/**
 * Density-grid resolution per axis. Deliberately below core's 256 default: the
 * splat stamps a `(2⌈h/cell⌉+1)²` stencil per control point, so the cost is
 * quadratic in the resolution at fixed bandwidth, and 128 measured as the knee
 * (276 ms vs 666 ms at E=1000, for no visible difference in the rivers).
 */
export const DEFAULT_DENSITY_RESOLUTION = 128;

/**
 * Inset, in work-box units, that keeps every control point clear of the band at
 * the edge of the density grid where core's advection refuses to run.
 *
 * ⚠ This is a CORRECTION, not a tuning knob. `bundleEdges` samples its gradient
 * bilinearly and SKIPS any point whose grid coordinate falls outside
 * `[1, res - 2]` — a 1.5-cell band around the border, where a centred stencil
 * would read off the grid. deck's GLSL advect instead CLAMPS its four density
 * reads, so its boundary points still move. With deck's min-anchored mapping the
 * data touches the box edge on all four sides by construction, so on the CPU
 * kernel the extreme edges of every dataset land squarely in that dead band.
 * Measured on an 11-edge parallel fan: the outermost edge moved EXACTLY zero
 * with no margin, and 18.8 work units with it — the difference between "the
 * fringe of the bundle is straight" and a bundle.
 *
 * Two cells (a half-cell of slack past the 1.5 the guard needs) on each side,
 * which costs ~3% of the box at the default resolution. The consequence is that
 * {@link FlowBundlingOptions.kernelRadius}, a fraction of the whole box, is that
 * same ~3% larger relative to the DATA than deck's is — far below the precision
 * anyone tunes a bandwidth to.
 */
export function workBoxMargin(densityResolution: number): number {
  const res = Math.max(16, Math.floor(densityResolution));
  return (2 * BUNDLING_WORK_SIZE) / res;
}

/** Knobs on {@link bundleFlows}. Names mirror deck's `BundledFlowmapLayer` props. */
export interface FlowBundlingOptions {
  /** Control points per bundled edge (≥ 3; endpoints pinned). @default 24 */
  subdivisionPoints?: number;
  /**
   * Hard ceiling on the edge count. Past it {@link bundleFlows} returns `null`
   * and the caller draws straight arrows — see the header on why it is
   * all-or-nothing. @default 1000
   */
  maxBundledEdges?: number;
  /** KDEEB rounds. @default 15 */
  bundlingIterations?: number;
  /** Initial kernel bandwidth as a fraction of the work box. @default 0.03 */
  kernelRadius?: number;
  /** Laplacian smoothing strength per round, 0..1. @default 0.5 */
  smoothingStrength?: number;
  /** Density-grid resolution per axis. @default 128 */
  densityResolution?: number;
}

/**
 * The minimum an edge needs to be bundled: its two ends. `FlowmapFlow`
 * satisfies this structurally, so a caller passes `build.flows` straight in.
 */
export interface FlowEndpoints {
  srcLon: number;
  srcLat: number;
  tgtLon: number;
  tgtLat: number;
  /** Optional altitudes; {@link buildBundledArrowRibbon} lerps between them. */
  srcAlt?: number;
  tgtAlt?: number;
}

/** A relaxed bundle: one lon/lat river per input flow, in input order. */
export interface FlowBundle {
  /**
   * Bundled control points in LON/LAT, edge-major then point-major: edge `e`'s
   * point `i` is at `(e * pointsPerEdge + i) * 2`. Edge `e` IS input flow `e` —
   * bundling never reorders or drops edges, so the caller indexes with the same
   * loop counter it uses for the flows.
   */
  points: Float64Array;
  edgeCount: number;
  pointsPerEdge: number;
  /** `cos(mean latitude)` the longitude axis was corrected by (already undone in `points`). */
  cosLat0: number;
  /**
   * Work-box mapping, kept for diagnostics:
   * `corrected = (work - margin) / scale + origin`.
   */
  originX: number;
  originY: number;
  scale: number;
  /** The {@link workBoxMargin} this bundle was inset by. */
  margin: number;
  /** Wall-clock ms the relaxation took. Diagnostics only — never an input. */
  elapsedMs: number;
}

/**
 * Relax `flows` into bundled rivers, or return `null` when bundling is refused.
 *
 * `null` means "draw straight arrows", and there are exactly four ways to get
 * it: fewer than 2 edges (nothing to bundle toward), more edges than
 * {@link FlowBundlingOptions.maxBundledEdges}, a `subdivisionPoints` under 3
 * (no interior to advect), or a degenerate extent (every endpoint at one point).
 * Nothing here throws and nothing partially bundles.
 *
 * Deterministic: same flows and options in, byte-identical `points` out
 * (`elapsedMs` excepted — it is a measurement, not a result).
 */
export function bundleFlows(
  flows: readonly FlowEndpoints[],
  opts: FlowBundlingOptions = {},
): FlowBundle | null {
  const edgeCount = flows.length;
  const pointsPerEdge = Math.floor(
    opts.subdivisionPoints ?? DEFAULT_SUBDIVISION_POINTS,
  );
  const cap = Math.floor(opts.maxBundledEdges ?? DEFAULT_MAX_BUNDLED_EDGES);
  if (edgeCount < 2 || edgeCount > cap || pointsPerEdge < 3) return null;

  // The longitude axis is squeezed by cos(lat) so the work box is isotropic in
  // METRES: without it a mid-latitude dataset bundles as if east-west distances
  // were 1/cos(lat) longer than they are, and the rivers lean. Floored at 0.1
  // (≈84°) so a polar dataset cannot divide the mapping back out to infinity.
  let latSum = 0;
  for (const f of flows) latSum += f.srcLat + f.tgtLat;
  const cosLat0 = Math.max(
    0.1,
    Math.cos((latSum / (2 * edgeCount) / 180) * Math.PI),
  );

  // Pass 1 — resample every edge into `pointsPerEdge` control points in
  // cosLat-corrected degree space, tracking the extent as we go. The resample
  // goes through core's `resampleInto`, the same primitive deck's
  // `controlPointsFor` uses, so both backends parametrize an edge identically.
  // For a 2-vertex OD chord that is a uniform lerp; it is written as a resample
  // anyway so the parametrization is the shared one, not a lookalike.
  const total = edgeCount * pointsPerEdge;
  const points = new Float64Array(total * 2);
  const ends = new Float64Array(4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let e = 0; e < edgeCount; e++) {
    const f = flows[e];
    ends[0] = f.srcLon * cosLat0;
    ends[1] = f.srcLat;
    ends[2] = f.tgtLon * cosLat0;
    ends[3] = f.tgtLat;
    resampleInto(ends, 2, 0, 2, pointsPerEdge, points, e * pointsPerEdge);
    for (let i = 0; i < pointsPerEdge; i++) {
      const x = points[(e * pointsPerEdge + i) * 2];
      const y = points[(e * pointsPerEdge + i) * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // ONE isotropic scale off the LARGER axis (deck's `toWorkBox`): a per-axis
  // scale would stretch the density kernel into an ellipse and bundle the narrow
  // axis far harder than the wide one. The consequence is that the narrow axis
  // does not fill the box, and that is correct. The box is the MARGINED
  // interior, not the whole thing — see `workBoxMargin`.
  const extent = Math.max(maxX - minX, maxY - minY);
  if (!(extent > BUNDLING_EPS)) return null; // every endpoint at one point
  const densityResolution =
    opts.densityResolution ?? DEFAULT_DENSITY_RESOLUTION;
  const margin = workBoxMargin(densityResolution);
  const scale = (BUNDLING_WORK_SIZE - 2 * margin) / extent;
  for (let p = 0; p < total; p++) {
    points[p * 2] = margin + (points[p * 2] - minX) * scale;
    points[p * 2 + 1] = margin + (points[p * 2 + 1] - minY) * scale;
  }

  // Pass 2 — the relaxation itself, entirely inside the shared core kernel.
  const t0 = performance.now();
  const bundled = bundleEdges(points, edgeCount, pointsPerEdge, {
    iterations: opts.bundlingIterations ?? DEFAULT_BUNDLING_ITERATIONS,
    kernelRadius:
      BUNDLING_WORK_SIZE * (opts.kernelRadius ?? DEFAULT_KERNEL_RADIUS),
    smoothing: opts.smoothingStrength ?? DEFAULT_SMOOTHING_STRENGTH,
    densityResolution,
  });
  const elapsedMs = performance.now() - t0;

  // Pass 3 — invert the mapping, in place, back to lon/lat.
  const invScale = 1 / scale;
  const invCos = 1 / cosLat0;
  for (let p = 0; p < total; p++) {
    bundled[p * 2] = ((bundled[p * 2] - margin) * invScale + minX) * invCos;
    bundled[p * 2 + 1] = (bundled[p * 2 + 1] - margin) * invScale + minY;
  }

  return {
    points: bundled,
    edgeCount,
    pointsPerEdge,
    cosLat0,
    originX: minX,
    originY: minY,
    scale,
    margin,
    elapsedMs,
  };
}

/**
 * Copy edge `edgeIndex`'s bundled river out as a standalone lon/lat polyline
 * (`pointsPerEdge` × `[lon, lat]`). Convenience for callers and tests that want
 * one river rather than the packed buffer; the ribbon builder reads the packed
 * buffer directly and never allocates this.
 */
export function bundledPath(
  bundle: FlowBundle,
  edgeIndex: number,
): Float64Array | null {
  if (edgeIndex < 0 || edgeIndex >= bundle.edgeCount) return null;
  const base = edgeIndex * bundle.pointsPerEdge * 2;
  return bundle.points.slice(base, base + bundle.pointsPerEdge * 2);
}

/**
 * Metre length of a lon/lat step, in the local ENU frame at `lat`. The mean
 * metres-per-degree is ample here for the same reason it is in
 * `lib/flow-strokes.ts`: this measures the SPACING of control points along one
 * river, which only ever selects where the arrowhead starts.
 */
function stepMeters(dLon: number, dLat: number, lat: number): number {
  const cosLat = Math.cos((lat / 180) * Math.PI);
  return Math.hypot(dLon * cosLat * M_PER_DEG_LAT, dLat * M_PER_DEG_LAT);
}

/**
 * Extrude a tapered arrow ribbon ALONG a bundled river — the bundled twin of
 * `buildArrowRibbon`, with a deliberately IDENTICAL output contract: the same
 * `(shaftSegments + 1) × 2 + 3` vertex layout, the same `shaftSegments × 6 + 3`
 * index list, the same tail→head taper, the same head triangle with its apex on
 * the destination, the same signed `gapMeters` twin offset. That is what lets
 * the layer swap one for the other on a single option with no other change, and
 * it is what makes "a lone edge's bundled ribbon equals its straight ribbon" a
 * meaningful test rather than a coincidence.
 *
 * The one structural difference is the stations: they are placed by ARC LENGTH
 * along the river rather than by chord fraction, and each one takes its lateral
 * push from the LOCAL tangent (see the header). On a river that came back
 * straight — an edge whose neighbourhood was empty, or any bundle asked for zero
 * iterations — the local tangent IS the chord, and along a constant parallel the
 * two parametrizations coincide exactly, so the builders agree to
 * floating-point noise. A straight river that also climbs in latitude parts
 * company by the variation of `cos(lat)` along it: sub-millimetre over a
 * city-scale OD pair, and it moves only where the head starts, never an endpoint.
 *
 * `flow` supplies ALTITUDES only — the lon/lat comes from the bundle, so an
 * `edgeIndex` and a `flow` that disagree misplace the height and nothing else.
 *
 * Returns `null` for a non-positive width or a zero-length river (a self-loop
 * has no tangent to be perpendicular to), exactly as the straight builder does.
 */
export function buildBundledArrowRibbon(
  bundle: FlowBundle,
  edgeIndex: number,
  flow: FlowEndpoints,
  widthMeters: number,
  opts: FlowmapBuildOptions = {},
  gapMeters = 0,
): ArrowRibbon | null {
  if (!(widthMeters > 0)) return null;
  if (edgeIndex < 0 || edgeIndex >= bundle.edgeCount) return null;

  const P = bundle.pointsPerEdge;
  const src = bundle.points;
  const base = edgeIndex * P * 2;

  // Cumulative arc length in metres along the river.
  const cum = new Float64Array(P);
  for (let i = 1; i < P; i++) {
    const o = base + i * 2;
    cum[i] =
      cum[i - 1] +
      stepMeters(
        src[o] - src[o - 2],
        src[o + 1] - src[o - 1],
        (src[o + 1] + src[o - 1]) / 2,
      );
  }
  const length = cum[P - 1];
  if (!(length > 0)) return null;

  const segs = Math.max(
    1,
    Math.floor(opts.shaftSegments ?? DEFAULT_SHAFT_SEGMENTS),
  );
  const tailRatio = opts.tailWidthRatio ?? DEFAULT_TAIL_WIDTH_RATIO;
  const headWidth =
    widthMeters * (opts.headWidthRatio ?? DEFAULT_HEAD_WIDTH_RATIO);
  const headLen = Math.min(
    headWidth * (opts.headLengthRatio ?? DEFAULT_HEAD_LENGTH_RATIO),
    length * (opts.maxHeadFraction ?? DEFAULT_MAX_HEAD_FRACTION),
  );
  const zLift = opts.zLift ?? 0;
  const srcAlt = flow.srcAlt ?? 0;
  const tgtAlt = flow.tgtAlt ?? 0;
  // Where the shaft stops and the head begins, as an ARC LENGTH along the river.
  const sHead = length - headLen;

  const shaftVerts = 2 * (segs + 1);
  const positions = new Float64Array((shaftVerts + 3) * 3);
  const shift: [number, number] = [0, 0];

  // Monotone cursor over the river's segments: every station this function asks
  // for has a target arc length >= the previous one, so the walk is O(P + segs)
  // rather than a binary search per station.
  let seg = 1;
  const station = (
    vertexIndex: number,
    target: number,
    lateral: number,
  ): void => {
    while (seg < P - 1 && cum[seg] < target) seg++;
    const a = base + (seg - 1) * 2;
    const b = base + seg * 2;
    const segLen = cum[seg] - cum[seg - 1];
    const f = segLen < BUNDLING_EPS ? 0 : (target - cum[seg - 1]) / segLen;
    const lon = src[a] + f * (src[b] - src[a]);
    const lat = src[a + 1] + f * (src[b + 1] - src[a + 1]);
    // Altitude follows the ARC-LENGTH fraction, which on a straight river is the
    // chord fraction the unbundled builder uses.
    const u = target / length;
    const alt = srcAlt + (tgtAlt - srcAlt) * u + zLift;
    // The lateral push is taken in the LOCAL east-north-up frame at THIS vertex,
    // off the LOCAL tangent. A degree-space perpendicular would skew every
    // non-equatorial arrow by the aspect ratio of the graticule, and a global
    // chord direction would cut the corners of a bent river.
    enuPerpendicularShift(
      lon,
      lat,
      src[b] - src[a],
      src[b + 1] - src[a + 1],
      lateral,
      shift,
    );
    const [x, y, z] = GLOBE.project(shift[0], shift[1], alt);
    positions[vertexIndex * 3] = x;
    positions[vertexIndex * 3 + 1] = y;
    positions[vertexIndex * 3 + 2] = z;
  };

  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const target = sHead * s;
    const half = (widthMeters * (tailRatio + (1 - tailRatio) * s)) / 2;
    station(i * 2, target, gapMeters + half);
    station(i * 2 + 1, target, gapMeters - half);
  }
  station(shaftVerts, sHead, gapMeters + headWidth / 2);
  station(shaftVerts + 1, sHead, gapMeters - headWidth / 2);
  station(shaftVerts + 2, length, gapMeters);

  const indices = new Uint16Array(segs * 6 + 3);
  let k = 0;
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices[k++] = a;
    indices[k++] = a + 1;
    indices[k++] = a + 2;
    indices[k++] = a + 2;
    indices[k++] = a + 1;
    indices[k++] = a + 3;
  }
  indices[k++] = shaftVerts;
  indices[k++] = shaftVerts + 1;
  indices[k++] = shaftVerts + 2;

  return { positions, indices, widthMeters };
}
