// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Refactored SpatioTemporalLayer using Tileset pattern
 * 
 * Based on deck.gl TileLayer architecture with loaders.gl integration
 */

import { CompositeLayer } from '@deck.gl/core';
import type {
  CompositeLayerProps,
  DefaultProps,
  GetPickingInfoParams,
  LayerContext,
  PickingInfo,
  UpdateParameters,
} from '@deck.gl/core';
import { STTArchive, getFeatureProperties } from '@poopdeck.gl/core';
import { SpatiotemporalTileset } from '@poopdeck.gl/core';
import type {
  Tile,
  TileId,
  BinaryFeatures,
  BoundingBox,
  ArchiveMetadata,
  OverviewPreloadResult,
  SpatiotemporalTilesetOptions,
  SttLoadOptions,
} from '@poopdeck.gl/core';
import { TimeController } from '@poopdeck.gl/playback';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';
import { snapshot, isProbeEnabled } from '../lib/telemetry';
import { warnOnce } from '../lib/log';

const DEBUG = false;

/**
 * Wall-clock floor (ms) between VIEWPORT-driven tileset reselections, mirroring
 * the time-tick path's `MIN_TILESET_UPDATE_WALL_MS`. A controlled camera that
 * animates at 60fps (the AV cockpit's ego-follow, or any drag/zoom) otherwise
 * drives a full `selectAndLoadTiles()` — and its prefetch re-plan — on every
 * STT layer every frame. This caps that to ~10Hz; the GPU still redraws the
 * moving viewport every frame (`setNeedsRedraw()`), and a trailing pass
 * guarantees the SETTLE position reselects when motion ends inside the window.
 */
const MIN_VIEWPORT_TILESET_WALL_MS = 100;

/**
 * Picking info emitted by the STT layer family. Follows `TileLayer`'s
 * enrichment contract: `sourceTile` is the tile whose sublayer emitted the
 * event (set on hover-off too), `tile` only on an actual hit. `info.object`
 * — undefined by default for binary data — is filled with the picked
 * feature's properties decoded from the tile's binary columns
 * (see {@link getFeatureProperties} in `@poopdeck.gl/core`).
 */
export interface SpatioTemporalPickingInfo extends PickingInfo {
  /** The picked tile (set only when a feature was hit). */
  tile?: Tile | null;
  /** The tile whose sublayer emitted the picking event. */
  sourceTile?: Tile | null;
}

/**
 * Props every animated sublayer carries so {@link SpatioTemporalLayer.getPickingInfo}
 * can enrich picks — the `tile` name is the TileLayer convention; `sttFeatures`
 * is the (tile, layer) pair's decoded columns. Both are REFERENCES into the
 * prepared-tile cache, never copies.
 */
export interface SttSublayerPickingProps {
  tile?: Tile | null;
  sttFeatures?: BinaryFeatures;
}

/**
 * Props added by {@link SpatioTemporalLayer} (upstream `_XxxLayerProps`
 * convention: own props only — compose with `CompositeLayerProps` via
 * {@link SpatioTemporalLayerProps}).
 *
 * Deliberate difference from upstream: there is NO `DataT` generic. Tiles are
 * binary (Arrow-backed columnar buffers), so there is no per-row datum type
 * for accessors to receive — `data` is always the archive URL string.
 */
export interface _SpatioTemporalLayerProps {
  /** URL to the STT archive. */
  data: string;

  /** Current time to display (Unix milliseconds). */
  currentTime: number;

  /**
   * Time window (milliseconds before and after `currentTime`).
   * @default 86400000
   */
  timeWindow?: number;

  /** Full time range of the dataset. */
  timeRange?: { start: number; end: number } | null;

  /** Optional shared {@link TimeController} for synchronized animation. */
  timeController?: TimeController | null;

  /**
   * Maximum concurrent in-flight HTTP Range requests. Threaded into the
   * archive's range coalescer as its `maxConcurrentRequests` ceiling, so this
   * is the single knob that bounds actual fetch concurrency.
   * @default 24
   */
  maxRequests?: number;

  /**
   * Debounce time for viewport changes in ms (deck.gl `TileLayer` pattern).
   * @default 0
   */
  debounceTime?: number;

  /**
   * Maximum number of tiles to cache.
   * @default 2000
   */
  maxCacheSize?: number;

  /**
   * Maximum cache size in bytes.
   * @default 2147483648 (2 GiB)
   */
  maxCacheByteSize?: number;

  /**
   * Enable predictive prefetching for smooth animation.
   * @default true
   */
  enablePrefetch?: boolean;

  /**
   * How far ahead to prefetch in animation time (milliseconds).
   * @default 30000
   */
  prefetchAhead?: number;

