/**
 * RecordedSource — a deterministic fake archive + link for the loading-QoE
 * gate and the loader-invariant suite (tile-loading audit 2026-08, G1 / G3).
 *
 * WHY a fake and not `packedFromGolden` + `STTArchive`: the gate's job is to
 * drive the REAL `SpatioTemporalTileset` and the REAL `PlaybackGovernor` over
 * archive SHAPES the golden cannot express (3,000 hourly buckets × 40 tiles,
 * 12,000 overview tiles) under a link whose every byte and millisecond is
 * scripted on vitest fake timers. The reader's transport is pinned by the
 * packed-fixture suites; here it is replaced by a synthetic directory and a
 * modelled link so the only thing under test is loader + governor policy.
 *
 * Everything the tileset can ask of an archive is answered from the shape:
 * `getAvailableTiles` enumerates the directory (bounds are ignored — one
 * viewport), `getTileByteSize` prices a tile in directory bytes, and
 * `getTileDataBatch` moves those bytes across the link and delivers sized
 * decoded tiles. Every request is recorded per key, so requests, bytes
 * requested, bytes useful and refetches are measured HERE until
 * `getCacheStats()` carries them (G2, in flight — see the report).
 *
 * The link is 40 ms to first byte, then processor-sharing at the modelled
 * rate across every in-flight batch: a 1 MB lookahead slice and a 4 KB
 * need-now batch share the pipe, which is what HTTP/2 multiplexing does and
 * what a FIFO model would misreport as a stall. An optional burst schedule
 * drops the rate deterministically for part of every period. The throughput
 * estimator the governor and tileset see is an EWMA over completed
 * transfers — `null` until the first one, exactly the archive EWMA's
 * contract — so it TRACKS the link instead of knowing it.
 *
 * DETERMINISM: no `Date.now` / `Math.random` of our own; the tileset and the
 * governor capture `Date.now` / `performance.now` at construction, so callers
 * MUST install fake timers ({@link installLoaderFakeTimers}) BEFORE building
 * a session.
 */

import { vi } from 'vitest';
import type { BoundingBox, Tile, TileId } from '../../src/types';
import {
  SpatioTemporalTileset,
  type BufferedRunway,
  type OverviewPreloadResult,
  type SpatioTemporalTilesetOptions,
  type TileBatchHooks,
  type TilesetCacheStats,
} from '../../src/spatiotemporal-tileset';
import { TimeController } from '../../../playback/src/time-controller';
import {
  PlaybackGovernor,
  type BufferSource,
  type PlaybackGovernorOptions,
  type PlaybackGovernorState,
  type PlaybackQoeStats,
} from '../../../playback/src/playback-governor';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/**
 * `playback-governor.ts` `TICK_PROBE_INTERVAL_MS` (not exported): the wall
 * cadence at which the governor re-probes the buffered frontier, hence the
 * overrun window its per-tick clamp is documented to allow.
 */
export const TICK_PROBE_INTERVAL_MS = 200;

/** One overview (storyboard) zoom level of a shape. */
export interface OverviewLevel {
  readonly zoom: number;
  /** Tiles per temporal bucket at this zoom. */
  readonly tilesPerBucket: number;
  /** Directory (compressed) bytes per tile. */
  readonly bytesPerTile: number;
}

/** A synthetic archive: one viewport, `nBuckets` buckets, N tiles per bucket. */
export interface ArchiveShape {
  readonly name: string;
  readonly bucketMs: number;
  readonly nBuckets: number;
  /** The zoom the viewport selects at. */
  readonly primaryZoom: number;
  /** Archive min zoom (default: `primaryZoom`; set 0 to give the overview tier something). */
  readonly minZoom?: number;
  /** Primary-zoom tiles per temporal bucket (all inside the one viewport). */
  readonly tilesPerBucket: number;
  /** Directory (compressed) bytes per primary-zoom tile. */
  readonly bytesPerTile: number;
  /** Decoded ÷ directory bytes; the decoded tile is exactly this × directory. */
  readonly decodedExpansion: number;
  readonly overview?: readonly OverviewLevel[];
}

/** Deterministic burstiness: each period, the rate is `slowFactor ×` from `slowFromMs` to the end. */
export interface LinkSchedule {
  readonly periodMs: number;
  readonly slowFromMs: number;
  readonly slowFactor: number;
}

/** Bytes per wall-ms and the round trip charged before the first byte. */
export interface LinkModel {
  readonly bytesPerMs: number;
  readonly latencyMs: number;
  readonly schedule?: LinkSchedule;
}

