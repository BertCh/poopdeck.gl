// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * react-three-fiber binding for the STT Three engine — `@poopdeck.gl/three/r3f`.
 *
 * A DECLARATIVE layer API: `<STTCanvas>` owns the `WebGPURenderer`, a Z-up camera,
 * `OrbitControls`, the ground, and a follow-ego rig; inside it you compose layer
 * components (`<STTSurfelLayer>`, `<STTPointCloudLayer>`, `<STTBoundingBoxLayer>`,
 * `<STTMapPolygonLayer>`, `<STTMapLineLayer>`, `<STTEgoLayer>`). r3f's reconciler
 * does the lifecycle: mounting a layer adds its object to the scene, unmounting
 * removes + disposes it, and React Strict Mode's double-invoke is handled
 * natively (no manual dispose dance). Tile loading is coordinated by React
 * Suspense — each layer suspends until its archive loads.
 *
 * Playback parity: each mounted layer registers a complete {@link BufferSource}
 * with the playback governor (via the `registry` prop) under the SAME stream id
 * the deck path uses, so the start/seek gate passes immediately and the cockpit's
 * buffered-range bar / Auto-speed / ETA light up. Without it the governor's
 * empty-source path can't pass the gate and the clock freezes for ~8 s on play.
 *
 * WebGPU: the `gl` factory is async — it `await`s `WebGPURenderer.init()` before
 * returning, and r3f v9 awaits that promise before its first render, so the
 * renderer is fully initialised up front (no blank frame, no warning).
 */

import * as React from 'react';
import { Canvas, useThree, useFrame, type GLProps } from '@react-three/fiber';
import { MapControls, OrbitControls } from '@react-three/drei';
import { WebGPURenderer } from 'three/webgpu';
import {
  Box3,
  RenderTarget,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { type GeoAnchor, type Projection } from '../projection/local-enu.js';
import {
  pickBoxes,
  type STTPickable,
  type STTPickInfo,
  type STTBoxPickInfo,
} from '../lib/box-pick.js';
import { isIdPickable, type STTIdPickable } from '../lib/id-pick.js';
import {
  GpuPicker,
  type PickRenderer,
  type RenderTargetCtor,
} from '../lib/gpu-pick.js';
import {
  createCompleteBufferSource,
  type STTSourceRegistry,
} from '../lib/source-registry.js';
import {
  createHighLimitDevice,
  resolveBackend,
} from '../renderer/webgpu-renderer.js';
import {
  createSTTAtmosphere,
  type AtmosphereOptions,
  type STTAtmosphere as AtmosphereHandle,
} from '../scene/atmosphere.js';
import {
  createSTT3DTiles,
  type STT3DTiles,
  type STT3DTilesOptions,
  type STT3DTilesSource,
} from '../scene/tiles-3d.js';
import {
  createSTTGlobeControls,
  type STTGlobeControls,
} from '../scene/globe-controls.js';
import { STTTileSource } from '../scene/tile-source.js';
import {
  StreamingTileSource,
  cameraToViewport,
  createTilesetBufferSource,
  type StreamingLayerOptions,
} from '../scene/streaming-tile-source.js';
import { makeGround, type GroundOptions } from '../scene/ground.js';
import { frameBox } from '../scene/camera.js';
import { frameGlobe } from '../scene/globe-camera.js';
import {
  updateCameraClip,
  viewStateToCamera,
  type ViewState,
} from '../projection/view-state.js';
import {
  isGlobeProjection,
  resolveCanvasProjection,
  globeControlLimits,
  groundControlLimits,
} from '../scene/projection-rig.js';
import type { STTLayer } from '../layers/layer.js';
import {
  STTSurfelLayer as SurfelLayerEngine,
  type STTSurfelLayerOptions,
} from '../layers/surfel-layer.js';
import {
  STTPointCloudLayer as PointCloudLayerEngine,
  type STTPointCloudLayerOptions,
} from '../layers/point-cloud-layer.js';
import {
  STTBoundingBoxLayer as BoundingBoxLayerEngine,
  type STTBoundingBoxLayerOptions,
} from '../layers/bounding-box-layer.js';
import {
  STTStaticPathLayer as StaticPathLayerEngine,
  type STTStaticPathLayerOptions,
} from '../layers/path-layer.js';
import {
  STTStaticPolygonLayer as StaticPolygonLayerEngine,
  type STTStaticPolygonLayerOptions,
  STTPolygonLayer as PolygonLayerEngine,
  type STTPolygonLayerOptions,
} from '../layers/polygon-layer.js';
import {
  STTEgoLayer as EgoLayerEngine,
  type STTEgoLayerOptions,
} from '../layers/ego-layer.js';
import {
  STTIsoLayer as IsoLayerEngine,
  type STTIsoLayerOptions,
} from '../layers/iso-layer.js';
import {
  STTTripsLayer as TripsLayerEngine,
  type STTTripsLayerOptions,
} from '../layers/trips-layer.js';
import {
  STTPathGeoLayer as PathGeoLayerEngine,
  type STTPathGeoLayerOptions,
} from '../layers/path-geo-layer.js';
import {
  STTOdLineLayer as OdLineLayerEngine,
  type STTOdLineLayerOptions,
} from '../layers/od-line-layer.js';
import {
  STTArcLayer as ArcLayerEngine,
  type STTArcLayerOptions,
} from '../layers/arc-layer.js';
import {
  STTIconLayer as IconLayerEngine,
  type STTIconLayerOptions,
} from '../layers/icon-layer.js';
import {
  STTColumnLayer as ColumnLayerEngine,
  type STTColumnLayerOptions,
} from '../layers/column-layer.js';
import {
  STTTripHeadsLayer as TripHeadsLayerEngine,
  type STTTripHeadsLayerOptions,
} from '../layers/trip-heads-layer.js';
import {
  STTQuadbinSummaryLayer as QuadbinSummaryLayerEngine,
  type STTQuadbinSummaryLayerOptions,
} from '../layers/quadbin-summary-layer.js';
import {
  STTH3SummaryLayer as H3SummaryLayerEngine,
  type STTH3SummaryLayerOptions,
} from '../layers/h3-summary-layer.js';
import {
  STTFlowmapLayer as FlowmapLayerEngine,
  type STTFlowmapLayerOptions,
} from '../layers/flowmap-layer.js';
import {
  STTFlowCorridorLayer as FlowCorridorLayerEngine,
  type STTFlowCorridorLayerOptions,
} from '../layers/flow-corridor-layer.js';
import {
  makeGlobeBasemap,
  type GlobeBasemapOptions,
} from '../scene/globe-basemap.js';
import { GlobeProjection } from '../projection/globe.js';

// ─── Context ──────────────────────────────────────────────────────────────────

interface STTSceneCtx {
  projection: Projection;
  timeOrigin: number;
  getTime: () => number;
  egoRef: React.MutableRefObject<EgoLayerEngine | null>;
  /** Layers contributing pickable boxes (objects + ego) for click-to-inspect. */
  pickables: React.MutableRefObject<Set<STTPickable>>;
  /**
   * Instanced layers (points, columns, arcs, …) answering a GPU id-buffer pick —
   * consulted when a CPU box pick misses (hover + click). Separate from
   * {@link pickables} because the mechanism differs (async GPU readback vs sync
   * ray-OBB). Any {@link isIdPickable} layer auto-registers here on mount, so a
   * new kind needs no wiring in this file.
   */
  idPickables: React.MutableRefObject<Set<STTIdPickable>>;
  /** All mounted layers — CameraRig frames to the union of their world AABBs. */
  layers: React.MutableRefObject<Set<STTLayer>>;
  /** Playback governor source registry (so the clock gates on buffer readiness). */
  registry?: STTSourceRegistry;
  /** Scene time range (epoch-ms) reported as the buffered span to the governor. */
  timeRange?: { start: number; end: number };
  /**
   * Canvas-level streaming default a layer inherits when it omits its own
   * `streaming` prop. Omit / `false` = the backward-compatible eager Suspense
   * path for every layer.
   */
  streaming?: boolean | StreamingLayerOptions;
}
const Ctx = React.createContext<STTSceneCtx | null>(null);

function useSTTScene(): STTSceneCtx {
  const c = React.useContext(Ctx);
  if (!c)
    throw new Error('STT layer components must be rendered inside <STTCanvas>');
  return c;
}

/**
 * Minimum interval (ms) between viewport pumps into a streaming tileset (the
 * RenderPump advances every rAF; the tileset debounces, but re-deriving the
 * frustum footprint every frame is wasted work when the camera is idle).
 */
const STREAM_UPDATE_MS = 100;

/**
 * The FULL-width render time window (ms) a layer's options imply, or `undefined`
 * when the layer draws only the current bucket (no explicit window). Threaded
 * into the streaming tileset's SELECTION window so a layer that renders a wide
 * `timeWindow` (a trail / trips tail) selects every tile its render pass needs —
 * otherwise selection defaults to `temporalBucketMs` alone and under-selects
 * relative to what is drawn. Mirrors `resolveTimeWindow`'s vocabulary: the
 * three-native half-width `windowHalf` (×2) wins over the deck/maplibre
 * full-width `timeWindow` when both are set.
 */
function renderWindowFromOpts(opts: object): number | undefined {
  const o = opts as { timeWindow?: unknown; windowHalf?: unknown };
  if (typeof o.windowHalf === 'number') return o.windowHalf * 2;
  if (typeof o.timeWindow === 'number') return o.timeWindow;
  return undefined;
}

/**
 * Resolve a layer's `streaming` prop against the canvas-level default: an
 * explicit prop wins (including `false` to force eager), else the canvas default,
 * else eager. Returns `false` (eager) or the resolved tileset options.
 */
function useResolvedStreaming(
  prop: boolean | StreamingLayerOptions | undefined,
): false | { opts: StreamingLayerOptions } {
  const { streaming: canvasDefault } = useSTTScene();
  const chosen = prop ?? canvasDefault;
  if (!chosen) return false;
  return { opts: chosen === true ? {} : chosen };
}

// ─── Suspense tile loader (with a bounded LRU) ──────────────────────────────────

interface CacheEntry {
  status: 'pending' | 'done' | 'error';
  promise: Promise<void>;
  tiles?: Tile[];
  error?: unknown;
  source: STTTileSource;
  /** Mounted layers holding this archive; an entry is evictable only at 0. */
  refCount: number;
  /** Monotonic access stamp for LRU ordering. */
  lastAccess: number;
}
const tileCache = new Map<string, CacheEntry>();
/** Keep at most this many UNREFERENCED archives decoded in the module cache. */
const MAX_IDLE_TILE_ENTRIES = 12;
let accessSeq = 0;

/** Cache key folds the LOD mode in (an additive union is a different tile set). */
function tileCacheKey(url: string, lodMode?: 'additive'): string {
  return lodMode === 'additive' ? `${url}#additive` : url;
}

/**
 * Evict the least-recently-used UNREFERENCED entries once the idle set exceeds
 * the cap. Mounted archives (refCount > 0) are never evicted, so a layer can't
 * lose the tiles it is rendering. Disposes the evicted source.
 */
function evictIdleTiles(): void {
  const idle: Array<[string, CacheEntry]> = [];
  for (const e of tileCache.entries()) if (e[1].refCount === 0) idle.push(e);
  if (idle.length <= MAX_IDLE_TILE_ENTRIES) return;
  idle.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (let i = 0; i < idle.length - MAX_IDLE_TILE_ENTRIES; i++) {
    const [key, entry] = idle[i];
    entry.source.dispose();
    tileCache.delete(key);
  }
}

function acquireTiles(key: string): void {
  const e = tileCache.get(key);
  if (e) {
    e.refCount++;
    e.lastAccess = accessSeq++;
  }
}

function releaseTiles(key: string): void {
  const e = tileCache.get(key);
  if (e && e.refCount > 0) e.refCount--;
  evictIdleTiles();
}

// Console-warn a given message at most once per key, so a per-frame failure
// (e.g. setTime in the render loop) logs a single line instead of spamming.
const warnedKeys = new Set<string>();
function warnOnce(key: string, ...args: unknown[]): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(...args);
}

