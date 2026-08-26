/**
 * Bounding-box geometry adapter — renders an AV `objects/` POINT archive as ONE
 * oriented 3D cuboid per TRACKED OBJECT at the playhead.
 *
 * ── Why this layer does not look like its siblings ──────────────────────────
 * Every other kind in this package is a pure function of a TILE: the tile's
 * features go up as attribute buffers once, and the play-head moves a *time
 * window* across them in the shader. That model is exactly wrong here, and the
 * bug it produces is the reason this kind exists as its own file.
 *
 * The source archive carries one POINT feature per tracked object PER
 * KEYFRAME — a car at 10 Hz for 20 s is 200 features, all with the same
 * `track_id`. Window-filter that stream and a window spanning N keyframes
 * lights N boxes for ONE car: a "train" of ghost cuboids dragging behind every
 * vehicle, getting longer as `timeWindow` grows. No amount of tuning fixes it,
 * because the number of drawn boxes is a function of the window width rather
 * than of how many objects exist.
 *
 * So this layer inverts the model. It POOLS every resident tile's snapshots by
 * `track_id` — rebasing each keyframe to ABSOLUTE epoch-ms so keyframes coming
 * from tiles with different `timeOffset`s join ONE timeline — and emits exactly
 * ONE INTERPOLATED instance per ACTIVE track per frame. A track is "active"
 * while the play-head lies inside its keyframe span, so **visibility is
 * implicit and there is no window uniform gating existence at all**. Boxes
 * cannot train, by construction, whatever `timeWindow` is set to.
 *
 * The pooling + interpolation kernel is `@poopdeck.gl/core`'s
 * {@link buildTrackIndex} / {@link sampleTrack} — the SAME code deck, three and
 * Cesium run, so a box's pose here is bit-for-bit the pose there. In particular
 * heading interpolation is SHORTEST-ARC (`lerpAngle`/`lerpAngleDeg`): a car
 * turning 350° → 10° crosses 0, it does not spin backwards through 180°. This
 * file deliberately contains no second pooler and no second angle lerp.
 *
 * ── Shape of the draw ───────────────────────────────────────────────────────
 * One UNIT CUBE (8 vertices, 36 fill indices, 24 wireframe indices) is uploaded
 * once per GL context; every active track is ONE INSTANCE carrying:
 *
 *   aCenter  vec3   (mercatorX, mercatorY, altitudeMetres) — the pose
 *   aDims    vec4   (halfLength, halfWidth, heightMetres, mercatorZPerMetre)
 *   aRot     vec2   (cos yaw, −sin yaw) — the mercator-y flip baked in
 *   aColor   rgba8  the track's category colour × its appear/disappear fade
 *   aTime    vec2   the track's [firstKeyframe, lastKeyframe], layer-relative
 *
 * `halfLength`/`halfWidth` arrive already in MERCATOR units: mercator is
 * conformal, so one metre is the same number of mercator units on both axes and
 * the conversion can be baked per instance on the CPU at that box's OWN
 * latitude (`metersToMercatorUnits`) — more exact than a single per-tile or
 * per-layer scale uniform, and it costs nothing because the centres are being
 * projected on the CPU each frame anyway. The height stays in METRES and rides
 * with its own `mercatorZPerMetre` factor because elevation units are
 * host-variant dependent (see below).
 *
 * A tile of 50 000 snapshots that resolves to 300 live objects therefore costs
 * ONE `drawElementsInstanced` of 300 instances — not 50 000 boxes, and not one
 * draw per tile.
 *
 * ── One draw for the whole LAYER, hosted inside `drawTile` ──────────────────
 * The pooled index spans every resident tile, so the draw unit is the LAYER,
 * not the tile. Rather than override `render()` wholesale (and re-implement
 * `beginFrame`, the visible-set flush and the shared GL state), this layer lets
 * the base drive and draws everything on the FIRST `drawTile` call of each
 * frame: {@link applySharedGlState} — which the base calls exactly once per
 * `render()`, immediately before its tile loop — arms `pendingLayerDraw`, and
 * `drawTile` disarms it. Subsequent tiles in the same frame are no-ops. Picking
 * takes the same shape from the other end: {@link buildPickProvenance} is
 * overridden to allocate ONE id range `[1, activeTracks]` for the whole layer
 * (the hexbin precedent — the draw unit is not "one id per feature per tile"),
 * so `drawPickTile` likewise runs once.
 *
 * ── Elevation units ─────────────────────────────────────────────────────────
 * Identical to `STTColumnLayer`'s prism path: legacy `uMatrix` and the v5
 * MERCATOR prelude take mercator-z, the v5 GLOBE prelude takes METRES for its
 * sphere term while its transition fallback wants mercator-z again. All three
 * are fed from the same two values by {@link buildElevatedProjection}, with the
 * latitude-correct metres→mercator-z factor riding per instance in `aDims.w`
 * rather than in a uniform (this layer's instances span tiles, so a single
 * per-tile factor would be wrong for most of them). A flat `1e-7` constant is
 * latitude-blind and ~4× too tall — never substitute one.
 *
 * ── The four time-filter modes ──────────────────────────────────────────────
 * Carried in full, through the shared `shaders/time-window.glsl.ts` chunks,
 * with the standard {@link resolveBoundingBoxTimeFilterMode} degradation — but
 * they mean something slightly different here, and that difference is the
 * point. `aTime` is the track's OWN LIFESPAN, not a keyframe's timestamp, so:
 *
 *  - `window` (default) — the lifespan against the render window: alpha 1 for a
 *    live object, with the base's `fadeIn`/`fadeOut` ramps applied at the
 *    object's BIRTH and DEATH. A box appears and leaves smoothly.
 *  - `wake` — lit for `wakeLength` ms after the object first appeared: "only
 *    things that just entered the scene".
 *  - `cumulative` — every object that has ever appeared stays lit while active.
 *  - `trail` — lit while the object's birth is within `trailLength` behind the
 *    play-head.
 *
 * In every mode the instance COUNT is unchanged — the mode modulates alpha, it
 * can never multiply a box. And unlike the column layer, `wake` does NOT taper
 * the geometry (`sttWakeSizeScale` is not spliced) and `filterTransformSize` is
 * declared but never read: a vehicle's length and width are PHYSICAL FACTS, the
 * same reason a summary cell's footprint — which is geography — must not
 * shrink. Only alpha responds.
 *
 * ⚠ **Times here are LAYER-relative, not tile-relative.** That is the one
 * deliberate deviation from this package's usual rule, and it is forced twice
 * over. The pool has no single TILE time base — dissolving those bases is
 * exactly what let keyframes from different tiles join one timeline — and an
 * `aTime` attribute is `float32`, which cannot carry an absolute epoch-ms at
 * all (1.7e12 rounds to the nearest ~131 072 ms, i.e. two minutes of jitter).
 * So the pool picks ONE base for the whole layer — the smallest `timeOffset`
 * among the resident tiles, stable for as long as the tile set is — and every
 * instance time and every time uniform is expressed against it:
 * `uCurrentTime = ctx.currentTime − timeBase`, and the window bounds are
 * re-absolutized off the cache (`ctx.windowStart + cache.timeOffset`, invariant
 * across tiles since the base derived them with that same offset) before being
 * rebased. The residual precision budget is the same one every tile-relative
 * layer already lives on.
 *
 * ── DataFilter ─────────────────────────────────────────────────────────────
 * Compiled in only when `filterProperty` is set, as everywhere else. The
 * filterable columns are the ones the track kernel POOLS per keyframe —
 * `speed`, `length`, `width`, `height`, `heading`, `altitude` — resolved
 * through {@link boundingBoxFilterValue} at the interpolated pose, so filtering
 * on speed filters on the speed the box is drawn WITH. Any other column name is
 * not carried by the pool; it degrades to `hasColumn: false` with a one-time
 * warning and the layer renders UNFILTERED, never blank — the same contract a
 * missing or categorical column gets in every other kind.
 *
 * ── What this layer deliberately does NOT do ────────────────────────────────
 *  - **No time-window filtering of the snapshot stream.** See the top. There is
 *    no `uWindowStart` gating which KEYFRAMES draw; only a track's lifespan
 *    reaches the window kernel.
 *  - **No CPU-side re-pooling per frame.** The index is rebuilt only when the
 *    resident tile set or a feeding prop changes; each frame re-SAMPLES it,
 *    which is O(active tracks · log keyframes).
 *  - **No per-tile GPU geometry.** The base's per-tile cache is still built
 *    (it is what makes `drawTile` reachable and carries `timeOffset`), but the
 *    boxes are drawn from LAYER-level instance buffers.
 *  - **No globe chord subdivision.** A cuboid's footprint is a few metres
 *    across — some six orders of magnitude below one subdivision cell — so the
 *    per-vertex `projectTileFor3D` path is already exact to the cube's own
 *    faceting. `lib/globe.ts` is for long edges.
 *  - **No text labels.** `Track.label` is pooled and surfaces on a PICK; a
 *    label layer is a separate kind.
 *  - **No screen-space wireframe width.** `wireframe: true` draws `gl.LINES`,
 *    which every modern driver clamps to 1 px. A width-controlled cage is the
 *    line layer's job.
 *
 * The `mesh` kind shares this motion contract (pool → sample → one instance per
 * active track). It keeps its OWN copy; the two files intentionally do not
 * import from each other, so neither can break the other by evolving.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import {
  GeometryType,
  buildTrackIndex,
  sampleTrack,
  makePickRow,
  DEFAULT_TRACK_COLOR,
  type Sample,
  type TrackColor,
  type TrackFieldConfig,
  type TrackIndexResult,
  type TrackSampleConfig,
} from '@poopdeck.gl/core';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  STTFilterableLayer,
  resolveTrailFade,
  type DrawContext,
  type PickProvenanceEntry,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
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
  TIME_MODE_UNIFORM_DECLS,
  resolveTimeUniformLocations,
  type TimeUniformLocations,
} from '../shaders/time-window.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  resolveDataFilterUniformLocations,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type FilterTransformSizeUniformLocation,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
import {
  lngLatToMercator,
  mercatorZFromAltitude,
  metersToMercatorUnits,
} from '../lib/projection.js';

/** Re-export of the shared union under this layer's own name. */
export type BoundingBoxTimeFilterMode = STTTimeFilterMode;

