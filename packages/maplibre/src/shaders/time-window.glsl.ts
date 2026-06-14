/**
 * Single source of truth for STT's time-filtering GLSL.
 *
 * Both `@poopdeck.gl/layers`'s `TimeFilterExtension` and `@poopdeck.gl/maplibre`'s layers
 * compare a feature's `[startTime, endTime]` (or per-vertex `vertexTime` in
 * trail mode) against the current time, with optional symmetric fade-in /
 * fade-out at each window edge. Keeping the math in one snippet here lets us:
 *
 *   1. Share *exactly* the same semantics across the two adapters, so a tile
 *      rendered by deck.gl and by maplibre lights up identical features at the
 *      identical instants. Previously each layer inlined a slightly different
 *      `entering`/`leaving` expression; see commit history for the divergence.
 *   2. Audit precision / saturation in one place.
 *
 * The snippet expects the *caller* to declare:
 *   - `attribute vec2 aTime`  (window-mode) — interleaved [startTime, endTime]
 *     relative to the tile's `timeOffset`.
 *   - `attribute float aVertexTime` (trail-mode) — per-vertex timestamp,
 *     relative to the tile's `timeOffset`.
 * and the matching uniforms. We emit only the floats `vAlphaWindow` /
 * `vAlphaTrail` — call sites pick which one(s) they want and combine.
 *
 * Why one snippet and not two:
 *   - Both modes are float-precision sensitive, and both must agree with the
 *     deck.gl extension's per-edge fade formula:
 *       fade_in_factor  = clamp((timeEnd - startTime) / fadeIn, 0..1)
 *       fade_out_factor = clamp((endTime - timeStart) / fadeOut, 0..1)
 *     where (timeStart,timeEnd) = (currentTime - half, currentTime + half).
 *   - Trail mode discards future vertices and ramps `1 - age/trailLength`.
 *
 * The functions return alpha factors only; nothing here projects positions or
 * touches colour. Call them from `main()` after attributes are read.
 */

/**
 * Window-mode helper. Compares a feature's [startTime, endTime] against the
 * `[uWindowStart, uWindowEnd]` half-window uniform. Returns a 0..1 alpha
 * factor including symmetric fade ramps.
 *
 * Mirrors the deck.gl `TimeFilterExtension` formula exactly:
 *   - fade-in:  factor *= (timeEnd  - startTime) / fadeIn   if age < fadeIn
 *   - fade-out: factor *= (endTime  - timeStart) / fadeOut  if remaining < fadeOut
 *
 * Note: the previous maplibre per-layer formula used
 *   entering = clamp((endTime - windowStart) / fadeIn, 0, 1)
 *   leaving  = clamp((windowEnd - startTime) / fadeOut, 0, 1)
 * which is asymmetric vs. deck.gl. The new formula here matches deck.gl, so
 * fades at the leading edge of a feature align across adapters.
 */
export const TIME_WINDOW_GLSL = `
float sttTimeWindowAlpha(
  vec2 timeRange,        // [featureStart, featureEnd], tile-relative
  float windowStart,
  float windowEnd,
  float fadeIn,
  float fadeOut
) {
  float startTime = timeRange.x;
  float endTime   = timeRange.y;
  // Overlap test: feature's [start,end] must overlap [windowStart, windowEnd].
  if (endTime < windowStart || startTime > windowEnd) {
    return 0.0;
  }
  float alpha = 1.0;
  if (fadeIn > 0.0) {
    // age = how long the feature has been visible at the trailing edge.
    float age = windowEnd - startTime;
    if (age < fadeIn) {
      alpha *= clamp(age / fadeIn, 0.0, 1.0);
    }
  }
  if (fadeOut > 0.0) {
    // remaining = how much of the feature still lies inside the window.
    float remaining = endTime - windowStart;
    if (remaining < fadeOut) {
      alpha *= clamp(remaining / fadeOut, 0.0, 1.0);
    }
  }
  return alpha;
}
`;

/**
 * Trail-mode helper. Hides vertices in the future or older than `trailLength`,
 * otherwise returns `1 - age/trailLength` (linear fade) when `fadeTrail` is
 * non-zero, or 1.0 (snake mode) when it is zero.
 *
 * Matches the deck.gl trail branch in `TimeFilterExtension`.
 */
export const TIME_TRAIL_GLSL = `
float sttTrailAlpha(
  float vertexTime,      // tile-relative
  float currentTime,     // tile-relative
  float trailLength,
  float fadeTrail        // 0 = no per-vertex fade (snake mode), 1 = fade
) {
  if (vertexTime > currentTime) return 0.0;
  if (trailLength <= 0.0) return 1.0;
  float age = currentTime - vertexTime;
  if (age > trailLength) return 0.0;
  if (fadeTrail > 0.5) {
    return clamp(1.0 - age / trailLength, 0.0, 1.0);
  }
  return 1.0;
}
`;

/**
 * Convenience: a JS-side reference implementation of the window-mode shader,
 * used by tests to cross-check parity with `@poopdeck.gl/layers`'s extension. Keeping
 * it in the same file as the GLSL source forces the two to stay in lock-step
 * if anyone ever edits the formula.
 */
export function timeWindowAlphaJS(
  startTime: number,
  endTime: number,
  windowStart: number,
  windowEnd: number,
  fadeIn: number,
  fadeOut: number,
): number {
  if (endTime < windowStart || startTime > windowEnd) return 0;
  let alpha = 1;
  if (fadeIn > 0) {
    const age = windowEnd - startTime;
    if (age < fadeIn) alpha *= Math.max(0, Math.min(1, age / fadeIn));
  }
  if (fadeOut > 0) {
    const remaining = endTime - windowStart;
    if (remaining < fadeOut) alpha *= Math.max(0, Math.min(1, remaining / fadeOut));
  }
  return alpha;
}

/** Trail-mode JS-side reference, used by parity tests. */
export function trailAlphaJS(
  vertexTime: number,
  currentTime: number,
  trailLength: number,
  fadeTrail: number,
): number {
  if (vertexTime > currentTime) return 0;
  if (trailLength <= 0) return 1;
  const age = currentTime - vertexTime;
  if (age > trailLength) return 0;
  if (fadeTrail > 0.5) return Math.max(0, Math.min(1, 1 - age / trailLength));
  return 1;
}
