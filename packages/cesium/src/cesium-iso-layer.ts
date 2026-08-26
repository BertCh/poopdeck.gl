// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTIsoLayer` — iso-contour rendering for CesiumJS, the Cesium port of the
 * Three `STTIsoLayer` and of deck's `lidarIso` path mode.
 *
 * ## What it renders
 * One polyline per contour LineString, exactly as {@link STTPathLayer} would —
 * but with the styling that makes a contour plot READABLE rather than a pile of
 * anonymous lines:
 *
 *   1. **Level ramp.** Every contour's colour comes from its own iso VALUE (the
 *      numeric `levelProperty` column, default `'level'`) run through the
 *      kernel's ramp (`core/style` `rampColorAt`, reached via
 *      {@link featureColor}'s `'ramp'` mode). Low contours and high contours are
 *      different colours; that mapping IS the substance of the kind.
 *   2. **Major/minor emphasis.** Contours whose level is an integer multiple of
 *      `majorInterval` (cartography's *index* contours) are drawn wider than the
 *      rest, so the eye can count intervals between the heavy lines.
 *
 * Without this, `isoLines` degrades to plain `path`: the contours still draw,
 * but every one of them is the same colour and the same weight, which is the
 * information the kind exists to carry. That degradation is what this file
 * removes; the descriptor can now declare `isoLines` natively instead of naming
 * `path` as a fallback.
 *
 * ## Why TWO primitives
 * A Cesium `PolylineGeometry`'s `width` is BAKED INTO THE GEOMETRY at
 * construction (it becomes the extruded ribbon's half-width in the vertex
 * buffer) — unlike colour, which lives in the per-instance batch table and can
 * therefore animate. So there is no per-instance width, and "major contours are
 * wider" cannot be one primitive. Contours are grouped into ONE PRIMITIVE PER
 * WIDTH BUCKET: `minor` at `width`, `major` at `majorWidth`. Two buckets, two
 * draw-call groups, deliberately no more — an N-bucket width ramp would trade a
 * draw call per bucket for an emphasis nobody reads off a map.
 *
 * ## What it composes (and therefore does not re-implement)
 *   - geometry → `lib/polylines.ts` `buildPathPolylines`, the PURE, Cesium-free
 *     builder: `core/geo` `GlobeProjection(..., { datum: 'wgs84' })` (never the
 *     class's `'sphere'` default, which mis-registers against Cesium's real
 *     ellipsoid by ~20 km at mid-latitudes), absolute f64 ECEF metres with no
 *     RTC, geometry z honoured so a 3-D contour stack keeps its altitudes.
 *   - colour → `lib/feature-color.ts` `featureColor`, the same
 *     constant/categorical/ramp trichotomy every other Cesium layer uses.
 *   - primitive + per-frame animation + picking → {@link STTBatchedPolylineLayer}
 *     (batched `Primitive` of `PolylineGeometry` instances,
 *     `PolylineColorAppearance`, per-instance `ColorGeometryInstanceAttribute`).
 *     That is where the `timeOrigin` rebase, the module-level `SCRATCH_RGBA`,
 *     the per-entry `lastAlpha` seeded to `NaN`, and the `timeFilterAlpha`
 *     oracle call all live — this layer owns none of that math and duplicates
 *     none of it.
 *
 * The only NEW math here is level selection: which bucket a contour belongs to
 * and what domain the ramp spans. Those are the pure, Cesium-free functions
 * exported below ({@link isoLevelOf}, {@link isoLevelExtent},
 * {@link isMajorLevel}, {@link partitionIsoPolylines}, {@link applyLevelColors}).
 * This file's ONLY `cesium` import is `import type { Scene }`, which the
 * compiler erases — so those helpers run, and are unit-tested, in plain Node
 * with no Cesium object graph at all. No model matrix is used anywhere in this
 * layer, so the east-north-up-frame rule has nothing to bite on: every vertex is
 * already an absolute ECEF position.
 *
 * ## Deliberate non-goals (documented deviations, not silent approximations)
 *   - **No per-vertex colour.** Inherited from the batched polyline path:
 *     Cesium's batch-table animation has no per-vertex colour channel, so a
 *     contour is ONE colour along its whole length. Deck can gradient a contour
 *     along its own arc; this cannot, and does not pretend to.
 *   - **No `elevationProperty` / iso3d column.** Three's port lifts each ring by
 *     a numeric `z_layer` column. Here altitude comes from the geometry's own z
 *     (honoured automatically for 3-D tiles) plus a constant `zLift`. A
 *     per-feature elevation column would need a bespoke projection loop, which
 *     would mean forking `buildPathPolylines`; it is not supported rather than
 *     half-supported.
 *   - **No contour EXTRACTION.** This renders contours that are already in the
 *     archive as LineStrings. It does not marching-squares a density field into
 *     contours at load time — that is a build-time concern (`stt-build`), not a
 *     renderer one.
 *   - **No per-instance width.** See "Why TWO primitives". Width is
 *     two-valued by construction.
 *   - **Colour default differs from Three's port.** Three defaults to a
 *     CATEGORICAL `density_band` mapping. Here the default is a RAMP over the
 *     numeric level, because the ramp is what generalises past the AV
 *     density-band fixture. For byte-parity with the Three demo, pass an
 *     explicit `color: { type: 'categorical', property: 'density_band', ... }` —
 *     `color` overrides the level ramp wholesale while `levelProperty` keeps
 *     driving the major/minor split.
 */

import type { Scene } from 'cesium';
import type { Tile } from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import {
  STTBatchedPolylineLayer,
  type STTBatchedPolylineOptions,
} from './batched-polyline-layer.js';
import { buildPathPolylines } from './lib/polylines.js';
import type { FeaturePolyline, PolylineBuild } from './lib/polylines.js';
import { featureColor, type FeatureColorMode } from './lib/feature-color.js';

export interface STTIsoLayerOptions extends STTBatchedPolylineOptions {
  id?: string;
  /**
   * Numeric property holding each contour's iso VALUE. Drives both the colour
   * ramp and the major/minor split. @default 'level'
   */
  levelProperty?: string;
  /**
   * Ramp domain in level units. Omit to LATCH the domain from the first
   * non-empty build (see {@link isoLevelExtent}) — latched, not recomputed,
   * because a per-build domain would re-scale the ramp and visibly re-colour
   * every contour on the map each time a tile streams in. Pass an explicit
   * domain whenever the full level range is known up front.
   */
  levelDomain?: readonly [number, number];
  /** Ramp stops, low level → high level (0–255 channels). @default {@link DEFAULT_LEVEL_RAMP} */
  levelRange?: readonly RGBA255[];
  /** Colour for contours missing the level column. @default translucent grey */
  levelFallback?: RGBA255;
  /**
   * Overrides the level ramp entirely (constant / categorical / ramp). The
   * major/minor width split still follows `levelProperty`. @default undefined
   */
  color?: FeatureColorMode;
  /**
   * Contours at integer multiples of this level interval are drawn at
   * `majorWidth`. `0` (the default) disables the split — every contour is
   * minor and only one primitive is built. @default 0
   */
  majorInterval?: number;
  /**
   * How close to an exact multiple counts as major, as a FRACTION of
   * `majorInterval`. Contour levels are usually stored as f32, so an exact
   * equality test would silently classify `4.999999` as minor. @default 1e-6
   */
  majorTolerance?: number;
  /** Width of major contours in pixels. @default `width × 2` */
  majorWidth?: number;
  /** Constant altitude lift in metres (keeps ground contours off the ellipsoid). @default 0 */
  zLift?: number;
}

/**
 * Placeholder sequential ramp, cool → warm. Deliberately generic: a contour
 * ramp is a data-design decision (terrain, reflectivity and density all want
 * different ones), so this exists to make an un-configured layer READABLE, not
 * to be the right answer. Pass `levelRange` for anything real.
 */
export const DEFAULT_LEVEL_RAMP: readonly RGBA255[] = [
  [37, 68, 138, 235],
  [46, 148, 176, 235],
  [122, 194, 132, 235],
  [230, 200, 92, 235],
  [214, 96, 61, 235],
];

const DEFAULT_LEVEL_FALLBACK: RGBA255 = [170, 176, 188, 200];
/** Used only when the level column is absent everywhere, so nothing can latch. */
const FALLBACK_DOMAIN: readonly [number, number] = [0, 1];
const DEFAULT_LEVEL_PROPERTY = 'level';
const DEFAULT_MAJOR_TOLERANCE = 1e-6;

/**
 * The iso value of one built polyline, or `undefined` when the feature's tile
 * carries no such numeric column (or the stored value is not finite). Pure.
 */
export function isoLevelOf(
  p: FeaturePolyline,
  property: string,
): number | undefined {
  const col: Float32Array | undefined = p.binary.numericProps[property];
  if (!col) return undefined;
  const v = col[p.featureIndex];
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Min/max iso value across a built polyline set, or `null` when not one
 * polyline carries a finite level. A single-valued set is widened to
 * `[min, min + 1]`: a zero-width ramp domain is a divide-by-zero waiting to
 * happen, and one distinct level has nothing to interpolate anyway — it lands
 * on the ramp's first stop. Pure.
 */
export function isoLevelExtent(
  polylines: readonly FeaturePolyline[],
  property: string,
): readonly [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of polylines) {
    const v = isoLevelOf(p, property);
    if (v === undefined) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return null;
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/**
 * Is `level` an index (major) contour — an integer multiple of `interval`,
 * within `tolerance × interval`? A non-positive interval means "no major
 * contours"; an absent or non-finite level is never major. Pure.
 */
export function isMajorLevel(
  level: number | undefined,
  interval: number,
  tolerance: number = DEFAULT_MAJOR_TOLERANCE,
): boolean {
  if (level === undefined || !Number.isFinite(level)) return false;
  if (!(interval > 0) || !Number.isFinite(interval)) return false;
  const k = level / interval;
  if (!Number.isFinite(k)) return false;
  return Math.abs(k - Math.round(k)) <= Math.abs(tolerance);
}

export interface IsoPartitionOptions {
  levelProperty: string;
  majorInterval: number;
  majorTolerance?: number;
}

/**
 * Split one build into the two WIDTH buckets, both keeping the build's
 * `timeOrigin` so the two primitives animate off the same clock. Pure: it
 * allocates two new arrays and re-uses the polyline objects unchanged.
 */
export function partitionIsoPolylines(
  build: PolylineBuild,
  opts: IsoPartitionOptions,
): { minor: PolylineBuild; major: PolylineBuild } {
  const minor: FeaturePolyline[] = [];
  const major: FeaturePolyline[] = [];
  const tol = opts.majorTolerance ?? DEFAULT_MAJOR_TOLERANCE;
  for (const p of build.polylines) {
    const level = isoLevelOf(p, opts.levelProperty);
    if (isMajorLevel(level, opts.majorInterval, tol)) major.push(p);
    else minor.push(p);
  }
  return {
    minor: { polylines: minor, timeOrigin: build.timeOrigin },
    major: { polylines: major, timeOrigin: build.timeOrigin },
  };
}

/**
 * Re-resolve every polyline's base colour under `mode`. Runs over a build the
 * caller has JUST created and still solely owns, and REPLACES `p.color` rather
 * than mutating the array in place — `featureColor`'s constant branch hands
 * back the caller's own array by reference, so writing through it would
 * scribble on the options object. Pure with respect to everything except the
 * freshly-built polylines it is handed; Cesium-free.
 */
export function applyLevelColors(
  polylines: readonly FeaturePolyline[],
  mode: FeatureColorMode,
): void {
  for (const p of polylines) {
    p.color = featureColor(p.binary, p.featureIndex, mode);
  }
}

export class STTIsoLayer implements SttRenderNode {
  readonly id: string;
  /**
   * The two width buckets. `minor` is listed first and is the one `setTime`
   * delegates to first — the package's structural gate reads the first
   * statement of a delegating `setTime` body.
   */
  private readonly minor: STTBatchedPolylineLayer;
  private readonly major: STTBatchedPolylineLayer;
  private readonly opts: STTIsoLayerOptions;
  private readonly levelProperty: string;
  /** Latched on the first non-empty build when `levelDomain` is not supplied. */
  private latchedDomain: readonly [number, number] | null = null;

  constructor(scene: Scene, options: STTIsoLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-iso';
    this.opts = options;
    this.levelProperty = options.levelProperty ?? DEFAULT_LEVEL_PROPERTY;

    // Everything except width is shared: both buckets must animate under the
    // same time filter and interpolate their vertices the same way, or the
    // major contours would drift off the minor ones they annotate.
    const shared: STTBatchedPolylineOptions = {
      mode: options.mode,
      timeFilter: options.timeFilter,
      arcType: options.arcType,
    };
    const width = options.width ?? 2;
    // Distinct sub-ids so each bucket's `pick` claims only its OWN instances;
    // `pick` below re-labels the result with this layer's public id.
    this.minor = new STTBatchedPolylineLayer(scene, `${this.id}:minor`, {
      ...shared,
      width,
    });
    this.major = new STTBatchedPolylineLayer(scene, `${this.id}:major`, {
      ...shared,
      width: options.majorWidth ?? width * 2,
    });
  }

  /** (Re)build the contours from decoded tiles (replace-all). */
  setTiles(tiles: Tile[]): void {
    // 1. PURE BUILD FIRST. `buildPathPolylines` with no colour option yields a
    //    constant placeholder that `applyLevelColors` immediately overwrites;
    //    the placeholder is never rendered.
    const build = buildPathPolylines(tiles, { zLift: this.opts.zLift });

    // 2. BAIL ON EMPTY BEFORE ANY TEARDOWN — the hard rule. Selection reports an
    //    empty visible set for the frames between a viewport change and the
    //    first decoded tile of the new set; tearing down first turns that
    //    transient into a blank frame (the "tiles genuinely in view flash out"
    //    symptom). Holding the previous contours is safe even when the emptiness
    //    is permanent: they sit at their true ECEF positions, which the camera
    //    has by then left behind. It also leaves `latchedDomain` and both
    //    buckets' `timeOrigin` untouched, which is deliberate.
    if (build.polylines.length === 0) return;

    // 3. Resolve the ramp, latching an auto-domain exactly once.
    if (!this.opts.levelDomain && this.latchedDomain === null) {
      this.latchedDomain = isoLevelExtent(build.polylines, this.levelProperty);
    }
    const domain =
      this.opts.levelDomain ?? this.latchedDomain ?? FALLBACK_DOMAIN;
    const mode: FeatureColorMode = this.opts.color ?? {
      type: 'ramp',
      property: this.levelProperty,
      domain,
      range: this.opts.levelRange ?? DEFAULT_LEVEL_RAMP,
      fallback: this.opts.levelFallback ?? DEFAULT_LEVEL_FALLBACK,
    };
    applyLevelColors(build.polylines, mode);

    // 4. Split into width buckets and publish each.
    const split = partitionIsoPolylines(build, {
      levelProperty: this.levelProperty,
      majorInterval: this.opts.majorInterval ?? 0,
      majorTolerance: this.opts.majorTolerance,
    });
    this.publish(this.minor, split.minor);
    this.publish(this.major, split.major);
  }

  /**
   * Hand one bucket its share of a build.
   *
   * `STTBatchedPolylineLayer.setPolylines` refuses an empty build so a decode
   * gap never blanks the map — correct at the LAYER level, wrong at the BUCKET
   * level. By the time we get here the overall build is known non-empty, so an
   * empty bucket is not a decode gap: it means this viewport genuinely contains
   * no contours of that weight, and the bucket's standing primitive is stale
   * geometry the camera is still looking at. Clear it explicitly. (`dispose()`
   * is the batch's clear — it drops the primitive and the entries and leaves the
   * object reusable by the next `setPolylines`.)
   */
  private publish(bucket: STTBatchedPolylineLayer, build: PolylineBuild): void {
    if (build.polylines.length === 0) bucket.dispose();
    else bucket.setPolylines(build);
  }

  setTime(absoluteMs: number): void {
    this.minor.setTime(absoluteMs);
    this.major.setTime(absoluteMs);
  }

  /**
   * Hit-test both buckets. Each `STTBatchedPolylineLayer.pick` re-runs
   * `scene.pick`, which returns at most one instance, and each bucket rejects an
   * id that is not its own — so at most one of the two calls can hit. Two picks
   * per gesture is a user-gesture-rate cost, not a per-frame one. The bucket's
   * sub-id is an internal detail, so the result is re-labelled with this layer's
   * public `id`.
   */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const hit = this.minor.pick(cssX, cssY) ?? this.major.pick(cssX, cssY);
    return hit ? { ...hit, layerId: this.id } : null;
  }

  /**
   * Both buckets own only their own `Primitive` (which Cesium destroys on
   * removal, along with the `PolylineColorAppearance` constructed with it).
   * There is no externally-supplied `Material` or texture to release the way
   * `STTTripsLayer` has, so removing the two primitives is the whole teardown.
   */
  dispose(): void {
    this.minor.dispose();
    this.major.dispose();
    this.latchedDomain = null;
  }
}
