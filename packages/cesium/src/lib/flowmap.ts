// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly + arrow geometry for the `flowmap` kind — the CPU
 * builder behind {@link STTFlowmapLayer}.
 *
 * ## What this renders, and why it is not `arc` or `line`
 * A flowmap feature is an origin→destination FLOW: a LineString whose first
 * vertex is the origin and whose last is the destination, carrying a magnitude
 * that varies over the archive's time buckets. deck's `FlowmapLayer` draws each
 * one as a flowmap.gl-style **tapered half-arrow** — a shaft that thickens from
 * tail to head plus a wide arrowhead — because the arrowhead is what makes the
 * DIRECTION of an OD pair readable and the taper is what makes a hundred
 * overlapping corridors legible. Degrading the kind to `line` throws both away:
 * `A→B` and `B→A` collapse onto one indistinguishable stroke.
 *
 * So this module builds real ribbon geometry:
 *
 * ```text
 *            tail (thin)                 head base            apex
 *   O  >------------------------------<        ^  ^             > D
 *      \__ shaft quads, width lerped __/        \__ head __/
 *          tailWidthRatio·w  →  w              headWidthRatio·w
 * ```
 *
 * - The shaft is `shaftSegments` quads along the origin→destination chord, each
 *   vertex pushed sideways by the LOCAL east-north-up left-normal at that point
 *   ({@link enuPerpendicularShift}, shared with the `flowStroke` builder). A
 *   degree-space perpendicular would skew every non-equatorial arrow by the
 *   aspect ratio of the graticule; the ENU rotation is the honest one.
 * - The head is one triangle: two base corners at `±headWidthRatio·w/2` and an
 *   apex ON the destination.
 * - Every vertex is then projected to ABSOLUTE f64 ECEF metres through a
 *   WGS84 {@link GlobeProjection} — no RTC, because `Cartesian3` is f64 and
 *   Cesium's native frame IS WGS84 ECEF.
 *
 * ## The twin ribbon
 * `A→B` and `B→A` are separate features with reversed endpoints. A CONSTANT
 * signed lateral `gapMeters` therefore separates them with no pairing logic:
 * reversing the endpoints flips the tangent, which flips the left-normal, which
 * flips the shift. Same trick, same reasoning, as `lib/flow-strokes.ts`.
 *
 * ## Magnitude → width
 * The per-bucket magnitude is sampled at a FRACTIONAL bucket position through
 * the sampling primitives that already exist in `lib/flow-strokes.ts`
 * ({@link bucketPositionAt} / {@link bucketBlendAt} / {@link strokeWidthFromPeak}
 * / {@link flowStrokeSubStep}) — reused, not re-implemented, so a flowmap arrow
 * and a flow stroke agree about what "the flow at 08:37" means. A magnitude at
 * or below `minFlow` yields width `0`, which drops the arrow entirely: the
 * "inactive ⇒ invisible" pulse is the point of the kind.
 *
 * ## Deliberate non-goals (documented deviations, not silent ones)
 * - **Widths are METRES, not screen pixels.** deck sizes flowmap arrows in
 *   pixels, so they hold a constant on-screen thickness at every zoom. Cesium
 *   has no screen-space extrusion for an arbitrary triangle mesh, so the width
 *   is baked into world-space geometry via
 *   {@link FlowmapBuildOptions.metersPerPixel}: correct at the reference scale,
 *   thinner-looking as you zoom out. Sizing it in pixels would need the whole
 *   mesh re-uploaded on every camera move, not merely on every bucket.
 * - **One colour per arrow, never per-vertex.** Cesium's per-instance batch
 *   table is one RGBA per instance, so deck's `getSourceColor`→`getTargetColor`
 *   gradient collapses to a single colour — the same deviation the batched
 *   polyline layers already document. What DOES follow the magnitude is the
 *   colour's ALPHA ({@link flowmapColorAt}).
 * - **Straight chords, not great circles.** flowmap.gl draws straight OD
 *   arrows and so does this; the chord is subdivided in lon/lat so it hugs the
 *   ground rather than tunnelling, but it is not a geodesic. For the
 *   city/region-scale OD matrices this kind is for, the two are the same line.
 * - **No node circles.** deck's `FlowmapLayer` also pulses a circle at each
 *   station sized by incident flow. That is a second primitive with its own
 *   aggregation and is not built here; the arrows alone carry the kind.
 * - **`liveBundling` is out of scope** — deck's `BundledFlowmapLayer` is a
 *   separate capability, not a mode of this one.
 *
 * Zero Cesium imports: unit-testable in plain Node.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';
