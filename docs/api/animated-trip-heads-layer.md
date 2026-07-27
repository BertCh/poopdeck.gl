# AnimatedTripHeadsLayer

The `AnimatedTripHeadsLayer` renders a **smooth moving dot at the head of each active trip** — the vehicle's position at the current playhead. The head position is interpolated along each trip's path **on the CPU, once per frame**, and drawn through a stock [`ScatterplotLayer`](https://deck.gl/docs/api-reference/layers/scatterplot-layer). It therefore gets fp64 positions (no high-zoom jitter), real circular markers, globe support, and categorical-color headroom — all on plain deck.gl layers, with zero custom GLSL.

Because the motion is a CPU-computed _position_ (not a per-vertex alpha gate), the dot glides continuously — none of the per-vertex pulsing a short [`AnimatedTripsLayer`](./animated-trips-layer.md) trail shows on sparse (bridge/highway) geometry.

## Installation

```typescript
import { AnimatedTripHeadsLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedTripHeadsLayer } from '@poopdeck.gl/layers';

const heads = new AnimatedTripHeadsLayer({
  id: 'taxi-heads',
  data: '/data/nyc-taxi/manifest.json',
  currentTime,
  timeController,
  headColor: [253, 128, 93, 255],
  // World-space sizing: a 20 m dot that emerges/shrinks with zoom, clamped on screen.
  sizeUnits: 'meters',
  headRadius: 20,
  headRadiusMinPixels: 0,
  headRadiusMaxPixels: 8,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property              | Type                               | Default                                           | Description                                                                                                                                                                                                                                                                                                                                             |
| :-------------------- | :--------------------------------- | :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headColor`           | `Color`                            | `[253, 128, 93, 255]`                             | Head-dot color (RGBA, 0–255).                                                                                                                                                                                                                                                                                                                           |
| `sizeUnits`           | `'pixels' \| 'meters' \| 'common'` | `'pixels'`                                        | Units for the head radius, forwarded to `ScatterplotLayer.radiusUnits`. `'pixels'` is screen-space; **anything else is world-space** — `'meters'` makes the dot emerge/shrink with zoom, `'common'` is deck's projection-space unit — and reads the radius from `headRadius` (falling back to `headRadiusPixels`), clamped by the min/max-pixel bounds. |
| `headRadiusPixels`    | `number`                           | `4`                                               | Head radius in pixels (used when `sizeUnits === 'pixels'`).                                                                                                                                                                                                                                                                                             |
| `headRadius`          | `number`                           | `0`                                               | Head radius in world units (used for any non-`'pixels'` `sizeUnits`; falls back to `headRadiusPixels` when left at `0`).                                                                                                                                                                                                                                |
| `headRadiusMinPixels` | `number`                           | `0`                                               | Minimum on-screen head radius in pixels (world-space clamp).                                                                                                                                                                                                                                                                                            |
| `headRadiusMaxPixels` | `number`                           | `1e9` (effectively unbounded)                     | Maximum on-screen head radius in pixels (world-space clamp).                                                                                                                                                                                                                                                                                            |
| `radiusScale`         | `number`                           | `1`                                               | Global multiplier applied to every head radius before the min/max-pixel clamp (`ScatterplotLayer` `radiusScale` pass-through) — a one-knob emphasis pulse without touching the per-dot radius.                                                                                                                                                          |
| `headBillboard`       | `boolean`                          | `false`                                           | Render the head dots as camera-facing billboards (`ScatterplotLayer` `billboard` pass-through) — matters in the globe / pitched / space-time-cube views where a ground-plane disk would foreshorten.                                                                                                                                                    |
| `antialiasing`        | `boolean`                          | `true`                                            | Smooth-edge antialiasing (`ScatterplotLayer` `antialiasing` pass-through). Disable to reduce blending artifacts on dense overlapping dots.                                                                                                                                                                                                              |
| `headStroked`         | `boolean`                          | `false`                                           | Draw an outline ring around each head (`ScatterplotLayer` `stroked` pass-through).                                                                                                                                                                                                                                                                      |
| `headFilled`          | `boolean`                          | `true`                                            | Fill the head disk (`ScatterplotLayer` `filled` pass-through). Set `false` with `headStroked` for hollow rings.                                                                                                                                                                                                                                         |
| `headStrokeColor`     | `Color`                            | `[0, 0, 0, 255]`                                  | Outline color (RGBA, 0–255), forwarded to `ScatterplotLayer` `getLineColor`. Constant only.                                                                                                                                                                                                                                                             |
| `headStrokeWidth`     | `number`                           | `1`                                               | Outline width, forwarded to `ScatterplotLayer` `getLineWidth`. Constant only; interpreted in `lineWidthUnits` and clamped by the pixel bounds below.                                                                                                                                                                                                    |
| `lineWidthUnits`      | `'pixels' \| 'meters' \| 'common'` | `'meters'`                                        | Units for `headStrokeWidth` (`ScatterplotLayer` `lineWidthUnits` pass-through). Deck-parity default: world-space meters.                                                                                                                                                                                                                                |
| `lineWidthScale`      | `number`                           | `1`                                               | Global multiplier for the outline width (`ScatterplotLayer` `lineWidthScale` pass-through).                                                                                                                                                                                                                                                             |
| `lineWidthMinPixels`  | `number`                           | `0`                                               | Minimum on-screen outline width in pixels (`ScatterplotLayer` `lineWidthMinPixels` pass-through).                                                                                                                                                                                                                                                       |
| `lineWidthMaxPixels`  | `number`                           | `Number.MAX_SAFE_INTEGER` (effectively unbounded) | Maximum on-screen outline width in pixels (`ScatterplotLayer` `lineWidthMaxPixels` pass-through).                                                                                                                                                                                                                                                       |

## How it works

0. **Geometry-kind guard**: tile layers whose `geometryType` is not `LineString` are skipped with one named console warning, rather than misread as a vertex run they are not.
1. **Tile prepare** (once per tile, cached): the tile's `positions`/`startIndices`/`startTimes`/`endTimes` are referenced zero-copy; per-vertex times come from `vertexTimestamps` when present, otherwise they are synthesized distance-proportionally.
2. **Per frame**: for every trip _active_ at the playhead, a binary-search + lerp finds the head position along its path. Inactive trips are simply not emitted (a trip pops in at its start and out at its end). The active heads are handed to a `ScatterplotLayer` as a binary `data` buffer.
3. Like [`FlowCorridorLayer`](./flow-corridor-layer.md), the layer bumps a state counter to force a `renderLayers()` pass each frame so the CPU-computed positions advance (unlike [`AnimatedTripsLayer`](./animated-trips-layer.md), which animates via a shader uniform and only needs a redraw).

Cost scales with the number of _active_ trips over the visible tiles (a few thousand at most at metro scale) — well under 1 ms/frame.

Tile-side data dependencies: ZERO archive changes — it reads the same `BinaryFeatures` columns as [`AnimatedTripsLayer`](./animated-trips-layer.md).

## Limitations

- **Not pickable** — the active-only instance buffer reorders indices, so picking is disabled (it would mis-map to a feature). Aligned picking (emitting a per-instance feature index) is a follow-up.

The sublayer short id for `_subLayerProps` overrides is **`heads`**.

## Source

[packages/layers/src/layers/trips/animated-trip-heads-layer.ts](../../packages/layers/src/layers/trips/animated-trip-heads-layer.ts)
