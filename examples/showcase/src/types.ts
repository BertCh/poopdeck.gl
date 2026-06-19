export type DatasetType =
  | 'point'
  | 'path'
  | 'trips'
  /**
   * Moving head-dot trip rendering — one interpolated dot at the head of each
   * active trip, drawn by `AnimatedTripHeadsLayer` (CPU per-frame position on a
   * stock ScatterplotLayer). Same archive shape as `trips` (no rebuild needed).
   */
  | 'trip-heads'
  | 'heatmap'
  | 'polygon'
  /**
   * Server-aggregated summary tier (H3 hex bins). Renders summary tiles via
   * `H3SummaryLayer`. Only useful for archives built with
   * `stt-build --summary-tier h3`.
   */
  | 'summary'
  /**
   * Origin→destination flow arcs (`AnimatedArcLayer`). Each feature is a
   * 2-vertex LineString — first vertex = source, last = target. Arcs bow over
   * the map and animate in/out by time window. Build with
   * `stt-generate nyc-rideshare --od`.
   */
  | 'arc'
  /**
   * Extruded 3D columns at point features (`AnimatedColumnLayer`); column
   * height comes from a numeric `elevationProperty`. Reuses any point archive.
   */
  | 'column'
  /**
   * Server-aggregated CARTO Quadbin summary tier (`QuadbinSummaryLayer`) — the
   * square-cell analog of `summary`. Only useful for archives built with
   * `stt-build --summary-tier quadbin`.
   */
  | 'quadbin-summary'
  /**
   * flowmap.gl-style animated origin→destination flowmap (`FlowmapLayer`). One
   * weighted arc per OD station-pair whose width tracks trip volume at the
   * playhead (read from a per-bucket `vertexValueMatrix`), plus node circles
   * sized by incident flow. Build with `stt-generate bixi`.
   */
  | 'flowmap'
  /**
   * GPU force-directed edge-bundled flowmap (`BundledFlowmapLayer`). Same OD
   * `vertexValueMatrix` tiles as `flowmap`, but compatible flows are relaxed
   * into smooth bundled rivers on the GPU (Holten FDEB, cosmos.gl-style
   * ping-pong textures) and rendered fully GPU-resident. Drop-in superset of
   * `flowmap`; honors the same `flow*` styling props.
   */
  | 'flowmap-bundled'
  /**
   * Composite storm-radar render (NEXRAD). Overlays THREE STT archives from one
   * dataset entry: filled reflectivity contour bands (`AnimatedPolygonLayer`,
   * categorical `dbz_band`) as the animated precipitation field — the dataset's
   * primary `url`; storm-cell centroids (`AnimatedPointLayer`) from
   * `radarCellsUrl`; and animated cell tracks (`AnimatedTripsLayer`,
   * per-vertex intensity) from `radarTracksUrl`. Build with `stt-generate storms`.
   */
  | 'radar'
  /**
   * Composite AV-telemetry "cockpit" render (streetscape.gl / avs.auto style).
   * Overlays up to THREE STT archives from one AV scene bundle: an accumulated
   * LIDAR point cloud (`AnimatedPointLayer`, categorical `height_band` fill) as
   * the dataset's primary `url`; the ego trajectory (`AnimatedTripsLayer`) from
   * `avEgoUrl`; and tracked-object 3D boxes (`AnimatedBoundingBoxLayer`,
   * categorical `category`) from `avObjectsUrl`. The bespoke `/drive/:sceneId`
   * cockpit additionally reads `avSceneUrl` (the `scene.json` manifest) plus the
   * `avTelemetryUrl` / `avCamerasUrl` sidecars for chrome, gauges, and the camera
   * inset. Built by the `av_synthetic.py` / `nuscenes_extract.py` adapters.
   */
  | 'av';

export interface DatasetLegendItem {
  color: string;
  label: string;
}

/** A color ramp shown as a horizontal gradient strip with a low/high label. */
export interface DatasetLegendRamp {
  label: string;
  /** CSS color stops, low→high. */
  colors: string[];
}

export interface DatasetLegend {
  title: string;
  items?: DatasetLegendItem[];
  /** Optional ramps; if set, the legend renders gradient strips alongside items. */
  ramps?: DatasetLegendRamp[];
}

