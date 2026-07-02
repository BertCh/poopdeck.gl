// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free, GPU-free) assembly of merged surfel instance buffers from
 * decoded tiles. Split out from {@link SurfelLayer} so the column-wiring,
 * time-rebasing, ENU projection, and column detection are unit-tested without
 * importing the WebGPU material or constructing GPU geometry.
 *
 * Two on-disk layouts are supported (the renderer auto-detects per tile):
 *   • **vector** (current `stt-build --vector-group`): interleaved FixedSizeList
 *     columns `surfel_quat` (f32×4, full quaternion), `surfel_scale` (f32×2),
 *     `surfel_rgba` (u8×4 rgba w/ confidence) in `binary.vectorProps`. This is
 *     what the rewired deck `SplatLayer` reads.
 *   • **numeric** (legacy): separate `qx,qy,qz,qw` (or smallest-three packed
 *     `q_a,q_b,q_c,q_imax`), `s_major,s_minor`, `r,g,b`, `surfel_opacity` columns
 *     in `binary.numericProps`.
 * Altitude (`z`) and `is_dynamic` are always plain numeric columns.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu.js';

export interface SurfelBufferOptions {
  /** Interleaved vector columns (preferred). */
  quatVectorColumn: string;
  scaleVectorColumn: string;
  colorVectorColumn: string;
  /** Legacy separate numeric quaternion columns. */
  quaternionColumns: [string, string, string, string];
  scaleColumns: [string, string];
  rgbColumns: [string, string, string] | null;
  opacityColumn: string | null;
  /** Altitude column (metres). */
  elevationProperty: string | null;
  elevationScale: number;
  fallbackColor: [number, number, number];
}

