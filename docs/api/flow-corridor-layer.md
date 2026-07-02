# FlowCorridorLayer

The `FlowCorridorLayer` renders a **static-geometry overview whose per-vertex color is a time series**. It is the pre-aggregated OD / flow renderer behind the `nyc-taxi-flows` demo: a corridor network (e.g. street segments carrying taxi volume) is stored **once**, and every corridor "pulses" as the playhead moves — width-constant lines whose color tracks the active flow value.

It extends [`AnimatedTripsLayer`](./animated-trips-layer.md), keeping all of its tile caching and sublayer plumbing, and overrides just the gradient seams so the per-vertex scalar comes from a **time bucket** instead of a single static channel.

## How it works

A flow-corridor tile stores its geometry once and carries a per-vertex × per-time-bucket value matrix (`BinaryFeatures.vertexValueMatrix`, `vertexValueBuckets` columns). The geometry never re-uploads as time advances — only the per-vertex color changes:

- For the current playhead the layer finds the continuous bucket position, selects the two adjacent bucket columns, and **linearly blends** them into a per-vertex scalar. The base class maps that scalar through the gradient ramp into per-vertex RGBA.
- The cross-fade is quantized to a sub-step grid (`STEP = 0.1`, ~10 sub-steps per bucket ≈ 5 Hz at default playback), so the CPU re-expansion fires only when the playhead crosses a sub-step — between sub-steps the prepared-tile cache hits and nothing re-uploads.
- Corridors are **timeless**: each feature's `[start, end]` spans the whole range, so the window-mode time filter never hides the network.

## Installation

```typescript
import { FlowCorridorLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new FlowCorridorLayer({
  id: 'taxi-flows',
  data: '/data/nyc-taxi-flows/manifest.json',
  currentTime,
  gradientDomain: [0, 400],          // flow-count range mapped onto the ramp
  gradientColorRamp: [
    [40, 40, 80, 180],
    [80, 180, 255, 220],
    [255, 220, 120, 255],
  ],
  tripWidth: 2,
});
```

The active-bucket scalar is colored through the inherited per-vertex gradient props — `gradientDomain` and `gradientColorRamp` (the `gradientProperty` channel is selected automatically from the value matrix). See [`AnimatedTripsLayer`](./animated-trips-layer.md) for the full gradient and width prop tables.

## Properties

Inherits all properties from [`AnimatedTripsLayer`](./animated-trips-layer.md) (and through it [`SpatioTemporalLayer`](./spatiotemporal-layer.md)). The relevant inherited props are:

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `gradientDomain` | `[number, number]` | `[0, 1]` | Flow-value range mapped onto the color ramp. |
| `gradientColorRamp` | `Color[]` | `[]` | Low→high color stops (piecewise-lerped) for the pulsing color. |
| `tripWidth` | `number \| string` | `3` | Corridor line width (constant; widths do not animate here). |
| `widthUnits` / `widthScale` / `widthMinPixels` / `widthMaxPixels` | — | — | `PathLayer` width controls (see `AnimatedTripsLayer`). |

`FlowCorridorLayer` also adds its own props, all optional, that control how the active-bucket scalar is derived and how a paired [`ChevronFlowExtension`](./chevron-flow-extension.md) reads direction/intensity off it:

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `signedFlow` | `boolean` | `false` | Treats the value matrix as **signed**: `abs(value)` drives the color (volume) while the sign carries per-bucket travel direction. Set this for tiles built with `bixi --streets --per-bucket-direction`. When on, `chevronDirectionsFor` emits a continuous `[-1, 1]` directional-coherence signal (a rolling `Σsigned / Σ|value|` ratio) instead of the default plain-magnitude blend, so a paired `ChevronFlowExtension` can morph arrow shape/hue/march smoothly between forward and reverse. |
| `chevronPerTripLight` | `boolean` | `false` | Switches the gradient source to a **two-signal** mode built for `ChevronFlowExtension({ perTripLight: true })`: the RGB channel becomes a rolling-window aggregate mean of `abs(value)` (the "style over a granular period" color), and the color buffer's alpha byte is packed with a separate instantaneous per-trip flash (a short trailing decay of the nearest fine bucket) — no extra GPU attribute is needed. |
| `chevronAggregateWindowMs` | `number` | `240000` | Half-span, in ms of data time, of the rolling window used for the `chevronPerTripLight` RGB aggregate (±4 min by default). Wider windows smooth the ramp color further. |
| `chevronInstantDomain` | `number` | `1.5` | Normalization top for the `chevronPerTripLight` instant flash: a trailing-sum value at or above this reads as a full-brightness flash in the alpha channel. Non-positive values fall back to the default. |
| `chevronInstantDecayMs` | `number` | `120000` | Trailing exponential decay time constant, in ms of data time, for the `chevronPerTripLight` instant flash (2 min by default) — controls how long a segment stays lit after a trip passes. |
| `chevronDirectionWindowMs` | `number` | `chevronAggregateWindowMs` | Half-span, in ms of data time, of the rolling window used for the `signedFlow` directional-coherence signal. Defaults to sharing the aggregate window so color and direction resolve at the same temporal granularity; set separately to decouple them. |

These props power the directional chevron rendering used by the `bixi-streets-flow` demo, where `signedFlow` + `chevronPerTripLight` on this layer pair with a `ChevronFlowExtension` added via the inherited `extensions` prop.

## Related layers

[`FlowStrokeLayer`](./flow-stroke-layer.md) extends `FlowCorridorLayer` for merged, directed corridor networks — it keeps the same per-vertex time-bucket coloring and adds breathing width plus twin directional offset ribbons. [`ChevronFlowExtension`](./chevron-flow-extension.md) is the standalone `LayerExtension` form of the marching-arrow effect this layer's `signedFlow` / `chevronPerTripLight` props are designed to feed — it can also be applied to any other `PathLayer`-based layer.

## Difference from FlowmapLayer / FlowLinesLayer

[`FlowmapLayer`](./flowmap-layer.md) and [`FlowLinesLayer`](./flow-lines-layer.md) animate weighted **arrows/arcs** between an origin and destination — the *width* tracks volume at the playhead. `FlowCorridorLayer` instead renders the **static corridor geometry** and animates **color**: the network shape never changes, and each corridor's value pulses through the gradient ramp over time. Use it when you have a fixed network (streets, rails) with a per-segment volume time series, rather than discrete OD pairs.

## Source

[packages/layers/src/layers/trips/flow-corridor-layer.ts](../../packages/layers/src/layers/trips/flow-corridor-layer.ts)
