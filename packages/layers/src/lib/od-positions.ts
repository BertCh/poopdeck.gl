// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Origin→destination (source/target) endpoint derivation for the OD flow layers
 * (AnimatedArcLayer, AnimatedLineLayer). The implementation moved to the
 * framework-free kernel `@poopdeck.gl/core/geometry` (byte-identical extraction —
 * three's OD layer re-exports the same function); this module stays as a
 * re-export shim so the deck OD layers import an unchanged surface while the
 * logic lives in exactly one place. See docs/roadmap/renderer-abstraction-2026-06.md.
 */

export {
  deriveSourceTargetPositions,
  type SourceTargetPositions,
} from '@poopdeck.gl/core/geometry';
