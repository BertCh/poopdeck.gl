// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `StandaloneViewer` — a vanilla (no-React, no-r3f) Three.js mount for an
 * {@link SttScene}. It owns the `WebGPURenderer`, a Z-up camera, `OrbitControls`,
 * and the rAF loop, and is the robust integration path: because it **awaits
 * `renderer.init()` before the first render**, it never hits the "render() before
 * the backend is initialized" warning (and never paints a blank first frame) the
 * way react-three-fiber v8 does — r3f renders an on-demand frame at mount before
 * the async WebGPU init can resolve. Use this from any framework via a thin
 * effect (see the showcase `AvThreeViewer`); the r3f binding stays available in
 * `@poopdeck.gl/three/r3f` for declarative apps that accept that one-time warning.
 */

import { Scene, PerspectiveCamera, Vector3, Color, AxesHelper } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SttScene } from '../scene/stt-three-scene.js';
import { cameraToViewport } from '../scene/streaming-tile-source.js';
import type { EgoLayer } from '../layers/ego-layer.js';
import { frameBox } from '../scene/camera.js';
import {
  createHighLimitDevice,
  resolveBackend,
  type RendererBackend,
} from '../renderer/webgpu-renderer.js';
import {
  createSttAtmosphere,
  type AtmosphereOptions,
  type SttAtmosphere,
} from '../scene/atmosphere.js';
import {
  createStt3DTiles,
  type Stt3DTiles,
  type Stt3DTilesOptions,
} from '../scene/tiles-3d.js';
import { createSttGlobeControls, type SttGlobeControls } from '../scene/globe-controls.js';
import { frameGlobe } from '../scene/globe-camera.js';
import { GlobeProjection } from '../projection/globe.js';

/**
 * Minimum interval (ms) between viewport pumps into the streaming tileset. The
 * tileset debounces internally, but re-deriving the frustum footprint every
 * frame is wasted work when the camera is idle — a ~10 Hz cadence keeps
 * streaming responsive without per-frame cost. (Playhead time rides along on the
 * same pump, so temporal selection lags by at most this interval — imperceptible.)
 */
const STREAM_UPDATE_MS = 100;

export interface StandaloneViewerOptions {
  /** Playback clock — absolute playhead in epoch-ms each frame. */
  getTime: () => number;
  egoLayer?: EgoLayer | null;
  followEgo?: boolean;
  topDown?: boolean;
  forceWebGL?: boolean;
  background?: number;
  pitchDeg?: number;
  headingDeg?: number;
  onBackend?: (backend: RendererBackend) => void;
  /**
   * Opt-in physically-based atmosphere / sky / day-night (WebGPU only; ignored on
   * the WebGL2 fallback). `true` enables it with defaults; an options object tunes
   * it (see {@link AtmosphereOptions}). Omit / `false` (default) keeps the current
   * behaviour exactly. Most impactful on globe scenes. The sun tracks the playhead
   * time each frame via `getTime`.
   */
  atmosphere?: boolean | AtmosphereOptions;
  /**
   * Opt-in OGC 3D Tiles overlay (real terrain, Google Photorealistic Tiles, Cesium
   * Ion). Adds the tileset group to the scene and drives its LOD update each frame.
   * Co-registers with STT's ECEF globe world — a globe scene MUST use the `'wgs84'`
   * datum (see {@link createStt3DTiles}). Omit (default) keeps the current scene
   * untouched. Works on both the WebGPU and WebGL2 paths.
   */
  tiles3d?: Stt3DTilesOptions;
  /**
   * Use ellipsoid-aware `GlobeControls` instead of `OrbitControls` for globe
   * navigation (horizon-aware, zoom-to-cursor, auto earth-scale near/far). Reuses
   * the {@link tiles3d} ellipsoid frame when both are set. @default false
   */
  globeControls?: boolean;
  /** Log diagnostics + drop a bright axes gizmo at the cloud centre (bring-up). */
  debug?: boolean;
}

