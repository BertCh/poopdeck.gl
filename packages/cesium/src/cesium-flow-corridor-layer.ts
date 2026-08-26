// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTFlowCorridorLayer` — the `flowCorridor` kind for CesiumJS.
 *
 * ## What it renders
 * A STATIC route network whose per-segment ridership is a TIME SERIES. Each
 * corridor is one `LineString` — a bus route, a metro trunk, a street segment —
 * and its geometry never moves. What animates is the VOLUME riding it: the tile
 * carries a per-vertex x per-time-bucket matrix (`BinaryFeatures.vertexValueMatrix`,
 * `vertexValueBuckets` columns, flattened globally vertex-major and aligned 1:1
 * with `positions`), and the playhead selects a FRACTIONAL bucket, linearly
 * blended between the two bracketing columns so a 24-column day reads as a
 * continuous swell rather than 24 hard cuts.
 *
 * ```text
 * pos(t)   = (t - bucket0Abs) / bucketWidth        -- continuous, clamped
 * value(v) = (1-f) * matrix[v][b0] + f * matrix[v][b1]
 * corridor = max over v of value(v)                -- see "the reduction", below
 * rgb      = ramp(corridor)  (or the feature's base colour when no ramp is set)
 * alpha    = rgb.a/255 * timeFilterAlpha(mode, t, start, end, params)
 * ```
 *
 * ## Why: this is not a `line`
 * Before this file the kind DEGRADED to `line` — a flat, dead road atlas. The
 * volume matrix is the entire dataset; drawing the network without it renders
 * the one column of the table nobody needs. Everything else in the pipeline
 * (selection, streaming, the publish gate) already treats a flow tile as
 * resident-and-static, precisely so the playhead can sweep the matrix without a
 * refetch: the corridor set stays put for the whole day and only the colour
 * moves. That is the cheapest animation in the package, and it was being thrown
 * away.
 *
 * ## The reduction: `max` of the blend, ONE colour per corridor
 * **Cesium has no per-vertex colour on the batch-table path.** This is the
 * backend's standing documented deviation, already carried by `STTPathLayer` /
 * `STTArcLayer` (see `batched-polyline-layer.ts`): a `Primitive` of
 * `PolylineGeometry` instances animates through a per-INSTANCE
 * `ColorGeometryInstanceAttribute`, which is one RGBA per polyline, full stop.
 * So each corridor is resolved to ONE colour per frame.
 *
 * The reduction is `max` over the corridor's vertices, taken AT the blended
 * bucket ({@link corridorPeakAt}) — the busiest point on the corridor right now:
 *  - it matches what the `flowStroke` sibling widths by, so a corridor's colour
 *    and its ribbon's thickness are the same number and can never disagree;
 *  - a MEAN would wash out exactly the signal the kind exists to show: one
 *    congested block inside a long quiet route disappears into its own length,
 *    and a corridor's colour would then depend on how the source happened to
 *    split it into features;
 *  - `max` of the blend, never blend of the per-column `max`. Those differ
 *    whenever the argmax vertex migrates between adjacent columns (the peak
 *    walking from one intersection to the next across the hour), and the
 *    column-max form is a strict UPPER BOUND, not the value deck draws.
 *
 * **deck and three animate PER VERTEX; this backend animates PER CORRIDOR.** A
 * deck `flowCorridor` gradient down a single long corridor collapses here to its
 * busiest vertex's colour. Split long corridors at the source if that gradient
 * matters — a documented deviation, not a silent approximation.
 *
 * ## What it deliberately does NOT do
 * - **No animated width.** Width is one constant scalar for the whole network.
 *   Volume-driven width, the per-hour pulse and the twin `A->B` / `B->A` ribbon
 *   are the `flowStroke` kind's job; this one moves colour only.
 * - **No perpendicular offset.** The builder is shared with `flowStroke` and is
 *   called here with `offsetWidths: 0`, so every corridor rides its true
 *   centreline. Both directions of a street therefore land on top of each other
 *   — correct for a corridor map, and the reason `flowStroke` exists.
 * - **No model matrix, no RTC.** Vertices are absolute f64 ECEF metres straight
 *   out of `GlobeProjection({datum:'wgs84'})` (in `lib/flow-strokes.ts`, which
 *   also holds every scrap of geometry and value math — this file imports
 *   `cesium` and does none). Nothing here is positioned by a model matrix, so
 *   the east-north-up trap that lays a column flat at latitude cannot arise;
 *   `Cartesian3` takes CPU doubles, so there is no f32 buffer to protect.
 * - **No shader path.** `src/shaders.ts` does not exist. Alpha is the CPU
 *   `timeFilterAlpha` oracle, per frame per corridor, byte-identical to every
 *   other backend.
 *
 * ## Per-frame cost
 * The colour reduction is O(vertices) and is GATED to a sub-step of a bucket
 * ({@link flowStrokeSubStep}, deck's `FlowCorridorLayer.STEP` re-expansion
 * gate): colours are recomputed only when the playhead crosses a sub-step,
 * while the time-filter ALPHA still updates every frame and unchanged alphas
 * skip the write entirely. Scrubbing a 24-bucket day at `subStep: 0.5` costs 48
 * reductions, not one per frame.
 *
 * Rendering needs a live Cesium `Scene`, so the draw is browser-verify-only;
 * everything up to the GPU is exercised in `test/cesium-flow-corridor-layer.test.ts`.
 */

