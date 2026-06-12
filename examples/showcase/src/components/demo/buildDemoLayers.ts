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
} from "@stt/deck.gl";
import type {
  BufferSource,
  BufferedRunway,
  HeatmapChannelSpec,
  OverviewPreloadResult,
  TimeController,
} from "@stt/deck.gl";
import { tileLoadingProps } from "../../types";
import type { Dataset, SummaryToggleOption } from "../../types";

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
 * Governor/overview callbacks the LIVE viewer wires through. The hover preview
 * passes none of these — it is a throwaway static render, not part of the
 * buffering machine.
 */
export interface DemoLayerPlumbing {
  onTilesetReady?: (tileset: BufferSource) => void;
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
    onTilesetReady,
    onBufferChange,
    onOverviewPreload,
    overviewPreload = false,
  } = plumbing ?? {};

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
    // Playback-governor plumbing: hand the tileset over once it exists and
    // forward buffer-runway events for immediate gate/stall evaluation.
    onTilesetReady,
    onBufferChange,
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
      return [
        new H3SummaryLayer({
          id: `${selectedDataset.id}-${activeSummaryToggle?.id ?? "default"}`,
          data: selectedDataset.url,
          currentTime: selectedDataset.timeRange.start,
          timeController,
          timeWindow,
          // Same governor plumbing as the raw-tier layers (baseProps).
          onTilesetReady,
          onBufferChange,
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
      // flowmap.gl-style animated OD flowmap: one weighted arc per station-pair
      // whose width tracks volume at the playhead (per-bucket vertexValueMatrix
      // decode), plus node circles sized by incident flow. Geometry spans the
      // whole time range — loads once, animates from the matrix.
      return [
        new FlowmapLayer({
          ...baseProps,
          widthScale: selectedDataset.flowWidthScale ?? 1.1,
          widthMinPixels: selectedDataset.flowWidthMinPixels ?? 1,
          widthMaxPixels: selectedDataset.flowWidthMaxPixels ?? 12,
          sourceColor: selectedDataset.flowSourceColor ?? [56, 196, 232, 235],
          targetColor: selectedDataset.flowTargetColor ?? [255, 142, 64, 245],
          greatCircle: selectedDataset.flowGreatCircle ?? false,
          arcHeight: selectedDataset.flowArcHeight ?? 0.5,
          nodeRadiusScale: selectedDataset.flowNodeRadiusScale ?? 1.3,
          ...(selectedDataset.flowNodeColor && {
            nodeColor: selectedDataset.flowNodeColor,
          }),
          minFlow: selectedDataset.flowMinFlow ?? 0.25,
        }),
      ];
    case "column":
      // Extruded 3D columns at point features; height from a numeric column.
      return [
        new AnimatedColumnLayer({
          ...baseProps,
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
      return [
        new QuadbinSummaryLayer({
          id: `${selectedDataset.id}-${activeSummaryToggle?.id ?? "default"}`,
          data: selectedDataset.url,
          currentTime: selectedDataset.timeRange.start,
          timeController,
          timeWindow,
          onTilesetReady,
          onBufferChange,
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
    default:
      return [];
  }
}
