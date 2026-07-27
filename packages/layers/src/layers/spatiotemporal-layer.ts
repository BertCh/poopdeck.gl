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
  Layer,
  LayerContext,
  PickingInfo,
  UpdateParameters,
} from '@deck.gl/core';
import { STTArchive, getFeatureProperties } from '@poopdeck.gl/core';
import { SpatioTemporalTileset } from '@poopdeck.gl/core';
// The camera→bounds repair every backend shares; see getViewportBounds() and
// docs/roadmap/tile-loading-3d-2026-07.md §4.1.
import { normalizeViewportBounds, boundsFromCorners } from '@poopdeck.gl/core';
// The cost cap on that box; see the `viewportCellBudget` prop and
// docs/roadmap/tile-loading-3d-2026-07.md §4.4.
import {
  fitZoomToCellBudget,
  DEFAULT_VIEWPORT_CELL_BUDGET,
} from '@poopdeck.gl/core';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import type {
  Tile,
  TileId,
  BinaryFeatures,
  BoundingBox,
  ArchiveMetadata,
  OverviewPreloadResult,
  SpatioTemporalTilesetOptions,
  SttLoadOptions,
} from '@poopdeck.gl/core';
import { TimeController } from '@poopdeck.gl/playback';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';
import { snapshot, isProbeEnabled } from '../lib/telemetry.js';
import { warnOnce } from '../lib/log.js';

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
  /**
   * The per-tile sublayer that emitted the picking event (upstream
   * `TileLayerPickingInfo.sourceTileSubLayer`). `_updateAutoHighlight` routes
   * the highlight to THIS sublayer instead of broadcasting it to all of them.
   */
  sourceTileSubLayer?: Layer | null;
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

  /**
   * Widen the window used to SELECT tiles, without widening the window used to
   * RENDER features. Unset (or <= `timeWindow`) means the two are the same.
   *
   * The visible-tile set is refreshed at most once per 100 ms of wall clock, so
   * the tiles it selects have to still contain the playhead 100 ms of sim time
   * later. Datasets whose `timeWindow` is a single animation frame (a baked
   * frame sequence) must set this to a few hundred milliseconds or they render
   * nothing for most of playback — the playhead leaves the selected tiles before
   * the next refresh. Extra resident tiles are cheap: TimeFilterExtension still
   * discards every feature outside `timeWindow`, per feature, not per tile.
   *
   * @default 0 (use `timeWindow`)
   */
  tileLoadTimeWindow?: number;

  /** Full time range of the dataset. */
  timeRange?: { start: number; end: number } | null;

  /** Optional shared {@link TimeController} for synchronized animation. */
  timeController?: TimeController | null;

  /**
   * Level-of-detail composition across zoom levels (threaded to the tileset).
   * - `'parent-fallback'` (default): render the single best zoom; coarser
   *   parents are transient fallbacks dropped once detail streams in.
   * - `'additive'`: render the UNION of zoom levels `[minZoom..cameraZoom]` and
   *   keep every level resident. For ADDITIVE-OCTREE point clouds built with
   *   `stt-build --min-zoom-field=--max-zoom-field=<home_zoom column>`, where
   *   each point lives at exactly one zoom: coarse tiles are a sparse overview,
   *   finer tiles add only the residual, so zooming in streams in detail without
   *   re-fetching the coarse cloud.
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default 'parent-fallback'
   */
  lodMode?: 'parent-fallback' | 'additive';

  /**
   * Maximum concurrent in-flight HTTP Range requests. Threaded into the
   * archive's range coalescer as its `maxConcurrentRequests` ceiling, so this
   * is the single knob that bounds actual fetch concurrency.
   *
   * CONSTRUCTION-ONLY: read once when the archive + tileset are built.
   * Changing it after mount warns and has no effect until `data` changes.
   * @default 24
   */
  maxRequests?: number;

  /**
   * Debounce time for viewport changes in ms (deck.gl `TileLayer` pattern).
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default 0
   */
  debounceTime?: number;

  /**
   * Maximum number of tiles to cache.
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default 2000
   */
  maxCacheSize?: number;

  /**
   * Maximum cache size in bytes.
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default 2147483648 (2 GiB)
   */
  maxCacheByteSize?: number;

  /**
   * Enable predictive prefetching for smooth animation.
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default true
   */
  enablePrefetch?: boolean;

  /**
   * How far ahead to prefetch in animation time (milliseconds).
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default 30000
   */
  prefetchAhead?: number;

  /**
   * Number of time steps to prefetch ahead.
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
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
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Toggling the tier
   * after mount warns and has no effect until `data` changes.
   * @default 'auto'
   */
  tier?: 'auto' | 'summary' | 'raw';

  /**
   * Scrub-time LOD degradation (docs/roadmap/playback-and-loading.md): while
   * the user drags the timeline (the PlaybackGovernor's beginScrub…endScrub
   * bracket, broadcast to the tileset via `setInteractive`), tile SELECTION
   * may degrade to a cheaper "motion tier":
   * - `spatial`: request a coarser zoom (`spatialZoomDrop` levels, default 2)
   *   — usually tiles the parent-fallback path already fetched.
   * - `temporal`: route selection through the archive's temporal-LOD
   *   pyramid (requires an archive built with `--temporal-lod`; silently
   *   no-ops otherwise).
   * The degraded tier is preview-only: buffered-runway/gate math and
   * prefetch keep tracking the fine tier, and release restores it.
   * `null`/absent (default) is the kill switch — behavior is identical to
   * today, scrub state is stored but changes nothing.
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default null
   */
  scrubLod?: {
    spatial?: boolean;
    spatialZoomDrop?: number;
    temporal?: boolean;
  } | null;

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
   * `tileId` is `undefined` for DATASET-level failures (a tile-selection
   * pass that could not query the directory — e.g. a transient paged-leaf
   * fetch failure), which have no single failing tile.
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
  onTilesetReady?:
    | ((tileset: SpatioTemporalTileset & BufferSource) => void)
    | null;

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
   *
   * CONSTRUCTION-ONLY: read once when the archive is built. Changing it after
   * mount warns and has no effect until `data` changes.
   */
  loadOptions?: SttLoadOptions;

  /**
   * Tile refinement strategy (deck.gl TileLayer vocabulary).
   *
   * - `'best-available'` (default): also fetch parent tiles up to 4 zooms
   *   below the viewport zoom so the map shows coarse data while the primary
   *   tiles stream, dropping each parent once its in-viewport children load.
   * - `'no-overlap'`: fetch EXACTLY the viewport zoom. The right choice for
   *   full-duplication archives (the no-thinning default bakes every feature
   *   into every zoom level), where each parent level is a complete extra
   *   copy of the visible data — 4 fallback levels ≈ 5× the fetch, decode
   *   and vertex load for zero information gain. Costs the coarse-first-paint
   *   fallback: tiles are blank until their own zoom level arrives.
   *
   * CONSTRUCTION-ONLY: read once when the tileset is built. Changing it after
   * mount warns and has no effect until `data` changes.
   * @default 'best-available'
   */
  refinementStrategy?: 'best-available' | 'no-overlap';

  /**
   * Force a specific zoom level (useful for `GlobeView` to load low-zoom
   * tiles). `null` (default) derives zoom from the viewport.
   */
  zoomOverride?: number | null;

  /** Use global bounds instead of viewport bounds (for `GlobeView`). */
  useGlobalBounds?: boolean;

  /**
   * Vertical extent of the RENDERED content, `[minMeters, maxMeters]` above
   * the ellipsoid — upstream `TileLayer.zRange`, and used for the same thing:
   * the viewport box becomes the union of the frustum's footprint on the
   * ground plane and on the plane at the top of the content, exactly as deck's
   * own `Tileset2D.getBoundingBox` unions them.
   *
   * Only content lifted off the ground needs it: an extruded/volumetric layer
   * (`storm-4d`, `earthquake-columns`) or time-as-height mode draws geometry
   * whose screen position comes from a plane ABOVE `z = 0`, so under pitch the
   * tiles that own that geometry can sit outside the ground-plane box — the
   * near edge of a pitched frame loses about half a tile row of anvil.
   *
   * Named for deck's prop rather than `elevationRange` on purpose:
   * `AnimatedHexagonLayer` already carries an `elevationRange`, deck's
   * `HexagonLayer` meaning ("elevation scale OUTPUT range", default
   * `[0, 1000]`), and a chassis prop of that name would silently read a
   * subclass's aggregation setting as a camera altitude slab.
   *
   * `null` (the default) means the ground plane only. NOTHING is derived
   * automatically, deliberately: the obvious candidate — `timeHeightScale` ×
   * the dataset's time span — is wrong under the DEFAULT `timeHeightOrigin:
   * null`, where altitude 0 is anchored per TILE (at each tile's own
   * `timeOffset`) rather than dataset-wide, and an over-large slab does real
   * damage (`getBounds({z: 1e7})` reports a near-global box and selects
   * accordingly). A wrong guess here is not conservative, so the value is the
   * app's to state.
   *
   * Cheap: at pitch 60 / z8 the `z = 0` and `z = 15000` boxes differ by
   * 0.3–0.6%, so this is a correctness completion rather than a hot path.
   * Requires a viewport that exposes `getBounds({z})` (every deck `Viewport`
   * does); ignored on the `unproject` fallback path.
   * @default null (ground plane only)
   */
  zRange?: [number, number] | null;

  /**
   * Cap on the number of tile CELLS the viewport box may enumerate at the
   * selected zoom. Once the box exceeds it, the zoom steps down (never below
   * the archive's `minZoom`) until it fits.
   *
   * This is the cost half of the 3D tile-selection work, and it does NOT walk
   * back its correctness half: `docs/roadmap/tile-loading-3d-2026-07.md` §4.4
   * rules that tile counts must be allowed to RISE under pitch, because the
   * old two-corner footprint was a 36%-coverage under-selection. They still
   * do. But an axis-aligned box around a strongly pitched frustum degrades
   * non-linearly — at pitch 85 / z8 it enumerates 832 cells where a flat
   * camera at the same zoom enumerates ~12, nearly all of them in the horizon
   * band that occupies a few screen rows. Dropping one integer zoom quarters
   * that while still covering the whole frame, and on a full-duplication
   * archive (the no-thinning default) the coarser tile carries the same
   * features at a coarser simplification rather than fewer of them.
   *
   * Note what this is NOT: a cap on the tile LIST. Truncating an enumeration
   * leaves on-screen tiles unfetched, which is the blank-region symptom the
   * whole roadmap exists to remove. The selection stays complete; only its
   * resolution drops.
   *
   * Inert below roughly pitch 65 at every zoom (tile counts on screen are
   * zoom-invariant), so most apps never reach it. `Infinity` disables it
   * outright; `useGlobalBounds` and `zoomOverride` bypass it, both being
   * explicit instructions about what to load.
   * @default 256
   */
  viewportCellBudget?: number;

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
   *
   * `null` (the default) anchors altitude 0 at each tile's own `timeOffset`,
   * which is what keeps the lift representable: the shader computes
   * `(heightTime - heightOrigin)` in FLOAT32, so an origin far from the tile's
   * times destroys the difference. A literal `0` is the Unix epoch — ~1.7e12 ms
   * away, where the f32 ULP is ~131 s — and is therefore treated as "unset"
   * rather than honoured; passing it would collapse every feature within ~131 s
   * to one altitude and lift the layer ~8.6e10 m off-planet.
   * {@link import('../extensions/time-filter-extension.js').TimeFilterExtension}
   * warns once when the resolved origin costs more than a metre of resolution.
   *
   * @default null (anchor at the tile's `timeOffset`)
   */
  timeHeightOrigin?: number | null;
}

