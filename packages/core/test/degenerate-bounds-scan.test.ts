/**
 * The archive's last line of defence against a degenerate query box, and the
 * cost ceiling on the scan itself. See docs/roadmap/tile-loading-3d-2026-07.md
 * §4.3 ("defence in depth") and Wave-1 items F2 / F7a.
 *
 * The producers of a `BoundingBox` are four independent camera→ground
 * projections, and every one of them can emit an inverted or world-sized box
 * for a camera the user considers ordinary. `normalizeViewportBounds` repairs
 * that at the producer; these tests pin what happens when something reaches the
 * archive UNREPAIRED, because the failure modes are silent:
 *
 *  - an inverted LATITUDE box made `boundsToTiles`' row loop never execute —
 *    zero tiles, while every readiness signal reported settled and buffered;
 *  - a whole-world box at a zoom CLAMPED up into a regional archive's range
 *    enumerated ~1e6 cells per pass, at display refresh during playback,
 *    to find the handful of tiles the archive actually has.
 *
 * The latitude half of the seam contract lives in `antimeridian-bounds.test.ts`
 * (which owns the longitude half, including the crossing-vs-inversion split).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { STTArchive } from '../src/archive';
import { encodeDirectory } from '../src/directory';
import type { BoundingBox, TileId } from '../src/types';
import {
  directoryObject,
  packObject,
  packedFetch,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';

const HOUR = 3_600_000;
const RANGE = { start: 0, end: HOUR };
const WORLD: BoundingBox = {
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
};

let seq = 0;

interface SynthTile {
  zoom: number;
  x: number;
  y: number;
}

/** Web-Mercator tile coordinates of a lon/lat, computed independently of archive.ts. */
function tileOf(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
  return [x, y];
}

/**
 * A packed archive holding exactly `tiles` (1-byte blobs, one bucket each) and
 * declaring `bounds` as its extent. Only the directory walk is under test.
 */
function buildArchive(
  tiles: SynthTile[],
  bounds: BoundingBox,
  zoomRange: { min: number; max: number },
): InMemoryPackedDataset {
  const blobs = tiles.map((_, i) => new Uint8Array(1).fill(i & 0xff));
  const { bytes: pack, offsets } = packObject(blobs);
  const indexBytes = encodeDirectory(
    tiles.map((t, i) => ({
      zoom: t.zoom,
      x: t.x,
      y: t.y,
      timeStart: 0,
      timeEnd: HOUR,
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
        formatVersion: 2,
        compression: 'none',
        directory: {
          key: 'index/dir.sttd',
          length: dirObject.byteLength,
          directoryVersion: 5,
        },
        packs: [{ key: 'packs/p0.sttp', length: pack.byteLength }],
        metadata: {
          name: 'degenerate',
          bounds: {
            min_lon: bounds.minLon,
            min_lat: bounds.minLat,
            max_lon: bounds.maxLon,
            max_lat: bounds.maxLat,
          },
          time_range: { start: 0, end: HOUR },
          temporal_bucket_ms: HOUR,
          min_zoom: zoomRange.min,
          max_zoom: zoomRange.max,
        },
      }),
    ),
  );
  return { objects, manifestUrl: `mem://degenerate-${seq++}/manifest.json` };
}

function openArchive(
  tiles: SynthTile[],
  bounds: BoundingBox = WORLD,
  zoomRange = { min: 0, max: 14 },
): STTArchive {
  const ds = buildArchive(tiles, bounds, zoomRange);
  return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
}

const cells = (ids: TileId[]): string[] =>
  ids.map((i) => `${i.x}/${i.y}`).sort();

// ---------------------------------------------------------------------------
// F2 — the row span must be ORDERED, not just clamped
// ---------------------------------------------------------------------------

