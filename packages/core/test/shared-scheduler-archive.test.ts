/**
 * Integration test: TWO STTArchives sharing the process-shared
 * SharedRequestScheduler (multi-source coordination, Phase 2 — integration;
 * docs/roadmap/playback-and-loading.md §5).
 *
 * Proves the two non-negotiable Phase-2 contracts:
 *   (a) the GLOBAL concurrency cap is never exceeded across BOTH archives;
 *   (b) neither archive starves the other (Deficit-Round-Robin fair share).
 *
 * Each archive is given K tiles spread one-per-pack with a zero coalesce gap, so
 * every tile becomes its own coalesced range-group = one scheduled unit. A
 * GATED fetch lets the test hold range requests in flight and observe the
 * scheduler's slot allocation precisely (no real timers, deterministic).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { STTArchive } from '../src/archive';
import { crc32c } from '../src/crc32c';
import { encodeDirectory } from '../src/directory';
import {
  configureSharedScheduler,
  resetSharedScheduler,
  getSharedScheduler,
} from '../src/shared-scheduler';
import {
  OBJECT_MAGIC_LEN,
  directoryKey,
  packObject,
  packKey,
  directoryObject,
  packedFromGolden,
} from './helpers/packed-fixture';
import { bufferToArrayBuffer, flush } from './helpers/fixtures';

const DATASET = packedFromGolden();
const DATASET_PACK_KEYS = [...DATASET.objects.keys()]
  .filter((k) => k.startsWith('packs/'))
  .sort();

/** Pull the fixture's first decodable blob + its metadata once. */
async function fixtureBlobAndMeta(): Promise<{
  blob: Uint8Array;
  meta: any;
  e: any;
}> {
  const idx = await new STTArchive({
    url: DATASET.manifestUrl,
    fetch: memFetch(DATASET.objects, DATASET.manifestUrl),
  }).getIndex();
  const e = idx.tiles[0];
  const srcPack = DATASET.objects.get(DATASET_PACK_KEYS[e.packId])!;
  const blob = srcPack.subarray(e.offset, e.offset + e.length);
  const meta = JSON.parse(
    new TextDecoder().decode(DATASET.objects.get('manifest.json')!),
  ).metadata;
  return { blob, meta, e };
}

/**
 * Build an in-memory packed dataset with `k` tiles, one blob per pack (so a
 * zero coalesce gap makes every tile its own range-group), reusing the fixture's
 * decodable blob so the decoder is happy.
 */
function makeDataset(
  k: number,
  blob: Uint8Array,
  meta: any,
  e: any,
): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  const packRefs: Array<{ key: string; length: number }> = [];
  const entries: any[] = [];
  for (let i = 0; i < k; i++) {
    const { bytes: basePack } = packObject([blob]);
    const packBytes = new Uint8Array(basePack.length + 1);
    packBytes.set(basePack);
    packBytes[basePack.length] = i;
    const key = packKey(packBytes);
    objects.set(key, packBytes);
    packRefs.push({ key, length: packBytes.length });
    entries.push({
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: i,
      timeEnd: i,
      packId: i,
      offset: OBJECT_MAGIC_LEN,
      length: blob.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: i,
      // Real blob decoded through the verifying reader → true CRC-32C.
      crc32c: crc32c(blob),
      temporalBucketMs: e.temporalBucketMs,
    });
  }
  const dir = encodeDirectory(entries);
  const dirObject = directoryObject(dir);
  const dKey = directoryKey(dirObject);
  objects.set(dKey, dirObject);
  const manifest = {
    format: 'stt-packed',
    formatVersion: 3,
    variants: [{ id: 0, kind: 'raw' }],
    compression: 'zstd',
    directory: {
      key: dKey,
      length: dirObject.length,
      directoryVersion: 6,
    },
    packs: packRefs,
    metadata: meta,
  };
  objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  return objects;
}

