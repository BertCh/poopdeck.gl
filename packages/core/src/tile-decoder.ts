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

import { decompress } from './compression.js';
import { decodeTile, type TemplateRegistry } from './tile.js';
import { verifyCrc32c } from './crc32c.js';
import { emit as emitTelemetry } from './telemetry.js';
import { createCancellationError } from './request-scheduler.js';
import type { Compression, Tile, TileId, TimeRange } from './types.js';

/** A single decode request. Compressed bytes are owned by the caller. */
export interface DecodeArgs {
  id: TileId;
  timeRange: TimeRange;
  compressed: ArrayBuffer;
  compression: Compression;
  /**
   * Expected CRC-32C of `compressed` (from the archive directory). When set,
   * the decoder verifies it BEFORE decompressing — on the worker path the
   * check runs off the main thread — and rejects with a distinctive
   * "crc32c mismatch" error on disagreement. Omitted when verification is
   * disabled (`ArchiveOptions.verifyChecksums: false`), when the directory
   * recorded no checksum, or when the input is already decompressed (OPFS
   * warm hits).
   */
  expectedCrc32c?: number;
  /**
   * Optional hand-back of the DECOMPRESSED payload bytes, invoked before the
   * decode promise resolves (success path only). The archive requests this
   * when an OPFS write will follow, so the cache writer reuses the worker's
   * decompressed bytes instead of re-decompressing on the main thread. On
   * the worker path the payload rides the same transferred buffer as the
   * tile's columns (zero extra copy); decoders that don't support the hook
   * simply never call it and the archive falls back to re-decompressing.
   */
  onPayload?: (payload: Uint8Array) => void;
  /**
   * Optional abort signal. `WorkerTileDecoder` honors it two ways: aborted
   * before dispatch, the decode is rejected without ever touching a worker;
   * aborted mid-flight, the pending promise rejects immediately (freeing the
   * caller) AND a `{type:'cancel'}` message tells the owning worker to skip
   * the (comparatively expensive) Arrow IPC parse for a request it hasn't
   * reached yet — so a tile that scrolled off-screen mid-decode doesn't keep
   * the small worker pool busy on wasted work. `InlineTileDecoder` only
   * checks it before starting (no natural mid-decode interruption point on
   * the fallback path).
   */
  signal?: AbortSignal;
  /**
   * The dataset's declared `manifest.formatVersion` (1 | 2), forwarded to
   * `decodeTile` for the packed spec §5.2 authority check — a v2 frame
   * reached through a v1 manifest (or vice versa) fails loudly instead of
   * decoding. Omitted (custom callers), the payload is sniffed.
   */
  formatVersion?: number;
}

/**
 * Union-merge one template registry into another (content-addressed, so a
 * shared hash always maps to identical bytes — merging can never conflict).
 * Merges into a decoder-OWNED map: the caller's registry object is never
 * adopted or mutated, and repeated installs from multiple archives sharing
 * one decoder accumulate instead of clobbering.
 */
function mergeTemplates(
  existing: TemplateRegistry | undefined,
  incoming: TemplateRegistry,
): TemplateRegistry {
  const merged = existing ?? new Map<string, Uint8Array>();
  for (const [hash, bytes] of incoming) merged.set(hash, bytes);
  return merged;
}

export interface TileDecoder {
  decode(args: DecodeArgs): Promise<Tile>;
  finalize(): void;
  /**
   * OPTIONAL: install the dataset's formatVersion-2 schema-template registry
   * (built + blake3-validated from `manifest.schemas` at archive open) so v2
   * frames can resolve their 16-byte template-hash references.
   *
   * Distribution contract (packed v2 design §4.4, normative): the archive
   * calls this once per decoder; a pool implementation MUST (re)send the
   * registry to every worker on EVERY spawn AND respawn, BEFORE dispatching
   * decodes to it, and the inline decoder + OPFS warm path share the same
   * registry object. A v2 decode that reaches a hash reference without the
   * registry rejects descriptively (never a silently-empty tile). Decoders
   * that don't implement it simply can't decode hash-referencing v2 frames
   * (v1 datasets and inline-schema v2 frames are unaffected).
   */
  setTemplates?(templates: TemplateRegistry): void;
}

/**
 * Synchronous decoder that runs on whichever thread called it. Used as the
 * default in Node and as the fallback in browsers when a worker can't start.
 */
export class InlineTileDecoder implements TileDecoder {
  /** v2 schema-template registry, shared with the OPFS warm path (§4.4). */
  private templates?: TemplateRegistry;

  setTemplates(templates: TemplateRegistry): void {
    // UNION-merge, never replace: template hashes are content-addressed
    // (blake3-128 of the bytes), so a key collision is by definition
    // identical bytes and merging is always safe — while replacement let
    // two v2 archives sharing one decoder clobber each other's registries
    // (the second archive's install broke every hash-referencing decode of
    // the first).
    this.templates = mergeTemplates(this.templates, templates);
  }

