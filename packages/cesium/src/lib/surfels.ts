// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of oriented anisotropic SURFELS from decoded
 * Point tiles — the CPU builder behind `STTSurfelLayer`. A surfel is an
 * elliptical disk lying in its own local surface frame: two in-plane
 * half-extents (`s_major`, `s_minor`, metres) swept around a centre whose
 * orientation comes from a baked surface-frame quaternion. Everything the
 * renderer needs to place one — the ECEF centre, the ECEF disk basis, the
 * half-extents, the colour, the window — is computed here, so the layer file
 * only turns numbers into Cesium objects.
 *
 * ── THE FRAME CHAIN, which is the whole substance of this file ───────────────
 * The baked quaternion's rotation matrix has columns `[tangent | bitangent |
 * normal]` **expressed in the render ENU frame** (east, north, up — metres),
 * exactly as deck's `SplatPrimitiveLayer` and three's `surfel-material`
 * consume it. Cesium's world frame is not ENU, it is absolute ECEF, so this
 * builder composes the two rotations per surfel:
 *
 *     R_ecef = R_enu→ecef(lon, lat) · R_quat
 *
 * `R_enu→ecef` is built per SURFEL at its own geodetic lon/lat (columns
 * east|north|up), not once at a scene anchor. On an AV-sized scan the two are
 * indistinguishable; on a globe they are not, and this backend is the globe
 * one — a scan in Zürich and a scan in Auckland cannot share an up vector.
 * The `up` column uses the geodetic normal (the same latitude convention
 * `GlobeProjection({datum:'wgs84'})` projects with), so the disk's normal is
 * perpendicular to the ellipsoid, not to a sphere through the point.
 *
 * ── COLUMN CONTRACT (identical to `@poopdeck.gl/three`'s `surfel-buffers`) ───
 * Two on-disk layouts, auto-detected per tile layer:
 *   • **vector** (current `stt-build --vector-group`): interleaved
 *     FixedSizeList columns `surfel_quat` (f32×4), `surfel_scale` (f32×2) and
 *     `surfel_rgba` (u8×4, confidence already folded into `a`) in
 *     `binary.vectorProps`.
 *   • **numeric** (legacy): separate `qx,qy,qz,qw` — or smallest-three packed
 *     `q_a,q_b,q_c,q_imax` — plus `s_major,s_minor`, `r,g,b` and
 *     `surfel_opacity` in `binary.numericProps`.
 * Altitude is a plain numeric column (`z` by default, × `elevationScale`),
 * falling back to the tile's own 3-D geometry z.
 *
 * `is_dynamic` is deliberately NOT read: it exists to choose between two
 * temporal-Gaussian widths, and this backend animates through the one shared
 * `timeFilterAlpha` oracle instead (see the layer header).
 *
 * Positions are ABSOLUTE f64 ECEF metres (no RTC) — Cesium consumes CPU
 * doubles, so there is no f32 buffer to protect.
 */

import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';

const DEG2RAD = Math.PI / 180;

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum
// matters). Byte-identical to the point/polyline builders' GLOBE; `project` is
// anchor-independent.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEFAULT_COLOR: RGBA255 = [200, 205, 215, 255];

/** One renderable surfel: ECEF centre + ECEF disk basis + its animation window. */
export interface FeatureSurfel {
  /** Absolute ECEF centre (metres). */
  x: number;
  y: number;
  z: number;
  /**
   * Column-major 3×3 whose columns are the UNIT `[tangent | bitangent |
   * normal]` of the surface frame, rotated into ECEF. Unscaled — the
   * half-extents ride {@link sMajor}/{@link sMinor} so a layer `sizeScale`
   * multiplies one number, not nine.
   */
  frame: Float64Array;
  /** In-plane half-extents (metres): tangent-wise, then bitangent-wise. */
  sMajor: number;
  sMinor: number;
  /** Base colour channels (0–255) — batch-table colours are u8. */
  r: number;
  g: number;
  b: number;
  /** Base alpha 0..1 (colour alpha × baked confidence); × the time-filter alpha. */
  a: number;
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

/** A built surfel set, rebased to one scene-wide time origin. */
export interface SurfelBuild {
  surfels: FeatureSurfel[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
}

export interface SurfelBuildOptions {
  /** Interleaved quaternion vector column (preferred). @default 'surfel_quat' */
  quatVectorColumn?: string;
  /** Interleaved half-extent vector column. @default 'surfel_scale' */
  scaleVectorColumn?: string;
  /** Interleaved rgba(u8) vector column; alpha IS the confidence. @default 'surfel_rgba' */
  colorVectorColumn?: string;
  /** Legacy separate quaternion columns when NOT smallest-three packed. @default ['qx','qy','qz','qw'] */
  quaternionColumns?: [string, string, string, string];
  /** Legacy in-plane half-extent columns (metres). @default ['s_major','s_minor'] */
  scaleColumns?: [string, string];
  /** Per-surfel RGB columns (0–255); `null` disables. @default ['r','g','b'] */
  rgbColumns?: [string, string, string] | null;
  /** Per-surfel confidence column (0–1) → alpha; `null` disables. @default 'surfel_opacity' */
  opacityColumn?: string | null;
  /** Altitude column (metres); `null` falls back to geometry z. @default 'z' */
  elevationProperty?: string | null;
  /** Multiplier on the elevation column. @default 1 */
  elevationScale?: number;
  /** Colour when no baked RGB is available (0–255). @default opaque grey */
  fallbackColor?: RGBA255;
  /**
   * Optional per-feature colour OVERRIDE (the package's standard
   * constant/categorical/ramp trichotomy). When given it supplies the RGB and
   * its alpha becomes an extra multiplier — the baked confidence still folds
   * in, because confidence is a property of the SCAN, not of the palette.
   */
  color?: FeatureColorMode;
}

/** How one tile layer stores its surfels (vector preferred, numeric fallback). */
export type SurfelLayout =
  | {
      kind: 'vector';
      binary: BinaryFeatures;
      quat: Float32Array | Uint8Array;
      scale: Float32Array | Uint8Array;
      /** u8 rgba; `null` when the tile carries no colour column. */
      color: Float32Array | Uint8Array | null;
    }
  | {
      kind: 'numeric';
      binary: BinaryFeatures;
      /** Quaternion columns are smallest-three packed (`q_imax` present). */
      packed: boolean;
      quatCols: [string, string, string, string];
      scaleCols: [string, string];
    };

function resolved(
  opts: SurfelBuildOptions,
): Required<
  Omit<
    SurfelBuildOptions,
    'rgbColumns' | 'opacityColumn' | 'elevationProperty' | 'color'
  >
> &
  Pick<
    SurfelBuildOptions,
    'rgbColumns' | 'opacityColumn' | 'elevationProperty' | 'color'
  > {
  return {
    quatVectorColumn: opts.quatVectorColumn ?? 'surfel_quat',
    scaleVectorColumn: opts.scaleVectorColumn ?? 'surfel_scale',
    colorVectorColumn: opts.colorVectorColumn ?? 'surfel_rgba',
    quaternionColumns: opts.quaternionColumns ?? ['qx', 'qy', 'qz', 'qw'],
    scaleColumns: opts.scaleColumns ?? ['s_major', 's_minor'],
    rgbColumns:
      opts.rgbColumns === undefined ? ['r', 'g', 'b'] : opts.rgbColumns,
    opacityColumn:
      opts.opacityColumn === undefined ? 'surfel_opacity' : opts.opacityColumn,
    elevationProperty:
      opts.elevationProperty === undefined ? 'z' : opts.elevationProperty,
    elevationScale: opts.elevationScale ?? 1,
    fallbackColor: opts.fallbackColor ?? DEFAULT_COLOR,
    color: opts.color,
  };
}

/**
 * Classify one tile layer's surfel storage, or `null` when it carries none.
 * A layer must be a non-empty POINT layer: the accessors below index
 * `positions` as `i × positionDimensions`, which is only the point layout.
 */
export function detectSurfelLayout(
  b: BinaryFeatures,
  opts: SurfelBuildOptions = {},
): SurfelLayout | null {
  if (b.featureCount === 0 || b.geometryType !== GeometryType.Point)
    return null;
  const o = resolved(opts);

  const vec = b.vectorProps ?? {};
  const quatV = vec[o.quatVectorColumn];
  const scaleV = vec[o.scaleVectorColumn];
  if (quatV && quatV.size === 4 && scaleV && scaleV.size === 2) {
    const colorV = vec[o.colorVectorColumn];
    return {
      kind: 'vector',
      binary: b,
      quat: quatV.value,
      scale: scaleV.value,
      color: colorV && colorV.size === 4 ? colorV.value : null,
    };
  }

  const num = b.numericProps;
  const packed = !!num['q_imax'];
  const quatCols: [string, string, string, string] = packed
    ? ['q_a', 'q_b', 'q_c', 'q_imax']
    : o.quaternionColumns;
  const scaleCols = o.scaleColumns;
  for (const c of quatCols) if (!num[c]) return null;
  for (const c of scaleCols) if (!num[c]) return null;
  return { kind: 'numeric', binary: b, packed, quatCols, scaleCols };
}

/** Every surfel-bearing layer across `tiles`, in tile/layer order. */
export function collectSurfelLayouts(
  tiles: Tile[],
  opts: SurfelBuildOptions = {},
): SurfelLayout[] {
  const out: SurfelLayout[] = [];
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const layout = detectSurfelLayout(tl.features, opts);
      if (layout) out.push(layout);
    }
  }
  return out;
}

/**
 * Reconstruct a full `[x,y,z,w]` quaternion from the smallest-three packing
 * `[a,b,c,imax]`: the dropped component is the largest one, recovered as
 * `√(1 − a² − b² − c²)` and re-inserted at slot `imax`. Mirrors three's
 * `unpackQuat` component-for-component.
 */
export function unpackSmallestThree(
  a: number,
  b: number,
  c: number,
  imax: number,
): [number, number, number, number] {
  const d = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
  const m = Math.round(imax);
  if (m === 0) return [d, a, b, c];
  if (m === 1) return [a, d, b, c];
  if (m === 2) return [a, b, d, c];
  return [a, b, c, d];
}

/**
 * Quaternion → column-major 3×3 whose columns are `[tangent | bitangent |
 * normal]`, matching deck's `quatToMat3` and three's `quatTangentBitangent`
 * term for term.
 *
 * The quaternion is normalized first. deck/three both assume a unit
 * quaternion baked by the encoder and would silently SCALE the disk by |q|²
 * if it were not; a CPU builder can afford the reciprocal square root, and a
 * degenerate (zero-length) quaternion falls back to identity — a disk lying
 * flat in the local tangent plane, which is the honest reading of "no
 * orientation was baked".
 */
export function quaternionToBasis(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: Float64Array = new Float64Array(9),
): Float64Array {
  const len = Math.hypot(qx, qy, qz, qw);
  let x = 0,
    y = 0,
    z = 0,
    w = 1;
  if (len > 1e-12) {
    x = qx / len;
    y = qy / len;
    z = qz / len;
    w = qw / len;
  }
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  // column 0 — tangent
  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  // column 1 — bitangent
  out[3] = xy - wz;
  out[4] = 1 - (xx + zz);
  out[5] = yz + wx;
  // column 2 — normal
  out[6] = xz + wy;
  out[7] = yz - wx;
  out[8] = 1 - (xx + yy);
  return out;
}

/**
 * ENU → ECEF rotation at a geodetic `(lon, lat)`, column-major with columns
 * `[east | north | up]`. `up` is the GEODETIC normal — the same latitude
 * convention `GlobeProjection({datum:'wgs84'})` projects centres with, so the
 * disk plane and the ellipsoid agree.
 */
export function enuToEcefBasis(
  lon: number,
  lat: number,
  out: Float64Array = new Float64Array(9),
): Float64Array {
  const lonR = lon * DEG2RAD;
  const latR = lat * DEG2RAD;
  const sl = Math.sin(lonR);
  const cl = Math.cos(lonR);
  const sp = Math.sin(latR);
  const cp = Math.cos(latR);
  // column 0 — east
  out[0] = -sl;
  out[1] = cl;
  out[2] = 0;
  // column 1 — north
  out[3] = -sp * cl;
  out[4] = -sp * sl;
  out[5] = cp;
  // column 2 — up (geodetic normal)
  out[6] = cp * cl;
  out[7] = cp * sl;
  out[8] = sp;
  return out;
}

/**
 * Compose the frame chain: `R_enu→ecef(lon,lat) · R_quat`, i.e. rotate the
 * quaternion's ENU-space `[tangent|bitangent|normal]` columns into ECEF.
 * Column-major in, column-major out.
 */
export function surfelFrame(
  lon: number,
  lat: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: Float64Array = new Float64Array(9),
): Float64Array {
  const enu = enuToEcefBasis(lon, lat, SCRATCH_ENU);
  const q = quaternionToBasis(qx, qy, qz, qw, SCRATCH_QUAT);
  for (let c = 0; c < 3; c++) {
    const e = q[c * 3];
    const n = q[c * 3 + 1];
    const u = q[c * 3 + 2];
    out[c * 3] = enu[0] * e + enu[3] * n + enu[6] * u;
    out[c * 3 + 1] = enu[1] * e + enu[4] * n + enu[7] * u;
    out[c * 3 + 2] = enu[2] * e + enu[5] * n + enu[8] * u;
  }
  return out;
}

// Build-time scratch for the two rotations `surfelFrame` composes. Safe for
// the same reason the layers' per-frame scratch is: the builder is synchronous
// and copies out of them before returning.
const SCRATCH_ENU = new Float64Array(9);
const SCRATCH_QUAT = new Float64Array(9);

/**
 * The surfel's model matrix, column-major (Cesium's
 * `Matrix4.fromColumnMajorArray` order): the ECEF basis with the tangent and
 * bitangent columns scaled to the half-extents (× `sizeScale`, floored at
 * `minimumSize` metres), the normal left unit — the disk is FLAT, so nothing
 * lives along it — and the ECEF centre in the translation column.
 *
 * A unit-radius disk in the local xy-plane transformed by this matrix is the
 * surfel: an ellipse with semi-axes `sMajor` along the tangent and `sMinor`
 * along the bitangent, standing in its own surface plane.
 *
 * `minimumSize` exists because encoders do emit zero half-extents for
 * degenerate surfels, and a zero column makes the matrix SINGULAR — the disk
 * collapses to a line and disappears. Flooring is the honest repair: a surfel
 * with no measured extent still had a measured position and orientation.
 */
export function surfelModelMatrix(
  s: FeatureSurfel,
  sizeScale = 1,
  minimumSize = 0,
  out: Float64Array = new Float64Array(16),
): Float64Array {
  const f = s.frame;
  const a = Math.max(s.sMajor * sizeScale, minimumSize);
  const b = Math.max(s.sMinor * sizeScale, minimumSize);
  out[0] = f[0] * a;
  out[1] = f[1] * a;
  out[2] = f[2] * a;
  out[3] = 0;
  out[4] = f[3] * b;
  out[5] = f[4] * b;
  out[6] = f[5] * b;
  out[7] = 0;
  out[8] = f[6];
  out[9] = f[7];
  out[10] = f[8];
  out[11] = 0;
  out[12] = s.x;
  out[13] = s.y;
  out[14] = s.z;
  out[15] = 1;
  return out;
}

/**
 * Rim vertices of the canonical unit disk, `(cos θ, sin θ, 0)` for
 * `segments` evenly spaced θ, x,y,z interleaved. This is the geometry every
 * instance shares before its model matrix bends it into place.
 *
 * Unlike deck/three — which rasterise a HEXAGON and let the fragment shader's
 * radial Gaussian carve the circle out of it — this backend has no fragment
 * hook (see the layer header), so the polygon IS the silhouette and its
 * vertices sit ON the unit circle rather than circumscribing it.
 */
export function unitDiskRim(segments: number): Float64Array {
  const n = Math.max(3, Math.floor(segments));
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out[i * 3] = Math.cos(t);
    out[i * 3 + 1] = Math.sin(t);
    out[i * 3 + 2] = 0;
  }
  return out;
}

/** Triangle-fan indices for {@link unitDiskRim} (`n − 2` triangles from vertex 0). */
export function diskIndices(segments: number): Uint16Array {
  const n = Math.max(3, Math.floor(segments));
  const out = new Uint16Array((n - 2) * 3);
  for (let i = 1; i < n - 1; i++) {
    out[(i - 1) * 3] = 0;
    out[(i - 1) * 3 + 1] = i;
    out[(i - 1) * 3 + 2] = i + 1;
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Build one {@link FeatureSurfel} per surfel-bearing Point feature. Times are
 * rebased to the first surfel layer's `timeOffset` — the same scene-wide
 * origin convention every layer in this package uses. Returns an empty build
 * (`timeOrigin: 0`) when no layer carries surfel columns, so the layer's
 * `surfels.length` bail leaves the previous origin untouched.
 */
export function buildSurfelEntries(
  tiles: Tile[],
  opts: SurfelBuildOptions = {},
): SurfelBuild {
  const layouts = collectSurfelLayouts(tiles, opts);
  if (layouts.length === 0) return { surfels: [], timeOrigin: 0 };

  const o = resolved(opts);
  const fb = o.fallbackColor;
  const timeOrigin = layouts[0].binary.timeOffset;
  const surfels: FeatureSurfel[] = [];

  for (const layout of layouts) {
    const b = layout.binary;
    const num = b.numericProps;
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const elev = o.elevationProperty ? num[o.elevationProperty] : undefined;

    const isVector = layout.kind === 'vector';
    const vQuat = isVector ? layout.quat : null;
    const vScale = isVector ? layout.scale : null;
    const vColor = isVector ? layout.color : null;
    const nQx = !isVector ? num[layout.quatCols[0]] : null;
    const nQy = !isVector ? num[layout.quatCols[1]] : null;
    const nQz = !isVector ? num[layout.quatCols[2]] : null;
    const nQw = !isVector ? num[layout.quatCols[3]] : null;
    const nSmaj = !isVector ? num[layout.scaleCols[0]] : null;
    const nSmin = !isVector ? num[layout.scaleCols[1]] : null;
    const packed = !isVector && layout.packed;
    const rgb = o.rgbColumns;
    const nR = rgb ? num[rgb[0]] : undefined;
    const nG = rgb ? num[rgb[1]] : undefined;
    const nB = rgb ? num[rgb[2]] : undefined;
    const nOp = o.opacityColumn ? num[o.opacityColumn] : undefined;

    for (let i = 0; i < b.featureCount; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = elev
        ? elev[i] * o.elevationScale
        : dims > 2
          ? b.positions[i * dims + 2]
          : 0;
      const [x, y, z] = GLOBE.project(lon, lat, alt);

      let qx: number, qy: number, qz: number, qw: number;
      let sMajor: number, sMinor: number;
      if (isVector) {
        qx = vQuat![i * 4];
        qy = vQuat![i * 4 + 1];
        qz = vQuat![i * 4 + 2];
        qw = vQuat![i * 4 + 3];
        sMajor = vScale![i * 2];
        sMinor = vScale![i * 2 + 1];
      } else {
        const a = nQx![i];
        const bq = nQy![i];
        const c = nQz![i];
        const d = nQw![i];
        if (packed) [qx, qy, qz, qw] = unpackSmallestThree(a, bq, c, d);
        else {
          qx = a;
          qy = bq;
          qz = c;
          qw = d;
        }
        sMajor = nSmaj![i];
        sMinor = nSmin![i];
      }

      // Baked colour: the vector layout carries confidence in rgba.a, the
      // numeric one in a separate opacity column. An explicit `color` mode
      // supplies the RGB and multiplies its own alpha on top; confidence
      // always survives, because it describes the SCAN, not the palette.
      let r: number, g: number, bb: number;
      let confidence: number;
      if (isVector && vColor) {
        r = vColor[i * 4];
        g = vColor[i * 4 + 1];
        bb = vColor[i * 4 + 2];
        confidence = vColor[i * 4 + 3] / 255;
      } else if (nR && nG && nB) {
        r = nR[i];
        g = nG[i];
        bb = nB[i];
        confidence = nOp ? clamp01(nOp[i]) : 1;
      } else {
        r = fb[0];
        g = fb[1];
        bb = fb[2];
        confidence = nOp ? clamp01(nOp[i]) : (fb[3] ?? 255) / 255;
      }
      if (o.color) {
        const c = featureColor(b, i, o.color);
        r = c[0];
        g = c[1];
        bb = c[2];
        confidence *= (c[3] ?? 255) / 255;
      }

      surfels.push({
        x,
        y,
        z,
        frame: surfelFrame(lon, lat, qx, qy, qz, qw),
        sMajor,
        sMinor,
        r,
        g,
        b: bb,
        a: confidence,
        start: b.startTimes[i] + rebase,
        end: b.endTimes[i] + rebase,
        lon,
        lat,
        binary: b,
        featureIndex: i,
      });
    }
  }

  return { surfels, timeOrigin };
}
