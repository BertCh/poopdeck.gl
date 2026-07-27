/**
 * `SharedTilesetSource` — ONE archive + ONE tileset serving N maplibre layers.
 *
 * By default every `STTBaseLayer` owns a private `STTArchive` +
 * `SpatioTemporalTileset` (`base-layer.ts` initTileset), so a map showing
 * points + lines + polygons from the same .stt runs N archives against one URL:
 * N directory fetches, N tile caches holding the same bytes, and N
 * `BufferSource`s that distort governor fairness (the same runway counted N
 * times). This source is the shared alternative described in
 * docs/roadmap/renderer-architecture.md: layers register as *consumers* of one
 * shared tileset and receive the resident set replace-all, exactly like the
 * three renderer's `StreamingTileSource` (the template for this file).
 *
 * Contracts:
 *  - **Replace-all delivery.** `onTilesChanged(tiles)` always carries the FULL
 *    current resident set (`tileset.getVisibleTiles()`), published only when
 *    the set actually changed by tile address. Consumers rebuild their
 *    tile→GPU maps from it; incremental residency is a later optimization.
 *  - **Frame-token dedupe.** N layers on one map each call {@link update}
 *    per frame with the same viewport; the tileset must be driven ONCE per
 *    frame. There is deliberately no wall-clock coalescing (no `Date.now`):
 *    the host either calls {@link beginFrame} once per animation frame
 *    (every layer's plain `update(viewport)` then shares that token), or
 *    every caller passes the same external `frameId` for a given frame.
 *    Whichever convention is chosen must be used consistently: once dedupe
 *    is armed, repeating a token forever means the tileset is never driven
 *    again. Unarmed (neither `beginFrame` nor `frameId` ever used), every
 *    `update` drives the tileset — correct for a single-layer embed.
 *    Within a frame the FIRST caller's viewport wins; all consumers are
 *    assumed to share one map.
 *  - **One honest BufferSource.** {@link getBufferSource} exposes the shared
 *    tileset's readiness/cost surface for governor registration — register it
 *    once per archive, not once per layer. The class satisfies
 *    `@poopdeck.gl/playback`'s structural `BufferSource` contract without
 *    importing it (this package stays playback- and deck-free).
 *
 * `STTBaseLayer` integration (owned by the integrate step, not this file):
 * layers accept `{ source: SharedTilesetSource }` as an alternative to their
 * private archive, register a consumer in `onAdd`, call
 * `source.update(viewport)` from `render()`, and unregister in `onRemove`.
 */

import {
  STTArchive,
  SpatioTemporalTileset,
  type ArchiveMetadata,
  type BoundingBox,
  type BufferedRunway,
  type Tile,
} from '@poopdeck.gl/core';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';

/**
 * Selection window used when a caller supplies none AND nothing is configured
 * — no `timeWindowMs` option and no `temporalBucketMs` in the metadata (an
 * attached mock, or an archive predating the field). Strictly a default for
 * "nobody said": it is never composed into the `Math.max` floor, because a
 * fallback that outranks an explicit request is not a fallback.
 */
const DEFAULT_TIME_WINDOW_MS = 3600 * 1000;

/** A map-derived viewport — the input to {@link SharedTilesetSource.update}. */
export interface SharedViewport {
  bounds: BoundingBox;
  /** Integer slippy zoom (the base layer already floors `map.getZoom()`). */
  zoom: number;
  /** Play-head time (absolute ms). */
  time: number;
  /**
   * Temporal window (ms) the tileset selects around `time`. Composed with
   * {@link SharedTilesetSourceOptions.timeWindowMs} (then the archive's
   * `temporalBucketMs`) as a `Math.max`: a CONFIGURED value is a FLOOR, not
   * merely a default-when-omitted, so a caller asking for a narrower — or
   * zero — window cannot shrink the shared selection. With neither configured
   * there is no floor at all and this value is honoured as given; omitting it
   * then falls back to one hour.
   */
  timeWindow?: number;
}

/**
 * Options mirroring what `STTBaseLayer.initTileset` passes to its private
 * tileset today, so a layer switched onto a shared source keeps identical
 * loading behaviour, plus the cache caps the three streaming source exposes
 * (a shared source serves N layers — per-demo cache scaling wants them).
 */