import {
  M_PER_DEG_LAT,
  axisFor,
  bucketBlendAt,
  bucketPositionAt,
  enuPerpendicularShift,
  strokeWidthFromPeak,
  type BucketAxis,
  type BucketBlend,
  type FlowStrokeWidthOptions,
} from './flow-strokes.js';

// One WGS84 globe for every build. Byte-identical to the polyline/flow-stroke
// builders' GLOBE — `project` is anchor-independent, so the duplication is
// intentional (each pure module stays self-contained). The class default is
// 'sphere', which mis-registers against Cesium's real ellipsoid by up to ~20 km
// at mid-latitudes, so the datum is always spelled out.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEFAULT_COLOR: RGBA255 = [90, 160, 255, 235];

/** Metres of arrow width per unit of {@link strokeWidthFromPeak}'s pixel width. */
export const DEFAULT_METERS_PER_PIXEL = 30;
/** Lateral separation of a twin pair, in units of the arrow's reference width. */
export const DEFAULT_GAP_WIDTHS = 0.65;
/** Shaft width at the tail, as a fraction of the head-base width. */
export const DEFAULT_TAIL_WIDTH_RATIO = 0.3;
/** Arrowhead base width, as a multiple of the shaft's head-base width. */
export const DEFAULT_HEAD_WIDTH_RATIO = 2.6;
/** Arrowhead length, as a multiple of its base width. */
export const DEFAULT_HEAD_LENGTH_RATIO = 1.15;
/** Hard cap on the head length as a fraction of the whole flow — a short flow must not be all head. */
export const DEFAULT_MAX_HEAD_FRACTION = 0.45;
/** Shaft subdivisions; > 1 keeps a long chord on the ground instead of through it. */
export const DEFAULT_SHAFT_SEGMENTS = 8;
/** Alpha floor for a barely-flowing arrow, so it dims rather than vanishing mid-shape. */
export const DEFAULT_MIN_MAGNITUDE_ALPHA = 0.35;

/**
 * Column names probed for a per-feature flow magnitude when a tile carries no
 * per-bucket `vertexValueMatrix`. First match wins; `flowProperty` overrides
 * the probe entirely. Kept in the same order as deck's `FlowmapLayer`, which is
 * the compatibility contract — an archive that animates under deck must animate
 * here, and one that is static there must be static here.
 */
export const FLOW_COLUMN_CANDIDATES = [
  'flow',
  'count',
  'volume',
  'trips',
  'value',
  'weight',
] as const;

export interface FlowmapBuildOptions extends FlowStrokeWidthOptions {
  /** Per-feature colour mode. @default a constant blue */
  color?: FeatureColorMode;
  /**
   * Per-feature numeric column carrying the flow magnitude, used for archives
   * built WITHOUT the per-bucket `vertexValueMatrix` (a STATIC flowmap). Ignored
   * when the tile does carry the matrix. Unset auto-detects the first of
   * {@link FLOW_COLUMN_CANDIDATES} present.
   */
  flowProperty?: string | null;
  /** Metres added to every vertex's altitude, to lift arrows off the terrain. @default 0 */
  zLift?: number;
  /** Metres of world-space width per pixel of {@link strokeWidthFromPeak} output. @default 30 */
  metersPerPixel?: number;
  /** Lateral twin separation in reference widths; 0 puts both directions on the centreline. @default 0.65 */
  gapWidths?: number;
  /** Shaft width at the tail as a fraction of the head-base width. @default 0.3 */
  tailWidthRatio?: number;
  /** Arrowhead base width as a multiple of the shaft width. @default 2.6 */
  headWidthRatio?: number;
  /** Arrowhead length as a multiple of its base width. @default 1.15 */
  headLengthRatio?: number;
  /** Cap on head length as a fraction of the flow's length. @default 0.45 */
  maxHeadFraction?: number;
  /** Shaft subdivisions along the chord. @default 8 */
  shaftSegments?: number;
  /** Alpha multiplier at zero flow (1 disables magnitude-driven alpha). @default 0.35 */
  minMagnitudeAlpha?: number;
}

