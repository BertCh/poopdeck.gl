# AnimatedPolygonLayer

The `AnimatedPolygonLayer` renders time-series polygon data (e.g., county boundaries, zones). It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides time-based visibility filtering for polygon features.

## Installation

```typescript
import { AnimatedPolygonLayer } from "@stt/deck.gl";
```

## Usage

```typescript
import { AnimatedPolygonLayer } from "@stt/deck.gl";

const layer = new AnimatedPolygonLayer({
  id: "covid-counties",
  data: "https://example.com/covid-counties.stt",
  currentTime: 1672531200000,
  timeWindow: 86400000 * 30, // 30 days
  fillColor: "status", // Use categorical property
  colorPalette: [
    [255, 255, 178, 180],
    [254, 204, 92, 180],
    [253, 141, 60, 180],
    [240, 59, 32, 180],
    [189, 0, 38, 180],
  ],
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property          | Type                   | Default    | Description                             |
| :---------------- | :--------------------- | :--------- | :-------------------------------------- |
| `filled`          | `boolean`              | `true`     | Whether to fill polygons.               |
| `stroked`         | `boolean`              | `false`    | Whether to draw polygon outlines.       |
| `extruded`        | `boolean`              | `false`    | Whether to extrude polygons in 3D.      |
| `lineWidthUnits`  | `'pixels' \| 'meters'` | `'pixels'` | Units for line width (if stroked).      |
| `fadeInDuration`  | `number`               | `500`      | Duration (ms) for polygons to fade in.  |
| `fadeOutDuration` | `number`               | `500`      | Duration (ms) for polygons to fade out. |

### Data Accessors

| Property       | Type               | Default              | Description                                                                     |
| :------------- | :----------------- | :------------------- | :------------------------------------------------------------------------------ |
| `fillColor`    | `Color \| string`  | `[255, 140, 0, 180]` | Fill color. Can be a constant RGBA or a property name for categorical coloring. |
| `lineColor`    | `Color \| string`  | `[0, 0, 0, 255]`     | Line color (if stroked).                                                        |
| `lineWidth`    | `number \| string` | `1`                  | Line width.                                                                     |
| `elevation`    | `number \| string` | `0`                  | Elevation for extruded polygons.                                                |
| `colorPalette` | `Color[]`          | D3 category palette  | Color palette for categorical properties.                                       |

## Performance

Note: Unlike point and path layers, `AnimatedPolygonLayer` performs time filtering in JavaScript rather than GPU shaders because `SolidPolygonLayer` doesn't support the `TimeFilterExtension`. However, it still caches geometry and color attributes for efficient rendering.

## Source

[packages/deck.gl/src/animated-polygon-layer.ts](../../packages/deck.gl/src/animated-polygon-layer.ts)
