// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `polygon` for CesiumJS: time-filtered FILLED polygons — administrative units,
 * hex/quad cells, burn scars, flood extents, service areas, isochrones — each
 * fading in and out of its own `[start, end]` window, and optionally EXTRUDED
 * into a prism whose height comes from a numeric column. It is the kind that
 * turns an area table into a choropleth that moves.
 *
 * ── HOW IT DRAWS ─────────────────────────────────────────────────────────────
 * ONE batched `Primitive` of `PolygonGeometry` `GeometryInstance`s under a
 * shared `PerInstanceColorAppearance` — the same bargain `STTBatchedPolylineLayer`
 * and `STTColumnLayer` strike. Every polygon lands in one draw-call bucket, and
 * per-frame animation is a four-byte write into the batch table rather than a
 * rebatch, so alpha costs the same for ten polygons or ten thousand. Colour
 * handles come from `getGeometryInstanceAttributes`, which exists only after the
 * primitive's first render, so they are cached lazily on the first frame
 * `primitive.ready` is true (`setTime` runs on `scene.preRender`, every frame).
 *
 * A MultiPolygon feature emits one instance PER PART, each with its own `id`
 * OBJECT carrying the same `{layerId, binary, featureIndex}` triple. Cesium keys
 * the batch table by object IDENTITY (`===`), so distinct objects give each
 * island its own colour slot while picking any of them still resolves to the one
 * feature. The alternative — one hierarchy per feature — is not available:
 * `PolygonHierarchy` nests exterior/hole/exterior, it cannot hold two disjoint
 * exteriors at the top level.
 *
 * ── WHY `PolygonGeometry` AND NOT `CoplanarPolygonGeometry` ──────────────────
 * `CoplanarPolygonGeometry` takes the ring exactly as given and assumes it lies
 * in a PLANE. A geographic ring on the WGS84 ellipsoid does not: a country-sized
 * polygon's vertices bow away from any plane through them by kilometres, so the
 * coplanar fill would cut a flat chord through the globe, sinking its middle
 * below the terrain and lifting its edges off it. `PolygonGeometry` instead
 * projects the ring, tessellates in 2-D and re-drapes onto the ellipsoid, which
 * is what a map polygon means. (`CoplanarPolygonGeometry` remains the right tool
 * for small non-geographic quads — billboard-ish decals — which this layer is
 * not.) Flat fills are built with `perPositionHeight: true` so each vertex keeps
 * the altitude the builder gave it and Cesium adds no height-driven subdivision.
 *
 * ── NO MODEL MATRIX ──────────────────────────────────────────────────────────
 * The ENU-frame rule that binds `STTColumnLayer` (an identity rotation points a
 * prism at the ECEF spin axis, not local up) does not arise here: every vertex
 * is absolute f64 ECEF from the builder and the extrusion direction is Cesium's
 * own ellipsoid normal at each vertex. There is no `modelMatrix` to get wrong.
 *
 * ── DOCUMENTED DEVIATIONS FROM DECK (not silent approximations) ───────────────
 *  1. COLOUR IS ONE VALUE PER FEATURE, never per vertex. Batch-table animation
 *     has exactly one `ColorGeometryInstanceAttribute` per instance, so a deck
 *     polygon with a vertex-interpolated fill collapses to its source colour.
 *     Package-wide deviation, shared with the path/arc/column layers.
 *  2. NO `stroked` OUTLINE. deck's `PolygonLayer` draws fill + outline as two
 *     layers; the Cesium equivalent is a second primitive of
 *     `PolylineGeometry`/outline geometry with its own appearance and its own
 *     batch table — twice the draw calls and twice the per-frame writes. If you
 *     want borders, run `STTPathLayer` over the same tiles.
 *  3. NO `wireframe`. Same reason: a second primitive for a debug view.
 *  4. HEIGHT IS STATIC per build. deck's shader can rescale elevation per frame;
 *     here extrusion is baked into vertices, so changing `heightScale` means
 *     another `setTiles`. Alpha is the only per-frame channel.
 *  5. AN EXTRUDED FEATURE LOSES PER-VERTEX ALTITUDE. Cesium's extruded polygon
 *     spans two scalar heights (floor, roof); a 3-D tile's per-vertex z is
 *     therefore collapsed to the feature's first-vertex altitude when (and only
 *     when) an extrusion is requested. Flat fills keep every vertex's own z.
 *  6. `elevationScale` on a NEGATIVE column does not dig. The builder clamps a
 *     non-positive height to a flat fill, because Cesium reads a roof below its
 *     floor as a swap and would sink the polygon through the globe.
 *
 * Rendering needs a live `Scene` (a WebGL canvas), but every non-render seam —
 * the collection registration, the instance count, the ring/hole/part walk, the
 * batch-table writes, picking — is unit-tested in Node against a stub scene and
 * the real Cesium value types.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  PrimitiveCollection,
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
  buildPolygonEntries,
  type FeaturePolygon,
  type PolygonPart,
} from './lib/polygons.js';

