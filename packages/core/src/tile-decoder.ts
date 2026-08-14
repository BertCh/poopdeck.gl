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
import {
  emit as emitTelemetry,
  isProbeEnabled,
  recordDecodeWait,
} from './telemetry.js';
import { createCancellationError } from './request-scheduler.js';
import type { Compression, Tile, TileId, TimeRange } from './types.js';

/** A single decode request. Compressed bytes are owned by the caller. */
export interface DecodeArgs {
  id: TileId;
  timeRange: TimeRange;
  compressed: ArrayBuffer;
  compression: Compression;
  /**
   * Exact decompressed payload length declared by the directory. This is
   * mandatory: it is both the decompression-bomb output cap and the authority
   * checked after decode. Callers starting from an already-decompressed cache
   * payload pass that payload's directory-declared size here too.
   */
  expectedUncompressedSize: number;
  /**
   * Expected CRC-32C of `compressed` (from the archive directory). When set,
   * the decoder verifies it BEFORE decompressing — on the worker path the
   * check runs off the main thread — and rejects with a distinctive
   * "crc32c mismatch" error on disagreement. Omitted when the directory
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
   * Optional abort signal. `WorkerTileDecoder` keeps queued work on the host:
   * an abort before worker dispatch removes it without spending decode CPU.
   * Once a synchronous decode is active it cannot be preempted, but the caller
   * still rejects immediately and the late result is discarded.
   * `InlineTileDecoder` only checks before starting.
   */
  signal?: AbortSignal;
  /**
   * The dataset's declared `manifest.formatVersion` (3), forwarded to
   * `decodeTile` for the packed spec §5.2 authority check — a v2 frame
   * reached through a v1 manifest (or vice versa) fails loudly instead of
   * decoding. Omitted (custom callers), the payload is sniffed.
   */
  formatVersion?: number;
  /**
   * DECODE PRIORITY (M6 / BH-5), on the request scheduler's scale: LOWER is
   * MORE URGENT (Cesium semantics), so a play-head-adjacent tile carries a
   * small value and a prefetch-tier tile carries a large one. The archive
   * threads the very value the network stage selected on
   * (`groupSchedulerPriority`), so the decode stage stops discarding what the
   * fetch stage established.
   *
   * `WorkerTileDecoder` serves its pool-wide host queue by this value; jobs
   * that declare none default to {@link DEFAULT_DECODE_PRIORITY} (0 — the most
   * urgent class), which is where the uninstrumented callers belong: byte-cache
   * and OPFS warm hits are the interactive path. `InlineTileDecoder` ignores it
   * (it has no queue).
   */
  priority?: number;
}

/**
 * Priority assumed for a decode that declares none. 0 is the MOST URGENT class:
 * the callers that omit it are the warm/interactive paths (byte-cache hits,
 * OPFS hits, single `getTile`), while the prefetch tier is the only thing that
 * declares a large value. Making the default "last" would park warm hits behind
 * prefetch, which is the opposite of what a viewer feels.
 */
export const DEFAULT_DECODE_PRIORITY = 0;

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
   * OPTIONAL: install the dataset's formatVersion-3 schema-template registry
   * (built + blake3-validated from `manifest.schemas` at archive open) so v2
   * frames can resolve their 16-byte template-hash references.
   *
   * Distribution contract (normative): the archive
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
    expectedUncompressedSize,
    expectedCrc32c,
    onPayload,
    signal,
    formatVersion,
  }: DecodeArgs): Promise<Tile> {
    if (signal?.aborted) {
      throw createCancellationError('Tile decode cancelled before dispatch');
    }
    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Integrity gate BEFORE decompression: the directory CRC covers the
    // compressed bytes, and a corrupt frame should fail loudly here rather
    // than as a confusing fzstd/IPC parse error (or worse, decode cleanly).
    if (expectedCrc32c !== undefined) {
      verifyCrc32c(new Uint8Array(compressed), expectedCrc32c);
    }
    const payload = await decompress(
      new Uint8Array(compressed),
      compression,
      expectedUncompressedSize,
    );
    if (payload.byteLength !== expectedUncompressedSize) {
      throw new Error(
        `tile payload length mismatch: decoded ${payload.byteLength} bytes, ` +
          `directory declares ${expectedUncompressedSize}`,
      );
    }
    const tDecompress =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tile = decodeTile(payload, id, timeRange, {
      templates: this.templates,
      formatVersion,
    });
    // Success-path payload hand-back (OPFS write reuse) — mirrors the worker
    // response, which only carries the payload for a successful decode.
    onPayload?.(payload);
    const t1 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
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
  /**
   * Host enqueue → worker dispatch, in ms. 0 until the job is pulled. Rides the
   * `decode` telemetry sample as `queueWaitMs` (BH-5) and feeds the pool-sizing
   * controller's EWMA (BH-6).
   */
  queueWaitMs: number;
}

