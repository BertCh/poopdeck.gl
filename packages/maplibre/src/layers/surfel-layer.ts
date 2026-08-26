// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Surfel geometry adapter — renders POINT-type tiles as ORIENTED ANISOTROPIC
 * GAUSSIAN SURFELS.
 *
 * ── What it draws ───────────────────────────────────────────────────────────
 * A surfel ("surface element") is a measured patch of a real surface: a
 * position, the ORIENTATION of the surface there, and how big the patch is
 * along each of its two in-plane axes. This layer draws exactly that — an
 * instanced quad per feature, rotated into the surfel's own surface frame by a
 * per-feature quaternion, scaled by TWO DISTINCT half-extents (`s_major`,
 * `s_minor`, both in METRES), and shaded with a radial Gaussian so the quad
 * reads as a soft elliptical disk rather than a card.
 *
 * The columns it consumes (the `@poopdeck.gl/three` / `@poopdeck.gl/cesium`
 * surfel contract, one row per surfel):
 *
 *  | column                   | meaning                                        |
 *  | ------------------------ | ---------------------------------------------- |
 *  | geometry `[lng, lat]`    | where the patch sits                           |
 *  | `z` (numeric, METRES)    | height above the ellipsoid                     |
 *  | `qx,qy,qz,qw`            | surface frame; matrix columns are               |
 *  |                          | `[tangent | bitangent | normal]`               |
 *  | `q_a,q_b,q_c,q_imax`     | …or the smallest-three PACKED form of the same |
 *  | `s_major`, `s_minor`     | in-plane half-extents, METRES                  |
 *  | `r`, `g`, `b` (0–255)    | per-surfel colour                              |
 *  | `surfel_opacity` (0–1)   | per-surfel CONFIDENCE, folded into disk alpha   |
 *  | feature start time       | centre of the TEMPORAL Gaussian                |
 *
 * ── Why the design is what it is ────────────────────────────────────────────
 *  - **World-space quad, not a billboard.** `STTPointLayer` with a splat-ish
 *    disc mask draws an ISOTROPIC, screen-facing, round sprite. That is the
 *    exact thing a surfel is not. The orientation and the two distinct
 *    half-extents ARE the payload: a surfel lying on a road deck must foreshorten
 *    to a sliver when you look along it, and a surfel on a wall must stand up.
 *    So the offset is built in the local surface frame, in metres, and projected
 *    like any other 3D geometry — `renderingMode: '3d'`, so overlapping disks
 *    resolve by DEPTH rather than by draw order.
 *  - **Gaussian in the fragment stage.** The vertex stage hands the fragment
 *    stage the quad's own `[-1,1]²` corner, so the isotropic
 *    `exp(-½·r²·falloffSigmas²)` in `sttSurfelDiskWeight` becomes an
 *    ANISOTROPIC world-space falloff for free — the axes were already scaled.
 *    `r² > 1` clips hard, which is what makes the footprint an ellipse and not
 *    the bounding quad.
 *  - **Two independent temporal stories.** The shared four-mode time filter
 *    (window / wake / cumulative / trail) decides whether the surfel is in the
 *    frame at all; `temporalSigma` then weights it by a Gaussian centred on its
 *    own sample time, so a LiDAR sweep dissolves smoothly through the playhead
 *    instead of popping at a window edge. The second term is compiled in only
 *    when `temporalSigma > 0`, so it is a structural axis of the program key.
 *  - **Sizing is metric because the data is metric.** `s_major`/`s_minor` are
 *    ground metres. `sizeUnits: 'pixels'` and `minSizePixels` both resolve
 *    through `this.metricPixelScale` at the TILE's centre latitude and the map's
 *    fractional zoom, then feed the shader as METRES — the geometry stays real
 *    world-space geometry in every mode, only its extent is re-expressed.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *  - **No wake-tail size taper.** `sttWakeSizeScale` shrinks a billboard's
 *    radius as it ages; a surfel's half-extents are a MEASUREMENT of a physical
 *    patch, the same way a summary cell's footprint is geography. Wake mode
 *    fades a surfel's alpha and leaves its size alone. (Hence the plain
 *    `TIME_MODE_UNIFORM_DECLS`, not the `_WITH_WAKE_TAIL_SCALE` variant.)
 *  - **No DataFilter size transform.** Same reason: `uFilterTransformSize` is
 *    declared by the shared chunk but never read, matching upstream deck's
 *    `SolidPolygonLayer` and this package's summary/cell layers.
 *  - **No spherical-harmonic / view-dependent colour, no covariance-matrix
 *    (3DGS) splatting, no sorted alpha blending.** A surfel here is an OPAQUE-
 *    ordered, depth-tested disk with a soft profile; it is a surface sample, not
 *    a radiance field primitive. Order-independent transparency for overlapping
 *    disks would need a second pass this layer does not have.
 *  - **No globe edge subdivision.** A surfel is metres across; its quad is
 *    always far below the host's chord granularity, so the elevated-projection
 *    block alone is the whole globe story.
 *
 * Every alpha gate — time filter, temporal Gaussian, per-surfel confidence,
 * DataFilter, the radial profile and the `alphaCutoff` — lands in the id-pick
 * program too, from the SAME builders and the same uniform uploads: a surfel
 * the user cannot see is never pickable.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
} from '../base-layer.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import {
  mercatorZFromAltitude,
  metersToMercatorUnits,
  tileCenterLatitude,
} from '../lib/projection.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_TRAIL_GLSL,
  TIME_MODE_UNIFORM_DECLS,
  resolveTimeUniformLocations,
  type TimeUniformLocations,
} from '../shaders/time-window.glsl.js';
import { POSITION_DEQUANT_GLSL } from '../shaders/position-quantization.glsl.js';
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
import {
  SURFEL_BASIS_GLSL,
  SURFEL_GAUSSIAN_GLSL,
} from '../shaders/surfel-disk.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  type DataFilterUniformLocations,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's own name.
 */
export type SurfelTimeFilterMode = STTTimeFilterMode;

