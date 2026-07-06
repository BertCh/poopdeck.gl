# SpatiotemporalTileset

The `SpatiotemporalTileset` class manages the lifecycle, loading, and caching of spatiotemporal tiles. It is the "brain" behind the [`SpatioTemporalLayer`](./spatiotemporal-layer.md), determining which tiles to load based on the current viewport and time window — and, since the player-buffering work, the readiness oracle a [`PlaybackGovernor`](./playback-governor.md) gates playback on.

It is inspired by deck.gl's `Tileset2D` (the class behind `TileLayer`), extended for the temporal dimension: tile selection, request scheduling, prefetch, and the buffer model all reason about `(z, x, y, t)` addresses.

## Installation

```typescript
import { SpatiotemporalTileset } from "@poopdeck.gl/core";
```

## Usage

Typically used internally by `SpatioTemporalLayer` (and `@poopdeck.gl/maplibre`'s `STTBaseLayer`), but can be used independently for custom implementations.

```typescript
const tileset = new SpatiotemporalTileset({
  maxRequests: 24,
  getAvailableTiles: (bounds, zoom, timeRange) =>
    archive.getTileIdsInBounds(bounds, zoom, timeRange),
  getTileData: (tileId, signal) => archive.getTile(tileId, { signal }),
  // Coalesced batch path + directory byte sizes + throughput — strongly
  // recommended; this is what the deck.gl and maplibre layers wire.
  getTileDataBatch: (ids, signal, hooks) =>
    archive.getTiles(ids, {
      signal,
      onTileReady: hooks?.onTileReady,
      fetchPriority: hooks?.fetchPriority,
    }),
  getTileByteSize: (id) => archive.getTileByteSize(id),
  getThroughput: () => archive.getThroughputEstimate(),
  onTileLoad: (tile) => console.log("Loaded", tile),
});

// Update every frame or viewport change
tileset.update(
  {
    bounds: currentBounds,
    zoom: currentZoom,
    time: Date.now(),
    timeWindow: 86400000,
  },
  false
);

const visibleTiles = tileset.getVisibleTiles();
```

## Constructor Options

### Required Callbacks

| Option              | Type       | Description                                              |
| :------------------ | :--------- | :------------------------------------------------------- |
| `getAvailableTiles` | `(bounds, zoom, timeRange) => Promise<TileId[]>` | Async directory query for raw-tier tile IDs in view. |
| `getTileData`       | `(tileId, signal?) => Promise<Tile \| null>` | Fetch and decode a single tile (also the fallback when no batch callback is wired). |

### Optional Data Callbacks

| Option | Type | Description |
| :--- | :--- | :--- |
| `getTileDataBatch` | `(tileIds, signal?, hooks?) => Promise<(Tile \| null)[]>` | Batched fetch. When provided, each request-queue pass sends the tiles it would otherwise fetch one-by-one as a SINGLE call, letting the archive coalesce their (Hilbert-adjacent, hence usually byte-adjacent) ranges into a handful of HTTP Range requests. Wire `STTArchive.getTiles` here. `hooks.onTileReady(index, tile)` delivers each tile as soon as ITS coalesced range group decodes, so tiles render incrementally; `hooks.fetchPriority` is the browser fetch-priority hint (`'low'` for lookahead tiers). |
| `getTileByteSize` | `(tileId) => number \| undefined` | SYNCHRONOUS directory lookup of a tile's compressed byte size (wire `STTArchive.getTileByteSize`). Enables (a) skipping PARENT-fallback tiles larger than `maxParentTileBytes`, and (b) byte-exact buffer-model math (`bytesPending`, `estimateCost`). |
| `getAvailableSummaryTiles` | `(bounds, zoom, timeRange) => Promise<TileId[]>` | Directory query for SUMMARY-tier tile IDs (wire `STTArchive.getSummaryTileIdsInBounds`). Without it, `tier: 'summary'`/`'auto'` behave as `'raw'`. |
| `getThroughput` | `() => { bytesPerMs: number \| null; samples: number }` | Network throughput probe used by `estimateTimeToReadyMs` to convert pending bytes into an honest ETA. Wire `STTArchive.getThroughputEstimate` (a dual-EWMA over coalesced range responses). `bytesPerMs` is `null` until the estimator has a sample. |

### Tile Loading Options

| Option             | Type     | Default       | Description                                     |
| :----------------- | :------- | :------------ | :---------------------------------------------- |
| `maxRequests`      | `number` | `24`          | Concurrency budget for the single-tile / prefetch paths. The coalesced priority path sends the whole viewport×window working set in one batch and lets the archive bound in-flight HTTP requests internally; this caps the per-tile + prefetch fan-out. |
| `debounceTime`     | `number` | `0`           | Debounce (ms) before loading after a viewport change. |
| `maxCacheSize`     | `number` | `2000`        | Maximum tiles in the LRU cache.                 |
| `maxCacheByteSize` | `number` | `2147483648`  | Maximum decoded bytes in the cache (2 GiB). Accounting is alias-deduped (honest): zero-copy datasets genuinely fill the budget where they previously plateaued ~half; set explicitly on memory-constrained targets. |
| `minZoom`          | `number` | `0`           | Minimum zoom level available in data.           |
| `maxZoom`          | `number` | `14`          | Maximum zoom level available in data (the layers replace this from archive metadata). |
| `temporalBucketMs` | `number` | `3600000`     | Temporal bucket size in ms (from archive metadata). Aligns prefetch to bucket boundaries and is the granularity of the buffer model. |
| `maxParentTileBytes` | `number` | `2097152`   | Byte ceiling above which a PARENT-fallback tile is skipped (requires `getTileByteSize`). The primary display zoom is never subject to this. |

### Refinement Options

| Option               | Type                                | Default            | Description                                            |
| :------------------- | :---------------------------------- | :----------------- | :----------------------------------------------------- |
| `refinementStrategy` | `'best-available' \| 'no-overlap'`  | `'best-available'` | `'best-available'` surfaces parent tiles (up to 4 zoom levels back) while detailed tiles load — also covers the gap when `--min-features-per-tile` drops sparse deep-zoom tiles. `'no-overlap'` loads only the exact zoom (used by the summary tier, where a parent would double-draw aggregated cells). |
| `lodMode`            | `'parent-fallback' \| 'additive'`   | `'parent-fallback'`| `'parent-fallback'` renders the single best (highest loaded) zoom; coarser parents are transient fallbacks dropped the moment their children finish streaming. `'additive'` renders the UNION of zoom levels `[minZoom..requestedZoom]` simultaneously and keeps every level resident — for additive-octree point clouds (built with `stt-build --min-zoom-field`/`--max-zoom-field`), where each point lives at exactly one zoom, a coarse tile holds a sparse overview and finer tiles add only the residual detail, so there is no double-drawing and zooming in fetches only the deeper levels. |

### Prefetch Options

| Option          | Type      | Default | Description                                          |
| :-------------- | :-------- | :------ | :--------------------------------------------------- |
| `enablePrefetch`| `boolean` | `true`  | Enable predictive prefetching for animations.        |
| `prefetchAhead` | `number`  | `30000` | How far ahead to prefetch (animation time in ms). During measured playback the lookahead is additionally sized in REAL time (~8 s of playback at the current speed). |
| `prefetchSteps` | `number`  | `4`     | Number of time-window steps to prefetch.             |

Prefetch dispatches in small, time-ordered, byte-budgeted SLICES (~1 s of measured throughput, clamped to 1–16 MiB; 4 MiB before the estimator has a sample) — the streaming-video segment model. One slice is in flight at a time; every slice boundary is a fresh chance for priority work to dispatch first. The prefetch direction has hysteresis (3 consecutive opposite-sign frames before flipping), and the prefetch working set is capped at half the tile-count cache budget so the runway stays resident instead of thrashing the LRU.

### Tier dispatch

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `tier` | `'raw' \| 'summary' \| 'auto'` | `'auto'` | Tile-tier dispatch for archives with a server-aggregated summary tier. `'auto'` uses summary tiles when the zoom is inside `summaryZoomRange` and raw tiles otherwise. Falls back to `'raw'` whenever `getAvailableSummaryTiles` is unwired. |
| `summaryZoomRange` | `{ minZoom, maxZoom }` | `null` | Inclusive zoom range covered by the archive's summary tier. Only consulted by `'auto'`. |

Temporal-LOD dispatch is now wired into the tileset, but only via the opt-in [Scrub-LOD](#scrub-lod-motion-tier) `scrubLod.temporal` axis (default off, and only when the archive was built with `--temporal-lod`). The underlying reader API — `STTArchive.pickTemporalLodForZoom`, `getTileIdsInBoundsForTemporalLod`, and `getTilesInBoundsForTemporalLod` — is also exposed directly, so an app that wants coarser temporal tiers outside the scrub path can select the LOD level and request those tiles itself.

### Scrub-LOD (motion tier)

Opt-in, default off. While the user drags the timeline, tile SELECTION may degrade to a cheaper preview tier; the readiness/buffer APIs (`getBufferedRunway` / `getBufferedRanges` / `estimateCost`) and the prefetch planner keep measuring/warming the FINE base tier, so a playback gate on scrub release re-arms against full detail — never the coarse preview.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `scrubLod` | `ScrubLodOptions` | `null` | Scrub-time LOD degradation policy (see below). Absent/empty = the kill switch: `setInteractive` becomes stored state only and behavior is byte-identical to today. |
| `temporalLodLevels` | `TemporalLodLevel[]` | `null` | The archive's temporal-LOD pyramid levels (from `ArchiveMetadata.temporalLod`), enabling the `scrubLod.temporal` axis. Absent for archives built without `--temporal-lod` — the temporal axis then no-ops regardless of `scrubLod`. |
| `getAvailableTemporalLodTiles` | `(bounds, zoom, timeRange, bucketMs) => Promise<TileId[]>` | `null` | Enumerate the tiles of ONE temporal-LOD tier (wire `STTArchive.getTileIdsInBoundsForTemporalLod`). Used only while interactive with `scrubLod.temporal` enabled; the base `getAvailableTiles` still serves every other query. |

`ScrubLodOptions` has two independent axes, both default OFF; an absent/empty object is byte-identical to today (the kill switch):

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `spatial` | `boolean` | `false` | While interactive, drop the requested (primary) zoom by `spatialZoomDrop` so selection targets coarser tiles — usually ones the parent-fallback path already fetched. |
| `spatialZoomDrop` | `number` | `2` | Zoom levels dropped while interactive (spatial axis). Clamped to `[0, 4]` (`PARENT_FALLBACK_LEVELS`) so the coarse target stays inside the band the fallback path already loads. |
| `temporal` | `boolean` | `false` | While interactive, route selection through the archive's temporal-LOD pyramid — the coarsest level covering the requested zoom — instead of the base-bucket tiles. No-ops unless the archive was built with `--temporal-lod` AND both `temporalLodLevels` and `getAvailableTemporalLodTiles` are wired (capability detection). Zooms already dispatched to the summary tier keep using it (summary is already a reduced tier). |

### Callbacks

| Option         | Type                           | Description                        |
| :------------- | :----------------------------- | :--------------------------------- |
| `onTileLoad`   | `(tile: Tile) => void`         | Called when a tile loads.          |
| `onTileUnload` | `(tile: Tile) => void`         | Called when a tile is evicted.     |
| `onTileError`  | `(error: Error, tileId) => void` | Called on tile load error. Dataset-level failures (selection pass could not query the directory) use the sentinel `tileId {x: -1, y: -1}` — ignore negative coords when keying per-tile state. |
| `onBufferChange` | `(runway: BufferedRunway) => void` | Invoked with a fresh `BufferedRunway` (probed from the play head in the committed prefetch direction) whenever a needed tile loads, a tile is evicted, or the needed-tile set changes. Trailing-edge throttled to ≤ 10 Hz. Wiring this enables coverage-index maintenance (one extra `getAvailableTiles` call per viewport change). |

## Methods

### `update(viewport, skipDebounce?): number`

Updates the tileset with a new viewport state. Returns a `frameNumber` which increments whenever the set of visible tiles changes.

- `viewport`: Object containing `{ bounds, zoom, time, timeWindow }`.
- `skipDebounce`: If `true`, loads tiles immediately (useful for time-only updates).

`update()` also runs speed-aware seek detection: a time jump beyond `max(timeWindow, |speed| × 1 s)` is treated as a seek and flushes the prefetch runway (a continuous fast playback's per-update step is NOT misread as a seek).

### `getVisibleTiles(): Tile[]`

Returns the loaded tiles for the current selection. Parent-fallback tiles are included only while at least one of their child cells at the primary zoom is still uncovered.

### `setAnimationState(playing, speed)`

Inform the tileset about animation playback state for prefetch sizing and direction. The `PlaybackGovernor` also asserts this while a gate holds the clock frozen, so prefetch keeps reaching ahead during buffering.

### `setInteractive(interactive: boolean): void` / `isInteractive: boolean` (getter)

Set/read the interactive (motion) bit — the `PlaybackGovernor` toggles it `true` on `beginScrub` and `false` on `endScrub`, driving the preview tier while the timeline is scrubbed. With no [Scrub-LOD](#scrub-lod-motion-tier) axis enabled (the default) this is STORED STATE ONLY — no selection change, no fetch, byte-identical behavior (the kill switch). With an axis enabled, the transition re-runs selection immediately: `true` serves the degraded motion tier; `false` restores the fine settle tier without waiting for the next clock tick.

### `isLoaded: boolean` (getter)

True when the current selection has SETTLED: nothing queued, no needed tile in flight. Mirrors upstream `Tileset2D.isLoaded` semantics including its error stance — a failed/cancelled tile counts as settled. Prefetch/overview lookahead never blocks this.

### `selectionVersion: number` (getter)

Monotonic needed-set version: bumps exactly when a selection pass changes WHICH tiles the viewport×window needs — never on tile arrival. Pair with `isLoaded` to derive once-per-settle viewport-load events.

### `getCacheStats()`

Returns `{ hits, misses, evictions, tileCount, cacheBytes, hitRate, activeRequests, priorityQueueLength, prefetchQueueLength }`. Hits/misses reflect genuine cache behaviour (a hit is a needed tile already decoded in memory).

### `getPrefetchDirection(): 1 | -1` / `getAnimationSpeed(): number`

The committed prefetch direction (with flip hysteresis) and the most recent estimated animation speed (sim-ms per real-ms).

### `cancelSupersededRequests(neededTileKeys): number`

Aborts in-flight work the current selection no longer needs. Tier-aware: prefetch-tier requests are EXEMPT (being ahead of the window is their normal operating condition), and a priority-tier batch is aborted only when EVERY member has left the needed set (a seek landed elsewhere).

### `clear()` / `finalize()`

`clear()` cancels all active requests (latching them so late deliveries can't corrupt the counters) and clears the cache; a pending overview preload settles with reason `'disabled'`. `finalize()` additionally stops all timers — call it on unmount.

## Buffer model (player buffering)

These APIs are what the [`PlaybackGovernor`](./playback-governor.md) consumes — the tileset structurally satisfies the governor's `BufferSource` contract. All of them are **pure directory + cache math (zero network)**: the coverage index — every needed tile id and its directory byte length at the primary zoom for the current viewport, across the FULL dataset time range, grouped by temporal bucket — is built once per spatial viewport change (lazily, on first buffer-API use or when `onBufferChange` is wired), and loaded status is resolved live against the tile registry.

### `getBufferedRunway(time, direction, horizonSimMs?): BufferedRunway`

How much contiguous sim-time ahead of `time` in `direction` is fully loaded — "can the clock advance into `[t, t+Δ]` without rendering a partial frame?". Returns:

```typescript
interface BufferedRunway {
  simMs: number;        // contiguous loaded span (stops at the first bucket with a missing tile)
  bytesPending: number; // directory byte sum of needed-but-not-loaded tiles in the horizon
                        // (in-flight counts as not loaded; 0 when getTileByteSize is unwired)
  horizonSimMs: number; // how far the probe looked
  complete: boolean;    // reached the horizon — or the dataset edge — with nothing missing
}
```

The default horizon is `max(4 × timeWindow, |animationSpeed| × 10 s)`, at least one temporal bucket. Cheap and synchronous; safe to call several times per second. Reports an empty, incomplete runway until the coverage index is built.

### `getBufferedRanges(opts?): Array<{ start, end }>`

Merged, ascending sim-time ranges that are fully loaded for the current viewport at the primary zoom across the FULL dataset time range — the data behind a scrubber's "buffered" bar. Capped at `maxRanges` (default 64). Cheap enough to poll at ~1 Hz.

### `estimateCost(range): { bytes, tiles }`

Exact cost of making `range` fully buffered: the directory byte sum (and count) of intersecting tiles that are NOT loaded. Byte-exact lookahead a video player cannot do — STT can because the directory knows every tile's length in advance.

### `estimateTimeToReadyMs(range): number | null`

Honest ETA: `estimateCost(range).bytes / measured throughput`. Returns `null` when `getThroughput` is unwired or has no signal yet — callers should show an indeterminate state, not a fake number.

### `flushPrefetch(): void`

Drop ALL pending prefetch work: clears the prefetch queue, aborts in-flight prefetch-tier requests (priority-tier requests untouched), and resets the runway bookkeeping so the next pass re-plans from the new play-head position. Called automatically on seeks, spatial viewport changes, and committed direction flips; safe to call manually.

### `preloadOverviewTier(opts?): Promise<OverviewPreloadResult>`

Eagerly load and PIN the coarsest tiles (zooms `minZoom..maxZoom`, default 0..1) across the full dataset time range and world bounds — the storyboard/thumbnail-strip analog. Budget-gated on DIRECTORY bytes before any fetch (default 20 MiB; `{ loaded: false, reason: 'over-budget' }` rejects without fetching). Fetches ride the LOWEST request tier (dispatched only when priority is idle); pinned headers are exempt from LRU eviction, `flushPrefetch()`, and supersession. Idempotent — repeat calls return the original attempt's promise. Pinned tiles deliberately do NOT count toward the primary-zoom readiness APIs above.

```typescript
interface OverviewPreloadResult {
  loaded: boolean;
  bytes: number;   // directory byte sum of candidates (reported even on rejection)
  tiles: number;
  reason?: 'over-budget' | 'no-tiles' | 'disabled' | 'error';
}
```

## Source

[packages/core/src/spatiotemporal-tileset.ts](../../packages/core/src/spatiotemporal-tileset.ts)
