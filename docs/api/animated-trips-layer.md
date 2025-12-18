# AnimatedTripsLayer

The `AnimatedTripsLayer` renders animated trajectories with a "vehicle moving along route" effect. Paths are progressively drawn with a trailing fade, making it ideal for taxi routes, delivery paths, or any moving entity visualization.

## Installation

```typescript
import { AnimatedTripsLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { AnimatedTripsLayer } from '@stt/deck.gl';

const layer = new AnimatedTripsLayer({
  id: 'taxi-trips',
  data: 'https://example.com/taxis.stt',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  tripColor: [253, 128, 93, 255],
  tripWidth: 4,
  trailLength: 120000, // 2 minute trail
  fadeTrail: true,
  capRounded: true,
  jointRounded: true,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `widthScale` | `number` | `1` | Global multiplier for path widths. |
| `widthMinPixels` | `number` | `2` | Minimum width in pixels. |
| `widthMaxPixels` | `number` | `10` | Maximum width in pixels. |
| `trailLength` | `number` | `180000` | Trail length in milliseconds (3 minutes default). |
| `fadeTrail` | `boolean` | `true` | Whether the trail fades out. |
| `capRounded` | `boolean` | `true` | Round caps on path ends. |
| `jointRounded` | `boolean` | `true` | Round joints between path segments. |

### Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `tripColor` | `Color \| string` | `[253, 128, 93, 255]` | Trip color. Can be a constant RGBA or a property name for categorical coloring. |
| `tripWidth` | `number \| string` | `3` | Trip width. Can be a constant or a property name. |
| `colorPalette` | `Color[]` | Default palette | Color palette for categorical properties. |

## Difference from AnimatedPathLayer

| Feature | AnimatedPathLayer | AnimatedTripsLayer |
|---------|-------------------|-------------------|
| Effect | Static paths with time filtering | Progressive drawing ("moving vehicle") |
| Trail | Optional fade behind current position | Always trails behind current time |
| Use case | Ship tracks, flight paths | Taxi routes, delivery animations |

## Performance

The layer uses several optimizations:

- **Per-vertex progress**: Computed once per tile and cached
- **GPU trail rendering**: Trail fade calculated entirely in shaders
- **Layer caching**: Layers are cached and reused when tiles don't change

## Source

[packages/deck.gl/src/animated-trips-layer.ts](../../packages/deck.gl/src/animated-trips-layer.ts)

