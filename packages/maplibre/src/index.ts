/**
 * @poopdeck.gl/maplibre — MapLibre GL custom-layer adapters for STT archives.
 *
 * Fifteen layer classes across the point/line/polygon, trips, icon/column/arc,
 * summary and flow families. Add the one(s) you need to your map; each manages
 * its own archive read, tile cache and shader pipeline:
 *
 *   - {@link STTPointLayer} — Point features (billboards).
 *   - {@link STTLineLayer} — LineString features, constant width, all four
 *     time modes plus progressive path reveal (`revealTrail`).
 *   - {@link STTPolygonLayer} — Polygon features, with optional stroke and
 *     extrusion.
 *   - {@link STTTripsLayer} — LineString features rendered with a trailing
 *     fade anchored at `currentTime` (parity with `AnimatedTripsLayer`).
 *   - {@link STTTripHeadsLayer} — the moving head dot at the live end of each
 *     trip, CPU-interpolated through the shared core track kernel.
 *   - {@link STTHeatmapLayer} — Density heatmap from POINT tiles, with an
 *     additive splat + colour-ramp pipeline (parity with `HeatmapTimeLayer`).
 *   - {@link STTIconLayer} — rotated sprite billboards from an atlas, with
 *     per-feature sprite selection, an icon wake and CPU motion glide.
 *   - {@link STTColumnLayer} — instanced prisms (`elevation` in metres) with
 *     the space-time-cube lift (`timeHeightScale`).
 *   - {@link STTArcLayer} — real 3D origin→destination arcs, optionally
 *     great-circle, tessellated in the vertex shader.
 *   - {@link STTH3SummaryLayer} / {@link STTQuadbinSummaryLayer} — summary-tier
 *     cells (H3 / CARTO Quadbin) as ramp-coloured, optionally extruded prisms.
 *     H3 takes an injected `cellToBoundary` (h3-js is not a dependency here).
 *   - {@link STTHexbinLayer} — a REAL runtime hexbin (CPU binning at upload +
 *     GPU scatter/gather aggregation), not a fallback to the H3 summary tier.
 *   - {@link STTFlowCorridorLayer} / {@link STTFlowStrokeLayer} — value-matrix
 *     flow ribbons whose width breathes off a single per-frame scalar.
 *   - {@link STTFlowmapLayer} — one animated OD arrow per pair (static bundles;
 *     GPU live-bundling stays a declared fallback).
 *
 * For tiles containing multiple geometry types, instantiate multiple layers
 * pointing at the same URL — each will pick out the geometries it accepts —
 * or hand them one {@link SharedTilesetSource} (`{ source }` instead of
 * `{ url }`) so they share a single archive + tileset and a single governor
 * `BufferSource`.
 *
 * Layers work on maplibre v3–v6 and mapbox v3 from one build: `render()`
 * duck-types the host's calling convention (`lib/host-adapter.ts`), and on
 * v5+ hosts the shaders compile the host's injected projection prelude, which
 * includes globe. Prefer {@link STTBaseLayer.attach} over `map.addLayer` — it
 * survives `setStyle` diff-fallback rebuilds; `detach()` removes.
 *
 * For deck.gl's rounded joints, dashes and GPU picking, use
 * {@link "@poopdeck.gl/layers"} instead. This adapter exists for sites that don't
 * want a deck.gl dependency or that need to interleave STT data between
 * native MapLibre layers.
 */