/** 4 MB/s, 40 ms RTT — the audit's link model. */
export const LINK_4MBPS: LinkModel = { bytesPerMs: 4000, latencyMs: 40 };

/**
 * The three §6 Wave-5 shapes. S is the small-archive control; L is the
 * earthquakes / hurricanes shape (hourly buckets over years, thousands of
 * tiny z0–z1 tiles the storyboard would pin — A1); F is the nyc-taxi-paths
 * shape (fine buckets at a speed whose `speed × 5 s` floor is 200 buckets
 * against a 2,000-tile cache — A2).
 */
export const SHAPE_SMALL: ArchiveShape = {
  name: 'S small',
  bucketMs: HOUR_MS,
  nBuckets: 1,
  primaryZoom: 6,
  tilesPerBucket: 4,
  bytesPerTile: 48 * KiB,
  decodedExpansion: 4,
};

export const SHAPE_LONG_SPARSE: ArchiveShape = {
  name: 'L long-sparse',
  bucketMs: HOUR_MS,
  nBuckets: 3000,
  primaryZoom: 10,
  minZoom: 0,
  tilesPerBucket: 40,
  bytesPerTile: 1 * KiB,
  decodedExpansion: 4,
  // 1 + 3 tiles per bucket × 3,000 buckets = 12,000 overview tiles, 12 MB of
  // directory bytes — under the 20 MiB byte budget, over the count gate.
  overview: [
    { zoom: 0, tilesPerBucket: 1, bytesPerTile: 1 * KiB },
    { zoom: 1, tilesPerBucket: 3, bytesPerTile: 1 * KiB },
  ],
};

export const SHAPE_FAST_FINE: ArchiveShape = {
  name: 'F fast-fine',
  bucketMs: MINUTE_MS,
  nBuckets: 3000,
  primaryZoom: 14,
  tilesPerBucket: 30,
  bytesPerTile: 1536,
  decodedExpansion: 4,
};

/** `speed × 5 s` = `buckets` temporal buckets, in sim-ms per wall-ms. */
export function speedForFloorBuckets(
  shape: ArchiveShape,
  buckets: number,
): number {
  return (buckets * shape.bucketMs) / 5000;
}

/** The one viewport every shape lives in. */
export const VIEWPORT: BoundingBox = {
  minLon: -10,
  minLat: -10,
  maxLon: 10,
  maxLat: 10,
};

export const tileKeyOf = (id: TileId): string =>
  `${id.z}/${id.x}/${id.y}/${id.t}`;

// ---------------------------------------------------------------------------
// Fake timers
// ---------------------------------------------------------------------------

/**
 * Fake every clock the loader chain reads: timers (link, debounce, eviction
 * coalescing, governor eval), `Date` (tileset seek detection, prefetch
 * pacing) and `performance` (governor wall clock, TimeController frames).
 * rAF is stubbed to a no-op — the clock is driven by `advanceFrame()`.
 */
export function installLoaderFakeTimers(): void {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'performance',
    ],
  });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

