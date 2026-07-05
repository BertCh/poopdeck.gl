# Spatiotemporal Tiles Documentation

Welcome to the documentation for Spatiotemporal Tiles (STT), a cloud-native,
edge-cacheable tile format for visualizing massive time-variant geospatial
datasets.

To see it all live, run the showcase app (`examples/showcase`): a gallery of
dozens of real-dataset demos (`/demos`), this documentation rendered at
`/docs`, the AV LIDAR cockpit (`/drive`), and a scrollytelling ocean-drifter
story (`/story/drifters`).

## Introduction

- [**Concepts**](./intro/concepts.md): Spatiotemporal tiling, the packed
  container, temporal LOD, blob ordering, and the streaming render model.
- [**Choosing a layer & backend**](./intro/choosing.md): Which layer fits your
  data shape, and which renderer backend (deck.gl / Three / MapLibre / Cesium)
  fits your stack.

## Architecture

- [**System Overview**](./architecture/system-overview.md): High-level look
  at the Rust generation tools and the TypeScript reader + render stack, which
  streams tiles into one of four renderer backends — deck.gl, Three.js,
  MapLibre, or Cesium.
- [**Packed format**](./spec/stt-packed-format.md): The canonical container —
  `manifest.json` + content-addressed packs + directory, and the immutable-object
  caching model. Machine-checkable manifest schema: [`manifest.schema.json`](./spec/manifest.schema.json).
- [**Tile payload**](./architecture/data-format.md): Normative spec of the tile
  payload (Apache Arrow IPC + GeoArrow), shared across containers, including the
  space-time cube (`vertex_value_matrix`).
- [**Time model**](./spec/time-model.md): The temporal axis — Unix-ms UTC, instants
  vs intervals, fixed-width start-anchored buckets, temporal LOD, read-time pruning,
  and the OGC TMS mapping ([`tile-matrix-set.json`](./spec/tile-matrix-set.json)).
- [**Sidecar assets**](./spec/sidecar-assets.md): The scene-bundle profile —
  multi-stream bundles, non-tile sidecars, and `georeferenced` vs `anchored-local`
  frames. Machine-checkable [`scene.schema.json`](./spec/scene.schema.json).
- [**Conformance**](./spec/conformance.md): What a conformant reader/writer
  MUST/SHOULD do, the golden fixtures, and the `stt-validate` reference validator.
- [**`stt-serve` protocol**](./spec/stt-serve-protocol.md): The HTTP surface of
  the dynamic per-request tile server — routes, status codes, response
  headers, and the `/metadata.json` descriptor.
- [**Backend capability matrix**](./spec/backend-capabilities.md): Generated
  cross-backend table of the render traits, capabilities, and time-filter
  modes each of the four renderer backends supports, regenerated from each
  backend's [`BackendDescriptor`](./api/backend-descriptor.md).
- [**deck.gl Integration**](./architecture/deckgl-integration.md): How
  `@poopdeck.gl/layers` relates to TileLayer, and where it deliberately departs.

## API Reference

### deck.gl Layers

Every animated layer extends **SpatioTemporalLayer**, which streams STT tiles
into a deck.gl sublayer.

- [**SpatioTemporalLayer**](./api/spatiotemporal-layer.md): Base class used by
  every layer below — tile lifecycle, time wiring, and binary-attribute plumbing.

**Core — points / paths / polygons / 3D**

- [**AnimatedPointLayer**](./api/animated-point-layer.md): Animated points
  (billboards), with window / wake / cumulative modes.
- [**AnimatedPathLayer**](./api/animated-path-layer.md): Animated paths /
  trajectories with window-mode fade.
- [**AnimatedPolygonLayer**](./api/animated-polygon-layer.md): Animated polygons
  with optional extrusion.
- [**AnimatedColumnLayer**](./api/animated-column-layer.md): Time-animated 3D
  columns / bars.
