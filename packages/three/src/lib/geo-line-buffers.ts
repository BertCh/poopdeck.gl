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
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  rampColorAt,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from './color.js';

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
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
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
  layers: BinaryFeatures[];
  segCount: number;
} {
  const layers: BinaryFeatures[] = [];
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
      layers.push(b);
      for (let f = 0; f < b.featureCount; f++) {
        segCount += Math.max(0, b.startIndices[f + 1] - b.startIndices[f] - 1);
      }
    }
  }
  return { layers, segCount };
}

export function buildLineSegmentBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: LineSegmentBufferOptions,
): LineSegmentBuffers {
  const { layers, segCount } = collectLineLayers(tiles);
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
    origin: [0, 0, 0],
    bbox: null,
  });
  if (segCount === 0) return empty();

  const zLift = opts.zLift ?? 0;
  const elevScale = opts.elevationScale ?? 1;

  // RTC origin = first vertex of the first feature, projected (absolute world).
  const first = layers[0];
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
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let s = 0; // segment index
  for (const b of layers) {
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const rebase = b.timeOffset - timeOrigin;
    for (let f = 0; f < b.featureCount; f++) {
      const rgba = featureColor(b, f, opts.colorMode);
      const cr = rgba[0] / 255,
        cg = rgba[1] / 255,
        cb = rgba[2] / 255,
        ca = (rgba[3] ?? 255) / 255;
      const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
      const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;
      const baseZ = elev ? elev[f] * elevScale : null;
      const v0 = b.startIndices![f];
      const v1 = b.startIndices![f + 1];
      for (let v = v0; v < v1 - 1; v++) {
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
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}
