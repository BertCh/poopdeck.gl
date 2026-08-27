# AnimatedLineLayer

The `AnimatedLineLayer` is the **flat** sibling of [`AnimatedArcLayer`](./animated-arc-layer.md): it draws origin→destination flows as straight line segments rather than bowed arcs, through deck.gl's `LineLayer` (`@deck.gl/layers`). Each tile feature is a 2-vertex LineString — first vertex = source, last = target — and the two layers share the same `deriveSourceTargetPositions` endpoint helper.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and uses window-mode time filtering via the shared [`TimeFilterExtension`](./time-filter-extension.md). Use it when arcs add unwanted visual height (dense local flows, top-down views) and a flat segment reads cleaner.

## Installation

```typescript
import { AnimatedLineLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedLineLayer({
  id: 'od-lines',
  data: '/data/nyc-od-arcs/manifest.json',
  currentTime,
  timeWindow: 30 * 60 * 1000,
  color: [120, 200, 255, 200],
  width: 1.5,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property                             | Type                               | Default             | Description                                                                                                                                                                                                                                                                                                                                             |
| :----------------------------------- | :--------------------------------- | :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `color` / `getColor`                 | `Color \| string`                  | `[0,150,255,255]`   | Segment color: constant RGBA or a categorical property-column name.                                                                                                                                                                                                                                                                                     |
| `width` / `getWidth`                 | `number \| string`                 | `1`                 | Segment width — constant or per-feature numeric column.                                                                                                                                                                                                                                                                                                 |
| `widthUnits`                         | `'pixels' \| 'meters' \| 'common'` | `'pixels'`          | Width units.                                                                                                                                                                                                                                                                                                                                            |
| `widthScale`                         | `number`                           | `1`                 | Global multiplier for segment widths.                                                                                                                                                                                                                                                                                                                   |
| `widthMinPixels`                     | `number`                           | `0`                 | Clamp segment width to at least this many on-screen pixels.                                                                                                                                                                                                                                                                                             |
| `widthMaxPixels`                     | `number`                           | `MAX_SAFE_INTEGER`  | Clamp segment width to at most this many on-screen pixels.                                                                                                                                                                                                                                                                                              |
| `colorPalette`                       | `Color[]`                          | 10-stop             | Palette for a categorical `color` column, indexed by first-seen category order within each tile.                                                                                                                                                                                                                                                        |
| `colorMapping`                       | `Record<string, Color> \| null`    | `null`              | Explicit category-string → color map, projected onto each tile's own dictionary so a category keeps ONE color across tiles. Takes precedence over `colorPalette` when set.                                                                                                                                                                              |
| `colorMappingDefault`                | `Color`                            | `[120,120,120,255]` | Fallback color for categories absent from `colorMapping`.                                                                                                                                                                                                                                                                                               |
| `filterProperty`                     | `string \| null`                   | `null`              | Name of a baked **numeric** column to GPU-filter segments by ([`STTDataFilterExtension`](./data-filter-extension.md)); composes WITH the time filter — a segment must pass both. Accessor-alias of deck's `getFilterValue`: a column NAME, not a function. Unset ⇒ the extension is not installed at all. A tile lacking the column renders unfiltered. |
| `filterRange`                        | `[number, number] \| null`         | `null`              | Inclusive `[min, max]` bounds for `filterProperty`. `null` idles the filter (renders all) while keeping the column bound, so a range set later animates by uniform with no tile re-preparation.                                                                                                                                                         |
| `filterSoftRange`                    | `[number, number] \| null`         | `null`              | Optional soft `[min, max]` inside `filterRange` for a fade instead of a hard clip. No effect unless `filterProperty` + `filterRange` are set.                                                                                                                                                                                                           |
| `filterEnabled`                      | `boolean`                          | `true`              | Enable/disable the column filter without dropping the bound attribute. Effective only with `filterProperty` + a valid `filterRange`.                                                                                                                                                                                                                    |
| `fadeInDuration` / `fadeOutDuration` | `number`                           | `300`               | Window fade ramps (ms).                                                                                                                                                                                                                                                                                                                                 |

## Behavior notes

- Shares endpoint derivation, caching, and picking with `AnimatedArcLayer`; only the rendered geometry differs.
- **No attribute-budget caveat**: `LineLayer` carries far fewer vertex attributes than `PathLayer` (no fp64 path split, no tessellation), so `instancePickingColors` fits and `pickable: true` works on the stock `LineLayer` — unlike the path family, which has to strip picking to stay under WebGL2's 16-slot floor.
- **LineString tiles only**: the layer checks each tile layer's `geometryType` and skips any layer that is not `LineString`, emitting one named console warning rather than misreading the position buffer. Tiles predating the geometry-kind tag are trusted.
- The sublayer short id for `_subLayerProps` overrides is **`lines`**.

## Source

[packages/layers/src/layers/core/animated-line-layer.ts](../../packages/layers/src/layers/core/animated-line-layer.ts)
