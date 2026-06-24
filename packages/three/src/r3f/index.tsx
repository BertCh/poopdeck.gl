// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * react-three-fiber binding for the STT Three engine — `@poopdeck.gl/three/r3f`.
 *
 * A DECLARATIVE layer API: `<SttCanvas>` owns the `WebGPURenderer`, a Z-up camera,
 * `OrbitControls`, the ground, and a follow-ego rig; inside it you compose layer
 * components (`<SttSurfelLayer>`, `<SttPointCloudLayer>`, `<SttBoundingBoxLayer>`,
 * `<SttMapPolygonLayer>`, `<SttMapLineLayer>`, `<SttEgoLayer>`). r3f's reconciler
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
import { MapControls } from '@react-three/drei';
import { WebGPURenderer } from 'three/webgpu';
import { Box3, Vector2, Vector3, type PerspectiveCamera } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import {
  LocalEnuProjection,
  type GeoAnchor,
  type Projection,
} from '../projection/local-enu';
import { pickBoxes, type SttPickable, type SttPickInfo } from '../lib/box-pick';
import { createCompleteBufferSource, type SttSourceRegistry } from '../lib/source-registry';
import { createHighLimitDevice } from '../renderer/webgpu-renderer';
import { SttTileSource } from '../scene/tile-source';
import { makeGround, type GroundOptions } from '../scene/ground';
import { frameBox } from '../scene/camera';
import type { SttLayer } from '../layers/layer';
import { SurfelLayer, type SurfelLayerOptions } from '../layers/surfel-layer';
import { PointCloudLayer, type PointCloudLayerOptions } from '../layers/point-cloud-layer';
import { BoundingBoxLayer, type BoundingBoxLayerOptions } from '../layers/bounding-box-layer';
import { StaticPathLayer, type StaticPathLayerOptions } from '../layers/path-layer';
import {
  StaticPolygonLayer,
  type StaticPolygonLayerOptions,
  PolygonLayer,
  type PolygonLayerOptions,
} from '../layers/polygon-layer';
import { EgoLayer, type EgoLayerOptions } from '../layers/ego-layer';
import { IsoLayer, type IsoLayerOptions } from '../layers/iso-layer';
import { TripsLayer, type TripsLayerOptions } from '../layers/trips-layer';
import { PathGeoLayer, type PathGeoLayerOptions } from '../layers/path-geo-layer';
import { OdLineLayer, type OdLineLayerOptions } from '../layers/od-line-layer';
import { ArcLayer, type ArcLayerOptions } from '../layers/arc-layer';
import { IconLayer, type IconLayerOptions } from '../layers/icon-layer';
import { ColumnLayer, type ColumnLayerOptions } from '../layers/column-layer';
import { TripHeadsLayer, type TripHeadsLayerOptions } from '../layers/trip-heads-layer';
import {
  QuadbinSummaryLayer,
  type QuadbinSummaryLayerOptions,
} from '../layers/quadbin-summary-layer';
import { H3SummaryLayer, type H3SummaryLayerOptions } from '../layers/h3-summary-layer';
import { FlowmapLayer, type FlowmapLayerOptions } from '../layers/flowmap-layer';
import { FlowCorridorLayer, type FlowCorridorLayerOptions } from '../layers/flow-corridor-layer';
import { makeGlobeBasemap, type GlobeBasemapOptions } from '../scene/globe-basemap';
import { GlobeProjection } from '../projection/globe';

// ─── Context ──────────────────────────────────────────────────────────────────

interface SttSceneCtx {
  projection: Projection;
  timeOrigin: number;
  getTime: () => number;
  egoRef: React.MutableRefObject<EgoLayer | null>;
  /** Layers contributing pickable boxes (objects + ego) for click-to-inspect. */
  pickables: React.MutableRefObject<Set<SttPickable>>;
  /** All mounted layers — CameraRig frames to the union of their world AABBs. */
  layers: React.MutableRefObject<Set<SttLayer>>;
  /** Playback governor source registry (so the clock gates on buffer readiness). */
  registry?: SttSourceRegistry;
  /** Scene time range (epoch-ms) reported as the buffered span to the governor. */
  timeRange?: { start: number; end: number };
}
const Ctx = React.createContext<SttSceneCtx | null>(null);

function useSttScene(): SttSceneCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error('STT layer components must be rendered inside <SttCanvas>');
  return c;
}

// ─── Suspense tile loader (with a bounded LRU) ──────────────────────────────────