export {
  STTPointLayer,
  type STTPointLayerOptions,
  type PointTimeFilterMode,
} from './layers/point-layer.js';
export {
  STTLineLayer,
  // Progressive path reveal: the compiled-mode union widens the four
  // time modes with `'reveal'`, and the kernel ships its JS references so a
  // subclass (or an app-side scrubber) can predict the frontier on the CPU.
  LINE_REVEAL_GLSL,
  REVEAL_PERSIST_TRAIL_MS,
  resolveRevealTrailLength,
  revealSpanJS,
  revealVertexJS,
  type STTLineLayerOptions,
  type STTLineTimeFilterMode,
  type LineCompiledMode,
} from './layers/line-layer.js';
export {
  STTPolygonLayer,
  type STTPolygonLayerOptions,
  type PolygonTimeFilterMode,
} from './layers/polygon-layer.js';
export {
  STTTripsLayer,
  type STTTripsLayerOptions,
} from './layers/trips-layer.js';
export {
  STTTripHeadsLayer,
  type STTTripHeadsLayerOptions,
  type TripHeadsTimeFilterMode,
} from './layers/trip-heads-layer.js';
export {
  STTHeatmapLayer,
  type STTHeatmapLayerOptions,
  type STTHeatmapTimeFilterMode,
} from './layers/heatmap-layer.js';
export {
  STTIconLayer,
  type STTIconLayerOptions,
  type IconTimeFilterMode,
  // The atlas prop surface: a consumer typing its own sprite sheet needs both
  // the rectangle shape and the accepted image sources.
  type IconMappingEntry,
  type IconAtlasImage,
  type STTIconAtlasSource,
} from './layers/icon-layer.js';
export {
  STTColumnLayer,
  type STTColumnLayerOptions,
  type ColumnTimeFilterMode,
} from './layers/column-layer.js';
export {
  STTArcLayer,
  // Arc CPU references: the same closed forms the vertex shader mirrors, so an
  // app can pre-size an arc's apex (or lay out a legend) without a GPU pass.
  MAX_ARC_SEGMENTS,
  greatCircleMeters,
  arcHeightMeters,
  arcVertexTime,
  type STTArcLayerOptions,
  type ArcTimeFilterMode,
} from './layers/arc-layer.js';

// ── Summary + flow families ──────────────────────────────────────────────────

// Summary tier (h3Summary / quadbinSummary): one abstract cell layer plus the
// two thin scheme subclasses. `STTH3SummaryLayer` REQUIRES an injected
// `cellToBoundary` (h3-js is not a dependency of this package — see the option
// docs), so the `H3CellToBoundary` type ships from the cell-geometry kernel
// below and is named on `STTH3SummaryLayerOptions`.
export {
  STTSummaryCellLayer,
  STTH3SummaryLayer,
  STTQuadbinSummaryLayer,
  SUMMARY_WALL_SHADE,
  summaryCellElevationMeters,
  type STTSummaryCellLayerOptions,
  type STTH3SummaryLayerOptions,
  type STTQuadbinSummaryLayerOptions,
  type SummaryCellTimeFilterMode,
} from './layers/summary-cell-layer.js';

// Hexbin (real runtime aggregation — NOT a fallback to h3Summary): CPU binning
// at tile upload + a GPU scatter/gather aggregate that re-ranges every frame.
export {
  STTHexbinLayer,
  DEFAULT_HEXBIN_COLOR_RANGE,
  type STTHexbinLayerOptions,
  type HexbinTimeFilterMode,
  type HexbinAggregation,
  type HexbinScaleType,
} from './layers/hexbin-layer.js';

// Flow corridor / flow stroke: a ref-stable value-matrix ribbon whose width
// breathes per frame off a single `uFlowBucket` scalar (the FlowCorridorLayer
// re-tessellation bug, designed out).
export {
  STTFlowCorridorLayer,
  STTFlowStrokeLayer,
  corridorHalfWidthMercator,
  type STTFlowCorridorLayerOptions,
  type STTFlowStrokeLayerOptions,
  type FlowCorridorTimeFilterMode,
  type FlowMagnitudeSource,
} from './layers/flow-corridor-layer.js';

// Flowmap: one animated OD arrow per pair, width driven by trip volume at the
// playhead. `liveBundling` (GPU KDEEB) stays a permanent declared fallback —
// the layer carries no bundling path.
export {
  STTFlowmapLayer,
  type STTFlowmapLayerOptions,
  type FlowmapTimeFilterMode,
  type FlowmapColorMode,
  type FlowmapArrowShape,
} from './layers/flowmap-layer.js';
export {
  STTBaseLayer,
  cssToDevicePixel,
  resolveTrailFade,
  expandPickIdColors,
  // How the tile-LOAD window is derived from the render window plus the time
  // mode. Exported so a custom subclass composes the same floors instead of
  // re-deriving them (and so the rule is testable on its own).
  widenLoadWindowForTimeMode,
  type TimeModeLoadKnobs,
  type STTBaseLayerOptions,
  // ONE spelling of the mode union for the whole package; every layer's
  // `*TimeFilterMode` alias above resolves to it.
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  type PickProvenanceEntry,
  type RGBA,
  type RGBA8,
} from './base-layer.js';

