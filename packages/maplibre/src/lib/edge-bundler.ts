// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * KDEEB edge bundling for this backend — the **tile-side half**: resample a
 * flow tile's OD features into per-edge control polylines, run the shared
 * bundler over them, and hand back the texel payload
 * `shaders/bundle.glsl.ts` samples in the vertex stage.
 *
 * ── The iteration is NOT here, on purpose ───────────────────────────────────
 * Kernel-density edge bundling (Hurter, Ersoy & Telea 2012; CUBu pipeline, van
 * der Zwan & Telea 2016) is splat → advect → resample → smooth → anneal. Every
 * line of that lives in ONE place, `bundleEdges()` in
 * `@poopdeck.gl/core/edge-bundling`, and this module calls it. There is no
 * second copy of the kernel here, in GLSL or otherwise, and there must never
 * be: the renderer-architecture record already has one case of hand-copied
 * scalar math drifting across backends in shipped pixels, and a bundling
 * constant is exactly the kind of number that drifts silently.
 *
 * That sharing is possible because of what a bundle IS:
 *
 *   **A bundle is STATIC GEOMETRY.** It is a function of the edge SET alone —
 *   not the playhead, not the camera, not the frame. It is computed once when a
 *   tile is uploaded and never touched again. The deck backend runs the same
 *   schedule as a GPU ping-pong for a different reason (it already owns a luma
 *   `Device`, so the splat is free there), but the two agree on the schedule
 *   and on core's kernel functions, which is what makes them the same
 *   capability rather than two lookalikes.
 *
 * This package has no compute path to run a splat on — no luma, no transform
 * feedback abstraction, one runtime dependency (`@poopdeck.gl/core`) and a raw
 * `gl` handed to it by a host that also owns it. Writing a raw-WebGL2 ping-pong
 * here would buy a second implementation of maths that runs ONCE PER TILE, at a
 * cost of: a WebGL2-only path in a package that must run on maplibre v3/v4
 * WebGL1 hosts, a float-renderable + `EXT_float_blend` requirement that turns
 * the capability off on the mobile GPUs that lack it, four extra programs and
 * six extra GL objects per bundle, and the drift risk above. The GPU is used
 * for the part it is actually good at: holding the finished control points and
 * sampling them per vertex, per frame, for free.
 *
 * ── Cost, honestly ─────────────────────────────────────────────────────────
 * The bundle runs SYNCHRONOUSLY on the tile-upload path, and it is linear in
 * the edge count. Measured on a 2026 laptop at the defaults below: ~65 ms for
 * 128 edges, ~130 ms for 256, ~255 ms at the 512-edge default cap. That is a
 * one-off hitch per tile, never a per-frame cost — but it is real, and it is
 * why {@link DEFAULT_BUNDLE_CAP} is 512 where the deck backend's
 * `maxBundledEdges` is 4000. deck splats on the GPU; this does not. Raise the
 * cap only if the hitch is acceptable for your tiles, and prefer a coarser
 * summary tier to a bigger cap.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 *   - **No cross-tile bundling.** Each tile bundles its own edges. Two halves
 *     of one corridor split across a tile seam bundle independently and will
 *     not meet perfectly at the boundary. Bundling is an OVERVIEW idiom (deck's
 *     sibling drives it off a summary tier, which is one tile), so in practice
 *     the bundled view is a single tile; this is a documented limit, not a bug
 *     that has been hidden.
 *   - **No animation of the bundle.** There is no per-frame relaxation and no
 *     "watch it bundle" reveal. The tile arrives, the bundle is computed, the
 *     texture is uploaded, and that geometry stands until the tile is evicted.
 *   - **No re-bundling on a style change.** Width, colour, minFlow and the
 *     playhead do not touch the bundle. Only the EDGE SET does.
 *   - **No lon/lat isotropy correction.** deck bundles in lon/lat and therefore
 *     carries a `cosLat0` to stop a high-latitude box from shearing. This
 *     backend bundles in MERCATOR, which is conformal — locally isotropic by
 *     construction — so the correction is not merely omitted, it would be
 *     wrong. See {@link toWorkBox}.
 */

import {
  BUNDLING_WORK_SIZE,
  bundleEdges,
  resampleInto,
} from '@poopdeck.gl/core/edge-bundling';
import { lngLatToMercatorInto } from './projection.js';

