// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `QuadbinSummaryLayer` — render the server-aggregated summary tier as CARTO
 * Quadbin (Z/X/Y quad-key) cells. The Three port of deck's
 * `QuadbinSummaryLayer`: each summary cell's u64 id (`featureIds64`) is decoded
 * to its lon/lat mercator quad, projected (RTC) into one merged indexed mesh,
 * and coloured by a ramp over a numeric `weightProperty` (default `'count'`).
 * At low zooms this is the only way to draw a planet-scale point dataset in
 * real time — the raw tier would push hundreds of millions of points/frame.
 *
 * Static (the summary tier is timeless aggregates): geometry is built once in
 * {@link setTiles}; {@link setTime} is a no-op. The pure geometry/colour split
 * lives in {@link buildQuadbinBuffers}; this class is the thin GPU wrapper —
 * decode → BufferGeometry (position + color) → `MeshBasicMaterial` with
 * `vertexColors` → `object.position = origin` (RTC).
 *
 * Unlocks the `od-quadbin` showcase demo.
 */

import {
  Group,
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
  MeshBasicMaterial,
  DoubleSide,
  Box3,
  Vector3,
  Sphere,
} from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import {
  buildQuadbinBuffers,
  DEFAULT_QUADBIN_COLOR_RANGE,
  type QuadbinBufferOptions,
} from '../lib/quadbin-buffers.js';
import type { RGBA } from '../lib/color.js';

export interface QuadbinSummaryLayerOptions {
  id?: string;
  /** Numeric property the color ramp is driven by. @default 'count' */
  weightProperty?: string;
  /** Low→high RGBA ramp (0-255). @default {@link DEFAULT_QUADBIN_COLOR_RANGE} */
  colorRange?: RGBA[];
  /**
   * `[min, max]` for the ramp. Pinning keeps the legend stable across tiles;
   * when null each rebuild's visible-cell min/max drives it. @default null
   */
  colorDomain?: [number, number] | null;
  /** Per-cell coverage 0..1 — shrinks the quad toward its centroid. @default 1 */
  coverage?: number;
  /** Height above ground (metres). @default 0 */
  zLift?: number;
  /** Name of the summary layer within each tile. @default 'summary' */
  summaryLayerName?: string;
  opacity?: number;
}

export class QuadbinSummaryLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Group();
  private mesh: Mesh;
  private material: MeshBasicMaterial;

  private readonly opts: QuadbinSummaryLayerOptions;

  constructor(options: QuadbinSummaryLayerOptions = {}) {
    super();
    this.opts = options;
    this.id = options.id ?? 'quadbins';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: options.opacity ?? 1,
      side: DoubleSide,
      depthWrite: false,
    });
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.object.add(this.mesh);
  }

  private bufferOptions(): QuadbinBufferOptions {
    return {
      weightProperty: this.opts.weightProperty ?? 'count',
      colorRange: this.opts.colorRange ?? DEFAULT_QUADBIN_COLOR_RANGE,
      colorDomain: this.opts.colorDomain ?? null,
      coverage: this.opts.coverage ?? 1,
      zLift: this.opts.zLift ?? 0,
      summaryLayerName: this.opts.summaryLayerName ?? 'summary',
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildQuadbinBuffers(tiles, ctx.projection, this.bufferOptions());

    this.mesh.geometry.dispose();
    if (buf.count === 0) {
      this.mesh.geometry = new BufferGeometry();
      this.mesh.visible = false;
      return;
    }

    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(buf.positions, 3));
    geom.setAttribute('color', new Float32BufferAttribute(buf.colors, 4));
    geom.setIndex(new Uint32BufferAttribute(buf.indices, 1));
    if (buf.bbox) {
      geom.boundingBox = new Box3(new Vector3(...buf.bbox.min), new Vector3(...buf.bbox.max));
      geom.boundingSphere = geom.boundingBox.getBoundingSphere(new Sphere());
    } else {
      geom.computeBoundingSphere();
    }
    this.mesh.geometry = geom;
    this.mesh.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);
  }

  setTime(): void {}

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
