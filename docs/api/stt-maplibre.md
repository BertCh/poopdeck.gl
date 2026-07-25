# @poopdeck.gl/maplibre

A MapLibre GL custom-layer adapter for SpatioTemporal Tiles archives.

This package lets a vanilla MapLibre GL site consume STT archives without
pulling in deck.gl. It implements MapLibre's `CustomLayerInterface` and renders
STT tiles in raw WebGL, with the same archive reader and tileset scheduler the
deck.gl layers use under the hood — including the globally-coalesced batch
loading path (one range-coalesced request per viewport fill, incremental
per-tile delivery, giant-parent-tile gating, throughput-driven ETAs).

If you can take a deck.gl dependency, [`@poopdeck.gl/layers`](./spatiotemporal-layer.md)
still has a few advantages — rounded joints/dashes, GPU-side category-color
extension, cross-tile consolidation, GPU flow live-bundling, and the full
23-kind catalog. The MapLibre adapter trades those off for a much smaller bundle
and the ability to interleave between native MapLibre style layers. It covers
fifteen layer kinds across the point/line/polygon, trips, icon/column/arc,
summary and flow families (see the table below); the remaining deck-only kinds
(text, mesh, point cloud, bounding box, iso-lines, …) are listed in the
[backend capability matrix](../spec/backend-capabilities.md).

## Install

```bash
pnpm add @poopdeck.gl/maplibre maplibre-gl
# or
npm i @poopdeck.gl/maplibre maplibre-gl
```

