/**
 * Reader integrity + memory accounting (format review 2026-07, T1.4 / T2.3):
 *
 *  1. CRC-32C verification on the decode path — a corrupted blob (or a
 *     directory whose CRC disagrees with the bytes) rejects that tile's
 *     decode with the distinctive "crc32c mismatch" message; the
 *  2. OPFS writes reuse the decoder's decompressed payload (no main-thread
 *     re-decompress on the default decoders).
 *  3. `estimateTileSize` deduplicates views by backing ArrayBuffer, so a
 *     zero-copy tile (every column a view into one Arrow IPC buffer) is no
 *     longer counted ~2×.
 *  4. `retainArrowIpc` retention policy for the raw Arrow IPC bytes.
 *
 * Exercises the INLINE decoder path (the Node default) end-to-end over the
 * transcoded Rust-built fixture — whose directory CRCs are the Rust writer's
 * own `crc32c_tag` values, so every successful decode in this file is also a
 * cross-implementation known-answer check.
 */

import { describe, it, expect } from 'vitest';
import {
  STTArchive,
  estimateTileSize,
  DEFAULT_RANGE_COALESCE_GAP,
  MIN_ADAPTIVE_COALESCE_GAP,
  MAX_ADAPTIVE_COALESCE_GAP,
} from '../src/archive';
import { OBJECT_MAGIC_LEN, directoryObject } from './helpers/packed-fixture';
import { decompressSync } from '../src/compression';
import { blake3Hex128 } from '../src/blake3';
import { crc32c } from '../src/crc32c';
import { decodeDirectory, encodeDirectory } from '../src/directory';
import { toGeoArrowTable } from '../src/tile';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
  type TileEntry,
} from '../src/types';
import type { OpfsTileCache } from '../src/opfs-cache';
import {
  packedFromGolden,
  packedFetch,
  type InMemoryPackedDataset,
  type PackedFetchLog,
} from './helpers/packed-fixture';

/** A fresh, mutation-isolated dataset (pack bytes are copied at transcode). */
function freshDataset(url: string): InMemoryPackedDataset {
  return packedFromGolden({ manifestUrl: url });
}

/** The single pack object of a default (uncapped) transcode. */
function packOf(ds: InMemoryPackedDataset): Uint8Array {
  const keys = [...ds.objects.keys()].filter((k) => k.startsWith('packs/'));
  expect(keys.length).toBe(1);
  return ds.objects.get(keys[0])!;
}

/** First directory entry + its tile id. */
async function firstEntry(archive: STTArchive): Promise<{
  e: TileEntry;
  id: { z: number; x: number; y: number; t: number };
}> {
  const index = await archive.getIndex();
  const e = index.tiles[0];
  return { e, id: { z: e.zoom, x: e.x, y: e.y, t: e.timeStart } };
}

/** Rewrite the dataset's directory with every run CRC flipped (blobs intact). */
function tamperDirectoryCrcs(ds: InMemoryPackedDataset): void {
  const manifest = JSON.parse(
    new TextDecoder().decode(ds.objects.get('manifest.json')!),
  );
  const entries = decodeDirectory(
    ds.objects.get(manifest.directory.key)!.subarray(OBJECT_MAGIC_LEN),
  );
  const dir = encodeDirectory(
    entries.map((e) => ({ ...e, crc32c: (e.crc32c ^ 0xffffffff) >>> 0 })),
  );
  const dirObject = directoryObject(dir);
  const oldKey = manifest.directory.key;
  const newKey = `index/${blake3Hex128(dirObject)}.sttd`;
  ds.objects.delete(oldKey);
  ds.objects.set(newKey, dirObject);
  manifest.directory.key = newKey;
  manifest.directory.length = dirObject.length;
  ds.objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
}

/**
 * Re-key a dataset's directory to its blake3-128 content address
 * (`index/<hash>.sttd`), matching the production writer, so the reader's
 * content-address enforcement has an address to verify against.
 */
function contentAddressedDataset(url: string): InMemoryPackedDataset {
  const ds = freshDataset(url);
  const manifest = JSON.parse(
    new TextDecoder().decode(ds.objects.get('manifest.json')!),
  );
  const oldKey = manifest.directory.key;
  const dirBytes = ds.objects.get(oldKey)!;
  const newKey = `index/${blake3Hex128(dirBytes)}.sttd`;
  ds.objects.delete(oldKey);
  ds.objects.set(newKey, dirBytes);
  manifest.directory.key = newKey;
  ds.objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  return ds;
}

