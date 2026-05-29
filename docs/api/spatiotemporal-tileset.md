# SpatiotemporalTileset

The `SpatiotemporalTileset` class manages the lifecycle, loading, and caching of spatiotemporal tiles. It is the "brain" behind the [`SpatioTemporalLayer`](./spatiotemporal-layer.md), determining which tiles to load based on the current viewport and time window.

It is inspired by loaders.gl's [Tileset3D](https://loaders.gl/modules/tiles/docs/api-reference/tileset-3d) but specifically designed for the 4th dimension (Time).

## Installation

```typescript
import { SpatiotemporalTileset } from "@stt/core";
```

## Usage

Typically used internally by `SpatioTemporalLayer`, but can be used independently for custom implementations.

```typescript
const tileset = new SpatiotemporalTileset({
  maxRequests: 64,
  getAvailableTiles: (bounds, zoom, timeRange) =>
    archive.getTileIdsInBounds(bounds, zoom, timeRange),
  getTileData: (tileId) => archive.getTile(tileId),
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
| `getAvailableTiles` | `Function` | Async callback to query tile IDs in current view.        |
| `getTileData`       | `Function` | Async callback to fetch and decode a specific tile.      |

### Tile Loading Options

| Option             | Type     | Default | Description                                     |
| :----------------- | :------- | :------ | :---------------------------------------------- |
| `maxRequests`      | `number` | `12`    | Maximum concurrent tile fetches (browser per-origin cap). |
| `debounceTime`     | `number` | `0`     | Debounce time (ms) for viewport updates.        |
| `maxCacheSize`     | `number` | `2000`  | Maximum tiles in LRU cache.                     |
| `minZoom`          | `number` | `0`     | Minimum zoom level available in data.           |
| `maxZoom`          | `number` | `22`    | Maximum zoom level available in data.           |

### Refinement Options

| Option               | Type                                | Default            | Description                                            |
| :------------------- | :---------------------------------- | :----------------- | :----------------------------------------------------- |
| `refinementStrategy` | `'best-available' \| 'no-overlap'`  | `'best-available'` | `'best-available'` surfaces parent tiles while detailed tiles load — also covers the gap when `--min-features-per-tile` drops sparse deep-zoom tiles. |

### Prefetch Options

| Option          | Type      | Default | Description                                          |
| :-------------- | :-------- | :------ | :--------------------------------------------------- |
| `enablePrefetch`| `boolean` | `true`  | Enable predictive prefetching for animations.        |
| `prefetchAhead` | `number`  | `30000` | How far ahead to prefetch (animation time in ms).    |
| `prefetchSteps` | `number`  | `4`     | Number of time-window steps to prefetch.             |

### Tier dispatch

When the archive's metadata declares a `summaryTier` (built with
`stt-build --summary-tier h3`), the tileset routes requests in the
declared `[minZoom..=maxZoom]` to summary tiles instead of the raw tier.
This is driven by the `tier` option (`'raw' | 'summary' | 'auto'`) plus a
`getAvailableSummaryTiles` callback (wire it to
`STTArchive.getSummaryTileIdsInBounds`); `'auto'` uses summary inside the
summary zoom range and raw outside.

Temporal-LOD dispatch is **not** yet wired into the tileset. The reader
API exposes it — `STTArchive.pickTemporalLodForZoom`,
`getTileIdsInBoundsForTemporalLod`, and
`getTilesInBoundsForTemporalLod` — but no tileset or renderer calls them
automatically today, so an app that wants coarser temporal tiers must
select the LOD level and request those tiles itself.

### Callbacks

| Option         | Type                           | Description                        |
| :------------- | :----------------------------- | :--------------------------------- |
| `onTileLoad`   | `(tile: Tile) => void`         | Called when a tile loads.          |
| `onTileUnload` | `(tile: Tile) => void`         | Called when a tile is evicted.     |
| `onTileError`  | `(error: Error, tileId) => void` | Called on tile load error.       |

## Methods

### `update(viewport, skipDebounce?): number`

Updates the tileset with a new viewport state. Returns a `frameNumber` which increments whenever the set of visible tiles changes.

- `viewport`: Object containing `{ bounds, zoom, time, timeWindow }`.
- `skipDebounce`: If `true`, loads tiles immediately (useful for time-only updates).

### `getVisibleTiles(): Tile[]`

Returns the array of tiles that are currently loaded and intersect with the current time window.

### `getCacheStats(): CacheStats`

Returns statistics about the cache (hits, misses, active requests, cached tiles count).

### `setAnimationState(playing, speed)`

Inform the tileset about animation playback state for prefetch optimization.

### `finalize()`

Cancels all active requests and cleans up resources.

### `clear()`

Cancels all active requests and clears the cache.

## Source

[packages/core/src/spatiotemporal-tileset.ts](../../packages/core/src/spatiotemporal-tileset.ts)
