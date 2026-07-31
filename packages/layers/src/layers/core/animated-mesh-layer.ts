// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedMeshLayer — recognizable 3D MODELS (cars / pedestrians / ships /
 * planes) that move smoothly over time. It is the MESH analog of
 * {@link AnimatedBoundingBoxLayer}'s oriented cuboids: instead of drawing each
 * tracked object as a phong-lit box, it instances an arbitrary glTF/OBJ mesh at
 * the object's interpolated pose.
 *
 * ── DATA: the AV `objects/` point archive, VERBATIM ──────────────────────────
 * Same tile shape as the bounding-box layer — one POINT feature per tracked
 * object PER KEYFRAME (`track_id`, `category`, `heading`, `length`/`width`/
 * `height`, `speed`, timestamped). The two layers are interchangeable over the
 * exact same archive; only the render primitive differs. The mesh geometry is
 * NOT a tile column — it is a STATIC per-layer prop ({@link _AnimatedMeshLayerProps.mesh},
 * the analog of IconLayer's `iconAtlas`), optionally a per-category map
 * ({@link _AnimatedMeshLayerProps.meshMapping}) so cars, pedestrians and cyclists
 * each get their own model.
 *
 * ── MOTION: the shared track kernel (no "train" of models) ────────────────────
 * Like the bounding-box layer, this pools every loaded tile's snapshots by
 * `track_id` (rebased to absolute epoch-ms so cross-tile keyframes join one
 * timeline) and, once per frame, emits ONE interpolated instance per ACTIVE
 * track — never one model per keyframe. All of that (pooling, binary-search +
 * lerp, shortest-arc heading interpolation, appear/disappear fade, GPU-id
 * picking rows) lives in {@link ../../lib/track-kernel.js} and is SHARED with
 * AnimatedBoundingBoxLayer — this file owns only the SimpleMeshLayer instance
 * bake. Motion rides a CPU instance buffer the base class never recomputes on a
 * bare time tick, so — like its sibling — we override `_handleTimeUpdate` to
 * force a renderLayers() pass per advanced tick.
 *
 * ── RENDER: SimpleMeshLayer (@deck.gl/mesh-layers) ───────────────────────────
 * Per-instance attributes, refreshed each frame from the interpolated samples
 * into GROW-ONLY buffers this layer owns (never reallocated per tick):
 *   • getPosition    → the interpolated point (lon/lat/alt).
 *   • getOrientation → [pitch, heading°+yaw, roll] — heading (a yaw about the
 *     vertical z axis) rides slot 1 of deck's [pitch, yaw, roll], plus the
 *     constant {@link _AnimatedMeshLayerProps.orientationOffset} so a model whose
 *     native forward axis isn't +x can be corrected once. A full 3-axis attitude
 *     instead rides {@link _AnimatedMeshLayerProps.quaternionColumn} — a baked
 *     `[qx,qy,qz,qw]` vector column, slerped between keyframes and converted to
 *     deck's euler convention (see {@link quatToDeckEuler}).
 *   • getScale       → [length, width, height] when {@link _AnimatedMeshLayerProps.scaleToDimensions}
 *     (default) — fits a unit-sized model to the object's bbox; else [1,1,1]
 *     (native model size). SimpleMeshLayer's own `sizeScale` multiplies on top.
 *   • getColor       → per-instance RGBA from `category` via `colorMapping`
 *     (× the CPU appear/disappear fade). With a `texture` set, the mesh's
 *     texture wins and this is ignored (deck SimpleMeshLayer semantics); default
 *     white keeps textured / vertex-colored models looking natural.
 * `getOrientation`/`getScale` reach the GPU as FUNCTION accessors, not binary
 * attributes: deck folds orientation/scale/translation into ONE computed
 * `instanceModelMatrix` whose `accessor` is an ARRAY, and the attribute manager
 * only consults `data.attributes[accessorName]` when the accessor is a STRING.
 * A true ZERO-COPY pose path would need a SimpleMeshLayer subclass that
 * registers `instanceModelMatrixCol0..2` itself (or supplies a prebuilt
 * `instanceModelMatrix` external buffer) — deliberately out of scope here.
 * Pass-throughs: `mesh`, `texture`, `textureParameters`, `sizeScale`,
 * `getTranslation` (constant anchor offset), `material`, `wireframe`,
 * `_instanced`, plus upstream's `getOrientation` / `getScale` /
 * `getTransformMatrix` when a caller wants to drive the pose itself. (deck
 * 9.3's SimpleMeshLayer exposes no `_lighting`/`_useMeshColors` props —
 * `material` is the lighting control here.)
 *
 * ── PER-CATEGORY MODELS ──────────────────────────────────────────────────────
 * With {@link _AnimatedMeshLayerProps.meshMapping} set, the active samples are
 * grouped by `category` and one SimpleMeshLayer is emitted per category (mesh is
 * a per-layer prop, so distinct models need distinct sublayers), each falling
 * back to `mesh` for categories absent from the map. Otherwise a single
 * SimpleMeshLayer draws every instance.
 *
 * Picking: `pickable` is INHERITED like any other deck layer (pass
 * `pickable: true` on the composite). On a hit, `info.index` maps into that
 * sublayer's active-track samples (stride 1) and {@link getPickingInfo} builds
 * — lazily, at event rate, never per frame — the flat decoded props
 * (`track_id`/`category`/`heading`/dims/`speed`), the same AV-inspector shape
 * the bounding-box layer emits.
 *
 * ── SIBLING: AnimatedScenegraphLayer ────────────────────────────────────────
 * deck splits flat-mesh and full-glTF-scenegraph rendering into two layers
 * (`SimpleMeshLayer` / `ScenegraphLayer`), and so does this catalog:
 * {@link ../core/animated-scenegraph-layer.js} subclasses THIS layer, inherits
 * every line of the pooling / interpolation / buffer / picking machinery, and
 * overrides only the four "engine seams" grouped together below
 * ({@link AnimatedMeshLayer.resolveAssets}, {@link AnimatedMeshLayer.missingAssetWarning},
 * {@link AnimatedMeshLayer.warnEngineCaveats}, {@link AnimatedMeshLayer.engineProps}
 * + its id/class pair). Anything engine-specific added below belongs in that
 * group, or the two layers drift.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`mesh`**.
 */

import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type {
  Color,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayerContext,
  Material,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
  SpatioTemporalPickingInfo,
} from '../spatiotemporal-layer.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  colorMappingDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type { ColorAccessorValue } from '../../lib/accessor-alias.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import { bindFloatVector } from '../../lib/vector-props.js';
import {
  sampleTrack as kernelSampleTrack,
  makePickRow,
  TrackIndexMaintainer,
  RAD_TO_DEG,
  SINGLETON_HOLD_MS,
} from '../../lib/track-kernel.js';
import type {
  Track,
  Sample,
  TrackPickRow,
  TrackFieldConfig,
} from '../../lib/track-kernel.js';
import { GeometryType } from '@poopdeck.gl/core';
import type { Tile, STTTileLayer as TileLayer } from '@poopdeck.gl/core';

const DEBUG = false;

/** Shared fallback color when a track's category is unmapped / colorProperty is
 * unset. White so textured / vertex-colored models render with their own look
 * (deck SimpleMeshLayer: `[255,255,255]` == "use the original mesh colors"). */
const DEFAULT_COLOR: Color = [255, 255, 255, 255];

/**
 * A mesh source SimpleMeshLayer accepts (glTF/OBJ URL, a parsed geometry /
 * attributes object, or a promise thereof). Kept structurally loose — deck's
 * internal `Mesh` union is not exported and we only forward the value.
 */
export type MeshSource = string | object | Promise<unknown> | null;

/**
 * A deck layer class this composite may instantiate as its render engine —
 * `SimpleMeshLayer` here, `ScenegraphLayer` in {@link AnimatedScenegraphLayer}.
 * Structural (rather than `typeof SimpleMeshLayer`) so a subclass can return a
 * different engine without widening every call site.
 */
export type EngineClass = new (props: any) => Layer;

/** Props added by {@link AnimatedMeshLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedMeshLayerProps}). */
export interface _AnimatedMeshLayerProps {
  /**
   * The STATIC 3D model instanced at every tracked object's pose — a glTF/OBJ
   * URL, a parsed mesh/geometry object, or a promise of one (SimpleMeshLayer's
   * `mesh` prop, forwarded verbatim). This is a per-LAYER prop, NOT a tile
   * column (the analog of IconLayer's `iconAtlas`). When {@link meshMapping} is
   * set it is the fallback for categories absent from the map. If both are
   * unset the layer renders nothing (and warns once).
   * @default null
   */
  mesh?: MeshSource;

  /**
   * Per-CATEGORY model map, keyed by the raw `colorProperty`/`getColor` category
   * string. When set, active objects are grouped by category and each group is
   * drawn by its own SimpleMeshLayer with `meshMapping[category]` (falling back
   * to {@link mesh}). Categories with neither a mapped model nor a `mesh`
   * fallback are skipped.
   * @default null
   */
  meshMapping?: Record<string, MeshSource> | null;

  /**
   * Texture applied to the mesh (SimpleMeshLayer `texture` pass-through — a URL,
   * a `TextureSource`, or a promise). When set, the texture wins over
   * `getColor`. @default null
   */
  texture?: unknown;

  /**
   * Texture sampler parameters (SimpleMeshLayer `textureParameters` pass-through).
   * @default null
   */
  textureParameters?: unknown;

  /**
   * Per-feature track-identity column NAME used to group an object's keyframe
   * snapshots into one interpolated model. When absent each snapshot becomes its
   * own (un-interpolated) instance, held for {@link SINGLETON_HOLD_MS}.
   * @default 'track_id'
   */
  trackIdProperty?: string;

  /**
   * Categorical property column NAME that drives each model's per-instance color
   * AND (with {@link meshMapping}) which model to draw — e.g. `'category'`.
   * Resolved on the CPU through {@link colorMapping}. When unset, models use the
   * constant {@link colorMappingDefault} and a single {@link mesh}.
   * @default null
   */
  colorProperty?: string | null;

  /**
   * Upstream-vocabulary alias reconciling deck's `getColor`. Accepts a constant
   * {@link Color} (a single color for every model, overriding
   * {@link colorProperty}) OR a property-column NAME (treated as
   * {@link colorProperty}) — NOT a function accessor (binary tiles can't run
   * per-feature JS; a function warns once and falls back). When set, it wins.
   * @default null
   */
  getColor?: ColorAccessorValue | null;

  /**
   * Category → color map, keyed by the raw category string. Categories absent
   * from the map fall back to {@link colorMappingDefault}.
   * @default null
   */
  colorMapping?: Record<string, Color> | null;

  /**
   * Color for categories not present in {@link colorMapping} (and the constant
   * color when {@link colorProperty}/`getColor` name no column). Default white so
   * textured models keep their own appearance.
   * @default [255, 255, 255, 255]
   */
  colorMappingDefault?: Color;

  /**
   * Per-feature yaw column NAME (radians, world frame, 0 = +x/east, CCW). Drives
   * the model's `getOrientation` yaw (slot 1 of deck's [pitch, yaw, roll]),
   * angle-interpolated between keyframes. Absent ⇒ models are axis-aligned.
   * @default 'heading'
   */
  headingProperty?: string;

  /**
   * Per-feature ATTITUDE quaternion column NAME — an interleaved
   * `FixedSizeList<Float32,4>` VECTOR column holding `[qx, qy, qz, qw]` (the
   * shape `BinaryFeatures.vectorProps` documents for exactly this case). When
   * set and the tile carries it, the full 3-axis attitude drives
   * `getOrientation`: the quaternion is slerped (shortest-arc) between the two
   * keyframes bracketing the playhead and converted to deck's euler
   * `[pitch, yaw, roll]` degrees, then {@link orientationOffset} is added. This
   * is what lets a drone / aircraft archive bank and pitch instead of rendering
   * permanently wings-level, which the scalar {@link headingProperty} (yaw
   * only) cannot express.
   *
   * Requires a resolvable {@link trackIdProperty} column — attitude keyframes
   * are pooled per track, exactly like positions. Falls back to the heading
   * path (with a one-time warning) when the column is missing, mis-sized, or
   * carries a u8 leaf. NOTE: opting in costs a second pooled index; it is
   * maintained incrementally across tile churn, like the track index.
   * @default null
   */
  quaternionColumn?: string | null;

  /**
   * Constant orientation offset `[pitch, yaw, roll]` in degrees, ADDED to the
   * interpolated heading (which rides the yaw slot) or to the
   * {@link quaternionColumn} attitude. Use it to correct a model whose native
   * forward axis is not +x, or to tilt/roll it.
   * @default [0, 0, 0]
   */
  orientationOffset?: [number, number, number];

  /**
   * Upstream SimpleMeshLayer `getOrientation` pass-through — a constant
   * `[pitch, yaw, roll]` (degrees) or a deck accessor function. When set it
   * REPLACES this layer's computed per-instance orientation (heading /
   * quaternion + offset) wholesale: the caller owns the pose. Superset-mandate
   * escape hatch; leave unset for the normal animated path.
   * @default null
   */
  getOrientation?:
    | [number, number, number]
    | ((d: unknown, info: { index: number }) => number[])
    | null;

  /**
   * Upstream SimpleMeshLayer `getScale` pass-through — a constant `[x, y, z]`
   * or a deck accessor function. When set it REPLACES the computed
   * {@link scaleToDimensions} scale.
   * @default null
   */
  getScale?:
    | [number, number, number]
    | ((d: unknown, info: { index: number }) => number[])
    | null;

  /**
   * Upstream SimpleMeshLayer `getTransformMatrix` pass-through — a constant
   * 16-element column-major matrix, or an accessor returning one. deck ignores
   * `getOrientation`/`getScale`/`getTranslation` entirely when this yields a
   * matrix, so it overrides the whole computed pose. CAVEAT: deck probes it
   * once as `getTransformMatrix(data[0])`, and `data` here is a BINARY
   * `{length, attributes}` object whose `[0]` is `undefined` — an accessor must
   * tolerate that probe call.
   * @default null
   */
  getTransformMatrix?:
    | number[]
    | ((d: unknown, info: { index: number }) => number[])
    | null;

  /**
   * Per-feature model-length column NAME (meters, model +x). Drives the model's
   * x-scale when {@link scaleToDimensions}. Absent ⇒ {@link defaultLength}.
   * @default 'length'
   */
  lengthProperty?: string;

  /**
   * Per-feature model-width column NAME (meters). Drives the y-scale when
   * {@link scaleToDimensions}. Absent ⇒ {@link defaultWidth}.
   * @default 'width'
   */
  widthProperty?: string;

  /**
   * Per-feature model-height column NAME (meters). Drives the z-scale when
   * {@link scaleToDimensions}. Absent ⇒ {@link defaultHeight}.
   * @default 'height'
   */
  heightProperty?: string;

  /**
   * When true (default), `getScale` = `[length, width, height]`, fitting a
   * unit-sized model to each object's bounding box. When false, `getScale` =
   * `[1, 1, 1]` and the model renders at its native size (scaled only by
   * {@link sizeScale}) — the right choice for a pre-sized car/ped model.
   * @default true
   */
  scaleToDimensions?: boolean;

  /**
   * Uniform SimpleMeshLayer size multiplier applied to the whole model on top of
   * `getScale`.
   * @default 1
   */
  sizeScale?: number;

  /**
   * Constant translation `[x, y, z]` (meters) from the anchor point
   * (SimpleMeshLayer `getTranslation` pass-through). Lift a model whose origin is
   * at its center by half its height, or leave `[0,0,0]` for base-anchored models.
   * @default [0, 0, 0]
   */
  getTranslation?: [number, number, number];

  /**
   * Constant model length (meters) used when {@link lengthProperty} names no
   * column and {@link scaleToDimensions} is on.
   * @default 4
   */
  defaultLength?: number;

  /**
   * Constant model width (meters) used when {@link widthProperty} names no column.
   * @default 2
   */
  defaultWidth?: number;

  /**
   * Constant model height (meters) used when {@link heightProperty} names no
   * column.
   * @default 1.6
   */
  defaultHeight?: number;

  /**
   * Lighting material for the models — SimpleMeshLayer pass-through. `true` for
   * the default phong material, `false` to disable lighting, or a material spec.
   * @default true
   */
  material?: Material;

  /**
   * Draw the models in wireframe mode — SimpleMeshLayer pass-through.
   * @default false
   */
  wireframe?: boolean;

  /**
   * SimpleMeshLayer `_instanced` pass-through. `true` (default) instances one
   * shared mesh at every object; `false` treats mesh positions as lng/lat deltas
   * of a single anchor (rarely wanted here).
   * @default true
   */
  _instanced?: boolean;

  /**
   * Appear-fade duration (ms of playhead time) just after a track starts — a CPU
   * alpha ramp folded into `getColor`. `0` pops in. NOTE: when a {@link texture}
   * is set, deck's SimpleMeshLayer ignores `getColor`, so the fade has NO effect
   * (textured models pop in) and the layer warns once — use an untextured /
   * vertex-colored mesh for fades.
   * @default 200
   */
  fadeInDuration?: number;

  /**
   * Disappear-fade duration (ms of playhead time) just before a track ends — a
   * CPU alpha ramp folded into `getColor`. `0` pops out. NOTE: has no effect with
   * a {@link texture} set (see {@link fadeInDuration}).
   * @default 200
   */
  fadeOutDuration?: number;

  /**
   * Per-feature speed column NAME (m/s). Carried through to picking rows so the
   * AV inspector can read it; not otherwise rendered.
   * @default 'speed'
   */
  speedProperty?: string;

  /**
   * Categorical/numeric column NAME whose value is carried through to picking
   * rows / per-track grouping label.
   * @default 'category'
   */
  labelProperty?: string;
}

/** Complete props accepted by {@link AnimatedMeshLayer}. */
export type AnimatedMeshLayerProps = _AnimatedMeshLayerProps &
  SpatioTemporalLayerProps;

/** Flat decoded props attached to `info.object` on a pick (AV inspector shape). */
type PickRow = TrackPickRow;

/** Deck's euler triple `[pitch, yaw, roll]` in DEGREES. */
type Euler = [number, number, number];

/** The lone sublayer key used when no `meshMapping` splits by category. */
const SINGLE_SUBLAYER_KEYS: ReadonlySet<string> = new Set(['all']);

// ---------------------------------------------------------------------------
// Per-sublayer instance buffers
// ---------------------------------------------------------------------------

/**
 * Grow-only per-sublayer instance buffers plus the STABLE pose accessors bound
 * to them.
 *
 * Everything here is held across frames and rewritten in place: a 300-object AV
 * scene at 60fps used to burn ~54k short-lived allocations/sec (4 typed arrays
 * + `new Array(n)` of pick rows per frame, plus a fresh 3-element array per
 * instance inside deck's `MATRIX_ATTRIBUTES.update` loop). The typed arrays are
 * handed to deck as `subarray(0, n × stride)` VIEWS — deck copies them into the
 * GPU buffer during the same update pass, so rewriting them next frame is safe
 * (the same pattern AnimatedPointLayer's glide path uses).
 *
 * `getOrientation` / `getScale` are created ONCE per sublayer and read
 * `buf.orientations` / `buf.scales` through the object, so growing swaps the
 * arrays without invalidating the closures. Because they are stable, deck
 * cannot infer a pose change from `data` identity — `revision` must feed
 * explicit `updateTriggers` instead.
 */
interface MeshInstanceBuffers {
  positions: Float64Array;
  orientations: Float32Array;
  scales: Float32Array;
  colors: Uint8Array;
  /** Capacity in INSTANCES (each buffer is capacity × its own stride). */
  capacity: number;
  /** Bumped on every rewrite; the `updateTriggers` value for the pose accessors. */
  revision: number;
  /**
   * Separate return arrays for the two accessors. deck calls `getOrientation`
   * AND `getScale` back-to-back and only then feeds both to
   * `calculateTransformMatrix`, so a single shared scratch array — including
   * deck's own reusable `objectInfo.target` — would let the scale write clobber
   * the orientation it just read.
   */
  oriOut: Euler;
  sclOut: [number, number, number];
  getOrientation: (d: unknown, info: { index: number }) => Euler;
  getScale: (d: unknown, info: { index: number }) => [number, number, number];
}

function makeMeshBuffers(capacity: number): MeshInstanceBuffers {
  const buf = {
    positions: new Float64Array(capacity * 3),
    orientations: new Float32Array(capacity * 3),
    scales: new Float32Array(capacity * 3),
    colors: new Uint8Array(capacity * 4),
    capacity,
    revision: 0,
    oriOut: [0, 0, 0] as Euler,
    sclOut: [1, 1, 1] as [number, number, number],
  } as MeshInstanceBuffers;
  buf.getOrientation = (_: unknown, info: { index: number }): Euler => {
    const o = info.index * 3;
    const t = buf.oriOut;
    t[0] = buf.orientations[o];
    t[1] = buf.orientations[o + 1];
    t[2] = buf.orientations[o + 2];
    return t;
  };
  buf.getScale = (
    _: unknown,
    info: { index: number },
  ): [number, number, number] => {
    const o = info.index * 3;
    const t = buf.sclOut;
    t[0] = buf.scales[o];
    t[1] = buf.scales[o + 1];
    t[2] = buf.scales[o + 2];
    return t;
  };
  return buf;
}

/** Grow in place (same object ⇒ the bound accessors stay valid). */
function growMeshBuffers(buf: MeshInstanceBuffers, capacity: number): void {
  buf.positions = new Float64Array(capacity * 3);
  buf.orientations = new Float32Array(capacity * 3);
  buf.scales = new Float32Array(capacity * 3);
  buf.colors = new Uint8Array(capacity * 4);
  buf.capacity = capacity;
}

// ---------------------------------------------------------------------------
// Attitude quaternions
// ---------------------------------------------------------------------------

/**
 * Convert a `[qx,qy,qz,qw]` attitude quaternion into deck's euler triple, in
 * DEGREES.
 *
 * deck's `MATRIX_ATTRIBUTES` composes `R = Rz(yaw)·Ry(pitch)·Rx(roll)`
 * (`@deck.gl/mesh-layers/src/utils/matrix.ts` — verified against the installed
 * 9.3.2 source), i.e. intrinsic Z-Y'-X'' with yaw about +z, pitch about +y and
 * roll about +x. Extracting that convention from the quaternion's rotation
 * matrix gives `pitch = asin(-R20)`, `yaw = atan2(R10, R00)`,
 * `roll = atan2(R21, R22)`, with the usual gimbal-lock fallback folding roll
 * into yaw when `cos(pitch) ≈ 0`.
 */
function quatToDeckEuler(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: Euler,
): void {
  const n = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  const w = qw / n;

  // R20 = 2(xz - yw) = -sin(pitch)
  const sp = Math.min(1, Math.max(-1, -2 * (x * z - y * w)));
  const pitch = Math.asin(sp);
  const cp = Math.sqrt(1 - sp * sp);

  let yaw: number;
  let roll: number;
  if (cp < 1e-6) {
    // Gimbal lock (nose straight up/down): yaw and roll are the same DOF.
    roll = 0;
    yaw = Math.atan2(-2 * (x * y - z * w), 1 - 2 * (x * x + z * z));
  } else {
    yaw = Math.atan2(2 * (x * y + z * w), 1 - 2 * (y * y + z * z));
    roll = Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + y * y));
  }
  out[0] = pitch * RAD_TO_DEG;
  out[1] = yaw * RAD_TO_DEG;
  out[2] = roll * RAD_TO_DEG;
}

