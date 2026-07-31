// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * @poopdeck.gl/layers - deck.gl layers for spatiotemporal tiles
 */

// Layers - Original implementation (stable)
export { SpatioTemporalLayer } from './layers/spatiotemporal-layer.js';
export { AnimatedPointLayer } from './layers/core/animated-point-layer.js';
export { AnimatedPathLayer } from './layers/core/animated-path-layer.js';
export { AnimatedPolygonLayer } from './layers/core/animated-polygon-layer.js';
export { AnimatedTripsLayer } from './layers/trips/animated-trips-layer.js';
export { FlowCorridorLayer } from './layers/trips/flow-corridor-layer.js';
// Coherent merged directed corridors with breathing (hourly) width + twin
// offset ribbons — the `bixi-corridors` renderer (bixi --merged-paths).
export { FlowStrokeLayer } from './layers/trips/flow-stroke-layer.js';
export type { FlowStrokeLayerProps } from './layers/trips/flow-stroke-layer.js';
// Smooth moving head-dot for trip archives — CPU-interpolated position per
// frame rendered through a stock ScatterplotLayer (fp64, no jitter, globe,
// circular markers). Draws one moving marker at the head of each active trip.
export { AnimatedTripHeadsLayer } from './layers/trips/animated-trip-heads-layer.js';
// PathLayer subclass that drops the `instancePickingColors` vertex attribute so
// the animated path/trips sublayers fit WebGL2's 16-slot minimum. The animated
// layers select it automatically from `pickable`; it is exported for callers who
// hit the same attribute ceiling with their own PathLayer stack and want the
// stripped variant directly. (Its own docstring still carries a stale
// `@internal` tag — the export is public and supported.)
export { NoPickingPathLayer } from './layers/internal/no-picking-path-layer.js';
// Tapered half-arrow primitive (flowmap.gl-style) used by FlowmapLayer to draw
// weighted OD flows with triangular arrowheads instead of arcs. Exposed for
// callers who want the arrow geometry directly with their own data.
export { FlowLinesLayer } from './layers/internal/flow-lines-layer.js';
// Temporal heatmap built ON deck.gl's canonical @deck.gl/aggregation-layers
// HeatmapLayer (+ DataFilterExtension) — it replaced an earlier hand-rolled
// GPU-splat wrapper, not the other way around. Named `AnimatedHeatmapLayer`
// so it does not shadow the canonical deck.gl `HeatmapLayer`.
export { AnimatedHeatmapLayer } from './layers/summary/heatmap-layer.js';
// Runtime hexbin composite over @deck.gl/aggregation-layers HexagonLayer (kind
// 'hexbin') — the discrete/pickable/extruded analog of AnimatedHeatmapLayer;
// reuses buildConsolidatedChannelData + animates via DataFilterExtension range.
export { AnimatedHexagonLayer } from './layers/summary/animated-hexagon-layer.js';
// Server-aggregated summary tier (renders H3 hexes at low zooms).
export { H3SummaryLayer } from './layers/summary/h3-summary-layer.js';
// Server-aggregated Quadbin summary tier (renders Z/X/Y quad cells at low
// zooms) — the Quadbin analog of H3SummaryLayer, completing the format's
// already-declared `SummaryScheme::Quadbin`. Reads the cell id from
// `featureIds64` exactly like H3; converts the CARTO Quadbin u64 to a Bing
// quadkey for deck.gl's QuadkeyLayer.
export { QuadbinSummaryLayer } from './layers/summary/quadbin-summary-layer.js';
// flowmap.gl-style animated OD flowmap: one weighted arc per station-pair whose
// width tracks volume at the playhead (vertexValueMatrix decode, like
// FlowCorridorLayer) + node circles sized by incident flow. Feed it the
// `stt-generate bixi` OD-pair matrix tiles.
export { FlowmapLayer } from './layers/summary/flowmap-layer.js';
// GPU force-directed edge bundling variant of FlowmapLayer: compatible OD flows
// are relaxed into smooth rivers by an EdgeBundler running entirely on the GPU
// (cosmos.gl-style ping-pong float textures), then rendered fully GPU-resident.
// Drop-in superset of FlowmapLayer; falls back to straight arrows when the
// device can't render to a float texture or a tile exceeds `maxBundledEdges`.
export { BundledFlowmapLayer } from './layers/summary/bundled-flowmap-layer.js';
export { BundledFlowLinesLayer } from './layers/internal/bundled-flow-lines-layer.js';
// The GPU bundling engine + its float-render capability gate, exposed for
// callers who want to bundle their own OD edges directly. StaticBundle renders
// BAKED bundles (built by `stt-generate bixi --bake-bundling`) — same renderer,
// no per-frame relaxation, laxer device gate.
export {
  EdgeBundler,
  isBundlingSupported,
  StaticBundle,
  isStaticBundleSupported,
} from './lib/edge-bundler.js';

