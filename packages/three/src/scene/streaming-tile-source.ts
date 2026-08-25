// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `StreamingTileSource` — viewport-driven streaming for the Three renderer.
 *
 * Where {@link STTTileSource} eagerly loads a whole (small, local) AV archive,
 * this source WRAPS the core {@link SpatioTemporalTileset} so the heavy
 * multi-km clouds stream like the deck renderer: a camera-derived
 * `{bounds, zoom, time}` drives `tileset.update`, the tileset selects/loads/
 * prefetches/evicts, and on every change we hand the layer the fresh
 * {@link SpatioTemporalTileset.getVisibleTiles} set (replace-all — incremental
 * residency is a later optimization). It deliberately REUSES the core tileset's
 * selection/buffer machinery rather than reimplementing any of it.
 *
 * Three responsibilities, all thin:
 *   1. {@link StreamingTileSource.update} — pump a viewport into the tileset and,
 *      when the visible/resident set actually changed, fire `onTilesChanged`.
 *   2. {@link cameraToViewport} — turn a {@link Projection} + Three
 *      `PerspectiveCamera` into `{bounds, zoom}` by casting a grid of NDC rays
 *      at the projection's reference surface (ground plane / globe sphere),
 *      clipping every ray that grazes the horizon (not just the ones that miss)
 *      AT the horizon, widening for a pole in frame, and taking the zoom from
 *      the recovered view state.
 *   3. {@link TilesetBufferSource} — the REAL playback `BufferSource` backed by
 *      the tileset's pending/loaded coverage state (runway / ranges / cost /
 *      ETA), replacing the faked `createCompleteBufferSource` for streaming
 *      datasets where "everything is buffered" is a lie.
 *
 * The buffer/builder split convention (a PURE testable core + a thin GPU/Three
 * wrapper) is honoured here too: the resident-diffing and the BufferSource are
 * Three-free and unit-tested. {@link cameraToViewport} needs Three's
 * `Vector3.unproject`, so it lives here rather than in the framework-free
 * kernel, but it is deterministic and IS unit-tested (`camera-viewport.test.ts`)
 * — the "verified visually" it used to claim is how four separate defects,
 * including a globe path that returned latitude 0 for every camera, survived to
 * the 2026-07 audit.
 */

import { STTArchive, tileKey as coreTileKey } from '@poopdeck.gl/core';
import type { ArchiveMetadata, BoundingBox, Tile } from '@poopdeck.gl/core';
import {
  SpatioTemporalTileset,
  type BufferedRunway as CoreBufferedRunway,
} from '@poopdeck.gl/core';
// The shared bounds repair comes in on the `/geo` subpath, not the package root:
// `streaming-tile-source.test.ts` mocks the root specifier to stub the archive +
// tileset, and a root import of these would resolve to the mock (Vitest throws
// on an export the factory does not define).
import {
  boundsFromCorners,
  normalizeViewportBounds,
} from '@poopdeck.gl/core/geo';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';
import { PerspectiveCamera, Vector3 } from 'three';
import type { Projection } from '../projection/local-enu.js';
import { EARTH_RADIUS } from '../projection/local-enu.js';
import {
  cameraToViewState,
  intersectSurface,
  surfaceRadius,
} from '../projection/view-state.js';

/** A camera/playback-derived viewport — the input to {@link StreamingTileSource.update}. */
export interface StreamingViewport {
  bounds: BoundingBox;
  zoom: number;
  /** Play-head time (absolute ms). */
  time: number;
  /**
   * Temporal window (ms) the tileset selects around `time` (`[t - w/2, t + w/2]`).
   * Defaults to the archive's `temporalBucketMs` when omitted.
   */
  timeWindow?: number;
}

export interface StreamingTileSourceOptions {
  /** Resolved archive manifest URL. */
  url: string;
  /** Custom fetch (e.g. to add auth headers / rewrite the base). */
  fetch?: typeof fetch;
  /**
   * LOD strategy, forwarded to the tileset. `'additive'` loads the UNION of
   * `[minZoom..cameraZoom]` (additive-octree clouds where each point lives at
   * one home zoom); `'parent-fallback'` (default) renders the single best zoom.
   */
  lodMode?: 'parent-fallback' | 'additive';
  /**
   * Default temporal window (ms) used when {@link StreamingViewport.timeWindow}
   * is omitted. Defaults to the archive's `temporalBucketMs`.
   */
  timeWindowMs?: number;
  /** Forwarded to the tileset (concurrency / cache caps / prefetch). */
  maxRequests?: number;
  maxCacheSize?: number;
  maxCacheByteSize?: number;
  enablePrefetch?: boolean;
  /**
   * Debounce (ms) before a viewport change triggers tile selection (the
   * deck.gl `TileLayer` pattern). Forwarded to the tileset. @default 0
   */
  debounceTime?: number;
  /** How far ahead to prefetch, in animation-time ms (tileset default 30000). */
  prefetchAhead?: number;
  /** Number of temporal-window steps to prefetch ahead (tileset default 4). */
  prefetchSteps?: number;
  /**
   * Tile-tier dispatch mode. `'auto'` (the tileset default) uses the summary
   * tier inside {@link summaryZoomRange} and raw tiles above it; `'summary'` /
   * `'raw'` force one tier. Inert on archives without a summary tier.
   */
  tier?: 'auto' | 'summary' | 'raw';
  /**
   * Inclusive zoom range covered by the archive's summary tier. Normally left
   * unset — {@link StreamingTileSource} derives it from the archive metadata's
   * `summaryTier` — but an explicit value overrides that (e.g. to narrow the
   * band a host wants aggregated cells for).
   */
  summaryZoomRange?: { minZoom: number; maxZoom: number };
  /**
   * Scrub-time LOD degradation policy (the core "motion tier"). Absent/empty is
   * the kill switch — {@link StreamingTileSource.setInteractive} then stores the
   * bit only and selection is byte-identical. With an axis enabled, selection
   * degrades to a cheaper preview while the governor holds the interactive bit
   * (via {@link TilesetBufferSource.setInteractive}) and restores on release.
   */
  scrubLod?: {
    spatial?: boolean;
    spatialZoomDrop?: number;
    temporal?: boolean;
  };
  /**
   * Overview (storyboard) preview tier. When truthy, the tileset's
   * `preloadOverviewTier()` is kicked right after init: the coarsest tiles
   * across the full dataset time range are budget-gated, pinned, and rendered
   * via the parent-zoom fallback so a scrub always has SOMETHING to show. An
   * object tunes the budget / deepest overview zoom. @default false
   */
  overviewPreload?: boolean | { budgetBytes?: number; maxZoom?: number };
  /**
   * Fired (async, after the tileset's `getVisibleTiles` changes) with the fresh
   * resident set. The layer re-calls `layer.setTiles(tiles, ctx)`. Receives the
   * SAME `Tile[]` instance order `getVisibleTiles` returns.
   */
  onTilesChanged?: (tiles: Tile[]) => void;
}