/** Default numeric column names, the `@poopdeck.gl/three` surfel contract. */
export const SURFEL_DEFAULT_QUATERNION_COLUMNS: readonly [
  string,
  string,
  string,
  string,
] = ['qx', 'qy', 'qz', 'qw'];

/** Default smallest-three PACKED quaternion column names. */
export const SURFEL_DEFAULT_PACKED_QUATERNION_COLUMNS: readonly [
  string,
  string,
  string,
  string,
] = ['q_a', 'q_b', 'q_c', 'q_imax'];

/** Default in-plane half-extent column names, both METRES. */
export const SURFEL_DEFAULT_EXTENT_COLUMNS: readonly [string, string] = [
  's_major',
  's_minor',
];

/** Default per-surfel colour columns (0–255 each). */
export const SURFEL_DEFAULT_COLOR_COLUMNS: readonly [string, string, string] = [
  'r',
  'g',
  'b',
];

export interface STTSurfelLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Constant colour as `[r, g, b, a]`, used for any surfel whose colour columns
   * are absent from the tile. Accepts EITHER 0–255 ints (the deck.gl `Color`
   * convention) OR 0–1 floats — the range is auto-detected. The alpha channel
   * multiplies {@link opacity}.
   */
  color?: [number, number, number, number];
  /** Layer-wide opacity multiplier, 0–1. @default 1 */
  opacity?: number;
  /**
   * Numeric columns holding per-surfel RGB in 0–255.
   * @default ['r', 'g', 'b']
   */
  colorColumns?: [string, string, string];
  /**
   * Numeric column holding per-surfel CONFIDENCE in 0–1, folded into the disk's
   * alpha. A tile without it renders every surfel at full confidence.
   * @default 'surfel_opacity'
   */
  opacityProperty?: string;
  /**
   * The four numeric columns of the surface-frame quaternion, in `(x, y, z, w)`
   * order. Its matrix columns are `[tangent | bitangent | normal]` in the local
   * ENU frame at the surfel.
   * @default ['qx', 'qy', 'qz', 'qw']
   */
  quaternionColumns?: [string, string, string, string];
  /**
   * The smallest-three PACKED form of the same quaternion — three components
   * plus the index of the dropped (largest-magnitude) one. Used only when
   * {@link quaternionColumns} are absent from the tile; unpacked on the CPU at
   * upload so the shader only ever sees a full `vec4`.
   * @default ['q_a', 'q_b', 'q_c', 'q_imax']
   */
  packedQuaternionColumns?: [string, string, string, string];
  /**
   * The two in-plane half-extent columns, `[major, minor]`, both in METRES.
   * @default ['s_major', 's_minor']
   */
  extentColumns?: [string, string];
  /**
   * Constant `[major, minor]` half-extents for tiles whose
   * {@link extentColumns} are absent. In {@link sizeUnits}.
   * @default [1, 1]
   */
  size?: [number, number];
  /**
   * Unit the half-extents (constant AND column) are expressed in. `'meters'`
   * (default) is the surfel contract's own unit. `'pixels'` re-resolves them
   * into metres per tile at the tile centre's latitude and the map's fractional
   * zoom, so the disk holds a constant SCREEN size while remaining real
   * world-space, depth-tested geometry.
   * @default 'meters'
   */
  sizeUnits?: 'meters' | 'pixels';
  /** Multiplier applied to both half-extents. @default 1 */
  sizeScale?: number;
  /**
   * Floor on the on-screen half-extent, in pixels, resolved to metres per tile.
   * A LiDAR surfel is often a few centimetres across and would vanish below one
   * pixel at city zooms; a small floor keeps a sweep legible while zoomed out.
   * @default 0 (no floor)
   */
  minSizePixels?: number;
  /**
   * Numeric column holding the surfel's height above the ellipsoid, in METRES.
   * @default 'z'
   */
  elevationProperty?: string;
  /** Multiplier on {@link elevationProperty}. @default 1 */
  elevationScale?: number;
  /**
   * How many standard deviations of the radial Gaussian fit inside the disk's
   * rim. Higher is a tighter, harder-edged core; the rim weight is
   * `exp(-falloffSigmas² / 2)`.
   * @default 3 (rim weight ≈ 0.011)
   */
  falloffSigmas?: number;
  /**
   * Standard deviation, in ms, of the TEMPORAL Gaussian centred on each
   * surfel's own sample time. `0` (default) compiles the term out entirely and
   * leaves the shared time filter as the whole temporal story.
   * @default 0
   */
  temporalSigma?: number;
  /**
   * Composed-alpha below which a fragment is discarded, in BOTH the visual and
   * the id pass. Its job is to make the two passes agree exactly on where a
   * surfel ends — a Gaussian never reaches zero, so without a shared cutoff the
   * pickable footprint would be larger than the visible one.
   * @default 0.01
   */
  alphaCutoff?: number;
  /**
   * Which temporal alpha the shader computes. Unset ⇒ inferred from the knobs
   * in deck's precedence order. `'wake'`/`'trail'` degrade to `'window'` when
   * their length knob is non-positive. The mode is compiled into the shader, so
   * flipping it at runtime links a second program.
   */
  timeFilterMode?: SurfelTimeFilterMode;
  /**
   * Wake mode: a surfel is lit for this many ms after its own `startTime`,
   * alpha fading linearly to 0. Its half-extents do NOT taper (see the file
   * header). @default 0
   */
  wakeLength?: number;
  /**
   * Trail mode: a surfel is lit while its `startTime` lies within this many ms
   * behind `currentTime`. @default 0
   */
  trailLength?: number;
  /**
   * Trail mode head→tail fade: `1`/`true` (default) fades across
   * `trailLength`, `0`/`false` keeps every lit surfel at full alpha.
   */
  fadeTrail?: boolean | number;
}

// Immutable stand-in for callers with no host frame: onContextReady's eager
// legacy link and hand-built test DrawContexts that omit `frame`.
const LEGACY_FRAME: HostFrame = createHostFrame();

// Hoisted uniform fallbacks — see point-layer.ts.
const IDENTITY_POS_SCALE: readonly number[] = [1, 1, 1];
const ZERO_POS_OFFSET: readonly number[] = [0, 0, 0];

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled surfel program supports. All three knobs are structural
 * (each adds uniforms/attributes/statements), so every combination is its own
 * program and every one appears in {@link surfelProgramKey}.
 */