describe('an inverted latitude box', () => {
  // z2 row 1 spans roughly 0…66°N, row 2 roughly 66°S…0 — so a ±10° band
  // covers both, and the tiles below sit in it.
  const BAND: SynthTile[] = [1, 2].map((y) => ({ zoom: 2, x: 1, y }));

  it('selects the band it brackets instead of NOTHING', async () => {
    const archive = openArchive(BAND);
    const wellFormed = await archive.getTileIdsInBounds(
      { minLon: -10, minLat: -10, maxLon: 10, maxLat: 10 },
      2,
      RANGE,
    );
    // The same box with its latitudes swapped — what a bearing-rotated or
    // above-horizon camera produced. `minY > maxY` used to make the row loop
    // body never run: zero tiles, silently.
    const inverted = await archive.getTileIdsInBounds(
      { minLon: -10, minLat: 10, maxLon: 10, maxLat: -10 },
      2,
      RANGE,
    );
    expect(cells(wellFormed)).toEqual(['1/1', '1/2']);
    expect(cells(inverted)).toEqual(cells(wellFormed));
  });

  it('is ordered by the ROW SCAN itself, not only by the extent clip', async () => {
    // An archive whose declared extent is unusable gets no clip at all (an
    // inverted extent is not evidence about the query), so the row scan's own
    // ordering is the only thing standing between this box and a loop body
    // that never executes. Both repairs have to be there: the clip is not
    // reachable for every archive, and the scan is the primitive.
    const archive = openArchive(BAND, {
      minLon: 10,
      minLat: 10,
      maxLon: -10,
      maxLat: -10,
    });
    const ids = await archive.getTileIdsInBounds(
      { minLon: -10, minLat: 10, maxLon: 10, maxLat: -10 },
      2,
      RANGE,
    );
    expect(cells(ids)).toEqual(['1/1', '1/2']);
  });

  it('is repaired on the temporal-LOD scan too', async () => {
    const archive = openArchive(BAND);
    const ids = await archive.getTileIdsInBoundsForTemporalLod(
      { minLon: -10, minLat: 10, maxLon: 10, maxLat: -10 },
      2,
      RANGE,
      HOUR,
    );
    expect(cells(ids)).toEqual(['1/1', '1/2']);
  });

  it('survives BOTH axes inverted at once', async () => {
    // pitch > 71.57° with bearing past atan2(h, w): longitude and latitude
    // invert independently, and the audit measured both together.
    const archive = openArchive(BAND);
    const ids = await archive.getTileIdsInBounds(
      { minLon: 5, minLat: 10, maxLon: -5, maxLat: -10 },
      2,
      RANGE,
    );
    expect(cells(ids)).toEqual(['1/1', '1/2']);
  });
});

// ---------------------------------------------------------------------------
// F7a — intersect with the declared extent, then cap what is left
// ---------------------------------------------------------------------------

describe('the declared extent must NOT narrow the query', () => {
  const MONTREAL: BoundingBox = {
    minLon: -73.7,
    minLat: 45.4,
    maxLon: -73.5,
    maxLat: 45.6,
  };

  it('finds a regional tile under a whole-world box at the archive zoom', async () => {
    // The camera is zoomed out and the tileset CLAMPS the zoom up into
    // `[min_zoom, max_zoom]`, so the scan walks 1024 x ~1024 cells at z10 to
    // find one tile. That is a real per-frame cost — but it is a COST, and the
    // tile must still come back.
    const [x, y] = tileOf(-73.6, 45.5, 10);
    const archive = openArchive([{ zoom: 10, x, y }], MONTREAL, {
      min: 10,
      max: 10,
    });
    const ids = await archive.getTileIdsInBounds(WORLD, 10, RANGE);
    expect(cells(ids)).toEqual([`${x}/${y}`]);
  });

  it('returns tiles that lie OUTSIDE the declared extent', async () => {
    // THE REGRESSION GUARD. An earlier revision intersected the query with
    // `metadata.bounds` on the reasoning that a tile holding data must
    // intersect the archive's extent. That is false, because the declared
    // bounds do not bound the data: `calculate_bounds` takes the min/max of
    // each feature's CENTROID, while the tiler addresses tiles by VERTEX
    // (`lonlat_to_tile(p[0], p[1], zoom)` per point, and polygons clipped
    // across every tile they cross). So on any line / polygon / multi-point
    // archive the occupied tiles extend past the declared extent, and the
    // intersection silently dropped real, non-empty tiles at the edges of the
    // data.
    //
    // This fixture is exactly that shape: bounds tight around the centroid at
    // (0, 0), tiles spanning five columns either side of it.
    const CENTROID_ONLY: BoundingBox = {
      minLon: -0.1,
      minLat: -0.1,
      maxLon: 0.1,
      maxLat: 0.1,
    };
    const spread = [6, 7, 8, 9, 10].map((x) => ({ zoom: 4, x, y: 8 }));
    const archive = openArchive(spread, CENTROID_ONLY, { min: 4, max: 4 });
    const ids = await archive.getTileIdsInBounds(
      { minLon: -60, minLat: -20, maxLon: 80, maxLat: 20 },
      4,
      RANGE,
    );
    // With the extent intersection this returned only the centroid's own tile.
    expect(cells(ids)).toEqual(['10/8', '6/8', '7/8', '8/8', '9/8']);
  });

  it('still finds tiles when the query misses the declared extent entirely', async () => {
    // The same defect at its most extreme: a query that does not overlap the
    // declared bounds at all short-circuited to `[]` before the scan. A
    // polygon archive whose centroids cluster in one region but whose geometry
    // reaches another would go permanently blank there.
    const [x, y] = tileOf(105, 0, 6);
    const archive = openArchive([{ zoom: 6, x, y }], MONTREAL, {
      min: 6,
      max: 6,
    });
    const ids = await archive.getTileIdsInBounds(
      { minLon: 100, minLat: -10, maxLon: 110, maxLat: 10 },
      6,
      RANGE,
    );
    expect(cells(ids)).toEqual([`${x}/${y}`]);
  });

  it('returns nothing when the box covers no tile the archive holds', async () => {
    // Emptiness must come from the ENTRY INDEX, never from the declared extent.
    const [x, y] = tileOf(-73.6, 45.5, 10);
    const archive = openArchive([{ zoom: 10, x, y }], MONTREAL, {
      min: 10,
      max: 10,
    });
    const ids = await archive.getTileIdsInBounds(
      { minLon: 100, minLat: -10, maxLon: 110, maxLat: 10 },
      10,
      RANGE,
    );
    expect(ids).toEqual([]);
  });

  it('leaves the query alone when the archive declares no usable extent', async () => {
    const archive = openArchive(
      [{ zoom: 2, x: 1, y: 1 }],
      { minLon: 10, minLat: 10, maxLon: -10, maxLat: -10 }, // inverted extent
      { min: 0, max: 14 },
    );
    const ids = await archive.getTileIdsInBounds(
      { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 },
      2,
      RANGE,
    );
    expect(cells(ids)).toEqual(['1/1']);
  });
});

