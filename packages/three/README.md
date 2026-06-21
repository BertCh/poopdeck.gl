# @poopdeck.gl/three

A **Three.js + TSL (Three Shading Language / WebGPU) renderer for SpatioTemporal
Tiles** — an independent, GPU-native alternative to the deck.gl renderer
(`@poopdeck.gl/layers`). It consumes the **same** decoded tiles from
`@poopdeck.gl/core` and the **same** playback clock from `@poopdeck.gl/playback`,
and renders them through a single `WebGPURenderer` (with automatic WebGL2
fallback) using TSL node materials.

The first-class target is the **AV LIDAR cockpit**: oriented anisotropic Gaussian
**surfels** and billboard point splats animated by a soft temporal Gaussian, in a
local ENU metric frame — the kind of surface-splatting that is awkward in a 2D map
renderer but natural in Three.

```
@poopdeck.gl/core (tiles)  ─┐
                            ├─►  @poopdeck.gl/three  ──►  WebGPURenderer (WebGL2 fallback)
@poopdeck.gl/playback (clock)┘        │
                                      └─►  @poopdeck.gl/three/r3f  (react-three-fiber)
```

## Why Three + TSL

- **Surface splatting in 3D.** Surfels are oriented elliptical disks with a radial
  Gaussian and a temporal Gaussian, depth-tested with depth-write on (no
  back-to-front sort). TSL compiles the same node graph to WGSL (WebGPU) or GLSL
  (WebGL2).
- **A metric world.** AV tiles are georeferenced lon/lat (+ z metres) about a scene
  origin. The local ENU projection inverts that to a Z-up metric frame where
  **1 world unit = 1 metre**, so the baked surfel orientation quaternions drop
  straight in with no mercator dance.
- **Same data, same clock.** No new tile format, no second playback engine — it
  reads `BinaryFeatures` and `TimeController` exactly like the deck renderer.

## Install

```bash
pnpm add @poopdeck.gl/three three
# for the react-three-fiber bindings:
pnpm add @react-three/fiber @react-three/drei react react-dom
```

`three` (≥ 0.168) is a peer dependency; `react` / `@react-three/fiber` /
`@react-three/drei` are optional peers used only by the `/r3f` subpath.

## Quick start (react-three-fiber)

```tsx
import { SttScene, SurfelLayer } from "@poopdeck.gl/three";
import { SttThreeView } from "@poopdeck.gl/three/r3f";

const scene = new SttScene({
  anchor: { longitude: -79.933, latitude: 40.456 }, // world origin
  timeOrigin: dataset.timeRange.start,               // common f32 time base
});
scene.addLayer(
  new SurfelLayer({ temporalSigma: 180, rgbColumns: ["r", "g", "b"] }),
  "https://tiles.example.com/scene/lidar/manifest.json",
);

<SttThreeView scene={scene} getTime={() => timeController.getTime()} />;
```

`<SttThreeView>` owns the `WebGPURenderer`, a Z-up camera with `OrbitControls`,
calls `scene.load()` (eagerly loading every tile in the scene), frames the camera,
and drives `scene.setTime(clock)` every frame.

## Layers

| Layer | Renders | Notes |
| --- | --- | --- |
| `SurfelLayer` | Oriented Gaussian surfels | hero LIDAR mode; `temporalSigma`, `cumulative` (worldbuild) |
| `PointCloudLayer` | Billboard point splats | `window` / `wake` (scan) / `cumulative`; categorical or `r,g,b` colour; `splat` soft Gaussian |
| `BoundingBoxLayer` | Tracked-object 3D boxes | CPU keyframe interpolation by `track_id`, 12-edge outlines + velocity arrows |
| `StaticPathLayer` | Map lines (lane dividers) | flat ground decals, categorical colour |
| `StaticPolygonLayer` | Map polygons (drivable area) | pre-baked triangles or earcut |
| `EgoLayer` | Ego trail + marker | provides the follow-camera target |

All animated layers share the TSL **time-filter** (`window` / `wake` / `trail` /
`cumulative` / `none`) — the node mirror of deck's `TimeFilterExtension`, pinned by
the CPU reference math in `time-filter-math.ts`.

## Architecture

- **Engine** (framework-agnostic): the `WebGPURenderer` bootstrap, the `SttScene`
  orchestrator + tile loader, the TSL materials, and the tile→geometry layer
  adapters. No React.
- **`/r3f`**: a thin react-three-fiber `<Canvas>` binding that drives the engine.

## Status

Pure-function logic (projection round-trip, quaternion math, time-filter alpha,
colour expansion, tile→attribute wiring) is unit-tested. The GPU material +
renderer paths have no headless coverage (no WebGL/WebGPU in CI) and are verified
in-browser. See `docs/roadmap/three-tsl-renderer.md`.

MIT.
