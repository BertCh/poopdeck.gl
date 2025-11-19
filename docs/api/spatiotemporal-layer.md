# SpatioTemporalLayer

The `SpatioTemporalLayer` is the base layer for visualizing spatiotemporal data from `.stt` archives. It handles the complex logic of data loading, caching, time synchronization, and coordinate decoding, allowing subclasses to focus purely on rendering.

It follows the **[Tileset](https://loaders.gl/modules/tiles/docs/api-reference/tileset-3d)** pattern from loaders.gl and integrates seamlessly with deck.gl's composite layer system.

## Installation

```typescript
import { SpatioTemporalLayer } from '@stt/deck.gl';
```

## Usage

This is an abstract base layer. Typically, you would use a subclass like [`AnimatedPointLayer`](./animated-point-layer.md) or extend it yourself.

```typescript
class MyCustomLayer extends SpatioTemporalLayer {
  renderLayers() {
    const { tiles, currentTime } = this.state;
    // ... implementation ...
  }
}
```

## Properties

Inherits from all [CompositeLayer](https://deck.gl/docs/api-reference/core/composite-layer) properties.

### Data Properties

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `data` | `string` | `""` | URL to the `.stt` archive. |
| `currentTime` | `number` | `Date.now()` | Current timestamp in Unix milliseconds. The layer will automatically filter and render data for this time. |
| `timeWindow` | `number` | `86400000` | Time window duration in milliseconds (e.g., 1 day). Features falling within `currentTime ± timeWindow/2` will be considered visible. |
| `timeController` | `TimeController` | `undefined` | Optional `TimeController` instance to synchronize animation state. |

### Render Properties

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `opacity` | `number` | `1.0` | Layer opacity (0.0 to 1.0). |
| `visible` | `boolean` | `true` | Whether the layer is visible. |

### Load Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `maxRequests` | `number` | `6` | Maximum number of concurrent HTTP requests for tiles. Aligns with browser limits. |
| `debounceTime` | `number` | `300` | Debounce time (ms) for viewport updates. Prevents excessive tile requests during panning/zooming. |
| `maxCacheSize` | `number` | `200` | Maximum number of tiles to keep in the LRU cache. |
| `maxCacheByteSize` | `number` | `500MB` | Maximum memory usage (in bytes) for the tile cache before eviction. |

### Callbacks

| Property | Type | Description |
| :--- | :--- | :--- |
| `onViewportLoad` | `(tiles: Tile[]) => void` | Called when all tiles in the current viewport have finished loading. |
| `onTileLoad` | `(tile: Tile) => void` | Called when a single tile successfully loads. |
| `onTileUnload` | `(tile: Tile) => void` | Called when a tile is evicted from the cache. |

## Source

[packages/deck.gl/src/spatiotemporal-layer.ts](../../packages/deck.gl/src/spatiotemporal-layer.ts)

