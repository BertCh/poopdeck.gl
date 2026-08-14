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

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  addressableTemporalTiers,
  requestPriceBytes,
  STTArchive,
  temporalTierArgmin,
} from '../src/archive';
import {
  directoryKey,
  directoryObject,
  packKey,
  packObject,
  OBJECT_MAGIC_LEN,
} from './helpers/packed-fixture';
import {
  decodePagedRoot,
  encodeDirectory,
  type PageDescriptor,
} from '../src/directory';
import { blake3Hex128 } from '../src/blake3';
import type { BoundingBox, SelectionCost, TimeRange } from '../src/types';
import {
  packedFetch,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';

// ---------------------------------------------------------------------------
// Helpers: build a minimal PACKED archive in memory
//
// The reader consumes the packed format (manifest + index + packs). These
// LOD-dispatch tests only walk the directory, so a single pack of 1-byte dummy
// blobs is enough; the v6 directory carries the temporal_bucket_ms column.
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

  // Build the v6 directory. `writeBucketColumn === false` simulates a tile with
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
    formatVersion: 3,
    variants: [{ id: 0, kind: 'raw' }],
    compression: 'none', // 1-byte raw dummy blobs (no zstd)
    directory: {
      key: 'index/dir.sttd',
      length: dirObject.byteLength,
      directoryVersion: 6,
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
      { z: 5, x: 0, y: 0, t: 0, variantId: 0, bucketMs: HOUR },
      { z: 5, x: 0, y: 0, t: HOUR, variantId: 0, bucketMs: HOUR },
    ]);

    const lodIds = await archive.getTileIdsInBoundsForTemporalLod(
      bounds,
      5,
      range,
      DAY,
    );
    expect(lodIds).toEqual([
      { z: 5, x: 0, y: 0, t: 0, variantId: 0, bucketMs: DAY },
    ]);
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
    expect(ids).toEqual([
      { z: 5, x: 0, y: 0, t: 0, variantId: 0, bucketMs: HOUR },
    ]);
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
    expect(ids).toEqual([{ z: 5, x: 0, y: 0, t: 0, variantId: 0 }]);
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

// ===========================================================================
// CO-5 — the temporal-tier pick as a 1-D argmin over the addressable set.
//
// Losslessness makes every addressable tier a CORRECT answer, so the choice
// between them is pure cost — and the reader knows both terms of that cost
// exactly (CO-1 prices the bytes off the directory; CO-7 prices the request).
// What these pin is that the argmin (a) beats the zoom threshold where the
// threshold is window-blind, (b) is deterministic to the coarser tier on a
// tie, and (c) ABSTAINS rather than guessing whenever a tier cannot be priced.
// ===========================================================================

const MINUTE = 60_000;
const WORLD: BoundingBox = {
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
};

/**
 * `DEFAULT_RANGE_COALESCE_GAP`, spelled out. NOT a request price — it is the
 * constant `effectiveCoalesceGap()` falls back to on a cold / pinned / gated
 * session, and the thing the objective must never be fed. Asserted against by
 * name below so a regression that reintroduces it fails loudly.
 */
const COALESCE_GAP_CONSTANT = 2 * 1024 * 1024;

/**
 * Replace `performance.now()` with a counter that advances `stepMs` on every
 * read, so `L̂` and `θ̂` are functions of the scripted call sequence and not of
 * the host's timer resolution.
 *
 * The tests below never hard-code the resulting price: they warm the archive,
 * READ `L̂` and `θ̂` back off it, and multiply. That is deliberate — a pin that
 * asserted a named constant would pass for any value of that constant, which
 * is exactly how a 2 MiB request price survived review once already.
 */
function scriptClock(stepMs = 1000): void {
  let at = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    const now = at;
    at += stepMs;
    return now;
  });
}

/**
 * Run one real batch so BOTH estimators have a sample. The dummy blobs do not
 * decode — irrelevant here, because the throughput sample is taken from the
 * completed transfer, before any decode is attempted.
 */
async function warm(
  archive: STTArchive,
  bounds: BoundingBox,
  zoom: number,
  timeRange: TimeRange,
): Promise<void> {
  const ids = await archive.getTileIdsInBounds(bounds, zoom, timeRange);
  expect(ids.length).toBeGreaterThan(0);
  await archive.getTiles(ids).catch(() => undefined);
  expect(archive.getLatencyEstimateMs()).not.toBeNull();
  expect(archive.getThroughputEstimate().bytesPerMs).not.toBeNull();
}