/** One origin→destination flow, with the magnitude row its arrow breathes off. */
export interface FlowmapFlow {
  srcLon: number;
  srcLat: number;
  srcAlt: number;
  tgtLon: number;
  tgtLat: number;
  tgtAlt: number;
  /** Magnitude per time bucket (length === {@link FlowmapBuild.numBuckets}). */
  magnitudes: Float32Array;
  /** All-bucket max — the flow's rush-hour magnitude; sizes the constant twin gap. */
  refMagnitude: number;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Base colour (0–255 channels). */
  color: RGBA255;
  /** Origin lon/lat, for `SttPickResult.coordinate`. */
  lon: number;
  lat: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built flow set, rebased to one scene-wide time origin. */
export interface FlowmapBuild {
  flows: FlowmapFlow[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
  /** The global bucket axis, or `null` for a static (column-driven) flowmap. */
  axis: BucketAxis | null;
  /** Columns in every {@link FlowmapFlow.magnitudes} row; `1` when static. */
  numBuckets: number;
}

/** Triangle-mesh arrow: absolute ECEF positions (x,y,z interleaved) + indices. */
export interface ArrowRibbon {
  positions: Float64Array;
  indices: Uint16Array;
  /** Width in metres the mesh was baked at — carried for diagnostics/tests. */
  widthMeters: number;
}

/** A LineString layer with at least the two endpoints an OD flow needs. */
function isODLayer(b: BinaryFeatures): boolean {
  return (
    b.featureCount > 0 &&
    b.geometryType === GeometryType.LineString &&
    !!b.startIndices
  );
}

/**
 * The per-feature flow column for a tile with no bucket matrix: the caller's
 * `flowProperty` when set, else the first {@link FLOW_COLUMN_CANDIDATES} hit.
 * `null` means the archive carries no usable magnitude at all, and the builder
 * skips the layer rather than drawing a fleet of zero-width arrows.
 */
export function resolveFlowColumn(
  binary: BinaryFeatures,
  flowProperty?: string | null,
): ArrayLike<number> | null {
  const numeric = binary.numericProps ?? {};
  if (flowProperty) return numeric[flowProperty] ?? null;
  for (const name of FLOW_COLUMN_CANDIDATES) {
    const col = numeric[name];
    if (col) return col;
  }
  return null;
}

/**
 * The flow's magnitude at a blended bucket position — the same convex
 * `(1-f)·a + f·b` two-column blend `flowStroke` uses, so the two kinds agree at
 * every sub-bucket instant. A degenerate axis blends to column 0.
 */
export function flowMagnitudeAt(
  flow: FlowmapFlow,
  numBuckets: number,
  blend: BucketBlend,
): number {
  const m = flow.magnitudes;
  if (numBuckets <= 0 || m.length === 0) return 0;
  const { b0, b1, f } = blend;
  const a = m[Math.min(b0, m.length - 1)];
  if (f <= 0) return a;
  return a * (1 - f) + m[Math.min(b1, m.length - 1)] * f;
}

/**
 * `magnitude → arrow width in METRES`. Delegates the exponent/scale/pixel-clamp
 * curve to `flowStroke`'s {@link strokeWidthFromPeak} (identical response for
 * identical data) and converts the pixel result to world metres — see the
 * "widths are metres" deviation in the module header. A width of exactly `0`
 * means "do not draw this arrow".
 */
export function arrowWidthMeters(
  magnitude: number,
  opts: FlowmapBuildOptions = {},
): number {
  const px = strokeWidthFromPeak(magnitude, opts);
  if (px <= 0) return 0;
  return px * (opts.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL);
}

/**
 * Colour for an arrow at a given magnitude: the feature's base RGB with its
 * alpha scaled by the magnitude's share of the flow's own rush hour, floored at
 * {@link FlowmapBuildOptions.minMagnitudeAlpha} so a quiet-but-present corridor
 * dims instead of half-disappearing. (An ENTIRELY quiet corridor is already
 * gone — {@link arrowWidthMeters} returned 0 and no geometry was built.)
 */
export function flowmapColorAt(
  flow: FlowmapFlow,
  magnitude: number,
  opts: FlowmapBuildOptions = {},
): RGBA255 {
  const base = flow.color;
  const baseAlpha = base[3] ?? 255;
  const floor = opts.minMagnitudeAlpha ?? DEFAULT_MIN_MAGNITUDE_ALPHA;
  let t = flow.refMagnitude > 0 ? magnitude / flow.refMagnitude : 0;
  if (!(t > 0)) t = 0;
  else if (t > 1) t = 1;
  return [
    base[0],
    base[1],
    base[2],
    Math.round(baseAlpha * (floor + (1 - floor) * t)),
  ];
}

/** Great-circle-free chord length in metres, via the mid-latitude ENU scaling. */
function chordMeters(flow: FlowmapFlow): {
  meters: number;
  dLon: number;
  dLat: number;
} {
  const dLon = flow.tgtLon - flow.srcLon;
  const dLat = flow.tgtLat - flow.srcLat;
  const midLat = (flow.srcLat + flow.tgtLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const safeCos = Math.abs(cosLat) < 1e-9 ? 1e-9 : cosLat;
  const east = dLon * safeCos * M_PER_DEG_LAT;
  const north = dLat * M_PER_DEG_LAT;
  return { meters: Math.hypot(east, north), dLon, dLat };
}

/**
 * Bake one arrow: `shaftSegments` tapered quads plus the head triangle, all in
 * absolute ECEF metres. `gapMeters` is the SIGNED lateral shift applied to every
 * vertex (the twin-ribbon separation).
 *
 * Returns `null` for a zero width or a zero-length flow (a self-loop has no
 * tangent to be perpendicular to, so there is no arrow to draw) — the caller
 * drops it rather than emitting a degenerate instance.
 */
export function buildArrowRibbon(
  flow: FlowmapFlow,
  widthMeters: number,
  opts: FlowmapBuildOptions = {},
  gapMeters = 0,
): ArrowRibbon | null {
  if (!(widthMeters > 0)) return null;
  const { meters: length, dLon, dLat } = chordMeters(flow);
  if (!(length > 0)) return null;

  const segs = Math.max(
    1,
    Math.floor(opts.shaftSegments ?? DEFAULT_SHAFT_SEGMENTS),
  );
  const tailRatio = opts.tailWidthRatio ?? DEFAULT_TAIL_WIDTH_RATIO;
  const headWidth =
    widthMeters * (opts.headWidthRatio ?? DEFAULT_HEAD_WIDTH_RATIO);
  const headLen = Math.min(
    headWidth * (opts.headLengthRatio ?? DEFAULT_HEAD_LENGTH_RATIO),
    length * (opts.maxHeadFraction ?? DEFAULT_MAX_HEAD_FRACTION),
  );
  const zLift = opts.zLift ?? 0;
  // Where the shaft stops and the head begins, as a fraction of the chord.
  const uHead = 1 - headLen / length;

  const shaftVerts = 2 * (segs + 1);
  const positions = new Float64Array((shaftVerts + 3) * 3);
  const shift: [number, number] = [0, 0];

  const put = (i: number, u: number, lateral: number): void => {
    const lon = flow.srcLon + dLon * u;
    const lat = flow.srcLat + dLat * u;
    const alt = flow.srcAlt + (flow.tgtAlt - flow.srcAlt) * u + zLift;
    // The lateral push is taken in the LOCAL east-north-up frame at THIS vertex.
    // An identity/degree-space rotation would point the offset at the ECEF pole:
    // right at the equator, visibly skewed anywhere else.
    enuPerpendicularShift(lon, lat, dLon, dLat, lateral, shift);
    const [x, y, z] = GLOBE.project(shift[0], shift[1], alt);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  };

  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const u = uHead * s;
    const half = (widthMeters * (tailRatio + (1 - tailRatio) * s)) / 2;
    put(i * 2, u, gapMeters + half);
    put(i * 2 + 1, u, gapMeters - half);
  }
  put(shaftVerts, uHead, gapMeters + headWidth / 2);
  put(shaftVerts + 1, uHead, gapMeters - headWidth / 2);
  put(shaftVerts + 2, 1, gapMeters);

  const indices = new Uint16Array(segs * 6 + 3);
  let k = 0;
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices[k++] = a;
    indices[k++] = a + 1;
    indices[k++] = a + 2;
    indices[k++] = a + 2;
    indices[k++] = a + 1;
    indices[k++] = a + 3;
  }
  indices[k++] = shaftVerts;
  indices[k++] = shaftVerts + 1;
  indices[k++] = shaftVerts + 2;

