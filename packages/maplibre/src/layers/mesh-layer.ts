/**
 * Mesh geometry adapter — renders POINT-type tiles as instanced 3D MODELS that
 * glide continuously along their tracks.
 *
 * ── What it renders ─────────────────────────────────────────────────────────
 * An AV archive's `objects/` layer is a stream of SNAPSHOTS: one row per
 * detected object per lidar sweep, ~10 Hz, each carrying `track_id`, a pose
 * (`heading`, optionally a `qx/qy/qz/qw` quaternion), box dimensions
 * (`length`/`width`/`height`) and a class. Drawn literally, that is a stuttering
 * cloud of 10 models per second per car, all of them present at once inside any
 * `timeWindow` wide enough to be useful.
 *
 * This layer draws the OBJECT, not the snapshot. Resident tiles are pooled by
 * `track_id` through the core track kernel (`buildTrackIndex`, the same engine
 * behind the deck/three/icon glide paths), and every frame each ACTIVE track is
 * interpolated to the playhead exactly once — **one model per tracked object per
 * frame, never one model per keyframe.** That is the defining constraint of
 * this kind and of its sibling `boundingBox`; everything else here follows from
 * it.
 *
 * Pooling happens per TILE, at tile-upload time, and is cached with the tile's
 * GPU buffers. A track whose snapshots straddle a tile boundary therefore pools
 * into two partial tracks and briefly draws two models — the same trade
 * `STTTripHeadsLayer` makes, and a non-issue for the AV scenes this kind
 * targets (a whole 20-second scene lives inside one tile at the zooms it is
 * viewed at). The alternative — a layer-level index — cannot express
 * tile-relative time, which is what keeps every timestamp in this backend
 * inside float32's honest range.
 *
 * ── Motion ──────────────────────────────────────────────────────────────────
 * Keyframe times are rebased to ABSOLUTE epoch-ms by the kernel, so the playhead
 * goes into `sampleTrack` unmodified; only the `[start, end]` pair that feeds
 * the GPU time gate is relativized against `cache.timeOffset`. Position, box
 * dimensions and speed lerp; HEADING takes the SHORTEST ARC (`lerpAngle`), so a
 * vehicle crossing due north swings 2° rather than spinning 358° the other way.
 * `maxInterpolationGap` HOLDS the last pose instead of fabricating straight-line
 * motion across a data hole.
 *
 * ── Attitude ────────────────────────────────────────────────────────────────
 * Heading alone is a yaw. Real vehicles pitch over crests and bank into turns,
 * and archives that know it carry a quaternion. So `quaternionProperties`
 * accepts four numeric columns `(qx, qy, qz, qw)`; when present, the per-frame
 * attitude is a SLERP of the bracketing keyframes — shortest-arc, sign-flipped
 * so `q` and `-q` (the same rotation, opposite representation) never take the
 * long way round. See `shaders/mesh-attitude.glsl.ts`. Without those columns the
 * layer synthesizes a yaw-only quaternion from the interpolated heading, so the
 * fallback path is the same shader with a degenerate rotation rather than a
 * second code path.
 *
 * The quaternion keyframes are pooled in this layer's own pass, keyed by the
 * same track id and bracket-searched independently of the kernel's arrays. That
 * decoupling is deliberate: the kernel sorts and de-dups its keyframes, and
 * joining by INDEX to a structure that reserves the right to compact would be a
 * silent correctness bug the moment it did.
 *
 * ── Geometry ────────────────────────────────────────────────────────────────
 * The model is a STATIC per-layer prop, not tile data: `mesh` (positions,
 * optional normals, optional indices) or `meshes`, a per-CATEGORY map so cars,
 * pedestrians and cyclists get different models. That map is the exact analogue
 * of `STTIconLayer`'s atlas, and the category is the same `colorProperty` value
 * the kernel already bakes into `Track.category` — one categorical read, two
 * consumers.
 *
 * Model space is `+x` FORWARD, `+y` LEFT, `+z` UP, sized so that
 * `scaleToDimensions` (default `true`) multiplying by `[length, width, height]`
 * yields the object's real footprint — i.e. a unit box spanning
 * `[-0.5, 0.5]³`. `orientationOffset` is a static euler XYZ triple (radians)
 * that rotates a model whose author pointed it down `-z` or `+y` into that
 * frame; it is composed with the instance attitude ON THE CPU, once per
 * instance, so the shader has exactly one rotation to do.
 *
 * ── Buffers ─────────────────────────────────────────────────────────────────
 * Poses cannot be baked — they change every frame by construction — so this
 * layer does write GPU memory per tick. It does so into buffers it allocated
 * ONCE, at tile-cache build, sized to the tile's track count, and refills a
 * PREFIX of them with `bufferSubData`. The CPU staging arrays are per-LAYER and
 * grow-only. Nothing is reallocated per tick, and nothing is allocated per
 * instance except the small `Sample` the kernel returns.
 *
 * Instances are emitted in CATEGORY order (precomputed once per tile), so each
 * category's active instances stay contiguous and one `drawElementsInstanced`
 * covers each. The per-category instance offset changes every frame, which is
 * why this layer binds raw attribute pointers instead of caching a VAO: a VAO
 * records the offset, so a cached one would be stale the frame after it was
 * recorded — the failure mode that produces silently-wrong bindings rather than
 * a crash.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * Model-space metres reach the map through two different factors resolved at
 * the TILE'S OWN CENTRE latitude: horizontal metres via `metersToMercatorUnits`
 * (with the `y` term NEGATED, because ENU north is mercator-y DOWN), vertical
 * metres left in metres for `buildElevatedProjection` to spend as the host
 * variant requires (mercator-z under `uMatrix` and the v5 mercator prelude,
 * real metres under the globe prelude). A flat constant is latitude-blind and
 * several times wrong; never substitute one.
 *
 * `sizeUnits: 'pixels'` re-reads those dimensions as SCREEN pixels via the
 * shared `metricPixelScale` helper, giving a model that holds its apparent size
 * across zooms — useful for a schematic overlay, wrong for anything claiming to
 * be a measurement, hence `'meters'` is the default.
 *
 * ── Everything the package requires of a kind ───────────────────────────────
 *  - all four `timeFilterMode`s, compiled in (no mode uniform, no branch) and
 *    carried in the program-cache key; `wake` additionally shrinks the model
 *    toward `wakeTailScale`, which a model CAN do because its extent is a
 *    physical size and not geography;
 *  - the DataFilter kernel, compiled in only when `filterProperty` is set;
 *    `filterTransformSize` shrinks and `filterTransformColor` fades;
 *  - `renderingMode: '3d'` — genuinely volumetric geometry that must occlude
 *    itself, its neighbours and the basemap's own extrusions;
 *  - id-FBO picking through `drawPickTile`, whose alpha gates are the SAME
 *    expressions as the visual pass (same time kernel, same DataFilter, same
 *    colour-alpha gate), so a model the user cannot see is never pickable. Each
 *    instance paints the id of the snapshot that OPENED its track in this tile,
 *    so a pick resolves through the base's ordinary per-feature provenance to a
 *    real source row.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *  - **No mesh loading.** Positions/normals/indices arrive as typed arrays from
 *    the caller. glTF/OBJ parsing is a build-time concern and dragging a loader
 *    in here would breach the package's one-runtime-dependency rule.
 *  - **No normal matrix.** Instances are rotated and NON-UNIFORMLY scaled, so a
 *    strictly correct normal needs the inverse transpose of that scale. This
 *    layer rotates the normal by the instance quaternion and ignores the scale.
 *    The error is a shading gradient on a车-shaped box whose axes differ by <2×;
 *    the cost of the correct version is a per-instance 3×3 the shader would
 *    rebuild for every vertex. Lighting here is a legibility aid, not a
 *    radiometric claim.
 *  - **No per-instance model matrix.** deck's `SimpleMeshLayer` exposes one;
 *    this kind's whole point is that the transform is DERIVED from the track,
 *    and a caller-supplied matrix would be a second, silently-conflicting
 *    source of orientation.
 *  - **No shadows, no PBR, no texture.** One directional term plus an ambient
 *    floor. A textured model needs an atlas, a sampler and a UV stream, which
 *    is a different kind, not a flag on this one.
 *  - **No chord subdivision.** A model is metres across; the globe curvature it
 *    spans is far below its own faceting. (`STTColumnLayer` documents the same
 *    boundary for its disks.)
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import {
  GeometryType,
  buildTrackIndex,
  sampleTrack,
  readCategorical,
  type Track,
  type TrackFieldConfig,
  type TrackSampleConfig,
  type TrackColor,
} from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
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
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
import {
  QUAT_ROTATE_GLSL,
  IDENTITY_QUAT,
  quatFromEulerXYZ,
  quatFromHeading,
  multiplyQuat,
  normalizeQuat,
  slerpQuat,
  type Quat,
} from '../shaders/mesh-attitude.glsl.js';
import {
  lngLatToMercatorInto,
  mercatorZFromAltitude,
  metersToMercatorUnits,
  tileCenterLatitude,
} from '../lib/projection.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's name.
 */