  /**
   * Number of time steps to prefetch ahead.
   * @default 4
   */
  prefetchSteps?: number;

  /**
   * Which tier the tileset draws from when the archive carries a
   * server-aggregated summary tier (`stt-build --summary-tier`):
   * - `'auto'` (default): use the summary tier at zooms inside the tier's
   *   `[minZoom, maxZoom]` band and the raw tier above it — so a wide,
   *   low-zoom view streams a few thousand aggregated cells instead of
   *   millions of raw features (the 100M+ unlock; fixes ship-traffic).
   * - `'summary'`: always use the summary tier.
   * - `'raw'`: always use the raw tier (legacy behaviour; what every layer
   *   did before summary dispatch was wired).
   *
   * Has no effect on archives without a summary tier — the tileset falls
   * back to `'raw'` whenever no summary tier is present in the metadata.
   * @default 'auto'
   */
  tier?: 'auto' | 'summary' | 'raw';

  /**
   * Called when all tiles in the current viewport×window selection have
   * finished loading (the `TileLayer.onViewportLoad` moment), with the
   * loaded tile array. Fires once per selection settle: again only after
   * the selection itself changes (pan/zoom or the time window crossing a
   * bucket) and re-settles — never per tile.
   */
  onViewportLoad?: ((tiles: Tile[]) => void) | null;

  /** Callback when a tile loads. */
  onTileLoad?: ((tile: Tile) => void) | null;

  /** Callback when a tile is evicted from cache. */
  onTileUnload?: ((tile: Tile) => void) | null;

  /**
   * Called when a tile's fetch/decode fails after the loader's retries.
   * Mirrors `TileLayer.onTileError`, plus the failing tile's id as context.
   * Default (null) logs via `console.error`, matching TileLayer.
   */
  onTileError?: ((error: Error, tileId?: TileId) => void) | null;

  /**
   * Fired ONCE per archive/tileset initialization (and again if `data`
   * changes and a new tileset is created), with the live tileset. The tileset
   * satisfies the {@link BufferSource} readiness contract, so apps hand it
   * straight to a `PlaybackGovernor` via `governor.setSource(tileset)`.
   * Mirrors the `onTileLoad` callback pattern.
   */
  onTilesetReady?: ((tileset: SpatiotemporalTileset & BufferSource) => void) | null;

  /**
   * Forwarded from the tileset's buffer bookkeeping: fires when the buffered
   * runway around the playhead crosses a threshold (not per tile load). Apps
   * forward this to `PlaybackGovernor.notifyBufferChange(runway)` so gating
   * reacts immediately instead of waiting for the governor's poll cadence.
   */
  onBufferChange?: ((runway: BufferedRunway) => void) | null;

  /**
   * Overview (storyboard) preview tier — player buffering WS-C4. When truthy,
   * the layer calls `tileset.preloadOverviewTier()` right after tileset init:
   * the coarsest tiles (z0..maxZoom, default 1) across the FULL dataset time
   * range are loaded at the lowest request tier and PINNED, so scrubbing
   * always renders a coarse preview via the parent-zoom fallback — the data
   * analog of a video player's always-resident thumbnail strip. Budget-gated
   * per dataset (default 20 MiB of directory bytes): datasets with giant
   * coarse tiles are rejected without fetching anything. Pass an object to
   * tune `budgetBytes` / `maxZoom`. Init is never blocked on the preload.
   * @default false
   */
  overviewPreload?: boolean | { budgetBytes?: number; maxZoom?: number };

  /**
   * Fired once per tileset init with the overview preload's outcome (loaded,
   * candidate tile count, directory byte sum, and the rejection reason when
   * skipped). Only fires when `overviewPreload` is truthy.
   */
  onOverviewPreload?: ((result: OverviewPreloadResult) => void) | null;

  /**
   * loaders.gl-style options. Only `loadOptions.fetch` is consumed: the
   * OBJECT form (`RequestInit`) is merged into every HTTP request the
   * archive makes (manifest, directory, pack ranges) — auth headers,
   * credentials, CORS mode; per-request fields like the `Range` header
   * always win. A fetch-like FUNCTION replaces the transport instead.
   */
  loadOptions?: SttLoadOptions;

  /**
   * Force a specific zoom level (useful for `GlobeView` to load low-zoom
   * tiles). `null` (default) derives zoom from the viewport.
   */
  zoomOverride?: number | null;

  /** Use global bounds instead of viewport bounds (for `GlobeView`). */
  useGlobalBounds?: boolean;

