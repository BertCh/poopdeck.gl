/**
 * Cross-impl contract test for the STT **packed format**.
 *
 * Reads the committed golden fixture (a real Rust-produced packed dataset:
 * `manifest.json` + `index/<hash>.sttd` + `packs/<hash>.sttp`) through the
 * TypeScript `STTArchive`, proving the TS reader and the Rust writer agree on:
 *   - the manifest schema (format / packs / folded metadata),
 *   - the v5 directory (per-run `pack_id` + pack-relative offsets, incl. the
 *     byte-identical dedup that shares ONE blob across k=0,4,9), and
 *   - the per-blob zstd tile payloads (feature ids / coords / times).
 *
 * Deterministic golden payload scheme (see the generator): 12 tiles, zoom 10,
 * cells (x,0) for x=0..11, one "default" point layer per tile. Tile k has
 * feature ids [100*s, 100*s+1, 100*s+2] and point (-122.4 + 0.01*s, 37.7),
 * where s=k EXCEPT k=4 and k=9 use s=0 — so those three blobs are byte-
 * identical and dedup to ONE blob shared at packId 0, offset 0. The DIRECTORY
 * addresses tile k at time_start=1000*k, temporal_bucket_ms=1000,
 * cover_t_min=1000*k; the per-feature times inside every blob are a fixed
 * 0..100 window (the payload varies only by id/coord, which is what makes the
 * s=0 trio byte-identical). 2 packs, 10 distinct blobs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { GeometryType } from '../src/types';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/packed-golden/', import.meta.url));

function bufferToArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

interface FetchLog {
  /** Every requested path (relative to the fixture dir). */
  paths: string[];
  /** Per-path Range requests, e.g. "bytes=0-535". */
  ranges: Array<{ path: string; range: string }>;
}

/**
 * A `fetch` shim that serves the local fixture dir. The `url` is treated as a
 * path under `FIXTURE_DIR` (the leading scheme/host, if any, is stripped down
 * to the path after the fixture base). Whole GET → 200; Range → 206 via Buffer
 * slicing. Every call is recorded in `log`.
 */
function fixtureFetch(log: FetchLog): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    // Resolve to a path under the fixture dir. The reader builds URLs as
    // `<base><key>`, where base is the manifest URL minus its last segment, so
    // the tail after "packed-golden/" (or the bare key) is the file path.
    let rel = url;
    const marker = 'packed-golden/';
    const at = url.indexOf(marker);
    if (at >= 0) rel = url.slice(at + marker.length);
    else if (rel.endsWith('manifest.json')) rel = 'manifest.json';
    log.paths.push(rel);

    const bytes = new Uint8Array(readFileSync(FIXTURE_DIR + rel));
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
    log.ranges.push({ path: rel, range: range! });
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
}

/** The seed `s` for tile k (k=4 and k=9 alias to seed 0 via dedup). */
function seedFor(k: number): number {
  return k === 4 || k === 9 ? 0 : k;
}

function makeArchive(log: FetchLog): STTArchive {
  return new STTArchive({
    url: 'https://cdn.example/data/packed-golden/manifest.json',
    fetch: fixtureFetch(log),
  });
}

function emptyLog(): FetchLog {
  return { paths: [], ranges: [] };
}

