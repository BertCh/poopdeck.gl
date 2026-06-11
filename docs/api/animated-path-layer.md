# AnimatedPathLayer

The `AnimatedPathLayer` renders time-series path/trajectory data as lines. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU-accelerated time filtering.

It operates in **window mode**: each feature is shown (with optional fade) whenever its `[startTime, endTime]` overlaps the current time window — whole paths render at once. For a "vehicle moving along the route" trailing effect, use [`AnimatedTripsLayer`](./animated-trips-layer.md) instead, which renders per-vertex with a fading trail.

## Installation

```typescript
import { AnimatedPathLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { AnimatedPathLayer } from '@stt/deck.gl';

const layer = new AnimatedPathLayer({
  id: 'ship-tracks',
  data: 'https://example.com/ships/manifest.json',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  pathColor: [0, 150, 255, 255],
  pathWidth: 3,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `widthScale` | `number` | `1` | Global multiplier for path widths. |
| `widthUnits` | `'pixels' \| 'meters'` | `'pixels'` | Units for width. |
| `widthMinPixels` | `number` | `0` | Clamp path width to at least this many on-screen pixels. |
| `widthMaxPixels` | `number` | `MAX_SAFE_INTEGER` | Clamp path width to at most this many on-screen pixels. |
| `capRounded` | `boolean` | `false` | Rounded line caps. Rounded caps are the dominant fragment-shader cost at small widths and visually indistinguishable from flat below ~10 px. |
| `jointRounded` | `boolean` | `false` | Rounded line joints; same fragment-cost tradeoff. |
| `fadeInDuration` | `number` | `300` | Duration (ms) for paths to fade in when their time range enters the window. |
| `fadeOutDuration` | `number` | `300` | Duration (ms) for paths to fade out when their time range leaves the window. |

### Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `pathColor` | `Color \| string` | `[0, 150, 255, 255]` | Path color: constant RGBA, or a property name for categorical coloring. |
| `getColor` | `Color \| string \| null` | `null` | Upstream-vocabulary (PathLayer) alias of `pathColor`. Accepts a constant or a property-column NAME — NOT a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back to `pathColor`). When set, it wins. |
| `pathWidth` | `number \| string` | `3` | Path width: constant, or a numeric property name. |
| `getWidth` | `number \| string \| null` | `null` | Upstream-vocabulary alias of `pathWidth` (same domain rules). |
| `colorPalette` | `Color[]` | 10-color palette | Palette for categorical `pathColor` (GPU lookup via `CategoryColorExtension`, up to 4096 entries). |

## Architecture & performance

- **Per-tile binary sublayers**: one `PathLayer` per (tile, layer) pair
  using the binary `data: { length, startIndices, attributes }` interface;
  typed arrays reference the tile's Arrow buffers zero-copy. New tiles are
  additive — one sublayer, one GPU upload.
- **Sublayer + prepared-data caches** with content-keyed style digests, so
  unchanged tiles short-circuit deck.gl's prop diff entirely.
- **Per-tile `timeOffset`** through a window-mode
  [`TimeFilterExtension`](./time-filter-extension.md); time updates flow
  via `getTime()` per draw (no layer recreation per frame).
- **Categorical color on the GPU** via
  [`CategoryColorExtension`](./category-color-extension.md) — category
  indices upload once as a float attribute; the palette is a shared 16 KB
  texture per device.
- **Picking and the attribute budget**: by default sublayers render through
  `NoPickingPathLayer`, which strips `instancePickingColors` — PathLayer's
  13 attributes + TimeFilter's 3 + CategoryColor's 1 = 17 would otherwise
  exceed WebGL2's 16-attribute guaranteed minimum on some GPUs. Setting
  `pickable: true` switches to the stock `PathLayer` so picking works
  (with a one-time warning about the possible link warning on
  16-slot GPUs).

The sublayer short id for `_subLayerProps` overrides is **`paths`**. Without a `type` override the class is `PathLayer` when `pickable`, `NoPickingPathLayer` otherwise.

## Source

[packages/deck.gl/src/animated-path-layer.ts](../../packages/deck.gl/src/animated-path-layer.ts)
