/**
 * Temporal-LOD scaffold: reader-side dispatch.
 *
 * The Rust build pipeline emits one tile per (z, x, y, lod_bucket_start) for
 * each declared LOD level, alongside the base-bucket tiles, and tags each
 * directory entry with its `temporal_bucket_ms`. These tests drive the TS
 * reader against synthetic archives that mimic that shape (built by hand
 * from Arrow IPC + a header) and exercise the level-dispatch APIs.
 *
 * Goals (per task spec):
 *   - getTileIdsInBoundsForTemporalLod(bounds, zoom, timeRange, bucketMs)
 *     returns tiles from the matching LOD level.
 *   - pickTemporalLodForZoom(zoom) picks the coarsest applicable level.
 *   - Legacy archives (no `temporal_lod` field, no `temporal_bucket_ms`
 *     column) still parse and the default API returns the base tiles
 *     unchanged.
 */

import { describe, it, expect } from 'vitest';
import { STTArchive } from '../src/archive';
import { directoryObject, packObject } from './helpers/packed-fixture';
import { encodeDirectory } from '../src/directory';
import {
  packedFetch,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';

// ---------------------------------------------------------------------------
// Helpers: build a minimal PACKED archive in memory
//
// The reader consumes the packed format (manifest + index + packs). These
// LOD-dispatch tests only walk the directory, so a single pack of 1-byte dummy
// blobs is enough; the v5 directory carries the temporal_bucket_ms column.
// ---------------------------------------------------------------------------

interface SynthTile {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  bucketMs?: number; // when set, the synth index emits the column
  /** Dummy blob byte length (default 1) — lets tests tell tiers apart. */
  blobSize?: number;
}

let synthSeq = 0;

function buildSyntheticArchive(opts: {
  tiles: SynthTile[];
  metadata: any;
  /**
   * When false, the directory schema OMITS the `temporal_bucket_ms` column
   * entirely — simulates an archive built before the LOD scaffold.
   */
  writeBucketColumn: boolean;
}): InMemoryPackedDataset {
  const tiles = opts.tiles;
  // Dummy tile blobs — the reader path under test only walks the directory.
  // Each tile has a 1-byte payload (unless sized) so offsets stay distinct.
  const tileBlobs: Uint8Array[] = tiles.map((t, i) =>
    new Uint8Array(t.blobSize ?? 1).fill(i & 0xff),
  );

  // One pack holding all blobs back-to-back; the directory records
  // object-absolute offsets (packId 0).
  const { bytes: pack, offsets: blobOffsets } = packObject(tileBlobs);

  // Build the v5 directory. `writeBucketColumn === false` simulates a tile with
  // no temporal-LOD tag (presence flag 0 → temporalBucketMs undefined).
  const indexBytes = encodeDirectory(
    tiles.map((t, i) => ({
      zoom: t.zoom,
      x: t.x,
      y: t.y,
      timeStart: t.timeStart,
      timeEnd: t.timeEnd,
      packId: 0,
      offset: blobOffsets[i],
      length: tileBlobs[i].byteLength,
      uncompressedSize: tileBlobs[i].byteLength,
      featureCount: 1,
      hilbert: 0,
      crc32c: 0,
      temporalBucketMs: opts.writeBucketColumn ? t.bucketMs : undefined,
    })),
  );

  const objects = new Map<string, Uint8Array>();
  const dirObject = directoryObject(indexBytes);
  objects.set('packs/p0.sttp', pack);
  objects.set('index/dir.sttd', dirObject);
  const manifest = {
    format: 'stt-packed',
    formatVersion: 2,
    compression: 'none', // 1-byte raw dummy blobs (no zstd)
    directory: {
      key: 'index/dir.sttd',
      length: dirObject.byteLength,
      directoryVersion: 5,
    },
    packs: [{ key: 'packs/p0.sttp', length: pack.byteLength }],
    metadata: opts.metadata,
  };
  objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );

  // Unique manifest URL per dataset so concurrent tests don't share a base.
  return { objects, manifestUrl: `mem://lod-${synthSeq++}/manifest.json` };
}

