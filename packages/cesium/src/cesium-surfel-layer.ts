// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `surfel` for CesiumJS: ORIENTED, ANISOTROPIC surface elements — the Cesium
 * analogue of deck's `SplatLayer` and of `@poopdeck.gl/three`'s
 * `STTSurfelLayer`.
 *
 * A surfel is not a dot. It is an elliptical disk standing in its own local
 * surface frame: a baked quaternion whose rotation-matrix columns are
 * `[tangent | bitangent | normal]`, two DISTINCT in-plane half-extents
 * (`s_major`, `s_minor`, metres), a per-surfel RGB and a confidence folded
 * into its alpha. Reconstructed scenes (Gaussian-splat captures, LiDAR
 * surface reconstructions, photogrammetry) encode a wall as wide-and-short
 * disks lying IN the wall and the ground as broad disks lying flat; a
 * round billboard throws all of that away.
 *
 * Which is exactly what this backend used to do: `surfel` degraded to `point`,
 * losing the orientation and the two half-extents — the whole substance of the
 * kind. This layer restores both.
 *
 *   - centre     → `core/geo` `GlobeProjection({datum:'wgs84'})` → absolute
 *                  f64 ECEF metres (no RTC — `Cartesian3` is CPU doubles)
 *   - frame      → `lib/surfels` `surfelFrame` = `R_enu→ecef(lon,lat) · R_quat`,
 *                  the ENU-space baked quaternion rotated into Cesium's ECEF
 *                  world, per surfel at its OWN geodetic latitude
 *   - placement  → one `Matrix4` per surfel: the ECEF basis with the tangent
 *                  and bitangent columns scaled to the half-extents, the
 *                  normal left unit (the disk is flat), centre in translation.
 *                  A canonical unit disk carried by every `GeometryInstance`
 *                  is bent into place by that matrix, and all of them batch
 *                  into ONE `Primitive` — one draw-call bucket, no rebatch.
 *   - animation  → per-frame batch-table byte write of the alpha from the
 *                  shared `core/time-filter` `timeFilterAlpha` oracle, exactly
 *                  as `STTBatchedPolylineLayer` animates path/arc.
 *   - picking    → `scene.pick` → `{layerId, binary, featureIndex}` → the
 *                  shared `SttPickResult`.
 *
 * ── DOCUMENTED DEVIATIONS FROM DECK (the package rule: if Cesium cannot match
 *    deck pixel-for-pixel, SAY SO here rather than paper over it) ────────────
 *
 * 1. **No soft radial Gaussian.** deck rasterises a hexagon and lets the
 *    fragment shader carve a Gaussian falloff out of it — alpha ∝
 *    `exp(-½ r²)` across the disk. Cesium's stock appearances expose no
 *    radial hook: per-instance colour through the batch table is ONE colour
 *    for the whole instance (the same constraint that flattens this
 *    package's per-vertex gradients), and `src/shaders.ts` — the file the
 *    older comments point at for a custom-appearance path — was deleted.
 *    So the silhouette here is a HARD-EDGED ellipse: the polygon IS the
 *    outline, which is why its rim vertices sit ON the unit circle instead
 *    of circumscribing it, and why `diskSegments` (the silhouette
 *    resolution) is a real knob rather than a hexagon constant. Dense
 *    splat clouds therefore read crisper and more "tiled" than deck's, and
 *    overlapping surfels do not blend into a smooth surface.
 * 2. **No soft temporal Gaussian.** deck's splat fades a surfel in and out
 *    on a Gaussian in time whose width switches on the `is_dynamic` column.
 *    This backend animates every kind through the one shared
 *    `timeFilterAlpha` oracle (window / wake / cumulative / trail), so
 *    `is_dynamic` is deliberately not read: a second, private temporal
 *    curve here would put this layer out of step with every other layer on
 *    the same playhead. Use `timeFilter.fadeIn` / `fadeOut` for a soft edge.
 * 3. **Ellipse, not ellipsoid.** A surfel is a flat disk. The normal column
 *    of the model matrix stays UNIT — nothing is extruded along it — so a
 *    surfel viewed edge-on vanishes, as it does in deck.
 *
 * `EllipseGeometry` is deliberately NOT used: it draws a geodesic ellipse
 * lying ON the ellipsoid with a heading in the local tangent plane, which can
 * express neither a disk tilted out of that plane nor a wall-facing normal.
 *
 * Rendering needs a live Cesium `Scene`; the geometry/colour/frame maths is in
 * the Cesium-free `lib/surfels.ts` and is unit-tested in plain Node.
 */

import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  type GeometryAttributes,
  GeometryInstance,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveType,
  defined,
  type Scene,
} from 'cesium';
import {
  getFeatureProperties,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  buildSurfelEntries,
  diskIndices,
  surfelModelMatrix,
  unitDiskRim,
  type SurfelBuildOptions,
} from './lib/surfels.js';

