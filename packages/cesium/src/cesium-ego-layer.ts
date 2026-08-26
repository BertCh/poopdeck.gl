// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTEgoLayer` — the EGO-VEHICLE marker for the AV cockpit on a real globe.
 *
 * WHAT IT RENDERS. One cuboid. Exactly one, forever, no matter how many
 * keyframes the archive holds. An ego archive is a single-track pose stream —
 * one POINT feature per timestamp carrying the vehicle's own pose (`lon,lat,alt`
 * plus a heading column, and where the producer wrote them the vehicle's own
 * L×W×H). Every one of those samples is a KEYFRAME, not a feature to draw. The
 * layer pools them into one time-sorted array at `setTiles`, and each frame
 * binary-searches the bracketing pair, lerps position, SHORTEST-ARC-lerps
 * heading, and writes ONE `Matrix4` onto ONE `Primitive`.
 *
 * WHY IT EXISTS. The deck backend has NO ego layer at all — the showcase
 * cockpit fakes one with a bespoke `ScatterplotLayer`/icon per route. This is
 * the gap this file closes, and `packages/three/src/layers/ego-layer.ts` is the
 * behavioural reference it matches (same default box, same heading convention,
 * same clamp-at-the-ends sampling).
 *
 * THE MODEL MATRIX IS THE WHOLE TRICK. Cesium's world frame is ECEF: +Z is the
 * spin axis, +X pierces the Gulf of Guinea. A box built at the origin and
 * merely TRANSLATED to the vehicle's ECEF position stands up along the ECEF
 * pole — which is only "up" at the equator and is visibly, comically wrong
 * anywhere else (in Zurich it leans ~47°, and the heading rotation lands on a
 * meaningless axis). So the matrix is composed, in order:
 *
 *     enu   = Transforms.eastNorthUpToFixedFrame(ecef)   // local x=E, y=N, z=Up
 *     local = fromRotationTranslation(rotZ(heading), (0, 0, height/2 + zLift))
 *     model = enu × local
 *
 * `rotZ` is about LOCAL up, so heading means what it says; the +height/2 lift
 * puts the box's base on the ground plane instead of burying half the car.
 * Heading is radians CCW-from-east (see `lib/ego-pose.ts`), which is exactly
 * the ENU frame's own convention — no sign flip, no bearing conversion at
 * render time.
 *
 * PER-FRAME COST. A binary search plus a lerp — O(log N) in keyframes, plus a
 * fixed handful of `Matrix3`/`Matrix4` writes into MODULE-LEVEL scratch
 * objects. Zero allocation, zero geometry rebuild, one draw call. And the frame
 * is skipped outright when the clamped sample time is unchanged since the last
 * one (`lastSampleMs`, NaN-initialised so the first frame always writes) — a
 * paused playhead, or a playhead parked past the end of the track, costs one
 * float compare.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — documented deviations, not silent ones:
 *
 *  - NO TRAIL. three's ego layer also draws the full trajectory as a static
 *    line; this one draws the marker only. On a globe the ego trail is the job
 *    of `STTPathLayer`/`STTTripsLayer` pointed at the same archive, which
 *    already own batching, trimming and the trail fade. Duplicating it here
 *    would mean a second primitive whose vertex count grows with the archive,
 *    against the one-instance guarantee above.
 *  - NO ALPHA, NO TIME FILTER. This layer animates a POSE, not an opacity, so
 *    it does not call `timeFilterAlpha` and is an `EXEMPT_SETTIME` case in
 *    `test/time-filter-oracle.test.ts` — the same carve-out `STTTripsLayer`
 *    (geometry trim) and `STTTripHeadsLayer` (position lerp) already have.
 *    `window`/`wake`/`cumulative`/`trail` are meaningless for a marker that is
 *    defined to be at the playhead: the ego is never "faded out", it is either
 *    on screen at its pose or the track has not loaded.
 *  - NO PER-FEATURE COLOUR. `lib/feature-color.ts`'s constant/categorical/ramp
 *    trichotomy resolves a colour PER FEATURE; there is one marker here, so a
 *    ramp over a single-track pose stream has nothing to vary across. The
 *    marker takes one `markerColor`, resolved once at construction.
 *  - NO CAMERA. The pose is exposed via {@link STTEgoLayer.getEgoPose} so a
 *    caller can drive a follow camera; the layer never touches
 *    `scene.camera` itself (package rule 4).
 */

import {
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveCollection,
  Transforms,
  defined,
  type Scene,
} from 'cesium';
import { getFeatureProperties, type Tile } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  buildEgoTrack,
  sampleEgoPose,
  type EgoBuildOptions,
  type EgoPose,
  type EgoTrack,
} from './lib/ego-pose.js';

