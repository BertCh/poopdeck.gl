// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `IconLayer` — directional billboard markers, the Three port of deck's
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
 * Sizing is in **screen pixels** (deck `IconLayer`'s default `sizeUnits`), so the
 * host must push the drawing-buffer size via {@link setViewport} on resize.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Texture } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import { resolveTimeWindow, type ThreeTimeWindowOptions } from '../lib/time-window.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import {
  buildIconBuffers,
  type IconColorMode,
  type IconMappingEntry,
} from '../lib/icon-buffers.js';
import {
  createIconMaterial,
  updateIconUniforms,
  type IconMaterialBundle,
  type IconMode,
} from '../tsl/icon-material.js';
import type { RGBA } from '../lib/color.js';

export interface IconLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** window (raw) | cumulative (markers persist) | none. @default 'window' */
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

  // ── elevation ────────────────────────────────────────────────────────────────
  elevationProperty?: string | null;
  elevationScale?: number;

  // ── opacity / time params ────────────────────────────────────────────────────
  opacity?: number;
  alphaCutoff?: number;
  // Full-width `timeWindow` + `fadeIn/OutDuration` and the lower-level
  // `windowHalf`/`fadeIn`/`fadeOut` aliases come from ThreeTimeWindowOptions.
}

const DEFAULT_TINT: RGBA = [255, 255, 255, 255];

export class IconLayer extends BaseSttLayer {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: IconMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  private readonly opts: IconLayerOptions;

  constructor(options: IconLayerOptions) {
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

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
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
    });

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
    geometry.setAttribute('sttCenter', new InstancedBufferAttribute(buf.centers, 3));
    geometry.setAttribute('sttColor', new InstancedBufferAttribute(buf.colors, 4));
    geometry.setAttribute('sttAngle', new InstancedBufferAttribute(buf.angles, 1));
    geometry.setAttribute('sttSize', new InstancedBufferAttribute(buf.sizes, 1));
    geometry.setAttribute('sttUvRect', new InstancedBufferAttribute(buf.uvRects, 4));
    geometry.setAttribute('sttAnchor', new InstancedBufferAttribute(buf.anchors, 2));
    geometry.setAttribute('sttStart', new InstancedBufferAttribute(buf.starts, 1));
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    if (buf.bbox) {
      geometry.boundingBox = new Box3(new Vector3(...buf.bbox.min), new Vector3(...buf.bbox.max));
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    }

    // The shader maps quad-top → atlas v0 (top-left origin). A TextureLoader atlas
    // defaults to flipY=true, which would mirror every icon vertically — enforce
    // flipY=false to match the UV contract.
    if (this.opts.atlas.flipY) {
      this.opts.atlas.flipY = false;
      this.opts.atlas.needsUpdate = true;
    }
    this.bundle = createIconMaterial({
      mode: this.opts.mode ?? 'window',
      atlas: this.opts.atlas,
      mask: this.opts.mask ?? false,
      alphaCutoff: this.opts.alphaCutoff,
    });
    this.object.geometry = geometry;
    this.object.material = this.bundle.material;
    this.pushUniforms(this.timeOrigin);
  }

  setTime(absoluteTimeMs: number): void {
    this.pushUniforms(absoluteTimeMs);
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateIconUniforms(this.bundle, {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: resolveTimeWindow(this.opts, 0),
      opacity: this.opts.opacity ?? 1,
      sizeScale: this.opts.sizeScale ?? 1,
      sizeMinPixels: this.opts.sizeMinPixels ?? 0,
      sizeMaxPixels: this.opts.sizeMaxPixels ?? 1e9,
      viewport: this.viewport,
    });
  }

  private disposeGpu(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.bundle?.material.dispose();
    this.bundle = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
