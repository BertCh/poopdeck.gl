---
name: choosing-a-renderer
description: >-
  Pick the renderer backend for a SpatioTemporal Tiles dataset — deck.gl,
  MapLibre/Mapbox, Three.js + WebGPU, or CesiumJS. Use when a user asks which
  backend to use, whether a .stt can render without deck.gl, how to put STT on an
  existing MapLibre or Mapbox map, wants a true WGS84 globe, a WebGPU /
  react-three-fiber / LIDAR point-cloud scene, asks about bundle size or
  interleaving with native style layers, or hits a layer kind or capability one
  backend does not support. Covers the trade-offs, peer pins, and what carries
  over when you switch.
license: MIT
metadata:
  version: '0.6.0'
---

# Choosing an STT renderer backend

Four backends read the **same** archive through the same `@poopdeck.gl/core`
reader and animate off the same `TimeController`. Switching is a _render_
decision, not a data decision — the `.stt` never changes.

> **Doc paths** are repo-relative. With no repo on disk, use the MCP
> `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — full chain in **poopdeck-overview**.
> Everything load-bearing below is inlined.

## Step 1 — Pick by stack, not by feature list

| Backend                             | Pick it when                                                                                                    | Trade-off                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@poopdeck.gl/layers` (**deck.gl**) | Default. 21 of 23 kinds native (all but `ego`/`isoLines`), layer extensions, live flow bundling, fp64 precision | Brings the deck.gl dependency graph                                                                                  |
| `@poopdeck.gl/maplibre`             | You already run MapLibre GL (or Mapbox GL JS) and want STT **interleaved between native style layers**, no deck | 15 of 23 kinds; float32 mercator positions cap usable zoom around z15; one draw call per tile (no consolidation)     |
| `@poopdeck.gl/three`                | 3D-native scenes: LIDAR surfels, point clouds, a local metric (ENU) frame, WebGPU/TSL, react-three-fiber        | Needs WebGPU **or** WebGL2 (no WebGL1); basemap is a camera-synced overlay canvas, never interleaved; no GPU heatmap |
| `@poopdeck.gl/cesium`               | Already a Cesium shop; want STT on a real **WGS84 ellipsoid** globe with Cesium's own camera and picking        | Movement kinds only; CPU-side time filtering; the app wires `STTArchive` + `SpatiotemporalTileset` itself            |

## Step 2 — Check the deal-breakers

Straight from each backend's `BackendDescriptor` (the generated matrix lives at
`docs/spec/backend-capabilities.md`; `globe`, `picking`, `extrude3d`,
`metricSizing`, and all four time-filter modes are ✅ everywhere):

| Capability                        | deck | maplibre | three           | cesium |
| --------------------------------- | ---- | -------- | --------------- | ------ |
| `gpuHeatmap`                      | ✅   | ✅       | — (↳ point)     | —      |
| `timeAsHeight` (space-time cube)  | ✅   | ✅       | —               | —      |
| `interleavedBasemap`              | ✅   | ✅       | — (overlay)     | ✅     |
| `userExtensions` (LayerExtension) | ✅   | —        | —               | —      |
| `liveBundling` (KDEEB flowmap)    | ✅   | —        | — (static only) | —      |
| `cameraRoll`                      | —    | —        | —               | ✅     |

Layer-kind coverage, in one line each:

- **deck** — every kind native except `ego` (compose it from point/icon layers)
  and `isoLines` (degrades to `path`).
- **maplibre** — **fifteen** native classes: point, line, polygon, heatmap,
  trips, tripHeads, icon, column, arc, h3Summary, quadbinSummary, hexbin,
  flowCorridor, flowStroke, flowmap. `text` degrades to `icon`, `pointCloud` to
  `point`; the remaining six — path / boundingBox / surfel / mesh / isoLines /
  ego — have no substitute (`degradeRequest` returns `skip`, not a fallback; a
  hand-written `line` is the closest port for `path`).
- **three** — nothing is hard-unsupported; `heatmap`/`pointCloud` degrade to
  point density, `flowStroke` to `flowCorridor`, `text` to `icon`, `mesh` to
  `boundingBox`, `hexbin` to `h3Summary`. Only backend with a native `ego` kind
  and ENU-frame `SurfelLayer`.
- **cesium** — the movement catalog only: point, path, line, arc, trips,
  tripHeads. Aggregation/summary kinds fall back or skip.

Check a specific request programmatically instead of guessing:

```ts
import { degradeRequest } from '@poopdeck.gl/core/capabilities';
import { maplibreBackend } from '@poopdeck.gl/maplibre';

degradeRequest(maplibreBackend, 'text'); // → { action: 'fallback', toKind: 'icon', lost: [] }
degradeRequest(maplibreBackend, 'surfel'); // → { action: 'skip', reason: … }
degradeRequest(maplibreBackend, 'point'); // → null  (fully supported as-is)
```