/** Complete props accepted by {@link SpatioTemporalLayer}. */
export type SpatioTemporalLayerProps = _SpatioTemporalLayerProps &
  CompositeLayerProps;

/**
 * Layer state. EVERYTHING the layer's lifecycle depends on lives here rather
 * than in class fields, because deck's `Layer._transferState`
 * (`@deck.gl/core/src/lib/layer.ts`) moves ONLY `state` / `internalState` onto
 * the new instance React hands it every render — class-field initializers
 * re-run on that new instance, while the closures created in
 * `initializeState` / `_initArchiveAndTileset` still capture the FIRST one.
 * Guards split across two instances are not guards: deck would finalize the
 * NEWEST layer (setting its `finalized`) while an awaiting init continuation
 * read the OLD layer's `finalized === false` and attached a fresh
 * archive/tileset — leaking the decoder worker pool, OPFS handles and every
 * in-flight range request. One shared object, one truth.
 */
interface SpatioTemporalLayerState {
  archive: STTArchive | null;
  tileset: SpatioTemporalTileset | null;
  metadata: ArchiveMetadata | null;
  tiles: Tile[];
  /**
   * LIVE play-head (Unix ms), mirrored by the `_currentTime` accessor. Written
   * directly (not via `setState`) on the tick path so a time-only change costs
   * a `setNeedsRedraw()` instead of a full `renderLayers()`.
   */
  currentTime: number;
  /**
   * LAYER-OWNED monotonic render epoch — the single authority behind every
   * "the visible data changed, re-run renderLayers()" decision. Bump it by
   * `+1` (never assign a tileset-derived value); subclasses that force a
   * re-aggregate on the tick path (`AnimatedHeatmapLayer`,
   * `AnimatedHexagonLayer`) already follow that contract.
   */
  frameNumber?: number;
  /**
   * Mirror of the tileset's OWN frame counter as last observed from
   * `tileset.update()`. Only used to detect "the tileset saw a change";
   * keeping it separate from {@link frameNumber} is what stops the two
   * counters from drifting and making `frameChanged` spuriously true.
   */
  tilesetFrameNumber?: number;
  playStateHandler?: (playing: boolean, speed: number) => void;
  tickHandler?: (time: number) => void;
  /**
   * The controller the layer is currently subscribed to, resolved from the
   * `timeController` prop OR `context.userData.stt.timeController`. Kept in
   * state so subscribe/unsubscribe keys off the resolved value, not the prop.
   */
  resolvedTimeController?: TimeController | null;
  /** Tracks the URL whose archive init is currently in flight, to avoid racing duplicate inits. */
  initializingUrl?: string | null;

  // ── Lifecycle bookkeeping (mirrored by the `_`-prefixed accessors) ────────
  /** Sim time of the last tileset reselection (drives the tick-path throttle). */
  lastTilesetUpdateTime?: number;
  /** Wall clock of the last tick-driven tileset reselection. */
  lastTilesetUpdateWall?: number;
  /** Wall clock of the last VIEWPORT-driven tileset reselection. */
  lastViewportSelectWall?: number;
  /** Handle of the single pending trailing viewport-settle pass. */
  viewportSettleTimer?: ReturnType<typeof setTimeout> | null;
  /** rAF handle coalescing per-tile `onTileLoad` state updates. */
  tileLoadRafId?: number | null;
  /** Tile-ID set from the last `_tilesChanged` comparison. */
  lastTileIdSet?: Set<string>;
  /** Viewport identity the cached bounds were computed for. */
  lastBoundsKey?: string;
  /** Cached viewport bounds for {@link lastBoundsKey}. */
  cachedBounds?: BoundingBox | null;
  /** Set by `finalizeState`; every async continuation checks it before touching state. */
  finalized?: boolean;
  /** Outcome of the storyboard preload for the LIVE tileset (republished to the probe). */
  overviewPreloadResult?: OverviewPreloadResult | null;
  /** Once-per-settle latch: the tileset selection version `onViewportLoad` last fired for. */
  viewportLoadVersion?: number;
}

