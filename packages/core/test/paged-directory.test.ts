/**
 * Cross-impl + differential tests for the **paged directory** (Wave 2).
 *
 * Two Rust-produced fixtures hold the SAME 252-tile grid dataset in both
 * container shapes: `paged-golden/` (root page + 32 leaf pages) and
 * `paged-golden-single/` (one whole-load v5 directory). Because the two builds
 * share byte-identical blobs, the only difference is the `.sttd` container — so
 * the single build is an exact oracle for the paged build's query results.
 *
 * The tests prove:
 *  1. Paged `getTileIdsInBounds` returns IDENTICAL results to the whole-load
 *     directory for every viewport / zoom / time-window (correctness).
 *  2. Paging actually fires: a viewport with no tiles fetches ONLY the root
 *     page (temporal/spatial pruning), and a small viewport fetches a fraction
 *     of the directory — not the whole thing.
 *  3. Tile payloads decode byte-identically through the paged reader.
 *  4. The small-paged whole-load fast path (default threshold) still matches.
 *  5. Point queries (getTile by bucket timeStart) still find a tile whose
 *     leaf tMin derives from coverTMin > timeStart (synthetic regression).
 */

import { describe, it, expect } from 'vitest';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import {
  decodeDirectory,
  decodePagedRoot,
  encodeDirectory,
  type PageDescriptor,
} from '../src/directory';
import { unzstdSync } from '../src/compression';
import type { BoundingBox, TimeRange } from '../src/types';
import {
  directoryObject,
  loadPackedDatasetFromDisk,
  OBJECT_MAGIC_LEN,
  packObject,
  packedFetch,
  packedFromGolden,
  type InMemoryPackedDataset,
  type PackedFetchLog,
} from './helpers/packed-fixture';

const PAGED_DIR = fileURLToPath(
  new URL('./fixtures/paged-golden', import.meta.url),
);
const SINGLE_DIR = fileURLToPath(
  new URL('./fixtures/paged-golden-single', import.meta.url),
);

const paged = loadPackedDatasetFromDisk(
  nodeFs,
  PAGED_DIR,
  'mem://data/paged/manifest.json',
);
const single = loadPackedDatasetFromDisk(
  nodeFs,
  SINGLE_DIR,
  'mem://data/single/manifest.json',
);

const pagedManifest = JSON.parse(
  new TextDecoder().decode(paged.objects.get('manifest.json')!),
);
const PAGED_DIR_KEY: string = pagedManifest.directory.key;
const PAGED_DIR_LEN: number = pagedManifest.directory.length;
const PAGED_ROOT_LEN: number = pagedManifest.directory.rootLength;

/** A whole-load (oracle) archive over the single fixture. */
function singleArchive(): STTArchive {
  return new STTArchive({
    url: single.manifestUrl,
    fetch: packedFetch(single),
  });
}
/** A paged archive forced to stream every leaf (threshold 0), with a fetch log. */
function pagedArchive(log?: PackedFetchLog): STTArchive {
  return new STTArchive({
    url: paged.manifestUrl,
    fetch: packedFetch(paged, log),
    directoryPageThresholdBytes: 0,
  });
}

