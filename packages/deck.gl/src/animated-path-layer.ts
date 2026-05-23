/**
 * AnimatedPathLayer - GPU-efficient path/trajectory rendering with time filtering
 *
 * Operates in WINDOW MODE: each feature is shown (with optional fade) when its
 * `[startTime, endTime]` overlaps the current time window. Whole paths render
 * at once. For a "vehicle moving along the route" effect with a trailing fade,
 * use AnimatedTripsLayer instead — it consumes per-vertex times (or
 * interpolates them from feature start/end) and runs the trail shader.
 *
 * PERFORMANCE OPTIMIZED (v2 - Consolidated Rendering):
 * - Consolidates ALL tiles into a SINGLE PathLayer (1 draw call instead of N)
 * - Uses deck.gl's binary data interface for maximum performance
 * - Passes typed arrays directly to GPU (no accessor function calls)
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Layer instance memoized to avoid recreation on time-only updates
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import { consolidatePaths } from './consolidate';
import type { Tile } from '@stt/core';

// Debug flag
const DEBUG = false;

// Singleton TimeFilterExtension instance - reused across all layers
const TIME_FILTER_EXTENSION = new TimeFilterExtension();

/**
 * Consolidated path data from all tiles
 */
interface ConsolidatedPathData {
  length: number;
  startIndices: Uint32Array;
  /** Layer-wide time offset. All time attributes are RELATIVE to this. */
  timeOffset: number;
  attributes: {
    // Float64Array for deck.gl's fp64 position attribute (full lon/lat precision).
    getPath: { value: Float64Array; size: number };
    // Keyed by the exact attribute name TimeFilterExtension registers.
    instanceStartTime: { value: Float32Array; size: 1 };
    instanceEndTime: { value: Float32Array; size: 1 };
    getColor?: { value: Uint8Array; size: 4; normalized: boolean };
    getWidth?: { value: Float32Array; size: 1 };
  };
}

export interface AnimatedPathLayerProps extends SpatioTemporalLayerProps {
  /** Width scale multiplier */
  widthScale?: number;
  
  /** Width units ('pixels' | 'meters') */
  widthUnits?: 'pixels' | 'meters';
  
  /** Path color - constant value or property name for categorical coloring */
  pathColor?: Color | string;
  
  /** Path width - constant value or property name */
  pathWidth?: number | string;
  
  /** Color palette for categorical properties */
  colorPalette?: Color[];

  /** Fade-in duration for appearing paths (ms) */
  fadeInDuration?: number;
  
  /** Fade-out duration for disappearing paths (ms) */
  fadeOutDuration?: number;
}

