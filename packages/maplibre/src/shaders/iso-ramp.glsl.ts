/**
 * Iso-level styling chunk — the LEVEL→style kernel `STTIsoLayer` splices into
 * both of its passes.
 *
 * An iso-contour carries one number that means everything about it: the LEVEL
 * (the value of the scalar field the contour traces — 500 hPa, 20 dBZ, the
 * 30 m depth curve). This chunk turns that one number into the three things a
 * contour map varies: its COLOUR (a continuous ramp across the level domain),
 * its WIDTH (optionally interpolated across the same domain), and its
 * EMPHASIS (whether the level sits on the "major" interval that a contour map
 * draws heavier and labels).
 *
 * WHY IT IS A SHADER KERNEL AND NOT A CPU PASS. Levels are per-FEATURE
 * constants, so a naive implementation would bake an RGBA per contour at tile
 * upload. That is what the line kind does with `colorProperty`, and it is
 * wrong here for one reason: the level DOMAIN is a layer-wide quantity that
 * widens as tiles stream in. Baked colours would leave every already-resident
 * tile on a stale domain — the classic "the same 500 hPa contour is two
 * different colours in two adjacent tiles" artefact. Evaluating the ramp from
 * a `uLevelDomain` UNIFORM restyles every resident tile in the same frame, for
 * free, with no cache rebuild. The same argument covers `majorInterval` and
 * the width range: all of them become animatable knobs instead of rebuilds.
 *
 * The ramp is read from a uniform ARRAY with a compare-in-a-fixed-loop rather
 * than a dynamic index. GLSL ES 1.00 does not guarantee dynamic indexing of
 * uniform arrays outside of loop indices, and this package must link on WebGL1
 * hosts; the loop costs {@link MAX_ISO_RAMP_STOPS} compares per vertex on a
 * per-SEGMENT-instanced quad, which is nothing next to the four-vertex
 * rasterization it feeds.
 *
 * What this chunk deliberately does NOT do:
 *   - It does not pick the domain. Auto-widening is a LAYER concern (it needs
 *     the tile stream); the kernel only ever reads the uniform it is handed.
 *   - It does not quantise. deck's summary layers bucket a ramp into
 *     `colorRange.length` steps; contours are already a quantisation of the
 *     field, so bucketing them a second time throws away the one continuous
 *     signal a contour map has. The ramp lerps.
 *   - It does not label. Text is a different kind.
 *
 * Every GLSL function here has a JS twin with the SAME name + `JS`, so the
 * test suite can assert the numeric contract byte-for-byte with no GL context
 * — the `shaders/time-window.glsl.ts` idiom.
 */

import type { RGBA } from '../base-layer.js';

/**
 * Ramp stops the shader can hold. 16 vec4s is an eighth of the ES 2.0
 * guaranteed vertex-uniform budget (128 vec4) and four times the widest
 * colour range deck ships. A longer caller ramp is RESAMPLED to 16 stops on
 * the CPU rather than truncated — truncating would silently drop the top of
 * the ramp, which on a contour map reads as "the storm core is missing".
 */
export const MAX_ISO_RAMP_STOPS = 16;

/**
 * Uniform block every iso program declares. Spliced verbatim; the resolver
 * below joins these names to locations. The block ends with a newline, so the
 * splice site pastes it as a whole template line and must `.trimEnd()` —
 * the same contract `TIME_MODE_UNIFORM_DECLS` carries.
 */
export const ISO_RAMP_UNIFORMS_GLSL = `  uniform vec4 uIsoRamp[${MAX_ISO_RAMP_STOPS}]; // ramp stops, RGBA 0..1
  uniform float uIsoRampCount;  // stops actually uploaded (1..MAX)
  uniform vec2 uLevelDomain;    // [min, max] of the level column
  uniform float uUseLevel;      // 1 when this tile carried the level column
  uniform float uMajorInterval; // 0 disables major emphasis
  uniform float uMajorWidthScale;
  uniform float uMinorOpacity;
  uniform float uWidthByLevel;  // 0/1 — interpolate width across the domain
  uniform vec2 uWidthRange;     // [atDomainMin, atDomainMax], in widthUnits
  uniform float uOpacity;
`;