/** RGBA color, 0-255 per channel. Matches deck.gl's Color type. */
export type ColorRGBA = [number, number, number, number];

/**
 * One channel of a stacked heatmap. N specs (max 4) pack into the
 * RGBA channels of the new HeatmapLayer's accumulator FBO — one splat
 * pass + one ramp pass total, regardless of channel count.
 */
export interface HeatmapLayerSpec {
  /** Channel id (used for log/picking + future build-time metadata lookup). */
  id: string;
  /** Color ramp from low density → high density. */
  colorRange: ColorRGBA[];
  /** Optional filter on a categorical property — only matching features count. */
  categoryFilter?: { property: string; values: string[] };
  /** Optional weight property (defaults to 1 per feature). */
  weightProperty?: string;
  /**
   * Optional per-layer radius override (px). When several channels are
   * stacked, only the FIRST channel's `radiusPixels` is honoured — the
   * splat pass runs once for all channels.
   */
  radiusPixels?: number;
  /** Per-channel weight multiplier on top of the global intensity. */
  intensity?: number;
  /**
   * Pinned `[min, max]` accumulator-intensity domain. Setting this skips
   * any runtime auto-detect (zero GPU readback). Defaults to [0, 1].
   */
  colorDomain?: [number, number];
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  url: string;
  type: DatasetType;
  /**
   * Data-source attribution keys (see SOURCE_REGISTRY in components/SourceLogo).
   * Rendered as small source badges on the demo cards.
   */
  sources?: string[];
  /**
   * Tile-tier dispatch for archives built with `--summary-tier`. `'auto'`
   * (default) swaps to the H3 summary overview at low zoom; `'raw'` always
   * uses raw features (use this when the summary overlay would obscure the
   * point-level story, e.g. the cumulative "draws itself" demo); `'summary'`
   * always uses the aggregated tier. No effect on archives without a summary tier.
   */
  tier?: 'auto' | 'summary' | 'raw';
  timeRange: {
    start: number;
    end: number;
  };
  timeWindow: number;
  /** Target duration in seconds for one complete playthrough at 1x speed (default: 30) */
  targetPlaybackSeconds?: number;
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  legend?: DatasetLegend;
  
  /** Enable 3D visualization with altitude/elevation */
  use3D?: boolean;
  
  /** Use GlobeView instead of Mercator projection (for global satellite data) */
  useGlobe?: boolean;

  /** Slowly auto-rotate the globe (only applies when `useGlobe` is true). */
  autoRotate?: boolean;

  /**
   * Fill color of the globe's earth sphere (only applies when `useGlobe`).
   * Defaults to a dark sphere; set a light tone to match the paper landing page.
   */
  globeBackgroundColor?: ColorRGBA;

  /** Property name containing elevation data (e.g., 'altitude', 'elevation') */
  elevationProperty?: string;
  
  /** Scale factor for elevation values (e.g., for unit conversion) */
  elevationScale?: number;
  
  /** Property name for categorical coloring (passed to layers as colorProperty) */
  colorProperty?: string;

  /**
   * Stable category-string → RGBA mapping for `colorProperty`. When set, the
   * point layer colors each feature by looking up its category string in this
   * mapping — required for cross-tile consistency, since the default palette
   * fallback assigns palette indices in first-seen order per tile.
   */
  colorMapping?: Record<string, ColorRGBA>;

  /** Fallback color for categories absent from colorMapping. */
  colorMappingDefault?: ColorRGBA;

  /** Property name for radius/size (passed to layers as radiusProperty) */
  radiusProperty?: string;

  /**
   * Fixed radius for all features when no `radiusProperty` is set. Interpreted
   * in `radiusUnits` (meters by default in DemoPage). Falls back to 1000 m.
   */
  radius?: number;

  /** Units for the `radius` prop — defaults to 'pixels' in DemoPage. */
  radiusUnits?: 'pixels' | 'meters' | 'common';

  /** Multiplier applied to per-feature radius values. */
  radiusScale?: number;

  /** Clamp radius to at least this many on-screen pixels. */
  radiusMinPixels?: number;

  /** Clamp radius to at most this many on-screen pixels. */
  radiusMaxPixels?: number;

