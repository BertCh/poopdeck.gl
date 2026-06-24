// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of merged point-cloud instance buffers — the points
 * analogue of `./surfel-buffers.ts`. Projects each feature to ENU metres,
 * resolves its colour (categorical `colorMapping` OR `r,g,b` columns), and
 * rebases its `[startTime,endTime]` to the scene's common time origin.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu';
import {
  expandCategoricalColors,
  expandRgbColumns,
  expandRampColors,
  type CategoricalColorSpec,
  type RampColorSpec,
  type RGBA,
} from '../lib/color';

export type PointColorMode =
  | { type: 'rgb'; columns: [string, string, string]; alpha?: number }
  | ({ type: 'categorical' } & CategoricalColorSpec)
  | ({ type: 'ramp' } & RampColorSpec);

export interface PointBufferOptions {
  colorMode: PointColorMode;
  elevationProperty: string | null;
  elevationScale: number;
  /**
   * Interleaved rgba(u8) vector column that, when present on a tile, takes
   * precedence over `colorMode` (the camera-colour path baked by
   * `stt-build --vector-group`). @default 'point_rgba'
   */
  colorVectorColumn?: string;
}

export interface PointBuffers {
  count: number;
  centers: Float32Array; // vec3, RTC-local (relative to `origin`)
  colors: Float32Array; // vec4 0..1
  starts: Float32Array; // float relative to timeOrigin
  ends: Float32Array; // float relative to timeOrigin
  /**
   * RTC origin (absolute projected world coords). `centers` are written
   * RELATIVE to this; the layer sets `object.position = origin`. For the
   * ENU/AV frame this is ~[0,0,0] so `centers` stay byte-identical to absolute.
   */
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

function colorsForTile(
  b: BinaryFeatures,
  mode: PointColorMode,
  colorVectorColumn: string,
): Float32Array {
  // Interleaved camera-colour vector column wins when present (the rewired path).
  const cv = b.vectorProps?.[colorVectorColumn];
  if (cv && cv.size === 4) {
    const count = b.featureCount;
    const out = new Float32Array(count * 4);
    const v = cv.value;
    for (let i = 0; i < count * 4; i++) out[i] = v[i] / 255;
    return out;
  }
  if (mode.type === 'rgb') {
    return expandRgbColumns(b, mode.columns, mode.alpha ?? 1);
  }
  if (mode.type === 'ramp') {
    return expandRampColors(b, {
      property: mode.property,
      domain: mode.domain,
      range: mode.range,
      fallback: mode.fallback,
    });
  }
  return expandCategoricalColors(b, {
    property: mode.property,
    mapping: mode.mapping,
    fallback: mode.fallback,
  });
}

export function buildPointBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: PointBufferOptions,
): PointBuffers {
  const parts: BinaryFeatures[] = [];
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount) continue;
      if (b.geometryType !== GeometryType.Point) continue;
      parts.push(b);
      total += b.featureCount;
    }
  }

  if (total === 0) {
    return {
      count: 0,
      centers: new Float32Array(0),
      colors: new Float32Array(0),
      starts: new Float32Array(0),
      ends: new Float32Array(0),
      origin: [0, 0, 0],
      bbox: null,
    };
  }

  // RTC origin = first vertex of the first non-empty point layer, projected
  // (absolute world). `centers` are written relative to it so the large
  // mercator/globe magnitude stays in the f64 CPU transform (object.position),
  // not the f32 buffer. For the ENU/AV frame origin ≈ [0,0,0] → no-op.
  const firstLayer = parts[0];
  const firstDims = firstLayer.positionDimensions ?? 2;
  const firstAlt = firstDims > 2 ? firstLayer.positions[2] : 0;
  const origin = projection.project(firstLayer.positions[0], firstLayer.positions[1], firstAlt);

  const centers = new Float32Array(total * 3);
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
  for (const b of parts) {
    const count = b.featureCount;
    const dims = b.positionDimensions ?? 2;
    const elev = opts.elevationProperty ? b.numericProps[opts.elevationProperty] : undefined;
    const tileColors = colorsForTile(b, opts.colorMode, opts.colorVectorColumn ?? 'point_rgba');
    const rebase = b.timeOffset - timeOrigin;

    for (let i = 0; i < count; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = elev ? elev[i] * opts.elevationScale : dims > 2 ? b.positions[i * dims + 2] : 0;
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
    colors,
    starts,
    ends,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

export type { RGBA };