/** One track's quaternion keyframes pooled from ONE (tile, layer), in feature order. */
interface TileQuatGroup {
  times: number[];
  /** Flat `[qx,qy,qz,qw]` per keyframe. */
  quats: number[];
}

/** Merged, time-sorted attitude keyframes for one track. */
interface QuatTrack {
  times: Float64Array;
  quats: Float32Array;
}

/**
 * Incrementally-maintained per-track attitude index, mirroring
 * {@link TrackIndexMaintainer}'s absorb/evict shape so opting into
 * {@link _AnimatedMeshLayerProps.quaternionColumn} does NOT reintroduce the
 * O(all resident snapshots) rebuild-per-tile-change that the track index just
 * shed: only ADDED (tile, layer)s are pooled, only REMOVED ones dropped, and
 * only the tracks those touched are re-merged + re-sorted.
 */
class QuatIndex {
  /** Absorbed (tile, layer) pools, keyed exactly like the track maintainer. */
  private pools = new Map<string, Map<string, TileQuatGroup>>();
  /** Inverse index so a dirty track re-merges without walking every pool. */
  private byTrack = new Map<string, Map<string, TileQuatGroup>>();
  /** Merged, sorted keyframes per track — what {@link sample} reads. */
  private merged = new Map<string, QuatTrack>();
  /** True once a tile was seen whose quaternion column was unusable. */
  missingColumn = false;

