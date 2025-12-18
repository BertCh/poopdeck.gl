/**
 * SpatioTemporalTileLayer - deck.gl TileLayer pattern for 4D (x, y, z, t) tiles
 *
 * Extends @deck.gl/geo-layers TileLayer with temporal dimension support.
 * Uses the standard TileLayer patterns for viewport culling, request management,
 * and cache eviction while adding time-based filtering.
 */
import { TileLayer } from '@deck.gl/geo-layers';
import type { TileLayerProps } from '@deck.gl/geo-layers';
import type { Layer, LayersList, UpdateParameters, DefaultProps } from '@deck.gl/core';
import type { _Tile2DHeader as Tile2DHeader, _TileLoadProps as TileLoadProps } from '@deck.gl/geo-layers';
import { STTArchive } from '@stt/core';
import type { Tile, ArchiveMetadata } from '@stt/core';
import { TimeController } from './time-controller';
/**
 * Extended tile data including temporal information
 */
export interface SpatioTemporalTileData {
    /** The decoded tile data (binary format) */
    tile: Tile;
    /** Tile temporal bounds */
    timeRange: {
        start: number;
        end: number;
    };
}
export interface SpatioTemporalTileLayerProps extends Omit<TileLayerProps<SpatioTemporalTileData>, 'data' | 'getTileData'> {
    /** URL to STT archive */
    data: string;
    /** Current time to display (Unix milliseconds) */
    currentTime: number;
    /** Time window (milliseconds before and after currentTime) */
    timeWindow?: number;
    /** Full time range of the dataset */
    timeRange?: {
        start: number;
        end: number;
    };
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
    [key: string]: unknown;
}
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
export declare class SpatioTemporalTileLayer<ExtraPropsT extends {} = {}> extends TileLayer<SpatioTemporalTileData, SpatioTemporalTileLayerProps & ExtraPropsT> {
    static layerName: string;
    static defaultProps: DefaultProps<SpatioTemporalTileLayerProps>;
    state: TileLayer<SpatioTemporalTileData>['state'] & SpatioTemporalTileLayerState;
    initializeState(): void;
    shouldUpdateState(params: {
        changeFlags: {
            somethingChanged: boolean;
        };
    }): boolean;
    updateState(params: UpdateParameters<this>): void;
    /**
     * Initialize the STT archive
     */
    private _initArchive;
    /**
     * Override getTileData to load from STT archive
     */
    getTileData(loadProps: TileLoadProps): Promise<SpatioTemporalTileData> | SpatioTemporalTileData | null;
    /**
     * Load a tile from the archive with temporal bounds
     */
    private _loadTileWithTime;
    /**
     * Convert tile index to geographic bounds
     */
    private _tileIndexToBounds;
    /**
     * Filter visible tiles by current time
     */
    private _filterTilesByTime;
    /**
     * Override renderLayers to only render time-visible tiles
     */
    renderLayers(): Layer | null | LayersList;
    /**
     * Get current archive metadata
     */
    getMetadata(): ArchiveMetadata | null;
    /**
     * Get visible tiles in current time window
     */
    getVisibleTiles(): Tile2DHeader<SpatioTemporalTileData>[];
}
export default SpatioTemporalTileLayer;
//# sourceMappingURL=spatiotemporal-tile-layer.d.ts.map