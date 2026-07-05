# AnimatedBoundingBoxLayer

The `AnimatedBoundingBoxLayer` renders **one smooth-moving oriented 3D box per tracked object** — the streetscape.gl / avs.auto tracked-object look, and the AV-cockpit detected-object overlay. The tile archive carries one POINT feature per object *per keyframe* (a snapshot: `track_id`, `category`, `heading`, `length`/`width`/`height`, `speed`, timestamped). The layer pools every loaded tile's keyframes by `track_id` and, once per frame, CPU-interpolates each active track's pose between the two keyframes bracketing the playhead — so an object glides continuously instead of leaving a "train" of one box per keyframe behind it.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md), but unlike its window-mode siblings it does **not** use the [`TimeFilterExtension`](./time-filter-extension.md): a track's visibility is implicit (it only produces a sample while the playhead lies inside its keyframe span), so there is no window/trail uniform to configure. `timeWindow` still governs which tile buckets stay resident — it only needs to cover roughly one keyframe gap so both bracketing keyframes are loaded.

## How a box is posed

- **Position** — the interpolated point (lon/lat/alt) between the two bracketing keyframes.
- **Orientation** — the `headingProperty` column (radians, `0` = +x/east, CCW), angle-interpolated the shortest way around the ±π seam, becomes `getOrientation: [0, heading°, 0]` — a yaw about the vertical axis (slot 1 of deck.gl `SimpleMeshLayer`'s `[pitch, yaw, roll]`). With no heading column, or NaN at both keyframes, boxes are axis-aligned.
- **Scale** — `[length, width, height]` (meters) → `getScale × 0.5 × sizeScale`. `CubeGeometry` spans ±1, so the ×0.5 makes one scale unit one meter.
- **Ground anchor** — each box is lifted by `height / 2 × sizeScale` (`getTranslation` z) so its base rests on the ground rather than straddling it.
- **Color** — the `colorProperty` category is resolved on the CPU through `colorMapping` into a per-instance RGBA `getColor` attribute, applied *before* the mesh's phong lighting so the box faces still read as a lit 3D volume (a GPU color extension would write after lighting and flatten it). The color is multiplied by a CPU appear/disappear fade driven by `fadeInDuration`/`fadeOutDuration`.

The optional 12-edge outline (`stroked`), labels (`showLabels`), and velocity arrows (`showVelocity`) are built from the same interpolated pose — see [How it works](#how-it-works).

## Installation

```typescript
import { AnimatedBoundingBoxLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedBoundingBoxLayer({
  id: 'detected-objects',
  data: '/data/av-scene/objects/manifest.json',
  currentTime,
  timeWindow: 200,            // ms — tile-loading window, not per-box visibility
  colorProperty: 'category',
  colorMapping: {
    car: [80, 170, 255, 255],
    pedestrian: [255, 90, 90, 255],
    bicycle: [255, 200, 60, 255],
  },
  sizeScale: 1,
});
```

Feed it the AV-cockpit `objects/` point archive (one snapshot per tracked object per keyframe, with a `track_id` column). When a tile lacks `length`/`width`/`height` columns, boxes fall back to the constant `defaultLength`/`defaultWidth`/`defaultHeight`.

### streetscape.gl detection-box look (outline + labels + velocity)

```typescript
const layer = new AnimatedBoundingBoxLayer({
  id: 'detected-objects',
  data: '/data/av-scene/objects/manifest.json',
  currentTime,
  filled: false,
  stroked: true,
  colorProperty: 'category',
  colorMapping: { car: [80, 170, 255, 255], pedestrian: [255, 90, 90, 255] },
  showLabels: true,
  showVelocity: true,
});
```

`filled: false` together with `stroked: true` gives the classic outline-only box you can see the LIDAR through. `showLabels` and `showVelocity` add a per-object category label and speed/heading arrow, each only for objects currently active.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Identity & color

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `trackIdProperty` | `string` | `'track_id'` | Categorical column name grouping an object's keyframe snapshots into one interpolated box. When absent, each snapshot becomes its own un-interpolated box, held for ±300ms around its lone keyframe — a degraded fallback real AV archives never hit. |
| `colorProperty` | `string \| null` | `null` | Categorical column name driving box color (e.g. `'category'`). Resolved via `colorMapping`. When unset, boxes use `colorMappingDefault`. |
| `colorMapping` | `Record<string, Color> \| null` | `null` | Category string → color map. Categories absent from the map use `colorMappingDefault`. |
| `colorMappingDefault` | `Color` | `[160, 160, 160, 255]` | Color for unmapped categories (and the constant color when `colorProperty` is unset). |

### Pose & geometry

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `headingProperty` | `string` | `'heading'` | Yaw column name (radians, world frame, 0 = +x/east, CCW). Drives the box's z-rotation, angle-interpolated between keyframes. |
| `lengthProperty` | `string` | `'length'` | Box-length column name (meters, heading axis). |
| `widthProperty` | `string` | `'width'` | Box-width column name (meters). |
| `heightProperty` | `string` | `'height'` | Box-height column name (meters). |
| `sizeScale` | `number` | `1` | Uniform multiplier on every box dimension. |
| `defaultLength` | `number` | `4` | Length used when `lengthProperty` names no column. |
| `defaultWidth` | `number` | `2` | Width used when `widthProperty` names no column. |
| `defaultHeight` | `number` | `1.6` | Height used when `heightProperty` names no column. |

### Fill & outline

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `filled` | `boolean` | `true` | Render the solid, phong-lit box faces (the `boxes` `SimpleMeshLayer`). Set `false` together with `stroked` for an outline-only box. If both `filled` and `stroked` are `false`, the layer falls back to filled so it never renders nothing. |
| `stroked` | `boolean` | `false` | Draw each box as a crisp 12-edge cuboid outline (the `edges` `LineLayer`) — the streetscape.gl / nuScenes-devkit detection-box look. Unlike `wireframe`, this draws only the 12 true box edges, not the mesh's triangle diagonals. |
| `strokeWidth` | `number` | `1.5` | On-screen width (pixels) of the `stroked` box edges. |
| `strokeWidthMinPixels` | `number` | `1` | Minimum on-screen width (pixels) of the `stroked` box edges, so they stay visible when the box is far away. |
| `strokeColor` | `Color \| null` | `null` | Distinct constant RGBA color for the `stroked` 12-edge outline (forwarded to the `edges` `LineLayer`'s `getColor`). `null` inherits each box's per-category fill × the appear/disappear fade; set a constant (e.g. a bright cyan) for the classic detection-box outline — a crisp outline over a dimmer fill. The fade still rides this color's alpha. |
| `getLineColor` | `Color \| null` | `null` | Upstream-vocabulary alias of `strokeColor` (constant `Color` only; a function accessor warns once and falls back to `strokeColor`). When set, wins over `strokeColor`. A property-column name is not supported for the outline color. |
| `strokeWidthUnits` | `'pixels' \| 'meters' \| 'common'` | `'pixels'` | Units for the `stroked` box-edge width (the `edges` `LineLayer`'s `widthUnits`). `'pixels'` keeps a constant on-screen thickness; `'meters'`/`'common'` scale with zoom. |
| `strokeWidthMaxPixels` | `number` | `Number.MAX_SAFE_INTEGER` (no clamp) | Maximum on-screen width (pixels) of the `stroked` box edges (the `edges` `LineLayer`'s `widthMaxPixels`) — an upper clamp so a meters/common-unit outline doesn't blow up to a thick slab when zoomed in. |
| `wireframe` | `boolean` | `false` | Draw a line wireframe around each box instead of filled faces (`SimpleMeshLayer` pass-through). This is the mesh's *triangle* wireframe (diagonals on every face); for a clean detection-box outline use `stroked` instead. |
| `material` | `Material` | `true` | Lighting material for the boxes (`SimpleMeshLayer` pass-through). `true` for the default phong material, `false` to disable lighting, or a material spec. |
| `fadeInDuration` | `number` | `200` | Appear-fade duration (ms of playhead time) for a box just after its track starts — a CPU alpha ramp folded into `getColor`. `0` pops in. |
| `fadeOutDuration` | `number` | `200` | Disappear-fade duration (ms of playhead time) for a box just before its track ends — a CPU alpha ramp folded into `getColor`. `0` pops out. |

### Labels

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `showLabels` | `boolean` | `false` | Draw a per-object `TextLayer` label (sublayer id `labels`) above each active box, billboarded. |
| `labelProperty` | `string` | `'category'` | Column name whose per-feature value is drawn as each object's label when `showLabels` is on. Reads a categorical column the same way box color reads `colorProperty`; a numeric column is stringified. |

### Velocity arrows

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `showVelocity` | `boolean` | `false` | Draw a per-object velocity arrow `LineLayer` (sublayer id `velocity`) from each box along its interpolated heading, length ∝ speed. Only drawn when the tile carries `speedProperty`. |
| `speedProperty` | `string` | `'speed'` | Speed column name (meters/second) driving the velocity-arrow length. Direction comes from `headingProperty`. |
| `velocityScale` | `number` | `1.5` | Velocity-arrow length scale: world-space meters of arrow per (meter/second) of speed. The default shows roughly ~1.5s of travel, so a 10 m/s object draws a ~15 m arrow. |
| `velocityMinSpeed` | `number` | `0.3` | Objects with speed below this (meters/second) draw no velocity arrow (the segment collapses to zero length) — filters parked/jittering objects. |
| `velocityColor` | `Color` | `[80, 255, 220, 255]` | Velocity-arrow color (RGBA) — a bright accent so arrows read over the boxes. |
| `velocityWidthMinPixels` | `number` | `2` | Minimum on-screen width of the velocity arrows, in pixels. |

## How it works

1. **Cross-tile pooling** — a track's keyframes are spread across temporal-bucket tiles (e.g. a 1s bucket at 2Hz holds ~2 of them), so the two keyframes bracketing the playhead can live in adjacent tiles. Every loaded tile's snapshots are grouped by `trackIdProperty`, with each keyframe's time rebased to absolute epoch-ms (`startTime + tile.timeOffset`) so snapshots from tiles with different `timeOffset`s sort into one timeline. The pooled, track-grouped index is rebuilt only when the visible tile set changes (or a style prop that feeds it changes) — not every frame.
2. **Per-frame interpolation** — for every track active at the playhead, a binary search finds the two bracketing keyframes and linearly interpolates position, dimensions, and speed; heading is interpolated the shortest way around the ±π seam. Missing dimension/heading/speed columns fall back to the `default*` props (or axis-aligned, for heading).
3. **Implicit visibility & fade** — a track only produces a sample while the playhead lies within its keyframe span; there is no separate time-filter window to configure. Just inside the start/end of that span, `fadeInDuration`/`fadeOutDuration` ramp the box's alpha from/to zero. A track with only one loaded keyframe (nothing to interpolate against) is instead held, un-interpolated, for ±300ms around that keyframe.
4. **Sublayers** — every enabled sublayer is rebuilt from the same per-frame active-track samples, so they appear and vanish together with their object:
   - **`boxes`** — a `SimpleMeshLayer` (`@deck.gl/mesh-layers`) instancing a unit `CubeGeometry`, one instance per active box (when `filled`).
   - **`edges`** — a `LineLayer` of each box's 12 true edges, computed from the same interpolated pose (when `stroked`).
   - **`labels`** — a `TextLayer` of each active object's `labelProperty` value, billboarded above the box (when `showLabels`).
   - **`velocity`** — a `LineLayer` velocity arrow per active object, from its interpolated `speedProperty` + `headingProperty` (when `showVelocity`).
5. **Redraw** — the layer forces a `renderLayers()` pass every frame (like [`AnimatedTripHeadsLayer`](./animated-trip-heads-layer.md)) so the CPU-computed instance buffers advance; the base class's shader-uniform redraw path never runs for this layer.

Cost scales with the number of *active* tracks over the visible tiles (AV scenes carry tens of active objects and a few thousand snapshots per scene) — a binary-search + lerp per active track, well under a millisecond per frame.

## Picking

Exactly one sublayer carries picking: `boxes` when `filled`, otherwise `edges` when `stroked` (a solid box is easier to click than a thin edge, so fill wins when both are on). `labels` and `velocity` are never pickable. A hit's `info.object` is set to that track's flat decoded props — `track_id`, `category`, `heading`, `length`, `width`, `height`, `speed` — the shape the AV cockpit's click-to-inspect handler reads.

## Source

[packages/layers/src/layers/core/animated-bounding-box-layer.ts](../../packages/layers/src/layers/core/animated-bounding-box-layer.ts)