  reset(): void {
    this.pools.clear();
    this.byTrack.clear();
    this.merged.clear();
    this.missingColumn = false;
  }

  /** Diff `tiles` against the absorbed set and re-merge only affected tracks. */
  sync(tiles: Tile[], column: string, trackIdProp: string): void {
    const incoming = new Set<string>();
    const orderedKeys: string[] = [];
    const dirty = new Set<string>();

    for (const tile of tiles) {
      const { z, x, y, t } = tile.id;
      for (const tileLayer of tile.layers) {
        if (tileLayer.features.featureCount === 0) continue;
        const key = `${z}/${x}/${y}/${t}:${tileLayer.name}`;
        if (incoming.has(key)) continue;
        incoming.add(key);
        orderedKeys.push(key);
        if (this.pools.has(key)) continue;

        const pool = poolQuats(tileLayer, column, trackIdProp);
        if (!pool) this.missingColumn = true;
        const groups = pool ?? new Map<string, TileQuatGroup>();
        this.pools.set(key, groups);
        for (const [trackId, group] of groups) {
          let byKey = this.byTrack.get(trackId);
          if (!byKey) {
            byKey = new Map();
            this.byTrack.set(trackId, byKey);
          }
          byKey.set(key, group);
          dirty.add(trackId);
        }
      }
    }

    for (const [key, groups] of this.pools) {
      if (incoming.has(key)) continue;
      for (const trackId of groups.keys()) {
        this.byTrack.get(trackId)?.delete(key);
        dirty.add(trackId);
      }
      this.pools.delete(key);
    }

    for (const trackId of dirty) {
      const byKey = this.byTrack.get(trackId);
      if (!byKey || byKey.size === 0) {
        this.byTrack.delete(trackId);
        this.merged.delete(trackId);
        continue;
      }
      // Reassemble in current tile-array order, then sort — the same
      // deterministic pre-sort ordering a from-scratch build would produce.
      const times: number[] = [];
      const quats: number[] = [];
      for (const key of orderedKeys) {
        const g = byKey.get(key);
        if (!g) continue;
        for (let i = 0; i < g.times.length; i++) {
          times.push(g.times[i]);
          const o = i * 4;
          quats.push(
            g.quats[o],
            g.quats[o + 1],
            g.quats[o + 2],
            g.quats[o + 3],
          );
        }
      }
      const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
      const outT = new Float64Array(order.length);
      const outQ = new Float32Array(order.length * 4);
      for (let w = 0; w < order.length; w++) {
        const r = order[w];
        outT[w] = times[r];
        outQ[w * 4] = quats[r * 4];
        outQ[w * 4 + 1] = quats[r * 4 + 1];
        outQ[w * 4 + 2] = quats[r * 4 + 2];
        outQ[w * 4 + 3] = quats[r * 4 + 3];
      }
      this.merged.set(trackId, { times: outT, quats: outQ });
    }
  }

