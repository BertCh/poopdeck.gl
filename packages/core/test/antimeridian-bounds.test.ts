/**
 * Antimeridian-crossing viewport bounds.
 *
 * `WebMercatorViewport.unproject` returns UNWRAPPED longitudes, so a MapView
 * centred at lon 179 reports `{minLon: 174, maxLon: 184}` — and the `[180,
 * 184]` slice, which visually occupies the RIGHT HALF of the screen, lives at
 * tile columns `x ∈ [0…]`. Both tile scans used to clamp x into `[0, 2^z − 1]`
 * and simply dropped it, so on seam-crossing datasets (`ais-all-us`,
 * `drifters`) the eastern half of the viewport stayed permanently blank.
 *
 * Contracts under test:
 *  - x iteration is WRAP-AWARE: a seam-crossing span yields columns from both
 *    edges of the world (`tileXSpanForLonRange`, `boundsToTiles`,
 *    `getTileIdsInBounds`, `getTileIdsInBoundsForTemporalLod`);
 *  - the explicit `minLon > maxLon` crossing encoding round-trips;
 *  - a >360° span (a low-zoom unproject can produce one) covers every column
 *    EXACTLY ONCE — never a duplicate tile id;
 *  - the non-crossing path is unchanged, including the `maxLon === 180` edge
 *    where the historical CLAMP (not a wrap) is the right answer;
 *  - the paged directory pages in the leaves on BOTH sides of the seam, so a
 *    wrapped column is not selected against an empty entry index;
 *  - the tileset's `update()` accepts either encoding;
 *  - and — the 2026-07 addition — a `minLon > maxLon` pair is read as a
 *    CROSSING only while the width it implies stays under `MAX_SEAM_SPAN_DEG`.
 *    A pitch-inverted viewport produces the identical shape (above the horizon,
 *    `unproject` returns a point behind the camera and the pair swaps), and
 *    believing it selected 510 of 512 columns at z9 while the camera looked at
 *    two. See docs/roadmap/tile-loading-3d-2026-07.md §4.1.
 */