describe('directory content-address verification (spec §9.2)', () => {
  it('opens a directory whose bytes match its content address', async () => {
    const ds = contentAddressedDataset('mem://dir-addr-ok/manifest.json');
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    const index = await archive.getIndex();
    expect(index.tiles.length).toBeGreaterThan(0);
  });

  it('rejects a tampered directory whose bytes no longer hash to its address', async () => {
    const ds = contentAddressedDataset('mem://dir-addr-bad/manifest.json');
    const manifest = JSON.parse(
      new TextDecoder().decode(ds.objects.get('manifest.json')!),
    );
    // Flip one byte in the directory object — the key (its declared address)
    // is unchanged, so the open MUST fail the content-address check before it
    // trusts a single tile offset out of the tampered directory.
    const dir = ds.objects.get(manifest.directory.key)!;
    dir[dir.length >> 1] ^= 0xff;
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    await expect(archive.getIndex()).rejects.toThrow(
      /content hash .* does not match/i,
    );
  });
});

describe('OPFS corrupt-entry self-heal', () => {
  it('refetches from origin when an OPFS payload is truncated (not a permanently blank tile)', async () => {
    const ds = freshDataset('mem://opfs-heal/manifest.json');
    const store = new Map<string, Uint8Array>();
    let servedCorrupt = false;
    const cacheStub = {
      get: async (k: string) => {
        if (store.has(k)) return store.get(k)!;
        // First lookup: a disk-corrupted (truncated) entry — wrong length vs
        // the directory's declared uncompressedSize.
        servedCorrupt = true;
        return new Uint8Array(3);
      },
      set: async (k: string, bytes: Uint8Array) => {
        store.set(k, bytes);
      },
      clear: async () => {
        store.clear();
      },
      getStats: () => ({ available: true, bytes: 0, entries: 0, maxBytes: 0 }),
    } as unknown as OpfsTileCache;

    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
      opfsCacheImpl: cacheStub,
    });
    const { e, id } = await firstEntry(archive);
    const tile = await archive.getTile(id);
    expect(servedCorrupt).toBe(true);
    // Self-heal: the corrupt entry did not blank the tile — it refetched.
    expect(tile).not.toBeNull();
    expect(tile!.layers[0].features.featureCount).toBeGreaterThan(0);
    // ...and the refetch overwrote the poisoned entry with a correct payload.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.size).toBe(1);
    expect([...store.values()][0].byteLength).toBe(e.uncompressedSize);
  });
});

