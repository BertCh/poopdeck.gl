// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * KDEEB edge-bundling — the **pure, device-free kernel math**, shared by every
 * backend that ships the `liveBundling` capability.
 *
 * Kernel-density edge bundling (Hurter, Ersoy & Telea 2012) with a CUBu-style
 * pipeline (van der Zwan & Telea 2016) bundles geometrically-close flows into
 * smooth rivers by iteratively advecting each edge's control points up the
 * gradient of an edge-DENSITY field. One iteration is:
 *
 *  1. SPLAT     — additively rasterize an Epanechnikov kernel of radius `h` at
 *                 every control point into a density texture.
 *  2. ADVECT    — move each interior control point a step `h` along the
 *                 normalized density gradient `∇ρ/‖∇ρ‖`.
 *  3. RESAMPLE  — redistribute each edge's points to uniform arc-length spacing
 *                 (advection bunches them; without this you get gaps/kinks).
 *  4. SMOOTH    — one 1D Laplacian pass along each edge, which removes the
 *                 advection/discretization zig-zags. THIS is what makes the
 *                 bundles smooth; advection alone is jagged.
 *  5. ANNEAL    — shrink `h` and repeat, progressively tightening the bundles.
 *
 * Steps 1, 2 and 4 are per-point arithmetic and step 3 is a polyline resample —
 * none of them touch a GPU device, a shading language, or a scene graph. They
 * live here so the four backends share ONE definition instead of hand-copying
 * the constants that the renderer-architecture record records drifting before
 * (`wakeTailScale` 0.15 vs 0.1, fade 10%-soft vs hard-0). Each backend still
 * writes its own device path — luma for deck, TSL for three, hand-written GLSL
 * for maplibre — and pins that path to these functions as the CPU oracle, the
 * same conformance idiom `time-filter.ts` uses for the scalar alpha.
 *
 * Endpoint pinning (columns `0` and `P-1` of every edge stay put) is a property
 * of the caller's advect loop, not of these primitives.
 */

/** A 2-D point/vector. */
export type Vec2 = readonly [number, number];

const sub = (a: Vec2, b: Vec2): [number, number] => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);

/**
 * Shared epsilon for the degenerate-length guards below. Segment lengths and
 * kernel radii at or under this read as zero rather than dividing.
 */
export const BUNDLING_EPS = 1e-9;
const EPS = BUNDLING_EPS;

/**
 * Radial **Epanechnikov** kernel weight (KDEEB's density kernel): `1 − (d/h)²`
 * inside the bandwidth `h`, `0` outside. Smooth, finite-support, cheap.
 *
 * A non-positive `radius` yields 0 rather than dividing by it, so an annealing
 * schedule that runs `h` to zero terminates instead of producing NaN.
 */
export function epanechnikovWeight(dist: number, radius: number): number {
  if (radius <= EPS) return 0;
  const x = dist / radius;
  return x >= 1 ? 0 : 1 - x * x;
}

/**
 * One 1D Laplacian smoothing step on a control point toward the midpoint of its
 * same-edge neighbours, by strength `f` (CUBu uses `f≈0.5`): `cur + f·(½(prev+
 * next) − cur)`. Evenly-spaced collinear points are unchanged; kinks relax.
 */
export function laplacianStep(
  prev: Vec2,
  cur: Vec2,
  next: Vec2,
  f: number,
): [number, number] {
  const mx = 0.5 * (prev[0] + next[0]) - cur[0];
  const my = 0.5 * (prev[1] + next[1]) - cur[1];
  return [cur[0] + f * mx, cur[1] + f * my];
}

/**
 * Allocation-free arc-length resample of ONE polyline straight out of a binary
 * `positions` buffer and straight into a caller-owned control-point buffer —
 * the streaming form of {@link subdivide}, for the per-tile-set bundle rebuild
 * path where the boxed `Vec2[]`/`cum[]` of `subdivide` dominates (one rebuild at
 * E=4000, P=48 allocates ~200k short-lived arrays).
 *
 * Reads vertices `[v0, v1)` of `positions` (stride `dims`) and writes `count`
 * evenly spaced points (endpoints preserved) at `out[(outPoint0 + i) * dims]`.
 * A single-vertex input degenerates to `count` copies of it; an empty input
 * writes zeros. Numerically identical to {@link subdivide} — the two are
 * cross-checked in `test/edge-bundling.test.ts`.
 */
