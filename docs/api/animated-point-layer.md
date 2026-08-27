# AnimatedPointLayer

The `AnimatedPointLayer` renders time-series point data as circles. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU-accelerated time filtering (window, wake, and cumulative modes) with support for categorical coloring.

## Installation

```typescript
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedPointLayer } from '@poopdeck.gl/layers';

const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: 'https://example.com/earthquakes/manifest.json',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  fillColor: [255, 128, 0, 255],
  radius: 5,
  radiusScale: 2,
  radiusUnits: 'meters',
});
```

### With Categorical Coloring

```typescript
const layer = new AnimatedPointLayer({
  id: 'flights',
  data: 'https://example.com/flights/manifest.json',
  currentTime: Date.now(),
  timeWindow: 3600000,
  fillColor: 'airline', // categorical property name → GPU palette lookup
  colorPalette: [
    [31, 119, 180, 255],
    [255, 127, 14, 255],
    [44, 160, 44, 255],
  ],
  radius: 'altitude', // numeric property name → per-feature radius
});
```

### Wake mode (ship-wake aesthetic)

```typescript
const layer = new AnimatedPointLayer({
  id: 'vessels',
  data: '/data/ais/manifest.json',
  currentTime,
  wakeLength: 30 * 60 * 1000, // 30 min comet tail behind each point
  wakeTailScale: 0.15,
  timeWindow: 60 * 60 * 1000, // must be >= 2 × wakeLength (loader window)
});
```

### Cumulative mode ("the map draws itself")

```typescript
const layer = new AnimatedPointLayer({
  id: 'osm-nodes',
  data: '/data/osm-nyc/manifest.json',
  currentTime,
  cumulative: true,
  fadeInDuration: 500, // appear ramp
  timeWindow: WHOLE_DATASET_MS, // keep revealed tiles resident
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property             | Type                               | Default            | Description                                                                                                                                                                                                                                                                                                                                                                      |
| :------------------- | :--------------------------------- | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `radiusScale`        | `number`                           | `1`                | Global multiplier for point radii.                                                                                                                                                                                                                                                                                                                                               |
| `radiusUnits`        | `'pixels' \| 'meters' \| 'common'` | `'pixels'`         | Units for radius. **Diverges from upstream `ScatterplotLayer`'s `'meters'`** — see [Deliberate default drift](#deliberate-default-drift).                                                                                                                                                                                                                                        |
| `radiusMinPixels`    | `number`                           | `0`                | Minimum on-screen radius in pixels.                                                                                                                                                                                                                                                                                                                                              |
| `radiusMaxPixels`    | `number`                           | `MAX_SAFE_INTEGER` | Maximum on-screen radius in pixels.                                                                                                                                                                                                                                                                                                                                              |
| `filled`             | `boolean`                          | `true`             | Fill the marker.                                                                                                                                                                                                                                                                                                                                                                 |
| `stroked`            | `boolean`                          | `false`            | Render an outline stroke around each point.                                                                                                                                                                                                                                                                                                                                      |
| `strokeColor`        | `Color`                            | `[0, 0, 0, 255]`   | Stroke color (constant).                                                                                                                                                                                                                                                                                                                                                         |
| `lineWidthUnits`     | `'pixels' \| 'meters' \| 'common'` | `'meters'`         | Units for `strokeWidth`. Deck-parity default — note this differs from `radiusUnits`, whose STT default is `'pixels'`.                                                                                                                                                                                                                                                            |
| `lineWidthScale`     | `number`                           | `1`                | Global multiplier for stroke widths.                                                                                                                                                                                                                                                                                                                                             |
| `lineWidthMinPixels` | `number`                           | `0`                | Minimum on-screen stroke width in pixels.                                                                                                                                                                                                                                                                                                                                        |
| `lineWidthMaxPixels` | `number`                           | `MAX_SAFE_INTEGER` | Maximum on-screen stroke width in pixels.                                                                                                                                                                                                                                                                                                                                        |
| `billboard`          | `boolean`                          | `false`            | Render markers as billboards (always face the camera in 3D views).                                                                                                                                                                                                                                                                                                               |
| `antialiasing`       | `boolean`                          | `true`             | Smooth-edge antialiasing; disable to fix blending artifacts under some depth-test `parameters`.                                                                                                                                                                                                                                                                                  |
| `fadeInDuration`     | `number`                           | `300`              | Duration (ms) for points to fade in.                                                                                                                                                                                                                                                                                                                                             |
| `fadeOutDuration`    | `number`                           | `300`              | Duration (ms) for points to fade out (window mode).                                                                                                                                                                                                                                                                                                                              |
| `splat`              | `boolean`                          | `false`            | Render points as soft-gaussian splats instead of hard antialiased disks (installs [`SplatExtension`](./splat-extension.md)). Overlapping splats blend into continuous surfaces — a colored point-cloud / "poor-man's-photogrammetry" look rather than a field of discs. Pairs well with `rgbColorColumns`, a slightly larger `radius`, some transparency, and `billboard: true`. |

### Mode Options

| Property        | Type      | Default | Description                                                                                                                                                                                                                                                                                                                                                        |
| :-------------- | :-------- | :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeLength`    | `number`  | `0`     | When > 0, switches to one-sided "ship wake" rendering: visible only while `0 <= currentTime - startTime <= wakeLength`, alpha fades to 0 at the trailing edge, radius shrinks to `wakeTailScale` × head. Takes precedence over the symmetric window filter. The caller must ensure `timeWindow >= 2 × wakeLength` so the loader fetches the past half of the wake. |
| `wakeTailScale` | `number`  | `0.15`  | Trailing-edge size multiplier in wake mode (0..1).                                                                                                                                                                                                                                                                                                                 |
| `cumulative`    | `boolean` | `false` | "Draw and persist" mode: each point appears at its `startTime` and stays visible for the rest of playback. `fadeInDuration` doubles as the appear ramp. Widen the tile loader's window so revealed tiles stay resident.                                                                                                                                            |

