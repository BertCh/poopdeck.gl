// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Shared `vertexValueMatrix` two-bucket blend.
 *
 * A flow tile stores its geometry once and animates through a per-row ×
 * per-time-bucket value matrix (`BinaryFeatures.vertexValueMatrix`,
 * `vertexValueBuckets` columns, flattened row-major). The playhead maps to a
 * continuous (quantized/"stepped") bucket position; the animated scalar is the
 * linear blend of the two adjacent bucket columns.
 *
 * One implementation for every consumer — FlowCorridorLayer's per-vertex
 * gradient (FlowStrokeLayer inherits it), FlowmapLayer's and
 * BundledFlowmapLayer's per-edge widths — so the blend cannot drift between
 * them. (BundledFlowLinesLayer's GLSL re-derives the same blend on the GPU.)
 */

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
 * Resolve the bucket columns to blend for a continuous position `stepped`
 * (already clamped to `[0, numBuckets - 1]` and quantized by the caller's
 * sub-step). At the last column `b1 === b0`, so the blend degenerates to a
 * plain read.
 */
export function bucketBlendAt(
  stepped: number,
  numBuckets: number,
): BucketBlend {
  const b0 = Math.floor(stepped);
  const b1 = Math.min(b0 + 1, numBuckets - 1);
  return { b0, b1, f: stepped - b0 };
}

/**
 * Blend one matrix row's two adjacent bucket columns into a scalar.
 * `rowBase` is the row's flattened start index (`row * numBuckets`).
 * `absolute` blends `|value|` — for SIGNED matrices where the sign carries
 * direction, magnitude must not dip through zero at a direction flip.
 */
export function blendMatrixRow(
  matrix: ArrayLike<number>,
  rowBase: number,
  blend: BucketBlend,
  absolute = false,
): number {
  const { b0, b1, f } = blend;
  if (f <= 0) {
    const m = matrix[rowBase + b0];
    return absolute ? Math.abs(m) : m;
  }
  const g = 1 - f;
  const m0 = matrix[rowBase + b0];
  const m1 = matrix[rowBase + b1];
  return absolute ? Math.abs(m0) * g + Math.abs(m1) * f : m0 * g + m1 * f;
}

/**
 * Max of the piecewise-linear bucket signal over a TRAILING window `[lo, hi]`
 * of continuous bucket positions (caller-clamped to `[0, numBuckets - 1]`,
 * `hi` = the playhead's stepped position). A piecewise-linear function attains
 * its max at a window endpoint or at an interior sample, so this evaluates the
 * blend at `lo` and `hi` and every whole bucket between — the value rises over
 * one bucket as a peak enters at `hi`, HOLDS for the window span, then fades
 * over one bucket as it slides out past `lo`. `absolute` mirrors
 * {@link blendMatrixRow} (signed matrices: magnitude is the value).
 */
export function trailingMaxMatrixRow(
  matrix: ArrayLike<number>,
  rowBase: number,
  numBuckets: number,
  lo: number,
  hi: number,
  absolute = false,
): number {
  let best = blendMatrixRow(
    matrix,
    rowBase,
    bucketBlendAt(hi, numBuckets),
    absolute,
  );
  if (lo < hi) {
    const atLo = blendMatrixRow(
      matrix,
      rowBase,
      bucketBlendAt(lo, numBuckets),
      absolute,
    );
    if (atLo > best) best = atLo;
    const bEnd = Math.floor(hi);
    for (let b = Math.ceil(lo); b <= bEnd; b++) {
      const m = matrix[rowBase + b];
      const val = absolute ? Math.abs(m) : m;
      if (val > best) best = val;
    }
  }
  return best;
}