export function resampleInto(
  positions: ArrayLike<number>,
  dims: number,
  v0: number,
  v1: number,
  count: number,
  out: Float64Array,
  outPoint0: number,
): void {
  const n = v1 - v0;
  const write = (i: number, x: number, y: number): void => {
    const o = (outPoint0 + i) * dims;
    out[o] = x;
    out[o + 1] = y;
  };
  if (n <= 0) {
    for (let i = 0; i < count; i++) write(i, 0, 0);
    return;
  }
  if (n === 1 || count < 2) {
    const x = positions[v0 * dims];
    const y = positions[v0 * dims + 1];
    for (let i = 0; i < count; i++) write(i, x, y);
    return;
  }

  // Total arc length (one pass, no cumulative array — the walk below re-derives
  // segment lengths in order, which is O(n + count) overall since `target` is
  // monotonically increasing).
  let total = 0;
  for (let v = v0 + 1; v < v1; v++) {
    const dx = positions[v * dims] - positions[(v - 1) * dims];
    const dy = positions[v * dims + 1] - positions[(v - 1) * dims + 1];
    total += Math.hypot(dx, dy);
  }

  let seg = v0 + 1; // walking segment [seg-1, seg]
  let acc = 0; // arc length consumed before `seg`
  let segLen = Math.hypot(
    positions[seg * dims] - positions[(seg - 1) * dims],
    positions[seg * dims + 1] - positions[(seg - 1) * dims + 1],
  );
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (seg < v1 - 1 && acc + segLen < target) {
      acc += segLen;
      seg++;
      segLen = Math.hypot(
        positions[seg * dims] - positions[(seg - 1) * dims],
        positions[seg * dims + 1] - positions[(seg - 1) * dims + 1],
      );
    }
    const f = segLen < EPS ? 0 : (target - acc) / segLen;
    const ax = positions[(seg - 1) * dims];
    const ay = positions[(seg - 1) * dims + 1];
    write(
      i,
      ax + f * (positions[seg * dims] - ax),
      ay + f * (positions[seg * dims + 1] - ay),
    );
  }
}

/**
 * Resample a polyline `points` into `newCount` evenly arc-length-spaced points,
 * preserving the endpoints — the readable reference form of the resampling the
 * GPU pass and {@link resampleInto} both implement, kept as the oracle the
 * streaming version is cross-checked against. Use {@link resampleInto} on any
 * hot path: this one boxes every vertex.
 */
export function subdivide(
  points: Vec2[],
  newCount: number,
): [number, number][] {
  if (newCount < 2 || points.length < 2) return points.map((p) => [p[0], p[1]]);
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++)
    cum.push(cum[i - 1] + len(sub(points[i], points[i - 1])));
  const total = cum[cum.length - 1];
  const out: [number, number][] = [];
  for (let k = 0; k < newCount; k++) {
    const target = (total * k) / (newCount - 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const segLen = cum[i] - cum[i - 1];
    const f = segLen < EPS ? 0 : (target - cum[i - 1]) / segLen;
    out.push([
      points[i - 1][0] + f * (points[i][0] - points[i - 1][0]),
      points[i - 1][1] + f * (points[i][1] - points[i - 1][1]),
    ]);
  }
  return out;
}

/**
 * Side length of the normalized simulation box. KDEEB's kernel and step
 * constants are scale-relative, so every dataset's cosLat-corrected endpoints
 * are mapped into a fixed box and the renderer reconstructs lon/lat from it.
 * Shared so a backend's box and its inverse mapping cannot disagree.
 */
export const BUNDLING_WORK_SIZE = 1000;

/**
 * One annealing step on the kernel bandwidth: `h ← h · lambda`, with `lambda`
 * clamped to the CUBu-sane `[0.5, 0.9]`. Progressively sharpening the density
 * map is what tightens the bundles across iterations.
 */
export function annealRadius(radius: number, lambda: number): number {
  const l = lambda < 0.5 ? 0.5 : lambda > 0.9 ? 0.9 : lambda;
  return radius * l;
}

// ───────────────────────── the CPU KDEEB iteration ──────────────────────────
// The primitives above are the pieces; this is the loop that uses them. It
// lives here rather than in a backend because it is pure arithmetic over
// control points, and because a bundle is STATIC GEOMETRY: it is recomputed
// when the edge set changes, never per frame. That is what makes one shared CPU
// implementation viable for every backend, including the two (maplibre, cesium)
// that have no compute path of their own to run it on.
//
// deck runs the same schedule as a GPU ping-pong for a different reason: it
// already owns a luma `Device`, so the splat is free there. The two agree on
// the SCHEDULE and on this module's kernel functions, which is what makes them
// the same capability rather than two lookalikes.

