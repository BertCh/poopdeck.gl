/**
 * AnimatedPointLayer - GPU-efficient point rendering with time filtering
 * 
 * PERFORMANCE OPTIMIZED (v2 - Consolidated Rendering):
 * - Consolidates ALL tiles into a SINGLE ScatterplotLayer (1 draw call instead of N)
 * - Uses deck.gl's binary data interface for maximum performance
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Consolidated data cached per tile set - only rebuilt when tiles change
 * - Layer instance memoized to avoid recreation on time-only updates
 * 
 * Performance: Targets 200fps by eliminating per-tile layer overhead
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import { consolidatePoints } from './consolidate';
import type { Tile } from '@stt/core';

// Debug flag
const DEBUG = false;

// Singleton TimeFilterExtension instance - reused across all layers
const TIME_FILTER_EXTENSION = new TimeFilterExtension();

/**
 * Consolidated data from all tiles - contains merged typed arrays
 */
interface ConsolidatedData {
  length: number;
  /**
   * The reference time offset for this consolidated layer. All time
   * attributes below are RELATIVE to this value (see relativizeTime / the
   * float32-precision note in time-filter-extension.ts). The first tile's
   * timeOffset is used as the layer-wide reference.
   */
  timeOffset: number;
  /** Interleaved size-3 positions (lon, lat, 0). */
  positions: Float64Array;
  /** Per-feature start times, RELATIVE to timeOffset. */
  startTimes: Float32Array;
  /** Per-feature end times, RELATIVE to timeOffset. */
  endTimes: Float32Array;
  /** Per-feature RGBA colors, or null to use the constant `fillColor` prop. */
  colors: Uint8Array | null;
  /** Per-feature radii, or null to use the constant `radius` prop. */
  radii: Float32Array | null;
}

export interface AnimatedPointLayerProps extends SpatioTemporalLayerProps {
  /** Radius scale multiplier */
  radiusScale?: number;
  
  /** Radius units ('pixels' | 'meters' | 'common') */
  radiusUnits?: 'pixels' | 'meters' | 'common';
  
  /** Fill color - constant value or property name for categorical coloring */
  fillColor?: Color | string;
  
  /** Radius - constant value or property name for radius */
  radius?: number | string;
  
  /** Color palette for categorical properties */
  colorPalette?: Color[];

  /**
   * Explicit category-to-color map. When set together with a string `fillColor`
   * property, each feature's color is `colorMapping[categoryValue]`, using
   * `colorMappingDefault` (or transparent) for unknown values. This is the
   * only way to get stable colors across tiles whose categorical column
   * contains different category subsets — the first-seen palette index
   * fallback assigns the same band a different palette slot per tile.
   */
  colorMapping?: Record<string, Color>;

  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;

  /**
   * Per-feature radius transform, applied to the numeric value of the
   * `radius` property column before the GPU receives it. Useful for
   * non-linear scalings (e.g. magnitude → area).
   */
  radiusTransform?: (value: number) => number;

  /** Minimum on-screen radius in pixels. Forwarded to ScatterplotLayer. */
  radiusMinPixels?: number;

  /** Maximum on-screen radius in pixels. Forwarded to ScatterplotLayer. */
  radiusMaxPixels?: number;

  /** Outline stroke width in pixels. Forwarded to ScatterplotLayer. */
  lineWidthMinPixels?: number;

  /** Whether to render an outline stroke around each point. */
  stroked?: boolean;

  /** Stroke color (constant). */
  strokeColor?: Color;

  /** Whether to fill the marker (default true). */
  filled?: boolean;
  
  /** 
   * Enable 3D positions (altitude/elevation support)
   * When true, positions will include altitude component
   */
  use3D?: boolean;
  
  /**
   * Property name to extract elevation from (e.g., 'altitude', 'elevation')
   * Used when positions don't have embedded altitude but it's available in properties
   * Only used when use3D is true
   */
  elevationProperty?: string;
  
  /**
   * Scale factor for elevation values (e.g., to convert feet to meters)
   * Only used when use3D is true
   */
  elevationScale?: number;
  
