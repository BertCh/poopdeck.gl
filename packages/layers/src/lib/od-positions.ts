// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Origin→destination (source/target) position derivation shared by the OD flow
 * layers (AnimatedArcLayer, AnimatedLineLayer).
 *
 * The OD layers render deck.gl's `ArcLayer` / `LineLayer`, which are INSTANCED
 * source→target layers: one instance per feature, with a `getSourcePosition`
 * and a `getTargetPosition` accessor (binary attribute names
 * `instanceSourcePositions` / `instanceTargetPositions`). STT tiles, however,
 * store OD flows as LineString features — a feature is a run of vertices in the
 * tile's interleaved `positions` buffer, addressed by `startIndices`.
 *
 * This helper bridges the two representations WITHOUT a per-feature object: it
 * walks `startIndices` once and copies each feature's FIRST vertex into a dense
 * `source` buffer and its LAST vertex into a dense `target` buffer — both
 * `featureCount * dims` long. A 2-vertex-per-feature tile (the common OD case)
 * yields source = vertex 0, target = vertex 1; a multi-vertex polyline collapses
 * to its endpoints (intermediate vertices are dropped — an arc/line only has two
 * ends). The result is two Float64Arrays so deck.gl's fp64 position attribute
 * populates the hi/lo split correctly (a Float32 buffer would leave the low half
 * zero and jitter coordinates at high zoom).
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';

/** Dense source/target endpoint buffers derived from a tile's LineString features. */
export interface SourceTargetPositions {
  /** Interleaved source endpoints, `featureCount * dims` long (feature i's FIRST vertex). */
  source: Float64Array;
  /** Interleaved target endpoints, `featureCount * dims` long (feature i's LAST vertex). */
  target: Float64Array;
  /** Position dimensions (2 for [lon, lat], 3 for [lon, lat, alt]) — drives `positionFormat`. */
  dims: number;
}

/**
 * Derive dense source (first-vertex) and target (last-vertex) endpoint buffers
 * for every feature in a LineString tile, suitable for ArcLayer / LineLayer's
 * `instanceSourcePositions` / `instanceTargetPositions` binary attributes.
 *
 * Allocated once per (tile, prepare) — not per frame; the OD layers cache the
 * result on their PreparedTile. Requires `startIndices` (LineString geometry);
 * callers gate on `binary.featureCount > 0 && binary.startIndices` before
 * invoking. A feature with a single vertex degenerates to source === target
 * (the arc/line has zero length there).
 */
export function deriveSourceTargetPositions(
  binary: BinaryFeatures,
): SourceTargetPositions {
  const dims = binary.positionDimensions ?? 2;
  const featureCount = binary.featureCount;
  const startIndices = binary.startIndices!;
  const positions = binary.positions;

  const source = new Float64Array(featureCount * dims);
  const target = new Float64Array(featureCount * dims);

  for (let i = 0; i < featureCount; i++) {
    // First vertex of feature i is the source; the last (one before the next
    // feature's start) is the target. startIndices has length featureCount + 1,
    // so startIndices[i + 1] is always in range.
    const srcVertex = startIndices[i];
    const tgtVertex = startIndices[i + 1] - 1;
    const srcBase = srcVertex * dims;
    const tgtBase = tgtVertex * dims;
    const outBase = i * dims;
    for (let d = 0; d < dims; d++) {
      source[outBase + d] = positions[srcBase + d];
      target[outBase + d] = positions[tgtBase + d];
    }
  }

  return { source, target, dims };
}
