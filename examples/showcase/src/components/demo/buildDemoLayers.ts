/**
 * Shared data-layer builder for the live demo map AND the scrubber's hover
 * preview. Extracted verbatim from DemoViewer's `layers` memo so the two
 * surfaces render the same layer types + styling and cannot drift: the live
 * viewer calls this with the real governor/overview plumbing, and HoverPreview
 * calls it with empty plumbing + a flat (timeHeightScale 0) frozen controller.
 *
 * The space-time-cube OVERLAY layers (tile lattice, now-plane) deliberately
 * stay in DemoViewer — they ride the 20 Hz UI clock and are not part of the
 * dataset's own layer tree.
 */
import { SolidPolygonLayer } from "@deck.gl/layers";
import {
  AnimatedPointLayer,
  AnimatedPathLayer,
  AnimatedTripsLayer,
  FlowCorridorLayer,
  AnimatedPolygonLayer,
  HeatmapLayer,
  H3SummaryLayer,
  QuadbinSummaryLayer,
  AnimatedArcLayer,
  AnimatedColumnLayer,
  AnimatedTripHeadsLayer,
  FlowmapLayer,
  BundledFlowmapLayer,
  AnimatedBoundingBoxLayer,
} from "@poopdeck.gl/layers";
import type { HeatmapChannelSpec, OverviewPreloadResult } from "@poopdeck.gl/layers";
import type {
  BufferSource,
  BufferedRunway,
  TimeController,
} from "@poopdeck.gl/playback";
import { tileLoadingProps } from "../../types";
import type { Dataset, SummaryToggleOption } from "../../types";

/**
 * luma.gl v9 render parameters for a FLAT GROUND DECAL — the AV HD-map
 * substrate (drivable-area / lane / crosswalk polygons + lane-divider lines).
 * nuScenes ships these as many OVERLAPPING, semi-transparent polygons all at
 * z=0; with normal depth testing the coplanar fragments fight for the depth
 * buffer and flicker as the camera moves. `depthCompare: 'always'` lets every
 * fragment pass (so the overlaps just alpha-composite in painter's order), and
 * `depthWriteEnabled: false` keeps the flat map out of the depth buffer so the
 * 3D content drawn ABOVE it (LIDAR cloud / object boxes) still depth-tests
 * correctly among itself. Same idiom as edge-bundler.ts's offscreen passes.
 */
const GROUND_DECAL_PARAMETERS = {
  depthCompare: "always" as const,
  depthWriteEnabled: false,
};

const EARTH_POLYGON: number[][][] = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

/**
 * Per-source registration API the app (the governor owner) hands down so that
 * EVERY layer in a composite is classified into the {@link PlaybackGovernor}'s
 * N-source registry, not just the field. This is Phase 0 of multi-source
 * coordination (docs/roadmap/multi-source-coordination.md §5): the clock must
 * wait for every *required* source, while *optional* overlays load but never
 * gate (continue-and-degrade). Keyed by each layer's deck.gl `id`.
 *
 * The governor owner implements:
 *   registerSource(id, tileset, {required}) → governor.addSource(id, tileset, {required})
 *   unregisterSource(id)                    → governor.removeSource(id)
 *   onBufferChange(id, runway)              → governor.notifyBufferChange(runway)
 *     (the governor re-probes all sources itself; the runway arg is advisory.)
 */
export interface DemoSourceRegistry {
  registerSource: (
    id: string,
    tileset: BufferSource,
    opts?: { required?: boolean; weight?: number },
  ) => void;
  unregisterSource: (id: string) => void;
  onBufferChange: (id: string, runway: BufferedRunway) => void;
}

/**
 * Governor/overview callbacks the LIVE viewer wires through. The hover preview
 * passes none of these — it is a throwaway static render, not part of the
 * buffering machine.
 */
export interface DemoLayerPlumbing {
  /**
   * Multi-source registration API. When present, EACH layer's tileset is
   * registered as a classified governor source (field/primary = required,
   * overlays = optional). Preferred over the legacy single-source pair below.
   */
  registry?: DemoSourceRegistry;
  /**
   * @deprecated Legacy single-source plumbing (one shared field tileset → the
   * governor). Superseded by {@link DemoSourceRegistry}. Still honored when
   * `registry` is absent so callers can migrate independently; a caller passing
   * both gets the registry path (these are ignored).
   */
  onTilesetReady?: (tileset: BufferSource) => void;
  /** @deprecated See {@link DemoLayerPlumbing.onTilesetReady}. */
  onBufferChange?: (runway: BufferedRunway) => void;
  onOverviewPreload?: (result: OverviewPreloadResult) => void;
  /** Pin the coarse z0–z1 storyboard tiles (live viewer only). @default false */
  overviewPreload?: boolean;
}