// Default color palette for categorical data
const DEFAULT_PALETTE: Color[] = [
  [0, 150, 255, 255],
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
 * Animated path layer using deck.gl binary interface
 * 
 * Performance optimizations (v2):
 * - SINGLE draw call: All tiles consolidated into one PathLayer
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Consolidated data cached - only rebuilt when tiles change (frameNumber)
 * - Layer instance memoized for time-only updates
 */
export class AnimatedPathLayer extends SpatioTemporalLayer<AnimatedPathLayerProps> {
  static layerName = 'AnimatedPathLayer';
  
  // ========== CONSOLIDATED DATA CACHE ==========
  private consolidatedDataCache: {
    frameNumber: number;
    propsKey: string;
    data: ConsolidatedPathData | null;
  } = { frameNumber: -1, propsKey: '', data: null };
  
  // ========== MEMOIZED LAYER CACHE ==========
  private cachedLayer: PathLayer | null = null;
  private cachedLayerFrameNumber: number = -1;
  
  // Track last prop values
  private lastPathColor: Color | string | undefined = undefined;
  private lastPathWidth: number | string | undefined = undefined;
  private lastColorPalette: Color[] | undefined = undefined;

  // Stable bound getTime - stable reference avoids defeating memoization.
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // PathLayer props
    widthScale: { type: 'number', value: 1, min: 0 },
    widthUnits: 'pixels',
    pathColor: { type: 'color', value: [0, 150, 255, 255] as Color },
    pathWidth: { type: 'number', value: 3 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },

    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };
  
  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.consolidatedDataCache = { frameNumber: -1, propsKey: '', data: null };
    this.cachedLayer = null;
  }

  /**
   * PERFORMANCE OPTIMIZED renderLayers:
   * - Creates a SINGLE PathLayer for ALL tiles (1 draw call)
   * - Caches consolidated data - only rebuilds when tiles change
   * - TRULY MEMOIZES layer instance - returns SAME layer for time-only updates
   */
  renderLayers(): Layer[] {
    const { tiles, frameNumber } = this.state;
    
    if (!tiles || tiles.length === 0) {
      if (DEBUG) console.log('AnimatedPathLayer: No tiles loaded');
      this.cachedLayer = null;
      return [];
    }

    const currentFrameNumber = frameNumber || 0;
    
    // Get or build consolidated data for all tiles
    const data = this.getConsolidatedData(tiles, currentFrameNumber);
    
    if (!data || data.length === 0) {
      if (DEBUG) console.log('AnimatedPathLayer: No features in tiles');
      return [];
    }
    
    // ========== LAYER MEMOIZATION ==========
    if (this.cachedLayer && this.cachedLayerFrameNumber === currentFrameNumber) {
      const propsUnchanged = 
        this.props.pathColor === this.lastPathColor &&
        this.props.pathWidth === this.lastPathWidth &&
        this.props.colorPalette === this.lastColorPalette &&
        this.props.opacity === (this.cachedLayer.props as any).opacity &&
        this.props.visible === (this.cachedLayer.props as any).visible;
      
      if (propsUnchanged) {
        if (DEBUG) console.log('AnimatedPathLayer: Returning memoized layer');
        return [this.cachedLayer];
      }
    }
    
    if (DEBUG) {
      console.log(`AnimatedPathLayer: ${tiles.length} tiles, ${data.length} paths, creating single layer`);
    }
    
    // Update prop tracking
    this.lastPathColor = this.props.pathColor;
    this.lastPathWidth = this.props.pathWidth;
    this.lastColorPalette = this.props.colorPalette;
    
    // Create the single consolidated layer
    const layer = this.createConsolidatedPathLayer(data);
    
    this.cachedLayer = layer;
    this.cachedLayerFrameNumber = currentFrameNumber;

    return [layer];
  }
  
  /**
   * Get or create consolidated data from all tiles.
   */
  private getConsolidatedData(tiles: Tile[], frameNumber: number): ConsolidatedPathData | null {
    const colorProp = typeof this.props.pathColor === 'string' ? this.props.pathColor : '';
    const widthProp = typeof this.props.pathWidth === 'string' ? this.props.pathWidth : '';
    const propsKey = `${colorProp}|${widthProp}`;
    
    if (this.consolidatedDataCache.data &&
        this.consolidatedDataCache.frameNumber === frameNumber &&
        this.consolidatedDataCache.propsKey === propsKey) {
      return this.consolidatedDataCache.data;
    }
    
    const data = this.buildConsolidatedData(tiles);
    
    this.consolidatedDataCache = {
      frameNumber,
      propsKey,
      data,
    };
    
    this.cachedLayer = null;
    this.cachedLayerFrameNumber = -1;
    
    return data;
  }
  
  /**
   * Build consolidated data by merging all tile binary path data.
   *
   * Positions, startIndices and per-feature times come from the pure
   * `consolidatePaths` helper (unit-tested). Times are kept RELATIVE to the
   * layer-wide timeOffset (float32-precision fix). Property-based color/width
   * attributes are merged here.
   */
  private buildConsolidatedData(tiles: Tile[]): ConsolidatedPathData | null {
    const consolidated = consolidatePaths(tiles);
    if (!consolidated) {
      return null;
    }

    const {
      length: totalFeatures,
      dims,
      positions,
      startIndices,
      startTimes,
      endTimes,
      timeOffset: layerTimeOffset,
    } = consolidated;

    if (DEBUG) {
      console.log(`AnimatedPathLayer: Consolidating ${totalFeatures} paths`);
    }

    const colorProp = typeof this.props.pathColor === 'string' ? this.props.pathColor : null;
    const widthProp = typeof this.props.pathWidth === 'string' ? this.props.pathWidth : null;
    let colors: Uint8Array | null = colorProp ? new Uint8Array(totalFeatures * 4) : null;
    let widths: Float32Array | null = widthProp ? new Float32Array(totalFeatures) : null;
    const palette = this.props.colorPalette || DEFAULT_PALETTE;

    if (colors || widths) {
      let featureOffset = 0;
      for (const tile of tiles) {
        for (const layer of tile.layers) {
          const binary = layer.features;
          if (binary.featureCount === 0 || !binary.startIndices) continue;

          if (colors && colorProp) {
            const prop = binary.categoricalProps[colorProp];
            if (prop) {
              for (let i = 0; i < binary.featureCount; i++) {
                const categoryIndex = prop.indices[i];
                const color = palette[categoryIndex % palette.length];
                const dstIdx = (featureOffset + i) * 4;
                colors[dstIdx] = color[0];
                colors[dstIdx + 1] = color[1];
                colors[dstIdx + 2] = color[2];
                colors[dstIdx + 3] = color[3] ?? 255;
              }
            }
          }

          if (widths && widthProp) {
            const values = binary.numericProps[widthProp];
            if (values) {
              for (let i = 0; i < binary.featureCount; i++) {
                widths[featureOffset + i] = values[i];
              }
            }
          }

          featureOffset += binary.featureCount;
        }
      }
    }

    const result: ConsolidatedPathData = {
      length: totalFeatures,
      startIndices,
      timeOffset: layerTimeOffset,
      attributes: {
        getPath: { value: positions, size: dims },
        instanceStartTime: { value: startTimes, size: 1 },
        instanceEndTime: { value: endTimes, size: 1 },
      },
    };
    
    if (colors) {
      result.attributes.getColor = { value: colors, size: 4, normalized: true };
    }
    
    if (widths) {
      result.attributes.getWidth = { value: widths, size: 1 };
    }
    
    return result;
  }
  
  /**
   * Create a single PathLayer from consolidated data.
   *
   * Per-feature objects, but each carries a zero-copy `subarray` view into
   * the consolidated positions Float64Array. The previous implementation
   * allocated `new Array(n * dims)` and copied every vertex per feature,
   * which dominated render time on large path datasets.
   *
   * Why not the binary `data.attributes` path? In deck.gl 9.3 it silently
   * fails to render when combined with `TimeFilterExtension`. Per-feature
   * subarrays keep accessor semantics (and PathLayer's existing
   * positionFormat handling) intact while removing the per-vertex copy.
   * Time is snapshotted per render (the `getTime` getter trips the same
   * 9.3 bug); intra-tile-set redraws go through `setNeedsRedraw()`.
   */
  private createConsolidatedPathLayer(data: ConsolidatedPathData): PathLayer {
    const timeWindow = this.props.timeWindow || 86400000;
    const positionsArr = data.attributes.getPath.value;
    const startTimesArr = data.attributes.instanceStartTime.value;
    const endTimesArr = data.attributes.instanceEndTime.value;
    const colorBuf = data.attributes.getColor?.value;
    const widthBuf = data.attributes.getWidth?.value;
    const dims = data.attributes.getPath.size;

    interface PathFeat {
      path: Float64Array;
      startTime: number;
      endTime: number;
      color?: [number, number, number, number];
      width?: number;
    }
    const features: PathFeat[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const v0 = data.startIndices[i];
      const v1 = data.startIndices[i + 1];
      const f: PathFeat = {
        path: positionsArr.subarray(v0 * dims, v1 * dims),
        startTime: startTimesArr[i],
        endTime: endTimesArr[i],
      };
      if (colorBuf) {
        const c = i * 4;
        f.color = [colorBuf[c], colorBuf[c + 1], colorBuf[c + 2], colorBuf[c + 3]];
      }
      if (widthBuf) f.width = widthBuf[i];
      features[i] = f;
    }

    const constColor = (Array.isArray(this.props.pathColor)
      ? this.props.pathColor
      : [31, 186, 214, 255]) as Color;
    const constWidth = typeof this.props.pathWidth === 'number' ? this.props.pathWidth : 2;
    const snapshotTime = this.getCurrentTime();

    return new PathLayer({
      id: `${this.props.id}-consolidated`,
      data: features,
      _pathType: 'open',
      // Tile data is 2D (lon, lat) or 3D (lon, lat, alt); each feature's
      // `path` is a flat `Float64Array.subarray`. PathLayer's tesselator
      // derives vertex stride from `positionFormat`, which defaults to
      // 'XYZ' — feeding 2D data through the default reads garbage z values
      // and shifts every vertex.
      positionFormat: dims === 3 ? 'XYZ' : 'XY',
      // Forward user-facing display props — without these, layer-level
      // settings from the demo (widthUnits, widthScale, opacity, pickable,
      // min/max width clamps) were silently dropped on the floor.
      widthUnits: this.props.widthUnits ?? 'pixels',
      widthScale: this.props.widthScale ?? 1,
      widthMinPixels: (this.props as any).widthMinPixels,
      widthMaxPixels: (this.props as any).widthMaxPixels,
      capRounded: (this.props as any).capRounded,
      jointRounded: (this.props as any).jointRounded,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,

      getPath: (d: PathFeat) => d.path,
      getColor: colorBuf ? (d: PathFeat) => d.color ?? constColor : constColor,
      getWidth: widthBuf ? (d: PathFeat) => d.width ?? constWidth : constWidth,
      getInstanceStartTime: (d: PathFeat) => d.startTime,
      getInstanceEndTime: (d: PathFeat) => d.endTime,

      extensions: [TIME_FILTER_EXTENSION],
      currentTime: snapshotTime,
      timeOffset: data.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,

      updateTriggers: {
        getPath: positionsArr,
        getInstanceStartTime: startTimesArr,
        getInstanceEndTime: endTimesArr,
        getColor: colorBuf ?? [this.props.pathColor, this.props.colorPalette],
        getWidth: widthBuf ?? [this.props.pathWidth, this.props.widthUnits, this.props.widthScale],
      },
    });
  }
}
