export type DatasetType = 'point' | 'path' | 'trips' | 'heatmap' | 'polygon';

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

export interface HeatmapLayerSpec {
  /** Suffix appended to the dataset id to make a unique layer id. */
  id: string;
  /** Color ramp from low density → high density. */
  colorRange: ColorRGBA[];
  /** Optional filter on a categorical property — only matching features count. */
  categoryFilter?: { property: string; values: string[] };
  /** Optional weight property (defaults to 1 per feature). */
  weightProperty?: string;
  /** Optional per-layer radius override (px). */
  radiusPixels?: number;
  /** Optional per-layer intensity override. */
  intensity?: number;
  /**
   * Pinned `[min, max]` weight domain forwarded to deck.gl's HeatmapLayer.
   * Setting this is the big perf knob for animated heatmaps — it skips
   * deck.gl's per-rebuild max-weight auto-detection.
   */
  colorDomain?: [number, number];
  /** Forwarded to HeatmapLayer.debounceTimeout (ms). */
  debounceTimeout?: number;
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  url: string;
  type: DatasetType;
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



