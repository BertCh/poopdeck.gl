// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTFlowmapLayer` — the NATIVE `flowmap` kind for CesiumJS: flowmap.gl-style
 * origin→destination arrows whose width and colour breathe off a per-bucket
 * flow magnitude.
 *
 * ## What it renders
 * One TAPERED RIBBON WITH A HEAD per OD flow — a shaft that thickens from tail
 * to head plus an arrowhead triangle — baked in `lib/flowmap.ts` (pure, no
 * Cesium) and published as batched `GeometryInstance`s inside ONE `Primitive`
 * with a `PerInstanceColorAppearance`. Colour animates through that primitive's
 * batch table exactly as `STTBatchedPolylineLayer` does: one draw-call bucket,
 * a colour write is a texel update, never a rebatch.
 *
 * ## Why it exists (what the `line` degradation was losing)
 * Until now `cesiumBackend` declared `flowmap → line`. A plain line has no
 * arrowhead and no taper, so `A→B` and `B→A` collapse onto one stroke and the
 * direction — the entire content of an OD matrix — is gone. The head and the
 * taper are the kind.
 *
 * ## The honest cost: rebuild on a BUCKET CHANGE, not per frame
 * A flowmap arrow's WHOLE SHAPE is value-driven: the shaft width, the head
 * width, the head length and the tail taper are all functions of the current
 * magnitude. Baked triangle geometry cannot change width without being rebuilt,
 * and Cesium exposes no screen-space extrusion for an arbitrary mesh — so there
 * is no shader hook to hide behind here (the package has no shader path at all;
 * `src/shaders.ts` is gone).
 *
 * So the geometry is rebuilt when the playhead crosses a bucket sub-step, and
 * NOT otherwise:
 *
 * ```text
 *   every frame :  timeFilterAlpha → one batch-table byte write per arrow   (cheap)
 *   bucket step :  re-bake every ribbon + new Primitive + re-upload         (expensive)
 * ```
 *
 * The gate is `flowStrokeSubStep(bucketPositionAt(axis, t), rebuildStep)` —
 * the SAME quantizer `flowStroke` uses to bound its per-frame reduction, reused
 * rather than re-invented. At the default `rebuildStep` of `0.5` a 60 fps
 * playthrough of a 24-bucket archive rebuilds 48 times, not 60 times a second;
 * the half-bucket step is also what keeps the two-column blend genuinely
 * engaged (an integer step would always sample `f === 0` and the arrows would
 * jump between hours instead of easing). A static, column-driven archive has no
 * axis, so `bucketPositionAt` returns `0` forever and the geometry is built
 * exactly ONCE.
 *
 * Rebuild cost is `O(flows × shaftSegments)` CPU plus one `Primitive` upload.
 * If that shows up in a profile the levers are, in order: raise `rebuildStep`,
 * lower `shaftSegments`, raise `minFlow` (quiet arrows are dropped entirely).
 *
 * ## Opt-in KDEEB bundling (`liveBundling`)
 * Setting {@link STTFlowmapLayerOptions.bundling} relaxes the visible OD flows
 * into smooth rivers with the shared `@poopdeck.gl/core/edge-bundling` kernel
 * and extrudes each arrow along its river instead of along its chord —
 * `lib/edge-bundler.ts`, which owns the whole story including its measured CPU
 * cost and its edge cap.
 *
 * It fits the two-cadence split above rather than fighting it: a bundle is
 * STATIC GEOMETRY (the relaxed control points depend only on the endpoints,
 * never on the playhead), so it is computed ONCE per `setTiles` and the
 * per-bucket re-bake merely re-extrudes ribbons along paths that are already
 * settled. The relaxation is main-thread CPU — this package has no shader path
 * — so it is capped, and past the cap `bundleFlows` returns `null` and every
 * arrow falls back to its straight chord.
 *
 * ## Deviations from deck
 * All inherited from the pure builder and documented at length in
 * `lib/flowmap.ts`: widths are world METRES not screen pixels; one colour per
 * arrow (deck's source→target gradient collapses); straight subdivided chords,
 * not geodesics; NO node circles.
 *
 * Rendering needs a live Cesium `Scene` → browser-verify-only; the pure builder
 * it composes is unit-tested in plain Node.
 */

import {
  BoundingSphere,
  Cartesian2,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  type GeometryAttributes,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveCollection,
  PrimitiveType,
  defined,
  type Scene,
} from 'cesium';
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
  DEFAULT_GAP_WIDTHS,
  arrowWidthMeters,
  buildArrowRibbon,
  buildFlowmapFlows,
  flowMagnitudeAt,
  flowmapColorAt,
  type FlowmapBuild,
  type FlowmapBuildOptions,
  type FlowmapFlow,
} from './lib/flowmap.js';
import {
  FLOW_STROKE_SUB_STEP,
  bucketBlendAt,
  bucketPositionAt,
  flowStrokeSubStep,
  steppedBucketPos,
} from './lib/flow-strokes.js';
import {
  buildBundledArrowRibbon,
  bundleFlows,
  type FlowBundle,
  type FlowBundlingOptions,
} from './lib/edge-bundler.js';

