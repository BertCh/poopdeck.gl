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
 * - Request concurrency control (maxRequests: 24)
 * - Debouncing for smooth viewport changes
 * - LRU cache with size limits
 * - Frame-based rendering optimization
 */
export class SpatioTemporalLayer extends CompositeLayer {
    initializeState(_context) {
        // Create handler for play state changes
        const playStateHandler = (playing, speed) => {
            const { tileset } = this.state;
            if (tileset) {
                tileset.setAnimationState(playing, speed);
            }
        };
        // Create handler for time tick updates - this allows the layer to update
        // without React re-rendering the entire layer tree
        const tickHandler = (time) => {
            // Only update if time actually changed significantly (avoid micro-updates)
            if (Math.abs(time - this.state.currentTime) > 1) {
                this._handleTimeUpdate(time);
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
            tickHandler,
        });
        // Subscribe to time controller events if provided
        if (this.props.timeController) {
            this.props.timeController.on('playState', playStateHandler);
            this.props.timeController.on('tick', tickHandler);
        }
        // Initialize archive and tileset
        this._initArchiveAndTileset();
    }
    finalizeState(_context) {
        // Unsubscribe from time controller
        if (this.props.timeController) {
            if (this.state.playStateHandler) {
                this.props.timeController.off('playState', this.state.playStateHandler);
            }
            if (this.state.tickHandler) {
                this.props.timeController.off('tick', this.state.tickHandler);
            }
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
    shouldUpdateState(params) {
        return params.changeFlags.somethingChanged;
    }
    updateState(params) {
        const { changeFlags, oldProps } = params;
        const propsChanged = changeFlags.propsChanged;
        const dataChanged = propsChanged && this.props.data !== this.state.archive?.url;
        // Handle TimeController changes
        if (oldProps?.timeController !== this.props.timeController) {
            // Unsubscribe from old controller
            if (oldProps?.timeController) {
                if (this.state.playStateHandler) {
                    oldProps.timeController.off('playState', this.state.playStateHandler);
                }
                if (this.state.tickHandler) {
                    oldProps.timeController.off('tick', this.state.tickHandler);
                }
            }
            // Subscribe to new controller
            if (this.props.timeController) {
                if (this.state.playStateHandler) {
                    this.props.timeController.on('playState', this.state.playStateHandler);
                }
                if (this.state.tickHandler) {
                    this.props.timeController.on('tick', this.state.tickHandler);
                }
                // Sync current animation state
                const { tileset } = this.state;
                if (tileset) {
                    tileset.setAnimationState(this.props.timeController.isPlaying(), this.props.timeController.getSpeed());
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
    /**
     * Handle time updates from TimeController tick events
     *
     * PERFORMANCE OPTIMIZED:
     * - Only updates currentTime without full tile re-evaluation
     * - Tiles are updated less frequently via a throttled tileset update
     * - Layer caching in subclasses ensures GPU state is preserved
     */
    _handleTimeUpdate(time) {
        const { tileset } = this.state;
        if (!tileset)
            return;
        // Update current time immediately for smooth animation
        // This is a minimal state update - just the time value
        const prevTime = this.state.currentTime;
        this.state.currentTime = time;
        // Check if we need to update the tileset (throttled)
        // Only update tileset when time has changed significantly relative to timeWindow
        const timeWindow = this.props.timeWindow || 86400000;
        const timeDelta = Math.abs(time - prevTime);
        const updateThreshold = timeWindow / 20; // Update tileset when 5% of time window has passed
        if (timeDelta > updateThreshold) {
            const viewport = this.context.viewport;
            if (viewport) {
                const bounds = this.getViewportBounds(viewport);
                const zoom = this.getZoomLevel(viewport);
                // Update tileset - this triggers prefetch for upcoming tiles
                tileset.update({
                    bounds,
                    zoom,
                    time,
                    timeWindow,
                }, true); // skipDebounce = true for animation
                // Only get new tiles array if tileset might have changed
                const tiles = tileset.getVisibleTiles();
                // Check if tiles actually changed (different length or different tile IDs)
                if (tiles.length !== this.state.tiles.length || this._tilesChanged(tiles)) {
                    this.state.tiles = tiles;
                    this.state.frameNumber = (this.state.frameNumber || 0) + 1;
                }
            }
        }
        // Force deck.gl to re-draw this layer (updates uniforms in shaders)
        this.setNeedsRedraw();
    }
    /**
     * Check if the tiles array has actually changed (not just reference)
     */
    _tilesChanged(newTiles) {
        const oldTiles = this.state.tiles;
        if (!oldTiles || oldTiles.length !== newTiles.length)
            return true;
        // Quick check: compare tile IDs
        for (let i = 0; i < newTiles.length; i++) {
            const newId = newTiles[i].id;
            const oldId = oldTiles[i].id;
            if (newId.z !== oldId.z || newId.x !== oldId.x ||
                newId.y !== oldId.y || newId.t !== oldId.t) {
                return true;
            }
        }
        return false;
    }
    _updateTileset(changeFlags) {
        const { tileset } = this.state;
        if (!tileset)
            return;
        // Get current time from TimeController if available, otherwise from props
        // This allows the layer to work correctly when currentTime is not passed as a prop
        const currentTime = this.props.timeController
            ? this.props.timeController.getTime()
            : this.props.currentTime;
        // Check if it's a time-only change for debouncing logic
        const timeChanged = changeFlags.propsChanged && currentTime !== this.state.currentTime;
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
            time: currentTime,
            timeWindow,
        }, skipDebounce);
        // Get visible tiles (optimistic rendering - show what we have)
        const tiles = tileset.getVisibleTiles();
        // Check if state changed
        const frameChanged = this.state.frameNumber !== frameNumber;
        const timeStateChanged = currentTime !== this.state.currentTime;
        if (frameChanged || timeStateChanged) {
            // Trigger re-render by updating state
            this.setState({
                tiles,
                frameNumber,
                currentTime,
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
            // Prefetch configuration for smooth animation playback
            enablePrefetch: this.props.enablePrefetch,
            prefetchAhead: this.props.prefetchAhead,
            prefetchSteps: this.props.prefetchSteps,
            getAvailableTiles: (bounds, zoom, timeRange) => archive.getTileIdsInBounds(bounds, zoom, timeRange),
            getTileData: (tileId) => archive.getTile(tileId),
            onTileLoad: (tile) => {
                if (DEBUG)
                    console.log('[STL] Tile loaded:', tile.id);
                this.props.onTileLoad?.(tile);
                // Update tiles state immediately when new tiles load
                // This ensures the map updates with newly loaded data
                const visibleTiles = tileset.getVisibleTiles();
                this.setState({
                    tiles: visibleTiles,
                    frameNumber: (this.state.frameNumber || 0) + 1,
                });
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
        // If time controller is playing, set initial animation state
        if (this.props.timeController?.isPlaying()) {
            tileset.setAnimationState(true, this.props.timeController.getSpeed());
        }
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
    maxRequests: { type: 'number', value: 64, compare: false }, // Higher for parallel animation loading
    debounceTime: { type: 'number', value: 0, compare: false }, // No debounce for time changes
    maxCacheSize: { type: 'number', value: 2000, compare: false }, // Large cache for big datasets
    maxCacheByteSize: { type: 'number', value: 2 * 1024 * 1024 * 1024, compare: false }, // 2GB for large datasets
    // Prefetch configuration for smooth animation
    enablePrefetch: { type: 'boolean', value: true, compare: false },
    prefetchAhead: { type: 'number', value: 30000, compare: false }, // 30 seconds ahead
    prefetchSteps: { type: 'number', value: 10, compare: false }, // More steps for fast animations
    // Callbacks
    onViewportLoad: { type: 'function', value: null, optional: true },
    onTileLoad: { type: 'function', value: null, optional: true },
    onTileUnload: { type: 'function', value: null, optional: true },
    // Loaders options
    loadOptions: { type: 'object', value: {}, compare: false },
};
//# sourceMappingURL=spatiotemporal-layer.js.map