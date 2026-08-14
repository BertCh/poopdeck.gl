/**
 * Tile-decoder worker pool: respawn-on-crash behaviour.
 *
 * The real Worker constructor is unavailable in Node, so we stub a minimal
 * implementation that lets us drive `onmessage` / `onerror` from the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float64,
  Table,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';

import {
  InlineTileDecoder,
  WorkerTileDecoder,
  createDefaultTileDecoder,
  decidePoolResize,
  type PoolResizeInput,
} from '../src/tile-decoder';
import { crc32c } from '../src/crc32c';
import { Compression } from '../src/types';
import { bufferToArrayBuffer } from './helpers/fixtures';
import {
  buildV2Frame,
  REF_KIND_NO_PROPS,
  REF_KIND_TEMPLATE_HASH,
  SECTION_CORE_BATCH,
  splitIpcTemplate,
  templateHashBytes,
  templateHashHex,
} from './helpers/v2-frame';

/**
 * Smallest valid tile payload frame: a zero-layer frame is just the u16 layer
 * count `0`. `decodeTile` parses it to a tile with `layers: []`, so the inline
 * decode path can run end-to-end without a real Arrow IPC stream.
 */
// A zero-layer frame: the 0xFFFF escape, frame version, flags, count 0.
const EMPTY_FRAME = buildV2Frame([]);
/** `EMPTY_FRAME` bytes as a standalone ArrayBuffer (what `DecodeArgs.compressed` wants). */
const emptyFrameBuffer = (): ArrayBuffer => EMPTY_FRAME.slice().buffer;

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

  /**
   * Simulate the worker's decode response arriving. Pass `payload` to also
   * exercise the decompressed-payload hand-back (the `returnPayload` path).
   */
  respond(requestId: number, tile: unknown, payload?: Uint8Array) {
    const data =
      payload !== undefined
        ? { requestId, tile, payload }
        : { requestId, tile };
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  /** Simulate the worker reporting a decode failure ({requestId, error}). */
  respondError(requestId: number, error: string) {
    this.onmessage?.({ data: { requestId, error } } as MessageEvent<unknown>);
  }

  /**
   * Simulate the worker's CANCEL ACK (BH-5): a cancelled decode returns without
   * a tile, so the worker must still tell the host it is free.
   */
  respondCancelled(requestId: number) {
    this.onmessage?.({
      data: { requestId, cancelled: true },
    } as MessageEvent<unknown>);
  }

  /** Decode messages posted to this worker, in order. */
  decodeMessages(): any[] {
    return this.postedMessages.filter((m) => m.type === 'decode');
  }

  /** Cancel messages posted to this worker, in order. */
  cancelMessages(): any[] {
    return this.postedMessages.filter((m) => m.type === 'cancel');
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
    const decoder = new WorkerTileDecoder({
      poolSize: 2,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    expect(FakeWorker.all).toHaveLength(2);

    const compressed = new ArrayBuffer(8);
    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed,
      compression: Compression.None,
      expectedUncompressedSize: 8,
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
    const decoder = new WorkerTileDecoder({
      poolSize: 3,
      workerUrl: new URL('file:///fake-worker.js'),
    });
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
        expectedUncompressedSize: 8,
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
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const controller = new AbortController();
    controller.abort();

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      signal: controller.signal,
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all[0].postedMessages).toHaveLength(0);

    decoder.finalize();
  });

  it('aborting active work rejects immediately and discards the late result', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const controller = new AbortController();

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      signal: controller.signal,
    });

    const worker = FakeWorker.all[0];
    const decodeMsg = worker.postedMessages.find((m) => m.type === 'decode');
    expect(decodeMsg).toBeDefined();
    const requestId = decodeMsg.requestId;

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    // BH-5 INVERTS the pre-M6 assertion here (it used to expect NO cancel).
    // The mid-pipeline cancel is now wired: the message goes to the ONE worker
    // running THIS request, and the worker checks its cancelled set right after
    // the unavoidable decompress and before the far more expensive IPC parse.
    // It is not "queued behind the work" — it targets the ACTIVE request, which
    // is exactly the distinction the rejected worker-side-cancel-QUEUE design
    // failed to make.
    const cancelMsgs = worker.postedMessages.filter((m) => m.type === 'cancel');
    expect(cancelMsgs).toHaveLength(1);
    expect(cancelMsgs[0].requestId).toBe(requestId);

    worker.respond(requestId, { layers: [] });

    decoder.finalize();
  });

  it('a late worker response after abort is a harmless no-op (no double-settle)', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const controller = new AbortController();

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      signal: controller.signal,
    });

    const worker = FakeWorker.all[0];
    const requestId = worker.postedMessages.find(
      (m) => m.type === 'decode',
    ).requestId;

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    // The worker "didn't get the memo" in time and responds anyway — must
    // not throw, must not resolve/reject the already-settled promise again.
    expect(() => worker.respond(requestId, { layers: [] })).not.toThrow();
  });

  it('active abort holds the worker slot until its late response, then dispatches queued work', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const controller = new AbortController();

    const first = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      signal: controller.signal,
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    // The second decode stays host-queued until the active synchronous work
    // actually returns; posting it earlier is what made cancellation useless.
    const worker = FakeWorker.all[0];
    const second = decoder.decode({
      id: { z: 1, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
    });
    expect(
      worker.postedMessages.filter((m) => m.type === 'decode'),
    ).toHaveLength(1);
    const firstMsg = worker.postedMessages.find((m) => m.type === 'decode');
    worker.respond(firstMsg.requestId, { layers: [] });
    const secondMsg = worker.postedMessages
      .filter((m) => m.type === 'decode')
      .at(-1);
    expect(secondMsg).toBeDefined();
    worker.respond(secondMsg.requestId, { layers: [] });
    await expect(second).resolves.toEqual({ layers: [] });

    decoder.finalize();
  });

  it('removes host-queued work before it is posted', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const worker = FakeWorker.all[0];
    const first = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
    });
    const controller = new AbortController();
    const queued = decoder.decode({
      id: { z: 1, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      signal: controller.signal,
    });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      worker.postedMessages.filter((m) => m.type === 'decode'),
    ).toHaveLength(1);
    const firstMsg = worker.postedMessages.find((m) => m.type === 'decode');
    worker.respond(firstMsg.requestId, { layers: [] });
    await first;
    expect(
      worker.postedMessages.filter((m) => m.type === 'decode'),
    ).toHaveLength(1);
    decoder.finalize();
  });
});