- [**AnimatedIconLayer**](./api/animated-icon-layer.md): Directional icon markers
  with heading rotation.
- [**AnimatedBoundingBoxLayer**](./api/animated-bounding-box-layer.md): Oriented
  3D boxes for tracked objects (the AV-cockpit overlay).
- [**SplatLayer**](./api/splat-layer.md): Point clouds (LIDAR) as oriented
  anisotropic Gaussian surfels — elliptical disks in the surface frame with a
  soft temporal Gaussian weight, no per-frame sort.
- [**AnimatedPointCloudLayer**](./api/animated-point-cloud-layer.md): Time-windowed
  3D point clouds (LIDAR) on deck.gl's `PointCloudLayer`, with optional per-point RGBA.
- [**AnimatedMeshLayer**](./api/animated-mesh-layer.md): Animated glTF/OBJ mesh
  instances interpolated along per-object tracks (the AV-cockpit `objects/` overlay).
- [**AnimatedTextLayer**](./api/animated-text-layer.md): Time-filtered map labels
  with categorical color, background, and SDF outlines.

**Trips**

- [**AnimatedTripsLayer**](./api/animated-trips-layer.md): "Vehicle moving along
  route" trails with per-vertex timestamps.
- [**AnimatedTripHeadsLayer**](./api/animated-trip-heads-layer.md): A smooth
  moving dot at the head of each active trip (CPU-interpolated on a stock
  ScatterplotLayer).

**OD & flow**

- [**AnimatedArcLayer**](./api/animated-arc-layer.md): Per-trip origin→destination
  arcs (window mode, no aggregation).
- [**AnimatedLineLayer**](./api/animated-line-layer.md): The flat sibling of the
  arc layer.
- [**FlowmapLayer**](./api/flowmap-layer.md): flowmap.gl-style animated OD
  flowmap — tapered arrows sized by volume plus node circles.
- [**FlowLinesLayer**](./api/flow-lines-layer.md): The tapered-arrow primitive
  FlowmapLayer renders.
- [**BundledFlowmapLayer**](./api/bundled-flowmap-layer.md): Flowmap with baked /
  GPU edge bundling.
- [**FlowCorridorLayer**](./api/flow-corridor-layer.md): Static corridor network
  whose per-segment color pulses over a time series.
- [**FlowStrokeLayer**](./api/flow-stroke-layer.md): Merged, directed flow
  corridors whose width tapers along each path and pulses with traveller
  volume, with twin-ribbon offsets for opposing directions.

**Summary tiers**

- [**AnimatedHeatmapLayer**](./api/heatmap-time-layer.md): Temporal heatmap built
  on deck.gl's aggregation layers, with stacked categorical channels.
- [**H3SummaryLayer**](./api/h3-summary-layer.md): Server-aggregated H3 summary
  tier rendered as hexagons.
- [**QuadbinSummaryLayer**](./api/quadbin-summary-layer.md): Server-aggregated
  Quadbin (quadkey) summary tier.
- [**AnimatedHexagonLayer**](./api/animated-hexagon-layer.md): GPU-binned,
  optionally-extruded hexagon aggregation of time-filtered points — the discrete
  sibling of AnimatedHeatmapLayer.

### Extensions

- [**TimeFilterExtension**](./api/time-filter-extension.md): GPU temporal
  filtering (and time-as-height) for any deck.gl layer.
- [**CategoryColorExtension**](./api/category-color-extension.md): GPU
  categorical color lookup via a palette texture.
- [**ChevronFlowExtension**](./api/chevron-flow-extension.md): Fragment-shader
  marching chevrons overlaying directional flow on any `PathLayer`-derived
  layer.
- [**SplatExtension**](./api/splat-extension.md): Fragment-shader gaussian
  falloff turning `ScatterplotLayer` points into soft splats; powers
  `AnimatedPointLayer`'s `splat` prop.
