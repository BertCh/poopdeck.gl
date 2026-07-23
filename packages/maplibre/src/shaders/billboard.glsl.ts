// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * The point-sprite (billboard) disc — one definition of the circle every
 * `gl.POINTS` layer in this package draws and hit-tests (Wave M3 seam pass).
 *
 * `STTPointLayer` and `STTTripHeadsLayer` both render round billboards, and
 * each needs the SAME disc in two fragment stages: the visual one (antialiased)
 * and the id-buffer pick one (hard-edged, because a partially covered edge texel
 * must still decode to the exact id byte triple). That is four transcriptions
 * of one shape, and the numbers in it are not arbitrary:
 *
 *  - `gl_PointCoord` runs 0..1 across the sprite, so the centre is `0.5` and
 *    the disc's radius is `0.5` — hence `r² <= 0.25` as the inside test. The
 *    comparison stays SQUARED so no fragment pays a `sqrt`.
 *  - the antialiased edge softens the last ~10% of the radius
 *    (`smoothstep(0.25, 0.20, r²)`), which is the only place the two stages
 *    diverge.
 *
 * The risk this module removes is specific: if the visual disc and the pick
 * disc drift apart, the layer becomes pickable in a ring where nothing is
 * drawn (or unpickable at its own edge), and no unit test that does not
 * rasterize can see it. Sharing the constant makes that drift impossible.
 */

/**
 * Squared radius of the sprite disc in `gl_PointCoord` space (`0.5² = 0.25`).
 * Emitted as GLSL source, not a JS number, so the literal in the shader and the
 * value documented here cannot disagree.
 */
export const DISC_R2_MAX = '0.25';

/** Inner edge of the antialiasing ramp — the last ~10% of the radius. */
export const DISC_R2_SOFT = '0.20';

/**
 * Discard everything outside the disc and leave `r2` (the squared distance from
 * the sprite centre, 0 at the middle) in scope for the caller.
 *
 * `indent` matches the surrounding fragment stage; both current callers use
 * four spaces.
 */
export function discMaskGLSL(indent = '    '): string {
  return `${indent}vec2 d = gl_PointCoord - vec2(0.5);
${indent}float r2 = dot(d, d);
${indent}if (r2 > ${DISC_R2_MAX}) discard;
`;
}

/**
 * The antialiasing weight for a fragment at squared radius `r2`: 1 inside,
 * ramping to 0 at the rim. Multiply into the final alpha.
 */
export const DISC_EDGE_EXPR = `smoothstep(${DISC_R2_MAX}, ${DISC_R2_SOFT}, r2)`;

/**
 * The complete id-buffer fragment stage for a billboard layer — byte-identical
 * between the point and trip-heads layers apart from `what`, which only names
 * the kind in the gate comment.
 *
 * Two invariants it encodes, both of which a rasterizing test would be needed
 * to catch otherwise:
 *  1. the SAME `vAlpha` gate as the visual pass, so geometry the time filter or
 *     the DataFilter hid is not secretly pickable;
 *  2. the SAME disc mask, so the hit area is the circle the user sees rather
 *     than the sprite's square.
 */
export function buildBillboardIdFragmentSource(what: string): string {
  return `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // gated ${what} are not pickable
${discMaskGLSL()}    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;
}
