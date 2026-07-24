# Spatiotemporal Tiles Documentation

Spatiotemporal Tiles (STT) is a cloud-native, edge-cacheable tile format for
visualizing large time-variant geospatial datasets.

The showcase app (`examples/showcase`) runs it all locally: a gallery of
real-dataset demos at `/demos`, this documentation at `/docs`, the AV LIDAR
cockpit at `/drive`, and an ocean-drifter data story at `/story/drifters`.

## Introduction

- [Concepts](./intro/concepts.md) — spatiotemporal tiling, the packed container,
  temporal LOD, blob ordering, the streaming render model.
- [Choosing a layer & backend](./intro/choosing.md) — which layer fits your data
  shape, which renderer fits your stack.

## Architecture

- [System overview](./architecture/system-overview.md) — the Rust build tools and
  the TypeScript reader + render stack that streams tiles into deck.gl, Three.js,
  MapLibre, or Cesium.
- [Packed format](./spec/stt-packed-format.md) — the canonical container:
  `manifest.json`, content-addressed packs, the directory, and the
  immutable-object caching model. Schema:
  [`manifest.schema.json`](./spec/manifest.schema.json).
- [Tile payload](./architecture/data-format.md) — normative spec of the tile
  payload (Apache Arrow IPC with GeoArrow geometry), including the space-time
  cube (`vertex_value_matrix`).
- [Time model](./spec/time-model.md) — Unix-ms UTC, instants vs intervals,
  fixed-width start-anchored buckets, temporal LOD, read-time pruning, and the
  OGC TMS mapping ([`tile-matrix-set.json`](./spec/tile-matrix-set.json)).
- [Sidecar assets](./spec/sidecar-assets.md) — the scene-bundle profile:
  multi-stream bundles, non-tile sidecars, and `georeferenced` vs
  `anchored-local` frames. Schema:
  [`scene.schema.json`](./spec/scene.schema.json).
- [Conformance](./spec/conformance.md) — what a conformant reader/writer must do,
  the golden fixtures, and the `stt-validate` reference validator.
- [`stt-serve` protocol](./spec/stt-serve-protocol.md) — routes, status codes,
  response headers, and the `/metadata.json` descriptor.
- [Backend capability matrix](./spec/backend-capabilities.md) — generated
  cross-backend table of render traits, capabilities, and time-filter modes,
  regenerated from each backend's
  [`BackendDescriptor`](./api/backend-descriptor.md).
- [deck.gl integration](./architecture/deckgl-integration.md) — how
  `@poopdeck.gl/layers` relates to `TileLayer`, and where it departs.

## API Reference

### deck.gl layers

Every animated layer extends `SpatioTemporalLayer`, which streams STT tiles into
a deck.gl sublayer.

- [SpatioTemporalLayer](./api/spatiotemporal-layer.md) — the base class: tile
  lifecycle, time wiring, binary-attribute plumbing.

**Core — points / paths / polygons / 3D**

- [AnimatedPointLayer](./api/animated-point-layer.md) — animated points, with
  window / wake / cumulative modes.
- [AnimatedPathLayer](./api/animated-path-layer.md) — trajectories with
  window-mode fade.
- [AnimatedPolygonLayer](./api/animated-polygon-layer.md) — polygons, optionally
  extruded.
- [AnimatedColumnLayer](./api/animated-column-layer.md) — 3D columns.
- [AnimatedIconLayer](./api/animated-icon-layer.md) — directional markers with
  heading rotation.
- [AnimatedBoundingBoxLayer](./api/animated-bounding-box-layer.md) — oriented 3D
  boxes for tracked objects.
- [SplatLayer](./api/splat-layer.md) — LIDAR point clouds as oriented anisotropic
  Gaussian surfels, no per-frame sort.
- [AnimatedPointCloudLayer](./api/animated-point-cloud-layer.md) — time-windowed
  3D point clouds with optional per-point RGBA.
- [AnimatedMeshLayer](./api/animated-mesh-layer.md) — glTF/OBJ meshes
  interpolated along per-object tracks.
- [AnimatedTextLayer](./api/animated-text-layer.md) — time-filtered map labels.

**Trips**

- [AnimatedTripsLayer](./api/animated-trips-layer.md) — trailing ribbons with
  per-vertex timestamps.
- [AnimatedTripHeadsLayer](./api/animated-trip-heads-layer.md) — a moving dot at
  the head of each active trip.

**OD & flow**

- [AnimatedArcLayer](./api/animated-arc-layer.md) — per-trip origin→destination
  arcs.
- [AnimatedLineLayer](./api/animated-line-layer.md) — the flat sibling of the arc
  layer.
- [FlowmapLayer](./api/flowmap-layer.md) — flowmap.gl-style tapered arrows plus
  node circles.
- [FlowLinesLayer](./api/flow-lines-layer.md) — the tapered-arrow primitive
  behind it.
- [BundledFlowmapLayer](./api/bundled-flowmap-layer.md) — flowmap with baked or
  GPU edge bundling.
- [FlowCorridorLayer](./api/flow-corridor-layer.md) — static network whose
  per-segment color pulses over a time series.
