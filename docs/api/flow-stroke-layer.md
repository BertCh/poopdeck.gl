# FlowStrokeLayer

The `FlowStrokeLayer` renders **coherent, merged, directed flow corridors whose per-path width breathes with traveller volume**. It extends [`FlowCorridorLayer`](./flow-corridor-layer.md) — the corridor geometry loads once and per-vertex color animates by selecting the active time bucket from a value matrix — and adds two things on top: a **width** that tapers along each corridor and pulses with the active hour's volume, and a constant perpendicular **offset** that draws opposing travel directions as twin side-by-side ribbons. It is the renderer behind the `bixi-corridors` demo, which reads a `bixi --merged-paths` archive (origin→destination trips merged onto shared trunk lines, Sankey-style).

## How it works

- **Width.** `widthsFor` overrides the base `undefined` (static-width) hook with a **per-vertex** buffer, aligned 1:1 with `positions` exactly like the gradient color buffer: each vertex's width is `(active-bucket blended value at that vertex) ** widthExponent`, or `0` when that value is at or under `minFlow`. Because the value comes from the same per-vertex bucket blend the parent uses for color, a trunk both **tapers** along its length (thick where tributaries join, thin where they leave) and **breathes** with the hour (rush-hour swell, overnight thin) in lockstep with its color. The buffer recomputes exactly when the inherited `gradientStyleSuffix` changes (the playhead crosses a sub-step) — the underlying geometry never re-uploads.
- **Twin-ribbon offset.** When `offsetWidths` is nonzero, `extraTripsExtensions` installs a stable `PathStyleExtension({ offset: true })` singleton and `extraTripsSubLayerProps` sets `getOffset` to `offsetWidths` (a constant, in multiples of the rendered width). Because an A→B corridor and its B→A counterpart are separate features traversing a shared street in opposite vertex order, the same constant offset lands them on opposite sides — exposing directional asymmetry (inbound vs. outbound rush) as two parallel ribbons instead of one overlapping line. `includeCategoryColorExtension` drops the (otherwise idle) category-color extension only while the offset extension is active, freeing a GPU attribute slot; with `offsetWidths: 0` the offset is disabled and the sublayer falls back to the base extension set unchanged.

## Installation

```typescript
import { FlowStrokeLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new FlowStrokeLayer({
  id: 'bixi-corridors',
  data: '/data/bixi-corridors/manifest.json',
  currentTime,
  gradientProperty: 'vertexValues', // per-vertex value-matrix gradient
  gradientDomain: [0, 90], // active single-hour travellers on a trunk
  gradientColorRamp: [
    [30, 50, 120, 180],
    [40, 150, 200, 215],
    [120, 210, 160, 235],
    [255, 170, 70, 248],
    [255, 255, 255, 255],
  ],
  widthExponent: 0.5, // √-scale: width is area-proportional to volume
  minFlow: 0, // corridors at/under this pulse to width 0
  offsetWidths: 0.6, // twin-ribbon separation, in multiples of width
  widthUnits: 'pixels',
  widthMinPixels: 1,
});
```

## Properties

Inherits all properties from [`FlowCorridorLayer`](./flow-corridor-layer.md) (and through it [`AnimatedTripsLayer`](./animated-trips-layer.md) and [`SpatioTemporalLayer`](./spatiotemporal-layer.md)), including `gradientProperty`/`gradientDomain`/`gradientColorRamp`, `tripWidth`/`widthUnits`/`widthScale`/`widthMinPixels`/`widthMaxPixels`, and the `signedFlow`/`chevronPerTripLight`/`persistenceMs`/chevron-window props — see [`FlowCorridorLayer`](./flow-corridor-layer.md) for the full inherited tables. It also inherits that layer's `trailLength: 0` pin; raising it blanks the network (the parent warns once).

`FlowStrokeLayer` adds:

| Property        | Type     | Default | Description                                                                                                                                                                                                                                                          |
| :-------------- | :------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `widthExponent` | `number` | `0.5`   | Exponent applied to each vertex's active-bucket blended value before `widthScale`/`widthMin`/`MaxPixels`: `width = value ** widthExponent`. `0.5` (√) is area-proportional, the cartographic default; lower flattens the busy/quiet contrast, higher exaggerates it. |
| `minFlow`       | `number` | `0`     | Vertices whose active-bucket value is at or under this render at width `0` (invisible) — the per-hour pulse.                                                                                                                                                         |
| `offsetWidths`  | `number` | `0.6`   | Constant perpendicular offset, in multiples of the rendered width, applied to every corridor to separate opposing-direction ribbons. `0` disables the offset (single centered line, base extension set).                                                             |

## Difference from FlowCorridorLayer

[`FlowCorridorLayer`](./flow-corridor-layer.md) animates **color only** over static, width-constant geometry. `FlowStrokeLayer` is built for **merged, bidirectional** corridor networks (e.g. `bixi --merged-paths`, where each origin→destination trip is folded onto a shared trunk): it keeps the same per-vertex time-bucket coloring but additionally animates **width** (tapering + breathing with volume) and separates opposing directions into **twin offset ribbons**, so a single rendered network reads as a directed, volume-weighted flow diagram rather than a flat-width overview.

## Source

[packages/layers/src/layers/trips/flow-stroke-layer.ts](../../packages/layers/src/layers/trips/flow-stroke-layer.ts)
