// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Lit 3-D point clouds for CesiumJS — the Cesium analogue of deck's
 * `AnimatedPointCloudLayer`, and this backend's `pointCloud` kind (which until
 * now degraded to `point`).
 *
 * WHAT IT RENDERS: one lit point per Point feature, carrying a genuine
 * ELEVATION and an optional surface NORMAL. Those two things are the whole
 * difference from {@link STTPointLayer}, the package's flat sibling:
 *
 *   - ELEVATION is free here and nowhere else. Cesium's positions are absolute
 *     f64 ECEF, so a point's altitude is just the third argument to
 *     `GlobeProjection.project` — no height-above-ellipsoid uniform, no RTC
 *     origin, no f32 range problem. The altitude comes from an
 *     `elevationProperty × elevationScale` column when named, else from the
 *     tile's own 3-D geometry z.
 *   - LIGHTING comes from an optional `FixedSizeList<Float32,3>` normal column
 *     through a Lambert term. Which brings us to the one real design choice.
 *
 * ── THE TRADE-OFF, AND WHICH SIDE OF IT THIS FILE IS ON ─────────────────────
 * `PointPrimitiveCollection` gives elevation, depth-correct occlusion against
 * terrain, one draw-call bucket, and a per-point colour we can animate — but it
 * has NO shader hook, so it cannot shade per fragment. The two ways out:
 *
 *   (i)  stay on `PointPrimitiveCollection` and BAKE a per-point Lambert term
 *        (normal · fixed light direction) into the per-point COLOUR at build
 *        time; or
 *   (ii) build a `Primitive` of per-point quad geometry with a custom
 *        `Appearance` whose fragment shader lights the interpolated normal.
 *
 * **This layer takes (i).** Why: (ii) multiplies a cloud's vertex count by four
 * and its index count by six, replaces one `PointPrimitiveCollection.add` per
 * point with a `GeometryInstance` per point, and — decisively — resurrects a
 * GLSL surface in a backend that has none. `src/shaders.ts` was DELETED; there
 * is no appearance-side alpha path here, and every animated layer in this
 * package writes its per-frame alpha from the CPU. A custom `Appearance` would
 * make `pointCloud` the sole kind whose time filter lives in a shader, which is
 * exactly the divergence `test/time-filter-oracle.test.ts` exists to prevent.
 *
 * WHAT (i) COSTS, stated plainly rather than hidden:
 *   - The light is FIXED AT BUILD TIME. Move it and the shading is stale until
 *     the next `setTiles`; there is no `setLightDirection` because honouring one
 *     would mean re-walking every point's colour anyway, which is what a rebuild
 *     already does.
 *   - The shading is per POINT, not per fragment. A point is a screen-space
 *     splat with one colour: no specular highlight across it, no normal
 *     interpolation, no sphere-impostor curvature (which is what three's
 *     normal-less variant fakes in its fragment stage from the billboard uv).
 *     A cloud with NO normal column therefore renders exactly as `point` does,
 *     at full shade — deliberately, because there is nothing to light.
 *   - `pixelSize` is screen pixels. deck's `sizeUnits: 'meters' | 'common'` has
 *     no analogue on `PointPrimitiveCollection`; metre-sized points are a
 *     property of geometry, and geometry is precisely what path (ii) buys.
 *
 * All three are documented deviations from deck, not silent approximations.
 *
 * Per-frame alpha is unchanged from every other layer here: `timeFilterAlpha`
 * from the core oracle, MULTIPLIED into the baked shaded colour's alpha channel
 * (`a × timeFilterAlpha`) — it never replaces the shading, and the shade never
 * touches A. Lighting darkens a surface; it does not dissolve it.
 *
 * Colour resolution and the normal/elevation column contracts live in the pure
 * builder, `lib/point-clouds.ts`. Rendering needs a live Cesium `Scene`, so the
 * visual result is browser-verify-only; everything this file decides is unit
 * tested against a stub `Scene` and a real `PointPrimitiveCollection`.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  PointPrimitiveCollection,
  defined,
  type PointPrimitive,
  type Scene,
} from 'cesium';
import { getFeatureProperties, type Tile } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  buildPointCloudEntries,
  type PointCloudBuildOptions,
} from './lib/point-clouds.js';