export interface STTFlowmapLayerOptions extends FlowmapBuildOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /**
   * Bucket quantization that gates the GEOMETRY rebuild, in buckets. Larger is
   * cheaper and steppier. `0.5` (the `flowStroke` sub-step) keeps the two-column
   * blend engaged; `1` snaps to whole buckets. @default 0.5
   */
  rebuildStep?: number;
  /**
   * Opt into KDEEB edge bundling (`liveBundling`): `true` for the defaults, or
   * an options bag to tune them. Unset (the default) draws straight arrows.
   *
   * The relaxation runs ONCE per `setTiles`, on the main thread, and is linear
   * in the visible edge count at roughly 0.28 ms per edge — see
   * `lib/edge-bundler.ts`, which carries the measured table and the cap. Past
   * `maxBundledEdges` (1000 by default, ≈280 ms) bundling is refused outright
   * and every arrow is straight; nothing partially bundles.
   */
  bundling?: boolean | FlowBundlingOptions;
}

/** Pick/attribute identity for one arrow instance. */
interface InstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface FlowmapEntry {
  id: InstanceId;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // batch-table colours are u8 — kept 0–255, never re-divided per frame
  g: number;
  b: number;
  a: number; // magnitude-driven base alpha (0..1) at the CURRENT bucket
  lastAlpha: number; // NaN → the first setTime after a rebuild always writes
  /** Batch-table colour handle; cached on the first ready frame after a rebuild. */
  attrs: { color: Uint8Array } | null;
  lon: number; // origin, for SttPickResult.coordinate
  lat: number;
}

// Reused for every per-frame colour write; the batch-table setter copies the
// four bytes immediately, so one shared scratch is safe across every entry AND
// every layer instance (same argument as STTPointLayer's SCRATCH_COLOR: JS is
// single-threaded and setTime runs synchronously to completion). It must stay a
// DISTINCT object from the batch table's own storage.
const SCRATCH_RGBA = new Uint8Array(4);
// Seed colour for a freshly-created instance: the real RGB, alpha 0. The first
// setTime writes the animated alpha, so an un-ticked layer is invisible rather
// than a flash of fully-opaque arrows.
const SCRATCH_SEED = new Color();

