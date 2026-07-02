/**
 * @poopdeck.gl/maplibre — MapLibre GL custom-layer adapters for STT archives.
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
 * {@link "@poopdeck.gl/layers"} instead. This adapter exists for sites that don't
 * want a deck.gl dependency or that need to interleave STT data between
 * native MapLibre layers.
 */

export {
  STTPointLayer,
  type STTPointLayerOptions,
} from './layers/point-layer';
export {
  STTLineLayer,
  type STTLineLayerOptions,
} from './layers/line-layer';
export {
  STTPolygonLayer,
  type STTPolygonLayerOptions,
} from './layers/polygon-layer';
export { STTTripsLayer, type STTTripsLayerOptions } from './layers/trips-layer';
export {
  STTHeatmapLayer,
  type STTHeatmapLayerOptions,
} from './layers/heatmap-layer';
export {
  STTBaseLayer,
  cssToDevicePixel,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  type PickProvenanceEntry,
  type RGBA,
  type RGBA8,
} from './base-layer';
export { lngLatToMercator, projectPositions } from './lib/projection';

// Shared id-buffer picking result shape (see `STTBaseLayer.pick`). Re-exported
// from the core picking kernel so consumers don't reach across packages.
export type { SttPickResult } from '@poopdeck.gl/core/picking';

// Backend capability descriptor — what this adapter declares against the shared
// `@poopdeck.gl/core/capabilities` vocabulary (renderer-abstraction Phase 5).
export { maplibreBackend } from './backend-descriptor';

// Backwards-compat alias for the 0.1.x scaffold, which only had a points
// renderer named STTMaplibreLayer. New code should import STTPointLayer.
export { STTPointLayer as STTMaplibreLayer } from './layers/point-layer';
export type { STTPointLayerOptions as STTMaplibreLayerOptions } from './layers/point-layer';
