/**
 * Point geometry adapter — renders POINT-type tiles as circular billboards.
 *
 * ── Feature surface ─────────────────────────────────────────────────────────
 * Three parity axes sit on top of the window-mode billboard, all OFF-shaped at
 * their defaults:
 *
 *  - `timeFilterMode` — window (default) / wake / cumulative / trail, each a
 *    kernel snippet from `shaders/time-window.glsl.ts`. The mode is chosen at
 *    PROGRAM-BUILD time (no mode uniform, no dynamic branch), so the cache key
 *    carries it; `getOrCreateProgram` only appends the host variant.
 *  - `filterProperty`/`filterRange`/… — the DataFilter kernel
 *    (`shaders/data-filter.glsl.ts`), compiled in only when `filterProperty`
 *    is set and multiplied into the same `vAlpha` the time filter writes.
 *  - `radiusUnits: 'meters'` — metric sizing via `lib/projection.ts`. Purely a
 *    CPU-side scale folded into `uRadiusScale`; the shader is unchanged, so
 *    metric sizing costs no extra program variant.
 *
 * Every gate lands in the id-pick program too (same snippets, same uniforms):
 * a feature that is time-filtered, hard-filtered or shrunk to nothing must not
 * be pickable.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_CATEGORICAL_PALETTE } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
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
import {
  discMaskGLSL,
  DISC_EDGE_EXPR,
  buildBillboardIdFragmentSource,
} from '../shaders/billboard.glsl.js';
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

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's own name.
 */
export type PointTimeFilterMode = STTTimeFilterMode;

export interface STTPointLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Point color as `[r, g, b, a]`. Accepts EITHER 0–255 ints (the deck.gl
   * `Color` convention, and what `colorPalette` uses) OR 0–1 floats — the
   * range is auto-detected. Ignored when `colorProperty` is set.
   */
  color?: [number, number, number, number];
  /**
   * Point radius, in {@link radiusUnits}. Clamped to the GPU `gl_PointSize`
   * range at draw time.
   */
  radius?: number;
  /**
   * Unit `radius` (and a `radiusProperty` column) is expressed in. `'pixels'`
   * (default) is screen-space: one radius, same size
   * at every zoom. `'meters'` is ground-metric (deck's `radiusUnits`): the
   * radius is converted per tile at the tile centre's latitude and the map's
   * current zoom, so a point covers a fixed patch of ground and grows as you
   * zoom in. Screen-space caveat under pitch: see `metersToPixelsAtLatitude`.
   */
  radiusUnits?: 'pixels' | 'meters';
  /**
   * Drive per-feature colour from a categorical property name (looked up in
   * `binary.categoricalProps[colorProperty]`). The palette is sampled by the
   * category index. Falls back to the constant `color` if the property is
   * absent from a tile.
   */
  colorProperty?: string;
  /**
   * Colour palette used when `colorProperty` is set, expressed as 0–255 RGBA
   * tuples (matches the deck.gl adapter). Defaults to a 10-colour categorical
   * palette.
   */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA color map (deck/three `colorMapping`
   * parity). When set, `colorProperty`'s category NAME is looked up here so a
   * category renders the same color in every tile regardless of per-tile
   * dictionary order — avoiding the positional `colorPalette` reorder hazard.
   * Unmapped categories fall back to {@link colorMappingDefault}, then to the
   * positional `colorPalette`.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Color for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /**
   * Drive per-feature radius (in {@link radiusUnits}) from a numeric property.
   * Falls back to the constant `radius` if the property is absent.
   */
  radiusProperty?: string;
  /** Optional radius scale multiplier applied to property-driven radii. */
  radiusScale?: number;
  /**
   * Which temporal alpha the shader computes. Unset ⇒ inferred from the knobs
   * in deck's precedence order (`TimeFilterExtension` `vs:#main-start`):
   * `wakeLength > 0` selects wake, otherwise window. Set it explicitly to pin
   * a mode. `'wake'`/`'trail'` degrade to `'window'` when their length knob is
   * non-positive (a zero-length wake would light nothing).
   *
   * `'cumulative'` carries a CALLER OBLIGATION (deck's `TimeFilterExtension`
   * states the same one): the shader does the progressive reveal, the loader
   * does not, so already-revealed tiles must stay resident. The tileset selects
   * `[currentTime ± timeWindow/2]` and evicts behind it, so a `timeWindow`
   * narrower than the played-through range makes the layer UN-draw itself as
   * playback advances. Set `timeWindow` wide enough to cover the whole range
   * you intend to accumulate.
   *
   * The mode is compiled into the shader, so flipping it at runtime
   * ({@link STTPointLayer.setTimeFilterMode}) links a second program.
   */
  timeFilterMode?: PointTimeFilterMode;
  /**
   * Wake mode: a feature is lit only for this many ms AFTER its own
   * `startTime`, alpha fading linearly to 0 and its radius shrinking toward
   * `wakeTailScale` at the tail. Defaults to 0 (no wake).
   *
   * The tile loader must span the past half of the wake for it to be visible
   * at all — pass `timeWindow >= 2 * wakeLength` (same caller obligation as
   * deck's `AnimatedPointLayer`).
   */
  wakeLength?: number;
  /**
   * Wake mode trailing-edge radius multiplier (head = 1.0). Defaults to core's
   * `DEFAULT_WAKE_TAIL_SCALE` (0.15).
   */
  wakeTailScale?: number;
  /**
   * Trail mode: a feature is lit while its `startTime` lies within this many ms
   * behind `currentTime`. A point IS its own single vertex, so the per-vertex
   * trail kernel reads `aTime.x` — for a point layer trail is therefore a
   * "solid or fading tail of recent events", not a swept polyline (that is
   * {@link STTTripsLayer}). Defaults to 0, which degrades trail mode to window.
   */
  trailLength?: number;
  /**
   * Trail mode head→tail fade: `1`/`true` (default) fades across
   * `trailLength`, `0`/`false` keeps every lit feature at full alpha (snake
   * mode), and intermediate numbers blend between them. Package-wide
   * convention (`resolveTrailFade`), shared with every other STT layer.
   */
  fadeTrail?: boolean | number;
}

