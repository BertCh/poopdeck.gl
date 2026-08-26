// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Point-cloud adapter — LIT 3D points that stand off the ground plane.
 *
 * ── Why this kind exists at all ─────────────────────────────────────────────
 * Until now `pointCloud` DEGRADED to `point`, and the thing it lost in the
 * degradation is the entire reason the kind is separate: a point cloud carries
 * a per-point ELEVATION. Rendered through the point layer, a LiDAR sweep, a
 * radar volume or a surfel scene collapses onto the ground plane as a mat of
 * flat billboards — the tunnel and the bridge above it land on the same pixel,
 * and the cloud reads as a smear rather than as an object. This layer raises
 * every point to its own height, depth-resolves the result
 * (`renderingMode: '3d'`), and shades it so the volume is legible.
 *
 * ── Elevation ───────────────────────────────────────────────────────────────
 * One `aElevation` attribute, in METRES, resolved ONCE on the CPU at tile
 * upload from the first source that exists, so the shader has no source branch:
 *
 *   1. `elevationProperty` — a numeric per-feature column (metres).
 *   2. the geometry's own third dimension, when the tile bakes 3D positions
 *      (`positionDimensions === 3`) and {@link STTPointCloudLayerOptions.useGeometryElevation}
 *      is left on. This is the common case: `stt-build` puts altitude there.
 *   3. the constant `elevation`.
 *
 * Projection goes through `buildElevatedProjection`
 * (`shaders/globe-elevation.glsl.ts`) and NOT through a hand-rolled
 * `uMatrix * vec4(xy, elev * k, 1.0)`. That is not stylistic: the elevation
 * UNIT is host-variant dependent (mercator-z on legacy and on the v5 MERCATOR
 * prelude, METRES on the v5 GLOBE prelude), `projectTileFor3D` deliberately
 * preserves z on globe and so drops the horizon clip that elevated geometry
 * needs, and the globe↔mercator transition needs BOTH units at once. A
 * hand-rolled multiply compiles, renders correctly on the flat map, and is a
 * silent back-hemisphere bleed on the globe that no test in this repo can see.
 *
 * ── Lighting ────────────────────────────────────────────────────────────────
 * A self-contained directional + ambient term in the FRAGMENT stage — no deck,
 * no luma, no `lighting-phong` module (this package's zero-deck rule is
 * absolute). The formula is deck's `PointCloudLayer` default shading ported by
 * hand: material `ambient: 0.35`, `diffuse: 0.6` (deck's `DEFAULT_MATERIAL`)
 * lit by the first of deck's two default directional lights,
 * `direction: [-1, -3, -1]`, `intensity: 1.0`
 * (`@deck.gl/core/lib/lighting/lighting-effect.ts`). Specular is deliberately
 * NOT ported — deck's default specular colour is `[30,30,30]` on a shininess-32
 * lobe, which on a 2-pixel sprite is a sub-pixel highlight nobody will ever
 * see, and it would cost the fragment stage a `pow` per point per frame.
 *
 * The normal comes from one of two places:
 *  - `normalProperty` — an interleaved `FixedSizeList<Float32,3>` vector
 *    column, the shape `stt-build` bakes surfel normals into. Interpreted in
 *    the same frame as `lightDirection`: +x east, +y north, +z up.
 *  - ABSENT — the fragment stage synthesizes a SPHERE-IMPOSTER normal from
 *    `gl_PointCoord`, so each sprite shades as a tiny ball rather than as a
 *    flat chip. That fallback is necessarily in VIEW space (there is no view
 *    matrix on the prelude path to rotate it out of), which means the light
 *    appears camera-fixed on a normal-less cloud. That is the honest trade: a
 *    cloud with no normals has no world-frame surface orientation to shade
 *    against, and camera-fixed shading still separates the near and far faces
 *    of a volume, which is the whole point.
 *
 * ── Colour, and why the categorical path is MULTIPLIED ──────────────────────
 * Four colour sources, in priority order — and every one of them lands in the
 * SAME `aColor`/`uColor` RGBA8 slot, resolved on the CPU at tile upload:
 *
 *   1. `colorProperty` naming an interleaved RGBA vector column
 *      (`vectorProps`, `FixedSizeList<UInt8|Float32, 3|4>`) — the zero-copy
 *      path a real scanner's colour ships in.
 *   2. `colorProperties: [r, g, b]` — three numeric 0–255 columns.
 *   3. `colorProperty` naming a categorical column — palette / `colorMapping`.
 *   4. the constant `color`.
 *
 * Collapsing all four into one attribute is what makes the layer's central
 * correctness rule structural rather than a convention someone has to
 * remember: the fragment stage computes the lighting term and then writes
 * `vColor.rgb * light`. There is no code path on which a colour REPLACES the
 * shaded result after lighting, because there is no second colour path at all.
 * That mistake — "classification colours look wrong, let me just assign them
 * straight to gl_FragColor" — is exactly why deck refuses its
 * `CategoryColorExtension` on `PointCloudLayer`: a categorical cloud painted
 * flat loses every depth cue the elevation was carried for, and looks like a
 * sticker rather than a volume. Here the categorical path is a palette lookup
 * into the same buffer the RGBA path fills, so it is lit like everything else.
 *
 * ── What this layer deliberately does NOT do ────────────────────────────────
 *  - **No specular / no material surface.** See above.
 *  - **No sphere geometry.** Points are `gl.POINTS` sprites with a disc mask
 *    (`shaders/billboard.glsl.ts`), not instanced quads or icosahedra. A real
 *    cloud is 10⁵–10⁷ points per tile; one vertex each is the only budget that
 *    works, and the imposter normal recovers most of the roundness anyway.
 *  - **No EDL / screen-space ambient occlusion.** Potree-style eye-dome
 *    lighting needs a depth prepass and a second full-screen pass; this package
 *    has no offscreen accumulation machinery outside the hexbin layer, and a
 *    custom layer cannot see the host's depth buffer.
 *  - **No LOD or point-budget thinning.** The tileset already owns zoom
 *    selection; thinning inside a tile is a project-wide non-goal.
 *  - **No normal recomputation.** If `normalProperty` is missing the imposter
 *    fallback runs; the layer never estimates normals from neighbours (that is
 *    build-time work, and it needs the whole neighbourhood, not one tile).
 *
 * Every alpha gate here — the time filter, the DataFilter, the disc mask —
 * lands in the id-pick program too, from the SAME source builder. A point the
 * user cannot see is never pickable.
 */

import type {
  BinaryFeatures,
  Tile,
  STTTileLayer as STTLayer,
} from '@poopdeck.gl/core';
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
  mercatorZFromAltitude,
  tileCenterLatitude,
} from '../lib/projection.js';
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
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
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
export type PointCloudTimeFilterMode = STTTimeFilterMode;

