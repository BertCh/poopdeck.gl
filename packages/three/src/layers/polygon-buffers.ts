// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of merged polygon mesh buffers — the polygon
 * analogue of `point-buffers.ts` / `geo-line-buffers.ts`. This is the unit-tested
 * heart of {@link STTPolygonLayer}: it projects each feature's ring(s) under the
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
 *   walls are stitched from the feature's ring edges.
 *
 *   Which edges actually get a wall comes from the shared kernel
 *   `computePolygonWallMask`: it drops ring closures (so no wall bridges from a
 *   feature's exterior into its first hole) and — the visible one — the
 *   SYNTHETIC edges the tiler laid along tile boundaries when it clipped
 *   polygon coverage into per-tile pieces. Walling those raises a full-height
 *   curtain along every tile boundary a shape crosses, printing the tile grid
 *   through the surface. The abutting tile's piece continues the prism there.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { computePolygonWallMask } from '@poopdeck.gl/core/geometry';
import { InstanceProvenance, encodePickId } from '@poopdeck.gl/core/picking';
import earcut from 'earcut';
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  rampColorAt,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from '../lib/color.js';
import { featureTileKey } from '../lib/id-pick.js';

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
  /**
   * Numeric column feeding the GPU DataFilter (`sttFilterValue`, per VERTEX — a
   * feature's value written to every one of its mesh vertices). When set,
   * `filterValues` is emitted (0 where a tile lacks the column, deck's constant
   * fallback). @default null (no filter attribute)
   */
  filterProperty?: string | null;
  /**
   * Emit the per-vertex time-as-height LIFT direction (`sttLift`, vec3 = local
   * up ÷ metersPerWorldUnit — WORLD units per metre of altitude, a feature's
   * vector written to every one of its mesh vertices). When set, the
   * space-time-cube material raises each feature by its start time from a single
   * scale uniform. @default false (no lift attribute)
   */
  timeHeight?: boolean;
}

export interface PolygonBuffers {
  /** Number of mesh vertices written (indices reference these). */
  vertexCount: number;
  positions: Float32Array; // vec3, RTC-local
  colors: Float32Array; // vec4 0..1 (straight, NOT premultiplied)
  starts: Float32Array; // float, relative to timeOrigin (per vertex)
  ends: Float32Array; // float, relative to timeOrigin (per vertex)
  /** float, per-vertex DataFilter value; 0-length when no `filterProperty`. */
  filterValues: Float32Array;
  /**
   * vec3 time-as-height lift direction per vertex (local up ÷
   * metersPerWorldUnit = world units per metre of altitude); 0-length when no
   * `timeHeight`.
   */
  lift: Float32Array;
  /**
   * vec3 GPU pick id-colour, PER VERTEX. Because polygons render as ONE merged
   * (non-instanced) mesh, the per-instance id trick can't be used: every vertex
   * of a feature is painted the SAME colour, which encodes that feature's MERGED
   * feature index (its `provenance` slot). A GPU id-buffer readback therefore
   * decodes straight to the merged feature index a {@link resolveIdPick} joins
   * back to columns. Written in the same vertex loop as `filterValues`/`lift`.
   * Empty when `vertexCount === 0`.
   */
  idColors: Float32Array;
  indices: Uint32Array; // triangle index buffer
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-FEATURE provenance (the GPU picking-catalog identity buffer).
   * Merged feature `m` — the index a GPU id-buffer pick decodes from the shared
   * `idColors` — resolves via `provenance.resolve(m)` to its source
   * `(tileKey, featureIndex)`. Pushed once per EMITTED feature (rings < 3 verts
   * are skipped and never take a slot), in the EXACT order features are written,
   * so `idColors` and `provenance` stay aligned. Empty when `vertexCount === 0`.
   */
  provenance: InstanceProvenance;
  /**
   * `tileKey` → the source layer's {@link BinaryFeatures}, so a resolved
   * provenance entry can be joined back to columns via
   * `getFeatureProperties(binary, featureIndex)` and its representative vertex
   * looked up (`startIndices[featureIndex]`). Built from the SAME iteration (and
   * the same {@link featureTileKey}) as {@link provenance}, so keys align.
   */
  binaryByTileKey: Map<string, BinaryFeatures>;
}