export class StandaloneViewer {
  private readonly threeScene = new Scene();
  private readonly camera: PerspectiveCamera;
  private renderer: WebGPURenderer | null = null;
  private controls: OrbitControls | null = null;
  private raf = 0;
  private disposed = false;
  private started = false;
  private resizeObs: ResizeObserver | null = null;
  private lastEgo: Vector3 | null = null;
  private followEgo: boolean;
  private topDown: boolean;
  /** Cached at load: does the scene hold any viewport-driven streaming layer? */
  private streaming = false;
  /** Timestamp of the last streaming viewport pump (for the STREAM_UPDATE_MS throttle). */
  private lastStreamUpdate = 0;
  /** Previous playhead time — a change ⇒ animating (drives prefetch). */
  private lastTime = Number.NaN;
  /** Streaming scenes start empty; re-frame once the first tiles give real bounds. */
  private framedToData = false;
  /** Opt-in atmosphere (WebGPU only); when set, drives the per-frame render. */
  private atmosphere: SttAtmosphere | null = null;
  /** Opt-in OGC 3D Tiles overlay; when set, pumped each frame. */
  private tiles3d: Stt3DTiles | null = null;
  /** Ellipsoid-aware globe controls (replaces OrbitControls when `globeControls`). */
  private globeControlsHandle: SttGlobeControls | null = null;
  /** Cached at construction: use GlobeControls rather than OrbitControls. */
  private readonly useGlobeControls: boolean;

