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
 *
 * DISPERSION (M5/CO-3+CO-4). The upshift deadband is the consumer-side half of
 * the same jitter re-fit the governor applies to its watermark and its
 * auto-speed safety factor: on a link whose measured rate wobbles, one
 * optimistic sample is worth less, so the deadband a rise must clear widens by
 * {@link dispersionScale}. Pass the governor's
 * `getThroughputDispersionCv()` as {@link AutoSpeedDecisionOptions.dispersionCv}
 * to enable it. Omitted (or `0` — a steady link, or a producer with no variance
 * channel at all) it is bit-for-bit the incumbent 0.25 policy.
 */

/** Default sensitivity `k` of {@link dispersionScale}. */
export const DISPERSION_SCALE_K = 2;
/** Ceiling of {@link dispersionScale} — the bound on the jitter re-fit. */
export const DISPERSION_SCALE_MAX = 3;

/**
 * The single jitter-response shape shared by every dispersion-sensitive knob in
 * this package: `clamp(1 + k·cv, 1, 3)`, where `cv = stdDev / rate` is the
 * measured coefficient of variation of the link's throughput.
 *
 * Defined once, here, because three call sites must move together or the tuning
 * story falls apart: the governor's effective low watermark (a jittery link
 * stalls EARLIER — `G_low_eff = lowWatermarkWallMs × dispersionScale(cv)`), the
 * governor's auto-speed safety factor (`η_eff = 0.7 / dispersionScale(cv)` — a
 * jittery link rises MORE slowly), and this module's upshift deadband (a
 * jittery link needs a BIGGER move to justify rising).
 *
 * Properties the callers depend on:
 * - `cv = 0` (a steady link) ⇒ exactly `1` ⇒ every knob keeps its configured
 *   value bit-for-bit. This is the incumbent-behaviour fallback, and it is also
 *   what a cold estimator, a missing `stdDev`, and a garbage input produce — a
 *   non-finite cv is read as NO SIGNAL, never as infinite jitter, so bad input
 *   can never silently move a threshold.
 * - Monotone non-decreasing in `cv`, and clamped at
 *   {@link DISPERSION_SCALE_MAX} so no amount of measured jitter can run a knob
 *   away — the bounded-knob requirement.
 */
export function dispersionScale(
  cv: number | null | undefined,
  k: number = DISPERSION_SCALE_K,
): number {
  if (typeof cv !== 'number' || !Number.isFinite(cv) || cv <= 0) return 1;
  const kk = Number.isFinite(k) && k > 0 ? k : 0;
  return Math.min(DISPERSION_SCALE_MAX, Math.max(1, 1 + kk * cv));
}

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
  /**
   * Measured coefficient of variation of the link's throughput
   * (`stdDev / bytesPerMs`, from `PlaybackGovernor.getThroughputDispersionCv()`).
   * Widens the UPSHIFT deadband by {@link dispersionScale} — a jittery link must
   * clear a bigger relative move before Auto rises.
   *
   * Downshifts are untouched: the asymmetry is the whole point, and damping a
   * downshift converts directly into a stall.
   *
   * @default 0 (steady link / no variance channel ⇒ the incumbent deadband
   * exactly)
   */
  dispersionCv?: number;
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
export const SPEED_STEPS = [
  0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10,
] as const;

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
  // The deadband is the only knob dispersion touches here (upshifts only), and
  // `dispersionScale(0) === 1`, so an omitted cv reproduces the incumbent
  // policy exactly.
  const deadband =
    (opts.upshiftDeadband ?? 0.25) * dispersionScale(opts.dispersionCv);

  const clamped = Math.min(max, Math.max(min, rawMultiplier));
  const snapped = steps.reduce((best, step) =>
    Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best,
  );
  if (snapped === prevMultiplier) return null;

  if (snapped > prevMultiplier) {
    // Upshift: damped — cadence-only, and only past the deadband.
    if (phase !== 'cadence') return null;
    if (
      prevMultiplier > 0 &&
      (snapped - prevMultiplier) / prevMultiplier <= deadband
    ) {
      return null;
    }
  }
  // Downshift: immediate, no deadband.
  return snapped;
}
