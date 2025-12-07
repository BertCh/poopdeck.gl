# SpatioTemporalTileLayer

A deck.gl layer that extends `@deck.gl/geo-layers` `TileLayer` for 4D (x, y, z, t) tile loading. This is the recommended layer for new projects as it leverages deck.gl's built-in tile management infrastructure.

## Features

- **TileLayer Integration**: Inherits deck.gl's viewport culling, request management, and cache eviction
- **Temporal Filtering**: Adds time-based filtering for 4D spatiotemporal data
- **Request Optimization**: Uses deck.gl's request queue with configurable concurrency
- **Memory Management**: Automatic cache eviction based on size and count limits

## Installation

```typescript
import { SpatioTemporalTileLayer } from "@stt/deck.gl";
```

## Usage

```typescript
import DeckGL from "@deck.gl/react";
import { SpatioTemporalTileLayer } from "@stt/deck.gl";
import { ScatterplotLayer } from "@deck.gl/layers";

function App() {
  const layer = new SpatioTemporalTileLayer({
    id: 'stt-layer',
    data: 'https://example.com/data.stt',
    currentTime: Date.now(),
    timeWindow: 86400000, // 1 day
    
    // Custom sub-layer rendering
    renderSubLayers: (props) => {
      const { tile, data } = props;
      if (!data?.tile?.layers) return null;
      
      return data.tile.layers.map((layer, i) => 
        new ScatterplotLayer({
          id: `${props.id}-${i}`,
          data: layer.features,
          getPosition: d => d.positions[0],
          getRadius: 100,
          getFillColor: [255, 128, 0],
        })
      );
    },
  });

  return <DeckGL layers={[layer]} />;
}
```

## Props

### Data Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `string` | Required | URL to the STT archive |
| `currentTime` | `number` | `Date.now()` | Current time in Unix milliseconds |
| `timeWindow` | `number` | `86400000` | Time window size in milliseconds |
| `timeRange` | `{ start: number; end: number }` | - | Optional full time range of the dataset |

### TileLayer Props (Inherited)

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `maxRequests` | `number` | `6` | Maximum concurrent tile requests |
| `debounceTime` | `number` | `0` | Debounce time for viewport changes (ms) |
| `maxCacheSize` | `number` | `200` | Maximum number of cached tiles |
| `maxCacheByteSize` | `number` | `500MB` | Maximum cache size in bytes |
| `refinementStrategy` | `string` | `'best-available'` | Tile refinement strategy |

### Callbacks

| Prop | Type | Description |
|------|------|-------------|
| `onMetadataLoad` | `(metadata: ArchiveMetadata) => void` | Called when archive metadata is loaded |
| `renderSubLayers` | `(props) => Layer \| Layer[]` | Custom sub-layer rendering function |

## Comparison with SpatioTemporalLayer

| Feature | SpatioTemporalLayer | SpatioTemporalTileLayer |
|---------|---------------------|-------------------------|
| Tile Management | Custom `SpatiotemporalTileset` | deck.gl `Tileset2D` |
| Viewport Culling | Custom implementation | Built-in deck.gl |
| Request Queue | Custom implementation | deck.gl's optimized queue |
| API Stability | Stable | Experimental |
| Best For | Existing projects | New projects |

## Source

[packages/deck.gl/src/spatiotemporal-tile-layer.ts](../../packages/deck.gl/src/spatiotemporal-tile-layer.ts)