/**
 * The streaming-tileset knobs a HOST forwards when opting a layer into
 * streaming (see {@link STTScene.addLayer} / the r3f `streaming` prop). `url`,
 * `fetch`, and `onTilesChanged` are omitted because the driver wires them from
 * the layer's archive URL + resident-set callback — the caller only tunes the
 * LOD/cache/prefetch behaviour.
 */
export type StreamingLayerOptions = Omit<
  StreamingTileSourceOptions,
  'url' | 'fetch' | 'onTilesChanged'
>;

/**
 * Stable identity key for a {@link Tile} used by the resident-set diff. A tile's
 * `id` is its address; two `getVisibleTiles` calls that return the same
 * addresses describe the same resident set even if the array order or the
 * `Tile` object identities differ.
 *
 * Delegates to core's canonical `tileKey` rather than re-spelling
 * `${z}/${x}/${y}/${t}`. This source wires a {@link
 * StreamingTileSourceOptions.scrubLod} axis, so `bucketMs` is genuinely
 * populated here — and the hand-spelled form made a scrub-preview tile and the
 * base tile it shares an address with compare EQUAL, so the resident-set diff
 * reported no change across a tier swap and the scene kept the old geometry.
 */
export function tileKey(tile: Tile): string {
  return coreTileKey(tile.id);
}

