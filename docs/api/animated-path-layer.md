# AnimatedPathLayer

The `AnimatedPathLayer` renders time-series path/trajectory data as lines. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU-accelerated time filtering.

It operates in **window mode**: each feature is shown (with optional fade) whenever its `[startTime, endTime]` overlaps the current time window — whole paths render at once. For a "vehicle moving along the route" trailing effect, use [`AnimatedTripsLayer`](./animated-trips-layer.md) instead, which renders per-vertex with a fading trail.

## Installation

```typescript
import { AnimatedPathLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { AnimatedPathLayer } from '@stt/deck.gl';

const layer = new AnimatedPathLayer({
  id: 'ship-tracks',
  data: 'https://example.com/ships.stt',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  pathColor: [0, 150, 255, 255],
  pathWidth: 3,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `widthScale` | `number` | `1` | Global multiplier for path widths. |
| `widthUnits` | `'pixels' \| 'meters'` | `'pixels'` | Units for width. |
| `fadeInDuration` | `number` | `300` | Duration (ms) for paths to fade in when their time range enters the window. |
| `fadeOutDuration` | `number` | `300` | Duration (ms) for paths to fade out when their time range leaves the window. |

### Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `pathColor` | `Color \| string` | `[0, 150, 255, 255]` | Path color. Can be a constant RGBA or a property name for categorical coloring. |
| `pathWidth` | `number \| string` | `3` | Path width. Can be a constant or a property name for numeric values. |
| `colorPalette` | `Color[]` | D3 category palette | Color palette for categorical properties. |

## Performance

The layer uses several optimizations:

- **Binary data interface**: Typed arrays passed directly to GPU
- **Layer caching**: Layers are cached and reused when tiles don't change
- **TimeFilterExtension**: Time filtering happens entirely in GPU shaders

## Source

[packages/deck.gl/src/animated-path-layer.ts](../../packages/deck.gl/src/animated-path-layer.ts)