export interface SharedTilesetSourceOptions {
  /** Custom fetch (auth headers / base rewrite). URL-constructed archives only. */
  fetch?: typeof fetch;
  /**
   * Max concurrent tile requests. Threaded into both the archive's range
   * coalescer (URL-constructed archives) and the tileset, matching the
   * base layer's single-knob behaviour.
   */
  maxRequests?: number;
  /** Prefetch behaviour, forwarded to the tileset (defaults: on, 30s, 4 steps). */
  enablePrefetch?: boolean;
  prefetchAhead?: number;
  prefetchSteps?: number;
  /** Tile-cache caps, forwarded to the tileset. */
  maxCacheSize?: number;
  maxCacheByteSize?: number;
  /**
   * FLOOR on the temporal window (ms) the tileset selects with, and the value
   * used outright when {@link SharedViewport.timeWindow} is omitted. Defaults
   * to the archive's `temporalBucketMs`; with neither, there is no floor and
   * an omitted window falls back to {@link DEFAULT_TIME_WINDOW_MS}.
   */
  timeWindowMs?: number;
  /**
   * Buffered-runway threshold events, forwarded once per SOURCE (the
   * governor-wiring seat — per-consumer `onBufferChange` also fires).
   */
  onBufferChange?: (runway: BufferedRunway) => void;
  /**
   * Whether {@link SharedTilesetSource.dispose} finalizes the archive.
   * Defaults to true (the source owns its archive even when one was passed
   * in); pass false when a caller shares the archive beyond this source.
   */
  ownsArchive?: boolean;
}

/**
 * A layer (or governor observer) receiving fan-out from the shared source.
 * Registering an id that is already registered replaces the previous entry.
 */
export interface TilesetConsumer {
  /** Unique id, conventionally the maplibre layer id. */
  id: string;
  /**
   * Replace-all resident-set delivery: the full current `getVisibleTiles()`
   * result, fired only when the set changed by tile address. Also fired
   * synchronously at registration when tiles are already resident, so
   * late-added layers render without waiting for the next change.
   */
  onTilesChanged: (tiles: Tile[]) => void;
  /** Buffered-runway threshold events (see the base layer's option of the same name). */
  onBufferChange?: (runway: BufferedRunway) => void;
}

/**
 * Stable identity key for a {@link Tile} used by the resident-set diff. A
 * tile's `id` (`z/x/y/t`) is its address; two `getVisibleTiles` calls that
 * return the same addresses describe the same resident set even if array
 * order or `Tile` object identities differ.
 */