/** `true` when two tile arrays describe the same resident set (by address). */
export function residentSetEqual(
  a: readonly Tile[],
  b: readonly Tile[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const seen = new Set<string>();
  for (const t of a) seen.add(tileKey(t));
  for (const t of b) {
    if (!seen.has(tileKey(t))) return false;
  }
  return true;
}

/**
 * The minimal tileset surface {@link StreamingTileSource} drives. The real
 * {@link SpatioTemporalTileset} satisfies it; tests pass a mock. Keeping it
 * structural lets the unit test exercise the update-pump + resident diff
 * without a network/archive.
 */
export interface DrivableTileset {
  update(
    viewport: {
      bounds: BoundingBox;
      zoom: number;
      time: number;
      timeWindow: number;
    },
    skipDebounce?: boolean,
  ): number;
  getVisibleTiles(): Tile[];
  setAnimationState?(isAnimating: boolean, speed?: number): void;
  setInteractive?(interactive: boolean): void;
  clear?(): void;
}

/**
 * Wraps a {@link SpatioTemporalTileset} (or any {@link DrivableTileset}) and
 * pumps camera-derived viewports into it, surfacing the resident set via an
 * `onTilesChanged` callback whenever it actually changes.
 */
export class StreamingTileSource {
  readonly url: string;
  private archive: STTArchive | null = null;
  private metadata: ArchiveMetadata | null = null;
  private tileset: DrivableTileset | null = null;
  private inflightInit: Promise<void> | null = null;

  private readonly lodMode: 'parent-fallback' | 'additive';
  private readonly fetchImpl?: typeof fetch;
  private readonly optTimeWindowMs?: number;
  private readonly maxRequests?: number;
  private readonly maxCacheSize?: number;
  private readonly maxCacheByteSize?: number;
  private readonly enablePrefetch?: boolean;
  private readonly debounceTime?: number;
  private readonly prefetchAhead?: number;
  private readonly prefetchSteps?: number;
  private readonly tier?: 'auto' | 'summary' | 'raw';
  private readonly optSummaryZoomRange?: { minZoom: number; maxZoom: number };
  private readonly scrubLod?: {
    spatial?: boolean;
    spatialZoomDrop?: number;
    temporal?: boolean;
  };
  private readonly overviewPreload?:
    | boolean
    | { budgetBytes?: number; maxZoom?: number };
  private onTilesChanged?: (tiles: Tile[]) => void;

  /** Last resident set published to `onTilesChanged` (for diffing). */
  private resident: Tile[] = [];
  /**
   * Tileset frame number at the last update-path publish. An unchanged one is
   * the tileset's guarantee that the visible set cannot have moved THROUGH
   * `update()`, which keeps the `getVisibleTiles()` + Set diff walk off a
   * host's per-frame pump. Arrivals and evictions never bump it — they come
   * through {@link publishPending}.
   */
  private lastPublishedFrame = -1;
  /** A resident-set change may be outstanding; re-derive on the next flush. */
  private publishPending = false;
  /** A microtask flush is already queued. */
  private publishScheduled = false;
  private disposed = false;

  constructor(opts: StreamingTileSourceOptions) {
    this.url = opts.url;
    this.lodMode = opts.lodMode ?? 'parent-fallback';
    this.fetchImpl = opts.fetch;
    this.optTimeWindowMs = opts.timeWindowMs;
    this.maxRequests = opts.maxRequests;
    this.maxCacheSize = opts.maxCacheSize;
    this.maxCacheByteSize = opts.maxCacheByteSize;
    this.enablePrefetch = opts.enablePrefetch;
    this.debounceTime = opts.debounceTime;
    this.prefetchAhead = opts.prefetchAhead;
    this.prefetchSteps = opts.prefetchSteps;
    this.tier = opts.tier;
    this.optSummaryZoomRange = opts.summaryZoomRange;
    this.scrubLod = opts.scrubLod;
    this.overviewPreload = opts.overviewPreload;
    this.onTilesChanged = opts.onTilesChanged;
  }

  /**
   * Test/embedding seam: drive a pre-built tileset (real or mock) instead of
   * constructing one from an archive URL. Sets the metadata used to default the
   * time window. Returns `this` for chaining.
   */
  attachTileset(tileset: DrivableTileset, metadata?: ArchiveMetadata): this {
    this.tileset = tileset;
    // A fresh tileset numbers its frames from scratch: the first update must
    // walk, whatever the previous one last reported.
    this.lastPublishedFrame = -1;
    if (metadata) this.metadata = metadata;
    return this;
  }

  /** Build the archive + tileset from the URL (idempotent; safe to await repeatedly). */
  async load(): Promise<void> {
    if (this.tileset) return;
    if (this.inflightInit) return this.inflightInit;
    this.inflightInit = this._load();
    try {
      await this.inflightInit;
    } finally {
      this.inflightInit = null;
    }
  }

  private async _load(): Promise<void> {
    const archive = new STTArchive({ url: this.url, fetch: this.fetchImpl });
    const metadata = await archive.getMetadata();
    if (this.disposed) {
      archive.finalize?.();
      return;
    }
    this.archive = archive;
    this.metadata = metadata;

    // Summary-tier auto dispatch (parity with the deck path): derive the
    // aggregated-cell zoom band from the archive metadata unless the host set
    // one explicitly. The matching `getAvailableSummaryTiles` callback is wired
    // by `makeTilesetCallbacks(archive, metadata)` — both are capability-gated,
    // so an archive without a summary tier is byte-identical to before.
    const summaryTier = metadata.summaryTier;
    const summaryZoomRange =
      this.optSummaryZoomRange ??
      (summaryTier
        ? { minZoom: summaryTier.minZoom, maxZoom: summaryTier.maxZoom }
        : undefined);

    const tileset = new SpatioTemporalTileset({
      minZoom: metadata.minZoom,
      maxZoom: metadata.maxZoom,
      temporalBucketMs: metadata.temporalBucketMs,
      lodMode: this.lodMode,
      refinementStrategy: 'best-available',
      maxRequests: this.maxRequests,
      maxCacheSize: this.maxCacheSize,
      maxCacheByteSize: this.maxCacheByteSize,
      enablePrefetch: this.enablePrefetch,
      debounceTime: this.debounceTime,
      prefetchAhead: this.prefetchAhead,
      prefetchSteps: this.prefetchSteps,
      tier: this.tier,
      summaryZoomRange,
      // Scrub-LOD motion tier (kill-switched off unless an axis is enabled).
      scrubLod: this.scrubLod,
      // Archive-backed fetch callbacks (getAvailableTiles / getTileData /
      // getTileDataBatch / getTileByteSize / getThroughput / summary tiles) —
      // shared with the deck path via the core adapter.
      ...makeTilesetCallbacks(archive, metadata),
      // Tiles arrive — and leave — AFTER the synchronous update() returns,
      // one callback per tile. Both edges mark the resident set stale and
      // re-derive it ONCE per task (audit E5): a burst of M arrivals used to
      // cost M replace-all `setTiles` rebuilds (O(N·M) point packing + M GPU
      // re-uploads), and evictions were not surfaced at all, so an evicted
      // tile's points stayed on the GPU until some later change moved the set.
      onTileLoad: () => this.schedulePublish(),
      onTileUnload: () => this.schedulePublish(),
    } as ConstructorParameters<typeof SpatioTemporalTileset>[0]);
    this.tileset = tileset;

    // Storyboard tier (WS-C4, parity with the deck path): kick the budget-gated
    // overview preload WITHOUT blocking init — the pinned coarse tiles ride the
    // lowest request tier behind viewport work and give a scrub a parent-zoom
    // fallback to render. The gate may reject the dataset (giant coarse tiles).
    if (this.overviewPreload) {
      const overviewOpts =
        typeof this.overviewPreload === 'object'
          ? this.overviewPreload
          : undefined;
      void tileset.preloadOverviewTier(overviewOpts).then(() => {
        // A finished preload can pin new resident tiles — surface them.
        if (!this.disposed) this.publishIfChanged();
      });
    }
  }

  /** Resolved archive metadata, once loaded. */
  getMetadata(): ArchiveMetadata | null {
    return this.metadata;
  }

  /** The underlying tileset (for buffer-source wiring), once built. */
  getTileset(): DrivableTileset | null {
    return this.tileset;
  }

  /** The archive (for direct queries), once loaded. */
  getArchive(): STTArchive | null {
    return this.archive;
  }

  /** Register/replace the resident-set listener. */
  setOnTilesChanged(cb: (tiles: Tile[]) => void): void {
    this.onTilesChanged = cb;
  }

  /**
   * Pump a viewport into the tileset, then publish the resident set if it
   * changed. `time` is absolute ms; `timeWindow` defaults to the archive's
   * `temporalBucketMs`. Safe before `load()` resolves (no-op until then).
   */
  update(viewport: StreamingViewport): void {
    if (!this.tileset) return;
    const timeWindow =
      viewport.timeWindow ??
      this.optTimeWindowMs ??
      this.metadata?.temporalBucketMs ??
      3600 * 1000;
    const frame = this.tileset.update({
      bounds: viewport.bounds,
      zoom: viewport.zoom,
      time: viewport.time,
      timeWindow,
    });
    // Same frame number ⇒ the visible set cannot have changed through the
    // update path since the last publish — skip the diff walk (a host pumps
    // this every frame; the walk is O(resident) with a Set allocation).
    if (frame !== this.lastPublishedFrame) {
      this.lastPublishedFrame = frame;
      this.publishPending = true;
    }
    // Flush here rather than wait for the microtask: `tileset.update()` has
    // returned, so any eviction it ran synchronously is complete, and the
    // frame that drove the tileset gets the corrected set inside itself.
    this.flushPublish();
  }

  /**
   * Coalesce resident-set changes: mark stale, re-derive once at the end of
   * the current task. A microtask, not a frame callback, because the browser
   * cannot paint between a task and its microtask drain — so a correction
   * always beats the next frame to the screen — and because core fires the
   * unload callback BEFORE it deletes the header, so a re-derive inside the
   * callback would still see the evicted tile as resident.
   */
  private schedulePublish(): void {
    this.publishPending = true;
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    queueMicrotask(() => {
      this.publishScheduled = false;
      this.flushPublish();
    });
  }

  /** Run a queued republish now, if one is outstanding. */
  private flushPublish(): void {
    if (!this.publishPending) return;
    this.publishPending = false;
    this.publishIfChanged();
  }

  /** Forward playback animation state to the tileset (keeps prefetch alive while gated). */
  setAnimationState(isAnimating: boolean, speed = 0): void {
    this.tileset?.setAnimationState?.(isAnimating, speed);
  }

  /**
   * Forward the interactive/motion bit to the tileset for scrub-LOD. No-op
   * unless a {@link StreamingTileSourceOptions.scrubLod} axis is enabled — the
   * tileset stores the bit and changes nothing otherwise (the kill switch).
   * Normally driven by the PlaybackGovernor through
   * {@link TilesetBufferSource.setInteractive}; also exposed here for hosts
   * without a governor.
   */
  setInteractive(interactive: boolean): void {
    this.tileset?.setInteractive?.(interactive);
  }

  /** Current resident set (loaded tiles for the latest viewport). */
  getVisibleTiles(): Tile[] {
    return this.tileset ? this.tileset.getVisibleTiles() : [];
  }

  /** Recompute the resident set; fire `onTilesChanged` only on a real change. */
  private publishIfChanged(): void {
    if (!this.tileset) return;
    const next = this.tileset.getVisibleTiles();
    if (residentSetEqual(this.resident, next)) return;
    this.resident = next;
    this.onTilesChanged?.(next);
  }

  dispose(): void {
    this.disposed = true;
    // AFTER clear(): it fires onTileUnload per header, which re-arms the flag.
    this.tileset?.clear?.();
    this.archive?.finalize?.();
    this.tileset = null;
    this.archive = null;
    this.resident = [];
    this.publishPending = false;
    this.onTilesChanged = undefined;
  }
}

// ── Camera → viewport ───────────────────────────────────────────────────────

/**
 * Web-Mercator tile-pyramid constants. A slippy-map zoom `z` tiles the world
 * into `2^z × 2^z` tiles of {@link TILE_SIZE_PX} pixels, so the ground
 * resolution at the equator is `circumference / (TILE_SIZE_PX · 2^z)` metres
 * per pixel. Inverting that gives a zoom from a measured ground resolution.
 */
const TILE_SIZE_PX = 512;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;

/**
 * Shallowest depression below horizontal, in radians, at which a camera ray is
 * still allowed to reach the ground.
 *
 * A ray aimed AT or ABOVE the horizon has no ground point at all, and the old
 * code simply dropped those corners. That is what collapses a pitched viewport:
 * at `pitch ≥ 90 − fov/2` (65° at fov 50) BOTH top corners go, exactly two
 * symmetric bottom corners survive — too many for any `hits.length < 2` fallback
 * to fire — and their AABB is a ZERO-HEIGHT LINE along the bottom screen edge.
 * One degree shallower the same box spans 100° of longitude. That explode-then-
 * collapse pair across a single degree of tilt is the flash users report.
 *
 * So above-horizon rays are CLIPPED here rather than dropped, and the clip angle
 * is deck's: `@math.gl/web-mercator`'s `getProjectionParameters` clamps the top
 * plane's ground angle to a 0.01 rad minimum when sizing the far plane, and
 * `getBounds` then reads its top corners off that far plane
 * (`unprojectOnFarPlane`). Clamping the ray angle directly reproduces the same
 * footprint without depending on whatever `camera.far` the host happens to have
 * set — a Three camera's far plane is a clipping decision, not a horizon one.
 *
 * 0.01 rad puts the far edge at ~100× the camera height. The resulting tile
 * count under steep pitch is much larger than today's — see §4.4 of
 * docs/roadmap/tile-loading-3d-2026-07.md: today's is a 36 %-coverage
 * UNDER-selection, and the rise is the fix, not a regression to tune back down.
 *
 * The angle is only half the guard. WHEN it is applied — from the ray's own
 * depression rather than from whether the surface solve failed — is what makes
 * the footprint bounded on both sides of the singularity; see
 * {@link groundPointForRay}.
 */
const HORIZON_MIN_DEPRESSION_RAD = 0.01;

/**
 * Rays cast per axis across NDC (so `5 × 5 = 25` ground samples, boundary
 * included).
 *
 * Four corners are exactly right for an unclipped planar ground quad — it is
 * convex with straight edges, so its AABB is pinned by its vertices. They are
 * NOT enough for either of the two cases this function must now handle:
 *
 * - **Horizon-clipped.** The far edge becomes an ARC at constant depression.
 *   Its chord (corner to corner) cuts ~18 % off the forward reach at a 70°
 *   horizontal FOV — a missing row of tiles at the top of a pitched frame.
 * - **Globe.** Lon/lat is a curved function of the ECEF hit, so the edges bow
 *   outside the corner box.
 *
 * A 5-per-axis grid leaves at most a 17.5° gap along that arc (~1.2 % sag) and
 * costs 25 unprojections a few times a second. On the unclipped planar case it
 * returns exactly the four-corner answer, because every interior sample lands
 * inside the hull.
 */
const GROUND_SAMPLES_PER_AXIS = 5;

/**
 * Slack added before flooring the continuous zoom.
 *
 * `cameraToViewState` inverts `viewStateToCamera` through a chain of
 * `tan`/`log2`/distance round-trips, so a view state authored at an exact
 * integer zoom comes back as e.g. `13.999999999999939` (measured: z14/pitch 45,
 * and z9 on the globe). `Math.floor` then hands the tileset zoom 13 and the
 * whole frame renders one level too coarse — from a rounding error, at the most
 * common camera there is. 1e-9 is six orders above the observed noise and eleven
 * below anything a real camera move produces.
 */
const ZOOM_FLOOR_EPSILON = 1e-9;

/**
 * Where a ray that never reaches the surface should be treated as landing.
 *
 * Planar frames have no true horizon point, so the ray is tilted down to
 * {@link HORIZON_MIN_DEPRESSION_RAD} keeping its azimuth. Globe frames DO have
 * one — the limb — so the ray is snapped to the tangent point in its own plane,
 * at the exact limb half-angle `acos(radius / distance)`.
 *
 * `null` only for rays with no meaningful ground azimuth at all (straight up
 * from a planar camera, straight out from the planet centre) or a camera at or
 * below the surface.
 */
function clipAtHorizon(
  proj: Projection,
  origin: Vector3,
  dir: Vector3,
): Vector3 | null {
  if (proj.kind === 'globe') {
    const radius = surfaceRadius(proj);
    const distance = origin.length();
    if (!(distance > radius)) return null;
    const up = origin.clone().divideScalar(distance);
    const tangent = dir.clone().addScaledVector(up, -dir.dot(up));
    if (tangent.lengthSq() < 1e-12) return null;
    tangent.normalize();
    const cosLimb = radius / distance;
    const sinLimb = Math.sqrt(Math.max(0, 1 - cosLimb * cosLimb));
    return up
      .multiplyScalar(radius * cosLimb)
      .addScaledVector(tangent, radius * sinLimb);
  }
  if (!(origin.z > 0)) return null;
  const azimuth = Math.hypot(dir.x, dir.y);
  if (azimuth < 1e-12) return null;
  const sinDepression = Math.sin(HORIZON_MIN_DEPRESSION_RAD);
  const cosDepression = Math.cos(HORIZON_MIN_DEPRESSION_RAD);
  const t = origin.z / sinDepression;
  return new Vector3(
    origin.x + (dir.x / azimuth) * cosDepression * t,
    origin.y + (dir.y / azimuth) * cosDepression * t,
    0,
  );
}

/**
 * Where a camera ray should be treated as reaching the ground — the surface
 * solve, the horizon clip, or nowhere.
 *
 * The branch is decided from the RAY GEOMETRY, before the solve, and that is the
 * entire point of this function. Wave 2 shipped the clip as a FALLBACK for the
 * solve —
 *
 *     intersectSurface(proj, camPos, dir) ?? clipAtHorizon(proj, camPos, dir)
 *
 * — which reads as "clip the rays that cannot reach the ground". It is not what
 * it does. A ray a hundredth of a degree BELOW horizontal reaches the ground
 * perfectly well, about 5,700 camera heights out; the solve returns that point
 * and the clip is never consulted. So the guard caught only the far side of the
 * 1/tan(depression) singularity — the collapse — and left the near side, the
 * EXPLODE, running unbounded. Measured at z9 on 1440×900 (see
 * `camera-viewport.test.ts`), the box grew to lon [-180, 180] × lat [40.3,
 * 89.999] at pitch 64.95 and snapped back to 62.7° × 29.7° at 65.00. Twice, in
 * fact: each row of the NDC sample grid has its own pitch at which it goes
 * horizontal, and the second one (ny = 0.5) fires at 76.88 and reaches further.
 * A full-planet tile scan flashing past inside one degree of a smooth camera
 * move is exactly the flash users reported.
 *
 * deck resolves the same singularity the same way: `@math.gl/web-mercator`'s
 * `getBounds` tests `halfFov > angleToGround - 0.01` and substitutes the far
 * plane for its top corners BEFORE it casts. The substitution is a property of
 * the camera, never of what a cast happened to return.
 *
 * Because {@link clipAtHorizon} projects along exactly
 * {@link HORIZON_MIN_DEPRESSION_RAD} and the test switches at exactly that
 * angle, the two branches AGREE at the crossover — both place the point
 * `height / tan(θ)` out along the ray's azimuth — so the footprint is continuous
 * through it. That continuity, not the clip itself, is what the pitch sweep in
 * `camera-viewport.test.ts` pins.
 */
function groundPointForRay(
  proj: Projection,
  origin: Vector3,
  dir: Vector3,
): Vector3 | null {
  // Planar frames only, and only for a camera above the plane.
  //
  // A globe needs NO minimum-depression clamp and must not be given one. Its
  // solve is against a FINITE sphere, so a grazing ray lands on the limb, not
  // 5,700 heights downrange — `intersectSurface` is already bounded, and it
  // already meets `clipAtHorizon`'s tangent point continuously as the ray slides
  // past the limb (the tangent point IS the limit of the grazing intersection).
  // Clamping there would instead DISCARD near-limb ground that a globe camera
  // genuinely sees. Measured over the same 55°→85° sweep at 0.05° steps, the
  // globe path's sharpest step is ×1.099 — grid-sampling wobble on a curved
  // surface, not a singularity.
  //
  // Below the plane there is no horizon to reason about (`clipAtHorizon` would
  // return null and drop the sample), so the old solve-or-nothing behaviour is
  // kept byte-for-byte for a sub-surface camera.
  if (proj.kind !== 'globe' && origin.z > 0) {
    // `dir` is unit, so this is `asin(-dir.z)`; the two-argument form keeps the
    // answer right for a ray that is not quite normalized and is exact at the
    // straight-up / straight-down poles.
    const depression = Math.atan2(-dir.z, Math.hypot(dir.x, dir.y));
    if (!(depression >= HORIZON_MIN_DEPRESSION_RAD)) {
      return clipAtHorizon(proj, origin, dir);
    }
  }
  return (
    intersectSurface(proj, origin, dir) ?? clipAtHorizon(proj, origin, dir)
  );
}

/**
 * Is the geographic pole at `sign · 90°` both inside the frustum and on the near
 * side of the globe?
 *
 * A lon/lat AABB of ray hits is simply the wrong shape once the frame CONTAINS
 * a pole, and no amount of extra sampling fixes it: the visible patch is a CAP,
 * every meridian runs through it, and latitude turns back DOWN once the frame
 * steps over the pole. A globe camera centred at lat 89 / z2 on 1440×900 — the
 * pole 0.72 of the way up the screen — reported
 * `{minLat: 86.699, maxLat: 89.691, minLon: -109.456, maxLon: 180}`: the pole it
 * is staring straight at outside its own viewport box, and the longitudes it did
 * report an artefact of where the 5×5 grid happened to land rather than a bound
 * on anything. The samples cannot detect this themselves — the grid's
 * northernmost row lands short of 90 either way, and an AABB has no way to know
 * it stepped OVER the pole rather than up to it.
 *
 * So the test is geometric, and it is a FRUSTUM test rather than a latitude
 * threshold because the two disagree over exactly the cameras that matter: at
 * the same lat 89 centre one zoom in, the pole sits at NDC y = 1.44, just off
 * the top edge, and the sampled box is then genuinely correct (its widest
 * longitude IS a corner sample). Widening there would scan every column on the
 * planet for a 150°-wide frame. Two conditions, both required:
 *
 * - **Facing.** The outward normal at a pole is the ECEF ±Z axis exactly — on
 *   the sphere and on the WGS84 ellipsoid alike, since the poles lie on the axis
 *   of symmetry — so the pole faces the camera iff the camera sits on its
 *   outward side. Without this a zoomed-out equatorial view would widen for a
 *   pole that is behind the planet.
 * - **Frustum.** In front of the camera FIRST, then inside the NDC square.
 *   `Vector3.project` divides by `w`, and `w` is negative behind the camera,
 *   which flips both NDC axes and makes a point 180° away test as on screen.
 */
function poleOnScreen(
  proj: Projection,
  camera: PerspectiveCamera,
  sign: 1 | -1,
): boolean {
  const [px, py, pz] = proj.project(0, sign * 90, 0);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
    return false;
  }
  const pole = new Vector3(px, py, pz);
  if (!(camera.position.clone().sub(pole).dot(pole) > 0)) return false;
  const inCamera = pole.clone().applyMatrix4(camera.matrixWorldInverse);
  if (!(inCamera.z < 0)) return false;
  const ndc = pole.clone().project(camera);
  return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
}

