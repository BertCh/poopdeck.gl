// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of instanced wide-line **segment** buffers from
 * decoded LineString tiles — the line analogue of `point-buffers.ts`, feeding
 * {@link createWideLineMaterial}. Each consecutive vertex pair of every feature
 * becomes one segment instance (`posA`/`posB`), coloured per-feature (categorical
 * / ramp / constant) and time-windowed by the feature's `[start,end]`.
 *
 * **RTC**: positions are written f32 RELATIVE to a per-build `origin` (the first
 * projected vertex); the layer sets `object.position = origin` so the large
 * mercator/globe magnitude lives in the f64 CPU transform, not the f32 buffer.
 * For the ENU/AV frame the origin is tiny and this is a no-op.
 *
 * Per-vertex *trail* times (deck `AnimatedTripsLayer`) are NOT synthesized here —
 * `timeA`/`timeB` default to the feature start; a trips builder that knows the
 * vertex-time encoding overrides them. Window-mode layers (Path, OD-Line, map
 * lines, FlowCorridor base) need only `[start,end]`.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { synthesizeVertexTimes } from '@poopdeck.gl/core/trips';
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

export type LineColorMode =
  | ({ type: 'categorical' } & CategoricalColorSpec)
  | ({ type: 'ramp' } & RampColorSpec)
  | { type: 'constant'; color: RGBA };

export interface LineSegmentBufferOptions {
  colorMode: LineColorMode;
  /** Altitude column (metres), per feature. @default null (use geometry z) */
  elevationProperty?: string | null;
  elevationScale?: number;
  /** Constant height lift (metres) — keeps ground decals off the basemap. @default 0 */
  zLift?: number;
  /**
   * Numeric column feeding the GPU DataFilter (`sttFilterValue`, per segment —
   * a feature's value repeated to each of its segments). When set,
   * `filterValues` is emitted (0 where a tile lacks the column, deck's constant
   * fallback). @default null (no filter attribute)
   */
  filterProperty?: string | null;
  /**
   * Progressive-reveal (deck `revealTrail`) source times. When `true`, `timeA`/
   * `timeB` carry PER-VERTEX times — the tile's own `vertexTimestamps` when
   * present (zero-copy), else synthesized by distributing each feature's
   * `[startTime,endTime]` span across its vertices by cumulative haversine
   * distance (`@poopdeck.gl/core/trips`, the same scheme as `buildTripsBuffers`
   * and deck's `synthesizeVertexTimes`) — so the path layer's reveal material can
   * ink a timeless line in ALONG its length over its span. When `false` (default),
   * `timeA`/`timeB` stay at the feature `[start,end]` (byte-identical window-mode
   * output; no synthesis cost), the value the Path/OD-Line window gate ignores.
   * @default false
   */
  revealTimes?: boolean;
  /**
   * GPU stable-palette path (deck `CategoryColorExtension`): when set, emit a
   * per-segment `categoryIndices` slot buffer for the palette-texture lookup — the
   * category LABEL of the segment's parent feature is placed by `palette` (stable
   * across tiles; every segment of a feature shares its slot), NULL / missing →
   * the palette's null slot. The CPU-expanded `colorA`/`colorB` still ride along
   * (the shader ignores them under the palette path). @default null
   */
  categoryIndex?: { property: string; palette: StablePalette } | null;
}

export interface LineSegmentBuffers {
  count: number;
  posA: Float32Array; // vec3, RTC-local
  posB: Float32Array; // vec3, RTC-local
  colorA: Float32Array; // vec4 0..1
  colorB: Float32Array; // vec4 0..1
  starts: Float32Array; // float, relative to timeOrigin
  ends: Float32Array; // float, relative to timeOrigin
  timeA: Float32Array; // float, relative (per-vertex trail time; defaults to start)
  timeB: Float32Array;
  /** float, per-segment DataFilter value; 0-length when no `filterProperty`. */
  filterValues: Float32Array;
  /** float, per-segment stable palette slot; 0-length when no `categoryIndex`. */
  categoryIndices: Float32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-instance provenance (the GPU picking-catalog identity buffer).
   * Merged segment instance `i` — the same `i` a GPU id-buffer pick decodes —
   * resolves via `provenance.resolve(i)` to its source `(tileKey, featureIndex)`.
   * A multi-vertex feature emits several segment instances that ALL point at the
   * same `featureIndex`, so a pick on any segment resolves to the parent feature.
   * Populated in the EXACT order segments are written, so index alignment with the
   * geometry is guaranteed. Empty when `count === 0`. See `point-buffers.ts`.
   */
  provenance: InstanceProvenance;
  /**
   * `tileKey` → the source layer's {@link BinaryFeatures}, so a resolved
   * provenance entry can be joined back to features via
   * `getFeatureProperties(binary, featureIndex)` (and the pick coordinate read
   * from `startIndices[featureIndex]`, the feature's first vertex). Built from the
   * SAME iteration (and the same {@link featureTileKey}) as {@link provenance}.
   */
  binaryByTileKey: Map<string, BinaryFeatures>;
}

function featureColor(b: BinaryFeatures, f: number, mode: LineColorMode): RGBA {
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

function collectLineLayers(tiles: Tile[]): {
  parts: Array<{ b: BinaryFeatures; tileKey: string }>;
  segCount: number;
} {
  const parts: Array<{ b: BinaryFeatures; tileKey: string }> = [];
  let segCount = 0;
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
      for (let f = 0; f < b.featureCount; f++) {
        segCount += Math.max(0, b.startIndices[f + 1] - b.startIndices[f] - 1);
      }
    }
  }
  return { parts, segCount };
}