  return { positions, indices, widthMeters };
}

/**
 * Collect every origin→destination flow in `tiles`, with its per-bucket
 * magnitude row. Times are rebased to the first accepted layer's `timeOffset`,
 * mirroring `STTPointLayer`.
 *
 * Two magnitude sources, in priority order — the same order deck resolves:
 *  1. `vertexValueMatrix` (× `vertexValueBuckets` columns) → ANIMATED. The
 *     feature's row is the per-bucket MAX over its own vertices, matching
 *     `flowStroke`'s "busiest vertex" reduction. For a two-vertex OD flow the
 *     max is just the flow's own volume; for a routed corridor it is the
 *     bottleneck, which is what an OD arrow should be sized by.
 *  2. a per-feature numeric column → STATIC (one magnitude broadcast to every
 *     bucket, so the arrow never breathes but the map is not blank).
 *
 * A layer offering neither is skipped: an arrow with no magnitude has no width.
 */
export function buildFlowmapFlows(
  tiles: Tile[],
  opts: FlowmapBuildOptions = {},
): FlowmapBuild {
  // Pass 1 — accept layers, and let the FIRST matrix layer define the axis.
  const layers: BinaryFeatures[] = [];
  let numBuckets = 0;
  let axisLayer: BinaryFeatures | null = null;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!isODLayer(b)) continue;
      const nb = b.vertexValueBuckets ?? 0;
      const hasMatrix = nb > 0 && !!b.vertexValueMatrix;
      if (hasMatrix) {
        if (numBuckets === 0) {
          numBuckets = nb;
          axisLayer = b;
        } else if (nb !== numBuckets) {
          continue; // defensive: a dataset bakes ONE global axis
        }
      } else if (!resolveFlowColumn(b, opts.flowProperty)) {
        continue;
      }
      layers.push(b);
    }
  }
  if (layers.length === 0) {
    return { flows: [], timeOrigin: 0, axis: null, numBuckets: 0 };
  }

  const rows = numBuckets > 0 ? numBuckets : 1;
  const timeOrigin = layers[0].timeOffset;
  const colorMode: FeatureColorMode = opts.color ?? {
    type: 'constant',
    color: DEFAULT_COLOR,
  };
  const flows: FlowmapFlow[] = [];

  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const si = b.startIndices!;
    const matrix =
      numBuckets > 0 && (b.vertexValueBuckets ?? 0) === numBuckets
        ? (b.vertexValueMatrix ?? null)
        : null;
    const column = matrix ? null : resolveFlowColumn(b, opts.flowProperty);

    for (let f = 0; f < b.featureCount; f++) {
      const v0 = si[f];
      const v1 = si[f + 1];
      if (v1 - v0 < 2) continue; // an OD flow needs both ends

      const magnitudes = new Float32Array(rows);
      let refMagnitude = 0;
      if (matrix) {
        for (let v = v0; v < v1; v++) {
          const base = v * numBuckets;
          for (let bk = 0; bk < numBuckets; bk++) {
            const m = matrix[base + bk];
            if (m > magnitudes[bk]) magnitudes[bk] = m;
          }
        }
        for (let bk = 0; bk < rows; bk++) {
          if (magnitudes[bk] > refMagnitude) refMagnitude = magnitudes[bk];
        }
      } else {
        const raw = column ? column[f] : 0;
        const val = Number.isFinite(raw) ? raw : 0;
        magnitudes.fill(val);
        refMagnitude = val;
      }

      const sb = v0 * dims;
      const tb = (v1 - 1) * dims;
      flows.push({
        srcLon: b.positions[sb],
        srcLat: b.positions[sb + 1],
        srcAlt: dims > 2 ? b.positions[sb + 2] : 0,
        tgtLon: b.positions[tb],
        tgtLat: b.positions[tb + 1],
        tgtAlt: dims > 2 ? b.positions[tb + 2] : 0,
        magnitudes,
        refMagnitude,
        start: (b.startTimes ? b.startTimes[f] : 0) + rebase,
        end: (b.endTimes ? b.endTimes[f] : 0) + rebase,
        color: featureColor(b, f, colorMode),
        lon: b.positions[sb],
        lat: b.positions[sb + 1],
        binary: b,
        featureIndex: f,
      });
    }
  }

  return {
    flows,
    timeOrigin,
    axis: axisLayer ? axisFor(axisLayer) : null,
    numBuckets: rows,
  };
}

/**
 * Convenience for callers that hold only a build + a playhead: the blend to
 * sample at. Exported so the layer and its tests agree on the sampling chain
 * (`absolute ms → bucket position → clamped two-column blend`).
 */
export function flowmapBlendAt(
  build: FlowmapBuild,
  absoluteMs: number,
): BucketBlend {
  return bucketBlendAt(
    bucketPositionAt(build.axis, absoluteMs),
    build.numBuckets,
  );
}
