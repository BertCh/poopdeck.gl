/**
 * Scrub-time LOD degradation (docs/roadmap/playback-and-loading.md P0–P2):
 * the tileset's `setInteractive` motion bit and the selection-only degrade
 * it drives when a `scrubLod` axis is enabled.
 *
 * Contracts under test:
 *  - kill switch: with `scrubLod` absent, setInteractive is stored state
 *    only — no reselection, no extra directory queries, today's behavior;
 *  - P1 spatial: while interactive, selection targets `zoom − drop`
 *    (clamped to the parent-fallback band) and the base zoom is restored
 *    the moment the bit clears (settle);
 *  - P2 temporal: while interactive, raw-tier selection routes through the
 *    temporal-LOD pyramid at the coarsest level covering the requested
 *    zoom; archives without a pyramid (or without the callback) no-op;
 *  - G7: the coverage index / buffered-runway math stays honest about the
 *    FINE primary tier throughout — the coarse tier is preview-only.
 *
 * Harness mirrors buffered-runway.test.ts: a synthetic single-cell archive
 * (one base tile per 1 s bucket; one LOD tile per 4 s bucket), tiny time
 * windows so each update addresses exactly one base bucket.
 */

import { describe, it, expect } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { ScrubLodOptions } from '../src/spatiotemporal-tileset';
import type { BoundingBox, TemporalLodLevel, TileId } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
  settle,
} from './helpers/fixtures';

const N_BUCKETS = 40;
const LOD_BUCKET_MS = 4 * BUCKET_MS;

/** Two coarse levels covering every zoom; the pick must snap to the COARSEST. */
const LOD_LEVELS: TemporalLodLevel[] = [
  { bucketMs: 2 * BUCKET_MS, maxZoomLevel: 12 },
  { bucketMs: LOD_BUCKET_MS, maxZoomLevel: 12 },
];

/** One base tile per 1 s bucket at (x=0, y=0), any zoom. */
const availableTiles = makeAvailableTiles(N_BUCKETS);

/** One LOD tile per `bucketMs` bucket at (x=0, y=0) overlapping the range. */
function lodTiles(
  _bounds: BoundingBox,
  zoom: number,
  range: { start: number; end: number },
  bucketMs: number,
): TileId[] {
  const ids: TileId[] = [];
  for (let t = 0; t < N_BUCKETS * BUCKET_MS; t += bucketMs) {
    if (t + bucketMs >= range.start && t <= range.end)
      ids.push({ z: zoom, x: 0, y: 0, t });
  }
  return ids;
}

interface HarnessOptions {
  scrubLod?: ScrubLodOptions;
  /** Wire the temporal-LOD capability (levels + enumeration callback)? */
  withLod?: boolean;
  /** Enable coverage tracking from the first update (the G7 probes). */
  trackBuffer?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const baseCalls: Array<{
    zoom: number;
    range: { start: number; end: number };
  }> = [];
  const lodCalls: Array<{ zoom: number; bucketMs: number }> = [];
  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    // One zoom level per selection pass — the degrade asserts stay exact.
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    scrubLod: opts.scrubLod,
    temporalLodLevels: opts.withLod ? LOD_LEVELS : undefined,
    getAvailableTemporalLodTiles: opts.withLod
      ? async (b, z, r, bucketMs) => {
          lodCalls.push({ zoom: z, bucketMs });
          return lodTiles(b, z, r, bucketMs);
        }
      : undefined,
    getAvailableTiles: async (b, z, r) => {
      baseCalls.push({ zoom: z, range: { ...r } });
      return availableTiles(b, z, r);
    },
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => ids.map((id) => fakeTile(id)),
    onBufferChange: opts.trackBuffer ? () => {} : undefined,
  });
  /** Address exactly base bucket `i` (tiny window centred inside it). */
  const update = (bucketIndex: number, zoom = 10): void => {
    tileset.update({
      bounds: BOUNDS,
      zoom,
      time: bucketIndex * BUCKET_MS + 500,
      timeWindow: 100,
    });
  };
  const visibleKeys = (): string[] =>
    tileset
      .getVisibleTiles()
      .map((t) => `${t.id.z}/${t.id.x}/${t.id.y}/${t.id.t}`)
      .sort();
  return { tileset, baseCalls, lodCalls, update, visibleKeys };
}

