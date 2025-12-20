/**
 * AnimatedTripsLayer - GPU-efficient animated trips/trajectories
 * 
 * Provides a "vehicle moving along route" effect where paths are progressively 
 * drawn with a trailing fade effect.
 * 
 * PERFORMANCE OPTIMIZED:
 * - Uses PathLayer with binary data interface (no per-frame JS object creation)
 * - Trail rendering done entirely in GPU via TimeFilterExtension
 * - Per-vertex progress computed once and cached per tile
 * - Layer instances are cached and cloned to avoid recreation overhead
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import type { Tile, BinaryFeatures } from '@stt/core';

// Singleton TimeFilterExtension instance - reused across all layers
const TIME_FILTER_EXTENSION = new TimeFilterExtension();

// Cache for per-vertex progress arrays (keyed by BinaryFeatures instance)
const vertexProgressCache = new WeakMap<BinaryFeatures, Float32Array>();

// Cache for expanded per-vertex time arrays (legacy - used when no actual vertex timestamps)
const vertexTimesCache = new WeakMap<BinaryFeatures, {
  vertexStartTimes: Float32Array;
  vertexEndTimes: Float32Array;
}>();

// Cache for actual per-vertex timestamps (from data or computed via interpolation)
const actualVertexTimesCache = new WeakMap<BinaryFeatures, Float32Array>();

// Cache for color attributes (keyed by binary + property + palette hash)
const colorAttrCache = new WeakMap<BinaryFeatures, Map<string, Uint8Array>>();

/**
 * Cached layer info - stores the base layer and associated data
 */
interface CachedLayerInfo {
  layer: PathLayer;
  binary: BinaryFeatures;
  timeOffset: number;
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
 * Performance optimizations:
 * - Uses PathLayer with deck.gl binary data interface (zero accessor calls)
 * - TimeFilterExtension handles trail rendering entirely in GPU shaders
 * - Per-vertex progress computed once and cached per tile (not per frame)
 * - Layer caching prevents unnecessary buffer recreation
 */
export class AnimatedTripsLayer extends SpatioTemporalLayer<AnimatedTripsLayerProps> {
  static layerName = 'AnimatedTripsLayer';
  
  // Cache of layer instances keyed by tile+layer ID
  private layerCache: Map<string, CachedLayerInfo> = new Map();
  
  // Set of layer IDs that are currently visible
  private activeLayerIds: Set<string> = new Set();

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
    this.layerCache.clear();
    this.activeLayerIds.clear();
  }

  /**
   * Override to ensure time window is large enough for trail rendering.
   * For trail mode, the time window should be at least 2x the trail length
   * to ensure tiles containing trail data are loaded.
   * 
   * The time window is centered on currentTime, so we need:
   * timeWindow/2 >= trailLength
   */
  protected getEffectiveTimeWindow(): number {
    const baseWindow = this.props.timeWindow || 86400000;
    const trailLength = this.props.trailLength || 180000;
    
    // Ensure the backward look (timeWindow/2) covers the full trail
    // Need: baseWindow/2 >= trailLength, so baseWindow >= trailLength * 2
    const minWindowForTrail = trailLength * 2;
    
    return Math.max(baseWindow, minWindowForTrail);
  }