- [**DataFilterExtension**](./api/data-filter-extension.md): Range-filter (and
  soft-fade) instances by a baked numeric column — a poopdeck-native port of
  deck.gl's DataFilterExtension.
- [**CollisionFilterExtension**](./api/collision-filter-extension.md): Hide
  colliding instances (overlapping labels / icons) by priority.
- [**deck.gl extensions on STT layers**](./api/extensions.md): which stock
  deck extensions (Brushing/Mask/Clip/PathStyle) work as-is via the
  `extensions` prop, the two adapted ones (DataFilter/Collision), and the
  three skipped — with reasons.

### Playback (`@poopdeck.gl/playback`)

- [**SttPlayer**](./api/stt-player.md): HTMLMediaElement-style facade over the
  clock + governor — the high-level entry point.
- [**TimeController**](./api/time-controller.md): Animation playback clock shared
  across layers.
- [**PlaybackGovernor**](./api/playback-governor.md): Buffering state machine
  that gates the clock on a buffered runway (stall/resume, seek gates, Auto speed).

### Reader (`@poopdeck.gl/core`)

- [**Tile decoding**](./api/stt-loader.md): The `TileDecoder` interface plus the
  inline / worker-pool implementations.
- [**SpatiotemporalTileset**](./api/spatiotemporal-tileset.md): Tile lifecycle,
  viewport + time-aware selection, and prefetching.
- [**Binary Features**](./api/binary-features.md): The GPU-ready columnar format
  `TileDecoder` returns.

### Render kernel (`@poopdeck.gl/core`)

- [**Render Kernel**](./api/render-kernel.md): The framework-free `core/time-filter`,
  `core/shader-codegen`, `core/style`, `core/geometry`, `core/geo`, `core/picking`,
  `core/tileset-adapter`, and `core/capabilities` sub-paths every renderer backend
  (deck / three / maplibre / Cesium) imports instead of hand-forking.

### React adapter (`@poopdeck.gl/react`)

- [**@poopdeck.gl/react**](./api/stt-react.md): React playback hooks + UI
  controls — `usePlayback`, `usePlaybackHotkeys`, `PlaybackControls`, and the
  `HoverPreview` scrubber thumbnail.

### Three.js renderer (`@poopdeck.gl/three`)

- [**@poopdeck.gl/three**](./api/stt-three.md): Three.js + TSL (WebGPU,
  WebGL2-fallback) renderer with mercator, globe, and local-ENU-metric
  projections — the AV LIDAR cockpit's oriented Gaussian surfels, plus a
  react-three-fiber binding at `/r3f`.

### MapLibre adapter

- [**@poopdeck.gl/maplibre**](./api/stt-maplibre.md): MapLibre GL custom-layer
  adapter — five layer classes (point / line / polygon / trips / heatmap)
  for sites that don't want a deck.gl dependency.

### Cesium renderer (`@poopdeck.gl/cesium`)

- [**@poopdeck.gl/cesium**](./api/stt-cesium.md): CesiumJS backend rendering
  STT on a real WGS84 globe — the movement layer catalog (point / path /
  OD line / arc / trips / trip-heads) plus the `ViewState`⇄Cesium camera
  bridge and render-loop clock hook.

### CLI Tools

- [**CLI Reference**](./api/cli-reference.md): `stt-build`, `stt-generate`,
  `stt-optimize`, `stt-validate`, `stt-serve`.

## Guides

- [**Data Generation**](./guides/data-generation.md): Building packed
  datasets with `stt-generate` for the included showcase datasets, or
  with `stt-build` for your own GeoParquet input.
- [**Building from Python**](./guides/python.md): GeoPandas, DuckDB, or
  pyarrow recipes for getting your data into GeoParquet so `stt-build`
  can consume it.
- [**Deploying a dataset**](./guides/deploying.md): R2 / S3 / GCS / nginx —
  the two Cache-Control regimes, CORS for Range requests, and the
  copy-never-delete deploy rule.
