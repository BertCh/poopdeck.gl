# AnimatedColumnLayer

The `AnimatedColumnLayer` renders **extruded 3D columns** at point features — a bar chart laid over the map, where each column's height comes from a numeric property. It draws through deck.gl's `ColumnLayer` (`@deck.gl/layers`), one binary sublayer per tile, animated window-mode by the shared [`TimeFilterExtension`](./time-filter-extension.md).

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and is instanced at points exactly like [`AnimatedPointLayer`](./animated-point-layer.md): the elevation column is baked into a per-feature `getElevation` attribute (zero-copy), NOT per-vertex. Any point archive with a numeric column works — no rebuild needed.

## Installation

```typescript
import { AnimatedColumnLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedColumnLayer({
  id: 'quake-columns',
  data: '/data/earthquakes-v2/manifest.json',
  currentTime,
  timeWindow: 30 * 24 * 3600 * 1000,
  elevation: 'magnitude', // numeric column → column height
  elevationScale: 12000, // metres per unit
  radius: 6000, // metres
  fillColor: [251, 106, 74, 220],
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property                                           | Type                               | Default                   | Description                                                                                                                                                                                                                                            |
| :------------------------------------------------- | :--------------------------------- | :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elevation` / `getElevation`                       | `number \| string`                 | `1000`                    | Column height — constant or a numeric property-column name.                                                                                                                                                                                            |
| `elevationScale`                                   | `number`                           | `1`                       | Multiplier on every elevation (e.g. metres per unit).                                                                                                                                                                                                  |
| `radius`                                           | `number`                           | `100`                     | Column disk radius, in `radiusUnits`. **Diverges from deck.gl's `ColumnLayer` default of `1000`** — see [Deliberate default drift](#deliberate-default-drift).                                                                                         |
| `radiusUnits`                                      | `'meters' \| 'pixels' \| 'common'` | `'meters'`                | Radius units.                                                                                                                                                                                                                                          |
| `diskResolution`                                   | `number`                           | `20`                      | Number of sides on the column cross-section.                                                                                                                                                                                                           |
| `extruded`                                         | `boolean`                          | `true`                    | 3D extrusion.                                                                                                                                                                                                                                          |
| `fillColor` / `getFillColor`                       | `Color \| string`                  | `[255,140,0,255]`         | Fill — constant RGBA or a categorical property-column name. See [Categorical fill and lighting](#categorical-fill-and-lighting) for where the palette is resolved.                                                                                     |
| `colorPalette`                                     | `Color[]`                          | 10-stop                   | Palette for a categorical `fillColor` column (by first-seen category index).                                                                                                                                                                           |
| `colorMapping`                                     | `Record<string, Color> \| null`    | `null`                    | Explicit category-string → color map. Keeps a category's color stable across tiles whose dictionaries differ in order or subset, which the bare `colorPalette` cannot. Always CPU-expands (a category string can't hash to a palette slot on the GPU). |
| `colorMappingDefault`                              | `Color`                            | `[0, 0, 0, 0]`            | Fallback for categories absent from `colorMapping` (transparent by default).                                                                                                                                                                           |
| `wireframe` / `filled` / `stroked` / `flatShading` | `boolean`                          | —                         | `ColumnLayer` style pass-throughs.                                                                                                                                                                                                                     |
| `angle`                                            | `number`                           | `0`                       | Disk rotation (degrees, counter-clockwise) — `ColumnLayer` pass-through.                                                                                                                                                                               |
| `vertices`                                         | `Position[] \| null`               | `null`                    | Custom disk cross-section replacing the regular polygon — `ColumnLayer` pass-through.                                                                                                                                                                  |
| `offset`                                           | `[number, number]`                 | `[0, 0]`                  | Disk offset from the anchor, in radius multiples — `ColumnLayer` pass-through.                                                                                                                                                                         |
| `coverage`                                         | `number`                           | `1`                       | Radius multiplier `[0, 1]` shrinking each column within its footprint.                                                                                                                                                                                 |
| `lineColor` / `getLineColor`                       | `Color`                            | `[0,0,0,255]`             | Outline stroke color (constant only) — drawn when `stroked` is true.                                                                                                                                                                                   |
| `lineWidth` / `getLineWidth`                       | `number`                           | `1`                       | Outline stroke width (constant only), in `lineWidthUnits`.                                                                                                                                                                                             |
| `lineWidthUnits`                                   | `'meters' \| 'pixels' \| 'common'` | `'meters'`                | Outline stroke width units.                                                                                                                                                                                                                            |
| `lineWidthScale`                                   | `number`                           | `1`                       | Outline width multiplier — applies when `stroked` is true.                                                                                                                                                                                             |
| `lineWidthMinPixels`                               | `number`                           | `0`                       | Minimum outline width in pixels — applies when `stroked` is true.                                                                                                                                                                                      |
| `lineWidthMaxPixels`                               | `number`                           | `Number.MAX_SAFE_INTEGER` | Maximum outline width in pixels — applies when `stroked` is true.                                                                                                                                                                                      |
| `material`                                         | `Material`                         | `true`                    | Lighting material for the extrusion.                                                                                                                                                                                                                   |
| `fadeInDuration` / `fadeOutDuration`               | `number`                           | `300`                     | Window fade ramps (ms).                                                                                                                                                                                                                                |
| `reducedMotion`                                    | `boolean`                          | `false`                   | Honor `prefers-reduced-motion`: forces the inherited `timeHeightScale` space-time-cube lift to 0 so the columns stay ground-anchored. Time playback and fades are unaffected.                                                                          |
| `filterProperty`                                   | `string \| null`                   | `null`                    | Name of a baked **numeric** column for a GPU range filter ([`STTDataFilterExtension`](./data-filter-extension.md)). Accessor-alias of deck's `getFilterValue` — a column NAME, not a function. Unset ⇒ the extension is not installed at all.          |
| `filterRange`                                      | `[number, number] \| null`         | `null`                    | Inclusive `[min, max]` bounds for `filterProperty`. `null` idles the filter (renders all) while keeping the column bound. Note this differs from upstream deck's `[-1, 1]` default.                                                                    |
| `filterSoftRange`                                  | `[number, number] \| null`         | `null`                    | Optional soft `[min, max]` for a fade instead of a hard clip.                                                                                                                                                                                          |
| `filterEnabled`                                    | `boolean`                          | `true`                    | Enable/disable the filter without dropping the bound attribute.                                                                                                                                                                                        |

