// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * The surfel kernel — the three tiny numeric pieces that make an ORIENTED
 * ANISOTROPIC GAUSSIAN SPLAT something other than a round billboard.
 *
 *  1. `sttSurfelBasis(vec4 q)` — quaternion → column-major `mat3` whose columns
 *     are `[tangent | bitangent | normal]`. This is the SAME term-for-term
 *     expansion as `packages/cesium/src/lib/surfels.ts::quaternionToBasis` and
 *     deck's `quatToMat3`; the three backends must agree to the bit or the same
 *     archive renders a differently-tilted disk per renderer. It is transcribed
 *     rather than imported because this package has exactly one runtime
 *     dependency (`@poopdeck.gl/core`) and cross-package imports are forbidden.
 *  2. `sttSurfelDiskWeight(vec2 uv, float k)` — the radial Gaussian profile,
 *     evaluated on the quad's own `[-1,1]²` corner coordinates. The unit disk
 *     IS the ellipse (the vertex stage already scaled the two axes by the two
 *     half-extents), so one isotropic `dot(uv, uv)` here is an anisotropic
 *     falloff in world space, for free.
 *  3. `sttSurfelTemporalWeight(now, center, invSigma)` — the temporal Gaussian,
 *     centred on the surfel's OWN sample time. Separate from the four shared
 *     time-filter kernels on purpose: those decide whether a feature is IN the
 *     frame at all, this decides how confidently a sample taken at `center`
 *     speaks about the instant `now`.
 *
 * Every GLSL function here has a JS twin below with the identical body, so the
 * suite can pin the numbers without a GL context (this repo ships no pixel
 * goldens — `test/mock-gl.ts` is a recorder, not a rasterizer).
 */

/**
 * `mat3 sttSurfelBasis(vec4 q)` — unit-normalized quaternion → the local
 * surface frame, columns `[tangent | bitangent | normal]`.
 *
 * The quaternion is normalized in the shader rather than trusted: an encoder
 * that baked a non-unit quaternion would otherwise SCALE the disk by |q|²,
 * which reads as a random per-surfel size error rather than as bad data. A
 * degenerate (zero-length) quaternion falls back to identity — a disk lying
 * flat in the local tangent plane, the honest reading of "no orientation was
 * baked".
 */
export const SURFEL_BASIS_GLSL = `
  mat3 sttSurfelBasis(vec4 q) {
    float qlen = length(q);
    vec4 n = (qlen > 1e-12) ? q / qlen : vec4(0.0, 0.0, 0.0, 1.0);
    float x2 = n.x + n.x;
    float y2 = n.y + n.y;
    float z2 = n.z + n.z;
    float xx = n.x * x2;
    float xy = n.x * y2;
    float xz = n.x * z2;
    float yy = n.y * y2;
    float yz = n.y * z2;
    float zz = n.z * z2;
    float wx = n.w * x2;
    float wy = n.w * y2;
    float wz = n.w * z2;
    // mat3(...) takes COLUMNS: tangent, then bitangent, then normal.
    return mat3(
      1.0 - (yy + zz), xy + wz,         xz - wy,
      xy - wz,         1.0 - (xx + zz), yz + wx,
      xz + wy,         yz - wx,         1.0 - (xx + yy)
    );
  }
`;

/**
 * The two Gaussian weights. `k` is `falloffSigmas²`, i.e. the rim of the quad
 * sits `falloffSigmas` standard deviations out, so the caller tunes "how soft"
 * in a unit that means something.
 *
 * `r2 > 1.0` returns a hard `0.0` rather than a tiny tail value: that IS the
 * elliptical clip that turns the quad into a disk, and both the visual and the
 * id pass read it, so the pickable footprint is the ellipse and never the
 * bounding quad.
 */
export const SURFEL_GAUSSIAN_GLSL = `
  float sttSurfelDiskWeight(vec2 uv, float k) {
    float r2 = dot(uv, uv);
    if (r2 > 1.0) return 0.0;
    return exp(-0.5 * r2 * k);
  }

  float sttSurfelTemporalWeight(float now, float center, float invSigma) {
    float d = (now - center) * invSigma;
    return exp(-0.5 * d * d);
  }
`;

/**
 * The load-bearing operations of {@link SURFEL_BASIS_GLSL}, in order. Exported
 * for structural seam assertions that survive a rename — the same trick
 * `GLOBE_ELEVATION_STEPS` plays for the elevated-projection block.
 */
export const SURFEL_BASIS_STEPS: readonly string[] = [
  'sttSurfelBasis(',
  'length(q)',
  'mat3(',
];

/**
 * JS twin of `sttSurfelBasis`. Returns the 9 entries COLUMN-MAJOR, i.e.
 * `[t.x, t.y, t.z, b.x, b.y, b.z, n.x, n.y, n.z]` — the same layout GLSL's
 * `mat3` constructor consumes and the same one the cesium backend emits.
 */
export function surfelBasisRef(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: Float64Array = new Float64Array(9),
): Float64Array {
  const len = Math.hypot(qx, qy, qz, qw);
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 1;
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

/** JS twin of `sttSurfelDiskWeight`. */
export function surfelDiskWeightRef(u: number, v: number, k: number): number {
  const r2 = u * u + v * v;
  if (r2 > 1) return 0;
  return Math.exp(-0.5 * r2 * k);
}

/** JS twin of `sttSurfelTemporalWeight`. */
export function surfelTemporalWeightRef(
  now: number,
  center: number,
  invSigma: number,
): number {
  const d = (now - center) * invSigma;
  return Math.exp(-0.5 * d * d);
}