import { describe, it, expect } from 'vitest';
import {
  tileXSpanForLonRange,
  lonQueryIntervals,
  wrapLon,
  STTArchive,
} from '../src/archive';
import { MAX_SEAM_SPAN_DEG } from '../src/geo/viewport-bounds';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import {
  decodePagedRoot,
  encodeDirectory,
  type PageDescriptor,
} from '../src/directory';
import type { BoundingBox, TileId } from '../src/types';
import {
  directoryObject,
  packObject,
  packedFetch,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';
import { settle } from './helpers/fixtures';

const HOUR = 3_600_000;

/** Expand a span into its wrapped column list (what every caller does). */
function columns(minLon: number, maxLon: number, zoom: number): number[] {
  const n = 1 << zoom;
  const { start, count } = tileXSpanForLonRange(minLon, maxLon, zoom);
  return Array.from({ length: count }, (_, i) => (start + i) % n);
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

describe('tileXSpanForLonRange', () => {
  it('leaves an ordinary in-world span alone', () => {
    // z2: 4 columns of 90°. [-180,-90) [-90,0) [0,90) [90,180)
    expect(columns(-180, 180, 2)).toEqual([0, 1, 2, 3]);
    expect(columns(-10, 10, 2)).toEqual([1, 2]);
    expect(columns(95, 170, 2)).toEqual([3]);
  });

  it('clamps (does NOT wrap) a span whose east edge is exactly 180', () => {
    // lon 180 is the world's right edge, not the first column of a second
    // world: the historical clamp is what keeps a narrow eastern viewport
    // from pulling in a spurious x=0.
    expect(columns(179, 180, 2)).toEqual([3]);
    expect(columns(-180, 180, 1)).toEqual([0, 1]);
  });

  it('wraps an UNWRAPPED span that runs past +180', () => {
    // The unproject case: [174, 184] covers x=3 AND the wrapped x=0.
    expect(columns(174, 184, 2)).toEqual([3, 0]);
    expect(columns(170, 200, 3)).toEqual([7, 0]);
  });

  it('wraps an UNWRAPPED span that runs past -180', () => {
    expect(columns(-184, -176, 2)).toEqual([3, 0]);
  });

  it('supports the explicit minLon > maxLon crossing encoding', () => {
    expect(columns(170, -170, 2)).toEqual([3, 0]);
    // 100°E east through the seam to 100°W: columns 3 (90…180) and 0
    // (−180…−90) — and NOT column 1, which starts at −90.
    expect(columns(100, -100, 2)).toEqual([3, 0]);
    expect(columns(100, -80, 2)).toEqual([3, 0, 1]);
  });

  it('caps a >360° span at one world width (no duplicate columns)', () => {
    const cols = columns(-200, 200, 2);
    expect(cols).toHaveLength(4);
    expect(new Set(cols).size).toBe(4);

    const wide = columns(-540, 540, 3);
    expect(wide).toHaveLength(8);
    expect(new Set(wide).size).toBe(8);
  });

  it('reads a WIDE minLon > maxLon pair as an inversion, not a crossing', () => {
    // The audit's headline number: a pitch-inverted box at z9 selected 510 of
    // 512 columns for a camera looking at four of them. `[1, -1]` is what the
    // above-horizon unproject hands over — a 2°-wide view of the prime
    // meridian, encoded backwards.
    expect(tileXSpanForLonRange(1, -1, 9)).toEqual({ start: 254, count: 4 });
    expect(columns(5, -3, 2)).toEqual([1, 2]);
  });

  it('splits crossing from inversion at exactly MAX_SEAM_SPAN_DEG', () => {
    // Implied span = maxLon − minLon + 360. 349° is still believable as a
    // near-global view parked on the seam; 350° is not a viewport.
    expect(MAX_SEAM_SPAN_DEG).toBe(350);
    expect(columns(10, -1, 2)).toEqual([2, 3, 0, 1]); // 349° — crossing, kept
    expect(columns(10, 0, 2)).toEqual([2]); // 350° — inverted, swapped
  });

  it('never emits an out-of-world column', () => {
    for (const [a, b] of [
      [174, 184],
      [170, -170],
      [-184, -176],
      [-200, 200],
      [359, 361],
    ]) {
      for (const cols of [columns(a, b, 0), columns(a, b, 3), columns(a, b, 6)])
        for (const x of cols) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(1 << 6);
        }
    }
  });
});

describe('lonQueryIntervals', () => {
  it('passes an in-world range through untouched', () => {
    expect(lonQueryIntervals(-10, 10)).toEqual([[-10, 10]]);
  });

  it('splits an unwrapped or crossing range at the seam', () => {
    expect(lonQueryIntervals(174, 184)).toEqual([
      [174, 180],
      [-180, -176],
    ]);
    expect(lonQueryIntervals(170, -170)).toEqual([
      [170, 180],
      [-180, -170],
    ]);
  });

  it('collapses a full-world (or wider) range to one interval', () => {
    expect(lonQueryIntervals(-200, 200)).toEqual([[-180, 180]]);
  });

  it('re-joins a range that only LOOKED like it crossed', () => {
    expect(lonQueryIntervals(-190, -185)).toEqual([[170, 175]]);
  });

  it('applies the SAME crossing/inversion split as the column scan', () => {
    // These two decide different halves of one query — which leaf pages get
    // fetched, and which columns get selected. If they disagreed about an
    // inverted box, the selected columns would resolve against leaves that
    // were never paged in, which reads exactly like "no data here".
    expect(lonQueryIntervals(5, -3)).toEqual([[-3, 5]]);
    expect(lonQueryIntervals(10, -1)).toEqual([
      [10, 180],
      [-180, -1],
    ]);
  });

  it('wrapLon folds into [-180, 180)', () => {
    expect(wrapLon(184)).toBe(-176);
    expect(wrapLon(-184)).toBe(176);
    expect(wrapLon(0)).toBe(0);
    expect(wrapLon(540)).toBe(-180);
  });
});

// ---------------------------------------------------------------------------
// Through the archive
// ---------------------------------------------------------------------------

interface SynthTile {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
}

let synthSeq = 0;

/**
 * A minimal packed archive whose directory holds exactly `tiles` (1-byte
 * blobs). Only the directory walk is under test here.
 */
function buildArchive(tiles: SynthTile[]): InMemoryPackedDataset {
  const blobs = tiles.map((_, i) => new Uint8Array(1).fill(i & 0xff));
  const { bytes: pack, offsets } = packObject(blobs);
  const indexBytes = encodeDirectory(
    tiles.map((t, i) => ({
      zoom: t.zoom,
      x: t.x,
      y: t.y,
      timeStart: t.timeStart,
      timeEnd: t.timeEnd,
      packId: 0,
      offset: offsets[i],
      length: blobs[i].byteLength,
      uncompressedSize: blobs[i].byteLength,
      featureCount: 1,
      hilbert: 0,
      crc32c: 0,
    })),
  );
  const dirObject = directoryObject(indexBytes);
  const objects = new Map<string, Uint8Array>();
  objects.set('packs/p0.sttp', pack);
  objects.set('index/dir.sttd', dirObject);
  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        format: 'stt-packed',
        formatVersion: 3,
        variants: [{ id: 0, kind: 'raw' }],
        compression: 'none',
        directory: {
          key: 'index/dir.sttd',
          length: dirObject.byteLength,
          directoryVersion: 6,
        },
        packs: [{ key: 'packs/p0.sttp', length: pack.byteLength }],
        metadata: {
          name: 'seam',
          bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
          time_range: { start: 0, end: HOUR },
          temporal_bucket_ms: HOUR,
        },
      }),
    ),
  );
  return { objects, manifestUrl: `mem://seam-${synthSeq++}/manifest.json` };
}

