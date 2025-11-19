/**
 * Base layer for spatiotemporal tile visualization
 */

import { CompositeLayer } from '@deck.gl/core';
import { STTArchive } from '@stt/core';
import type { Tile, BoundingBox } from '@stt/core';
import { TimeController } from './time-controller';

// Debug flag - set to false for production
const DEBUG = false;

export interface SpatioTemporalLayerProps {
  /** URL to STT archive */
  data: string;
  
  /** Current time to display (Unix milliseconds) */
  currentTime: number;
  
  /** Time window (milliseconds before and after currentTime) */
  timeWindow?: number;
  
  /** Time controller (optional, for synchronized animation) */
  timeController?: TimeController;
  
  /** Opacity */
  opacity?: number;
  
  /** Visible flag */
  visible?: boolean;
  
  /** Interpolation enabled */
  interpolation?: boolean;
  
  /** Tile cache size in bytes */
  cacheSize?: number;
}

interface SpatioTemporalLayerState {
  archive: STTArchive | null;
  tiles: Tile[];
  currentTime: number;
}

/**
 * Base layer for spatiotemporal tile visualization
 * 
 * This is an abstract base class that handles:
 * - Loading tiles from STT archive
 * - Filtering features by time
 * - Managing tile cache
 * - Time-based animation
 * 
 * Subclasses implement specific visualization types (points, paths, heatmaps, etc.)
 */
export class SpatioTemporalLayer<
  Props extends SpatioTemporalLayerProps = SpatioTemporalLayerProps
