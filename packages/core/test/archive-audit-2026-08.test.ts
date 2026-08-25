/**
 * Tile-loading audit (docs/roadmap/tile-loading-audit-2026-08.md §2), archive
 * side. One `it` per finding, named by its ID:
 *
 * - C1  progress watchdog: a slowly-progressing body never times out, a
 *       stalled one still does, and a timed-out attempt is not a throughput
 *       sample;
 * - C2  intra-group streaming: a coalesced group's first member is delivered
 *       before the range's last byte arrives;
 * - C7  per-member fallback runs through the slot-budgeted scheduler path;
 * - B8  a permanent 4xx is final: one request, no retries, no fan-out;
 * - C3  the coalesce gap is amplification-bounded (`k × useful + 256 KiB`);
 * - C6  directory leaf pages fuse at page scale, not the 2 MiB tile gap;
 * - A6  `clearCache()` unregisters the shared LRU; `maxCacheTiles: 0` is off;
 * - C4  `planRangeBytes(ids)` prices exactly the ranges `getTiles` issues, and
 *       rides `makeTilesetCallbacks` as `estimateFetchBytes`.
 *
 * Fixtures are the committed golden blob laid out at test-chosen spacing (as in
 * tile-batch-coalescing.test.ts), served through fault- and stream-injecting
 * fetch shims.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STTArchive,
  DEFAULT_RANGE_COALESCE_GAP,
  MIN_ADAPTIVE_COALESCE_GAP,
  COALESCE_AMPLIFICATION_K,
  planCoalescedRanges,
  getSharedByteCacheStats,
} from '../src/archive';
import { makeTilesetCallbacks } from '../src/render/tileset-adapter';
import { crc32c } from '../src/crc32c';
import { blake3Hex128 } from '../src/blake3';
import {
  decodeDirectory,
  decodePagedRoot,
  encodeDirectory,
  type PageDescriptor,
} from '../src/directory';
import type { TileId } from '../src/types';
import {
  configureSharedScheduler,
  resetSharedScheduler,
} from '../src/shared-scheduler';
import {
  OBJECT_MAGIC_LEN,
  directoryKey,
  directoryObject,
  packKey,
  packObject,
  packedFetch,
  packedFromGolden,
  type InMemoryPackedDataset,
  type PackedFetchLog,
} from './helpers/packed-fixture';

// ───────────────────────────────────────────────────────────────────────────
// Fixture: the golden blob at test-chosen spacing
// ───────────────────────────────────────────────────────────────────────────

interface BlobPlacement {
  pack: number;
  padBefore: number;
  zoom?: number;
}

interface SyntheticDataset {
  ds: InMemoryPackedDataset;
  ids: TileId[];
  blobLength: number;
  packLengths: number[];
}

/** One real, decodable blob + its directory facts from the golden fixture. */
function goldenBlob(): {
  blob: Uint8Array;
  entry: ReturnType<typeof decodeDirectory>[number];
  manifest: any;
} {
  const src = packedFromGolden({
    manifestUrl: 'mem://audit-src/manifest.json',
  });
  const manifest = JSON.parse(
    new TextDecoder().decode(src.objects.get('manifest.json')!),
  );
  const entry = decodeDirectory(
    src.objects.get(manifest.directory.key)!.subarray(OBJECT_MAGIC_LEN),
  )[0];
  const pack = src.objects.get(manifest.packs[entry.packId].key)!;
  return {
    blob: pack.subarray(entry.offset, entry.offset + entry.length),
    entry,
    manifest,
  };
}

let seq = 0;