  /**
   * Slerp this track's attitude at absolute `now` into `out` as deck euler
   * degrees. Returns false when the track carries no attitude keyframes (the
   * caller then falls back to the scalar heading).
   */
  sample(trackId: string, now: number, out: Euler): boolean {
    const track = this.merged.get(trackId);
    if (!track || track.times.length === 0) return false;
    const { times, quats } = track;
    const n = times.length;

    if (n === 1 || now <= times[0]) {
      quatToDeckEuler(quats[0], quats[1], quats[2], quats[3], out);
      return true;
    }
    if (now >= times[n - 1]) {
      const o = (n - 1) * 4;
      quatToDeckEuler(quats[o], quats[o + 1], quats[o + 2], quats[o + 3], out);
      return true;
    }

    // Binary search for the last keyframe at or before `now`.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= now) lo = mid;
      else hi = mid;
    }
    const dt = times[hi] - times[lo];
    const t = dt > 0 ? (now - times[lo]) / dt : 0;
    slerpInto(quats, lo * 4, hi * 4, t, out);
    return true;
  }
}

/** Shortest-arc slerp of two quaternions in one flat buffer → deck euler degrees. */
function slerpInto(
  q: Float32Array,
  ia: number,
  ib: number,
  t: number,
  out: Euler,
): void {
  const ax = q[ia];
  const ay = q[ia + 1];
  const az = q[ia + 2];
  const aw = q[ia + 3];
  let bx = q[ib];
  let by = q[ib + 1];
  let bz = q[ib + 2];
  let bw = q[ib + 3];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  // q and -q are the same rotation; flip so we take the short way round.
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  let s0: number;
  let s1: number;
  if (dot > 0.9995) {
    // Nearly parallel — lerp (normalized in quatToDeckEuler) to dodge 0/0.
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }
  quatToDeckEuler(
    s0 * ax + s1 * bx,
    s0 * ay + s1 * by,
    s0 * az + s1 * bz,
    s0 * aw + s1 * bw,
    out,
  );
}

