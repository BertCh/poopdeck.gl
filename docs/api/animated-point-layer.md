# AnimatedPointLayer

The `AnimatedPointLayer` renders time-series point data as circles. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU-accelerated time filtering (window, wake, and cumulative modes) with support for categorical coloring.

## Installation

```typescript
import { AnimatedPointLayer } from "@poopdeck.gl/layers";
```

## Usage

```typescript
import { AnimatedPointLayer } from "@poopdeck.gl/layers";

const layer = new AnimatedPointLayer({
  id: "earthquakes",
  data: "https://example.com/earthquakes/manifest.json",
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
  data: "https://example.com/flights/manifest.json",
  currentTime: Date.now(),
  timeWindow: 3600000,
  fillColor: "airline", // categorical property name → GPU palette lookup
  colorPalette: [
    [31, 119, 180, 255],
    [255, 127, 14, 255],
    [44, 160, 44, 255],
  ],
  radius: "altitude", // numeric property name → per-feature radius
});
```

### Wake mode (ship-wake aesthetic)

```typescript
const layer = new AnimatedPointLayer({
  id: "vessels",
  data: "/data/ais/manifest.json",
  currentTime,
  wakeLength: 30 * 60 * 1000,    // 30 min comet tail behind each point
  wakeTailScale: 0.15,
  timeWindow: 60 * 60 * 1000,    // must be >= 2 × wakeLength (loader window)
});
```

### Cumulative mode ("the map draws itself")

