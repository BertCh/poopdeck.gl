// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * @poopdeck.gl/layers - deck.gl layers for spatiotemporal tiles
 */

// Layers - Original implementation (stable)
export { SpatioTemporalLayer } from './layers/spatiotemporal-layer';
export { AnimatedPointLayer } from './layers/core/animated-point-layer';
export { AnimatedPathLayer } from './layers/core/animated-path-layer';
export { AnimatedPolygonLayer } from './layers/core/animated-polygon-layer';
export { AnimatedTripsLayer } from './layers/trips/animated-trips-layer';
export { FlowCorridorLayer } from './layers/trips/flow-corridor-layer';
// Smooth moving head-dot for trip archives — CPU-interpolated position per
// frame rendered through a stock ScatterplotLayer (fp64, no jitter, globe,
// circular markers). Draws one moving marker at the head of each active trip.
export { AnimatedTripHeadsLayer } from './layers/trips/animated-trip-heads-layer';
export { NoPickingPathLayer } from './layers/internal/no-picking-path-layer';
// Tapered half-arrow primitive (flowmap.gl-style) used by FlowmapLayer to draw
// weighted OD flows with triangular arrowheads instead of arcs. Exposed for
// callers who want the arrow geometry directly with their own data.
export { FlowLinesLayer } from './layers/internal/flow-lines-layer';
// Temporal heatmap built ON deck.gl's canonical @deck.gl/aggregation-layers
// HeatmapLayer (+ DataFilterExtension) — it replaced an earlier hand-rolled
// GPU-splat wrapper, not the other way around. `HeatmapLayer` is the
// deprecated pre-rename alias (it shadowed the canonical layer's name);
// prefer `AnimatedHeatmapLayer`.
export { AnimatedHeatmapLayer, HeatmapLayer } from './layers/summary/heatmap-layer';
// Server-aggregated summary tier (renders H3 hexes at low zooms).
export { H3SummaryLayer } from './layers/summary/h3-summary-layer';
// Server-aggregated Quadbin summary tier (renders Z/X/Y quad cells at low
// zooms) — the Quadbin analog of H3SummaryLayer, completing the format's
// already-declared `SummaryScheme::Quadbin`. Reads the cell id from
// `featureIds64` exactly like H3; converts the CARTO Quadbin u64 to a Bing
// quadkey for deck.gl's QuadkeyLayer.
export { QuadbinSummaryLayer } from './layers/summary/quadbin-summary-layer';
// flowmap.gl-style animated OD flowmap: one weighted arc per station-pair whose
// width tracks volume at the playhead (vertexValueMatrix decode, like
// FlowCorridorLayer) + node circles sized by incident flow. Feed it the
// `stt-generate bixi` OD-pair matrix tiles.
export { FlowmapLayer } from './layers/summary/flowmap-layer';
// GPU force-directed edge bundling variant of FlowmapLayer: compatible OD flows
// are relaxed into smooth rivers by an EdgeBundler running entirely on the GPU
// (cosmos.gl-style ping-pong float textures), then rendered fully GPU-resident.
// Drop-in superset of FlowmapLayer; falls back to straight arrows when the
// device can't render to a float texture or a tile exceeds `maxBundledEdges`.
export { BundledFlowmapLayer } from './layers/summary/bundled-flowmap-layer';
export { BundledFlowLinesLayer } from './layers/internal/bundled-flow-lines-layer';
// The GPU bundling engine + its float-render capability gate, exposed for
// callers who want to bundle their own OD edges directly. StaticBundle renders
// BAKED bundles (built by `stt-generate bixi --bake-bundling`) — same renderer,
// no per-frame relaxation, laxer device gate.
export {
  EdgeBundler,
  isBundlingSupported,
  StaticBundle,
  isStaticBundleSupported,
} from './lib/edge-bundler';

// Origin→destination flow layers (window-mode time filtering). Arc/Line read
// the FIRST vertex of each (typically 2-vertex) LineString tile as the source
// and the LAST as the target — feed them with the `nyc-rideshare --od` mode.
export { AnimatedArcLayer } from './layers/core/animated-arc-layer';
export { AnimatedLineLayer } from './layers/core/animated-line-layer';
// Directional point markers — IconLayer rotated per-feature by a heading
// column (e.g. AIS `cog`, aircraft `heading`); pairs with `--with-bearing`.
export { AnimatedIconLayer } from './layers/core/animated-icon-layer';
// Extruded 3D columns at point features; height driven by a numeric column.
export { AnimatedColumnLayer } from './layers/core/animated-column-layer';

