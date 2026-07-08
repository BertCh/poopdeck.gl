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
visible tile's points are consolidated into one binary buffer set, cached by
the visible-tile-set key so it rebuilds only when that set (or the weight
config) changes, never per frame. The single consolidated weight buffer is
aliased to _both_ of HexagonLayer's weight accessors (`getColorWeight` and
`getElevationWeight`), so one weight column drives both colour and elevation.

**Time animation.** The canonical HexagonLayer has no notion of time, so the
window is driven by `@deck.gl/extensions`'
[`DataFilterExtension`](https://deck.gl/docs/api-reference/extensions/data-filter-extension):
each point carries a relativized start time as `getFilterValue`, and the
`filterRange` (the `[start, end]` window around the play head) is recomputed
each render. When the window centre moves, the cached weight buffers are
re-bound in fresh attribute wrappers, which re-runs the GPU bin sorter so cells
genuinely appear, disappear, and re-colour as the window slides — it is not a
cross-fade. The re-aggregation cadence is capped at ~30 Hz, independently of
tile loading.

Because the `DataFilterExtension` is a GPU-shader construct, the time window
only works on the GPU aggregation path; `gpuAggregation` is forced `true` (with
a one-time warning) when a caller disables it, since HexagonLayer's CPU
aggregator ignores the filter. Both the per-point filter value and
`filterRange` are relativized against a single layer time offset (the first
visible tile's offset) so both sides of the shader comparison stay inside the
Float32 mantissa budget.

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

| Property          | Type                                                | Default        | Description                                                                                                           |
| ----------------- | --------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `colorRange`      | `Color[]`                                           | 6-class YlOrRd | Cell colour ramp (low → high aggregated weight).                                                                      |
| `colorDomain`     | `[number, number] \| null`                          | `null`         | Pinned colour scale domain. `null` → the canonical layer auto-ranges against the current window's aggregated weights. |
| `colorScaleType`  | `'quantize' \| 'linear' \| 'quantile' \| 'ordinal'` | `'quantize'`   | Colour scale function.                                                                                                |
| `upperPercentile` | `number`                                            | `100`          | Hide cells above this colour percentile (`0`–`100`).                                                                  |
| `lowerPercentile` | `number`                                            | `0`            | Hide cells below this colour percentile (`0`–`100`).                                                                  |

### Elevation

| Property                   | Type                       | Default     | Description                                                                                               |
| -------------------------- | -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `extruded`                 | `boolean`                  | `true`      | Whether to extrude cells by their aggregated weight.                                                      |
| `elevationScale`           | `number`                   | `1`         | Cell elevation multiplier.                                                                                |
| `elevationRange`           | `[number, number]`         | `[0, 1000]` | Elevation scale output range.                                                                             |
| `elevationDomain`          | `[number, number] \| null` | `null`      | Pinned elevation scale input domain. `null` → auto-range against the current window's aggregated weights. |
| `elevationScaleType`       | `'linear' \| 'quantile'`   | `'linear'`  | Elevation scale function.                                                                                 |
| `elevationUpperPercentile` | `number`                   | `100`       | Hide cells above this elevation percentile (`0`–`100`).                                                   |
| `elevationLowerPercentile` | `number`                   | `0`         | Hide cells below this elevation percentile (`0`–`100`).                                                   |
| `material`                 | `Material \| boolean`      | `true`      | Lighting material (applies when `extruded`).                                                              |

### Aggregation

| Property               | Type                                                   | Default | Description                                                                                                                |
| ---------------------- | ------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `hexagonAggregation`   | `'SUM' \| 'MEAN' \| 'MIN' \| 'MAX' \| 'COUNT'`         | `'SUM'` | Aggregation operation used for both colour and elevation, unless `colorAggregation` / `elevationAggregation` overrides it. |
| `colorAggregation`     | `'SUM' \| 'MEAN' \| 'MIN' \| 'MAX' \| 'COUNT' \| null` | `null`  | Colour aggregation operation. `null` → inherit `hexagonAggregation`.                                                       |
| `elevationAggregation` | `'SUM' \| 'MEAN' \| 'MIN' \| 'MAX' \| 'COUNT' \| null` | `null`  | Elevation aggregation operation. `null` → inherit `hexagonAggregation`.                                                    |
| `gpuAggregation`       | `boolean`                                              | `true`  | Perform binning on the GPU when possible. Forced `true` for the time window — see below.                                   |

### Weight column

The weight is a baked property-column **name** (not a per-feature function
accessor — binary tiles cannot run per-feature JS; a function-valued alias
warns once and falls back). One weight column drives both colour and elevation.

| Property             | Type             | Default | Description                                                                                                                             |
| -------------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `getColorWeight`     | `string \| null` | `null`  | Upstream-vocabulary alias for the colour weight column name. Wins over `getElevationWeight` and `weightProperty`.                       |
| `getElevationWeight` | `string \| null` | `null`  | Upstream-vocabulary alias for the elevation weight column name. Used when `getColorWeight` is unset.                                    |
| `weightProperty`     | `string \| null` | `null`  | Legacy weight column name. Unset → every point weighs `1.0` (a pure COUNT hexbin). `getColorWeight` / `getElevationWeight` win over it. |

## Aggregation and behavior notes

- **Weight resolution**: the single weight column is resolved in order
  `getColorWeight` → `getElevationWeight` → `weightProperty`. Unset → every
  point weighs `1.0`, producing a pure COUNT hexbin. A weight-config change
  invalidates the consolidated buffers and re-consolidates.
- **Aggregation inheritance**: `hexagonAggregation` is the shared default;
  `colorAggregation` and `elevationAggregation` each override it only when set
  to a non-`null` value.
- **GPU-only time window**: the `DataFilterExtension` is a GPU-shader construct,
  so the time window only works on the GPU aggregation path. Setting
  `gpuAggregation: false` warns once and is forced back to `true`; devices
  without float-texture support still fall back to CPU inside HexagonLayer,
  where the window has no effect.
- **Auto-ranging vs pinned domains**: with `colorDomain` / `elevationDomain`
  unset (`null`), the canonical layer auto-ranges against the current window's
  aggregated weights, so the mapping shifts as the window slides; pin a domain
  to keep it stable.
- **Picking**: the sublayer is `pickable` (discrete cells have feature identity
  to pick, unlike the heatmap's density pixels).
- The sublayer short id for `_subLayerProps` overrides is **`hexbin`**:
  `_subLayerProps: { hexbin: { type: MyLayer, ... } }` swaps the sublayer class
  or overrides sublayer props.

## Source

[`packages/layers/src/layers/summary/animated-hexagon-layer.ts`](../../packages/layers/src/layers/summary/animated-hexagon-layer.ts)
