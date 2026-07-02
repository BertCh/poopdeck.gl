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
import type { EgoLayer } from '../layers/ego-layer.js';
import { frameBox } from '../scene/camera.js';
import {
  createHighLimitDevice,
  resolveBackend,
  type RendererBackend,
} from '../renderer/webgpu-renderer.js';

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

  constructor(
    private readonly container: HTMLElement,
    private readonly scene: SttScene,
    private readonly opts: StandaloneViewerOptions,
  ) {
    this.followEgo = opts.followEgo ?? false;
    this.topDown = opts.topDown ?? false;
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
    this.opts.onBackend?.(resolveBackend(renderer, forceWebGL));

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    // Eager-load the scene, then frame the camera to the cloud.
    try {
      await this.scene.load();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[StandaloneViewer] scene load failed', err);
    }
    if (this.disposed) return;
    this.frame();

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
  }

  private loop = (): void => {
    if (this.disposed || !this.renderer) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = this.opts.getTime();
    this.scene.setTime(t);

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
    this.controls?.update();
    // Backend is initialized (we awaited it) → synchronous render, no warning.
    this.renderer.render(this.threeScene, this.camera);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
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
