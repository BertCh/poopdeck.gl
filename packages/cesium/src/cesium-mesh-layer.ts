// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTMeshLayer` — ONE recognizable 3-D glTF MODEL per TRACKED OBJECT at the
 * playhead, the Cesium analogue of deck's `AnimatedMeshLayer` and three's
 * `STTMeshLayer`. Where `STTBoundingBoxLayer` draws the detection cuboid, this
 * draws the thing the cuboid is around: an actual car/truck/pedestrian mesh,
 * posed on the WGS84 ellipsoid and moving smoothly between keyframes.
 *
 * ── THE DEFINING CONSTRAINT: ONE INSTANCE PER ACTIVE TRACK ───────────────────
 * An AV `objects/` archive carries one POINT feature per tracked object PER
 * KEYFRAME (`track_id`, `category`, `heading`, `length`/`width`/`height`,
 * `speed`, timestamped). Resolving a per-feature alpha from `core/time-filter`
 * over that — what every alpha-animated layer in this package does — would draw
 * N models for one object whenever the window spans N of its keyframes: a
 * *train of parked cars* trailing every moving car, the mesh form of the box
 * layer's "train of boxes".
 *
 * So there is no `mode`, no `timeFilter`, and no `timeFilterAlpha` call on this
 * path. `lib/mesh-instances.ts` pools every resident tile's snapshots by
 * `track_id` through `@poopdeck.gl/core`'s SHARED track kernel — which rebases
 * each keyframe to ABSOLUTE epoch-ms, so keyframes from tiles with different
 * `timeOffset`s join ONE timeline — and emits one entry per TRACK. `setTime`
 * then interpolates exactly ONE pose per ACTIVE track (`sampleTrack`) and
 * rewrites that track's model matrix. Visibility is implicit: `sampleTrack`
 * returns `null` outside a track's keyframe span and the model is simply not
 * shown.
 *
 * That makes this file an `EXEMPT_SETTIME` case for
 * `test/time-filter-oracle.test.ts` — it animates POSE, not alpha, alongside
 * `STTBoundingBoxLayer` (same reason), `STTTripsLayer` (geometry trim) and
 * `STTTripHeadsLayer` (position lerp). The one alpha here is the kernel's
 * appear/disappear FADE (`Sample.alpha`), a ramp at each track's own ends; it is
 * not a time filter and does not run through the oracle.
 *
 * ── MODELS LOAD ASYNCHRONOUSLY, AND THAT IS VISIBLE ──────────────────────────
 * `Model.fromGltfAsync` fetches and parses a glTF/glb before anything can be
 * drawn. A track whose model has not resolved is fully live in every other
 * respect — pooled, sampled, its matrix written every frame — it just does not
 * DRAW; it starts drawing, already correctly posed, on the frame after its model
 * resolves. Nothing blocks and nothing is substituted: there is deliberately NO
 * placeholder cube standing in for a mesh that has not arrived (or for a
 * category with no URL at all), because a stand-in that looks like data IS data
 * as far as the viewer is concerned. A category with no URL never draws, and
 * `modelErrors` counts loads that failed outright.
 *
 * Models are keyed by `(track, url)` and REUSED across `setTiles`: tile churn is
 * routine (every pan, every prefetch) and re-creating a `Model` per rebuild
 * would blink every vehicle out for a fetch/parse it did not need. Only tracks
 * that genuinely left the pool, or whose category now resolves to a different
 * URL, are removed and destroyed.
 *
 * ── WHY ONE `Model` PER TRACK, AND WHAT THAT COSTS ───────────────────────────
 * Cesium has no instanced-model primitive on the public surface (`i3dm` lives
 * inside 3D Tiles, behind a tileset and its own JSON), so "one instanced draw
 * for all vehicles" is not on offer here the way it is in deck's
 * `ScenegraphLayer`. One `Model` per track is the honest shape: per-frame work
 * is O(active tracks) — a matrix write of 16 doubles each, no buffer traffic —
 * and the price is DRAW CALLS PER TRACK (each model's own primitives), plus one
 * glTF load per distinct URL, cached by Cesium's `ResourceCache` so N cars
 * sharing a URL parse it once. Tens of tracked objects is the AV cockpit's
 * scale and is nothing; this is not a general per-feature mesh renderer.
 *
 * ── THE ALIASING TRAP (why each entry owns its own `Matrix4`) ────────────────
 * The package's per-frame idiom is one shared module-level scratch per mutable
 * Cesium type, which is safe wherever the SETTER COPIES (`PointPrimitive.color`,
 * batch-table colours, and `Model.color`, which clones into its own `_color`).
 * `Model.modelMatrix` is a PLAIN FIELD with no setter: assigning one shared
 * scratch to every model would leave them all referencing the same object and
 * the last write of the frame would pose every vehicle. Each entry therefore
 * owns a `Matrix4`, and the model's field is re-pointed at it once on attach —
 * `Model`'s constructor CLONES the matrix it is given, so adopting identity
 * afterwards is what makes the per-frame in-place mutation land. Cesium keeps
 * its own `_modelMatrix` copy and diffs against it, so in-place mutation still
 * dirties correctly. The only shared scratches here are the plain `number[]` the
 * pure builder writes into, the euler triple, and one `Color`.
 *
 * ── LOCAL EAST-NORTH-UP, NOT THE ECEF AXES ───────────────────────────────────
 * Every pose is composed on the local east/north/up frame at its own geodetic
 * lon/lat (`enuBasis`, which reproduces `Transforms.eastNorthUpToFixedFrame` by
 * construction and stays Cesium-free so it is testable in plain Node). An
 * identity rotation would point the model at the ECEF pole: right at the equator
 * on the prime meridian, and visibly, increasingly wrong everywhere else.
 * Positions are absolute f64 ECEF metres with no RTC — `Cartesian3`/`Matrix4`
 * consume CPU doubles, so there is no f32 buffer to protect.
 *
 * The unit model frame is +x forward, +y left, +z up: that is what Cesium's own
 * glTF axis correction (Y-up/Z-forward → Z-up/X-forward) hands the model matrix,
 * and the matrix columns are scaled to `length`/`width`/`height` metres, so a
 * 1 m unit car becomes a 4.5 m car. A model authored on some other axis is
 * corrected with `orientationOffset` (deck's tuple, same order, same numbers)
 * rather than by swapping Cesium's `upAxis`, so the same numbers port between
 * backends.
 *
 * ── DOCUMENTED DEVIATIONS FROM DECK ──────────────────────────────────────────
 * 1. deck's `ScenegraphLayer`/`SimpleMeshLayer` applies `getColor` as a per-mesh
 *    tint multiply. Cesium's equivalent is `Model.color` + `colorBlendMode`, and
 *    the default here is `HIGHLIGHT` (multiply), which matches. `REPLACE` and
 *    `MIX` are exposed but are Cesium-only looks with no deck counterpart.
 * 2. No per-VERTEX or per-primitive colour: the tint is one value per TRACK,
 *    baked by the kernel from the track's `category`. `lib/feature-color.ts`'s
 *    constant/categorical/ramp trichotomy therefore does not apply — a track is
 *    not a feature, and a ramp over "the feature's numeric column" has no single
 *    value once snapshots are pooled. The categorical arm survives as
 *    `colorProperty` + `colorMapping`, which is what deck and three expose for
 *    this layer too.
 * 3. No `showLabels` / `showVelocity` sublayers, matching `STTBoundingBoxLayer`:
 *    absent, not approximated.
 * 4. deck animates glTF ANIMATION tracks (`_animations`); this layer poses the
 *    model rigidly and leaves `clampAnimations` at Cesium's default. Wheels do
 *    not turn. Rigid-body pose is the archive's content; anything else would be
 *    invented motion.
 *
 * Rendering needs a live Cesium `Scene` and a real glTF fetch, so the drawn
 * result is browser-verify only; the pooling, the pose maths, the async attach
 * and the update path are unit-tested under Node
 * (`test/cesium-mesh-layer.test.ts`, `test/mesh-instances.test.ts`).
 */

import {
  Cartesian2,
  Color,
  ColorBlendMode,
  Matrix4,
  Model,
  PrimitiveCollection,
  defined,
  type Scene,
} from 'cesium';
import {
  getFeatureProperties,
  makePickRow,
  sampleTrack,
  type BinaryFeatures,
  type Sample,
  type Tile,
  type TrackSampleConfig,
} from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  MATRIX4_LENGTH,
  buildMeshInstances,
  meshPoseOptions,
  meshSampleConfig,
  sampleMeshAttitude,
  writeMeshModelMatrix,
  type MeshBuildOptions,
  type MeshPoseOptions,
  type MeshSampleOptions,
  type MeshTrackedModel,
} from './lib/mesh-instances.js';

/**
 * Pick/attribute identity for one track's model — the package-wide pick shape
 * (`layerId`/`binary`/`featureIndex`) plus the `trackId`, which rides along
 * because a tracked object, unlike a feature, HAS an identity worth reporting
 * and because `binary` is null for a track with no resolvable id. This object
 * becomes `Model.id`, which is exactly what `scene.pick` hands back
 * (`PickingPipelineStage` copies `model.id` onto the pick object).
 */
export interface MeshPickId {
  layerId: string;
  binary: BinaryFeatures | null;
  featureIndex: number;
  trackId: string;
}

/**
 * Everything the layer hands its model loader. Spelled out as a type — rather
 * than the layer calling `Model.fromGltfAsync` inline — so a host can supply a
 * pre-parsed model, an offline cache, or (in this package's own tests) a stand-in
 * that needs no GPU context and no network.
 */
export interface MeshModelRequest {
  /** Resolved glTF/glb URL for this track's category. Never empty. */
  url: string;
  /**
   * The ENTRY's own matrix. Cesium clones it into the model, so the layer
   * re-points `model.modelMatrix` at this object on attach; a loader that
   * constructs the model some other way should do the same or leave the field
   * alone and let the layer's attach step do it.
   */
  modelMatrix: Matrix4;
  /** Initial tint — alpha 0, so the first `setTime` writes the real alpha. */
  color: Color;
  /** Becomes `Model.id`; `pick()` matches on `layerId`. */
  id: MeshPickId;
  colorBlendMode: ColorBlendMode;
  colorBlendAmount: number;
  backFaceCulling: boolean;
}

/** How a track's glTF is obtained. @see MeshModelRequest */
export type MeshModelLoader = (req: MeshModelRequest) => Promise<Model>;

export interface STTMeshLayerOptions
  extends MeshBuildOptions, MeshSampleOptions, Partial<MeshPoseOptions> {
  id?: string;
  /**
   * Extra multiplier on every model's alpha (0..1), on top of the category
   * colour and the kernel's appear/disappear fade. @default 1
   */
  opacity?: number;
  /**
   * How `Model.color` combines with the glTF's own materials. `HIGHLIGHT`
   * (multiply) is deck's tint semantics; `REPLACE`/`MIX` are Cesium-only.
   * @default ColorBlendMode.HIGHLIGHT
   */
  colorBlendMode?: ColorBlendMode;
  /** Blend weight for `ColorBlendMode.MIX` (0..1). @default 0.5 */
  colorBlendAmount?: number;
  /** @default true — a vehicle mesh is closed, so culling is free correctness. */
  backFaceCulling?: boolean;
  /**
   * Override how models are obtained. Defaults to `Model.fromGltfAsync`, which
   * needs a browser (fetch + WebGL); a test or an offline host swaps it here.
   */
  loadModel?: MeshModelLoader;
}

interface MeshEntry {
  mesh: MeshTrackedModel;
  id: MeshPickId;
  /** `${track key}\0${url}` — the reuse key across rebuilds. */
  modelKey: string;
  /** Null while the glTF is in flight, when it failed, or with no URL at all. */
  model: Model | null;
  /**
   * This entry's OWN model matrix, adopted by its model on attach and mutated in
   * place every frame. Never a shared scratch — see the header.
   */
  matrix: Matrix4;
  /** Last alpha written; NaN so the first frame (and every attach) writes. */
  lastAlpha: number;
  /** Most recent interpolated pose, or null while the track is inactive. */
  sample: Sample | null;
}

/**
 * Shared per-frame scratches. All three are consumed synchronously by the write
 * that follows them and none is ever handed to Cesium to keep: the column-major
 * buffer is copied by `Matrix4.fromColumnMajorArray` into the entry's own
 * matrix, the euler triple is read out immediately, and `Model.color`'s setter
 * clones into the model's own `_color`.
 */
const SCRATCH_M16: number[] = new Array(MATRIX4_LENGTH).fill(0);
const SCRATCH_ATTITUDE: [number, number, number] = [0, 0, 0];
const SCRATCH_COLOR = new Color();

/** The shipped loader: a real glTF/glb through Cesium's own resource cache. */
const loadGltfModel: MeshModelLoader = (req) =>
  Model.fromGltfAsync({
    url: req.url,
    modelMatrix: req.modelMatrix,
    color: req.color,
    colorBlendMode: req.colorBlendMode,
    colorBlendAmount: req.colorBlendAmount,
    backFaceCulling: req.backFaceCulling,
    id: req.id,
    // Nothing is posed until the first setTime, so nothing may draw yet.
    show: false,
    allowPicking: true,
    asynchronous: true,
    incrementallyLoadTextures: true,
  });

export class STTMeshLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PrimitiveCollection;
  private readonly opts: STTMeshLayerOptions;
  private readonly sampleCfg: TrackSampleConfig;
  private readonly pose: MeshPoseOptions;
  private readonly opacity: number;
  private readonly colorBlendMode: ColorBlendMode;
  private readonly colorBlendAmount: number;
  private readonly backFaceCulling: boolean;
  private readonly loadModel: MeshModelLoader;

  private entries: MeshEntry[] = [];
  /** Live models by `modelKey`, so a rebuild reuses rather than refetches. */
  private models = new Map<string, Model>();
  private pending: Promise<void>[] = [];
  /**
   * Bumped by every `setTiles` (and by `dispose`). A load that resolves against
   * a stale generation belongs to a pool that no longer exists, so its model is
   * destroyed on arrival instead of joining the scene.
   *
   * A rebuild that lands MID-FLIGHT therefore re-issues that track's load: the
   * reuse map can only hand back models that already attached. That is the
   * accepted cost of not tracking half-loaded models as reusable state, and it
   * is small — the glTF is in Cesium's `ResourceCache` by then, so the second
   * attempt is a parse, not a fetch.
   */
  private generation = 0;
  private timeOrigin = 0;
  /** Playhead of the last resample; a repeated `setTime` is a no-op. */
  private lastSampledTime = Number.NaN;
  private disposed = false;

  /**
   * True when the most recent `setTiles` saw a tile with NO track-id column.
   * Those snapshots cannot be grouped, so each is drawn as its own HELD
   * singleton with no interpolation. Surfaced as a field rather than a console
   * warning because nothing else in this package logs; a host that wants to tell
   * the user reads it after `setTiles`.
   */
  trackIdMissing = false;
  /** True when a quaternion column was asked for but unusable on some tile. */
  attitudeMissing = false;
  /** Model loads that rejected (bad URL, 404, unparseable glTF). */
  modelErrors = 0;

  constructor(scene: Scene, options: STTMeshLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-meshes';
    this.scene = scene;
    this.opts = options;
    this.opacity = options.opacity ?? 1;
    this.sampleCfg = meshSampleConfig(options);
    this.pose = meshPoseOptions(options);
    this.colorBlendMode = options.colorBlendMode ?? ColorBlendMode.HIGHLIGHT;
    this.colorBlendAmount = options.colorBlendAmount ?? 0.5;
    this.backFaceCulling = options.backFaceCulling ?? true;
    this.loadModel = options.loadModel ?? loadGltfModel;
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /**
   * (Re)build one model per tracked object from decoded tiles.
   *
   * Build BEFORE the teardown, and bail on an empty result while the old models
   * are still standing. Selection reports an empty visible set for the frames
   * between a viewport change and the first decoded tile of the new set;
   * tearing down first turns that transient into a blank frame (the "tiles
   * genuinely in view flash out" symptom). Holding the previous models is safe
   * even when the emptiness is permanent: they sit at their true ECEF poses,
   * which the camera has by then left behind.
   *
   * The teardown itself is a DIFF rather than a `removeAll`, because a model is
   * an expensive, asynchronously-acquired thing: a track still in the pool under
   * the same URL keeps the exact `Model` it already had (and, with it, the
   * matrix carrying its last pose, so it cannot flash to the earth's centre
   * before the next `setTime`). Only genuinely departed tracks are destroyed.
   */
  setTiles(tiles: Tile[]): void {
    const build = buildMeshInstances(tiles, this.opts);
    if (build.meshes.length === 0) return; // also leaves the prior timeOrigin untouched

    const previous = this.models;
    this.models = new Map<string, Model>();
    this.pending = [];
    this.generation++;
    const gen = this.generation;
    const entries: MeshEntry[] = [];

    for (const mesh of build.meshes) {
      const id: MeshPickId = {
        layerId: this.id,
        binary: mesh.binary,
        featureIndex: mesh.featureIndex,
        trackId: mesh.track.trackId || mesh.key,
      };
      // Track keys are unique within one build, so the URL is all that can
      // change under a key — and a changed URL is a different model.
      const modelKey = `${mesh.key}\u0000${mesh.modelUrl}`;
      const entry: MeshEntry = {
        mesh,
        id,
        modelKey,
        model: null,
        matrix: new Matrix4(),
        lastAlpha: Number.NaN, // NaN !== anything → force the first write
        sample: null,
      };
      entries.push(entry);

      if (mesh.modelUrl === '') continue; // no URL for this category → never drawn

      const reused = previous.get(modelKey);
      if (reused) {
        previous.delete(modelKey);
        this.models.set(modelKey, reused);
        // Adopt the model's EXISTING matrix: it already holds the last pose, so
        // the reused model keeps standing exactly where it was until the next
        // setTime, rather than snapping to identity (the earth's centre).
        entry.matrix = reused.modelMatrix;
        reused.id = id; // fresh provenance — the pool was rebuilt
        entry.model = reused;
        continue;
      }
      this.startLoad(entry, gen);
    }

    // Whatever no entry claimed has left the pool; PrimitiveCollection.remove
    // destroys it (destroyPrimitives defaults true).
    for (const stale of previous.values()) this.collection.remove(stale);

    this.entries = entries;
    this.timeOrigin = build.timeOrigin;
    this.trackIdMissing = build.trackIdMissing;
    this.attitudeMissing = build.attitudeMissing;
    // New tracks: the next setTime must resample even at the same playhead.
    this.lastSampledTime = Number.NaN;
  }

  /**
   * Advance to an absolute playhead time: interpolate ONE pose per ACTIVE track
   * and rewrite that track's model matrix.
   *
   * The rebase against `timeOrigin` is spelled the way every layer here spells
   * it, and is the IDENTITY on this path — the track kernel pools keyframes to
   * absolute epoch-ms, so `buildMeshInstances` reports an origin of 0 (see
   * `MeshBuild.timeOrigin`).
   *
   * Pose is rewritten unconditionally for an active track because it genuinely
   * changes every frame, and it is written even while the model is still in
   * flight so that the model appears already correctly posed. COLOUR is not: it
   * only moves when the appear/disappear fade is ramping, so it is guarded by
   * the same `lastAlpha` skip the other layers use. That guard is worth more
   * here than anywhere else in the package — `Model.color`'s setter calls
   * `resetDrawCommands()` whenever the write crosses the translucency boundary,
   * so an unguarded per-frame write would rebuild draw commands for every
   * vehicle, every frame.
   */
  setTime(absoluteMs: number): void {
    const now = absoluteMs - this.timeOrigin;
    // A paused clock still renders every frame; resampling every track for a
    // playhead that did not move is pure waste.
    if (now === this.lastSampledTime) return;
    this.lastSampledTime = now;

    const cfg = this.sampleCfg;
    const pose = this.pose;
    for (const e of this.entries) {
      const s = sampleTrack(e.mesh.track, now, cfg);
      e.sample = s;
      if (!s) {
        // Inactive: not emitted at all. No pose, no draw.
        this.writeAppearance(e);
        continue;
      }
      const posed = sampleMeshAttitude(e.mesh.attitude, now, SCRATCH_ATTITUDE)
        ? SCRATCH_ATTITUDE
        : null;
      writeMeshModelMatrix(SCRATCH_M16, s, posed, pose);
      // Copies into the entry's own matrix — the object the model references.
      Matrix4.fromColumnMajorArray(SCRATCH_M16, e.matrix);
      this.writeAppearance(e);
    }
  }

  /**
   * Hit-test → the shared `SttPickResult`.
   *
   * `object` is the archive's own decoded columns for the track's first pooled
   * keyframe, which is where its immutable per-object facts (`track_id`,
   * `category`, nominal dims) live; the model's LIVE state at the playhead —
   * interpolated heading, dims, speed — goes in `meta` via the kernel's
   * `makePickRow`, which is the AV inspector's shape. A track with no resolvable
   * id has no feature to join to, so it reports `object: null`, `index: -1` and
   * `meta` alone. `coordinate` is the interpolated pose, not the first keyframe:
   * it is where the user actually clicked.
   */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: MeshPickId }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const id = picked.id;
    // Resolve by id IDENTITY: every entry owns exactly one id object, so this
    // works even for track-less snapshots whose (binary, featureIndex) is absent
    // and would otherwise collide on (null, -1).
    const entry = this.entries.find((e) => e.id === id);
    const row = entry?.sample ? makePickRow(entry.sample) : null;
    return {
      object: id.binary
        ? getFeatureProperties(id.binary, id.featureIndex)
        : null,
      index: id.binary ? id.featureIndex : -1,
      layerId: this.id,
      coordinate: entry?.sample
        ? [entry.sample.lon, entry.sample.lat]
        : undefined,
      screen: [cssX, cssY],
      meta: row ? { ...row } : { track_id: id.trackId },
    };
  }

  /**
   * Resolves once every model load started by the LATEST `setTiles` has settled
   * (resolved, rejected, or been discarded as stale). Loads only start in
   * `setTiles`, so awaiting this after one is deterministic; it exists for hosts
   * that want to hold a first frame until the fleet is up, and for this
   * package's tests.
   */
  async modelsSettled(): Promise<void> {
    await Promise.all(this.pending);
  }

  /**
   * Remove (and, through `PrimitiveCollection`'s own `destroyPrimitives`,
   * destroy) every attached model, then make sure nothing in flight can outlive
   * the layer: bumping the generation means a load that resolves after this
   * destroys its own model instead of joining a collection that is gone. That
   * second half is the part the collection cannot do for us — it can only
   * destroy what it already holds.
   */
  dispose(): void {
    this.disposed = true;
    this.generation++; // orphan every in-flight load
    this.scene.primitives.remove(this.collection);
    this.models.clear();
    this.entries = [];
  }

  /**
   * Start (or fail) one track's glTF. Rejections are absorbed into
   * `modelErrors`: a 404 on one category must not take down the frame loop, and
   * an unhandled rejection here would be a crash in a host that treats them as
   * fatal.
   */
  private startLoad(entry: MeshEntry, gen: number): void {
    const req: MeshModelRequest = {
      url: entry.mesh.modelUrl,
      modelMatrix: entry.matrix,
      color: new Color(entry.mesh.r, entry.mesh.g, entry.mesh.b, 0),
      id: entry.id,
      colorBlendMode: this.colorBlendMode,
      colorBlendAmount: this.colorBlendAmount,
      backFaceCulling: this.backFaceCulling,
    };
    const p = this.loadModel(req).then(
      (model) => {
        this.attachModel(entry, model, gen);
      },
      () => {
        this.modelErrors++;
      },
    );
    this.pending.push(p);
  }

  /**
   * Adopt a resolved model, or destroy it if the world moved on while it loaded.
   *
   * The model is re-pointed at the entry's own `Matrix4` (Cesium's constructor
   * cloned the one it was handed, so identity has to be re-established here),
   * then given the current frame's appearance immediately rather than waiting
   * for the next `setTime` — a paused clock short-circuits `setTime`, so a model
   * that arrives during a pause would otherwise stay invisible until the user
   * scrubbed.
   */
  private attachModel(entry: MeshEntry, model: Model, gen: number): void {
    if (this.disposed || gen !== this.generation) {
      // Stale: this model belongs to a pool that no longer exists. The
      // collection never held it, so nothing else will ever destroy it.
      model.destroy();
      return;
    }
    model.modelMatrix = entry.matrix;
    model.id = entry.id;
    entry.model = model;
    entry.lastAlpha = Number.NaN; // a fresh model has written nothing yet
    this.models.set(entry.modelKey, model);
    this.collection.add(model);
    this.writeAppearance(entry);
    this.requestRender();
  }

  /**
   * Push one entry's alpha to its model, skipping when nothing changed.
   *
   * A hidden model gets `show = false` and NO colour write: the write would be
   * invisible and, crossing the translucency boundary, would cost a
   * `resetDrawCommands()`. `lastAlpha` still advances, so re-entering the window
   * writes the real colour again.
   */
  private writeAppearance(entry: MeshEntry): void {
    const model = entry.model;
    if (!model) return; // still loading, failed, or no URL — pose is kept anyway
    const s = entry.sample;
    const alpha = s ? entry.mesh.a * s.alpha * this.opacity : 0;
    if (alpha === entry.lastAlpha) return;
    entry.lastAlpha = alpha;
    model.show = alpha > 0;
    if (alpha <= 0) return;
    const c = SCRATCH_COLOR;
    c.red = entry.mesh.r;
    c.green = entry.mesh.g;
    c.blue = entry.mesh.b;
    c.alpha = alpha;
    model.color = c; // setter clones the scratch into the model's own _color
  }

  /**
   * Nudge a `requestRenderMode` scene after an out-of-band change (a model
   * arriving between frames). Guarded rather than called outright because the
   * only thing this layer is promised is a `Scene`-shaped primitives host.
   */
  private requestRender(): void {
    const scene = this.scene as { requestRender?: () => void };
    if (typeof scene.requestRender === 'function') scene.requestRender();
  }
}
