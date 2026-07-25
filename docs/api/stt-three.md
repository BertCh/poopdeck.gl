# @poopdeck.gl/three

A Three.js renderer for SpatioTemporal Tiles archives, built on Three's
node-material system (TSL — Three Shading Language) so it runs on
`WebGPURenderer`'s WebGPU backend and falls back to its own WebGL2 backend
transparently. It consumes the exact same decoded tiles as
[`@poopdeck.gl/layers`](./spatiotemporal-layer.md) (via `@poopdeck.gl/core`)
and the same playback clock from `@poopdeck.gl/playback`, so it is a drop-in
alternative renderer rather than a separate data pipeline. It ships two
surfaces: a framework-agnostic engine core (`SttScene`, `createSttRenderer`,
individual `SttLayer`s) and a declarative react-three-fiber binding at the
`@poopdeck.gl/three/r3f` subpath (`<SttCanvas>` + layer components). It covers
a first-class local-metric (ENU) frame for the AV LIDAR cockpit — oriented
Gaussian surfels included — alongside mercator and globe projections, viewport
streaming, and a near-full port of the geographic layer catalog. See
[System overview](../architecture/system-overview.md) for where it sits in
the stack and [renderer-architecture.md](../roadmap/renderer-architecture.md)
for the deck-parity design rationale.

## Install

```bash
pnpm add @poopdeck.gl/three three
# for the react-three-fiber binding:
pnpm add @react-three/fiber @react-three/drei react react-dom
```

`three` (`>=0.171.0`) is a peer dependency. `@react-three/fiber`,
`@react-three/drei`, and `react` are peer dependencies too, but only required
if you import from the `@poopdeck.gl/three/r3f` subpath — the base package
has no React dependency.

> **Needs WebGPU or WebGL2.** TSL node materials only compile on Three's
> `WebGPURenderer` (which transparently falls back to its own WebGL2 backend
> when the browser has no WebGPU adapter); the classic `WebGLRenderer` cannot
> run them. There is no WebGL1 fallback — `isWebGPUAvailable()` /
> `canRenderGpu()`-style feature detection is worth gating on (the r3f
> `<SttCanvas>` does this for you, see below).

## Renderer bootstrap

```ts
import { createSttRenderer, isWebGPUAvailable } from '@poopdeck.gl/three';

const { renderer, backend } = await createSttRenderer({
  canvas: document.querySelector('canvas')!,
  antialias: true,
  alpha: true, // transparent clear, lets a basemap show through
});
console.log(backend); // 'webgpu' | 'webgl2'
```

`createSttRenderer` builds and `init()`s a `WebGPURenderer` — always `await`
it before the first render. It also pre-requests a WebGPU device with its
buffer-size limits raised to the adapter maximum (`createHighLimitDevice`),
because Three's default device caps a single buffer at the WebGPU spec
default (256 MB) and a dense LIDAR sweep's merged vertex buffer can exceed
that; `forceWebGL: true` skips this (the WebGL2 backend has no such cap).

| Function                                  | Description                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSttRenderer(opts?)`                | Builds + `init()`s a `WebGPURenderer`. Returns `{ renderer, backend }`.                                                                                                          |
| `isWebGPUAvailable()`                     | `true` if the page can request a WebGPU adapter (`navigator.gpu` present). Does not guarantee adapter/device acquisition succeeds.                                               |
| `resolveBackend(renderer, forceWebGL?)`   | Inspects a live renderer to report which backend `init()` actually chose.                                                                                                        |
| `createHighLimitDevice(powerPreference?)` | Pre-creates a `GPUDevice` with raised buffer-size limits; used internally by `createSttRenderer` and the r3f binding's `gl` factory. Returns `undefined` on WebGL2 / on failure. |

### `CreateRendererOptions`

| Field             | Type                                             | Default              | Description                                                                                         |
| ----------------- | ------------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------- |
| `canvas`          | `HTMLCanvasElement`                              | new canvas           | Target canvas (the r3f binding supplies its own).                                                   |
| `antialias`       | `boolean`                                        | `true`               | MSAA.                                                                                               |
| `alpha`           | `boolean`                                        | `true`               | Transparent clear, so a DOM/basemap layer underneath shows through.                                 |
| `forceWebGL`      | `boolean`                                        | `false`              | Pin the WebGL2 backend even when WebGPU is available (no compute shaders; maximum-uniformity mode). |
| `powerPreference` | `'high-performance' \| 'low-power' \| 'default'` | `'high-performance'` | GPU power hint.                                                                                     |

### Non-React mount

For apps without React there is no viewer wrapper — you own the camera and
the loop, and the package gives you the two halves: `createSttRenderer()`
(which `await`s `renderer.init()` **before** you ever call `render()`, so the
"render() before the backend is initialized" warning cannot happen) and
`SttScene`, whose `root` is a plain `Group` you add to any Three scene.

```ts
import { Scene, PerspectiveCamera, Group } from 'three';
import {
  SttScene,
  STTPointCloudLayer,
  createSttRenderer,
} from '@poopdeck.gl/three';

