# Three.js renderer → SoTA for geo + STT tiles (2026-07)

Status: **implemented, live-render browser-verify pending.** Tracks the July 2026 upgrade of
`@poopdeck.gl/three` from a georeferenced *data* renderer into a state-of-the-art three.js
*geo* renderer. All package work is on `main` (uncommitted at time of writing) and each phase
was gated on `typecheck` + `test` + `build` green.

## 1. Where the renderer started

`@poopdeck.gl/three` was already a strong **GPU-native STT data renderer**:

- ~30 TSL node-material layers on a single `WebGPURenderer` (WebGL2 is a real fallback, not the
  default — the same TSL graph compiles to WGSL or GLSL).
- The core design win: every tile merges into **one buffer** and time-culls on the GPU via a
  single shared `currentTime` uniform — playback is a uniform write, never a geometry rebuild.
- Three interchangeable projections (`MercatorProjection`, `LocalEnuProjection`, and a real ECEF
  `GlobeProjection` with both `sphere` and `wgs84` datums), RTC origin-shift wired through every
  layer for f32 precision, and a deck-compatible ViewState↔camera bridge.
- `createHighLimitDevice` lifts WebGPU's 256 MB single-buffer cap for dense LIDAR.
- First-class AV LIDAR cockpit (oriented Gaussian surfels).

**The gap:** it rendered data *on* geography but did **not render geography** — no basemap tiles,
terrain, atmosphere, or photorealistic 3D, a bare 64×64 globe sphere; and two capabilities were
**built but unwired** (viewport streaming, GPU picking). It was also wired into the showcase only
for the AV cockpit.

## 2. Landscape scan + the governing constraint

The renderer is **WebGPU/TSL + `moduleResolution: NodeNext`**. That decides what can plug in:

| Project | Fit | Verdict |
|---|---|---|
| [`@takram/three-atmosphere`](https://github.com/takram-design-engineering/three-geospatial) | native `/webgpu` TSL path | **plugged in** (atmosphere) |
| [NASA-AMMOS `3d-tiles-renderer`](https://github.com/NASA-AMMOS/3DTilesRendererJS) | renderer-agnostic meshes + GlobeControls | **plugged in** (3D tiles) |
| `geo-three`, `three-geo` | GLSL `ShaderMaterial` — won't compile on `WebGPURenderer` | reference only |
| Giro3D / iTowns | own renderer + loop — can't co-host | reference only |
| [Spark](https://github.com/sparkjsdev/spark) (Gaussian splatting) | WebGPU path | **deferred** |

**Decisions (locked with the user):** plug in mature libs (not native reinvention); basemap =
reuse the existing host **maplibre camera-sync** (native TSL raster tiles dropped); **WebGPU-first
with graceful WebGL2 degrade**; priorities = wire streaming + picking, atmosphere, 3D tiles.

### NodeNext integration gotcha (reusable knowledge)
`type: module` deps that ship **extensionless `.d.ts` re-exports** don't resolve under NodeNext
("has no exported member"), even though the runtime JS import is fine. `@takram/three-atmosphere`
hit this; `3d-tiles-renderer` did not (it uses explicit `.js` extensions). The fix is a local
ambient `declare module` shim authored as a tracked **`.ts`** (NOT `.d.ts` — `.gitignore` excludes
`src/**/*.d.ts`, and `skipLibCheck` would hide errors inside a `.d.ts`). See
`src/types/takram-atmosphere.ts` for the pattern.

## 3. What was built

### Phase 0 — wire the machinery that already existed (no new deps)
- **Streaming** (`SttScene` / `StandaloneViewer` / r3f `SttCanvas`): the pre-built
  `StreamingTileSource` (viewport → `SpatiotemporalTileset.update` → LOD select / frustum cull /
  cache evict / prefetch → `onTilesChanged` → `layer.setTiles`) is now driven by the viewers as an
  **opt-in** mode (`streaming` prop/option). Eager load-everything stays the default. Registers the
  real `TilesetBufferSource` with the playback governor for honest buffering.
- **GPU picking + hover**: `GpuPicker` is now wired so instanced point clouds are pickable (not
  just CPU ray-OBB boxes), and `onHover` was added (throttled to one pick per frame). This resolved
  a standing TODO and **fixed a real latent bug** — `GpuPicker` was passing its output buffer as the
  `textureIndex` arg to the unified renderer's `readRenderTargetPixelsAsync` (which *returns* the
  pixels), so every GPU pick decoded index 0; plus a background-sentinel fix (black clear = feature
  0) and a concurrent-render race fix. `pickMechanism` is now `'gpu-id'`. **API note:** `SttPickInfo`
  is now a discriminated union `SttBoxPickInfo | SttPointPickInfo` — consumers narrow on `kind`.

### Phase 1 — atmosphere / sky / day-night (`@takram/three-atmosphere/webgpu`)
- New `src/scene/atmosphere.ts` (`createSttAtmosphere`): physically-based sky, sun, environment
  IBL, and aerial perspective, via a `pass → MRT → aerialPerspective` node pipeline. **Opt-in,
  default OFF, WebGPU-only** (graceful WebGL2 degrade to the plain render); setup is wrapped so a
  runtime failure falls back to a normal render — it can never crash a scene.
- Sun tracks the playhead date each frame (`getSunDirectionECEF`).
- ECEF alignment: takram's `Geodetic.toECEF` axes are identical to STT's `GlobeProjection`
  (+X@lon0/lat0, +Y@lon90E, +Z@pole) — no axis swap. `matrixWorldToECEF` is a scaled identity for
  globe scenes and the `[East|North|Up]` basis for local ENU/mercator.
- Enable: `new StandaloneViewer(el, scene, { getTime, atmosphere: true })` or
  `<SttCanvas atmosphere>` / `<SttAtmosphere/>`.

### Phase 3 — 3D Tiles / terrain / photorealistic (`3d-tiles-renderer`)
- New `src/scene/tiles-3d.ts` (`createStt3DTiles`) + `src/scene/globe-controls.ts`
  (`createSttGlobeControls`). Sources: `{ url }` (self-hosted OGC 3D Tiles), `{ google: { apiToken }}`
  (Photorealistic — needs `dracoDecoderPath`), `{ ion: { apiToken, assetId }}` (assetId 1 = Cesium
  World Terrain, 2 = Bing, 96188 = OSM buildings). Renderer-agnostic meshes → works under
  `WebGPURenderer`. **Opt-in.**
- Ellipsoid/tile alignment reuses the atmosphere module's tested `computeWorldToEcef` as the single
  source of truth; composes with atmosphere via render-priority ordering. **Overlay co-registration
  requires the globe scene on `datum:'wgs84'`** (the `sphere` datum mis-registers ~20 km; a one-time
  console warning fires on the sphere datum).
- Enable: `<SttCanvas><SttTiles3D source={{ ion:{apiToken, assetId:1} }} globeControls/></SttCanvas>`
  or `new StandaloneViewer(el, scene, { getTime, tiles3d:{ source:{google:{apiToken}} }, globeControls:true })`.

### Phase 4 — Three backend for the geo showcase demos
- New `examples/showcase/src/components/demo/SttThreeGeoViewer.tsx`: a geo analog of
  `AvThreeViewer` that maps each demo's deck layer config to the equivalent `@poopdeck.gl/three/r3f`
  layers, with a **maplibre camera-sync basemap + on/off toggle**. Wired into the `DemoPage`
  renderer selector (`deck | maplibre | three`) for ~30 flat demos (bixi & nyc-taxi families,
  flights, ships, hurricanes, gtfs, rivers, wildfires…).

### Phase 5 — projection-aware `<SttCanvas>` (the keystone)
- `<SttCanvas>` was ENU-only, which meant the globe-oriented features (atmosphere, 3D tiles) could
  not be exercised from r3f. Added a `projection?: Projection` prop (default = ENU, backward
  compatible) with a projection-aware camera rig + controls (flat → Z-up + MapControls; globe →
  `frameGlobe`/`setGlobeClip` + globe controls). This unlocks globe demos + atmosphere + 3D tiles in
  the app and lets flat demos use exact web-mercator basemap alignment.

## 4. Browser-verify checklist (no GPU/network in CI)

- Streaming: pan/zoom a large dataset on the three backend → tiles LOD-refine + evict; buffered bar
  reflects real coverage.
- GPU pick/hover: hover/click a LIDAR cloud decodes to the correct feature on WebGPU **and** WebGL2;
  no background flash.
- Atmosphere: sky/sun/aerial render and the sun aligns with the globe; check the sphere-vs-wgs84
  datum note at the horizon; confirm the WebGL2 degrade path.
- 3D tiles: url / Google / Ion each fetch + render; GlobeControls navigation; token/CORS
  (Google needs Map Tiles API key + `dracoDecoderPath`; Ion needs a token + assetId).
- Showcase geo viewer: transparent WebGPU canvas over the maplibre basemap; alignment on
  bixi (Montréal) + nyc-taxi (NYC); per-demo point sizing / corridor ramps.

## 5. Deferred

- **Native in-engine TSL raster basemap** (quadtree LOD, XYZ/WMTS providers) — dropped in favor of
  the maplibre camera-sync per the basemap decision.
- **Spark Gaussian splatting** for the AV/point-cloud path.
- **Incremental (non-replace-all) streaming residency** and an r3f streaming-source cache.
- Vector-tile basemap, labels/GPU text, draping/clamp-to-ground, antimeridian wrapping.