- [FlowStrokeLayer](./api/flow-stroke-layer.md) — merged directed corridors with
  tapering width and twin-ribbon offsets.

**Summary tiers**

- [AnimatedHeatmapLayer](./api/heatmap-time-layer.md) — temporal heatmap with
  stacked categorical channels.
- [H3SummaryLayer](./api/h3-summary-layer.md) — server-aggregated H3 tier as
  hexagons.
- [QuadbinSummaryLayer](./api/quadbin-summary-layer.md) — server-aggregated
  Quadbin tier.
- [AnimatedHexagonLayer](./api/animated-hexagon-layer.md) — GPU-binned hexagon
  aggregation, the discrete sibling of the heatmap.

### Extensions

- [TimeFilterExtension](./api/time-filter-extension.md) — GPU temporal filtering
  and time-as-height for any deck.gl layer.
- [CategoryColorExtension](./api/category-color-extension.md) — GPU categorical
  color via a palette texture.
- [ChevronFlowExtension](./api/chevron-flow-extension.md) — marching chevrons
  over any `PathLayer`-derived layer.
- [SplatExtension](./api/splat-extension.md) — gaussian falloff turning
  `ScatterplotLayer` points into soft splats.
- [DataFilterExtension](./api/data-filter-extension.md) — range-filter instances
  by a baked numeric column.
- [CollisionFilterExtension](./api/collision-filter-extension.md) — hide
  colliding labels and icons by priority.
- [deck.gl extensions on STT layers](./api/extensions.md) — which stock
  extensions work as-is, which two are adapted, and which three are skipped.

### Playback (`@poopdeck.gl/playback`)

- [SttPlayer](./api/stt-player.md) — HTMLMediaElement-style facade over the clock
  and governor; the recommended entry point.
- [TimeController](./api/time-controller.md) — the animation clock shared across
  layers.
- [PlaybackGovernor](./api/playback-governor.md) — buffering state machine that
  gates the clock on a buffered runway.

### Reader (`@poopdeck.gl/core`)

- [Tile decoding](./api/stt-loader.md) — the `TileDecoder` interface plus the
  inline and worker-pool implementations.
- [SpatiotemporalTileset](./api/spatiotemporal-tileset.md) — tile lifecycle,
  viewport + time-aware selection, prefetching.
- [Binary features](./api/binary-features.md) — the GPU-ready columnar format
  `TileDecoder` returns.

### Render kernel (`@poopdeck.gl/core`)

- [Render kernel](./api/render-kernel.md) — the framework-free `core/*` sub-paths
  every renderer backend imports instead of hand-forking: time-filter,
  shader-codegen, style, geometry, geo, picking, tileset-adapter, capabilities.

### Renderer backends

- [`@poopdeck.gl/react`](./api/stt-react.md) — React playback hooks and UI:
  `usePlayback`, `usePlaybackHotkeys`, `PlaybackControls`, `HoverPreview`.
- [`@poopdeck.gl/three`](./api/stt-three.md) — Three.js + TSL (WebGPU, WebGL2
  fallback) with mercator, globe, and local-ENU-metric projections, plus a
  react-three-fiber binding.
- [`@poopdeck.gl/maplibre`](./api/stt-maplibre.md) — MapLibre GL custom-layer
  adapter: fifteen layer classes, a composite host, and a Mapbox target, for
  sites that don't want a deck.gl dependency.
- [`@poopdeck.gl/cesium`](./api/stt-cesium.md) — CesiumJS on a real WGS84 globe:
  the movement layer catalog plus the `ViewState`⇄camera bridge and clock hook.

### CLI tools

- [CLI reference](./api/cli-reference.md) — `stt-build`, `stt-generate`,
  `stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve`.

## Guides

- [From CSV to an animated map](./guides/csv-quickstart.md) — **start here.**
  The fastest end-to-end path on published packages: CSV → DuckDB one-liner →
  `stt-build --auto` → an animated deck.gl map in a Vite + React app.
- [Data generation](./guides/data-generation.md) — building datasets with
  `stt-generate` for the bundled showcase sets, or `stt-build` for your own
  GeoParquet.
- [Building from Python](./guides/python.md) — GeoPandas, DuckDB, and pyarrow
  recipes for getting data into GeoParquet.
- [Deploying a dataset](./guides/deploying.md) — R2 / S3 / GCS / nginx: the two
  Cache-Control regimes, the CDN cache rule immutable packs need, CORS for Range
  requests, the copy-never-delete rule.
- [Tuning your tiles](./guides/tuning-tiles.md) — the measure → interpret →
  decide loop with `stt-optimize`: `analyze`/`recommend`, `--auto`, `inspect`,
  `doctor`, and `diff` — shrinking bytes without dropping or degrading data.

## AI Suite

- [AI Suite (MCP + Skills)](./guides/ai-suite.md) — the `poopdeck-ai` plugin
  (`@poopdeck.gl/mcp` server + Agent Skills), install, worked flows, and the
  security model.
- [`@poopdeck.gl/mcp`](./api/stt-mcp.md) — MCP server reference: the `stt-mcp`
  command, the discovery / analysis / interactive / execution tools, dataset
  resources, and the `--allow-cli` safety model.
