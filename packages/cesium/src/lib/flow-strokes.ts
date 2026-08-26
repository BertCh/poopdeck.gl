// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly + width math for the `flowStroke` kind — the
 * CPU builder behind {@link STTFlowStrokeLayer}.
 *
 * A flow tile carries a per-vertex x per-time-bucket volume matrix
 * (`BinaryFeatures.vertexValueMatrix`, `vertexValueBuckets` columns, flattened
 * globally vertex-major and aligned 1:1 with `positions`). The `flowCorridor`
 * kind animates COLOUR from it. A STROKE adds two things on top:
 *
 * ```text
 * width(corridor, t) = peak(corridor, t) ** widthExponent x widthScale, clamped to px
 * peak(corridor, t)  = max over the corridor's vertices of the two-bucket blend at t
 * peak <= minFlow    =>  width = 0 (invisible)          -- the per-hour pulse
 * offset(corridor)   = offsetWidths x refWidth, perpendicular, in the local ENU frame
 * ```
 *
 * **`max` after `blend`, never `blend` after `max`.** The busiest vertex is
 * resolved AT the blended bucket, not per column: for a convex blend
 * `(1-f)*a + f*b` the two differ whenever the argmax vertex migrates between
 * the adjacent columns (a corridor whose peak moves from one intersection to
 * the next through the hour). A per-corridor x per-bucket column max would be
 * O(corridors) per frame instead of O(vertices), but it is a strict UPPER
 * BOUND, not the value deck draws — so this module keeps the vertex rows and
 * blends them, exactly as deck does.
 *
 * ## The twin ribbon
 * `A->B` and `B->A` are SEPARATE corridors traversing the same street in
 * OPPOSITE vertex order. A CONSTANT signed perpendicular offset therefore
 * lands them on opposite sides of the centreline without any pairing logic:
 * reversing the vertex order flips the tangent, which flips the left-normal,
 * which flips the shift. That asymmetry — one ribbon fat, its twin thin — is
 * the whole point of the kind.
 *
 * The shift is computed in the LOCAL east-north-up frame at each vertex (rotate
 * the ENU tangent +90 deg to get the left normal, convert the metre delta back
 * to a lon/lat delta, then project). Over the few metres an offset spans, a
 * mean metres-per-degree is ample; see {@link M_PER_DEG_LAT}.
 *
 * ## Deliberate non-goals (documented deviations, not silent ones)
 * - **The offset is BAKED, in metres, at a reference width.** deck applies
 *   `getOffset` in the shader, in width units, so its ribbons re-separate every
 *   frame as the width breathes. A Cesium `PolylineCollection` has no
 *   screen-space vertex offset, so the separation would have to be re-uploaded
 *   as GEOMETRY every frame. Instead the offset is computed ONCE from the
 *   corridor's ALL-BUCKET peak (its rush-hour width) and converted to metres
 *   via {@link FlowStrokeBuildOptions.offsetMetersPerPixel}. The ribbons hold a
 *   constant world-space gap: correct at the reference scale, and they neither
 *   overlap at the busy hour nor drift apart at the quiet one.
 * - **No per-vertex width taper.** deck's `flowStroke` can width each vertex
 *   from that vertex's own volume; a Cesium polyline's width is one scalar for
 *   the whole polyline, so the taper collapses to the busiest vertex.
 *
 * Zero Cesium imports: unit-testable in plain Node.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';

// One WGS84 globe for every build. Byte-identical to the polyline builders'
// GLOBE — the duplication is intentional and `project` is anchor-independent.
// The class default is 'sphere', which mis-registers against Cesium's real
// ellipsoid by up to ~20 km at mid-latitudes.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

/**
 * Mean metres per degree of latitude. The perpendicular offset is a handful of
 * metres, so the 0.5% swing between the polar and equatorial radii is far below
 * the width of the line it shifts; a mean is ample and keeps the ENU hop
 * allocation-free. (Positions themselves go through the real WGS84 ellipsoid —
 * only the small lateral DELTA uses this.)
 */
export const M_PER_DEG_LAT = 111_320;

/** sqrt — area-proportional, the cartographic default (deck `widthExponent`). */
export const DEFAULT_WIDTH_EXPONENT = 0.5;

/** deck `FlowStrokeLayer.defaultProps.offsetWidths`. */
export const DEFAULT_OFFSET_WIDTHS = 0.6;

/**
 * Cross-fade granularity in fractions of a bucket, mirroring deck
 * `FlowCorridorLayer.STEP`. `0.5` => two width recomputes per bucket.
 */
export const FLOW_STROKE_SUB_STEP = 0.5;

const DEFAULT_COLOR: RGBA255 = [200, 205, 215, 255];