export function restoreLoaderFakeTimers(): void {
  vi.unstubAllGlobals();
  vi.useRealTimers();
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export interface RequestRecord {
  /** Fake wall-ms at dispatch. */
  readonly at: number;
  readonly ids: readonly TileId[];
  /** Σ directory bytes of `ids`. */
  readonly bytes: number;
  /** `hooks.fetchPriority === 'low'` — a lookahead (prefetch / overview) batch. */
  readonly lookahead: boolean;
  aborted: boolean;
  settledAt: number | null;
}

interface Transfer {
  remaining: number;
  startedAt: number;
  done: () => void;
}

const abortError = (): Error =>
  Object.assign(new Error('aborted'), { name: 'AbortError' });

/** The archive's 404 verdict, duck-typed the way the tileset detects it (B8). */
const permanentError = (id: TileId): Error =>
  Object.assign(new Error(`404 ${tileKeyOf(id)}`), {
    name: 'PermanentFetchError',
    status: 404,
  });

/** Weight of the newest sample in the throughput EWMA. */
const THROUGHPUT_EWMA_ALPHA = 0.5;

export class RecordedSource {
  readonly requests: RequestRecord[] = [];
  readonly requestCountByKey = new Map<string, number>();
  readonly loadCountByKey = new Map<string, number>();
  readonly unloadCountByKey = new Map<string, number>();
  /** Every `onTileError` the tileset raised, in order. */
  readonly errors: Array<{ id: TileId; error: Error }> = [];
  /** Keys with a decoded tile in the tileset right now (onTileLoad → onTileUnload). */
  readonly resident = new Map<string, TileId>();
  /** Keys dispatched and not yet settled. */
  readonly inflight = new Map<string, TileId>();
  private readonly idByKey = new Map<string, TileId>();
  private readonly requestsSinceUnload = new Map<string, number>();

  directoryCalls = 0;
  batchCalls = 0;
  /** Counts frozen at the first `onTileLoad` — the cold-start round trips. */
  directoryCallsAtFirstLoad: number | null = null;
  batchCallsAtFirstLoad: number | null = null;
  tileRequests = 0;
  /** Σ directory bytes over every tile ever requested (duplicates included). */
  bytesRequested = 0;
  /** Σ decoded bytes delivered (monotone; per-frame deltas come from it). */
  bytesDelivered = 0;
  /** Requests for a key AFTER it was evicted (`onTileUnload` seen first). */
  refetches = 0;
  /** Requests for a key already requested at least once (any reason). */
  duplicateRequests = 0;

  private permanent: (id: TileId) => boolean = () => false;
  private readonly active: Transfer[] = [];
  private linkTimer: ReturnType<typeof setTimeout> | null = null;
  private linkAdvancedAt = 0;
  private ewmaBytesPerMs: number | null = null;
  private throughputSamples = 0;
  /** Fake wall-ms the schedule's phase is measured from (construction). */
  private readonly linkEpoch = Date.now();

  constructor(
    readonly shape: ArchiveShape,
    readonly link: LinkModel = LINK_4MBPS,
  ) {}

  /** Make the archive answer 404 (permanently) for every tile `pred` selects. */
  markPermanentlyMissing(pred: (id: TileId) => boolean): void {
    this.permanent = pred;
  }

  // ── Directory ──────────────────────────────────────────────────────────

  private levelAt(
    z: number,
  ): { tilesPerBucket: number; bytesPerTile: number } | null {
    if (z === this.shape.primaryZoom) {
      return {
        tilesPerBucket: this.shape.tilesPerBucket,
        bytesPerTile: this.shape.bytesPerTile,
      };
    }
    const level = this.shape.overview?.find((l) => l.zoom === z);
    return level ?? null;
  }

  /** Directory bytes of `id`, or `undefined` for a tile the archive does not have. */
  readonly getTileByteSize = (id: TileId): number | undefined => {
    const level = this.levelAt(id.z);
    if (!level || id.y !== 0 || id.x < 0 || id.x >= level.tilesPerBucket) {
      return undefined;
    }
    const i = id.t / this.shape.bucketMs;
    if (!Number.isInteger(i) || i < 0 || i >= this.shape.nBuckets) {
      return undefined;
    }
    return level.bytesPerTile;
  };

  /** Decoded byte size the tileset will account for `id` (`estimateTileSize`). */
  decodedBytesOf(id: TileId): number {
    const dir = this.getTileByteSize(id) ?? 0;
    return Math.max(1000, Math.round(dir * this.shape.decodedExpansion));
  }

  /** Bounds are ignored: the whole shape sits inside the one viewport. */
  readonly getAvailableTiles = async (
    _bounds: BoundingBox,
    z: number,
    range: { start: number; end: number },
  ): Promise<TileId[]> => {
    this.directoryCalls++;
    const level = this.levelAt(z);
    if (!level) return [];
    const { bucketMs, nBuckets } = this.shape;
    const ids: TileId[] = [];
    const first = Math.max(0, Math.floor(range.start / bucketMs));
    const last = Math.min(nBuckets - 1, Math.floor(range.end / bucketMs));
    for (let i = first; i <= last; i++) {
      const t = i * bucketMs;
      if (t + bucketMs < range.start || t > range.end) continue;
      for (let x = 0; x < level.tilesPerBucket; x++)
        ids.push({ z, x, y: 0, t });
    }
    return ids;
  };

  // ── Link ───────────────────────────────────────────────────────────────

  /** The link's rate at fake wall-ms `t`. */
  private rateAt(t: number): number {
    const { bytesPerMs, schedule } = this.link;
    if (!schedule) return bytesPerMs;
    const phase = (t - this.linkEpoch) % schedule.periodMs;
    return phase >= schedule.slowFromMs
      ? bytesPerMs * schedule.slowFactor
      : bytesPerMs;
  }

  /** Fake wall-ms until the schedule next changes rate (∞ without one). */
  private msToNextRateChange(t: number): number {
    const { schedule } = this.link;
    if (!schedule) return Infinity;
    const phase = (t - this.linkEpoch) % schedule.periodMs;
    return phase >= schedule.slowFromMs
      ? schedule.periodMs - phase
      : schedule.slowFromMs - phase;
  }

  /** Bytes the link can move over [t0, t1] — exact under the schedule. */
  private capacityBytes(t0: number, t1: number): number {
    let bytes = 0;
    let t = t0;
    while (t < t1) {
      const end = Math.min(t1, t + this.msToNextRateChange(t));
      bytes += (end - t) * this.rateAt(t);
      t = end;
    }
    return bytes;
  }

  /**
   * The estimator a real archive exposes, on its real contract: `bytesPerMs`
   * is `null` until at least one transfer has completed, then an EWMA of
   * the link rate each completed transfer experienced. The `null` matters:
   * the governor's canplaythrough predictor abstains on a blind estimator,
   * and an estimator that answers before the coverage index is built lets
   * `estimateCost`'s "0 bytes on an unbuilt index" pass a gate onto nothing
   * (see the report).
   */
  readonly getThroughput = (): {
    bytesPerMs: number | null;
    samples: number;
  } => ({
    bytesPerMs: this.ewmaBytesPerMs,
    samples: this.throughputSamples,
  });

  private observeTransfer(t: Transfer, now: number): void {
    const elapsed = Math.max(1, now - t.startedAt);
    const rate = this.capacityBytes(t.startedAt, now) / elapsed;
    this.throughputSamples++;
    this.ewmaBytesPerMs =
      this.ewmaBytesPerMs === null
        ? rate
        : this.ewmaBytesPerMs +
          THROUGHPUT_EWMA_ALPHA * (rate - this.ewmaBytesPerMs);
  }

  private advanceLink(now: number): void {
    const t0 = this.linkAdvancedAt;
    this.linkAdvancedAt = now;
    if (now <= t0 || this.active.length === 0) return;
    const share = this.capacityBytes(t0, now) / this.active.length;
    for (const t of this.active) t.remaining = Math.max(0, t.remaining - share);
  }

  private scheduleLink(): void {
    if (this.linkTimer !== null) {
      clearTimeout(this.linkTimer);
      this.linkTimer = null;
    }
    if (this.active.length === 0) return;
    const now = Date.now();
    let minRemaining = Infinity;
    for (const t of this.active) {
      minRemaining = Math.min(minRemaining, t.remaining);
    }
    let wait = Math.ceil(
      (minRemaining * this.active.length) / this.rateAt(now),
    );
    // Under a schedule the rate may change before the earliest completion:
    // wake at the boundary, integrate exactly, and re-plan from there.
    wait = Math.max(0, Math.min(wait, this.msToNextRateChange(now)));
    this.linkTimer = setTimeout(() => {
      this.linkTimer = null;
      const at = Date.now();
      this.advanceLink(at);
      const finished: Transfer[] = [];
      for (let i = this.active.length - 1; i >= 0; i--) {
        if (this.active[i].remaining <= 1e-6) {
          finished.push(this.active[i]);
          this.active.splice(i, 1);
        }
      }
      for (const t of finished) {
        this.observeTransfer(t, at);
        t.done();
      }
      this.scheduleLink();
    }, wait);
  }

  /** Enter the shared pipe with `bytes` to move; `done` fires when they have. */
  private transfer(bytes: number, done: () => void): Transfer {
    const now = Date.now();
    this.advanceLink(now);
    const t: Transfer = { remaining: bytes, startedAt: now, done };
    this.active.push(t);
    this.scheduleLink();
    return t;
  }

  private dropTransfer(t: Transfer): void {
    const i = this.active.indexOf(t);
    if (i < 0) return;
    this.advanceLink(Date.now());
    this.active.splice(i, 1);
    this.scheduleLink();
  }

  // ── Tiles ──────────────────────────────────────────────────────────────

  /** A decoded tile whose `estimateTileSize` is exactly {@link decodedBytesOf}. */
  makeTile(id: TileId): Tile {
    const { bucketMs } = this.shape;
    return {
      id,
      timeRange: { start: id.t, end: id.t + bucketMs },
      layers: [{ arrowIpc: new Uint8Array(this.decodedBytesOf(id) - 1000) }],
    } as unknown as Tile;
  }

  readonly getTileDataBatch = (
    ids: TileId[],
    signal?: AbortSignal,
    hooks?: TileBatchHooks,
  ): Promise<(Tile | null)[]> => {
    const now = Date.now();
    this.batchCalls++;
    let bytes = 0;
    for (const id of ids) {
      const key = tileKeyOf(id);
      this.idByKey.set(key, id);
      const seen = this.requestCountByKey.get(key) ?? 0;
      if (seen > 0) this.duplicateRequests++;
      this.requestCountByKey.set(key, seen + 1);
      if ((this.unloadCountByKey.get(key) ?? 0) > 0) {
        const since = this.requestsSinceUnload.get(key) ?? 0;
        if (since === 0) this.refetches++;
        this.requestsSinceUnload.set(key, since + 1);
      }
      this.inflight.set(key, id);
      bytes += this.getTileByteSize(id) ?? 0;
    }
    this.tileRequests += ids.length;
    this.bytesRequested += bytes;
    const record: RequestRecord = {
      at: now,
      ids,
      bytes,
      lookahead: hooks?.fetchPriority === 'low',
      aborted: false,
      settledAt: null,
    };
    this.requests.push(record);

    return new Promise<(Tile | null)[]>((resolve, reject) => {
      let transfer: Transfer | null = null;
      let rttTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): void => {
        record.settledAt = Date.now();
        for (const id of ids) this.inflight.delete(tileKeyOf(id));
      };
      const onAbort = (): void => {
        if (rttTimer !== null) clearTimeout(rttTimer);
        if (transfer) this.dropTransfer(transfer);
        record.aborted = true;
        settle();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const deliver = (): void => {
        signal?.removeEventListener('abort', onAbort);
        settle();
        const out: (Tile | null)[] = ids.map((id, i) => {
          if (this.permanent(id)) {
            hooks?.onTileError?.(i, permanentError(id));
            return null;
          }
          const tile = this.makeTile(id);
          // Mirror the archive's incremental contract: each member is
          // delivered as it decodes, then the batch resolves with all of them.
          hooks?.onTileReady?.(i, tile);
          return tile;
        });
        resolve(out);
      };
      rttTimer = setTimeout(() => {
        rttTimer = null;
        transfer = this.transfer(bytes, deliver);
      }, this.link.latencyMs);
    });
  };

  readonly onTileLoad = (tile: Tile): void => {
    this.directoryCallsAtFirstLoad ??= this.directoryCalls;
    this.batchCallsAtFirstLoad ??= this.batchCalls;
    const key = tileKeyOf(tile.id);
    this.loadCountByKey.set(key, (this.loadCountByKey.get(key) ?? 0) + 1);
    this.resident.set(key, tile.id);
    this.bytesDelivered += this.decodedBytesOf(tile.id);
  };

  readonly onTileUnload = (tile: Tile): void => {
    const key = tileKeyOf(tile.id);
    this.unloadCountByKey.set(key, (this.unloadCountByKey.get(key) ?? 0) + 1);
    this.requestsSinceUnload.set(key, 0);
    this.resident.delete(key);
  };

  readonly onTileError = (error: Error, id: TileId): void => {
    this.errors.push({ id, error });
  };

  /** `directoryCalls + batchCalls` at the moment of the first `onTileLoad`. */
  get roundTripsToFirstLoad(): number | null {
    if (this.directoryCallsAtFirstLoad === null) return null;
    return this.directoryCallsAtFirstLoad + (this.batchCallsAtFirstLoad ?? 0);
  }

  /** A complete option bag for the tileset over this source; `overrides` win. */
  tilesetOptions(
    overrides: Partial<SpatioTemporalTilesetOptions> = {},
  ): SpatioTemporalTilesetOptions {
    return {
      minZoom: this.shape.minZoom ?? this.shape.primaryZoom,
      maxZoom: this.shape.primaryZoom,
      temporalBucketMs: this.shape.bucketMs,
      refinementStrategy: 'no-overlap',
      enablePrefetch: true,
      getAvailableTiles: this.getAvailableTiles,
      getTileByteSize: this.getTileByteSize,
      getTileData: (id, signal) =>
        this.getTileDataBatch([id], signal).then((r) => r[0]),
      getTileDataBatch: this.getTileDataBatch,
      getThroughput: this.getThroughput,
      onTileLoad: this.onTileLoad,
      onTileUnload: this.onTileUnload,
      onTileError: this.onTileError,
      ...overrides,
    };
  }

  // ── Measures ───────────────────────────────────────────────────────────

  /**
   * Directory bytes of the distinct primary-zoom tiles that were DELIVERED
   * and whose bucket the playhead's window actually visited — the bytes a
   * viewer saw. Everything else requested (a second fetch of the same key,
   * an unplayed runway, a storyboard) is speculation, useful or not.
   */
  bytesUseful(visitedBuckets: ReadonlySet<number>): number {
    let sum = 0;
    for (const [key, id] of this.idByKey) {
      if (id.z !== this.shape.primaryZoom) continue;
      if ((this.loadCountByKey.get(key) ?? 0) === 0) continue;
      if (!visitedBuckets.has(id.t / this.shape.bucketMs)) continue;
      sum += this.getTileByteSize(id) ?? 0;
    }
    return sum;
  }

  /** Σ directory bytes requested for tiles at zoom `z` (duplicates included). */
  bytesRequestedAtZoom(z: number): number {
    let sum = 0;
    for (const r of this.requests) {
      for (const id of r.ids) {
        if (id.z === z) sum += this.getTileByteSize(id) ?? 0;
      }
    }
    return sum;
  }

  /**
   * Directory bytes COMMITTED ahead of `time` at the primary zoom: resident
   * or in flight, bucket strictly after the playhead's. The quantity the
   * prefetch budget bounds (`PREFETCH_CACHE_FRACTION × maxCacheByteSize` in
   * directory currency, A2).
   */
  committedAheadBytes(time: number): number {
    const { primaryZoom } = this.shape;
    let sum = 0;
    const add = (id: TileId): void => {
      if (id.z === primaryZoom && id.t > time) {
        sum += this.getTileByteSize(id) ?? 0;
      }
    };
    for (const id of this.resident.values()) add(id);
    for (const [key, id] of this.inflight) {
      if (!this.resident.has(key)) add(id);
    }
    return sum;
  }

  /** Keys requested more than once, with their counts. */
  multiplyRequested(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const [k, n] of this.requestCountByKey) if (n > 1) out.push([k, n]);
    return out;
  }
}

