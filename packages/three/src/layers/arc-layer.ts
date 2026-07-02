// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `ArcLayer` — raised origin→destination arcs, the Three port of deck's
 * `AnimatedArcLayer`. Every LineString feature collapses to its source (first)
 * and target (last) endpoint (one arc instance); the GPU tessellates a raised,
 * window-time-filtered, source→target gradient curve over the instanced strip
 * ({@link makeArcStripGeometry} + {@link createArcMaterial}). Unlocks the
 * od-arcs demo.
 *
 * RTC: all tiles merge into one instanced buffer whose endpoints are relative to
 * a shared `origin`, written to `object.position` so large mercator/globe
 * magnitudes stay in the f64 CPU transform. The same origin is pushed to the
 * material uniform so the `greatCircle` shape can recover absolute ECEF for slerp.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { resolveTimeWindow, type ThreeTimeWindowOptions } from '../lib/time-window';
import {
  buildArcBuffers,
  type ArcColorMode,
  type ArcBufferOptions,
} from '../lib/arc-buffers';
import {
  createArcMaterial,
  makeArcStripGeometry,
  updateArcUniforms,
  type ArcMaterialBundle,
  type ArcShape,
} from '../tsl/arc-material';

export interface ArcLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** parabolic flat-map raised arc | greatCircle spherical (globe). @default 'parabolic' */
  shape?: ArcShape;
  /** Source-endpoint colour spec. @default constant [0,150,255,255] */
  sourceColor?: ArcColorMode;
  /** Target-endpoint colour spec. @default constant [255,127,14,255] */
  targetColor?: ArcColorMode;
  /** Full arc width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing flows). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  /** Per-arc height multiplier (constant). @default 1 */
  height?: number;
  /** Per-feature numeric height-multiplier column (overrides {@link height}). */
  heightProperty?: string | null;
  // geometry lift
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // time window params (full-width `timeWindow` + `fadeIn/OutDuration`, plus the
  // lower-level `windowHalf`/`fadeIn`/`fadeOut` aliases) via ThreeTimeWindowOptions.
}

export class ArcLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: ArcMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: ArcLayerOptions;

  constructor(options: ArcLayerOptions = {}) {
    super();
    this.opts = options;
    this.id = options.id ?? 'arc';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  protected bufferOptions(): ArcBufferOptions {
    return {
      sourceColor: this.opts.sourceColor,
      targetColor: this.opts.targetColor,
      height: this.opts.height ?? 1,
      heightProperty: this.opts.heightProperty ?? null,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      zLift: this.opts.zLift ?? 0,
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildArcBuffers(tiles, ctx.projection, ctx.timeOrigin, this.bufferOptions());

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeArcStripGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const geometry = makeArcStripGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute('sttPosSource', new InstancedBufferAttribute(buf.posSource, 3));
    geometry.setAttribute('sttPosTarget', new InstancedBufferAttribute(buf.posTarget, 3));
    geometry.setAttribute('sttColorSource', new InstancedBufferAttribute(buf.colorSource, 4));
    geometry.setAttribute('sttColorTarget', new InstancedBufferAttribute(buf.colorTarget, 4));
    geometry.setAttribute('sttStart', new InstancedBufferAttribute(buf.starts, 1));
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    geometry.setAttribute('sttHeight', new InstancedBufferAttribute(buf.heights, 1));
    if (buf.bbox) {
      geometry.boundingBox = new Box3(new Vector3(...buf.bbox.min), new Vector3(...buf.bbox.max));
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    }

    this.bundle = createArcMaterial({
      shape: this.opts.shape ?? 'parabolic',
      additive: this.opts.additive,
      depthWrite: this.opts.depthWrite,
      alphaCutoff: this.opts.alphaCutoff,
    });
    this.object.geometry = geometry;
    this.object.material = this.bundle.material;
    // origin lives in the uniform too (greatCircle slerp recovers absolute ECEF).
    this.bundle.arc.origin.value.set(buf.origin[0], buf.origin[1], buf.origin[2]);
    this.pushUniforms(this.timeOrigin);
  }

  setTime(absoluteTimeMs: number): void {
    this.pushUniforms(absoluteTimeMs);
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateArcUniforms(this.bundle, {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: resolveTimeWindow(this.opts, 0),
      widthPx: this.opts.widthPx ?? 2,
      opacity: this.opts.opacity ?? 1,
      viewport: this.viewport,
    });
  }

  private disposeGpu(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.bundle?.material.dispose();
    this.bundle = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