/** `L̂ × θ̂` as the archive itself measured it. Fails loudly if still cold. */
function measuredRequestPrice(archive: STTArchive): number {
  const price = archive.getRequestPriceBytes();
  expect(price).not.toBeNull();
  expect(price).toBe(
    archive.getLatencyEstimateMs()! *
      archive.getThroughputEstimate().bytesPerMs!,
  );
  return price!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Base-tier hourly tiles at `zoom`/(0,0), `count` of them, `bytes` each. */
function hourlyBaseTiles(count: number, bytes: number, zoom = 5): SynthTile[] {
  return Array.from({ length: count }, (_, i) => ({
    zoom,
    x: 0,
    y: 0,
    timeStart: i * HOUR,
    timeEnd: (i + 1) * HOUR - 1,
    bucketMs: HOUR,
    blobSize: bytes,
  }));
}

function costArchive(opts: {
  tiles: SynthTile[];
  lod: Array<{ bucket_ms: number; max_zoom_level: number }>;
}): STTArchive {
  const ds = buildSyntheticArchive({
    tiles: opts.tiles,
    metadata: {
      name: 'cost',
      bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
      time_range: { start: 0, end: MONTH },
      temporal_bucket_ms: HOUR,
      temporal_lod: opts.lod,
    },
    writeBucketColumn: true,
  });
  return new STTArchive({ url: ds.manifestUrl, fetch: rangeFetch(ds) });
}

/**
 * A day's worth of hourly base tiles alongside ONE daily LOD tile holding the
 * same features. The base tier is cheaper for a 10-minute window (one small
 * tile vs one 24× bigger one) and dearer for a whole-day window (24 tiles and
 * 24 requests vs one) — the two halves of §7.5's gap in one archive.
 */
function dayPyramid(): STTArchive {
  return costArchive({
    tiles: [
      ...hourlyBaseTiles(24, 1000),
      {
        zoom: 5,
        x: 0,
        y: 0,
        timeStart: 0,
        timeEnd: DAY - 1,
        bucketMs: DAY,
        blobSize: 24_000,
      },
    ],
    lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
  });
}

describe('CO-5: pickTemporalLodByCost — the addressable set', () => {
  it('is {base} ∪ {levels whose cutoff covers the zoom}, coarsest first', () => {
    const levels = [
      { bucketMs: DAY, maxZoomLevel: 8 },
      { bucketMs: MONTH, maxZoomLevel: 4 },
    ];
    expect(addressableTemporalTiers(levels, HOUR, 0)).toEqual([
      MONTH,
      DAY,
      HOUR,
    ]);
    // Just above MONTH's cutoff: that level drops out of the set entirely.
    expect(addressableTemporalTiers(levels, HOUR, 5)).toEqual([DAY, HOUR]);
    // Above every cutoff only the base tier is addressable — the item prices
    // EXISTING tiers and never invents one (§11.6 / G5 stays M8's).
    expect(addressableTemporalTiers(levels, HOUR, 12)).toEqual([HOUR]);
    expect(addressableTemporalTiers(undefined, HOUR, 3)).toEqual([HOUR]);
  });

  it('always contains the zoom-threshold pick (why the property below holds)', async () => {
    const archive = costArchive({
      tiles: hourlyBaseTiles(1, 10),
      lod: [
        { bucket_ms: DAY, max_zoom_level: 8 },
        { bucket_ms: MONTH, max_zoom_level: 4 },
      ],
    });
    for (const zoom of [0, 4, 5, 8, 9, 12]) {
      const threshold = await archive.pickTemporalLodForZoom(zoom);
      const set = addressableTemporalTiers(
        (await archive.getMetadata()).temporalLod,
        HOUR,
        zoom,
      );
      expect(set).toContain(threshold?.bucketMs ?? HOUR);
    }
  });
});

describe('CO-5: pickTemporalLodByCost — the two §7.5 gap cases', () => {
  it('OVER-FETCH: a window far narrower than the coarse bucket picks the BASE tier', async () => {
    scriptClock();
    const archive = dayPyramid();
    const narrow: TimeRange = { start: 0, end: 10 * MINUTE };
    await warm(archive, WORLD, 5, { start: 0, end: DAY });
    const price = measuredRequestPrice(archive);

    // The incumbent is window-blind: z5 is inside the DAY level's cutoff, so
    // it snaps to DAY and buys 24 000 bytes to show ten minutes.
    expect(await archive.pickTemporalLodForZoom(5)).toEqual({
      bucketMs: DAY,
      maxZoomLevel: 8,
    });

    const pick = await archive.pickTemporalLodByCost(WORLD, 5, narrow);
    expect(pick).toBeDefined();
    expect(pick!.bucketMs).toBe(HOUR); // the base tier, not the coarse one
    expect(pick!.policy).toBe('cost-argmin');
    expect(pick!.exact).toBe(true);
    // One hourly tile, priced exactly, plus one request at the MEASURED rate.
    expect(pick!.tiles).toBe(1);
    expect(pick!.bytes).toBe(1000);
    expect(pick!.requestOverheadBytes).toBe(price);
    expect(pick!.cost).toBe(1000 + price);
    // And it is genuinely cheaper than what the threshold would have bought.
    const coarse = archive.estimateSelectionCost(WORLD, 5, narrow, {
      bucketMs: DAY,
    });
    expect(coarse.bytes).toBe(24_000);
    expect(pick!.cost).toBeLessThan(coarse.bytes + coarse.tiles * price);
  });

  it('UNDER-AGGREGATION: a wide window picks the coarse tier over 24 base requests', async () => {
    scriptClock();
    const archive = dayPyramid();
    const wide: TimeRange = { start: 0, end: DAY - 1 };
    await warm(archive, WORLD, 5, wide);
    const price = measuredRequestPrice(archive);

    const pick = await archive.pickTemporalLodByCost(WORLD, 5, wide);
    expect(pick!.bucketMs).toBe(DAY);
    expect(pick!.policy).toBe('cost-argmin');
    expect(pick!.tiles).toBe(1);
    expect(pick!.bytes).toBe(24_000);

    // The base tier moves the SAME bytes but in 24 separately-addressed
    // tiles — which is exactly what the request term prices. Note the coarse
    // tier wins here on EQUAL bytes: the request term breaks the tie, it does
    // not overrule a byte term 125× worse (see the domination pin below).
    const base = archive.estimateSelectionCost(WORLD, 5, wide, {
      bucketMs: HOUR,
    });
    expect(base.tiles).toBe(24);
    expect(base.bytes).toBe(24_000);
    expect(pick!.cost).toBeLessThan(base.bytes + base.tiles * price);
  });

  it('picks a MIDDLE tier when it is the cheapest — not merely the coarsest', async () => {
    scriptClock();
    // Three tiers addressable at z4. The month tile is one request but a fat
    // one; the hourly tier is small tiles but 24 requests; the day tier wins.
    const archive = costArchive({
      tiles: [
        ...hourlyBaseTiles(24, 100),
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: 0,
          timeEnd: DAY - 1,
          bucketMs: DAY,
          blobSize: 3000,
        },
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: 0,
          timeEnd: MONTH - 1,
          bucketMs: MONTH,
          blobSize: 90_000,
        },
      ],
      lod: [
        { bucket_ms: DAY, max_zoom_level: 8 },
        { bucket_ms: MONTH, max_zoom_level: 5 },
      ],
    });
    const wide: TimeRange = { start: 0, end: DAY - 1 };
    await warm(archive, WORLD, 5, wide);
    const price = measuredRequestPrice(archive);

    // The threshold would take the coarsest applicable level (MONTH).
    expect((await archive.pickTemporalLodForZoom(5))?.bucketMs).toBe(MONTH);

    const pick = await archive.pickTemporalLodByCost(WORLD, 5, wide);
    expect(pick!.bucketMs).toBe(DAY);
    expect(pick!.cost).toBe(3000 + price);
  });
});

