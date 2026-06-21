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
 * WebGPU: the `gl` factory wraps the renderer so `render()` is a no-op until
 * `init()` resolves — this suppresses the one-time "render() before init" warning
 * AND draws to r3f's own canvas (so nothing is blank).
 */

import * as React from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { WebGPURenderer } from 'three/webgpu';
import { Vector3, MathUtils, type PerspectiveCamera } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import {
  LocalEnuProjection,
  type GeoAnchor,
  type Projection,
} from '../projection/local-enu';
import { SttTileSource } from '../scene/tile-source';
import { makeGround, type GroundOptions } from '../scene/ground';
import type { SttLayer } from '../layers/layer';
import { SurfelLayer, type SurfelLayerOptions } from '../layers/surfel-layer';
import { PointCloudLayer, type PointCloudLayerOptions } from '../layers/point-cloud-layer';
import { BoundingBoxLayer, type BoundingBoxLayerOptions } from '../layers/bounding-box-layer';
import { StaticPathLayer, type StaticPathLayerOptions } from '../layers/path-layer';
import { StaticPolygonLayer, type StaticPolygonLayerOptions } from '../layers/polygon-layer';
import { EgoLayer, type EgoLayerOptions } from '../layers/ego-layer';

// ─── Context ──────────────────────────────────────────────────────────────────

interface SttSceneCtx {
  projection: Projection;
  timeOrigin: number;
  getTime: () => number;
  egoRef: React.MutableRefObject<EgoLayer | null>;
}
const Ctx = React.createContext<SttSceneCtx | null>(null);

function useSttScene(): SttSceneCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error('STT layer components must be rendered inside <SttCanvas>');
  return c;
}

// ─── Suspense tile loader ─────────────────────────────────────────────────────

interface CacheEntry {
  status: 'pending' | 'done' | 'error';
  promise: Promise<void>;
  tiles?: Tile[];
  error?: unknown;
}
const tileCache = new Map<string, CacheEntry>();

/** Load (and cache) every tile for an archive URL, suspending until ready. */
export function useSttTiles(url: string): Tile[] {
  let entry = tileCache.get(url);
  if (!entry) {
    const source = new SttTileSource({ url });
    const e: CacheEntry = { status: 'pending', promise: Promise.resolve() };
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
    tileCache.set(url, e);
  }
  if (entry.status === 'pending') throw entry.promise;
  if (entry.status === 'error') throw entry.error;
  return entry.tiles!;
}

/** Drop a cached archive so it reloads next mount (rarely needed). */
export function invalidateSttTiles(url: string): void {
  tileCache.delete(url);
}

// ─── Layer plumbing ───────────────────────────────────────────────────────────

/** Build geometry from suspended tiles, drive the clock, dispose on unmount. */
function useEngineLayer<L extends SttLayer>(
  make: () => L,
  tiles: Tile[],
  deps: React.DependencyList,
): L {
  const { projection, timeOrigin, getTime } = useSttScene();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layer = React.useMemo(make, deps);
  // Build GPU buffers once tiles are resolved (Suspense guarantees they are).
  React.useMemo(
    () => layer.setTiles(tiles, { projection, timeOrigin }),
    [layer, tiles, projection, timeOrigin],
  );
  useFrame(() => layer.setTime(getTime()));
  React.useEffect(() => () => layer.dispose(), [layer]);
  return layer;
}

interface UrlProp {
  url: string;
}

export function SttSurfelLayer(props: SurfelLayerOptions & UrlProp): React.ReactElement {
  const { url, ...opts } = props;
  const tiles = useSttTiles(url);
  const layer = useEngineLayer(() => new SurfelLayer(opts), tiles, [url]);
  return <primitive object={layer.object} dispose={null} />;
}

export function SttPointCloudLayer(props: PointCloudLayerOptions & UrlProp): React.ReactElement {
  const { url, ...opts } = props;
  const tiles = useSttTiles(url);
  const layer = useEngineLayer(() => new PointCloudLayer(opts), tiles, [url]);
  return <primitive object={layer.object} dispose={null} />;
}

export function SttBoundingBoxLayer(props: BoundingBoxLayerOptions & UrlProp): React.ReactElement {
  const { url, ...opts } = props;
  const tiles = useSttTiles(url);
  const layer = useEngineLayer(() => new BoundingBoxLayer(opts), tiles, [url]);
  return <primitive object={layer.object} dispose={null} />;
}

export function SttMapPolygonLayer(props: StaticPolygonLayerOptions & UrlProp): React.ReactElement {
  const { url, ...opts } = props;
  const tiles = useSttTiles(url);
  const layer = useEngineLayer(() => new StaticPolygonLayer(opts), tiles, [url]);
  return <primitive object={layer.object} dispose={null} />;
}

export function SttMapLineLayer(props: StaticPathLayerOptions & UrlProp): React.ReactElement {
  const { url, ...opts } = props;
  const tiles = useSttTiles(url);
  const layer = useEngineLayer(() => new StaticPathLayer(opts), tiles, [url]);
  return <primitive object={layer.object} dispose={null} />;
}

export function SttEgoLayer(props: EgoLayerOptions & UrlProp): React.ReactElement {
  const { url, ...opts } = props;
  const { egoRef } = useSttScene();
  const tiles = useSttTiles(url);
  const layer = useEngineLayer(() => new EgoLayer(opts), tiles, [url]);
  React.useEffect(() => {
    egoRef.current = layer;
    return () => {
      if (egoRef.current === layer) egoRef.current = null;
    };
  }, [layer, egoRef]);
  return <primitive object={layer.object} dispose={null} />;
}

