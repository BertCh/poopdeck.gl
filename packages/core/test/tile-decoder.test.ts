/**
 * Tile-decoder worker pool: respawn-on-crash behaviour.
 *
 * The real Worker constructor is unavailable in Node, so we stub a minimal
 * implementation that lets us drive `onmessage` / `onerror` from the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { InlineTileDecoder, WorkerTileDecoder } from '../src/tile-decoder';
import { Compression } from '../src/types';

class FakeWorker {
  static all: FakeWorker[] = [];
  static idSeq = 0;

  readonly id: number;
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  postedRequestIds: number[] = [];
  /** Every posted message verbatim, so tests can distinguish decode vs cancel. */
  postedMessages: any[] = [];

  constructor(_url: URL | string, _opts?: WorkerOptions) {
    this.id = ++FakeWorker.idSeq;
    FakeWorker.all.push(this);
  }

  postMessage(msg: any, _transfer?: Transferable[]) {
    this.postedMessages.push(msg);
    if (msg && typeof msg.requestId === 'number') {
      this.postedRequestIds.push(msg.requestId);
    }
  }

  /** Simulate the worker's decode response arriving. */
  respond(requestId: number, tile: unknown) {
    this.onmessage?.({ data: { requestId, tile } } as MessageEvent<unknown>);
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

describe('InlineTileDecoder pre-dispatch cancellation', () => {
  it('rejects without decoding when the signal is already aborted', async () => {
    const decoder = new InlineTileDecoder();
    const controller = new AbortController();
    controller.abort();

    await expect(
      decoder.decode({
        id: { z: 0, x: 0, y: 0, t: 0 },
        timeRange: { start: 0, end: 1 },
        compressed: new ArrayBuffer(8),
        compression: Compression.None,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('WorkerTileDecoder mid-flight cancellation (perf research 2026-07)', () => {
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

  it('rejects before ever posting to a worker when the signal is already aborted', async () => {
    const decoder = new WorkerTileDecoder({ poolSize: 1, workerUrl: new URL('file:///fake-worker.js') });
    const controller = new AbortController();
    controller.abort();

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      signal: controller.signal,
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all[0].postedMessages).toHaveLength(0);

    decoder.finalize();
  });

  it('aborting mid-flight rejects immediately and posts a cancel message to the owning worker', async () => {
    const decoder = new WorkerTileDecoder({ poolSize: 1, workerUrl: new URL('file:///fake-worker.js') });
    const controller = new AbortController();

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      signal: controller.signal,
    });

    const worker = FakeWorker.all[0];
    const decodeMsg = worker.postedMessages.find((m) => m.type === 'decode');
    expect(decodeMsg).toBeDefined();
    const requestId = decodeMsg.requestId;

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    // A {type:'cancel', requestId} message was sent to the SAME worker.
    const cancelMsg = worker.postedMessages.find((m) => m.type === 'cancel');
    expect(cancelMsg).toEqual({ type: 'cancel', requestId });

    decoder.finalize();
  });

  it('a late worker response after abort is a harmless no-op (no double-settle)', async () => {
    const decoder = new WorkerTileDecoder({ poolSize: 1, workerUrl: new URL('file:///fake-worker.js') });
    const controller = new AbortController();

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      signal: controller.signal,
    });

    const worker = FakeWorker.all[0];
    const requestId = worker.postedMessages.find((m) => m.type === 'decode').requestId;

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    // The worker "didn't get the memo" in time and responds anyway — must
    // not throw, must not resolve/reject the already-settled promise again.
    expect(() => worker.respond(requestId, { layers: [] })).not.toThrow();
  });

  it('freed slot bookkeeping: an aborted decode lets a new request pick the same worker as least-pending', async () => {
    const decoder = new WorkerTileDecoder({ poolSize: 1, workerUrl: new URL('file:///fake-worker.js') });
    const controller = new AbortController();

    const first = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      signal: controller.signal,
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    // A second decode on the same (pool-size-1) decoder must still dispatch
    // normally — the aborted request's `pending` count was released, not
    // left stuck occupying the worker forever.
    const worker = FakeWorker.all[0];
    const second = decoder.decode({
      id: { z: 1, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
    });
    const secondMsg = worker.postedMessages.filter((m) => m.type === 'decode').at(-1);
    expect(secondMsg).toBeDefined();
    worker.respond(secondMsg.requestId, { layers: [] });
    await expect(second).resolves.toEqual({ layers: [] });

    decoder.finalize();
  });
});
