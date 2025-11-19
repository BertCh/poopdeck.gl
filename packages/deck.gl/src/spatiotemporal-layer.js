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
    initializeState() {
        this.setState({
            archive: null,
            tileset: null,
            tiles: [],
            currentTime: this.props.currentTime,
            isLoaded: false,
        });
        // Initialize archive and tileset
        this.initArchiveAndTileset();
    }
    finalizeState() {
        // Cleanup tileset
        if (this.state.tileset) {
            this.state.tileset.finalize();
        }
    }
    /**
     * deck.gl layer lifecycle: decide if layer needs to update
     * Following deck.gl TileLayer pattern - return true for any change including viewport
     */
    shouldUpdateState({ changeFlags }) {
        return changeFlags.somethingChanged;
    }
    updateState({ changeFlags }) {
        const propsChanged = changeFlags.propsChanged;
        const dataChanged = propsChanged && this.props.data !== this.state.archive?.url;
        if (dataChanged) {
            // Reinitialize with new data source
            this.initArchiveAndTileset();
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
    async initArchiveAndTileset() {
        if (DEBUG)
            console.log('[STL] Initializing archive from', this.props.data);
        const archive = new STTArchive(this.props.data);
        // Get metadata to configure tileset zoom range
        const metadata = await archive.getMetadata();
        // Calculate appropriate prefetch time increment based on dataset
        // This helps prefetch the right amount of data ahead
        const datasetDuration = metadata.timeRange.end - metadata.timeRange.start;
        const defaultPrefetchIncrement = this.props.prefetchTimeIncrement || 86400000;
        // Create tileset with archive as data source
        const tileset = new SpatiotemporalTileset({
            maxRequests: this.props.maxRequests,
            debounceTime: this.props.debounceTime,
            maxCacheSize: this.props.maxCacheSize,
            maxCacheByteSize: this.props.maxCacheByteSize,
            minZoom: metadata.minZoom,
            maxZoom: metadata.maxZoom,
            refinementStrategy: 'best-available', // Load parent tiles as fallback (deck.gl pattern)
            enablePrefetch: this.props.enablePrefetch ?? true,
            prefetchTimeSteps: this.props.prefetchTimeSteps ?? 10,
            prefetchTimeIncrement: defaultPrefetchIncrement,
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
        console.log('[STL] Prefetch enabled:', this.props.enablePrefetch ?? true, 'steps:', this.props.prefetchTimeSteps ?? 10, 'increment:', defaultPrefetchIncrement, 'ms');
        console.log('[STL] Cache size limits:', 'tiles:', this.props.maxCacheSize, 'bytes:', Math.round((this.props.maxCacheByteSize || 0) / (1024 * 1024)), 'MB');
        this.setState({ archive, tileset });
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
        const { archive } = this.state;
        if (archive) {
            // Use metadata from tileset (already loaded during initialization)
            // Metadata is fetched in initArchiveAndTileset()
            const minZoom = 0; // Default fallback
            const maxZoom = 14; // Default fallback
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
    data: { type: 'string', value: '', compare: true },
    currentTime: { type: 'number', value: Date.now(), compare: true },
    timeWindow: { type: 'number', value: 86400000, compare: false }, // 1 day
    opacity: { type: 'number', value: 1.0, compare: false },
    visible: { type: 'boolean', value: true, compare: false },
    maxRequests: { type: 'number', value: 12, compare: false }, // Increased from 6 for aggressive prefetching
    debounceTime: { type: 'number', value: 100, compare: false }, // Reduced from 300ms for faster response
    maxCacheSize: { type: 'number', value: 2000, compare: false }, // 10x increase from 200 for smooth looping
    maxCacheByteSize: { type: 'number', value: 2 * 1024 * 1024 * 1024, compare: false }, // 2GB for smooth looping
    enablePrefetch: { type: 'boolean', value: true, compare: false }, // Enable prefetching by default
    prefetchTimeSteps: { type: 'number', value: 10, compare: false }, // Prefetch 10 time steps ahead
    prefetchTimeIncrement: { type: 'number', value: 86400000, compare: false }, // 1 day default
    onViewportLoad: { type: 'function', value: null, compare: false },
    onTileLoad: { type: 'function', value: null, compare: false },
    onTileUnload: { type: 'function', value: null, compare: false },
};
//# sourceMappingURL=spatiotemporal-layer.js.map