describe('scrub-LOD kill switch (P0 contract: bit only, zero behavior change)', () => {
  it('with scrubLod absent, setInteractive stores the bit and changes nothing', async () => {
    const { tileset, baseCalls, lodCalls, update, visibleKeys } = makeHarness({
      withLod: true,
    });

    update(5);
    await settle();
    expect(baseCalls.map((c) => c.zoom)).toEqual([10]);
    expect(visibleKeys()).toEqual(['10/0/0/5000']);

    tileset.setInteractive(true);
    expect(tileset.isInteractive).toBe(true);
    await settle();
    // No reselection was triggered, no query issued, nothing degraded.
    expect(baseCalls.length).toBe(1);
    expect(lodCalls.length).toBe(0);

    // An identical viewport update still rides the selection fast-path.
    update(5);
    await settle();
    expect(baseCalls.length).toBe(1);

    // A genuine time change selects at the ORDINARY viewport zoom.
    update(6);
    await settle();
    expect(baseCalls.map((c) => c.zoom)).toEqual([10, 10]);
    expect(lodCalls.length).toBe(0);
    expect(visibleKeys()).toEqual(['10/0/0/6000']);

    tileset.setInteractive(false);
    expect(tileset.isInteractive).toBe(false);
    tileset.finalize();
  });
});

describe('scrub-LOD spatial axis (P1)', () => {
  it('degrades the requested zoom during the drag and restores base on settle', async () => {
    const { tileset, baseCalls, update, visibleKeys } = makeHarness({
      scrubLod: { spatial: true, spatialZoomDrop: 2 },
    });

    update(5);
    await settle();
    expect(visibleKeys()).toEqual(['10/0/0/5000']);

    // Grab: selection re-runs immediately at zoom − 2.
    tileset.setInteractive(true);
    await settle();
    expect(baseCalls.map((c) => c.zoom)).toEqual([10, 8]);
    expect(visibleKeys()).toEqual(['8/0/0/5000']);

    // Release: the fine tier is restored without waiting for a clock tick.
    tileset.setInteractive(false);
    await settle();
    expect(baseCalls.map((c) => c.zoom)).toEqual([10, 8, 10]);
    expect(visibleKeys()).toEqual(['10/0/0/5000']);

    tileset.finalize();
  });

  it('clamps the drop to the parent-fallback band', async () => {
    const { tileset, baseCalls, update } = makeHarness({
      scrubLod: { spatial: true, spatialZoomDrop: 99 },
    });
    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();
    // 10 − PARENT_FALLBACK_LEVELS(4), never further.
    expect(baseCalls.map((c) => c.zoom)).toEqual([10, 6]);
    tileset.finalize();
  });
});

