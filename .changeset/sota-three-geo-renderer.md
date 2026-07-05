---
"@poopdeck.gl/three": minor
---

SoTA geo-rendering upgrade for `@poopdeck.gl/three` (all additions are opt-in and backward-compatible):

- **Streaming**: the viewport-driven `StreamingTileSource` (LOD selection, frustum culling, cache eviction, prefetch) is now drivable from `SttScene` / `StandaloneViewer` / `<SttCanvas>` via an opt-in `streaming` prop/option. Eager load-everything remains the default. Registers a real `TilesetBufferSource` with the playback governor for honest buffering.
- **GPU picking + hover**: instanced point clouds are now pickable via the wired `GpuPicker` (previously only CPU ray-OBB boxes), and a new `onHover` callback fires on pointer-move (throttled). Fixed a latent bug where every GPU pick decoded feature index 0 (`readRenderTargetPixelsAsync` returns the pixels; the output-buffer arg was being misused as `textureIndex`), plus a background-sentinel and a concurrent-render race. `pickMechanism` is now `'gpu-id'`.
  - **Type change**: `SttPickInfo` is now a discriminated union `SttBoxPickInfo | SttPointPickInfo` — narrow on `kind` (`'object'` / `'ego'` are boxes; `'point'` is a cloud hit).
- **Atmosphere / sky / day-night** (`createSttAtmosphere`, `<SttAtmosphere>`, `atmosphere` prop): physically-based sky, sun, environment IBL, and aerial perspective via `@takram/three-atmosphere/webgpu`. Opt-in, default off, WebGPU-only with a graceful WebGL2 degrade; the sun tracks the playhead date. Setup failures fall back to a plain render (never crashes a scene).
- **3D Tiles / terrain / photorealistic** (`createStt3DTiles`, `<SttTiles3D>`, `createSttGlobeControls`): OGC 3D Tiles via `3d-tiles-renderer` — self-hosted `{ url }`, Google Photorealistic `{ google }`, or Cesium Ion `{ ion }` — plus ellipsoid-aware `GlobeControls`. Opt-in. Globe overlay co-registration requires the `GlobeProjection` `wgs84` datum.
- **Projection-aware `<SttCanvas>`**: new optional `projection` prop (default local-ENU, unchanged) with a projection-aware camera rig and controls — Mercator (flat, exact web-mercator) and Globe (ECEF, orbit + `frameGlobe`/`setGlobeClip`), unlocking globe scenes, atmosphere, and 3D tiles in the r3f binding.

New peer/regular dependencies: `@takram/three-atmosphere`, `@takram/three-geospatial`, `3d-tiles-renderer`.
