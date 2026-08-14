// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * sRGB → working-colour-space conversion for the material colour nodes.
 *
 * Every STT colour — `colorMapping` values, ramp stops, the palette textures,
 * the `r,g,b` / `point_rgba` camera columns — is authored as **sRGB bytes**:
 * the same 0–255 numbers the deck.gl layers, the demo configs and the showcase
 * legend swatches use. deck writes those straight to an unmanaged canvas, so
 * what you author is what you see.
 *
 * Three is colour-managed. `WebGPURenderer.outputColorSpace` defaults to
 * `SRGBColorSpace` (and r3f re-asserts it unless `<Canvas linear>`), so the
 * output pass runs the linear→sRGB OETF over whatever the fragment stage
 * produced. Handing it a value that is ALREADY sRGB encodes it a second time:
 * mid-tones lift by ~50/255 and saturated colours go pastel — the app cyan
 * `[31,186,214]` reaches the screen as `[98,222,236]`, `[253,128,93]` as
 * `[254,188,163]`. That is why the Three layers washed out toward white while
 * the deck layers rendered the intended palette.
 *
 * So decode once on the way in: {@link srgbToWorking} runs the matching EOTF in
 * the fragment stage and the output pass's OETF returns the authored byte
 * exactly. That buys deck parity WITHOUT switching colour management off for
 * the rest of the scene — the atmosphere and the glTF-textured `STTTiles3D`
 * paths need it on, and `new Color(hex)` content (the ego trail, the ground,
 * the globe sphere) is already converted for us by `ColorManagement`.
 *
 * Two rules for callers:
 *
 *  • Convert **colour only** — never alpha, never an id material. Alpha is
 *    linear already (it is `opacityNode`, not part of the transfer function),
 *    and the GPU-pick pass renders into a `RenderTarget`, which stays in the
 *    working colour space with no output encode, so its 24-bit indices must
 *    reach the readback bit-exact.
 *
 *  • Convert **last**, on the final fragment colour — after the gradient
 *    `mix()`es, after the column shade term, after the icon atlas × tint
 *    product. deck does all of those on sRGB values, so interpolating the
 *    varying and converting per-fragment reproduces deck's result exactly;
 *    converting per-vertex first would interpolate in a different space.
 *
 * `srgbToLinear` in `../lib/color.ts` is the CPU mirror of this node, for the
 * few layers that shade through a classic `vertexColors` material rather than a
 * TSL graph (H3 / Quadbin summaries, the AV map paths and bounding boxes).
 */

import { SRGBColorSpace } from 'three';
import { colorSpaceToWorking, vec4, type TSLNode } from './nodes.js';

/**
 * An sRGB-authored `vec3` colour → the renderer's working colour space.
 *
 * Delegates to Three's own `ColorSpaceNode`, so it resolves the working space
 * at build time and becomes a no-op when the host has set
 * `ColorManagement.enabled = false` — in which case the output pass skips its
 * encode too, and the raw sRGB value is once again exactly what lands on screen.
 */
export function srgbToWorking(rgb: TSLNode): TSLNode {
  return colorSpaceToWorking(vec4(rgb, 1), SRGBColorSpace).rgb;
}
