/**
 * AnimatedPolygonLayer - GPU-efficient polygon rendering with time filtering
 * 
 * Uses deck.gl's binary data interface for maximum performance:
 * - Passes typed arrays directly to GPU where possible
 * - Time filtering done in JavaScript (SolidPolygonLayer doesn't support TimeFilterExtension)
 * - Uses startIndices for variable-length polygon geometries
 * 
 * PERFORMANCE OPTIMIZED:
 * - Caches extracted geometry per tile/visible set combination
 * - Reuses arrays between frames when visible set unchanged
 * - Color attributes cached per tile
 * - Layer instances are cached and reused when possible
 */

import { SolidPolygonLayer } from '@deck.gl/layers';
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { BinaryFeatures } from '@stt/core';

// Debug flag - enable to see tile/feature info
const DEBUG = false;

// Cache for extracted polygon geometry per tile (keyed by binary + visible indices hash)
interface CachedPolygonGeometry {
  positions: Float64Array;
  startIndices: Uint32Array;
  visibleCount: number;
  indicesHash: string;
}

const geometryCache = new WeakMap<BinaryFeatures, CachedPolygonGeometry>();

// Cache for color attributes per tile
const colorCache = new WeakMap<BinaryFeatures, Map<string, Uint8Array>>();

/**
 * Cached layer info - stores the layer and its geometry hash.
 *
 * `opacity`/`visible` are tracked so we can return the cached `layer`
 * reference unchanged when nothing the consumer cares about has changed —
 * deck.gl reuses the same GPU state and skips updateState() for matched
 * sublayers, but only when we hand back the SAME Layer instance. The
 * previous `.clone({opacity, visible})` allocated a fresh layer per render
 * even when both values were equal to the cached layer's props.
 */
interface CachedLayerInfo {
  layer: SolidPolygonLayer;
  indicesHash: string;
  opacity: number | undefined;
  visible: boolean | undefined;
}

export interface AnimatedPolygonLayerProps extends SpatioTemporalLayerProps {
  /** Whether to draw an outline around each polygon */
  stroked?: boolean;
  
  /** Whether to fill the polygon */
  filled?: boolean;
  
  /** Line width in pixels (if stroked) */
  lineWidthUnits?: 'pixels' | 'meters' | 'common';
  
  /** Line width */
  lineWidth?: number | string;
  
  /** Line color - constant value or property name */
  lineColor?: Color | string;
  
  /** Fill color - constant value or property name */
  fillColor?: Color | string;
  
  /** Color palette for categorical properties */
  colorPalette?: Color[];
  
  /** Elevation - constant value or property name (for extruded polygons) */
  elevation?: number | string;
  
  /** Whether polygons are extruded */
  extruded?: boolean;
  
  /** Fade-in duration for appearing polygons (ms) */
  fadeInDuration?: number;
  
  /** Fade-out duration for disappearing polygons (ms) */
  fadeOutDuration?: number;
}

// Default color palette for categorical data
const DEFAULT_PALETTE: Color[] = [
  [255, 140, 0, 180],
  [31, 119, 180, 180],
  [44, 160, 44, 180],
  [214, 39, 40, 180],
  [148, 103, 189, 180],
  [140, 86, 75, 180],
  [227, 119, 194, 180],
  [127, 127, 127, 180],
  [188, 189, 34, 180],
  [23, 190, 207, 180],
];

/**
 * Animated polygon layer using deck.gl binary interface
 * 
 * Performance optimizations:
 * - Caches extracted geometry per tile when visible set is stable
 * - Reuses typed arrays between frames
 * - Color attributes cached per tile+palette combination
 * - Layer instances cached and reused when visible set unchanged
 */
export class AnimatedPolygonLayer extends SpatioTemporalLayer<AnimatedPolygonLayerProps> {
  static layerName = 'AnimatedPolygonLayer';
  
  // Cache of layer instances keyed by tile+layer ID
  private layerCache: Map<string, CachedLayerInfo> = new Map();
  
  // Set of layer IDs that are currently visible
  private activeLayerIds: Set<string> = new Set();

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // Polygon appearance
    stroked: false, // Stroked requires separate PathLayer, disabled for performance
    filled: true,
    lineWidthUnits: 'pixels' as const,
    lineWidth: { type: 'number', value: 1 },
    lineColor: { type: 'color', value: [0, 0, 0, 255] as Color },
    fillColor: { type: 'color', value: [255, 140, 0, 180] as Color },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    elevation: { type: 'number', value: 0 },
    extruded: false,
    
