# AnimatedScenegraphLayer

The `AnimatedScenegraphLayer` renders **one authored glTF scenegraph per tracked object** — a full node hierarchy with PBR materials and per-node animation, instanced at each object's interpolated pose. It is to [`AnimatedMeshLayer`](./animated-mesh-layer.md) exactly what deck.gl's [`ScenegraphLayer`](https://deck.gl/docs/api-reference/mesh-layers/scenegraph-layer) is to its `SimpleMeshLayer`: the same data, the same motion, a heavier and more faithful render engine. The catalog mirrors deck's own two-layer split rather than hiding it behind a mode flag.

It **subclasses** `AnimatedMeshLayer` and inherits every line of its machinery — the AV `objects/` point archive, cross-tile pooling by `track_id`, binary-search + lerp interpolation, shortest-arc heading, quaternion slerp, appear/disappear fade, grow-only instance buffers, lazy pick rows, the geometry-kind guard. Only the render engine differs, so **the two layers are interchangeable over one archive and one config**: swap the class, keep the props.

## When to use which

|                             | [`AnimatedMeshLayer`](./animated-mesh-layer.md)           | `AnimatedScenegraphLayer`                                     |
| :-------------------------- | :-------------------------------------------------------- | :------------------------------------------------------------ |
| deck engine                 | `SimpleMeshLayer`                                         | `ScenegraphLayer`                                             |
| Asset                       | one flat mesh (glTF/OBJ) + optional separate `texture`    | a glTF 2.0 scenegraph: node hierarchy, materials, textures    |
| Materials                   | `material` (phong)                                        | the asset's own, via `_lighting: 'pbr'`                       |
| Animation                   | none                                                      | per-node (TRS) — see the caveats below                        |
| `scaleToDimensions` default | `true` (fit a unit model to the bbox)                     | **`false`** (an authored asset is already in metres)          |
| Best for                    | normalized primitives, one shape per class, gallery scale | authored assets from a DCC — Omniverse, Blender, any USD tool |

## Why it exists: authored assets

This is the consumption end of an OpenUSD pipeline ([openusd-integration-2026-07.md §8.5a](../roadmap/openusd-integration-2026-07.md)): author a vehicle, machine, or building in Omniverse or any USD DCC, export it to glTF, and drop it into the geospatial time scene at every tracked object's pose. STT contributes the axis and the streaming; the asset contributes the look.

Nothing about the layer is USD-specific — it renders any glTF 2.0 — but that is the workflow it was added for, and the constraints below are the ones that pipeline actually hits.

## Installation

```typescript
import { AnimatedScenegraphLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedScenegraphLayer({
  id: 'traffic-assets',
  data: '/data/av-scene/objects/manifest.json',
  currentTime,
  timeWindow: 2000, // ms — floor it above the keyframe cadence
  scenegraph: '/assets/sedan.glb', // exported from USD; already in metres
  _lighting: 'pbr', // run the asset's metallic-roughness material
  orientationOffset: [0, 90, 0], // correct an asset whose forward axis isn't +x
  sizeMinPixels: 2, // stay legible when zoomed out
});
```

### Per-category assets

```typescript
const layer = new AnimatedScenegraphLayer({
  id: 'traffic-assets',
  data: '/data/av-scene/objects/manifest.json',
  currentTime,
  colorProperty: 'category',
  scenegraphMapping: {
    car: '/assets/sedan.glb',
    truck: '/assets/box-truck.glb',
    pedestrian: '/assets/pedestrian.glb',
  },
  scenegraph: '/assets/generic.glb', // fallback for unmapped categories
  _lighting: 'pbr',
});
```

Active objects are grouped by `category` and each group is drawn by its own `ScenegraphLayer` (the asset is a per-layer prop, so distinct assets need distinct sublayers), each falling back to `scenegraph`. Every mapped category is seeded up front so its uploaded GPU model persists across frames instead of re-uploading as the category comes and goes.

### Drop-in over an existing mesh config

`scenegraph` falls back to the inherited `mesh`, and `scenegraphMapping` to `meshMapping`, so a config written for `AnimatedMeshLayer` drives this layer unchanged:

```typescript
// Same props object, either class.
const props = {
  data,
  currentTime,
  colorProperty: 'category',
  mesh: '/assets/car.glb',
};
new AnimatedMeshLayer(props); // SimpleMeshLayer
new AnimatedScenegraphLayer(props); // ScenegraphLayer, same pose
```

## Four constraints on authored assets

These are properties of deck's `ScenegraphLayer`, not of this wrapper, and each was verified against the installed deck 9.3.2 / luma.gl 9.3.3 / loaders.gl 4.4.2. Each one silently changes what an asset looks like in the browser versus in the DCC it came from.

1. **Skinned geometry does not deform.** deck's `scenegraph-layer-vertex.glsl` declares `positions`, `texCoords` and `normals` only — no `JOINTS_0` / `WEIGHTS_0` — and `_getModelOptions()` injects deck's own shaders into every glTF model (`modelOptions: {...this.getShaders()}`), replacing the one luma would have generated. luma.gl itself _has_ skinning; deck's instanced path does not reach it. **A rigged pedestrian renders in bind pose.** Bake deformation into per-node transforms, or use separate meshes per state.
2. **Rigid per-node animation does work.** `draw()` traverses the scenegraph with `worldMatrix` into a per-model `sceneModelMatrix` uniform and `GLTFAnimator` drives node TRS. Wheels spin, doors open, booms swing.
3. **…but on deck's clock, not the playhead.** `draw()` calls `animator.setTime(context.timeline.getTime())` — deck's own timeline, while STT drives `currentTime`. So `_animations` runs on wall-clock: it does **not** rewind when the timeline is scrubbed and does not stop when playback pauses. It also needs `_animate: true` on the `Deck` instance to tick at all, which forces a continuous redraw loop — gate that behind `prefers-reduced-motion` like any other animated surface. The layer warns once when `_animations` is set. Playhead-locked asset animation would need a `draw()` override and is not implemented.
4. **Materials are filtered twice on the USD route.** Omniverse's `omni.kit.asset_converter` emits only OmniPBR / `UsdPreviewSurface` / `gltf.mdl` when exporting USD → glTF. Then loaders.gl carries `KHR_draco_mesh_compression`, `KHR_texture_basisu`, `EXT_meshopt_compression`, `EXT_texture_webp` and `KHR_texture_transform` — but has **no handler** for `KHR_materials_clearcoat` / `_transmission` / `_sheen` / `_ior`, and deck hardcodes `useTangents: false`. Author to `UsdPreviewSurface`, stay on core metallic-roughness, and expect no tangent-space normal mapping.

Compressed assets need no extra setup: `@loaders.gl/gltf` already depends on `@loaders.gl/draco` and `@loaders.gl/textures`, so a Draco- or KTX2-compressed export loads as-is. Pass `scenegraphLoadOptions` if a specific decode option is needed.

## Two things this does better than the mesh sibling

- **Fades survive a textured asset.** `SimpleMeshLayer` lets a `texture` win over `getColor`, which kills the CPU appear/disappear alpha (`AnimatedMeshLayer` warns about exactly this). `ScenegraphLayer` **multiplies** instead — `fragColor = vColor * pbr_filterColor(...)` in PBR mode, `vColor * texture(baseColorSampler, uv)` in flat+textured mode — so the fade, the per-category color, and `opacity` all modulate a fully textured PBR asset. The inherited white default `[255, 255, 255, 255]` is the identity for that multiply, which is why it stays the default here.
- **`scaleToDimensions` defaults to `false`.** The inherited default (`true`) fits a _unit-sized_ model to each object's `[length, width, height]` box — correct for a normalized primitive, wrong for an authored asset, which arrives already in real metres via USD's `metersPerUnit`. Leaving the inherited default would silently squash every exported vehicle. Set it back to `true` if your asset really is unit-sized.

## Properties

Inherits all properties from [`AnimatedMeshLayer`](./animated-mesh-layer.md) (and therefore from [`SpatioTemporalLayer`](./spatiotemporal-layer.md)), with the changes and additions below.

### Asset

| Property            | Type                                       | Default | Description                                                                                                                                                                                                                                                                                                                                                                                       |
| :------------------ | :----------------------------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scenegraph`        | `ScenegraphSource`                         | `null`  | The static glTF scenegraph instanced at every object's pose — a `.gltf`/`.glb` URL, a parsed glTF, a luma.gl `ScenegraphNode`, or a promise of one (deck `scenegraph` pass-through). A per-layer prop, not a tile column. Falls back to the inherited `mesh`. When `scenegraphMapping` is set it is the fallback for unmapped categories; with neither, the layer renders nothing and warns once. |
| `scenegraphMapping` | `Record<string, ScenegraphSource> \| null` | `null`  | Per-category asset map, keyed by the raw `colorProperty` category string. One sublayer per category, each falling back to `scenegraph`. Falls back to the inherited `meshMapping`.                                                                                                                                                                                                                |

`ScenegraphSource` is `string | object | Promise<unknown> | null` (an alias of `MeshSource`).

### Rendering

| Property                         | Type                                                | Default                   | Description                                                                                                                                                                                                                                                                                                                                                      |
| :------------------------------- | :-------------------------------------------------- | :------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_lighting`                      | `'flat' \| 'pbr'`                                   | `'flat'`                  | Lighting mode (deck pass-through). `'pbr'` runs the glTF's metallic-roughness material through luma's PBR module and is what an authored asset expects; `'flat'` (deck's default, kept here so swapping the class never silently adds a PBR pass per instance) draws the base color unlit — cheaper, and better at gallery zoom where a vehicle is a few pixels. |
| `_imageBasedLightingEnvironment` | `unknown`                                           | `null`                    | Image-based lighting environment (deck pass-through). Requires `_lighting: 'pbr'`; the layer warns once if set without it.                                                                                                                                                                                                                                       |
| `_animations`                    | `Record<string, ScenegraphAnimationConfig> \| null` | `null`                    | (Experimental) glTF animation config keyed by animation index, name, or `'*'`. **Read constraint 3 above before using it** — it runs on deck's timeline, not the playhead, and needs `_animate: true` on the `Deck` instance.                                                                                                                                    |
| `sizeMinPixels`                  | `number`                                            | `0`                       | Minimum instance size in pixels (deck pass-through). Keeps an asset legible when zoomed out.                                                                                                                                                                                                                                                                     |
| `sizeMaxPixels`                  | `number`                                            | `Number.MAX_SAFE_INTEGER` | Maximum instance size in pixels (deck pass-through).                                                                                                                                                                                                                                                                                                             |
| `scaleToDimensions`              | `boolean`                                           | **`false`**               | Overrides the inherited `true`. See "Two things this does better", above.                                                                                                                                                                                                                                                                                        |

`ScenegraphAnimationConfig` is `{playing?: boolean; startTime?: number; speed?: number}`.

### Loading & escape hatches

| Property                | Type                              | Default | Description                                                                                                                                                                                                                                                                                                                                 |
| :---------------------- | :-------------------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scenegraphLoadOptions` | `Record<string, unknown> \| null` | `null`  | Load options for the glTF fetch/parse, forwarded to the sublayer's `loadOptions` — e.g. `{gltf: {decompressMeshes: true}}`. A **dedicated** prop because the base repurposes deck's `loadOptions` as `SttLoadOptions` for archive HTTP and deliberately does not forward it to sublayers, so glTF load options have no inherited path down. |
| `getScene`              | `Function \| null`                | `null`  | Build the luma.gl `GroupNode` from the resolved `scenegraph` (deck pass-through). Forwarded only when set — deck's default handles every ordinary glTF.                                                                                                                                                                                     |
| `getAnimator`           | `Function \| null`                | `null`  | Build the `GLTFAnimator` from the resolved `scenegraph` (deck pass-through). Forwarded only when set.                                                                                                                                                                                                                                       |
| `onFirstDraw`           | `Function \| null`                | `null`  | Called after the layer's first successful draw (deck pass-through). Forwarded only when set.                                                                                                                                                                                                                                                |

### Inherited props with no effect here

`ScenegraphLayer` has no equivalent for these `SimpleMeshLayer` props, so they are **not forwarded** and setting one warns once: `texture`, `textureParameters`, `wireframe`, `_instanced`, `material`. A glTF carries its own materials and textures — use `_lighting: 'pbr'` for material fidelity, or `AnimatedMeshLayer` for a flat mesh plus a separate texture.

## How it works

Identical to [`AnimatedMeshLayer`'s pipeline](./animated-mesh-layer.md#how-it-works) — geometry-kind guard, cross-tile pooling, per-frame interpolation, implicit visibility and fade, instance bake, forced redraw per advanced tick — with the final bake handed to a `ScenegraphLayer` instead of a `SimpleMeshLayer`. The pose reaches it untranslated: `getPosition`, `getOrientation`, `getScale`, `getTranslation`, `getTransformMatrix`, `getColor` and `sizeScale` are the same prop names on both deck layers.

The subclass overrides only four "engine seams" on the base — asset resolution, the missing-asset warning, the engine caveat warnings, and the engine id/class/props triple. Anything engine-specific added to either layer belongs in that group, or the two drift.

## Picking

Unchanged from `AnimatedMeshLayer`: `pickable` is inherited, a hit's `info.index` maps into that sublayer's per-instance active-track rows (stride 1), and `info.object` is the track's flat decoded props (`track_id`, `category`, `heading`, `length`, `width`, `height`, `speed`). The sublayer short id for `_subLayerProps` overrides is **`scenegraph`**.

## Source

[packages/layers/src/layers/core/animated-scenegraph-layer.ts](../../packages/layers/src/layers/core/animated-scenegraph-layer.ts)