### Glide (motion interpolation)

Point archives carry one row per entity **per sample**, so a GPU time-window
filter shows every sample in the window at once and a moving entity POPS between
them. Glide instead pools the loaded samples by `idProperty` and emits one
CPU-interpolated pose per active entity per frame.

| Property              | Type             | Default    | Description                                                                                                                                                                                                                        |
| :-------------------- | :--------------- | :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interpolate`         | `boolean`        | `false`    | Opt into the glide path. Active only when `interpolate && !reducedMotion &&` a resolvable `idProperty && !cumulative && wakeLength === 0`; any condition unmet leaves the GPU window/wake/cumulative path unchanged, at zero cost. |
| `idProperty`          | `string \| null` | `null`     | Per-entity id column name grouping samples into one track (e.g. aircraft `icao24`). Reads a categorical column; a numeric one is stringified. Must be an EXACT id — a lossy or quantized id fuses distinct tracks.                 |
| `maxInterpolationGap` | `number`         | `Infinity` | Largest gap (ms) glide interpolates across. A wider gap is a data hole: the entity HOLDS its last known position rather than gliding a straight line it never travelled.                                                           |
| `reducedMotion`       | `boolean`        | `false`    | Honor the viewer's reduced-motion preference: disables glide and degrades to the discrete GPU window path.                                                                                                                         |

### Data Accessors

| Property              | Type                               | Default              | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| :-------------------- | :--------------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fillColor`           | `Color \| string`                  | `[255, 128, 0, 255]` | Fill: constant RGBA, or a property name for categorical coloring. **Drifts from upstream** — see below.                                                                                                                                                                                                                                                                                      |
| `getFillColor`        | `Color \| string \| null`          | `null`               | Upstream-vocabulary alias of `fillColor`. When set, it wins. Unset here, so `fillColor` wins unless you opt in; with neither set the effective constant is `[255, 128, 0, 255]`, not upstream's `[0, 0, 0, 255]`.                                                                                                                                                                            |
| `radius`              | `number \| string`                 | `5`                  | Point radius: constant, or a numeric property name. **Drifts from upstream** — see below.                                                                                                                                                                                                                                                                                                    |
| `getRadius`           | `number \| string \| null`         | `null`               | Upstream-vocabulary alias of `radius`. Unset here, so `radius` wins unless you opt in; with neither set the effective constant is `5`, not upstream's `1`.                                                                                                                                                                                                                                   |
| `getLineColor`        | `Color \| null`                    | `null`               | Upstream-vocabulary alias of `strokeColor` (constant only).                                                                                                                                                                                                                                                                                                                                  |
| `strokeWidth`         | `number \| string`                 | `1`                  | Outline width: constant, or a numeric property name.                                                                                                                                                                                                                                                                                                                                         |
| `getLineWidth`        | `number \| string \| null`         | `null`               | Upstream-vocabulary alias of `strokeWidth`.                                                                                                                                                                                                                                                                                                                                                  |
| `colorPalette`        | `Color[]`                          | 10-color palette     | Palette for categorical `fillColor` (GPU path, up to 4096 entries).                                                                                                                                                                                                                                                                                                                          |
| `colorMapping`        | `Record<string, Color> \| null`    | `null`               | Explicit category-string → color map. Forces the CPU palette path.                                                                                                                                                                                                                                                                                                                           |
| `colorMappingDefault` | `Color`                            | `[0, 0, 0, 0]`       | Fallback for categories absent from `colorMapping` (transparent).                                                                                                                                                                                                                                                                                                                            |
| `rgbColorColumns`     | `[string, string, string] \| null` | `null`               | Per-point RGB from three numeric columns (each 0–255).                                                                                                                                                                                                                                                                                                                                       |
| `colorVectorColumn`   | `string \| null`                   | `null`               | Per-point RGBA from one interleaved `FixedSizeList<UInt8,4>` column.                                                                                                                                                                                                                                                                                                                         |
| `radiusTransform`     | `(v: number) => number \| null`    | `null`               | Transform applied to the `radius` value before GPU upload.                                                                                                                                                                                                                                                                                                                                   |
| `rampProperty`        | `string \| null`                   | `null`               | Continuous ramp: name of a baked NUMERIC column to color each point by. Each point's fill is `rampColorRamp` sampled at its value mapped through `rampDomain` (clamped). Expanded once per tile at prepare time and uploaded as a u8 RGBA attribute — zero per-frame cost. A tile lacking the column falls through to the normal color path; a categorical column warns once and is ignored. |
| `rampDomain`          | `[number, number]`                 | `[0, 1]`             | Value range mapped to the ramp's ends; values outside it clamp. No effect unless `rampProperty` is set.                                                                                                                                                                                                                                                                                      |
| `rampColorRamp`       | `Color[]`                          | `[]`                 | Low→high stops, evenly spaced across `rampDomain`. Empty leaves the ramp inert even when `rampProperty` is set (warns once).                                                                                                                                                                                                                                                                 |