// Mercator + metric-sizing math. `mercatorZFromAltitude` /
// `metersToPixelsAtLatitude` are what `radiusUnits`/`widthUnits: 'meters'` and
// polygon `elevation` (metres) resolve through — exported so an embedder can
// pre-compute the same factors, and so a custom subclass sizes identically.
export {
  lngLatToMercator,
  projectPositions,
  latFromMercatorY,
  tileCenterLatitude,
  metersPerMercatorUnit,
  mercatorZFromAltitude,
  metersToMercatorUnits,
  metersToPixelsAtLatitude,
  EARTH_RADIUS_M,
  EARTH_CIRCUMFERENCE_M,
} from './lib/projection.js';

// GPU DataFilter kernel. Every layer's options interface
// EXTENDS `STTDataFilterOptions`, so consumers need to be able to name it (and
// `DataFilterRange`) to type a filter-driving component; the GLSL + CPU helpers
// come along for custom subclasses that want the same semantics.
export {
  DATA_FILTER_GLSL,
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_UNIFORMS_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_NAMES,
  dataFilterAlphaJS,
  createDataFilterUniforms,
  resolveDataFilterUniforms,
  extractFilterColumn,
  expandFilterValues,
  type STTDataFilterOptions,
  type DataFilterRange,
  type DataFilterUniforms,
  type FilterColumn,
} from './shaders/data-filter.glsl.js';

// Time-filter kernel: the four mode snippets plus their JS reference
// impls, for subclasses that build their own shaders against the same math.
export {
  TIME_WINDOW_GLSL,
  TIME_TRAIL_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  timeWindowAlphaJS,
  trailAlphaJS,
  wakeAlphaJS,
  wakeSizeScaleJS,
  cumulativeAlphaJS,
} from './shaders/time-window.glsl.js';

// Elevated-projection kernel: the one implementation of
// the metres-vs-mercator-z split and the globe horizon-clip re-derivation that
// polygon/column/arc all raise geometry through. Exported for a subclass that
// wants to leave the ground without re-deriving maplibre's contract.
export {
  buildElevatedProjection,
  GLOBE_ELEVATION_STEPS,
  type ElevatedProjectionOptions,
  type ElevatedProjectionNames,
} from './shaders/globe-elevation.glsl.js';

// Billboard (point-sprite) disc kernel: shared by the point and trip-heads
// layers so their VISUAL disc and their PICK hit area cannot drift apart.
export {
  discMaskGLSL,
  buildBillboardIdFragmentSource,
  DISC_R2_MAX,
  DISC_R2_SOFT,
  DISC_EDGE_EXPR,
} from './shaders/billboard.glsl.js';

// Shared tileset source: ONE archive + ONE tileset serving N layers.
// Construct one per .stt, pass it to each layer as `{ source }`, and register
// its getBufferSource() with a PlaybackGovernor once per source.
export {
  SharedTilesetSource,
  SharedTilesetBufferSource,
  residentSetEqual,
  tileKey,
  type SharedTilesetSourceOptions,
  type SharedViewport,
  type TilesetConsumer,
  type DrivableTileset,
  type RunwayTileset,
} from './lib/streaming-source.js';

// Composite host: ONE custom layer hosting an ordered list of STT layers,
// driven in a single render pass so a stacked composite (weather suite, AV
// substrates) pays MapLibre's per-custom-layer state cycle ONCE instead of N
// times. Pair it with a SharedTilesetSource so the stacked layers also share
// one archive + governor BufferSource. `setCurrentTime` / `setTimeWindow` fan
// out to every child behind a single coalesced repaint.
export { STTLayerGroup, type STTLayerGroupOptions } from './layer-group.js';

// Host render-signature adapter: the normalized per-frame shape layers
// draw from, public for full-render()-override subclasses and tests.
export {
  createHostFrame,
  normalizeRenderArgs,
  DEFAULT_FOV_RADIANS,
  type HostFrame,
  type HostShaderData,
  type HostProjectionData,
} from './lib/host-adapter.js';

