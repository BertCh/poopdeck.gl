// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `column` for CesiumJS: one extruded n-sided PRISM per point feature, rising
 * from the ellipsoid — the Cesium analogue of deck's `AnimatedColumnLayer`.
 * Radius is in TRUE METRES, height comes from a numeric column through a scale,
 * and the feature's `[start,end]` window animates the prism's alpha through the
 * shared `timeFilterAlpha` oracle. It is the kind that turns a point tier into a
 * skyline: counts, magnitudes, depths, volumes — anything whose comparison is
 * easier as length than as colour.
 *
 * ── HOW IT DRAWS ─────────────────────────────────────────────────────────────
 * ONE batched `Primitive` of `CylinderGeometry` `GeometryInstance`s (`slices` =
 * the prism's side count, so `slices: 6` is a hexagon and the deck default 20 is
 * a smooth-enough disk), under a shared `PerInstanceColorAppearance`. That is the
 * same bargain `STTBatchedPolylineLayer` strikes: every prism lands in one
 * draw-call bucket, and animation is a four-byte write into the batch table
 * rather than a rebatch. Alpha therefore costs the same whether the tile holds
 * ten prisms or ten thousand.
 *
 * ── WHY EVERY PRISM NEEDS ITS OWN ORIENTATION ────────────────────────────────
 * Cesium's frame is a real ellipsoid in absolute ECEF metres, and
 * `CylinderGeometry` is built along its LOCAL +Z. A prism placed with an identity
 * model matrix therefore points at the ECEF +Z pole — the spin axis — not at the
 * local vertical. At the equator that is exactly right and the mistake is
 * invisible; by 45° every column leans 45° toward the pole, and in Reykjavík they
 * lie down and point out to sea. So each instance carries
 * `Transforms.eastNorthUpToFixedFrame(foot)` as its `modelMatrix`, which is the
 * one definition of local up the whole engine already agrees on, composed with a
 * local raise of half the height (Cesium's cylinder is CENTRED on its origin,
 * while the data is at the FOOT) and deck's optional `angle` about the axis.
 * `GeometryInstance.modelMatrix` is baked into the vertices when the primitive is
 * built, so this costs nothing per frame.
 *
 * ── TIME AS HEIGHT ───────────────────────────────────────────────────────────
 * `timeHeightScale` lifts each prism's foot by `(start − timeHeightOrigin) ×
 * timeHeightScale` metres, turning a stack of repeated events at one place into a
 * vertical time axis — the space-time cube, and one of the two kinds that make
 * this backend's `capabilities.timeAsHeight` honest. The lift is an ALTITUDE add
 * inside the pure builder (`project(lon, lat, alt + lift)`), never a Z offset on
 * the ECEF result, for exactly the reason the orientation is not identity: +Z is
 * the spin axis, not up. See `lib/columns.ts` for the full note.
 *
 * ── DOCUMENTED DEVIATIONS FROM DECK (not silent approximations) ───────────────
 *  1. COLOUR IS PER FEATURE, never per vertex. Batch-table animation has one
 *     `ColorGeometryInstanceAttribute` per instance, so a deck column with a
 *     vertical gradient collapses to its source colour. Package-wide deviation,
 *     shared with the path/arc layers.
 *  2. NO `stroked` OUTLINE. deck can ring a column with a wireframe; the Cesium
 *     equivalent is a second `CylinderOutlineGeometry` primitive with its own
 *     appearance and its own batch table — twice the draw calls and twice the
 *     per-frame writes for a decoration. Not shipped.
 *  3. NO `extruded: false`. A zero-length cylinder is degenerate in Cesium (the
 *     builder skips any height that is not `> 0`); for flat disks use
 *     `STTPointLayer`, which is what that mode actually is.
 *  4. NO `vertices` (custom cross-section polygon). `CylinderGeometry` is a
 *     REGULAR n-gon only; `diskResolution` picks n and `angle` spins it.
 *  5. `radiusUnits: 'pixels'` is unsupported — this geometry is metric on the
 *     ellipsoid, and a screen-space radius would need a per-frame rebuild.
 *  6. HEIGHT IS STATIC per build. deck's shader can rescale elevation per frame;
 *     here elevation is baked into vertices, so changing `elevationScale` means
 *     another `setTiles`. Alpha is the only per-frame channel.
 *
 * Rendering needs a live `Scene` (a WebGL canvas), but every non-render seam —
 * the collection registration, the instance count, the model matrices, the
 * batch-table writes — is unit-tested in Node against a stub scene and the real
 * Cesium value types.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
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
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { FeatureColorMode } from './lib/feature-color.js';
import {
  buildColumnEntries,
  columnAxisOffsetMeters,
  prismSlices,
  type FeatureColumn,
} from './lib/columns.js';

export interface STTColumnLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /** Per-feature colour (constant / categorical / ramp). @default deck's orange */
  color?: FeatureColorMode;
  /** Numeric column (metres) driving each prism's height. @default null */
  elevationProperty?: string | null;
  /** Height in metres when no `elevationProperty` resolves. @default 1000 */
  defaultElevation?: number;
  /** Multiplier on every height. @default 1 */
  elevationScale?: number;
  /** Cross-section circumradius in TRUE metres. @default 100 */
  radius?: number;
  /** Radius multiplier in 0..1 (deck's `coverage`). @default 1 */
  coverage?: number;
  /** Sides of the prism (deck's `diskResolution`); clamped to `>= 3`. @default 20 */
  diskResolution?: number;
  /** Rotation of the cross-section about the prism axis, DEGREES. @default 0 */
  angle?: number;
  /** Numeric column (metres) raising each foot off the ground. @default null */
  baseElevationProperty?: string | null;
  /** Constant altitude lift in metres added to every foot. @default 0 */
  zLift?: number;
  /** Space-time cube: metres of altitude per millisecond. @default 0 (flat) */
  timeHeightScale?: number;
  /** Absolute epoch ms drawn at altitude 0; `null` = the build's own origin. @default null */
  timeHeightOrigin?: number | null;
  /**
   * Draw unlit. Lit prisms read as solids (the default, and what makes a
   * skyline legible); flat is for palettes that must survive unshaded.
   * @default false
   */
  flat?: boolean;
}

/** The picking id object attached to every instance. */
interface InstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface ColumnEntry {
  id: InstanceId;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // base colour, kept as 0–255 bytes: the batch table IS bytes
  g: number;
  b: number;
  a: number; // base alpha 0..1, multiplied by the time-filter alpha
  lastAlpha: number; // skip the batch-table write when unchanged; NaN forces frame 1
  attrs: { color: Uint8Array } | null;
  lon: number;
  lat: number;
  /** Space-time-cube lift already folded into this prism's foot (metres). */
  lift: number;
}

// Module-level scratch, reused for every write so the per-frame loop allocates
// nothing. Safe because JS is single-threaded and setTime runs synchronously to
// completion, and because Cesium's batch-table setter COPIES the bytes out
// (identical reasoning to STTPointLayer's SCRATCH_COLOR).
const SCRATCH_RGBA = new Uint8Array(4);

// Build-time scratch for the local (raise + spin) half of each model matrix.
// The ENU half is allocated fresh per instance — Cesium holds that Matrix4 by
// reference until the primitive is built, so instances must not share one.
const SCRATCH_LOCAL_ROT = new Matrix3();
const SCRATCH_LOCAL_POS = new Cartesian3();
const SCRATCH_LOCAL = new Matrix4();

const DEG2RAD = Math.PI / 180;

/**
 * The full model matrix for one prism: the local east-north-up frame at its
 * foot, composed with a raise of half the height along local up and a spin of
 * `angleRad` about that same axis.
 *
 * Returns a FRESH `Matrix4` per call by design — see `SCRATCH_LOCAL`.
 */
function columnModelMatrix(c: FeatureColumn, angleRad: number): Matrix4 {
  // Fresh, per instance: Transforms allocates when given no result parameter.
  const enu = Transforms.eastNorthUpToFixedFrame(new Cartesian3(c.x, c.y, c.z));
  SCRATCH_LOCAL_POS.x = 0;
  SCRATCH_LOCAL_POS.y = 0;
  SCRATCH_LOCAL_POS.z = columnAxisOffsetMeters(c.height);
  Matrix4.fromRotationTranslation(
    Matrix3.fromRotationZ(angleRad, SCRATCH_LOCAL_ROT),
    SCRATCH_LOCAL_POS,
    SCRATCH_LOCAL,
  );
  return Matrix4.multiply(enu, SCRATCH_LOCAL, enu); // in place into the fresh ENU
}

export class STTColumnLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly opts: STTColumnLayerOptions;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly collection: PrimitiveCollection;
  private readonly appearance: PerInstanceColorAppearance;
  private primitive: Primitive | null = null;
  private entries: ColumnEntry[] = [];
  private attrsCached = false;
  private timeOrigin = 0;

  constructor(scene: Scene, options: STTColumnLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-columns';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.appearance = new PerInstanceColorAppearance({
      translucent: true, // the time filter animates alpha; opaque would clip it to on/off
      flat: options.flat ?? false,
      // A prism is a closed solid, so backface culling is both correct and
      // cheaper — but only when it is lit; `flat` draws the inside of the far
      // wall as the same colour anyway.
      closed: !(options.flat ?? false),
    });
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build the prisms from decoded tiles. Rebases all times to one origin. */
  setTiles(tiles: Tile[]): void {
    // Pure geometry/colour/lift assembly first — this method only turns each
    // FeatureColumn into a Cesium GeometryInstance.
    const build = buildColumnEntries(tiles, {
      color: this.opts.color,
      elevationProperty: this.opts.elevationProperty,
      defaultElevation: this.opts.defaultElevation,
      elevationScale: this.opts.elevationScale,
      radius: this.opts.radius,
      coverage: this.opts.coverage,
      baseElevationProperty: this.opts.baseElevationProperty,
      zLift: this.opts.zLift,
      timeHeightScale: this.opts.timeHeightScale,
      timeHeightOrigin: this.opts.timeHeightOrigin,
    });
    // Build BEFORE the teardown, and bail on an empty result while the old
    // prisms are still standing. Selection reports an empty visible set for the
    // frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame (the
    // "tiles genuinely in view flash out" symptom). Holding the previous
    // geometry is safe even when the emptiness is permanent: the prisms sit at
    // their true ECEF positions, which the camera has by then left behind.
    if (build.columns.length === 0) return; // also leaves the prior timeOrigin untouched
    this.collection.removeAll(); // destroys the standing primitive
    this.primitive = null;
    this.entries = [];
    this.attrsCached = false;
    this.timeOrigin = build.timeOrigin;

    const slices = prismSlices(this.opts.diskResolution);
    const angleRad = (this.opts.angle ?? 0) * DEG2RAD;
    const instances: GeometryInstance[] = [];
    for (const c of build.columns) {
      const id: InstanceId = {
        layerId: this.id,
        binary: c.binary,
        featureIndex: c.featureIndex,
      };
      instances.push(
        new GeometryInstance({
          geometry: new CylinderGeometry({
            length: c.height,
            topRadius: c.radius,
            bottomRadius: c.radius,
            slices,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          modelMatrix: columnModelMatrix(c, angleRad),
          attributes: {
            // Seed fully transparent; the first setTime writes the real alpha.
            color: ColorGeometryInstanceAttribute.fromColor(
              new Color(
                c.color[0] / 255,
                c.color[1] / 255,
                c.color[2] / 255,
                0,
              ),
            ),
          },
          id,
        }),
      );
      this.entries.push({
        id,
        start: c.start,
        end: c.end,
        r: c.color[0],
        g: c.color[1],
        b: c.color[2],
        a: (c.color[3] ?? 255) / 255,
        lastAlpha: NaN, // NaN !== anything → the first setTime always writes
        attrs: null,
        lon: c.lon,
        lat: c.lat,
        lift: c.lift,
      });
    }

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: this.appearance,
      asynchronous: false, // deterministic replace-all; no worker round-trip per tile load
    });
    this.collection.add(this.primitive);
  }

  /**
   * Advance to an absolute playhead time; recompute per-prism alpha via the
   * shared oracle and write it into the batch table. Handles come from
   * `getGeometryInstanceAttributes`, which only exists once the primitive has
   * rendered — so they are cached lazily on the first `ready` frame, and the
   * whole pass is skipped before that.
   */
  setTime(absoluteMs: number): void {
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
      if (alpha === e.lastAlpha || !e.attrs) continue; // unchanged → no GPU dirty
      e.lastAlpha = alpha;
      v[0] = e.r;
      v[1] = e.g;
      v[2] = e.b;
      v[3] = Math.round(alpha * 255);
      e.attrs.color = v; // setter copies the bytes into the batch table
    }
  }

  /** Hit-test → the shared `SttPickResult` (props joined via `getFeatureProperties`). */
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
   * Symmetric with the constructor. `PrimitiveCollection.remove` destroys the
   * collection, which (via `destroyPrimitives`) destroys the batched primitive
   * and with it the compiled shader program and vertex arrays. There is no
   * externally-supplied GPU resource left over: `PerInstanceColorAppearance` is
   * a shader-source + render-state DESCRIPTION, not an allocation — unlike
   * `STTTripsLayer`, whose `Material`s `PolylineCollection.removeAll()` would
   * leak, and which therefore destroys them by hand.
   */
  dispose(): void {
    this.scene.primitives.remove(this.collection);
    this.primitive = null;
    this.entries = [];
    this.attrsCached = false;
  }
}
