/**
 * Tests for the batched (range-coalesced) load path in SpatioTemporalTileset,
 * and for the archive-side fuse threshold those batches are coalesced against.
 *
 * Before this, the live render path drained the priority/prefetch queues one
 * tile at a time through `getTileData` (= one HTTP Range request per tile),
 * even though the archive's `getTiles()` coalescer existed. These tests lock
 * in that, when a `getTileDataBatch` callback is provided, a multi-tile pass
 * is sent as ONE batched call (so adjacent byte ranges can coalesce), and
 * that the per-tile fallback still works when no batch callback is set.
 *
 * The second half covers CO-7 — the ADAPTIVE coalesce gap. The fuse rule is
 * `gap <= min(G, 4 × useful + 256 KiB)` (a range never crosses an object
 * boundary, and — audit C3 — never bridges more than a few times the useful
 * bytes it carries); the constant `G` is fitted from the link, as
 * `clamp(L̂ × θ̂, 256 KiB, 4 MiB)`. Everything that could make that fit wrong —
 * an explicit pin, a cold estimator, or an archive whose layout was optimized
 * against a specific gap — falls back to the historic 2 MiB constant, and
 * those fallbacks are pinned here as regression guards rather than left
 * implicit.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import {
  STTArchive,
  adaptiveCoalesceGapBand,
  adaptiveCoalesceGapBytes,
  planCoalescedRanges,
  DEFAULT_RANGE_COALESCE_GAP,
  MIN_ADAPTIVE_COALESCE_GAP,
  MAX_ADAPTIVE_COALESCE_GAP,
} from '../src/archive';
import { crc32c } from '../src/crc32c';
import { decodeDirectory, encodeDirectory } from '../src/directory';
import type { TileId, BoundingBox } from '../src/types';
import { BOUNDS, fakeTile } from './helpers/fixtures';
import {
  OBJECT_MAGIC_LEN,
  directoryObject,
  packedFetch,
  packedFromGolden,
  type InMemoryPackedDataset,
  type PackedFetchLog,
} from './helpers/packed-fixture';

describe('SpatioTemporalTileset batched (coalesced) loads', () => {
  it('routes a multi-tile pass through getTileDataBatch and loads every tile', async () => {
    const ids: TileId[] = [0, 1, 2, 3, 4].map((x) => ({ z: 6, x, y: 0, t: 0 }));
    const availSpy = vi.fn(async (_b: BoundingBox, z: number) =>
      ids.filter((i) => i.z === z),
    );
    const singleSpy = vi.fn(async (id: TileId) => fakeTile(id));
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));
    const loaded: TileId[] = [];

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: availSpy,
      getTileData: singleSpy,
      getTileDataBatch: batchSpy,
      onTileLoad: (t) => loaded.push(t.id),
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 20));

    // The batch path handled the multi-tile pass...
    expect(batchSpy).toHaveBeenCalled();
    // ...with more than one tile in a single call (i.e. it coalesced).
    const maxBatch = Math.max(
      ...batchSpy.mock.calls.map((c) => (c[0] as TileId[]).length),
    );
    expect(maxBatch).toBeGreaterThan(1);
    // The per-tile path was not used for this multi-tile pass.
    expect(singleSpy).not.toHaveBeenCalled();
    // Every requested tile was delivered.
    expect(loaded.length).toBe(ids.length);

    tileset.finalize();
  });

  it('sends the whole priority working set in ONE coalesced batch (no ⌈N/maxRequests⌉ split)', async () => {
    // 30 tiles with a deliberately small slot budget (maxRequests: 12). The old
    // code sliced this into ⌈30/12⌉ = 3 serial batches; the P0 fix sends all 30
    // in one globally-coalesced batch so byte-adjacent tiles collapse to a few
    // range requests in a single round-trip.
    const ids: TileId[] = Array.from({ length: 30 }, (_, x) => ({
      z: 6,
      x,
      y: 0,
      t: 0,
    }));
    const availSpy = vi.fn(async (_b: BoundingBox, z: number) =>
      ids.filter((i) => i.z === z),
    );
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      maxRequests: 12,
      getAvailableTiles: availSpy,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 30));

    // The multi-tile priority pass was a SINGLE batch of all 30 tiles, not
    // three 12-tile batches.
    const multiCalls = batchSpy.mock.calls.filter(
      (c) => (c[0] as TileId[]).length > 1,
    );
    expect(multiCalls.length).toBe(1);
    expect((multiCalls[0][0] as TileId[]).length).toBe(30);
    tileset.finalize();
  });

  it('falls back to per-tile getTileData when no batch callback is set', async () => {
    const ids: TileId[] = [0, 1, 2].map((x) => ({ z: 6, x, y: 0, t: 0 }));
    const availSpy = vi.fn(async (_b: BoundingBox, z: number) =>
      ids.filter((i) => i.z === z),
    );
    const singleSpy = vi.fn(async (id: TileId) => fakeTile(id));

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: availSpy,
      getTileData: singleSpy,
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 20));

    expect(singleSpy.mock.calls.length).toBe(ids.length);
    tileset.finalize();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CO-7 — the adaptive coalesce gap `G ← L̂·θ̂`
// ───────────────────────────────────────────────────────────────────────────

/** One synthetic blob's placement: which pack, and the pad before it. */
interface BlobPlacement {
  pack: number;
  padBefore: number;
}

