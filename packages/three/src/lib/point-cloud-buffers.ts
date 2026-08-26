// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free, GPU-free) assembly of merged POINT-CLOUD instance buffers —
 * the LIT-points analogue of `../layers/point-buffers.ts` (flat unlit
 * billboards) and the isotropic sibling of `../layers/surfel-buffers.ts`
 * (oriented anisotropic gaussians that need baked covariance columns). Feeds
 * {@link import('../tsl/point-cloud-material.js').createPointCloudMaterial}, the
 * Three port of deck's `AnimatedPointCloudLayer`: one lit 3D point per Point
 * feature, carrying a position, an OPTIONAL surface normal, and a colour.
 *
 * Per merged instance we bake:
 *   • `centers` vec3 world coords, RTC-relative to a shared `origin` (the layer
 *     writes `object.position = origin`). Under ENU/AV the origin is ~0 so the
 *     buffer is byte-identical to absolute; under mercator/globe it is what
 *     keeps the huge world magnitude in the f64 CPU transform instead of an f32
 *     attribute.
 *   • `normals` vec3 unit surface normal — ONLY when the lit-by-normal material
 *     variant is in play (see {@link PointCloudBuffers.hasNormals}).
 *   • `colors` vec4 0..1, resolved four ways (below).
 *   • `starts`/`ends` per-feature `[startTime,endTime]` rebased to `timeOrigin`.
 *
 * ── COLOUR (deck's four-way resolution, in priority order) ────────────────────
 *   1. {@link PointCloudBufferOptions.colorVectorColumn} — ONE interleaved
 *      `FixedSizeList<UInt8,4>` RGBA column (baked by
 *      `stt-build --vector-group`), read straight off the contiguous buffer.
 *      Wins over every other path whenever the tile carries it.
 *   2. `colorMode: {type:'rgb'}` — three numeric columns `[r,g,b]` (0–255).
 *   3. `colorMode: {type:'categorical'}` — a category column through the CPU
 *      palette / `colorMapping`.
 *   4. `colorMode: {type:'constant'}` — one colour for the whole cloud.
 *
 * Note what is ABSENT: there is no GPU stable-palette (`sttCategoryIndex` +
 * palette texture) path here, the one the icon/column kinds carry. That is
 * deliberate and matches deck, which refuses to install its
 * `CategoryColorExtension` on this kind: the extension replaces colour AFTER
 * lighting in the fragment stage, so categorical points would render flat and
 * unshaded — the whole point of a LIT cloud lost. Categorical colour therefore
 * rides the per-instance `sttColor` attribute (path 3) and gets multiplied by
 * the shading term like every other colour.
 *
 * ── NORMALS ──────────────────────────────────────────────────────────────────
 * `FixedSizeList<Float32,3>` vector column (deck's `normalColumn`, default
 * `'normal'`). A u8 leaf is IGNORED rather than rescaled — deck does the same,
 * because `instanceNormals` is a float attribute and no rescale convention
 * would make a u8 leaf valid. {@link PointCloudBuffers.hasNormals} is a
 * WHOLE-BUILD verdict, because it selects the material's node-graph variant:
 * with normals the shader lights the per-point normal, without them it lights a
 * sphere impostor normal derived from the billboard's own uv. A tile that lacks
 * the column inside a build that HAS normals gets deck's default `[0, 0, 1]` —
 * straight up in the ENU frame, i.e. uniform lighting — rather than dropping
 * out.
 *
 * That verdict is a per-BUILD property of the RESIDENT tiles, not of the
 * archive, and streaming makes the two differ: a mixed archive can have the
 * normal-carrying tiles evicted from view and the verdict flip back to false.
 * Flipping the material variant on that would dispose and rebuild the shader on
 * a tile arrival (audit E5), so the layer PINS the variant once it has seen
 * normals and passes {@link PointCloudBufferOptions.forceNormals} from then on;
 * this builder then emits the full, index-aligned buffer with defaults where a
 * tile carries no column. Without that the lit graph would declare `sttNormal`
 * over a geometry that binds none — an unbound attribute reads `(0,0,0)`, `N·L`
 * is 0, and the whole cloud silently collapses to the ambient floor.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { Projection } from '../projection/local-enu.js';
import {
  expandCategoricalColors,
  expandRgbColumns,
  type CategoricalColorSpec,
  type RGBA,
} from './color.js';
import { featureTileKey } from './id-pick.js';

/** deck's `getNormal` default: straight up in the ENU frame (uniform lighting). */
const DEFAULT_NORMAL: readonly [number, number, number] = [0, 0, 1];

/**
 * How a point's colour is resolved when the interleaved RGBA vector column
 * (which always wins) is absent — paths 2–4 of the four-way resolution.
 */
export type PointCloudColorMode =
  | { type: 'rgb'; columns: [string, string, string]; alpha?: number }
  | ({ type: 'categorical' } & CategoricalColorSpec)
  | { type: 'constant'; color: RGBA };

export interface PointCloudBufferOptions {
  /** Colour resolution for paths 2–4 (the vector column below outranks it). */
  colorMode: PointCloudColorMode;
  /**
   * Interleaved rgba(u8) vector column that, when present on a tile, takes
   * precedence over {@link colorMode} — the camera-colour path baked by
   * `stt-build --vector-group`. @default 'point_rgba'
   */
  colorVectorColumn?: string | null;
  /**
   * `FixedSizeList<Float32,3>` vector column holding each point's surface
   * normal `[nx,ny,nz]`. @default 'normal'
   */
  normalColumn?: string | null;
  /**
   * Emit a full, index-aligned normal buffer even when NO resident tile carries
   * {@link normalColumn}, filling deck's default `[0,0,1]` wherever the column
   * is missing. The layer sets it once it has committed the material to the
   * lit-by-normal variant: that node graph DECLARES `sttNormal`, and a geometry
   * that binds none feeds it `(0,0,0)` — `N·L` collapses to 0 and the whole
   * cloud drops to the ambient floor. @default false
   */
  forceNormals?: boolean;
  /** Altitude column (metres); null ⇒ take z from 3D tile geometry. */
  elevationProperty: string | null;
  elevationScale: number;
}

export interface PointCloudBuffers {
  count: number;
  centers: Float32Array; // vec3, RTC-local (relative to `origin`)
  /**
   * vec3 unit surface normals — length `count * 3` when {@link hasNormals},
   * otherwise ZERO-LENGTH (the material builds its impostor-normal variant and
   * binds no `sttNormal` attribute at all).
   */
  normals: Float32Array;
  /**
   * True when {@link normals} is POPULATED and index-aligned with every other
   * per-instance buffer — because a contributing tile-layer carried a usable
   * normal column, or because {@link PointCloudBufferOptions.forceNormals}
   * pinned the lit variant. False ⇒ {@link normals} is zero-LENGTH and the
   * layer must bind no `sttNormal` attribute.
   */
  hasNormals: boolean;
  colors: Float32Array; // vec4 0..1
  starts: Float32Array; // float relative to timeOrigin
  ends: Float32Array; // float relative to timeOrigin
  /**
   * RTC origin (absolute projected world coords). `centers` are written
   * RELATIVE to it; the layer sets `object.position = origin`.
   */
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-instance provenance (the GPU picking-catalog identity buffer).
   * Merged instance `i` — the same `i` a GPU id-buffer pick decodes — resolves
   * via `provenance.resolve(i)` to its source `(tileKey, featureIndex)`.
   * Populated in the EXACT order instances are written, so index alignment with
   * the geometry is guaranteed. Empty (never null) when `count === 0`.
   */
  provenance: InstanceProvenance;
  /**
   * `tileKey` → the source layer's {@link BinaryFeatures}, so a resolved
   * provenance entry joins back to columns via
   * `getFeatureProperties(binary, featureIndex)`. Built from the SAME iteration
   * (and the same {@link featureTileKey}) as {@link provenance}, so keys align.
   */
  binaryByTileKey: Map<string, BinaryFeatures>;
}

/**
 * The per-point normal buffer for one tile layer, or `null` when the tile
 * carries none. Only an f32 leaf of exactly 3 components qualifies (see the
 * module docstring for why a u8 leaf is refused rather than rescaled), and it
 * must be long enough for every feature — a short column is treated as absent
 * so the caller falls back to {@link DEFAULT_NORMAL} instead of reading past
 * the end.
 */
function normalsForTile(
  b: BinaryFeatures,
  column: string | null,
): Float32Array | null {
  if (!column) return null;
  const nv = b.vectorProps?.[column];
  if (!nv || nv.size !== 3) return null;
  if (!(nv.value instanceof Float32Array)) return null;
  return nv.value.length >= b.featureCount * 3 ? nv.value : null;
}

/** Packed 0..1 RGBA for one tile layer, resolving the four colour paths. */
function colorsForTile(
  b: BinaryFeatures,
  mode: PointCloudColorMode,
  colorVectorColumn: string | null,
): Float32Array {
  const count = b.featureCount;
  // (1) Interleaved camera-colour vector column wins whenever present.
  const cv = colorVectorColumn ? b.vectorProps?.[colorVectorColumn] : undefined;
  if (cv && cv.size === 4 && cv.value.length >= count * 4) {
    const out = new Float32Array(count * 4);
    const v = cv.value;
    for (let i = 0; i < count * 4; i++) out[i] = v[i] / 255;
    return out;
  }
  // (2) Three numeric RGB columns.
  if (mode.type === 'rgb') {
    return expandRgbColumns(b, mode.columns, mode.alpha ?? 1);
  }
  // (3) Categorical column through the CPU palette / colorMapping.
  if (mode.type === 'categorical') {
    return expandCategoricalColors(b, {
      property: mode.property,
      mapping: mode.mapping,
      fallback: mode.fallback,
    });
  }
  // (4) One constant colour for the whole cloud.
  const out = new Float32Array(count * 4);
  const [r, g, bl, a] = mode.color;
  for (let i = 0; i < count; i++) {
    out[i * 4] = r / 255;
    out[i * 4 + 1] = g / 255;
    out[i * 4 + 2] = bl / 255;
    out[i * 4 + 3] = (a ?? 255) / 255;
  }
  return out;
}

/**
 * Merge every Point-geometry tile layer into one set of lit point-cloud
 * instance buffers: projected + RTC-rebased centres, optional unit normals,
 * 0..1 RGBA, and `[start,end]` times rebased to the scene's common
 * `timeOrigin` (so a single shared material and one `currentTime` uniform drive
 * the whole cloud).
 *
 * Non-Point layers are silently SKIPPED (a mixed archive's lines/polygons are
 * another layer's business), and a build that merges nothing returns the
 * all-empty shape — never `null`: the layer branches on `count === 0`, and the
 * empty `provenance`/`binaryByTileKey` are what make a stale pick after a
 * reload resolve to `null` rather than to an old feature.
 */
export function buildPointCloudBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: PointCloudBufferOptions,
): PointCloudBuffers {
  const normalColumn =
    opts.normalColumn === undefined ? 'normal' : opts.normalColumn;
  const colorVectorColumn =
    opts.colorVectorColumn === undefined
      ? 'point_rgba'
      : opts.colorVectorColumn;

  const parts: Array<{
    features: BinaryFeatures;
    tileKey: string;
    normals: Float32Array | null;
  }> = [];
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  let total = 0;
  let anyNormals = false;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount) continue;
      if (b.geometryType !== GeometryType.Point) continue;
      const key = featureTileKey(tile.id, tl.name);
      const normals = normalsForTile(b, normalColumn);
      if (normals) anyNormals = true;
      parts.push({ features: b, tileKey: key, normals });
      binaryByTileKey.set(key, b);
      total += b.featureCount;
    }
  }

  const provenance = new InstanceProvenance();

  if (total === 0) {
    return {
      count: 0,
      centers: new Float32Array(0),
      normals: new Float32Array(0),
      hasNormals: false,
      colors: new Float32Array(0),
      starts: new Float32Array(0),
      ends: new Float32Array(0),
      origin: [0, 0, 0],
      bbox: null,
      provenance,
      binaryByTileKey,
    };
  }

  // RTC origin = first vertex of the first non-empty point layer, projected
  // (absolute world); every centre below is written relative to it.
  const firstLayer = parts[0].features;
  const firstDims = firstLayer.positionDimensions ?? 2;
  const firstElev = opts.elevationProperty
    ? firstLayer.numericProps[opts.elevationProperty]
    : undefined;
  const firstAlt = firstElev
    ? firstElev[0] * opts.elevationScale
    : firstDims > 2
      ? firstLayer.positions[2]
      : 0;
  const origin = projection.project(
    firstLayer.positions[0],
    firstLayer.positions[1],
    firstAlt,
  );

  const centers = new Float32Array(total * 3);
  // Allocated only for the lit-by-normal variant: with no normal column anywhere
  // AND no pinned variant the material never declares a `sttNormal` attribute,
  // so the buffer would be dead weight on every tile arrival.
  const emitNormals = anyNormals || opts.forceNormals === true;
  const normals = emitNormals
    ? new Float32Array(total * 3)
    : new Float32Array(0);
  const colors = new Float32Array(total * 4);
  const starts = new Float32Array(total);
  const ends = new Float32Array(total);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let o = 0;
  for (const part of parts) {
    const b = part.features;
    const count = b.featureCount;
    const dims = b.positionDimensions ?? 2;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const tileColors = colorsForTile(b, opts.colorMode, colorVectorColumn);
    const tileNormals = part.normals;
    const rebase = b.timeOffset - timeOrigin;

    for (let i = 0; i < count; i++) {
      // Provenance MUST be pushed in the same order instances are written
      // (merged index j = o + i), so `provenance.resolve(j)` aligns with the
      // GPU id decoded from that instance.
      provenance.push(part.tileKey, i);
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = elev
        ? elev[i] * opts.elevationScale
        : dims > 2
          ? b.positions[i * dims + 2]
          : 0;
      const p = projection.project(lon, lat, alt);
      const x = p[0] - origin[0];
      const y = p[1] - origin[1];
      const z = p[2] - origin[2];
      const j = o + i;
      centers[j * 3] = x;
      centers[j * 3 + 1] = y;
      centers[j * 3 + 2] = z;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;

      if (emitNormals) {
        if (tileNormals) {
          normals[j * 3] = tileNormals[i * 3];
          normals[j * 3 + 1] = tileNormals[i * 3 + 1];
          normals[j * 3 + 2] = tileNormals[i * 3 + 2];
        } else {
          // A normal-less tile inside a build that lights per-point normals:
          // deck's default `[0,0,1]`, so it shades uniformly instead of
          // dropping out (or, under `forceNormals`, instead of reading the
          // unbound-attribute zero that would black the whole cloud out).
          normals[j * 3] = DEFAULT_NORMAL[0];
          normals[j * 3 + 1] = DEFAULT_NORMAL[1];
          normals[j * 3 + 2] = DEFAULT_NORMAL[2];
        }
      }

      colors[j * 4] = tileColors[i * 4];
      colors[j * 4 + 1] = tileColors[i * 4 + 1];
      colors[j * 4 + 2] = tileColors[i * 4 + 2];
      colors[j * 4 + 3] = tileColors[i * 4 + 3];

      starts[j] = b.startTimes[i] + rebase;
      ends[j] = b.endTimes[i] + rebase;
    }
    o += count;
  }

  return {
    count: total,
    centers,
    normals,
    hasNormals: emitNormals,
    colors,
    starts,
    ends,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}
