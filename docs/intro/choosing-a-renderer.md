# Choosing a renderer, a layer, and a playback API

Use this page once you have decided STT fits your data — that question, and the
static-archive-versus-live-service choice, are in
[choosing STT and a deployment](./choosing.md).

The [backend capability matrix](../spec/backend-capabilities.md) is generated
from the backend descriptors and is authoritative for individual render
features; the tables here are the product-level shortcut.

## Which renderer?

| Backend                                                 | Choose it when                                                                                                 | Status and constraint                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`@poopdeck.gl/layers`](../api/spatiotemporal-layer.md) | You want the primary, most heavily integrated backend, deck.gl extensions, and the widest set of styling props | Stable pre-1.0; deck.gl is pinned to 9.3.x; no native `ego` kind and `isoLines` falls back to `path` |
| [`@poopdeck.gl/maplibre`](../api/stt-maplibre.md)       | STT must sit between native MapLibre or Mapbox style layers without a deck.gl dependency                       | Preview; renders every layer kind natively                                                           |
| [`@poopdeck.gl/three`](../api/stt-three.md)             | You need a 3D-native scene, WebGPU, react-three-fiber, LIDAR, or local metric frames                           | Preview; uses a WebGL2 fallback where supported                                                      |
| [`@poopdeck.gl/cesium`](../api/stt-cesium.md)           | You are evaluating STT on a true WGS84 Cesium globe                                                            | Private, source-only, and experimental; not an npm package commitment                                |

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
| LIDAR or 3D point clouds            | [`AnimatedPointCloudLayer`](../api/animated-point-cloud-layer.md)                                          |
| Oriented surfels or Gaussian splats | [`SplatLayer`](../api/splat-layer.md) (needs `--surfel`-baked covariance columns)                          |
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
