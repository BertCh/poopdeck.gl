// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * The BUNDLE kernel's GLSL — a KDEEB-bundled flow path sampled on the GPU from
 * a per-tile **control-point texture** (rows = OD pairs, cols = control points
 * along the pair), so a bundled arrow follows the river its edge was advected
 * into instead of the straight chord between its endpoints.
 *
 * ── What lives where ────────────────────────────────────────────────────────
 * The KDEEB math itself — splat → advect → resample → smooth → anneal — is NOT
 * here and is not in this package at all. It is one shared CPU implementation,
 * `bundleEdges()` in `@poopdeck.gl/core/edge-bundling`, which every backend
 * calls. That is deliberate and it is the whole design:
 *
 *   **A bundle is STATIC GEOMETRY.** It is a function of the edge SET, not of
 *   the playhead, the camera or the frame. It is recomputed when a tile's edges
 *   change — once — and never again. Nothing about it wants to live in a
 *   per-frame device loop, which is why one CPU implementation can serve four
 *   backends without any of them re-deriving the kernel constants that the
 *   renderer-architecture record has already watched drift once.
 *
 * So this file is the *sampling* half only: `lib/edge-bundler.ts` produces the
 * control points, uploads them once per tile, and the two functions below read
 * them back in the VERTEX stage at the arrow parameter `t`.
 *
 * ── Texture addressing ──────────────────────────────────────────────────────
 * The texture is exactly `pointsPerEdge × edgeCount` texels of RGBA float,
 * `.xy` holding a MERCATOR position (`.zw` unused — RGBA rather than RG so ONE
 * upload recipe serves WebGL1's `OES_texture_float` and WebGL2's `RGBA32F`
 * alike). Row `e` is OD pair `e`, in the layer's own instance order, so the
 * per-instance row attribute is just the instance index.
 *
 * There is no linear index to split here — unlike `flow.glsl.ts`'s value
 * matrix, whose power-of-two width is load-bearing — because the natural shape
 * IS the texture shape. Sampling is NEAREST at texel centres (`+0.5`); the
 * interpolation BETWEEN control points is done in the shader, where it is
 * defined, so `OES_texture_float_linear` is never required.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *   - **It does not bundle.** No splat, no gradient, no anneal. A second copy
 *     of the kernel in GLSL is exactly the drift this file exists to avoid.
 *   - **It does not smooth between control points.** `sttBundlePathAt` is a
 *     piecewise-LINEAR walk of the polyline. The bundle is already Laplacian-
 *     smoothed on the CPU and resampled to uniform arc length, so a spline here
 *     would round corners the smoothing pass deliberately left; the arrow's own
 *     tessellation (`numSegments`, raised to the control-point count when
 *     bundling is on) is what makes the drawn river smooth.
 *   - **It does not own the fallback.** `uUseBundle` is a per-TILE switch, not
 *     a layer mode: a tile the bundler declined (over the edge cap, degenerate
 *     extent, a failed texture upload) uploads no texture and sets it to 0, and
 *     the layer's straight/baked-Bézier path draws instead. One compiled
 *     program serves both, exactly as `uUseFeatureColor` does for a tile
 *     missing its colour column.
 *
 * Like every kernel in this directory, each GLSL function ships with a JS
 * reference implementation in the same file so a test can pin the two together
 * with no GPU in the room.
 */

/**
 * Attribute / uniform names the GLSL below declares. Layers resolve locations
 * through these constants so the kernel, the layers and the tests cannot drift
 * on a string.
 */
export const BUNDLE_NAMES = Object.freeze({
  /** `sampler2D` — `pointsPerEdge × edgeCount` control points, mercator in `.xy`. */
  positions: 'uBundlePositions',
  /** `vec3` — `[pointsPerEdge, 1 / pointsPerEdge, 1 / edgeCount]`. */
  shape: 'uBundleShape',
  /** `float` — 1 when THIS TILE carries a bundle, 0 when it fell back. */
  enabled: 'uUseBundle',
  /** `float` attribute — this instance's row in the control-point texture. */
  row: 'aBundleRow',
} as const);

