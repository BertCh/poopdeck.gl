// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

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

import { decompress } from './compression.js';
import { decodeTile, type TemplateRegistry } from './tile.js';
import { verifyCrc32c } from './crc32c.js';
import { collectTransferables } from './tile-transferables.js';
import type { Compression, Tile, TileId, TimeRange } from './types.js';

interface DecodeRequest {
  type: 'decode';
  requestId: number;
  id: TileId;
  timeRange: TimeRange;
  compressed: ArrayBuffer;
  compression: Compression;
  /** Directory CRC-32C of `compressed`; verified before decompress when set. */
  expectedCrc32c?: number;
  /** Declared `manifest.formatVersion` (spec §5.2 authority check). */
  formatVersion?: number;
  /** Include the decompressed payload in the response (OPFS write reuse). */
  returnPayload?: boolean;
}

interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

/**
 * The dataset's v2 schema-template registry, structured-cloned from the pool
 * wrapper. Sent as the FIRST message after every spawn/respawn (packed v2
 * design §4.4), so it is always present before any v2 decode request.
 */
interface TemplatesMessage {
  type: 'templates';
  templates: TemplateRegistry;
}

type IncomingMessage = DecodeRequest | CancelRequest | TemplatesMessage;

type DecodeResponse =
  | { requestId: number; tile: Tile; payload?: Uint8Array }
  | { requestId: number; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// Request ids the main thread has cancelled but whose `decode` message this
// worker hasn't finished processing yet. Checked right after the
// (unavoidable) decompress step, before the more expensive Arrow IPC parse +
// binary-feature extraction — the biggest chunk of wasted work a cancel can
// still save once a request has already been dispatched to this worker. A
// cancel that loses the race against an already-completed decode leaves a
// harmless, never-revisited entry here; at one small integer per occurrence
// this is not worth extra bookkeeping to prune.
const cancelledRequestIds = new Set<number>();

/** v2 schema-template registry (see {@link TemplatesMessage}). */
let templates: TemplateRegistry | undefined;

ctx.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  if (msg.type === 'templates') {
    // UNION-merge (content-addressed — a shared hash is identical bytes by
    // construction), mirroring WorkerTileDecoder.setTemplates: successive
    // registry installs from multiple archives sharing this worker
    // accumulate instead of clobbering each other.
    if (!templates) templates = new Map();
    for (const [hash, bytes] of msg.templates) templates.set(hash, bytes);
    return;
  }
  if (msg.type === 'cancel') {
    cancelledRequestIds.add(msg.requestId);
    return;
  }
  const { requestId, id, timeRange, compressed, compression } = msg;
  try {
    // Integrity gate BEFORE decompression (off the main thread): the
    // directory CRC covers the compressed bytes, so a corrupt frame fails
    // loudly here instead of as a confusing fzstd/IPC parse error — or
    // worse, decoding cleanly into garbage.
    if (msg.expectedCrc32c !== undefined) {
      verifyCrc32c(new Uint8Array(compressed), msg.expectedCrc32c);
    }
    const payload = await decompress(new Uint8Array(compressed), compression);
    if (cancelledRequestIds.delete(requestId)) return;
    const tile = decodeTile(payload, id, timeRange, {
      templates,
      formatVersion: msg.formatVersion,
    });
    // The `arrowTable` field carries an apache-arrow `Table` instance. That
    // class has methods on its prototype and is NOT structured-cloneable —
    // postMessage would throw. Strip it before transfer. The raw IPC bytes
    // (`layer.arrowIpc`) DO cross the boundary, so `toGeoArrowTable()` can
    // rehydrate the Table lazily on the main thread.
    for (const layer of tile.layers) delete layer.arrowTable;
    const transferables = collectTransferables(tile);
    const response: DecodeResponse = { requestId, tile };
    if (msg.returnPayload) {
      // Hand the decompressed bytes back for the main thread's OPFS write
      // (saves its re-decompress). The payload's buffer usually IS the
      // decoded Arrow buffer already in `transferables` (zero-copy tiles);
      // only add it when it isn't, since duplicate transfers throw.
      response.payload = payload;
      const payloadBuffer = payload.buffer as ArrayBuffer;
      if (!transferables.includes(payloadBuffer)) {
        transferables.push(payloadBuffer);
      }
    }
    ctx.postMessage(response, transferables);
  } catch (err) {
    if (cancelledRequestIds.delete(requestId)) return; // cancelled, not a real error
    // Tag the error with the tile id so the main thread's `[STL] Tile error`
    // log identifies the offending tile without a separate debug pass.
    const base = err instanceof Error ? err.message : String(err);
    const tileKey = `${id.z}/${id.x}/${id.y}/${id.t}`;
    const message = `tile ${tileKey}: ${base}`;
    const response: DecodeResponse = { requestId, error: message };
    ctx.postMessage(response);
  }
};