/**
 * Bring `lon` into the same unwrapped turn as `reference`.
 *
 * `GlobeProjection.unproject` ends in `atan2`, so it always reports lon in
 * `[-180, 180]`: a globe view straddling the antimeridian samples −179.5 and
 * +179.5 and their AABB claims 359° of the planet — the long way round, every
 * tile except the ones on screen. Re-referencing each sample to the view centre
 * instead yields `[179.5, 180.5]`, the UNWRAPPED box the core tile scan wants
 * (`tileXSpanForLonRange` walks unwrapped column space and wraps at emit; see
 * §4.1 rule 4 of the plan). Planar frames need none of this — their `unproject`
 * is linear in world x and already unwrapped.
 */
function unwrapLon(lon: number, reference: number): number {
  return lon + 360 * Math.round((reference - lon) / 360);
}

/**
 * Derive `{bounds, zoom}` from a {@link Projection} and a Z-up
 * `PerspectiveCamera` by casting a grid of NDC rays at the projection's
 * reference surface and converting the hits back to lon/lat.
 *
 * - **bounds**: lon/lat AABB of the ground samples, repaired by the shared
 *   `normalizeViewportBounds` (ordering, the antimeridian-crossing-vs-inversion
 *   test, the full-world collapse). Rays above the horizon are CLIPPED at it,
 *   never dropped.
 * - **zoom**: `floor(cameraToViewState(...).zoom)`. Flooring is required and
 *   correct — the directory is keyed by integer z, and a fractional zoom makes
 *   `getAvailableTiles` query a level that does not exist, selecting nothing.
 *
 * Returns **`null`** when the camera yields no usable box — a canvas that has
 * not been laid out yet, or a camera whose matrices came out non-finite. The
 * caller must then KEEP ITS PREVIOUS VIEWPORT (the simplest form of which is:
 * skip the `tileset.update` for this frame). Selecting against a NaN box is
 * strictly worse than selecting against a slightly stale one — it makes
 * `boundsToTiles` enumerate nothing while every readiness signal still reports
 * settled and fully buffered. §4.1 rule 1.
 */
