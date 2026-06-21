// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `StaticPolygonLayer` — flat filled ground decals, the Three port of the deck AV
 * `map_poly` rendering (drivable area, lanes, crosswalks). Uses each feature's
 * pre-baked `triangles`/`triangleOffsets` when present (the columnar.rs multi-ring
 * fix), else earcut-tessellates the feature's single ring. Coloured per feature by
 * a categorical property (`map_layer`); rendered with `depthWrite:false` so the
 * cloud above always shows through. Static — built once.
 */

import {
  Group,
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
  MeshBasicMaterial,
  DoubleSide,
} from 'three';
import earcut from 'earcut';
import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { resolveCategoryColor, type RGBA } from '../lib/color';
import type { Projection } from '../projection/local-enu';

export interface StaticPolygonLayerOptions {
  id?: string;
  colorProperty?: string;
  colorMapping?: Record<string, RGBA>;
  colorMappingDefault?: RGBA;
  /** Height above ground (metres). @default 0.02 */
  zLift?: number;
  opacity?: number;
}

const DEFAULT_COLOR: RGBA = [120, 130, 150, 90];

export class StaticPolygonLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Group();
  private mesh: Mesh;

  private readonly opts: Required<Omit<StaticPolygonLayerOptions, 'id'>>;

  constructor(options: StaticPolygonLayerOptions = {}) {
    super();
    this.id = options.id ?? 'map-poly';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.opts = {
      colorProperty: options.colorProperty ?? 'map_layer',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_COLOR,
      zLift: options.zLift ?? 0.02,
      opacity: options.opacity ?? 1,
    };
    this.mesh = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: this.opts.opacity,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    this.mesh.frustumCulled = false;
    this.object.add(this.mesh);
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (const tile of tiles) {
      for (const tl of tile.layers) {
        const b = tl.features;
        if (!b.featureCount || b.geometryType !== GeometryType.Polygon || !b.startIndices) continue;
        this.appendLayer(b, ctx.projection, positions, colors, indices);
      }
    }

    this.mesh.geometry.dispose();
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geom.setIndex(new Uint32BufferAttribute(indices, 1));
    geom.computeBoundingSphere();
    this.mesh.geometry = geom;
  }

  private appendLayer(
    b: BinaryFeatures,
    proj: Projection,
    positions: number[],
    colors: number[],
    indices: number[],
  ): void {
    const dims = b.positionDimensions ?? 2;
    const cat = b.categoricalProps[this.opts.colorProperty];
    const vertexBase = positions.length / 3;

    // Project every vertex once (indices below reference these global vertices).
    const totalVerts = b.startIndices![b.featureCount];
    for (let v = 0; v < totalVerts; v++) {
      const lon = b.positions[v * dims];
      const lat = b.positions[v * dims + 1];
      const z = (dims > 2 ? b.positions[v * dims + 2] : 0) + this.opts.zLift;
      const p = proj.project(lon, lat, z);
      positions.push(p[0], p[1], p[2]);
    }

    // Per-vertex colour by feature.
    for (let f = 0; f < b.featureCount; f++) {
      const label = cat && cat.indices[f] !== 0xffff ? cat.categories[cat.indices[f]] : undefined;
      const rgba = resolveCategoryColor(label, this.opts.colorMapping, this.opts.colorMappingDefault);
      const a = (rgba[3] ?? 255) / 255;
      const r = (rgba[0] / 255) * a;
      const g = (rgba[1] / 255) * a;
      const bl = (rgba[2] / 255) * a;
      const v0 = b.startIndices![f];
      const v1 = b.startIndices![f + 1];
      for (let v = v0; v < v1; v++) {
        colors[(vertexBase + v) * 3] = r;
        colors[(vertexBase + v) * 3 + 1] = g;
        colors[(vertexBase + v) * 3 + 2] = bl;
      }
    }

    if (b.triangles && b.triangleOffsets) {
      // Pre-baked, GLOBALLY-indexed triangles → just shift to our vertex base.
      for (let f = 0; f < b.featureCount; f++) {
        const t0 = b.triangleOffsets[f];
        const t1 = b.triangleOffsets[f + 1];
        for (let t = t0; t < t1; t++) indices.push(vertexBase + b.triangles[t]);
      }
    } else {
      // Earcut fallback — single ring per feature (no holes in this path).
      for (let f = 0; f < b.featureCount; f++) {
        const v0 = b.startIndices![f];
        const v1 = b.startIndices![f + 1];
        const ringLen = v1 - v0;
        if (ringLen < 3) continue;
        const flat = new Float64Array(ringLen * 2);
        for (let k = 0; k < ringLen; k++) {
          flat[k * 2] = b.positions[(v0 + k) * dims];
          flat[k * 2 + 1] = b.positions[(v0 + k) * dims + 1];
        }
        const tri = earcut(flat, undefined, 2);
        for (let t = 0; t < tri.length; t++) indices.push(vertexBase + v0 + tri[t]);
      }
    }
  }

  setTime(): void {}

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
  }
}