describe('CRC-32C verification (T1.4)', () => {
  it('decodes the Rust-built fixture with verification ON (default) — CRCs agree cross-impl', async () => {
    const ds = freshDataset('mem://crc-ok/manifest.json');
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    const { e, id } = await firstEntry(archive);
    expect(e.crc32c).toBeGreaterThan(0); // the Rust writer recorded a real CRC
    const tile = await archive.getTile(id);
    expect(tile).not.toBeNull();
    expect(tile!.layers[0].features.featureCount).toBeGreaterThan(0);
  });

  it('rejects a corrupted blob with the distinctive crc32c message', async () => {
    const ds = freshDataset('mem://crc-corrupt/manifest.json');
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    const { e, id } = await firstEntry(archive);
    // Flip one byte in the middle of the blob — lengths are preserved, so
    // nothing before the CRC gate would notice.
    packOf(ds)[e.offset + (e.length >> 1)] ^= 0xff;
    await expect(archive.getTile(id)).rejects.toThrow(/crc32c mismatch/);
  });

  it('rejects when the directory CRC disagrees with intact bytes', async () => {
    const ds = freshDataset('mem://crc-dir/manifest.json');
    tamperDirectoryCrcs(ds);
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    const { id } = await firstEntry(archive);
    await expect(archive.getTile(id)).rejects.toThrow(/crc32c mismatch/);
  });

  it('getTiles surfaces a corrupt member as a per-tile null, not a batch failure', async () => {
    // The fixture dedups every entry onto one blob, so build a two-blob
    // dataset by duplicating its (decodable) blob at two offsets in one
    // pack, each entry carrying the blob's REAL CRC. The small gap keeps
    // both members in ONE coalesced range group — the group decode path
    // must fail only the corrupted member, not the whole batch.
    const src = freshDataset('mem://crc-batch-src/manifest.json');
    const srcManifest = JSON.parse(
      new TextDecoder().decode(src.objects.get('manifest.json')!),
    );
    const e = decodeDirectory(
      src.objects.get(srcManifest.directory.key)!.subarray(OBJECT_MAGIC_LEN),
    )[0];
    const blob = packOf(src).subarray(e.offset, e.offset + e.length);
    const PAD = 64;
    const stride = blob.length + PAD;
    const pack = new Uint8Array(2 * stride);
    pack.set(blob, 0);
    pack.set(blob, stride);
    const entries = [0, 1].map((i) => ({
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: i,
      timeEnd: i,
      packId: 0,
      offset: i * stride,
      length: blob.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: i,
      crc32c: crc32c(blob),
    }));
    const dir = encodeDirectory(entries);
    const objects = new Map<string, Uint8Array>();
    const dirObject = directoryObject(dir);
    objects.set('index/dir.sttd', dirObject);
    objects.set('packs/p0.sttp', pack);
    objects.set(
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'stt-packed',
          formatVersion: 3,
          variants: [{ id: 0, kind: 'raw' }],
          compression: srcManifest.compression,
          directory: {
            key: 'index/dir.sttd',
            length: dirObject.length,
            directoryVersion: 6,
          },
          packs: [{ key: 'packs/p0.sttp', length: pack.length }],
          metadata: srcManifest.metadata,
        }),
      ),
    );
    const ds: InMemoryPackedDataset = {
      objects,
      manifestUrl: 'mem://crc-batch/manifest.json',
    };

    // Corrupt only the SECOND copy.
    pack[stride + (blob.length >> 1)] ^= 0xff;

    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    await archive.getIndex();
    const ids = [
      { z: e.zoom, x: e.x, y: e.y, t: 0 },
      { z: e.zoom, x: e.x, y: e.y, t: 1 },
    ];
    const tiles = await archive.getTiles(ids);
    expect(tiles[0]).not.toBeNull();
    expect(tiles[1]).toBeNull();

    // SECOND batch — the poisoned-cache path. The corrupt bytes were cached
    // before verification; without per-tile catch + eviction on the
    // cache-hit decode path, this batch would REJECT wholesale (healthy
    // member included) and keep rejecting forever.
    const again = await archive.getTiles(ids);
    expect(again[0]).not.toBeNull();
    expect(again[1]).toBeNull();

    // Self-heal: the poisoned entry was evicted, so after the source
    // recovers (transient middlebox corruption) a fresh fetch decodes.
    pack[stride + (blob.length >> 1)] ^= 0xff; // repair
    const healed = await archive.getTiles(ids);
    expect(healed[1]).not.toBeNull();
  });
});

