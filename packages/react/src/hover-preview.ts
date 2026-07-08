// @poopdeck.gl/react/hover-preview
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * Subpath entry for the scrubber hover thumbnail. Kept out of the package
 * barrel because it value-imports the OPTIONAL `@deck.gl/core` +
 * `@deck.gl/react` peers — importing `@poopdeck.gl/react` alone must not
 * require deck.gl to be installed.
 *
 *   import { HoverPreview } from '@poopdeck.gl/react/hover-preview';
 */
export { HoverPreview } from './components/HoverPreview.js';
export type { HoverPreviewProps } from './components/HoverPreview.js';