/**
 * One tile per column at z2, row y=1 — the row the `[-10, 10]` test latitude
 * band lands in (z2 row 0 only reaches down to ~66°N).
 */
const Z2_ROW: SynthTile[] = [0, 1, 2, 3].map((x) => ({
  zoom: 2,
  x,
  y: 1,
  timeStart: 0,
  timeEnd: HOUR,
}));

function openArchive(tiles: SynthTile[]): STTArchive {
  const ds = buildArchive(tiles);
  return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
}

const RANGE = { start: 0, end: HOUR };
const bbox = (minLon: number, maxLon: number): BoundingBox => ({
  minLon,
  minLat: -10,
  maxLon,
  maxLat: 10,
});
const xs = (ids: TileId[]): number[] => ids.map((i) => i.x).sort();

describe('getTileIdsInBounds across the antimeridian', () => {
  it('an unwrapped bbox selects tiles from BOTH edges of the world', async () => {
    const archive = openArchive(Z2_ROW);
    const ids = await archive.getTileIdsInBounds(bbox(174, 184), 2, RANGE);
    expect(xs(ids)).toEqual([0, 3]);
  });

  it('the minLon > maxLon crossing encoding round-trips', async () => {
    const archive = openArchive(Z2_ROW);
    const ids = await archive.getTileIdsInBounds(bbox(170, -170), 2, RANGE);
    expect(xs(ids)).toEqual([0, 3]);
  });

  it('a non-crossing bbox is unchanged', async () => {
    const archive = openArchive(Z2_ROW);
    expect(
      xs(await archive.getTileIdsInBounds(bbox(-10, 10), 2, RANGE)),
    ).toEqual([1, 2]);
    expect(
      xs(await archive.getTileIdsInBounds(bbox(-180, 180), 2, RANGE)),
    ).toEqual([0, 1, 2, 3]);
    expect(
      xs(await archive.getTileIdsInBounds(bbox(179, 180), 2, RANGE)),
    ).toEqual([3]);
  });

  it('an INVERTED bbox selects the band it brackets, not the whole world', async () => {
    // What a pitched camera over the prime meridian hands the archive. The
    // crossing reading selected every column at this zoom; the band reading
    // selects the two the camera can actually see.
    const archive = openArchive(Z2_ROW);
    const ids = await archive.getTileIdsInBounds(bbox(5, -5), 2, RANGE);
    expect(xs(ids)).toEqual([1, 2]);
  });

  it('a >360° span emits every tile exactly once', async () => {
    const archive = openArchive(Z2_ROW);
    const ids = await archive.getTileIdsInBounds(bbox(-200, 200), 2, RANGE);
    expect(ids).toHaveLength(4);
    expect(new Set(ids.map((i) => `${i.z}/${i.x}/${i.y}/${i.t}`)).size).toBe(4);
  });

  it('getTileIdsInBoundsForTemporalLod wraps the same way', async () => {
    const archive = openArchive(Z2_ROW);
    const ids = await archive.getTileIdsInBoundsForTemporalLod(
      bbox(174, 184),
      2,
      RANGE,
      HOUR,
    );
    expect(xs(ids)).toEqual([0, 3]);
  });

  it('a multi-row bbox keeps the x-major, y-ascending emission order', async () => {
    const archive = openArchive([
      ...Z2_ROW,
      ...[0, 1, 2, 3].map((x) => ({
        zoom: 2,
        x,
        y: 2,
        timeStart: 0,
        timeEnd: HOUR,
      })),
    ]);
    const ids = await archive.getTileIdsInBounds(
      { minLon: 174, minLat: -10, maxLon: 184, maxLat: 10 },
      2,
      RANGE,
    );
    // x=3 (both its rows) before the wrapped x=0.
    expect(ids.map((i) => `${i.x}/${i.y}`)).toEqual([
      '3/1',
      '3/2',
      '0/1',
      '0/2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Paged directory: the leaf-page filter must cross the seam too
// ---------------------------------------------------------------------------

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

describe('paged directory across the antimeridian', () => {
  /**
   * Two leaves, one per side of the seam: the WEST leaf holds z2/x=3 (lon
   * 90…180), the EAST leaf holds z2/x=0 (lon −180…−90). A crossing query
   * selects columns from both, so both leaves must page in — the descriptor
   * filter used to prune the east one and the wrapped column then resolved
   * against an empty entry index.
   */
  function seamPagedDataset(): InMemoryPackedDataset {
    const entry = (x: number) => ({
      zoom: 2,
      x,
      y: 1,
      timeStart: 0,
      timeEnd: HOUR,
      packId: 0,
      offset: 0,
      length: 1,
      uncompressedSize: 1,
      featureCount: 1,
      hilbert: 0,
      crc32c: 0,
    });
    const west = encodeDirectory([entry(3)]);
    const east = encodeDirectory([entry(0)]);
    const pages: PageDescriptor[] = [
      {
        relOffset: 0,
        length: west.length,
        entryCount: 1,
        minZoom: 2,
        maxZoom: 2,
        minLon: 90,
        minLat: -66,
        maxLon: 180,
        maxLat: 0,
        tMin: 0,
        tMax: HOUR,
      },
      {
        relOffset: west.length,
        length: east.length,
        entryCount: 1,
        minZoom: 2,
        maxZoom: 2,
        minLon: -180,
        minLat: -66,
        maxLon: -90,
        maxLat: 0,
        tMin: 0,
        tMax: HOUR,
      },
    ];
    const root = encodePagedRootBytes(pages);
    // Guard the hand-rolled encoder against layout drift from the decoder.
    expect(decodePagedRoot(root).pages).toEqual(pages);

    const sttd = new Uint8Array(root.length + west.length + east.length);
    sttd.set(root, 0);
    sttd.set(west, root.length);
    sttd.set(east, root.length + west.length);

    const { bytes: pack } = packObject([new Uint8Array(1)]);
    const dirObject = directoryObject(sttd);
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
          compression: 'none',
          directory: {
            key: 'index/dir.sttd',
            length: dirObject.byteLength,
            directoryVersion: 6,
            layout: 'paged',
            rootLength: root.length,
            pageCount: 2,
            pageEntries: 1,
          },
          packs: [{ key: 'packs/p0.sttp', length: pack.byteLength }],
          metadata: {
            name: 'seam-paged',
            bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
            time_range: { start: 0, end: HOUR },
            temporal_bucket_ms: HOUR,
          },
        }),
      ),
    );
    return {
      objects,
      manifestUrl: `mem://seam-paged-${synthSeq++}/manifest.json`,
    };
  }

  const pagedArchive = (): STTArchive => {
    const ds = seamPagedDataset();
    return new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
      directoryPageThresholdBytes: 0, // force real paging
    });
  };

  it('pages in the leaves on BOTH sides for a crossing query', async () => {
    const ids = await pagedArchive().getTileIdsInBounds(
      bbox(174, 184),
      2,
      RANGE,
    );
    expect(xs(ids)).toEqual([0, 3]);
  });

  it('still prunes the far leaf for a non-crossing query', async () => {
    const ids = await pagedArchive().getTileIdsInBounds(
      bbox(120, 170),
      2,
      RANGE,
    );
    expect(xs(ids)).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Through the tileset's update()
// ---------------------------------------------------------------------------

describe('tileset update() with seam-crossing bounds', () => {
  const BUCKET = 1000;

  /**
   * A wrap-aware synthetic source: one tile per (wrapped column × bucket
   * overlapping the query range). `hang` keeps every fetch pending so the
   * request queues stay observable.
   */
  function makeTileset(opts: { prefetch?: boolean; hang?: boolean } = {}) {
    const seen: BoundingBox[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 6,
      temporalBucketMs: BUCKET,
      enablePrefetch: opts.prefetch ?? false,
      prefetchAhead: 20 * BUCKET,
      prefetchSteps: 1,
      maxRequests: 1,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (bounds, zoom, range) => {
        seen.push({ ...bounds });
        const n = 1 << zoom;
        const { start, count } = tileXSpanForLonRange(
          bounds.minLon,
          bounds.maxLon,
          zoom,
        );
        const ids: TileId[] = [];
        for (let i = 0; i < count; i++) {
          for (let b = 0; b < 60; b++) {
            const t = b * BUCKET;
            if (t + BUCKET >= range.start && t <= range.end)
              ids.push({ z: zoom, x: (start + i) % n, y: 0, t });
          }
        }
        return ids;
      },
      getTileData: async (id: TileId) => {
        if (opts.hang) return new Promise<never>(() => {});
        return {
          id,
          timeRange: { start: id.t, end: id.t + BUCKET },
          layers: [],
        } as never;
      },
      getTileDataBatch: opts.hang
        ? undefined
        : async (ids: TileId[]) =>
            ids.map(
              (id) =>
                ({
                  id,
                  timeRange: { start: id.t, end: id.t + BUCKET },
                  layers: [],
                }) as never,
            ),
    });
    return { tileset, seen };
  }

  it('passes the crossing bounds through and renders both edges', async () => {
    const { tileset, seen } = makeTileset();
    tileset.update({
      bounds: bbox(170, -170), // the crossing encoding
      zoom: 2,
      time: 0,
      timeWindow: 100,
    });
    await settle();
    expect(seen[0].minLon).toBe(170);
    expect(seen[0].maxLon).toBe(-170);
    const visible = tileset.getVisibleTiles();
    expect(visible.map((t) => t.id.x).sort()).toEqual([0, 3]);
  });

  it('measures a crossing viewport by its REAL 20° extent, not a negative span', async () => {
    // `maxLon − minLon` is NEGATIVE for a crossing box, which collapsed the
    // spatial-flush tolerance (a fraction of the extent) to ~0: every pass
    // then read as a big pan and flushed the prefetch runway, so a viewport
    // parked on the seam could never build one.
    const { tileset } = makeTileset({ prefetch: true, hang: true });
    const at = (lon: number): BoundingBox => bbox(lon, lon - 340); // 20° wide
    tileset.update({ bounds: at(170), zoom: 2, time: 0, timeWindow: 100 });
    await settle();
    const queued = tileset.getCacheStats().prefetchQueueLength;
    expect(queued).toBeGreaterThan(0);

    // 0.5° drift — well inside the 1/8 × 20° = 2.5° tolerance. The runway
    // must survive it.
    tileset.update({ bounds: at(170.5), zoom: 2, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getCacheStats().prefetchQueueLength).toBe(queued);

    // A real 10° pan is past the tolerance and DOES flush — proving the
    // check is still live, not just permanently disabled.
    tileset.update({ bounds: at(180.5), zoom: 2, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getCacheStats().prefetchQueueLength).toBe(0);
  });

  it('an unwrapped viewport renders both edges too', async () => {
    const { tileset } = makeTileset();
    tileset.update({
      bounds: bbox(174, 184),
      zoom: 2,
      time: 0,
      timeWindow: 100,
    });
    await settle();
    expect(
      tileset
        .getVisibleTiles()
        .map((t) => t.id.x)
        .sort(),
    ).toEqual([0, 3]);
  });
});