/**
 * Pool ONE (tile, layer)'s attitude keyframes by track id. Returns null when
 * the tile cannot feed the attitude path at all (no usable quaternion column,
 * or no track-id column to group by), so the caller can warn once and fall
 * back to the scalar heading.
 */
function poolQuats(
  tileLayer: TileLayer,
  column: string,
  trackIdProp: string,
): Map<string, TileQuatGroup> | null {
  const binary = tileLayer.features;
  // The leaf type is load-bearing: a u8 leaf against float quaternion
  // components is a format mismatch, not a rescale (bindFloatVector warns).
  const bound = bindFloatVector(
    binary.vectorProps?.[column],
    4,
    'AnimatedMeshLayer',
    column,
  );
  const trackCol = binary.categoricalProps[trackIdProp];
  if (!bound || !trackCol) return null;

  const q = bound.value as Float32Array;
  const offset = binary.timeOffset;
  const starts = binary.startTimes;
  const groups = new Map<string, TileQuatGroup>();
  for (let i = 0; i < binary.featureCount; i++) {
    const idx = trackCol.indices[i];
    if (idx === 0xffff) continue; // NULL id ⇒ un-poolable, held singleton
    const trackId = trackCol.categories[idx];
    if (trackId === undefined) continue;
    let g = groups.get(trackId);
    if (!g) {
      g = { times: [], quats: [] };
      groups.set(trackId, g);
    }
    g.times.push(starts[i] + offset); // → absolute epoch-ms, like the kernel
    const o = i * 4;
    g.quats.push(q[o], q[o + 1], q[o + 2], q[o + 3]);
  }
  return groups;
}

/**
 * Animated mesh layer — ONE CPU-interpolated 3D model per tracked object. See
 * the file header for the pool-by-track + per-frame-interpolate model (shared
 * with {@link AnimatedBoundingBoxLayer} via the track kernel).
 *
 * Sublayer short id for `_subLayerProps` overrides / `getSubLayerClass`:
 * **`mesh`**.
 */
export class AnimatedMeshLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_AnimatedMeshLayerProps>> {
  static layerName = 'AnimatedMeshLayer';

