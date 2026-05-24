# @stt/maplibre

A MapLibre GL custom-layer adapter for SpatioTemporal Tiles archives.

This package lets a vanilla MapLibre GL site consume `.stt` archives without
pulling in deck.gl. It implements MapLibre's `CustomLayerInterface` and renders
STT tiles in raw WebGL, with the same archive reader and tileset scheduler the
deck.gl layers use under the hood.

If you can take a deck.gl dependency, [`@stt/deck.gl`](./spatiotemporal-layer.md)
still has a few advantages — rounded joints/dashes, GPU picking, GPU-side
category-color extension, cross-tile consolidation. The MapLibre adapter trades
those off for a much smaller bundle and the ability to interleave between
native MapLibre style layers. It now covers every layer kind the deck.gl
adapter does: points, lines, polygons (with optional stroke + extrusion),
animated trips, and density heatmaps.

## Install

```bash
pnpm add @stt/maplibre maplibre-gl
# or
npm i @stt/maplibre maplibre-gl
```

`maplibre-gl` is a peer dependency; any v3 / v4 / v5 release works.

## Layer classes

Tiles whose geometry type doesn't match a given layer are skipped, so you can
pile multiple layers onto the same archive URL when a dataset has more than
one geometry type.

| Class | Renders | Notes |
|-------|---------|-------|
| `STTPointLayer` | Point | Circular billboards with antialiased disc fragment shader |
| `STTLineLayer` | LineString | Screen-space thick lines, constant pixel width across zoom |
| `STTPolygonLayer` | Polygon | Filled, earcut triangulated, optional stroke + extrusion |
| `STTTripsLayer` | LineString | Trailing-fade trajectories using per-vertex timestamps |
| `STTHeatmapLayer` | Point | Two-pass FBO density heatmap with colour-ramp lookup |

All extend the abstract `STTBaseLayer`, which owns the archive read, tileset
scheduling, viewport→tile resolution, and the GPU resource lifecycle.

## Quick start

```ts
import maplibregl from 'maplibre-gl';
import { STTPointLayer } from '@stt/maplibre';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [-122.4, 37.7],
  zoom: 6,
});

const sttLayer = new STTPointLayer({
  id: 'earthquakes',
  url: '/data/earthquakes.stt',
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
import { STTTripsLayer } from '@stt/maplibre';

const trips = new STTTripsLayer({
  id: 'satellite-trips',
  url: '/data/satellites.stt',
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
import { STTHeatmapLayer } from '@stt/maplibre';

const heat = new STTHeatmapLayer({
  id: 'pickup-heat',
  url: '/data/taxi.stt',
  currentTime: Date.parse('2024-01-01T18:00:00Z'),
  timeWindow: 30 * 60 * 1000,
  radiusPixels: 40,
  intensity: 1,
  weightProperty: 'passenger_count',
});
map.addLayer(heat);
```

## Options

### Shared (`STTBaseLayerOptions`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | — | Unique MapLibre layer id |
| `url` | `string` | — | Archive URL |
| `currentTime` | `number` | — | Initial Unix-ms time |
| `timeWindow` | `number` | — | Full window in ms; features overlapping `[t - w/2, t + w/2]` are visible |
| `autoRepaint` | `boolean` | `true` | Call `map.triggerRepaint()` from `setCurrentTime` |
| `maxRequests` | `number` | tileset default | Max in-flight tile requests |
| `enablePrefetch` | `boolean` | tileset default | Predictive prefetch for animation |
| `prefetchAhead` | `number` | tileset default | Lookahead in ms of sim time |
| `prefetchSteps` | `number` | tileset default | Number of prefetch time buckets |
| `fadeInDuration` | `number` | 10 % of `timeWindow` | Leading-edge alpha ramp (ms) |
| `fadeOutDuration` | `number` | 10 % of `timeWindow` | Trailing-edge alpha ramp (ms) |
| `softTimeWindow` | `boolean` | `true` | Legacy shortcut — `false` zeroes the fades |