export type MeshTimeFilterMode = STTTimeFilterMode;

/** A static model, supplied by the caller. */
export interface STTMeshGeometry {
  /**
   * Vertex positions, stride 3, in MODEL space (`+x` forward, `+y` left,
   * `+z` up). Under the default `scaleToDimensions` these should span the unit
   * box `[-0.5, 0.5]³` so that scaling by `[length, width, height]` reproduces
   * the object's real footprint.
   */
  positions: Float32Array | ArrayLike<number>;
  /**
   * Vertex normals, stride 3, same vertex count as {@link positions}. Omitted ⇒
   * every vertex gets `+z`, which flattens the model to its ambient term. That
   * is a legible silhouette, not an error.
   */
  normals?: Float32Array | ArrayLike<number>;
  /**
   * Triangle indices. Omitted ⇒ the positions are drawn as a non-indexed
   * triangle soup (`drawArraysInstanced`).
   */
  indices?: Uint16Array | Uint32Array | ArrayLike<number>;
}

/** Options for {@link STTMeshLayer}. */
export interface STTMeshLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * The model every instance draws, unless {@link meshes} has an entry for its
   * category. Required in practice — with neither `mesh` nor a matching
   * `meshes` entry a category simply does not draw (once-warned).
   */
  mesh?: STTMeshGeometry;
  /**
   * Per-CATEGORY models, keyed by the value of {@link colorProperty} (the class
   * column: `car`, `pedestrian`, `bicycle`, …). A category with no entry falls
   * back to {@link mesh}. The analogue of the icon layer's atlas.
   */
  meshes?: Record<string, STTMeshGeometry>;
  /**
   * Multiply the model by each object's `[length, width, height]` before
   * placing it. `false` draws every instance at {@link sizeScale} alone, which
   * is what a model already authored at real-world size wants.
   * @default true
   */
  scaleToDimensions?: boolean;
  /**
   * Uniform multiplier on the final model size.
   * @default 1
   */
  sizeScale?: number;
  /**
   * How the model's dimensions are read. `'meters'` (default) is a real
   * ground-relative size; `'pixels'` re-reads them as SCREEN pixels at the
   * tile's centre latitude and the map's fractional zoom, holding apparent size
   * across zoom levels.
   * @default 'meters'
   */
  sizeUnits?: 'meters' | 'pixels';
  /**
   * Static euler XYZ triple (RADIANS) rotating the supplied model into this
   * layer's frame (`+x` forward). A model authored nose-down-`-y` takes
   * `[0, 0, Math.PI / 2]`. Composed with the per-instance attitude on the CPU.
   * @default [0, 0, 0]
   */
  orientationOffset?: [number, number, number];

  // ── track pooling ─────────────────────────────────────────────────────────
  /**
   * Categorical column pooling snapshots into one tracked object.
   * @default 'track_id'
   */
  trackIdProperty?: string;
  /**
   * Categorical column driving per-instance colour AND per-category model
   * dispatch (`Track.category`). Empty ⇒ every instance takes
   * {@link colorMappingDefault}.
   * @default 'category'
   */
  colorProperty?: string;
  /** Category → RGBA (0-255). Missing keys fall back to {@link colorMappingDefault}. */
  colorMapping?: Record<string, TrackColor> | null;
  /** Colour for a category with no {@link colorMapping} entry. @default [160,160,160,255] */
  colorMappingDefault?: TrackColor;
  /** Numeric heading column. @default 'heading' */
  headingProperty?: string;
  /**
   * Angular unit of {@link headingProperty}, selecting which shortest-arc lerp
   * the kernel applies. Radians are measured counter-clockwise from `+x` (east).
   * @default 'rad'
   */
  headingUnits?: 'rad' | 'deg';
  /**
   * The four numeric columns of a per-keyframe attitude quaternion, in
   * `(x, y, z, w)` order. All four must be present or the layer falls back to a
   * yaw-only quaternion built from {@link headingProperty}.
   * @default ['qx','qy','qz','qw']
   */
  quaternionProperties?: [string, string, string, string];
  /** Numeric dimension columns (METRES). @default 'length'/'width'/'height' */
  lengthProperty?: string;
  widthProperty?: string;
  heightProperty?: string;
  /** Numeric speed column (m/s), carried onto the pick row. @default 'speed' */
  speedProperty?: string;
  /** Fallback dimensions (METRES) when a column is absent. @default 4.5 / 2 / 1.8 */
  defaultLength?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  /**
   * Largest keyframe gap (ms) across which a pose is interpolated. Beyond it
   * the track HOLDS its last sample rather than gliding a path it never
   * travelled.
   * @default Infinity
   */
  maxInterpolationGap?: number;

  // ── styling ───────────────────────────────────────────────────────────────
  /** Overall multiplier on the composed alpha. @default 1 */
  opacity?: number;
  /** Ambient floor of the single directional light term. @default 0.45 */
  ambientLight?: number;
  /** Weight of the directional (lambert) term. @default 0.55 */
  diffuseLight?: number;
  /** Light direction in the local ENU frame (need not be normalized). @default [0.3,0.4,0.9] */
  lightDirection?: [number, number, number];

  // ── time filtering ────────────────────────────────────────────────────────
  timeFilterMode?: STTTimeFilterMode;
  wakeLength?: number;
  /** Size the model shrinks toward at the wake's tail. @default DEFAULT_WAKE_TAIL_SCALE */
  wakeTailScale?: number;
  trailLength?: number;
  fadeTrail?: boolean | number;

  /**
   * MapLibre `CustomLayerInterface.renderingMode`. `'3d'` (the DEFAULT, and the
   * only sane value for volumetric models) puts the layer in the host's shared
   * LEQUAL read-write depth mode, so models occlude one another and the
   * basemap's extrusions. `'2d'` restores always-on-top compositing, which is
   * only right for a translucent schematic. Read by the host at `addLayer`
   * time — set it in the constructor, not later.
   * @default '3d'
   */
  renderingMode?: '2d' | '3d';
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled mesh program supports. Both knobs are structural (they add
 * attributes, uniforms and statements), so each combination is its own program
 * and each must appear in the program-cache key — {@link meshProgramKey}.
 */
