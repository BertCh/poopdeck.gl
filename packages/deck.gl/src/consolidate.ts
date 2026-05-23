/**
 * Pure tile-consolidation helpers.
 *
 * These functions merge the binary features of multiple tiles into a single
 * set of typed arrays for one deck.gl draw call. They are deliberately pure
 * (no `this`, no deck.gl dependency) so the consolidation logic - array
 * lengths, offsets, and the float32 time-relativization scheme - can be unit
 * tested without a GPU or a real layer instance.
 *
 * TIME-RELATIVIZATION SCHEME (float32-precision fix):
 * - Each binary tile carries times RELATIVE to its own `timeOffset`.
 * - A consolidated layer picks ONE reference offset (the first tile's
 *   `timeOffset`) and rebases every tile's times onto it via
 *   `(tile.timeOffset - layerTimeOffset)`.
 * - The resulting attribute values stay small (relative), so they fit
 *   exactly in a Float32Array. `TimeFilterExtension` subtracts the SAME
 *   `timeOffset` from the current-time uniform.
 */

import type { Tile } from '@stt/core';

/** A point tile-set consolidated into single typed arrays. */
export interface ConsolidatedPoints {
  length: number;
  /** Reference offset; all times below are relative to this. */
  timeOffset: number;
  dims: number;
  /**
   * Interleaved positions. `Float64Array` so deck.gl's fp64 position
   * attribute keeps full lon/lat precision — a Float32Array binary buffer
   * leaves the 64-bit-low component unset and renders garbage coordinates.
   */
  positions: Float64Array;
  /** Per-feature start times, RELATIVE to timeOffset. */
  startTimes: Float32Array;
  /** Per-feature end times, RELATIVE to timeOffset. */
  endTimes: Float32Array;
}

/** A path/line tile-set consolidated into single typed arrays. */
export interface ConsolidatedPaths {
  length: number;
  timeOffset: number;
  dims: number;
  /** Interleaved positions; `Float64Array` for deck.gl's fp64 attribute. */
  positions: Float64Array;
  /** Length = featureCount + 1; last entry = total vertex count. */
  startIndices: Uint32Array;
  /** Per-feature start times, RELATIVE to timeOffset. */
  startTimes: Float32Array;
  /** Per-feature end times, RELATIVE to timeOffset. */
  endTimes: Float32Array;
}

/**
 * Pick the layer-wide reference time offset: the first tile/layer's offset.
 */
export function pickLayerTimeOffset(tiles: Tile[]): number {
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      return layer.features.timeOffset;
    }
  }
  return 0;
}

/**
 * Consolidate point tiles into single typed arrays.
 * Times are kept relative to the layer-wide offset (float32-safe).
 */
export function consolidatePoints(tiles: Tile[]): ConsolidatedPoints | null {
  let totalFeatures = 0;
  // deck.gl's ScatterplotLayer registers `instancePositions` at size 3, so the
  // consolidated position buffer is always 3-component (z padded to 0 for 2D
  // tiles) — a size-2 binary buffer would be read with the wrong stride.
  const dims = 3;

  for (const tile of tiles) {
    for (const layer of tile.layers) {
      totalFeatures += layer.features.featureCount;
    }
  }

  if (totalFeatures === 0) return null;

  const layerTimeOffset = pickLayerTimeOffset(tiles);
  const positions = new Float64Array(totalFeatures * dims);
  const startTimes = new Float32Array(totalFeatures);
  const endTimes = new Float32Array(totalFeatures);

  let offset = 0;
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      const binary = layer.features;
      const count = binary.featureCount;
      const srcDims = binary.positionDimensions ?? 2;
      const offsetDelta = binary.timeOffset - layerTimeOffset;

      for (let i = 0; i < count; i++) {
        const srcIdx = i * srcDims;
        const dstIdx = (offset + i) * dims;
        positions[dstIdx] = binary.positions[srcIdx];
        positions[dstIdx + 1] = binary.positions[srcIdx + 1];
        if (dims === 3) {
          positions[dstIdx + 2] = srcDims === 3 ? binary.positions[srcIdx + 2] : 0;
        }
      }

      for (let i = 0; i < count; i++) {
        startTimes[offset + i] = binary.startTimes[i] + offsetDelta;
        endTimes[offset + i] = binary.endTimes[i] + offsetDelta;
      }

      offset += count;
    }
  }

  return { length: totalFeatures, timeOffset: layerTimeOffset, dims, positions, startTimes, endTimes };
}

/**
 * Consolidate path/line tiles into single typed arrays.
 * Produces a contiguous startIndices array (offsets across tiles) and
 * relative per-feature times.
 */
export function consolidatePaths(tiles: Tile[]): ConsolidatedPaths | null {
  let totalFeatures = 0;
  let totalVertices = 0;
  let dims = 2;

  for (const tile of tiles) {
    for (const layer of tile.layers) {
      const binary = layer.features;
      if (binary.featureCount === 0 || !binary.startIndices) continue;
      totalFeatures += binary.featureCount;
      totalVertices += binary.startIndices[binary.featureCount];
      if (binary.positionDimensions && binary.positionDimensions > dims) {
        dims = binary.positionDimensions;
      }
    }
  }

  if (totalFeatures === 0 || totalVertices === 0) return null;

  const layerTimeOffset = pickLayerTimeOffset(tiles);
  const positions = new Float64Array(totalVertices * dims);
  const startTimes = new Float32Array(totalFeatures);
  const endTimes = new Float32Array(totalFeatures);
  const startIndices = new Uint32Array(totalFeatures + 1);

  let featureOffset = 0;
  let vertexOffset = 0;

  for (const tile of tiles) {
    for (const layer of tile.layers) {
      const binary = layer.features;
      if (binary.featureCount === 0 || !binary.startIndices) continue;

      const srcDims = binary.positionDimensions ?? 2;
      const offsetDelta = binary.timeOffset - layerTimeOffset;
      const srcStartIndices = binary.startIndices;
      const srcVertexCount = srcStartIndices[binary.featureCount];

      for (let i = 0; i < binary.featureCount; i++) {
        startIndices[featureOffset + i] = vertexOffset + srcStartIndices[i];
      }

      for (let v = 0; v < srcVertexCount; v++) {
        const srcIdx = v * srcDims;
        const dstIdx = (vertexOffset + v) * dims;
        positions[dstIdx] = binary.positions[srcIdx];
        positions[dstIdx + 1] = binary.positions[srcIdx + 1];
        if (dims === 3) {
          positions[dstIdx + 2] = srcDims === 3 ? binary.positions[srcIdx + 2] : 0;
        }
      }

      for (let i = 0; i < binary.featureCount; i++) {
        startTimes[featureOffset + i] = binary.startTimes[i] + offsetDelta;
        endTimes[featureOffset + i] = binary.endTimes[i] + offsetDelta;
      }

      featureOffset += binary.featureCount;
      vertexOffset += srcVertexCount;
    }
  }

  startIndices[totalFeatures] = totalVertices;

  return {
    length: totalFeatures,
    timeOffset: layerTimeOffset,
    dims,
    positions,
    startIndices,
    startTimes,
    endTimes,
  };
}