export function cameraToViewport(
  proj: Projection,
  camera: PerspectiveCamera,
  viewportPx: { width: number; height: number },
  opts: { minZoom?: number; maxZoom?: number } = {},
): { bounds: BoundingBox; zoom: number } | null {
  // A canvas that has not been laid out yet reports 0×0 (and r3f then hands the
  // camera an aspect of 0 or NaN). Nothing downstream can recover from that, and
  // the zoom in particular is scaled by the viewport height, so bail before
  // fabricating a plausible-looking box from it.
  if (!(viewportPx.width > 0) || !(viewportPx.height > 0)) return null;

  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const camPos = camera.position.clone();

  // The view centre serves twice: it is the reference turn for globe longitude
  // unwrapping, and its zoom is the zoom. Deriving zoom from the ground AABB
  // instead (the old `zoomFromCamera`) measured the wrong thing four different
  // ways at once — it took the LARGER of the two ground spans and divided by the
  // viewport WIDTH, so a pitched frame read 2–5 levels too coarse, a portrait
  // canvas 0.83 too coarse and a 90°-rotated one 0.14 off. The view state's zoom
  // comes straight from the camera distance and the vertical FOV, which is what
  // the tile pyramid is defined against, and is invariant to all three.
  const view = cameraToViewState(proj, camera, {
    viewportHeight: viewportPx.height,
  });

  const samples: Array<[number, number]> = [];
  const far = new Vector3();
  const dir = new Vector3();
  const steps = GROUND_SAMPLES_PER_AXIS - 1;
  for (let iy = 0; iy <= steps; iy++) {
    const ny = -1 + (2 * iy) / steps;
    for (let ix = 0; ix <= steps; ix++) {
      const nx = -1 + (2 * ix) / steps;
      // NDC on the far plane (z = 1) gives a point along the ray through this
      // pixel; the ray itself is what we intersect, so the far plane's distance
      // never enters the answer.
      far.set(nx, ny, 1).unproject(camera);
      dir.copy(far).sub(camPos).normalize();
      const hit = groundPointForRay(proj, camPos, dir);
      if (!hit) continue;
      // `hit.z` matters on the globe — it is an ECEF point on the sphere, not a
      // planar ground point, and passing 0 is precisely the bug that made every
      // globe camera report latitude 0.
      const [lon, lat] = proj.unproject(hit.x, hit.y, hit.z);
      samples.push([
        proj.kind === 'globe' ? unwrapLon(lon, view.longitude) : lon,
        lat,
      ]);
    }
  }

  // `boundsFromCorners` skips non-finite components PER AXIS, so one diverged
  // sample costs that axis one contribution instead of poisoning the whole box.
  const raw = boundsFromCorners(samples);

  // Polar widening. Where the sample AABB under-reports because the frame
  // CONTAINS a pole, extend it to the geometry the samples cannot express: the
  // full longitude circle (every meridian passes through the visible cap) and
  // the pole's own latitude. See {@link poleOnScreen} for why sampling harder
  // does not help. Applied before `normalizeViewportBounds`, so the exactly-360°
  // span lands on its full-world rule rather than being carried through as a
  // suspiciously wide box.
  if (raw && proj.kind === 'globe') {
    if (poleOnScreen(proj, camera, 1)) {
      raw.maxLat = 90;
      raw.minLon = -180;
      raw.maxLon = 180;
    }
    if (poleOnScreen(proj, camera, -1)) {
      raw.minLat = -90;
      raw.minLon = -180;
      raw.maxLon = 180;
    }
  }
  const normalized = raw ? normalizeViewportBounds(raw) : null;
  if (!normalized || !Number.isFinite(view.zoom)) return null;

  return {
    bounds: normalized.bounds,
    zoom: clamp(
      Math.floor(view.zoom + ZOOM_FLOOR_EPSILON),
      opts.minZoom ?? -Infinity,
      opts.maxZoom ?? Infinity,
    ),
  };
}