export interface SurfelShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: SurfelTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
  /** Compile the temporal-Gaussian term (`temporalSigma > 0`). */
  temporal: boolean;
}

/** The OFF shape: window mode, no column filter, no temporal Gaussian. */
const DEFAULT_SHADER_CONFIG: SurfelShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
  temporal: false,
});

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<SurfelTimeFilterMode, string>> = Object.freeze(
  {
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  },
);

/**
 * Uniforms each mode reads. The PLAIN record: a surfel's extent is a
 * measurement, so wake mode never taper-scales it and `uWakeTailScale` would be
 * a dead uniform.
 */
const MODE_UNIFORMS = TIME_MODE_UNIFORM_DECLS;

/** The `vAlpha = …` expression per mode. */
const MODE_ALPHA: Readonly<Record<SurfelTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    // One surfel is one instance, so its "vertex time" is its own start time.
    trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
  });

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * DataFilter application. Deck's split: a HARD-filtered feature (`0`) is hidden
 * whatever the transform flags say, while a soft-margin value only fades when
 * `DECKGL_FILTER_COLOR` is on. There is no size branch — `uFilterTransformSize`
 * is declared by the shared chunk and deliberately never read here.
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
`;

/**
 * Assemble a surfel vertex shader.
 *
 * The quad is INSTANCED: four shared corner vertices (the base's unit quad,
 * `(side ∈ {-1,+1}, along ∈ {0,1})`, remapped here to `[-1,1]²`) against one
 * instance per surfel. Everything that describes the surfel — position, time,
 * quaternion, half-extents, elevation, colour, confidence, filter value — is a
 * per-instance attribute with divisor 1.
 *
 * The offset is built in the surfel's own surface frame and stays in METRES for
 * as long as possible:
 *
 * ```
 * offENU = tangent·(cx·sMajor) + bitangent·(cy·sMinor)     // metres, ENU
 * posM   = centre.xy + vec2(offENU.x, -offENU.y)·mercPerM  // NOTE the y flip
 * elevM  = z·elevScale + offENU.z                          // metres, still
 * ```
 *
 * The `-offENU.y` is not a sign slip: ENU's north is +y, and mercator's y grows
 * SOUTHWARD. Getting it wrong mirrors every disk about its own centre — which
 * is invisible on a circular splat and glaring on an anisotropic one.
 *
 * Elevation then goes through {@link buildElevatedProjection}, the one
 * implementation of the legacy / v5-mercator / v5-globe elevation-unit split.
 * Real 3D content: it keeps its own z (and re-derives the globe horizon clip),
 * which is what lets two overlapping disks resolve by depth.
 *
 * `vAlpha` is composed entirely in the vertex stage — time filter × temporal
 * Gaussian × per-surfel confidence × base alpha × DataFilter — so the visual
 * and id fragment stages can be byte-identical in their gates while differing
 * only in what colour they write.
 */
function buildSurfelVs(
  shader: ShaderInjection,
  cfg: SurfelShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  const payloadAttribute = isMain
    ? '  attribute vec3 aColor;       // per-surfel RGB, UNSIGNED_BYTE normalized\n'
    : '  attribute vec3 aIdColor;     // per-surfel encoded id (UNSIGNED_BYTE normalized)\n';
  const legacyUniforms = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const colorUniforms = isMain
    ? '  uniform float uUseFeatureColor;\n  uniform vec4 uColor;\n'
    : '';
  const payloadVarying = isMain
    ? '  varying vec3 vColor;\n'
    : '  varying vec3 vIdColor;\n';
  const payloadAssign = isMain
    ? '    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor.rgb;\n'
    : '    vIdColor = aIdColor;\n';
  const temporalUniform = cfg.temporal
    ? '  uniform float uTemporalInvSigma;\n'
    : '';
  const temporalBody = cfg.temporal
    ? '    vAlpha *= sttSurfelTemporalWeight(uSurfelNow, aTime.x, uTemporalInvSigma);\n'
    : '';
  const projection = buildElevatedProjection({
    usesPrelude,
    xy: 'posM',
    elevMeters: 'elevM',
    elevMercatorZ: 'elevM * uMercatorZPerMeter',
    names: {
      out: 'here',
      sphere: 'hereSphere',
      globe: 'hereGlobe',
      flat: 'hereFlat',
    },
  });

  return `${head}
  precision highp float;
  attribute vec2 aCorner;      // per-VERTEX unit quad: (side ∈ {-1,+1}, along ∈ {0,1})
  attribute vec3 aMercator;    // per-instance tile-local UNSIGNED_SHORT — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec4 aQuat;        // per-instance surface frame (x,y,z,w)
  attribute vec2 aExtent;      // per-instance [s_major, s_minor], METRES
  attribute float aElevation;  // per-instance height above the ellipsoid, METRES
  attribute float aConfidence; // per-instance 0..1, folded into the disk alpha
${payloadAttribute}${cfg.filter ? FILTER_ATTRIBUTE : ''}${legacyUniforms}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform vec2 uSize;                 // constant half-extent fallback, METRES
  uniform float uSizeScale;
  uniform float uMinExtentMeters;
  uniform float uUseFeatureExtent;
  uniform float uUseFeatureQuat;
  uniform float uUseFeatureElevation;
  uniform float uUseFeatureConfidence;
  uniform float uElevationScale;
  uniform float uMercatorPerMeter;    // METRES → mercator XY units at this tile's latitude
  uniform float uMercatorZPerMeter;   // METRES → mercator Z at this tile's latitude
  uniform float uBaseAlpha;           // constant colour alpha × layer opacity
  uniform float uSurfelNow;           // playhead, TILE-RELATIVE ms
${temporalUniform}${colorUniforms}${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
  varying vec2 vDisk;
${payloadVarying}${MODE_GLSL[cfg.mode]}${POSITION_DEQUANT_GLSL}${SURFEL_BASIS_GLSL}${SURFEL_GAUSSIAN_GLSL}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vec3 centre = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);

    vAlpha = ${MODE_ALPHA[cfg.mode]};