function featureColor(
  b: BinaryFeatures,
  f: number,
  mode: PolygonColorMode,
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

function collectPolygonLayers(
  tiles: Tile[],
): Array<{ b: BinaryFeatures; tileKey: string; wallMask: Uint16Array | null }> {
  const out: Array<{
    b: BinaryFeatures;
    tileKey: string;
    wallMask: Uint16Array | null;
  }> = [];
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (
        !b.featureCount ||
        b.geometryType !== GeometryType.Polygon ||
        !b.startIndices
      )
        continue;
      out.push({
        b,
        tileKey: featureTileKey(tile.id, tl.name),
        // Which edges may grow a side wall. Computed per TILE (it depends on
        // the tile's own rect), so it is resolved here rather than inside the
        // merge loop, which has already forgotten which tile a layer came from.
        // `wrapLastEdge` matches this builder's `kn = (k + 1) % ringLen` wrap.
        wallMask: computePolygonWallMask(b, tile.id, { wrapLastEdge: true }),
      });
    }
  }
  return out;
}

export function buildPolygonBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: PolygonBufferOptions,
): PolygonBuffers {
  const layers = collectPolygonLayers(tiles);
  // Pick-identity buffers (always built, like the instanced builders' provenance):
  // one provenance slot per emitted feature; `idColors` painted per vertex.
  const provenance = new InstanceProvenance();
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const emptyBuf = (
    origin: [number, number, number] = [0, 0, 0],
  ): PolygonBuffers => ({
    vertexCount: 0,
    positions: new Float32Array(0),
    colors: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    filterValues: new Float32Array(0),
    lift: new Float32Array(0),
    idColors: new Float32Array(0),
    indices: new Uint32Array(0),
    origin,
    bbox: null,
    provenance,
    binaryByTileKey,
  });
  if (layers.length === 0) return emptyBuf();

  const zLift = opts.zLift ?? 0;
  const elevScale = opts.elevationScale ?? 1;
  const extruded = !!opts.extrusionProperty;
  const wantFilter = !!opts.filterProperty;
  const wantLift = !!opts.timeHeight;

  // RTC origin = first feature's first projected vertex (absolute world).
  const first = layers[0].b;
  const fdims = first.positionDimensions ?? 2;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    zLift,
  );
  const [ox, oy, oz] = origin;

  // Growable scratch arrays (final sizes depend on tessellation + extrusion).
  const positions: number[] = [];
  const colors: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const filterVals: number[] = [];
  const liftVals: number[] = [];
  const idColorVals: number[] = [];
  const indices: number[] = [];
  // Per-feature id colour (the merged-feature-index encode), refreshed once per
  // emitted feature and painted onto every one of that feature's mesh vertices.
  let idR = 0;
  let idG = 0;
  let idB = 0;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  const pushVertex = (
    x: number,
    y: number,
    z: number,
    col: RGBA,
    s: number,
    e: number,
    fv: number,
    lx: number,
    ly: number,
    lz: number,
  ): number => {
    const vi = positions.length / 3;
    positions.push(x, y, z);
    colors.push(
      col[0] / 255,
      col[1] / 255,
      col[2] / 255,
      (col[3] ?? 255) / 255,
    );
    starts.push(s);
    ends.push(e);
    if (wantFilter) filterVals.push(fv);
    // Per-feature-constant lift direction, written to every mesh vertex (base +
    // top) so the whole feature rises coherently by its time.
    if (wantLift) liftVals.push(lx, ly, lz);
    // Per-feature-constant GPU pick id colour (the merged-feature-index encode),
    // written to every mesh vertex so a readback on any of the feature's pixels
    // decodes to the same merged feature index. Set by the loop before pushing.
    idColorVals.push(idR, idG, idB);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
    return vi;
  };

  for (const { b, tileKey, wallMask } of layers) {
    binaryByTileKey.set(tileKey, b);
    const dims = b.positionDimensions ?? fdims;
    const rebase = b.timeOffset - timeOrigin;
    const extrudeCol = opts.extrusionProperty
      ? b.numericProps[opts.extrusionProperty]
      : undefined;
    const filterCol =
      wantFilter && opts.filterProperty
        ? b.numericProps[opts.filterProperty]
        : undefined;
    const hasPreBaked = !!b.triangles && !!b.triangleOffsets;

    for (let f = 0; f < b.featureCount; f++) {
      const v0 = b.startIndices![f];
      const v1 = b.startIndices![f + 1];
      const ringLen = v1 - v0;
      if (ringLen < 3) continue;

      // Take this feature's merged pick slot (the index a GPU id decodes) and
      // encode it once — every vertex pushed below carries this colour. Pushed
      // in emit order, so `provenance` and `idColors` stay aligned; skipped
      // (sub-triangle) features never take a slot.
      const mergedFeatureIndex = provenance.length;
      provenance.push(tileKey, f);
      const [ir, ig, ib] = encodePickId(mergedFeatureIndex);
      idR = ir / 255;
      idG = ig / 255;
      idB = ib / 255;

      const rgba = featureColor(b, f, opts.colorMode);
      const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      const fval = wantFilter && filterCol ? filterCol[f] : 0;

      // Time-as-height lift direction for this feature: local up scaled to WORLD
      // units per metre of altitude (÷ metersPerWorldUnit, the same metric→world
      // factor the extrusion uses). Reduces to +Z on the flat frames where
      // polygons render; per-vertex-constant, so the whole feature rises as one.
      let liftX = 0;
      let liftY = 0;
      let liftZ = 0;
      if (wantLift) {
        const lonRef = b.positions[v0 * dims];
        const latRef = b.positions[v0 * dims + 1];
        const wpm = 1 / (projection.metersPerWorldUnit(lonRef, latRef) || 1);
        const up = projection.localFrame(lonRef, latRef).up;
        liftX = up[0] * wpm;
        liftY = up[1] * wpm;
        liftZ = up[2] * wpm;
      }

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
        const gz =
          (dims > 2 ? b.positions[(v0 + k) * dims + 2] * elevScale : 0) + zLift;
        const p = projection.project(lon, lat, gz);
        projX[k] = p[0] - ox;
        projY[k] = p[1] - oy;
        projZ[k] = p[2] - oz;
      }

      // ── Base/cap vertices: one mesh vertex per ring vertex. ────────────────
      const baseVi: number[] = new Array(ringLen);
      for (let k = 0; k < ringLen; k++) {
        baseVi[k] = pushVertex(
          projX[k],
          projY[k],
          projZ[k],
          rgba,
          start,
          end,
          fval,
          liftX,
          liftY,
          liftZ,
        );
      }

      // Cap triangles.
      if (hasPreBaked) {
        // Pre-baked indices are GLOBAL (already shifted by startIndices[f]).
        // They reference vertices v0..v1 of THIS tile's positions, so subtract
        // v0 to land on baseVi[] and add this feature's mesh vertex base.
        const meshBase = baseVi[0];
        const t0 = b.triangleOffsets![f];
        const t1 = b.triangleOffsets![f + 1];
        for (let t = t0; t < t1; t++)
          indices.push(meshBase + (b.triangles![t] - v0));
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
          topVi[k] = pushVertex(
            projX[k],
            projY[k],
            projZ[k] + height,
            rgba,
            start,
            end,
            fval,
            liftX,
            liftY,
            liftZ,
          );
        }
        if (hasPreBaked) {
          const meshBase = topVi[0];
          const t0 = b.triangleOffsets![f];
          const t1 = b.triangleOffsets![f + 1];
          for (let t = t0; t < t1; t++)
            indices.push(meshBase + (b.triangles![t] - v0));
        } else {
          const flat = new Float64Array(ringLen * 2);
          for (let k = 0; k < ringLen; k++) {
            flat[k * 2] = projX[k];
            flat[k * 2 + 1] = projY[k];
          }
          const tri = earcut(flat, undefined, 2);
          for (let t = 0; t < tri.length; t++) indices.push(topVi[tri[t]]);
        }
        // Side walls: quad per ring edge (k → k+1, wrapping). Two triangles
        // each — skipping every edge the wall mask rejects (ring closures and
        // tile-boundary cuts; see the module docstring). Without a mask the
        // whole run walls, which is the pre-mask behaviour.
        for (let k = 0; k < ringLen; k++) {
          if (wallMask && wallMask[v0 + k] === 0) continue;
          const kn = (k + 1) % ringLen;
          const b0 = baseVi[k],
            b1 = baseVi[kn],
            t0v = topVi[k],
            t1v = topVi[kn];
          indices.push(b0, b1, t1v, b0, t1v, t0v);
        }
      }
    }
  }

  const vertexCount = positions.length / 3;
  if (vertexCount === 0) return emptyBuf(origin);

  return {
    vertexCount,
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    starts: new Float32Array(starts),
    ends: new Float32Array(ends),
    filterValues: wantFilter
      ? new Float32Array(filterVals)
      : new Float32Array(0),
    lift: wantLift ? new Float32Array(liftVals) : new Float32Array(0),
    idColors: new Float32Array(idColorVals),
    indices: new Uint32Array(indices),
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}

export type { RGBA };
