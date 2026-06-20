// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * SplatExtension — render ScatterplotLayer points as soft gaussian "splats".
 *
 * A ScatterplotLayer normally draws a hard (antialiased) disk. This extension
 * multiplies each fragment's alpha by a radial gaussian `exp(-k·r²)` where `r`
 * is the unit distance from the point centre (`geometry.uv`, which the
 * scatterplot fragment shader sets to `unitPosition` — 0 at centre, 1 at the
 * disk edge). The result is a fuzzy dot that fades to nothing at its rim;
 * overlapping splats blend into continuous surfaces, which reads as a colored
 * point-cloud / "poor-man's-photogrammetry" look rather than a field of discs.
 *
 * It's a pure fragment-stage effect — no extra attributes, no uniforms, no CPU
 * cost. Install it in the layer's extension list (after any color-writing
 * extension, so it shapes the FINAL alpha) and it composes with the existing
 * TimeFilter / CategoryColor injections (deck.gl concatenates same-hook
 * injections in extension order).
 *
 * Pairs naturally with per-point RGB (`AnimatedPointLayer.rgbColorColumns`):
 * camera-colored returns rendered as overlapping splats look like a photograph
 * sprayed onto the 3D structure. Best with a slightly larger `radius`, a touch
 * of transparency, and `billboard: true` so every splat faces the camera.
 */

import { LayerExtension } from '@deck.gl/core';

/**
 * Gaussian tightness. Higher = sharper core + faster edge falloff. At the disk
 * edge (r²=1) the alpha factor is `exp(-SPLAT_FALLOFF)`; 3.0 ⇒ ~0.05 (nearly
 * transparent rim) which gives a soft but still legible dot.
 */
const SPLAT_FALLOFF = 3.0;

/**
 * Layer extension that fades point alpha radially for a soft-gaussian splat.
 * Stateless — a single shared instance can serve every sublayer of a family.
 */
export class SplatExtension extends LayerExtension {
  static extensionName = 'SplatExtension';

  getShaders() {
    return {
      inject: {
        // geometry.uv is the point's unit position (length 0 at centre, 1 at
        // the rim); dot(uv,uv) is r² ∈ [0,1]. Multiply — never replace — alpha,
        // so the temporal-fade / categorical alpha written by earlier
        // extensions survives.
        'fs:DECKGL_FILTER_COLOR': `
          float splatR2 = dot(geometry.uv, geometry.uv);
          color.a *= exp(-${SPLAT_FALLOFF.toFixed(1)} * splatR2);
        `,
      },
    };
  }
}
