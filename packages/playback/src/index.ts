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
 *     playhead (see docs/roadmap/playback-and-loading.md).
 *   - {@link decideAutoSpeedMultiplier} — asymmetric ABR step decision.
 *   - {@link SttPlayer} — the HTMLMediaElement-shaped facade over the above;
 *     the recommended single entry point.
 *
 * The engine has zero runtime dependencies and never touches a renderer — feed
 * the governor any {@link BufferSource} (e.g. `@poopdeck.gl/core`'s tileset) and
 * wire the controller's time into whatever draws the frame.
 */

// The wall-clock × speed clock.
export { TimeController } from './time-controller.js';
export type {
  TimeControllerOptions,
  TimeControllerState,
} from './time-controller.js';

// Playback buffering governor — the state machine between user intent and the
// TimeController that gates play/resume/seek on the buffered runway.
export { PlaybackGovernor } from './playback-governor.js';
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
  SourceRunway,
  ThroughputEstimate,
} from './playback-governor.js';

// Auto-speed step decision (asymmetric ABR: immediate downshifts, damped
// upshifts) shared by every consumer of getAutoSpeedSuggestion.
export { decideAutoSpeedMultiplier, SPEED_STEPS } from './auto-speed.js';
export type { AutoSpeedDecisionOptions, AutoSpeedPhase } from './auto-speed.js';

// SttPlayer — the HTMLMediaElement-shaped facade over TimeController +
// PlaybackGovernor: the recommended single entry point. Owns the
// baseRate × playbackRate speed model and the throttled 'timeupdate' cadence.
export { SttPlayer } from './stt-player.js';
export type {
  SttPlayerEventMap,
  SttPlayerEventName,
  SttPlayerOptions,
} from './stt-player.js';
