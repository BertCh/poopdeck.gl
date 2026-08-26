// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) **flow-stroke width math** — the per-PATH "breathing" width
 * that {@link STTFlowStrokeLayer} adds on top of the inherited flow-corridor
 * colour animation. The Three port of deck's `FlowStrokeLayer.widthsFor`.
 *
 * A flow-corridor tile carries a per-vertex × per-time-bucket volume matrix
 * (`BinaryFeatures.vertexValueMatrix`, `vertexValueBuckets` columns, flattened
 * globally vertex-major). The corridor kind animates per-vertex COLOUR from it.
 * A STROKE additionally animates WIDTH, and — because a stroke is drawn as ONE
 * path (deck's `PathLayer` width is uniform along a path) — that width is a
 * single scalar per corridor:
 *
 * ```text
 * width(path) = peak(path, t) ** widthExponent × widthScale   clamped to px
 * peak(path, t) = max over the path's vertices of the two-bucket blend at t
 * peak <= minFlow  ⇒  width = 0 (invisible)   — the per-hour pulse
 * ```
 *
 * **`max ∘ blend`, never `blend ∘ max`.** The busiest vertex is resolved AT the
 * blended bucket, not per column: for a convex blend `(1−f)·a + f·b` the two
 * differ whenever the argmax vertex changes between the adjacent columns (a
 * corridor whose peak migrates from one intersection to the next through the
 * hour). Precomputing a per-path × per-bucket column max would be O(paths)
 * per sub-step instead of O(vertices), but it is a strict UPPER BOUND, not the
 * value deck draws — so this module keeps the path's vertex rows and blends
 * them, exactly as deck does.
 *
 * The whole module is a pure function of the decoded tiles + a playhead bucket
 * position: no Three import, no GPU state, unit-testable in plain Node.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import type { BucketAxis } from './flow-corridor-buffers.js';

/**
 * Cross-fade granularity in fractions of a bucket, mirroring deck
 * `FlowCorridorLayer.STEP`. `0.5` ⇒ two width recomputes per bucket. The width
 * is re-derived when — and only when — the playhead crosses one of these
 * sub-steps ({@link flowStrokeSubStep}); the GEOMETRY never re-uploads.
 */
export const FLOW_STROKE_SUB_STEP = 0.5;

/** √ — area-proportional, the cartographic default (deck `widthExponent`). */
export const DEFAULT_WIDTH_EXPONENT = 0.5;

/** The two adjacent bucket columns + blend fraction for a stepped position. */
export interface BucketBlend {
  /** Lower bucket column. */
  b0: number;
  /** Upper bucket column (clamped to the last column). */
  b1: number;
  /** Fraction of `b1` in the blend. `<= 0` reads `b0` alone. */
  f: number;
}

/**
 * The per-path payload the stroke width needs, in the EXACT merge order
 * {@link buildFlowCorridorBuffers} emits segment instances — so
 * `segmentPath[s]` names the owning corridor of merged instance `s`.
 */
export interface FlowStrokePaths {
  /** Merged corridor (LineString feature) count. */
  pathCount: number;
  /** Merged segment-instance count — equals `FlowCorridorBuffers.count`. */
  segmentCount: number;
  /** Time-bucket columns shared by every accepted tile. */
  numBuckets: number;
  /**
   * Per-vertex bucket rows, packed path-major:
   * `values[(vertexStart[p] + k) * numBuckets + b]` is corridor `p`'s `k`-th
   * vertex in bucket `b`. Copied out of the tiles so the paths outlive them.
   */
  values: Float32Array;
  /** `pathCount + 1` prefix offsets into {@link values}' vertex rows. */
  vertexStart: Uint32Array;
  /** Owning path index per merged segment instance. Length `segmentCount`. */
  segmentPath: Uint32Array;
  /** Global bucket axis (null when no tile carried a usable matrix). */
  axis: BucketAxis | null;
}

/** Width knobs. Names and defaults mirror deck's `FlowStrokeLayer`/`PathLayer`. */
export interface FlowStrokeWidthOptions {
  /** Width = `peak ** widthExponent`. @default 0.5 (√, area-proportional) */
  widthExponent?: number;
  /** Corridors whose active-bucket peak is `<= minFlow` collapse to 0. @default 0 */
  minFlow?: number;
  /** Multiplier applied AFTER the exponent (deck `widthScale`). @default 1 */
  widthScale?: number;
  /** Lower clamp in CSS px, applied after the scale. @default 0 */
  minWidthPx?: number;
  /** Upper clamp in CSS px, applied after the scale. @default unbounded */
  maxWidthPx?: number;
}

/**
 * A tile layer that carries a usable flow matrix. MIRRORS `isFlowLayer` in
 * `./flow-corridor-buffers.ts` — the two predicates MUST agree or
 * `segmentPath` would index a different merge order than the instances the
 * corridor builder emitted. `buildFlowStrokePaths` is pinned against
 * `buildFlowCorridorBuffers` by test, so drift fails CI rather than silently
 * mis-widthing every corridor.
 */
function isFlowLayer(b: BinaryFeatures): boolean {
  const nb = b.vertexValueBuckets ?? 0;
  return (
    b.featureCount > 0 &&
    b.geometryType === GeometryType.LineString &&
    !!b.startIndices &&
    nb > 0 &&
    !!b.vertexValueMatrix
  );
}

/**
 * Derive the global bucket axis from a flow layer's feature-0 `[start,end]`.
 * MIRRORS `axisFor` in `./flow-corridor-buffers.ts` (which is module-private
 * there); pinned equal by test so the stroke width blends at exactly the bucket
 * position the corridor material samples its value texture at.
 */
function axisFor(b: BinaryFeatures): BucketAxis | null {
  const nb = b.vertexValueBuckets ?? 0;
  if (nb <= 0 || !b.startTimes || b.startTimes.length === 0 || !b.endTimes)
    return null;
  const rel0 = b.startTimes[0];
  const span = b.endTimes[0] - rel0;
  if (span <= 0) return null;
  return {
    numBuckets: nb,
    bucket0Abs: b.timeOffset + rel0,
    bucketWidth: span / nb,
  };
}

/** The all-empty shape — returned rather than `null`, like the buffer builders. */
function emptyPaths(): FlowStrokePaths {
  return {
    pathCount: 0,
    segmentCount: 0,
    numBuckets: 0,
    values: new Float32Array(0),
    vertexStart: new Uint32Array(1),
    segmentPath: new Uint32Array(0),
    axis: null,
  };
}

/**
 * Collect every corridor's vertex bucket rows from the resident tiles, in the
 * merge order {@link buildFlowCorridorBuffers} walks (tiles → layers →
 * features → vertex pairs), and map each merged segment instance back to its
 * owning corridor.
 *
 * Memory: `totalVertices × numBuckets` floats — the same order as the corridor
 * layer's own value texture (`segments × numBuckets × 2`), and the price of the
 * exact `max ∘ blend` documented at the top of this file.
 */
export function buildFlowStrokePaths(tiles: Tile[]): FlowStrokePaths {
  // Pass 1 — accept the layers that agree with the first tile's bucket count
  // (defensive; a dataset bakes a single global axis), and size the buffers.
  const layers: BinaryFeatures[] = [];
  let numBuckets = 0;
  let pathCount = 0;
  let segmentCount = 0;
  let vertexCount = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!isFlowLayer(b)) continue;
      const nb = b.vertexValueBuckets ?? 0;
      if (numBuckets === 0) numBuckets = nb;
      else if (nb !== numBuckets) continue;
      layers.push(b);
      const starts = b.startIndices!;
      pathCount += b.featureCount;
      vertexCount += starts[b.featureCount] - starts[0];
      for (let f = 0; f < b.featureCount; f++) {
        segmentCount += Math.max(0, starts[f + 1] - starts[f] - 1);
      }
    }
  }
  if (layers.length === 0 || numBuckets === 0) return emptyPaths();

  // Pass 2 — copy each corridor's vertex rows out of the (transient) tile
  // matrices and record the segment → path map.
  const values = new Float32Array(vertexCount * numBuckets);
  const vertexStart = new Uint32Array(pathCount + 1);
  const segmentPath = new Uint32Array(segmentCount);
  let p = 0; // path index
  let vOut = 0; // packed vertex cursor
  let s = 0; // merged segment-instance index
  for (const b of layers) {
    const starts = b.startIndices!;
    const matrix = b.vertexValueMatrix!;
    for (let f = 0; f < b.featureCount; f++) {
      const v0 = starts[f];
      const v1 = starts[f + 1];
      vertexStart[p] = vOut;
      for (let v = v0; v < v1; v++) {
        // The matrix is globally vertex-major and aligned 1:1 with `positions`,
        // so vertex `v` starts at `v * numBuckets`.
        const src = v * numBuckets;
        const dst = vOut * numBuckets;
        for (let bk = 0; bk < numBuckets; bk++) {
          values[dst + bk] = matrix[src + bk];
        }
        vOut++;
      }
      // One instance per consecutive vertex pair — the corridor builder's loop.
      for (let v = v0; v < v1 - 1; v++) segmentPath[s++] = p;
      p++;
    }
  }
  vertexStart[pathCount] = vOut;

  return {
    pathCount,
    segmentCount,
    numBuckets,
    values,
    vertexStart,
    segmentPath,
    axis: axisFor(layers[0]),
  };
}

