// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The generated time-filter alpha for a Cesium custom `Appearance` fragment
 * shader (GLSL ES 3.00). Cesium is a WebGL2/GLSL backend, so it consumes the
 * SAME `ALPHA_EXPR` AST as deck's `TimeFilterExtension` — no hand-written copy.
 * The worked `STTPointLayer` currently CPU-time-filters via the oracle; this
 * is the ready-made snippet for the GPU-appearance path (browser-verify to wire).
 */

import {
  ALPHA_EXPR,
  emitGLSL300,
  type TimeFilterModeKey,
} from '@poopdeck.gl/core/shader-codegen';

/**
 * The GLSL expression computing the time-filter alpha for `mode`. Pass a `nameMap`
 * to rewrite the canonical uniform/attr identifiers (`currentTime`, `startTime`,
 * `endTime`, `windowHalf`, `fadeIn`, `fadeOut`, `wakeLength`, `trailLength`,
 * `trailFade`, `vertexTime`) to the host shader's variable names.
 */
export function timeFilterAlphaGlsl(
  mode: TimeFilterModeKey,
  nameMap?: Record<string, string>,
): string {
  return emitGLSL300(ALPHA_EXPR[mode], nameMap);
}
