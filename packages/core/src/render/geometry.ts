// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT geometry kernel — framework-free, backend-neutral geometry reductions the
 * renderers share. Phase 2 seeds it with the OD endpoint derivation (byte-
 * identical across the deck and three packages before this extraction); Phase 3
 * adds `tessellateFeature` (pre-baked-triangle-aware polygon tessellation) here.
 * See docs/roadmap/renderer-abstraction-2026-06.md.
 */

import earcut from 'earcut';
import type { BinaryFeatures } from '../types';

/** Dense source/target endpoint buffers derived from a tile's LineString features. */
export interface SourceTargetPositions {
  /** Interleaved source endpoints, `featureCount * dims` long (feature i's FIRST vertex). */
  source: Float64Array;
  /** Interleaved target endpoints, `featureCount * dims` long (feature i's LAST vertex). */
  target: Float64Array;
  /** Position dimensions (2 for [lon, lat], 3 for [lon, lat, alt]). */
  dims: number;
}

/**
 * Derive dense source (first-vertex) and target (last-vertex) endpoint buffers
 * for every feature in a LineString tile — the source→target representation the
 * OD flow layers (deck ArcLayer/LineLayer, three OD-line) need. STT stores OD
 * flows as LineString features (a run of vertices addressed by `startIndices`);
 * an arc/line has only two ends, so each feature collapses to its FIRST vertex
 * (source) and LAST vertex (target); intermediate vertices are dropped.
 *
 * Float64 output so deck's fp64 position attribute populates hi/lo correctly.
 * Requires `startIndices`; callers gate on `featureCount > 0 && startIndices`.
 * A single-vertex feature degenerates to source === target.
 */
export function deriveSourceTargetPositions(binary: BinaryFeatures): SourceTargetPositions {
  const dims = binary.positionDimensions ?? 2;
  const featureCount = binary.featureCount;
  const startIndices = binary.startIndices!;
  const positions = binary.positions;

  const source = new Float64Array(featureCount * dims);
  const target = new Float64Array(featureCount * dims);

  for (let i = 0; i < featureCount; i++) {
    // First vertex of feature i is the source; the last (one before the next
    // feature's start) is the target. startIndices has length featureCount + 1.
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

/**
 * Tessellate one polygon feature into GLOBAL triangle indices (into the tile's
 * `positions` vertices), the single dispatch every backend shares:
 *
 *  - When the tile carries pre-baked `triangles`/`triangleOffsets` (built with
 *    `--pre-tessellate`; the TS decoder already pre-shifts them to global
 *    indices) AND `preferPrebaked` (default), return that feature's slice — the
 *    holes-correct, multi-ring-correct path deck and three already use.
 *  - Otherwise fall back to earcutting the feature's SINGLE ring
 *    (`startIndices[f] … startIndices[f+1]`), matching maplibre's current
 *    fallback. (Multi-ring earcut needs a `holeIndices` field STT does not yet
 *    emit — the multi-ring case is handled by build-time baking above.)
 *
 * Returns `null` when the feature has no polygon geometry. Indices are `Uint32`
 * (a returned pre-baked `Uint32Array` is a zero-copy subarray view).
 */
export function tessellateFeature(
  binary: BinaryFeatures,
  featureIndex: number,
  opts: { preferPrebaked?: boolean } = {},
): Uint32Array | null {
  const preferPrebaked = opts.preferPrebaked !== false;
  if (preferPrebaked && binary.triangles && binary.triangleOffsets) {
    const start = binary.triangleOffsets[featureIndex];
    const end = binary.triangleOffsets[featureIndex + 1];
    return binary.triangles.subarray(start, end);
  }

  const startIndices = binary.startIndices;
  if (!startIndices) return null;
  const dims = binary.positionDimensions ?? 2;
  const vStart = startIndices[featureIndex];
  const vEnd = startIndices[featureIndex + 1];
  const ringLen = vEnd - vStart;
  if (ringLen < 3) return null;

  // Flat 2D coords for earcut (topology is unaffected by dropping z).
  const flat = new Float64Array(ringLen * 2);
  for (let i = 0; i < ringLen; i++) {
    flat[i * 2] = binary.positions[(vStart + i) * dims];
    flat[i * 2 + 1] = binary.positions[(vStart + i) * dims + 1];
  }
  const local = earcut(flat, undefined, 2);
  const out = new Uint32Array(local.length);
  for (let i = 0; i < local.length; i++) out[i] = local[i] + vStart; // local → global
  return out;
}