${temporalBody}    vAlpha *= (uUseFeatureConfidence > 0.5) ? aConfidence : 1.0;
    vAlpha *= uBaseAlpha;
${cfg.filter ? FILTER_BODY : ''}
    // Quad corner in [-1,1]²; the fragment stage evaluates the Gaussian on it.
    vec2 corner = vec2(aCorner.x, aCorner.y * 2.0 - 1.0);
    vDisk = corner;

    vec2 halfExtent = ((uUseFeatureExtent > 0.5) ? aExtent : uSize) * uSizeScale;
    halfExtent = max(halfExtent, vec2(uMinExtentMeters));

    mat3 frame = sttSurfelBasis(
      (uUseFeatureQuat > 0.5) ? aQuat : vec4(0.0, 0.0, 0.0, 1.0));
    // frame[0] = tangent, frame[1] = bitangent (frame[2], the normal, is the
    // axis the disk has no extent along).
    vec3 offENU = frame[0] * (corner.x * halfExtent.x)
                + frame[1] * (corner.y * halfExtent.y);

    // ENU north is +y; mercator y grows southward — hence the flip.
    vec2 posM = centre.xy + vec2(offENU.x, -offENU.y) * uMercatorPerMeter;
    float elevM =
      ((uUseFeatureElevation > 0.5) ? aElevation : 0.0) * uElevationScale
      + offENU.z;

${projection}    gl_Position = here;
${payloadAssign}  }
`;
}

/** Visual vertex source for a host shader variant + feature configuration. */
export function buildSurfelVertexSource(
  shader: ShaderInjection,
  cfg: SurfelShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildSurfelVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildSurfelVertexSource}. */
export function buildSurfelIdVertexSource(
  shader: ShaderInjection,
  cfg: SurfelShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildSurfelVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `getOrCreateProgram` appends `::${variantName}` (the HOST variant) only, so
 * every other structural axis has to be here.
 */
export function surfelProgramKey(
  pass: 'main' | 'pick',
  cfg: SurfelShaderConfig,
): string {
  return `surfel:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}${
    cfg.temporal ? ':temporal' : ''
  }`;
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence when `mode` is unset and the "a degenerate length lights
 * nothing" guard when it is set. Exported for the prop-default tests.
 */
export function resolveSurfelTimeFilterMode(
  mode: SurfelTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): SurfelTimeFilterMode {
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
 * The gate both fragment stages share, verbatim. Keeping it a single constant
 * spliced into two sources is the mechanical guarantee that the pick pass is
 * never more permissive than the visual one — the rule a hand-copied second
 * `discard` would break silently, and which no rasterization-free test suite
 * could catch by rendering.
 */
const FS_GATE = `    if (vAlpha <= 0.0) discard;
    float w = sttSurfelDiskWeight(vDisk, uFalloffK);
    float a = vAlpha * w;
    if (a <= uAlphaCutoff) discard;
`;

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec2 vDisk;
  varying vec3 vColor;
  uniform float uFalloffK;
  uniform float uAlphaCutoff;
${SURFEL_GAUSSIAN_GLSL}
  void main() {
${FS_GATE}    gl_FragColor = vec4(vColor, a);
  }
`;

// The id pass runs the SAME gate and then paints a flat, opaque, un-blended,
// un-antialiased id colour: a partially-covered edge texel must still decode to
// the exact id byte triple.
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec2 vDisk;
  varying vec3 vIdColor;
  uniform float uFalloffK;
  uniform float uAlphaCutoff;
