---
name: wiring-deckgl-layers
description: >-
  Render a SpatioTemporal Tiles dataset with deck.gl — choose the right STT layer
  for the data, set the time/tier/styling props, and build a @deck.gl/json spec.
  Use when a user wants to put a .stt on a deck.gl map, asks which layer to use for
  points/tracks/trips/polygons/flows/density, how to set currentTime/timeWindow/tier,
  color by a property, or compose a @deck.gl/json spec with STT layers. Pairs with
  the view_map MCP tool, which composes the spec for you.
license: MIT
metadata:
  version: '0.6.0'
---

# Wiring a deck.gl layer for STT data

`@poopdeck.gl/layers` ships one deck.gl layer per geometry/visual idiom, all built
on the `SpatioTemporalLayer` chassis (shared time/tier/prefetch props). Pick the
layer by what the data _is_ and how you want it to read.

> Not installed yet, or hitting a deck.gl/luma.gl peer-dependency error? See
> **installing-poopdeck** — `@poopdeck.gl/layers` needs the deck.gl 9.3.x peer set
> installed alongside it.

> **Doc paths** are repo-relative. With no repo on disk, use the MCP
> `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — full chain in **poopdeck-overview**.
> Everything load-bearing below is inlined.

**Version pin (must not guess):** `@poopdeck.gl/layers` peer-depends on deck.gl and
luma.gl on the **`9.3.x`** line (`>=9.3.0 <10.0.0`) across the repo. Install
`@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/json`, etc. from `9.3.x` — mismatched
majors are a common cause of a layer that never draws.

## Step 1 — Pick the layer (`@@type`)

| Data / intent                                                      | Layer `@@type`                                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Points / events                                                    | `AnimatedPointLayer` (`splat: true` for soft blobs)                                                                                                                                                |
| Static line features                                               | `AnimatedPathLayer`                                                                                                                                                                                |
| Moving objects with tails (GPS tracks, vehicles, trips)            | `AnimatedTripsLayer` (+ `AnimatedTripHeadsLayer` for lead markers)                                                                                                                                 |
| Polygons / areas                                                   | `AnimatedPolygonLayer`                                                                                                                                                                             |
| Origin→destination flows                                           | `FlowmapLayer`, `BundledFlowmapLayer`, `FlowCorridorLayer`, `FlowStrokeLayer`                                                                                                                      |
| Density / heat                                                     | `AnimatedHeatmapLayer`                                                                                                                                                                             |
| Pre-aggregated H3 / Quadbin summary tier                           | `H3SummaryLayer` / `QuadbinSummaryLayer`                                                                                                                                                           |
| Binned hex aggregation                                             | `AnimatedHexagonLayer`                                                                                                                                                                             |
| Arcs / lines / icons / columns / text / mesh / point-cloud / boxes | `AnimatedArcLayer`, `AnimatedLineLayer`, `AnimatedIconLayer`, `AnimatedColumnLayer`, `AnimatedTextLayer`, `AnimatedMeshLayer`, `AnimatedPointCloudLayer`, `AnimatedBoundingBoxLayer`, `SplatLayer` |

Not sure? `describe_dataset` → `styleHints.layer_hint` (`points`/`paths`/`trips`/
`polygons`) names the geometry the archive was built for. Or just call the
`view_map` MCP tool, which infers the `@@type` from that hint / summary scheme.

## Step 2 — Set the time + tier props (shared by every layer)

These come from the chassis, so they work on all layers above:

- `data` — the manifest URL (string) in a JSON spec; or an `STTArchive`/`{tiles,
accessToken}` object in code.
- `currentTime` — Unix ms; the playhead. **Must be inside the dataset's `timeRange`
  or nothing draws.**
- `timeWindow` — ms of data shown around `currentTime` (default `86_400_000` = 1 day).
- `timeRange` — clamp the visible span; `timeController` — bind a shared clock
  (drive it with `SttPlayer` / `usePlayback`, never by hand — **adding-playback**).
- `tier` — `'auto'` (default) | `'summary'` (force the coarse H3/Quadbin tier) |
  `'raw'` (force full-resolution features).
- `scrubLod` — `{ spatial?, spatialZoomDrop?, temporal? }` to drop detail while
  scrubbing (default `null` = off).
- prefetch/cache: `enablePrefetch` (default true), `prefetchAhead`, `maxCacheSize`,
  `maxCacheByteSize` — usually leave at defaults.
- `timeHeightScale`/`timeHeightOrigin` — lift features by time for a space-time cube.

## Step 3 — Style it

Per-family key props (all optional; sensible defaults exist):

- **AnimatedPointLayer**: `radius`/`getRadius`, `radiusUnits`, `fillColor`/
  `getFillColor`, `colorPalette` / `colorMapping` (categorical), `stroked`,
  `splat`.
- **AnimatedPathLayer**: `pathColor`/`getColor`, `pathWidth`/`getWidth`, `widthUnits`,
  `capRounded`, `elevationProperty`.
- **AnimatedTripsLayer**: `tripColor`/`getColor`, `tripWidth`, `trailLength` (ms,
  default 180000), `fadeTrail`, `gradientProperty`/`gradientDomain`/`gradientColorRamp`.
- **FlowmapLayer**: `sourceColor`/`targetColor`, `widthScale`, `widthMinPixels`/
  `widthMaxPixels`, `minFlow`, node radius props.
- **H3SummaryLayer / QuadbinSummaryLayer**: `weightProperty` (default `'count'`),
  `colorRange`, `colorDomain`, `extruded`/`elevationScale`, `stroked`/`filled`.
- **AnimatedHeatmapLayer**: `radiusPixels` (30), `weightProperty`/`getWeight`,
  `colorRange`, `colorDomain`, `intensity`, `threshold`, `channels` (per-category).

Color domains: prefer the archive's measured percentiles — `describe_dataset` →
`styleHints.properties[].suggestedDomain` — over hand-picked numbers.

Add behavior with extensions (in a spec, `"extensions": [{ "@@type": "..." }]`):
`TimeFilterExtension`, `DataFilterExtension`, `CategoryColorExtension`,
`CollisionFilterExtension`, `ChevronFlowExtension`, `SplatExtension`.

## Step 4 — Compose a `@deck.gl/json` spec (agent-friendly)

The `view_map` MCP tool emits exactly this. To instantiate STT layers from a JSON
spec, register the STT layer classes from `@poopdeck.gl/layers`:

```ts
import { JSONConfiguration, JSONConverter } from '@deck.gl/json';
import * as sttLayers from '@poopdeck.gl/layers';