interface GapDataset {
  ds: InMemoryPackedDataset;
  ids: TileId[];
  blobLength: number;
  packPaths: string[];
}

/**
 * A packed dataset whose blob spacing is dictated by the test.
 *
 * The blob itself is the committed golden fixture's real (zstd-framed,
 * CRC-tagged) tile payload, copied N times, so every member of a coalesced
 * range still has to survive the production slice-and-verify path. Only the
 * SPACING is synthetic — that is the variable the fuse rule reads.
 */
function gapDataset(opts: {
  url: string;
  blobs: BlobPlacement[];
  blobOrdering?: string;
  buildAssumedGapBytes?: number;
}): GapDataset {
  const src = packedFromGolden({ manifestUrl: 'mem://gap-src/manifest.json' });
  const srcManifest = JSON.parse(
    new TextDecoder().decode(src.objects.get('manifest.json')!),
  );
  const e = decodeDirectory(
    src.objects.get(srcManifest.directory.key)!.subarray(OBJECT_MAGIC_LEN),
  )[0];
  const srcPack = src.objects.get(srcManifest.packs[e.packId].key)!;
  const blob = srcPack.subarray(e.offset, e.offset + e.length);

  // Lay each pack out: cursor += padBefore, blob, repeat.
  const packCount = Math.max(...opts.blobs.map((b) => b.pack)) + 1;
  const cursors = new Array<number>(packCount).fill(0);
  const placed = opts.blobs.map((b) => {
    const offset = cursors[b.pack] + b.padBefore;
    cursors[b.pack] = offset + blob.length;
    return { pack: b.pack, offset };
  });
  const packs = cursors.map((size) => new Uint8Array(size));
  for (const p of placed) packs[p.pack].set(blob, p.offset);

  const entries = placed.map((p, i) => ({
    zoom: e.zoom,
    x: e.x,
    y: e.y,
    timeStart: i,
    timeEnd: i,
    packId: p.pack,
    offset: p.offset,
    length: blob.length,
    uncompressedSize: e.uncompressedSize,
    featureCount: e.featureCount,
    hilbert: i,
    crc32c: crc32c(blob),
  }));
  const dirObject = directoryObject(encodeDirectory(entries));

  const objects = new Map<string, Uint8Array>();
  objects.set('index/dir.sttd', dirObject);
  const packPaths = packs.map((_, i) => `packs/p${i}.sttp`);
  packs.forEach((bytes, i) => objects.set(packPaths[i], bytes));
  // The build-assumed gap goes exactly where the WRITER puts it: inside the
  // verbatim metadata block as `ordering_workload.coalesce_gap_bytes`
  // (snake_case), written by `PackWriter::finalize` only when the blob ordering
  // was resolved by simulation. There is no top-level manifest key for it, and
  // a fixture that invented one would prove nothing about real archives.
  const metadata = { ...srcManifest.metadata };
  if (opts.buildAssumedGapBytes !== undefined) {
    metadata.ordering_workload = {
      scrub: 3,
      pan: 2,
      playback: 1,
      playback_window_buckets: 8,
      runway_multiplier: 4,
      coalesce_gap_bytes: opts.buildAssumedGapBytes,
    };
  }
  const manifest: Record<string, unknown> = {
    format: 'stt-packed',
    formatVersion: 3,
    variants: [{ id: 0, kind: 'raw' }],
    compression: srcManifest.compression,
    directory: {
      key: 'index/dir.sttd',
      length: dirObject.length,
      directoryVersion: 6,
    },
    packs: packs.map((bytes, i) => ({
      key: packPaths[i],
      length: bytes.length,
    })),
    metadata,
  };
  // `blobOrdering` is deliberately OMITTED when undefined — that is what a
  // pre-2026-07 archive looks like.
  if (opts.blobOrdering !== undefined) {
    manifest.blobOrdering = opts.blobOrdering;
  }
  objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );

  return {
    ds: { objects, manifestUrl: opts.url },
    ids: entries.map((entry) => ({
      z: entry.zoom,
      x: entry.x,
      y: entry.y,
      t: entry.timeStart,
    })),
    blobLength: blob.length,
    packPaths,
  };
}

/** Open an archive over a synthetic dataset, logging every range request. */
function openWithLog(
  gap: GapDataset,
  options: { coalesceGapBytes?: number } = {},
): { archive: STTArchive; log: PackedFetchLog } {
  const log: PackedFetchLog = { paths: [], ranges: [] };
  const archive = new STTArchive({
    url: gap.ds.manifestUrl,
    fetch: packedFetch(gap.ds, log),
    ...options,
  });
  return { archive, log };
}