/**
 * deck's `DEFAULT_MATERIAL.ambient` — the fraction of a point's own colour that
 * survives with no light reaching it. Ported, not imported (zero-deck rule).
 */
export const DEFAULT_AMBIENT = 0.35;

/** deck's `DEFAULT_MATERIAL.diffuse` — the Lambertian coefficient. */
export const DEFAULT_DIFFUSE = 0.6;

/**
 * deck's first default directional light direction, `[-1, -3, -1]`
 * (`lighting-effect.ts`), pre-normalized: the direction light TRAVELS, in the
 * layer's shading frame (+x east, +y north, +z up).
 */
export const DEFAULT_LIGHT_DIRECTION: readonly [number, number, number] =
  normalize3([-1, -3, -1]);

export interface STTPointCloudLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Constant point colour as `[r, g, b, a]`. Accepts EITHER 0–255 ints (deck's
   * `Color` convention, and what `colorPalette` uses) OR 0–1 floats — the range
   * is auto-detected. Used when no per-point colour source resolves.
   */
  color?: [number, number, number, number];
  /**
   * Per-point colour source. Resolved against the tile's INTERLEAVED vector
   * columns first (`vectorProps[colorProperty]`, an RGB or RGBA
   * `FixedSizeList`), then against its categorical columns (palette /
   * {@link colorMapping}). A tile that bakes neither falls back to the
   * constant `color` — never to blank.
   */
  colorProperty?: string;
  /**
   * Three NUMERIC 0–255 columns read as `[r, g, b]`. Lower priority than an
   * interleaved {@link colorProperty} vector column, higher than a categorical
   * one. All three must be present in the tile or the source is skipped
   * entirely (a half-resolved colour is worse than the constant).
   */
  colorProperties?: readonly [string, string, string];
  /**
   * Palette sampled by category index when {@link colorProperty} resolves to a
   * categorical column. 0–255 RGBA tuples, deck adapter convention.
   */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA map. The category NAME is looked up
   * here, so a category renders the same colour in every tile regardless of
   * per-tile dictionary order — the positional {@link colorPalette} cannot
   * promise that.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /**
   * Sprite radius in {@link pointSizeUnits}. Defaults to deck
   * `PointCloudLayer`'s `pointSize: 10`, which is a RADIUS in pixels there
   * too. Clamped to the GPU's `gl_PointSize` range at draw time.
   */
  pointSize?: number;
  /**
   * Unit {@link pointSize} (and a {@link sizeProperty} column) is expressed in.
   * `'pixels'` (default) is screen-space. `'meters'` is ground-metric: the size
   * is converted per tile at that tile's centre latitude and the map's
   * fractional zoom, so a point covers a fixed patch of ground.
   */
  pointSizeUnits?: 'pixels' | 'meters';
  /** Drive per-point size (in {@link pointSizeUnits}) from a numeric column. */
  sizeProperty?: string;
  /** Multiplier applied to both the constant and the property-driven size. */
  sizeScale?: number;
  /**
   * Per-point elevation in METRES, from a numeric column. Takes priority over
   * the geometry's own third dimension.
   */
  elevationProperty?: string;
  /**
   * Use the tile's third position dimension as the elevation when
   * {@link elevationProperty} is unset or absent. Default `true` — this is
   * where `stt-build` puts altitude, and it is the reason this kind exists.
   */
  useGeometryElevation?: boolean;
  /** Constant elevation in METRES when no per-point source resolves. */
  elevation?: number;
  /** Multiplier on the resolved elevation, applied in metres. */
  elevationScale?: number;
  /**
   * Interleaved per-point normal column (`vectorProps[normalProperty]`, a
   * `FixedSizeList<Float32,3>`) in the shading frame (+x east, +y north,
   * +z up). Absent ⇒ the sphere-imposter view-space fallback.
   */
  normalProperty?: string;
  /**
   * Direction the light TRAVELS, in the shading frame. Normalized on
   * assignment. Defaults to {@link DEFAULT_LIGHT_DIRECTION}.
   */
  lightDirection?: readonly [number, number, number];
  /** Ambient coefficient. Defaults to deck's {@link DEFAULT_AMBIENT}. */
  ambientIntensity?: number;
  /** Lambertian coefficient. Defaults to deck's {@link DEFAULT_DIFFUSE}. */
  diffuseIntensity?: number;
  /**
   * Turn shading off entirely (ambient 1, diffuse 0). A uniform flip, NOT a
   * program variant — an unlit cloud is a debugging view, not a second layer.
   */
  lit?: boolean;
  /**
   * MapLibre `CustomLayerInterface.renderingMode`. `'3d'` by DEFAULT: this kind
   * is genuinely volumetric and must depth-resolve against itself and against
   * any other 3d layer in the style. `'2d'` forces the package's flat
   * always-on-top behaviour for a cloud you want painted over the basemap.
   */
  renderingMode?: '2d' | '3d';
  /**
   * Which temporal alpha the shader computes. Unset ⇒ inferred from the knobs
   * in deck's precedence order. `'wake'`/`'trail'` degrade to `'window'` when
   * their length knob is non-positive. `'cumulative'` carries the caller
   * obligation every STT layer states: the shader reveals progressively, the
   * loader does not, so `timeWindow` must be wide enough to keep the
   * accumulated tiles resident.
   */
  timeFilterMode?: PointCloudTimeFilterMode;
  /** Wake mode: ms a point stays lit after its own `startTime`. */
  wakeLength?: number;
  /** Wake mode trailing-edge size multiplier (head = 1.0). */
  wakeTailScale?: number;
  /** Trail mode: ms behind `currentTime` a point stays lit. */
  trailLength?: number;
  /**
   * Trail mode head→tail fade: `1`/`true` (default) fades across
   * `trailLength`, `0`/`false` keeps every lit point at full alpha.
   */
  fadeTrail?: boolean | number;
}