export interface MeshShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: MeshTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
}

/** The out-of-the-box configuration: window mode, no DataFilter. */
const DEFAULT_SHADER_CONFIG: MeshShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

/** The two draw passes, each with its own compiled program. */
export type MeshPass = 'fill' | 'pick-fill';

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<MeshTimeFilterMode, string>> = Object.freeze({
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
});

/**
 * Uniforms each mode reads. Only the active mode's block is declared, so an
 * unused uniform can never be silently mis-set. The wake block carries
 * `uWakeTailScale` because a model's extent is a physical SIZE and may taper —
 * unlike a summary cell, whose footprint is geography.
 */
const MODE_UNIFORMS: Readonly<Record<MeshTimeFilterMode, string>> =
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE;

/**
 * The `vAlpha = …` expression per mode. Every vertex of an instance carries its
 * TRACK's `[first, last]` keyframe span, so `trail` reads `aTime.x` — a model
 * reveals whole.
 */
const MODE_ALPHA: Readonly<Record<MeshTimeFilterMode, string>> = Object.freeze({
  window:
    'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
  wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
  cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
  trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
});

const FILTER_ATTRIBUTE = `  ${DATA_FILTER_ATTRIBUTE_GLSL}\n`;
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL;

/** Project a model vertex through whichever host variant is live. */
function projectBlock(
  usesPrelude: boolean,
  out: string,
  xy: string,
  elevM: string,
): string {
  return buildElevatedProjection({
    usesPrelude,
    xy,
    elevMeters: elevM,
    elevMercatorZ: `${elevM} * uMercatorZPerMeter`,
    names: {
      out,
      sphere: `${out}Sphere`,
      globe: `${out}Globe`,
      flat: `${out}Flat`,
    },
  });
}

/**
 * Declarations both mesh passes share: the model stream, the per-instance
 * stream and the sizing/lighting uniforms. `uMatrix` is declared only on the
 * legacy host — under a v5+ prelude the projection travels through
 * `projectTileFor3D` and an unread `uMatrix` would just be stripped anyway,
 * but declaring it would falsely suggest the layer reads it.
 */
function sharedDeclarations(
  usesPrelude: boolean,
  cfg: MeshShaderConfig,
): string {
  return `  attribute vec3 aModelPos;    // model-space vertex: +x forward, +y left, +z up
  attribute vec3 aModelNormal; // model-space normal (rotated, never scaled)
  attribute vec3 aInstPos;     // instance anchor: world-mercator xy + altitude METRES
  attribute vec4 aInstQuat;    // instance attitude (x,y,z,w), offset already composed in
  attribute vec3 aInstDims;    // [length, width, height] in model units
  attribute vec2 aTime;        // TILE-RELATIVE [trackStart, trackEnd]
  attribute float aFade;       // CPU appear/disappear ramp from sampleTrack
  attribute vec4 aColor;       // per-instance RGBA in 0..1
${cfg.filter ? FILTER_ATTRIBUTE : ''}${usesPrelude ? '' : '  uniform mat4 uMatrix;\n'}  uniform vec2 uMeterToMercator;  // horizontal metres → world-mercator (y NEGATED: ENU north is mercator-y down)
  uniform float uMercatorZPerMeter;
  uniform float uSizeScale;
  uniform float uOpacity;
  uniform vec3 uLightDirection;
  uniform vec2 uLightTerms;       // (ambient, diffuse)
`;
}

/**
 * The statements every pass runs before it has a position: compose the alpha
 * from the compiled time kernel and the CPU fade, let the wake taper and the
 * DataFilter act on SIZE, then apply the colour-alpha gate last so a tint's
 * opacity can never shrink the model.
 */
function preambleStatements(cfg: MeshShaderConfig, colorGate: string): string {
  const wakeTaper =
    cfg.mode === 'wake'
      ? '    sizeScale *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';
  const filterBlock = cfg.filter
    ? `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) sizeScale *= filterAlpha;
`
    : '';
  return `    vAlpha = ${MODE_ALPHA[cfg.mode]} * aFade;
    float sizeScale = uSizeScale;
${wakeTaper}${filterBlock}    vAlpha *= uOpacity;
${colorGate}`;
}

/**
 * Assemble the model vertex shader.
 *
 * A fully-gated instance is dropped twice over: `gl_Position = vec4(0.0)`
 * collapses it at the vertex stage (every gate here is per-INSTANCE, so the
 * whole model collapses — no vertex left pinned at the origin) and the fragment
 * stage's `if (vAlpha <= 0.0) discard;` backs that up.
 */
function buildMeshVs(
  shader: ShaderInjection,
  cfg: MeshShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  const idAttribute = isMain
    ? ''
    : '  attribute vec3 aIdColor;     // per-instance encoded pick id (UNSIGNED_BYTE normalized)\n';
  const payloadVarying = isMain
    ? '  varying vec4 vColor;\n  varying float vLight;\n'
    : '  varying vec3 vIdColor;\n';
  // The id pass reads the instance colour's ALPHA only: a model painted with a
  // zero-alpha `colorMapping` entry (the idiomatic "hide this class" spelling)
  // is invisible AND unpickable, matching deck's `picking_filterPickingColor`.
  const colorGate = isMain ? '' : '    vAlpha *= aColor.a;\n';
  const payloadAssign = isMain
    ? `    vColor = aColor;
    vec3 nrm = sttRotateByQuat(aInstQuat, aModelNormal);
    float lambert = max(dot(normalize(nrm), normalize(uLightDirection)), 0.0);
    vLight = uLightTerms.x + uLightTerms.y * lambert;
`
    : '    vIdColor = aIdColor;\n';

  return `${head}
  precision highp float;
${sharedDeclarations(usesPrelude, cfg)}${idAttribute}${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${payloadVarying}${MODE_GLSL[cfg.mode]}${QUAT_ROTATE_GLSL}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
${preambleStatements(cfg, colorGate)}    vec3 local = sttRotateByQuat(aInstQuat, aModelPos * aInstDims * sizeScale);
    vec2 posM = aInstPos.xy + local.xy * uMeterToMercator;
    float elevM = aInstPos.z + local.z;
${projectBlock(usesPrelude, 'here', 'posM', 'elevM')}    gl_Position = here;
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${payloadAssign}  }
`;
}

/** Visual model vertex source for a host variant + feature configuration. */
export function buildMeshVertexSource(
  shader: ShaderInjection,
  cfg: MeshShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildMeshVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildMeshVertexSource}. */
