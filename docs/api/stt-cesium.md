# @poopdeck.gl/cesium

A CesiumJS backend for SpatioTemporal Tiles archives. It renders STT on a real
**WGS84 globe** using CesiumJS's own scene, camera, and picking — no deck.gl
or MapLibre dependency, and no Cesium ion access token (CesiumJS itself is
Apache-2.0; nothing here talks to ion).

The package is intentionally small. It is the first green-field backend built
against the shared render kernel in `@poopdeck.gl/core` — every layer is an
`SttRenderNode` plus a `BackendDescriptor` that declares what it supports, a
`ViewState`⇄Cesium camera bridge, and a render-loop clock hook. Positions,
categorical colour, time-filter alpha, trip interpolation, and OD endpoint
derivation are not reimplemented here — they come straight from
`@poopdeck.gl/core/{geo,style,time-filter,trips,geometry,shader-codegen}`,
the same modules the deck.gl, Three.js, and MapLibre backends use.

**Current scope: the movement catalog** — `point`, `path` (+ OD `line`),
`arc`, `trips`, `tripHeads`. Aggregation/summary kinds (heatmap, H3/quadbin,
the flowmap family) and surfels are declared unsupported with typed fallbacks
— see [Limitations](#limitations).

## Install

```bash
pnpm add @poopdeck.gl/cesium cesium
# or
npm i @poopdeck.gl/cesium cesium
```

`cesium` is a peer dependency, pinned **`^1`** (developed and tested against
`1.142.0`). Rendering STT tiles needs no Cesium ion access token, but CesiumJS
still needs its static asset bundle (workers, widget CSS) reachable at
runtime — point `window.CESIUM_BASE_URL` at the npm package's
`Build/Cesium/` output or a CDN copy before constructing a `Viewer`:

```ts
window.CESIUM_BASE_URL = 'https://cdn.jsdelivr.net/npm/cesium@1.142.0/Build/Cesium/';
```

## Exports

| Export | Kind | Description |
|--------|------|-------------|
| `CesiumPointLayer` | class | The `point` `SttRenderNode` — builds a `PointPrimitiveCollection` from decoded tiles and drives per-point alpha off the shared time-filter oracle |
| `CesiumPathLayer` | class | Animated LineStrings (`path` **and** OD `line` — an OD line is a 2-vertex LineString); batched `Primitive` + per-instance colour animation |
| `CesiumArcLayer` | class | OD flow arcs — endpoints via the kernel's `deriveSourceTargetPositions`, swept into raised great-circle polylines (same parametrization as three's globe arc material) |
| `CesiumTripsLayer` | class | Vehicle trails — per-frame CPU trail trim (`core/trips` `trimTrail`) into a `PolylineCollection`, arc-length tail fade material |
| `CesiumTripHeadsLayer` | class | Moving head-dots — per-frame `sampleHead` interpolation (`core/trips`) onto `PointPrimitive`s |
| `BatchedPolylineLayer` | class | The shared batched-`Primitive` machinery behind the path/arc layers (advanced use) |
| `buildPathPolylines` / `buildArcPolylines` / `sampleGreatCircleArc` | functions | The pure (Cesium-free, unit-tested) geometry builders behind the polyline layers |
| `featureColor` | function | Per-feature constant/categorical/ramp colour dispatch over `core/style` scalar lookups |
| `cesiumBackend` | `BackendDescriptor` | This backend's declared capabilities / layer-kind support, against `@poopdeck.gl/core/capabilities` |
| `viewStateToCesiumView` | function | Pure `ViewState` → Cesium camera-parameter math (no Cesium runtime import) |
| `cesiumViewToViewState` | function | Pure inverse of `viewStateToCesiumView` |
| `applyViewStateToCamera` | function | Drives a live Cesium `Camera` from a `ViewState` |
| `attachCesiumClock` | function | Binds a governor-owned playback clock to `scene.preRender` |
| `timeFilterAlphaGlsl` | function | Emits the generated GLSL ES 3.00 time-filter alpha expression, for a future GPU-`Appearance` path |

