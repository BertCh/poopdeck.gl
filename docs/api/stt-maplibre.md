# @poopdeck.gl/maplibre

A MapLibre GL custom-layer adapter for SpatioTemporal Tiles archives.

This package lets a vanilla MapLibre GL site consume STT archives without
pulling in deck.gl. It implements MapLibre's `CustomLayerInterface` and renders
STT tiles in raw WebGL, with the same archive reader and tileset scheduler the
deck.gl layers use under the hood — including the globally-coalesced batch
loading path (one range-coalesced request per viewport fill, incremental
per-tile delivery, giant-parent-tile gating, throughput-driven ETAs).

If you can take a deck.gl dependency, [`@poopdeck.gl/layers`](./spatiotemporal-layer.md)
still has a few advantages — rounded joints/dashes, GPU picking, GPU-side
category-color extension, cross-tile consolidation. The MapLibre adapter trades
those off for a much smaller bundle and the ability to interleave between
native MapLibre style layers. It covers five layer kinds — points, lines,
polygons (with optional stroke + extrusion), animated trips, and density
heatmaps; the deck-only kinds (arcs, flowmaps, summary tiers, …) are listed
in the [backend capability matrix](../spec/backend-capabilities.md).

## Install

```bash
pnpm add @poopdeck.gl/maplibre maplibre-gl
# or
npm i @poopdeck.gl/maplibre maplibre-gl
```

`maplibre-gl` is a peer dependency, pinned **`^3 || ^4`**.

