/**
 * Refactored SpatioTemporalLayer using Tileset pattern
 * 
 * Based on deck.gl TileLayer architecture with loaders.gl integration
 */

import { CompositeLayer } from '@deck.gl/core';
import type { CompositeLayerProps, UpdateParameters, LayerContext } from '@deck.gl/core';
import { STTArchive } from '@stt/core';
import { SpatiotemporalTileset } from '@stt/core';
import type { Tile, BoundingBox, ArchiveMetadata } from '@stt/core';
import { TimeController } from './time-controller';

const DEBUG = false;

export interface SpatioTemporalLayerProps extends CompositeLayerProps {
  /** URL to STT archive */
  data: string;
  
  /** Current time to display (Unix milliseconds) */
  currentTime: number;
  
  /** Time window (milliseconds before and after currentTime) */
  timeWindow?: number;

  /** Full time range of the dataset */
  timeRange?: { start: number; end: number };
  
  /** Time controller (optional, for synchronized animation) */
  timeController?: TimeController;
  
  /** Maximum concurrent tile requests (deck.gl TileLayer pattern) */
  maxRequests?: number;
  
  /** Debounce time for viewport changes in ms (deck.gl TileLayer pattern) */
  debounceTime?: number;
  
  /** Maximum number of tiles to cache */
  maxCacheSize?: number;
  
  /** Maximum cache size in bytes */
  maxCacheByteSize?: number;
  
  /** Enable predictive prefetching for smooth animation */
  enablePrefetch?: boolean;
  
  /** How far ahead to prefetch in animation time (milliseconds) */
  prefetchAhead?: number;
  
  /** Number of time steps to prefetch ahead */
  prefetchSteps?: number;
  
  /** Callback when all tiles in viewport are loaded */
  onViewportLoad?: (tiles: Tile[]) => void;
  
  /** Callback when a tile loads */
  onTileLoad?: (tile: Tile) => void;
  
  /** Callback when a tile is evicted from cache */
  onTileUnload?: (tile: Tile) => void;

  /** Loaders.gl options */
  loadOptions?: Record<string, unknown>;
}

interface SpatioTemporalLayerState {
  archive: STTArchive | null;
  tileset: SpatiotemporalTileset | null;
  metadata: ArchiveMetadata | null;
  tiles: Tile[];
  currentTime: number;
  isLoaded: boolean;
  frameNumber?: number;
  playStateHandler?: (playing: boolean, speed: number) => void;
}

/**
 * Base layer for spatiotemporal tile visualization
 * 
 * Architecture based on deck.gl TileLayer + loaders.gl:
 * - Separates tile management (Tileset) from data loading (Archive)
 * - Request concurrency control (maxRequests: 6)
 * - Debouncing for smooth viewport changes
 * - LRU cache with size limits
 * - Frame-based rendering optimization
 */
export class SpatioTemporalLayer<
  Props extends SpatioTemporalLayerProps = SpatioTemporalLayerProps
