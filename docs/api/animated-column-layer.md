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
  elevation: 'magnitude',   // numeric column → column height
  elevationScale: 12000,    // metres per unit
  radius: 6000,             // metres
  fillColor: [251, 106, 74, 220],
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `elevation` / `getElevation` | `number \| string` | `1000` | Column height — constant or a numeric property-column name. |
| `elevationScale` | `number` | `1` | Multiplier on every elevation (e.g. metres per unit). |
| `radius` | `number` | `100` | Column disk radius, in `radiusUnits`. |
| `radiusUnits` | `'meters' \| 'pixels' \| 'common'` | `'meters'` | Radius units. |
| `diskResolution` | `number` | `20` | Number of sides on the column cross-section. |
| `extruded` | `boolean` | `true` | 3D extrusion. |
| `fillColor` / `getFillColor` | `Color \| string` | `[255,140,0,255]` | Fill — constant RGBA or a categorical property-column name (GPU palette). |
| `colorPalette` | `Color[]` | 10-stop | Palette for a categorical `fillColor` column. |
| `wireframe` / `filled` / `stroked` / `flatShading` | `boolean` | — | `ColumnLayer` style pass-throughs. |
| `angle` | `number` | `0` | Disk rotation (degrees, counter-clockwise) — `ColumnLayer` pass-through. |
| `vertices` | `Position[] \| null` | `null` | Custom disk cross-section replacing the regular polygon — `ColumnLayer` pass-through. |
| `offset` | `[number, number]` | `[0, 0]` | Disk offset from the anchor, in radius multiples — `ColumnLayer` pass-through. |
| `coverage` | `number` | `1` | Radius multiplier `[0, 1]` shrinking each column within its footprint. |
| `lineColor` / `getLineColor` | `Color` | `[0,0,0,255]` | Outline stroke color (constant only) — drawn when `stroked` is true. |
| `lineWidth` / `getLineWidth` | `number` | `1` | Outline stroke width (constant only), in `lineWidthUnits`. |
| `lineWidthUnits` | `'meters' \| 'pixels' \| 'common'` | `'meters'` | Outline stroke width units. |
| `lineWidthScale` | `number` | `1` | Outline width multiplier — applies when `stroked` is true. |
| `lineWidthMinPixels` | `number` | `0` | Minimum outline width in pixels — applies when `stroked` is true. |
| `lineWidthMaxPixels` | `number` | `Number.MAX_SAFE_INTEGER` | Maximum outline width in pixels — applies when `stroked` is true. |
| `material` | `Material` | `true` | Lighting material for the extrusion. |
| `fadeInDuration` / `fadeOutDuration` | `number` | `300` | Window fade ramps (ms). |

## Behavior notes

- **Elevation is per-feature** (instanced), unlike `AnimatedPolygonLayer`'s per-vertex elevation expansion.
- Columns are best read at a tilted, regional zoom; at low zoom a metre-radius column falls sub-pixel (the deliberate "render by space" tradeoff).
- The sublayer short id for `_subLayerProps` overrides is **`columns`**.

## Source

[packages/layers/src/layers/core/animated-column-layer.ts](../../packages/layers/src/layers/core/animated-column-layer.ts)
