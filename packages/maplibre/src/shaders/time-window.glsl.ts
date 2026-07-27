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
 *      identical instants. A layer that inlines its own `entering`/`leaving`
 *      expression instead reintroduces cross-adapter divergence.
 *   2. Audit precision / saturation in one place.
 *
 * The snippet expects the *caller* to declare:
 *   - `attribute vec2 aTime`  (window / wake / cumulative) — interleaved
 *     [startTime, endTime] relative to the tile's `timeOffset`.
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
 *
 * ── MODE SELECTION ──────────────────────────────────────────────────────────
 * All four `TimeFilterMode`s live here as INDEPENDENT functions — there is no
 * mode uniform, because maplibre layers pick their mode when they build the
 * vertex source (`buildPointVertexSource` & friends), the same place they pick
 * the legacy/v5 projection variant. The snippets declare no uniforms and no
 * attributes and share no symbols, so a layer may include one, several, or all
 * of them in one program and branch at the call site on its own uniform.
 * Mode precedence, when several knobs are set, is deck's (`TimeFilterExtension`
 * `vs:#main-start`): cumulative > wake > trail > window.
 *
 * ── PRECISION ───────────────────────────────────────────────────────────────
 * Every time value here is RELATIVE to the tile's `timeOffset` (feature times
 * are uploaded that way; `uCurrentTime`/`uWindowStart`/`uWindowEnd` are
 * relativized at draw time), so the subtractions stay f32-exact while the
 * relative span stays inside core's `MAX_RELATIVE_TIME_MS` (2^24 ms ≈ ±4.66 h).
 * `cumulative` is the one mode that intentionally spans years and accepts the
 * coarser quantization beyond 2^24 — its reveal steps by days, and the
 * comparison stays monotone under f32 rounding, so features still appear in
 * order (core's `assertRelTimeInRange` skips cumulative for exactly this
 * reason). Do NOT introduce a second time origin for it.
 */