import {
  ArcType,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PolylineColorAppearance,
  PolylineGeometry,
  Primitive,
  PrimitiveCollection,
  defined,
  type Scene,
} from 'cesium';
import {
  getFeatureProperties,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import { rampColorAt, type RGBA255 } from '@poopdeck.gl/core/style';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  FLOW_STROKE_SUB_STEP,
  buildFlowStrokes,
  bucketBlendAt,
  bucketPositionAt,
  corridorPeakAt,
  flowStrokeSubStep,
  steppedBucketPos,
  type BucketAxis,
  type FlowStrokeCorridor,
} from './lib/flow-strokes.js';
import type { FeatureColorMode } from './lib/feature-color.js';

/** Maps the active-bucket volume onto a colour. */
export interface FlowValueRamp {
  /** `[lo, hi]` volume clamped onto `range`. */
  domain: readonly [number, number];
  /** Ramp stops (0-255 channels); alpha rides through to the batch table. */
  range: readonly RGBA255[];
}

export interface STTFlowCorridorLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /**
   * Per-corridor IDENTITY colour (route colour, agency colour, ...). Used as
   * the drawn RGB when {@link valueRamp} is absent, and always supplies the
   * base alpha the time filter multiplies. @default constant opaque grey
   */
  color?: FeatureColorMode;
  /**
   * Volume -> colour ramp, evaluated per frame at the corridor's active-bucket
   * peak. Absent => the corridor keeps its identity colour and only the time
   * filter moves, which is the "static network, fading in" degenerate case.
   */
  valueRamp?: FlowValueRamp;
  /**
   * Corridors whose active-bucket peak is `<= minFlow` draw fully transparent.
   * The "inactive => invisible" pulse, shared verbatim with `flowStroke`.
   * @default 0 — a zero-volume corridor still disappears, since `0 > 0` is false.
   */
  minFlow?: number;
  /** Line width in pixels — CONSTANT; volume drives colour, not width. @default 3 */
  width?: number;
  /** Constant altitude lift in metres, to keep the network off the terrain. @default 0 */
  zLift?: number;
  /**
   * Colour-recompute granularity in fractions of a bucket (deck's `STEP`).
   * @default 0.5 — two recomputes per bucket.
   */
  subStep?: number;
  /**
   * Vertex-to-vertex interpolation. `'none'` draws straight 3-D segments
   * between the (already dense) corridor vertices; `'geodesic'` subdivides
   * along the ellipsoid for sparse ground-hugging lines. @default 'none'
   */
  arcType?: 'none' | 'geodesic' | 'rhumb';
}

/** Pick/attribute identity for one corridor instance. */
interface InstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface CorridorEntry {
  id: InstanceId;
  corridor: FlowStrokeCorridor;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // colour resolved for the CURRENT sub-step (0-255; batch-table colours are u8)
  g: number;
  b: number;
  a: number; // base alpha 0..1, multiplied by the time-filter alpha
  /** Active-bucket peak behind `r,g,b` — also what the `minFlow` gate reads. */
  value: number;
  lastAlpha: number; // NaN until the first write, so the first frame always writes
  /** Batch-table colour handle; cached on the first `ready` frame. */
  attrs: { color: Uint8Array } | null;
  lon: number; // first vertex, for SttPickResult.coordinate
  lat: number;
}

