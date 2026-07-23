// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * The elevated-projection kernel — ONE implementation of the trickiest twelve
 * lines of GLSL in this package (Wave M3 seam pass).
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * Raising geometry off the ground is not one operation but three, because
 * `projectTileFor3D`'s elevation UNIT is host-variant dependent:
 *
 *  | host variant              | elevation unit  |
 *  | ------------------------- | --------------- |
 *  | legacy `uMatrix` (≤v4)    | MERCATOR-Z      |
 *  | v5+ prelude, MERCATOR     | MERCATOR-Z      |
 *  | v5+ prelude, GLOBE        | METRES          |
 *
 * …and on GLOBE it is worse than a unit change:
 *
 *  1. `projectTileFor3D` deliberately PRESERVES z there ("Unlike
 *     interpolateProjection, this variant preserves the Z value", maplibre
 *     `_projection_globe.vertex.glsl`), so calling it would drop the horizon
 *     clipping the flat path inherits and the BACK hemisphere would draw over
 *     the front. The block has to re-derive the clip z itself via
 *     `globeComputeClippingZ`.
 *  2. During the globe↔mercator transition the sphere term wants METRES while
 *     the flat fallback matrix wants MERCATOR-Z — one call cannot feed both, so
 *     the block mirrors maplibre's own `interpolateProjection` with the right
 *     unit on each side. `0.2` is maplibre's `z_globeness_threshold`, verbatim.
 *
 * ── Why it lives here ───────────────────────────────────────────────────────
 * Three layers need it — `STTPolygonLayer` (extruded fills), `STTColumnLayer`
 * (prisms + the space-time-cube lift) and `STTArcLayer` (arcs leave the ground
 * by definition) — and before this module each carried its own transcription.
 * Nothing in CI compiles GLSL, so a fix applied to one copy and not the others
 * would have surfaced as a back-hemisphere bleed in a browser, on one kind.
 *
 * Callers keep their own variable NAMES (the emitted text is unchanged from the
 * hand-written copies) because a shader is read in a GL debugger, where
 * `elevated`/`globePos` in the arc's projection function and `hereSphere`/
 * `hereGlobe` in the column's per-vertex block are the names the surrounding
 * code uses.
 */

/**
 * Names the emitted block DECLARES. All four are block-local, so two blocks in
 * one shader must differ in at least `out`, `sphere`, `globe` and `flat`.
 */
export interface ElevatedProjectionNames {
  /** `vec4` clip-space result the block declares and the caller consumes. */
  out: string;
  /** `vec3` sphere-space position (globe branch only). */
  sphere: string;
  /** `vec4` pure-globe clip position, before the transition blend. */
  globe: string;
  /** `vec4` mercator fallback, mixed in during the transition. */
  flat: string;
}

export interface ElevatedProjectionOptions {
  /** v5+ host (an injected prelude) vs the legacy `uMatrix` path. */
  usesPrelude: boolean;
  /** GLSL `vec2` expression: the position in tile-mercator 0..1. */
  xy: string;
  /**
   * GLSL `float` expression for the elevation in METRES — the GLOBE sphere
   * term (`spherePos * (1 + elev / GLOBE_RADIUS)`) and nothing else.
   */
  elevMeters: string;
  /**
   * GLSL `float` expression for the elevation in MERCATOR-Z — the legacy
   * `uMatrix` path and the v5 MERCATOR prelude's `projectTileFor3D`.
   */
  elevMercatorZ: string;
  /**
   * Mercator-z expression for the GLOBE transition's flat fallback. Defaults to
   * {@link elevMercatorZ}, which is right whenever the caller keeps elevation
   * in metres and converts explicitly. `STTPolygonLayer` overrides it because
   * it folds the metres→mercator-z factor into a UNIFORM whose VALUE differs
   * per variant, so its `elevMercatorZ` is already converted on mercator while
   * the same source needs an explicit conversion on globe.
   */
  elevMercatorZFallback?: string;
  names: ElevatedProjectionNames;
  /** Leading whitespace for the emitted statements. @default four spaces */
  indent?: string;
}

/**
 * Emit `vec4 <names.out> = <clip position of (xy, elevation)>;` for one host
 * variant, including the `#ifdef GLOBE` split on prelude hosts.
 *
 * The block always DECLARES its result rather than assigning `gl_Position`, so
 * a caller can consume it (`gl_Position = out;`, `return out;`, or a screen-
 * space offset computed from two of them, which is what the column's outline
 * pass does). Preprocessor directives are emitted at column 0 — GLSL ES 1.00
 * allows leading whitespace, but every hand-written copy this replaced put them
 * flush left and a GL debugger's line view is easier to read that way.
 */
export function buildElevatedProjection(o: ElevatedProjectionOptions): string {
  const {
    usesPrelude,
    xy,
    elevMeters,
    elevMercatorZ,
    elevMercatorZFallback = elevMercatorZ,
    names: { out, sphere, globe, flat },
    indent = '    ',
  } = o;

  if (!usesPrelude) {
    return `${indent}vec4 ${out} = uMatrix * vec4(${xy}, ${elevMercatorZ}, 1.0);\n`;
  }

  return `#ifdef GLOBE
${indent}vec3 ${sphere} = projectToSphere(${xy}) * (1.0 + ${elevMeters} / GLOBE_RADIUS);
${indent}vec4 ${globe} = u_projection_matrix * vec4(${sphere}, 1.0);
${indent}${globe}.z = globeComputeClippingZ(${sphere}) * ${globe}.w;
${indent}vec4 ${out} = ${globe};
${indent}if (u_projection_transition <= 0.999) {
${indent}  vec4 ${flat} = u_projection_fallback_matrix *
${indent}    vec4(${xy}, ${elevMercatorZFallback}, 1.0);
${indent}  ${out}.z = mix(0.0, ${globe}.z,
${indent}    clamp((u_projection_transition - 0.2) / 0.8, 0.0, 1.0));
${indent}  ${out}.xyw = mix(${flat}.xyw, ${globe}.xyw, u_projection_transition);
${indent}}
#else
${indent}vec4 ${out} = projectTileFor3D(${xy}, ${elevMercatorZ});
#endif
`;
}

/**
 * The five load-bearing operations of the globe branch, in order. Exported for
 * the seam gate: a structural check that survives a rename is the only way to
 * assert "this block still does the thing" without pinning whole strings.
 */
export const GLOBE_ELEVATION_STEPS: readonly string[] = [
  'projectToSphere(',
  'GLOBE_RADIUS',
  'globeComputeClippingZ(',
  'u_projection_fallback_matrix',
  'u_projection_transition',
];