/** Load (and cache) every tile for an archive URL, suspending until ready. */
export function useSTTTiles(url: string, lodMode?: 'additive'): Tile[] {
  const key = tileCacheKey(url, lodMode);
  let entry = tileCache.get(key);
  if (!entry) {
    const source = new STTTileSource({ url, lodMode });
    const e: CacheEntry = {
      status: 'pending',
      promise: Promise.resolve(),
      source,
      refCount: 0,
      lastAccess: accessSeq++,
    };
    e.promise = source
      .load()
      .then((r) => {
        e.tiles = r.tiles;
        e.status = 'done';
      })
      .catch((err) => {
        e.error = err;
        e.status = 'error';
      });
    entry = e;
    tileCache.set(key, e);
    evictIdleTiles();
  }
  entry.lastAccess = accessSeq++;
  if (entry.status === 'pending') throw entry.promise;
  // A load/decode failure (e.g. a transient tile-decoder worker crash) must NOT
  // blank the whole canvas via the error boundary — render this archive empty
  // (logged once). `invalidateSTTTiles(url)` or a reload retries.
  if (entry.status === 'error') {
    warnOnce(
      `tiles:${key}`,
      `[stt-three] tiles failed to load (${url}); rendering empty`,
      entry.error,
    );
    return [];
  }
  return entry.tiles!;
}

/** Drop a cached archive so it reloads next mount (rarely needed). */
export function invalidateSTTTiles(url: string, lodMode?: 'additive'): void {
  const key = tileCacheKey(url, lodMode);
  const e = tileCache.get(key);
  if (e) e.source.dispose();
  tileCache.delete(key);
}

// ─── Layer plumbing ───────────────────────────────────────────────────────────

interface LayerGovernance {
  /** Governor source id (matches the deck stream id, e.g. `${datasetId}-objects`). */
  sourceId?: string;
  /** Cache key for the tile lease (keeps the archive resident while mounted). */
  cacheKey: string;
  /** Whether this layer's source gates the clock. @default true */
  required?: boolean;
}

/** Build geometry from suspended tiles, drive the clock, govern, dispose on unmount. */
function useEngineLayer<L extends STTLayer>(
  make: () => L,
  tiles: Tile[],
  deps: React.DependencyList,
  gov: LayerGovernance,
): L {
  const {
    projection,
    timeOrigin,
    getTime,
    layers,
    idPickables,
    registry,
    timeRange,
  } = useSTTScene();
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layer = React.useMemo(make, deps);
  // Build GPU buffers once tiles are resolved (Suspense guarantees they are).
  React.useMemo(() => {
    try {
      layer.setTiles(tiles, { projection, timeOrigin });
    } catch (err) {
      warnOnce(
        `setTiles:${gov.sourceId}`,
        `[stt-three] setTiles failed for ${gov.sourceId}`,
        err,
      );
    }
  }, [layer, tiles, projection, timeOrigin, gov.sourceId]);
  // CRITICAL: a per-frame throw here (transient decode/NaN, a WGSL build hiccup)
  // must NOT kill r3f's render loop — that strands the canvas on the last frame
  // while the clock runs on. Swallow it (logged once) so the next frame paints.
  useFrame(() => {
    try {
      layer.setTime(getTime());
    } catch (err) {
      warnOnce(
        `setTime:${gov.sourceId}`,
        `[stt-three] setTime failed for ${gov.sourceId}`,
        err,
      );
    }
  });

  // Tile lease: hold the archive resident while mounted; release for LRU eviction
  // on unmount (a scene/mode switch then frees the previous scene's tiles).
  React.useEffect(() => {
    acquireTiles(gov.cacheKey);
    return () => releaseTiles(gov.cacheKey);
  }, [gov.cacheKey]);

  // Bounds membership: CameraRig frames to the union of layer AABBs.
  React.useEffect(() => {
    const set = layers.current;
    set.add(layer);
    return () => {
      set.delete(layer);
    };
  }, [layer, layers]);

  // GPU id-buffer pick auto-registration: any layer that structurally satisfies
  // STTIdPickable (has a `pick()` method — points, columns, arcs, and every
  // other id-pickable kind) joins the id-pick set with NO per-kind wiring here.
  // Box pickables (getPickBoxes) use the separate `pickables` registry via each
  // layer's `extra`.
  React.useEffect(() => {
    if (!isIdPickable(layer)) return;
    const set = idPickables.current;
    set.add(layer);
    return () => {
      set.delete(layer);
    };
  }, [layer, idPickables]);

  // Governor source: a complete BufferSource (the eager load is done by mount) so
  // the start/seek gate passes immediately and the transport's buffered bar /
  // Auto-speed / ETA come alive — instead of the empty-source 8 s freeze.
  React.useEffect(() => {
    const id = gov.sourceId;
    if (!registry || !id) return;
    registry.registerSource(id, createCompleteBufferSource(timeRange), {
      required: gov.required ?? true,
    });
    return () => registry.unregisterSource(id);
  }, [registry, gov.sourceId, gov.required, timeRange]);

  // Viewport push: wide-line layers + pixel-mode points size their pixel widths
  // off the live DRAWING-BUFFER dimensions (device pixels, dpr-scaled). Push them
  // on mount and on every resize; a no-op for layers without `setViewport`.
  React.useEffect(() => {
    const dims = gl.getDrawingBufferSize(new Vector2());
    (
      layer as unknown as { setViewport?: (w: number, h: number) => void }
    ).setViewport?.(dims.x, dims.y);
  }, [layer, gl, size.width, size.height]);

  React.useEffect(() => () => layer.dispose(), [layer]);
  return layer;
}

/**
 * The streaming sibling of {@link useEngineLayer}: builds geometry from a
 * viewport-driven {@link StreamingTileSource} instead of a one-shot eager load.
 *
 * Per rAF (via the RenderPump's `advance`): derive the camera viewport
 * (frustum-footprint bounds + slippy zoom) from the live camera + CSS canvas
 * size, pump it into the tileset (throttled), then advance the layer time
 * uniform. The tileset re-selects/loads/evicts and re-publishes its resident set
 * through `onTilesChanged`, which rebuilds the layer's buffers. The governor gets
 * the REAL {@link TilesetBufferSource} so the buffered bar reflects honest
 * coverage (vs the eager path's always-complete source).
 */