export interface STTPointCloudLayerOptions extends PointCloudBuildOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /**
   * Point size in SCREEN PIXELS (see the header: there is no metric sizing on
   * this primitive). Smaller than {@link STTPointLayer}'s 6 because a cloud is
   * dense by construction — at 6 px a LiDAR sweep is a solid sheet. @default 4
   */
  pixelSize?: number;
}

interface CloudEntry {
  pp: PointPrimitive;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // SHADED colour channels, pre-normalized to 0..1 by the builder
  g: number;
  b: number;
  a: number; // base alpha (0..1), multiplied by the time-filter alpha
  lastAlpha: number; // last alpha written; skip the setter when unchanged
  lon: number;
  lat: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

// One shared per-frame colour scratch, exactly as `STTPointLayer` argues for it:
// JS is single-threaded and `setTime` runs to completion synchronously, and the
// Cesium setter CLONES the value out. It MUST stay a distinct object from each
// primitive's internal `_color` — mutating that in place would bypass the
// `Color.equals` dirty check and freeze the animation.
const SCRATCH_COLOR = new Color();

export class STTPointCloudLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PointPrimitiveCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTPointCloudLayerOptions;
  private readonly pixelSize: number;
  private timeOrigin = 0;
  private entries: CloudEntry[] = [];
  private lit = false;

  constructor(scene: Scene, options: STTPointCloudLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-point-cloud';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.pixelSize = options.pixelSize ?? 4;
    this.collection = new PointPrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /**
   * Whether the resident tiles actually carried usable normals — i.e. whether
   * the shading in the collection varies by geometry at all. DIAGNOSTIC only:
   * unlike three, nothing branches on it, because baked shading has no material
   * variant to pin and a tile arrival that flips the verdict simply re-bakes.
   */
  get hasNormals(): boolean {
    return this.lit;
  }

  /** (Re)build the cloud from decoded tiles. Rebases all times to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Projection, elevation, colour resolution, normal lookup and the baked
    // Lambert term all happen in the Cesium-free builder; this method only turns
    // each CloudPoint into a Cesium primitive.
    const build = buildPointCloudEntries(tiles, this.opts);
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitives are still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous cloud is
    // safe even when the emptiness is permanent: it sits at its true ECEF
    // positions, which the camera has by then left behind.
    if (build.points.length === 0) return; // also leaves the prior timeOrigin untouched
    this.collection.removeAll();
    this.entries = [];
    this.timeOrigin = build.timeOrigin;
    this.lit = build.hasNormals;

    const pixelSize = this.pixelSize;
    for (const p of build.points) {
      const pp = this.collection.add({
        position: new Cartesian3(p.x, p.y, p.z),
        color: new Color(p.r, p.g, p.b, p.a),
        pixelSize,
        id: {
          layerId: this.id,
          binary: p.binary,
          featureIndex: p.featureIndex,
        },
      });
      this.entries.push({
        pp,
        start: p.start,
        end: p.end,
        r: p.r,
        g: p.g,
        b: p.b,
        a: p.a,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        lon: p.lon,
        lat: p.lat,
        binary: p.binary,
        featureIndex: p.featureIndex,
      });
    }
  }

  /**
   * Advance to an absolute playhead time; recompute per-point alpha via the
   * shared `timeFilterAlpha` oracle. The RGB channels are the BAKED shaded
   * colour and are rewritten verbatim — the time filter owns A and only A.
   * Reuses one scratch `Color` (zero allocations per frame) and skips points
   * whose alpha is unchanged since the last frame, so a point fully in or fully
   * out of the window costs one compare rather than a write plus a GPU dirty.
   */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const c = SCRATCH_COLOR;
    for (const e of this.entries) {
      const alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      if (alpha === e.lastAlpha) continue; // colour identical to last write
      e.lastAlpha = alpha;
      c.red = e.r;
      c.green = e.g;
      c.blue = e.b;
      c.alpha = alpha;
      e.pp.color = c; // setter clones the scratch into the primitive's own _color
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

  /**
   * Symmetric with the constructor. `PrimitiveCollection.remove` destroys the
   * collection, and — unlike `STTTripsLayer`, which must `destroyMaterials()`
   * because `PolylineCollection.removeAll()` leaks externally-supplied
   * `Material`s — this layer hands Cesium no external GPU resource at all: the
   * shading is baked into plain `Color`s, so there is no material, no texture
   * and nothing left for a `destroy()` of our own to release.
   */
  dispose(): void {
    this.scene.primitives.remove(this.collection);
    this.entries = [];
    this.lit = false;
  }
}