export function buildMeshIdVertexSource(
  shader: ShaderInjection,
  cfg: MeshShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildMeshVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `STTBaseLayer.getOrCreateProgram` appends `::${variantName}` (the HOST
 * variant) only, so two configurations sharing a base key would collide.
 */
export function meshProgramKey(pass: MeshPass, cfg: MeshShaderConfig): string {
  return `mesh:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
}

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  varying float vLight;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb * vLight, vColor.a * vAlpha);
  }
`;

/**
 * Id-pick fragment stage. No blending, no antialiasing: the readback must
 * recover the byte triple exactly. The `vAlpha` discard is what makes
 * time-filtered, DataFilter-hidden and zero-alpha models unpickable.
 */
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // invisible models are not pickable
    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;

/**
 * Degradation rule, verbatim from the package contract: an explicitly-named
 * mode whose knob is off degrades to `window`; an UNSET mode follows deck's
 * `TimeFilterExtension` precedence (wake, then trail, then window).
 */
export function resolveMeshTimeFilterMode(
  mode: STTTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): MeshTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

// ── program handles ─────────────────────────────────────────────────────────

interface MeshSharedHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  aModelPos: number;
  aModelNormal: number;
  aInstPos: number;
  aInstQuat: number;
  aInstDims: number;
  aTime: number;
  aFade: number;
  aColor: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uMeterToMercator: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
  uSizeScale: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uLightDirection: WebGLUniformLocation | null;
  uLightTerms: WebGLUniformLocation | null;
}

interface MeshHandles extends MeshSharedHandles {
  aIdColor: number;
}

// ── GPU state ───────────────────────────────────────────────────────────────

/** One uploaded model, keyed by category name (or `''` for the default). */
interface MeshGpuGeometry {
  positionBuffer: WebGLBuffer;
  normalBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer | null;
  indexType: number;
  vertexCount: number;
  indexCount: number;
}

/** A contiguous run of active instances sharing one model. */
interface MeshDrawGroup {
  category: string;
  start: number;
  count: number;
}

/** Per-track extras this layer pools itself, joined to the kernel by track id. */
interface TrackExtra {
  /** Index of the snapshot that OPENED this track in this tile — the pick id. */
  featureIndex: number;
  /** DataFilter value for that snapshot (`0` when the column is absent). */
  filterValue: number;
  /** Ascending absolute keyframe times for the quaternion arrays, or null. */
  quatTimes: Float64Array | null;
  /** Stride-4 `(x,y,z,w)` keyframes aligned to {@link quatTimes}. */
  quatValues: Float32Array | null;
}

interface MeshGpuCache extends TileGpuCache {
  instanceBuffer: WebGLBuffer;
  tracks: Track[];
  extras: TrackExtra[];
  /** Track indices in CATEGORY order, so active instances stay contiguous. */
  order: Uint32Array;
  /** `[category, startInOrder, countInOrder]` runs over {@link order}. */
  categoryRuns: { category: string; start: number; count: number }[];
  capacity: number;
  /** Source snapshot count — the width of the base's per-feature id range. */
  featureCount: number;
  hasFilterColumn: boolean;
  /** Filled per frame by {@link STTMeshLayer.emitInstances}. */
  activeFeatureIndex: Uint32Array;
  activeCount: number;
  groups: MeshDrawGroup[];
}

const LEGACY_FRAME: HostFrame = createHostFrame();

/** Float slots per instance, excluding the optional DataFilter value. */
const BASE_STRIDE = 17;

const DEFAULT_LIGHT_DIRECTION: [number, number, number] = [0.3, 0.4, 0.9];

/**
 * Instanced 3D models on a time-aware tileset, one per tracked object per
 * frame. See the file header for the full design rationale.
 */
export class STTMeshLayer extends STTFilterableLayer {
  override readonly renderingMode: '2d' | '3d';

  private readonly meshOpts: {
    mesh: STTMeshGeometry | null;
    meshes: Record<string, STTMeshGeometry> | null;
    scaleToDimensions: boolean;
    sizeScale: number;
    sizeUnits: 'meters' | 'pixels';
    orientationOffset: [number, number, number];
    trackIdProperty: string;
    colorProperty: string;
    colorMapping: Record<string, TrackColor> | null;
    colorMappingDefault: TrackColor;
    headingProperty: string;
    headingUnits: 'rad' | 'deg';
    quaternionProperties: [string, string, string, string];
    lengthProperty: string;
    widthProperty: string;
    heightProperty: string;
    speedProperty: string;
    defaultLength: number;
    defaultWidth: number;
    defaultHeight: number;
    maxInterpolationGap: number;
    opacity: number;
    ambientLight: number;
    diffuseLight: number;
    lightDirection: [number, number, number];
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };

  private shaderConfig: MeshShaderConfig;
  private programKeys: Readonly<Record<MeshPass, string>>;
  private requestedMode: STTTimeFilterMode | undefined;

  /** Composed static model→layer-frame correction, rebuilt on setter. */
  private orientationQuat: Quat;

  /** Interleaved instance staging, per-LAYER and grow-only. */
  private instanceScratch = new Float32Array(0);
  /** Id-colour staging for the pick pass, per-LAYER and grow-only. */
  private idScratch = new Uint8Array(0);

  /** Uploaded models keyed by category (`''` = the default mesh). */
  private readonly geometries = new Map<string, MeshGpuGeometry>();
  private warnedMissingMesh = false;
  private warnedNoInstancing = false;

  private handles?: MeshHandles;
  private handlesVariant?: string;
  private idHandles?: MeshHandles;
  private idHandlesVariant?: string;

  /**
   * Sample knobs handed to `sampleTrack`, refilled in place every emit so the
   * per-frame path allocates nothing beyond the kernel's own `Sample`.
   */
  private readonly sampleCfg: TrackSampleConfig = {
    defaultLength: 4.5,
    defaultWidth: 2,
    defaultHeight: 1.8,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    angleUnit: 'rad',
    maxGapMs: Infinity,
  };

  /** Reused mercator destination, so the emit loop allocates no pairs. */
  private readonly mercatorScratch = new Float64Array(2);

  /** Reused vec3 for the light-direction uniform (no per-draw allocation). */
  private readonly lightScratch = new Float32Array(3);

  constructor(opts: STTMeshLayerOptions) {
    super(opts);
    // Every default uses `??`: 0, false and '' are all legitimate caller values
    // here, and an explicit `undefined` forwarded from a React prop must still
    // land on the default.
    this.renderingMode = opts.renderingMode ?? '3d';
    this.requestedMode = opts.timeFilterMode;
    this.meshOpts = {
      mesh: opts.mesh ?? null,
      meshes: opts.meshes ?? null,
      scaleToDimensions: opts.scaleToDimensions ?? true,
      sizeScale: opts.sizeScale ?? 1,
      sizeUnits: opts.sizeUnits ?? 'meters',
      orientationOffset: opts.orientationOffset ?? [0, 0, 0],
      trackIdProperty: opts.trackIdProperty ?? 'track_id',
      colorProperty: opts.colorProperty ?? 'category',
      colorMapping: opts.colorMapping ?? null,
      colorMappingDefault: opts.colorMappingDefault ?? [160, 160, 160, 255],
      headingProperty: opts.headingProperty ?? 'heading',
      headingUnits: opts.headingUnits ?? 'rad',
      quaternionProperties: opts.quaternionProperties ?? [
        'qx',
        'qy',
        'qz',
        'qw',
      ],
      lengthProperty: opts.lengthProperty ?? 'length',
      widthProperty: opts.widthProperty ?? 'width',
      heightProperty: opts.heightProperty ?? 'height',
      speedProperty: opts.speedProperty ?? 'speed',
      defaultLength: opts.defaultLength ?? 4.5,
      defaultWidth: opts.defaultWidth ?? 2,
      defaultHeight: opts.defaultHeight ?? 1.8,
      maxInterpolationGap: opts.maxInterpolationGap ?? Infinity,
      opacity: opts.opacity ?? 1,
      ambientLight: opts.ambientLight ?? 0.45,
      diffuseLight: opts.diffuseLight ?? 0.55,
      lightDirection: opts.lightDirection ?? DEFAULT_LIGHT_DIRECTION,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.orientationQuat = this.composeOrientation();
    this.shaderConfig = {
      mode: resolveMeshTimeFilterMode(
        this.requestedMode,
        this.meshOpts.wakeLength,
        this.meshOpts.trailLength,
      ),
      filter: Boolean(this.filterOpts.filterProperty),
    };
    this.programKeys = this.buildProgramKeys();
    this.sampleCfg.defaultLength = this.meshOpts.defaultLength;
    this.sampleCfg.defaultWidth = this.meshOpts.defaultWidth;
    this.sampleCfg.defaultHeight = this.meshOpts.defaultHeight;
    this.sampleCfg.angleUnit = this.meshOpts.headingUnits;
  }

  private buildProgramKeys(): Readonly<Record<MeshPass, string>> {
    return Object.freeze({
      fill: meshProgramKey('fill', this.shaderConfig),
      'pick-fill': meshProgramKey('pick-fill', this.shaderConfig),
    });
  }

  private composeOrientation(): Quat {
    const [x, y, z] = this.meshOpts.orientationOffset;
    return quatFromEulerXYZ(x, y, z);
  }

  /**
   * Re-resolve the compiled mode and drop the memoized program handles, so the
   * next draw re-resolves under the new key. Called by every setter that moves
   * a COMPILED axis.
   */
  private applyShaderConfig(): void {
    const next = resolveMeshTimeFilterMode(
      this.requestedMode,
      this.meshOpts.wakeLength,
      this.meshOpts.trailLength,
    );
    const filter = Boolean(this.filterOpts.filterProperty);
    if (next === this.shaderConfig.mode && filter === this.shaderConfig.filter)
      return;
    this.shaderConfig = { mode: next, filter };
    this.programKeys = this.buildProgramKeys();
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  // ── setters ───────────────────────────────────────────────────────────────

  setMesh(mesh: STTMeshGeometry | null): void {
    this.meshOpts.mesh = mesh;
    this.releaseGeometries();
    this.map?.triggerRepaint();
  }

  setMeshes(meshes: Record<string, STTMeshGeometry> | null): void {
    this.meshOpts.meshes = meshes;
    this.releaseGeometries();
    this.map?.triggerRepaint();
  }

  setSizeScale(sizeScale: number): void {
    this.meshOpts.sizeScale = sizeScale;
    this.map?.triggerRepaint();
  }

  setScaleToDimensions(scaleToDimensions: boolean): void {
    this.meshOpts.scaleToDimensions = scaleToDimensions;
    this.map?.triggerRepaint();
  }

  setOrientationOffset(offset: [number, number, number]): void {
    this.meshOpts.orientationOffset = offset;
    this.orientationQuat = this.composeOrientation();
    this.map?.triggerRepaint();
  }

  setOpacity(opacity: number): void {
    this.meshOpts.opacity = opacity;
    this.map?.triggerRepaint();
  }

  setTimeFilterMode(mode: STTTimeFilterMode): void {
    this.requestedMode = mode;
    this.applyShaderConfig();
    this.map?.triggerRepaint();
  }

  setWakeLength(wakeLength: number): void {
    this.meshOpts.wakeLength = wakeLength;
    this.applyShaderConfig();
    this.map?.triggerRepaint();
  }

  setTrailLength(trailLength: number): void {
    this.meshOpts.trailLength = trailLength;
    this.applyShaderConfig();
    this.map?.triggerRepaint();
  }

  setMaxInterpolationGap(maxInterpolationGap: number): void {
    this.meshOpts.maxInterpolationGap = maxInterpolationGap;
    this.map?.triggerRepaint();
  }

  // ── base hooks ────────────────────────────────────────────────────────────

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  protected onContextReady(): void {}

  protected onContextLost(
    gl?: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // The base has already dropped the program cache and every tile cache; this
    // subclass only nulls what IT memoized. The model buffers belong to the
    // lost context, so drop the map without deleting through a dead `gl`.
    if (gl) this.releaseGeometries(gl);
    else this.geometries.clear();
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
  }

  private releaseGeometries(
    gl?: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (gl) {
      for (const g of this.geometries.values()) {
        gl.deleteBuffer(g.positionBuffer);
        gl.deleteBuffer(g.normalBuffer);
        if (g.indexBuffer) gl.deleteBuffer(g.indexBuffer);
      }
    }
    this.geometries.clear();
  }

  // ── tile pooling ──────────────────────────────────────────────────────────

  /**
   * Pool this tile's snapshots into tracks and allocate the per-tile instance
   * buffer ONCE. Everything expensive happens here — the per-frame path only
   * interpolates and refills a prefix of that buffer.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): MeshGpuCache | null {
    const f = layer.features;
    if (f.featureCount === 0) return null;

    const fieldCfg: TrackFieldConfig = {
      trackIdProperty: this.meshOpts.trackIdProperty,
      colorProperty: this.meshOpts.colorProperty,
      labelProperty: this.meshOpts.colorProperty,
      headingProperty: this.meshOpts.headingProperty,
      lengthProperty: this.meshOpts.lengthProperty,
      widthProperty: this.meshOpts.widthProperty,
      heightProperty: this.meshOpts.heightProperty,
      speedProperty: this.meshOpts.speedProperty,
      colorMapping: this.meshOpts.colorMapping,
      colorMappingDefault: this.meshOpts.colorMappingDefault,
    };
    // Pool THIS (tile, layer) only: `buildTileGpuCache` is called per layer,
    // and handing the kernel the whole tile would double-count a tile carrying
    // two point layers.
    const index = buildTrackIndex([{ ...tile, layers: [layer] }], fieldCfg);
    const tracks = [...index.tracks.values()];
    if (tracks.length === 0) return null;

    let filterValues: Float32Array | null = null;
    let hasFilterColumn = false;
    if (this.shaderConfig.filter) {
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical) this.warnCategoricalFilterOnce();
      filterValues = col.values;
      hasFilterColumn = col.hasColumn;
    }

    const extras = this.poolTrackExtras(layer, tracks, filterValues);
    const { order, categoryRuns } = orderTracksByCategory(tracks);

    const capacity = tracks.length;
    const stride = this.stride();
    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * stride * 4, gl.DYNAMIC_DRAW);

    // The base `TileGpuCache` contract wants a `timeBuffer`; the per-instance
    // `[start, end]` pair rides the interleaved instance buffer here (it must
    // follow the compacted active order), so this is a zero-length placeholder —
    // the same shape `STTTripHeadsLayer` and `STTTripsLayer` use.
    const timeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);

    return {
      positionBuffer: instanceBuffer,
      instanceBuffer,
      timeBuffer,
      vertexCount: 0,
      indexCount: 0,
      timeOffset: f.timeOffset,
      tracks,
      extras,
      order,
      categoryRuns,
      capacity,
      featureCount: f.featureCount,
      hasFilterColumn,
      activeFeatureIndex: new Uint32Array(capacity),
      activeCount: 0,
      groups: [],
    };
  }

  /** Float slots per instance for the compiled configuration. */
  private stride(): number {
    return BASE_STRIDE + (this.shaderConfig.filter ? 1 : 0);
  }

  /**
   * Second pooling pass: the quaternion keyframes, the representative feature
   * index (the pick id) and the DataFilter value, keyed by the SAME track id
   * string the kernel keys its map with.
   *
   * Deliberately independent of the kernel's internal arrays. The kernel sorts
   * and de-dups its keyframes; joining to it by INDEX would be correct today
   * and a silent mis-orientation the day it compacts differently. A quaternion
   * bracket search over this layer's own ascending times cannot drift.
   *
   * With no track-id column the kernel emits one synthetic track per snapshot
   * in walk order, so track `k` is feature `k` and the join is positional.
   */
  private poolTrackExtras(
    layer: STTLayer,
    tracks: Track[],
    filterValues: Float32Array | null,
  ): TrackExtra[] {
    const f = layer.features;
    const count = f.featureCount;
    const idProp = this.meshOpts.trackIdProperty;
    const hasIds = Boolean(idProp) && Boolean(f.categoricalProps?.[idProp]);

    const [qxName, qyName, qzName, qwName] = this.meshOpts.quaternionProperties;
    const qx = this.getNumericProperty(f, qxName);
    const qy = this.getNumericProperty(f, qyName);
    const qz = this.getNumericProperty(f, qzName);
    const qw = this.getNumericProperty(f, qwName);
    const hasQuat = Boolean(qx && qy && qz && qw);

    // Group feature indices by track id, in feature order.
    const byId = new Map<string, number[]>();
    if (hasIds) {
      for (let i = 0; i < count; i++) {
        const id = String(readCategorical(f, idProp, i) ?? '');
        const bucket = byId.get(id);
        if (bucket) bucket.push(i);
        else byId.set(id, [i]);
      }
    }

    const times = f.startTimes;
    const timeOffset = f.timeOffset;
    const out: TrackExtra[] = [];
    for (let k = 0; k < tracks.length; k++) {
      const track = tracks[k];
      const rows = hasIds ? byId.get(track.trackId) : undefined;
      const idx = rows ?? (hasIds ? [] : [k]);
      const featureIndex = idx.length > 0 ? idx[0] : Math.min(k, count - 1);
      let quatTimes: Float64Array | null = null;
      let quatValues: Float32Array | null = null;
      if (hasQuat && idx.length > 0) {
        // Ascending by absolute keyframe time; the kernel's own arrays are
        // never consulted.
        const sorted = idx.slice().sort((a, b) => times[a] - times[b]);
        quatTimes = new Float64Array(sorted.length);
        quatValues = new Float32Array(sorted.length * 4);
        for (let j = 0; j < sorted.length; j++) {
          const fi = sorted[j];
          quatTimes[j] = times[fi] + timeOffset;
          const q = normalizeQuat([qx![fi], qy![fi], qz![fi], qw![fi]]);
          quatValues[j * 4] = q[0];
          quatValues[j * 4 + 1] = q[1];
          quatValues[j * 4 + 2] = q[2];
          quatValues[j * 4 + 3] = q[3];
        }
      }
      out.push({
        featureIndex,
        filterValue: filterValues ? (filterValues[featureIndex] ?? 0) : 0,
        quatTimes,
        quatValues,
      });
    }
    return out;
  }

  // ── per-frame emit ────────────────────────────────────────────────────────

  private ensureScratch(capacity: number): void {
    const need = capacity * this.stride();
    if (this.instanceScratch.length < need) {
      this.instanceScratch = new Float32Array(need);
    }
  }

  /**
   * Interpolate every ACTIVE track to `ctx.currentTime` and refill the prefix
   * of the tile's instance buffer, in CATEGORY order so each model's instances
   * stay contiguous. Returns the active count (also `cache.activeCount`).
   *
   * Track times are ABSOLUTE epoch-ms, so the playhead goes in unmodified; the
   * `[start, end]` pair written for the GPU time gate is TILE-RELATIVE, matching
   * `uWindowStart` / `uCurrentTime`.
   */
  private emitInstances(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    cache: MeshGpuCache,
    ctx: DrawContext,
  ): number {
    this.ensureScratch(cache.capacity);
    const F = this.instanceScratch;
    const stride = this.stride();
    const { tracks, extras, order, categoryRuns } = cache;
    const now = ctx.currentTime;
    const timeOffset = cache.timeOffset;
    const dims = this.meshOpts.scaleToDimensions;

    // WAKE takes NO CPU fade: `sttWakeAlpha` already ramps from the track's own
    // start, the same instant `sampleTrack`'s fade-in measures from — keeping
    // both would apply one ramp twice, and the doubled value also drives
    // `sttWakeSizeScale`, inverting the tail taper. Same reasoning as
    // `STTTripHeadsLayer`.
    const wake = this.shaderConfig.mode === 'wake';
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    const cfg = this.sampleCfg;
    cfg.fadeInDuration = wake ? 0 : fadeIn;
    cfg.fadeOutDuration = wake ? 0 : fadeOut;
    cfg.maxGapMs = this.meshOpts.maxInterpolationGap;

    const groups = cache.groups;
    groups.length = 0;
    const offsetQ = this.orientationQuat;
    const m = this.mercatorScratch;

    let n = 0;
    for (const run of categoryRuns) {
      const groupStart = n;
      for (let j = run.start; j < run.start + run.count; j++) {
        const k = order[j];
        const track = tracks[k];
        const s = sampleTrack(track, now, cfg);
        if (!s) continue; // playhead outside this track ⇒ no model
        const extra = extras[k];
        const o = n * stride;

        lngLatToMercatorInto(s.lon, s.lat, m, 0);
        F[o] = m[0];
        F[o + 1] = m[1];
        F[o + 2] = s.alt;

        // Attitude: a real quaternion slerped between keyframes when the
        // columns exist, otherwise a yaw built from the shortest-arc heading.
        // The static model correction is composed here, once per instance, so
        // the shader has exactly one rotation to run per vertex.
        const base = extra.quatTimes
          ? slerpQuatAt(extra.quatTimes, extra.quatValues!, now)
          : quatFromHeading(s.heading);
        const q = multiplyQuat(base, offsetQ);
        F[o + 3] = q[0];
        F[o + 4] = q[1];
        F[o + 5] = q[2];
        F[o + 6] = q[3];

        F[o + 7] = dims ? s.length : 1;
        F[o + 8] = dims ? s.width : 1;
        F[o + 9] = dims ? s.height : 1;

        const t = track.times;
        F[o + 10] = t[0] - timeOffset;
        F[o + 11] = t[t.length - 1] - timeOffset;
        F[o + 12] = s.alpha;

        const c = track.color;
        F[o + 13] = c[0] / 255;
        F[o + 14] = c[1] / 255;
        F[o + 15] = c[2] / 255;
        F[o + 16] = c[3] / 255;
        if (stride > BASE_STRIDE) F[o + BASE_STRIDE] = extra.filterValue;

        cache.activeFeatureIndex[n] = extra.featureIndex;
        n++;
      }
      if (n > groupStart) {
        groups.push({
          category: run.category,
          start: groupStart,
          count: n - groupStart,
        });
      }
    }

    cache.activeCount = n;
    if (n === 0) return 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, F.subarray(0, n * stride));
    return n;
  }

  // ── model upload ──────────────────────────────────────────────────────────

  /**
   * Upload (once per GL context) the model a category draws with, falling back
   * to the layer's default `mesh`. A category with neither draws nothing and
   * warns once — silently dropping a whole class of objects is worse than a
   * console line, and throwing inside a render loop is worse than both.
   */
  private geometryFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    category: string,
  ): MeshGpuGeometry | null {
    const source = this.meshOpts.meshes?.[category] ?? this.meshOpts.mesh;
    if (!source) {
      if (!this.warnedMissingMesh) {
        this.warnedMissingMesh = true;
        console.warn(
          `STTMeshLayer(${this.id}): no mesh for category "${category}" and no default \`mesh\` — those instances are not drawn.`,
        );
      }
      return null;
    }
    const key = this.meshOpts.meshes?.[category] ? category : '';
    const cached = this.geometries.get(key);
    if (cached) return cached;

    const positions =
      source.positions instanceof Float32Array
        ? source.positions
        : new Float32Array(source.positions as ArrayLike<number>);
    const vertexCount = Math.floor(positions.length / 3);
    if (vertexCount === 0) return null;
    const normals = source.normals
      ? source.normals instanceof Float32Array
        ? source.normals
        : new Float32Array(source.normals as ArrayLike<number>)
      : defaultNormals(vertexCount);

    const positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const normalBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

    let indexBuffer: WebGLBuffer | null = null;
    let indexCount = 0;
    let indexType: number = gl.UNSIGNED_SHORT;
    if (source.indices) {
      const raw = source.indices;
      const wide =
        raw instanceof Uint32Array ||
        (!(raw instanceof Uint16Array) && vertexCount > 65535);
      const indices = wide
        ? raw instanceof Uint32Array
          ? raw
          : new Uint32Array(raw as ArrayLike<number>)
        : raw instanceof Uint16Array
          ? raw
          : new Uint16Array(raw as ArrayLike<number>);
      indexType = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      indexCount = indices.length;
      indexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    }

    const geom: MeshGpuGeometry = {
      positionBuffer,
      normalBuffer,
      indexBuffer,
      indexType,
      vertexCount,
      indexCount,
    };
    this.geometries.set(key, geom);
    return geom;
  }

  // ── uniforms + binds ──────────────────────────────────────────────────────

  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: MeshHandles,
    cache: MeshGpuCache,
    ctx: DrawContext,
  ): void {
    // Every time is TILE-RELATIVE: `ctx.windowStart`/`windowEnd` already are,
    // and the playhead is relativized here.
    const now = ctx.currentTime - cache.timeOffset;
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    switch (this.shaderConfig.mode) {
      case 'window':
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
        break;
      case 'wake':
        gl.uniform1f(h.uCurrentTime, now);
        gl.uniform1f(h.uWakeLength, this.meshOpts.wakeLength);
        gl.uniform1f(h.uWakeTailScale, this.meshOpts.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, now);
        gl.uniform1f(h.uFadeIn, fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, now);
        gl.uniform1f(h.uTrailLength, this.meshOpts.trailLength);
        gl.uniform1f(h.uFadeTrail, this.meshOpts.fadeTrail);
        break;
    }
  }

  /**
   * Metres→mercator for the horizontal axes and metres→mercator-z for the
   * vertical, both at THIS TILE'S centre latitude. `y` is negated because the
   * model frame is ENU (north-positive) and world mercator counts `y` downward.
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: MeshHandles,
    tile: Tile,
    cache: MeshGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (frame.shader.prelude.length > 0) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else if (h.uMatrix) {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix as Float32Array);
    }
    const lat = tileCenterLatitude(tile.id.z, tile.id.y);
    const perMeter = metersToMercatorUnits(1, lat);
    gl.uniform2f(h.uMeterToMercator, perMeter, -perMeter);
    gl.uniform1f(h.uMercatorZPerMeter, mercatorZFromAltitude(1, lat));
    gl.uniform1f(h.uSizeScale, this.resolveSizeScale(gl, tile, ctx));
    gl.uniform1f(h.uOpacity, this.meshOpts.opacity);
    const light = this.lightScratch;
    light[0] = this.meshOpts.lightDirection[0];
    light[1] = this.meshOpts.lightDirection[1];
    light[2] = this.meshOpts.lightDirection[2];
    gl.uniform3fv(h.uLightDirection, light);
    gl.uniform2f(
      h.uLightTerms,
      this.meshOpts.ambientLight,
      this.meshOpts.diffuseLight,
    );
    this.setTimeUniforms(gl, h, cache, ctx);
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn);
    }
  }

  /**
   * `sizeScale` as the shader wants it. In `'meters'` it is the plain
   * multiplier (the model's dimensions already ARE metres). In `'pixels'` the
   * dimensions are re-read as screen pixels, so they are divided by the
   * metres→device-pixels factor at the tile centre's latitude and the map's
   * FRACTIONAL zoom — the model then holds its apparent size and grows
   * continuously with zoom instead of stepping at integer zooms.
   */
  private resolveSizeScale(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const scale = this.meshOpts.sizeScale;
    if (this.meshOpts.sizeUnits !== 'pixels') return scale;
    const pxPerMeter = this.metricPixelScale(gl, tile, ctx);
    return pxPerMeter > 0 ? scale / pxPerMeter : scale;
  }

  /**
   * Bind the model stream (divisor 0) and the interleaved instance stream
   * (divisor 1) at `instanceStart`.
   *
   * Raw pointers, never a VAO: the per-category instance offset is recomputed
   * every frame, and a VAO RECORDS that offset — a cached one would be stale
   * the frame after it was recorded, which produces silently-wrong bindings
   * rather than a crash.
   */
  private bindAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: MeshHandles,
    geom: MeshGpuGeometry,
    cache: MeshGpuCache,
    instanceStart: number,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, geom.positionBuffer);
    gl.enableVertexAttribArray(h.aModelPos);
    gl.vertexAttribPointer(h.aModelPos, 3, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aModelPos, 0);
    if (h.aModelNormal >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, geom.normalBuffer);
      gl.enableVertexAttribArray(h.aModelNormal);
      gl.vertexAttribPointer(h.aModelNormal, 3, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aModelNormal, 0);
    }

    const stride = this.stride();
    const bytes = stride * 4;
    const base = instanceStart * bytes;
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.instanceBuffer);
    const inst = (loc: number, size: number, slot: number): void => {
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(
        loc,
        size,
        gl.FLOAT,
        false,
        bytes,
        base + slot * 4,
      );
      this.instSupport.vertexAttribDivisor(loc, 1);
    };
    inst(h.aInstPos, 3, 0);
    inst(h.aInstQuat, 4, 3);
    inst(h.aInstDims, 3, 7);
    inst(h.aTime, 2, 10);
    inst(h.aFade, 1, 12);
    inst(h.aColor, 4, 13);
    if (this.shaderConfig.filter) inst(h.aFilterValue, 1, BASE_STRIDE);
  }

  /** Undo {@link bindAttributes} — divisors are GLOBAL state on WebGL2. */
  private releaseAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: MeshHandles,
  ): void {
    const locs = [
      h.aModelPos,
      h.aModelNormal,
      h.aInstPos,
      h.aInstQuat,
      h.aInstDims,
      h.aTime,
      h.aFade,
      h.aColor,
      h.aFilterValue,
      h.aIdColor,
    ];
    for (const loc of locs) {
      if (loc < 0) continue;
      this.instSupport.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
  }

  private resolveHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
  ): MeshHandles {
    return {
      program,
      aModelPos: gl.getAttribLocation(program, 'aModelPos'),
      aModelNormal: gl.getAttribLocation(program, 'aModelNormal'),
      aInstPos: gl.getAttribLocation(program, 'aInstPos'),
      aInstQuat: gl.getAttribLocation(program, 'aInstQuat'),
      aInstDims: gl.getAttribLocation(program, 'aInstDims'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aFade: gl.getAttribLocation(program, 'aFade'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aFilterValue: gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uMeterToMercator: gl.getUniformLocation(program, 'uMeterToMercator'),
      uMercatorZPerMeter: gl.getUniformLocation(program, 'uMercatorZPerMeter'),
      uSizeScale: gl.getUniformLocation(program, 'uSizeScale'),
      uOpacity: gl.getUniformLocation(program, 'uOpacity'),
      uLightDirection: gl.getUniformLocation(program, 'uLightDirection'),
      uLightTerms: gl.getUniformLocation(program, 'uLightTerms'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveWakeTailScaleUniformLocation(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
      ...resolveFilterTransformSizeUniformLocation(gl, program),
    };
  }

  private readonly fillFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): MeshHandles =>
    this.resolveHandles(
      gl,
      this.linkProgram(
        gl,
        buildMeshVertexSource(shader, this.shaderConfig),
        FS_SOURCE,
      ),
    );

  private readonly pickFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): MeshHandles =>
    this.resolveHandles(
      gl,
      this.linkProgram(
        gl,
        buildMeshIdVertexSource(shader, this.shaderConfig),
        ID_FS_SOURCE,
      ),
    );

  /** Instanced draws are the whole design here; without them, draw nothing. */
  private ensureInstancing(): boolean {
    if (this.instSupport.enabled) return true;
    if (!this.warnedNoInstancing) {
      this.warnedNoInstancing = true;
      console.warn(
        `STTMeshLayer(${this.id}): instanced drawing is unavailable (no WebGL2, no ANGLE_instanced_arrays) — models are not drawn.`,
      );
    }
    return false;
  }

  private drawGroups(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: MeshHandles,
    cache: MeshGpuCache,
  ): void {
    for (const group of cache.groups) {
      const geom = this.geometryFor(gl, group.category);
      if (!geom) continue;
      this.bindAttributes(gl, h, geom, cache, group.start);
      if (geom.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geom.indexBuffer);
        this.instSupport.drawElementsInstanced(
          gl.TRIANGLES,
          geom.indexCount,
          geom.indexType,
          0,
          group.count,
        );
      } else {
        this.instSupport.drawArraysInstanced(
          gl.TRIANGLES,
          0,
          geom.vertexCount,
          group.count,
        );
      }
    }
  }

  // ── draw ──────────────────────────────────────────────────────────────────

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const c = cache as MeshGpuCache;
    if (c.capacity <= 0 || !this.ensureInstancing()) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;

    let h = this.handles;
    if (!h || this.handlesVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        this.programKeys.fill,
        frame,
        this.fillFactory,
      );
      this.handles = h;
      this.handlesVariant = variant;
    }
    gl.useProgram(h.program);

    if (this.emitInstances(gl, c, ctx) === 0) return;
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);
    this.drawGroups(gl, h, c);
    this.releaseAttributes(gl, h);
  }

  /**
   * Draw this tile's models into the id-pick FBO. Mirrors {@link drawTile}'s
   * projection (same host variant, same builder), its sizing and — critically —
   * its ALPHA GATES: the same compiled time kernel, the same DataFilter range
   * and the same colour-alpha gate, so a model the user cannot see is never
   * pickable. Because this kind renders depth-TESTED, the id pass runs against
   * a depth attachment too, so the model the user can SEE wins the texel.
   *
   * One instance paints the id of the snapshot that OPENED its track in this
   * tile, so a pick resolves through the base's ordinary per-feature provenance
   * to a real source row. The id buffer is rebuilt per pick and freed
   * immediately: `idBase` shifts with whatever tiles are loaded this frame, and
   * picks are rare user-initiated events.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const c = cache as MeshGpuCache;
    if (c.capacity <= 0 || !this.ensureInstancing()) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;

    let h = this.idHandles;
    if (!h || this.idHandlesVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        this.programKeys['pick-fill'],
        frame,
        this.pickFactory,
      );
      this.idHandles = h;
      this.idHandlesVariant = variant;
    }
    gl.useProgram(h.program);

    const n = this.emitInstances(gl, c, ctx);
    if (n === 0) return;
    this.setSharedUniforms(gl, h, tile, c, ctx, frame);

    // Gather the per-FEATURE id table into the compacted instance order, so
    // instance i paints the id of the feature it came from.
    const table = this.buildPickIdColors(c.featureCount, idBase);
    if (this.idScratch.length < n * 3) this.idScratch = new Uint8Array(n * 3);
    const ids = this.idScratch;
    for (let i = 0; i < n; i++) {
      const fi = c.activeFeatureIndex[i] * 3;
      ids[i * 3] = table[fi];
      ids[i * 3 + 1] = table[fi + 1];
      ids[i * 3 + 2] = table[fi + 2];
    }
    const idBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, ids.subarray(0, n * 3), gl.DYNAMIC_DRAW);

    for (const group of c.groups) {
      const geom = this.geometryFor(gl, group.category);
      if (!geom) continue;
      this.bindAttributes(gl, h, geom, c, group.start);
      if (h.aIdColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
        gl.enableVertexAttribArray(h.aIdColor);
        gl.vertexAttribPointer(
          h.aIdColor,
          3,
          gl.UNSIGNED_BYTE,
          true,
          3,
          group.start * 3,
        );
        this.instSupport.vertexAttribDivisor(h.aIdColor, 1);
      }
      if (geom.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geom.indexBuffer);
        this.instSupport.drawElementsInstanced(
          gl.TRIANGLES,
          geom.indexCount,
          geom.indexType,
          0,
          group.count,
        );
      } else {
        this.instSupport.drawArraysInstanced(
          gl.TRIANGLES,
          0,
          geom.vertexCount,
          group.count,
        );
      }
    }

    this.releaseAttributes(gl, h);
    gl.deleteBuffer(idBuffer);
  }
}

// ── module-level helpers ────────────────────────────────────────────────────

/**
 * Order track indices so every category is one contiguous run. Computed ONCE
 * per tile: the emit loop then walks the runs and skips inactive tracks, which
 * keeps each category's ACTIVE instances contiguous too — one
 * `drawElementsInstanced` per model, no per-frame sort.
 */