/**
 * The kernel. `sttIsoRampColor` reads the `uIsoRamp` / `uIsoRampCount`
 * globals declared above rather than taking them as parameters: a GLSL ES 1.00
 * array parameter must be sized at the call site, which would hard-code the
 * stop count into every caller and defeat the point of the uniform.
 */
export const ISO_RAMP_GLSL = `
// Normalized position of a level inside the domain, 0..1. A degenerate domain
// (single level, or an empty tile) pins to 0 rather than dividing by zero —
// one contour level renders as the ramp's FIRST stop, which is a colour, not a
// NaN that would blank the whole tile.
float sttIsoLevelT(float level, vec2 domain) {
  float span = domain.y - domain.x;
  if (abs(span) < 1e-12) return 0.0;
  return clamp((level - domain.x) / span, 0.0, 1.0);
}

// Continuous ramp lookup. See the module header for why this compares in a
// fixed loop instead of indexing dynamically.
vec4 sttIsoRampColor(float t) {
  float n = max(uIsoRampCount, 1.0);
  if (n < 1.5) return uIsoRamp[0];
  float scaled = clamp(t, 0.0, 1.0) * (n - 1.0);
  float lo = floor(scaled);
  float frac = scaled - lo;
  float hi = min(lo + 1.0, n - 1.0);
  vec4 a = uIsoRamp[0];
  vec4 b = uIsoRamp[0];
  for (int k = 0; k < ${MAX_ISO_RAMP_STOPS}; k++) {
    float fk = float(k);
    if (fk == lo) a = uIsoRamp[k];
    if (fk == hi) b = uIsoRamp[k];
  }
  return mix(a, b, frac);
}

// Is this level on the major interval? Returns 1.0 / 0.0 so the caller can
// mix() rather than branch. The tolerance is a thousandth of the interval:
// levels arrive as f32, so an exact multiple like 850.0 / 50.0 can land an ulp
// off and a strict equality test would flicker the emphasis on and off between
// tiles that quantised the column differently.
float sttIsoMajor(float level, float interval) {
  if (interval <= 0.0) return 0.0;
  float ratio = level / interval;
  float nearest = floor(ratio + 0.5);
  float delta = abs(ratio - nearest) * interval;
  return (delta <= interval * 1e-3) ? 1.0 : 0.0;
}

// Width before the width SCALE and before any wake taper. \`enabled\` is a 0/1
// uniform product (the caller ANDs "the option is on" with "this tile has the
// column"), so a tile with no level column keeps the flat width instead of
// collapsing every contour to \`widthRange.x\`.
float sttIsoWidth(float t, float baseWidth, float enabled, vec2 widthRange) {
  float ramped = mix(widthRange.x, widthRange.y, clamp(t, 0.0, 1.0));
  return mix(baseWidth, ramped, clamp(enabled, 0.0, 1.0));
}
`;

/** Locations of every uniform {@link ISO_RAMP_UNIFORMS_GLSL} declares. */
export interface IsoRampUniformLocations {
  uIsoRamp: WebGLUniformLocation | null;
  uIsoRampCount: WebGLUniformLocation | null;
  uLevelDomain: WebGLUniformLocation | null;
  uUseLevel: WebGLUniformLocation | null;
  uMajorInterval: WebGLUniformLocation | null;
  uMajorWidthScale: WebGLUniformLocation | null;
  uMinorOpacity: WebGLUniformLocation | null;
  uWidthByLevel: WebGLUniformLocation | null;
  uWidthRange: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
}

/**
 * Resolve the block in one call, the `resolve*UniformLocations` idiom every
 * shared chunk here follows. The ramp array resolves by its BARE name: WebGL
 * returns element 0's location for `uIsoRamp`, and a single `uniform4fv` with
 * a longer payload fills the consecutive elements from there.
 */