describe('CO-5: pickTemporalLodByCost — determinism & the measured exchange rate', () => {
  it('breaks ties toward the COARSER tier, independent of pricing order', () => {
    const equal = (
      bucketMs: number,
    ): { bucketMs: number; selection: SelectionCost } => ({
      bucketMs,
      selection: { bytes: 5000, tiles: 1, unknownTiles: 0 },
    });
    const ascending = temporalTierArgmin(
      [equal(HOUR), equal(DAY), equal(MONTH)],
      40_000,
    );
    const descending = temporalTierArgmin(
      [equal(MONTH), equal(DAY), equal(HOUR)],
      40_000,
    );
    expect(ascending.pick!.bucketMs).toBe(MONTH);
    expect(descending.pick!.bucketMs).toBe(MONTH);
    // Candidates are always reported coarsest-first, whatever came in.
    expect(ascending.candidates.map((c) => c.bucketMs)).toEqual([
      MONTH,
      DAY,
      HOUR,
    ]);
  });

  it('ties on a real archive resolve to the coarse tier', async () => {
    scriptClock();
    const archive = costArchive({
      tiles: [
        ...hourlyBaseTiles(1, 5000),
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: 0,
          timeEnd: DAY - 1,
          bucketMs: DAY,
          blobSize: 5000,
        },
      ],
      lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
    });
    await warm(archive, WORLD, 5, { start: 0, end: DAY });
    const price = measuredRequestPrice(archive);
    const pick = await archive.pickTemporalLodByCost(WORLD, 5, {
      start: 0,
      end: 10 * MINUTE,
    });
    expect(pick!.bucketMs).toBe(DAY);
    expect(pick!.cost).toBe(5000 + price);
  });

  it('is deterministic: identical archive + query ⇒ identical pick across re-runs', async () => {
    scriptClock();
    const range: TimeRange = { start: 0, end: 6 * HOUR };
    const a = dayPyramid();
    await warm(a, WORLD, 5, range);
    const first = await a.pickTemporalLodByCost(WORLD, 5, range);
    expect(first!.policy).toBe('cost-argmin');
    const second = await a.pickTemporalLodByCost(WORLD, 5, range);
    expect(second).toEqual(first);
    // ...and across a freshly-built archive from identical inputs, warmed by
    // the identical scripted sequence.
    const b = dayPyramid();
    await warm(b, WORLD, 5, range);
    expect(await b.pickTemporalLodByCost(WORLD, 5, range)).toEqual(first);
  });

  it('returns undefined for an archive with no pyramid (zero regression)', async () => {
    const ds = buildSyntheticArchive({
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
      url: ds.manifestUrl,
      fetch: rangeFetch(ds),
    });
    expect(
      await archive.pickTemporalLodByCost(WORLD, 5, { start: 0, end: HOUR }),
    ).toBeUndefined();
  });

  it('above every cutoff the base tier is the only candidate', async () => {
    scriptClock();
    const archive = dayPyramid();
    await warm(archive, WORLD, 5, { start: 0, end: DAY });
    // A tight box over the z5/(0,0) cell — a world box at z12 would trip the
    // oversized-scan warning without changing what is being asserted.
    const tight: BoundingBox = {
      minLon: -180,
      minLat: 84,
      maxLon: -179,
      maxLat: 85,
    };
    expect(
      addressableTemporalTiers(
        (await archive.getMetadata()).temporalLod,
        HOUR,
        12,
      ),
    ).toEqual([HOUR]);
    const pick = await archive.pickTemporalLodByCost(tight, 12, {
      start: 0,
      end: DAY,
    });
    // pickTemporalLodForZoom(12) is undefined ⇒ base; the argmin agrees, and
    // does NOT reach for an out-of-cutoff tier to save bytes.
    expect(await archive.pickTemporalLodForZoom(12)).toBeUndefined();
    expect(pick!.bucketMs).toBe(HOUR);
    // This archive carries no z12 tiles at all, so the sole candidate has no
    // coverage — the argmin abstains rather than "picking" an empty tier, and
    // the incumbent's own answer (the base tier) is what rides back.
    expect(
      archive.estimateSelectionCost(tight, 12, { start: 0, end: DAY }),
    ).toMatchObject({ tiles: 0, unknownTiles: 0 });
    expect(pick!.policy).toBe('zoom-threshold');
    expect(pick!.abstainReason).toBe('no-eligible-tier');
  });
});

