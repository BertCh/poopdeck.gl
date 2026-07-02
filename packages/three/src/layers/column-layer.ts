// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `ColumnLayer` — extruded 3D columns (bars / prisms) at point features, the
 * Three port of deck's `AnimatedColumnLayer`. Each Point feature becomes one
 * instance of a shared unit prism (`diskResolution` sides, see
 * `geometry/column-prism.ts`), scaled by a metric `radius` + a per-feature HEIGHT
 * (a numeric column × `elevationScale`), oriented to the local ground frame
 * (`projection.localFrame`, so columns stand up on the globe too), coloured per
 * feature (categorical / ramp / constant), lit by {@link createColumnMaterial},
 * and optionally window time-filtered.
 *
 * RTC: all tiles merge into one instanced buffer whose BASE positions are relative
 * to a shared `origin`, written to `object.position` so large mercator/globe
 * magnitudes stay in the f64 CPU transform (no-op for the AV ENU frame). Unlocks
 * the earthquake-columns demo (magnitude → height, depth → colour ramp).
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { resolveTimeWindow, type ThreeTimeWindowOptions } from '../lib/time-window';
import { makeColumnPrismGeometry } from '../geometry/column-prism';
import {
  buildColumnBuffers,
  type ColumnColorMode,
  type ColumnBufferOptions,
} from '../lib/column-buffers';
import {
  createColumnMaterial,
  updateColumnUniforms,
  type ColumnMaterialBundle,
} from '../tsl/column-material';
import type { TimeFilterParams } from '../tsl/time-filter-math';

export interface ColumnLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  colorMode: ColumnColorMode;
  /** Disk faces (deck `diskResolution`). @default 20 */
  diskResolution?: number;
  /** Disk rotation (deck `angle`), CCW degrees. @default 0 */
  angle?: number;
  /** Disk incircle radius in true metres. @default 100 */
  radius?: number;
  /** Numeric column driving per-feature height (metres). @default null */
  elevationProperty?: string | null;
  /** Constant height (metres) when `elevationProperty` is absent. @default 1000 */
  defaultElevation?: number;
  /** Multiplier on every height. @default 1 */
  elevationScale?: number;
  /** Base-altitude column (metres) lifting the column foot. */
  baseElevationProperty?: string | null;
  /** Constant base-altitude lift (metres). @default 0 */
  zLift?: number;
  /** Apply the window time-filter. @default true */
  timeFiltered?: boolean;
  /** Translucent columns (lets the time window fade). @default false */
  transparent?: boolean;
  opacity?: number;
  alphaCutoff?: number;
  // window time params — full-width `timeWindow` + `fadeIn/OutDuration` and the
  // lower-level `windowHalf`/`fadeIn`/`fadeOut` aliases come from
  // ThreeTimeWindowOptions.
}

export class ColumnLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: ColumnMaterialBundle | null = null;
  protected readonly opts: ColumnLayerOptions;

  constructor(options: ColumnLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'columns';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  protected bufferOptions(): ColumnBufferOptions {
    return {
      colorMode: this.opts.colorMode,
      elevationProperty: this.opts.elevationProperty ?? null,
      defaultElevation: this.opts.defaultElevation ?? 1000,
      elevationScale: this.opts.elevationScale ?? 1,
      radius: this.opts.radius ?? 100,
      baseElevationProperty: this.opts.baseElevationProperty ?? null,
      zLift: this.opts.zLift ?? 0,
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildColumnBuffers(tiles, ctx.projection, ctx.timeOrigin, this.bufferOptions());

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeColumnPrismGeometry(
        this.opts.diskResolution ?? 20,
        ((this.opts.angle ?? 0) * Math.PI) / 180,
      ).geometry;
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const { geometry } = makeColumnPrismGeometry(
      this.opts.diskResolution ?? 20,
      ((this.opts.angle ?? 0) * Math.PI) / 180,
    );
    geometry.instanceCount = buf.count;
    geometry.setAttribute('sttBase', new InstancedBufferAttribute(buf.bases, 3));
    geometry.setAttribute('sttBasisX', new InstancedBufferAttribute(buf.basisX, 3));
    geometry.setAttribute('sttBasisY', new InstancedBufferAttribute(buf.basisY, 3));
    geometry.setAttribute('sttBasisZ', new InstancedBufferAttribute(buf.basisZ, 3));
    geometry.setAttribute('sttColor', new InstancedBufferAttribute(buf.colors, 4));
    geometry.setAttribute('sttStart', new InstancedBufferAttribute(buf.starts, 1));
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    if (buf.bbox) {
      geometry.boundingBox = new Box3(new Vector3(...buf.bbox.min), new Vector3(...buf.bbox.max));
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    }

    this.bundle = createColumnMaterial({
      timeFiltered: this.opts.timeFiltered ?? true,
      transparent: this.opts.transparent ?? false,
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
    const params: TimeFilterParams = resolveTimeWindow(this.opts, 0);
    updateColumnUniforms(this.bundle, {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params,
      opacity: this.opts.opacity ?? 1,
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
