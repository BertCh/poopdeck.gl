/**
 * Regression test for the PAGED-PATH supersession leak + hang (multi-source
 * coordination, Wave 3 — archive↔scheduler integration).
 *
 * On the default (shared-scheduler ENABLED) path, `fetchAndMergePages` registers
 * a per-page-group deferred in `pageFetchPromises` so concurrent queries dedup
 * onto an in-flight page fetch. That deferred is settled ONLY inside the
 * `executeGroup` wrapper handed to `runGroupFetches` — i.e. only when the
 * scheduler DISPATCHES the group. A group cancelled while still QUEUED (caller
 * supersession while the global budget is saturated) is dropped by the scheduler
 * WITHOUT ever invoking `execute`, so before the fix its deferred — and the
 * `reg.finally` that prunes `pageFetchPromises` — never fired. Result:
 *   (1) `pageFetchPromises` leaked one Map entry per queued-then-aborted group;
 *   (2) a later query dedup-ing onto a leaked entry hung forever.
 *
 * This test reproduces the finding's scenario directly on the buggy method:
 * an in-memory PAGED `.sttd` with non-adjacent page indices (separate range
 * groups), a global budget of 1 (so all-but-one group stays queued), a gated
 * fetch, and a caller-abort while the groups are queued. It asserts that after
 * the drain `pageFetchPromises` is empty, the scheduler is fully drained, and a
 * follow-up page fetch for a previously-queued-then-aborted page settles.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { STTArchive } from '../src/archive';
import {
  OBJECT_MAGIC_LEN,
  directoryKey,
  directoryObject,
  packKey,
} from './helpers/packed-fixture';
import { blake3Hex128 } from '../src/blake3';
import { encodeDirectory, type DirectoryEncodeEntry } from '../src/directory';
import {
  configureSharedScheduler,
  resetSharedScheduler,
  getSharedScheduler,
} from '../src/shared-scheduler';
import { bufferToArrayBuffer, flush } from './helpers/fixtures';

// ── Paged-root codec (encode side) — mirrors directory.ts `decodePagedRoot`. ──
const PAGED_ROOT_VERSION = 1;
const DESCRIPTOR_GEO_BBOX = 0;
const ROOT_HEADER_LEN = 12;
const DESCRIPTOR_LEN = 52;

interface LeafDesc {
  relOffset: number;
  length: number;
  entryCount: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  tMin: number;
  tMax: number;
}

function encodePagedRoot(pages: LeafDesc[]): Uint8Array {
  const buf = new Uint8Array(ROOT_HEADER_LEN + pages.length * DESCRIPTOR_LEN);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, PAGED_ROOT_VERSION);
  dv.setUint8(1, DESCRIPTOR_GEO_BBOX);
  dv.setUint32(4, pages.length, true);
  dv.setUint32(8, pages.length, true); // pageEntries (informational)
  for (let i = 0; i < pages.length; i++) {
    let o = ROOT_HEADER_LEN + i * DESCRIPTOR_LEN;
    const p = pages[i];
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
    o += 2; // reserved
    dv.setInt32(o, Math.round(p.minLon * 1e7), true);
    o += 4;
    dv.setInt32(o, Math.round(p.minLat * 1e7), true);
    o += 4;
    dv.setInt32(o, Math.round(p.maxLon * 1e7), true);
    o += 4;
    dv.setInt32(o, Math.round(p.maxLat * 1e7), true);
    o += 4;
    dv.setBigInt64(o, BigInt(p.tMin), true);
    o += 8;
    dv.setBigInt64(o, BigInt(p.tMax), true);
  }
  return buf;
}

/**
 * Build an in-memory PAGED packed dataset with `pageCount` leaf pages. Each leaf
 * holds one directory entry. The directory is UNFRAMED (manifest omits
 * `encoding`), so no zstd round-trip is needed in the test. Pages are laid out
 * contiguously after the root; with `coalesceGapBytes: 0` a request for
 * non-adjacent page indices yields SEPARATE range groups (the skipped pages'
 * bytes sit between them).
 */