/**
 * Slippy-map zoom from the camera's visible ground resolution.
 *
 * Measures metres-per-pixel as `(visible ground width in world metres) /
 * viewport-width-px`, converts world units to true metres via the projection's
 * `metersPerWorldUnit`, then inverts the web-mercator
 * `metresPerPixel = (circumference · cos(lat)) / (TILE_SIZE_PX · 2^z)`.
 *
 * When the ground hits are unavailable it falls back to the camera distance to
 * the ground × the vertical FOV as the visible span (the classic
 * `2·tan(fov/2)·distance` extent).
 *
 * @deprecated Not used for tile selection any more, and do not adopt it for a
 * new one. Measured against a real camera it is wrong four ways at once: it
 * takes the LARGER of the two ground-hit spans yet divides by the viewport
 * WIDTH, so a pitched frame reads 2–5 zoom levels too coarse, a portrait canvas
 * 0.83 too coarse and a 90°-rotated one 0.14 off, and the `log2` lands a hair
 * under an exact integer so even a flat north-up camera floors one level down.
 * {@link cameraToViewport} now takes `cameraToViewState(...).zoom`, which is
 * derived from the camera distance and vertical FOV and is invariant to all
 * four. Kept only because it is exported from `@poopdeck.gl/three/internal`.
 */
