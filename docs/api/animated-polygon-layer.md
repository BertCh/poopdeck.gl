# AnimatedPolygonLayer

The `AnimatedPolygonLayer` renders time-series polygon data (e.g., county boundaries, zones). It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU time-based visibility filtering for polygon features, with one `SolidPolygonLayer` sublayer per tile.

## Installation

```typescript
import { AnimatedPolygonLayer } from "@stt/deck.gl";
```

## Usage

```typescript
import { AnimatedPolygonLayer } from "@stt/deck.gl";

const layer = new AnimatedPolygonLayer({
  id: "covid-counties",
  data: "https://example.com/covid-counties/manifest.json",
  currentTime: 1672531200000,
  timeWindow: 86400000 * 30, // 30 days
  fillColor: "status", // categorical property name
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
| `extruded`        | `boolean`              | `false`    | Whether to extrude polygons in 3D.      |
| `elevationScale`  | `number`               | `1`        | GPU multiplier applied to every elevation value (constant and column-driven). Only takes effect when `extruded`. |
| `wireframe`       | `boolean`              | `false`    | Draw the edges of extruded polygons as a wireframe (SolidPolygonLayer pass-through). Only takes effect when `extruded`. |
| `material`        | `Material`             | `true`     | Lighting material for extruded polygons: `true` for the default phong material, `false` to disable lighting, or `{ambient, diffuse, shininess, specularColor}`. |
| `fadeInDuration`  | `number`               | `500`      | Duration (ms) for polygons to fade in.  |
| `fadeOutDuration` | `number`               | `500`      | Duration (ms) for polygons to fade out. |

### Data Accessors

| Property       | Type               | Default              | Description                                                                     |
| :------------- | :----------------- | :------------------- | :------------------------------------------------------------------------------ |
| `fillColor`    | `Color \| string`  | `[255, 140, 0, 180]` | Fill color: constant RGBA, or a property name for categorical coloring.        |
| `getFillColor` | `Color \| string \| null` | `null`        | Upstream-vocabulary alias of `fillColor`. Accepts a constant or a property-column NAME — NOT a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back). When set, it wins. |
| `elevation`    | `number \| string` | `0`                  | Elevation for extruded polygons: constant, or a numeric property name.          |
| `getElevation` | `number \| string \| null` | `null`        | Upstream-vocabulary alias of `elevation` (same domain rules).                   |
| `colorPalette` | `Color[]`          | 10-color palette     | Palette for categorical `fillColor` (GPU lookup, up to 4096 entries).           |

### Outline props (no effect)

`stroked`, `lineWidthUnits`, `lineWidth`, and `lineColor` have **no visual effect**: the fill sublayer is a `SolidPolygonLayer` with no outline pass. They remain on the type for API compatibility, and a runtime warning fires when they are set.

## Architecture & performance

- **GPU time filtering**: the shared
  [`TimeFilterExtension`](./time-filter-extension.md) runs directly on
  `SolidPolygonLayer` — polygons upload once per tile and time-window
  changes only update uniforms. (`PolygonTimeFilterExtension` is available
  as a deprecated alias.) Categorical fill colors likewise lift to the GPU
  via [`CategoryColorExtension`](./category-color-extension.md).
- **Per-vertex attribute expansion**: `SolidPolygonLayer`'s fill model is
  non-instanced, so the extension attributes resolve to per-vertex there
  and the layer expands start/end times, category indices, and per-feature
  elevations across each feature's vertex range — once per tile prep,
  cached, never on the draw path.
- **Pre-baked triangles (MLT-style)**: when the archive was built with
  `stt-build --pre-tessellate`, the tile's `triangles` index buffer feeds
  `SolidPolygonLayer` directly through the binary `indices` attribute,
  skipping deck.gl's CPU earcut at tile-arrival time entirely. (All
  sublayers run with `_normalize: false` — tile data is already
  pre-tesselated, so deck's re-normalization pass is bypassed either way.) **This is also the only path
  that renders polygon holes correctly** — `BinaryFeatures` collapses ring
  boundaries into per-feature vertex runs (see
  [Binary Features](./binary-features.md)), so on the non-pre-tessellated
  path interior rings are not distinguished from the outer ring and
  polygons with holes will mis-tessellate. Build polygon archives with
  `--pre-tessellate`.
- **Known limitation (tile-seam overdraw)**: polygons spanning a tile
  boundary are split across tiles and drawn by separate sublayers. With
  `opacity < 1` the two halves blend twice along the seam; extruded
  polygons can z-fight. Prefer fully-opaque fills.

The sublayer short id for `_subLayerProps` overrides is **`polygons`**: `_subLayerProps: { polygons: { type: MyLayer, ... } }`.

## Source

[packages/deck.gl/src/animated-polygon-layer.ts](../../packages/deck.gl/src/animated-polygon-layer.ts)