/** Default cuboid colour when no `colorMapping` entry matches the category. */
const DEFAULT_BOX_COLOR: TrackColor = DEFAULT_TRACK_COLOR;

/** Vertical shade at the cuboid's base; the top cap stays at 1.0. */
const DEFAULT_WALL_SHADE = 0.72;

/** Columns the track kernel pools per keyframe, hence the filterable set. */
export const BOUNDING_BOX_FILTERABLE_COLUMNS = Object.freeze([
  'speed',
  'length',
  'width',
  'height',
  'altitude',
  'heading',
] as const);

export type BoundingBoxFilterColumn =
  (typeof BOUNDING_BOX_FILTERABLE_COLUMNS)[number];

/**
 * The pooled numeric a DataFilter reads off an INTERPOLATED pose. Returns NaN
 * for a column the track kernel does not carry — the caller turns that into
 * `hasColumn: false` (render unfiltered) rather than a blank layer.
 *
 * Exported as the JS reference the tests assert against: it is the whole CPU
 * half of this layer's filter contract.
 */
export function boundingBoxFilterValue(sample: Sample, column: string): number {
  switch (column) {
    case 'speed':
      return sample.speed;
    case 'length':
      return sample.length;
    case 'width':
      return sample.width;
    case 'height':
      return sample.height;
    case 'altitude':
      return sample.alt;
    case 'heading':
      return sample.heading;
    default:
      return NaN;
  }
}

/**
 * `(cos yaw, −sin yaw)` — the CPU half of `sttRotateBox`.
 *
 * The mercator y axis points SOUTH while a heading is measured
 * counter-clockwise in a north-up ENU frame, so the sine is negated HERE, once,
 * rather than in the shader: the GLSL kernel then stays a textbook 2D rotation
 * that a reader can check by eye. A NaN heading (the column is absent, or the
 * pose fell in a gap) yields the identity, i.e. an axis-aligned box, which is
 * the honest rendering of "orientation unknown".
 */