export function zoomFromCamera(
  proj: Projection,
  camera: PerspectiveCamera,
  viewportPx: { width: number; height: number },
  centerLat: number,
  hits?: Vector3[],
): number {
  // Visible ground width in WORLD units. Prefer the actual ground-hit span
  // (matches the real footprint under tilt); fall back to the FOV extent.
  let groundWidthWorld: number;
  if (hits && hits.length >= 2) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const h of hits) {
      minX = Math.min(minX, h.x);
      maxX = Math.max(maxX, h.x);
      minY = Math.min(minY, h.y);
      maxY = Math.max(maxY, h.y);
    }
    // Use the larger horizontal span as the "viewport width" proxy.
    groundWidthWorld = Math.max(maxX - minX, maxY - minY);
  } else {
    const fov = (camera.fov * Math.PI) / 180;
    const dist = Math.max(Math.abs(camera.position.z), 1);
    groundWidthWorld = 2 * Math.tan(fov / 2) * dist;
  }
  groundWidthWorld = Math.max(groundWidthWorld, 1e-6);

  // World units → true ground metres at the view centre.
  const mpwu = proj.metersPerWorldUnit(0, centerLat) || 1;
  const groundWidthMeters = groundWidthWorld * mpwu;

  const widthPx = Math.max(viewportPx.width, 1);
  const metersPerPixel = groundWidthMeters / widthPx;

  // Invert the mercator ground-resolution formula. cos(lat) corrects the
  // mercator stretch so the zoom matches the tile pyramid the archive was
  // built on.
  const cosLat = Math.max(Math.cos((centerLat * Math.PI) / 180), 1e-3);
  const z = Math.log2(
    (EARTH_CIRCUMFERENCE * cosLat) / (TILE_SIZE_PX * metersPerPixel),
  );
  return Number.isFinite(z) ? z : 0;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ── Real BufferSource backed by the tileset ─────────────────────────────────

