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
npm install @poopdeck.gl/three three
# for the react-three-fiber bindings:
npm install @react-three/fiber @react-three/drei react react-dom
```

**Peers**: `three` ≥ 0.171 (required); `react` ≥ 19 / `@react-three/fiber` ≥ 9 /
`@react-three/drei` ≥ 10 are optional peers used only by the `/r3f` subpath.

## Quick start (react-three-fiber)

```tsx
import { SttCanvas, SttSurfelLayer } from "@poopdeck.gl/three/r3f";

<SttCanvas
  anchor={{ longitude: -79.933, latitude: 40.456 }} // world origin
  timeOrigin={dataset.timeRange.start}              // common f32 time base
  timeRange={dataset.timeRange}
  getTime={() => timeController.getTime()}
>
  <SttSurfelLayer
    url="https://tiles.example.com/scene/lidar/manifest.json"
    temporalSigma={180}
    rgbColumns={["r", "g", "b"]}
  />
</SttCanvas>;
```

`<SttCanvas>` owns the `WebGPURenderer` (WebGL2 fallback), a Z-up camera with
`OrbitControls`, loads each child layer's archive, frames the camera, and reads
`getTime()` every frame to drive the temporal filter.

Without React, the same wiring is imperative: build an `SttScene` (engine
export), `scene.addLayer(new SurfelLayer({...}), manifestUrl)`, add
`scene.root` to your Three scene, `await scene.load()`, then call
`scene.setTime(t)` from your render loop.

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
in-browser. See the [parity roadmap](../../docs/roadmap/three-renderer-parity.md).

## Docs

- [@poopdeck.gl/three reference](../../docs/api/stt-three.md)

MIT.