/**
 * One worker in the pool. Under the BH-5 pull model a worker holds AT MOST ONE
 * job: everything else waits in the decoder's single pool-wide {@link
 * WorkerTileDecoder.hostQueue} until some worker goes idle and pulls. There is
 * therefore no per-worker queue to balance and no per-worker backlog to strand.
 */
interface PooledWorkerEntry {
  worker: Worker;
  /** The one request currently executing in this worker. */
  activeRequestId?: number;
  /** `now()` when this worker last pulled a job — the idle-shrink clock (BH-6). */
  lastPullAt: number;
  /** `now()` when the active job was pulled; closes the service-time sample. */
  activeStartedAt: number;
}

interface QueuedWorkerDecode {
  message: Record<string, unknown> & { type: 'decode'; requestId: number };
  compressed: ArrayBuffer;
  /**
   * Timestamp at host enqueue. `pullNext` closes the span, giving the decode
   * QUEUE WAIT that the `decodeQueue` roll-up summarises (P0-2 / §10.2) and
   * that BH-6's pool controller feeds on. Already computed for the `decode`
   * sample, so this costs nothing extra.
   */
  queuedAt: number;
  /**
   * Decode priority, LOWER = MORE URGENT (see {@link DecodeArgs.priority}).
   * Primary host-queue sort key.
   */
  priority: number;
  /**
   * `compressed.byteLength`, observable at enqueue. Secondary sort key
   * (shortest-job-first among equal priorities) and the unit of
   * {@link PoolStats.pendingBytes}.
   */
  costBytes: number;
}

/** A point-in-time snapshot of the decode pool (BH-6; perf HUD). */
export interface PoolStats {
  /** Live workers. Adaptive within `[1, cores − 1]` unless `poolSize` pins it. */
  poolSize: number;
  /** Compressed bytes sitting in the host queue, undispatched. */
  pendingBytes: number;
  /** EWMA of host-enqueue → worker-dispatch latency, ms. */
  queueWaitEwmaMs: number;
  /** EWMA of worker-dispatch → settle latency, ms. */
  serviceEwmaMs: number;
}

/** What {@link decidePoolResize} concluded from one sample stream. */
export type PoolResizeDecision = 'grow' | 'shrink' | 'hold';

/** Inputs to {@link decidePoolResize}. Pure data — no clocks, no globals. */
export interface PoolResizeInput {
  /** Current live worker count. */
  poolSize: number;
  /** Hard ceiling: `cores − 1` (the render-core reservation). */
  maxPoolSize: number;
  queueWaitEwmaMs: number;
  serviceEwmaMs: number;
  /** Completions observed since the last resize (the sustain requirement). */
  samplesSinceResize: number;
  /**
   * Milliseconds since the MOST-idle worker last pulled a job, or `null` when
   * every worker is busy (nothing is shrinkable).
   */
  idleMs: number | null;
}

/**
 * Grow when queue wait exceeds this multiple of service time — i.e. a job
 * spends more time waiting for a worker than being decoded by one.
 */
const POOL_GROW_RATIO = 1.5;
/**
 * Shrink only once queue wait falls below this much smaller multiple. The gap
 * between the two ratios is the hysteresis band that stops an oscillating load
 * from flapping the pool.
 */
const POOL_SHRINK_RATIO = 0.25;
/** Completions required between resize decisions (sustain + cooldown). */
const POOL_RESIZE_MIN_SAMPLES = 8;
/** A worker must have gone unpulled this long (ms) before it can be retired. */
const POOL_SHRINK_IDLE_MS = 5000;
/**
 * Absolute floor on queue wait before growth is considered. Without it a pool
 * whose service time rounds to 0 would grow on sub-millisecond noise.
 */