function makePagedDataset(
  pageCount: number,
  manifestUrl: string,
): {
  objects: Map<string, Uint8Array>;
  manifestUrl: string;
  rootLength: number;
} {
  const leafFrames: Uint8Array[] = [];
  const descs: LeafDesc[] = [];
  let rel = 0;
  for (let i = 0; i < pageCount; i++) {
    const entry: DirectoryEncodeEntry = {
      zoom: 10,
      x: i,
      y: 0,
      timeStart: i,
      timeEnd: i,
      packId: 0,
      offset: OBJECT_MAGIC_LEN,
      length: 1,
      uncompressedSize: 1,
      featureCount: 1,
      // Explicit "no checksum": these 1-byte blobs are never decoded by
      // this suite (it exercises page scheduling, not payloads).
      crc32c: 0,
    };
    const frame = encodeDirectory([entry]);
    leafFrames.push(frame);
    descs.push({
      relOffset: rel,
      length: frame.length,
      entryCount: 1,
      minZoom: 10,
      maxZoom: 10,
      minLon: i,
      minLat: 0,
      maxLon: i + 1,
      maxLat: 1,
      tMin: i,
      tMax: i,
    });
    rel += frame.length;
  }
  const root = encodePagedRoot(descs);
  const rootLength = root.length;
  const totalLeaf = leafFrames.reduce((s, f) => s + f.length, 0);
  const dir = new Uint8Array(rootLength + totalLeaf);
  dir.set(root, 0);
  let o = rootLength;
  for (const f of leafFrames) {
    dir.set(f, o);
    o += f.length;
  }

  const objects = new Map<string, Uint8Array>();
  const dirObject = directoryObject(dir);
  const dKey = directoryKey(dirObject);
  objects.set(dKey, dirObject);
  // A trivial pack object so the manifest references something (unused here —
  // we only exercise the directory page fetches).
  const pack = new Uint8Array(OBJECT_MAGIC_LEN);
  const pKey = packKey(pack);
  objects.set(pKey, pack);
  const manifest = {
    format: 'stt-packed',
    formatVersion: 3,
    variants: [{ id: 0, kind: 'raw' }],
    compression: 'none',
    directory: {
      key: dKey,
      length: dirObject.length,
      directoryVersion: 6,
      layout: 'paged',
      rootLength,
      pageCount,
      pageEntries: pageCount,
      rootHash: blake3Hex128(root),
      pageHashes: leafFrames.map((frame) => blake3Hex128(frame)),
    },
    packs: [{ key: pKey, length: pack.length }],
    metadata: { temporalBucketMs: 1 },
  };
  objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  return { objects, manifestUrl, rootLength };
}

/** A shared gate/concurrency tracker for the gated directory fetch. */
interface SharedGate {
  inFlight: number;
  peak: number;
  gates: Array<() => void>;
}

function newShared(): SharedGate {
  return { inFlight: 0, peak: 0, gates: [] };
}

/**
 * A gated fetch: directory RANGE GETs that start AT OR AFTER the root length
 * (i.e. leaf-page fetches) block until released; the root prefix GET and whole
 * GETs resolve immediately so `getIndex()` is never gated.
 */
