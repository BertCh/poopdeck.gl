/**
 * SpatioTemporalTileLayer - deck.gl TileLayer pattern for 4D (x, y, z, t) tiles
 * 
 * Extends @deck.gl/geo-layers TileLayer with temporal dimension support.
 * Uses the standard TileLayer patterns for viewport culling, request management,
 * and cache eviction while adding time-based filtering.
 */

import { TileLayer } from '@deck.gl/geo-layers';
import type { TileLayerProps } from '@deck.gl/geo-layers';
import type { 
  Layer, 
  LayersList, 
  UpdateParameters,
  DefaultProps
} from '@deck.gl/core';

// Import internal types with underscore prefix as they're exported that way
import type { 
  _Tile2DHeader as Tile2DHeader,
  _TileLoadProps as TileLoadProps
} from '@deck.gl/geo-layers';

import { STTArchive } from '@stt/core';
import type { Tile, BoundingBox, ArchiveMetadata } from '@stt/core';
import { TimeController } from './time-controller';

const DEBUG = false;

/**
 * Extended tile data including temporal information
 */
export interface SpatioTemporalTileData {
  /** The decoded tile data (binary format) */
  tile: Tile;
  /** Tile temporal bounds */
  timeRange: { start: number; end: number };
}

export interface SpatioTemporalTileLayerProps extends Omit<TileLayerProps<SpatioTemporalTileData>, 'data' | 'getTileData'> {
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
  
  /** Callback when archive metadata is loaded */
  onMetadataLoad?: (metadata: ArchiveMetadata) => void;
}

interface SpatioTemporalTileLayerState {
  archive: STTArchive | null;
  metadata: ArchiveMetadata | null;
  currentTime: number;
  visibleTiles: Tile2DHeader<SpatioTemporalTileData>[];
  [key: string]: unknown; // Index signature for state compatibility
}

const defaultProps: DefaultProps<SpatioTemporalTileLayerProps> = {
  // Inherit TileLayer defaults and override
  data: { type: 'data', value: '' },
  currentTime: { type: 'number', value: Date.now() },
  timeWindow: { type: 'number', value: 86400000 }, // 1 day default
  
  // TileLayer defaults optimized for STT
  maxRequests: 24,
  debounceTime: 0, // No debounce for time changes
  maxCacheSize: 200,
  maxCacheByteSize: 500 * 1024 * 1024, // 500MB
  refinementStrategy: 'best-available',
};

/**
 * SpatioTemporalTileLayer
 * 
 * A deck.gl layer that extends TileLayer for 4D (x, y, z, t) tile loading.
 * 
 * Features:
 * - Inherits TileLayer's viewport culling and request management
 * - Adds temporal filtering for time-based data
 * - Supports both object and binary tile formats
 * - Integrates with STTArchive for efficient data loading
 * 
 * @example
 * ```typescript
 * new SpatioTemporalTileLayer({
 *   id: 'stt-layer',
 *   data: 'https://example.com/data.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 86400000, // 1 day
 *   renderSubLayers: (props) => new ScatterplotLayer(props)
 * });
 * ```
 */
export class SpatioTemporalTileLayer<
  ExtraPropsT extends {} = {}
