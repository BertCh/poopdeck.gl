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
 *
 * Requests arrive BATCHED (`decodeBatch`) and are answered with one reply per
 * batch — a decode round trip costs a fixed ~0.3-1.2 ms of cross-thread
 * latency whatever it carries, which is negligible against a 155 KB tile and a
 * large fraction of the cost of a sub-KB one. Members are still decoded and
 * reported individually.
 */

/// <reference lib="webworker" />

import { decompressSync } from './compression.js';
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
  /** Exact decompressed size declared by the directory. */
  expectedUncompressedSize: number;
  /** Directory CRC-32C of `compressed`; verified before decompress when set. */
  expectedCrc32c?: number;
  /** Declared `manifest.formatVersion` (spec §5.2 authority check). */
  formatVersion?: number;
  /** Include the decompressed payload in the response (OPFS write reuse). */
  returnPayload?: boolean;
}

/**
 * A pull of several {@link DecodeRequest}s in ONE message (BH-7).
 *
 * A decode round trip costs a fixed ~0.3-1.2 ms of cross-thread latency
 * regardless of payload size, so a tile-COUNT-heavy archive spends much of its
 * decode pipeline couriering. The host batches; this worker decodes the members
 * in order and replies once. Members are still decoded and reported INDIVIDUALLY — one bad
 * tile fails alone, and each still carries its own timing.
 */
interface DecodeBatchRequest {
  type: 'decodeBatch';
  items: DecodeRequest[];
}

interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

/**
 * The dataset's v2 schema-template registry, structured-cloned from the pool
 * wrapper. Sent as the FIRST message after every spawn/respawn, so it is
 * always present before any v2 decode request.
 */
interface TemplatesMessage {
  type: 'templates';
  templates: TemplateRegistry;
}

type IncomingMessage =
  | DecodeRequest
  | DecodeBatchRequest
  | CancelRequest
  | TemplatesMessage;

/**
 * Worker-side service-time breakdown, carried back on every successful decode
 * and forwarded onto the `decode` probe channel by the host.
 *
 * The `decode` sample already splits total round-trip into queue wait vs
 * service, but service was one opaque number — which left "is this parse work
 * or is it per-message overhead?" unanswerable from a trace. That distinction
 * decides whether the answer to a decode backlog is batching (amortise fixed
 * cost) or faster parsing (reduce variable cost), so it is worth the
 * timestamps. NOTE the host stamps the `decode` sample's END on the main
 * thread, so `ms` absorbs main-thread stall; these worker-side fields are the
 * only ones that don't, which is what makes them worth carrying.
 */
interface DecodeTiming {
  /** CRC verify + zstd inflate. */
  decompressMs: number;
  /** Arrow IPC parse + binary-feature extraction (`decodeTile`). */
  parseMs: number;
  /** Strip `arrowTable` + `collectTransferables` — the response prep. */
  prepMs: number;
  /** Whole handler: message receipt → just before the reply postMessage. */
  handlerMs: number;
  /** How many ArrayBuffers this reply transfers (per-buffer detach cost). */
  transferables: number;
}

type DecodeResponse =
  | {
      requestId: number;
      tile: Tile;
      payload?: Uint8Array;
      timing?: DecodeTiming;
    }
  | { requestId: number; error: string }
  /**
   * CANCEL ACK (M6 / BH-5). A cancelled request returns without a tile — but
   * the host tracks exactly one active request per worker, so it must still be
   * told the worker is free. Without this ack the worker would look busy
   * forever and the pool would lose a slot per cancel.
   */
  | { requestId: number; cancelled: true };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Monotonic clock, `Date.now()` only where `performance` is absent. */
const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

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

/**
 * Decode ONE tile and append its reply + transferables to the batch being
 * assembled. Never throws: a bad tile becomes an `error` response for that
 * request alone, so one corrupt frame can't take its batch-mates down.
 *
 * `seen` dedupes transferables ACROSS the whole batch — postMessage throws on a
 * duplicate entry in the transfer list, and two tiles can legitimately share a
 * buffer (a zero-copy payload that is also an Arrow buffer).
 */