describe('CO-5: pickTemporalLodByCost — honesty (never guess)', () => {
  it('abstains when ANY candidate is unpriced', () => {
    const argmin = temporalTierArgmin(
      [
        { bucketMs: DAY, selection: { bytes: 10, tiles: 1, unknownTiles: 0 } },
        // Cheaper on the numbers the reader can see — and exactly the trap:
        // a lower bound is not a price.
        { bucketMs: HOUR, selection: { bytes: 1, tiles: 1, unknownTiles: 4 } },
      ],
      0,
    );
    expect(argmin.exact).toBe(false);
    expect(argmin.pick).toBeNull();
  });

  it('abstains on a request price it does not have, rather than pricing at 0', () => {
    // The old behaviour degraded an unmeasured price to 0 and ranked on bytes
    // alone. That is a different objective wearing the same name: the tier
    // that fetches 9 tiles wins on bytes and loses badly on requests, and
    // which of those is right is precisely what the missing measurement was
    // going to say. No measurement ⇒ no comparison.
    const priced = [
      { bucketMs: DAY, selection: { bytes: 900, tiles: 1, unknownTiles: 0 } },
      { bucketMs: HOUR, selection: { bytes: 100, tiles: 9, unknownTiles: 0 } },
    ];
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const argmin = temporalTierArgmin(priced, bad);
      expect(argmin.pick).toBeNull();
      expect(argmin.reason).toBe('unmeasured-request-price');
      // The candidates are still reported (audit trail) and their costs are
      // bytes-only — never NaN, and never scored against a stand-in constant.
      expect(argmin.requestOverheadBytes).toBe(0);
      expect(argmin.candidates.map((c) => c.cost)).toEqual([900, 100]);
    }
    // A measured price of exactly zero IS a price and does compare.
    const free = temporalTierArgmin(priced, 0);
    expect(free.reason).toBe('none');
    expect(free.pick!.bucketMs).toBe(HOUR);
    expect(free.pick!.cost).toBe(100);
  });
});

// ===========================================================================
// Regression pins for two CO-5 review findings. Both are the same shape of
// bug: the objective was being minimized over something that is not the cost
// of showing the user a frame.
// ===========================================================================