  async decode({
    id,
    timeRange,
    compressed,
    compression,
    expectedCrc32c,
    onPayload,
    signal,
    formatVersion,
  }: DecodeArgs): Promise<Tile> {
    if (signal?.aborted) {
      throw createCancellationError('Tile decode cancelled before dispatch');
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Integrity gate BEFORE decompression: the directory CRC covers the
    // compressed bytes, and a corrupt frame should fail loudly here rather
    // than as a confusing fzstd/IPC parse error (or worse, decode cleanly).
    if (expectedCrc32c !== undefined) {
      verifyCrc32c(new Uint8Array(compressed), expectedCrc32c);
    }
    const payload = await decompress(new Uint8Array(compressed), compression);
    const tDecompress = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tile = decodeTile(payload, id, timeRange, {
      templates: this.templates,
      formatVersion,
    });
    // Success-path payload hand-back (OPFS write reuse) — mirrors the worker
    // response, which only carries the payload for a successful decode.
    onPayload?.(payload);
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
  /** Forwarded from `DecodeArgs.onPayload`; fed by the worker's response. */
  onPayload?: (payload: Uint8Array) => void;
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
  /**
   * v2 schema-template registry. (Re)sent to EVERY worker on every spawn and
   * respawn — see {@link setTemplates} and `spawnWorker` — so a crash-replaced
   * worker can never receive a v2 decode before it holds the registry.
   */
  private templates?: TemplateRegistry;

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
    // Registry distribution (§4.4, normative): a freshly-spawned worker —
    // including a crash REPLACEMENT — gets the template registry as its very
    // first message. Decode dispatches only ever follow on the same message
    // queue, so the worker can never see a v2 decode registry-less.
    if (this.templates) {
      worker.postMessage({ type: 'templates', templates: this.templates });
    }
    return entry;
  }

  /**
   * Install a dataset's v2 template registry and broadcast the decoder's
   * (merged) registry to every live worker. UNION-merge, never replace —
   * hashes are content-addressed, so merging is always safe, and two v2
   * archives sharing one decoder keep BOTH registries resolvable (see
   * `mergeTemplates`). Future spawns/respawns re-send the merged map
   * automatically (`spawnWorker`).
   */
  setTemplates(templates: TemplateRegistry): void {
    this.templates = mergeTemplates(this.templates, templates);
    if (this.disposed) return;
    for (const { worker } of this.workers) {
      worker.postMessage({ type: 'templates', templates: this.templates });
    }
  }

  decode(args: DecodeArgs): Promise<Tile> {
    if (this.disposed) {
      return Promise.reject(new Error('WorkerTileDecoder has been finalized'));
    }
    if (args.signal?.aborted) {
      return Promise.reject(createCancellationError('Tile decode cancelled before dispatch'));
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
      // Detach the abort listener on every settlement path (normal
      // resolve/reject via handleMessage/handleWorkerError/finalize, or the
      // abort path itself) so a long-lived shared signal (e.g. one
      // AbortController covering a whole batch fetch) never accumulates a
      // listener per tile for the life of the signal.
      let onAbort: (() => void) | undefined;
      const detachAbort = (): void => {
        if (onAbort && args.signal) args.signal.removeEventListener('abort', onAbort);
      };
      this.pending.set(requestId, {
        onPayload: args.onPayload,
        resolve: (tile) => {
          detachAbort();
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
          detachAbort();
          owner.pending = Math.max(0, owner.pending - 1);
          owner.inFlight.delete(requestId);
          this.requestOwner.delete(requestId);
          reject(err);
        },
      });
      if (args.signal) {
        onAbort = () => {
          // Still pending? Settle immediately client-side (the caller is
          // freed without waiting on the worker) and tell the owning worker
          // to drop it. A response that arrives anyway lands in
          // handleMessage with no `pending` entry left and is a silent
          // no-op — the two paths can't double-settle.
          const pendingRequest = this.pending.get(requestId);
          if (!pendingRequest) return;
          this.pending.delete(requestId);
          owner.worker.postMessage({ type: 'cancel', requestId });
          pendingRequest.reject(createCancellationError('Tile decode cancelled'));
        };
        args.signal.addEventListener('abort', onAbort, { once: true });
      }
      target.worker.postMessage(
        {
          type: 'decode',
          requestId,
          id: args.id,
          timeRange: args.timeRange,
          compressed: compressedCopy,
          compression: args.compression,
          expectedCrc32c: args.expectedCrc32c,
          formatVersion: args.formatVersion,
          // Only ask for the decompressed payload back when the caller will
          // consume it (an OPFS write) — it usually rides an already-
          // transferred buffer, but there's no point widening the response
          // otherwise.
          returnPayload: args.onPayload !== undefined,
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
      | { requestId: number; tile: Tile; payload?: Uint8Array }
      | { requestId: number; error: string }
      | undefined;
    if (!data || typeof data.requestId !== 'number') return;
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    this.pending.delete(data.requestId);
    if ('error' in data) {
      pending.reject(new Error(data.error));
    } else {
      // Decompressed-payload hand-back (requested via `returnPayload`),
      // delivered BEFORE resolve so the caller observes it by the time the
      // decode promise settles.
      if (data.payload && pending.onPayload) pending.onPayload(data.payload);
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