function gatedFetch(
  objects: Map<string, Uint8Array>,
  manifestUrl: string,
  rootLength: number,
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
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    // Gate only the leaf-page fetches (range starts past the root prefix).
    if (
      key.startsWith('index/') &&
      key.endsWith('.sttd') &&
      start >= rootLength
    ) {
      shared.inFlight++;
      shared.peak = Math.max(shared.peak, shared.inFlight);
      await new Promise<void>((resolve) => shared.gates.push(resolve));
      shared.inFlight--;
    }
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

describe('paged page-fetch + SharedRequestScheduler supersession (Wave 3)', () => {
  beforeEach(() => resetSharedScheduler());
  afterEach(() => resetSharedScheduler());

  it('queued-then-aborted page groups do not leak pageFetchPromises or deadlock waiters', async () => {
    const GLOBAL = 1; // one slot → all but one page-group stays queued
    const PAGES = 9;
    configureSharedScheduler({ enabled: true, maxRequests: GLOBAL });

    const url = 'mem://paged/manifest.json';
    const ds = makePagedDataset(PAGES, url);
    const shared = newShared();
    const archive = new STTArchive({
      url,
      fetch: gatedFetch(ds.objects, url, ds.rootLength, shared),
      coalesceGapBytes: 0, // non-adjacent indices → separate range groups
      directoryPageThresholdBytes: 0, // force the streaming (paged) path
      retryDelaysMs: [], // an aborted in-flight fetch frees its slot at once
    });

    // Build the page table (root-only fetch — not gated).
    await archive.getIndex();

    // Non-adjacent page indices [0,2,4,6,8] → five separate coalesced groups.
    const indices = [0, 2, 4, 6, 8];
    const ctrl = new AbortController();
    // Call the (private) page-fetch method directly — the exact unit the finding
    // identified — so the test isolates the bug rather than the tile geometry.
    const p = (
      archive as unknown as {
        fetchAndMergePages: (i: number[], s?: AbortSignal) => Promise<void>;
      }
    ).fetchAndMergePages(indices, ctrl.signal);
    // Observe the rejection synchronously so the abort never leaks as unhandled.
    const observed = p.then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, e }),
    );

    await flush();
    await flush();
    // One group is gated in flight; the other four are queued in the scheduler.
    expect(shared.inFlight).toBe(GLOBAL);
    const scheduler = getSharedScheduler();
    expect(scheduler.getStats().queued).toBe(indices.length - GLOBAL);

    // Supersede the whole page fetch while four groups are still QUEUED.
    ctrl.abort();
    await flush();
    // Queued groups drop immediately (never dispatched → executeGroup never ran).
    expect(scheduler.getStats().queued).toBe(0);

    // Release the one (aborted) in-flight directory fetch so its slot frees.
    while (shared.gates.length > 0) {
      shared.gates.shift()!();
      await flush();
    }
    await flush();
    await flush();

    const res = await observed;
    expect(res.ok).toBe(false); // the call rejected (superseded)

    // THE REGRESSION: every per-page registry entry must be pruned (no leak),
    // and the scheduler must be fully drained (no orphaned bookkeeping).
    const leaked = (
      archive as unknown as { pageFetchPromises: Map<number, unknown> }
    ).pageFetchPromises;
    expect(leaked.size).toBe(0);
    const stats = scheduler.getStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);

    // THE DEADLOCK: a follow-up fetch for a page that was queued-then-aborted
    // (index 8) must SETTLE — before the fix it would dedup onto the leaked,
    // never-settling registry promise and hang forever. Release its gate so it
    // can complete, and bound it with a timeout so a hang fails fast.
    const follow = (
      archive as unknown as {
        fetchAndMergePages: (i: number[], s?: AbortSignal) => Promise<void>;
      }
    ).fetchAndMergePages([8]);
    const drain = (async () => {
      for (let k = 0; k < 50; k++) {
        if (shared.gates.length > 0) shared.gates.shift()!();
        await flush();
      }
    })();
    const timeout = new Promise<'timeout'>((r) =>
      setTimeout(() => r('timeout'), 2000),
    );
    const winner = await Promise.race([follow.then(() => 'settled'), timeout]);
    await drain;
    expect(winner).toBe('settled');
    // Page 8 is now resident.
    expect(
      (archive as unknown as { residentPages: Set<number> }).residentPages.has(
        8,
      ),
    ).toBe(true);
  });

  it('disabled (kill-switch) path: page groups still settle on abort (no regression)', async () => {
    // The legacy path always invokes executeGroup per group, so its deferred
    // always settles via d.reject on abort — confirm it stays clean too.
    configureSharedScheduler({ enabled: false, maxRequests: 24 });

    const url = 'mem://paged-off/manifest.json';
    const ds = makePagedDataset(5, url);
    const shared = newShared();
    const archive = new STTArchive({
      url,
      fetch: gatedFetch(ds.objects, url, ds.rootLength, shared),
      coalesceGapBytes: 0,
      directoryPageThresholdBytes: 0,
      maxConcurrentRequests: 1, // one group in flight at a time
      retryDelaysMs: [],
    });
    await archive.getIndex();

    const ctrl = new AbortController();
    const p = (
      archive as unknown as {
        fetchAndMergePages: (i: number[], s?: AbortSignal) => Promise<void>;
      }
    ).fetchAndMergePages([0, 2, 4], ctrl.signal);
    const observed = p.then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, e }),
    );

    await flush();
    await flush();
    ctrl.abort();
    while (shared.gates.length > 0) {
      shared.gates.shift()!();
      await flush();
    }
    await flush();

    const res = await observed;
    expect(res.ok).toBe(false);
    const leaked = (
      archive as unknown as { pageFetchPromises: Map<number, unknown> }
    ).pageFetchPromises;
    expect(leaked.size).toBe(0);
  });
});
