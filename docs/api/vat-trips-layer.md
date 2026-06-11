# VatTripsLayer

The `VatTripsLayer` renders animated trips via **Vertex Animation Textures**: each active trajectory becomes ONE quad (or ribbon) instance, and position-over-time is baked into a 2D texture per tile that the vertex shader samples at the current playhead. GPU work therefore scales with **active trips × vertices-per-instance** and is independent of how many vertices each trajectory had.

Contrast with [`AnimatedTripsLayer`](./animated-trips-layer.md), which uploads every vertex of every trajectory and fades past/future segments with a per-vertex time attribute — work scales with trajectories × average path length. At a 100M+ vertex universe that upload can't fit; VAT is the path to that scale.

## Installation

```typescript
import { VatTripsLayer } from '@stt/deck.gl';
```

## Usage

```typescript
import { VatTripsLayer } from '@stt/deck.gl';

// Head-dot mode (default): one moving dot per active trip.
const dots = new VatTripsLayer({
  id: 'taxi-vat',
  data: '/data/nyc-taxi/manifest.json',
  currentTime,
  timeController,
  headColor: [253, 128, 93, 255],
  headRadiusPixels: 4,
});

// Ribbon-trail mode: trailLength > 0 swaps in the trail sublayer
// (the trail's leading vertex IS the head — no second draw).
const trails = new VatTripsLayer({
  id: 'taxi-vat-trails',
  data: '/data/nyc-taxi/manifest.json',
  currentTime,
  timeController,
  trailLength: 10_000,
  trailSamples: 16,
  trailColor: [253, 128, 93, 255],
  tripWidth: 4,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Head-dot mode (`trailLength === 0`, the default)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `headColor` | `Color` | `[253, 128, 93, 255]` | Constant head-dot color. |
| `headRadiusPixels` | `number` | `4` | Head radius in pixels. |
| `sizeUnits` | `'pixels' \| 'meters'` | `'pixels'` | Units for head radius and trail width. `'meters'` makes sizes world-space (dots/ribbons emerge as you zoom in), clamped by the pixel bounds. |
| `headRadius` | `number` | `0` | Head radius in meters when `sizeUnits === 'meters'` (falls back to `headRadiusPixels` when unset). |
| `headRadiusMinPixels` | `number` | `0` | Min on-screen head radius (meters-mode clamp). |
| `headRadiusMaxPixels` | `number` | `1e9` | Max on-screen head radius (meters-mode clamp). |

### Ribbon-trail mode (`trailLength > 0`)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `trailLength` | `number` | `0` | Trail length in ms. > 0 swaps the head-dot sublayer for the ribbon-trail sublayer. |
| `trailSamples` | `number` | `16` | Vertices per ribbon trail (one instance per active trip). VS work is `activeTrips × (trailSamples + 1) × 2`. 16 is the sweet spot for a 10 s trail; 32 is invisible at zoom ≥ 14. |
| `trailColor` | `Color` | `[253, 128, 93, 255]` | Ribbon color. |
| `tripWidth` | `number` | `4` | Ribbon nominal width in pixels. |
| `widthMinPixels` | `number` | `0` | Minimum on-screen ribbon width. |
| `widthMaxPixels` | `number` | `100` | Maximum on-screen ribbon width. |
| `fadeTrail` | `boolean` | `true` | Fade the trail older→transparent. |

### Texture resolution

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `timeSlots` | `number` | `64` | Time-slot resolution of the VAT (samples per trajectory). Higher = smoother motion / larger texture. 64 ≈ 16 ms per slot for a 1 s trip — the visual sweet spot for the NYC taxi case; raise it for much-longer trips. |

## How it works

1. **Tile prepare** (once per tile, cached): each trip's positions are
   resampled into `timeSlots` evenly-spaced samples across its
   `[startTime, endTime]` window — time-driven interpolation when the tile
   carries `vertexTimestamps` (so a trip that loitered then accelerated
   shows that), vertex-uniform otherwise — and packed into an RG32F
   texture (lon, lat per texel), many trips per row.
2. **Draw**: each instance fetches its position(s) for the current time
   from the texture in the vertex shader. The head dot is a billboarded
   quad; the ribbon samples `trailSamples + 1` recent positions and
   extrudes a screen-space strip.
3. A trip outside `[startTime, endTime]` collapses to zero area —
   visibility is free.

Tile-side data dependencies: ZERO archive changes — it reads the existing `BinaryFeatures` columns (`positions`, `startIndices`, `startTimes`, `endTimes`, optional `vertexTimestamps`).

## Limitations (v1)

- **Float32 positions in the texture** — no fp64 split yet. Expect ~meter-scale
  jitter at zoom ≥ 16 in dense urban grids.
- **Constant color** — no categorical/gradient coloring yet
  (`CategoryColorExtension` wiring is a follow-up).
- **Not pickable** — the VAT sublayers' shaders carry no picking symbols.
- **Capacity caps**: trips per tile are capped at 131,072 (texture-memory
  safety net; the NYC taxi peak is ~25K), within WebGL2's guaranteed
  8192×8192 texture floor.

The sublayer short ids for `_subLayerProps` overrides are **`head`** (dot mode) and **`trail`** (ribbon mode).

## Source

[packages/deck.gl/src/vat-trips-layer.ts](../../packages/deck.gl/src/vat-trips-layer.ts)
