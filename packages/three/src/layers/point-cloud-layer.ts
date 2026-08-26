// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTPointCloudLayer` — phong-LIT 3D points with optional surface normals, the
 * Three port of deck's `AnimatedPointCloudLayer` (deck base: `PointCloudLayer`).
 *
 * It is the MIDDLE GROUND of this backend's three point-ish kinds:
 *   • {@link import('./point-layer.js').STTPointLayer} (`'point'`) — flat UNLIT
 *     billboards, optionally a soft gaussian splat, with the AV wake/cumulative
 *     modes and the motion-glide path. Fast, but a cloud of them reads as
 *     confetti: nothing in the image says which way a surface faces.
 *   • THIS layer (`'pointCloud'`) — one lit 3D point per feature: position,
 *     OPTIONAL normal, colour. Structure becomes visible without any baked
 *     covariance columns.
 *   • {@link import('./surfel-layer.js').STTSurfelLayer} (`'surfel'`) — oriented
 *     anisotropic gaussian surfels, which need `--surfel`-baked quaternion +
 *     scale columns and a soft temporal gaussian.
 *
 * NAMING: this file and the name `STTPointCloudLayer` previously held the FLAT
 * billboard kind; that class now lives in `./point-layer.ts` as `STTPointLayer`.
 * The two are deliberately distinct kinds with distinct pick tags (`'point'` vs
 * `'pointCloud'`), so a consumer narrowing on one never silently matches the
 * other.
 *
 * ── LIGHTING ─────────────────────────────────────────────────────────────────
 * This renderer is unlit end to end — every material is a
 * `MeshBasicNodeMaterial` and the host scene is not required to carry a single
 * light. Rather than break that posture for one kind (and render black in every
 * light-less scene), the shading is self-contained inside the TSL material:
 * a fixed-direction key light + an ambient floor, from material-level uniforms
 * defaulted to deck's out-of-the-box `PointCloudLayer` lighting. The full
 * rationale, the frame each variant's `lightDirection` is measured in, and the
 * deliberate omissions (no specular lobe, no second fill light, no shadow) are
 * documented in `../tsl/point-cloud-material.ts`.
 *
 * ── COLOUR ───────────────────────────────────────────────────────────────────
 * The same four-way resolution deck uses, in priority order: (1) an interleaved
 * `FixedSizeList<UInt8,4>` RGBA vector column; (2) three numeric `[r,g,b]`
 * columns (0–255); (3) a categorical column through the CPU palette /
 * `colorMapping`; (4) a constant colour. There is deliberately NO GPU
 * palette-texture path — it replaces colour after lighting and would render
 * categorical points flat and unshaded (see the material docstring).
 *
 * ── STRUCTURE ────────────────────────────────────────────────────────────────
 * All tiles merge into ONE billboard-quad `InstancedBufferGeometry` with an RTC
 * origin, and per-tile `startTimes` are rebased to the scene's common time
 * origin, so a single shared material and one `currentTime` uniform drive the
 * whole cloud and `setTime` is a pure uniform write. Tile arrivals churn
 * GEOMETRY only, never the shader/pipeline (audit E5): the material is built
 * once per NORMAL VARIANT, and the variant is STICKY — once any build has seen
 * a normal column the layer stays lit-by-normal for the rest of its life, so it
 * can flip at most ONCE (impostor → lit) and never back. That matters because
 * `hasNormals` is a property of the RESIDENT tiles, not of the archive: a mixed
 * archive whose normal-carrying tiles pan out of view would otherwise dispose
 * and rebuild the shader on a tile arrival. The pinned variant travels back
 * into the builder as `forceNormals`, which keeps `sttNormal` populated (deck's
 * default `[0,0,1]` where a tile has no column) rather than leaving the lit
 * graph reading an unbound, all-zero attribute.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { InstanceProvenance, buildIdColors } from '@poopdeck.gl/core/picking';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import {
  buildPointCloudBuffers,
  type PointCloudColorMode,
} from '../lib/point-cloud-buffers.js';
import {
  createPointCloudMaterial,
  createPointCloudIdMaterial,
  updatePointCloudUniforms,
  POINT_CLOUD_AMBIENT,
  POINT_CLOUD_DIFFUSE,
  POINT_CLOUD_LIGHT_DIRECTION,
  POINT_CLOUD_SIZE,
  type PointCloudMaterialBundle,
  type PointCloudSizeUnits,
} from '../tsl/point-cloud-material.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';
import type { RGBA } from '../lib/color.js';

