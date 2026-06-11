# AnimatedLineLayer

The `AnimatedLineLayer` is the **flat** sibling of [`AnimatedArcLayer`](./animated-arc-layer.md): it draws origin→destination flows as straight line segments rather than bowed arcs, through deck.gl's `LineLayer` (`@deck.gl/layers`). Each tile feature is a 2-vertex LineString — first vertex = source, last = target — and the two layers share the same `deriveSourceTargetPositions` endpoint helper.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and uses window-mode time filtering via the shared [`TimeFilterExtension`](./time-filter-extension.md). Use it when arcs add unwanted visual height (dense local flows, top-down views) and a flat segment reads cleaner.

## Installation

```typescript
import { AnimatedLineLayer } from '@stt/deck.gl';
```

## Usage

```typescript
const layer = new AnimatedLineLayer({
  id: 'od-lines',
  data: '/data/nyc-od-arcs/manifest.json',
  currentTime,
  timeWindow: 30 * 60 * 1000,
  color: [120, 200, 255, 200],
  width: 1.5,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `color` / `getColor` | `Color \| string` | `[0,150,255,255]` | Segment color: constant RGBA or a categorical property-column name. |
| `width` / `getWidth` | `number \| string` | `2` | Segment width — constant or per-feature numeric column. |
| `widthUnits` | `'pixels' \| 'meters' \| 'common'` | `'pixels'` | Width units. |
| `widthScale` / `widthMinPixels` / `widthMaxPixels` | `number` | — | Width scaling + pixel clamps. |
| `colorPalette` | `Color[]` | 10-stop | Palette for a categorical `color` column. |
| `fadeInDuration` / `fadeOutDuration` | `number` | `300` | Window fade ramps (ms). |

## Behavior notes

- Shares endpoint derivation, caching, and picking with `AnimatedArcLayer`; only the rendered geometry differs.
- The sublayer short id for `_subLayerProps` overrides is **`lines`**.

## Source

[packages/deck.gl/src/animated-line-layer.ts](../../packages/deck.gl/src/animated-line-layer.ts)
