// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) CPU density field for the `heatmap` kind — the whole of the
 * maths behind `STTHeatmapLayer`, unit-testable in plain Node.
 *
 * WHAT IT COMPUTES, AND IN WHICH ORDER
 * ------------------------------------
 * A heatmap is a *density* estimate, not a scatter plot of coloured dots. The
 * pipeline is therefore strictly two-phase and the order is the entire point of
 * this file:
 *
 *   1. ACCUMULATE — {@link accumulateDensity} splats a compactly-supported
 *      kernel (Epanechnikov by default, truncated Gaussian on request) of
 *      radius `h` ADDITIVELY into a scalar `Float32Array` field. Nothing here
 *      knows about colour. Two coincident points deposit twice the density of
 *      one; ten deposit ten times.
 *   2. RAMP — {@link rampDensityField} maps that already-summed scalar through
 *      the colour range ONCE PER CELL, producing RGBA bytes.
 *
 * Doing it the other way round — sampling the palette per point and additively
 * blending the resulting COLOURS — sums *colours* rather than *density*. Two
 * overlapping mid-ramp splats then land near white instead of near the hot end
 * of the ramp, every dense region saturates to the same blown-out colour, and
 * the image stops being readable as a density at all. `test/heatmap-field.test.ts`
 * asserts the correct ordering directly (coincident points are hotter, and the
 * ramp is applied to the SUM), and pins the divergence from the naive
 * per-splat-colour path so a future refactor cannot quietly reintroduce it.
 *
 * TIME
 * ----
 * The field is a function of the playhead: a sample outside the time window
 * contributes EXACTLY ZERO density, not a faded colour. That is expressed by
 * the `alphas` argument — the caller (the layer) evaluates
 * `core/time-filter`'s `timeFilterAlpha` oracle per sample and passes the
 * result in, so every backend agrees on which features are "in window" while
 * this module stays free of time semantics *and* of Cesium. A fading feature
 * scales its own weight; a filtered-out one drops out of the sum entirely.
 *
 * METRIC SCALE
 * ------------
 * `radiusMeters` is resolved against real WGS84 geometry, not a spherical
 * approximation: {@link metresPerCell} projects the field centre and its
 * one-cell neighbours through `core/geo`'s `GlobeProjection` with an explicit
 * `{ datum: 'wgs84' }` and measures the ABSOLUTE f64 ECEF separation in metres
 * (no RTC anchor — Cesium consumes CPU doubles natively, so there is no f32
 * buffer to protect). The result is anisotropic: one cell of longitude is a
 * different number of metres from one cell of latitude everywhere except the
 * equator, which is exactly why the kernel below is elliptical in cell space.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * - **No GPU accumulation.** deck's `HeatmapLayer` splats into a float
 *   render-target and ramps in a fragment shader. Cesium exposes no
 *   render-to-texture splat pipeline to a primitive author, so this is a CPU
 *   field rebuilt on a time bucket rather than every frame. It is correct and
 *   it is honest, but it is NOT a GPU heatmap: cost is O(samples x kernel
 *   area) on the main thread, so `resolution` and `radius` are budget knobs.
 * - **No screen-space radius.** deck's `radiusPixels` is measured in *screen*
 *   pixels and so rescales with zoom for free. Here the field is a fixed
 *   geographic raster, so `radiusPixels` means "radius in FIELD cells" and
 *   `radiusMeters` means what it says. A documented deviation, not a silent one.
 * - **No antimeridian stitching.** Bounds are a plain lon/lat min/max box; a
 *   sample set straddling +/-180 degrees yields a world-spanning rectangle
 *   rather than two panels. Split the archive, or supply explicit `bounds`.
 * - **Point geometry only.** Line and polygon layers are ignored rather than
 *   silently reduced to centroids, which would invent density that is not in
 *   the data.
 */

import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';

// One WGS84 globe for every build — Cesium's native frame. Byte-identical to
// the point/polyline builders' GLOBE; `project` is anchor-independent, so the
// duplication across builder modules is intentional (see the authoring guide).
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

