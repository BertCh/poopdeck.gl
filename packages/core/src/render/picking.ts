// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT picking kernel — the framework-free pieces every backend's hit-testing
 * shares: the normalized pick-result shape, the 24-bit id-colour packing (so any
 * id-buffer backend is interoperable), and the per-instance provenance contract a
 * MERGED-buffer backend (three) needs to answer "which feature is instance N?"
 * (see docs/roadmap/renderer-abstraction-2026-06.md §5.3). The GPU render/readback
 * (three's `GpuPicker`) and the CPU ray-OBB test stay per-backend; join a decoded
 * index back to columns via `getFeatureProperties(binary, index)` from
 * `@poopdeck.gl/core`.
 */

import type { TileId } from '../types.js';

/** Max feature index representable in 24 bits (inclusive). */
export const MAX_PICK_ID = 0xffffff; // 16,777,215

/**
 * Encode a non-negative 24-bit index into an `[r, g, b]` byte triple, big-endian
 * (r = most-significant byte). Throws on out-of-range so a wrapped id can't
 * masquerade as a different feature. (Named `encodeId` in the three package.)
 */
export function encodePickId(index: number): [number, number, number] {
  if (!Number.isInteger(index) || index < 0 || index > MAX_PICK_ID) {
    throw new RangeError(
      `encodePickId: index ${index} out of 24-bit range [0, ${MAX_PICK_ID}]`,
    );
  }
  return [(index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff];
}

/** Decode an `[r, g, b]` byte triple back into the index. Inverse of {@link encodePickId}. */
export function decodePickId(rgb: readonly [number, number, number]): number {
  return (
    (((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff)) >>> 0
  );
}

/**
 * Build a per-feature id-colour attribute (one normalised RGB triple per feature),
 * ready to upload as an instanced attribute an id material passes through opaque.
 */
export function buildIdColors(featureCount: number): Float32Array {
  const out = new Float32Array(featureCount * 3);
  for (let i = 0; i < featureCount; i++) {
    const [r, g, b] = encodePickId(i);
    out[i * 3] = r / 255;
    out[i * 3 + 1] = g / 255;
    out[i * 3 + 2] = b / 255;
  }
  return out;
}

/**
 * The normalized pick result every backend returns to a caller. `index` joins to
 * columns via `getFeatureProperties(binary, index)`; `coordinate` is geographic
 * `[lng, lat]` (backends in a local/ENU frame convert on the way out).
 */
export interface SttPickResult {
  /** Decoded feature properties, or null when only a world point is known. */
  object: Record<string, unknown> | null;
  /** Feature index within its (tile, layer) `BinaryFeatures`, or -1 if unresolved. */
  index: number;
  /** The picked tile, when known. */
  tileId?: TileId;
  /** The STT layer name the feature came from. */
  layerId: string;
  /** Geographic `[lng, lat]` of the pick. */
  coordinate?: [number, number];
  /** Screen `[cssX, cssY]` of the pick. */
  screen?: [number, number];
  /** World-space `[x, y, z]` (renderer frame) of the pick. */
  worldPoint?: [number, number, number];
  /** Backend/domain-specific extras (e.g. AV trackId, speed). */
  meta?: Record<string, unknown>;
}

/**
 * Per-merged-instance provenance: for a backend that merges all tiles into ONE
 * buffer (three), instance `i` maps back to a specific `(tile, layer, feature)`.
 * The merge builders populate this in the SAME order they emit instances, so a
 * decoded pick index resolves to `getFeatureProperties(entry.binary, entry.featureIndex)`.
 */
export interface InstanceProvenanceEntry {
  /** Stable tile key `z/x/y/t::layer` for the source (tile, layer). */
  tileKey: string;
  /** Feature index within that (tile, layer)'s `BinaryFeatures`. */
  featureIndex: number;
}

/**
 * Accumulates {@link InstanceProvenanceEntry} while a merged-buffer builder emits
 * instances, then answers merged-index → provenance. Framework-free; the three
 * buffer builders push one entry per emitted instance in draw order.
 */
export class InstanceProvenance {
  private readonly entries: InstanceProvenanceEntry[] = [];

  /** Record the source of the next emitted instance. */
  push(tileKey: string, featureIndex: number): void {
    this.entries.push({ tileKey, featureIndex });
  }

  /** Number of recorded instances (should equal the merged instance count). */
  get length(): number {
    return this.entries.length;
  }

  /** Resolve a merged instance index to its source, or null if out of range. */
  resolve(instanceIndex: number): InstanceProvenanceEntry | null {
    return this.entries[instanceIndex] ?? null;
  }
}
