// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTBoundingBoxLayer` — ONE oriented 3-D cuboid per TRACKED OBJECT at the
 * playhead, the Cesium analogue of deck's `AnimatedBoundingBoxLayer` and three's
 * `STTBoundingBoxLayer`. This is the AV cockpit's detection-box layer: nuScenes
 * / Argoverse / Waymo `objects/` archives carry one POINT feature per tracked
 * object PER KEYFRAME (`track_id`, `category`, `heading`, `length`/`width`/
 * `height`, `speed`, timestamped), and the job is to turn that pile of snapshots
 * back into a small set of smoothly-moving boxes.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO: TIME-WINDOW FILTERING ──────────────────
 * Every other animated layer in this package resolves a per-feature alpha from
 * `core/time-filter`'s oracle and writes it into a Cesium colour. This layer
 * must not, and the reason is structural rather than stylistic: with one feature
 * PER KEYFRAME, a window spanning N keyframes of one object draws N boxes for
 * it — the "train of boxes" the deck layer was rewritten to kill. So there is no
 * `mode`, no `timeFilter`, and no `timeFilterAlpha` call anywhere on this path.
 * Instead `lib/tracked-boxes.ts` pools every resident tile's snapshots by
 * `track_id` into `@poopdeck.gl/core`'s track kernel — which rebases each
 * keyframe to ABSOLUTE epoch-ms, so keyframes from tiles with different
 * `timeOffset`s join ONE timeline — and `setTime` emits exactly one interpolated
 * instance per ACTIVE track. Visibility is implicit: `sampleTrack` returns
 * `null` outside a track's keyframe span and the box is simply not shown.
 *
 * That makes this file an `EXEMPT_SETTIME` case for
 * `test/time-filter-oracle.test.ts` — it animates POSE, not alpha, alongside
 * `STTTripsLayer` (geometry trim) and `STTTripHeadsLayer` (position lerp). The
 * ONE alpha here is the kernel's appear/disappear FADE (`Sample.alpha`), a
 * playhead-time ramp at each track's own ends, which is not a time filter and
 * does not run through the oracle. Heading interpolation is SHORTEST-ARC
 * (`lerpAngle`, delta normalized into (-π, π]) so a box crossing the ±π seam
 * turns the short way — the kernel's, not a local copy.
 *
 * ── WHY ONE `Primitive` PER TRACK, AND WHAT THAT COSTS ───────────────────────
 * A `Primitive` COMBINES its geometry instances into one vertex buffer at batch
 * time, baking each `GeometryInstance.modelMatrix` into the vertices as it goes:
 * after that the per-instance transform no longer exists, and the only writable
 * transform is `Primitive.modelMatrix`, which moves EVERY instance in the
 * primitive together. A box pose changes every frame, so a single batched
 * primitive over all tracks could only be re-posed by rebuilding (and
 * re-uploading) the whole vertex buffer per frame.
 *
 * So this layer holds a `PrimitiveCollection` of one single-instance `Primitive`
 * per track and writes that primitive's `modelMatrix` each frame. Per-frame work
 * is then O(active tracks) — a handful of doubles each, no buffer traffic — which
 * is the right shape for AV scenes carrying tens of objects.
 *
 * The price, stated plainly: ONE DRAW CALL PER TRACK, versus the one bucket the
 * batched polyline layer gets. Tens of draw calls is nothing; tens of THOUSANDS
 * would be, so this layer is for tracked-object archives and not a general
 * per-feature box renderer. Two smaller costs ride along — the kernel's
 * `sampleTrack` allocates one small `Sample` per active track per frame (forking
 * it to avoid that would reintroduce exactly the CPU-logic drift the shared
 * kernel exists to prevent), and `Primitive.modelMatrix` is 3-D-SCENE ONLY:
 * Cesium throws `"Primitive.modelMatrix is only supported in 3D mode"` if a
 * non-identity matrix reaches a 2D/Columbus-view frame. The AV cockpit is a 3-D
 * globe scene; a caller who morphs the scene to 2D must drop this layer.
 *
 * ── THE ALIASING TRAP (why each entry owns its own `Matrix4`) ────────────────
 * The package's per-frame idiom is one shared module-level scratch per mutable
 * Cesium type, which is safe for `PointPrimitive.color` and for batch-table
 * colours because those SETTERS COPY the value out. `Primitive.modelMatrix` is a
 * PLAIN FIELD with no setter: assigning one shared scratch to every primitive
 * would leave them all referencing the same object, and the last write of the
 * frame would pose every box. Each entry therefore owns a `Matrix4` that is
 * assigned once and MUTATED IN PLACE afterwards — Cesium keeps its own
 * `_modelMatrix` copy and diffs against it with `Matrix4.equals`, so in-place
 * mutation still dirties correctly. The only shared scratch here is the plain
 * `number[]` the pure builder writes into.
 *
 * ── DOCUMENTED DEVIATIONS FROM DECK ──────────────────────────────────────────
 * 1. deck can draw FILLED and STROKED simultaneously (a lit `SimpleMeshLayer`
 *    plus a 12-edge `LineLayer`). Cesium's box comes as either `BoxGeometry` or
 *    `BoxOutlineGeometry`, so `outline` here is an exclusive CHOICE, not an
 *    additive one. Default is filled, matching deck's `filled: true`.
 * 2. No `showLabels` / `showVelocity` sublayers. deck rides a `TextLayer` and a
 *    velocity `LineLayer` alongside the boxes; `text` is not a kind this backend
 *    renders yet, and a velocity arrow belongs with it rather than bolted on
 *    here. Not approximated — absent, and said so.
 * 3. Colour is a per-TRACK constant baked by the kernel from the track's
 *    `category`, so `lib/feature-color.ts`'s constant/categorical/ramp
 *    trichotomy does not apply: a track is not a feature, and a ramp over "the
 *    feature's numeric column" has no single value once snapshots are pooled.
 *    The categorical arm survives as `colorProperty` + `colorMapping`, which is
 *    what deck and three expose for this layer too.
 *
 * Rendering needs a live Cesium `Scene`, so the drawn result is browser-verify
 * only; the pooling, the pose maths and the update path are unit-tested against
 * real Cesium objects under Node (`test/cesium-bounding-box-layer.test.ts`).
 */

