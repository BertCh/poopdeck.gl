// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * @poopdeck.gl/react — React hooks and UI for spatiotemporal / time-series
 * playback, built on the renderer-agnostic @poopdeck.gl/playback engine.
 *
 *   - usePlayback         wire a TimeController + PlaybackGovernor into React
 *   - usePlaybackHotkeys  standard video-player keyboard map
 *   - useReducedMotion    live prefers-reduced-motion subscription
 *   - PlaybackControls    transport bar + scrubber + density strip + speed
 *
 * HoverPreview (YouTube-style scrubber hover thumbnail) lives on the
 * `@poopdeck.gl/react/hover-preview` subpath because it value-imports the
 * OPTIONAL `@deck.gl/react` / `@deck.gl/core` peers — keeping it out of this
 * barrel lets the base package import (and typecheck) without deck.gl.
 *
 * Styling: control GEOMETRY and colour are inline styles, so the bar is usable
 * even in an app whose Tailwind build never scanned `node_modules`; layout uses
 * Tailwind utilities, shipped precompiled in `@poopdeck.gl/react/styles.css`.
 * Re-theme through the CSS custom properties that stylesheet documents, or pass
 * `className` / `style` to `PlaybackControls` to reach the root element.
 */

// Hooks (zero rendering deps — only @poopdeck.gl/playback + react).
export { usePlayback } from './hooks/use-playback.js';
export type {
  UsePlaybackOptions,
  PlaybackState,
  SourceRegistry,
} from './hooks/use-playback.js';
export {
  usePlaybackHotkeys,
  PLAYBACK_SHORTCUTS,
} from './hooks/use-playback-hotkeys.js';
export type { PlaybackShortcut } from './hooks/use-playback-hotkeys.js';
export { useReducedMotion } from './hooks/use-reduced-motion.js';
export { useDeckClock } from './hooks/use-deck-clock.js';
export type { DeckClockProps } from './hooks/use-deck-clock.js';

// Transport-bar UI (react only).
export { PlaybackControls } from './components/PlaybackControls.js';
export type { PlaybackControlsProps } from './components/PlaybackControls.js';
