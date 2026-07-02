// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `StaticPathLayer` — flat ground-decal polylines, the Three port of the deck AV
 * `map_line` rendering (lane dividers, boundaries, centerlines). Each LineString
 * feature is split into `LineSegments`, projected to ENU at a small `zLift`, and
 * coloured by a categorical property (`map_layer`) through a colour map. Static:
 * built once in {@link setTiles}, no per-frame work.
 */

import {
  Group,
  LineSegments,
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
} from 'three';
import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import { resolveCategoryColor, type RGBA } from '../lib/color.js';

export interface StaticPathLayerOptions {
  id?: string;
  /** Categorical property selecting the colour (e.g. `map_layer`). */
  colorProperty?: string;
  colorMapping?: Record<string, RGBA>;
  colorMappingDefault?: RGBA;
  /** Height above ground (metres). @default 0.05 */
  zLift?: number;
  opacity?: number;
}

const DEFAULT_COLOR: RGBA = [120, 130, 150, 220];

export class StaticPathLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Group();
  private lines: LineSegments;

  private readonly opts: Required<Omit<StaticPathLayerOptions, 'id'>>;

  constructor(options: StaticPathLayerOptions = {}) {
    super();
    this.id = options.id ?? 'map-line';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.opts = {
      colorProperty: options.colorProperty ?? 'map_layer',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_COLOR,
      zLift: options.zLift ?? 0.05,
      opacity: options.opacity ?? 1,
    };
    this.lines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.opts.opacity }),
    );
    this.lines.frustumCulled = false;
    this.object.add(this.lines);
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const proj = ctx.projection;

    // Pass 1 — count segments.
    let segCount = 0;
    const lineLayers: BinaryFeatures[] = [];
    for (const tile of tiles) {
      for (const tl of tile.layers) {
        const b = tl.features;
        if (!b.featureCount || b.geometryType !== GeometryType.LineString || !b.startIndices) continue;
        lineLayers.push(b);
        for (let f = 0; f < b.featureCount; f++) {
          const v0 = b.startIndices[f];
          const v1 = b.startIndices[f + 1];
          segCount += Math.max(0, v1 - v0 - 1);
        }
      }
    }

    const positions = new Float32Array(segCount * 2 * 3);
    const colors = new Float32Array(segCount * 2 * 3);
    const dimsDefault = 2;
    let o = 0;
    for (const b of lineLayers) {
      const dims = b.positionDimensions ?? dimsDefault;
      const cat = b.categoricalProps[this.opts.colorProperty];
      for (let f = 0; f < b.featureCount; f++) {
        const label =
          cat && cat.indices[f] !== 0xffff ? cat.categories[cat.indices[f]] : undefined;
        const rgba = resolveCategoryColor(label, this.opts.colorMapping, this.opts.colorMappingDefault);
        const a = (rgba[3] ?? 255) / 255;
        const r = (rgba[0] / 255) * a;
        const g = (rgba[1] / 255) * a;
        const bl = (rgba[2] / 255) * a;
        const v0 = b.startIndices![f];
        const v1 = b.startIndices![f + 1];
        for (let v = v0; v < v1 - 1; v++) {
          const lon0 = b.positions[v * dims];
          const lat0 = b.positions[v * dims + 1];
          const lon1 = b.positions[(v + 1) * dims];
          const lat1 = b.positions[(v + 1) * dims + 1];
          const z0 = (dims > 2 ? b.positions[v * dims + 2] : 0) + this.opts.zLift;
          const z1 = (dims > 2 ? b.positions[(v + 1) * dims + 2] : 0) + this.opts.zLift;
          const p0 = proj.project(lon0, lat0, z0);
          const p1 = proj.project(lon1, lat1, z1);
          positions[o] = p0[0];
          positions[o + 1] = p0[1];
          positions[o + 2] = p0[2];
          positions[o + 3] = p1[0];
          positions[o + 4] = p1[1];
          positions[o + 5] = p1[2];
          colors[o] = r;
          colors[o + 1] = g;
          colors[o + 2] = bl;
          colors[o + 3] = r;
          colors[o + 4] = g;
          colors[o + 5] = bl;
          o += 6;
        }
      }
    }

    this.lines.geometry.dispose();
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geom.computeBoundingSphere();
    this.lines.geometry = geom;
    this.lines.visible = segCount > 0; // no 0-vertex draw when there are no lines
  }

  // Static geometry — nothing animates per frame.
  setTime(): void {}

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as LineBasicMaterial).dispose();
  }
}
