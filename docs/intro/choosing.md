# Choosing STT and a deployment

Use this page for the two product-level choices this repository owns: whether
STT fits the data at all, and whether to publish a packed archive or serve
tiles live. Picking a renderer, a layer and a playback API is the subject of
[choosing a renderer](./choosing-a-renderer.md).

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

Renderer, layer and playback choices live with the renderers themselves, in
[choosing a renderer](./choosing-a-renderer.md). Renderer choice does not
require rebuilding the dataset unless the visualization needs an optional
variant — a summary tier, or a specialized payload such as `--surfel`-baked
covariance columns.