  /**
   * Non-linear transform applied to each feature's `radiusProperty` value.
   * Useful when the property is a log-scale quantity (e.g. earthquake
   * magnitude) and a linear pixel mapping is uninformative.
   */
  radiusTransform?: (value: number) => number;

  /**
   * Wake length in milliseconds for `type: 'point'`. When > 0, each point
   * is drawn behind the play head as a fading + shrinking "ship wake".
   * The caller's `timeWindow` should be `>= 2 × wakeLength` so the tile
   * loader still covers the past portion of the wake.
   */
  wakeLength?: number;

  /** Tail-edge size multiplier for wake mode (0..1). Defaults to 0.15. */
  wakeTailScale?: number;

  /**
   * Cumulative "draw and persist" mode for `type: 'point'`. When true, each
   * point appears at its start time and stays visible for the rest of playback
   * — the dataset "draws itself" (e.g. OSM node creations inking a city in).
   * DemoPage widens the tile loader's window to keep revealed tiles resident;
   * the GPU does the progressive reveal. Pair with `fadeInDuration` for an
   * "ink appearing" ramp.
   */
  cumulative?: boolean;

  /**
   * Fade-in duration in SIM milliseconds for appearing points. In `cumulative`
   * mode this is the "ink appearing" ramp applied as each point is revealed.
   */
  fadeInDuration?: number;

  /** Render a stroke around each point. */
  stroked?: boolean;

  /** Stroke color (constant). */
  strokeColor?: ColorRGBA;

  /** Stroke width clamp in pixels. */
  lineWidthMinPixels?: number;
  
  /** Property name for weight (used in heatmap layers) */
  weightProperty?: string;

  /**
   * For `type: 'heatmap'`, render multiple stacked heatmap layers from this
   * one source archive (e.g. pickup + dropoff heatmaps from the NYC taxi
   * status column). If unset, a single default heatmap layer is rendered.
   */
  heatmapLayers?: HeatmapLayerSpec[];

  // ─── trip-heads styling (type: 'trip-heads') ───────────────────────────
  // Rendered by AnimatedTripHeadsLayer — a smooth moving dot at the head of
  // each active trip (CPU-interpolated position on a stock ScatterplotLayer).
  /** Head-dot color, RGBA 0-255. */
  headColor?: ColorRGBA;
  /** Head-dot radius in pixels (used when `headSizeUnits` is 'pixels'). */
  headRadiusPixels?: number;
  /**
   * Units for the head radius. 'pixels' (default) is screen-space; 'meters'
   * makes the dot world-space (emerges on zoom) like the maritime point layer,
   * using `headRadius` and clamped by the *MinPixels/*MaxPixels bounds.
   */
  headSizeUnits?: 'pixels' | 'meters';
  /** Head radius in METRES when `headSizeUnits === 'meters'`. */
  headRadius?: number;
  /** Min on-screen head radius in pixels (meters-mode clamp). */
  headRadiusMinPixels?: number;
  /** Max on-screen head radius in pixels (meters-mode clamp). */
  headRadiusMaxPixels?: number;

  /**
   * Layer opacity (0-1). Defaults to 0.8. Lower values let dense, overlapping
   * geometry (e.g. thousands of satellite trails) read as a density glow
   * instead of saturating into a solid block.
   */
  opacity?: number;