> extends CompositeLayer<Props> {
  static layerName = 'SpatioTemporalLayer';

  static defaultProps = {
    data: { type: 'string', value: '', compare: true },
    currentTime: { type: 'number', value: Date.now(), compare: true },
    timeWindow: { type: 'number', value: 86400000, compare: false }, // 1 day
    opacity: { type: 'number', value: 1.0, compare: false },
    visible: { type: 'boolean', value: true, compare: false },
    interpolation: { type: 'boolean', value: true, compare: false },
    cacheSize: { type: 'number', value: 200 * 1024 * 1024, compare: false },
  };

  declare state: SpatioTemporalLayerState & { [key: string]: any };

  initializeState(): void {
    this.setState({
      archive: null,
      tiles: [],
      currentTime: this.props.currentTime,
    });

    // Initialize archive
    this.initArchive();

    // Subscribe to time controller if provided
    if (this.props.timeController) {
      this.props.timeController.on('tick', this.onTimeUpdate);
    }
  }

  finalizeState(): void {
    if (this.props.timeController) {
      this.props.timeController.off('tick', this.onTimeUpdate);
    }
  }

  updateState({ changeFlags }: any): void {
    if (changeFlags.propsChanged) {
      if (this.props.data !== this.state.archive?.url) {
        // Don't await - let it load asynchronously
        this.initArchive();
      }

      if (this.props.currentTime !== this.state.currentTime) {
        // Update current time immediately
        this.setState({ currentTime: this.props.currentTime });
        // Load tiles asynchronously
        this.loadTilesForTime(this.props.currentTime);
      }
    }
  }

  private async initArchive(): Promise<void> {
    if (DEBUG) console.log('SpatioTemporalLayer: Initializing archive from', this.props.data);
    const archive = new STTArchive(this.props.data);
    this.setState({ archive });

    // Load initial tiles
    await this.loadTilesForTime(this.props.currentTime);
  }

  private async loadTilesForTime(time: number): Promise<void> {
    const { archive } = this.state;
    if (!archive) {
      if (DEBUG) console.log('SpatioTemporalLayer: No archive, skipping tile load');
      return;
    }

    // Get viewport bounds
    const viewport = this.context.viewport;
    if (!viewport) {
      if (DEBUG) console.log('SpatioTemporalLayer: No viewport available');
      return;
    }
    
    const bounds = this.getViewportBounds(viewport);

    // Get appropriate zoom level
    const zoom = this.getZoomLevel(viewport);

    // Get archive metadata to know the actual time bounds
    const metadata = await archive.getMetadata();

    // Load tiles
    try {
      // Use smart initial window based on dataset duration and user config
      // This prevents loading 400 days of data for 24-hour datasets
      const datasetDuration = metadata.timeRange.end - metadata.timeRange.start;
      const userTimeWindow = this.props.timeWindow || 86400000; // 1 day default
      
      // Initial window: smaller of dataset duration or 10x user window (max 30 days)
      const maxInitialWindow = Math.min(30 * 86400000, datasetDuration);
      const initialTimeWindow = Math.min(maxInitialWindow, userTimeWindow * 10);
      
      const initialTimeRange = {
        start: Math.max(metadata.timeRange.start, time - initialTimeWindow / 2),
        end: Math.min(metadata.timeRange.end, time + initialTimeWindow / 2),
      };
      
      if (DEBUG) console.log(`SpatioTemporalLayer: Initial load with ${initialTimeWindow / 86400000} day window`);
      const tiles = await archive.getTilesInBounds(bounds, zoom, initialTimeRange);
      
      if (DEBUG) console.log(`SpatioTemporalLayer: Loaded ${tiles.length} tiles`);

      // Auto-configure from first tile's temporal resolution
      if (tiles.length > 0 && tiles[0].temporalResolution) {
        const tempRes = tiles[0].temporalResolution;
        if (DEBUG) console.log('SpatioTemporalLayer: Auto-configuring from tile metadata:', {
          bucketSizeMs: tempRes.bucketSizeMs,
          suggestedSpeed: tempRes.suggestedSpeedMultiplier,
        });
        
        // Calculate time window (query 2-3x bucket size to catch adjacent tiles)
        const autoTimeWindow = tempRes.bucketSizeMs > 0 
          ? tempRes.bucketSizeMs * 2.5 
          : (this.props.timeWindow || 86400000);
        
        // Reload with proper time window
        const timeRange = {
          start: Math.max(metadata.timeRange.start, time - autoTimeWindow / 2),
          end: Math.min(metadata.timeRange.end, time + autoTimeWindow / 2),
        };
        
        const tilesWithWindow = await archive.getTilesInBounds(bounds, zoom, timeRange);
        if (DEBUG) console.log(`SpatioTemporalLayer: Reloaded with ${autoTimeWindow / 86400000}day window: ${tilesWithWindow.length} tiles`);
        
        // Update time controller speed if needed
        if (this.props.timeController && tempRes.suggestedSpeedMultiplier > 1) {
          // Speed should be ms/sec (how much time advances per second of real time)
          // suggestedSpeedMultiplier is already the desired ms/sec value
          const recommendedSpeed = tempRes.suggestedSpeedMultiplier;
          if (DEBUG) console.log(`SpatioTemporalLayer: Recommending animation speed: ${recommendedSpeed / 86400000} days/sec`);
          this.props.timeController.setSpeed(recommendedSpeed);
        }
        
        this.setState({ tiles: tilesWithWindow, currentTime: time });
      } else {
        // Fallback: use configured time window
        const timeWindow = this.props.timeWindow || 86400000;
        const timeRange = {
          start: Math.max(metadata.timeRange.start, time - timeWindow / 2),
          end: Math.min(metadata.timeRange.end, time + timeWindow / 2),
        };
        
        const tilesWithWindow = await archive.getTilesInBounds(bounds, zoom, timeRange);
        this.setState({ tiles: tilesWithWindow, currentTime: time });
      }

      // Prefetch nearby tiles for smooth animation
      this.prefetchNearbyTiles(bounds, zoom, time);
    } catch (error) {
      console.error('Error loading tiles:', error);
    }
  }

  private async prefetchNearbyTiles(
    bounds: BoundingBox,
    zoom: number,
    currentTime: number
  ): Promise<void> {
    const { archive } = this.state;
    if (!archive) return;

    // Prefetch tiles for next 5 seconds
    const times: number[] = [];
    const speed = this.props.timeController?.getSpeed() || 1.0;
    const direction = speed >= 0 ? 1 : -1;

    for (let i = 1; i <= 5; i++) {
      times.push(currentTime + direction * i * 1000);
    }

    await archive.prefetch(bounds, zoom, times);
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
    // deck.gl uses continuous zoom, tiles use discrete levels
    return Math.floor(viewport.zoom);
  }

  private onTimeUpdate = (time: number): void => {
    if (time !== this.state.currentTime) {
      this.setState({ currentTime: time });
      this.loadTilesForTime(time);
    }
  };

  /**
   * Subclasses override this to render actual visualization layers
   */
  renderLayers(): any[] {
    return [];
  }
}

