// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `StreamingTileSource` — viewport-driven streaming for the Three renderer.
 *
 * Where {@link SttTileSource} eagerly loads a whole (small, local) AV archive,
 * this source WRAPS the core {@link SpatiotemporalTileset} so the heavy
 * multi-km clouds stream like the deck renderer: a camera-derived
 * `{bounds, zoom, time}` drives `tileset.update`, the tileset selects/loads/
 * prefetches/evicts, and on every change we hand the layer the fresh
 * {@link SpatiotemporalTileset.getVisibleTiles} set (replace-all — incremental
 * residency is a later optimization). It deliberately REUSES the core tileset's
 * selection/buffer machinery rather than reimplementing any of it.
 *
 * Three responsibilities, all thin:
 *   1. {@link StreamingTileSource.update} — pump a viewport into the tileset and,
 *      when the visible/resident set actually changed, fire `onTilesChanged`.
 *   2. {@link cameraToViewport} — turn a {@link Projection} + Three
 *      `PerspectiveCamera` into `{bounds, zoom}` by unprojecting the four NDC
 *      frustum corners onto the ground (z = 0) plane and deriving a slippy-map
 *      zoom from the visible ground resolution.
 *   3. {@link TilesetBufferSource} — the REAL playback `BufferSource` backed by
 *      the tileset's pending/loaded coverage state (runway / ranges / cost /
 *      ETA), replacing the faked `createCompleteBufferSource` for streaming
 *      datasets where "everything is buffered" is a lie.
 *
 * The buffer/builder split convention (a PURE testable core + a thin GPU/Three
 * wrapper) is honoured here too: the resident-diffing and the BufferSource are
 * Three-free and unit-tested; {@link cameraToViewport} is the only Three-coupled
 * piece (verified visually).
 */

import { STTArchive } from '@poopdeck.gl/core';
import type {
  ArchiveMetadata,
  BoundingBox,
  Tile,
} from '@poopdeck.gl/core';
import {
  SpatiotemporalTileset,
  type BufferedRunway as CoreBufferedRunway,
} from '@poopdeck.gl/core';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';
import { PerspectiveCamera, Vector3 } from 'three';
import type { Projection } from '../projection/local-enu';
import { EARTH_RADIUS } from '../projection/local-enu';

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
   * Fired (async, after the tileset's `getVisibleTiles` changes) with the fresh
   * resident set. The layer re-calls `layer.setTiles(tiles, ctx)`. Receives the
   * SAME `Tile[]` instance order `getVisibleTiles` returns.
   */
  onTilesChanged?: (tiles: Tile[]) => void;
}

/**
 * Stable identity key for a {@link Tile} used by the resident-set diff. A tile's
 * `id` (`z/x/y/t`) is its address; two `getVisibleTiles` calls that return the
 * same addresses describe the same resident set even if the array order or the
 * `Tile` object identities differ.
 */