export function resolveIsoRampUniformLocations(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  program: WebGLProgram,
): IsoRampUniformLocations {
  return {
    uIsoRamp: gl.getUniformLocation(program, 'uIsoRamp'),
    uIsoRampCount: gl.getUniformLocation(program, 'uIsoRampCount'),
    uLevelDomain: gl.getUniformLocation(program, 'uLevelDomain'),
    uUseLevel: gl.getUniformLocation(program, 'uUseLevel'),
    uMajorInterval: gl.getUniformLocation(program, 'uMajorInterval'),
    uMajorWidthScale: gl.getUniformLocation(program, 'uMajorWidthScale'),
    uMinorOpacity: gl.getUniformLocation(program, 'uMinorOpacity'),
    uWidthByLevel: gl.getUniformLocation(program, 'uWidthByLevel'),
    uWidthRange: gl.getUniformLocation(program, 'uWidthRange'),
    uOpacity: gl.getUniformLocation(program, 'uOpacity'),
  };
}

// ────────────────────────────── JS references ──────────────────────────────
// One per GLSL function above, same name + `JS`. These are the CONTRACT: the
// suite asserts against them, and any edit to the GLSL that is not mirrored
// here is a test failure rather than a silent rendering drift.

/** JS twin of `sttIsoLevelT`. */
export function isoLevelTJS(
  level: number,
  domain: readonly [number, number],
): number {
  const span = domain[1] - domain[0];
  if (Math.abs(span) < 1e-12) return 0;
  return Math.min(1, Math.max(0, (level - domain[0]) / span));
}

/** JS twin of `sttIsoRampColor`. `ramp` stops are RGBA in the 0..1 range. */
export function isoRampColorJS(t: number, ramp: ReadonlyArray<RGBA>): RGBA {
  if (ramp.length === 0) return [0, 0, 0, 0];
  if (ramp.length === 1) return [...ramp[0]] as RGBA;
  const scaled = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const lo = Math.floor(scaled);
  const frac = scaled - lo;
  const hi = Math.min(lo + 1, ramp.length - 1);
  const a = ramp[lo];
  const b = ramp[hi];
  return [
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
    a[3] + (b[3] - a[3]) * frac,
  ];
}

/** JS twin of `sttIsoMajor`. */
export function isoMajorJS(level: number, interval: number): number {
  if (!(interval > 0)) return 0;
  const ratio = level / interval;
  const nearest = Math.floor(ratio + 0.5);
  const delta = Math.abs(ratio - nearest) * interval;
  return delta <= interval * 1e-3 ? 1 : 0;
}

/** JS twin of `sttIsoWidth`. */
export function isoWidthJS(
  t: number,
  baseWidth: number,
  enabled: number,
  widthRange: readonly [number, number],
): number {
  const tc = Math.min(1, Math.max(0, t));
  const ramped = widthRange[0] + (widthRange[1] - widthRange[0]) * tc;
  const e = Math.min(1, Math.max(0, enabled));
  return baseWidth + (ramped - baseWidth) * e;
}

/**
 * Resample an arbitrarily long caller ramp down to at most
 * {@link MAX_ISO_RAMP_STOPS} stops, preserving the endpoints and sampling the
 * interior with the SAME lerp the shader uses. Ramps already short enough are
 * returned stop-for-stop (no resampling error on the common path).
 */
export function fitIsoRamp(ramp: ReadonlyArray<RGBA>): RGBA[] {
  if (ramp.length <= MAX_ISO_RAMP_STOPS) return ramp.map((c) => [...c] as RGBA);
  const out: RGBA[] = new Array(MAX_ISO_RAMP_STOPS);
  for (let i = 0; i < MAX_ISO_RAMP_STOPS; i++) {
    out[i] = isoRampColorJS(i / (MAX_ISO_RAMP_STOPS - 1), ramp);
  }
  return out;
}
