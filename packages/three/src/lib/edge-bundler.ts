// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * KDEEB **edge bundling for the three backend** — the wiring that turns one
 * tile-set's OD flows into bundled rivers, sitting on top of the shared kernel
 * in `@poopdeck.gl/core/edge-bundling`. Drives {@link STTFlowmapLayer}'s opt-in
 * `bundling` option and the `liveBundling` capability.
 *
 * Pure and THREE-FREE (typed arrays, core's binary tile types and the
 * projection interface only), so the whole path is unit-testable in plain Node
 * with no WebGPU device — the same rule every `src/lib/*-buffers.ts` follows.
 *
 * ## What it does
 *  1. {@link collectFlowEndpoints} walks the tiles exactly as
 *     `buildFlowmapBuffers` does and emits each OD flow's `[srcLon, srcLat,
 *     tgtLon, tgtLat]` **in the same merged order**, so bundled edge `e` is
 *     flowmap instance `e`. That correspondence is load-bearing (per-edge widths
 *     are looked up by index) and is pinned in `test/edge-bundler.test.ts`.
 *  2. Each flow is resampled to `pointsPerEdge` control points with core's
 *     {@link resampleInto} — a straight OD segment resamples to evenly spaced
 *     points, which is precisely the straight-arrow geometry the bundle starts
 *     from.
 *  3. {@link toWorkBox} maps the cosLat-corrected control points into the shared
 *     {@link BUNDLING_WORK_SIZE} box (KDEEB's kernel and step constants are
 *     scale-relative, so every backend bundles in the same normalized box).
 *  4. Core's {@link bundleEdges} runs the whole splat → advect → resample →
 *     smooth → anneal schedule.
 *  5. {@link fromWorkBox} maps the result back to lon/lat for the layer to
 *     project and upload.
 *
 * ## Which compute path, and why NOT a device path
 * deck runs this schedule as a luma ping-pong over float render targets, and the
 * obvious three analogue would be the same ping-pong over `RenderTarget`s (or a
 * TSL compute pass). **This backend deliberately runs the iteration on the CPU,
 * through the one shared implementation in core.** Three reasons:
 *
 *  • A bundle is STATIC GEOMETRY. It is a function of the edge SET, not of the
 *    playhead, so it is recomputed when tiles change and never per frame. The
 *    animation — arrows swelling and receding — is the per-edge WIDTH, which
 *    stays a cheap attribute refresh. A GPU iteration would buy throughput on a
 *    cost that is not per-frame.
 *  • A second copy of the schedule in TSL is a second thing that can drift from
 *    the oracle. The renderer-architecture record exists because hand-copied
 *    scalar math drifted in shipped pixels; core owns `bundleEdges` (25 tests,
 *    including that neighbouring edges genuinely attract and a lone edge does
 *    not) precisely so no backend needs its own.
 *  • Reading a WebGPU compute result back to the CPU is asynchronous
 *    (`getArrayBufferAsync`), and the bundled control points must be projected
 *    on the CPU anyway (three's `Projection` is an f64 CPU transform, not a
 *    shader). That would make `setTiles` — a synchronous method on the
 *    `STTLayer` contract — async, or leave the layer rendering garbage for a
 *    frame or two after every tile change.
 *
 * The honest cost of that choice is a main-thread stall on the rebuild, which is
 * what {@link BUNDLE_WORK_BUDGET} bounds; see below.
 *
 * ## Device gate, and an honest note about it
 * The layer must degrade to straight arrows rather than fail or draw garbage,
 * and {@link bundleFlowEdges} always returns a `{bundled: false, reason}` the
 * caller can warn once about instead of throwing. But note WHAT actually gates
 * it here: deck's `isBundlingSupported` tests for `EXT_color_buffer_float` +
 * `EXT_float_blend` because ITS iteration renders into float targets. **This
 * path renders into nothing.** The bundled rivers arrive as ordinary f32
 * instance attributes on an `InstancedBufferGeometry`, so they need nothing
 * from the device that a straight arrow does not.
 *
 * {@link isBundlingSupported} is therefore a genuinely weaker predicate than
 * deck's, and it says so rather than inventing a requirement: it reports `false`
 * only for a renderer that has no backend at all (one that failed to
 * initialize), and `true` otherwise — including when handed no renderer, which
 * is the case in Node and before the first frame. The gate that actually bites
 * is the CPU budget, and it is checked on the same call.
 *
 * ## The budget
 * `bundleEdges`' cost is dominated by the density splat: `iterations × E × P ×
 * (2⌈h/cell⌉+1)²` cell touches, measured at ≈45 M touches/second in Node 24 on
 * an M-series laptop. {@link BUNDLE_WORK_BUDGET} caps one rebuild at ~0.4 s of
 * main-thread work — a real hitch, and the reason the budget is not simply ten
 * times larger. At the default knobs that admits ≈1300 edges. Over budget, the
 * layer falls back to straight arrows with a message naming the knob to turn
 * rather than freezing the tab.
 *
 * ## What it deliberately does NOT do
 *  • **No GPU iteration** (above) — no TSL compute pass, no float ping-pong.
 *  • **No partial bundling.** Over-budget edge sets fall back WHOLESALE rather
 *    than bundling the strongest N: the "strongest" edges change with the
 *    playhead, so a flow-ranked subset would re-cut the bundle every cross-fade
 *    sub-step, and a bundle that reshuffles as the slider moves is worse than no
 *    bundle. Bundle everything or nothing.
 *  • **No worker.** Moving the iteration off the main thread is the obvious next
 *    step and is not taken here; it would make `setTiles` asynchronous, which is
 *    the same objection as the GPU path.
 *  • **No intermediate geometry.** Only the OD flow's two endpoints seed the
 *    bundle; a multi-vertex flow feature is treated as its source→target
 *    straight line, exactly as `buildFlowmapBuffers` treats it.
 *  • **No altitude.** Bundling is planar in lon/lat (KDEEB is a 2-D method);
 *    control points are projected at altitude 0. A globe projection still
 *    renders them, but the bundle itself is computed in the plane.
 *  • **No per-edge weighting.** Every flow contributes equally to the density
 *    field, so a hairline flow bends a river as much as a hub-to-hub one. CUBu's
 *    weighted splat is a real improvement and is not implemented.
 */

import type { Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import {
  BUNDLING_EPS,
  BUNDLING_WORK_SIZE,
  annealRadius,
  bundleEdges,
  resampleInto,
} from '@poopdeck.gl/core/edge-bundling';

/**
 * Structural view of the host renderer the gate inspects — deliberately just
 * `backend`, because that is the only thing about a `WebGPURenderer` this path
 * depends on (see the header's note on why there is no float-target
 * requirement). Kept structural so a test, or a host that has not constructed a
 * renderer yet, can drive the path.
 */
export interface BundleRenderer {
  /** three's `WebGPURenderer.backend` — `WebGPUBackend` or its WebGL fallback. */
  backend?: unknown;
}

/**
 * Whether this runtime can draw a bundled ribbon at all.
 *
 * ⚠ Read the header before extending this: it is intentionally a much weaker
 * predicate than deck's namesake. The three path computes the bundle on the CPU
 * and uploads plain f32 attributes, so it requires nothing beyond what every
 * other layer in this package already requires. `undefined` (no renderer in
 * hand — Node, or before the first frame) is supported; a renderer carrying no
 * backend is not, because nothing at all will draw through it.
 *
 * A future float-texture or TSL-compute variant would add its feature probe
 * HERE, and the layer would degrade without further change.
 */
export function isBundlingSupported(renderer?: BundleRenderer | null): boolean {
  if (renderer == null) return true;
  return renderer.backend != null;
}

/** Tuning for {@link bundleFlowEdges}. Defaults are {@link DEFAULT_BUNDLE_OPTIONS}. */
export interface ThreeBundleOptions {
  /**
   * Control points per edge, `P` (≥ 3 — endpoints are pinned, so `P-2` points
   * are free to move). Higher = smoother rivers, linearly more work AND one more
   * ribbon segment per point. @default 16
   */
  pointsPerEdge?: number;
  /** KDEEB advect/anneal rounds. @default 12 */
  iterations?: number;
  /**
   * Initial kernel bandwidth as a FRACTION of the work box — also the advection
   * STEP. Bigger bundles harder and costs QUADRATICALLY more (the splat
   * rasterizes a `(2h)²` neighbourhood per control point). @default 0.05
   */
  kernelRadiusFraction?: number;
  /** Bandwidth decay per round; core clamps it to `[0.5, 0.9]`. @default 0.85 */
  lambda?: number;
  /** 1D Laplacian smoothing strength per round. @default 0.5 */
  smoothing?: number;
  /** Density-grid resolution per axis. @default 128 */
  densityResolution?: number;
  /**
   * Hard ceiling on edges, independent of the work budget — a guard on the
   * `E·P·2` allocations and the `E·(P-1)` ribbon instances. @default 2000
   */
  maxEdges?: number;
}

/** Resolved {@link ThreeBundleOptions} — every field concrete. */
export type ResolvedBundleOptions = Required<ThreeBundleOptions>;

/**
 * Defaults, tuned for the CPU iteration rather than copied from deck: fewer
 * control points (16 vs 32) and a coarser density grid (128² vs 512²), because
 * here every one of those cells is a JS loop iteration rather than a fragment.
 * The bandwidth fraction and smoothing ARE deck's, so bundles look the same
 * shape, just resolved a little coarser.
 */
export const DEFAULT_BUNDLE_OPTIONS: ResolvedBundleOptions = {
  pointsPerEdge: 16,
  iterations: 12,
  kernelRadiusFraction: 0.05,
  lambda: 0.85,
  smoothing: 0.5,
  densityResolution: 128,
  maxEdges: 2000,
};

/** Clamp and default one caller's knobs into a fully concrete set. */
export function resolveBundleOptions(
  opts: ThreeBundleOptions = {},
): ResolvedBundleOptions {
  const d = DEFAULT_BUNDLE_OPTIONS;
  return {
    pointsPerEdge: Math.max(
      3,
      Math.floor(opts.pointsPerEdge ?? d.pointsPerEdge),
    ),
    iterations: Math.max(0, Math.floor(opts.iterations ?? d.iterations)),
    kernelRadiusFraction: Math.max(
      0,
      opts.kernelRadiusFraction ?? d.kernelRadiusFraction,
    ),
    lambda: opts.lambda ?? d.lambda,
    smoothing: opts.smoothing ?? d.smoothing,
    densityResolution: Math.max(
      16,
      Math.floor(opts.densityResolution ?? d.densityResolution),
    ),
    maxEdges: Math.max(0, Math.floor(opts.maxEdges ?? d.maxEdges)),
  };
}

/**
 * Density-splat cell touches one {@link bundleEdges} call will perform —
 * `Σ_rounds E · P · (2⌈h_r/cell⌉+1)²`, walking the SAME anneal schedule core
 * walks so the estimate is exact rather than asymptotic.
 *
 * Exported so the cost model is unit-testable and so a host can size its own
 * `maxEdges` against {@link BUNDLE_WORK_BUDGET} before it asks for a bundle.
 */
export function bundleWorkUnits(
  edgeCount: number,
  opts: ResolvedBundleOptions,
): number {
  if (edgeCount < 1 || opts.pointsPerEdge < 3) return 0;
  const cell = BUNDLING_WORK_SIZE / opts.densityResolution;
  let h = opts.kernelRadiusFraction * BUNDLING_WORK_SIZE;
  let cells = 0;
  for (let round = 0; round < opts.iterations; round++) {
    if (h <= BUNDLING_EPS) break;
    const r = Math.max(1, Math.ceil(h / cell));
    cells += (2 * r + 1) * (2 * r + 1);
    h = annealRadius(h, opts.lambda);
  }
  return edgeCount * opts.pointsPerEdge * cells;
}

/**
 * Ceiling on {@link bundleWorkUnits} for ONE rebuild. ≈45 M cell touches/second
 * measured in Node 24 on an M-series laptop, so this is ~0.4 s of synchronous
 * main-thread work — a hitch you can feel, taken once when the edge set changes
 * and never per frame. It is not larger because the iteration is not on a
 * worker; see the header.
 */
export const BUNDLE_WORK_BUDGET = 2e7;

/** One OD flow's endpoints, in `buildFlowmapBuffers`' merged instance order. */
export interface FlowEndpoints {
  /** Number of flows, `E`. */
  edgeCount: number;
  /** `[srcLon, srcLat, tgtLon, tgtLat]` per flow — `edgeCount · 4` values. */
  endpoints: Float64Array;
}

/**
 * Collect every OD flow's source/target lon-lat from decoded tiles.
 *
 * This deliberately re-walks the tiles rather than widening `FlowmapBuffers`:
 * the endpoint set is INVARIANT with the playhead (which is exactly why the
 * bundle can be static), while `buildFlowmapBuffers`' output is not, and the
 * bundle must not be rebuilt every time the widths are. The filter and the
 * iteration order are the same as `collectOdLayers`' — first vertex of each
 * LineString is the source, last is the target — so index `e` here IS instance
 * `e` there. `test/edge-bundler.test.ts` pins that.
 */
export function collectFlowEndpoints(tiles: Tile[]): FlowEndpoints {
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (
        !b.featureCount ||
        b.geometryType !== GeometryType.LineString ||
        !b.startIndices
      )
        continue;
      total += b.featureCount;
    }
  }
  const endpoints = new Float64Array(total * 4);
  let o = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (
        !b.featureCount ||
        b.geometryType !== GeometryType.LineString ||
        !b.startIndices
      )
        continue;
      const si = b.startIndices;
      const dims = b.positionDimensions ?? 2;
      for (let i = 0; i < b.featureCount; i++) {
        const vSrc = si[i];
        const vTgt = si[i + 1] - 1;
        const j = (o + i) * 4;
        endpoints[j] = b.positions[vSrc * dims];
        endpoints[j + 1] = b.positions[vSrc * dims + 1];
        endpoints[j + 2] = b.positions[vTgt * dims];
        endpoints[j + 3] = b.positions[vTgt * dims + 1];
      }
      o += b.featureCount;
    }
  }
  return { edgeCount: total, endpoints };
}

/**
 * The normalized simulation box plus the mapping back out of it. `corrected =
 * work / scale + origin`; `lon = corrected.x / cosLat0`, `lat = corrected.y`.
 */
export interface BundleWorkBox {
  /** Control points in `[0, BUNDLING_WORK_SIZE]`, 2 per point. */
  work: Float64Array;
  /** `cos(meanLatitude)` — makes the longitude axis isotropic before bundling. */
  cosLat0: number;
  originX: number;
  originY: number;
  scale: number;
}

/**
 * Map cosLat-corrected lon/lat control points into the shared
 * {@link BUNDLING_WORK_SIZE} box. The box is SQUARE and preserves aspect (one
 * `scale` for both axes), so a long thin corridor does not get stretched into a
 * circle before the isotropic kernel sees it.
 */
export function toWorkBox(
  lonLat: ArrayLike<number>,
  pointCount: number,
  cosLat0: number,
): BundleWorkBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let p = 0; p < pointCount; p++) {
    const cx = lonLat[p * 2] * cosLat0;
    const cy = lonLat[p * 2 + 1];
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  const extent = Math.max(maxX - minX, maxY - minY, BUNDLING_EPS);
  const scale = BUNDLING_WORK_SIZE / extent;
  const work = new Float64Array(pointCount * 2);
  for (let p = 0; p < pointCount; p++) {
    work[p * 2] = (lonLat[p * 2] * cosLat0 - minX) * scale;
    work[p * 2 + 1] = (lonLat[p * 2 + 1] - minY) * scale;
  }
  return { work, cosLat0, originX: minX, originY: minY, scale };
}

/**
 * The inverse of {@link toWorkBox}: work-box points back to lon/lat, written
 * into `out` (which may be a fresh array or `work` itself).
 */
export function fromWorkBox(
  work: ArrayLike<number>,
  pointCount: number,
  box: Pick<BundleWorkBox, 'cosLat0' | 'originX' | 'originY' | 'scale'>,
  out: Float64Array,
): void {
  const invScale = 1 / box.scale;
  const invCos = box.cosLat0 === 0 ? 0 : 1 / box.cosLat0;
  for (let p = 0; p < pointCount; p++) {
    out[p * 2] = (work[p * 2] * invScale + box.originX) * invCos;
    out[p * 2 + 1] = work[p * 2 + 1] * invScale + box.originY;
  }
}

/** Bundled rivers, ready for the layer to project and upload. */
export interface BundledFlowEdges {
  /** Number of edges, `E` — equal to the flowmap instance count. */
  edgeCount: number;
  /** Control points per edge, `P`. */
  pointsPerEdge: number;
  /** `E · P` lon/lat control points, edge-major then point-major. */
  lonLat: Float64Array;
  /** The knobs the bundle was actually computed with. */
  options: ResolvedBundleOptions;
}

/**
 * The result of asking for a bundle: either the rivers, or a human-readable
 * reason the caller should warn about ONCE and fall back to straight arrows.
 * Never throws and never returns a half-built bundle — a caller that ignores
 * `bundled` gets a type error rather than garbage geometry.
 */
export type BundleResult =
  | { bundled: true; edges: BundledFlowEdges }
  | { bundled: false; reason: string };

/**
 * Bundle a tile-set's OD flows: resample → work box → core's
 * {@link bundleEdges} → back to lon/lat.
 *
 * `endpoints` is `[srcLon, srcLat, tgtLon, tgtLat]` per flow, in the flowmap's
 * merged instance order (see {@link collectFlowEndpoints}). Edge `e`'s bundled
 * control points come back at `lonLat[(e·P + i)·2]`, with `i = 0` pinned to the
 * source and `i = P-1` pinned to the target — the bundled river still starts and
 * ends where the data says it does.
 *
 * Falls back (never throws) when: there is nothing to bundle toward (`E < 2` —
 * a lone edge has no neighbours and core would return it unchanged anyway); the
 * renderer cannot host it; the edge count exceeds `maxEdges`; or the work
 * estimate exceeds {@link BUNDLE_WORK_BUDGET}.
 */
export function bundleFlowEdges(
  endpoints: ArrayLike<number>,
  edgeCount: number,
  opts: ThreeBundleOptions = {},
  renderer?: BundleRenderer | null,
): BundleResult {
  const resolved = resolveBundleOptions(opts);
  const P = resolved.pointsPerEdge;

  if (!isBundlingSupported(renderer)) {
    return {
      bundled: false,
      reason:
        'the renderer reports no initialized backend, so nothing can be drawn through it',
    };
  }
  if (edgeCount < 2) {
    return {
      bundled: false,
      reason: `only ${edgeCount} flow(s) in view — bundling needs at least 2 edges to have anything to bundle toward`,
    };
  }
  if (edgeCount > resolved.maxEdges) {
    return {
      bundled: false,
      reason:
        `${edgeCount} flows exceeds maxEdges (${resolved.maxEdges}); ` +
        'raise `bundling.maxEdges` if the CPU budget allows, or raise `minFlow` to thin the OD set',
    };
  }
  const units = bundleWorkUnits(edgeCount, resolved);
  if (units > BUNDLE_WORK_BUDGET) {
    return {
      bundled: false,
      reason:
        `bundling ${edgeCount} flows × ${P} control points × ${resolved.iterations} iterations ` +
        `would cost ~${(units / 1e6).toFixed(0)}M density-splat cells, over the ` +
        `${(BUNDLE_WORK_BUDGET / 1e6).toFixed(0)}M budget for one synchronous rebuild. ` +
        'Lower `bundling.kernelRadiusFraction` (cost is QUADRATIC in it), ' +
        '`bundling.pointsPerEdge` or `bundling.iterations`, or raise `minFlow` to thin the OD set',
    };
  }

  // 1. Resample each straight OD segment to P control points. Core's
  //    `resampleInto` streams straight out of a positions buffer and into the
  //    destination, so this allocates nothing per edge — and using it here
  //    (rather than a local lerp) is what pins the seeding to the same routine
  //    core's own iteration resamples with every round.
  const totalPoints = edgeCount * P;
  const lonLat = new Float64Array(totalPoints * 2);
  const segment = new Float64Array(4);
  let latSum = 0;
  for (let e = 0; e < edgeCount; e++) {
    segment[0] = endpoints[e * 4];
    segment[1] = endpoints[e * 4 + 1];
    segment[2] = endpoints[e * 4 + 2];
    segment[3] = endpoints[e * 4 + 3];
    latSum += segment[1] + segment[3];
    resampleInto(segment, 2, 0, 2, P, lonLat, e * P);
  }

  // 2. Normalize into the shared work box (cosLat-corrected so a degree of
  //    longitude and a degree of latitude are the same distance to the kernel).
  const meanLat = latSum / (edgeCount * 2);
  const cosLat0 = Math.max(Math.cos((meanLat * Math.PI) / 180), 1e-6);
  const box = toWorkBox(lonLat, totalPoints, cosLat0);

  // 3. The shared KDEEB iteration. This module writes NO kernel math of its own.
  const bundled = bundleEdges(box.work, edgeCount, P, {
    iterations: resolved.iterations,
    kernelRadius: resolved.kernelRadiusFraction * BUNDLING_WORK_SIZE,
    lambda: resolved.lambda,
    smoothing: resolved.smoothing,
    densityResolution: resolved.densityResolution,
  });

  // 4. Back to lon/lat, in place (the seed buffer is dead once step 2 read it).
  fromWorkBox(bundled, totalPoints, box, lonLat);

  // 5. Re-pin the endpoints to the SOURCE lon/lat verbatim. Core already pins
  //    them in work space; this removes the ~1e-13° of round-trip residue the
  //    normalize/denormalize adds, so a bundled river ends on its dock's exact
  //    coordinate and the node-circle it is drawn against cannot drift off it.
  for (let e = 0; e < edgeCount; e++) {
    const first = e * P * 2;
    const last = (e * P + P - 1) * 2;
    lonLat[first] = endpoints[e * 4];
    lonLat[first + 1] = endpoints[e * 4 + 1];
    lonLat[last] = endpoints[e * 4 + 2];
    lonLat[last + 1] = endpoints[e * 4 + 3];
  }

  return {
    bundled: true,
    edges: { edgeCount, pointsPerEdge: P, lonLat, options: resolved },
  };
}
