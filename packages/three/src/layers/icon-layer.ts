// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTIconLayer` — directional billboard markers, the Three port of deck's
 * `AnimatedIconLayer`. One {@link createIconMaterial} billboard-quad instance per
 * Point feature, rotated by a per-feature heading/bearing column and textured from
 * a shared icon atlas the host supplies. Unlocks AIS-vessel / aircraft
 * directional-marker demos.
 *
 * All tiles merge into one billboard-quad `InstancedBufferGeometry`; the GPU
 * time-filter handles per-frame visibility. RTC: positions are relative to a
 * shared `origin` written to `object.position` so large mercator/globe magnitudes
 * stay in the f64 CPU transform (no-op in the ENU/AV frame).
 *
 * Sizing is in **screen pixels** (deck `STTIconLayer`'s default `sizeUnits`), so the
 * host must push the drawing-buffer size via {@link setViewport} on resize.
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
import type { Texture } from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { TrackIndexMaintainer } from '@poopdeck.gl/core';
import type { TrackColor, TrackFieldConfig } from '@poopdeck.gl/core';
import { InstanceProvenance, buildIdColors } from '@poopdeck.gl/core/picking';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import {
  buildIconBuffers,
  type IconColorMode,
  type IconMappingEntry,
} from '../lib/icon-buffers.js';
import {
  assembleKeyframes,
  type KeyframeField,
} from '../lib/track-keyframes.js';
import { GLIDE_ATTR } from '../tsl/motion-glide.js';
import {
  createIconMaterial,
  createIconIdMaterial,
  updateIconUniforms,
  type IconMaterialBundle,
  type IconMode,
  type IconUniformValues,
} from '../tsl/icon-material.js';
import type { RGBA } from '../lib/color.js';
import { buildStablePalette, type StablePalette } from '../lib/palette.js';
import { makePaletteTexture } from '../tsl/palette.js';
import type { DataFilterRange } from '../tsl/data-filter.js';
import {
  resolveIdPick,
  type SttIdPickInfo,
  type SttIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface STTIconLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** window (raw) | wake (trailing comet tail) | cumulative (markers persist) |
   *  none. @default 'window' */
  mode?: IconMode;

  // ── atlas (host provides the loaded image) ───────────────────────────────────
  /** The loaded icon-atlas texture. Required to render anything. */
  atlas: Texture;
  /** Pixel dimensions of the atlas — used to normalize `iconMapping` to 0..1 UV. */
  atlasWidth: number;
  atlasHeight: number;
  /** Named sub-rectangles into the atlas. */
  iconMapping: Record<string, IconMappingEntry>;
  /** The single icon name (a key of `iconMapping`) used for every feature. @default 'marker' */
  icon?: string;
  /** `mask` icons take colour from the tint; opaque icons modulate it. @default false */
  mask?: boolean;

  // ── rotation (the headline directional feature) ──────────────────────────────
  /** Numeric column of headings in DEGREES (CCW from up), e.g. 'heading' / 'cog'. */
  angleProperty?: string | null;
  /** Constant rotation (degrees) when `angleProperty` is null/absent. @default 0 */
  angle?: number;

  // ── size (on-screen pixels) ──────────────────────────────────────────────────
  /** Numeric column for per-feature pixel size. */
  sizeProperty?: string | null;
  /** Constant on-screen size (pixels). @default 12 */
  size?: number;
  /** Global multiplier on every instance size (deck `sizeScale`). @default 1 */
  sizeScale?: number;
  sizeMinPixels?: number;
  sizeMaxPixels?: number;

  // ── tint ─────────────────────────────────────────────────────────────────────
  /** Categorical tint property; when null the constant `color` applies. */
  colorProperty?: string | null;
  /** `{ category → [r,g,b,a] 0–255 }` for categorical tint. */
  colorMapping?: Record<string, RGBA>;
  /** Tint for null / unmapped categories, or the constant tint. @default [255,255,255,255] */
  color?: RGBA;
  // ── Stable categorical tint (deck CategoryColorExtension) ──────────────────
  /**
   * Opt into the GPU stable-palette path for a categorical `colorProperty` tint
   * (STATIC icon path). A given vessel/aircraft category then tints the SAME
   * colour in every tile and recolouring is a palette-texture swap. Off (default),
   * a constant tint, or the glide path (whose per-entity tint is already stable)
   * leave the tint path BYTE-IDENTICAL. @default false
   */
  stableColorMapping?: boolean;
  /** Positional palette (deck `colorPalette`) for the auto/hash/order paths of
   *  {@link stableColorMapping}; ignored when `colorMapping` is non-empty. */
  colorPalette?: RGBA[];
  /** Optional global category ordering for {@link stableColorMapping} (position
   *  instead of hash); ignored when `colorMapping` is non-empty. */
  categoryOrder?: string[];

  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU marker filter (`sttFilterValue`, per icon).
   * When set, the material installs the filter and each marker is gated by
   * {@link filterRange} / {@link filterSoftRange} (hard range → the quad
   * collapses to zero area alongside the time/wake gates, soft band → fade).
   * STATIC icon path only — the glide (motionInterpolation) path pools per-entity
   * tracks and carries no per-sample filter column, so a filter set together with
   * an active glide is a no-op there. @default null (no filter)
   */
  filterProperty?: string | null;
  /** Inclusive `[min,max]` hard range; `null` idles the filter. @default null */
  filterRange?: DataFilterRange | null;
  /** `[min,max]` inside {@link filterRange} fading instead of hard-clipping. @default null */
  filterSoftRange?: DataFilterRange | null;
  /** Enable/disable the marker filter. @default true */
  filterEnabled?: boolean;

  // ── elevation ────────────────────────────────────────────────────────────────
  elevationProperty?: string | null;
  elevationScale?: number;

  // ── opacity / time params ────────────────────────────────────────────────────
  opacity?: number;
  alphaCutoff?: number;
  // Full-width `timeWindow` + `fadeIn/OutDuration` and the lower-level
  // `windowHalf`/`fadeIn`/`fadeOut` aliases come from ThreeTimeWindowOptions.

  // ── wake (trailing comet tail — deck `wakeLength`/`wakeTailScale`) ────────────
  /**
   * Wake length (ms) — the trailing comet tail behind a moving marker. Effective
   * only in `mode: 'wake'`: each icon is visible while
   * `0 <= currentTime - startTime <= wakeLength`, its ALPHA fading linearly to 0
   * AND its size tapering toward {@link wakeTailScale} at the trailing edge (the
   * icon analogue of the point layer's ship-wake). Gated off under
   * {@link reducedMotion} (the wake collapses to a static window marker). Deck
   * prop name. @default 0
   */
  wakeLength?: number;
  /**
   * Trailing-edge size multiplier for wake mode (0..1): the tail shrinks toward
   * `wakeTailScale × headSize` while the head stays full size. Deck prop name.
   * @default 0.15 (DEFAULT_WAKE_TAIL_SCALE)
   */
  wakeTailScale?: number;

  // ── motion-glide (motionInterpolation) ───────────────────────────────────────
  /**
   * Opt into the GPU "glide" path. An icon archive carries one row per entity
   * PER SAMPLE, so the GPU window path pops a marker between its samples. With
   * `interpolate` on (and a resolvable {@link idProperty}), the layer pools
   * samples into per-entity tracks, resamples BOTH position AND heading into a
   * keyframe texture, and the shader glides + turns ONE marker per entity
   * smoothly between the bracketing samples — zero per-frame CPU writes. Gated:
   * `interpolate && !reducedMotion && idProperty && mode === 'window'`. Any unmet
   * (the default: off) leaves the static icon path BYTE-IDENTICAL.
   * @default false
   */
  interpolate?: boolean;
  /**
   * Per-entity id column NAME grouping samples into one glide track (e.g. AIS
   * `mmsi`, aircraft `icao24`). Must be an EXACT per-entity id. No effect unless
   * {@link interpolate} is on. @default null
   */
  idProperty?: string | null;
  /**
   * Largest gap (ms) glide interpolates across; wider gaps HOLD the last pose.
   * @default Infinity
   */
  maxInterpolationGap?: number;
  /** Honour reduced-motion: `true` disables glide (degrades to the window path). @default false */
  reducedMotion?: boolean;
  /** Fixed-rate resample spacing (ms) for the keyframe texture. @default 1000 */
  glideResampleIntervalMs?: number;
  /** Cap on a glide track's resampled frame count (= texture columns). @default 512 */
  glideMaxFrames?: number;
}

const DEFAULT_TINT: RGBA = [255, 255, 255, 255];

export class STTIconLayer extends BaseSttLayer implements SttIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: IconMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  private readonly opts: STTIconLayerOptions;

  // ── GPU id-buffer pick identity (merged instance i → (tileKey, featureIndex)) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: IconMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  // ── glide (motionInterpolation) state ────────────────────────────────────────
  private maintainer: TrackIndexMaintainer | null = null;
  private glideTexture: DataTexture | null = null;
  // ── stable-palette (categorical tint) state ─────────────────────────────────
  private paletteTexture: DataTexture | null = null;

  constructor(options: STTIconLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'icons';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so pixel sizing is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  private colorMode(): IconColorMode {
    if (this.opts.colorProperty) {
      return {
        type: 'categorical',
        property: this.opts.colorProperty,
        mapping: this.opts.colorMapping ?? {},
        fallback: this.opts.color ?? DEFAULT_TINT,
      };
    }
    return { type: 'constant', color: this.opts.color ?? DEFAULT_TINT };
  }

  /**
   * Resolve the GPU stable-palette tint path (property + palette) when
   * `stableColorMapping` is on and a categorical `colorProperty` is set; else null
   * (byte-identical CPU tint path). STATIC path only — the glide path bakes a
   * per-entity tint that is already stable across tiles. CPU-only; the palette
   * TEXTURE is built after `disposeGpu` in `setTiles`.
   */
  private resolveCategoryPalette(): {
    property: string;
    palette: StablePalette;
  } | null {
    if (this.opts.stableColorMapping !== true) return null;
    const prop = this.opts.colorProperty;
    if (!prop) return null;
    const palette = buildStablePalette({
      colorMapping: this.opts.colorMapping,
      colorMappingDefault: this.opts.color ?? DEFAULT_TINT,
      palette: this.opts.colorPalette,
      categoryOrder: this.opts.categoryOrder,
    });
    return { property: prop, palette };
  }

  /** Resolvable id column name for glide, or '' when unset/blank. */
  private idPropertyValue(): string {
    return typeof this.opts.idProperty === 'string' ? this.opts.idProperty : '';
  }

  /**
   * True when the GPU glide path is active — `interpolate` on, reduced-motion
   * off, a resolvable `idProperty`, and window mode. Any unmet condition (the
   * default) leaves the static icon path byte-identical.
   */
  private interpolationActive(): boolean {
    return (
      this.opts.interpolate === true &&
      this.opts.reducedMotion !== true &&
      this.idPropertyValue().length > 0 &&
      (this.opts.mode ?? 'window') === 'window'
    );
  }

  /**
   * The material mode after the reduced-motion gate. A wake is animated motion, so
   * — like the glide path — `reducedMotion` collapses `mode: 'wake'` back to a
   * static `'window'` marker (no trailing tail). Every other mode passes through
   * unchanged, so the non-wake paths stay byte-identical.
   */
  private resolveMode(): IconMode {
    const mode = this.opts.mode ?? 'window';
    if (mode === 'wake' && this.opts.reducedMotion === true) return 'window';
    return mode;
  }

  /** True when the wake tail is actually rendered (wake mode, reduced-motion off). */
  private wakeActive(): boolean {
    return this.resolveMode() === 'wake';
  }

  /** TrackFieldConfig fed to the pooler: id + categorical colour + the heading
   *  column (icon `angleProperty`, degrees) so heading glides alongside position. */
  private glideTrackConfig(): TrackFieldConfig {
    const colorProp = this.opts.colorProperty ?? '';
    return {
      trackIdProperty: this.idPropertyValue(),
      colorProperty: colorProp,
      labelProperty: '',
      headingProperty: this.opts.angleProperty ?? '',
      lengthProperty: '',
      widthProperty: '',
      heightProperty: '',
      speedProperty: '',
      colorMapping: (this.opts.colorMapping ?? null) as Record<
        string,
        TrackColor
      > | null,
      colorMappingDefault: (this.opts.color ?? DEFAULT_TINT) as TrackColor,
    };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    if (this.interpolationActive()) {
      this.setTilesGlide(tiles, ctx);
      return;
    }
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const cat = this.resolveCategoryPalette();
    const buf = buildIconBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      atlasWidth: this.opts.atlasWidth,
      atlasHeight: this.opts.atlasHeight,
      iconMapping: this.opts.iconMapping,
      icon: this.opts.icon ?? 'marker',
      angleProperty: this.opts.angleProperty ?? null,
      angleConstant: this.opts.angle ?? 0,
      sizeProperty: this.opts.sizeProperty ?? null,
      sizeConstant: this.opts.size ?? 12,
      colorMode: this.colorMode(),
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      filterProperty: this.opts.filterProperty ?? null,
      categoryIndex: cat,
    });
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeBillboardQuadGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

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
      'sttAngle',
      new InstancedBufferAttribute(buf.angles, 1),
    );
    geometry.setAttribute(
      'sttSize',
      new InstancedBufferAttribute(buf.sizes, 1),
    );
    geometry.setAttribute(
      'sttUvRect',
      new InstancedBufferAttribute(buf.uvRects, 4),
    );
    geometry.setAttribute(
      'sttAnchor',
      new InstancedBufferAttribute(buf.anchors, 2),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    // DataFilter: bind the per-icon filter value when a filterProperty emitted one.
    if (buf.filterValues.length > 0) {
      geometry.setAttribute(
        'sttFilterValue',
        new InstancedBufferAttribute(buf.filterValues, 1),
      );
    }
    // Stable palette: bind the per-icon category slot when it emitted one.
    if (buf.categoryIndices.length > 0) {
      geometry.setAttribute(
        'sttCategoryIndex',
        new InstancedBufferAttribute(buf.categoryIndices, 1),
      );
    }
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    // Stable palette: build the texture AFTER disposeGpu (frees the previous one).
    const paletteTexture =
      cat && buf.categoryIndices.length > 0
        ? makePaletteTexture(cat.palette)
        : null;
    this.paletteTexture = paletteTexture;

    // The shader maps quad-top → atlas v0 (top-left origin). A TextureLoader atlas
    // defaults to flipY=true, which would mirror every icon vertically — enforce
    // flipY=false to match the UV contract.
    if (this.opts.atlas.flipY) {
      this.opts.atlas.flipY = false;
      this.opts.atlas.needsUpdate = true;
    }
    this.bundle = createIconMaterial({
      // Reduced-motion collapses `wake` → `window` (no trailing tail).
      mode: this.resolveMode(),
      atlas: this.opts.atlas,
      mask: this.opts.mask ?? false,
      alphaCutoff: this.opts.alphaCutoff,
      dataFilter: !!this.opts.filterProperty,
      colorPalette: paletteTexture ? { texture: paletteTexture } : undefined,
    });
    if (this.bundle.palette && cat) {
      this.bundle.palette.invWidth.value = 1 / cat.palette.colors.length;
    }
    this.object.geometry = geometry;
    this.object.material = this.bundle.material;
    this.pushUniforms(this.timeOrigin);
  }

  /**
   * Glide `setTiles`: pool the resident tiles' samples into per-entity tracks
   * (incrementally), resample position + heading into the keyframe texture, and
   * build ONE instanced billboard whose centres AND headings glide on the GPU.
   * The entity-constant icon geometry (uv rect, anchor, size) is baked once.
   */
  private setTilesGlide(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    // Glide carries no merged-buffer provenance (per-track picking deferred, as in
    // the point layer): a stale pick after a reload resolves to null.
    this.provenance = new InstanceProvenance();
    this.binaryByTileKey = new Map();

    const hasAngleCol =
      this.idPropertyValue().length > 0 && !!this.opts.angleProperty;
    if (!this.maintainer) this.maintainer = new TrackIndexMaintainer();
    const result = this.maintainer.sync(tiles, this.glideTrackConfig());
    const field = assembleKeyframes(
      result.tracks.values(),
      ctx.projection,
      ctx.timeOrigin,
      {
        resampleIntervalMs: this.opts.glideResampleIntervalMs ?? 1000,
        maxFrames: this.opts.glideMaxFrames ?? 512,
        maxGapMs: this.opts.maxInterpolationGap ?? Infinity,
        withHeading: hasAngleCol,
        angleUnit: 'deg',
      },
    );
    // No heading column ⇒ bake the constant `angle` (deg→rad) into the texture's
    // A channel for every texel, so a fixed-orientation icon keeps its heading
    // (the material reads angle from texel.w in glide mode).
    if (!hasAngleCol && field.count > 0) {
      const rad = ((this.opts.angle ?? 0) * Math.PI) / 180;
      for (let i = 3; i < field.texData.length; i += 4) field.texData[i] = rad;
    }

    this.disposeGpu();
    if (field.count === 0) {
      this.object.geometry = makeBillboardQuadGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(field.origin[0], field.origin[1], field.origin[2]);

    const texture = this.makeGlideTexture(field);
    this.glideTexture = texture;

    // Enforce the flipY=false UV contract (same as the static path).
    if (this.opts.atlas.flipY) {
      this.opts.atlas.flipY = false;
      this.opts.atlas.needsUpdate = true;
    }
    this.bundle = createIconMaterial({
      mode: 'window',
      atlas: this.opts.atlas,
      mask: this.opts.mask ?? false,
      alphaCutoff: this.opts.alphaCutoff,
      glide: { texture },
    });
    if (this.bundle.glide) {
      this.bundle.glide.invTexWidth.value = 1 / field.texWidth;
    }

    this.object.geometry = this.makeGlideGeometry(field);
    this.object.material = this.bundle.material;
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

  /**
   * One instanced billboard for the glide path. Position + heading come from the
   * texture (via `sttGlide*`); the entity-constant icon geometry (uv rect,
   * anchor, size) and tint + active span are per-instance attributes. NO
   * `sttCenter` / `sttAngle` — the material reads those from the texture.
   */
  private makeGlideGeometry(field: KeyframeField): InstancedBufferGeometry {
    const count = field.count;
    // DEFERRED: glide bakes ONE constant size per instance (`size`). A per-feature
    // `sizeProperty` is not glided here (directional-marker demos — AIS/aircraft —
    // use a constant marker size); `sizeScale` still multiplies it via the uniform.
    const sizeConst = this.opts.size ?? 12;

    // Resolve the single shared icon's atlas rect + anchor offset once (mirrors
    // buildIconBuffers), then fill it across every instance.
    const entry = this.opts.iconMapping[this.opts.icon ?? 'marker'];
    let u0 = 0;
    let v0 = 0;
    let u1 = 1;
    let v1 = 1;
    let ax = 0;
    let ay = 0;
    if (entry && this.opts.atlasWidth > 0 && this.opts.atlasHeight > 0) {
      u0 = entry.x / this.opts.atlasWidth;
      v0 = entry.y / this.opts.atlasHeight;
      u1 = (entry.x + entry.width) / this.opts.atlasWidth;
      v1 = (entry.y + entry.height) / this.opts.atlasHeight;
      const anchorX = entry.anchorX ?? entry.width / 2;
      const anchorY = entry.anchorY ?? entry.height / 2;
      ax = -(2 * (anchorX / entry.width) - 1);
      ay = 2 * (anchorY / entry.height) - 1;
    }

    const sizes = new Float32Array(count);
    const uvRects = new Float32Array(count * 4);
    const anchors = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      sizes[i] = sizeConst;
      uvRects[i * 4] = u0;
      uvRects[i * 4 + 1] = v0;
      uvRects[i * 4 + 2] = u1;
      uvRects[i * 4 + 3] = v1;
      anchors[i * 2] = ax;
      anchors[i * 2 + 1] = ay;
    }

    const geometry = makeBillboardQuadGeometry();
    geometry.instanceCount = count;
    geometry.setAttribute(
      'sttColor',
      new InstancedBufferAttribute(field.colors, 4),
    );
    geometry.setAttribute('sttSize', new InstancedBufferAttribute(sizes, 1));
    geometry.setAttribute(
      'sttUvRect',
      new InstancedBufferAttribute(uvRects, 4),
    );
    geometry.setAttribute(
      'sttAnchor',
      new InstancedBufferAttribute(anchors, 2),
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

  /** The uniform values for the given playhead — shared by the colour render and
   *  the id-pass so the pick pass gates on the SAME time / wake / filter. */
  private iconUniformValues(absoluteTimeMs: number): IconUniformValues {
    // Wake params ride the shared TimeFilterUniforms (following the glide/DataFilter
    // glue): `wakeLength` is zeroed unless the wake tail is actually active (wake
    // mode, reduced-motion off), so the other modes see an untouched uniform set.
    const wake = this.wakeActive();
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        ...resolveTimeWindow(this.opts, 0),
        wakeLength: wake ? (this.opts.wakeLength ?? 0) : 0,
        wakeTailScale: this.opts.wakeTailScale,
      },
      opacity: this.opts.opacity ?? 1,
      sizeScale: this.opts.sizeScale ?? 1,
      sizeMinPixels: this.opts.sizeMinPixels ?? 0,
      sizeMaxPixels: this.opts.sizeMaxPixels ?? 1e9,
      viewport: this.viewport,
      // No-op unless the material was built with a filter (static path).
      dataFilter: {
        filterEnabled: this.opts.filterEnabled,
        filterRange: this.opts.filterRange ?? null,
        filterSoftRange: this.opts.filterSoftRange ?? null,
      },
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateIconUniforms(this.bundle, this.iconUniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: icon variant) ──────────────────────────
  //
  // Two halves: `resolvePick` (pure, unit-tested — merged index → SttIdPickInfo
  // via the provenance buffer, the shared `resolveIdPick` seam) and `pick` (the
  // opt-in GPU id-pass + readback, which needs a live WebGPU device and is
  // browser-verify only). STATIC icon path only — the glide path defers picking
  // (its provenance is empty), consistent with the point layer.

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback)
   * to a normalised {@link SttIdPickInfo} (`kind: 'icon'`), or `null` for a miss.
   * Pure — the unit-tested seam; call it directly with a decoded index.
   */
  resolvePick(index: number, screen?: [number, number]): SttIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'icon',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createIconIdMaterial({
        // Match the render material (reduced-motion collapses wake → window).
        mode: this.resolveMode(),
        dataFilter: !!this.opts.filterProperty,
        alphaCutoff: this.opts.alphaCutoff,
      });
    }
    if (!this.idColorsPresent && this.provenance.length > 0) {
      const idColors = buildIdColors(this.provenance.length);
      this.object.geometry.setAttribute(
        'sttIdColor',
        new InstancedBufferAttribute(idColors, 3),
      );
      this.idColorsPresent = true;
    }
  }

  /**
   * GPU icon pick — auto-registered into the r3f `PickController` (a CPU box miss
   * falls through to this). Renders this layer's markers with the flat id material
   * into `picker`'s off-screen target, reads back the merged-instance id at CSS
   * pixel `(cssX, cssY)`, and resolves it through the provenance buffer. The
   * `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify per the package's test policy. The id material
   * reuses the SAME vertex collapse gates (time-filter + wake taper + marker
   * filter), so only markers drawn THIS frame are pickable, at their sized
   * position. The glide path defers picking (empty provenance → early null).
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<SttIdPickInfo | null> {
    if (this.provenance.length === 0 || !this.object.visible) return null;
    this.ensurePickPass();
    const idBundle = this.idBundle;
    if (!idBundle) return null;
    // Sync the id material's gates to the live playhead so only markers visible
    // THIS frame are pickable, at their sized position.
    updateIconUniforms(idBundle, this.iconUniformValues(this.currentTimeMs));

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
    this.paletteTexture?.dispose();
    this.paletteTexture = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