describe('CRC verification is invariant under the coalesce gap (CO-7)', () => {
  /**
   * Three copies of the golden blob in one pack, spaced by `pads`, each entry
   * carrying the blob's REAL CRC. Returns the dataset plus a mutator that
   * corrupts a chosen copy in place.
   */
  function spacedDataset(
    url: string,
    pads: number[],
  ): {
    ds: InMemoryPackedDataset;
    ids: Array<{ z: number; x: number; y: number; t: number }>;
    corrupt: (which: number) => void;
  } {
    const src = freshDataset('mem://crc-gap-src/manifest.json');
    const srcManifest = JSON.parse(
      new TextDecoder().decode(src.objects.get('manifest.json')!),
    );
    const e = decodeDirectory(
      src.objects.get(srcManifest.directory.key)!.subarray(OBJECT_MAGIC_LEN),
    )[0];
    const blob = packOf(src).subarray(e.offset, e.offset + e.length);

    let cursor = 0;
    const offsets = pads.map((pad) => {
      const offset = cursor + pad;
      cursor = offset + blob.length;
      return offset;
    });
    const pack = new Uint8Array(cursor);
    for (const offset of offsets) pack.set(blob, offset);

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
    }));
    const dirObject = directoryObject(encodeDirectory(entries));

    const objects = new Map<string, Uint8Array>();
    objects.set('index/dir.sttd', dirObject);
    objects.set('packs/p0.sttp', pack);
    objects.set(
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'stt-packed',
          formatVersion: 3,
          variants: [{ id: 0, kind: 'raw' }],
          compression: srcManifest.compression,
          directory: {
            key: 'index/dir.sttd',
            length: dirObject.length,
            directoryVersion: 6,
          },
          packs: [{ key: 'packs/p0.sttp', length: pack.length }],
          metadata: srcManifest.metadata,
        }),
      ),
    );

    return {
      ds: { objects, manifestUrl: url },
      ids: entries.map((entry) => ({
        z: entry.zoom,
        x: entry.x,
        y: entry.y,
        t: entry.timeStart,
      })),
      corrupt: (which: number) => {
        pack[offsets[which] + (blob.length >> 1)] ^= 0xff;
      },
    };
  }

  /**
   * The whole adaptive band plus its neighbours. Every value changes how many
   * of the three blobs share one HTTP range — 0 fuses nothing, MAX_SAFE fuses
   * everything — and none of it may change what CRC verification concludes.
   */
  const GAP_LADDER = [
    0,
    64 * 1024,
    MIN_ADAPTIVE_COALESCE_GAP,
    DEFAULT_RANGE_COALESCE_GAP,
    MAX_ADAPTIVE_COALESCE_GAP,
    Number.MAX_SAFE_INTEGER,
  ];
  /**
   * Pads chosen so the ladder actually spans "all split" → "all fused". They
   * sit INSIDE the amplification bound for ~830 B blobs (audit C3: a fuse may
   * bridge at most `4 × useful + 256 KiB` ≈ 260 KB), so `G` alone decides;
   * the previous 300 KB / 1.5 MB pads are now never bridged at any `G`.
   */
  const PADS = [0, 100_000, 200_000];

  it('every member of a fused buffer CRC-verifies, at every G', async () => {
    const requestCounts: number[] = [];
    for (const coalesceGapBytes of GAP_LADDER) {
      const built = spacedDataset(
        `mem://crc-gap-ok-${coalesceGapBytes}/`,
        PADS,
      );
      const log: PackedFetchLog = { paths: [], ranges: [] };
      const archive = new STTArchive({
        url: built.ds.manifestUrl + 'manifest.json',
        fetch: packedFetch(
          { ...built.ds, manifestUrl: built.ds.manifestUrl + 'manifest.json' },
          log,
        ),
        coalesceGapBytes,
      });
      const tiles = await archive.getTiles(built.ids);
      for (const tile of tiles) {
        expect(tile).not.toBeNull();
        expect(tile!.layers[0].features.featureCount).toBeGreaterThan(0);
      }
      requestCounts.push(log.ranges.length);
    }
    // The ladder really did move the fuse decisions (otherwise the invariance
    // above would be vacuous): it spans one-request-per-blob to one request.
    expect(Math.max(...requestCounts)).toBe(PADS.length);
    expect(Math.min(...requestCounts)).toBe(1);
  });

  it('a corrupt member fails ALONE, at every G — fusing never bypasses the check', async () => {
    for (const coalesceGapBytes of GAP_LADDER) {
      const built = spacedDataset(
        `mem://crc-gap-bad-${coalesceGapBytes}/`,
        PADS,
      );
      built.corrupt(1); // the middle blob only
      const archive = new STTArchive({
        url: built.ds.manifestUrl + 'manifest.json',
        fetch: packedFetch({
          ...built.ds,
          manifestUrl: built.ds.manifestUrl + 'manifest.json',
        }),
        coalesceGapBytes,
      });
      const tiles = await archive.getTiles(built.ids);
      // Whether the three blobs arrived in one buffer or three, the slice-and-
      // verify path reaches the same verdict per member.
      expect(tiles[0]).not.toBeNull();
      expect(tiles[1]).toBeNull();
      expect(tiles[2]).not.toBeNull();
    }
  });
});

describe('OPFS decompressed-payload reuse (D2)', () => {
  it('writes the decoder-returned payload (byte-equal to decompressing the blob)', async () => {
    const ds = freshDataset('mem://opfs-payload/manifest.json');
    const writes: Array<{ key: string; bytes: Uint8Array }> = [];
    const cacheStub = {
      get: async () => null,
      set: async (key: string, bytes: Uint8Array) => {
        writes.push({ key, bytes });
      },
      clear: async () => {},
      getStats: () => ({ available: true, bytes: 0, entries: 0, maxBytes: 0 }),
    } as unknown as OpfsTileCache;
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
      opfsCacheImpl: cacheStub,
    });
    const { e, id } = await firstEntry(archive);
    const tile = await archive.getTile(id);
    expect(tile).not.toBeNull();
    // The OPFS write is fire-and-forget; let the microtask/timer queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes.length).toBe(1);
    const blob = packOf(ds).subarray(e.offset, e.offset + e.length);
    const expected = decompressSync(blob, e.compression);
    expect(writes[0].bytes).toEqual(expected);
  });
});