/** The global time-bucket axis a flow dataset bakes. */
export interface BucketAxis {
  numBuckets: number;
  /** Absolute ms of bucket 0's leading edge. */
  bucket0Abs: number;
  /** Bucket duration in ms. */
  bucketWidth: number;
}

/** The two adjacent bucket columns + blend fraction for a stepped position. */
export interface BucketBlend {
  b0: number;
  /** Upper column, clamped to the last one. */
  b1: number;
  /** Fraction of `b1`. `<= 0` reads `b0` alone. */
  f: number;
}

/** Width/offset knobs. Names and defaults mirror deck's `FlowStrokeLayer`. */
export interface FlowStrokeWidthOptions {
  /** Width = `peak ** widthExponent`. @default 0.5 (sqrt) */
  widthExponent?: number;
  /** Corridors whose active-bucket peak is `<= minFlow` collapse to 0. @default 0 */
  minFlow?: number;
  /** Multiplier applied AFTER the exponent (deck `widthScale`). @default 1 */
  widthScale?: number;
  /** Lower clamp in CSS px, applied after the scale. @default 0 */
  minWidthPx?: number;
  /** Upper clamp in CSS px, applied after the scale. @default unbounded */
  maxWidthPx?: number;
}

export interface FlowStrokeBuildOptions extends FlowStrokeWidthOptions {
  /** Per-corridor base colour. @default constant opaque grey */
  color?: FeatureColorMode;
  /** Constant altitude lift in metres (keeps ground decals off the ellipsoid). @default 0 */
  zLift?: number;
  /**
   * Perpendicular offset as a multiple of the corridor's REFERENCE width.
   * Positive shifts LEFT of the direction of travel; negative shifts right
   * (the right-hand-traffic convention). `0` disables the twin ribbon and
   * both directions ride the centreline. @default 0.6
   */
  offsetWidths?: number;
  /**
   * Metres per CSS pixel used to bake the pixel-space offset into world-space
   * geometry. Pick the metres-per-pixel of the zoom the demo sits at (~2 at
   * z15, street scale). @default 2
   */
  offsetMetersPerPixel?: number;
}

