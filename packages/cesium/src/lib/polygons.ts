// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of per-feature ECEF polygon rings from decoded
 * Polygon tiles — the CPU builder behind `STTPolygonLayer`. Kernel-built:
 *
 *   - positions → `core/geo` `GlobeProjection({datum:'wgs84'})`, i.e. Cesium's
 *                 own frame, so the result drops straight into `Cartesian3`
 *   - colour    → {@link featureColor} over `core/style` scalar lookups
 *                 (constant / categorical / ramp), ONE colour per feature
 *   - times     → rebased to a single scene-wide origin, exactly as
 *                 `lib/polylines.ts` does
 *
 * Positions are ABSOLUTE f64 ECEF metres (no RTC): Cesium consumes CPU doubles
 * (`Cartesian3`), so there is no f32 buffer whose precision needs protecting.
 *
 * ── THE THREE NESTED INDEX ARRAYS ────────────────────────────────────────────
 * A polygon tile carries up to three boundary arrays over one flat vertex run,
 * nested coarsest to finest: `startIndices` (feature) ⊇ `partIndices`
 * (MultiPolygon member) ⊇ `ringIndices` (exterior ring, then its holes). This
 * builder walks all three, because collapsing any of them is visible:
 *   - ignore `partIndices` and an archipelago becomes one polygon stitched
 *     across open water;
 *   - ignore `ringIndices` and every hole is welded to the exterior by a
 *     spurious edge (and lakes fill in solid).
 * Both arrays are OPTIONAL — tiles written by readers predating them carry only
 * `startIndices` — so their absence degrades to "one part, one ring", which is
 * the correct reading of a simple polygon.
 *
 * The boundary walk uses a MOVING CURSOR per array rather than a scan per
 * feature: features arrive in ascending vertex order and every feature boundary
 * also appears in the finer arrays, so one pass over each array serves the whole
 * layer (O(V) instead of O(F·R)).
 *
 * ── RINGS ARRIVE CLOSED; CESIUM WANTS THEM OPEN ──────────────────────────────
 * GeoArrow/GeoJSON rings repeat their first vertex as their last. Cesium's
 * polygon tessellator treats that duplicate as a degenerate edge, so the trailing
 * vertex is dropped here — in the pure builder, where it is testable — rather
 * than left for `PolygonPipeline.removeDuplicates` to notice at draw time.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *  - It does NOT use the tile's pre-baked `triangles`. Cesium owns polygon
 *    tessellation (it has to: extrusion walls, ellipsoid subdivision and the
 *    2-D projection of the fill are all its business), so the wire triangles are
 *    dead weight on this path.
 *  - It does NOT reproject or clip. Tiles are already clipped to the tile
 *    boundary upstream; a ring that crosses the antimeridian is the encoder's
 *    problem, not this builder's.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';

/** One member of a (Multi)Polygon: an exterior ring plus its holes. */
export interface PolygonPart {
  /**
   * Exterior ring, absolute ECEF x,y,z interleaved (metres). At least 3
   * vertices, and OPEN (no repeated closing vertex).
   */
  outer: Float64Array;
  /** Interior rings (holes), same layout and the same open/≥3 guarantee. */
  holes: Float64Array[];
}

