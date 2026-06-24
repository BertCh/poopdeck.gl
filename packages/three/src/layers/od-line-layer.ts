// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `OdLineLayer` — the Three port of deck's `AnimatedLineLayer` (WINDOW mode):
 * straight origin→destination flow lines. Each LineString feature collapses to a
 * SINGLE segment from its FIRST vertex (source) to its LAST vertex (target);
 * intermediate vertices are dropped — an OD flow has only two ends. The segment
 * rides the shared {@link createWideLineMaterial} ribbon (screen-pixel width,
 * window-mode time filter), so this is the OD-pair sibling of {@link
 * WideLineLayer} differing only in the buffer builder.
 *
 * It mirrors the `WideLineLayer.setTiles` GPU flow but feeds {@link
 * buildOdLineSegmentBuffers} (one quad instance per OD pair) instead of the
 * per-segment builder. RTC: positions relative to a shared `origin`, written to
 * `object.position`.
 *
 * Unlocks the OD-arcs / OD-flows geographic demos on the Three renderer.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { makeSegmentQuadGeometry } from '../geometry/segment-quad';
import { buildOdLineSegmentBuffers } from '../lib/od-positions';
import type { LineColorMode, LineSegmentBufferOptions } from '../lib/geo-line-buffers';
import {
  createWideLineMaterial,
  updateWideLineUniforms,
  type WideLineMaterialBundle,
} from '../tsl/wide-line-material';

export interface OdLineLayerOptions {
  id?: string;
  /** Per-feature color (categorical / ramp / constant). */
  colorMode: LineColorMode;
  /** Full line width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing flows). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  // geometry
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // window-mode time params
  /** Half-width of the visibility window (ms). @default 0 (instantaneous) */
  windowHalf?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export class OdLineLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: WideLineMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: OdLineLayerOptions;

  constructor(options: OdLineLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'od-line';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  private bufferOptions(): LineSegmentBufferOptions {
    return {
      colorMode: this.opts.colorMode,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      zLift: this.opts.zLift ?? 0,
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildOdLineSegmentBuffers(tiles, ctx.projection, ctx.timeOrigin, this.bufferOptions());

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
      mode: 'window',
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
        trailLength: 0,
        trailFade: 1,
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