const POOL_GROW_MIN_WAIT_MS = 1;
/** EWMA smoothing factor for the queue-wait / service samples. */
const POOL_EWMA_ALPHA = 0.2;

/**
 * The pool-sizing controller (M6 / BH-6), extracted as a PURE function of the
 * sample stream: same inputs ⇒ same decision, no wall clock, no randomness.
 *
 * Closes the D2 loop §10.1 names — queue-wait samples were emitted and never
 * fed back, so `m = max(1, min(4, cores − 1))` was the permanent answer to a
 * question that only provisioning can answer. The `[1, cores − 1]` bound is the
 * render-core reservation and is HARD: growth stops there regardless of wait.
 */
export function decidePoolResize(input: PoolResizeInput): PoolResizeDecision {
  // Sustain + cooldown: never react to a single completion, and never resize
  // twice in a row without fresh evidence.
  if (input.samplesSinceResize < POOL_RESIZE_MIN_SAMPLES) return 'hold';
  if (
    input.poolSize < input.maxPoolSize &&
    input.queueWaitEwmaMs >= POOL_GROW_MIN_WAIT_MS &&
    input.queueWaitEwmaMs > POOL_GROW_RATIO * input.serviceEwmaMs
  ) {
    return 'grow';
  }
  if (
    input.poolSize > 1 &&
    input.idleMs !== null &&
    input.idleMs >= POOL_SHRINK_IDLE_MS &&
    input.queueWaitEwmaMs < POOL_SHRINK_RATIO * input.serviceEwmaMs
  ) {
    return 'shrink';
  }
  return 'hold';
}

export class WorkerTileDecoder implements TileDecoder {
  private workers: PooledWorkerEntry[];
  private pending = new Map<number, PendingRequest>();
  /** Payloads stay on the host until a worker is actually free. */
  private queuedDecodes = new Map<number, QueuedWorkerDecode>();
  /**
   * THE POOL-WIDE HOST QUEUE (M6 / BH-5). Request ids awaiting a worker, served
   * by `(priority, costBytes, requestId)`. Replaces the per-worker queues +
   * least-pending-count assignment, which stranded a queue behind ONE slow
   * decode while other workers idled, and lost the fetch stage's priority to
   * arrival order.
   */
  private hostQueue: number[] = [];
  /** Set on enqueue; the queue is (re)sorted lazily at the next pull. */
  private hostQueueDirty = false;
  /** Running Σ costBytes of `hostQueue`, for O(1) {@link getPoolStats}. */
  private hostQueueBytes = 0;
  /**
   * request id -> the worker that PULLED it. Populated at DISPATCH, never at
   * enqueue (there is no owner until a worker takes the job), and read only to
   * route a mid-flight cancel to the one worker actually running the request.
   */
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

  // ── BH-6 pool-sizing controller state ─────────────────────────────────────
  /** Hard ceiling `cores − 1`: one core stays reserved for the render loop. */
  private readonly maxPoolSize: number;
  /** True when `poolSize` was supplied — the pin that disables adaptation. */
  private readonly poolSizePinned: boolean;
  private queueWaitEwmaMs = 0;
  private serviceEwmaMs = 0;
  /** Completions since the last resize (the sustain requirement). */
  private samplesSinceResize = 0;
  /** Injectable clock. TEST SEAM only; production reads the real one. */
  private readonly now: () => number;

  constructor(
    options: {
      poolSize?: number;
      workerUrl?: URL;
      /**
       * TEST SEAM: override the detected hardware concurrency. The `κ − 1`
       * render-core reservation is still applied to it, so the bound stays
       * hard — this only changes what κ is read as.
       */
      cores?: number;
      /** TEST SEAM: injectable monotonic clock for the BH-6 idle rules. */
      now?: () => number;
    } = {},
  ) {
    this.now =
      options.now ??
      (() =>
        typeof performance !== 'undefined' ? performance.now() : Date.now());

    const detected =
      options.cores ??
      (typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4);
    const cores = Math.max(1, Math.min(64, Math.floor(detected)));
    // One core for the main thread + render loop. This ceiling is a hard
    // constraint from the provisioning model — the adaptive controller may
    // never grow past it.
    this.maxPoolSize = Math.max(1, cores - 1);

    this.poolSizePinned = typeof options.poolSize === 'number';
    // The historical fixed rule survives as the INITIAL size (cap at 4 so a
    // cold start doesn't out-spawn the network on a big machine); BH-6's
    // controller takes it from there unless `poolSize` pins it.
    const initial = this.poolSizePinned
      ? Math.max(1, Math.floor(options.poolSize as number))
      : Math.max(1, Math.min(4, this.maxPoolSize));

    this.workerUrl =
      options.workerUrl ?? new URL('./tile-decoder.worker.js', import.meta.url);

    this.workers = [];
    for (let i = 0; i < initial; i++) {
      this.workers.push(this.spawnWorker());
    }
  }