  renderLayers(): Layer[] {
    const { tiles, frameNumber } = this.state;
    
    if (!tiles || tiles.length === 0) {
      this.cleanupCache(new Set());
      return [];
    }

    const newActiveIds = new Set<string>();

    const layers = tiles.flatMap((tile: Tile) => {
      return tile.layers.map((layer, layerIndex) => {
        const binary = layer.features;
        
        if (binary.featureCount === 0 || !binary.startIndices) {
          return null;
        }
        
        const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${tile.id.t}-${layerIndex}`;
        newActiveIds.add(layerId);
        
        const tileTimeOffset = binary.timeOffset;
        
        return this.getOrCreateLayer(binary, layerId, tileTimeOffset, frameNumber || 0);
      });
    }).filter(Boolean) as Layer[];
    
    this.cleanupCache(newActiveIds);
    this.activeLayerIds = newActiveIds;

    return layers;
  }
  
  /**
   * Get a cached layer or create a new one.
   * PERFORMANCE: Uses getTime() getter so layers can be memoized.
   */
  private getOrCreateLayer(
    binary: BinaryFeatures,
    layerId: string,
    timeOffset: number,
    _frameNumber: number
  ): PathLayer {
    const cached = this.layerCache.get(layerId);
    
    // Return cached layer if binary hasn't changed
    // Time updates happen via getTime() getter in TimeFilterExtension.draw()
    if (cached && cached.binary === binary) {
      return cached.layer;
    }
    
    // Create new layer with getTime getter
    const layer = this.createBinaryPathLayer(binary, layerId, timeOffset);
    
    this.layerCache.set(layerId, {
      layer,
      binary,
      timeOffset,
    });
    
    return layer;
  }
  
  /**
   * Remove cached layers that are no longer active
   */
  private cleanupCache(activeIds: Set<string>): void {
    for (const id of this.layerCache.keys()) {
      if (!activeIds.has(id)) {
        this.layerCache.delete(id);
      }
    }
  }

  /**
   * Create a PathLayer using deck.gl's binary data interface with trail support.
   * PERFORMANCE: Uses getTime() getter for dynamic time updates.
   * 
   * SMOOTH ANIMATION: Uses actual per-vertex timestamps for GPU-based trail rendering.
   * This avoids the flashing issues caused by path segmentation.
   */
  private createBinaryPathLayer(
    binary: BinaryFeatures,
    layerId: string,
    timeOffset: number
  ): PathLayer {
    const dims = binary.positionDimensions ?? 2;
    const timeWindow = this.props.timeWindow || 86400000;
    
    // Capture self for getTime closure
    const self = this;
    
    // Get actual per-vertex timestamps (from data or computed via interpolation)
    // This is the key to smooth trail animation - each vertex has its own timestamp
    const actualVertexTimes = this.getActualVertexTimes(binary);
    
    // Build the binary data object for deck.gl
    // We use a SINGLE time attribute (instanceVertexTime) for simplicity and to avoid
    // hitting WebGL attribute limits
    const data: any = {
      length: binary.featureCount,
      startIndices: binary.startIndices,
      attributes: {
        // Path positions - the full interleaved array
        getPath: {
          value: binary.positions,
          size: dims,
        },
        // Per-vertex absolute timestamp for trail rendering
        // The shader uses this directly: show if (currentTime - trailLength) <= vertexTime <= currentTime
        instanceVertexTime: {
          value: actualVertexTimes,
          size: 1,
        },
      },
    };
    
    // Add width attribute if using a property
    const widthAttr = this.getWidthAttribute(binary);
    if (widthAttr) {
      data.attributes.getWidth = widthAttr;
    }
    
    // Add color attribute if using a property
    const colorAttr = this.getColorAttribute(binary);
    if (colorAttr) {
      data.attributes.getColor = colorAttr;
    }

    return new PathLayer({
      id: layerId,
      data,
      // Tell PathLayer this is pre-formatted path data
      _pathType: 'open',
      
      widthScale: this.props.widthScale,
      widthUnits: 'pixels',
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,
      capRounded: this.props.capRounded,
      jointRounded: this.props.jointRounded,
      
      // Time Filtering via extension with trail support
      // PERFORMANCE: Use getTime() getter for dynamic time updates (allows layer memoization)
      extensions: [TIME_FILTER_EXTENSION],
      getTime: () => self.getCurrentTime() - timeOffset,
      timeWindow,
      trailLength: this.props.trailLength,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      
      // Use constant values if not using property-based attributes
      ...(widthAttr ? {} : { getWidth: this.props.tripWidth as number }),
      ...(colorAttr ? {} : { getColor: this.props.tripColor as Color }),
      
      updateTriggers: {
        getColor: [this.props.tripColor, this.props.colorPalette],
        getWidth: [this.props.tripWidth],
      },
    });
  }
  
  /**
   * Get per-vertex timestamps from the pre-calculated data.
   * 
   * Per-vertex timestamps are computed during tile building (in Rust) and stored
   * in the tile data. This ensures consistent, accurate timestamps without any
   * frontend computation.
   * 
   * The timestamps are absolute (relative to timeOffset) and enable smooth
   * GPU-based trail animation.
   */
  private getActualVertexTimes(binary: BinaryFeatures): Float32Array {
    // Check cache first
    const cached = actualVertexTimesCache.get(binary);
    if (cached) {
      return cached;
    }
    
    const startIndices = binary.startIndices!;
    const totalVertices = startIndices[binary.featureCount];
    
    // Per-vertex timestamps are pre-calculated in the Rust tiler
    // They are stored as deltas from tile time_start, decoded to absolute times
    if (binary.vertexTimestamps && binary.vertexTimestamps.length === totalVertices) {
      // Cache the reference directly (no copy needed)
      actualVertexTimesCache.set(binary, binary.vertexTimestamps);
      return binary.vertexTimestamps;
    }
    
    // Fallback for older data without per-vertex timestamps
    // This should not happen with properly generated data
    console.warn('[AnimatedTripsLayer] Missing per-vertex timestamps - regenerate data with latest stt-build');
    const vertexTimes = new Float32Array(totalVertices);
    for (let i = 0; i < binary.featureCount; i++) {
      const vertexStart = startIndices[i];
      const vertexEnd = startIndices[i + 1];
      const featureStartTime = binary.startTimes[i];
      for (let j = vertexStart; j < vertexEnd; j++) {
        vertexTimes[j] = featureStartTime;
      }
    }
    actualVertexTimesCache.set(binary, vertexTimes);
    return vertexTimes;
  }
  
  /**
   * Get or compute per-vertex progress (0-1) for each vertex along its path.
   * Cached per BinaryFeatures instance to avoid recomputation.
   * @deprecated Use getActualVertexTimes instead for trail rendering
   */
  private getVertexProgress(binary: BinaryFeatures): Float32Array {
    // Check cache first
    let cached = vertexProgressCache.get(binary);
    if (cached) {
      return cached;
    }
    
    // Compute per-vertex progress
    const startIndices = binary.startIndices!;
    const totalVertices = startIndices[binary.featureCount];
    const progress = new Float32Array(totalVertices);
    
    for (let i = 0; i < binary.featureCount; i++) {
      const start = startIndices[i];
      const end = startIndices[i + 1];
      const numVertices = end - start;
      
      if (numVertices <= 1) {
        progress[start] = 0;
      } else {
        for (let j = 0; j < numVertices; j++) {
          progress[start + j] = j / (numVertices - 1);
        }
      }
    }
    
    // Cache for reuse
    vertexProgressCache.set(binary, progress);
    return progress;
  }
  
  /**
   * Expand per-feature start/end times to per-vertex arrays.
   * This is needed because PathLayer processes vertices, not instances.
   * Cached per BinaryFeatures instance to avoid recomputation.
   */
  private expandTimesToVertices(binary: BinaryFeatures): {
    vertexStartTimes: Float32Array;
    vertexEndTimes: Float32Array;
  } {
    // Check cache first
    const cached = vertexTimesCache.get(binary);
    if (cached) {
      return cached;
    }
    
    const startIndices = binary.startIndices!;
    const totalVertices = startIndices[binary.featureCount];
    
    const vertexStartTimes = new Float32Array(totalVertices);
    const vertexEndTimes = new Float32Array(totalVertices);
    
    for (let i = 0; i < binary.featureCount; i++) {
      const start = startIndices[i];
      const end = startIndices[i + 1];
      const featureStart = binary.startTimes[i];
      const featureEnd = binary.endTimes[i];
      
      for (let j = start; j < end; j++) {
        vertexStartTimes[j] = featureStart;
        vertexEndTimes[j] = featureEnd;
      }
    }
    
    const result = { vertexStartTimes, vertexEndTimes };
    vertexTimesCache.set(binary, result);
    return result;
  }
  
  /**
   * Get width attribute from numeric property if specified
   */
  private getWidthAttribute(binary: BinaryFeatures): { value: Float32Array; size: number } | null {
    const width = this.props.tripWidth;
    
    if (typeof width === 'string') {
      const values = binary.numericProps[width];
      if (values) {
        return { value: values, size: 1 };
      }
    }
    
    return null;
  }
  
  /**
   * Get color attribute from categorical property if specified.
   * Cached per BinaryFeatures + property + palette combination.
   */
  private getColorAttribute(binary: BinaryFeatures): { value: Uint8Array; size: 4; normalized: boolean } | null {
    const color = this.props.tripColor;
    
    if (typeof color === 'string') {
      const prop = binary.categoricalProps[color];
      if (prop) {
        const palette = this.props.colorPalette || DEFAULT_PALETTE;
        
        // Check cache
        let binaryCache = colorAttrCache.get(binary);
        if (!binaryCache) {
          binaryCache = new Map();
          colorAttrCache.set(binary, binaryCache);
        }
        
        // Create cache key from property name and palette
        const paletteKey = palette.map(c => c.join(',')).join('|');
        const cacheKey = `${color}:${paletteKey}`;
        
        let colors = binaryCache.get(cacheKey);
        if (!colors) {
          colors = new Uint8Array(binary.featureCount * 4);
          
          for (let i = 0; i < binary.featureCount; i++) {
            const categoryIndex = prop.indices[i];
            const c = palette[categoryIndex % palette.length];
            colors[i * 4] = c[0];
            colors[i * 4 + 1] = c[1];
            colors[i * 4 + 2] = c[2];
            colors[i * 4 + 3] = c[3] ?? 255;
          }
          
          binaryCache.set(cacheKey, colors);
        }
        
        return { value: colors, size: 4, normalized: true };
      }
    }
    
    return null;
  }
}