// ---------------------------------------------------------------------------
// A playback session: real tileset + real governor + external-clock frames
// ---------------------------------------------------------------------------

export interface FrameContext {
  readonly frame: number;
  /** Fake wall-ms since the session started. */
  readonly wall: number;
  /** Playhead sim-ms after this frame. */
  readonly time: number;
  readonly tileset: SpatioTemporalTileset;
  readonly source: RecordedSource;
  readonly governor: PlaybackGovernor;
  readonly tc: TimeController;
  readonly stats: TilesetCacheStats;
  /** Fresh probe from the post-frame playhead at a one-bucket horizon. */
  readonly runway: BufferedRunway;
}

export interface SessionConfig {
  readonly shape: ArchiveShape;
  readonly link?: LinkModel;
  /** Sim-ms per wall-ms. */
  readonly speed: number;
  /** Fake wall-clock to play for. */
  readonly wallMs: number;
  /** @default 16 */
  readonly frameMs?: number;
  readonly timeWindow: number;
  /** @default 0 */
  readonly startTime?: number;
  /** Loop the clock over the dataset range. */
  readonly loop?: boolean;
  /** Viewport zoom. @default shape.primaryZoom */
  readonly zoom?: number;
  readonly tileset?: Partial<SpatioTemporalTilesetOptions>;
  readonly governor?: PlaybackGovernorOptions;
  /** Run `preloadOverviewTier()` with its REAL default budget before play. */
  readonly preloadOverview?: boolean;
  /** Tiles the archive answers 404 for, permanently (B8). */
  readonly permanentlyMissing?: (id: TileId) => boolean;
  readonly onFrame?: (ctx: FrameContext) => void;
}

