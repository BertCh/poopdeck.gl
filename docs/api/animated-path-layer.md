# AnimatedPathLayer

The `AnimatedPathLayer` renders time-series path/trajectory data as lines. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU-accelerated time filtering.

It operates in **window mode**: each feature is shown (with optional fade) whenever its `[startTime, endTime]` overlaps the current time window — whole paths render at once. For a "vehicle moving along the route" trailing effect, use [`AnimatedTripsLayer`](./animated-trips-layer.md) instead, which renders per-vertex with a fading trail.

## Installation

```typescript
import { AnimatedPathLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedPathLayer } from '@poopdeck.gl/layers';

const layer = new AnimatedPathLayer({
  id: 'ship-tracks',
  data: 'https://example.com/ships/manifest.json',
  currentTime: 1672531200000,
  timeWindow: 3600000, // 1 hour
  pathColor: [0, 150, 255, 255],
  pathWidth: 3,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property          | Type                               | Default            | Description                                                                                                                                                                                                                                                                                 |
| :---------------- | :--------------------------------- | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `widthScale`      | `number`                           | `1`                | Global multiplier for path widths.                                                                                                                                                                                                                                                          |
| `widthUnits`      | `'pixels' \| 'meters' \| 'common'` | `'pixels'`         | Units for width — the full upstream `Unit` domain. **Default drift**: upstream `PathLayer` defaults to `'meters'`; tile-sourced paths are map furniture (routes, lane lines, contours) whose on-screen weight should not collapse as you zoom out. Pass `'meters'` for ground-truth widths. |
| `widthMinPixels`  | `number`                           | `0`                | Clamp path width to at least this many on-screen pixels.                                                                                                                                                                                                                                    |
| `widthMaxPixels`  | `number`                           | `MAX_SAFE_INTEGER` | Clamp path width to at most this many on-screen pixels.                                                                                                                                                                                                                                     |
| `capRounded`      | `boolean`                          | `false`            | Rounded line caps. Rounded caps are the dominant fragment-shader cost at small widths and visually indistinguishable from flat below ~10 px.                                                                                                                                                |
| `jointRounded`    | `boolean`                          | `false`            | Rounded line joints; same fragment-cost tradeoff.                                                                                                                                                                                                                                           |
| `miterLimit`      | `number`                           | `4`                | Miter-joint length cap in multiples of line width (PathLayer pass-through; applies when `jointRounded` is `false`).                                                                                                                                                                         |
| `billboard`       | `boolean`                          | `false`            | Extrude lines in screen space so they always face the camera (PathLayer pass-through).                                                                                                                                                                                                      |
| `pathType`        | `'open' \| 'loop'`                 | `'open'`           | Path topology, forwarded to `PathLayer._pathType`. See [Closed rings (`pathType`)](#closed-rings-pathtype) before setting `'loop'`.                                                                                                                                                         |
| `fadeInDuration`  | `number`                           | `300`              | Duration (ms) for paths to fade in when their time range enters the window.                                                                                                                                                                                                                 |
| `fadeOutDuration` | `number`                           | `300`              | Duration (ms) for paths to fade out when their time range leaves the window.                                                                                                                                                                                                                |

### Data Accessors

| Property              | Type                            | Default                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| :-------------------- | :------------------------------ | :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pathColor`           | `Color \| string`               | `[0, 150, 255, 255]`   | Path color: constant RGBA, or a property name for categorical coloring. **Default drift**: upstream `PathLayer.getColor` defaults to opaque black, which is invisible on the dark basemaps these tiles are usually drawn over.                                                                                                                                                                                                                                                                                                                    |
| `getColor`            | `Color \| string \| null`       | `null`                 | Upstream-vocabulary (PathLayer) alias of `pathColor`. Accepts a constant or a property-column NAME — NOT a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back to `pathColor`). When set, it wins.                                                                                                                                                                                                                                                                                                     |
| `pathWidth`           | `number \| string`              | `3`                    | Path width: constant, or a numeric property name — also the fallback width for tiles that do not carry the named column. **Default drift**: upstream `PathLayer.getWidth` defaults to `1`, which in this layer's `'pixels'` units is a hairline that all but disappears on a HiDPI display.                                                                                                                                                                                                                                                       |
| `getWidth`            | `number \| string \| null`      | `null`                 | Upstream-vocabulary alias of `pathWidth` (same domain rules).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `colorPalette`        | `Color[]`                       | 10-color palette       | Palette for categorical `pathColor` (GPU lookup via `CategoryColorExtension`, up to 4096 entries).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `colorMapping`        | `Record<string, Color> \| null` | `null`                 | Explicit category-string → color map for categorical `pathColor`. Resolved per-tile against each tile's own category dictionary, so the same category (e.g. an HD-map `lane_divider` class) renders the same color in every tile — unlike `colorPalette`, whose indices are assigned per-tile in first-seen order. Takes precedence over `colorPalette` when set.                                                                                                                                                                                 |
| `colorMappingDefault` | `Color`                         | `[120, 120, 120, 255]` | Fallback color for categories absent from `colorMapping`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `filterProperty`      | `string \| null`                | `null`                 | Name of a baked NUMERIC column to GPU-filter paths by — wires the column into [`STTDataFilterExtension`](./data-filter-extension.md). A path renders when its value is inside `filterRange`, else it is hidden (or soft-faded via `filterSoftRange`); composes WITH the time filter (a path must pass both). Accessor-alias of deck's `getFilterValue`: pass a column NAME, not a function (a function warns once and is ignored). Unset ⇒ the extension is not installed (zero cost). A categorical column can't be range-filtered (warns once). |
| `filterRange`         | `[number, number] \| null`      | `null`                 | Inclusive `[min, max]` bounds for `filterProperty`. `null` idles the filter (renders all) while keeping the column bound, so a range set later animates by uniform with no re-preparation. No effect unless `filterProperty` is set.                                                                                                                                                                                                                                                                                                              |
| `filterSoftRange`     | `[number, number] \| null`      | `null`                 | Optional soft `[min, max]` inside `filterRange` for a fade instead of a hard clip. No effect unless `filterProperty` + `filterRange` are set.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `filterEnabled`       | `boolean`                       | `true`                 | Enable/disable the column filter without dropping the bound attribute. Effective only with `filterProperty` + a valid `filterRange`.                                                                                                                                                                                                                                                                                                                                                                                                              |

