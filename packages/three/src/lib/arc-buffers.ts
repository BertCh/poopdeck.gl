// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of instanced **arc** buffers from decoded
 * LineString tiles — the OD-flow analogue of `geo-line-buffers.ts`, feeding
 * {@link createArcMaterial}. The Three port of deck's `AnimatedArcLayer`
 * (`STTArcLayer`): every feature collapses to its SOURCE (first vertex) / TARGET
 * (last vertex) endpoint, becoming ONE arc instance — a raised curve from
 * source to target that the GPU tessellates along `t ∈ [0,1]`.
 *
 * Unlike `geo-line-buffers.ts`, which pre-tessellates each polyline into screen
 * segments on the CPU, this builder only emits the two ENDPOINTS per instance;
 * the arc samples are generated in the vertex stage of {@link createArcMaterial}
 * over the instanced strip geometry. So the per-instance attributes are:
 *   • `sttPosSource` / `sttPosTarget` — vec3 RTC-local endpoints
 *   • `sttColorSource` / `sttColorTarget` — vec4 0..1 (gradient ends)
 *   • `sttStart` / `sttEnd` — float, relative to `timeOrigin` (window filter)
 *   • `sttHeight` — float, per-arc height multiplier (constant unless a column
 *     drives it; arc-height is normally a constant — see deck's `getHeight`).
 *
 * **RTC**: endpoints are written f32 RELATIVE to a per-build `origin` (the first
 * projected source endpoint); the layer sets `object.position = origin` so the
 * large mercator/globe magnitude lives in the f64 CPU transform, not the f32
 * buffer. For the ENU/AV frame the origin is tiny and this is a no-op. The arc
 * material reconstructs absolute positions on the globe by adding the origin
 * uniform back (great-circle slerp needs ~absolute direction vectors); on a
 * planar (mercator/ENU) frame the parabolic lift is done in RTC space directly.
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

/**
 * Per-endpoint colour spec — an arc gradients from its source colour to its
 * target colour. Each end is independently categorical / ramp / constant, so
 * `sourceColor` and `targetColor` can differ (deck's `getSourceColor` /
 * `getTargetColor`).
 */
export type ArcColorMode =
  | ({ type: 'categorical' } & CategoricalColorSpec)
  | ({ type: 'ramp' } & RampColorSpec)
  | { type: 'constant'; color: RGBA };

export interface ArcBufferOptions {
  /** Source-endpoint colour. @default constant [0,150,255,255]. */
  sourceColor?: ArcColorMode;
  /** Target-endpoint colour. @default constant [255,127,14,255]. */
  targetColor?: ArcColorMode;
  /**
   * Per-arc height multiplier — a property column name (numeric) drives a
   * per-feature height; otherwise every arc uses the constant {@link height}.
   * @default null (constant)
   */
  heightProperty?: string | null;
  /** Constant arc-height multiplier (deck's `getHeight`). @default 1 */
  height?: number;
  /** Altitude column (metres), per feature — lifts both endpoints. @default null */
  elevationProperty?: string | null;
  elevationScale?: number;
  /** Constant height lift (metres) on both endpoints. @default 0 */
  zLift?: number;
  /**
   * Numeric column feeding the GPU DataFilter (`sttFilterValue`, per arc). When
   * set, `filterValues` is emitted (0 where a tile lacks the column, deck's
   * constant fallback). @default null (no filter attribute)
   */
  filterProperty?: string | null;
  /**
   * GPU stable-palette path (deck `CategoryColorExtension`): when set, emit a
   * per-arc `categoryIndices` slot buffer for the palette-texture lookup — the
   * category LABEL is placed by `palette` (stable across tiles), NULL / missing →
   * the palette's null slot. The CPU-expanded `colorSource`/`colorTarget` still
   * ride along (the shader ignores them under the palette path). @default null
   */
  categoryIndex?: { property: string; palette: StablePalette } | null;
}

export interface ArcBuffers {
  count: number;
  posSource: Float32Array; // vec3, RTC-local
  posTarget: Float32Array; // vec3, RTC-local
  colorSource: Float32Array; // vec4 0..1
  colorTarget: Float32Array; // vec4 0..1
  starts: Float32Array; // float, relative to timeOrigin
  ends: Float32Array; // float, relative to timeOrigin
  heights: Float32Array; // float, per-arc height multiplier
  /** float, per-arc DataFilter value; 0-length when no `filterProperty`. */
  filterValues: Float32Array;
  /** float, per-arc stable palette slot; 0-length when no `categoryIndex`. */
  categoryIndices: Float32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-instance provenance (the GPU picking-catalog identity buffer).
   * Merged arc instance `i` — the same `i` a GPU id-buffer pick decodes —
   * resolves via `provenance.resolve(i)` to its source `(tileKey, featureIndex)`.
   * Populated in the EXACT order arcs are written (1 arc per LineString feature),
   * so index alignment with the geometry is guaranteed. Empty when `count === 0`.
   * See `point-buffers.ts` (the template).
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

const DEFAULT_SOURCE: RGBA = [0, 150, 255, 255];
const DEFAULT_TARGET: RGBA = [255, 127, 14, 255];

function featureColor(b: BinaryFeatures, f: number, mode: ArcColorMode): RGBA {
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

/** Collect LineString layers (with their tile key) + total arc (feature) count. */
function collectArcLayers(tiles: Tile[]): {
  parts: Array<{ b: BinaryFeatures; tileKey: string }>;
  arcCount: number;
} {
  const parts: Array<{ b: BinaryFeatures; tileKey: string }> = [];
  let arcCount = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (
        !b.featureCount ||
        b.geometryType !== GeometryType.LineString ||
        !b.startIndices
      )
        continue;
      parts.push({ b, tileKey: featureTileKey(tile.id, tl.name) });
      arcCount += b.featureCount;
    }
  }
  return { parts, arcCount };
}

/**
 * Build instanced arc endpoint buffers. Each feature collapses to its first
 * (source) and last (target) vertex — the OD-pair derivation of
 * `lib/od-positions.ts` — and one arc instance is emitted per feature.
 */
export function buildArcBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: ArcBufferOptions = {},
): ArcBuffers {
  const { parts, arcCount } = collectArcLayers(tiles);
  const provenance = new InstanceProvenance();
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const empty = (): ArcBuffers => ({
    count: 0,
    posSource: new Float32Array(0),
    posTarget: new Float32Array(0),
    colorSource: new Float32Array(0),
    colorTarget: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    heights: new Float32Array(0),
    filterValues: new Float32Array(0),
    categoryIndices: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
    provenance,
    binaryByTileKey,
  });
  if (arcCount === 0) return empty();

  const sourceMode: ArcColorMode = opts.sourceColor ?? {
    type: 'constant',
    color: DEFAULT_SOURCE,
  };
  const targetMode: ArcColorMode = opts.targetColor ?? {
    type: 'constant',
    color: DEFAULT_TARGET,
  };
  const zLift = opts.zLift ?? 0;
  const elevScale = opts.elevationScale ?? 1;
  const constHeight = opts.height ?? 1;

  // RTC origin = first feature's source (first) vertex, projected (absolute world).
  const first = parts[0].b;
  const fdims = first.positionDimensions ?? 2;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    zLift,
  );

  const posSource = new Float32Array(arcCount * 3);
  const posTarget = new Float32Array(arcCount * 3);
  const colorSource = new Float32Array(arcCount * 4);
  const colorTarget = new Float32Array(arcCount * 4);
  const starts = new Float32Array(arcCount);
  const ends = new Float32Array(arcCount);
  const heights = new Float32Array(arcCount);
  const wantFilter = !!opts.filterProperty;
  const filterValues = wantFilter
    ? new Float32Array(arcCount)
    : new Float32Array(0);
  const catIndex = opts.categoryIndex ?? null;
  const categoryIndices = catIndex
    ? new Float32Array(arcCount)
    : new Float32Array(0);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let a = 0; // arc instance index
  for (const part of parts) {
    const b = part.b;
    binaryByTileKey.set(part.tileKey, b);
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const heightCol = opts.heightProperty
      ? b.numericProps[opts.heightProperty]
      : undefined;
    const filterCol =
      wantFilter && opts.filterProperty
        ? b.numericProps[opts.filterProperty]
        : undefined;
    const rebase = b.timeOffset - timeOrigin;
    const si = b.startIndices!;
    for (let f = 0; f < b.featureCount; f++) {
      // Provenance MUST be pushed in the same order arcs are written (merged
      // index = a), so a decoded GPU id aligns with this feature.
      provenance.push(part.tileKey, f);
      const srcVertex = si[f];
      const tgtVertex = si[f + 1] - 1;
      const srcBase = srcVertex * dims;
      const tgtBase = tgtVertex * dims;

      const srcZ =
        (elev ? elev[f] * elevScale : dims > 2 ? b.positions[srcBase + 2] : 0) +
        zLift;
      const tgtZ =
        (elev ? elev[f] * elevScale : dims > 2 ? b.positions[tgtBase + 2] : 0) +
        zLift;
      const ps = projection.project(
        b.positions[srcBase],
        b.positions[srcBase + 1],
        srcZ,
      );
      const pt = projection.project(
        b.positions[tgtBase],
        b.positions[tgtBase + 1],
        tgtZ,
      );
      const sx = ps[0] - origin[0],
        sy = ps[1] - origin[1],
        sz = ps[2] - origin[2];
      const tx = pt[0] - origin[0],
        ty = pt[1] - origin[1],
        tz = pt[2] - origin[2];

      posSource[a * 3] = sx;
      posSource[a * 3 + 1] = sy;
      posSource[a * 3 + 2] = sz;
      posTarget[a * 3] = tx;
      posTarget[a * 3 + 1] = ty;
      posTarget[a * 3 + 2] = tz;

      const cs = featureColor(b, f, sourceMode);
      const ct = featureColor(b, f, targetMode);
      colorSource[a * 4] = cs[0] / 255;
      colorSource[a * 4 + 1] = cs[1] / 255;
      colorSource[a * 4 + 2] = cs[2] / 255;
      colorSource[a * 4 + 3] = (cs[3] ?? 255) / 255;
      colorTarget[a * 4] = ct[0] / 255;
      colorTarget[a * 4 + 1] = ct[1] / 255;
      colorTarget[a * 4 + 2] = ct[2] / 255;
      colorTarget[a * 4 + 3] = (ct[3] ?? 255) / 255;

      starts[a] = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      ends[a] = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      heights[a] = heightCol ? heightCol[f] : constHeight;
      if (wantFilter) filterValues[a] = filterCol ? filterCol[f] : 0;
      if (catIndex)
        categoryIndices[a] = featureCategorySlot(
          b,
          f,
          catIndex.property,
          catIndex.palette,
        );

      // bbox tracks both endpoints (the raised mid is bounded by their span).
      for (const [x, y, zz] of [
        [sx, sy, sz],
        [tx, ty, tz],
      ] as const) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (zz < minZ) minZ = zz;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (zz > maxZ) maxZ = zz;
      }
      a++;
    }
  }

  return {
    count: arcCount,
    posSource,
    posTarget,
    colorSource,
    colorTarget,
    starts,
    ends,
    heights,
    filterValues,
    categoryIndices,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}
