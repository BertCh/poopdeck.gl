// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of merged polygon mesh buffers — the polygon
 * analogue of `point-buffers.ts` / `geo-line-buffers.ts`. This is the unit-tested
 * heart of {@link PolygonLayer}: it projects each feature's ring(s) under the
 * active {@link Projection}, tessellates them into triangles, and emits a single
 * indexed mesh (position / color / per-vertex start+end time) for one shared
 * material + a window time-filter.
 *
 * ── TESSELLATION (the correctness core) ──────────────────────────────────────
 *   1. **Honour pre-baked triangles.** When a tile carries `triangles` +
 *      `triangleOffsets` (the columnar.rs `--pre-tessellate` path, which already
 *      split multi-ring polygons / holes correctly), we use them verbatim — no
 *      earcut. This is the ONLY path that gets holes / multipolygons right,
 *      because `BinaryFeatures.startIndices` is feature-level and does NOT carry
 *      ring boundaries (see core/tile.ts: "Ring boundaries inside a feature are
 *      not preserved").
 *   2. **Earcut in PROJECTED space.** When no pre-baked triangles exist, earcut
 *      the feature's single ring — but on the **projected planar (x,y)** vertices,
 *      not raw lon/lat. Earcutting raw lon/lat is only correct for an
 *      equirectangular frame; under mercator/globe the planar shape differs and
 *      raw-lon/lat triangulation produces spanning triangles. We earcut the
 *      already-projected (RTC-local) x/y, which is the actual render geometry.
 *
 * ── RTC ──────────────────────────────────────────────────────────────────────
 *   Geographic world coords are huge (~5e7 mercator / 6.4e6 globe) and overflow
 *   f32. Positions are written f32 RELATIVE to a per-build `origin` (the first
 *   feature's first projected vertex); the layer parents the geometry under an
 *   `Object3D` whose `.position = origin`. For the ENU/AV frame origin ≈ 0 so
 *   this is a no-op and AV output stays byte-identical to the old static path.
 *
 * ── EXTRUSION ─────────────────────────────────────────────────────────────────
 *   When `extrusionProperty` is set, each feature is raised to a prism of height
 *   `value · elevationScale · (1/metersPerWorldUnit)` (so a metric height reads
 *   true at any latitude): the flat cap is duplicated at base+top and the side
 *   walls are stitched from the feature's ring edges. The base ring is the
 *   feature's full vertex run (no per-ring split — same single-ring caveat as the
 *   earcut fallback for the walls).
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import earcut from 'earcut';
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  rampColorAt,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from '../lib/color.js';

export type PolygonColorMode =
  | ({ type: 'categorical' } & CategoricalColorSpec)
  | ({ type: 'ramp' } & RampColorSpec)
  | { type: 'constant'; color: RGBA };

export interface PolygonBufferOptions {
  colorMode: PolygonColorMode;
  /** Constant height lift (metres) — keeps flat decals off the basemap. @default 0 */
  zLift?: number;
  /**
   * Numeric column giving each feature an extruded prism height (metres). When
   * set (and a feature has the column) the polygon becomes a 3D prism.
   * @default null (flat)
   */
  extrusionProperty?: string | null;
  /** Multiplier applied to the extrusion height (and any geometry z). @default 1 */
  elevationScale?: number;
}

export interface PolygonBuffers {
  /** Number of mesh vertices written (indices reference these). */
  vertexCount: number;
  positions: Float32Array; // vec3, RTC-local
  colors: Float32Array; // vec4 0..1 (straight, NOT premultiplied)
  starts: Float32Array; // float, relative to timeOrigin (per vertex)
  ends: Float32Array; // float, relative to timeOrigin (per vertex)
  indices: Uint32Array; // triangle index buffer
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

function featureColor(b: BinaryFeatures, f: number, mode: PolygonColorMode): RGBA {
  if (mode.type === 'constant') return mode.color;
  if (mode.type === 'ramp') {
    const col = b.numericProps[mode.property];
    return col ? rampColorAt(col[f], mode.domain, mode.range) : mode.fallback;
  }
  const cat = b.categoricalProps[mode.property];
  const label = cat && cat.indices[f] !== 0xffff ? cat.categories[cat.indices[f]] : undefined;
  return resolveCategoryColor(label, mode.mapping, mode.fallback);
}

function collectPolygonLayers(tiles: Tile[]): BinaryFeatures[] {
  const out: BinaryFeatures[] = [];
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount || b.geometryType !== GeometryType.Polygon || !b.startIndices) continue;
      out.push(b);
    }
  }
  return out;
}

const EMPTY: PolygonBuffers = {
  vertexCount: 0,
  positions: new Float32Array(0),
  colors: new Float32Array(0),
  starts: new Float32Array(0),
  ends: new Float32Array(0),
  indices: new Uint32Array(0),
  origin: [0, 0, 0],
  bbox: null,
};

