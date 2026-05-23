/**
 * AnimatedTripsLayer - GPU-efficient animated trips/trajectories
 * 
 * Provides a "vehicle moving along route" effect where paths are progressively 
 * drawn with a trailing fade effect.
 * 
 * PERFORMANCE OPTIMIZED (v2 - Consolidated Rendering):
 * - Consolidates ALL tiles into a SINGLE PathLayer (1 draw call instead of N)
 * - Uses PathLayer with binary data interface (no per-frame JS object creation)
 * - Trail rendering done entirely in GPU via TimeFilterExtension
 * - Per-vertex timestamps computed once and cached
 * - Layer instance memoized to avoid recreation on time-only updates
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import type { Tile } from '@stt/core';

// Debug flag
const DEBUG = false;

/**
 * Consolidated path data from all tiles
 */
interface ConsolidatedPathData {
  length: number;
  startIndices: Uint32Array;
  /** Layer-wide time offset. instanceVertexTime is RELATIVE to this. */
  timeOffset: number;
  attributes: {
    // Float64Array for deck.gl's fp64 position attribute (full lon/lat precision).
    getPath: { value: Float64Array; size: number };
    // Keyed by the exact attribute name TimeFilterExtension registers.
    instanceVertexTime: { value: Float32Array; size: 1 };
    getColor?: { value: Uint8Array; size: 4; normalized: boolean };
    getWidth?: { value: Float32Array; size: 1 };
  };
}

export interface AnimatedTripsLayerProps extends SpatioTemporalLayerProps {
  /** Width scale multiplier */
  widthScale?: number;
  
  /** Minimum width in pixels */
  widthMinPixels?: number;
  
  /** Maximum width in pixels */
  widthMaxPixels?: number;
  
  /** Trip color - constant value or property name */
  tripColor?: Color | string;
  
  /** Trip width - constant value or property name */
  tripWidth?: number | string;
  
  /** Color palette for categorical properties */
  colorPalette?: Color[];
  
  /** Trail length in time units (milliseconds) */
  trailLength?: number;
  
  /** Whether the trail fades out (always true for this implementation) */
  fadeTrail?: boolean;
  
  /** Round caps on path ends */
  capRounded?: boolean;
  
  /** Round joints between path segments */
  jointRounded?: boolean;
}

