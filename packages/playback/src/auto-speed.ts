// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * Auto-speed step decision for consumers of
 * {@link PlaybackGovernor.getAutoSpeedSuggestion}.
 *
 * The governor does the honest sustainable-speed math; this module owns the
 * consumer-side snapping/clamping/hysteresis so every Auto-speed UI applies
 * the SAME asymmetric policy (docs/roadmap/playback-and-loading.md §2, after
 * hls.js ABR's 0.95-down / 0.7-up factors):
 *
 * - DOWNSHIFTS apply immediately, with no deadband — the suggestion already
 *   says the network cannot sustain the current speed, so any damping here
 *   converts directly into a stall.
 * - UPSHIFTS are damped: only on the slow re-evaluation cadence, and only
 *   when the suggested step is a >`upshiftDeadband` relative move. Rising
 *   eagerly on one optimistic sample produces speed flapping.
 *
 * The suggested multiplier is clamped to [min, max] and snapped to the
 * nearest preset-like step before the asymmetry is applied, so Auto never
 * lands on speeds the UI cannot display.
 */

/**
 * What triggered the re-evaluation:
 * - `'cadence'` — the periodic timer; both directions allowed.
 * - `'waiting'` — the governor entered a gate (stall/seek); the runway is
 *   already in deficit, so only downshifts are allowed (an upshift computed
 *   from a momentarily-stale cost would deepen the stall).
 */
export type AutoSpeedPhase = 'cadence' | 'waiting';

export interface AutoSpeedDecisionOptions {
  /** Preset-like steps the result snaps to. @default [0.25 … 10] (the showcase preset row) */
  steps?: readonly number[];
  /** Lower clamp for the suggested multiplier. @default 0.25 */
  minMultiplier?: number;
  /** Upper clamp for the suggested multiplier. @default 10 (top of the preset row) */
  maxMultiplier?: number;
  /** Relative deadband applied to UPSHIFTS only. @default 0.25 */
  upshiftDeadband?: number;
}

/**
 * The canonical 13-step speed-multiplier ladder shared by every Auto-speed /
 * keyboard-stepping surface (this module's snapping default, and
 * `@poopdeck.gl/react`'s `usePlaybackHotkeys`). This is the single source of
 * truth: retuning it here retunes what Auto-speed can produce AND where +/-
 * keyboard stepping lands, so the two can never drift out of lockstep.
 *
 * (`PlaybackControls.speedPresets` is a distinct 5-button quick-pick, not this
 * ladder.)
 */
export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

const DEFAULT_STEPS = SPEED_STEPS;

/**
 * Decide the next Auto-speed multiplier, or `null` to hold the current one.
 *
 * @param prevMultiplier current speed multiplier (relative to base speed)
 * @param rawMultiplier  governor suggestion ÷ base speed (unclamped)
 * @param phase          what triggered this evaluation (see {@link AutoSpeedPhase})
 */
export function decideAutoSpeedMultiplier(
  prevMultiplier: number,
  rawMultiplier: number,
  phase: AutoSpeedPhase,
  opts: AutoSpeedDecisionOptions = {},
): number | null {
  const steps = opts.steps ?? DEFAULT_STEPS;
  const min = opts.minMultiplier ?? 0.25;
  const max = opts.maxMultiplier ?? 10;
  const deadband = opts.upshiftDeadband ?? 0.25;

  const clamped = Math.min(max, Math.max(min, rawMultiplier));
  const snapped = steps.reduce((best, step) =>
    Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best,
  );
  if (snapped === prevMultiplier) return null;

  if (snapped > prevMultiplier) {
    // Upshift: damped — cadence-only, and only past the deadband.
    if (phase !== 'cadence') return null;
    if (prevMultiplier > 0 && (snapped - prevMultiplier) / prevMultiplier <= deadband) {
      return null;
    }
  }
  // Downshift: immediate, no deadband.
  return snapped;
}