function useStreamingEngineLayer<L extends STTLayer>(
  make: () => L,
  source: StreamingTileSource,
  deps: React.DependencyList,
  gov: {
    sourceId?: string;
    required?: boolean;
    /**
     * The layer's full-width render time window (ms), passed into every
     * viewport pump as {@link StreamingViewport.timeWindow} so tile SELECTION
     * covers the render window (see {@link renderWindowFromOpts}). `undefined`
     * leaves the tileset on its `temporalBucketMs`/`timeWindowMs` default.
     */
    renderTimeWindowMs?: number;
  },
): L {
  const {
    projection,
    timeOrigin,
    getTime,
    layers,
    idPickables,
    registry,
    timeRange,
  } = useSTTScene();
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layer = React.useMemo(make, deps);

  // Resident-set callback: rebuild the layer's buffers on every real residency
  // change. Kick off the (idempotent) tileset init here — `update()` is inert
  // until it resolves — and dispose the source on unmount.
  React.useEffect(() => {
    source.setOnTilesChanged((tiles) => {
      try {
        layer.setTiles(tiles, { projection, timeOrigin });
      } catch (err) {
        warnOnce(
          `setTiles:${gov.sourceId}`,
          `[stt-three] streaming setTiles failed for ${gov.sourceId}`,
          err,
        );
      }
    });
    void source.load();
    return () => source.dispose();
  }, [source, layer, projection, timeOrigin, gov.sourceId]);

  const lastUpdate = React.useRef(0);
  const lastTime = React.useRef(Number.NaN);
  // CRITICAL (as in the eager path): a per-frame throw must NOT kill the render
  // loop — swallow it (logged once) so the next frame paints.
  useFrame(() => {
    const t = getTime();
    try {
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastUpdate.current >= STREAM_UPDATE_MS) {
        lastUpdate.current = now;
        const md = source.getMetadata();
        const vp = cameraToViewport(
          projection,
          camera,
          { width: size.width, height: size.height },
          md ? { minZoom: md.minZoom, maxZoom: md.maxZoom } : {},
        );
        // A `null` viewport means the camera produced no usable lon/lat box —
        // reliably the case for the first frames after mount, when `size` is
        // still 0×0 and every unprojection is NaN. KEEP THE PREVIOUS VIEWPORT by
        // simply not pumping: the tileset holds its last one, where feeding it a
        // NaN box would make `boundsToTiles` enumerate nothing while every
        // readiness signal still reported "settled and fully buffered".
        if (vp) {
          // Couple selection to the layer's render window: pass it as the
          // viewport's `timeWindow` so tile selection never under-covers what the
          // render pass draws. `undefined` falls back to the tileset default
          // (streaming `timeWindowMs` → archive `temporalBucketMs`).
          source.update({
            bounds: vp.bounds,
            zoom: vp.zoom,
            time: t,
            timeWindow: gov.renderTimeWindowMs,
          });
        }
      }
      // Without a governor, keep prefetch alive via a play/pause heuristic (time
      // advancing ⇒ animating). With one, the governor drives animation state
      // through the registered TilesetBufferSource, so we leave it alone.
      if (!registry) source.setAnimationState(t !== lastTime.current);
    } catch (err) {
      warnOnce(
        `stream:${gov.sourceId}`,
        `[stt-three] streaming update failed for ${gov.sourceId}`,
        err,
      );
    }
    lastTime.current = t;
    try {
      layer.setTime(t);
    } catch (err) {
      warnOnce(
        `setTime:${gov.sourceId}`,
        `[stt-three] setTime failed for ${gov.sourceId}`,
        err,
      );
    }
  });

  // Pixel-sizing viewport push (device px), mirroring the eager path.
  React.useEffect(() => {
    const dims = gl.getDrawingBufferSize(new Vector2());
    (
      layer as unknown as { setViewport?: (w: number, h: number) => void }
    ).setViewport?.(dims.x, dims.y);
  }, [layer, gl, size.width, size.height]);

  // Bounds membership: CameraRig frames to the union of layer AABBs (which grow
  // as streaming tiles arrive).
  React.useEffect(() => {
    const set = layers.current;
    set.add(layer);
    return () => {
      set.delete(layer);
    };
  }, [layer, layers]);

  // GPU id-buffer pick auto-registration (mirrors the eager path): any
  // STTIdPickable layer joins the id-pick set with no per-kind wiring here.
  React.useEffect(() => {
    if (!isIdPickable(layer)) return;
    const set = idPickables.current;
    set.add(layer);
    return () => {
      set.delete(layer);
    };
  }, [layer, idPickables]);

  // Governor: register the REAL tileset BufferSource once the tileset exists so
  // the buffered bar / Auto-speed / ETA reflect honest streaming coverage. Falls
  // back to a complete source if the runway surface is somehow absent.
  React.useEffect(() => {
    const id = gov.sourceId;
    if (!registry || !id) return;
    let cancelled = false;
    void source.load().then(() => {
      if (cancelled) return;
      const bs =
        createTilesetBufferSource(source) ??
        createCompleteBufferSource(timeRange);
      registry.registerSource(id, bs, { required: gov.required ?? true });
    });
    return () => {
      cancelled = true;
      registry.unregisterSource(id);
    };
  }, [registry, gov.sourceId, gov.required, source, timeRange]);

  React.useEffect(() => () => layer.dispose(), [layer]);
  return layer;
}

/**
 * Generic EAGER layer mount — the shared body every `STT*Layer` renders when it
 * is NOT streaming (the backward-compatible default). Suspends on the full
 * archive load, then builds + governs the layer via {@link useEngineLayer}.
 */
function EagerLayerMount<L extends STTLayer>(props: {
  make: () => L;
  url: string;
  lodMode?: 'additive';
  sourceId?: string;
  sourceRequired?: boolean;
  /** Governor `required` default when `sourceRequired` is omitted (map overlays pass false). */
  defaultRequired?: boolean;
  /** Optional extra registration hook (pickables / ego). Stable per mount site. */
  extra?: (layer: L) => void;
}): React.ReactElement {
  const tiles = useSTTTiles(props.url, props.lodMode);
  const layer = useEngineLayer(props.make, tiles, [props.url, props.lodMode], {
    sourceId: props.sourceId,
    cacheKey: tileCacheKey(props.url, props.lodMode),
    required: props.sourceRequired ?? props.defaultRequired,
  });
  // Stable per mount site (a given fiber always renders the same layer kind), so
  // the extra hook's order is consistent across this fiber's renders.
  if (props.extra) props.extra(layer);
  return <primitive object={layer.object} dispose={null} />;
}

/**
 * Generic STREAMING layer mount — the shared body every `STT*Layer` renders when
 * opted into streaming. Builds a {@link StreamingTileSource} (rebuilt only on
 * url/lodMode change) and drives it via {@link useStreamingEngineLayer}.
 */
function StreamingLayerMount<L extends STTLayer>(props: {
  make: () => L;
  url: string;
  lodMode?: 'additive';
  opts: StreamingLayerOptions;
  sourceId?: string;
  sourceRequired?: boolean;
  defaultRequired?: boolean;
  /** The layer's full-width render window (ms); couples selection to render. */
  renderTimeWindowMs?: number;
  extra?: (layer: L) => void;
}): React.ReactElement {
  const source = React.useMemo(
    () =>
      new StreamingTileSource({
        ...props.opts,
        url: props.url,
        lodMode: props.lodMode ?? props.opts.lodMode,
      }),
    // Rebuild only on url/lodMode change (opts changes after mount are ignored,
    // mirroring the eager path's [url, lodMode] deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.url, props.lodMode],
  );
  const layer = useStreamingEngineLayer(
    props.make,
    source,
    [props.url, props.lodMode],
    {
      sourceId: props.sourceId,
      required: props.sourceRequired ?? props.defaultRequired,
      renderTimeWindowMs: props.renderTimeWindowMs,
    },
  );
  if (props.extra) props.extra(layer);
  return <primitive object={layer.object} dispose={null} />;
}

interface UrlProp {
  url: string;
  /** Additive-octree LOD: load the UNION of all zoom levels (see STTTileSource). */
  lodMode?: 'additive';
  /**
   * Whether this layer gates the playback clock as a REQUIRED governor source.
   * @default true (map overlays pass false, matching the deck path).
   */
  sourceRequired?: boolean;
  /**
   * Back this layer with the viewport-driven {@link StreamingTileSource} (real
   * LOD selection + prefetch + eviction) instead of the eager load-everything
   * Suspense path. `true` streams with the archive defaults; an options object
   * passes tileset knobs. Omit to inherit the `<STTCanvas streaming>` default.
   * Eager is the backward-compatible default.
   */
  streaming?: boolean | StreamingLayerOptions;
}

export function STTSurfelLayer(
  props: STTSurfelLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): SurfelLayerEngine => new SurfelLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTPointCloudLayer(
  props: STTPointCloudLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): PointCloudLayerEngine => new PointCloudLayerEngine(opts);
  // GPU id-buffer picking is auto-registered by the shared layer mount for ANY
  // STTIdPickable layer (see useEngineLayer / useStreamingEngineLayer) — no
  // per-kind `extra` here. The controller runs the GPU pass only when a box pick
  // misses and an `onPick`/`onHover` consumer is present.
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTBoundingBoxLayer(
  props: STTBoundingBoxLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const { pickables } = useSTTScene();
  const make = (): BoundingBoxLayerEngine => new BoundingBoxLayerEngine(opts);
  // Register the layer's boxes for click-to-inspect (both modes).
  const extra = (layer: BoundingBoxLayerEngine): void => {
    React.useEffect(() => {
      const set = pickables.current;
      set.add(layer);
      return () => {
        set.delete(layer);
      };
    }, [layer]);
  };
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      extra={extra}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      extra={extra}
    />
  );
}

