// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `motion-glide` — the GPU interpolation node for the motionInterpolation
 * ("glide") family (Wave 1 item 7). Given a per-track keyframe DATA TEXTURE
 * (`../lib/track-keyframes.ts` bakes it: RGB = RTC-local position, A = heading
 * in radians) and the shared `currentTime` uniform, the VERTEX stage maps time
 * to a fractional frame position, fetches the two bracketing keyframe columns
 * and `mix()`es them — so the instance GLIDES between its samples with ZERO
 * per-frame CPU attribute writes. Only the time uniform changes each frame.
 *
 * O(1) lookup (the roadmap's "fixed-rate resample" verdict): the CPU already
 * resampled each track onto a uniform grid, so the shader is a straight
 * `frame = (t − t0)·invDt` — no per-vertex binary search. The two-fetch + `mix`
 * is done explicitly (rather than leaning on hardware LINEAR filtering, which
 * needs the WebGL2 `OES_texture_float_linear` extension for float textures), so
 * the texture is NEAREST-filtered and the path is portable to WebGL2 and WebGPU
 * alike. The exact same texel arithmetic is mirrored on the CPU in
 * {@link import('../lib/track-keyframes.js').glideSampleCpu} for unit testing.
 *
 * STORAGE-BUFFER NOTE. The roadmap's end-state swaps this NEAREST data-texture
 * fetch for a WebGPU `storage()` / `instancedArray` read (a strictly-WebGPU
 * optimisation). That is a drop-in replacement of the `keyframeTexelNode` fetch
 * ONLY — the CPU assembly, the per-instance locator attributes and the material
 * wiring are all store-agnostic. The data-texture path is the portable baseline
 * that runs on BOTH backends, so it ships first; see the campaign doc.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Texture } from 'three';
import * as TSL from 'three/tsl';
import { attribute, uniform, float, vec2, min, mix } from './nodes.js';
import type { TSLNode, UniformNode } from './nodes.js';

// Builders not surfaced on the ./nodes seam (a parallel agent owns that file;
// grabbed locally, loosely typed, exactly like icon/flow-corridor materials).
const texture = TSL.texture as unknown as (...a: any[]) => any;
const floor = TSL.floor as unknown as (...a: any[]) => any;
const clamp = TSL.clamp as unknown as (...a: any[]) => any;

/**
 * Per-instance attribute names the glide vertex stage reads. The layer sets these
 * from a {@link import('../lib/track-keyframes.js').KeyframeField}. Exported as
 * constants so the layer and the shader agree on one spelling.
 */
export const GLIDE_ATTR = {
  /** Grid origin (relative ms) — the track's first-sample time. */
  t0: 'sttGlideT0',
  /** 1 / dt (ms⁻¹); 0 holds a singleton at column 0. */
  invDt: 'sttGlideInvDt',
  /** frameCount − 1 (clamp upper bound in frame units). */
  frameMax: 'sttGlideFrameMax',
  /** Texture v of this instance's row centre. */
  rowV: 'sttGlideRowV',
} as const;

/** Glide uniforms — just the texel-width reciprocal (set once when the texture
 *  is built; the time uniform is the material's shared `TimeFilterUniforms`). */
export class GlideUniforms {
  /** 1 / texWidth — converts a column index to the texture u centre. */
  readonly invTexWidth: UniformNode = uniform(1);
}

/**
 * Build the glided keyframe texel node: a `vec4` (`xyz` = RTC-local position,
 * `w` = heading in radians) interpolated between the two columns bracketing
 * `currentTime`.
 *
 * @param tex The keyframe data texture (NEAREST-filtered RGBA float).
 * @param currentTime The shared relative-playhead uniform node
 *   (`TimeFilterUniforms.currentTime`).
 * @param gu The glide uniforms (`invTexWidth`).
 */
export function glideSampleNode(
  tex: Texture,
  currentTime: TSLNode,
  gu: GlideUniforms,
): TSLNode {
  const t0 = attribute(GLIDE_ATTR.t0, 'float');
  const invDt = attribute(GLIDE_ATTR.invDt, 'float');
  const frameMax = attribute(GLIDE_ATTR.frameMax, 'float');
  const rowV = attribute(GLIDE_ATTR.rowV, 'float');

  // Fractional frame position, clamped to the track's filled columns.
  const framePos = clamp(currentTime.sub(t0).mul(invDt), float(0), frameMax);
  const f = floor(framePos);
  const frac = framePos.sub(f);

  // Two bracketing columns → texel centres (NEAREST reads the exact column).
  const colB = min(f.add(float(1)), frameMax);
  const uA = f.add(float(0.5)).mul(gu.invTexWidth);
  const uB = colB.add(float(0.5)).mul(gu.invTexWidth);
  const texelA = texture(tex, vec2(uA, rowV));
  const texelB = texture(tex, vec2(uB, rowV));

  return mix(texelA, texelB, frac);
}

/** Convenience: the glided WORLD POSITION node (`xyz` of {@link glideSampleNode}). */
export function glidePositionNode(
  tex: Texture,
  currentTime: TSLNode,
  gu: GlideUniforms,
): TSLNode {
  return glideSampleNode(tex, currentTime, gu).xyz;
}
