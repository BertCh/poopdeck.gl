// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `SttIsoLayer` — animated density iso-lines, the Three port of the deck AV
 * `lidarIso` / `lidarIso3d` modes (`AnimatedPathLayer` over windowed contour
 * LineStrings). Each contour is split into `LineSegments` with per-vertex time
 * (`sttStart` / `sttEnd`) and colour (`sttColor`, the `density_band` ramp), and a
 * window-filtered {@link createIsoLineMaterial} fades it in/out around the
 * playhead. For iso3d, each ring is lifted to its real altitude via a numeric
 * `z_layer` column. Built once in {@link setTiles}; only the time uniform moves
 * per frame.
 */

import { Group, LineSegments, BufferGeometry, Float32BufferAttribute } from 'three';
import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { resolveTimeWindow, type ThreeTimeWindowOptions } from '../lib/time-window';
import { resolveCategoryColor, type RGBA } from '../lib/color';
import {
  createIsoLineMaterial,
  updateIsoLineUniforms,
  type IsoLineMaterialBundle,
} from '../tsl/iso-line-material';

export interface IsoLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** Categorical property selecting the contour colour. @default 'density_band' */
  colorProperty?: string;
  colorMapping?: Record<string, RGBA>;
  colorMappingDefault?: RGBA;
  /** Numeric column lifting each contour to a real altitude (iso3d). @default null */
  elevationProperty?: string | null;
  /** Multiplier on the elevation column (metres). @default 1 */
  elevationScale?: number;
  /** Height above ground for the flat (non-iso3d) case (metres). @default 0.05 */
  zLift?: number;
  // Full-width `timeWindow` + `fadeIn/OutDuration` and the lower-level
  // `windowHalf` (@default 130) / `fadeIn` / `fadeOut` aliases come from
  // ThreeTimeWindowOptions.
  opacity?: number;
}

const DEFAULT_COLOR: RGBA = [120, 200, 255, 220];

export class IsoLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Group();
  private lines: LineSegments;
  private bundle: IsoLineMaterialBundle;

  private readonly opts: Required<
    Omit<IsoLayerOptions, 'id' | 'timeWindow' | 'fadeInDuration' | 'fadeOutDuration'>
  >;

  constructor(options: IsoLayerOptions = {}) {
    super();
    this.id = options.id ?? 'iso';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    const tw = resolveTimeWindow(options, 130);
    this.opts = {
      colorProperty: options.colorProperty ?? 'density_band',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_COLOR,
      elevationProperty: options.elevationProperty ?? null,
      elevationScale: options.elevationScale ?? 1,
      zLift: options.zLift ?? 0.05,
      windowHalf: tw.windowHalf,
      fadeIn: tw.fadeIn,
      fadeOut: tw.fadeOut,
      opacity: options.opacity ?? 0.95,
    };
    this.bundle = createIsoLineMaterial();
    this.lines = new LineSegments(new BufferGeometry(), this.bundle.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
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
          segCount += Math.max(0, b.startIndices[f + 1] - b.startIndices[f] - 1);
        }
      }
    }

    const positions = new Float32Array(segCount * 2 * 3);
    const colors = new Float32Array(segCount * 2 * 4);
    const starts = new Float32Array(segCount * 2);
    const ends = new Float32Array(segCount * 2);
    let p = 0; // position cursor (×3)
    let c = 0; // color cursor (×4)
    let t = 0; // time cursor (×1)

    for (const b of lineLayers) {
      const dims = b.positionDimensions ?? 2;
      const cat = b.categoricalProps[this.opts.colorProperty];
      const elev =
        this.opts.elevationProperty ? b.numericProps[this.opts.elevationProperty] : undefined;
      const rebase = b.timeOffset - this.timeOrigin;

      for (let f = 0; f < b.featureCount; f++) {
        // Per-contour colour (straight, NOT premultiplied — alpha varies per frame).
        const label = cat && cat.indices[f] !== 0xffff ? cat.categories[cat.indices[f]] : undefined;
        const rgba = resolveCategoryColor(label, this.opts.colorMapping, this.opts.colorMappingDefault);
        const cr = rgba[0] / 255;
        const cg = rgba[1] / 255;
        const cb = rgba[2] / 255;
        const ca = (rgba[3] ?? 255) / 255;

        // Per-contour time window (all vertices share it).
        const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
        const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;

        // iso3d lifts the whole ring to its slab altitude; flat iso uses geom z.
        const baseZ = elev ? elev[f] * this.opts.elevationScale : null;

        const v0 = b.startIndices![f];
        const v1 = b.startIndices![f + 1];
        for (let v = v0; v < v1 - 1; v++) {
          const lon0 = b.positions[v * dims];
          const lat0 = b.positions[v * dims + 1];
          const lon1 = b.positions[(v + 1) * dims];
          const lat1 = b.positions[(v + 1) * dims + 1];
          const z0 = (baseZ ?? (dims > 2 ? b.positions[v * dims + 2] : 0)) + this.opts.zLift;
          const z1 = (baseZ ?? (dims > 2 ? b.positions[(v + 1) * dims + 2] : 0)) + this.opts.zLift;
          const a0 = proj.project(lon0, lat0, z0);
          const a1 = proj.project(lon1, lat1, z1);
          positions[p] = a0[0];
          positions[p + 1] = a0[1];
          positions[p + 2] = a0[2];
          positions[p + 3] = a1[0];
          positions[p + 4] = a1[1];
          positions[p + 5] = a1[2];
          p += 6;
          colors[c] = cr;
          colors[c + 1] = cg;
          colors[c + 2] = cb;
          colors[c + 3] = ca;
          colors[c + 4] = cr;
          colors[c + 5] = cg;
          colors[c + 6] = cb;
          colors[c + 7] = ca;
          c += 8;
          starts[t] = start;
          starts[t + 1] = start;
          ends[t] = end;
          ends[t + 1] = end;
          t += 2;
        }
      }
    }

    this.lines.geometry.dispose();
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geom.setAttribute('sttColor', new Float32BufferAttribute(colors, 4));
    geom.setAttribute('sttStart', new Float32BufferAttribute(starts, 1));
    geom.setAttribute('sttEnd', new Float32BufferAttribute(ends, 1));
    geom.computeBoundingSphere();
    this.lines.geometry = geom;
    this.lines.visible = segCount > 0; // no 0-vertex draw when there are no contours
  }

  setTime(absoluteTimeMs: number): void {
    updateIsoLineUniforms(this.bundle, {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        windowHalf: this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
      },
      opacity: this.opts.opacity,
    });
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.bundle.material.dispose();
  }
}