> extends TileLayer<SpatioTemporalTileData, SpatioTemporalTileLayerProps & ExtraPropsT> {
  static layerName = 'SpatioTemporalTileLayer';
  static defaultProps = defaultProps;

  declare state: TileLayer<SpatioTemporalTileData>['state'] & SpatioTemporalTileLayerState;

  initializeState(): void {
    super.initializeState();
    
    this.setState({
      archive: null,
      metadata: null,
      currentTime: this.props.currentTime,
      visibleTiles: [],
    });

    // Initialize archive
    this._initArchive();
  }

  shouldUpdateState(params: { changeFlags: { somethingChanged: boolean } }): boolean {
    // Always update on time changes for smooth animation
    if (this.props.currentTime !== this.state.currentTime) {
      return true;
    }
    return super.shouldUpdateState(params);
  }

  updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    
    // Check if archive URL changed
    if (props.data !== oldProps?.data) {
      this._initArchive();
    }
    
    // Track current time for change detection
    if (props.currentTime !== this.state.currentTime) {
      this.setState({ currentTime: props.currentTime });
    }

    super.updateState(params);
    
    // After tileset update, filter tiles by time
    this._filterTilesByTime();
  }

  /**
   * Initialize the STT archive
   */
  private async _initArchive(): Promise<void> {
    const url = this.props.data;
    if (!url) return;

    if (DEBUG) console.log('[STTLayer] Initializing archive:', url);

    const archive = new STTArchive({ url });
    
    try {
      const metadata = await archive.getMetadata();
      
      if (DEBUG) {
        console.log('[STTLayer] Archive metadata:', {
          minZoom: metadata.minZoom,
          maxZoom: metadata.maxZoom,
          timeRange: metadata.timeRange,
        });
      }

      this.setState({ archive, metadata });
      
      // Notify parent of metadata
      this.props.onMetadataLoad?.(metadata);
    } catch (error) {
      console.error('[STTLayer] Failed to load archive:', error);
    }
  }

  /**
   * Override getTileData to load from STT archive
   */
  getTileData(loadProps: TileLoadProps): Promise<SpatioTemporalTileData> | SpatioTemporalTileData | null {
    const { archive, metadata } = this.state;
    if (!archive || !metadata) {
      return null;
    }

    const { index, signal } = loadProps;
    const { x, y, z } = index;
    
    // Get temporal range from current view
    const timeWindow = this.props.timeWindow || 86400000;
    const currentTime = this.props.currentTime;
    const timeStart = currentTime - timeWindow / 2;
    const timeEnd = currentTime + timeWindow / 2;

    // Load tile with temporal context
    return this._loadTileWithTime(x, y, z, timeStart, timeEnd, signal);
  }

  /**
   * Load a tile from the archive with temporal bounds
   */
  private async _loadTileWithTime(
    x: number,
    y: number,
    z: number,
    timeStart: number,
    timeEnd: number,
    signal?: AbortSignal
  ): Promise<SpatioTemporalTileData> {
    const { archive } = this.state;
    if (!archive) {
      // Return empty tile data if no archive
      return {
        tile: { id: { z, x, y, t: 0 }, timeRange: { start: 0, end: 0 }, layers: [] },
        timeRange: { start: 0, end: 0 },
      };
    }

    try {
      // Get tile IDs that overlap with our spatial and temporal bounds
      const bounds = this._tileIndexToBounds(x, y, z);
      const tileIds = await archive.getTileIdsInBounds(bounds, z, {
        start: timeStart,
        end: timeEnd,
      });

      if (tileIds.length === 0) {
        // Return empty tile data
        return {
          tile: { id: { z, x, y, t: 0 }, timeRange: { start: 0, end: 0 }, layers: [] },
          timeRange: { start: 0, end: 0 },
        };
      }

      // For now, load the first matching tile
      // TODO: Support multiple temporal tiles per spatial tile
      const tileId = tileIds[0];
      const tile = await archive.getTile(tileId, { signal });

      if (!tile) {
        return {
          tile: { id: { z, x, y, t: 0 }, timeRange: { start: 0, end: 0 }, layers: [] },
          timeRange: { start: 0, end: 0 },
        };
      }

      return {
        tile,
        timeRange: tile.timeRange,
      };
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('[STTLayer] Failed to load tile:', error);
      }
      // Return empty tile data on error
      return {
        tile: { id: { z, x, y, t: 0 }, timeRange: { start: 0, end: 0 }, layers: [] },
        timeRange: { start: 0, end: 0 },
      };
    }
  }

  /**
   * Convert tile index to geographic bounds
   */
  private _tileIndexToBounds(x: number, y: number, z: number): BoundingBox {
    const n = Math.pow(2, z);
    const minLon = (x / n) * 360 - 180;
    const maxLon = ((x + 1) / n) * 360 - 180;
    
    const minLatRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
    const maxLatRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    
    const minLat = (minLatRad * 180) / Math.PI;
    const maxLat = (maxLatRad * 180) / Math.PI;

    return { minLon, minLat, maxLon, maxLat };
  }

  /**
   * Filter visible tiles by current time
   */
  private _filterTilesByTime(): void {
    const tileset = this.state.tileset;
    if (!tileset) return;

    const currentTime = this.props.currentTime;
    const timeWindow = this.props.timeWindow || 86400000;
    const timeStart = currentTime - timeWindow / 2;
    const timeEnd = currentTime + timeWindow / 2;

    // Filter tiles that overlap with current time window
    const visibleTiles = tileset.tiles.filter((tile: Tile2DHeader<SpatioTemporalTileData>) => {
      if (!tile.content) return false;
      
      const { timeRange } = tile.content;
      return timeRange.end >= timeStart && timeRange.start <= timeEnd;
    });

    this.setState({ visibleTiles });
  }

  /**
   * Override renderLayers to only render time-visible tiles
   */
  renderLayers(): Layer | null | LayersList {
    const tileset = this.state.tileset;
    if (!tileset) return null;

    const currentTime = this.props.currentTime;
    const timeWindow = this.props.timeWindow || 86400000;
    const timeStart = currentTime - timeWindow / 2;
    const timeEnd = currentTime + timeWindow / 2;

    // Filter and render tiles based on temporal visibility
    return tileset.tiles
      .filter((tile: Tile2DHeader<SpatioTemporalTileData>) => {
        if (!tile.content && !tile.isLoaded) return false;
        if (!tile.content) return false;
        
        const { timeRange } = tile.content;
        return timeRange.end >= timeStart && timeRange.start <= timeEnd;
      })
      .map((tile: Tile2DHeader<SpatioTemporalTileData>) => {
        // Check if we need to regenerate layers
        if (!tile.layers && tile.content) {
          const layers = this.renderSubLayers({
            ...this.props,
            ...this.getSubLayerProps({
              id: tile.id,
              updateTriggers: {
                ...this.props.updateTriggers,
                currentTime: this.props.currentTime,
              }
            }),
            data: tile.content,
            _offset: 0,
            tile,
          });
          
          tile.layers = Array.isArray(layers) 
            ? layers.flat().filter(Boolean) as Layer[]
            : layers ? [layers] : [];
        }
        
        return tile.layers;
      });
  }

  /**
   * Get current archive metadata
   */
  getMetadata(): ArchiveMetadata | null {
    return this.state.metadata;
  }

  /**
   * Get visible tiles in current time window
   */
  getVisibleTiles(): Tile2DHeader<SpatioTemporalTileData>[] {
    return this.state.visibleTiles || [];
  }
}

export default SpatioTemporalTileLayer;
