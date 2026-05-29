# SpatioTemporalTileLayer (removed)

> **Removed.** This experimental wrapper around `@deck.gl/geo-layers`
> `TileLayer` has been removed. STT needs first-class access to the time
> axis (4D `(z, x, y, t)` addressing, bucket-aligned temporal prefetch,
> temporal-aware cache eviction) and `TileLayer` does not model that.

Use [`SpatioTemporalLayer`](./spatiotemporal-layer.md) — or one of its
concrete subclasses ([`AnimatedPointLayer`](./animated-point-layer.md),
[`AnimatedPathLayer`](./animated-path-layer.md),
[`AnimatedPolygonLayer`](./animated-polygon-layer.md),
[`AnimatedTripsLayer`](./animated-trips-layer.md),
[`HeatmapLayer`](./heatmap-time-layer.md),
`H3SummaryLayer`) — instead. They share the same archive reader and
tileset internally but expose the temporal API the rest of STT relies on.

For sites that want a no-deck.gl dependency,
[`@stt/maplibre`](./stt-maplibre.md) implements equivalent layers as
MapLibre GL custom layers.