interface CacheEntry {
  status: 'pending' | 'done' | 'error';
  promise: Promise<void>;
  tiles?: Tile[];
  error?: unknown;
  source: SttTileSource;
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
export function useSttTiles(url: string, lodMode?: 'additive'): Tile[] {
  const key = tileCacheKey(url, lodMode);
  let entry = tileCache.get(key);
  if (!entry) {
    const source = new SttTileSource({ url, lodMode });
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
  // (logged once). `invalidateSttTiles(url)` or a reload retries.
  if (entry.status === 'error') {
    warnOnce(`tiles:${key}`, `[stt-three] tiles failed to load (${url}); rendering empty`, entry.error);
    return [];
  }
  return entry.tiles!;
}

/** Drop a cached archive so it reloads next mount (rarely needed). */
export function invalidateSttTiles(url: string, lodMode?: 'additive'): void {
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
function useEngineLayer<L extends SttLayer>(
  make: () => L,
  tiles: Tile[],
  deps: React.DependencyList,
  gov: LayerGovernance,
): L {
  const { projection, timeOrigin, getTime, layers, registry, timeRange } = useSttScene();
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layer = React.useMemo(make, deps);
  // Build GPU buffers once tiles are resolved (Suspense guarantees they are).
  React.useMemo(() => {
    try {
      layer.setTiles(tiles, { projection, timeOrigin });
    } catch (err) {
      warnOnce(`setTiles:${gov.sourceId}`, `[stt-three] setTiles failed for ${gov.sourceId}`, err);
    }
  }, [layer, tiles, projection, timeOrigin]);
  // CRITICAL: a per-frame throw here (transient decode/NaN, a WGSL build hiccup)
  // must NOT kill r3f's render loop — that strands the canvas on the last frame
  // while the clock runs on. Swallow it (logged once) so the next frame paints.
  useFrame(() => {
    try {
      layer.setTime(getTime());
    } catch (err) {
      warnOnce(`setTime:${gov.sourceId}`, `[stt-three] setTime failed for ${gov.sourceId}`, err);
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
    (layer as unknown as { setViewport?: (w: number, h: number) => void }).setViewport?.(
      dims.x,
      dims.y,
    );
  }, [layer, gl, size.width, size.height]);

  React.useEffect(() => () => layer.dispose(), [layer]);
  return layer;
}

interface UrlProp {
  url: string;
  /** Additive-octree LOD: load the UNION of all zoom levels (see SttTileSource). */
  lodMode?: 'additive';
  /**
   * Whether this layer gates the playback clock as a REQUIRED governor source.
   * @default true (map overlays pass false, matching the deck path).
   */
  sourceRequired?: boolean;
}

export function SttSurfelLayer(props: SurfelLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new SurfelLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttPointCloudLayer(props: PointCloudLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new PointCloudLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttBoundingBoxLayer(props: BoundingBoxLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const { pickables } = useSttScene();
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new BoundingBoxLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  React.useEffect(() => {
    const set = pickables.current;
    set.add(layer);
    return () => {
      set.delete(layer);
    };
  }, [layer, pickables]);
  return <primitive object={layer.object} dispose={null} />;
}

export function SttMapPolygonLayer(props: StaticPolygonLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new StaticPolygonLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    // Map overlays load coordinated but never gate the clock (HD-map idiom).
    required: sourceRequired ?? false,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttMapLineLayer(props: StaticPathLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new StaticPathLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired ?? false,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttIsoLayer(props: IsoLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new IsoLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttTripsLayer(props: TripsLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new TripsLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttPathLayer(props: PathGeoLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new PathGeoLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttOdLineLayer(props: OdLineLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new OdLineLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttArcLayer(props: ArcLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new ArcLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttIconLayer(props: IconLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new IconLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttColumnLayer(props: ColumnLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new ColumnLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttPolygonLayer(props: PolygonLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new PolygonLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttTripHeadsLayer(props: TripHeadsLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new TripHeadsLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttQuadbinLayer(props: QuadbinSummaryLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new QuadbinSummaryLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttH3Layer(props: H3SummaryLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new H3SummaryLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttFlowmapLayer(props: FlowmapLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new FlowmapLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttFlowCorridorLayer(props: FlowCorridorLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new FlowCorridorLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  return <primitive object={layer.object} dispose={null} />;
}

export function SttEgoLayer(props: EgoLayerOptions & UrlProp): React.ReactElement {
  const { url, lodMode, sourceRequired, ...opts } = props;
  const { egoRef, pickables } = useSttScene();
  const tiles = useSttTiles(url, lodMode);
  const layer = useEngineLayer(() => new EgoLayer(opts), tiles, [url, lodMode], {
    sourceId: opts.id,
    cacheKey: tileCacheKey(url, lodMode),
    required: sourceRequired,
  });
  React.useEffect(() => {
    egoRef.current = layer;
    const set = pickables.current;
    set.add(layer);
    return () => {
      if (egoRef.current === layer) egoRef.current = null;
      set.delete(layer);
    };
  }, [layer, egoRef, pickables]);
  return <primitive object={layer.object} dispose={null} />;
}

/**
 * Earth-sphere basemap primitive for the globe demos. Reads the globe radius from
 * the scene's `GlobeProjection` when present; on a planar scene pass an explicit
 * `globe` prop. Not a tile-backed layer — a single static `Mesh`.
 */
export function SttGlobeBasemap(
  props: GlobeBasemapOptions & { globe?: GlobeProjection },
): React.ReactElement {
  const { globe: globeProp, ...opts } = props;
  const { projection } = useSttScene();
  const globe =
    globeProp ?? (projection instanceof GlobeProjection ? projection : undefined);
  if (!globe) {
    throw new Error(
      'SttGlobeBasemap needs a GlobeProjection: render inside a globe scene or pass `globe`.',
    );
  }
  const mesh = React.useMemo(() => makeGlobeBasemap(globe, opts), [globe, opts]);
  return <primitive object={mesh} dispose={null} />;
}

// ─── Camera rig ───────────────────────────────────────────────────────────────

/** Time constant (s) for the ego-follow easing (≈ deck's positionTau). */
const FOLLOW_TAU_S = 0.25;

function CameraRig(props: {
  followEgo: boolean;
  topDown: boolean;
  pitchDeg?: number;
  headingDeg?: number;
  egoRef: React.MutableRefObject<EgoLayer | null>;
  layers: React.MutableRefObject<Set<SttLayer>>;
  getTime: () => number;
  reducedMotion: boolean;
}): null {
  const { followEgo, topDown, pitchDeg, headingDeg, egoRef, layers, getTime, reducedMotion } =
    props;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const get = useThree((s) => s.get);
  // Eased ego position (the camera target chases this); null = snap next frame.
  const easedEgo = React.useRef<Vector3 | null>(null);
  const framed = React.useRef(false);

  // Z-up world.
  React.useEffect(() => {
    camera.up.set(0, 0, 1);
  }, [camera]);

  // Re-frame to bounds when follow turns off or the view (top-down) flips. A
  // dataset switch remounts the whole Canvas, so a fresh rig re-frames anyway.
  React.useEffect(() => {
    framed.current = false;
    easedEgo.current = null;
  }, [followEgo, topDown]);

  useFrame((_state, delta) => {
   // Guard: a throw in the camera rig must not kill r3f's render loop either.
   try {
    const controls = get().controls as { target: Vector3; update: () => void } | null;

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
          pitchDeg: topDown ? 89 : pitchDeg ?? 55,
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

// ─── Picking (click-to-inspect) ────────────────────────────────────────────────

/**
 * Hit-tests a click against the registered pickable layers' boxes (objects +
 * ego) and reports the nearest hit (or `null` on a miss) via `onPick`. A pointer
 * gesture that moves past a small threshold is treated as an OrbitControls drag,
 * not a pick. Mounted only when an `onPick` consumer is present.
 */
function PickController(props: {
  onPick?: (info: SttPickInfo | null) => void;
  pickables: React.MutableRefObject<Set<SttPickable>>;
}): null {
  const camera = useThree((s) => s.camera);
  const raycaster = useThree((s) => s.raycaster);
  const gl = useThree((s) => s.gl);
  const { pickables } = props;
  const hasPick = !!props.onPick;
  const onPickRef = React.useRef(props.onPick);
  onPickRef.current = props.onPick;

  React.useEffect(() => {
    if (!hasPick) return; // no consumer → don't intercept pointer events
    const el = gl.domElement;
    const DRAG_PX = 6; // a drag past this is an orbit, not a click
    let downX = 0;
    let downY = 0;
    let moved = false;
    const onDown = (e: PointerEvent): void => {
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
    };
    const onMove = (e: PointerEvent): void => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) moved = true;
    };
    const onUp = (e: PointerEvent): void => {
      if (moved || Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const ndc = new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const o = raycaster.ray.origin;
      const d = raycaster.ray.direction;
      const boxes = Array.from(pickables.current).flatMap((p) => p.getPickBoxes());
      onPickRef.current?.(pickBoxes([o.x, o.y, o.z], [d.x, d.y, d.z], boxes));
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
  }, [gl, camera, raycaster, pickables, hasPick]);

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
  const factory = async (props: { canvas: HTMLCanvasElement | OffscreenCanvas }) => {
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
class SttCanvasBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[SttCanvas] render error', error);
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
    This renderer needs WebGPU or WebGL2, which isn’t available here — try the deck.gl renderer.
  </div>
);

// ─── Canvas ───────────────────────────────────────────────────────────────────

export interface SttCanvasProps {
  /** lon/lat anchor mapped to the world origin (usually the scene view centre). */
  anchor: GeoAnchor;
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
  registry?: SttSourceRegistry;
  /** Scene time range (epoch-ms) reported as the buffered span to the governor. */
  timeRange?: { start: number; end: number };
  followEgo?: boolean;
  topDown?: boolean;
  forceWebGL?: boolean;
  background?: string;
  pitchDeg?: number;
  headingDeg?: number;
  /**
   * Device pixel ratio cap. Lower (e.g. 1) for fill-bound clouds on retina — the
   * single biggest perf lever. @default clamped device ratio [1, 2].
   */
  pixelRatio?: number;
  /** Snap (no easing/damping) for `prefers-reduced-motion`. @default false */
  reducedMotion?: boolean;
  ground?: GroundOptions | false;
  className?: string;
  style?: React.CSSProperties;
  /** Loading fallback while layers' archives load. @default null */
  fallback?: React.ReactNode;
  /**
   * Click-to-inspect callback. Fires with the nearest hit object/ego box on a
   * click, or `null` when clicking empty space. Omit to disable picking (pointer
   * events pass straight through to OrbitControls).
   */
  onPick?: (info: SttPickInfo | null) => void;
  /**
   * Shown when WebGPU/WebGL2 is unavailable or the Canvas subtree errors.
   * @default a built-in "needs WebGPU or WebGL2" message
   */
  renderFallback?: React.ReactNode;
  children?: React.ReactNode;
}

export function SttCanvas(props: SttCanvasProps): React.ReactElement {
  const {
    anchor,
    timeOrigin,
    getTime,
    registry,
    timeRange,
    followEgo = false,
    topDown = false,
    forceWebGL = false,
    background = '#05070d',
    pitchDeg,
    headingDeg,
    pixelRatio,
    reducedMotion = false,
    ground = {},
    className,
    style,
    fallback = null,
    onPick,
    renderFallback = DEFAULT_GPU_FALLBACK,
    children,
  } = props;

  const gpuOk = React.useMemo(() => canRenderGpu(), []);
  const projection = React.useMemo(
    () => new LocalEnuProjection(anchor),
    [anchor.longitude, anchor.latitude],
  );
  const egoRef = React.useRef<EgoLayer | null>(null);
  const pickables = React.useRef<Set<SttPickable>>(new Set());
  const layers = React.useRef<Set<SttLayer>>(new Set());
  // Stabilise the time range by value so the governor-registration effect doesn't
  // re-register every render on a fresh object identity.
  const trStart = timeRange?.start;
  const trEnd = timeRange?.end;
  const stableTimeRange = React.useMemo(
    () => (trStart !== undefined && trEnd !== undefined ? { start: trStart, end: trEnd } : undefined),
    [trStart, trEnd],
  );
  const ctx = React.useMemo<SttSceneCtx>(
    () => ({
      projection,
      timeOrigin,
      getTime,
      egoRef,
      pickables,
      layers,
      registry,
      timeRange: stableTimeRange,
    }),
    [projection, timeOrigin, getTime, registry, stableTimeRange],
  );
  const groundObj = React.useMemo(
    () => (ground === false ? null : makeGround(ground)),
    // ground is effectively static for a scene; build once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!gpuOk) return <>{renderFallback}</>;

  return (
    <SttCanvasBoundary fallback={renderFallback}>
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
            followEgo={followEgo}
            topDown={topDown}
            pitchDeg={pitchDeg}
            headingDeg={headingDeg}
            egoRef={egoRef}
            layers={layers}
            getTime={getTime}
            reducedMotion={reducedMotion}
          />
          {/* MapControls (not OrbitControls) so left-drag PANS across the ground
              plane — a map-style gesture matching the deck cockpit's MapController
              — instead of orbiting a point. Right-drag still rotates; wheel zooms.
              Panning is in the XY plane because the camera up is Z. */}
          <MapControls makeDefault enableDamping={!reducedMotion} dampingFactor={0.12} />
          <RenderPump />
          <GlDisposer />
          <PickController onPick={onPick} pickables={pickables} />
          <React.Suspense fallback={fallback}>{children}</React.Suspense>
        </Ctx.Provider>
      </Canvas>
    </SttCanvasBoundary>
  );
}