/** Serve a synthetic packed dataset (the `bytes` variable IS the dataset). */
function rangeFetch(ds: InMemoryPackedDataset): typeof fetch {
  return packedFetch(ds);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

describe('temporal LOD: metadata round-trip', () => {
  it('decodes temporal_lod from archive metadata JSON', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
      ],
      metadata: {
        name: 'lod',
        bounds: { min_lon: -1, min_lat: -1, max_lon: 1, max_lat: 1 },
        time_range: { start: 0, end: DAY },
        temporal_bucket_ms: HOUR,
        temporal_lod: [
          { bucket_ms: DAY, max_zoom_level: 8 },
          { bucket_ms: MONTH, max_zoom_level: 4 },
        ],
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const meta = await archive.getMetadata();
    expect(meta.temporalLod).toEqual([
      { bucketMs: DAY, maxZoomLevel: 8 },
      { bucketMs: MONTH, maxZoomLevel: 4 },
    ]);
  });

  it('leaves temporalLod undefined for legacy archives', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [{ zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR }],
      metadata: {
        name: 'legacy',
        bounds: { min_lon: -1, min_lat: -1, max_lon: 1, max_lat: 1 },
        time_range: { start: 0, end: HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: false,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const meta = await archive.getMetadata();
    expect(meta.temporalLod).toBeUndefined();
  });
});

describe('temporal LOD: index column round-trip', () => {
  it('decodes the per-tile temporal_bucket_ms column when present', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: DAY, bucketMs: DAY },
      ],
      metadata: {
        name: 'two-tiers',
        bounds: { min_lon: -1, min_lat: -1, max_lon: 1, max_lat: 1 },
        time_range: { start: 0, end: DAY },
        temporal_bucket_ms: HOUR,
        temporal_lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const index = await archive.getIndex();
    expect(index.tiles.map((t) => t.temporalBucketMs)).toEqual([HOUR, DAY]);
  });

  it('reads legacy archives (no column) with temporalBucketMs undefined', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [{ zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR }],
      metadata: {
        name: 'legacy',
        bounds: { min_lon: -1, min_lat: -1, max_lon: 1, max_lat: 1 },
        time_range: { start: 0, end: HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: false,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const index = await archive.getIndex();
    expect(index.tiles[0].temporalBucketMs).toBeUndefined();
  });
});

describe('temporal LOD: getTileIdsInBoundsForTemporalLod', () => {
  it('returns only the tiles tagged with the requested bucket size', async () => {
    // Two zoom-5 tiles at (0,0): one base-bucket (hour), one LOD (day).
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: HOUR,
          timeEnd: 2 * HOUR,
          bucketMs: HOUR,
        },
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: DAY, bucketMs: DAY },
      ],
      metadata: {
        name: 'lod',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: DAY },
        temporal_bucket_ms: HOUR,
        temporal_lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const range = { start: 0, end: DAY };

    // Returned ids are stamped with the requested tier's bucketMs so every
    // downstream key stays distinct from the base tile sharing a z/x/y/t.
    const baseIds = await archive.getTileIdsInBoundsForTemporalLod(
      bounds,
      5,
      range,
      HOUR,
    );
    expect(baseIds).toEqual([
      { z: 5, x: 0, y: 0, t: 0, bucketMs: HOUR },
      { z: 5, x: 0, y: 0, t: HOUR, bucketMs: HOUR },
    ]);

    const lodIds = await archive.getTileIdsInBoundsForTemporalLod(
      bounds,
      5,
      range,
      DAY,
    );
    expect(lodIds).toEqual([{ z: 5, x: 0, y: 0, t: 0, bucketMs: DAY }]);
  });

  it('returns an empty list for a bucket size the archive does not carry', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
      ],
      metadata: {
        name: 'plain',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: DAY },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const ids = await archive.getTileIdsInBoundsForTemporalLod(
      bounds,
      5,
      { start: 0, end: DAY },
      DAY,
    );
    expect(ids).toEqual([]);
  });

  it('legacy tiles (column unset) match a request for the archive base bucket', async () => {
    // A legacy v3 archive (no LOD column at all) must still answer the
    // base-bucket query — readers that use the LOD dispatch API need a
    // consistent contract whether the archive carries the column or not.
    const bytes = buildSyntheticArchive({
      tiles: [{ zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR }],
      metadata: {
        name: 'legacy',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: false,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const ids = await archive.getTileIdsInBoundsForTemporalLod(
      bounds,
      5,
      { start: 0, end: HOUR },
      HOUR,
    );
    expect(ids).toEqual([{ z: 5, x: 0, y: 0, t: 0, bucketMs: HOUR }]);
    // And a non-matching bucket gets nothing back.
    const noneIds = await archive.getTileIdsInBoundsForTemporalLod(
      bounds,
      5,
      { start: 0, end: HOUR },
      DAY,
    );
    expect(noneIds).toEqual([]);
  });
});

describe('temporal LOD: tier-qualified directory resolution (aliasing regression)', () => {
  // Base HOUR tile and DAY LOD tile share z/x/y/timeStart — before the
  // tier-qualified keys, tileEntryByKey was last-write-wins and BOTH ids
  // resolved to whichever entry merged last.
  function aliasedArchive(): STTArchive {
    const bytes = buildSyntheticArchive({
      tiles: [
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: 0,
          timeEnd: HOUR,
          bucketMs: HOUR,
          blobSize: 1,
        },
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: 0,
          timeEnd: DAY,
          bucketMs: DAY,
          blobSize: 2,
        },
      ],
      metadata: {
        name: 'aliased',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: DAY },
        temporal_bucket_ms: HOUR,
        temporal_lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
      },
      writeBucketColumn: true,
    });
    return new STTArchive({ url: bytes.manifestUrl, fetch: rangeFetch(bytes) });
  }

  it('a plain id resolves the BASE entry; a bucketMs id resolves ITS LOD entry', async () => {
    const archive = aliasedArchive();
    await archive.getIndex();
    // Directory byte size is a pure findTileEntry read — 1 byte base blob,
    // 2 byte LOD blob.
    expect(archive.getTileByteSize({ z: 5, x: 0, y: 0, t: 0 })).toBe(1);
    expect(
      archive.getTileByteSize({ z: 5, x: 0, y: 0, t: 0, bucketMs: DAY }),
    ).toBe(2);
    expect(
      archive.getTileByteSize({ z: 5, x: 0, y: 0, t: 0, bucketMs: HOUR }),
    ).toBe(1);
  });

  it('the interval-scan fallback stays tier-filtered (a base point query mid-span cannot land on the DAY tile)', async () => {
    const archive = aliasedArchive();
    await archive.getIndex();
    // t = 2 h: no base bucket starts there and the only interval covering it
    // is the DAY LOD tile — a base-tier lookup must NOT resolve to it.
    expect(
      archive.getTileByteSize({ z: 5, x: 0, y: 0, t: 2 * HOUR }),
    ).toBeUndefined();
    // The same instant addressed AT the LOD tier finds the DAY tile.
    expect(
      archive.getTileByteSize({ z: 5, x: 0, y: 0, t: 2 * HOUR, bucketMs: DAY }),
    ).toBe(2);
  });
});

