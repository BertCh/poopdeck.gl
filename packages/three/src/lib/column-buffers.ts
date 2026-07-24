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
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  rampColorAt,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from './color.js';
import { featureCategorySlot, type StablePalette } from './palette.js';
import { featureTileKey } from './id-pick.js';

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
  /**
   * Numeric column feeding the GPU DataFilter (`sttFilterValue`, per column).
   * When set, `filterValues` is emitted (0 where a tile lacks the column, deck's
   * constant fallback). @default null (no filter attribute)
   */
  filterProperty?: string | null;
  /**
   * Emit the per-instance time-as-height LIFT direction (`sttLift`, vec3 =
   * local up ÷ metersPerWorldUnit — WORLD units per metre of altitude). When
   * set, the space-time-cube material raises each prism's foot by its feature
   * start time from a single scale uniform. @default false (no lift attribute)
   */
  timeHeight?: boolean;
  /**
   * GPU stable-palette path (deck `CategoryColorExtension`): when set, emit a
   * per-column `categoryIndices` slot buffer for the palette-texture lookup — the
   * category LABEL is placed by `palette` (stable across tiles), NULL / missing →
   * the palette's null slot. The CPU-expanded `colors` still ride along (the
   * shader ignores them under the palette path). @default null
   */
  categoryIndex?: { property: string; palette: StablePalette } | null;
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
  /** float, per-column DataFilter value; 0-length when no `filterProperty`. */
  filterValues: Float32Array;
  /** float, per-column stable palette slot; 0-length when no `categoryIndex`. */
  categoryIndices: Float32Array;
  /**
   * vec3 time-as-height lift direction per instance (local up ÷
   * metersPerWorldUnit = world units per metre of altitude); 0-length when no
   * `timeHeight`.
   */
  lift: Float32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-instance provenance (the GPU picking-catalog identity buffer).
   * Merged column instance `i` — the same `i` a GPU id-buffer pick decodes —
   * resolves via `provenance.resolve(i)` to its source `(tileKey, featureIndex)`.
   * Populated in the EXACT order instances are written (1 column per Point
   * feature), so index alignment with the geometry is guaranteed. Empty when
   * `count === 0`. See `point-buffers.ts` (the template).
   */
  provenance: InstanceProvenance;
  /**
   * `tileKey` → the source layer's {@link BinaryFeatures}, so a resolved
   * provenance entry can be joined back to columns via
   * `getFeatureProperties(binary, featureIndex)`. Built from the SAME iteration
   * (and the same {@link featureTileKey}) as {@link provenance}, so keys align.
   */
  binaryByTileKey: Map<string, BinaryFeatures>;
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
  parts: Array<{ b: BinaryFeatures; tileKey: string }>;
  total: number;
} {
  const parts: Array<{ b: BinaryFeatures; tileKey: string }> = [];
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount || b.geometryType !== GeometryType.Point) continue;
      parts.push({ b, tileKey: featureTileKey(tile.id, tl.name) });
      total += b.featureCount;
    }
  }
  return { parts, total };
}

export function buildColumnBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: ColumnBufferOptions,
): ColumnBuffers {
  const { parts, total } = collectPointLayers(tiles);
  const provenance = new InstanceProvenance();
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const empty = (): ColumnBuffers => ({
    count: 0,
    bases: new Float32Array(0),
    basisX: new Float32Array(0),
    basisY: new Float32Array(0),
    basisZ: new Float32Array(0),
    colors: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    filterValues: new Float32Array(0),
    categoryIndices: new Float32Array(0),
    lift: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
    provenance,
    binaryByTileKey,
  });
  if (total === 0) return empty();

  const radius = opts.radius ?? 100;
  const defaultElevation = opts.defaultElevation ?? 1000;
  const elevScale = opts.elevationScale ?? 1;
  const zLift = opts.zLift ?? 0;
  const wantFilter = !!opts.filterProperty;
  const wantLift = !!opts.timeHeight;
  const catIndex = opts.categoryIndex ?? null;

  // RTC origin = first feature's projected foot (absolute world).
  const first = parts[0].b;
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
  const filterValues = wantFilter
    ? new Float32Array(total)
    : new Float32Array(0);
  const categoryIndices = catIndex
    ? new Float32Array(total)
    : new Float32Array(0);
  const lift = wantLift ? new Float32Array(total * 3) : new Float32Array(0);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let o = 0; // instance index
  for (const part of parts) {
    const b = part.b;
    binaryByTileKey.set(part.tileKey, b);
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const baseElev = opts.baseElevationProperty
      ? b.numericProps[opts.baseElevationProperty]
      : undefined;
    const filterCol =
      wantFilter && opts.filterProperty
        ? b.numericProps[opts.filterProperty]
        : undefined;
    const rebase = b.timeOffset - timeOrigin;
    for (let f = 0; f < b.featureCount; f++) {
      // Provenance MUST be pushed in the same order instances are written
      // (merged index = o), so a decoded GPU id aligns with this feature.
      provenance.push(part.tileKey, f);
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

      // Time-as-height lift direction: local up scaled to WORLD units per metre
      // of altitude (÷ metersPerWorldUnit, same metric→world factor as the
      // height above). The shader multiplies this by (start − heightOrigin) ×
      // heightScale, so the whole prism rises with the feature's time.
      if (wantLift) {
        lift[o * 3] = u[0] * inv;
        lift[o * 3 + 1] = u[1] * inv;
        lift[o * 3 + 2] = u[2] * inv;
      }

      const rgba = featureColor(b, f, opts.colorMode);
      colors[o * 4] = rgba[0] / 255;
      colors[o * 4 + 1] = rgba[1] / 255;
      colors[o * 4 + 2] = rgba[2] / 255;
      colors[o * 4 + 3] = (rgba[3] ?? 255) / 255;

      starts[o] = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      ends[o] = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      if (wantFilter) filterValues[o] = filterCol ? filterCol[f] : 0;
      if (catIndex)
        categoryIndices[o] = featureCategorySlot(
          b,
          f,
          catIndex.property,
          catIndex.palette,
        );

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
    filterValues,
    categoryIndices,
    lift,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}

export type { RGBA };
