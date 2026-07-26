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
      signal: controller.signal,
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all[0].postedMessages).toHaveLength(0);

    decoder.finalize();
  });

  it('aborting mid-flight rejects immediately and posts a cancel message to the owning worker', async () => {
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

  it('freed slot bookkeeping: an aborted decode lets a new request pick the same worker as least-pending', async () => {
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
    const secondMsg = worker.postedMessages
      .filter((m) => m.type === 'decode')
      .at(-1);
    expect(secondMsg).toBeDefined();
    worker.respond(secondMsg.requestId, { layers: [] });
    await expect(second).resolves.toEqual({ layers: [] });

    decoder.finalize();
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
      expectedCrc32c: crc32c(EMPTY_FRAME),
    });
    expect(tile.layers).toEqual([]);
  });

  it('hands the decompressed payload back via onPayload on the success path', async () => {
    const decoder = new InlineTileDecoder();
    let handed: Uint8Array | undefined;
    const tile = await decoder.decode({
      id,
      timeRange,
      compressed: emptyFrameBuffer(),
      compression: Compression.None,
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
    });
    const p2 = decoder.decode({
      id: { z: 1, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      compressed: new ArrayBuffer(8),
      compression: Compression.None,
      onPayload: () => {},
    });

    const decodeMsgs = worker.postedMessages.filter((m) => m.type === 'decode');
    expect(decodeMsgs[0].returnPayload).toBe(false); // no onPayload
    expect(decodeMsgs[1].returnPayload).toBe(true); // onPayload supplied

    // finalize() cancels the two still-pending decodes — consume the
    // cancellations so they aren't surfaced as unhandled rejections.
    decoder.finalize();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
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
      formatVersion: 2,
    });
    const msg = worker.postedMessages.find((m) => m.type === 'decode');
    expect(msg.formatVersion).toBe(2);
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
        formatVersion: 2,
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

  it('builds a WorkerTileDecoder when module Workers are available', () => {
    (globalThis as any).Worker = FakeWorker;
    const decoder = createDefaultTileDecoder();
    expect(decoder).toBeInstanceOf(WorkerTileDecoder);
    (decoder as WorkerTileDecoder).finalize();
  });
});
