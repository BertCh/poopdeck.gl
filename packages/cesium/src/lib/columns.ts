// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of per-feature extruded PRISMS from decoded Point
 * tiles — the CPU builder behind `STTColumnLayer`, the Cesium analogue of deck's
 * `AnimatedColumnLayer`. One prism per Point feature: a metric radius, a height
 * driven by a numeric column through a scale, a per-feature colour, and the
 * feature's `[start,end]` window rebased to one scene-wide origin.
 *
 * Kernel-built, exactly like `lib/points.ts` and `lib/polylines.ts`:
 *   - positions → `core/geo` `GlobeProjection({datum:'wgs84'})` (Cesium's frame)
 *   - colour    → {@link featureColor} over `core/style` scalar lookups
 *   - layers    → `collectPointLayers` from `lib/points.ts` (same Point-tier
 *                 collection rule; a column IS a point feature, drawn tall)
 *
 * ── WHAT THIS BUILDER DOES *NOT* DECIDE ──────────────────────────────────────
 * It emits the prism's FOOT as an absolute ECEF position and its height/radius
 * in metres, and stops there. The prism's ORIENTATION is the layer's business,
 * because on a real ellipsoid "up" is a per-position direction that Cesium
 * already owns (`Transforms.eastNorthUpToFixedFrame`); duplicating that basis
 * here would mean shipping a second, subtly different definition of local up.
 *
 * ── TIME AS HEIGHT (the space-time cube) ─────────────────────────────────────
 * `timeHeightScale` is METRES OF ALTITUDE PER MILLISECOND: each prism's foot
 * rises by `(start − timeHeightOrigin) × timeHeightScale`, so a stack of events
 * at one location fans out into a vertical time axis and the flat map (scale 0)
 * morphs continuously into the cube.
 *
 * The lift is applied as an ALTITUDE ADD through the projection — `project(lon,
 * lat, baseAltitude + lift)` — never as a Z offset on the resulting Cartesian.
 * Cesium's positions are absolute f64 ECEF metres, where +Z is the spin axis,
 * not the local vertical: adding the lift to `z` would tilt every column toward
 * the pole by exactly the co-latitude and leave Quito right while Reykjavík
 * points out to sea. Going through the projection makes the lift geodetic by
 * construction, at every latitude, for free.
 *
 * DEVIATION from deck: deck's `timeHeightOrigin: 0` is reinterpreted as "unset"
 * because its shader differences times in f32, where the Unix epoch destroys the
 * subtraction. This backend differences in f64 on the CPU, so a literal `0` here
 * IS the Unix epoch and is honoured as such (it will lift the columns ~1.7e12 ×
 * scale metres off the planet, which is what was asked for). Pass `null` — the
 * default — to anchor altitude 0 at the build's own time origin.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';
import { collectPointLayers } from './points.js';

/** One renderable prism: absolute ECEF foot + metric size + its animation window. */
export interface FeatureColumn {
  /** Absolute ECEF position (metres) of the prism's FOOT — the centre of its base disk. */
  x: number;
  y: number;
  z: number;
  /** Prism height in TRUE metres, always `> 0` (non-positive heights are skipped). */
  height: number;
  /** Cross-section circumradius in TRUE metres, always `> 0`. */
  radius: number;
  /** Base colour (0–255 channels); alpha animates as `base.a × timeFilterAlpha`. */
  color: RGBA255;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /**
   * The time-as-height lift already folded into this foot's altitude (metres);
   * 0 when `timeHeightScale` is 0. Reported so a caller (or a test) can see the
   * cube axis without re-deriving it.
   */
  lift: number;
  /** Source lon/lat (degrees) — the picking coordinate. */
  lon: number;
  lat: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built column set, rebased to one scene-wide time origin. */
export interface ColumnBuild {
  columns: FeatureColumn[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
}

export interface ColumnBuildOptions {
  /** Per-feature colour (constant / categorical / ramp). @default constant grey */
  color?: FeatureColorMode;
  /**
   * Numeric column (metres) driving each prism's HEIGHT. A tile missing the
   * named column falls back to {@link defaultElevation}, matching the deck
   * adapter. @default null (every prism gets `defaultElevation`)
   */
  elevationProperty?: string | null;
  /** Height in metres when no `elevationProperty` resolves. @default 1000 */
  defaultElevation?: number;
  /** Multiplier on every height, constant and column-driven alike. @default 1 */
  elevationScale?: number;
  /** Cross-section circumradius in TRUE metres. @default 100 */
  radius?: number;
  /** Radius multiplier in 0..1 (deck's `coverage`). @default 1 */
  coverage?: number;
  /**
   * Numeric column (metres) lifting each prism's FOOT off the ground — a
   * floating slab. Falls back to the geometry's own z on 3-D tiles.
   * @default null
   */
  baseElevationProperty?: string | null;
  /** Constant altitude lift in metres added to every foot. @default 0 */
  zLift?: number;
  /**
   * Space-time cube: METRES of altitude per MILLISECOND. Each foot rises by
   * `(start − timeHeightOrigin) × timeHeightScale`. @default 0 (flat map)
   */
  timeHeightScale?: number;
  /**
   * ABSOLUTE time (epoch ms) rendered at altitude 0 under
   * {@link timeHeightScale} — typically the archive's `timeRange.start`.
   * Relativized against the build's own `timeOrigin`. `null` anchors altitude 0
   * at that origin. A literal `0` means the Unix epoch here (see the module
   * header). @default null
   */
  timeHeightOrigin?: number | null;
}

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum matters).
// Byte-identical to the point/polyline builders' GLOBE; `project` is
// anchor-independent, so the duplication costs nothing and keeps this module
// free of cross-builder imports for a single constant.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEFAULT_COLOR: RGBA255 = [255, 140, 0, 255]; // deck ColumnLayer's fill

/**
 * The space-time-cube lift for one feature, in metres: how far above its base
 * altitude a prism starting at `startRel` stands. Both times are relative to
 * the build's `timeOrigin`, so the subtraction stays small and exact.
 *
 * Factored out (rather than inlined) because it is the ONE piece of cube maths
 * a caller may need to reproduce — to place a time axis, a legend tick, or a
 * camera target at the same altitude the columns use.
 */
export function timeHeightLiftMeters(
  startRel: number,
  timeHeightOriginRel: number,
  timeHeightScale: number,
): number {
  return (startRel - timeHeightOriginRel) * timeHeightScale;
}

/**
 * Build one prism per Point feature. Times are rebased to the first Point
 * layer's `timeOffset` — the scene-wide origin convention every layer in this
 * package shares.
 *
 * A feature whose resolved height or radius is not `> 0` is SKIPPED rather than
 * emitted degenerate: that is deck's `shouldRender` semantics (a negative
 * elevation draws nothing instead of punching a prism through the ground), and
 * it is also a hard requirement downstream — Cesium's `CylinderGeometry` builds
 * caps and a wall band from these numbers and has no meaningful zero case.
 *
 * Returns an empty build (`timeOrigin: 0`) when nothing survives; the layer
 * checks `columns.length` before adopting `timeOrigin`, so an empty rebuild
 * leaves the previous origin — and the previous prisms — untouched.
 */
export function buildColumnEntries(
  tiles: Tile[],
  opts: ColumnBuildOptions = {},
): ColumnBuild {
  const layers = collectPointLayers(tiles);
  if (layers.length === 0) return { columns: [], timeOrigin: 0 };

  const timeOrigin = layers[0].timeOffset;
  const mode: FeatureColorMode = opts.color ?? {
    type: 'constant',
    color: DEFAULT_COLOR,
  };
  const radius = (opts.radius ?? 100) * (opts.coverage ?? 1);
  const defaultElevation = opts.defaultElevation ?? 1000;
  const elevationScale = opts.elevationScale ?? 1;
  const zLift = opts.zLift ?? 0;
  const heightScale = opts.timeHeightScale ?? 0;
  // Absolute epoch ms → build-relative, so the difference in
  // `timeHeightLiftMeters` is between two small, same-origin numbers.
  const heightOriginRel =
    opts.timeHeightOrigin == null ? 0 : opts.timeHeightOrigin - timeOrigin;
  const columns: FeatureColumn[] = [];
  if (!(radius > 0)) return { columns, timeOrigin };

  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const baseElev = opts.baseElevationProperty
      ? b.numericProps[opts.baseElevationProperty]
      : undefined;

    for (let f = 0; f < b.featureCount; f++) {
      const height = (elev ? elev[f] : defaultElevation) * elevationScale;
      if (!(height > 0)) continue; // deck `shouldRender`: no prism below ground

      const lon = b.positions[f * dims];
      const lat = b.positions[f * dims + 1];
      const start = b.startTimes[f] + rebase;
      const end = b.endTimes[f] + rebase;
      const lift =
        heightScale === 0
          ? 0
          : timeHeightLiftMeters(start, heightOriginRel, heightScale);
      // Foot altitude: the explicit base column (else the tile's own geometry
      // z), plus the constant lift, plus the cube lift. ONE altitude, projected
      // once — see the module header on why the cube lift cannot be a Z add.
      const baseAlt =
        (baseElev ? baseElev[f] : dims > 2 ? b.positions[f * dims + 2] : 0) +
        zLift +
        lift;
      const [x, y, z] = GLOBE.project(lon, lat, baseAlt);

      columns.push({
        x,
        y,
        z,
        height,
        radius,
        color: featureColor(b, f, mode),
        start,
        end,
        lift,
        lon,
        lat,
        binary: b,
        featureIndex: f,
      });
    }
  }

  return { columns, timeOrigin };
}

/**
 * The along-axis offset, in metres, from a prism's FOOT to its CENTRE.
 *
 * Trivial arithmetic with a non-trivial reason to exist: Cesium's
 * `CylinderGeometry` is built CENTRED on its local origin, spanning `±length/2`
 * along local +Z, whereas {@link FeatureColumn} reports the foot — the place the
 * data actually is. Every placement therefore has to raise the prism by half its
 * height along local up, and getting that wrong sinks half of every column into
 * the ground, which reads as "short columns" rather than as a bug. Naming it
 * here keeps the fact testable without a GPU and out of the layer's inner loop.
 */
export function columnAxisOffsetMeters(height: number): number {
  return height / 2;
}

/**
 * Resolve deck's `diskResolution` to a legal Cesium `slices` count: an integer
 * `>= 3`, defaulting to deck's own 20.
 *
 * A prism needs three sides to enclose anything, and Cesium throws
 * `DeveloperError: options.slices must be greater than or equal to 3` rather
 * than degrading — so an author who asks for a 2-sided column (or a fractional
 * one, from a slider bound straight to a number input) would take the whole
 * scene down at the first rebuild. Clamping is the kinder contract: the column
 * is a triangular prism instead of an exception.
 */
export function prismSlices(diskResolution?: number): number {
  const n = Math.floor(diskResolution ?? 20);
  return Number.isFinite(n) && n >= 3 ? n : 3;
}