export interface STTSurfelLayerOptions extends SurfelBuildOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /** Multiplier on BOTH in-plane half-extents. @default 1 */
  sizeScale?: number;
  /**
   * Floor on each half-extent AFTER `sizeScale`, in metres. A zero half-extent
   * makes the model matrix singular and the disk invisible; encoders do emit
   * zeros for degenerate surfels. @default 0.01
   */
  minimumSize?: number;
  /**
   * Rim vertices of the disk silhouette. Because there is no fragment falloff
   * (deviation 1), this polygon IS the outline. @default 12
   */
  diskSegments?: number;
  /** Global opacity multiplier folded into every surfel's base alpha. @default 1 */
  opacity?: number;
}

/** The pick id every instance carries; also the batch-table lookup key. */
interface SurfelInstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface SurfelEntry {
  id: SurfelInstanceId;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // base colour channels 0–255 — batch-table colours are u8
  g: number;
  b: number;
  a: number; // baked confidence × `opacity` (0..1), × the time-filter alpha
  lastAlpha: number; // last alpha written; skip the write when unchanged
  /** Batch-table colour handle; cached on the first `ready` frame. */
  attrs: { color: Uint8Array } | null;
  lon: number;
  lat: number;
}

// One shared scratch per mutable type, reused for every write so neither the
// build nor `setTime` allocates per surfel / per frame. Safe because JS is
// single-threaded and both run synchronously to completion, and because the
// consumers COPY out of them (`Matrix4.fromColumnMajorArray` constructs, the
// batch-table setter copies bytes) — the scratch never becomes the primitive's
// own storage, which is what would bypass Cesium's dirty check.
const SCRATCH_RGBA = new Uint8Array(4);
const SCRATCH_MATRIX = new Float64Array(16);