/**
 * M6 / BH-5 — decode priority continuity.
 *
 * The decode stage used to erase everything the request scheduler decided: jobs
 * were bound to a worker at enqueue by least-pending COUNT and served FIFO
 * inside that worker. This suite pins the repair — one pool-wide host queue,
 * pull-on-idle, priority carried through from the fetch stage — plus the two
 * rejected designs that border it (copy-at-enqueue; worker-side cancel queues).
 */
describe('WorkerTileDecoder pool-wide host queue (M6 / BH-5)', () => {
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

  const decodeArgs = (z: number, extra: Record<string, unknown> = {}) => ({
    id: { z, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 1 },
    compressed: new ArrayBuffer(8),
    compression: Compression.None,
    expectedUncompressedSize: 8,
    ...extra,
  });

  it('(1) head-of-line: an idle worker pulls jobs a busy worker used to strand', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 2,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const [a, b] = FakeWorker.all;

    // Four jobs, two workers: A takes #1, B takes #2, the rest wait POOL-WIDE.
    const ps = [1, 2, 3, 4].map((z) => decoder.decode(decodeArgs(z)));
    expect(a.decodeMessages()).toHaveLength(1);
    expect(b.decodeMessages()).toHaveLength(1);

    // A is the slow one and never answers. B answers twice and, because the
    // backlog is pool-wide, B keeps pulling. Under the old least-pending
    // assignment jobs 3 and 4 were bound to A/B at enqueue, so job 3 sat behind
    // A's long decode while B went idle.
    for (let i = 0; i < 2; i++) {
      const msg = b.decodeMessages().at(-1);
      b.respond(msg.requestId, { layers: [] });
      await Promise.resolve();
    }
    expect(a.decodeMessages()).toHaveLength(1);
    expect(b.decodeMessages()).toHaveLength(3);

    // Drain so nothing leaks.
    a.respond(a.decodeMessages()[0].requestId, { layers: [] });
    b.respond(b.decodeMessages().at(-1).requestId, { layers: [] });
    await Promise.all(ps);
    decoder.finalize();
  });

  it('(2) serves by PRIORITY: [5, 1, 3] complete in [1, 3, 5] order', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const w = FakeWorker.all[0];
    // A blocker occupies the single worker so the three below really queue —
    // the first enqueue on an idle pool is pulled immediately by construction.
    const blocker = decoder.decode(decodeArgs(0, { priority: 0 }));
    const jobs = [5, 1, 3].map((p) =>
      decoder.decode(decodeArgs(10 + p, { priority: p })),
    );
    expect(w.decodeMessages()).toHaveLength(1);

    const dispatched: number[] = [];
    w.respond(w.decodeMessages()[0].requestId, { layers: [] });
    await blocker;
    for (let i = 0; i < 3; i++) {
      const msg = w.decodeMessages().at(-1);
      dispatched.push(msg.id.z - 10); // recover the priority we encoded in z
      w.respond(msg.requestId, { layers: [] });
      await Promise.resolve();
    }
    await Promise.all(jobs);
    expect(dispatched).toEqual([1, 3, 5]);
    decoder.finalize();
  });

  it('(3) jobs that declare NO priority keep FIFO order (back-compat)', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const w = FakeWorker.all[0];
    const blocker = decoder.decode(decodeArgs(0));
    // Equal size + no declared priority ⇒ the requestId tiebreak alone orders
    // them, i.e. exactly the pre-BH-5 arrival order.
    const jobs = [1, 2, 3].map((z) => decoder.decode(decodeArgs(z)));

    const order: number[] = [];
    w.respond(w.decodeMessages()[0].requestId, { layers: [] });
    await blocker;
    for (let i = 0; i < 3; i++) {
      const msg = w.decodeMessages().at(-1);
      order.push(msg.id.z);
      w.respond(msg.requestId, { layers: [] });
      await Promise.resolve();
    }
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
    decoder.finalize();
  });

  it('(3b) breaks priority ties SHORTEST-JOB-FIRST (least compressed bytes)', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const w = FakeWorker.all[0];
    const blocker = decoder.decode(decodeArgs(0));
    // Same priority class, different sizes. SJF minimises mean flow time and
    // subsumes the old least-pending-BYTES balancing — with a central queue
    // there is no per-worker assignment left to balance.
    const sizes = [4096, 64, 512];
    const jobs = sizes.map((n, i) =>
      decoder.decode({
        id: { z: i + 1, x: 0, y: 0, t: 0 },
        timeRange: { start: 0, end: 1 },
        compressed: new ArrayBuffer(n),
        compression: Compression.None,
        expectedUncompressedSize: n,
        priority: 7,
      }),
    );

    const order: number[] = [];
    w.respond(w.decodeMessages()[0].requestId, { layers: [] });
    await blocker;
    for (let i = 0; i < 3; i++) {
      const msg = w.decodeMessages().at(-1);
      order.push(msg.id.z);
      w.respond(msg.requestId, { layers: [] });
      await Promise.resolve();
    }
    await Promise.all(jobs);
    expect(order).toEqual([2, 3, 1]); // 64 B, 512 B, 4096 B
    decoder.finalize();
  });

  it('(5) aborting the ACTIVE job posts exactly ONE cancel, to its owner only', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 2,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const [a, b] = FakeWorker.all;
    const ctrl = new AbortController();
    const first = decoder.decode(decodeArgs(1, { signal: ctrl.signal }));
    const second = decoder.decode(decodeArgs(2));
    const ownerMsg = a.decodeMessages()[0];

    ctrl.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    expect(a.cancelMessages()).toEqual([
      { type: 'cancel', requestId: ownerMsg.requestId },
    ]);
    // The OTHER worker — busy with an unrelated job — is never told anything.
    expect(b.cancelMessages()).toEqual([]);

    b.respond(b.decodeMessages()[0].requestId, { layers: [] });
    await second;
    a.respondCancelled(ownerMsg.requestId);
    decoder.finalize();
  });

  it("(5b) the worker's cancel ACK frees its slot — a cancel must not wedge a worker", async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const w = FakeWorker.all[0];
    const ctrl = new AbortController();
    const doomed = decoder.decode(decodeArgs(1, { signal: ctrl.signal }));
    const queued = decoder.decode(decodeArgs(2));
    const doomedId = w.decodeMessages()[0].requestId;

    ctrl.abort();
    await expect(doomed).rejects.toMatchObject({ name: 'AbortError' });
    // Still only one decode posted: the worker is (as far as the host knows)
    // busy, so the second job stays on the host.
    expect(w.decodeMessages()).toHaveLength(1);

    // A cancelled decode returns early WITHOUT a tile response. The ack is the
    // only thing that tells the host the worker is free again; without it the
    // pool would silently lose a slot on every mid-flight cancel.
    w.respondCancelled(doomedId);
    expect(w.decodeMessages()).toHaveLength(2);
    w.respond(w.decodeMessages()[1].requestId, { layers: [] });
    await expect(queued).resolves.toEqual({ layers: [] });
    decoder.finalize();
  });

  it('(6) host-queued jobs SURVIVE a worker crash and finish on the replacement', async () => {
    // INTENTIONAL INVERSION of the pre-M6 contract: host-queued jobs used to
    // fail alongside the worker they had been assigned to at enqueue. With one
    // pool-wide queue they were never that worker's to lose, so the crash blast
    // radius shrinks to the single ACTIVE job.
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const first = FakeWorker.all[0];
    const active = decoder.decode(decodeArgs(1));
    const survivorA = decoder.decode(decodeArgs(2));
    const survivorB = decoder.decode(decodeArgs(3));

    first.crash('boom');
    await expect(active).rejects.toThrow(/worker crashed/i);

    const replacement = FakeWorker.all.find((w) => !w.terminated)!;
    expect(replacement).not.toBe(first);
    // The replacement immediately picked up a survivor — and, per §4.4, only
    // after its template registry.
    expect(replacement.decodeMessages()).toHaveLength(1);
    replacement.respond(replacement.decodeMessages()[0].requestId, {
      layers: [],
    });
    await expect(survivorA).resolves.toEqual({ layers: [] });
    replacement.respond(replacement.decodeMessages()[1].requestId, {
      layers: [],
    });
    await expect(survivorB).resolves.toEqual({ layers: [] });
    decoder.finalize();
  });

  it('(7) finalize rejects host-queued AND active work as cancellations', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const ps = [1, 2, 3].map((z) => decoder.decode(decodeArgs(z)));
    const observed = ps.map((p) => p.catch((e) => e));
    decoder.finalize();
    for (const e of await Promise.all(observed)) {
      expect(e).toMatchObject({ name: 'AbortError' });
    }
    expect(decoder.getPoolStats()).toMatchObject({
      poolSize: 0,
      pendingBytes: 0,
    });
  });

  it('GUARD (rejected design): the compressed buffer is NOT copied at enqueue', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const w = FakeWorker.all[0];
    const blocker = decoder.decode(decodeArgs(0));

    // Instrument slice() on the ONE buffer we care about.
    const buf = new ArrayBuffer(64);
    let sliceCalls = 0;
    (buf as any).slice = function (this: ArrayBuffer, ...a: unknown[]) {
      sliceCalls++;
      return ArrayBuffer.prototype.slice.apply(
        this,
        a as [number?, number?],
      ) as ArrayBuffer;
    };
    const queued = decoder.decode({
      id: { z: 9, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: buf,
      compression: Compression.None,
      expectedUncompressedSize: 64,
    });
    // Copy-at-enqueue is a recorded rejected design: it doubled peak memory for
    // work a worker might never see.
    expect(sliceCalls).toBe(0);

    w.respond(w.decodeMessages()[0].requestId, { layers: [] });
    await blocker;
    // The transferable copy is made at the last responsible moment: the PULL.
    expect(sliceCalls).toBe(1);
    w.respond(w.decodeMessages()[1].requestId, { layers: [] });
    await queued;
    decoder.finalize();
  });

  it('GUARD (rejected design): no cancel is EVER posted for a host-queued job', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const w = FakeWorker.all[0];
    const blocker = decoder.decode(decodeArgs(0));
    const ctrl = new AbortController();
    const queued = decoder.decode(decodeArgs(1, { signal: ctrl.signal }));

    ctrl.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    // Worker-side cancel QUEUEING is rejected: a cancel for work the worker has
    // never seen would sit in its message queue behind the very work it targets.
    // Host-queued cancellation is a splice, not a message.
    expect(w.cancelMessages()).toEqual([]);
    expect(w.decodeMessages()).toHaveLength(1);

    w.respond(w.decodeMessages()[0].requestId, { layers: [] });
    await blocker;
    expect(w.cancelMessages()).toEqual([]);
    expect(w.decodeMessages()).toHaveLength(1); // the dropped job never posted
    decoder.finalize();
  });

  it('DETERMINISM: an identical scripted sequence yields an identical dispatch order', async () => {
    const script: Array<{ z: number; priority?: number; bytes: number }> = [
      { z: 1, priority: 400, bytes: 100 },
      { z: 2, priority: 10, bytes: 900 },
      { z: 3, priority: 10, bytes: 100 },
      { z: 4, bytes: 4000 },
      { z: 5, priority: 400, bytes: 50 },
      { z: 6, priority: 10, bytes: 100 },
    ];
    const run = async (): Promise<number[]> => {
      FakeWorker.all = [];
      FakeWorker.idSeq = 0;
      const decoder = new WorkerTileDecoder({
        poolSize: 1,
        workerUrl: new URL('file:///fake-worker.js'),
      });
      const w = FakeWorker.all[0];
      const ps = script.map((s) =>
        decoder.decode({
          id: { z: s.z, x: 0, y: 0, t: 0 },
          timeRange: { start: 0, end: 1 },
          compressed: new ArrayBuffer(s.bytes),
          compression: Compression.None,
          expectedUncompressedSize: s.bytes,
          ...(s.priority === undefined ? {} : { priority: s.priority }),
        }),
      );
      const order: number[] = [];
      for (let i = 0; i < script.length; i++) {
        const msg = w.decodeMessages().at(-1);
        order.push(msg.id.z);
        w.respond(msg.requestId, { layers: [] });
        await Promise.resolve();
      }
      await Promise.all(ps);
      decoder.finalize();
      return order;
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    // And it really is priority-then-SJF-then-FIFO: z1 was pulled by the idle
    // pool before anything else existed; the rest sort 10s before 400s, and
    // z4 (no priority ⇒ 0) leads its own class.
    expect(first).toEqual([1, 4, 3, 6, 2, 5]);
  });
});

