/**
 * Ego-vehicle marker — the "you are here" cuboid at the centre of an AV
 * cockpit, drawn at the INTERPOLATED pose for the current play-head.
 *
 * ── What an ego archive is ──────────────────────────────────────────────────
 * A single-track pose stream: one POINT feature per timestamp, each carrying
 * the ego's position (`lon, lat, alt`), its `heading`, and — because a log
 * knows what vehicle recorded it — the vehicle's own `length`/`width`/`height`
 * in metres. A 20 Hz, 20-second nuScenes scene is ~400 features; a comma2k19
 * segment is ~6000. The whole archive describes ONE object moving, not a
 * population.
 *
 * ── The draw ────────────────────────────────────────────────────────────────
 * ONE marker. Never a trail, never one box per keyframe, never a box per tile.
 * Per frame the layer:
 *   1. picks the resident tile whose keyframe span is nearest the play-head
 *      (gap 0 = contains it),
 *   2. BINARY-SEARCHES that tile's time-sorted track for the bracketing pair,
 *   3. LERPs position and vehicle extent, and SHORTEST-ARC lerps heading,
 *   4. uploads that pose as UNIFORMS and issues one `drawElements` over a
 *      static 24-vertex unit cuboid.
 *
 * So the per-frame cost is `O(log k)` in the number of resident keyframes plus
 * a handful of `uniform*` calls — it is the same cost with 400 keyframes
 * resident as with 400,000, and the instance count is 1 either way. That is the
 * whole design: the pose stream is bulk DATA but the render is a SINGLETON, so
 * nothing per-keyframe is ever allowed onto the GPU per frame. The base's
 * per-tile position/time buffers are still built (the base owns their
 * lifetime), they are simply not what this layer draws.
 *
 * Between two keyframes the marker MOVES CONTINUOUSLY. A pose stream sampled at
 * 2 Hz would otherwise teleport twice a second under a 60 fps clock, which
 * reads as a broken playhead rather than a slow log. Interpolation is the
 * feature, not an optimization.
 *
 * `maxInterpolationGap` is the same guard `STTIconLayer` and `STTTripHeadsLayer`
 * carry (and the key the backend descriptor probes `motionInterpolation` with):
 * across a hole larger than the gap — a GPS dropout, a paused recorder — the
 * pose HOLDS the last real sample instead of gliding smoothly through data that
 * does not exist. The held pose reports the span the ARCHIVE gave that sample,
 * so once the play-head runs past it the time filter fades the marker and the
 * dropout reads as a dropout rather than as a slow, confident glide.
 * Those two layers pool entities by id and run the hoisted core track kernel
 * (`@poopdeck.gl/core` `sampleTrack`); this one has a single un-pooled track and
 * two requirements that kernel does not carry — a SHORTEST-ARC heading channel,
 * and a clamp-then-fade at the ends rather than a hard `null` — so it samples
 * its own track and matches the kernel on the knob that is observable.
 *
 * ── Why this kind exists at all ─────────────────────────────────────────────
 * The deck backend has NO ego layer: `/drive` composes a point layer and an
 * icon layer at the APP level and lets the app own the interpolation. That
 * works, but it puts a per-frame CPU lerp and a data-prop identity hazard in
 * every consumer, and it cannot express "one marker" to a backend-descriptor
 * gate. Here the singleton IS the layer.
 *
 * ── Geometry and orientation ────────────────────────────────────────────────
 * The marker is a unit cuboid: `x, y ∈ [-0.5, 0.5]` (lateral, longitudinal),
 * `z ∈ [0, 1]` (ground → roof), plus a per-vertex `shade`. It is scaled by the
 * pose's own metric extent, so the box on screen is the vehicle's true
 * footprint, and rotated by the pose heading.
 *
 * `heading` is RADIANS COUNTER-CLOCKWISE FROM EAST — the `atan2(Δnorth,
 * Δeast)` convention `packages/three`'s ego layer uses, and the convention its
 * direction-of-travel fallback produces. Archives that bake a compass BEARING
 * (degrees clockwise from north) set `headingUnits: 'degrees'` and
 * `headingOffset`; the conversion is CPU-side so the shader stays one
 * `(cos, sin)` pair. Mercator's `y` grows SOUTHWARD, so the shader negates the
 * north component after rotating — a rotation done directly in mercator axes
 * would mirror the vehicle and point the nose the wrong way at every heading
 * except due east and due west.
 *
 * Face shading makes heading legible without a separate arrow: roof brightest,
 * NOSE next, tail darkest. A cuboid with six identically-lit faces is a
 * direction-free blob at cockpit zoom.
 *
 * `renderingMode` is `'3d'` by default: the marker sits ON terrain among
 * extruded buildings and other 3D STT layers, and must resolve against them by
 * DEPTH rather than by draw order. That also gives its id pass a depth
 * attachment (`STTBaseLayer.pick`), so a marker hidden behind a building is not
 * pickable through it.
 *
 * ── Time filtering ──────────────────────────────────────────────────────────
 * All four modes are carried, compiled in (no mode uniform), through the shared
 * `shaders/time-window.glsl.ts` kernels — but the marker's time span is not a
 * per-feature attribute, it is the BRACKETING PAIR's span uploaded as `uTime`
 * and aliased to a local `vec2 aTime` in `main()`. The alias is deliberate: it
 * lets this layer splice the package's shared alpha expressions BYTE-IDENTICALLY
 * (`sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)`),
 * so a change to the shared kernel cannot leave this kind behind.
 *
 * By construction the bracketing span straddles the play-head, so inside the
 * log every mode lights the marker. That is not a no-op: the gate is what makes
 * the marker VANISH once the clock leaves the log. When the play-head runs past
 * the last keyframe the pose CLAMPS to the track's end (so the box does not
 * jump to the origin or flicker across a tile seam) and its span falls behind
 * the render window — the time alpha then fades it out on exactly the same
 * curve every other kind uses. Deleting the gate would leave a ghost vehicle
 * parked at the end of the log forever.
 *
 * The footprint does NOT taper in `wake` mode and does NOT shrink under
 * `filterTransformSize`. The cuboid's extent is the vehicle's real metric size,
 * the same argument that keeps a summary cell's footprint (which is geography)
 * from tapering: a half-size ego box is a smaller CAR, which is a lie about the
 * data. `uFilterTransformSize` is still declared for uniform-block parity with
 * every other kind and simply never read — deck's `SolidPolygonLayer` makes the
 * identical trade.
 *
 * ── What this layer deliberately does NOT do ────────────────────────────────
 *  - **No trail / no history.** One marker, present tense. A breadcrumb of past
 *    poses is `STTPathLayer` or `STTTripsLayer` over the same archive, composed
 *    beside this one; baking it in here would put the whole track on the GPU
 *    every frame and forfeit the `O(log k)` property above.
 *  - **No sensor frustum, no LiDAR, no bounding boxes for OTHER agents.** Those
 *    are separate archives and separate kinds; this layer knows about exactly
 *    one vehicle.
 *  - **No per-feature colour column.** One vehicle has one colour. A
 *    `colorMapping` over a single-object track would be a category legend with
 *    one entry.
 *  - **No instancing.** There is one instance; `drawElementsInstanced` with
 *    `instanceCount: 1` would only add an extension probe and a divisor reset
 *    to a draw that does not need them. This is also the one kind here that
 *    runs correctly on a WebGL1 context with no instancing extension at all.
 *  - **No chord subdivision on globe.** A vehicle is metres across; a
 *    subdivision cell is degrees. The cuboid is projected per-vertex through
 *    the prelude's `projectTileFor3D` (with the horizon clip re-derived by
 *    `buildElevatedProjection`), which is already exact at this scale.
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
  type RGBA,
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
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_UNIFORMS_GLSL,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  type DataFilterUniformLocations,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
import {
  lngLatToMercator,
  mercatorZFromAltitude,
  metersToMercatorUnits,
  tileCenterLatitude,
} from '../lib/projection.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's name.
 */