/** The range requests issued so far, as comparable `path bytes=a-b` strings. */
function rangePlan(log: PackedFetchLog): string[] {
  return log.ranges.map((r) => `${r.path} ${r.range}`);
}

/**
 * Freeze the clock the estimators sample against.
 *
 * With `performance.now()` pinned, every request's TTFB is exactly 0 ms and
 * every busy window is exactly 0 ms wide — so `L̂ = 0`, `θ̂ = windowBytes`, and
 * the fitted gap is exactly `clamp(0, …) = MIN_ADAPTIVE_COALESCE_GAP`. That
 * makes the WARM behavior a fixed number instead of a race against the host's
 * real timer resolution, which is what lets the determinism case below assert
 * byte-identical request plans.
 */
function freezeClock(): void {
  vi.spyOn(performance, 'now').mockReturnValue(0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adaptiveCoalesceGapBytes — the fitted constant (CO-7)', () => {
  /** The gap every simulated layout is priced at today (2 MiB, both sides). */
  const BUILD_GAP = DEFAULT_RANGE_COALESCE_GAP;

  it('prices a warm edge session at L̂·θ̂, which the declared band then catches', () => {
    // §6.2's warm-edge profile: L̂ ≈ 20 ms, θ̂ ≈ 12.5 KB/ms.
    const raw = 20 * 12_500;
    expect(raw).toBe(250_000); // the plan's "G ≈ 250 KB"
    // …which sits under BOTH floors, so the band decides. Against a 2 MiB
    // build assumption the binding floor is `2 MiB / 2`, NOT the reader's
    // global 256 KiB floor — the declared band is the tighter of the two.
    expect(raw).toBeLessThan(MIN_ADAPTIVE_COALESCE_GAP);
    expect(adaptiveCoalesceGapBytes(20, 12_500, BUILD_GAP)).toBe(1_048_576);
    // A layout priced at 512 KiB declares a WIDER-DOWN band, and the global
    // floor binds there instead.
    expect(adaptiveCoalesceGapBytes(20, 12_500, 512 * 1024)).toBe(
      MIN_ADAPTIVE_COALESCE_GAP,
    );
  });

  it('returns the raw product inside the band', () => {
    expect(adaptiveCoalesceGapBytes(100, 12_500, BUILD_GAP)).toBe(1_250_000);
    expect(1_250_000).toBeGreaterThan(BUILD_GAP / 2);
    expect(1_250_000).toBeLessThan(MAX_ADAPTIVE_COALESCE_GAP);
  });

  it('a cold-origin round trip buys MORE over-fetch than the 2 MiB default', () => {
    // ≈200 ms origin at the same rate ⇒ 2.5 MB — above the historic constant,
    // still inside the declared band (2 MiB × 2 = 4 MiB).
    expect(adaptiveCoalesceGapBytes(200, 12_500, BUILD_GAP)).toBe(2_500_000);
    expect(2_500_000).toBeGreaterThan(DEFAULT_RANGE_COALESCE_GAP);
  });

  it('clamps a fat, slow link to the band ceiling', () => {
    // 200 ms × 50 KB/ms = 10 MB of "request value" — the ceiling is what stops
    // one estimate turning a viewport into a 10 MB over-fetch.
    expect(200 * 50_000).toBe(10_000_000);
    expect(adaptiveCoalesceGapBytes(200, 50_000, BUILD_GAP)).toBe(
      MAX_ADAPTIVE_COALESCE_GAP,
    );
    // A narrow build assumption caps it far below the reader's own ceiling:
    // 512 KiB × 2 = 1 MiB, and that is the whole point of the band.
    expect(adaptiveCoalesceGapBytes(200, 50_000, 512 * 1024)).toBe(1_048_576);
  });

  it('NO declared build gap ⇒ the incumbent 2 MiB constant, at every reading', () => {
    // The co-versioning guard, stated as a number: this is the shape of every
    // archive on the fleet today (nothing emits `ordering_workload` yet), and
    // no pair of estimator readings may move it off 2 MiB.
    for (const buildGap of [null, undefined, 0, -1, NaN, Infinity]) {
      expect(adaptiveCoalesceGapBytes(20, 12_500, buildGap)).toBe(2_097_152);
      expect(adaptiveCoalesceGapBytes(200, 12_500, buildGap)).toBe(2_097_152);
      expect(adaptiveCoalesceGapBytes(200, 50_000, buildGap)).toBe(2_097_152);
      expect(adaptiveCoalesceGapBytes(1, 1, buildGap)).toBe(2_097_152);
    }
    expect(DEFAULT_RANGE_COALESCE_GAP).toBe(2_097_152);
  });

  it('a build gap outside the reader band (empty intersection) ⇒ no adaptation', () => {
    // 64 MiB / 2 = 32 MiB floor vs a 4 MiB ceiling: the reader will not adapt
    // toward an assumption it is unwilling to honor.
    expect(adaptiveCoalesceGapBytes(200, 50_000, 64 * 1024 * 1024)).toBe(
      DEFAULT_RANGE_COALESCE_GAP,
    );
    // 64 KiB × 2 = 128 KiB ceiling vs a 256 KiB floor — same verdict below.
    expect(adaptiveCoalesceGapBytes(20, 12_500, 64 * 1024)).toBe(
      DEFAULT_RANGE_COALESCE_GAP,
    );
  });

  it('either estimator cold ⇒ the incumbent 2 MiB constant, never a guess', () => {
    expect(adaptiveCoalesceGapBytes(null, 12_500, BUILD_GAP)).toBe(
      DEFAULT_RANGE_COALESCE_GAP,
    );
    expect(adaptiveCoalesceGapBytes(20, null, BUILD_GAP)).toBe(
      DEFAULT_RANGE_COALESCE_GAP,
    );
    expect(adaptiveCoalesceGapBytes(null, null, BUILD_GAP)).toBe(
      DEFAULT_RANGE_COALESCE_GAP,
    );
    expect(adaptiveCoalesceGapBytes(undefined, undefined, BUILD_GAP)).toBe(
      DEFAULT_RANGE_COALESCE_GAP,
    );
  });

  it('treats a nonsense reading as unmeasured, not as an extreme', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      expect(adaptiveCoalesceGapBytes(bad, 12_500, BUILD_GAP)).toBe(
        DEFAULT_RANGE_COALESCE_GAP,
      );
      expect(adaptiveCoalesceGapBytes(20, bad, BUILD_GAP)).toBe(
        DEFAULT_RANGE_COALESCE_GAP,
      );
    }
  });

  it('property: non-decreasing in latency and in throughput, always in band', () => {
    const rates = [0, 1, 100, 5_000, 12_500, 60_000, 1e6];
    const latencies = [0, 1, 5, 20, 60, 200, 1000];
    for (const buildGap of [512 * 1024, BUILD_GAP, 4 * 1024 * 1024]) {
      const band = adaptiveCoalesceGapBand(buildGap)!;
      expect(band).not.toBeNull();
      for (const rate of rates) {
        let previous = -1;
        for (const latency of latencies) {
          const g = adaptiveCoalesceGapBytes(latency, rate, buildGap);
          expect(g).toBeGreaterThanOrEqual(band.floorBytes);
          expect(g).toBeLessThanOrEqual(band.ceilingBytes);
          expect(g).toBeGreaterThanOrEqual(MIN_ADAPTIVE_COALESCE_GAP);
          expect(g).toBeLessThanOrEqual(MAX_ADAPTIVE_COALESCE_GAP);
          expect(g).toBeGreaterThanOrEqual(previous);
          previous = g;
        }
      }
      for (const latency of latencies) {
        let previous = -1;
        for (const rate of rates) {
          const g = adaptiveCoalesceGapBytes(latency, rate, buildGap);
          expect(g).toBeGreaterThanOrEqual(previous);
          previous = g;
        }
      }
    }
  });

  it('property: the fitted gap never leaves ×2 of the layout it was priced at', () => {
    // The band IS the co-versioning contract, so state it as an inequality
    // over the whole estimator space rather than as a clamp constant.
    for (const buildGap of [
      512 * 1024,
      1024 * 1024,
      DEFAULT_RANGE_COALESCE_GAP,
      3 * 1024 * 1024,
    ]) {
      for (const latency of [0, 1, 20, 200, 5_000]) {
        for (const rate of [0, 1, 12_500, 1e6]) {
          const g = adaptiveCoalesceGapBytes(latency, rate, buildGap);
          expect(g).toBeGreaterThanOrEqual(buildGap / 2);
          expect(g).toBeLessThanOrEqual(buildGap * 2);
        }
      }
    }
  });
});