  // ─── trips-layer styling (type: 'trips') ───────────────────────────────
  /** Constant trip color, RGBA 0-255. */
  tripColor?: ColorRGBA;
  /**
   * Color each trip *along its length* by a per-vertex scalar carried in the
   * tile (the `vertex_value` channel, e.g. sea-surface temperature). `property`
   * names the BinaryFeatures channel (currently only `'vertexValues'`),
   * `domain` is the `[min, max]` mapped onto `colors` (low→high RGBA stops).
   * Takes precedence over `colorProperty` / `tripColor`.
   */
  tripGradient?: {
    property: string;
    domain: [number, number];
    colors: ColorRGBA[];
  };
  /**
   * Render this `type: 'trips'` dataset with {@link FlowCorridorLayer} instead
   * of {@link AnimatedTripsLayer}. Use for static-geometry *overview* archives
   * (flow corridors) whose tiles carry a per-vertex × per-time-bucket value
   * matrix: the corridor geometry loads ONCE and the renderer animates the
   * `tripGradient` color by selecting the active bucket column from the
   * playhead — no per-timestep geometry re-fetch. Pair with `trailLength: 0`
   * (the matrix drives the animation, not a trailing fade).
   */
  flowMatrix?: boolean;
  /** Trip line width — number (in widthUnits) or numeric property name. */
  tripWidth?: number | string;
  /** Clamp trip width to at least this many on-screen pixels. */
  widthMinPixels?: number;
  /** Clamp trip width to at most this many on-screen pixels. */
  widthMaxPixels?: number;
  /**
   * Trail duration in ms — how long the trailing path remains visible behind
   * the play head. The tile loader auto-widens its window to `2 × trailLength`
   * if `timeWindow` is shorter; setting `timeWindow` smaller than that has no
   * effect.
   */
  trailLength?: number;
  /** Fade the trail's tail to transparent (vs. hard cut at trailLength). */
  fadeTrail?: boolean;
  /** Rounded line caps; disable for ~2× faster fragment shading at small widths. */
  capRounded?: boolean;
  /** Rounded line joints; same perf tradeoff as `capRounded`. */
  jointRounded?: boolean;
  /** Force a specific zoom for tile selection (used by globe-style demos). */
  zoomOverride?: number;
  /** Load tiles for the entire planet, ignoring the current viewport bounds. */
  useGlobalBounds?: boolean;

  // ─── path-layer styling (type: 'path') ─────────────────────────────────
  /** Constant path color (or fall back to `colorProperty` if categorical). */
  pathColor?: ColorRGBA;
  /** Path line width — number (in widthUnits) or numeric property name. */
  pathWidth?: number | string;
  /** Units for `pathWidth` / `tripWidth`. */
  widthUnits?: 'pixels' | 'meters';

  // ─── polygon-layer styling (type: 'polygon') ───────────────────────────
  /** Fill polygons (default true). */
  polygonFilled?: boolean;
  /** Stroke polygon outlines (default false — slow path in AnimatedPolygonLayer). */
  polygonStroked?: boolean;
  /** Polygon outline width. */
  polygonLineWidth?: number;
  /** Units for `polygonLineWidth`. */
  polygonLineWidthUnits?: 'pixels' | 'meters' | 'common';
  /** Polygon outline color (constant). */
  polygonLineColor?: ColorRGBA;
  /** Polygon fill color — constant RGBA or `colorProperty` for categorical fill. */
  polygonFillColor?: ColorRGBA;

  // ─── radar composite styling (type: 'radar') ───────────────────────────
  /**
   * Storm-cell CENTROID points manifest (sized/colored by `max_dbz`). The
   * dataset's primary `url` is the reflectivity FIELD manifest; this and
   * `radarTracksUrl` are the two overlay tilesets. Rewritten through
   * `resolveDataUrl` alongside `url` so an R2 deploy resolves all three.
   */
  radarCellsUrl?: string;
  /** Storm-cell TRACK linestrings manifest (per-vertex intensity trail). */
  radarTracksUrl?: string;
  /** Solid fill for storm-cell centroids. Defaults to near-white. */
  radarCellColor?: ColorRGBA;