/**
 * Texture-upload recipe per host, as GL enum NAMES (the kernel itself stays
 * GL-free, like `flow.glsl.ts` and `lib/projection.ts`). A layer does
 * `gl[recipe.internalFormat]`, `gl[recipe.format]`, `gl[recipe.type]`.
 *
 * A WebGL1 host additionally requires `OES_texture_float` — see
 * `isBundlingSupported` in `lib/edge-bundler.ts`, which is the gate. Both hosts
 * need `NEAREST` min/mag filtering and `CLAMP_TO_EDGE` wrapping.
 */
export const BUNDLE_TEXTURE_RECIPE = Object.freeze({
  webgl2: Object.freeze({
    internalFormat: 'RGBA32F',
    format: 'RGBA',
    type: 'FLOAT',
    unpackAlignment: 4,
  }),
  webgl1: Object.freeze({
    internalFormat: 'RGBA',
    format: 'RGBA',
    type: 'FLOAT',
    unpackAlignment: 4,
  }),
} as const);

/** Per-instance attribute declaration to splice into a layer's vertex source. */
export const BUNDLE_ATTRIBUTE_GLSL = `
  attribute float aBundleRow;  // this instance's row in the control-point texture
`;

/**
 * Uniform declarations to splice into a layer's vertex source. All three are
 * declared together; the compiler strips any the layer never reads and
 * `getUniformLocation` then returns null — a no-op for the setter, the same
 * tolerance the DataFilter and flow kernels rely on.
 */
export const BUNDLE_UNIFORMS_GLSL = `
  uniform sampler2D uBundlePositions; // P × E control points, mercator in .xy
  uniform vec3 uBundleShape;          // [P, 1/P, 1/E]
  uniform float uUseBundle;           // 1 ⇒ this tile carries a bundle
`;

/** Canonical call expression, so every layer samples the bundle the same way. */
export const BUNDLE_PATH_CALL_GLSL = 'sttBundlePathAt(t, aBundleRow)';

/**
 * The load-bearing operations of {@link BUNDLE_PATH_GLSL}, in order. Exported
 * for a structural seam gate (the `GLOBE_ELEVATION_STEPS` / `FLOW_SAMPLER_STEPS`
 * pattern): asserting these survive is how a test says "this block still does
 * the thing" without pinning a whole string.
 */
export const BUNDLE_PATH_STEPS: readonly string[] = Object.freeze([
  'texture2D(uBundlePositions',
  'uBundleShape.x - 1.0',
  'floor(f)',
  'mix(a, b, frac)',
]);

/**
 * `sttBundleTexel(i, row)` (one exact control point) and `sttBundlePathAt(t,
 * row)` (the polyline position at arc parameter `t ∈ [0, 1]`).
 *
 * Semantics, mirrored exactly by {@link bundleTexelJS} / {@link bundlePathAtJS}:
 *   - `t` is CLAMPED to `[0, 1]`, so the head's over-shoot guard and any
 *     numerical spill past the tip read the LAST control point rather than
 *     wrapping onto row `row + 1`;
 *   - the walk is uniform in INDEX, which is uniform in ARC LENGTH because the
 *     CPU bundler resamples every edge to even spacing on its final pass — so
 *     `t` means the same fraction-along-the-corridor it means for a straight
 *     arrow, and the arrowhead lands in the same place;
 *   - `t = 1` collapses `i1` onto `i0`, degenerating to a plain read;
 *   - control points `0` and `P-1` are PINNED by the bundler to the pair's own
 *     endpoints, so `sttBundlePathAt(0.0)` is `aSource` and
 *     `sttBundlePathAt(1.0)` is `aTarget` to float precision. The arrow's
 *     on-screen length and head fraction are still measured off the chord
 *     attributes, and this is what keeps the two from disagreeing.
 *
 * The fetches happen in the VERTEX stage, which WebGL2 guarantees and WebGL1
 * does not (its `MAX_VERTEX_TEXTURE_IMAGE_UNITS` minimum is ZERO) — hence the
 * `isBundlingSupported` gate, whose failure mode is straight arrows.
 */