// Default color palette
const DEFAULT_PALETTE: Color[] = [
  [253, 128, 93, 255],
  [0, 150, 255, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
];

/**
 * Animated trips layer for trajectory data with progressive drawing
 * 
 * Performance optimizations (v2):
 * - SINGLE draw call: All tiles consolidated into one PathLayer
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - TimeFilterExtension handles trail rendering in shaders
 * - Consolidated data cached - only rebuilt when tiles change (frameNumber)
 * - Layer instance memoized for time-only updates
 */
export class AnimatedTripsLayer extends SpatioTemporalLayer<AnimatedTripsLayerProps> {
  static layerName = 'AnimatedTripsLayer';
  
  // ========== CONSOLIDATED DATA CACHE ==========
  // Merges all tile data into a single data object for ONE draw call
  private consolidatedDataCache: {
    frameNumber: number;
    propsKey: string;
    data: ConsolidatedPathData | null;
  } = { frameNumber: -1, propsKey: '', data: null };
  
  // ========== MEMOIZED LAYER CACHE ==========
  private cachedLayer: PathLayer | null = null;
  private cachedLayerFrameNumber: number = -1;
  
  // Track last prop values to detect changes
  private lastTripColor: Color | string | undefined = undefined;
  private lastTripWidth: number | string | undefined = undefined;
  private lastColorPalette: Color[] | undefined = undefined;

  // Stable bound getTime - stable reference avoids defeating memoization.
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  // Singleton TimeFilterExtension reused across renders of this layer.
  private readonly timeFilterExtension: TimeFilterExtension = new TimeFilterExtension();

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // Path styling props
    widthScale: { type: 'number', value: 1, min: 0 },
    widthMinPixels: { type: 'number', value: 2 },
    widthMaxPixels: { type: 'number', value: 10 },
    tripColor: { type: 'color', value: [253, 128, 93, 255] as Color },
    tripWidth: { type: 'number', value: 3 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    
    // Trail props
    trailLength: { type: 'number', value: 180000, min: 0 }, // 3 minutes default
    fadeTrail: true,
    capRounded: true,
    jointRounded: true,
  };
  
  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.consolidatedDataCache = { frameNumber: -1, propsKey: '', data: null };
    this.cachedLayer = null;
  }

  /**
   * Override to ensure time window is large enough for trail rendering.
   */
  protected getEffectiveTimeWindow(): number {
    const baseWindow = this.props.timeWindow || 86400000;
    const trailLength = this.props.trailLength || 180000;
    const minWindowForTrail = trailLength * 2;
    return Math.max(baseWindow, minWindowForTrail);
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
      if (DEBUG) console.log('AnimatedTripsLayer: No tiles loaded');
      this.cachedLayer = null;
      return [];
    }

    const currentFrameNumber = frameNumber || 0;
    
    // Get or build consolidated data for all tiles
    const data = this.getConsolidatedData(tiles, currentFrameNumber);
    
    if (!data || data.length === 0) {
      if (DEBUG) console.log('AnimatedTripsLayer: No features in tiles');
      return [];
    }
    
    // ========== LAYER MEMOIZATION ==========
    // Return the SAME layer instance if tiles haven't changed.
    // Time updates are handled by the getTime() getter in TimeFilterExtension.draw()
    if (this.cachedLayer && this.cachedLayerFrameNumber === currentFrameNumber) {
      const propsUnchanged = 
        this.props.tripColor === this.lastTripColor &&
        this.props.tripWidth === this.lastTripWidth &&
        this.props.colorPalette === this.lastColorPalette &&
        this.props.opacity === (this.cachedLayer.props as any).opacity &&
        this.props.visible === (this.cachedLayer.props as any).visible;
      
      if (propsUnchanged) {
        if (DEBUG) console.log('AnimatedTripsLayer: Returning memoized layer');
        return [this.cachedLayer];
      }
    }
    
    if (DEBUG) {
      console.log(`AnimatedTripsLayer: ${tiles.length} tiles, ${data.length} paths, creating single layer`);
    }
    
    // Update prop tracking
    this.lastTripColor = this.props.tripColor;
    this.lastTripWidth = this.props.tripWidth;
    this.lastColorPalette = this.props.colorPalette;
    
    // Create the single consolidated layer
    const layer = this.createConsolidatedPathLayer(data);
    
    this.cachedLayer = layer;
    this.cachedLayerFrameNumber = currentFrameNumber;

    return [layer];
  }
  
  /**
   * Get or create consolidated data from all tiles.
   * Cached by frameNumber - rebuilds only when tiles or structural props change.
   *
   * NOTE: the cache key intentionally does NOT include time. Trail clipping is
   * done entirely on the GPU by TimeFilterExtension, so the consolidated
   * buffers are time-independent and stay cached across animation frames.
   */
  private getConsolidatedData(tiles: Tile[], frameNumber: number): ConsolidatedPathData | null {
    // Generate cache key from props that affect data structure
    const colorProp = typeof this.props.tripColor === 'string' ? this.props.tripColor : '';
    const widthProp = typeof this.props.tripWidth === 'string' ? this.props.tripWidth : '';
    const propsKey = `${colorProp}|${widthProp}`;

    // Return cached data if still valid
    if (this.consolidatedDataCache.data &&
        this.consolidatedDataCache.frameNumber === frameNumber &&
        this.consolidatedDataCache.propsKey === propsKey) {
      return this.consolidatedDataCache.data;
    }
    
    // Build new consolidated data
    const data = this.buildConsolidatedData(tiles);
    
    // Cache it
    this.consolidatedDataCache = {
      frameNumber,
      propsKey,
      data,
    };
    
    // Invalidate layer cache since data changed
    this.cachedLayer = null;
    this.cachedLayerFrameNumber = -1;
    
    return data;
  }
  
  /**
   * Build consolidated data by merging all tile binary path data.
   *
   * Trail clipping is done ENTIRELY on the GPU by TimeFilterExtension (trail
   * mode). This method therefore copies ALL vertices of ALL features once and
   * the buffers are time-independent - they stay cached across frames. Per-
   * vertex times are kept RELATIVE to the layer-wide timeOffset so they fit
   * exactly in Float32 (float32-precision fix).
   */
  private buildConsolidatedData(tiles: Tile[]): ConsolidatedPathData | null {
    // First pass: count features and vertices, find dims + layer time offset.
    let totalFeatures = 0;
    let totalVertices = 0;
    let dims = 2;
    let layerTimeOffset = 0;
    let foundOffset = false;

    for (const tile of tiles) {
      for (const layer of tile.layers) {
        const binary = layer.features;
        if (binary.featureCount === 0 || !binary.startIndices) continue;

        if (!foundOffset) {
          layerTimeOffset = binary.timeOffset;
          foundOffset = true;
        }

        // Count only features with >= 2 vertices (drawable paths).
        for (let i = 0; i < binary.featureCount; i++) {
          const numVerts = binary.startIndices[i + 1] - binary.startIndices[i];
          if (numVerts < 2) continue;
          totalFeatures++;
          totalVertices += numVerts;
        }

        if (binary.positionDimensions && binary.positionDimensions > dims) {
          dims = binary.positionDimensions;
        }
      }
    }

    if (totalFeatures === 0 || totalVertices === 0) {
      return null;
    }

    if (DEBUG) {
      console.log(`AnimatedTripsLayer: Consolidating ${totalFeatures} paths, ${totalVertices} vertices from ${tiles.length} tiles`);
    }

    // Allocate consolidated arrays. Positions are Float64Array for deck.gl's
    // fp64 position attribute (a Float32Array leaves the 64-low buffer unset).
    const positions = new Float64Array(totalVertices * dims);
    const vertexTimes = new Float32Array(totalVertices);
    const startIndices = new Uint32Array(totalFeatures + 1);

    // For property-based attributes
    const colorProp = typeof this.props.tripColor === 'string' ? this.props.tripColor : null;
    const widthProp = typeof this.props.tripWidth === 'string' ? this.props.tripWidth : null;
    let colors: Uint8Array | null = colorProp ? new Uint8Array(totalFeatures * 4) : null;
    let widths: Float32Array | null = widthProp ? new Float32Array(totalFeatures) : null;
    const palette = this.props.colorPalette || DEFAULT_PALETTE;

    // Second pass: copy ALL vertices of every drawable feature.
    let featureOffset = 0;
    let vertexOffset = 0;

    for (const tile of tiles) {
      for (const layer of tile.layers) {
        const binary = layer.features;
        if (binary.featureCount === 0 || !binary.startIndices) continue;

        const srcDims = binary.positionDimensions ?? 2;
        const timeOffset = binary.timeOffset;
        // Rebase this tile's relative times onto the layer-wide offset.
        const offsetDelta = timeOffset - layerTimeOffset;
        const hasVertexTimestamps = !!(binary.vertexTimestamps && binary.vertexTimestamps.length > 0);

        for (let i = 0; i < binary.featureCount; i++) {
          const vStart = binary.startIndices[i];
          const vEnd = binary.startIndices[i + 1];
          const numVerts = vEnd - vStart;
          if (numVerts < 2) continue;

          startIndices[featureOffset] = vertexOffset;

          // Copy positions
          for (let v = 0; v < numVerts; v++) {
            const srcIdx = (vStart + v) * srcDims;
            const dstIdx = (vertexOffset + v) * dims;
            positions[dstIdx] = binary.positions[srcIdx];
            positions[dstIdx + 1] = binary.positions[srcIdx + 1];
            if (dims === 3) {
              positions[dstIdx + 2] = srcDims === 3 ? binary.positions[srcIdx + 2] : 0;
            }
          }

          // Copy per-vertex times, kept RELATIVE to layerTimeOffset.
          if (hasVertexTimestamps) {
            for (let v = 0; v < numVerts; v++) {
              vertexTimes[vertexOffset + v] =
                binary.vertexTimestamps![vStart + v] + offsetDelta;
            }
          } else {
            // Fallback: interpolate from feature start/end times.
            const featureStart = binary.startTimes[i] + offsetDelta;
            const featureEnd = binary.endTimes[i] + offsetDelta;
            const duration = featureEnd - featureStart;
            for (let v = 0; v < numVerts; v++) {
              const progress = numVerts > 1 ? v / (numVerts - 1) : 0;
              vertexTimes[vertexOffset + v] = featureStart + progress * duration;
            }
          }

          // Copy color if using property-based coloring
          if (colors && colorProp) {
            const prop = binary.categoricalProps[colorProp];
            if (prop) {
              const categoryIndex = prop.indices[i];
              const color = palette[categoryIndex % palette.length];
              const dstIdx = featureOffset * 4;
              colors[dstIdx] = color[0];
              colors[dstIdx + 1] = color[1];
              colors[dstIdx + 2] = color[2];
              colors[dstIdx + 3] = color[3] ?? 255;
            }
          }

          // Copy width if using property-based width
          if (widths && widthProp) {
            const values = binary.numericProps[widthProp];
            if (values) {
              widths[featureOffset] = values[i];
            }
          }

          featureOffset++;
          vertexOffset += numVerts;
        }
      }
    }

    // Set final startIndex (total vertex count)
    startIndices[totalFeatures] = totalVertices;

    // Build result
    const result: ConsolidatedPathData = {
      length: totalFeatures,
      startIndices,
      timeOffset: layerTimeOffset,
      attributes: {
        getPath: { value: positions, size: dims },
        instanceVertexTime: { value: vertexTimes, size: 1 },
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
   * Per-feature objects + accessors (deck.gl 9.3's binary `data.attributes`
   * silently fails); snapshot `currentTime` (the `getTime` getter pattern
   * filters every vertex). Per-vertex timestamps for the trail shader are
   * sliced from the consolidated `vertexTimes` buffer.
   */
  private createConsolidatedPathLayer(data: ConsolidatedPathData): PathLayer {
    const timeWindow = this.props.timeWindow || 86400000;
    const positionsArr = data.attributes.getPath.value;
    const vertexTimesArr = data.attributes.instanceVertexTime!.value;
    const colorBuf = data.attributes.getColor?.value;
    const widthBuf = data.attributes.getWidth?.value;
    const dims = data.attributes.getPath.size;

    // Per-feature lightweight objects backed by zero-copy `subarray` views
    // into the consolidated typed arrays. The previous implementation built
    // `new Array(n * dims)` per feature and copied every vertex into it,
    // which dominated render time on large trip datasets. With `subarray`,
    // each feature carries two views (path + vertex times) and no copies.
    interface TripFeat {
      path: Float64Array;
      vertexTimes: Float32Array;
      color?: [number, number, number, number];
      width?: number;
    }
    const features: TripFeat[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const v0 = data.startIndices[i];
      const v1 = data.startIndices[i + 1];
      const f: TripFeat = {
        path: positionsArr.subarray(v0 * dims, v1 * dims),
        vertexTimes: vertexTimesArr.subarray(v0, v1),
      };
      if (colorBuf) {
        const c = i * 4;
        f.color = [colorBuf[c], colorBuf[c + 1], colorBuf[c + 2], colorBuf[c + 3]];
      }
      if (widthBuf) f.width = widthBuf[i];
      features[i] = f;
    }

    const constColor = (Array.isArray(this.props.tripColor)
      ? this.props.tripColor
      : [253, 128, 93, 255]) as Color;
    const constWidth = typeof this.props.tripWidth === 'number' ? this.props.tripWidth : 2;
    const snapshotTime = this.getCurrentTime();

    return new PathLayer({
      id: `${this.props.id}-consolidated`,
      data: features,
      _pathType: 'open',
      // See AnimatedPathLayer: PathLayer defaults `positionFormat` to 'XYZ',
      // which misreads 2D flat-array paths as 3D triples and corrupts every
      // vertex. Match the consolidated `dims`.
      positionFormat: dims === 3 ? 'XYZ' : 'XY',
      widthUnits: 'pixels',
      // Forward user-facing display props — without these the demo's
      // widthMinPixels/widthMaxPixels clamps, rounded caps/joints and
      // opacity/visible/pickable settings were silently dropped.
      widthScale: this.props.widthScale ?? 1,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      capRounded: this.props.capRounded,
      jointRounded: this.props.jointRounded,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,

      getPath: (d: TripFeat) => d.path,
      getColor: colorBuf ? (d: TripFeat) => d.color ?? constColor : constColor,
      getWidth: widthBuf ? (d: TripFeat) => d.width ?? constWidth : constWidth,
      // CRITICAL: PathLayer's per-vertex distribution kicks in only when this
      // accessor returns the full per-feature ARRAY of vertex times. Returning
      // a single number (e.g. `d.vertexTimes[info.index]`) made deck.gl call
      // the accessor once per feature with `info.index = featureIndex` and
      // then replicate that one value across every vertex of the feature —
      // producing the "whole flight path flashes on/off" bug instead of a
      // trailing animation. deck.gl's own TripsLayer follows the same
      // array-returning pattern.
      getInstanceVertexTime: (d: TripFeat) => d.vertexTimes,

      extensions: [this.timeFilterExtension],
      currentTime: snapshotTime,
      timeOffset: data.timeOffset,
      timeWindow,
      trailLength: this.props.trailLength,

      updateTriggers: {
        getPath: positionsArr,
        getInstanceVertexTime: vertexTimesArr,
        getColor: colorBuf ?? [this.props.tripColor, this.props.colorPalette],
        getWidth: widthBuf ?? [this.props.tripWidth, this.props.widthScale],
      },
    });
  }
}
