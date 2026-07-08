// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `FlowCorridorLayer` — the Three/TSL port of deck's `FlowCorridorLayer`: a static
 * street/route network whose per-segment ridership is a TIME SERIES animated by the
 * playhead. Unlocks the `nyc-taxi-flows` / `bixi-streets` overviews.
 *
 * The geometry uploads ONCE (every consecutive vertex pair → one wide-line segment
 * instance, expanded to a value-driven screen-pixel width in
 * {@link createFlowCorridorMaterial}'s vertex stage). The per-segment value matrix
 * (`vertexValueMatrix`, `numBuckets` time columns) uploads ONCE as a linear-filtered
 * RG-float `DataTexture`; the material samples it at the fractional playhead bucket,
 * letting the texture's hardware filtering do the two-bucket lerp on the GPU. This
 * KILLS deck's per-sub-step CPU re-expand — advancing time only moves a uniform.
 *
 * RTC: all tiles merge into one instanced buffer whose positions are relative to a
 * shared `origin`, written to `object.position`. For the ENU/AV frame origin ≈ 0.
 */

import {
  Mesh,
  InstancedBufferAttribute,
  Box3,
  Vector3,
  Sphere,
  DataTexture,
  RGFormat,
  RGBAFormat,
  FloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  type Texture,
} from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeSegmentQuadGeometry } from '../geometry/segment-quad.js';
import {
  buildFlowCorridorBuffers,
  bucketPosFromTime,
  type FlowCorridorBuffers,
  type BucketAxis,
} from '../lib/flow-corridor-buffers.js';
import {
  createFlowCorridorMaterial,
  updateFlowCorridorUniforms,
  type FlowCorridorMaterialBundle,
} from '../tsl/flow-corridor-material.js';
import { rampColorAt, type RGBA } from '../lib/color.js';

export interface FlowCorridorLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** Value domain `[lo, hi]` mapped onto the width range + colour ramp. */
  domain: [number, number];
  /** Colour ramp stops (≥2), each `[r,g,b,a]` 0–255 — baked into a ramp texture. */
  ramp: RGBA[];
  /** Width (CSS px) at the LOW end of the domain. @default 1 */
  minWidthPx?: number;
  /** Width (CSS px) at the HIGH end of the domain. @default 8 */
  maxWidthPx?: number;
  opacity?: number;
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  /** Constant height lift (metres) to keep the network off the basemap. @default 0 */
  zLift?: number;
  /** Number of texels in the baked ramp texture. @default 256 */
  rampResolution?: number;
  // window-mode time filter (corridors are timeless by default → off)
  windowFilter?: boolean;
  // Full-width `timeWindow` + `fadeIn/OutDuration` and the lower-level
  // `windowHalf`/`fadeIn`/`fadeOut` aliases come from ThreeTimeWindowOptions.
}

/** Bake a multi-stop RGBA(0–255) ramp into a 1-D RGBA-float `DataTexture`. */
function makeRampTexture(ramp: RGBA[], resolution: number): DataTexture {
  const n = Math.max(2, resolution);
  const data = new Float32Array(n * 4);
  const domain: [number, number] = [0, 1];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const c = rampColorAt(t, domain, ramp);
    data[i * 4] = c[0] / 255;
    data[i * 4 + 1] = c[1] / 255;
    data[i * 4 + 2] = c[2] / 255;
    data[i * 4 + 3] = (c[3] ?? 255) / 255;
  }
  const tex = new DataTexture(data, n, 1, RGBAFormat, FloatType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Pack the per-segment value matrix into an RG-float, linear-filtered texture. */
function makeValueTexture(buf: FlowCorridorBuffers): DataTexture {
  const tex = new DataTexture(
    buf.valueMatrix,
    buf.numBuckets,
    buf.count,
    RGFormat,
    FloatType,
  );
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export class FlowCorridorLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: FlowCorridorMaterialBundle | null = null;
  private valueTex: Texture | null = null;
  private rampTex: Texture | null = null;
  private axis: BucketAxis | null = null;
  private numBuckets = 0;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: FlowCorridorLayerOptions;

  constructor(options: FlowCorridorLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'flow-corridor';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so widths are true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildFlowCorridorBuffers(
      tiles,
      ctx.projection,
      ctx.timeOrigin,
      {
        zLift: this.opts.zLift ?? 0,
      },
    );

    this.disposeGpu();
    this.axis = buf.axis;
    this.numBuckets = buf.numBuckets;

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
    geometry.setAttribute('sttRowV', new InstancedBufferAttribute(buf.rowV, 1));
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    this.valueTex = makeValueTexture(buf);
    this.rampTex = makeRampTexture(
      this.opts.ramp,
      this.opts.rampResolution ?? 256,
    );

    this.bundle = createFlowCorridorMaterial({
      valueTexture: this.valueTex,
      rampTexture: this.rampTex,
      additive: this.opts.additive,
      depthWrite: this.opts.depthWrite,
      alphaCutoff: this.opts.alphaCutoff,
      windowFilter: this.opts.windowFilter,
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
    const bucketPos = this.axis
      ? bucketPosFromTime(this.axis, absoluteTimeMs)
      : 0;
    updateFlowCorridorUniforms(this.bundle, {
      bucketPos,
      numBuckets: this.numBuckets,
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        ...resolveTimeWindow(this.opts, 0),
        trailLength: 0,
        trailFade: 1,
      },
      minWidthPx: this.opts.minWidthPx ?? 1,
      maxWidthPx: this.opts.maxWidthPx ?? 8,
      domain: this.opts.domain,
      opacity: this.opts.opacity ?? 1,
      viewport: this.viewport,
    });
  }

  private disposeGpu(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.bundle?.material.dispose();
    this.valueTex?.dispose();
    this.rampTex?.dispose();
    this.bundle = null;
    this.valueTex = null;
    this.rampTex = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