/** Lay the golden blob out at the given spacing; every copy still decodes. */
function syntheticDataset(blobs: BlobPlacement[]): SyntheticDataset {
  const { blob, entry: e, manifest: srcManifest } = goldenBlob();
  const packCount = Math.max(...blobs.map((b) => b.pack)) + 1;
  const cursors = new Array<number>(packCount).fill(OBJECT_MAGIC_LEN);
  const placed = blobs.map((b) => {
    const offset = cursors[b.pack] + b.padBefore;
    cursors[b.pack] = offset + blob.length;
    return { pack: b.pack, offset };
  });
  const packs = cursors.map((size, i) => {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode('STTP'), 0);
    bytes[4] = 3;
    // Distinct lead-in per pack so two identical layouts never share a key.
    bytes[5] = 0;
    bytes[6] = i & 0xff;
    return bytes;
  });
  for (const p of placed) packs[p.pack].set(blob, p.offset);

  const entries = placed.map((p, i) => ({
    zoom: blobs[i].zoom ?? e.zoom,
    x: e.x + i,
    y: e.y,
    timeStart: i,
    timeEnd: i,
    packId: p.pack,
    offset: p.offset,
    length: blob.length,
    uncompressedSize: e.uncompressedSize,
    featureCount: e.featureCount,
    hilbert: i,
    crc32c: crc32c(blob),
  }));
  const dirObject = directoryObject(encodeDirectory(entries));
  const dKey = directoryKey(dirObject);
  const objects = new Map<string, Uint8Array>();
  objects.set(dKey, dirObject);
  const packRefs = packs.map((bytes) => {
    const key = packKey(bytes);
    objects.set(key, bytes);
    return { key, length: bytes.length };
  });
  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        format: 'stt-packed',
        formatVersion: 3,
        variants: [{ id: 0, kind: 'raw' }],
        compression: srcManifest.compression,
        directory: { key: dKey, length: dirObject.length, directoryVersion: 6 },
        packs: packRefs,
        metadata: srcManifest.metadata,
      }),
    ),
  );
  return {
    ds: { objects, manifestUrl: `mem://audit-${seq++}/manifest.json` },
    ids: entries.map((en) => ({
      z: en.zoom,
      x: en.x,
      y: en.y,
      t: en.timeStart,
    })),
    blobLength: blob.length,
    packLengths: packs.map((p) => p.length),
  };
}

function isPackRange(url: string, init?: RequestInit): boolean {
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  return Boolean(range) && url.includes('packs/');
}

function rangeSpan(init?: RequestInit): number {
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  const m = /bytes=(\d+)-(\d+)/.exec(range ?? '')!;
  return Number(m[2]) - Number(m[1]) + 1;
}