/** Control points per edge when the caller does not choose. deck uses 48. */
export const DEFAULT_BUNDLE_POINTS = 24;

/**
 * Hard ceiling on control points per edge. The texture is `P` texels WIDE, and
 * the arrow tessellation is raised to `P` segments, so an absurd value costs
 * vertices in every frame forever — unlike the edge count, which costs bytes.
 */
export const MAX_BUNDLE_POINTS = 128;

/**
 * Edges past which a tile is NOT bundled (it keeps its own geometry instead).
 * 512 rather than deck's 4000 because the splat runs on the CPU here — see the
 * module header's cost note.
 */
export const DEFAULT_BUNDLE_CAP = 512;

/**
 * Density-grid resolution per axis. 128² rather than core's 256² default: the
 * splat cost is quadratic in `h / cell`, so halving the resolution is a 4×
 * saving, and at the default bandwidth (5% of the work box = 6.4 cells at 128²)
 * the field is still resolved several cells inside the kernel.
 */
export const DEFAULT_BUNDLE_DENSITY_RES = 128;

/** Initial kernel bandwidth as a FRACTION of the work box — deck's default. */
export const DEFAULT_BUNDLE_KERNEL_RADIUS = 0.05;

/**
 * Fraction of the work box left EMPTY on each side.
 *
 * Not cosmetic. core's advection skips any control point within two grid cells
 * of the density field's border — it has no centred gradient stencil there — so
 * a mapping that puts the data's bounding box exactly on the box edges pins the
 * OUTERMOST corridors in place while their neighbours bundle inward. Measured
 * on three parallel corridors, the edge one did not move a single float. A 5%
 * inset costs 10% of the dynamic range (so the bandwidth means ~11% more of the
 * data than it otherwise would) and buys every edge an equal chance to move.
 */
const BUNDLE_WORK_MARGIN = 0.05;

/**
 * Below this mercator extent a tile's edges are all effectively the same point,
 * so mapping them into the work box would multiply float noise by ~1e9. Such a
 * tile is returned unbundled. 1e-9 mercator ≈ 4 cm at the equator.
 */
const MIN_WORK_EXTENT = 1e-9;

/**
 * Knobs on {@link buildFlowBundle}. Names mirror the deck backend's
 * `BundledFlowmapLayer` props so a ported app tunes the same dials, and every
 * default is stated on the field rather than only in code.
 */
export interface FlowBundleOptions {
  /**
   * Control points each edge is resampled to (`P`, the texture WIDTH, and the
   * arrow's tessellation floor). Clamped to `[3, MAX_BUNDLE_POINTS]`.
   * @default 24
   */
  subdivisionPoints?: number;
  /** KDEEB advection/anneal rounds. @default 15 */
  bundlingIterations?: number;
  /**
   * Initial kernel bandwidth as a fraction of the work box. Also the advection
   * STEP — KDEEB moves a point one bandwidth per round. COST is quadratic in
   * this value. @default 0.05
   */
  kernelRadius?: number;
  /** 1D Laplacian smoothing strength per round, `0..1`. @default 0.5 */
  smoothingStrength?: number;
  /** Bandwidth anneal factor per round; core clamps it to `[0.5, 0.9]`. @default 0.85 */
  annealLambda?: number;
  /** Density-grid resolution per axis. @default 128 */
  densityResolution?: number;
  /**
   * Edges past which the tile is returned UNBUNDLED rather than stalling the
   * upload. See the module header's cost note before raising it.
   * @default 512
   */
  maxBundledEdges?: number;
}

/** The three host capabilities {@link isBundlingSupported} needs, structurally. */
export interface BundlingProbe {
  /**
   * Can the VERTEX stage sample a texture at all? WebGL2 guarantees ≥16 units;
   * the WebGL1 minimum is ZERO. `supportsVertexTextureFetch` in
   * `lib/flow-kernel.ts` answers this from a live context.
   */
  vertexTextureFetch: boolean;
  /**
   * Can a FLOAT texture be sampled? WebGL2 always; WebGL1 needs
   * `OES_texture_float`. Control points are mercator, and 16-bit fixed point
   * over a continental work box lands ~80 m of quantization on a river that is
   * a few pixels wide — so unlike the value matrix, this payload has no
   * `unorm16` fallback. It is float or it is nothing.
   */
  floatTextures: boolean;
  /** `gl.MAX_TEXTURE_SIZE` — bounds `P` (width) and the edge count (height). */
  maxTextureSize: number;
}