// Origin→destination flow layers (window-mode time filtering). Arc/Line read
// the FIRST vertex of each (typically 2-vertex) LineString tile as the source
// and the LAST as the target — feed them with the `nyc-rideshare --od` mode.
export { AnimatedArcLayer } from './layers/core/animated-arc-layer.js';
export { AnimatedLineLayer } from './layers/core/animated-line-layer.js';
// Directional point markers — IconLayer rotated per-feature by a heading
// column (e.g. AIS `cog`, aircraft `heading`); pairs with `--with-bearing`.
export { AnimatedIconLayer } from './layers/core/animated-icon-layer.js';
// Extruded 3D columns at point features; height driven by a numeric column.
export { AnimatedColumnLayer } from './layers/core/animated-column-layer.js';
// Oriented extruded boxes at point features (streetscape.gl tracked-object
// look); per-feature categorical color + box dims. Feed it the AV-cockpit
// `objects/` point archive (one box per tracked object per sample).
export { AnimatedBoundingBoxLayer } from './layers/core/animated-bounding-box-layer.js';
// Oriented anisotropic Gaussian SURFELS that evolve over time — a "formal"
// splat for STT (surface splatting, not the isotropic point-splat of
// AnimatedPointLayer.splat). Reads the surfel columns baked by
// `waymo_extract.py --surfel` (quaternion + in-plane extents + per-surfel
// confidence) and renders depth-tested oriented disks with a soft radial AND a
// soft temporal Gaussian, so the cloud reads as continuous surface that brightens
// and fades around each sample's instant. The custom-Model primitive is exposed
// for callers who want the splat geometry directly.
export { SplatLayer } from './layers/core/splat-layer.js';
export { SplatPrimitiveLayer } from './layers/internal/splat-primitive-layer.js';
// Time-filtered map labels (kind 'text') — decodes each tile's string column to
// stable CPU rows once, then CPU-filters against the playhead (deck TextLayer
// needs string ROWS + a FontAtlasManager, so it can't run the binary interface).
export { AnimatedTextLayer } from './layers/core/animated-text-layer.js';
// Animated glTF/OBJ instances (kind 'mesh') — one interpolated SimpleMeshLayer
// instance per active track over the AV objects/ point archive; static mesh (or
// per-category meshMapping) is a per-layer prop, motion/color ride the tracks.
export { AnimatedMeshLayer } from './layers/core/animated-mesh-layer.js';
// Animated glTF SCENEGRAPHS (also kind 'mesh') — the ScenegraphLayer engine
// behind the same track machinery, mirroring deck's own SimpleMeshLayer /
// ScenegraphLayer split. Node hierarchy + PBR materials + per-node animation,
// for AUTHORED assets (e.g. an OpenUSD/Omniverse export) rather than primitives.
export { AnimatedScenegraphLayer } from './layers/core/animated-scenegraph-layer.js';
// Time-windowed 3D point clouds (kind 'pointCloud') — zero-copy binary
// getPosition/getNormal/getColor over deck PointCloudLayer + TimeFilterExtension
// window mode; the scan/overview primitive (no cumulative-slab reveal path).
export { AnimatedPointCloudLayer } from './layers/core/animated-point-cloud-layer.js';

// Shortest-arc angular interpolation in DEGREES — the degrees analogue of the
// track kernel's radians `lerpAngle`, exposed for callers interpolating an
// `IconLayer.getAngle`-style heading (which deck.gl measures in degrees).
export { lerpAngleDeg } from './lib/track-kernel.js';

// Backend capability descriptor — what the deck.gl renderer DECLARES about
// itself against the shared `@poopdeck.gl/core/capabilities` contract (the
// declare-and-prove replacement for the hand-maintained parity table). Guarded
// by test/backend-descriptor.test.ts so it can't claim a layer kind whose class
// isn't actually exported here.
export { deckBackend } from './backend-descriptor.js';

