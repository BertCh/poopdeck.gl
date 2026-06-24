// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `H3SummaryLayer` — render the server-aggregated summary tier as Uber H3
 * hexagons. The Three port of deck's `H3SummaryLayer`: each summary cell's u64
 * id (`featureIds64`) is decoded to its lon/lat boundary ring, projected (RTC)
 * into one merged indexed mesh, and coloured by a ramp over a numeric
 * `weightProperty` (default `'count'`). At low zooms this is the only way to
 * draw a planet-scale point dataset in real time — the raw tier would push
 * hundreds of millions of points/frame.
 *
 * Static (the summary tier is timeless aggregates): geometry is built once in
 * {@link setTiles}; {@link setTime} is a no-op. The pure geometry/colour split
 * lives in {@link buildH3Buffers}; this class is the thin GPU wrapper — decode →
 * BufferGeometry (position + color) → `MeshBasicMaterial` with `vertexColors` →
 * `object.position = origin` (RTC).
 *
 * The H3 analogue of {@link QuadbinSummaryLayer}; same material + RTC approach,
 * differing only in the cell decode (H3 boundary ring vs mercator quad) and the
 * variable-N triangle-fan tessellation it implies.
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
import { BaseSttLayer, type SttLayerContext } from './layer';
import {
  buildH3Buffers,
  DEFAULT_H3_COLOR_RANGE,
  type H3BufferOptions,
} from '../lib/h3-buffers';
import type { RGBA } from '../lib/color';

export interface H3SummaryLayerOptions {
  id?: string;
  /** Numeric property the color ramp is driven by. @default 'count' */
  weightProperty?: string;
  /** Low→high RGBA ramp (0-255). @default {@link DEFAULT_H3_COLOR_RANGE} */
  colorRange?: RGBA[];
  /**
   * `[min, max]` for the ramp. Pinning keeps the legend stable across tiles;
   * when null each rebuild's visible-cell min/max drives it. @default null
   */
  colorDomain?: [number, number] | null;
  /** Per-cell coverage 0..1 — shrinks the hexagon toward its centroid. @default 1 */
  coverage?: number;
  /** Height above ground (metres). @default 0 */
  zLift?: number;
  /** Name of the summary layer within each tile. @default 'summary' */
  summaryLayerName?: string;
  opacity?: number;
}

export class H3SummaryLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Group();
  private mesh: Mesh;
  private material: MeshBasicMaterial;

  private readonly opts: H3SummaryLayerOptions;

  constructor(options: H3SummaryLayerOptions = {}) {
    super();
    this.opts = options;
    this.id = options.id ?? 'h3-cells';
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

  private bufferOptions(): H3BufferOptions {
    return {
      weightProperty: this.opts.weightProperty ?? 'count',
      colorRange: this.opts.colorRange ?? DEFAULT_H3_COLOR_RANGE,
      colorDomain: this.opts.colorDomain ?? null,
      coverage: this.opts.coverage ?? 1,
      zLift: this.opts.zLift ?? 0,
      summaryLayerName: this.opts.summaryLayerName ?? 'summary',
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const buf = buildH3Buffers(tiles, ctx.projection, this.bufferOptions());

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