/** A plain (ungated) in-memory fetch — whole GET → 200, Range → 206. */
function memFetch(
  objects: Map<string, Uint8Array>,
  manifestUrl: string,
): typeof fetch {
  const slash = manifestUrl.lastIndexOf('/');
  const base = slash >= 0 ? manifestUrl.slice(0, slash + 1) : '';
  return (async (url: string, init?: RequestInit) => {
    const key = url.startsWith(base) ? url.slice(base.length) : url;
    const bytes = objects.get(key);
    if (!bytes) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bufferToArrayBuffer(bytes),
      };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    const contentRange = `bytes ${start}-${end}/${bytes.length}`;
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      headers: {
        get: (n: string) =>
          n.toLowerCase() === 'content-range' ? contentRange : null,
      },
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
}

/**
 * A GATED in-memory fetch: range requests block until `release()` is called for
 * each. Whole GETs (manifest/directory) resolve immediately so getIndex() is
 * not gated. Tracks concurrent range requests (and per-source via the path's
 * dataset prefix). The `tag` distinguishes the two archives' fetches.
 */
function gatedFetch(
  objects: Map<string, Uint8Array>,
  manifestUrl: string,
  tag: string,
  shared: SharedGate,
): typeof fetch {
  const slash = manifestUrl.lastIndexOf('/');
  const base = slash >= 0 ? manifestUrl.slice(0, slash + 1) : '';
  return (async (url: string, init?: RequestInit) => {
    const key = url.startsWith(base) ? url.slice(base.length) : url;
    const bytes = objects.get(key)!;
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bufferToArrayBuffer(bytes),
      };
    }
    // Enter the gate: bump concurrency, then block until released.
    shared.dispatchOrder.push(tag);
    shared.inFlight++;
    shared.peak = Math.max(shared.peak, shared.inFlight);
    shared.perSourceInFlight.set(
      tag,
      (shared.perSourceInFlight.get(tag) ?? 0) + 1,
    );
    shared.perSourcePeak.set(
      tag,
      Math.max(
        shared.perSourcePeak.get(tag) ?? 0,
        shared.perSourceInFlight.get(tag)!,
      ),
    );
    await new Promise<void>((resolve) => {
      shared.gates.push(resolve);
      const cb = shared.onEnter.shift();
      if (cb) cb();
    });
    shared.inFlight--;
    shared.perSourceInFlight.set(
      tag,
      (shared.perSourceInFlight.get(tag) ?? 1) - 1,
    );
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    const contentRange = `bytes ${start}-${end}/${bytes.length}`;
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      headers: {
        get: (n: string) =>
          n.toLowerCase() === 'content-range' ? contentRange : null,
      },
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
}

/** A shared gate/concurrency tracker for the gated fetch. */
interface SharedGate {
  inFlight: number;
  peak: number;
  perSourceInFlight: Map<string, number>;
  perSourcePeak: Map<string, number>;
  gates: Array<() => void>;
  onEnter: Array<() => void>;
  /** Source tag (in dispatch order) for each request that ENTERED the gate. */
  dispatchOrder: string[];
}

function newShared(): SharedGate {
  return {
    inFlight: 0,
    peak: 0,
    perSourceInFlight: new Map(),
    perSourcePeak: new Map(),
    gates: [],
    onEnter: [],
    dispatchOrder: [],
  };
}

/**
 * Release every gated request as it appears until `done` settles. Runs as a
 * background pump (no fixed iteration count), so it can't break early while
 * requests are still merely QUEUED in the scheduler (not yet at a gate).
 */
async function drainUntil(
  shared: SharedGate,
  done: Promise<unknown>,
): Promise<void> {
  let finished = false;
  done.finally(() => {
    finished = true;
  });
  while (!finished) {
    const gate = shared.gates.shift();
    if (gate) gate();
    await flush();
  }
  // Release any stragglers that entered the gate during the final flush.
  while (shared.gates.length > 0) {
    shared.gates.shift()!();
    await flush();
  }
}

/**
 * Attach a rejection observer SYNCHRONOUSLY so a promise that rejects mid-test
 * (before the test awaits it) never registers as an unhandled rejection. Returns
 * a getter for the captured reason; throws if the promise resolved instead.
 */
function captureRejection(p: Promise<unknown>): () => Promise<unknown> {
  let settled: { ok: boolean; value: unknown } | undefined;
  const observed = p.then(
    (v) => {
      settled = { ok: true, value: v };
    },
    (e) => {
      settled = { ok: false, value: e };
    },
  );
  return async () => {
    await observed;
    if (!settled || settled.ok)
      throw new Error('expected promise to reject, but it resolved');
    return settled.value;
  };
}

describe('STTArchive + SharedRequestScheduler (Phase 2 integration)', () => {
  beforeEach(() => resetSharedScheduler());
  afterEach(() => resetSharedScheduler());

  it('(a) never exceeds the GLOBAL cap across two archives', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const GLOBAL = 5;
    const K = 8;
    configureSharedScheduler({ enabled: true, maxRequests: GLOBAL });

    const urlA = 'mem://a/manifest.json';
    const urlB = 'mem://b/manifest.json';
    const objA = makeDataset(K, blob, meta, e);
    const objB = makeDataset(K, blob, meta, e);

    const shared = newShared();
    const aA = new STTArchive({
      url: urlA,
      fetch: gatedFetch(objA, urlA, 'A', shared),
      coalesceGapBytes: 0,
    });
    const aB = new STTArchive({
      url: urlB,
      fetch: gatedFetch(objB, urlB, 'B', shared),
      coalesceGapBytes: 0,
    });

    const idsA = (await aA.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const idsB = (await aB.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));

    const pA = aA.getTiles(idsA);
    const pB = aB.getTiles(idsB);
    const both = Promise.all([pA, pB]);

    // Drain the gate, releasing one blocked request at a time. At every instant
    // the in-flight count must stay ≤ the global budget — even though the two
    // archives together asked for 2·K = 16 range-groups.
    let finished = false;
    both.finally(() => {
      finished = true;
    });
    while (!finished) {
      await flush();
      expect(shared.inFlight).toBeLessThanOrEqual(GLOBAL);
      const gate = shared.gates.shift();
      if (gate) gate();
    }
    while (shared.gates.length > 0) {
      shared.gates.shift()!();
      await flush();
    }

    const [ra, rb] = await both;
    expect(ra.every((t) => t !== null)).toBe(true);
    expect(rb.every((t) => t !== null)).toBe(true);
    expect(shared.peak).toBeLessThanOrEqual(GLOBAL);
    expect(shared.peak).toBeGreaterThan(1); // it really did run concurrently
  });

  it('(b) neither archive starves the other (DRR fair share)', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const GLOBAL = 4;
    const K = 10;
    // Equal weights → roughly equal slot share; the key invariant is that while
    // BOTH have work queued, BOTH appear in flight (one source can't monopolize
    // every slot for the whole drain).
    configureSharedScheduler({ enabled: true, maxRequests: GLOBAL });

    const urlA = 'mem://fa/manifest.json';
    const urlB = 'mem://fb/manifest.json';
    const objA = makeDataset(K, blob, meta, e);
    const objB = makeDataset(K, blob, meta, e);

    const shared = newShared();
    const aA = new STTArchive({
      url: urlA,
      fetch: gatedFetch(objA, urlA, 'A', shared),
      coalesceGapBytes: 0,
      schedulerWeight: 1,
    });
    const aB = new STTArchive({
      url: urlB,
      fetch: gatedFetch(objB, urlB, 'B', shared),
      coalesceGapBytes: 0,
      schedulerWeight: 1,
    });

    const idsA = (await aA.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const idsB = (await aB.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));

    // A is enqueued first, so it fills the budget before B even enqueues — that
    // is NOT starvation (B just arrived second). The DRR guarantee is about how
    // slots are shared AS THEY FREE: with equal weights, A must NOT drain its
    // entire queue before B gets dispatched. We release one slot at a time and
    // record dispatch order; B's first dispatch must land well before A's last.
    const pA = aA.getTiles(idsA);
    const pB = aB.getTiles(idsB);
    const both = Promise.all([pA, pB]);
    // Synchronously observe both so an assertion failure can't leak a rejection.
    const settled = both.then(
      (v) => ({ ok: true as const, v }),
      (err) => ({ ok: false as const, err }),
    );

    try {
      // Drain slot-by-slot, releasing the oldest gated request each step.
      let finished = false;
      both.finally(() => {
        finished = true;
      });
      while (!finished) {
        const gate = shared.gates.shift();
        if (gate) gate();
        await flush();
        expect(shared.inFlight).toBeLessThanOrEqual(GLOBAL);
      }
      while (shared.gates.length > 0) {
        shared.gates.shift()!();
        await flush();
      }

      const order = shared.dispatchOrder;
      const totalA = order.filter((s) => s === 'A').length;
      const totalB = order.filter((s) => s === 'B').length;
      expect(totalA).toBe(K);
      expect(totalB).toBe(K);
      // Interleaving: B's FIRST dispatch happens before A's LAST — A did not
      // monopolize the whole budget for its entire queue (no starvation).
      const firstB = order.indexOf('B');
      const lastA = order.lastIndexOf('A');
      expect(firstB).toBeGreaterThanOrEqual(0);
      expect(firstB).toBeLessThan(lastA);
      // And the long-run share is roughly fair (equal weights): within the
      // first 2·K dispatches each source got a substantial fraction, not ~0.
      const half = order.slice(0, K); // first K dispatches
      const aInHalf = half.filter((s) => s === 'A').length;
      const bInHalf = half.filter((s) => s === 'B').length;
      expect(aInHalf).toBeGreaterThan(0);
      expect(bInHalf).toBeGreaterThan(0);
    } finally {
      // Always drain so no in-flight scheduled work leaks into afterEach.
      while (shared.gates.length > 0) {
        shared.gates.shift()!();
        await flush();
      }
    }

    const result = await settled;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [ra, rb] = result.v;
      expect(ra.every((t) => t !== null)).toBe(true);
      expect(rb.every((t) => t !== null)).toBe(true);
    }
  });

  it('global budget is fully used by a SINGLE archive (no single-source regression)', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const GLOBAL = 6;
    const K = 12;
    configureSharedScheduler({ enabled: true, maxRequests: GLOBAL });

    const url = 'mem://one/manifest.json';
    const obj = makeDataset(K, blob, meta, e);
    const shared = newShared();
    // A high per-archive cap proves the GLOBAL budget (6) is the binding cap,
    // not the per-archive number — DRR is work-conserving so one source gets it all.
    const archive = new STTArchive({
      url,
      fetch: gatedFetch(obj, url, 'one', shared),
      coalesceGapBytes: 0,
      maxConcurrentRequests: 1000,
    });
    const ids = (await archive.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const p = archive.getTiles(ids);

    await flush();
    await flush();
    expect(shared.inFlight).toBe(GLOBAL); // the lone source drew the whole budget

    await drainUntil(shared, p);
    const r = await p;
    expect(r.every((t) => t !== null)).toBe(true);
    expect(shared.peak).toBe(GLOBAL);
  });

  it('ENABLED path still honors a LOW per-archive maxConcurrentRequests cap', async () => {
    // Wave-3 fix: the shared scheduler must not silently override a consumer
    // that lowered THIS dataset's cap to throttle its own range concurrency
    // (e.g. the showcase's maxRequests:12). A single archive whose per-archive
    // cap is BELOW the global budget must stay bounded by its own cap — the
    // global budget only bounds the AGGREGATE across archives.
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const GLOBAL = 12;
    const PER_ARCHIVE_CAP = 3;
    const K = 10;
    configureSharedScheduler({ enabled: true, maxRequests: GLOBAL });

    const url = 'mem://capped/manifest.json';
    const obj = makeDataset(K, blob, meta, e);
    const shared = newShared();
    const archive = new STTArchive({
      url,
      fetch: gatedFetch(obj, url, 'capped', shared),
      coalesceGapBytes: 0,
      maxConcurrentRequests: PER_ARCHIVE_CAP,
    });
    const ids = (await archive.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const p = archive.getTiles(ids);

    let finished = false;
    p.finally(() => {
      finished = true;
    });
    while (!finished) {
      await flush();
      // The per-archive cap is binding — never the (higher) global budget.
      expect(shared.inFlight).toBeLessThanOrEqual(PER_ARCHIVE_CAP);
      const gate = shared.gates.shift();
      if (gate) gate();
    }
    while (shared.gates.length > 0) {
      shared.gates.shift()!();
      await flush();
    }

    const r = await p;
    expect(r.every((t) => t !== null)).toBe(true);
    // It really filled its own cap, and never exceeded it (would be GLOBAL=12
    // before the fix, since the global budget was the only in-flight bound).
    expect(shared.peak).toBe(PER_ARCHIVE_CAP);
    // Sanity: the scheduler drained cleanly (no leaked slots).
    expect(getSharedScheduler().getStats().active).toBe(0);
  });

  it('two archives with low per-archive caps still bounded by GLOBAL aggregate', async () => {
    // Each archive caps itself at 3; the global budget is 4. With both
    // contending, neither exceeds its own 3-cap AND the aggregate never exceeds
    // the global 4 (the global budget bounds the sum across archives).
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const GLOBAL = 4;
    const PER_ARCHIVE_CAP = 3;
    const K = 8;
    configureSharedScheduler({ enabled: true, maxRequests: GLOBAL });

    const urlA = 'mem://capA/manifest.json';
    const urlB = 'mem://capB/manifest.json';
    const objA = makeDataset(K, blob, meta, e);
    const objB = makeDataset(K, blob, meta, e);
    const shared = newShared();
    const aA = new STTArchive({
      url: urlA,
      fetch: gatedFetch(objA, urlA, 'A', shared),
      coalesceGapBytes: 0,
      maxConcurrentRequests: PER_ARCHIVE_CAP,
    });
    const aB = new STTArchive({
      url: urlB,
      fetch: gatedFetch(objB, urlB, 'B', shared),
      coalesceGapBytes: 0,
      maxConcurrentRequests: PER_ARCHIVE_CAP,
    });

    const idsA = (await aA.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const idsB = (await aB.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));

    const both = Promise.all([aA.getTiles(idsA), aB.getTiles(idsB)]);
    let finished = false;
    both.finally(() => {
      finished = true;
    });
    while (!finished) {
      await flush();
      expect(shared.inFlight).toBeLessThanOrEqual(GLOBAL);
      expect(shared.perSourceInFlight.get('A') ?? 0).toBeLessThanOrEqual(
        PER_ARCHIVE_CAP,
      );
      expect(shared.perSourceInFlight.get('B') ?? 0).toBeLessThanOrEqual(
        PER_ARCHIVE_CAP,
      );
      const gate = shared.gates.shift();
      if (gate) gate();
    }
    while (shared.gates.length > 0) {
      shared.gates.shift()!();
      await flush();
    }

    const [ra, rb] = await both;
    expect(ra.every((t) => t !== null)).toBe(true);
    expect(rb.every((t) => t !== null)).toBe(true);
    expect(shared.peak).toBeLessThanOrEqual(GLOBAL);
    expect(shared.peak).toBeGreaterThan(1); // it really did run concurrently
  });

  it('caller abort supersedes scheduled work (queued + in-flight), freeing slots', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const GLOBAL = 3;
    const K = 9;
    configureSharedScheduler({ enabled: true, maxRequests: GLOBAL });

    const url = 'mem://abrt/manifest.json';
    const obj = makeDataset(K, blob, meta, e);
    const shared = newShared();
    const archive = new STTArchive({
      url,
      fetch: gatedFetch(obj, url, 'abrt', shared),
      coalesceGapBytes: 0,
      // No retries so an aborted in-flight fetch resolves the slot immediately.
      retryDelaysMs: [],
    });
    const ids = (await archive.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const ctrl = new AbortController();
    const p = archive.getTiles(ids, { signal: ctrl.signal });
    // Observe the rejection synchronously — `p` rejects mid-test on abort.
    const rejection = captureRejection(p);

    await flush();
    await flush();
    // GLOBAL requests are gated in flight; the rest (K - GLOBAL) are queued.
    expect(shared.inFlight).toBe(GLOBAL);
    const scheduler = getSharedScheduler();
    expect(scheduler.getStats().queued).toBe(K - GLOBAL);

    // Abort the whole batch: queued requests drop immediately; in-flight ones
    // get their signal fired and free their slot when the fetch settles.
    ctrl.abort();
    await flush();
    // Queued work is gone right away.
    expect(scheduler.getStats().queued).toBe(0);

    // Release the (aborted) in-flight requests so their slots free.
    while (shared.gates.length > 0) {
      shared.gates.shift()!();
      await flush();
    }
    await flush();
    await flush();

    // The batch rejects with an AbortError, and the scheduler is fully drained
    // (no leaked slots) afterward.
    const reason = (await rejection()) as Error;
    expect(reason.name).toBe('AbortError');
    const stats = scheduler.getStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });

  // ─── M6 / BH-1: the archive prices every group in BYTES ────────────────────
  //
  // A coalesced range's size is known EXACTLY at enqueue (`end - start + 1`),
  // so byte-metered fair share needs no estimate anywhere. These pin the
  // producer half of the seam: what the archive actually hands the scheduler.

  /**
   * Build a dataset whose `n` blobs live in ONE pack object, contiguous, so the
   * default coalesce gap fuses them into a single range group.
   */
  function makeSinglePackDataset(
    n: number,
    blob: Uint8Array,
    meta: any,
    e: any,
  ): { objects: Map<string, Uint8Array>; groupBytes: number } {
    const { bytes: packBytes, offsets } = packObject(
      Array.from({ length: n }, () => blob),
    );
    const objects = new Map<string, Uint8Array>();
    const pKey = packKey(packBytes);
    objects.set(pKey, packBytes);
    const entries = offsets.map((offset, i) => ({
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: i,
      timeEnd: i,
      packId: 0,
      offset,
      length: blob.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: i,
      crc32c: crc32c(blob),
      temporalBucketMs: e.temporalBucketMs,
    }));
    const dirObject = directoryObject(encodeDirectory(entries));
    const dKey = directoryKey(dirObject);
    objects.set(dKey, dirObject);
    objects.set(
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'stt-packed',
          formatVersion: 3,
          variants: [{ id: 0, kind: 'raw' }],
          compression: 'zstd',
          directory: {
            key: dKey,
            length: dirObject.length,
            directoryVersion: 6,
          },
          packs: [{ key: pKey, length: packBytes.length }],
          metadata: meta,
        }),
      ),
    );
    const last = offsets[offsets.length - 1] + blob.length - 1;
    return { objects, groupBytes: last - offsets[0] + 1 };
  }

  it('prices an UNCOALESCED group at exactly its blob length', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const K = 4;
    const url = 'mem://cost1/manifest.json';
    const obj = makeDataset(K, blob, meta, e);
    const archive = new STTArchive({
      url,
      fetch: memFetch(obj, url),
      coalesceGapBytes: 0, // one blob per pack ⇒ one group per tile
    });
    const ids = (await archive.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const spy = vi.spyOn(getSharedScheduler(), 'scheduleRequest');
    const tiles = await archive.getTiles(ids);
    expect(tiles.every((t) => t !== null)).toBe(true);

    const costs = spy.mock.calls.map((c) => (c[0] as any).costBytes);
    expect(costs).toHaveLength(K);
    for (const cost of costs) expect(cost).toBe(blob.length);
    spy.mockRestore();
  });

  it('prices a COALESCED group at end − start + 1 (the bytes the wire carries)', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const N = 3;
    const { objects, groupBytes } = makeSinglePackDataset(N, blob, meta, e);
    const url = 'mem://cost2/manifest.json';
    const archive = new STTArchive({ url, fetch: memFetch(objects, url) });
    const ids = (await archive.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    const spy = vi.spyOn(getSharedScheduler(), 'scheduleRequest');
    const tiles = await archive.getTiles(ids);
    expect(tiles.every((t) => t !== null)).toBe(true);

    const costs = spy.mock.calls.map((c) => (c[0] as any).costBytes);
    // One fused group covering all three blobs — priced as the whole range, not
    // as one tile and not as a flat quantum.
    expect(costs).toEqual([groupBytes]);
    expect(groupBytes).toBeGreaterThan(blob.length);
    spy.mockRestore();
  });

  it('keeps costBytes independent of the probe (a decision field, not a label)', async () => {
    // `bytes` is OBSERVATION ONLY and is only computed when a probe bag is
    // installed; `costBytes` must be there either way, or dispatch order would
    // depend on whether someone is watching.
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const url = 'mem://cost3/manifest.json';
    const obj = makeDataset(2, blob, meta, e);
    const archive = new STTArchive({
      url,
      fetch: memFetch(obj, url),
      coalesceGapBytes: 0,
    });
    const ids = (await archive.getIndex()).tiles.map((t) => ({
      z: t.zoom,
      x: t.x,
      y: t.y,
      t: t.timeStart,
    }));
    expect((globalThis as any).__sttProbe).toBeUndefined(); // probe OFF
    const spy = vi.spyOn(getSharedScheduler(), 'scheduleRequest');
    await archive.getTiles(ids);
    for (const call of spy.mock.calls) {
      const opts = call[0] as any;
      expect(opts.costBytes).toBe(blob.length);
      expect(opts.bytes).toBeUndefined(); // the probe label really is absent
    }
    spy.mockRestore();
  });
});
