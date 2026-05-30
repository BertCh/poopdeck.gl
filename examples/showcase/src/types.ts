export type DatasetType =
  | 'point'
  | 'path'
  | 'trips'
  /**
   * Vertex-Animation-Texture trip rendering — one head dot per active trip,
   * positions baked into a per-tile 2D texture. GPU work is independent of
   * per-trajectory vertex count, so this scales where `trips` doesn't.
   * Same archive shape as `trips` (no rebuild needed).
   */
  | 'vat'
  | 'heatmap'
  | 'polygon'
  /**
   * Server-aggregated summary tier (H3 hex bins). Renders summary tiles via
   * `H3SummaryLayer`. Only useful for archives built with
   * `stt-build --summary-tier h3`.
   */
  | 'summary';

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

  // ─── VAT-trips styling (type: 'vat') ───────────────────────────────────
  /** Head-dot color for VAT trips, RGBA 0-255. Used when `vatTrailLength` is 0. */
  vatHeadColor?: ColorRGBA;
  /** Head-dot radius in pixels for VAT trips. Used when `vatTrailLength` is 0. */
  vatHeadRadiusPixels?: number;
  /** Time-slot resolution per trip for the VAT texture (default 64). */
  vatTimeSlots?: number;
  /**
   * VAT trail length in ms. > 0 switches the VAT layer from a head dot to a
   * ribbon trail behind each active trip — same perf characteristics, but
   * visually matches AnimatedTripsLayer trips.
   */
  vatTrailLength?: number;
  /** Ribbon resolution (verts = (samples+1)*2 per active trip). Default 16. */
  vatTrailSamples?: number;
  /** Ribbon color (RGBA, 0-255). Used when `vatTrailLength` > 0. */
  vatTrailColor?: ColorRGBA;
  /** Ribbon nominal width in pixels (clamped to widthMin/MaxPixels). */
  vatTripWidth?: number;
  /** Fade the trail's tail to transparent (vs constant alpha). */
  vatFadeTrail?: boolean;

  /**
   * Layer opacity (0-1). Defaults to 0.8. Lower values let dense, overlapping
   * geometry (e.g. thousands of satellite trails) read as a density glow
   * instead of saturating into a solid block.
   */
  opacity?: number;

  // ─── trips-layer styling (type: 'trips') ───────────────────────────────
  /** Constant trip color, RGBA 0-255. */
  tripColor?: ColorRGBA;
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
 */
export function calculateAnimationSpeed(dataset: Dataset): number {
  const timeRangeDuration = dataset.timeRange.end - dataset.timeRange.start;
  const targetSeconds = dataset.targetPlaybackSeconds ?? 30; // Default to 30 seconds
  const targetMs = targetSeconds * 1000;
  return timeRangeDuration / targetMs;
}