// One shared scratch per mutable Cesium type, so neither the per-frame loop nor
// the per-corridor build allocates. Safe because JS is single-threaded and both
// methods run to completion synchronously, and because each sink COPIES the
// value out: the batch-table `color` setter copies the four bytes immediately,
// and `ColorGeometryInstanceAttribute.fromColor` reads the channels into its own
// `value`. The scratch must stay a DISTINCT object from the primitive's own
// storage — writing through the primitive's buffer in place would bypass the
// dirty check and freeze the animation.
/** Per-frame batch-table write (`setTime`). */
const SCRATCH_RGBA = new Uint8Array(4);
/** Per-corridor instance seed (`setTiles`). */
const SCRATCH_COLOR = new Color();

/** Map the option string onto Cesium's enum (default `'none'`). */
function toArcType(a: STTFlowCorridorLayerOptions['arcType']): ArcType {
  if (a === 'geodesic') return ArcType.GEODESIC;
  if (a === 'rhumb') return ArcType.RHUMB;
  return ArcType.NONE;
}

export class STTFlowCorridorLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PrimitiveCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTFlowCorridorLayerOptions;
  private readonly width: number;
  private readonly subStep: number;
  private readonly arcType: ArcType;
  private primitive: Primitive | null = null;
  private entries: CorridorEntry[] = [];
  private attrsCached = false;
  private timeOrigin = 0;
  private axis: BucketAxis | null = null;
  private numBuckets = 0;
  /** Sub-step behind the currently-resolved colours; NaN forces the first pass. */
  private lastSubStep = Number.NaN;

  constructor(scene: Scene, options: STTFlowCorridorLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-flow-corridors';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.width = options.width ?? 3;
    this.subStep = options.subStep ?? FLOW_STROKE_SUB_STEP;
    this.arcType = toArcType(options.arcType);
    // The Primitive itself cannot exist before the first tile, so the layer owns
    // a collection from construction and swaps the primitive inside it. That
    // keeps registration/teardown symmetric with every other layer here.
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build the corridor network from decoded tiles. Replace-all. */
  setTiles(tiles: Tile[]): void {
    // All geometry, projection and value-matrix assembly lives in the
    // Cesium-free builder; this method only turns corridors into instances.
    // `offsetWidths: 0` is what separates this kind from `flowStroke`: no
    // perpendicular shift, every corridor on its true centreline.
    const build = buildFlowStrokes(tiles, {
      color: this.opts.color,
      zLift: this.opts.zLift,
      offsetWidths: 0,
    });
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitives are still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame (the
    // "tiles genuinely in view flash out" symptom). Holding the previous
    // geometry is safe even when the emptiness is permanent: it sits at its true
    // ECEF positions, which the camera has by then left behind.
    if (build.corridors.length === 0) return; // also leaves the prior timeOrigin/axis untouched
    this.collection.removeAll(); // destroys the standing primitive
    this.primitive = null;
    this.entries = [];
    this.attrsCached = false;
    this.lastSubStep = Number.NaN; // force a colour pass on the next frame
    this.timeOrigin = build.timeOrigin;
    this.axis = build.axis;
    this.numBuckets = build.numBuckets;

    const instances: GeometryInstance[] = [];
    for (const c of build.corridors) {
      const numVerts = c.positions.length / 3;
      const positions: Cartesian3[] = new Array(numVerts);
      for (let v = 0; v < numVerts; v++) {
        positions[v] = new Cartesian3(
          c.positions[v * 3],
          c.positions[v * 3 + 1],
          c.positions[v * 3 + 2],
        );
      }
      const id: InstanceId = {
        layerId: this.id,
        binary: c.binary,
        featureIndex: c.featureIndex,
      };
      // Seed fully transparent: the network must not flash at full opacity for
      // the frames between construction and the first setTime.
      SCRATCH_COLOR.red = c.color[0] / 255;
      SCRATCH_COLOR.green = c.color[1] / 255;
      SCRATCH_COLOR.blue = c.color[2] / 255;
      SCRATCH_COLOR.alpha = 0;
      instances.push(
        new GeometryInstance({
          geometry: new PolylineGeometry({
            positions,
            width: this.width,
            vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
            arcType: this.arcType,
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(SCRATCH_COLOR),
          },
          id,
        }),
      );
      this.entries.push({
        id,
        corridor: c,
        start: c.start,
        end: c.end,
        r: c.color[0],
        g: c.color[1],
        b: c.color[2],
        a: (c.color[3] ?? 255) / 255,
        value: 0,
        lastAlpha: NaN,
        attrs: null,
        lon: c.lon,
        lat: c.lat,
      });
    }

    this.primitive = this.collection.add(
      new Primitive({
        geometryInstances: instances,
        appearance: new PolylineColorAppearance({ translucent: true }),
        asynchronous: false, // deterministic replace-all; no worker round-trip per tile load
      }),
    ) as Primitive;
  }

  /**
   * Advance to an absolute playhead time.
   *
   * Two clocks meet here and they are rebased differently, which is the one
   * thing easy to get wrong: the BUCKET axis is absolute (`bucket0Abs` is a real
   * epoch ms, so the playhead indexes the matrix directly), while the TIME
   * FILTER is relative (`start`/`end` were rebased to `timeOrigin` at build).
   */
  setTime(absoluteMs: number): void {
    const prim = this.primitive;
    if (!prim || !prim.ready) return; // the batch table exists only after the first render
    if (!this.attrsCached) {
      for (const e of this.entries) {
        e.attrs = prim.getGeometryInstanceAttributes(e.id) as {
          color: Uint8Array;
        };
      }
      this.attrsCached = true;
    }

    // Colour reduction is O(vertices); gate it to a sub-step of a bucket.
    const sub = flowStrokeSubStep(
      bucketPositionAt(this.axis, absoluteMs),
      this.subStep,
    );
    const recolor = sub !== this.lastSubStep;
    const blend = recolor
      ? bucketBlendAt(steppedBucketPos(sub, this.subStep), this.numBuckets)
      : null;
    if (recolor) this.lastSubStep = sub;

    const ramp = this.opts.valueRamp;
    const minFlow = this.opts.minFlow ?? 0;
    const cur = absoluteMs - this.timeOrigin;
    const v = SCRATCH_RGBA;
    for (const e of this.entries) {
      // True only when the RGB actually moved. Crossing a sub-step is NOT
      // enough: with no ramp the identity colour never changes, so a static
      // network still costs one compare per corridor per frame rather than a
      // forced write every half-bucket.
      let rgbDirty = false;
      if (blend) {
        // max OF the blend — never blend of the per-column max.
        e.value = corridorPeakAt(e.corridor, this.numBuckets, blend);
        if (ramp) {
          const col = rampColorAt(e.value, ramp.domain, ramp.range);
          // ROUND to u8 here, not at the write. `rampColorAt` interpolates in
          // continuous channel space, and a typed-array store TRUNCATES toward
          // zero — which would bias every interpolated colour dark by up to
          // 1/255 and, worse, make the dirty check compare floats that differ
          // below the quantum the GPU can even see.
          const r = Math.round(col[0]);
          const g = Math.round(col[1]);
          const b = Math.round(col[2]);
          const a = (col[3] ?? 255) / 255;
          rgbDirty = r !== e.r || g !== e.g || b !== e.b || a !== e.a;
          e.r = r;
          e.g = g;
          e.b = b;
          e.a = a;
        }
      }
      // The pulse: a corridor at or below minFlow is INVISIBLE, whatever the
      // time filter says. `!(x > minFlow)` also catches NaN.
      const alpha = !(e.value > minFlow)
        ? 0
        : e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      // Skip only when nothing at all changed: an unchanged alpha still needs a
      // write when the sub-step moved the RGB underneath it.
      if ((!rgbDirty && alpha === e.lastAlpha) || !e.attrs) continue;
      e.lastAlpha = alpha;
      v[0] = e.r;
      v[1] = e.g;
      v[2] = e.b;
      v[3] = Math.round(alpha * 255);
      e.attrs.color = v; // the batch-table setter copies the four bytes out
    }
  }

  /** Hit-test → the shared `SttPickResult` (feature props via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
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
      (e) => e.id.binary === binary && e.id.featureIndex === featureIndex,
    );
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.id,
      coordinate: entry ? [entry.lon, entry.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    // `removeAll()` FIRST: it destroys the primitive (and with it the geometry
    // and the appearance's shader program) while the collection is still alive.
    // `scene.primitives.remove` destroys the collection itself, after which any
    // call on it throws — so the order is not interchangeable. Nothing else here
    // is an externally-supplied GPU resource: `PolylineColorAppearance` carries
    // no Material, unlike `STTTripsLayer`'s per-trip materials.
    this.collection.removeAll();
    this.scene.primitives.remove(this.collection);
    this.primitive = null;
    this.entries = [];
    this.attrsCached = false;
  }
}