`null` means the backend supports `(kind, mode)` as requested. The descriptors
export as `deckBackend` / `maplibreBackend` / `threeBackend` / `cesiumBackend`,
and a per-package conformance test stops one from claiming a kind whose class
isn't a live export — so the matrix cannot over-claim.

## Step 3 — Install with the right peer pins (must not guess)

| Backend  | Peer requirement                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deck     | deck.gl + luma.gl **`>=9.3.0 <10.0.0`** across the whole graph — see **installing-poopdeck**                                                              |
| maplibre | `maplibre-gl` **`^3 \|\| ^4 \|\| ^5 \|\| ^6`**; Mapbox GL JS **`>=3.9.1`** also works. `h3-js ^4.1.0` is an _optional_ peer, only for `STTH3SummaryLayer` |
| three    | `three` **`>=0.183.0`**. The `/r3f` subpath additionally needs `@react-three/fiber >=9`, `@react-three/drei >=10`, `react >=19`                           |
| cesium   | `cesium` **`^1`**. No ion token needed, but set `window.CESIUM_BASE_URL` before constructing a `Viewer`                                                   |

## Step 4 — Know the per-backend gotchas

- **MapLibre globe needs a v5+ host.** On v5/v6 the layers inject MapLibre's own
  `vertexShaderPrelude` and project through `projectTile`, so
  `map.setProjection({type: 'globe'})` works. v3/v4 render flat. **Mapbox globe
  is not supported** (mercator only).
- **MapLibre: prefer `layer.attach(map)` over `map.addLayer`** — it installs a
  `styledata` guard that re-adds the layer after a `setStyle` diff-rebuild, which
  otherwise silently destroys custom layers. `attach(map, { slot })` targets a
  Mapbox Standard-style slot; MapLibre has no slots (use `beforeId`).
- **MapLibre owns a tileset per layer.** Several layers on one archive should
  share a `SharedTilesetSource` (pass `source` instead of `url`, exactly one of
  the two) and register its `getBufferSource()` with the governor **once**.
  Stacking many layers? `STTLayerGroup` hosts N of them behind one custom layer.
- **MapLibre picking is `layer.pick(cssX, cssY)`** (an id-FBO pass), on every
  kind except heatmap. `queryRenderedFeatures` never reaches custom layers.
- **three's basemap is a separate canvas.** WebGPU and WebGL contexts are not
  interoperable, so three content always composites on top — no depth-weaving
  with 3D basemap content.
- **three's `GlobeProjection` defaults to a sphere.** Pass `datum: 'wgs84'` when
  registering against a real ellipsoidal frame (Cesium); the sphere diverges by
  up to ~20 km at mid-latitudes.
- **Cesium: `viewer.clock.shouldAnimate = false`,** or Cesium's own clock fights
  the STT playhead. `requestRenderMode` and
  `attachCesiumClock({ requestRender: true })` are a matched pair — turning on
  the first without the second freezes a playing animation.

## Class naming across backends

The same kind wears four names; don't mix them up when porting a demo:

| Backend  | Convention       | Trips example        |
| -------- | ---------------- | -------------------- |
| deck     | `Animated*Layer` | `AnimatedTripsLayer` |
| maplibre | `STT*Layer`      | `STTTripsLayer`      |
| three    | bare `*Layer`    | `TripsLayer`         |
| cesium   | `Cesium*Layer`   | `CesiumTripsLayer`   |

Time props port directly: deck/maplibre take full-width `timeWindow` +
`fadeInDuration`/`fadeOutDuration`; three accepts those **and** its native
half-width `windowHalf`/`fadeIn`/`fadeOut` (`windowHalf = timeWindow / 2`), with
the half-width name winning when both are set.

## What carries over when you switch

The archive, the manifest, `currentTime`/`timeWindow` semantics, the four
time-filter modes, `@poopdeck.gl/playback`'s `TimeController`/`PlaybackGovernor`
wiring (every backend exposes `onTilesetReady`/`onBufferChange`-shaped hooks or
a tileset you can hand the governor), the category/ramp color vocabulary, and the
shared `ViewState` camera type from `@poopdeck.gl/core/geo` (three and Cesium
bridge it to their own cameras — Cesium via `viewStateToCesiumView` and its
inverse). What does **not**: layer extensions, and any kind in the "no
substitute" list above.

Next: **wiring-deckgl-layers** for the deck catalog and props,
**adding-playback** for the clock, **debugging-blank-renders** if it draws
nothing. Refs: `docs/intro/choosing.md`, `docs/spec/backend-capabilities.md`,
`docs/api/backend-descriptor.md`, `docs/api/render-kernel.md`,
`docs/api/stt-maplibre.md`, `docs/api/stt-three.md`, `docs/api/stt-cesium.md`.