// Extensions
export { TimeFilterExtension } from './extensions/time-filter-extension.js';
// The TimeFilterExtension contract requires callers to relativize all
// per-feature/per-vertex times against a layer timeOffset — export the
// canonical helper + the f32 precision ceiling so consumers don't have to
// re-derive the scheme.
export {
  relativizeTime,
  MAX_RELATIVE_TIME_MS,
} from './extensions/time-filter-extension.js';
export {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './extensions/category-color-extension.js';
// Soft-gaussian "splat" rendering for ScatterplotLayer points (e.g.
// camera-colored LIDAR clouds). See AnimatedPointLayer.splat.
export { SplatExtension } from './extensions/splat-extension.js';
// Marching directional chevrons over a path (e.g. BIXI street-flow direction).
// Compose via the `extensions` prop of an animated-trips-family layer.
export { ChevronFlowExtension } from './extensions/chevron-flow-extension.js';
export type { ChevronFlowExtensionOptions } from './extensions/chevron-flow-extension.js';
// Filter features by any baked numeric column against a [min,max] range (hard
// step) or soft range (smoothstep fade) — the poopdeck-native port of deck.gl's
// `DataFilterExtension` for binary STT tiles. Opt-in via `filterProperty` on
// AnimatedPointLayer / AnimatedPathLayer; zero cost when unset.
//
// PREFIXED (0.6.0) because it is a different class doing the same job under
// the same name: through 0.5.x this shadowed `@deck.gl/extensions`' own
// `DataFilterExtension` in any app importing both — and this very package
// imports both (the heatmap/hexagon composites drive deck's stock extension
// over CPU rows). The unprefixed spellings have been removed.
export { STTDataFilterExtension } from './extensions/data-filter-extension.js';
// Collision-based de-cluttering for STT layers. NOTE the name is deliberately
// NOT prefixed: this re-exports deck.gl's OWN `CollisionFilterExtension` class
// unchanged, so `@deck.gl/extensions` and this barrel hand you the identical
// object — there is nothing to shadow. (Contrast STTDataFilterExtension, which
// is a different class and therefore had to be renamed.)
// deck.gl's CollisionFilterExtension
// works as-is via the `extensions` prop for the constant case (great for thinning
// AnimatedIconLayer / AnimatedTextLayer labels); `collisionFilterProps` ergonomically
// wires the CONSTANT collision props. A data-driven `collisionPriorityProperty` is
// DEFERRED (warns once and falls back to the constant priority — per-feature ranking
// needs a layer-level baked `collisionPriorities` attribute, unlike DataFilterExtension's
// wired `filterProperty`).
export {
  CollisionFilterExtension,
  collisionFilterProps,
  COLLISION_PRIORITY_MIN,
  COLLISION_PRIORITY_MAX,
} from './extensions/collision-filter-extension.js';

// NOTE: the playback engine (TimeController, PlaybackGovernor, SttPlayer,
// decideAutoSpeedMultiplier) lives in @poopdeck.gl/playback and is NOT
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
} from './lib/telemetry.js';
export type { ProbeChannel } from './lib/telemetry.js';

// Overview (storyboard) preview tier — the result shape of the layer's
// `onOverviewPreload` callback (re-exported from @poopdeck.gl/core for convenience).
export type { OverviewPreloadResult } from '@poopdeck.gl/core';

// Governor-wiring callback parameter types: what `onTilesetReady` /
// `onBufferChange` hand you, re-exported so a consumer can type its handlers
// (`(tileset: SpatioTemporalTileset & BufferSource) => …`) without adding
// @poopdeck.gl/core or /playback as a direct dependency.
export type { SpatioTemporalTileset } from '@poopdeck.gl/core';
export type {
  /**
   * @deprecated Use {@link SpatioTemporalTileset} — the project noun is spelled
   * `SpatioTemporal` (capital T) everywhere now, matching the product name
   * "SpatioTemporal Tiles" and this package's own `SpatioTemporalLayer`.
   */
  SpatioTemporalTileset as SpatiotemporalTileset,
} from '@poopdeck.gl/core';
export type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';

// Accessor-named prop aliases: value-domain unions for the
// upstream-vocabulary props (getFillColor/getColor/getWidth/…) — constant or
// column-name string; function accessors warn once and are ignored.
export type {
  ColorAccessorValue,
  NumericAccessorValue,
  WeightAccessorValue,
} from './lib/accessor-alias.js';

