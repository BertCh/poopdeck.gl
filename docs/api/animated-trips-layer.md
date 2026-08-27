# AnimatedTripsLayer

The `AnimatedTripsLayer` renders animated trajectories with a "vehicle moving along route" effect. Paths are progressively drawn with a trailing fade, making it ideal for taxi routes, delivery paths, or any moving entity visualization.

It runs the [`TimeFilterExtension`](./time-filter-extension.md) in **trail mode**, driven by per-vertex timestamps (`BinaryFeatures.vertexTimestamps`). When a tile lacks per-vertex times, the layer synthesizes them by cumulative haversine distance across each path (matching the Rust builder's interpolation), so long segments animate at the right speed instead of "flashing".

## Installation

```typescript
import { AnimatedTripsLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedTripsLayer } from '@poopdeck.gl/layers';

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
  gradientProperty: 'vertexValues', // the tile's per-vertex scalar channel
  gradientDomain: [271, 305], // Kelvin
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

| Property         | Type                               | Default    | Description                                                                                                                                                                                                                                                                                       |
| :--------------- | :--------------------------------- | :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `widthUnits`     | `'pixels' \| 'meters' \| 'common'` | `'pixels'` | `'meters'` makes widths world-space so trails thicken/thin with zoom (clamped by the pixel bounds).                                                                                                                                                                                               |
| `widthScale`     | `number`                           | `1`        | Global multiplier for path widths.                                                                                                                                                                                                                                                                |
| `widthMinPixels` | `number`                           | `2`        | Minimum width in pixels.                                                                                                                                                                                                                                                                          |
| `widthMaxPixels` | `number`                           | `10`       | Maximum width in pixels.                                                                                                                                                                                                                                                                          |
| `trailLength`    | `number`                           | `180000`   | Trail length in milliseconds (3 minutes default).                                                                                                                                                                                                                                                 |
| `fadeTrail`      | `boolean`                          | `true`     | Fade the trail older→transparent. **Diverges from upstream `TripsLayer`** — read [Trail semantics](#trail-semantics-fadetrail-diverges-from-upstream) before porting a config.                                                                                                                    |
| `capRounded`     | `boolean`                          | `true`     | Round caps on path ends. Upstream `PathLayer` defaults to `false`; trails read better round.                                                                                                                                                                                                      |
| `jointRounded`   | `boolean`                          | `true`     | Round joints between path segments. Same upstream drift as `capRounded`.                                                                                                                                                                                                                          |
| `miterLimit`     | `number`                           | `4`        | Miter-joint length cap in multiples of line width (PathLayer pass-through; applies when `jointRounded` is `false`).                                                                                                                                                                               |
| `pathType`       | `'open' \| 'loop'`                 | `'open'`   | Path closure — `PathLayer._pathType` pass-through. `'open'` draws each LineString as-is; `'loop'` closes it back onto its first vertex. STT tiles arrive pre-normalized, so upstream's third mode (`undefined` ⇒ normalize on the CPU) is deliberately not offered — it would re-walk every path. |
| `billboard`      | `boolean`                          | `false`    | Extrude lines in screen space so they always face the camera (PathLayer pass-through).                                                                                                                                                                                                            |

### Data Accessors

| Property              | Type                            | Default                | Description                                                                                                                                                                                        |
| :-------------------- | :------------------------------ | :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tripColor`           | `Color \| string`               | `[253, 128, 93, 255]`  | Trip color: constant RGBA, or a property name for categorical coloring.                                                                                                                            |
| `getColor`            | `Color \| string \| null`       | `null`                 | Upstream-vocabulary (TripsLayer/PathLayer) alias of `tripColor`. Accepts a constant or a property-column NAME — NOT a function accessor (a function warns once and falls back). When set, it wins. |
| `tripWidth`           | `number \| string`              | `3`                    | Trip width: constant, or a numeric property name.                                                                                                                                                  |
| `getWidth`            | `number \| string \| null`      | `null`                 | Upstream-vocabulary alias of `tripWidth` (same domain rules).                                                                                                                                      |
| `colorPalette`        | `Color[]`                       | 5-color palette        | Palette for categorical `tripColor`. Indices are assigned per-tile in first-seen order — use `colorMapping` for cross-tile stability.                                                              |
| `colorMapping`        | `Record<string, Color> \| null` | `null`                 | Explicit category-string → color map, resolved per-tile against each tile's own category dictionary so colors stay consistent across tiles. Takes precedence over `colorPalette`.                  |
| `colorMappingDefault` | `Color`                         | `[120, 120, 120, 255]` | Fallback for categories absent from `colorMapping` (also the gradient `NaN` fallback).                                                                                                             |

### Per-vertex gradient

| Property            | Type               | Default  | Description                                                                                                                                                                                                                                                                                                                 |
| :------------------ | :----------------- | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gradientProperty`  | `string \| null`   | `null`   | Names which per-vertex scalar channel to color by — the one supported channel is `'vertexValues'` (see [Binary Features](./binary-features.md)). When set and the tile carries that channel, each vertex's value maps through the ramp, shading the line _along its length_. Takes precedence over categorical `tripColor`. |
| `gradientDomain`    | `[number, number]` | `[0, 1]` | Value range mapped onto the ramp.                                                                                                                                                                                                                                                                                           |
| `gradientColorRamp` | `Color[]`          | `[]`     | Low→high color stops (piecewise-lerped).                                                                                                                                                                                                                                                                                    |

### Column range filter

Wires a baked numeric column into
[`STTDataFilterExtension`](./data-filter-extension.md). Trips whose value falls
inside `filterRange` render; the rest are hidden, or soft-faded via
`filterSoftRange`. It composes with the trail-mode time filter — a trip must
pass both. The value is per-**feature** (all vertices of a trip share it),
splatted per-vertex to match `PathLayer`'s segment-instanced attribute layout.

| Property          | Type                       | Default | Description                                                   |
| :---------------- | :------------------------- | :------ | :------------------------------------------------------------ |
| `filterProperty`  | `string \| null`           | `null`  | Name of the baked numeric column to filter by.                |
| `filterRange`     | `[number, number] \| null` | `null`  | Inclusive `[min, max]` bounds.                                |
| `filterSoftRange` | `[number, number] \| null` | `null`  | Soft bounds inside `filterRange`; trips between the two fade. |
| `filterEnabled`   | `boolean`                  | `true`  | Toggle the filter without dropping the bound attribute.       |

`filterProperty` is the accessor-alias of deck's `getFilterValue`: pass a column
NAME, not a function (a function warns once and is ignored). Leaving it unset
means the extension is not installed at all — zero attribute, zero uniform, zero
shader change. Setting it costs one attribute slot, so the layer drops the idle
`CategoryColorExtension` (categorical color is CPU-expanded here, so it was
never coloring anything) to stay inside WebGL2's guaranteed 16-attribute floor.

## Trail semantics: `fadeTrail` diverges from upstream

Upstream `TripsLayer` discards a vertex only when
`vTime > currentTime || (fadeTrail && vTime < currentTime - trailLength)`, so
**`fadeTrail: false` never culls the tail** — the whole traversed path stays
drawn at full opacity ("ink the route as it is driven").

STT's [`TimeFilterExtension`](./time-filter-extension.md) **always** culls at
`vertexTime < trailStart` and uses this prop only to pick a ramped vs a flat
alpha. So here `fadeTrail: false` yields a fixed-length **solid snake**, not an
accumulating path. For the upstream accumulating look, use the inherited
`cumulative` prop (whole-feature reveal) or set `trailLength` to the dataset's
full span.

The cull is shared with the `trailAlpha()` kernel oracle in
`@poopdeck.gl/core/time-filter` that the three/maplibre backends are pinned
against, so this is not a deck-only knob.

## Deliberate default drift

Against upstream `PathLayer`/`TripsLayer`:

| Property         | STT default | deck default       |
| :--------------- | :---------- | :----------------- |
| `widthUnits`     | `'pixels'`  | `'meters'`         |
| `widthMinPixels` | `2`         | `0`                |
| `widthMaxPixels` | `10`        | `MAX_SAFE_INTEGER` |
| `jointRounded`   | `true`      | `false`            |
| `capRounded`     | `true`      | `false`            |

The `widthMaxPixels` cap is the one that bites: a caller who switches to
`widthUnits: 'meters'` and scales up silently clamps at 10 px. That combination
warns once.

## Per-segment trail time

The trail time is interpolated along each segment and the fade runs per
**fragment**, so the head glides instead of stepping vertex to vertex. It gets
that without a second attribute: `instanceEndTime` is dead weight in trail mode
— the trail branch never reads it — so it is loaded with the **next vertex's**
time and [`TimeFilterExtension`](./time-filter-extension.md) interpolates
between the two.

- **Size `trailLength` above the archive's vertex spacing.** The interpolation
  removes the blinking, but a trail shorter than one segment is still just a
  short dash.
- Off-trail segments are collapsed in the **vertex** stage (visibility is
  decided from both endpoints), so a long trail over a dense tile pays no
  fragment cost for the dark parts of the route.

For a "one dot per vehicle" read, use
[`AnimatedTripHeadsLayer`](./animated-trip-heads-layer.md).

## Tile loading window

The layer widens the effective loading window to `max(timeWindow, 2 × trailLength)` so tiles containing trail data behind the playhead are resident — the shader's trail filter is independent of the loader window.

## Difference from AnimatedPathLayer

| Feature          | AnimatedPathLayer                   | AnimatedTripsLayer                     |
| ---------------- | ----------------------------------- | -------------------------------------- |
| Effect           | Whole paths on/off with window fade | Progressive drawing ("moving vehicle") |
| Time granularity | Per-feature `[start, end]`          | Per-vertex timestamps                  |
| Use case         | Ship tracks, flight paths           | Taxi routes, delivery animations       |

To show a moving marker at each vehicle's current position instead of a trail, see [`AnimatedTripHeadsLayer`](./animated-trip-heads-layer.md), which interpolates the head position per frame and draws it on a stock ScatterplotLayer.

## Architecture & performance

- **Geometry-kind guard**: tile layers whose `geometryType` is not `LineString`
  are skipped with one named console warning, rather than misreading the
  position buffer.
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

[packages/layers/src/layers/trips/animated-trips-layer.ts](../../packages/layers/src/layers/trips/animated-trips-layer.ts)