export interface STTEgoLayerOptions extends EgoBuildOptions {
  id?: string;
  /** Marker colour (0–255). @default a cyan cockpit accent at ~78% alpha */
  markerColor?: RGBA255;
  /** Metres to lift the box above the sampled altitude, to beat z-fighting
   *  against a ground mesh or terrain tile. @default 0.05 */
  zLift?: number;
  /**
   * What to do when the playhead falls outside the track's time span.
   * - `'clamp'` (default) — park the marker at the first/last pose. The AV
   *   cockpit wants this: a follow camera targeting a vanished pose snaps to
   *   the globe origin.
   * - `'hide'` — hide the marker entirely outside the span.
   * @default 'clamp'
   */
  outsideRange?: 'clamp' | 'hide';
}

/** Same accent the three cockpit uses for the ego marker. */
const DEFAULT_MARKER: RGBA255 = [120, 230, 255, 200];

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum
// matters). Byte-identical to the point/polyline builders' GLOBE; `project` is
// anchor-independent, so the module-level singleton is safe to share. The
// explicit `{ datum: 'wgs84' }` is load-bearing: the class default is
// 'sphere', which mis-registers against Cesium's real ellipsoid by up to ~20 km
// at mid-latitudes — and here that error would also tilt the ENU frame, so the
// car would be both in the wrong place AND pointing the wrong way.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

// Reused for every per-frame pose write so setTime allocates nothing. Safe for
// the same reason the point layer's SCRATCH_COLOR is: JS is single-threaded and
// setTime runs synchronously to completion. They must stay DISTINCT from the
// primitive's own `modelMatrix`, which is why the final multiply writes INTO
// that matrix rather than assigning a scratch to it: `Primitive.modelMatrix` is
// a plain field, so assigning the shared scratch would alias every layer
// instance's matrix to the same object — and Cesium's dirty check
// (`Matrix4.equals(modelMatrix, _modelMatrix)`) still fires correctly on an
// in-place rewrite, because `_modelMatrix` is its own private clone.
const SCRATCH_ECEF = new Cartesian3();
const SCRATCH_ENU = new Matrix4();
const SCRATCH_LOCAL = new Matrix4();
const SCRATCH_ROT = new Matrix3();
const SCRATCH_OFFSET = new Cartesian3();

