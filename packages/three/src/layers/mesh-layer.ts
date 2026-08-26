// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTMeshLayer` — recognizable 3D MODELS (cars / pedestrians / ships / planes)
 * moving smoothly over time. The Three port of deck's `AnimatedMeshLayer`, and
 * the MESH analogue of this package's {@link import('./bounding-box-layer.js').STTBoundingBoxLayer}:
 * the same archive, the same pooled-track motion, an arbitrary instanced
 * `BufferGeometry` in place of the cuboid's twelve wireframe edges.
 *
 * ── DATA: the AV `objects/` point archive, VERBATIM ──────────────────────────
 * One POINT feature per tracked object PER KEYFRAME (`track_id`, `category`,
 * `heading`, `length`/`width`/`height`, `speed`, timestamped). This layer and
 * the bounding-box layer are interchangeable over the exact same tiles; only the
 * render primitive differs. The model is NOT a tile column — it is a STATIC
 * per-layer prop ({@link STTMeshLayerOptions.mesh}, the analogue of the icon
 * layer's atlas), optionally a per-category map
 * ({@link STTMeshLayerOptions.meshMapping}) so cars, pedestrians and cyclists
 * each get their own model.
 *
 * ── MOTION: one model per ACTIVE TRACK, never one per keyframe ───────────────
 * The defining constraint of the kind. There is NO time-window filter anywhere
 * in this layer — no window uniform, no `sttStart`/`sttEnd`, no vertex collapse
 * gate — because a window over this archive would draw N models per object
 * whenever it spanned N keyframes, leaving a "train" of cars behind every car.
 * Instead `../lib/mesh-instances.ts` pools every loaded tile's snapshots by
 * `track_id` through the SHARED framework-free track kernel (rebasing to
 * absolute epoch-ms so cross-tile keyframes join one timeline) and, once per
 * frame, interpolates exactly ONE pose per ACTIVE track. Visibility is implicit:
 * an inactive track emits no instance.
 *
 * ── THE ONE DIVERGENCE FROM THE LAYER CONTRACT ───────────────────────────────
 * `setTime` is normally a pure uniform write. Here it re-interpolates and
 * rewrites the instance buffers, because CPU-interpolated pose IS this kind's
 * animation — exactly as `STTBoundingBoxLayer.setTime` rebuilds its edge
 * buffers. Everything that CAN be static is: the pooled index, the RTC origin,
 * the bbox, the model geometries and both materials are built once and survive
 * every tick; a repeated `setTime` at the same playhead is a no-op; and the
 * per-frame attributes ride GROW-ONLY buffers this layer owns, sized to the
 * high-water mark of simultaneously-active tracks and never reallocated per
 * tick.
 *
 * ── PICKING (`kind: 'mesh'`) ─────────────────────────────────────────────────
 * Standard GPU id-buffer picking, with one documented twist: the decoded id is
 * the stable TRACK ORDINAL rather than the draw slot (draw order changes every
 * frame), painted into `sttIdColor` by the bake. See
 * `MeshTrackIndex.provenance`. A hit resolves through the shared
 * {@link resolveIdPick} to the track's representative snapshot, then has its
 * `coordinate` replaced by the LIVE interpolated position — the model is drawn
 * at the interpolated pose, so that is where the user clicked.
 */

import {
  Group,
  Mesh,
  Box3,
  Sphere,
  Vector3,
  BufferGeometry,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
} from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  bakeMeshGroup,
  buildMeshTrackIndex,
  findMeshSample,
  meshRtcOrigin,
  meshTrackBbox,
  sampleMeshFrame,
  MESH_SINGLE_GROUP,
  MESH_SINGLETON_HOLD_MS,
  type MeshGroup,
  type MeshPoseOptions,
  type MeshTrackIndex,
  type MeshTrackOptions,
  type Sample,
} from '../lib/mesh-instances.js';
import {
  createMeshMaterial,
  createMeshIdMaterial,
  updateMeshUniforms,
  type MeshMaterialBundle,
  type MeshUniformValues,
} from '../tsl/mesh-material.js';
import type { Projection } from '../projection/local-enu.js';
import type { RGBA } from '../lib/color.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

