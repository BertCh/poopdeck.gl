// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Animated LineString rendering for CesiumJS — the Cesium analogue of deck's
 * `AnimatedPathLayer` AND `AnimatedLineLayer` (an OD line is just a 2-vertex
 * LineString, so both `path` and `line` kinds land here). Geometry comes from
 * the pure `buildPathPolylines` (kernel WGS84 ECEF projection, geometry z
 * honoured — satellite tracks fly at altitude); per-frame time-filter colour
 * animation + picking come from {@link BatchedPolylineLayer}.
 *
 * Deviation from deck (documented in the backend capability matrix): colour is
 * one value per feature — Cesium's batch-table animation path has no per-vertex
 * colour, so OD endpoint gradients (`getSourceColor`/`getTargetColor`) collapse
 * to the source colour.
 */

import type { Scene } from 'cesium';
import type { Tile } from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import { BatchedPolylineLayer, type BatchedPolylineOptions } from './batched-polyline-layer';
import { buildPathPolylines } from './lib/polylines';
import type { FeatureColorMode } from './lib/feature-color';

export interface CesiumPathLayerOptions extends BatchedPolylineOptions {
  id?: string;
  /** Per-feature colour (constant / categorical / ramp). @default opaque grey */
  color?: FeatureColorMode;
  /** Constant altitude lift in metres. @default 0 */
  zLift?: number;
}

export class CesiumPathLayer implements SttRenderNode {
  readonly id: string;
  private readonly batch: BatchedPolylineLayer;
  private readonly opts: CesiumPathLayerOptions;

  constructor(scene: Scene, options: CesiumPathLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-paths';
    this.opts = options;
    this.batch = new BatchedPolylineLayer(scene, this.id, options);
  }

  /** (Re)build polylines from decoded tiles (replace-all). */
  setTiles(tiles: Tile[]): void {
    this.batch.setPolylines(buildPathPolylines(tiles, { color: this.opts.color, zLift: this.opts.zLift }));
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