## Closed rings (`pathType`)

`'open'` (the default) draws a START_CAP at a feature's first vertex and an
END_CAP at its last. On CLOSED geometry — contour rings, lane loops, footprints
baked as LineStrings — that leaves a visible notch at the ring seam where a
mitred joint belongs. `pathType: 'loop'` closes the joint instead.

⚠️ **`'loop'` is not a drop-in for arbitrary tiles**, for two reasons:

1. **It is tile-WIDE, not per-feature.** STT tiles feed `PathLayer` binary data
   (`normalize: false`), and its tessellator then reads closedness from the
   `loop` flag alone rather than comparing each path's endpoints. Every feature
   in every tile is treated as closed — so only set it for datasets that are
   **all** rings.
2. **The buffer must already carry the +2 wrap vertices.** For a closed path the
   tessellator expects `numPoints + 2` vertices — the ring followed by a repeat
   of its first TWO vertices (`B0 B1 B2 B3 B0 B1`) — and it reads that padding
   out of the tile's own `positions`/`startIndices`; the binary path never
   synthesizes it. A ring baked in the usual first-vertex-repeated-last form
   does **not** satisfy this and renders a short, mis-capped final segment. The
   layer checks the tile's buffers for the padding and **warns once** when it is
   missing.

## Elevation (space-time relief)

A path layer is normally flat: every vertex rides the tile's ground-plane
`z`. Setting `elevationProperty` lifts each **feature** (the whole path, not
individual vertices) to a per-feature altitude, turning a set of flat rings —
most usefully nested density iso-contours — into a 3D terraced relief, the
classic stacked contour plot. Combined with `elevationOpacityRange`, the
upper terraces can also be graded translucent so a top-down camera sees
through the roof to the layers underneath instead of the topmost band
occluding everything below it.

