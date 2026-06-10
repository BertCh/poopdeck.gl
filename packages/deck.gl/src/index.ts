// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * @stt/deck.gl - deck.gl layers for spatiotemporal tiles
 */

// Layers - Original implementation (stable)
export { SpatioTemporalLayer } from './spatiotemporal-layer';
export { AnimatedPointLayer } from './animated-point-layer';
export { AnimatedPathLayer } from './animated-path-layer';
export { AnimatedPolygonLayer } from './animated-polygon-layer';
export { AnimatedTripsLayer } from './animated-trips-layer';
// Vertex-Animation-Texture variant of trip rendering — one quad per active
// trip; positions sampled from a per-tile texture. Scales independently of
// per-trajectory vertex count.
export { VatTripsLayer } from './vat-trips-layer';
export { NoPickingPathLayer } from './no-picking-path-layer';
// GPU-splat temporal heatmap. Replaces the old aggregation-layers wrapper.
export { HeatmapLayer } from './heatmap-layer';
// Server-aggregated summary tier (renders H3 hexes at low zooms).
export { H3SummaryLayer } from './h3-summary-layer';

// Extensions
export { TimeFilterExtension } from './time-filter-extension';
export {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './category-color-extension';
export { PolygonTimeFilterExtension } from './polygon-time-filter-extension';

// Controllers
export { TimeController } from './time-controller';

// Playback buffering governor — the state machine between user intent and the
// TimeController that gates play/resume/seek on the tileset's buffered runway
// (see docs/roadmap/player-buffering.md, WS-B).
export { PlaybackGovernor } from './playback-governor';
export type {
  BufferSource,
  BufferedRunway,
  GovernorEventMap,
  GovernorEventName,
  GovernorReadyEvent,
  GovernorWaitingEvent,
  PlaybackGovernorOptions,
  PlaybackGovernorState,
  ThroughputEstimate,
} from './playback-governor';

// Telemetry — opt-in perf probe channel used by tools/render-test and
// the showcase HUD. No-op when `globalThis.__sttProbe` is unset.
export {
  emit,
  measure,
  disableProbe,
  enableProbe,
  snapshot,
  getSnapshot,
} from './telemetry';
export type { ProbeChannel } from './telemetry';

// Overview (storyboard) preview tier — the result shape of the layer's
// `onOverviewPreload` callback (re-exported from @stt/core for convenience).
export type { OverviewPreloadResult } from '@stt/core';

// Types
export type { SpatioTemporalLayerProps } from './spatiotemporal-layer';
export type { AnimatedPointLayerProps } from './animated-point-layer';
export type { AnimatedPathLayerProps } from './animated-path-layer';
export type { AnimatedPolygonLayerProps } from './animated-polygon-layer';
export type { AnimatedTripsLayerProps } from './animated-trips-layer';
export type { VatTripsLayerProps } from './vat-trips-layer';
export type { HeatmapLayerProps, HeatmapChannelSpec } from './heatmap-layer';
export type { H3SummaryLayerProps } from './h3-summary-layer';
export type { TimeFilterExtensionProps } from './time-filter-extension';
export type { CategoryColorExtensionProps } from './category-color-extension';
export type { PolygonTimeFilterExtensionProps } from './polygon-time-filter-extension';
export type { TimeControllerOptions, TimeControllerState } from './time-controller';