const converter = new JSONConverter({
  configuration: new JSONConfiguration({ layers: sttLayers }), // STT layer classes
});
const { layers } = converter.convert({
  initialViewState: { longitude: -74, latitude: 40.7, zoom: 10 },
  layers: [
    {
      '@@type': 'AnimatedTripsLayer',
      id: 'trips',
      data: 'https://tiles.example.com/nyc-trips/manifest.json',
      currentTime: 1700000000000,
      timeWindow: 3600000,
      trailLength: 180000,
      tripColor: [253, 128, 93, 255],
    },
  ],
});
```

The catalog exposes the layers by class name (the `@@type` = the class
name). `data` in a JSON spec must be a manifest **URL string**.

## In code (not JSON)

```ts
import { AnimatedTripsLayer } from '@poopdeck.gl/layers';
new AnimatedTripsLayer({
  id: 'trips',
  data: manifestUrl,
  currentTime,
  timeWindow: 3600000,
  trailLength: 180000,
});
```

For non-deck backends see the **choosing-a-renderer** skill (`@poopdeck.gl/three`
WebGPU, `@poopdeck.gl/maplibre`, `@poopdeck.gl/cesium`).

Refs: `docs/api/spatiotemporal-layer.md`, per-layer `docs/api/animated-*-layer.md`,
`docs/api/h3-summary-layer.md`, `docs/api/quadbin-summary-layer.md`,
`docs/api/flowmap-layer.md`, `docs/api/extensions.md`,
`docs/architecture/deckgl-integration.md`.