export interface SessionResult {
  readonly source: RecordedSource;
  readonly stats: TilesetCacheStats;
  readonly qoe: PlaybackQoeStats;
  readonly state: PlaybackGovernorState;
  readonly overview: OverviewPreloadResult | null;
  readonly wraps: number;
  readonly samples: number;
  /**
   * STRICT form: frames on which the clock was RUNNING over a bucket that
   * was not resident (a partial frame), `blockedPermanently` excepted.
   */
  readonly frontierViolations: number;
  readonly firstFrontierViolation: { wall: number; time: number } | null;
  /**
   * The audit's form (TO-5 #4): frames on which the head was more than
   * `|speed| × TICK_PROBE_INTERVAL_MS` past the end of resident data.
   */
  readonly overrunViolations: number;
  /** Largest `time − end of resident data` seen while running (≤ 0 = never). */
  readonly maxOverrunSimMs: number;
  /** Samples where `cacheBytes` exceeded the cap by more than this frame's own deliveries. */
  readonly overCapSamples: number;
  /** Largest `cacheBytes − maxCacheByteSize` seen at a sample (≤ 0 = never over). */
  readonly maxOverCapBytes: number;
  readonly maxCacheBytes: number;
  readonly maxCacheByteSize: number;
  readonly bytesUseful: number;
  readonly bytesRequested: number;
  /** `bytesRequested / bytesUseful` (Infinity when nothing was useful). */
  readonly bytesRatio: number;
  /** Sim-ms the playhead ended at. */
  readonly endTime: number;
  /** Distinct temporal buckets the playhead's window touched. */
  readonly visitedBuckets: number;
  readonly summary: string;
}