export function STTMapPolygonLayer(
  props: STTStaticPolygonLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): StaticPolygonLayerEngine =>
    new StaticPolygonLayerEngine(opts);
  // Map overlays load coordinated but never gate the clock (HD-map idiom).
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      defaultRequired={false}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      defaultRequired={false}
    />
  );
}

export function STTMapLineLayer(
  props: STTStaticPathLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): StaticPathLayerEngine => new StaticPathLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      defaultRequired={false}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      defaultRequired={false}
    />
  );
}

export function STTIsoLayer(
  props: STTIsoLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): IsoLayerEngine => new IsoLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTTripsLayer(
  props: STTTripsLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): TripsLayerEngine => new TripsLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTPathLayer(
  props: STTPathGeoLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): PathGeoLayerEngine => new PathGeoLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTOdLineLayer(
  props: STTOdLineLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): OdLineLayerEngine => new OdLineLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTArcLayer(
  props: STTArcLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): ArcLayerEngine => new ArcLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTIconLayer(
  props: STTIconLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): IconLayerEngine => new IconLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTColumnLayer(
  props: STTColumnLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): ColumnLayerEngine => new ColumnLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTPolygonLayer(
  props: STTPolygonLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): PolygonLayerEngine => new PolygonLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTTripHeadsLayer(
  props: STTTripHeadsLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): TripHeadsLayerEngine => new TripHeadsLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTQuadbinLayer(
  props: STTQuadbinSummaryLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): QuadbinSummaryLayerEngine =>
    new QuadbinSummaryLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTH3Layer(
  props: STTH3SummaryLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): H3SummaryLayerEngine => new H3SummaryLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTFlowmapLayer(
  props: STTFlowmapLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): FlowmapLayerEngine => new FlowmapLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTFlowCorridorLayer(
  props: STTFlowCorridorLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const make = (): FlowCorridorLayerEngine => new FlowCorridorLayerEngine(opts);
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
    />
  );
}

export function STTEgoLayer(
  props: STTEgoLayerOptions & UrlProp,
): React.ReactElement {
  const { url, lodMode, sourceRequired, streaming, ...opts } = props;
  const resolved = useResolvedStreaming(streaming);
  const { egoRef, pickables } = useSTTScene();
  const make = (): EgoLayerEngine => new EgoLayerEngine(opts);
  // Publish the ego layer + its pickable box (both modes).
  const extra = (layer: EgoLayerEngine): void => {
    React.useEffect(() => {
      egoRef.current = layer;
      const set = pickables.current;
      set.add(layer);
      return () => {
        if (egoRef.current === layer) egoRef.current = null;
        set.delete(layer);
      };
    }, [layer]);
  };
  return resolved ? (
    <StreamingLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      opts={resolved.opts}
      renderTimeWindowMs={renderWindowFromOpts(opts)}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      extra={extra}
    />
  ) : (
    <EagerLayerMount
      make={make}
      url={url}
      lodMode={lodMode}
      sourceId={opts.id}
      sourceRequired={sourceRequired}
      extra={extra}
    />
  );
}

/**
 * Earth-sphere basemap primitive for the globe demos. Reads the globe radius from
 * the scene's `GlobeProjection` when present; on a planar scene pass an explicit
 * `globe` prop. Not a tile-backed layer — a single static `Mesh`.
 */
export function STTGlobeBasemap(
  props: GlobeBasemapOptions & { globe?: GlobeProjection },
): React.ReactElement {
  const { globe: globeProp, ...opts } = props;
  const { projection } = useSTTScene();
  const globe =
    globeProp ??
    (projection instanceof GlobeProjection ? projection : undefined);
  if (!globe) {
    throw new Error(
      'STTGlobeBasemap needs a GlobeProjection: render inside a globe scene or pass `globe`.',
    );
  }
  const mesh = React.useMemo(
    () => makeGlobeBasemap(globe, opts),
    [globe, opts],
  );
  return <primitive object={mesh} dispose={null} />;
}

// ─── Camera rig ───────────────────────────────────────────────────────────────

/** Time constant (s) for the ego-follow easing (≈ deck's positionTau). */
const FOLLOW_TAU_S = 0.25;

function CameraRig(props: {
  projection: Projection;
  followEgo: boolean;
  topDown: boolean;
  pitchDeg?: number;
  headingDeg?: number;
  /** Explicit initial geographic view (geo demos); overrides the bounds-fit below. */
  initialViewState?: ViewState;
  egoRef: React.MutableRefObject<EgoLayerEngine | null>;
  layers: React.MutableRefObject<Set<STTLayer>>;
  getTime: () => number;
  reducedMotion: boolean;
}): null {
  const {
    projection,
    followEgo,
    topDown,
    pitchDeg,
    headingDeg,
    initialViewState,
    egoRef,
    layers,
    getTime,
    reducedMotion,
  } = props;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const get = useThree((s) => s.get);
  // Eased ego position (the camera target chases this); null = snap next frame.
  const easedEgo = React.useRef<Vector3 | null>(null);
  const framed = React.useRef(false);
  // Globe scenes orbit the earth centre with a per-anchor north up; every planar
  // projection (ENU, mercator) uses the flat Z-up ground rig below.
  const globe = isGlobeProjection(projection) ? projection : null;
  // GEO rigs (web-mercator ground, globe) are framed by `viewStateToCamera`,
  // whose near/far bracket the distance it framed AT — so they need re-bracketing
  // as the controls dolly (see `updateCameraClip`). An ENU/AV scene is framed by
  // `frameBox` against real layer bounds inside a tight distance clamp; leave it.
  const syncClip =
    projection.kind === 'mercator' || projection.kind === 'globe';

  // Z-up world — flat projections only. On the globe there is no single world-up;
  // `frameGlobe` sets `camera.up` to the anchor's north, so leave it be.
  React.useEffect(() => {
    if (!globe) camera.up.set(0, 0, 1);
  }, [camera, globe]);

  // Re-frame to bounds when follow turns off or the view (top-down) flips. A
  // dataset switch remounts the whole Canvas, so a fresh rig re-frames anyway.
  React.useEffect(() => {
    framed.current = false;
    easedEgo.current = null;
  }, [followEgo, topDown]);

  useFrame((_state, delta) => {
    // Guard: a throw in the camera rig must not kill r3f's render loop either.
    try {
      const controls = get().controls as {
        target: Vector3;
        update: () => void;
        enabled?: boolean;
      } | null;

      // Once framed, the controls own the camera and NOTHING else revisits the
      // clip planes — so a wheel-out eventually pushes the ground past the far
      // plane it was framed with. Re-bracket every frame on the geo rigs. Skipped
      // while `<STTTiles3D globeControls>` drives navigation: it manages near/far
      // itself, and disables these controls to say so.
      if (framed.current && syncClip && controls?.enabled !== false) {
        updateCameraClip(projection, camera);
      }

      // Geo demos supply an explicit initial view state (lng/lat/zoom/pitch/bearing).
      // Place the camera via the projection-aware bridge — correct at web-mercator AND
      // planet scales, and the exact inverse of the basemap `cameraToViewState` sync —
      // instead of the AV/ENU bounds-fit below (whose metre-scale distance clamps put
      // a city-scale mercator scene entirely outside the frustum). One-shot: controls
      // own the camera afterwards.
      if (!framed.current && initialViewState) {
        const target = viewStateToCamera(projection, initialViewState, camera, {
          viewportHeight: Math.max(1, get().size.height),
        });
        if (controls?.target) {
          controls.target.copy(target);
          controls.update();
        }
        framed.current = true;
        return;
      }

      // Globe: park a whole-earth overview above the anchor once, then hand off to
      // OrbitControls (or, if `<STTTiles3D globeControls>` is mounted, its ellipsoid
      // GlobeControls). No ground-plane ego-follow / AABB fit applies on the sphere.
      if (globe) {
        if (!framed.current) {
          const center = frameGlobe(camera, globe, {
            longitude: globe.anchor.longitude,
            latitude: globe.anchor.latitude,
          });
          if (controls?.target) {
            controls.target.copy(center);
            controls.update();
          }
          framed.current = true;
        }
        return;
      }

      // Ego-follow: glide the camera + orbit target toward the live ego pose with a
      // time-based exponential filter (smooth + frame-rate independent), preserving
      // the user's orbit offset. Snaps on the first frame and under reduced motion.
      if (followEgo && egoRef.current && controls?.target) {
        const pose = egoRef.current.getEgoPose(getTime());
        if (pose) {
          const want = new Vector3(pose.x, pose.y, pose.z);
          const prev = easedEgo.current;
          let next: Vector3;
          if (!prev || reducedMotion) {
            next = want.clone();
          } else {
            const dt = Math.min(delta || 0.016, 0.1);
            const a = 1 - Math.exp(-dt / FOLLOW_TAU_S);
            next = prev.clone().lerp(want, a);
          }
          if (prev) camera.position.add(next.clone().sub(prev));
          controls.target.copy(next);
          controls.update();
          easedEgo.current = next;
        }
        return;
      }
      easedEgo.current = null;

      // Initial / re-frame: fit the camera to the union of the layers' world AABBs
      // once they exist (dominated by the LIDAR cloud's real bbox). Bounds-aware so
      // a 60 m scene and a 400 m drive both frame correctly — the old fixed 60/130 m
      // distance mis-scaled every scene whose extent wasn't ~60 m.
      if (!framed.current) {
        const box = new Box3().makeEmpty();
        for (const l of layers.current) box.expandByObject(l.object);
        if (!box.isEmpty()) {
          const center = frameBox(camera, box, {
            pitchDeg: topDown ? 89 : (pitchDeg ?? 55),
            headingDeg: headingDeg ?? 20,
            margin: 1.5,
            minDistance: 20,
            maxDistance: topDown ? 320 : 160,
          });
          if (controls?.target) {
            controls.target.copy(center);
            controls.update();
          }
          framed.current = true;
        }
      }
    } catch (err) {
      warnOnce('camera-rig', '[stt-three] camera rig frame failed', err);
    }
  });

  return null;
}

