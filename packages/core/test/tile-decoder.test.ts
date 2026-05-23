/**
 * Tile-decoder worker pool: respawn-on-crash behaviour.
 *
 * The real Worker constructor is unavailable in Node, so we stub a minimal
 * implementation that lets us drive `onmessage` / `onerror` from the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { WorkerTileDecoder } from '../src/tile-decoder';
import { Compression } from '../src/types';

class FakeWorker {
  static all: FakeWorker[] = [];
  static idSeq = 0;

  readonly id: number;
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  postedRequestIds: number[] = [];

  constructor(_url: URL | string, _opts?: WorkerOptions) {
    this.id = ++FakeWorker.idSeq;
    FakeWorker.all.push(this);
  }

  postMessage(msg: any, _transfer?: Transferable[]) {
    if (msg && typeof msg.requestId === 'number') {
      this.postedRequestIds.push(msg.requestId);
    }
  }

  terminate() {
    this.terminated = true;
  }

  /** Drive an error event as though the worker had crashed. */
  crash(message = 'simulated crash') {
    this.onerror?.({ message } as ErrorEvent);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var Worker: any;
}

describe('WorkerTileDecoder respawn', () => {
  let originalWorker: any;

  beforeEach(() => {
    FakeWorker.all = [];
    FakeWorker.idSeq = 0;
    originalWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = FakeWorker;
  });

  afterEach(() => {
    (globalThis as any).Worker = originalWorker;
  });

  it('rejects pending requests and replaces the crashed worker', async () => {
    const decoder = new WorkerTileDecoder({ poolSize: 2, workerUrl: new URL('file:///fake-worker.js') });
    expect(FakeWorker.all).toHaveLength(2);

    const compressed = new ArrayBuffer(8);
    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed,
      compression: Compression.None,
    });

    // The decoder picked the least-pending worker; only one of the two has
    // a posted request.
    const owner = FakeWorker.all.find((w) => w.postedRequestIds.length > 0);
    expect(owner, 'a worker received the request').toBeDefined();

    owner!.crash('boom');

    await expect(promise).rejects.toThrow(/worker crashed/i);
    expect(owner!.terminated).toBe(true);

    // Pool size still 2 (replacement spawned).
    expect(FakeWorker.all.filter((w) => !w.terminated)).toHaveLength(2);

    decoder.finalize();
  });

  it('finalize terminates every live worker exactly once', () => {
    const decoder = new WorkerTileDecoder({ poolSize: 3, workerUrl: new URL('file:///fake-worker.js') });
    expect(FakeWorker.all).toHaveLength(3);

    decoder.finalize();
    for (const w of FakeWorker.all) {
      expect(w.terminated).toBe(true);
    }
    // Idempotent.
    decoder.finalize();
  });
});
