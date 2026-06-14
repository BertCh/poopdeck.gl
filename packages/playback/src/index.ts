// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * @poopdeck.gl/playback — framework- and renderer-agnostic playback engine for
 * time-series and spatiotemporal visualization.
 *
 * The pieces compose bottom-up:
 *   - {@link TimeController}  — a dumb wall-clock × speed rAF clock.
 *   - {@link PlaybackGovernor} — the buffering state machine that wraps the
 *     clock and gates play/resume/seek on a buffered runway ahead of the
 *     playhead (see docs/roadmap/player-buffering.md).
 *   - {@link decideAutoSpeedMultiplier} — asymmetric ABR step decision.
 *   - {@link SttPlayer} — the HTMLMediaElement-shaped facade over the above;
 *     the recommended single entry point.
 *
 * The engine has zero runtime dependencies and never touches a renderer — feed
 * the governor any {@link BufferSource} (e.g. `@poopdeck.gl/core`'s tileset) and
 * wire the controller's time into whatever draws the frame.
 */

// The wall-clock × speed clock.
export { TimeController } from './time-controller';
export type { TimeControllerOptions, TimeControllerState } from './time-controller';

// Playback buffering governor — the state machine between user intent and the
// TimeController that gates play/resume/seek on the buffered runway.
export { PlaybackGovernor } from './playback-governor';
export type {
  BufferSource,
  BufferedRunway,
  GovernorEventMap,
  GovernorEventName,
  GovernorReadyEvent,
  GovernorWaitingEvent,
  PlaybackGovernorOptions,
  PlaybackGovernorState,
  PlaybackQoeStats,
  ThroughputEstimate,
} from './playback-governor';

// Auto-speed step decision (asymmetric ABR: immediate downshifts, damped
// upshifts) shared by every consumer of getAutoSpeedSuggestion.
export { decideAutoSpeedMultiplier } from './auto-speed';
export type { AutoSpeedDecisionOptions, AutoSpeedPhase } from './auto-speed';

// SttPlayer — the HTMLMediaElement-shaped facade over TimeController +
// PlaybackGovernor: the recommended single entry point. Owns the
// baseRate × playbackRate speed model and the throttled 'timeupdate' cadence.
export { SttPlayer } from './stt-player';
export type {
  SttPlayerEventMap,
  SttPlayerEventName,
  SttPlayerOptions,
} from './stt-player';