  /** Fade-in duration for appearing points (ms) */
  fadeInDuration?: number;
  
  /** Fade-out duration for disappearing points (ms) */
  fadeOutDuration?: number;
}

/**
 * True if two tile arrays describe the SAME set of tiles by id (z/x/y/t).
 * The reference may differ (the tileset always returns a fresh array) but
 * the content match lets the consolidated-data cache avoid a rebuild.
 */
function tilesContentMatch(a: Tile[], b: Tile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i].id;
    const bi = b[i].id;
    if (ai.z !== bi.z || ai.x !== bi.x || ai.y !== bi.y || ai.t !== bi.t) {
      return false;
    }
  }
  return true;
}

// Default color palette for categorical data
const DEFAULT_PALETTE: Color[] = [
  [31, 119, 180, 255],
  [255, 127, 14, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

/**
 * Animated point layer using deck.gl binary interface
 * 
 * Performance optimizations (v2):
 * - SINGLE draw call: All tiles consolidated into one ScatterplotLayer
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Consolidated data cached - only rebuilt when tiles change (frameNumber)
 * - Layer instance memoized for time-only updates
 */
export class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
  static layerName = 'AnimatedPointLayer';
  
  // ========== CONSOLIDATED DATA CACHE ==========
  // Merges all tile data into a single data object for ONE draw call.
  // `paletteRef` / `mappingRef` hold the object identity of the palette and
  // mapping that produced the cached `colors` buffer; mutating either while
  // keeping the same field name on `fillColor` invalidates the cache.
  // Without these, swapping colorPalette/colorMapping returned stale colors.
  private consolidatedDataCache: {
    tiles: Tile[] | null;
    frameNumber: number;
    propsKey: string;
    paletteRef: unknown;
    mappingRef: unknown;
    data: ConsolidatedData | null;
  } = {
    tiles: null,
    frameNumber: -1,
    propsKey: '',
    paletteRef: null,
    mappingRef: null,
    data: null,
  };
  
  // ========== MEMOIZED LAYER CACHE ==========
  // Reuse the same layer instance when only time changes (not tiles)
  private cachedLayer: ScatterplotLayer | null = null;
  private cachedLayerFrameNumber: number = -1;
  
  // ========== CACHED PROPERTIES FOR PERFORMANCE ==========
  // These provide stable references so deck.gl can use fast reference equality
  // instead of expensive deep comparison during layer diffing.
  
  // Cached updateTriggers object - only recreated when relevant props change
  private cachedUpdateTriggers: Record<string, any> = {};
  
  // Track last prop values to detect changes
  private lastFillColor: Color | string | undefined = undefined;
  private lastRadius: number | string | undefined = undefined;
  private lastColorPalette: Color[] | undefined = undefined;
  
  // Cached color/radius props object - only recreated when props change
  private cachedColorRadiusProps: Record<string, any> | null = null;
  private lastFillColorForProps: Color | string | undefined = undefined;
  private lastRadiusForProps: number | string | undefined = undefined;

  // Stable bound getTime function - hoisted so the layer prop reference is
  // stable across renderLayers() calls (avoids defeating memoization).
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // ScatterplotLayer props
    radiusScale: { type: 'number', value: 1, min: 0 },
    radiusUnits: 'pixels',
    fillColor: { type: 'color', value: [255, 128, 0, 255] as Color },
    radius: { type: 'number', value: 5 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    
    // 3D support
    use3D: false,
    elevationProperty: null,
    elevationScale: { type: 'number', value: 1, min: 0 },
    
    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };
  
  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    // Clean up cached data — shape must match the field declaration above
    // (including paletteRef / mappingRef which were added to fix the
    // stale-palette cache bug).
    this.consolidatedDataCache = {
      tiles: null,
      frameNumber: -1,
      propsKey: '',
      paletteRef: null,
      mappingRef: null,
      data: null,
    };
    this.cachedLayer = null;
  }
  
  /**
   * PERFORMANCE OPTIMIZED renderLayers:
   * - Creates a SINGLE ScatterplotLayer for ALL tiles (1 draw call)
   * - Caches consolidated data - only rebuilds when tiles change
   * - TRULY MEMOIZES layer instance - returns SAME layer for time-only updates
   * - Time updates happen via getTime() getter in TimeFilterExtension.draw()
   */
  renderLayers(): Layer[] {
    const { tiles, frameNumber } = this.state;
    
    if (!tiles || tiles.length === 0) {
      if (DEBUG) console.log('AnimatedPointLayer: No tiles loaded');
      this.cachedLayer = null;
      return [];
    }
    
    const currentFrameNumber = frameNumber || 0;
    
    // Get or build consolidated data for all tiles
    const data = this.getConsolidatedData(tiles, currentFrameNumber);
    
    if (!data || data.length === 0) {
      if (DEBUG) console.log('AnimatedPointLayer: No features in tiles');
      return [];
    }
    
    // ========== LAYER MEMOIZATION ==========
    // Return the SAME layer instance if tiles haven't changed.
    // Time updates are handled by the getTime() getter in TimeFilterExtension.draw()
    if (this.cachedLayer && this.cachedLayerFrameNumber === currentFrameNumber) {
      // Check if props that affect the layer have changed
      const propsUnchanged = 
        this.props.fillColor === this.lastFillColor &&
        this.props.radius === this.lastRadius &&
        this.props.colorPalette === this.lastColorPalette &&
        this.props.opacity === (this.cachedLayer.props as any).opacity &&
        this.props.visible === (this.cachedLayer.props as any).visible;
      
      if (propsUnchanged) {
        if (DEBUG) console.log('AnimatedPointLayer: Returning memoized layer');
        return [this.cachedLayer];
      }
    }
    
    if (DEBUG) {
      console.log(`AnimatedPointLayer: ${tiles.length} tiles, ${data.length} total features, creating layer`);
    }
    
    // ========== UPDATE CACHED OBJECTS ONLY WHEN PROPS CHANGE ==========
    if (this.props.fillColor !== this.lastFillColor ||
        this.props.radius !== this.lastRadius ||
        this.props.colorPalette !== this.lastColorPalette) {
      this.lastFillColor = this.props.fillColor;
      this.lastRadius = this.props.radius;
      this.lastColorPalette = this.props.colorPalette;
      this.cachedUpdateTriggers = {
        getFillColor: [this.props.fillColor, this.props.colorPalette, currentFrameNumber],
        getRadius: [this.props.radius, currentFrameNumber],
      };
    }
    
    // Create and cache the layer
    const layer = this.createConsolidatedLayer(data);
    this.cachedLayer = layer;
    this.cachedLayerFrameNumber = currentFrameNumber;

    return [layer];
  }
  
  /**
   * Get or create consolidated data from all tiles.
   *
   * The cache key has two layers:
   *  1. tiles array reference — fast path for "same tiles array".
   *  2. tile-ID content match — handles the common case where the tileset
   *     returns a fresh array for the SAME tile set after an unrelated
   *     frameNumber bump (an animation tick, a non-content-changing tile
   *     load). Without the content check we'd allocate a fresh ~30 MB
   *     consolidated buffer per frame for no visual gain and re-upload it
   *     to the GPU, which on software WebGL takes ~1 s per upload.
   */
  private getConsolidatedData(tiles: Tile[], frameNumber: number): ConsolidatedData | null {
    const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : '';
    const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : '';
    const propsKey = `${fillColorProp}|${radiusProp}`;
    // Palette / mapping identity matters only when colors come from a
    // categorical property — the constant-color branch doesn't read them.
    const paletteRef = fillColorProp ? this.props.colorPalette ?? null : null;
    const mappingRef = fillColorProp ? this.props.colorMapping ?? null : null;
    const cache = this.consolidatedDataCache;

    if (
      cache.data &&
      cache.propsKey === propsKey &&
      cache.paletteRef === paletteRef &&
      cache.mappingRef === mappingRef &&
      cache.tiles &&
      (cache.tiles === tiles || tilesContentMatch(cache.tiles, tiles))
    ) {
      cache.frameNumber = frameNumber;
      return cache.data;
    }

    const data = this.buildConsolidatedData(tiles);

    this.consolidatedDataCache = {
      tiles,
      frameNumber,
      propsKey,
      paletteRef,
      mappingRef,
      data,
    };
    this.cachedLayer = null;
    this.cachedLayerFrameNumber = -1;
    return data;
  }
  
  /**
   * Build consolidated data by merging all tile binary data.
   *
   * Positions and per-feature times come from the pure `consolidatePoints`
   * helper (unit-tested). Times are kept RELATIVE to the layer-wide
   * timeOffset so they fit exactly in a Float32Array - the extension
   * subtracts the same offset from currentTime. Property-based color/radius
   * attributes are merged here.
   */
  private buildConsolidatedData(tiles: Tile[]): ConsolidatedData | null {
    const consolidated = consolidatePoints(tiles);
    if (!consolidated) {
      return null;
    }

    const { length: totalFeatures, dims, positions, startTimes, endTimes, timeOffset } =
      consolidated;

    // For property-based attributes
    const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : null;
    const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : null;
    let colors: Uint8Array | null = fillColorProp ? new Uint8Array(totalFeatures * 4) : null;
    let radii: Float32Array | null = radiusProp ? new Float32Array(totalFeatures) : null;
    const palette = this.props.colorPalette || DEFAULT_PALETTE;

    if (colors || radii) {
      let offset = 0;
      for (const tile of tiles) {
        for (const layer of tile.layers) {
          const binary = layer.features;
          const count = binary.featureCount;

          if (colors && fillColorProp) {
            const catProp = binary.categoricalProps[fillColorProp];
            const numProp = binary.numericProps[fillColorProp];
            if (catProp) {
              const mapping = this.props.colorMapping;
              const fallback =
                this.props.colorMappingDefault ?? [0, 0, 0, 0];
              for (let i = 0; i < count; i++) {
                const categoryIndex = catProp.indices[i];
                let color: Color;
                if (mapping) {
                  // Explicit mapping wins — looking up by category string
                  // produces stable colors across tiles whose category lists
                  // differ. (Falling back to palette[index] does not, since
                  // each tile rebuilds the category dictionary in first-seen
                  // order.)
                  const cat =
                    categoryIndex === 0xffff
                      ? undefined
                      : catProp.categories[categoryIndex];
                  color = (cat !== undefined && mapping[cat]) || fallback;
                } else {
                  color =
                    categoryIndex === 0xffff
                      ? fallback
                      : palette[categoryIndex % palette.length];
                }
                const dstIdx = (offset + i) * 4;
                colors[dstIdx] = color[0];
                colors[dstIdx + 1] = color[1];
                colors[dstIdx + 2] = color[2];
                colors[dstIdx + 3] = color[3] ?? 255;
              }
            } else if (numProp && this.props.colorMapping) {
              // Numeric column + explicit mapping: stringify the value to look
              // it up. Useful when a categorical-style key was accidentally
              // emitted as numeric (rare, but defensive).
              const mapping = this.props.colorMapping;
              const fallback =
                this.props.colorMappingDefault ?? [0, 0, 0, 0];
              for (let i = 0; i < count; i++) {
                const color = mapping[String(numProp[i])] || fallback;
                const dstIdx = (offset + i) * 4;
                colors[dstIdx] = color[0];
                colors[dstIdx + 1] = color[1];
                colors[dstIdx + 2] = color[2];
                colors[dstIdx + 3] = color[3] ?? 255;
              }
            }
          }

          if (radii && radiusProp) {
            const values = binary.numericProps[radiusProp];
            const transform = this.props.radiusTransform;
            if (values) {
              if (transform) {
                for (let i = 0; i < count; i++) {
                  radii[offset + i] = transform(values[i]);
                }
              } else {
                for (let i = 0; i < count; i++) {
                  radii[offset + i] = values[i];
                }
              }
            }
          }

          offset += count;
        }
      }
    }

    // `dims` is always 3 (see consolidatePoints).
    void dims;
    return {
      length: totalFeatures,
      timeOffset,
      positions,
      startTimes,
      endTimes,
      colors,
      radii,
    };
  }
  
  /**
   * Create a single ScatterplotLayer over the consolidated typed arrays.
   *
   * Uses deck.gl's binary `data.attributes` interface: typed arrays are
   * uploaded directly to the GPU and deck.gl never invokes a per-feature
   * accessor. On the AIS dataset (1.29M points) this eliminates millions
   * of accessor calls per tile-set change, which previously stalled the
   * main thread for several seconds at a time during animation playback.
   *
   * Wiring:
   * - ScatterplotLayer's own accessors are keyed under their accessor
   *   names: `getPosition`, `getFillColor`, `getRadius`.
   * - `TimeFilterExtension`'s instanced attributes are bound by ATTRIBUTE
   *   name, not accessor name: `instanceStartTime` / `instanceEndTime`
   *   (see attribute-wiring.test.ts).
   * - When a property-driven attribute is absent (constant color/radius)
   *   deck.gl falls back to the constant on `getRadius` / `getFillColor`.
   *
   * Time is snapshotted per render; the layer is rebuilt only when
   * `frameNumber` bumps, and intra-tile-set time updates take
   * `setNeedsRedraw()`, not a layer rebuild.
   */
  private createConsolidatedLayer(data: ConsolidatedData): ScatterplotLayer {
    const layerId = `${this.props.id}-consolidated`;
    const timeWindow = this.props.timeWindow || 86400000;
    const { length, positions, startTimes, endTimes, colors, radii, timeOffset } = data;

    const constRadius =
      typeof this.props.radius === 'number' ? this.props.radius : 5;
    const constColor = (Array.isArray(this.props.fillColor)
      ? this.props.fillColor
      : [255, 128, 0, 255]) as Color;

    const attributes: Record<string, any> = {
      getPosition: { value: positions, size: 3 },
      instanceStartTime: { value: startTimes, size: 1 },
      instanceEndTime: { value: endTimes, size: 1 },
    };
    if (colors) {
      attributes.getFillColor = { value: colors, size: 4, normalized: true };
    }
    if (radii) {
      attributes.getRadius = { value: radii, size: 1 };
    }

    return new ScatterplotLayer({
      id: layerId,
      data: { length, attributes } as any,
      // Forward user-facing display props. Hardcoding radiusUnits dropped
      // the demo configs' "meters" setting and turned 1000m ship markers
      // into 1000-pixel discs that covered the entire viewport.
      radiusUnits: this.props.radiusUnits ?? 'pixels',
      radiusScale: this.props.radiusScale ?? 1,
      radiusMinPixels: this.props.radiusMinPixels ?? 0,
      radiusMaxPixels: this.props.radiusMaxPixels ?? Number.MAX_SAFE_INTEGER,
      stroked: this.props.stroked ?? false,
      filled: this.props.filled ?? true,
      getLineColor: this.props.strokeColor ?? [0, 0, 0, 255],
      lineWidthMinPixels: this.props.lineWidthMinPixels ?? 0,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,

      // Constant fallbacks — deck.gl uses these when no binary buffer is
      // present for the corresponding accessor.
      getRadius: constRadius,
      getFillColor: constColor,

      extensions: [TIME_FILTER_EXTENSION],
      // Dynamic time: TimeFilterExtension.draw() reads getTime() every frame,
      // so the layer instance can be memoized across animation ticks and only
      // the uniform changes. Passing `currentTime: snapshotTime` froze the
      // shader uniform until the next tile-set change, which produced a
      // visible "points stop animating between tile churn" bug. Paths and
      // trips already use the getTime path; points now match.
      getTime: this.boundGetTime,
      timeOffset,
      timeWindow,

      updateTriggers: {
        getPosition: positions,
        instanceStartTime: startTimes,
        instanceEndTime: endTimes,
        getRadius: radii ?? [this.props.radius, this.props.radiusUnits, this.props.radiusScale],
        getFillColor: colors ?? [this.props.fillColor, this.props.colorPalette, this.props.colorMapping],
      },
    });
  }
}
