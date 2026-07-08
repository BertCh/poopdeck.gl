# Choosing a Layer & Backend

Two decisions shape an STT integration: **which renderer backend** fits your
stack, and **which layer** fits your data's shape. This page is the short
answer to both; the generated
[backend capability matrix](../spec/backend-capabilities.md) is the
authoritative per-kind reference.

## Which backend?

| Backend                                                           | Pick it when                                                                                                    | Trade-off                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`@poopdeck.gl/layers`](../api/spatiotemporal-layer.md) (deck.gl) | Default choice — you want the full catalog below, GPU picking, and the extensions                               | Brings the deck.gl dependency                                                                |
| [`@poopdeck.gl/maplibre`](../api/stt-maplibre.md)                 | You already run MapLibre and want STT interleaved between native style layers without deck.gl                   | Five layer kinds (point / line / polygon / trips / heatmap)                                  |
| [`@poopdeck.gl/three`](../api/stt-three.md)                       | 3D-native scenes: LIDAR surfels, point clouds, metric local frames (the AV cockpit), WebGPU + react-three-fiber | Its own camera/controls world, not a slippy map (mercator + globe projections exist)         |
| [`@poopdeck.gl/cesium`](../api/stt-cesium.md)                     | You're already a Cesium shop and want STT on a true WGS84 globe                                                 | Movement kinds (point / path / line / arc / trips / trip-heads); aggregation kinds fall back |

All four consume the same archives through the same
[`@poopdeck.gl/core`](../api/spatiotemporal-tileset.md) reader and the same
[playback clock](../api/time-controller.md) — switching backends is a render
decision, not a data decision.

## Which layer? (deck.gl catalog)

Match your data's geometry + time shape:

| Your data                                   | Layer                                                                                                     | Notes                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Timestamped events / moving points          | [`AnimatedPointLayer`](../api/animated-point-layer.md)                                                    | `window` / `wake` / `cumulative` modes; `splat` for soft gaussian points |
| Trajectories (per-vertex times)             | [`AnimatedPathLayer`](../api/animated-path-layer.md)                                                      | Whole path visible, window-mode fade                                     |
| …rendered as moving trails                  | [`AnimatedTripsLayer`](../api/animated-trips-layer.md)                                                    | trips-style trailing ribbon                                              |
| …rendered as a moving dot                   | [`AnimatedTripHeadsLayer`](../api/animated-trip-heads-layer.md)                                           | CPU-interpolated head per active trip                                    |
| Origin→destination pairs, per trip          | [`AnimatedArcLayer`](../api/animated-arc-layer.md) / [`AnimatedLineLayer`](../api/animated-line-layer.md) | Raised arcs vs flat lines                                                |
| OD volumes, aggregated                      | [`FlowmapLayer`](../api/flowmap-layer.md)                                                                 | flowmap.gl-style tapered arrows + node circles                           |
| …with edge bundling                         | [`BundledFlowmapLayer`](../api/bundled-flowmap-layer.md)                                                  | baked KDEEB "rivers"                                                     |
| Flow on a street network                    | [`FlowCorridorLayer`](../api/flow-corridor-layer.md)                                                      | static geometry, per-segment color pulses over time                      |
| …as merged directed ribbons                 | [`FlowStrokeLayer`](../api/flow-stroke-layer.md)                                                          | width tapers + breathes, twin ribbons per direction                      |
| Polygons (footprints, perimeters, isobands) | [`AnimatedPolygonLayer`](../api/animated-polygon-layer.md)                                                | optional extrusion                                                       |
| Per-feature magnitude as 3D bars            | [`AnimatedColumnLayer`](../api/animated-column-layer.md)                                                  | instanced columns                                                        |
| Directional markers                         | [`AnimatedIconLayer`](../api/animated-icon-layer.md)                                                      | heading-rotated icons (needs a `bearing` column)                         |
| Tracked objects with pose + size            | [`AnimatedBoundingBoxLayer`](../api/animated-bounding-box-layer.md)                                       | oriented 3D boxes, labels, velocity arrows                               |
| LIDAR / oriented point clouds               | [`SplatLayer`](../api/splat-layer.md)                                                                     | anisotropic gaussian surfels                                             |
| Dense data at overview zooms                | [`AnimatedHeatmapLayer`](../api/heatmap-time-layer.md)                                                    | GPU density with stacked categorical channels                            |
| …as pre-aggregated cells                    | [`H3SummaryLayer`](../api/h3-summary-layer.md) / [`QuadbinSummaryLayer`](../api/quadbin-summary-layer.md) | server-side aggregation baked at build time                              |

Two build-side couplings to know: the summary layers read a tier baked with
`stt-build --summary-tier`, and the flowmap/corridor layers read the
per-vertex × per-bucket value matrix
([`vertex_value_matrix`](../architecture/data-format.md)) that flow-producing
generators emit. Everything else works on any archive with the matching
geometry type.

## Combining them

Layers compose on one clock: a typical composite renders a basemap-level
summary tier at low zoom and switches to per-feature layers as you zoom in
(the tileset handles the LOD selection), or overlays several layers from one
multi-stream [scene bundle](../spec/sidecar-assets.md). The
[playback guide pages](../api/stt-player.md) cover driving them all from a
single `TimeController`.