**Accessor aliases.** The upstream `get*` names accept a constant or a
property-column **name** — not a function accessor, since binary tiles cannot run
per-feature JS. A function warns once and falls back to the plain prop.

### Deliberate default drift

Three defaults intentionally differ from upstream `ScatterplotLayer`. Porting a
deck config that relied on the upstream values will look different until these
are passed explicitly.

| Property                     | STT default          | deck default     | Why                                                                                                                                |
| :--------------------------- | :------------------- | :--------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| `radiusUnits`                | `'pixels'`           | `'meters'`       | STT points are overwhelmingly event markers, not ground footprints; a pixel radius keeps them legible across the whole zoom range. |
| `radius` / `getRadius`       | `5`                  | `1`              | `5` in the pixel units above is a legible marker; `1 px` is a near-invisible speck.                                                |
| `fillColor` / `getFillColor` | `[255, 128, 0, 255]` | `[0, 0, 0, 255]` | Opaque black is invisible on the dark basemaps these demos use.                                                                    |

Note that `lineWidthUnits` does **not** drift — it keeps deck's `'meters'`,
which is why it differs from `radiusUnits` in this same layer.

**Color precedence.** `colorVectorColumn` wins over everything, then
`rgbColorColumns`, then `rampProperty` (the continuous ramp), then
`colorMapping`/`colorPalette` (categorical), then a constant `fillColor`. Every
column path falls through to the next when its column is absent from a tile. The
ramp is not applied on the CPU glide (`interpolate`) path, which colors
per-track.

`colorMapping` is the only way to get stable colors across tiles whose
categorical column contains different category subsets — the GPU palette texture
cannot look up by string, so setting it forces CPU palette expansion.

`rgbColorColumns` reads three numeric columns (each 0–255) as `[r, g, b, 255]`,
e.g. LIDAR returns colored by projecting them into camera images at build time
(`waymo_extract.py --colorize`). Alpha comes from layer `opacity`.