export interface BuildDemoLayersArgs {
  dataset: Dataset;
  /** The clock the layers read live time from (the shared one, or a frozen preview one). */
  timeController: TimeController;
  useGlobe: boolean;
  /** Space-time-cube height scale (meters per sim-ms); 0 = flat. */
  timeHeightScale: number;
  /** Active summary-tier weight toggle, if the dataset declares one. */
  activeSummaryToggle?: SummaryToggleOption;
  plumbing?: DemoLayerPlumbing;
}

export function buildDemoLayers({
  dataset: selectedDataset,
  timeController,
  useGlobe,
  timeHeightScale,
  activeSummaryToggle,
  plumbing,
}: BuildDemoLayersArgs) {
  const {
    registry,
    onTilesetReady: legacyOnTilesetReady,
    onBufferChange: legacyOnBufferChange,
    onOverviewPreload,
    overviewPreload = false,
  } = plumbing ?? {};

  // Per-layer governor plumbing. Each layer registers ITS OWN tileset under its
  // deck.gl id with a role-based `required` flag (field/primary = required,
  // overlays = optional). When the app supplies a `registry`, that is the
  // multi-source path; otherwise we fall back to the legacy single-source pair
  // (which only the REQUIRED field carries) so un-migrated callers keep working.
  const sourceProps = (
    layerId: string,
    required: boolean,
  ): {
    onTilesetReady?: (tileset: BufferSource) => void;
    onBufferChange?: (runway: BufferedRunway) => void;
  } => {
    if (registry) {
      return {
        onTilesetReady: (tileset: BufferSource) =>
          registry.registerSource(layerId, tileset, { required }),
        onBufferChange: (runway: BufferedRunway) =>
          registry.onBufferChange(layerId, runway),
      };
    }
    // Legacy single-source fallback: only the REQUIRED (field/primary) layer
    // talks to the governor, exactly as before this wave. Overlays get nothing.
    return required
      ? {
          onTilesetReady: legacyOnTilesetReady,
          onBufferChange: legacyOnBufferChange,
        }
      : { onTilesetReady: undefined, onBufferChange: undefined };
  };

  const datasetDuration =
    selectedDataset.timeRange.end - selectedDataset.timeRange.start;
  const playbackSpeed =
    datasetDuration / (selectedDataset.targetPlaybackSeconds || 60) / 1000;
  // Cumulative ("draw and persist") datasets reveal progressively in the
  // shader, so the tile loader must keep every played-through bucket
  // resident. A symmetric window of 2× the dataset duration guarantees the
  // loader's [t-w/2, t+w/2] always covers the whole [start, end] range — at
  // metro/viewport scale this loads the visible city's tiles once and retains
  // them. Non-cumulative datasets keep their per-dataset rolling window.
  const isCumulative = !!selectedDataset.cumulative;
  const timeWindow = isCumulative
    ? datasetDuration * 2
    : selectedDataset.timeWindow || 86400000;

  const baseProps = {
    id: selectedDataset.id,
    data: selectedDataset.url,
    // Seed with the initial time. The layer reads the live time from the
    // shared TimeController every draw — we deliberately do NOT thread
    // the React `currentTime` state in here, because that would invalidate
    // the layer prop tree at 60Hz and force deck.gl to re-run updateState
    // (and the trip consolidation cache) on every tick.
    currentTime: selectedDataset.timeRange.start,
    timeController,
    timeWindow,
    timeRange: selectedDataset.timeRange,
    // Tile-tier dispatch. Defaults to 'auto' (summary overview at low zoom);
    // datasets can force 'raw' when the summary overlay obscures the story.
    tier: selectedDataset.tier,
    opacity: selectedDataset.opacity ?? 0.8,
    pickable: false,
    // Shared prefetch/concurrency recipe (see tileLoadingProps): a few real
    // seconds of sim-time lookahead, floored at the resident window.
    ...tileLoadingProps(timeWindow, playbackSpeed),
    // Playback-governor plumbing is NOT baked into baseProps anymore: each
    // single-layer demo and each composite layer applies its own role-based
    // `sourceProps(id, required)` so EVERY tileset is registered (Phase 0).
    // Storyboard preview tier: pin z0–z1 across the full time range so
    // scrubbing always renders SOMETHING (default 20 MiB budget gate — the
    // tileset rejects datasets with giant coarse tiles, e.g. satellites).
    overviewPreload,
    onOverviewPreload,
    // Space-time cube: 0 (inert) unless the dataset opts in via timeHeight.
    timeHeightScale,
    timeHeightOrigin: selectedDataset.timeRange.start,
  };

  switch (selectedDataset.type) {
    case "point":
      return [
        new AnimatedPointLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          fillColor: selectedDataset.colorProperty || [31, 186, 214, 255],
          colorMapping: selectedDataset.colorMapping,
          colorMappingDefault: selectedDataset.colorMappingDefault,
          radius:
            selectedDataset.radiusProperty ?? selectedDataset.radius ?? 1000,
          // Per-dataset styling overrides; legacy datasets stay on the old
          // meters/×2 default so ship and flight markers keep their look.
          radiusUnits: selectedDataset.radiusUnits ?? "meters",
          radiusScale: selectedDataset.radiusScale ?? 2,
          radiusMinPixels: selectedDataset.radiusMinPixels,
          radiusMaxPixels: selectedDataset.radiusMaxPixels,
          radiusTransform: selectedDataset.radiusTransform,
          stroked: selectedDataset.stroked,
          strokeColor: selectedDataset.strokeColor,
          lineWidthMinPixels: selectedDataset.lineWidthMinPixels,
          wakeLength: selectedDataset.wakeLength,
          wakeTailScale: selectedDataset.wakeTailScale,
          // Cumulative "draw the map" mode (e.g. OSM node creations): points
          // appear at their creation time and persist. fadeInDuration (sim-ms)
          // doubles as the "ink appearing" ramp.
          cumulative: selectedDataset.cumulative,
          fadeInDuration: selectedDataset.fadeInDuration,
          use3D: selectedDataset.use3D,
          elevationProperty: selectedDataset.elevationProperty,
          elevationScale: selectedDataset.elevationScale,
        }),
      ];
    case "path":
      return [
        new AnimatedPathLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          pathColor:
            selectedDataset.colorProperty ||
            selectedDataset.pathColor ||
            [31, 186, 214, 255],
          pathWidth: selectedDataset.pathWidth ?? 3,
          widthUnits: selectedDataset.widthUnits ?? "pixels",
          // Same fragment-cost story as trips: rounded is the dominant cost
          // on dense Manhattan paths at small widths; default off.
          capRounded: selectedDataset.capRounded ?? false,
          jointRounded: selectedDataset.jointRounded ?? false,
        }),
      ];
    case "trip-heads":
      // A smooth moving point at each active trip's head via AnimatedTripHeadsLayer
      // (stock ScatterplotLayer + CPU per-frame position interpolation) — fp64,
      // no jitter, no custom GLSL.
      return [
        new AnimatedTripHeadsLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          headColor: selectedDataset.headColor ?? [253, 128, 93, 255],
          headRadiusPixels: selectedDataset.headRadiusPixels ?? 4,
          // World-space sizing (meters) so heads emerge on zoom like the
          // maritime points; defaults to pixels (legacy look).
          sizeUnits: selectedDataset.headSizeUnits,
          headRadius: selectedDataset.headRadius,
          headRadiusMinPixels: selectedDataset.headRadiusMinPixels,
          headRadiusMaxPixels: selectedDataset.headRadiusMaxPixels,
        }),
      ];
    case "trips": {
      // Static-geometry overviews (flow corridors) carry a per-vertex ×
      // per-bucket value matrix and animate via FlowCorridorLayer — the
      // geometry loads once and only the active bucket column changes.
      const TripsLayerCtor = selectedDataset.flowMatrix
        ? FlowCorridorLayer
        : AnimatedTripsLayer;
      const tripsLayer = new TripsLayerCtor({
        ...baseProps,
        ...sourceProps(selectedDataset.id, true),
        // useGlobe / useGlobalBounds / zoomOverride let a dataset opt into
        // a global tile load without bespoke per-id branching here. Globe
        // mode forces global bounds because GlobeView's unproject() at low
        // zoom returns degenerate bounds — without it the tile loader sees
        // a tiny visible box and never requests the polar/back-side tiles.
        ...(selectedDataset.zoomOverride !== undefined && {
          zoomOverride: selectedDataset.zoomOverride,
        }),
        ...((selectedDataset.useGlobalBounds || useGlobe) && {
          useGlobalBounds: true,
        }),
        // A categorical `colorProperty` is passed as the property-name form
        // of `tripColor`; `colorMapping` keeps colors stable across tiles.
        tripColor:
          selectedDataset.colorProperty ??
          selectedDataset.tripColor ??
          [31, 186, 214, 255],
        ...(selectedDataset.colorMapping && {
          colorMapping: selectedDataset.colorMapping,
        }),
        ...(selectedDataset.colorMappingDefault && {
          colorMappingDefault: selectedDataset.colorMappingDefault,
        }),
        // Per-vertex gradient (e.g. ocean-drifter SST) shades the line along
        // its length and takes precedence over categorical `tripColor`.
        ...(selectedDataset.tripGradient && {
          gradientProperty: selectedDataset.tripGradient.property,
          gradientDomain: selectedDataset.tripGradient.domain,
          gradientColorRamp: selectedDataset.tripGradient.colors,
        }),
        tripWidth: selectedDataset.tripWidth ?? 4,
        // World-space widths (meters) when a dataset opts in, so trails
        // thicken on zoom like the maritime points; defaults to pixels.
        widthUnits: selectedDataset.widthUnits ?? "pixels",
        widthMinPixels: selectedDataset.widthMinPixels ?? 2,
        widthMaxPixels: selectedDataset.widthMaxPixels ?? 8,
        trailLength: selectedDataset.trailLength ?? 60000,
        fadeTrail: selectedDataset.fadeTrail ?? true,
        // Rounded caps/joints are the dominant fragment-shader cost at small
        // widths; default off and let datasets opt in.
        capRounded: selectedDataset.capRounded ?? false,
        jointRounded: selectedDataset.jointRounded ?? false,
      });
      if (useGlobe) {
        return [
          new SolidPolygonLayer({
            id: "earth-background",
            data: EARTH_POLYGON,
            getPolygon: (d) => d as any,
            stroked: false,
            filled: true,
            getFillColor:
              selectedDataset.globeBackgroundColor ?? [36, 39, 48, 255],
          }),
          tripsLayer,
        ];
      }
      return [tripsLayer];
    }
    case "heatmap": {
      // Stacked heatmaps now compile down to ONE HeatmapLayer with N
      // channels packed into the RGBA accumulator — half the draw calls
      // and one shared FBO. The legacy per-spec sublayer fanout is gone.
      const specs = selectedDataset.heatmapLayers ?? [];
      if (specs.length === 0) {
        return [
          new HeatmapLayer({
            ...baseProps,
            ...sourceProps(selectedDataset.id, true),
            radiusPixels: 30,
            intensity: 1,
            colorRange: [
              [255, 255, 178, 255],
              [254, 204, 92, 255],
              [253, 141, 60, 255],
              [240, 59, 32, 255],
              [189, 0, 38, 255],
            ],
            weightProperty: selectedDataset.weightProperty,
            // TAA — visible smoothness boost at no measurable cost.
            historyWeight: 0.15,
          }),
        ];
      }
      // Pick the first spec's radius/intensity for the layer-wide values
      // (the per-channel intensity multiplier still composes on top).
      const first = specs[0];
      const channels: HeatmapChannelSpec[] = specs.slice(0, 4).map((spec) => ({
        id: spec.id,
        categoryFilter: spec.categoryFilter,
        colorRange: spec.colorRange,
        colorDomain: spec.colorDomain ?? undefined,
        intensity: spec.intensity ?? 1,
      }));
      return [
        new HeatmapLayer({
          ...baseProps,
          id: `${selectedDataset.id}-heatmap`,
          ...sourceProps(`${selectedDataset.id}-heatmap`, true),
          radiusPixels: first.radiusPixels ?? 30,
          intensity: 1,
          weightProperty:
            first.weightProperty ?? selectedDataset.weightProperty,
          channels,
          historyWeight: 0.15,
        }),
      ];
    }
    case "polygon":
      return [
        new AnimatedPolygonLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          filled: selectedDataset.polygonFilled ?? true,
          stroked: selectedDataset.polygonStroked ?? false,
          lineWidthUnits: selectedDataset.polygonLineWidthUnits ?? "pixels",
          lineWidth: selectedDataset.polygonLineWidth ?? 2,
          lineColor: selectedDataset.polygonLineColor ?? [31, 186, 214, 255],
          fillColor:
            selectedDataset.colorProperty ||
            selectedDataset.polygonFillColor ||
            [31, 186, 214, 180],
          // Categorical fills keyed by category STRING (stable across tiles);
          // only meaningful alongside a `colorProperty` fillColor.
          ...(selectedDataset.colorMapping && {
            colorMapping: selectedDataset.colorMapping,
          }),
          ...(selectedDataset.colorMappingDefault && {
            colorMappingDefault: selectedDataset.colorMappingDefault,
          }),
        }),
      ];
    case "summary": {
      // If the dataset declares a toggle (e.g. pickup vs dropoff), the
      // active option overrides the base summary styling props. Otherwise
      // fall back to the dataset's single-weight settings.
      const weightProperty =
        activeSummaryToggle?.weightProperty ??
        selectedDataset.summaryWeightProperty ??
        "count";
      const colorRange =
        activeSummaryToggle?.colorRange ?? selectedDataset.summaryColorRange;
      const colorDomain =
        activeSummaryToggle?.colorDomain ?? selectedDataset.summaryColorDomain;
      const summaryId = `${selectedDataset.id}-${activeSummaryToggle?.id ?? "default"}`;
      return [
        new H3SummaryLayer({
          id: summaryId,
          data: selectedDataset.url,
          currentTime: selectedDataset.timeRange.start,
          timeController,
          timeWindow,
          // Required (single-source) governor plumbing, keyed by the layer id.
          ...sourceProps(summaryId, true),
          weightProperty,
          colorRange,
          colorDomain,
          extruded: selectedDataset.summaryExtruded ?? false,
          elevationScale: selectedDataset.summaryElevationScale ?? 1,
          coverage: selectedDataset.summaryCoverage ?? 0.92,
          opacity: 0.85,
          pickable: false,
        }),
      ];
    }
    case "arc":
      // Origin→destination flow arcs. Each tile feature is a 2-vertex
      // LineString (first vertex = source, last = target); the layer derives
      // instanced source/target positions and bows an arc between them, faded
      // in/out by the time window (pickup→dropoff overlap).
      return [
        new AnimatedArcLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          sourceColor:
            selectedDataset.colorProperty ??
            selectedDataset.arcSourceColor ??
            [56, 196, 232, 210],
          targetColor: selectedDataset.arcTargetColor ?? [255, 142, 64, 220],
          ...(selectedDataset.colorPalette && {
            colorPalette: selectedDataset.colorPalette,
          }),
          width: selectedDataset.arcWidth ?? 1.5,
          widthUnits: selectedDataset.widthUnits ?? "pixels",
          widthMinPixels: selectedDataset.widthMinPixels ?? 1,
          widthMaxPixels: selectedDataset.widthMaxPixels,
          greatCircle: selectedDataset.arcGreatCircle ?? false,
          arcHeight: selectedDataset.arcHeight ?? 1,
          fadeInDuration: selectedDataset.fadeInDuration ?? 300,
        }),
      ];
    case "flowmap":
      // flowmap.gl-style animated OD flowmap: one weighted tapered arrow per
      // station-pair whose width tracks volume at the playhead (per-bucket
      // vertexValueMatrix decode, rendered via FlowLinesLayer), plus node
      // circles sized by incident flow. Geometry spans the whole time range —
      // loads once, animates from the matrix.
      return [
        new FlowmapLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          widthScale: selectedDataset.flowWidthScale ?? 1.1,
          widthMinPixels: selectedDataset.flowWidthMinPixels ?? 1,
          widthMaxPixels: selectedDataset.flowWidthMaxPixels ?? 12,
          sourceColor: selectedDataset.flowSourceColor ?? [56, 196, 232, 235],
          targetColor: selectedDataset.flowTargetColor ?? [255, 142, 64, 245],
          gap: selectedDataset.flowGap ?? 0.5,
          nodeRadiusScale: selectedDataset.flowNodeRadiusScale ?? 1.3,
          ...(selectedDataset.flowNodeRadiusUnits && {
            nodeRadiusUnits: selectedDataset.flowNodeRadiusUnits,
          }),
          ...(selectedDataset.flowNodeColor && {
            nodeColor: selectedDataset.flowNodeColor,
          }),
          minFlow: selectedDataset.flowMinFlow ?? 0.25,
        }),
      ];
    case "flowmap-bundled":
      // Same OD flowmap, but compatible corridors are relaxed into smooth rivers
      // by a GPU kernel-density edge bundler (KDEEB/CUBu — density splat → advect
      // → resample → Laplacian smooth, cosmos.gl-style ping-pong float textures)
      // and rendered fully GPU-resident — the bundle is computed once and stays on
      // the GPU; only ribbon width animates. Falls back to straight arrows on
      // devices that can't additively blend into a float texture.
      return [
        new BundledFlowmapLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          widthScale: selectedDataset.flowWidthScale ?? 1.1,
          widthMinPixels: selectedDataset.flowWidthMinPixels ?? 1,
          widthMaxPixels: selectedDataset.flowWidthMaxPixels ?? 12,
          sourceColor: selectedDataset.flowSourceColor ?? [56, 196, 232, 235],
          targetColor: selectedDataset.flowTargetColor ?? [255, 142, 64, 245],
          gap: selectedDataset.flowGap ?? 0.5,
          nodeRadiusScale: selectedDataset.flowNodeRadiusScale ?? 1.3,
          ...(selectedDataset.flowNodeColor && {
            nodeColor: selectedDataset.flowNodeColor,
          }),
          minFlow: selectedDataset.flowMinFlow ?? 0.25,
          ...(selectedDataset.flowNodeRadiusUnits && {
            nodeRadiusUnits: selectedDataset.flowNodeRadiusUnits,
          }),
          ...(selectedDataset.flowNodeRadiusMaxPixels != null && {
            nodeRadiusMaxPixels: selectedDataset.flowNodeRadiusMaxPixels,
          }),
          subdivisionPoints: selectedDataset.flowSubdivisionPoints ?? 48,
          kernelRadius: selectedDataset.flowKernelRadius ?? 0.05,
          bundlingIterations: selectedDataset.flowBundlingIterations ?? 15,
          smoothingStrength: selectedDataset.flowSmoothingStrength ?? 0.5,
          ...(selectedDataset.flowMaxBundledEdges != null && {
            maxBundledEdges: selectedDataset.flowMaxBundledEdges,
          }),
          // Tiles built with `--bake-bundling` carry the rivers already; skip the
          // live GPU bundler and render the precomputed geometry.
          ...(selectedDataset.flowPreBundled && { preBundled: true }),
        }),
      ];
    case "column":
      // Extruded 3D columns at point features; height from a numeric column.
      return [
        new AnimatedColumnLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          radius: selectedDataset.columnRadius ?? 100,
          radiusUnits: selectedDataset.columnRadiusUnits ?? "meters",
          diskResolution: selectedDataset.columnDiskResolution ?? 12,
          extruded: true,
          elevation:
            selectedDataset.elevationProperty ??
            selectedDataset.columnElevation ??
            1000,
          elevationScale: selectedDataset.elevationScale ?? 1,
          fillColor:
            selectedDataset.colorProperty ??
            selectedDataset.columnFillColor ??
            [253, 128, 93, 220],
          ...(selectedDataset.colorPalette && {
            colorPalette: selectedDataset.colorPalette,
          }),
          fadeInDuration: selectedDataset.fadeInDuration ?? 300,
        }),
      ];
    case "quadbin-summary": {
      // CARTO Quadbin square-cell analog of the H3 summary tier. Mirrors the
      // `summary` case: the layer clamps to the tier's zoom band and reads the
      // aggregated `count` (or a toggle weight) per cell. Quadbin cells carry
      // no per-bucket TimeFilter — they are pre-aggregated per time bucket.
      const weightProperty =
        activeSummaryToggle?.weightProperty ??
        selectedDataset.summaryWeightProperty ??
        "count";
      const colorRange =
        activeSummaryToggle?.colorRange ?? selectedDataset.summaryColorRange;
      const colorDomain =
        activeSummaryToggle?.colorDomain ?? selectedDataset.summaryColorDomain;
      const quadbinId = `${selectedDataset.id}-${activeSummaryToggle?.id ?? "default"}`;
      return [
        new QuadbinSummaryLayer({
          id: quadbinId,
          data: selectedDataset.url,
          currentTime: selectedDataset.timeRange.start,
          timeController,
          timeWindow,
          ...sourceProps(quadbinId, true),
          weightProperty,
          colorRange,
          colorDomain,
          extruded: selectedDataset.summaryExtruded ?? false,
          elevationScale: selectedDataset.summaryElevationScale ?? 1,
          coverage: selectedDataset.summaryCoverage ?? 0.92,
          opacity: 0.85,
          pickable: false,
        }),
      ];
    }
    case "radar": {
      // Composite NEXRAD render. Three STT archives from one dataset entry:
      //   1. reflectivity CONTOUR BANDS (the field) — primary `url`, reuses
      //      baseProps verbatim and is the REQUIRED governor source so the clock
      //      gates on the heaviest stream (the categorical `dbz_band` fill, GPU
      //      CategoryColorExtension);
      //   2. storm-cell TRACKS (AnimatedTripsLayer, per-vertex intensity);
      //   3. storm-cell CENTROIDS (AnimatedPointLayer, sized by max_dbz).
      // Phase 0 multi-source: the overlays are now registered as OPTIONAL
      // governor sources (required:false) — they load and stream coordinated
      // with the rest, but never gate the clock (continue-and-degrade). They no
      // longer have their governor plumbing stripped; only the overview-preload
      // tier stays field-only (the storyboard pins the primary archive).
      // Painter order: field (backdrop) → tracks → centroids (topmost).
      const overlayBase = {
        ...baseProps,
        onOverviewPreload: undefined,
        overviewPreload: false,
      };
      const layers: any[] = [
        new AnimatedPolygonLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          filled: true,
          stroked: false,
          // String fillColor = property name → GPU categorical fill; colorMapping
          // keeps each dBZ band stable across tiles (the wildfires/severity pattern).
          fillColor: selectedDataset.colorProperty ?? "dbz_band",
          ...(selectedDataset.colorMapping && {
            colorMapping: selectedDataset.colorMapping,
          }),
          ...(selectedDataset.colorMappingDefault && {
            colorMappingDefault: selectedDataset.colorMappingDefault,
          }),
        }),
      ];
      if (selectedDataset.radarTracksUrl) {
        layers.push(
          new AnimatedTripsLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-tracks`,
            ...sourceProps(`${selectedDataset.id}-tracks`, false),
            data: selectedDataset.radarTracksUrl,
            tripColor: selectedDataset.tripColor ?? [255, 255, 255, 200],
            // Per-vertex intensity (max_dbz over time) shades the trail.
            ...(selectedDataset.tripGradient && {
              gradientProperty: selectedDataset.tripGradient.property,
              gradientDomain: selectedDataset.tripGradient.domain,
              gradientColorRamp: selectedDataset.tripGradient.colors,
            }),
            tripWidth: selectedDataset.tripWidth ?? 3,
            widthUnits: selectedDataset.widthUnits ?? "pixels",
            widthMinPixels: selectedDataset.widthMinPixels ?? 1.5,
            widthMaxPixels: selectedDataset.widthMaxPixels ?? 6,
            trailLength: selectedDataset.trailLength ?? 1800000,
            fadeTrail: selectedDataset.fadeTrail ?? true,
            capRounded: false,
            jointRounded: false,
          }),
        );
      }
      if (selectedDataset.radarCellsUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-cells`,
            ...sourceProps(`${selectedDataset.id}-cells`, false),
            data: selectedDataset.radarCellsUrl,
            fillColor: selectedDataset.radarCellColor ?? [255, 255, 255, 230],
            radius: selectedDataset.radiusProperty ?? "max_dbz",
            radiusUnits: selectedDataset.radiusUnits ?? "pixels",
            radiusScale: selectedDataset.radiusScale ?? 1,
            radiusMinPixels: selectedDataset.radiusMinPixels ?? 2,
            radiusMaxPixels: selectedDataset.radiusMaxPixels ?? 14,
            radiusTransform: selectedDataset.radiusTransform,
            stroked: selectedDataset.stroked ?? true,
            strokeColor: selectedDataset.strokeColor ?? [8, 12, 24, 220],
            lineWidthMinPixels: selectedDataset.lineWidthMinPixels ?? 1,
          }),
        );
      }
      return layers;
    }
    case "av": {
      // Composite AV-telemetry render (streetscape.gl style). Up to three STT
      // archives from one scene bundle, painter order LIDAR → ego → objects:
      //   1. accumulated LIDAR point cloud — the primary `url`; reuses baseProps
      //      verbatim so the playback governor gates on the heaviest stream
      //      (categorical `height_band` fill via the colorMapping machinery);
      //   2. the ego trajectory (AnimatedTripsLayer) from `avEgoUrl`;
      //   3. tracked-object oriented 3D boxes (AnimatedBoundingBoxLayer) from
      //      `avObjectsUrl`, colored by categorical `category`.
      // Multi-source gating: the LIDAR / ego / objects streams are co-equal
      // views of the SAME instant, so all three register as REQUIRED governor
      // sources. The gate is min(runway) over required sources and the heavy
      // LIDAR dominates it, so requiring the TINY ego trip + object boxes adds
      // ~no latency — but it keeps the boxes/ego locked to the cloud on seek /
      // cold-start / fast playback instead of trailing it (they're optional no
      // longer). The HD-map substrate stays OPTIONAL: it's a static backdrop,
      // not a per-instant view. Only the PRIMARY archive (`url` — LIDAR, or the
      // ego trips on LIDAR-less scenes like comma.ai) keeps the overview-preload
      // tier (the storyboard pins one archive).
      const overlayBase = {
        ...baseProps,
        onOverviewPreload: undefined,
        overviewPreload: false,
      };
      const isPrimaryStream = (streamUrl: string) =>
        streamUrl === selectedDataset.url;
      // Base layer props (overview tier on the primary only) + per-layer
      // governor plumbing keyed by the layer's own id, registered REQUIRED so
      // ego/objects stay in lock-step with the LIDAR. comma.ai (ego-only) gates
      // correctly on its ego stream, which is its primary.
      const propsForStream = (layerId: string, streamUrl: string) => {
        const primary = isPrimaryStream(streamUrl);
        return {
          // Overview-preload tier on the primary only; gate on ALL of these
          // streams (required:true) — see the block comment above.
          ...(primary ? baseProps : overlayBase),
          ...sourceProps(layerId, true),
        };
      };
      const layers: any[] = [];
      // HD-map substrate — drawn FIRST so it sits UNDER the LIDAR/ego/objects:
      // drivable-area / crosswalk POLYGONS + lane-divider / boundary LINES, each
      // colored by a categorical `map_layer` via `mapColors`. Both are OPTIONAL
      // governor sources (load coordinated, never gate the clock).
      if (selectedDataset.avMapPolyUrl) {
        layers.push(
          new AnimatedPolygonLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-map-poly`,
            ...sourceProps(`${selectedDataset.id}-map-poly`, false),
            data: selectedDataset.avMapPolyUrl,
            filled: true,
            stroked: false,
            fillColor: "map_layer",
            ...(selectedDataset.mapColors && {
              colorMapping: selectedDataset.mapColors,
            }),
            opacity: 1, // per-layer alpha lives in mapColors
            // Flat ground decal: kill the coplanar-polygon z-fighting (the
            // nuScenes drivable-area / lane / crosswalk fills heavily overlap).
            parameters: GROUND_DECAL_PARAMETERS,
          }),
        );
      }
      if (selectedDataset.avMapLineUrl) {
        layers.push(
          new AnimatedPathLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-map-line`,
            ...sourceProps(`${selectedDataset.id}-map-line`, false),
            data: selectedDataset.avMapLineUrl,
            pathColor: "map_layer",
            ...(selectedDataset.mapColors && {
              colorMapping: selectedDataset.mapColors,
            }),
            widthUnits: "meters",
            pathWidth: 0.35,
            widthMinPixels: 1,
            capRounded: false,
            jointRounded: false,
            opacity: 1,
            // Same flat ground decal as map_poly — the dividers sit ON the
            // fills at z=0, so they fight the polygons without this.
            parameters: GROUND_DECAL_PARAMETERS,
          }),
        );
      }
      if (selectedDataset.avLidarUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...propsForStream(selectedDataset.id, selectedDataset.avLidarUrl),
            id: selectedDataset.id, // bare id → the cockpit's "lidar" toggle
            data: selectedDataset.avLidarUrl,
            // String fillColor = property name → GPU categorical fill; the
            // height-band colorMapping keeps each band stable across tiles.
            fillColor: selectedDataset.colorProperty ?? "height_band",
            colorMapping: selectedDataset.lidarColorMapping,
            colorMappingDefault: selectedDataset.lidarColorMappingDefault,
            // Place each return at its real height (`z`, metres) so the tilted
            // cockpit camera renders a true 3D point CLOUD — not flat dots. The
            // tile carries a numeric `z` column; AnimatedPointLayer now fills the
            // position's z from it. `elevationScale` lets a scene exaggerate.
            use3D: true,
            elevationProperty: "z",
            elevationScale: selectedDataset.elevationScale ?? 1,
            radius: selectedDataset.radius ?? 1.4,
            radiusUnits: selectedDataset.radiusUnits ?? "pixels",
            radiusScale: selectedDataset.radiusScale ?? 1,
            radiusMinPixels: selectedDataset.radiusMinPixels ?? 1,
            radiusMaxPixels: selectedDataset.radiusMaxPixels,
            // Camera-facing dots so the point CLOUD reads volumetrically at the
            // tilted cockpit pitch. With the default ground-flat disks, returns
            // lying in the thin (~3 m) ground band foreshorten into a flat
            // carpet and the 3D structure (placed via elevationProperty `z`)
            // is invisible; billboarded round points keep each return legible
            // at its real height from any angle.
            billboard: true,
            // LIDAR reads best as a dense cloud rather than translucent splats.
            opacity: selectedDataset.opacity ?? 0.9,
          }),
        );
      }
      if (selectedDataset.avEgoUrl) {
        layers.push(
          new AnimatedTripsLayer({
            ...propsForStream(`${selectedDataset.id}-ego`, selectedDataset.avEgoUrl),
            id: `${selectedDataset.id}-ego`,
            data: selectedDataset.avEgoUrl,
            tripColor: selectedDataset.tripColor ?? [120, 230, 255, 255],
            widthUnits: selectedDataset.widthUnits ?? "meters",
            tripWidth: selectedDataset.tripWidth ?? 2.2,
            widthMinPixels: selectedDataset.widthMinPixels ?? 2,
            widthMaxPixels: selectedDataset.widthMaxPixels,
            // Show the full ego path for the scene — the whole drive is the
            // trail. Falls back to the dataset duration so the line never fades
            // mid-scene; datasets can override for a shorter tail.
            trailLength:
              selectedDataset.trailLength ??
              selectedDataset.timeRange.end - selectedDataset.timeRange.start,
            fadeTrail: selectedDataset.fadeTrail ?? true,
            capRounded: selectedDataset.capRounded ?? false,
            jointRounded: selectedDataset.jointRounded ?? false,
          }),
        );
      }
      if (selectedDataset.avObjectsUrl) {
        layers.push(
          new AnimatedBoundingBoxLayer({
            ...propsForStream(`${selectedDataset.id}-objects`, selectedDataset.avObjectsUrl),
            id: `${selectedDataset.id}-objects`,
            data: selectedDataset.avObjectsUrl,
            // Categorical `category` → oriented box color via the same
            // colorMapping machinery AnimatedColumnLayer uses.
            colorProperty: "category",
            colorMapping: selectedDataset.avObjectColors,
            colorMappingDefault: selectedDataset.colorMappingDefault,
            headingProperty: "heading",
            lengthProperty: "length",
            widthProperty: "width",
            heightProperty: "height",
            // streetscape.gl refinements: class labels above each box, velocity
            // arrows (derived from speed+heading), and click-to-inspect picking
            // (overrides the baseProps pickable:false for the objects layer only).
            pickable: true,
            showLabels: true,
            labelProperty: "category",
            showVelocity: true,
          }),
        );
      }
      return layers;
    }
    default:
      return [];
  }
}