describe('STTArchive.effectiveCoalesceGap — precedence and fallbacks (CO-7)', () => {
  it('is the 2 MiB constant while the estimators are cold', async () => {
    const gap = gapDataset({
      url: 'mem://gap-cold/manifest.json',
      blobs: [{ pack: 0, padBefore: 0 }],
      blobOrdering: 'spatial',
      buildAssumedGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    const { archive } = openWithLog(gap);
    await archive.getIndex();
    const estimate = archive.getCoalesceGapEstimate();
    // A co-versioned archive whose estimators have simply not fired yet: the
    // gate passed, so `cold` is reachable and is what is reported.
    expect(estimate.source).toBe('cold');
    expect(estimate.gapBytes).toBe(DEFAULT_RANGE_COALESCE_GAP);
    expect(estimate.latencyMs).toBeNull();
    expect(estimate.bytesPerMs).toBeNull();
    expect(archive.effectiveCoalesceGap()).toBe(DEFAULT_RANGE_COALESCE_GAP);
  });

  it('fits G from L̂·θ̂ once BOTH estimators have a sample AND a build gap is declared', async () => {
    freezeClock();
    const gap = gapDataset({
      url: 'mem://gap-warm/manifest.json',
      blobs: [
        { pack: 0, padBefore: 0 },
        { pack: 0, padBefore: 0 },
      ],
      blobOrdering: 'spatial',
      buildAssumedGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    const { archive } = openWithLog(gap);
    await archive.getTiles(gap.ids);
    const estimate = archive.getCoalesceGapEstimate();
    expect(estimate.source).toBe('adaptive');
    expect(estimate.latencyMs).toBe(0); // frozen clock ⇒ 0 ms TTFB, measured
    expect(estimate.bytesPerMs).not.toBeNull();
    // clamp(0 × θ̂) into [2 MiB / 2, 2 MiB × 2] = the band floor, 1 MiB — a
    // NUMBER, not whichever constant the implementation happened to reach for.
    expect(estimate.gapBytes).toBe(1_048_576);
    expect(estimate.buildAssumedGapBytes).toBe(2_097_152);
    expect(archive.getLatencyEstimateMs()).toBe(0);
  });

  it('an explicit coalesceGapBytes pins the gap and disables adaptation', async () => {
    freezeClock();
    const gap = gapDataset({
      url: 'mem://gap-pinned/manifest.json',
      blobs: [
        { pack: 0, padBefore: 0 },
        { pack: 0, padBefore: 0 },
      ],
      blobOrdering: 'spatial',
      buildAssumedGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    const { archive } = openWithLog(gap, { coalesceGapBytes: 777_000 });
    await archive.getTiles(gap.ids);
    // Warm estimators, declared build gap — and still pinned.
    expect(archive.getLatencyEstimateMs()).not.toBeNull();
    const estimate = archive.getCoalesceGapEstimate();
    expect(estimate.source).toBe('pinned');
    expect(estimate.gapBytes).toBe(777_000);
  });

  it('reports the estimator readings even where it does not use them', async () => {
    freezeClock();
    const gap = gapDataset({
      url: 'mem://gap-pinned-report/manifest.json',
      blobs: [
        { pack: 0, padBefore: 0 },
        { pack: 0, padBefore: 0 },
      ],
      blobOrdering: 'spatial',
      buildAssumedGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    const { archive } = openWithLog(gap, { coalesceGapBytes: 777_000 });
    await archive.getTiles(gap.ids);
    const estimate = archive.getCoalesceGapEstimate();
    // `source` says the readings were not consulted; the readings themselves
    // are still surfaced, so `null` keeps meaning "cold" and nothing else.
    expect(estimate.source).toBe('pinned');
    expect(estimate.latencyMs).toBe(0);
    expect(estimate.bytesPerMs).toBeGreaterThan(0);
  });
});

describe('the co-versioning guard: only a DECLARED build gap licenses adaptation (CO-7 / D6)', () => {
  /**
   * Every string the writer can put in `blobOrdering`
   * (`stt_core::curve::BlobOrdering::as_str`), plus two that it cannot.
   *
   * `measured` is a CLI SELECTION MODE — and the default one — not an ordering:
   * `PackWriter::finalize` records the WINNER, so a `--blob-ordering measured`
   * build (whose layout really was fitted against the simulator's 2 MiB gap)
   * publishes as `"spatial"` or `"time-major"`, indistinguishable by string
   * from a build that never simulated anything. `temporal` is likewise a name
   * no Rust variant serializes to. That is why nothing below is allowed to
   * depend on which string is present.
   */
  const ORDERING_STRINGS = [
    'spatial', // BlobOrdering::SpatialMajor — the fleet's most common
    'time-major', // BlobOrdering::TimeMajor
    'hilbert3', // BlobOrdering::Hilbert3
    'morton3', // BlobOrdering::Morton3
    'measured', // NOT a writer output: a selection mode
    'temporal', // NOT a writer output: no variant serializes to it
    'something-new', // a future/unknown value
  ];

  /** Warm both estimators, then read the gap the archive settled on. */
  async function warmThenRead(
    blobOrdering: string | undefined,
    buildAssumedGapBytes?: number,
  ) {
    freezeClock();
    const gap = gapDataset({
      url: `mem://gap-order-${blobOrdering ?? 'absent'}-${buildAssumedGapBytes ?? 'nogap'}/manifest.json`,
      blobs: [
        { pack: 0, padBefore: 0 },
        { pack: 0, padBefore: 0 },
      ],
      blobOrdering,
      buildAssumedGapBytes,
    });
    const { archive } = openWithLog(gap);
    await archive.getTiles(gap.ids);
    expect(archive.getLatencyEstimateMs()).not.toBeNull();
    return archive.getCoalesceGapEstimate();
  }

  it.each([...ORDERING_STRINGS, undefined])(
    'blobOrdering %s + NO declared build gap ⇒ adaptation OFF, exactly 2 MiB',
    async (ordering) => {
      // This is the ENTIRE published fleet today: nothing emits
      // `ordering_workload`, and a `measured` build hides behind an ordinary
      // ordering string. Hazard D6 is closed by refusing to adapt at all here.
      const estimate = await warmThenRead(ordering);
      expect(estimate.gapBytes).toBe(2_097_152);
      expect(estimate.source).toBe('no-build-gap');
      expect(estimate.buildAssumedGapBytes).toBeNull();
      // The estimators ARE warm — the gate, not coldness, is what held the gap.
      expect(estimate.latencyMs).not.toBeNull();
      expect(estimate.bytesPerMs).not.toBeNull();
    },
  );

  it.each(ORDERING_STRINGS)(
    'blobOrdering %s + a declared build gap ⇒ adaptation ON, same number for every string',
    async (ordering) => {
      // The ordering string is not load-bearing in EITHER direction: with the
      // co-versioning field present, every one of these adapts, and to the
      // identical gap. A string allow-list cannot express this rule because it
      // cannot see which layouts were fitted.
      const estimate = await warmThenRead(ordering, 2_097_152);
      expect(estimate.gapBytes).toBe(1_048_576); // the 2 MiB / 2 band floor
      expect(estimate.source).toBe('adaptive');
      expect(estimate.buildAssumedGapBytes).toBe(2_097_152);
    },
  );

  it('the gap tracks the DECLARED band, not the ordering string', async () => {
    // Same ordering, three different build assumptions, three different gaps —
    // the band is the mechanism, so the numbers must move with it.
    expect((await warmThenRead('spatial', 2_097_152)).gapBytes).toBe(1_048_576);
    expect((await warmThenRead('spatial', 1_048_576)).gapBytes).toBe(524_288);
    expect((await warmThenRead('spatial', 4_194_304)).gapBytes).toBe(2_097_152);
  });

  it('a build gap the reader will not honor ⇒ adaptation OFF', async () => {
    // 64 MiB: the declared band [32 MiB, 128 MiB] and the reader's own
    // [256 KiB, 4 MiB] do not intersect, so there is no gap that is both
    // faithful to the layout and safe to fetch. Fall back, do not split the
    // difference.
    const estimate = await warmThenRead('spatial', 64 * 1024 * 1024);
    expect(estimate.gapBytes).toBe(2_097_152);
    expect(estimate.source).toBe('no-build-gap');
    expect(estimate.buildAssumedGapBytes).toBe(67_108_864);
  });

  it('reports drift from the declared build gap without acting on it', async () => {
    const estimate = await warmThenRead('spatial', 2_097_152);
    expect(estimate.buildAssumedGapBytes).toBe(2_097_152);
    // The session fitted a different gap than the layout was priced at. That
    // is REPORTED (order-audit's input), not corrected here — and it is
    // bounded: drift can never exceed ×2 of the build assumption.
    expect(estimate.gapBytes).toBe(1_048_576);
    expect(estimate.driftsFromBuildAssumption).toBe(true);
    expect(estimate.gapBytes).toBeGreaterThanOrEqual(2_097_152 / 2);
    expect(estimate.gapBytes).toBeLessThanOrEqual(2_097_152 * 2);
  });

  it('reads the gap from where the WRITER writes it, not from a top-level key', async () => {
    // `PackWriter::finalize` folds it into the verbatim metadata block as
    // `ordering_workload.coalesce_gap_bytes`. A manifest carrying the value
    // anywhere else declares nothing, and must not unlock adaptation.
    freezeClock();
    const gap = gapDataset({
      url: 'mem://gap-wrong-key/manifest.json',
      blobs: [
        { pack: 0, padBefore: 0 },
        { pack: 0, padBefore: 0 },
      ],
      blobOrdering: 'spatial',
    });
    const manifestBytes = gap.ds.objects.get('manifest.json')!;
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    expect(manifest.metadata.ordering_workload).toBeUndefined();
    manifest.coalesceGapBytes = 2_097_152; // a key no writer emits
    manifest.metadata.coalesce_gap_bytes = 2_097_152; // nor this one
    gap.ds.objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );

    const { archive } = openWithLog(gap);
    await archive.getTiles(gap.ids);
    const estimate = archive.getCoalesceGapEstimate();
    expect(estimate.buildAssumedGapBytes).toBeNull();
    expect(estimate.source).toBe('no-build-gap');
    expect(estimate.gapBytes).toBe(2_097_152);
  });
});

describe('legacy guard: an un-adapted session plans byte-identical requests (CO-7)', () => {
  /**
   * Six ~830 B blobs 512 KiB apart. Under the raw 2 MiB gap these all fused;
   * since the amplification bound (audit C3: a fuse may bridge at most
   * `4 × useful + 256 KiB`, ≈ 260 KB for blobs this small) they do NOT, and
   * — the point of this block — the adaptive and pinned readers agree on
   * that plan byte-for-byte.
   */
  const SCRIPT_BLOBS: BlobPlacement[] = [
    { pack: 0, padBefore: 0 },
    { pack: 0, padBefore: 512 * 1024 },
    { pack: 0, padBefore: 512 * 1024 },
    { pack: 0, padBefore: 512 * 1024 },
    { pack: 0, padBefore: 512 * 1024 },
    { pack: 0, padBefore: 512 * 1024 },
  ];

  /** The scripted sequence: three multi-tile batches, then a re-request. */
  async function runScript(archive: STTArchive, ids: TileId[]): Promise<void> {
    await archive.getTiles([ids[0], ids[1]]);
    await archive.getTiles([ids[2], ids[3]]);
    await archive.getTiles([ids[4], ids[5]]);
    await archive.getTiles([ids[0], ids[3], ids[5]]); // all cached
  }

  /** Wider spacing (1.5 MB): outside the amplification bound at any G. */
  const WIDE_BLOBS: BlobPlacement[] = SCRIPT_BLOBS.map((b, i) =>
    i === 0 ? b : { pack: 0, padBefore: 1_500_000 },
  );

  it('a FLEET-SHAPED archive issues exactly the ranges a 2 MiB-pinned reader would', async () => {
    freezeClock();
    // `blobOrdering: 'spatial'` and no `ordering_workload` — the shape of every
    // archive published to date, INCLUDING the ones whose ordering really was
    // resolved by simulation. The guard holds the gap at the constant for the
    // WHOLE session, warm estimators notwithstanding.
    const adaptive = gapDataset({
      url: 'mem://gap-legacy-a/manifest.json',
      blobs: SCRIPT_BLOBS,
      blobOrdering: 'spatial',
    });
    const reference = gapDataset({
      url: 'mem://gap-legacy-b/manifest.json',
      blobs: SCRIPT_BLOBS,
      blobOrdering: 'spatial',
    });
    const a = openWithLog(adaptive);
    const b = openWithLog(reference, {
      coalesceGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    await runScript(a.archive, adaptive.ids);
    await runScript(b.archive, reference.ids);

    // Same object keys are content-addressed from identical bytes, so the
    // plans are literally comparable string-for-string.
    expect(rangePlan(a.log)).toEqual(rangePlan(b.log));
    expect(a.archive.getCoalesceGapEstimate().source).toBe('no-build-gap');
    // …and a 512 KiB pad between ~830 B tiles is NOT bridged by either reader
    // (re-blessed for audit C3: this used to pin 3 fused requests, i.e. a
    // ~600× over-fetch per batch): 2 tiles per batch, 1 request each.
    expect(a.log.ranges.length).toBe(6);
  });

  it('a COLD adaptive archive plans its first batch exactly as today', async () => {
    freezeClock();
    const adaptive = gapDataset({
      url: 'mem://gap-cold-plan-a/manifest.json',
      blobs: SCRIPT_BLOBS,
      blobOrdering: 'spatial',
      buildAssumedGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    const reference = gapDataset({
      url: 'mem://gap-cold-plan-b/manifest.json',
      blobs: SCRIPT_BLOBS,
    });
    const a = openWithLog(adaptive);
    const b = openWithLog(reference, {
      coalesceGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    // First batch only: nothing has been measured yet, so the cold reader and
    // the pinned reader plan identically — and (audit C3) neither bridges a
    // 512 KiB pad between ~830 B tiles: 2 requests, not 1 fused over-fetch.
    await a.archive.getTiles([adaptive.ids[0], adaptive.ids[1]]);
    await b.archive.getTiles([reference.ids[0], reference.ids[1]]);
    expect(rangePlan(a.log)).toEqual(rangePlan(b.log));
    expect(a.log.ranges.length).toBe(2);
  });

  it('once warm, the fitted gap actually changes the plan (the item is not a no-op)', async () => {
    freezeClock();
    const gap = gapDataset({
      url: 'mem://gap-warm-plan/manifest.json',
      blobs: WIDE_BLOBS,
      blobOrdering: 'spatial',
      buildAssumedGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    const { archive, log } = openWithLog(gap);
    await archive.getTiles([gap.ids[0], gap.ids[1]]);
    // Re-blessed for audit C3: a 1.5 MB pad between ~830 B tiles is outside
    // the amplification bound at ANY G, so it is 2 requests cold as well as
    // warm — the fitted gap can only ever matter for tiles large enough that
    // bridging is not mostly over-fetch.
    expect(log.ranges.length).toBe(2);

    const warmFrom = log.ranges.length;
    await archive.getTiles([gap.ids[2], gap.ids[3]]);
    expect(log.ranges.length - warmFrom).toBe(2);
    // Warm ⇒ G = 1 MiB (the declared band's floor). Where it DOES bind — MB-
    // scale tiles, whose `4 × useful` clears the bound — the plan changes
    // with it: 1 MB tiles 1.5 MB apart fuse at the cold 2 MiB and split at
    // the fitted 1 MiB. The reader stopped paying 1.5 MB of over-fetch for a
    // round trip this link says is worth ~nothing, while staying inside ×2
    // of what the layout was priced at.
    const estimate = archive.getCoalesceGapEstimate();
    expect(estimate.source).toBe('adaptive');
    expect(estimate.gapBytes).toBe(1_048_576);
    const big = [
      { packId: 0, offset: 8, length: 1_000_000 },
      { packId: 0, offset: 8 + 1_000_000 + 1_500_000, length: 1_000_000 },
    ];
    const extent = (e: (typeof big)[number]) => e;
    expect(
      planCoalescedRanges(big, extent, DEFAULT_RANGE_COALESCE_GAP).length,
    ).toBe(1);
    expect(planCoalescedRanges(big, extent, estimate.gapBytes).length).toBe(2);
  });
});

describe('the fuse rule under a moving G (CO-7 properties)', () => {
  /** Increasing gap ladder, spanning the whole adaptive band and beyond. */
  const LADDER = [
    0,
    64 * 1024,
    MIN_ADAPTIVE_COALESCE_GAP,
    1024 * 1024,
    DEFAULT_RANGE_COALESCE_GAP,
    MAX_ADAPTIVE_COALESCE_GAP,
    Number.MAX_SAFE_INTEGER,
  ];

  const SPREAD: BlobPlacement[] = [
    { pack: 0, padBefore: 0 },
    { pack: 0, padBefore: 0 },
    { pack: 0, padBefore: 100_000 },
    { pack: 0, padBefore: 300_000 },
    { pack: 0, padBefore: 900_000 },
    { pack: 0, padBefore: 1_500_000 },
  ];

  it('request count is monotone non-increasing in G, and never below 1', async () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const coalesceGapBytes of LADDER) {
      const gap = gapDataset({
        url: `mem://gap-mono-${coalesceGapBytes}/manifest.json`,
        blobs: SPREAD,
      });
      const { archive, log } = openWithLog(gap, { coalesceGapBytes });
      const tiles = await archive.getTiles(gap.ids);
      expect(tiles.every((t) => t !== null)).toBe(true);
      expect(log.ranges.length).toBeGreaterThanOrEqual(1);
      expect(log.ranges.length).toBeLessThanOrEqual(previous);
      previous = log.ranges.length;
    }
    // The ladder actually exercised a change of plan (otherwise the property
    // would hold vacuously).
    expect(previous).toBeLessThan(SPREAD.length);
  });

  it('no G bridges an object boundary — coalescing stays per-pack', async () => {
    // Two packs, blobs back to back inside each: byte-space says "fuse", the
    // object boundary says "you may not".
    const gap = gapDataset({
      url: 'mem://gap-boundary/manifest.json',
      blobs: [
        { pack: 0, padBefore: 0 },
        { pack: 0, padBefore: 0 },
        // A 16-byte lead-in only so the two packs are not byte-identical (the
        // reader rejects a manifest with a duplicate content-addressed key).
        { pack: 1, padBefore: 16 },
        { pack: 1, padBefore: 0 },
      ],
    });
    const { archive, log } = openWithLog(gap, {
      coalesceGapBytes: Number.MAX_SAFE_INTEGER,
    });
    const tiles = await archive.getTiles(gap.ids);
    expect(tiles.every((t) => t !== null)).toBe(true);
    expect(log.ranges.length).toBe(2);
    expect(new Set(log.ranges.map((r) => r.path)).size).toBe(2);
  });

  it('every member of a fused buffer still decodes, at every G', async () => {
    for (const coalesceGapBytes of LADDER) {
      const gap = gapDataset({
        url: `mem://gap-members-${coalesceGapBytes}/manifest.json`,
        blobs: SPREAD,
      });
      const { archive } = openWithLog(gap, { coalesceGapBytes });
      const tiles = await archive.getTiles(gap.ids);
      expect(tiles.length).toBe(gap.ids.length);
      for (const tile of tiles) {
        expect(tile).not.toBeNull();
        expect(tile!.layers[0].features.featureCount).toBeGreaterThan(0);
      }
    }
  });
});

describe('determinism: a fixed sample sequence is a fixed request plan (CO-7)', () => {
  /** Pads straddling the 1 MiB band floor, so warm and cold plans differ. */
  const BLOBS: BlobPlacement[] = [
    { pack: 0, padBefore: 0 },
    { pack: 0, padBefore: 400_000 },
    { pack: 0, padBefore: 1_200_000 },
    { pack: 0, padBefore: 1_400_000 },
    { pack: 0, padBefore: 1_500_000 },
    { pack: 0, padBefore: 1_600_000 },
  ];

  async function planFor(url: string): Promise<string[]> {
    const gap = gapDataset({
      url,
      blobs: BLOBS,
      blobOrdering: 'spatial',
      buildAssumedGapBytes: DEFAULT_RANGE_COALESCE_GAP,
    });
    const { archive, log } = openWithLog(gap);
    await archive.getTiles([gap.ids[0], gap.ids[1]]);
    await archive.getTiles([gap.ids[2], gap.ids[3]]);
    await archive.getTiles([gap.ids[4], gap.ids[5]]);
    return rangePlan(log);
  }

  it('two runs over the same scripted sequence issue identical ranges', async () => {
    freezeClock();
    const first = await planFor('mem://gap-det-1/manifest.json');
    const second = await planFor('mem://gap-det-2/manifest.json');
    const third = await planFor('mem://gap-det-3/manifest.json');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // The plan is non-trivial: every pad here is outside the amplification
    // bound for ~830 B tiles (audit C3), so each 2-tile batch is 2 requests.
    expect(first.length).toBeGreaterThan(3);
  });
});