describe('STT packed format (golden fixture)', () => {
  it('parses the manifest and folds the metadata in', async () => {
    const log = emptyLog();
    const archive = makeArchive(log);
    const meta = await archive.getMetadata();
    expect(meta.name).toBe('packed-golden');
    expect(meta.minZoom).toBe(10);
    expect(meta.maxZoom).toBe(10);
    expect(meta.temporalBucketMs).toBe(1000);
    // Metadata comes from the manifest — a single whole-object GET, no Range.
    expect(log.paths).toContain('manifest.json');
    expect(log.ranges.length).toBe(0);
  });

  it('decodes the v5 directory: 12 entries with the expected packId/offset', async () => {
    const log = emptyLog();
    const archive = makeArchive(log);
    const index = await archive.getIndex();
    expect(index.tiles.length).toBe(12);

    // Index by x (each tile is cell (x,0), x = 0..11).
    const byX = new Map<number, (typeof index.tiles)[number]>();
    for (const t of index.tiles) {
      expect(t.zoom).toBe(10);
      expect(t.y).toBe(0);
      byX.set(t.x, t);
    }
    expect([...byX.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, k) => k),
    );

    for (let k = 0; k < 12; k++) {
      const e = byX.get(k)!;
      expect(e.timeStart).toBe(1000 * k);
      expect(e.timeEnd).toBe(1000 * k + 100);
      expect(e.coverTMin).toBe(1000 * k);
      expect(e.temporalBucketMs).toBe(1000);
      expect(e.featureCount).toBe(3);
    }

    // Dedup: k=0, k=4, k=9 are byte-identical → one shared blob at
    // packId 0, offset 0.
    for (const k of [0, 4, 9]) {
      expect(byX.get(k)!.packId).toBe(0);
      expect(byX.get(k)!.offset).toBe(0);
    }
    const e0 = byX.get(0)!;
    expect(byX.get(4)!.length).toBe(e0.length);
    expect(byX.get(9)!.length).toBe(e0.length);

    // 2 packs: at least one entry lands in pack 1 (the cut to a second object),
    // and every pack's offsets are pack-relative (each pack has an offset-0 run).
    const packIds = new Set(index.tiles.map((t) => t.packId));
    expect(packIds).toEqual(new Set([0, 1]));
    for (const pid of packIds) {
      expect(index.tiles.some((t) => t.packId === pid && t.offset === 0)).toBe(true);
    }
  });

  it('getTile decodes several k to the expected ids / coords / times', async () => {
    const log = emptyLog();
    const archive = makeArchive(log);
    await archive.getIndex();

    for (const k of [0, 1, 3, 4, 8, 9, 11]) {
      const s = seedFor(k);
      const tile = await archive.getTile({ z: 10, x: k, y: 0, t: 1000 * k });
      expect(tile, `tile k=${k}`).not.toBeNull();
      expect(tile!.layers.length).toBe(1);
      const layer = tile!.layers[0];
      expect(layer.name).toBe('default');
      const f = layer.features;
      expect(f.geometryType).toBe(GeometryType.Point);
      expect(f.featureCount).toBe(3);

      // Feature ids [100*s, 100*s+1, 100*s+2].
      expect(Array.from(f.featureIds).map(Number).sort((a, b) => a - b)).toEqual([
        100 * s,
        100 * s + 1,
        100 * s + 2,
      ]);

      // Point (-122.4 + 0.01*s, 37.7) for all three features.
      for (let i = 0; i < f.positions.length; i += 2) {
        expect(f.positions[i]).toBeCloseTo(-122.4 + 0.01 * s, 4);
        expect(f.positions[i + 1]).toBeCloseTo(37.7, 4);
      }

      // The tile's interval comes from the directory entry: [1000*k, 1000*k+100].
      expect(tile!.timeRange.start).toBe(1000 * k);
      expect(tile!.timeRange.end).toBe(1000 * k + 100);

      // Per-feature times inside the blob are the fixed 0..100 window (varying
      // only the id/coord is what makes the s=0 trio byte-identical → deduped).
      for (let i = 0; i < f.startTimes.length; i++) {
        expect(Number(f.startTimes[i])).toBe(0);
        expect(Number(f.endTimes[i])).toBe(100);
      }
    }
  });

  it('getTiles over all 12 returns every tile and coalesces per pack', async () => {
    const log = emptyLog();
    const archive = makeArchive(log);
    await archive.getIndex();

    const ids = Array.from({ length: 12 }, (_, k) => ({ z: 10, x: k, y: 0, t: 1000 * k }));
    const before = log.ranges.length;
    const tiles = await archive.getTiles(ids);
    const packRanges = log.ranges.slice(before);

    // Every tile decoded to the right seed's feature ids.
    expect(tiles.length).toBe(12);
    for (let k = 0; k < 12; k++) {
      const s = seedFor(k);
      const t = tiles[k];
      expect(t, `batch tile k=${k}`).not.toBeNull();
      const f = t!.layers[0].features;
      expect(Array.from(f.featureIds).map(Number).sort((a, b) => a - b)).toEqual([
        100 * s,
        100 * s + 1,
        100 * s + 2,
      ]);
    }

    // All range requests were against pack objects (never the manifest/dir).
    for (const r of packRanges) {
      expect(r.path.startsWith('packs/')).toBe(true);
    }
    // Per-pack coalescing: with the default 2 MB gap the contiguous blobs in a
    // pack fuse into ONE range each, and a range never bridges two packs — so
    // the batch issues exactly one range per pack (2 packs → 2 requests).
    const distinctPackObjects = new Set(packRanges.map((r) => r.path));
    expect(distinctPackObjects.size).toBe(2);
    expect(packRanges.length).toBe(2);
  });

  it('per-pack coalescing never bridges two pack objects', async () => {
    const log = emptyLog();
    const archive = makeArchive(log);
    await archive.getIndex();

    // Request one tile from pack 0 (k=0) and one from pack 1 (k=8). Even with an
    // unbounded coalesce gap these CANNOT merge — they live in different
    // objects, so the reader must issue (at least) one range per pack.
    const wide = new STTArchive({
      url: 'https://cdn.example/data/packed-golden/manifest.json',
      fetch: fixtureFetch(log),
      coalesceGapBytes: Number.MAX_SAFE_INTEGER,
    });
    await wide.getIndex();
    const before = log.ranges.length;
    const tiles = await wide.getTiles([
      { z: 10, x: 0, y: 0, t: 0 },
      { z: 10, x: 8, y: 0, t: 8000 },
    ]);
    const ranges = log.ranges.slice(before);
    expect(tiles.every((t) => t !== null)).toBe(true);
    const objects = new Set(ranges.map((r) => r.path));
    expect(objects.size).toBe(2); // one pack-0 range + one pack-1 range
  });
});