> **MapLibre v5 is not supported.** v5 replaced the custom layer's
> positional `render(gl, matrix)` signature with a single args object and
> changed the mercator matrix semantics (maplibre-gl-js#3854), which this
> adapter's render path does not handle — it expects the matrix and would
> draw nothing. Use maplibre-gl v4 for STT layers.

## Layer classes

Tiles whose geometry type doesn't match a given layer are skipped, so you can
pile multiple layers onto the same archive URL when a dataset has more than
one geometry type.

| Class             | Renders    | Notes                                                                             |
| ----------------- | ---------- | --------------------------------------------------------------------------------- |
| `STTPointLayer`   | Point      | Circular billboards with antialiased disc fragment shader                         |
| `STTLineLayer`    | LineString | Instanced segment quads, constant pixel width across zoom                         |
| `STTPolygonLayer` | Polygon    | Filled, earcut triangulated (or pre-baked triangles), optional stroke + extrusion |
| `STTTripsLayer`   | LineString | Trailing-fade trajectories using per-vertex timestamps                            |
| `STTHeatmapLayer` | Point      | Two-pass FBO density heatmap with colour-ramp lookup                              |

All extend the abstract `STTBaseLayer`, which owns the archive read, tileset
scheduling, viewport→tile resolution, and the GPU resource lifecycle.

## Quick start

```ts
import maplibregl from 'maplibre-gl';
import { STTPointLayer } from '@poopdeck.gl/maplibre';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [-122.4, 37.7],
  zoom: 6,
});

const sttLayer = new STTPointLayer({
  id: 'earthquakes',
  url: '/data/earthquakes/manifest.json',
  currentTime: Date.now(),
  timeWindow: 24 * 60 * 60 * 1000, // 1 day
  color: [0.99, 0.5, 0.2, 1.0],
  radius: 4,
});

map.on('load', () => map.addLayer(sttLayer));

// Drive the animation. autoRepaint is on by default, so setCurrentTime()
// will call map.triggerRepaint() for you.
setInterval(() => sttLayer.setCurrentTime(Date.now()), 16);
```

### Trips (trailing-fade trajectories)

```ts
import { STTTripsLayer } from '@poopdeck.gl/maplibre';

const trips = new STTTripsLayer({
  id: 'satellite-trips',
  url: '/data/satellites/manifest.json',
  currentTime: Date.parse('2024-01-01T00:00:00Z'),
  timeWindow: 30 * 60 * 1000,
  trailLength: 5 * 60 * 1000,
  color: [0.99, 0.5, 0.36, 1.0],
  width: 2,
});
map.addLayer(trips);
```

### Heatmap

```ts
import { STTHeatmapLayer } from '@poopdeck.gl/maplibre';

const heat = new STTHeatmapLayer({
  id: 'pickup-heat',
  url: '/data/taxi/manifest.json',
  currentTime: Date.parse('2024-01-01T18:00:00Z'),
  timeWindow: 30 * 60 * 1000,
  radiusPixels: 40,
  intensity: 1,
  weightProperty: 'passenger_count',
});
map.addLayer(heat);
```

### Playback governor wiring

The maplibre layers expose the same buffer-model hooks as the deck.gl
layers, so a [`PlaybackGovernor`](./playback-governor.md) (from
`@poopdeck.gl/playback`) can gate playback against them:

```ts
const layer = new STTTripsLayer({
  id: 'trips',
  url,
  currentTime,
  timeWindow,
  onTilesetReady: (tileset) => governor.setSource(tileset),
  onBufferChange: (runway) => governor.notifyBufferChange(runway),
});
// or later, pull-style:
const tileset = layer.getTileset(); // undefined until metadata resolves
```

## Options

### Shared (`STTBaseLayerOptions`)

| Field             | Type                               | Default                  | Description                                                                                                                                            |
| ----------------- | ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | `string`                           | —                        | Unique MapLibre layer id                                                                                                                               |
| `url`             | `string`                           | —                        | Archive URL                                                                                                                                            |
| `currentTime`     | `number`                           | —                        | Initial Unix-ms time                                                                                                                                   |
| `timeWindow`      | `number`                           | —                        | Full window in ms; features overlapping `[t - w/2, t + w/2]` are visible                                                                               |
| `autoRepaint`     | `boolean`                          | `true`                   | Call `map.triggerRepaint()` from `setCurrentTime`                                                                                                      |
| `maxRequests`     | `number`                           | `24`                     | Single concurrency knob: threaded into the archive's range coalescer as its in-flight HTTP Range ceiling (and the tileset's per-tile/prefetch fan-out) |
| `enablePrefetch`  | `boolean`                          | tileset default (`true`) | Predictive prefetch for animation                                                                                                                      |
| `prefetchAhead`   | `number`                           | tileset default (30 s)   | Lookahead in ms of sim time                                                                                                                            |
| `prefetchSteps`   | `number`                           | tileset default (4)      | Number of prefetch time buckets                                                                                                                        |
| `fadeInDuration`  | `number`                           | `0` (hard cut)           | Leading-edge alpha ramp (ms); an explicit value always wins over `softTimeWindow`                                                                      |
| `fadeOutDuration` | `number`                           | `0` (hard cut)           | Trailing-edge alpha ramp (ms); an explicit value always wins over `softTimeWindow`                                                                     |
| `softTimeWindow`  | `boolean`                          | `false`                  | Opt-in: `true` defaults both fades to 10 % of `timeWindow` (deck/three parity is the hard-cut default)                                                 |
| `onTilesetReady`  | `(tileset) => void`                | —                        | Fired once per archive init with the live tileset (satisfies the governor's `BufferSource` contract)                                                   |
| `onBufferChange`  | `(runway: BufferedRunway) => void` | —                        | Buffered-runway threshold events from the tileset's coverage index, forwarded as-is                                                                    |

### `STTPointLayer`

| Field                 | Type                    | Default                   | Description                                                                                                                                                                                                            |
| --------------------- | ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color`               | `[r, g, b, a]`          | `[0.31, 0.76, 0.97, 1.0]` | Constant fill colour. 0–1 floats or 0–255 ints — the range is auto-detected (any RGB channel > 1 ⇒ 0–255), so deck.gl-style colors port directly                                                                       |
| `colorProperty`       | `string`                | —                         | Categorical property → palette lookup                                                                                                                                                                                  |
| `colorPalette`        | `RGBA8[]`               | 10-stop categorical       | Palette for `colorProperty` (0–255)                                                                                                                                                                                    |
| `colorMapping`        | `Record<string, RGBA8>` | —                         | Keyed category-name → color map (deck/three parity): stable per-category colors regardless of per-tile dictionary order. Unmapped categories fall back to `colorMappingDefault`, then to the positional `colorPalette` |
| `colorMappingDefault` | `RGBA8`                 | —                         | Color for categories absent from `colorMapping`                                                                                                                                                                        |
| `radius`              | `number`                | `4`                       | Constant pixel radius                                                                                                                                                                                                  |
| `radiusProperty`      | `string`                | —                         | Numeric property name driving per-feature radius                                                                                                                                                                       |
| `radiusScale`         | `number`                | `1`                       | Multiplier on per-feature radius                                                                                                                                                                                       |

### `STTLineLayer`

| Field                                  | Type                              | Default                   | Description                                                                    |
| -------------------------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `color`                                | `[r, g, b, a]`                    | `[0.31, 0.76, 0.97, 1.0]` | Constant stroke colour (range auto-detected)                                   |
| `colorProperty`                        | `string`                          | —                         | Categorical property → palette lookup                                          |
| `colorPalette`                         | `RGBA8[]`                         | 10-stop categorical       | Palette for `colorProperty`                                                    |
| `colorMapping` / `colorMappingDefault` | `Record<string, RGBA8>` / `RGBA8` | —                         | Keyed category-name → color map + fallback (same semantics as `STTPointLayer`) |
| `width`                                | `number`                          | `2`                       | Constant pixel width                                                           |
| `widthProperty`                        | `string`                          | —                         | Numeric property driving per-feature width                                     |
| `widthScale`                           | `number`                          | `1`                       | Multiplier on per-feature width                                                |

### `STTPolygonLayer`

| Field                                  | Type                              | Default                  | Description                                                                    |
| -------------------------------------- | --------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `color`                                | `[r, g, b, a]`                    | `[0.99, 0.55, 0.2, 0.7]` | Constant fill colour (range auto-detected)                                     |
| `fillColorProperty`                    | `string`                          | —                        | Categorical fill property → palette lookup                                     |
| `colorPalette`                         | `RGBA8[]`                         | 10-stop categorical      | Palette for `fillColorProperty`                                                |
| `colorMapping` / `colorMappingDefault` | `Record<string, RGBA8>` / `RGBA8` | —                        | Keyed category-name → color map + fallback (same semantics as `STTPointLayer`) |
| `filled`                               | `boolean`                         | `true`                   | Render the polygon fill                                                        |
| `stroked`                              | `boolean`                         | `false`                  | Draw a stroked outline over each ring                                          |
| `lineColor`                            | `[r, g, b, a]`                    | `[0, 0, 0, 1]`           | Outline colour (used with `stroked`)                                           |
| `lineWidth`                            | `number`                          | `1`                      | Outline pixel width                                                            |
| `extruded`                             | `boolean`                         | `false`                  | Raise the top of the polygon to `elevation` and draw side walls                |
| `elevation`                            | `number \| string`                | `0`                      | Constant elevation, or numeric property name                                   |
| `altitudeScale`                        | `number`                          | `1e-7`                   | Converts elevation units → mercator-z                                          |

### `STTTripsLayer`

| Field           | Type           | Default                  | Description                                                                                                                                                        |
| --------------- | -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `color`         | `[r, g, b, a]` | `[0.99, 0.5, 0.36, 1.0]` | Constant trail colour (range auto-detected)                                                                                                                        |
| `colorProperty` | `string`       | —                        | Categorical trail colour property                                                                                                                                  |
| `colorPalette`  | `RGBA8[]`      | 5-stop categorical       | Palette for `colorProperty`                                                                                                                                        |
| `width`         | `number`       | `2`                      | Constant pixel width                                                                                                                                               |
| `widthProperty` | `string`       | —                        | Numeric property driving per-feature width                                                                                                                         |
| `widthScale`    | `number`       | `1`                      | Multiplier on per-feature width                                                                                                                                    |
| `trailLength`   | `number`       | `180_000`                | Trail length in ms                                                                                                                                                 |
| `fadeTrail`     | `boolean`      | `true`                   | Ramp alpha 1→0 across the trail age; `false` keeps the trail solid. Uploaded as the shared `trailFade` blend factor at `0`/`1`, matching core/deck/three semantics |

`STTTripsLayer` consumes `binary.vertexTimestamps` when present; otherwise it
interpolates between `startTimes` / `endTimes`.

### `STTHeatmapLayer`

| Field            | Type         | Default                                  | Description                                                                                                                        |
| ---------------- | ------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `radiusPixels`   | `number`     | `30`                                     | Splat radius in pixels                                                                                                             |
| `intensity`      | `number`     | `1`                                      | Per-point intensity multiplier                                                                                                     |
| `colorRange`     | `RGBA8[]`    | 7-stop OrRd                              | Density-low → density-high colour ramp                                                                                             |
| `weightProperty` | `string`     | —                                        | Numeric property name; defaults to 1 per point                                                                                     |
| `threshold`      | `number`     | `0.05`                                   | Hide pixels whose accumulated intensity is below this                                                                              |
| `colorDomain`    | `[min, max]` | archive's `heatmapDomain`, else `[0, 1]` | Pinned accumulated-intensity domain mapped onto the ramp (deck.gl `colorDomain` parity) — keeps weighted heatmaps from washing out |

## Methods

Each layer exposes lifecycle helpers in addition to `CustomLayerInterface`:

| Method                       | Description                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setCurrentTime(t: number)`  | Update the time the next frame's filter compares against                                                                                                                         |
| `setTimeWindow(ms: number)`  | Replace the time window                                                                                                                                                          |
| `setColor([r,g,b,a])`        | (Per-class) Update fill / stroke / trail colour                                                                                                                                  |
| `setRadius(px: number)`      | (Point, Heatmap) Update billboard / splat radius                                                                                                                                 |
| `setWidth(px: number)`       | (Line, Trips) Update stroke width                                                                                                                                                |
| `setTrailLength(ms: number)` | (Trips) Update the trail length                                                                                                                                                  |
| `setStroked(b: boolean)`     | (Polygon) Toggle the stroke pass. Rebuilds the per-tile GPU caches (stroke instance buffers are baked in at build time), so expect a one-off CPU re-triangulation cost on toggle |
| `setExtruded(b: boolean)`    | (Polygon) Toggle extrusion. Same cache rebuild as `setStroked`                                                                                                                   |
| `setColorRange(range)`       | (Heatmap) Replace the colour ramp                                                                                                                                                |
| `ready()`                    | `Promise<ArchiveMetadata>` resolved when the archive metadata is parsed                                                                                                          |
| `getTileset()`               | The live `SpatiotemporalTileset`, or `undefined` before metadata resolves (subscribe via `onTilesetReady` to avoid polling)                                                      |

## How it works

1. The constructor opens an `STTArchive` against the URL. No fetches happen yet.
2. MapLibre calls `onAdd(map, gl)` when the layer is added. The adapter
   compiles its shader, requests `archive.getMetadata()` asynchronously, and
   builds a [`SpatiotemporalTileset`](./spatiotemporal-tileset.md) configured
   with the archive's `minZoom` / `maxZoom` / `temporalBucketMs` — wiring the
   batched `getTiles` path, `getTileByteSize`, throughput, and buffer-change
   forwarding exactly like the deck.gl layer does.
3. On every frame MapLibre calls `render(gl, matrix)` (the v3/v4 signature).
   The adapter feeds the current viewport bounds + `currentTime` to the
   tileset, which decides which tiles to load / unload.
4. Each loaded tile is pre-projected to mercator unit-square coordinates _once_
   on the CPU, uploaded into a tile-scoped `WebGLBuffer` (with a cached VAO
   where available), and reused across frames. The window-mode time filter is
   a per-feature `[startTime, endTime]` pair compared against window uniforms
   in the vertex shader; trips mode uses per-vertex timestamps and a
   trail-length uniform; the heatmap layer renders points into an FBO
   additively, then samples it through a colour ramp on a full-screen quad.

## Compared to deck.gl

| Feature                                | `@poopdeck.gl/maplibre`                            | `@poopdeck.gl/layers`                             |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Point billboards                       | ✓                                                  | ✓                                                 |
| Line stroke (constant px)              | ✓                                                  | ✓                                                 |
| Filled polygons                        | ✓ (single-ring)                                    | ✓                                                 |
| Stroked / extruded polygons            | ✓                                                  | extruded ✓ (stroke: no)                           |
| Trip animation (per-vertex timestamps) | ✓                                                  | ✓                                                 |
| Heatmaps                               | ✓ (two-pass FBO)                                   | ✓ (`AnimatedHeatmapLayer`)                        |
| Per-feature categorical colour         | ✓ (CPU-expanded RGBA attribute)                    | ✓ (`CategoryColorExtension`, GPU palette texture) |
| Batched/coalesced tile loading         | ✓                                                  | ✓                                                 |
| PlaybackGovernor hooks                 | ✓ (`onTilesetReady`/`onBufferChange`/`getTileset`) | ✓                                                 |
| Rounded joints / caps                  | —                                                  | ✓                                                 |
| GPU picking                            | —                                                  | ✓                                                 |
| Globe projection                       | —                                                  | ✓ (GlobeView)                                     |
| Interleaves with MapLibre style layers | ✓                                                  | partially (overlay)                               |

## Limitations

- **MapLibre v5 unsupported** (see the install note above).
- **Single-ring polygons only.** Holes are not preserved in
  `BinaryFeatures` (see [Binary Features](./binary-features.md)); with
  pre-baked triangles (`--pre-tessellate`) hole-aware meshes draw
  correctly, but the runtime-earcut path treats each feature as one ring.
- **No picking.** MapLibre's `queryRenderedFeatures` doesn't reach into
  custom layers; you'd have to plumb pickable hit-testing yourself.
- **Categorical colours expand on the CPU.** Each tile builds a per-vertex
  RGBA buffer (Uint8 normalised); the deck.gl adapter does the lookup
  GPU-side via a palette texture. Hot-swapping palettes therefore requires
  re-uploading the colour attribute on the MapLibre side.
- **Polygon tiles need 32-bit indices above 65,535 vertices.** Only the
  polygon fill path uses element indices; WebGL2 supports `UNSIGNED_INT`
  natively, WebGL1 needs `OES_element_index_uint`. On a WebGL1 context
  without the extension, polygon tiles exceeding the cap are dropped with
  a console warning. Lines/trips/points are instanced or unindexed and
  unaffected.
- **Instancing required for lines/trips/polygon-stroke.** WebGL2 core, or
  `ANGLE_instanced_arrays` on WebGL1; where missing, those tiles are
  skipped with a warning.
- **No tile consolidation.** Each tile is one draw call (heatmap: one
  accumulate draw per tile + a fullscreen ramp draw). Bring `@poopdeck.gl/layers`
  if you need cross-tile consolidation for hundreds of tiles per frame.
- **Float32 mercator positions** cap usable zoom around z15 (~meter-scale
  quantization in dense city data); the deck.gl side is immune via its
  fp64 position split.

## Live demo

The repo's showcase app renders any supported dataset through this adapter
via the renderer toggle on each demo page — run `pnpm dev` from
`examples/showcase`.