describe('scrub-LOD temporal axis (P2 — the temporal-LOD pyramid on the hot path)', () => {
  it('routes selection through the coarsest applicable LOD level during the drag', async () => {
    const { tileset, baseCalls, lodCalls, update, visibleKeys } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
    });

    update(5);
    await settle();
    expect(visibleKeys()).toEqual(['10/0/0/5000']);
    expect(lodCalls.length).toBe(0); // at rest: base tier only

    tileset.setInteractive(true);
    await settle();
    // The coarsest level covering z10 (4 s), not the 2 s one.
    expect(lodCalls).toEqual([{ zoom: 10, bucketMs: LOD_BUCKET_MS }]);
    expect(baseCalls.length).toBe(1); // the base tier was NOT re-queried
    expect(visibleKeys()).toEqual(['10/0/0/4000']); // the coarse-bucket tile renders
    // The LOD id is tier-stamped, so its cache identity can never alias the
    // base tile sharing z/x/y/t: `tileKey` folds `bucketMs` into the key.
    expect(tileset.getVisibleTiles().map((t) => t.id.bucketMs)).toEqual([
      LOD_BUCKET_MS,
    ]);

    tileset.setInteractive(false);
    await settle();
    expect(baseCalls.length).toBe(2);
    expect(visibleKeys()).toEqual(['10/0/0/5000']); // base tier restored

    tileset.finalize();
  });

  it('composes with the spatial axis (coarser zoom AND coarser bucket)', async () => {
    const { tileset, lodCalls, update, visibleKeys } = makeHarness({
      scrubLod: { spatial: true, spatialZoomDrop: 2, temporal: true },
      withLod: true,
    });
    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();
    expect(lodCalls).toEqual([{ zoom: 8, bucketMs: LOD_BUCKET_MS }]);
    expect(visibleKeys()).toEqual(['8/0/0/4000']);
    tileset.finalize();
  });

  it('no-ops on archives without a temporal-LOD pyramid (capability detection)', async () => {
    const { tileset, baseCalls, update, visibleKeys } = makeHarness({
      scrubLod: { temporal: true },
      withLod: false, // no levels, no callback — most fixtures
    });

    update(5);
    await settle();
    const before = visibleKeys();

    tileset.setInteractive(true);
    await settle();
    // The interactive reselect falls straight back to the base tier: same
    // tiles, ordinary zoom, no LOD query (there is nothing to query).
    expect(baseCalls.every((c) => c.zoom === 10)).toBe(true);
    expect(visibleKeys()).toEqual(before);

    tileset.setInteractive(false);
    await settle();
    expect(visibleKeys()).toEqual(before);
    tileset.finalize();
  });
});

describe('scrub-LOD G7 contract (preview-only: readiness stays on the fine tier)', () => {
  it('coverage index and buffered runway keep measuring the UNdegraded primary zoom', async () => {
    const { tileset, baseCalls, update } = makeHarness({
      scrubLod: { spatial: true, spatialZoomDrop: 2 },
      trackBuffer: true,
    });

    update(5);
    await settle();

    tileset.setInteractive(true);
    await settle();

    // The coverage build is the full-time-range slice; every one of those
    // queries must be at the FINE primary zoom (10) — never the degraded 8.
    const coverageCalls = baseCalls.filter((c) => c.range.start < -1e15);
    expect(coverageCalls.length).toBeGreaterThan(0);
    expect(coverageCalls.every((c) => c.zoom === 10)).toBe(true);

    // The runway is honest about the fine tier: base bucket 5 is loaded
    // (pre-scrub), bucket 6 is not — a resident coarse z8 preview tile for
    // the same span must NOT extend it.
    const runway = tileset.getBufferedRunway(5000, 1, 3000);
    expect(runway.simMs).toBe(1000);
    expect(runway.complete).toBe(false);

    tileset.finalize();
  });

  it('a resident temporal-LOD preview tile does NOT satisfy base coverage', async () => {
    const { tileset, update } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
      trackBuffer: true,
    });

    update(5);
    await settle();

    // Grab: the temporal axis loads the coarse tile for buckets 4..7 — it
    // shares z/x/y/t = 10/0/0/4000 with base bucket 4's (unloaded) tile.
    tileset.setInteractive(true);
    await settle();
    expect(
      tileset
        .getVisibleTiles()
        .map((t) => `${t.id.z}/${t.id.x}/${t.id.y}/${t.id.t}`),
    ).toEqual(['10/0/0/4000']);

    // The coverage index is base-keyed and the LOD tile is resident under
    // its tier-qualified key, so probing from t=4000 reports ZERO buffered
    // — before the tier-qualified keys, the resident preview tile aliased
    // base bucket 4 and the runway lied by a full bucket (G7: readiness
    // must re-arm against full detail, never the coarse preview).
    const runway = tileset.getBufferedRunway(4000, 1, 3000);
    expect(runway.simMs).toBe(0);
    expect(runway.complete).toBe(false);

    tileset.finalize();
  });
});