export function orderTracksByCategory(tracks: readonly Track[]): {
  order: Uint32Array;
  categoryRuns: { category: string; start: number; count: number }[];
} {
  const buckets = new Map<string, number[]>();
  for (let k = 0; k < tracks.length; k++) {
    const cat = tracks[k].category ?? '';
    const b = buckets.get(cat);
    if (b) b.push(k);
    else buckets.set(cat, [k]);
  }
  const order = new Uint32Array(tracks.length);
  const runs: { category: string; start: number; count: number }[] = [];
  let w = 0;
  for (const [category, idx] of buckets) {
    const start = w;
    for (const k of idx) order[w++] = k;
    runs.push({ category, start, count: w - start });
  }
  return { order, categoryRuns: runs };
}

/**
 * Slerp the quaternion keyframe list at absolute time `now`, clamping outside
 * the span. Binary search, so a 200-keyframe track costs 8 comparisons rather
 * than a scan — this runs once per ACTIVE track per frame.
 */
export function slerpQuatAt(
  times: ArrayLike<number>,
  values: Float32Array,
  now: number,
): Quat {
  const n = times.length;
  if (n === 0) return [...IDENTITY_QUAT] as Quat;
  if (n === 1 || now <= times[0]) return quatAt(values, 0);
  if (now >= times[n - 1]) return quatAt(values, n - 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= now) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const f = span > 0 ? (now - times[lo]) / span : 0;
  return slerpQuat(quatAt(values, lo), quatAt(values, hi), f);
}

function quatAt(values: Float32Array, i: number): Quat {
  const o = i * 4;
  return [values[o], values[o + 1], values[o + 2], values[o + 3]];
}

/** `+z` for every vertex — a model with no normals reads as its ambient term. */
function defaultNormals(vertexCount: number): Float32Array {
  const out = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) out[i * 3 + 2] = 1;
  return out;
}
