// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `PointCloudLayer` — the Three port of deck's `AnimatedPointLayer` for the AV
 * LIDAR point modes: raw points (height-band / seg-class categorical colour or
 * `r,g,b` camera colour), soft Gaussian `splat`, `scan` (wake sweep), and
 * worldbuild-on-points (cumulative). All tiles merge into one billboard-quad
 * `InstancedBufferGeometry`; the GPU time-filter handles per-frame visibility.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad';
import { buildPointBuffers, type PointColorMode } from './point-buffers';
import {
  createPointMaterial,
  updatePointUniforms,
  type PointMaterialBundle,
} from '../tsl/point-material';
import type { TimeFilterMode } from '../tsl/time-filter-math';
import type { RGBA } from '../lib/color';

export interface PointCloudLayerOptions {
  id?: string;
  /** window (raw) | wake (scan) | cumulative (worldbuild). @default 'window' */
  mode?: TimeFilterMode;
  /** Soft Gaussian point splat. @default false */
  splat?: boolean;

  // colour
  /** Categorical property (e.g. `height_band`, `seg_class`). */
  colorProperty?: string;
  /** `{ category → [r,g,b,a] 0–255 }`. */
  colorMapping?: Record<string, RGBA>;
  /** Colour for null / unmapped categories. @default [150,160,175,220] */
  colorMappingDefault?: RGBA;
  /** When set, colour from these RGB columns (0–255) instead of categorical. */
  rgbColumns?: [string, string, string] | null;

  // elevation
  /** Altitude column (metres). @default 'z' */
  elevationProperty?: string | null;
  elevationScale?: number;

  // size / opacity
  /** World-metre half-size of each point. @default 0.06 */
  pointSize?: number;
  opacity?: number;
  splatFalloff?: number;

  // time params
  windowHalf?: number;
  fadeIn?: number;
  fadeOut?: number;
  wakeLength?: number;
  wakeTailScale?: number;
  alphaCutoff?: number;
}

const DEFAULT_FALLBACK: RGBA = [150, 160, 175, 220];

export class PointCloudLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: PointMaterialBundle | null = null;
  private readonly opts: Required<
    Omit<PointCloudLayerOptions, 'id' | 'rgbColumns' | 'elevationProperty'>
  > & Pick<PointCloudLayerOptions, 'rgbColumns' | 'elevationProperty'>;

  constructor(options: PointCloudLayerOptions = {}) {
    super();
    this.id = options.id ?? 'points';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.opts = {
      mode: options.mode ?? 'window',
      splat: options.splat ?? false,
      colorProperty: options.colorProperty ?? '',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_FALLBACK,
      rgbColumns: options.rgbColumns === undefined ? null : options.rgbColumns,
      elevationProperty:
        options.elevationProperty === undefined ? 'z' : options.elevationProperty,
      elevationScale: options.elevationScale ?? 1,
      pointSize: options.pointSize ?? 0.06,
      opacity: options.opacity ?? 1,
      splatFalloff: options.splatFalloff ?? 3,
      windowHalf: options.windowHalf ?? 250,
      fadeIn: options.fadeIn ?? 0,
      fadeOut: options.fadeOut ?? 0,
      wakeLength: options.wakeLength ?? 60,
      wakeTailScale: options.wakeTailScale ?? 0.1,
      alphaCutoff: options.alphaCutoff ?? 0.01,
    };
  }

  private colorMode(): PointColorMode {
    if (this.opts.rgbColumns) {
      return { type: 'rgb', columns: this.opts.rgbColumns, alpha: 1 };
    }
    return {
      type: 'categorical',
      property: this.opts.colorProperty,
      mapping: this.opts.colorMapping,
      fallback: this.opts.colorMappingDefault,
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildPointBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      colorMode: this.colorMode(),
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale,
    });

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeBillboardQuadGeometry();
      return;
    }

    const geometry = makeBillboardQuadGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute('sttCenter', new InstancedBufferAttribute(buf.centers, 3));
    geometry.setAttribute('sttColor', new InstancedBufferAttribute(buf.colors, 4));
    geometry.setAttribute('sttStart', new InstancedBufferAttribute(buf.starts, 1));
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    if (buf.bbox) {
      geometry.boundingBox = new Box3(new Vector3(...buf.bbox.min), new Vector3(...buf.bbox.max));
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    }

    this.bundle = createPointMaterial({
      mode: this.opts.mode,
      splat: this.opts.splat,
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
    updatePointUniforms(this.bundle, {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        windowHalf: this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
        wakeLength: this.opts.wakeLength,
        wakeTailScale: this.opts.wakeTailScale,
      },
      pointSize: this.opts.pointSize,
      opacity: this.opts.opacity,
      splatFalloff: this.opts.splatFalloff,
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
