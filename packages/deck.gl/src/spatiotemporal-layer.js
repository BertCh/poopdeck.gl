/**
 * Refactored SpatioTemporalLayer using Tileset pattern
 *
 * Based on deck.gl TileLayer architecture with loaders.gl integration
 */
import { CompositeLayer } from '@deck.gl/core';
import { STTArchive } from '@stt/core';
import { SpatiotemporalTileset } from '@stt/core';
const DEBUG = false;
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
export class SpatioTemporalLayer extends CompositeLayer {
    initializeState(_context) {
        this.setState({
            archive: null,
            tileset: null,
            metadata: null,
            tiles: [],
            currentTime: this.props.currentTime,
            isLoaded: false,
        });
        // Initialize archive and tileset
        this._initArchiveAndTileset();
    }
    finalizeState(_context) {
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
    shouldUpdateState(params) {
        return params.changeFlags.somethingChanged;
    }
    updateState(params) {
        const { changeFlags } = params;
        const propsChanged = changeFlags.propsChanged;
        const dataChanged = propsChanged && this.props.data !== this.state.archive?.url;
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
    _updateTileset(changeFlags) {
        const { tileset } = this.state;
        if (!tileset)
            return;
        // Check if it's a time-only change for debouncing logic
        const timeChanged = changeFlags.propsChanged && this.props.currentTime !== this.state.currentTime;
        const skipDebounce = timeChanged && !changeFlags.propsOrDataChanged;
        // Get viewport bounds and zoom
        const viewport = this.context.viewport;
        if (!viewport) {
            if (DEBUG)
                console.log('[STL] No viewport available');
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
    async _initArchiveAndTileset() {
        if (DEBUG)
            console.log('[STL] Initializing archive from', this.props.data);
        const archive = new STTArchive({
            url: this.props.data,
            loadOptions: this.props.loadOptions
        });
        // Get metadata to configure tileset zoom range
        const metadata = await archive.getMetadata();
        // Create tileset with archive as data source
        const tileset = new SpatiotemporalTileset({
            maxRequests: this.props.maxRequests,
            debounceTime: this.props.debounceTime,
            maxCacheSize: this.props.maxCacheSize,
            maxCacheByteSize: this.props.maxCacheByteSize,
            minZoom: metadata.minZoom,
            maxZoom: metadata.maxZoom,
            refinementStrategy: 'best-available', // Load parent tiles as fallback (deck.gl pattern)
            getAvailableTiles: (bounds, zoom, timeRange) => archive.getTileIdsInBounds(bounds, zoom, timeRange),
            getTileData: (tileId) => archive.getTile(tileId),
            onTileLoad: (tile) => {
                if (DEBUG)
                    console.log('[STL] Tile loaded:', tile.id);
                this.props.onTileLoad?.(tile);
                // Trigger re-render when new tiles load
                this.setNeedsUpdate();
            },
            onTileUnload: (tile) => {
                if (DEBUG)
                    console.log('[STL] Tile unloaded:', tile.id);
                this.props.onTileUnload?.(tile);
            },
            onTileError: (error, tileId) => {
                console.error('[STL] Tile error:', tileId, error);
            },
        });
        if (DEBUG)
            console.log('[STL] Tileset configured with zoom range:', metadata.minZoom, '-', metadata.maxZoom);
        this.setState({ archive, tileset, metadata });
    }
    getViewportBounds(viewport) {
        const [minLon, minLat] = viewport.unproject([0, viewport.height]);
        const [maxLon, maxLat] = viewport.unproject([viewport.width, 0]);
        return {
            minLon: Math.max(-180, minLon),
            minLat: Math.max(-90, minLat),
            maxLon: Math.min(180, maxLon),
            maxLat: Math.min(90, maxLat),
        };
    }
    getZoomLevel(viewport) {
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
    get isLoaded() {
        return this.state.isLoaded;
    }
    /**
     * Subclasses override this to render actual visualization layers
     */
    renderLayers() {
        return [];
    }
}
SpatioTemporalLayer.layerName = 'SpatioTemporalLayer';
SpatioTemporalLayer.defaultProps = {
    // Data source
    data: { type: 'string', value: '', compare: true },
    // Temporal properties
    currentTime: { type: 'number', value: Date.now(), compare: true },
    timeWindow: { type: 'number', value: 86400000, compare: false }, // 1 day default
    timeRange: { type: 'object', value: null, compare: true },
    timeController: { type: 'object', value: null, compare: false },
    // Tile loading configuration (following deck.gl TileLayer pattern)
    maxRequests: { type: 'number', value: 6, compare: false },
    debounceTime: { type: 'number', value: 300, compare: false },
    maxCacheSize: { type: 'number', value: 200, compare: false },
    maxCacheByteSize: { type: 'number', value: 500 * 1024 * 1024, compare: false }, // 500MB
    // Callbacks
    onViewportLoad: { type: 'function', value: null, optional: true },
    onTileLoad: { type: 'function', value: null, optional: true },
    onTileUnload: { type: 'function', value: null, optional: true },
    // Loaders options
    loadOptions: { type: 'object', value: {}, compare: false },
};
//# sourceMappingURL=spatiotemporal-layer.js.map