export function boxRotation(headingRadians: number): [number, number] {
  if (!Number.isFinite(headingRadians)) return [1, 0];
  return [Math.cos(headingRadians), -Math.sin(headingRadians)];
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set. Verbatim
 * the rule every other kind in this package uses.
 */
export function resolveBoundingBoxTimeFilterMode(
  mode: BoundingBoxTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): BoundingBoxTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

// ── options ─────────────────────────────────────────────────────────────────

export interface STTBoundingBoxLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Categorical column grouping snapshots into one tracked object. `''` makes
   * every snapshot its own held instance (degenerate — no interpolation).
   * @default 'track_id'
   */
  trackIdProperty?: string;
  /** Categorical column driving the per-object colour. @default 'category' */
  colorProperty?: string;
  /** Column whose value rides along for the pick row. @default 'category' */
  labelProperty?: string;
  /** Numeric column carrying the yaw. @default 'heading' */
  headingProperty?: string;
  /** Angular unit of {@link headingProperty}. @default 'radians' */
  headingUnits?: 'radians' | 'degrees';
  /** Numeric column carrying the box extent along its heading. @default 'length' */
  lengthProperty?: string;
  /** Numeric column carrying the box extent across its heading. @default 'width' */
  widthProperty?: string;
  /** Numeric column carrying the box height. @default 'height' */
  heightProperty?: string;
  /** Numeric column carrying ground speed, m/s. @default 'speed' */
  speedProperty?: string;
  /** `category` → RGBA8. Unmatched categories fall back to {@link color}. */
  colorMapping?: Record<string, TrackColor> | null;
  /** Fallback RGBA8 for a category with no mapping entry. @default [160,160,160,255] */
  color?: TrackColor;
  /** Metres used when the length column is absent for a pose. @default 4.5 */
  defaultLength?: number;
  /** Metres used when the width column is absent for a pose. @default 1.9 */
  defaultWidth?: number;
  /** Metres used when the height column is absent for a pose. @default 1.6 */
  defaultHeight?: number;
  /** Uniform multiplier on all three physical extents. @default 1 */
  sizeScale?: number;
  /** Extra multiplier on HEIGHT only (vertical exaggeration). @default 1 */
  elevationScale?: number;
  /**
   * Where the pose sits in the cuboid: `'base'` puts the archive's position on
   * the GROUND plane of the box (right for a vehicle whose recorded position is
   * its ground footprint), `'center'` puts it at the box's centroid (the
   * nuScenes/Waymo `translation` convention).
   * @default 'base'
   */
  zAnchor?: 'base' | 'center';
  /** Layer-wide opacity multiplier, 0..1. Gates picking too. @default 1 */
  opacity?: number;
  /**
   * Draw 12 edges (`gl.LINES`) instead of 12 solid triangles — the classic AV
   * cage. Line width is driver-clamped to 1 px; see the module header.
   * @default false
   */
  wireframe?: boolean;
  /** Shade at the cuboid's base, 0..1; the top cap is 1.0. @default 0.72 */
  wallShade?: number;
  /**
   * Largest bracket gap (ms) a pose is interpolated across. A wider bracket is
   * a data hole: the track HOLDS its last keyframe rather than glide a straight
   * line it never travelled.
   *
   * Named to match `STTIconLayer`/`STTTripHeadsLayer` — it is the option key
   * the backend descriptor proves `motionInterpolation` on across every kind
   * that claims it, and it feeds the kernel's `maxGapMs` exactly as they do.
   * @default Infinity
   */
  maxInterpolationGap?: number;
  /** Hold window (ms) for a track with a single loaded keyframe. @default 600 */
  singletonHoldMs?: number;
  /** Compiled time-filter mode; unset applies deck's precedence. */
  timeFilterMode?: BoundingBoxTimeFilterMode;
  /** `wake` mode: ms a track stays lit after it first appeared. @default 0 */
  wakeLength?: number;
  /** `trail` mode: ms behind the play-head a track's birth stays lit. @default 0 */
  trailLength?: number;
  /** `trail` mode: solid-snake (0) ⇄ comet (1). @default false */
  fadeTrail?: boolean | number;
  /**
   * `'3d'` by DEFAULT and effectively mandatory: overlapping cuboids must
   * resolve by DEPTH in both the visual and the id pass, which is what maplibre
   * gives a `'3d'` custom layer (a LEQUAL read-write depth mode) and what makes
   * `STTBaseLayer.pick` attach a depth renderbuffer to its id FBO. `'2d'` is
   * offered only for a deliberately flat overlay.
   * @default '3d'
   */
  renderingMode?: '2d' | '3d';
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled bounding-box program supports. Both knobs are structural, so
 * each combination is its own program and each must appear in the
 * program-cache key — {@link boundingBoxProgramKey}.
 */
export interface BoundingBoxShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: BoundingBoxTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
}

/** The out-of-the-box configuration: window mode, no filter column. */
const DEFAULT_SHADER_CONFIG: BoundingBoxShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

/** The two draw passes, each with its own compiled program. */
export type BoundingBoxPass = 'fill' | 'pick';

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<BoundingBoxTimeFilterMode, string>> =
  Object.freeze({
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  });

/**
 * Uniforms each mode reads. The plain (non-`WAKE_TAIL_SCALE`) block, because a
 * cuboid's extents are physical measurements and must not taper — see the
 * module header.
 */
const MODE_UNIFORMS: Readonly<Record<BoundingBoxTimeFilterMode, string>> =
  TIME_MODE_UNIFORM_DECLS;

/**
 * The `vAlpha = …` expression per mode. `aTime` is the TRACK'S LIFESPAN
 * `[first, last]`, rebased to the layer's time base, so `trail` reads
 * `aTime.x` — the object's birth — and a box reveals whole.
 */
const MODE_ALPHA: Readonly<Record<BoundingBoxTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
  });

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * Yaw kernel. `rot` is `(cos yaw, −sin yaw)` resolved on the CPU by
 * {@link boxRotation} — the shader pays no transcendentals and the mercator-y
 * flip lives in exactly one place.
 */
export const BOX_ROTATION_GLSL = `
vec2 sttRotateBox(vec2 v, vec2 rot) {
  return vec2(v.x * rot.x - v.y * rot.y, v.x * rot.y + v.y * rot.x);
}
`;

/**
 * DataFilter application. Deck's split: a HARD-filtered instance (`0`) is hidden
 * whatever the transform flags say, while a soft-margin value only fades when
 * `DECKGL_FILTER_COLOR` is on. `uFilterTransformSize` is declared by the shared
 * uniform block but deliberately NOT read — see the module header.
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
`;

/**
 * Emit the projection of one `(mercatorXY, elevationMetres)` pair into a fresh
 * `vec4 ${out}` clip-space position.
 *
 * `aDims.w` is this instance's OWN metres→mercator-z factor at its OWN
 * latitude, so the globe branch's sphere term gets metres while the transition
 * fallback and the mercator/legacy paths get mercator-z, all from one pair of
 * expressions.
 */
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
    elevMercatorZ: `${elevM} * aDims.w`,
    names: {
      out,
      sphere: `${out}Sphere`,
      globe: `${out}Globe`,
      flat: `${out}Flat`,
    },
  });
}

/**
 * Assemble the cuboid vertex shader.
 *
 * Both passes run byte-identical geometry and byte-identical alpha gates; the
 * only differences are which payload varying is written and that the id pass
 * folds the instance colour's ALPHA into `vAlpha` (the visual pass's fragment
 * stage multiplies it instead). That is what makes "a box you cannot see is
 * never pickable" structural rather than a thing to remember.
 *
 * A fully-gated instance is dropped twice over: `gl_Position = vec4(0.0)`
 * collapses it at the vertex stage (every gate is per-INSTANCE, so the cuboid
 * collapses whole — no corner left pinned at the origin) and the fragment
 * shader's `if (vAlpha <= 0.0) discard;` backs that up.
 */