    // Animation props
    fadeInDuration: { type: 'number', value: 500, min: 0 },
    fadeOutDuration: { type: 'number', value: 500, min: 0 },
  };
  
  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.layerCache.clear();
    this.activeLayerIds.clear();
  }

  /**
   * KNOWN LIMITATION (tile-seam overdraw): this layer creates ONE
   * SolidPolygonLayer per tile/layer rather than consolidating all tiles into
   * a single layer (as the point/path/trips layers do). Polygons that span a
   * tile boundary are split across tiles, so along seams the two halves are
   * drawn by separate layers. With opacity < 1 this causes visible double-
   * blending at seams, and for extruded polygons it can z-fight.
   *
   * Consolidating into a single SolidPolygonLayer (like the other layers)
   * would fix this; it is deferred because polygons have variable ring counts
   * and SolidPolygonLayer binary input needs careful startIndices handling.
   * For now, prefer fully-opaque fills to avoid the seam artifact.
   */
  renderLayers(): Layer[] {
    const { tiles } = this.state;
    // Use getCurrentTime() for up-to-date time without setState overhead
    const currentTime = this.getCurrentTime();
    
    if (DEBUG) {
      console.log('[AnimatedPolygonLayer] renderLayers called, tiles:', tiles?.length || 0);
    }
    
    if (!tiles || tiles.length === 0) {
      this.cleanupCache(new Set());
      return [];
    }

    const timeWindow = this.props.timeWindow || 86400000 * 30; // Default 30 days
    const halfWindow = timeWindow / 2;
    const timeStart = currentTime - halfWindow;
    const timeEnd = currentTime + halfWindow;

    const layers: Layer[] = [];
    const newActiveIds = new Set<string>();
    
    for (const tile of tiles) {
      for (let layerIndex = 0; layerIndex < tile.layers.length; layerIndex++) {
        const tileLayer = tile.layers[layerIndex];
        const binary = tileLayer.features;
        
        if (binary.featureCount === 0 || !binary.startIndices) {
          continue;
        }

        // Get visible feature indices and check if they changed
        const { visibleIndices, indicesHash } = this.getVisibleFeatureIndices(binary, timeStart, timeEnd);
        
        if (DEBUG) {
          console.log('[AnimatedPolygonLayer] Visible features:', visibleIndices.length, 'of', binary.featureCount);
        }

        if (visibleIndices.length === 0) {
          continue;
        }

        const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${tile.id.t}-${layerIndex}`;
        newActiveIds.add(layerId);
        
        const layer = this.getOrCreateLayer(binary, visibleIndices, indicesHash, layerId);
        
        if (layer) {
          layers.push(layer);
        }
      }
    }
    
    this.cleanupCache(newActiveIds);
    this.activeLayerIds = newActiveIds;

    return layers;
  }
  
  /**
   * Get a cached layer or create a new one.
   */
  private getOrCreateLayer(
    binary: BinaryFeatures,
    visibleIndices: number[],
    indicesHash: string,
    layerId: string
  ): SolidPolygonLayer | null {
    const cached = this.layerCache.get(layerId);
    const opacity = this.props.opacity;
    const visible = this.props.visible;

    if (cached && cached.indicesHash === indicesHash) {
      // Same visible set: if opacity/visible also match the cached layer's
      // baked values, return the exact same instance. deck.gl's layer
      // matcher will short-circuit prop diff entirely. Only clone when one
      // of the cheap props actually changed.
      if (cached.opacity === opacity && cached.visible === visible) {
        return cached.layer;
      }
      const cloned = cached.layer.clone({ opacity, visible } as any);
      cached.layer = cloned;
      cached.opacity = opacity;
      cached.visible = visible;
      return cloned;
    }

    // Visible set changed or new layer - create new
    const layer = this.createBinaryPolygonLayer(binary, visibleIndices, indicesHash, layerId);

    if (layer) {
      this.layerCache.set(layerId, {
        layer,
        indicesHash,
        opacity,
        visible,
      });
    }

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
   * Get indices of features visible in the current time window.
   * Returns both the indices and a hash for cache invalidation.
   */
  private getVisibleFeatureIndices(
    binary: BinaryFeatures,
    timeStart: number,
    timeEnd: number
  ): { visibleIndices: number[]; indicesHash: string } {
    const visible: number[] = [];
    const timeOffset = binary.timeOffset;

    // NOTE: time filtering here is CPU-side in JS doubles (full precision).
    // featureStart/featureEnd are plain numbers, never stored in a
    // Float32Array, so the absolute epoch-ms values do not lose precision.
    for (let i = 0; i < binary.featureCount; i++) {
      const featureStart = timeOffset + binary.startTimes[i];
      const featureEnd = timeOffset + binary.endTimes[i];
      
      // Feature is visible if its time range overlaps with the current window
      if (featureEnd >= timeStart && featureStart <= timeEnd) {
        visible.push(i);
      }
    }
    
    // Create a hash of visible indices for cache key
    // For performance, just use first/last/count as approximate hash
    const indicesHash = visible.length > 0 
      ? `${visible.length}:${visible[0]}:${visible[visible.length - 1]}`
      : 'empty';
    
    return { visibleIndices: visible, indicesHash };
  }

  /**
   * Create a SolidPolygonLayer for visible features using binary data.
   * Uses cached geometry when the visible set hasn't changed.
   */
  private createBinaryPolygonLayer(
    binary: BinaryFeatures,
    visibleIndices: number[],
    indicesHash: string,
    layerId: string
  ): SolidPolygonLayer | null {
    const dims = binary.positionDimensions ?? 2;
    
    // Check if we have cached geometry for this visible set
    let cached = geometryCache.get(binary);
    if (!cached || cached.indicesHash !== indicesHash) {
      // Need to recompute geometry
      const { positions, startIndices } = this.extractVisiblePolygons(binary, visibleIndices, dims);
      
      if (positions.length === 0) {
        return null;
      }
      
      cached = {
        positions,
        startIndices,
        visibleCount: visibleIndices.length,
        indicesHash
      };
      geometryCache.set(binary, cached);
    }
    
    if (cached.positions.length === 0) {
      return null;
    }

    // Build the binary data object for deck.gl
    const data: any = {
      length: cached.visibleCount,
      startIndices: cached.startIndices,
      attributes: {
        getPolygon: {
          value: cached.positions,
          size: dims,
        },
      },
    };
    
    // Add fill color attribute (cached)
    const fillColorAttr = this.getFillColorAttribute(binary, visibleIndices, indicesHash);
    if (fillColorAttr) {
      data.attributes.getFillColor = fillColorAttr;
    }

    return new SolidPolygonLayer({
      id: layerId,
      data,
      // Tell deck.gl we're providing pre-formatted polygon data
      _normalize: false,
      // Counter-clockwise winding
      _windingOrder: 'CCW',
      
      filled: this.props.filled,
      extruded: this.props.extruded,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,
      
      // Use constant fill color if not using property-based
      ...(fillColorAttr ? {} : { getFillColor: this.props.fillColor as Color }),
      
      // Elevation
      ...(this.props.extruded ? { getElevation: this.props.elevation as number } : {}),
      
      updateTriggers: {
        getFillColor: [this.props.fillColor, this.props.colorPalette, indicesHash],
      },
    });
  }
  
  /**
   * Extract positions for visible polygons only
   */
  private extractVisiblePolygons(
    binary: BinaryFeatures,
    visibleIndices: number[],
    dims: number
  ): { positions: Float64Array; startIndices: Uint32Array } {
    // Calculate total positions needed
    let totalPositions = 0;
    for (const idx of visibleIndices) {
      const start = binary.startIndices![idx];
      const end = binary.startIndices![idx + 1];
      totalPositions += end - start;
    }
    
    const positions = new Float64Array(totalPositions * dims);
    const startIndices = new Uint32Array(visibleIndices.length + 1);
    
    let posIdx = 0;
    for (let i = 0; i < visibleIndices.length; i++) {
      const featureIdx = visibleIndices[i];
      const srcStart = binary.startIndices![featureIdx] * dims;
      const srcEnd = binary.startIndices![featureIdx + 1] * dims;
      
      startIndices[i] = posIdx / dims;
      
      // Copy positions
      for (let j = srcStart; j < srcEnd; j++) {
        positions[posIdx++] = binary.positions[j];
      }
    }
    startIndices[visibleIndices.length] = posIdx / dims;
    
    return { positions, startIndices };
  }
  
  /**
   * Get fill color attribute for visible features.
   * Cached per tile + property + palette + visible set combination.
   */
  private getFillColorAttribute(
    binary: BinaryFeatures, 
    visibleIndices: number[],
    indicesHash: string
  ): { value: Uint8Array; size: 4; normalized: boolean } | null {
    const fillColor = this.props.fillColor;
    
    if (typeof fillColor === 'string') {
      const prop = binary.categoricalProps[fillColor];
      if (prop) {
        const palette = this.props.colorPalette || DEFAULT_PALETTE;
        
        // Check cache
        let binaryColorCache = colorCache.get(binary);
        if (!binaryColorCache) {
          binaryColorCache = new Map();
          colorCache.set(binary, binaryColorCache);
        }
        
        // Cache key includes visible indices hash
        const paletteKey = palette.map(c => c.join(',')).join('|');
        const cacheKey = `${fillColor}:${paletteKey}:${indicesHash}`;
        
        let colors = binaryColorCache.get(cacheKey);
        if (!colors) {
          colors = new Uint8Array(visibleIndices.length * 4);
          
          for (let i = 0; i < visibleIndices.length; i++) {
            const featureIdx = visibleIndices[i];
            const categoryIndex = prop.indices[featureIdx];
            const c = palette[categoryIndex % palette.length];
            colors[i * 4] = c[0];
            colors[i * 4 + 1] = c[1];
            colors[i * 4 + 2] = c[2];
            colors[i * 4 + 3] = c[3] ?? 255;
          }
          
          binaryColorCache.set(cacheKey, colors);
        }
        
        return { value: colors, size: 4, normalized: true };
      }
    }
    
    return null;
  }
}
