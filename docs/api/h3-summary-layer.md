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
  colorDomain: [1, 5000], // pin the legend (recommended)
  extruded: true,
  elevationScale: 50,
});
```

Pair it with a raw-tier layer for a zoom-dependent stack, or simply use any animated layer with `tier: 'auto'` (the base default) — the tileset dispatches to the summary tier automatically inside its zoom band.

## Summary tile shape

Each summary tile carries, per cell:

- `id` — the H3 cell index as a u64 (Arrow UInt64 `id` column, surfaced on [`BinaryFeatures.featureIds64`](./binary-features.md#feature-identity-read-featureids64-not-featureids)). ⚠️ At **resolution ≥ 7 the index does not fit in 32 bits**, so the sibling `featureIds` field — a masked low half — collides between distinct cells and must not be used here.
- `count` — feature count for that cell.
- `<agg>_<col>` — one numeric column per aggregated attribute (`mean_magnitude`, `sum_value`, …).

## Time inside a tile (sub-buckets)

A summary tile is one **outer** temporal bucket, so residency alone gives a map that jumps at bucket boundaries and does nothing while the playhead scrubs _inside_ one. `stt-build --summary-tier h3 --summary-sub-buckets N` bakes `bucket_0..bucket_<N-1>` count columns per cell, and the tier declares N as `summaryTier.subBuckets`. **N is not clamped** — the builder only floors it at 1 — but each sub-bucket is another numeric column on every cell (~6 bytes per cell), so the practical ceiling is around 32 before deep-zoom tiles stop being tractable; 12–30 is the useful range for hour-bucketed archives (one column per 2–5 minutes).

When N > 1 the layer selects the column the playhead is inside — `floor((t − tile.id.t) / (temporalBucketMs / N))`, the exact inverse of the builder's binning — drives the ramp from it, and hides cells with no activity in that slice. It re-renders on every sub-bucket **crossing** (not per tick), so an N-sub-bucket archive re-renders N times per outer bucket. A non-`count` `weightProperty` keeps its own bucket-wide aggregate — no per-sub-bucket aggregates are baked for it — but its cells are still shown/hidden by the active sub-bucket's activity.

With N = 1 (the default) there is no baked intra-bucket signal: the playhead changes nothing inside a tile, and the layer costs nothing extra. `--summary-sub-buckets` is how an archive opts into intra-bucket animation.

Each cell also carries its own `[startTimes, endTimes]` — the min/max feature time observed in that cell within the bucket. Those are deliberately **not** used to gate rendering (it would make the visible row set a function of the continuous playhead, rebuilding every visible tile's prepared rows on every tick); they reach the app through picking as `start_time` / `end_time`.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md). One base default changes: `maxCacheSize` is **500** (summary tiles are few but row-heavy).

| Property         | Type                              | Default       | Description                                                                                                                                                                                                                                                            |
| :--------------- | :-------------------------------- | :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weightProperty` | `string`                          | `'count'`     | Numeric property the color ramp + extrusion height are driven by. Any aggregated column is valid. On a sub-bucketed archive the default `'count'` is replaced per frame by the active `bucket_<k>` column — see [Time inside a tile](#time-inside-a-tile-sub-buckets). |
| `colorRange`     | `Color[]`                         | 6-stop YlGnBu | Low→high color ramp; `weightProperty` is quantised into its buckets.                                                                                                                                                                                                   |
| `colorDomain`    | `[number, number] \| null`        | `null`        | `[min, max]` for the ramp. Setting this pins the legend stable across tiles and zooms (recommended). When unset, the min/max across visible tiles drives the ramp — visually unstable while tiles stream in.                                                           |
| `extruded`       | `boolean`                         | `false`       | 3D extrusion.                                                                                                                                                                                                                                                          |
| `elevationScale` | `number`                          | `1`           | Meters per weight unit (only when `extruded`).                                                                                                                                                                                                                         |
| `coverage`       | `number`                          | `0.92`        | Hex coverage of its cell (0..1). Lower values leave gaps between adjacent hexes.                                                                                                                                                                                       |
| `onMetadataLoad` | `(meta: ArchiveMetadata) => void` | `null`        | Fired once per archive init with the decoded metadata.                                                                                                                                                                                                                 |

There is no custom color-callback prop — restyle via `colorRange` / `colorDomain` / `weightProperty`.

### Stroke & material

Pass-throughs to deck.gl's `H3HexagonLayer` (which forwards them to its internal `PolygonLayer` / `ColumnLayer`). They surface the previously-implicit hex outline — a black 1px border you could neither recolor nor disable — plus the extrusion lighting material and precision toggle. `getLineColor` / `getLineWidth` are upstream-vocabulary aliases: unlike upstream deck.gl they accept a **constant** value only (the summary outline is one style for the whole grid — a function accessor or column-name string warns once and falls back to `lineColor` / `lineWidth`); when set to a constant they win over the legacy prop. Like the fill, outlines double-draw along tile seams.

| Property             | Type                  | Default                   | Description                                                                                                                                                                                                                                                                                                                                                                    |
| :------------------- | :-------------------- | :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroked`            | `boolean`             | `true`                    | Draw the per-hex outline stroke (the hex-grid look).                                                                                                                                                                                                                                                                                                                           |
| `filled`             | `boolean`             | `true`                    | Fill each hex. Set `false` (with `stroked: true`) for an outline-only hex grid.                                                                                                                                                                                                                                                                                                |
| `wireframe`          | `boolean`             | `false`                   | Draw the extruded-prism edges as a wireframe. Only visible when `extruded: true`.                                                                                                                                                                                                                                                                                              |
| `lineColor`          | `Color`               | `[0, 0, 0, 255]`          | Outline color (constant).                                                                                                                                                                                                                                                                                                                                                      |
| `getLineColor`       | `Color \| null`       | `null`                    | Upstream-vocabulary alias of `lineColor` (constant `Color` only). Wins over `lineColor` when set.                                                                                                                                                                                                                                                                              |
| `lineWidth`          | `number`              | `1`                       | Outline width, in `lineWidthUnits`, clamped by `lineWidthMinPixels`/`lineWidthMaxPixels`. Only drawn when `stroked`.                                                                                                                                                                                                                                                           |
| `getLineWidth`       | `number \| null`      | `null`                    | Upstream-vocabulary alias of `lineWidth` (constant number only). Wins over `lineWidth` when set.                                                                                                                                                                                                                                                                               |
| `lineWidthUnits`     | `Unit`                | `'meters'`                | Units for `lineWidth`.                                                                                                                                                                                                                                                                                                                                                         |
| `lineWidthScale`     | `number`              | `1`                       | Outline width multiplier.                                                                                                                                                                                                                                                                                                                                                      |
| `lineWidthMinPixels` | `number`              | `0`                       | Minimum on-screen outline width in pixels — the practical lever that keeps hex-grid borders visible at summary zooms (meters-based widths collapse below a pixel when zoomed out).                                                                                                                                                                                             |
| `lineWidthMaxPixels` | `number`              | `Number.MAX_SAFE_INTEGER` | Maximum on-screen outline width in pixels.                                                                                                                                                                                                                                                                                                                                     |
| `material`           | `Material \| boolean` | `true`                    | Lighting material for extruded hexes. Applies only when `extruded`; `true` uses the default lit material.                                                                                                                                                                                                                                                                      |
| `highPrecision`      | `boolean \| 'auto'`   | `'auto'`                  | High-precision hexagon rendering. `'auto'` picks per-cell fidelity (irregular low-res cells + pentagons render hi-fi); `true`/`false` force it.                                                                                                                                                                                                                                |
| `centerHexagon`      | `string \| null`      | `null`                    | Hexagon whose projected shape is reused for every instanced column on the `highPrecision: false` path (`H3HexagonLayer` pass-through). Defaults to the cell nearest the viewport centre; pin it when the set has a stable centre of mass and you want the geometry to stop being re-derived as the camera moves. Ignored on the hi-fi path, which uses real per-cell polygons. |

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

[packages/layers/src/layers/summary/h3-summary-layer.ts](../../packages/layers/src/layers/summary/h3-summary-layer.ts)