export function buildLineSegmentBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: LineSegmentBufferOptions,
): LineSegmentBuffers {
  const { parts, segCount } = collectLineLayers(tiles);
  const provenance = new InstanceProvenance();
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const empty = (): LineSegmentBuffers => ({
    count: 0,
    posA: new Float32Array(0),
    posB: new Float32Array(0),
    colorA: new Float32Array(0),
    colorB: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    timeA: new Float32Array(0),
    timeB: new Float32Array(0),
    filterValues: new Float32Array(0),
    categoryIndices: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
    provenance,
    binaryByTileKey,
  });
  if (segCount === 0) return empty();

  const zLift = opts.zLift ?? 0;
  const elevScale = opts.elevationScale ?? 1;
  const wantFilter = !!opts.filterProperty;
  const revealTimes = !!opts.revealTimes;
  const catIndex = opts.categoryIndex ?? null;

  // RTC origin = first vertex of the first feature, projected (absolute world).
  const first = parts[0].b;
  const fdims = first.positionDimensions ?? 2;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    zLift,
  );

  const posA = new Float32Array(segCount * 3);
  const posB = new Float32Array(segCount * 3);
  const colorA = new Float32Array(segCount * 4);
  const colorB = new Float32Array(segCount * 4);
  const starts = new Float32Array(segCount);
  const ends = new Float32Array(segCount);
  const timeA = new Float32Array(segCount);
  const timeB = new Float32Array(segCount);
  const filterValues = wantFilter
    ? new Float32Array(segCount)
    : new Float32Array(0);
  const categoryIndices = catIndex
    ? new Float32Array(segCount)
    : new Float32Array(0);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let s = 0; // segment index
  for (const part of parts) {
    const b = part.b;
    binaryByTileKey.set(part.tileKey, b);
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const filterCol =
      wantFilter && opts.filterProperty
        ? b.numericProps[opts.filterProperty]
        : undefined;
    const rebase = b.timeOffset - timeOrigin;
    // Progressive reveal (deck revealTrail): per-vertex times, preferring the
    // tile's own `vertexTimestamps` (zero-copy) else synthesized by cumulative
    // haversine distance across each feature's [start,end] span — mirrors
    // buildTripsBuffers. Only computed when opted in, so window-mode builds pay
    // nothing and stay byte-identical.
    const startIndices = b.startIndices!;
    const vertexTimes: Float32Array | null = revealTimes
      ? b.vertexTimestamps &&
        b.vertexTimestamps.length >= startIndices[b.featureCount]
        ? b.vertexTimestamps
        : synthesizeVertexTimes(b)
      : null;
    for (let f = 0; f < b.featureCount; f++) {
      const rgba = featureColor(b, f, opts.colorMode);
      const cr = rgba[0] / 255,
        cg = rgba[1] / 255,
        cb = rgba[2] / 255,
        ca = (rgba[3] ?? 255) / 255;
      const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      const fval = wantFilter && filterCol ? filterCol[f] : 0;
      // Per-feature stable palette slot (shared by every segment of the feature).
      const catSlot = catIndex
        ? featureCategorySlot(b, f, catIndex.property, catIndex.palette)
        : 0;
      const baseZ = elev ? elev[f] * elevScale : null;
      const v0 = b.startIndices![f];
      const v1 = b.startIndices![f + 1];
      for (let v = v0; v < v1 - 1; v++) {
        // One provenance entry per SEGMENT instance (merged index = s), all of a
        // feature's segments pointing at the same `featureIndex` f, so a pick on
        // any segment resolves to the parent feature. Pushed in draw order.
        provenance.push(part.tileKey, f);
        const z0 =
          (baseZ ?? (dims > 2 ? b.positions[v * dims + 2] : 0)) + zLift;
        const z1 =
          (baseZ ?? (dims > 2 ? b.positions[(v + 1) * dims + 2] : 0)) + zLift;
        const a = projection.project(
          b.positions[v * dims],
          b.positions[v * dims + 1],
          z0,
        );
        const c = projection.project(
          b.positions[(v + 1) * dims],
          b.positions[(v + 1) * dims + 1],
          z1,
        );
        const ax = a[0] - origin[0],
          ay = a[1] - origin[1],
          az = a[2] - origin[2];
        const bx = c[0] - origin[0],
          by = c[1] - origin[1],
          bz = c[2] - origin[2];
        posA[s * 3] = ax;
        posA[s * 3 + 1] = ay;
        posA[s * 3 + 2] = az;
        posB[s * 3] = bx;
        posB[s * 3 + 1] = by;
        posB[s * 3 + 2] = bz;
        colorA[s * 4] = cr;
        colorA[s * 4 + 1] = cg;
        colorA[s * 4 + 2] = cb;
        colorA[s * 4 + 3] = ca;
        colorB[s * 4] = cr;
        colorB[s * 4 + 1] = cg;
        colorB[s * 4 + 2] = cb;
        colorB[s * 4 + 3] = ca;
        starts[s] = start;
        ends[s] = end;
        // Window mode ignores timeA/timeB; reveal mode reads them as the
        // per-vertex reveal times (rebased onto the global playhead like start/end).
        if (vertexTimes) {
          timeA[s] = vertexTimes[v] + rebase;
          timeB[s] = vertexTimes[v + 1] + rebase;
        } else {
          timeA[s] = start;
          timeB[s] = end;
        }
        if (wantFilter) filterValues[s] = fval;
        if (catIndex) categoryIndices[s] = catSlot;
        for (const [x, y, zz] of [
          [ax, ay, az],
          [bx, by, bz],
        ] as const) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (zz < minZ) minZ = zz;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (zz > maxZ) maxZ = zz;
        }
        s++;
      }
    }
  }

  return {
    count: segCount,
    posA,
    posB,
    colorA,
    colorB,
    starts,
    ends,
    timeA,
    timeB,
    filterValues,
    categoryIndices,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}