describe('CO-5 regression: a tier with NO COVERAGE is ineligible, not free', () => {
  it('the zero-coverage tier does not win the argmin (the reviewer probe)', () => {
    // The exact candidate set the review probed. The HOUR tier holds nothing
    // for this (bbox, zoom, window): 0 bytes in 0 tiles. It therefore costs 0,
    // it sorts FIRST (coarsest), and on a strict `<` no other tier can ever
    // displace it. What it buys is a blank frame.
    const argmin = temporalTierArgmin(
      [
        { bucketMs: HOUR, selection: { bytes: 0, tiles: 0, unknownTiles: 0 } },
        {
          bucketMs: MINUTE,
          selection: { bytes: 500_000, tiles: 5, unknownTiles: 0 },
        },
      ],
      COALESCE_GAP_CONSTANT,
    );
    // The trap is armed: the empty tier really does price at zero and really
    // is the first candidate considered.
    expect(argmin.candidates[0]).toMatchObject({
      bucketMs: HOUR,
      cost: 0,
      eligible: false,
    });
    // …and it loses anyway, to the only tier that holds the data.
    expect(argmin.reason).toBe('none');
    expect(argmin.pick!.bucketMs).toBe(MINUTE);
    expect(argmin.pick!.eligible).toBe(true);
    expect(argmin.pick!.cost).toBe(10_985_760); // 500 000 + 5 × 2 MiB
  });

  it('abstains when NO addressable tier has coverage', () => {
    const argmin = temporalTierArgmin(
      [
        { bucketMs: DAY, selection: { bytes: 0, tiles: 0, unknownTiles: 0 } },
        { bucketMs: HOUR, selection: { bytes: 0, tiles: 0, unknownTiles: 0 } },
      ],
      40_000,
    );
    expect(argmin.pick).toBeNull();
    expect(argmin.reason).toBe('no-eligible-tier');
    // Empty input is the same answer, not a crash.
    expect(temporalTierArgmin([], 40_000)).toMatchObject({
      pick: null,
      reason: 'no-eligible-tier',
    });
  });

  it('a DECLARED-but-empty tier cannot win on a real archive either', async () => {
    scriptClock();
    // The pyramid declares a DAY level; the archive carries no DAY tile at
    // all. That is not exotic — a level whose cutoff covers this zoom but
    // whose tiles were only emitted elsewhere in space or time looks exactly
    // like this from the directory.
    const archive = costArchive({
      tiles: hourlyBaseTiles(4, 1000),
      lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
    });
    const range: TimeRange = { start: 0, end: 4 * HOUR - 1 };
    await warm(archive, WORLD, 5, range);
    const price = measuredRequestPrice(archive);

    // The trap, as the reader sees it: the DAY tier prices at nothing…
    const coarse = archive.estimateSelectionCost(WORLD, 5, range, {
      bucketMs: DAY,
    });
    expect(coarse).toMatchObject({ bytes: 0, tiles: 0, unknownTiles: 0 });
    // …and buying it would render nothing.
    expect(
      await archive.getTileIdsInBoundsForTemporalLod(WORLD, 5, range, DAY),
    ).toEqual([]);

    const pick = await archive.pickTemporalLodByCost(WORLD, 5, range);
    expect(pick!.bucketMs).toBe(HOUR);
    expect(pick!.policy).toBe('cost-argmin');
    expect(pick!.tiles).toBe(4);
    expect(pick!.bytes).toBe(4000);
    expect(pick!.cost).toBe(4000 + 4 * price);
    // The tier that won actually addresses something.
    expect((await archive.getTileIdsInBounds(WORLD, 5, range)).length).toBe(4);
  });
});

describe('CO-5 regression: the request term is MEASURED, never the 2 MiB gap', () => {
  it('requestPriceBytes is L̂ × θ̂, and null — not a constant — when cold', () => {
    expect(requestPriceBytes(40, 12.5)).toBe(500);
    expect(requestPriceBytes(200, 12_500)).toBe(2_500_000);
    // A measured zero is a measurement and survives as one.
    expect(requestPriceBytes(0, 12_500)).toBe(0);
    // Cold on either side ⇒ no price at all.
    expect(requestPriceBytes(null, 12_500)).toBeNull();
    expect(requestPriceBytes(40, null)).toBeNull();
    expect(requestPriceBytes(undefined, undefined)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(requestPriceBytes(bad, 12_500)).toBeNull();
      expect(requestPriceBytes(40, bad)).toBeNull();
    }
    // Deliberately NOT clamped into CO-7's fuse band, in either direction:
    // this is an exchange rate, not an over-fetch budget.
    expect(requestPriceBytes(1, 1)).toBe(1);
    expect(requestPriceBytes(1000, 50_000)).toBe(50_000_000);
  });

  it('a COLD archive abstains instead of pricing a request at 2 MiB', async () => {
    const archive = dayPyramid();
    await archive.getIndex();
    expect(archive.getRequestPriceBytes()).toBeNull();
    // The gap CO-7 fuses on IS the 2 MiB constant on this archive — and that
    // constant is precisely what must not reach the objective.
    expect(archive.effectiveCoalesceGap()).toBe(COALESCE_GAP_CONSTANT);

    const pick = await archive.pickTemporalLodByCost(WORLD, 5, {
      start: 0,
      end: 10 * MINUTE,
    });
    expect(pick!.policy).toBe('zoom-threshold');
    expect(pick!.abstainReason).toBe('unmeasured-request-price');
    expect(pick!.exact).toBe(false);
    expect(pick!.requestOverheadBytes).toBe(0);
    expect(pick!.requestOverheadBytes).not.toBe(COALESCE_GAP_CONSTANT);
    expect(pick!.requestOverheadBytes).not.toBe(archive.effectiveCoalesceGap());
    // The incumbent answered, byte-for-byte.
    expect(pick!.bucketMs).toBe(
      (await archive.pickTemporalLodForZoom(5))!.bucketMs,
    );
  });

  it('DOMINATION: a coarse tier with far worse bytes does not win on tile count', async () => {
    scriptClock();
    // One fat daily tile against 24 small hourly tiles holding the same day.
    // Bytes say the base tier by 125×; request COUNT says the coarse tier.
    const archive = costArchive({
      tiles: [
        ...hourlyBaseTiles(24, 1000),
        {
          zoom: 5,
          x: 0,
          y: 0,
          timeStart: 0,
          timeEnd: DAY - 1,
          bucketMs: DAY,
          blobSize: 3_000_000,
        },
      ],
      lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
    });
    const wide: TimeRange = { start: 0, end: DAY - 1 };
    await warm(archive, WORLD, 5, wide);

    const priced = [DAY, HOUR].map((bucketMs) => ({
      bucketMs,
      selection: archive.estimateSelectionCost(WORLD, 5, wide, { bucketMs }),
    }));
    expect(priced[0].selection).toMatchObject({ bytes: 3_000_000, tiles: 1 });
    expect(priced[1].selection).toMatchObject({ bytes: 24_000, tiles: 24 });

    // At the 2 MiB coalesce-gap constant the request term is 50.3 MB against a
    // 24 kB byte term, so the objective is decided ENTIRELY by tile count and
    // the 3 MB tier wins. That is the defect, reproduced on these exact
    // candidates so the pin cannot pass by accident.
    const atConstant = temporalTierArgmin(priced, COALESCE_GAP_CONSTANT);
    expect(atConstant.pick!.bucketMs).toBe(DAY);
    expect(atConstant.pick!.cost).toBe(3_000_000 + COALESCE_GAP_CONSTANT);

    // At this link's own measured rate the byte term is not swamped.
    const price = measuredRequestPrice(archive);
    expect(price).toBeGreaterThan(0);
    expect(price).toBeLessThan(COALESCE_GAP_CONSTANT);

    const pick = await archive.pickTemporalLodByCost(WORLD, 5, wide);
    expect(pick!.policy).toBe('cost-argmin');
    expect(pick!.requestOverheadBytes).toBe(price);
    expect(pick!.bucketMs).toBe(HOUR);
    expect(pick!.bytes).toBe(24_000);
    expect(pick!.tiles).toBe(24);
    expect(pick!.cost).toBe(24_000 + 24 * price);
    // …and it really is the cheaper buy at that rate.
    expect(pick!.cost).toBeLessThan(3_000_000 + price);
  });
});