/** Unit-length copy of a 3-vector; a zero vector is returned unchanged. */
function normalize3(
  v: readonly [number, number, number],
): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) return [v[0], v[1], v[2]];
  return [v[0] / len, v[1] / len, v[2] / len];
}

// Shared with the deck.gl adapter (single source of truth in
// @poopdeck.gl/core) so both backends paint identical default colours.
const DEFAULT_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_CATEGORICAL_PALETTE;

// Immutable stand-in for callers with no host frame: onContextReady's eager
// legacy link and hand-built test DrawContexts that omit `frame`.
const LEGACY_FRAME: HostFrame = createHostFrame();

// Hoisted uniform fallbacks — a tile whose position buffer skipped
// quantization would otherwise allocate these every draw.
const IDENTITY_POS_SCALE: readonly number[] = [1, 1, 1];
const ZERO_POS_OFFSET: readonly number[] = [0, 0, 0];

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled point-cloud program supports. All three knobs are structural
 * — they add attributes, uniforms or statements — so each combination is its
 * own program and each must appear in {@link pointCloudProgramKey}.
 */
export interface PointCloudShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: PointCloudTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
  /**
   * Compile the per-point normal attribute + varying. When false the fragment
   * stage synthesizes the sphere-imposter normal instead — a different FS, so
   * this is a program axis on BOTH stages.
   */
  normals: boolean;
}

/** The OFF shape: window mode, no column filter, imposter normals. */
const DEFAULT_SHADER_CONFIG: PointCloudShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
  normals: false,
});

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<PointCloudTimeFilterMode, string>> =
  Object.freeze({
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  });

/**
 * Uniforms each mode reads. A sprite's radius is a STYLE quantity, not
 * geography, so it may taper in wake mode — hence the `_WITH_WAKE_TAIL_SCALE`
 * record.
 */
const MODE_UNIFORMS = TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE;

/** The `vAlpha = …` expression per mode. */
const MODE_ALPHA: Readonly<Record<PointCloudTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    // A cloud point is a single vertex, so its "vertex time" is its own start.
    trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
  });

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * DataFilter application, shared by the visual and id passes. Deck's split: a
 * HARD-filtered point (`0`) is hidden whatever the transform flags say, while a
 * soft-margin value only fades / shrinks when its flag is on.
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
 * Assemble a point-cloud vertex shader.
 *
 * The one structural difference from `STTPointLayer`'s billboard: projection
 * runs through {@link buildElevatedProjection} rather than `projectTile`,
 * because these points are real 3D content with their own z. That emitter
 * DECLARES `vec4 here` (splitting `#ifdef GLOBE` on prelude hosts and falling
 * back to `uMatrix` on legacy ones); this function only assigns it.
 *
 * `vAlpha` is computed BEFORE the size so wake mode's tail shrink and the
 * DataFilter size transform can both read it — deck's `vs:#main-start` →
 * `DECKGL_FILTER_SIZE` ordering.
 *
 * A fully-gated point is dropped by the fragment stage's
 * `if (vAlpha <= 0.0) discard;`, never by a `gl_Position = vec4(0.0)` collapse:
 * a POINT primitive with `w == 0` has no defined NDC position and could paint a
 * stray disc.
 */