// Mapbox host detection + Standard-style slot vocabulary.
// `MapboxSlot` types a `STTBaseLayer.attach({ slot })` / `STTBaseLayer.slot`
// value; `isMapboxHost` duck-types a Mapbox GL v3 host apart from MapLibre
// (structural only — no mapbox-gl dependency); `isValidMapboxSlot` is the
// runtime guard for a value crossing the untyped JS boundary.
export {
  isMapboxHost,
  isValidMapboxSlot,
  type MapboxSlot,
} from './lib/host-slot.js';

// Globe correctness kit: mercator-space subdivision + wrap/granularity
// helpers for custom subclasses targeting v5+ globe hosts.
export {
  subdivideLineMercator,
  subdivideTrianglesMercator,
  shouldDrawWorldCopy,
  granularityForZoom,
  type AttrArray,
  type SubdivisionAttrs,
  type LineSubdivisionResult,
} from './lib/globe.js';

// Cell-geometry kernel (summary/hexbin families): pure CPU decode of
// H3 / Quadbin cell ids and the deck-compatible hexbin lattice into mercator
// rings. `H3CellToBoundary` is the h3-js `cellToBoundary` signature the h3
// summary layer takes injected (h3-js is not a dependency of this package —
// the caller supplies the resolver). Every entry point is tile-upload-time.
export {
  ringSignedArea2,
  orientRingPositive,
  h3IndexFromU64,
  h3CellToMercatorRing,
  quadbinToTile,
  quadbinTileToMercatorBounds,
  quadbinCellToMercatorRing,
  hexBinRadiusFromMeters,
  pointToHexBin,
  hexBinKey,
  hexBinKeyForPoint,
  hexBinCentroidMercator,
  hexBinToMercatorRing,
  buildSummaryCellRings,
  cellRingToTriangles,
  triangulateCellRings,
  type H3CellToBoundary,
  type SeamMode,
  type PoleMode,
  type CellRingOptions,
  type CellRingBatch,
  type CellRingDiagnostics,
  type QuadbinTile,
  type MercatorBounds,
  type SummaryCellRingOptions,
} from './lib/cell-geometry.js';

// Flow kernel (flow family): the ref-stable value-matrix packing +
// per-frame bucket axis + corridor ribbon tessellation. Geometry is built once
// per tile; only `uFlowBucket` moves per frame (the re-tessellation bug,
// designed out). Exported for subclasses driving the same GPU magnitude path.
export {
  deriveFlowAxis,
  bucketPositionAt,
  packValueMatrix,
  packVertexValueMatrix,
  buildCorridorRibbon,
  extractFlowOdPairs,
  flowTileKey,
  FlowTileCache,
  supportsVertexTextureFetch,
  chooseFlowMatrixFormat,
  mercatorPerPixel,
  MAX_FLOW_MATRIX_TEXELS,
  type FlowBucketAxis,
  type PackedValueMatrix,
  type CorridorRibbon,
  type CorridorRibbonOptions,
  type FlowOdPairs,
} from './lib/flow-kernel.js';

// Flow GLSL (flow family): the vertex-stage magnitude sampler + width
// kernel and their JS references. `flowSamplerCacheKey` MUST appear in a flow
// program's cache key (a matrix-format permutation axis).
export {
  FLOW_MATRIX_FORMATS,
  FLOW_NAMES,
  FLOW_MATRIX_TEXTURE_RECIPE,
  buildFlowMatrixSampler,
  flowSamplerCacheKey,
  flowWidthJS,
  flowRampTJS,
  type FlowMatrixFormat,
} from './shaders/flow.glsl.js';

// Shared id-buffer picking result shape (see `STTBaseLayer.pick`). Re-exported
// from the core picking kernel so consumers don't reach across packages.
export type { SttPickResult } from '@poopdeck.gl/core/picking';

// Backend capability descriptor — what this adapter declares against the shared
// `@poopdeck.gl/core/capabilities` vocabulary, plus the per-layer feature
// matrix mirroring `deckLayerFeatures`.
export {
  maplibreBackend,
  maplibreLayerFeatures,
  LAYER_FEATURES,
  type LayerFeature,
  type LayerFeatureSupport,
} from './backend-descriptor.js';