// Shared with the deck.gl adapter (single source of truth in
// @poopdeck.gl/core) so both backends paint identical default colours.
const DEFAULT_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_CATEGORICAL_PALETTE;

// Immutable stand-in for callers with no host frame: onContextReady's eager
// legacy link and hand-built test DrawContexts that omit `frame`. Never
// mutated (only normalizeRenderArgs mutates frames, and it never sees this one).
const LEGACY_FRAME: HostFrame = createHostFrame();

// Hoisted uniform fallbacks — a layer whose position buffer skipped
// quantization would otherwise allocate these every draw.
const IDENTITY_POS_SCALE: readonly number[] = [1, 1, 1];
const ZERO_POS_OFFSET: readonly number[] = [0, 0, 0];

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled point program supports. Both knobs are structural (they add
 * uniforms/attributes/statements), so each combination is its own program and
 * each must appear in the program-cache key — {@link pointProgramKey}.
 */
export interface PointShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: PointTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
}

/** The OFF shape: window mode, no column filter. */
const DEFAULT_SHADER_CONFIG: PointShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<PointTimeFilterMode, string>> = Object.freeze({
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
});

/**
 * Uniforms each mode reads. The billboard tapers in wake mode, so this is the
 * record carrying `uWakeTailScale`.
 */
const MODE_UNIFORMS = TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE;

/** The `vAlpha = …` expression per mode. */
const MODE_ALPHA: Readonly<Record<PointTimeFilterMode, string>> = Object.freeze(
  {
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    // A point is a single vertex, so its "vertex time" is its own start time.
    trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
  },
);

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * DataFilter application, shared by the visual and id passes. Deck's split:
 * a HARD-filtered feature (`0`) is hidden whatever the transform flags say,
 * while a soft-margin value only fades / shrinks when its flag is on
 * (`DECKGL_FILTER_COLOR` / `DECKGL_FILTER_SIZE`).
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) {
      radiusPx *= filterAlpha;
    }