export function buildPolygonBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: PolygonBufferOptions,
): PolygonBuffers {
  const layers = collectPolygonLayers(tiles);
  if (layers.length === 0) return { ...EMPTY };

  const zLift = opts.zLift ?? 0;
  const elevScale = opts.elevationScale ?? 1;
  const extruded = !!opts.extrusionProperty;

  // RTC origin = first feature's first projected vertex (absolute world).
  const first = layers[0];
  const fdims = first.positionDimensions ?? 2;
  const origin = projection.project(first.positions[0], first.positions[1], zLift);
  const [ox, oy, oz] = origin;

  // Growable scratch arrays (final sizes depend on tessellation + extrusion).
  const positions: number[] = [];
  const colors: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const indices: number[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const pushVertex = (x: number, y: number, z: number, col: RGBA, s: number, e: number): number => {
    const vi = positions.length / 3;
    positions.push(x, y, z);
    colors.push(col[0] / 255, col[1] / 255, col[2] / 255, (col[3] ?? 255) / 255);
    starts.push(s);
    ends.push(e);
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    return vi;
  };

  for (const b of layers) {
    const dims = b.positionDimensions ?? fdims;
    const rebase = b.timeOffset - timeOrigin;
    const extrudeCol = opts.extrusionProperty ? b.numericProps[opts.extrusionProperty] : undefined;
    const hasPreBaked = !!b.triangles && !!b.triangleOffsets;

    for (let f = 0; f < b.featureCount; f++) {
      const v0 = b.startIndices![f];
      const v1 = b.startIndices![f + 1];
      const ringLen = v1 - v0;
      if (ringLen < 3) continue;

      const rgba = featureColor(b, f, opts.colorMode);
      const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;

      // metric extrusion height in WORLD units at this feature's location.
      let height = 0;
      if (extruded && extrudeCol) {
        const lonRef = b.positions[v0 * dims];
        const latRef = b.positions[v0 * dims + 1];
        const mpwu = projection.metersPerWorldUnit(lonRef, latRef) || 1;
        height = (extrudeCol[f] * elevScale) / mpwu;
      }

      // Project this feature's ring once into RTC-local space. We keep the
      // projected planar (x,y) so earcut runs in the real render frame.
      const projX = new Float64Array(ringLen);
      const projY = new Float64Array(ringLen);
      const projZ = new Float64Array(ringLen);
      for (let k = 0; k < ringLen; k++) {
        const lon = b.positions[(v0 + k) * dims];
        const lat = b.positions[(v0 + k) * dims + 1];
        const gz = (dims > 2 ? b.positions[(v0 + k) * dims + 2] * elevScale : 0) + zLift;
        const p = projection.project(lon, lat, gz);
        projX[k] = p[0] - ox;
        projY[k] = p[1] - oy;
        projZ[k] = p[2] - oz;
      }

      // ── Base/cap vertices: one mesh vertex per ring vertex. ────────────────
      const baseVi: number[] = new Array(ringLen);
      for (let k = 0; k < ringLen; k++) {
        baseVi[k] = pushVertex(projX[k], projY[k], projZ[k], rgba, start, end);
      }

      // Cap triangles.
      if (hasPreBaked) {
        // Pre-baked indices are GLOBAL (already shifted by startIndices[f]).
        // They reference vertices v0..v1 of THIS tile's positions, so subtract
        // v0 to land on baseVi[] and add this feature's mesh vertex base.
        const meshBase = baseVi[0];
        const t0 = b.triangleOffsets![f];
        const t1 = b.triangleOffsets![f + 1];
        for (let t = t0; t < t1; t++) indices.push(meshBase + (b.triangles![t] - v0));
      } else {
        // Earcut in PROJECTED planar space (single ring — no hole info in
        // BinaryFeatures; pre-baked triangles are the holes-correct path).
        const flat = new Float64Array(ringLen * 2);
        for (let k = 0; k < ringLen; k++) {
          flat[k * 2] = projX[k];
          flat[k * 2 + 1] = projY[k];
        }
        const tri = earcut(flat, undefined, 2);
        for (let t = 0; t < tri.length; t++) indices.push(baseVi[tri[t]]);
      }

      // ── Extrusion: top cap + side walls. ───────────────────────────────────
      if (extruded && height !== 0) {
        // Top cap = base ring lifted by `height`, re-triangulated the same way.
        const topVi: number[] = new Array(ringLen);
        for (let k = 0; k < ringLen; k++) {
          topVi[k] = pushVertex(projX[k], projY[k], projZ[k] + height, rgba, start, end);
        }
        if (hasPreBaked) {
          const meshBase = topVi[0];
          const t0 = b.triangleOffsets![f];
          const t1 = b.triangleOffsets![f + 1];
          for (let t = t0; t < t1; t++) indices.push(meshBase + (b.triangles![t] - v0));
        } else {
          const flat = new Float64Array(ringLen * 2);
          for (let k = 0; k < ringLen; k++) {
            flat[k * 2] = projX[k];
            flat[k * 2 + 1] = projY[k];
          }
          const tri = earcut(flat, undefined, 2);
          for (let t = 0; t < tri.length; t++) indices.push(topVi[tri[t]]);
        }
        // Side walls: quad per ring edge (k → k+1, wrapping). Two triangles each.
        for (let k = 0; k < ringLen; k++) {
          const kn = (k + 1) % ringLen;
          const b0 = baseVi[k], b1 = baseVi[kn], t0v = topVi[k], t1v = topVi[kn];
          indices.push(b0, b1, t1v, b0, t1v, t0v);
        }
      }
    }
  }

  const vertexCount = positions.length / 3;
  if (vertexCount === 0) return { ...EMPTY, origin };

  return {
    vertexCount,
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    starts: new Float32Array(starts),
    ends: new Float32Array(ends),
    indices: new Uint32Array(indices),
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

export type { RGBA };