/** A lon/lat box (degrees) the density field is rasterised over. */
export interface HeatmapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** One weighted density sample: a point, its active window, and its weight. */
export interface HeatmapSample {
  lon: number;
  lat: number;
  /** Absolute ECEF position (metres) of the sample — f64, no RTC anchor. */
  x: number;
  y: number;
  z: number;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Density weight from the baked column; 1 when no weight column is set. */
  weight: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built sample set, rebased to one scene-wide time origin. */
export interface HeatmapBuild {
  samples: HeatmapSample[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
  /** Tight lon/lat extent of the samples; `null` when there are none. */
  bounds: HeatmapBounds | null;
}

export interface HeatmapBuildOptions {
  /**
   * Baked numeric column supplying each feature's density weight. When unset —
   * or when the column is missing, or the value is not finite — the weight is
   * `defaultWeight`, i.e. every feature counts once.
   */
  weightProperty?: string;
  /** Weight for features with no usable value. @default 1 */
  defaultWeight?: number;
}

/** Kernel shape. Both have COMPACT support: zero beyond the radius. */
export type HeatmapKernel = 'epanechnikov' | 'gaussian';

export interface DensityOptions {
  /** Raster extent. */
  bounds: HeatmapBounds;
  width: number;
  height: number;
  /** Kernel radius in FIELD CELLS. Ignored when `radiusMeters` is set. @default 12 */
  radiusPixels?: number;
  /** Kernel radius in metres on the ellipsoid; wins over `radiusPixels`. */
  radiusMeters?: number;
  /** @default 'epanechnikov' */
  kernel?: HeatmapKernel;
  /**
   * `'SUM'` accumulates weighted density (the heatmap default).
   * `'MEAN'` divides by the accumulated kernel mass, giving a weighted average
   * of the contributing weights — useful for "average value here", not density.
   * @default 'SUM'
   */
  aggregation?: 'SUM' | 'MEAN';
}

/** A scalar density raster. Row 0 is the NORTH edge (image convention). */
export interface DensityField {
  values: Float32Array;
  width: number;
  height: number;
  bounds: HeatmapBounds;
  /** Largest cell value in `values` (0 when the field is empty). */
  max: number;
  /** Kernel semi-axes actually used, in cells. */
  radiusX: number;
  radiusY: number;
  /** Number of samples that contributed non-zero density. */
  contributing: number;
}

/**
 * deck.gl's default heatmap colour range (6-step YlOrRd). Kept byte-identical
 * so a backend toggle between deck and Cesium does not change the palette.
 */
export const DEFAULT_COLOR_RANGE: RGBA255[] = [
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [240, 59, 32, 255],
  [189, 0, 38, 255],
];

export interface RampOptions {
  /** Palette stops, low density first. @default {@link DEFAULT_COLOR_RANGE} */
  colorRange?: RGBA255[];
  /** Explicit `[lo, hi]` density domain; defaults to `[0, field.max]`. */
  colorDomain?: [number, number];
  /** Multiplies the normalised density before the ramp. @default 1 */
  intensity?: number;
  /** Normalised density below which a cell is fully transparent. @default 0.05 */
  threshold?: number;
  /** Global opacity multiplier, 0..1. @default 1 */
  opacity?: number;
}

/** An RGBA raster ready to hand to a texture, plus the domain it was ramped over. */
export interface HeatmapRaster {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  domain: [number, number];
}

const EPS = 1e-12;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Every non-empty Point layer across `tiles`, in tile/layer order. */
export function collectHeatmapLayers(tiles: Tile[]): BinaryFeatures[] {
  const layers: BinaryFeatures[] = [];
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      if (
        layer.features.geometryType === GeometryType.Point &&
        layer.features.featureCount > 0
      ) {
        layers.push(layer.features);
      }
    }
  }
  return layers;
}

/**
 * Build one weighted sample per Point feature. Times are rebased to the first
 * Point layer's `timeOffset` (the scene-wide origin convention this package
 * uses everywhere). Returns an empty build (`timeOrigin: 0`, `bounds: null`)
 * when there are no Point features, so the layer can bail before adopting a
 * new origin.
 */
