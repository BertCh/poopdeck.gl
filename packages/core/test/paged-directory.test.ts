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
 */

import { describe, it, expect } from 'vitest';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { decodePagedRoot } from '../src/directory';
import { unzstdSync } from '../src/compression';
import type { BoundingBox, TimeRange } from '../src/types';
import { loadPackedDatasetFromDisk, packedFetch, type PackedFetchLog } from './helpers/packed-fixture';

const PAGED_DIR = fileURLToPath(new URL('./fixtures/paged-golden', import.meta.url));
const SINGLE_DIR = fileURLToPath(new URL('./fixtures/paged-golden-single', import.meta.url));

const paged = loadPackedDatasetFromDisk(nodeFs, PAGED_DIR, 'mem://data/paged/manifest.json');
const single = loadPackedDatasetFromDisk(nodeFs, SINGLE_DIR, 'mem://data/single/manifest.json');

const pagedManifest = JSON.parse(new TextDecoder().decode(paged.objects.get('manifest.json')!));
const PAGED_DIR_KEY: string = pagedManifest.directory.key;
const PAGED_DIR_LEN: number = pagedManifest.directory.length;
const PAGED_ROOT_LEN: number = pagedManifest.directory.rootLength;

/** A whole-load (oracle) archive over the single fixture. */
function singleArchive(): STTArchive {
  return new STTArchive({ url: single.manifestUrl, fetch: packedFetch(single) });
}
/** A paged archive forced to stream every leaf (threshold 0), with a fetch log. */
function pagedArchive(log?: PackedFetchLog): STTArchive {
  return new STTArchive({
    url: paged.manifestUrl,
    fetch: packedFetch(paged, log),
    directoryPageThresholdBytes: 0,
  });
}

function sortedIds(ids: { z: number; x: number; y: number; t: number }[]): string[] {
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
const QUERIES: Array<{ name: string; bounds: BoundingBox; zoom: number; time: TimeRange }> = [
  { name: 'world @z10', bounds: ALL_DATA, zoom: 10, time: FULL_TIME },
  { name: 'sub-A @z10', bounds: { minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 }, zoom: 10, time: FULL_TIME },
  { name: 'sub-B @z10', bounds: { minLon: 6.5, minLat: 38, maxLon: 9, maxLat: 40 }, zoom: 10, time: FULL_TIME },
  { name: 'sub-A bucket0', bounds: { minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 }, zoom: 10, time: { start: 0, end: 1 } },
  { name: 'sub-A bucket2', bounds: { minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 }, zoom: 10, time: { start: 2 * HOUR, end: 2 * HOUR + 1 } },
  { name: 'world @z12', bounds: ALL_DATA, zoom: 12, time: FULL_TIME },
  { name: 'empty region', bounds: { minLon: -50, minLat: -30, maxLon: -40, maxLat: -20 }, zoom: 10, time: FULL_TIME },
];

describe('paged directory: cross-impl + differential', () => {
  it('the fixture really is paged, and its root decodes to sane descriptors', () => {
    expect(pagedManifest.directory.layout).toBe('paged');
    expect(PAGED_ROOT_LEN).toBeGreaterThan(0);
    expect(pagedManifest.directory.pageCount).toBe(32); // 252 tiles / 8 per page
    expect(pagedManifest.directory.encoding).toBe('zstd');

    // Decode the root frame the same way the reader does (zstd-framed prefix).
    const rootFrame = paged.objects.get(PAGED_DIR_KEY)!.subarray(0, PAGED_ROOT_LEN);
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
      const want = sortedIds(await s.getTileIdsInBounds(q.bounds, q.zoom, q.time));
      const got = sortedIds(await p.getTileIdsInBounds(q.bounds, q.zoom, q.time));
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
    // Only the root page region was fetched — no leaf bytes.
    expect(directoryBytesFetched(log)).toBe(PAGED_ROOT_LEN);
    for (const r of log.ranges) {
      if (r.path !== PAGED_DIR_KEY) continue;
      const start = Number(/bytes=(\d+)-/.exec(r.range)![1]);
      expect(start, 'no leaf range fetched').toBeLessThan(PAGED_ROOT_LEN);
    }
  });

  it('fetches only a fraction of the directory for a small viewport', async () => {
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const p = pagedArchive(log);
    await p.getTileIdsInBounds({ minLon: 3, minLat: 39, maxLon: 5, maxLat: 41 }, 10, FULL_TIME);
    const fetched = directoryBytesFetched(log);
    expect(fetched).toBeGreaterThan(PAGED_ROOT_LEN); // root + some leaves
    expect(fetched).toBeLessThan(PAGED_DIR_LEN); // not the whole directory
  });

  it('eventually fetches all leaves for a whole-world sweep', async () => {
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const p = pagedArchive(log);
    await p.getTileIdsInBounds(
      ALL_DATA,
      10,
      FULL_TIME,
    );
    await p.getTileIdsInBounds(
      ALL_DATA,
      12,
      FULL_TIME,
    );
    // Root + every leaf == the full directory (coalesced reads may overlap the
    // accounting slightly, so assert "at least the whole thing").
    expect(directoryBytesFetched(log)).toBeGreaterThanOrEqual(PAGED_DIR_LEN);
  });

  it('decodes tile payloads identically through the paged reader', async () => {
    const s = singleArchive();
    const p = pagedArchive();
    const oracleIds = await s.getTileIdsInBounds(
      ALL_DATA,
      10,
      FULL_TIME,
    );
    expect(oracleIds.length).toBeGreaterThan(0);
    // Sample a few tiles across the set.
    for (const id of [oracleIds[0], oracleIds[Math.floor(oracleIds.length / 2)], oracleIds[oracleIds.length - 1]]) {
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
    const p = new STTArchive({ url: paged.manifestUrl, fetch: packedFetch(paged) });
    for (const q of QUERIES) {
      const want = sortedIds(await s.getTileIdsInBounds(q.bounds, q.zoom, q.time));
      const got = sortedIds(await p.getTileIdsInBounds(q.bounds, q.zoom, q.time));
      expect(got, `whole-load paged ${q.name}`).toEqual(want);
    }
  });
});
