// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of the **heatmap splat** buffers — the per-point
 * inputs to the density accumulation pass of `STTHeatmapLayer` (the three/TSL
 * analogue of deck's `AnimatedHeatmapLayer` and maplibre's `STTHeatmapLayer`).
 *
 * ── ONE CONSOLIDATED BUFFER SET, NOT ONE PER TILE ────────────────────────────
 * Every visible tile's points merge into a SINGLE instance buffer set, exactly
 * as the deck composite consolidates its channels. That is not a performance
 * nicety, it is a correctness requirement of the pipeline: a gaussian splat is
 * ~`radiusPixels` wide on screen, so a point sitting just inside tile A's edge
 * deposits density into pixels that belong to tile B. Splatting per tile — one
 * mesh, one accumulation pass, one normalisation each — would cut every splat
 * at the tile border and paint a visible lattice of brightness seams over the
 * map. One merged buffer set → one additive pass → one density field.
 *
 * ── WHAT A SPLAT CARRIES ─────────────────────────────────────────────────────
 * Four attributes per point and nothing else: an RTC-local `centre`, an
 * accumulation `weight`, and the rebased `[start, end]` the GPU time filter
 * gates on. No colour: the ramp is applied per PIXEL after accumulation (see
 * `../tsl/heatmap-material.ts`), so a per-splat colour would be meaningless —
 * sampling the palette per point and additively blending the resulting COLOURS
 * sums colours instead of density, and overlapping points blow out to white.
 *
 * ── THE WEIGHT COLUMN ────────────────────────────────────────────────────────
 * {@link HeatmapBufferOptions.weightProperty} names a baked numeric COLUMN, not
 * a JS accessor (binary tiles cannot run per-feature JS — the same rule deck's
 * `getWeight` alias documents). Unset, every point weighs exactly `1` and the
 * result is a pure COUNT density. Set but ABSENT from a given tile, that tile's
 * points fall back to `1` rather than dropping out, matching the deck
 * consolidator's `weightSrc ? weightSrc[i] : 1`: a tile that predates the column
 * still contributes its count instead of punching a hole in the field.
 *
 * `weightScale` is the archive-derived normaliser (deck folds `1 / p95` of the
 * baked `metadata.heatmapDomain` into the same multiply) and is folded in HERE
 * because it is fixed for the life of a tile set. The live `intensity` knob is
 * deliberately NOT folded in — it is a fragment uniform on the splat material
 * (maplibre's `uIntensity`), so retuning it re-renders without re-packing a
 * single byte.
 *
 * ── DELIBERATE NON-GOALS ─────────────────────────────────────────────────────
 * • **No provenance / `binaryByTileKey`.** Every other merged builder in this
 *   package emits the GPU-pick identity pair; this one must not. A heatmap
 *   PIXEL is the sum of an unbounded number of splats and has no single feature
 *   identity to report, so the layer ships no `pick()` and deck forces
 *   `pickable: false` on its sublayers for the same reason. Emitting a
 *   provenance buffer nothing can read would be pure waste. Hit-testing a
 *   heatmap means picking the underlying point layer.
 * • **Point geometry only.** LineString tiles are SKIPPED, matching the
 *   maplibre backend ("renders POINT-type tiles"). deck's consolidator also
 *   splats one gaussian per line VERTEX; that path is not ported here.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu.js';

export interface HeatmapBufferOptions {
  /**
   * Numeric column NAME whose per-feature value weights that point's splat.
   * `null` / omitted → every point weighs `1` (a pure COUNT heatmap). A tile
   * that lacks the column falls back to `1` for its own points.
   * @default null
   */
  weightProperty?: string | null;
  /**
   * Constant multiplier folded into every weight at build time — the
   * archive-derived normaliser (`1 / p95` of `metadata.heatmapDomain`) that
   * re-expresses each weight in units of "one p95-magnitude feature". The live
   * `intensity` knob is a material uniform, not this. @default 1
   */
  weightScale?: number;
}

export interface HeatmapBuffers {
  /** Splat count = merged point count across every visible tile. */
  count: number;
  /** vec3 splat centre, RTC-local (relative to {@link origin}). */
  centers: Float32Array;
  /** float accumulation weight per splat (already × `weightScale`). */
  weights: Float32Array;
  /** float start time, relative to `timeOrigin`. */
  starts: Float32Array;
  /** float end time, relative to `timeOrigin`. */
  ends: Float32Array;
  /**
   * RTC origin (absolute projected world coords). {@link centers} are written
   * RELATIVE to it; the layer sets the splat mesh's `position` to it. Keeps the
   * large mercator/globe magnitude in the f64 CPU transform instead of the f32
   * buffer. `[0,0,0]` when empty (and ≈ that in the ENU/AV frame).
   */
  origin: [number, number, number];
  /** RTC-local AABB of the splat centres; `null` when `count === 0`. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** Collect the Point-geometry source layers across every visible tile. */
function collectPointLayers(tiles: Tile[]): {
  parts: BinaryFeatures[];
  total: number;
} {
  const parts: BinaryFeatures[] = [];
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      // Non-point geometry is silently skipped, not an error: a scene may mount
      // the heatmap over an archive whose layers mix kinds.
      if (!b.featureCount || b.geometryType !== GeometryType.Point) continue;
      parts.push(b);
      total += b.featureCount;
    }
  }
  return { parts, total };
}

