// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTPointCloudLayer` — the Three port of deck's `AnimatedPointLayer` for the AV
 * LIDAR point modes: raw points (height-band / seg-class categorical colour or
 * `r,g,b` camera colour), soft Gaussian `splat`, `scan` (wake sweep), and
 * worldbuild-on-points (cumulative). All tiles merge into one billboard-quad
 * `InstancedBufferGeometry`; the GPU time-filter handles per-frame visibility.
 */

import {
  Mesh,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Box3,
  Vector3,
  Sphere,
  DataTexture,
  RGBAFormat,
  FloatType,
  NearestFilter,
  ClampToEdgeWrapping,
} from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { TrackIndexMaintainer } from '@poopdeck.gl/core';
import type { TrackFieldConfig } from '@poopdeck.gl/core';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import { buildPointBuffers, type PointColorMode } from './point-buffers.js';
import {
  assembleKeyframes,
  type KeyframeField,
} from '../lib/track-keyframes.js';
import { GLIDE_ATTR } from '../tsl/motion-glide.js';
import {
  createPointMaterial,
  createPointIdMaterial,
  updatePointUniforms,
  type PointMaterialBundle,
  type PointSizeUnits,
} from '../tsl/point-material.js';
import type { TimeFilterMode } from '../tsl/time-filter-math.js';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import { InstanceProvenance, buildIdColors } from '@poopdeck.gl/core/picking';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';
import type { RGBA } from '../lib/color.js';

export interface STTPointCloudLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** window (raw) | wake (scan) | cumulative (worldbuild). @default 'window' */
  mode?: TimeFilterMode;
  /** Soft Gaussian point splat. @default false */
  splat?: boolean;

  // colour
  /** Categorical property (e.g. `height_band`, `seg_class`). */
  colorProperty?: string;
  /** `{ category → [r,g,b,a] 0–255 }`. */
  colorMapping?: Record<string, RGBA>;
  /** Colour for null / unmapped categories. @default [150,160,175,220] */
  colorMappingDefault?: RGBA;
  /** When set, colour from these RGB columns (0–255) instead of categorical. */
  rgbColumns?: [string, string, string] | null;
  /**
   * Continuous-ramp colour (deck `getColor` ramp). When set, each point is
   * coloured by sampling `rampRange` at `numericProps[rampProperty]` mapped
   * through `rampDomain`. Wins over the categorical path; ignored if unset.
   */
  rampProperty?: string | null;
  /** `[min,max]` value range mapped to the ramp's ends. @default [0,1] */
  rampDomain?: [number, number];
  /** Evenly-spaced gradient stops (≥1), each `[r,g,b,a]` (0–255). */
  rampRange?: RGBA[];

  // elevation
  /** Altitude column (metres). @default 'z' */
  elevationProperty?: string | null;
  elevationScale?: number;

  // size / opacity
  /**
   * Billboard half-size. World metres when `sizeUnits:'meters'` (default,
   * AV-unchanged), or CSS pixels when `sizeUnits:'pixels'`. @default 0.06
   */
  pointSize?: number;
  /**
   * `'meters'` = fixed metric size that shrinks with distance (AV default);
   * `'pixels'` = constant on-screen radius (deck `radiusUnits:'pixels'`).
   * Pixel sizing needs {@link viewport} pushed on resize. @default 'meters'
   */
  sizeUnits?: PointSizeUnits;
  /** Drawing-buffer size `[w,h]` px (pixel sizing only). @default [1280,720] */
  viewport?: [number, number];
  opacity?: number;
  splatFalloff?: number;

  // time params — full-width `timeWindow` + `fadeIn/OutDuration` and the
  // lower-level `windowHalf` (@default 250) / `fadeIn` / `fadeOut` aliases come
  // from ThreeTimeWindowOptions.
  wakeLength?: number;
  wakeTailScale?: number;
  alphaCutoff?: number;

  // ── motion-glide (motionInterpolation) ───────────────────────────────────────
  /**
   * Opt into the GPU "glide" render path. A point archive carries one row per
   * entity PER SAMPLE, so the GPU time-WINDOW path shows every sample in the
   * window at once — a moving entity POPS between its samples. With `interpolate`
   * on (and a resolvable {@link idProperty}), the layer instead pools samples
   * into per-entity tracks, fixed-rate-resamples each into a keyframe texture,
   * and the shader glides ONE instance per entity between the two keyframes
   * bracketing the playhead — zero per-frame CPU attribute writes. Gated:
   * `interpolate && !reducedMotion && idProperty && mode === 'window'`. Any unmet
   * (the default: off) leaves the GPU window/wake/cumulative path BYTE-IDENTICAL.
   * @default false
   */
  interpolate?: boolean;
  /**
   * Per-entity id column NAME grouping samples into one glide track (e.g.
   * aircraft `icao24`). Must be an EXACT per-entity id — a lossy id fuses
   * distinct entities. No effect unless {@link interpolate} is on. @default null
   */
  idProperty?: string | null;
  /**
   * Largest gap (ms) glide interpolates across; a wider gap HOLDS the entity's
   * last position instead of gliding a straight line it never travelled.
   * @default Infinity
   */
  maxInterpolationGap?: number;
  /**
   * Honour the viewer's reduced-motion preference: `true` disables glide and
   * DEGRADES to the discrete GPU window path. @default false
   */
  reducedMotion?: boolean;
  /**
   * Fixed-rate resample spacing (ms) for the keyframe texture (glide only).
   * Smaller = more faithful, wider texture rows. @default 1000
   */
  glideResampleIntervalMs?: number;
  /**
   * Cap on a glide track's resampled frame count (= texture columns).
   * @default 512
   */
  glideMaxFrames?: number;
}