export type EgoTimeFilterMode = STTTimeFilterMode;

const TAU = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Fallback vehicle extent in METRES when the archive bakes no dimension
 * columns: the nuScenes ego (a Renault Zoe), which is close enough to a generic
 * passenger car that a log from any other platform still reads as a car rather
 * than as a lorry or a pin.
 */
export const DEFAULT_EGO_LENGTH_M = 4.084;
/** @see DEFAULT_EGO_LENGTH_M */
export const DEFAULT_EGO_WIDTH_M = 1.73;
/** @see DEFAULT_EGO_LENGTH_M */
export const DEFAULT_EGO_HEIGHT_M = 1.562;

/**
 * Per-face brightness of the unit cuboid. The roof reads full, the NOSE next,
 * the tail darkest — the direction cue. The `0.75` side value is the package's
 * extruded-wall convention (`STTPolygonLayer`, `STTColumnLayer`), so an ego box
 * sitting among extruded geometry is lit the same way it is.
 */
export const EGO_FACE_SHADE = Object.freeze({
  roof: 1.0,
  nose: 0.95,
  side: 0.75,
  tail: 0.6,
  floor: 0.45,
});

const LEGACY_FRAME: HostFrame = createHostFrame();

// ── pose maths ──────────────────────────────────────────────────────────────

/**
 * Interpolate `a → b` along the SHORTEST ARC, in radians.
 *
 * A plain `a + (b - a) * t` spins the vehicle the long way round whenever the
 * pair straddles the branch cut: a car crossing due west from `+3.10` rad to
 * `-3.10` rad would sweep 355° through a full clockwise pirouette in one
 * keyframe interval instead of the 2.5° it actually turned. The difference is
 * wrapped into `(-π, π]` first, so the interpolation always takes the short
 * way and `t ∈ [0, 1]` stays a linear angular rate.
 */
export function lerpHeadingShortestArc(
  a: number,
  b: number,
  t: number,
): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return a + d * t;
}

/** Index of the last entry of ascending `times` that is `<= t`, or `-1`. */
function lastAtOrBefore(
  times: ArrayLike<number>,
  count: number,
  t: number,
): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** One resolved ego pose: everything the shader needs, in source units. */
export interface EgoPose {
  /** Tile-mercator X of the vehicle origin. */
  x: number;
  /** Tile-mercator Y of the vehicle origin. */
  y: number;
  /** Altitude in METRES (0 when the archive is 2D). */
  z: number;
  /** Radians counter-clockwise from EAST. */
  heading: number;
  /** Vehicle extent in METRES. */
  length: number;
  width: number;
  height: number;
  /** Bracketing span, TILE-RELATIVE, fed to the time-filter kernel. */
  startTime: number;
  endTime: number;
  /** Feature index of the LOWER bracketing keyframe, for pick provenance. */
  index: number;
  /** DataFilter column value at the lower keyframe (`NaN` when absent). */
  filterValue: number;
  /** `true` when the play-head sits outside the track and the pose is clamped. */
  clamped: boolean;
  /** `true` when `maxInterpolationGap` suppressed the glide across a data hole. */
  held: boolean;
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set. Byte-for-
 * byte the rule every other kind in this package uses.
 */
export function resolveEgoTimeFilterMode(
  mode: EgoTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): EgoTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

// ── unit cuboid ─────────────────────────────────────────────────────────────

/** The shared unit-cuboid mesh: `vec4 (x, y, z, shade)` × 24, 36 indices. */
export interface EgoMesh {
  vertices: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

let MESH: EgoMesh | undefined;

/**
 * Build the unit cuboid: six independent quads (24 vertices) rather than eight
 * shared corners, because each face carries its OWN `shade` and a shared corner
 * could only carry one. `x` is lateral (left +), `y` is longitudinal (nose +),
 * `z` is `0` at the ground and `1` at the roof — so the vertex shader scales by
 * `(width, length, height)` with no axis re-mapping.
 *
 * Module-level and immutable: one geometry serves every ego layer on the page.
 */
export function buildEgoCuboidMesh(): EgoMesh {
  if (MESH) return MESH;
  const s = EGO_FACE_SHADE;
  // (x, y, z) corners per face, wound counter-clockwise seen from outside.
  const faces: Array<{ shade: number; corners: number[][] }> = [
    {
      shade: s.roof,
      corners: [
        [-0.5, -0.5, 1],
        [0.5, -0.5, 1],
        [0.5, 0.5, 1],
        [-0.5, 0.5, 1],
      ],
    },
    {
      shade: s.floor,
      corners: [
        [-0.5, 0.5, 0],
        [0.5, 0.5, 0],
        [0.5, -0.5, 0],
        [-0.5, -0.5, 0],
      ],
    },
    {
      shade: s.nose,
      corners: [
        [-0.5, 0.5, 0],
        [-0.5, 0.5, 1],
        [0.5, 0.5, 1],
        [0.5, 0.5, 0],
      ],
    },
    {
      shade: s.tail,
      corners: [
        [0.5, -0.5, 0],
        [0.5, -0.5, 1],
        [-0.5, -0.5, 1],
        [-0.5, -0.5, 0],
      ],
    },
    {
      shade: s.side,
      corners: [
        [-0.5, -0.5, 0],
        [-0.5, -0.5, 1],
        [-0.5, 0.5, 1],
        [-0.5, 0.5, 0],
      ],
    },
    {
      shade: s.side,
      corners: [
        [0.5, 0.5, 0],
        [0.5, 0.5, 1],
        [0.5, -0.5, 1],
        [0.5, -0.5, 0],
      ],
    },
  ];
  const vertices = new Float32Array(24 * 4);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (let f = 0; f < faces.length; f++) {
    const base = f * 4;
    for (const c of faces[f].corners) {
      vertices[v++] = c[0];
      vertices[v++] = c[1];
      vertices[v++] = c[2];
      vertices[v++] = faces[f].shade;
    }
    indices[i++] = base;
    indices[i++] = base + 1;
    indices[i++] = base + 2;
    indices[i++] = base;
    indices[i++] = base + 2;
    indices[i++] = base + 3;
  }
  MESH = Object.freeze({
    vertices,
    indices,
    vertexCount: 24,
    indexCount: 36,
  }) as EgoMesh;
  return MESH;
}

// ── options ─────────────────────────────────────────────────────────────────

export interface STTEgoLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Marker colour, `[r, g, b, a]` as 0–255 ints or 0–1 floats. Alpha `0` hides
   * the marker AND makes it unpickable (the id pass gates on the same alpha).
   */
  color?: RGBA;