export function buildHeatmapSamples(
  tiles: Tile[],
  opts: HeatmapBuildOptions = {},
): HeatmapBuild {
  const pointLayers = collectHeatmapLayers(tiles);
  if (pointLayers.length === 0) {
    return { samples: [], timeOrigin: 0, bounds: null };
  }

  const timeOrigin = pointLayers[0].timeOffset;
  const fallback = opts.defaultWeight ?? 1;
  const samples: HeatmapSample[] = [];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const b of pointLayers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const weights = opts.weightProperty
      ? b.numericProps[opts.weightProperty]
      : undefined;

    for (let i = 0; i < b.featureCount; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const alt = dims > 2 ? b.positions[i * dims + 2] : 0;
      // Absolute f64 ECEF metres via the wgs84 datum — no RTC anchor.
      const [x, y, z] = GLOBE.project(lon, lat, alt);
      const raw = weights ? weights[i] : undefined;
      const weight = raw !== undefined && Number.isFinite(raw) ? raw : fallback;
      samples.push({
        lon,
        lat,
        x,
        y,
        z,
        start: b.startTimes[i] + rebase,
        end: b.endTimes[i] + rebase,
        weight,
        binary: b,
        featureIndex: i,
      });
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }

  if (samples.length === 0) return { samples, timeOrigin, bounds: null };
  return { samples, timeOrigin, bounds: { west, south, east, north } };
}

/**
 * Grow a box by `fraction` of each span (so kernels near the data edge are not
 * clipped by the raster edge) and guarantee a non-degenerate extent — a single
 * sample would otherwise produce a zero-area rectangle, which no geometry
 * backend can tessellate. Latitude is clamped to the valid range; longitude is
 * clamped to +/-180 without antimeridian stitching (see the file header).
 */
export function padHeatmapBounds(
  b: HeatmapBounds,
  fraction = 0.08,
  minSpanDeg = 0.002,
): HeatmapBounds {
  const lonSpan = Math.max(b.east - b.west, 0);
  const latSpan = Math.max(b.north - b.south, 0);
  const padLon = Math.max(lonSpan * fraction, minSpanDeg / 2);
  const padLat = Math.max(latSpan * fraction, minSpanDeg / 2);
  return {
    west: clamp(b.west - padLon, -180, 180),
    east: clamp(b.east + padLon, -180, 180),
    south: clamp(b.south - padLat, -90, 90),
    north: clamp(b.north + padLat, -90, 90),
  };
}

/**
 * Pick a raster size for `bounds` whose longest side is `resolution` cells and
 * whose cells are as close to square IN METRES as the box allows. Sizes are
 * clamped to a sane range: below ~8 the field is not a field, and above ~1024
 * a CPU splat stops being a per-bucket cost.
 */
export function fieldGridForBounds(
  bounds: HeatmapBounds,
  resolution = 256,
): { width: number; height: number } {
  const res = Math.round(clamp(resolution, 8, 1024));
  const midLat = (bounds.north + bounds.south) / 2;
  const lonSpan = Math.max(bounds.east - bounds.west, EPS);
  const latSpan = Math.max(bounds.north - bounds.south, EPS);
  // Metric aspect: a degree of longitude shrinks by cos(lat) toward the poles.
  const aspect = (lonSpan * Math.cos((midLat * Math.PI) / 180)) / latSpan;
  const width = aspect >= 1 ? res : Math.round(res * aspect);
  const height = aspect >= 1 ? Math.round(res / aspect) : res;
  return {
    width: Math.round(clamp(width, 8, 1024)),
    height: Math.round(clamp(height, 8, 1024)),
  };
}

/**
 * Metres spanned by one field cell in the x (east) and y (north) directions,
 * measured at the box centre by projecting through the wgs84 `GlobeProjection`
 * and taking the ABSOLUTE f64 ECEF separation. This is the reason
 * `radiusMeters` behaves at latitude: an equirectangular cell is anisotropic
 * everywhere except the equator, and a spherical datum would additionally
 * mis-scale by up to ~0.3%.
 */
