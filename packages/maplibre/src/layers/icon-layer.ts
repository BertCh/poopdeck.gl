/**
 * Icon geometry adapter — renders POINT-type tiles as rotated billboard sprites
 * sampled from a texture atlas. The AIS / flights kind: one quad per feature,
 * rotated by a heading column, tinted per category, optionally GLIDING between
 * samples instead of popping from one snapshot to the next.
 *
 * ── How a sprite is built ───────────────────────────────────────────────────
 * Each feature is ONE instance of the base layer's shared 4-vertex unit quad
 * (`getUnitQuad`, `(side, along) ∈ {-1,1} × {0,1}`). The vertex shader maps that
 * corner to the icon's `[0,1]²` sprite space, offsets it from the anchor in
 * ATLAS pixels, scales it to the requested on-screen size, rotates it by the
 * angle (degrees, CCW — deck `IconLayer.getAngle` semantics, including the
 * rotate-then-flip-y order of upstream's `rotate_by_angle`), and adds the result
 * to the projected anchor in NDC. The quad is therefore always camera-facing:
 * "billboard" is structural here, not a prop.
 *
 * The atlas rectangle itself rides EITHER a uniform (the common case: every
 * feature draws the same `icon`) or a per-instance attribute pair
 * (`iconProperty` names a categorical column selecting the sprite per feature —
 * this backend goes past deck's single-constant-icon limitation, which exists
 * there only because binary tiles cannot run a per-row `getIcon` accessor).
 *
 * ── Feature surface ─────────────────────────────────────────────────────────
 *  - `timeFilterMode` — window (default) / wake / cumulative / trail, one
 *    kernel snippet from `shaders/time-window.glsl.ts` chosen at PROGRAM-BUILD
 *    time (no mode uniform, no dynamic branch), so the mode is part of the
 *    program-cache key. Icons are the wake showcase kind: wake mode shrinks the
 *    sprite toward `wakeTailScale` with the SAME alpha the kernel returned, so
 *    the fade and the shrink cannot drift apart.
 *  - `filterProperty`/`filterRange`/… — the DataFilter kernel
 *    (`shaders/data-filter.glsl.ts`), compiled in only when `filterProperty` is
 *    named, multiplied into the same `vAlpha` the time filter writes.
 *  - `sizeUnits: 'meters'` — metric sizing through `lib/projection.ts`, folded
 *    CPU-side into `uSizeScale` (no extra program variant), then clamped by
 *    `sizeMinPixels`/`sizeMaxPixels` exactly as deck does.
 *  - `interpolate` — the CPU motion-glide path (below).
 *
 * Every gate lands in the id-pick program too (same kernels, same uniforms,
 * same sprite-alpha cutoff): a feature that is time-filtered, range-filtered,
 * shrunk to nothing or transparent must not be pickable.
 *
 * ── Motion glide (`interpolate`) ────────────────────────────────────────────
 * Icon archives carry one row per entity PER SAMPLE, so a GPU time-window
 * filter shows every sample in the window at once and a moving marker POPS.
 * With `interpolate` on (plus an `idProperty` and no wake), the layer pools the
 * resident tiles' snapshots through the shared core track kernel
 * (`TrackIndexMaintainer`, rebuilt only when the tile SET changes — never per
 * frame) and emits ONE instance per ACTIVE entity, its position and heading
 * interpolated between the two samples bracketing the playhead. Visibility is
 * implicit (only active tracks are emitted), so the glide program compiles NO
 * time kernel and NO filter — `vAlpha` is a constant 1 and the appear/disappear
 * fade rides the per-instance colour alpha. Picking still works: each track
 * remembers the (tile, layer, featureIndex) of its first-seen snapshot, which is
 * exactly the id the base provenance table allocates.
 *
 * ── Atlas loading ───────────────────────────────────────────────────────────
 * `iconAtlas` may be a URL string (fetched via `Image`, once) or an already
 * decoded image-like source. Until BOTH the atlas texture and an `iconMapping`
 * are available the layer draws NOTHING — never a throw, never an untextured
 * quad. A failed/absent atlas warns once and the layer stays silent, so a demo
 * whose atlas 404s degrades to "no icons" rather than to a broken map.
 */

import type {
  Tile,
  STTTileLayer as STTLayer,
  BinaryFeatures,
  TrackFieldConfig,
  TrackSampleConfig,
  Track,
  Sample,
} from '@poopdeck.gl/core';
import {
  GeometryType,
  DEFAULT_CATEGORICAL_PALETTE,
  TrackIndexMaintainer,
  sampleTrack,
} from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import { encodePickId } from '@poopdeck.gl/core/picking';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  toRgba01,
  type RGBA8,
} from '../base-layer.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_TRAIL_GLSL,
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE,
  resolveTimeUniformLocations,
  resolveWakeTailScaleUniformLocation,
  type TimeUniformLocations,
  type WakeTailScaleUniformLocation,
} from '../shaders/time-window.glsl.js';
import { POSITION_DEQUANT_GLSL } from '../shaders/position-quantization.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type FilterTransformSizeUniformLocation,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';
import { lngLatToMercatorInto } from '../lib/projection.js';

/** The four real time-filter modes, under this layer's name. */
export type IconTimeFilterMode = STTTimeFilterMode;

/**
 * One entry of an `iconMapping`: the sub-rectangle of the atlas a named icon
 * occupies, in ATLAS PIXELS, plus its anchor and mask flag. Identical shape to
 * deck.gl `IconLayer`'s mapping, so one mapping object serves both backends.
 */
export interface IconMappingEntry {
  /** Left edge of the sprite in the atlas, in pixels. */
  x: number;
  /** Top edge of the sprite in the atlas, in pixels. */
  y: number;
  /** Sprite width in pixels. */
  width: number;
  /** Sprite height in pixels. */
  height: number;
  /** Horizontal anchor within the sprite, in pixels. @default width / 2 */
  anchorX?: number;
  /** Vertical anchor within the sprite, in pixels (from the TOP). @default height / 2 */
  anchorY?: number;
  /**
   * When true the sprite is a stencil: its RGB is replaced by the tint colour
   * and only its alpha is read. When false (default) the sprite keeps its own
   * colours and the tint modulates alpha only.
   */
  mask?: boolean;
}

/**
 * Anything `texImage2D` accepts as a source, structurally. Declared here rather
 * than as the DOM's `TexImageSource` so the package keeps compiling against a
 * DOM-less type surface, and so `{ width, height }` alone (an `ImageData`, a
 * decoded `ImageBitmap`, a canvas) is enough to be uploaded.
 */
export interface IconAtlasImage {
  width: number;
  height: number;
}

/** Atlas source: a URL to fetch once, or an already decoded image-like object. */
export type STTIconAtlasSource = string | IconAtlasImage;

export interface STTIconLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Icon atlas — a URL string (loaded once via `Image`, CORS-anonymous) or an
   * already decoded source (`HTMLImageElement`, `ImageBitmap`, canvas,
   * `ImageData`). Nothing is drawn until it AND {@link iconMapping} resolve.
   */
  iconAtlas?: STTIconAtlasSource | null;
  /**
   * Named sub-rectangles into {@link iconAtlas}, deck's `iconMapping` shape.
   * Required to draw anything.
   */
  iconMapping?: Record<string, IconMappingEntry> | null;
  /**
   * Name of the sprite every feature uses (a key of {@link iconMapping}).
   * @default 'marker'
   */
  icon?: string;
  /**
   * Categorical column NAME selecting the sprite PER FEATURE (e.g. a vessel
   * class or aircraft type column). Values missing from {@link iconMapping} —
   * and NULL entries — fall back to the constant {@link icon}; if that is
   * missing too, the feature draws nothing (a zero-size quad) rather than a
   * wrong sprite.
   *
   * The per-tile sprite attribute is baked at tile-upload time, so changing the
   * mapping through {@link STTIconLayer.setIconMapping} rebuilds tile caches.
   */
  iconProperty?: string;
  /** Icon size in {@link sizeUnits}. @default 12 */
  size?: number;
  /** Numeric column NAME driving per-feature size (in {@link sizeUnits}). */
  sizeProperty?: string;
  /**
   * Unit `size` / a `sizeProperty` column is expressed in. `'pixels'` (default)
   * is screen-space — the same size at every zoom. `'meters'` is ground-metric
   * (deck's `sizeUnits`): converted per tile at the tile centre's latitude and
   * the map's fractional zoom. See `metersToPixelsAtLatitude` for the
   * screen-space caveat under pitch.
   */
  sizeUnits?: 'pixels' | 'meters';
  /** Multiplier applied to `size` and to a `sizeProperty` column. @default 1 */
  sizeScale?: number;
  /** Lower clamp on the final on-screen size, in pixels. @default 0 */
  sizeMinPixels?: number;
  /** Upper clamp on the final on-screen size, in pixels. @default MAX_SAFE_INTEGER */
  sizeMaxPixels?: number;
  /**
   * Which dimension of a non-square sprite `size` measures. `'height'` (default)
   * scales so the rendered HEIGHT equals `size`; `'width'` scales by width.
   * No effect on square sprites. deck `IconLayer.sizeBasis` parity.
   */
  sizeBasis?: 'height' | 'width';
  /**
   * Rotation in DEGREES, counter-clockwise from the sprite's default (up)
   * orientation — deck `IconLayer.getAngle` semantics. @default 0
   */
  angle?: number;
  /**
   * Numeric column NAME driving per-feature rotation in degrees (e.g. AIS
   * `cog`, aircraft `heading`). Also the heading column the glide path
   * interpolates along the shortest DEGREE arc.
   */
  angleProperty?: string;
  /**
   * Tint. For a `mask: true` sprite the tint REPLACES the sprite's colour; for
   * an opaque sprite it modulates alpha. Accepts 0–255 ints (deck convention)
   * or 0–1 floats — auto-detected by `toRgba01`. @default [255, 255, 255, 255]
   */
  color?: [number, number, number, number];
  /** Categorical column NAME driving the per-feature tint. */
  colorProperty?: string;
  /** Positional palette used with {@link colorProperty} (0–255 RGBA). */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA map (deck/three `colorMapping` parity):
   * a category renders the same colour in every tile regardless of per-tile
   * dictionary order. Unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional palette.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /**
   * Fragments whose final (sprite × tint × time) alpha falls below this are
   * discarded, which crisps masked-sprite edges and keeps translucent fringes
   * from registering as pick targets. deck `IconLayer.alphaCutoff` parity.
   * @default 0.05
   */
  alphaCutoff?: number;
  /**
   * Which temporal alpha the shader computes. Unset ⇒ inferred from the knobs
   * in deck's precedence order (`wakeLength > 0` ⇒ wake, else `trailLength > 0`
   * ⇒ trail, else window). `'wake'`/`'trail'` degrade to `'window'` when their
   * length knob is non-positive (a zero-length wake would light nothing).
   *
   * `'cumulative'` carries the same caller obligation as every other STT layer:
   * the shader does the reveal, the loader does not, so `timeWindow` must cover
   * the range you intend to accumulate.
   */
  timeFilterMode?: IconTimeFilterMode;
  /**
   * Wake mode: a sprite is lit only for this many ms AFTER its own `startTime`,
   * its alpha fading to 0 and its size shrinking toward {@link wakeTailScale}.
   * Defaults to 0 (no wake).
   *
   * The loader must span the past half of the wake for it to be visible at all —
   * pass `timeWindow >= 2 * wakeLength` (deck's rule).
   */
  wakeLength?: number;
  /** Wake trailing-edge size multiplier (head = 1). @default core's 0.15 */
  wakeTailScale?: number;
  /**
   * Trail mode: a sprite is lit while its `startTime` lies within this many ms
   * behind `currentTime`. An icon IS its own single vertex, so this is a fading
   * tail of RECENT EVENTS, not a swept polyline. Defaults to 0, which degrades
   * trail mode to window.
   */
  trailLength?: number;
  /**
   * Trail head→tail fade: `1`/`true` (default) fades across `trailLength`, `0`/
   * `false` keeps every lit feature opaque, numbers blend between them
   * (package-wide `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
  /**
   * Opt into the CPU motion-glide path: pool the resident tiles' samples by
   * {@link idProperty} and draw ONE interpolated pose per active entity instead
   * of every sample in the window. Active only when `interpolate === true`,
   * `reducedMotion !== true`, a non-empty `idProperty` is given and wake is off
   * — any unmet condition leaves the GPU window/wake path byte-identical.
   * @default false
   */
  interpolate?: boolean;
  /**
   * Per-entity id column NAME grouping samples into one glide track (AIS MMSI,
   * aircraft `icao24`). Must be an EXACT per-entity id — a lossy/quantized id
   * fuses distinct entities into one impossible track. @default undefined
   */
  idProperty?: string;
  /**
   * Largest gap (ms) between two samples of an entity that glide interpolates
   * across; a wider gap HOLDS the last pose instead of fabricating straight-line
   * motion through a data hole. @default Infinity
   */
  maxInterpolationGap?: number;
  /**
   * Honour the viewer's reduced-motion preference: `true` disables the glide
   * path and degrades to the discrete GPU time-window path. A concrete boolean
   * (survives the explicit-undefined-shadows-default gotcha). @default false
   */
  reducedMotion?: boolean;
}

