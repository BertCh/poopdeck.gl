// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * TSL node for the GPU **stable-palette lookup** — the Three port of deck's
 * `CategoryColorExtension` fragment/vertex palette sample. The CPU side
 * (`../lib/palette.ts`) assigns each feature a STABLE slot into a `width × 1`
 * palette texture (RGBA, one texel per slot, the trailing texel the null /
 * default colour); this node reads the per-instance `sttCategoryIndex` attribute
 * and samples that texel, so a category renders the same colour in every tile and
 * RECOLOURING is a single uniform/texture swap — no per-feature CPU re-expand.
 *
 * Mirrors `./motion-glide.ts`: a NEAREST-filtered data texture sampled at the
 * texel centre (`u = (idx + 0.5) / width`), the width reciprocal carried in a
 * {@link PaletteUniforms} the layer sets once when it builds the texture. Off
 * (no palette) leaves the material's existing per-instance colour attribute path
 * BYTE-IDENTICAL.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  DataTexture,
  RGBAFormat,
  FloatType,
  NearestFilter,
  ClampToEdgeWrapping,
} from 'three';
import type { Texture } from 'three';
import * as TSL from 'three/tsl';
import { attribute, uniform, float, vec2 } from './nodes.js';
import type { TSLNode, UniformNode } from './nodes.js';
import { paletteTextureData, type StablePalette } from '../lib/palette.js';

// `texture` is not surfaced on the ./nodes seam (a parallel agent owns that
// file); grabbed locally, loosely typed, exactly like icon/flow-corridor/glide
// materials. (Reported to the parent for a possible nodes.ts alias.)
const texture = TSL.texture as unknown as (...a: any[]) => any;

/**
 * Per-instance attribute the palette lookup reads — the STABLE category slot
 * ({@link import('../lib/palette.js').assignCategoryIndices}). Exported so the
 * layer and the shader agree on one spelling.
 */
export const PALETTE_ATTR = {
  /** float, the stable palette slot index for this instance. */
  categoryIndex: 'sttCategoryIndex',
} as const;

/**
 * Palette uniforms — just the texel-width reciprocal (set once when the palette
 * texture is built; the slot itself rides the per-instance attribute).
 */
export class PaletteUniforms {
  /** 1 / paletteWidth — converts a slot index to the texture u centre. */
  readonly invWidth: UniformNode = uniform(1);
}

/**
 * Build the palette-colour node: the RGBA (0..1) `vec4` for this instance,
 * sampled from `tex` at the texel of its `sttCategoryIndex` slot.
 *
 * @param tex The palette data texture (NEAREST-filtered RGBA, `width × 1`).
 * @param pu The palette uniforms (`invWidth`).
 */
export function paletteColorNode(tex: Texture, pu: PaletteUniforms): TSLNode {
  const idx = attribute(PALETTE_ATTR.categoryIndex, 'float');
  // Sample the centre of texel `idx` in a `1/invWidth`-wide, 1-tall texture.
  const u = idx.add(float(0.5)).mul(pu.invWidth);
  return texture(tex, vec2(u, float(0.5)));
}

/**
 * Build the `width × 1` RGBA-float palette {@link DataTexture} for a
 * {@link StablePalette} (NEAREST-filtered — the shader reads the exact slot
 * texel, no interpolation). The layer sets its material's `palette.invWidth` to
 * `1 / colors.length` after wiring. Shared by every kind's layer so the
 * texture-config contract lives in one place (mirrors icon-layer's glide texture).
 */
export function makePaletteTexture(palette: StablePalette): DataTexture {
  const width = palette.colors.length;
  const tex = new DataTexture(
    paletteTextureData(palette),
    width,
    1,
    RGBAFormat,
    FloatType,
  );
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