export interface STTPolygonLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /** Per-feature colour (constant / categorical / ramp). @default translucent slate */
  color?: FeatureColorMode;
  /** Numeric column (metres) driving each polygon's extrusion. @default null */
  extrudedHeightProperty?: string | null;
  /** Extrusion in metres when no column resolves. 0 = a flat fill. @default 0 */
  extrudedHeight?: number;
  /** Multiplier on every extrusion. @default 1 */
  heightScale?: number;
  /** Constant altitude lift in metres, to keep a ground decal off the terrain. @default 0 */
  zLift?: number;
  /**
   * Force the appearance's shading. `undefined` picks per build: FLAT when
   * nothing in the set is extruded (a fill has no meaningful normal and flat
   * shading skips the normal attribute entirely), LIT when anything is, so
   * prism walls read as walls. @default undefined
   */
  flat?: boolean;
}

/** Pick/attribute identity for one polygon instance. */
interface InstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface PolygonEntry {
  /** One id per rendered PART; distinct objects, identical field values. */
  ids: InstanceId[];
  /** Batch-table colour handles, parallel to {@link ids}; cached on the first ready frame. */
  attrs: ({ color: Uint8Array } | null)[];
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // base colour channels (0–255) — batch-table colours are u8
  g: number;
  b: number;
  a: number; // base alpha 0..1, multiplied by the time-filter alpha
  lastAlpha: number;
  lon: number; // first vertex, for SttPickResult.coordinate
  lat: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

// Reused for every per-frame colour write; the batch-table setter copies the
// four bytes immediately, so one shared scratch is safe across every entry and
// every layer instance (JS is single-threaded and setTime runs synchronously to
// completion). Same argument as the point layer's SCRATCH_COLOR.
const SCRATCH_RGBA = new Uint8Array(4);

/** Ring (x,y,z interleaved f64) → the `Cartesian3[]` Cesium's hierarchy wants. */
function toCartesians(ring: Float64Array): Cartesian3[] {
  const n = ring.length / 3;
  const out: Cartesian3[] = new Array(n);
  for (let v = 0; v < n; v++) {
    out[v] = new Cartesian3(ring[v * 3], ring[v * 3 + 1], ring[v * 3 + 2]);
  }
  return out;
}

/** One part → a `PolygonHierarchy` of exterior + holes. */
function toHierarchy(part: PolygonPart): PolygonHierarchy {
  return new PolygonHierarchy(
    toCartesians(part.outer),
    part.holes.map((h) => new PolygonHierarchy(toCartesians(h))),
  );
}

export class STTPolygonLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PrimitiveCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTPolygonLayerOptions;
  private primitive: Primitive | null = null;
  private entries: PolygonEntry[] = [];
  private attrsCached = false;
  private timeOrigin = 0;