  private spawnWorker(): PooledWorkerEntry {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    const entry: PooledWorkerEntry = {
      worker,
      activeRequestId: undefined,
      lastPullAt: this.now(),
      activeStartedAt: 0,
    };
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
      return Promise.reject(
        createCancellationError('Tile decode cancelled before dispatch'),
      );
    }
    const requestId = this.nextRequestId++;

    // NO WORKER IS CHOSEN HERE (BH-5). The job goes on the pool-wide host queue
    // and whichever worker goes idle first pulls the most-urgent one. Binding a
    // job to a worker at enqueue is what stranded a backlog behind one slow
    // decode while other workers sat idle.
    const compressedBytes = args.compressed.byteLength;
    // Capture round-trip start so we can emit a probe sample including the
    // main-thread→worker→main-thread queue latency. Useful when the pool
    // is saturated and the bottleneck is queue wait, not raw decode.
    const tStart = this.now();
    const tileKey = `${args.id.z}/${args.id.x}/${args.id.y}/${args.id.t}`;

    return new Promise<Tile>((resolve, reject) => {
      // Detach the abort listener on every settlement path (normal
      // resolve/reject via handleMessage/handleWorkerError/finalize, or the
      // abort path itself) so a long-lived shared signal (e.g. one
      // AbortController covering a whole batch fetch) never accumulates a
      // listener per tile for the life of the signal.
      let onAbort: (() => void) | undefined;
      const detachAbort = (): void => {
        if (onAbort && args.signal)
          args.signal.removeEventListener('abort', onAbort);
      };
      // Named so the resolve closure can read the queue wait `pullNext` stamps
      // on it after this object is built.
      const record: PendingRequest = {
        onPayload: args.onPayload,
        queueWaitMs: 0,
        resolve: (tile) => {
          detachAbort();
          this.requestOwner.delete(requestId);
          const tEnd = this.now();
          emitTelemetry('decode', {
            tileKey,
            ms: tEnd - tStart,
            // BH-5: the queue-wait / service split §10.2 asked for, and the
            // signal BH-6's pool controller adapts on.
            queueWaitMs: record.queueWaitMs,
            compressedBytes,
            path: 'worker',
          });
          resolve(tile);
        },
        reject: (err) => {
          detachAbort();
          this.requestOwner.delete(requestId);
          reject(err);
        },
      };
      this.pending.set(requestId, record);
      if (args.signal) {
        onAbort = () => {
          const pendingRequest = this.pending.get(requestId);
          if (!pendingRequest) return;
          this.pending.delete(requestId);
          // HOST-QUEUED work is removed before the worker ever sees it: no
          // copy was made, no message was posted, and — per the standing
          // rejection of worker-side cancel queueing — NO cancel is posted
          // either. There is nothing on the worker to cancel.
          const removed = this.removeFromHostQueue(requestId);
          if (!removed) {
            // ACTIVE work cannot be preempted, but the worker checks its
            // cancelled set right after the (unavoidable) decompress and
            // before the far more expensive IPC parse + feature extraction.
            // The message goes ONLY to the worker running THIS request —
            // never queued behind other work.
            this.postCancel(requestId);
          }
          pendingRequest.reject(
            createCancellationError('Tile decode cancelled'),
          );
          this.pumpQueue();
        };
        args.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.queuedDecodes.set(requestId, {
        message: {
          type: 'decode',
          requestId,
          id: args.id,
          timeRange: args.timeRange,
          compression: args.compression,
          expectedUncompressedSize: args.expectedUncompressedSize,
          expectedCrc32c: args.expectedCrc32c,
          formatVersion: args.formatVersion,
          // Only ask for the decompressed payload back when the caller will
          // consume it (an OPFS write) — it usually rides an already-
          // transferred buffer, but there's no point widening the response
          // otherwise.
          returnPayload: args.onPayload !== undefined,
        },
        compressed: args.compressed,
        queuedAt: tStart,
        priority: Number.isFinite(args.priority as number)
          ? (args.priority as number)
          : DEFAULT_DECODE_PRIORITY,
        costBytes: compressedBytes,
      });
      this.hostQueue.push(requestId);
      this.hostQueueBytes += compressedBytes;
      this.hostQueueDirty = true;
      this.pumpQueue();
    });
  }