import {
  BoxGeometry,
  BoxOutlineGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
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
  buildTrackedBoxes,
  trackedBoxSampleConfig,
  writeBoxModelMatrix,
  type TrackedBox,
  type TrackedBoxBuildOptions,
  type TrackedBoxSampleOptions,
} from './lib/tracked-boxes.js';

export interface STTBoundingBoxLayerOptions
  extends TrackedBoxBuildOptions, TrackedBoxSampleOptions {
  id?: string;
  /** Uniform multiplier on every box dimension. @default 1 */
  sizeScale?: number;
  /**
   * Draw 12-edge cuboid OUTLINES (`BoxOutlineGeometry`) instead of solid lit
   * boxes — the streetscape.gl / nuScenes look you can see the LiDAR through.
   * Exclusive with the filled look; see deviation 1 in the file header.
   * @default false
   */
  outline?: boolean;
  /**
   * Extra multiplier on every box's alpha (0..1), on top of the category colour
   * and the kernel's appear/disappear fade. @default 1
   */
  opacity?: number;
}

/**
 * Pick/attribute identity for one track's box. `layerId`/`binary`/`featureIndex`
 * are the package-wide pick shape; `trackId` rides along because a tracked
 * object, unlike a feature, HAS an identity worth reporting and because
 * `binary` is null for a track with no resolvable id.
 */
interface BoxInstanceId {
  layerId: string;
  binary: BinaryFeatures | null;
  featureIndex: number;
  trackId: string;
}

interface BoxEntry {
  prim: Primitive;
  id: BoxInstanceId;
  /**
   * This entry's OWN model matrix, assigned to `prim.modelMatrix` once and
   * mutated in place every frame. Never a shared scratch — see the header.
   */
  matrix: Matrix4;
  box: TrackedBox;
  /** Last alpha written; NaN so the first frame always writes. */
  lastAlpha: number;
  /** Batch-table colour handle; cached on the first ready frame. */
  attrs: { color: Uint8Array } | null;
  /** Most recent interpolated pose, or null while the track is inactive. */
  sample: Sample | null;
}

/**
 * The unit cuboid every instance is a transform of: `fromDimensions((1,1,1))`
 * spans ±0.5 on each axis, so the model matrix's column magnitudes ARE the box's
 * metric length/width/height.
 */
