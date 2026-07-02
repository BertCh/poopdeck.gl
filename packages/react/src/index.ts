// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * @poopdeck.gl/react — React hooks and UI for spatiotemporal / time-series
 * playback, built on the renderer-agnostic @poopdeck.gl/playback engine.
 *
 *   - usePlayback         wire a TimeController + PlaybackGovernor into React
 *   - usePlaybackHotkeys  standard video-player keyboard map
 *   - PlaybackControls    transport bar + scrubber + density strip + speed
 *   - HoverPreview        YouTube-style scrubber hover thumbnail (deck.gl)
 *
 * Components are styled with standard Tailwind utility classes; consumers
 * supply their own Tailwind build (or override via `className`).
 */

// Hooks (zero rendering deps — only @poopdeck.gl/playback + react).
export { usePlayback } from "./hooks/use-playback";
export type {
  UsePlaybackOptions,
  PlaybackState,
  SourceRegistry,
} from "./hooks/use-playback";
export { usePlaybackHotkeys } from "./hooks/use-playback-hotkeys";
export { useDeckClock } from "./hooks/use-deck-clock";
export type { DeckClockProps } from "./hooks/use-deck-clock";

// Transport-bar UI (react only).
export { PlaybackControls } from "./components/PlaybackControls";
export type { PlaybackControlsProps } from "./components/PlaybackControls";

// Scrubber hover thumbnail (requires the @deck.gl/core + @deck.gl/react peers).
export { HoverPreview } from "./components/HoverPreview";
export type { HoverPreviewProps } from "./components/HoverPreview";
