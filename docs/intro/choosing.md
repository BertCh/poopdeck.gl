# Choosing STT, a deployment, and a renderer

Use this page for product-level choices. The
[backend capability matrix](../spec/backend-capabilities.md) is authoritative
for individual render features.

## Should I use STT?

STT is a good fit when all or most of these are true:

- the source is vector data with timestamps or time intervals;
- users pan, zoom, scrub, or animate through more data than a browser should
  load at once;
- immutable snapshots and CDN caching fit the publication model;
- columnar properties or GeoArrow interoperability matter; and
- the same archive should support several web-rendering stacks.

STT is usually not the right fit when:

- a small GeoJSON or Arrow file already loads and filters comfortably;
- the main data is imagery, weather grids, or another raster/datacube workload;
- records must be edited individually in place;
- every query is an unpredictable server-side aggregation; or
- the application requires a renderer feature that the
  [capability matrix](../spec/backend-capabilities.md) does not provide.

STT covers vector trajectories, events, paths, polygons, trips, flows, and
time-varying features. For raster time series, consider GeoZarr or COG.

## Static archive or live service?

| Choose                            | When                                                                                             | Operational trade-off                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Packed archive from `stt-build`   | Data is published in snapshots and can live in R2, S3, GCS, or another static host               | Simplest and most cacheable; publish immutable objects before the manifest |
| Dynamic endpoint from `stt-serve` | Data must come directly from PostGIS or DuckDB, or archive generation is not the right lifecycle | Requires an application service and database capacity                      |

Both expose the same STT data model. See the
[deployment guide](../guides/deploying.md) and
[`stt-serve` protocol](../spec/stt-serve-protocol.md).

## Which renderer?

| Backend                                                 | Choose it when                                                                           | Status and constraint                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`@poopdeck.gl/layers`](../api/spatiotemporal-layer.md) | You want the primary, broadest layer catalog, GPU picking, and deck.gl extensions        | Stable pre-1.0; deck.gl is pinned to 9.3.x                            |
| [`@poopdeck.gl/maplibre`](../api/stt-maplibre.md)       | STT must sit between native MapLibre or Mapbox style layers without a deck.gl dependency | Preview; confirm the required layer kind in the capability matrix     |
| [`@poopdeck.gl/three`](../api/stt-three.md)             | You need a 3D-native scene, WebGPU, react-three-fiber, LIDAR, or local metric frames     | Preview; uses a WebGL2 fallback where supported                       |
| [`@poopdeck.gl/cesium`](../api/stt-cesium.md)           | You are evaluating STT on a true WGS84 Cesium globe                                      | Private, source-only, and experimental; not an npm package commitment |

All backends use `@poopdeck.gl/core` and the same archive semantics. Renderer
choice does not require rebuilding the dataset unless the desired visualization
needs an optional variant or specialized payload.

## Which deck.gl layer?

| Data shape                          | Start with                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Timestamped events or moving points | [`AnimatedPointLayer`](../api/animated-point-layer.md)                                                     |
| Paths or trajectories               | [`AnimatedPathLayer`](../api/animated-path-layer.md)                                                       |
| Moving trails                       | [`AnimatedTripsLayer`](../api/animated-trips-layer.md)                                                     |
| A moving position along each trip   | [`AnimatedTripHeadsLayer`](../api/animated-trip-heads-layer.md)                                            |
| Origin–destination pairs            | [`AnimatedArcLayer`](../api/animated-arc-layer.md) or [`AnimatedLineLayer`](../api/animated-line-layer.md) |
| Aggregated OD volumes               | [`FlowmapLayer`](../api/flowmap-layer.md)                                                                  |
| Time-varying network flow           | [`FlowCorridorLayer`](../api/flow-corridor-layer.md)                                                       |
| Polygons, perimeters, or isobands   | [`AnimatedPolygonLayer`](../api/animated-polygon-layer.md)                                                 |
| Directional markers                 | [`AnimatedIconLayer`](../api/animated-icon-layer.md)                                                       |
| Tracked 3D objects                  | [`AnimatedBoundingBoxLayer`](../api/animated-bounding-box-layer.md)                                        |
| LIDAR or oriented point clouds      | [`SplatLayer`](../api/splat-layer.md)                                                                      |
| Dense overview visualization        | [`AnimatedHeatmapLayer`](../api/heatmap-time-layer.md)                                                     |
| Precomputed coarse cells            | [`H3SummaryLayer`](../api/h3-summary-layer.md) or [`QuadbinSummaryLayer`](../api/quadbin-summary-layer.md) |

The linked references cover the common choices; the
[SpatioTemporalLayer reference](../api/spatiotemporal-layer.md) routes to the
full deck.gl catalog. Summary layers require a summary variant built explicitly
with `stt-build`; they do not replace the raw feature tier.

## Playback choice

Use [`SttPlayer`](../api/stt-player.md) for normal applications. It owns the
clock and buffering governor and can pause when the loading runway runs out. Use
the bare [`TimeController`](../api/time-controller.md) only when another media,
simulation, or application clock is authoritative.

For React, [`@poopdeck.gl/react`](../api/stt-react.md) supplies hooks and controls
around the same player. Multiple layers and backends can share one clock.

Before adopting an API, check
[status, support, and compatibility](./status-and-support.md).