/** One renderable polygon feature: its parts + its animation window. */
export interface FeaturePolygon {
  /**
   * One entry per MultiPolygon member (length 1 for a simple polygon). Never
   * empty — a feature whose every ring is degenerate is dropped by the builder.
   */
  parts: PolygonPart[];
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Base colour (0–255 channels); alpha animates as `base.a × timeFilterAlpha`. */
  color: RGBA255;
  /**
   * Height (metres above the ellipsoid) of the fill when it is NOT extruded, and
   * of the extrusion's floor when it is: the feature's first vertex altitude
   * plus `zLift`.
   */
  baseHeight: number;
  /**
   * Height (metres above the ellipsoid) of the extrusion's roof. Equal to
   * {@link baseHeight} when the feature is not extruded — the layer treats
   * `top <= base` as "draw a flat fill".
   */
  topHeight: number;
  /** First vertex, for `SttPickResult.coordinate`. */
  lon: number;
  lat: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built polygon set, rebased to one scene-wide time origin. */
export interface PolygonBuild {
  polygons: FeaturePolygon[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
}

export interface PolygonBuildOptions {
  /** Per-feature colour. @default constant translucent slate */
  color?: FeatureColorMode;
  /**
   * Numeric column (metres) driving each feature's extrusion. When absent or
   * unresolvable, {@link extrudedHeight} is used. @default null
   */
  extrudedHeightProperty?: string | null;
  /** Extrusion in metres when no column resolves. 0 = a flat fill. @default 0 */
  extrudedHeight?: number;
  /** Multiplier applied to whichever height was resolved. @default 1 */
  heightScale?: number;
  /**
   * Constant altitude lift in metres applied to every vertex — keeps a ground
   * decal from z-fighting the ellipsoid/terrain. @default 0
   */
  zLift?: number;
}

// One WGS84 globe for every build. Byte-identical to the polyline/point
// builders' GLOBE, and duplicated on purpose: `project` is anchor-independent,
// so a module-level singleton per file costs nothing and keeps each builder
// readable on its own. The `datum` is NOT optional — the class default is
// 'sphere', which mis-registers against Cesium's real ellipsoid by up to ~20 km
// at mid-latitudes.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEFAULT_COLOR: RGBA255 = [120, 150, 200, 200];

function collectPolygonLayers(tiles: Tile[]): BinaryFeatures[] {
  const layers: BinaryFeatures[] = [];
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (
        b.featureCount > 0 &&
        b.geometryType === GeometryType.Polygon &&
        b.startIndices
      ) {
        layers.push(b);
      }
    }
  }
  return layers;
}

/**
 * The scene-wide time origin for Polygon-based layers: the first animatable
 * Polygon layer's `timeOffset`, or 0 when there is none. Same first-match
 * convention as `lineStringTimeOrigin`.
 */
export function polygonTimeOrigin(tiles: Tile[]): number {
  const layers = collectPolygonLayers(tiles);
  return layers.length > 0 ? layers[0].timeOffset : 0;
}

/**
 * Boundaries of `arr` falling inside `[v0, v1]`, returned ascending WITH both
 * ends included, so the result is always a usable span list of length ≥ 2.
 *
 * `cursor` is carried across calls: the caller walks features in ascending
 * vertex order and every feature boundary also appears in `arr`, so the cursor
 * lands on `v1` (== the next feature's `v0`) and the next call skips it via the
 * `<= v0` guard. A missing `arr` yields `[v0, v1]` — one span, the right reading
 * of a tile that never recorded the finer structure.
 */
function boundariesWithin(
  arr: Uint32Array | undefined,
  v0: number,
  v1: number,
  cursor: { i: number },
): number[] {
  const out: number[] = [v0];
  if (arr) {
    while (cursor.i < arr.length && arr[cursor.i] <= v0) cursor.i++;
    while (cursor.i < arr.length && arr[cursor.i] < v1) {
      out.push(arr[cursor.i]);
      cursor.i++;
    }
  }
  out.push(v1);
  return out;
}

/**
 * Project one ring's vertex span into absolute ECEF, dropping the repeated
 * closing vertex. Returns `null` for a ring that cannot bound an area (< 3
 * distinct vertices) — the caller drops it rather than handing Cesium a
 * degenerate hierarchy.
 */