describe('temporal LOD: pickTemporalLodForZoom', () => {
  it('picks the coarsest level that still applies at the given zoom', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 0, x: 0, y: 0, timeStart: 0, timeEnd: MONTH, bucketMs: MONTH },
      ],
      metadata: {
        name: 'lod',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: MONTH },
        temporal_bucket_ms: HOUR,
        temporal_lod: [
          { bucket_ms: DAY, max_zoom_level: 8 },
          { bucket_ms: MONTH, max_zoom_level: 4 },
        ],
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    // Very zoomed out: both levels apply, pick the coarser (month).
    expect(await archive.pickTemporalLodForZoom(0)).toEqual({
      bucketMs: MONTH,
      maxZoomLevel: 4,
    });
    // Mid zoom: only the day level applies.
    expect(await archive.pickTemporalLodForZoom(6)).toEqual({
      bucketMs: DAY,
      maxZoomLevel: 8,
    });
    // High zoom: no LOD — caller falls back to base.
    expect(await archive.pickTemporalLodForZoom(12)).toBeUndefined();
  });

  it('returns undefined for an archive without a pyramid', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
      ],
      metadata: {
        name: 'plain',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    expect(await archive.pickTemporalLodForZoom(0)).toBeUndefined();
  });
});

describe('temporal LOD: getTileIdsInBounds excludes LOD tiers by default', () => {
  it('returns only base-bucket tiles when an LOD pyramid is declared', async () => {
    // A renderer that hasn't opted into the LOD API must keep getting only
    // base-bucket tiles even on archives that ship coarser tiers.
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: DAY, bucketMs: DAY },
      ],
      metadata: {
        name: 'lod',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: DAY },
        temporal_bucket_ms: HOUR,
        temporal_lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const ids = await archive.getTileIdsInBounds(bounds, 5, {
      start: 0,
      end: DAY,
    });
    // Only the base-bucket tile shows up.
    expect(ids).toEqual([{ z: 5, x: 0, y: 0, t: 0 }]);
  });

  it('returns every overlapping tile when no LOD pyramid is declared', async () => {
    // Without LOD, the existing range-scan behaviour is preserved exactly.
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: HOUR,
          timeEnd: 2 * HOUR,
          bucketMs: HOUR,
        },
      ],
      metadata: {
        name: 'plain',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: 2 * HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({
      url: bytes.manifestUrl,
      fetch: rangeFetch(bytes),
    });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const ids = await archive.getTileIdsInBounds(bounds, 5, {
      start: 0,
      end: 2 * HOUR,
    });
    expect(ids.length).toBe(2);
  });
});
