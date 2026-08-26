/**
 * Glyph-coverage GLSL chunk — the shared edge kernel behind `STTTextLayer`.
 *
 * A text atlas is sampled ONE of two ways and the difference is structural, not
 * a uniform:
 *
 *  - **SDF** (`sdf: true`): the alpha channel holds a signed distance field, so
 *    coverage is a `smoothstep` across a gamma band centred on the glyph edge.
 *    This is what makes a 12 px label and a 96 px label both look crisp from one
 *    64 px atlas, and it is what makes a cheap outline possible (the same field
 *    thresholded at a LOWER buffer is a dilated glyph).
 *  - **Bitmap** (`sdf: false`): the alpha channel is plain coverage, sampled
 *    bilinearly. Nothing to threshold.
 *
 * The chunk exists so the VISUAL and the ID-PICK fragment stages cannot drift.
 * A pick pass that computed coverage even slightly differently would make the
 * antialiased fringe of a glyph pickable (or the solid core unpickable), which
 * is exactly the "pick pass must never be more permissive than the visual pass"
 * rule. Both stages are emitted from {@link buildGlyphFragmentSource} and share
 * `sttGlyphCoverage` verbatim.
 *
 * As with every shared chunk in this package there is a JS reference
 * implementation ({@link glyphCoverageRef}) so a GPU-free test can pin the
 * numerics against hand-computed constants.
 *
 * This chunk deliberately does NOT do: colour bitmap fonts (an emoji atlas —
 * the bitmap path treats the atlas as a MASK and always tints), per-glyph
 * gamma from `fwidth` (`OES_standard_derivatives` is not universal on the
 * WebGL1 hosts this package still supports; the gamma is derived analytically
 * from the on-screen size instead), or multi-channel SDF.
 */

/**
 * `smoothstep` coverage of a distance-field sample against an edge `buffer`,
 * with a half-width `gamma` band. `gamma` is supplied per-vertex (it depends on
 * the on-screen text size), so a big label gets a tight band and a small one a
 * soft band — the analytic stand-in for a screen-space derivative.
 */
export const GLYPH_COVERAGE_GLSL = `
float sttGlyphCoverage(float dist, float buffer, float gamma) {
  return smoothstep(buffer - gamma, buffer + gamma, dist);
}
`;

/**
 * JS reference implementation of `sttGlyphCoverage`, byte-for-byte the GLSL
 * `smoothstep` definition (including its degenerate-edge behaviour: GLSL leaves
 * `edge0 == edge1` undefined, so this pins it to a hard step, which is what a
 * `gamma` of 0 should mean).
 */
export function glyphCoverageRef(
  dist: number,
  buffer: number,
  gamma: number,
): number {
  const edge0 = buffer - gamma;
  const edge1 = buffer + gamma;
  if (edge0 >= edge1) return dist < buffer ? 0 : 1;
  const t = Math.min(1, Math.max(0, (dist - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Uniform block the SDF fragment stage reads. Absent in the bitmap variant. */
export const GLYPH_SDF_UNIFORMS_GLSL = `  uniform float uSdfBuffer;
  uniform float uOutlineBuffer;
  uniform vec4 uOutlineColor;
`;

/**
 * Assemble a glyph fragment stage.
 *
 * Both variants compose the SAME final alpha —
 * `coverage * vColor.a * vAlpha` — and cut it against the SAME
 * `uAlphaCutoff`, because that expression IS the pickability contract: the id
 * stage differs only in what it writes to `gl_FragColor` once the gates pass.
 *
 * `vAlpha` carries the time-filter × DataFilter product from the vertex stage
 * and is discarded at `<= 0.0` first, so a filtered-out label costs one
 * compare.
 *
 * The SDF variant paints the outline by thresholding the SAME field at a lower
 * buffer: `uOutlineBuffer <= uSdfBuffer` dilates the glyph, the fill coverage
 * mixes the two colours, and the DILATED coverage is what becomes alpha. With
 * `outlineWidth: 0` the caller sets `uOutlineBuffer === uSdfBuffer`, the mix
 * factor and the alpha term collapse to the same value, and the result is
 * bit-identical to an outline-free shader — no second program needed.
 */
export function buildGlyphFragmentSource(
  kind: 'main' | 'id',
  sdf: boolean,
): string {
  const isId = kind === 'id';
  const coverage = sdf
    ? `    float dist = texture2D(uAtlas, vUv).a;
    float fill = sttGlyphCoverage(dist, uSdfBuffer, vGamma);
    float cover = sttGlyphCoverage(dist, uOutlineBuffer, vGamma);`
    : `    float cover = texture2D(uAtlas, vUv).a;`;
  const rgb = sdf
    ? '    vec3 rgb = mix(uOutlineColor.rgb, vColor.rgb, fill);'
    : '    vec3 rgb = vColor.rgb;';
  return `
  precision highp float;
  uniform sampler2D uAtlas;
  uniform float uAlphaCutoff;
${sdf ? GLYPH_SDF_UNIFORMS_GLSL : ''}  varying float vAlpha;
  varying vec2 vUv;
  varying vec4 vColor;
${sdf ? '  varying float vGamma;\n' : ''}${isId ? '  varying vec3 vIdColor;\n' : ''}${sdf ? GLYPH_COVERAGE_GLSL : ''}
  void main() {
    if (vAlpha <= 0.0) discard;
${coverage}
    float a = cover * vColor.a * vAlpha;
    if (a < uAlphaCutoff) discard;
${
  isId
    ? '    gl_FragColor = vec4(vIdColor, 1.0);'
    : `${rgb}
    gl_FragColor = vec4(rgb, a);`
}
  }
`;
}