/**
 * Fallback tint when a track's category is unmapped / `colorProperty` is unset.
 * WHITE, like deck's `AnimatedMeshLayer`, so a model that carries its own
 * colouring renders with its own look instead of being tinted grey.
 */
const DEFAULT_COLOR: RGBA = [255, 255, 255, 255];

const WARNED = new Set<string>();

/** Emit `message` at most once per `key` for the life of the module. */
function warnOnce(key: string, message: string): void {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(message);
}

/**
 * Clear the one-shot warning ledger. TEST-ONLY: a suite asserting on the
 * missing-model or missing-track-id warning needs each case to warn again in
 * isolation. Production code never calls this.
 */
export function resetMeshWarnings(): void {
  WARNED.clear();
}

/**
 * Options for {@link STTMeshLayer}.
 *
 * Deliberately does NOT extend `ThreeTimeWindowOptions`: this kind is timeless
 * at the GPU (see the class header) — a `timeWindow` here would be meaningless
 * at best and would resurrect the train-of-models bug at worst.
 */
export interface STTMeshLayerOptions {
  id?: string;
  /**
   * The STATIC 3D model instanced at every tracked object's pose. A UNIT model
   * in deck's `SimpleMeshLayer` convention — +x forward, +y left, +z up, base at
   * z = 0 — which {@link scaleToDimensions} fits to each object's
   * `[length, width, height]` bbox. Load it however you like (`GLTFLoader`,
   * `OBJLoader`, a primitive); the layer takes the parsed geometry.
   *
   * When {@link meshMapping} is set this is the FALLBACK for categories absent
   * from the map. With neither set the layer renders nothing (and warns once).
   * @default null
   */
  mesh?: BufferGeometry | null;
  /**
   * Per-CATEGORY model map keyed by the raw {@link colorProperty} value. Active
   * objects are grouped by category and each group is drawn by its own child
   * `Mesh` (geometry is per-object-3D, so distinct models need distinct draws),
   * falling back to {@link mesh}. Categories with neither a mapped model nor a
   * fallback are skipped entirely — they cost no sample and no draw.
   * @default null
   */
  meshMapping?: Record<string, BufferGeometry> | null;
  /**
   * Categorical column grouping an object's keyframe snapshots into ONE
   * interpolated model. Absent ⇒ each snapshot becomes its own held instance
   * (and the layer warns once). @default 'track_id'
   */
  trackIdProperty?: string;
  /**
   * Categorical column driving each model's tint AND (with {@link meshMapping})
   * which model to draw. @default 'category'
   */
  colorProperty?: string;
  /** `{ categoryLabel → RGBA(0–255) }`. @default {} */
  colorMapping?: Record<string, RGBA>;
  /** Tint for unmapped / absent categories. @default [255,255,255,255] (white) */
  colorMappingDefault?: RGBA;
  /**
   * Yaw column (RADIANS, world frame, 0 = +x/east, CCW), shortest-arc
   * interpolated between keyframes and applied about local UP. Absent ⇒ models
   * sit at {@link orientationOffset} alone. @default 'heading'
   */
  headingProperty?: string;
  /**
   * Interleaved `FixedSizeList<f32,4>` ATTITUDE column `[qx,qy,qz,qw]` in
   * `vectorProps`. When set and present, the full 3-axis attitude — slerped
   * (shortest-arc) between the bracketing keyframes — drives all of pitch/yaw/
   * roll instead of the scalar {@link headingProperty}, which is what lets a
   * drone or aircraft archive bank and pitch instead of rendering permanently
   * wings-level. Requires a resolvable {@link trackIdProperty} (attitude
   * keyframes pool per track, exactly like positions); falls back to the heading
   * path, with a one-time warning, when the column is missing or mis-shaped.
   * @default null
   */
  quaternionColumn?: string | null;
  /**
   * Constant `[pitch, yaw, roll]` in DEGREES added to every pose — correct a
   * model whose native forward axis is not +x, or tilt/roll it. Same convention
   * and same numbers as deck's `orientationOffset`. @default [0,0,0]
   */
  orientationOffset?: [number, number, number];
  /**
   * Constant anchor offset in MODEL units, applied THROUGH the instance basis so
   * it scales with the object: `[0, 0, 0.5]` lifts a centre-origin model by half
   * of ITS OWN height. (deck's `getTranslation` is a constant offset in world
   * metres, which cannot express that.) @default [0,0,0]
   */
  modelOffset?: [number, number, number];
  /** Model-length column (metres, model +x). @default 'length' */
  lengthProperty?: string;
  /** Model-width column (metres, model +y). @default 'width' */
  widthProperty?: string;
  /** Model-height column (metres, model +z). @default 'height' */
  heightProperty?: string;
  /** Speed column (m/s) — carried to picking rows, not otherwise rendered. @default 'speed' */
  speedProperty?: string;
  /** Column whose value becomes the track label (carried to picking). @default 'category' */
  labelProperty?: string;
  /** Constant length (m) when {@link lengthProperty} names no column. @default 4 */
  defaultLength?: number;
  /** Constant width (m) when {@link widthProperty} names no column. @default 2 */
  defaultWidth?: number;
  /** Constant height (m) when {@link heightProperty} names no column. @default 1.6 */
  defaultHeight?: number;
  /**
   * Scale by `[length, width, height]`, fitting a UNIT model to each object's
   * bbox. `false` renders the model at its native size (× {@link sizeScale}) —
   * the right choice for a pre-sized car/pedestrian model. @default true
   */
  scaleToDimensions?: boolean;
  /** Uniform multiplier on the whole model, on top of the dimension scale. @default 1 */
  sizeScale?: number;
  /** Appear-fade duration (ms of playhead time) — a CPU alpha ramp. @default 200 */
  fadeInDuration?: number;
  /** Disappear-fade duration (ms of playhead time) — a CPU alpha ramp. @default 200 */
  fadeOutDuration?: number;
  /**
   * Hold window (ms) for a track with a single (un-interpolatable) keyframe.
   * @default MESH_SINGLETON_HOLD_MS (600, the shared kernel's value)
   */
  singletonHoldMs?: number;
  /**
   * Largest bracket gap (ms) a pose is interpolated across; a wider gap HOLDS
   * the last keyframe rather than gliding a line the object never travelled.
   * @default Infinity
   */
  maxGapMs?: number;
  /** Constant opacity multiplier over the per-instance faded alpha. @default 1 */
  opacity?: number;
  /** Bake the fixed-sun Lambert shade (deck `material: true`). @default true */
  lit?: boolean;
  /** Translucent models (lets the fade show). @default false (opaque, depth-sorted) */
  transparent?: boolean;
  /** Discard fragments below this alpha when transparent. @default 0.01 */
  alphaCutoff?: number;
  /** Draw the models in wireframe. @default false */
  wireframe?: boolean;
}

