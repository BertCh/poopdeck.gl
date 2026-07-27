/**
 * Density-heatmap adapter — renders POINT-type tiles as a screen-space
 * heatmap. Equivalent to `@poopdeck.gl/layers`'s `HeatmapTimeLayer`.
 *
 * Pipeline (two passes):
 *
 *   1. Accumulate pass: each visible point is splatted into an offscreen
 *      framebuffer as a Gaussian disc with additive blending. The splat
 *      shader writes one accumulated-intensity value, replicated across all
 *      four channels; a `weightProperty` scales each point's contribution
 *      before accumulation. The ramp pass samples `.r`.
 *
 *   2. Colour-ramp pass: a full-screen quad samples the accumulator with a
 *      256×1 RGBA palette texture (default = OrRd, matches the deck.gl
 *      adapter's `HeatmapLayer` defaults), compositing into whatever
 *      framebuffer the host had bound when render() was called (the default
 *      framebuffer normally; an offscreen target under terrain/globe).
 *
 * Performance notes:
 *   - We render directly with `gl.POINTS` and rely on the GPU's `gl_PointSize`
 *     to size each splat. This is the same trick deck.gl's `HeatmapLayer`
 *     uses internally and keeps memory bandwidth low.
 *   - The accumulator texture is allocated lazily and resized whenever the
 *     `drawingBuffer{Width,Height}` changes. The framebuffer is recreated on
 *     resize because some drivers don't support framebuffer texture
 *     reattachment.
 *
 * Host-projection variants: the accumulate-pass vertex shader is built
 * per host shader variant — legacy hosts (maplibre ≤v4 / mapbox) compile the
 * plain `uMatrix` projection, while v5+ hosts get the map's injected
 * prelude + define prepended and project via `projectTile`, so splats land in
 * the correct screen position on mercator AND globe. The colour-ramp pass is
 * a screen-space fullscreen quad — projection-agnostic by construction.
 * Programs are cached per variant via the base `getOrCreateProgram`, linked
 * lazily on the first frame that needs them.
 *
 * Gating (time filter + DataFilter): which splats reach the accumulator is
 * decided entirely in the accumulate-pass VERTEX stage, by two independent
 * factors multiplied into the splat weight:
 *
 *   - the {@link STTHeatmapLayerOptions.timeFilterMode} alpha — one of the
 *     four shared kernels in `shaders/time-window.glsl.ts` (window / wake /
 *     cumulative / trail), selected at COMPILE time (the mode is part of the
 *     program-cache key, so no mode uniform and no dynamic branch), and
 *   - the column range filter from `shaders/data-filter.glsl.ts`, compiled in
 *     only when a `filterProperty` is configured.
 *
 * Both default OFF-shaped: `timeFilterMode` defaults to `'window'`, and with
 * no `filterProperty` no filter branch is compiled in at all.
 *
 * Picking: heatmap is deliberately NOT pickable. The rendered surface is a
 * density field — a pixel is the sum of an unbounded number of splats and has
 * no single feature identity to report, so the layer ships no `drawPickTile`
 * hook and `pick()` returns null (`supportsPicking() === false`). Hit-testing
 * a heatmap means picking the underlying POINT layer.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_HEATMAP_COLOR_RANGE } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type TileGpuCache,
  type TimeModeLoadKnobs,
  type RGBA8,
} from '../base-layer.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_TRAIL_GLSL,
  TIME_MODE_UNIFORM_DECLS,
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE,
  resolveTimeUniformLocations,
  resolveWakeTailScaleUniformLocation,
  type TimeUniformLocations,
  type WakeTailScaleUniformLocation,
} from '../shaders/time-window.glsl.js';
import {
  DATA_FILTER_GLSL,
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_UNIFORMS_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_NAMES,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type FilterTransformSizeUniformLocation,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';
import { POSITION_DEQUANT_GLSL } from '../shaders/position-quantization.glsl.js';

/**
 * The time-filter modes this layer can gate the accumulate pass with — the
 * package-wide {@link STTTimeFilterMode} under this layer's own name.
 */
export type STTHeatmapTimeFilterMode = STTTimeFilterMode;

