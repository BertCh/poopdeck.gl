# AnimatedPointLayer

The `AnimatedPointLayer` renders time-series point data as circles. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU-accelerated time filtering with support for categorical coloring and 3D elevation.

## Installation

```typescript
import { AnimatedPointLayer } from "@stt/deck.gl";
```

## Usage

```typescript
import { AnimatedPointLayer } from "@stt/deck.gl";

const layer = new AnimatedPointLayer({
  id: "earthquakes",
  data: "https://example.com/earthquakes.stt",
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  fillColor: [255, 128, 0, 255],
  radius: 5,
  radiusScale: 2,
  radiusUnits: "meters",
});
```

### With Categorical Coloring

```typescript
const layer = new AnimatedPointLayer({
  id: "flights",
  data: "https://example.com/flights.stt",
  currentTime: Date.now(),
  timeWindow: 3600000,
  fillColor: "airline", // Use categorical property name
  colorPalette: [
    [31, 119, 180, 255],
    [255, 127, 14, 255],
    [44, 160, 44, 255],
  ],
  radius: "altitude", // Use numeric property for radius
});
```

### With 3D Elevation

```typescript
const layer = new AnimatedPointLayer({
  id: "aircraft",
  data: "https://example.com/aircraft.stt",
  currentTime: Date.now(),
  timeWindow: 60000,
  use3D: true,
  elevationProperty: "altitude",
  elevationScale: 0.3048, // feet to meters
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property         | Type                              | Default | Description                                        |
| :--------------- | :-------------------------------- | :------ | :------------------------------------------------- |
| `radiusScale`    | `number`                          | `1`     | Global multiplier for point radii.                 |
| `radiusUnits`    | `'pixels' \| 'meters' \| 'common'` | `'pixels'` | Units for radius.                               |
| `fadeInDuration` | `number`                          | `300`   | Duration (ms) for points to fade in.               |
| `fadeOutDuration`| `number`                          | `300`   | Duration (ms) for points to fade out.              |

### 3D Options

| Property           | Type      | Default | Description                                                    |
| :----------------- | :-------- | :------ | :------------------------------------------------------------- |
| `use3D`            | `boolean` | `false` | Enable 3D positions with altitude/elevation.                   |
| `elevationProperty`| `string`  | `null`  | Property name to extract elevation from (e.g., `'altitude'`).  |
| `elevationScale`   | `number`  | `1`     | Scale factor for elevation values.                             |

### Data Accessors

| Property       | Type              | Default              | Description                                                                    |
| :------------- | :---------------- | :------------------- | :----------------------------------------------------------------------------- |
| `fillColor`    | `Color \| string` | `[255, 128, 0, 255]` | Fill color. Can be a constant RGBA or a property name for categorical coloring. |
| `radius`       | `number \| string`| `5`                  | Point radius. Can be a constant or a property name for numeric values.         |
| `colorPalette` | `Color[]`         | D3 category palette  | Color palette for categorical properties (up to 10 colors).                    |

## Performance

The layer uses several optimizations:

- **Per-tile binary sublayers**: each visible tile produces one
  `ScatterplotLayer` (no cross-tile consolidation). A new tile arriving
  adds exactly one sublayer and one GPU upload — it never re-uploads or
  rebuilds existing tiles.
- **Binary data interface**: each sublayer uses deck.gl's binary
  `data: { length, attributes }` shape, so the Arrow-backed typed arrays go
  straight to the GPU.
- **Sublayer memoization**: each per-tile `ScatterplotLayer` instance is
  cached and the same reference is returned across `renderLayers()` calls,
  so deck.gl short-circuits prop diffing when only time changes.
- **TimeFilterExtension**: time filtering happens entirely in GPU shaders;
  each sublayer rebases time against its own per-tile `timeOffset`.

## Source

[packages/deck.gl/src/animated-point-layer.ts](../../packages/deck.gl/src/animated-point-layer.ts)
