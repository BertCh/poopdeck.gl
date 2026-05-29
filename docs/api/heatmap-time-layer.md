# HeatmapLayer

> Previously documented as `HeatmapTimeLayer` (an `@deck.gl/aggregation-layers`
> wrapper). That implementation was replaced with a GPU-splat layer that
> renders directly from the binary tile buffers — same import path, new
> class name (`HeatmapLayer`).

The `HeatmapLayer` renders temporal point data as an animated density
heatmap. It is a **single-pass GPU splat**: each point is drawn as a
gaussian-weighted quad with **additive blending directly to the canvas**
(no offscreen framebuffer / FBO accumulation pass), and overlapping splats
sum per-pixel. The accumulated intensity is mapped through a palette LUT in
the fragment shader.

The per-(tile, channel) GPU vertex buffers (`instancePosition`,
`instanceTime`, `instanceWeight`) are uploaded **once** when a tile first
arrives and reused across every subsequent frame — there is zero per-frame
buffer allocation and no per-frame CPU filter. Time filtering is done in
the shader against a small uniform updated each frame. (Per-frame cost still
scales with the number of splats drawn, since every active splat is one
instanced quad; the win is the eliminated per-frame upload/rebuild, not a
fixed cost.)

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and supports
up to four stacked categorical channels (one per RGBA accumulator slot),
each rendered as a sub-draw with the shared shader.

## Installation

```typescript
import { HeatmapLayer } from '@stt/deck.gl';
```

## Usage

### Single-channel (default)

```typescript
const layer = new HeatmapLayer({
  id: 'earthquake-heat',
  data: '/data/earthquakes.stt',
  currentTime: 1672531200000,
  timeWindow: 86_400_000,           // 1 day
  radiusPixels: 30,
  intensity: 1,
  weightProperty: 'magnitude',      // per-splat weight
  colorDomain: [4.0, 6.5],          // pin the ramp — protects against jitter
  colorRange: [
    [255, 255, 178, 255],
    [254, 204, 92, 255],
    [253, 141, 60, 255],
    [240, 59, 32, 255],
    [189, 0, 38, 255],
  ],
});
```

If the archive was built with `stt-build --heatmap-weight <prop>`, the
layer reads `metadata.heatmapDomain` and pins `colorDomain` automatically
to the baked `[min, 95p]` range. Setting `colorDomain` explicitly always
wins.

### Stacked categorical channels

```typescript
const layer = new HeatmapLayer({
  id: 'taxi-od',
  data: '/data/nyc-taxi-od.stt',
  currentTime,
  timeWindow: 30 * 60 * 1000,
  radiusPixels: 40,
  channels: [
    {
      id: 'pickup',
      categoryFilter: { property: 'kind', values: ['pickup'] },
      colorRange: PICKUP_RAMP,
      colorDomain: [1, 80],
    },
    {
      id: 'dropoff',
      categoryFilter: { property: 'kind', values: ['dropoff'] },
      colorRange: DROPOFF_RAMP,
      colorDomain: [1, 80],
    },
  ],
});
```

Up to four channels pack into the RGBA accumulator; beyond that the
layer warns and renders only the first four.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render

| Property | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `radiusPixels` | `number` | `30` | Splat radius in pixels |
| `intensity` | `number` | `1` | Global per-splat multiplier |
| `weightProperty` | `string` | `undefined` | Numeric property → per-splat weight. Defaults to `1.0`. |
| `colorRange` | `Color[]` | OrRd | Low → high density ramp (single-channel mode) |
| `colorDomain` | `[number, number]` | `[0, 1]` or baked-in | Pinned intensity domain (single-channel mode) |
| `threshold` | `number` | `0.05` | Hide pixels with accumulated intensity below this |
| `fadeInDuration` | `number` | `0` | Leading-edge alpha ramp (ms) |
| `fadeOutDuration` | `number` | `0` | Trailing-edge alpha ramp (ms) |

### Stacked channels (`channels`)

When supplied, each entry produces one sub-draw using the shared shader
and accumulator.

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `id` | `string` | — | Channel id; matches `metadata.heatmapDomain.classes[*].id` when present |
| `categoryFilter` | `{ property, values[] }` | — | Only features matching this categorical filter contribute to the channel |
| `colorRange` | `Color[]` | OrRd | Per-channel ramp |
| `colorDomain` | `[number, number]` | `[0, 1]` or baked-in | Pinned per-channel intensity domain |
| `intensity` | `number` | `1` | Per-channel weight multiplier stacked on top of the global one |

## Build-time intensity domain

The renderer can pin `colorDomain` from archive metadata when the build
sets it. Use `stt-build --heatmap-weight <prop>` (and optionally
`--heatmap-class <prop>` for per-class domains) — the build computes
`[min, 95th-percentile]` across all features and writes it to
`metadata.heatmapDomain`. 95p (not absolute max) protects the ramp from
single-outlier dimming.

## Source

[`packages/deck.gl/src/heatmap-layer.ts`](../../packages/deck.gl/src/heatmap-layer.ts)