/**
 * Resolve the bucket columns to blend for a continuous position `stepped`
 * (clamped here to `[0, numBuckets - 1]`). At the last column `b1 === b0`, so
 * the blend degenerates to a plain read. Mirrors `bucketBlendAt` in
 * `@poopdeck.gl/layers`' `lib/vertex-value-blend.ts` — three must not depend on
 * the deck package, so the two copies are pinned by the shared semantics tested
 * on both sides.
 */
export function bucketBlendAt(
  stepped: number,
  numBuckets: number,
): BucketBlend {
  if (numBuckets <= 0) return { b0: 0, b1: 0, f: 0 };
  const max = numBuckets - 1;
  // `!(x > 0)` also catches NaN, which would otherwise index the matrix wildly.
  let pos = stepped;
  if (!(pos > 0)) pos = 0;
  else if (pos > max) pos = max;
  const b0 = Math.floor(pos);
  const b1 = Math.min(b0 + 1, max);
  return { b0, b1, f: pos - b0 };
}

/**
 * The corridor's BUSIEST-vertex volume at a blended bucket position — the
 * `max ∘ blend` reduction. An empty path (or one whose whole row is
 * non-positive) peaks at `0`, which {@link strokeWidthFromPeak} collapses.
 */
export function pathPeakAt(
  paths: FlowStrokePaths,
  path: number,
  blend: BucketBlend,
): number {
  const { values, vertexStart, numBuckets, pathCount } = paths;
  if (path < 0 || path >= pathCount || numBuckets <= 0) return 0;
  const from = vertexStart[path];
  const to = vertexStart[path + 1];
  const { b0, b1, f } = blend;
  let peak = 0;
  if (f <= 0) {
    for (let v = from; v < to; v++) {
      const m = values[v * numBuckets + b0];
      if (m > peak) peak = m;
    }
    return peak;
  }
  const g = 1 - f;
  for (let v = from; v < to; v++) {
    const base = v * numBuckets;
    const m = values[base + b0] * g + values[base + b1] * f;
    if (m > peak) peak = m;
  }
  return peak;
}

