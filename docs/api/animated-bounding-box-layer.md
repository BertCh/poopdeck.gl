# AnimatedBoundingBoxLayer

The `AnimatedBoundingBoxLayer` renders **time-filtered oriented 3D boxes** at point features — the streetscape.gl / avs.auto tracked-object look. One box per active tracked object: each point carries a category (color), a heading (yaw), and box dimensions, and the box appears, holds, and fades as the playhead crosses its time window. It powers the AV-cockpit detected-object overlay.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) on the same per-tile binary-sublayer model as [`AnimatedColumnLayer`](./animated-column-layer.md): one `SimpleMeshLayer` (`@deck.gl/mesh-layers`) per tile, a unit `CubeGeometry` instanced at every point, with per-feature `getOrientation` / `getScale` / `getTranslation` / `getColor` buffers baked once per tile (zero-copy positions and times). The whole-box on/off + fade is the shared window-mode [`TimeFilterExtension`](./time-filter-extension.md) every sibling uses.

## How a box is posed

- **Orientation** — the `heading` column (radians, `0` = +x/east, CCW) becomes `getOrientation: [0, 0, heading°]`, a yaw about the vertical axis. With no heading column boxes are axis-aligned.
- **Scale** — `[length, width, height]` (meters) → `getScale × 0.5 × sizeScale`. `CubeGeometry` spans ±1, so the ×0.5 makes one scale unit one meter.
- **Ground anchor** — each box is lifted by `height / 2` (`getTranslation` z) so its base rests on the road rather than straddling it.
- **Color** — the category column is resolved on the CPU through `colorMapping` into a per-feature RGBA `getColor` attribute, applied *before* the mesh's phong lighting so the box faces read as a lit 3D volume.

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
  timeWindow: 200,            // ms — how long a box stays visible
  colorProperty: 'category',
  colorMapping: {
    car: [80, 170, 255, 255],
    pedestrian: [255, 90, 90, 255],
    bicycle: [255, 200, 60, 255],
  },
  sizeScale: 1,
});
```

Feed it the AV-cockpit `objects/` point archive (one box per tracked object per sample). When a tile lacks `length`/`width`/`height` columns, boxes fall back to the constant `defaultLength`/`defaultWidth`/`defaultHeight`.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `colorProperty` | `string \| null` | `null` | Categorical column name driving box color (e.g. `'category'`). Resolved via `colorMapping`. When unset, boxes use `colorMappingDefault`. |
| `colorMapping` | `Record<string, Color> \| null` | `null` | Category string → color map. Categories absent from the map use `colorMappingDefault`. |
| `colorMappingDefault` | `Color` | `[160, 160, 160, 255]` | Color for unmapped categories (and the constant color when `colorProperty` is unset). |
| `headingProperty` | `string` | `'heading'` | Yaw column name (radians). Drives the z-rotation. |
| `lengthProperty` | `string` | `'length'` | Box-length column name (meters, heading axis). |
| `widthProperty` | `string` | `'width'` | Box-width column name (meters). |
| `heightProperty` | `string` | `'height'` | Box-height column name (meters). |
| `sizeScale` | `number` | `1` | Uniform multiplier on every box dimension. |
| `defaultLength` | `number` | `4` | Length used when `lengthProperty` names no column. |
| `defaultWidth` | `number` | `2` | Width used when `widthProperty` names no column. |
| `defaultHeight` | `number` | `1.6` | Height used when `heightProperty` names no column. |
| `wireframe` | `boolean` | `false` | Draw a box wireframe instead of filled faces (SimpleMeshLayer pass-through). |
| `material` | `Material` | `true` | Lighting material — `true` for the default phong (gives the 3D read), `false` to disable. |
| `fadeInDuration` | `number` | `200` | Fade-in for appearing boxes (ms, TimeFilterExtension window). |
| `fadeOutDuration` | `number` | `200` | Fade-out for disappearing boxes (ms). |

## Behavior notes

- Category color is a **CPU bake** (per-feature RGBA), not the GPU `CategoryColorExtension`: the extension writes color *after* lighting, which would flatten the box shading. Object counts are small, so the O(n) bake is trivial.
- The sublayer short id for `_subLayerProps` overrides is **`boxes`**.

## Source

[packages/layers/src/layers/core/animated-bounding-box-layer.ts](../../packages/layers/src/layers/core/animated-bounding-box-layer.ts)
