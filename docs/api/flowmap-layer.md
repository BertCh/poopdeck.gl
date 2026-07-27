# FlowmapLayer

The `FlowmapLayer` renders a **flowmap.gl-style animated origin→destination flowmap**: one weighted **tapered arrow** per OD pair whose **width tracks trip volume at the playhead**, plus **node circles sized by each location's incident flow**. As the time slider scrubs, corridors swell and recede with demand and the node circles pulse — the classic flowmap-over-time look.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and fuses two STT mechanisms with a flowmap.gl-faithful arrow primitive, so it needs **no special tile type**:

- **Tapered arrows** — each tile feature is a **2-vertex LineString**; the layer derives instanced `getSourcePosition`/`getTargetPosition` from the first/last vertex and draws them through [`FlowLinesLayer`](./flow-lines-layer.md), a port of flowmap.gl's `FlowLinesLayer`. Each flow is a straight shaft that tapers into a triangular arrowhead at the destination; the two directions of a pair are offset side-by-side, and the ends are inset to the node-circle edges.
- **Animate-from-a-matrix** — like [`FlowCorridorLayer`](./flow-corridor-layer.md), each feature carries a **`[2 × numBuckets]` per-bucket count matrix** ([`vertexValueMatrix`](./binary-features.md)). The layer reads the active bucket (linearly blended across a sub-step) as the per-flow value → arrow width, and sums that flow at each endpoint → node radius. Geometry stays resident; only the width buffer re-expands when the playhead crosses a sub-step (~5 Hz), so the tile **loads once and never re-fetches**. An archive built without the matrix falls back to a per-feature magnitude column and renders a **static** flowmap — see [`flowProperty`](#static-archives-without-a-bucket-matrix).

There is no time-window filter — an arrow with ~0 current flow simply gets width 0 (invisible), which **is** the animation.

The natural producer is `stt-generate bixi`, which aggregates real [BIXI Montréal open data](https://bixi.com/en/open-data/) trips into directed OD-pair corridors carrying an hourly `vertexValueMatrix`. By default it **clusters stations into hubs per zoom** (flowmap.gl-style), so coarse zooms show a few fat hub-to-hub corridors and full per-station resolution returns as you zoom in — the layer is agnostic to this and just renders whatever corridors a tile holds.

## Installation

```typescript
import { FlowmapLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new FlowmapLayer({
  id: 'bixi-flowmap',
  data: '/data/bixi-flowmap/manifest.json',
  currentTime, // driven live from the TimeController
  timeController,
  widthScale: 1.1, // arrow px per sqrt(current-bucket trips)
  widthMaxPixels: 14,
  sourceColor: [56, 196, 232, 235], // origin (tail) — cyan
  targetColor: [255, 142, 64, 245], // destination (arrowhead) — warm orange
  gap: 0.5, // side-by-side separation of A→B and B→A
  nodeRadiusScale: 1.3, // node px per sqrt(incident flow)
  minFlow: 0.5, // hide corridors below ~1 trip this bucket
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Flow arrows

| Prop             | Type     | Default            | Description                                                                                                                   |
| ---------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `widthScale`     | `number` | `1.1`              | Arrow width in pixels per `sqrt(currentBucketFlow)`. `sqrt` keeps a wide dynamic range legible.                               |
| `widthMinPixels` | `number` | `1`                | Minimum width for **active** arrows (zero-flow arrows stay at width 0).                                                       |
| `widthMaxPixels` | `number` | `12`               | Maximum arrow width in pixels.                                                                                                |
| `sourceColor`    | `Color`  | `[56,196,232,235]` | Origin / tail color (the arrow interpolates source→target along its length).                                                  |
| `targetColor`    | `Color`  | `[255,142,64,245]` | Destination / arrowhead color.                                                                                                |
| `gap`            | `number` | `0.5`              | Perpendicular separation between the two directions of a pair, in units of the arrow width — so A→B and B→A sit side-by-side. |

### Node circles

| Prop                  | Type                   | Default             | Description                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodeRadiusScale`     | `number`               | `1.3`               | Node circle radius in pixels per `sqrt(incidentFlow)` (inbound + outbound current-bucket volume). Also drives the arrow endpoint insets.                                                                                                                                                                                                                                                                  |
| `nodeRadiusUnits`     | `'meters' \| 'pixels'` | `'pixels'`          | Units for the node-circle radius. `'pixels'` keeps a constant on-screen size at every zoom; `'meters'` scales circles with the map so a dense overview shrinks them instead of blowing out into overlapping blobs (still clamped by `nodeRadiusMinPixels`/`nodeRadiusMaxPixels`). With `'meters'`, `nodeRadiusScale` is a metres-per-`sqrt(flow)` factor, so it needs a much larger value than in pixels. |
| `nodeRadiusMinPixels` | `number`               | `1.5`               | Minimum node radius in pixels.                                                                                                                                                                                                                                                                                                                                                                            |
| `nodeRadiusMaxPixels` | `number`               | `28`                | Maximum node radius in pixels.                                                                                                                                                                                                                                                                                                                                                                            |
| `nodeColor`           | `Color`                | `[232,238,255,170]` | Node circle fill color.                                                                                                                                                                                                                                                                                                                                                                                   |
| `nodeLineColor`       | `Color`                | `[255,255,255,220]` | Node circle stroke color.                                                                                                                                                                                                                                                                                                                                                                                 |

### General

| Prop           | Type             | Default | Description                                                                                                                                                                                 |
| -------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minFlow`      | `number`         | `0.25`  | Hide arrows and nodes whose current flow is below this many trips (squelches sub-bucket blend noise).                                                                                       |
| `flowProperty` | `string \| null` | `null`  | Per-feature numeric column carrying the flow magnitude, for archives built **without** the per-bucket `vertexValueMatrix`. See [Static archives](#static-archives-without-a-bucket-matrix). |

### Static archives (without a bucket matrix)

The per-bucket `vertexValueMatrix` is the animated source of truth, and
`flowProperty` is **ignored** whenever a tile carries one. An archive built
without the matrix used to render every corridor at width 0 — a blank map
indistinguishable from a load failure. It now falls back to a per-feature
magnitude column and renders a **static** flowmap (every corridor keeps one
constant width):

- `flowProperty` unset (the default) auto-detects the first column present out
  of `flow`, `count`, `volume`, `trips`, `value`, `weight`.
- Setting `flowProperty` overrides the probe entirely.
- With neither a matrix nor a usable magnitude column, the layer warns once,
  naming the candidate columns, and every corridor renders at width 0.

## Sublayers

`renderLayers()` runs in three passes — pass 1 resolves per-tile geometry, pass 2 decodes widths and accumulates per-node incident flow across all visible tiles, pass 3 builds the arrows feeding each one its endpoints' node radii — and returns one [`FlowLinesLayer`](./flow-lines-layer.md) per tile plus a single `ScatterplotLayer` node overlay. Station identity (the coordinate interning) is hoisted out of the per-sub-step path into a node table rebuilt only when the visible tile _set_ changes. Override either sublayer via `_subLayerProps`:

- **`flows`** — the per-tile arrow sublayer.
- **`nodes`** — the node-circle overlay.

### `extensions` are stripped

deck extensions cannot reach this family's shaders. [`FlowLinesLayer`](./flow-lines-layer.md)
is a custom-`Model` layer that declares no `DECKGL_FILTER_*` hooks, so deck would
merge the extension's module, allocate its attributes, and then drop every
injection — silently, because `disableWarnings` is inherited. This layer
therefore **strips a forwarded `extensions` list and warns once**, naming the
extensions it dropped, rather than passing along a list that looks live and
isn't.

## Data shape

Each feature is a 2-vertex `origin → destination` LineString whose `vertexValueMatrix` holds `[2 × numBuckets]` per-bucket trip counts (both vertices carry the pair's count). The feature's `[timestamp, end_timestamp]` spans the **whole** time range, so every corridor is always geometrically present and the matrix alone drives the animation. Produce it with:

```bash
stt-generate bixi --input DonneesOuvertes2024.csv \
  --from 2024-08-01 --to 2024-09-01 --bin 1h --min-trips 30 \
  --output bixi-flowmap.stt
```

By default the generator **clusters** stations per zoom and confines each zoom's hub-to-hub corridors to a single-zoom band (a per-feature `[min_zoom, max_zoom]`) so coarse aggregates never bleed into the full-resolution deep zooms. Tune the hub coarseness with `--cluster-radius <px>` (default `40`), or pass `--no-cluster` to emit one full-resolution corridor per OD pair with an open-ended, volume-based `min_zoom` (busy pairs appear at low zoom, minor pairs only reveal on zoom-in). Either way this is _not_ temporal thinning — every bucket is kept for every emitted corridor.

## See also

- [`FlowLinesLayer`](./flow-lines-layer.md) — the tapered-arrow primitive this layer renders.
- [`AnimatedArcLayer`](./animated-arc-layer.md) — per-trip OD arcs (window-mode, no aggregation).
- [`QuadbinSummaryLayer`](./quadbin-summary-layer.md) / [`H3SummaryLayer`](./h3-summary-layer.md) — other summary tiers.
- [Binary features](./binary-features.md) — the `vertexValueMatrix` encoding.

## Source

[packages/layers/src/layers/summary/flowmap-layer.ts](../../packages/layers/src/layers/summary/flowmap-layer.ts)