  /**
   * Numeric column holding the heading, in the units named by
   * {@link headingUnits}. When the column is absent — or a sample is not finite
   * — the heading falls back to the DIRECTION OF TRAVEL between the bracketing
   * keyframes, which is what an archive without an IMU can offer.
   * Default `'heading'`.
   */
  headingProperty?: string;
  /** Units of the {@link headingProperty} column. Default `'radians'`. */
  headingUnits?: 'radians' | 'degrees';
  /**
   * Radians added AFTER unit conversion. A compass bearing (clockwise from
   * north) becomes the package convention with
   * `headingUnits: 'degrees'` and the archive negated upstream; a body frame
   * whose nose is `+x` rather than `+y` corrects here with `Math.PI / 2`.
   * Default `0`.
   */
  headingOffset?: number;

  /** Numeric column holding the vehicle length in METRES. Default `'length'`. */
  lengthProperty?: string;
  /** Numeric column holding the vehicle width in METRES. Default `'width'`. */
  widthProperty?: string;
  /** Numeric column holding the vehicle height in METRES. Default `'height'`. */
  heightProperty?: string;

  /** Length in METRES when no column supplies one. @see DEFAULT_EGO_LENGTH_M */
  length?: number;
  /** Width in METRES when no column supplies one. */
  width?: number;
  /** Height in METRES when no column supplies one. */
  height?: number;

  /**
   * Multiplier on the resolved metric extent. `1` (default) draws the vehicle
   * at true size; `1.5` fattens the marker so it stays findable when the camera
   * pulls back to city scale. It scales the BOX, never the pose.
   */
  sizeScale?: number;
  /**
   * Units the extent is expressed in. `'meters'` (default) is true-scale and
   * converts at the tile's own centre latitude. `'pixels'` pins the marker to a
   * constant SCREEN footprint at the current zoom — an overview mode, where a
   * true-scale car is sub-pixel.
   */
  sizeUnits?: 'meters' | 'pixels';
  /** Multiplier on the box HEIGHT only, after `sizeScale`. Default `1`. */
  elevationScale?: number;

  /**
   * Largest keyframe gap, in ms, that is still interpolated ACROSS. A wider
   * hole holds the last real sample rather than fabricating a glide through it.
   * Default `Infinity` (interpolate every gap) — the same default and the same
   * semantics as `STTIconLayer` / `STTTripHeadsLayer`.
   */
  maxInterpolationGap?: number;

  /** Wake length in ms; also selects `wake` mode when `timeFilterMode` is unset. */
  wakeLength?: number;
  /** Trail length in ms; also selects `trail` mode when `timeFilterMode` is unset. */
  trailLength?: number;
  /** `0` solid, `1` comet. Default `1`, via `resolveTrailFade`. */
  fadeTrail?: boolean | number;
  /** Which time-filter kernel to compile. Default: deck's precedence rule. */
  timeFilterMode?: EgoTimeFilterMode;

