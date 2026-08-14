/**
 * Integration test: STTArchive + OpfsTileCache.
 *
 * Uses the same sample.stt fixture as `archive.test.ts` but wires in an
 * in-memory OPFS cache and asserts:
 *   1. A cold getTile() goes through the fetch shim and writes to OPFS.
 *   2. A second STTArchive instance against the same cache short-circuits the
 *      fetch (zero new range requests) and decodes from OPFS.
 *   3. The OPFS layer is keyed by the archive fingerprint (ETag) — a
 *      different fingerprint produces a miss.
 *   4. (P0-2) The additive per-entry `hits` counter: monotone with
 *      `lastAccess`, and an index written before the field existed still
 *      round-trips.
 */

import { describe, it, expect } from 'vitest';
import { STTArchive } from '../src/archive';
import { OpfsTileCache } from '../src/opfs-cache';
import { blake3Hex128 } from '../src/blake3';
import { decodeDirectory, encodeDirectory } from '../src/directory';
import {
  OBJECT_MAGIC_LEN,
  directoryObject,
  packedFromGolden,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';
import { bufferToArrayBuffer, settle } from './helpers/fixtures';
import {
  installShim,
  uninstallShim,
  type MemDirectoryHandle,
} from './helpers/opfs-shim';

// The reader consumes the packed format; transcode the single-file fixture. The
// OPFS fingerprint now derives from the manifest's content-addressed directory
// key (stable across packs), NOT a per-response ETag.
const DATASET = packedFromGolden({
  manifestUrl: 'mem://data/sample/manifest.json',
});

/**
 * A counting `fetch` over an in-memory packed dataset. `.calls` counts ALL
 * HTTP calls (manifest + directory whole-GETs and pack range requests); tests
 * snapshot it after `getIndex()` so the delta isolates tile-body fetches.
 */
function packedCountingFetch(ds: InMemoryPackedDataset): {
  fetch: typeof fetch;
  stats: { calls: number };
} {
  const stats = { calls: 0 };
  const slash = ds.manifestUrl.lastIndexOf('/');
  const base = slash >= 0 ? ds.manifestUrl.slice(0, slash + 1) : '';
  const fn = (async (url: string, init?: RequestInit) => {
    stats.calls++;
    const key = url.startsWith(base) ? url.slice(base.length) : url;
    const bytes = ds.objects.get(key)!;
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
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
  return { fetch: fn, stats };
}

/** Backwards-compatible alias: the OPFS tests serve the transcoded fixture. */
function rangeFetch(): { fetch: typeof fetch; stats: { calls: number } } {
  return packedCountingFetch(DATASET);
}

const MANIFEST_URL = DATASET.manifestUrl;

describe('STTArchive + OpfsTileCache integration', () => {
  it('writes a decompressed payload to OPFS on cold miss', async () => {
    installShim();
    try {
      const cache = new OpfsTileCache();
      const { fetch: f } = rangeFetch();
      const a = new STTArchive({
        url: MANIFEST_URL,
        fetch: f,
        opfsCacheImpl: cache,
      });
      const index = await a.getIndex();
      const e = index.tiles[0];
      const tile = await a.getTile({
        z: e.zoom,
        x: e.x,
        y: e.y,
        t: e.timeStart,
      });
      expect(tile).not.toBeNull();
      // The OPFS write is fire-and-forget; await a tick so the microtask
      // chain that decompresses + writes can finish before we inspect.
      await settle(50);
      expect(cache.getEntryCount()).toBeGreaterThanOrEqual(1);
      expect(cache.getBytes()).toBeGreaterThan(0);
    } finally {
      uninstallShim();
    }
  });

  it('serves a warm hit from OPFS without re-fetching tile bytes', async () => {
    installShim();
    try {
      const sharedCache = new OpfsTileCache();
      // Cold pass — populate OPFS.
      {
        const { fetch: f } = rangeFetch();
        const a = new STTArchive({
          url: MANIFEST_URL,
          fetch: f,
          opfsCacheImpl: sharedCache,
        });
        const idx = await a.getIndex();
        const e = idx.tiles[0];
        await a.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
        await settle(50);
      }

      // Warm pass — same OPFS cache, fresh archive (simulates page reload).
      const { fetch: f2, stats: s2 } = rangeFetch();
      const b = new STTArchive({
        url: MANIFEST_URL,
        fetch: f2,
        opfsCacheImpl: sharedCache,
      });
      const idx2 = await b.getIndex();
      const e = idx2.tiles[0];
      const callsAfterOpen = s2.calls;
      const tile = await b.getTile({
        z: e.zoom,
        x: e.x,
        y: e.y,
        t: e.timeStart,
      });
      expect(tile).not.toBeNull();
      // No new fetches for the tile body — header + metadata + index are
      // the only HTTP calls. The tile range request was skipped.
      expect(s2.calls).toBe(callsAfterOpen);
      const stats = b.getCacheStats();
      expect(stats.opfs?.hits).toBe(1);
    } finally {
      uninstallShim();
    }
  });

  it('treats a different archive fingerprint as a fresh OPFS namespace', async () => {
    installShim();
    try {
      const sharedCache = new OpfsTileCache();
      // Two "deploys" of the SAME URL whose tiles changed → distinct
      // content-addressed directory keys → distinct OPFS fingerprints. (The
      // fingerprint is the manifest directory key, not a per-response ETag.)
      const v1 = packedFromGolden({
        manifestUrl: 'mem://sample/manifest.json',
      });
      const v2 = packedFromGolden({
        manifestUrl: 'mem://sample/manifest.json',
      });
      // Rebuild v2's directory with a harmless informational feature-count
      // change so the simulated redeploy has a distinct, valid content address.
      {
        const manifest = JSON.parse(
          new TextDecoder().decode(v2.objects.get('manifest.json')!),
        );
        const oldKey = manifest.directory.key;
        const entries = decodeDirectory(
          v2.objects.get(oldKey)!.subarray(OBJECT_MAGIC_LEN),
        );
        entries[0].featureCount++;
        const object = directoryObject(encodeDirectory(entries));
        const key = `index/${blake3Hex128(object)}.sttd`;
        v2.objects.delete(oldKey);
        v2.objects.set(key, object);
        manifest.directory.key = key;
        manifest.directory.length = object.length;
        v2.objects.set(
          'manifest.json',
          new TextEncoder().encode(JSON.stringify(manifest)),
        );
      }

      // Populate OPFS with the v1 deploy.
      {
        const { fetch: f } = packedCountingFetch(v1);
        const a = new STTArchive({
          url: v1.manifestUrl,
          fetch: f,
          opfsCacheImpl: sharedCache,
        });
        const idx = await a.getIndex();
        const e = idx.tiles[0];
        await a.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
        await settle(50);
      }

      // Same URL, redeployed (different directory hash) — should miss OPFS and
      // re-fetch the tile.
      const { fetch: f2, stats: s2 } = packedCountingFetch(v2);
      const b = new STTArchive({
        url: v2.manifestUrl,
        fetch: f2,
        opfsCacheImpl: sharedCache,
      });
      const idx2 = await b.getIndex();
      const e = idx2.tiles[0];
      const callsAfterOpen = s2.calls;
      const tile = await b.getTile({
        z: e.zoom,
        x: e.x,
        y: e.y,
        t: e.timeStart,
      });
      expect(tile).not.toBeNull();
      // The fingerprint differs, so the OPFS key differs — we expect a real
      // range request to have fired for the tile body.
      expect(s2.calls).toBeGreaterThan(callsAfterOpen);
      const stats = b.getCacheStats();
      expect(stats.opfs?.misses ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      uninstallShim();
    }
  });

  it('threads the tile zoom into the admission filter of its OWN cache (BH-9)', async () => {
    installShim();
    try {
      // `opfsCache: true` is the production path: the archive constructs the
      // cache itself and opts it into the admission filter. The byte cache is
      // switched off so each read is a real cold fetch that offers the
      // payload to OPFS.
      const { fetch: f } = rangeFetch();
      const a = new STTArchive({
        url: MANIFEST_URL,
        fetch: f,
        opfsCache: true,
        maxCacheTiles: 0,
      });
      const cache = a.getOpfsCache();
      expect(cache).toBeDefined();
      const idx = await a.getIndex();
      const e = idx.tiles[0];
      const id = { z: e.zoom, x: e.x, y: e.y, t: e.timeStart };
      expect(e.zoom).toBeGreaterThan(2); // a leaf tile, not an overview one

      // First cold touch: the fixture's tiles are well under 4 KiB, so the
      // doorkeeper turns this one away. That it is turned away AT ALL is the
      // proof that `id.z` reached the cache — with no zoom declared the
      // filter admits unconditionally.
      expect(await a.getTile(id)).not.toBeNull();
      await settle(50);
      expect(cache!.getEntryCount()).toBe(0);
      expect(cache!.getBytes()).toBe(0);

      // Second cold touch of the same tile: admitted, and readable.
      expect(await a.getTile(id)).not.toBeNull();
      await settle(50);
      expect(cache!.getEntryCount()).toBe(1);
      expect(cache!.getBytes()).toBeGreaterThan(0);
      expect(a.getCacheStats().opfs?.available).toBe(true);
    } finally {
      uninstallShim();
    }
  });

  it('leaves a caller-supplied cache on the incumbent admit-all policy', async () => {
    installShim();
    try {
      // The BYO instance keeps whatever policy its own constructor set — the
      // archive never reconfigures someone else's cache — so the same
      // sub-4 KiB leaf tile lands on the FIRST touch, exactly as before BH-9.
      const cache = new OpfsTileCache();
      const { fetch: f } = rangeFetch();
      const a = new STTArchive({
        url: MANIFEST_URL,
        fetch: f,
        opfsCacheImpl: cache,
        maxCacheTiles: 0,
      });
      const idx = await a.getIndex();
      const e = idx.tiles[0];
      expect(
        await a.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart }),
      ).not.toBeNull();
      await settle(50);
      expect(cache.getEntryCount()).toBe(1);
    } finally {
      uninstallShim();
    }
  });

  it('runs as a no-op when OPFS is unavailable (default in Node)', async () => {
    uninstallShim();
    const { fetch: f } = rangeFetch();
    // Don't pass opfsCacheImpl, don't pass opfsCache=true. The archive should
    // default to "OPFS off" in this environment and still work normally.
    const a = new STTArchive({ url: MANIFEST_URL, fetch: f });
    const idx = await a.getIndex();
    const e = idx.tiles[0];
    const tile = await a.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
    expect(tile).not.toBeNull();
    expect(a.getCacheStats().opfs).toBeUndefined();
  });
});

/**
 * The layout is documented in the module header:
 *   `<hex of the UTF-8 key bytes>.bin`
 * Mirrored here so the round-trip test can seed a legacy index by hand.
 */
function safeFileName(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `${hex}.bin`;
}

async function readIndex(
  root: MemDirectoryHandle,
): Promise<
  Record<string, { bytes: number; lastAccess: number; hits?: number }>
> {
  const dir = await root.getDirectoryHandle('stt-cache');
  const handle = await dir.getFileHandle('index.json');
  const parsed = JSON.parse(await (await handle.getFile()).text());
  return parsed.entries;
}

describe('OpfsTileCache — the additive per-entry `hits` counter (P0-2)', () => {
  it('counts one hit per successful get and stays monotone with lastAccess', async () => {
    const root = installShim();
    try {
      const cache = new OpfsTileCache();
      const payload = new Uint8Array([1, 2, 3, 4]);
      await cache.set('tile-a', payload);
      await cache.set('tile-b', payload);

      // A freshly written entry has never been re-read.
      expect(cache.peekEntry('tile-a')!.hits).toBe(0);

      // PROPERTY: over an arbitrary interleaving of reads, per key
      //   hits === the number of successful gets, and
      //   lastAccess strictly increases on every access (get OR set).
      const plan = ['a', 'a', 'b', 'a', 'b', 'a', 'a', 'b'] as const;
      const expected = { a: 0, b: 0 };
      let prevAccess = Math.max(
        cache.peekEntry('tile-a')!.lastAccess,
        cache.peekEntry('tile-b')!.lastAccess,
      );
      for (const which of plan) {
        const key = `tile-${which}`;
        expect(await cache.get(key)).not.toBeNull();
        expected[which]++;
        const entry = cache.peekEntry(key)!;
        expect(entry.hits).toBe(expected[which]);
        expect(entry.lastAccess).toBeGreaterThan(prevAccess);
        prevAccess = entry.lastAccess;
      }
      // Counts are per key — no cross-talk.
      expect(cache.peekEntry('tile-a')!.hits).toBe(5);
      expect(cache.peekEntry('tile-b')!.hits).toBe(3);

      // And they persist: the whole point is a zero-I/O re-access estimate on
      // the NEXT visit.
      await cache.flushIndex();
      const persisted = await readIndex(root);
      expect(persisted[safeFileName('tile-a')].hits).toBe(5);
      expect(persisted[safeFileName('tile-b')].hits).toBe(3);
    } finally {
      uninstallShim();
    }
  });

  it('carries the count across a re-write of the same key, and resets on clear', async () => {
    installShim();
    try {
      const cache = new OpfsTileCache();
      await cache.set('k', new Uint8Array([1]));
      await cache.get('k');
      await cache.get('k');
      expect(cache.peekEntry('k')!.hits).toBe(2);

      // Re-writing a key is the SAME logical tile (the cache key carries the
      // archive fingerprint) — its re-access history must survive.
      await cache.set('k', new Uint8Array([1, 2, 3]));
      expect(cache.peekEntry('k')!.hits).toBe(2);
      expect(cache.peekEntry('k')!.bytes).toBe(3);

      await cache.clear();
      expect(cache.peekEntry('k')).toBeNull();
      await cache.set('k', new Uint8Array([1]));
      expect(cache.peekEntry('k')!.hits).toBe(0);
    } finally {
      uninstallShim();
    }
  });

  it('does not count a hit when the payload file is gone (stale index entry)', async () => {
    const root = installShim();
    try {
      const cache = new OpfsTileCache();
      await cache.set('ghost', new Uint8Array([9]));
      await cache.get('ghost');
      expect(cache.peekEntry('ghost')!.hits).toBe(1);

      // Delete the payload behind the cache's back (a crashed tab, a
      // concurrent sweep). The index entry is forgotten, not credited.
      const dir = await root.getDirectoryHandle('stt-cache');
      await dir.removeEntry(safeFileName('ghost'));
      expect(await cache.get('ghost')).toBeNull();
      expect(cache.peekEntry('ghost')).toBeNull();
    } finally {
      uninstallShim();
    }
  });

  it('peekEntry() is pure — no hit, no lastAccess bump, no I/O', async () => {
    installShim();
    try {
      const cache = new OpfsTileCache();
      await cache.set('p', new Uint8Array([1]));
      const before = cache.peekEntry('p')!;
      const after = cache.peekEntry('p')!;
      expect(after).toEqual(before);
      expect(cache.peekEntry('missing')).toBeNull();
    } finally {
      uninstallShim();
    }
  });

  it('ROUND-TRIPS an older index that predates the field, defaulting hits to 0', async () => {
    const root = installShim();
    try {
      // Hand-write a v1 index in the OLD shape: no `hits` anywhere. This is
      // exactly what a returning visitor's disk holds.
      const dir = await root.getDirectoryHandle('stt-cache', { create: true });
      const legacy = {
        v: 1,
        totalBytes: 7,
        entries: {
          [safeFileName('old-a')]: { bytes: 4, lastAccess: 1000 },
          [safeFileName('old-b')]: { bytes: 3, lastAccess: 2000 },
        },
      };
      const idx = await dir.getFileHandle('index.json', { create: true });
      const w = await idx.createWritable();
      await w.write(JSON.stringify(legacy));
      await w.close();
      for (const [key, bytes] of [
        ['old-a', 4],
        ['old-b', 3],
      ] as Array<[string, number]>) {
        const h = await dir.getFileHandle(safeFileName(key), { create: true });
        const fw = await h.createWritable();
        await fw.write(new Uint8Array(bytes));
        await fw.close();
      }

      const cache = new OpfsTileCache();
      // Any op triggers the memoised init() → loadIndex().
      const a = await cache.get('old-a');
      expect(a).not.toBeNull();
      expect(a!.byteLength).toBe(4);

      // Nothing was wiped: both entries survive with their original bytes and
      // LRU stamps, and the untouched one is still at hits 0.
      expect(cache.getEntryCount()).toBe(2);
      expect(cache.getBytes()).toBe(7);
      const b = cache.peekEntry('old-b')!;
      expect(b).toEqual({ bytes: 3, lastAccess: 2000, hits: 0 });
      // The one we read got exactly one hit and a fresh (higher) stamp.
      const readBack = cache.peekEntry('old-a')!;
      expect(readBack.hits).toBe(1);
      expect(readBack.bytes).toBe(4);
      expect(readBack.lastAccess).toBeGreaterThan(2000);

      // Written back, the index is still v1 — the field is additive, the
      // format version does NOT move.
      await cache.flushIndex();
      const persistedDir = await root.getDirectoryHandle('stt-cache');
      const persisted = JSON.parse(
        await (
          await (await persistedDir.getFileHandle('index.json')).getFile()
        ).text(),
      );
      expect(persisted.v).toBe(1);
      expect(persisted.totalBytes).toBe(7);
      expect(persisted.entries[safeFileName('old-b')]).toEqual({
        bytes: 3,
        lastAccess: 2000,
        hits: 0,
      });
    } finally {
      uninstallShim();
    }
  });

  it('defaults a mangled hits value to 0 rather than wiping the index', async () => {
    const root = installShim();
    try {
      const dir = await root.getDirectoryHandle('stt-cache', { create: true });
      const legacy = {
        v: 1,
        totalBytes: 4,
        entries: {
          [safeFileName('weird')]: {
            bytes: 4,
            lastAccess: 500,
            hits: 'lots' as unknown as number,
          },
        },
      };
      const idx = await dir.getFileHandle('index.json', { create: true });
      const w = await idx.createWritable();
      await w.write(JSON.stringify(legacy));
      await w.close();
      const h = await dir.getFileHandle(safeFileName('weird'), {
        create: true,
      });
      const fw = await h.createWritable();
      await fw.write(new Uint8Array(4));
      await fw.close();

      const cache = new OpfsTileCache();
      expect(await cache.get('weird')).not.toBeNull();
      expect(cache.peekEntry('weird')!.hits).toBe(1); // 0 default, then +1
      expect(cache.getEntryCount()).toBe(1);
    } finally {
      uninstallShim();
    }
  });
});
