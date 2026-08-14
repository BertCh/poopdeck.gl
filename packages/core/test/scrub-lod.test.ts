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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { ScrubLodOptions } from '../src/spatiotemporal-tileset';
import type { EvictProbeSample } from '../src/telemetry';
import type {
  BoundingBox,
  SelectionCost,
  TemporalLodLevel,
  TileId,
} from '../src/types';
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
  /** CO-5 tier-pick policy (default = the option's own default). */
  temporalTierPolicy?: 'zoom-threshold' | 'cost-argmin';
  /**
   * CO-1 oracle stand-in: per-tier `SelectionCost`, keyed by bucket width.
   * `undefined` leaves the oracle UNWIRED (capability detection), which must
   * route the pick straight back to the zoom threshold.
   */
  tierCosts?: Record<number, SelectionCost>;
  /** CO-7 exchange rate stand-in (bytes per request). @default 0 */
  requestOverheadBytes?: number;
}

function makeHarness(opts: HarnessOptions = {}) {
  const baseCalls: Array<{
    zoom: number;
    range: { start: number; end: number };
  }> = [];
  const lodCalls: Array<{ zoom: number; bucketMs: number }> = [];
  /** Every tier the cost oracle was asked to price, in ask order. */
  const pricedTiers: number[] = [];
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
    temporalTierPolicy: opts.temporalTierPolicy,
    estimateSelectionCost: opts.tierCosts
      ? (_b, _z, _r, o) => {
          const bucketMs = o?.bucketMs ?? BUCKET_MS;
          pricedTiers.push(bucketMs);
          return (
            opts.tierCosts![bucketMs] ?? {
              bytes: 0,
              tiles: 0,
              unknownTiles: 0,
            }
          );
        }
      : undefined,
    getRequestOverheadBytes: opts.tierCosts
      ? () => opts.requestOverheadBytes ?? 0
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
  return { tileset, baseCalls, lodCalls, pricedTiers, update, visibleKeys };
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

/**
 * P0-2 — the CORE half of the scrub instrumentation, over a synthetic drag.
 *
 * The five-field `ScrubQoeStats` itself lives on the PlaybackGovernor
 * (`@poopdeck.gl/playback`), because it is accumulated between the governor's
 * `scrubstart`/`scrubend` events; `@poopdeck.gl/core` has no dependency on the
 * playback engine and cannot import the type, so that accumulation is pinned
 * in `packages/playback/test/playback-governor.test.ts`. What core owns — and
 * what P0-5's byte-during-scrub metric is windowed against — is the eviction
 * accounting under the drag, asserted here.
 */
describe('scrub drag — core-side eviction accounting (P0-2)', () => {
  interface ProbeBag {
    enabled?: boolean;
    evict?: EvictProbeSample[];
    [k: string]: unknown;
  }
  const readBag = (): ProbeBag | undefined =>
    (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  const setBag = (bag: ProbeBag | undefined): void => {
    if (bag === undefined) {
      delete (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
    } else {
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe = bag;
    }
  };

  let original: ProbeBag | undefined;
  beforeEach(() => {
    original = readBag();
    setBag(undefined);
  });
  afterEach(() => {
    setBag(original);
  });

  /** Grab → 8 preview positions → release, against a 2-tile cache ceiling. */
  async function synthDrag(
    tileset: SpatioTemporalTileset,
    update: (bucketIndex: number, zoom?: number) => void,
  ): Promise<void> {
    tileset.setInteractive(true);
    await settle();
    for (let bucket = 6; bucket <= 13; bucket++) {
      update(bucket);
      await settle();
    }
    tileset.setInteractive(false);
    await settle();
  }

  it('emits one `evict` sample per eviction, and bytesEvicted agrees with them', async () => {
    const { tileset, update } = makeHarness({
      scrubLod: { spatial: true, spatialZoomDrop: 2 },
      trackBuffer: true,
    });
    update(5);
    await settle();
    tileset.options.maxCacheSize = 2; // force the drag to churn the cache

    setBag({ enabled: true });
    const before = tileset.getCacheStats();
    await synthDrag(tileset, update);
    const after = tileset.getCacheStats();

    const samples = readBag()!.evict!;
    // The drag really did evict, and the channel accounts for EVERY eviction
    // — a per-tier attribution with holes in it would silently under-report.
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.length).toBe(after.evictions - before.evictions);
    expect(after.bytesEvicted - before.bytesEvicted).toBe(
      samples.reduce((sum, s) => sum + s.bytes, 0),
    );
    // Every sample is attributed to a real tier and stamped with the playhead
    // it was judged against — that stamp is what lets P0-5 window the drag.
    for (const s of samples) {
      expect(['a', 'b', 'c', 'd']).toContain(s.tier);
      expect(typeof s.playheadMs).toBe('number');
    }
    // The tier counters only ever count the playhead-relative tiers.
    const byTier = after.evictionsByTier;
    expect(byTier.b + byTier.c + byTier.d).toBe(
      samples.filter((s) => s.tier !== 'a').length,
    );

    // G7 / the restore invariant is untouched by the instrumentation: the
    // fine tier is back the moment the thumb lifts.
    expect(tileset.isInteractive).toBe(false);

    tileset.finalize();
  });

  it('is a no-op across the whole drag when the probe is off', async () => {
    const { tileset, update } = makeHarness({
      scrubLod: { spatial: true, spatialZoomDrop: 2 },
      trackBuffer: true,
    });
    update(5);
    await settle();
    tileset.options.maxCacheSize = 2;

    await synthDrag(tileset, update);

    // Not merely "no samples" — the bag was never created, so no probe
    // payload was ever allocated on the eviction path.
    expect(readBag()).toBeUndefined();
    // The plain counters still accumulate: they are fields, not probe state.
    expect(tileset.getCacheStats().evictions).toBeGreaterThan(0);
    expect(tileset.getCacheStats().bytesEvicted).toBeGreaterThan(0);

    tileset.finalize();
  });
});

/**
 * CO-5 — the temporal-tier pick as a 1-D argmin, on the tileset's scrub path.
 *
 * Two gates, both binding: the outer one is `scrubLod.temporal` (unchanged —
 * the axis is still what turns temporal-LOD selection on at all), the inner
 * one is `temporalTierPolicy`, whose DEFAULT is the incumbent zoom threshold.
 * So the first thing asserted here is that nothing moves by default; only
 * then does the cost path get to be interesting.
 *
 * The tier costs are injected rather than measured: what is under test is the
 * DECISION (which tier, and when it abstains), not CO-1's arithmetic, which
 * has its own suite.
 */
describe('CO-5: temporalTierPolicy on the scrub path', () => {
  /** Prices that make the BASE tier the cheapest (the over-fetch case). */
  const BASE_CHEAPEST: Record<number, SelectionCost> = {
    [BUCKET_MS]: { bytes: 10, tiles: 1, unknownTiles: 0 },
    [2 * BUCKET_MS]: { bytes: 900, tiles: 1, unknownTiles: 0 },
    [LOD_BUCKET_MS]: { bytes: 4000, tiles: 1, unknownTiles: 0 },
  };
  /** Prices that make the MIDDLE tier the cheapest — not the coarsest. */
  const MIDDLE_CHEAPEST: Record<number, SelectionCost> = {
    [BUCKET_MS]: { bytes: 900, tiles: 1, unknownTiles: 0 },
    [2 * BUCKET_MS]: { bytes: 50, tiles: 1, unknownTiles: 0 },
    [LOD_BUCKET_MS]: { bytes: 5000, tiles: 1, unknownTiles: 0 },
  };

  it('DEFAULT policy: the pick is the incumbent snap and the oracle is never consulted', async () => {
    const { tileset, lodCalls, pricedTiers, update } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
      // Oracles wired, policy left at its default. This is the regression pin:
      // wiring the oracle must not, by itself, change a single selection.
      tierCosts: BASE_CHEAPEST,
    });

    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();

    expect(lodCalls).toEqual([{ zoom: 10, bucketMs: LOD_BUCKET_MS }]);
    expect(pricedTiers).toEqual([]);
    tileset.finalize();
  });

  it('cost-argmin: a cheaper BASE tier keeps selection on the base tier', async () => {
    const { tileset, baseCalls, lodCalls, pricedTiers, update, visibleKeys } =
      makeHarness({
        scrubLod: { temporal: true },
        withLod: true,
        temporalTierPolicy: 'cost-argmin',
        tierCosts: BASE_CHEAPEST,
      });

    update(5);
    await settle();
    const before = visibleKeys();

    tileset.setInteractive(true);
    await settle();

    // Every addressable tier was priced — base included, coarsest first.
    expect(pricedTiers.slice(0, 3)).toEqual([
      LOD_BUCKET_MS,
      2 * BUCKET_MS,
      BUCKET_MS,
    ]);
    // ...and the base tier won, so the LOD enumeration was never called and
    // the fine tiles stay on screen. The zoom threshold would have bought the
    // 4 s tile here.
    expect(lodCalls).toEqual([]);
    expect(baseCalls.every((c) => c.zoom === 10)).toBe(true);
    expect(visibleKeys()).toEqual(before);

    tileset.setInteractive(false);
    await settle();
    tileset.finalize();
  });

  it('cost-argmin: picks the cheapest tier even when it is not the coarsest', async () => {
    const { tileset, lodCalls, update } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
      temporalTierPolicy: 'cost-argmin',
      tierCosts: MIDDLE_CHEAPEST,
    });

    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();

    // The zoom threshold snaps to the coarsest applicable level (4 s); the
    // argmin buys the 2 s tier because it is genuinely cheaper.
    expect(lodCalls).toEqual([{ zoom: 10, bucketMs: 2 * BUCKET_MS }]);
    expect(tileset.getVisibleTiles().map((t) => t.id.bucketMs)).toEqual([
      2 * BUCKET_MS,
    ]);

    tileset.finalize();
  });

  it('cost-argmin: the request price can make a coarse tier win on tile COUNT alone', async () => {
    const { tileset, lodCalls, update } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
      temporalTierPolicy: 'cost-argmin',
      // Identical bytes at every tier — only the number of separately
      // addressed tiles differs, which is exactly what L̂·θ̂ prices.
      tierCosts: {
        [BUCKET_MS]: { bytes: 2400, tiles: 24, unknownTiles: 0 },
        [2 * BUCKET_MS]: { bytes: 2400, tiles: 12, unknownTiles: 0 },
        [LOD_BUCKET_MS]: { bytes: 2400, tiles: 6, unknownTiles: 0 },
      },
      requestOverheadBytes: 1000,
    });

    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();

    expect(lodCalls).toEqual([{ zoom: 10, bucketMs: LOD_BUCKET_MS }]);
    tileset.finalize();
  });

  it('cost-argmin: an unpriced tier abstains back to the zoom threshold', async () => {
    const { tileset, lodCalls, update } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
      temporalTierPolicy: 'cost-argmin',
      tierCosts: {
        // The base tier LOOKS cheapest — but its answer is a lower bound
        // (a non-resident directory leaf), so it must not be acted on.
        [BUCKET_MS]: { bytes: 10, tiles: 1, unknownTiles: 7 },
        [2 * BUCKET_MS]: { bytes: 900, tiles: 1, unknownTiles: 0 },
        [LOD_BUCKET_MS]: { bytes: 4000, tiles: 1, unknownTiles: 0 },
      },
    });

    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();

    // The incumbent answers: coarsest applicable level.
    expect(lodCalls).toEqual([{ zoom: 10, bucketMs: LOD_BUCKET_MS }]);
    tileset.finalize();
  });

  it('cost-argmin with the oracles unwired is the zoom threshold (capability detection)', async () => {
    const { tileset, lodCalls, update } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
      temporalTierPolicy: 'cost-argmin',
      // tierCosts omitted ⇒ neither oracle is wired.
    });

    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();

    expect(lodCalls).toEqual([{ zoom: 10, bucketMs: LOD_BUCKET_MS }]);
    tileset.finalize();
  });

  it('cost-argmin is inert while the scrubLod.temporal axis is off (the outer kill switch)', async () => {
    const { tileset, lodCalls, pricedTiers, update } = makeHarness({
      scrubLod: { spatial: true, spatialZoomDrop: 2 },
      withLod: true,
      temporalTierPolicy: 'cost-argmin',
      tierCosts: BASE_CHEAPEST,
    });

    update(5);
    await settle();
    tileset.setInteractive(true);
    await settle();

    // The spatial axis degrades as before; the tier oracle is not even asked.
    expect(lodCalls).toEqual([]);
    expect(pricedTiers).toEqual([]);
    tileset.finalize();
  });

  it('is deterministic: the same scripted drag yields the same tier sequence', async () => {
    const run = async (): Promise<
      Array<{ zoom: number; bucketMs: number }>
    > => {
      const { tileset, lodCalls, update } = makeHarness({
        scrubLod: { temporal: true },
        withLod: true,
        temporalTierPolicy: 'cost-argmin',
        tierCosts: MIDDLE_CHEAPEST,
      });
      update(5);
      await settle();
      tileset.setInteractive(true);
      await settle();
      for (let bucket = 6; bucket <= 9; bucket++) {
        update(bucket);
        await settle();
      }
      tileset.setInteractive(false);
      await settle();
      tileset.finalize();
      return lodCalls;
    };
    expect(await run()).toEqual(await run());
  });
});