/** Σ range lengths logged against pack objects. */
function packBytesFetched(log: PackedFetchLog): number {
  let total = 0;
  for (const r of log.ranges) {
    if (!r.path.startsWith('packs/')) continue;
    const m = /bytes=(\d+)-(\d+)/.exec(r.range)!;
    total += Number(m[2]) - Number(m[1]) + 1;
  }
  return total;
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A transport that serves pack ranges as a `ReadableStream` body emitting
 * `chunkBytes` every `chunkDelayMs` (or never, when `stall` is set). The
 * `arrayBuffer()` path hangs so only a streaming reader can consume it.
 */
function streamingFetch(
  ds: InMemoryPackedDataset,
  opts: {
    chunkBytes: number;
    chunkDelayMs: number;
    stall?: boolean;
    log?: PackedFetchLog;
    counter?: { attempts: number };
    onChunk?: (bytesSoFar: number, isLast: boolean) => void;
  },
): typeof fetch {
  const inner = packedFetch(ds, opts.log);
  return (async (url: string, init?: RequestInit) => {
    const res = await inner(url, init);
    if (!isPackRange(url, init) || !res.ok) return res;
    if (opts.counter) opts.counter.attempts++;
    const whole = new Uint8Array(await res.arrayBuffer());
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (opts.stall) return new Promise<void>(() => {});
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            const end = Math.min(offset + opts.chunkBytes, whole.length);
            controller.enqueue(whole.subarray(offset, end));
            offset = end;
            const last = end >= whole.length;
            opts.onChunk?.(end, last);
            if (last) controller.close();
            resolve();
          }, opts.chunkDelayMs);
        });
      },
    });
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      headers: res.headers,
      body,
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => resetSharedScheduler());
afterEach(() => {
  resetSharedScheduler();
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// C1 / C2 — progress watchdog + intra-group streaming
// ───────────────────────────────────────────────────────────────────────────

describe('C1: the transfer watchdog is a PROGRESS timeout', () => {
  it('C1a: a slowly-progressing body resolves under a timeout shorter than the whole transfer', async () => {
    // Three contiguous blobs → one ~2.5 KB range, streamed 100 B per 100 ms
    // (~2.5 s) under a 500 ms watchdog. A total deadline rejects this with a
    // TimeoutError; an idle deadline must let it complete.
    const fx = syntheticDataset([
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
    ]);
    const counter = { attempts: 0 };
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: streamingFetch(fx.ds, {
        chunkBytes: 100,
        chunkDelayMs: 100,
        counter,
      }),
      transferTimeoutMs: 500,
      retryDelaysMs: [0, 0],
    });
    const tiles = await archive.getTiles(fx.ids);
    expect(tiles.every((t) => t !== null)).toBe(true);
    expect(counter.attempts).toBe(1);
  }, 20_000);

  it('C1b: a body that never progresses still dies at the idle threshold', async () => {
    const fx = syntheticDataset([{ pack: 0, padBefore: 0 }]);
    const counter = { attempts: 0 };
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: streamingFetch(fx.ds, {
        chunkBytes: 100,
        chunkDelayMs: 0,
        stall: true,
        counter,
      }),
      transferTimeoutMs: 30,
      retryDelaysMs: [0, 0],
    });
    const t0 = Date.now();
    await expect(archive.getTile(fx.ids[0])).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    // A single range cannot be re-split, so a stall on it is still retried
    // as a transient (archive-transport-hardening pins the 3 attempts).
    expect(counter.attempts).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('C1c: a timed-out multi-member group splits immediately instead of re-issuing the same range', async () => {
    const fx = syntheticDataset([
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
    ]);
    const spans: number[] = [];
    const inner = streamingFetch(fx.ds, {
      chunkBytes: 100,
      chunkDelayMs: 0,
      stall: true,
    });
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (isPackRange(url, init)) spans.push(rangeSpan(init));
        return inner(url, init);
      }) as unknown as typeof fetch,
      transferTimeoutMs: 30,
      retryDelaysMs: [0, 0],
    });
    const tiles = await archive.getTiles(fx.ids);
    expect(tiles.every((t) => t === null)).toBe(true);
    // ONE coalesced attempt, then one single-member attempt each — never the
    // two identical re-issues of the whole range.
    const grouped = spans.filter((s) => s > fx.blobLength);
    const single = spans.filter((s) => s === fx.blobLength);
    expect(grouped.length).toBe(1);
    expect(single.length).toBe(fx.ids.length);
  });

  it('C1d: a timed-out attempt is a failure event, not a throughput sample', async () => {
    const fx = syntheticDataset([
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
    ]);
    let stall = false;
    const inner = packedFetch(fx.ds);
    const stalled = streamingFetch(fx.ds, {
      chunkBytes: 100,
      chunkDelayMs: 0,
      stall: true,
    });
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) =>
        stall && isPackRange(url, init)
          ? stalled(url, init)
          : inner(url, init)) as unknown as typeof fetch,
      transferTimeoutMs: 30,
      retryDelaysMs: [0, 0],
      maxCacheTiles: 0,
    });
    await archive.getTiles(fx.ids);
    const healthy = archive.getThroughputEstimate();
    expect(healthy.bytesPerMs).toBeGreaterThan(0);

    stall = true;
    await expect(archive.getTile(fx.ids[0])).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    // The estimate is untouched: a stall delivered no bytes and says nothing
    // about the link's rate. The failure is counted where it belongs.
    expect(archive.getThroughputEstimate()).toEqual(healthy);
    const failures = archive.getTransferFailureStats();
    expect(failures.timedOutAttempts).toBe(3);
    expect(failures.failedAttempts).toBe(3);
  });
});