/**
 * Can this host render bundled paths?
 *
 * Note what is NOT in this gate: `EXT_float_blend` and float-RENDERABLE colour
 * attachments. The deck backend requires both, because it additively splats the
 * density field into an R32F render target. This backend splats on the CPU, so
 * it needs a float texture it can SAMPLE and nothing more — which lights the
 * capability up on every WebGL2 host and on the mobile GPUs that ship
 * `OES_texture_float` without `EXT_float_blend` (the cosmos.gl caveat deck's
 * bundler documents). Claiming the stricter gate here would turn the feature
 * off on hardware that runs it perfectly.
 *
 * A false answer is not an error: the layer compiles the straight / baked-Bézier
 * arrow path instead and says so once.
 */
export function isBundlingSupported(probe: BundlingProbe): boolean {
  return (
    probe.vertexTextureFetch && probe.floatTextures && probe.maxTextureSize >= 1
  );
}

/**
 * Largest edge count a bundle `pointsPerEdge` texels wide can have, given the
 * host's `MAX_TEXTURE_SIZE` and the caller's own cap. Returns `0` when the
 * WIDTH alone already exceeds the limit, i.e. no bundle of any size fits.
 *
 * This is consulted BEFORE anything is allocated, because a `texImage2D` past
 * the limit raises INVALID_VALUE and leaves an INCOMPLETE texture rather than
 * throwing — every arrow would silently collapse onto the tile origin, which is
 * exactly the class of failure a rasterization-free test suite cannot see.
 */
export function maxBundleEdges(
  maxTextureSize: number,
  pointsPerEdge: number,
  cap: number = DEFAULT_BUNDLE_CAP,
): number {
  if (pointsPerEdge > maxTextureSize) return 0;
  return Math.max(0, Math.min(Math.floor(cap), Math.floor(maxTextureSize)));
}

/** The tile geometry {@link buildFlowBundle} reads. */
export interface FlowBundleInput {
  /** Interleaved lon/lat vertex list of every feature, stride {@link dims}. */
  positions?: ArrayLike<number>;
  /** Per-feature first-vertex offsets, `featureCount + 1` long. */
  startIndices?: ArrayLike<number>;
  /** Position stride of {@link positions} — 2 or 3. Only lon/lat are read. */
  dims: number;
  /** Per-pair mercator origins, stride 2, already antimeridian-unwrapped. */
  sourceM: ArrayLike<number>;
  /** Per-pair mercator destinations, stride 2, already unwrapped. */
  targetM: ArrayLike<number>;
  /** Number of OD pairs, `E` — one texture ROW each, in instance order. */
  edgeCount: number;
  /**
   * Antimeridian unwrap, `x - floor(x - referenceX + 0.5)`. INJECTED rather
   * than imported: the layer owns the canonical copy (`unwrapFlowMercatorX`),
   * and a lib reaching up into a layer would invert this package's dependency
   * direction — the same reason `h3-js` is injected into the summary layers.
   */
  unwrapX(referenceX: number, x: number): number;
}

/**
 * One tile's BUNDLED control points, ready to upload. A tile that was not
 * bundled produces no `FlowBundle` at all (see {@link buildFlowBundle}), so the
 * existence of this object means exactly one thing: the KDEEB iteration ran
 * over this tile's edges and these are its output.
 */
export interface FlowBundle {
  /**
   * `pointsPerEdge × edgeCount × 4` RGBA float texels — `.xy` is a MERCATOR
   * position, `.zw` is zero. Row-major: edge `e`'s point `i` starts at
   * `(e * pointsPerEdge + i) * 4`.
   */
  readonly texels: Float32Array;
  /** Control points per edge — the texture WIDTH, and the tessellation floor. */
  readonly pointsPerEdge: number;
  /** Edges — the texture HEIGHT. */
  readonly edgeCount: number;
}