### Deliberate default drift

`radius` defaults to **`100`**, where deck.gl's own `ColumnLayer` defaults to
**`1000`**. The STT default is sized for the point archives this layer renders
(a metro-scale bar chart, not a continental hex grid). Porting a deck config
that relied on the upstream default therefore yields columns 10× narrower —
pass `radius` explicitly. This is the only value in the column surface that
diverges from upstream.

## Categorical fill and lighting

Where a categorical `fillColor` palette is resolved depends on `extruded`:

- **`extruded: true` (the default)** — the palette is expanded on the **CPU**
  into a per-feature RGBA `getFillColor` buffer.
- **`extruded: false`** (flat disks) — the palette lifts to the GPU via
  [`CategoryColorExtension`](./category-color-extension.md).
- A `colorMapping` always CPU-expands, extruded or not.

The split is forced by the shader. `ColumnLayer` computes lighting **before**
`DECKGL_FILTER_COLOR` — gouraud into `vColor` in the vertex stage, phong into
`fragColor` under `flatShading` — and the extension's hook _replaces_ rgb, so a
GPU palette write on an extruded column discards the lit color and every bar
renders as a flat single-tone silhouette. [`AnimatedPointLayer`](./animated-point-layer.md)
can use the GPU path unconditionally because its markers are unlit;
[`AnimatedPointCloudLayer`](./animated-point-cloud-layer.md), also lit, makes
the same CPU choice.

## Behavior notes

- **Point tiles only.** The layer checks each tile layer's `geometryType` and
  skips any layer that is not `Point`, emitting one named console warning
  rather than misreading a linestring/polygon vertex run as one position per
  feature.
- **Elevation is per-feature** (instanced), unlike `AnimatedPolygonLayer`'s per-vertex elevation expansion.
- Columns are best read at a tilted, regional zoom; at low zoom a metre-radius column falls sub-pixel (the deliberate "render by space" tradeoff).
- There is no cumulative-slab path: columns are an overview/aggregate primitive, so the per-tile sublayer count never climbs the way a cumulative point reveal does.
- The sublayer short id for `_subLayerProps` overrides is **`columns`**.

## Source

[packages/layers/src/layers/core/animated-column-layer.ts](../../packages/layers/src/layers/core/animated-column-layer.ts)