  // ─── AV cockpit composite styling (type: 'av') ─────────────────────────
  /**
   * `scene.json` manifest URL for the AV scene bundle. The bespoke
   * `/drive/:sceneId` cockpit fetches it for chrome (name/attribution/license),
   * object colors, the runtime time range, and the telemetry/camera sidecar
   * references. The standard `case 'av'` render does NOT need it (it composes
   * from the archive URLs + the Dataset copies of the colors); the cockpit does.
   * Rewritten through `resolveDataUrl` alongside `url` so an R2 deploy resolves it.
   */
  avSceneUrl?: string;
  /**
   * LIDAR point-cloud archive manifest (an STT POINT archive — accumulated
   * returns, colored by categorical `height_band`). Rendered by
   * `AnimatedPointLayer`. Present ONLY on scenes that have a LIDAR stream
   * (nuScenes / Argoverse / synthetic); omit it for LIDAR-less scenes such as
   * comma.ai. On LIDAR scenes set it equal to the dataset's primary `url` so the
   * playback governor rides the LIDAR (heaviest) archive. Routed through `resolveDataUrl`.
   */
  avLidarUrl?: string;
  /**
   * Ego-trajectory archive manifest (an STT TRIPS archive — one LineString =
   * the ego path). Rendered by `AnimatedTripsLayer`. On LIDAR scenes the
   * primary `url` is the LIDAR archive; on LIDAR-less scenes (comma.ai) this IS
   * the primary `url`, so the governor rides it. Routed through `resolveDataUrl`.
   */
  avEgoUrl?: string;
  /**
   * Tracked-object archive manifest (an STT POINT archive — one point per
   * object per annotated sample, carrying `category`/`heading`/box dims).
   * Rendered by `AnimatedBoundingBoxLayer`. Routed through `resolveDataUrl`.
   */
  avObjectsUrl?: string;
  /**
   * CAN-bus telemetry sidecar JSON URL (`telemetry.json`). Loaded client-side
   * by the cockpit; binary-searched at the playhead to drive the metric gauges.
   * Routed through `resolveDataUrl`.
   */
  avTelemetryUrl?: string;
  /**
   * Camera-keyframe sidecar JSON URL (`cameras.json`). Loaded client-side by
   * the cockpit's top-right camera inset. Routed through `resolveDataUrl`.
   */
  avCamerasUrl?: string;
  /**
   * Tracked-object category → RGBA color. Also present in `scene.json`; the
   * Dataset copy keeps `buildDemoLayers` self-contained (so the standard
   * `DemoPage` render colors object boxes without fetching the manifest).
   */
  avObjectColors?: Record<string, ColorRGBA>;
  /**
   * LIDAR `height_band` (categorical) → RGBA color ramp. Drives the LIDAR
   * point cloud's `colorMapping`. ~8 bands across the height domain.
   */
  lidarColorMapping?: Record<string, ColorRGBA>;
  /** Fallback color for `height_band` values absent from `lidarColorMapping`. */
  lidarColorMappingDefault?: ColorRGBA;
  /**
   * HD-map vector streams: drivable-area / lane / crosswalk POLYGONS
   * (`avMapPolyUrl`) and lane-divider / boundary LINES (`avMapLineUrl`), each an
   * STT archive whose features carry a categorical `map_layer` string. Rendered
   * UNDER the LIDAR as the scene substrate (the streetscape.gl "real road" cue).
   * Routed through `resolveDataUrl`.
   */
  avMapPolyUrl?: string;
  avMapLineUrl?: string;
  /** `map_layer` (categorical) → RGBA for both map streams (fills low-alpha, lines crisp). */
  mapColors?: Record<string, ColorRGBA>;

  // ─── space-time cube (time = height) ───────────────────────────────────
  /**
   * Render the dataset as a Hägerstrand space-time cube: time maps to
   * altitude, so trail-mode trips become 3D threads climbing through the
   * cube (slope = speed) and points become temporal strata. DemoPage adds a
   * "squash" slider that morphs between the flat map (0) and the full cube
   * (1) — a single shader uniform, free to animate. MapView demos only.
   */
  timeHeight?: {
    /** Cube height in meters for the full timeRange at squash factor 1. */
    rangeHeightMeters: number;
    /** Initial squash factor, 0..1. Defaults to 1 (full cube). */
    initialFactor?: number;
    /** Draw a translucent "now" plane rising with the playhead. Default true. */
    nowPlane?: boolean;
    /**
     * Draw the STT tile lattice: each loaded tile rendered as a wireframe
     * box (spatial footprint × temporal bucket) — the format made visible.
     * Default true.
     */
    tileLattice?: boolean;
    /** Camera pitch limit (MapView defaults to 60; cubes want more). */
    maxPitch?: number;
  };