  /**
   * Time-as-height ("space-time cube"): meters of altitude per simulation
   * millisecond. When non-zero, the trips/path/point layers lift each vertex
   * by `(featureTime - timeHeightOrigin) * timeHeightScale` meters — per-vertex
   * time on trail-mode trips (threads climb along their length, slope = speed),
   * per-feature start time elsewhere. Animating this value morphs between the
   * flat map (0) and the cube. MapView only — the lift is vertical in
   * web-mercator common space.
   * @default 0 (off)
   */
  timeHeightScale?: number;

  /**
   * Absolute time (Unix ms) rendered at altitude 0 in time-as-height mode,
   * typically `timeRange.start`.
   * @default 0
   */
  timeHeightOrigin?: number;
}

/** Complete props accepted by {@link SpatioTemporalLayer}. */
export type SpatioTemporalLayerProps = _SpatioTemporalLayerProps & CompositeLayerProps;

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

const defaultProps: DefaultProps<SpatioTemporalLayerProps> = {
  // Data source
  data: '',

  // Temporal properties
  currentTime: 0,
  timeWindow: 86_400_000, // 1 day
  timeRange: { type: 'object', value: null, optional: true, compare: true },
  timeController: { type: 'object', value: null, optional: true, compare: false },

  // Tile-loading configuration (mirrors deck.gl `TileLayer`).
  // maxRequests is the SINGLE concurrency knob: it's threaded into the
  // archive as `maxConcurrentRequests`, bounding the number of in-flight
  // HTTP Range requests the coalescer opens per batch. Under HTTP/2/3
  // multiplexing to object storage (R2 caps ~75 streams/connection) 24 is
  // the tuned ceiling — high enough to fill a viewport in one round-trip,
  // low enough to stay well under the per-connection stream cap.
  maxRequests: 24,
  debounceTime: 0,
  maxCacheSize: 2000,
  maxCacheByteSize: 2 * 1024 * 1024 * 1024, // 2 GiB

  // Prefetch configuration. Defaults sized for a few real-time seconds of
  // buffer, not minutes — see DemoPage.tsx for the consumer-side math.
  // Overshooting here (the previous defaults were 60s ahead × 15 steps =
  // 15 minutes of lookahead) caused the prefetch queue to balloon and
  // saturated the decode backlog.
  enablePrefetch: true,
  prefetchAhead: 30_000, // 30s of sim time
  prefetchSteps: 4,

  // Summary-tier dispatch: 'auto' transparently swaps to the aggregated
  // tier at low zoom when the archive has one (no-op otherwise).
  tier: 'auto',

  // GlobeView helpers: null/false = derive from the viewport (the default).
  zoomOverride: null,
  useGlobalBounds: false,

  // Time-as-height (space-time cube) — off by default.
  timeHeightScale: 0,
  timeHeightOrigin: 0,

  // Callbacks
  onViewportLoad: { type: 'function', value: null, optional: true },
  onTileLoad: { type: 'function', value: null, optional: true },
  onTileUnload: { type: 'function', value: null, optional: true },
  onTileError: { type: 'function', value: null, optional: true },
  onTilesetReady: { type: 'function', value: null, optional: true },
  onBufferChange: { type: 'function', value: null, optional: true },

  // Storyboard preview tier: opt-in (some datasets fail the byte budget by
  // design — the gate, not the consumer, decides whether anything loads).
  overviewPreload: false,
  onOverviewPreload: { type: 'function', value: null, optional: true },

  // loaders.gl options
  loadOptions: { type: 'object', value: {}, compare: false },
};

/**
 * Base layer for spatiotemporal tile visualization
 *
 * Architecture based on deck.gl TileLayer + loaders.gl:
 * - Separates tile management (Tileset) from data loading (Archive)
 * - Request concurrency control (maxRequests: 24)
 * - Debouncing for smooth viewport changes
 * - LRU cache with size limits
 * - Frame-based rendering optimization
 *
 * Generics follow the upstream extension pattern
 * (`PathLayer<DataT, ExtraPropsT> extends Layer<ExtraPropsT & Required<_PathLayerProps<DataT>>>`)
 * minus the `DataT` parameter — tiles are binary, there is no per-row datum
 * type (see {@link _SpatioTemporalLayerProps}). Third parties subclass via
 * `class My extends SpatioTemporalLayer<MyExtraProps>`, which types
 * `this.props` as `MyExtraProps & Required<_SpatioTemporalLayerProps> &
 * Required<CompositeLayerProps>`.
 */
export class SpatioTemporalLayer<
  ExtraPropsT extends {} = {}
