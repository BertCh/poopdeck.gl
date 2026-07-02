// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free, WebGPU-free) resolution half of the point-cloud pick path:
 * a decoded merged-instance index → an {@link SttPickResult}. The GPU id-buffer
 * render + readback (needs a live device) lives in the layer / `GpuPicker`; this
 * module joins the resolved index back to columns and geographic coordinates, so
 * it is the unit-tested seam of §5.3's merged-buffer picking.
 *
 * The flow: `provenance.resolve(mergedIndex)` → `(tileKey, featureIndex)` →
 * `binaryByTileKey.get(tileKey)` → `getFeatureProperties(binary, featureIndex)`.
 */

import type { BinaryFeatures, TileId } from '@poopdeck.gl/core';
import { getFeatureProperties } from '@poopdeck.gl/core';
import type { InstanceProvenance, SttPickResult } from '@poopdeck.gl/core/picking';

/**
 * Parse a `z/x/y/t::layer` {@link import('../layers/point-buffers.js').pointTileKey}
 * back into its {@link TileId}, or `undefined` if the shape is unexpected (so a
 * malformed key never fabricates a bogus tile).
 */
export function parsePointTileKey(tileKey: string): TileId | undefined {
  const sep = tileKey.indexOf('::');
  const coords = sep >= 0 ? tileKey.slice(0, sep) : tileKey;
  const p = coords.split('/');
  if (p.length !== 4) return undefined;
  const [z, x, y, t] = p.map(Number);
  if (![z, x, y, t].every((n) => Number.isFinite(n))) return undefined;
  return { z, x, y, t };
}

export interface ResolvePointPickParams {
  /** Merged instance index (as decoded from the GPU id buffer). */
  index: number;
  /** The merged layer's per-instance provenance (from `buildPointBuffers`). */
  provenance: InstanceProvenance;
  /** `tileKey` → source `BinaryFeatures` (from `buildPointBuffers`). */
  binaryByTileKey: Map<string, BinaryFeatures>;
  /** The STT layer id surfaced on the result. */
  layerId: string;
  /** Optional screen `[cssX, cssY]` to echo back on the result. */
  screen?: [number, number];
}

/**
 * Resolve a merged instance index to a normalized {@link SttPickResult}, or
 * `null` for a miss (out-of-range index, unknown tileKey, or stale feature
 * index). `result.index` is the FEATURE index within its `(tile, layer)` —
 * matching the `SttPickResult.index` contract — not the merged index.
 */
export function resolvePointPick(params: ResolvePointPickParams): SttPickResult | null {
  const { index, provenance, binaryByTileKey, layerId, screen } = params;
  const entry = provenance.resolve(index);
  if (!entry) return null;
  const binary = binaryByTileKey.get(entry.tileKey);
  if (!binary) return null;
  const object = getFeatureProperties(binary, entry.featureIndex);
  if (!object) return null;

  const dims = binary.positionDimensions ?? 2;
  const lon = binary.positions[entry.featureIndex * dims];
  const lat = binary.positions[entry.featureIndex * dims + 1];

  const result: SttPickResult = {
    object,
    index: entry.featureIndex,
    layerId,
    coordinate: [lon, lat],
  };
  const tileId = parsePointTileKey(entry.tileKey);
  if (tileId) result.tileId = tileId;
  if (screen) result.screen = screen;
  return result;
}
