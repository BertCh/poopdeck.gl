# HeatmapTimeLayer

The `HeatmapTimeLayer` renders temporal point data as an animated density heatmap. Points are aggregated into a GPU-accelerated heatmap that animates smoothly over time.

## Installation

```typescript
import { HeatmapTimeLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { HeatmapTimeLayer } from '@stt/deck.gl';

const layer = new HeatmapTimeLayer({
  id: 'earthquake-heatmap',
  data: 'https://example.com/earthquakes.stt',
  currentTime: 1672531200000,
  timeWindow: 86400000, // 1 day
  radiusPixels: 30,
  intensity: 1,
  weightProperty: 'magnitude',
  colorRange: [
    [255, 255, 178, 255],
    [254, 204, 92, 255],
    [253, 141, 60, 255],
    [240, 59, 32, 255],
    [189, 0, 38, 255],
  ],
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `radiusPixels` | `number` | `30` | Radius of influence for each point in pixels. |
| `intensity` | `number` | `1` | Intensity multiplier for each point. |
| `aggregation` | `'SUM' \| 'MEAN'` | `'SUM'` | Aggregation method for overlapping points. |
| `colorRange` | `Color[]` | Yellow-Red gradient | Color range from low to high density. |

### Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `weightProperty` | `string` | `null` | Property name to use for point weights. If not provided, all points have weight 1. |

## Performance

The layer uses several optimizations:

- **Cached tile points**: Points are extracted once per tile and cached
- **Reusable arrays**: Visible point arrays are reused between frames
- **Typed arrays**: Uses Float64Array for positions and Float32Array for weights

## Source

[packages/deck.gl/src/heatmap-time-layer.ts](../../packages/deck.gl/src/heatmap-time-layer.ts)