/**
 * The flat-rig `MapControls`, with the tilt clamp AND (mercator scenes) the
 * dolly clamps that hold the camera inside the map zoom range. Its own component
 * because the zoom→distance conversion needs the LIVE viewport height and camera
 * FOV, which only exist inside the Canvas — and must be recomputed on resize, or
 * the clamp would encode the scale of a stale viewport.
 *
 * Why clamp at all: nothing else bounds the dolly. `MapControls` defaults to
 * `maxDistance: Infinity`, so a scene could be wheeled out to zoom −5 while the
 * maplibre basemap under it — whose own `minZoom` is 0 — silently ignored every
 * `jumpTo` past its floor and froze. Past that point the data kept shrinking over
 * a fixed basemap: same camera, two scales.
 */
function GroundControls(props: {
  projection: Projection;
  reducedMotion: boolean;
  minZoom?: number;
  maxZoom?: number;
}): React.ReactElement {
  const { projection, reducedMotion, minZoom, maxZoom } = props;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const height = useThree((s) => s.size.height);
  const limits = React.useMemo(
    () =>
      groundControlLimits({
        projection,
        viewportHeight: height,
        fovDeg: camera.fov,
        minZoom,
        maxZoom,
      }),
    [projection, height, camera.fov, minZoom, maxZoom],
  );
  return (
    /* MapControls (not OrbitControls) so left-drag PANS across the ground plane —
       a map-style gesture matching the deck cockpit's MapController — instead of
       orbiting a point. Right-drag still rotates; wheel zooms. Panning is in the
       XY plane because the camera up is Z.

       `maxPolarAngle`: without it the default is π and a right-drag can swing the
       camera THROUGH the ground and out the other side — at which point no camera
       ray reaches the surface at all and tile selection has nothing to select
       against. */
    <MapControls
      makeDefault
      enableDamping={!reducedMotion}
      dampingFactor={0.12}
      {...limits}
    />
  );
}

// ─── WebGPU device disposal ─────────────────────────────────────────────────────

/**
 * Disposes the `WebGPURenderer` (→ `GPUDevice.destroy()`) when the Canvas
 * unmounts. r3f v9's own unmount cleanup only calls the WebGL-only
 * `forceContextLoss()`/`renderLists.dispose()`, which Three's `WebGPURenderer`
 * does not implement, so without this every dataset/mode switch (the Canvas is
 * keyed on `dataset.id`) leaks a GPU device — and after enough switches new
 * contexts fail and the viewport stops rendering. `dispose()` is idempotent.
 */
function GlDisposer(): null {
  const gl = useThree((s) => s.gl);
  React.useEffect(() => {
    return () => {
      try {
        (gl as unknown as { dispose?: () => void }).dispose?.();
      } catch {
        /* idempotent — r3f may have already torn the renderer down */
      }
    };
  }, [gl]);
  return null;
}

// ─── Render pump ────────────────────────────────────────────────────────────────

/**
 * Drives the render loop for the externally-clocked scene. The STT layers read
 * the playback `TimeController` in `useFrame`, so the canvas must re-render every
 * animation frame to reflect the moving playhead — but the clock advances on its
 * OWN rAF and never notifies r3f.
 *
 * Under `frameloop="always"` with the async WebGPU `gl` factory, r3f's own loop
 * degrades to on-demand: it repaints on camera/control events (so pan/zoom stays
 * live) but NOT as the external clock ticks, so the scene sticks on the first
 * frame of data while the clock runs on. So the Canvas runs `frameloop="never"`
 * (r3f paints nothing on its own) and this pump calls `advance(now)` every rAF —
 * forcing every `useFrame` subscriber (layer `setTime`, the camera rig, controls
 * damping) to run and then rendering — giving a steady clock-tracking loop.
 */
