---
'@poopdeck.gl/layers': minor
---

`AnimatedScenegraphLayer` — authored glTF assets on the track kernel

New layer: a full glTF **scenegraph** (node hierarchy, PBR materials, per-node
animation) instanced at each tracked object's interpolated pose. It is to
`AnimatedMeshLayer` what deck's `ScenegraphLayer` is to its `SimpleMeshLayer`,
and the catalog now mirrors that split rather than hiding it behind a mode flag.

It **subclasses** `AnimatedMeshLayer` and inherits the whole pipeline — the AV
`objects/` archive, cross-tile pooling by `track_id`, binary-search + lerp,
shortest-arc heading, quaternion slerp, fades, grow-only instance buffers, lazy
pick rows, the geometry-kind guard. Only the engine differs, and `scenegraph` /
`scenegraphMapping` fall back to the inherited `mesh` / `meshMapping`, so one
props object drives either class.

**Why:** this is the consumption end of an OpenUSD pipeline — author in Omniverse
(or any USD DCC), export to glTF, place the asset in the geospatial time scene.

**New props:** `scenegraph`, `scenegraphMapping`, `_lighting`,
`_imageBasedLightingEnvironment`, `_animations`, `sizeMinPixels`,
`sizeMaxPixels`, `getScene`, `getAnimator`, `onFirstDraw`, and
`scenegraphLoadOptions` (a dedicated prop because the base repurposes deck's
`loadOptions` as `SttLoadOptions` for archive HTTP and does not forward it).

**Two deliberate divergences from the mesh sibling**

- `scaleToDimensions` defaults to **`false`**. The inherited `true` fits a
  _unit-sized_ model to each object's `[length, width, height]` box, which would
  silently squash an authored asset — those arrive already in real metres via
  USD's `metersPerUnit`.
- Appear/disappear fades work on a **textured** asset. `SimpleMeshLayer` lets a
  `texture` win over `getColor` and kills the CPU alpha ramp;
  `ScenegraphLayer` multiplies `getColor` into the material instead, so the
  fade, the per-category color and `opacity` all modulate a textured PBR asset.

**Four constraints, verified against deck 9.3.2 / luma 9.3.3 / loaders 4.4.2**
and documented on the layer (with one-time warnings where detectable): skinned
geometry does **not** deform (deck injects its own vertex shader, which declares
no `JOINTS_0`/`WEIGHTS_0`); rigid per-node animation does work; but it runs on
deck's `context.timeline`, **not** the STT playhead, so it neither rewinds on a
scrub nor stops on pause, and needs `_animate: true` on the `Deck` instance; and
`KHR_materials_clearcoat`/`_transmission`/`_sheen`/`_ior` have no loaders.gl
handler, with `useTangents: false` hardcoded — so author to `UsdPreviewSurface`
and stay on core metallic-roughness. Draco/KTX2/meshopt-compressed assets need
no extra setup.

`AnimatedMeshLayer` is unchanged in behaviour. Internally it grew four
`protected` engine seams (asset resolution, the missing-asset warning, the
engine caveat warnings, the engine id/class/props triple) that the subclass
overrides; its 42 existing tests pass untouched.