/**
 * Map `points` (mercator, in place) into the shared {@link BUNDLING_WORK_SIZE}
 * box and return the inverse mapping: `mercator = work / scale + origin`.
 *
 * ONE scale for both axes, deliberately. KDEEB's bandwidth is a single radius,
 * so anisotropic scaling would make "close" mean different distances along x
 * and y and bundle a north-south corridor differently from an east-west one.
 * Mercator is conformal, so a uniform scale IS the isotropic choice — which is
 * why, unlike deck's lon/lat bundler, there is no `cosLat0` here.
 *
 * The data is inset by {@link BUNDLE_WORK_MARGIN} rather than filling the box,
 * so no edge starts inside the density field's un-differentiable border.
 *
 * Returns `null` for a degenerate extent (every point effectively coincident),
 * which the caller treats as "nothing to bundle".
 */
export function toWorkBox(
  points: Float64Array,
  count: number,
): { scale: number; originX: number; originY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(extent) || extent < MIN_WORK_EXTENT) return null;
  const scale = (BUNDLING_WORK_SIZE * (1 - 2 * BUNDLE_WORK_MARGIN)) / extent;
  // Fold the inset into the ORIGIN so the inverse stays a single
  // `work / scale + origin` and cannot disagree with the forward map.
  const pad = BUNDLING_WORK_SIZE * BUNDLE_WORK_MARGIN;
  const originX = minX - pad / scale;
  const originY = minY - pad / scale;
  for (let i = 0; i < count; i++) {
    points[i * 2] = (points[i * 2] - originX) * scale;
    points[i * 2 + 1] = (points[i * 2 + 1] - originY) * scale;
  }
  return { scale, originX, originY };
}

/**
 * Resample every OD feature to `pointsPerEdge` evenly arc-length-spaced
 * MERCATOR control points, edge-major, into a freshly allocated buffer.
 *
 * A feature's own vertices are used when it has them (an archive that already
 * baked a bundle keeps its shape as the bundler's starting point, which is
 * strictly better than throwing it away and re-deriving a chord); a plain
 * 2-vertex OD pair resamples to a straight, evenly spaced chord. Interior
 * vertices are unwrapped onto the same side of the antimeridian as their
 * origin, so a Tokyo→LA pair stays short instead of sweeping the whole map.
 *
 * Endpoints come from `sourceM`/`targetM` VERBATIM, never from the resample:
 * the shader measures the arrow's on-screen length and head fraction off those
 * same attributes, so a path whose ends drifted by a float would visibly detach
 * from its own arrowhead.
 */
export function resampleFlowEdges(
  input: FlowBundleInput,
  pointsPerEdge: number,
): Float64Array {
  const {
    edgeCount: E,
    positions,
    startIndices,
    dims,
    sourceM,
    targetM,
  } = input;
  const P = pointsPerEdge;
  const out = new Float64Array(E * P * 2);
  // One scratch polyline reused across features — this runs once per tile, but
  // a per-feature allocation would still be thousands of arrays.
  let poly = new Float64Array(64);
  for (let e = 0; e < E; e++) {
    const sx = sourceM[e * 2];
    const sy = sourceM[e * 2 + 1];
    const tx = targetM[e * 2];
    const ty = targetM[e * 2 + 1];
    let interior = 0;
    if (positions && startIndices) {
      const begin = startIndices[e] + 1;
      const end = startIndices[e + 1] - 1;
      interior = Math.max(0, end - begin);
      const needed = (interior + 2) * 2;
      if (needed > poly.length) poly = new Float64Array(needed);
      for (let v = 0; v < interior; v++) {
        const base = (begin + v) * dims;
        lngLatToMercatorInto(
          positions[base],
          positions[base + 1],
          poly,
          (v + 1) * 2,
        );
        poly[(v + 1) * 2] = input.unwrapX(sx, poly[(v + 1) * 2]);
        // A non-finite vertex would poison the whole arc-length walk; drop the
        // feature's interior rather than the feature.
        if (
          !Number.isFinite(poly[(v + 1) * 2]) ||
          !Number.isFinite(poly[(v + 1) * 2 + 1])
        ) {
          interior = 0;
          break;
        }
      }
    }
    poly[0] = sx;
    poly[1] = sy;
    poly[(interior + 1) * 2] = tx;
    poly[(interior + 1) * 2 + 1] = ty;
    resampleInto(poly, 2, 0, interior + 2, P, out, e * P);
    // Pin the ends to the chord attributes exactly (see the doc comment).
    out[e * P * 2] = sx;
    out[e * P * 2 + 1] = sy;
    out[(e * P + P - 1) * 2] = tx;
    out[(e * P + P - 1) * 2 + 1] = ty;
  }
  return out;
}