/**
 * `peak → rendered width in CSS px`: the exponent, then the scale, then the
 * pixel clamp. A peak at or below `minFlow` returns EXACTLY `0` and BYPASSES
 * the `minWidthPx` floor — "inactive → invisible" is the point of the pulse, so
 * a floor must never resurrect a quiet corridor at 1 px. A non-positive peak
 * (an empty path, or a signed matrix's negative direction) collapses the same
 * way, which also keeps `Math.pow` off its NaN branch for fractional exponents.
 */
export function strokeWidthFromPeak(
  peak: number,
  opts: FlowStrokeWidthOptions = {},
): number {
  const minFlow = opts.minFlow ?? 0;
  if (!(peak > minFlow) || peak <= 0) return 0;
  const width =
    Math.pow(peak, opts.widthExponent ?? DEFAULT_WIDTH_EXPONENT) *
    (opts.widthScale ?? 1);
  const lo = opts.minWidthPx ?? 0;
  const hi = opts.maxWidthPx ?? Number.MAX_SAFE_INTEGER;
  if (width < lo) return lo;
  if (width > hi) return hi;
  return width;
}

/**
 * Per-PATH widths at a (stepped) bucket position. `out` is reused across
 * sub-steps so a playhead move allocates nothing.
 */
export function computePathWidths(
  paths: FlowStrokePaths,
  bucketPos: number,
  opts: FlowStrokeWidthOptions = {},
  out?: Float32Array,
): Float32Array {
  const widths =
    out && out.length >= paths.pathCount
      ? out
      : new Float32Array(paths.pathCount);
  const blend = bucketBlendAt(bucketPos, paths.numBuckets);
  for (let p = 0; p < paths.pathCount; p++) {
    widths[p] = strokeWidthFromPeak(pathPeakAt(paths, p, blend), opts);
  }
  return widths;
}

/**
 * Broadcast per-path widths onto the merged SEGMENT instances — this is what
 * makes the width UNIFORM ALONG a path (deck's `PathLayer` semantics), unlike
 * the parent corridor's per-endpoint, value-driven taper.
 */
export function expandPathWidths(
  paths: FlowStrokePaths,
  pathWidths: ArrayLike<number>,
  out?: Float32Array,
): Float32Array {
  const widths =
    out && out.length >= paths.segmentCount
      ? out
      : new Float32Array(paths.segmentCount);
  const { segmentPath, segmentCount } = paths;
  for (let s = 0; s < segmentCount; s++) widths[s] = pathWidths[segmentPath[s]];
  return widths;
}

/**
 * The sub-step GATE: the quantized index of a continuous bucket position.
 * Mirrors deck's `gradientStyleSuffix` (`Math.round(pos / STEP)`), the gate its
 * inherited per-vertex colour re-expansion fires on. In THIS backend the colour
 * blend is continuous on the GPU, so the gate is not a colour/width sync
 * requirement — it is what bounds the width's per-frame CPU cost.
 */
export function flowStrokeSubStep(
  bucketPos: number,
  step: number = FLOW_STROKE_SUB_STEP,
): number {
  if (!(step > 0)) return 0;
  return Math.round(bucketPos / step);
}

/** The bucket position a sub-step index stands for (deck's `stepped`). */
export function steppedBucketPos(
  subStep: number,
  step: number = FLOW_STROKE_SUB_STEP,
): number {
  return subStep * step;
}
