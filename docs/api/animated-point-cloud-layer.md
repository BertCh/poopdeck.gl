# AnimatedPointCloudLayer

The `AnimatedPointCloudLayer` renders time-windowed 3D point clouds as phong-lit points. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and wraps deck.gl's `PointCloudLayer` with the [`TimeFilterExtension`](./time-filter-extension.md) (window mode): each feature is a lit 3D point with a position, an optional surface normal, and a colour. It is the middle ground between the flat billboards of [`AnimatedPointLayer`](./animated-point-layer.md) and oriented Gaussian surfels — a scan/overview primitive that animates points on and off (with fade ramps) as the time window sweeps.

## Installation

```typescript
import { AnimatedPointCloudLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedPointCloudLayer } from '@poopdeck.gl/layers';

const layer = new AnimatedPointCloudLayer({
  id: 'scan',
  data: 'https://example.com/scan/manifest.json',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  pointSize: 4,
  sizeUnits: 'pixels',
  color: [255, 255, 255, 255],
});
```

### Per-point RGB from camera-sampled columns

```typescript
const layer = new AnimatedPointCloudLayer({
  id: 'lidar',
  data: '/data/lidar/manifest.json',
  currentTime,
  timeWindow: 5000,
  // Three NUMERIC columns (each 0–255) → [r, g, b, 255] per point.
  rgbColorColumns: ['r', 'g', 'b'],
  pointSize: 2,
});
```

### Elevation from a column + categorical colour

```typescript
const layer = new AnimatedPointCloudLayer({
  id: 'returns',
  data: '/data/returns/manifest.json',
  currentTime,
  color: 'surface', // categorical property name → CPU-expanded, phong-lit
  colorPalette: [
    [31, 119, 180, 255],
    [255, 127, 14, 255],
    [44, 160, 44, 255],
  ],
  elevationProperty: 'height', // z = height × elevationScale
  elevationScale: 1,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property          | Type                               | Default    | Description                                                                                                                                                                                          |
| :---------------- | :--------------------------------- | :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sizeUnits`       | `'meters' \| 'pixels' \| 'common'` | `'pixels'` | Units for `pointSize` (PointCloudLayer pass-through).                                                                                                                                                |
| `pointSize`       | `number`                           | `10`       | Global radius of all points, in `sizeUnits` (PointCloudLayer pass-through).                                                                                                                          |
| `material`        | `Material`                         | `true`     | Lighting material for the lit points (PointCloudLayer pass-through). `true` for the default phong material, `false` to disable lighting, or a spec `{ ambient, diffuse, shininess, specularColor }`. |
| `fadeInDuration`  | `number`                           | `300`      | Fade-in duration (ms) for appearing points (TimeFilterExtension window).                                                                                                                             |
| `fadeOutDuration` | `number`                           | `300`      | Fade-out duration (ms) for disappearing points (TimeFilterExtension window).                                                                                                                         |

### Data Accessors

