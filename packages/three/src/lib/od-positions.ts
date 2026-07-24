// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Origin→destination (source/target) endpoint derivation + OD segment buffers,
 * the Three port of the deck `@poopdeck.gl/layers` `od-positions.ts` helper that
 * feeds `AnimatedLineLayer` / `AnimatedArcLayer`.
 *
 * STT tiles store OD flows as LineString features — a feature is a run of
 * vertices in the tile's interleaved `positions` buffer, addressed by
 * `startIndices`. An OD line/arc, however, has only TWO ends: each feature
 * collapses to its FIRST vertex (source) and LAST vertex (target). Intermediate
 * vertices of a multi-vertex polyline are dropped.
 *
 * Two surfaces:
 *  - {@link deriveSourceTargetPositions}: dense Float64Array source/target
 *    endpoint buffers (the faithful port of the deck helper — kept for any
 *    instanced source→target consumer / parity tests), and
 *  - {@link buildOdLineSegmentBuffers}: collapses each feature to ONE
 *    source→target segment and emits the EXACT {@link LineSegmentBuffers} shape
 *    so the OD-line layer rides the shared {@link createWideLineMaterial} ribbon
 *    (one quad instance per OD pair) — the GPU path the `WideLineLayer` already
 *    uses. RTC-relative like {@link buildLineSegmentBuffers}, so the layer sets
 *    `object.position = origin`.
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
import { featureCategorySlot } from './palette.js';
import { featureTileKey } from './id-pick.js';
import type {
  LineColorMode,
  LineSegmentBufferOptions,
  LineSegmentBuffers,
} from './geo-line-buffers.js';

// Dense source/target endpoint derivation now lives in the framework-free
// `@poopdeck.gl/core/geometry` kernel (Phase 2 dedup — byte-identical port,
// see docs/roadmap/renderer-architecture.md). Re-exported here so OD
// consumers keep a single three-side import surface.
export {
  deriveSourceTargetPositions,
  type SourceTargetPositions,
} from '@poopdeck.gl/core/geometry';

// Re-export the line color/option types so OD consumers pull a single surface.
export type { LineColorMode, LineSegmentBufferOptions, LineSegmentBuffers };

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

function collectOdLayers(tiles: Tile[]): {
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
      // One OD segment per feature (source→target endpoints).
      segCount += b.featureCount;
    }
  }
  return { parts, segCount };
}

/**
 * Build instanced wide-line **segment** buffers for OD flows: each LineString
 * feature collapses to ONE segment from its FIRST vertex (source) to its LAST
 * vertex (target). Output is the EXACT {@link LineSegmentBuffers} shape consumed
 * by the wide-line ribbon, so the OD-line layer reuses {@link
 * createWideLineMaterial} with no new GPU code.
 *
 * RTC: positions are written f32 RELATIVE to a per-build `origin` (the first
 * feature's source vertex, projected); the layer sets `object.position = origin`.
 * Time `[start,end]` is per-feature, rebased by `timeOffset - timeOrigin`.
 */
export function buildOdLineSegmentBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: LineSegmentBufferOptions,
): LineSegmentBuffers {
  const { parts, segCount } = collectOdLayers(tiles);
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
  const catIndex = opts.categoryIndex ?? null;

  // RTC origin = first feature's SOURCE vertex, projected (absolute world).
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

  let s = 0; // segment index (== feature index, but tiles concatenate)
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
    const si = b.startIndices!;
    for (let f = 0; f < b.featureCount; f++) {
      // One provenance entry per OD instance (merged index = s), in draw order.
      provenance.push(part.tileKey, f);
      const rgba = featureColor(b, f, opts.colorMode);
      const cr = rgba[0] / 255,
        cg = rgba[1] / 255,
        cb = rgba[2] / 255,
        ca = (rgba[3] ?? 255) / 255;
      const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      if (wantFilter) filterValues[s] = filterCol ? filterCol[f] : 0;
      if (catIndex)
        categoryIndices[s] = featureCategorySlot(
          b,
          f,
          catIndex.property,
          catIndex.palette,
        );
      const baseZ = elev ? elev[f] * elevScale : null;

      // First vertex = source, last vertex = target.
      const vSrc = si[f];
      const vTgt = si[f + 1] - 1;
      const zSrc =
        (baseZ ?? (dims > 2 ? b.positions[vSrc * dims + 2] : 0)) + zLift;
      const zTgt =
        (baseZ ?? (dims > 2 ? b.positions[vTgt * dims + 2] : 0)) + zLift;
      const a = projection.project(
        b.positions[vSrc * dims],
        b.positions[vSrc * dims + 1],
        zSrc,
      );
      const c = projection.project(
        b.positions[vTgt * dims],
        b.positions[vTgt * dims + 1],
        zTgt,
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
      timeA[s] = start;
      timeB[s] = end;
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

// Keep CategoricalColorSpec / RampColorSpec on the public surface for typing
// OD color modes without reaching into geo-line-buffers.
export type { RGBA, CategoricalColorSpec, RampColorSpec };
