# AnimatedPolygonLayer

The `AnimatedPolygonLayer` renders time-series polygon data (e.g., county boundaries, zones). It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU time-based visibility filtering for polygon features, with one `SolidPolygonLayer` sublayer per tile.

## Installation

```typescript
import { AnimatedPolygonLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedPolygonLayer } from '@poopdeck.gl/layers';

const layer = new AnimatedPolygonLayer({
  id: 'covid-counties',
  data: 'https://example.com/covid-counties/manifest.json',
  currentTime: 1672531200000,
  timeWindow: 86400000 * 30, // 30 days
  fillColor: 'status', // categorical property name
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

| Property          | Type       | Default | Description                                                                                                                                                     |
| :---------------- | :--------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filled`          | `boolean`  | `true`  | Whether to fill polygons.                                                                                                                                       |
| `extruded`        | `boolean`  | `false` | Whether to extrude polygons in 3D.                                                                                                                              |
| `elevationScale`  | `number`   | `1`     | GPU multiplier applied to every elevation value (constant and column-driven). Only takes effect when `extruded`.                                                |
| `wireframe`       | `boolean`  | `false` | Draw the edges of extruded polygons as a wireframe (SolidPolygonLayer pass-through). Only takes effect when `extruded`.                                         |
| `material`        | `Material` | `true`  | Lighting material for extruded polygons: `true` for the default phong material, `false` to disable lighting, or `{ambient, diffuse, shininess, specularColor}`. |
| `fadeInDuration`  | `number`   | `500`   | Duration (ms) for polygons to fade in.                                                                                                                          |
| `fadeOutDuration` | `number`   | `500`   | Duration (ms) for polygons to fade out.                                                                                                                         |

### Data Accessors

| Property              | Type                            | Default              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :-------------------- | :------------------------------ | :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fillColor`           | `Color \| string`               | `[255, 140, 0, 180]` | Fill color: constant RGBA, or a property name for categorical coloring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `getFillColor`        | `Color \| string \| null`       | `null`               | Upstream-vocabulary alias of `fillColor`. Accepts a constant or a property-column NAME — NOT a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back). When set, it wins.                                                                                                                                                                                                                                                                                                                                                            |
| `elevation`           | `number \| string`              | `0`                  | Elevation for extruded polygons: constant, or a numeric property name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `getElevation`        | `number \| string \| null`      | `null`               | Upstream-vocabulary alias of `elevation` (same domain rules).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `colorPalette`        | `Color[]`                       | 10-color palette     | Palette for categorical `fillColor` (GPU lookup, up to 4096 entries).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `colorMapping`        | `Record<string, Color> \| null` | `null`               | Explicit category-string → color map. When set together with a string `fillColor`, each tile resolves its own category dictionary through this map into a per-tile palette, so a category keeps the same color across tiles whose dictionaries differ in order or subset — the bare `colorPalette` assigns colors by first-seen category index and drifts tile to tile. Stays on the GPU `CategoryColorExtension` path (the mapping only changes how the per-tile palette is built, not how it's sampled). Categories absent from the map fall back to `colorMappingDefault`. |
| `colorMappingDefault` | `Color`                         | `[0, 0, 0, 0]`       | Fallback color for categories absent from `colorMapping` (transparent by default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Outline pass

Set `stroked: true` to draw an outline. This emits a **second sublayer** per
tile — a `PathLayer` on the polygon ring geometry (`_pathType: 'loop'`), drawn
over the fill. The outline is only constructed when `stroked` is true. For a
standalone outline with no fill, set `filled: false` and `stroked: true`.

| Property             | Type                               | Default          | Description                                                                                                                                                           |
| :------------------- | :--------------------------------- | :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroked`            | `boolean`                          | `false`          | Draw a `PathLayer` outline on each polygon's rings (a second sublayer per tile).                                                                                      |
| `getLineColor`       | `Color \| string \| null`          | `[0, 0, 0, 255]` | Outline color: a constant RGBA or a property-column NAME (not a function accessor). Also sets the `wireframe: true` extruded-edge color, which otherwise stays black. |
| `getLineWidth`       | `number \| string \| null`         | `1`              | Outline width: a constant or a numeric property-column name. Interpreted in `lineWidthUnits`, clamped by `lineWidthMinPixels`. Only takes effect when `stroked`.      |
| `lineWidthUnits`     | `'pixels' \| 'meters' \| 'common'` | `'meters'`       | Units for `getLineWidth` (PathLayer pass-through).                                                                                                                    |
| `lineWidthMinPixels` | `number`                           | `0`              | Clamp the outline to at least this many on-screen pixels so thin borders stay visible at low zoom.                                                                    |
| `lineJointRounded`   | `boolean`                          | `false`          | Rounded outline joints (`PathLayer.jointRounded`).                                                                                                                    |
| `lineMiterLimit`     | `number`                           | `4`              | Miter-joint length cap (multiples of line width); applies when `lineJointRounded` is false.                                                                           |
| `lineDashJustified`  | `boolean`                          | `false`          | Justify outline dashes to segment endpoints (deck parity).                                                                                                            |

## Architecture & performance

- **GPU time filtering**: the shared
  [`TimeFilterExtension`](./time-filter-extension.md) runs directly on
  `SolidPolygonLayer` — polygons upload once per tile and time-window
  changes only update uniforms. Categorical fill colors likewise lift to the
  GPU via [`CategoryColorExtension`](./category-color-extension.md).
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

The sublayer short ids for `_subLayerProps` overrides are **`polygons`** (the fill) and **`outline`** (the `stroked` `PathLayer`): `_subLayerProps: { polygons: { type: MyLayer, ... }, outline: { ... } }`.

## Source

[packages/layers/src/layers/core/animated-polygon-layer.ts](../../packages/layers/src/layers/core/animated-polygon-layer.ts)
