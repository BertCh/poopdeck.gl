# Spatiotemporal Tiles Documentation

Welcome to the documentation for Spatiotemporal Tiles (STT), a cloud-native,
edge-cacheable tile format for visualizing massive time-variant geospatial
datasets.

## Introduction

- [**Concepts**](./intro/concepts.md): Spatiotemporal tiling, the packed
  container, temporal LOD, blob ordering, and the streaming render model.

## Architecture

- [**System Overview**](./architecture/system-overview.md): High-level look
  at the Rust generation tools and the TypeScript reader + render stack
  (deck.gl and MapLibre).
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

**Summary tiers**

- [**AnimatedHeatmapLayer**](./api/heatmap-time-layer.md): Temporal heatmap built
  on deck.gl's aggregation layers, with stacked categorical channels.
- [**H3SummaryLayer**](./api/h3-summary-layer.md): Server-aggregated H3 summary
  tier rendered as hexagons.
- [**QuadbinSummaryLayer**](./api/quadbin-summary-layer.md): Server-aggregated
  Quadbin (quadkey) summary tier.

### Extensions

- [**TimeFilterExtension**](./api/time-filter-extension.md): GPU temporal
  filtering (and time-as-height) for any deck.gl layer.
- [**CategoryColorExtension**](./api/category-color-extension.md): GPU
  categorical color lookup via a palette texture.

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

### React adapter (`@poopdeck.gl/react`)

- [**@poopdeck.gl/react**](./api/stt-react.md): React playback hooks + UI
  controls — `usePlayback`, `usePlaybackHotkeys`, `PlaybackControls`, and the
  `HoverPreview` scrubber thumbnail.

### MapLibre adapter

- [**@poopdeck.gl/maplibre**](./api/stt-maplibre.md): MapLibre GL custom-layer
  adapter — five layer classes (point / line / polygon / trips / heatmap)
  for sites that don't want a deck.gl dependency.

### CLI Tools

- [**CLI Reference**](./api/cli-reference.md): `stt-build`, `stt-generate`,
  `stt-optimize`, `stt-validate`.

## Guides

- [**Data Generation**](./guides/data-generation.md): Building packed
  datasets with `stt-generate` for the included showcase datasets, or
  with `stt-build` for your own GeoParquet input.
- [**Building from Python**](./guides/python.md): GeoPandas, DuckDB, or
  pyarrow recipes for getting your data into GeoParquet so `stt-build`
  can consume it.
