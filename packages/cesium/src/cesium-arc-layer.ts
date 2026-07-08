// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Animated OD flow arcs for CesiumJS — the Cesium analogue of deck's
 * `AnimatedArcLayer`. Each LineString feature collapses to its source/target
 * endpoints (kernel `deriveSourceTargetPositions`) and is swept into a raised
 * great-circle polyline by the pure `sampleGreatCircleArc` — the SAME
 * parametrization as three's globe arc material, so a backend toggle shows the
 * same arc. Per-frame time-filter colour animation + picking come from
 * {@link BatchedPolylineLayer}.
 *
 * Deviation from deck (see the capability matrix): one colour per arc — the
 * source→target gradient collapses to a single per-instance colour.
 */

import type { Scene } from 'cesium';
import type { Tile } from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  BatchedPolylineLayer,
  type BatchedPolylineOptions,
} from './batched-polyline-layer.js';
import { buildArcPolylines } from './lib/polylines.js';
import type { FeatureColorMode } from './lib/feature-color.js';

export interface CesiumArcLayerOptions extends Omit<
  BatchedPolylineOptions,
  'arcType'
> {
  id?: string;
  /** Per-arc colour (constant / categorical / ramp). @default opaque grey */
  color?: FeatureColorMode;
  /** Arc-height multiplier (deck's `getHeight`); 0 = surface-hugging chord. @default 1 */
  height?: number;
  /** Sample count per arc. @default 33 */
  samples?: number;
  /** Constant altitude lift in metres on both endpoints. @default 0 */
  zLift?: number;
}

export class CesiumArcLayer implements SttRenderNode {
  readonly id: string;
  private readonly batch: BatchedPolylineLayer;
  private readonly opts: CesiumArcLayerOptions;

  constructor(scene: Scene, options: CesiumArcLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-arcs';
    this.opts = options;
    // The arc is already densely sampled — straight segments between samples.
    this.batch = new BatchedPolylineLayer(scene, this.id, {
      ...options,
      arcType: 'none',
    });
  }

  /** (Re)build arcs from decoded tiles (replace-all). */
  setTiles(tiles: Tile[]): void {
    this.batch.setPolylines(
      buildArcPolylines(tiles, {
        color: this.opts.color,
        height: this.opts.height,
        samples: this.opts.samples,
        zLift: this.opts.zLift,
      }),
    );
  }

  setTime(absoluteMs: number): void {
    this.batch.setTime(absoluteMs);
  }

  pick(cssX: number, cssY: number): SttPickResult | null {
    return this.batch.pick(cssX, cssY);
  }

  dispose(): void {
    this.batch.dispose();
  }
}