export interface STTHeatmapLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /** Splat radius in pixels. */
  radiusPixels?: number;
  /** Intensity multiplier per point. */
  intensity?: number;
  /**
   * 0–255 RGBA colour ramp, sampled by intensity. Length 2–256. Default is a
   * 7-stop OrRd ramp matching the deck.gl adapter.
   */
  colorRange?: ReadonlyArray<RGBA8>;
  /**
   * Per-feature weight property name (defaults to constant 1 per point). Used
   * for analyses where each point has a magnitude/score.
   */
  weightProperty?: string;
  /**
   * Threshold below which accumulated intensity is rendered fully
   * transparent. 0 = no threshold; 0.05 hides faint regions and keeps the
   * heat tightly localised. Default 0.05.
   */
  threshold?: number;
  /**
   * Pinned `[min, max]` accumulated-intensity domain mapped onto the colour
   * ramp. When unset, the layer uses `metadata.heatmapDomain` (class `default`)
   * if the archive carries one (`stt-build --heatmap-weight`), else `[0, 1]`.
   * Mirrors the deck.gl HeatmapLayer's `colorDomain` so a weighted heatmap
   * scales the same on both adapters instead of washing out on maplibre.
   */
  colorDomain?: [number, number];
  /**
   * Which temporal kernel decides whether a point splats this frame. Default
   * `'window'` — the symmetric `timeWindow` filter with the
   * `fadeInDuration`/`fadeOutDuration` ramps.
   *
   *   - `'wake'` — a point splats for {@link wakeLength} ms AFTER its own
   *     start time, fading (and shrinking toward {@link wakeTailScale}) to
   *     nothing at the tail. `endTime` is ignored (deck parity).
   *   - `'cumulative'` — a point splats once `startTime <= currentTime` and
   *     never stops, so the heat builds up over playback. `fadeInDuration`
   *     doubles as the appear ramp.
   *   - `'trail'` — the trips kernel applied per point: splats within
   *     {@link trailLength} ms BEFORE the playhead, optionally fading with age
   *     ({@link fadeTrail}). A point tile has one vertex per feature, so the
   *     kernel's per-vertex time is the feature's start time (core
   *     `timeFilterAlpha`'s `vertexTime = startTime` default).
   *
   * `'cumulative'` carries a CALLER OBLIGATION (deck's `TimeFilterExtension`
   * states the same one): the shader does the reveal, the loader does not, so
   * `timeWindow` must be wide enough to cover the played-through range or
   * already-revealed tiles are evicted and the accumulated heat un-builds
   * itself as playback advances. `'wake'`/`'trail'` with a non-positive length
   * knob degrade to `'window'`, matching deck's branch guards.
   *
   * Selected at COMPILE time — the mode is part of the program-cache key.
   */
  timeFilterMode?: STTHeatmapTimeFilterMode;
  /**
   * `'wake'` mode: how long (ms) a point keeps splatting after its start time.
   * Default 0, which lights nothing — set it whenever you select wake mode.
   */
  wakeLength?: number;
  /**
   * `'wake'` mode: splat-radius multiplier at the tail of the wake (the head
   * always renders at full {@link radiusPixels}). Defaults to core's
   * `DEFAULT_WAKE_TAIL_SCALE` (0.15), shared with the deck + three backends.
   */
  wakeTailScale?: number;
  /**
   * `'trail'` mode: how far (ms) behind the playhead points keep splatting.
   * Defaults to the layer's `timeWindow` and TRACKS `setTimeWindow`. An
   * explicit non-positive value degrades the mode to `'window'`.
   */
  trailLength?: number;
  /**
   * `'trail'` mode head→tail fade: `1`/`true` (default) fades a splat's weight
   * linearly with age, `0`/`false` holds constant weight for the whole trail
   * (snake mode), intermediate numbers blend between them (package-wide
   * `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
}

/** Layer options after defaulting — what the draw path reads. */
interface ResolvedHeatmapOptions {
  radiusPixels: number;
  intensity: number;
  threshold: number;
  colorRange: ReadonlyArray<RGBA8>;
  weightProperty?: string;
  colorDomain?: [number, number];
  timeFilterMode: STTHeatmapTimeFilterMode;
  wakeLength: number;
  wakeTailScale: number;
  trailLength: number;
  fadeTrail: number;
}

// Shared with @poopdeck.gl/layers HeatmapLayer (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_COLOR_RANGE: ReadonlyArray<RGBA8> = DEFAULT_HEATMAP_COLOR_RANGE;

/**
 * What one time-filter mode contributes to the accumulate-pass vertex source.
 * Modes share no symbols and declare no attributes, so exactly one block is
 * spliced per program (compile-time selection — see the module header).
 */
interface TimeModeBlock {
  /** Uniform declarations the mode's call site reads. */
  decls: string;
  /** The kernel snippet from `shaders/time-window.glsl.ts`. */
  glsl: string;
  /** Expression yielding this splat's 0..1 time alpha. */
  alpha: string;
  /** Optional vertex-stage splat-size multiplier (wake's tail shrink). */
  size?: string;
}

