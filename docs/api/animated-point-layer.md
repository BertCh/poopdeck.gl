# AnimatedPointLayer

The `AnimatedPointLayer` renders time-series point data as circles. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and adds specialized rendering logic for points, including radius scaling and color accessors.

## Installation

```typescript
import { AnimatedPointLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { AnimatedPointLayer } from '@stt/deck.gl';

const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: 'https://example.com/earthquakes.stt',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  getFillColor: f => [255, 0, 0],
  getRadius: f => f.properties.magnitude * 1000
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `radiusScale` | `number` | `1` | Global multiplier for point radii. |
| `radiusUnits` | `'pixels' \| 'meters'` | `'pixels'` | Units for radius. Use `'meters'` for geospatial accuracy. |
| `fadeInDuration` | `number` | `300` | Duration (ms) for points to fade in when they appear. |
| `fadeOutDuration` | `number` | `300` | Duration (ms) for points to fade out when they disappear. |

### Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `getFillColor` | `Accessor<[r, g, b, a]>` | `[255, 128, 0, 255]` | Accessor for point color. |
| `getRadius` | `Accessor<number>` | `5` | Accessor for point radius. |
| `getPosition` | `Accessor<[lon, lat]>` | `undefined` | Optional accessor for position. If not provided, position is automatically decoded from the tile geometry. |

## Source

[packages/deck.gl/src/animated-point-layer.ts](../../packages/deck.gl/src/animated-point-layer.ts)