`;

/**
 * Assemble a point vertex shader.
 *
 * Legacy hosts (empty prelude) keep the `uMatrix` path verbatim; v5+ hosts get
 * the injected prelude + define prepended (maplibre's documented order) with
 * projection routed through the prelude's `projectTile` — billboards are 2d
 * content, so `projectTile`'s z overwrite (horizon clipping) is exactly right;
 * real 3D content would need `projectTileFor3D`. Single-vertex geometry needs
 * no globe edge subdivision, and STT tiles are world-absolute (no wrap copies
 * to skip).
 *
 * `vAlpha` is computed BEFORE the radius so wake mode's tail shrink and the
 * DataFilter size transform can both read it — deck's `vs:#main-start` →
 * `DECKGL_FILTER_SIZE` ordering. Nothing else depends on the move (window mode
 * emits the identical statements it always did).
 *
 * A fully-gated feature is dropped by the fragment shader's
 * `if (vAlpha <= 0.0) discard;`, NOT by the kernel's suggested
 * `gl_Position = vec4(0.0)` collapse: with `w == 0` a POINT primitive has no
 * defined NDC position, so collapsing could paint a stray disc. The discard is
 * the same gate the time filter has always used here.
 */
function buildPointVs(
  shader: ShaderInjection,
  cfg: PointShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  const projection = usesPrelude
    ? '    gl_Position = projectTile(mercator.xy);'
    : isMain
      ? '    vec4 pos = uMatrix * vec4(mercator.x, mercator.y, mercator.z * uAltitudeScale, 1.0);\n    gl_Position = pos;'
      : '    gl_Position = uMatrix * vec4(mercator.x, mercator.y, mercator.z * uAltitudeScale, 1.0);';
  const payloadAttribute = isMain
    ? '  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)\n'
    : '  attribute vec3 aIdColor;     // per-feature encoded id (UNSIGNED_BYTE normalized)\n';
  const legacyUniforms = usesPrelude
    ? ''
    : '  uniform mat4 uMatrix;\n  uniform float uAltitudeScale;\n';
  const colorUniforms = isMain
    ? '  uniform float uUseFeatureColor;\n  uniform vec4 uColor;\n'
    : '';
  const payloadVarying = isMain
    ? '  varying vec4 vColor;\n'
    : '  varying vec3 vIdColor;\n';
  const wakeSize =
    cfg.mode === 'wake'
      ? '    radiusPx *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';
  const payloadAssign = isMain
    ? '    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;\n'
    : '    vIdColor = aIdColor;\n';

  return `${head}
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
${payloadAttribute}  attribute float aRadius;     // per-feature radius in radiusUnits (when uUseFeatureRadius=1)
${cfg.filter ? FILTER_ATTRIBUTE : ''}${legacyUniforms}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
${colorUniforms}${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${payloadVarying}${MODE_GLSL[cfg.mode]}${POSITION_DEQUANT_GLSL}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
${projection}
    vAlpha = ${MODE_ALPHA[cfg.mode]};
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
${wakeSize}${cfg.filter ? FILTER_BODY : ''}    gl_PointSize = radiusPx * 2.0;
${payloadAssign}  }
`;
}

/** Visual vertex source for a host shader variant + feature configuration. */
export function buildPointVertexSource(
  shader: ShaderInjection,
  cfg: PointShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildPointVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildPointVertexSource}. */
