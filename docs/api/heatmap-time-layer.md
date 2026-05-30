# HeatmapLayer

The `HeatmapLayer` renders temporal point data as an animated density
heatmap. It is a thin composite over the **canonical deck.gl
[`HeatmapLayer`](https://deck.gl/docs/api-reference/aggregation-layers/heatmap-layer)**
(`@deck.gl/aggregation-layers`): points are splatted into a GPU weight
texture with **additive density accumulation**, reduced to a per-pixel
density, and only then mapped through the colour ramp. Dense regions get
hotter because more splats land on the same pixels — true per-pixel density,
not per-splat colour blending.

> **Why the rewrite.** An earlier implementation hand-rolled a single-pass
> splat shader that sampled the palette *per splat* (each point coloured by
> its own weight) and additively blended the resulting *colours*. Overlapping
> points summed colours instead of density, so hot zones blew out and the
> result never read as a heatmap. The current layer hands the
> splat→accumulate→ramp pipeline to deck.gl's tested implementation. Same
> import path and public API.

**Time animation.** The canonical HeatmapLayer has no notion of time, so the
window is driven by `@deck.gl/extensions`'
[`DataFilterExtension`](https://deck.gl/docs/api-reference/extensions/data-filter-extension):
each point carries a relativized timestamp as `getFilterValue`, and the
`filterRange` (the `[start, end]` window around the play head) is recomputed
each frame. Out-of-window points contribute zero density during the weights
aggregation pass — and changing `filterRange` **re-runs the aggregation**, so
the heatmap genuinely re-densifies as the play head moves (it is not a
cross-fade). The re-aggregation cadence is capped (default 30 Hz) independently
of tile loading.

**Data feed.** Points from every visible tile are consolidated into one binary
buffer set per channel (not per-tile sublayers), so the canonical layer
normalises against a single global max — no per-tile brightness seams, and
gaussian splats accumulate correctly across tile borders. The consolidated
buffers are cached by visible-tile-set key and rebuilt only when that set (or
the channel config) changes; per frame only the small `filterRange` array
changes, so nothing is re-uploaded — only the GPU aggregation re-runs.

f32 precision: both the per-point filter value and `filterRange` are
relativized against a single layer time offset (the first visible tile's
offset), keeping both sides of the shader comparison inside the Float32
mantissa budget (≈ 2²⁴ ms ≈ 4.6 h around the offset; longer-spanning windows
quantize at the edges — the same bound the previous layer had).

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and supports up
to four stacked categorical channels, each rendered as its own canonical
HeatmapLayer (own ramp + density normalisation) composited in order.

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

Up to four channels are supported (one canonical HeatmapLayer each); beyond
that the layer warns and renders only the first four.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render

| Property | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `radiusPixels` | `number` | `30` | Splat radius in pixels |
| `intensity` | `number` | `1` | Global intensity multiplier (canonical `intensity`) |
| `weightProperty` | `string` | `undefined` | Numeric property → per-point weight. Defaults to `1.0`. |
| `colorRange` | `Color[]` | OrRd | Low → high density ramp (single-channel mode) |
| `colorDomain` | `[number, number]` | auto / baked-in | Pinned density domain. **Unset → the layer auto-normalises against the current window's max each frame** (so colours may "breathe" as the window slides; pin it to keep the mapping stable). |
| `threshold` | `number` | `0.05` | Density fraction below which pixels are transparent. **Only takes effect when `colorDomain` is unset** (the pinned-domain path supersedes it). |
| `fadeInDuration` | `number` | `0` | Leading-edge fade (ms), mapped onto the filter soft-range |
| `fadeOutDuration` | `number` | `0` | Trailing-edge fade (ms) |
| `historyWeight` | `number` | `0` | **Deprecated / no-op.** Accepted for API compatibility; the canonical aggregation pipeline has no TAA blend. |

### Stacked channels (`channels`)

When supplied, each entry renders as its own canonical HeatmapLayer (its own
ramp + density normalisation), composited in order.

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `id` | `string` | — | Channel id; matches `metadata.heatmapDomain.classes[*].id` when present |
| `categoryFilter` | `{ property, values[] }` | — | Only features matching this categorical filter contribute to the channel |
| `colorRange` | `Color[]` | OrRd | Per-channel ramp |
| `colorDomain` | `[number, number]` | auto / baked-in | Pinned per-channel density domain (see note above) |
| `intensity` | `number` | `1` | Per-channel weight multiplier, folded into the point weight |

## Build-time intensity domain

The renderer can pin `colorDomain` from archive metadata when the build
sets it. Use `stt-build --heatmap-weight <prop>` (and optionally
`--heatmap-class <prop>` for per-class domains) — the build computes
`[min, 95th-percentile]` across all features and writes it to
`metadata.heatmapDomain`. 95p (not absolute max) protects the ramp from
single-outlier dimming.

## Source

[`packages/deck.gl/src/heatmap-layer.ts`](../../packages/deck.gl/src/heatmap-layer.ts)
