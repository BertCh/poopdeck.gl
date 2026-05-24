/**
 * @stt/deck.gl - deck.gl layers for spatiotemporal tiles
 */

// Layers - Original implementation (stable)
export { SpatioTemporalLayer } from './spatiotemporal-layer';
export { AnimatedPointLayer } from './animated-point-layer';
export { AnimatedPathLayer } from './animated-path-layer';
export { AnimatedPolygonLayer } from './animated-polygon-layer';
export { AnimatedTripsLayer } from './animated-trips-layer';
export { HeatmapTimeLayer } from './heatmap-time-layer';

// Extensions
export { TimeFilterExtension } from './time-filter-extension';
export {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './category-color-extension';
export { PolygonTimeFilterExtension } from './polygon-time-filter-extension';

// Controllers
export { TimeController } from './time-controller';

// Telemetry (opt-in; no-op when globalThis.__sttProbe is not set)
export { emit as emitTelemetry } from './telemetry';

// Types
export type { SpatioTemporalLayerProps } from './spatiotemporal-layer';
export type { AnimatedPointLayerProps } from './animated-point-layer';
export type { AnimatedPathLayerProps } from './animated-path-layer';
export type { AnimatedPolygonLayerProps } from './animated-polygon-layer';
export type { AnimatedTripsLayerProps } from './animated-trips-layer';
export type { HeatmapTimeLayerProps } from './heatmap-time-layer';
export type { TimeFilterExtensionProps } from './time-filter-extension';
export type { CategoryColorExtensionProps } from './category-color-extension';
export type { PolygonTimeFilterExtensionProps } from './polygon-time-filter-extension';
export type { TimeControllerOptions, TimeControllerState } from './time-controller';