`maplibre-gl` is a peer dependency, accepting **`^3 || ^4 || ^5 || ^6`**.
Mapbox GL JS `>=3.9.1` also works (mercator only — see [Mapbox](#mapbox)).

`h3-js` is an **optional** peer, needed only by `STTH3SummaryLayer` — it is not
bundled and nothing else imports it. That layer takes the boundary resolver
injected (`cellToBoundary`), so you decide whether to pull h3-js in.

The render path detects the host's custom-layer signature at runtime — v3/v4's
positional `render(gl, matrix)`, v4.6's added camera options, v5's
`CustomRenderMethodInput` args object, and v6's per-tile `getProjectionData` —
so the same layer code runs on every version.

> **Globe requires a v5+ MapLibre host.** On v5 and newer the layers inject
> MapLibre's own `shaderData.vertexShaderPrelude` and project through
> `projectTile`, so `map.setProjection({type: 'globe'})` renders STT data on the
> globe with geometry subdivided to the projection's granularity. On v3/v4 the
> layers use the legacy mercator matrix path and render flat, which is all those
> hosts expose to custom layers. **Mapbox globe is not supported** (deferred): a
> Mapbox host renders STT in mercator only, and at globe zooms the basemap's own
> globe→mercator transition covers most practical cases.

## Layer classes

Fifteen classes across four families. Tiles whose geometry type doesn't match a
given layer are skipped, so you can pile multiple layers onto the same archive
URL (or one `SharedTilesetSource`) when a dataset has more than one geometry
type.

**Core geometry**

| Class             | Renders    | Notes                                                                              |
| ----------------- | ---------- | ---------------------------------------------------------------------------------- |
| `STTPointLayer`   | Point      | Circular billboards with antialiased disc fragment shader                          |
| `STTLineLayer`    | LineString | Instanced segment quads, constant pixel width across zoom; progressive path reveal |
| `STTPolygonLayer` | Polygon    | Filled, earcut triangulated (or pre-baked triangles), optional stroke + extrusion  |
| `STTHeatmapLayer` | Point      | Two-pass FBO density heatmap with colour-ramp lookup                               |

**Motion & 3D**

| Class               | Renders    | Notes                                                                                      |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `STTTripsLayer`     | LineString | Trailing-fade trajectories using per-vertex timestamps                                     |
| `STTTripHeadsLayer` | LineString | Moving head dot, position interpolated through the hoisted core track kernel               |
| `STTIconLayer`      | Point      | Rotated billboard atlas with heading, `iconWake`, and CPU motion glide                     |
| `STTColumnLayer`    | Point      | Instanced 3D prisms with the space-time-cube lift (`timeHeightScale`)                      |
| `STTArcLayer`       | LineString | Real 3D origin→destination arcs, optionally great-circle, tessellated in the vertex shader |

**Summary tiers**

| Class                    | Renders | Notes                                                                                                   |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| `STTH3SummaryLayer`      | Point   | H3 summary-tier cells as ramp-coloured, optionally extruded prisms (takes an injected `cellToBoundary`) |
| `STTQuadbinSummaryLayer` | Point   | CARTO Quadbin summary-tier cells, same ramp/extrusion path as H3                                        |
| `STTHexbinLayer`         | Point   | Real runtime hexbin — CPU binning at tile upload + a GPU scatter/gather aggregate                       |

**Flow**

| Class                  | Renders    | Notes                                                                                        |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `STTFlowCorridorLayer` | LineString | Value-matrix flow ribbon whose width breathes off a single per-frame scalar                  |
| `STTFlowStrokeLayer`   | LineString | Constant-width flow-stroke variant of the corridor                                           |
| `STTFlowmapLayer`      | LineString | One animated OD arrow per pair; static bundles (GPU live-bundling stays a declared fallback) |

All extend the abstract `STTBaseLayer`, which owns the archive read, tileset
scheduling, viewport→tile resolution, and the GPU resource lifecycle. The two
summary subclasses share an abstract `STTSummaryCellLayer` base.

## Features

Beyond the raw geometry each layer supports, in step with the deck.gl backend:

- **Four time-filter modes** via `timeFilterMode` — `'window'` (default, the
  hard/soft `[t − w/2, t + w/2]` gate), `'wake'` (a fading trail behind the
  leading edge), `'cumulative'` (everything up to `t` stays lit) and `'trail'`
  (age-ramped). `STTTripsLayer` compiles trail + wake; `STTTripHeadsLayer`
  window + wake; the rest compile any of the four.
- **DataFilter** — `filterProperty` + `filterRange` / `filterSoftRange` /
  `filterEnabled` GPU-range a numeric column (deck `DataFilterExtension`
  parity). Every kind reads it; the branch compiles in only when
  `filterProperty` is set, and a tile missing the column renders unfiltered.
- **Metric sizing** — `radiusUnits: 'meters'` (point), `widthUnits: 'meters'`
  (line/trips) and polygon `elevation` in metres, each resolved at the tile's
  centre latitude. Screen-space approximation under pitch.
- **Picking** — synchronous id-FBO hit-testing (`layer.pick(cssX, cssY)`) on
  every kind **except `STTHeatmapLayer`** (a density pixel has no single feature
  behind it). `supportsPicking()` reports it per layer.
- **Stable colour mapping** — `colorMapping` / `colorMappingDefault` keep a
  category's colour constant across tiles regardless of per-tile dictionary
  order (point/line/polygon/trips/icon/column/arc/tripHeads and the flow family;
  the density and value-ramp kinds have no category).
- **Globe** on v5+ MapLibre hosts (see the callout above).
- **Shared tileset** — hand N layers one `SharedTilesetSource` so they share a
  single archive, tileset and governor `BufferSource` (see below).
- **Composite host** — `STTLayerGroup` drives N STT layers behind one custom
  layer, paying MapLibre's per-custom-layer state cycle once (see below).
- **Mapbox** — mercator + Standard-style `slot` support (see [Mapbox](#mapbox)).

Per-layer feature claims are machine-checked against the exported classes by the
backend descriptor (`maplibreLayerFeatures`), so this list can't over-claim.

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

## Shared tileset

By default each layer opens its own archive. When several layers read the **same**
`.stt` (a dataset with more than one geometry type, or a stack of styled passes),
hand them one `SharedTilesetSource` instead of a `url` so they share a single
archive, a single tileset, and a single governor `BufferSource` — no N-way
duplicate fetching, and honest buffer accounting for the governor:

```ts
import {
  SharedTilesetSource,
  STTPolygonLayer,
  STTPointLayer,
} from '@poopdeck.gl/maplibre';

const source = new SharedTilesetSource({ url: '/data/quakes/manifest.json' });
const fill = new STTPolygonLayer({
  id: 'quake-fill',
  source,
  currentTime,
  timeWindow,
});
const dots = new STTPointLayer({
  id: 'quake-dots',
  source,
  currentTime,
  timeWindow,
});

map.addLayer(fill);
map.addLayer(dots);

// Register the shared BufferSource with a governor ONCE per source, not per
// layer. getBufferSource() is null until the tileset resolves, so wait on load.
await source.load();
const bufferSource = source.getBufferSource();
if (bufferSource) governor.setSource(bufferSource);
// The source's lifetime is yours: dispose it after removing its layers.
```

Pass exactly one of `url` or `source` to a layer.

## Composite host (`STTLayerGroup`)

Every custom layer costs the map a full GL-state re-apply per frame. A composite
that stacks N STT layers (a weather suite, AV substrates) pays that cycle N
times. `STTLayerGroup` hosts an ordered list of STT layers behind **one** custom
layer, drives them in a single render pass, and coalesces their repaints — the
native analogue of deck's `MapboxLayerGroup`, with no deck/luma dependency:

```ts
import { STTLayerGroup } from '@poopdeck.gl/maplibre';

const group = new STTLayerGroup({
  id: 'weather',
  layers: [radar, wind, fronts],
});
group.attach(map); // survives setStyle diff-rebuilds; detach() removes
group.setCurrentTime(t); // fans out to every child behind ONE repaint
```

Children are added in **draw order** (later paints over earlier) and must not
also be added to the map individually — the group owns their lifecycle. Pair it
with a `SharedTilesetSource` when the children share one archive. `group.pick()`
hit-tests top-to-bottom and returns the first hit.

## Mapbox

The same build runs on **Mapbox GL JS `>=3.9.1`** (below that,
`queryRenderedFeatures` crashes with custom layers present). Mapbox renders
**mercator only** — globe is deferred (see the globe callout). Mapbox is a
secondary, structurally-typed target: no `mapbox-gl` runtime dependency is
added, and the host is duck-typed apart from MapLibre at attach time.

In the Mapbox Standard style you can place a layer (or a whole `STTLayerGroup`)
into a named `slot` via `attach`:

```ts
layer.attach(map, { slot: 'bottom' }); // 'bottom' | 'middle' | 'top'
```

`attach` is preferred over `map.addLayer` on any host: it installs a `styledata`
guard that re-adds the layer after a `setStyle` diff-fallback rebuild (which
silently destroys custom layers). On MapLibre, which has no slot concept, a
`slot` request is ignored with a one-time warning; use `beforeId` for ordering
there.

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

### Time filter & DataFilter (every layer)

Mixed into every layer's options. `timeFilterMode`'s accepted union is
per-layer (trips is `trail`/`wake`; tripHeads is `window`/`wake`; the rest take
all four).

| Field             | Type                                      | Default    | Description                                                                                  |
| ----------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `timeFilterMode`  | `'window'\|'wake'\|'cumulative'\|'trail'` | `'window'` | How the per-feature time gate is evaluated (see [Features](#features))                       |
| `filterProperty`  | `string`                                  | —          | Numeric column to GPU-range filter on; the filter branch compiles in only when this is set   |
| `filterRange`     | `[min, max]`                              | —          | Features outside the range are hidden; a tile missing the column renders unfiltered          |
| `filterSoftRange` | `[min, max]`                              | —          | Optional fade margin inside `filterRange` — values between the two ramp instead of hard-clip |
| `filterEnabled`   | `boolean`                                 | `true`     | Toggle the filter without dropping `filterProperty`/`filterRange`                            |

### `STTPointLayer`

| Field                 | Type                    | Default                   | Description                                                                                                                                                                                                            |
| --------------------- | ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color`               | `[r, g, b, a]`          | `[0.31, 0.76, 0.97, 1.0]` | Constant fill colour. 0–1 floats or 0–255 ints — the range is auto-detected (any RGB channel > 1 ⇒ 0–255), so deck.gl-style colors port directly                                                                       |
| `colorProperty`       | `string`                | —                         | Categorical property → palette lookup                                                                                                                                                                                  |
| `colorPalette`        | `RGBA8[]`               | 10-stop categorical       | Palette for `colorProperty` (0–255)                                                                                                                                                                                    |
| `colorMapping`        | `Record<string, RGBA8>` | —                         | Keyed category-name → color map (deck/three parity): stable per-category colors regardless of per-tile dictionary order. Unmapped categories fall back to `colorMappingDefault`, then to the positional `colorPalette` |
| `colorMappingDefault` | `RGBA8`                 | —                         | Color for categories absent from `colorMapping`                                                                                                                                                                        |
| `radius`              | `number`                | `4`                       | Constant radius, in `radiusUnits`                                                                                                                                                                                      |
| `radiusUnits`         | `'pixels' \| 'meters'`  | `'pixels'`                | `'meters'` sizes the disc in ground metres at the tile's centre latitude (deck parity)                                                                                                                                 |
| `radiusProperty`      | `string`                | —                         | Numeric property name driving per-feature radius                                                                                                                                                                       |
| `radiusScale`         | `number`                | `1`                       | Multiplier on per-feature radius                                                                                                                                                                                       |

### `STTLineLayer`

| Field                                  | Type                              | Default                   | Description                                                                          |
| -------------------------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `color`                                | `[r, g, b, a]`                    | `[0.31, 0.76, 0.97, 1.0]` | Constant stroke colour (range auto-detected)                                         |
| `colorProperty`                        | `string`                          | —                         | Categorical property → palette lookup                                                |
| `colorPalette`                         | `RGBA8[]`                         | 10-stop categorical       | Palette for `colorProperty`                                                          |
| `colorMapping` / `colorMappingDefault` | `Record<string, RGBA8>` / `RGBA8` | —                         | Keyed category-name → color map + fallback (same semantics as `STTPointLayer`)       |
| `width`                                | `number`                          | `2`                       | Constant width, in `widthUnits`                                                      |
| `widthUnits`                           | `'pixels' \| 'meters'`            | `'pixels'`                | `'meters'` sizes the stroke in ground metres at the tile's centre latitude           |
| `widthProperty`                        | `string`                          | —                         | Numeric property driving per-feature width                                           |
| `widthScale`                           | `number`                          | `1`                       | Multiplier on per-feature width                                                      |
| `revealTrail`                          | `boolean`                         | `false`                   | Progressive path reveal: draw each line up to an interpolated `currentTime` frontier |

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
| `altitudeScale`                        | `number`                          | `1`                      | Dimensionless exaggeration on `elevation` (see the note below)                 |

> **Breaking change (2026-07).** `elevation` is now interpreted in **metres**
> and converted with a latitude-correct metres→mercator-z factor, matching the
> conformal-z contract MapLibre documents for custom layers. `altitudeScale`
> used to carry that conversion as a hardcoded `1e-7` (which rendered
> extrusions roughly 4× too tall); it is now a plain exaggeration multiplier
> defaulting to `1`. If you previously passed `altitudeScale` to correct the
> height, drop it — pass `elevation` in real metres instead.

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

| Method                       | Description                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attach(map, opts?)`         | Add the layer with a `styledata` re-add guard (survives `setStyle` diff-rebuilds); `opts.beforeId` orders it, `opts.slot` targets a Mapbox Standard-style slot. Prefer over `map.addLayer` |
| `detach()`                   | Undo `attach` — disarm the guard and remove the layer                                                                                                                                      |
| `setCurrentTime(t: number)`  | Update the time the next frame's filter compares against                                                                                                                                   |
| `setTimeWindow(ms: number)`  | Replace the time window                                                                                                                                                                    |
| `setTimeFilterMode(mode)`    | Switch the time-filter mode (links a second program on first use of a mode)                                                                                                                |
| `pick(cssX, cssY)`           | Id-FBO hit-test at a CSS pixel → `SttPickResult \| null` (returns `null` on `STTHeatmapLayer`)                                                                                             |
| `supportsPicking()`          | `true` on every kind except heatmap                                                                                                                                                        |
| `setColor([r,g,b,a])`        | (Per-class) Update fill / stroke / trail colour                                                                                                                                            |
| `setRadius(px: number)`      | (Point, Heatmap) Update billboard / splat radius                                                                                                                                           |
| `setWidth(px: number)`       | (Line, Trips) Update stroke width                                                                                                                                                          |
| `setTrailLength(ms: number)` | (Trips) Update the trail length                                                                                                                                                            |
| `setStroked(b: boolean)`     | (Polygon) Toggle the stroke pass. Rebuilds the per-tile GPU caches (stroke instance buffers are baked in at build time), so expect a one-off CPU re-triangulation cost on toggle           |
| `setExtruded(b: boolean)`    | (Polygon) Toggle extrusion. Same cache rebuild as `setStroked`                                                                                                                             |
| `setColorRange(range)`       | (Heatmap) Replace the colour ramp                                                                                                                                                          |
| `ready()`                    | `Promise<ArchiveMetadata>` resolved when the archive metadata is parsed                                                                                                                    |
| `getTileset()`               | The live `SpatiotemporalTileset`, or `undefined` before metadata resolves (subscribe via `onTilesetReady` to avoid polling)                                                                |

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

| Feature                                   | `@poopdeck.gl/maplibre`                            | `@poopdeck.gl/layers`                             |
| ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Point billboards                          | ✓                                                  | ✓                                                 |
| Line stroke (constant px)                 | ✓                                                  | ✓                                                 |
| Filled polygons                           | ✓ (single-ring)                                    | ✓                                                 |
| Stroked / extruded polygons               | ✓                                                  | extruded ✓ (stroke: no)                           |
| Trip animation (per-vertex timestamps)    | ✓                                                  | ✓                                                 |
| Trip heads (moving head dot)              | ✓ (`STTTripHeadsLayer`)                            | ✓                                                 |
| Icon billboards (heading / wake / glide)  | ✓ (`STTIconLayer`)                                 | ✓                                                 |
| 3D columns (space-time cube)              | ✓ (`STTColumnLayer`, `timeHeightScale`)            | ✓                                                 |
| Arcs (3D / great-circle)                  | ✓ (`STTArcLayer`)                                  | ✓                                                 |
| Summary tiers (H3 / Quadbin cells)        | ✓ (ramp-coloured, optionally extruded)             | ✓                                                 |
| Runtime hexbin                            | ✓ (CPU bin + GPU aggregate)                        | ✓                                                 |
| Flow ribbons / OD flowmap                 | ✓ (value-matrix; static bundles)                   | ✓ (+ GPU live-bundling)                           |
| Heatmaps                                  | ✓ (two-pass FBO)                                   | ✓ (`AnimatedHeatmapLayer`)                        |
| Per-feature categorical colour            | ✓ (CPU-expanded RGBA attribute)                    | ✓ (`CategoryColorExtension`, GPU palette texture) |
| Batched/coalesced tile loading            | ✓                                                  | ✓                                                 |
| PlaybackGovernor hooks                    | ✓ (`onTilesetReady`/`onBufferChange`/`getTileset`) | ✓                                                 |
| Rounded joints / caps                     | —                                                  | ✓                                                 |
| GPU picking                               | ✓ (id-FBO; all kinds except heatmap)               | ✓                                                 |
| Time modes (window/wake/cumulative/trail) | ✓                                                  | ✓                                                 |
| Data filtering by column                  | ✓ (`filterProperty` + soft range)                  | ✓ (`STTDataFilterExtension`)                      |
| Globe projection                          | ✓ (v5+ hosts, native prelude)                      | ✓ (GlobeView)                                     |
| Interleaves with MapLibre style layers    | ✓                                                  | partially (overlay)                               |

## Limitations

- **Single-ring polygons only.** Holes are not preserved in
  `BinaryFeatures` (see [Binary Features](./binary-features.md)); with
  pre-baked triangles (`--pre-tessellate`) hole-aware meshes draw
  correctly, but the runtime-earcut path treats each feature as one ring.
- **Heatmaps are not pickable.** A density field has no per-feature
  identity; every other kind picks via an offscreen id buffer — a cell,
  corridor, or OD arrow is its own pick unit (`queryRenderedFeatures` never
  reaches custom layers in either library).
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