```typescript
const layer = new AnimatedPointLayer({
  id: "osm-nodes",
  data: "/data/osm-nyc/manifest.json",
  currentTime,
  cumulative: true,
  fadeInDuration: 500,          // appear ramp
  timeWindow: WHOLE_DATASET_MS, // keep revealed tiles resident
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property             | Type                              | Default | Description                                        |
| :------------------- | :-------------------------------- | :------ | :------------------------------------------------- |
| `radiusScale`        | `number`                          | `1`     | Global multiplier for point radii.                 |
| `radiusUnits`        | `'pixels' \| 'meters' \| 'common'` | `'pixels'` | Units for radius.                               |
| `radiusMinPixels`    | `number`                          | `0`     | Minimum on-screen radius in pixels.                |
| `radiusMaxPixels`    | `number`                          | `MAX_SAFE_INTEGER` | Maximum on-screen radius in pixels.     |
| `filled`             | `boolean`                         | `true`  | Fill the marker.                                   |
| `stroked`            | `boolean`                         | `false` | Render an outline stroke around each point.        |
| `strokeColor`        | `Color`                           | `[0, 0, 0, 255]` | Stroke color (constant).                  |
| `lineWidthUnits`     | `'pixels' \| 'meters' \| 'common'` | `'meters'` | Units for `strokeWidth`. Deck-parity default — note this differs from `radiusUnits`, whose STT default is `'pixels'`. |
| `lineWidthScale`     | `number`                          | `1`     | Global multiplier for stroke widths.               |
| `lineWidthMinPixels` | `number`                          | `0`     | Minimum on-screen stroke width in pixels.          |
| `lineWidthMaxPixels` | `number`                          | `MAX_SAFE_INTEGER` | Maximum on-screen stroke width in pixels. |
| `billboard`          | `boolean`                         | `false` | Render markers as billboards (always face the camera in 3D views). |
| `antialiasing`       | `boolean`                         | `true`  | Smooth-edge antialiasing; disable to fix blending artifacts under some depth-test `parameters`. |
| `fadeInDuration`     | `number`                          | `300`   | Duration (ms) for points to fade in.               |
| `fadeOutDuration`    | `number`                          | `300`   | Duration (ms) for points to fade out (window mode).|
| `splat`              | `boolean`                         | `false` | Render points as soft-gaussian splats instead of hard antialiased disks (installs [`SplatExtension`](./splat-extension.md)). Overlapping splats blend into continuous surfaces — a colored point-cloud / "poor-man's-photogrammetry" look rather than a field of discs. Pairs well with `rgbColorColumns`, a slightly larger `radius`, some transparency, and `billboard: true`. |

### Mode Options

| Property        | Type      | Default | Description |
| :-------------- | :-------- | :------ | :--- |
| `wakeLength`    | `number`  | `0`     | When > 0, switches to one-sided "ship wake" rendering: visible only while `0 <= currentTime - startTime <= wakeLength`, alpha fades to 0 at the trailing edge, radius shrinks to `wakeTailScale` × head. Takes precedence over the symmetric window filter. The caller must ensure `timeWindow >= 2 × wakeLength` so the loader fetches the past half of the wake. |
| `wakeTailScale` | `number`  | `0.15`  | Trailing-edge size multiplier in wake mode (0..1). |
| `cumulative`    | `boolean` | `false` | "Draw and persist" mode: each point appears at its `startTime` and stays visible for the rest of playback. `fadeInDuration` doubles as the appear ramp. Widen the tile loader's window so revealed tiles stay resident. |

### Data Accessors

| Property              | Type               | Default              | Description                                                                    |
| :-------------------- | :----------------- | :------------------- | :----------------------------------------------------------------------------- |
| `fillColor`           | `Color \| string`  | `[255, 128, 0, 255]` | Fill color: constant RGBA, or a property name for categorical coloring.        |
| `getFillColor`        | `Color \| string \| null` | `null`        | Upstream-vocabulary alias of `fillColor`. Unlike upstream deck.gl it accepts a constant or a property-column NAME — NOT a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back to `fillColor`). When set, it wins. |
| `radius`              | `number \| string` | `5`                  | Point radius: constant, or a numeric property name.                            |
| `getRadius`           | `number \| string \| null` | `null`       | Upstream-vocabulary alias of `radius` (same domain rules as `getFillColor`).   |
| `getLineColor`        | `Color \| null`    | `null`               | Upstream-vocabulary alias of `strokeColor` (constant only).                    |
| `strokeWidth`         | `number \| string` | `1`                  | Outline stroke width: constant, or a numeric property name. In `cumulative` mode a property-column value is ignored (slabs don't pack stroke widths) — the constant branch still applies. |
| `getLineWidth`        | `number \| string \| null` | `null`       | Upstream-vocabulary alias of `strokeWidth` (same domain rules as `getRadius`). |
| `colorPalette`        | `Color[]`          | 10-color palette     | Palette for categorical `fillColor` (GPU path, up to 4096 entries).            |
| `colorMapping`        | `Record<string, Color> \| null` | `null`  | Explicit category-string → color map. The only way to get stable colors across tiles whose categorical column contains different category subsets. Forces the CPU palette-expansion path (the GPU texture can't look up by string). |
| `colorMappingDefault` | `Color`            | `[0, 0, 0, 0]`       | Fallback for categories absent from `colorMapping` (transparent: unknown categories disappear rather than mislead). |
| `rgbColorColumns`     | `[string, string, string] \| null` | `null` | Per-point RGB read straight from three NUMERIC property columns (each 0–255), e.g. LIDAR returns colored by projecting them into camera images at build time (`waymo_extract.py --colorize`). Fill is `[r, g, b, 255]` — no palette, no category lookup. Alpha comes from layer `opacity`. Takes precedence over `fillColor`/`colorMapping`; ignored (falls back to the normal color path) if any of the three columns is absent. |
| `colorVectorColumn`   | `string \| null`   | `'point_rgba'`       | Per-point RGBA from ONE interleaved VECTOR column (`FixedSizeList<UInt8,4>`, baked by `stt-build --vector-group point_rgba=r,g,b,a:u8`). When the tile carries it, the contiguous u8 buffer is bound to `getFillColor` **zero-copy** — the GPU-ready analogue of `rgbColorColumns`. Takes precedence over every other color path; ignored if the column is absent from the tile. |
| `radiusTransform`     | `(v: number) => number \| null` | `null`  | Per-feature transform applied to the `radius` property value before GPU upload (e.g. magnitude → area). |

### 3D props

| Property            | Type               | Default | Description |
| :------------------- | :----------------- | :------ | :--- |
| `elevationProperty`  | `string \| null`   | `null`  | Numeric property name to source per-point elevation (z) from. Tile geometry is 2D (lon/lat); when set, each point's z is baked as `column[i] * elevationScale` into the position buffer at tile-prepare time, on both the per-tile sublayer path and the cumulative slab path. Negative and zero values pass through unchanged (e.g. below-grade to rooftop LIDAR returns). Left unset (the default), z stays 0 — byte-identical to a flat 2D render. |
| `elevationScale`     | `number`           | `1`     | Multiplier applied to every `elevationProperty` value before it becomes z. No effect when `elevationProperty` is unset. |
| `use3D`              | `boolean`          | `false` | Accepted for API compatibility only — has **no effect**. 3D is inferred automatically: tiles whose `positionDimensions` is 3 ride their z zero-copy, 2D tiles are padded with z=0 (or with the `elevationProperty`-baked z, if set), regardless of this flag. |

3D handling is otherwise fully automatic — there is no separate "3D mode" to opt into beyond setting `elevationProperty` (for 2D tiles) or building the archive with 3D positions in the first place.

## Architecture & performance

- **Per-tile binary sublayers**: each visible (tile, layer) pair produces one
  `ScatterplotLayer` using deck.gl's binary `data: { length, attributes }`
  shape, with positions/times referenced DIRECTLY from the tile's Arrow
  buffers (zero copy). A new tile adds exactly one sublayer and one GPU
  upload — existing tiles' buffers are untouched.
- **Sublayer + prepared-data caches**: the same layer instance and `data`
  reference come back across `renderLayers()` calls, so deck.gl
  short-circuits prop diffing and re-uploads when only time changes.
- **Per-tile `timeOffset`**: each sublayer rebases time independently via
  its [`TimeFilterExtension`](./time-filter-extension.md) — see the
  timeOffset contract there.
- **Cumulative slabs**: in cumulative mode the per-tile-sublayer model
  would climb into thousands of draw calls by end of playback, so points
  are instead packed append-only into consolidated ~250k-point slabs —
  frozen slabs keep a stable `data` ref (zero re-upload); only the single
  open slab grows. Picking resolves through per-tile provenance ranges.
- **Picking**: `getPickingInfo` enriches hits with `info.tile` and decodes
  the picked feature's columns into `info.object` at event rate.
- **Splat rendering** (`splat: true`): installs [`SplatExtension`](./splat-extension.md), a
  fragment-only effect with no extra attributes or uniforms. It multiplies
  each fragment's alpha by a radial gaussian falloff from the point's
  center (`geometry.uv`, the disk's unit position) out to its rim, turning
  the hard antialiased disk into a soft blob. It always runs last in the
  sublayer's extension list — after [`TimeFilterExtension`](./time-filter-extension.md)
  and [`CategoryColorExtension`](./category-color-extension.md) — and
  multiplies into the alpha those extensions already wrote rather than
  replacing it, so temporal fades and categorical colors still apply
  underneath the splat shaping.

The sublayer short id for `_subLayerProps` overrides is **`points`** (covers both per-tile and slab sublayers): `_subLayerProps: { points: { type: MyLayer, ... } }`.

## Source

[packages/layers/src/layers/core/animated-point-layer.ts](../../packages/layers/src/layers/core/animated-point-layer.ts)
