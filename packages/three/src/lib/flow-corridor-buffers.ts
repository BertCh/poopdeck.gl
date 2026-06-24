// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of instanced **flow-corridor** segment buffers — a
 * static street/route network whose per-segment ridership is a TIME SERIES, not a
 * single scalar. The Three port of deck's `FlowCorridorLayer`.
 *
 * A flow-corridor tile stores its geometry ONCE and carries a per-vertex ×
 * per-time-bucket value matrix (`BinaryFeatures.vertexValueMatrix`, flattened
 * globally vertex-major: `matrix[globalVertex * vertexValueBuckets + bucket]`,
 * aligned 1:1 with `positions`). Each consecutive vertex pair becomes one wide-line
 * **segment** instance, exactly like {@link buildLineSegmentBuffers}.
 *
 * The win over deck: instead of re-expanding the active-bucket per-vertex colour on
 * the CPU every sub-step, we emit the WHOLE value matrix as a flat texture payload
 * (`valueMatrix`, RG = endpoint-A / endpoint-B value, `numBuckets` columns ×
 * `count` rows). The material samples it with a single linear-filtered fetch at the
 * fractional playhead bucket position, so the two-bucket lerp happens on the GPU
 * for free and NOTHING re-uploads as the playhead advances — only a uniform moves.
 *
 * **RTC**: positions are written f32 RELATIVE to a per-build `origin` (the first
 * projected vertex); the layer sets `object.position = origin`. For the ENU/AV
 * frame the origin is tiny and this is a no-op.
 *
 * The per-segment value range animates width + ramp colour, so unlike the static
 * wide-line builder there is no per-feature colour here: colour/width are computed
 * in the material from the sampled instantaneous value.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu';

export interface FlowCorridorBufferOptions {
  /** Constant height lift (metres) — keeps ground decals off the basemap. @default 0 */
  zLift?: number;
}

/** Global bucket axis shared by every flow corridor (all span the whole range). */
export interface BucketAxis {
  /** Number of time buckets in the matrix. */
  numBuckets: number;
  /** Absolute epoch-ms of bucket 0's centre/start. */
  bucket0Abs: number;
  /** Width of one bucket in ms. */
  bucketWidth: number;
}

export interface FlowCorridorBuffers {
  /** Segment-instance count. */
  count: number;
  /** Time buckets per segment row in {@link valueMatrix}. */
  numBuckets: number;
  posA: Float32Array; // vec3, RTC-local
  posB: Float32Array; // vec3, RTC-local
  /** Normalised row coordinate per instance: `(seg + 0.5) / count`, for the texture v. */
  rowV: Float32Array; // float
  /**
   * The per-segment value time series, row-major: `valueMatrix` packs `count`
   * rows of `numBuckets` columns, 2 channels (RG) per texel — R = endpoint-A
   * value, G = endpoint-B value. Layout: `[(seg*numBuckets + bucket)*2 + ch]`.
   * Upload as a `width=numBuckets`, `height=count`, RG-float `DataTexture`.
   */
  valueMatrix: Float32Array;
  /** Per-segment window times (relative to timeOrigin) — every corridor is timeless. */
  starts: Float32Array; // float
  ends: Float32Array; // float
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Global bucket axis (null when no matrix tile was seen). */
  axis: BucketAxis | null;
}

/** A tile layer that actually carries a usable flow matrix. */
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

function collectFlowLayers(tiles: Tile[]): { layers: BinaryFeatures[]; segCount: number; numBuckets: number } {
  const layers: BinaryFeatures[] = [];
  let segCount = 0;
  let numBuckets = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!isFlowLayer(b)) continue;
      const nb = b.vertexValueBuckets ?? 0;
      // All flow tiles share one global bucket axis; ignore any mismatching tile
      // (defensive — the dataset bakes a single bucket count).
      if (numBuckets === 0) numBuckets = nb;
      else if (nb !== numBuckets) continue;
      layers.push(b);
      for (let f = 0; f < b.featureCount; f++) {
        segCount += Math.max(0, b.startIndices![f + 1] - b.startIndices![f] - 1);
      }
    }
  }
  return { layers, segCount, numBuckets };
}

/** Derive the global bucket axis from a flow layer's feature-0 [start,end]. */
function axisFor(b: BinaryFeatures): BucketAxis | null {
  const nb = b.vertexValueBuckets ?? 0;
  if (nb <= 0 || !b.startTimes || b.startTimes.length === 0 || !b.endTimes) return null;
  const rel0 = b.startTimes[0];
  const span = b.endTimes[0] - rel0;
  if (span <= 0) return null;
  return { numBuckets: nb, bucket0Abs: b.timeOffset + rel0, bucketWidth: span / nb };
}