function RenderPump(): null {
  const advance = useThree((s) => s.advance);
  React.useEffect(() => {
    let raf = 0;
    const tick = (now: number): void => {
      advance(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [advance]);
  return null;
}

// ─── Atmosphere (opt-in physically-based sky / sun / day-night) ─────────────────

/**
 * Takes over the render loop while a live {@link AtmosphereHandle} exists: a
 * render-priority (`> 0`) `useFrame` disables r3f's automatic render, so we drive
 * the atmosphere's `pass → MRT → aerialPerspective` pipeline instead — after the
 * priority-0 layer `setTime` and the camera rig have run for this frame. The sun
 * is advanced to the playhead time each frame. A throw here is swallowed (logged
 * once) so a transient node hiccup can't strand the canvas.
 */
function AtmosphereRenderLoop(props: {
  atmosphere: AtmosphereHandle;
  getTime: () => number;
}): null {
  const { atmosphere, getTime } = props;
  useFrame(() => {
    try {
      atmosphere.update(getTime());
      atmosphere.render();
    } catch (err) {
      warnOnce('atmosphere-frame', '[stt-three] atmosphere frame failed', err);
    }
  }, 1);
  return null;
}

/**
 * Sets up the atmosphere for the live r3f scene/camera/renderer and, once ready,
 * mounts {@link AtmosphereRenderLoop} to render through it. WebGPU only — on the
 * WebGL2 fallback (or before the async setup resolves) this renders nothing and
 * r3f's default render stays in charge, so the scene never blanks and WebGL2
 * degrades gracefully. Options are read once at setup (like `ground`); change the
 * `anchor`/`getDate`/feature flags before mount.
 */
function AtmosphereController(props: {
  options: boolean | AtmosphereOptions;
  forceWebGL: boolean;
}): React.ReactElement | null {
  const { projection, getTime } = useSTTScene();
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const [atmosphere, setAtmosphere] = React.useState<AtmosphereHandle | null>(
    null,
  );
  // Options are effectively static per scene (mirrors the `ground` build-once
  // idiom); read from a ref so an inline-object prop doesn't churn the setup.
  const optionsRef = React.useRef(props.options);
  optionsRef.current = props.options;

  React.useEffect(() => {
    const backend = resolveBackend(
      gl as unknown as import('three/webgpu').WebGPURenderer,
      props.forceWebGL,
    );
    if (backend !== 'webgpu') return; // graceful WebGL2 degrade — leave r3f rendering
    const opts = optionsRef.current;
    const atmoOpts = opts === true ? {} : opts;
    let handle: AtmosphereHandle | null = null;
    let cancelled = false;
    void createSTTAtmosphere({
      ...atmoOpts,
      renderer: gl as unknown as import('three/webgpu').WebGPURenderer,
      scene,
      camera,
      projection,
    })
      .then((a) => {
        if (cancelled) {
          a.dispose();
          return;
        }
        handle = a;
        setAtmosphere(a);
      })
      .catch((err) => {
        warnOnce(
          'atmosphere-setup',
          '[stt-three] atmosphere setup failed; rendering without it',
          err,
        );
      });
    return () => {
      cancelled = true;
      handle?.dispose();
      setAtmosphere(null);
    };
    // Build once per scene/camera/renderer/projection; options read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, projection, props.forceWebGL]);

  return atmosphere ? (
    <AtmosphereRenderLoop atmosphere={atmosphere} getTime={getTime} />
  ) : null;
}

/**
 * Declarative atmosphere child — render `<STTAtmosphere />` inside an `<STTCanvas>`
 * as an alternative to the `atmosphere` prop (use ONE of the two, not both). Opt-in,
 * WebGPU-only, default-off elsewhere.
 */
export function STTAtmosphere(
  props: AtmosphereOptions & { forceWebGL?: boolean },
): React.ReactElement {
  const { forceWebGL = false, ...options } = props;
  return <AtmosphereController options={options} forceWebGL={forceWebGL} />;
}

// ─── OGC 3D Tiles (opt-in: real terrain / Google Photorealistic / Cesium Ion) ────

/** Stable dependency key so the tileset rebuilds only on a real source change. */
function tilesSourceKey(s: STT3DTilesSource): string {
  if ('google' in s) return `google:${s.google.apiToken}`;
  if ('ion' in s) return `ion:${s.ion.apiToken}:${s.ion.assetId}`;
  return `url:${s.url}`;
}

/** Props for {@link STTTiles3D}. */
export interface STTTiles3DProps extends STT3DTilesOptions {
  /**
   * Use ellipsoid-aware `GlobeControls` while mounted (horizon-aware,
   * zoom-to-cursor, auto earth-scale near/far), disabling the `<STTCanvas>` default
   * `MapControls` until unmount. @default false
   */
  globeControls?: boolean;
  /** Force the WebGL2 backend detection (matches the canvas). @default false */
  forceWebGL?: boolean;
}

/**
 * Declarative OGC 3D Tiles child for an `<STTCanvas>` — mounts a tileset (real
 * terrain, Google Photorealistic Tiles, or a Cesium Ion asset) into the canvas
 * scene and drives its LOD from the existing per-frame `RenderPump` path.
 *
 * It wires the VANILLA `3d-tiles-renderer/three` `TilesRenderer` into the STTCanvas
 * scene (NOT `3d-tiles-renderer/r3f`, which would manage its own camera/controls
 * and fight STTCanvas). Because the group is added to the same scene, it **composes
 * with the atmosphere feature**: when the atmosphere is on it renders the tiles
 * through the same `pass → aerialPerspective` pipeline (tiles pump at frame
 * priority 0, the atmosphere draws at priority 1, so tiles are current before the
 * draw); when it is off, r3f's default render draws the tiles.
 *
 * **Opt-in, default-OFF.** Live tiles need network + a GPU + (google/ion) a token,
 * so this is browser-verified. Note: `<STTCanvas>` uses a local-ENU projection, so
 * tiles co-register around the canvas anchor; a full-earth globe view is best set
 * up with a globe host + `globeControls`.
 */
export function STTTiles3D(props: STTTiles3DProps): null {
  const {
    globeControls = false,
    forceWebGL: _forceWebGL,
    ...tilesOpts
  } = props;
  const { projection } = useSTTScene();
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const defaultControls = useThree((s) => s.controls) as {
    enabled: boolean;
  } | null;
  const [handle, setHandle] = React.useState<STT3DTiles | null>(null);
  const [globe, setGlobe] = React.useState<STTGlobeControls | null>(null);

  // Options are effectively static per source (build-once idiom, like `ground` /
  // the atmosphere); read from a ref so an inline-object prop doesn't churn setup.
  const optsRef = React.useRef(tilesOpts);
  optsRef.current = tilesOpts;
  const sourceKey = tilesSourceKey(tilesOpts.source);

  React.useEffect(() => {
    let h: STT3DTiles | null = null;
    let g: STTGlobeControls | null = null;
    let cancelled = false;
    const renderer = gl as unknown as import('three/webgpu').WebGPURenderer;
    void (async () => {
      const t = await createSTT3DTiles({
        ...optsRef.current,
        renderer,
        scene,
        camera,
        projection,
      });
      if (cancelled) {
        t.dispose();
        return;
      }
      h = t;
      setHandle(t);
      if (globeControls) {
        const gc = await createSTTGlobeControls({
          scene,
          camera,
          domElement: gl.domElement,
          projection,
          tiles: t,
        });
        if (cancelled) {
          gc.dispose();
          return;
        }
        g = gc;
        setGlobe(gc);
      }
    })().catch((err) => {
      warnOnce(
        'tiles3d-setup',
        '[stt-three] 3D tiles setup failed; rendering without them',
        err,
      );
    });
    return () => {
      cancelled = true;
      g?.dispose();
      h?.dispose();
      setHandle(null);
      setGlobe(null);
    };
    // Rebuild on renderer/scene/camera/projection/source/globeControls change;
    // other options are read via ref (build-once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, projection, sourceKey, globeControls]);

  // While GlobeControls owns navigation, disable the STTCanvas default MapControls
  // (they fight over the same pointer); restore it when this unmounts.
  React.useEffect(() => {
    if (!globe || !defaultControls) return;
    const prev = defaultControls.enabled;
    defaultControls.enabled = false;
    return () => {
      defaultControls.enabled = prev;
    };
  }, [globe, defaultControls]);

  // Refresh the SSE reference resolution on canvas resize.
  React.useEffect(() => {
    handle?.setResolutionFromRenderer();
  }, [handle, size.width, size.height]);

  // Per-frame (priority 0, before the atmosphere's priority-1 render): advance the
  // globe controls (if any), then pump tiles LOD with a current camera matrix.
  useFrame(() => {
    try {
      if (globe) globe.update();
      if (handle) {
        camera.updateMatrixWorld();
        handle.update();
      }
    } catch (err) {
      warnOnce('tiles3d-frame', '[stt-three] 3D tiles frame failed', err);
    }
  });

  return null;
}

// ─── Picking (click-to-inspect + hover) ─────────────────────────────────────────

/**
 * Pointer-driven picking against the registered pickables, in two mechanisms and
 * in order:
 *  1. CPU ray-OBB over the object/ego boxes ({@link pickBoxes}) — synchronous.
 *  2. On a box MISS (and only if any id-pickable layers are registered): a GPU
 *     id-buffer pass at the cursor ({@link GpuPicker}) resolved through each
 *     layer's provenance buffer — async (a GPU readback). Every id-pickable kind
 *     (points, columns, arcs, …) is consulted uniformly.
 *
 * The hit (or `null`) is reported to `onPick` on a click and, throttled to one
 * pick per animation frame, to `onHover` on a pointer-move. A gesture that moves
 * past a small threshold is an OrbitControls drag, not a click; hover is
 * suppressed while a button is held (dragging). Mounted only when an `onPick` or
 * `onHover` consumer is present — otherwise pointer events pass straight to the
 * controls.
 *
 * The click path is unchanged for box hits (still synchronous) and for empty
 * space when no id-pickables are registered (still a synchronous `null`); the GPU
 * fall-through is purely additive.
 */
function PickController(props: {
  onPick?: (info: STTPickInfo | null) => void;
  onHover?: (info: STTPickInfo | null) => void;
  pickables: React.MutableRefObject<Set<STTPickable>>;
  idPickables: React.MutableRefObject<Set<STTIdPickable>>;
}): null {
  const camera = useThree((s) => s.camera);
  const raycaster = useThree((s) => s.raycaster);
  const gl = useThree((s) => s.gl);
  const { pickables, idPickables } = props;
  const hasPick = !!props.onPick;
  const hasHover = !!props.onHover;
  const onPickRef = React.useRef(props.onPick);
  onPickRef.current = props.onPick;
  const onHoverRef = React.useRef(props.onHover);
  onHoverRef.current = props.onHover;

  React.useEffect(() => {
    if (!hasPick && !hasHover) return; // no consumer → don't intercept pointer events
    const el = gl.domElement;
    const DRAG_PX = 6; // a drag past this is an orbit, not a click

    // One shared GPU id-buffer picker (a 1×1 readback target), lazily built on
    // the first cloud pick and disposed on teardown.
    let picker: GpuPicker | null = null;
    const ensurePicker = (): GpuPicker => {
      picker ??= new GpuPicker(
        gl as unknown as PickRenderer,
        RenderTarget as unknown as RenderTargetCtor,
        1,
      );
      return picker;
    };

    // Client (viewport) px → NDC for the CPU ray + canvas-local CSS px for the
    // GPU picker. Null when the canvas has no layout box yet.
    const project = (
      clientX: number,
      clientY: number,
    ): { ndc: Vector2; localX: number; localY: number } | null => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const ndc = new Vector2(
        (localX / rect.width) * 2 - 1,
        -(localY / rect.height) * 2 + 1,
      );
      return { ndc, localX, localY };
    };

    // (1) Synchronous CPU box pick — identical to the click-only path.
    const boxPickAt = (
      clientX: number,
      clientY: number,
    ): STTBoxPickInfo | null => {
      const p = project(clientX, clientY);
      if (!p) return null;
      raycaster.setFromCamera(p.ndc, camera);
      const o = raycaster.ray.origin;
      const d = raycaster.ray.direction;
      const boxes = Array.from(pickables.current).flatMap((pk) =>
        pk.getPickBoxes(),
      );
      return pickBoxes([o.x, o.y, o.z], [d.x, d.y, d.z], boxes);
    };

    // (2) Async GPU id-buffer pick — first hit across the registered id-pickable
    // layers (points, columns, arcs, …). Each returns a fully kind-tagged
    // STTIdPickInfo, so there is no per-kind mapping here.
    const idPickAt = async (
      clientX: number,
      clientY: number,
    ): Promise<STTPickInfo | null> => {
      const layers = idPickables.current;
      if (layers.size === 0) return null;
      const p = project(clientX, clientY);
      if (!p) return null;
      const gpu = ensurePicker();
      for (const layer of layers) {
        const res = await layer.pick(gpu, camera, p.localX, p.localY);
        if (res) return res;
      }
      return null;
    };

    // ── Click gesture state (drag vs click discrimination) ──
    let downX = 0;
    let downY = 0;
    let moved = false;
    const onDown = (e: PointerEvent): void => {
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
    };

    // ── Hover, coalesced to one pick per animation frame ──
    let hoverScheduled = false;
    let hoverX = 0;
    let hoverY = 0;
    let hoverSeq = 0; // bumped every hover to drop stale async cloud results
    const runHover = (): void => {
      hoverScheduled = false;
      if (!onHoverRef.current) return;
      // Bump first, so an in-flight cloud pick from a prior frame is invalidated
      // even when this frame resolves synchronously (a box hit or an empty null).
      const seq = ++hoverSeq;
      const box = boxPickAt(hoverX, hoverY);
      if (box) {
        onHoverRef.current(box);
        return;
      }
      if (idPickables.current.size === 0) {
        onHoverRef.current(null);
        return;
      }
      void idPickAt(hoverX, hoverY).then((hit) => {
        if (seq === hoverSeq) onHoverRef.current?.(hit);
      });
    };

    const onMove = (e: PointerEvent): void => {
      const dragging = e.buttons !== 0; // any button held ⇒ orbit/pan, not hover
      if (
        dragging &&
        Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX
      )
        moved = true;
      if (hasHover && !dragging) {
        hoverX = e.clientX;
        hoverY = e.clientY;
        if (!hoverScheduled) {
          hoverScheduled = true;
          requestAnimationFrame(runHover);
        }
      }
    };

    const onUp = (e: PointerEvent): void => {
      if (!hasPick) return;
      if (moved || Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX)
        return;
      const box = boxPickAt(e.clientX, e.clientY);
      if (box) {
        onPickRef.current?.(box);
        return;
      }
      // Box miss: fall through to the GPU id-buffer pass, else report a sync null
      // (the unchanged empty-space behaviour when no id-pickables are registered).
      if (idPickables.current.size === 0) {
        onPickRef.current?.(null);
        return;
      }
      void idPickAt(e.clientX, e.clientY).then((hit) =>
        onPickRef.current?.(hit),
      );
    };

    // Clear hover when the pointer leaves the canvas (and drop any in-flight pick).
    const onLeave = (): void => {
      if (!hasHover) return;
      hoverSeq++;
      onHoverRef.current?.(null);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      picker?.dispose();
      picker = null;
    };
  }, [gl, camera, raycaster, pickables, idPickables, hasPick, hasHover]);

  return null;
}

// ─── WebGPU gl factory ─────────────────────────────────────────────────────────

/**
 * R3F v9's official async `gl` factory: r3f awaits the returned promise before
 * its first render, so `WebGPURenderer.init()` completes up front and the
 * one-time "render() before init" warning never fires — no monkeypatch needed.
 */
function makeGl(forceWebGL: boolean): GLProps {
  // r3f v9 awaits this async factory before the first render, so init() finishes
  // up front. r3f's other GL params target a WebGLRenderer, so we don't spread
  // them — we build the WebGPURenderer with just r3f's canvas + our options.
  // Casts bridge a duplicate-`OffscreenCanvas` DOM-lib type and r3f's WebGL-
  // shaped GLProps vs the WebGPURenderer factory.
  const factory = async (props: {
    canvas: HTMLCanvasElement | OffscreenCanvas;
  }) => {
    // Raise the device buffer-size ceiling on the WebGPU path so a dense LIDAR
    // sweep's single ~hundreds-of-MB vertex buffer doesn't blow the 256 MB
    // default cap (deck.gl renders it fine; WebGPU defaults are stricter).
    const device = forceWebGL ? undefined : await createHighLimitDevice();
    const renderer = new WebGPURenderer({
      canvas: props.canvas,
      antialias: true,
      alpha: true,
      forceWebGL,
      ...(device ? { device } : {}),
    } as unknown as ConstructorParameters<typeof WebGPURenderer>[0]);
    await renderer.init();
    return renderer;
  };
  return factory as unknown as GLProps;
}

// ─── Error boundary / capability fallback ──────────────────────────────────────

/** True if a WebGPU or WebGL2 backend can plausibly be created in this browser. */
function canRenderGpu(): boolean {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) return true;
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

interface BoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}
interface BoundaryState {
  failed: boolean;
}

/** Catches render-time errors in the Canvas subtree (WebGPU context loss, a tile
 *  decode/error thrown past Suspense) and shows the fallback instead of a blank
 *  or crashed viewport. */
class STTCanvasBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[STTCanvas] render error', error);
  }
  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const FALLBACK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
  background: '#05070d',
  color: '#9aa4b2',
  font: '13px system-ui, sans-serif',
  textAlign: 'center',
  padding: 24,
};

const DEFAULT_GPU_FALLBACK = (
  <div style={FALLBACK_STYLE}>
    This renderer needs WebGPU or WebGL2, which isn’t available here — try the
    deck.gl renderer.
  </div>
);

// ─── Canvas ───────────────────────────────────────────────────────────────────

export interface STTCanvasProps {
  /**
   * lon/lat anchor mapped to the world origin (usually the scene view centre).
   * Used to build the default ENU projection, and as the camera-framing / basemap
   * centre hint (e.g. the whole-earth overview the globe rig parks above).
   */
  anchor: GeoAnchor;
  /**
   * The lon/lat(+alt) → world {@link Projection} the whole scene renders under.
   * Omit for the backward-compatible default `new LocalEnuProjection(anchor)`
   * (metric ENU — the AV / local-scene frame every existing demo uses). Pass a
   * `MercatorProjection` for a flat web-map frame, or a `GlobeProjection` for a 3D
   * globe (which also switches the camera rig to an earth-orbit + enables the
   * atmosphere / 3D-tiles / `<STTGlobeBasemap>` globe path). Build it with the
   * exported projection classes; it is read once per scene (a change remounts the
   * scene graph like a dataset switch).
   *
   * @example
   * // Flat web-map (Mercator):
   * <STTCanvas anchor={c} projection={new MercatorProjection(c)} …/>
   * @example
   * // 3D globe (WGS84 datum co-registers 3D-tiles / atmosphere):
   * <STTCanvas anchor={c} projection={new GlobeProjection(c, EARTH_RADIUS, { datum: 'wgs84' })} …>
   *   <STTGlobeBasemap />
   * </STTCanvas>
   */
  projection?: Projection;
  /** Common time base (epoch-ms) — usually `timeRange.start`. */
  timeOrigin: number;
  /** Playback clock — absolute playhead in epoch-ms each frame. */
  getTime: () => number;
  /**
   * Playback governor source registry (`usePlayback().registry`). When provided,
   * each layer registers a complete source under its `id` so the start/seek gate
   * passes immediately and the cockpit transport (buffered bar / Auto-speed /
   * ETA) reflects the Three scene. Omit for an un-governed standalone canvas.
   */
  registry?: STTSourceRegistry;
  /** Scene time range (epoch-ms) reported as the buffered span to the governor. */
  timeRange?: { start: number; end: number };
  /**
   * Canvas-level streaming default: every child layer that omits its own
   * `streaming` prop inherits this. `true` streams all layers with archive
   * defaults; an options object passes tileset knobs. Omit / `false` (default)
   * keeps the backward-compatible eager Suspense path. Per-layer `streaming` wins.
   */
  streaming?: boolean | StreamingLayerOptions;
  followEgo?: boolean;
  topDown?: boolean;
  forceWebGL?: boolean;
  background?: string;
  pitchDeg?: number;
  headingDeg?: number;
  /**
   * Initial geographic camera placement (deck-parity: `longitude`/`latitude`/`zoom`
   * + optional `pitch`/`bearing`). When set, the camera is positioned via
   * `viewStateToCamera` for the active projection — correct across Mercator (web-
   * mercator) and Globe (planet) scales — instead of the AV/ENU bounds-fit. Strongly
   * recommended for geo demos; omit for AV/ENU scenes (which fit to layer bounds).
   */
  initialViewState?: ViewState;
  /**
   * Zoom-OUT floor for a flat web-mercator scene, as a map zoom. The camera
   * cannot dolly past it. Defaults to {@link MIN_MERCATOR_ZOOM} (0) — where every
   * basemap host stops, so a stacked basemap can always follow the camera.
   * Raise it to keep a scene inside a tighter range. Ignored on ENU/globe scenes.
   */
  minZoom?: number;
  /**
   * Zoom-IN ceiling for a flat web-mercator scene, as a map zoom.
   * @default {@link MAX_MERCATOR_ZOOM} (20 — deck's `MapState` ceiling)
   */
  maxZoom?: number;
  /**
   * Device pixel ratio cap. Lower (e.g. 1) for fill-bound clouds on retina — the
   * single biggest perf lever. @default clamped device ratio [1, 2].
   */
  pixelRatio?: number;
  /** Snap (no easing/damping) for `prefers-reduced-motion`. @default false */
  reducedMotion?: boolean;
  /**
   * Opt-in physically-based atmosphere / sky / day-night (WebGPU only; the WebGL2
   * fallback keeps r3f's default render, so it degrades gracefully). `true` uses
   * defaults; an options object tunes it (see {@link AtmosphereOptions}). Omit /
   * `false` (default) leaves the current render path untouched. When on, the sun
   * tracks the playhead time each frame. Prefer this OR a `<STTAtmosphere>` child,
   * not both.
   */
  atmosphere?: boolean | AtmosphereOptions;
  ground?: GroundOptions | false;
  className?: string;
  style?: React.CSSProperties;
  /** Loading fallback while layers' archives load. @default null */
  fallback?: React.ReactNode;
  /**
   * Click-to-inspect callback. Fires with the nearest hit on a click (a CPU
   * object/ego box, or a GPU-picked point-cloud feature when the click misses
   * every box), or `null` when clicking empty space. Omit to disable click
   * picking (pointer events pass straight through to the controls).
   */
  onPick?: (info: STTPickInfo | null) => void;
  /**
   * Hover callback. Fires on pointer-move (throttled to one pick per animation
   * frame) with the hovered hit — a box or a GPU-picked point-cloud feature — or
   * `null` when hovering empty space / on leaving the canvas. Suppressed while a
   * button is held (an orbit/pan drag). Omit to disable hover.
   */
  onHover?: (info: STTPickInfo | null) => void;
  /**
   * Shown when WebGPU/WebGL2 is unavailable or the Canvas subtree errors.
   * @default a built-in "needs WebGPU or WebGL2" message
   */
  renderFallback?: React.ReactNode;
  children?: React.ReactNode;
}

export function STTCanvas(props: STTCanvasProps): React.ReactElement {
  const {
    anchor,
    projection: projectionProp,
    timeOrigin,
    getTime,
    registry,
    timeRange,
    streaming,
    followEgo = false,
    topDown = false,
    forceWebGL = false,
    background = '#05070d',
    pitchDeg,
    headingDeg,
    initialViewState,
    minZoom,
    maxZoom,
    pixelRatio,
    reducedMotion = false,
    atmosphere,
    ground = {},
    className,
    style,
    fallback = null,
    onPick,
    onHover,
    renderFallback = DEFAULT_GPU_FALLBACK,
    children,
  } = props;

  const gpuOk = React.useMemo(() => canRenderGpu(), []);
  // Caller-supplied projection wins; else the backward-compatible ENU default.
  // Depend on the anchor's lng/lat primitives rather than the object identity so an
  // inline `anchor={{…}}` prop doesn't recreate the projection — and reset the
  // controls/camera built from it — on every render.
  const { longitude: anchorLng, latitude: anchorLat } = anchor;
  const projection = React.useMemo(
    () =>
      resolveCanvasProjection(projectionProp, {
        longitude: anchorLng,
        latitude: anchorLat,
      }),
    [projectionProp, anchorLng, anchorLat],
  );
  // Globe scenes swap the flat MapControls for an earth-orbit OrbitControls.
  const globe = isGlobeProjection(projection) ? projection : null;
  const egoRef = React.useRef<EgoLayerEngine | null>(null);
  const pickables = React.useRef<Set<STTPickable>>(new Set());
  const idPickables = React.useRef<Set<STTIdPickable>>(new Set());
  const layers = React.useRef<Set<STTLayer>>(new Set());
  // Stabilise the time range by value so the governor-registration effect doesn't
  // re-register every render on a fresh object identity.
  const trStart = timeRange?.start;
  const trEnd = timeRange?.end;
  const stableTimeRange = React.useMemo(
    () =>
      trStart !== undefined && trEnd !== undefined
        ? { start: trStart, end: trEnd }
        : undefined,
    [trStart, trEnd],
  );
  const ctx = React.useMemo<STTSceneCtx>(
    () => ({
      projection,
      timeOrigin,
      getTime,
      egoRef,
      pickables,
      idPickables,
      layers,
      registry,
      timeRange: stableTimeRange,
      streaming,
    }),
    [projection, timeOrigin, getTime, registry, stableTimeRange, streaming],
  );
  const groundObj = React.useMemo(
    () => (ground === false ? null : makeGround(ground)),
    // ground is effectively static for a scene; build once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!gpuOk) return <>{renderFallback}</>;

  return (
    <STTCanvasBoundary fallback={renderFallback}>
      <Canvas
        className={className}
        style={{ background, width: '100%', height: '100%', ...style }}
        gl={makeGl(forceWebGL)}
        dpr={pixelRatio ?? [1, 2]}
        camera={{ fov: 50, near: 0.1, far: 5000, position: [40, -40, 30] }}
        flat
        // Externally clocked: r3f paints nothing on its own; <RenderPump/> drives
        // one `advance()` per rAF so the scene tracks the playback clock. (Under
        // "always" + the async WebGPU factory r3f only repaints on demand — camera
        // events, not clock ticks — so the data would stick on the first frame.)
        frameloop="never"
      >
        <Ctx.Provider value={ctx}>
          {groundObj && <primitive object={groundObj} dispose={null} />}
          <CameraRig
            projection={projection}
            followEgo={followEgo}
            topDown={topDown}
            pitchDeg={pitchDeg}
            headingDeg={headingDeg}
            initialViewState={initialViewState}
            egoRef={egoRef}
            layers={layers}
            getTime={getTime}
            reducedMotion={reducedMotion}
          />
          {globe ? (
            /* Globe: OrbitControls about the earth centre — left-drag rotates the
               planet, wheel zooms, with earth-scale distance clamps. Panning is off
               so the orbit target stays pinned to the centre. Both this and the flat
               MapControls set `makeDefault`, so `<STTTiles3D globeControls>` finds
               and disables whichever is active while its ellipsoid GlobeControls own
               navigation (no double-instantiate / fight). */
            <OrbitControls
              makeDefault
              enablePan={false}
              enableDamping={!reducedMotion}
              dampingFactor={0.12}
              {...globeControlLimits(globe)}
            />
          ) : (
            <GroundControls
              projection={projection}
              reducedMotion={reducedMotion}
              minZoom={minZoom}
              maxZoom={maxZoom}
            />
          )}
          <RenderPump />
          {atmosphere && (
            <AtmosphereController
              options={atmosphere}
              forceWebGL={forceWebGL}
            />
          )}
          <GlDisposer />
          <PickController
            onPick={onPick}
            onHover={onHover}
            pickables={pickables}
            idPickables={idPickables}
          />
          <React.Suspense fallback={fallback}>{children}</React.Suspense>
        </Ctx.Provider>
      </Canvas>
    </STTCanvasBoundary>
  );
}

// ─── Deprecated spelling aliases (`Stt*` → `STT*`) ─────────────────────────────
// Same rename as the root barrel: the acronym is spelled `STT` everywhere in
// this package now. The `Stt*` component/hook names stay exported so published
// consumers keep compiling; they will be removed in a future major.
export {
  /** @deprecated Use {@link useSTTTiles}. */
  useSTTTiles as useSttTiles,
  /** @deprecated Use {@link invalidateSTTTiles}. */
  invalidateSTTTiles as invalidateSttTiles,
  /** @deprecated Use {@link STTCanvas}. */
  STTCanvas as SttCanvas,
  /** @deprecated Use {@link STTCanvasProps}. */
  type STTCanvasProps as SttCanvasProps,
  /** @deprecated Use {@link STTAtmosphere}. */
  STTAtmosphere as SttAtmosphere,
  /** @deprecated Use {@link STTGlobeBasemap}. */
  STTGlobeBasemap as SttGlobeBasemap,
  /** @deprecated Use {@link STTTiles3D}. */
  STTTiles3D as SttTiles3D,
  /** @deprecated Use {@link STTTiles3DProps}. */
  type STTTiles3DProps as SttTiles3DProps,
  /** @deprecated Use {@link STTSurfelLayer}. */
  STTSurfelLayer as SttSurfelLayer,
  /** @deprecated Use {@link STTPointCloudLayer}. */
  STTPointCloudLayer as SttPointCloudLayer,
  /** @deprecated Use {@link STTBoundingBoxLayer}. */
  STTBoundingBoxLayer as SttBoundingBoxLayer,
  /** @deprecated Use {@link STTMapPolygonLayer}. */
  STTMapPolygonLayer as SttMapPolygonLayer,
  /** @deprecated Use {@link STTMapLineLayer}. */
  STTMapLineLayer as SttMapLineLayer,
  /** @deprecated Use {@link STTIsoLayer}. */
  STTIsoLayer as SttIsoLayer,
  /** @deprecated Use {@link STTTripsLayer}. */
  STTTripsLayer as SttTripsLayer,
  /** @deprecated Use {@link STTPathLayer}. */
  STTPathLayer as SttPathLayer,
  /** @deprecated Use {@link STTOdLineLayer}. */
  STTOdLineLayer as SttOdLineLayer,
  /** @deprecated Use {@link STTArcLayer}. */
  STTArcLayer as SttArcLayer,
  /** @deprecated Use {@link STTIconLayer}. */
  STTIconLayer as SttIconLayer,
  /** @deprecated Use {@link STTColumnLayer}. */
  STTColumnLayer as SttColumnLayer,
  /** @deprecated Use {@link STTPolygonLayer}. */
  STTPolygonLayer as SttPolygonLayer,
  /** @deprecated Use {@link STTTripHeadsLayer}. */
  STTTripHeadsLayer as SttTripHeadsLayer,
  /** @deprecated Use {@link STTQuadbinLayer}. */
  STTQuadbinLayer as SttQuadbinLayer,
  /** @deprecated Use {@link STTH3Layer}. */
  STTH3Layer as SttH3Layer,
  /** @deprecated Use {@link STTFlowmapLayer}. */
  STTFlowmapLayer as SttFlowmapLayer,
  /** @deprecated Use {@link STTFlowCorridorLayer}. */
  STTFlowCorridorLayer as SttFlowCorridorLayer,
  /** @deprecated Use {@link STTEgoLayer}. */
  STTEgoLayer as SttEgoLayer,
};
