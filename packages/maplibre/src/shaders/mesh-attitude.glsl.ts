/**
 * Attitude kernel — quaternion rotation for instanced 3D models.
 *
 * `STTMeshLayer` orients every instance with a full 3-axis attitude rather than
 * a yaw angle, because a real vehicle pitches over a crest and rolls into a
 * bank and an AV archive that carries `qx/qy/qz/qw` already knows it. A
 * quaternion is also the only rotation representation this backend can
 * INTERPOLATE honestly: euler triples gimbal-lock and matrices lerp into
 * non-orthogonal garbage, while a slerp between two unit quaternions is a
 * constant-angular-velocity rotation along the shortest arc — the rotational
 * analogue of the shortest-arc heading lerp (`lerpAngle`) the core track kernel
 * already applies to a scalar heading.
 *
 * Everything here is deliberately tiny and duplicated on both sides of the bus:
 * the GLSL chunk rotates a vertex by an already-interpolated per-instance
 * quaternion, and the JS references do the interpolation on the CPU (once per
 * ACTIVE track per frame, not once per keyframe) plus a byte-identical rotation
 * a GPU-free test can assert against. Nothing in this file knows about tiles,
 * time filtering or picking.
 *
 * What it deliberately does NOT do:
 *  - no euler↔quaternion conversion beyond the single yaw-only constructor
 *    ({@link quatFromHeading}) and the model-frame correction
 *    ({@link quatFromEulerXYZ}); a caller with a richer rig should hand the
 *    layer real quaternion columns;
 *  - no normal matrix. Instances are rotated and NON-UNIFORMLY scaled, so a
 *    strictly correct normal needs the inverse transpose. The layer rotates the
 *    normal by the same quaternion and skips the scale — see the layer header
 *    for why that is the right trade here.
 */

/**
 * Rotate a vec3 by a unit quaternion `q = (x, y, z, w)`.
 *
 * The two-cross-product form (`v + 2w(q×v) + 2(q×(q×v))`) — 15 mul / 15 add,
 * no matrix build, no trig, and numerically well-behaved for a `q` that has
 * drifted slightly off the unit sphere. It is the same identity glMatrix and
 * three.js use.
 *
 * Declares `sttRotateByQuat`. Splice once per program.
 */
export const QUAT_ROTATE_GLSL = `
  vec3 sttRotateByQuat(vec4 q, vec3 v) {
    vec3 t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
  }
`;

/**
 * Compose two rotations: apply `b` first, then `a` (Hamilton product `a * b`).
 *
 * The layer needs exactly one composition — `attitude * orientationOffset` —
 * and does it on the CPU, once per instance. The GLSL form exists so a variant
 * that wants a per-vertex composed frame does not have to re-derive it.
 *
 * Declares `sttQuatMul`.
 */
export const QUAT_MUL_GLSL = `
  vec4 sttQuatMul(vec4 a, vec4 b) {
    return vec4(
      a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz),
      a.w * b.w - dot(a.xyz, b.xyz)
    );
  }
`;

/** A quaternion in the `(x, y, z, w)` order every WebGL attribute uses. */
export type Quat = [number, number, number, number];

/** The identity rotation. */
export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/**
 * JS reference for {@link QUAT_ROTATE_GLSL} — identical arithmetic, same order
 * of operations, so a test can pin the shader against it without a GPU.
 */
export function rotateByQuat(
  q: ArrayLike<number>,
  v: readonly [number, number, number],
): [number, number, number] {
  const [vx, vy, vz] = v;
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** JS reference for {@link QUAT_MUL_GLSL} (`a` applied after `b`). */
export function multiplyQuat(a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  return [
    aw * bx + bw * ax + (ay * bz - az * by),
    aw * by + bw * ay + (az * bx - ax * bz),
    aw * bz + bw * az + (ax * by - ay * bx),
    aw * bw - (ax * bx + ay * by + az * bz),
  ];
}

/** Normalize in place-ish; a zero quaternion degrades to identity, never NaN. */
export function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(len > 1e-12)) return [0, 0, 0, 1];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Yaw-only attitude from a heading in RADIANS, measured counter-clockwise from
 * `+x` (east) in the local ENU frame — the same convention the core track
 * kernel's `heading` column and `lerpAngle` use.
 *
 * This is the fallback path: an archive with no quaternion columns still gets a
 * correctly-turning model, it just never pitches or rolls.
 */
export function quatFromHeading(headingRad: number): Quat {
  if (!Number.isFinite(headingRad)) return [0, 0, 0, 1];
  const h = headingRad * 0.5;
  return [0, 0, Math.sin(h), Math.cos(h)];
}

/**
 * Attitude from an intrinsic X→Y→Z euler triple in RADIANS (roll, pitch, yaw).
 *
 * Used for ONE thing: `orientationOffset`, the static correction that rotates a
 * model whose author pointed it down `-z` or `+y` into this layer's canonical
 * frame (`+x` forward / `+y` left / `+z` up). Per-instance attitude never comes
 * through here.
 */
export function quatFromEulerXYZ(x: number, y: number, z: number): Quat {
  const cx = Math.cos(x * 0.5);
  const sx = Math.sin(x * 0.5);
  const cy = Math.cos(y * 0.5);
  const sy = Math.sin(y * 0.5);
  const cz = Math.cos(z * 0.5);
  const sz = Math.sin(z * 0.5);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

/**
 * Spherical linear interpolation along the SHORTEST arc.
 *
 * Two details that are the whole reason this is not a lerp:
 *  1. `q` and `-q` are the same rotation, so a raw slerp on a bracket whose
 *     endpoints happen to be stored with opposite signs takes the 358° way
 *     round — the rotational twin of the heading wrap-around bug. The dot-sign
 *     flip below is the fix, and it is exactly what `lerpAngle` does for a
 *     scalar.
 *  2. As the arc closes, `sin(theta)` → 0 and the trig form divides by ~0. Near
 *     alignment it falls back to a normalized lerp, whose error at
 *     `dot > 0.9995` is below a float32 ULP of the result.
 */
export function slerpQuat(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  f: number,
): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    // Same rotation, opposite representation — flip so the arc is the short one.
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuat([
      a[0] + (bx - a[0]) * f,
      a[1] + (by - a[1]) * f,
      a[2] + (bz - a[2]) * f,
      a[3] + (bw - a[3]) * f,
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - f) * theta) / sinTheta;
  const wb = Math.sin(f * theta) / sinTheta;
  return [
    a[0] * wa + bx * wb,
    a[1] * wa + by * wb,
    a[2] * wa + bz * wb,
    a[3] * wa + bw * wb,
  ];
}