  /**
   * Drop a request from the host queue. Returns true if it was still queued
   * (so the caller knows no worker ever saw it).
   */
  private removeFromHostQueue(requestId: number): boolean {
    const job = this.queuedDecodes.get(requestId);
    const idx = this.hostQueue.indexOf(requestId);
    if (idx >= 0) this.hostQueue.splice(idx, 1);
    if (job) {
      this.queuedDecodes.delete(requestId);
      this.hostQueueBytes = Math.max(0, this.hostQueueBytes - job.costBytes);
    }
    return idx >= 0;
  }

  /**
   * Post the (previously dormant) mid-pipeline cancel to the ONE worker running
   * `requestId`. No-op when the request has no owner, i.e. it is not active on
   * any worker — the recorded rejection of worker-side cancel QUEUEING is
   * precisely that a cancel must never sit in a worker's message queue behind
   * the work it is trying to stop.
   */
  private postCancel(requestId: number): void {
    if (this.disposed) return;
    const owner = this.requestOwner.get(requestId);
    if (!owner || owner.activeRequestId !== requestId) return;
    owner.worker.postMessage({ type: 'cancel', requestId });
  }

  /**
   * Order the host queue: most urgent first.
   *
   *  1. `priority` ascending — the fetch stage's scale, carried through.
   *  2. `costBytes` ascending — shortest-job-first WITHIN a priority class,
   *     which minimises mean flow time and subsumes the old least-pending-bytes
   *     balancing (a central queue has no per-worker assignment left to
   *     balance). Note this is a real ordering change for same-priority jobs of
   *     different sizes; identical-size jobs are unaffected.
   *  3. `requestId` ascending — FIFO, and a total tiebreak, so the order is
   *     fully deterministic for a given enqueue sequence.
   */
  private sortHostQueue(): void {
    if (!this.hostQueueDirty) return;
    this.hostQueueDirty = false;
    const jobs = this.queuedDecodes;
    this.hostQueue.sort((a, b) => {
      const ja = jobs.get(a);
      const jb = jobs.get(b);
      // Stale ids (cancelled between enqueue and sort) sink; `pullNext` skips
      // them. Never compares two live jobs, so the order stays total.
      if (!ja || !jb) return ja ? -1 : jb ? 1 : a - b;
      if (ja.priority !== jb.priority) return ja.priority - jb.priority;
      if (ja.costBytes !== jb.costBytes) return ja.costBytes - jb.costBytes;
      return a - b;
    });
  }

  /** Give every idle worker a chance to pull, most-urgent job first. */
  private pumpQueue(): void {
    if (this.disposed) return;
    for (const entry of this.workers) {
      if (this.hostQueue.length === 0) return;
      if (entry.activeRequestId === undefined) this.pullNext(entry);
    }
  }

  /**
   * An idle worker PULLS the most-urgent host-queued job (BH-5). Exactly one
   * job per worker; the rest stay on the host, which is what makes cancellation
   * real — a superseded pan/seek deletes queued work instead of posting a
   * cancel behind the work it targets.
   *
   * The transferable `slice(0)` is made HERE, when a worker actually takes the
   * job — never at enqueue. Copy-at-enqueue is a recorded rejected design: it
   * doubled peak memory for work the worker never saw.
   */
  private pullNext(entry: PooledWorkerEntry): void {
    if (this.disposed || entry.activeRequestId !== undefined) return;
    this.sortHostQueue();
    while (this.hostQueue.length > 0) {
      const requestId = this.hostQueue.shift()!;
      const queued = this.queuedDecodes.get(requestId);
      if (!queued || !this.pending.has(requestId)) continue;
      this.queuedDecodes.delete(requestId);
      this.hostQueueBytes = Math.max(0, this.hostQueueBytes - queued.costBytes);
      entry.activeRequestId = requestId;
      this.requestOwner.set(requestId, entry);
      const dispatchedAt = this.now();
      entry.lastPullAt = dispatchedAt;
      entry.activeStartedAt = dispatchedAt;
      const waitMs = Math.max(0, dispatchedAt - queued.queuedAt);
      // Feed the BH-6 controller unconditionally — it is a control loop, not
      // observation, and must not depend on whether a probe is attached.
      this.queueWaitEwmaMs = ewma(this.queueWaitEwmaMs, waitMs);
      const record = this.pending.get(requestId);
      if (record) record.queueWaitMs = waitMs;
      // OBSERVATION (P0-2): close the host-queue span for the `decodeQueue`
      // roll-up. `hostQueue.length` is the O(1) host queue depth.
      if (isProbeEnabled()) recordDecodeWait(waitMs, this.hostQueue.length);
      const compressed = queued.compressed.slice(0);
      entry.worker.postMessage({ ...queued.message, compressed }, [compressed]);
      return;
    }
  }

