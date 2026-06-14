# QuadbinSummaryLayer

The `QuadbinSummaryLayer` renders the **server-aggregated summary tier** of an STT archive as **CARTO Quadbin** square cells — the Z/X/Y square-grid counterpart of [`H3SummaryLayer`](./h3-summary-layer.md). The summary tier (built with `stt-build --summary-tier quadbin`) collapses raw features into one row per Quadbin cell — `count` plus per-column aggregates — indexed by `(zoom, x, y, time-bucket)` just like the raw tier. At low zooms it renders a dense point dataset as a few thousand cells instead of millions of features.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and reuses all of its archive/tileset plumbing, clamping to the summary tier's zoom band. Each cell renders through deck.gl's `QuadkeyLayer` (`@deck.gl/geo-layers`): the layer reads the cell id from `BinaryFeatures.featureIds64`, decodes the CARTO Quadbin u64 to a Bing quadkey string, and hands it to `getQuadkey`. Summary cells are pre-aggregated per time bucket at build time, so — like `H3SummaryLayer` — no per-feature `TimeFilterExtension` is attached.

## Installation

```typescript
import { QuadbinSummaryLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new QuadbinSummaryLayer({
  id: 'trip-density',
  data: '/data/nyc-od-quadbin/manifest.json',
  currentTime,
  timeWindow: 3600 * 1000,
  weightProperty: 'count',
  colorDomain: [1, 60],   // pin the legend (recommended)
  extruded: true,
  elevationScale: 120,
});
```

## Cell encoding

The Quadbin cell id is a **CARTO Quadbin u64** (header `0b100`, mode bit, 5-bit zoom at bits 56–52, 52-bit left-aligned Morton x/y). The Rust aggregator (`stt-build`) encodes it and the TS [`quadbin-cell`](../../packages/layers/src/quadbin-cell.ts) helper decodes it to `(z, x, y)` → Bing quadkey string. The encode/decode are exact mirror-images, validated against CARTO's reference value `(0,0,0) → 0x480fffffffffffff`.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `weightProperty` | `string` | `'count'` | Numeric column the color ramp + extrusion height are driven by. |
| `colorRange` | `Color[]` | 6-stop | Low→high color ramp; `weightProperty` is quantised into its buckets. |
| `colorDomain` | `[number, number] \| null` | `null` | `[min, max]` for the ramp. Pin it for a stable legend across streaming tiles (recommended). |
| `extruded` | `boolean` | `false` | 3D extrusion. |
| `elevationScale` | `number` | `1` | Meters per weight unit (only when `extruded`). |
| `coverage` | `number` | `0.92` | Cell coverage (0..1); lower values leave gaps between cells. |
| `onMetadataLoad` | `(meta: ArchiveMetadata) => void` | `null` | Fired once per archive init with the decoded metadata. |

## Behavior notes

- **No tier, no render**: archives without a Quadbin summary tier render nothing; the layer warns once ("rebuild with `stt-build --summary-tier quadbin`").
- **Zoom band**: clamps tile zoom to the summary tier's `[minZoom, maxZoom]` with `'no-overlap'` refinement, identical to `H3SummaryLayer`.
- deck.gl 9.x ships no Quadbin-native layer, so `QuadkeyLayer` + the u64→quadkey decode is the path; a future deck/`@deck.gl/carto` upgrade could swap it without touching the renderer.
- The sublayer short id for `_subLayerProps` overrides is **`quadbins`**.

## Source

[packages/layers/src/quadbin-summary-layer.ts](../../packages/layers/src/quadbin-summary-layer.ts) · cell helper: [quadbin-cell.ts](../../packages/layers/src/quadbin-cell.ts)