  constructor(scene: Scene, options: STTPolygonLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-polygons';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    // Own a collection rather than adding the Primitive to scene.primitives
    // directly: the layer's slot in the render order is then fixed at
    // construction and survives every replace-all rebuild.
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build polygons from decoded tiles. Rebases all times to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Pure geometry/colour/rebase assembly lives in the Cesium-free builder;
    // this method only turns each FeaturePolygon into GeometryInstances.
    const build = buildPolygonEntries(tiles, {
      color: this.opts.color,
      extrudedHeightProperty: this.opts.extrudedHeightProperty,
      extrudedHeight: this.opts.extrudedHeight,
      heightScale: this.opts.heightScale,
      zLift: this.opts.zLift,
    });
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitive is still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the
    // new set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous
    // polygons is safe even when the emptiness is permanent: they sit at their
    // true ECEF positions, which the camera has by then left behind.
    if (build.polygons.length === 0) return; // also leaves the prior timeOrigin untouched

    this.collection.removeAll(); // destroys the standing Primitive + its batch table
    this.primitive = null;
    this.entries = [];
    this.attrsCached = false;
    this.timeOrigin = build.timeOrigin;

    // Pick the shading ONCE, before any geometry is built: the appearance and
    // every geometry's vertexFormat must agree, or Cesium throws on the missing
    // normal attribute.
    const anyExtruded = build.polygons.some((p) => p.topHeight > p.baseHeight);
    const flat = this.opts.flat ?? !anyExtruded;
    const vertexFormat = flat
      ? PerInstanceColorAppearance.FLAT_VERTEX_FORMAT
      : PerInstanceColorAppearance.VERTEX_FORMAT;

    const instances: GeometryInstance[] = [];
    for (const p of build.polygons) {
      const entry: PolygonEntry = {
        ids: [],
        attrs: [],
        start: p.start,
        end: p.end,
        r: p.color[0],
        g: p.color[1],
        b: p.color[2],
        a: (p.color[3] ?? 255) / 255,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        lon: p.lon,
        lat: p.lat,
        binary: p.binary,
        featureIndex: p.featureIndex,
      };
      for (const part of p.parts) {
        // A fresh object per part: Cesium's batch table looks ids up by `===`,
        // so sharing one object across parts would give them one shared slot.
        const id: InstanceId = {
          layerId: this.id,
          binary: p.binary,
          featureIndex: p.featureIndex,
        };
        instances.push(
          new GeometryInstance({
            geometry: this.geometryFor(p, part, vertexFormat),
            attributes: {
              // Seed fully transparent; the first setTime writes the real alpha.
              color: ColorGeometryInstanceAttribute.fromColor(
                new Color(
                  p.color[0] / 255,
                  p.color[1] / 255,
                  p.color[2] / 255,
                  0,
                ),
              ),
            },
            id,
          }),
        );
        entry.ids.push(id);
        entry.attrs.push(null);
      }
      this.entries.push(entry);
    }

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({
        translucent: true, // the whole point: alpha is the animation channel
        closed: false, // flat fills are open surfaces; culling them would blank half of them
        flat,
      }),
      asynchronous: false, // deterministic replace-all; no worker round-trip per tile load
    });
    this.collection.add(this.primitive);
  }

  /**
   * Flat fills keep every vertex's own altitude (`perPositionHeight`); extruded
   * ones span the two scalar heights the builder resolved — see deviation 5.
   */
  private geometryFor(
    p: FeaturePolygon,
    part: PolygonPart,
    vertexFormat: PerInstanceColorAppearance['vertexFormat'],
  ): PolygonGeometry {
    const polygonHierarchy = toHierarchy(part);
    if (p.topHeight > p.baseHeight) {
      // Cesium SORTS these two: whichever is larger becomes the roof. Passing
      // floor-then-roof is the idiomatic order and the sort makes it exact, so
      // the prism always spans [baseHeight, topHeight] regardless of sign work
      // upstream.
      return new PolygonGeometry({
        polygonHierarchy,
        height: p.baseHeight,
        extrudedHeight: p.topHeight,
        vertexFormat,
      });
    }
    return new PolygonGeometry({
      polygonHierarchy,
      perPositionHeight: true,
      vertexFormat,
    });
  }

  /**
   * Advance to an absolute playhead time; recompute per-feature alpha via the
   * shared `timeFilterAlpha` oracle and write it into the batch table. Reuses
   * one scratch `Uint8Array` (zero allocations per frame) and skips features
   * whose alpha is unchanged since the last frame, so a polygon fully in or
   * fully out of the window costs a single compare rather than a GPU dirty.
   */
  setTime(absoluteMs: number): void {
    const prim = this.primitive;
    if (!prim || !prim.ready) return; // the batch table exists only after the first render
    if (!this.attrsCached) {
      for (const e of this.entries) {
        for (let i = 0; i < e.ids.length; i++) {
          e.attrs[i] = prim.getGeometryInstanceAttributes(e.ids[i]) as {
            color: Uint8Array;
          };
        }
      }
      this.attrsCached = true;
    }

    const cur = absoluteMs - this.timeOrigin;
    const v = SCRATCH_RGBA;
    for (const e of this.entries) {
      const alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      if (alpha === e.lastAlpha) continue; // identical to the last write — nothing to dirty
      e.lastAlpha = alpha;
      v[0] = e.r;
      v[1] = e.g;
      v[2] = e.b;
      v[3] = Math.round(alpha * 255);
      for (const attrs of e.attrs) {
        if (attrs) attrs.color = v; // the setter copies the four bytes out
      }
    }
  }

  /** Hit-test → the shared `SttPickResult` (feature props joined via `getFeatureProperties`). */
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
      (e) => e.binary === binary && e.featureIndex === featureIndex,
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
    // removeAll() destroys the contained Primitive (and with it the geometry and
    // batch table); the appearance holds no Material, so nothing else is owned.
    // Removing the collection afterwards is what un-registers us from the scene.
    this.collection.removeAll();
    this.scene.primitives.remove(this.collection);
    this.primitive = null;
    this.entries = [];
  }
}
