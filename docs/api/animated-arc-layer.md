# AnimatedArcLayer

The `AnimatedArcLayer` renders **origin→destination flows** as bowed arcs, animated by the time window. Each tile feature is a **2-vertex LineString** — the layer reads the FIRST vertex as the arc's source and the LAST as its target, derives instanced `getSourcePosition`/`getTargetPosition` buffers once per tile, and draws through deck.gl's `ArcLayer` (`@deck.gl/layers`). No special "arc" tile type is needed: any LineString archive whose features collapse to endpoints works, but the natural producer is `stt-generate nyc-rideshare --od`, which emits straight pickup→dropoff lines (no routing).

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and reuses all of its archive/tileset plumbing. Time filtering is window-mode via the shared [`TimeFilterExtension`](./time-filter-extension.md): an arc is shown (with optional fade) while its `[startTime, endTime]` overlaps the current window — for taxi data, the pickup→dropoff interval.

## Installation

```typescript
import { AnimatedArcLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedArcLayer({
  id: 'od-arcs',
  data: '/data/nyc-od-arcs/manifest.json',
  currentTime,
  timeWindow: 30 * 60 * 1000, // 30-min slice
  sourceColor: [56, 196, 232, 210], // origin — cyan
  targetColor: [255, 142, 64, 220], // destination — orange
  width: 1.5,
  arcHeight: 0.4,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property                                           | Type                               | Default            | Description                                                                                                                                                                                                                                               |
| :------------------------------------------------- | :--------------------------------- | :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceColor`                                      | `Color \| string`                  | `[0,150,255,255]`  | Origin-end color: a constant RGBA **or** a categorical property-column name (GPU `CategoryColorExtension`).                                                                                                                                               |
| `targetColor`                                      | `Color \| string`                  | `[255,127,14,255]` | Destination-end color; the arc interpolates source→target.                                                                                                                                                                                                |
| `getSourceColor` / `getTargetColor`                | `Color \| string`                  | —                  | Upstream-vocabulary aliases (constant or column name; a function warns once and falls back).                                                                                                                                                              |
| `width` / `getWidth`                               | `number \| string`                 | `2`                | Arc width — constant or per-feature numeric column.                                                                                                                                                                                                       |
| `widthUnits`                                       | `'pixels' \| 'meters' \| 'common'` | `'pixels'`         | Width units.                                                                                                                                                                                                                                              |
| `widthScale` / `widthMinPixels` / `widthMaxPixels` | `number`                           | —                  | Width scaling + pixel clamps (`ArcLayer` pass-through).                                                                                                                                                                                                   |
| `greatCircle`                                      | `boolean`                          | `false`            | Bow arcs along a great-circle path (long-haul / globe flows).                                                                                                                                                                                             |
| `numSegments`                                      | `number`                           | `50`               | Arc tessellation segment count — higher is smoother, lower is cheaper (`ArcLayer` pass-through).                                                                                                                                                          |
| `arcHeight` / `getHeight`                          | `number \| string`                 | `1`                | Arc height multiplier; `0` = flat. Constant **or** a per-feature numeric column name — upstream registers `instanceHeights` as an ordinary per-instance accessor, so a baked column rides it zero-copy exactly like `width`.                              |
| `arcTilt` / `getTilt`                              | `number \| string`                 | `0`                | Sideways tilt (degrees) to separate arcs sharing endpoints. Constant **or** a per-feature numeric column name (`instanceTilts` is likewise a per-instance accessor upstream) — a column is what actually separates overlapping flows on the same OD pair. |
| `colorPalette`                                     | `Color[]`                          | 10-stop            | Palette for a categorical `sourceColor`/`targetColor` column.                                                                                                                                                                                             |
| `fadeInDuration` / `fadeOutDuration`               | `number`                           | `300`              | Window fade ramps (ms).                                                                                                                                                                                                                                   |

> **Single-channel categorical color:** because `CategoryColorExtension` injects one category index, a categorical column colors the WHOLE arc one color (source wins if both name a column), not independent source/target categories.

## Behavior notes

- **LineString tiles only**: the layer checks each tile layer's `geometryType` and skips any layer that is not `LineString`, emitting one named console warning rather than misreading a point/polygon buffer. Tiles predating the geometry-kind tag are trusted, with a structural `startIndices` backstop behind them.
- **Source/target derivation**: `deriveSourceTargetPositions` walks each feature's `startIndices`, copying the first vertex → dense `source` and the last → dense `target` (both `featureCount × dims`). Multi-vertex polylines collapse to their endpoints.
- **Accessor aliases**: `getHeight`/`getTilt` (and `getWidth`, `getSourceColor`, `getTargetColor`) take a constant or a property-column NAME, never a function accessor — a function warns once and falls back to the legacy prop.
- **Picking**: hits carry the feature's decoded properties on `info.object` and the source tile on `info.tile`.

The sublayer short id for `_subLayerProps` overrides is **`arcs`**.

## Source

[packages/layers/src/layers/core/animated-arc-layer.ts](../../packages/layers/src/layers/core/animated-arc-layer.ts) · shared endpoint helper: [od-positions.ts](../../packages/layers/src/lib/od-positions.ts)