export class STTSurfelLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly opts: STTSurfelLayerOptions;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly sizeScale: number;
  private readonly minimumSize: number;
  private readonly segments: number;
  private readonly opacity: number;
  private primitive: Primitive | null = null;
  private timeOrigin = 0;
  private entries: SurfelEntry[] = [];
  private attrsCached = false;

  constructor(scene: Scene, options: STTSurfelLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-surfels';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.sizeScale = options.sizeScale ?? 1;
    this.minimumSize = options.minimumSize ?? 0.01;
    this.segments = Math.max(3, Math.floor(options.diskSegments ?? 12));
    this.opacity = options.opacity ?? 1;
    // Nothing is registered into `scene.primitives` until the first non-empty
    // `setTiles`: unlike a PointPrimitiveCollection, a `Primitive` is immutable
    // once built, so the collection here IS the batch and it is replaced whole.
  }

  /** (Re)build the surfel batch from decoded tiles. Rebases to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Pure frame/colour/rebase assembly lives in the Cesium-free builder; this
    // method only turns numbers into Cesium objects.
    const build = buildSurfelEntries(tiles, this.opts);
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitive is still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the
    // new set; tearing down first turns that transient into a blank frame (the
    // "tiles genuinely in view flash out" symptom). Holding the previous
    // surfels is safe even when the emptiness is permanent: they sit at their
    // true ECEF positions, which the camera has by then left behind.
    if (build.surfels.length === 0) return; // also leaves the prior timeOrigin untouched
    if (this.primitive) {
      this.scene.primitives.remove(this.primitive); // remove() destroys it
      this.primitive = null;
    }
    this.entries = [];
    this.attrsCached = false;
    this.timeOrigin = build.timeOrigin;

    // The canonical unit disk, shared as SOURCE data only: each instance gets
    // its own Float64Array copy, because `GeometryPipeline.transformToWorldCoordinates`
    // rewrites an instance's positions IN PLACE with its model matrix — one
    // shared buffer would be transformed once and then re-transformed by every
    // following surfel's matrix.
    const rim = unitDiskRim(this.segments);
    const indices = diskIndices(this.segments);
    const instances: GeometryInstance[] = [];

    for (const s of build.surfels) {
      const id: SurfelInstanceId = {
        layerId: this.id,
        binary: s.binary,
        featureIndex: s.featureIndex,
      };
      const a = s.a * this.opacity;
      instances.push(
        new GeometryInstance({
          geometry: new Geometry({
            // Cesium types `GeometryAttributes` with every slot required, but
            // the runtime only reads the ones an appearance's VertexFormat asks
            // for — `PerInstanceColorAppearance` with `flat: true` needs
            // position alone. The cast is the honest narrowing, not a shortcut:
            // supplying zeroed normal/st/tangent/bitangent/color buffers would
            // upload five unused attributes per surfel.
            attributes: {
              position: new GeometryAttribute({
                componentDatatype: ComponentDatatype.DOUBLE,
                componentsPerAttribute: 3,
                values: Float64Array.from(rim),
              }),
            } as unknown as GeometryAttributes,
            // A typed array, which is what `Geometry.indices` is declared to
            // take — it goes straight to the index buffer instead of a boxed
            // array being walked per surfel.
            indices: Uint16Array.from(indices),
            primitiveType: PrimitiveType.TRIANGLES,
            // Per instance, never shared: `transformToWorldCoordinates` also
            // rewrites the bounding sphere in place. Radius 1 around the unit
            // disk's own origin; the matrix's maximum column scale carries it
            // out to the real half-extent (conservative, which is the safe way
            // to be wrong about a culling volume).
            boundingSphere: new BoundingSphere(Cartesian3.ZERO, 1),
          }),
          // `fromColumnMajorArray` is declared over `number[]`, but it only
          // indexes its argument — a Float64Array reads identically and keeps
          // the per-surfel scratch un-boxed. Casting here rather than
          // materialising a 16-element array per surfel is the whole point of
          // SCRATCH_MATRIX.
          modelMatrix: Matrix4.fromColumnMajorArray(
            surfelModelMatrix(
              s,
              this.sizeScale,
              this.minimumSize,
              SCRATCH_MATRIX,
            ) as unknown as number[],
          ),
          attributes: {
            // Seed fully transparent; the first setTime writes the real alpha.
            color: ColorGeometryInstanceAttribute.fromColor(
              new Color(s.r / 255, s.g / 255, s.b / 255, 0),
            ),
          },
          id,
        }),
      );
      this.entries.push({
        id,
        start: s.start,
        end: s.end,
        r: s.r,
        g: s.g,
        b: s.b,
        a,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        attrs: null,
        lon: s.lon,
        lat: s.lat,
      });
    }

    this.primitive = new Primitive({
      geometryInstances: instances,
      // `flat` because a surfel carries its own baked shading in the RGB
      // column; re-lighting it would double-count the capture's own lighting.
      // `closed: false` leaves back-face culling off, so a disk is visible from
      // both sides — a surface element has no inside.
      appearance: new PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        closed: false,
      }),
      asynchronous: false, // deterministic replace-all; no worker round-trip per tile load
    });
    this.scene.primitives.add(this.primitive);
  }

  /**
   * Advance to an absolute playhead time; recompute per-surfel alpha via the
   * shared oracle and write it as a batch-table byte. Reuses one scratch
   * `Uint8Array` (zero allocations per frame) and skips surfels whose alpha is
   * unchanged since the last frame, so one fully in or fully out of the window
   * costs a single compare rather than a GPU dirty.
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
      if (alpha === e.lastAlpha || !e.attrs) continue;
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
      | { id?: SurfelInstanceId }
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
   * `primitives.remove()` destroys the `Primitive`, which releases its own
   * shaders, vertex arrays and batch table. `PerInstanceColorAppearance` owns
   * no `Material`, so — unlike `STTTripsLayer`, whose externally-supplied
   * polyline materials `removeAll()` does NOT release — there is no extra GPU
   * resource left dangling here.
   */
  dispose(): void {
    if (this.primitive) {
      this.scene.primitives.remove(this.primitive);
      this.primitive = null;
    }
    this.entries = [];
    this.attrsCached = false;
  }
}
