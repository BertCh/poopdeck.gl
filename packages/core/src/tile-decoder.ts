// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Tile-decode strategy: inline (main thread) or worker pool (off main).
 *
 * The default `STTArchive` constructs a {@link createDefaultTileDecoder}, which
 * picks a worker-pool decoder in browsers that support module Workers and
 * falls back to inline decoding everywhere else (Node tests, SSR, browsers
 * where the worker fails to construct). The worker path is the only way to
 * sustain 60 fps while streaming a many-thousand-tile dataset — inline
 * decode of one tile is ~5–20 ms of `tableFromIPC` + binary extraction,
 * which is a full frame budget gone.
 */

import { decompress } from './compression';
import { decodeTile } from './tile';
import { emit as emitTelemetry } from './telemetry';
import { createCancellationError } from './request-scheduler';
import type { Compression, Tile, TileId, TimeRange } from './types';

/** A single decode request. Compressed bytes are owned by the caller. */
export interface DecodeArgs {
  id: TileId;
  timeRange: TimeRange;
  compressed: ArrayBuffer;
  compression: Compression;
}

export interface TileDecoder {
  decode(args: DecodeArgs): Promise<Tile>;
  finalize(): void;
}

/**
 * Synchronous decoder that runs on whichever thread called it. Used as the
 * default in Node and as the fallback in browsers when a worker can't start.
 */
export class InlineTileDecoder implements TileDecoder {
  async decode({ id, timeRange, compressed, compression }: DecodeArgs): Promise<Tile> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const payload = await decompress(new Uint8Array(compressed), compression);
    const tDecompress = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tile = decodeTile(payload, id, timeRange);
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Emit telemetry only when the probe is enabled. Capturing compressed
    // + decompressed sizes lets the perf probe attribute slow decodes to
    // either decompression (compression hot-path bottleneck) or IPC parse
    // (Arrow IPC reader bottleneck).
    emitTelemetry('decode', {
      tileKey: `${id.z}/${id.x}/${id.y}/${id.t}`,
      decompressMs: tDecompress - t0,
      ipcMs: t1 - tDecompress,
      ms: t1 - t0,
      compressedBytes: compressed.byteLength,
      payloadBytes: payload.byteLength,
      path: 'inline',
    });
    return tile;
  }
  finalize(): void {
    /* nothing to release */
  }
}

interface PendingRequest {
  resolve: (tile: Tile) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  pending: number;
}

/**
 * Worker-pool decoder. Each `decode()` call slices the compressed payload
 * (so the archive byte cache keeps its original ArrayBuffer intact) and
 * transfers the slice to one of the pool workers. The worker decompresses
 * and decodes off the main thread, then transfers the decoded typed-array
 * buffers back — zero copy at the worker→main boundary.
 *
 * Workers are picked by least-pending count, so a long-running decode does
 * not block subsequent fast tiles behind it.
 */
interface PooledWorkerEntry extends PooledWorker {
  /** Request IDs currently dispatched to this worker. */
  inFlight: Set<number>;
}

export class WorkerTileDecoder implements TileDecoder {
  private workers: PooledWorkerEntry[];
  private pending = new Map<number, PendingRequest>();
  /** request id -> the worker entry that owns it (for respawn fail-fast). */
  private requestOwner = new Map<number, PooledWorkerEntry>();
  private nextRequestId = 1;
  private disposed = false;
  private readonly workerUrl: URL;

  constructor(options: { poolSize?: number; workerUrl?: URL } = {}) {
    const poolSize =
      options.poolSize ??
      (() => {
        const cores =
          typeof navigator !== 'undefined' && navigator.hardwareConcurrency
            ? navigator.hardwareConcurrency
            : 4;
        // One core for the main thread + render loop; cap at 4 so we don't
        // out-spawn the network or thrash on small machines.
        return Math.max(2, Math.min(4, cores - 1));
      })();

    this.workerUrl =
      options.workerUrl ??
      new URL('./tile-decoder.worker.js', import.meta.url);

    this.workers = [];
    for (let i = 0; i < poolSize; i++) {
      this.workers.push(this.spawnWorker());
    }
  }

  private spawnWorker(): PooledWorkerEntry {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    const entry: PooledWorkerEntry = { worker, pending: 0, inFlight: new Set() };
    worker.onmessage = (e) => this.handleMessage(e);
    worker.onerror = (e) => this.handleWorkerError(entry, e);
    return entry;
  }