const UNIT_BOX_DIMENSIONS = new Cartesian3(1, 1, 1);

/**
 * Shared per-frame scratches. Both are consumed synchronously by the write that
 * follows them, and neither is ever handed to Cesium to keep: the column-major
 * buffer is copied by `Matrix4.fromColumnMajorArray` into the entry's own
 * matrix, and the batch-table colour setter copies its four bytes immediately.
 */
const SCRATCH_M16: number[] = new Array(MATRIX4_LENGTH).fill(0);
const SCRATCH_RGBA = new Uint8Array(4);

export class STTBoundingBoxLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PrimitiveCollection;
  private readonly opts: STTBoundingBoxLayerOptions;
  private readonly sampleCfg: TrackSampleConfig;
  private readonly sizeScale: number;
  private readonly opacity: number;
  /** Shared across every track's primitive; holds no GPU resource of its own. */
  private readonly appearance: PerInstanceColorAppearance;
  /** Shared immutable geometry DESCRIPTION; each Primitive builds its own mesh. */
  private readonly geometry: BoxGeometry | BoxOutlineGeometry;

  private entries: BoxEntry[] = [];
  private timeOrigin = 0;
  /** Playhead of the last resample; a repeated `setTime` is a no-op. */
  private lastSampledTime = Number.NaN;

  /**
   * True when the most recent `setTiles` saw a tile with NO track-id column.
   * Those snapshots cannot be grouped, so each is drawn as its own HELD
   * singleton box with no interpolation. Surfaced as a field rather than a
   * console warning because nothing else in this package logs; a host that wants
   * to tell the user reads it after `setTiles`.
   */
  trackIdMissing = false;

  constructor(scene: Scene, options: STTBoundingBoxLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-boxes';
    this.scene = scene;
    this.opts = options;
    this.sizeScale = options.sizeScale ?? 1;
    this.opacity = options.opacity ?? 1;
    this.sampleCfg = trackedBoxSampleConfig(options);
    const outline = options.outline ?? false;
    this.geometry = outline
      ? BoxOutlineGeometry.fromDimensions({ dimensions: UNIT_BOX_DIMENSIONS })
      : BoxGeometry.fromDimensions({
          dimensions: UNIT_BOX_DIMENSIONS,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        });
    this.appearance = new PerInstanceColorAppearance({
      translucent: true,
      // An outline has no normals to light; a solid box is closed, so backface
      // culling is both correct and cheaper.
      flat: outline,
      closed: !outline,
    });
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /**
   * (Re)build one box per tracked object from decoded tiles.
   *
   * Build BEFORE the teardown, and bail on an empty result while the old
   * primitives are still standing. Selection reports an empty visible set for
   * the frames between a viewport change and the first decoded tile of the new
   * set; tearing down first turns that transient into a blank frame (the "tiles
   * genuinely in view flash out" symptom). Holding the previous boxes is safe
   * even when the emptiness is permanent: they sit at their true ECEF positions,
   * which the camera has by then left behind.
   */
  setTiles(tiles: Tile[]): void {
    const build = buildTrackedBoxes(tiles, this.opts);
    if (build.boxes.length === 0) return; // also leaves the prior timeOrigin untouched
    this.collection.removeAll(); // destroys the previous primitives
    this.entries = [];
    this.timeOrigin = build.timeOrigin;
    this.trackIdMissing = build.trackIdMissing;
    // New tracks: the next setTime must resample even at the same playhead.
    this.lastSampledTime = Number.NaN;

    for (const box of build.boxes) {
      const id: BoxInstanceId = {
        layerId: this.id,
        binary: box.binary,
        featureIndex: box.featureIndex,
        trackId: box.track.trackId || box.key,
      };
      const prim = new Primitive({
        geometryInstances: new GeometryInstance({
          geometry: this.geometry,
          // Seed fully transparent; the first setTime writes the real alpha.
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(
              new Color(box.r / 255, box.g / 255, box.b / 255, 0),
            ),
          },
          id,
        }),
        appearance: this.appearance,
        // Nothing is posed until the first setTime, so nothing may draw yet.
        show: false,
        // Deterministic replace-all; a unit cuboid needs no worker round-trip.
        asynchronous: false,
      });
      this.collection.add(prim);
      this.entries.push({
        prim,
        id,
        // `Primitive` allocates its OWN identity `modelMatrix` in the
        // constructor (it clones whatever it is given). Adopting that object as
        // this entry's matrix is what makes the per-frame in-place mutation
        // land on the primitive with no assignment and no aliasing.
        matrix: prim.modelMatrix,
        box,
        lastAlpha: Number.NaN, // NaN !== anything → force the first write
        attrs: null,
        sample: null,
      });
    }
  }

  /**
   * Advance to an absolute playhead time: interpolate ONE pose per ACTIVE track
   * and rewrite that track's model matrix.
   *
   * The rebase against `timeOrigin` is spelled the way every layer here spells
   * it, and is the IDENTITY on this path — the track kernel pools keyframes to
   * absolute epoch-ms, so `buildTrackedBoxes` reports an origin of 0 (see
   * `TrackedBoxBuild.timeOrigin`).
   *
   * Pose is rewritten unconditionally for an active track because it genuinely
   * changes every frame. COLOUR is not: it only moves when the appear/disappear
   * fade is ramping, so it is guarded by the same `lastAlpha` skip the other
   * layers use, and a box sitting at full opacity costs one compare rather than
   * a batch-table write and a GPU dirty. `lastAlpha` advances only once the
   * write actually lands — the batch table exists solely after the primitive's
   * first render, so an early frame must not record a write it could not make.
   */
  setTime(absoluteMs: number): void {
    const now = absoluteMs - this.timeOrigin;
    // A paused clock still renders every frame; resampling every track for a
    // playhead that did not move is pure waste.
    if (now === this.lastSampledTime) return;
    this.lastSampledTime = now;

    const cfg = this.sampleCfg;
    const scale = this.sizeScale;
    const v = SCRATCH_RGBA;
    for (const e of this.entries) {
      const s = sampleTrack(e.box.track, now, cfg);
      if (!s) {
        // Inactive: not emitted at all. No alpha, no pose, no draw.
        e.sample = null;
        if (e.lastAlpha !== 0) {
          e.lastAlpha = 0;
          e.prim.show = false;
        }
        continue;
      }
      e.sample = s;
      writeBoxModelMatrix(SCRATCH_M16, s, scale);
      Matrix4.fromColumnMajorArray(SCRATCH_M16, e.matrix); // copies into the entry's own matrix

      const alpha = e.box.a * s.alpha * this.opacity;
      if (alpha === e.lastAlpha) continue;
      e.prim.show = alpha > 0;
      if (!e.attrs) {
        if (!e.prim.ready) continue; // batch table exists only after the first render
        e.attrs = e.prim.getGeometryInstanceAttributes(e.id) as {
          color: Uint8Array;
        };
      }
      e.lastAlpha = alpha;
      v[0] = e.box.r;
      v[1] = e.box.g;
      v[2] = e.box.b;
      v[3] = Math.round(alpha * 255);
      e.attrs.color = v; // setter copies the bytes into the batch table
    }
  }

  /**
   * Hit-test → the shared `SttPickResult`.
   *
   * `object` is the archive's own decoded columns for the track's first pooled
   * keyframe, which is where its immutable per-object facts (`track_id`,
   * `category`, nominal dims) live; the box's LIVE state at the playhead —
   * interpolated heading, dims, speed — goes in `meta` via the kernel's
   * `makePickRow`, which is the AV inspector's shape. A track with no resolvable
   * id has no feature to join to, so it reports `object: null`, `index: -1` and
   * `meta` alone. `coordinate` is the interpolated pose, not the first keyframe:
   * it is where the user actually clicked.
   */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: BoxInstanceId }
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
   * Remove (and, through `PrimitiveCollection`'s own `destroyPrimitives`,
   * destroy) every per-track primitive. There is no externally-supplied GPU
   * resource to release on top of that: the shared `PerInstanceColorAppearance`
   * is a shader-source + render-state description, and the compiled program that
   * actually lives on the GPU belongs to each `Primitive` and dies with it —
   * unlike `STTTripsLayer`, whose `Material`s `PolylineCollection.removeAll()`
   * would leak.
   */
  dispose(): void {
    this.scene.primitives.remove(this.collection);
    this.entries = [];
  }
}