// Shared with the deck.gl adapter (single source of truth in @poopdeck.gl/core).
const DEFAULT_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_CATEGORICAL_PALETTE;

/** Sprite name used when neither `iconProperty` nor a mapping hit resolves. */
const DEFAULT_ICON = 'marker';

/** Floats per instance in the interleaved sprite-frame buffer (rect + meta). */
const ICON_FRAME_STRIDE = 8;

/** `gl.TRIANGLE_STRIP` — the mock GL and WebGL agree on the literal. */
const TRIANGLE_STRIP = 0x0005;

/**
 * Unpack pixel-store parameters, as literals for the same reason as
 * {@link TRIANGLE_STRIP}. `gl.getParameter` returns a BOOLEAN for both.
 */
const UNPACK_FLIP_Y_WEBGL = 0x9240;
const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;

// Immutable stand-in for callers with no host frame: onContextReady's eager
// legacy link and hand-built test DrawContexts that omit `frame`.
const LEGACY_FRAME: HostFrame = createHostFrame();

// Hoisted uniform fallbacks — the hot path never allocates these.
const IDENTITY_POS_SCALE: readonly number[] = [1, 1, 1];
const ZERO_POS_OFFSET: readonly number[] = [0, 0, 0];

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled icon program supports. Every field is structural (it adds
 * attributes/uniforms/statements), so each combination is its own program and
 * each must appear in the program-cache key — {@link iconProgramKey}.
 */
export interface IconShaderConfig {
  /** Time-filter mode compiled into `main()`. Ignored when `glide` is set. */
  mode: IconTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
  /**
   * Motion-glide variant: no time attribute, no time kernel, no filter —
   * visibility is decided on the CPU (only ACTIVE tracks are emitted) and the
   * appear/disappear fade rides the per-instance colour alpha.
   */
  glide: boolean;
}

/** The OFF shape: window mode, no column filter, no glide. */
const DEFAULT_SHADER_CONFIG: IconShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
  glide: false,
});

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<IconTimeFilterMode, string>> = Object.freeze({
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
});

/**
 * Uniforms each mode reads. Only the active mode's block is declared. The wake
 * block carries `uWakeTailScale` because this layer shrinks the sprite toward
 * the tail (`sttWakeSizeScale`).
 */
const MODE_UNIFORMS: Readonly<Record<IconTimeFilterMode, string>> =
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE;

/** The `vAlpha = …` expression per mode. */
const MODE_ALPHA: Readonly<Record<IconTimeFilterMode, string>> = Object.freeze({
  window:
    'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
  wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
  cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
  // An icon is a single anchor point, so its "vertex time" is its start time.
  trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
});

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * DataFilter application, shared by the visual and id passes. deck's split: a
 * HARD-filtered feature (`0`) is hidden whatever the transform flags say, while
 * a soft-margin value only fades / shrinks when its flag is on
 * (`DECKGL_FILTER_COLOR` / `DECKGL_FILTER_SIZE`).
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) {
      sizePx *= filterAlpha;
    }
`;

/**
 * deck's `vs:#main-end` collapse. Keyed on the FILTER factor only — it is
 * per-FEATURE, so the whole quad collapses to a degenerate point and skips
 * rasterization entirely (the FS discard is still the correctness gate).
 */
const FILTER_COLLAPSE =
  '    if (filterAlpha <= 0.0) gl_Position = vec4(0.0);\n';

/**
 * Assemble an icon vertex shader.
 *
 * Legacy hosts (empty prelude) project the anchor through `uMatrix`; v5+ hosts
 * get the injected prelude + define prepended (maplibre's documented order) and
 * project through `projectTile` — billboards are 2d content, so `projectTile`'s
 * z overwrite (horizon clipping) is exactly right. A sprite is a single anchor
 * point, so no globe edge subdivision is needed and STT tiles carry no wrap
 * copies to skip.
 *
 * `vAlpha` is computed BEFORE the size so wake's tail shrink and the DataFilter
 * size transform can both read it — deck's `vs:#main-start` →
 * `DECKGL_FILTER_SIZE` ordering.
 *
 * ⚠ ORDER OF THE CLAMP. `sizeMinPixels`/`sizeMaxPixels` are applied to the BASE
 * size, BEFORE the wake taper and the filter shrink — deck's
 * `icon-layer-vertex.glsl` clamps inside `instanceScale` and only then runs
 * `DECKGL_FILTER_SIZE`, and the arc/trip-heads layers here do the same with
 * their width/radius clamps. Clamping last would let `sizeMinPixels` cancel the
 * taper: a wake tail at `wakeTailScale: 0.15` of a 24 px sprite (3.6 px) would
 * be pushed back up to a 12 px `sizeMinPixels`, so the comet would fade without
 * ever shrinking.
 */
function buildIconVs(
  shader: ShaderInjection,
  cfg: IconShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  // Glide decides visibility on the CPU, so it compiles neither kernel.
  const filter = cfg.filter && !cfg.glide;
  const projection = usesPrelude
    ? '    vec4 anchor = projectTile(mercator.xy);'
    : '    vec4 anchor = uMatrix * vec4(mercator.x, mercator.y, 0.0, 1.0);';
  const timeAttribute = cfg.glide
    ? ''
    : '  attribute vec2 aTime;       // [startTime, endTime], per-instance, tile-relative\n';
  const idAttribute = isMain
    ? ''
    : '  attribute vec3 aIdColor;    // per-feature encoded id (UNSIGNED_BYTE normalized)\n';
  const legacyUniforms = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const modeUniforms = cfg.glide ? '' : MODE_UNIFORMS[cfg.mode];
  const modeKernel = cfg.glide ? '' : MODE_GLSL[cfg.mode];
  const alpha = cfg.glide ? '1.0' : MODE_ALPHA[cfg.mode];
  const wakeSize =
    !cfg.glide && cfg.mode === 'wake'
      ? '    sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';
  const idVarying = isMain ? '' : '  varying vec3 vIdColor;\n';
  const colorModeVarying = isMain ? '  varying float vColorMode;\n' : '';
  const colorModeAssign = isMain ? '    vColorMode = meta.z;\n' : '';
  const idAssign = isMain ? '' : '    vIdColor = aIdColor;\n';

  return `${head}
  precision highp float;
  attribute vec2 aCorner;     // (side, along) ∈ {-1,1} × {0,1}, per-vertex unit quad
  attribute vec3 aMercator;   // per-instance anchor — see sttDecodeMercatorPos
${timeAttribute}  attribute float aSize;      // per-instance size (when uUseFeatureSize=1)
  attribute float aAngle;     // per-instance rotation in degrees (when uUseFeatureAngle=1)
  attribute vec4 aColor;      // per-instance RGBA in 0..1 (when uUseFeatureColor=1)
  attribute vec4 aIconRect;   // per-instance sprite (x, y, w, h) in atlas pixels
  attribute vec4 aIconMeta;   // per-instance (anchorX, anchorY, mask, unused)
${idAttribute}${filter ? FILTER_ATTRIBUTE : ''}${legacyUniforms}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform vec2 uViewport;     // drawing-buffer size in DEVICE pixels
  uniform vec2 uAtlasSize;    // atlas texture size in pixels
  uniform vec4 uIconRect;     // constant sprite rect (when uUseFeatureIcon=0)
  uniform vec4 uIconMeta;     // constant sprite anchor/mask (when uUseFeatureIcon=0)
  uniform float uUseFeatureIcon;
  uniform float uSize;
  uniform float uSizeScale;
  uniform float uUseFeatureSize;
  uniform float uSizeMinPixels;
  uniform float uSizeMaxPixels;
  uniform float uSizeBasisWidth;  // 0 = size is the sprite HEIGHT, 1 = its WIDTH
  uniform float uAngle;
  uniform float uUseFeatureAngle;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
${modeUniforms}${filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
  varying vec2 vUv;
  varying vec4 vColor;
${colorModeVarying}${idVarying}${modeKernel}${POSITION_DEQUANT_GLSL}${filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
${projection}
    vAlpha = ${alpha};
    vec4 rect = (uUseFeatureIcon > 0.5) ? aIconRect : uIconRect;
    vec4 meta = (uUseFeatureIcon > 0.5) ? aIconMeta : uIconMeta;
    float sizePx = (uUseFeatureSize > 0.5 ? aSize : uSize) * uSizeScale;
    sizePx = clamp(sizePx, uSizeMinPixels, uSizeMaxPixels);
${wakeSize}${filter ? FILTER_BODY : ''}
    // Sprite-pixel → device-pixel scale. A missing mapping entry leaves the rect
    // at zero, which collapses the quad instead of drawing a wrong sprite.
    float basis = (uSizeBasisWidth > 0.5) ? rect.z : rect.w;
    float scale = (basis > 0.0) ? sizePx / basis : 0.0;
    vec2 uv01 = vec2(aCorner.x * 0.5 + 0.5, aCorner.y);
    vec2 spritePx = vec2(uv01.x * rect.z, uv01.y * rect.w);
    vec2 iconPx = (spritePx - meta.xy) * scale;
    float angleRad = radians(uUseFeatureAngle > 0.5 ? aAngle : uAngle);
    float ca = cos(angleRad);
    float sa = sin(angleRad);
    // deck IconLayer's rotate_by_angle followed by its y flip: the net effect is
    // a COUNTER-CLOCKWISE on-screen rotation of a y-down sprite space.
    vec2 offsetPx = vec2(ca * iconPx.x + sa * iconPx.y, sa * iconPx.x - ca * iconPx.y);
    gl_Position = anchor;
    gl_Position.xy += (offsetPx / (0.5 * uViewport)) * anchor.w;
${filter ? FILTER_COLLAPSE : ''}    vUv = (rect.xy + spritePx) / uAtlasSize;
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
${colorModeAssign}${idAssign}  }
`;
}

/** Visual vertex source for a host shader variant + feature configuration. */
export function buildIconVertexSource(
  shader: ShaderInjection,
  cfg: IconShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildIconVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildIconVertexSource}. */