> extends CompositeLayer<Props> {
  static layerName = 'SpatioTemporalLayer';

  static defaultProps = {
    // Data source
    data: { type: 'string', value: '', compare: true },
    
    // Temporal properties
    currentTime: { type: 'number', value: Date.now(), compare: true },
    timeWindow: { type: 'number', value: 86400000, compare: false }, // 1 day default
    timeRange: { type: 'object', value: null, compare: true },
    timeController: { type: 'object', value: null, compare: false },
    
    // Tile loading configuration (following deck.gl TileLayer pattern)
    maxRequests: { type: 'number', value: 12, compare: false }, // Higher for animation
    debounceTime: { type: 'number', value: 0, compare: false }, // No debounce for time changes
    maxCacheSize: { type: 'number', value: 200, compare: false },
    maxCacheByteSize: { type: 'number', value: 500 * 1024 * 1024, compare: false }, // 500MB
    
    // Prefetch configuration for smooth animation
    enablePrefetch: { type: 'boolean', value: true, compare: false },
    prefetchAhead: { type: 'number', value: 10000, compare: false }, // 10 seconds ahead
    prefetchSteps: { type: 'number', value: 3, compare: false },
    
    // Callbacks
    onViewportLoad: { type: 'function', value: null, optional: true },
    onTileLoad: { type: 'function', value: null, optional: true },
    onTileUnload: { type: 'function', value: null, optional: true },
    
    // Loaders options
    loadOptions: { type: 'object', value: {}, compare: false },
  };

  declare state: SpatioTemporalLayerState & { [key: string]: unknown };

  initializeState(_context: LayerContext): void {
    // Create handler for play state changes
    const playStateHandler = (playing: boolean, speed: number) => {
      const { tileset } = this.state;
      if (tileset) {
        tileset.setAnimationState(playing, speed);
      }
    };
    
    this.setState({
      archive: null,
      tileset: null,
      metadata: null,
      tiles: [],
      currentTime: this.props.currentTime,
      isLoaded: false,
      playStateHandler,
    });

    // Subscribe to time controller play state if provided
    if (this.props.timeController) {
      this.props.timeController.on('playState', playStateHandler);
    }

    // Initialize archive and tileset
    this._initArchiveAndTileset();
  }

  finalizeState(_context: LayerContext): void {
    // Unsubscribe from time controller
    if (this.props.timeController && this.state.playStateHandler) {
      this.props.timeController.off('playState', this.state.playStateHandler);
    }
    
    // Cleanup tileset resources
    const { tileset } = this.state;
    if (tileset) {
      tileset.finalize();
    }
  }

  /**
   * deck.gl layer lifecycle: decide if layer needs to update
   * Following deck.gl TileLayer pattern - return true for any change including viewport
   */
  shouldUpdateState(params: { changeFlags: any }): boolean {
    return params.changeFlags.somethingChanged;
  }

  updateState(params: UpdateParameters<this>): void {
    const { changeFlags, oldProps } = params;
    const propsChanged = changeFlags.propsChanged;
    const dataChanged = propsChanged && this.props.data !== this.state.archive?.url;
    
    // Handle TimeController changes
    if (oldProps?.timeController !== this.props.timeController && this.state.playStateHandler) {
      // Unsubscribe from old controller
      if (oldProps?.timeController) {
        oldProps.timeController.off('playState', this.state.playStateHandler);
      }
      // Subscribe to new controller
      if (this.props.timeController) {
        this.props.timeController.on('playState', this.state.playStateHandler);
        // Sync current animation state
        const { tileset } = this.state;
        if (tileset) {
          tileset.setAnimationState(
            this.props.timeController.isPlaying(),
            this.props.timeController.getSpeed()
          );
        }
      }
    }
    
    if (dataChanged) {
      // Reinitialize with new data source
      this._initArchiveAndTileset();
      return;
    }
    
    // Following deck.gl TileLayer pattern:
    // Always update tileset on any change (viewport, props, etc)
    // The tileset itself will detect what changed and update accordingly
    this._updateTileset(changeFlags);
  }

  private _updateTileset(changeFlags: any): void {
    const { tileset } = this.state;
    if (!tileset) return;
    
    // Check if it's a time-only change for debouncing logic
    const timeChanged = changeFlags.propsChanged && this.props.currentTime !== this.state.currentTime;
    const skipDebounce = timeChanged && !changeFlags.propsOrDataChanged;
    
    // Get viewport bounds and zoom
    const viewport = this.context.viewport;
    if (!viewport) {
      if (DEBUG) console.log('[STL] No viewport available');
      return;
    }
    
    const bounds = this.getViewportBounds(viewport);
    const zoom = this.getZoomLevel(viewport);
    const timeWindow = this.props.timeWindow || 86400000;
    
    // Update tileset - this returns a new frameNumber if tiles changed
    const frameNumber = tileset.update({
      bounds,
      zoom,
      time: this.props.currentTime,
      timeWindow,
    }, skipDebounce);
    
    // Get visible tiles (optimistic rendering - show what we have)
    const tiles = tileset.getVisibleTiles();
    
    // Check if state changed
    const frameChanged = this.state.frameNumber !== frameNumber;
    const timeStateChanged = this.props.currentTime !== this.state.currentTime;
    
    if (frameChanged || timeStateChanged) {
      // Trigger re-render by updating state
      this.setState({
        tiles,
        frameNumber,
        currentTime: this.props.currentTime,
      });
    }
    
    // Track loading state (doesn't trigger re-render)
    this.state.isLoaded = tiles.length > 0;
    
    if (DEBUG) {
      const stats = tileset.getCacheStats();
      console.log('[STL] Tileset updated - frame:', frameNumber, 'tiles:', tiles.length, 'stats:', stats);
    }
  }

  private async _initArchiveAndTileset(): Promise<void> {
    if (DEBUG) console.log('[STL] Initializing archive from', this.props.data);
    
    const archive = new STTArchive({
        url: this.props.data,
        loadOptions: this.props.loadOptions
    });
    
    // Get metadata to configure tileset zoom range
    const metadata = await archive.getMetadata();
    
    // Create tileset with archive as data source
    const tileset = new SpatiotemporalTileset({
      maxRequests: this.props.maxRequests!,
      debounceTime: this.props.debounceTime!,
      maxCacheSize: this.props.maxCacheSize!,
      maxCacheByteSize: this.props.maxCacheByteSize!,
      minZoom: metadata.minZoom,
      maxZoom: metadata.maxZoom,
      refinementStrategy: 'best-available', // Load parent tiles as fallback (deck.gl pattern)
      // Prefetch configuration for smooth animation playback
      enablePrefetch: this.props.enablePrefetch!,
      prefetchAhead: this.props.prefetchAhead!,
      prefetchSteps: this.props.prefetchSteps!,
      getAvailableTiles: (bounds, zoom, timeRange) => 
        archive.getTileIdsInBounds(bounds, zoom, timeRange),
      getTileData: (tileId) => archive.getTile(tileId),
      onTileLoad: (tile) => {
        if (DEBUG) console.log('[STL] Tile loaded:', tile.id);
        this.props.onTileLoad?.(tile);
        // Trigger re-render when new tiles load
        this.setNeedsUpdate();
      },
      onTileUnload: (tile) => {
        if (DEBUG) console.log('[STL] Tile unloaded:', tile.id);
        this.props.onTileUnload?.(tile);
      },
      onTileError: (error, tileId) => {
        console.error('[STL] Tile error:', tileId, error);
      },
    });
    
    if (DEBUG) console.log('[STL] Tileset configured with zoom range:', metadata.minZoom, '-', metadata.maxZoom);
    
    // If time controller is playing, set initial animation state
    if (this.props.timeController?.isPlaying()) {
      tileset.setAnimationState(true, this.props.timeController.getSpeed());
    }
    
    this.setState({ archive, tileset, metadata });
  }

  private getViewportBounds(viewport: any): BoundingBox {
    const [minLon, minLat] = viewport.unproject([0, viewport.height]);
    const [maxLon, maxLat] = viewport.unproject([viewport.width, 0]);

    return {
      minLon: Math.max(-180, minLon),
      minLat: Math.max(-90, minLat),
      maxLon: Math.min(180, maxLon),
      maxLat: Math.min(90, maxLat),
    };
  }

  private getZoomLevel(viewport: any): number {
    // Convert deck.gl zoom to tile zoom
    // Clamp to available zoom range from archive metadata
    const zoom = Math.floor(viewport.zoom);
    const { archive, metadata } = this.state;
    
    if (archive && metadata) {
      // Use metadata from state
      const minZoom = metadata.minZoom;
      const maxZoom = metadata.maxZoom;
      return Math.max(minZoom, Math.min(maxZoom, zoom));
    }
    
    return zoom;
  }

  /**
   * Check if layer is fully loaded
   */
  get isLoaded(): boolean {
    return this.state.isLoaded;
  }

  /**
   * Subclasses override this to render actual visualization layers
   */
  renderLayers(): any[] {
    return [];
  }
}




