// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of LIT ECEF point clouds from decoded Point
 * tiles — the CPU builder behind `STTPointCloudLayer.setTiles`, and the lit,
 * genuinely-3-D sibling of `points.ts` (flat, unlit, ground-hugging billboards).
 * Kernel-built like every other builder here:
 *
 *   - positions → `core/geo` `GlobeProjection({datum:'wgs84'})`, with a REAL
 *                 altitude: `elevationProperty × elevationScale` when the
 *                 caller names a column, else the tile's own 3-D geometry z,
 *                 else 0. On a globe the altitude is simply the third argument
 *                 to `project`, so elevation costs nothing — this is the one
 *                 thing Cesium gives away that the flat backends must earn.
 *   - normals   → an optional `FixedSizeList<Float32,3>` vector column
 *                 (deck's `normalColumn`, default `'normal'`), read straight off
 *                 the contiguous child buffer; absent ⇒ deck's default `[0,0,1]`.
 *   - colour    → the four-way resolution below.
 *   - lighting  → {@link lambertShade}, BAKED into the per-point colour here at
 *                 build time. See `cesium-point-cloud-layer.ts`'s header for why
 *                 the shading is baked rather than shaded per fragment; the short
 *                 version is that `PointPrimitiveCollection` has no shader hook,
 *                 and the quad-`Primitive` alternative costs four vertices and a
 *                 custom `Appearance` per point.
 *
 * Times are rebased to the first Point layer's `timeOffset` — the same
 * scene-wide origin convention every layer in this package uses. Positions are
 * ABSOLUTE f64 ECEF metres (no RTC): `Cartesian3` consumes CPU doubles, so
 * there is no f32 buffer to protect.
 *
 * ── COLOUR (deck's four-way resolution, in priority order) ───────────────────
 *   1. {@link PointCloudBuildOptions.colorVectorColumn} — ONE interleaved
 *      `FixedSizeList<UInt8,4>` RGBA column (baked by `stt-build --vector-group`,
 *      e.g. LiDAR returns coloured by projection into camera images). Wins over
 *      every other path whenever the tile carries it.
 *   2. {@link PointCloudBuildOptions.rgbColorColumns} — three numeric columns
 *      `[r,g,b]`, 0–255, through the kernel's `expandRgbColumns`. Used only when
 *      ALL THREE are present on the tile; a missing column falls THROUGH to (3)
 *      rather than painting the kernel's fallback grey, matching deck.
 *   3./4. {@link PointCloudBuildOptions.color} — a {@link FeatureColorMode},
 *      i.e. a categorical column, a numeric ramp, or one constant. This is the
 *      `feature-color.ts` trichotomy the polyline/trip layers use, so a cloud
 *      gains `ramp` for free — one more mode than deck's `AnimatedPointCloudLayer`
 *      offers on this kind.
 *
 * Resolution is PER TILE, not per build: a mixed archive where only some tiles
 * carry the camera-colour column paints those from the column and the rest from
 * `color`, rather than picking one path for everything.
 *
 * Note what is ABSENT, deliberately and for the same reason deck refuses it:
 * there is no GPU stable-palette path for the categorical case. deck will not
 * install its `CategoryColorExtension` on a lit kind because the extension
 * replaces colour AFTER lighting, which would render categorical points flat.
 * Here the equivalent mistake would be to skip the shade multiply for
 * categorical colours; we do not — every path is shaded identically.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection, type LocalFrame } from '@poopdeck.gl/core/geo';
import { expandRgbColumns, type RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';
import { collectPointLayers } from './points.js';

/** deck's `getNormal` default: straight up in the local ENU frame. */
const DEFAULT_NORMAL: readonly [number, number, number] = [0, 0, 1];
/** Zenith in the ENU frame — a headlamp directly overhead (see {@link PointCloudLighting}). */
const DEFAULT_LIGHT: readonly [number, number, number] = [0, 0, 1];
/** Ambient + diffuse sum to exactly 1, so a fully-lit point IS its source colour. */
const DEFAULT_AMBIENT = 0.35;
const DEFAULT_DIFFUSE = 0.65;
const DEFAULT_COLOR: RGBA255 = [200, 205, 215, 255];
const DEFAULT_NORMAL_COLUMN = 'normal';
const DEFAULT_COLOR_VECTOR_COLUMN = 'point_rgba';

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum matters).
// Byte-identical to the point/polyline builders' GLOBE; `project` and
// `localFrame` are both anchor-independent.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

// Reused inside the build loop so a million-point cloud allocates one tuple, not
// a million. Safe for exactly the reason the layers' per-frame scratch objects
// are: the loop is synchronous, single-threaded, and nothing escapes it —
// `lambertShade` reads the tuple and returns a number.
const SCRATCH_NORMAL: [number, number, number] = [0, 0, 1];
const SCRATCH_ROTATED: [number, number, number] = [0, 0, 1];

/**
 * A fixed directional light, baked into every point's colour at build time.
 *
 * `frame` decides what {@link direction} — and the normal column — MEAN, and the
 * two choices are genuinely different lights:
 *
 * - `'enu'` (default) reads both the normal and the light in each point's LOCAL
 *   east/north/up frame, so `N·L` needs no per-point rotation and a `[0,0,1]`
 *   light is overhead EVERYWHERE. That is a headlamp, not a sun: two points on
 *   opposite sides of the globe are both lit from their own zenith. For the
 *   city-block-scale clouds this kind actually renders, it is indistinguishable
 *   from a sun and it is what deck's `[0,0,1]` default normal assumes.
 * - `'ecef'` rotates each normal ENU→ECEF through `GlobeProjection.localFrame`
 *   and dots it against `direction` read as a fixed ECEF vector — a real distant
 *   sun, correct across a whole-globe cloud, at the cost of one 3×3 rotation per
 *   point. Supply a real sun vector; the `[0,0,1]` default means "lit from the
 *   celestial north", which is rarely what you want.
 */
export interface PointCloudLighting {
  /** Direction TOWARDS the light. Normalized internally. @default [0,0,1] */
  direction?: readonly [number, number, number];
  /** Frame both {@link direction} and the normal column are read in. @default 'enu' */
  frame?: 'enu' | 'ecef';
  /** Unlit floor, 0..1 — what a back-facing point keeps. @default 0.35 */
  ambient?: number;
  /** Lambert term weight, 0..1. @default 0.65 */
  diffuse?: number;
}

export interface PointCloudBuildOptions {
  /**
   * Interleaved rgba vector column that, when a tile carries it, outranks every
   * other colour path (channels 0–255, u8 or f32 leaf). `null` disables the
   * path. @default 'point_rgba'
   */
  colorVectorColumn?: string | null;
  /**
   * Three numeric columns `[r,g,b]`, each 0–255 — used only when all three are
   * present on the tile. @default null
   */
  rgbColorColumns?: readonly [string, string, string] | null;
  /** Constant alpha (0–255) for the {@link rgbColorColumns} path. @default 255 */
  rgbAlpha?: number;
  /** Per-feature colour for the categorical / ramp / constant paths. @default opaque grey */
  color?: FeatureColorMode;
  /**
   * `FixedSizeList<Float32,3>` column holding each point's surface normal
   * `[nx,ny,nz]`. A u8 leaf is IGNORED rather than rescaled (deck does the same:
   * no rescale convention would make a u8 normal valid), as is a column too
   * short for the tile's features. `null` disables the lookup. @default 'normal'
   */
  normalColumn?: string | null;
  /** Numeric column giving each point's altitude in metres. @default null (geometry z) */
  elevationProperty?: string | null;
  /** Multiplier applied to {@link elevationProperty}. @default 1 */
  elevationScale?: number;
  /** The baked light. @default a zenith ENU headlamp, 0.35 ambient + 0.65 diffuse */
  lighting?: PointCloudLighting;
}

/** One lit cloud point: absolute ECEF position + SHADED colour + its window. */
export interface CloudPoint {
  /** Absolute ECEF position (metres), altitude included. */
  x: number;
  y: number;
  z: number;
  /**
   * Colour channels pre-normalized to 0..1 and ALREADY multiplied by
   * {@link shade}, so the per-frame `setTime` neither re-divides by 255 nor
   * re-lights. Alpha animates as `a × timeFilterAlpha`.
   */
  r: number;
  g: number;
  b: number;
  /** Base alpha 0..1 — NOT shaded (lighting darkens a surface, it never dissolves it). */
  a: number;
  /** The Lambert term applied to r/g/b, 0..1. Kept for tests and diagnostics. */
  shade: number;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Source lon/lat (degrees) — the picking coordinate. */
  lon: number;
  lat: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built cloud, rebased to one scene-wide time origin. */
export interface PointCloudBuild {
  points: CloudPoint[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
  /**
   * True when at least one contributing tile carried a usable normal column —
   * i.e. the shading in `points` varies by geometry rather than being the one
   * constant every default `[0,0,1]` normal produces. A WHOLE-BUILD verdict, and
   * a property of the RESIDENT tiles rather than of the archive: streaming can
   * evict the normal-carrying tiles and flip it back to false.
   */
  hasNormals: boolean;
}

/**
 * Lambert shading term for one point: `ambient + diffuse · max(0, N̂·L̂)`,
 * clamped to 0..1. Both vectors are normalized here, so callers may pass raw
 * column values and a raw light direction.
 *
 * A zero-length normal or light carries no direction at all; rather than
 * propagating `NaN` into a colour channel (which Cesium would render as an
 * undefined colour, not as an error) such a point falls back to the ambient
 * floor — the same place a fully back-facing point lands.
 */
export function lambertShade(
  normal: readonly [number, number, number],
  light: readonly [number, number, number],
  ambient: number = DEFAULT_AMBIENT,
  diffuse: number = DEFAULT_DIFFUSE,
): number {
  const nLen = Math.hypot(normal[0], normal[1], normal[2]);
  const lLen = Math.hypot(light[0], light[1], light[2]);
  const dot =
    nLen > 0 && lLen > 0
      ? (normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]) /
        (nLen * lLen)
      : 0;
  const shade = ambient + diffuse * (dot > 0 ? dot : 0);
  return shade < 0 ? 0 : shade > 1 ? 1 : shade;
}

/**
 * The per-point normal buffer for one tile layer, or `null` when the tile
 * carries none usable. Only an f32 leaf of exactly 3 components qualifies (see
 * {@link PointCloudBuildOptions.normalColumn}), and it must be long enough for
 * every feature — a short column is treated as ABSENT so the caller falls back
 * to `[0,0,1]` instead of reading past the end.
 */
function normalsForTile(
  b: BinaryFeatures,
  column: string | null,
): Float32Array | null {
  if (!column) return null;
  const nv = b.vectorProps?.[column];
  if (!nv || nv.size !== 3) return null;
  if (!(nv.value instanceof Float32Array)) return null;
  return nv.value.length >= b.featureCount * 3 ? nv.value : null;
}

/**
 * Packed 0..1 RGBA for one tile layer via colour paths (1) and (2), or `null`
 * when neither applies and the caller must fall through to
 * {@link FeatureColorMode}.
 */
function bakedColorsForTile(
  b: BinaryFeatures,
  colorVectorColumn: string | null,
  rgbColumns: readonly [string, string, string] | null,
  rgbAlpha: number,
): Float32Array | null {
  const n = b.featureCount;
  // (1) Interleaved camera-colour vector column wins whenever present. Channels
  // are 0–255 for BOTH leaf widths: an f32 leaf here is a wire-format variation
  // of the same u8 palette, not a normalized colour.
  const cv = colorVectorColumn ? b.vectorProps?.[colorVectorColumn] : undefined;
  if (cv && cv.size === 4 && cv.value.length >= n * 4) {
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) out[i] = cv.value[i] / 255;
    return out;
  }
  // (2) Three numeric RGB columns — all three, or fall through to (3)/(4).
  if (
    rgbColumns &&
    b.numericProps[rgbColumns[0]] &&
    b.numericProps[rgbColumns[1]] &&
    b.numericProps[rgbColumns[2]]
  ) {
    return expandRgbColumns(b, rgbColumns, 'f32', rgbAlpha) as Float32Array;
  }
  return null;
}

/** Rotate an ENU direction into ECEF through a point's local tangent basis. */
function enuToEcef(
  n: readonly [number, number, number],
  frame: LocalFrame,
  out: [number, number, number],
): [number, number, number] {
  const { east, north, up } = frame;
  out[0] = n[0] * east[0] + n[1] * north[0] + n[2] * up[0];
  out[1] = n[0] * east[1] + n[1] * north[1] + n[2] * up[1];
  out[2] = n[0] * east[2] + n[1] * north[2] + n[2] * up[2];
  return out;
}

/**
 * Build one lit ECEF point per Point feature. Returns the all-empty shape
 * (`timeOrigin: 0`, `hasNormals: false`) when there are no Point features — the
 * layer checks `points.length` before adopting `timeOrigin`, so an empty rebuild
 * leaves the previous origin untouched.
 */
export function buildPointCloudEntries(
  tiles: Tile[],
  opts: PointCloudBuildOptions = {},
): PointCloudBuild {
  const layers = collectPointLayers(tiles);
  if (layers.length === 0)
    return { points: [], timeOrigin: 0, hasNormals: false };

  const timeOrigin = layers[0].timeOffset;
  const colorMode: FeatureColorMode = opts.color ?? {
    type: 'constant',
    color: DEFAULT_COLOR,
  };
  // `undefined` means "the default column name"; explicit `null` disables the
  // lookup. The two must stay distinguishable — a caller whose archive has an
  // unrelated column called `normal` needs a way to say so.
  const normalColumn =
    opts.normalColumn === undefined ? DEFAULT_NORMAL_COLUMN : opts.normalColumn;
  const colorVectorColumn =
    opts.colorVectorColumn === undefined
      ? DEFAULT_COLOR_VECTOR_COLUMN
      : opts.colorVectorColumn;
  const rgbColumns = opts.rgbColorColumns ?? null;
  const rgbAlpha = opts.rgbAlpha ?? 255;
  const elevationProperty = opts.elevationProperty ?? null;
  const elevationScale = opts.elevationScale ?? 1;
  const light = opts.lighting?.direction ?? DEFAULT_LIGHT;
  const ecefLight = opts.lighting?.frame === 'ecef';
  const ambient = opts.lighting?.ambient ?? DEFAULT_AMBIENT;
  const diffuse = opts.lighting?.diffuse ?? DEFAULT_DIFFUSE;

  const points: CloudPoint[] = [];
  let hasNormals = false;

  for (const b of layers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const elev = elevationProperty
      ? b.numericProps[elevationProperty]
      : undefined;
    const normals = normalsForTile(b, normalColumn);
    if (normals) hasNormals = true;
    const baked = bakedColorsForTile(
      b,
      colorVectorColumn,
      rgbColumns,
      rgbAlpha,
    );

    for (let i = 0; i < b.featureCount; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      // A named elevation column WINS over the tile's own geometry z: it is the
      // caller telling us which of several altitude-ish columns is the height.
      const alt = elev
        ? elev[i] * elevationScale
        : dims > 2
          ? b.positions[i * dims + 2]
          : 0;
      const [x, y, z] = GLOBE.project(lon, lat, alt);

      if (normals) {
        SCRATCH_NORMAL[0] = normals[i * 3];
        SCRATCH_NORMAL[1] = normals[i * 3 + 1];
        SCRATCH_NORMAL[2] = normals[i * 3 + 2];
      } else {
        // A normal-less tile inside a build that HAS normals still shades: deck's
        // default up-normal makes it uniformly lit rather than dropping it out.
        SCRATCH_NORMAL[0] = DEFAULT_NORMAL[0];
        SCRATCH_NORMAL[1] = DEFAULT_NORMAL[1];
        SCRATCH_NORMAL[2] = DEFAULT_NORMAL[2];
      }
      const shade = lambertShade(
        ecefLight
          ? enuToEcef(
              SCRATCH_NORMAL,
              GLOBE.localFrame(lon, lat),
              SCRATCH_ROTATED,
            )
          : SCRATCH_NORMAL,
        light,
        ambient,
        diffuse,
      );

      let r: number;
      let g: number;
      let bl: number;
      let a: number;
      if (baked) {
        r = baked[i * 4];
        g = baked[i * 4 + 1];
        bl = baked[i * 4 + 2];
        a = baked[i * 4 + 3];
      } else {
        const c = featureColor(b, i, colorMode);
        r = c[0] / 255;
        g = c[1] / 255;
        bl = c[2] / 255;
        a = (c[3] ?? 255) / 255;
      }

      points.push({
        x,
        y,
        z,
        // Shade multiplies RGB only. Lighting darkens a surface; it does not
        // dissolve it, and the per-frame time-filter alpha owns the A channel.
        r: r * shade,
        g: g * shade,
        b: bl * shade,
        a,
        shade,
        start: b.startTimes[i] + rebase,
        end: b.endTimes[i] + rebase,
        lon,
        lat,
        binary: b,
        featureIndex: i,
      });
    }
  }

  return { points, timeOrigin, hasNormals };
}
