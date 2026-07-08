// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

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

import type { BinaryFeatures, Tile } from './types.js';

/**
 * Visit every typed-array view held by a {@link BinaryFeatures} — THE single
 * enumeration of buffer-bearing fields, shared by `collectTransferables`
 * (worker transfer list) and `estimateTileSize` (cache byte accounting) so
 * the two can never drift when a new column lands (this diff's own history:
 * `estimateTileSize` had silently fallen behind on `vertexValueMatrix` /
 * `vectorProps` before they were re-synced). Layer-level extras (`arrowIpc`,
 * `arrowIpcProps`) are NOT features fields — callers that want them add them
 * themselves.
 *
 * Defensive: skips any field whose value is not a real typed array (see the
 * module doc); the callback only ever receives genuine `ArrayBufferView`s.
 */
export function forEachBufferView(
  features: BinaryFeatures,
  cb: (view: ArrayBufferView) => void,
): void {
  const visit = (v: ArrayBufferView | undefined | null): void => {
    if (v && ArrayBuffer.isView(v)) cb(v);
  };
  visit(features.positions);
  visit(features.featureIds);
  visit(features.startTimes);
  visit(features.endTimes);
  visit(features.startIndices);
  visit(features.vertexTimestamps);
  visit(features.vertexValues);
  visit(features.vertexValueMatrix);
  visit(features.globalFeatureIds);
  visit(features.triangles);
  visit(features.triangleOffsets);
  visit(features.featureIds64);
  if (features.numericProps) {
    for (const arr of Object.values(features.numericProps)) visit(arr);
  }
  if (features.vectorProps) {
    for (const entry of Object.values(features.vectorProps)) {
      if (entry) visit(entry.value);
    }
  }
  if (features.categoricalProps) {
    for (const entry of Object.values(features.categoricalProps)) {
      // The category-index column is the only buffer-bearing piece; the
      // category-string table is plain JS strings.
      if (entry) visit(entry.indices);
    }
  }
}

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
    // Raw per-layer Arrow IPC bytes (the GeoArrow hand-off; rehydrated
    // lazily by `toGeoArrowTable()` on the main thread). Usually a view
    // into the decoded payload buffer, which the dedup set collapses with
    // any column views sharing it. `arrowIpcProps` is the v2 spliced-props
    // sibling (template + PROPS tail) — same treatment, or it silently
    // structured-clone-copies across the worker boundary.
    addBuffer(layer?.arrowIpc);
    addBuffer(layer?.arrowIpcProps);
    const f = layer?.features;
    if (!f) continue;
    // Every BinaryFeatures buffer field, via the shared enumeration —
    // omitting one silently structured-CLONE-copies that buffer across the
    // worker boundary (the biggest ones live here: triangles, featureIds64,
    // vertexValueMatrix, vectorProps).
    forEachBufferView(f, addBuffer);
  }
  return Array.from(seen) as Transferable[];
}