export function metresPerCell(
  bounds: HeatmapBounds,
  width: number,
  height: number,
): { mx: number; my: number } {
  const cLon = (bounds.west + bounds.east) / 2;
  const cLat = (bounds.south + bounds.north) / 2;
  const dLon = (bounds.east - bounds.west) / Math.max(width, 1);
  const dLat = (bounds.north - bounds.south) / Math.max(height, 1);
  const p0 = GLOBE.project(cLon, cLat, 0);
  const px = GLOBE.project(cLon + dLon, cLat, 0);
  const py = GLOBE.project(cLon, clamp(cLat + dLat, -90, 90), 0);
  const dist = (a: number[], b: number[]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return {
    mx: Math.max(dist(p0, px), EPS),
    my: Math.max(dist(p0, py), EPS),
  };
}

/**
 * Kernel amplitude at squared normalised radius `t = (d/h)^2`. Both kernels
 * peak at 1 in the centre and are exactly 0 at and beyond `t = 1`, so the splat
 * loop can use a tight integer bounding box with no truncation artefact.
 *
 * - `epanechnikov`: `1 - t` — the minimum-variance density kernel, and the one
 *   that reads best as a heatmap because its shoulder is flat-ish.
 * - `gaussian`: `exp(-4.5 t) - exp(-4.5)`, renormalised so it still hits 0 at
 *   the radius. Sharper core, longer tail inside the support.
 */
export function kernelWeight(kind: HeatmapKernel, t: number): number {
  if (t >= 1 || t < 0) return t < 0 ? 1 : 0;
  if (kind === 'gaussian') {
    const tail = Math.exp(-4.5);
    return (Math.exp(-4.5 * t) - tail) / (1 - tail);
  }
  return 1 - t;
}

/**
 * PHASE 1 — additive accumulation. Splats every sample's kernel into a scalar
 * field; no colour is involved and none may be. `alphas[i]` scales sample `i`'s
 * weight: pass the time-filter oracle's output so an out-of-window sample
 * contributes exactly zero.
 */
export function accumulateDensity(
  samples: readonly HeatmapSample[],
  alphas: ArrayLike<number> | null,
  opts: DensityOptions,
): DensityField {
  const { bounds } = opts;
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const kernel = opts.kernel ?? 'epanechnikov';
  const mean = opts.aggregation === 'MEAN';
  const values = new Float32Array(width * height);
  const mass = mean ? new Float32Array(width * height) : null;

  let radiusX = opts.radiusPixels ?? 12;
  let radiusY = radiusX;
  if (opts.radiusMeters !== undefined && opts.radiusMeters > 0) {
    const { mx, my } = metresPerCell(bounds, width, height);
    radiusX = opts.radiusMeters / mx;
    radiusY = opts.radiusMeters / my;
  }
  // A sub-cell radius deposits into nothing; floor it at half a cell so a
  // point never silently vanishes from its own heatmap.
  radiusX = Math.max(radiusX, 0.5);
  radiusY = Math.max(radiusY, 0.5);

  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const empty: DensityField = {
    values,
    width,
    height,
    bounds,
    max: 0,
    radiusX,
    radiusY,
    contributing: 0,
  };
  if (!(Math.abs(lonSpan) > EPS) || !(Math.abs(latSpan) > EPS)) return empty;

  let contributing = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const a = alphas ? alphas[i] : 1;
    // Out of the window → ZERO density. Not a faded colour: absent from the sum.
    if (!(a > 0)) continue;
    const w = s.weight * a;
    if (!Number.isFinite(w) || w === 0) continue;

    // Cell-centre coordinates; row 0 is the NORTH edge so the raster can be
    // uploaded straight as an image (Cesium's Texture flips Y by default).
    const fx = ((s.lon - bounds.west) / lonSpan) * width - 0.5;
    const fy = ((bounds.north - s.lat) / latSpan) * height - 0.5;

    const x0 = Math.max(0, Math.ceil(fx - radiusX));
    const x1 = Math.min(width - 1, Math.floor(fx + radiusX));
    const y0 = Math.max(0, Math.ceil(fy - radiusY));
    const y1 = Math.min(height - 1, Math.floor(fy + radiusY));
    if (x1 < x0 || y1 < y0) continue;

    let deposited = false;
    for (let y = y0; y <= y1; y++) {
      const dy = (y - fy) / radiusY;
      const dy2 = dy * dy;
      if (dy2 >= 1) continue;
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        const dx = (x - fx) / radiusX;
        const t = dx * dx + dy2;
        if (t >= 1) continue;
        const k = kernelWeight(kernel, t);
        if (k <= 0) continue;
        values[row + x] += w * k; // ADDITIVE: density sums, colours do not
        if (mass) mass[row + x] += k;
        deposited = true;
      }
    }
    if (deposited) contributing++;
  }

  if (mass) {
    for (let i = 0; i < values.length; i++) {
      values[i] = mass[i] > EPS ? values[i] / mass[i] : 0;
    }
  }

  let max = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > max) max = values[i];
  }
  return { values, width, height, bounds, max, radiusX, radiusY, contributing };
}

/**
 * Sample the palette at normalised position `t` in 0..1 with linear
 * interpolation between stops (deck's colour texture filters linearly, so a
 * stepped lookup here would be a visible divergence).
 */