describe('the scan cell cap', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A genuinely global archive at z10. */
  function globalZ10(tiles: Array<[number, number]>): STTArchive {
    return openArchive(
      tiles.map(([x, y]) => ({ zoom: 10, x, y })),
      WORLD,
      { min: 10, max: 10 },
    );
  }

  it('warns — once per zoom — with the archive, zoom, count and cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = globalZ10([[512, 512]]);
    await archive.getTileIdsInBounds(WORLD, 10, RANGE);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('mem://degenerate-');
    expect(message).toContain('z10');
    expect(message).toContain('8192'); // the cap
    expect(message).toMatch(/enumerated \d{6,} cells/); // the count
    // The warning must NOT claim tiles were dropped — it is a frame-time
    // warning. An earlier revision truncated the scan here, which turned a
    // performance problem into a silent blank-region problem.
    expect(message).not.toContain('TRUNCATED');
    expect(message).toContain('does not drop tiles');

    // A camera does not move much between frames; a warning per frame would
    // bury the console it is meant to inform.
    await archive.getTileIdsInBounds(WORLD, 10, RANGE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns EVERY tile over the cap, including ones far from centre', async () => {
    // The cap warns; it must never narrow the result. An earlier revision kept
    // a centred window, which dropped the corner tile below — on screen, in the
    // needed set, and never loaded.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = globalZ10([
      [512, 512], // world centre — what the camera is pointed at
      [0, 512], // western edge, as far from centre in x as the box reaches
      // (y=0 is deliberately NOT used: at z10 it sits above lat 85, so it is
      // outside WORLD's own latitude span and its absence proves nothing.)
    ]);
    const ids = await archive.getTileIdsInBounds(WORLD, 10, RANGE);
    expect(cells(ids)).toEqual(['0/512', '512/512']);
  });

  it('leaves an ordinary viewport scan untouched and unwarned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [x, y] = tileOf(-73.6, 45.5, 10);
    const archive = globalZ10([[x, y]]);
    const ids = await archive.getTileIdsInBounds(
      { minLon: -74.2, minLat: 45.1, maxLon: -73.1, maxLat: 45.9 },
      10,
      RANGE,
    );
    expect(cells(ids)).toEqual([`${x}/${y}`]);
    expect(warn).not.toHaveBeenCalled();
  });
});