/**
 * M6 / BH-6 — decode pool sizing adapted from queue-wait telemetry.
 *
 * `m = max(1, min(4, cores − 1))` was the permanent answer to a question only
 * provisioning can answer; the queue-wait samples §10.1 names were emitted and
 * never fed back. The controller closes that loop. `m ∈ [1, cores − 1]` is a
 * HARD bound — the render core stays reserved.
 */
describe('WorkerTileDecoder adaptive pool sizing (M6 / BH-6)', () => {
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

  const base: PoolResizeInput = {
    poolSize: 2,
    maxPoolSize: 7,
    queueWaitEwmaMs: 0,
    serviceEwmaMs: 10,
    samplesSinceResize: 100,
    idleMs: null,
  };

  describe('decidePoolResize (pure)', () => {
    it('holds until the sustain window has passed', () => {
      const hot = { ...base, queueWaitEwmaMs: 100, samplesSinceResize: 7 };
      expect(decidePoolResize(hot)).toBe('hold');
      expect(decidePoolResize({ ...hot, samplesSinceResize: 8 })).toBe('grow');
    });

    it('grows on queue-wait dominance but NEVER past cores − 1', () => {
      const hot = { ...base, queueWaitEwmaMs: 100 };
      expect(decidePoolResize(hot)).toBe('grow');
      expect(decidePoolResize({ ...hot, poolSize: 7 })).toBe('hold');
      expect(decidePoolResize({ ...hot, poolSize: 1, maxPoolSize: 1 })).toBe(
        'hold',
      );
    });

    it('ignores sub-millisecond wait noise on a near-zero service time', () => {
      // service 0 would make ANY wait "dominant" without the absolute floor.
      expect(
        decidePoolResize({
          ...base,
          serviceEwmaMs: 0,
          queueWaitEwmaMs: 0.4,
        }),
      ).toBe('hold');
      expect(
        decidePoolResize({ ...base, serviceEwmaMs: 0, queueWaitEwmaMs: 2 }),
      ).toBe('grow');
    });

    it('shrinks only when a worker has been idle AND the wait is far below service', () => {
      const cold = { ...base, queueWaitEwmaMs: 1, idleMs: 6000 };
      expect(decidePoolResize(cold)).toBe('shrink');
      // Not idle long enough.
      expect(decidePoolResize({ ...cold, idleMs: 4999 })).toBe('hold');
      // Every worker busy ⇒ nothing to retire.
      expect(decidePoolResize({ ...cold, idleMs: null })).toBe('hold');
      // Never below one worker.
      expect(decidePoolResize({ ...cold, poolSize: 1 })).toBe('hold');
    });

    it('HYSTERESIS: the band between the two ratios does nothing in either direction', () => {
      for (const q of [2.6, 5, 10, 14.9]) {
        // 0.25×10 = 2.5 < q < 15 = 1.5×10
        expect(
          decidePoolResize({ ...base, queueWaitEwmaMs: q, idleMs: 60_000 }),
        ).toBe('hold');
      }
    });

    it('is a PURE function of its inputs (same stream ⇒ same decisions)', () => {
      const stream: PoolResizeInput[] = [
        { ...base, queueWaitEwmaMs: 100 },
        { ...base, queueWaitEwmaMs: 1, idleMs: 9000 },
        { ...base, queueWaitEwmaMs: 5, idleMs: 9000 },
        { ...base, samplesSinceResize: 0, queueWaitEwmaMs: 100 },
      ];
      const a = stream.map(decidePoolResize);
      const b = stream.map(decidePoolResize);
      expect(b).toEqual(a);
      expect(a).toEqual(['grow', 'shrink', 'hold', 'hold']);
    });
  });

  /**
   * Drive a decoder with a fake clock. Returns helpers that answer the oldest
   * outstanding decode on whichever worker holds it.
   */
  function harness(opts: { cores: number; poolSize?: number }) {
    let t = 0;
    const decoder = new WorkerTileDecoder({
      ...(opts.poolSize === undefined ? {} : { poolSize: opts.poolSize }),
      cores: opts.cores,
      now: () => t,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const answered = new Set<number>();
    const outstanding = (): Array<{ w: FakeWorker; requestId: number }> => {
      const out: Array<{ w: FakeWorker; requestId: number }> = [];
      for (const w of FakeWorker.all) {
        if (w.terminated) continue;
        for (const m of w.decodeMessages()) {
          if (!answered.has(m.requestId))
            out.push({ w, requestId: m.requestId });
        }
      }
      return out;
    };
    return {
      decoder,
      advance: (ms: number) => {
        t += ms;
      },
      now: () => t,
      outstanding,
      answerOne: async (): Promise<boolean> => {
        const [next] = outstanding();
        if (!next) return false;
        answered.add(next.requestId);
        next.w.respond(next.requestId, { layers: [] });
        await Promise.resolve();
        return true;
      },
    };
  }

  const job = (decoder: WorkerTileDecoder, z: number) =>
    decoder.decode({
      id: { z, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
    });

  it('(1) sustained queue-wait dominance GROWS the pool, capped at cores − 1', async () => {
    const h = harness({ cores: 8 }); // max 7, initial min(4, 7) = 4
    expect(FakeWorker.all).toHaveLength(4);
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i++) ps.push(job(h.decoder, i).catch(() => {}));

    // Every completion costs 10 ms of service while the deep backlog keeps
    // waiting, so queue wait climbs far past 1.5× service and stays there.
    for (let i = 0; i < 200; i++) {
      h.advance(10);
      if (!(await h.answerOne())) break;
    }
    const size = h.decoder.getPoolStats().poolSize;
    expect(size).toBeGreaterThan(4); // the fixed rule's answer was 4, forever
    // HARD BOUND: the render-core reservation is never spent.
    expect(size).toBe(7);
    expect(FakeWorker.all.filter((w) => !w.terminated)).toHaveLength(7);
    h.decoder.finalize();
    await Promise.all(ps);
  });

  it('(1b) a pool already at cores − 1 does NOT grow, however bad the wait', async () => {
    const h = harness({ cores: 5 }); // max 4, initial min(4, 4) = 4 — at the cap
    expect(FakeWorker.all).toHaveLength(4);
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 80; i++) ps.push(job(h.decoder, i).catch(() => {}));
    for (let i = 0; i < 80; i++) {
      h.advance(25);
      if (!(await h.answerOne())) break;
    }
    expect(h.decoder.getPoolStats().poolSize).toBe(4);
    h.decoder.finalize();
    await Promise.all(ps);
  });

  it('(4) an explicit poolSize PINS the pool — the controller never fires', async () => {
    const h = harness({ cores: 16, poolSize: 1 });
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) ps.push(job(h.decoder, i).catch(() => {}));
    for (let i = 0; i < 40; i++) {
      h.advance(50); // brutal queue-wait dominance
      if (!(await h.answerOne())) break;
    }
    expect(h.decoder.getPoolStats().poolSize).toBe(1);
    expect(FakeWorker.all.filter((w) => !w.terminated)).toHaveLength(1);
    h.decoder.finalize();
    await Promise.all(ps);
  });

  it('(2) idle SHRINK retires only workers holding no active job, and never below 1', async () => {
    const h = harness({ cores: 9 }); // max 8, initial 4
    expect(FakeWorker.all).toHaveLength(4);
    // Strictly serial load: only workers[0] is ever pulled to, so 1..3 sit at
    // lastPullAt = 0 forever.
    for (let i = 0; i < 40; i++) {
      const p = job(h.decoder, i);
      h.advance(1000); // service time; also ages the idle workers
      const busy = FakeWorker.all.filter(
        (w) => !w.terminated && w.decodeMessages().length > 0,
      );
      await h.answerOne();
      await p;
      // The worker that just ran is never the retired one (it is the least
      // idle), and a terminated worker never held an unanswered decode.
      for (const w of busy) {
        if (w.terminated) {
          expect(w.decodeMessages().length).toBeGreaterThan(0);
        }
      }
    }
    const stats = h.decoder.getPoolStats();
    expect(stats.poolSize).toBeLessThan(4);
    expect(stats.poolSize).toBeGreaterThanOrEqual(1);
    h.decoder.finalize();
  });

  it('(3) a GROWN worker receives the template registry before any decode', async () => {
    const h = harness({ cores: 6 }); // max 5, initial 4
    const registry = new Map<string, Uint8Array>([
      ['00112233445566778899aabbccddeeff', Uint8Array.from([7])],
    ]);
    h.decoder.setTemplates(registry);
    const before = FakeWorker.all.length;

    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) ps.push(job(h.decoder, i).catch(() => {}));
    for (let i = 0; i < 40; i++) {
      h.advance(10);
      if (!(await h.answerOne())) break;
    }
    const grown = FakeWorker.all.slice(before);
    expect(grown.length).toBeGreaterThan(0);
    for (const w of grown) {
      // §4.4 distribution contract holds for controller-spawned workers too.
      expect(w.postedMessages[0].type).toBe('templates');
      const types = w.postedMessages.map((m) => m.type);
      if (types.includes('decode')) {
        expect(types.indexOf('templates')).toBeLessThan(
          types.indexOf('decode'),
        );
      }
    }
    h.decoder.finalize();
    await Promise.all(ps);
  });

  it('(5) HYSTERESIS: an oscillating load does not flap the pool', () => {
    // Replay the controller over a load that swings across the middle of the
    // band. Neither threshold is crossed, so the size is constant.
    let poolSize = 3;
    const decisions: string[] = [];
    for (let i = 0; i < 40; i++) {
      const wait = i % 2 === 0 ? 4 : 12; // 0.25×10=2.5 < wait < 1.5×10=15
      const d = decidePoolResize({
        poolSize,
        maxPoolSize: 7,
        queueWaitEwmaMs: wait,
        serviceEwmaMs: 10,
        samplesSinceResize: 50,
        idleMs: 60_000,
      });
      decisions.push(d);
      if (d === 'grow') poolSize++;
      if (d === 'shrink') poolSize--;
    }
    expect(new Set(decisions)).toEqual(new Set(['hold']));
    expect(poolSize).toBe(3);
  });

  it('SIMULATION: arrivals at ~2× single-worker service settle the pool at 2–3', () => {
    // Deterministic LCG → exponential-ish interarrivals; fixed service time.
    // No wall clock anywhere: the controller only ever sees injected numbers.
    let seed = 20260810;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const SERVICE = 10;
    const MEAN_GAP = SERVICE / 2; // offered load ≈ 2 servers' worth
    const ALPHA = 0.2;
    const ewma = (prev: number, x: number) =>
      prev === 0 ? x : prev + ALPHA * (x - prev);

    let poolSize = 1;
    const maxPoolSize = 7;
    let queueWaitEwma = 0;
    let serviceEwma = 0;
    let samplesSinceResize = 0;
    // Busy-until timestamps, one per worker.
    let free: number[] = [0];
    const sizes: number[] = [];
    let t = 0;
    for (let n = 0; n < 4000; n++) {
      t += -MEAN_GAP * Math.log(1 - rand());
      // Earliest-free worker takes it.
      free.sort((a, b) => a - b);
      const start = Math.max(t, free[0]);
      free[0] = start + SERVICE;
      queueWaitEwma = ewma(queueWaitEwma, start - t);
      serviceEwma = ewma(serviceEwma, SERVICE);
      samplesSinceResize++;
      const idleMs = free.some((f) => f <= t) ? 6000 : null;
      const d = decidePoolResize({
        poolSize,
        maxPoolSize,
        queueWaitEwmaMs: queueWaitEwma,
        serviceEwmaMs: serviceEwma,
        samplesSinceResize,
        idleMs,
      });
      if (d === 'grow') {
        poolSize++;
        free.push(t);
        samplesSinceResize = 0;
      } else if (d === 'shrink') {
        poolSize--;
        free = free.slice(0, poolSize);
        samplesSinceResize = 0;
      }
      if (n > 3000) sizes.push(poolSize);
    }
    const settled = sizes[sizes.length - 1];
    expect(settled).toBeGreaterThanOrEqual(2);
    expect(settled).toBeLessThanOrEqual(4);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(maxPoolSize);
  });
});

