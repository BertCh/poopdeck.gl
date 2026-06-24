// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `PolygonLayer` — filled polygon meshes, the Three port of the deck
 * `AnimatedPolygonLayer` (and its static `map_poly` ancestor). It merges every
 * polygon feature across the resident tiles into ONE indexed mesh via the pure
 * {@link buildPolygonBuffers} builder, then shades it with a single
 * {@link createPolygonMaterial} node material:
 *
 *   • TESSELLATION — honours a tile's pre-baked `triangles`/`triangleOffsets`
 *     (the columnar.rs multi-ring / hole fix) when present, else earcut-
 *     tessellates each feature's ring **in projected/planar space** (raw lon/lat
 *     earcut is wrong under mercator/globe).
 *   • TIME WINDOW — in `window` mode each vertex carries its feature's
 *     `[start,end]` and the material fades the polygon in/out around the playhead
 *     (storms / wildfires / osm). `none` mode is the shipped static AV map-decal
 *     behaviour, byte-identical (constant alpha, no filter).
 *   • EXTRUSION — an optional numeric column raises each feature to a 3D prism
 *     (cap + side walls), sized in true metres at any latitude.
 *   • RTC — positions are f32 relative to a per-build origin; the layer sets
 *     `object.position = origin` so large mercator/globe magnitudes stay in the
 *     f64 CPU transform.
 *
 * {@link StaticPolygonLayer} is a thin back-compat wrapper preserving the old
 * AV map-poly API (categorical `map_layer` colouring, flat, no time filter).
 */

import { Group, Mesh, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer';
import { type RGBA } from '../lib/color';
import {
  buildPolygonBuffers,
  type PolygonColorMode,
  type PolygonBufferOptions,
} from './polygon-buffers';
import {
  createPolygonMaterial,
  updatePolygonUniforms,
  type PolygonMaterialBundle,
  type PolygonTimeMode,
} from '../tsl/polygon-material';

export interface PolygonLayerOptions {
  id?: string;
  /** How each feature is coloured. @default constant grey */
  colorMode?: PolygonColorMode;
  /** Time-filter mode. @default 'none' (static) */
  mode?: PolygonTimeMode;
  /** Half-width of the playhead time window (ms), `window` mode. @default 500 */
  windowHalf?: number;
  /** Edge fade-in / fade-out ramp (ms), `window` mode. @default 0 */
  fadeIn?: number;
  fadeOut?: number;
  /** Height above ground for flat fills (metres). @default 0.02 */
  zLift?: number;
  /** Numeric column extruding each feature into a 3D prism (metres). @default null */
  extrusionProperty?: string | null;
  /** Multiplier on extrusion height + geometry z. @default 1 */
  elevationScale?: number;
  /** Write depth (extruded prisms usually want this). @default false */
  depthWrite?: boolean;
  opacity?: number;
}

const DEFAULT_COLOR: RGBA = [120, 130, 150, 90];

export class PolygonLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Group();
  private mesh: Mesh;
  private bundle: PolygonMaterialBundle;

  private readonly opts: Required<Omit<PolygonLayerOptions, 'id'>>;

  constructor(options: PolygonLayerOptions = {}) {
    super();
    this.id = options.id ?? 'polygons';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.opts = {
      colorMode: options.colorMode ?? { type: 'constant', color: DEFAULT_COLOR },
      mode: options.mode ?? 'none',
      windowHalf: options.windowHalf ?? 500,
      fadeIn: options.fadeIn ?? 0,
      fadeOut: options.fadeOut ?? 0,
      zLift: options.zLift ?? 0.02,
      extrusionProperty: options.extrusionProperty ?? null,
      elevationScale: options.elevationScale ?? 1,
      depthWrite: options.depthWrite ?? false,
      opacity: options.opacity ?? 1,
    };
    this.bundle = createPolygonMaterial({
      mode: this.opts.mode,
      depthWrite: this.opts.depthWrite,
    });
    this.mesh = new Mesh(new BufferGeometry(), this.bundle.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.object.add(this.mesh);
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    const bufOpts: PolygonBufferOptions = {
      colorMode: this.opts.colorMode,
      zLift: this.opts.zLift,
      extrusionProperty: this.opts.extrusionProperty,
      elevationScale: this.opts.elevationScale,
    };
    const buf = buildPolygonBuffers(tiles, ctx.projection, ctx.timeOrigin, bufOpts);

    this.mesh.geometry.dispose();
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(buf.positions, 3));
    geom.setAttribute('sttColor', new Float32BufferAttribute(buf.colors, 4));
    geom.setAttribute('sttStart', new Float32BufferAttribute(buf.starts, 1));
    geom.setAttribute('sttEnd', new Float32BufferAttribute(buf.ends, 1));
    geom.setIndex(new Uint32BufferAttribute(buf.indices, 1));
    geom.computeBoundingSphere();
    this.mesh.geometry = geom;

    // RTC: the large mercator/globe magnitude lives in the f64 CPU transform.
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);
    this.mesh.visible = buf.indices.length > 0;

    // Seed the uniforms so the static (`none`) path is correct before any frame.
    updatePolygonUniforms(this.bundle, {
      relativeCurrentTime: 0,
      params: {
        windowHalf: this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
      },
      opacity: this.opts.opacity,
    });
  }

  setTime(absoluteTimeMs: number): void {
    updatePolygonUniforms(this.bundle, {
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
    this.mesh.geometry.dispose();
    this.bundle.material.dispose();
  }
}

// ── Back-compat: the shipped AV map-poly layer ─────────────────────────────────

export interface StaticPolygonLayerOptions {
  id?: string;
  colorProperty?: string;
  colorMapping?: Record<string, RGBA>;
  colorMappingDefault?: RGBA;
  /** Height above ground (metres). @default 0.02 */
  zLift?: number;
  opacity?: number;
}

/**
 * The original flat, static, categorically-coloured AV `map_poly` layer
 * (drivable area / lanes / crosswalks). Now a thin preset over {@link PolygonLayer}
 * (`mode:'none'`, categorical colour by `map_layer`) so the shipped cockpit keeps
 * working unchanged.
 */
export class StaticPolygonLayer extends PolygonLayer {
  constructor(options: StaticPolygonLayerOptions = {}) {
    super({
      id: options.id ?? 'map-poly',
      mode: 'none',
      colorMode: {
        type: 'categorical',
        property: options.colorProperty ?? 'map_layer',
        mapping: options.colorMapping ?? {},
        fallback: options.colorMappingDefault ?? [120, 130, 150, 90],
      },
      zLift: options.zLift ?? 0.02,
      opacity: options.opacity ?? 1,
    });
  }
}