export interface STTPointCloudLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /**
   * Gate each point by the window time-filter (hard vertex collapse + soft
   * fade). `false` renders the whole resident cloud at once — a static scan.
   * @default true
   */
  timeFiltered?: boolean;

  // ── colour (four-way; see the class docstring for precedence) ──────────────
  /**
   * Interleaved rgba(u8) vector column (`stt-build --vector-group`). Wins over
   * every other colour path on any tile that carries it; `null` disables the
   * probe. @default 'point_rgba'
   */
  colorVectorColumn?: string | null;
  /** Colour from these three numeric columns (0–255). @default null */
  rgbColumns?: [string, string, string] | null;
  /** Categorical property (e.g. `seg_class`, `classification`). */
  colorProperty?: string;
  /** `{ category → [r,g,b,a] 0–255 }` for {@link colorProperty}. */
  colorMapping?: Record<string, RGBA>;
  /** Colour for null / unmapped categories. @default [150,160,175,255] */
  colorMappingDefault?: RGBA;
  /** Constant colour when no other path resolves. @default [255,255,255,255] */
  color?: RGBA;

  // ── geometry ───────────────────────────────────────────────────────────────
  /**
   * `FixedSizeList<Float32,3>` column holding each point's surface normal.
   * Present ⇒ the shader lights that normal; absent ⇒ it lights a sphere
   * impostor instead. `null` ignores the column even when baked.
   * @default 'normal'
   */
  normalColumn?: string | null;
  /**
   * Altitude column (metres). `null` (the deck-parity default) takes z straight
   * from 3D tile geometry. NOTE `STTPointLayer` defaults this to `'z'` for the
   * AV LIDAR archives; this kind is generic, so it does not assume a column.
   * @default null
   */
  elevationProperty?: string | null;
  /** Multiplier on {@link elevationProperty}. @default 1 */
  elevationScale?: number;

  // ── size / opacity ─────────────────────────────────────────────────────────
  /**
   * Point RADIUS in {@link sizeUnits} (deck `pointSize`). @default 10
   */
  pointSize?: number;
  /**
   * `'pixels'` (default, deck parity) = constant on-screen radius at any depth,
   * which needs {@link viewport} pushed on resize; `'meters'` = fixed metric
   * radius that shrinks with distance. @default 'pixels'
   */
  sizeUnits?: PointCloudSizeUnits;
  /** Drawing-buffer size `[w,h]` px (pixel sizing only). @default [1280,720] */
  viewport?: [number, number];
  /** Constant multiplier on the per-point alpha. @default 1 */
  opacity?: number;
  /** Discard fragments below this alpha (disc edge). @default 0.01 */
  alphaCutoff?: number;

  // ── lighting (the self-contained term; see ../tsl/point-cloud-material.ts) ──
  /**
   * Unit direction FROM the surface TOWARD the key light, in the SHADING frame:
   * world (ENU) when the archive carries normals, view space when it does not.
   * @default the negation of deck's default `directionalLight0.direction`
   */
  lightDirection?: [number, number, number];
  /** Ambient floor (deck material `ambient`). @default 0.35 */
  ambient?: number;
  /** Key-light weight (deck material `diffuse`). @default 0.6 */
  diffuse?: number;

  // Window/fade params (`timeWindow` + `fadeIn/OutDuration`, and the
  // lower-level `windowHalf` (@default 250) / `fadeIn` / `fadeOut` aliases)
  // come from ThreeTimeWindowOptions.
}

const DEFAULT_FALLBACK: RGBA = [150, 160, 175, 255];
const DEFAULT_COLOR: RGBA = [255, 255, 255, 255];

