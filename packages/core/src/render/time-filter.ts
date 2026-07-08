// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT time-filter kernel — the framework-free CPU reference for the temporal
 * alpha every renderer backend animates against, plus the relativization scheme
 * and the vocabulary resolver they all share.
 *
 * This is the single source of truth ("the oracle"): deck's GLSL inject strings,
 * three's TSL node graph, and maplibre's hand-written GLSL are each a structural
 * mirror of the functions here, pinned by parity/conformance tests. The math was
 * originally authored as deck.gl's `TimeFilterExtension` and lived (verbatim) in
 * `@poopdeck.gl/three`'s `tsl/time-filter-math.ts`; it now lives here so all
 * three backends import ONE copy rather than keeping hand-maintained forks in
 * lockstep. See `docs/roadmap/renderer-abstraction-2026-06.md`.
 *
 * ── PRECISION CONTRACT ───────────────────────────────────────────────────────
 * Every time argument is RELATIVE to a time offset (absolute epoch-ms minus the
 * offset). deck/maplibre use a per-tile `timeOffset`; three uses one scene-wide
 * `timeOrigin`. `currentTime` is relativized the same way before it reaches a
 * uniform, so the subtractions below stay f32-exact while the relative span
 * stays within {@link MAX_RELATIVE_TIME_MS}.
 */

export type TimeFilterMode =
  | 'window'
  | 'wake'
  | 'cumulative'
  | 'trail'
  | 'none';