  decode(args: DecodeArgs): Promise<Tile> {
    if (this.disposed) {
      return Promise.reject(new Error('WorkerTileDecoder has been finalized'));
    }
    const requestId = this.nextRequestId++;

    // Pick the worker with the smallest pending queue. With pool sizes ≤ 4
    // this linear scan is negligible compared to the decode itself.
    let target = this.workers[0];
    for (let i = 1; i < this.workers.length; i++) {
      if (this.workers[i].pending < target.pending) target = this.workers[i];
    }
    target.pending++;
    target.inFlight.add(requestId);
    this.requestOwner.set(requestId, target);

    // Slice (copy) the compressed bytes before transferring — the archive
    // keeps the original in its byte cache for re-decode after eviction or
    // for a viewport tile that's also in the prefetch queue.
    const compressedCopy = args.compressed.slice(0);
    const compressedBytes = compressedCopy.byteLength;
    const owner = target;
    // Capture round-trip start so we can emit a probe sample including the
    // main-thread→worker→main-thread queue latency. Useful when the pool
    // is saturated and the bottleneck is queue wait, not raw decode.
    const tStart =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tileKey = `${args.id.z}/${args.id.x}/${args.id.y}/${args.id.t}`;

    return new Promise<Tile>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (tile) => {
          owner.pending = Math.max(0, owner.pending - 1);
          owner.inFlight.delete(requestId);
          this.requestOwner.delete(requestId);
          const tEnd =
            typeof performance !== 'undefined' ? performance.now() : Date.now();
          emitTelemetry('decode', {
            tileKey,
            ms: tEnd - tStart,
            compressedBytes,
            path: 'worker',
          });
          resolve(tile);
        },
        reject: (err) => {
          owner.pending = Math.max(0, owner.pending - 1);
          owner.inFlight.delete(requestId);
          this.requestOwner.delete(requestId);
          reject(err);
        },
      });
      target.worker.postMessage(
        {
          requestId,
          id: args.id,
          timeRange: args.timeRange,
          compressed: compressedCopy,
          compression: args.compression,
        },
        [compressedCopy],
      );
    });
  }

  finalize(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { worker } of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const { reject } of this.pending.values()) {
      // Finalizing cancels in-flight decodes — surface it as an AbortError-style
      // cancellation (not a hard error) so consumers that unmount/teardown
      // mid-load (e.g. switching renderers, navigating away) swallow it the same
      // way they swallow a superseded fetch, instead of logging it as a tile error.
      reject(createCancellationError('WorkerTileDecoder finalized while decode was pending'));
    }
    this.pending.clear();
    this.requestOwner.clear();
  }

  private handleMessage(event: MessageEvent<unknown>) {
    const data = event.data as
      | { requestId: number; tile: Tile }
      | { requestId: number; error: string }
      | undefined;
    if (!data || typeof data.requestId !== 'number') return;
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    this.pending.delete(data.requestId);
    if ('error' in data) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve(data.tile);
    }
  }

  private handleWorkerError(entry: PooledWorkerEntry, event: ErrorEvent) {
    // A worker error fails every request it was carrying, and we replace the
    // worker so the pool stays healthy. Surviving in-flight requests on OTHER
    // workers are unaffected.
    const message = event.message || 'worker crashed';
    console.error('[stt] tile-decoder worker error:', message);

    const failed = Array.from(entry.inFlight);
    entry.inFlight.clear();
    entry.pending = 0;
    for (const requestId of failed) {
      const pending = this.pending.get(requestId);
      this.pending.delete(requestId);
      this.requestOwner.delete(requestId);
      pending?.reject(new Error(`tile decoder worker crashed: ${message}`));
    }

    try {
      entry.worker.terminate();
    } catch {
      /* terminate may throw if already dead */
    }

    if (this.disposed) return;

    // Replace the slot with a fresh worker so the pool size stays constant.
    const idx = this.workers.indexOf(entry);
    if (idx >= 0) {
      this.workers[idx] = this.spawnWorker();
    }
  }
}

/**
 * Build the decoder used by default. Picks the worker pool in browsers with
 * module-Worker support, falls back to inline anywhere else (Node tests,
 * older browsers, environments where `new Worker(URL, { type: 'module' })`
 * throws synchronously).
 */
export function createDefaultTileDecoder(): TileDecoder {
  if (typeof Worker === 'undefined') return new InlineTileDecoder();
  try {
    return new WorkerTileDecoder();
  } catch (err) {
    console.warn(
      '[stt] Worker tile decoder unavailable, falling back to inline decode:',
      err,
    );
    return new InlineTileDecoder();
  }
}