  private finishWorkerRequest(requestId: number): void {
    const entry = this.workers.find(
      (candidate) => candidate.activeRequestId === requestId,
    );
    if (!entry) return;
    entry.activeRequestId = undefined;
    this.requestOwner.delete(requestId);
    if (entry.activeStartedAt > 0) {
      this.serviceEwmaMs = ewma(
        this.serviceEwmaMs,
        Math.max(0, this.now() - entry.activeStartedAt),
      );
      entry.activeStartedAt = 0;
    }
    this.samplesSinceResize++;
    this.maybeResizePool();
    this.pumpQueue();
  }

  /**
   * BH-6: one resize decision per completion, delegated to the pure
   * {@link decidePoolResize}. Pinned pools never adapt.
   */
  private maybeResizePool(): void {
    if (this.disposed || this.poolSizePinned) return;
    const now = this.now();
    let idleMs: number | null = null;
    for (const entry of this.workers) {
      if (entry.activeRequestId !== undefined) continue;
      const idle = Math.max(0, now - entry.lastPullAt);
      if (idleMs === null || idle > idleMs) idleMs = idle;
    }
    const decision = decidePoolResize({
      poolSize: this.workers.length,
      maxPoolSize: this.maxPoolSize,
      queueWaitEwmaMs: this.queueWaitEwmaMs,
      serviceEwmaMs: this.serviceEwmaMs,
      samplesSinceResize: this.samplesSinceResize,
      idleMs,
    });
    if (decision === 'hold') return;
    if (decision === 'grow') {
      // At most one spawn per evaluation, so a burst can't pay N spawn
      // latencies at once. The fresh worker gets the template registry as its
      // first message (spawnWorker), before it can ever pull a decode.
      this.workers.push(this.spawnWorker());
      this.samplesSinceResize = 0;
      return;
    }
    // Shrink: retire the MOST-idle worker, and only one that holds no job.
    let victim: PooledWorkerEntry | undefined;
    for (const entry of this.workers) {
      if (entry.activeRequestId !== undefined) continue;
      if (!victim || entry.lastPullAt < victim.lastPullAt) victim = entry;
    }
    if (!victim) return;
    const idx = this.workers.indexOf(victim);
    if (idx >= 0) this.workers.splice(idx, 1);
    try {
      victim.worker.terminate();
    } catch {
      /* terminate may throw if already dead */
    }
    this.samplesSinceResize = 0;
  }