export function buildIconIdVertexSource(
  shader: ShaderInjection,
  cfg: IconShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildIconVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration. `getOrCreateProgram`
 * appends `::${variantName}` (the HOST variant) only, so two configurations
 * sharing a base key would collide on one program.
 */
export function iconProgramKey(
  pass: 'main' | 'pick',
  cfg: IconShaderConfig,
): string {
  if (cfg.glide) return `icon:${pass}:glide`;
  return `icon:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set.
 */
export function resolveIconTimeFilterMode(
  mode: IconTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): IconTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

/**
 * Write one sprite frame into an interleaved stride-8 buffer:
 * `[x, y, w, h, anchorX, anchorY, mask, 0]`, all in ATLAS PIXELS. An absent
 * entry writes zeros, which the shader reads as "no sprite" (scale 0 ⇒ a
 * collapsed quad) rather than as a wrong rectangle.
 *
 * Anchor defaults match deck's `IconLayer` (`width/2`, `height/2`), so an entry
 * that omits them centres the sprite on the feature position.
 */
export function writeIconFrame(
  out: Float32Array,
  offset: number,
  entry: IconMappingEntry | undefined | null,
): void {
  if (!entry) {
    for (let i = 0; i < ICON_FRAME_STRIDE; i++) out[offset + i] = 0;
    return;
  }
  const w = entry.width ?? 0;
  const h = entry.height ?? 0;
  out[offset] = entry.x ?? 0;
  out[offset + 1] = entry.y ?? 0;
  out[offset + 2] = w;
  out[offset + 3] = h;
  out[offset + 4] = entry.anchorX ?? w / 2;
  out[offset + 5] = entry.anchorY ?? h / 2;
  out[offset + 6] = entry.mask ? 1 : 0;
  out[offset + 7] = 0;
}

/**
 * Bearing in deck `getAngle` DEGREES (counter-clockwise from the sprite's "up"
 * orientation) for a move from `(fromLon, fromLat)` to `(toLon, toLat)`, or
 * `null` when the two positions coincide (a held sample / degenerate delta) so
 * a stationary marker keeps its previous angle instead of snapping to an
 * arbitrary heading.
 *
 * Longitude deltas are cosine-corrected at the source latitude — the same
 * equirectangular small-offset approximation the deck icon layer uses.
 */
export function bearingFromMotionDeg(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
): number | null {
  const dEast = (toLon - fromLon) * Math.cos((fromLat * Math.PI) / 180);
  const dNorth = toLat - fromLat;
  if (dEast === 0 && dNorth === 0) return null;
  return (Math.atan2(-dEast, dNorth) * 180) / Math.PI;
}

const FS_SOURCE = `
  precision highp float;
  uniform sampler2D uAtlas;
  uniform float uAlphaCutoff;
  varying float vAlpha;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vColorMode;
  void main() {
    if (vAlpha <= 0.0) discard;
    vec4 tex = texture2D(uAtlas, vUv);
    // mask sprites (vColorMode = 1) take their RGB from the tint; opaque
    // sprites keep their own colours and are modulated in alpha only.
    vec3 rgb = mix(tex.rgb, vColor.rgb, vColorMode);
    float a = tex.a * vColor.a * vAlpha;
    if (a < uAlphaCutoff) discard;
    gl_FragColor = vec4(rgb, a);
  }
`;

// Id-buffer pick stage. The readback must recover the byte triple exactly, so
// the id colour is written flat and opaque with no blending or coverage term.
// The three discards are what make an invisible sprite UNPICKABLE: the time /
// filter gate (`vAlpha`), the sprite's own alpha against the same
// `alphaCutoff` the visual pass uses (so transparent atlas padding is not a hit
// box), and the reserved id 0 — which the glide pick pass paints on every
// instance that does NOT belong to the (tile, layer) currently being drawn.
const ID_FS_SOURCE = `
  precision highp float;
  uniform sampler2D uAtlas;
  uniform float uAlphaCutoff;
  varying float vAlpha;
  varying vec2 vUv;
  varying vec4 vColor;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    float a = texture2D(uAtlas, vUv).a * vColor.a * vAlpha;
    if (a < uAlphaCutoff) discard;
    if (dot(vIdColor, vec3(1.0)) <= 0.0) discard;  // id 0 = not this entry
    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

/**
 * Locations every icon program shares. Resolved once per program; absent
 * uniforms come back null (a no-op for `gl.uniform*`) and absent attributes come
 * back -1, which is exactly how a mode/filter combination that doesn't declare
 * them reads.
 */
interface IconSharedHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aCorner: number;
  aMercator: number;
  aTime: number;
  aSize: number;
  aAngle: number;
  aColor: number;
  aIconRect: number;
  aIconMeta: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uAtlasSize: WebGLUniformLocation | null;
  uAtlas: WebGLUniformLocation | null;
  uAlphaCutoff: WebGLUniformLocation | null;
  uIconRect: WebGLUniformLocation | null;
  uIconMeta: WebGLUniformLocation | null;
  uUseFeatureIcon: WebGLUniformLocation | null;
  uSize: WebGLUniformLocation | null;
  uSizeScale: WebGLUniformLocation | null;
  uUseFeatureSize: WebGLUniformLocation | null;
  uSizeMinPixels: WebGLUniformLocation | null;
  uSizeMaxPixels: WebGLUniformLocation | null;
  uSizeBasisWidth: WebGLUniformLocation | null;
  uAngle: WebGLUniformLocation | null;
  uUseFeatureAngle: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

interface IconIdProgramHandles extends IconSharedHandles {
  aIdColor: number;
}

/** Per-feature attribute buffers held alongside the standard TileGpuCache. */
interface IconGpuCache extends TileGpuCache {
  colorBuffer?: WebGLBuffer;
  sizeBuffer?: WebGLBuffer;
  angleBuffer?: WebGLBuffer;
  /** Interleaved stride-8 sprite frames; absent when a constant icon is used. */
  iconBuffer?: WebGLBuffer;
  /** Per-feature DataFilter column; absent when the tile didn't bake it. */
  filterBuffer?: WebGLBuffer;
  /** Whether this tile supplies the filter column (the `enabled` gate). */
  hasFilterColumn?: boolean;
  /**
   * `${programKey}::${variantName}` the cached VAO's attribute locations were
   * recorded against — a VAO stores per-PROGRAM attribute slots, so a host
   * variant flip or a mode flip must re-record it.
   */
  vaoVariant?: string;
}

/** Atlas lifecycle: nothing → fetching → decoded (CPU) → uploaded (GPU). */
type AtlasState = 'idle' | 'loading' | 'decoded' | 'ready' | 'failed';

/** One base pick-provenance grouping: `${z}/${x}/${y}/${t}::${layerName}`. */
const entryKeyFor = (tile: Tile, layer: STTLayer): string =>
  `${tile.id.z}/${tile.id.x}/${tile.id.y}/${tile.id.t}::${layer.name}`;

/**
 * MapLibre custom layer that renders STT point tiles as atlas sprites.
 *
 * ```ts
 * const layer = new STTIconLayer({
 *   id: 'ais',
 *   url: '/data/ais.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 60_000,
 *   iconAtlas: '/icons/vessels.png',
 *   iconMapping: { vessel: { x: 0, y: 0, width: 32, height: 32, mask: true } },
 *   icon: 'vessel',
 *   angleProperty: 'cog',
 *   colorProperty: 'vessel_class',
 *   interpolate: true,
 *   idProperty: 'mmsi',
 * });
 * map.addLayer(layer);
 * ```
 */
export class STTIconLayer extends STTFilterableLayer {
  private iconOpts: {
    iconAtlas?: STTIconAtlasSource | null;
    iconMapping?: Record<string, IconMappingEntry> | null;
    icon: string;
    iconProperty?: string;
    size: number;
    sizeProperty?: string;
    sizeUnits: 'pixels' | 'meters';
    sizeScale: number;
    sizeMinPixels: number;
    sizeMaxPixels: number;
    sizeBasis: 'height' | 'width';
    angle: number;
    angleProperty?: string;
    color: [number, number, number, number];
    colorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    alphaCutoff: number;
    timeFilterMode?: IconTimeFilterMode;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
    interpolate: boolean;
    idProperty: string;
    maxInterpolationGap: number;
    reducedMotion: boolean;
  };
  /** Compiled feature configuration; drives the program-cache keys. */
  private shaderConfig: IconShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /** `${mainKey}::${variantName}` — the tile-VAO staleness key. */
  private mainVaoKey = '';
  /** Handles of the most recently used variant, memoized per `*Variant`. */
  private handles?: IconSharedHandles;
  private handlesVariant?: string;
  private idHandles?: IconIdProgramHandles;
  private idHandlesVariant?: string;
  /** One-shot warning keys (missing atlas, categorical filter, no id column…). */
  private readonly warned = new Set<string>();

  // ── atlas state ──────────────────────────────────────────────────────────
  private atlasState: AtlasState = 'idle';
  /** The decoded source, kept across context loss so a restore re-uploads it. */
  private atlasImage?: IconAtlasImage;
  private atlasTexture?: WebGLTexture;
  private atlasWidth = 0;
  private atlasHeight = 0;
  /** URL the in-flight/completed load belongs to (guards a late swap). */
  private atlasUrl?: string;

  /** Constant sprite frame resolved from `iconMapping[icon]`, split per uniform. */
  private readonly constIconRect = new Float32Array(4);
  private readonly constIconMeta = new Float32Array(4);
  /** Scratch for {@link writeIconFrame} (rect + meta interleaved). */
  private readonly constIconFrame = new Float32Array(ICON_FRAME_STRIDE);
  /**
   * The constant tint in 0–1 floats, resolved once per `setColor` rather than
   * per tile per frame — `toRgba01` allocates, and `setStyleUniforms` runs on
   * every tile of every frame.
   */
  private readonly tintRgba01 = new Float32Array(4);

  // ── motion-glide state (the `interpolate` path only) ─────────────────────
  private readonly glideMaintainer = new TrackIndexMaintainer();
  private glideIndex: Map<string, Track> | null = null;
  /** Resident tiles the index was last synced against (identity-compared). */
  private glideTiles: Tile[] = [];
  private glideTileKeys: string[] = [];
  private glideIndexStale = true;
  /**
   * Per-provenance-entry `entityId → feature row`, the join the glide pick pass
   * needs (its instances are per ENTITY, while ids are allocated per tile ROW).
   * Built lazily for the entry being picked and dropped whole when the resident
   * set moves, so it can never outlive — or fall behind — the tiles it indexes.
   */
  private readonly glideRows = new Map<string, Map<string, number>>();
  /** Instance buffers, grown to the track count and filled to `glideCount`. */
  private glidePositions = new Float32Array(0);
  private glideAngles = new Float32Array(0);
  private glideColors = new Uint8Array(0);
  private glideFrames = new Float32Array(0);
  private glideTrackIds: string[] = [];
  private glideCount = 0;
  private glideCapacity = 0;
  /**
   * True once every GPU store has been (re-)specified at the CURRENT
   * `glideCapacity`. Cleared by a capacity growth and by context loss, which is
   * exactly when a `bufferData` re-specification is owed before the per-frame
   * `bufferSubData` prefix writes resume.
   */
  private glideStoresSized = false;
  /** Playhead the CPU buffers were sampled at; NaN forces a re-sample. */
  private glideSampleTime = Number.NaN;
  /** Sample time the GPU buffers hold; NaN forces a re-upload. */
  private glideUploadedTime = Number.NaN;
  private glidePosBuffer?: WebGLBuffer;
  private glideAngleBuffer?: WebGLBuffer;
  private glideColorBuffer?: WebGLBuffer;
  private glideFrameBuffer?: WebGLBuffer;
  /** Refilled in place every sync/sample — the glide path allocates no config. */
  private readonly glideSampleConfig: TrackSampleConfig = {
    defaultLength: 0,
    defaultWidth: 0,
    defaultHeight: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    // The heading column is DEGREES (deck `getAngle` parity), so the kernel
    // must take the shortest DEGREE arc rather than treating it as radians.
    angleUnit: 'deg',
    maxGapMs: Infinity,
  };

  constructor(opts: STTIconLayerOptions) {
    super(opts);
    this.iconOpts = {
      iconAtlas: opts.iconAtlas,
      iconMapping: opts.iconMapping,
      icon: opts.icon ?? DEFAULT_ICON,
      iconProperty: opts.iconProperty,
      size: opts.size ?? 12,
      sizeProperty: opts.sizeProperty,
      sizeUnits: opts.sizeUnits ?? 'pixels',
      sizeScale: opts.sizeScale ?? 1,
      sizeMinPixels: opts.sizeMinPixels ?? 0,
      sizeMaxPixels: opts.sizeMaxPixels ?? Number.MAX_SAFE_INTEGER,
      sizeBasis: opts.sizeBasis ?? 'height',
      angle: opts.angle ?? 0,
      angleProperty: opts.angleProperty,
      color: opts.color ?? [255, 255, 255, 255],
      colorProperty: opts.colorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      alphaCutoff: opts.alphaCutoff ?? 0.05,
      timeFilterMode: opts.timeFilterMode,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
      interpolate: opts.interpolate === true,
      idProperty: opts.idProperty ?? '',
      maxInterpolationGap: opts.maxInterpolationGap ?? Infinity,
      reducedMotion: opts.reducedMotion === true,
    };
    this.shaderConfig = {
      mode: this.resolveMode(),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered.
      filter: Boolean(opts.filterProperty),
      glide: this.glideActive(),
    };
    this.mainKey = iconProgramKey('main', this.shaderConfig);
    this.pickKey = iconProgramKey('pick', this.shaderConfig);
    this.refreshConstantIcon();
    this.tintRgba01.set(toRgba01(this.iconOpts.color));
  }

  private resolveMode(): IconTimeFilterMode {
    return resolveIconTimeFilterMode(
      this.iconOpts.timeFilterMode,
      this.iconOpts.wakeLength,
      this.iconOpts.trailLength,
    );
  }

  /**
   * True when the CPU glide path owns this frame: `interpolate` on,
   * reduced-motion off, a resolvable `idProperty`, and wake off (deck's exact
   * gate). Any unmet condition — the default — leaves the discrete GPU path
   * byte-identical.
   */
  private glideActive(): boolean {
    const o = this.iconOpts;
    return (
      o.interpolate &&
      !o.reducedMotion &&
      !(o.wakeLength > 0) &&
      o.idProperty.length > 0
    );
  }

  // ── runtime setters ──────────────────────────────────────────────────────

  /**
   * Replace the tint. Uniform-only on the discrete path; the glide path BAKES
   * the tint into its per-instance colours, so its sampled poses are
   * invalidated too (otherwise a PAUSED map would keep the old colour until the
   * playhead moved).
   */
  setColor(color: [number, number, number, number]): void {
    this.iconOpts.color = color;
    this.tintRgba01.set(toRgba01(color));
    this.invalidateGlideSample();
    this.map?.triggerRepaint();
  }

  /** Replace the constant size (in `sizeUnits`). Uniform-only. */
  setSize(size: number): void {
    this.iconOpts.size = size;
    this.map?.triggerRepaint();
  }

  /**
   * Replace the constant rotation, in degrees CCW. Uniform-only on the discrete
   * path; it is the glide path's per-instance fallback angle (headingless or
   * stationary tracks), so that path re-samples — see {@link setColor}.
   */
  setAngle(angle: number): void {
    this.iconOpts.angle = angle;
    this.invalidateGlideSample();
    this.map?.triggerRepaint();
  }

  /**
   * Swap the atlas image/URL. The current texture is dropped and the new source
   * re-resolved (a URL is fetched once); nothing draws until it is ready.
   */
  setIconAtlas(atlas: STTIconAtlasSource | null): void {
    if (this.iconOpts.iconAtlas === atlas) return;
    this.iconOpts.iconAtlas = atlas;
    this.releaseAtlasTexture(this.gl);
    this.atlasImage = undefined;
    this.atlasUrl = undefined;
    this.atlasState = 'idle';
    this.map?.triggerRepaint();
  }

  /**
   * Swap the sprite mapping. Per-feature sprite frames are baked at tile-upload
   * time, so this rebuilds the tile caches — a UI-scale operation, not a
   * per-frame one.
   */
  setIconMapping(mapping: Record<string, IconMappingEntry> | null): void {
    this.iconOpts.iconMapping = mapping;
    this.refreshConstantIcon();
    // Glide frames are resolved per SAMPLE, not per tile, so the merged path
    // needs its own invalidation (rebuildTileCaches only touches tile buffers).
    this.invalidateGlideSample();
    this.rebuildTileCaches();
  }

  /**
   * Select the constant sprite by name (a key of `iconMapping`). Uniform-only
   * UNLESS `iconProperty` is set: the per-feature frames bake this sprite as the
   * fallback for values the mapping doesn't name, so those tiles are rebuilt.
   */
  setIcon(icon: string): void {
    if (this.iconOpts.icon === icon) return;
    this.iconOpts.icon = icon;
    this.refreshConstantIcon();
    this.invalidateGlideSample();
    if (this.iconOpts.iconProperty) {
      this.rebuildTileCaches();
      return;
    }
    this.map?.triggerRepaint();
  }

  /**
   * Switch time-filter mode at runtime. The mode is compiled in, so this links a
   * second program on the next frame (cached from then on) and re-records every
   * tile VAO against it.
   */
  setTimeFilterMode(mode: IconTimeFilterMode): void {
    this.iconOpts.timeFilterMode = mode;
    this.applyShaderConfig();
  }

  /** Update the wake length (ms) — selects wake mode when it goes positive. */
  setWakeLength(wakeLength: number): void {
    this.iconOpts.wakeLength = wakeLength;
    this.applyShaderConfig();
  }

  /** Update the trail length (ms) — selects trail mode when it goes positive. */
  setTrailLength(trailLength: number): void {
    this.iconOpts.trailLength = trailLength;
    this.applyShaderConfig();
  }

  /**
   * Toggle the motion-glide path. Flipping it swaps which program is compiled
   * (glide has no time kernel) and resets the pooled track index, so it is a UI
   * toggle, not a per-frame knob.
   */
  setInterpolate(interpolate: boolean): void {
    if (this.iconOpts.interpolate === interpolate) return;
    this.iconOpts.interpolate = interpolate;
    this.resetGlideIndex();
    this.applyShaderConfig();
  }

  /** Honour (or stop honouring) the viewer's reduced-motion preference. */
  setReducedMotion(reducedMotion: boolean): void {
    if (this.iconOpts.reducedMotion === reducedMotion) return;
    this.iconOpts.reducedMotion = reducedMotion;
    this.resetGlideIndex();
    this.applyShaderConfig();
  }

  /**
   * Recompute the compiled configuration after a knob moved, dropping the
   * memoized handles so the next draw resolves (and links, once) the program for
   * the new key. Tile VAOs carry the key in `vaoVariant` and rebuild themselves
   * on the same draw.
   */
  private applyShaderConfig(): void {
    const mode = this.resolveMode();
    const glide = this.glideActive();
    if (mode === this.shaderConfig.mode && glide === this.shaderConfig.glide) {
      this.map?.triggerRepaint();
      return;
    }
    const glideFlipped = glide !== this.shaderConfig.glide;
    this.shaderConfig = { ...this.shaderConfig, mode, glide };
    this.mainKey = iconProgramKey('main', this.shaderConfig);
    this.pickKey = iconProgramKey('pick', this.shaderConfig);
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
    // The tile cache SHAPE follows the glide gate (glide builds the attribute
    // -less placeholder), so a flip must drop what the other mode built —
    // otherwise leaving glide would draw empty placeholders for every already
    // resident tile.
    if (glideFlipped) this.rebuildTileCaches();
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[${this.id}] ${message}`);
  }

  // ── atlas ────────────────────────────────────────────────────────────────

  /** Recompute the constant sprite uniforms from `iconMapping[icon]`. */
  private refreshConstantIcon(): void {
    const entry = this.iconOpts.iconMapping?.[this.iconOpts.icon];
    writeIconFrame(this.constIconFrame, 0, entry);
    this.constIconRect.set(this.constIconFrame.subarray(0, 4));
    this.constIconMeta.set(this.constIconFrame.subarray(4, 8));
  }

  /**
   * Ensure the atlas texture is uploaded and an `iconMapping` exists, kicking
   * off a URL load on the first call. Returns false while anything is missing —
   * callers SKIP the draw entirely rather than paint untextured quads. Never
   * throws: a failed load warns once and the layer stays silent.
   */
  private ensureAtlas(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): boolean {
    if (!this.iconOpts.iconMapping) {
      this.warnOnce(
        'mapping',
        'iconMapping is required to draw icons — nothing will be drawn until it is set',
      );
      return false;
    }
    if (this.atlasState === 'ready' && this.atlasTexture) return true;
    if (this.atlasState === 'failed') return false;
    if (this.atlasState === 'idle') this.resolveAtlasSource();
    if (this.atlasState === 'decoded') return this.uploadAtlas(gl);
    return false;
  }

  /**
   * First look at `iconAtlas`: a string starts a one-shot `Image` load; an
   * already decoded source moves straight to 'decoded'; a source still decoding
   * (an `<img>` with `complete === false`) gets a load listener.
   */
  private resolveAtlasSource(): void {
    const src = this.iconOpts.iconAtlas;
    if (!src) {
      this.warnOnce(
        'atlas',
        'iconAtlas is required to draw icons — nothing will be drawn until it is set',
      );
      this.atlasState = 'failed';
      return;
    }
    if (typeof src === 'string') {
      this.loadAtlasUrl(src);
      return;
    }
    const el = src as { complete?: boolean; addEventListener?: unknown };
    if (el.complete === false && typeof el.addEventListener === 'function') {
      // An <img> handed over before it finished decoding: wait for it rather
      // than uploading a 0×0 texture.
      this.atlasState = 'loading';
      const target = src as unknown as {
        addEventListener: (t: string, fn: () => void, o: object) => void;
      };
      target.addEventListener(
        'load',
        () => {
          if (this.iconOpts.iconAtlas !== src) return; // superseded
          this.atlasImage = src;
          this.atlasState = 'decoded';
          this.map?.triggerRepaint();
        },
        { once: true },
      );
      return;
    }
    this.atlasImage = src;
    this.atlasState = 'decoded';
  }

  /** Fetch a URL atlas exactly once. No `Image` in this runtime ⇒ warn + idle. */
  private loadAtlasUrl(url: string): void {
    const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement })
      .Image;
    if (!ImageCtor) {
      this.warnOnce(
        'atlas-image',
        'iconAtlas was given as a URL but this runtime has no Image constructor — ' +
          'pass a decoded image source instead; nothing will be drawn',
      );
      this.atlasState = 'failed';
      return;
    }
    this.atlasState = 'loading';
    this.atlasUrl = url;
    const img = new ImageCtor();
    // Same-origin atlases are unaffected; a cross-origin one must be CORS-clean
    // or the upload would taint the map canvas.
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.atlasUrl !== url) return; // superseded by a later setIconAtlas
      this.atlasImage = img;
      this.atlasState = 'decoded';
      this.map?.triggerRepaint();
    };
    img.onerror = () => {
      if (this.atlasUrl !== url) return;
      this.atlasState = 'failed';
      // Keyed by URL so a later `setIconAtlas` to a different broken URL is
      // still reported once (the warn-once set is per LAYER, not per source).
      this.warnOnce(`atlas-load:${url}`, `icon atlas failed to load: ${url}`);
    };
    img.src = url;
  }

  /**
   * Upload the decoded atlas. LINEAR + CLAMP_TO_EDGE with no mipmaps keeps
   * non-power-of-two atlases legal on WebGL1.
   */
  private uploadAtlas(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): boolean {
    const src = this.atlasImage;
    if (!src) return false;
    const probe = src as { naturalWidth?: number; naturalHeight?: number };
    const w = probe.naturalWidth || src.width;
    const h = probe.naturalHeight || src.height;
    if (!(w > 0) || !(h > 0)) return false;
    const tex = gl.createTexture();
    if (!tex) return false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (!this.texImageAtlas(gl, src)) {
      // A source the runtime refuses (see texImageAtlas): drop the texture and
      // stay silent forever rather than draw untextured quads every frame.
      gl.deleteTexture(tex);
      this.atlasState = 'failed';
      return false;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasTexture = tex;
    this.atlasWidth = w;
    this.atlasHeight = h;
    this.atlasState = 'ready';
    return true;
  }

  /**
   * `texImage2D` the atlas with the unpack state this layer's fragment stage
   * assumes — STRAIGHT (non-premultiplied) alpha, no vertical flip — and then
   * put the HOST's values back.
   *
   * Both flags are global GL state that maplibre mirrors in cached `BaseValue`s
   * and re-applies only when its cache disagrees; its own `Texture.update` sets
   * UNPACK_PREMULTIPLY_ALPHA for every RGBA texture it uploads, so by the time a
   * custom layer runs the flag is usually ON. Two consequences, both real:
   *
   *  - uploading premultiplied and then blending `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`
   *    (what `applySharedGlState` sets) double-multiplies, haloing every
   *    translucent sprite edge — visible on colour sprites, invisible on `mask`
   *    ones whose RGB the tint replaces;
   *  - leaving our value behind the map's back is NOT self-healing: maplibre's
   *    cache still claims the old value, so the basemap's next glyph/sprite
   *    upload would silently inherit ours. Same hazard the base `pick()`
   *    documents for blend/depth/clear state — hence the restore.
   *
   * Returns false (never throws — `ensureAtlas` promises that) when the runtime
   * rejects the source: a bare `{width, height}` stand-in, a tainted
   * cross-origin image, a detached `ImageBitmap`.
   */
  private texImageAtlas(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    src: IconAtlasImage,
  ): boolean {
    // Feature-detected: the package's test recorder implements only the GL
    // surface the layers actually need, and unpack state is a no-op there.
    const canSetUnpack =
      typeof (gl as { pixelStorei?: unknown }).pixelStorei === 'function';
    const premultiplied =
      canSetUnpack && Boolean(gl.getParameter(UNPACK_PREMULTIPLY_ALPHA_WEBGL));
    const flipped =
      canSetUnpack && Boolean(gl.getParameter(UNPACK_FLIP_Y_WEBGL));
    // Only touched when the host left them ON, so the common case costs nothing.
    if (premultiplied) gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (flipped) gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, false);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        src as unknown as TexImageSource,
      );
      return true;
    } catch (err) {
      this.warnOnce(
        'atlas-upload',
        `icon atlas could not be uploaded (${String(err)}) — pass a decoded, ` +
          'CORS-clean image source; nothing will be drawn',
      );
      return false;
    } finally {
      if (premultiplied) gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (flipped) gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, true);
    }
  }

  /** Drop the GPU texture (decoded source kept, so a restore re-uploads it). */
  private releaseAtlasTexture(
    gl?: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (gl && this.atlasTexture) gl.deleteTexture(this.atlasTexture);
    this.atlasTexture = undefined;
    this.atlasWidth = 0;
    this.atlasHeight = 0;
    if (this.atlasState === 'ready') this.atlasState = 'decoded';
  }

  // ── GL lifecycle ─────────────────────────────────────────────────────────

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Eagerly link the legacy variants (what a ≤v4 host uses from its first
    // frame; a v5 host links its own lazily through the base per-variant
    // cache). The id program comes along so the first pick() doesn't stall.
    const variant = LEGACY_FRAME.shader.variantName;
    this.handles = this.getOrCreateProgram(
      gl,
      this.mainKey,
      LEGACY_FRAME,
      (g, s) => this.buildMainHandles(g, s),
    );
    this.handlesVariant = variant;
    this.mainVaoKey = `${this.mainKey}::${variant}`;
    this.idHandles = this.getOrCreateProgram(
      gl,
      this.pickKey,
      LEGACY_FRAME,
      (g, s) => this.buildIdHandles(g, s),
    );
    this.idHandlesVariant = variant;
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Programs are owned by the base per-variant cache (already dropped before
    // this hook runs); the atlas texture and the glide instance buffers are
    // ours. Deletes on a lost context are silently ignored, so this doubles as
    // the pure reference release the loss path wants.
    this.releaseAtlasTexture(gl);
    for (const buf of [
      this.glidePosBuffer,
      this.glideAngleBuffer,
      this.glideColorBuffer,
      this.glideFrameBuffer,
    ]) {
      if (buf) gl.deleteBuffer(buf);
    }
    this.glidePosBuffer = undefined;
    this.glideAngleBuffer = undefined;
    this.glideColorBuffer = undefined;
    this.glideFrameBuffer = undefined;
    // The stores went with the context: the next upload owes a fresh
    // `bufferData` sizing before it can write a prefix.
    this.glideStoresSized = false;
    this.glideSampleTime = Number.NaN;
    this.glideUploadedTime = Number.NaN;
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /** Resolve the locations every icon program declares. */
  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): IconSharedHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aSize: gl.getAttribLocation(program, 'aSize'),
      aAngle: gl.getAttribLocation(program, 'aAngle'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aIconRect: gl.getAttribLocation(program, 'aIconRect'),
      aIconMeta: gl.getAttribLocation(program, 'aIconMeta'),
      aFilterValue: gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uAtlasSize: gl.getUniformLocation(program, 'uAtlasSize'),
      uAtlas: gl.getUniformLocation(program, 'uAtlas'),
      uAlphaCutoff: gl.getUniformLocation(program, 'uAlphaCutoff'),
      uIconRect: gl.getUniformLocation(program, 'uIconRect'),
      uIconMeta: gl.getUniformLocation(program, 'uIconMeta'),
      uUseFeatureIcon: gl.getUniformLocation(program, 'uUseFeatureIcon'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uSizeScale: gl.getUniformLocation(program, 'uSizeScale'),
      uUseFeatureSize: gl.getUniformLocation(program, 'uUseFeatureSize'),
      uSizeMinPixels: gl.getUniformLocation(program, 'uSizeMinPixels'),
      uSizeMaxPixels: gl.getUniformLocation(program, 'uSizeMaxPixels'),
      uSizeBasisWidth: gl.getUniformLocation(program, 'uSizeBasisWidth'),
      uAngle: gl.getUniformLocation(program, 'uAngle'),
      uUseFeatureAngle: gl.getUniformLocation(program, 'uUseFeatureAngle'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveWakeTailScaleUniformLocation(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
      ...resolveFilterTransformSizeUniformLocation(gl, program),
    };
  }

  /** Link the visual program for a variant and resolve its locations. */
  private buildMainHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): IconSharedHandles {
    const program = this.linkProgram(
      gl,
      buildIconVertexSource(shader, this.shaderConfig),
      FS_SOURCE,
    );
    return this.resolveSharedHandles(gl, program, shader);
  }

  /** Link the id-pick program for a variant and resolve its locations. */
  private buildIdHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): IconIdProgramHandles {
    const program = this.linkProgram(
      gl,
      buildIconIdVertexSource(shader, this.shaderConfig),
      ID_FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
    };
  }

  /** Fetch (or link) the visual handles for this frame's host variant. */
  private mainHandlesFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
  ): IconSharedHandles {
    const variant = frame.shader.variantName;
    let h = this.handles;
    if (!h || this.handlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.mainKey, frame, (g, s) =>
        this.buildMainHandles(g, s),
      );
      this.handles = h;
      this.handlesVariant = variant;
      // `mainKey` and `variant` are the only inputs, and applyShaderConfig
      // clears `handlesVariant` whenever `mainKey` moves — so this branch is
      // exactly the set of frames where the VAO key can change.
      this.mainVaoKey = `${this.mainKey}::${variant}`;
    }
    return h;
  }

  /** Fetch (or link) the id-pass handles for this frame's host variant. */
  private idHandlesFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
  ): IconIdProgramHandles {
    const variant = frame.shader.variantName;
    let h = this.idHandles;
    if (!h || this.idHandlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.pickKey, frame, (g, s) =>
        this.buildIdHandles(g, s),
      );
      this.idHandles = h;
      this.idHandlesVariant = variant;
    }
    return h;
  }

  // ── tile upload ──────────────────────────────────────────────────────────

  /**
   * A cache that owns no per-feature attributes — what the GLIDE path needs.
   *
   * Glide draws from the layer-wide merged instance buffers, so `render()`
   * never asks for a tile cache at all; the only caller left is
   * `buildPickProvenance`, which builds one per resident (tile, layer) before
   * every `pick()`. Uploading the full attribute set there would spend tens of
   * MB (and a multi-frame hitch on the first hover) on buffers
   * {@link drawGlidePick} never binds — it reads only the merged buffers and
   * the CPU-side `glideRows` join. The two zero-length buffers keep the
   * `TileGpuCache` contract (the base's unload sweep deletes them) and
   * `vertexCount: 0` makes an accidental discrete `drawTile` a no-op rather
   * than a wrong draw.
   *
   * `applyShaderConfig` drops every cache when the glide gate flips, so a layer
   * that leaves glide never keeps one of these.
   */
  private buildGlidePlaceholderCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    layer: STTLayer,
  ): IconGpuCache {
    const empty = new Float32Array(0);
    return {
      positionBuffer: this.uploadArrayBuffer(gl, empty),
      timeBuffer: this.uploadArrayBuffer(gl, empty),
      vertexCount: 0,
      indexCount: 0,
      timeOffset: layer.features.timeOffset,
    };
  }

  /**
   * Build the per-tile cache: the base's quantized anchors + per-feature times,
   * plus optional colour / size / angle / sprite-frame / DataFilter attributes
   * for whichever columns are configured AND present in this tile.
   *
   * In glide mode the per-tile attributes are dead weight (see
   * {@link buildGlidePlaceholderCache}), so only the placeholder is built.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): IconGpuCache | null {
    if (!this.instSupport.enabled) {
      this.warnOnce(
        'instancing',
        'runtime lacks ANGLE_instanced_arrays / WebGL2; STTIconLayer requires instancing',
      );
      return null;
    }
    if (this.glideActive()) return this.buildGlidePlaceholderCache(gl, layer);
    const baseCache = super.buildTileGpuCache(gl, tile, layer);
    if (!baseCache) return null;
    const cache = baseCache as IconGpuCache;
    const f = layer.features;
    const count = cache.vertexCount;
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];

    if (this.iconOpts.colorProperty) {
      const colors = this.expandCategoricalColors(
        f,
        this.iconOpts.colorProperty,
        this.iconOpts.colorPalette,
        this.iconOpts.colorMapping,
        this.iconOpts.colorMappingDefault,
      );
      if (colors) {
        cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
        extras.push(cache.colorBuffer);
      }
    }

    if (this.iconOpts.sizeProperty) {
      const sizes = this.getNumericProperty(f, this.iconOpts.sizeProperty);
      if (sizes) {
        cache.sizeBuffer = this.uploadArrayBuffer(gl, sizes);
        extras.push(cache.sizeBuffer);
      }
    }

    if (this.iconOpts.angleProperty) {
      const angles = this.getNumericProperty(f, this.iconOpts.angleProperty);
      if (angles) {
        cache.angleBuffer = this.uploadArrayBuffer(gl, angles);
        extras.push(cache.angleBuffer);
      }
    }

    const frames = this.buildIconFrames(f, count);
    if (frames) {
      cache.iconBuffer = this.uploadArrayBuffer(gl, frames);
      extras.push(cache.iconBuffer);
    }

    if (this.shaderConfig.filter) {
      // One icon == one instance, so the per-FEATURE column binds directly.
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical) this.warnCategoricalFilterOnce();
      cache.hasFilterColumn = col.hasColumn;
      if (col.values) {
        cache.filterBuffer = this.uploadArrayBuffer(gl, col.values);
        extras.push(cache.filterBuffer);
      }
    }

    cache.extraBuffers = extras.length > 0 ? extras : undefined;
    return cache;
  }

  /**
   * Per-feature sprite frames for a tile, or null when the constant sprite
   * uniform covers every feature (no `iconProperty`, or this tile lacks the
   * column). A value missing from `iconMapping` falls back to the constant
   * sprite, and a NULL category entry (`0xffff`) does the same.
   */
  private buildIconFrames(
    features: BinaryFeatures,
    count: number,
  ): Float32Array | null {
    const prop = this.iconOpts.iconProperty;
    if (!prop) return null;
    const cat = features.categoricalProps[prop];
    if (!cat) {
      this.warnOnce(
        'icon-column',
        `iconProperty '${prop}' is not a categorical column in this tile — ` +
          `falling back to the constant icon '${this.iconOpts.icon}'`,
      );
      return null;
    }
    const mapping = this.iconOpts.iconMapping;
    const fallback = mapping?.[this.iconOpts.icon];
    const out = new Float32Array(count * ICON_FRAME_STRIDE);
    for (let i = 0; i < count; i++) {
      const idx = cat.indices[i];
      const name = idx === 0xffff ? undefined : cat.categories[idx];
      const entry =
        (name !== undefined ? mapping?.[name] : undefined) ?? fallback;
      writeIconFrame(out, i * ICON_FRAME_STRIDE, entry);
    }
    return out;
  }

  // ── uniforms ─────────────────────────────────────────────────────────────

  /**
   * The `uSizeScale` value for one tile. In `'pixels'` it is the plain
   * `sizeScale` multiplier; in `'meters'` the metres→device-pixels factor at the
   * TILE CENTRE's latitude and the map's FRACTIONAL zoom is folded in, so both
   * the constant `size` and a `sizeProperty` column read as ground metres and
   * grow continuously rather than stepping at integer zooms.
   */
  private sizeScaleForTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { sizeScale, sizeUnits } = this.iconOpts;
    if (sizeUnits !== 'meters') return sizeScale;
    // Shared base helper (fractional zoom + dpr + tile-centre latitude).
    return sizeScale * this.metricPixelScale(gl, tile, ctx);
  }

  /**
   * The `uSizeScale` value for the GLIDE pass. Glide merges every resident tile
   * into ONE draw, so a metric size has no per-tile latitude to resolve at and
   * uses the MAP CENTRE's instead — the same single-factor approximation
   * maplibre's own `_pixelPerMeter` makes for fill-extrusion.
   */
  private sizeScaleForGlide(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): number {
    const { sizeScale, sizeUnits } = this.iconOpts;
    if (sizeUnits !== 'meters') return sizeScale;
    const center = (
      this.map as unknown as { getCenter?: () => { lat: number } } | undefined
    )?.getCenter?.();
    // The latitude-explicit form of the shared base helper: a glide instance is
    // not tied to one tile, so the MAP CENTRE stands in, and the fallback zoom
    // is 0 because the glide pass only ever runs inside a frame (where
    // `frameZoom` is set).
    return sizeScale * this.metricPixelScaleAt(gl, center?.lat ?? 0, 0);
  }

  /**
   * Projection uniforms for the frame's host variant: the injected prelude owns
   * projection on v5+, `uMatrix` on legacy hosts. Icons are 2d billboards, so
   * `projectTile`'s z overwrite is exactly what we want and altitude is unused.
   */
  private setProjectionUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) this.setPreludeProjectionUniforms(gl, h.program, frame);
    else gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
  }

  /**
   * Sizing / sprite / tint uniforms — everything the visual and id passes set
   * identically, so the pickable quad always matches the drawn one.
   * `useFeature*` flags are program-level (not VAO-recorded), so they are set
   * every draw and a runtime column swap takes effect immediately.
   */
  private setStyleUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
    sizeScale: number,
    useFeatureIcon: boolean,
    useFeatureSize: boolean,
    useFeatureAngle: boolean,
    useFeatureColor: boolean,
  ): void {
    const o = this.iconOpts;
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(h.uAtlasSize, this.atlasWidth || 1, this.atlasHeight || 1);
    gl.uniform4fv(h.uIconRect, this.constIconRect);
    gl.uniform4fv(h.uIconMeta, this.constIconMeta);
    gl.uniform1f(h.uUseFeatureIcon, useFeatureIcon ? 1 : 0);
    gl.uniform1f(h.uSize, o.size);
    gl.uniform1f(h.uSizeScale, sizeScale);
    gl.uniform1f(h.uUseFeatureSize, useFeatureSize ? 1 : 0);
    gl.uniform1f(h.uSizeMinPixels, o.sizeMinPixels);
    gl.uniform1f(h.uSizeMaxPixels, o.sizeMaxPixels);
    gl.uniform1f(h.uSizeBasisWidth, o.sizeBasis === 'width' ? 1 : 0);
    gl.uniform1f(h.uAngle, o.angle);
    gl.uniform1f(h.uUseFeatureAngle, useFeatureAngle ? 1 : 0);
    gl.uniform4fv(h.uColor, this.tintRgba01);
    gl.uniform1f(h.uUseFeatureColor, useFeatureColor ? 1 : 0);
    gl.uniform1f(h.uAlphaCutoff, o.alphaCutoff);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture ?? null);
    gl.uniform1i(h.uAtlas, 0);
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active mode's
   * uniforms exist in the program, so the switch is also what keeps a stale
   * mode's uniform from being written to a null location every draw.
   * `uCurrentTime` is TILE-RELATIVE (the package-wide convention).
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
    cache: IconGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.iconOpts;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
        gl.uniform1f(h.uWakeTailScale, o.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uTrailLength, o.trailLength);
        gl.uniform1f(h.uFadeTrail, o.fadeTrail);
        break;
      default: {
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  /**
   * Upload the DataFilter uniforms for this tile, unless no filter branch was
   * compiled — the glide program compiles none whatever `filterProperty` says,
   * so its program has no filter uniform to write.
   */
  private setFilterUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
    cache: IconGpuCache,
  ): void {
    if (!this.shaderConfig.filter || this.shaderConfig.glide) return;
    this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn === true);
  }

  // ── discrete draw ────────────────────────────────────────────────────────

  /**
   * Bind one instanced attribute (divisor 1) — the icon layer's per-instance
   * binds are otherwise five copies of the same four calls.
   */
  private bindInstanced(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    loc: number,
    buffer: WebGLBuffer,
    size: number,
    type: number,
    normalized: boolean,
    stride = 0,
    offset = 0,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, normalized, stride, offset);
    this.instSupport.vertexAttribDivisor(loc, 1);
  }

  /** Bind the per-vertex unit quad (divisor 0), shared by every pass. */
  private bindQuad(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.getUnitQuad(gl));
    gl.enableVertexAttribArray(h.aCorner);
    gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCorner, 0);
  }

  /** Bind every per-instance attribute a discrete tile draw needs. */
  private bindTileAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
    c: IconGpuCache,
  ): void {
    this.bindQuad(gl, h);
    this.bindInstanced(
      gl,
      h.aMercator,
      c.positionBuffer,
      3,
      gl.UNSIGNED_SHORT,
      true,
    );
    if (h.aTime >= 0) {
      this.bindInstanced(gl, h.aTime, c.timeBuffer, 2, gl.FLOAT, false);
    }
    if (c.sizeBuffer && h.aSize >= 0) {
      this.bindInstanced(gl, h.aSize, c.sizeBuffer, 1, gl.FLOAT, false);
    }
    if (c.angleBuffer && h.aAngle >= 0) {
      this.bindInstanced(gl, h.aAngle, c.angleBuffer, 1, gl.FLOAT, false);
    }
    if (c.colorBuffer && h.aColor >= 0) {
      this.bindInstanced(
        gl,
        h.aColor,
        c.colorBuffer,
        4,
        gl.UNSIGNED_BYTE,
        true,
      );
    }
    if (c.iconBuffer && h.aIconRect >= 0) {
      // One interleaved stride-8 buffer feeds both sprite attributes.
      const stride = ICON_FRAME_STRIDE * 4;
      this.bindInstanced(
        gl,
        h.aIconRect,
        c.iconBuffer,
        4,
        gl.FLOAT,
        false,
        stride,
        0,
      );
      if (h.aIconMeta >= 0) {
        this.bindInstanced(
          gl,
          h.aIconMeta,
          c.iconBuffer,
          4,
          gl.FLOAT,
          false,
          stride,
          16,
        );
      }
    }
    if (c.filterBuffer && h.aFilterValue >= 0) {
      this.bindInstanced(
        gl,
        h.aFilterValue,
        c.filterBuffer,
        1,
        gl.FLOAT,
        false,
      );
    }
  }

  /**
   * Host dispatch: the glide path replaces the base's per-tile loop with ONE
   * merged draw of interpolated poses, so it owns `render()` end to end (still
   * going through `beginFrame`, which is what advances the tileset viewport and
   * normalizes the host's render arguments). Everything else falls through to
   * the base loop → {@link drawTile}.
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ): void {
    if (!this.glideActive()) {
      super.render(gl, matrixOrArgs, options);
      return;
    }
    const frame = this.beginFrame(matrixOrArgs, options);
    if (!frame) return;
    this.applySharedGlState(gl);
    this.drawGlide(gl, frame);
    this.unbindVao();
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    if (!this.instSupport.enabled) return;
    if (!this.ensureAtlas(gl)) return;
    const c = cache as IconGpuCache;
    const count = c.vertexCount; // one instance per feature
    if (count === 0) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const h = this.mainHandlesFor(gl, frame);

    gl.useProgram(h.program);
    this.setProjectionUniforms(gl, h, ctx, frame);
    gl.uniform3fv(h.uPosScale, c.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, c.posOffset ?? ZERO_POS_OFFSET);
    this.setStyleUniforms(
      gl,
      h,
      this.sizeScaleForTile(gl, tile, ctx),
      Boolean(c.iconBuffer) && h.aIconRect >= 0,
      Boolean(c.sizeBuffer) && h.aSize >= 0,
      Boolean(c.angleBuffer) && h.aAngle >= 0,
      Boolean(c.colorBuffer) && h.aColor >= 0,
    );
    this.setTimeUniforms(gl, h, c, ctx);
    this.setFilterUniforms(gl, h, c);

    // A VAO records attribute locations against ONE program — drop it when the
    // host flipped shader variants or the layer flipped compiled mode.
    if (c.vao && c.vaoVariant !== this.mainVaoKey) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    if (this.vaoSupport.enabled && c.vao) {
      this.vaoSupport.bind(c.vao);
    } else {
      // The closure is allocated only on the VAO-build (or no-VAO) path, never
      // on the steady-state frame.
      this.bindVaoOrSetup(c, () => this.bindTileAttributes(gl, h, c));
    }
    c.vaoVariant = this.mainVaoKey;

    this.instSupport.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count);
  }

  /**
   * Draw this icon tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)`. Mirrors {@link drawTile}'s projection
   * (including the v5+ prelude variant), sprite geometry and — critically — its
   * ALPHA GATES: the same time mode, the same DataFilter range and the same
   * sprite-alpha cutoff, so a feature the user cannot see is never pickable.
   *
   * In glide mode the drawn geometry is one instance per ENTITY rather than per
   * tile row, so the pass is delegated to {@link drawGlidePick}, which paints
   * only the entities whose representative snapshot belongs to THIS (tile,
   * layer) and leaves the rest at the reserved id 0 (discarded by the id FS).
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    if (!this.instSupport.enabled) return;
    if (!this.ensureAtlas(gl)) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const h = this.idHandlesFor(gl, frame);
    if (this.glideActive()) {
      this.drawGlidePick(gl, h, frame, tile, layer, ctx, idBase);
      return;
    }
    const c = cache as IconGpuCache;
    const count = c.vertexCount;
    if (count === 0) return;

    const idBuffer = this.uploadArrayBuffer(
      gl,
      this.buildPickIdColors(count, idBase),
    );

    gl.useProgram(h.program);
    this.setProjectionUniforms(gl, h, ctx, frame);
    gl.uniform3fv(h.uPosScale, c.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, c.posOffset ?? ZERO_POS_OFFSET);
    this.setStyleUniforms(
      gl,
      h,
      this.sizeScaleForTile(gl, tile, ctx),
      Boolean(c.iconBuffer) && h.aIconRect >= 0,
      Boolean(c.sizeBuffer) && h.aSize >= 0,
      Boolean(c.angleBuffer) && h.aAngle >= 0,
      Boolean(c.colorBuffer) && h.aColor >= 0,
    );
    this.setTimeUniforms(gl, h, c, ctx);
    this.setFilterUniforms(gl, h, c);

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass and
    // the id buffer is per-pass, so a cached VAO would just go stale.
    this.bindTileAttributes(gl, h, c);
    this.bindInstanced(gl, h.aIdColor, idBuffer, 3, gl.UNSIGNED_BYTE, true);

    this.instSupport.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count);

    this.releasePickAttributes(gl, h);
    gl.deleteBuffer(idBuffer);
  }

  /**
   * Leave the default-VAO attribute slate clean and every divisor back at 0, so
   * the next visual frame's VAO recording starts from a known state. Leave a
   * divisor at 1 and the next non-instanced draw on that slot reads one element
   * per INSTANCE instead of per vertex.
   */
  private releasePickAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconIdProgramHandles,
  ): void {
    const locs = [
      h.aCorner,
      h.aMercator,
      h.aTime,
      h.aSize,
      h.aAngle,
      h.aColor,
      h.aIconRect,
      h.aIconMeta,
      h.aFilterValue,
      h.aIdColor,
    ];
    for (const loc of locs) {
      if (loc < 0) continue;
      this.instSupport.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
  }

  // ── motion glide ─────────────────────────────────────────────────────────

  /**
   * Drop the pooled index. Called when the glide path is toggled and when the
   * layer is torn down. The COLUMNS feeding the index (`idProperty`,
   * `colorProperty`, `angleProperty`, `iconProperty`, `colorMapping`) are
   * constructor-only by design, which is what lets `sync()` stay incremental —
   * see the kernel's `TrackIndexMaintainer` invariant (4).
   */
  private resetGlideIndex(): void {
    this.glideMaintainer.reset();
    this.glideIndex = null;
    this.glideRows.clear();
    this.glideTiles.length = 0;
    this.glideTileKeys.length = 0;
    this.glideIndexStale = true;
    this.glideCount = 0;
    this.glideSampleTime = Number.NaN;
    this.glideUploadedTime = Number.NaN;
  }

  /** Which tile columns the kernel reads when pooling snapshots into tracks. */
  private glideFieldConfig(): TrackFieldConfig {
    const o = this.iconOpts;
    if (this.filterOpts.filterProperty) {
      // The glide program compiles NO DataFilter kernel (`buildIconVs` forces
      // `filter && !glide`) and the track kernel pools no filter column, so the
      // whole DataFilter surface is inert while gliding. deck's
      // AnimatedIconLayer degrades the same way; saying so once is the
      // difference between a documented degrade and a silent no-op.
      this.warnOnce(
        'glide-data-filter',
        `interpolate is on, so the CPU glide path owns this layer and the DataFilter ` +
          `('${this.filterOpts.filterProperty}') is NOT applied — every entity renders ` +
          'regardless of filterRange. Turn interpolate off to filter, or pre-filter the archive.',
      );
    }
    if (o.colorProperty && !o.colorMapping) {
      this.warnOnce(
        'glide-color-mapping',
        `interpolate is on with a categorical colour column ('${o.colorProperty}') but no ` +
          '`colorMapping` — the CPU glide path cannot use a per-tile positional palette, so ' +
          'every icon resolves to `colorMappingDefault`. Provide a colorMapping (category → ' +
          'colour) or a constant color for glide.',
      );
    }
    return {
      trackIdProperty: o.idProperty,
      colorProperty: o.colorProperty ?? '',
      // The sprite-selecting column rides `label`, so a per-entity icon is
      // resolved once at pooling time instead of per frame per track.
      labelProperty: o.iconProperty ?? '',
      // Heading is DEGREES here (deck getAngle parity) — see glideSampleConfig.
      headingProperty: o.angleProperty ?? '',
      lengthProperty: '',
      widthProperty: '',
      heightProperty: '',
      speedProperty: '',
      colorMapping: o.colorMapping,
      colorMappingDefault: o.colorMappingDefault ?? [0, 0, 0, 0],
    };
  }

  /**
   * Refresh {@link glideTiles} from the base's drawn set (the tileset's VISIBLE
   * tiles — see `STTBaseLayer.loadedTiles`), allocation-free when nothing
   * moved: the sizes and the per-slot tile IDENTITIES are compared in place,
   * and the arrays are only rebuilt when they actually differ. Both ownership
   * modes replace `loadedTiles` wholesale on a change, which the identity
   * compare absorbs — the Tile objects themselves are stable across a
   * re-derivation that did not actually move anything.
   */
  private refreshGlideTiles(): void {
    const loaded = this.loadedTiles;
    if (loaded.size === this.glideTiles.length) {
      let same = true;
      for (let i = 0; i < this.glideTileKeys.length; i++) {
        if (loaded.get(this.glideTileKeys[i]) !== this.glideTiles[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.glideTiles.length = 0;
    this.glideTileKeys.length = 0;
    for (const [key, tile] of loaded) {
      this.glideTileKeys.push(key);
      this.glideTiles.push(tile);
    }
    // Entries came or went: the row join is rebuilt lazily against the NEW set.
    this.glideRows.clear();
    this.glideIndexStale = true;
  }

  /**
   * Bring the pooled track index up to date with the resident tile set. The
   * maintainer re-pools only ADDED tiles and re-sorts only AFFECTED tracks, so a
   * sliding loader window costs O(changed tiles) instead of the O(all snapshots)
   * full rebuild — this is why the sync is gated on a tile-SET change and never
   * runs per frame.
   */
  private syncGlideIndex(): void {
    this.refreshGlideTiles();
    if (!this.glideIndexStale && this.glideIndex) return;
    const cfg = this.glideFieldConfig();
    const result = this.glideMaintainer.sync(this.glideTiles, cfg);
    this.glideIndex = result.tracks;
    if (result.trackIdMissing) {
      this.warnOnce(
        'glide-id-column',
        `interpolate is on but no '${cfg.trackIdProperty}' categorical column was found — ` +
          'each sample becomes its own held instance (no glide). Set idProperty to an ' +
          'EXACT per-entity id column.',
      );
    }
    this.glideIndexStale = false;
    // The pooled keyframes moved, so any sampled pose is stale.
    this.glideSampleTime = Number.NaN;
  }

  /**
   * `entityId → feature row` for ONE provenance entry, memoized until the
   * resident set moves. The first row wins: every snapshot of an entity in this
   * layer is an equally valid pick target, and the base joins the id back to
   * that row's own properties.
   *
   * Deliberately per-ENTRY and not a single first-seen table: an entity outlives
   * the tile it was first seen in, so a global table would leave a still-gliding
   * marker unpickable the moment that tile was evicted (and would grow for the
   * lifetime of the layer). Null when this layer has no id column at all.
   */
  private glideRowsFor(
    tile: Tile,
    layer: STTLayer,
  ): Map<string, number> | null {
    const key = entryKeyFor(tile, layer);
    const memo = this.glideRows.get(key);
    if (memo) return memo;
    const binary = layer.features;
    const col = binary.categoricalProps[this.iconOpts.idProperty];
    if (!col) return null;
    const rows = new Map<string, number>();
    for (let i = 0; i < binary.featureCount; i++) {
      const idx = col.indices[i];
      if (idx === 0xffff) continue;
      const id = col.categories[idx];
      if (id === undefined || rows.has(id)) continue;
      rows.set(id, i);
    }
    this.glideRows.set(key, rows);
    return rows;
  }

  /**
   * Force the next frame to re-interpolate (and re-upload) the glide instances.
   * Needed by every setter whose value is BAKED into them rather than read as a
   * uniform — a paused map would otherwise keep the old poses/colours/sprites.
   */
  private invalidateGlideSample(): void {
    this.glideSampleTime = Number.NaN;
  }

  /**
   * Grow the per-instance CPU buffers to hold `cap` tracks. Grow-only: the
   * pooled index shrinks as tiles are evicted, and re-allocating on every dip
   * would churn far more than the dead tail costs.
   *
   * The GPU stores are sized from the SAME capacity, so a growth marks them
   * stale — {@link uploadGlideInstances} re-specifies each buffer once and then
   * goes back to `bufferSubData` over the live prefix.
   */
  private ensureGlideCapacity(cap: number): void {
    if (cap <= this.glideCapacity) return;
    this.glidePositions = new Float32Array(cap * 3);
    this.glideAngles = new Float32Array(cap);
    this.glideColors = new Uint8Array(cap * 4);
    this.glideFrames = new Float32Array(cap * ICON_FRAME_STRIDE);
    this.glideTrackIds = new Array(cap);
    this.glideCapacity = cap;
    this.glideStoresSized = false;
  }

  /**
   * Interpolate one pose per ACTIVE track at `now` (absolute epoch ms) into the
   * reused instance buffers. Returns the active count.
   *
   * The buffers are filled from index 0 and only the first `glideCount`
   * instances are ever drawn or uploaded — see {@link uploadGlideInstances} for
   * why the TAIL never reaches the bus.
   */
  private sampleGlide(now: number): number {
    const index = this.glideIndex;
    if (!index) {
      this.glideCount = 0;
      return 0;
    }
    this.ensureGlideCapacity(index.size);
    const cfg = this.glideSampleConfig;
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    cfg.fadeInDuration = fadeIn;
    cfg.fadeOutDuration = fadeOut;
    cfg.maxGapMs = this.iconOpts.maxInterpolationGap;

    const o = this.iconOpts;
    const hasHeading = Boolean(o.angleProperty);
    const perTrackColor = Boolean(o.colorProperty);
    const perTrackIcon = Boolean(o.iconProperty);
    const mapping = o.iconMapping;
    const fallbackEntry = mapping?.[o.icon];
    // The constant tint in 0–255 bytes (`color` accepts either convention; the
    // 0–1 form is resolved once in setColor, not per frame).
    const tint = this.tintRgba01;
    const tr = Math.round(tint[0] * 255);
    const tg = Math.round(tint[1] * 255);
    const tb = Math.round(tint[2] * 255);
    const ta = Math.round(tint[3] * 255);

    const positions = this.glidePositions;
    const angles = this.glideAngles;
    const colors = this.glideColors;
    const frames = this.glideFrames;
    const ids = this.glideTrackIds;
    let w = 0;
    for (const track of index.values()) {
      const s = sampleTrack(track, now, cfg);
      if (!s) continue;
      const p3 = w * 3;
      // Allocation-free projection: this loop runs per ACTIVE track per frame,
      // and the tuple-returning `lngLatToMercator` would allocate one array per
      // track per frame (the same trap trip-heads' emit avoids).
      lngLatToMercatorInto(s.lon, s.lat, positions, p3);
      // Icons are 2d billboards: altitude never reaches the projection.
      positions[p3 + 2] = 0;
      angles[w] = hasHeading
        ? Number.isFinite(s.heading)
          ? s.heading
          : o.angle
        : (this.glideBearingDeg(track, s, now) ?? o.angle);
      const c4 = w * 4;
      if (perTrackColor) {
        const base = track.color;
        colors[c4] = base[0];
        colors[c4 + 1] = base[1];
        colors[c4 + 2] = base[2];
        colors[c4 + 3] = Math.round((base[3] ?? 255) * s.alpha);
      } else {
        colors[c4] = tr;
        colors[c4 + 1] = tg;
        colors[c4 + 2] = tb;
        colors[c4 + 3] = Math.round(ta * s.alpha);
      }
      if (perTrackIcon) {
        writeIconFrame(
          frames,
          w * ICON_FRAME_STRIDE,
          mapping?.[track.label] ?? fallbackEntry,
        );
      }
      ids[w] = track.trackId;
      w++;
    }
    this.glideCount = w;
    this.glideSampleTime = now;
    return w;
  }

  /**
   * Heading from the direction of travel, for archives with no heading column.
   * Samples a hair ahead (or behind, at the end of a track) and returns null
   * when the marker is not moving, so a held pose keeps its previous angle
   * instead of spinning to an arbitrary bearing. Mirrors the deck icon layer.
   */
  private glideBearingDeg(track: Track, s: Sample, now: number): number | null {
    const cfg = this.glideSampleConfig;
    let from: Sample = s;
    let to: Sample | null = sampleTrack(track, now + 1, cfg);
    if (!to) {
      const behind = sampleTrack(track, now - 1, cfg);
      if (!behind) return null;
      from = behind;
      to = s;
    }
    return bearingFromMotionDeg(from.lon, from.lat, to.lon, to.lat);
  }

  /**
   * Upload the LIVE PREFIX of one glide instance buffer, creating (and sizing)
   * the store on first use and after a capacity growth.
   *
   * `resize` re-specifies the whole store with `bufferData(target, byteLength,
   * usage)` — an allocation with no transfer — and every other frame writes
   * only `elements` values with `bufferSubData`. Uploading the CAPACITY-sized
   * array instead would push the entire dead tail across the bus every frame:
   * capacity is grow-only (a zoomed-out flights view pools ~100k tracks and
   * never shrinks), so a zoomed-in frame drawing 2k instances would still
   * transfer ~2 MB. The `subarray` view this allocates per attribute per frame
   * is the deliberate trade — the same shape `STTTripHeadsLayer.emitHeads`
   * uses.
   */
  private uploadGlideBuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    existing: WebGLBuffer | undefined,
    data: Float32Array | Uint8Array,
    elements: number,
    resize: boolean,
  ): WebGLBuffer | undefined {
    const buf = existing ?? gl.createBuffer() ?? undefined;
    if (!buf) return undefined;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    if (resize || !existing) {
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    }
    if (elements > 0) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, elements));
    }
    return buf;
  }

  /**
   * Push the freshly sampled poses to the GPU (one `bufferSubData` per
   * attribute, over the ACTIVE prefix only), memoized on the sample time so a
   * pick pass right after a frame — and each of its per-entry draws — reuses
   * what the frame already uploaded.
   */
  private uploadGlideInstances(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): boolean {
    const framesReady =
      !this.iconOpts.iconProperty || Boolean(this.glideFrameBuffer);
    if (
      this.glideUploadedTime === this.glideSampleTime &&
      this.glidePosBuffer &&
      this.glideAngleBuffer &&
      this.glideColorBuffer &&
      framesReady
    ) {
      return true;
    }
    const n = this.glideCount;
    // One re-specification per capacity growth, shared by all four stores.
    const resize = !this.glideStoresSized;
    this.glidePosBuffer = this.uploadGlideBuffer(
      gl,
      this.glidePosBuffer,
      this.glidePositions,
      n * 3,
      resize,
    );
    this.glideAngleBuffer = this.uploadGlideBuffer(
      gl,
      this.glideAngleBuffer,
      this.glideAngles,
      n,
      resize,
    );
    this.glideColorBuffer = this.uploadGlideBuffer(
      gl,
      this.glideColorBuffer,
      this.glideColors,
      n * 4,
      resize,
    );
    if (this.iconOpts.iconProperty) {
      this.glideFrameBuffer = this.uploadGlideBuffer(
        gl,
        this.glideFrameBuffer,
        this.glideFrames,
        n * ICON_FRAME_STRIDE,
        resize,
      );
    }
    const ok = Boolean(
      this.glidePosBuffer && this.glideAngleBuffer && this.glideColorBuffer,
    );
    this.glideStoresSized = ok;
    this.glideUploadedTime = ok ? this.glideSampleTime : Number.NaN;
    return ok;
  }

  /** Bind the merged glide instance attributes (no VAO — one draw per frame). */
  private bindGlideAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
  ): void {
    this.bindQuad(gl, h);
    // Glide positions are raw f32 mercator (the identity posScale/posOffset
    // below make `sttDecodeMercatorPos` a pass-through), so ONE program serves
    // both the quantized tile path and this one.
    this.bindInstanced(
      gl,
      h.aMercator,
      this.glidePosBuffer!,
      3,
      gl.FLOAT,
      false,
    );
    this.bindInstanced(
      gl,
      h.aAngle,
      this.glideAngleBuffer!,
      1,
      gl.FLOAT,
      false,
    );
    this.bindInstanced(
      gl,
      h.aColor,
      this.glideColorBuffer!,
      4,
      gl.UNSIGNED_BYTE,
      true,
    );
    if (this.glideFrameBuffer && h.aIconRect >= 0) {
      const stride = ICON_FRAME_STRIDE * 4;
      this.bindInstanced(
        gl,
        h.aIconRect,
        this.glideFrameBuffer,
        4,
        gl.FLOAT,
        false,
        stride,
        0,
      );
      if (h.aIconMeta >= 0) {
        this.bindInstanced(
          gl,
          h.aIconMeta,
          this.glideFrameBuffer,
          4,
          gl.FLOAT,
          false,
          stride,
          16,
        );
      }
    }
  }

  /** Uniforms shared by the glide visual and glide pick passes. */
  private setGlideUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    this.setProjectionUniforms(gl, h, ctx, frame);
    gl.uniform3fv(h.uPosScale, IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, ZERO_POS_OFFSET);
    this.setStyleUniforms(
      gl,
      h,
      this.sizeScaleForGlide(gl),
      Boolean(this.glideFrameBuffer) && h.aIconRect >= 0,
      // Glide draws one instance per ENTITY, and the kernel carries no size
      // column — a `sizeProperty` applies to the discrete path only.
      false,
      true,
      true,
    );
  }

  /**
   * Scratch DrawContext for the glide pass. The merged draw has no tile (and so
   * no `timeOffset`), and the glide program compiles no time kernel, so only
   * `matrix`/`frame` are ever read — refilled in place, never allocated.
   */
  private readonly glideCtx: DrawContext = {
    matrix: LEGACY_FRAME.matrix,
    frame: undefined,
    windowStart: 0,
    windowEnd: 0,
    currentTime: 0,
    zoom: 0,
  };

  /** The whole glide visual pass: sync → sample → upload → one instanced draw. */
  private drawGlide(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
  ): void {
    if (!this.instSupport.enabled) {
      this.warnOnce(
        'instancing',
        'runtime lacks ANGLE_instanced_arrays / WebGL2; STTIconLayer requires instancing',
      );
      return;
    }
    if (!this.ensureAtlas(gl)) return;
    this.syncGlideIndex();
    const now = this.opts.currentTime;
    if (this.glideSampleTime !== now) this.sampleGlide(now);
    if (this.glideCount === 0) return;
    if (!this.uploadGlideInstances(gl)) return;

    const ctx = this.glideCtx;
    ctx.matrix = frame.matrix;
    ctx.frame = frame;
    ctx.currentTime = now;
    ctx.zoom = Math.floor(this.frameZoom ?? 0);

    const h = this.mainHandlesFor(gl, frame);
    gl.useProgram(h.program);
    this.setGlideUniforms(gl, h, ctx, frame);
    this.bindGlideAttributes(gl, h);
    this.instSupport.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, this.glideCount);
    this.releaseGlideAttributes(gl, h, -1);
  }

  /**
   * Glide id pass for ONE provenance entry. Every active instance is drawn, but
   * only entities THIS (tile, layer) actually holds a snapshot of carry a real
   * id — the rest get the reserved id 0, which the id fragment shader discards,
   * so an entry's pass can never erase ids another entry already painted.
   *
   * An entity resident in several entries is painted by each of them, and the
   * last one drawn wins the pixel — every candidate is a genuine snapshot row of
   * that same entity, so whichever wins resolves to correct properties.
   */
  private drawGlidePick(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconIdProgramHandles,
    frame: HostFrame,
    tile: Tile,
    layer: STTLayer,
    ctx: DrawContext,
    idBase: number,
  ): void {
    this.syncGlideIndex();
    if (this.glideSampleTime !== ctx.currentTime) {
      this.sampleGlide(ctx.currentTime);
    }
    const count = this.glideCount;
    if (count === 0) return;
    const rows = this.glideRowsFor(tile, layer);
    if (!rows) return;
    if (!this.uploadGlideInstances(gl)) return;

    const idColors = new Uint8Array(count * 3); // zero-filled = "not this entry"
    let any = false;
    for (let i = 0; i < count; i++) {
      const row = rows.get(this.glideTrackIds[i]);
      if (row === undefined) continue;
      const [r, g, b] = encodePickId(idBase + row);
      idColors[i * 3] = r;
      idColors[i * 3 + 1] = g;
      idColors[i * 3 + 2] = b;
      any = true;
    }
    if (!any) return;
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    gl.useProgram(h.program);
    this.setGlideUniforms(gl, h, ctx, frame);
    this.bindGlideAttributes(gl, h);
    this.bindInstanced(gl, h.aIdColor, idBuffer, 3, gl.UNSIGNED_BYTE, true);
    this.instSupport.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count);
    this.releaseGlideAttributes(gl, h, h.aIdColor);
    gl.deleteBuffer(idBuffer);
  }

  /** Reset the divisors/enables the glide passes set (see releasePickAttributes). */
  private releaseGlideAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IconSharedHandles,
    idLoc: number,
  ): void {
    const locs = [
      h.aCorner,
      h.aMercator,
      h.aAngle,
      h.aColor,
      h.aIconRect,
      h.aIconMeta,
      idLoc,
    ];
    for (const loc of locs) {
      if (loc < 0) continue;
      this.instSupport.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
  }

  onRemove(): void {
    super.onRemove();
    this.resetGlideIndex();
  }
}