There is no shared base layer or archive-owning helper like MapLibre's
`STTBaseLayer` — the app wires `STTArchive` + `SpatiotemporalTileset` itself
and feeds tiles to the layer (see [How it works](#how-it-works)). Every layer
class has the same surface: `setTiles(tiles)`, `setTime(absoluteMs)`,
`pick(cssX, cssY)`, `dispose()`.

## Quick start

```ts
import { Viewer } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { STTArchive, SpatiotemporalTileset } from '@poopdeck.gl/core';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import { CesiumPointLayer, applyViewStateToCamera } from '@poopdeck.gl/cesium';

window.CESIUM_BASE_URL = 'https://cdn.jsdelivr.net/npm/cesium@1.142.0/Build/Cesium/';

const viewer = new Viewer(document.getElementById('cesiumContainer')!, {
  baseLayer: false, // no imagery provider — no ion token needed
  requestRenderMode: true, // render on demand; see the clock section below
});
viewer.clock.shouldAnimate = false; // Cesium's own clock must not compete with the STT playhead

const layer = new CesiumPointLayer(viewer.scene, {
  id: 'earthquakes',
  mode: 'window',
  timeFilter: { windowHalf: 12 * 60 * 60 * 1000 }, // 12h half-window
  pixelSize: 6,
});

applyViewStateToCamera(viewer.camera, { longitude: -122.4, latitude: 37.7, zoom: 6 });

const archive = new STTArchive({ url: '/data/earthquakes/manifest.json' });
const meta = await archive.getMetadata();

const tileset = new SpatiotemporalTileset({
  minZoom: meta.minZoom,
  maxZoom: meta.maxZoom,
  temporalBucketMs: meta.temporalBucketMs,
  ...makeTilesetCallbacks(archive),
  onTileLoad: () => layer.setTiles(tileset.getVisibleTiles()),
  onTileUnload: () => layer.setTiles(tileset.getVisibleTiles()),
});

const now = Date.now();
tileset.update({ bounds: meta.bounds, zoom: 6, time: now, timeWindow: 24 * 60 * 60 * 1000 }, true);
layer.setTime(now);
```

### Driving the playhead from Cesium's render loop

`attachCesiumClock` reads a governor-owned clock on every drawn frame
(`scene.preRender`) instead of pushing time through React state, so animation
stays synced to the actual draw frame:

```ts
import { attachCesiumClock } from '@poopdeck.gl/cesium';

// `timeController` is any object shaped like @poopdeck.gl/playback's
// TimeController — getTime() + on('tick'|'playState', ...). No import needed.
const detach = attachCesiumClock(
  viewer.scene,
  timeController,
  (t) => {
    layer.setTime(t);
    tileset.update({ bounds, zoom, time: t, timeWindow }, true);
  },
  { requestRender: true }, // required when requestRenderMode:true — see Limitations
);

// Before viewer.destroy():
detach();
```

`attachCesiumClock` never advances the clock itself — it is read-only, so it
cannot double-drive a controller that already owns its own `requestAnimationFrame`.

## `CesiumPointLayer`

### Constructor

```ts
new CesiumPointLayer(scene: Scene, options?: CesiumPointLayerOptions)
```

Adds a `PointPrimitiveCollection` to `scene.primitives` immediately; no tiles
are drawn until `setTiles` is called.

### Options (`CesiumPointLayerOptions`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | `'stt-cesium-points'` | Layer id, stamped onto each primitive's pick id so `pick()` can filter hits to this layer |
| `mode` | `TimeFilterMode` | `'window'` | One of `'window' \| 'wake' \| 'cumulative' \| 'trail' \| 'none'` — see [Time Filter Extension](./time-filter-extension.md) for the shared semantics |
| `timeFilter` | `TimeFilterParams` | `{}` | Mode parameters (`windowHalf`, `fadeIn`, `fadeOut`, `wakeLength`, `trailLength`, `trailFade`) — all relative milliseconds |
| `colorProperty` | `string` | — | Categorical property to colour by. Omit it and every point uses `colorMappingDefault` |
| `colorMapping` | `Record<string, RGBA255>` | — | Category → colour lookup for `colorProperty` |
| `colorMappingDefault` | `RGBA255` | `[200, 205, 215, 255]` | Colour for unmapped/absent categories, and for every point when `colorProperty` is unset |
| `pixelSize` | `number` | `6` | Point size in pixels — one constant for the whole layer; there is no per-feature radius property (unlike the deck.gl/MapLibre point layers) |

### Methods

| Method | Description |
|--------|-------------|
| `setTiles(tiles: Tile[])` | Rebuilds the point collection from decoded tiles. Clears and re-adds every primitive; rebases all feature `[startTime, endTime]` pairs onto one scene-wide `timeOrigin` (the first tile layer's `timeOffset`). Non-point layers in the tile set are silently skipped |
| `setTime(absoluteMs: number)` | Recomputes per-point alpha via the shared `timeFilterAlpha` oracle and writes it into each primitive's colour. Skips the write when a point's alpha is unchanged since the last call, and reuses one scratch `Color` — no allocations in the steady state |
| `pick(cssX: number, cssY: number)` | `scene.pick()` at the given CSS pixel, filtered to this layer's own primitives, returning a shared `SttPickResult` (`object` from `getFeatureProperties`, `index`, `layerId`, `coordinate: [lon, lat]`, `screen`) or `null` on a miss |
| `dispose()` | Removes the point collection from `scene.primitives` and drops all entries |

`CesiumPointLayer` implements the shared `SttRenderNode` interface (`id`,
`setTime`, `pick`, `dispose`) but does not implement the optional
`setViewState` hook — camera control goes through the camera bridge
functions below, not through the layer.

## The movement catalog

The four other layers share `CesiumPointLayer`'s lifecycle (`setTiles` →
`setTime` per drawn frame → `pick` → `dispose`) and its scene-wide
`timeOrigin` rebasing. All colour options take a `FeatureColorMode` —
`{ type: 'constant', color }`, `{ type: 'categorical', property,
colorMapping?, fallback }`, or `{ type: 'ramp', property, domain, range,
fallback }` — resolved per feature through `core/style`.

### `CesiumPathLayer` (`path` + `line`)

```ts
new CesiumPathLayer(scene, { id?, mode?, timeFilter?, color?, width?, zLift?, arcType? })
```

One batched `Primitive` of `PolylineGeometry` instances with per-instance
`ColorGeometryInstanceAttribute`s — a colour write is a batch-table texel
update, so per-frame time-filter animation stays one draw-call bucket.
Geometry z is honoured when the tile is 3-D (satellite tracks fly at
altitude). `arcType` (`'none'` default | `'geodesic'` | `'rhumb'`) picks the
vertex-to-vertex interpolation; use `'geodesic'` for sparse ground-hugging
lines. An OD `line` dataset needs no special handling — each 2-vertex
LineString renders as a (geodesic-capable) polyline.

### `CesiumArcLayer` (`arc`)

```ts
new CesiumArcLayer(scene, { id?, mode?, timeFilter?, color?, height?, samples?, width?, zLift? })
```

Each feature collapses to source/target endpoints
(`core/geometry` `deriveSourceTargetPositions`) and sweeps a raised
great-circle polyline (`sampleGreatCircleArc`, `samples` default 33): slerp of
the two ECEF direction vectors, radius lerped between the endpoint radii,
radial parabolic lift `height · chord · 4·t·(1−t)` — the SAME parametrization
as three's globe arc material, so a backend toggle shows the same arc.
`height: 0` hugs the great circle.

### `CesiumTripsLayer` (`trips`)

```ts
new CesiumTripsLayer(scene, { id?, trailLength?, color?, width?, fadeTrail? })
```

Cesium's stock polyline has no per-vertex shader hook, so the trail is
GEOMETRY, not alpha: every drawn frame each active trip is trimmed to
`[t − trailLength, t]` by `core/trips` `trimTrail` (interpolated head + tail
vertices) and written into a `PolylineCollection` polyline. `fadeTrail`
(default true) applies a tiny shared polyline material that ramps alpha along
the trimmed line's arc length — a geometric approximation of deck's
per-vertex time fade. Trips sharing a colour share one material instance, so
the collection batches by colour. Per-frame cost tracks the number of ACTIVE
trips.

### `CesiumTripHeadsLayer` (`tripHeads`)

```ts
new CesiumTripHeadsLayer(scene, { id?, color?, pixelSize? })
```

One `PointPrimitive` per trip, `show`-toggled; every drawn frame the head
position is interpolated by `core/trips` `sampleHead` (binary search + lerp
along per-vertex times — the tile's `vertexTimestamps` column when present,
else distance-synthesized). The trip index is built at `'f64'` precision so
globe-spanning data doesn't quantize.

## Camera bridge

STT's cross-backend camera vocabulary is a `ViewState`
(`{ longitude, latitude, zoom, pitch?, bearing?, roll?, altitude? }`) — the
same shape deck.gl, Three.js, and MapLibre share, so a renderer toggle keeps
one view. Cesium is a 3-DOF camera (it has roll, where deck/MapLibre don't),
and it's height-driven rather than zoom-driven, so the bridge does a bit more
conversion work than the other backends' equivalents.

Convention differences the bridge absorbs:

- **Pitch.** STT `pitch` is 0 = top-down; Cesium `pitch` is `-90°` =
  straight down, `0°` = horizon. `cesiumPitch = viewPitch - 90`.
- **Heading / bearing.** `heading = bearing`, both compass degrees.
- **Zoom ⇄ height.** Cesium's camera is positioned by altitude in metres, not
  a mercator zoom level. The bridge reuses the framework-free `core/geo`
  `GlobeProjection` + `worldUnitsPerPixel`/`zoomForWorldUnitsPerPixel` helpers
  (WGS84, no Cesium import) to convert between the two given a viewport
  height and vertical field of view — the same math a deck `GlobeView` would
  use for ground resolution. An explicit `ViewState.altitude` overrides the
  derived height outright.

### `viewStateToCesiumView(v, opts?)` / `cesiumViewToViewState(view, opts?)`

Pure functions — no Cesium runtime import, safe to unit test in Node.

```ts
export interface CesiumViewOptions {
  /** Viewport height in CSS px — sets the zoom→height scale. @default 800 */
  viewportHeight?: number;
  /** Vertical field of view, radians. @default 60° */
  fovRadians?: number;
}

interface CesiumView {
  longitude: number;
  latitude: number;
  height: number;      // camera altitude above the surface, metres
  headingRad: number;
  pitchRad: number;
  rollRad: number;
}
```

`cesiumViewToViewState` returns a `ResolvedViewState` — every `ViewState`
field present (`longitude`, `latitude`, `zoom`, `pitch`, `bearing`, `roll`),
so the two functions round-trip.

### `applyViewStateToCamera(camera, v, opts?)`

The one function in the package that touches a live Cesium `Camera` — it
converts `v` via `viewStateToCesiumView` and calls
`camera.setView({ destination, orientation })` with a `Cartesian3` /
`HeadingPitchRoll` built from the result.

## Render-loop clock

### `attachCesiumClock(scene, clock, apply, options?)`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scene` | `Scene` | — | The live Cesium scene to hook |
| `clock` | `PlayheadClock` | — | Anything shaped like `{ getTime(): number; on('tick', cb): () => void; on('playState', cb): () => void }` — `@poopdeck.gl/playback`'s `TimeController` satisfies this structurally, with no import |
| `apply` | `(timeMs: number) => void` | — | Called with the clock's absolute time on every drawn frame |
| `options.requestRender` | `boolean` | `false` | Also pump `scene.requestRender()` on `'tick'` and `'playState'`, so a `Scene` with `requestRenderMode: true` keeps animating while playing and goes idle (zero renders) when paused |

Returns a disposer that removes every listener it added — call it before
`viewer.destroy()`.

`apply` is wired to `scene.preRender`, which fires immediately before
Cesium's primitive-update + draw pass, so a colour/uniform write from `apply`
lands in the same frame it's read. The hook is read-only: it calls
`clock.getTime()` but never advances the clock, so it structurally cannot
double-drive a controller that runs its own `requestAnimationFrame` loop.

`requestRenderMode: true` on the `Viewer`/`Scene` and
`attachCesiumClock(..., { requestRender: true })` are an **atomic pair** —
turning on the former without the latter silently freezes a playing
animation, because nothing else will ask Cesium to redraw a new frame.

## Backend descriptor

`cesiumBackend` is a `BackendDescriptor` (from `@poopdeck.gl/core/capabilities`)
describing what the Cesium *engine* can do and what this *package* currently
implements — the two are called out separately, since Cesium natively has a
WGS84 globe, GPU picking, 3D extrusion, metric sizing, and camera roll well
beyond the one layer kind wired up so far:

| Trait / capability | Value |
|---|---|
| `globe` | `true` — Cesium's native frame is a WGS84 globe |
| `picking` | `true` — `scene.pick` |
| `extrude3d` | `true` |
| `metricSizing` | `true` — ECEF metres |
| `gpuHeatmap` | `false` |
| `liveBundling` | `false` |
| `timeAsHeight` | `false` |
| `interleavedBasemap` | `true` — STT primitives share Cesium's scene + depth buffer |
| `userExtensions` | `false` |
| `cameraRoll` | `true` — Cesium's camera has heading/pitch/roll |
| `projectsOnCpu` | `true` — via `core/geo` `GlobeProjection(wgs84)` → `Cartesian3` |
| `tilesetOwnership` | `shared` |
| `pickMechanism` | `host` — `scene.pick` |
| `basemapProjection` | `globe` |

`layerKinds()` marks `point`, `path`, `line`, `arc`, `trips`, and `tripHeads`
as `{ supported: true }`; `surfel` falls back to `point`, the flowmap family
(`flowmap`/`flowCorridor`/`flowStroke`) to `line`, `isoLines` to `path`, and
every remaining `LayerKind` is unsupported with an explicit reason. See the
generated [`docs/spec/backend-capabilities.md`](../spec/backend-capabilities.md)
for the full cross-backend matrix (regenerated by
`scripts/gen-capabilities-doc.mjs` — don't hand-edit it).

## GPU shader codegen

### `timeFilterAlphaGlsl(mode, nameMap?)`

```ts
function timeFilterAlphaGlsl(mode: TimeFilterModeKey, nameMap?: Record<string, string>): string
```

Emits GLSL ES 3.00 (Cesium is a WebGL2 host) for the same `ALPHA_EXPR`
expression AST that deck's `TimeFilterExtension` and Three's TSL time-filter
node graph compile from — one source of truth for the animation math, not a
hand-copied fork. `nameMap` rewrites the canonical identifiers
(`currentTime`, `startTime`, `endTime`, `windowHalf`, `fadeIn`, `fadeOut`,
`wakeLength`, `trailLength`, `trailFade`, `vertexTime`) to whatever a host
shader's variables are actually called.

This is ready-made for a future GPU-`Appearance` path — `CesiumPointLayer`
does not use it yet; it recomputes and writes alpha per point on the CPU in
`setTime` (see [Limitations](#limitations)).

## How it works

1. The `CesiumPointLayer` constructor adds an (initially empty)
   `PointPrimitiveCollection` to `scene.primitives`. There's no
   archive-owning base class — the app constructs its own `STTArchive` and
   `SpatiotemporalTileset` (wired via `makeTilesetCallbacks` from
   `@poopdeck.gl/core/tileset-adapter`), exactly as it would for any other
   STT backend.
2. Whenever the tileset's resident tile set changes, the app calls
   `layer.setTiles(tileset.getVisibleTiles())`. Each point feature's
   `[longitude, latitude, altitude?]` is projected once through `core/geo`'s
   `GlobeProjection({ datum: 'wgs84' })` into ECEF `Cartesian3` — Cesium's
   native frame, so the projected output drops straight into
   `PointPrimitiveCollection.add()` with no further conversion. Categorical
   colour, if configured, is expanded once per tile via `core/style`'s
   `expandCategoricalColors`.
3. Camera sync goes through the `ViewState` bridge, not through the layer:
   `applyViewStateToCamera` for one-shot moves, or read the camera back each
   frame via `cesiumViewToViewState` (as the showcase's Cesium renderer does
   to drive tileset streaming from `scene.camera.changed`/`moveEnd`).
4. `attachCesiumClock` subscribes to `scene.preRender` and calls `setTime`
   (plus, typically, a `tileset.update(...)`) on every drawn frame — so
   animation is paced by Cesium's actual draw cadence, not React's UI clock.
5. `setTime` walks the flat entry list built by `setTiles` and asks the
   shared `timeFilterAlpha(mode, …)` oracle for each point's alpha, skipping
   the GPU colour write when the value hasn't changed since the last frame.
6. `pick(cssX, cssY)` calls `scene.pick`, checks the returned primitive's id
   belongs to this layer, and joins the hit back to feature properties via
   the shared `getFeatureProperties(binary, featureIndex)` helper — the same
   join every backend's picking result uses.

## Limitations

- **Aggregation/summary kinds aren't implemented.** `heatmap`, `h3Summary`,
  `quadbinSummary`, the flowmap family, `isoLines`, `polygon`, `column`,
  `icon`, `boundingBox`, `surfel`, and `ego` are declared unsupported in
  `cesiumBackend` (with typed fallbacks where one makes sense) rather than
  silently dropped. The movement catalog — `point`/`path`/`line`/`arc`/
  `trips`/`tripHeads` — is real parity; the rest is demand-driven.
- **One colour per feature.** The batch-table animation path has no
  per-vertex colour, so deck's OD endpoint gradients
  (`getSourceColor`/`getTargetColor`) collapse to the source colour, per-vertex
  trip gradients collapse to a per-trip ramp, and the trips tail fade is
  arc-length-based rather than per-vertex-time-based.
- **No shared archive/tileset-owning base class.** Unlike MapLibre's
  `STTBaseLayer` (which owns `onAdd`/streaming/buffer-change forwarding), the
  Cesium package gives you the primitives (`CesiumPointLayer`,
  `attachCesiumClock`, the camera bridge) and expects the host app to wire
  `STTArchive` + `SpatiotemporalTileset` + `makeTilesetCallbacks` itself, as
  shown in [Quick start](#quick-start).
- **CPU-side time filtering.** `setTime` loops every feature on the CPU and
  writes a colour per changed feature (point `Color`s, polyline batch-table
  texels); `timeFilterAlphaGlsl` produces the GLSL for a GPU-`Appearance`
  path but nothing in this package wires it into one yet, so large feature
  counts pay a per-frame JS loop (mitigated by the unchanged-alpha skip, not
  eliminated). Trips additionally rewrite active polylines' positions each
  frame (the trail trim).
- **One constant pixel size / width per layer.** There is no per-feature
  radius or width property (`radiusProperty`, property-name `pathWidth`) —
  `pixelSize`/`width` apply to every feature in a layer.
- **`requestRenderMode` + `attachCesiumClock({ requestRender: true })` are a
  matched pair.** Turning on `requestRenderMode` without also passing
  `requestRender: true` (or otherwise calling `scene.requestRender()`
  yourself) freezes a playing animation — Cesium simply never redraws.
- **Cesium's own clock must be silenced.** `viewer.clock.shouldAnimate` needs
  to be `false`, or Cesium's built-in clock competes with the STT-driven
  playhead for scene updates.
- **Zoom↔height is an approximation.** `viewStateToCesiumView`/
  `cesiumViewToViewState` derive Cesium's height-driven camera from STT's
  zoom-driven `ViewState` using a fixed viewport-height/FOV model; it isn't
  pixel-identical to Cesium's own frustum math at extreme pitches or very
  high latitudes.
- **CesiumJS is a large runtime dependency** (workers, static assets, WebGL2
  requirement) compared to the other STT backends — reach for it only when
  you need a true 3D WGS84 globe with camera roll.

## Live demo

The showcase app has a dedicated Cesium route,
`/cesium/:datasetId` (`CesiumDemoPage` → `CesiumRenderer` →
`buildCesiumLayer`), which streams a dataset through the matching Cesium
layer on a real globe using the same playback clock as the other renderer
demos. Run `pnpm dev` from `examples/showcase` and navigate to
`/cesium/<datasetId>` for any `point` / `path` / `trips` / `trip-heads` /
`arc` dataset (other types redirect home).