  /** Pool snapshot for the perf HUD (BH-6). */
  getPoolStats(): PoolStats {
    return {
      poolSize: this.workers.length,
      pendingBytes: this.hostQueueBytes,
      queueWaitEwmaMs: this.queueWaitEwmaMs,
      serviceEwmaMs: this.serviceEwmaMs,
    };
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
      reject(
        createCancellationError(
          'WorkerTileDecoder finalized while decode was pending',
        ),
      );
    }
    this.pending.clear();
    this.requestOwner.clear();
    this.queuedDecodes.clear();
    this.hostQueue = [];
    this.hostQueueBytes = 0;
    this.hostQueueDirty = false;
  }

  private handleMessage(event: MessageEvent<unknown>) {
    const data = event.data as
      | { requestId: number; tile: Tile; payload?: Uint8Array }
      | { requestId: number; error: string }
      | { requestId: number; cancelled: true }
      | undefined;
    if (!data || typeof data.requestId !== 'number') return;
    const pending = this.pending.get(data.requestId);
    if (pending) {
      this.pending.delete(data.requestId);
      if ('cancelled' in data) {
        // The worker honoured a mid-flight cancel and skipped the parse. The
        // caller was already rejected on the abort path; this branch only
        // exists for the (impossible-by-construction) case of a cancel ACK for
        // a request nobody cancelled.
        pending.reject(createCancellationError('Tile decode cancelled'));
      } else if ('error' in data) {
        pending.reject(new Error(data.error));
      } else {
        // Decompressed-payload hand-back (requested via `returnPayload`),
        // delivered BEFORE resolve so the caller observes it by the time the
        // decode promise settles.
        if (data.payload && pending.onPayload) pending.onPayload(data.payload);
        pending.resolve(data.tile);
      }
    }
    // Also release an active slot whose caller aborted and was removed from
    // `pending`; its late response is intentionally otherwise ignored. A
    // cancel ACK lands here too — that is what frees the worker after a
    // mid-flight cancel, which returns without a normal response.
    this.finishWorkerRequest(data.requestId);
  }

  private handleWorkerError(entry: PooledWorkerEntry, event: ErrorEvent) {
    // A worker error fails only the ONE request it was actually running, and we
    // replace the worker so the pool stays healthy. Surviving in-flight
    // requests on OTHER workers are unaffected.
    const message = event.message || 'worker crashed';
    console.error('[stt] tile-decoder worker error:', message);

    // BH-5, INTENTIONAL BEHAVIOUR CHANGE: host-queued jobs no longer die with
    // the worker. Under the old per-worker assignment they were bound to this
    // entry and were failed alongside it; with one pool-wide queue they were
    // never this worker's to lose, so they stay queued and the replacement (or
    // any other idle worker) pulls them. Crash blast radius = the active job.
    const failedId = entry.activeRequestId;
    entry.activeRequestId = undefined;
    entry.activeStartedAt = 0;
    if (failedId !== undefined) {
      const pending = this.pending.get(failedId);
      this.pending.delete(failedId);
      this.queuedDecodes.delete(failedId);
      this.requestOwner.delete(failedId);
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
    // Let the replacement (which already holds the template registry — it was
    // its first message) pick up the survivors.
    this.pumpQueue();
  }
}

/** Exponentially-weighted moving average; seeds on the first sample. */
function ewma(prev: number, sample: number): number {
  return prev === 0 ? sample : prev + POOL_EWMA_ALPHA * (sample - prev);
}

interface SharedWorkerDecoderState {
  decoder: WorkerTileDecoder;
  leases: number;
}

let sharedWorkerDecoder: SharedWorkerDecoderState | undefined;

/**
 * One archive-facing lease on the process-wide worker pool. Archive teardown
 * releases only its lease; the workers stay alive until the last live archive
 * goes away. Template registries are safe to union because their keys are
 * content hashes (WorkerTileDecoder.setTemplates already enforces that).
 */
class SharedWorkerDecoderLease implements TileDecoder {
  private released = false;

  constructor(private readonly state: SharedWorkerDecoderState) {
    state.leases++;
  }

  decode(args: DecodeArgs): Promise<Tile> {
    if (this.released) {
      return Promise.reject(
        new Error('Shared tile decoder lease has been finalized'),
      );
    }
    return this.state.decoder.decode(args);
  }

  setTemplates(templates: TemplateRegistry): void {
    if (!this.released) this.state.decoder.setTemplates(templates);
  }

  /** Pool snapshot for the perf HUD (BH-6) — the shared pool's, not per-lease. */
  getPoolStats(): PoolStats {
    return this.state.decoder.getPoolStats();
  }

  finalize(): void {
    if (this.released) return;
    this.released = true;
    this.state.leases = Math.max(0, this.state.leases - 1);
    if (this.state.leases === 0) {
      this.state.decoder.finalize();
      if (sharedWorkerDecoder === this.state) sharedWorkerDecoder = undefined;
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
    if (!sharedWorkerDecoder) {
      sharedWorkerDecoder = {
        decoder: new WorkerTileDecoder(),
        leases: 0,
      };
    }
    return new SharedWorkerDecoderLease(sharedWorkerDecoder);
  } catch (err) {
    console.warn(
      '[stt] Worker tile decoder unavailable, falling back to inline decode:',
      err,
    );
    return new InlineTileDecoder();
  }
}
