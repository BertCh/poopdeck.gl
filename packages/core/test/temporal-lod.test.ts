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
import { encodeDirectory } from '../src/directory';

// ---------------------------------------------------------------------------
// Helpers: build a minimal v3 archive in memory
// ---------------------------------------------------------------------------

const HEADER_SIZE = 64;

interface SynthTile {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  bucketMs?: number; // when set, the synth index emits the column
}

function buildSyntheticArchive(opts: {
  tiles: SynthTile[];
  metadata: any;
  /**
   * When false, the directory schema OMITS the `temporal_bucket_ms` column
   * entirely — simulates an archive built before the LOD scaffold.
   */
  writeBucketColumn: boolean;
}): Uint8Array {
  const tiles = opts.tiles;
  // Dummy tile blobs — the reader path under test only walks the directory.
  // Each tile has a 1-byte payload so offsets stay distinct.
  const tileBlobs: Uint8Array[] = tiles.map((_, i) => new Uint8Array([i & 0xff]));

  let cursor = HEADER_SIZE;
  const blobOffsets: number[] = [];
  for (let i = 0; i < tileBlobs.length; i++) {
    blobOffsets.push(cursor);
    cursor += tileBlobs[i].byteLength;
  }
  const indexOffset = cursor;

  // Build the v4 directory. `writeBucketColumn === false` simulates a tile
  // with no temporal-LOD tag (presence flag 0 → temporalBucketMs undefined).
  const indexBytes = encodeDirectory(
    tiles.map((t, i) => ({
      zoom: t.zoom,
      x: t.x,
      y: t.y,
      timeStart: t.timeStart,
      timeEnd: t.timeEnd,
      offset: blobOffsets[i],
      length: tileBlobs[i].byteLength,
      uncompressedSize: tileBlobs[i].byteLength,
      featureCount: 1,
      hilbert: 0,
      crc32c: 0,
      temporalBucketMs: opts.writeBucketColumn ? t.bucketMs : undefined,
    })),
  );
  // Tail: metadata JSON.
  const metadataOffset = indexOffset + indexBytes.byteLength;
  const metadataBytes = new TextEncoder().encode(JSON.stringify(opts.metadata));

  const total = new Uint8Array(metadataOffset + metadataBytes.byteLength);
  // 64-byte header.
  const headerView = new DataView(total.buffer, 0, HEADER_SIZE);
  total[0] = 0x53; // 'S'
  total[1] = 0x54;
  total[2] = 0x54;
  total[3] = 4; // version
  headerView.setUint8(4, 4); // version
  headerView.setUint8(5, 0); // Compression.None
  headerView.setBigUint64(6, BigInt(indexOffset), true);
  headerView.setBigUint64(14, BigInt(indexBytes.byteLength), true);
  headerView.setBigUint64(22, BigInt(metadataOffset), true);
  headerView.setBigUint64(30, BigInt(metadataBytes.byteLength), true);
  headerView.setBigUint64(38, 0n, true);
  headerView.setBigUint64(46, 0n, true);
  // Tile blobs.
  for (let i = 0; i < tileBlobs.length; i++) {
    total.set(tileBlobs[i], blobOffsets[i]);
  }
  total.set(indexBytes, indexOffset);
  total.set(metadataBytes, metadataOffset);
  return total;
}

function rangeFetch(bytes: Uint8Array): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bytes.buffer.slice(0),
      };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      arrayBuffer: async () =>
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    };
  }) as unknown as typeof fetch;
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
    const archive = new STTArchive({ url: 'mem://lod', fetch: rangeFetch(bytes) });
    const meta = await archive.getMetadata();
    expect(meta.temporalLod).toEqual([
      { bucketMs: DAY, maxZoomLevel: 8 },
      { bucketMs: MONTH, maxZoomLevel: 4 },
    ]);
  });

  it('leaves temporalLod undefined for legacy archives', async () => {
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR },
      ],
      metadata: {
        name: 'legacy',
        bounds: { min_lon: -1, min_lat: -1, max_lon: 1, max_lat: 1 },
        time_range: { start: 0, end: HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: false,
    });
    const archive = new STTArchive({ url: 'mem://legacy', fetch: rangeFetch(bytes) });
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
    const archive = new STTArchive({ url: 'mem://lod', fetch: rangeFetch(bytes) });
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
    const archive = new STTArchive({ url: 'mem://legacy', fetch: rangeFetch(bytes) });
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
        { zoom: 5, x: 0, y: 0, timeStart: HOUR, timeEnd: 2 * HOUR, bucketMs: HOUR },
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
    const archive = new STTArchive({ url: 'mem://lod', fetch: rangeFetch(bytes) });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const range = { start: 0, end: DAY };

    const baseIds = await archive.getTileIdsInBoundsForTemporalLod(bounds, 5, range, HOUR);
    expect(baseIds).toEqual([
      { z: 5, x: 0, y: 0, t: 0 },
      { z: 5, x: 0, y: 0, t: HOUR },
    ]);

    const lodIds = await archive.getTileIdsInBoundsForTemporalLod(bounds, 5, range, DAY);
    expect(lodIds).toEqual([{ z: 5, x: 0, y: 0, t: 0 }]);
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
    const archive = new STTArchive({ url: 'mem://plain', fetch: rangeFetch(bytes) });
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
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR },
      ],
      metadata: {
        name: 'legacy',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: false,
    });
    const archive = new STTArchive({ url: 'mem://legacy', fetch: rangeFetch(bytes) });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const ids = await archive.getTileIdsInBoundsForTemporalLod(
      bounds,
      5,
      { start: 0, end: HOUR },
      HOUR,
    );
    expect(ids).toEqual([{ z: 5, x: 0, y: 0, t: 0 }]);
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
    const archive = new STTArchive({ url: 'mem://lod', fetch: rangeFetch(bytes) });
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
    const archive = new STTArchive({ url: 'mem://plain', fetch: rangeFetch(bytes) });
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
    const archive = new STTArchive({ url: 'mem://lod', fetch: rangeFetch(bytes) });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const ids = await archive.getTileIdsInBounds(bounds, 5, { start: 0, end: DAY });
    // Only the base-bucket tile shows up.
    expect(ids).toEqual([{ z: 5, x: 0, y: 0, t: 0 }]);
  });

  it('returns every overlapping tile when no LOD pyramid is declared', async () => {
    // Without LOD, the existing range-scan behaviour is preserved exactly.
    const bytes = buildSyntheticArchive({
      tiles: [
        { zoom: 5, x: 0, y: 0, timeStart: 0, timeEnd: HOUR, bucketMs: HOUR },
        { zoom: 5, x: 0, y: 0, timeStart: HOUR, timeEnd: 2 * HOUR, bucketMs: HOUR },
      ],
      metadata: {
        name: 'plain',
        bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
        time_range: { start: 0, end: 2 * HOUR },
        temporal_bucket_ms: HOUR,
      },
      writeBucketColumn: true,
    });
    const archive = new STTArchive({ url: 'mem://plain', fetch: rangeFetch(bytes) });
    const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const ids = await archive.getTileIdsInBounds(bounds, 5, { start: 0, end: 2 * HOUR });
    expect(ids.length).toBe(2);
  });
});