export function sampleColorRange(
  range: readonly RGBA255[],
  t: number,
): [number, number, number, number] {
  if (range.length === 0) return [0, 0, 0, 0];
  if (range.length === 1) {
    const c = range[0];
    return [c[0], c[1], c[2], c[3] ?? 255];
  }
  const p = clamp(t, 0, 1) * (range.length - 1);
  const i = Math.min(range.length - 2, Math.floor(p));
  const f = p - i;
  const lo = range[i];
  const hi = range[i + 1];
  return [
    lo[0] + (hi[0] - lo[0]) * f,
    lo[1] + (hi[1] - lo[1]) * f,
    lo[2] + (hi[2] - lo[2]) * f,
    (lo[3] ?? 255) + ((hi[3] ?? 255) - (lo[3] ?? 255)) * f,
  ];
}

/**
 * PHASE 2 — ramp the ALREADY-SUMMED field. One palette lookup per CELL, never
 * per splat. Cells at or below `threshold` are written fully transparent so the
 * raster does not tint the whole rectangle; above it, alpha ramps linearly from
 * the threshold to the top of the domain, approximating the alpha ramp deck
 * bakes into its colour texture.
 */
export function rampDensityField(
  field: DensityField,
  opts: RampOptions = {},
): HeatmapRaster {
  const range = opts.colorRange?.length ? opts.colorRange : DEFAULT_COLOR_RANGE;
  const intensity = opts.intensity ?? 1;
  const threshold = clamp(opts.threshold ?? 0.05, 0, 1);
  const opacity = clamp(opts.opacity ?? 1, 0, 1);
  const [lo, hi] = opts.colorDomain ?? [0, field.max];
  const span = hi - lo;
  const rgba = new Uint8ClampedArray(field.width * field.height * 4);
  const domain: [number, number] = [lo, hi];
  if (!(span > EPS))
    return { rgba, width: field.width, height: field.height, domain };

  const fade = Math.max(1 - threshold, EPS);
  for (let i = 0; i < field.values.length; i++) {
    // Normalise the SUM, then look the palette up once. This is the ordering
    // the whole module exists to protect.
    const u = clamp(((field.values[i] - lo) / span) * intensity, 0, 1);
    if (u <= threshold) continue; // leaves 0,0,0,0
    const [r, g, b, ca] = sampleColorRange(range, u);
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = ca * clamp((u - threshold) / fade, 0, 1) * opacity;
  }
  return { rgba, width: field.width, height: field.height, domain };
}

/** Accumulate then ramp, in that order. The only supported composition. */
export function renderHeatmapRaster(
  samples: readonly HeatmapSample[],
  alphas: ArrayLike<number> | null,
  density: DensityOptions,
  ramp: RampOptions = {},
): HeatmapRaster & { field: DensityField } {
  const field = accumulateDensity(samples, alphas, density);
  return { ...rampDensityField(field, ramp), field };
}

/** Lon/lat of a cell's centre. Row 0 is the north edge. */
export function cellCenterLonLat(
  field: DensityField,
  x: number,
  y: number,
): [number, number] {
  const { bounds, width, height } = field;
  const lon = bounds.west + ((x + 0.5) / width) * (bounds.east - bounds.west);
  const lat =
    bounds.north - ((y + 0.5) / height) * (bounds.north - bounds.south);
  return [lon, lat];
}

/** The hottest cell, or `null` when the field is empty. */
export function peakCell(
  field: DensityField,
): { x: number; y: number; lon: number; lat: number; value: number } | null {
  if (field.max <= 0) return null;
  let best = -1;
  let bestVal = 0;
  for (let i = 0; i < field.values.length; i++) {
    if (field.values[i] > bestVal) {
      bestVal = field.values[i];
      best = i;
    }
  }
  if (best < 0) return null;
  const x = best % field.width;
  const y = Math.floor(best / field.width);
  const [lon, lat] = cellCenterLonLat(field, x, y);
  return { x, y, lon, lat, value: bestVal };
}

/**
 * Nearest CONTRIBUTING sample to a lon/lat, in the equirectangular metric of
 * the field (cheap, and monotone with true distance over a single raster).
 * Samples whose alpha is zero are skipped — they are not in the picture.
 */
export function nearestSample(
  samples: readonly HeatmapSample[],
  alphas: ArrayLike<number> | null,
  lon: number,
  lat: number,
): HeatmapSample | null {
  let best: HeatmapSample | null = null;
  let bestD = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < samples.length; i++) {
    if (alphas && !(alphas[i] > 0)) continue;
    const s = samples[i];
    const dx = (s.lon - lon) * k;
    const dy = s.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
