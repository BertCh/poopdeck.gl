// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The `flowStroke` kind for CesiumJS: an origin-destination corridor network
 * drawn as TWIN RIBBONS whose WIDTH breathes with the playhead.
 *
 * ## What it renders
 * A flow tile carries a per-vertex x per-time-bucket volume matrix
 * (`vertexValueMatrix`, `vertexValueBuckets` columns). The sibling
 * `flowCorridor` kind animates COLOUR from that matrix; `flowStroke` adds the
 * two things that turn a corridor map into a legible flow map:
 *
 *  1. **Width per corridor.** Every frame (sub-step gated, see below) the
 *     corridor's BUSIEST vertex is resolved AT the blended bucket and raised to
 *     `widthExponent` (default `0.5` — sqrt, so drawn AREA is proportional to
 *     volume, the cartographic convention). A corridor whose peak sits at or
 *     below `minFlow` collapses to width 0 and is hidden outright: that
 *     "inactive => invisible" step is the per-hour PULSE, the thing that makes a
 *     commute visible as a wave sweeping across the network rather than as a
 *     static lattice that merely changes hue.
 *  2. **A twin-ribbon offset.** `A->B` and `B->A` are separate corridors that
 *     traverse the same street in OPPOSITE vertex order, so a CONSTANT signed
 *     perpendicular offset lands them on opposite sides of the centreline with
 *     no pairing logic at all — reversing the vertices flips the tangent, which
 *     flips the left normal, which flips the shift. One ribbon fat while its
 *     twin is thin IS the direction of the flow.
 *
 * All of that maths — the blend, the `max`-of-the-blend reduction, the width
 * curve, and the east-north-up perpendicular hop — lives in the pure,
 * Cesium-free {@link ../lib/flow-strokes.js}. This file only owns Cesium
 * objects and the per-frame writes.
 *
 * ## Why `PolylineCollection` and what it costs
 * A `PolylineGeometry`'s width is BAKED INTO ITS VERTICES at tessellation time,
 * so the batched-`Primitive` path that `STTPathLayer`/`STTArcLayer` use (a
 * single draw bucket, colour animated through the batch table) cannot animate
 * width at all — every frame would have to re-tessellate and re-upload the whole
 * network. `PolylineCollection` is the right fit instead, and for a precise
 * reason: Cesium keeps a polyline's `width` and `show` in the collection's
 * BATCH TABLE (`setBatchedAttribute(index, 0, Cartesian2(width, show))`), so a
 * per-frame width write is a few bytes into a batch texture, NOT a geometry
 * rebuild. Positions are uploaded once and never touched again.
 *
 * The cost, stated plainly: colour has to come from each polyline's own `Color`
 * MATERIAL, and `PolylineCollection` emits a new `DrawCommand` whenever the
 * material changes between consecutive polylines. Per-corridor alpha animation
 * therefore means per-corridor materials, which means ONE DRAW CALL PER
 * CORRIDOR — where `STTTripsLayer` deliberately shares materials keyed by RGBA
 * so same-colour trips batch. A flow network is hundreds of corridors, not
 * hundreds of thousands of features, so that trade buys animated width for a
 * draw-call count a street network can afford. It would NOT be an acceptable
 * trade for a point cloud, and this kind should not be reached for as a generic
 * polyline renderer.
 *
 * The corollary is the one place this layer breaks the package's scratch-object
 * rule on purpose. `STTPointLayer` writes a shared scratch `Color` through
 * `pointPrimitive.color =` because that setter clones and value-compares. A
 * material uniform has no setter and no dirty check: the collection's uniform
 * map closes over `material.uniforms.color` and reads it live at draw time. So
 * alpha is mutated IN PLACE on each polyline's own uniform — assigning a shared
 * scratch object there would alias every corridor to one colour. Documented,
 * not accidental.
 *
 * ## Deliberate non-goals (documented deviations from deck, not silent ones)
 * - **No per-vertex width taper.** deck can width each vertex from its own
 *   volume; a Cesium polyline has ONE scalar width, so the taper collapses to
 *   the busiest vertex. A corridor that is busy at one end and empty at the
 *   other draws at its busy width along its whole length.
 * - **The offset is BAKED in world metres at a reference width.** deck applies
 *   `getOffset` in the shader in width units, so its ribbons re-separate every
 *   frame as the width breathes. There is no screen-space vertex offset on a
 *   Cesium polyline, so re-separating would mean re-uploading geometry every
 *   frame. The builder instead sizes the shift ONCE from the corridor's
 *   ALL-BUCKET peak (its rush-hour width) via `offsetMetersPerPixel`. The gap is
 *   then constant in world space: correct at the reference zoom, and the twins
 *   neither overlap at the busy hour nor drift apart at the quiet one.
 * - **No per-vertex colour.** Package-wide: colour is one value per feature, so
 *   an OD gradient collapses to the corridor's colour.
 * - **Widths recompute on a sub-step, alpha every frame.** The `max`-over-
 *   vertices reduction is O(vertices); `flowStrokeSubStep` gates it to twice per
 *   bucket (deck's `FlowCorridorLayer.STEP`), which is finer than the eye reads
 *   an hourly pulse. The time-filter alpha is O(1) and stays per-frame.
 *
 * ## Frames
 * Positions are ABSOLUTE f64 ECEF metres straight from
 * `GlobeProjection({datum:'wgs84'})` — no RTC, because `Cartesian3` is CPU
 * doubles and there is no f32 buffer to protect. No model matrix is used
 * anywhere, so there is no rotation to get wrong; the only local-frame work is
 * the perpendicular hop, and the builder does it in a true east-north-up frame
 * (an identity rotation would point at the ECEF pole and skew every offset away
 * from the equator).
 *
 * Rendering needs a live Cesium `Scene`, but every piece below is exercised in
 * plain Node against a stub scene and a real `PolylineCollection`.
 */

import { Cartesian2, Cartesian3, PolylineCollection, defined } from 'cesium';
import type { Color, Scene } from 'cesium';
import { getFeatureProperties, type Tile } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import {
  FLOW_STROKE_SUB_STEP,
  bucketBlendAt,
  bucketPositionAt,
  buildFlowStrokes,
  corridorPeakAt,
  flowStrokeSubStep,
  steppedBucketPos,
  strokeWidthFromPeak,
  type BucketAxis,
  type BucketBlend,
  type FlowStrokeBuildOptions,
  type FlowStrokeCorridor,
} from './lib/flow-strokes.js';

/** Every pure-builder knob, plus the render-side time filter. */
export interface STTFlowStrokeLayerOptions extends FlowStrokeBuildOptions {
  id?: string;
  /** Time-filter mode driving per-corridor ALPHA. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /**
   * Width recompute granularity, in fractions of a bucket. Smaller = smoother
   * breathing, more CPU. @default 0.5 (twice per bucket, deck's `STEP`)
   */
  subStep?: number;
}

/** A `PolylineCollection.add` handle; `Polyline` is not a public cesium type. */
type CesiumPolyline = ReturnType<PolylineCollection['add']>;

interface FlowStrokeEntry {
  polyline: CesiumPolyline;
  /**
   * The polyline's OWN `Color`-material uniform, read back after `add`. Mutated
   * in place every frame — see the header: no dirty check exists on a uniform,
   * and a shared object would alias every corridor.
   */
  colorUniform: Color;
  /** The volume rows the width reduction reads; kept, not copied. */
  corridor: FlowStrokeCorridor;
  start: number; // relative to timeOrigin (ms)
  end: number;
  /** Base alpha, pre-normalized to 0..1 so setTime never re-divides by 255. */
  a: number;
  /** Last alpha written; NaN forces the first frame through (NaN !== anything). */
  lastAlpha: number;
  /** Last width written; NaN likewise. */
  lastWidth: number;
  lon: number;
  lat: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

/**
 * Written and read within ONE synchronous `setTime` call (the read is inside the
 * same `if (widthsDirty)` branch that wrote it), so a single module-level object
 * is safe even with several layer instances interleaved on one clock.
 */
const SCRATCH_BLEND: BucketBlend = { b0: 0, b1: 0, f: 0 };

/** Reused for every `scene.pick`; `pick` reads x/y synchronously and keeps nothing. */
const SCRATCH_PICK = new Cartesian2();

export class STTFlowStrokeLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PolylineCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTFlowStrokeLayerOptions;
  private readonly subStep: number;
  private timeOrigin = 0;
  private axis: BucketAxis | null = null;
  private numBuckets = 0;
  /** Sub-step the widths currently reflect; NaN = "recompute on the next frame". */
  private lastSubStep = NaN;
  private entries: FlowStrokeEntry[] = [];

  constructor(scene: Scene, options: STTFlowStrokeLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-flow-strokes';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.subStep = options.subStep ?? FLOW_STROKE_SUB_STEP;
    this.collection = new PolylineCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build the corridor network. Rebases all times to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Pure offset-geometry / colour / rebase assembly lives in the Cesium-free
    // builder; this method only turns each corridor into a Cesium polyline.
    const build = buildFlowStrokes(tiles, this.opts);
    // Build BEFORE the teardown, and bail on an empty result while the old
    // polylines are still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous ribbons
    // is safe even when the emptiness is permanent: they sit at their true ECEF
    // positions, which the camera has by then left behind.
    if (build.corridors.length === 0) return; // also leaves the prior timeOrigin/axis untouched
    this.collection.removeAll();
    this.entries = [];
    this.timeOrigin = build.timeOrigin;
    this.axis = build.axis;
    this.numBuckets = build.numBuckets;
    this.lastSubStep = NaN; // widths belong to the old corridor set; force a recompute

    for (const c of build.corridors) {
      const n = c.vertexCount;
      const positions = new Array<Cartesian3>(n);
      for (let v = 0; v < n; v++) {
        positions[v] = new Cartesian3(
          c.positions[v * 3],
          c.positions[v * 3 + 1],
          c.positions[v * 3 + 2],
        );
      }
      // Seed with the corridor's REFERENCE (rush-hour) width so a static scene
      // with no clock attached still draws something sensible; `lastWidth` stays
      // NaN so the first `setTime` overwrites it unconditionally.
      const polyline = this.collection.add({
        positions,
        width: c.refWidth > 0 ? c.refWidth : 1,
        show: c.refWidth > 0,
        id: {
          layerId: this.id,
          binary: c.binary,
          featureIndex: c.featureIndex,
        },
      });
      // Each `add` mints its own default `Color` material, so this uniform is
      // private to this polyline and safe to mutate per frame.
      const colorUniform = polyline.material.uniforms.color as Color;
      colorUniform.red = c.color[0] / 255;
      colorUniform.green = c.color[1] / 255;
      colorUniform.blue = c.color[2] / 255;
      const a = (c.color[3] ?? 255) / 255;
      colorUniform.alpha = a;
      this.entries.push({
        polyline,
        colorUniform,
        corridor: c,
        start: c.start,
        end: c.end,
        a,
        lastAlpha: NaN,
        lastWidth: NaN,
        lon: c.lon,
        lat: c.lat,
        binary: c.binary,
        featureIndex: c.featureIndex,
      });
    }
  }

  /**
   * Advance to an absolute playhead. Two independent animations run here:
   *
   *  - WIDTH, from the volume matrix, gated to a sub-step of the bucket axis —
   *    the `max`-over-vertices reduction is the only O(vertices) work in the
   *    frame, and re-running it between sub-steps would recompute an identical
   *    number. A width of 0 hides the polyline outright (`show = false`) rather
   *    than drawing a degenerate quad, which is also what keeps a quiet corridor
   *    out of the draw-call list entirely.
   *  - ALPHA, from the shared `timeFilterAlpha` oracle, every frame, identical
   *    math to every other backend. Skip-if-unchanged on both, so a corridor
   *    that is fully in or fully out of the window costs two compares.
   */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const nb = this.numBuckets;
    const sub = flowStrokeSubStep(
      bucketPositionAt(this.axis, absoluteMs),
      this.subStep,
    );
    // `NaN !== NaN` makes the first frame after a rebuild always dirty.
    const widthsDirty = sub !== this.lastSubStep;
    if (widthsDirty) {
      this.lastSubStep = sub;
      const blend = bucketBlendAt(steppedBucketPos(sub, this.subStep), nb);
      SCRATCH_BLEND.b0 = blend.b0;
      SCRATCH_BLEND.b1 = blend.b1;
      SCRATCH_BLEND.f = blend.f;
    }
    for (const e of this.entries) {
      if (widthsDirty) {
        const width = strokeWidthFromPeak(
          corridorPeakAt(e.corridor, nb, SCRATCH_BLEND),
          this.opts,
        );
        if (width !== e.lastWidth) {
          e.lastWidth = width;
          if (width > 0) {
            e.polyline.width = width; // batch-table write, not a re-tessellation
            e.polyline.show = true;
          } else {
            e.polyline.show = false; // the pulse: inactive => invisible
          }
        }
      }
      const alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      if (alpha === e.lastAlpha) continue; // nothing to dirty
      e.lastAlpha = alpha;
      e.colorUniform.alpha = alpha; // in place: the uniform map reads it live
    }
  }

  /** Hit-test → the shared `SttPickResult` (props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    SCRATCH_PICK.x = cssX;
    SCRATCH_PICK.y = cssY;
    const picked = this.scene.pick(SCRATCH_PICK) as
      | {
          id?: {
            layerId: string;
            binary: BinaryFeatures;
            featureIndex: number;
          };
        }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const { binary, featureIndex } = picked.id;
    const entry = this.entries.find(
      (e) => e.binary === binary && e.featureIndex === featureIndex,
    );
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.id,
      // The corridor's first vertex BEFORE the offset — the pick should report
      // the street, not the ribbon's shifted copy of it.
      coordinate: entry ? [entry.lon, entry.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  /**
   * Unlike `STTTripsLayer`, this layer supplies NO material of its own: every
   * polyline uses the default `Color` material the collection mints inside
   * `add`, and `Polyline._destroy` releases it with the polyline. So removing
   * the collection is the whole teardown — there is no externally-supplied GPU
   * resource left holding a texture.
   */
  dispose(): void {
    this.scene.primitives.remove(this.collection);
    this.entries = [];
    this.axis = null;
    this.numBuckets = 0;
    this.lastSubStep = NaN;
  }
}