describe('InlineTileDecoder integrity gate + payload hand-back', () => {
  const id = { z: 0, x: 0, y: 0, t: 0 };
  const timeRange = { start: 0, end: 1 };

  it('verifies the CRC BEFORE decompressing and rejects on mismatch', async () => {
    const decoder = new InlineTileDecoder();
    await expect(
      decoder.decode({
        id,
        timeRange,
        compressed: emptyFrameBuffer(),
        compression: Compression.None,
        expectedUncompressedSize: EMPTY_FRAME.length,
        expectedCrc32c: 0xdeadbeef, // not the CRC of EMPTY_FRAME
      }),
    ).rejects.toThrow(/crc32c mismatch/i);
  });

  it('passes the integrity gate and decodes when the CRC matches', async () => {
    const decoder = new InlineTileDecoder();
    const tile = await decoder.decode({
      id,
      timeRange,
      compressed: emptyFrameBuffer(),
      compression: Compression.None,
      expectedUncompressedSize: EMPTY_FRAME.length,
      expectedCrc32c: crc32c(EMPTY_FRAME),
    });
    expect(tile.layers).toEqual([]);
  });

  it('rejects when decoded bytes disagree with directory uncompressedSize', async () => {
    const decoder = new InlineTileDecoder();
    await expect(
      decoder.decode({
        id,
        timeRange,
        compressed: emptyFrameBuffer(),
        compression: Compression.None,
        expectedUncompressedSize: EMPTY_FRAME.length + 1,
      }),
    ).rejects.toThrow(/payload length mismatch/i);
  });

  it('hands the decompressed payload back via onPayload on the success path', async () => {
    const decoder = new InlineTileDecoder();
    let handed: Uint8Array | undefined;
    const tile = await decoder.decode({
      id,
      timeRange,
      compressed: emptyFrameBuffer(),
      compression: Compression.None,
      expectedUncompressedSize: EMPTY_FRAME.length,
      onPayload: (p) => {
        handed = p;
      },
    });
    expect(tile.layers).toEqual([]);
    // For Compression.None the decompressed payload is the frame bytes verbatim.
    expect(handed).toBeInstanceOf(Uint8Array);
    expect(Array.from(handed!)).toEqual(Array.from(EMPTY_FRAME));
  });
});

