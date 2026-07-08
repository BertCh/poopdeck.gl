// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of instanced **column** (extruded-prism) buffers —
 * the Three analogue of deck's `AnimatedColumnLayer`. Each Point feature becomes
 * one column instance: a unit cylinder/prism standing on the ground, scaled by a
 * per-feature radius (metric) and height (a numeric column × `elevationScale`),
 * coloured per-feature (categorical / ramp / constant), and time-windowed by the
 * feature's `[start,end]`.
 *
 * ── ORIENTATION (globe-safe) ──────────────────────────────────────────────────
 * A column must stand UP on the local ground, which on the ECEF globe is a
 * per-position basis (not world Z). For each instance we bake the projection's
 * `localFrame(lon,lat)` E/N/U world vectors, pre-scaled into three "basis"
 * columns the vertex shader recomposes:
 *   • `basisX` = east  × radiusWorld   (unit-cylinder X → ground east)
 *   • `basisY` = north × radiusWorld   (unit-cylinder Y → ground north)
 *   • `basisZ` = up    × heightWorld   (unit-cylinder Z → local up)
 * so `worldOffset = cyl.x·basisX + cyl.y·basisY + cyl.z·basisZ` from the instance
 * base. The unit-cylinder geometry is radius-1 in XY with its base at z=0 and top
 * at z=1 (see `geometry/column-prism.ts`).
 *
 * ── SIZING ────────────────────────────────────────────────────────────────────
 * `radius`/`elevation` are TRUE metres; one world unit is `metersPerWorldUnit`
 * ground metres, so metric → world divides by that factor (ENU = 1, mercator =
 * cos(lat), globe = 1). This keeps a 100 m column 100 m at any latitude.
 *
 * ── RTC ───────────────────────────────────────────────────────────────────────
 * Bases (the column axes) are direction vectors and stay absolute; only the
 * instance BASE position is written f32 RELATIVE to a shared `origin` (first
 * projected feature), which the layer writes to `object.position`. For ENU the
 * origin is tiny so this is a no-op.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  rampColorAt,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from './color.js';

export type ColumnColorMode =
  | ({ type: 'categorical' } & CategoricalColorSpec)
  | ({ type: 'ramp' } & RampColorSpec)
  | { type: 'constant'; color: RGBA };

export interface ColumnBufferOptions {
  colorMode: ColumnColorMode;
  /**
   * Numeric column driving each column's HEIGHT (true metres). When absent on a
   * tile (or `null`), every column uses `defaultElevation`.
   * @default null
   */
  elevationProperty?: string | null;
  /** Constant height (metres) when `elevationProperty` is absent. @default 1000 */
  defaultElevation?: number;
  /** Multiplier applied to every height (constant AND column-driven). @default 1 */
  elevationScale?: number;
  /** Disk radius in true metres. @default 100 */
  radius?: number;
  /** Base altitude column (metres) lifting the column foot off the ground. */
  baseElevationProperty?: string | null;
  /** Constant base-altitude lift (metres) added to every column foot. @default 0 */
  zLift?: number;
}

export interface ColumnBuffers {
  count: number;
  /** vec3 instance base position, RTC-local (foot of the column). */
  bases: Float32Array;
  /** vec3 east × radiusWorld per instance. */
  basisX: Float32Array;
  /** vec3 north × radiusWorld per instance. */
  basisY: Float32Array;
  /** vec3 up × heightWorld per instance. */
  basisZ: Float32Array;
  /** vec4 colour 0..1 per instance. */
  colors: Float32Array;
  /** float start time, relative to timeOrigin. */
  starts: Float32Array;
  /** float end time, relative to timeOrigin. */
  ends: Float32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

function featureColor(
  b: BinaryFeatures,
  f: number,
  mode: ColumnColorMode,
): RGBA {
  if (mode.type === 'constant') return mode.color;
  if (mode.type === 'ramp') {
    const col = b.numericProps[mode.property];
    return col ? rampColorAt(col[f], mode.domain, mode.range) : mode.fallback;
  }
  const cat = b.categoricalProps[mode.property];
  const label =
    cat && cat.indices[f] !== 0xffff
      ? cat.categories[cat.indices[f]]
      : undefined;
  return resolveCategoryColor(label, mode.mapping, mode.fallback);
}

function collectPointLayers(tiles: Tile[]): {
  layers: BinaryFeatures[];
  total: number;
} {
  const layers: BinaryFeatures[] = [];
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount || b.geometryType !== GeometryType.Point) continue;
      layers.push(b);
      total += b.featureCount;
    }
  }
  return { layers, total };
}