const { renderer } = await createSttRenderer({
  canvas: document.getElementById('viewport') as HTMLCanvasElement,
});

const stt = new SttScene({
  anchor: { longitude: -122.4, latitude: 37.77 },
  timeOrigin: Date.now(),
});
stt.addLayer(
  new STTPointCloudLayer({ id: 'points', colorProperty: 'category' }),
  '/data/points/manifest.json',
);
await stt.load();

const scene = new Scene();
scene.add(stt.root);
const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 10_000);
camera.up.set(0, 0, 1); // the engine's frames are Z-up

renderer.setAnimationLoop(() => {
  stt.setTime(Date.now());
  renderer.render(scene, camera);
});
```

For a camera rig, orbit controls and a follow-ego mode, use the r3f binding
(`<SttCanvas>`) below rather than hand-rolling them.

## Projections

`Projection` (re-exported from `@poopdeck.gl/core/geo`) is the pluggable seam
every layer's buffer builder projects lon/lat/alt through — it decouples the
GPU layers from any one coordinate scheme.

| Class                | Frame                                          | Use                                | Notes                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalEnuProjection` | Local East-North-Up, metres, Z-up              | AV cockpit / any small local scene | `1 world unit = 1 metre`; `metersPerWorldUnit = 1`. Anchored at a `GeoAnchor { longitude, latitude }`.                                                                                                                                                                                                                                                                            |
| `MercatorProjection` | EPSG:3857, Z-up plane (ground XY, altitude +Z) | Flat-map geographic demos          | `metersPerWorldUnit` is `cos(lat)`-scaled; `MAX_MERCATOR_LAT` clamps the usual ±85.05°.                                                                                                                                                                                                                                                                                           |
| `GlobeProjection`    | ECEF (Earth-Centred, Earth-Fixed)              | Globe geographic demos             | Real 3D sphere coords — a standard MVP renders it with real depth/occlusion (not deck's in-shader vertex-warp). `datum: 'sphere'` (default, byte-identical to the original implementation) or `datum: 'wgs84'` (ellipsoid, matches Cesium/real-globe hosts to the metre instead of the sphere's ~20 km mid-latitude mismatch). `radius` is configurable (default `EARTH_RADIUS`). |

Every `Projection` also exposes `metersPerWorldUnit(lon, lat)` (a sizing
scale for metric layers like columns/surfels) and `localFrame(lon, lat)` (a
per-position east/north/up basis — how a column stands up straight on a
globe, or a box orients on a mercator plane).

Coordinates project through **RTC** (relative-to-center): `projectPositions`
returns f32-relative vertices plus a per-build f64 origin, which each layer
writes to its `Object3D.position` — so large mercator/globe magnitudes stay
in the CPU-side f64 transform instead of losing precision in an f32 vertex
buffer. (`projectPositionsToEnu` is the ENU-only precursor, kept for
back-compat.)

### View state

```ts
import {
  viewStateToCamera,
  cameraToViewState,
  MercatorProjection,
} from '@poopdeck.gl/three';

const proj = new MercatorProjection();
const target = viewStateToCamera(
  proj,
  { longitude: -74, latitude: 40.7, zoom: 12, pitch: 45, bearing: 0 },
  camera,
);
// ...user drags the camera via OrbitControls/MapControls...
const viewState = cameraToViewState(proj, camera); // round-trips back to {longitude, latitude, zoom, pitch, bearing}
```