export class STTFlowmapLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly opts: STTFlowmapLayerOptions;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly rebuildStep: number;
  /** Holds the one batched arrow Primitive; swapped wholesale on a bucket change. */
  private readonly collection: PrimitiveCollection;
  private readonly appearance: PerInstanceColorAppearance;
  private build: FlowmapBuild | null = null;
  /**
   * The relaxed rivers for the standing `build`, or `null` when bundling is off
   * or was refused (too many edges, too few, degenerate extent). Edge `e` is
   * `build.flows[e]`, so `bake` indexes both with one counter.
   */
  private bundle: FlowBundle | null = null;
  private primitive: Primitive | null = null;
  private entries: FlowmapEntry[] = [];
  private attrsCached = false;
  private timeOrigin = 0;
  /** Quantized bucket index the standing geometry was baked at. */
  private lastSubStep = Number.NaN;
  /** Last playhead seen, so setTiles can bake at the CURRENT bucket. NaN before the first tick. */
  private lastAbsoluteMs = Number.NaN;

  constructor(scene: Scene, options: STTFlowmapLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-flowmap';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.rebuildStep = options.rebuildStep ?? FLOW_STROKE_SUB_STEP;
    // `flat` drops the normal from the required vertex format — the ribbons are
    // unlit ground decals, and a normal-bearing format would double the upload
    // that the bucket rebuild is already paying for.
    this.appearance = new PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      closed: false,
    });
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /**
   * (Re)build flows from decoded tiles, then bake the arrows for the current
   * bucket. Rebases all times to one scene-wide origin.
   */
  setTiles(tiles: Tile[]): void {
    // Pure geometry/colour/rebase assembly lives in the Cesium-free builder.
    const build = buildFlowmapFlows(tiles, this.opts);
    // Build BEFORE the teardown, and bail on an empty result while the old
    // arrows are still standing. Selection reports an empty visible set for the
    // frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous arrows
    // is safe even when the emptiness is permanent: they sit at their true ECEF
    // positions, which the camera has by then left behind.
    if (build.flows.length === 0) return; // also leaves the prior timeOrigin untouched
    this.build = build;
    // The bundle is static geometry — it depends on the endpoints alone — so it
    // is relaxed HERE, once per tile-set change, and never again until the next
    // one. `null` (bundling off, or refused) means every bake draws chords.
    const bundling = this.opts.bundling;
    this.bundle = bundling
      ? bundleFlows(build.flows, bundling === true ? {} : bundling)
      : null;
    this.timeOrigin = build.timeOrigin;
    // Bake at whatever bucket the playhead is already on. Before the first tick
    // `lastAbsoluteMs` is NaN, which `bucketPositionAt` maps to 0 rather than
    // indexing the magnitude rows wildly.
    this.lastSubStep = flowStrokeSubStep(
      bucketPositionAt(build.axis, this.lastAbsoluteMs),
      this.rebuildStep,
    );
    this.bake(steppedBucketPos(this.lastSubStep, this.rebuildStep));
  }

  /**
   * Advance to an absolute playhead time.
   *
   * TWO cadences, deliberately: the geometry is re-baked only when the playhead
   * crosses a bucket sub-step (a flowmap arrow's whole shape is value-driven and
   * baked triangles cannot change width — see the file header), while the
   * per-frame work is the shared `timeFilterAlpha` oracle writing one batch-table
   * RGBA per arrow, with unchanged alphas skipped.
   */
  setTime(absoluteMs: number): void {
    this.lastAbsoluteMs = absoluteMs;
    const build = this.build;
    if (!build) return;

    // 1. The bucket gate. Checked BEFORE the ready/primitive guard below, so a
    //    bucket whose flows were all quiet (no primitive at all) can still bring
    //    the arrows back on the next step.
    const subStep = flowStrokeSubStep(
      bucketPositionAt(build.axis, absoluteMs),
      this.rebuildStep,
    );
    if (subStep !== this.lastSubStep) {
      this.lastSubStep = subStep;
      this.bake(steppedBucketPos(subStep, this.rebuildStep));
    }

    // 2. The per-frame alpha, through the batch table.
    const prim = this.primitive;
    if (!prim || !prim.ready) return; // batch table exists only after the first render
    if (!this.attrsCached) {
      for (const e of this.entries) {
        e.attrs = prim.getGeometryInstanceAttributes(e.id) as {
          color: Uint8Array;
        };
      }
      this.attrsCached = true;
    }

    const cur = absoluteMs - this.timeOrigin;
    const v = SCRATCH_RGBA;
    for (const e of this.entries) {
      const alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      if (alpha === e.lastAlpha || !e.attrs) continue; // identical to the last write
      e.lastAlpha = alpha;
      v[0] = e.r;
      v[1] = e.g;
      v[2] = e.b;
      v[3] = Math.round(alpha * 255);
      e.attrs.color = v; // setter copies the bytes into the batch table
    }
  }

  /**
   * Re-bake every arrow at a bucket position and swap the Primitive.
   *
   * The pure pass runs FIRST, before any teardown — same discipline as
   * `setTiles`. The teardown is NOT conditional on the result here, and that
   * difference is deliberate: an empty result in `setTiles` means "the tiles
   * have not arrived yet", but an empty result HERE means "every flow is below
   * `minFlow` this hour", which is real data the pulse must show. Standing
   * arrows through a quiet bucket would draw traffic that is not there.
   */
  private bake(steppedBucket: number): void {
    const build = this.build;
    if (!build) return;
    const blend = bucketBlendAt(steppedBucket, build.numBuckets);
    const gapWidths = this.opts.gapWidths ?? DEFAULT_GAP_WIDTHS;

    const instances: GeometryInstance[] = [];
    const entries: FlowmapEntry[] = [];
    const bundle = this.bundle;
    for (let fi = 0; fi < build.flows.length; fi++) {
      const flow = build.flows[fi];
      const magnitude = flowMagnitudeAt(flow, build.numBuckets, blend);
      const width = arrowWidthMeters(magnitude, this.opts);
      if (width <= 0) continue; // "inactive ⇒ invisible" — the pulse
      // The twin gap comes from the flow's ALL-BUCKET reference width, not the
      // current one, so a pair holds a constant world-space separation instead
      // of drifting together every time both directions go quiet.
      const gap = gapWidths * arrowWidthMeters(flow.refMagnitude, this.opts);
      // The ONLY place bundling shows: extrude along the relaxed river when one
      // exists, along the straight chord otherwise. Both builders return the
      // same vertex/index layout, so nothing downstream changes.
      const ribbon = bundle
        ? buildBundledArrowRibbon(bundle, fi, flow, width, this.opts, gap)
        : buildArrowRibbon(flow, width, this.opts, gap);
      if (!ribbon) continue;
      const color = flowmapColorAt(flow, magnitude, this.opts);
      const id: InstanceId = {
        layerId: this.id,
        binary: flow.binary,
        featureIndex: flow.featureIndex,
      };
      SCRATCH_SEED.red = color[0] / 255;
      SCRATCH_SEED.green = color[1] / 255;
      SCRATCH_SEED.blue = color[2] / 255;
      SCRATCH_SEED.alpha = 0; // the first setTime writes the real alpha
      instances.push(
        new GeometryInstance({
          geometry: new Geometry({
            // Cesium types `GeometryAttributes` with every slot required, but
            // the runtime only reads the ones the appearance's VertexFormat asks
            // for — `PerInstanceColorAppearance` with `flat: true` needs position
            // alone. The cast is the honest narrowing: zeroed
            // normal/st/tangent/bitangent buffers would be four unused uploads
            // per arrow, on every bucket.
            attributes: {
              position: new GeometryAttribute({
                componentDatatype: ComponentDatatype.DOUBLE,
                componentsPerAttribute: 3,
                values: ribbon.positions,
              }),
            } as unknown as GeometryAttributes,
            indices: ribbon.indices,
            primitiveType: PrimitiveType.TRIANGLES,
            // Absolute f64 ECEF, no RTC: Cartesian3 is f64 all the way down, and
            // Primitive does its own high/low split for the GPU.
            boundingSphere: BoundingSphere.fromVertices(ribbon.positions),
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(SCRATCH_SEED),
          },
          id,
        }),
      );
      entries.push({
        id,
        start: flow.start,
        end: flow.end,
        r: color[0],
        g: color[1],
        b: color[2],
        a: (color[3] ?? 255) / 255,
        lastAlpha: Number.NaN, // NaN !== anything → force the first write
        attrs: null,
        lon: flow.lon,
        lat: flow.lat,
      });
    }

    // Teardown AFTER the pure pass. removeAll() destroys the outgoing Primitive
    // (PrimitiveCollection.destroyPrimitives defaults true), which is what
    // releases its vertex arrays and batch table.
    this.collection.removeAll();
    this.primitive = null;
    this.entries = entries;
    this.attrsCached = false;
    if (instances.length === 0) return; // a genuinely quiet bucket draws nothing

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: this.appearance,
      asynchronous: false, // deterministic swap; no worker round-trip per bucket
    });
    this.collection.add(this.primitive);
  }

  /** Hit-test → the shared `SttPickResult` (feature props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: InstanceId }
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

  /**
   * Remove the collection from the scene — which destroys the Primitive it
   * holds, and with it the vertex arrays and batch table.
   *
   * Nothing else here is an externally-supplied GPU resource: a
   * `PerInstanceColorAppearance` is a CPU-side render-state description with no
   * `destroy()`, unlike a `Material` (compare `STTTripsLayer.destroyMaterials`).
   * What the collection cannot free is the CPU-side state — the per-flow
   * magnitude rows and the bundle's control points are plain typed arrays held
   * by THIS object — so both are dropped explicitly, along with the entries that
   * reference the decoded tiles.
   */
  dispose(): void {
    this.collection.removeAll();
    this.scene.primitives.remove(this.collection);
    this.primitive = null;
    this.entries = [];
    this.build = null;
    this.bundle = null;
    this.lastSubStep = Number.NaN;
  }
}

/** Re-exported so a flow instance and its ribbon can be typed by callers. */
export type { FlowmapFlow };