function buildBoundingBoxVs(
  shader: ShaderInjection,
  cfg: BoundingBoxShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const legacy = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const isMain = kind === 'main';
  const idAttribute = isMain
    ? ''
    : '  attribute vec3 aIdColor;     // per-instance encoded pick id (UNSIGNED_BYTE normalized)\n';
  const payloadVarying = isMain
    ? '  varying vec4 vColor;\n  varying float vShade;\n'
    : '  varying vec3 vIdColor;\n';
  // The id pass reads only the instance colour's ALPHA, so a category mapped to
  // `[r,g,b,0]` (the idiomatic "hide this class" spelling) is invisible AND
  // unpickable — deck's `picking_filterPickingColor` discards on the same
  // condition. The visual pass applies the same factor in its FS.
  const colorGate = isMain ? '' : '    vAlpha *= aColor.a;\n';
  const payloadAssign = isMain
    ? '    vColor = aColor;\n    vShade = mix(uWallShade, 1.0, aUnit.z);\n'
    : '    vIdColor = aIdColor;\n';

  return `${head}
  precision highp float;
  attribute vec3 aUnit;        // unit cube vertex: x,y ∈ [-0.5,0.5], z ∈ [0,1]
  attribute vec3 aCenter;      // per-instance pose: (mercatorX, mercatorY, altitudeMetres)
  attribute vec4 aDims;        // per-instance (halfLenMerc, halfWidMerc, heightMetres, mercatorZPerMetre)
  attribute vec2 aRot;         // per-instance (cos yaw, -sin yaw)
  attribute vec4 aColor;       // per-instance RGBA in 0..1
  attribute vec2 aTime;        // per-instance track lifespan [first, last], layer-relative ms
${cfg.filter ? FILTER_ATTRIBUTE : ''}${idAttribute}${legacy}  uniform float uZAnchor;      // 0 = pose on the base, 0.5 = pose at the centroid
  uniform float uOpacity;
  uniform float uWallShade;
${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${payloadVarying}${MODE_GLSL[cfg.mode]}${BOX_ROTATION_GLSL}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vAlpha = ${MODE_ALPHA[cfg.mode]} * uOpacity;
${cfg.filter ? FILTER_BODY : ''}${colorGate}    vec2 local = vec2(aUnit.x * aDims.x, aUnit.y * aDims.y);
    vec2 posM = aCenter.xy + sttRotateBox(local, aRot);
    float elevM = aCenter.z + (aUnit.z - uZAnchor) * aDims.z;
${projectBlock(usesPrelude, 'here', 'posM', 'elevM')}    gl_Position = here;
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${payloadAssign}  }
`;
}

/** Visual cuboid vertex source for a host variant + feature configuration. */
export function buildBoundingBoxVertexSource(
  shader: ShaderInjection,
  cfg: BoundingBoxShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildBoundingBoxVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildBoundingBoxVertexSource}. */
export function buildBoundingBoxIdVertexSource(
  shader: ShaderInjection,
  cfg: BoundingBoxShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildBoundingBoxVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `STTBaseLayer.getOrCreateProgram` appends `::${variantName}` (the HOST
 * variant) only, so two configurations sharing a base key would collide.
 */
export function boundingBoxProgramKey(
  pass: BoundingBoxPass,
  cfg: BoundingBoxShaderConfig,
): string {
  return `boundingBox:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
}

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  varying float vShade;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb * vShade, vColor.a * vAlpha);
  }
`;

/**
 * Id fragment stage: flat, unblended, un-antialiased. A partially covered edge
 * texel must still decode to the exact id byte triple.
 */
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

// ── unit cube ───────────────────────────────────────────────────────────────

/**
 * The unit cuboid: 8 corners with `x,y ∈ [-0.5, 0.5]` and `z ∈ [0, 1]`, so a
 * pose lands on the box's BASE by default and `uZAnchor = 0.5` recentres it
 * without a second mesh. Vertical shade is derived in the shader from `z`, so
 * 8 shared corners suffice — no 24-vertex per-face split, and the SAME vertex
 * buffer feeds both the triangle and the wireframe index sets.
 *
 * Exported for the tests: these are hand-checkable constants.
 */
export const BOX_UNIT_VERTICES: Readonly<Float32Array> =
  /* @__PURE__ */ new Float32Array([
    -0.5,
    -0.5,
    0, // 0 base rear-right
    0.5,
    -0.5,
    0, // 1 base front-right
    0.5,
    0.5,
    0, // 2 base front-left
    -0.5,
    0.5,
    0, // 3 base rear-left
    -0.5,
    -0.5,
    1, // 4 top rear-right
    0.5,
    -0.5,
    1, // 5 top front-right
    0.5,
    0.5,
    1, // 6 top front-left
    -0.5,
    0.5,
    1, // 7 top rear-left
  ]) as Readonly<Float32Array>;

/** 12 triangles: base, top and four walls, all wound counter-clockwise. */
export const BOX_FILL_INDICES: Readonly<Uint16Array> =
  /* @__PURE__ */ new Uint16Array([
    0,
    2,
    1,
    0,
    3,
    2, // base
    4,
    5,
    6,
    4,
    6,
    7, // top
    0,
    1,
    5,
    0,
    5,
    4, // -y wall
    1,
    2,
    6,
    1,
    6,
    5, // +x wall
    2,
    3,
    7,
    2,
    7,
    6, // +y wall
    3,
    0,
    4,
    3,
    4,
    7, // -x wall
  ]) as Readonly<Uint16Array>;

/** 12 edges of the cage. */
export const BOX_WIRE_INDICES: Readonly<Uint16Array> =
  /* @__PURE__ */ new Uint16Array([
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    0, // base ring
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    4, // top ring
    0,
    4,
    1,
    5,
    2,
    6,
    3,
    7, // verticals
  ]) as Readonly<Uint16Array>;

// ── handles ─────────────────────────────────────────────────────────────────

interface BoundingBoxHandles
  extends
    TimeUniformLocations,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  usesPrelude: boolean;
  aUnit: number;
  aCenter: number;
  aDims: number;
  aRot: number;
  aColor: number;
  aTime: number;
  aFilterValue: number;
  aIdColor: number;
  uMatrix: WebGLUniformLocation | null;
  uZAnchor: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uWallShade: WebGLUniformLocation | null;
}

/** Resolved option surface — every field concrete, every default via `??`. */
interface ResolvedBoxOptions {
  trackIdProperty: string;
  colorProperty: string;
  labelProperty: string;
  headingProperty: string;
  headingUnits: 'radians' | 'degrees';
  lengthProperty: string;
  widthProperty: string;
  heightProperty: string;
  speedProperty: string;
  colorMapping: Record<string, TrackColor> | null;
  color: TrackColor;
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  sizeScale: number;
  elevationScale: number;
  zAnchor: 'base' | 'center';
  opacity: number;
  wireframe: boolean;
  wallShade: number;
  maxInterpolationGap: number;
  singletonHoldMs: number;
  timeFilterMode?: BoundingBoxTimeFilterMode;
  wakeLength: number;
  trailLength: number;
  fadeTrail: number;
}

/** Legacy (`uMatrix`) frame for hand-built draw contexts that carry no frame. */
const LEGACY_FRAME: HostFrame = createHostFrame();

// ── layer ───────────────────────────────────────────────────────────────────

export class STTBoundingBoxLayer extends STTFilterableLayer {
  /**
   * `'3d'` by default — overlapping cuboids MUST resolve by depth, in the id
   * pass as much as in the visual one. See {@link STTBoundingBoxLayerOptions}.
   */
  override readonly renderingMode: '2d' | '3d';

  private readonly boxOpts: ResolvedBoxOptions;
  private shaderConfig: BoundingBoxShaderConfig;
  private programKeys: Record<BoundingBoxPass, string>;

  private fillHandles?: BoundingBoxHandles;
  private fillVariant?: string;
  private pickHandles?: BoundingBoxHandles;
  private pickVariant?: string;

  private meshVertexBuffer?: WebGLBuffer;
  private fillIndexBuffer?: WebGLBuffer;
  private wireIndexBuffer?: WebGLBuffer;

  private centerBuffer?: WebGLBuffer;
  private dimsBuffer?: WebGLBuffer;
  private rotBuffer?: WebGLBuffer;
  private colorBuffer?: WebGLBuffer;
  private timeBuffer?: WebGLBuffer;
  private filterBuffer?: WebGLBuffer;

  private centers = new Float32Array(0);
  private dims = new Float32Array(0);
  private rots = new Float32Array(0);
  private colors = new Uint8Array(0);
  private times = new Float32Array(0);
  private filterValues = new Float32Array(0);

  /** The active poses of THIS frame, in draw order — the pick index space. */
  private activeSamples: Sample[] = [];
  private instanceCount = 0;

  /**
   * The layer's time base: the smallest `timeOffset` among the resident tiles.
   * Every instance time and time uniform is expressed against it, because the
   * pool has no per-tile base left and `float32` cannot carry epoch-ms.
   */
  private timeBase = 0;

  /** Memoized pool; rebuilt when the resident tile set or a prop changes. */
  private trackIndex?: TrackIndexResult;
  private trackIndexTileKey = ' ';
  private trackIndexEpoch = -1;
  private configEpoch = 0;

  /** Play-head the instance arrays were last sampled at. */
  private sampledAt = Number.NaN;
  private sampledEpoch = -1;
  private uploadedCount = -1;

  /**
   * Armed once per `render()` by {@link applySharedGlState} and disarmed by the
   * first {@link drawTile}: this layer's draw unit is the LAYER. Starts armed so
   * a test that calls `drawTile` directly (without a `render()`) still draws
   * once — and, deliberately, exactly once.
   */
  private pendingLayerDraw = true;

  private warnedNoInstancing = false;
  private warnedNoFilterColumn = false;
  private warnedTrackIdMissing = false;
  private hasFilterColumn = false;

  constructor(options: STTBoundingBoxLayerOptions) {
    super(options);
    this.renderingMode = options.renderingMode ?? '3d';
    this.boxOpts = {
      trackIdProperty: options.trackIdProperty ?? 'track_id',
      colorProperty: options.colorProperty ?? 'category',
      labelProperty: options.labelProperty ?? 'category',
      headingProperty: options.headingProperty ?? 'heading',
      headingUnits: options.headingUnits ?? 'radians',
      lengthProperty: options.lengthProperty ?? 'length',
      widthProperty: options.widthProperty ?? 'width',
      heightProperty: options.heightProperty ?? 'height',
      speedProperty: options.speedProperty ?? 'speed',
      colorMapping: options.colorMapping ?? null,
      color: options.color ?? DEFAULT_BOX_COLOR,
      defaultLength: options.defaultLength ?? 4.5,
      defaultWidth: options.defaultWidth ?? 1.9,
      defaultHeight: options.defaultHeight ?? 1.6,
      sizeScale: options.sizeScale ?? 1,
      elevationScale: options.elevationScale ?? 1,
      zAnchor: options.zAnchor ?? 'base',
      opacity: options.opacity ?? 1,
      wireframe: options.wireframe ?? false,
      wallShade: options.wallShade ?? DEFAULT_WALL_SHADE,
      maxInterpolationGap: options.maxInterpolationGap ?? Infinity,
      singletonHoldMs: options.singletonHoldMs ?? 600,
      timeFilterMode: options.timeFilterMode,
      wakeLength: options.wakeLength ?? 0,
      trailLength: options.trailLength ?? 0,
      fadeTrail: resolveTrailFade(options.fadeTrail),
    };
    this.shaderConfig = {
      mode: resolveBoundingBoxTimeFilterMode(
        this.boxOpts.timeFilterMode,
        this.boxOpts.wakeLength,
        this.boxOpts.trailLength,
      ),
      filter: Boolean(this.filterOpts.filterProperty),
    };
    this.programKeys = {
      fill: boundingBoxProgramKey('fill', this.shaderConfig),
      pick: boundingBoxProgramKey('pick', this.shaderConfig),
    };
  }

  // ── base hooks ────────────────────────────────────────────────────────────

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  protected onContextReady(): void {
    // Buffers are allocated lazily on the first draw: a layer added to a map
    // that never becomes visible should cost no GPU memory.
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    for (const b of [
      this.meshVertexBuffer,
      this.fillIndexBuffer,
      this.wireIndexBuffer,
      this.centerBuffer,
      this.dimsBuffer,
      this.rotBuffer,
      this.colorBuffer,
      this.timeBuffer,
      this.filterBuffer,
    ]) {
      if (b) gl.deleteBuffer(b);
    }
    this.meshVertexBuffer = undefined;
    this.fillIndexBuffer = undefined;
    this.wireIndexBuffer = undefined;
    this.centerBuffer = undefined;
    this.dimsBuffer = undefined;
    this.rotBuffer = undefined;
    this.colorBuffer = undefined;
    this.timeBuffer = undefined;
    this.filterBuffer = undefined;
    this.fillHandles = undefined;
    this.fillVariant = undefined;
    this.pickHandles = undefined;
    this.pickVariant = undefined;
    this.uploadedCount = -1;
  }

  /**
   * The base calls this exactly once per `render()`, immediately before its
   * tile loop — which makes it the frame boundary this layer needs to collapse
   * N per-tile callbacks into ONE layer-level draw.
   */
  protected override applySharedGlState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    super.applySharedGlState(gl);
    this.pendingLayerDraw = true;
  }

  protected override onFilterChanged(): void {
    // A filter range change does not re-pool, but it DOES change what the
    // per-instance filter attribute must be re-uploaded against on the next
    // frame only if the column itself changed — the range lives in uniforms.
    super.onFilterChanged();
  }

  // ── pooling + sampling ────────────────────────────────────────────────────

  /** Field config handed to the shared pooler. */
  private fieldConfig(): TrackFieldConfig {
    const o = this.boxOpts;
    return {
      trackIdProperty: o.trackIdProperty,
      colorProperty: o.colorProperty,
      labelProperty: o.labelProperty,
      headingProperty: o.headingProperty,
      lengthProperty: o.lengthProperty,
      widthProperty: o.widthProperty,
      heightProperty: o.heightProperty,
      speedProperty: o.speedProperty,
      colorMapping: o.colorMapping,
      colorMappingDefault: o.color,
    };
  }

  /** Sample config handed to the shared interpolator. */
  private sampleConfig(): TrackSampleConfig {
    const o = this.boxOpts;
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    return {
      defaultLength: o.defaultLength,
      defaultWidth: o.defaultWidth,
      defaultHeight: o.defaultHeight,
      fadeInDuration: fadeIn,
      fadeOutDuration: fadeOut,
      // Shortest-arc heading interpolation, in the unit the column is stored
      // in: 'deg' routes to lerpAngleDeg, 'rad' to lerpAngle. Either way
      // 350 → 10 crosses 0 rather than unwinding through 180.
      angleUnit: o.headingUnits === 'degrees' ? 'deg' : 'rad',
      maxGapMs: o.maxInterpolationGap,
      singletonHoldMs: o.singletonHoldMs,
    };
  }

  /**
   * A cheap identity for the resident tile set. `loadedTiles` is keyed
   * `z/x/y/t`, so joining its keys is O(tiles) with no hashing subtleties and
   * changes exactly when the pool would.
   */
  private tileSetKey(): string {
    let key = '';
    for (const k of this.loadedTiles.keys()) key += k + '|';
    return key;
  }

  /**
   * Pool every resident tile's snapshots into absolute-time tracks, memoized on
   * (tile set × config epoch). This is the only O(total snapshots) step, and it
   * runs on a tile change, not on a frame.
   */
  private ensureTrackIndex(): TrackIndexResult {
    const key = this.tileSetKey();
    if (
      this.trackIndex &&
      this.trackIndexTileKey === key &&
      this.trackIndexEpoch === this.configEpoch
    ) {
      return this.trackIndex;
    }
    const tiles = [...this.loadedTiles.values()];
    // One base for the whole pool. The MINIMUM resident offset (rather than,
    // say, the first tile's) keeps every rebased time non-negative and changes
    // only when the tile set does — which is the same event that re-pools.
    let base = Infinity;
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const offset = tileLayer.features.timeOffset;
        if (Number.isFinite(offset) && offset < base) base = offset;
      }
    }
    this.timeBase = Number.isFinite(base) ? base : 0;
    const index = buildTrackIndex(tiles, this.fieldConfig());
    this.trackIndex = index;
    this.trackIndexTileKey = key;
    this.trackIndexEpoch = this.configEpoch;
    if (index.trackIdMissing && !this.warnedTrackIdMissing) {
      this.warnedTrackIdMissing = true;
      console.warn(
        `[${this.id}] no "${this.boxOpts.trackIdProperty}" column on at least ` +
          `one loaded tile; those snapshots each render as their own held box ` +
          `(no interpolation)`,
      );
    }
    return index;
  }

  /**
   * Re-sample every pooled track at the play-head and pack the per-instance
   * arrays. Exactly ONE instance per ACTIVE track — the whole point of this
   * layer. Memoized on (play-head × config epoch × tile set) so the two entry
   * points (draw, pick) in one frame do the work once.
   */
  private rebuildInstances(now: number): void {
    const index = this.ensureTrackIndex();
    if (
      this.sampledAt === now &&
      this.sampledEpoch === this.configEpoch &&
      this.trackIndexTileKey === this.tileSetKey()
    ) {
      return;
    }
    const o = this.boxOpts;
    const cfg = this.sampleConfig();
    const filterColumn = this.filterOpts.filterProperty ?? '';
    const capacity = index.tracks.size;
    if (this.centers.length < capacity * 3) {
      this.centers = new Float32Array(capacity * 3);
      this.dims = new Float32Array(capacity * 4);
      this.rots = new Float32Array(capacity * 2);
      this.colors = new Uint8Array(capacity * 4);
      this.times = new Float32Array(capacity * 2);
      this.filterValues = new Float32Array(capacity);
    }
    this.activeSamples.length = 0;

    let n = 0;
    let sawFilterValue = false;
    for (const track of index.tracks.values()) {
      const s = sampleTrack(track, now, cfg);
      if (!s) continue;

      const mercator = lngLatToMercator(s.lon, s.lat);
      this.centers[n * 3] = mercator[0];
      this.centers[n * 3 + 1] = mercator[1];
      this.centers[n * 3 + 2] = s.alt;

      // Mercator is conformal — one metre is the same number of mercator units
      // on x and y — so a single per-instance factor at this box's OWN latitude
      // is exact for both half-extents however the box is yawed.
      const perMeter = metersToMercatorUnits(1, s.lat);
      this.dims[n * 4] = s.length * o.sizeScale * 0.5 * perMeter;
      this.dims[n * 4 + 1] = s.width * o.sizeScale * 0.5 * perMeter;
      this.dims[n * 4 + 2] = s.height * o.sizeScale * o.elevationScale;
      this.dims[n * 4 + 3] = mercatorZFromAltitude(1, s.lat);

      const heading =
        o.headingUnits === 'degrees' ? (s.heading * Math.PI) / 180 : s.heading;
      const rot = boxRotation(heading);
      this.rots[n * 2] = rot[0];
      this.rots[n * 2 + 1] = rot[1];

      const c = s.track.color;
      this.colors[n * 4] = c[0];
      this.colors[n * 4 + 1] = c[1];
      this.colors[n * 4 + 2] = c[2];
      // The appear/disappear ramp the sampler resolved rides in the alpha byte,
      // so it gates the id pass exactly as it gates the visual one.
      this.colors[n * 4 + 3] = Math.round(
        c[3] * Math.max(0, Math.min(1, s.alpha)),
      );

      // The track's LIFESPAN, not a keyframe time: the time modes gate on how
      // long the OBJECT has existed, and can never multiply its instance.
      // Rebased to the layer's time base — see the module header.
      const kf = track.times;
      this.times[n * 2] = kf[0] - this.timeBase;
      this.times[n * 2 + 1] = kf[kf.length - 1] - this.timeBase;

      if (filterColumn) {
        const v = boundingBoxFilterValue(s, filterColumn);
        if (Number.isFinite(v)) sawFilterValue = true;
        this.filterValues[n] = Number.isFinite(v) ? v : 0;
      }

      this.activeSamples.push(s);
      n++;
    }
    this.instanceCount = n;
    this.sampledAt = now;
    this.sampledEpoch = this.configEpoch;
    this.uploadedCount = -1;

    const had = this.hasFilterColumn;
    this.hasFilterColumn = Boolean(filterColumn) && sawFilterValue;
    if (filterColumn && !this.hasFilterColumn && !this.warnedNoFilterColumn) {
      this.warnedNoFilterColumn = true;
      console.warn(
        `[${this.id}] filterProperty "${filterColumn}" is not a column the ` +
          `track pool carries (${BOUNDING_BOX_FILTERABLE_COLUMNS.join(', ')}); ` +
          `rendering unfiltered`,
      );
    }
    if (had !== this.hasFilterColumn) this.uploadedCount = -1;
  }

  // ── GPU ───────────────────────────────────────────────────────────────────

  private ensureMesh(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (this.meshVertexBuffer) return;
    this.meshVertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, BOX_UNIT_VERTICES, gl.STATIC_DRAW);
    this.fillIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fillIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, BOX_FILL_INDICES, gl.STATIC_DRAW);
    this.wireIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.wireIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, BOX_WIRE_INDICES, gl.STATIC_DRAW);
  }

  /** Upload the per-instance streams, once per (frame × instance set). */
  private uploadInstances(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.uploadedCount === this.instanceCount) return;
    const n = this.instanceCount;
    this.centerBuffer ??= gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.centers.subarray(0, n * 3),
      gl.DYNAMIC_DRAW,
    );
    this.dimsBuffer ??= gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dimsBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.dims.subarray(0, n * 4),
      gl.DYNAMIC_DRAW,
    );
    this.rotBuffer ??= gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rotBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.rots.subarray(0, n * 2),
      gl.DYNAMIC_DRAW,
    );
    this.colorBuffer ??= gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.colors.subarray(0, n * 4),
      gl.DYNAMIC_DRAW,
    );
    this.timeBuffer ??= gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.timeBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.times.subarray(0, n * 2),
      gl.DYNAMIC_DRAW,
    );
    if (this.shaderConfig.filter) {
      this.filterBuffer ??= gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.filterBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.filterValues.subarray(0, n),
        gl.DYNAMIC_DRAW,
      );
    }
    this.uploadedCount = n;
  }

  private resolveHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): BoundingBoxHandles {
    const program = this.linkProgram(
      gl,
      pick
        ? buildBoundingBoxIdVertexSource(shader, this.shaderConfig)
        : buildBoundingBoxVertexSource(shader, this.shaderConfig),
      pick ? ID_FS_SOURCE : FS_SOURCE,
    );
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aUnit: gl.getAttribLocation(program, 'aUnit'),
      aCenter: gl.getAttribLocation(program, 'aCenter'),
      aDims: gl.getAttribLocation(program, 'aDims'),
      aRot: gl.getAttribLocation(program, 'aRot'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      aIdColor: pick ? gl.getAttribLocation(program, 'aIdColor') : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uZAnchor: gl.getUniformLocation(program, 'uZAnchor'),
      uOpacity: gl.getUniformLocation(program, 'uOpacity'),
      uWallShade: gl.getUniformLocation(program, 'uWallShade'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
      ...resolveFilterTransformSizeUniformLocation(gl, program),
    };
  }

  private readonly fillFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): BoundingBoxHandles => this.resolveHandles(gl, shader, false);

  private readonly pickFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): BoundingBoxHandles => this.resolveHandles(gl, shader, true);

  /**
   * Instancing is not optional: the whole draw model is one shared cube × N
   * instances. A runtime without it (WebGL1 with no `ANGLE_instanced_arrays`)
   * is told once and skipped rather than silently drawing one box per tile.
   */
  private ensureInstancing(): boolean {
    if (this.instSupport.enabled) return true;
    if (!this.warnedNoInstancing) {
      this.warnedNoInstancing = true;
      console.warn(
        `[${this.id}] instanced drawing is unavailable (no WebGL2 and no ` +
          `ANGLE_instanced_arrays); the bounding-box layer renders nothing`,
      );
    }
    return false;
  }

  // ── uniforms + attributes ─────────────────────────────────────────────────

  /**
   * LAYER-relative time uniforms — see the module header for why neither
   * absolute nor tile-relative works here. `ctx.windowStart` was derived by the
   * base as `currentTime − cache.timeOffset − timeWindow/2`, so adding the same
   * offset back recovers the absolute bound exactly whichever tile supplied the
   * cache; subtracting {@link timeBase} then lands it in the same frame as
   * `aTime`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: BoundingBoxHandles,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.boxOpts;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - this.timeBase);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - this.timeBase);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - this.timeBase);
        gl.uniform1f(h.uTrailLength, o.trailLength);
        gl.uniform1f(h.uFadeTrail, o.fadeTrail);
        break;
      default: {
        const base = this.timeBase;
        gl.uniform1f(h.uWindowStart, ctx.windowStart + cache.timeOffset - base);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd + cache.timeOffset - base);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  /**
   * Everything the visual and id passes set identically, so the pickable cuboid
   * always matches the drawn one (including on globe, where the prelude owns
   * projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: BoundingBoxHandles,
    cache: TileGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    const o = this.boxOpts;
    gl.uniform1f(h.uZAnchor, o.zAnchor === 'center' ? 0.5 : 0);
    gl.uniform1f(h.uOpacity, o.opacity);
    // A wireframe cage must read as one flat colour, so the vertical shade
    // ramp is switched off rather than compiled out — same program, one uniform.
    gl.uniform1f(h.uWallShade, o.wireframe ? 1 : o.wallShade);
    this.setTimeUniforms(gl, h, cache, ctx);
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, this.hasFilterColumn);
    }
  }

  /** Bind the shared unit cube (divisor 0 — it repeats for every instance). */
  private bindMesh(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: BoundingBoxHandles,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVertexBuffer!);
    gl.enableVertexAttribArray(h.aUnit);
    gl.vertexAttribPointer(h.aUnit, 3, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aUnit, 0);
    gl.bindBuffer(
      gl.ELEMENT_ARRAY_BUFFER,
      this.boxOpts.wireframe ? this.wireIndexBuffer! : this.fillIndexBuffer!,
    );
  }

  private bindInstanceAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: BoundingBoxHandles,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuffer!);
    gl.enableVertexAttribArray(h.aCenter);
    gl.vertexAttribPointer(h.aCenter, 3, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCenter, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.dimsBuffer!);
    gl.enableVertexAttribArray(h.aDims);
    gl.vertexAttribPointer(h.aDims, 4, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aDims, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rotBuffer!);
    gl.enableVertexAttribArray(h.aRot);
    gl.vertexAttribPointer(h.aRot, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aRot, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer!);
    gl.enableVertexAttribArray(h.aColor);
    gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aColor, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.timeBuffer!);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aTime, 1);

    if (this.shaderConfig.filter && this.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 1);
    }
  }

  /**
   * Undo {@link bindInstanceAttributes} on the DEFAULT VAO after a pick pass.
   * Attribute divisors are per-VAO state and a pick runs outside the host's
   * render pass, so every per-instance slot must go back to 0 — otherwise the
   * next non-instanced draw landing on the same slot reads one element per
   * INSTANCE instead of per vertex.
   */
  private releaseInstanceAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: BoundingBoxHandles,
  ): void {
    for (const loc of [h.aCenter, h.aDims, h.aRot, h.aColor, h.aTime]) {
      gl.disableVertexAttribArray(loc);
      this.instSupport.vertexAttribDivisor(loc, 0);
    }
    if (this.shaderConfig.filter && this.filterBuffer && h.aFilterValue >= 0) {
      gl.disableVertexAttribArray(h.aFilterValue);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 0);
    }
    gl.disableVertexAttribArray(h.aUnit);
  }

  private drawMode(gl: WebGLRenderingContext | WebGL2RenderingContext): {
    mode: number;
    count: number;
  } {
    return this.boxOpts.wireframe
      ? { mode: gl.LINES, count: BOX_WIRE_INDICES.length }
      : { mode: gl.TRIANGLES, count: BOX_FILL_INDICES.length };
  }

  // ── draw ──────────────────────────────────────────────────────────────────

  /**
   * The LAYER's draw, hosted in the base's per-tile callback. Only the FIRST
   * (tile, layer) of a frame gets through: the instances were pooled across
   * every resident tile, so drawing per tile would draw every box once per
   * tile.
   */
  protected drawTile(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    if (!this.pendingLayerDraw) return;
    this.pendingLayerDraw = false;
    const gl = _gl;
    if (!this.ensureInstancing()) return;

    this.rebuildInstances(ctx.currentTime);
    if (this.instanceCount <= 0) return;

    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    this.ensureMesh(gl);
    this.uploadInstances(gl);

    let h = this.fillHandles;
    if (!h || this.fillVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        this.programKeys.fill,
        frame,
        this.fillFactory,
      );
      this.fillHandles = h;
      this.fillVariant = variant;
    }
    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, cache, ctx, frame);

    // No VAO: the instance buffers are re-uploaded whenever the play-head
    // moves, and the draw happens once per FRAME (not once per tile), so a
    // recording would be re-validated as often as it was used.
    this.bindMesh(gl, h);
    this.bindInstanceAttributes(gl, h);

    const { mode, count } = this.drawMode(gl);
    this.instSupport.drawElementsInstanced(
      mode,
      count,
      gl.UNSIGNED_SHORT,
      0,
      this.instanceCount,
    );
    this.releaseInstanceAttributes(gl, h);
  }

  /**
   * ONE provenance entry for the whole layer — the hexbin precedent. The draw
   * unit here is "one id per ACTIVE TRACK", not "one id per feature per tile":
   * a track's ids cannot be attributed to a tile, since its keyframes were
   * pooled from all of them.
   */
  protected override buildPickProvenance(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): PickProvenanceEntry[] {
    this.rebuildInstances(this.opts.currentTime);
    if (this.instanceCount <= 0) return [];
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(gl, tile, layer);
        if (!cache) continue;
        // The (tile, layer, cache) triple is carried only so the pass has a
        // draw context; the ids span the layer.
        return [{ tile, layer, cache, idBase: 1, count: this.instanceCount }];
      }
    }
    return [];
  }

  /**
   * Paint every active cuboid its id colour. Same geometry, same projection and
   * — critically — the SAME alpha gates as {@link drawTile}, assembled from the
   * same builder with `kind: 'id'`, so a box the user cannot see is never
   * pickable.
   *
   * Browser-verify-only (the enclosing FBO round-trip needs a live GPU); the
   * id-colour build + decode join are unit-tested in the base.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    if (!this.ensureInstancing()) return;
    this.rebuildInstances(ctx.currentTime);
    const count = this.instanceCount;
    if (count <= 0) return;

    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    this.ensureMesh(gl);
    this.uploadInstances(gl);

    let h = this.pickHandles;
    if (!h || this.pickVariant !== variant) {
      h = this.getOrCreateProgram(
        gl,
        this.programKeys.pick,
        frame,
        this.pickFactory,
      );
      this.pickHandles = h;
      this.pickVariant = variant;
    }
    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, cache, ctx, frame);

    const idColors = this.buildPickIdColors(count, idBase);
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    this.bindMesh(gl, h);
    this.bindInstanceAttributes(gl, h);
    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aIdColor, 1);

    const { mode, count: indexCount } = this.drawMode(gl);
    this.instSupport.drawElementsInstanced(
      mode,
      indexCount,
      gl.UNSIGNED_SHORT,
      0,
      count,
    );

    gl.disableVertexAttribArray(h.aIdColor);
    this.instSupport.vertexAttribDivisor(h.aIdColor, 0);
    this.releaseInstanceAttributes(gl, h);
    gl.deleteBuffer(idBuffer);
  }

  /**
   * Resolve a decoded id against THIS layer's index space: the ids address
   * active TRACKS, not tile feature rows, so the base's `getFeatureProperties`
   * join would land on an unrelated snapshot. Returns the AV inspector row for
   * the pose that was actually drawn.
   */
  protected override resolvePick(
    rgb: readonly [number, number, number],
    provenance: readonly PickProvenanceEntry[],
  ): SttPickResult | null {
    const base = super.resolvePick(rgb, provenance);
    if (!base) return null;
    const sample = this.activeSamples[base.index];
    if (!sample) return null;
    return {
      ...base,
      object: {
        ...makePickRow(sample),
        track_id: sample.track.trackId,
        label: sample.track.label,
      },
    };
  }

  // ── setters ───────────────────────────────────────────────────────────────

  /** Bump whatever memo a prop change invalidates, then repaint. */
  private invalidatePool(): void {
    this.configEpoch++;
    this.sampledAt = Number.NaN;
    this.map?.triggerRepaint();
  }

  setColorMapping(mapping: Record<string, TrackColor> | null): void {
    this.boxOpts.colorMapping = mapping ?? null;
    this.invalidatePool();
  }

  setSizeScale(scale: number): void {
    this.boxOpts.sizeScale = scale;
    this.invalidatePool();
  }

  setElevationScale(scale: number): void {
    this.boxOpts.elevationScale = scale;
    this.invalidatePool();
  }

  setWireframe(on: boolean): void {
    this.boxOpts.wireframe = on;
    this.map?.triggerRepaint();
  }

  setOpacity(opacity: number): void {
    this.boxOpts.opacity = opacity;
    this.map?.triggerRepaint();
  }

  /**
   * Flip the compiled time-filter mode. Rebuilds the program-cache keys and
   * drops the memoized handles so the next draw re-resolves against the right
   * program — the mode is a compile-time axis, never a uniform.
   */
  setTimeFilterMode(mode: BoundingBoxTimeFilterMode | undefined): void {
    this.boxOpts.timeFilterMode = mode;
    this.shaderConfig = {
      ...this.shaderConfig,
      mode: resolveBoundingBoxTimeFilterMode(
        mode,
        this.boxOpts.wakeLength,
        this.boxOpts.trailLength,
      ),
    };
    this.programKeys = {
      fill: boundingBoxProgramKey('fill', this.shaderConfig),
      pick: boundingBoxProgramKey('pick', this.shaderConfig),
    };
    this.fillHandles = undefined;
    this.fillVariant = undefined;
    this.pickHandles = undefined;
    this.pickVariant = undefined;
    this.map?.triggerRepaint();
  }

  /** The compiled shader configuration — read by the tests. */
  get compiledShaderConfig(): Readonly<BoundingBoxShaderConfig> {
    return this.shaderConfig;
  }

  /** Instances emitted by the last sampling pass — read by the tests. */
  get activeInstanceCount(): number {
    return this.instanceCount;
  }

  /**
   * Re-sample at `now` and return the per-instance arrays. The CPU seam the
   * "no train" contract is asserted on, without a GL context.
   */
  sampleInstancesAt(now: number): {
    count: number;
    timeBase: number;
    centers: Float32Array;
    dims: Float32Array;
    rots: Float32Array;
    colors: Uint8Array;
    times: Float32Array;
    filterValues: Float32Array;
    samples: readonly Sample[];
  } {
    this.rebuildInstances(now);
    const n = this.instanceCount;
    return {
      count: n,
      timeBase: this.timeBase,
      centers: this.centers.slice(0, n * 3),
      dims: this.dims.slice(0, n * 4),
      rots: this.rots.slice(0, n * 2),
      colors: this.colors.slice(0, n * 4),
      times: this.times.slice(0, n * 2),
      filterValues: this.filterValues.slice(0, n),
      samples: this.activeSamples.slice(0, n),
    };
  }
}