/**
 * CO-5 readiness isolation — the structural half of preview-never-gates.
 *
 * The tier pick moves SELECTION. It must not move readiness: the coverage
 * index is built from the base-tier enumeration at the undegraded primary
 * zoom, and every tile it keys is a base-tier `tileKey`. A coarse-tier tile is
 * keyed with its `bucketMs` folded in, so it cannot satisfy a base bucket even
 * when it spans one — which is what lets a gate re-arm against full detail on
 * scrub release rather than against the preview it just showed.
 */
describe('CO-5: readiness stays pinned to the fine base tier', () => {
  it('getBufferedRunway / getBufferedRanges never report the coarse tier', async () => {
    const { tileset, update } = makeHarness({
      scrubLod: { temporal: true },
      withLod: true,
      temporalTierPolicy: 'cost-argmin',
      // The coarse 4 s tier wins, so the drag really does load a coarse tile
      // spanning base buckets 4..7.
      tierCosts: {
        [BUCKET_MS]: { bytes: 9000, tiles: 4, unknownTiles: 0 },
        [2 * BUCKET_MS]: { bytes: 4000, tiles: 2, unknownTiles: 0 },
        [LOD_BUCKET_MS]: { bytes: 100, tiles: 1, unknownTiles: 0 },
      },
      trackBuffer: true,
    });

    update(5);
    await settle();
    // At rest, exactly base bucket 5 is buffered.
    expect(tileset.getBufferedRanges()).toEqual([{ start: 5000, end: 6000 }]);

    tileset.setInteractive(true);
    await settle();
    // The coarse tile IS resident and IS what renders.
    expect(tileset.getVisibleTiles().map((t) => t.id.bucketMs)).toEqual([
      LOD_BUCKET_MS,
    ]);

    // ...and it buys the readiness APIs nothing. Buckets 4, 6 and 7 lie under
    // the coarse tile's span and stay unbuffered; the runway probed from the
    // coarse tile's own start is zero.
    expect(tileset.getBufferedRanges()).toEqual([{ start: 5000, end: 6000 }]);
    const runway = tileset.getBufferedRunway(4000, 1, 3000);
    expect(runway.simMs).toBe(0);
    expect(runway.complete).toBe(false);

    // Release restores the fine tier; readiness is unchanged by the round trip.
    tileset.setInteractive(false);
    await settle();
    expect(tileset.getBufferedRanges()).toEqual([{ start: 5000, end: 6000 }]);

    tileset.finalize();
  });
});
