# Three.js + TSL (WebGPU) renderer (2026-06)

A second, independent GPU renderer for STT, built on Three.js's node shading
language (TSL) running through `WebGPURenderer` (with automatic WebGL2 fallback),
with optional react-three-fiber bindings. It lives alongside the deck.gl renderer
(`@poopdeck.gl/layers`) and the maplibre adapter, consuming the **same** decoded
tiles (`@poopdeck.gl/core`) and the **same** playback clock
(`@poopdeck.gl/playback`).

Package: `packages/three` → `@poopdeck.gl/three` (engine) + `@poopdeck.gl/three/r3f`.

## TL;DR

- First end-to-end target = the **AV LIDAR cockpit** (`/drive/:sceneId`). The
  cockpit gains a **deck.gl ↔ TSL·WebGPU** renderer toggle; all existing chrome
  (telemetry, camera inset, stream panel, timeline, scene switcher) is reused
  unchanged — only the map viewport swaps.
- The hero is **oriented Gaussian surfels** (surface splatting) ported from deck's
  `SplatPrimitiveLayer` GLSL into a TSL node material, plus billboard point splats,
  CPU-interpolated tracked-object boxes, HD-map decals, and an ego trail.
- Backend: a single `WebGPURenderer` — WebGPU when available, its WebGL2 backend
  otherwise. TSL compiles the same node graph to WGSL or GLSL.

## Why a metric (ENU) world

AV tiles store geometry as lon/lat (+ z metres), georeferenced at build time by
`av_common.local_to_lonlat` (an equirectangular map about a documented origin).
The renderer **inverts** that to a local ENU frame anchored at the scene's view
centre:

```
world X = East  = (lon − lon0) · 111320 · cos(lat0)
world Y = North = (lat − lat0) · 111320
world Z = Up    = altitude (metres)
```

So **1 world unit = 1 metre**, Z-up. The surfel orientation quaternions are baked
in exactly this render-ENU basis, so the disk-offset math is a 1:1 port of the deck
splat shader with **no** mercator `project_size` step — metres are world units. The
projection is an interface (`LocalEnuProjection`); mercator-plane and ECEF-globe
variants can drop in later for the non-AV scenes.

## Pipeline

```
STTArchive (per stream) ─► eager full-scene tile load ─► layer.setTiles()
                                                            │  (merge all tiles into
                                                            │   one InstancedBufferGeometry,
                                                            │   rebased to one time origin,
                                                            │   ENU-projected)
TimeController ─► rAF ─► scene.setTime(t) ─► layer uniforms (no rebuild)
```

The AV scenes are small and local, so the renderer eagerly loads every tile once
and lets the GPU cull by time per frame (the surfel temporal Gaussian / the
time-filter alpha) — no viewport reselection, no per-frame rebuild. Streaming via
`SpatiotemporalTileset` can be wired later for the heavy multi-km clouds.

All per-feature/per-vertex times are **rebased to one common time origin**
(`timeRange.start`) so a single shared material + one `currentTime` uniform drives
a whole layer; AV spans are seconds, so the rebased f32 times stay exact (the same
`time − timeOffset` precision trick deck uses).

## Surfel material (the hero)

A line-for-line port of `packages/layers/src/layers/internal/splat-primitive-layer.ts`
into TSL (`tsl/surfel-material.ts`):

- smallest-three quaternion unpack (`q_a,q_b,q_c,q_imax`) → tangent/bitangent;
- temporal weight `exp(−½·((t−μ)/σ)²)` with static/dynamic σ and the
  cumulative/worldbuild appear-and-persist branch;
- a hexagon disk envelope (incircle = unit disk; ~13% fewer fragments than a quad);
- radial `exp(−falloff·r²)` falloff, `alphaTest` cutoff (sub-cutoff fragments write
  no depth → no halo), depth-write on, no sort;
- off-time surfels collapse to a zero-area triangle (the Three analogue of deck's
  `gl_Position = vec4(0)`).

## Render modes (parity with deck `case 'av'`)

| Dataset flag | Three layer | Status |
| --- | --- | --- |
| `lidarSurfel` | `SurfelLayer` (temporal Gaussian) | ✅ |
| `lidarWorldbuild` | `SurfelLayer` (cumulative + dynamic σ) | ✅ |
| `lidarScan` | `PointCloudLayer` (wake) | ✅ |
| `lidarSplat` / raw | `PointCloudLayer` (window, soft Gaussian) | ✅ |
| `lidarIso` / `lidarIso3d` | density iso-lines | deck-only for now |
| objects | `BoundingBoxLayer` (CPU interp + velocity) | ✅ |
| map poly/line | `StaticPolygonLayer` / `StaticPathLayer` | ✅ |
| ego | `EgoLayer` (trail + follow-cam) | ✅ |

## Testing

No WebGL/WebGPU in CI, so the GPU paths are verified in-browser (the same posture
the `react` package took for its WebGL `HoverPreview`). The **pure** logic is
unit-tested (48 tests): ENU round-trip vs `av_common`, smallest-three quaternion
unpack, the five time-filter alpha modes, categorical colour expansion, the
surfel/point tile→attribute wiring, box keyframe interpolation (shortest-arc
heading), and box-edge yaw geometry.

## Open / follow-ups

- **Browser aesthetic verification** of the surfel / point / box / map look vs the
  deck render (point size in metres vs deck's pixels may want tuning).
- **Click-to-inspect** (ObjectInspector) is not yet wired on the Three path (the
  box layer exposes `getActiveSamples()` for a future raycast).
- `iso`/`iso3d` density-line modes are deck-only.
- r3f v8 calls `renderer.render()` synchronously; `WebGPURenderer` warns once then
  auto-`renderAsync`-initialises on the first frames — acceptable, no special async
  wiring needed.
- Streaming (`SpatiotemporalTileset` + governor gating) for the heavy multi-km
  clouds; today the renderer eager-loads the whole scene.