  /**
   * `'3d'` (default) so the marker resolves against terrain, extruded buildings
   * and other 3D STT layers by depth. `'2d'` restores the package's
   * always-on-top behaviour for a flat basemap.
   */
  renderingMode?: '2d' | '3d';
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled ego program supports. Both knobs are structural (they add
 * uniforms and statements), so each combination is its own program and each
 * must appear in the program-cache key — {@link egoProgramKey}.
 */
export interface EgoShaderConfig {
  mode: EgoTimeFilterMode;
  filter: boolean;
}

const DEFAULT_SHADER_CONFIG: EgoShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

/** The two draw passes, each with its own compiled program. */
export type EgoPass = 'body' | 'pick';

const MODE_GLSL: Readonly<Record<EgoTimeFilterMode, string>> = Object.freeze({
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
});

/**
 * Uniforms each mode reads. The plain (non-`WITH_WAKE_TAIL_SCALE`) table: the
 * ego footprint is the vehicle's true metric extent and must not taper — see
 * the module header.
 */
const MODE_UNIFORMS: Readonly<Record<EgoTimeFilterMode, string>> =
  TIME_MODE_UNIFORM_DECLS;

/**
 * The `vAlpha = …` expression per mode, spliced BYTE-IDENTICALLY to the other
 * kinds' — `aTime` here is a local alias of `uTime` (the marker is a singleton,
 * so its span is a uniform, not an attribute), which is exactly what makes the
 * shared spelling reusable.
 */
const MODE_ALPHA: Readonly<Record<EgoTimeFilterMode, string>> = Object.freeze({
  window:
    'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
  wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
  cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
  trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
});

const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * Rotate a unit-cuboid offset into mercator axes.
 *
 * `rot` is `(cos heading, sin heading)` resolved on the CPU, heading measured
 * counter-clockwise from EAST. The offset is composed in East/North metres —
 * `forward` along the heading, `left` perpendicular — and only then does the
 * north component flip sign, because mercator `y` grows southward. Rotating
 * straight in mercator axes would mirror the vehicle.
 */
const EGO_ROTATE_GLSL = `
vec2 sttEgoOffsetMeters(vec2 unitXY, vec2 sizeM, vec2 rot) {
  vec2 forwardEN = vec2(rot.x, rot.y) * (unitXY.y * sizeM.y);
  vec2 leftEN = vec2(-rot.y, rot.x) * (unitXY.x * sizeM.x);
  vec2 en = forwardEN + leftEN;
  return vec2(en.x, -en.y);
}
`;

/**
 * DataFilter application. The hard gate hides the marker outright; the soft
 * margin only fades it when `filterTransformColor` is on. `uFilterTransformSize`
 * is declared by the shared uniform block and deliberately NOT read — a
 * shrunken ego box is a lie about the vehicle's size (module header).
 */
const FILTER_BODY = `    float aFilterValue = uFilterValue;
    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
`;

/**
 * Assemble the ego vertex shader for one host variant + feature configuration.
 *
 * Legacy hosts (empty prelude) keep the `uMatrix` path; v5+ hosts get the
 * injected prelude + define prepended in maplibre's documented order and
 * project through `projectTileFor3D` — the marker is genuinely 3D (it has a
 * roof), and on globe `buildElevatedProjection` re-derives the horizon clip
 * that `projectTileFor3D` deliberately drops.
 *
 * The pose arrives entirely by UNIFORM; the only attribute is the shared unit
 * cuboid. That is what keeps the draw independent of keyframe count.
 */
function buildEgoVs(
  shader: ShaderInjection,
  cfg: EgoShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const legacy = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const isMain = kind === 'main';
  const idUniform = isMain
    ? ''
    : '  uniform vec3 uIdColor;       // encoded pick id, already 0..1 normalized\n';
  const payloadVarying = isMain
    ? '  varying vec4 vColor;\n  varying float vShade;\n'
    : '  varying vec3 vIdColor;\n';
  // The id pass reads the colour's ALPHA only: a marker painted `[r,g,b,0]` is
  // invisible and must not be pickable either. Applied AFTER the time and
  // filter alphas so the gates compose the same way in both passes.
  const colorGate = isMain ? '' : '    vAlpha *= uColor.a;\n';
  const payloadAssign = isMain
    ? '    vColor = uColor;\n    vShade = aUnit.w;\n'
    : '    vIdColor = uIdColor;\n';

  return `${head}
  precision highp float;
  attribute vec4 aUnit;        // unit cuboid vertex: (xLateral, yLongitudinal, zUnit 0|1, shade)
${legacy}  uniform vec3 uCenter;        // tile-mercator xy + altitude METRES
  uniform vec2 uTime;          // bracketing keyframe span, tile-relative
  uniform vec2 uHeadingRot;    // (cos heading, sin heading), CCW from east
  uniform vec3 uSizeM;         // (width, length, height) in METRES
  uniform float uSizeScale;
  uniform float uElevationScale;
  uniform float uMetersToUnits; // METRES → mercator XY at this tile's latitude
  uniform float uMercatorZPerMeter; // METRES → mercator-z at this tile's latitude
  uniform vec4 uColor;
${idUniform}${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}${cfg.filter ? '  uniform float uFilterValue;  // DataFilter column at the lower bracketing keyframe\n' : ''}  varying float vAlpha;
${payloadVarying}${MODE_GLSL[cfg.mode]}${EGO_ROTATE_GLSL}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
    vec2 aTime = uTime;        // singleton span: uniform, aliased so the shared kernels read verbatim
    vAlpha = ${MODE_ALPHA[cfg.mode]};
${cfg.filter ? FILTER_BODY : ''}${colorGate}    vec3 sizeM = uSizeM * uSizeScale;
    vec2 offsetM = sttEgoOffsetMeters(aUnit.xy, sizeM.xy, uHeadingRot);
    vec2 posM = uCenter.xy + offsetM * uMetersToUnits;
    float elevM = uCenter.z + aUnit.z * sizeM.z * uElevationScale;
${buildElevatedProjection({
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
})}    gl_Position = here;
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${payloadAssign}  }
`;
}

/** Visual vertex source for a host variant + feature configuration. */
export function buildEgoVertexSource(
  shader: ShaderInjection,
  cfg: EgoShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildEgoVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildEgoVertexSource}. */
export function buildEgoIdVertexSource(
  shader: ShaderInjection,
  cfg: EgoShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildEgoVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `STTBaseLayer.getOrCreateProgram` appends `::${variantName}` (the HOST
 * variant) only, so two configurations sharing a base key would collide.
 */
export function egoProgramKey(pass: EgoPass, cfg: EgoShaderConfig): string {
  return `ego:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
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
 * Id-pick fragment stage. No blending, no antialiasing, no face shading: the
 * readback must recover the byte triple exactly. The `vAlpha` discard is what
 * keeps a time-filtered, DataFilter-hidden or transparent marker out of the
 * hit test.
 */
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // an invisible ego is not pickable
    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;

// ── program handles ─────────────────────────────────────────────────────────

interface EgoHandles extends TimeUniformLocations, DataFilterUniformLocations {
  program: WebGLProgram;
  usesPrelude: boolean;
  aUnit: number;
  uMatrix: WebGLUniformLocation | null;
  uCenter: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uHeadingRot: WebGLUniformLocation | null;
  uSizeM: WebGLUniformLocation | null;
  uSizeScale: WebGLUniformLocation | null;
  uElevationScale: WebGLUniformLocation | null;
  uMetersToUnits: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uFilterValue: WebGLUniformLocation | null;
  uIdColor: WebGLUniformLocation | null;
}

// ── tile cache ──────────────────────────────────────────────────────────────

/**
 * Per-tile CPU track plus the base's GPU buffers. The `Float64Array` times are
 * not paranoia: epoch-ms at 20 Hz needs more than a `float32`'s 24-bit mantissa
 * to keep two adjacent keyframes distinct, and a collapsed pair makes the lerp
 * denominator zero.
 */
interface EgoTileCache extends TileGpuCache {
  /** Ascending tile-relative start times of the sorted track. */
  keyTimes: Float64Array;
  /** Tile-relative end times, parallel to {@link keyTimes}. */
  keyEndTimes: Float64Array;
  /** Mercator x, y + altitude METRES, stride 3, parallel to {@link keyTimes}. */
  keyTrack: Float64Array;
  /** Original feature index per sorted slot — the pick id offset. */
  keyIndex: Uint32Array;
  keyHeading: Float32Array | null;
  keyLength: Float32Array | null;
  keyWidth: Float32Array | null;
  keyHeight: Float32Array | null;
  keyFilter: Float32Array | null;
  hasFilterColumn?: boolean;
  keyframeCount: number;
  /** METRES → mercator XY at this tile's centre latitude. */
  metersToUnits: number;
  /** METRES → mercator Z at this tile's centre latitude. */
  mercatorZScale: number;
}

/** The tile that owns the marker this frame, and the pose it resolved to. */
interface EgoFrameTarget {
  tile: Tile;
  layer: STTLayer;
  cache: EgoTileCache;
  pose: EgoPose;
}

// ── layer ───────────────────────────────────────────────────────────────────

export class STTEgoLayer extends STTFilterableLayer {
  /**
   * `'3d'` by default — see {@link STTEgoLayerOptions.renderingMode}. Assigned
   * in the constructor, so the field is redeclared over the base's `'2d'`.
   */
  readonly renderingMode: '2d' | '3d';

  private readonly egoOpts: {
    color: RGBA;
    headingProperty: string;
    headingUnits: 'radians' | 'degrees';
    headingOffset: number;
    lengthProperty: string;
    widthProperty: string;
    heightProperty: string;
    length: number;
    width: number;
    height: number;
    sizeScale: number;
    sizeUnits: 'meters' | 'pixels';
    elevationScale: number;
    maxInterpolationGap: number;
    wakeLength: number;
    trailLength: number;
    fadeTrail: number;
  };

  private readonly shaderConfig: EgoShaderConfig;
  private readonly programKeys: Readonly<Record<EgoPass, string>>;

  private bodyHandles?: EgoHandles;
  private bodyVariant?: string;
  private pickHandles?: EgoHandles;
  private pickVariant?: string;

  private meshVertexBuffer?: WebGLBuffer;
  private meshIndexBuffer?: WebGLBuffer;

  // Reused vec3 payloads: one uniform each, one upload per frame, so a shared
  // scratch would let the second overwrite the first before the driver read it.
  private readonly centerScratch = new Float32Array(3);
  private readonly sizeScratch = new Float32Array(3);
  private readonly idColorScratch = new Float32Array(3);

  /** The pose the last visual frame drew — what a UI overlay wants to read. */
  private lastPose: EgoPose | null = null;

  constructor(opts: STTEgoLayerOptions) {
    super(opts);
    // Redeclared over the base's `'2d'`; `??` (never a spread) so an explicitly
    // passed `renderingMode: undefined` still lands on the default.
    this.renderingMode = opts.renderingMode ?? '3d';
    this.egoOpts = {
      color: opts.color ?? [64, 196, 255, 235],
      headingProperty: opts.headingProperty ?? 'heading',
      headingUnits: opts.headingUnits ?? 'radians',
      headingOffset: opts.headingOffset ?? 0,
      lengthProperty: opts.lengthProperty ?? 'length',
      widthProperty: opts.widthProperty ?? 'width',
      heightProperty: opts.heightProperty ?? 'height',
      length: opts.length ?? DEFAULT_EGO_LENGTH_M,
      width: opts.width ?? DEFAULT_EGO_WIDTH_M,
      height: opts.height ?? DEFAULT_EGO_HEIGHT_M,
      sizeScale: opts.sizeScale ?? 1,
      sizeUnits: opts.sizeUnits ?? 'meters',
      elevationScale: opts.elevationScale ?? 1,
      maxInterpolationGap: opts.maxInterpolationGap ?? Number.POSITIVE_INFINITY,
      wakeLength: opts.wakeLength ?? 0,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.shaderConfig = Object.freeze({
      mode: resolveEgoTimeFilterMode(
        opts.timeFilterMode,
        this.egoOpts.wakeLength,
        this.egoOpts.trailLength,
      ),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
    });
    this.programKeys = Object.freeze({
      body: egoProgramKey('body', this.shaderConfig),
      pick: egoProgramKey('pick', this.shaderConfig),
    });
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  // ── runtime setters ───────────────────────────────────────────────────────

  /** Update the marker colour (0–1 floats or 0–255 ints). */
  setColor(color: RGBA): void {
    this.egoOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Update the box multiplier (true scale is `1`). */
  setSizeScale(scale: number): void {
    this.egoOpts.sizeScale = scale;
    this.map?.triggerRepaint();
  }

  /** Update the height-only multiplier applied after `sizeScale`. */
  setElevationScale(scale: number): void {
    this.egoOpts.elevationScale = scale;
    this.map?.triggerRepaint();
  }

  /**
   * The pose the most recent visual frame drew, or `null` when the marker was
   * gated off. Read-only snapshot for a cockpit HUD (speed, heading readout) —
   * it is a COPY, so a caller cannot mutate what the next frame interpolates.
   */
  getCurrentPose(): EgoPose | null {
    return this.lastPose ? { ...this.lastPose } : null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  protected onContextReady(): void {
    // Programs and the unit mesh are built lazily on first draw (a v5 host
    // recompiles per projection variant, and after a context restore the base
    // cache is empty and relinks anyway), so there is nothing worth
    // pre-linking. The first pick always follows at least one rendered frame.
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Program lifetimes belong to the base's per-variant cache (dropped before
    // this hook runs); only our handle references and our own mesh buffers are
    // ours to release. Deletes on an already-lost context are ignored, which is
    // exactly the reference-release this needs.
    this.bodyHandles = undefined;
    this.bodyVariant = undefined;
    this.pickHandles = undefined;
    this.pickVariant = undefined;
    if (this.meshVertexBuffer) gl.deleteBuffer(this.meshVertexBuffer);
    if (this.meshIndexBuffer) gl.deleteBuffer(this.meshIndexBuffer);
    this.meshVertexBuffer = undefined;
    this.meshIndexBuffer = undefined;
    this.lastPose = null;
  }

  /**
   * GL state for the frame. Like every `'3d'` kind here, the host has already
   * installed its LEQUAL read-write depth mode before calling us, so we leave
   * it alone — disabling `DEPTH_TEST` would make the marker paint over the
   * building it is behind. `'2d'` keeps the package's always-on-top behaviour.
   */
  protected applySharedGlState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.renderingMode !== '3d') gl.disable(gl.DEPTH_TEST);
  }

  // ── tile cache ────────────────────────────────────────────────────────────

  /**
   * Build the per-tile cache. The base's quantized position/time buffers are
   * kept (the base owns their lifetime and a future sibling pass may want
   * them), but this layer draws from the CPU-side track built here: mercator
   * positions, ascending times, and whatever pose columns the tile bakes.
   *
   * The sort is the binary search's precondition and runs ONCE per tile, at
   * upload — an ego archive is usually already time-ordered, so this is a
   * near-linear pass, and paying it here is what makes every subsequent frame
   * `O(log k)`. Every absent column degrades to the constant option, never to
   * a hidden marker.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): EgoTileCache | null {
    const baseCache = super.buildTileGpuCache(gl, tile, layer);
    if (!baseCache) return null;
    const f = layer.features;
    const cache = baseCache as EgoTileCache;

    const dims: 2 | 3 = f.positionDimensions === 3 ? 3 : 2;
    const count = Math.min(f.featureCount, baseCache.vertexCount);
    if (count <= 0) return null;

    const starts = f.startTimes;
    const ends = f.endTimes;

    // Sort an INDEX permutation, not the arrays — the original index is the
    // pick id offset and must survive the reorder.
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    const orderArray = Array.from(order).sort(
      (a, b) => (starts?.[a] ?? 0) - (starts?.[b] ?? 0),
    );

    const keyTimes = new Float64Array(count);
    const keyEndTimes = new Float64Array(count);
    const keyTrack = new Float64Array(count * 3);
    const keyIndex = new Uint32Array(count);
    for (let k = 0; k < count; k++) {
      const src = orderArray[k];
      keyIndex[k] = src;
      keyTimes[k] = starts?.[src] ?? 0;
      keyEndTimes[k] = ends?.[src] ?? keyTimes[k];
      // Projected here rather than through `projectPositions`, whose stride-3
      // output is a Float32Array. Mercator is a 0..1 world, so a float32 lands
      // on a ~0.6 m grid — coarser than the gap between two 20 Hz pose samples
      // at urban speed. Rounding the KEYFRAMES to that grid before interpolating
      // does not just add error, it collapses adjacent samples onto the same
      // point, and the marker stands still and then jumps instead of gliding.
      // (It is the same precision cliff the base sidesteps by quantizing per
      // tile against each axis's own min/max.) One track, one point per frame:
      // float64 costs 8 bytes a keyframe and removes the failure mode.
      const [mx, my] = lngLatToMercator(
        f.positions[src * dims],
        f.positions[src * dims + 1],
      );
      keyTrack[k * 3] = mx;
      keyTrack[k * 3 + 1] = my;
      keyTrack[k * 3 + 2] = dims === 3 ? f.positions[src * dims + 2] : 0;
    }

    const reorder = (col: Float32Array | null): Float32Array | null => {
      if (!col) return null;
      const out = new Float32Array(count);
      for (let k = 0; k < count; k++) out[k] = col[orderArray[k]];
      return out;
    };

    cache.keyTimes = keyTimes;
    cache.keyEndTimes = keyEndTimes;
    cache.keyTrack = keyTrack;
    cache.keyIndex = keyIndex;
    cache.keyframeCount = count;
    cache.keyHeading = reorder(
      this.getNumericProperty(f, this.egoOpts.headingProperty),
    );
    cache.keyLength = reorder(
      this.getNumericProperty(f, this.egoOpts.lengthProperty),
    );
    cache.keyWidth = reorder(
      this.getNumericProperty(f, this.egoOpts.widthProperty),
    );
    cache.keyHeight = reorder(
      this.getNumericProperty(f, this.egoOpts.heightProperty),
    );

    if (this.shaderConfig.filter) {
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical) this.warnCategoricalFilterOnce();
      cache.hasFilterColumn = col.hasColumn;
      cache.keyFilter = reorder(col.values ?? null);
    } else {
      cache.keyFilter = null;
    }

    const lat = tileCenterLatitude(tile.id.z, tile.id.y);
    cache.metersToUnits = metersToMercatorUnits(1, lat);
    cache.mercatorZScale = mercatorZFromAltitude(1, lat);
    return cache;
  }

  // ── pose resolution ───────────────────────────────────────────────────────

  /**
   * Sample the track at tile-relative time `t`.
   *
   * Binary-search for the last keyframe at or before `t`, take its successor,
   * lerp. Outside the track the pose CLAMPS to the nearest end and is flagged
   * `clamped` — the marker stays put rather than snapping to the origin, and
   * its (now stale) time span is what the time-filter kernel fades out.
   */
  private samplePose(cache: EgoTileCache, t: number): EgoPose | null {
    const n = cache.keyframeCount;
    if (n <= 0) return null;
    const times = cache.keyTimes;
    let lo = lastAtOrBefore(times, n, t);
    let hi: number;
    let frac: number;
    let clamped = false;
    let held = false;
    if (lo < 0) {
      lo = 0;
      hi = 0;
      frac = 0;
      clamped = true;
    } else if (lo >= n - 1) {
      lo = n - 1;
      hi = n - 1;
      frac = 0;
      clamped = t > times[n - 1];
    } else {
      hi = lo + 1;
      const span = times[hi] - times[lo];
      // Two keyframes stamped at the same millisecond are a legal archive; a
      // zero denominator is not. Snap to the earlier one.
      frac = span > 0 ? (t - times[lo]) / span : 0;
      if (span > this.egoOpts.maxInterpolationGap) {
        // A hole this wide is missing DATA, not slow motion: hold the last real
        // sample and let it keep its OWN declared span, so the time filter ages
        // it out on the archive's terms instead of this layer inventing an
        // expiry for it.
        hi = lo;
        frac = 0;
        held = true;
      }
    }

    const p = cache.keyTrack;
    const x = p[lo * 3] + (p[hi * 3] - p[lo * 3]) * frac;
    const y = p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * frac;
    const z = p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * frac;

    const heading = this.resolveHeading(cache, lo, hi, frac);
    const o = this.egoOpts;
    const pick = (col: Float32Array | null, fallback: number): number => {
      if (!col) return fallback;
      const v = col[lo];
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };

    return {
      x,
      y,
      z,
      heading,
      // A vehicle does not change size between two keyframes, so the extent is
      // READ, not lerped — an interpolated width would only smear sensor noise.
      length: pick(cache.keyLength, o.length),
      width: pick(cache.keyWidth, o.width),
      height: pick(cache.keyHeight, o.height),
      startTime: times[lo],
      endTime: cache.keyEndTimes[hi],
      index: cache.keyIndex[lo],
      filterValue: cache.keyFilter ? cache.keyFilter[lo] : Number.NaN,
      clamped,
      held,
    };
  }

  /**
   * Heading in radians CCW from east.
   *
   * Preference order: the baked column (shortest-arc lerped between the
   * bracketing pair), then the direction of travel across the pair, then the
   * direction across the PREVIOUS pair when the pair is degenerate (the clamped
   * tail of a track, where `lo === hi`), then `0`. `Δnorth` is `-Δmercator.y`
   * because mercator `y` grows southward.
   */
  private resolveHeading(
    cache: EgoTileCache,
    lo: number,
    hi: number,
    frac: number,
  ): number {
    const col = cache.keyHeading;
    const scale = this.egoOpts.headingUnits === 'degrees' ? DEG_TO_RAD : 1;
    if (col) {
      const a = col[lo] * scale;
      const b = col[hi] * scale;
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return lerpHeadingShortestArc(a, b, frac) + this.egoOpts.headingOffset;
      }
      if (Number.isFinite(a)) return a + this.egoOpts.headingOffset;
    }
    const p = cache.keyTrack;
    let i = lo;
    let j = hi;
    if (i === j) {
      // Degenerate pair: reach back one keyframe so a clamped tail still points
      // the way the vehicle was last travelling.
      i = Math.max(0, lo - 1);
      j = lo;
    }
    if (i === j) return this.egoOpts.headingOffset;
    const dx = p[j * 3] - p[i * 3];
    const dy = p[j * 3 + 1] - p[i * 3 + 1];
    if (dx === 0 && dy === 0) return this.egoOpts.headingOffset;
    return Math.atan2(-dy, dx) + this.egoOpts.headingOffset;
  }

  /**
   * Pick the tile that owns the marker this frame and sample it.
   *
   * The ego track is ONE object, but it can be split across several resident
   * tiles (the vehicle crosses a tile seam; `best-available` fallback can also
   * hold a parent alongside its child). Whichever tile's keyframe span is
   * NEAREST the play-head wins — gap `0` means it contains it — and strict
   * `<` keeps the first such tile, so the choice is deterministic under the
   * base's stable iteration order. Every other tile draws nothing, which is
   * what makes "exactly one marker" true across tiles as well as across
   * keyframes.
   *
   * Cost: one binary search per resident tile, and an ego archive holds a
   * handful. `ensureTileGpuCache` is memoized, so this never rebuilds anything.
   */
  private resolveFrameTarget(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    currentTime: number,
  ): EgoFrameTarget | null {
    let best: EgoFrameTarget | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(
          gl,
          tile,
          layer,
        ) as EgoTileCache | null;
        if (!cache || !(cache.keyframeCount > 0)) continue;
        const t = currentTime - cache.timeOffset;
        const first = cache.keyTimes[0];
        const last = cache.keyTimes[cache.keyframeCount - 1];
        const gap = t < first ? first - t : t > last ? t - last : 0;
        if (gap >= bestGap) continue;
        const pose = this.samplePose(cache, t);
        if (!pose) continue;
        bestGap = gap;
        best = { tile, layer, cache, pose };
        if (gap === 0) return best; // contains the play-head: nothing can beat it
      }
    }
    return best;
  }

  // ── programs, mesh, uniforms ──────────────────────────────────────────────

  private ensureMesh(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (this.meshVertexBuffer) return;
    const mesh = buildEgoCuboidMesh();
    this.meshVertexBuffer = this.uploadArrayBuffer(gl, mesh.vertices);
    const index = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.meshIndexBuffer = index;
  }

  private resolveHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    pass: EgoPass,
    frame: HostFrame,
  ): EgoHandles {
    const variant = frame.shader.variantName;
    const cached = pass === 'body' ? this.bodyHandles : this.pickHandles;
    const cachedVariant = pass === 'body' ? this.bodyVariant : this.pickVariant;
    if (cached && cachedVariant === variant) return cached;
    const h = this.getOrCreateProgram(
      gl,
      this.programKeys[pass],
      frame,
      (g, s) => this.linkEgoProgram(g, s, pass),
    );
    if (pass === 'body') {
      this.bodyHandles = h;
      this.bodyVariant = variant;
    } else {
      this.pickHandles = h;
      this.pickVariant = variant;
    }
    return h;
  }

  private linkEgoProgram(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pass: EgoPass,
  ): EgoHandles {
    const cfg = this.shaderConfig;
    const vs =
      pass === 'body'
        ? buildEgoVertexSource(shader, cfg)
        : buildEgoIdVertexSource(shader, cfg);
    const program = this.linkProgram(
      gl,
      vs,
      pass === 'body' ? FS_SOURCE : ID_FS_SOURCE,
    );
    const u = (name: string) => gl.getUniformLocation(program, name);
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aUnit: gl.getAttribLocation(program, 'aUnit'),
      uMatrix: u('uMatrix'),
      uCenter: u('uCenter'),
      uTime: u('uTime'),
      uHeadingRot: u('uHeadingRot'),
      uSizeM: u('uSizeM'),
      uSizeScale: u('uSizeScale'),
      uElevationScale: u('uElevationScale'),
      uMetersToUnits: u('uMetersToUnits'),
      uMercatorZPerMeter: u('uMercatorZPerMeter'),
      uColor: u('uColor'),
      uFilterValue: u('uFilterValue'),
      uIdColor: pass === 'body' ? null : u('uIdColor'),
      ...resolveTimeUniformLocations(gl, program),
      // Resolved unconditionally: on a program with no filter branch every one
      // of these comes back `null`, which is precisely a no-op for `gl.uniform*`
      // — cheaper than a conditional shape the type system then has to widen.
      ...resolveDataFilterUniformLocations(gl, program),
    };
  }

  /**
   * METRES → mercator XY. `'meters'` converts at the tile's own centre latitude
   * (never the map centre — a metre is 1.4× more mercator at 45° than at the
   * equator). `'pixels'` inverts maplibre's `512 · 2^zoom` CSS-pixel world so
   * the box holds a constant screen footprint, and the caller's `length`/
   * `width`/`height` are then read as pixels rather than metres.
   */
  private resolveMetersToUnits(cache: EgoTileCache, ctx: DrawContext): number {
    return this.egoOpts.sizeUnits === 'pixels'
      ? 1 / (512 * Math.pow(2, ctx.zoom))
      : cache.metersToUnits;
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode only. Every time is
   * tile-relative: absolute minus the owning tile's `timeOffset`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: EgoHandles,
    cache: EgoTileCache,
    ctx: DrawContext,
  ): void {
    const o = this.egoOpts;
    const relativeNow = ctx.currentTime - cache.timeOffset;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, relativeNow);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, relativeNow);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, relativeNow);
        gl.uniform1f(h.uTrailLength, o.trailLength);
        gl.uniform1f(h.uFadeTrail, o.fadeTrail);
        break;
      default: {
        // The base builds `ctx.windowStart/End` against the tile it is
        // currently iterating; the marker may live on a DIFFERENT tile, so the
        // window is re-derived here against the OWNING tile's offset.
        const half = this.opts.timeWindow / 2;
        gl.uniform1f(h.uWindowStart, relativeNow - half);
        gl.uniform1f(h.uWindowEnd, relativeNow + half);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  /**
   * Everything the visual and id passes set IDENTICALLY, so the pickable box is
   * always the drawn box — same projection, same pose, same extent, same time
   * and filter gates.
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: EgoHandles,
    target: EgoFrameTarget,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    const o = this.egoOpts;
    const { cache, pose } = target;
    this.centerScratch[0] = pose.x;
    this.centerScratch[1] = pose.y;
    this.centerScratch[2] = pose.z;
    gl.uniform3fv(h.uCenter, this.centerScratch);
    gl.uniform2f(h.uTime, pose.startTime, pose.endTime);
    gl.uniform2f(h.uHeadingRot, Math.cos(pose.heading), Math.sin(pose.heading));
    // (width, length, height) — the cuboid's own (lateral, longitudinal, up).
    this.sizeScratch[0] = pose.width;
    this.sizeScratch[1] = pose.length;
    this.sizeScratch[2] = pose.height;
    gl.uniform3fv(h.uSizeM, this.sizeScratch);
    gl.uniform1f(h.uSizeScale, o.sizeScale);
    gl.uniform1f(h.uElevationScale, o.elevationScale);
    gl.uniform1f(h.uMetersToUnits, this.resolveMetersToUnits(cache, ctx));
    gl.uniform1f(h.uMercatorZPerMeter, cache.mercatorZScale);
    gl.uniform4fv(h.uColor, this.rgba01Uniform('EgoColor', o.color));
    this.setTimeUniforms(gl, h, cache, ctx);
    if (this.shaderConfig.filter) {
      // A tile with no such column renders UNFILTERED, never blank; the value
      // it would have supplied is irrelevant then, so `0` is a safe stand-in.
      gl.uniform1f(
        h.uFilterValue,
        Number.isFinite(pose.filterValue) ? pose.filterValue : 0,
      );
      this.uploadDataFilterUniforms(gl, h, cache.hasFilterColumn === true);
    }
  }

  /**
   * Bind the shared unit cuboid and issue the single `drawElements`.
   *
   * No VAO: there is exactly one attribute and one draw per frame, so a
   * recording would cost more state churn than it saves, and it would have to
   * be invalidated on every host-variant flip. The attribute is disabled again
   * afterwards so the default slate is clean for the basemap.
   */
  private drawCuboid(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: EgoHandles,
  ): void {
    const mesh = buildEgoCuboidMesh();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVertexBuffer!);
    gl.enableVertexAttribArray(h.aUnit);
    gl.vertexAttribPointer(h.aUnit, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndexBuffer!);
    gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(h.aUnit);
  }

  // ── draw ──────────────────────────────────────────────────────────────────

  /**
   * Draw the ego marker — at most ONCE per frame, from whichever tile owns the
   * play-head. Called by the base once per (tile, layer); every call but the
   * owner's returns immediately, which is why the instance count is 1 no matter
   * how many tiles or keyframes are resident.
   */
  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    _cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const target = this.resolveFrameTarget(gl, ctx.currentTime);
    if (!target) {
      this.lastPose = null;
      return;
    }
    if (target.tile !== tile || target.layer !== layer) return;
    this.lastPose = target.pose;

    const frame = ctx.frame ?? LEGACY_FRAME;
    this.ensureMesh(gl);
    const h = this.resolveHandles(gl, 'body', frame);
    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, target, ctx, frame);
    this.drawCuboid(gl, h);
  }

  /**
   * Draw the marker into the id-pick FBO, painted the flat colour of the LOWER
   * bracketing keyframe's id (`idBase + poseIndex`) — the source row a click
   * should resolve to, since that is the pose the interpolation started from.
   *
   * Same owner test, same uniforms and the same alpha gates as
   * {@link drawTile}: a marker that is time-filtered out, hard-filtered,
   * transparent or off the end of the log cannot be picked. Its id colour rides
   * as a UNIFORM (there is one instance, so a per-instance attribute would be a
   * one-element buffer allocated and freed per pick); the bytes are normalized
   * on the CPU and land back in an RGBA8 attachment exactly.
   *
   * Browser-verify-only for the FBO round-trip itself; the id build + decode
   * join is unit-tested in the base.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    _cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const target = this.resolveFrameTarget(gl, ctx.currentTime);
    if (!target || target.tile !== tile || target.layer !== layer) return;
    // The base sized this tile's id range from `featureCount`; painting an
    // index beyond it would decode into the NEXT tile's range.
    const index = target.pose.index;
    if (index < 0 || index >= layer.features.featureCount) return;

    const frame = ctx.frame ?? LEGACY_FRAME;
    this.ensureMesh(gl);
    const h = this.resolveHandles(gl, 'pick', frame);
    gl.useProgram(h.program);
    this.setSharedUniforms(gl, h, target, ctx, frame);
    const rgb = this.buildPickIdColors(1, idBase + index);
    this.idColorScratch[0] = rgb[0] / 255;
    this.idColorScratch[1] = rgb[1] / 255;
    this.idColorScratch[2] = rgb[2] / 255;
    gl.uniform3fv(h.uIdColor, this.idColorScratch);
    this.drawCuboid(gl, h);
  }
}
