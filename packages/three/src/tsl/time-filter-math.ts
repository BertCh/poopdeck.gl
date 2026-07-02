// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The CPU time-filter reference moved to the framework-free kernel in
 * `@poopdeck.gl/core/time-filter` (see docs/roadmap/renderer-abstraction-2026-06.md).
 * This module stays as a re-export shim so every `./time-filter-math` importer
 * (the TSL materials, the CPU-interpolated layers, and the package barrel) keeps
 * resolving unchanged while the math lives in exactly one place. The TSL node
 * graph in `./time-filter.ts` remains the structural mirror of these functions.
 */

export {
  windowAlpha,
  wakeAlpha,
  cumulativeAlpha,
  trailAlpha,
  wakeSizeScale,
  timeFilterAlpha,
} from '@poopdeck.gl/core/time-filter';
export type { TimeFilterMode, TimeFilterParams } from '@poopdeck.gl/core/time-filter';
