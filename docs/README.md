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
  payload (Apache Arrow IPC + GeoArrow), shared across containers.
- [**deck.gl Integration**](./architecture/deckgl-integration.md): How
  `@stt/deck.gl` relates to TileLayer, and where it deliberately departs.

## API Reference

### deck.gl Layers

- [**SpatioTemporalLayer**](./api/spatiotemporal-layer.md): Base class
  used by every animated layer below.
- [**AnimatedPointLayer**](./api/animated-point-layer.md): Animated
  points (billboards).
- [**AnimatedPathLayer**](./api/animated-path-layer.md): Animated
  paths / trajectories with window-mode fade.
- [**AnimatedPolygonLayer**](./api/animated-polygon-layer.md): Animated
  polygons with optional extrusion.
- [**AnimatedTripsLayer**](./api/animated-trips-layer.md): "Vehicle moving
  along route" trails with per-vertex timestamps.
- [**VatTripsLayer**](./api/vat-trips-layer.md): Vertex-attribute-texture
  trips variant for very high trip counts.
- [**AnimatedHeatmapLayer**](./api/heatmap-time-layer.md): Temporal heatmap
  built on deck.gl's aggregation layers, with stacked categorical channels.
- [**H3SummaryLayer**](./api/h3-summary-layer.md): Renders the
  server-aggregated H3 summary tier as hexagons.

### Extensions

- [**TimeFilterExtension**](./api/time-filter-extension.md): GPU-based
  temporal filtering for any deck.gl layer.
- [**CategoryColorExtension**](./api/category-color-extension.md): GPU-based
  categorical color lookup via a palette texture.

### Controllers

- [**TimeController**](./api/time-controller.md): Animation playback clock
  shared across layers.
- [**PlaybackGovernor**](./api/playback-governor.md): Buffering state machine
  that gates the clock on a buffered runway (stall/resume, seek gates,
  Auto speed).

### Reader (`@stt/core`)

- [**Tile decoding**](./api/stt-loader.md): The `TileDecoder` interface
  plus the inline / worker-pool implementations.
- [**SpatiotemporalTileset**](./api/spatiotemporal-tileset.md): Tile
  lifecycle, viewport + time-aware selection, and prefetching.
- [**Binary Features**](./api/binary-features.md): The GPU-ready columnar
  format `TileDecoder` returns.

### MapLibre adapter

- [**@stt/maplibre**](./api/stt-maplibre.md): MapLibre GL custom-layer
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