export const BUNDLE_PATH_GLSL = `
vec2 sttBundleTexel(float i, float row) {
  // Texel CENTRES under NEAREST filtering: an exact fetch of control point
  // \`i\` of edge \`row\`. uBundleShape.yz is [1/P, 1/E].
  return texture2D(uBundlePositions, (vec2(i, row) + 0.5) * uBundleShape.yz).xy;
}

vec2 sttBundlePathAt(float t, float row) {
  float last = uBundleShape.x - 1.0;
  float f = clamp(t, 0.0, 1.0) * last;
  float i0 = floor(f);
  float frac = f - i0;
  vec2 a = sttBundleTexel(i0, row);
  if (frac <= 0.0) return a;
  vec2 b = sttBundleTexel(min(i0 + 1.0, last), row);
  return mix(a, b, frac);
}
`;

/** Locations {@link BUNDLE_UNIFORMS_GLSL} declares, resolved per program. */
export interface BundleUniformLocations {
  uBundlePositions: WebGLUniformLocation | null;
  uBundleShape: WebGLUniformLocation | null;
  uUseBundle: WebGLUniformLocation | null;
}

/**
 * Resolve every {@link BundleUniformLocations} member against a linked program.
 * An absent (or compiled-out) uniform resolves to null.
 */
export function resolveBundleUniformLocations(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  program: WebGLProgram,
): BundleUniformLocations {
  return {
    uBundlePositions: gl.getUniformLocation(program, BUNDLE_NAMES.positions),
    uBundleShape: gl.getUniformLocation(program, BUNDLE_NAMES.shape),
    uUseBundle: gl.getUniformLocation(program, BUNDLE_NAMES.enabled),
  };
}

/**
 * JS reference for `sttBundleTexel`: control point `i` of edge `row` out of the
 * packed RGBA texel array (`(row * pointsPerEdge + i) * 4`).
 *
 * Indices are FLOORED and clamped, matching the shader's NEAREST fetch of a
 * texel centre — a fractional `i` resolves to the texel it sits in, never to a
 * blend, and an out-of-range `row` clamps rather than reading a neighbour.
 */
export function bundleTexelJS(
  texels: ArrayLike<number>,
  pointsPerEdge: number,
  edgeCount: number,
  i: number,
  row: number,
): [number, number] {
  const p = Math.min(Math.max(Math.floor(i), 0), pointsPerEdge - 1);
  const r = Math.min(Math.max(Math.floor(row), 0), edgeCount - 1);
  const o = (r * pointsPerEdge + p) * 4;
  return [texels[o], texels[o + 1]];
}

/**
 * JS reference for `sttBundlePathAt` — the piecewise-linear walk of one edge's
 * control polyline at arc parameter `t`. Used by the parity tests and by any
 * caller that needs a bundled position without a GPU round-trip (a legend, a
 * CPU hit test).
 */
export function bundlePathAtJS(
  texels: ArrayLike<number>,
  pointsPerEdge: number,
  edgeCount: number,
  t: number,
  row: number,
): [number, number] {
  const last = pointsPerEdge - 1;
  const f = Math.min(Math.max(t, 0), 1) * last;
  const i0 = Math.floor(f);
  const frac = f - i0;
  const a = bundleTexelJS(texels, pointsPerEdge, edgeCount, i0, row);
  if (frac <= 0) return a;
  const b = bundleTexelJS(
    texels,
    pointsPerEdge,
    edgeCount,
    Math.min(i0 + 1, last),
    row,
  );
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
}
