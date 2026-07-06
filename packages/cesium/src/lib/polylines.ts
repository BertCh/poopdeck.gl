// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of per-feature ECEF polylines from decoded
 * LineString tiles — the CPU builders behind `CesiumPathLayer` (every vertex
 * of every feature) and `CesiumArcLayer` (OD endpoints swept into a raised
 * great-circle arc). Kernel-built:
 *
 *   - positions   → `core/geo` `GlobeProjection({datum:'wgs84'})` (Cesium's frame)
 *   - OD endpoints→ `core/geometry` `deriveSourceTargetPositions`
 *   - colour      → {@link featureColor} over `core/style` scalar lookups
 *   - arc shape   → the SAME parametrization as three's `greatCirclePos`
 *                   (`tsl/arc-material.ts`): slerp of the two ECEF direction
 *                   vectors, radius lerped between the endpoint radii, plus a
 *                   radial parabolic lift `height · chord · 4·t·(1−t)` — so a
 *                   deck/three/cesium toggle shows the same arc.
 *
 * Positions are ABSOLUTE f64 ECEF metres (no RTC): Cesium consumes CPU doubles
 * (`Cartesian3`), so there is no f32 buffer to protect.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { deriveSourceTargetPositions } from '@poopdeck.gl/core/geometry';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';

/** One renderable polyline: absolute ECEF vertices + its animation window. */
export interface FeaturePolyline {
  /** Absolute ECEF positions, x,y,z interleaved (metres). ≥ 2 vertices. */
  positions: Float64Array;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Base colour (0–255 channels); alpha animates as `base.a × timeFilterAlpha`. */
  color: RGBA255;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built polyline set, rebased to one scene-wide time origin. */
export interface PolylineBuild {
  polylines: FeaturePolyline[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
}

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum matters).
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, { datum: 'wgs84' });

const DEFAULT_COLOR: RGBA255 = [200, 205, 215, 255];

function collectLineLayers(tiles: Tile[]): BinaryFeatures[] {
  const layers: BinaryFeatures[] = [];
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (b.featureCount > 0 && b.geometryType === GeometryType.LineString && b.startIndices) {
        layers.push(b);
      }
    }
  }
  return layers;
}

/**
 * The scene-wide time origin for LineString-based layers: the first animatable
 * LineString layer's `timeOffset`, or 0 when there is none. This is the same
 * first-match convention `buildPathPolylines` / `buildArcPolylines` rebase to;
 * `CesiumTripsLayer` needs only the scalar (its geometry origin comes from the
 * core `buildTripIndex`), so it is factored out here rather than re-scanned.
 */
export function lineStringTimeOrigin(tiles: Tile[]): number {
  const layers = collectLineLayers(tiles);
  return layers.length > 0 ? layers[0].timeOffset : 0;
}

export interface PathBuildOptions {
  /** Per-feature colour. @default constant opaque grey */
  color?: FeatureColorMode;
  /** Constant altitude lift in metres (keeps ground decals off the ellipsoid). @default 0 */
  zLift?: number;
}

/**
 * Build one ECEF polyline per LineString feature (every vertex kept; geometry
 * z used when the tile is 3-D). Single-vertex features are skipped — a
 * polyline needs two ends. Times are rebased to the first layer's
 * `timeOffset`, mirroring `CesiumPointLayer.setTiles`.
 */
export function buildPathPolylines(tiles: Tile[], opts: PathBuildOptions = {}): PolylineBuild {
  const layers = collectLineLayers(tiles);
  if (layers.length === 0) return { polylines: [], timeOrigin: 0 };

  const timeOrigin = layers[0].timeOffset;
  const mode: FeatureColorMode = opts.color ?? { type: 'constant', color: DEFAULT_COLOR };
  const zLift = opts.zLift ?? 0;
  const polylines: FeaturePolyline[] = [];

  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const si = b.startIndices!;
    for (let f = 0; f < b.featureCount; f++) {
      const v0 = si[f];
      const v1 = si[f + 1];
      const nv = v1 - v0;
      if (nv < 2) continue;

      const pos = new Float64Array(nv * 3);
      for (let v = 0; v < nv; v++) {
        const base = (v0 + v) * dims;
        const alt = (dims > 2 ? b.positions[base + 2] : 0) + zLift;
        const [x, y, z] = GLOBE.project(b.positions[base], b.positions[base + 1], alt);
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
      }

      polylines.push({
        positions: pos,
        start: b.startTimes[f] + rebase,
        end: b.endTimes[f] + rebase,
        color: featureColor(b, f, mode),
        binary: b,
        featureIndex: f,
      });
    }
  }

  return { polylines, timeOrigin };
}