export function tileKey(tile: Tile): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}`;
}

/** `true` when two tile arrays describe the same resident set (by address). */
export function residentSetEqual(
  a: readonly Tile[],
  b: readonly Tile[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const seen = new Set<string>();
  for (const t of a) seen.add(tileKey(t));
  for (const t of b) {
    if (!seen.has(tileKey(t))) return false;
  }
  return true;
}

/**
 * The minimal tileset surface {@link SharedTilesetSource} drives. The real
 * {@link SpatioTemporalTileset} satisfies it; tests pass a mock. Keeping it
 * structural lets the unit tests exercise the update-pump + fan-out without
 * a network/archive.
 */
export interface DrivableTileset {
  /**
   * Returns the tileset's frame number — a version that changes whenever the
   * visible-tile set may have changed (needed-set change or tile-load
   * completion; the core tileset's contract). {@link SharedTilesetSource.update}
   * gates its resident-set diff on it, so a mock whose set can change must
   * bump the returned value.
   */
  update(
    viewport: {
      bounds: BoundingBox;
      zoom: number;
      time: number;
      timeWindow: number;
    },
    skipDebounce?: boolean,
  ): number;
  getVisibleTiles(): Tile[];
  setAnimationState?(isAnimating: boolean, speed?: number): void;
  setInteractive?(interactive: boolean): void;
  finalize?(): void;
  clear?(): void;
}

/**
 * The readiness/cost surface {@link SharedTilesetBufferSource} delegates to.
 * The real {@link SpatioTemporalTileset} satisfies it; tests pass a mock.
 */
export interface RunwayTileset {
  getBufferedRunway(
    time: number,
    direction: 1 | -1,
    horizonSimMs?: number,
  ): BufferedRunway;
  getBufferedRanges(opts?: {
    maxRanges?: number;
  }): Array<{ start: number; end: number }>;
  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  };
  estimateTimeToReadyMs(range: { start: number; end: number }): number | null;
  flushPrefetch(): void;
  setAnimationState?(isAnimating: boolean, speed?: number): void;
  setInteractive?(interactive: boolean): void;
  setPrefetchRunAheadLimit?(simMs: number | null): void;
  setBandwidthWeight?(weight: number): void;
}

/**
 * The playback `BufferSource` for a shared tileset — every method delegates
 * straight to the core tileset's coverage-index math (runway / ranges / cost
 * / ETA / flush), the same shape as three's `TilesetBufferSource`. Register
 * ONE of these per archive with the governor; registering each layer's
 * private tileset instead counts the same runway N times and distorts
 * multi-source fairness.
 *
 * Satisfies `@poopdeck.gl/playback`'s `BufferSource` structurally (the
 * governor narrows with `typeof source.getBufferedRunway === 'function'`);
 * no playback import so this package keeps its zero-extra-deps posture.
 */
export class SharedTilesetBufferSource {
  constructor(private readonly tileset: RunwayTileset) {}

  getBufferedRunway(
    time: number,
    direction: 1 | -1,
    horizonSimMs?: number,
  ): BufferedRunway {
    const r = this.tileset.getBufferedRunway(time, direction, horizonSimMs);
    return {
      simMs: r.simMs,
      bytesPending: r.bytesPending,
      horizonSimMs: r.horizonSimMs,
      complete: r.complete,
    };
  }

  getBufferedRanges(opts?: {
    maxRanges?: number;
  }): Array<{ start: number; end: number }> {
    return this.tileset.getBufferedRanges(opts);
  }

  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  } {
    return this.tileset.estimateCost(range);
  }

  estimateTimeToReadyMs(range: { start: number; end: number }): number | null {
    return this.tileset.estimateTimeToReadyMs(range);
  }

  flushPrefetch(): void {
    this.tileset.flushPrefetch();
  }

  setAnimationState(isAnimating: boolean, speed?: number): void {
    this.tileset.setAnimationState?.(isAnimating, speed);
  }

  // Scrub-LOD interactive bit (governor beginScrub/endScrub).
  setInteractive(interactive: boolean): void {
    this.tileset.setInteractive?.(interactive);
  }

  // Run-ahead fairness + dynamic fair-share weight for multi-source playback.
  // Without these forwards the governor's optional-chained calls silently
  // no-op for every maplibre source while the deck path cooperates.
  setPrefetchRunAheadLimit(simMs: number | null): void {
    this.tileset.setPrefetchRunAheadLimit?.(simMs);
  }

  setBandwidthWeight(weight: number): void {
    this.tileset.setBandwidthWeight?.(weight);
  }
}

export class SharedTilesetSource {
  private url?: string;
  private archive: STTArchive | null = null;
  private metadata: ArchiveMetadata | null = null;
  private tileset: DrivableTileset | null = null;
  /** The tileset {@link load} built (vs one handed to {@link attachTileset}). */
  private loadBuiltTileset: DrivableTileset | null = null;
  private inflightInit: Promise<void> | null = null;
  private bufferSource: SharedTilesetBufferSource | null = null;
  /**
   * Tileset frame number as of the last update-path publish. An unchanged
   * number means the visible set cannot have changed since (async
   * arrivals/evictions publish directly via onTileLoad/onTileUnload), so
   * update() skips the getVisibleTiles + resident-diff walk — with N sibling
   * layers calling update() unarmed every frame, that walk otherwise
   * allocates arrays/Sets/keys N times per frame in the render hot path.
   */
  private lastPublishedFrame: number | null = null;
  /** A republish is owed (see {@link schedulePublish}) but has not run yet. */
  private publishPending = false;
  /** A microtask flush is already queued (one per batch, not one per tile). */
  private publishScheduled = false;

  private readonly opts: SharedTilesetSourceOptions;
  private readonly ownsArchive: boolean;
  private archiveFinalized = false;

  private readonly consumers = new Map<string, TilesetConsumer>();

  /** Last resident set published to consumers (for diffing). */
  private resident: Tile[] = [];
  private disposed = false;

  // Frame-token dedupe state (see the class doc). `dedupeArmed` stays false
  // until the host declares frames via beginFrame()/frameId — before that,
  // every update drives the tileset.
  private frameToken = 0;
  private lastDrivenToken: number | null = null;
  private dedupeArmed = false;

  constructor(
    archiveOrUrl: STTArchive | string,
    options: SharedTilesetSourceOptions = {},
  ) {
    if (typeof archiveOrUrl === 'string') {
      this.url = archiveOrUrl;
    } else {
      this.archive = archiveOrUrl;
    }
    this.opts = options;
    this.ownsArchive = options.ownsArchive ?? true;
  }

  /**
   * Test/embedding seam: drive a pre-built tileset (real or mock) instead of
   * constructing one via {@link load}. Sets the metadata used to default the
   * time window. Returns `this` for chaining.
   *
   * Re-attaching over an existing tileset invalidates every piece of derived
   * state that belongs to the outgoing one: the cached {@link getBufferSource}
   * (it delegates to the replaced tileset), the resident set (address-equal
   * sets from the replacement carry different Tile objects and would be
   * diff-suppressed), and the dedupe/frame tokens. A predecessor that
   * {@link load} built is finalized (its debounce/prefetch timers would leak);
   * an attached predecessor stays its caller's to finalize.
   */
  attachTileset(tileset: DrivableTileset, metadata?: ArchiveMetadata): this {
    const prev = this.tileset;
    this.tileset = tileset;
    if (metadata) this.metadata = metadata;
    if (prev && prev !== tileset) {
      if (prev === this.loadBuiltTileset) {
        prev.finalize?.();
        this.loadBuiltTileset = null;
      }
      this.bufferSource = null;
      this.lastDrivenToken = null;
      this.lastPublishedFrame = null;
      // `prev.finalize()` above routes through its `clear()`, which fires
      // `onTileUnload` for every header and so arms a republish that belongs
      // to a tileset this source no longer drives. The re-seed below is the
      // authoritative publish for the replacement.
      this.publishPending = false;
      // Re-seed unconditionally (no diff): consumers must swap to the NEW
      // tileset's Tile objects even when the addresses are identical.
      this.resident = tileset.getVisibleTiles();
      for (const consumer of this.consumers.values()) {
        consumer.onTilesChanged(this.resident);
      }
    }
    return this;
  }

  /** Build the archive + tileset (idempotent; safe to await repeatedly). */
  async load(): Promise<void> {
    if (this.disposed || this.tileset) return;
    if (this.inflightInit) return this.inflightInit;
    this.inflightInit = this._load();
    try {
      await this.inflightInit;
    } finally {
      this.inflightInit = null;
    }
  }

  private async _load(): Promise<void> {
    const archive =
      this.archive ??
      new STTArchive({
        url: this.url!,
        fetch: this.opts.fetch,
        maxConcurrentRequests: this.opts.maxRequests,
      });
    const metadata = await archive.getMetadata();
    if (this.disposed) {
      this.finalizeArchive(archive);
      return;
    }
    this.archive = archive;
    this.metadata = metadata;

    // Same option set STTBaseLayer.initTileset passes today (parity with the
    // per-layer path), plus the cache caps. The core adapter callbacks route
    // the bulk fill through the range coalescer, carry incremental delivery +
    // fetch-priority + cross-source EDF playhead hints, and wire the
    // throughput EWMA + scheduler weight — shared verbatim with deck/three.
    this.tileset = new SpatioTemporalTileset({
      maxRequests: this.opts.maxRequests,
      minZoom: metadata.minZoom,
      maxZoom: metadata.maxZoom,
      temporalBucketMs: metadata.temporalBucketMs,
      refinementStrategy: 'best-available',
      enablePrefetch: this.opts.enablePrefetch,
      prefetchAhead: this.opts.prefetchAhead,
      prefetchSteps: this.opts.prefetchSteps,
      maxCacheSize: this.opts.maxCacheSize,
      maxCacheByteSize: this.opts.maxCacheByteSize,
      ...makeTilesetCallbacks(archive),
      onBufferChange: (runway) => this.handleBufferChange(runway),
      // Tiles arrive after the synchronous update() returns — re-publish the
      // resident set so consumers pick them up; ditto evictions. DEFERRED, not
      // inline — see schedulePublish().
      onTileLoad: () => this.schedulePublish(),
      onTileUnload: () => this.schedulePublish(),
    });
    this.loadBuiltTileset = this.tileset;
  }

  /** Resolved archive metadata, once loaded (or attached). */
  getMetadata(): ArchiveMetadata | null {
    return this.metadata;
  }

  /** The underlying tileset, once built. */
  getTileset(): DrivableTileset | null {
    return this.tileset;
  }

  /** The archive (for direct queries, e.g. `getFeatureProperties`), once loaded. */
  getArchive(): STTArchive | null {
    return this.archive;
  }

  /**
   * Register a consumer; returns its unregister function. Registration is
   * replace-by-id; the returned unregister only removes the entry it
   * registered (a stale unregister cannot evict a replacement). Consumers
   * with tiles already resident are seeded synchronously.
   */
  registerConsumer(consumer: TilesetConsumer): () => void {
    if (this.disposed) return () => undefined;
    this.consumers.set(consumer.id, consumer);
    if (this.tileset && this.resident.length > 0) {
      consumer.onTilesChanged(this.resident);
    }
    return () => {
      if (this.consumers.get(consumer.id) === consumer) {
        this.consumers.delete(consumer.id);
      }
    };
  }

  /**
   * Declare a new animation frame and arm frame-token dedupe: until the next
   * `beginFrame()`, only the FIRST plain `update(viewport)` drives the
   * tileset. Returns the new token (usable as an explicit `frameId`). Call
   * once per frame, every frame — see the class doc for the contract.
   */
  beginFrame(): number {
    this.dedupeArmed = true;
    return ++this.frameToken;
  }

  /**
   * Pump a viewport into the tileset, then publish the resident set if it
   * changed. Deduped per frame token (see the class doc): pass `frameId`
   * when the host distributes its own frame counter, omit it when the host
   * calls {@link beginFrame}. Safe before {@link load} resolves (no-op).
   */
  update(viewport: SharedViewport, frameId?: number): void {
    if (!this.tileset) return;
    let token: number;
    if (frameId !== undefined) {
      this.dedupeArmed = true;
      token = frameId;
    } else {
      token = this.frameToken;
    }
    if (this.dedupeArmed && this.lastDrivenToken === token) return;
    this.lastDrivenToken = token;

    // `Math.max`, not the `??` chain this used to be. A per-frame window is a
    // REQUEST and the source's configured `timeWindowMs` is the FLOOR under it,
    // because the source is shared: layer A asking for a narrow window must not
    // shrink the selection out from under layer B, and a layer whose own
    // `timeWindow` is 0 (a baked frame sequence, before its
    // `tileLoadTimeWindow`/mode widening is configured) would otherwise collapse
    // the whole source's selection to a point — `??` treats 0 as "supplied" and
    // passes it straight through, so the configured floor never gets a vote.
    // Same semantics as deck's `getEffectiveTimeWindow` composition.
    //
    // The floor is only ever a CONFIGURED value: the explicit `timeWindowMs`,
    // else the archive's own bucket width. The one-hour literal below is the
    // last resort for when neither exists, and it is deliberately NOT part of
    // the floor — a fallback answers "you told me nothing", it does not get to
    // overrule a caller who did. Folding it in made an unconfigured source
    // silently select a 1-HOUR window for a layer asking for 5 s: 720× the
    // requested span, every frame, on the demos whose whole point is a thin
    // slice.
    const floor = this.opts.timeWindowMs ?? this.metadata?.temporalBucketMs;
    const timeWindow =
      viewport.timeWindow === undefined
        ? (floor ?? DEFAULT_TIME_WINDOW_MS)
        : Math.max(viewport.timeWindow, floor ?? 0);
    // Fresh object, never a reused scratch: tileset.update RETAINS the
    // viewport reference and reads the PREVIOUS object's time for seek
    // detection — mutating a shared scratch would erase every seek.
    const frame = this.tileset.update({
      bounds: viewport.bounds,
      zoom: viewport.zoom,
      time: viewport.time,
      timeWindow,
    });
    // Same frame number ⇒ the visible set cannot have changed since the last
    // update-path publish (see lastPublishedFrame) — skip the diff walk.
    if (frame !== this.lastPublishedFrame) {
      this.lastPublishedFrame = frame;
      this.publishPending = true;
    }
    // Flush here rather than wait for the microtask: `tileset.update()` has
    // returned, so any eviction it performed is complete AND its registry is
    // settled, and consumers get the corrected set inside the frame that
    // caused it. The frame gate above is a pure optimisation — an eviction
    // does NOT bump the tileset's frame number, so it can only ever arrive
    // through the pending flag.
    this.flushPublish();
  }

  /** Forward playback animation state (keeps prefetch alive while gated). */
  setAnimationState(isAnimating: boolean, speed = 0): void {
    this.tileset?.setAnimationState?.(isAnimating, speed);
  }

  /** Current resident set (loaded tiles for the latest viewport). */
  getVisibleTiles(): Tile[] {
    return this.tileset ? this.tileset.getVisibleTiles() : [];
  }

  /**
   * The governor-facing readiness surface over the shared tileset, or `null`
   * before one exists. Narrows structurally (a mock tileset without runway
   * methods stays `null`); cached once resolved.
   */
  getBufferSource(): SharedTilesetBufferSource | null {
    if (this.bufferSource) return this.bufferSource;
    const ts = this.tileset;
    if (
      ts &&
      typeof (ts as Partial<RunwayTileset>).getBufferedRunway === 'function'
    ) {
      this.bufferSource = new SharedTilesetBufferSource(
        ts as unknown as RunwayTileset,
      );
      return this.bufferSource;
    }
    return null;
  }

  /**
   * Queue a resident-set republish for the end of the current task.
   *
   * THE ORDERING THIS EXISTS FOR. Core fires `onTileUnload` with the header
   * STILL in its registry and deletes it only afterwards
   * (`packages/core/src/spatiotemporal-tileset.ts` `evictTiles`: callback,
   * then `tiles.delete(key)`). Publishing from inside the callback therefore
   * re-read a registry that still contained the evicted tile — so the "new"
   * set was address-identical to the old one, `residentSetEqual` reported
   * unchanged, and the correction NEVER WENT OUT. Every consumer went on
   * drawing a tile whose data was gone until some unrelated change happened
   * to move the set again.
   *
   * A microtask, not a frame callback: the browser cannot paint between a task
   * and its microtask drain, so the corrected set always beats the next frame
   * to the screen. It also coalesces a batch of arrivals into one
   * `getVisibleTiles()` + diff walk instead of one per tile, and {@link update}
   * flushes it synchronously so a frame that drives the tileset itself never
   * publishes late.
   */
  private schedulePublish(): void {
    this.publishPending = true;
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    queueMicrotask(() => {
      this.publishScheduled = false;
      this.flushPublish();
    });
  }

  /** Run a queued republish now, if one is outstanding. */
  private flushPublish(): void {
    if (!this.publishPending) return;
    this.publishPending = false;
    this.publishIfChanged();
  }

  /** Recompute the resident set; fan out to consumers only on a real change. */
  private publishIfChanged(): void {
    if (!this.tileset) return;
    const next = this.tileset.getVisibleTiles();
    if (residentSetEqual(this.resident, next)) return;
    this.resident = next;
    for (const consumer of this.consumers.values()) {
      consumer.onTilesChanged(next);
    }
  }

  private handleBufferChange(runway: BufferedRunway): void {
    this.opts.onBufferChange?.(runway);
    for (const consumer of this.consumers.values()) {
      consumer.onBufferChange?.(runway);
    }
  }

  /** Finalize the archive at most once, and only when this source owns it. */
  private finalizeArchive(archive: STTArchive): void {
    if (!this.ownsArchive || this.archiveFinalized) return;
    this.archiveFinalized = true;
    archive.finalize();
  }

  /**
   * Tear down: consumers stop receiving callbacks, the tileset is finalized,
   * and the archive is finalized when owned. Idempotent; a `load()` still
   * awaiting metadata aborts at its post-await guard.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.consumers.clear();
    const ts = this.tileset;
    if (ts) {
      if (typeof ts.finalize === 'function') ts.finalize();
      else ts.clear?.();
    }
    if (this.archive) this.finalizeArchive(this.archive);
    // finalize()/clear() above armed a republish per header; there is nobody
    // left to publish to (consumers are already cleared) and no tileset to
    // read.
    this.publishPending = false;
    this.tileset = null;
    this.loadBuiltTileset = null;
    this.archive = null;
    this.bufferSource = null;
    this.resident = [];
  }
}
