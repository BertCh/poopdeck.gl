# H3SummaryLayer

The `H3SummaryLayer` renders the **server-aggregated summary tier** of an STT archive as H3 hexagons. The summary tier (built with `stt-build --summary-tier h3`) collapses 100M+ raw features into one row per H3 cell — `count` plus per-column aggregates — stored as Arrow tiles indexed by `(zoom, x, y, time-bucket)` just like the raw tier. At low zooms this is the only way to render a planet-scale point dataset in real time.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and reuses ALL of its archive/tileset plumbing (init + supersession race guards, rAF-coalesced tile-load updates, throttled animation ticks, byte-budgeted cache, callbacks, `loadOptions`); the summary-tier specifics ride the base's subclass hooks. Each cell renders through deck.gl's `H3HexagonLayer` (`@deck.gl/geo-layers`), so high-precision polygon rendering, GPU picking, and the standard extruded/coverage style props come for free.

## Installation

```typescript
import { H3SummaryLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { H3SummaryLayer } from '@poopdeck.gl/layers';

const layer = new H3SummaryLayer({
  id: 'ship-density',
  data: '/data/ais/manifest.json',
  currentTime,
  timeWindow: 24 * 3600 * 1000,
  weightProperty: 'count',
  colorDomain: [1, 5000],    // pin the legend (recommended)
  extruded: true,
  elevationScale: 50,
});
```

Pair it with a raw-tier layer for a zoom-dependent stack, or simply use any animated layer with `tier: 'auto'` (the base default) — the tileset dispatches to the summary tier automatically inside its zoom band.

## Summary tile shape

Each summary tile carries, per cell:

- `id` — the H3 cell index as a u64 (Arrow UInt64 `id` column, surfaced on `BinaryFeatures.featureIds64`; resolutions ≥ 7 don't fit in 32 bits).
- `count` — feature count for that cell.
- `<agg>_<col>` — one numeric column per aggregated attribute (`mean_magnitude`, `sum_value`, …).

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md). One base default changes: `maxCacheSize` is **500** (summary tiles are few but row-heavy).

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `weightProperty` | `string` | `'count'` | Numeric property the color ramp + extrusion height are driven by. Any aggregated column is valid. |
| `colorRange` | `Color[]` | 6-stop YlGnBu | Low→high color ramp; `weightProperty` is quantised into its buckets. |
| `colorDomain` | `[number, number] \| null` | `null` | `[min, max]` for the ramp. Setting this pins the legend stable across tiles and zooms (recommended). When unset, the min/max across visible tiles drives the ramp — visually unstable while tiles stream in. |
| `extruded` | `boolean` | `false` | 3D extrusion. |
| `elevationScale` | `number` | `1` | Meters per weight unit (only when `extruded`). |
| `coverage` | `number` | `0.92` | Hex coverage of its cell (0..1). Lower values leave gaps between adjacent hexes. |
| `onMetadataLoad` | `(meta: ArchiveMetadata) => void` | `null` | Fired once per archive init with the decoded metadata. |

There is no custom color-callback prop — restyle via `colorRange` / `colorDomain` / `weightProperty`.

## Behavior notes

- **Zoom band**: the layer clamps tile zoom to the summary tier's
  `[minZoom, maxZoom]` (not the raw tier's) and uses `'no-overlap'`
  refinement — a parent SUMMARY tile under a finer view would double-draw
  aggregated cells.
- **No tier, no render**: archives without a summary tier render nothing;
  the layer warns once ("rebuild with `stt-build --summary-tier h3`").
- **Picking**: hits arrive with `info.object` swapped for the cell's FULL
  aggregated columns plus `hex` and `weight` keys; `info.tile` carries the
  source tile.
- **Caching**: per-tile prepared rows and per-tile `H3HexagonLayer`
  instances are cached and invalidated by a content-keyed style digest
  (extrusion, coverage, domain, ramp content, inherited composite props,
  `updateTriggers`), so streaming tiles or restyles never rebuild more than
  necessary.

The sublayer short id for `_subLayerProps` overrides is **`hexagons`**: `_subLayerProps: { hexagons: { type: MyLayer, ... } }`.

## Source

[packages/layers/src/h3-summary-layer.ts](../../packages/layers/src/h3-summary-layer.ts)