export class STTPointCloudLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: PointCloudMaterialBundle | null = null;
  /** The `normals` variant the live colour material was built for. */
  private bundleNormals: boolean | null = null;
  /**
   * STICKY: set the first time a build reports a usable normal column, and
   * never cleared. It is fed back into the builder as `forceNormals`, so the
   * lit-by-normal variant survives a resident set that happens to carry no
   * normals — the difference between ONE material for the life of the layer and
   * a shader rebuild every time the mix of resident tiles changes (audit E5).
   */
  private normalsSeen = false;
  // Merged-buffer pick identity: merged instance i → (tileKey, featureIndex).
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: PointCloudMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  private readonly opts: Required<
    Omit<
      STTPointCloudLayerOptions,
      | 'id'
      | 'colorVectorColumn'
      | 'rgbColumns'
      | 'normalColumn'
      | 'elevationProperty'
      | 'timeWindow'
      | 'fadeInDuration'
      | 'fadeOutDuration'
    >
  > &
    Pick<
      STTPointCloudLayerOptions,
      'colorVectorColumn' | 'rgbColumns' | 'normalColumn' | 'elevationProperty'
    >;

  constructor(options: STTPointCloudLayerOptions = {}) {
    super();
    this.id = options.id ?? 'point-cloud';
    this.object.name = this.id;
    // Bounds come from the merged instances, set on the geometry below.
    this.object.frustumCulled = false;
    const tw = resolveTimeWindow(options, 250);
    this.opts = {
      timeFiltered: options.timeFiltered ?? true,
      colorVectorColumn:
        options.colorVectorColumn === undefined
          ? 'point_rgba'
          : options.colorVectorColumn,
      rgbColumns: options.rgbColumns === undefined ? null : options.rgbColumns,
      colorProperty: options.colorProperty ?? '',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_FALLBACK,
      color: options.color ?? DEFAULT_COLOR,
      normalColumn:
        options.normalColumn === undefined ? 'normal' : options.normalColumn,
      elevationProperty:
        options.elevationProperty === undefined
          ? null
          : options.elevationProperty,
      elevationScale: options.elevationScale ?? 1,
      pointSize: options.pointSize ?? POINT_CLOUD_SIZE,
      sizeUnits: options.sizeUnits ?? 'pixels',
      viewport: options.viewport ?? [1280, 720],
      opacity: options.opacity ?? 1,
      alphaCutoff: options.alphaCutoff ?? 0.01,
      lightDirection: options.lightDirection ?? [
        POINT_CLOUD_LIGHT_DIRECTION[0],
        POINT_CLOUD_LIGHT_DIRECTION[1],
        POINT_CLOUD_LIGHT_DIRECTION[2],
      ],
      ambient: options.ambient ?? POINT_CLOUD_AMBIENT,
      diffuse: options.diffuse ?? POINT_CLOUD_DIFFUSE,
      windowHalf: tw.windowHalf,
      fadeIn: tw.fadeIn,
      fadeOut: tw.fadeOut,
    };
  }

  /**
   * Paths 2–4 of the colour resolution (the interleaved RGBA vector column is
   * resolved per TILE inside the builder, because it either exists on that tile
   * or it does not). Explicit `rgbColumns` outrank a categorical property,
   * which outranks the constant colour — deck's order.
   */
  private colorMode(): PointCloudColorMode {
    if (this.opts.rgbColumns) {
      return { type: 'rgb', columns: this.opts.rgbColumns, alpha: 1 };
    }
    if (this.opts.colorProperty) {
      return {
        type: 'categorical',
        property: this.opts.colorProperty,
        mapping: this.opts.colorMapping,
        fallback: this.opts.colorMappingDefault,
      };
    }
    return { type: 'constant', color: this.opts.color };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const buf = buildPointCloudBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      colorMode: this.colorMode(),
      colorVectorColumn: this.opts.colorVectorColumn ?? null,
      normalColumn: this.opts.normalColumn ?? null,
      // Keep the pinned variant fed once we have committed to it — see
      // `normalsSeen`.
      forceNormals: this.normalsSeen,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale,
    });
    if (buf.hasNormals) this.normalsSeen = true;
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;

    this.disposeGeometry();
    // An EMPTY arrival keeps whatever variant is already live: `hasNormals` is
    // trivially false with nothing merged, and flipping the variant on it would
    // dispose the material — evicting three's nodeBuilderCache entry, program
    // and pipeline for a shader rebuild on the next real tile (audit E5).
    const bundle = this.ensureBundle(
      buf.count === 0 ? (this.bundleNormals ?? false) : buf.hasNormals,
    );
    this.object.material = bundle.material;
    if (buf.count === 0) {
      // No points: hide rather than draw the bare quad with no instances.
      this.object.geometry = makeBillboardQuadGeometry();
      this.object.position.set(0, 0, 0);
      this.object.visible = false;
      return;
    }
    this.object.visible = true;

    const geometry = makeBillboardQuadGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute(
      'sttCenter',
      new InstancedBufferAttribute(buf.centers, 3),
    );
    geometry.setAttribute(
      'sttColor',
      new InstancedBufferAttribute(buf.colors, 4),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    // Bound ONLY on the lit-by-normal variant — the impostor graph never
    // declares `sttNormal`, and an unread attribute is a wasted upload.
    if (buf.hasNormals) {
      geometry.setAttribute(
        'sttNormal',
        new InstancedBufferAttribute(buf.normals, 3),
      );
    }
    // Real cloud bounds (the base quad's are unit-scale and would mis-cull /
    // mis-frame) so `STTScene.computeBounds()` frames the camera correctly.
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    this.object.geometry = geometry;
    // RTC: centres are relative to `origin`; lift the mesh by it (an f64 CPU
    // transform). For the ENU/AV frame origin ≈ [0,0,0] so it is a no-op.
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);
    this.pushUniforms(this.timeOrigin);
  }

  /**
   * The colour material, built ONCE per NORMAL VARIANT (audit E5). Every other
   * input is fixed at construction, and `normals` only ever goes false → true
   * (see `normalsSeen`), so the variant flips at most once — the moment an
   * archive first reveals a normal column — and every later `setTiles` returns
   * the cached bundle. Disposing and rebuilding per arrival would evict three's
   * `nodeBuilderCache` entry, program and pipeline: a full shader rebuild per
   * tile arrival.
   */
  private ensureBundle(normals: boolean): PointCloudMaterialBundle {
    if (!this.bundle || this.bundleNormals !== normals) {
      this.bundle?.material.dispose();
      this.bundle = createPointCloudMaterial({
        timeFiltered: this.opts.timeFiltered,
        normals,
        sizeUnits: this.opts.sizeUnits,
        alphaCutoff: this.opts.alphaCutoff,
      });
      this.bundleNormals = normals;
    }
    return this.bundle;
  }

  /** Release the geometry (and the per-geometry pick attribute flag) only. */
  private disposeGeometry(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.idColorsPresent = false;
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.pushUniforms(absoluteTimeMs);
  }

  /**
   * Host pushes the drawing-buffer size on resize so `sizeUnits:'pixels'` points
   * size against the live canvas (the per-frame `setTime` reads it). No-op for
   * metre sizing. Duck-typed by the r3f mount; mirrors STTPointLayer.
   */
  setViewport(width: number, height: number): void {
    this.opts.viewport = [width, height];
  }

  private uniformValues(absoluteTimeMs: number) {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        windowHalf: this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
      },
      pointSize: this.opts.pointSize,
      opacity: this.opts.opacity,
      viewport: this.opts.viewport,
      lightDirection: this.opts.lightDirection,
      ambient: this.opts.ambient,
      diffuse: this.opts.diffuse,
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updatePointCloudUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: pointCloud specialisation) ──────────────
  //
  // Two halves: `resolvePick` (pure, unit-tested — merged index → STTIdPickInfo
  // via the provenance buffer, the shared `resolveIdPick` seam) and `pick` (the
  // opt-in GPU id-pass + readback, which needs a live WebGPU device and is
  // browser-verify only).

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback)
   * to a normalised, kind-tagged {@link STTIdPickInfo} (`kind: 'pointCloud'`),
   * or `null` for a miss. Pure — call it directly if you already have a decoded
   * index from your own pick pass.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'pointCloud',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      // The GATE options only — the id material is unlit by construction, so
      // the `normals` variant is irrelevant to it.
      this.idBundle = createPointCloudIdMaterial({
        timeFiltered: this.opts.timeFiltered,
        sizeUnits: this.opts.sizeUnits,
        alphaCutoff: this.opts.alphaCutoff,
      });
    }
    if (!this.idColorsPresent && this.provenance.length > 0) {
      // buildIdColors(count) paints merged instance i with the colour that
      // decodes back to i — exactly what `resolvePick` expects.
      const idColors = buildIdColors(this.provenance.length);
      this.object.geometry.setAttribute(
        'sttIdColor',
        new InstancedBufferAttribute(idColors, 3),
      );
      this.idColorsPresent = true;
    }
  }

  /**
   * GPU cloud pick — renders this layer's points with the flat id material into
   * `picker`'s off-screen target, reads back the merged-instance id at CSS pixel
   * `(cssX, cssY)`, and resolves it through the provenance buffer. The
   * `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify per the package's test policy.
   *
   * Leaves normal rendering unchanged: the id material + `sttIdColor` attribute
   * are built lazily on first call, and the render material is restored inside
   * the picker's synchronous render window (before the async readback yields),
   * so a concurrent main-scene render can never flash the id colours.
   *
   * `featureCount` is passed so a decoded id ≥ the instance count — including
   * the picker's white sentinel background — is reported as a miss, while
   * merged index 0 (black) stays a valid hit.
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<STTIdPickInfo | null> {
    if (this.provenance.length === 0 || !this.object.visible) return null;
    this.ensurePickPass();
    const idBundle = this.idBundle;
    if (!idBundle) return null;
    // Sync the id material's time filter (and sizing) to the live playhead so
    // only points visible THIS frame are pickable, at the size they drew.
    updatePointCloudUniforms(idBundle, this.uniformValues(this.currentTimeMs));

    const mesh = this.object;
    const renderMaterial = mesh.material;
    const index = await picker.pick(mesh, camera, cssX, cssY, {
      featureCount: this.provenance.length,
      onBeforeRender: () => {
        mesh.material = idBundle.material;
      },
      onAfterRender: () => {
        mesh.material = renderMaterial;
      },
    });
    if (index == null) return null;
    return this.resolvePick(index, [cssX, cssY]);
  }

  private disposeGpu(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.bundle?.material.dispose();
    this.bundle = null;
    this.bundleNormals = null;
    this.idBundle?.material.dispose();
    this.idBundle = null;
    this.idColorsPresent = false;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