/**
 * End of the resident run the head is in, or of the last resident run
 * before it (−∞ with nothing resident behind): the absolute frontier the
 * audit's overrun property measures against.
 */
function residentFrontier(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  time: number,
  direction: 1 | -1,
): number {
  if (direction > 0) {
    let frontier = -Infinity;
    for (const r of ranges) {
      if (r.start <= time && time < r.end) return r.end;
      if (r.end <= time) frontier = r.end;
    }
    return frontier;
  }
  let frontier = Infinity;
  for (const r of ranges) {
    if (r.start < time && time <= r.end) return r.start;
    if (r.start >= time) frontier = Math.min(frontier, r.start);
  }
  return frontier;
}

/**
 * Open the shape, hand the tileset to a real governor as the required
 * source, `requestPlay()`, and step `wallMs` of fake time in `frameMs`
 * frames: timers fire (link, debounce, eviction coalescing, governor eval),
 * the external clock advances one frame, the tileset sees the new playhead,
 * and the invariants are sampled — every frame, not at the end.
 */
export async function runPlaybackSession(
  cfg: SessionConfig,
): Promise<SessionResult> {
  const { shape } = cfg;
  const source = new RecordedSource(shape, cfg.link);
  if (cfg.permanentlyMissing) {
    source.markPermanentlyMissing(cfg.permanentlyMissing);
  }
  const frameMs = cfg.frameMs ?? 16;
  const startTime = cfg.startTime ?? 0;
  const zoom = cfg.zoom ?? shape.primaryZoom;
  const datasetEnd = shape.nBuckets * shape.bucketMs;

  let governor: PlaybackGovernor | null = null;
  const tileset = new SpatioTemporalTileset(
    source.tilesetOptions({
      onBufferChange: (runway) => governor?.notifyBufferChange(runway),
      ...cfg.tileset,
    }),
  );
  const maxCacheByteSize =
    cfg.tileset?.maxCacheByteSize ?? 2 * 1024 * 1024 * 1024;

  const tc = new TimeController({
    initialTime: startTime,
    speed: cfg.speed,
    timeRange: { start: 0, end: datasetEnd },
    loop: cfg.loop ?? false,
  });
  tc.attachExternalClock();
  let wraps = 0;
  tc.on('wrap', () => {
    wraps++;
  });
  governor = new PlaybackGovernor(tc, {
    getThroughput: source.getThroughput,
    ...cfg.governor,
  });
  governor.addSource('primary', tileset as unknown as BufferSource, {
    required: true,
  });

  const view = (): {
    bounds: BoundingBox;
    zoom: number;
    time: number;
    timeWindow: number;
  } => ({
    bounds: VIEWPORT,
    zoom,
    time: tc.getTime(),
    timeWindow: cfg.timeWindow,
  });

  tileset.update(view(), true);
  let overview: OverviewPreloadResult | null = null;
  if (cfg.preloadOverview) {
    void tileset.preloadOverviewTier().then((r) => {
      overview = r;
    });
  }
  governor.requestPlay();

  const visited = new Set<number>();
  const wall0 = Date.now();
  const overrunAllowance = Math.abs(cfg.speed) * TICK_PROBE_INTERVAL_MS;
  let samples = 0;
  let frontierViolations = 0;
  let firstFrontierViolation: { wall: number; time: number } | null = null;
  let overrunViolations = 0;
  let maxOverrunSimMs = -Infinity;
  let overCapSamples = 0;
  let maxOverCapBytes = -Infinity;
  let maxCacheBytes = 0;
  let deliveredAtLastSample = 0;
  const frames = Math.round(cfg.wallMs / frameMs);
  for (let frame = 0; frame < frames; frame++) {
    await vi.advanceTimersByTimeAsync(frameMs);
    tc.advanceFrame();
    tileset.update(view(), true);

    const time = tc.getTime();
    const half = cfg.timeWindow / 2;
    const lo = Math.max(0, Math.floor((time - half) / shape.bucketMs));
    const hi = Math.min(
      shape.nBuckets - 1,
      Math.floor((time + half) / shape.bucketMs),
    );
    for (let b = lo; b <= hi; b++) visited.add(b);

    const direction: 1 | -1 = tc.getSpeed() < 0 ? -1 : 1;
    // A one-bucket horizon: `simMs > 0` ⇔ the bucket under the playhead is
    // resident. Fresh from the registry, so a tile that landed this frame
    // counts and a tile the governor is (correctly) holding the clock for
    // is only a violation if the clock is running anyway. A bucket the
    // archive has refused for good is played THROUGH by design (B8) — the
    // governor folds `blockedPermanently` as complete — so it is exempt.
    const runway = tileset.getBufferedRunway(time, direction, shape.bucketMs);
    if (tc.isPlaying()) {
      if (!runway.complete && !runway.blockedPermanently && runway.simMs <= 0) {
        frontierViolations++;
        firstFrontierViolation ??= { wall: Date.now() - wall0, time };
      }
      if (!runway.complete && !runway.blockedPermanently) {
        const frontier = residentFrontier(
          tileset.getBufferedRanges({ maxRanges: 1_000_000 }),
          time,
          direction,
        );
        const overrun = direction > 0 ? time - frontier : frontier - time;
        if (Number.isFinite(overrun)) {
          if (overrun > maxOverrunSimMs) maxOverrunSimMs = overrun;
          if (overrun > overrunAllowance) overrunViolations++;
        }
      }
    }
    const stats = tileset.getCacheStats();
    const delivered = source.bytesDelivered - deliveredAtLastSample;
    deliveredAtLastSample = source.bytesDelivered;
    const over = stats.cacheBytes - maxCacheByteSize;
    if (over > maxOverCapBytes) maxOverCapBytes = over;
    // A3 evicts on delivery through a one-frame coalescing timer, so the
    // bytes THIS frame delivered may not have been reclaimed yet; everything
    // older must be under the cap.
    if (stats.cacheBytes - delivered > maxCacheByteSize) overCapSamples++;
    if (stats.cacheBytes > maxCacheBytes) maxCacheBytes = stats.cacheBytes;
    samples++;
    cfg.onFrame?.({
      frame,
      wall: Date.now() - wall0,
      time,
      tileset,
      source,
      governor,
      tc,
      stats,
      runway,
    });
  }

  const qoe = governor.getQoeStats();
  const stats = tileset.getCacheStats();
  const state = governor.state;
  const endTime = tc.getTime();
  const bytesUseful = source.bytesUseful(visited);
  const bytesRatio =
    bytesUseful > 0 ? source.bytesRequested / bytesUseful : Infinity;

  governor.dispose();
  tc.destroy();
  tileset.finalize();

  const summary =
    `${shape.name} @${cfg.speed}×: samples=${samples} buckets=${visited.size} ` +
    `evictions=${stats.evictions} runwayEvictions=${stats.runwayEvictions} ` +
    `byTier=${JSON.stringify(stats.evictionsByTier)} ` +
    `requests=${source.batchCalls} tileRequests=${source.tileRequests} ` +
    `refetches=${source.refetches} duplicates=${source.duplicateRequests} ` +
    `bytesRequested=${source.bytesRequested} bytesUseful=${bytesUseful} ` +
    `ratio=${bytesRatio.toFixed(3)} stalls=${qoe.stallCount} ` +
    `stallMs=${qoe.totalStallMs} degraded=${qoe.degradedResumeCount} ` +
    `creepMs=${qoe.creepMs} startupMs=${qoe.startupMs} ` +
    `gates=${JSON.stringify(qoe.gateEntriesByReason)} ` +
    `snapBacks=${qoe.frontierSnapBacks} frontierViolations=${frontierViolations} ` +
    `overrunViolations=${overrunViolations} maxOverrunSimMs=${maxOverrunSimMs} ` +
    `maxCacheBytes=${maxCacheBytes}/${maxCacheByteSize} ` +
    `overCapSamples=${overCapSamples} maxOverCap=${maxOverCapBytes} ` +
    `pinned=${stats.pinnedCount} wraps=${wraps} state=${state} ` +
    `errors=${source.errors.length}`;

  return {
    source,
    stats,
    qoe,
    state,
    overview,
    wraps,
    samples,
    frontierViolations,
    firstFrontierViolation,
    overrunViolations,
    maxOverrunSimMs,
    overCapSamples,
    maxOverCapBytes,
    maxCacheBytes,
    maxCacheByteSize,
    bytesUseful,
    bytesRequested: source.bytesRequested,
    bytesRatio,
    endTime,
    visitedBuckets: visited.size,
    summary,
  };
}