`colorVectorColumn` reads one interleaved column baked by
`stt-build --vector-group point_rgba=r,g,b,a:u8` and binds the contiguous u8
buffer to `getFillColor` zero-copy — the GPU-ready analogue of
`rgbColorColumns`. It defaults off on this layer because a truthy default would
silently shadow an explicit `fillColor` on any tile that happened to carry the
column; `AnimatedPointCloudLayer` defaults it to `'point_rgba'`.

In `cumulative` mode a property-column `strokeWidth` is ignored (slabs don't pack
stroke widths); the constant branch still applies.

### Column filter

Wires a baked numeric column into
[`STTDataFilterExtension`](./data-filter-extension.md). Points whose value falls
inside `filterRange` render; the rest are hidden, or soft-faded via
`filterSoftRange`. It composes with the time filter — a point must pass both.

| Property          | Type                       | Default | Description                                                    |
| :---------------- | :------------------------- | :------ | :------------------------------------------------------------- |
| `filterProperty`  | `string \| null`           | `null`  | Name of the baked numeric column to filter by.                 |
| `filterRange`     | `[number, number] \| null` | `null`  | Inclusive `[min, max]` bounds.                                 |
| `filterSoftRange` | `[number, number] \| null` | `null`  | Soft bounds inside `filterRange`; values between the two fade. |
| `filterEnabled`   | `boolean`                  | `true`  | Toggle the filter without dropping the bound attribute.        |

`filterProperty` is the accessor-alias of deck's `getFilterValue`: pass a column
name, not a function (a function warns once and is ignored). Leaving it unset
means the extension is never installed — zero cost. A categorical column cannot
be range-filtered and warns once. The filter is ignored in `cumulative` mode,
where slabs bake a fixed schema.

A `null` `filterRange` keeps the column bound with no active range, so a range
set later animates purely by uniform with no tile re-preparation.
`filterSoftRange` and `filterEnabled` have no effect unless `filterProperty` (and
for the former, `filterRange`) is set.

### 3D props

| Property            | Type             | Default | Description                                              |
| :------------------ | :--------------- | :------ | :------------------------------------------------------- |
| `elevationProperty` | `string \| null` | `null`  | Numeric property supplying per-point elevation (z).      |
| `elevationScale`    | `number`         | `1`     | Multiplier applied before the value becomes z.           |
| `use3D`             | `boolean`        | `false` | Accepted for API compatibility only — has **no effect**. |

Tile geometry is 2D lon/lat. With `elevationProperty` set, each point's z is
baked as `column[i] * elevationScale` into the position buffer at tile-prepare
time, on both the per-tile sublayer path and the cumulative slab path. Negative
and zero values pass through unchanged (below-grade to rooftop LIDAR returns).
Left unset, z stays 0 — byte-identical to a flat 2D render.

3D is otherwise inferred automatically: tiles whose `positionDimensions` is 3
ride their z zero-copy, and 2D tiles are padded with z=0 (or the
`elevationProperty`-baked z). There is no separate "3D mode" to opt into beyond
setting `elevationProperty` for 2D tiles, or building the archive with 3D
positions in the first place.

## Architecture & performance

- **Geometry-kind guard**: tile layers whose `geometryType` is not `Point` are
  skipped with one named console warning. `geometryType` is the only thing that
  distinguishes a point tile from a linestring tile once the columns are
  decoded — this layer would otherwise read the first `featureCount` _vertices_
  of a flattened vertex run as one position per feature: no error, no blank map,
  just points silently bunched along the first few paths. Tiles predating the
  geometry-kind tag are trusted, not rejected.
- **Cumulative slabs**: in cumulative mode points pack append-only into
  consolidated slabs rather than one sublayer per tile, which is why a
  property-column `strokeWidth` and `filterProperty` are ignored there (see
  [Data Accessors](#data-accessors) and [Column filter](#column-filter)).

The sublayer short id for `_subLayerProps` overrides is **`points`** (covers both per-tile and slab sublayers): `_subLayerProps: { points: { type: MyLayer, ... } }`.

## Source

[packages/layers/src/layers/core/animated-point-layer.ts](../../packages/layers/src/layers/core/animated-point-layer.ts)
