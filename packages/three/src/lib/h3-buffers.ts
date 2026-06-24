// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of a merged, indexed hexagon mesh for the H3
 * summary tier — the geometry-side port of deck's `H3SummaryLayer`. Each summary
 * cell's u64 id (`featureIds64`) is decoded to its lon/lat boundary ring
 * ({@link cellBoundaryFromTile}), the ring vertices are projected (RTC, relative
 * to a shared `origin`), and the cell is coloured by a ramp over a numeric
 * `weightProperty` (default `'count'`) bucketed across `colorRange`.
 *
 * This is the unit-tested half; {@link H3SummaryLayer} is the thin GPU wrapper.
 * We bake a flat indexed `TRIANGLES` mesh (one triangle FAN per cell) rather
 * than instancing — cells are few (summary tiles are row-light) and a single
 * merged BufferGeometry is the simplest faithful render. An H3 boundary is 5
 * (pentagon), 6 (hexagon), or 7 (icosahedron-edge distorted) vertices, so each
 * cell contributes `N` verts and `N-2` triangles; the cell is convex so a fan
 * from vertex 0 tessellates it correctly. (The Quadbin port uses a fixed 4-vert
 * quad; H3 generalizes that to a variable-N ring.)
 *
 * **RTC**: positions are written f32 RELATIVE to a per-build `origin` (the first
 * decodable cell's first ring vertex, projected); the layer sets
 * `object.position = origin` so large mercator/globe magnitudes live in the f64
 * CPU transform. For the ENU/AV frame the origin is tiny and this is a no-op.
 *
 * Coverage shrinks each cell toward its lon/lat centroid (0..1), matching the
 * Quadbin builder. Coloring matches the deck `rampColor`: quantise
 * `(weight - lo)/(hi - lo)` into one of `colorRange.length` buckets (last bucket
 * for values ≥ hi) — shared with the Quadbin builder via {@link rampBucketColor}.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { cellBoundaryFromTile } from './h3-cell';
import { rampBucketColor } from './quadbin-buffers';
import type { Projection } from '../projection/local-enu';
import type { RGBA } from './color';

/** Default 6-stop low→high ramp (mirrors the deck H3 layer's DEFAULT_COLOR_RANGE). */
export const DEFAULT_H3_COLOR_RANGE: RGBA[] = [
  [255, 255, 204, 220],
  [199, 233, 180, 230],
  [127, 205, 187, 235],
  [65, 182, 196, 240],
  [44, 127, 184, 245],
  [37, 52, 148, 255],
];

export interface H3BufferOptions {
  /** Numeric column driving the color ramp. @default 'count' */
  weightProperty?: string;
  /** Low→high RGBA ramp (0-255). @default {@link DEFAULT_H3_COLOR_RANGE} */
  colorRange?: RGBA[];
  /**
   * `[min, max]` for the ramp. When null the visible cells' own min/max drive
   * it (computed across all tiles). @default null
   */
  colorDomain?: [number, number] | null;
  /** Per-cell coverage 0..1 — shrinks the hexagon toward its centroid. @default 1 */
  coverage?: number;
  /** Height above ground (metres) for the flat hexagon. @default 0 */
  zLift?: number;
  /** Name of the summary layer within each tile. @default 'summary' */
  summaryLayerName?: string;
}

export interface H3Buffers {
  /** Number of cells (hexagons) emitted. */
  count: number;
  /** vec3 world positions, f32, RTC-local (one per ring vertex). */
  positions: Float32Array;
  /** vec4 color 0..1 (one per ring vertex, the cell's color repeated). */
  colors: Float32Array;
  /** Uint32 triangle indices into `positions` (a fan per cell). */
  indices: Uint32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

function emptyBuffers(): H3Buffers {
  return {
    count: 0,
    positions: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
    origin: [0, 0, 0],
    bbox: null,
  };
}

interface CellLayer {
  binary: BinaryFeatures;
  weights: Float32Array;
}

/** Collect the summary layer (with its weight column) from each tile. */
function collectCellLayers(
  tiles: Tile[],
  summaryName: string,
  weightProp: string,
): { layers: CellLayer[]; total: number } {
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

/**
 * Apply `coverage` by shrinking a ring toward its lon/lat centroid (0..1). At
 * `coverage === 1` the ring is unchanged; lower values pull each vertex toward
 * the centroid, leaving a heatmap-style gap between adjacent cells.
 */
function shrinkRing(ring: [number, number][], coverage: number): [number, number][] {
  if (coverage >= 1) return ring;
  let cx = 0;
  let cy = 0;
  for (const [lon, lat] of ring) {
    cx += lon;
    cy += lat;
  }
  cx /= ring.length;
  cy /= ring.length;
  return ring.map(([lon, lat]) => [cx + (lon - cx) * coverage, cy + (lat - cy) * coverage]);
}

export function buildH3Buffers(
  tiles: Tile[],
  projection: Projection,
  opts: H3BufferOptions = {},
): H3Buffers {
  const weightProp = opts.weightProperty ?? 'count';
  const summaryName = opts.summaryLayerName ?? 'summary';
  const range = opts.colorRange ?? DEFAULT_H3_COLOR_RANGE;
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
        if (!cellBoundaryFromTile(binary.featureIds64, i)) continue;
        const w = weights[i];
        if (w < lo) lo = w;
        if (w > hi) hi = w;
      }
    }
    domain = [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 1];
  }

  // RTC origin = the first decodable cell's first ring vertex, projected.
  let origin: [number, number, number] | null = null;
  for (const { binary } of layers) {
    for (let i = 0; i < binary.featureCount; i++) {
      const b = cellBoundaryFromTile(binary.featureIds64, i);
      if (!b) continue;
      const [lon, lat] = b.ring[0];
      origin = projection.project(lon, lat, zLift);
      break;
    }
    if (origin) break;
  }
  if (!origin) return emptyBuffers();
  const [ox, oy, oz] = origin;

  // Cells have a variable vertex count (5/6/7). Over-allocate to the worst case
  // (7 verts + 5 triangles per cell) and trim to the actual emitted counts.
  const MAX_RING = 7;
  const positions = new Float32Array(total * MAX_RING * 3);
  const colors = new Float32Array(total * MAX_RING * 4);
  const indices = new Uint32Array(total * (MAX_RING - 2) * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  let cell = 0; // emitted cell count
  let vBase = 0; // running vertex offset into positions/colors
  let iPos = 0; // running write offset into indices
  for (const { binary, weights } of layers) {
    for (let i = 0; i < binary.featureCount; i++) {
      const b = cellBoundaryFromTile(binary.featureIds64, i);
      if (!b) continue;
      const ring = shrinkRing(b.ring, coverage);
      const n = ring.length;

      for (let c = 0; c < n; c++) {
        const [lon, lat] = ring[c];
        const p = projection.project(lon, lat, zLift);
        const px = p[0] - ox, py = p[1] - oy, pz = p[2] - oz;
        const o3 = (vBase + c) * 3;
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
      for (let c = 0; c < n; c++) {
        const o4 = (vBase + c) * 4;
        colors[o4] = cr;
        colors[o4 + 1] = cg;
        colors[o4 + 2] = cb;
        colors[o4 + 3] = ca;
      }

      // Triangle FAN from vertex 0: (0,1,2), (0,2,3), … (0,n-2,n-1).
      for (let c = 1; c < n - 1; c++) {
        indices[iPos++] = vBase;
        indices[iPos++] = vBase + c;
        indices[iPos++] = vBase + c + 1;
      }

      vBase += n;
      cell++;
    }
  }

  if (cell === 0) return emptyBuffers();

  return {
    count: cell,
    positions: positions.subarray(0, vBase * 3),
    colors: colors.subarray(0, vBase * 4),
    indices: indices.subarray(0, iPos),
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}