export function buildColumnBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: ColumnBufferOptions,
): ColumnBuffers {
  const { layers, total } = collectPointLayers(tiles);
  const empty = (): ColumnBuffers => ({
    count: 0,
    bases: new Float32Array(0),
    basisX: new Float32Array(0),
    basisY: new Float32Array(0),
    basisZ: new Float32Array(0),
    colors: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
  });
  if (total === 0) return empty();

  const radius = opts.radius ?? 100;
  const defaultElevation = opts.defaultElevation ?? 1000;
  const elevScale = opts.elevationScale ?? 1;
  const zLift = opts.zLift ?? 0;

  // RTC origin = first feature's projected foot (absolute world).
  const first = layers[0];
  const fdims = first.positionDimensions ?? 2;
  const firstBaseZ = (() => {
    const baseProp = opts.baseElevationProperty
      ? first.numericProps[opts.baseElevationProperty]
      : undefined;
    if (baseProp) return baseProp[0] + zLift;
    return (fdims > 2 ? first.positions[2] : 0) + zLift;
  })();
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    firstBaseZ,
  );

  const bases = new Float32Array(total * 3);
  const basisX = new Float32Array(total * 3);
  const basisY = new Float32Array(total * 3);
  const basisZ = new Float32Array(total * 3);
  const colors = new Float32Array(total * 4);
  const starts = new Float32Array(total);
  const ends = new Float32Array(total);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let o = 0; // instance index
  for (const b of layers) {
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const baseElev = opts.baseElevationProperty
      ? b.numericProps[opts.baseElevationProperty]
      : undefined;
    const rebase = b.timeOffset - timeOrigin;
    for (let f = 0; f < b.featureCount; f++) {
      const lon = b.positions[f * dims];
      const lat = b.positions[f * dims + 1];
      const baseZ =
        (baseElev ? baseElev[f] : dims > 2 ? b.positions[f * dims + 2] : 0) +
        zLift;
      const [px, py, pz] = projection.project(lon, lat, baseZ);

      bases[o * 3] = px - origin[0];
      bases[o * 3 + 1] = py - origin[1];
      bases[o * 3 + 2] = pz - origin[2];

      // metric → world: 1 world unit = metersPerWorldUnit ground metres.
      const inv = 1 / projection.metersPerWorldUnit(lon, lat);
      const rWorld = radius * inv;
      const hMetres = (elev ? elev[f] : defaultElevation) * elevScale;
      const hWorld = hMetres * inv;

      const frame = projection.localFrame(lon, lat);
      const e = frame.east,
        n = frame.north,
        u = frame.up;
      basisX[o * 3] = e[0] * rWorld;
      basisX[o * 3 + 1] = e[1] * rWorld;
      basisX[o * 3 + 2] = e[2] * rWorld;
      basisY[o * 3] = n[0] * rWorld;
      basisY[o * 3 + 1] = n[1] * rWorld;
      basisY[o * 3 + 2] = n[2] * rWorld;
      basisZ[o * 3] = u[0] * hWorld;
      basisZ[o * 3 + 1] = u[1] * hWorld;
      basisZ[o * 3 + 2] = u[2] * hWorld;

      const rgba = featureColor(b, f, opts.colorMode);
      colors[o * 4] = rgba[0] / 255;
      colors[o * 4 + 1] = rgba[1] / 255;
      colors[o * 4 + 2] = rgba[2] / 255;
      colors[o * 4 + 3] = (rgba[3] ?? 255) / 255;

      starts[o] = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      ends[o] = (b.endTimes ? b.endTimes[f] : 0) + rebase;

      // bbox over the foot and the top of the column (covers the extrusion).
      const bx = bases[o * 3],
        by = bases[o * 3 + 1],
        bz = bases[o * 3 + 2];
      const tx = bx + basisZ[o * 3],
        ty = by + basisZ[o * 3 + 1],
        tz = bz + basisZ[o * 3 + 2];
      for (const [x, y, z] of [
        [bx, by, bz],
        [tx, ty, tz],
      ] as const) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      o++;
    }
  }

  return {
    count: total,
    bases,
    basisX,
    basisY,
    basisZ,
    colors,
    starts,
    ends,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

export type { RGBA };