export function buildPointIdVertexSource(
  shader: ShaderInjection,
  cfg: PointShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildPointVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `getOrCreateProgram` appends `::${variantName}` (the HOST variant) only, so
 * two configurations sharing a base key would collide on one program.
 */
export function pointProgramKey(
  pass: 'main' | 'pick',
  cfg: PointShaderConfig,
): string {
  return `point:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is
 * unset and the "a degenerate length lights nothing" guard when it is set.
 * Exported for the prop-default tests.
 */
export function resolvePointTimeFilterMode(
  mode: PointTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): PointTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  // Unset: infer from the knobs, deck's TimeFilterExtension precedence.
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  void main() {
    if (vAlpha <= 0.0) discard;
${discMaskGLSL()}    // Antialiased disc: soften the last ~10% of the radius.
    float edge = ${DISC_EDGE_EXPR};
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha * edge);
  }
`;

// ── id-buffer picking variant (browser-verify-only) ─────────────────────────
// The id vertex source is the same builder with `kind: 'id'`: same projection,
// same billboard sizing (including the wake tail shrink and the DataFilter
// size transform) and the same alpha gates as the visual pass, but each
// feature paints its flat opaque `encodePickId` colour so a readback recovers
// the feature index. The disc mask below matches the visual FS so only the
// visible circle is pickable (no square hit box); no antialiased edge — a
// partially-covered edge texel must still decode to the exact id byte triple.
const ID_FS_SOURCE = buildBillboardIdFragmentSource('points');

/**
 * Locations every point program shares — the geometry, sizing, time-filter and
 * DataFilter surface. Resolved once per program; absent uniforms come back
 * null (a no-op for `gl.uniform*`) and absent attributes come back -1, which
 * is exactly how a mode/filter combination that doesn't declare them reads.
 */
interface PointSharedHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aMercator: number;
  aTime: number;
  aRadius: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uAltitudeScale: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uRadiusScale: WebGLUniformLocation | null;
  uUseFeatureRadius: WebGLUniformLocation | null;
}

interface PointIdProgramHandles extends PointSharedHandles {
  aIdColor: number;
}

interface PointProgramHandles extends PointSharedHandles {
  aColor: number;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/** Per-feature attribute buffers held alongside the standard TileGpuCache. */
interface PointGpuCache extends TileGpuCache {
  colorBuffer?: WebGLBuffer;
  radiusBuffer?: WebGLBuffer;
  /** Per-feature DataFilter column; absent when the tile didn't bake it. */
  filterBuffer?: WebGLBuffer;
  /** Whether this tile supplies the filter column (the `enabled` gate). */
  hasFilterColumn?: boolean;
  /**
   * Program the cached VAO's attribute locations were recorded against, as
   * `${programKey}::${variantName}`. A VAO stores attribute SLOTS, which are
   * per-program — when the host flips variants (mercator ⇄ globe) or the layer
   * flips time-filter modes, the relinked program may assign different slots,
   * so the VAO must be rebuilt against it.
   */
  vaoVariant?: string;
}

/**
 * MapLibre custom layer that renders STT point tiles.
 *
 * ```ts
 * const layer = new STTPointLayer({
 *   id: 'eq',
 *   url: '/data/earthquakes.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 60_000,
 *   color: [0.99, 0.5, 0.2, 1.0],
 *   radius: 5,
 * });
 * map.addLayer(layer);
 * setInterval(() => layer.setCurrentTime(Date.now()), 16);
 * ```
 */
export class STTPointLayer extends STTFilterableLayer {
  private pointOpts: {
    color: [number, number, number, number];
    radius: number;
    radiusScale: number;
    radiusUnits: 'pixels' | 'meters';
    colorProperty?: string;
    radiusProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    timeFilterMode?: PointTimeFilterMode;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };
  /** Compiled feature configuration; drives the program-cache keys. */
  private shaderConfig: PointShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /** `${mainKey}::${variantName}` — the tile-VAO staleness key, built on variant flips only. */
  private mainVaoKey = '';
  /**
   * Handles of the most recently used variant (legacy seeded eagerly in
   * onContextReady), memoized per `*Variant` so the per-tile hot path skips
   * the base cache's key-string build; the cache is only consulted on a
   * variant flip. Cleared together in onContextLost.
   */
  private handles?: PointProgramHandles;
  private handlesVariant?: string;
  private idHandles?: PointIdProgramHandles;
  private idHandlesVariant?: string;

  constructor(opts: STTPointLayerOptions) {
    super(opts);
    this.pointOpts = {
      color: opts.color ?? [0.31, 0.76, 0.97, 1.0],
      radius: opts.radius ?? 4,
      radiusScale: opts.radiusScale ?? 1,
      radiusUnits: opts.radiusUnits ?? 'pixels',
      colorProperty: opts.colorProperty,
      radiusProperty: opts.radiusProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      timeFilterMode: opts.timeFilterMode,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.shaderConfig = {
      mode: this.resolveMode(),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
    };
    this.mainKey = pointProgramKey('main', this.shaderConfig);
    this.pickKey = pointProgramKey('pick', this.shaderConfig);
  }

  private resolveMode(): PointTimeFilterMode {
    return resolvePointTimeFilterMode(
      this.pointOpts.timeFilterMode,
      this.pointOpts.wakeLength,
      this.pointOpts.trailLength,
    );
  }

  /** Update the point colour at runtime. */
  setColor(color: [number, number, number, number]): void {
    this.pointOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Update the point radius (in `radiusUnits`) at runtime. */
  setRadius(radius: number): void {
    this.pointOpts.radius = radius;
    this.map?.triggerRepaint();
  }

  /**
   * Switch time-filter mode at runtime. The mode is compiled in, so this links
   * a second program on the next frame (cached from then on) and re-records
   * every tile VAO against it — cheap enough for a UI toggle, not for a
   * per-frame animation.
   */
  setTimeFilterMode(mode: PointTimeFilterMode): void {
    this.pointOpts.timeFilterMode = mode;
    this.applyShaderConfig();
  }

  /** Update the wake length (ms) — selects wake mode when it goes positive. */
  setWakeLength(wakeLength: number): void {
    this.pointOpts.wakeLength = wakeLength;
    this.applyShaderConfig();
  }

  /** Update the trail length (ms) — selects trail mode when it goes positive. */
  setTrailLength(trailLength: number): void {
    this.pointOpts.trailLength = trailLength;
    this.applyShaderConfig();
  }

  /**
   * Recompute the compiled configuration after a mode knob moved, dropping the
   * memoized handles so the next draw resolves (and links, once) the program
   * for the new key. Tile VAOs carry the key in `vaoVariant` and rebuild
   * themselves on the same draw.
   */
  private applyShaderConfig(): void {
    const mode = this.resolveMode();
    if (mode === this.shaderConfig.mode) {
      this.map?.triggerRepaint();
      return;
    }
    this.shaderConfig = { ...this.shaderConfig, mode };
    this.mainKey = pointProgramKey('main', this.shaderConfig);
    this.pickKey = pointProgramKey('pick', this.shaderConfig);
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  /** Resolve the locations every point program declares. */
  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): PointSharedHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aRadius: gl.getAttribLocation(program, 'aRadius'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uAltitudeScale: gl.getUniformLocation(program, 'uAltitudeScale'),
      uRadius: gl.getUniformLocation(program, 'uRadius'),
      uRadiusScale: gl.getUniformLocation(program, 'uRadiusScale'),
      uUseFeatureRadius: gl.getUniformLocation(program, 'uUseFeatureRadius'),
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
  ): PointProgramHandles {
    const program = this.linkProgram(
      gl,
      buildPointVertexSource(shader, this.shaderConfig),
      FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aColor: gl.getAttribLocation(program, 'aColor'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
    };
  }

  /** Link the id-pick program for a variant and resolve its locations. */
  private buildIdHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): PointIdProgramHandles {
    const program = this.linkProgram(
      gl,
      buildPointIdVertexSource(shader, this.shaderConfig),
      ID_FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
    };
  }

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Eagerly link the legacy variants (what a ≤v4 host uses from its first
    // frame; a v5 host links its own variant lazily through the base
    // per-variant program cache on first draw, then reuses it). The id
    // program is compiled up-front alongside the visual one so the first
    // `pick()` doesn't stall; it's a tiny flat-colour shader.
    this.handles = this.getOrCreateProgram(
      gl,
      this.mainKey,
      LEGACY_FRAME,
      (g, s) => this.buildMainHandles(g, s),
    );
    this.handlesVariant = LEGACY_FRAME.shader.variantName;
    this.idHandles = this.getOrCreateProgram(
      gl,
      this.pickKey,
      LEGACY_FRAME,
      (g, s) => this.buildIdHandles(g, s),
    );
    this.idHandlesVariant = LEGACY_FRAME.shader.variantName;
  }

  /**
   * Build the per-tile cache. Adds optional per-feature colour / radius /
   * DataFilter attribute buffers when `colorProperty` / `radiusProperty` /
   * `filterProperty` are set and the named property exists in the binary tile.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): PointGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, _tile, layer);
    if (!baseCache) return null;
    const cache: PointGpuCache = baseCache as PointGpuCache;
    const f = layer.features;
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];

    if (this.pointOpts.colorProperty) {
      const colors = this.expandCategoricalColors(
        f,
        this.pointOpts.colorProperty,
        this.pointOpts.colorPalette,
        this.pointOpts.colorMapping,
        this.pointOpts.colorMappingDefault,
      );
      if (colors) {
        cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
        extras.push(cache.colorBuffer);
      }
    }

    if (this.pointOpts.radiusProperty) {
      const radii = this.getNumericProperty(f, this.pointOpts.radiusProperty);
      if (radii) {
        cache.radiusBuffer = this.uploadArrayBuffer(gl, radii);
        extras.push(cache.radiusBuffer);
      }
    }

    if (this.shaderConfig.filter) {
      // One point == one instance, so the per-FEATURE column binds directly
      // (no expandFilterValues, which is for segment/vertex instancing).
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

  protected onContextLost(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Program lifetimes are owned by the base per-variant cache (deleted on
    // dispose, dropped on context loss — both before this hook runs); only
    // the handle references are ours to clear.
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /**
   * The `uRadiusScale` value for this tile. In `'pixels'` mode it is the plain
   * `radiusScale` multiplier. In `'meters'` mode the
   * metres→device-pixels factor at the TILE CENTRE's latitude and the map's
   * FRACTIONAL zoom is folded in, so both the constant `radius` and a
   * `radiusProperty` column are read as ground metres and the size changes
   * continuously rather than stepping at integer zooms.
   */
  private resolveRadiusScale(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const scale = this.pointOpts.radiusScale;
    if (this.pointOpts.radiusUnits !== 'meters') return scale;
    // Shared base helper: fractional zoom + device-pixel ratio + the tile's
    // centre latitude, resolved once per tile (see `metricPixelScale`).
    return scale * this.metricPixelScale(gl, tile, ctx);
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active
   * mode's uniforms exist in the program, so the switch is also what keeps a
   * stale mode's uniform from being written to a null location every draw.
   * `uCurrentTime` follows the trips-layer convention: absolute time minus the
   * tile's own `timeOffset`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: PointSharedHandles,
    cache: PointGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.pointOpts;
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
   * Projection + sizing + time + filter uniforms — everything the visual and
   * id passes set identically, so the pickable disc always matches the drawn
   * one (including on globe, where the prelude owns projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: PointSharedHandles,
    tile: Tile,
    cache: PointGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude's projectTile owns projection.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
      gl.uniform1f(h.uAltitudeScale, 0); // 2D points; altitudes are ignored.
    }
    gl.uniform3fv(h.uPosScale, cache.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, cache.posOffset ?? ZERO_POS_OFFSET);
    gl.uniform1f(h.uRadius, this.pointOpts.radius);
    gl.uniform1f(h.uRadiusScale, this.resolveRadiusScale(gl, tile, ctx));
    this.setTimeUniforms(gl, h, cache, ctx);
    // A tile that didn't bake the column resolves to `enabled: 0`, which the
    // kernel reads as "render everything" — never as "hide everything".
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn === true);
    }
    // useFeature* uniforms are program-level, not VAO-recorded; set them every
    // draw so toggling radiusProperty at runtime takes effect.
    gl.uniform1f(
      h.uUseFeatureRadius,
      cache.radiusBuffer && h.aRadius >= 0 ? 1 : 0,
    );
  }

  /** Bind the geometry/time/filter attributes both passes share. */
  private bindSharedAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: PointSharedHandles,
    cache: PointGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 3, gl.UNSIGNED_SHORT, true, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

    if (cache.radiusBuffer && h.aRadius >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.radiusBuffer);
      gl.enableVertexAttribArray(h.aRadius);
      gl.vertexAttribPointer(h.aRadius, 1, gl.FLOAT, false, 0, 0);
    }
    if (cache.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
    }
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    let h = this.handles;
    if (!h || this.handlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.mainKey, frame, (g, s) =>
        this.buildMainHandles(g, s),
      );
      this.handles = h;
      this.handlesVariant = variant;
      // `mainKey` and `variant` are the only two inputs, and `applyShaderConfig`
      // clears `handlesVariant` whenever `mainKey` moves — so this branch is the
      // exact set of frames where the key can change. Never rebuilt per tile.
      this.mainVaoKey = `${this.mainKey}::${variant}`;
    }
    const c = cache as PointGpuCache;

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);
    gl.uniform4fv(h.uColor, this.rgba01Uniform('Color', this.pointOpts.color));
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);

    // A VAO records attribute locations against ONE program — drop it when the
    // host flipped shader variants, or the layer flipped time-filter mode, so
    // it re-records against `h`.
    const vaoKey = this.mainVaoKey;
    if (c.vao && c.vaoVariant !== vaoKey) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }

    // First-frame VAO setup: capture every attribute binding. Subsequent
    // frames just `bindVertexArray` and reuse all the state we recorded.
    this.bindVaoOrSetup(c, () => {
      this.bindSharedAttributes(gl, h!, c);
      if (c.colorBuffer && h!.aColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
        gl.enableVertexAttribArray(h!.aColor);
        gl.vertexAttribPointer(h!.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      }
    });
    c.vaoVariant = vaoKey;

    gl.drawArrays(gl.POINTS, 0, cache.vertexCount);
  }

  /**
   * Draw this point tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)`. Mirrors {@link drawTile}'s projection
   * (including the v5+ prelude variant, resolved from the same host frame),
   * billboard sizing and — critically — its ALPHA GATES: the same time-filter
   * mode and the same DataFilter range, so a feature the user cannot see is
   * never pickable. Browser-verify-only (the enclosing FBO round-trip needs a
   * live GPU); the id-colour build + decode join are unit-tested in the base.
   *
   * The per-feature id-colour buffer is rebuilt each pick and freed immediately:
   * `idBase` shifts with whatever tiles are loaded this frame, and picks are
   * rare user-initiated events, so a persistent per-tile buffer would be stale
   * cache for no win.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    let h = this.idHandles;
    if (!h || this.idHandlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.pickKey, frame, (g, s) =>
        this.buildIdHandles(g, s),
      );
      this.idHandles = h;
      this.idHandlesVariant = variant;
    }
    const c = cache as PointGpuCache;
    // One point == one feature, so vertexCount is the feature count here.
    const count = cache.vertexCount;
    const idColors = this.buildPickIdColors(count, idBase);
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass, and
    // the temp id buffer is per-pass, so a cached VAO would just go stale.
    this.bindSharedAttributes(gl, h, c);

    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawArrays(gl.POINTS, 0, count);

    // Leave the default-VAO attribute slate clean so the next visual frame's
    // VAO setup starts fresh, and drop the one-shot id buffer.
    gl.disableVertexAttribArray(h.aMercator);
    gl.disableVertexAttribArray(h.aTime);
    gl.disableVertexAttribArray(h.aIdColor);
    if (c.radiusBuffer && h.aRadius >= 0) {
      gl.disableVertexAttribArray(h.aRadius);
    }
    if (c.filterBuffer && h.aFilterValue >= 0) {
      gl.disableVertexAttribArray(h.aFilterValue);
    }
    gl.deleteBuffer(idBuffer);
  }
}