describe('estimateTileSize alias dedup (T2.3)', () => {
  /** A minimal synthetic tile around the given features + optional IPC view. */
  function makeTile(features: BinaryFeatures, arrowIpc?: Uint8Array): Tile {
    return {
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      layers: [
        {
          name: 'points',
          extent: 0,
          features,
          geometryExtensionName: 'geoarrow.point',
          arrowIpc,
        },
      ],
    };
  }

  it('counts a shared backing buffer ONCE (zero-copy tile shape)', () => {
    // Zero-copy point tile: every column (and arrowIpc) is a view into ONE
    // backing buffer, like an aligned-frame Arrow IPC decode.
    const backing = new ArrayBuffer(1024);
    const features: BinaryFeatures = {
      featureCount: 4,
      geometryType: GeometryType.Point,
      positions: new Float64Array(backing, 0, 8),
      featureIds: new Uint32Array(backing, 64, 4),
      startTimes: new Float32Array(backing, 80, 4),
      endTimes: new Float32Array(backing, 96, 4),
      timeOffset: 0,
      numericProps: { speed: new Float32Array(backing, 112, 4) },
      categoricalProps: {},
    };
    const size = estimateTileSize(makeTile(features, new Uint8Array(backing)));
    // 1000 base + the ONE backing buffer. The old per-view sum counted the
    // 1024-byte arrowIpc AND every column again (~2× for zero-copy tiles).
    expect(size).toBe(1000 + 1024);
  });

  it('sums distinct buffers as before', () => {
    const features: BinaryFeatures = {
      featureCount: 4,
      geometryType: GeometryType.Point,
      positions: new Float64Array(8), // 64 B
      featureIds: new Uint32Array(4), // 16 B
      startTimes: new Float32Array(4), // 16 B
      endTimes: new Float32Array(4), // 16 B
      timeOffset: 0,
      numericProps: { speed: new Float32Array(4) }, // 16 B
      categoricalProps: {
        kind: { indices: new Uint16Array(4), categories: ['a', 'bc'] }, // 8 B + strings
      },
    };
    const size = estimateTileSize(makeTile(features));
    // 1000 + 64 + 16 + 16 + 16 + 16 + 8 + ('a': 2+16) + ('bc': 4+16)
    expect(size).toBe(1000 + 64 + 16 + 16 + 16 + 16 + 8 + 18 + 20);
  });

  it('a subarray view retains (and is charged for) its whole backing buffer', () => {
    const backing = new ArrayBuffer(4096);
    const features: BinaryFeatures = {
      featureCount: 1,
      geometryType: GeometryType.Point,
      positions: new Float64Array(backing, 0, 2), // 16 B view, 4096 B retained
      featureIds: new Uint32Array(1),
      startTimes: new Float32Array(1),
      endTimes: new Float32Array(1),
      timeOffset: 0,
      numericProps: {},
      categoricalProps: {},
    };
    const size = estimateTileSize(makeTile(features));
    expect(size).toBe(1000 + 4096 + 4 + 4 + 4);
  });
});

describe('retainArrowIpc retention policy (T2.3)', () => {
  it("'auto' (default) keeps the IPC bytes for unquantized layers — valid GeoArrow stays available", async () => {
    // 'auto' is SEMANTIC: it drops only coordinate-quantized layers, whose
    // tables are not literal GeoArrow anyway. The v4 sample fixture is
    // UNQUANTIZED (Float64 lon/lat), so the hand-off must keep working
    // under the default with no extra option — even though the legacy
    // unaligned frame means no extracted column aliases the IPC buffer.
    // (The aliasing-keyed 'auto' dropped exactly this valid-GeoArrow case —
    // the published-API regression this test now pins.)
    const ds = freshDataset('mem://ipc-auto/manifest.json');
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    const { id } = await firstEntry(archive);
    const tile = await archive.getTile(id);
    const layer = tile!.layers[0];
    expect(layer.coordinatesQuantized).toBe(false);
    expect(layer.arrowIpc).toBeDefined();
    expect(layer.arrowIpcDropped).toBeUndefined();
    const table = toGeoArrowTable(layer);
    expect(table.numRows).toBe(layer.features.featureCount);
  });

  it('true always keeps the IPC bytes for the GeoArrow hand-off', async () => {
    const ds = freshDataset('mem://ipc-true/manifest.json');
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
      retainArrowIpc: true,
    });
    const { id } = await firstEntry(archive);
    const tile = await archive.getTile(id);
    const layer = tile!.layers[0];
    expect(layer.arrowIpc).toBeDefined();
    const table = toGeoArrowTable(layer);
    expect(table.numRows).toBe(layer.features.featureCount);
  });

  it('false always drops, and toGeoArrowTable names the option', async () => {
    const ds = freshDataset('mem://ipc-false/manifest.json');
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
      retainArrowIpc: false,
    });
    const { id } = await firstEntry(archive);
    const tile = await archive.getTile(id);
    const layer = tile!.layers[0];
    expect(layer.arrowIpc).toBeUndefined();
    expect(layer.arrowTable).toBeUndefined();
    expect(() => toGeoArrowTable(layer)).toThrow(/retainArrowIpc: true/);
  });
});