function buildPointCloudVs(
  shader: ShaderInjection,
  cfg: PointCloudShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  // The normal is a visual-pass concern only — the id pass paints flat bytes.
  const withNormals = isMain && cfg.normals;

  const projection = buildElevatedProjection({
    usesPrelude,
    xy: 'mercator.xy',
    elevMeters: 'elevM',
    elevMercatorZ: 'elevM * uMercatorZPerMeter',
    names: {
      out: 'here',
      sphere: 'hereSphere',
      globe: 'hereGlobe',
      flat: 'hereFlat',
    },
  });

  const payloadAttribute = isMain
    ? '  attribute vec4 aColor;       // per-point RGBA in 0..1 (constant fallback when uUseFeatureColor=0)\n'
    : '  attribute vec3 aIdColor;     // per-point encoded id (UNSIGNED_BYTE normalized)\n';
  const normalAttribute = withNormals
    ? '  attribute vec3 aNormal;      // per-point surface normal, shading frame\n'
    : '';
  const legacyUniforms = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const colorUniforms = isMain
    ? '  uniform float uUseFeatureColor;\n  uniform vec4 uColor;\n'
    : '';
  const payloadVarying = isMain
    ? `  varying vec4 vColor;\n${
        withNormals ? '  varying vec3 vNormal;\n' : ''
      }`
    : '  varying vec3 vIdColor;\n';
  const wakeSize =
    cfg.mode === 'wake'
      ? '    sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';
  const payloadAssign = isMain
    ? `    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;\n${
        withNormals ? '    vNormal = aNormal;\n' : ''
      }`
    : '    vIdColor = aIdColor;\n';

  return `${head}
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute float aElevation;  // per-point height in METRES (when uUseFeatureElevation=1)
  attribute float aSize;       // per-point size in pointSizeUnits (when uUseFeatureSize=1)
${normalAttribute}${payloadAttribute}${
    cfg.filter ? FILTER_ATTRIBUTE : ''
  }${legacyUniforms}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uElevation;
  uniform float uUseFeatureElevation;
  uniform float uElevationScale;
  uniform float uMercatorZPerMeter; // METRES → mercator-z at this tile's latitude
  uniform float uSize;
  uniform float uSizeScale;
  uniform float uUseFeatureSize;
${colorUniforms}${MODE_UNIFORMS[cfg.mode]}${
    cfg.filter ? FILTER_UNIFORMS : ''
  }  varying float vAlpha;
${payloadVarying}${MODE_GLSL[cfg.mode]}${POSITION_DEQUANT_GLSL}${
    cfg.filter ? DATA_FILTER_GLSL : ''
  }
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    float elevM =
      (uUseFeatureElevation > 0.5 ? aElevation : uElevation) * uElevationScale;
${projection}    gl_Position = here;
    vAlpha = ${MODE_ALPHA[cfg.mode]};
    float sizePx = (uUseFeatureSize > 0.5 ? aSize : uSize) * uSizeScale;
${wakeSize}${cfg.filter ? FILTER_BODY : ''}    gl_PointSize = sizePx * 2.0;
${payloadAssign}  }
`;
}

/** Visual vertex source for a host shader variant + feature configuration. */
export function buildPointCloudVertexSource(
  shader: ShaderInjection,
  cfg: PointCloudShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildPointCloudVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildPointCloudVertexSource}. */
export function buildPointCloudIdVertexSource(
  shader: ShaderInjection,
  cfg: PointCloudShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildPointCloudVs(shader, cfg, 'id');
}

/**
 * The visual fragment stage: disc mask → normal → directional + ambient term →
 * `vColor.rgb * light`.
 *
 * The MULTIPLY is the layer's central rule, and it is expressed exactly once,
 * here, for every colour source the layer supports (see the module header).
 *
 * When `cfg.normals` is false the normal is the sphere imposter built from
 * `gl_PointCoord`: `d` runs ±0.5 across the sprite, so `2d` is the unit-disc
 * coordinate and `sqrt(1 - 4r²)` lifts it onto the hemisphere. `gl_PointCoord.y`
 * grows DOWNWARD, hence the negated y — without it the lighting is vertically
 * mirrored, which reads as "lit from below" and is invisible to any test that
 * does not rasterize.
 */
export function buildPointCloudFragmentSource(
  cfg: PointCloudShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  const normalVarying = cfg.normals ? '  varying vec3 vNormal;\n' : '';
  const normalExpr = cfg.normals
    ? '    vec3 n = normalize(vNormal);\n'
    : '    // sphere imposter: shade the sprite as a tiny ball, in VIEW space.\n' +
      '    vec3 n = normalize(vec3(d.x * 2.0, -d.y * 2.0,\n' +
      '      sqrt(max(0.0, 1.0 - 4.0 * r2))));\n';
  return `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
${normalVarying}  uniform vec3 uLightDirection; // direction light TRAVELS, unit length
  uniform float uAmbient;
  uniform float uDiffuse;
  void main() {
    if (vAlpha <= 0.0) discard;
${discMaskGLSL()}    // Antialiased disc: soften the last ~10% of the radius.
    float edge = ${DISC_EDGE_EXPR};
${normalExpr}    float lambert = max(dot(n, -uLightDirection), 0.0);
    float light = uAmbient + uDiffuse * lambert;
    gl_FragColor = vec4(vColor.rgb * light, vColor.a * vAlpha * edge);
  }
`;
}

/**
 * Program-cache key for one pass + feature configuration.
 * `getOrCreateProgram` appends `::${variantName}` (the HOST variant) only, so
 * every other structural axis has to be here.
 */