${SURFEL_GAUSSIAN_GLSL}
  void main() {
${FS_GATE}    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

/**
 * Locations every surfel program shares — geometry, orientation, sizing,
 * elevation, time-filter and DataFilter. Absent uniforms come back null (a
 * no-op for `gl.uniform*`) and absent attributes come back -1, which is exactly
 * how a mode/filter combination that doesn't declare them reads.
 */
interface SurfelSharedHandles
  extends TimeUniformLocations, DataFilterUniformLocations {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aCorner: number;
  aMercator: number;
  aTime: number;
  aQuat: number;
  aExtent: number;
  aElevation: number;
  aConfidence: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uSize: WebGLUniformLocation | null;
  uSizeScale: WebGLUniformLocation | null;
  uMinExtentMeters: WebGLUniformLocation | null;
  uUseFeatureExtent: WebGLUniformLocation | null;
  uUseFeatureQuat: WebGLUniformLocation | null;
  uUseFeatureElevation: WebGLUniformLocation | null;
  uUseFeatureConfidence: WebGLUniformLocation | null;
  uElevationScale: WebGLUniformLocation | null;
  uMercatorPerMeter: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
  uBaseAlpha: WebGLUniformLocation | null;
  uSurfelNow: WebGLUniformLocation | null;
  uTemporalInvSigma: WebGLUniformLocation | null;
  uFalloffK: WebGLUniformLocation | null;
  uAlphaCutoff: WebGLUniformLocation | null;
}

interface SurfelIdProgramHandles extends SurfelSharedHandles {
  aIdColor: number;
}

interface SurfelProgramHandles extends SurfelSharedHandles {
  aColor: number;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/** Per-surfel attribute buffers held alongside the standard TileGpuCache. */
interface SurfelGpuCache extends TileGpuCache {
  /** One instance per surfel — the same count as `vertexCount` for a point tile. */
  instanceCount: number;
  quatBuffer?: WebGLBuffer;
  extentBuffer?: WebGLBuffer;
  elevationBuffer?: WebGLBuffer;
  confidenceBuffer?: WebGLBuffer;
  colorBuffer?: WebGLBuffer;
  filterBuffer?: WebGLBuffer;
  hasFilterColumn?: boolean;
  /** METRES → mercator XY units at this tile's centre latitude. */
  mercatorPerMeter: number;
  /** METRES → mercator Z at this tile's centre latitude. */
  mercatorZPerMeter: number;
  /**
   * Program the cached VAO's attribute locations were recorded against, as
   * `${programKey}::${variantName}`. A VAO stores attribute SLOTS, which are
   * per-program — a host variant flip or a compiled-mode flip may reassign them.
   */
  vaoVariant?: string;
}

/**
 * Unpack a smallest-three quaternion: three stored components plus the INDEX of
 * the dropped one, which is reconstructed as `√(1 − a² − b² − c²)` and always
 * taken positive (a quaternion and its negation are the same rotation, so the
 * encoder is free to drop the sign).
 *
 * Byte-for-byte the same reconstruction as
 * `packages/cesium/src/lib/surfels.ts::unpackSmallestThree` — transcribed, not
 * imported, because this package may not depend on a sibling backend.
 */
export function unpackSmallestThreeQuat(
  a: number,
  b: number,
  c: number,
  imax: number,
): [number, number, number, number] {
  const d = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
  const m = Math.round(imax);
  if (m === 0) return [d, a, b, c];
  if (m === 1) return [a, d, b, c];
  if (m === 2) return [a, b, d, c];
  return [a, b, c, d];
}

/**
 * MapLibre custom layer that renders STT point tiles as oriented anisotropic
 * Gaussian surfels.
 *
 * ```ts
 * const layer = new STTSurfelLayer({
 *   id: 'lidar',
 *   url: '/data/sweep.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 2_000,
 *   temporalSigma: 400,
 *   minSizePixels: 1.5,
 * });
 * map.addLayer(layer);
 * ```
 */
export class STTSurfelLayer extends STTFilterableLayer {
  /**
   * Surfels are real oriented geometry in 3D: two disks that overlap on screen
   * must be resolved by DEPTH, not by which tile happened to draw last. This
   * also makes the base allocate a depth attachment on the pick FBO, so a pick
   * returns the surfel actually in front.
   */
  override readonly renderingMode: '2d' | '3d' = '3d';

  private surfelOpts: {
    color: [number, number, number, number];
    opacity: number;
    colorColumns: [string, string, string];
    opacityProperty: string;
    quaternionColumns: [string, string, string, string];
    packedQuaternionColumns: [string, string, string, string];
    extentColumns: [string, string];
    size: [number, number];
    sizeUnits: 'meters' | 'pixels';
    sizeScale: number;
    minSizePixels: number;
    elevationProperty: string;
    elevationScale: number;
    falloffSigmas: number;
    temporalSigma: number;
    alphaCutoff: number;
    timeFilterMode?: SurfelTimeFilterMode;
    wakeLength: number;
    trailLength: number;
    fadeTrail: number;
  };
  /** Compiled feature configuration; drives the program-cache keys. */
  private shaderConfig: SurfelShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /** `${mainKey}::${variantName}` — the tile-VAO staleness key. */
  private mainVaoKey = '';
  private handles?: SurfelProgramHandles;
  private handlesVariant?: string;
  private idHandles?: SurfelIdProgramHandles;
  private idHandlesVariant?: string;
  /** One-shot warning when a runtime has no instancing at all. */
  private warnedNoInstancing = false;

  constructor(opts: STTSurfelLayerOptions) {
    super(opts);
    this.surfelOpts = {
      color: opts.color ?? [200, 205, 214, 255],
      opacity: opts.opacity ?? 1,
      colorColumns:
        opts.colorColumns ??
        ([...SURFEL_DEFAULT_COLOR_COLUMNS] as [string, string, string]),
      opacityProperty: opts.opacityProperty ?? 'surfel_opacity',
      quaternionColumns:
        opts.quaternionColumns ??
        ([...SURFEL_DEFAULT_QUATERNION_COLUMNS] as [
          string,
          string,
          string,
          string,
        ]),
      packedQuaternionColumns:
        opts.packedQuaternionColumns ??
        ([...SURFEL_DEFAULT_PACKED_QUATERNION_COLUMNS] as [
          string,
          string,
          string,
          string,
        ]),
      extentColumns:
        opts.extentColumns ??
        ([...SURFEL_DEFAULT_EXTENT_COLUMNS] as [string, string]),
      size: opts.size ?? [1, 1],
      sizeUnits: opts.sizeUnits ?? 'meters',
      sizeScale: opts.sizeScale ?? 1,
      minSizePixels: opts.minSizePixels ?? 0,
      elevationProperty: opts.elevationProperty ?? 'z',
      elevationScale: opts.elevationScale ?? 1,
      falloffSigmas: opts.falloffSigmas ?? 3,
      temporalSigma: opts.temporalSigma ?? 0,
      alphaCutoff: opts.alphaCutoff ?? 0.01,
      timeFilterMode: opts.timeFilterMode,
      wakeLength: opts.wakeLength ?? 0,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.shaderConfig = {
      mode: this.resolveMode(),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered.
      filter: Boolean(opts.filterProperty),
      temporal: this.surfelOpts.temporalSigma > 0,
    };
    this.mainKey = surfelProgramKey('main', this.shaderConfig);
    this.pickKey = surfelProgramKey('pick', this.shaderConfig);
  }

  private resolveMode(): SurfelTimeFilterMode {
    return resolveSurfelTimeFilterMode(
      this.surfelOpts.timeFilterMode,
      this.surfelOpts.wakeLength,
      this.surfelOpts.trailLength,
    );
  }

  /** Update the constant fallback colour at runtime. */
  setColor(color: [number, number, number, number]): void {
    this.surfelOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Update the constant `[major, minor]` half-extent fallback at runtime. */
  setSize(size: [number, number]): void {
    this.surfelOpts.size = size;
    this.map?.triggerRepaint();
  }

  /** Update the layer opacity multiplier at runtime. */
  setOpacity(opacity: number): void {
    this.surfelOpts.opacity = opacity;
    this.map?.triggerRepaint();
  }

  /**
   * Update the radial Gaussian's tightness at runtime. A pure uniform — no
   * relink, because `falloffSigmas` feeds `uFalloffK` rather than the source.
   */
  setFalloffSigmas(falloffSigmas: number): void {
    this.surfelOpts.falloffSigmas = falloffSigmas;
    this.map?.triggerRepaint();
  }

  /**
   * Update the temporal Gaussian's σ (ms). Crossing 0 in either direction is
   * STRUCTURAL — the term is compiled in or out — so this may link a second
   * program on the next frame.
   */
  setTemporalSigma(temporalSigma: number): void {
    this.surfelOpts.temporalSigma = temporalSigma;
    this.applyShaderConfig();
  }

  /** Switch time-filter mode at runtime (links a second program). */
  setTimeFilterMode(mode: SurfelTimeFilterMode): void {
    this.surfelOpts.timeFilterMode = mode;
    this.applyShaderConfig();
  }

  /** Update the wake length (ms) — selects wake mode when it goes positive. */
  setWakeLength(wakeLength: number): void {
    this.surfelOpts.wakeLength = wakeLength;
    this.applyShaderConfig();
  }

  /** Update the trail length (ms) — selects trail mode when it goes positive. */
  setTrailLength(trailLength: number): void {
    this.surfelOpts.trailLength = trailLength;
    this.applyShaderConfig();
  }

  /**
   * Recompute the compiled configuration after a structural knob moved,
   * dropping the memoized handles so the next draw resolves (and links, once)
   * the program for the new key. Tile VAOs carry the key in `vaoVariant` and
   * rebuild themselves on the same draw.
   */
  private applyShaderConfig(): void {
    const mode = this.resolveMode();
    const temporal = this.surfelOpts.temporalSigma > 0;
    if (
      mode === this.shaderConfig.mode &&
      temporal === this.shaderConfig.temporal
    ) {
      this.map?.triggerRepaint();
      return;
    }
    this.shaderConfig = { ...this.shaderConfig, mode, temporal };
    this.mainKey = surfelProgramKey('main', this.shaderConfig);
    this.pickKey = surfelProgramKey('pick', this.shaderConfig);
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  /** Resolve the locations every surfel program declares. */
  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): SurfelSharedHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aQuat: gl.getAttribLocation(program, 'aQuat'),
      aExtent: gl.getAttribLocation(program, 'aExtent'),
      aElevation: gl.getAttribLocation(program, 'aElevation'),
      aConfidence: gl.getAttribLocation(program, 'aConfidence'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uSizeScale: gl.getUniformLocation(program, 'uSizeScale'),
      uMinExtentMeters: gl.getUniformLocation(program, 'uMinExtentMeters'),
      uUseFeatureExtent: gl.getUniformLocation(program, 'uUseFeatureExtent'),
      uUseFeatureQuat: gl.getUniformLocation(program, 'uUseFeatureQuat'),
      uUseFeatureElevation: gl.getUniformLocation(
        program,
        'uUseFeatureElevation',
      ),
      uUseFeatureConfidence: gl.getUniformLocation(
        program,
        'uUseFeatureConfidence',
      ),
      uElevationScale: gl.getUniformLocation(program, 'uElevationScale'),
      uMercatorPerMeter: gl.getUniformLocation(program, 'uMercatorPerMeter'),
      uMercatorZPerMeter: gl.getUniformLocation(program, 'uMercatorZPerMeter'),
      uBaseAlpha: gl.getUniformLocation(program, 'uBaseAlpha'),
      uSurfelNow: gl.getUniformLocation(program, 'uSurfelNow'),
      uTemporalInvSigma: gl.getUniformLocation(program, 'uTemporalInvSigma'),
      uFalloffK: gl.getUniformLocation(program, 'uFalloffK'),
      uAlphaCutoff: gl.getUniformLocation(program, 'uAlphaCutoff'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
    };
  }

  /** Link the visual program for a variant and resolve its locations. */
  private buildMainHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): SurfelProgramHandles {
    const program = this.linkProgram(
      gl,
      buildSurfelVertexSource(shader, this.shaderConfig),
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
  ): SurfelIdProgramHandles {
    const program = this.linkProgram(
      gl,
      buildSurfelIdVertexSource(shader, this.shaderConfig),
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
    // frame); a v5 host links its own lazily through the base per-variant
    // program cache on first draw.
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
    // Program lifetimes belong to the base per-variant cache; only the handle
    // references are ours to clear.
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  /**
   * Build the per-surfel quaternion buffer, `(x, y, z, w)` interleaved.
   *
   * Prefers the four full components; falls back to the smallest-three PACKED
   * columns, unpacked on the CPU so the shader only ever sees a full `vec4` —
   * one program serves both encodings. A tile with neither renders with the
   * identity quaternion (a disk flat in the local tangent plane), which is the
   * honest reading of "no orientation was baked" and is never blank.
   */
  private buildQuaternions(
    features: STTLayer['features'],
    count: number,
  ): Float32Array | null {
    const o = this.surfelOpts;
    const full = o.quaternionColumns.map((n) =>
      this.getNumericProperty(features, n),
    );
    if (full.every((c) => c !== null)) {
      const [qx, qy, qz, qw] = full as Float32Array[];
      const out = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        out[i * 4] = qx[i]!;
        out[i * 4 + 1] = qy[i]!;
        out[i * 4 + 2] = qz[i]!;
        out[i * 4 + 3] = qw[i]!;
      }
      return out;
    }
    const packed = o.packedQuaternionColumns.map((n) =>
      this.getNumericProperty(features, n),
    );
    if (packed.every((c) => c !== null)) {
      const [pa, pb, pc, pi] = packed as Float32Array[];
      const out = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const q = unpackSmallestThreeQuat(pa[i]!, pb[i]!, pc[i]!, pi[i]!);
        out[i * 4] = q[0];
        out[i * 4 + 1] = q[1];
        out[i * 4 + 2] = q[2];
        out[i * 4 + 3] = q[3];
      }
      return out;
    }
    return null;
  }

  /** Interleave the two half-extent columns into one `vec2` buffer, METRES. */
  private buildExtents(
    features: STTLayer['features'],
    count: number,
  ): Float32Array | null {
    const [majorCol, minorCol] = this.surfelOpts.extentColumns;
    const major = this.getNumericProperty(features, majorCol);
    const minor = this.getNumericProperty(features, minorCol);
    if (!major || !minor) return null;
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      out[i * 2] = major[i]!;
      out[i * 2 + 1] = minor[i]!;
    }
    return out;
  }

  /**
   * Interleave the three 0–255 colour columns into an RGB byte buffer. Colour
   * is per-surfel MEASURED radiance here, not a categorical palette lookup —
   * hence three numeric columns rather than `colorProperty` + palette.
   */
  private buildColors(
    features: STTLayer['features'],
    count: number,
  ): Uint8Array | null {
    const [rCol, gCol, bCol] = this.surfelOpts.colorColumns;
    const r = this.getNumericProperty(features, rCol);
    const g = this.getNumericProperty(features, gCol);
    const b = this.getNumericProperty(features, bCol);
    if (!r || !g || !b) return null;
    const out = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      out[i * 3] = Math.max(0, Math.min(255, Math.round(r[i]!)));
      out[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g[i]!)));
      out[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b[i]!)));
    }
    return out;
  }

  /**
   * Build the per-tile cache: the base's quantized positions + times, plus the
   * per-surfel orientation / extent / elevation / confidence / colour / filter
   * buffers, plus the two metres→mercator factors at this tile's centre
   * latitude (mercator's local scale is isotropic, so XY and Z share the
   * derivation but not the value — Z carries maplibre's own altitude
   * convention).
   *
   * Every buffer allocated here is pushed into `extraBuffers`; the base's
   * `deleteCacheBuffers` only knows the named fields plus that array.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): SurfelGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, tile, layer);
    if (!baseCache) return null;
    const f = layer.features;
    const count = baseCache.vertexCount;
    const lat = tileCenterLatitude(tile.id.z, tile.id.y);
    const cache: SurfelGpuCache = Object.assign(baseCache as SurfelGpuCache, {
      instanceCount: count,
      mercatorPerMeter: metersToMercatorUnits(1, lat),
      mercatorZPerMeter: mercatorZFromAltitude(1, lat),
    });
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];

    const quats = this.buildQuaternions(f, count);
    if (quats) {
      cache.quatBuffer = this.uploadArrayBuffer(gl, quats);
      extras.push(cache.quatBuffer);
    }

    const extents = this.buildExtents(f, count);
    if (extents) {
      cache.extentBuffer = this.uploadArrayBuffer(gl, extents);
      extras.push(cache.extentBuffer);
    }

    const elevations = this.getNumericProperty(
      f,
      this.surfelOpts.elevationProperty,
    );
    if (elevations) {
      cache.elevationBuffer = this.uploadArrayBuffer(gl, elevations);
      extras.push(cache.elevationBuffer);
    }

    const confidence = this.getNumericProperty(
      f,
      this.surfelOpts.opacityProperty,
    );
    if (confidence) {
      cache.confidenceBuffer = this.uploadArrayBuffer(gl, confidence);
      extras.push(cache.confidenceBuffer);
    }

    const colors = this.buildColors(f, count);
    if (colors) {
      cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
      extras.push(cache.colorBuffer);
    }

    if (this.shaderConfig.filter) {
      // One surfel == one instance, so the per-FEATURE column binds directly
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

  /**
   * Metres per screen pixel at this tile's centre latitude and the map's
   * FRACTIONAL zoom — the inverse of {@link STTBaseLayer.metricPixelScale}.
   * Both pixel-flavoured knobs (`sizeUnits: 'pixels'` and `minSizePixels`) go
   * through it, so the shader only ever receives METRES and the geometry stays
   * genuine world-space geometry in every mode.
   */
  private metersPerPixel(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const pxPerMeter = this.metricPixelScale(gl, tile, ctx);
    return pxPerMeter > 0 ? 1 / pxPerMeter : 0;
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active
   * mode's uniforms exist in the program, so the switch is also what keeps a
   * stale mode's uniform from being written to a null location every draw. All
   * times are TILE-RELATIVE: absolute minus the tile's own `timeOffset`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: SurfelSharedHandles,
    cache: SurfelGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.surfelOpts;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
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
   * Projection + orientation + sizing + time + filter + Gaussian uniforms —
   * everything the visual and id passes set IDENTICALLY, so the pickable disk
   * is always the drawn disk (including on globe, where the prelude owns
   * projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: SurfelSharedHandles,
    tile: Tile,
    cache: SurfelGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    const o = this.surfelOpts;
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude owns projection.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform3fv(h.uPosScale, cache.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, cache.posOffset ?? ZERO_POS_OFFSET);

    // Sizing: one metres-per-pixel resolve per tile serves both pixel knobs.
    const mPerPx =
      o.sizeUnits === 'pixels' || o.minSizePixels > 0
        ? this.metersPerPixel(gl, tile, ctx)
        : 0;
    const unitScale = o.sizeUnits === 'pixels' ? mPerPx : 1;
    gl.uniform2f(h.uSize, o.size[0], o.size[1]);
    gl.uniform1f(h.uSizeScale, o.sizeScale * unitScale);
    gl.uniform1f(h.uMinExtentMeters, o.minSizePixels * mPerPx);

    gl.uniform1f(h.uElevationScale, o.elevationScale);
    gl.uniform1f(h.uMercatorPerMeter, cache.mercatorPerMeter);
    gl.uniform1f(h.uMercatorZPerMeter, cache.mercatorZPerMeter);

    // Base alpha folds the constant colour's alpha channel into the layer
    // opacity so both passes carry it in ONE uniform the id pass also reads.
    const rgba = this.rgba01Uniform('Color', o.color);
    gl.uniform1f(h.uBaseAlpha, rgba[3] * o.opacity);
    gl.uniform1f(h.uFalloffK, o.falloffSigmas * o.falloffSigmas);
    gl.uniform1f(h.uAlphaCutoff, o.alphaCutoff);

    gl.uniform1f(h.uSurfelNow, ctx.currentTime - cache.timeOffset);
    if (this.shaderConfig.temporal) {
      gl.uniform1f(h.uTemporalInvSigma, 1 / o.temporalSigma);
    }
    this.setTimeUniforms(gl, h, cache, ctx);

    // A tile that didn't bake the column resolves to `enabled: 0`, which the
    // kernel reads as "render everything" — never as "hide everything".
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn === true);
    }

    // useFeature* uniforms are program-level, not VAO-recorded; set them every
    // draw so a tile with a different column set is read correctly.
    gl.uniform1f(h.uUseFeatureQuat, cache.quatBuffer && h.aQuat >= 0 ? 1 : 0);
    gl.uniform1f(
      h.uUseFeatureExtent,
      cache.extentBuffer && h.aExtent >= 0 ? 1 : 0,
    );
    gl.uniform1f(
      h.uUseFeatureElevation,
      cache.elevationBuffer && h.aElevation >= 0 ? 1 : 0,
    );
    gl.uniform1f(
      h.uUseFeatureConfidence,
      cache.confidenceBuffer && h.aConfidence >= 0 ? 1 : 0,
    );
  }

  /**
   * Bind the per-vertex quad and every per-instance attribute both passes
   * share. Divisor 1 on everything except `aCorner`, which is the only genuinely
   * per-vertex input.
   */
  private bindSharedAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: SurfelSharedHandles,
    cache: SurfelGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.getUnitQuad(gl));
    gl.enableVertexAttribArray(h.aCorner);
    gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCorner, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aMercator, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aTime, 1);

    if (cache.quatBuffer && h.aQuat >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.quatBuffer);
      gl.enableVertexAttribArray(h.aQuat);
      gl.vertexAttribPointer(h.aQuat, 4, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aQuat, 1);
    }
    if (cache.extentBuffer && h.aExtent >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.extentBuffer);
      gl.enableVertexAttribArray(h.aExtent);
      gl.vertexAttribPointer(h.aExtent, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aExtent, 1);
    }
    if (cache.elevationBuffer && h.aElevation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.elevationBuffer);
      gl.enableVertexAttribArray(h.aElevation);
      gl.vertexAttribPointer(h.aElevation, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aElevation, 1);
    }
    if (cache.confidenceBuffer && h.aConfidence >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.confidenceBuffer);
      gl.enableVertexAttribArray(h.aConfidence);
      gl.vertexAttribPointer(h.aConfidence, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aConfidence, 1);
    }
    if (cache.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 1);
    }
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    if (!this.instSupport.enabled) {
      // No instancing → no surfels. There is no non-instanced fallback: an
      // expanded 4-vertex-per-surfel buffer would quadruple every per-surfel
      // column. Logged once so a host can detect and swap layers.
      if (!this.warnedNoInstancing) {
        this.warnedNoInstancing = true;
        console.warn('STTSurfelLayer requires instancing.');
      }
      return;
    }
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    let h = this.handles;
    if (!h || this.handlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.mainKey, frame, (g, s) =>
        this.buildMainHandles(g, s),
      );
      this.handles = h;
      this.handlesVariant = variant;
      // `mainKey` and `variant` are the only two inputs, and applyShaderConfig
      // clears `handlesVariant` whenever `mainKey` moves — so this branch is
      // exactly the set of frames where the VAO key can change.
      this.mainVaoKey = `${this.mainKey}::${variant}`;
    }
    const c = cache as SurfelGpuCache;

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);
    // vec4 rather than vec3 so the shared `rgba01Uniform` scratch uploads
    // unsplit; the VS reads `.rgb` and the alpha rides `uBaseAlpha` instead
    // (the id pass needs that alpha too, and has no colour uniform).
    gl.uniform4fv(h.uColor, this.rgba01Uniform('Color', this.surfelOpts.color));
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);

    // A VAO records attribute locations against ONE program — drop it when the
    // host flipped shader variants, or the layer flipped a compiled mode.
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
        gl.vertexAttribPointer(h!.aColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
        this.instSupport.vertexAttribDivisor(h!.aColor, 1);
      }
    });
    c.vaoVariant = vaoKey;

    // 4 corner verts as a TRIANGLE_STRIP × one instance per surfel. No
    // gl_VertexID, so this runs on WebGL1 + ANGLE_instanced_arrays too.
    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );
  }

  /**
   * Draw this surfel tile into the id-pick FBO, painting surfel `i` the flat
   * colour `encodePickId(idBase + i)`. Mirrors {@link drawTile}'s projection,
   * orientation and sizing — same builder, `kind: 'id'` — and, critically, its
   * ALPHA GATES: the same time-filter mode, temporal Gaussian, per-surfel
   * confidence, DataFilter range, radial profile and `alphaCutoff`, from the
   * shared {@link FS_GATE}. A surfel the user cannot see is never pickable, and
   * the pickable footprint is the ELLIPSE, not the quad.
   *
   * The per-surfel id buffer is rebuilt each pick and freed immediately:
   * `idBase` shifts with whatever tiles are loaded this frame, and picks are
   * rare user-initiated events.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    if (!this.instSupport.enabled) return;
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
    const c = cache as SurfelGpuCache;
    // One surfel == one feature == one instance.
    const count = c.instanceCount;
    const idColors = this.buildPickIdColors(count, idBase);
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);

    // Raw attribute binds (no VAO): picking is a rare pass issued from outside
    // the host render loop, and the id buffer is per-pass.
    this.bindSharedAttributes(gl, h, c);

    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aIdColor, 1);

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      count,
    );

    // Leave the default-VAO attribute slate clean (divisors included — a stray
    // divisor 1 on a per-vertex slot is invisible until the next layer draws).
    const touched: Array<[number, boolean]> = [
      [h.aCorner, true],
      [h.aMercator, true],
      [h.aTime, true],
      [h.aIdColor, true],
      [h.aQuat, Boolean(c.quatBuffer)],
      [h.aExtent, Boolean(c.extentBuffer)],
      [h.aElevation, Boolean(c.elevationBuffer)],
      [h.aConfidence, Boolean(c.confidenceBuffer)],
      [h.aFilterValue, Boolean(c.filterBuffer)],
    ];
    for (const [loc, used] of touched) {
      if (!used || loc < 0) continue;
      gl.disableVertexAttribArray(loc);
      this.instSupport.vertexAttribDivisor(loc, 0);
    }
    gl.deleteBuffer(idBuffer);
  }
}
