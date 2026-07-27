// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTSurfelLayer` — render an STT point cloud as oriented anisotropic Gaussian
 * surfels using {@link createSurfelMaterial}. The Three analogue of deck's
 * `SplatLayer`: it reads the same `--surfel`-baked columns
 * (`qx,qy,qz,qw` | packed `q_a,q_b,q_c,q_imax`, `s_major,s_minor`, `r,g,b`,
 * `surfel_opacity`, `z`, `is_dynamic`) from every tile and merges them into ONE
 * `InstancedBufferGeometry`, rebasing each tile's `startTimes` to the scene's
 * common time origin so a single shared material + one `currentTime` uniform
 * drives the whole cloud. The GPU culls by the temporal Gaussian per frame.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import { makeHexDiskGeometry } from '../geometry/hex-disk.js';
import { buildSurfelBuffers } from './surfel-buffers.js';
import {
  createSurfelMaterial,
  updateSurfelUniforms,
  type SurfelUniforms,
} from '../tsl/surfel-material.js';
import type { MeshBasicNodeMaterial } from 'three/webgpu';

export interface STTSurfelLayerOptions {
  id?: string;
  /** Interleaved quaternion vector column (preferred). @default 'surfel_quat' */
  quatVectorColumn?: string;
  /** Interleaved scale vector column. @default 'surfel_scale' */
  scaleVectorColumn?: string;
  /** Interleaved rgba(u8) vector column. @default 'surfel_rgba' */
  colorVectorColumn?: string;
  /** Legacy separate quaternion columns when NOT smallest-three packed. @default ['qx','qy','qz','qw'] */
  quaternionColumns?: [string, string, string, string];
  /** Legacy in-plane half-extent columns (metres). @default ['s_major','s_minor'] */
  scaleColumns?: [string, string];
  /** Per-surfel RGB columns (0–255). @default ['r','g','b'] */
  rgbColumns?: [string, string, string] | null;
  /** Per-surfel confidence column (0–1) → alpha. @default 'surfel_opacity' */
  opacityColumn?: string | null;
  /** Altitude column (metres). @default 'z' */
  elevationProperty?: string | null;
  /** Multiplier on the elevation column. @default 1 */
  elevationScale?: number;
  /** RGB used when `rgbColumns` is absent. @default [200,205,215] */
  fallbackColor?: [number, number, number];

  // ── visual / time (live uniforms) ──
  temporalSigma?: number;
  temporalSigmaDynamic?: number;
  cumulative?: boolean;
  revealFade?: number;
  sizeScale?: number;
  gaussianFalloff?: number;
  alphaCutoff?: number;
  opacity?: number;
}

const DEFAULT_FALLBACK: [number, number, number] = [200, 205, 215];

export class STTSurfelLayer extends BaseSTTLayer {
  readonly id: string;
  readonly object = new Mesh();

  private uniforms: SurfelUniforms | null = null;
  private material: MeshBasicNodeMaterial | null = null;
  private readonly opts: Required<
    Omit<
      STTSurfelLayerOptions,
      'id' | 'rgbColumns' | 'opacityColumn' | 'elevationProperty'
    >
  > &
    Pick<
      STTSurfelLayerOptions,
      'rgbColumns' | 'opacityColumn' | 'elevationProperty'
    >;

  constructor(options: STTSurfelLayerOptions = {}) {
    super();
    this.id = options.id ?? 'surfels';
    this.object.name = this.id;
    this.object.frustumCulled = false; // bounds come from instances, set manually below
    this.opts = {
      quatVectorColumn: options.quatVectorColumn ?? 'surfel_quat',
      scaleVectorColumn: options.scaleVectorColumn ?? 'surfel_scale',
      colorVectorColumn: options.colorVectorColumn ?? 'surfel_rgba',
      quaternionColumns: options.quaternionColumns ?? ['qx', 'qy', 'qz', 'qw'],
      scaleColumns: options.scaleColumns ?? ['s_major', 's_minor'],
      rgbColumns:
        options.rgbColumns === undefined ? ['r', 'g', 'b'] : options.rgbColumns,
      opacityColumn:
        options.opacityColumn === undefined
          ? 'surfel_opacity'
          : options.opacityColumn,
      elevationProperty:
        options.elevationProperty === undefined
          ? 'z'
          : options.elevationProperty,
      elevationScale: options.elevationScale ?? 1,
      fallbackColor: options.fallbackColor ?? DEFAULT_FALLBACK,
      temporalSigma: options.temporalSigma ?? 180,
      temporalSigmaDynamic: options.temporalSigmaDynamic ?? 0,
      cumulative: options.cumulative ?? false,
      revealFade: options.revealFade ?? 0,
      sizeScale: options.sizeScale ?? 1,
      gaussianFalloff: options.gaussianFalloff ?? 3,
      alphaCutoff: options.alphaCutoff ?? 0.04,
      opacity: options.opacity ?? 1,
    };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;

    const buf = buildSurfelBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      quatVectorColumn: this.opts.quatVectorColumn,
      scaleVectorColumn: this.opts.scaleVectorColumn,
      colorVectorColumn: this.opts.colorVectorColumn,
      quaternionColumns: this.opts.quaternionColumns,
      scaleColumns: this.opts.scaleColumns,
      rgbColumns: this.opts.rgbColumns ?? null,
      opacityColumn: this.opts.opacityColumn ?? null,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale,
      fallbackColor: this.opts.fallbackColor,
    });

    this.disposeGpu();
    if (buf.count === 0) {
      // No surfels: hide rather than draw the bare hexagon with no instances.
      this.object.geometry = makeHexDiskGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;

    const geometry = makeHexDiskGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute(
      'sttCenter',
      new InstancedBufferAttribute(buf.centers, 3),
    );
    geometry.setAttribute(
      'sttQuat',
      new InstancedBufferAttribute(buf.quats, 4),
    );
    geometry.setAttribute(
      'sttScale',
      new InstancedBufferAttribute(buf.scales, 2),
    );
    geometry.setAttribute(
      'sttColor',
      new InstancedBufferAttribute(buf.colors, 4),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute(
      'sttDynamic',
      new InstancedBufferAttribute(buf.dynamic, 1),
    );
    // Real cloud bounds (the base hexagon's are metre-scale and would mis-cull /
    // mis-frame). Lets `STTScene.computeBounds()` frame the camera correctly.
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    const { material, uniforms } = createSurfelMaterial({
      packed: buf.packed,
      alphaCutoff: this.opts.alphaCutoff,
    });
    this.material = material;
    this.uniforms = uniforms;
    this.object.geometry = geometry;
    this.object.material = material;
    this.pushUniforms(this.timeOrigin); // seed at t0 so first frame is valid
  }

  setTime(absoluteTimeMs: number): void {
    this.pushUniforms(absoluteTimeMs);
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.uniforms) return;
    updateSurfelUniforms(this.uniforms, {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      temporalSigma: this.opts.temporalSigma,
      temporalSigmaDynamic: this.opts.temporalSigmaDynamic,
      sizeScale: this.opts.sizeScale,
      falloff: this.opts.gaussianFalloff,
      opacity: this.opts.opacity,
      cumulative: this.opts.cumulative,
      revealFade: this.opts.revealFade,
    });
  }

  private disposeGpu(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.material?.dispose();
    this.material = null;
    this.uniforms = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