/**
 * Bilinear sample of a square density grid at fractional grid coordinates,
 * where INTEGER coordinates are cell CENTRES. Out-of-range reads clamp to the
 * edge rather than wrapping, so a control point near the border of the work box
 * sees a flat field instead of density from the opposite side.
 *
 * Exported for the test suite: the advection's correctness rests on this being
 * a genuinely continuous reconstruction (see the ADVECT step's note on why a
 * nearest-cell stencil biased a lone edge by a whole bandwidth).
 */
export function sampleDensity(
  density: ArrayLike<number>,
  res: number,
  gx: number,
  gy: number,
): number {
  const cx = gx < 0 ? 0 : gx > res - 1 ? res - 1 : gx;
  const cy = gy < 0 ? 0 : gy > res - 1 ? res - 1 : gy;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 + 1 > res - 1 ? res - 1 : x0 + 1;
  const y1 = y0 + 1 > res - 1 ? res - 1 : y0 + 1;
  const fx = cx - x0;
  const fy = cy - y0;
  const a = density[y0 * res + x0];
  const b = density[y0 * res + x1];
  const c = density[y1 * res + x0];
  const d = density[y1 * res + x1];
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

/** Knobs on {@link bundleEdges}. Defaults are the CUBu-paper values. */
export interface BundleEdgesOptions {
  /** Advection/anneal rounds. @default 15 */
  iterations?: number;
  /**
   * Initial kernel bandwidth `h`, in work-box units. Also the advection STEP —
   * KDEEB moves a point one bandwidth per round, which is what lets the bundle
   * form in ~15 rounds instead of hundreds. @default 3% of the work box
   */
  kernelRadius?: number;
  /** Per-round bandwidth decay, clamped to [0.5, 0.9] by {@link annealRadius}. @default 0.85 */
  lambda?: number;
  /** 1D Laplacian smoothing strength per round. @default 0.5 */
  smoothing?: number;
  /** Density grid resolution per axis. @default 256 */
  densityResolution?: number;
}

/**
 * Bundle `edgeCount` edges of `pointsPerEdge` control points each, in place-safe
 * fashion (the input is never mutated; a new buffer is returned).
 *
 * `points` is edge-major and 2-D: edge `e`'s point `i` is at
 * `(e * pointsPerEdge + i) * 2`. Coordinates are expected in the shared
 * {@link BUNDLING_WORK_SIZE} box — map your cosLat-corrected endpoints into it
 * first so the bandwidth constants mean the same thing at every scale, and map
 * back afterwards.
 *
 * ENDPOINTS ARE PINNED. Column `0` and column `pointsPerEdge - 1` of every edge
 * are copied through untouched every round: a bundled flow must still start and
 * end where its data says it does, and letting the ends drift is what turns a
 * flow map into abstract art.
 *
 * Degenerate inputs return a copy rather than throwing — fewer than 3 points per
 * edge has no interior to advect, and a single edge has nothing to bundle
 * toward, so both are identity (modulo the smoothing pass, which is also
 * identity on an evenly-spaced straight line).
 */
export function bundleEdges(
  points: ArrayLike<number>,
  edgeCount: number,
  pointsPerEdge: number,
  opts: BundleEdgesOptions = {},
): Float64Array {
  const total = edgeCount * pointsPerEdge;
  const out = new Float64Array(total * 2);
  for (let i = 0; i < total * 2; i++) out[i] = points[i];
  if (edgeCount < 1 || pointsPerEdge < 3) return out;

  const iterations = Math.max(0, opts.iterations ?? 15);
  const lambda = opts.lambda ?? 0.85;
  const smoothing = opts.smoothing ?? 0.5;
  const res = Math.max(16, Math.floor(opts.densityResolution ?? 256));
  let h = opts.kernelRadius ?? BUNDLING_WORK_SIZE * 0.03;

  const density = new Float64Array(res * res);
  const scratch = new Float64Array(pointsPerEdge * 2);
  const cell = BUNDLING_WORK_SIZE / res;

  for (let round = 0; round < iterations; round++) {
    if (h <= BUNDLING_EPS) break;

    // 1. SPLAT — additive Epanechnikov density over every control point.
    density.fill(0);
    const rCells = Math.max(1, Math.ceil(h / cell));
    for (let p = 0; p < total; p++) {
      const gx = out[p * 2] / cell;
      const gy = out[p * 2 + 1] / cell;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      for (let dy = -rCells; dy <= rCells; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= res) continue;
        for (let dx = -rCells; dx <= rCells; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= res) continue;
          const d = Math.hypot((x + 0.5 - gx) * cell, (y + 0.5 - gy) * cell);
          const w = epanechnikovWeight(d, h);
          if (w > 0) density[y * res + x] += w;
        }
      }
    }

    // 2. ADVECT — move each INTERIOR point one bandwidth up the density
    //    gradient. A flat neighbourhood (an edge with nothing near it) yields a
    //    zero gradient and the point stays put, which is the correct "nothing to
    //    bundle to".
    //
    //    ⚠ The gradient is sampled BILINEARLY about the point's true position,
    //    not by differencing the cells either side of the cell it happens to
    //    fall in. That distinction is not a refinement — it is correctness. A
    //    nearest-cell stencil is centred on the CELL, so a point sitting near a
    //    cell boundary sees neighbours at unequal distances and reads a non-zero
    //    gradient out of a perfectly symmetric field. Measured on a single
    //    straight edge (which has nothing to attract it and must therefore not
    //    move), that bias walked the edge a full bandwidth — as far as real
    //    attraction moves a point — so the two were indistinguishable. The
    //    bilinear sample makes the lone-edge drift a quantization residual
    //    again, orders of magnitude below genuine attraction, and
    //    `edge-bundling.test.ts` pins exactly that separation.
    for (let e = 0; e < edgeCount; e++) {
      for (let i = 1; i < pointsPerEdge - 1; i++) {
        const p = e * pointsPerEdge + i;
        const gx = out[p * 2] / cell - 0.5; // grid coords, cell CENTRES at integers
        const gy = out[p * 2 + 1] / cell - 0.5;
        if (gx < 1 || gy < 1 || gx >= res - 2 || gy >= res - 2) continue;
        const dx =
          sampleDensity(density, res, gx + 1, gy) -
          sampleDensity(density, res, gx - 1, gy);
        const dy =
          sampleDensity(density, res, gx, gy + 1) -
          sampleDensity(density, res, gx, gy - 1);
        const len = Math.hypot(dx, dy);
        if (len < BUNDLING_EPS) continue;
        out[p * 2] += (dx / len) * h;
        out[p * 2 + 1] += (dy / len) * h;
      }
    }

    // 3. RESAMPLE — advection bunches points along the edge; without this the
    //    bundle develops gaps and kinks.
    for (let e = 0; e < edgeCount; e++) {
      const base = e * pointsPerEdge;
      resampleInto(
        out,
        2,
        base,
        base + pointsPerEdge,
        pointsPerEdge,
        scratch,
        0,
      );
      for (let i = 0; i < pointsPerEdge * 2; i++)
        out[base * 2 + i] = scratch[i];
    }

    // 4. SMOOTH — one 1D Laplacian pass. THIS is what makes the bundles smooth;
    //    advection alone is jagged. Read from a snapshot so the pass is
    //    simultaneous rather than a sequential drift down the edge.
    for (let e = 0; e < edgeCount; e++) {
      const base = e * pointsPerEdge;
      for (let i = 0; i < pointsPerEdge * 2; i++)
        scratch[i] = out[base * 2 + i];
      for (let i = 1; i < pointsPerEdge - 1; i++) {
        const [sx, sy] = laplacianStep(
          [scratch[(i - 1) * 2], scratch[(i - 1) * 2 + 1]],
          [scratch[i * 2], scratch[i * 2 + 1]],
          [scratch[(i + 1) * 2], scratch[(i + 1) * 2 + 1]],
          smoothing,
        );
        out[(base + i) * 2] = sx;
        out[(base + i) * 2 + 1] = sy;
      }
    }

    // 5. ANNEAL — sharpen the density map so later rounds tighten the bundle.
    h = annealRadius(h, lambda);
  }

  // Endpoints are pinned: restore them verbatim in case resampling nudged the
  // last float. (`resampleInto` preserves endpoints by construction; this makes
  // the guarantee exact rather than "as exact as the arc-length walk".)
  for (let e = 0; e < edgeCount; e++) {
    const first = e * pointsPerEdge;
    const last = first + pointsPerEdge - 1;
    out[first * 2] = points[first * 2];
    out[first * 2 + 1] = points[first * 2 + 1];
    out[last * 2] = points[last * 2];
    out[last * 2 + 1] = points[last * 2 + 1];
  }
  return out;
}