import type { STTTimeFilterMode } from '../base-layer.js';

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
 * otherwise blends between a solid snake (`fadeTrail = 0`) and the classic
 * head→tail comet (`fadeTrail = 1`).
 *
 * `fadeTrail` is a CONTINUOUS 0..1 weight, not a threshold — the same
 * `1*(1-trailFade) + faded*trailFade` blend core `trailAlpha` computes (and
 * deck's `trailFade` uniform). At `fadeTrail = 0` and `fadeTrail = 1` it is
 * bit-identical to a threshold form; the intermediate values are what the
 * numeric `fadeTrail` prop (all five layer classes) needs.
 *
 * A non-positive `trailLength` returns 0 — the trail lights NOTHING. That is
 * core `trailAlpha` for every input except the measure-zero `vertexTime ==
 * currentTime` point where core computes 0/0 → NaN, exactly the relationship
 * {@link TIME_WAKE_GLSL}'s `wakeLength <= 0` guard has to core `wakeAlpha`.
 * deck's `TimeFilterExtension` never reaches its trail branch in that case
 * (`else if (timeFilter.trailLength > 0.0)`) — it falls through to the WINDOW
 * branch — so a layer that owns a window kernel must degrade `trail` →
 * `window` when its length knob is non-positive rather than compiling this in
 * and drawing nothing. The one layer without a window kernel (`STTTripsLayer`)
 * resolves the same case to its `off` mode, which is what this 0 means.
 */
export const TIME_TRAIL_GLSL = `
float sttTrailAlpha(
  float vertexTime,      // tile-relative
  float currentTime,     // tile-relative
  float trailLength,
  float fadeTrail        // 0 = solid snake, 1 = full head→tail fade, blended between
) {
  if (vertexTime > currentTime) return 0.0;
  if (trailLength <= 0.0) return 0.0;  // degenerate trail lights nothing (no 0/0)
  float age = currentTime - vertexTime;
  if (age > trailLength) return 0.0;
  float faded = clamp(1.0 - age / trailLength, 0.0, 1.0);
  return clamp(mix(1.0, faded, fadeTrail), 0.0, 1.0);
}
`;

/**
 * Wake-mode helper ("ship wake" / comet tail). A feature is lit only for
 * `wakeLength` ms AFTER its own `startTime`, fading linearly to 0 at the tail;
 * `endTime` is ignored (deck parity — `TimeFilterExtension` reads only
 * `instanceStartTime` in its wake branch).
 *
 * Mirrors core `wakeAlpha` with ONE guard added: a non-positive `wakeLength`
 * returns 0 instead of dividing by zero. That matches the codegen oracle
 * (`ALPHA_EXPR.wake`'s `select(wakeLength, …, 0)`) for every input, and matches
 * core `wakeAlpha` for every input except the measure-zero `age == 0` point
 * where core computes 0/0 → NaN. Layers must still select wake mode only when
 * `wakeLength > 0` (deck's precedence rule); the guard is defensive.
 *
 * `sttWakeSizeScale` is the matching VERTEX-stage size multiplier (core
 * `wakeSizeScale`, deck's `DECKGL_FILTER_SIZE` wake branch): the head keeps
 * full size, the tail shrinks toward `wakeTailScale` (core's
 * `DEFAULT_WAKE_TAIL_SCALE` = 0.15). Shipped alongside the alpha so a layer
 * cannot hand-roll a divergent `mix`.
 */
export const TIME_WAKE_GLSL = `
float sttWakeAlpha(
  vec2 timeRange,        // [featureStart, featureEnd], tile-relative (.y unused)
  float currentTime,     // tile-relative
  float wakeLength
) {
  if (wakeLength <= 0.0) return 0.0;   // degenerate wake lights nothing (no 0/0)
  float age = currentTime - timeRange.x;
  if (age < 0.0 || age > wakeLength) return 0.0;
  return clamp(1.0 - age / wakeLength, 0.0, 1.0);
}

float sttWakeSizeScale(
  float alpha,           // the sttWakeAlpha result for this feature
  float wakeTailScale    // tail multiplier; head is always 1.0
) {
  return wakeTailScale * (1.0 - alpha) + alpha;
}
`;

/**
 * Cumulative-mode helper ("draw and persist"). A feature appears once
 * `startTime <= currentTime` and stays lit for the rest of playback;
 * `endTime` is ignored (deck parity). `fadeIn` ramps the appearance 0→1 over
 * that many ms; 0 (the default) is a hard pop-in.
 *
 * Mirrors core `cumulativeAlpha` exactly, including `fadeIn <= 0` ⇒ no ramp.
 * (The codegen AST's `select(fadeIn, …)` fires on ANY non-zero fadeIn, so a
 * NEGATIVE fadeIn would zero the alpha there; core — and therefore this — keeps
 * it at 1. Negative fades are out of contract: `resolveFadeDurations` clamps at
 * 0 before the uniform is ever set.)
 *
 * Precision: this is the mode whose relative times legitimately exceed
 * `MAX_RELATIVE_TIME_MS`; see the module header.
 */
export const TIME_CUMULATIVE_GLSL = `
float sttCumulativeAlpha(
  vec2 timeRange,        // [featureStart, featureEnd], tile-relative (.y unused)
  float currentTime,     // tile-relative
  float fadeIn
) {
  float startTime = timeRange.x;
  if (startTime > currentTime) return 0.0;
  if (fadeIn > 0.0) {
    return clamp((currentTime - startTime) / fadeIn, 0.0, 1.0);
  }
  return 1.0;
}
`;

/**
 * The uniform DECLARATIONS each mode's kernel reads, one block per mode, to
 * splice into a vertex source next to the matching `TIME_*_GLSL` kernel. A
 * layer declares ONLY its compiled mode's block, so an unused uniform can
 * never be silently mis-set.
 *
 * Every block ends with a newline: the blocks paste at a line START and the
 * next declaration follows on its own line. A call site that splices
 * `${DECLS[mode]}` as a whole template line must `.trimEnd()`, exactly as it
 * already does for `DATA_FILTER_UNIFORMS_GLSL`, or it emits a blank line.
 *
 * `wake` here is the ALPHA-only block. A layer whose geometry also tapers
 * toward the tail reads `uWakeTailScale` on top and wants
 * {@link TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE}; a layer whose size is
 * not a style knob (an aggregated cell's footprint, a polygon's outline) must
 * NOT declare it, because a wake taper it cannot honour would read as a
 * shrinking bin.
 */
export const TIME_MODE_UNIFORM_DECLS: Readonly<
  Record<STTTimeFilterMode, string>
> = Object.freeze({
  window: `  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
`,
  wake: `  uniform float uCurrentTime;
  uniform float uWakeLength;
`,
  cumulative: `  uniform float uCurrentTime;
  uniform float uFadeIn;
`,
  trail: `  uniform float uCurrentTime;
  uniform float uTrailLength;
  uniform float uFadeTrail;
`,
});

/**
 * The one declaration {@link TIME_WAKE_GLSL}'s `sttWakeSizeScale` adds on top
 * of the wake alpha block. Last in the block, so appending it to
 * {@link TIME_MODE_UNIFORM_DECLS}`.wake` yields the full wake declaration.
 */
export const WAKE_TAIL_SCALE_UNIFORM_DECL = '  uniform float uWakeTailScale;\n';

/**
 * {@link TIME_MODE_UNIFORM_DECLS} for a layer that tapers wake geometry toward
 * the tail. Only `wake` differs; the other three modes are the same blocks, so
 * a layer picks ONE of the two records and indexes it by its compiled mode.
 */
export const TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE: Readonly<
  Record<STTTimeFilterMode, string>
> = Object.freeze({
  ...TIME_MODE_UNIFORM_DECLS,
  wake: TIME_MODE_UNIFORM_DECLS.wake + WAKE_TAIL_SCALE_UNIFORM_DECL,
});

/**
 * Locations of the uniforms {@link TIME_MODE_UNIFORM_DECLS} declares, across
 * all four modes. Only the compiled mode's members resolve to a real location;
 * the rest are null, which every `gl.uniform*` call ignores — so one handles
 * shape serves a layer whose mode is a runtime knob.
 *
 * A layer extends this and adds its own locations:
 *   `interface XxxHandles extends TimeUniformLocations { program: …; … }`
 */
export interface TimeUniformLocations {
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uWakeLength: WebGLUniformLocation | null;
  uTrailLength: WebGLUniformLocation | null;
  uFadeTrail: WebGLUniformLocation | null;
}

/**
 * The wake taper's location, kept out of {@link TimeUniformLocations} so a
 * layer that cannot shrink its geometry does not carry a field it never sets.
 */
export interface WakeTailScaleUniformLocation {
  uWakeTailScale: WebGLUniformLocation | null;
}

/**
 * Resolve every {@link TimeUniformLocations} member against a linked program.
 * Names match {@link TIME_MODE_UNIFORM_DECLS} declaration for declaration; an
 * absent (or compiled-out) uniform resolves to null.
 */
export function resolveTimeUniformLocations(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  program: WebGLProgram,
): TimeUniformLocations {
  return {
    uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
    uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
    uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
    uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
    uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
    uWakeLength: gl.getUniformLocation(program, 'uWakeLength'),
    uTrailLength: gl.getUniformLocation(program, 'uTrailLength'),
    uFadeTrail: gl.getUniformLocation(program, 'uFadeTrail'),
  };
}

/** Resolve the wake taper's location; null unless the program declares it. */
export function resolveWakeTailScaleUniformLocation(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  program: WebGLProgram,
): WakeTailScaleUniformLocation {
  return {
    uWakeTailScale: gl.getUniformLocation(program, 'uWakeTailScale'),
  };
}

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
    if (remaining < fadeOut)
      alpha *= Math.max(0, Math.min(1, remaining / fadeOut));
  }
  return alpha;
}