  // ─── summary-tier styling (type: 'summary') ────────────────────────────
  /**
   * Numeric column the summary-tier color ramp + extrusion are driven by.
   * Defaults to `'count'` (the implicit per-cell count column).
   */
  summaryWeightProperty?: string;
  /**
   * 6-stop low→high colour ramp for the summary tier. RGBA, 0-255.
   */
  summaryColorRange?: ColorRGBA[];
  /**
   * `[min, max]` pin for the colour ramp. When unset, each tile's own
   * min/max drives the ramp — visually unstable but a usable default.
   */
  summaryColorDomain?: [number, number];
  /** Extrude the hexes by `weight * elevationScale`. */
  summaryExtruded?: boolean;
  /** Meters-per-weight-unit when extruded. */
  summaryElevationScale?: number;
  /** Hex coverage (0..1). Lower values leave visible gaps between hexes. */
  summaryCoverage?: number;
  /**
   * Optional pickup/dropoff-style toggle for a summary-tier demo. When set,
   * the demo renders a small segmented control over the map; selecting an
   * option swaps the layer's `weightProperty` + colour ramp + domain in
   * place. The first entry is the initial selection.
   */
  summaryToggleWeights?: SummaryToggleOption[];

  // ─── arc-layer styling (type: 'arc') ───────────────────────────────────
  /** Arc source-endpoint (origin) color, RGBA. The arc interpolates source→target. */
  arcSourceColor?: ColorRGBA;
  /** Arc target-endpoint (destination) color, RGBA. */
  arcTargetColor?: ColorRGBA;
  /** Arc line width in `widthUnits` (default pixels). */
  arcWidth?: number;
  /** Bow arcs along a great-circle path (for globe / long-haul flows). */
  arcGreatCircle?: boolean;
  /** Arc height multiplier; 0 = flat lines. Default 1. */
  arcHeight?: number;

  // ─── flowmap-layer styling (type: 'flowmap') ───────────────────────────
  /** Arrow width in px per `sqrt(current-bucket trip count)`. Default 1.1. */
  flowWidthScale?: number;
  /** Clamp arrow width to at least this many px (active arrows only). */
  flowWidthMinPixels?: number;
  /** Clamp arrow width to at most this many px. */
  flowWidthMaxPixels?: number;
  /** Arrow source (origin / tail) color, RGBA. */
  flowSourceColor?: ColorRGBA;
  /** Arrow target (destination / arrowhead) color, RGBA. */
  flowTargetColor?: ColorRGBA;
  /** Perpendicular separation of the two directions, in arrow widths. Default 0.5. */
  flowGap?: number;
  /** @deprecated No effect — flow arrows are flat (old raised-arc knob). */
  flowArcHeight?: number;
  /** @deprecated No effect — flow arrows are flat. */
  flowGreatCircle?: boolean;
  /** Node circle radius per `sqrt(incident flow)`. Default 1.3. */
  flowNodeRadiusScale?: number;
  /**
   * Units for node-circle radius: `'pixels'` (constant on screen) or `'meters'`
   * (scales with the map, so dense overviews don't blow out into overlapping
   * dots — still clamped by `flowNodeRadiusMaxPixels`). With `'meters'`,
   * `flowNodeRadiusScale` is metres per √flow. Default `'pixels'`.
   */
  flowNodeRadiusUnits?: 'meters' | 'pixels';
  /** Clamp node circle radius to at most this many px. Default 28. */
  flowNodeRadiusMaxPixels?: number;
  /** Node circle fill color, RGBA. */
  flowNodeColor?: ColorRGBA;
  /** Hide arrows/nodes whose current flow is below this many trips. Default 0.25. */
  flowMinFlow?: number;

  // ─── edge-bundled flowmap tuning (type: 'flowmap-bundled', KDEEB) ───────
  /** Control points per edge (P). Higher = smoother rivers, more GPU work. Default 48. */
  flowSubdivisionPoints?: number;
  /** Kernel bandwidth as a fraction of the tile extent — the headline knob; larger bundles more. Default 0.05. */
  flowKernelRadius?: number;
  /** Number of KDEEB density-advection iterations (more = tighter). Default 15. */
  flowBundlingIterations?: number;
  /** Per-iteration Laplacian smoothing strength in [0,1]. Default 0.5. */
  flowSmoothingStrength?: number;
  /** Above this many edges per tile, skip bundling (straight arrows). Default 4000. */
  flowMaxBundledEdges?: number;
  /**
   * The tiles already carry BAKED bundled geometry (`stt-generate bixi
   * --bake-bundling`): `BundledFlowmapLayer` skips the live GPU bundler and just
   * renders the precomputed rivers. Cheaper, stable, works without `EXT_float_blend`.
   */
  flowPreBundled?: boolean;

