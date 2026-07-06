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
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { OpfsTileCache } from '../src/opfs-cache';
import {
  packedFromSingleFile,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';
import { bufferToArrayBuffer, settle } from './helpers/fixtures';
import { installShim, uninstallShim } from './helpers/opfs-shim';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const FIXTURE_BYTES = new Uint8Array(readFileSync(FIXTURE));
// The reader consumes the packed format; transcode the single-file fixture. The
// OPFS fingerprint now derives from the manifest's content-addressed directory
// key (stable across packs), NOT a per-response ETag.
const DATASET = packedFromSingleFile(FIXTURE_BYTES, { manifestUrl: 'mem://data/sample/manifest.json' });

/**
 * A counting `fetch` over an in-memory packed dataset. `.calls` counts ALL
 * HTTP calls (manifest + directory whole-GETs and pack range requests); tests
 * snapshot it after `getIndex()` so the delta isolates tile-body fetches.
 */
function packedCountingFetch(
  ds: InMemoryPackedDataset,
): { fetch: typeof fetch; stats: { calls: number } } {
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
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bufferToArrayBuffer(bytes) };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    return { ok: true, status: 206, statusText: 'Partial Content', arrayBuffer: async () => bufferToArrayBuffer(slice) };
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
      const a = new STTArchive({ url: MANIFEST_URL, fetch: f, opfsCacheImpl: cache });
      const index = await a.getIndex();
      const e = index.tiles[0];
      const tile = await a.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
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
      const tile = await b.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
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
      const v1 = packedFromSingleFile(FIXTURE_BYTES, {
        manifestUrl: 'mem://sample/manifest.json',
        directoryKey: 'index/v1.sttd',
      });
      const v2 = packedFromSingleFile(FIXTURE_BYTES, {
        manifestUrl: 'mem://sample/manifest.json',
        directoryKey: 'index/v2-redeployed.sttd',
      });

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
      const tile = await b.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
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