  constructor(
    private readonly container: HTMLElement,
    private readonly scene: SttScene,
    private readonly opts: StandaloneViewerOptions,
  ) {
    this.followEgo = opts.followEgo ?? false;
    this.topDown = opts.topDown ?? false;
    this.useGlobeControls = opts.globeControls ?? false;
    this.camera = new PerspectiveCamera(50, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1); // Z-up world
    this.camera.position.set(40, -40, 30);
    this.threeScene.add(scene.root);
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const forceWebGL = this.opts.forceWebGL ?? false;
    // High-buffer-limit device for the WebGPU path so dense LIDAR sweeps clear
    // the 256 MB default single-buffer cap (see createHighLimitDevice).
    const device = forceWebGL ? undefined : await createHighLimitDevice();
    const renderer = new WebGPURenderer({
      antialias: true,
      alpha: true,
      forceWebGL,
      ...(device ? { device } : {}),
    } as ConstructorParameters<typeof WebGPURenderer>[0]);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(new Color(this.opts.background ?? 0x05070d), 1);
    const el = renderer.domElement as HTMLCanvasElement;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.display = 'block';
    this.container.appendChild(el);

    // Await init BEFORE the first render — the whole point of this mount.
    try {
      await renderer.init();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[StandaloneViewer] WebGPU init failed', err);
    }
    if (this.disposed) {
      renderer.dispose();
      el.remove();
      return;
    }
    this.renderer = renderer;
    const backend = resolveBackend(renderer, forceWebGL);
    this.opts.onBackend?.(backend);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // OrbitControls is the default; a globe scene opts into GlobeControls instead
    // (created below, once the tileset ellipsoid exists).
    if (!this.useGlobeControls) {
      this.controls = new OrbitControls(this.camera, el);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.12;
    }

    // Load the scene (eager sources resolve fully; streaming sources build their
    // tileset), then frame the camera. Streaming scenes have no tiles yet, so the
    // initial frame targets empty bounds — the loop re-frames once tiles arrive.
    try {
      await this.scene.load();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[StandaloneViewer] scene load failed', err);
    }
    if (this.disposed) return;
    this.streaming = this.scene.hasStreamingLayers();

    // Opt-in OGC 3D Tiles overlay (real terrain / Google Photorealistic / Ion).
    // Standard meshes, so it works on both backends. Added to the scene here so
    // the atmosphere post-pipeline (below) draws it too. Set up before framing so
    // the globe view can position the camera against the tileset ellipsoid.
    if (this.opts.tiles3d) {
      try {
        const tiles = await createStt3DTiles({
          ...this.opts.tiles3d,
          renderer,
          scene: this.threeScene,
          camera: this.camera,
          projection: this.scene.projection,
        });
        if (this.disposed) tiles.dispose();
        else this.tiles3d = tiles;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[StandaloneViewer] 3D tiles setup failed; continuing without them', err);
      }
    }

    // Opt-in ellipsoid-aware globe navigation (replaces OrbitControls). Reuses the
    // tileset's aligned ellipsoid frame when tiles3d is on.
    if (this.useGlobeControls) {
      try {
        const gc = await createSttGlobeControls({
          scene: this.threeScene,
          camera: this.camera,
          domElement: el,
          projection: this.scene.projection,
          tiles: this.tiles3d,
        });
        if (this.disposed) gc.dispose();
        else this.globeControlsHandle = gc;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[StandaloneViewer] globe controls setup failed', err);
      }
    }

    // Frame: a globe scene parks a whole-earth overview (GlobeControls then refines
    // near/far each frame); everything else fits the data bounds via OrbitControls.
    if (this.useGlobeControls) this.frameGlobeView();
    else this.frame();

    // Opt-in atmosphere: WebGPU only (the pass→MRT→aerialPerspective pipeline and
    // TSL sky/light nodes compile only on WebGPURenderer). On WebGL2 we simply
    // skip it and keep the plain render path — a graceful, crash-free degrade.
    if (this.opts.atmosphere && backend === 'webgpu') {
      const atmoOpts = this.opts.atmosphere === true ? {} : this.opts.atmosphere;
      try {
        const atmosphere = await createSttAtmosphere({
          ...atmoOpts,
          renderer,
          scene: this.threeScene,
          camera: this.camera,
          projection: this.scene.projection,
        });
        if (this.disposed) atmosphere.dispose();
        else this.atmosphere = atmosphere;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[StandaloneViewer] atmosphere setup failed; rendering without it', err);
      }
    }

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);
    this.loop();
  }

  /** Frame the camera to the current scene bounds at the current pitch/heading. */
  private frame(): void {
    if (!this.controls) return;
    const box = this.scene.computeBounds();
    const center = frameBox(this.camera, box, {
      pitchDeg: this.topDown ? 89 : this.opts.pitchDeg ?? 55,
      headingDeg: this.opts.headingDeg ?? 20,
      margin: 1.4,
      // Street-level cap: a big drive spans hundreds of m, but fitting it all
      // pushes the camera so far that cm-scale surfels go sub-pixel.
      minDistance: 25,
      maxDistance: this.topDown ? 220 : 90,
    });
    this.controls.target.copy(center);
    this.controls.update();
    this.lastEgo = null;
    if (this.opts.debug && !this.diagLogged) {
      // A 10 m bright axes gizmo at the cloud centre: if you can see THIS but no
      // cloud, the camera/renderer are fine and it's a data/material issue.
      const axes = new AxesHelper(10);
      axes.position.copy(center);
      this.threeScene.add(axes);
    }
    this.logDiagnostics(box);
  }

  private diagLogged = false;
  private logDiagnostics(box: import('three').Box3): void {
    if (this.diagLogged) return;
    this.diagLogged = true;
    if (!this.opts.debug) return;
    const layers = this.scene.getLayers().map((l) => {
      const o = l.object as unknown as {
        type: string;
        geometry?: { instanceCount?: number; drawRange?: { count: number }; boundingBox?: unknown };
      };
      const g = o.geometry;
      return {
        id: l.id,
        type: o.type,
        instanceCount: g?.instanceCount,
        drawCount: g?.drawRange?.count,
      };
    });
    // eslint-disable-next-line no-console
    console.info(
      '[stt-three] scene loaded ' +
        JSON.stringify({
          boundsEmpty: box.isEmpty(),
          min: box.isEmpty() ? null : box.min.toArray().map((n) => Math.round(n)),
          max: box.isEmpty() ? null : box.max.toArray().map((n) => Math.round(n)),
          cameraPos: this.camera.position.toArray().map((n) => Math.round(n)),
          time: this.opts.getTime(),
          layers,
        }),
    );
  }

  /**
   * Park a whole-earth overview for a globe scene (the entry view for globe +
   * 3D-tiles navigation). `frameGlobe` sets an initial earth-scale near/far via
   * `setGlobeClip`; `GlobeControls` then refines the clip each frame. A no-op on a
   * non-globe projection (globe controls only make sense on the globe).
   */
  private frameGlobeView(): void {
    const proj = this.scene.projection;
    if (proj instanceof GlobeProjection) frameGlobe(this.camera, proj);
  }

  setFollowEgo(on: boolean): void {
    this.followEgo = on;
    this.lastEgo = null;
  }

  setTopDown(on: boolean): void {
    if (this.topDown === on) return;
    this.topDown = on;
    this.frame();
  }

  private onResize(): void {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 3D-tiles LOD is screen-space-error driven; refresh its reference resolution.
    this.tiles3d?.setResolutionFromRenderer();
  }

  private loop = (): void => {
    if (this.disposed || !this.renderer) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = this.opts.getTime();
    this.scene.setTime(t);

    if (this.streaming) this.driveStreaming(t);

    if (this.followEgo && this.opts.egoLayer && this.controls) {
      const pose = this.opts.egoLayer.getEgoPose(t);
      if (pose) {
        const ego = new Vector3(pose.x, pose.y, pose.z);
        if (this.lastEgo) this.camera.position.add(ego.clone().sub(this.lastEgo));
        this.controls.target.copy(ego);
        this.lastEgo = ego;
      }
    } else {
      this.lastEgo = null;
    }
    // Controls: ellipsoid-aware globe navigation, else orbit. GlobeControls
    // self-times its delta and adjusts the camera near/far as it updates.
    if (this.globeControlsHandle) this.globeControlsHandle.update();
    else this.controls?.update();

    // Pump 3D-tiles LOD AFTER the camera matrix is current for this frame (the
    // controls above updated it), BEFORE the draw so new tiles show this frame.
    if (this.tiles3d) {
      this.camera.updateMatrixWorld();
      this.tiles3d.update();
    }

    // Backend is initialized (we awaited it) → synchronous render, no warning.
    // With the atmosphere on, advance the sun to the playhead time and draw
    // THROUGH its aerial-perspective pipeline (it falls back to a plain render
    // internally when aerial perspective is off), else render the scene directly.
    if (this.atmosphere) {
      this.atmosphere.update(t);
      this.atmosphere.render();
    } else {
      this.renderer.render(this.threeScene, this.camera);
    }
  };

  /**
   * Feed the camera-derived viewport into the scene's streaming sources. Time
   * rides along so the tileset selects the right temporal buckets; the play/pause
   * heuristic (time advancing ⇒ animating) keeps prefetch alive. Throttled to
   * STREAM_UPDATE_MS; the first non-empty bounds trigger a one-time re-frame so a
   * streaming scene (which loads no tiles up front) still frames itself.
   */
  private driveStreaming(t: number): void {
    this.scene.setAnimationState(t !== this.lastTime);
    this.lastTime = t;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastStreamUpdate >= STREAM_UPDATE_MS) {
      this.lastStreamUpdate = now;
      const width = this.container.clientWidth || 1;
      const height = this.container.clientHeight || 1;
      const { bounds, zoom } = cameraToViewport(this.scene.projection, this.camera, {
        width,
        height,
      });
      this.scene.updateStreaming({ bounds, zoom, time: t });
    }

    if (!this.framedToData && !this.scene.computeBounds().isEmpty()) {
      this.framedToData = true;
      this.frame();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.atmosphere?.dispose();
    this.atmosphere = null;
    this.globeControlsHandle?.dispose();
    this.globeControlsHandle = null;
    this.tiles3d?.dispose();
    this.tiles3d = null;
    this.controls?.dispose();
    if (this.renderer) {
      const el = this.renderer.domElement as HTMLCanvasElement;
      el.remove();
      this.renderer.dispose();
      this.renderer = null;
    }
    this.threeScene.remove(this.scene.root);
  }
}