/**
 * The tileset surface {@link TilesetBufferSource} reads. The real
 * {@link SpatioTemporalTileset} satisfies it; tests pass a mock.
 */
export interface RunwayTileset {
  getBufferedRunway(
    time: number,
    direction: 1 | -1,
    horizonSimMs?: number,
  ): CoreBufferedRunway;
  getBufferedRanges(opts?: {
    maxRanges?: number;
  }): Array<{ start: number; end: number }>;
  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  };
  estimateTimeToReadyMs(range: { start: number; end: number }): number | null;
  flushPrefetch(): void;
  setAnimationState?(isAnimating: boolean, speed?: number): void;
  setInteractive?(interactive: boolean): void;
  setPrefetchRunAheadLimit?(simMs: number | null): void;
  setBandwidthWeight?(weight: number): void;
}

/**
 * The REAL playback {@link BufferSource} for a streaming tileset — every method
 * delegates straight to the core tileset's coverage-index math (runway / ranges
 * / cost / ETA / flush). This replaces the faked `createCompleteBufferSource`
 * (which reports `complete: true` / `Infinity` runway unconditionally) for
 * datasets that actually stream: the playback governor then gates honestly on
 * how much sim-time ahead of the play head is genuinely loaded.
 *
 * Register it with the same source id / `required` flags the deck path uses so
 * stream toggles reconcile identically (see source-registry.ts).
 */
export class TilesetBufferSource implements BufferSource {
  constructor(private readonly tileset: RunwayTileset) {}

  getBufferedRunway(
    time: number,
    direction: 1 | -1,
    horizonSimMs?: number,
  ): BufferedRunway {
    const r = this.tileset.getBufferedRunway(time, direction, horizonSimMs);
    return {
      simMs: r.simMs,
      bytesPending: r.bytesPending,
      horizonSimMs: r.horizonSimMs,
      complete: r.complete,
    };
  }

  getBufferedRanges(opts?: {
    maxRanges?: number;
  }): Array<{ start: number; end: number }> {
    return this.tileset.getBufferedRanges(opts);
  }

  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  } {
    return this.tileset.estimateCost(range);
  }

  estimateTimeToReadyMs(range: { start: number; end: number }): number | null {
    return this.tileset.estimateTimeToReadyMs(range);
  }

  flushPrefetch(): void {
    this.tileset.flushPrefetch();
  }

  setAnimationState(isAnimating: boolean, speed?: number): void {
    this.tileset.setAnimationState?.(isAnimating, speed);
  }

  // Scrub-LOD interactive bit. The PlaybackGovernor broadcasts
  // `true` on beginScrub / `false` on endScrub through this optional hook, so a
  // streaming tileset can serve a cheaper motion tier while the user drags the
  // timeline. Without this forward the governor's optional-chained call silently
  // no-ops for every three-renderer source. Inert unless a `scrubLod` axis is
  // enabled on the tileset (the kill switch).
  setInteractive(interactive: boolean): void {
    this.tileset.setInteractive?.(interactive);
  }

  // Run-ahead fairness + dynamic fair-share weight for multi-source playback.
  // Without these forwards the governor's optional-chained calls silently
  // no-op for every three-renderer source while the deck path cooperates.
  setPrefetchRunAheadLimit(simMs: number | null): void {
    this.tileset.setPrefetchRunAheadLimit?.(simMs);
  }

  setBandwidthWeight(weight: number): void {
    this.tileset.setBandwidthWeight?.(weight);
  }
}

/**
 * Convenience factory: a {@link TilesetBufferSource} over a
 * {@link StreamingTileSource}'s tileset, or `null` before it has loaded.
 */
export function createTilesetBufferSource(
  source: StreamingTileSource,
): TilesetBufferSource | null {
  const ts = source.getTileset();
  // The streaming tileset implements the runway surface; narrow structurally.
  if (
    ts &&
    typeof (ts as Partial<RunwayTileset>).getBufferedRunway === 'function'
  ) {
    return new TilesetBufferSource(ts as unknown as RunwayTileset);
  }
  return null;
}