export interface TimeFilterParams {
  /** Half-width of the symmetric window (ms). `window` mode. */
  windowHalf?: number;
  /** Fade-in ramp at the window's leading edge (ms). `window` / `cumulative`. */
  fadeIn?: number;
  /** Fade-out ramp at the window's trailing edge (ms). `window`. */
  fadeOut?: number;
  /** Length of the wake behind the playhead (ms). `wake` mode. */
  wakeLength?: number;
  /** Trail length behind the playhead (ms). `trail` mode. */
  trailLength?: number;
  /** 1 ⇒ trail fades head→tail; 0 ⇒ solid trail. `trail` mode. */
  trailFade?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * `window` — a feature is visible while its `[startTime, endTime]` interval
 * overlaps the symmetric window `[currentTime ± windowHalf]`, with optional
 * fade-in / fade-out ramps at the window edges.
 */
export function windowAlpha(
  currentTime: number,
  startTime: number,
  endTime: number,
  windowHalf: number,
  fadeIn = 0,
  fadeOut = 0,
): number {
  const timeStart = currentTime - windowHalf;
  const timeEnd = currentTime + windowHalf;
  if (endTime < timeStart || startTime > timeEnd) return 0;
  let alpha = 1;
  if (fadeIn > 0) {
    const age = timeEnd - startTime;
    if (age < fadeIn) alpha *= age / fadeIn;
  }
  if (fadeOut > 0) {
    const remaining = endTime - timeStart;
    if (remaining < fadeOut) alpha *= remaining / fadeOut;
  }
  return clamp01(alpha);
}

/**
 * `wake` — visible only in `[0, wakeLength]` ms behind the playhead, fading
 * linearly to 0 at the tail. (The matching tail size-shrink — `mix(wakeTailScale,
 * 1, alpha)` — is applied in the material's size node, not here.)
 */
export function wakeAlpha(
  currentTime: number,
  startTime: number,
  wakeLength: number,
): number {
  const age = currentTime - startTime;
  if (age < 0 || age > wakeLength) return 0;
  return clamp01(1 - age / wakeLength);
}

/**
 * `cumulative` — a feature appears at its `startTime` and stays forever after
 * (draw-and-persist). `fadeIn`, if set, ramps its alpha 0→1 over that many ms.
 */
export function cumulativeAlpha(
  currentTime: number,
  startTime: number,
  fadeIn = 0,
): number {
  if (startTime > currentTime) return 0;
  if (fadeIn > 0) return clamp01((currentTime - startTime) / fadeIn);
  return 1;
}

/**
 * `trail` — per-vertex animation (trips): a vertex is visible while its
 * timestamp lies in `[currentTime - trailLength, currentTime]`; `trailFade`
 * blends between a solid trail (0) and a head→tail linear fade (1).
 */
export function trailAlpha(
  currentTime: number,
  vertexTime: number,
  trailLength: number,
  trailFade: number,
): number {
  const trailStart = currentTime - trailLength;
  if (vertexTime > currentTime || vertexTime < trailStart) return 0;
  const age = currentTime - vertexTime;
  const faded = clamp01(1 - age / trailLength);
  return clamp01(1 * (1 - trailFade) + faded * trailFade);
}

/**
 * Wake-mode tail size multiplier: tail shrinks toward `wakeTailScale`, head stays
 * full size. Mirrors deck's `DECKGL_FILTER_SIZE` wake branch.
 */
export function wakeSizeScale(alpha: number, wakeTailScale: number): number {
  return wakeTailScale * (1 - alpha) + 1 * alpha;
}

/**
 * The unified default wake-mode tail size multiplier (the "barely visible dot"
 * tail). Single-sourced here so the backends can't drift — they had already
 * split (deck 0.15 vs three 0.1); 0.15 is the resolved policy
 * (docs/roadmap/renderer-abstraction-2026-06.md Phase 1 decision).
 */
export const DEFAULT_WAKE_TAIL_SCALE = 0.15;

/** Dispatch to the active mode. `startTime`/`endTime`/`vertexTime` relative to offset. */
export function timeFilterAlpha(
  mode: TimeFilterMode,
  currentTime: number,
  startTime: number,
  endTime: number,
  params: TimeFilterParams = {},
  vertexTime = startTime,
): number {
  switch (mode) {
    case 'window':
      return windowAlpha(
        currentTime,
        startTime,
        endTime,
        params.windowHalf ?? 0,
        params.fadeIn ?? 0,
        params.fadeOut ?? 0,
      );
    case 'wake':
      return wakeAlpha(currentTime, startTime, params.wakeLength ?? 0);
    case 'cumulative':
      return cumulativeAlpha(currentTime, startTime, params.fadeIn ?? 0);
    case 'trail':
      return trailAlpha(
        currentTime,
        vertexTime,
        params.trailLength ?? 0,
        params.trailFade ?? 1,
      );
    case 'none':
    default:
      return 1;
  }
}

// ─── Relativization scheme (hoisted from deck's TimeFilterExtension) ─────────

/**
 * Largest relative-time magnitude that survives a Float32 round-trip with
 * full millisecond precision. f32 has a 24-bit mantissa, so integers up to
 * 2^24 (16,777,216) are exact — i.e. ±~4.66 HOURS around the offset. Beyond
 * that, granularity doubles each octave (2 ms at 2^25 ≈ 9.3 h, 4 ms at 2^26 ≈
 * 18.6 h, …), staying under one 60 fps frame (16 ms) of error out to ~3 days.
 * So the practical contract: pick the offset PER TEMPORAL CHUNK (not once per
 * dataset) so the animated relative span stays inside this window; a mismatched
 * offset silently shifts every feature's time. Cumulative mode intentionally
 * spans years and accepts the coarser quantization (its reveal steps by days).
 */
export const MAX_RELATIVE_TIME_MS = 16_777_216;

/**
 * Relativize an absolute time against a layer/scene time offset — the SINGLE
 * source of truth for the relativization scheme.
 * - Per-feature/per-vertex attributes store `absoluteTime - offset`.
 * - The `currentTime` shader uniform stores `currentTime - offset`.
 * Both sides are therefore small numbers that fit exactly in f32.
 */
export function relativizeTime(absoluteTime: number, offset: number): number {
  return absoluteTime - offset;
}

const _relTimeWarned = new Set<string>();

/**
 * Guard the f32 precision contract: a relative time past 2^24 ms loses
 * millisecond precision in the shader. Warns ONCE per key when the resolved
 * relative time crosses {@link MAX_RELATIVE_TIME_MS} in a non-cumulative mode
 * (cumulative intentionally spans years). Previously deck-only; hoisted so
 * three and maplibre — which quantized a too-wide span silently — can diagnose
 * it too. Pure/allocation-free on the hot path.
 */
export function assertRelTimeInRange(
  relativeTime: number,
  mode: TimeFilterMode,
  key = 'default',
): void {
  if (mode === 'cumulative') return;
  if (Math.abs(relativeTime) <= MAX_RELATIVE_TIME_MS) return;
  if (_relTimeWarned.has(key)) return;
  _relTimeWarned.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[stt/time-filter] relative time ${relativeTime} exceeds ${MAX_RELATIVE_TIME_MS} ms — ` +
      'Float32 precision is degraded; check that the time offset matches the tile data.',
  );
}

/** Test-only: reset the warn-once dedup set. */
export function _resetRelTimeWarnings(): void {
  _relTimeWarned.clear();
}

// ─── Vocabulary resolver (generalizes three resolveTimeWindow + maplibre resolveFadeDurations) ──

/**
 * The union of time-window vocabularies every backend accepts. deck & maplibre
 * expose FULL-width `timeWindow` + `fadeInDuration`/`fadeOutDuration`; three
 * filters against HALF-width `windowHalf` + `fadeIn`/`fadeOut`. When both the
 * full- and half-width form of a knob are supplied, the lower-level half-width
 * form wins (it is the more explicit control), matching three's historical
 * `resolveTimeWindow` precedence.
 */
export interface TimeFilterVocabulary {
  /** FULL-width window in ms (deck/maplibre). Converted to `windowHalf = timeWindow / 2`. */
  timeWindow?: number;
  /** Leading-edge fade ramp in ms (deck/maplibre `fadeInDuration`). */
  fadeInDuration?: number;
  /** Trailing-edge fade ramp in ms (deck/maplibre `fadeOutDuration`). */
  fadeOutDuration?: number;
  /**
   * OPT-IN soft window (maplibre vocabulary): the `softDefaultFraction` ramp
   * applies ONLY when this is explicitly `true` AND no explicit fade duration
   * is supplied. Unset/false ⇒ hard on/off (the unified deck/three default).
   * Honored only when a `softDefaultFraction` policy is supplied.
   */
  softTimeWindow?: boolean;
  /** Lower-level HALF-width window in ms (three-native). Wins over `timeWindow`. */
  windowHalf?: number;
  /** Lower-level leading-edge fade in ms (three-native). Wins over `fadeInDuration`. */
  fadeIn?: number;
  /** Lower-level trailing-edge fade in ms (three-native). Wins over `fadeOutDuration`. */
  fadeOut?: number;
  /** Mode params passed through untouched. */
  wakeLength?: number;
  trailLength?: number;
  trailFade?: number;
}

export interface ResolveTimeFilterPolicy {
  /** Half-width used when neither `windowHalf` nor `timeWindow` is supplied. */
  defaultWindowHalf?: number;
  /**
   * Fraction of the resolved full window applied as the soft fade ramp when
   * `softTimeWindow: true` is explicitly set and no explicit fade is given
   * (maplibre's soft window uses 0.1, floored at 1 ms). Omit (or leave
   * undefined) for backends with no soft-window vocabulary — fades then always
   * default to 0. The DEFAULT is a hard 0-cut either way: soft is strictly
   * opt-in (the shipped cross-backend policy, renderer-abstraction Phase 1).
   */
  softDefaultFraction?: number;
}

/**
 * Resolve the {@link TimeFilterVocabulary} into normalized {@link TimeFilterParams}.
 * Half-width knobs win over full-width; mode params pass through. Fades default
 * to 0 (hard cutoff). When `policy.softDefaultFraction` is set AND
 * `softTimeWindow === true` AND no explicit fade is supplied, both fades default
 * to that fraction of the full window (floored at 1 ms).
 */
export function resolveTimeFilterParams(
  v: TimeFilterVocabulary,
  policy: ResolveTimeFilterPolicy = {},
): TimeFilterParams {
  const windowHalf =
    v.windowHalf ??
    (v.timeWindow != null ? v.timeWindow / 2 : (policy.defaultWindowHalf ?? 0));

  let fadeIn = v.fadeIn ?? v.fadeInDuration;
  let fadeOut = v.fadeOut ?? v.fadeOutDuration;
  if (
    fadeIn == null &&
    fadeOut == null &&
    policy.softDefaultFraction != null &&
    v.softTimeWindow === true
  ) {
    const soft = Math.max(1, windowHalf * 2 * policy.softDefaultFraction);
    fadeIn = soft;
    fadeOut = soft;
  }

  return {
    windowHalf,
    fadeIn: fadeIn ?? 0,
    fadeOut: fadeOut ?? 0,
    wakeLength: v.wakeLength,
    trailLength: v.trailLength,
    trailFade: v.trailFade,
  };
}
