# FlowLinesLayer

The `FlowLinesLayer` is a **tapered half-arrow** primitive — a port of [flowmap.gl](https://github.com/visgl/flowmap.gl)'s `FlowLinesLayer` adapted to STT's binary-tile pipeline. One instance is one origin→destination flow: a straight shaft that tapers from the origin into a **triangular arrowhead** at the destination, with width proportional to the flow magnitude.

It is the geometry that [`FlowmapLayer`](./flowmap-layer.md) renders instead of arcs. Use it directly if you have your own source/target data and want the arrow look.

## How it draws

Each instance is a fixed **9-vertex template mesh** (3 triangles) extruded in the vertex shader, entirely in screen pixels (like deck.gl's own `LineLayer`):

- the vertex is placed at `mix(source, target)` on the centerline, then offset **perpendicular** by `template.perp · width` (shaft / arrowhead half-width) and **along-travel** by `template.travel · width` (the arrowhead pull-back);
- a constant `gap · width` perpendicular offset pushes the whole arrow to one side of the centerline, so the **A→B and B→A flows of a pair sit side-by-side** (the perpendicular direction flips with the flow direction);
- per-instance `getEndpointOffsets` (`[sourceInset, targetInset]`, pixels) inset the start/end **along** the line so the arrow begins/ends at the node-circle **edge**, not its center;
- the along-travel and endpoint offsets are clamped to a fraction of the flow's pixel length so short flows don't self-overlap or overshoot.

Color is a layer-uniform `mix(sourceColor → targetColor)` along the arrow (origin tail → arrowhead).

Unlike flowmap.gl (which feeds a normalized `instanceThickness∈[0,0.5]` × `thicknessUnit`), this layer takes **width directly in pixels** per instance via `getWidth` — so a host that already computes a pixel width (e.g. `FlowmapLayer`'s `widthScale·√flow`) just feeds it through.

## Installation

```typescript
import { FlowLinesLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new FlowLinesLayer({
  id: 'flows',
  data: flows,
  getSourcePosition: (d) => d.from,   // [lng, lat]
  getTargetPosition: (d) => d.to,
  getWidth: (d) => Math.sqrt(d.count), // pixels
  getEndpointOffsets: (d) => [d.fromRadius, d.toRadius], // pixels
  sourceColor: [56, 196, 232, 235],
  targetColor: [255, 142, 64, 245],
  gap: 0.5,
  widthMinPixels: 1,
  widthMaxPixels: 12,
});
```

Binary input (one instanced buffer per attribute) is also supported via deck.gl's `data: { length, attributes }` form, keyed by accessor name (`getSourcePosition`, `getTargetPosition`, `getWidth`, `getEndpointOffsets`) — this is how `FlowmapLayer` feeds it zero-copy from a tile.

## Properties

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `getSourcePosition` | `Accessor<Position>` | `d.sourcePosition` | Origin position. |
| `getTargetPosition` | `Accessor<Position>` | `d.targetPosition` | Destination position. |
| `getWidth` | `Accessor<number>` | `1` | Per-flow width in **pixels** (already scaled, not normalized). |
| `getEndpointOffsets` | `Accessor<[number, number]>` | `[0, 0]` | `[sourceInset, targetInset]` in pixels — pulls the ends in so the arrow meets the node-circle edge. |
| `sourceColor` | `Color` | `[0,150,255,255]` | Origin / tail color. |
| `targetColor` | `Color` | `[255,127,14,255]` | Destination / arrowhead color. |
| `gap` | `number` | `0.5` | Perpendicular separation of the two directions, in units of the arrow width. |
| `widthMinPixels` | `number` | `0` | Clamp width to at least this many pixels. |
| `widthMaxPixels` | `number` | `Number.MAX_SAFE_INTEGER` | Clamp width to at most this many pixels. |

## See also

- [`FlowmapLayer`](./flowmap-layer.md) — animated OD flowmap that renders this primitive from `vertexValueMatrix` tiles.
- [`AnimatedArcLayer`](./animated-arc-layer.md) — raised-arc OD rendering (the non-arrow alternative).
