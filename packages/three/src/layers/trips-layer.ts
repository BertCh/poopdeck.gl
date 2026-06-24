// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `TripsLayer` — animated trips/trajectories with a trailing fade, the Three port
 * of deck's `AnimatedTripsLayer` (trail mode) over the {@link createWideLineMaterial}
 * ribbon. Each LineString segment is one quad instance the GPU expands to `widthPx`
 * screen pixels; per-vertex trail times (`sttTimeA`/`sttTimeB`) fade each vertex
 * behind the playhead over `[cur - trailLength, cur]`, with optional head→tail fade.
 *
 * This is a sibling of {@link WideLineLayer} pinned to `mode: 'trail'`, using
 * {@link buildTripsBuffers} (real per-vertex trail times) instead of
 * {@link buildLineSegmentBuffers} (which leaves `timeA`/`timeB` at feature start).
 *
 * RTC: all tiles merge into one instanced buffer whose positions are relative to a
 * shared `origin`, written to `object.position`. AV/ENU origin is tiny → no-op.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { makeSegmentQuadGeometry } from '../geometry/segment-quad';
import {
  buildTripsBuffers,
  type TripsColorMode,
  type TripsBufferOptions,
} from '../lib/trips-buffers';
import {
  createWideLineMaterial,
  updateWideLineUniforms,
  type WideLineMaterialBundle,
} from '../tsl/wide-line-material';

export interface TripsLayerOptions {
  id?: string;
  /** Per-feature colour: categorical | ramp | constant. */
  colorMode: TripsColorMode;
  /** Full trail width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing trails). @default true */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  // geometry
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // trail params
  /** Trail length behind the playhead (ms). @default 180000 */
  trailLength?: number;
  /** 1 ⇒ trail fades head→tail; 0 ⇒ solid trail. @default 1 */
  trailFade?: number;
}

export class TripsLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: WideLineMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: TripsLayerOptions;

  constructor(options: TripsLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'trips';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  protected bufferOptions(): TripsBufferOptions {
    return {
      colorMode: this.opts.colorMode,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      zLift: this.opts.zLift ?? 0,
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildTripsBuffers(tiles, ctx.projection, ctx.timeOrigin, this.bufferOptions());

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeSegmentQuadGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const geometry = makeSegmentQuadGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute('sttPosA', new InstancedBufferAttribute(buf.posA, 3));
    geometry.setAttribute('sttPosB', new InstancedBufferAttribute(buf.posB, 3));
    geometry.setAttribute('sttColorA', new InstancedBufferAttribute(buf.colorA, 4));
    geometry.setAttribute('sttColorB', new InstancedBufferAttribute(buf.colorB, 4));
    geometry.setAttribute('sttStart', new InstancedBufferAttribute(buf.starts, 1));
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    geometry.setAttribute('sttTimeA', new InstancedBufferAttribute(buf.timeA, 1));
    geometry.setAttribute('sttTimeB', new InstancedBufferAttribute(buf.timeB, 1));
    if (buf.bbox) {
      geometry.boundingBox = new Box3(new Vector3(...buf.bbox.min), new Vector3(...buf.bbox.max));
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    }

    this.bundle = createWideLineMaterial({
      mode: 'trail',
      additive: this.opts.additive ?? true,
      depthWrite: this.opts.depthWrite,
      alphaCutoff: this.opts.alphaCutoff,
    });
    this.object.geometry = geometry;
    this.object.material = this.bundle.material;
    this.pushUniforms(this.timeOrigin);
  }

  setTime(absoluteTimeMs: number): void {
    this.pushUniforms(absoluteTimeMs);
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateWideLineUniforms(this.bundle, {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        trailLength: this.opts.trailLength ?? 180_000,
        trailFade: this.opts.trailFade ?? 1,
      },
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
