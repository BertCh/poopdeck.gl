// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of a merged, indexed quad mesh for the Quadbin
 * summary tier — the geometry-side port of deck's `QuadbinSummaryLayer`. Each
 * summary cell's u64 id (`featureIds64`) is decoded to its lon/lat mercator
 * quad ({@link cellBoundsFromTile}), the four corners are projected (RTC,
 * relative to a shared `origin`), and the cell is coloured by a ramp over a
 * numeric `weightProperty` (default `'count'`) bucketed across `colorRange`.
 *
 * This is the unit-tested half; {@link QuadbinSummaryLayer} is the thin GPU
 * wrapper. We bake a flat indexed `TRIANGLES` mesh (4 verts + 6 indices per
 * cell) rather than instancing — cells are few (summary tiles are row-light)
 * and a single merged BufferGeometry is the simplest faithful render.
 *
 * **RTC**: positions are written f32 RELATIVE to a per-build `origin` (the
 * first cell's SW corner, projected); the layer sets `object.position = origin`
 * so large mercator/globe magnitudes live in the f64 CPU transform. For the
 * ENU/AV frame the origin is tiny and this is a no-op.
 *
 * Coloring matches the deck `rampColor`: quantise `(weight - lo)/(hi - lo)`
 * into one of `colorRange.length` buckets (last bucket for values ≥ hi).
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { cellBoundsFromTile } from './quadbin-cell';
import type { Projection } from '../projection/local-enu';
import type { RGBA } from './color';

/** Default 6-stop low→high ramp (mirrors the deck layer's DEFAULT_COLOR_RANGE). */
export const DEFAULT_QUADBIN_COLOR_RANGE: RGBA[] = [
  [255, 255, 204, 220],
  [199, 233, 180, 230],
  [127, 205, 187, 235],
  [65, 182, 196, 240],
  [44, 127, 184, 245],
  [37, 52, 148, 255],
];

export interface QuadbinBufferOptions {
  /** Numeric column driving the color ramp. @default 'count' */
  weightProperty?: string;
  /** Low→high RGBA ramp (0-255). @default {@link DEFAULT_QUADBIN_COLOR_RANGE} */
  colorRange?: RGBA[];
  /**
   * `[min, max]` for the ramp. When null the visible cells' own min/max drive
   * it (computed across all tiles). @default null
   */
  colorDomain?: [number, number] | null;
  /** Per-cell coverage 0..1 — shrinks the quad toward its centroid. @default 1 */
  coverage?: number;
  /** Height above ground (metres) for the flat quad. @default 0 */
  zLift?: number;
  /** Name of the summary layer within each tile. @default 'summary' */
  summaryLayerName?: string;
}

export interface QuadbinBuffers {
  /** Number of cells (quads) emitted. */
  count: number;
  /** vec3 world positions, f32, RTC-local (4 per cell). */
  positions: Float32Array;
  /** vec4 color 0..1 (4 per cell, one color per cell repeated to its 4 verts). */
  colors: Float32Array;
  /** Uint32 triangle indices into `positions` (6 per cell). */
  indices: Uint32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

function emptyBuffers(): QuadbinBuffers {
  return {
    count: 0,
    positions: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
    origin: [0, 0, 0],
    bbox: null,
  };
}

/**
 * Quantise `value` into a color from `range` using `[lo, hi]`. Mirrors the deck
 * layer's `rampColor`: clamp `t = (value-lo)/(hi-lo)` to [0,1], bucket into
 * `floor(t * range.length)` (last bucket for value ≥ hi).
 */
export function rampBucketColor(
  value: number,
  domain: [number, number],
  range: RGBA[],
): RGBA {
  const [lo, hi] = domain;
  if (!Number.isFinite(value) || hi <= lo) return range[0];
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  const idx = Math.min(range.length - 1, Math.floor(t * range.length));
  return range[idx];
}

interface CellLayer {
  binary: BinaryFeatures;
  weights: Float32Array;
}

/** Collect the summary layer (with its weight column) from each tile. */
function collectCellLayers(tiles: Tile[], summaryName: string, weightProp: string): {
  layers: CellLayer[];
  total: number;
} {
  const layers: CellLayer[] = [];
  let total = 0;
  for (const tile of tiles) {
    // Prefer the named summary layer; fall back to any layer that carries both
    // a u64 id column and the weight column (defensive against a tile whose
    // only layer is the raw tier on a zoom race).
    let chosen: BinaryFeatures | null = null;
    const named = tile.layers.find((l) => l.name === summaryName);
    if (named) chosen = named.features;
    else {
      for (const tl of tile.layers) {
        if (tl.features.featureIds64 && tl.features.numericProps[weightProp]) {
          chosen = tl.features;
          break;
        }
      }
    }
    if (!chosen || !chosen.featureCount || !chosen.featureIds64) continue;
    const weights = chosen.numericProps[weightProp];
    if (!weights) continue;
    layers.push({ binary: chosen, weights });
    total += chosen.featureCount;
  }
  return { layers, total };
}

export function buildQuadbinBuffers(
  tiles: Tile[],
  projection: Projection,
  opts: QuadbinBufferOptions = {},
): QuadbinBuffers {
  const weightProp = opts.weightProperty ?? 'count';
  const summaryName = opts.summaryLayerName ?? 'summary';
  const range = opts.colorRange ?? DEFAULT_QUADBIN_COLOR_RANGE;
  const coverage = Math.max(0, Math.min(1, opts.coverage ?? 1));
  const zLift = opts.zLift ?? 0;

  const { layers, total } = collectCellLayers(tiles, summaryName, weightProp);
  if (total === 0) return emptyBuffers();

  // Resolve color domain: pinned, else min/max of decodable cells' weights.
  let domain: [number, number];
  if (opts.colorDomain) {
    domain = opts.colorDomain;
  } else {
    let lo = Infinity;
    let hi = -Infinity;
    for (const { binary, weights } of layers) {
      for (let i = 0; i < binary.featureCount; i++) {
        if (!cellBoundsFromTile(binary.featureIds64, i)) continue;
        const w = weights[i];
        if (w < lo) lo = w;
        if (w > hi) hi = w;
      }
    }
    domain = [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 1];
  }

  // RTC origin = the first decodable cell's SW corner, projected.
  let origin: [number, number, number] | null = null;
  for (const { binary } of layers) {
    for (let i = 0; i < binary.featureCount; i++) {
      const b = cellBoundsFromTile(binary.featureIds64, i);
      if (!b) continue;
      origin = projection.project(b.west, b.south, zLift);
      break;
    }
    if (origin) break;
  }
  if (!origin) return emptyBuffers();
  const [ox, oy, oz] = origin;

  // Over-allocate to the feature total; trim to the actual decodable count.
  const positions = new Float32Array(total * 4 * 3);
  const colors = new Float32Array(total * 4 * 4);
  const indices = new Uint32Array(total * 6);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  let cell = 0; // emitted cell index
  for (const { binary, weights } of layers) {
    for (let i = 0; i < binary.featureCount; i++) {
      const b = cellBoundsFromTile(binary.featureIds64, i);
      if (!b) continue;

      // Apply coverage by shrinking the quad toward its lon/lat centroid.
      const cx = (b.west + b.east) / 2;
      const cy = (b.south + b.north) / 2;
      const hw = ((b.east - b.west) / 2) * coverage;
      const hh = ((b.north - b.south) / 2) * coverage;
      const w0 = cx - hw, e0 = cx + hw, s0 = cy - hh, n0 = cy + hh;

      // 4 corners CCW: SW, SE, NE, NW.
      const corners: [number, number][] = [
        [w0, s0],
        [e0, s0],
        [e0, n0],
        [w0, n0],
      ];
      const v0 = cell * 4;
      for (let c = 0; c < 4; c++) {
        const [lon, lat] = corners[c];
        const p = projection.project(lon, lat, zLift);
        const px = p[0] - ox, py = p[1] - oy, pz = p[2] - oz;
        const o3 = (v0 + c) * 3;
        positions[o3] = px;
        positions[o3 + 1] = py;
        positions[o3 + 2] = pz;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        if (pz > maxZ) maxZ = pz;
      }

      const rgba = rampBucketColor(weights[i], domain, range);
      const cr = rgba[0] / 255, cg = rgba[1] / 255, cb = rgba[2] / 255;
      const ca = (rgba[3] ?? 255) / 255;
      for (let c = 0; c < 4; c++) {
        const o4 = (v0 + c) * 4;
        colors[o4] = cr;
        colors[o4 + 1] = cg;
        colors[o4 + 2] = cb;
        colors[o4 + 3] = ca;
      }

      const t6 = cell * 6;
      indices[t6] = v0;
      indices[t6 + 1] = v0 + 1;
      indices[t6 + 2] = v0 + 2;
      indices[t6 + 3] = v0;
      indices[t6 + 4] = v0 + 2;
      indices[t6 + 5] = v0 + 3;

      cell++;
    }
  }

  if (cell === 0) return emptyBuffers();

  return {
    count: cell,
    positions: positions.subarray(0, cell * 4 * 3),
    colors: colors.subarray(0, cell * 4 * 4),
    indices: indices.subarray(0, cell * 6),
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}