const TIME_MODES: Readonly<Record<STTHeatmapTimeFilterMode, TimeModeBlock>> =
  Object.freeze({
    window: {
      decls: TIME_MODE_UNIFORM_DECLS.window,
      glsl: TIME_WINDOW_GLSL,
      alpha:
        'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    },
    wake: {
      // The tapered block: a splat's radius is a style knob, so the wake tail
      // shrink applies and `uWakeTailScale` must be declared.
      decls: TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE.wake,
      glsl: TIME_WAKE_GLSL,
      alpha: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
      size: 'sttWakeSizeScale(alpha, uWakeTailScale)',
    },
    cumulative: {
      decls: TIME_MODE_UNIFORM_DECLS.cumulative,
      glsl: TIME_CUMULATIVE_GLSL,
      alpha: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    },
    trail: {
      decls: TIME_MODE_UNIFORM_DECLS.trail,
      glsl: TIME_TRAIL_GLSL,
      // One splat per feature ⇒ the kernel's per-vertex time IS the feature's
      // start time (core `timeFilterAlpha`'s `vertexTime = startTime`).
      alpha: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
    },
  });

/**
 * Filter statements spliced into `main()` when a `filterProperty` is set.
 * Mirrors `DataFilterExtension`'s three injections at once: the fragment-stage
 * `discard` (a fully-filtered splat must never accumulate, whatever the
 * transform flags say), the `vs:#main-end` degenerate-position collapse (safe:
 * the value is per-FEATURE and a point IS one feature), and the size / colour
 * transforms.
 */
const FILTER_MAIN_GLSL =
  `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};\n` +
  '    float filterColor = mix(1.0, filterAlpha, step(0.5, uFilterTransformColor));\n' +
  '    float filterSize = mix(1.0, filterAlpha, step(0.5, uFilterTransformSize));\n' +
  '    if (filterAlpha <= 0.0) {\n' +
  '      gl_Position = vec4(0.0);\n' +
  '      filterColor = 0.0;\n' +
  '    }\n';

/**
 * Variant-aware accumulate-pass vertex source. An empty prelude means a
 * legacy frame (maplibre ≤v4 / mapbox, or a v5 host without shaderData —
 * `frame.matrix` is the mercator MVP there): the plain `uMatrix`
 * projection is emitted. A non-empty prelude (v5+) is prepended, prelude
 * before define (the order maplibre's own custom-layer examples use), ahead
 * of the `projectTile`-projecting body.
 *
 * `mode` and `dataFilter` select which snippets are compiled in; both default
 * to the OFF shape (window gating, no filter). Callers MUST key the program
 * cache by both (see {@link accumProgramKey}) — `getOrCreateProgram` only
 * appends the host variant. Exported for string-level tests.
 */
export function buildHeatmapAccumVertexSource(
  shader: { prelude: string; define: string },
  opts: {
    timeFilterMode?: STTHeatmapTimeFilterMode;
    dataFilter?: boolean;
  } = {},
): string {
  // `?? window` also covers a JS caller handing an unknown mode string —
  // gating must degrade to the window filter, never to a crash.
  const mode = TIME_MODES[opts.timeFilterMode ?? 'window'] ?? TIME_MODES.window;
  const filtered = opts.dataFilter === true;
  const usesPrelude = shader.prelude.length > 0;

  // Legacy hosts project with the positional MVP; v5+ hosts call the injected
  // prelude's projectTile, which OVERWRITES z (horizon clipping) — correct for
  // these screen-space 2d splats, and what makes globe work with no other
  // change.
  const projection = usesPrelude
    ? 'projectTile(mercator.xy)'
    : 'uMatrix * vec4(mercator.x, mercator.y, 0.0, 1.0)';
  const sizeTerms = ['uRadius * 2.0'];
  if (mode.size) sizeTerms.push(mode.size);
  if (filtered) sizeTerms.push('filterSize');
  const weightTerms = ['aWeight', 'alpha'];
  if (filtered) weightTerms.push('filterColor');

  const body = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute float aWeight;
${usesPrelude ? '' : '  uniform mat4 uMatrix;\n'}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
${mode.decls}${filtered ? `${DATA_FILTER_ATTRIBUTE_GLSL}${DATA_FILTER_UNIFORMS_GLSL}` : ''}  varying float vWeight;
${mode.glsl}${filtered ? DATA_FILTER_GLSL : ''}${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    gl_Position = ${projection};
    float alpha = ${mode.alpha};
${filtered ? FILTER_MAIN_GLSL : ''}    gl_PointSize = ${sizeTerms.join(' * ')};
    vWeight = ${weightTerms.join(' * ')};
  }
`;
  if (!usesPrelude) return body;
  return `${shader.prelude}\n${shader.define}\n${body}`;
}

/**
 * Base program-cache key for one (mode, filter) shader shape.
 * `getOrCreateProgram` appends `::<host variant>`; two modes sharing a base
 * key would collide, so the mode is baked in here.
 */
function accumProgramKey(
  mode: STTHeatmapTimeFilterMode,
  filtered: boolean,
): string {
  return `heatmap-accum:${mode}${filtered ? ':filter' : ''}`;
}

const ACCUM_FS = `
  precision highp float;
  uniform float uIntensity;
  varying float vWeight;
  void main() {
    if (vWeight <= 0.0) discard;
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d) * 4.0;
    if (r2 > 1.0) discard;
    // Gaussian falloff: σ² ≈ 0.15 → tight, bright core.
    float falloff = exp(-r2 / 0.15);
    float v = falloff * vWeight * uIntensity;
    gl_FragColor = vec4(v, v, v, v);
  }
`;

const RAMP_VS = `
  precision highp float;
  attribute vec2 aPos; // -1..1 fullscreen quad
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const RAMP_FS = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uAccum;
  uniform sampler2D uPalette;
  uniform float uThreshold;
  // [min, max] accumulated-intensity range mapped onto the palette. Defaults
  // to [0, 1] (identity). When the archive carries a bake-time heatmap domain
  // (metadata.heatmapDomain) or the caller pins colorDomain, the accumulator
  // is remapped so a weighted heatmap (large weightProperty values) isn't
  // washed-out/saturated — matching the deck.gl adapter's colorDomain.
  uniform float uDomainMin;
  uniform float uDomainMax;
  void main() {
    float intensity = texture2D(uAccum, vUv).r;
    if (intensity <= uThreshold) discard;
    float span = max(uDomainMax - uDomainMin, 1e-6);
    float t = clamp((intensity - uDomainMin) / span, 0.0, 1.0);
    vec4 ramp = texture2D(uPalette, vec2(t, 0.5));
    gl_FragColor = vec4(ramp.rgb, ramp.a * smoothstep(uThreshold, uThreshold + 0.05, intensity));
  }
`;

/**
 * The inherited time-mode locations cover all four modes, and the filter ones
 * the whole filter block: only the active mode's — and, when the filter branch
 * was compiled in, the filter's — resolve to a real location, and every
 * `gl.uniform*` call ignores a null one.
 */
interface AccumProgramHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  aMercator: number;
  aTime: number;
  aWeight: number;
  /** -1 unless the filter branch was compiled into this variant. */
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null;
}

interface RampProgramHandles {
  program: WebGLProgram;
  aPos: number;
  uAccum: WebGLUniformLocation | null;
  uPalette: WebGLUniformLocation | null;
  uThreshold: WebGLUniformLocation | null;
  uDomainMin: WebGLUniformLocation | null;
  uDomainMax: WebGLUniformLocation | null;
}

interface HeatmapGpuCache extends TileGpuCache {
  weightBuffer?: WebGLBuffer;
  /** Per-feature filter column, uploaded only when this tile baked one. */
  filterBuffer?: WebGLBuffer;
  /** Whether this tile supplies the filter column (the `enabled` gate). */
  hasFilterColumn?: boolean;
  /**
   * Shader variant the cached VAO's attribute locations were recorded under.
   * A VAO binds attribute LOCATIONS, which belong to one linked program — a
   * projection-variant flip (mercator ⇄ globe on v5) links a different
   * program, so a mismatched VAO must be dropped and re-recorded.
   */
  vaoVariant?: string;
  /**
   * Accumulate-program key ({@link accumProgramKey}) the VAO was recorded
   * under. A runtime `setTimeFilterMode` links a DIFFERENT program under the
   * same host variant, so the variant alone does not identify the program.
   */
  vaoProgramKey?: string;
}

/** Resolved accumulator-texture format, decided once per layer. */
interface AccumFormat {
  /** internalFormat for texImage2D (RGBA / RGBA16F / RGBA32F). */
  internalFormat: number;
  /** format for texImage2D. */
  format: number;
  /** type for texImage2D (UNSIGNED_BYTE / HALF_FLOAT / FLOAT). */
  type: number;
  /** Pretty label, for logging only. */
  label: 'RGBA8' | 'RGBA16F' | 'RGBA32F';
}

export class STTHeatmapLayer extends STTFilterableLayer {
  private heatOpts: ResolvedHeatmapOptions;
  // The accumulate program lives in the base per-variant program cache
  // (`getOrCreateProgram(accumKey, ...)`), linked lazily per frame variant —
  // only the projection-agnostic ramp program is held here.
  private ramp?: RampProgramHandles;
  /**
   * Base cache key of the accumulate program: mode (+ filter) shape. Held as
   * a field so the render loop neither rebuilds the string nor allocates.
   */
  private accumKey: string;
  /**
   * Trail length AS PASSED (undefined ⇒ defaulted off `timeWindow`) and the
   * mode as REQUESTED — `heatOpts.timeFilterMode` holds the DEGRADED one.
   * Both feed {@link resolveTimeConfig} after a `setTimeWindow`.
   */
  private readonly trailLengthOpt?: number;
  private requestedMode: STTHeatmapTimeFilterMode;
  /** True when a `filterProperty` was configured — the filter branch is compiled. */
  private readonly filterCompiled: boolean;

  // FBO state — lazily allocated on first frame, resized when the drawing
  // buffer changes.
  private fbo?: WebGLFramebuffer;
  private accumTexture?: WebGLTexture;
  private accumWidth = 0;
  private accumHeight = 0;
  /**
   * Internal format probe result. RGBA8 saturates at ~255 splats per pixel,
   * which is easy to hit on dense events (rideshare in Manhattan, eqs near
   * the Pacific Rim). When the runtime supports a half-float colour buffer
   * (WebGL2 `EXT_color_buffer_half_float` / WebGL1 + OES_texture_half_float),
   * we allocate `RGBA16F` and the additive blend has ~65k headroom per
   * channel. Falls back to `RGBA8` everywhere else — heatmaps still render,
   * just with the ~255-splat saturation above.
   *
   * `null` = uninitialized; resolved on first `ensureAccumFramebuffer`.
   */
  private accumFormat: AccumFormat | null = null;

  // 256×1 RGBA palette texture sampled by accumulated intensity.
  private paletteTexture?: WebGLTexture;

  // Fullscreen quad VBO (4 verts, two triangles via triangle-strip).
  private quadBuffer?: WebGLBuffer;

  constructor(opts: STTHeatmapLayerOptions) {
    super(opts);
    this.heatOpts = {
      radiusPixels: opts.radiusPixels ?? 30,
      intensity: opts.intensity ?? 1,
      threshold: opts.threshold ?? 0.05,
      colorRange: opts.colorRange ?? DEFAULT_COLOR_RANGE,
      weightProperty: opts.weightProperty,
      colorDomain: opts.colorDomain,
      // Placeholder — `resolveTimeConfig()` below owns mode + trailLength.
      timeFilterMode: 'window',
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      // No independent default: a trail as long as the window is the closest
      // thing to the window gating, and never the degenerate `<= 0`.
      trailLength: opts.trailLength ?? opts.timeWindow,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.filterCompiled = !!opts.filterProperty;
    this.trailLengthOpt = opts.trailLength;
    this.requestedMode = opts.timeFilterMode ?? 'window';
    this.resolveTimeConfig();
    this.accumKey = accumProgramKey(
      this.heatOpts.timeFilterMode,
      this.filterCompiled,
    );
  }

  /**
   * Resolve the accumulated-intensity domain mapped onto the colour ramp:
   * the explicit `colorDomain` prop, else the archive's bake-time
   * `metadata.heatmapDomain` (class `default`), else the identity `[0, 1]`.
   */
  private resolveColorDomain(): [number, number] {
    if (this.heatOpts.colorDomain) return this.heatOpts.colorDomain;
    const classes = this.metadata?.heatmapDomain?.classes;
    if (classes && classes.length > 0) {
      const def = classes.find((c) => c.id === 'default') ?? classes[0];
      if (def && Number.isFinite(def.min) && Number.isFinite(def.max)) {
        return [def.min, def.max];
      }
    }
    return [0, 1];
  }

  /** Replace the colour ramp at runtime. */
  setColorRange(range: ReadonlyArray<RGBA8>): void {
    this.heatOpts.colorRange = range;
    // Force a palette texture rebuild on next draw.
    if (this.gl && this.paletteTexture) {
      this.uploadPalette(this.gl);
    }
    this.map?.triggerRepaint();
  }

  /** Replace the splat radius (px) at runtime. */
  setRadius(radiusPixels: number): void {
    this.heatOpts.radiusPixels = radiusPixels;
    this.map?.triggerRepaint();
  }

  /**
   * Switch the temporal gating mode at runtime. The new mode links its own
   * program on the next frame (the mode is part of the cache key) and stale
   * per-tile VAOs are re-recorded against it; tile buffers are untouched.
   */
  setTimeFilterMode(mode: STTHeatmapTimeFilterMode): void {
    this.requestedMode = mode;
    this.resolveTimeConfig();
    this.accumKey = accumProgramKey(
      this.heatOpts.timeFilterMode,
      this.filterCompiled,
    );
    this.map?.triggerRepaint();
  }

  /**
   * Widen/narrow the loading window. Overridden because the defaulted
   * `trailLength` is DERIVED from it: a stale snapshot would keep splatting
   * points for a tail the loader no longer covers (or a tail far shorter than
   * the data it now pays for). An explicit `trailLength` is the caller's.
   */
  setTimeWindow(ms: number): void {
    super.setTimeWindow(ms);
    this.resolveTimeConfig();
    this.accumKey = accumProgramKey(
      this.heatOpts.timeFilterMode,
      this.filterCompiled,
    );
  }

  /**
   * Re-derive the defaulted `trailLength` from the CURRENT `timeWindow`, then
   * the compiled mode from the length knobs. The degrade rule is deck's: its
   * extension enters the wake branch only for `wakeLength > 0` and the trail
   * branch only for `trailLength > 0`, otherwise falling through to window.
   * Both degenerate kernels here return 0, so a mode left in that state would
   * splat nothing at all.
   */
  private resolveTimeConfig(): void {
    const trail = this.trailLengthOpt ?? this.opts.timeWindow;
    this.heatOpts.trailLength = trail;
    const requested = this.requestedMode;
    this.heatOpts.timeFilterMode =
      (requested === 'wake' && !(this.heatOpts.wakeLength > 0)) ||
      (requested === 'trail' && !(trail > 0))
        ? 'window'
        : requested;
  }

  /**
   * The knobs the SHADER compiled, not the ones the caller passed. Both differ
   * here: `trailLength` defaults to the whole `timeWindow` (so the raw option
   * is usually undefined while the splat really does reach a full window into
   * the past), and the mode is DEGRADED to `'window'` when its length knob is
   * non-positive. Sizing the load window off the raw bag would under-cover the
   * tail in trail mode and over-cover it — by 2× — in window mode, where that
   * defaulted `trailLength` is not used at all.
   */
  protected timeModeLoadKnobs(): TimeModeLoadKnobs {
    return {
      mode: this.heatOpts.timeFilterMode,
      wakeLength: this.heatOpts.wakeLength,
      trailLength: this.heatOpts.trailLength,
    };
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // The accumulate program is NOT linked here — it depends on the host
    // frame's shader variant, so render() links it lazily through the base
    // per-variant cache (which also survives context restore).
    const rampProgram = this.linkProgram(gl, RAMP_VS, RAMP_FS);
    this.ramp = {
      program: rampProgram,
      aPos: gl.getAttribLocation(rampProgram, 'aPos'),
      uAccum: gl.getUniformLocation(rampProgram, 'uAccum'),
      uPalette: gl.getUniformLocation(rampProgram, 'uPalette'),
      uThreshold: gl.getUniformLocation(rampProgram, 'uThreshold'),
      uDomainMin: gl.getUniformLocation(rampProgram, 'uDomainMin'),
      uDomainMax: gl.getUniformLocation(rampProgram, 'uDomainMax'),
    };

    // Fullscreen quad (triangle strip).
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    // Palette texture (256×1 RGBA).
    this.paletteTexture = gl.createTexture()!;
    this.uploadPalette(gl);
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Accumulate programs are owned by the base program cache, which the
    // base invalidates on loss/dispose before invoking this hook.
    if (this.ramp) {
      gl.deleteProgram(this.ramp.program);
      this.ramp = undefined;
    }
    if (this.quadBuffer) {
      gl.deleteBuffer(this.quadBuffer);
      this.quadBuffer = undefined;
    }
    if (this.paletteTexture) {
      gl.deleteTexture(this.paletteTexture);
      this.paletteTexture = undefined;
    }
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      this.fbo = undefined;
    }
    if (this.accumTexture) {
      gl.deleteTexture(this.accumTexture);
      this.accumTexture = undefined;
    }
    this.accumWidth = 0;
    this.accumHeight = 0;
    // The format decision rests on extension probes (EXT_color_buffer_*) and
    // a completeness check that don't survive a context restore — re-probe on
    // the next accumulate pass rather than trusting a stale RGBA16F verdict.
    this.accumFormat = null;
  }

  /**
   * Pre-multiply each feature's weight and stash it as a Float32 attribute.
   * Falls back to a constant 1.0 buffer when no weightProperty is set. Also
   * pulls the range-filter column when one is configured — a tile without it
   * renders UNFILTERED (`hasFilterColumn: false` ⇒ `enabled: 0`), never blank.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): HeatmapGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, _tile, layer);
    if (!baseCache) return null;
    const cache: HeatmapGpuCache = baseCache as HeatmapGpuCache;
    const f = layer.features;
    const n = f.featureCount;
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];
    const weights = new Float32Array(n);
    if (this.heatOpts.weightProperty) {
      const src = this.getNumericProperty(f, this.heatOpts.weightProperty);
      if (src) {
        for (let i = 0; i < n; i++) weights[i] = src[i];
      } else {
        weights.fill(1);
      }
    } else {
      weights.fill(1);
    }
    cache.weightBuffer = this.uploadArrayBuffer(gl, weights);
    extras.push(cache.weightBuffer);

    if (this.filterCompiled) {
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical) this.warnCategoricalFilterOnce();
      cache.hasFilterColumn = col.hasColumn;
      if (col.values) {
        // One splat per feature, so the per-FEATURE column binds directly (no
        // expandFilterValues — that is for segment/vertex instancing).
        cache.filterBuffer = this.uploadArrayBuffer(gl, col.values);
        extras.push(cache.filterBuffer);
      }
    }

    cache.extraBuffers = extras;
    return cache;
  }

  /**
   * Heatmap rendering replaces the base render() entirely — we need to wrap
   * the per-tile splats in an FBO bind/unbind and then a fullscreen colour-
   * ramp pass. `beginFrame` runs FIRST (base contract): it normalizes
   * whichever host signature arrived into the scratch HostFrame, stashes the
   * matrix/camera params for pick(), and advances the tileset viewport.
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ): void {
    const frame = this.beginFrame(matrixOrArgs, options);
    if (!frame) return;
    if (!this.ramp || !this.paletteTexture || !this.quadBuffer) return;

    const currentTime = this.opts.currentTime;

    // MapLibre may be rendering custom layers into an offscreen target
    // (terrain draping, globe post-process), so the framebuffer bound on
    // entry is NOT necessarily the default one. Capture binding + viewport
    // before pass 1 hijacks them; pass 2 composites back into the host's
    // target.
    const prevFramebuffer = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    this.ensureAccumFramebuffer(gl);

    const w = this.accumWidth;
    const h = this.accumHeight;
    if (w === 0 || h === 0) return;

    // ---- Pass 1: accumulate intensity into FBO ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo!);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive
    gl.disable(gl.DEPTH_TEST);

    // Variant-keyed accumulate program: a v5 host relinks per projection
    // variant (mercator / globe / transition); legacy hosts reuse one
    // 'legacy' link. The key also carries the time mode + filter shape, both
    // compile-time selections. Linked lazily on the first frame needing it.
    const accumKey = this.accumKey;
    const ah = this.getOrCreateProgram(gl, accumKey, frame, (g, shader) =>
      this.buildAccumProgram(g, shader),
    );
    gl.useProgram(ah.program);
    // The legacy variant projects via uMatrix; on the v5 variant the location
    // is null (the prelude owns projection) and this is a spec-level no-op.
    gl.uniformMatrix4fv(ah.uMatrix, false, frame.matrix);
    this.setPreludeProjectionUniforms(gl, ah.program, frame); // no-op on legacy
    gl.uniform1f(ah.uRadius, this.heatOpts.radiusPixels);
    gl.uniform1f(ah.uIntensity, this.heatOpts.intensity);
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    gl.uniform1f(ah.uFadeIn, fadeIn);
    gl.uniform1f(ah.uFadeOut, fadeOut);
    // Mode knobs. Only the compiled mode declares its uniforms; the others
    // resolve to a null location, which gl.uniform1f ignores — so the whole
    // set can be uploaded unconditionally without branching per mode.
    gl.uniform1f(ah.uWakeLength, this.heatOpts.wakeLength);
    gl.uniform1f(ah.uWakeTailScale, this.heatOpts.wakeTailScale);
    gl.uniform1f(ah.uTrailLength, this.heatOpts.trailLength);
    gl.uniform1f(ah.uFadeTrail, this.heatOpts.fadeTrail);

    // Globe wrap-skip (drop wrap !== 0 copies) is vacuous here: STT tiles
    // are world tiles drawn exactly once — no wrapped copies exist to skip.
    // Splats are points, so no edge subdivision is needed either.
    const half = this.opts.timeWindow / 2;
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(
          gl,
          tile,
          layer,
        ) as HeatmapGpuCache | null;
        if (!cache) continue;
        // Every time uniform is TILE-RELATIVE (see the time-window module's
        // precision note); uCurrentTime is what wake/cumulative/trail compare
        // against, uWindowStart/End what window mode does.
        gl.uniform1f(ah.uCurrentTime, currentTime - cache.timeOffset);
        gl.uniform1f(ah.uWindowStart, currentTime - cache.timeOffset - half);
        gl.uniform1f(ah.uWindowEnd, currentTime - cache.timeOffset + half);
        gl.uniform3fv(ah.uPosScale, cache.posScale ?? [1, 1, 1]);
        gl.uniform3fv(ah.uPosOffset, cache.posOffset ?? [0, 0, 0]);
        if (this.filterCompiled) {
          // Per tile: `enabled` also depends on whether THIS tile baked the
          // column (a tile without it renders unfiltered).
          this.uploadDataFilterUniforms(gl, ah, cache.hasFilterColumn === true);
        }

        // A VAO records attribute locations belonging to the program it was
        // recorded against — a variant flip (transition start/end) or a
        // runtime mode flip links a different program, so a stale VAO is
        // dropped and re-recorded.
        if (
          cache.vao &&
          (cache.vaoVariant !== frame.shader.variantName ||
            cache.vaoProgramKey !== accumKey)
        ) {
          this.vaoSupport.delete(cache.vao);
          cache.vao = null;
        }
        // VAO captures position/time/weight/filter attribute state on first frame.
        this.bindVaoOrSetup(cache, () => {
          gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
          gl.enableVertexAttribArray(ah.aMercator);
          gl.vertexAttribPointer(
            ah.aMercator,
            3,
            gl.UNSIGNED_SHORT,
            true,
            0,
            0,
          );

          gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
          gl.enableVertexAttribArray(ah.aTime);
          gl.vertexAttribPointer(ah.aTime, 2, gl.FLOAT, false, 0, 0);

          if (cache.weightBuffer && ah.aWeight >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, cache.weightBuffer);
            gl.enableVertexAttribArray(ah.aWeight);
            gl.vertexAttribPointer(ah.aWeight, 1, gl.FLOAT, false, 0, 0);
          }

          if (cache.filterBuffer && ah.aFilterValue >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, cache.filterBuffer);
            gl.enableVertexAttribArray(ah.aFilterValue);
            gl.vertexAttribPointer(ah.aFilterValue, 1, gl.FLOAT, false, 0, 0);
          }
        });
        cache.vaoVariant = frame.shader.variantName;
        cache.vaoProgramKey = accumKey;

        gl.drawArrays(gl.POINTS, 0, cache.vertexCount);
      }
    }
    // Unbind before pass 2 — the fullscreen quad uses a different VBO and
    // shouldn't inherit any per-tile attribute state.
    this.unbindVao();

    // ---- Pass 2: colour-ramp lookup against the host's render target ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.viewport(
      prevViewport[0],
      prevViewport[1],
      prevViewport[2],
      prevViewport[3],
    );
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const rh = this.ramp;
    gl.useProgram(rh.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(rh.aPos);
    gl.vertexAttribPointer(rh.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture!);
    gl.uniform1i(rh.uAccum, 0);
    gl.activeTexture(gl.TEXTURE0 + 1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.uniform1i(rh.uPalette, 1);
    gl.uniform1f(rh.uThreshold, this.heatOpts.threshold);
    const [domainMin, domainMax] = this.resolveColorDomain();
    gl.uniform1f(rh.uDomainMin, domainMin);
    gl.uniform1f(rh.uDomainMax, domainMax);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(rh.aPos);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Link the accumulate program for one shader variant and resolve its
   * locations. Runs once per `<accumKey>::<variantName>` cache key.
   * `uMatrix` resolves to null on the v5 variant (the prelude owns
   * projection), and every uniform belonging to an unselected time mode /
   * to the uncompiled filter branch resolves to null too, so setting them
   * unconditionally is a no-op.
   */
  private buildAccumProgram(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: { prelude: string; define: string },
  ): AccumProgramHandles {
    const program = this.linkProgram(
      gl,
      buildHeatmapAccumVertexSource(shader, {
        timeFilterMode: this.heatOpts.timeFilterMode,
        dataFilter: this.filterCompiled,
      }),
      ACCUM_FS,
    );
    return {
      program,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aWeight: gl.getAttribLocation(program, 'aWeight'),
      aFilterValue: this.filterCompiled
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uRadius: gl.getUniformLocation(program, 'uRadius'),
      uIntensity: gl.getUniformLocation(program, 'uIntensity'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveWakeTailScaleUniformLocation(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
      ...resolveFilterTransformSizeUniformLocation(gl, program),
    };
  }

  /**
   * Unused — heatmap overrides `render()` entirely. Declared so the abstract
   * base class is happy.
   */
  protected drawTile(): void {
    /* no-op */
  }

  // --------------------------------------------------------------------------
  // FBO + palette helpers
  // --------------------------------------------------------------------------

  private ensureAccumFramebuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const w = gl.drawingBufferWidth | 0;
    const h = gl.drawingBufferHeight | 0;
    if (w === this.accumWidth && h === this.accumHeight && this.fbo) return;

    if (!this.accumFormat) this.accumFormat = this.probeAccumFormat(gl);

    // Drop the old FBO + texture.
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.accumTexture) gl.deleteTexture(this.accumTexture);
    this.fbo = gl.createFramebuffer()!;
    this.accumTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    const fmt = this.accumFormat;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      fmt.internalFormat,
      w,
      h,
      0,
      fmt.format,
      fmt.type,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.accumTexture,
      0,
    );
    // Some drivers refuse RGBA16F as colour-renderable even after advertising
    // the extension. Verify completeness and degrade to RGBA8 if the FBO is
    // unusable. Future allocations skip the probe by reusing the demoted
    // accumFormat.
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE && fmt.label !== 'RGBA8') {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteTexture(this.accumTexture);
      this.accumFormat = {
        internalFormat: gl.RGBA,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        label: 'RGBA8',
      };
      this.fbo = undefined;
      this.accumTexture = undefined;
      // Recursively retry with the demoted format.
      this.accumWidth = 0;
      this.accumHeight = 0;
      this.ensureAccumFramebuffer(gl);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.accumWidth = w;
    this.accumHeight = h;
  }

  /**
   * Resolve the best available colour-renderable RGBA format. We prefer
   * RGBA16F (~65k splats/pixel headroom, the deck.gl heatmap default on
   * modern hardware) and fall back through RGBA8 (~255 splats — the legacy
   * behaviour). RGBA32F is intentionally skipped: extra precision is not
   * useful for this accumulator and many drivers either don't expose it as
   * colour-renderable or refuse to blend it.
   */
  private probeAccumFormat(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): AccumFormat {
    const isWebGL2 =
      typeof WebGL2RenderingContext !== 'undefined' &&
      gl instanceof WebGL2RenderingContext;
    if (isWebGL2) {
      // WebGL2 path: requires EXT_color_buffer_half_float (or
      // EXT_color_buffer_float, which is a superset). RGBA16F internalFormat
      // is in core; only the colour-renderable property comes from the ext.
      const gl2 = gl as WebGL2RenderingContext;
      const hasHalf =
        !!gl.getExtension('EXT_color_buffer_half_float') ||
        !!gl.getExtension('EXT_color_buffer_float');
      if (hasHalf) {
        return {
          internalFormat: (gl2 as unknown as { RGBA16F: number }).RGBA16F,
          format: gl.RGBA,
          type: (gl2 as unknown as { HALF_FLOAT: number }).HALF_FLOAT,
          label: 'RGBA16F',
        };
      }
    } else {
      // WebGL1 path: OES_texture_half_float gives us HALF_FLOAT_OES as the
      // texture data type. The colour-renderable property comes from
      // EXT_color_buffer_half_float (separate from the texture ext). When
      // both are present, RGBA + HALF_FLOAT_OES is renderable.
      const halfTex = gl.getExtension('OES_texture_half_float') as {
        HALF_FLOAT_OES: number;
      } | null;
      const halfRender = gl.getExtension('EXT_color_buffer_half_float');
      if (halfTex && halfRender) {
        return {
          internalFormat: gl.RGBA,
          format: gl.RGBA,
          type: halfTex.HALF_FLOAT_OES,
          label: 'RGBA16F',
        };
      }
    }
    return {
      internalFormat: gl.RGBA,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      label: 'RGBA8',
    };
  }

  private uploadPalette(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (!this.paletteTexture) return;
    const range = this.heatOpts.colorRange;
    const data = new Uint8Array(256 * 4);
    // Linear interpolation between stops to fill 256 entries.
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (range.length - 1);
      const a = Math.floor(t);
      const b = Math.min(range.length - 1, a + 1);
      const f = t - a;
      const ca = range[a];
      const cb = range[b];
      data[i * 4] = Math.round(ca[0] * (1 - f) + cb[0] * f);
      data[i * 4 + 1] = Math.round(ca[1] * (1 - f) + cb[1] * f);
      data[i * 4 + 2] = Math.round(ca[2] * (1 - f) + cb[2] * f);
      data[i * 4 + 3] = Math.round(
        (ca[3] ?? 255) * (1 - f) + (cb[3] ?? 255) * f,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
}
