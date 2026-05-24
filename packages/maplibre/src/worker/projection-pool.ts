/**
 * Tiny worker pool that runs `lngLatToMercator` off the main thread.
 *
 * The maplibre adapter's `MapLibre.render` callback fires once per frame on
 * the main thread, so any per-vertex JavaScript inside it eats budget out of
 * the 16ms frame. Pre-projecting positions in a worker means the main thread
 * just uploads finished `Float32Array`s and lets the GPU draw them.
 *
 * Wire-up: the layers call `getProjectionPool().project(buf, dims)` from
 * inside `buildTileGpuCache`. The pool returns a Promise<Float32Array>;
 * builders that wired async returns (currently optional behind
 * `STTBaseLayerOptions.useWorkerProjection`) `await` it before upload. When
 * the host can't run workers (Node CLI bundles, etc.) the pool falls back to
 * an in-thread implementation so callers don't need a branch.
 *
 * No dependency on @stt/core's worker decoder pool: that pool is bound to the
 * STTArchive lifecycle, not the layer lifecycle, and reusing it would risk
 * starvation when an archive read happens concurrently with rendering.
 */

import { workerMain } from './projection-worker';
import { projectPositions as projectInThread } from '../projection';

interface PendingRequest {
  resolve: (value: Float32Array) => void;
  reject: (reason: unknown) => void;
}

interface PooledWorker {
  worker: Worker;
  inFlight: number;
}

/** Public-facing pool. Singleton; one pool per page. */
export class ProjectionWorkerPool {
  private workers: PooledWorker[] = [];
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private nextWorker = 0;
  private maxWorkers: number;
  private fallbackInThread = false;
  private blobUrl?: string;

  constructor(options: { maxWorkers?: number } = {}) {
    const hardwareConcurrency =
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
    this.maxWorkers = Math.min(
      4,
      Math.max(1, options.maxWorkers ?? hardwareConcurrency - 1),
    );
    // Detect Worker availability up-front so the first `project()` call
    // doesn't pay the failure-recovery cost.
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      this.fallbackInThread = true;
    }
  }

  /**
   * Project a packed lon/lat[/alt] buffer to mercator unit-square coordinates.
   *
   * Off-main-thread when possible; transparently falls back to synchronous
   * projection when workers aren't available (SSR, --no-worker bundles, etc).
   *
   * The input buffer's ownership is *transferred* to the worker, so the
   * caller must not touch it after this call resolves. Pass a copy if you
   * need to keep the originals.
   */
  async project(
    positions: Float64Array | Float32Array,
    dimensions: 2 | 3,
  ): Promise<Float32Array> {
    if (this.fallbackInThread) {
      return projectInThread(positions, dimensions);
    }
    const worker = this.acquireWorker();
    const id = this.nextId++;
    return new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.inFlight++;
      // Transfer the buffer; for Float64Array this is `positions.buffer`.
      worker.worker.postMessage(
        { id, positions, dimensions },
        // postMessage transfer list. Float32 input ArrayBuffers can't be
        // transferred if they're a view over a SharedArrayBuffer; in that
        // case `postMessage` will throw and we re-route to the in-thread
        // path on retry.
        [positions.buffer],
      );
    }).catch((err) => {
      // If the post itself fails, demote to in-thread for the remainder of
      // the page session — most likely cause is COOP/COEP not configured for
      // SharedArrayBuffer transfer.
      this.fallbackInThread = true;
      console.warn(
        '[STT] projection-worker post failed; falling back to main-thread projection:',
        err,
      );
      return projectInThread(positions, dimensions);
    });
  }

  /** Tear the pool down. Used by tests; rarely needed at runtime. */
  destroy(): void {
    for (const w of this.workers) w.worker.terminate();
    this.workers.length = 0;
    this.pending.clear();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = undefined;
  }

  private acquireWorker(): PooledWorker {
    if (this.workers.length < this.maxWorkers) {
      const worker = this.createWorker();
      if (worker) {
        const pooled = { worker, inFlight: 0 };
        this.workers.push(pooled);
        return pooled;
      }
    }
    // Round-robin across existing workers. Strict least-loaded would help if
    // requests had wildly varying sizes; per-tile projection tasks are pretty
    // uniform so RR is fine.
    const idx = this.nextWorker++ % this.workers.length;
    return this.workers[idx];
  }

  private createWorker(): Worker | null {
    if (!this.blobUrl) {
      // The blob URL ships `workerMain` as the entire worker body. Stringify
      // the function source, wrap in an IIFE so it runs on load. We do not
      // emit anything else into the worker — keeping the body minimal avoids
      // re-bundling dependencies (e.g. apache-arrow) that the layer doesn't
      // need at projection time.
      const source = `(${workerMain.toString()})()`;
      const blob = new Blob([source], { type: 'application/javascript' });
      this.blobUrl = URL.createObjectURL(blob);
    }
    try {
      const w = new Worker(this.blobUrl);
      w.onmessage = (e: MessageEvent) => this.handleReply(e);
      w.onerror = (e: ErrorEvent) => {
        // Demote to fallback on the first worker error; legitimate worker
        // errors here would be in our own projection code, which is very
        // small and tested in-thread, so any error in production is almost
        // certainly an environmental issue (CSP, etc).
        this.fallbackInThread = true;
        console.warn('[STT] projection-worker error:', e.message);
      };
      return w;
    } catch (err) {
      this.fallbackInThread = true;
      console.warn('[STT] failed to spawn projection worker:', err);
      return null;
    }
  }

  private handleReply(e: MessageEvent): void {
    const msg = e.data as
      | { id: number; projected: Float32Array }
      | { id: number; error: string };
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    // Decrement the worker's in-flight counter (best-effort; we don't know
    // which worker replied without tracking a per-id binding, but the
    // round-robin keeps load roughly balanced).
    const idx = (msg.id - 1) % Math.max(this.workers.length, 1);
    if (this.workers[idx]) this.workers[idx].inFlight--;
    if ('error' in msg) pending.reject(new Error(msg.error));
    else pending.resolve(msg.projected);
  }
}

let singleton: ProjectionWorkerPool | null = null;

/**
 * Lazily-instantiated shared pool. Layers call this once per tile build; the
 * pool is shared across all STT layers on the page so a 6-layer Showcase
 * doesn't spawn 24 workers.
 */
export function getProjectionPool(): ProjectionWorkerPool {
  if (!singleton) singleton = new ProjectionWorkerPool();
  return singleton;
}

/**
 * Reset the singleton. Tests use this to start each suite with a clean pool;
 * production code shouldn't normally need it.
 */
export function resetProjectionPool(): void {
  if (singleton) singleton.destroy();
  singleton = null;
}