function decodeOne(
  msg: DecodeRequest,
  responses: DecodeResponse[],
  transfer: Transferable[],
  seen: Set<Transferable>,
): void {
  const tHandlerStart = now();
  const { requestId, id, timeRange, compressed, compression } = msg;
  const push = (buf: Transferable): void => {
    if (seen.has(buf)) return;
    seen.add(buf);
    transfer.push(buf);
  };
  try {
    // Integrity gate BEFORE decompression (off the main thread): the directory
    // CRC covers the compressed bytes, so a corrupt frame fails loudly here
    // instead of as a confusing fzstd/IPC parse error — or worse, decoding
    // cleanly into garbage.
    const tDecompressStart = now();
    if (msg.expectedCrc32c !== undefined) {
      verifyCrc32c(new Uint8Array(compressed), msg.expectedCrc32c);
    }
    const payload = decompressSync(
      new Uint8Array(compressed),
      compression,
      msg.expectedUncompressedSize,
    );
    if (payload.byteLength !== msg.expectedUncompressedSize) {
      throw new Error(
        `tile payload length mismatch: decoded ${payload.byteLength} bytes, ` +
          `directory declares ${msg.expectedUncompressedSize}`,
      );
    }
    if (cancelledRequestIds.delete(requestId)) {
      // Skip the IPC parse + feature extraction (the expensive half) and free
      // the host's slot for this request.
      responses.push({ requestId, cancelled: true });
      return;
    }
    const tParseStart = now();
    const tile = decodeTile(payload, id, timeRange, {
      templates,
      formatVersion: msg.formatVersion,
    });
    const tParseEnd = now();
    // The `arrowTable` field carries an apache-arrow `Table` instance. That
    // class has methods on its prototype and is NOT structured-cloneable —
    // postMessage would throw. Strip it before transfer. The raw IPC bytes
    // (`layer.arrowIpc`) DO cross the boundary, so `toGeoArrowTable()` can
    // rehydrate the Table lazily on the main thread.
    for (const layer of tile.layers) delete layer.arrowTable;
    const tileTransferables = collectTransferables(tile);
    for (const buf of tileTransferables) push(buf);
    const tPrepEnd = now();
    const response: DecodeResponse = {
      requestId,
      tile,
      timing: {
        decompressMs: tParseStart - tDecompressStart,
        parseMs: tParseEnd - tParseStart,
        prepMs: tPrepEnd - tParseEnd,
        handlerMs: tPrepEnd - tHandlerStart,
        transferables: tileTransferables.length,
      },
    };
    if (msg.returnPayload) {
      // Hand the decompressed bytes back for the main thread's OPFS write
      // (saves its re-decompress). The payload's buffer usually IS the decoded
      // Arrow buffer already transferred above; `push` dedupes either way.
      response.payload = payload;
      push(payload.buffer as ArrayBuffer);
    }
    responses.push(response);
  } catch (err) {
    if (cancelledRequestIds.delete(requestId)) {
      // Cancelled, not a real error — but still ack so the host frees the slot.
      responses.push({ requestId, cancelled: true });
      return;
    }
    // Tag the error with the tile id so the main thread's `[STL] Tile error`
    // log identifies the offending tile without a separate debug pass.
    const base = err instanceof Error ? err.message : String(err);
    const tileKey = `${id.z}/${id.x}/${id.y}/${id.t}`;
    responses.push({ requestId, error: `tile ${tileKey}: ${base}` });
  }
}

ctx.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  if (msg.type === 'templates') {
    // UNION-merge (content-addressed — a shared hash is identical bytes by
    // construction), mirroring WorkerTileDecoder.setTemplates: successive
    // registry installs from multiple archives sharing this worker accumulate
    // instead of clobbering each other.
    if (!templates) templates = new Map();
    for (const [hash, bytes] of msg.templates) templates.set(hash, bytes);
    return;
  }
  if (msg.type === 'cancel') {
    cancelledRequestIds.add(msg.requestId);
    return;
  }

  // One batch in, one reply out (BH-7). Cancels arriving DURING a batch cannot
  // be observed — messages are tasks and this handler is one task — so a tile
  // cancelled mid-batch is still decoded and then discarded by the host on its
  // abort path. That is bounded waste, not incorrectness: a batch is capped at
  // DECODE_BATCH_MAX_TILES / DECODE_BATCH_MAX_BYTES, and the cancellation that
  // actually matters (dropping work the host never dispatched) is unaffected.
  const items = msg.type === 'decodeBatch' ? msg.items : [msg];
  const responses: DecodeResponse[] = [];
  const transfer: Transferable[] = [];
  const seen = new Set<Transferable>();
  for (const item of items) decodeOne(item, responses, transfer, seen);
  ctx.postMessage({ type: 'decodeBatch', responses }, transfer);
};
