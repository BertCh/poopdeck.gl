# AnimatedMeshLayer

The `AnimatedMeshLayer` renders **one smooth-moving 3D model per tracked object** — recognizable glTF/OBJ meshes (cars, pedestrians, cyclists, ships, planes) instanced at each object's interpolated pose. It is the mesh analog of [`AnimatedBoundingBoxLayer`](./animated-bounding-box-layer.md): both read the **exact same** AV `objects/` point archive — one POINT feature per tracked object _per keyframe_ (`track_id`, `category`, `heading`, `length`/`width`/`height`, `speed`, timestamped) — and only the render primitive differs, so the two layers are interchangeable over one archive. The mesh geometry itself is **not** a tile column: it is a static per-layer prop (the analog of `IconLayer`'s `iconAtlas`), optionally a per-category map so cars, pedestrians, and cyclists each get their own model.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and shares the track kernel — pooling, binary-search + lerp interpolation, shortest-arc heading interpolation, and appear/disappear fade — with `AnimatedBoundingBoxLayer`; this layer owns only the [`SimpleMeshLayer`](https://deck.gl/docs/api-reference/mesh-layers/simple-mesh-layer) (`@deck.gl/mesh-layers`) instance bake. Like its box sibling it pools every loaded tile's keyframes by `track_id` and, once per frame, emits **one** interpolated instance per active track — never one model per keyframe — so an object glides continuously instead of leaving a "train" of models behind it.

## How a model is posed

- **Position** — the interpolated point (lon/lat/alt) between the two bracketing keyframes → `getPosition`.
- **Orientation** — the `headingProperty` column (radians, `0` = +x/east, CCW), angle-interpolated the shortest way around the ±π seam, rides the yaw slot of deck.gl's `[pitch, yaw, roll]` (`getOrientation`, degrees). The constant `orientationOffset` is added on top so a model whose native forward axis is not +x can be corrected once. With no heading column, models render axis-aligned (the offset alone). For a full 3-axis attitude — banking, pitching aircraft and drones — set [`quaternionColumn`](#full-3-axis-attitude-quaternioncolumn) instead.
- **Scale** — when `scaleToDimensions` (default), `getScale` = `[length, width, height]` (meters), fitting a unit-sized model to the object's bounding box; when `false`, `getScale` = `[1, 1, 1]` and the model renders at its native size. `SimpleMeshLayer`'s own `sizeScale` multiplies on top.
- **Color** — the `colorProperty` category is resolved on the CPU through `colorMapping` into a per-instance RGBA `getColor`, multiplied by the CPU appear/disappear fade. With a `texture` set, the mesh's texture wins and `getColor` is ignored (deck `SimpleMeshLayer` semantics); the default white keeps textured / vertex-colored models looking natural.
- **Anchor** — the constant `getTranslation` `[x, y, z]` (meters) offsets every instance from its anchor point — lift a center-origin model by half its height, or leave `[0, 0, 0]` for a base-anchored model.

## Installation

```typescript
import { AnimatedMeshLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedMeshLayer({
  id: 'traffic-models',
  data: '/data/av-scene/objects/manifest.json',
  currentTime,
  timeWindow: 200, // ms — tile-loading window, not per-model visibility
  mesh: '/models/car.glb', // a static per-layer prop, like IconLayer's iconAtlas
  colorProperty: 'category',
  colorMapping: {
    car: [80, 170, 255, 255],
    pedestrian: [255, 90, 90, 255],
    bicycle: [255, 200, 60, 255],
  },
  orientationOffset: [0, 90, 0], // correct a model whose forward axis isn't +x
  sizeScale: 1,
});
```

Feed it the AV-cockpit `objects/` point archive (one snapshot per tracked object per keyframe, with a `track_id` column). When a tile lacks `length`/`width`/`height` columns, models fall back to the constant `defaultLength`/`defaultWidth`/`defaultHeight` (used only while `scaleToDimensions` is on). If neither `mesh` nor `meshMapping` is set the layer renders nothing and warns once.

### Per-category models (distinct model per class)

```typescript
const layer = new AnimatedMeshLayer({
  id: 'traffic-models',
  data: '/data/av-scene/objects/manifest.json',
  currentTime,
  colorProperty: 'category',
  meshMapping: {
    car: '/models/car.glb',
    pedestrian: '/models/pedestrian.glb',
    bicycle: '/models/bicycle.glb',
  },
  mesh: '/models/generic.glb', // fallback for categories absent from the map
  scaleToDimensions: false, // pre-sized models render at native size × sizeScale
});
```

With `meshMapping` set, active objects are grouped by `category` and each group is drawn by its own `SimpleMeshLayer` (mesh is a per-layer prop, so distinct models need distinct sublayers), each falling back to `mesh`. A category with neither a mapped model nor a `mesh` fallback is skipped.

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Mesh & texture

| Property            | Type                                 | Default | Description                                                                                                                                                                                                                                                                                                                                          |
| :------------------ | :----------------------------------- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mesh`              | `MeshSource`                         | `null`  | The static 3D model instanced at every object's pose — a glTF/OBJ URL, a parsed mesh/geometry object, or a promise of one (`SimpleMeshLayer` `mesh` pass-through). A per-layer prop, not a tile column. When `meshMapping` is set it is the fallback for categories absent from the map. If both are unset the layer renders nothing and warns once. |
| `meshMapping`       | `Record<string, MeshSource> \| null` | `null`  | Per-category model map, keyed by the raw category string. When set, active objects are grouped by category and each group is drawn by its own `SimpleMeshLayer` with `meshMapping[category]` (falling back to `mesh`). Categories with neither a mapped model nor a `mesh` fallback are skipped.                                                     |
| `texture`           | `unknown`                            | `null`  | Texture applied to the mesh (`SimpleMeshLayer` `texture` pass-through — a URL, a texture source, or a promise). When set, the texture wins over `getColor` (so per-instance color and fades have no effect).                                                                                                                                         |
| `textureParameters` | `unknown`                            | `null`  | Texture sampler parameters (`SimpleMeshLayer` `textureParameters` pass-through).                                                                                                                                                                                                                                                                     |

`MeshSource` is `string | object | Promise<unknown> | null`.

### Identity & color

| Property              | Type                            | Default                | Description                                                                                                                                                                                                                                                                                                        |
| :-------------------- | :------------------------------ | :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trackIdProperty`     | `string`                        | `'track_id'`           | Track-identity column name grouping an object's keyframe snapshots into one interpolated model. When absent, each snapshot becomes its own un-interpolated instance, held for a short hold window around its lone keyframe (the layer warns once).                                                                 |
| `colorProperty`       | `string \| null`                | `null`                 | Categorical column name driving each model's per-instance color and (with `meshMapping`) which model to draw (e.g. `'category'`). Resolved via `colorMapping`. When unset, models use `colorMappingDefault` and a single `mesh`.                                                                                   |
| `getColor`            | `Color \| string \| null`       | `null`                 | Upstream-vocabulary alias for deck's `getColor`. A constant `Color` (one color for every model, overriding `colorProperty`) or a property-column name (treated as `colorProperty`) — **not** a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back). When set, it wins. |
| `colorMapping`        | `Record<string, Color> \| null` | `null`                 | Category string → color map. Categories absent from the map use `colorMappingDefault`.                                                                                                                                                                                                                             |
| `colorMappingDefault` | `Color`                         | `[255, 255, 255, 255]` | Color for unmapped categories (and the constant color when `colorProperty`/`getColor` name no column). White so textured / vertex-colored models keep their own appearance.                                                                                                                                        |

### Pose & geometry

| Property            | Type                       | Default     | Description                                                                                                                                                                                                                                                                   |
| :------------------ | :------------------------- | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headingProperty`   | `string`                   | `'heading'` | Yaw column name (radians, world frame, 0 = +x/east, CCW). Drives the model's `getOrientation` yaw, angle-interpolated between keyframes. Absent ⇒ models are axis-aligned.                                                                                                    |
| `quaternionColumn`  | `string \| null`           | `null`      | Per-feature **attitude quaternion** column name — an interleaved `FixedSizeList<Float32, 4>` vector column holding `[qx, qy, qz, qw]`. See [Full 3-axis attitude](#full-3-axis-attitude-quaternioncolumn).                                                                    |
| `orientationOffset` | `[number, number, number]` | `[0, 0, 0]` | Constant orientation offset `[pitch, yaw, roll]` in degrees, added to the interpolated heading (which rides the yaw slot) or to the `quaternionColumn` attitude. Corrects a model whose native forward axis is not +x, or tilts/rolls it.                                     |
| `lengthProperty`    | `string`                   | `'length'`  | Model-length column name (meters, model +x). Drives the x-scale when `scaleToDimensions`.                                                                                                                                                                                     |
| `widthProperty`     | `string`                   | `'width'`   | Model-width column name (meters). Drives the y-scale when `scaleToDimensions`.                                                                                                                                                                                                |
| `heightProperty`    | `string`                   | `'height'`  | Model-height column name (meters). Drives the z-scale when `scaleToDimensions`.                                                                                                                                                                                               |
| `scaleToDimensions` | `boolean`                  | `true`      | When `true`, `getScale` = `[length, width, height]`, fitting a unit-sized model to each object's bounding box. When `false`, `getScale` = `[1, 1, 1]` and the model renders at its native size (scaled only by `sizeScale`) — the right choice for a pre-sized car/ped model. |
| `sizeScale`         | `number`                   | `1`         | Uniform `SimpleMeshLayer` size multiplier applied to the whole model on top of `getScale`.                                                                                                                                                                                    |
| `getTranslation`    | `[number, number, number]` | `[0, 0, 0]` | Constant translation `[x, y, z]` (meters) from the anchor point (`SimpleMeshLayer` `getTranslation` pass-through). Lift a center-origin model by half its height, or leave `[0, 0, 0]` for base-anchored models.                                                              |
| `defaultLength`     | `number`                   | `4`         | Length used when `lengthProperty` names no column and `scaleToDimensions` is on.                                                                                                                                                                                              |
| `defaultWidth`      | `number`                   | `2`         | Width used when `widthProperty` names no column.                                                                                                                                                                                                                              |
| `defaultHeight`     | `number`                   | `1.6`       | Height used when `heightProperty` names no column.                                                                                                                                                                                                                            |

### Full 3-axis attitude (`quaternionColumn`)

`headingProperty` expresses **yaw only**, so an aircraft or drone archive
renders permanently wings-level. Set `quaternionColumn` to the name of a baked
`FixedSizeList<Float32, 4>` column of `[qx, qy, qz, qw]` (the shape
[`BinaryFeatures.vectorProps`](./binary-features.md) documents for exactly this
case) and the full attitude drives the pose instead: the quaternion is
**slerped** (shortest-arc) between the two keyframes bracketing the playhead,
converted to deck's euler `[pitch, yaw, roll]` degrees, and then
`orientationOffset` is added.

Requires a resolvable `trackIdProperty` column — attitude keyframes are pooled
per track exactly like positions, which costs a second pooled index (maintained
incrementally across tile churn, like the track index). The layer falls back to
the heading path, with a one-time warning, when the column is missing,
mis-sized, or ships a `u8` leaf.

### Upstream pose escape hatches

These are `SimpleMeshLayer` pass-throughs, unset by default so the layer's own
interpolated pose drives the models. Setting one hands that part of the pose to
the caller.

| Property             | Type                                           | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                       |
| :------------------- | :--------------------------------------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getOrientation`     | `[number, number, number] \| Function \| null` | `null`  | Constant `[pitch, yaw, roll]` (degrees) or a deck accessor. When set it **replaces** the computed per-instance orientation (heading / quaternion + offset) wholesale.                                                                                                                                                                                                                                             |
| `getScale`           | `[number, number, number] \| Function \| null` | `null`  | Constant `[x, y, z]` or a deck accessor. When set it **replaces** the computed `scaleToDimensions` scale.                                                                                                                                                                                                                                                                                                         |
| `getTransformMatrix` | `number[] \| Function \| null`                 | `null`  | Constant 16-element column-major matrix, or an accessor returning one. deck ignores `getOrientation`/`getScale`/`getTranslation` entirely when this yields a matrix, so it overrides the whole computed pose. **Caveat**: deck probes it once as `getTransformMatrix(data[0])`, and `data` here is a binary `{length, attributes}` object whose `[0]` is `undefined` — an accessor must tolerate that probe call. |

### Rendering

| Property          | Type       | Default | Description                                                                                                                                                                                                                                               |
| :---------------- | :--------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `material`        | `Material` | `true`  | Lighting material for the models (`SimpleMeshLayer` pass-through). `true` for the default phong material, `false` to disable lighting, or a material spec.                                                                                                |
| `wireframe`       | `boolean`  | `false` | Draw the models in wireframe mode (`SimpleMeshLayer` pass-through).                                                                                                                                                                                       |
| `_instanced`      | `boolean`  | `true`  | `SimpleMeshLayer` `_instanced` pass-through. `true` instances one shared mesh at every object; `false` treats mesh positions as lng/lat deltas of a single anchor (rarely wanted here).                                                                   |
| `fadeInDuration`  | `number`   | `200`   | Appear-fade duration (ms of playhead time) just after a track starts — a CPU alpha ramp folded into `getColor`. `0` pops in. Has no effect when a `texture` is set (the layer warns once), because the texture makes `SimpleMeshLayer` ignore `getColor`. |
| `fadeOutDuration` | `number`   | `200`   | Disappear-fade duration (ms of playhead time) just before a track ends — a CPU alpha ramp folded into `getColor`. `0` pops out. Has no effect with a `texture` set (see `fadeInDuration`).                                                                |

### Metadata

| Property        | Type     | Default      | Description                                                                                                                 |
| :-------------- | :------- | :----------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `speedProperty` | `string` | `'speed'`    | Speed column name (meters/second). Carried through to picking rows so the AV inspector can read it; not otherwise rendered. |
| `labelProperty` | `string` | `'category'` | Categorical/numeric column name whose value is carried through to picking rows / the per-track grouping label.              |

## How it works

0. **Geometry-kind guard** — tile layers whose `geometryType` is not `Point` are filtered out before pooling, with one named console warning, rather than being misread as one position per feature. (The filter is memoized on the tile-array reference, so the tile-identity short-circuits downstream stay intact.)
1. **Cross-tile pooling** — a track's keyframes are spread across temporal-bucket tiles, so the two keyframes bracketing the playhead can live in adjacent tiles. Every loaded tile's snapshots are grouped by `trackIdProperty`, with each keyframe's time rebased to absolute epoch-ms so snapshots from tiles with different `timeOffset`s sort into one timeline. The pooled, track-grouped index is rebuilt only when the visible tile set changes (or a style prop that feeds it changes) — not every frame.
2. **Per-frame interpolation** — for every track active at the playhead, a binary search finds the two bracketing keyframes and linearly interpolates position, dimensions, and speed; heading is interpolated the shortest way around the ±π seam, and a `quaternionColumn` attitude is slerped the shortest arc. Missing dimension/heading columns fall back to the `default*` props (or axis-aligned, for heading).
3. **Implicit visibility & fade** — a track only produces a sample while the playhead lies within its keyframe span; there is no separate time-filter window to configure. Just inside the start/end of that span, `fadeInDuration`/`fadeOutDuration` ramp the model's alpha from/to zero. A track with only one loaded keyframe is instead held, un-interpolated, for a short hold window around that keyframe.
4. **Instance bake** — the interpolated samples are baked into per-instance buffers (`getPosition` and `getColor` as binary attributes, `getOrientation` and `getScale` as function accessors that index those buffers), then handed to a `SimpleMeshLayer` (`@deck.gl/mesh-layers`) instancing `mesh` at each pose. With `meshMapping`, one `SimpleMeshLayer` is emitted per category (each mapped category is seeded up front so its GPU model persists across frames rather than re-uploading as the category comes and goes); otherwise a single sublayer draws every instance.
5. **Redraw** — the layer forces a `renderLayers()` pass every advanced tick (like `AnimatedBoundingBoxLayer`) so the CPU-computed instance buffers advance; the base class's shader-uniform redraw path never runs for this layer.

Cost scales with the number of _active_ tracks over the visible tiles — a binary-search + lerp per active track, well under a millisecond per frame.

## Picking

`pickable` is **inherited** like any other deck layer — pass `pickable: true` on the composite (it is no longer hardcoded on the sublayers, so `pickable: false` now genuinely disables hit-testing and stops paying for the picking attribute). A hit's `info.index` maps into that sublayer's per-instance active-track rows (stride 1) and `info.object` is set to that track's flat decoded props — `track_id`, `category`, `heading`, `length`, `width`, `height`, `speed` — the same AV-inspector shape `AnimatedBoundingBoxLayer` emits. The sublayer short id for `_subLayerProps` overrides is **`mesh`**.

## Source

[packages/layers/src/layers/core/animated-mesh-layer.ts](../../packages/layers/src/layers/core/animated-mesh-layer.ts)
