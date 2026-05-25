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
import { snapshot, isProbeEnabled } from './telemetry';

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
  
  /** Force a specific zoom level (useful for GlobeView to load low-zoom tiles) */
  zoomOverride?: number;
  
  /** Use global bounds instead of viewport bounds (for GlobeView) */
  useGlobalBounds?: boolean;
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
  tickHandler?: (time: number) => void;
  /** Tracks the URL whose archive init is currently in flight, to avoid racing duplicate inits. */
  initializingUrl?: string | null;
}

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
export class SpatioTemporalLayer<
  Props extends SpatioTemporalLayerProps = SpatioTemporalLayerProps
> extends CompositeLayer<Props> {
  static layerName = 'SpatioTemporalLayer';
  
  // Internal time tracking - updated every tick without setState overhead
  // Sublayers read from this via getCurrentTime() method
  protected _currentTime: number = 0;

  // Track last time we updated the tileset to throttle updates
  private _lastTilesetUpdateTime: number = 0;

  // rAF handle for coalescing onTileLoad setState calls. Many tiles can
  // finish loading within one frame; batching avoids one full
  // renderLayers()/buildConsolidatedData() rebuild per tile.
  private _tileLoadRafId: number | null = null;

  /**
   * Snapshot of the tile-ID set from the last `_tilesChanged` comparison.
   * Set-based membership is the authoritative signal — we no longer treat
   * a reordered-but-identical tile array as a change (which used to spin
   * up a spurious setState every frame the tileset re-prioritised).
   */
  private _lastTileIdSet: Set<string> = new Set();

  /**
   * Last viewport (id, zoom, width, height) we computed bounds for.
   * Lets `_updateTileset` skip `viewport.unproject()` on the steady-state
   * 60 Hz path where the viewport hasn't actually moved.
   */
  private _lastBoundsKey: string = '';
  private _cachedBounds: BoundingBox | null = null;

  /**
   * Set once `finalizeState` runs, so an in-flight `_initArchiveAndTileset`
   * await that resolves AFTER the layer is gone can bail before attaching
   * a fresh archive/tileset to dead state. Without this, a fast
   * dataset-switch leaks the archive that was racing to come online.
   */
  private _finalized: boolean = false;

  static defaultProps = {
    // Data source
    data: { type: 'string', value: '', compare: true },
    
    // Temporal properties
    currentTime: { type: 'number', value: Date.now(), compare: true },
    timeWindow: { type: 'number', value: 86400000, compare: false }, // 1 day default
    timeRange: { type: 'object', value: null, compare: true },
    timeController: { type: 'object', value: null, compare: false },
    
    // Tile loading configuration (following deck.gl TileLayer pattern).
    // maxRequests sits at 12 because browsers cap concurrent connections per
    // origin (~6 HTTP/1.1, more under HTTP/2 multiplexing). Going above ~12
    // just queues fetches inside the browser and lengthens the main-thread
    // decode backlog without speeding anything up.
    maxRequests: { type: 'number', value: 12, compare: false },
    debounceTime: { type: 'number', value: 0, compare: false }, // No debounce for time changes
    maxCacheSize: { type: 'number', value: 2000, compare: false }, // Large cache for big datasets
    maxCacheByteSize: { type: 'number', value: 2 * 1024 * 1024 * 1024, compare: false }, // 2GB for large datasets

    // Prefetch configuration. Defaults sized for a few real-time seconds of
    // buffer, not minutes — see DemoPage.tsx for the consumer-side math.
    // Overshooting here (the previous defaults were 60s ahead × 15 steps =
    // 15 minutes of lookahead) caused the prefetch queue to balloon and
    // saturated the decode backlog.
    enablePrefetch: { type: 'boolean', value: true, compare: false },
    prefetchAhead: { type: 'number', value: 30000, compare: false }, // 30s of sim time
    prefetchSteps: { type: 'number', value: 4, compare: false },
    
    // Callbacks
    onViewportLoad: { type: 'function', value: null, optional: true },
    onTileLoad: { type: 'function', value: null, optional: true },
    onTileUnload: { type: 'function', value: null, optional: true },
    
    // Loaders options
    loadOptions: { type: 'object', value: {}, compare: false },
  };

  declare state: SpatioTemporalLayerState & { [key: string]: unknown };

  initializeState(_context: LayerContext): void {
    // Initialize internal time tracking
    this._currentTime = this.props.currentTime;
    this._lastTilesetUpdateTime = this.props.currentTime;
    
    // Create handler for play state changes
    const playStateHandler = (playing: boolean, speed: number) => {
      const { tileset } = this.state;
      if (tileset) {
        tileset.setAnimationState(playing, speed);
      }
    };
    
    // Create handler for time tick updates - this allows the layer to update
    // without React re-rendering the entire layer tree
    const tickHandler = (time: number) => {
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

  finalizeState(_context: LayerContext): void {
    this._finalized = true;
    // Cancel any pending coalesced tile-load update.
    if (this._tileLoadRafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this._tileLoadRafId);
      } else {
        clearTimeout(this._tileLoadRafId as unknown as ReturnType<typeof setTimeout>);
      }
      this._tileLoadRafId = null;
    }

    // Unsubscribe from time controller
    if (this.props.timeController) {
      if (this.state.playStateHandler) {
        this.props.timeController.off('playState', this.state.playStateHandler);
      }
      if (this.state.tickHandler) {
        this.props.timeController.off('tick', this.state.tickHandler);
      }
    }
    
    // Cleanup tileset + archive resources (the archive owns the worker-pool
    // decoder when one is in use; we must terminate it on unmount or the
    // workers stay alive across navigations).
    const { tileset, archive } = this.state;
    if (tileset) {
      tileset.finalize();
    }
    if (archive) {
      archive.finalize();
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
    // Race guard: `_initArchiveAndTileset` is async, so during the first
    // window after `initializeState` both `state.archive` and
    // `state.initializingUrl` describe what's coming. We treat the URL as
    // unchanged if either the live archive or an in-flight init already
    // matches it — without that check, the first `updateState` after init
    // (where `state.archive` is still null) re-fires `_initArchiveAndTileset`
    // and we get two parallel archive setups racing to attach workers.
    const liveUrl = this.state.archive?.url ?? this.state.initializingUrl ?? null;
    const dataChanged = propsChanged && this.props.data !== liveUrl;
    
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
  private _handleTimeUpdate(time: number): void {
    const { tileset } = this.state;
    if (!tileset) return;
    
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
        if (this._tilesChanged(newTiles)) {
          // Tiles changed - use setState (this will trigger full update cycle)
          this.setState({
            tiles: newTiles,
            frameNumber: (this.state.frameNumber || 0) + 1,
          });
          this._commitTileIdSet(newTiles);
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
   * Schedule a coalesced tiles-state update after tile load(s).
   *
   * Multiple tiles often finish loading within a single animation frame.
   * Instead of calling setState() per tile (each triggering a full
   * renderLayers() + buildConsolidatedData() rebuild), we batch them into one
   * rAF-deferred setState. The frameNumber is bumped once per batch, only if
   * the visible tile SET actually changed.
   */
  private _scheduleTileLoadUpdate(tileset: SpatiotemporalTileset): void {
    if (this._tileLoadRafId !== null) {
      // An update is already queued for this frame.
      return;
    }

    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0) as unknown as number;

    this._tileLoadRafId = schedule(() => {
      this._tileLoadRafId = null;

      const visibleTiles = tileset.getVisibleTiles();

      // Only bump frameNumber / setState if the tile set actually changed.
      // Otherwise a setNeedsRedraw is enough and we keep the cached layers.
      if (this._tilesChanged(visibleTiles)) {
        this.setState({
          tiles: visibleTiles,
          frameNumber: (this.state.frameNumber || 0) + 1,
        });
        this._commitTileIdSet(visibleTiles);
      } else {
        this.setNeedsRedraw();
      }
    }) as unknown as number;
  }

  /**
   * Set-based "did the visible tile set actually change?" check.
   *
   * Order-insensitive — the previous positional comparison treated a
   * reordered-but-identical tile list as a change, which spun up a
   * spurious setState (and a full sublayer rebuild downstream) every
   * frame the tileset re-prioritised. We carry the previous ID set on
   * the layer so the comparison is O(currentTiles).
   */
  private _tilesChanged(newTiles: Tile[]): boolean {
    const prev = this._lastTileIdSet;
    if (prev.size !== newTiles.length) return true;
    for (const tile of newTiles) {
      const { z, x, y, t } = tile.id;
      const key = `${z}/${x}/${y}/${t}`;
      if (!prev.has(key)) return true;
    }
    return false;
  }

  /**
   * Refresh the cached tile-ID set after we commit `newTiles` to state.
   * Kept separate from `_tilesChanged` so callers can probe equality
   * without mutating the cache.
   */
  private _commitTileIdSet(newTiles: Tile[]): void {
    const next = new Set<string>();
    for (const tile of newTiles) {
      const { z, x, y, t } = tile.id;
      next.add(`${z}/${x}/${y}/${t}`);
    }
    this._lastTileIdSet = next;
  }

  private _updateTileset(changeFlags: any): void {
    const { tileset } = this.state;
    if (!tileset) return;
    
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
      if (DEBUG) console.log('[STL] No viewport available');
      return;
    }
    
    const bounds = this.getViewportBounds(viewport);
    const zoom = this.getZoomLevel(viewport);
    
    // Get effective time window - subclasses can override for trail rendering etc.
    const timeWindow = this.getEffectiveTimeWindow();
    
    // Update tileset - this returns a new frameNumber if tiles changed
    const frameNumber = tileset.update({
      bounds,
      zoom,
      time: currentTime,
      timeWindow,
    }, skipDebounce);

    // Get visible tiles (optimistic rendering - show what we have)
    const tiles = tileset.getVisibleTiles();

    // Decide whether to setState. Two conditions matter for the consolidated
    // render path: the visible tile SET changed, or the frameNumber bumped
    // (a new tile finished loading). We check the tile content directly as
    // defense in depth — historically the tileset bumped frameNumber on
    // every selectAndLoadTiles() call, which made the trip consolidation
    // rebuild every animation frame. The content check stays cheap and
    // ensures we never re-consolidate when the visible set is unchanged.
    const frameChanged = this.state.frameNumber !== frameNumber;
    const tilesChanged = this._tilesChanged(tiles);

    if (frameChanged || tilesChanged) {
      this._lastTilesetUpdateTime = currentTime;
      this.setState({
        tiles,
        frameNumber,
      });
      this._commitTileIdSet(tiles);
    }

    // Track loading state (doesn't trigger re-render)
    this.state.isLoaded = tiles.length > 0;

    // Publish tileset stats so the HUD / probe consumers can read them
    // without a getter callback. The arguments to snapshot() are evaluated
    // unconditionally (JS), so building the stats objects here costs real
    // frame time even though snapshot() itself is a no-op when the probe is
    // off. Gate on isProbeEnabled() to make production truly free —
    // tileset.getCacheStats() / archive.getCacheStats() each allocate a
    // small object every call and the archive path also touches OPFS state.
    if (isProbeEnabled()) {
      const tilesetStats = tileset.getCacheStats();
      snapshot('tileset.stats', {
        ...tilesetStats,
        visibleTiles: tiles.length,
        layerId: this.props.id,
      });
      const archive = this.state.archive;
      if (archive) {
        snapshot('archive.stats', archive.getCacheStats());
      }
    }

    if (DEBUG) {
      console.log(
        '[STL] Tileset updated - frame:',
        frameNumber,
        'tiles:',
        tiles.length,
        'stats:',
        tileset.getCacheStats(),
      );
    }
  }

  /**
   * Get the effective time window for tile loading.
   * Subclasses can override this to account for trail rendering, etc.
   * 
   * For trail rendering, the time window should be at least 2x the trail length
   * to ensure tiles containing trail data are loaded.
   */
  protected getEffectiveTimeWindow(): number {
    return this.props.timeWindow || 86400000;
  }

  private async _initArchiveAndTileset(): Promise<void> {
    if (DEBUG) console.log('[STL] Initializing archive from', this.props.data);

    // Tear the previous archive/tileset down BEFORE wiring up the new pair.
    // Without this, switching the `data` prop leaks the previous archive's
    // worker pool + OPFS handles and the in-flight requests of the previous
    // tileset (they finish, mutate orphaned state, and only get GC'd when
    // every closure that referenced them is dropped).
    const previousTileset = this.state.tileset;
    const previousArchive = this.state.archive;
    if (previousTileset) {
      previousTileset.finalize();
    }
    if (previousArchive) {
      previousArchive.finalize();
    }
    if (previousTileset || previousArchive) {
      // Drop the tile-ID cache too — the next render starts from scratch.
      this._lastTileIdSet = new Set();
    }

    // Track this init so a follow-up `updateState` doesn't fire a parallel
    // init for the same URL (see `dataChanged` in updateState).
    const targetUrl = this.props.data;
    this.state.initializingUrl = targetUrl;

    const archive = new STTArchive({
        url: targetUrl,
        loadOptions: this.props.loadOptions
    });

    // Get metadata to configure tileset zoom range
    const metadata = await archive.getMetadata();

    // Bail out if the layer was finalized OR another init superseded ours
    // while we awaited metadata. In that case we own a stranded archive,
    // so finalize it ourselves rather than leak it into state.
    if (this._finalized || this.state.initializingUrl !== targetUrl) {
      archive.finalize();
      return;
    }
    
    // Create tileset with archive as data source
    const tileset = new SpatiotemporalTileset({
      maxRequests: this.props.maxRequests!,
      debounceTime: this.props.debounceTime!,
      maxCacheSize: this.props.maxCacheSize!,
      maxCacheByteSize: this.props.maxCacheByteSize!,
      minZoom: metadata.minZoom,
      maxZoom: metadata.maxZoom,
      // Use temporal bucket from metadata for deterministic tile loading
      temporalBucketMs: metadata.temporalBucketMs,
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

        // Coalesce per-tile updates: when many tiles finish within one frame
        // we only want a SINGLE setState (and thus a single renderLayers /
        // buildConsolidatedData rebuild), not one per tile.
        this._scheduleTileLoadUpdate(tileset);
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

    // Reset `tiles` to []; this signals subclass renderLayers() that the
    // visible set just collapsed (their lastTilesRef-guarded prune block
    // re-runs, dropping cache entries that referenced the previous
    // archive's tiles). Without this the cache holds stale entries until
    // the natural "different tile key" prune kicks in on the next render.
    this.setState({ archive, tileset, metadata, initializingUrl: null, tiles: [] });
  }

  private getViewportBounds(viewport: any): BoundingBox {
    // Use global bounds for GlobeView to load all tiles at zoom 0.
    // Static result — cache and return the same reference to dodge any
    // downstream identity checks.
    if (this.props.useGlobalBounds) {
      if (!this._cachedBounds || this._lastBoundsKey !== 'global') {
        this._lastBoundsKey = 'global';
        this._cachedBounds = {
          minLon: -180,
          minLat: -90,
          maxLon: 180,
          maxLat: 90,
        };
      }
      return this._cachedBounds;
    }

    // Per-frame cache: skip the two `unproject()` calls (each a matrix
    // multiply) when the viewport hasn't actually moved. Keyed on the
    // identity dimensions: id, dims, zoom, lon/lat, pitch, bearing. Two
    // unprojects are cheap on their own but the steady-state animation
    // path hits this on every tick of the time controller AND every
    // viewport callback, so the redundancy adds up.
    const v = viewport;
    const key = `${v.id ?? ''}|${v.width}x${v.height}|${v.zoom}|${v.longitude ?? 0},${v.latitude ?? 0}|${v.pitch ?? 0}|${v.bearing ?? 0}`;
    if (this._cachedBounds && this._lastBoundsKey === key) {
      return this._cachedBounds;
    }

    const [minLon, minLat] = viewport.unproject([0, viewport.height]);
    const [maxLon, maxLat] = viewport.unproject([viewport.width, 0]);

    this._lastBoundsKey = key;
    this._cachedBounds = {
      minLon: Math.max(-180, minLon),
      minLat: Math.max(-90, minLat),
      maxLon: Math.min(180, maxLon),
      maxLat: Math.min(90, maxLat),
    };
    return this._cachedBounds;
  }

  private getZoomLevel(viewport: any): number {
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
  get isLoaded(): boolean {
    return this.state.isLoaded;
  }
  
  /**
   * Get the current animation time.
   * Sublayers should use this instead of this.state.currentTime for performance.
   * This is updated every tick without triggering setState.
   */
  getCurrentTime(): number {
    return this._currentTime;
  }

  /**
   * Subclasses override this to render actual visualization layers
   */
  renderLayers(): any[] {
    return [];
  }
}




