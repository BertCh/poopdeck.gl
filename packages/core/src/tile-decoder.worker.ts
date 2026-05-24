/**
 * Worker entry for off-main-thread tile decoding.
 *
 * The main thread sends a compressed tile payload via {@link DecodeRequest}
 * and receives a fully-decoded {@link Tile} in {@link DecodeResponse}. The
 * tile's underlying typed-array buffers are transferred back so the main
 * thread can hand them straight to deck.gl as binary GPU attributes — no
 * copy on either boundary (the only copy is the small slice() that the
 * main side does before transferring the compressed bytes to keep its byte
 * cache intact).
 *
 * The decompress + Arrow IPC parse + binary-feature extraction all run
 * inside the worker, freeing the main thread to drive the rAF loop.
 */

/// <reference lib="webworker" />

import { decompress } from './compression';
import { decodeTile } from './tile';
import type { Compression, Tile, TileId, TimeRange } from './types';

interface DecodeRequest {
  requestId: number;
  id: TileId;
  timeRange: TimeRange;
  compressed: ArrayBuffer;
  compression: Compression;
}

type DecodeResponse =
  | { requestId: number; tile: Tile }
  | { requestId: number; error: string };

/**
 * Collect every transferable ArrayBuffer in a Tile.
 *
 * Several typed arrays (notably positions for points) are subarrays into the
 * decoded Arrow IPC buffer, so multiple views can share one underlying
 * buffer. Postmessage rejects duplicate transfers, so we deduplicate.
 */
function collectTransferables(tile: Tile): Transferable[] {
  // TypedArray.buffer is typed as ArrayBufferLike (could be SharedArrayBuffer
  // in newer TS lib defs); we only construct regular ArrayBuffer-backed
  // typed arrays so the runtime values are always plain ArrayBuffers.
  const seen = new Set<ArrayBufferLike>();
  for (const layer of tile.layers) {
    const f = layer.features;
    seen.add(f.positions.buffer);
    seen.add(f.featureIds.buffer);
    seen.add(f.startTimes.buffer);
    seen.add(f.endTimes.buffer);
    if (f.startIndices) seen.add(f.startIndices.buffer);
    if (f.vertexTimestamps) seen.add(f.vertexTimestamps.buffer);
    if (f.globalFeatureIds) seen.add(f.globalFeatureIds.buffer);
    for (const arr of Object.values(f.numericProps)) seen.add(arr.buffer);
    for (const { indices } of Object.values(f.categoricalProps)) {
      seen.add(indices.buffer);
    }
  }
  return Array.from(seen) as Transferable[];
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { requestId, id, timeRange, compressed, compression } = event.data;
  try {
    const payload = await decompress(new Uint8Array(compressed), compression);
    const tile = decodeTile(payload, id, timeRange);
    // The `arrowTable` field carries an apache-arrow `Table` instance. That
    // class has methods on its prototype and is NOT structured-cloneable —
    // postMessage would throw. Strip it before transfer. Callers that need
    // a GeoArrow `Table` should use the inline decoder
    // ({@link InlineTileDecoder}), which preserves `arrowTable` end-to-end.
    for (const layer of tile.layers) delete layer.arrowTable;
    const transferables = collectTransferables(tile);
    const response: DecodeResponse = { requestId, tile };
    ctx.postMessage(response, transferables);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const response: DecodeResponse = { requestId, error: message };
    ctx.postMessage(response);
  }
};