function sortedIds(
  ids: { z: number; x: number; y: number; t: number }[],
): string[] {
  return ids.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`).sort();
}

/** Total directory bytes fetched (sum of `.sttd` range lengths) from a log. */
function directoryBytesFetched(log: PackedFetchLog): number {
  let total = 0;
  for (const r of log.ranges) {
    if (r.path !== PAGED_DIR_KEY) continue;
    const m = /bytes=(\d+)-(\d+)/.exec(r.range)!;
    total += Number(m[2]) - Number(m[1]) + 1;
  }
  return total;
}

const HOUR = 3_600_000;
const FULL_TIME: TimeRange = { start: 0, end: 3 * HOUR };
// A bounded box that fully covers both the z10 and z12 grid blocks. Using this
// instead of the whole -180..180 world keeps the (existing) per-tile
// `boundsToTiles` scan small — production viewports are always bounded too — so
// it still selects EVERY leaf page without iterating millions of empty tiles.
const ALL_DATA: BoundingBox = { minLon: 0, minLat: 35, maxLon: 12, maxLat: 44 };

// Viewports chosen across the grid's geographic extent (zoom-10 block sits over
// ~[2.8,9.1]°lon × [37.8,41]°lat; zoom-12 block overlaps it). The single
// archive is the oracle, so the exact tile membership need not be hand-derived.
const QUERIES: Array<{
  name: string;
  bounds: BoundingBox;
  zoom: number;
  time: TimeRange;
}> = [
  { name: 'world @z10', bounds: ALL_DATA, zoom: 10, time: FULL_TIME },
  {
    name: 'sub-A @z10',
    bounds: { minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 },
    zoom: 10,
    time: FULL_TIME,
  },
  {
    name: 'sub-B @z10',
    bounds: { minLon: 6.5, minLat: 38, maxLon: 9, maxLat: 40 },
    zoom: 10,
    time: FULL_TIME,
  },
  {
    name: 'sub-A bucket0',
    bounds: { minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 },
    zoom: 10,
    time: { start: 0, end: 1 },
  },
  {
    name: 'sub-A bucket2',
    bounds: { minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 },
    zoom: 10,
    time: { start: 2 * HOUR, end: 2 * HOUR + 1 },
  },
  { name: 'world @z12', bounds: ALL_DATA, zoom: 12, time: FULL_TIME },
  {
    name: 'empty region',
    bounds: { minLon: -50, minLat: -30, maxLon: -40, maxLat: -20 },
    zoom: 10,
    time: FULL_TIME,
  },
];

describe('paged directory: cross-impl + differential', () => {
  it('the fixture really is paged, and its root decodes to sane descriptors', () => {
    expect(pagedManifest.directory.layout).toBe('paged');
    expect(PAGED_ROOT_LEN).toBeGreaterThan(0);
    expect(pagedManifest.directory.pageCount).toBe(32); // 252 tiles / 8 per page
    expect(pagedManifest.directory.encoding).toBe('zstd');

    // Decode the root frame the same way the reader does: skip the object's
    // 8-byte STTD prelude, then take the zstd-framed root prefix.
    const rootFrame = paged.objects
      .get(PAGED_DIR_KEY)!
      .subarray(OBJECT_MAGIC_LEN, OBJECT_MAGIC_LEN + PAGED_ROOT_LEN);
    const root = decodePagedRoot(unzstdSync(rootFrame));
    expect(root.pages.length).toBe(32);
    expect(root.pageEntries).toBe(8);

    let totalEntries = 0;
    let prevEnd = 0;
    for (const p of root.pages) {
      totalEntries += p.entryCount;
      expect(p.entryCount).toBeGreaterThan(0);
      expect(p.entryCount).toBeLessThanOrEqual(8);
      expect(p.minZoom).toBeLessThanOrEqual(p.maxZoom);
      expect([10, 12]).toContain(p.minZoom);
      expect(p.minLon).toBeLessThanOrEqual(p.maxLon);
      expect(p.minLat).toBeLessThanOrEqual(p.maxLat);
      expect(p.tMin).toBeLessThanOrEqual(p.tMax);
      // Leaves are laid out contiguously after the root.
      expect(p.relOffset).toBe(prevEnd);
      prevEnd += p.length;
    }
    expect(totalEntries).toBe(252);
  });

  it('paged query results are byte-identical to the whole-load oracle', async () => {
    const s = singleArchive();
    const p = pagedArchive();
    for (const q of QUERIES) {
      const want = sortedIds(
        await s.getTileIdsInBounds(q.bounds, q.zoom, q.time),
      );
      const got = sortedIds(
        await p.getTileIdsInBounds(q.bounds, q.zoom, q.time),
      );
      expect(got, `query ${q.name}`).toEqual(want);
    }
    // The world+full-time queries must actually return tiles (guards against a
    // vacuously-passing "both empty" result).
    const all = await p.getTileIdsInBounds(QUERIES[0].bounds, 10, FULL_TIME);
    expect(all.length).toBeGreaterThan(100);
  });

  it('prunes to only the root page when no tile matches', async () => {
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const p = pagedArchive(log);
    const ids = await p.getTileIdsInBounds(
      { minLon: -50, minLat: -30, maxLon: -40, maxLat: -20 },
      10,
      FULL_TIME,
    );
    expect(ids).toEqual([]);
    // Only the root page region was fetched — no leaf bytes. The reader's
    // prefix GET covers the object prelude plus the root frame.
    expect(directoryBytesFetched(log)).toBe(OBJECT_MAGIC_LEN + PAGED_ROOT_LEN);
    for (const r of log.ranges) {
      if (r.path !== PAGED_DIR_KEY) continue;
      const start = Number(/bytes=(\d+)-/.exec(r.range)![1]);
      expect(start, 'no leaf range fetched').toBeLessThan(
        OBJECT_MAGIC_LEN + PAGED_ROOT_LEN,
      );
    }
  });

  it('fetches only a fraction of the directory for a small viewport', async () => {
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const p = pagedArchive(log);
    await p.getTileIdsInBounds(
      { minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 },
      10,
      FULL_TIME,
    );
    const fetched = directoryBytesFetched(log);
    expect(fetched).toBeGreaterThan(OBJECT_MAGIC_LEN + PAGED_ROOT_LEN); // root + some leaves
    expect(fetched).toBeLessThan(PAGED_DIR_LEN); // not the whole directory
  });

  it('eventually fetches all leaves for a whole-world sweep', async () => {
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const p = pagedArchive(log);
    await p.getTileIdsInBounds(ALL_DATA, 10, FULL_TIME);
    await p.getTileIdsInBounds(ALL_DATA, 12, FULL_TIME);
    // Root + every leaf == the full directory (coalesced reads may overlap the
    // accounting slightly, so assert "at least the whole thing").
    expect(directoryBytesFetched(log)).toBeGreaterThanOrEqual(PAGED_DIR_LEN);
  });

  it('decodes tile payloads identically through the paged reader', async () => {
    const s = singleArchive();
    const p = pagedArchive();
    const oracleIds = await s.getTileIdsInBounds(ALL_DATA, 10, FULL_TIME);
    expect(oracleIds.length).toBeGreaterThan(0);
    // Sample a few tiles across the set.
    for (const id of [
      oracleIds[0],
      oracleIds[Math.floor(oracleIds.length / 2)],
      oracleIds[oracleIds.length - 1],
    ]) {
      const st = await s.getTile(id);
      const pt = await p.getTile(id);
      expect(pt).not.toBeNull();
      expect(st).not.toBeNull();
      const sf = st!.layers[0].features;
      const pf = pt!.layers[0].features;
      expect(pf.featureCount).toBe(sf.featureCount);
      expect(Array.from(pf.featureIds)).toEqual(Array.from(sf.featureIds));
      expect(Array.from(pf.positions)).toEqual(Array.from(sf.positions));
    }
  });

  it('small-paged whole-load fast path matches the oracle', async () => {
    // Default threshold (256 KiB) >> the 5.6 KB paged directory → the reader
    // grabs the whole object and decodes all pages, behaving like a single
    // directory. Results must still match the oracle.
    const s = singleArchive();
    const p = new STTArchive({
      url: paged.manifestUrl,
      fetch: packedFetch(paged),
    });
    for (const q of QUERIES) {
      const want = sortedIds(
        await s.getTileIdsInBounds(q.bounds, q.zoom, q.time),
      );
      const got = sortedIds(
        await p.getTileIdsInBounds(q.bounds, q.zoom, q.time),
      );
      expect(got, `whole-load paged ${q.name}`).toEqual(want);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: point-query leaf selection vs a covering-derived tMin
// ---------------------------------------------------------------------------
//
// A leaf descriptor's tMin is min(coverTMin ?? timeStart) over the leaf (spec
// §4.1), and coverTMin — the earliest feature START in a tile — can EXCEED the
// tile's bucket timeStart (the covering delta is signed in both directions).
// `ensurePagesForTiles` used to prune a leaf when `tMin > id.t`, so a
// getTile({t: bucket timeStart}) on such a tile skipped the only leaf holding
// it and returned null. Windowed queries (ensurePagesForBounds) are
// unaffected: their [start,end]-overlap test matches the descriptor's
// activity-window semantics.
//
// The Rust fixture generator emits coverTMin == timeStart, so this shape is
// built synthetically: a real decodable blob lifted from `packed-golden/`, wrapped
// in a hand-encoded two-leaf paged directory.

/** Encode a paged-directory root page (mirrors `decodePagedRoot`'s layout). */
function encodePagedRootBytes(pages: PageDescriptor[]): Uint8Array {
  const HEADER = 12;
  const DESC = 52;
  const out = new Uint8Array(HEADER + pages.length * DESC);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 1); // root_version
  dv.setUint8(1, 0); // descriptor_kind = geo-bbox
  dv.setUint32(4, pages.length, true);
  dv.setUint32(8, 1, true); // nominal page_entries
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
    o += 2; // reserved
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

describe('paged directory: point query with coverTMin > timeStart', () => {
  // The queried tile: bucket [1000, 1999] at z10/(520,384), earliest feature
  // start 1500 — the reporter's shape (coverTMin > bucket timeStart).
  const TARGET = { z: 10, x: 520, y: 384, t: 1000 };

  /** Two-leaf synthetic paged dataset: leaf 0 holds the target tile, leaf 1 a
   *  spatially distant decoy (bbox pruning must still skip it). */
  function syntheticCoverDataset(): {
    ds: InMemoryPackedDataset;
    dirKey: string;
    rootLength: number;
    leaf0Length: number;
  } {
    // A real decodable blob (+ its directory facts) from the sample fixture.
    const sample = packedFromGolden();
    const e = decodeDirectory(
      sample.objects.get('index/directory.sttd')!.subarray(OBJECT_MAGIC_LEN),
    )[0];
    const srcPack = sample.objects.get('packs/pack-0.sttp')!;
    const blob = srcPack.subarray(e.offset, e.offset + e.length);
    const sampleManifest = JSON.parse(
      new TextDecoder().decode(sample.objects.get('manifest.json')!),
    );

    const blobFields = {
      packId: 0,
      offset: OBJECT_MAGIC_LEN,
      length: e.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: 0,
      crc32c: e.crc32c,
      temporalBucketMs: 1000,
    };
    const target = {
      zoom: TARGET.z,
      x: TARGET.x,
      y: TARGET.y,
      timeStart: 1000,
      timeEnd: 1999,
      coverTMin: 1500,
      ...blobFields,
    };
    // Same shape, ~98° of longitude away (z10 x=800 sits at ~101°E).
    const decoy = { ...target, x: 800 };
    const leaf0 = encodeDirectory([target]);
    const leaf1 = encodeDirectory([decoy]);

    // Descriptors exactly as the writer derives them: tMin = coverTMin (1500),
    // tMax = timeEnd (1999); bboxes cover each leaf's tile.
    const pages: PageDescriptor[] = [
      {
        relOffset: 0,
        length: leaf0.length,
        entryCount: 1,
        minZoom: 10,
        maxZoom: 10,
        minLon: 2,
        minLat: 40,
        maxLon: 4,
        maxLat: 41.5,
        tMin: 1500,
        tMax: 1999,
      },
      {
        relOffset: leaf0.length,
        length: leaf1.length,
        entryCount: 1,
        minZoom: 10,
        maxZoom: 10,
        minLon: 101,
        minLat: 40,
        maxLon: 102,
        maxLat: 41.5,
        tMin: 1500,
        tMax: 1999,
      },
    ];
    const root = encodePagedRootBytes(pages);
    // Guard the hand-rolled encoder against layout drift from the decoder.
    expect(decodePagedRoot(root).pages).toEqual(pages);

    const sttd = new Uint8Array(root.length + leaf0.length + leaf1.length);
    sttd.set(root, 0);
    sttd.set(leaf0, root.length);
    sttd.set(leaf1, root.length + leaf0.length);

    const dirKey = 'index/dir.sttd';
    const objects = new Map<string, Uint8Array>();
    const sttdObject = directoryObject(sttd);
    const { bytes: packBytes } = packObject([blob]);
    objects.set(dirKey, sttdObject);
    objects.set('packs/p0.sttp', packBytes);
    const manifest = {
      format: 'stt-packed',
      formatVersion: 2,
      compression: sampleManifest.compression,
      directory: {
        key: dirKey,
        length: sttdObject.length,
        directoryVersion: 5,
        layout: 'paged',
        rootLength: root.length,
        pageCount: 2,
        pageEntries: 1,
      },
      packs: [{ key: 'packs/p0.sttp', length: packBytes.length }],
      metadata: sampleManifest.metadata,
    };
    objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    return {
      ds: { objects, manifestUrl: 'mem://data/cover/manifest.json' },
      dirKey,
      rootLength: root.length,
      leaf0Length: leaf0.length,
    };
  }

  it('getTile at the bucket timeStart finds the tile despite tMin > t', async () => {
    const { ds, dirKey, rootLength, leaf0Length } = syntheticCoverDataset();
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds, log),
      directoryPageThresholdBytes: 0, // force streaming leaf pages
    });

    // The miss: leaf 0's tMin (1500, coverTMin-derived) exceeds the query's
    // t (1000, the tile's own bucket timeStart) — the old `tMin > t` prune
    // skipped the leaf and this returned null.
    const tile = await archive.getTile(TARGET);
    expect(tile).not.toBeNull();
    expect(tile!.layers[0].features.featureCount).toBeGreaterThan(0);

    // The fix widens only the TEMPORAL axis: the spatially distant decoy leaf
    // must stay pruned by its bbox. Leaf 1 starts after the object prelude +
    // rootLength + leaf0Length;
    // no directory range may reach into it.
    const leaf1Start = OBJECT_MAGIC_LEN + rootLength + leaf0Length;
    let fetchedLeafBytes = false;
    for (const r of log.ranges) {
      if (r.path !== dirKey) continue;
      const m = /bytes=(\d+)-(\d+)/.exec(r.range)!;
      if (Number(m[1]) >= OBJECT_MAGIC_LEN + rootLength)
        fetchedLeafBytes = true;
      expect(Number(m[2]), 'decoy leaf must stay bbox-pruned').toBeLessThan(
        leaf1Start,
      );
    }
    expect(fetchedLeafBytes, 'the target leaf was actually streamed').toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: point-query upper prune (over-fetch)
// ---------------------------------------------------------------------------
//
// The widened lower test above removed the (unsound) `tMin > t` prune, but
// its replacement needs an upper bound at all: without one, a point query
// near the DATASET START faulted in every spatially-matching later leaf —
// `tMax < t` only prunes leaves entirely BEFORE the query. The sound bound
// (see ensurePagesForTiles) is `tMin <= id.t + maxBucketMs` for the leaf
// holding the tile, with maxBucketMs = max(base bucket, temporal-LOD tiers),
// so leaves with `tMin > id.t + maxBucketMs` are skipped.

describe('paged directory: point query near the dataset start does not fetch every later leaf', () => {
  const N_LEAVES = 8;
  const BUCKET = 1000;
  const TARGET = { z: 10, x: 520, y: 384, t: 0 };

  /** N single-entry leaves for the SAME spatial cell at successive buckets —
   *  every leaf passes the bbox/zoom tests, so only temporal pruning can
   *  keep the fetch bounded. */
  function manyLeafDataset(): {
    ds: InMemoryPackedDataset;
    dirKey: string;
    rootLength: number;
    leafOffsets: number[]; // rel offsets of each leaf (root-relative)
  } {
    const sample = packedFromGolden();
    const e = decodeDirectory(
      sample.objects.get('index/directory.sttd')!.subarray(OBJECT_MAGIC_LEN),
    )[0];
    const srcPack = sample.objects.get('packs/pack-0.sttp')!;
    const blob = srcPack.subarray(e.offset, e.offset + e.length);
    const sampleManifest = JSON.parse(
      new TextDecoder().decode(sample.objects.get('manifest.json')!),
    );

    const leaves: Uint8Array[] = [];
    const pages: PageDescriptor[] = [];
    let rel = 0;
    const leafOffsets: number[] = [];
    for (let i = 0; i < N_LEAVES; i++) {
      const t0 = i * BUCKET;
      const leaf = encodeDirectory([
        {
          zoom: TARGET.z,
          x: TARGET.x,
          y: TARGET.y,
          timeStart: t0,
          timeEnd: t0 + BUCKET - 1,
          packId: 0,
          offset: OBJECT_MAGIC_LEN,
          length: e.length,
          uncompressedSize: e.uncompressedSize,
          featureCount: e.featureCount,
          hilbert: 0,
          crc32c: e.crc32c,
          temporalBucketMs: BUCKET,
        },
      ]);
      leaves.push(leaf);
      leafOffsets.push(rel);
      pages.push({
        relOffset: rel,
        length: leaf.length,
        entryCount: 1,
        minZoom: 10,
        maxZoom: 10,
        minLon: 2,
        minLat: 40,
        maxLon: 4,
        maxLat: 41.5,
        tMin: t0,
        tMax: t0 + BUCKET - 1,
      });
      rel += leaf.length;
    }
    const root = encodePagedRootBytes(pages);
    expect(decodePagedRoot(root).pages).toEqual(pages);

    const sttd = new Uint8Array(root.length + rel);
    sttd.set(root, 0);
    for (let i = 0; i < N_LEAVES; i++)
      sttd.set(leaves[i], root.length + leafOffsets[i]);

    const dirKey = 'index/dir.sttd';
    const objects = new Map<string, Uint8Array>();
    const sttdObject = directoryObject(sttd);
    const { bytes: packBytes } = packObject([blob]);
    objects.set(dirKey, sttdObject);
    objects.set('packs/p0.sttp', packBytes);
    const manifest = {
      format: 'stt-packed',
      formatVersion: 2,
      compression: sampleManifest.compression,
      directory: {
        key: dirKey,
        length: sttdObject.length,
        directoryVersion: 5,
        layout: 'paged',
        rootLength: root.length,
        pageCount: N_LEAVES,
        pageEntries: 1,
      },
      packs: [{ key: 'packs/p0.sttp', length: packBytes.length }],
      // Base bucket = 1 s (and no temporal-LOD tiers), so the sound upper
      // prune is `tMin <= id.t + 1000`.
      metadata: { ...sampleManifest.metadata, temporal_bucket_ms: BUCKET },
    };
    objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    return {
      ds: { objects, manifestUrl: 'mem://data/many-leaf/manifest.json' },
      dirKey,
      rootLength: root.length,
      leafOffsets,
    };
  }

  it('fetches only the leaves within one max-bucket of the query, not all of them', async () => {
    const { ds, dirKey, rootLength, leafOffsets } = manyLeafDataset();
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds, log),
      directoryPageThresholdBytes: 0,
    });

    const tile = await archive.getTile(TARGET);
    expect(tile).not.toBeNull();
    expect(tile!.layers[0].features.featureCount).toBeGreaterThan(0);

    // Count the leaves the point query faulted in: a leaf i was fetched iff
    // some directory range covers its start byte. Only leaves 0 and 1 can
    // satisfy `tMin <= t + maxBucketMs` (tMin 0 and 1000 vs bound 1000) —
    // before the upper prune this query streamed ALL eight.
    const fetched = new Set<number>();
    for (const r of log.ranges) {
      if (r.path !== dirKey) continue;
      const m = /bytes=(\d+)-(\d+)/.exec(r.range)!;
      const [start, end] = [Number(m[1]), Number(m[2])];
      for (let i = 0; i < N_LEAVES; i++) {
        const abs = OBJECT_MAGIC_LEN + rootLength + leafOffsets[i];
        if (start <= abs && abs <= end) fetched.add(i);
      }
    }
    expect([...fetched].sort(), 'leaves fetched by the point query').toEqual([
      0, 1,
    ]);
  });
});