describe('WorkerTileDecoder payload hand-back + error branch', () => {
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

  it('requests returnPayload only when the caller supplies onPayload', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const worker = FakeWorker.all[0];

    const p1 = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
    });
    const p2 = decoder.decode({
      id: { z: 1, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      onPayload: () => {},
    });

    let decodeMsgs = worker.postedMessages.filter((m) => m.type === 'decode');
    expect(decodeMsgs[0].returnPayload).toBe(false); // no onPayload
    worker.respond(decodeMsgs[0].requestId, { layers: [] });
    await p1;
    decodeMsgs = worker.postedMessages.filter((m) => m.type === 'decode');
    expect(decodeMsgs[1].returnPayload).toBe(true); // onPayload supplied

    // finalize() cancels the second still-pending decode.
    decoder.finalize();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('invokes onPayload with the worker-returned payload before resolving', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const worker = FakeWorker.all[0];
    const payload = Uint8Array.from([1, 2, 3, 4]);
    const seen: Array<'payload' | 'resolve'> = [];

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      onPayload: (p) => {
        seen.push('payload');
        expect(Array.from(p)).toEqual([1, 2, 3, 4]);
      },
    });

    const requestId = worker.postedMessages.find(
      (m) => m.type === 'decode',
    ).requestId;
    worker.respond(requestId, { layers: [] }, payload);
    const tile = await promise;
    seen.push('resolve');

    expect(tile).toEqual({ layers: [] });
    // Hand-back fires BEFORE the promise settles (OPFS-reuse ordering contract).
    expect(seen).toEqual(['payload', 'resolve']);

    decoder.finalize();
  });

  it('rejects with the worker-reported error message', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const worker = FakeWorker.all[0];

    const promise = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
    });

    const requestId = worker.postedMessages.find(
      (m) => m.type === 'decode',
    ).requestId;
    worker.respondError(requestId, 'tableFromIPC blew up');
    await expect(promise).rejects.toThrow('tableFromIPC blew up');

    decoder.finalize();
  });
});