  // ─── column-layer styling (type: 'column') ─────────────────────────────
  /** Column disk radius in `columnRadiusUnits`. Default 100. */
  columnRadius?: number;
  /** Units for `columnRadius`. Default 'meters'. */
  columnRadiusUnits?: 'meters' | 'pixels' | 'common';
  /** Column cross-section resolution (sides). Default 12. */
  columnDiskResolution?: number;
  /** Constant column height when no `elevationProperty` is set. */
  columnElevation?: number;
  /** Constant column fill, RGBA (or use `colorProperty` for categorical fill). */
  columnFillColor?: ColorRGBA;

  /**
   * Palette for a categorical `colorProperty` on the arc / column layers
   * (GPU CategoryColorExtension — palette[categoryIndex]).
   */
  colorPalette?: ColorRGBA[];
}

/**
 * One choice in a summary-tier weight toggle. Each option points at a
 * different numeric column on the summary tier (e.g. `sum_is_pickup`
 * vs `sum_is_dropoff`) and styles it with its own ramp.
 */
export interface SummaryToggleOption {
  id: string;
  label: string;
  /** Summary column to drive the ramp. */
  weightProperty: string;
  colorRange: ColorRGBA[];
  /** Optional pinned `[min, max]` domain (same semantics as `summaryColorDomain`). */
  colorDomain?: [number, number];
  /** CSS gradient stops for the legend strip — usually `colorRange` mapped to hex strings. */
  legendColors?: string[];
}

/**
 * Calculate animation speed based on time range and target playback duration.
 * Returns the number of simulation milliseconds per real millisecond.
 *
 * Plays at the dataset's intended `targetPlaybackSeconds`. (The old global
 * `PLAYBACK_SLOWDOWN = 2` half-speed hack — which stretched every demo so R2
 * loading could keep up — is gone: the PlaybackGovernor now gates playback on
 * the buffered runway and stalls honestly when loading falls behind.)
 */
export function calculateAnimationSpeed(dataset: Dataset): number {
  const timeRangeDuration = dataset.timeRange.end - dataset.timeRange.start;
  const targetSeconds = dataset.targetPlaybackSeconds ?? 30;
  const targetMs = targetSeconds * 1000;
  return timeRangeDuration / targetMs;
}

/**
 * The ONE tile-loading recipe every STT layer in the showcase uses — demo
 * pages, the home hero globe, and the data stories all spread this into their
 * layer props so loading behaves identically across surfaces. (The underlying
 * tileset freezes these options when it is created, so callers must pass a
 * budget that covers their fastest playback up front.)
 *
 * Prefetch budget is keyed to REAL-time playback, not sim-time: we want a few
 * seconds of real-time buffer ahead of the play head regardless of how
 * compressed sim-time is. `playbackSpeed` is sim-ms per real-ms, so
 * `playbackSpeed * PREFETCH_REAL_SECONDS * 1000` is that many real seconds
 * expressed in sim-time. The `timeWindow` floor keeps a paused or slow view
 * warming its whole resident window.
 *
 * (The old DemoPage math asked for max(5*timeWindow, playbackSpeed*60000) and
 * up to 150 steps. For ship-traffic that produced ~8h of lookahead × 150 steps
 * ≈ 50 days of prefetch horizon per tick — every tick blew through the
 * bucket-boundary cap and queued thousands of fetches, collapsing FPS to 0.5
 * under SwiftShader.)
 */
export function tileLoadingProps(timeWindow: number, playbackSpeed: number) {
  const PREFETCH_REAL_SECONDS = 5;
  return {
    enablePrefetch: true,
    prefetchAhead: Math.max(timeWindow, playbackSpeed * 1000 * PREFETCH_REAL_SECONDS),
    prefetchSteps: 4,
    // Browsers cap to ~6 concurrent connections per HTTP/1.1 origin; asking
    // for more just queues inside the network layer and deepens the decode
    // backlog on the main thread. 12 is enough for HTTP/2 multiplexing too.
    maxRequests: 12,
  };
}