export function pointCloudProgramKey(
  pass: 'main' | 'pick',
  cfg: PointCloudShaderConfig,
): string {
  return `pointCloud:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}${
    cfg.normals ? ':normals' : ''
  }`;
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set.
 */
export function resolvePointCloudTimeFilterMode(
  mode: PointCloudTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): PointCloudTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  // Unset: infer from the knobs, deck's TimeFilterExtension precedence.
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

/**
 * JS reference for the fragment stage's lighting term — the same arithmetic in
 * the same order, so a test can pin the shading without a rasterizer.
 * `normal` and `lightDirection` are normalized here exactly as the GLSL does.
 */
export function pointCloudLightingJS(
  normal: readonly [number, number, number],
  lightDirection: readonly [number, number, number],
  ambient: number,
  diffuse: number,
): number {
  const n = normalize3([normal[0], normal[1], normal[2]]);
  const l = normalize3([
    lightDirection[0],
    lightDirection[1],
    lightDirection[2],
  ]);
  const lambert = Math.max(-(n[0] * l[0] + n[1] * l[1] + n[2] * l[2]), 0);
  return ambient + diffuse * lambert;
}

/**
 * JS reference for the sphere-imposter normal: the value the fragment stage
 * derives from `gl_PointCoord` when no per-point normal column exists. Returns
 * `null` outside the disc, where the mask discards the fragment.
 */
export function pointCloudImposterNormalJS(
  pointCoord: readonly [number, number],
): [number, number, number] | null {
  const dx = pointCoord[0] - 0.5;
  const dy = pointCoord[1] - 0.5;
  const r2 = dx * dx + dy * dy;
  if (r2 > 0.25) return null;
  return normalize3([dx * 2, -dy * 2, Math.sqrt(Math.max(0, 1 - 4 * r2))]);
}

// ── id-buffer picking variant (browser-verify-only) ─────────────────────────
// The id vertex source is the same builder with `kind: 'id'`: same elevated
// projection, same sizing (wake shrink and DataFilter size transform included)
// and the same alpha gates as the visual pass. Lighting is absent by
// construction — an id texel must decode to exact bytes, and a shaded id is a
// wrong id. The disc mask matches the visual FS so only the visible circle is
// pickable; no antialiased edge, for the same byte-exactness reason.
const ID_FS_SOURCE = buildBillboardIdFragmentSource('point-cloud points');

/**
 * Locations every point-cloud program shares — geometry, elevation, sizing,
 * time filter and DataFilter. Absent uniforms come back null (a no-op for
 * `gl.uniform*`) and absent attributes come back -1, which is exactly how a
 * configuration that doesn't declare them reads.
 */
interface PointCloudSharedHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  /** True when the source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aMercator: number;
  aTime: number;
  aElevation: number;
  aSize: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uElevation: WebGLUniformLocation | null;
  uUseFeatureElevation: WebGLUniformLocation | null;
  uElevationScale: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
  uSize: WebGLUniformLocation | null;
  uSizeScale: WebGLUniformLocation | null;
  uUseFeatureSize: WebGLUniformLocation | null;
}

interface PointCloudIdProgramHandles extends PointCloudSharedHandles {
  aIdColor: number;
}

interface PointCloudProgramHandles extends PointCloudSharedHandles {
  aColor: number;
  aNormal: number;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uLightDirection: WebGLUniformLocation | null;
  uAmbient: WebGLUniformLocation | null;
  uDiffuse: WebGLUniformLocation | null;
}

/** Per-point attribute buffers held alongside the standard TileGpuCache. */
interface PointCloudGpuCache extends TileGpuCache {
  colorBuffer?: WebGLBuffer;
  elevationBuffer?: WebGLBuffer;
  normalBuffer?: WebGLBuffer;
  sizeBuffer?: WebGLBuffer;
  /** Per-point DataFilter column; absent when the tile didn't bake it. */
  filterBuffer?: WebGLBuffer;
  /** Whether this tile supplies the filter column (the `enabled` gate). */
  hasFilterColumn?: boolean;
  /** METRES → mercator-z at THIS tile's centre latitude. */
  mercatorZScale: number;
  /**
   * Program the cached VAO's attribute locations were recorded against, as
   * `${programKey}::${variantName}`. Attribute SLOTS are per-program, so a host
   * variant flip or a compiled-mode flip must re-record the VAO.
   */
  vaoVariant?: string;
}

/**
 * MapLibre custom layer that renders STT point tiles as a LIT, ELEVATED 3D
 * point cloud.
 *
 * ```ts
 * const layer = new STTPointCloudLayer({
 *   id: 'lidar',
 *   url: '/data/sweep.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 2_000,
 *   colorProperty: 'rgb',        // interleaved RGB(A) vector column
 *   elevationProperty: 'z',      // metres; omit to use the geometry's own z
 *   pointSize: 2,
 * });
 * map.addLayer(layer);
 * ```
 */
export class STTPointCloudLayer extends STTFilterableLayer {
  private cloudOpts: {
    color: [number, number, number, number];
    colorProperty?: string;
    colorProperties?: readonly [string, string, string];
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    pointSize: number;
    pointSizeUnits: 'pixels' | 'meters';
    sizeProperty?: string;
    sizeScale: number;
    elevationProperty?: string;
    useGeometryElevation: boolean;
    elevation: number;
    elevationScale: number;
    normalProperty?: string;
    lightDirection: [number, number, number];
    ambientIntensity: number;
    diffuseIntensity: number;
    lit: boolean;
    timeFilterMode?: PointCloudTimeFilterMode;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };
  /** Compiled feature configuration; drives the program-cache keys. */
  private shaderConfig: PointCloudShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /** `${mainKey}::${variantName}` — the tile-VAO staleness key. */
  private mainVaoKey = '';
  private handles?: PointCloudProgramHandles;
  private handlesVariant?: string;
  private idHandles?: PointCloudIdProgramHandles;
  private idHandlesVariant?: string;

  /**
   * MapLibre `CustomLayerInterface.renderingMode`. `'3d'` by default — see
   * {@link STTPointCloudLayerOptions.renderingMode}. Assigned in the
   * constructor rather than as a field initializer so the option can drive it.
   */
  readonly renderingMode: '2d' | '3d';

  constructor(opts: STTPointCloudLayerOptions) {
    super(opts);
    this.cloudOpts = {
      color: opts.color ?? [0.85, 0.87, 0.9, 1.0],
      colorProperty: opts.colorProperty,
      colorProperties: opts.colorProperties,
      colorPalette: opts.colorPalette ?? DEFAULT_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      // deck PointCloudLayer's `pointSize: 10`, which is a pixel RADIUS there.
      pointSize: opts.pointSize ?? 10,
      pointSizeUnits: opts.pointSizeUnits ?? 'pixels',
      sizeProperty: opts.sizeProperty,
      sizeScale: opts.sizeScale ?? 1,
      elevationProperty: opts.elevationProperty,
      useGeometryElevation: opts.useGeometryElevation ?? true,
      elevation: opts.elevation ?? 0,
      elevationScale: opts.elevationScale ?? 1,
      normalProperty: opts.normalProperty,
      lightDirection: opts.lightDirection
        ? normalize3(opts.lightDirection)
        : ([...DEFAULT_LIGHT_DIRECTION] as [number, number, number]),
      ambientIntensity: opts.ambientIntensity ?? DEFAULT_AMBIENT,
      diffuseIntensity: opts.diffuseIntensity ?? DEFAULT_DIFFUSE,
      lit: opts.lit ?? true,
      timeFilterMode: opts.timeFilterMode,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    // A spread-with-default would carry an explicit `renderingMode: undefined`
    // as an own key; `??` is what makes a forwarded React prop hit the default.
    this.renderingMode = opts.renderingMode ?? '3d';
    this.shaderConfig = {
      mode: this.resolveMode(),
      // Compiled from the PROPERTY NAME alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
      normals: Boolean(opts.normalProperty),
    };
    this.mainKey = pointCloudProgramKey('main', this.shaderConfig);
    this.pickKey = pointCloudProgramKey('pick', this.shaderConfig);
  }

  private resolveMode(): PointCloudTimeFilterMode {
    return resolvePointCloudTimeFilterMode(
      this.cloudOpts.timeFilterMode,
      this.cloudOpts.wakeLength,
      this.cloudOpts.trailLength,
    );
  }

  /** Update the constant point colour at runtime. */
  setColor(color: [number, number, number, number]): void {
    this.cloudOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Update the sprite radius (in `pointSizeUnits`) at runtime. */
  setPointSize(pointSize: number): void {
    this.cloudOpts.pointSize = pointSize;
    this.map?.triggerRepaint();
  }

  /** Update the elevation multiplier at runtime — the vertical-exaggeration knob. */
  setElevationScale(elevationScale: number): void {
    this.cloudOpts.elevationScale = elevationScale;
    this.map?.triggerRepaint();
  }

  /**
   * Move the light. A uniform, not a program axis: this is cheap enough to
   * animate (a day/night sweep over a static cloud).
   */
  setLightDirection(direction: readonly [number, number, number]): void {
    this.cloudOpts.lightDirection = normalize3(direction);
    this.map?.triggerRepaint();
  }

  /** Turn shading on/off. Also a uniform flip, not a second program. */
  setLit(lit: boolean): void {
    this.cloudOpts.lit = lit;
    this.map?.triggerRepaint();
  }

  /**
   * Switch time-filter mode at runtime. The mode is compiled in, so this links
   * a second program on the next frame (cached from then on) and re-records
   * every tile VAO against it.
   */
  setTimeFilterMode(mode: PointCloudTimeFilterMode): void {
    this.cloudOpts.timeFilterMode = mode;
    this.applyShaderConfig();
  }

  /** Update the wake length (ms) — selects wake mode when it goes positive. */
  setWakeLength(wakeLength: number): void {
    this.cloudOpts.wakeLength = wakeLength;
    this.applyShaderConfig();
  }

  /** Update the trail length (ms) — selects trail mode when it goes positive. */
  setTrailLength(trailLength: number): void {
    this.cloudOpts.trailLength = trailLength;
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
    this.mainKey = pointCloudProgramKey('main', this.shaderConfig);
    this.pickKey = pointCloudProgramKey('pick', this.shaderConfig);
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  /** Resolve the locations every point-cloud program declares. */
  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): PointCloudSharedHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aElevation: gl.getAttribLocation(program, 'aElevation'),
      aSize: gl.getAttribLocation(program, 'aSize'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uElevation: gl.getUniformLocation(program, 'uElevation'),
      uUseFeatureElevation: gl.getUniformLocation(
        program,
        'uUseFeatureElevation',
      ),
      uElevationScale: gl.getUniformLocation(program, 'uElevationScale'),
      uMercatorZPerMeter: gl.getUniformLocation(program, 'uMercatorZPerMeter'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uSizeScale: gl.getUniformLocation(program, 'uSizeScale'),
      uUseFeatureSize: gl.getUniformLocation(program, 'uUseFeatureSize'),
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
  ): PointCloudProgramHandles {
    const program = this.linkProgram(
      gl,
      buildPointCloudVertexSource(shader, this.shaderConfig),
      buildPointCloudFragmentSource(this.shaderConfig),
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aNormal: this.shaderConfig.normals
        ? gl.getAttribLocation(program, 'aNormal')
        : -1,
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uLightDirection: gl.getUniformLocation(program, 'uLightDirection'),
      uAmbient: gl.getUniformLocation(program, 'uAmbient'),
      uDiffuse: gl.getUniformLocation(program, 'uDiffuse'),
    };
  }

  /** Link the id-pick program for a variant and resolve its locations. */
  private buildIdHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): PointCloudIdProgramHandles {
    const program = this.linkProgram(
      gl,
      buildPointCloudIdVertexSource(shader, this.shaderConfig),
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
    // frame; a v5 host links its own lazily through the base per-variant
    // cache). The id program compiles alongside so the first `pick()` doesn't
    // stall.
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

  protected onContextLost(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Program lifetimes are owned by the base per-variant cache; only the
    // handle references are ours to clear.
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /**
   * GL state for the frame. Departs from the base in exactly one way: on a
   * `'3d'` layer the host has already installed its LEQUAL read-write depth
   * mode before calling us, so we LEAVE IT ALONE — disabling `DEPTH_TEST` the
   * way the flat layers do is what would make a cloud paint in tile order
   * instead of by depth, which is precisely the failure this kind exists to
   * avoid. `'2d'` keeps the package's always-on-top behaviour.
   */
  protected applySharedGlState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.renderingMode !== '3d') gl.disable(gl.DEPTH_TEST);
  }

  // ── per-point column resolution (CPU, once per tile) ──────────────────────

  /**
   * Resolve the per-point RGBA8 buffer from the FIRST colour source the tile
   * actually carries, in the documented priority order. Returns null for "use
   * the constant" — never for "hide the tile".
   */
  private resolveColorValues(binary: BinaryFeatures): Uint8Array | null {
    const o = this.cloudOpts;
    const count = binary.featureCount;

    // (1) interleaved RGB/RGBA vector column — the zero-copy scanner path.
    if (o.colorProperty) {
      const vec = binary.vectorProps?.[o.colorProperty];
      if (vec && (vec.size === 3 || vec.size === 4)) {
        const out = new Uint8Array(count * 4);
        const src = vec.value;
        // f32 leaves are 0..1 (the FixedSizeList colour convention); u8 leaves
        // are already bytes.
        const k = src instanceof Float32Array ? 255 : 1;
        for (let i = 0; i < count; i++) {
          const s = i * vec.size;
          if (s + vec.size > src.length) break;
          out[i * 4] = src[s]! * k;
          out[i * 4 + 1] = src[s + 1]! * k;
          out[i * 4 + 2] = src[s + 2]! * k;
          out[i * 4 + 3] = vec.size === 4 ? src[s + 3]! * k : 255;
        }
        return out;
      }
    }

    // (2) three numeric 0–255 columns. All three or none: a half-resolved
    // colour (green channel silently 0) is worse than the honest constant.
    if (o.colorProperties) {
      const r = this.getNumericProperty(binary, o.colorProperties[0]);
      const g = this.getNumericProperty(binary, o.colorProperties[1]);
      const b = this.getNumericProperty(binary, o.colorProperties[2]);
      if (r && g && b) {
        const out = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
          out[i * 4] = r[i] ?? 0;
          out[i * 4 + 1] = g[i] ?? 0;
          out[i * 4 + 2] = b[i] ?? 0;
          out[i * 4 + 3] = 255;
        }
        return out;
      }
    }

    // (3) categorical palette / colorMapping — the SAME buffer, so the shading
    // multiply in the fragment stage applies to it identically. See the header.
    if (o.colorProperty) {
      return this.expandCategoricalColors(
        binary,
        o.colorProperty,
        o.colorPalette,
        o.colorMapping,
        o.colorMappingDefault,
      );
    }
    return null;
  }

  /**
   * Resolve the per-point elevation column in METRES. `elevationProperty`
   * first, then the geometry's own third dimension — which is where the
   * altitude a point cloud is built with actually lives.
   */
  private resolveElevationValues(
    binary: BinaryFeatures,
    count: number,
  ): Float32Array | null {
    const o = this.cloudOpts;
    if (o.elevationProperty) {
      const col = this.getNumericProperty(binary, o.elevationProperty);
      if (col) return col;
    }
    if (!o.useGeometryElevation) return null;
    const dims = binary.positionDimensions ?? 2;
    if (dims < 3) return null;
    const src = binary.positions;
    const n = Math.min(count, Math.floor(src.length / dims));
    if (n <= 0) return null;
    const out = new Float32Array(count);
    for (let i = 0; i < n; i++) out[i] = src[i * dims + 2]!;
    return out;
  }

  /**
   * Build the per-tile cache: the base's quantized positions + times, plus the
   * per-point colour / elevation / normal / size / DataFilter columns when they
   * resolve. Every one of them degrades to "use the constant", never to "hide
   * the tile".
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): PointCloudGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, tile, layer);
    if (!baseCache) return null;
    const cache = baseCache as PointCloudGpuCache;
    const f = layer.features;
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];

    // Metres → mercator-z at THIS tile's centre latitude. Resolving it per tile
    // (not at the map centre) is what keeps a cloud's height consistent across
    // a view that spans latitudes.
    cache.mercatorZScale = mercatorZFromAltitude(
      1,
      tileCenterLatitude(tile.id.z, tile.id.y),
    );

    const colors = this.resolveColorValues(f);
    if (colors) {
      cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
      extras.push(cache.colorBuffer);
    }

    const elevations = this.resolveElevationValues(f, baseCache.vertexCount);
    if (elevations) {
      cache.elevationBuffer = this.uploadArrayBuffer(gl, elevations);
      extras.push(cache.elevationBuffer);
    }

    if (this.shaderConfig.normals && this.cloudOpts.normalProperty) {
      const vec = f.vectorProps?.[this.cloudOpts.normalProperty];
      if (vec && vec.size === 3 && vec.value instanceof Float32Array) {
        cache.normalBuffer = this.uploadArrayBuffer(gl, vec.value);
        extras.push(cache.normalBuffer);
      }
    }

    if (this.cloudOpts.sizeProperty) {
      const sizes = this.getNumericProperty(f, this.cloudOpts.sizeProperty);
      if (sizes) {
        cache.sizeBuffer = this.uploadArrayBuffer(gl, sizes);
        extras.push(cache.sizeBuffer);
      }
    }

    if (this.shaderConfig.filter) {
      // One cloud point == one vertex, so the per-FEATURE column binds
      // directly (no expandFilterValues, which is for segment instancing).
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

  // ── draw ─────────────────────────────────────────────────────────────────

  /**
   * The `uSizeScale` value for this tile. `'pixels'` is the plain multiplier;
   * `'meters'` folds in the metres→device-pixels factor at the TILE CENTRE's
   * latitude and the map's FRACTIONAL zoom, so the cloud's footprint grows
   * continuously rather than stepping at integer zooms.
   */
  private resolveSizeScale(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const scale = this.cloudOpts.sizeScale;
    if (this.cloudOpts.pointSizeUnits !== 'meters') return scale;
    return scale * this.metricPixelScale(gl, tile, ctx);
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active
   * mode's uniforms exist in the program, so the switch is also what keeps a
   * stale mode's uniform from being written to a null location every draw. All
   * times are tile-relative: absolute time minus the tile's own `timeOffset`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: PointCloudSharedHandles,
    cache: PointCloudGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.cloudOpts;
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
   * Projection + elevation + sizing + time + filter uniforms — everything the
   * visual and id passes set IDENTICALLY, so a picked point is exactly the
   * point the user sees, at the height they see it (including on globe, where
   * the prelude owns projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: PointCloudSharedHandles,
    tile: Tile,
    cache: PointCloudGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude owns projection; the elevated block
      // still reads uMercatorZPerMeter on its MERCATOR branch.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform3fv(h.uPosScale, cache.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, cache.posOffset ?? ZERO_POS_OFFSET);
    gl.uniform1f(h.uMercatorZPerMeter, cache.mercatorZScale);
    gl.uniform1f(h.uElevation, this.cloudOpts.elevation);
    gl.uniform1f(h.uElevationScale, this.cloudOpts.elevationScale);
    gl.uniform1f(
      h.uUseFeatureElevation,
      cache.elevationBuffer && h.aElevation >= 0 ? 1 : 0,
    );
    gl.uniform1f(h.uSize, this.cloudOpts.pointSize);
    gl.uniform1f(h.uSizeScale, this.resolveSizeScale(gl, tile, ctx));
    gl.uniform1f(h.uUseFeatureSize, cache.sizeBuffer && h.aSize >= 0 ? 1 : 0);
    this.setTimeUniforms(gl, h, cache, ctx);
    // A tile that didn't bake the column resolves to `enabled: 0`, which the
    // kernel reads as "render everything" — never as "hide everything".
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn === true);
    }
  }

  /** Bind the geometry/time/elevation/size/filter attributes both passes share. */
  private bindSharedAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: PointCloudSharedHandles,
    cache: PointCloudGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 3, gl.UNSIGNED_SHORT, true, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);

    if (cache.elevationBuffer && h.aElevation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.elevationBuffer);
      gl.enableVertexAttribArray(h.aElevation);
      gl.vertexAttribPointer(h.aElevation, 1, gl.FLOAT, false, 0, 0);
    }
    if (cache.sizeBuffer && h.aSize >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.sizeBuffer);
      gl.enableVertexAttribArray(h.aSize);
      gl.vertexAttribPointer(h.aSize, 1, gl.FLOAT, false, 0, 0);
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
    const c = cache as PointCloudGpuCache;

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);
    gl.uniform4fv(h.uColor, this.rgba01Uniform('Color', this.cloudOpts.color));
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);
    // Lighting is fragment-stage and layer-level (not per tile), but it is set
    // here rather than once per frame because `render()` is the base's and a
    // per-frame hook would be a second place for the two passes to diverge.
    const lit = this.cloudOpts.lit;
    gl.uniform3fv(h.uLightDirection, this.cloudOpts.lightDirection);
    gl.uniform1f(h.uAmbient, lit ? this.cloudOpts.ambientIntensity : 1);
    gl.uniform1f(h.uDiffuse, lit ? this.cloudOpts.diffuseIntensity : 0);

    // A VAO records attribute locations against ONE program — drop it when the
    // host flipped shader variants, or the layer flipped time-filter mode, so
    // it re-records against `h`.
    const vaoKey = this.mainVaoKey;
    if (c.vao && c.vaoVariant !== vaoKey) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }

    this.bindVaoOrSetup(c, () => {
      this.bindSharedAttributes(gl, h!, c);
      if (c.colorBuffer && h!.aColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
        gl.enableVertexAttribArray(h!.aColor);
        gl.vertexAttribPointer(h!.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      }
      if (c.normalBuffer && h!.aNormal >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.normalBuffer);
        gl.enableVertexAttribArray(h!.aNormal);
        gl.vertexAttribPointer(h!.aNormal, 3, gl.FLOAT, false, 0, 0);
      }
    });
    c.vaoVariant = vaoKey;

    gl.drawArrays(gl.POINTS, 0, cache.vertexCount);
  }

  /**
   * Draw this cloud tile into the id-pick FBO, painting point `i` the flat
   * colour `encodePickId(idBase + i)`. Mirrors {@link drawTile}'s ELEVATED
   * projection (same builder, same uniforms, same `uMercatorZPerMeter`), its
   * sizing and its ALPHA GATES, so a point the time filter or the DataFilter
   * hid is never pickable and a point 400 m up is picked where it is DRAWN, not
   * where its ground footprint would be. The `'3d'` pick pass is depth-tested
   * by the base against the FBO's own depth attachment, so the nearest point
   * along the ray wins rather than the last one drawn.
   *
   * The id-colour buffer is rebuilt each pick and freed immediately: `idBase`
   * shifts with whatever tiles are loaded this frame, and picks are rare
   * user-initiated events.
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
    const c = cache as PointCloudGpuCache;
    // One point == one feature, so vertexCount is the feature count here.
    const count = cache.vertexCount;
    const idColors = this.buildPickIdColors(count, idBase);
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);

    // Raw attribute binds (no VAO): picking is a rare pass outside the host
    // render loop, and the temp id buffer is per-pass.
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
    if (c.elevationBuffer && h.aElevation >= 0) {
      gl.disableVertexAttribArray(h.aElevation);
    }
    if (c.sizeBuffer && h.aSize >= 0) {
      gl.disableVertexAttribArray(h.aSize);
    }
    if (c.filterBuffer && h.aFilterValue >= 0) {
      gl.disableVertexAttribArray(h.aFilterValue);
    }
    gl.deleteBuffer(idBuffer);
  }
}