export function tileKey(tile: Tile): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}`;
}

/** `true` when two tile arrays describe the same resident set (by address). */
export function residentSetEqual(a: readonly Tile[], b: readonly Tile[]): boolean {
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
 * {@link SpatiotemporalTileset} satisfies it; tests pass a mock. Keeping it
 * structural lets the unit test exercise the update-pump + resident diff
 * without a network/archive.
 */
export interface DrivableTileset {
  update(
    viewport: { bounds: BoundingBox; zoom: number; time: number; timeWindow: number },
    skipDebounce?: boolean,
  ): number;
  getVisibleTiles(): Tile[];
  setAnimationState?(isAnimating: boolean, speed?: number): void;
  clear?(): void;
}

/**
 * Wraps a {@link SpatiotemporalTileset} (or any {@link DrivableTileset}) and
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
  private onTilesChanged?: (tiles: Tile[]) => void;

  /** Last resident set published to `onTilesChanged` (for diffing). */
  private resident: Tile[] = [];
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
    this.onTilesChanged = opts.onTilesChanged;
  }

  /**
   * Test/embedding seam: drive a pre-built tileset (real or mock) instead of
   * constructing one from an archive URL. Sets the metadata used to default the
   * time window. Returns `this` for chaining.
   */
  attachTileset(tileset: DrivableTileset, metadata?: ArchiveMetadata): this {
    this.tileset = tileset;
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

    this.tileset = new SpatiotemporalTileset({
      minZoom: metadata.minZoom,
      maxZoom: metadata.maxZoom,
      temporalBucketMs: metadata.temporalBucketMs,
      lodMode: this.lodMode,
      refinementStrategy: 'best-available',
      maxRequests: this.maxRequests,
      maxCacheSize: this.maxCacheSize,
      maxCacheByteSize: this.maxCacheByteSize,
      enablePrefetch: this.enablePrefetch,
      // Archive-backed fetch callbacks (getAvailableTiles / getTileData /
      // getTileDataBatch / getTileByteSize / getThroughput) — shared with the
      // deck path via the core adapter.
      ...makeTilesetCallbacks(archive),
      // A wired onTileLoad means tiles arrive after the synchronous update()
      // returns — re-publish the resident set so the layer picks them up.
      onTileLoad: () => this.publishIfChanged(),
    } as ConstructorParameters<typeof SpatiotemporalTileset>[0]);
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
    this.tileset.update({
      bounds: viewport.bounds,
      zoom: viewport.zoom,
      time: viewport.time,
      timeWindow,
    });
    this.publishIfChanged();
  }

  /** Forward playback animation state to the tileset (keeps prefetch alive while gated). */
  setAnimationState(isAnimating: boolean, speed = 0): void {
    this.tileset?.setAnimationState?.(isAnimating, speed);
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
    this.tileset?.clear?.();
    this.archive?.finalize?.();
    this.tileset = null;
    this.archive = null;
    this.resident = [];
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
 * Intersect the ray from `origin` along `dir` with the ground plane `z = 0`.
 * Returns the world point, or `null` when the ray is parallel to / points away
 * from the plane (a near-horizon corner that never hits the ground).
 */
function intersectGround(origin: Vector3, dir: Vector3): Vector3 | null {
  // Plane z = 0: solve origin.z + t·dir.z = 0.
  if (Math.abs(dir.z) < 1e-9) return null;
  const t = -origin.z / dir.z;
  if (!Number.isFinite(t) || t <= 0) return null;
  return new Vector3(
    origin.x + dir.x * t,
    origin.y + dir.y * t,
    0,
  );
}

/**
 * Derive `{bounds, zoom}` from a {@link Projection} and a Z-up
 * `PerspectiveCamera` by unprojecting the four NDC frustum corners onto the
 * ground plane and converting back to lon/lat.
 *
 * - **bounds**: lon/lat AABB of the (up to four) ground-plane hits. Corners that
 *   point above the horizon are skipped; a fallback box around the camera's
 *   nadir is used when fewer than two corners hit (steep up-tilt / looking at
 *   sky), so the tileset always gets a sane viewport.
 * - **zoom**: a slippy-map zoom from the visible ground resolution
 *   (metres-per-pixel across the viewport width), corrected for latitude
 *   (`cos(lat)` mercator stretch) so it matches the deck/maplibre tile pyramid.
 *
 * Pure-ish: needs Three's `Vector3.unproject`, so it lives here (not in the
 * unit-tested pure core) and is verified visually.
 */
export function cameraToViewport(
  proj: Projection,
  camera: PerspectiveCamera,
  viewportPx: { width: number; height: number },
  opts: { minZoom?: number; maxZoom?: number } = {},
): { bounds: BoundingBox; zoom: number } {
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const camPos = camera.position.clone();

  // NDC corners of the far plane (z = 1): unproject each to a world point, form
  // the ray from the camera, intersect the ground.
  const ndc: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const hits: Vector3[] = [];
  for (const [nx, ny] of ndc) {
    const far = new Vector3(nx, ny, 1).unproject(camera);
    const dir = far.sub(camPos).normalize();
    const hit = intersectGround(camPos, dir);
    if (hit) hits.push(hit);
  }

  // Fallback: too few ground hits (looking near/above the horizon). Build a
  // box around the camera's nadir sized by its altitude so streaming keeps a
  // sane footprint instead of an empty / world-spanning one.
  if (hits.length < 2) {
    const alt = Math.max(Math.abs(camPos.z), 1);
    const nadir = new Vector3(camPos.x, camPos.y, 0);
    hits.length = 0;
    hits.push(
      new Vector3(nadir.x - alt, nadir.y - alt, 0),
      new Vector3(nadir.x + alt, nadir.y + alt, 0),
    );
  }

  // World-space AABB → lon/lat AABB (unproject each corner; the projection may
  // be non-linear, so corners alone bound it on planar frames — adequate here).
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let sumLat = 0;
  for (const h of hits) {
    const [lon, lat] = proj.unproject(h.x, h.y, 0);
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
    sumLat += lat;
  }
  const centerLat = sumLat / hits.length;
  const bounds: BoundingBox = { minLon, minLat, maxLon, maxLat };

  const zoom = zoomFromCamera(proj, camera, viewportPx, centerLat, hits);
  const clampedZoom = clamp(
    zoom,
    opts.minZoom ?? -Infinity,
    opts.maxZoom ?? Infinity,
  );
  return { bounds, zoom: clampedZoom };
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
 * {@link SpatiotemporalTileset} satisfies it; tests pass a mock.
 */
export interface RunwayTileset {
  getBufferedRunway(time: number, direction: 1 | -1, horizonSimMs?: number): CoreBufferedRunway;
  getBufferedRanges(opts?: { maxRanges?: number }): Array<{ start: number; end: number }>;
  estimateCost(range: { start: number; end: number }): { bytes: number; tiles: number };
  estimateTimeToReadyMs(range: { start: number; end: number }): number | null;
  flushPrefetch(): void;
  setAnimationState?(isAnimating: boolean, speed?: number): void;
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

  getBufferedRunway(time: number, direction: 1 | -1, horizonSimMs?: number): BufferedRunway {
    const r = this.tileset.getBufferedRunway(time, direction, horizonSimMs);
    return {
      simMs: r.simMs,
      bytesPending: r.bytesPending,
      horizonSimMs: r.horizonSimMs,
      complete: r.complete,
    };
  }

  getBufferedRanges(opts?: { maxRanges?: number }): Array<{ start: number; end: number }> {
    return this.tileset.getBufferedRanges(opts);
  }

  estimateCost(range: { start: number; end: number }): { bytes: number; tiles: number } {
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
  if (ts && typeof (ts as Partial<RunwayTileset>).getBufferedRunway === 'function') {
    return new TilesetBufferSource(ts as unknown as RunwayTileset);
  }
  return null;
}