| Property              | Type                               | Default                | Description                                                                                                                                                                                                                                                                                                                                                             |
| :-------------------- | :--------------------------------- | :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color`               | `Color \| string`                  | `[255, 255, 255, 255]` | Point colour: constant RGBA, or a property name for categorical colouring.                                                                                                                                                                                                                                                                                              |
| `getColor`            | `Color \| string \| null`          | `null`                 | Upstream-vocabulary alias of `color` (deck's `getColor`). Unlike upstream deck.gl it accepts a constant or a property-column NAME — NOT a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back to `color`). When set, it wins over `color`.                                                                                   |
| `colorPalette`        | `Color[]`                          | 10-color palette       | Palette for the categorical `color` path.                                                                                                                                                                                                                                                                                                                               |
| `colorMapping`        | `Record<string, Color> \| null`    | `null`                 | Explicit category-string → colour map. When set together with a string `color` property, each feature's colour is `colorMapping[categoryValue]`, using `colorMappingDefault` for unknown values. Forces the CPU palette-expansion path (the GPU palette texture cannot look up by category string).                                                                     |
| `colorMappingDefault` | `Color`                            | `[0, 0, 0, 0]`         | Fallback colour for categories absent from `colorMapping` (transparent: unknown categories disappear rather than mislead).                                                                                                                                                                                                                                              |
| `rgbColorColumns`     | `[string, string, string] \| null` | `null`                 | Per-point RGB straight from three NUMERIC columns (each 0–255) — e.g. LIDAR returns coloured by projecting them into camera images at build time. Each feature's colour is `[r, g, b, 255]`. Takes precedence over `color`/`colorMapping`; ignored (falls back to the normal colour path) if any of the three columns is absent from the tile.                          |
| `colorVectorColumn`   | `string \| null`                   | `'point_rgba'`         | Per-point RGBA from ONE interleaved VECTOR column (`FixedSizeList<UInt8,4>`, baked by `stt-build --vector-group name=r,g,b,a:u8`). When the tile carries it, the contiguous u8 buffer is bound to `getColor` **zero-copy** — the GPU-ready analogue of `rgbColorColumns`. Takes precedence over every other colour path; ignored if the column is absent from the tile. |

### 3D & lighting

| Property            | Type             | Default    | Description                                                                                                                                                                                                                                                        |
| :------------------ | :--------------- | :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalColumn`      | `string \| null` | `'normal'` | VECTOR column name (`FixedSizeList<Float32,3>`) holding each point's surface normal `[nx, ny, nz]`. When present it's bound to `getNormal` **zero-copy**; absent ⇒ deck's default `[0, 0, 1]` (points face straight up, so lighting is uniform).                   |
| `elevationProperty` | `string \| null` | `null`     | Property name to source per-point elevation (z) from a numeric tile column when the geometry is 2D (lon/lat). Each point is placed at `z = column[i] × elevationScale`. Unset (the common case) ⇒ z comes from 3D tile geometry directly, or stays 0 on a 2D tile. |
| `elevationScale`    | `number`         | `1`        | Multiplier applied to each `elevationProperty` value before it becomes the point's z. No effect when `elevationProperty` is unset. Unconstrained — negative scales are allowed (z values themselves may be negative).                                              |

## 3D, lighting & colour resolution

- **Colour precedence** — colour resolves in a fixed order and the first
  applicable path wins: (1) `colorVectorColumn` (one interleaved RGBA column,
  bound zero-copy); (2) `rgbColorColumns` (three numeric columns expanded into
  a Uint8 RGBA buffer); (3) a categorical `color`/`getColor` column, CPU-expanded
  through `colorPalette` or `colorMapping`; (4) the constant `color`. The
  vector- and RGB-column paths fall through to the next path when their columns
  are absent from the tile.
- **Categorical colours are lit** — this is a lit layer, so categorical
  colouring rides `instanceColors` (Gouraud-lit `getColor`) rather than a
  GPU fragment-stage replacement, keeping categorical points shaded like every
  other colour path.
- **Normals** — a `[nx, ny, nz]` normal column is bound to `getNormal`
  zero-copy when present; otherwise deck's default `[0, 0, 1]` gives uniform
  lighting across the cloud.
- **Point tiles only** — the layer checks each tile layer's `geometryType` and
  skips any layer that is not `Point`, emitting one named console warning. A
  linestring tile would otherwise be read as one position per feature over the
  flattened vertex run: no error, no blank map, just points silently bunched
  along the first few paths.
- **Window mode only** — there is no wake or cumulative ("draws itself") path;
  point clouds animate whole features on and off through the
  [`TimeFilterExtension`](./time-filter-extension.md) window (with fade ramps),
  as an overview/scan primitive.
- **Per-tile binary sublayers** — each visible (tile, layer) pair produces one
  `PointCloudLayer` using deck.gl's binary `data: { length, attributes }` shape,
  with positions and start/end times referenced directly from the tile's Arrow
  buffers (zero copy). A new tile adds exactly one sublayer and one GPU upload;
  existing tiles' buffers are untouched. Prepared-data and sublayer caches keep
  the `data` reference stable across `renderLayers()` calls so deck.gl
  short-circuits GPU re-uploads when only time changes.

The sublayer short id for `_subLayerProps` overrides is **`pointCloud`**: `_subLayerProps: { pointCloud: { type: MyLayer, ... } }` swaps the sublayer class (default `PointCloudLayer`) or overrides sublayer props.

## Source

[packages/layers/src/layers/core/animated-point-cloud-layer.ts](../../packages/layers/src/layers/core/animated-point-cloud-layer.ts)
