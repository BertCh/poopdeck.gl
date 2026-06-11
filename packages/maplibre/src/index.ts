/**
 * @stt/maplibre — MapLibre GL custom-layer adapters for STT archives.
 *
 * Five layer classes, one per visualisation kind. Add the one(s) you need to
 * your map; each manages its own archive read, tile cache and shader pipeline:
 *
 *   - {@link STTPointLayer} — Point features (billboards).
 *   - {@link STTLineLayer} — LineString features, constant width window mode.
 *   - {@link STTPolygonLayer} — Polygon features, with optional stroke and
 *     extrusion.
 *   - {@link STTTripsLayer} — LineString features rendered with a trailing
 *     fade anchored at `currentTime` (parity with `AnimatedTripsLayer`).
 *   - {@link STTHeatmapLayer} — Density heatmap from POINT tiles, with an
 *     additive splat + colour-ramp pipeline (parity with `HeatmapTimeLayer`).
 *
 * For tiles containing multiple geometry types, instantiate multiple layers
 * pointing at the same URL — each will pick out the geometries it accepts.
 *
 * For deck.gl's rounded joints, dashes and GPU picking, use
 * {@link "@stt/deck.gl"} instead. This adapter exists for sites that don't
 * want a deck.gl dependency or that need to interleave STT data between
 * native MapLibre layers.
 */

export {
  STTPointLayer,
  type STTPointLayerOptions,
} from './point-layer';
export {
  STTLineLayer,
  type STTLineLayerOptions,
} from './line-layer';
export {
  STTPolygonLayer,
  type STTPolygonLayerOptions,
} from './polygon-layer';
export { STTTripsLayer, type STTTripsLayerOptions } from './trips-layer';
export {
  STTHeatmapLayer,
  type STTHeatmapLayerOptions,
} from './heatmap-layer';
export {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  type RGBA,
  type RGBA8,
} from './base-layer';
export { lngLatToMercator, projectPositions } from './projection';

// Backwards-compat alias for the 0.1.x scaffold, which only had a points
// renderer named STTMaplibreLayer. New code should import STTPointLayer.
export { STTPointLayer as STTMaplibreLayer } from './point-layer';
export type { STTPointLayerOptions as STTMaplibreLayerOptions } from './point-layer';