  static defaultProps: DefaultProps<AnimatedMeshLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    // Permissive descriptors ({type:'object'}) hold a mesh source / map / Color /
    // column name / null — which deck's typed validators would reject.
    mesh: { type: 'object', value: null, optional: true, compare: true },
    meshMapping: { type: 'object', value: null, optional: true, compare: true },
    texture: { type: 'object', value: null, optional: true, compare: true },
    textureParameters: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    trackIdProperty: 'track_id',
    colorProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getColor: { type: 'object', value: null, optional: true, compare: true },
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    colorMappingDefault: { type: 'color', value: DEFAULT_COLOR },
    headingProperty: 'heading',
    quaternionColumn: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    orientationOffset: { type: 'object', value: [0, 0, 0], compare: true },
    // Upstream pose accessors — unset by default so the layer's own
    // interpolated pose drives the models. Permissive descriptors: each holds a
    // constant array, an accessor function, or null.
    getOrientation: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getScale: { type: 'object', value: null, optional: true, compare: true },
    getTransformMatrix: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    lengthProperty: 'length',
    widthProperty: 'width',
    heightProperty: 'height',
    scaleToDimensions: true,
    sizeScale: { type: 'number', value: 1, min: 0 },
    getTranslation: { type: 'object', value: [0, 0, 0], compare: true },
    defaultLength: { type: 'number', value: 4, min: 0 },
    defaultWidth: { type: 'number', value: 2, min: 0 },
    defaultHeight: { type: 'number', value: 1.6, min: 0 },
    // Boolean or material spec — same permissive descriptor SimpleMeshLayer uses.
    material: { type: 'object', value: true, compare: true },
    wireframe: false,
    _instanced: true,
    fadeInDuration: { type: 'number', value: 200, min: 0 },
    fadeOutDuration: { type: 'number', value: 200, min: 0 },
    speedProperty: 'speed',
    labelProperty: 'category',
  };

  /** Pooled, track-grouped keyframe index. Refreshed only when the tile set or
   * a feeding style prop changes; re-interpolated (not rebuilt) every frame. */
  private trackIndex: Map<string, Track> | null = null;
  private trackIndexKey = '';
  private lastTilesRef: Tile[] | null = null;
  /**
   * Incremental maintainer behind {@link trackIndex}: re-pools only ADDED tiles
   * and re-sorts only AFFECTED tracks across tile churn, instead of the
   * O(all resident snapshots) full rebuild that spiked frame time on every
   * tile-set change (playback refreshes up to 10×/s). Same swap
   * AnimatedPointLayer / AnimatedIconLayer made for their glide indices.
   * Lazily created (the test harness bypasses field initializers).
   */
  private trackMaintainer: TrackIndexMaintainer | null = null;
  /** Per-track attitude keyframes — only when `quaternionColumn` is set. */
  private quatIndex: QuatIndex | null = null;
  /** Grow-only instance buffers, keyed by sublayer instance key. Lazily created
   * (the test harness bypasses field initializers via Object.create). */
  private meshBuffers: Map<string, MeshInstanceBuffers> | null = null;
  /** Memoized geometry-kind filter: source tiles ref → accepted tiles. */
  private lastGeomSrc: Tile[] | null = null;
  private lastGeomOut: Tile[] | null = null;
  /** Sim-time of the last mesh-pose re-interpolation; skips redundant ticks. */
  private lastMeshFrameTime = NaN;

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.trackIndex = null;
    this.trackMaintainer?.reset();
    this.quatIndex?.reset();
    this.meshBuffers?.clear();
    this.lastGeomSrc = null;
    this.lastGeomOut = null;
    this.lastTilesRef = null;
  }

  /**
   * Force a renderLayers() pass every advanced tick so the CPU-interpolated
   * model pose advances (mirrors AnimatedBoundingBoxLayer — the motion lives in
   * an instance buffer the base class would not otherwise recompute).
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const { tiles } = this.state;
    if (tiles && tiles.length > 0 && time !== this.lastMeshFrameTime) {
      this.lastMeshFrameTime = time;
      this.setState({ meshFrame: ((this.state as any).meshFrame || 0) + 1 });
    }
  }

  /**
   * Resolve the color source (accessor-alias B1): a constant `getColor` Color
   * overrides `colorProperty` (single color for all); a string `getColor` is
   * treated as a column name; a function warns once and falls back. Returns the
   * effective `colorProperty` (column, '' when a constant is in force) and the
   * constant fallback color.
   */
  private resolveColorConfig(): {
    colorProperty: string;
    colorMappingDefault: Color;
  } {
    let colorProperty =
      typeof this.props.colorProperty === 'string'
        ? this.props.colorProperty
        : '';
    let colorMappingDefault = (this.props.colorMappingDefault ??
      DEFAULT_COLOR) as Color;

    const alias = resolveAccessorAlias<Color | string | null>(
      'AnimatedMeshLayer',
      'getColor',
      this.props.getColor,
      null,
    );
    if (typeof alias === 'string') {
      colorProperty = alias; // a column name
    } else if (Array.isArray(alias)) {
      // A constant color for every model — overrides per-category coloring.
      colorProperty = '';
      colorMappingDefault = alias as Color;
    }
    return { colorProperty, colorMappingDefault };
  }

  /**
   * Resolve which tile columns the shared track kernel reads, from this layer's
   * props (defaults applied here so the kernel receives a fully-resolved config).
   */
  private trackFieldConfig(): TrackFieldConfig {
    const { colorProperty, colorMappingDefault } = this.resolveColorConfig();
    return {
      trackIdProperty: this.props.trackIdProperty || 'track_id',
      colorProperty,
      labelProperty: this.props.labelProperty || 'category',
      headingProperty: this.props.headingProperty || 'heading',
      lengthProperty: this.props.lengthProperty || 'length',
      widthProperty: this.props.widthProperty || 'width',
      heightProperty: this.props.heightProperty || 'height',
      speedProperty: this.props.speedProperty || 'speed',
      colorMapping: this.props.colorMapping,
      colorMappingDefault,
    };
  }

  /**
   * Digest of the props that change the POOLED index content (which columns are
   * read, plus the baked per-track color). Geometric props / sizeScale re-apply
   * every frame, so they are NOT in this key.
   */
  private computeIndexKey(): string {
    const { colorProperty, colorMappingDefault } = this.resolveColorConfig();
    return [
      this.props.trackIdProperty,
      colorProperty,
      this.props.headingProperty,
      this.quaternionColumnValue(),
      this.props.lengthProperty,
      this.props.widthProperty,
      this.props.heightProperty,
      this.props.speedProperty,
      this.props.labelProperty,
      Array.isArray(colorMappingDefault) ? colorMappingDefault.join(',') : '',
      colorProperty ? colorMappingDigest(this.props.colorMapping ?? {}) : 0,
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  /** The attitude-quaternion column NAME, or '' when the path is off. */
  private quaternionColumnValue(): string {
    return typeof this.props.quaternionColumn === 'string'
      ? this.props.quaternionColumn
      : '';
  }

  /**
   * Bring the pooled index up to date with `tiles`. A feeding-prop change
   * (indexKey) resets the maintainer for a from-scratch re-pool; otherwise the
   * {@link TrackIndexMaintainer} pools only ADDED (tile, layer)s, drops only
   * REMOVED ones and re-sorts only the tracks those touched — the whole point
   * being that playback's up-to-10×/s tile-set refresh must never re-pool every
   * resident snapshot synchronously. The attitude index (opt-in) is maintained
   * with the same absorb/evict discipline.
   */
  private syncTrackIndex(tiles: Tile[], indexKey: string): void {
    const t0 = performance.now();
    if (!this.trackMaintainer)
      this.trackMaintainer = new TrackIndexMaintainer();
    const quatColumn = this.quaternionColumnValue();
    if (this.trackIndexKey !== indexKey) {
      this.trackMaintainer.reset();
      this.quatIndex?.reset();
    }

    const cfg = this.trackFieldConfig();
    const result = this.trackMaintainer.sync(tiles, cfg);
    this.trackIndex = result.tracks;

    if (result.trackIdMissing) {
      warnOnce(
        'AnimatedMeshLayer:noTrackId',
        `[AnimatedMeshLayer] no \`${cfg.trackIdProperty}\` column — object ` +
          `snapshots cannot be grouped into tracks, so each is shown as a held ` +
          `model (${SINGLETON_HOLD_MS}ms) with no interpolation. Build the ` +
          `objects archive with a track-id column for smooth single-model rendering.`,
      );
    }

    if (quatColumn) {
      if (!this.quatIndex) this.quatIndex = new QuatIndex();
      this.quatIndex.sync(tiles, quatColumn, cfg.trackIdProperty);
      if (this.quatIndex.missingColumn) {
        warnOnce(
          'AnimatedMeshLayer:noQuaternion',
          `[AnimatedMeshLayer] quaternionColumn "${quatColumn}" is not a usable ` +
            `FixedSizeList<f32,4> vector column on some loaded tiles (or those ` +
            `tiles carry no \`${cfg.trackIdProperty}\` column to pool it by). ` +
            `Those objects fall back to the scalar \`${cfg.headingProperty}\` ` +
            `heading — yaw only, so pitch/roll stay at orientationOffset.`,
        );
      }
    } else {
      this.quatIndex = null;
    }

    this.trackIndexKey = indexKey;
    this.lastTilesRef = tiles;

    emit('tilePrepare', {
      layer: 'AnimatedMeshLayer',
      tracks: result.tracks.size,
      snapshots: result.totalSnapshots,
      resorted: this.trackMaintainer.resortedTrackIds.length,
      ms: performance.now() - t0,
    });
  }

  /**
   * Keep only the tile layers this renderer can actually read. The pooling pass
   * indexes `positions` by FEATURE index, so a linestring/polygon layer would
   * silently place every model on the first few paths' leading vertices. The
   * all-Point case (effectively always) returns the SAME array reference, so
   * the tile-identity short-circuits downstream stay intact.
   */
  private resolvePointTiles(tiles: Tile[]): Tile[] {
    if (this.lastGeomSrc === tiles) return this.lastGeomOut!;
    const accepts = (tileLayer: TileLayer): boolean =>
      expectGeometry(
        tileLayer.features.geometryType,
        [GeometryType.Point],
        'AnimatedMeshLayer',
        tileLayer.name,
      );
    let ok = true;
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        if (!accepts(tileLayer)) ok = false;
      }
    }
    const out = ok
      ? tiles
      : tiles
          .map((tile) => ({ ...tile, layers: tile.layers.filter(accepts) }))
          .filter((tile) => tile.layers.length > 0);
    this.lastGeomSrc = tiles;
    this.lastGeomOut = out;
    return out;
  }

  // -------------------------------------------------------------------------
  // Engine seams — the four places the render engine (deck's SimpleMeshLayer
  // here, ScenegraphLayer in AnimatedScenegraphLayer) shows through. Everything
  // else in this class — pooling, interpolation, the instance buffers, picking —
  // is engine-agnostic and is inherited verbatim. Keep this the WHOLE surface: a
  // fifth engine-specific branch anywhere below is a seam that belongs here.
  // -------------------------------------------------------------------------

  /**
   * The STATIC asset source + per-category map this engine instances. Split out
   * so {@link AnimatedScenegraphLayer} can read its own `scenegraph` /
   * `scenegraphMapping` props first and still fall back to `mesh` /
   * `meshMapping`, which is what makes one dataset config drive either engine.
   */
  protected resolveAssets(): {
    asset: MeshSource;
    mapping: Record<string, MeshSource> | null;
  } {
    return {
      asset: (this.props.mesh ?? null) as MeshSource,
      mapping: this.props.meshMapping ?? null,
    };
  }

  /** `warnOnce` key + message when neither an asset nor a mapping is set. */
  protected missingAssetWarning(): [string, string] {
    return [
      'AnimatedMeshLayer:noMesh',
      '[AnimatedMeshLayer] no `mesh` (and no `meshMapping`) — nothing to ' +
        'render. Provide a glTF/OBJ model via the `mesh` prop (a static ' +
        "per-layer prop, like IconLayer's iconAtlas).",
    ];
  }

  /** One-time warnings for props this engine silently ignores. */
  protected warnEngineCaveats(): void {
    // Finding: a `texture` makes deck's SimpleMeshLayer ignore getColor entirely
    // (texture wins), so the per-instance appear/disappear fade folded into
    // getColor's alpha has NO effect — textured models pop in/out regardless of
    // fadeInDuration/fadeOutDuration. Warn once instead of silently dropping it.
    // (ScenegraphLayer MULTIPLIES getColor into the material instead, so its
    // override drops this warning rather than inheriting it.)
    if (
      this.props.texture &&
      ((this.props.fadeInDuration ?? 0) > 0 ||
        (this.props.fadeOutDuration ?? 0) > 0)
    ) {
      warnOnce(
        'AnimatedMeshLayer:textureFade',
        '[AnimatedMeshLayer] `texture` is set, so SimpleMeshLayer ignores ' +
          '`getColor` — the per-instance fadeInDuration/fadeOutDuration alpha has ' +
          'no effect and textured models pop in/out. Use an untextured / ' +
          'vertex-colored mesh (fade rides getColor) for appear/disappear fades.',
      );
    }
  }

  /**
   * The `_subLayerProps` / `getSubLayerClass` short id, the default engine
   * class, and the engine-specific props carrying `asset`. The pose, color,
   * `sizeScale`, `getTranslation`, extensions and picking rows are added by
   * {@link buildMeshSublayer} around this and are NOT repeated here.
   */
  protected engineSubLayerId(): string {
    return 'mesh';
  }

  protected engineClass(): EngineClass {
    return SimpleMeshLayer as unknown as EngineClass;
  }

  protected engineProps(asset: MeshSource): Record<string, unknown> {
    return {
      mesh: asset,
      // texture / textureParameters ride through only when set (SimpleMeshLayer
      // defaults are undefined; passing null is harmless but keep it explicit).
      texture: this.props.texture ?? undefined,
      textureParameters: this.props.textureParameters ?? undefined,
      material: this.props.material,
      wireframe: this.props.wireframe,
      _instanced: this.props._instanced,
    };
  }

  /**
   * Interpolate one track's pose at absolute `now` via the shared
   * {@link kernelSampleTrack}, feeding this layer's geometric defaults + fades.
   */
  private sampleTrack(track: Track, now: number): Sample | null {
    return kernelSampleTrack(track, now, {
      defaultLength: this.props.defaultLength ?? 4,
      defaultWidth: this.props.defaultWidth ?? 2,
      defaultHeight: this.props.defaultHeight ?? 1.6,
      fadeInDuration: this.props.fadeInDuration ?? 0,
      fadeOutDuration: this.props.fadeOutDuration ?? 0,
    });
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles: rawTiles } = this.state;
    if (!rawTiles || rawTiles.length === 0) {
      this.trackIndex = null;
      this.trackMaintainer?.reset();
      this.quatIndex?.reset();
      this.meshBuffers?.clear();
      this.lastGeomSrc = null;
      this.lastGeomOut = null;
      this.lastTilesRef = null;
      return [];
    }
    const tiles = this.resolvePointTiles(rawTiles);
    if (tiles.length === 0) return [];

    const { asset: baseMesh, mapping: meshMapping } = this.resolveAssets();
    if (!baseMesh && !meshMapping) {
      const [key, message] = this.missingAssetWarning();
      warnOnce(key, message);
      return [];
    }

    this.warnEngineCaveats();

    // Re-sync the pooled index only when the visible tile SET changes or a
    // feeding style prop changes; otherwise re-interpolate the cached index.
    const indexKey = this.computeIndexKey();
    if (
      this.lastTilesRef !== tiles ||
      this.trackIndexKey !== indexKey ||
      !this.trackIndex
    ) {
      this.syncTrackIndex(tiles, indexKey);
    }

    const index = this.trackIndex!;
    const now = this.getCurrentTime();
    const samples: Sample[] = [];
    for (const track of index.values()) {
      const s = this.sampleTrack(track, now);
      if (s) samples.push(s);
    }
    if (samples.length === 0) {
      emit('renderLayers', {
        layer: 'AnimatedMeshLayer',
        tiles: tiles.length,
        sublayers: 0,
        ms: performance.now() - t0,
      });
      return [];
    }

    let layers: Layer[];
    if (meshMapping) {
      // Per-category models: group active samples by category and emit one
      // SimpleMeshLayer per category (mesh is a per-layer prop, so distinct
      // models need distinct sublayers), each falling back to `mesh`.
      const groups = new Map<string, Sample[]>();
      // Seed a group for EVERY mapped category up front so its sublayer — and its
      // uploaded GPU Model — persists across frames even when that category
      // momentarily has zero active tracks. Otherwise the sublayer is unmounted
      // and remounted as the category comes and goes, re-uploading (and, for a
      // URL mesh, re-async-resolving) the Model each reappearance → pop-in.
      for (const cat of Object.keys(meshMapping)) groups.set(cat, []);
      for (const s of samples) {
        const cat = s.track.category;
        let g = groups.get(cat);
        if (!g) {
          g = [];
          groups.set(cat, g);
        }
        g.push(s);
      }
      layers = [];
      const live = new Set<string>();
      for (const [cat, group] of groups) {
        const mesh = meshMapping[cat] ?? baseMesh;
        if (!mesh) continue; // no model for this category and no fallback
        const key = `cat-${cat || '∅'}`;
        live.add(key);
        layers.push(this.buildMeshSublayer(group, mesh, key, now));
      }
      this.pruneBuffers(live);
    } else {
      layers = [this.buildMeshSublayer(samples, baseMesh, 'all', now)];
      this.pruneBuffers(SINGLE_SUBLAYER_KEYS);
    }

    emit('renderLayers', {
      layer: 'AnimatedMeshLayer',
      tiles: tiles.length,
      tracks: index.size,
      active: samples.length,
      sublayers: layers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedMeshLayer: ${index.size} tracks → ${samples.length} active models`,
      );
    }
    return layers;
  }

  /** Release instance buffers for sublayer keys that no longer render. */
  private pruneBuffers(live: ReadonlySet<string>): void {
    if (!this.meshBuffers) return;
    for (const key of this.meshBuffers.keys()) {
      if (!live.has(key)) this.meshBuffers.delete(key);
    }
  }

  /** Grow-only instance buffers for one sublayer, sized to at least `n`. */
  private ensureBuffers(instanceKey: string, n: number): MeshInstanceBuffers {
    if (!this.meshBuffers) this.meshBuffers = new Map();
    let buf = this.meshBuffers.get(instanceKey);
    if (!buf) {
      buf = makeMeshBuffers(Math.max(n, 16));
      this.meshBuffers.set(instanceKey, buf);
    } else if (buf.capacity < n) {
      // Geometric growth so a scene ramping up to N objects reallocates
      // O(log N) times, not once per frame.
      growMeshBuffers(buf, Math.max(n, buf.capacity * 2));
    }
    return buf;
  }

  /** Build one engine sublayer over `samples`, instancing `mesh` at each pose. */
  protected buildMeshSublayer(
    samples: Sample[],
    mesh: MeshSource,
    instanceKey: string,
    now: number,
  ): Layer {
    const n = samples.length;
    const scaleDims = this.props.scaleToDimensions ?? true;
    const offset = this.props.orientationOffset ?? [0, 0, 0];
    const pitchOff = offset[0] ?? 0;
    const yawOff = offset[1] ?? 0;
    const rollOff = offset[2] ?? 0;

    // Grow-only buffers, rewritten in place: see MeshInstanceBuffers for why
    // nothing here is reallocated per tick.
    const buf = this.ensureBuffers(instanceKey, n);
    buf.revision++;
    const { positions, orientations, scales, colors } = buf;
    const quat = this.quatIndex;
    const attitude: Euler = [0, 0, 0];

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const o3 = i * 3;
      positions[o3] = s.lon;
      positions[o3 + 1] = s.lat;
      positions[o3 + 2] = s.alt;
      // deck SimpleMeshLayer orientation is [pitch, yaw, roll] (deg). A baked
      // attitude quaternion (slerped to the playhead) drives all three slots;
      // otherwise heading is a yaw about the vertical z-axis → slot 1 alone.
      // Either way the constant offset is ADDED. NaN heading + no quaternion ⇒
      // the offset alone (axis-aligned base pose).
      if (quat?.sample(s.track.trackId, now, attitude)) {
        orientations[o3] = attitude[0] + pitchOff;
        orientations[o3 + 1] = attitude[1] + yawOff;
        orientations[o3 + 2] = attitude[2] + rollOff;
      } else {
        orientations[o3] = pitchOff;
        orientations[o3 + 1] =
          (Number.isFinite(s.heading) ? s.heading * RAD_TO_DEG : 0) + yawOff;
        orientations[o3 + 2] = rollOff;
      }
      if (scaleDims) {
        scales[o3] = s.length;
        scales[o3 + 1] = s.width;
        scales[o3 + 2] = s.height;
      } else {
        scales[o3] = 1;
        scales[o3 + 1] = 1;
        scales[o3 + 2] = 1;
      }
      const o4 = i * 4;
      const c = s.track.color;
      colors[o4] = c[0];
      colors[o4 + 1] = c[1];
      colors[o4 + 2] = c[2];
      colors[o4 + 3] = Math.round((c[3] ?? 255) * s.alpha);
    }

    // getPosition + getColor bind straight from binary data.attributes (deck's
    // SimpleMeshLayer registers them as single-string accessors), as VIEWS onto
    // the grow-only buffers. getOrientation and getScale CANNOT bind that way:
    // deck folds orientation/scale/translation into ONE computed
    // `instanceModelMatrix` attribute whose accessor is an ARRAY, and the
    // attribute manager only consults `data.attributes[accessorName]` for STRING
    // accessors — so a binary `data.attributes.getOrientation`/`getScale` is
    // silently ignored (the matrix updater reads the PROPS only). They ride the
    // sublayer's stable bound function accessors instead, invalidated by the
    // explicit updateTriggers below rather than by `data` identity.
    const data = {
      length: n,
      attributes: {
        getPosition: { value: positions.subarray(0, n * 3), size: 3 },
        getColor: {
          value: colors.subarray(0, n * 4),
          size: 4,
          normalized: true,
        },
      },
    };

    // Upstream pose pass-throughs win when set — the caller owns the pose.
    const userOrientation = this.props.getOrientation ?? null;
    const userScale = this.props.getScale ?? null;
    const userMatrix = this.props.getTransformMatrix ?? null;

    const extensions = this.composeExtensions([]);
    const shortId = this.engineSubLayerId();
    const props = this.composeSubLayerProps(shortId, instanceKey, {
      data: data as any,
      ...this.engineProps(mesh),
      // Per-instance pose accessors (see the note above) — read the interpolated
      // orientation/scale buffers by instance index.
      getOrientation: userOrientation ?? buf.getOrientation,
      getScale: userScale ?? buf.getScale,
      ...(userMatrix ? { getTransformMatrix: userMatrix } : {}),
      // The pose accessors are STABLE references now, and deck's accessor
      // comparator reports ANY function value as "equal" — so without these
      // triggers every model would freeze at its first-frame heading and scale.
      // Merged over (not replacing) the caller's own triggers.
      updateTriggers: {
        ...(this.props.updateTriggers as Record<string, unknown> | undefined),
        getOrientation: buf.revision,
        getScale: buf.revision,
      },
      sizeScale: this.props.sizeScale,
      // Constant anchor offset (same for every instance) — a plain accessor.
      getTranslation: this.props.getTranslation ?? [0, 0, 0],
      extensions,
      // NOTE: no `pickable` here — it inherits from the composite through
      // getSubLayerProps. Hardcoding it beat the inherited value, so
      // `pickable={false}` still produced hits and still paid for
      // instancePickingColors + the picking pass.

      // One SAMPLE per instance (stride 1); getPickingInfo turns the hit one
      // into a row lazily, so a 300-object scene stops minting 300 throwaway
      // objects per frame for picks that mostly never happen.
      sttPickSamples: samples,
      sttPickStride: 1,
    });
    const SubLayerClass = this.getSubLayerClass(shortId, this.engineClass());
    return new SubLayerClass(props as any);
  }

  /**
   * Picking enrichment: a hit's `info.index` maps into the source sublayer's
   * per-instance active-track samples (stride 1); `info.object` becomes that
   * track's flat decoded props — the AV cockpit's click-to-inspect shape. The
   * row is built HERE, at event rate, not baked for every instance every frame.
   */
  getPickingInfo({
    info,
    sourceLayer,
  }: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const out = info as SpatioTemporalPickingInfo;
    const sp = sourceLayer?.props as
      | { sttPickSamples?: Sample[]; sttPickStride?: number }
      | undefined;
    const samples = sp?.sttPickSamples;
    if (info.index >= 0 && samples) {
      const idx = Math.floor(info.index / (sp?.sttPickStride || 1));
      const sample = samples[idx];
      if (sample) {
        const row: PickRow = makePickRow(sample);
        out.object = row;
      }
    }
    return out;
  }
}