// ---------------------------------------------------------------------------
// A two-leaf PAGED archive carrying a pyramid — the fallback guard's fixture.
// ---------------------------------------------------------------------------

/** Hand-rolled paged root page (mirrors the writer; decoder-checked below). */
function encodePagedRootBytes(
  pages: PageDescriptor[],
  pageEntries: number,
): Uint8Array {
  const HEADER = 12;
  const DESC = 52;
  const out = new Uint8Array(HEADER + pages.length * DESC);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 1); // root_version
  dv.setUint8(1, 0); // descriptor_kind = geo-bbox
  dv.setUint32(4, pages.length, true);
  dv.setUint32(8, pageEntries, true); // nominal page_entries
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

/**
 * Two leaves, each holding a base + a DAY tile for one z5 cell — one near
 * lon 0, one near lon 90. A whole-world query intersects both descriptors, so
 * a cold reader can see NEITHER and must abstain from the cost comparison.
 */
function pagedPyramidArchive(): STTArchive {
  const cells = [
    { x: 16, y: 16, minLon: 0, maxLon: 11.25 },
    { x: 24, y: 16, minLon: 90, maxLon: 101.25 },
  ];
  const blobs = cells.flatMap(() => [
    new Uint8Array(1000),
    new Uint8Array(9000),
  ]);
  const { bytes: pack, offsets } = packObject(blobs);
  const leaves = cells.map((cell, i) =>
    encodeDirectory([
      {
        zoom: 5,
        x: cell.x,
        y: cell.y,
        timeStart: 0,
        timeEnd: HOUR - 1,
        packId: 0,
        offset: offsets[i * 2],
        length: 1000,
        uncompressedSize: 1000,
        featureCount: 1,
        hilbert: 0,
        crc32c: 0,
        temporalBucketMs: HOUR,
      },
      {
        zoom: 5,
        x: cell.x,
        y: cell.y,
        timeStart: 0,
        timeEnd: DAY - 1,
        packId: 0,
        offset: offsets[i * 2 + 1],
        length: 9000,
        uncompressedSize: 9000,
        featureCount: 1,
        hilbert: 0,
        crc32c: 0,
        temporalBucketMs: DAY,
      },
    ]),
  );
  let rel = 0;
  const pages: PageDescriptor[] = cells.map((cell, i) => {
    const desc: PageDescriptor = {
      relOffset: rel,
      length: leaves[i].length,
      entryCount: 2,
      minZoom: 5,
      maxZoom: 5,
      minLon: cell.minLon,
      minLat: -11.2,
      maxLon: cell.maxLon,
      maxLat: 0,
      tMin: 0,
      tMax: DAY - 1,
    };
    rel += leaves[i].length;
    return desc;
  });
  const root = encodePagedRootBytes(pages, 2);
  expect(decodePagedRoot(root).pages).toEqual(pages);

  const sttd = new Uint8Array(
    root.length + leaves.reduce((n, l) => n + l.length, 0),
  );
  sttd.set(root, 0);
  let at = root.length;
  for (const leaf of leaves) {
    sttd.set(leaf, at);
    at += leaf.length;
  }
  const sttdObject = directoryObject(sttd);
  const dirKey = directoryKey(sttdObject);
  const pKey = packKey(pack);
  const objects = new Map<string, Uint8Array>();
  objects.set(dirKey, sttdObject);
  objects.set(pKey, pack);
  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        format: 'stt-packed',
        formatVersion: 3,
        variants: [{ id: 0, kind: 'raw' }],
        compression: 'none',
        directory: {
          key: dirKey,
          length: sttdObject.length,
          directoryVersion: 6,
          layout: 'paged',
          rootLength: root.length,
          pageCount: leaves.length,
          pageEntries: 2,
          rootHash: blake3Hex128(root),
          pageHashes: leaves.map((l) => blake3Hex128(l)),
        },
        packs: [{ key: pKey, length: pack.length }],
        metadata: {
          name: 'paged-lod',
          bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
          time_range: { start: 0, end: DAY },
          temporal_bucket_ms: HOUR,
          temporal_lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
        },
      }),
    ),
  );
  const ds: InMemoryPackedDataset = {
    objects,
    manifestUrl: `mem://paged-lod-${synthSeq++}/manifest.json`,
  };
  expect(OBJECT_MAGIC_LEN).toBe(8); // the layout the offsets above assume
  return new STTArchive({
    url: ds.manifestUrl,
    fetch: packedFetch(ds),
    directoryPageThresholdBytes: 0, // force real paging
  });
}