/**
 * Trail-mode JS-side reference, used by parity tests. `fadeTrail` is the same
 * continuous 0..1 weight the GLSL takes; equals core `trailAlpha(currentTime,
 * vertexTime, trailLength, fadeTrail)` for every `trailLength > 0`, and for
 * `trailLength <= 0` everywhere core is not 0/0.
 */
export function trailAlphaJS(
  vertexTime: number,
  currentTime: number,
  trailLength: number,
  fadeTrail: number,
): number {
  if (vertexTime > currentTime) return 0;
  if (trailLength <= 0) return 0;
  const age = currentTime - vertexTime;
  if (age > trailLength) return 0;
  const faded = Math.max(0, Math.min(1, 1 - age / trailLength));
  return Math.max(0, Math.min(1, 1 + (faded - 1) * fadeTrail));
}

/**
 * Wake-mode JS-side reference. Argument order mirrors {@link TIME_WAKE_GLSL}
 * (feature time first, like {@link trailAlphaJS}) — NOT core `wakeAlpha`'s
 * `(currentTime, startTime, …)`. Both times are tile-relative.
 */
export function wakeAlphaJS(
  startTime: number,
  currentTime: number,
  wakeLength: number,
): number {
  if (wakeLength <= 0) return 0;
  const age = currentTime - startTime;
  if (age < 0 || age > wakeLength) return 0;
  return Math.max(0, Math.min(1, 1 - age / wakeLength));
}

/** Wake-mode size multiplier JS-side reference (core `wakeSizeScale`). */
export function wakeSizeScaleJS(alpha: number, wakeTailScale: number): number {
  return wakeTailScale * (1 - alpha) + alpha;
}

/**
 * Cumulative-mode JS-side reference. Argument order mirrors
 * {@link TIME_CUMULATIVE_GLSL}; both times are tile-relative.
 */
export function cumulativeAlphaJS(
  startTime: number,
  currentTime: number,
  fadeIn: number,
): number {
  if (startTime > currentTime) return 0;
  if (fadeIn > 0)
    return Math.max(0, Math.min(1, (currentTime - startTime) / fadeIn));
  return 1;
}