| Property                | Type                             | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| :---------------------- | :------------------------------- | :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elevationProperty`     | `string \| null`                 | `null`  | Property column supplying each feature's elevation (metres). Resolution mirrors `pathColor`: a CATEGORICAL column resolves through `elevationMapping` (category string → metres); a NUMERIC column is used directly. Either way the result is multiplied by `elevationScale`. A whole path rides at one height — its own feature's value — so nested rings terrace into a hill instead of warping per-vertex. Unset (or a categorical column with no mapping) leaves the tile flat, with positions riding to the GPU zero-copy.                                                                                                                              |
| `elevationMapping`      | `Record<string, number> \| null` | `null`  | Category-string → elevation (metres) map for a CATEGORICAL `elevationProperty` — the height analogue of `colorMapping`. Categories absent from the map elevate to 0. No effect on a numeric column.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `elevationScale`        | `number`                         | `1`     | Multiplier applied to each `elevationProperty` value (after the categorical map, if any) before it becomes the path's z. No effect when `elevationProperty` is unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `elevationOpacityRange` | `[number, number] \| null`       | `null`  | Enables height-graded opacity: the color alpha of each path is scaled by a factor that ramps LINEARLY from `elevationOpacityNear` at the low end of this range to `elevationOpacityFar` at the high end (clamped outside the range). The ramp is keyed on the RAW `elevationProperty` value in metres — _before_ `elevationScale` — so the fade stays consistent across tiles regardless of each tile's own elevation spread. Only applies on the categorical color path (per-vertex `getColor`) and only when `elevationProperty` is a NUMERIC column; requires `elevationProperty` to be set. Unset means no grading — alpha is just the band color's own. |
| `elevationOpacityNear`  | `number`                         | `1`     | Alpha multiplier (0–1) at the LOW end of `elevationOpacityRange` — the ground layer of the stack.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `elevationOpacityFar`   | `number`                         | `1`     | Alpha multiplier (0–1) at the HIGH end of `elevationOpacityRange` — the top of the stack. Values below `1` fade the upper terraces translucent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Together, a density-band categorical color plus a numeric elevation column
produce a readable 3D iso-surface from a single dataset: `pathColor`/
`colorMapping` paint each ring by its density band, `elevationProperty`/
`elevationScale` stack the bands into a hill by that same (or a related)
band value, and `elevationOpacityRange` thins out the upper terraces so nothing
above ground level fully hides the terrain underneath it when viewed from
above.

## Architecture & performance

- **Geometry-kind guard**: tile layers whose `geometryType` is not
  `LineString` are skipped with one named console warning, rather than
  misreading the position buffer (a point tile's `featureCount` positions are
  not a vertex run). Tiles predating the geometry-kind tag are trusted.
- **Per-tile binary sublayers**: one `PathLayer` per (tile, layer) pair
  using the binary `data: { length, startIndices, attributes }` interface;
  typed arrays reference the tile's Arrow buffers zero-copy. New tiles are
  additive — one sublayer, one GPU upload. `positionFormat` is **not**
  forwarded: `PathLayer` derives the geometry stride from
  `data.attributes.getPath.size`, which this layer always sets, and only falls
  back to `positionFormat` when the descriptor carries no `size` — so passing
  it was inert and the prop has been removed.
- **Sublayer + prepared-data caches** with content-keyed style digests, so
  unchanged tiles short-circuit deck.gl's prop diff entirely.
- **Per-tile `timeOffset`** through a window-mode
  [`TimeFilterExtension`](./time-filter-extension.md); time updates flow
  via `getTime()` per draw (no layer recreation per frame).
- **Categorical color on the GPU** via
  [`CategoryColorExtension`](./category-color-extension.md) — category
  indices upload once as a float attribute; the palette is a shared 16 KB
  texture per device.
- **Picking and the attribute budget**: by default sublayers render through
  `NoPickingPathLayer`, which strips `instancePickingColors` — PathLayer's
  13 attributes + TimeFilter's 3 + CategoryColor's 1 = 17 would otherwise
  exceed WebGL2's 16-attribute guaranteed minimum on some GPUs. Setting
  `pickable: true` switches to the stock `PathLayer` so picking works
  (with a one-time warning about the possible link warning on
  16-slot GPUs).

The sublayer short id for `_subLayerProps` overrides is **`paths`**. Without a `type` override the class is `PathLayer` when `pickable`, `NoPickingPathLayer` otherwise.

## Source

[packages/layers/src/layers/core/animated-path-layer.ts](../../packages/layers/src/layers/core/animated-path-layer.ts)
