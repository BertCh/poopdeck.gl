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
    constructor() {
        super(...arguments);
        // Internal time tracking - updated every tick without setState overhead
        // Sublayers read from this via getCurrentTime() method
        this._currentTime = 0;
        // Track last time we updated the tileset to throttle updates
        this._lastTilesetUpdateTime = 0;
    }
    initializeState(_context) {
        // Initialize internal time tracking
        this._currentTime = this.props.currentTime;
        this._lastTilesetUpdateTime = this.props.currentTime;
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
            if (Math.abs(time - this._currentTime) > 1) {
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
     * - Updates _currentTime directly (no setState overhead)
     * - Only calls setState when tiles actually change (infrequent)
     * - Calls setNeedsRedraw() for time-only changes (NOT setNeedsUpdate!)
     * - Time is read via getTime() getter in TimeFilterExtension.draw()
     * - This avoids renderLayers() call when only time changes
     */
    _handleTimeUpdate(time) {
        const { tileset } = this.state;
        if (!tileset)
            return;
        // Always update internal time tracking (no setState overhead)
        this._currentTime = time;
        // Check if we need to update the tileset (throttled)
        const timeWindow = this.props.timeWindow || 86400000;
        const timeDelta = Math.abs(time - this._lastTilesetUpdateTime);
        const updateThreshold = timeWindow / 20; // Update tileset when 5% of time window has passed
        let tilesChanged = false;
        if (timeDelta > updateThreshold) {
            this._lastTilesetUpdateTime = time;
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
                // Check if tiles actually changed
                const newTiles = tileset.getVisibleTiles();
                if (newTiles.length !== this.state.tiles.length || this._tilesChanged(newTiles)) {
                    // Tiles changed - use setState (this will trigger full update cycle)
                    this.setState({
                        tiles: newTiles,
                        frameNumber: (this.state.frameNumber || 0) + 1,
                    });
                    tilesChanged = true;
                }
            }
        }
        // PERFORMANCE: For time-only changes, use setNeedsRedraw() instead of setNeedsUpdate()
        // This triggers a redraw WITHOUT calling renderLayers() - the memoized layer is reused
        // Time updates happen via the getTime() getter in TimeFilterExtension.draw()
        if (!tilesChanged) {
            this.setNeedsRedraw();
        }
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
        const currentTime = this.props.timeController
            ? this.props.timeController.getTime()
            : this.props.currentTime;
        // Update internal time tracking
        this._currentTime = currentTime;
        // Check if it's a time-only change for debouncing logic
        const timeChanged = changeFlags.propsChanged && currentTime !== this._lastTilesetUpdateTime;
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
        // Check if tiles actually changed
        const frameChanged = this.state.frameNumber !== frameNumber;
        if (frameChanged) {
            // Tiles changed - use setState
            this._lastTilesetUpdateTime = currentTime;
            this.setState({
                tiles,
                frameNumber,
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
        // Use global bounds for GlobeView to load all tiles at zoom 0
        if (this.props.useGlobalBounds) {
            return {
                minLon: -180,
                minLat: -90,
                maxLon: 180,
                maxLat: 90,
            };
        }
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
        // Use zoomOverride if specified (useful for GlobeView)
        if (this.props.zoomOverride !== undefined) {
            return this.props.zoomOverride;
        }
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
     * Get the current animation time.
     * Sublayers should use this instead of this.state.currentTime for performance.
     * This is updated every tick without triggering setState.
     */
    getCurrentTime() {
        return this._currentTime;
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
    // Prefetch configuration for smooth animation - aggressive defaults to prevent flashing
    enablePrefetch: { type: 'boolean', value: true, compare: false },
    prefetchAhead: { type: 'number', value: 60000, compare: false }, // 60 seconds ahead for smooth animation
    prefetchSteps: { type: 'number', value: 15, compare: false }, // Aggressive prefetching to prevent flashing
    // Callbacks
    onViewportLoad: { type: 'function', value: null, optional: true },
    onTileLoad: { type: 'function', value: null, optional: true },
    onTileUnload: { type: 'function', value: null, optional: true },
    // Loaders options
    loadOptions: { type: 'object', value: {}, compare: false },
};
//# sourceMappingURL=spatiotemporal-layer.js.map