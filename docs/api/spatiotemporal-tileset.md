# SpatiotemporalTileset

The `SpatiotemporalTileset` class manages the lifecycle, loading, and caching of spatiotemporal tiles. It is the "brain" behind the [`SpatioTemporalLayer`](./spatiotemporal-layer.md), determining which tiles to load based on the current viewport and time window.

It is inspired by loaders.gl's [Tileset3D](https://loaders.gl/modules/tiles/docs/api-reference/tileset-3d) but specifically designed for the 4th dimension (Time).

## Installation

```typescript
import { SpatiotemporalTileset } from '@stt/core';
```

## Usage

Typically used internally by `SpatioTemporalLayer`, but can be used independently for custom implementations.

```typescript
const tileset = new SpatiotemporalTileset({
  maxRequests: 6,
  getAvailableTiles: (bounds, zoom, timeRange) => archive.getTileIdsInBounds(...),
  getTileData: (tileId) => archive.getTile(tileId),
  onTileLoad: (tile) => console.log('Loaded', tile)
});

// Update every frame or viewport change
tileset.update({
  bounds: currentBounds,
  zoom: currentZoom,
  time: Date.now(),
  timeWindow: 86400000
});

const visibleTiles = tileset.getVisibleTiles();
```

## Constructor Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `maxRequests` | `number` | `6` | Maximum concurrent tile fetches. |
| `debounceTime` | `number` | `300` | Debounce time (ms) for viewport updates. |
| `maxCacheSize` | `number` | `200` | Max tiles in LRU cache. |
| `maxCacheByteSize` | `number` | `500MB` | Max cache size in bytes. |
| `refinementStrategy` | `'best-available' \| 'no-overlap'` | `'best-available'` | Strategy for loading tiles. `'best-available'` loads parent tiles while detailed tiles are loading. |
| `getAvailableTiles` | `Function` | **Required** | Async callback to query the archive for tile IDs in the current view. |
| `getTileData` | `Function` | **Required** | Async callback to fetch and decode a specific tile. |

## Methods

### `update(viewport: Viewport, skipDebounce?: boolean): number`
Updates the tileset with a new viewport state. Returns a `frameNumber` which increments whenever the set of visible tiles changes.

*   `viewport`: Object containing `{ bounds, zoom, time, timeWindow }`.
*   `skipDebounce`: If `true`, loads tiles immediately (useful for time-only updates).

### `getVisibleTiles(): Tile[]`
Returns the array of tiles that are currently loaded and intersect with the current time window.

### `getCacheStats(): CacheStats`
Returns statistics about the cache (hits, misses, active requests).

### `clear()`
Cancels all active requests and clears the cache.

## Source

[packages/core/src/spatiotemporal-tileset.ts](../../packages/core/src/spatiotemporal-tileset.ts)