/**
 * Resample a tile's OD features, bundle them with the shared KDEEB
 * implementation, and pack the result as RGBA float texels in MERCATOR.
 *
 * Returns **null** whenever this tile is not bundled, which is a normal
 * outcome, not an error — the caller draws its straight (or baked-Bézier)
 * arrows and allocates nothing:
 *
 *   - **fewer than 2 edges.** KDEEB's entire signal is one edge's density seen
 *     by another, so a single edge is identity by construction. Running 15
 *     rounds to prove that would burn a frame for a guaranteed no-op.
 *   - **over `maxBundledEdges`, or over the host's texture ceiling.** The
 *     cheap checks happen BEFORE the resample, so an oversized tile costs
 *     nothing at all.
 *   - **a degenerate extent** — every edge collapsed onto effectively one
 *     point, where the work-box mapping would multiply float noise by ~1e9.
 *
 * The bundler is called EXACTLY ONCE, with work-box coordinates, and its output
 * is used verbatim — `test/edge-bundler.test.ts` pins both halves of that
 * sentence by re-running `bundleEdges` itself and comparing.
 *
 * `maxTextureSize` is the HOST's `gl.MAX_TEXTURE_SIZE`, not a user knob; it is
 * a separate argument for exactly that reason.
 */
export function buildFlowBundle(
  input: FlowBundleInput,
  opts: FlowBundleOptions = {},
  maxTextureSize = 4096,
): FlowBundle | null {
  const E = Math.floor(input.edgeCount);
  if (!Number.isFinite(E) || E < 2) return null;
  const P = clampBundlePoints(opts.subdivisionPoints);
  const limit = maxBundleEdges(
    maxTextureSize,
    P,
    opts.maxBundledEdges ?? DEFAULT_BUNDLE_CAP,
  );
  if (E > limit) return null;

  const total = E * P;
  const raw = resampleFlowEdges(input, P);
  const box = toWorkBox(raw, total);
  if (!box) return null;

  const work = bundleEdges(raw, E, P, {
    iterations: opts.bundlingIterations ?? 15,
    kernelRadius:
      (opts.kernelRadius ?? DEFAULT_BUNDLE_KERNEL_RADIUS) * BUNDLING_WORK_SIZE,
    lambda: opts.annealLambda ?? 0.85,
    smoothing: opts.smoothingStrength ?? 0.5,
    densityResolution: opts.densityResolution ?? DEFAULT_BUNDLE_DENSITY_RES,
  });

  const texels = new Float32Array(total * 4);
  const inv = 1 / box.scale;
  for (let i = 0; i < total; i++) {
    texels[i * 4] = work[i * 2] * inv + box.originX;
    texels[i * 4 + 1] = work[i * 2 + 1] * inv + box.originY;
  }
  // Endpoints once more: `bundleEdges` pins them, but the work-box round trip
  // is a multiply and an add, so restore the attribute values verbatim. The
  // shader measures the arrow's on-screen length and head fraction off those
  // same attributes, and a path whose ends drifted would detach from its own
  // arrowhead.
  for (let e = 0; e < E; e++) {
    const first = e * P * 4;
    const last = (e * P + P - 1) * 4;
    texels[first] = input.sourceM[e * 2];
    texels[first + 1] = input.sourceM[e * 2 + 1];
    texels[last] = input.targetM[e * 2];
    texels[last + 1] = input.targetM[e * 2 + 1];
  }
  return { texels, pointsPerEdge: P, edgeCount: E };
}

/** `subdivisionPoints` sanitized to `[3, MAX_BUNDLE_POINTS]` integers. */
export function clampBundlePoints(points: number | undefined): number {
  const n = points ?? DEFAULT_BUNDLE_POINTS;
  if (!Number.isFinite(n)) return DEFAULT_BUNDLE_POINTS;
  return Math.max(3, Math.min(MAX_BUNDLE_POINTS, Math.floor(n)));
}