export interface ArcBuildOptions {
  /** Per-arc colour (one colour per instance — no endpoint gradient). @default constant */
  color?: FeatureColorMode;
  /** Arc-height multiplier (deck's `getHeight`); 0 = surface-hugging chord. @default 1 */
  height?: number;
  /** Sample count per arc (segments = samples − 1). @default 33 */
  samples?: number;
  /** Constant altitude lift in metres on both endpoints. @default 0 */
  zLift?: number;
}

/**
 * Sample a raised great-circle arc between two absolute ECEF endpoints —
 * the CPU twin of three's `greatCirclePos` (slerp + lerped radius + radial
 * parabolic lift `height · chord · 4·t·(1−t)`). Returns `samples` x,y,z
 * triples, source→target. Antipodal endpoints degenerate (slerp is undefined);
 * they fall back to linear interpolation like the shader's small-angle branch.
 */
export function sampleGreatCircleArc(
  src: readonly [number, number, number],
  tgt: readonly [number, number, number],
  height: number,
  samples: number,
): Float64Array {
  const out = new Float64Array(samples * 3);
  const [ax, ay, az] = src;
  const [bx, by, bz] = tgt;
  const ra = Math.hypot(ax, ay, az);
  const rb = Math.hypot(bx, by, bz);
  const chord = Math.hypot(bx - ax, by - ay, bz - az);

  // Unit direction vectors + the angle between them.
  const iax = ax / ra, iay = ay / ra, iaz = az / ra;
  const ibx = bx / rb, iby = by / rb, ibz = bz / rb;
  const cos = Math.min(1, Math.max(-1, iax * ibx + iay * iby + iaz * ibz));
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const slerpable = sinTheta > 1e-6;

  for (let s = 0; s < samples; s++) {
    const t = samples > 1 ? s / (samples - 1) : 0;
    let dx: number, dy: number, dz: number;
    if (slerpable) {
      const wa = Math.sin((1 - t) * theta) / sinTheta;
      const wb = Math.sin(t * theta) / sinTheta;
      dx = iax * wa + ibx * wb;
      dy = iay * wa + iby * wb;
      dz = iaz * wa + ibz * wb;
      const len = Math.hypot(dx, dy, dz);
      dx /= len; dy /= len; dz /= len;
    } else {
      // Near-parallel (or antipodal) — linear fallback, normalized when possible.
      dx = iax + (ibx - iax) * t;
      dy = iay + (iby - iay) * t;
      dz = iaz + (ibz - iaz) * t;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-6) { dx /= len; dy /= len; dz /= len; }
    }
    const radius = ra + (rb - ra) * t;
    const lift = height * chord * 4 * t * (1 - t);
    out[s * 3] = dx * (radius + lift);
    out[s * 3 + 1] = dy * (radius + lift);
    out[s * 3 + 2] = dz * (radius + lift);
  }
  return out;
}

/**
 * Build one raised great-circle arc per LineString feature: each feature
 * collapses to its first (source) / last (target) vertex via the kernel's
 * `deriveSourceTargetPositions`, then sweeps {@link sampleGreatCircleArc}.
 */
export function buildArcPolylines(tiles: Tile[], opts: ArcBuildOptions = {}): PolylineBuild {
  const layers = collectLineLayers(tiles);
  if (layers.length === 0) return { polylines: [], timeOrigin: 0 };

  const timeOrigin = layers[0].timeOffset;
  const mode: FeatureColorMode = opts.color ?? { type: 'constant', color: DEFAULT_COLOR };
  const height = opts.height ?? 1;
  const samples = Math.max(2, opts.samples ?? 33);
  const zLift = opts.zLift ?? 0;
  const polylines: FeaturePolyline[] = [];

  for (const b of layers) {
    const { source, target, dims } = deriveSourceTargetPositions(b);
    const rebase = b.timeOffset - timeOrigin;
    for (let f = 0; f < b.featureCount; f++) {
      const sBase = f * dims;
      const srcAlt = (dims > 2 ? source[sBase + 2] : 0) + zLift;
      const tgtAlt = (dims > 2 ? target[sBase + 2] : 0) + zLift;
      const src = GLOBE.project(source[sBase], source[sBase + 1], srcAlt);
      const tgt = GLOBE.project(target[sBase], target[sBase + 1], tgtAlt);

      polylines.push({
        positions: sampleGreatCircleArc(src, tgt, height, samples),
        start: b.startTimes[f] + rebase,
        end: b.endTimes[f] + rebase,
        color: featureColor(b, f, mode),
        binary: b,
        featureIndex: f,
      });
    }
  }

  return { polylines, timeOrigin };
}