### `STTPointLayer`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `color` | `[r, g, b, a]` 0–1 | `[0.31, 0.76, 0.97, 1.0]` | Constant fill colour |
| `colorProperty` | `string` | — | Categorical property → palette lookup |
| `colorPalette` | `RGBA8[]` | 10-stop categorical | Palette for `colorProperty` (0–255) |
| `radius` | `number` | `4` | Constant pixel radius |
| `radiusProperty` | `string` | — | Numeric property name driving per-feature radius |
| `radiusScale` | `number` | `1` | Multiplier on per-feature radius |

### `STTLineLayer`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `color` | `[r, g, b, a]` 0–1 | `[0.31, 0.76, 0.97, 1.0]` | Constant stroke colour |
| `colorProperty` | `string` | — | Categorical property → palette lookup |
| `colorPalette` | `RGBA8[]` | 10-stop categorical | Palette for `colorProperty` |
| `width` | `number` | `2` | Constant pixel width |
| `widthProperty` | `string` | — | Numeric property driving per-feature width |
| `widthScale` | `number` | `1` | Multiplier on per-feature width |

### `STTPolygonLayer`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `color` | `[r, g, b, a]` 0–1 | `[0.99, 0.55, 0.2, 0.7]` | Constant fill colour |
| `fillColorProperty` | `string` | — | Categorical fill property → palette lookup |
| `colorPalette` | `RGBA8[]` | 10-stop categorical | Palette for `fillColorProperty` |
| `filled` | `boolean` | `true` | Render the polygon fill |
| `stroked` | `boolean` | `false` | Draw a stroked outline over each ring |
| `lineColor` | `[r, g, b, a]` 0–1 | `[0, 0, 0, 1]` | Outline colour (used with `stroked`) |
| `lineWidth` | `number` | `1` | Outline pixel width |
| `extruded` | `boolean` | `false` | Raise the top of the polygon to `elevation` and draw side walls |
| `elevation` | `number \| string` | `0` | Constant elevation, or numeric property name |
| `altitudeScale` | `number` | `1e-7` | Converts elevation units → mercator-z |

### `STTTripsLayer`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `color` | `[r, g, b, a]` 0–1 | `[0.99, 0.5, 0.36, 1.0]` | Constant trail colour |
| `colorProperty` | `string` | — | Categorical trail colour property |
| `colorPalette` | `RGBA8[]` | 5-stop categorical | Palette for `colorProperty` |
| `width` | `number` | `2` | Constant pixel width |
| `widthProperty` | `string` | — | Numeric property driving per-feature width |
| `widthScale` | `number` | `1` | Multiplier on per-feature width |
| `trailLength` | `number` | `180_000` | Trail length in ms |
| `fadeTrail` | `boolean` | `true` | Ramp alpha 1→0 across the trail age (vs. constant alpha) |

`STTTripsLayer` consumes `binary.vertexTimestamps` when present; otherwise it
interpolates between `startTimes` / `endTimes`.

### `STTHeatmapLayer`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `radiusPixels` | `number` | `30` | Splat radius in pixels |
| `intensity` | `number` | `1` | Per-point intensity multiplier |
| `colorRange` | `RGBA8[]` | 7-stop OrRd | Density-low → density-high colour ramp |
| `weightProperty` | `string` | — | Numeric property name; defaults to 1 per point |
| `threshold` | `number` | `0.05` | Hide pixels whose accumulated intensity is below this |

## Methods

Each layer exposes lifecycle helpers in addition to `CustomLayerInterface`:

| Method | Description |
|--------|-------------|
| `setCurrentTime(t: number)` | Update the time the next frame's filter compares against |
| `setTimeWindow(ms: number)` | Replace the time window |
| `setColor([r,g,b,a])` | (Per-class) Update fill / stroke / trail colour |
| `setRadius(px: number)` | (Point) Update billboard radius |
| `setWidth(px: number)` | (Line, Trips) Update stroke width |
| `setTrailLength(ms: number)` | (Trips) Update the trail length |
| `setStroked(b: boolean)` | (Polygon) Toggle the stroke pass |
| `setExtruded(b: boolean)` | (Polygon) Toggle extrusion |
| `setColorRange(range)` | (Heatmap) Replace the colour ramp |
| `ready()` | `Promise<ArchiveMetadata>` resolved when the archive header is parsed |

## How it works

1. The constructor opens an `STTArchive` against the URL. No fetches happen yet.
2. MapLibre calls `onAdd(map, gl)` when the layer is added. The adapter
   compiles its shader, requests `archive.getMetadata()` asynchronously, and
   builds a `SpatiotemporalTileset` configured with the archive's
   `minZoom` / `maxZoom` / `temporalBucketMs`.
3. On every frame MapLibre calls `render(gl, matrix)`. The adapter feeds the
   current viewport bounds + `currentTime` to the tileset, which decides which
   tiles to load / unload.
4. Each loaded tile is pre-projected to mercator unit-square coordinates *once*
   on the CPU, uploaded into a tile-scoped `WebGLBuffer`, and reused across
   frames. The window-mode time filter is a per-feature `[startTime, endTime]`
   pair compared against window uniforms in the vertex shader; trips mode
   uses per-vertex timestamps and a trail-length uniform; the heatmap layer
   renders points into an FBO additively, then samples it through a colour
   ramp on a full-screen quad.

## Compared to deck.gl

| Feature | `@stt/maplibre` | `@stt/deck.gl` |
|---------|-----------------|----------------|
| Point billboards | ✓ | ✓ |
| Line stroke (constant px) | ✓ | ✓ |
| Filled polygons | ✓ (single-ring) | ✓ |
| Stroked / extruded polygons | ✓ | ✓ |
| Trip animation (per-vertex timestamps) | ✓ | ✓ |
| Heatmaps | ✓ (two-pass FBO) | ✓ (`HeatmapLayer`) |
| Per-feature categorical colour | ✓ (CPU-expanded RGBA attribute) | ✓ (`CategoryColorExtension`, GPU palette texture) |
| Rounded joints / caps | — | ✓ |
| GPU picking | — | ✓ |
| Cross-tile consolidation | — | ✓ |
| Bundle size (peer-min) | ~35 kB gzipped | ~250 kB gzipped (with deck.gl) |
| Interleaves with MapLibre style layers | ✓ | partially (overlay) |

## Limitations

- **Single-ring polygons only.** Holes are not yet supported. The current
  `stt-build` pipeline emits single-ring polygons so the limitation hasn't
  bitten us in practice.
- **No picking.** MapLibre's `queryRenderedFeatures` doesn't reach into
  custom layers; you'd have to plumb pickable hit-testing yourself.
- **Categorical colours expand on the CPU.** Each tile builds a per-vertex
  RGBA buffer (Uint8 normalised); the deck.gl adapter does the lookup
  GPU-side via a palette texture. Hot-swapping palettes therefore requires
  re-uploading the colour attribute on the MapLibre side.
- **WebGL1 fallback only for ≤ 65 535 vertices per tile.** Lines and polygons
  that triangulate above that threshold need 32-bit indices, which require
  WebGL2 or the `OES_element_index_uint` extension. The adapter probes for
  the extension on `onAdd` and drops tiles that exceed the cap when it isn't
  available, with a console warning.
- **No tile consolidation.** Each tile is one draw call (heatmap is
  one draw call per tile in the accumulation pass, then a fullscreen ramp
  draw). Fine for the scaffold; bring `@stt/deck.gl` if you need
  cross-tile consolidation for hundreds of tiles per frame.

## Live demo

The repo's showcase app has a `/maplibre/:datasetId` route that renders any
supported dataset through this adapter — run `pnpm dev` from
`examples/showcase` and click "MapLibre Demo" in the sidebar.
