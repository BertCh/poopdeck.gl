// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `WideLineLayer` — screen-pixel-width animated lines, the Three port of deck's
 * `PathLayer` / `AnimatedLineLayer` / `AnimatedTripsLayer` (window + trail) over
 * the {@link createWideLineMaterial} ribbon. Every LineString segment is one quad
 * instance; the GPU expands it to `widthPx` and time-filters it. This is the base
 * for Path (window), OD-Line (window, 2-vertex od-pairs), map-lines (`none`), and
 * the geometry base for Trips/FlowCorridor.
 *
 * RTC: all tiles merge into one instanced buffer whose positions are relative to
 * a shared `origin`, which is written to `object.position` so large mercator/globe
 * magnitudes stay in the f64 CPU transform.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { makeSegmentQuadGeometry } from '../geometry/segment-quad';
import {
  buildLineSegmentBuffers,
  type LineColorMode,
  type LineSegmentBufferOptions,
} from '../lib/geo-line-buffers';
import {
  createWideLineMaterial,
  updateWideLineUniforms,
  type WideLineMaterialBundle,
  type WideLineMode,
} from '../tsl/wide-line-material';

export interface WideLineLayerOptions {
  id?: string;
  /** window (Path/OD-Line) | trail (Trips) | none (static map lines). @default 'none' */
  mode?: WideLineMode;
  colorMode: LineColorMode;
  /** Full line width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing trails/flows). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  // geometry
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // time params
  windowHalf?: number;
  fadeIn?: number;
  fadeOut?: number;
  trailLength?: number;
  trailFade?: number;
}

export class WideLineLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: WideLineMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: WideLineLayerOptions;

  constructor(options: WideLineLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'wide-line';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  protected bufferOptions(): LineSegmentBufferOptions {
    return {
      colorMode: this.opts.colorMode,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      zLift: this.opts.zLift ?? 0,
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildLineSegmentBuffers(tiles, ctx.projection, ctx.timeOrigin, this.bufferOptions());

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
      mode: this.opts.mode ?? 'none',
      additive: this.opts.additive,
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
        windowHalf: this.opts.windowHalf ?? 0,
        fadeIn: this.opts.fadeIn ?? 0,
        fadeOut: this.opts.fadeOut ?? 0,
        trailLength: this.opts.trailLength ?? 0,
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