`viewStateToCamera`/`cameraToViewState` bridge deck.gl-shaped
`{longitude, latitude, zoom, pitch, bearing}` view state and a Three
`PerspectiveCamera`, so a showcase page can drive a deck view and a three
view from the same state object (used by the `/drive` deck↔three toggle).
`frameGlobe`/`setGlobeClip` (from `scene/globe-camera`) fit a camera to a
globe scene with planet-aware near/far clipping.

## Layer catalog

Every layer implements the small `SttLayer` contract (`setTiles(tiles, ctx)`,
`setTime(absoluteMs)`, `dispose()`) and owns one Three `Object3D`; a layer
merges every resident tile into **one** `InstancedMesh`/indexed mesh per
layer (not one draw call per tile, unlike the maplibre adapter), and
per-frame animation is a uniform write — no rebuild. The kind→class map is in
the [renderer-architecture.md appendix](../roadmap/renderer-architecture.md#appendix-canonical-concept-map-deck--three--maplibre).

> **Renamed in 0.6.0.** Through 0.5.x these classes were unprefixed
> (`ArcLayer`, `IconLayer`, `TripsLayer`, …), which shadowed deck.gl's own
> exports of the same names in any app importing both — and deck is the
> primary backend, so that is the normal case. Every layer class now carries
> the `STT` prefix, matching `@poopdeck.gl/maplibre` and `@poopdeck.gl/cesium`,
> so one layer kind has one spelling on every backend. The old names still
> resolve as `@deprecated` aliases (same class, IDE strikethrough) and are
> removed in 0.8.0. The deck column below keeps deck's own `Animated*` names —
> those never collided and did not change.

| Class                    | Geometry                         | Deck equivalent                                                  | Notes                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STTPointCloudLayer`     | Point                            | `AnimatedPointLayer`                                             | window/wake/cumulative modes, soft-Gaussian `splat`, categorical/RGB-column/continuous-ramp colour, metre or pixel sizing, GPU id-colour picking (opt-in, browser-verify).                                                                                                                                 |
| `STTSurfelLayer`         | Point (oriented surfel)          | `SplatLayer` / `SplatPrimitiveLayer`                             | Oriented anisotropic Gaussian surfels (surface splatting) — the AV LIDAR hero mode. Reads `--surfel`-baked quaternion/scale/rgba columns. ENU-only; no globe port.                                                                                                                                         |
| `STTWideLineLayer`       | LineString                       | `AnimatedPathLayer` / `AnimatedLineLayer` / `AnimatedTripsLayer` | Screen-pixel-width instanced ribbon over `createWideLineMaterial`; `mode: 'window' \| 'trail' \| 'none'`. `STTPathGeoLayer` subclasses it directly; `STTOdLineLayer`/`STTTripsLayer`/`STTFlowCorridorLayer` are siblings reusing the same material + segment-quad geometry with their own buffer builders. |
| `STTPathGeoLayer`        | LineString                       | `AnimatedPathLayer`                                              | `STTWideLineLayer` subclass pinned to `mode: 'window'` with path-shaped option names.                                                                                                                                                                                                                      |
| `STTStaticPathLayer`     | LineString                       | — (AV `map_line`)                                                | Flat, static hairline path (no width/time) for AV map-line overlays.                                                                                                                                                                                                                                       |
| `STTOdLineLayer`         | LineString → 2-point segment     | `AnimatedLineLayer`                                              | Collapses each feature to its first→last vertex (a straight OD flow).                                                                                                                                                                                                                                      |
| `STTTripsLayer`          | LineString (trail)               | `AnimatedTripsLayer`                                             | Per-vertex trail times, trailing fade over `[cur - trailLength, cur]`.                                                                                                                                                                                                                                     |
| `STTTripHeadsLayer`      | LineString → point               | `AnimatedTripHeadsLayer`                                         | CPU-interpolates a moving dot at the head of every active trip each frame (sub-ms; only active trips are re-uploaded).                                                                                                                                                                                     |
| `STTArcLayer`            | LineString → OD arc              | `AnimatedArcLayer`                                               | Raised parabolic or spherical great-circle source→target arcs, per-endpoint colour, per-feature height.                                                                                                                                                                                                    |
| `STTIconLayer`           | Point                            | `AnimatedIconLayer`                                              | Directional billboard markers from a host-supplied atlas texture; per-feature heading/size/tint; pixel sizing.                                                                                                                                                                                             |
| `STTColumnLayer`         | Point → prism                    | `AnimatedColumnLayer`                                            | Extruded 3D disk-prism bars, oriented to the local ground frame (stands up straight on a globe too); categorical/ramp/constant colour.                                                                                                                                                                     |
| `STTPolygonLayer`        | Polygon                          | `AnimatedPolygonLayer`                                           | Projected-space earcut (or pre-baked triangles), window-mode time fade, optional extrusion to a 3D prism. `STTStaticPolygonLayer` is a flat, static, categorically-coloured preset for AV `map_poly` overlays.                                                                                             |
| `STTIsoLayer`            | LineString (contours)            | — (AV `lidarIso`/`lidarIso3d`)                                   | Animated density iso-contour lines; window-filtered, optional per-ring altitude for iso3d.                                                                                                                                                                                                                 |
| `STTBoundingBoxLayer`    | Point (keyframed) → oriented box | `AnimatedBoundingBoxLayer`                                       | CPU track pooling + binary-search interpolation per frame; draws 12-edge wireframe boxes + optional velocity arrows; supports ray-OBB picking.                                                                                                                                                             |
| `STTEgoLayer`            | Point (keyframed) → box + trail  | — (AV ego vehicle)                                               | Static full trajectory line + an interpolated marker box; the source of the follow-camera target.                                                                                                                                                                                                          |
| `STTFlowmapLayer`        | Point pairs + value matrix       | `FlowmapLayer`                                                   | flowmap.gl-style tapered OD arrows sized by per-bucket trip volume + node circles sized by incident flow; re-expands at ~5 Hz, not per frame.                                                                                                                                                              |
| `STTFlowCorridorLayer`   | LineString + value matrix        | `FlowCorridorLayer`                                              | Static route network geometry, ridership-over-time from a `vertexValueMatrix` baked into a linear-filtered `DataTexture` (GPU does the two-bucket lerp — no CPU re-expand per sub-step).                                                                                                                   |
| `STTH3SummaryLayer`      | H3 cell (summary tier)           | `H3SummaryLayer`                                                 | Decodes summary-tier u64 cell ids to H3 boundary rings; static (built once).                                                                                                                                                                                                                               |
| `STTQuadbinSummaryLayer` | Quadbin cell (summary tier)      | `QuadbinSummaryLayer`                                            | Decodes summary-tier u64 cell ids to CARTO quadbin quads; static.                                                                                                                                                                                                                                          |

Not ported: `AnimatedHeatmapLayer` (GPU multi-pass aggregation — deferred;
the backend descriptor advertises `point` as the fallback kind),
`BundledFlowmapLayer`'s live KDEEB edge bundling (a deterministic
`preBundled`/`StaticBundle` path exists conceptually in the design but has no
three-side layer yet), and the `CategoryColorExtension` GPU palette-texture
path (categorical colour is CPU-expanded per tile, same as the maplibre
adapter).

### Time-window vocabulary

Every layer accepts `ThreeTimeWindowOptions`, which bridges deck/maplibre's
**full-width** `timeWindow` (ms) + `fadeInDuration`/`fadeOutDuration` onto the
three-native **half-width** `windowHalf` + `fadeIn`/`fadeOut`
(`windowHalf = timeWindow / 2`). Both forms are accepted on every layer; if
both are supplied for the same knob, the lower-level three-native name wins
(`windowHalf` over `timeWindow`, `fadeIn` over `fadeInDuration`, `fadeOut`
over `fadeOutDuration`).

| deck / maplibre (full-width) | three (half-width) | Resolved as                                              |
| ---------------------------- | ------------------ | -------------------------------------------------------- |
| `timeWindow`                 | `windowHalf`       | `windowHalf = timeWindow / 2` when `windowHalf` is unset |
| `fadeInDuration`             | `fadeIn`           | `fadeIn = fadeInDuration` when `fadeIn` is unset         |
| `fadeOutDuration`            | `fadeOut`          | `fadeOut = fadeOutDuration` when `fadeOut` is unset      |

A deck demo's `timeWindow: 86_400_000` therefore ports onto a three layer
directly; the half-width names win only when set explicitly.

## Streaming model

Two tile sources cover the two shapes of dataset this renderer targets:

| Source                | Strategy                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Use                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `SttTileSource`       | Eager — loads every tile of an archive once (optionally the union of every zoom level under `lodMode: 'additive'`), hands the layer the full set, and lets the GPU time-filter cull per frame. No viewport reselection, no per-frame rebuild.                                                                                                                                                                                                                             | Small, local archives (the AV cockpit's ~20 s scenes).            |
| `StreamingTileSource` | Wraps the core `SpatiotemporalTileset` (the same selection/prefetch/eviction machinery the deck renderer uses). A camera-derived `{bounds, zoom, time}` viewport (via `cameraToViewport`, which unprojects the four NDC frustum corners onto the ground plane and derives a slippy-map zoom from the measured ground resolution) drives `tileset.update`, and `onTilesChanged` fires with the fresh resident tile set only when it actually changes (`residentSetEqual`). | Heavy multi-km / wide-area datasets that can't be loaded eagerly. |

`TilesetBufferSource` is the real playback `BufferSource` for a streaming
dataset — it delegates buffered-runway / ranges / cost / ETA straight to the
tileset's coverage index, replacing the always-`complete:true`
`createCompleteBufferSource` used for eagerly-loaded (AV) sources, so the
`PlaybackGovernor` gates honestly on how much sim-time is actually buffered.

## react-three-fiber (`@poopdeck.gl/three/r3f`)

`<SttCanvas>` owns the `WebGPURenderer`, a Z-up camera, `MapControls`
(left-drag pans, matching the deck `MapController` gesture), the ground, and
an optional follow-ego rig; layer components compose inside it declaratively.
r3f's reconciler drives the lifecycle — mounting a layer adds it to the
scene, unmounting disposes it — and tile loading is coordinated through React
Suspense (each layer suspends on its archive load via `useSttTiles`, with a
bounded LRU across mount/unmount cycles).

```tsx
import { SttCanvas, SttPointCloudLayer } from '@poopdeck.gl/three/r3f';

function Viewport({ getTime }: { getTime: () => number }) {
  return (
    <SttCanvas
      anchor={{ longitude: -122.4, latitude: 37.77 }}
      timeOrigin={Date.now()}
      getTime={getTime}
    >
      <SttPointCloudLayer
        url="/data/points/manifest.json"
        colorProperty="category"
      />
    </SttCanvas>
  );
}
```

Every `Stt*Layer` component (`SttSurfelLayer`, `SttPointCloudLayer`,
`SttBoundingBoxLayer`, `SttMapPolygonLayer`/`SttPolygonLayer`,
`SttMapLineLayer`/`SttPathLayer`, `SttOdLineLayer`, `SttArcLayer`,
`SttIconLayer`, `SttColumnLayer`, `SttTripsLayer`, `SttTripHeadsLayer`,
`SttQuadbinLayer`, `SttH3Layer`, `SttFlowmapLayer`, `SttFlowCorridorLayer`,
`SttIsoLayer`, `SttEgoLayer`) takes the corresponding engine layer's options
plus a `url` (archive manifest) and an optional `lodMode`/`sourceRequired`.
`SttGlobeBasemap` mounts a static earth-sphere mesh for globe scenes.

### `SttCanvasProps`

| Field                     | Type                                  | Default                       | Description                                                                                                                                                |
| ------------------------- | ------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anchor`                  | `GeoAnchor`                           | —                             | lon/lat mapped to the world origin (the `LocalEnuProjection` anchor).                                                                                      |
| `timeOrigin`              | `number`                              | —                             | Common time base (epoch-ms) every layer rebases to.                                                                                                        |
| `getTime`                 | `() => number`                        | —                             | Playback clock — absolute playhead each frame.                                                                                                             |
| `registry`                | `SttSourceRegistry`                   | —                             | Playback governor registry; when set, each mounted layer registers a `BufferSource` so the transport's buffered bar / Auto-speed / ETA reflect this scene. |
| `timeRange`               | `{ start, end }`                      | —                             | Reported to the governor as the buffered span.                                                                                                             |
| `followEgo`               | `boolean`                             | `false`                       | Camera chases the `SttEgoLayer` pose with an exponential filter.                                                                                           |
| `topDown`                 | `boolean`                             | `false`                       | Steeper framing pitch.                                                                                                                                     |
| `pitchDeg` / `headingDeg` | `number`                              | —                             | Explicit initial camera pitch / heading (degrees), overriding the framing defaults.                                                                        |
| `background`              | `string`                              | `'#05070d'`                   | Canvas background (CSS color string).                                                                                                                      |
| `forceWebGL`              | `boolean`                             | `false`                       | Pin the WebGL2 backend.                                                                                                                                    |
| `pixelRatio`              | `number \| [number, number]`          | clamped device ratio `[1, 2]` | Device-pixel-ratio cap — the single biggest perf lever for fill-bound clouds on retina.                                                                    |
| `reducedMotion`           | `boolean`                             | `false`                       | Snap the camera instead of easing/damping (`prefers-reduced-motion`).                                                                                      |
| `ground`                  | `GroundOptions \| false`              | `{}`                          | Metric reference grid, or `false` to omit.                                                                                                                 |
| `onPick`                  | `(info: SttPickInfo \| null) => void` | —                             | Click-to-inspect callback over registered pickable layers (boxes + ego); omit to disable picking.                                                          |
| `renderFallback`          | `ReactNode`                           | built-in message              | Shown when WebGPU/WebGL2 is unavailable or the canvas subtree errors.                                                                                      |
| `fallback`                | `ReactNode`                           | `null`                        | Suspense fallback while layer archives load.                                                                                                               |

### `gl` factory and the render loop

The `gl` prop is an **async** factory (`WebGPURenderer.init()` before r3f's
first render — no blank frame, no "render before init" warning). Because the
STT layers read the playback `TimeController` in `useFrame` rather than
reacting to React state, and r3f's `frameloop="always"` only repaints on
demand under an async `gl` factory (camera/control events, not clock ticks),
`<SttCanvas>` runs `frameloop="never"` and drives its own `requestAnimationFrame`
pump (`advance(now)` every frame) so the scene tracks the external clock.

## Picking

Two independent mechanisms exist:

- **CPU ray-OBB** (`pickBoxes`/`rayObbHit`, wired by default in `<SttCanvas>`
  via `onPick`) — hit-tests a pointer click against every registered
  pickable layer's boxes (objects + ego). This is the mechanism the backend
  descriptor reports (`pickMechanism: 'cpu-ray'`).
- **GPU id-colour picking** (`GpuPicker`, `encodeId`/`decodeId`/`buildIdColors`,
  and `STTPointCloudLayer.pick()`) — an opt-in off-screen id-buffer render pass +
  readback for merged-instance point clouds, resolved back to a feature via
  the `InstanceProvenance` merged-buffer identity contract
  (`resolvePointPick`). Exists and is unit-tested on the resolve half; the
  live GPU pass is browser-verify-only (needs a device-backed harness).

## Compared to `@poopdeck.gl/layers` (deck.gl)

| Feature                                           | `@poopdeck.gl/three`                                                                                                     | `@poopdeck.gl/layers`                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Renderer                                          | Single `WebGPURenderer` (WebGPU, WebGL2 fallback), TSL node materials                                                    | WebGL2 (`deck.gl`)                                     |
| Mercator projection                               | ✓                                                                                                                        | ✓                                                      |
| Globe projection                                  | ✓ (ECEF mesh — real 3D sphere/ellipsoid, standard MVP depth)                                                             | ✓ (`GlobeView` — in-shader vertex warp)                |
| Local metric (ENU) projection                     | ✓ (native — the AV cockpit frame)                                                                                        | —                                                      |
| Viewport streaming                                | ✓ (`StreamingTileSource` wraps the shared `SpatiotemporalTileset`)                                                       | ✓                                                      |
| GPU time filtering (window/wake/cumulative/trail) | ✓ (`tsl/time-filter.ts`, parity across all 4 modes)                                                                      | ✓ (`TimeFilterExtension`)                              |
| Basemap                                           | Host-owned maplibre **overlay canvas**, camera-synced (not interleaved — WebGPU/WebGL contexts can't share a GL context) | Interleaved (`interleaved: true`) or overlay           |
| GPU heatmap aggregation                           | — (deferred; fall back to a point-density layer)                                                                         | ✓ (`AnimatedHeatmapLayer`)                             |
| Live edge bundling                                | — (deferred; static `preBundled` design only, unported)                                                                  | ✓ (`BundledFlowmapLayer`)                              |
| Category-color GPU palette texture                | — (CPU-expanded per tile)                                                                                                | ✓ (`CategoryColorExtension`)                           |
| Surfel / oriented-splat rendering                 | ✓ (`STTSurfelLayer`, ENU-only)                                                                                           | ✓ (`SplatLayer`/`SplatPrimitiveLayer`)                 |
| Picking                                           | CPU ray-OBB (default) + opt-in GPU id-buffer (browser-verify)                                                            | GPU id-colour (`Deck.pickObject`)                      |
| fp64 precision                                    | Not needed — RTC (relative-to-center f32 + f64 CPU origin) instead of an in-shader fp64 split                            | fp64 attribute split                                   |
| 16-attribute WebGL2 budget                        | Not applicable (WebGPU/TSL has no such ceiling)                                                                          | `NoPickingPathLayer` workaround needed for some layers |

See [backend-capabilities.md](../spec/backend-capabilities.md) for the
machine-generated, drift-guarded capability matrix across all four backends
(deck / three / maplibre / cesium).

## Limitations

- **No WebGL1 fallback.** `WebGPURenderer` requires WebGPU or WebGL2; older
  browsers/devices render nothing (`<SttCanvas>` shows a "needs WebGPU or
  WebGL2" fallback by default).
- **Basemap is a separate overlay canvas, never interleaved.** TSL only
  compiles on `WebGPURenderer`, and WebGL/WebGPU contexts are non-interoperable
  — the maplibre basemap sits on its own camera-synced canvas underneath, so
  there is no per-pixel depth-weaving between 3D basemap content (extruded
  buildings, terrain) and STT layers; three content always composites on top.
- **GPU heatmap aggregation is deferred.** `AnimatedHeatmapLayer` has no
  three port; the backend descriptor's capability matrix reports
  `gpuHeatmap: false` with `point` as the declared fallback kind.
- **Live edge bundling (`BundledFlowmapLayer`) is unported.** Only the
  design for a deterministic pre-bundled `DataTexture` path exists; there is
  no three-side layer for it yet (the backend descriptor's `layerKinds.flowStroke`
  is `{ supported: false, fallbackKind: 'flowCorridor' }`).
- **Categorical colour is CPU-expanded per tile,** not a GPU palette-texture
  lookup — matching the maplibre adapter, not the deck `CategoryColorExtension`
  path. Hot-swapping a palette re-uploads the colour attribute.
- **`STTSurfelLayer` is ENU-only** — the surfel orientation quaternions are baked
  at build time in the local-ENU render basis; there is no mercator/globe
  surfel port.
- **`GlobeProjection` defaults to a sphere**, not the WGS84 ellipsoid — a
  sphere mis-registers geometry against a true ellipsoidal frame (e.g.
  Cesium's) by up to ~20 km at mid-latitudes. Pass `datum: 'wgs84'`
  explicitly when ellipsoid accuracy matters.
- **User `LayerExtension`-style hooks and camera roll are not implemented**
  (`userExtensions: false`, `cameraRoll: false` in the backend descriptor).
- **GPU id-colour picking is browser-verify-only.** The pure index→feature
  resolve path (`resolvePointPick`) is unit-tested; the live off-screen
  render-and-readback pass needs a real WebGPU device and has not been
  verified end-to-end outside manual browser testing.
- **Per-tile-group time origin under streaming is not yet wired** — all
  resident tiles currently rebase to one scene-wide `timeOrigin`, which is
  exact for AV-scale (second-to-minute) spans but can lose f32 precision for
  a streaming dataset spanning many days/years within one resident set.
- **General (non-AV) showcase wiring is partial.** Only the AV cockpit's
  `AvThreeViewer` composes layers today; a generic `buildDemoLayers`-style
  three path for the rest of the showcase demo catalog is not yet built (see
  [renderer-architecture.md §5.2](../roadmap/renderer-architecture.md#52-three-backend--integration-tail)).

## Live demo

The AV cockpit (`/drive/:sceneId` in the showcase app) ships a live deck.gl ↔
Three.js + TSL toggle — the "TSL · WebGPU" button in the cockpit chrome swaps
`AvDeck` for `AvThreeViewer` (`@poopdeck.gl/three/r3f`) against the same
dataset, playback clock, and governor registry. Run `pnpm dev` from
`examples/showcase` and open any Argoverse 2 or nuScenes drive scene.
