// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `time-height` — the uniform holder for the time-as-height ("space-time cube")
 * lift, the Three port of deck's `timeHeightScale`. A material that installs the
 * lift raises each feature by `(sttStart − heightOrigin) × heightScale` metres
 * along its per-vertex/per-instance `sttLift` direction.
 *
 * The lift is TWO scalar uniforms and nothing else, so animating the flat⇄cube
 * morph costs no attribute rewrite and no shader rebuild. One holder shared by
 * every lifting material keeps that contract single-sourced: a material bundle
 * surfaces this object as `timeHeight`, and the layer pushes `heightScale` /
 * `heightOrigin` into it.
 */

import { uniform } from './nodes.js';
import type { UniformNode } from './nodes.js';

/**
 * Live time-as-height uniforms. Both times are RELATIVE to the layer
 * `timeOrigin`, matching the `sttStart` attribute — feeding absolute epoch
 * milliseconds instead loses f32 precision and the lift visibly quantizes.
 * Idles flat while `heightScale` is 0 (deck's `timeHeightScale` default), so an
 * installed-but-unconfigured lift is a no-op.
 */
export class TimeHeightUniforms {
  /** Metres of altitude per simulation millisecond (0 = flat). */
  readonly heightScale: UniformNode = uniform(0);
  /** Relative time (vs the layer timeOrigin) mapped to altitude 0. */
  readonly heightOrigin: UniformNode = uniform(0);
}
