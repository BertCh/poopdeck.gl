// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Loosely-typed facade over `three/tsl`.
 *
 * TSL is a runtime shader-graph DSL. Its `@types/three` generics
 * (`Node<"float"> | Node<"vec4"> | …` with per-node-type swizzle/method
 * extensions, plus `AttributeNode<string>` / `VaryingNode<string>` for the
 * builders) are tuned for hand-authored graphs where every node's concrete type
 * is statically known. Our material builders compose nodes whose concrete type
 * varies step to step — unpack a quaternion, swizzle, `mix`, branch-free
 * `select` — so fighting those generics buys no real safety. The math is
 * mirrored and unit-tested on the CPU in `./time-filter-math.ts`, which is the
 * typed source of truth.
 *
 * So we re-export the builders we use with a single, documented loose node type.
 * New TSL materials should import their builders from here, not `three/tsl`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as TSL from 'three/tsl';

/** A loose TSL node — fluent ops, swizzles, and `.value` all compose freely. */
export type TSLNode = any;
/** A loose TSL uniform node whose `.value` the renderer sets per frame. */
export type UniformNode = any;

type Builder = (...args: any[]) => TSLNode;

// ── Builder functions ──────────────────────────────────────────────────────────
export const attribute = TSL.attribute as unknown as Builder;
export const uniform = TSL.uniform as unknown as Builder;
export const varying = TSL.varying as unknown as Builder;
export const float = TSL.float as unknown as Builder;
export const int = TSL.int as unknown as Builder;
export const vec2 = TSL.vec2 as unknown as Builder;
export const vec3 = TSL.vec3 as unknown as Builder;
export const vec4 = TSL.vec4 as unknown as Builder;
export const select = TSL.select as unknown as Builder;
export const min = TSL.min as unknown as Builder;
export const max = TSL.max as unknown as Builder;
export const saturate = TSL.saturate as unknown as Builder;
export const exp = TSL.exp as unknown as Builder;
export const sqrt = TSL.sqrt as unknown as Builder;
export const mix = TSL.mix as unknown as Builder;
export const step = TSL.step as unknown as Builder;
export const oneMinus = TSL.oneMinus as unknown as Builder;
/** `(vec4, sourceColorSpace) → vec4` in the renderer's working colour space.
 *  Wrapped by {@link ../tsl/color-space.srgbToWorking} — call that, not this. */
export const colorSpaceToWorking =
  TSL.colorSpaceToWorking as unknown as Builder;

// ── Built-in node constants ──────────────────────────────────────────────────
export const positionGeometry = TSL.positionGeometry as unknown as TSLNode;
export const modelViewMatrix = TSL.modelViewMatrix as unknown as TSLNode;
export const cameraProjectionMatrix =
  TSL.cameraProjectionMatrix as unknown as TSLNode;