describe('CO-5: pickTemporalLodByCost — the non-resident-leaf fallback guard', () => {
  const WIDE: BoundingBox = {
    minLon: -5,
    minLat: -20,
    maxLon: 110,
    maxLat: 10,
  };
  const RANGE: TimeRange = { start: 0, end: DAY - 1 };

  it('falls back to pickTemporalLodForZoom while leaves are unfetched', async () => {
    const archive = pagedPyramidArchive();
    // Root page only: every intersecting leaf is blind, so the comparison
    // would be between lower bounds. It refuses to make it.
    expect(
      archive.estimateSelectionCost(WIDE, 5, RANGE, { bucketMs: HOUR })
        .unknownTiles,
    ).toBeGreaterThan(0);

    const pick = await archive.pickTemporalLodByCost(WIDE, 5, RANGE);
    const threshold = await archive.pickTemporalLodForZoom(5);
    expect(pick!.policy).toBe('zoom-threshold');
    expect(pick!.exact).toBe(false);
    expect(pick!.abstainReason).toBe('unpriced-tiles');
    expect(pick!.bucketMs).toBe(threshold!.bucketMs);
  });

  it('and switches to the measured pick once those leaves are resident', async () => {
    scriptClock();
    const archive = pagedPyramidArchive();
    expect((await archive.pickTemporalLodByCost(WIDE, 5, RANGE))!.policy).toBe(
      'zoom-threshold',
    );

    // The ordinary selection query pages the leaves in as a side effect; the
    // pick does not fault them itself. The same pass also warms the two
    // estimators the request term is read from.
    const ids = await archive.getTileIdsInBounds(WIDE, 5, RANGE);
    await archive.getTiles(ids).catch(() => undefined);
    const price = measuredRequestPrice(archive);

    const settled = await archive.pickTemporalLodByCost(WIDE, 5, RANGE);
    expect(settled!.policy).toBe('cost-argmin');
    expect(settled!.exact).toBe(true);
    expect(settled!.abstainReason).toBe('none');
    // Two cells × one base tile each (the whole window is one base bucket
    // here) at 1000 B vs two DAY tiles at 9000 B: the base tier wins on bytes
    // at equal request counts.
    expect(settled!.bucketMs).toBe(HOUR);
    expect(settled!.tiles).toBe(2);
    expect(settled!.bytes).toBe(2000);
    expect(settled!.requestOverheadBytes).toBe(price);
  });
});