> extends CompositeLayer<ExtraPropsT & Required<_SpatioTemporalLayerProps>> {
  static layerName = 'SpatioTemporalLayer';

  /**
   * deck.gl resolves defaultProps through the props object's prototype
   * chain, so an own key explicitly set to `undefined` SHADOWS its default
   * (`new AnimatedPointLayer({ strokeColor: cfg.strokeColor })` with an
   * absent config field silently disables the default — and downstream the
   * sublayers receive explicit `undefined` accessors, which deck's
   * attribute updater rejects with "accessor is not a function"). Callers
   * build props from optional config fields all the time, so defend the
   * boundary once here: drop explicitly-undefined own keys before deck
   * sees them, making `undefined` mean "use the default" the way every
   * caller already assumes. This is also what makes the `Required<>` props
   * typing above actually true at runtime.
   */
  constructor(...propObjects: any[]) {
    super(
      ...propObjects.map((props) => {
        if (!props || typeof props !== 'object') return props;
        let hasUndefined = false;
        for (const key in props) {
          if (props[key] === undefined) {
            hasUndefined = true;
            break;
          }
        }
        if (!hasUndefined) return props;
        const cleaned: Record<string, unknown> = {};
        for (const key in props) {
          if (props[key] !== undefined) cleaned[key] = props[key];
        }
        return cleaned;
      }),
    );
  }
  
  // Internal time tracking - updated every tick without setState overhead
  // Sublayers read from this via getCurrentTime() method
  protected _currentTime: number = 0;

  // Track last time we updated the tileset to throttle updates
  private _lastTilesetUpdateTime: number = 0;

  // Wall-clock (real-ms) timestamp of the last animation-tick tileset update.
  // The sim-time threshold below (`timeWindow / 20`) is scale-relative, so at
  // high playback speeds (e.g. nyc-taxi-paths ~238×) it is crossed every frame,
  // firing ~60 synchronous selectAndLoadTiles passes/sec on the render thread.
  // This floor caps tick-driven tileset updates to a fixed wall-clock rate so
  // the cadence is playback-speed-invariant; the shader still animates smoothly
  // because every tick calls setNeedsRedraw() and reads time live via getTime().
  private _lastTilesetUpdateWall: number = 0;

  // Wall-clock (real-ms) timestamp of the last VIEWPORT-driven (updateState)
  // tileset reselection, and the handle for the single pending trailing pass.
  // Together they rate-limit pan/zoom/follow-cam reselection to ~10Hz without
  // dropping the final settle position. See MIN_VIEWPORT_TILESET_WALL_MS.
  private _lastViewportSelectWall: number = 0;
  private _viewportSettleTimer: ReturnType<typeof setTimeout> | null = null;

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

  /**
   * Outcome of the storyboard preload (WS-C4) for the LIVE tileset, kept so
   * the perf-probe snapshot can republish it (the one-shot callback may fire
   * before a HUD enables the probe). Reset on re-init.
   */
  private _overviewPreload: OverviewPreloadResult | null = null;

  /**
   * Once-per-settle latch for `onViewportLoad`: the tileset selection
   * version we last fired for. The version advances only when the
   * needed-tile SET changes (never on tile arrival), so "settled at
   * version V" fires exactly once even though we probe from several code
   * paths (updateState, the tile-load rAF, throttled animation ticks).
   * Reset on re-init — a fresh tileset restarts its version counter.
   */
  private _viewportLoadVersion = -1;

  // Upstream idiom: a module-level const typed `DefaultProps<XxxLayerProps>`
  // assigned to the static. The named annotation keeps the emitted .d.ts
  // portable (no inference into transitive deps' types).
  static defaultProps = defaultProps;

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

  finalizeState(context: LayerContext): void {
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
    // Cancel any pending trailing viewport reselection.
    this._clearViewportSettle();

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

    // Lifecycle contract: the base finalizeState still unsubscribes from the
    // resource manager and finalizes internal state even on composites.
    super.finalizeState(context);
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
   *
   * `protected` (not `private`) so subclasses whose per-frame value is a deck.gl
   * sublayer PROP rather than a draw-time uniform can override it. The canonical
   * `HeatmapLayer` is the motivating case: its time window is a `filterRange`
   * prop on a `@deck.gl/aggregation-layers` sublayer, which only re-aggregates
   * when renderLayers() re-runs — so that subclass calls super() here (to keep
   * `_currentTime` live and the tileset throttle intact) and then forces a
   * throttled renderLayers() via `setState`. Layers whose per-frame value is a
   * shader uniform (point/path/trips via TimeFilterExtension) never need to.
   */
  protected _handleTimeUpdate(time: number): void {
    const { tileset } = this.state;
    if (!tileset) return;
    
    // Always update internal time tracking (no setState overhead)
    this._currentTime = time;
    
    // Check if we need to update the tileset (throttled). `timeWindow` is
    // `Required<>`-typed: the default guarantees a value here.
    const timeWindow = this.props.timeWindow;
    const timeDelta = Math.abs(time - this._lastTilesetUpdateTime);
    const updateThreshold = timeWindow / 20; // Update tileset when 5% of time window has passed
    // Wall-clock ceiling: never refresh the tileset more than ~10×/sec from the
    // tick path, regardless of how fast sim-time advances. At 1× playback the
    // sim threshold still governs (100ms wall < timeWindow/20 for any realistic
    // window), so slow scrubbing is unchanged; only fast playback is reined in.
    const MIN_TILESET_UPDATE_WALL_MS = 100;
    const nowWall = performance.now();

    let tilesChanged = false;

    if (
      timeDelta > updateThreshold &&
      nowWall - this._lastTilesetUpdateWall >= MIN_TILESET_UPDATE_WALL_MS
    ) {
      this._lastTilesetUpdateTime = time;
      this._lastTilesetUpdateWall = nowWall;

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
        // Settle check rides the throttled block (≤10 Hz wall), NOT the raw
        // 60 Hz tick — it covers all-cache-hit selections, which never fire
        // onTileLoad and would otherwise only settle on the next updateState.
        this._maybeFireViewportLoad(tileset);
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

      // Tile arrivals are what complete a selection — probe for the
      // viewport-load settle here, once per coalesced batch.
      this._maybeFireViewportLoad(tileset);
    }) as unknown as number;
  }

  /**
   * Fire `onViewportLoad` when the tileset's current selection has settled
   * (the `TileLayer` "all tiles in viewport loaded" moment). Latched on the
   * tileset's selection version so a settled selection fires exactly once,
   * however many code paths probe it; an all-cached selection (version bump
   * with isLoaded already true) fires again, matching upstream semantics.
   * Version 0 means no selection has needed anything yet — firing there
   * would report an empty viewport during init.
   */
  private _maybeFireViewportLoad(tileset: SpatiotemporalTileset): void {
    if (!this.props.onViewportLoad) return;
    const version = tileset.selectionVersion;
    if (version === 0 || version === this._viewportLoadVersion) return;
    if (!tileset.isLoaded) return;
    this._viewportLoadVersion = version;
    this.props.onViewportLoad(tileset.getVisibleTiles());
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
    // TEMP-DIAGNOSTIC (flash repro): record visible-tile set deltas with the
    // sim time at the swap, so removed-before-replaced churn shows up offline.
    {
      const probe = (globalThis as unknown as {
        __sttProbe?: { enabled?: boolean; tileSwaps?: unknown[] };
      }).__sttProbe;
      if (probe?.enabled && Array.isArray(probe.tileSwaps)) {
        const added: string[] = [];
        const removed: string[] = [];
        for (const k of next) if (!this._lastTileIdSet.has(k)) added.push(k);
        for (const k of this._lastTileIdSet) if (!next.has(k)) removed.push(k);
        probe.tileSwaps.push({
          wall: performance.now(),
          sim: this._currentTime,
          count: next.size,
          added,
          removed,
        });
      }
    }
    this._lastTileIdSet = next;
  }

  private _updateTileset(changeFlags: any): void {
    const { tileset } = this.state;
    if (!tileset) return;

    // Throttle the PURE-viewport (pan / zoom / follow-cam) reselection path to
    // a wall-clock floor, mirroring the time-tick path (_handleTimeUpdate). A
    // controlled camera animating at 60fps (AV ego-follow) otherwise drives a
    // full selectAndLoadTiles() on every STT layer every frame. Prop/data
    // changes (timeWindow, tier, style, controller swap) are NEVER throttled —
    // they must reselect immediately. When throttled we still setNeedsRedraw()
    // so the moving viewport draws every frame, and schedule one trailing pass
    // so the settle position reselects when motion stops inside the window.
    const viewportOnly =
      !!(changeFlags && changeFlags.viewportChanged) &&
      !changeFlags.propsChanged &&
      !changeFlags.dataChanged;
    if (viewportOnly) {
      const nowWall = performance.now();
      if (nowWall - this._lastViewportSelectWall < MIN_VIEWPORT_TILESET_WALL_MS) {
        this.setNeedsRedraw();
        this._scheduleViewportSettle();
        return;
      }
    }
    // Running the selection now: it is the latest reselect, and any queued
    // trailing pass is redundant. (Prop-change passes count too, so a viewport
    // frame arriving just after one is correctly throttled.)
    this._lastViewportSelectWall = performance.now();
    this._clearViewportSettle();

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

    this._maybeFireViewportLoad(tileset);

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
      // Storyboard preload outcome (one-shot result, republished each pass so
      // a HUD that enables the probe AFTER the preload still sees it).
      if (this._overviewPreload) {
        snapshot('overview.preload', this._overviewPreload);
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
   * Schedule a single trailing tileset reselection after the viewport throttle
   * window, so a camera that stops moving WITHIN the window still selects tiles
   * for its settled position. During playback the time-tick path already
   * reselects at the settled viewport every ~100ms; this covers a paused
   * drag/zoom, where no tick fires. Re-enters `_updateTileset` with a synthetic
   * viewport change — enough wall time has elapsed that the throttle admits it.
   */
  private _scheduleViewportSettle(): void {
    if (this._viewportSettleTimer !== null) return; // one pending pass at a time
    if (typeof setTimeout !== 'function') return;
    this._viewportSettleTimer = setTimeout(() => {
      this._viewportSettleTimer = null;
      if (this._finalized || !this.state.tileset) return;
      this._updateTileset({ viewportChanged: true, propsChanged: false, dataChanged: false });
    }, MIN_VIEWPORT_TILESET_WALL_MS);
  }

  /** Cancel any pending trailing reselection (a real pass just ran, or finalize). */
  private _clearViewportSettle(): void {
    if (this._viewportSettleTimer !== null) {
      clearTimeout(this._viewportSettleTimer);
      this._viewportSettleTimer = null;
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
    return this.props.timeWindow;
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
        loadOptions: this.props.loadOptions,
        // Single concurrency knob: the tileset's `maxRequests` IS the archive's
        // in-flight Range-request ceiling. Previously the archive used its own
        // default (24) and the layer's `maxRequests` never reached the wire, so
        // setting it had no effect on actual fetch concurrency.
        maxConcurrentRequests: this.props.maxRequests,
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

    // Subclass hook (e.g. H3SummaryLayer fires onMetadataLoad + the
    // no-summary-tier warning here).
    this.onMetadataLoaded(metadata);

    // Summary-tier dispatch. When the archive carries a server-aggregated
    // summary tier, wire the tileset to fall back to it at low zoom so a
    // wide view streams a few thousand aggregated cells instead of millions
    // of raw features. Without this wiring pickTierForZoom always returns
    // 'raw' (the historical gap behind the ship-traffic 49→1 FPS regression).
    const summaryTier = metadata.summaryTier;
    const summaryZoomRange = summaryTier
      ? { minZoom: summaryTier.minZoom, maxZoom: summaryTier.maxZoom }
      : undefined;
    const getAvailableSummaryTiles = summaryTier
      ? (bounds: BoundingBox, zoom: number, timeRange: { start: number; end: number }) =>
          archive.getSummaryTileIdsInBounds(bounds, zoom, timeRange)
      : undefined;

    // Create tileset with archive as data source
    const tileset = new SpatiotemporalTileset({
      maxRequests: this.props.maxRequests,
      debounceTime: this.props.debounceTime,
      maxCacheSize: this.props.maxCacheSize,
      maxCacheByteSize: this.props.maxCacheByteSize,
      minZoom: metadata.minZoom,
      maxZoom: metadata.maxZoom,
      // Use temporal bucket from metadata for deterministic tile loading
      temporalBucketMs: metadata.temporalBucketMs,
      refinementStrategy: 'best-available', // Load parent tiles as fallback (deck.gl pattern)
      // Prefetch configuration for smooth animation playback
      enablePrefetch: this.props.enablePrefetch,
      prefetchAhead: this.props.prefetchAhead,
      prefetchSteps: this.props.prefetchSteps,
      tier: this.props.tier,
      summaryZoomRange,
      getAvailableTiles: (bounds, zoom, timeRange) =>
        archive.getTileIdsInBounds(bounds, zoom, timeRange),
      getAvailableSummaryTiles,
      getTileData: (tileId, signal) => archive.getTile(tileId, { signal }),
      // Route the bulk viewport/prefetch fill through the range coalescer so
      // a viewport-full of Hilbert-adjacent tiles collapses into a handful of
      // HTTP Range requests instead of one request per tile. The hooks carry
      // incremental per-tile delivery (tiles render as their range group
      // lands) and the fetch-priority hint for lookahead tiers.
      getTileDataBatch: (tileIds, signal, hooks) =>
        archive.getTiles(tileIds, {
          signal,
          onTileReady: hooks?.onTileReady,
          fetchPriority: hooks?.fetchPriority,
          // Cross-source EDF (multi-source coordination, Phase 2 §2.8): forward
          // the tileset's play-head time + travel direction so the archive's
          // shared scheduler ranks range-groups by distance-to-playhead
          // comparably ACROSS archives that share this play-head. Without this
          // link the archive falls back to its byte-order / enqueue-order
          // sequence (tier-correct, but not true cross-source EDF).
          playheadTime: hooks?.playheadTime,
          playheadDirection: hooks?.playheadDirection,
        }),
      // Lets the tileset skip giant low-zoom parent-fallback tiles (e.g. a
      // 14 MB z10 tile under a z14 view) before fetching them. Sync directory
      // lookup, no I/O.
      getTileByteSize: (tileId) => archive.getTileByteSize(tileId),
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
        if (this.props.onTileError) {
          this.props.onTileError(error, tileId);
        } else {
          // TileLayer's default: errors surface in the console.
          console.error('[STL] Tile error:', tileId, error);
        }
      },
      // ── Player-buffering plumbing (WS-A/WS-B contract) ──────────────────
      // Buffered-runway threshold events from the tileset's coverage index,
      // forwarded to the app (which routes them into a PlaybackGovernor).
      onBufferChange: (runway: BufferedRunway) => {
        this.props.onBufferChange?.(runway);
      },
      // Wire the archive's coalesced-range throughput EWMA into the tileset
      // so estimateTimeToReadyMs() can compute honest ETAs.
      getThroughput: () => archive.getThroughputEstimate(),
      // Subclass hook: tier-specific tileset config (e.g. H3SummaryLayer's
      // summary-tier zoom range + 'no-overlap' refinement). Spread LAST so
      // overrides win over the base wiring above.
      ...this.getTilesetOptionOverrides(metadata),
    });
    
    if (DEBUG) console.log('[STL] Tileset configured with zoom range:', metadata.minZoom, '-', metadata.maxZoom);
    
    // If time controller is playing, set initial animation state
    if (this.props.timeController?.isPlaying()) {
      tileset.setAnimationState(true, this.props.timeController.getSpeed());
    }

    // A fresh tileset restarts its selection-version counter; carrying the
    // old latch over could silently swallow the new dataset's first
    // onViewportLoad when the counters happen to collide.
    this._viewportLoadVersion = -1;

    // Reset `tiles` to []; this signals subclass renderLayers() that the
    // visible set just collapsed (their lastTilesRef-guarded prune block
    // re-runs, dropping cache entries that referenced the previous
    // archive's tiles). Without this the cache holds stale entries until
    // the natural "different tile key" prune kicks in on the next render.
    this.setState({ archive, tileset, metadata, initializingUrl: null, tiles: [] });

    // Hand the live tileset to the app exactly once per init, after state is
    // committed. The tileset implements the BufferSource readiness contract
    // (runway/cost/ETA queries), which is what a PlaybackGovernor consumes.
    this.props.onTilesetReady?.(tileset as SpatiotemporalTileset & BufferSource);

    // Storyboard tier (WS-C4): kick the budget-gated overview preload WITHOUT
    // blocking init — the fetches ride the lowest request tier behind any
    // viewport work, and the gate may reject the dataset outright (giant
    // coarse tiles) in which case nothing is fetched at all.
    this._overviewPreload = null;
    if (this.props.overviewPreload) {
      const overviewOpts =
        typeof this.props.overviewPreload === 'object'
          ? this.props.overviewPreload
          : undefined;
      tileset.preloadOverviewTier(overviewOpts).then((result) => {
        // Ignore results for a tileset this layer no longer owns (re-init /
        // unmount races) — `clear()` settles those with reason 'disabled'.
        if (this._finalized || this.state.tileset !== tileset) return;
        this._overviewPreload = result;
        this.props.onOverviewPreload?.(result);
      });
    }
  }

  /**
   * Subclass hook, called once per archive init right after metadata arrives
   * (and after the supersession race-guard). Base implementation is a no-op.
   */
  protected onMetadataLoaded(_metadata: ArchiveMetadata): void {}

  /**
   * Subclass hook: partial {@link SpatiotemporalTilesetOptions} spread over
   * the base tileset wiring at construction time (overrides win). Lets a
   * tier-specific subclass (H3SummaryLayer) swap zoom range / refinement
   * strategy without duplicating the whole `_initArchiveAndTileset` plumbing.
   */
  protected getTilesetOptionOverrides(
    _metadata: ArchiveMetadata,
  ): Partial<SpatiotemporalTilesetOptions> {
    return {};
  }

  protected getViewportBounds(viewport: any): BoundingBox {
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

  protected getZoomLevel(viewport: any): number {
    // Use zoomOverride if specified (useful for GlobeView)
    if (this.props.zoomOverride != null) {
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
   * Compose one sublayer's props through deck's standard
   * `CompositeLayer.getSubLayerProps()` so the inherited composite props
   * (opacity, pickable, visible, coordinateSystem, modelMatrix,
   * autoHighlight, highlightColor, wrapLongitude, positionFormat, …) and the
   * user's `_subLayerProps[shortId]` overrides apply. Upstream merge order
   * holds: inherited < `sublayerProps` (ours) < `_subLayerProps[shortId]`
   * (the user's), so a forced value passed in `sublayerProps` beats
   * inheritance but still yields to an explicit user override.
   *
   * `shortId` is the STABLE id `_subLayerProps` / `getSubLayerClass` key on
   * (`'points'`, `'paths'`, …); `instanceKey` (typically the tile key) is
   * appended afterwards so per-tile sublayer ids stay unique AND stable
   * frame-to-frame — id stability is what keys deck's layer matching for the
   * cached-instance optimization.
   *
   * PERF: allocates a fresh props object — call it only from the cache-gated
   * buildSublayer paths, never from a per-frame path that returns cached
   * sublayer instances. The user's `updateTriggers` are forwarded wholesale
   * (the TileLayer pattern); note that any change to the inherited props or
   * `_subLayerProps` must also be folded into the layer's cache digest via
   * `inheritedPropsDigest` or the rebuild never triggers.
   */
  protected composeSubLayerProps(
    shortId: string,
    instanceKey: string,
    sublayerProps: Record<string, any>,
  ): Record<string, any> {
    const props = this.getSubLayerProps({
      id: shortId,
      updateTriggers: this.props.updateTriggers,
      ...sublayerProps,
    } as any) as Record<string, any>;
    props.id = `${props.id}-${instanceKey}`;
    // A `_subLayerProps.<shortId>.extensions` override REPLACES the whole
    // list (deck's merge contract). The internal extensions are load-bearing
    // (time filtering, categorical color, heatmap animation), so an override
    // that drops one silently breaks the layer — surface that instead.
    const intended = sublayerProps.extensions as unknown[] | undefined;
    const overridden = props.extensions as unknown[] | undefined;
    if (intended?.length && overridden !== intended) {
      const missing = intended.filter(
        (e) =>
          !overridden?.some(
            (o) => (o as any)?.constructor === (e as any)?.constructor,
          ),
      );
      if (missing.length > 0) {
        const names = missing
          .map((e) => (e as any)?.constructor?.name ?? 'unknown extension')
          .join(', ');
        warnOnce(
          `${(this.constructor as any).layerName}:${shortId}:extensionsOverride`,
          `[${(this.constructor as any).layerName}] _subLayerProps.${shortId}.extensions ` +
            `replaces the internal extension list and omits: ${names}. Time ` +
            `filtering / categorical color may silently break. To ADD ` +
            `extensions, pass them via the top-level \`extensions\` prop ` +
            `instead — the layer appends them to its internal list.`,
        );
      }
    }
    return props;
  }

  /**
   * Merge the layer's internal extensions (time filter, categorical color, …)
   * with the user's top-level `extensions` prop. `getSubLayerProps` DOES
   * forward `extensions`, but the animated layers pass an explicit list in
   * `sublayerProps` — which beats inheritance — so without this merge a
   * user-supplied extension would be silently dropped. Internal extensions
   * come first so user shader injections compose on top of the time-filter
   * alpha. The merged contents are stable across calls as long as the
   * caller's `extensions` entries compare equal (deck diffs extensions via
   * `LayerExtension.equals`, not reference), preserving the
   * constant-extension-set shader-cache contract documented in
   * animated-trips-layer.ts. Adding/removing a user extension rebuilds the
   * cached sublayers via `extensionsDigest` inside `inheritedPropsDigest`.
   */
  protected composeExtensions(internal: any[]): any[] {
    const user = (this.props as CompositeLayerProps).extensions as
      | any[]
      | undefined;
    if (!user || user.length === 0) return internal;
    return [...internal, ...user];
  }

  /**
   * TileLayer-convention picking enrichment. Every animated sublayer
   * carries its source `tile` plus the (tile, layer) pair's decoded
   * `BinaryFeatures` as `sttFeatures` — references into the prepared-tile
   * cache, never copies. A hit decodes ONE feature's binary columns into a
   * plain `info.object` here, at event rate, so the render path stays free
   * of per-feature objects. Cumulative point slabs (which merge many tiles
   * into one sublayer) resolve through per-tile provenance instead — see
   * `AnimatedPointLayer.getPickingInfo`.
   */
  getPickingInfo({ info, sourceLayer }: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const out = info as SpatioTemporalPickingInfo;
    const sprops = sourceLayer?.props as SttSublayerPickingProps | undefined;
    const tile = sprops?.tile ?? null;
    out.sourceTile = tile;
    if (info.index >= 0 && tile) {
      out.tile = tile;
      // Respect an object a sublayer already resolved (e.g. JS-row
      // sublayers); only binary sublayers leave it undefined.
      if (out.object === undefined && sprops?.sttFeatures) {
        out.object = getFeatureProperties(sprops.sttFeatures, info.index) ?? undefined;
      }
    }
    return out;
  }

  /**
   * Subclasses override this to render actual visualization layers
   */
  renderLayers(): any[] {
    return [];
  }
}




