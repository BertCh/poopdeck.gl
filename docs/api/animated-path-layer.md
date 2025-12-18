# AnimatedPathLayer

The `AnimatedPathLayer` renders time-series path/trajectory data as lines. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU-accelerated time filtering with optional trailing fade effects.

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
  trail: true,
  trailLength: 5000, // 5 seconds
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `widthScale` | `number` | `1` | Global multiplier for path widths. |
| `widthUnits` | `'pixels' \| 'meters'` | `'pixels'` | Units for width. |
| `trail` | `boolean` | `true` | Enable trailing fade effect. |
| `trailLength` | `number` | `5000` | Trail length in milliseconds. |
| `fadeInDuration` | `number` | `300` | Duration (ms) for paths to fade in. |
| `fadeOutDuration` | `number` | `300` | Duration (ms) for paths to fade out. |

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