const defaultProps: DefaultProps<SpatioTemporalLayerProps> = {
  // Data source
  data: '',

  // Temporal properties
  currentTime: 0,
  timeWindow: 86_400_000, // 1 day
  tileLoadTimeWindow: 0, // 0 = follow timeWindow
  timeRange: { type: 'object', value: null, optional: true, compare: true },
  timeController: {
    type: 'object',
    value: null,
    optional: true,
    compare: false,
  },
  lodMode: 'parent-fallback',

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

  // Scrub-time LOD degradation: off (the kill switch) until browser-verified
  // on the heavy demos — see docs/roadmap/playback-and-loading.md §7.
  scrubLod: { type: 'object', value: null, optional: true, compare: true },

  // Parent-fallback fetch policy; 'no-overlap' for full-duplication archives
  // (see the prop docs).
  refinementStrategy: 'best-available',

  // GlobeView helpers: null/false = derive from the viewport (the default).
  zoomOverride: null,
  useGlobalBounds: false,

  // Altitude slab the viewport box is dilated over (upstream's `zRange`).
  // `compare: true` so an app re-creating the literal `[0, 15000]` every
  // render is a no-op rather than a fresh reference that invalidates the
  // bounds cache every frame.
  zRange: { type: 'array', value: null, optional: true, compare: true },

  // Cell cap that turns an over-wide pitched viewport box into one coarser
  // zoom instead of hundreds of fetches (see the prop docs). `Infinity` off.
  viewportCellBudget: DEFAULT_VIEWPORT_CELL_BUDGET,

  // Time-as-height (space-time cube) — off by default. The origin is `null`,
  // not `0`: see the prop docs — `0` is the Unix epoch and is f32-unrepresentable
  // as an offset from a tile's times.
  timeHeightScale: 0,
  timeHeightOrigin: null,

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
  ExtraPropsT extends {} = {},
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

  /**
   * Fallback store for the lifecycle accessors below while `this.state` does
   * not exist yet — the window between construction and `initializeState`,
   * and the `Object.create(Layer.prototype)` harness the unit tests drive.
   * Once state IS available it always wins, so a value written before state
   * existed stays readable afterwards (the tests set fields, then state).
   */
  private _detachedLifecycle?: Record<string, unknown>;

  /**
   * Read one lifecycle field, preferring `this.state` (the object deck
   * transfers between layer instances) and falling back to the detached bag.
   * See {@link SpatioTemporalLayerState} for why none of these may live in
   * class fields.
   */
  private _lcRead<T>(key: string, fallback: T): T {
    const state = this.state as Record<string, unknown> | undefined;
    const live = state?.[key];
    if (live !== undefined) return live as T;
    const detached = this._detachedLifecycle?.[key];
    return detached !== undefined ? (detached as T) : fallback;
  }

  /** Write one lifecycle field. Mirror of {@link _lcRead}. */
  private _lcWrite(key: string, value: unknown): void {
    const state = this.state as Record<string, unknown> | undefined;
    if (state) {
      state[key] = value;
      return;
    }
    (this._detachedLifecycle ??= {})[key] = value;
  }

  /**
   * Slots built before deck installed `this.state` (the class-field window
   * between construction and `initializeState`, and the
   * `Object.create(Layer.prototype)` unit-test harnesses, which never create a
   * state at all). Adopted into `state` the moment one exists, so nothing
   * prepared in that window is lost.
   *
   * Sibling of {@link _detachedLifecycle}: that one backs the named lifecycle
   * scalars above, this one backs subclass-owned composite caches.
   */
  private _detachedSlots: Record<string, unknown> | undefined;

  /**
   * Read-or-create a named slot on `this.state`.
   *
   * Anything a subclass would otherwise hold in a class FIELD across frames
   * belongs here: deck's `_transferState` moves `state`/`internalState` to the
   * new instance but re-runs field initializers, so a field-held cache is
   * silently discarded whenever the app hands deck a freshly-constructed layer
   * (an unmemoized `new AnimatedTripsLayer({...})` inside a React render is the
   * usual way this happens).
   *
   * Lives on the chassis rather than in each subclass because the state object
   * deck transfers is the chassis's — `declare state` above already carries the
   * `[key: string]: unknown` index signature that makes an arbitrary slot key
   * legal. Subclasses only choose the key and the factory.
   */
  protected stateSlot<T>(key: string, create: () => T): T {
    const state = this.state as Record<string, unknown> | undefined | null;
    if (!state) {
      const detached = (this._detachedSlots ??= {});
      if (detached[key] === undefined) detached[key] = create();
      return detached[key] as T;
    }
    if (state[key] === undefined) {
      state[key] = this._detachedSlots?.[key] ?? create();
      if (this._detachedSlots) delete this._detachedSlots[key];
    }
    return state[key] as T;
  }

  // Internal time tracking - updated every tick without setState overhead.
  // Sublayers read from this via getCurrentTime(). Backed by
  // `state.currentTime` so the value survives deck's `_transferState` — a
  // class field would be reset to 0 on the instance React renders next while
  // the TimeController's tick closure kept writing to the previous one.
  protected get _currentTime(): number {
    return this._lcRead('currentTime', 0);
  }
  protected set _currentTime(value: number) {
    this._lcWrite('currentTime', value);
  }

  // Track last time we updated the tileset to throttle updates
  private get _lastTilesetUpdateTime(): number {
    return this._lcRead('lastTilesetUpdateTime', 0);
  }
  private set _lastTilesetUpdateTime(value: number) {
    this._lcWrite('lastTilesetUpdateTime', value);
  }

  // Wall-clock (real-ms) timestamp of the last animation-tick tileset update.
  // The sim-time threshold below (`timeWindow / 20`) is scale-relative, so at
  // high playback speeds (e.g. nyc-taxi-paths ~238×) it is crossed every frame,
  // firing ~60 synchronous selectAndLoadTiles passes/sec on the render thread.
  // This floor caps tick-driven tileset updates to a fixed wall-clock rate so
  // the cadence is playback-speed-invariant; the shader still animates smoothly
  // because every tick calls setNeedsRedraw() and reads time live via getTime().
  private get _lastTilesetUpdateWall(): number {
    return this._lcRead('lastTilesetUpdateWall', 0);
  }
  private set _lastTilesetUpdateWall(value: number) {
    this._lcWrite('lastTilesetUpdateWall', value);
  }

  // Wall-clock (real-ms) timestamp of the last VIEWPORT-driven (updateState)
  // tileset reselection, and the handle for the single pending trailing pass.
  // Together they rate-limit pan/zoom/follow-cam reselection to ~10Hz without
  // dropping the final settle position. See MIN_VIEWPORT_TILESET_WALL_MS.
  private get _lastViewportSelectWall(): number {
    return this._lcRead('lastViewportSelectWall', 0);
  }
  private set _lastViewportSelectWall(value: number) {
    this._lcWrite('lastViewportSelectWall', value);
  }

  private get _viewportSettleTimer(): ReturnType<typeof setTimeout> | null {
    return this._lcRead('viewportSettleTimer', null);
  }
  private set _viewportSettleTimer(
    value: ReturnType<typeof setTimeout> | null,
  ) {
    this._lcWrite('viewportSettleTimer', value);
  }

  // rAF handle for coalescing onTileLoad setState calls. Many tiles can
  // finish loading within one frame; batching avoids one full
  // renderLayers()/buildConsolidatedData() rebuild per tile. Shared through
  // state so `finalizeState` on ANY instance cancels the pending callback.
  private get _tileLoadRafId(): number | null {
    return this._lcRead('tileLoadRafId', null);
  }
  private set _tileLoadRafId(value: number | null) {
    this._lcWrite('tileLoadRafId', value);
  }

  /**
   * Snapshot of the tile-ID set from the last `_tilesChanged` comparison.
   * Set MEMBERSHIP is the authoritative signal: the tileset re-prioritises
   * its visible-tile array, so a reordered-but-identical array must NOT count
   * as a change — comparing order or array identity spins up a spurious
   * setState on every frame the priority ordering shifts.
   */
  private get _lastTileIdSet(): Set<string> {
    const existing = this._lcRead<Set<string> | undefined>(
      'lastTileIdSet',
      undefined,
    );
    if (existing) return existing;
    const fresh = new Set<string>();
    this._lcWrite('lastTileIdSet', fresh);
    return fresh;
  }
  private set _lastTileIdSet(value: Set<string>) {
    this._lcWrite('lastTileIdSet', value);
  }

  /**
   * Last viewport (id, zoom, width, height) we computed bounds for.
   * Lets `_updateTileset` skip `viewport.unproject()` on the steady-state
   * 60 Hz path where the viewport hasn't actually moved.
   */
  private get _lastBoundsKey(): string {
    return this._lcRead('lastBoundsKey', '');
  }
  private set _lastBoundsKey(value: string) {
    this._lcWrite('lastBoundsKey', value);
  }

  private get _cachedBounds(): BoundingBox | null {
    return this._lcRead('cachedBounds', null);
  }
  private set _cachedBounds(value: BoundingBox | null) {
    this._lcWrite('cachedBounds', value);
  }

  /**
   * Zoom {@link getZoomLevel} returned last frame, the memory the cell
   * budget's hysteresis band needs (see `fitZoomToCellBudget`). Lives in the
   * lifecycle bag rather than a class field for the usual reason: deck's
   * `_transferState` re-runs field initializers, and a reset here would let
   * the zoom flap for one frame on every unmemoized re-render.
   *
   * `null` means "no previous decision" and is the honest first-frame value —
   * it can only ever RELAX the band, never select a zoom above the camera's.
   */
  private get _budgetZoom(): number | null {
    return this._lcRead<number | null>('budgetZoom', null);
  }
  private set _budgetZoom(value: number | null) {
    this._lcWrite('budgetZoom', value);
  }

  /**
   * Set once `finalizeState` runs, so an in-flight `_initArchiveAndTileset`
   * await that resolves AFTER the layer is gone can bail before attaching
   * a fresh archive/tileset to dead state. Without this, a fast
   * dataset-switch leaks the archive that was racing to come online — and
   * because deck finalizes the NEWEST instance while the continuation holds
   * the OLD one, the flag only works when it lives in the shared state.
   */
  private get _finalized(): boolean {
    return this._lcRead('finalized', false);
  }
  private set _finalized(value: boolean) {
    this._lcWrite('finalized', value);
  }

  /**
   * Outcome of the storyboard preload (WS-C4) for the LIVE tileset, kept so
   * the perf-probe snapshot can republish it (the one-shot callback may fire
   * before a HUD enables the probe). Reset on re-init.
   */
  private get _overviewPreload(): OverviewPreloadResult | null {
    return this._lcRead('overviewPreloadResult', null);
  }
  private set _overviewPreload(value: OverviewPreloadResult | null) {
    this._lcWrite('overviewPreloadResult', value);
  }

  /**
   * Once-per-settle latch for `onViewportLoad`: the tileset selection
   * version we last fired for. The version advances only when the
   * needed-tile SET changes (never on tile arrival), so "settled at
   * version V" fires exactly once even though we probe from several code
   * paths (updateState, the tile-load rAF, throttled animation ticks).
   * Reset on re-init — a fresh tileset restarts its version counter.
   */
  private get _viewportLoadVersion(): number {
    return this._lcRead('viewportLoadVersion', -1);
  }
  private set _viewportLoadVersion(value: number) {
    this._lcWrite('viewportLoadVersion', value);
  }

  // Upstream idiom: a module-level const typed `DefaultProps<XxxLayerProps>`
  // assigned to the static. The named annotation keeps the emitted .d.ts
  // portable (no inference into transitive deps' types).
  static defaultProps = defaultProps;

  declare state: SpatioTemporalLayerState & { [key: string]: unknown };

  /**
   * The {@link TimeController} driving this layer's playhead. Resolution order:
   *  1. the explicit `timeController` prop (back-compat + standalone use);
   *  2. an app-global controller mirrored onto deck's shared layer context as
   *     `context.userData.stt.timeController` — the idiomatic deck channel for
   *     pushing one value to every layer with no per-layer wiring (the same
   *     mechanism `context.viewport`/`context.timeline` ride). This lets new
   *     layers "see" time for free once the host sets `userData`.
   * Returns null for static, non-animated use.
   */
  protected _resolveTimeController(
    context: LayerContext = this.context,
  ): TimeController | null {
    if (this.props.timeController) return this.props.timeController;
    const userData = context?.userData as
      | { stt?: { timeController?: TimeController | null } }
      | undefined;
    return userData?.stt?.timeController ?? null;
  }

  initializeState(context: LayerContext): void {
    // Initialize internal time tracking. These are `state` writes (see the
    // accessors above), so `this.state` — assigned by deck right before this
    // hook — is already live.
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

    // Resolve the controller now (prop, else the app-global one on
    // context.userData) and key the subscription lifecycle off the resolved
    // value rather than the prop.
    const timeController = this._resolveTimeController(context);

    this.setState({
      archive: null,
      tileset: null,
      metadata: null,
      tiles: [],
      currentTime: this.props.currentTime,
      finalized: false,
      playStateHandler,
      tickHandler,
      resolvedTimeController: timeController,
    });

    // Subscribe to time controller events if one was resolved
    if (timeController) {
      timeController.on('playState', playStateHandler);
      timeController.on('tick', tickHandler);
    }

    // Initialize archive and tileset.
    this._startArchiveInit();
  }

  /**
   * Kick `_initArchiveAndTileset` such that nothing can escape as an unhandled
   * promise rejection. The init routes its OWN failures (404 / CORS / corrupt
   * manifest) to `props.onTileError`; this net only fires when that handler
   * itself throws. `Promise.resolve()` wraps the result so a subclass or test
   * that overrides the method synchronously still works.
   */
  private _startArchiveInit(): void {
    Promise.resolve(this._initArchiveAndTileset()).catch((error) => {
      console.error('[STL] Archive initialization handler threw:', error);
    });
  }

  finalizeState(context: LayerContext): void {
    this._finalized = true;
    // Cancel the pending coalesced tile-load rAF and trailing viewport-settle
    // timer — both capture/target the tileset being torn down.
    this._cancelPendingUpdates();

    // Unsubscribe from the controller we actually subscribed to (resolved from
    // prop or context.userData), not the prop alone.
    const resolved = this.state.resolvedTimeController;
    if (resolved) {
      if (this.state.playStateHandler) {
        resolved.off('playState', this.state.playStateHandler);
      }
      if (this.state.tickHandler) {
        resolved.off('tick', this.state.tickHandler);
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
    // Null the handles so every "is the tileset still mine?" bail-out (the
    // settle timer, the tile-load rAF, the overview-preload continuation)
    // reads a dead slot rather than a finalized object. `state` is shared with
    // any instance deck transferred it to, so this is authoritative.
    this.state.tileset = null;
    this.state.archive = null;
    this.state.initializingUrl = null;

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
    const { changeFlags } = params;
    const propsChanged = changeFlags.propsChanged;
    // Race guard: `_initArchiveAndTileset` is async, so during the first
    // window after `initializeState` both `state.archive` and
    // `state.initializingUrl` describe what's coming. We treat the URL as
    // unchanged if either the live archive or an in-flight init already
    // matches it — without that check, the first `updateState` after init
    // (where `state.archive` is still null) re-fires `_initArchiveAndTileset`
    // and we get two parallel archive setups racing to attach workers.
    const liveUrl =
      this.state.archive?.url ?? this.state.initializingUrl ?? null;
    // `changeFlags.dataChanged` is NOT redundant with `propsChanged`: deck's
    // `diffProps` runs `compareProps` with `ignoreProps: {data: null, …}`
    // (@deck.gl/core/src/lifecycle/props.ts), so swapping ONLY the archive URL
    // never sets `propsChanged` — it surfaces exclusively as `dataChanged`.
    // Gating on `propsChanged` alone meant a `data`-only swap kept serving the
    // previous archive forever. Both flags also gate a RETRY after a failed
    // init (which clears `initializingUrl`), so a broken manifest re-attempts
    // on the next real prop/data change instead of on every viewport frame.
    const dataChanged =
      (!!propsChanged || !!changeFlags.dataChanged) &&
      this.props.data !== liveUrl;

    // Handle TimeController changes. Resolution is prop → context.userData, so
    // a change can come from the prop OR — when some other prop change drives
    // this updateState — from a swapped app-global controller on userData. (A
    // userData swap alone does not trigger updateState, since userData lives on
    // the shared context and isn't diffed per-layer; the prop path covers
    // dynamic swaps, and in practice the controller reference is stable.)
    const prevController = this.state.resolvedTimeController ?? null;
    const nextController = this._resolveTimeController();
    if (prevController !== nextController) {
      // Unsubscribe from old controller
      if (prevController) {
        if (this.state.playStateHandler) {
          prevController.off('playState', this.state.playStateHandler);
        }
        if (this.state.tickHandler) {
          prevController.off('tick', this.state.tickHandler);
        }
      }
      // Subscribe to new controller
      if (nextController) {
        if (this.state.playStateHandler) {
          nextController.on('playState', this.state.playStateHandler);
        }
        if (this.state.tickHandler) {
          nextController.on('tick', this.state.tickHandler);
        }
        // Sync current animation state
        const { tileset } = this.state;
        if (tileset) {
          tileset.setAnimationState(
            nextController.isPlaying(),
            nextController.getSpeed(),
          );
        }
      }
      this.setState({ resolvedTimeController: nextController });
    }

    if (dataChanged) {
      // Reinitialize with new data source.
      this._startArchiveInit();
      return;
    }

    // Re-push the mutable tileset options, exactly as upstream `TileLayer`
    // does. Cheap when nothing changed: `setOptions` re-normalizes and only
    // reselects / re-evicts / re-anchors prefetch for the keys that actually
    // moved.
    if (propsChanged) this._pushTilesetOptions();

    // Following deck.gl TileLayer pattern:
    // Always update tileset on any change (viewport, props, etc)
    // The tileset itself will detect what changed and update accordingly
    this._updateTileset(changeFlags);
  }

  /**
   * Re-push the mutable tileset options against the live tileset, mirroring
   * upstream `TileLayer.updateState`'s `tileset.setOptions(...)` call.
   *
   * Ten of the eleven knobs ride `SpatioTemporalTileset.setOptions`, which
   * re-derives rather than merely reassigns — a `tier`/`lodMode`/
   * `refinementStrategy` change reselects, a lowered cache bound evicts down to
   * it immediately, and a prefetch change re-anchors the runway. `maxRequests`
   * additionally reaches the archive's range coalescer through the
   * `setMaxConcurrentRequests` callback wired by `makeTilesetCallbacks`.
   *
   * `loadOptions` is the exception: it is an `STTArchive` construction option
   * (it builds the fetch transport), not a tileset option, so it cannot ride
   * `setOptions` and goes straight to the archive. `setLoadOptions` re-derives
   * `fetchFn` from the archive's retained base transport, so a rotated auth
   * header REPLACES the previous wrapper rather than stacking another layer of
   * interception on every request.
   *
   * The subclass overrides are re-applied on top, exactly as construction
   * spreads them last. Without that, the FIRST `propsChanged` pass — any prop,
   * including one this bag does not even carry — silently reverted
   * `H3SummaryLayer`/`QuadbinSummaryLayer` from the summary tier's
   * `'no-overlap'` back to the base `refinementStrategy`, and from the summary
   * tier's zoom band back to the raw tier's, because `setOptions` treats every
   * key PRESENT in the bag as an instruction.
   */
  private _pushTilesetOptions(): void {
    const { tileset, archive, metadata } = this.state;
    // Nothing live yet (or an init still in flight) — the pending build reads
    // the current props directly, so there is nothing to re-push.
    if (!tileset || this.state.initializingUrl) return;

    const options: Partial<SpatioTemporalTilesetOptions> = {
      tier: this.props.tier,
      refinementStrategy: this.props.refinementStrategy ?? 'best-available',
      lodMode: this.props.lodMode,
      maxCacheSize: this.props.maxCacheSize,
      maxCacheByteSize: this.props.maxCacheByteSize,
      maxRequests: this.props.maxRequests,
      debounceTime: this.props.debounceTime,
      enablePrefetch: this.props.enablePrefetch,
      prefetchAhead: this.props.prefetchAhead,
      prefetchSteps: this.props.prefetchSteps,
      scrubLod: this.props.scrubLod ?? undefined,
    };

    tileset.setOptions(
      metadata
        ? { ...options, ...this.getTilesetOptionOverrides(metadata) }
        : options,
    );

    archive?.setLoadOptions(this.props.loadOptions);
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
   *
   * SUBCLASS CONTRACT: `state.frameNumber` is a LAYER-OWNED monotonic render
   * epoch. Force a `renderLayers()` by bumping it — `setState({ frameNumber:
   * (this.state.frameNumber || 0) + 1 })` — and never assign a value derived
   * from the tileset. (The tileset's own counter is mirrored separately in
   * `state.tilesetFrameNumber`; mixing the two is what used to make
   * `frameChanged` spuriously true and cost an extra full render per tick.)
   */
  protected _handleTimeUpdate(time: number): void {
    const { tileset } = this.state;
    if (!tileset) return;

    // Always update internal time tracking (no setState overhead)
    this._currentTime = time;

    // Check if we need to update the tileset (throttled). Use the LOAD window,
    // not the render window: what matters here is how much of the timeline the
    // selected tiles cover, which must outlast MIN_TILESET_UPDATE_WALL_MS of
    // playhead travel. See getEffectiveTimeWindow().
    const timeWindow = this.getEffectiveTimeWindow();
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

        // Update tileset - this triggers prefetch for upcoming tiles.
        // Its return value is the TILESET's own frame counter; mirror it so
        // the next `_updateTileset` doesn't read a stale value and declare a
        // spurious `frameChanged`.
        const tilesetFrameNumber = tileset.update(
          {
            bounds,
            zoom,
            time,
            timeWindow,
          },
          true,
        ); // skipDebounce = true for animation

        // Check if tiles actually changed
        const newTiles = tileset.getVisibleTiles();
        if (this._tilesChanged(newTiles)) {
          // Tiles changed - use setState (this will trigger full update cycle)
          this.setState({
            tiles: newTiles,
            frameNumber: (this.state.frameNumber || 0) + 1,
            tilesetFrameNumber,
          });
          this._commitTileIdSet(newTiles);
          tilesChanged = true;
        } else {
          this.state.tilesetFrameNumber = tilesetFrameNumber;
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
   * rAF-deferred setState. The layer-owned `state.frameNumber` is bumped once
   * per batch, only if the visible tile SET actually changed.
   */
  private _scheduleTileLoadUpdate(tileset: SpatioTemporalTileset): void {
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

      // The tileset this batch was scheduled for may have been torn down
      // (source switch / unmount) between the schedule and the callback.
      if (this._finalized || this.state.tileset !== tileset) return;

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
  private _maybeFireViewportLoad(tileset: SpatioTemporalTileset): void {
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
    // (A `TEMP-DIAGNOSTIC` block used to push every visible-set delta onto
    // `globalThis.__sttProbe.tileSwaps` from here. It bypassed
    // `lib/telemetry.ts`, so it grew without the channel cap for the whole
    // session, and the flash it was chasing was root-caused elsewhere — the
    // extrusion seam-wall mask. Removed; re-add via `emit()` if it's ever
    // needed again, so it inherits MAX_SAMPLES_PER_CHANNEL.)
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
      if (
        nowWall - this._lastViewportSelectWall <
        MIN_VIEWPORT_TILESET_WALL_MS
      ) {
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

    // Get current time from the resolved TimeController if available, otherwise
    // from props.
    const controller = this.state.resolvedTimeController;
    const currentTime = controller
      ? controller.getTime()
      : this.props.currentTime;

    // Update internal time tracking
    this._currentTime = currentTime;

    // Skip the tileset's viewport debounce when the play-head — not the
    // camera — is what moved.
    //
    // The previous condition (`timeChanged && !changeFlags.propsOrDataChanged`)
    // was dead code and always false: `timeChanged` required
    // `changeFlags.propsChanged`, and deck derives `propsOrDataChanged` as a
    // SUPERSET of `propsChanged`, so the two conjuncts were mutually exclusive.
    // An app driving the play-head through the `currentTime` prop with
    // `debounceTime > 0` therefore paid the viewport debounce on every frame —
    // exactly the delay this was meant to bypass. (The TimeController path
    // never hit it: `_handleTimeUpdate` passes `skipDebounce = true` directly.)
    //
    // `timeChanged` also drops its `propsChanged` conjunct: with a
    // TimeController the play-head advances through `controller.getTime()`,
    // which no prop diff can see. The debounce still applies whenever the
    // VIEWPORT moved in the same pass — coalescing camera motion is what it
    // exists for.
    const timeChanged = currentTime !== this._lastTilesetUpdateTime;
    const skipDebounce = timeChanged && !changeFlags.viewportChanged;

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

    // Update tileset - this returns the TILESET's own frame counter, which
    // bumps when its needed-tile set changes or a tile finishes loading.
    const tilesetFrameNumber = tileset.update(
      {
        bounds,
        zoom,
        time: currentTime,
        timeWindow,
      },
      skipDebounce,
    );

    // Get visible tiles (optimistic rendering - show what we have)
    const tiles = tileset.getVisibleTiles();

    // Decide whether to setState. Two conditions matter for the consolidated
    // render path: the visible tile SET changed, or the TILESET's counter
    // bumped (a new tile finished loading). The direct content check is
    // defense in depth: a counter that ticks on every selectAndLoadTiles()
    // call would rebuild the trip consolidation every animation frame, so the
    // (cheap) set comparison guarantees we never re-consolidate while the
    // visible set is unchanged.
    //
    // The tileset's counter MUST be compared against its OWN mirror
    // (`state.tilesetFrameNumber`), never against the layer-owned
    // `state.frameNumber` — that one is bumped independently by the
    // tick/tile-load paths as `frameNumber + 1`. Two authorities writing one
    // slot drift apart permanently and pin `frameChanged` true on every pass:
    // one extra full `renderLayers()` per update, forever.
    const frameChanged = this.state.tilesetFrameNumber !== tilesetFrameNumber;
    const tilesChanged = this._tilesChanged(tiles);

    if (frameChanged || tilesChanged) {
      this._lastTilesetUpdateTime = currentTime;
      this.setState({
        tiles,
        frameNumber: (this.state.frameNumber || 0) + 1,
        tilesetFrameNumber,
      });
      this._commitTileIdSet(tiles);
    }

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
        '[STL] Tileset updated - tileset frame:',
        tilesetFrameNumber,
        'render epoch:',
        this.state.frameNumber,
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
      this._updateTileset({
        viewportChanged: true,
        propsChanged: false,
        dataChanged: false,
      });
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
   * Cancel the pending coalesced tile-load rAF and the trailing viewport-settle
   * timer. Both capture / target the CURRENT tileset, so they must be dropped
   * on a data/source switch (before the old tileset is finalized in
   * `_initArchiveAndTileset`) and on teardown (`finalizeState`) — otherwise the
   * deferred callback fires against the finalized old tileset.
   */
  private _cancelPendingUpdates(): void {
    if (this._tileLoadRafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this._tileLoadRafId);
      } else {
        clearTimeout(
          this._tileLoadRafId as unknown as ReturnType<typeof setTimeout>,
        );
      }
      this._tileLoadRafId = null;
    }
    this._clearViewportSettle();
  }

  /**
   * Get the effective time window for tile loading.
   * Subclasses can override this to account for trail rendering, etc.
   *
   * For trail rendering, the time window should be at least 2x the trail length
   * to ensure tiles containing trail data are loaded.
   *
   * `tileLoadTimeWindow` decouples this from the RENDER window. The visible-tile
   * set is the tiles overlapping `currentTime ± thisWindow/2`, and it is refreshed
   * at most once per `MIN_TILESET_UPDATE_WALL_MS` (100 ms). A dataset whose render
   * window is narrower than the playhead's travel between two refreshes (at 1×,
   * 100 ms of sim) would select tiles it has already left by the next frame, and
   * the layer draws nothing. Frame-sequence archives are exactly that case: a
   * 66 ms window over 66 ms frames. Widening the LOAD window keeps a few buckets
   * resident; the render window still picks one frame out of them, because
   * TimeFilterExtension filters per feature, not per tile.
   */
  protected getEffectiveTimeWindow(): number {
    const load = this.props.tileLoadTimeWindow;
    return load && load > 0
      ? Math.max(load, this.props.timeWindow)
      : this.props.timeWindow;
  }

  /**
   * Report a DATASET-level failure (no single failing tile) the way
   * `TileLayer` reports tile failures: through `props.onTileError` when the
   * app supplied one, otherwise `console.error`. The `tileId` argument is
   * `undefined`, which is exactly what the `onTileError` prop doc promises for
   * dataset-level failures.
   */
  private _reportDatasetError(error: unknown, url: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (this.props.onTileError) {
      this.props.onTileError(err, undefined);
    } else {
      console.error('[STL] Archive init failed:', url, err);
    }
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
      // Drop any pending tile-load rAF / viewport-settle timer that captured
      // the previous tileset before we finalize it — otherwise they fire
      // against the dead tileset after the source switch.
      this._cancelPendingUpdates();
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
      // in-flight Range-request ceiling, so it has to be forwarded here.
      // Without it the archive falls back to its own default (24), the layer's
      // `maxRequests` never reaches the wire, and setting it has no effect on
      // actual fetch concurrency.
      maxConcurrentRequests: this.props.maxRequests,
    });

    // Get metadata to configure tileset zoom range. A 404, a CORS rejection or
    // a corrupt manifest surfaces HERE: without the catch it became an
    // unhandled promise rejection, `initializingUrl` stayed pinned to the dead
    // URL (so `updateState` treated it as already-live and never retried), and
    // `props.onTileError` — whose doc promises dataset-level failures arrive
    // with `tileId === undefined` — never fired.
    let metadata: ArchiveMetadata;
    try {
      metadata = await archive.getMetadata();
    } catch (error) {
      archive.finalize();
      if (this.state.initializingUrl === targetUrl) {
        this.state.initializingUrl = null;
      }
      if (!this._finalized) this._reportDatasetError(error, targetUrl);
      return;
    }

    // Bail out if the layer was finalized OR another init superseded ours
    // while we awaited metadata. In that case we own a stranded archive,
    // so finalize it ourselves rather than leak it into state.
    if (this._finalized || this.state.initializingUrl !== targetUrl) {
      archive.finalize();
      return;
    }

    // Everything from here is synchronous, but a subclass hook
    // (`onMetadataLoaded` / `getTilesetOptionOverrides`) or a malformed
    // metadata block can still throw — the same cleanup contract applies.
    try {
      this._attachArchiveAndTileset(archive, metadata);
    } catch (error) {
      if (this.state.archive !== archive) {
        // Never committed: we still own the archive, so tear it down instead
        // of leaking its worker pool / OPFS handles, and release the slot.
        archive.finalize();
        if (this.state.initializingUrl === targetUrl) {
          this.state.initializingUrl = null;
        }
      }
      if (!this._finalized) this._reportDatasetError(error, targetUrl);
    }
  }

  /**
   * Build the tileset for a freshly-loaded `metadata` and commit the
   * (archive, tileset) pair to state. Split out of
   * {@link _initArchiveAndTileset} so the async error path there has one
   * unambiguous "did we commit?" boundary (`state.archive === archive`).
   */
  private _attachArchiveAndTileset(
    archive: STTArchive,
    metadata: ArchiveMetadata,
  ): void {
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
      ? (
          bounds: BoundingBox,
          zoom: number,
          timeRange: { start: number; end: number },
        ) => archive.getSummaryTileIdsInBounds(bounds, zoom, timeRange)
      : undefined;

    // Temporal-LOD pyramid (the scrub-LOD temporal axis). Capability detection mirrors the
    // summary-tier wiring above: only archives built with `--temporal-lod`
    // carry `metadata.temporalLod`, and only then is the LOD enumeration
    // callback wired — everything no-ops cleanly on every other archive.
    // Inert until the `scrubLod.temporal` axis is switched on.
    const temporalLodLevels =
      metadata.temporalLod && metadata.temporalLod.length > 0
        ? metadata.temporalLod
        : undefined;
    const getAvailableTemporalLodTiles = temporalLodLevels
      ? (
          bounds: BoundingBox,
          zoom: number,
          timeRange: { start: number; end: number },
          bucketMs: number,
        ) =>
          archive.getTileIdsInBoundsForTemporalLod(
            bounds,
            zoom,
            timeRange,
            bucketMs,
          )
      : undefined;

    // Create tileset with archive as data source
    const tileset = new SpatioTemporalTileset({
      maxRequests: this.props.maxRequests,
      debounceTime: this.props.debounceTime,
      maxCacheSize: this.props.maxCacheSize,
      maxCacheByteSize: this.props.maxCacheByteSize,
      minZoom: metadata.minZoom,
      maxZoom: metadata.maxZoom,
      // Use temporal bucket from metadata for deterministic tile loading
      temporalBucketMs: metadata.temporalBucketMs,
      // Parent-fallback policy (prop pass-through; 'best-available' default).
      refinementStrategy: this.props.refinementStrategy ?? 'best-available',
      // Additive-octree LOD: when 'additive', load + render the union of zoom
      // levels [minZoom..cameraZoom] (each point lives at one home zoom). See the
      // lodMode prop and SpatioTemporalTilesetOptions.lodMode.
      lodMode: this.props.lodMode,
      // Prefetch configuration for smooth animation playback
      enablePrefetch: this.props.enablePrefetch,
      prefetchAhead: this.props.prefetchAhead,
      prefetchSteps: this.props.prefetchSteps,
      tier: this.props.tier,
      summaryZoomRange,
      getAvailableSummaryTiles,
      // Scrub-LOD motion tier (kill-switched off by default; see the prop).
      scrubLod: this.props.scrubLod ?? undefined,
      temporalLodLevels,
      getAvailableTemporalLodTiles,
      // Archive-backed fetch callbacks (getAvailableTiles / getTileData /
      // getTileDataBatch / getTileByteSize / getThroughput). Shared with three
      // + maplibre via the core adapter; see render/tileset-adapter.ts for the
      // range-coalescer batch hooks + cross-source EDF playhead forwarding.
      ...makeTilesetCallbacks(archive),
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
        // Core signals dataset-level failures (a selection pass that could
        // not query the directory) with the sentinel TileId {x:-1, y:-1} —
        // its own callback requires a TileId. This prop is already typed
        // `tileId?: TileId`, so translate the sentinel to undefined rather
        // than leaking a phantom tile key to app code.
        const realTileId = tileId && tileId.x >= 0 ? tileId : undefined;
        if (this.props.onTileError) {
          this.props.onTileError(error, realTileId);
        } else {
          // TileLayer's default: errors surface in the console.
          console.error(
            '[STL] Tile error:',
            realTileId ?? '(dataset-level)',
            error,
          );
        }
      },
      // ── Player-buffering plumbing (WS-A/WS-B contract) ──────────────────
      // Buffered-runway threshold events from the tileset's coverage index,
      // forwarded to the app (which routes them into a PlaybackGovernor).
      onBufferChange: (runway: BufferedRunway) => {
        this.props.onBufferChange?.(runway);
      },
      // Subclass hook: tier-specific tileset config (e.g. H3SummaryLayer's
      // summary-tier zoom range + 'no-overlap' refinement). Spread LAST so
      // overrides win over the base wiring above.
      ...this.getTilesetOptionOverrides(metadata),
    });

    if (DEBUG)
      console.log(
        '[STL] Tileset configured with zoom range:',
        metadata.minZoom,
        '-',
        metadata.maxZoom,
      );

    // If the resolved time controller is playing, set initial animation state
    const controller = this.state.resolvedTimeController;
    if (controller?.isPlaying()) {
      tileset.setAnimationState(true, controller.getSpeed());
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
    this.setState({
      archive,
      tileset,
      metadata,
      initializingUrl: null,
      tiles: [],
    });

    // Hand the live tileset to the app exactly once per init, after state is
    // committed. The tileset implements the BufferSource readiness contract
    // (runway/cost/ETA queries), which is what a PlaybackGovernor consumes.
    this.props.onTilesetReady?.(
      tileset as SpatioTemporalTileset & BufferSource,
    );

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
      tileset
        .preloadOverviewTier(overviewOpts)
        .then((result) => {
          // Ignore results for a tileset this layer no longer owns (re-init /
          // unmount races) — `clear()` settles those with reason 'disabled'.
          if (this._finalized || this.state.tileset !== tileset) return;
          this._overviewPreload = result;
          this.props.onOverviewPreload?.(result);
        })
        // The preload is best-effort and deliberately non-blocking, but a
        // rejected directory/pack fetch inside it must not escape as an
        // unhandled rejection. It never fails the layer — the map renders fine
        // without a storyboard tier — so it is reported, not propagated.
        .catch((error) => {
          if (this._finalized || this.state.tileset !== tileset) return;
          this._reportDatasetError(error, this.props.data);
        });
    }
  }

  /**
   * Subclass hook, called once per archive init right after metadata arrives
   * (and after the supersession race-guard). Base implementation is a no-op.
   */
  protected onMetadataLoaded(_metadata: ArchiveMetadata): void {}

  /**
   * Subclass hook: partial {@link SpatioTemporalTilesetOptions} spread over
   * the base tileset wiring at construction time (overrides win). Lets a
   * tier-specific subclass (H3SummaryLayer) swap zoom range / refinement
   * strategy without duplicating the whole `_initArchiveAndTileset` plumbing.
   */
  protected getTilesetOptionOverrides(
    _metadata: ArchiveMetadata,
  ): Partial<SpatioTemporalTilesetOptions> {
    return {};
  }

  /**
   * Viewport bounds for tile selection, in degrees.
   *
   * PITCH AND BEARING: the box is the axis-aligned hull of ALL FOUR ground
   * corners of the frustum, taken from `viewport.getBounds()`. It used to be
   * built from two opposite screen corners — `unproject([0, height])` and
   * `unproject([width, 0])` — which are the endpoints of ONE DIAGONAL of the
   * ground quad and only bound that quad at `bearing === 0`. Under rotation the
   * two-corner box is a strict subset of the true footprint, and past
   * `bearing > atan2(height, width)` (45° on a square canvas) the two samples
   * swap order and the box INVERTS: `boundsToTiles`' row loop then never
   * executes, so the layer selects ZERO TILES while `isLoaded` and
   * `getBufferedRunway` both report settled and fully buffered. Measured at z9
   * on 1000×1000: bearing 45 selected 4 of 16 on-screen tiles, bearing 60
   * selected none. See `docs/roadmap/tile-loading-3d-2026-07.md` §1.
   *
   * Pitch is the second, independent trigger. An `unproject` with a 2-element
   * pixel array is an unclamped ray/plane solve, so once
   * `pitch + fovy/2 > 90` — 71.57° at deck's default `altitude: 1.5` — the top
   * rays point at sky and the returned "ground point" is BEHIND the camera:
   * longitude inverts too, and an inverted longitude box is indistinguishable
   * from the deliberate antimeridian crossing encoding below (510 of 512
   * columns at z9). `getBounds()` is what fixes this and not merely the extra
   * two samples: `@math.gl/web-mercator`'s `getBounds` substitutes
   * `unprojectOnFarPlane` for the two top corners exactly when
   * `halfFov > angleToGround - 0.01`, i.e. it carries the horizon clamp we
   * would otherwise have to write here.
   *
   * This is NOT the same primitive deck's own `TileLayer` selects with — that
   * routes geospatial viewports through `getOSMTileIndices`, a frustum-plane
   * quadtree walk with per-node distance-based zoom. An axis-aligned box at one
   * integer zoom still over-covers the sides of a pitched frustum and still
   * gives the near and far thirds of the frame the same LOD. Closing that gap
   * is Wave 3 / A1 in docs/roadmap/tile-loading-3d-2026-07.md; what `getBounds`
   * buys here is a box that is CORRECT (never inverted, horizon-clamped) rather
   * than one that is minimal.
   *
   * ANTIMERIDIAN: `getBounds()` — like `unproject()` — returns UNWRAPPED
   * longitudes, so a camera centred at lon 179 reports `maxLon ≈ 184` and a
   * camera at −179 reports `minLon ≈ −184`. That is deliberate and
   * load-bearing: `worldToLngLat` is a pure linear map with no wrapping, and
   * clamping the result into `[-180, 180]` silently DISCARDS the wrapped half
   * of the screen — `ais-all-us` and `drifters` both straddle the seam and
   * rendered nothing there.
   *
   * The wrap is resolved in core rather than worked around in the chassis: the
   * archive's `tileXSpanForLonRange` walks UNWRAPPED column space and wraps at
   * emit (`(start + i) % n`), capping the span at one world width so a >360°
   * view cannot cover a column twice, and `SpatioTemporalTileset`'s
   * `viewportTileXIntervals` is built on the same primitive so selection and
   * the render-side cover check cannot disagree. For an in-world range
   * (`-180 ≤ minLon ≤ maxLon ≤ 180`) that path is byte-identical to a plain
   * clamped scan.
   *
   * So the bounds handed down are deliberately unwrapped and unclamped; the
   * `minLon > maxLon` crossing encoding is accepted equally. Do NOT introduce
   * a clamp here — it silently drops the far side of the seam.
   *
   * The one repair that IS applied is `normalizeViewportBounds` from
   * `@poopdeck.gl/core`, the primitive every backend shares (§4.1 of the
   * roadmap): it orders latitude, keeps `minLon > maxLon` only while the
   * implied span stays under 350° (wider is an inversion, not a crossing),
   * collapses a whole-world view to exactly `[-180, 180]`, and REJECTS a
   * non-finite box. On a rejection we keep the previous bounds — selecting
   * against garbage is strictly worse than selecting against a stale box.
   *
   * TILE COUNTS RISE under pitch and rotation. That is the fix, not a
   * regression: the old footprint was a 36%-coverage under-selection.
   */
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

    // Per-frame cache: skip the corner unprojections (each a matrix multiply)
    // when the viewport hasn't actually moved. Keyed on the identity
    // dimensions: id, dims, zoom, lon/lat, pitch, bearing — plus `zRange`,
    // which doubles the derivation and is a prop rather than a camera value,
    // so a change to it must invalidate too. The unprojections are cheap on
    // their own but the steady-state animation path hits this on every tick of
    // the time controller AND every viewport callback, so the redundancy adds
    // up.
    //
    // CONTRACT: every return path hands back the SAME OBJECT REFERENCE until
    // the key changes. Callers (and the tileset's own change detection) may
    // rely on that identity; do not build a fresh object per call.
    const v = viewport;
    const zRange = this._resolveZRange();
    const key =
      `${v.id ?? ''}|${v.width}x${v.height}|${v.zoom}|` +
      `${v.longitude ?? 0},${v.latitude ?? 0}|${v.pitch ?? 0}|${v.bearing ?? 0}|` +
      `${zRange ? `${zRange[0]}:${zRange[1]}` : ''}`;
    if (this._cachedBounds && this._lastBoundsKey === key) {
      return this._cachedBounds;
    }

    const raw = this._deriveViewportBox(viewport, zRange);
    const normalized = raw ? normalizeViewportBounds(raw) : null;

    if (!normalized) {
      // Rule 1 of the shared contract: a non-finite component carries no usable
      // information, and there is no sane repair for it. KEEP THE PREVIOUS BOX
      // — one stale frame of selection is invisible, whereas a NaN box makes
      // `boundsToTiles` enumerate nothing (blank map, every readiness signal
      // reporting "settled") or the whole world (a fetch storm). Caching under
      // the current key keeps the reference stable while the camera stays bad.
      warnOnce(
        `STL:bounds-nonfinite:${this.props.id}`,
        `[SpatioTemporalLayer] ${this.props.id}: viewport produced a non-finite ` +
          `bounds box at pitch ${v.pitch ?? 0}, bearing ${v.bearing ?? 0}; ` +
          'keeping the previous viewport. Tile selection is now one camera ' +
          'position stale until the camera recovers.',
      );
      this._lastBoundsKey = key;
      this._cachedBounds ??= this._cameraPointBounds(viewport);
      return this._cachedBounds;
    }

    // Only the INVERSIONS say something about the producer. `full-world` and
    // `clamped-lat` are ordinary consequences of a zoomed-out view (a z0 map
    // legitimately reports a ±421° longitude span and latitudes past the
    // pole), and a warning that fires on every global demo is a warning
    // developers learn to skip past.
    //
    // Neither derivation above can invert on its own — both min/max over four
    // corners — so an inversion means the VIEWPORT's own `getBounds` handed
    // back a box whose ends are the wrong way round (the shape Cesium's
    // `west > east` rectangle and any two-corner shim produce). The repair
    // keeps selection correct, but the host should hear about it once.
    const defects = normalized.issues.filter(
      (issue) => issue === 'inverted-lat' || issue === 'inverted-lon',
    );
    if (defects.length > 0) {
      warnOnce(
        `STL:bounds-repaired:${this.props.id}:${defects.join('+')}`,
        `[SpatioTemporalLayer] ${this.props.id}: repaired a degenerate viewport ` +
          `box (${defects.join(', ')}) at pitch ${v.pitch ?? 0}, bearing ` +
          `${v.bearing ?? 0}. Tile selection is correct, but this viewport's ` +
          '`getBounds()` is reporting its ends in the wrong order.',
      );
    }

    this._lastBoundsKey = key;
    this._cachedBounds = normalized.bounds;
    return this._cachedBounds;
  }

  /**
   * The raw lon/lat hull of the frustum's ground quad, before normalization.
   *
   * `viewport.getBounds()` is the wanted path and every deck `Viewport` has it
   * (`WebMercatorViewport` overrides it with the horizon-clamped four-corner
   * derivation described on {@link getViewportBounds}). The `unproject`
   * fallback exists for the viewport-shaped plain objects a host app — or this
   * package's own test suite — hands to a layer directly. That path samples
   * all FOUR corners through `boundsFromCorners` rather than the two it used
   * to: two corners bound the ground quad only at `bearing === 0`, and there
   * is no reason to keep that defect alive in the fallback.
   *
   * Returns `null` only when no corner produced a finite sample at all.
   */
  private _deriveViewportBox(
    viewport: any,
    zRange: [number, number] | null,
  ): BoundingBox | null {
    if (typeof viewport.getBounds === 'function') {
      if (zRange) {
        // Union the ground-plane box with the box at the top of the content,
        // exactly as deck's own `Tileset2D.getBoundingBox` does for `zRange`.
        // Feeding both boxes' corners through `boundsFromCorners` (rather than
        // min/maxing them by hand) keeps the per-axis non-finite skip: if the
        // upper plane degenerates, its longitudes can still widen the box
        // while its latitudes are ignored.
        const low = viewport.getBounds({ z: zRange[0] });
        const high = viewport.getBounds({ z: zRange[1] });
        return boundsFromCorners([
          [low[0], low[1]],
          [low[2], low[3]],
          [high[0], high[1]],
          [high[2], high[3]],
        ]);
      }
      const b = viewport.getBounds();
      return { minLon: b[0], minLat: b[1], maxLon: b[2], maxLat: b[3] };
    }

    // `zRange` is deliberately NOT honoured here: a viewport without
    // `getBounds` is a hand-rolled object, and there is no reason to believe
    // its `unproject` implements the `targetZ` option the union needs.
    const { width, height } = viewport;
    return boundsFromCorners([
      viewport.unproject([0, 0]),
      viewport.unproject([width, 0]),
      viewport.unproject([0, height]),
      viewport.unproject([width, height]),
    ]);
  }

  /**
   * The altitude slab to dilate the viewport box over, or `null` for the
   * ground plane only. Currently just the `zRange` prop: see the prop docs
   * for why nothing is derived automatically.
   */
  private _resolveZRange(): [number, number] | null {
    const range = this.props.zRange;
    if (!range) return null;
    const [a, b] = range;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    // Order it here so the cache key is canonical and `_deriveViewportBox`
    // can take [low, high] on faith.
    return a <= b ? [a, b] : [b, a];
  }

  /**
   * Degenerate stand-in used ONLY when the very first box a layer ever derives
   * is unusable, so there is no previous viewport to keep.
   *
   * A zero-area box at the camera's own centre selects the single tile under
   * the camera, which is certainly on screen. The alternatives are worse in
   * both directions: the global band is a `4^zoom` fetch storm, and there is
   * no "select nothing" value in this API — `{0,0,0,0}` would point at the
   * Gulf of Guinea. The next frame with a finite camera replaces it.
   */
  private _cameraPointBounds(viewport: any): BoundingBox {
    const lon = Number.isFinite(viewport.longitude) ? viewport.longitude : 0;
    const lat = Number.isFinite(viewport.latitude)
      ? Math.min(90, Math.max(-90, viewport.latitude))
      : 0;
    return { minLon: lon, minLat: lat, maxLon: lon, maxLat: lat };
  }

  /**
   * The camera zoom → the integer tile zoom to select at.
   *
   * Three stages, in order: the explicit override, the archive's declared
   * `[minZoom, maxZoom]`, then the viewport CELL BUDGET — a cap on how many
   * cells the box derived by {@link getViewportBounds} is allowed to
   * enumerate at that zoom, stepping down until it fits (never below
   * `minZoom`). See the `viewportCellBudget` prop for why the budget exists
   * and why it is not a cap on the tile list, and
   * docs/roadmap/tile-loading-3d-2026-07.md §4.4.
   *
   * The two explicit instructions bypass the budget entirely. `zoomOverride`
   * is an app saying which zoom to load and would be a lie to override.
   * `useGlobalBounds` hands down the whole planet by request (the `GlobeView`
   * path), so its cell count is `4^zoom` by construction and measuring it
   * against a viewport budget would clamp every globe demo to z4.
   */
  protected getZoomLevel(viewport: any): number {
    // Use zoomOverride if specified (useful for GlobeView)
    if (this.props.zoomOverride != null) {
      return this.props.zoomOverride;
    }

    // Convert deck.gl zoom to tile zoom
    // Clamp to available zoom range from archive metadata
    const zoom = Math.floor(viewport.zoom);
    const { archive, metadata } = this.state;

    let clamped = zoom;
    let minZoom = 0;
    if (archive && metadata) {
      // Use metadata from state
      minZoom = metadata.minZoom;
      clamped = Math.max(metadata.minZoom, Math.min(metadata.maxZoom, zoom));
    }

    const budget =
      this.props.viewportCellBudget ?? DEFAULT_VIEWPORT_CELL_BUDGET;
    if (!Number.isFinite(budget) || this.props.useGlobalBounds) {
      // Keep the memory in step with what we returned, so re-enabling the
      // budget mid-session doesn't read a decision from before it was off.
      this._budgetZoom = clamped;
      return clamped;
    }

    // `getViewportBounds` is memoised on the camera key and both callers have
    // just called it, so this is a cache hit rather than a second derivation.
    const fitted = fitZoomToCellBudget(
      this.getViewportBounds(viewport),
      clamped,
      {
        minZoom,
        maxCells: budget,
        previousZoom: this._budgetZoom,
      },
    );
    this._budgetZoom = fitted;
    return fitted;
  }

  /**
   * `TileLayer`'s readiness contract: true once the CURRENT viewport×window
   * selection has settled AND deck's own async props / sublayers are resolved.
   *
   * `state.tiles.length > 0` is NOT that predicate and must not stand in for
   * it: a layer panned over empty ocean (a legitimately empty but fully
   * settled selection) would report NOT loaded forever, and `state.tiles` is
   * only ever written from `_updateTileset`, so it goes stale on the whole
   * animation-tick path. `tileset.isLoaded` already mirrors
   * `Tileset2D.isLoaded` (nothing queued, no needed tile in flight, failed
   * tiles count as settled), so this composes it with the base
   * `CompositeLayer.isLoaded` exactly as upstream `TileLayer` does.
   *
   * Before the archive is up there is no selection to be settled, so a layer
   * whose tileset has not been created yet is deliberately NOT loaded.
   */
  get isLoaded(): boolean {
    const tileset = this.state?.tileset;
    if (!tileset) return false;
    return tileset.isLoaded && super.isLoaded;
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
   *
   * DEDUPED BY CONSTRUCTOR, internal instance wins. All four STT extensions are
   * publicly exported and the `composeSubLayerProps` docstring above tells
   * users to pass extensions through the top-level `extensions` prop, so a
   * caller re-adding (say) `TimeFilterExtension` is entirely expected — and a
   * plain concatenation broke the layer two ways:
   *   1. deck's `mergeShaders` CONCATENATES each extension's `inject` strings,
   *      so the same hook fires twice and its `in float instanceStartTime;`
   *      style declarations are emitted twice → GLSL redeclaration error →
   *      the layer compiles nothing and renders blank.
   *   2. `LayerExtension.getSubLayerProps` copies the extension's
   *      `defaultProps` keys off the COMPOSITE's props, clobbering the
   *      per-tile `timeOffset` / `getTime` / `filterEnabled` /
   *      `categoryPalette` the chassis just wired for that tile.
   * The internal instance is the one kept because it carries that per-tile
   * wiring; the duplicate is dropped with a one-time explanation.
   * (`collisionFilterProps` in `extensions/collision-filter-extension.ts`
   * applies the same rule from the other direction.)
   */
  protected composeExtensions(internal: any[]): any[] {
    const user = (this.props as CompositeLayerProps).extensions as
      | any[]
      | undefined;
    if (!user || user.length === 0) return internal;
    const merged = internal.slice();
    for (const ext of user) {
      // Dedupe by CLASS. A bare object literal (`{}`) is not a deck
      // `LayerExtension`, and its constructor is `Object` for every instance —
      // treating those as duplicates of each other would silently drop
      // unrelated stubs, so they always pass through.
      const ctor = (ext as any)?.constructor;
      const duplicate =
        !!ctor &&
        ctor !== Object &&
        internal.some((i) => i?.constructor === ctor);
      if (!duplicate) {
        merged.push(ext);
        continue;
      }
      const name = (ext as any)?.constructor?.name ?? 'unknown extension';
      warnOnce(
        `${(this.constructor as any).layerName}:duplicateExtension:${name}`,
        `[${(this.constructor as any).layerName}] \`${name}\` is already applied ` +
          `internally by this layer, so the instance passed via the ` +
          `\`extensions\` prop was dropped. Keeping both would emit its shader ` +
          `injections twice (a GLSL redeclaration that makes the layer render ` +
          `nothing) and would let its defaultProps, read off the composite, ` +
          `overwrite the per-tile wiring. Configure the internal instance ` +
          `through this layer's own props instead.`,
      );
    }
    return merged.length === internal.length ? internal : merged;
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
  getPickingInfo({
    info,
    sourceLayer,
  }: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const out = info as SpatioTemporalPickingInfo;
    const sprops = sourceLayer?.props as SttSublayerPickingProps | undefined;
    const tile = sprops?.tile ?? null;
    out.sourceTile = tile;
    // Upstream `TileLayer` sets this so `_updateAutoHighlight` can target the
    // ONE sublayer that emitted the pick — see the override below.
    out.sourceTileSubLayer = sourceLayer ?? null;
    if (info.index >= 0 && tile) {
      out.tile = tile;
      // Respect an object a sublayer already resolved (e.g. JS-row
      // sublayers); only binary sublayers leave it undefined.
      if (out.object === undefined && sprops?.sttFeatures) {
        out.object =
          getFeatureProperties(sprops.sttFeatures, info.index) ?? undefined;
      }
    }
    return out;
  }

  /**
   * Route `autoHighlight` to the sublayer that actually emitted the pick.
   *
   * `CompositeLayer._updateAutoHighlight` BROADCASTS the info to every
   * sublayer, and each one matches the hovered object by its index-encoded
   * picking colour. Since this chassis renders one sublayer per tile and every
   * tile numbers its features from 0, hovering feature 7 of one tile lit
   * feature 7 in all ~40 visible tiles. Delegating to `sourceTileSubLayer` is
   * exactly how upstream `TileLayer` avoids it; the broadcast remains the
   * fallback for picks that never passed through `getPickingInfo` (hover-off
   * on an unmounted sublayer, synthetic infos in tests).
   */
  protected _updateAutoHighlight(info: SpatioTemporalPickingInfo): void {
    const sublayer = info.sourceTileSubLayer;
    if (sublayer) {
      sublayer.updateAutoHighlight(info);
      return;
    }
    super._updateAutoHighlight(info);
  }

  /**
   * Subclasses override this to render actual visualization layers
   */
  renderLayers(): any[] {
    return [];
  }
}