describe('CO-5: property — argmin cost never exceeds the zoom-threshold cost', () => {
  /** Deterministic PRNG: no wall clock, no Math.random in a pinned test. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('holds for random priced tier sets (the pure objective)', () => {
    const rand = mulberry32(0xc05);
    for (let trial = 0; trial < 500; trial++) {
      const tierCount = 1 + Math.floor(rand() * 4);
      const priced: Array<{ bucketMs: number; selection: SelectionCost }> = [];
      for (let i = 0; i < tierCount; i++) {
        priced.push({
          bucketMs: HOUR * Math.pow(4, i),
          selection: {
            bytes: Math.floor(rand() * 1e6),
            // 1..200: every tier here HAS coverage, which is what makes
            // "≤ the coarsest" the right statement of the property. The
            // zero-coverage case is a different property, asserted below.
            tiles: 1 + Math.floor(rand() * 200),
            unknownTiles: 0,
          },
        });
      }
      const overhead = Math.floor(rand() * 4e6);
      const argmin = temporalTierArgmin(priced, overhead);
      // The zoom threshold always takes the COARSEST addressable tier.
      const coarsest = argmin.candidates[0];
      expect(argmin.pick!.cost).toBeLessThanOrEqual(coarsest.cost);
      for (const c of argmin.candidates) {
        expect(argmin.pick!.cost).toBeLessThanOrEqual(c.cost);
      }
    }
  });

  it('never picks a zero-coverage tier, however cheaply it prices', () => {
    const rand = mulberry32(0x0c5);
    let sawMixed = 0;
    let sawAllEmpty = 0;
    for (let trial = 0; trial < 500; trial++) {
      const tierCount = 1 + Math.floor(rand() * 4);
      const priced: Array<{ bucketMs: number; selection: SelectionCost }> = [];
      for (let i = 0; i < tierCount; i++) {
        // ~40% of tiers hold NOTHING for this query — the blank-frame trap.
        const tiles = rand() < 0.4 ? 0 : 1 + Math.floor(rand() * 200);
        priced.push({
          bucketMs: HOUR * Math.pow(4, i),
          selection: {
            bytes: tiles === 0 ? 0 : Math.floor(rand() * 1e6),
            tiles,
            unknownTiles: 0,
          },
        });
      }
      const overhead = Math.floor(rand() * 4e6);
      const argmin = temporalTierArgmin(priced, overhead);
      const eligible = argmin.candidates.filter((c) => c.eligible);
      if (eligible.length === 0) {
        sawAllEmpty++;
        expect(argmin.pick).toBeNull();
        expect(argmin.reason).toBe('no-eligible-tier');
        continue;
      }
      if (eligible.length < argmin.candidates.length) sawMixed++;
      expect(argmin.pick!.eligible).toBe(true);
      expect(argmin.pick!.selection.tiles).toBeGreaterThan(0);
      // Optimal AMONG THE TIERS THAT CAN BE BOUGHT.
      for (const c of eligible) {
        expect(argmin.pick!.cost).toBeLessThanOrEqual(c.cost);
      }
    }
    // The sweep really did exercise both shapes of the trap.
    expect(sawMixed).toBeGreaterThan(0);
    expect(sawAllEmpty).toBeGreaterThan(0);
  });

  it('holds end-to-end on random synthetic pyramids and windows', async () => {
    scriptClock();
    const rand = mulberry32(0x7f5);
    let compared = 0;
    for (let trial = 0; trial < 12; trial++) {
      // A random 2-level pyramid over a random hourly base tier, all emitted
      // at the zoom the query will address so every tier prices non-trivially.
      const zoom = Math.floor(rand() * 7); // 0..6 (keeps the cell scan small)
      const dayCut = Math.floor(rand() * 7); // 0..6
      const monthCut = Math.floor(rand() * 7); // 0..6, independent of dayCut
      const hours = 4 + Math.floor(rand() * 30);
      const tiles: SynthTile[] = hourlyBaseTiles(
        hours,
        1 + Math.floor(rand() * 4000),
        zoom,
      );
      tiles.push({
        zoom,
        x: 0,
        y: 0,
        timeStart: 0,
        timeEnd: DAY - 1,
        bucketMs: DAY,
        blobSize: 1 + Math.floor(rand() * 60_000),
      });
      tiles.push({
        zoom,
        x: 0,
        y: 0,
        timeStart: 0,
        timeEnd: MONTH - 1,
        bucketMs: MONTH,
        blobSize: 1 + Math.floor(rand() * 400_000),
      });
      const archive = costArchive({
        tiles,
        lod: [
          { bucket_ms: DAY, max_zoom_level: dayCut },
          { bucket_ms: MONTH, max_zoom_level: monthCut },
        ],
      });

      const start = Math.floor(rand() * hours) * HOUR;
      const end = start + Math.floor(rand() * hours * HOUR);
      const window: TimeRange = { start, end };

      // Measure this link before comparing anything priced against it.
      await warm(archive, WORLD, zoom, { start: 0, end: hours * HOUR });

      const pick = await archive.pickTemporalLodByCost(WORLD, zoom, window);
      expect(pick).toBeDefined();
      expect(pick!.policy).toBe('cost-argmin');
      expect(pick!.requestOverheadBytes).toBe(measuredRequestPrice(archive));

      // Price the incumbent's answer with the SAME objective.
      const thresholdBucket =
        (await archive.pickTemporalLodForZoom(zoom))?.bucketMs ?? HOUR;
      const t = archive.estimateSelectionCost(WORLD, zoom, window, {
        bucketMs: thresholdBucket,
      });
      // The property is about tiers that can actually be BOUGHT. A threshold
      // tier with no coverage for this window prices at 0 and is not a cheaper
      // alternative — it is a blank frame, and the argmin is right to refuse
      // it (see the eligibility pin). Windows past the coarse tile's span do
      // produce that case, so it is skipped explicitly rather than silently.
      if (t.tiles === 0) continue;
      compared++;
      const thresholdCost = t.bytes + t.tiles * pick!.requestOverheadBytes;
      expect(pick!.cost).toBeLessThanOrEqual(thresholdCost);
    }
    // The sweep is not vacuous.
    expect(compared).toBeGreaterThan(0);
  });
});