function projectRing(
  b: BinaryFeatures,
  dims: number,
  r0: number,
  r1: number,
  zLift: number,
): Float64Array | null {
  let n = r1 - r0;
  if (n < 3) return null;
  const first = r0 * dims;
  const last = (r1 - 1) * dims;
  if (
    b.positions[last] === b.positions[first] &&
    b.positions[last + 1] === b.positions[first + 1]
  ) {
    n -= 1; // closed ring → open it
  }
  if (n < 3) return null;

  const out = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) {
    const base = (r0 + v) * dims;
    const alt = (dims > 2 ? b.positions[base + 2] : 0) + zLift;
    const [x, y, z] = GLOBE.project(
      b.positions[base],
      b.positions[base + 1],
      alt,
    );
    out[v * 3] = x;
    out[v * 3 + 1] = y;
    out[v * 3 + 2] = z;
  }
  return out;
}

/**
 * Resolve one feature's extrusion in metres: the numeric column when it exists
 * and is finite, else the constant, times `heightScale`. Negative and
 * non-finite results clamp to 0 (a flat fill) — Cesium treats a roof below its
 * floor as a swap, which would silently sink a polygon through the globe.
 */
function resolveHeight(
  column: { [i: number]: number; length: number } | undefined,
  f: number,
  constant: number,
  scale: number,
): number {
  const raw = column ? column[f] : constant;
  const h = raw * scale;
  return Number.isFinite(h) && h > 0 ? h : 0;
}

/**
 * Build one {@link FeaturePolygon} per Polygon feature across every polygon
 * layer in `tiles`. Features whose rings are all degenerate are skipped; times
 * are rebased to the first layer's `timeOffset`, mirroring
 * `STTPointLayer.setTiles`.
 */
export function buildPolygonEntries(
  tiles: Tile[],
  opts: PolygonBuildOptions = {},
): PolygonBuild {
  const layers = collectPolygonLayers(tiles);
  if (layers.length === 0) return { polygons: [], timeOrigin: 0 };

  const timeOrigin = layers[0].timeOffset;
  const mode: FeatureColorMode = opts.color ?? {
    type: 'constant',
    color: DEFAULT_COLOR,
  };
  const heightProp = opts.extrudedHeightProperty ?? null;
  const heightConst = opts.extrudedHeight ?? 0;
  const heightScale = opts.heightScale ?? 1;
  const zLift = opts.zLift ?? 0;
  const polygons: FeaturePolygon[] = [];

  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const si = b.startIndices!;
    const heights = heightProp ? b.numericProps[heightProp] : undefined;
    const partCursor = { i: 0 };
    const ringCursor = { i: 0 };

    for (let f = 0; f < b.featureCount; f++) {
      const v0 = si[f];
      const v1 = si[f + 1];
      const partBounds = boundariesWithin(b.partIndices, v0, v1, partCursor);
      const ringBounds = boundariesWithin(b.ringIndices, v0, v1, ringCursor);

      const parts: PolygonPart[] = [];
      let r = 0;
      for (let p = 0; p + 1 < partBounds.length; p++) {
        const p1 = partBounds[p + 1];
        const rings: Float64Array[] = [];
        while (r + 1 < ringBounds.length && ringBounds[r] < p1) {
          const ring = projectRing(
            b,
            dims,
            ringBounds[r],
            ringBounds[r + 1],
            zLift,
          );
          if (ring) rings.push(ring);
          r++;
        }
        // A part with no usable exterior contributes nothing; its would-be holes
        // go with it (a hole without an exterior is not a shape).
        if (rings.length > 0) {
          parts.push({ outer: rings[0], holes: rings.slice(1) });
        }
      }
      if (parts.length === 0) continue;

      const head = v0 * dims;
      const baseHeight = (dims > 2 ? b.positions[head + 2] : 0) + zLift;
      const extrusion = resolveHeight(heights, f, heightConst, heightScale);

      polygons.push({
        parts,
        start: b.startTimes[f] + rebase,
        end: b.endTimes[f] + rebase,
        color: featureColor(b, f, mode),
        baseHeight,
        topHeight: baseHeight + extrusion,
        lon: b.positions[head],
        lat: b.positions[head + 1],
        binary: b,
        featureIndex: f,
      });
    }
  }

  return { polygons, timeOrigin };
}
