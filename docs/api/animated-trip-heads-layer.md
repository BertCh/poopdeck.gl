# AnimatedTripHeadsLayer

The `AnimatedTripHeadsLayer` renders a **smooth moving dot at the head of each active trip** — the vehicle's position at the current playhead. The head position is interpolated along each trip's path **on the CPU, once per frame**, and drawn through a stock [`ScatterplotLayer`](https://deck.gl/docs/api-reference/layers/scatterplot-layer). It therefore gets fp64 positions (no high-zoom jitter), real circular markers, globe support, and categorical-color headroom — all on plain deck.gl layers, with zero custom GLSL.

Because the motion is a CPU-computed *position* (not a per-vertex alpha gate), the dot glides continuously — none of the per-vertex pulsing a short [`AnimatedTripsLayer`](./animated-trips-layer.md) trail shows on sparse (bridge/highway) geometry.

## Installation

```typescript
import { AnimatedTripHeadsLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { AnimatedTripHeadsLayer } from '@stt/deck.gl';

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

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `headColor` | `Color` | `[253, 128, 93, 255]` | Head-dot color (RGBA, 0–255). |
| `sizeUnits` | `'pixels' \| 'meters'` | `'pixels'` | Units for the head radius. `'meters'` makes the dot world-space (emerges on zoom), using `headRadius` and clamped by the min/max-pixel bounds. |
| `headRadiusPixels` | `number` | `4` | Head radius in pixels (used when `sizeUnits === 'pixels'`). |
| `headRadius` | `number` | `0` | Head radius in metres (used when `sizeUnits === 'meters'`; falls back to `headRadiusPixels`). |
| `headRadiusMinPixels` | `number` | `0` | Minimum on-screen head radius in pixels (meters-mode clamp). |
| `headRadiusMaxPixels` | `number` | unbounded | Maximum on-screen head radius in pixels (meters-mode clamp). |

## How it works

1. **Tile prepare** (once per tile, cached): the tile's `positions`/`startIndices`/`startTimes`/`endTimes` are referenced zero-copy; per-vertex times come from `vertexTimestamps` when present, otherwise they are synthesized distance-proportionally.
2. **Per frame**: for every trip *active* at the playhead, a binary-search + lerp finds the head position along its path. Inactive trips are simply not emitted (a trip pops in at its start and out at its end). The active heads are handed to a `ScatterplotLayer` as a binary `data` buffer.
3. Like [`FlowCorridorLayer`](./animated-trips-layer.md), the layer forces a `renderLayers()` pass each frame so the CPU-computed positions advance.

Cost scales with the number of *active* trips over the visible tiles (a few thousand at most at metro scale) — well under 1 ms/frame.

Tile-side data dependencies: ZERO archive changes — it reads the same `BinaryFeatures` columns as [`AnimatedTripsLayer`](./animated-trips-layer.md).

## Limitations

- **Not pickable** — the active-only instance buffer reorders indices, so picking is disabled (it would mis-map to a feature). Aligned picking (emitting a per-instance feature index) is a follow-up.

The sublayer short id for `_subLayerProps` overrides is **`heads`**.

## Source

[packages/deck.gl/src/layers/trips/animated-trip-heads-layer.ts](../../packages/deck.gl/src/layers/trips/animated-trip-heads-layer.ts)