const DEFAULT_FALLBACK: RGBA = [150, 160, 175, 220];

export class STTPointCloudLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: PointMaterialBundle | null = null;
  // Merged-buffer pick identity: merged instance i → (tileKey, featureIndex).
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: PointMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  // ── glide (motionInterpolation) state ────────────────────────────────────────
  private readonly interpolate: boolean;
  private readonly idProperty: string;
  private readonly maxInterpolationGap: number;
  private readonly reducedMotion: boolean;
  private readonly glideResampleIntervalMs: number;
  private readonly glideMaxFrames: number;
  /** Incremental id→track pooler (re-pools ADDED tiles / re-sorts AFFECTED tracks). */
  private maintainer: TrackIndexMaintainer | null = null;
  /** True while the current geometry is the glide path (drives setTime + uniforms). */
  private glideActive = false;
  private glideTexture: DataTexture | null = null;

  private readonly opts: Required<
    Omit<
      STTPointCloudLayerOptions,
      | 'id'
      | 'rgbColumns'
      | 'elevationProperty'
      | 'rampProperty'
      | 'timeWindow'
      | 'fadeInDuration'
      | 'fadeOutDuration'
      // Glide props are stored in dedicated fields, not `opts`.
      | 'interpolate'
      | 'idProperty'
      | 'maxInterpolationGap'
      | 'reducedMotion'
      | 'glideResampleIntervalMs'
      | 'glideMaxFrames'
    >
  > &
    Pick<
      STTPointCloudLayerOptions,
      'rgbColumns' | 'elevationProperty' | 'rampProperty'
    >;

  constructor(options: STTPointCloudLayerOptions = {}) {
    super();
    this.id = options.id ?? 'points';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.interpolate = options.interpolate ?? false;
    this.idProperty =
      typeof options.idProperty === 'string' ? options.idProperty : '';
    this.maxInterpolationGap = options.maxInterpolationGap ?? Infinity;
    this.reducedMotion = options.reducedMotion ?? false;
    this.glideResampleIntervalMs = options.glideResampleIntervalMs ?? 1000;
    this.glideMaxFrames = options.glideMaxFrames ?? 512;
    const tw = resolveTimeWindow(options, 250);
    this.opts = {
      mode: options.mode ?? 'window',
      splat: options.splat ?? false,
      colorProperty: options.colorProperty ?? '',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_FALLBACK,
      rgbColumns: options.rgbColumns === undefined ? null : options.rgbColumns,
      rampProperty:
        options.rampProperty === undefined ? null : options.rampProperty,
      rampDomain: options.rampDomain ?? [0, 1],
      rampRange: options.rampRange ?? [
        [30, 60, 120, 255],
        [240, 240, 80, 255],
      ],
      elevationProperty:
        options.elevationProperty === undefined
          ? 'z'
          : options.elevationProperty,
      elevationScale: options.elevationScale ?? 1,
      pointSize: options.pointSize ?? 0.06,
      sizeUnits: options.sizeUnits ?? 'meters',
      viewport: options.viewport ?? [1280, 720],
      opacity: options.opacity ?? 1,
      splatFalloff: options.splatFalloff ?? 3,
      windowHalf: tw.windowHalf,
      fadeIn: tw.fadeIn,
      fadeOut: tw.fadeOut,
      wakeLength: options.wakeLength ?? 60,
      wakeTailScale: options.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      alphaCutoff: options.alphaCutoff ?? 0.01,
    };
  }

  private colorMode(): PointColorMode {
    if (this.opts.rgbColumns) {
      return { type: 'rgb', columns: this.opts.rgbColumns, alpha: 1 };
    }
    if (this.opts.rampProperty) {
      return {
        type: 'ramp',
        property: this.opts.rampProperty,
        domain: this.opts.rampDomain,
        range: this.opts.rampRange,
        fallback: this.opts.colorMappingDefault,
      };
    }
    return {
      type: 'categorical',
      property: this.opts.colorProperty,
      mapping: this.opts.colorMapping,
      fallback: this.opts.colorMappingDefault,
    };
  }

  /**
   * True when the GPU glide path is active — `interpolate` on, reduced-motion
   * off, a resolvable `idProperty`, and window mode (glide replaces the window
   * path; wake/cumulative keep the discrete per-sample GPU path). Any unmet
   * condition (the default) leaves the static point path byte-identical.
   */
  private interpolationActive(): boolean {
    return (
      this.interpolate &&
      !this.reducedMotion &&
      this.idProperty.length > 0 &&
      this.opts.mode === 'window'
    );
  }

  /** TrackFieldConfig fed to the pooler: id + (categorical) colour only; points
   *  carry no per-keyframe heading/dims/speed in glide. */
  private glideTrackConfig(): TrackFieldConfig {
    return {
      trackIdProperty: this.idProperty,
      colorProperty: this.opts.colorProperty,
      labelProperty: '',
      headingProperty: '',
      lengthProperty: '',
      widthProperty: '',
      heightProperty: '',
      speedProperty: '',
      colorMapping: this.opts.colorMapping,
      colorMappingDefault: this.opts.colorMappingDefault,
    };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    if (this.interpolationActive()) {
      this.setTilesGlide(tiles, ctx);
      return;
    }
    this.glideActive = false;
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const buf = buildPointBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      colorMode: this.colorMode(),
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale,
    });
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;

    this.disposeGpu();
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
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    this.bundle = createPointMaterial({
      mode: this.opts.mode,
      splat: this.opts.splat,
      alphaCutoff: this.opts.alphaCutoff,
      sizeUnits: this.opts.sizeUnits,
    });
    this.object.geometry = geometry;
    this.object.material = this.bundle.material;
    // RTC: centres are relative to `origin`; lift the mesh by it. For the AV/ENU
    // frame origin ≈ [0,0,0] so this is a no-op (AV stays byte-identical).
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);
    this.pushUniforms(this.timeOrigin);
  }

  /**
   * Glide `setTiles`: pool the resident tiles' samples into per-entity tracks
   * (incrementally — the {@link TrackIndexMaintainer} re-pools only ADDED tiles
   * and re-sorts only AFFECTED tracks across churn), resample each into the
   * shared keyframe texture, and build ONE instanced billboard whose centres
   * glide on the GPU. Per-frame advance is a pure uniform write (`setTime`).
   */
  private setTilesGlide(tiles: Tile[], ctx: STTLayerContext): void {
    this.glideActive = true;
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    // Glide carries no merged-buffer provenance (per-track picking deferred): a
    // stale pick after a reload resolves to null rather than an old feature.
    this.provenance = new InstanceProvenance();
    this.binaryByTileKey = new Map();

    if (!this.maintainer) this.maintainer = new TrackIndexMaintainer();
    const result = this.maintainer.sync(tiles, this.glideTrackConfig());
    const field = assembleKeyframes(
      result.tracks.values(),
      ctx.projection,
      ctx.timeOrigin,
      {
        resampleIntervalMs: this.glideResampleIntervalMs,
        maxFrames: this.glideMaxFrames,
        maxGapMs: this.maxInterpolationGap,
      },
    );

    this.disposeGpu();
    if (field.count === 0) {
      this.object.geometry = makeBillboardQuadGeometry();
      this.object.position.set(0, 0, 0);
      this.object.visible = false;
      return;
    }
    this.object.visible = true;

    const texture = this.makeGlideTexture(field);
    this.glideTexture = texture;
    this.bundle = createPointMaterial({
      mode: 'window',
      splat: this.opts.splat,
      alphaCutoff: this.opts.alphaCutoff,
      sizeUnits: this.opts.sizeUnits,
      glide: { texture },
    });
    if (this.bundle.glide) {
      this.bundle.glide.invTexWidth.value = 1 / field.texWidth;
    }

    this.object.geometry = this.makeGlideGeometry(field);
    this.object.material = this.bundle.material;
    this.object.position.set(field.origin[0], field.origin[1], field.origin[2]);
    this.pushUniforms(this.timeOrigin);
  }

  /** RGBA-float keyframe texture (NEAREST — the shader does the two-column mix). */
  private makeGlideTexture(field: KeyframeField): DataTexture {
    const tex = new DataTexture(
      field.texData,
      field.texWidth,
      field.texHeight,
      RGBAFormat,
      FloatType,
    );
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** One instanced billboard: colour/time span + the `sttGlide*` row locators. */
  private makeGlideGeometry(field: KeyframeField): InstancedBufferGeometry {
    const geometry = makeBillboardQuadGeometry();
    geometry.instanceCount = field.count;
    geometry.setAttribute(
      'sttColor',
      new InstancedBufferAttribute(field.colors, 4),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(field.starts, 1),
    );
    geometry.setAttribute(
      'sttEnd',
      new InstancedBufferAttribute(field.ends, 1),
    );
    geometry.setAttribute(
      GLIDE_ATTR.t0,
      new InstancedBufferAttribute(field.t0, 1),
    );
    geometry.setAttribute(
      GLIDE_ATTR.invDt,
      new InstancedBufferAttribute(field.invDt, 1),
    );
    geometry.setAttribute(
      GLIDE_ATTR.frameMax,
      new InstancedBufferAttribute(field.frameMax, 1),
    );
    geometry.setAttribute(
      GLIDE_ATTR.rowV,
      new InstancedBufferAttribute(field.rowV, 1),
    );
    if (field.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...field.bbox.min),
        new Vector3(...field.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }
    return geometry;
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.pushUniforms(absoluteTimeMs);
  }

  /** Host pushes the drawing-buffer size on resize so `sizeUnits:'pixels'` points
   *  size against the live canvas (the per-frame `setTime` reads it). No-op for the
   *  default metre sizing. Mirrors STTWideLineLayer.setViewport. */
  setViewport(width: number, height: number): void {
    this.opts.viewport = [width, height];
  }

  private uniformValues(absoluteTimeMs: number) {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        // Glide emits ONE instance per entity spanning its whole active track;
        // visibility is exactly `[start,end]`, so windowHalf collapses to 0 (the
        // fadeIn/fadeOut ramps still give the appear/disappear feel).
        windowHalf: this.glideActive ? 0 : this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
        wakeLength: this.opts.wakeLength,
        wakeTailScale: this.opts.wakeTailScale,
      },
      pointSize: this.opts.pointSize,
      opacity: this.opts.opacity,
      splatFalloff: this.opts.splatFalloff,
      viewport: this.opts.viewport,
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updatePointUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: point specialisation) ──────────────────
  //
  // Two halves: `resolvePick` (pure, unit-tested — merged index → STTIdPickInfo
  // via the provenance buffer, the shared `resolveIdPick` seam) and `pick` (the
  // opt-in GPU id-pass + readback, which needs a live WebGPU device and is
  // browser-verify only).

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback)
   * to a normalised, kind-tagged {@link STTIdPickInfo} (`kind: 'point'`), or
   * `null` for a miss. Pure — call it directly if you already have a decoded
   * index from your own pick pass.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'point',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createPointIdMaterial({
        mode: this.opts.mode,
        splat: this.opts.splat,
        alphaCutoff: this.opts.alphaCutoff,
        sizeUnits: this.opts.sizeUnits,
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
   * GPU cloud pick — wired into the r3f `PickController` (a CPU box-pick miss
   * falls through to this). Renders this layer's cloud with the flat id material
   * into `picker`'s off-screen target, reads back the merged-instance id at CSS
   * pixel `(cssX, cssY)`, and resolves it through the provenance buffer. The
   * `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify per the package's test policy.
   *
   * Leaves normal rendering unchanged: the id material + `sttIdColor` attribute
   * are built lazily on first call and the render material is restored after the
   * readback (even on throw).
   *
   * NOTES:
   *  - Background handling lives in {@link GpuPicker}: it clears the id target to
   *    a sentinel (white = MAX_PICK_ID) so an empty pixel is a miss while feature
   *    index 0 (black) stays a valid hit. `featureCount` is passed so an id ≥ the
   *    instance count is likewise reported as a miss.
   *  - The object is rendered in isolation, so its parent chain must be identity
   *    (the ENU/AV scene root is) for its world matrix to match the live frame.
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
    // Sync the id material's time filter to the live playhead so only points
    // visible THIS frame are pickable.
    updatePointUniforms(idBundle, this.uniformValues(this.currentTimeMs));

    // Swap to the id material only for the picker's SYNCHRONOUS render window
    // (onBeforeRender → render → onAfterRender all run before the async readback
    // yields), so a concurrent main-scene render can't flash the id colours.
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
    this.idBundle?.material.dispose();
    this.idBundle = null;
    this.idColorsPresent = false;
    this.glideTexture?.dispose();
    this.glideTexture = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
