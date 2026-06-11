# AnimatedTripsLayer

The `AnimatedTripsLayer` renders animated trajectories with a "vehicle moving along route" effect. Paths are progressively drawn with a trailing fade, making it ideal for taxi routes, delivery paths, or any moving entity visualization.

It runs the [`TimeFilterExtension`](./time-filter-extension.md) in **trail mode**, driven by per-vertex timestamps (`BinaryFeatures.vertexTimestamps`). When a tile lacks per-vertex times, the layer synthesizes them by cumulative haversine distance across each path (matching the Rust builder's interpolation), so long segments animate at the right speed instead of "flashing".

## Installation

```typescript
import { AnimatedTripsLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { AnimatedTripsLayer } from '@stt/deck.gl';

const layer = new AnimatedTripsLayer({
  id: 'taxi-trips',
  data: 'https://example.com/taxis/manifest.json',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  tripColor: [253, 128, 93, 255],
  tripWidth: 4,
  trailLength: 120000, // 2 minute trail
  fadeTrail: true,
});
```

### Per-vertex gradient coloring (e.g. SST along drifter tracks)

```typescript
const layer = new AnimatedTripsLayer({
  id: 'drifters',
  data: '/data/drifters/manifest.json',
  currentTime,
  trailLength: 14 * 86400000,
  gradientProperty: 'vertexValues',     // the tile's per-vertex scalar channel
  gradientDomain: [271, 305],           // Kelvin
  gradientColorRamp: [
    [49, 54, 149, 255],
    [255, 255, 191, 255],
    [165, 0, 38, 255],
  ],
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `widthUnits` | `'pixels' \| 'meters' \| 'common'` | `'pixels'` | `'meters'` makes widths world-space so trails thicken/thin with zoom (clamped by the pixel bounds). |
| `widthScale` | `number` | `1` | Global multiplier for path widths. |
| `widthMinPixels` | `number` | `2` | Minimum width in pixels. |
| `widthMaxPixels` | `number` | `10` | Maximum width in pixels. |
| `trailLength` | `number` | `180000` | Trail length in milliseconds (3 minutes default). |
| `fadeTrail` | `boolean` | `true` | Fade the trail older→transparent (vs a solid constant-opacity snake). |
| `capRounded` | `boolean` | `true` | Round caps on path ends. |
| `jointRounded` | `boolean` | `true` | Round joints between path segments. |
| `miterLimit` | `number` | `4` | Miter-joint length cap in multiples of line width (PathLayer pass-through; applies when `jointRounded` is `false`). |
| `billboard` | `boolean` | `false` | Extrude lines in screen space so they always face the camera (PathLayer pass-through). |

### Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `tripColor` | `Color \| string` | `[253, 128, 93, 255]` | Trip color: constant RGBA, or a property name for categorical coloring. |
| `getColor` | `Color \| string \| null` | `null` | Upstream-vocabulary (TripsLayer/PathLayer) alias of `tripColor`. Accepts a constant or a property-column NAME — NOT a function accessor (a function warns once and falls back). When set, it wins. |
| `tripWidth` | `number \| string` | `3` | Trip width: constant, or a numeric property name. |
| `getWidth` | `number \| string \| null` | `null` | Upstream-vocabulary alias of `tripWidth` (same domain rules). |
| `colorPalette` | `Color[]` | 5-color palette | Palette for categorical `tripColor`. Indices are assigned per-tile in first-seen order — use `colorMapping` for cross-tile stability. |
| `colorMapping` | `Record<string, Color> \| null` | `null` | Explicit category-string → color map, resolved per-tile against each tile's own category dictionary so colors stay consistent across tiles. Takes precedence over `colorPalette`. |
| `colorMappingDefault` | `Color` | `[120, 120, 120, 255]` | Fallback for categories absent from `colorMapping` (also the gradient `NaN` fallback). |

### Per-vertex gradient

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `gradientProperty` | `string \| null` | `null` | Names which per-vertex scalar channel to color by — the one supported channel is `'vertexValues'` (see [Binary Features](./binary-features.md)). When set and the tile carries that channel, each vertex's value maps through the ramp, shading the line *along its length*. Takes precedence over categorical `tripColor`. |
| `gradientDomain` | `[number, number]` | `[0, 1]` | Value range mapped onto the ramp. |
| `gradientColorRamp` | `Color[]` | `[]` | Low→high color stops (piecewise-lerped). |

## Tile loading window

The layer widens the effective loading window to `max(timeWindow, 2 × trailLength)` so tiles containing trail data behind the playhead are resident — the shader's trail filter is independent of the loader window.

## Difference from AnimatedPathLayer

| Feature | AnimatedPathLayer | AnimatedTripsLayer |
|---------|-------------------|-------------------|
| Effect | Whole paths on/off with window fade | Progressive drawing ("moving vehicle") |
| Time granularity | Per-feature `[start, end]` | Per-vertex timestamps |
| Use case | Ship tracks, flight paths | Taxi routes, delivery animations |

To show a moving marker at each vehicle's current position instead of a trail, see [`AnimatedTripHeadsLayer`](./animated-trip-heads-layer.md), which interpolates the head position per frame and draws it on a stock ScatterplotLayer.

## Architecture & performance

- **Per-tile binary sublayers** (one `PathLayer` per tile/layer pair) with
  zero-copy Arrow-backed attributes; streaming is additive.
- **Per-vertex times**: `vertexTimestamps` ride straight from the tile;
  the haversine fallback is computed once per tile and cached.
- **Sublayer + prepared-data caches** keyed by content digests; per-frame
  time updates are uniform-only via `getTime()`.
- **Categorical/gradient colors**: both expand to per-vertex RGBA on the
  CPU once per tile — PathLayer renders segments as instances, so the GPU
  `CategoryColorExtension`'s per-feature index can't ride its tessellation
  (the extension stays installed for shader-cache stability but is idle
  here). Per-vertex `getColor` is also what makes along-the-line gradients
  possible.
- **Non-pickable by default** via `NoPickingPathLayer` to stay within
  WebGL2's 16-attribute floor; `pickable: true` switches to the stock
  `PathLayer` (see [`AnimatedPathLayer`](./animated-path-layer.md) for the
  trade-off).

The sublayer short id for `_subLayerProps` overrides is **`trips`**.

## Source

[packages/deck.gl/src/animated-trips-layer.ts](../../packages/deck.gl/src/animated-trips-layer.ts)
