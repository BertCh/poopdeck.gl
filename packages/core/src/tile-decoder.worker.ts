// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

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
import { collectTransferables } from './tile-transferables';
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
    // Tag the error with the tile id so the main thread's `[STL] Tile error`
    // log identifies the offending tile without a separate debug pass.
    const base = err instanceof Error ? err.message : String(err);
    const tileKey = `${id.z}/${id.x}/${id.y}/${id.t}`;
    const message = `tile ${tileKey}: ${base}`;
    const response: DecodeResponse = { requestId, error: message };
    ctx.postMessage(response);
  }
};