export class STTEgoLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly opts: STTEgoLayerOptions;
  private readonly collection: PrimitiveCollection;
  private readonly appearance: PerInstanceColorAppearance;
  private readonly markerColor: Color;
  private readonly zLift: number;
  private readonly outsideRange: 'clamp' | 'hide';

  private track: EgoTrack | null = null;
  private timeOrigin = 0;
  private primitive: Primitive | null = null;
  /** Mutated in place each frame; `scene.pick` hands this very object back. */
  private pickId: {
    layerId: string;
    binary: BinaryFeatures | null;
    featureIndex: number;
  };
  private pose: EgoPose | null = null;
  /**
   * The ego's analogue of the per-entry `lastAlpha` guard: the clamped sample
   * time last written to the model matrix. NaN-initialised so the first
   * `setTime` always writes (`NaN !== anything`); a paused or past-the-end
   * playhead then costs a single compare instead of a matrix rebuild plus a
   * `Primitive` dirty.
   */
  private lastSampleMs = NaN;

  constructor(scene: Scene, options: STTEgoLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-ego';
    this.scene = scene;
    this.opts = options;
    this.zLift = options.zLift ?? 0.05;
    this.outsideRange = options.outsideRange ?? 'clamp';
    const [r, g, b, a] = options.markerColor ?? DEFAULT_MARKER;
    this.markerColor = new Color(r / 255, g / 255, b / 255, (a ?? 255) / 255);
    // Built once and reused across every rebuild — a Primitive does not own or
    // destroy its appearance, so re-creating one per setTiles would churn a
    // shader program for nothing.
    this.appearance = new PerInstanceColorAppearance({
      flat: true,
      translucent: this.markerColor.alpha < 1,
      closed: true,
    });
    this.pickId = { layerId: this.id, binary: null, featureIndex: 0 };
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /**
   * (Re)build the ego track from decoded tiles. All pose maths lives in the
   * Cesium-free `lib/ego-pose.ts`; this method only turns the vehicle's box
   * into ONE `GeometryInstance` on ONE `Primitive`.
   */
  setTiles(tiles: Tile[]): void {
    const track = buildEgoTrack(tiles, this.opts);
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitive is still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the
    // new set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous marker
    // is safe even when the emptiness is permanent: it sits at its true ECEF
    // pose, which the camera has by then left behind. It matters more here than
    // anywhere else in the package, because the ego marker IS the cockpit's
    // spatial anchor — one blank frame reads as the car teleporting.
    if (track.keyframes.length === 0) return; // also leaves the prior timeOrigin untouched

    const rebuildGeometry =
      this.primitive === null || !sameBox(this.track, track);

    this.track = track;
    this.timeOrigin = track.timeOrigin;
    this.lastSampleMs = NaN; // new origin ⇒ the cached sample time is meaningless

    // The box geometry is a constant of the VEHICLE, not of the tile set, so a
    // pan that swaps every tile still reuses the same Primitive. Only a genuine
    // change of dimensions (a different archive) pays for a rebuild.
    if (rebuildGeometry) {
      this.destroyPrimitive();
      const [length, width, height] = track.dimensions;
      this.primitive = new Primitive({
        geometryInstances: new GeometryInstance({
          geometry: BoxGeometry.fromDimensions({
            vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
            dimensions: new Cartesian3(length, width, height),
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(this.markerColor),
          },
          // One id object, mutated by setTime to name the keyframe under the
          // playhead — so a click on the car reports the pose sample it is
          // actually standing on, not the first one in the archive.
          id: this.pickId,
        }),
        appearance: this.appearance,
        asynchronous: false, // one 12-triangle box; a worker round-trip would
        // leave the cockpit's anchor missing for several frames
        allowPicking: true,
      });
      this.primitive.show = false; // until setTime samples a pose
      this.collection.add(this.primitive);
    }
  }

  /**
   * Advance to an absolute playhead time: sample the pose and rewrite the
   * marker's model matrix. No alpha, no time filter — see the file header.
   */
  setTime(absoluteMs: number): void {
    const prim = this.primitive;
    const track = this.track;
    if (!prim || !track) return;

    const cur = absoluteMs - this.timeOrigin;
    const pose = sampleEgoPose(track, cur);
    if (!pose) {
      prim.show = false;
      return;
    }

    // `sampleEgoPose` clamps, so `pose.t !== cur` is exactly "outside the span".
    if (this.outsideRange === 'hide' && pose.t !== cur) {
      prim.show = false;
      this.pose = null;
      this.lastSampleMs = NaN; // force a rewrite when the playhead comes back
      return;
    }

    prim.show = true;
    if (pose.t === this.lastSampleMs) return; // same sample as last frame
    this.lastSampleMs = pose.t;
    this.pose = pose;
    this.pickId.binary = pose.binary;
    this.pickId.featureIndex = pose.featureIndex;

    const [x, y, z] = GLOBE.project(pose.lon, pose.lat, pose.alt);
    SCRATCH_ECEF.x = x;
    SCRATCH_ECEF.y = y;
    SCRATCH_ECEF.z = z;

    // Local east-north-up at the vehicle, then heading about LOCAL up. Without
    // the ENU frame the box would stand along the ECEF spin axis (see header).
    Transforms.eastNorthUpToFixedFrame(SCRATCH_ECEF, undefined, SCRATCH_ENU);
    Matrix3.fromRotationZ(pose.heading, SCRATCH_ROT);
    SCRATCH_OFFSET.x = 0;
    SCRATCH_OFFSET.y = 0;
    SCRATCH_OFFSET.z = track.dimensions[2] / 2 + this.zLift; // base on the ground
    Matrix4.fromRotationTranslation(SCRATCH_ROT, SCRATCH_OFFSET, SCRATCH_LOCAL);
    // Written IN PLACE into the primitive's own matrix — never assigned from a
    // module-level scratch, which would alias two layers together.
    Matrix4.multiply(SCRATCH_ENU, SCRATCH_LOCAL, prim.modelMatrix);
  }

  /**
   * The pose under the playhead as of the last {@link setTime}, or `null`.
   * The follow-camera hook: a caller reads this and drives its own camera —
   * this layer never does (package rule 4).
   */
  getEgoPose(): EgoPose | null {
    return this.pose;
  }

  /** Hit-test → the shared `SttPickResult` (props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | {
          id?: {
            layerId: string;
            binary: BinaryFeatures | null;
            featureIndex: number;
          };
        }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const { binary, featureIndex } = picked.id;
    const pose = this.pose;
    return {
      object: binary ? getFeatureProperties(binary, featureIndex) : {},
      index: featureIndex,
      layerId: this.id,
      // The interpolated pose, not the keyframe's own lon/lat — the marker the
      // user clicked is at the interpolated position, so that is what a tooltip
      // must anchor to.
      coordinate: pose ? [pose.lon, pose.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    // `PrimitiveCollection.remove` destroys what it holds only while
    // `destroyPrimitives` is true, and a host may have flipped that on the
    // scene's own collection. Destroy the box's vertex arrays explicitly first
    // so the GPU buffers go regardless.
    this.destroyPrimitive();
    this.scene.primitives.remove(this.collection);
    this.track = null;
    this.pose = null;
    this.lastSampleMs = NaN;
  }

  private destroyPrimitive(): void {
    const prim = this.primitive;
    this.primitive = null;
    if (!prim) return;
    this.collection.remove(prim);
    if (typeof prim.isDestroyed === 'function' && !prim.isDestroyed()) {
      prim.destroy();
    }
  }
}

/** Do two builds describe the same vehicle box? (Geometry rebuild predicate.) */
function sameBox(prev: EgoTrack | null, next: EgoTrack): boolean {
  if (!prev) return false;
  return (
    prev.dimensions[0] === next.dimensions[0] &&
    prev.dimensions[1] === next.dimensions[1] &&
    prev.dimensions[2] === next.dimensions[2]
  );
}