/**
 * Build the consolidated splat buffers for every visible tile.
 *
 * Times are rebased by `b.timeOffset - timeOrigin` at build time so the GPU
 * compares two SMALL numbers (an absolute epoch-ms ≈ 1.7e12 does not survive an
 * f32 attribute); positions are written relative to {@link HeatmapBuffers.origin}
 * for the same f32 reason on the space axis.
 */
export function buildHeatmapBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: HeatmapBufferOptions = {},
): HeatmapBuffers {
  const { parts, total } = collectPointLayers(tiles);

  // Empty short-circuit: the all-empty SHAPE, never null/undefined — the layer
  // branches on `buf.count === 0`, not on nullability.
  if (total === 0) {
    return {
      count: 0,
      centers: new Float32Array(0),
      weights: new Float32Array(0),
      starts: new Float32Array(0),
      ends: new Float32Array(0),
      origin: [0, 0, 0],
      bbox: null,
    };
  }

  const weightProperty = opts.weightProperty ?? null;
  const weightScale = opts.weightScale ?? 1;

  // RTC origin = the first feature of the first non-empty point layer,
  // projected (absolute world). For the ENU/AV frame this is ≈ [0,0,0], so the
  // centres stay byte-identical to the absolute positions.
  const first = parts[0];
  const firstDims = first.positionDimensions ?? 2;
  const firstAlt = firstDims > 2 ? first.positions[2] : 0;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    firstAlt,
  );

  const centers = new Float32Array(total * 3);
  const weights = new Float32Array(total);
  const starts = new Float32Array(total);
  const ends = new Float32Array(total);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let o = 0; // merged splat index
  for (const b of parts) {
    const dims = b.positionDimensions ?? 2;
    // Absent column → undefined → every point in THIS tile weighs 1 (deck's
    // `weightSrc ? weightSrc[i] : 1`), rather than the tile dropping out.
    const wcol = weightProperty ? b.numericProps[weightProperty] : undefined;
    const rebase = b.timeOffset - timeOrigin;

    for (let i = 0; i < b.featureCount; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      // The baked altitude (when the archive carries 3D positions) is kept
      // rather than flattened to 0: the splat is projected through the live
      // camera, so under a pitched view a point 400 m up must land where it
      // actually is. There is no elevation COLUMN knob — density is a screen
      // quantity and an extruded heatmap is not a thing.
      const alt = dims > 2 ? b.positions[i * dims + 2] : 0;
      const p = projection.project(lon, lat, alt);
      const x = p[0] - origin[0];
      const y = p[1] - origin[1];
      const z = p[2] - origin[2];
      centers[o * 3] = x;
      centers[o * 3 + 1] = y;
      centers[o * 3 + 2] = z;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;

      const w = (wcol ? wcol[i] : 1) * weightScale;
      // A single NaN/Inf weight poisons every texel its splat touches, and the
      // accumulator is additive so the damage never washes out. Non-finite
      // weights contribute nothing; negatives are the caller's business (they
      // legitimately subtract density).
      weights[o] = Number.isFinite(w) ? w : 0;

      starts[o] = (b.startTimes ? b.startTimes[i] : 0) + rebase;
      ends[o] = (b.endTimes ? b.endTimes[i] : 0) + rebase;
      o++;
    }
  }

  return {
    count: total,
    centers,
    weights,
    starts,
    ends,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}