export interface SurfelBuffers {
  count: number;
  /** Any contributing tile used smallest-three packed quaternions (numeric path only). */
  packed: boolean;
  centers: Float32Array; // vec3 ENU metres
  quats: Float32Array; // vec4 (raw or packed)
  scales: Float32Array; // vec2 metres
  colors: Float32Array; // vec4 0..1
  starts: Float32Array; // float, relative to timeOrigin
  dynamic: Float32Array; // float 0/1
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

type VectorPart = {
  kind: 'vector';
  b: BinaryFeatures;
  quat: Float32Array | Uint8Array;
  scale: Float32Array | Uint8Array;
  color: Float32Array | Uint8Array | null;
};
type NumericPart = {
  kind: 'numeric';
  b: BinaryFeatures;
  packed: boolean;
  cols: [string, string, string, string, string, string];
};
type Part = VectorPart | NumericPart;

/** Classify a tile layer's surfel storage (vector preferred, numeric fallback). */
function detectSurfel(b: BinaryFeatures, opts: SurfelBufferOptions): Part | null {
  const vec = b.vectorProps ?? {};
  const quatV = vec[opts.quatVectorColumn];
  const scaleV = vec[opts.scaleVectorColumn];
  if (quatV && quatV.size === 4 && scaleV && scaleV.size === 2) {
    const colorV = vec[opts.colorVectorColumn];
    return {
      kind: 'vector',
      b,
      quat: quatV.value,
      scale: scaleV.value,
      color: colorV && colorV.size === 4 ? colorV.value : null,
    };
  }

  const num = b.numericProps;
  const packed = !!num['q_imax'];
  const [qx, qy, qz, qw] = packed
    ? (['q_a', 'q_b', 'q_c', 'q_imax'] as const)
    : opts.quaternionColumns;
  const [smaj, smin] = opts.scaleColumns;
  if (!num[qx] || !num[qy] || !num[qz] || !num[qw] || !num[smaj] || !num[smin]) return null;
  return { kind: 'numeric', b, packed, cols: [qx, qy, qz, qw, smaj, smin] };
}

/**
 * Merge every surfel-bearing tile into one set of interleaved instance buffers,
 * projected to ENU metres and rebased so each surfel's start time is relative to
 * `timeOrigin` (epoch-ms).
 */
export function buildSurfelBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: SurfelBufferOptions,
): SurfelBuffers {
  const parts: Part[] = [];
  let total = 0;
  let anyPacked = false;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount) continue;
      const part = detectSurfel(b, opts);
      if (!part) continue;
      parts.push(part);
      total += b.featureCount;
      if (part.kind === 'numeric') anyPacked = anyPacked || part.packed;
    }
  }

  if (total === 0) {
    return {
      count: 0,
      packed: false,
      centers: new Float32Array(0),
      quats: new Float32Array(0),
      scales: new Float32Array(0),
      colors: new Float32Array(0),
      starts: new Float32Array(0),
      dynamic: new Float32Array(0),
      bbox: null,
    };
  }

  const centers = new Float32Array(total * 3);
  const quats = new Float32Array(total * 4);
  const scales = new Float32Array(total * 2);
  const colors = new Float32Array(total * 4);
  const starts = new Float32Array(total);
  const dynamic = new Float32Array(total);
  const fb = opts.fallbackColor;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let o = 0;
  for (const part of parts) {
    const b = part.b;
    const num = b.numericProps;
    const count = b.featureCount;
    const dims = b.positionDimensions ?? 2;
    const elev = opts.elevationProperty ? num[opts.elevationProperty] : undefined;
    const dynArr = num['is_dynamic'];
    const rebase = b.timeOffset - timeOrigin;

    // Per-layout column accessors.
    const isVector = part.kind === 'vector';
    const vQuat = isVector ? part.quat : null;
    const vScale = isVector ? part.scale : null;
    const vColor = isVector ? part.color : null;
    const nQx = !isVector ? num[part.cols[0]] : null;
    const nQy = !isVector ? num[part.cols[1]] : null;
    const nQz = !isVector ? num[part.cols[2]] : null;
    const nQw = !isVector ? num[part.cols[3]] : null;
    const nSmaj = !isVector ? num[part.cols[4]] : null;
    const nSmin = !isVector ? num[part.cols[5]] : null;
    const rgb = opts.rgbColumns;
    const nR = !isVector && rgb ? num[rgb[0]] : undefined;
    const nG = !isVector && rgb ? num[rgb[1]] : undefined;
    const nB = !isVector && rgb ? num[rgb[2]] : undefined;
    const nOp = !isVector && opts.opacityColumn ? num[opts.opacityColumn] : undefined;

    for (let i = 0; i < count; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = elev ? elev[i] * opts.elevationScale : dims > 2 ? b.positions[i * dims + 2] : 0;
      const [x, y, z] = projection.project(lon, lat, alt);
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

      if (isVector) {
        quats[j * 4] = vQuat![i * 4];
        quats[j * 4 + 1] = vQuat![i * 4 + 1];
        quats[j * 4 + 2] = vQuat![i * 4 + 2];
        quats[j * 4 + 3] = vQuat![i * 4 + 3];
        scales[j * 2] = vScale![i * 2];
        scales[j * 2 + 1] = vScale![i * 2 + 1];
        if (vColor) {
          // u8 rgba (confidence already in a) → 0..1.
          colors[j * 4] = vColor[i * 4] / 255;
          colors[j * 4 + 1] = vColor[i * 4 + 1] / 255;
          colors[j * 4 + 2] = vColor[i * 4 + 2] / 255;
          colors[j * 4 + 3] = vColor[i * 4 + 3] / 255;
        } else {
          colors[j * 4] = fb[0] / 255;
          colors[j * 4 + 1] = fb[1] / 255;
          colors[j * 4 + 2] = fb[2] / 255;
          colors[j * 4 + 3] = 1;
        }
      } else {
        quats[j * 4] = nQx![i];
        quats[j * 4 + 1] = nQy![i];
        quats[j * 4 + 2] = nQz![i];
        quats[j * 4 + 3] = nQw![i];
        scales[j * 2] = nSmaj![i];
        scales[j * 2 + 1] = nSmin![i];
        if (nR && nG && nB) {
          colors[j * 4] = nR[i] / 255;
          colors[j * 4 + 1] = nG[i] / 255;
          colors[j * 4 + 2] = nB[i] / 255;
        } else {
          colors[j * 4] = fb[0] / 255;
          colors[j * 4 + 1] = fb[1] / 255;
          colors[j * 4 + 2] = fb[2] / 255;
        }
        colors[j * 4 + 3] = nOp ? Math.max(0, Math.min(1, nOp[i])) : 1;
      }

      starts[j] = b.startTimes[i] + rebase;
      dynamic[j] = dynArr ? (dynArr[i] >= 0.5 ? 1 : 0) : 0;
    }
    o += count;
  }

  return {
    count: total,
    packed: anyPacked,
    centers,
    quats,
    scales,
    colors,
    starts,
    dynamic,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}
