# FlowmapLayer

The `FlowmapLayer` renders a **flowmap.gl-style animated origin→destination flowmap**: one weighted arc per OD pair whose **width tracks trip volume at the playhead**, plus **node circles sized by each location's incident flow**. As the time slider scrubs, corridors swell and recede with demand and the node circles pulse — the classic flowmap-over-time look.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and fuses two existing STT mechanisms, so it needs **no special tile type**:

- **OD arcs** — like [`AnimatedArcLayer`](./animated-arc-layer.md), each tile feature is a **2-vertex LineString**; the layer derives instanced `getSourcePosition`/`getTargetPosition` from the first/last vertex and draws through deck.gl's `ArcLayer`.
- **Animate-from-a-matrix** — like [`FlowCorridorLayer`](./animated-trips-layer.md), each feature carries a **`[2 × numBuckets]` per-bucket count matrix** ([`vertexValueMatrix`](./binary-features.md)). The layer reads the active bucket (linearly blended across a sub-step) as the per-arc flow → arc width, and sums that flow at each endpoint → node radius. Geometry stays resident; only the width buffer re-expands when the playhead crosses a sub-step (~5 Hz), so the tile **loads once and never re-fetches**.

There is no time-window filter — an arc with ~0 current flow simply gets width 0 (invisible), which **is** the animation.

The natural producer is `stt-generate bixi`, which aggregates real [BIXI Montréal open data](https://bixi.com/en/open-data/) trips into directed OD-pair corridors carrying an hourly `vertexValueMatrix`.

## Installation

```typescript
import { FlowmapLayer } from '@stt/deck.gl';
```

## Usage

```typescript
const layer = new FlowmapLayer({
  id: 'bixi-flowmap',
  data: '/data/bixi-flowmap/manifest.json',
  currentTime,                       // driven live from the TimeController
  timeController,
  widthScale: 1.1,                   // arc px per sqrt(current-bucket trips)
  widthMaxPixels: 14,
  sourceColor: [56, 196, 232, 235],  // origin — cyan
  targetColor: [255, 142, 64, 245],  // destination — warm orange
  arcHeight: 0.5,
  nodeRadiusScale: 1.3,              // node px per sqrt(incident flow)
  minFlow: 0.5,                       // hide corridors below ~1 trip this bucket
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Arcs

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `widthScale` | `number` | `1.1` | Arc width in pixels per `sqrt(currentBucketFlow)`. `sqrt` keeps a wide dynamic range legible. |
| `widthMinPixels` | `number` | `1` | Minimum width for **active** arcs (zero-flow arcs stay at width 0). |
| `widthMaxPixels` | `number` | `12` | Maximum arc width in pixels. |
| `sourceColor` | `Color` | `[56,196,232,235]` | Origin endpoint color (the arc interpolates source→target). |
| `targetColor` | `Color` | `[255,142,64,245]` | Destination endpoint color. |
| `greatCircle` | `boolean` | `false` | Draw arcs along the great-circle path. |
| `arcHeight` | `number` | `0.5` | Arc height multiplier (`0` = flat). |

### Node circles

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `nodeRadiusScale` | `number` | `1.3` | Node circle radius in pixels per `sqrt(incidentFlow)` (inbound + outbound current-bucket volume). |
| `nodeRadiusMinPixels` | `number` | `1.5` | Minimum node radius in pixels. |
| `nodeRadiusMaxPixels` | `number` | `28` | Maximum node radius in pixels. |
| `nodeColor` | `Color` | `[232,238,255,170]` | Node circle fill color. |
| `nodeLineColor` | `Color` | `[255,255,255,220]` | Node circle stroke color. |

### General

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `minFlow` | `number` | `0.25` | Hide arcs and nodes whose current flow is below this many trips (squelches sub-bucket blend noise). |

## Sublayers

`renderLayers()` returns one `ArcLayer` per tile plus a single `ScatterplotLayer` node overlay aggregated across all visible tiles. Override either via `_subLayerProps`:

- **`arcs`** — the per-tile arc sublayer.
- **`nodes`** — the node-circle overlay.

## Data shape

Each feature is a 2-vertex `origin → destination` LineString whose `vertexValueMatrix` holds `[2 × numBuckets]` per-bucket trip counts (both vertices carry the pair's count). The feature's `[timestamp, end_timestamp]` spans the **whole** time range, so every corridor is always geometrically present and the matrix alone drives the animation. Produce it with:

```bash
stt-generate bixi --input DonneesOuvertes2024.csv \
  --from 2024-08-01 --to 2024-09-01 --bin 1h --min-trips 30 \
  --output bixi-flowmap.stt
```

A volume-based per-feature `min_zoom` (assigned by the generator) acts as a legibility LOD: the busiest corridors render city-wide while minor pairs reveal on zoom-in — this is *not* temporal thinning, every bucket is kept for kept corridors.

## See also

- [`AnimatedArcLayer`](./animated-arc-layer.md) — per-trip OD arcs (window-mode, no aggregation).
- [`QuadbinSummaryLayer`](./quadbin-summary-layer.md) / [`H3SummaryLayer`](./h3-summary-layer.md) — other summary tiers.
- [Binary features](./binary-features.md) — the `vertexValueMatrix` encoding.
