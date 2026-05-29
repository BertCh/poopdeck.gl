# SpatioTemporalLayer

The `SpatioTemporalLayer` is the base layer for visualizing spatiotemporal data from `.stt` archives. It handles the complex logic of data loading, caching, time synchronization, and coordinate decoding, allowing subclasses to focus purely on rendering.

It follows the **[Tileset](https://loaders.gl/modules/tiles/docs/api-reference/tileset-3d)** pattern from loaders.gl and integrates seamlessly with deck.gl's composite layer system.

## Installation

```typescript
import { SpatioTemporalLayer } from "@stt/deck.gl";
```

## Usage

This is an abstract base layer. Typically, you would use a subclass like [`AnimatedPointLayer`](./animated-point-layer.md) or extend it yourself.

```typescript
class MyCustomLayer extends SpatioTemporalLayer {
  renderLayers() {
    const { tiles } = this.state;
    const currentTime = this.getCurrentTime();
    // ... implementation ...
  }
}
```

## Properties

Inherits from all [CompositeLayer](https://deck.gl/docs/api-reference/core/composite-layer) properties.

### Data Properties

| Property         | Type                              | Default       | Description                                                                         |
| :--------------- | :-------------------------------- | :------------ | :---------------------------------------------------------------------------------- |
| `data`           | `string`                          | `""`          | URL to the `.stt` archive.                                                          |
| `currentTime`    | `number`                          | `Date.now()`  | Current timestamp in Unix milliseconds.                                             |
| `timeWindow`     | `number`                          | `86400000`    | Time window duration in milliseconds (1 day default).                               |
| `timeRange`      | `{ start: number; end: number }`  | `null`        | Full time range of the dataset (for precision handling).                            |
| `timeController` | `TimeController`                  | `undefined`   | Optional `TimeController` instance to synchronize animation state.                  |

### Tile Loading Options

| Property           | Type     | Default       | Description                                                                |
| :----------------- | :------- | :------------ | :------------------------------------------------------------------------- |
| `maxRequests`      | `number` | `12`          | Maximum concurrent tile requests. Sits at 12 because browsers cap concurrent connections per origin around there. |
| `debounceTime`     | `number` | `0`           | Debounce time (ms) for viewport updates. Set to 0 for responsive animation. |
| `maxCacheSize`     | `number` | `2000`        | Maximum number of tiles to keep in the LRU cache.                          |

### Prefetch Options

| Property        | Type      | Default | Description                                                   |
| :-------------- | :-------- | :------ | :------------------------------------------------------------ |
| `enablePrefetch`| `boolean` | `true`  | Enable predictive prefetching for smooth animation playback.  |
| `prefetchAhead` | `number`  | `30000` | How far ahead to prefetch in animation time (milliseconds).   |
| `prefetchSteps` | `number`  | `4`     | Number of time-window steps to prefetch ahead.                |

### Callbacks

| Property         | Type                      | Description                                            |
| :--------------- | :------------------------ | :----------------------------------------------------- |
| `onViewportLoad` | `(tiles: Tile[]) => void` | Called when all tiles in the current viewport loaded.  |
| `onTileLoad`     | `(tile: Tile) => void`    | Called when a single tile successfully loads.          |
| `onTileUnload`   | `(tile: Tile) => void`    | Called when a tile is evicted from the cache.          |

### Advanced Options

| Property      | Type                      | Default | Description                          |
| :------------ | :------------------------ | :------ | :----------------------------------- |
| `loadOptions` | `Record<string, unknown>` | `{}`    | Loaders.gl options for data loading. |

## Methods

### `getCurrentTime(): number`

Get the current animation time. Subclasses should use this instead of accessing state directly for performance (avoids setState overhead during animation).

### `isLoaded: boolean`

Property indicating whether the layer has finished initial loading.

## Performance

The layer is optimized for high-performance animation:

- **Request concurrency**: 12 parallel tile requests (matching browser
  per-origin caps); prefetch consumes ≤ 50 % of that budget while
  animating.
- **Prefetching**: tiles are loaded ahead of playback time, aligned with
  the archive's temporal bucket boundaries.
- **LRU caching**: 2000-tile cache; eviction respects the active time
  window so tiles needed by the current animation frame aren't dropped.
- **Time updates via getter**: passing `timeController` avoids React
  re-renders during animation — the layer reads time in `draw()`.

## Source

[packages/deck.gl/src/spatiotemporal-layer.ts](../../packages/deck.gl/src/spatiotemporal-layer.ts)
