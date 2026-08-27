# AnimatedHexagonLayer

The `AnimatedHexagonLayer` renders temporal point data as an animated,
extruded **hexbin** — the discrete, pickable analog of the smooth
[`AnimatedHeatmapLayer`](./heatmap-time-layer.md). It is a composite over the
**canonical deck.gl
[`HexagonLayer`](https://deck.gl/docs/api-reference/aggregation-layers/hexagon-layer)**
(`@deck.gl/aggregation-layers`): instead of splatting points into a density
texture, every visible point is binned into hexagonal cells at runtime (on the
GPU by default), and each cell is coloured — and optionally extruded — by its
aggregated weight, giving the iconic deck.gl hexagon look.

**Data feed.** The point feed is identical to `AnimatedHeatmapLayer`: every
visible tile's points are consolidated into one binary buffer set, cached by the
visible-tile-set key so it rebuilds only when that set (or the weight config)
changes, never per frame. The single consolidated weight buffer is aliased to
_both_ of HexagonLayer's weight accessors (`getColorWeight` and
`getElevationWeight`), so one weight column drives both colour and elevation.

**Time animation.** The canonical HexagonLayer has no notion of time, so the
window is driven by `@deck.gl/extensions`'
[`DataFilterExtension`](https://deck.gl/docs/api-reference/extensions/data-filter-extension):
each point carries its start time as `getFilterValue`, and the `filterRange`
(the window around the play head) is recomputed each render. Cells genuinely
appear, disappear and re-colour as the window slides — the bin sorter re-runs,
it is not a cross-fade. The re-aggregation cadence is capped at ~30 Hz,
independently of tile loading. Because `DataFilterExtension` is a GPU-shader
construct, the window only works on the GPU aggregation path.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and reuses all of
its archive/tileset plumbing.

## Installation

```typescript
import { AnimatedHexagonLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedHexagonLayer } from '@poopdeck.gl/layers';

const layer = new AnimatedHexagonLayer({
  id: 'pickup-hexbin',
  data: '/data/nyc-taxi/manifest.json',
  currentTime,
  timeWindow: 30 * 60 * 1000, // 30 min window around the play head
  radius: 500, // hex bin radius, meters
  extruded: true,
  elevationScale: 20,
  elevationRange: [0, 3000],
  weightProperty: 'passengers', // unset → a pure COUNT hexbin
  hexagonAggregation: 'SUM',
});
```

Pair it with a raw-tier layer for a zoom-dependent stack, or use any animated
layer with `tier: 'auto'` (the base default) to dispatch tiers automatically.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Binning

| Property   | Type     | Default | Description                                                                            |
| ---------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `radius`   | `number` | `1000`  | Radius of a hexagon bin, in meters.                                                    |
| `coverage` | `number` | `1`     | Cell size multiplier, clamped `0`–`1`. Lower values leave gaps between adjacent hexes. |

### Colour

| Property           | Type                                                | Default        | Description                                                                                                                                                                  |
| ------------------ | --------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `colorRange`       | `Color[]`                                           | 6-class YlOrRd | Cell colour ramp (low → high aggregated weight).                                                                                                                             |
| `colorDomain`      | `[number, number] \| null`                          | `null`         | Pinned colour scale domain. `null` → the canonical layer auto-ranges against the current window's aggregated weights.                                                        |
| `colorScaleType`   | `'quantize' \| 'linear' \| 'quantile' \| 'ordinal'` | `'quantize'`   | Colour scale function.                                                                                                                                                       |
| `upperPercentile`  | `number`                                            | `100`          | Hide cells above this colour percentile (`0`–`100`).                                                                                                                         |
| `lowerPercentile`  | `number`                                            | `0`            | Hide cells below this colour percentile (`0`–`100`).                                                                                                                         |
| `onSetColorDomain` | `((domain: [number, number]) => void) \| null`      | `null`         | Fired when the canonical HexagonLayer computes an auto-ranged colour domain (HexagonLayer pass-through) — the way to read the domain back when `colorDomain` is left `null`. |

### Elevation

| Property                   | Type                                           | Default     | Description                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extruded`                 | `boolean`                                      | `true`      | Whether to extrude cells by their aggregated weight.                                                                                                                                |
| `elevationScale`           | `number`                                       | `1`         | Cell elevation multiplier.                                                                                                                                                          |
| `elevationRange`           | `[number, number]`                             | `[0, 1000]` | Elevation scale output range.                                                                                                                                                       |
| `elevationDomain`          | `[number, number] \| null`                     | `null`      | Pinned elevation scale input domain. `null` → auto-range against the current window's aggregated weights.                                                                           |
| `elevationScaleType`       | `'linear' \| 'quantile'`                       | `'linear'`  | Elevation scale function.                                                                                                                                                           |
| `elevationUpperPercentile` | `number`                                       | `100`       | Hide cells above this elevation percentile (`0`–`100`).                                                                                                                             |
| `elevationLowerPercentile` | `number`                                       | `0`         | Hide cells below this elevation percentile (`0`–`100`).                                                                                                                             |
| `material`                 | `Material \| boolean`                          | `true`      | Lighting material (applies when `extruded`).                                                                                                                                        |
| `onSetElevationDomain`     | `((domain: [number, number]) => void) \| null` | `null`      | Fired when the canonical HexagonLayer computes an auto-ranged elevation domain (HexagonLayer pass-through) — the way to read the domain back when `elevationDomain` is left `null`. |

### Aggregation

| Property               | Type                                                   | Default | Description                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hexagonAggregation`   | `'SUM' \| 'MEAN' \| 'MIN' \| 'MAX' \| 'COUNT'`         | `'SUM'` | Aggregation operation used for both colour and elevation, unless `colorAggregation` / `elevationAggregation` overrides it.                                                                                                                                                                 |
| `colorAggregation`     | `'SUM' \| 'MEAN' \| 'MIN' \| 'MAX' \| 'COUNT' \| null` | `null`  | Colour aggregation operation. `null` → inherit `hexagonAggregation`.                                                                                                                                                                                                                       |
| `elevationAggregation` | `'SUM' \| 'MEAN' \| 'MIN' \| 'MAX' \| 'COUNT' \| null` | `null`  | Elevation aggregation operation. `null` → inherit `hexagonAggregation`.                                                                                                                                                                                                                    |
| `gpuAggregation`       | `boolean`                                              | `true`  | Perform binning on the GPU when possible. Setting it `false` warns once and is forced back to `true`: HexagonLayer's CPU aggregator ignores the shader-side time filter. Devices without float-texture support still fall back to CPU inside HexagonLayer, where the window has no effect. |

### Weight column

The weight is a baked property-column **name** (not a per-feature function
accessor — binary tiles cannot run per-feature JS; a function-valued alias
warns once and falls back). One weight column drives both colour and elevation.

| Property             | Type             | Default | Description                                                                                                                             |
| -------------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `getColorWeight`     | `string \| null` | `null`  | Upstream-vocabulary alias for the colour weight column name. Wins over `getElevationWeight` and `weightProperty`.                       |
| `getElevationWeight` | `string \| null` | `null`  | Upstream-vocabulary alias for the elevation weight column name. Used when `getColorWeight` is unset.                                    |
| `weightProperty`     | `string \| null` | `null`  | Legacy weight column name. Unset → every point weighs `1.0` (a pure COUNT hexbin). `getColorWeight` / `getElevationWeight` win over it. |

## Behavior notes

- **Picking**: `pickable` is **inherited**, like every sibling STT layer — pass
  `pickable: true` to pick cells. Discrete cells have feature identity to pick,
  unlike the heatmap's density pixels, which are forced non-pickable.
- The sublayer short id for `_subLayerProps` overrides is **`hexbin`**:
  `_subLayerProps: { hexbin: { type: MyLayer, ... } }` swaps the sublayer class
  or overrides sublayer props.

## Source

[`packages/layers/src/layers/summary/animated-hexagon-layer.ts`](../../packages/layers/src/layers/summary/animated-hexagon-layer.ts)