/** One render group's live GPU objects (a child `Mesh` + its instanced geometry). */
interface MeshChild {
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  /** True once the per-instance attributes are bound to the CURRENT buffers. */
  bound: boolean;
}

export class STTMeshLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Group();

  private readonly opts: Required<
    Omit<
      STTMeshLayerOptions,
      'id' | 'mesh' | 'meshMapping' | 'quaternionColumn' | 'maxGapMs'
    >
  > & {
    mesh: BufferGeometry | null;
    meshMapping: Record<string, BufferGeometry> | null;
    quaternionColumn: string;
    maxGapMs: number;
  };

  private projection: Projection | null = null;
  private index: MeshTrackIndex | null = null;
  private origin: [number, number, number] = [0, 0, 0];
  private bbox: {
    min: [number, number, number];
    max: [number, number, number];
  } | null = null;

  /** group key → this frame's samples + grow-only instance buffers. */
  private readonly groups = new Map<string, MeshGroup>();
  /** group key → its live child `Mesh`. */
  private readonly children = new Map<string, MeshChild>();

  private bundle: MeshMaterialBundle | null = null;
  private idBundle: MeshMaterialBundle | null = null;

  // ── GPU id-buffer pick identity (decoded id = TRACK ORDINAL) ───────────────
  private provenance: MeshTrackIndex['provenance'] | null = null;
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  private currentTimeMs = 0;
  private activeCount = 0;
  /** Playhead of the last bake; a repeated `setTime` is a no-op (audit E5). */
  private lastSampledTime = Number.NaN;

  constructor(options: STTMeshLayerOptions = {}) {
    super();
    this.id = options.id ?? 'meshes';
    this.object.name = this.id;
    // CPU-posed instances: the geometry's static bbox spans every keyframe (see
    // `meshTrackBbox`) and is what the camera rig frames to, but per-frame
    // culling on it would be pure overhead for a handful of draws.
    this.object.frustumCulled = false;
    this.opts = {
      mesh: options.mesh ?? null,
      meshMapping: options.meshMapping ?? null,
      trackIdProperty: options.trackIdProperty ?? 'track_id',
      colorProperty: options.colorProperty ?? 'category',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_COLOR,
      headingProperty: options.headingProperty ?? 'heading',
      quaternionColumn: options.quaternionColumn ?? '',
      orientationOffset: options.orientationOffset ?? [0, 0, 0],
      modelOffset: options.modelOffset ?? [0, 0, 0],
      lengthProperty: options.lengthProperty ?? 'length',
      widthProperty: options.widthProperty ?? 'width',
      heightProperty: options.heightProperty ?? 'height',
      speedProperty: options.speedProperty ?? 'speed',
      labelProperty: options.labelProperty ?? 'category',
      defaultLength: options.defaultLength ?? 4,
      defaultWidth: options.defaultWidth ?? 2,
      defaultHeight: options.defaultHeight ?? 1.6,
      scaleToDimensions: options.scaleToDimensions ?? true,
      sizeScale: options.sizeScale ?? 1,
      fadeInDuration: options.fadeInDuration ?? 200,
      fadeOutDuration: options.fadeOutDuration ?? 200,
      singletonHoldMs: options.singletonHoldMs ?? MESH_SINGLETON_HOLD_MS,
      maxGapMs: options.maxGapMs ?? Infinity,
      opacity: options.opacity ?? 1,
      lit: options.lit ?? true,
      transparent: options.transparent ?? false,
      alphaCutoff: options.alphaCutoff ?? 0.01,
      wireframe: options.wireframe ?? false,
    };
    this.object.visible = false;
  }

  // ── Config plumbing ────────────────────────────────────────────────────────

  private trackOptions(): MeshTrackOptions {
    return {
      trackIdProperty: this.opts.trackIdProperty,
      colorProperty: this.opts.colorProperty,
      colorMapping: this.opts.colorMapping,
      colorMappingDefault: this.opts.colorMappingDefault,
      labelProperty: this.opts.labelProperty,
      headingProperty: this.opts.headingProperty,
      lengthProperty: this.opts.lengthProperty,
      widthProperty: this.opts.widthProperty,
      heightProperty: this.opts.heightProperty,
      speedProperty: this.opts.speedProperty,
      quaternionColumn: this.opts.quaternionColumn,
    };
  }

  private poseOptions(): MeshPoseOptions {
    return {
      defaultLength: this.opts.defaultLength,
      defaultWidth: this.opts.defaultWidth,
      defaultHeight: this.opts.defaultHeight,
      fadeInDuration: this.opts.fadeInDuration,
      fadeOutDuration: this.opts.fadeOutDuration,
      singletonHoldMs: this.opts.singletonHoldMs,
      maxGapMs: this.opts.maxGapMs,
      sizeScale: this.opts.sizeScale,
      scaleToDimensions: this.opts.scaleToDimensions,
      orientationOffset: this.opts.orientationOffset,
      modelOffset: this.opts.modelOffset,
      groupKey: (category) => this.groupKeyFor(category),
    };
  }

  /**
   * Which render group (and therefore which model) draws `category`, or null to
   * skip it. Mirrors deck: a mapped category gets its own group, everything else
   * falls back to the base `mesh`, and a category with neither is dropped.
   */
  private groupKeyFor(category: string): string | null {
    const mapping = this.opts.meshMapping;
    if (mapping && category && mapping[category]) return `cat:${category}`;
    return this.opts.mesh ? MESH_SINGLE_GROUP : null;
  }

  /** The source geometry a group key draws. */
  private sourceGeometry(key: string): BufferGeometry | null {
    if (key === MESH_SINGLE_GROUP) return this.opts.mesh;
    const category = key.slice('cat:'.length);
    return this.opts.meshMapping?.[category] ?? this.opts.mesh;
  }

  // ── Tiles ─────────────────────────────────────────────────────────────────

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    // Cache the playhead so a `pick()` before the first `setTime` still gates on
    // a sane time rather than 0.
    this.currentTimeMs = ctx.timeOrigin;
    this.projection = ctx.projection;

    if (!this.opts.mesh && !this.opts.meshMapping) {
      warnOnce(
        `${this.id}:noMesh`,
        `[stt-three] STTMeshLayer "${this.id}": no \`mesh\` (and no ` +
          '`meshMapping`) — nothing to render. Provide a parsed glTF/OBJ ' +
          'BufferGeometry via the `mesh` prop (a static per-layer prop, like the ' +
          "icon layer's atlas).",
      );
    }

    const index = buildMeshTrackIndex(tiles, this.trackOptions());
    this.index = index;
    // Adopt the fresh pick identity EVEN when empty, so a stale pick after a
    // reload resolves to null rather than to an old feature.
    this.provenance = index.provenance;
    this.binaryByTileKey = index.binaryByTileKey;

    if (index.trackIdMissing) {
      warnOnce(
        `${this.id}:noTrackId`,
        `[stt-three] STTMeshLayer "${this.id}": no ` +
          `\`${this.opts.trackIdProperty}\` column — object snapshots cannot be ` +
          'grouped into tracks, so each is shown as a held model with no ' +
          'interpolation. Build the objects archive with a track-id column for ' +
          'smooth single-model rendering.',
      );
    }
    if (this.opts.quaternionColumn && index.attitudeMissing) {
      warnOnce(
        `${this.id}:noQuaternion`,
        `[stt-three] STTMeshLayer "${this.id}": quaternionColumn ` +
          `"${this.opts.quaternionColumn}" is not a usable FixedSizeList<f32,4> ` +
          'vector column on some loaded tiles (or those tiles carry no ' +
          `\`${this.opts.trackIdProperty}\` column to pool it by). Those objects ` +
          `fall back to the scalar \`${this.opts.headingProperty}\` heading — yaw ` +
          'only, so pitch/roll stay at orientationOffset.',
      );
    }

    this.origin = meshRtcOrigin(index, ctx.projection);
    this.bbox = meshTrackBbox(index, ctx.projection, this.origin);
    // RTC: the absolute world magnitude lives here, in an f64 CPU transform, so
    // the per-instance f32 centres stay metre-scale even under mercator/globe.
    this.object.position.set(this.origin[0], this.origin[1], this.origin[2]);
    this.applyBounds();

    // New tracks: the next `setTime` must re-bake even at the same playhead.
    this.lastSampledTime = Number.NaN;
    this.object.visible = index.ordinals.length > 0;
    // Bake immediately so a layer that is picked or measured before the first
    // frame already carries poses.
    this.bake(this.currentTimeMs);
  }

  // ── Per-frame pose bake ───────────────────────────────────────────────────

  /**
   * Re-interpolate every active track and rewrite the instance buffers.
   *
   * NOT the contract's "pure uniform write" — see the class header: CPU pose IS
   * this kind's animation, exactly as in `STTBoundingBoxLayer`. A repeated
   * `setTime` at the same playhead is skipped, because a paused clock still
   * renders every frame and this walk is O(resident tracks).
   */
  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    if (absoluteTimeMs === this.lastSampledTime) return;
    this.bake(absoluteTimeMs);
  }

  private bake(absoluteTimeMs: number): void {
    const index = this.index;
    const projection = this.projection;
    if (!index || !projection) return;
    this.lastSampledTime = absoluteTimeMs;

    const opts = this.poseOptions();
    this.activeCount = sampleMeshFrame(
      index,
      absoluteTimeMs,
      opts,
      this.groups,
    );
    for (const group of this.groups.values()) {
      const grew = bakeMeshGroup(
        group,
        index,
        projection,
        this.origin,
        absoluteTimeMs,
        opts,
      );
      this.syncChild(group, grew);
    }
    this.object.visible = this.activeCount > 0;
    this.pushUniforms();
  }

  /**
   * Bring one group's child `Mesh` in line with its freshly-baked buffers:
   * create it on first sight, re-bind its attributes when the grow-only buffers
   * were reallocated, otherwise just upload the prefix this frame wrote.
   */
  private syncChild(group: MeshGroup, grew: boolean): void {
    let child = this.children.get(group.key);
    if (!child) {
      const source = this.sourceGeometry(group.key);
      if (!source) return; // no model for this group — nothing to draw
      child = this.makeChild(source);
      this.children.set(group.key, child);
      this.object.add(child.mesh);
      // A child born mid-bake missed `applyBounds`; give it the static box now
      // so the camera rig's bounds union sees it on its very first frame.
      this.applyBoundsTo(child);
    }
    const { geometry } = child;
    const buf = group.buffers;
    if (grew || !child.bound) {
      geometry.setAttribute(
        'sttCenter',
        new InstancedBufferAttribute(buf.centers, 3),
      );
      geometry.setAttribute(
        'sttBasisX',
        new InstancedBufferAttribute(buf.basisX, 3),
      );
      geometry.setAttribute(
        'sttBasisY',
        new InstancedBufferAttribute(buf.basisY, 3),
      );
      geometry.setAttribute(
        'sttBasisZ',
        new InstancedBufferAttribute(buf.basisZ, 3),
      );
      geometry.setAttribute(
        'sttColor',
        new InstancedBufferAttribute(buf.colors, 4),
      );
      // The pick id rides the SAME per-frame bake as the pose (its value is the
      // track ordinal, so it moves with the draw slot); binding it here rather
      // than lazily in `ensurePickPass` is what keeps the two in lockstep.
      geometry.setAttribute(
        'sttIdColor',
        new InstancedBufferAttribute(buf.idColors, 3),
      );
      child.bound = true;
    } else {
      // Upload only the prefix this frame wrote. The buffers are sticky and
      // sized to CAPACITY, so an unqualified `needsUpdate` would re-send the
      // whole allocation every frame.
      uploadPrefix(geometry, 'sttCenter', buf.count * 3);
      uploadPrefix(geometry, 'sttBasisX', buf.count * 3);
      uploadPrefix(geometry, 'sttBasisY', buf.count * 3);
      uploadPrefix(geometry, 'sttBasisZ', buf.count * 3);
      uploadPrefix(geometry, 'sttColor', buf.count * 4);
      uploadPrefix(geometry, 'sttIdColor', buf.count * 3);
    }
    geometry.instanceCount = buf.count;
    // Hide (don't draw) when empty — a 0-instance draw is a no-op the WebGPU
    // backend warns about.
    child.mesh.visible = buf.count > 0;
  }

  /**
   * Wrap a caller-supplied `BufferGeometry` as the instanced template for one
   * group.
   *
   * The position/normal/index attributes are CLONED rather than shared: this
   * layer's `dispose()` must be free to release its own geometry without
   * dropping GPU buffers the caller's model — possibly shared with other layers,
   * or with another category here — still references, and equally the caller
   * must be free to dispose theirs. A model is a few hundred KB at most; the
   * ownership clarity is worth the copy.
   *
   * A model with no normals gets them computed, because the material reads
   * `attribute('normal')` and WebGPU treats a missing vertex attribute as a hard
   * build failure (it blanks the whole frame), where WebGL merely tolerated it.
   */
  private makeChild(source: BufferGeometry): MeshChild {
    const geometry = new InstancedBufferGeometry();
    const position = source.getAttribute('position');
    if (position) geometry.setAttribute('position', position.clone());
    if (source.index) geometry.setIndex(source.index.clone());
    const normal = source.getAttribute('normal');
    if (normal) geometry.setAttribute('normal', normal.clone());
    else if (position) geometry.computeVertexNormals();
    geometry.instanceCount = 0;

    const mesh = new Mesh(geometry, this.ensureBundle().material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.name = `${this.id}:${source.uuid}`;
    return { mesh, geometry, bound: false };
  }

  /**
   * Push the static keyframe bbox onto every child geometry. It spans EVERY
   * keyframe of every track, not just this frame's poses, so the camera rig's
   * bounds union (`Box3.expandByObject`, which reads `geometry.boundingBox`)
   * frames the whole scene instead of breathing with the traffic.
   */
  private applyBounds(): void {
    for (const child of this.children.values()) this.applyBoundsTo(child);
  }

  /** Push the current static bbox onto one child (null clears it). */
  private applyBoundsTo(child: MeshChild): void {
    const bbox = this.bbox;
    if (!bbox) {
      child.geometry.boundingBox = null;
      child.geometry.boundingSphere = null;
      return;
    }
    const box = new Box3(new Vector3(...bbox.min), new Vector3(...bbox.max));
    child.geometry.boundingBox = box;
    child.geometry.boundingSphere = box.getBoundingSphere(new Sphere());
  }

  /**
   * The colour material, built ONCE for the life of the layer (audit E5). Every
   * input is fixed at construction, so there is no variant to flip; rebuilding
   * it per `setTiles` would evict three's `nodeBuilderCache` entry and force a
   * full shader/pipeline rebuild on every tile arrival.
   */
  private ensureBundle(): MeshMaterialBundle {
    if (!this.bundle) {
      this.bundle = createMeshMaterial({
        lit: this.opts.lit,
        transparent: this.opts.transparent,
        alphaCutoff: this.opts.alphaCutoff,
        wireframe: this.opts.wireframe,
      });
      updateMeshUniforms(this.bundle, this.uniformValues());
    }
    return this.bundle;
  }

  /** Uniform values for the given frame — shared by the colour and the id pass. */
  private uniformValues(): MeshUniformValues {
    return { opacity: this.opts.opacity };
  }

  private pushUniforms(): void {
    if (this.bundle) updateMeshUniforms(this.bundle, this.uniformValues());
  }

  /** Active interpolated poses at the last bake (for inspection / debugging). */
  getActiveSamples(): readonly Sample[] {
    const out: Sample[] = [];
    for (const group of this.groups.values()) out.push(...group.samples);
    return out;
  }

  // ── Picking (GPU id-buffer catalog: mesh variant) ──────────────────────────

  /**
   * Resolve a decoded id to a normalised {@link STTIdPickInfo} (`kind: 'mesh'`),
   * or null for a miss. Pure — the unit-tested seam; call it directly with an id
   * you already decoded.
   *
   * The id is the stable TRACK ORDINAL (see the class header), so it indexes the
   * provenance array directly. The resolved feature is the track's
   * representative snapshot — the archive's per-track constants (`track_id`,
   * `category`, dims) are exactly what an AV inspector wants — but the
   * `coordinate` is replaced by the LIVE interpolated position, because that is
   * where the model was drawn and therefore where the click landed.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    const provenance = this.provenance;
    if (!provenance) return null;
    const info = resolveIdPick({
      index,
      provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'mesh',
      layerId: this.id,
      screen,
    });
    if (!info) return null;
    const live = findMeshSample(this.groups, index);
    if (live) info.coordinate = [live.lon, live.lat];
    return info;
  }

  /**
   * Lazily build the id material. Unlike the other kinds there is no
   * `sttIdColor` attribute to paint here: its value is the track ordinal, which
   * moves with the draw slot every frame, so the bake writes it as part of the
   * ordinary pose pass and it is always in sync.
   */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createMeshIdMaterial({
        alphaCutoff: this.opts.alphaCutoff,
      });
    }
  }

  /**
   * GPU mesh pick — auto-registered into the r3f `PickController` (a CPU box
   * miss falls through to this). Renders this layer's models with the flat id
   * material into `picker`'s off-screen target, reads back the id at CSS pixel
   * `(cssX, cssY)`, and resolves it through the provenance array. The
   * `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify per the package's test policy.
   *
   * The id material recomposes the model at the SAME interpolated pose as the
   * colour material and thresholds the SAME fade alpha, so only models drawn
   * THIS frame are pickable, exactly where the eye sees them. Every child mesh
   * is swapped (and restored) together, because the whole `Group` is what the
   * picker renders.
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<STTIdPickInfo | null> {
    const provenance = this.provenance;
    if (!provenance || provenance.length === 0) return null;
    if (!this.object.visible || this.activeCount === 0) return null;
    this.ensurePickPass();
    const idBundle = this.idBundle;
    if (!idBundle) return null;
    // Sync the id material's gates to the live playhead, not just to setTiles.
    updateMeshUniforms(idBundle, this.uniformValues());

    const swapped: Array<[Mesh, Mesh['material']]> = [];
    const index = await picker.pick(this.object, camera, cssX, cssY, {
      // The id is the TRACK ORDINAL, so the valid range is the provenance
      // length; anything above it (the sentinel white background included) is a
      // miss.
      featureCount: provenance.length,
      onBeforeRender: () => {
        for (const child of this.children.values()) {
          swapped.push([child.mesh, child.mesh.material]);
          child.mesh.material = idBundle.material;
        }
      },
      onAfterRender: () => {
        for (const [mesh, material] of swapped) mesh.material = material;
        swapped.length = 0;
      },
    });
    if (index == null) return null;
    return this.resolvePick(index, [cssX, cssY]);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /**
   * Release everything this layer owns: the cloned instanced geometries and both
   * materials. The caller's source `BufferGeometry` objects are host-supplied
   * resources and are NEVER touched (which is exactly why `makeChild` clones).
   */
  dispose(): void {
    for (const child of this.children.values()) {
      this.object.remove(child.mesh);
      child.geometry.dispose();
    }
    this.children.clear();
    this.groups.clear();
    // Drop the pooled index too, so a stray `setTime` after teardown (a frame
    // already in flight) bails instead of re-creating child meshes on a dead
    // layer — and so a stale `pick()` resolves to null.
    this.index = null;
    this.projection = null;
    this.provenance = null;
    this.binaryByTileKey = new Map();
    this.activeCount = 0;
    this.object.visible = false;
    this.bundle?.material.dispose();
    this.bundle = null;
    this.idBundle?.material.dispose();
    this.idBundle = null;
  }
}

/**
 * Mark the first `floats` of one instanced attribute dirty. Sticky, capacity-
 * sized buffers make an unqualified `needsUpdate` re-upload the whole allocation
 * every frame; this sends only what the bake actually wrote.
 */
function uploadPrefix(
  geometry: InstancedBufferGeometry,
  name: string,
  floats: number,
): void {
  const attr = geometry.getAttribute(name) as
    | InstancedBufferAttribute
    | undefined;
  if (!attr || floats === 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, floats);
  attr.needsUpdate = true;
}
