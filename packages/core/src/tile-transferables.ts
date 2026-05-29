// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

/**
 * Collect every transferable ArrayBuffer in a decoded tile.
 *
 * Lives in its own module so it can be imported by both the worker entry
 * (`tile-decoder.worker.ts`, which side-effectfully wires up `ctx.onmessage`
 * and therefore can't be imported by Node tests) and by unit tests that want
 * to assert the transferables list for a synthetic tile.
 *
 * Several typed arrays (notably positions for points) are subarrays into the
 * decoded Arrow IPC buffer, so multiple views can share one underlying
 * buffer. `postMessage` rejects duplicate transfers, so we deduplicate.
 *
 * Defensive: skip any field whose value is not a real typed array. A
 * malformed property column (e.g. a Boolean / nested-list column that
 * slipped past the numeric branch of `tableToBinaryFeatures`) would
 * otherwise crash the worker with a cryptic `Cannot read properties of
 * undefined (reading 'buffer')` and the surfaced error would not point at
 * the offending column. Skipping such entries keeps the rest of the tile
 * transferable; the tile is still structured-cloned (with a one-time copy)
 * which is correct, just a little slower than the zero-copy transfer.
 */

import type { Tile } from './types';

export function collectTransferables(tile: Tile): Transferable[] {
  // TypedArray.buffer is typed as ArrayBufferLike (could be SharedArrayBuffer
  // in newer TS lib defs); we only construct regular ArrayBuffer-backed
  // typed arrays so the runtime values are always plain ArrayBuffers.
  const seen = new Set<ArrayBufferLike>();
  const addBuffer = (v: ArrayBufferView | undefined | null): void => {
    // `ArrayBuffer.isView` is the cheapest "is this a real typed-array /
    // DataView" check. It returns false for `undefined`, `null`, plain
    // arrays, and objects that happen to carry a `.buffer` property — all
    // of which would otherwise either throw on `.buffer` or pass a bogus
    // value to `postMessage`'s transferables list.
    if (v && ArrayBuffer.isView(v)) seen.add(v.buffer);
  };
  if (!tile || !Array.isArray(tile.layers)) return [];
  for (const layer of tile.layers) {
    const f = layer?.features;
    if (!f) continue;
    addBuffer(f.positions);
    addBuffer(f.featureIds);
    addBuffer(f.startTimes);
    addBuffer(f.endTimes);
    addBuffer(f.startIndices);
    addBuffer(f.vertexTimestamps);
    addBuffer(f.globalFeatureIds);
    if (f.numericProps) {
      for (const arr of Object.values(f.numericProps)) addBuffer(arr);
    }
    if (f.categoricalProps) {
      for (const entry of Object.values(f.categoricalProps)) {
        // The category-index column is the only transferable piece; the
        // category-string table travels via structured clone (small and
        // shared across tiles).
        if (entry) addBuffer(entry.indices);
      }
    }
  }
  return Array.from(seen) as Transferable[];
}
