// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `TripHeadsLayer` — a smooth moving DOT at the head of every active trip, the
 * Three port of deck's `AnimatedTripHeadsLayer`. {@link buildTripIndex} pools all
 * LineString features into per-trip polylines (projected RTC + per-vertex times);
 * each frame {@link sampleHeads} CPU-interpolates the head of every active trip,
 * and the layer rewrites a small instanced billboard-quad buffer (reusing the
 * shared {@link createPointMaterial}). Like the AV box layer, this DOES rebuild a
 * per-frame buffer — but only over the few active trips, so it is sub-ms.
 *
 * Because CPU active-filtering already gates visibility (a dot pops in at the
 * trip start and out at its end), the time-filter material is driven in `none`
 * mode (alpha always 1) — only the active heads are ever uploaded, so every drawn
 * instance is fully opaque. Smoothness comes from the CONTINUOUS lerp, with none
 * of a short PathLayer trail's per-vertex pulsing on sparse geometry.
 */

import { Mesh, InstancedBufferAttribute, InstancedBufferGeometry } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import {
  createPointMaterial,
  updatePointUniforms,
  type PointMaterialBundle,
} from '../tsl/point-material.js';
import {
  buildTripIndex,
  sampleHeads,
  type TripIndex,
} from '../lib/trip-heads.js';
import type { Projection } from '../projection/local-enu.js';
import type { RGBA } from '../lib/color.js';

export interface TripHeadsLayerOptions {
  id?: string;
  /** Head dot colour (RGBA, 0–255). @default [253,128,93,255] */
  headColor?: RGBA;
  /**
   * Head radius in TRUE metres (world-metre half-size). Divided by
   * `metersPerWorldUnit` at the anchor so it is the same real size at any
   * latitude / projection. @default 6
   */
  headRadius?: number;
  /** Soft Gaussian splat instead of a hard disc. @default false */
  splat?: boolean;
  opacity?: number;
  splatFalloff?: number;
  /** Discard fragments below this final alpha. @default 0.01 */
  alphaCutoff?: number;
}

const DEFAULT_COLOR: RGBA = [253, 128, 93, 255];

export class TripHeadsLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: PointMaterialBundle | null = null;
  private index: TripIndex | null = null;
  private projection: Projection | null = null;
  private geom: InstancedBufferGeometry;

  // Per-frame instance buffers (grown by capacity, like the box layer).
  private centers = new Float32Array(0);
  private colors = new Float32Array(0);
  private times = new Float32Array(0); // start==end==relTime per instance
  private capacity = 0;

  private readonly opts: Required<Omit<TripHeadsLayerOptions, 'id'>>;

  constructor(options: TripHeadsLayerOptions = {}) {
    super();
    this.id = options.id ?? 'trip-heads';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.opts = {
      headColor: options.headColor ?? DEFAULT_COLOR,
      headRadius: options.headRadius ?? 6,
      splat: options.splat ?? false,
      opacity: options.opacity ?? 1,
      splatFalloff: options.splatFalloff ?? 3,
      alphaCutoff: options.alphaCutoff ?? 0.01,
    };

    // The geometry always carries the billboard quad; instance attributes are
    // (re)allocated lazily once the first head is active (WebGPU needs a valid
    // `position` attribute to build the material — the quad provides it).
    this.geom = makeBillboardQuadGeometry();
    this.object.geometry = this.geom;
    this.bundle = createPointMaterial({
      mode: 'none',
      splat: this.opts.splat,
      alphaCutoff: this.opts.alphaCutoff,
    });
    this.object.material = this.bundle.material;
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.projection = ctx.projection;
    this.index = buildTripIndex(tiles, ctx.projection, ctx.timeOrigin);
    // RTC: parent the geometry under the index origin so the small f32 offsets
    // resolve to absolute world coords (no-op ~0 for the ENU/AV frame).
    this.object.position.set(...(this.index.origin as [number, number, number]));
    // Worst-case instance count = every trip active at once.
    this.ensureCapacity(this.index.trips.length);
  }

  setTime(absoluteTimeMs: number): void {
    if (!this.index || !this.projection || !this.bundle) {
      this.object.visible = false;
      return;
    }
    const relTime = this.relativeTime(absoluteTimeMs);
    this.ensureCapacity(this.index.trips.length);
    const count = sampleHeads(this.index, relTime, this.centers);

    const geom = this.geom;
    geom.instanceCount = count;
    this.object.visible = count > 0;
    if (count === 0) {
      this.pushUniforms();
      return;
    }

    // Only the moved `sttCenter` buffer needs re-upload; colour/time are static
    // (`none` mode = alpha 1, one colour for all heads).
    const centerAttr = geom.getAttribute('sttCenter') as InstancedBufferAttribute;
    centerAttr.needsUpdate = true;

    this.pushUniforms();
  }

  /** (Re)allocate the instance attributes when the active set could grow. */
  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity && this.capacity > 0) return;
    this.capacity = Math.max(needed, this.capacity * 2, 16);
    this.centers = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 4);
    this.times = new Float32Array(this.capacity);

    // A single colour for all heads (deck uses one `headColor`); fill once.
    const [r, g, b, a] = this.opts.headColor;
    for (let i = 0; i < this.capacity; i++) {
      this.colors[i * 4] = r / 255;
      this.colors[i * 4 + 1] = g / 255;
      this.colors[i * 4 + 2] = b / 255;
      this.colors[i * 4 + 3] = (a ?? 255) / 255;
    }

    const geom = this.geom;
    geom.setAttribute('sttCenter', new InstancedBufferAttribute(this.centers, 3));
    geom.setAttribute('sttColor', new InstancedBufferAttribute(this.colors, 4));
    geom.setAttribute('sttStart', new InstancedBufferAttribute(this.times, 1));
    geom.setAttribute('sttEnd', new InstancedBufferAttribute(this.times, 1));
  }

  private pushUniforms(): void {
    if (!this.bundle || !this.projection) return;
    // Convert the metric head radius to world units (1 unit = metersPerWorldUnit
    // metres) at the anchor — point material wants a world-unit half-size.
    const mpu = this.projection.metersPerWorldUnit(
      this.projection.anchor.longitude,
      this.projection.anchor.latitude,
    );
    const pointSize = this.opts.headRadius / (mpu || 1);
    updatePointUniforms(this.bundle, {
      relativeCurrentTime: 0, // `none` mode ignores time
      pointSize,
      opacity: this.opts.opacity,
      splatFalloff: this.opts.splatFalloff,
    });
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.bundle?.material.dispose();
    this.bundle = null;
  }
}