describe('WorkerTileDecoder template-registry distribution (packed v2 §4.4)', () => {
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

  const registry = new Map<string, Uint8Array>([
    ['00112233445566778899aabbccddeeff', Uint8Array.from([1, 2, 3])],
  ]);

  it('broadcasts the registry to EVERY live worker on setTemplates', () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 3,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    decoder.setTemplates(registry);
    for (const w of FakeWorker.all) {
      const msg = w.postedMessages.find((m) => m.type === 'templates');
      expect(msg, `worker ${w.id}`).toBeDefined();
      // The decoder broadcasts its own (merged) map — same entries, but a
      // decoder-owned object so later installs can't mutate archive state.
      expect(msg.templates).not.toBe(registry);
      expect([...msg.templates.entries()]).toEqual([...registry.entries()]);
    }
    decoder.finalize();
  });

  it('setTemplates MERGES registries — two archives sharing one decoder keep both resolvable', () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const other = new Map<string, Uint8Array>([
      ['ffeeddccbbaa99887766554433221100', Uint8Array.from([9, 9])],
    ]);
    decoder.setTemplates(registry);
    decoder.setTemplates(other); // second archive's install must not clobber
    const worker = FakeWorker.all[0];
    const last = worker.postedMessages
      .filter((m) => m.type === 'templates')
      .at(-1);
    expect([...last.templates.keys()].sort()).toEqual(
      [...registry.keys(), ...other.keys()].sort(),
    );

    // Respawn re-sends the UNION as the replacement's first message.
    worker.crash('boom');
    const replacement = FakeWorker.all.find((w) => !w.terminated)!;
    expect(replacement.postedMessages[0].type).toBe('templates');
    expect([...replacement.postedMessages[0].templates.keys()].sort()).toEqual(
      [...registry.keys(), ...other.keys()].sort(),
    );
    decoder.finalize();
  });

  it('re-sends the registry to a crash-respawned worker BEFORE any decode dispatch', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    decoder.setTemplates(registry);
    const first = FakeWorker.all[0];

    const doomed = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
    });
    first.crash('boom');
    await expect(doomed).rejects.toThrow(/worker crashed/i);

    // The replacement worker holds the registry as its FIRST message —
    // the respawn-safety half of the §4.4 contract.
    const replacement = FakeWorker.all.find((w) => !w.terminated)!;
    expect(replacement.postedMessages[0]).toEqual({
      type: 'templates',
      templates: registry,
    });

    // A decode dispatched to the replacement necessarily queues AFTER it.
    const next = decoder.decode({
      id: { z: 1, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
    });
    const types = replacement.postedMessages.map((m) => m.type);
    expect(types.indexOf('templates')).toBeLessThan(types.indexOf('decode'));
    const decodeMsg = replacement.postedMessages.find(
      (m) => m.type === 'decode',
    );
    replacement.respond(decodeMsg.requestId, { layers: [] });
    await expect(next).resolves.toEqual({ layers: [] });

    decoder.finalize();
  });

  it('a worker spawned AFTER setTemplates still receives the registry (spawn-time send)', () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 2,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    decoder.setTemplates(registry);
    FakeWorker.all[1].crash('boom');
    const spawned = FakeWorker.all[2];
    expect(spawned.postedMessages[0]).toEqual({
      type: 'templates',
      templates: registry,
    });
    decoder.finalize();
  });

  it('forwards the declared formatVersion on every decode message (authority rule)', async () => {
    const decoder = new WorkerTileDecoder({
      poolSize: 1,
      workerUrl: new URL('file:///fake-worker.js'),
    });
    const worker = FakeWorker.all[0];
    const p = decoder.decode({
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      expectedUncompressedSize: 8,
      formatVersion: 3,
      variants: [{ id: 0, kind: 'raw' }],
    });
    const msg = worker.postedMessages.find((m) => m.type === 'decode');
    expect(msg.formatVersion).toBe(3);
    expect(msg.expectedUncompressedSize).toBe(8);
    decoder.finalize();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('InlineTileDecoder template-registry merge (two v2 archives, one decoder)', () => {
  /**
   * Minimal decodable v2 layer: a Float64 point-geometry core batch whose
   * schema differs per `propName` (distinct numeric column → distinct
   * template hash), assembled as a hash-referencing frame.
   */
  function hashFrameFor(propName: string): {
    frame: Uint8Array;
    registry: Map<string, Uint8Array>;
  } {
    const geom = vectorFromArray(
      [[-122.4, 37.7]],
      new FixedSizeList(2, new Field('xy', new Float64(), false)),
    );
    const table = new Table({
      geometry: geom,
      [propName]: vectorFromArray([1.5], new Float64()),
    });
    const ipc = tableToIPC(table, 'stream');
    const { template, tail } = splitIpcTemplate(ipc);
    const frame = buildV2Frame([
      {
        name: 'default',
        refCore: {
          kind: REF_KIND_TEMPLATE_HASH,
          hash: templateHashBytes(template),
        },
        refProps: { kind: REF_KIND_NO_PROPS },
        sections: [[SECTION_CORE_BATCH, tail]],
      },
    ]);
    return {
      frame,
      registry: new Map([[templateHashHex(template), template]]),
    };
  }

  it('decodes tiles from BOTH archives after their registries install sequentially', async () => {
    const a = hashFrameFor('speed');
    const b = hashFrameFor('heading');
    const decoder = new InlineTileDecoder();
    decoder.setTemplates(a.registry); // archive A opens…
    decoder.setTemplates(b.registry); // …then archive B, sharing the decoder

    const decode = (frame: Uint8Array, z: number) =>
      decoder.decode({
        id: { z, x: 0, y: 0, t: 0 },
        timeRange: { start: 0, end: 1 },
        compressed: bufferToArrayBuffer(frame),
        compression: Compression.None,
        expectedUncompressedSize: frame.length,
        formatVersion: 3,
        variants: [{ id: 0, kind: 'raw' }],
      });

    // Before the union-merge fix, B's install REPLACED the registry and A's
    // template hash stopped resolving ("not in the dataset's registry").
    const tileA = await decode(a.frame, 1);
    expect(Array.from(tileA.layers[0].features.numericProps.speed)).toEqual([
      1.5,
    ]);
    const tileB = await decode(b.frame, 2);
    expect(Array.from(tileB.layers[0].features.numericProps.heading)).toEqual([
      1.5,
    ]);
  });
});

describe('createDefaultTileDecoder fallbacks', () => {
  let originalWorker: any;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FakeWorker.all = [];
    FakeWorker.idSeq = 0;
    originalWorker = (globalThis as any).Worker;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as any).Worker = originalWorker;
    warnSpy.mockRestore();
  });

  it('falls back to inline decode when Worker is undefined', () => {
    (globalThis as any).Worker = undefined;
    const decoder = createDefaultTileDecoder();
    expect(decoder).toBeInstanceOf(InlineTileDecoder);
  });

  it('falls back to inline decode when the Worker constructor throws', () => {
    class ThrowingWorker {
      constructor() {
        throw new Error('module workers unsupported here');
      }
    }
    (globalThis as any).Worker = ThrowingWorker;
    const decoder = createDefaultTileDecoder();
    expect(decoder).toBeInstanceOf(InlineTileDecoder);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('builds shared worker-pool leases when module Workers are available', () => {
    (globalThis as any).Worker = FakeWorker;
    const first = createDefaultTileDecoder();
    const workerCount = FakeWorker.all.length;
    const second = createDefaultTileDecoder();
    expect(workerCount).toBeGreaterThan(0);
    expect(FakeWorker.all).toHaveLength(workerCount);
    first.finalize();
    expect(FakeWorker.all.some((worker) => !worker.terminated)).toBe(true);
    second.finalize();
    expect(FakeWorker.all.every((worker) => worker.terminated)).toBe(true);
  });
});