// Types
export type {
  SpatioTemporalLayerProps,
  SpatioTemporalPickingInfo,
  SttSublayerPickingProps,
} from './layers/spatiotemporal-layer.js';
export type { AnimatedPointLayerProps } from './layers/core/animated-point-layer.js';
export type { AnimatedPathLayerProps } from './layers/core/animated-path-layer.js';
export type { AnimatedPolygonLayerProps } from './layers/core/animated-polygon-layer.js';
export type { AnimatedTripsLayerProps } from './layers/trips/animated-trips-layer.js';
export type { FlowCorridorLayerProps } from './layers/trips/flow-corridor-layer.js';
export type { AnimatedTripHeadsLayerProps } from './layers/trips/animated-trip-heads-layer.js';
export type {
  AnimatedHeatmapLayerProps,
  HeatmapChannelSpec,
} from './layers/summary/heatmap-layer.js';
export type {
  AnimatedHexagonLayerProps,
  // The value union behind `hexagonAggregation` / `colorAggregation` /
  // `elevationAggregation`.
  HexagonAggregationType,
} from './layers/summary/animated-hexagon-layer.js';
export type { H3SummaryLayerProps } from './layers/summary/h3-summary-layer.js';
export type { QuadbinSummaryLayerProps } from './layers/summary/quadbin-summary-layer.js';
export type { FlowmapLayerProps } from './layers/summary/flowmap-layer.js';
export type { BundledFlowmapLayerProps } from './layers/summary/bundled-flowmap-layer.js';
export type { BundledFlowLinesLayerProps } from './layers/internal/bundled-flow-lines-layer.js';
export type {
  EdgeBundlerOptions,
  StaticBundleOptions,
  BundlePositions,
  Vec2,
} from './lib/edge-bundler.js';
export type { FlowLinesLayerProps } from './layers/internal/flow-lines-layer.js';
export type { AnimatedArcLayerProps } from './layers/core/animated-arc-layer.js';
export type { AnimatedLineLayerProps } from './layers/core/animated-line-layer.js';
export type {
  AnimatedIconLayerProps,
  // Both appear on `AnimatedIconLayerProps` itself: `iconMapping` is a
  // `Record<string, IconMappingEntry>` and `getPixelOffset` takes a
  // `PixelOffsetAccessorValue`. Without these a consumer cannot type the object
  // literal it passes.
  IconMappingEntry,
  PixelOffsetAccessorValue,
  // What `iconMapping` accepts as a whole: the entry map, or a URL string that
  // the sublayer resolves asynchronously.
  IconMappingValue,
  // The argument shape handed to `onIconError`.
  IconLoadErrorContext,
} from './layers/core/animated-icon-layer.js';
export type { AnimatedColumnLayerProps } from './layers/core/animated-column-layer.js';
export type { AnimatedBoundingBoxLayerProps } from './layers/core/animated-bounding-box-layer.js';
export type { SplatLayerProps } from './layers/core/splat-layer.js';
export type { SplatPrimitiveLayerProps } from './layers/internal/splat-primitive-layer.js';
export type { AnimatedTextLayerProps } from './layers/core/animated-text-layer.js';
export type {
  AnimatedMeshLayerProps,
  // What `mesh` / `meshMapping` accept (URL, parsed geometry, or a promise).
  MeshSource,
  // The engine-class seam the scenegraph sibling overrides.
  EngineClass,
} from './layers/core/animated-mesh-layer.js';
export type {
  AnimatedScenegraphLayerProps,
  // What `scenegraph` / `scenegraphMapping` accept (glTF URL, parsed glTF,
  // ScenegraphNode, or a promise) + the `_animations` entry shape.
  ScenegraphSource,
  ScenegraphAnimationConfig,
} from './layers/core/animated-scenegraph-layer.js';
export type { AnimatedPointCloudLayerProps } from './layers/core/animated-point-cloud-layer.js';
export type {
  TimeFilterExtensionProps,
  // The constructor-options type + its `mode` union. Every SIBLING extension
  // already exports its options type (ChevronFlowExtensionOptions,
  // STTDataFilterExtensionOptions, CollisionFilterOptions); this one was the
  // odd one out even though `new TimeFilterExtension({mode: 'trail'})` is the
  // documented way to configure it.
  TimeFilterExtensionOptions,
  TimeFilterMode,
} from './extensions/time-filter-extension.js';
export type { CategoryColorExtensionProps } from './extensions/category-color-extension.js';
export type {
  STTDataFilterExtensionProps,
  STTDataFilterExtensionOptions,
  // Upstream options accepted for source-compatibility but NOT implemented
  // (each warns once). Referenced by `{@link}` from the public options JSDoc,
  // so it has to be nameable from the barrel.
  STTDataFilterUnsupportedOptions,
  DataFilterRange,
} from './extensions/data-filter-extension.js';
export type {
  CollisionFilterOptions,
  CollisionFilterProps,
} from './extensions/collision-filter-extension.js';