// ─── Camera rig ───────────────────────────────────────────────────────────────

function CameraRig(props: {
  followEgo: boolean;
  topDown: boolean;
  pitchDeg?: number;
  headingDeg?: number;
  egoRef: React.MutableRefObject<EgoLayer | null>;
  getTime: () => number;
}): null {
  const { followEgo, topDown, pitchDeg, headingDeg, egoRef, getTime } = props;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const get = useThree((s) => s.get);
  const lastEgo = React.useRef<Vector3 | null>(null);

  // Z-up + frame to the origin (≈ scene centre) at street level.
  React.useEffect(() => {
    camera.up.set(0, 0, 1);
    const pitch = MathUtils.degToRad(topDown ? 89 : pitchDeg ?? 55);
    const heading = MathUtils.degToRad(headingDeg ?? 20);
    const dist = topDown ? 130 : 60;
    const horiz = Math.cos(pitch);
    camera.position.set(
      Math.cos(heading) * horiz * dist,
      Math.sin(heading) * horiz * dist,
      Math.sin(pitch) * dist,
    );
    camera.lookAt(0, 0, 0);
    const controls = get().controls as { target: Vector3; update: () => void } | null;
    if (controls?.target) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }, [camera, topDown, pitchDeg, headingDeg, get]);

  useFrame(() => {
    if (!followEgo) {
      lastEgo.current = null;
      return;
    }
    const ego = egoRef.current;
    const controls = get().controls as { target: Vector3; update: () => void } | null;
    if (ego && controls?.target) {
      const pose = ego.getEgoPose(getTime());
      if (pose) {
        const p = new Vector3(pose.x, pose.y, pose.z);
        if (lastEgo.current) camera.position.add(p.clone().sub(lastEgo.current));
        controls.target.copy(p);
        controls.update();
        lastEgo.current = p;
      }
    }
  });

  return null;
}

// ─── WebGPU gl factory (warning-free) ─────────────────────────────────────────

function makeGl(forceWebGL: boolean) {
  return (props: { canvas: HTMLCanvasElement }): unknown => {
    const renderer = new WebGPURenderer({
      canvas: props.canvas,
      antialias: true,
      alpha: true,
      forceWebGL,
    } as ConstructorParameters<typeof WebGPURenderer>[0]);
    // Suppress the one-time "render() before init" warning: no-op render until
    // the async backend init resolves, then restore the real render.
    const realRender = renderer.render.bind(renderer);
    let inited = false;
    (renderer as unknown as { render: (s: unknown, c: unknown) => void }).render = (s, c) => {
      if (inited) realRender(s as never, c as never);
    };
    renderer
      .init()
      .then(() => {
        inited = true;
        (renderer as unknown as { render: unknown }).render = realRender;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[SttCanvas] WebGPU init failed', err);
      });
    return renderer;
  };
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

export interface SttCanvasProps {
  /** lon/lat anchor mapped to the world origin (usually the scene view centre). */
  anchor: GeoAnchor;
  /** Common time base (epoch-ms) — usually `timeRange.start`. */
  timeOrigin: number;
  /** Playback clock — absolute playhead in epoch-ms each frame. */
  getTime: () => number;
  followEgo?: boolean;
  topDown?: boolean;
  forceWebGL?: boolean;
  background?: string;
  pitchDeg?: number;
  headingDeg?: number;
  ground?: GroundOptions | false;
  className?: string;
  style?: React.CSSProperties;
  /** Loading fallback while layers' archives load. @default null */
  fallback?: React.ReactNode;
  children?: React.ReactNode;
}

export function SttCanvas(props: SttCanvasProps): React.ReactElement {
  const {
    anchor,
    timeOrigin,
    getTime,
    followEgo = false,
    topDown = false,
    forceWebGL = false,
    background = '#05070d',
    pitchDeg,
    headingDeg,
    ground = {},
    className,
    style,
    fallback = null,
    children,
  } = props;

  const projection = React.useMemo(
    () => new LocalEnuProjection(anchor),
    [anchor.longitude, anchor.latitude],
  );
  const egoRef = React.useRef<EgoLayer | null>(null);
  const ctx = React.useMemo<SttSceneCtx>(
    () => ({ projection, timeOrigin, getTime, egoRef }),
    [projection, timeOrigin, getTime],
  );
  const groundObj = React.useMemo(
    () => (ground === false ? null : makeGround(ground)),
    // ground is effectively static for a scene; build once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <Canvas
      className={className}
      style={{ background, width: '100%', height: '100%', ...style }}
      gl={makeGl(forceWebGL) as never}
      camera={{ fov: 50, near: 0.1, far: 5000, position: [40, -40, 30] }}
      flat
      frameloop="always"
    >
      <Ctx.Provider value={ctx}>
        {groundObj && <primitive object={groundObj} dispose={null} />}
        <CameraRig
          followEgo={followEgo}
          topDown={topDown}
          pitchDeg={pitchDeg}
          headingDeg={headingDeg}
          egoRef={egoRef}
          getTime={getTime}
        />
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
        <React.Suspense fallback={fallback}>{children}</React.Suspense>
      </Ctx.Provider>
    </Canvas>
  );
}