describe('C2: intra-group streaming delivery', () => {
  it('C2: onTileReady for the first member fires before the last chunk of the range lands', async () => {
    const fx = syntheticDataset([
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
    ]);
    let lastChunkDelivered = false;
    const readyBeforeLastChunk: boolean[] = [];
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: streamingFetch(fx.ds, {
        // Just over one member per chunk, 100 ms apart: member 0 is complete
        // after the first chunk and decodable ~200 ms before the range ends.
        chunkBytes: fx.blobLength + 50,
        chunkDelayMs: 100,
        onChunk: (_n, last) => {
          if (last) lastChunkDelivered = true;
        },
      }),
      retryDelaysMs: [],
    });
    const tiles = await archive.getTiles(fx.ids, {
      onTileReady: (index) => {
        if (index === 0) readyBeforeLastChunk.push(!lastChunkDelivered);
      },
    });
    expect(tiles.every((t) => t !== null)).toBe(true);
    expect(readyBeforeLastChunk).toEqual([true]);
  }, 20_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C7 — per-member fallback through the scheduler
// ───────────────────────────────────────────────────────────────────────────

describe('C7: per-member fallback is slot-budgeted', () => {
  it('C7: a 40-member group whose coalesced fetch 500s never exceeds maxConcurrentRequests in flight', async () => {
    configureSharedScheduler({ maxRequests: 24 });
    const fx = syntheticDataset(
      Array.from({ length: 40 }, () => ({ pack: 0, padBefore: 0 })),
    );
    const inner = packedFetch(fx.ds);
    const inflight = { now: 0, max: 0, attempts: 0 };
    const MAX = 4;
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (!isPackRange(url, init)) return inner(url, init);
        inflight.attempts++;
        if (rangeSpan(init) > fx.blobLength) {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        inflight.now++;
        inflight.max = Math.max(inflight.max, inflight.now);
        try {
          await delay(5);
          return await inner(url, init);
        } finally {
          inflight.now--;
        }
      }) as unknown as typeof fetch,
      maxConcurrentRequests: MAX,
      retryDelaysMs: [0, 0],
    });
    const tiles = await archive.getTiles(fx.ids);
    expect(tiles.every((t) => t !== null)).toBe(true);
    // 3 group attempts (a 500 is transient) + one per member.
    expect(inflight.attempts).toBe(3 + fx.ids.length);
    expect(inflight.max).toBeLessThanOrEqual(MAX);
    expect(inflight.max).toBeGreaterThan(1); // still concurrent, not serial
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B8 — permanent 4xx
// ───────────────────────────────────────────────────────────────────────────

describe('B8: a permanently missing pack is final', () => {
  function notFoundFetch(
    ds: InMemoryPackedDataset,
    counter: { attempts: number },
    status = 404,
  ): typeof fetch {
    const inner = packedFetch(ds);
    return (async (url: string, init?: RequestInit) => {
      if (!isPackRange(url, init)) return inner(url, init);
      counter.attempts++;
      return {
        ok: false,
        status,
        statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as unknown as typeof fetch;
  }

  it('B8: a 404 pack costs exactly ONE request per group — no retries, no per-member fan-out', async () => {
    const fx = syntheticDataset([
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
    ]);
    const counter = { attempts: 0 };
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: notFoundFetch(fx.ds, counter),
      retryDelaysMs: [0, 0],
    });
    const errors: Array<{ index: number; error: unknown }> = [];
    const tiles = await archive.getTiles(fx.ids, {
      onTileError: (index, error) => errors.push({ index, error }),
    });
    expect(tiles.every((t) => t === null)).toBe(true);
    expect(counter.attempts).toBe(1);
    // Every member learns WHY it is null, typed so the tileset can write it
    // off on first sight instead of re-enqueueing it on the 60 s ladder.
    expect(errors.map((e) => e.index).sort()).toEqual([0, 1, 2, 3]);
    for (const { error } of errors) {
      expect(error).toMatchObject({ name: 'PermanentFetchError', status: 404 });
    }
    expect(archive.getTransferFailureStats().permanentFailures).toBe(1);
  });

  it('B8: the single-tile path surfaces the typed error after one attempt', async () => {
    const fx = syntheticDataset([{ pack: 0, padBefore: 0 }]);
    const counter = { attempts: 0 };
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: notFoundFetch(fx.ds, counter, 410),
      retryDelaysMs: [0, 0],
    });
    await expect(archive.getTile(fx.ids[0])).rejects.toMatchObject({
      name: 'PermanentFetchError',
      status: 410,
    });
    expect(counter.attempts).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C3 — amplification-bounded fuse
// ───────────────────────────────────────────────────────────────────────────

describe('C3: the coalesce gap is amplification-bounded', () => {
  it('C3: 10 tiny tiles 1 MiB apart cost ≤ 10 requests and < 100 KB, not one ~9 MiB range', async () => {
    const fx = syntheticDataset(
      Array.from({ length: 10 }, (_, i) => ({
        pack: 0,
        padBefore: i === 0 ? 0 : 1024 * 1024,
      })),
    );
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: packedFetch(fx.ds, log),
    });
    const tiles = await archive.getTiles(fx.ids);
    expect(tiles.every((t) => t !== null)).toBe(true);
    expect(log.ranges.length).toBeLessThanOrEqual(10);
    expect(packBytesFetched(log)).toBeLessThan(100 * 1024);
  });

  it('C3: the pure planner fuses only when the gap is within k × useful + 256 KiB', () => {
    const extent = (e: { packId: number; offset: number; length: number }) => e;
    // 10 × 500 B tiles 1 MiB apart: never fused at ANY gap.
    const sparse = Array.from({ length: 10 }, (_, i) => ({
      packId: 0,
      offset: 8 + i * (1024 * 1024 + 500),
      length: 500,
    }));
    expect(
      planCoalescedRanges(sparse, extent, DEFAULT_RANGE_COALESCE_GAP).length,
    ).toBe(10);
    expect(
      planCoalescedRanges(sparse, extent, Number.MAX_SAFE_INTEGER).length,
    ).toBe(10);
    // Two 1 MB tiles 1.5 MB apart: k × 1 MB = 4 MB clears the gap, so the
    // fitted G decides — fused at 2 MiB, split at the 1 MiB band floor. This
    // is CO-7's "the adaptive gap is not a no-op", now stated where it holds:
    // for tiles large enough that a fuse is not mostly over-fetch.
    const big = [
      { packId: 0, offset: 8, length: 1_000_000 },
      { packId: 0, offset: 8 + 1_000_000 + 1_500_000, length: 1_000_000 },
    ];
    expect(
      planCoalescedRanges(big, extent, DEFAULT_RANGE_COALESCE_GAP).length,
    ).toBe(1);
    expect(planCoalescedRanges(big, extent, 1024 * 1024).length).toBe(2);
    // The bound itself, at the edge: useful 500 B ⇒ 2000 + 256 KiB.
    const edge = (gap: number) =>
      planCoalescedRanges(
        [
          { packId: 0, offset: 8, length: 500 },
          { packId: 0, offset: 8 + 500 + gap, length: 500 },
        ],
        extent,
        DEFAULT_RANGE_COALESCE_GAP,
      ).length;
    const bound = COALESCE_AMPLIFICATION_K * 500 + MIN_ADAPTIVE_COALESCE_GAP;
    expect(edge(bound)).toBe(1);
    expect(edge(bound + 1)).toBe(2);
    // Per-pack: byte adjacency never bridges an object boundary.
    expect(
      planCoalescedRanges(
        [
          { packId: 0, offset: 8, length: 500 },
          { packId: 1, offset: 8, length: 500 },
        ],
        extent,
        DEFAULT_RANGE_COALESCE_GAP,
      ).length,
    ).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C6 — page-scale directory gap
// ───────────────────────────────────────────────────────────────────────────

/** Encode a paged-directory root page (mirrors `decodePagedRoot`'s layout). */
function encodePagedRootBytes(pages: PageDescriptor[]): Uint8Array {
  const HEADER = 12;
  const DESC = 52;
  const out = new Uint8Array(HEADER + pages.length * DESC);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 1);
  dv.setUint8(1, 0);
  dv.setUint32(4, pages.length, true);
  dv.setUint32(8, 1, true);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    let o = HEADER + i * DESC;
    dv.setBigUint64(o, BigInt(p.relOffset), true);
    o += 8;
    dv.setUint32(o, p.length, true);
    o += 4;
    dv.setUint32(o, p.entryCount, true);
    o += 4;
    dv.setUint8(o, p.minZoom);
    o += 1;
    dv.setUint8(o, p.maxZoom);
    o += 1;
    o += 2;
    for (const deg of [p.minLon, p.minLat, p.maxLon, p.maxLat]) {
      dv.setInt32(o, Math.round(deg * 1e7), true);
      o += 4;
    }
    dv.setBigInt64(o, BigInt(p.tMin), true);
    o += 8;
    dv.setBigInt64(o, BigInt(p.tMax), true);
  }
  return out;
}

describe('C6: directory leaf pages fuse at page scale', () => {
  const DECOY_LEN = 1_500_000;

  /**
   * Three leaves: two NEEDED single-entry leaves with a 1.5 MB decoy (far-away
   * bbox, never decoded) between them. Under the 2 MiB tile gap the two needed
   * leaves fuse across the decoy into one ~1.5 MB request.
   */
  function threeLeafDataset(): {
    ds: InMemoryPackedDataset;
    dirKey: string;
    rootLength: number;
    leafLengths: number[];
  } {
    const { blob, entry: e, manifest: srcManifest } = goldenBlob();
    const mkLeaf = (x: number) =>
      encodeDirectory([
        {
          zoom: 10,
          x,
          y: 384,
          timeStart: 0,
          timeEnd: 999,
          packId: 0,
          offset: OBJECT_MAGIC_LEN,
          length: e.length,
          uncompressedSize: e.uncompressedSize,
          featureCount: e.featureCount,
          hilbert: 0,
          crc32c: crc32c(blob),
          temporalBucketMs: 1000,
        },
      ]);
    const leaves = [mkLeaf(520), new Uint8Array(DECOY_LEN), mkLeaf(521)];
    const pages: PageDescriptor[] = [];
    let rel = 0;
    for (let i = 0; i < leaves.length; i++) {
      const decoy = i === 1;
      pages.push({
        relOffset: rel,
        length: leaves[i].length,
        entryCount: 1,
        minZoom: 10,
        maxZoom: 10,
        minLon: decoy ? -120 : 2,
        minLat: decoy ? -40 : 40,
        maxLon: decoy ? -110 : 4,
        maxLat: decoy ? -30 : 41.5,
        tMin: 0,
        tMax: 999,
      });
      rel += leaves[i].length;
    }
    const root = encodePagedRootBytes(pages);
    expect(decodePagedRoot(root).pages).toEqual(pages);
    const sttd = new Uint8Array(root.length + rel);
    sttd.set(root, 0);
    for (let i = 0; i < leaves.length; i++)
      sttd.set(leaves[i], root.length + pages[i].relOffset);
    const sttdObject = directoryObject(sttd);
    const { bytes: packBytes } = packObject([blob]);
    const dirKey = directoryKey(sttdObject);
    const pKey = packKey(packBytes);
    const objects = new Map<string, Uint8Array>();
    objects.set(dirKey, sttdObject);
    objects.set(pKey, packBytes);
    objects.set(
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'stt-packed',
          formatVersion: 3,
          variants: [{ id: 0, kind: 'raw' }],
          compression: srcManifest.compression,
          directory: {
            key: dirKey,
            length: sttdObject.length,
            directoryVersion: 6,
            layout: 'paged',
            rootLength: root.length,
            pageCount: leaves.length,
            pageEntries: 1,
            rootHash: blake3Hex128(root),
            pageHashes: leaves.map((leaf) => blake3Hex128(leaf)),
          },
          packs: [{ key: pKey, length: packBytes.length }],
          metadata: { ...srcManifest.metadata, temporal_bucket_ms: 1000 },
        }),
      ),
    );
    return {
      ds: { objects, manifestUrl: `mem://audit-paged-${seq++}/manifest.json` },
      dirKey,
      rootLength: root.length,
      leafLengths: leaves.map((l) => l.length),
    };
  }

  it('C6: two needed leaves 1.5 MB apart are two requests, not one fused over the decoy', async () => {
    const { ds, dirKey, rootLength, leafLengths } = threeLeafDataset();
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds, log),
      directoryPageThresholdBytes: 0,
    });
    const ids = await archive.getTileIdsInBounds(
      { minLon: 2, minLat: 40, maxLon: 4, maxLat: 41.5 },
      10,
      { start: 0, end: 999 },
    );
    expect(ids.length).toBe(2);
    const rootEnd = OBJECT_MAGIC_LEN + rootLength;
    const leafRanges = log.ranges.filter((r) => {
      if (r.path !== dirKey) return false;
      return Number(/bytes=(\d+)-/.exec(r.range)![1]) >= rootEnd;
    });
    let leafBytes = 0;
    for (const r of leafRanges) {
      const m = /bytes=(\d+)-(\d+)/.exec(r.range)!;
      leafBytes += Number(m[2]) - Number(m[1]) + 1;
    }
    expect(leafRanges.length).toBe(2);
    const needed = leafLengths[0] + leafLengths[2];
    expect(leafBytes).toBeLessThanOrEqual(
      needed + Math.max(leafLengths[0], leafLengths[2]),
    );
    // …and the decode path is intact: both tiles still arrive.
    const tiles = await archive.getTiles(ids);
    expect(tiles.every((t) => t !== null)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A6 — byte cache
// ───────────────────────────────────────────────────────────────────────────

describe('A6: the compressed byte cache', () => {
  it('A6: clearCache() unregisters its entries from the process-shared LRU', async () => {
    const fx = syntheticDataset([
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
    ]);
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: packedFetch(fx.ds),
    });
    const before = getSharedByteCacheStats();
    await archive.getTiles(fx.ids);
    expect(archive.getCacheStats().size).toBe(fx.ids.length);
    const filled = getSharedByteCacheStats();
    expect(filled.bytes).toBe(before.bytes + fx.ids.length * fx.blobLength);
    expect(filled.entries).toBe(before.entries + fx.ids.length);

    archive.clearCache();
    expect(archive.getCacheStats().size).toBe(0);
    expect(archive.getCacheStats().bytes).toBe(0);
    // The shared accounting must come back down too — otherwise every OTHER
    // archive is evicted early against bytes nobody holds any more.
    expect(getSharedByteCacheStats()).toEqual(before);
  });

  it('A6: maxCacheTiles: 0 stores nothing, registers nothing, and adds no copy', async () => {
    const fx = syntheticDataset([
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
      { pack: 0, padBefore: 0 },
    ]);
    const countSlices = async (maxCacheTiles: number | undefined) => {
      const archive = new STTArchive({
        url: fx.ds.manifestUrl,
        fetch: packedFetch(fx.ds),
        maxCacheTiles,
      });
      await archive.getIndex();
      const spy = vi.spyOn(ArrayBuffer.prototype, 'slice');
      const tiles = await archive.getTiles(fx.ids);
      const slices = spy.mock.calls.length;
      spy.mockRestore();
      expect(tiles.every((t) => t !== null)).toBe(true);
      return { archive, slices };
    };
    const shared = getSharedByteCacheStats();
    const off = await countSlices(0);
    expect(off.archive.getCacheStats().size).toBe(0);
    expect(off.archive.getCacheStats().bytes).toBe(0);
    expect(getSharedByteCacheStats()).toEqual(shared);
    // Re-requesting goes back to the network (misses, never hits).
    await off.archive.getTiles(fx.ids);
    expect(off.archive.getCacheStats().hits).toBe(0);

    const on = await countSlices(undefined);
    expect(on.archive.getCacheStats().size).toBe(fx.ids.length);
    // The decode copy is paid either way; the cache adds no second one.
    expect(off.slices).toBeLessThanOrEqual(on.slices);
    on.archive.clearCache();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C4 (archive side) — planRangeBytes
// ───────────────────────────────────────────────────────────────────────────

describe('C4: planRangeBytes prices exactly what getTiles fetches', () => {
  /** Coarse (z0) and fine (z10) tiles interleaved in byte order. */
  function interleaved(pad: number): SyntheticDataset {
    return syntheticDataset(
      Array.from({ length: 12 }, (_, i) => ({
        pack: 0,
        padBefore: i === 0 ? 0 : pad,
        zoom: i % 2 === 0 ? 0 : 10,
      })),
    );
  }

  for (const pad of [0, 300 * 1024, 1_500_000]) {
    it(`C4: planned bytes == fetched bytes for the coarse subset (pad ${pad})`, async () => {
      const fx = interleaved(pad);
      const coarse = fx.ids.filter((id) => id.z === 0);
      const log: PackedFetchLog = { paths: [], ranges: [] };
      const archive = new STTArchive({
        url: fx.ds.manifestUrl,
        fetch: packedFetch(fx.ds, log),
      });
      await archive.getIndex();
      const planned = archive.planRangeBytes(coarse);
      expect(planned).toBeGreaterThanOrEqual(coarse.length * fx.blobLength);
      const tiles = await archive.getTiles(coarse);
      expect(tiles.every((t) => t !== null)).toBe(true);
      expect(packBytesFetched(log)).toBe(planned);
      // Resident bytes are not re-planned: the cache now holds them.
      expect(archive.planRangeBytes(coarse)).toBe(0);
    });
  }

  it('C4: unknown ids plan to 0 bytes, and the adapter exposes it as estimateFetchBytes', async () => {
    const fx = interleaved(0);
    const archive = new STTArchive({
      url: fx.ds.manifestUrl,
      fetch: packedFetch(fx.ds),
    });
    await archive.getIndex();
    expect(archive.planRangeBytes([])).toBe(0);
    expect(archive.planRangeBytes([{ z: 5, x: 1, y: 1, t: 0 }])).toBe(0);
    const callbacks = makeTilesetCallbacks(archive);
    expect(typeof callbacks.estimateFetchBytes).toBe('function');
    expect(callbacks.estimateFetchBytes!(fx.ids)).toBe(
      archive.planRangeBytes(fx.ids),
    );
    expect(callbacks.estimateFetchBytes!(fx.ids)).toBeGreaterThan(0);
  });
});