// Extensions
export { TimeFilterExtension } from './extensions/time-filter-extension';
// The TimeFilterExtension contract requires callers to relativize all
// per-feature/per-vertex times against a layer timeOffset — export the
// canonical helper + the f32 precision ceiling so consumers don't have to
// re-derive the scheme.
export { relativizeTime, MAX_RELATIVE_TIME_MS } from './extensions/time-filter-extension';
export {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './extensions/category-color-extension';
// Deprecated alias of TimeFilterExtension (kept for back-compat; warns once
// on construction). TimeFilterExtension now works on SolidPolygonLayer.
export { PolygonTimeFilterExtension } from './extensions/polygon-time-filter-extension';

// NOTE: the playback engine (TimeController, PlaybackGovernor, SttPlayer,
// decideAutoSpeedMultiplier) lives in @poopdeck.gl/playback and is NO LONGER
// re-exported here — import it directly from @poopdeck.gl/playback. Layer code
// in this package still depends on the engine internally.

// Telemetry — opt-in perf probe channel used by tools/render-test and
// the showcase HUD. No-op when `globalThis.__sttProbe` is unset.
export {
  emit,
  measure,
  disableProbe,
  enableProbe,
  snapshot,
  getSnapshot,
} from './lib/telemetry';
export type { ProbeChannel } from './lib/telemetry';

// Overview (storyboard) preview tier — the result shape of the layer's
// `onOverviewPreload` callback (re-exported from @poopdeck.gl/core for convenience).
export type { OverviewPreloadResult } from '@poopdeck.gl/core';

// Accessor-named prop aliases (audit B1): value-domain unions for the
// upstream-vocabulary props (getFillColor/getColor/getWidth/…) — constant or
// column-name string; function accessors warn once and are ignored.
export type {
  ColorAccessorValue,
  NumericAccessorValue,
  WeightAccessorValue,
} from './lib/accessor-alias';

// Types
export type {
  SpatioTemporalLayerProps,
  SpatioTemporalPickingInfo,
  SttSublayerPickingProps,
} from './layers/spatiotemporal-layer';
export type { AnimatedPointLayerProps } from './layers/core/animated-point-layer';
export type { AnimatedPathLayerProps } from './layers/core/animated-path-layer';
export type { AnimatedPolygonLayerProps } from './layers/core/animated-polygon-layer';
export type { AnimatedTripsLayerProps } from './layers/trips/animated-trips-layer';
export type { AnimatedTripHeadsLayerProps } from './layers/trips/animated-trip-heads-layer';
export type {
  AnimatedHeatmapLayerProps,
  // Deprecated pre-rename alias of AnimatedHeatmapLayerProps.
  HeatmapLayerProps,
  HeatmapChannelSpec,
} from './layers/summary/heatmap-layer';
export type { H3SummaryLayerProps } from './layers/summary/h3-summary-layer';
export type { QuadbinSummaryLayerProps } from './layers/summary/quadbin-summary-layer';
export type { FlowmapLayerProps } from './layers/summary/flowmap-layer';
export type { BundledFlowmapLayerProps } from './layers/summary/bundled-flowmap-layer';
export type { BundledFlowLinesLayerProps } from './layers/internal/bundled-flow-lines-layer';
export type {
  EdgeBundlerOptions,
  StaticBundleOptions,
  BundlePositions,
  Vec2,
} from './lib/edge-bundler';
export type { FlowLinesLayerProps } from './layers/internal/flow-lines-layer';
export type { AnimatedArcLayerProps } from './layers/core/animated-arc-layer';
export type { AnimatedLineLayerProps } from './layers/core/animated-line-layer';
export type { AnimatedIconLayerProps } from './layers/core/animated-icon-layer';
export type { AnimatedColumnLayerProps } from './layers/core/animated-column-layer';
export type { TimeFilterExtensionProps } from './extensions/time-filter-extension';
export type { CategoryColorExtensionProps } from './extensions/category-color-extension';
export type { PolygonTimeFilterExtensionProps } from './extensions/polygon-time-filter-extension';