/** One renderable stroke: offset ECEF vertices + the volume rows that drive it. */
export interface FlowStrokeCorridor {
  /** Absolute, ALREADY-OFFSET ECEF positions, x,y,z interleaved (metres). >= 2 vertices. */
  positions: Float64Array;
  /** `vertexCount x numBuckets` volume rows, vertex-major, copied out of the tile. */
  values: Float32Array;
  vertexCount: number;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Base colour (0-255 channels); alpha animates as `base.a x timeFilterAlpha`. */
  color: RGBA255;
  /** Peak volume over EVERY bucket — the reference the baked offset was sized by. */
  refPeak: number;
  /** The reference width (px) `refPeak` produced, i.e. the corridor's busiest hour. */
  refWidth: number;
  /** Metres this corridor was shifted perpendicular to travel (signed). */
  offsetMeters: number;
  /** Pick coordinate: the first vertex, BEFORE the offset. */
  lon: number;
  lat: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built stroke set, rebased to one scene-wide time origin. */
export interface FlowStrokeBuild {
  corridors: FlowStrokeCorridor[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
  /** Global bucket axis, or `null` when no tile carried a usable matrix. */
  axis: BucketAxis | null;
  numBuckets: number;
}

/**
 * A tile layer carrying a usable flow matrix. Kept in lockstep with the
 * `flowCorridor` builder's predicate: the two MUST agree or a stroke would
 * width a corridor the parent kind never drew.
 */
function isFlowLayer(b: BinaryFeatures): boolean {
  const nb = b.vertexValueBuckets ?? 0;
  return (
    b.featureCount > 0 &&
    b.geometryType === GeometryType.LineString &&
    !!b.startIndices &&
    nb > 0 &&
    !!b.vertexValueMatrix
  );
}

/**
 * Derive the global bucket axis from a flow layer's feature-0 `[start,end]`:
 * the dataset bakes ONE axis, and feature 0's window spans it.
 */
export function axisFor(b: BinaryFeatures): BucketAxis | null {
  const nb = b.vertexValueBuckets ?? 0;
  if (nb <= 0 || !b.startTimes || b.startTimes.length === 0 || !b.endTimes)
    return null;
  const rel0 = b.startTimes[0];
  const span = b.endTimes[0] - rel0;
  if (span <= 0) return null;
  return {
    numBuckets: nb,
    bucket0Abs: b.timeOffset + rel0,
    bucketWidth: span / nb,
  };
}

/**
 * Continuous bucket position of an absolute playhead. Bucket `b` is sampled at
 * its LEADING edge, so `bucket0Abs` maps to `0` exactly; {@link bucketBlendAt}
 * clamps the ends. Returns `0` for a null/degenerate axis rather than NaN,
 * which would index the matrix wildly.
 */
export function bucketPositionAt(
  axis: BucketAxis | null,
  absoluteMs: number,
): number {
  if (!axis || !(axis.bucketWidth > 0)) return 0;
  const pos = (absoluteMs - axis.bucket0Abs) / axis.bucketWidth;
  return Number.isFinite(pos) ? pos : 0;
}

/**
 * Resolve the bucket columns to blend for a continuous position (clamped to
 * `[0, numBuckets - 1]`). At the last column `b1 === b0`, so the blend
 * degenerates to a plain read.
 */
export function bucketBlendAt(
  stepped: number,
  numBuckets: number,
): BucketBlend {
  if (numBuckets <= 0) return { b0: 0, b1: 0, f: 0 };
  const max = numBuckets - 1;
  // `!(x > 0)` also catches NaN.
  let pos = stepped;
  if (!(pos > 0)) pos = 0;
  else if (pos > max) pos = max;
  const b0 = Math.floor(pos);
  const b1 = Math.min(b0 + 1, max);
  return { b0, b1, f: pos - b0 };
}

/**
 * The corridor's BUSIEST-vertex volume at a blended bucket position — the
 * `max` OF the `blend`. An empty corridor (or one whose whole row is
 * non-positive) peaks at `0`, which {@link strokeWidthFromPeak} collapses.
 */
export function corridorPeakAt(
  corridor: FlowStrokeCorridor,
  numBuckets: number,
  blend: BucketBlend,
): number {
  if (numBuckets <= 0) return 0;
  const { values, vertexCount } = corridor;
  const { b0, b1, f } = blend;
  let peak = 0;
  if (f <= 0) {
    for (let v = 0; v < vertexCount; v++) {
      const m = values[v * numBuckets + b0];
      if (m > peak) peak = m;
    }
    return peak;
  }
  const g = 1 - f;
  for (let v = 0; v < vertexCount; v++) {
    const base = v * numBuckets;
    const m = values[base + b0] * g + values[base + b1] * f;
    if (m > peak) peak = m;
  }
  return peak;
}

/**
 * `peak -> rendered width in CSS px`: the exponent, then the scale, then the
 * pixel clamp. A peak at or below `minFlow` returns EXACTLY `0` and BYPASSES
 * the `minWidthPx` floor — "inactive => invisible" is the point of the pulse,
 * so a floor must never resurrect a quiet corridor at 1 px. A non-positive peak
 * collapses the same way, which also keeps `Math.pow` off its NaN branch for
 * fractional exponents.
 */
export function strokeWidthFromPeak(
  peak: number,
  opts: FlowStrokeWidthOptions = {},
): number {
  const minFlow = opts.minFlow ?? 0;
  if (!(peak > minFlow) || peak <= 0) return 0;
  const width =
    Math.pow(peak, opts.widthExponent ?? DEFAULT_WIDTH_EXPONENT) *
    (opts.widthScale ?? 1);
  const lo = opts.minWidthPx ?? 0;
  const hi = opts.maxWidthPx ?? Number.MAX_SAFE_INTEGER;
  if (width < lo) return lo;
  if (width > hi) return hi;
  return width;
}

/**
 * The sub-step GATE: the quantized index of a continuous bucket position.
 * Mirrors deck's `Math.round(pos / STEP)` re-expansion gate. Here it is what
 * bounds the per-frame CPU cost of the `max`-over-vertices reduction: the
 * widths are recomputed only when the playhead crosses a sub-step, while the
 * time-filter ALPHA still updates every frame.
 */
export function flowStrokeSubStep(
  bucketPos: number,
  step: number = FLOW_STROKE_SUB_STEP,
): number {
  if (!(step > 0)) return 0;
  return Math.round(bucketPos / step);
}

/** The bucket position a sub-step index stands for (deck's `stepped`). */
export function steppedBucketPos(
  subStep: number,
  step: number = FLOW_STROKE_SUB_STEP,
): number {
  return subStep * step;
}

/**
 * Signed perpendicular lon/lat shift of one vertex, in the LOCAL east-north-up
 * frame. `(dLonDeg, dLatDeg)` is the tangent BEFORE metre scaling; the east
 * component is scaled by `cos(lat)` on the way in and unscaled on the way out,
 * which is what makes the rotation a true ENU rotation rather than a
 * degree-space one (those differ by the aspect ratio of the graticule and would
 * skew every non-equatorial offset).
 *
 * Rotating the ENU tangent +90 deg gives the LEFT normal `(-north, east)`.
 * Writes into `out` and returns it; a degenerate (zero-length) tangent leaves
 * the vertex untouched.
 */
export function enuPerpendicularShift(
  lon: number,
  lat: number,
  dLonDeg: number,
  dLatDeg: number,
  meters: number,
  out: [number, number] = [0, 0],
): [number, number] {
  out[0] = lon;
  out[1] = lat;
  if (meters === 0 || !Number.isFinite(meters)) return out;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Guard the poles: cos -> 0 makes the inverse hop explode.
  const safeCos = Math.abs(cosLat) < 1e-9 ? 1e-9 : cosLat;
  const east = dLonDeg * safeCos;
  const north = dLatDeg;
  const len = Math.hypot(east, north);
  if (!(len > 0)) return out;
  // Left normal of the unit tangent, times the signed offset (metres).
  const nEast = (-north / len) * meters;
  const nNorth = (east / len) * meters;
  out[0] = lon + nEast / (M_PER_DEG_LAT * safeCos);
  out[1] = lat + nNorth / M_PER_DEG_LAT;
  return out;
}

/**
 * Build one offset ECEF stroke per flow corridor, carrying the volume rows the
 * per-frame width reduction needs. Single-vertex features are skipped — a
 * stroke needs two ends and a tangent to be perpendicular to. Times are rebased
 * to the first accepted layer's `timeOffset`, mirroring `STTPointLayer`.
 */
export function buildFlowStrokes(
  tiles: Tile[],
  opts: FlowStrokeBuildOptions = {},
): FlowStrokeBuild {
  // Pass 1 — accept the layers that agree with the first one's bucket count
  // (defensive; a dataset bakes a single global axis).
  const layers: BinaryFeatures[] = [];
  let numBuckets = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!isFlowLayer(b)) continue;
      const nb = b.vertexValueBuckets ?? 0;
      if (numBuckets === 0) numBuckets = nb;
      else if (nb !== numBuckets) continue;
      layers.push(b);
    }
  }
  if (layers.length === 0 || numBuckets === 0) {
    return { corridors: [], timeOrigin: 0, axis: null, numBuckets: 0 };
  }

  const timeOrigin = layers[0].timeOffset;
  const colorMode: FeatureColorMode = opts.color ?? {
    type: 'constant',
    color: DEFAULT_COLOR,
  };
  const zLift = opts.zLift ?? 0;
  const offsetWidths = opts.offsetWidths ?? DEFAULT_OFFSET_WIDTHS;
  const mPerPx = opts.offsetMetersPerPixel ?? 2;
  const corridors: FlowStrokeCorridor[] = [];
  const shift: [number, number] = [0, 0];

  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const si = b.startIndices!;
    const matrix = b.vertexValueMatrix!;
    for (let f = 0; f < b.featureCount; f++) {
      const v0 = si[f];
      const v1 = si[f + 1];
      const nv = v1 - v0;
      if (nv < 2) continue;

      // Volume rows first: the reference peak sizes the offset, so it has to be
      // known BEFORE any vertex is projected.
      const values = new Float32Array(nv * numBuckets);
      let refPeak = 0;
      for (let v = 0; v < nv; v++) {
        const src = (v0 + v) * numBuckets;
        const dst = v * numBuckets;
        for (let bk = 0; bk < numBuckets; bk++) {
          const m = matrix[src + bk];
          values[dst + bk] = m;
          if (m > refPeak) refPeak = m;
        }
      }
      const refWidth = strokeWidthFromPeak(refPeak, opts);
      const offsetMeters = offsetWidths * refWidth * mPerPx;

      const positions = new Float64Array(nv * 3);
      for (let v = 0; v < nv; v++) {
        const base = (v0 + v) * dims;
        const lon = b.positions[base];
        const lat = b.positions[base + 1];
        const alt = (dims > 2 ? b.positions[base + 2] : 0) + zLift;
        // Central difference inside, one-sided at the ends — so an endpoint's
        // normal matches its neighbouring segment's and the ribbon does not
        // splay open at the tips.
        const pPrev = (v0 + Math.max(0, v - 1)) * dims;
        const pNext = (v0 + Math.min(nv - 1, v + 1)) * dims;
        enuPerpendicularShift(
          lon,
          lat,
          b.positions[pNext] - b.positions[pPrev],
          b.positions[pNext + 1] - b.positions[pPrev + 1],
          offsetMeters,
          shift,
        );
        const [x, y, z] = GLOBE.project(shift[0], shift[1], alt);
        positions[v * 3] = x;
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = z;
      }

      corridors.push({
        positions,
        values,
        vertexCount: nv,
        start: (b.startTimes ? b.startTimes[f] : 0) + rebase,
        end: (b.endTimes ? b.endTimes[f] : 0) + rebase,
        color: featureColor(b, f, colorMode),
        refPeak,
        refWidth,
        offsetMeters,
        lon: b.positions[v0 * dims],
        lat: b.positions[v0 * dims + 1],
        binary: b,
        featureIndex: f,
      });
    }
  }

  return { corridors, timeOrigin, axis: axisFor(layers[0]), numBuckets };
}