export function buildFlowCorridorBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: FlowCorridorBufferOptions = {},
): FlowCorridorBuffers {
  const { layers, segCount, numBuckets } = collectFlowLayers(tiles);

  const empty = (): FlowCorridorBuffers => ({
    count: 0,
    numBuckets: 0,
    posA: new Float32Array(0),
    posB: new Float32Array(0),
    rowV: new Float32Array(0),
    valueMatrix: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
    axis: null,
  });
  if (segCount === 0 || numBuckets === 0) return empty();

  const zLift = opts.zLift ?? 0;
  const axis = axisFor(layers[0]);

  // RTC origin = first vertex of the first feature, projected (absolute world).
  const first = layers[0];
  const fdims = first.positionDimensions ?? 2;
  const origin = projection.project(first.positions[0], first.positions[1], zLift);

  const posA = new Float32Array(segCount * 3);
  const posB = new Float32Array(segCount * 3);
  const rowV = new Float32Array(segCount);
  // RG per texel: R = endpoint-A value, G = endpoint-B value.
  const valueMatrix = new Float32Array(segCount * numBuckets * 2);
  const starts = new Float32Array(segCount);
  const ends = new Float32Array(segCount);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  let s = 0; // segment index
  for (const b of layers) {
    const dims = b.positionDimensions ?? fdims;
    const nb = b.vertexValueBuckets ?? 0;
    const matrix = b.vertexValueMatrix!;
    const rebase = b.timeOffset - timeOrigin;
    for (let f = 0; f < b.featureCount; f++) {
      const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      const v0 = b.startIndices![f];
      const v1 = b.startIndices![f + 1];
      for (let v = v0; v < v1 - 1; v++) {
        const z0 = (dims > 2 ? b.positions[v * dims + 2] : 0) + zLift;
        const z1 = (dims > 2 ? b.positions[(v + 1) * dims + 2] : 0) + zLift;
        const a = projection.project(b.positions[v * dims], b.positions[v * dims + 1], z0);
        const c = projection.project(b.positions[(v + 1) * dims], b.positions[(v + 1) * dims + 1], z1);
        const ax = a[0] - origin[0], ay = a[1] - origin[1], az = a[2] - origin[2];
        const bx = c[0] - origin[0], by = c[1] - origin[1], bz = c[2] - origin[2];
        posA[s * 3] = ax; posA[s * 3 + 1] = ay; posA[s * 3 + 2] = az;
        posB[s * 3] = bx; posB[s * 3 + 1] = by; posB[s * 3 + 2] = bz;
        starts[s] = start; ends[s] = end;
        rowV[s] = (s + 0.5) / segCount;

        // Copy the two endpoint vertices' bucket columns into this segment's row.
        // The matrix is globally vertex-major aligned with `positions`, so vertex
        // `v` / `v+1` map directly to rows `v*nb` / `(v+1)*nb`.
        const baseA = v * nb;
        const baseB = (v + 1) * nb;
        const rowBase = s * numBuckets * 2;
        for (let bk = 0; bk < numBuckets; bk++) {
          valueMatrix[rowBase + bk * 2] = matrix[baseA + bk];
          valueMatrix[rowBase + bk * 2 + 1] = matrix[baseB + bk];
        }

        for (const [x, y, zz] of [[ax, ay, az], [bx, by, bz]] as const) {
          if (x < minX) minX = x; if (y < minY) minY = y; if (zz < minZ) minZ = zz;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (zz > maxZ) maxZ = zz;
        }
        s++;
      }
    }
  }

  return {
    count: segCount,
    numBuckets,
    posA, posB, rowV, valueMatrix, starts, ends,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    axis,
  };
}

/**
 * Continuous bucket position in `[0, numBuckets - 1]` for an absolute time.
 * Mirrors deck `FlowCorridorLayer.posFromBinary`, clamped to the axis ends. The
 * material samples the value texture at `(pos + 0.5) / numBuckets` so its linear
 * filtering performs the two-bucket lerp on the GPU.
 */
export function bucketPosFromTime(axis: BucketAxis, absoluteTimeMs: number): number {
  if (axis.numBuckets <= 0 || axis.bucketWidth <= 0) return 0;
  let pos = (absoluteTimeMs - axis.bucket0Abs) / axis.bucketWidth;
  if (pos < 0) pos = 0;
  const max = axis.numBuckets - 1;
  if (pos > max) pos = max;
  return pos;
}
