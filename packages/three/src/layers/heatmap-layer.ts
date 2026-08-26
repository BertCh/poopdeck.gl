// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTHeatmapLayer` — a per-PIXEL density heatmap, the three/TSL port of deck's
 * `AnimatedHeatmapLayer` and the sibling of maplibre's `STTHeatmapLayer`.
 *
 * ── THE PIPELINE ─────────────────────────────────────────────────────────────
 * Two passes per frame, because a heatmap's colour is a function of the SUM and
 * the sum only exists per pixel:
 *
 *   1. **Accumulate.** Every visible point across every visible tile is one
 *      camera-facing quad, ADDITIVELY blended into a single-channel float
 *      render target, depositing `kernel(r) · weight` over a `radiusPixels`
 *      disc. The target holds a genuine density field.
 *   2. **Resolve.** A full-screen quad reads each texel ONCE, normalises it
 *      through `colorDomain`, maps it through the colour ramp and composites
 *      the result over the scene.
 *
 * Splatting the palette per POINT instead and additively blending the resulting
 * colours would sum COLOURS rather than density — overlapping points blow out
 * to white and the image stops reading as a heatmap. `tsl/heatmap-material.ts`
 * carries the full argument.
 *
 * ── ONE MERGED SPLAT MESH ────────────────────────────────────────────────────
 * All visible tiles merge into ONE instanced buffer set (`lib/heatmap-buffers.ts`),
 * never one mesh per tile: a splat is ~`radiusPixels` wide on screen, so a point
 * near a tile edge legitimately deposits density into the neighbouring tile's
 * pixels. Per-tile passes would cut every straddling splat and paint a lattice
 * of brightness seams.
 *
 * ── WHERE THE OFF-SCREEN PASS IS DRIVEN FROM ─────────────────────────────────
 * `this.object` is a `Group` holding two meshes:
 *   • `splatMesh` — the merged instanced cloud. It is a CHILD of the group (so
 *     its world matrix tracks the real parent chain) but `visible = false`, so
 *     the main scene never draws it; the density pass flips it visible for the
 *     duration of its isolated `renderer.render(splatMesh, camera)` and back.
 *     Being a real child also means the shared camera-framing pass
 *     (`Box3.expandByObject`) reads the layer's true world AABB off its
 *     geometry, with nothing fabricated.
 *   • `resolveMesh` — the full-screen composite. Its `onBeforeRender` is the
 *     hook that runs the density pass just before the composite is drawn: the
 *     standard three render-target ping-pong idiom (`Reflector` / `Refractor` /
 *     `RTTNode` all do exactly this). Its geometry carries a deliberately EMPTY
 *     `boundingBox` so the clip-space quad contributes nothing to camera
 *     framing (`Box3.union` with an empty box is a no-op).
 * This is why the layer needs no r3f wiring of its own — the generic mount
 * drives `setTiles` / `setTime` / `setViewport` and the renderer does the rest.
 *
 * ── NOT ID-PICKABLE, DELIBERATELY ────────────────────────────────────────────
 * The layer implements no `pick()` / `resolvePick()`, and its buffer builder
 * emits no provenance. A heatmap PIXEL is the sum of an unbounded number of
 * splats and has no single feature identity to report — deck forces
 * `pickable: false` on its heatmap sublayers and maplibre's returns
 * `supportsPicking() === false` for the same reason. Since `isIdPickable()` is a
 * STRUCTURAL test (`typeof layer.pick === 'function'`), simply not implementing
 * it is also how the layer opts out of the r3f pick registry. Hit-testing a
 * heatmap means picking the underlying point layer.
 *
 * ── VERIFICATION ─────────────────────────────────────────────────────────────
 * The pure halves — the consolidated buffer builder and both material node
 * graphs — are unit-tested (`test/heatmap-buffers.test.ts`,
 * `test/heatmap-material.test.ts`). The render-target ping-pong needs a live
 * WebGPU device and is browser-verified, per this package's test policy.
 */

import {
  Group,
  Mesh,
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  RenderTarget,
  Sphere,
  Vector3,
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from 'three';
import type { Tile } from '@poopdeck.gl/core';
import type { PaletteRGBA } from '@poopdeck.gl/core';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import {
  buildHeatmapBuffers,
  type HeatmapBuffers,
} from '../lib/heatmap-buffers.js';
import {
  createHeatmapMaterial,
  updateHeatmapUniforms,
  DEFAULT_SPLAT_FALLOFF,
  HEATMAP_ATTR,
  type HeatmapKernel,
  type HeatmapMaterialBundle,
  type HeatmapUniformValues,
} from '../tsl/heatmap-material.js';
import type { TimeFilterMode } from '../tsl/time-filter-math.js';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal structural view of the renderer bits the density pass touches, so the
 * layer type-checks without importing `WebGPURenderer` (whose type does not
 * match `onBeforeRender`'s declared `WebGLRenderer` parameter anyway). Mirrors
 * `PickRenderer` in `../lib/gpu-pick.ts`; the optional members let a
 * lightweight mock drive the path.
 */
export interface HeatmapRenderer {
  autoClear: boolean;
  render(scene: any, camera: any): void;
  setRenderTarget(target: any | null): void;
  getRenderTarget?(): any | null;
  clear?(color?: boolean, depth?: boolean, stencil?: boolean): void;
  getClearColor?(target: Color): Color;
  getClearAlpha?(): number;
  setClearColor?(color: any, alpha?: number): void;
}

/** Console-warn at most once per key (per-frame paths must not spam). */
const warnedKeys = new Set<string>();
function warnOnce(key: string, ...args: unknown[]): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(...args);
}

export interface STTHeatmapLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /**
   * Which temporal kernel decides whether a point splats this frame:
   * `window` (default) / `wake` / `cumulative` / `trail` / `none`. Fixed at
   * construction — it is part of the material's node graph.
   * @default 'window'
   */
  mode?: TimeFilterMode;

  // ── weight ────────────────────────────────────────────────────────────────
  /**
   * Numeric column NAME whose per-feature value weights each splat. Unset →
   * every point weighs `1` (a pure COUNT heatmap). A tile that lacks the column
   * falls back to `1` for its own points rather than dropping out.
   * @default null
   */
  weightProperty?: string | null;
  /**
   * Upstream-vocabulary alias of {@link weightProperty}. NOTE, exactly as in the
   * deck adapter: this accepts a property-column NAME, **not** a function
   * accessor — binary tiles cannot run per-feature JS. A function warns once and
   * falls back to `weightProperty`. When set to a string it WINS over
   * `weightProperty`.
   * @default null
   */
  getWeight?: string | ((...args: unknown[]) => unknown) | null;
  /**
   * Archive-derived per-point weight normaliser (`1 / p95` of the baked
   * `metadata.heatmapDomain`), folded into every weight at build time. `1` when
   * the archive bakes no usable domain. @default 1
   */
  weightScale?: number;
  /** Global weight multiplier — a live uniform, retuned without re-packing. @default 1 */
  intensity?: number;

  // ── splat shape ───────────────────────────────────────────────────────────
  /**
   * Splat radius in device pixels.
   *
   * DELIBERATE DEFAULT DRIFT, inherited from the deck adapter: `30` vs deck's
   * upstream `50`. STT tiles are dense (a summary-zoom viewport routinely
   * carries 10⁵–10⁶ points) and a 50 px kernel merges everything into one blob
   * at those densities. Pass `50` for byte-identical upstream behaviour.
   * @default 30
   */
  radiusPixels?: number;
  /**
   * Splat kernel — `'gaussian'` (default; deck + maplibre parity) or
   * `'epanechnikov'` (compact support, exactly zero at the disc edge).
   * @default 'gaussian'
   */
  kernel?: HeatmapKernel;
  /** Gaussian tightness, `exp(-r² · falloff)`. @default `1 / 0.15` */
  splatFalloff?: number;

  // ── mode knobs ────────────────────────────────────────────────────────────
  // The full-width `timeWindow` + `fadeIn/OutDuration` and the lower-level
  // `windowHalf` / `fadeIn` / `fadeOut` aliases come from ThreeTimeWindowOptions.
  /**
   * `'wake'` mode: how long (ms) a point keeps splatting after its own start
   * time, shrinking toward {@link wakeTailScale} as it fades. Lights NOTHING at
   * the default `0`, so set it whenever you select wake mode. @default 0
   */
  wakeLength?: number;
  /**
   * `'wake'` mode: splat-radius multiplier at the tail of the wake (the head
   * always splats at full `radiusPixels`).
   * @default `DEFAULT_WAKE_TAIL_SCALE` (0.15, shared with deck + maplibre)
   */
  wakeTailScale?: number;
  /**
   * `'trail'` mode: how far (ms) behind the playhead points keep splatting.
   * Defaults to the FULL window (`2 × windowHalf`), the same derivation the
   * maplibre backend uses, so a trail never outruns the tiles the loader covers.
   */
  trailLength?: number;
  /**
   * `'trail'` mode head→tail fade: `1` (default) fades a splat's weight linearly
   * with age, `0` holds full weight for the whole trail. @default 1
   */
  trailFade?: number;

  // ── ramp ──────────────────────────────────────────────────────────────────
  /**
   * Colour ramp low → high density, as 0–255 sRGB RGBA stops. Baked into the
   * ramp material's node graph at construction.
   * @default `DEFAULT_HEATMAP_COLOR_RANGE` (ColorBrewer OrRd, 7 stops)
   */
  colorRange?: readonly PaletteRGBA[];
  /**
   * Pinned `[min, max]` **ACCUMULATED-density** range mapped onto the ramp —
   * the same units, and the same spelling, as deck's and maplibre's
   * `colorDomain`. NOT a per-feature weight range: it is compared against what
   * a texel accumulated, which depends on point density and `radiusPixels`.
   * Tune it against the rendered map. @default [0, 1]
   */
  colorDomain?: [number, number];
  /**
   * Accumulated density below which a pixel renders transparent, fading in over
   * a narrow band above it (maplibre's `smoothstep(threshold, threshold+0.05)`).
   * @default 0.05
   */
  threshold?: number;
  /** Composite opacity of the resolved heatmap. @default 1 */
  opacity?: number;

  // ── plumbing ──────────────────────────────────────────────────────────────
  /** Drawing-buffer size `[w,h]` px; the r3f mount pushes it on resize. @default [1280,720] */
  viewport?: [number, number];
  /**
   * Density-target resolution as a fraction of the drawing buffer. `0.5` quarters
   * the accumulation cost at the price of a softer field. @default 1
   */
  resolutionScale?: number;
  /**
   * `renderOrder` of the full-screen composite. The heatmap is a screen-space
   * overlay with depth testing off, so it must sort after the geometry it
   * covers. @default 10
   */
  renderOrder?: number;
}

/**
 * A `[-1,1]²` quad in CLIP space for the resolve pass. Its `boundingBox` is set
 * EMPTY on purpose: `Box3.expandByObject` uses an explicit `geometry.boundingBox`
 * verbatim, and a union with an empty box is a no-op — so the camera-framing
 * pass sees the splat cloud's real AABB and not a 2×2 box at the world origin.
 */
function makeFullScreenQuadGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  // prettier-ignore
  const corners = new Float32Array([
    -1, -1, 0,
     1, -1, 0,
     1,  1, 0,
    -1,  1, 0,
  ]);
  geometry.setAttribute('position', new Float32BufferAttribute(corners, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.boundingBox = new Box3(); // empty — see the doc above
  geometry.boundingSphere = new Sphere();
  return geometry;
}

export class STTHeatmapLayer extends BaseSTTLayer {
  readonly id: string;
  /** Stable container: `[splatMesh (hidden), resolveMesh]`. */
  readonly object = new Group();

  /** The merged splat cloud — hidden in the main pass, drawn into the target. */
  private readonly splatMesh = new Mesh();
  /** The full-screen composite; its `onBeforeRender` drives the density pass. */
  private readonly resolveMesh = new Mesh();

  private readonly bundle: HeatmapMaterialBundle;
  /** Accumulation target; `RenderTarget.setSize` keeps the texture identity. */
  private readonly target: RenderTarget;
  private currentTimeMs = 0;
  private splatCount = 0;
  /** Scratch for the clear-colour save/restore (no per-frame allocation). */
  private readonly savedClear = new Color();

  private readonly opts: {
    mode: TimeFilterMode;
    weightProperty: string | null;
    weightScale: number;
    intensity: number;
    radiusPixels: number;
    splatFalloff: number;
    colorDomain: [number, number];
    threshold: number;
    opacity: number;
    viewport: [number, number];
    resolutionScale: number;
    windowHalf: number;
    fadeIn: number;
    fadeOut: number;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    trailFade: number;
  };

  constructor(options: STTHeatmapLayerOptions = {}) {
    super();
    this.id = options.id ?? 'heatmap';
    this.object.name = this.id;
    // Nothing to draw until the first setTiles.
    this.object.visible = false;

    const tw = resolveTimeWindow(options, 0);
    this.opts = {
      mode: options.mode ?? 'window',
      weightProperty: resolveWeightProperty(options),
      weightScale: options.weightScale ?? 1,
      intensity: options.intensity ?? 1,
      radiusPixels: options.radiusPixels ?? 30,
      splatFalloff: options.splatFalloff ?? DEFAULT_SPLAT_FALLOFF,
      colorDomain: options.colorDomain ?? [0, 1],
      threshold: options.threshold ?? 0.05,
      opacity: options.opacity ?? 1,
      viewport: options.viewport ?? [1280, 720],
      resolutionScale: options.resolutionScale ?? 1,
      windowHalf: tw.windowHalf,
      fadeIn: tw.fadeIn,
      fadeOut: tw.fadeOut,
      wakeLength: options.wakeLength ?? 0,
      wakeTailScale: options.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      // Derived from the window, like maplibre's: a trail that outran the
      // loaded window would splat points whose tiles have been evicted.
      trailLength: options.trailLength ?? tw.windowHalf * 2,
      trailFade: options.trailFade ?? 1,
    };

    // Single-channel HALF float. `r16float` is blendable in core WebGPU;
    // `r32float` needs the optional `float32-blendable` feature, which an
    // additive accumulation pass cannot do without. LINEAR filtering so a
    // resolutionScale < 1 field resolves smoothly.
    this.target = new RenderTarget(
      Math.max(
        1,
        Math.round(this.opts.viewport[0] * this.opts.resolutionScale),
      ),
      Math.max(
        1,
        Math.round(this.opts.viewport[1] * this.opts.resolutionScale),
      ),
      {
        format: RedFormat,
        type: HalfFloatType,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        wrapS: ClampToEdgeWrapping,
        wrapT: ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      },
    );

    // ONE material pair for the life of the layer (audit E5): rebuilding it per
    // `setTiles` would evict three's nodeBuilderCache entry and force a full
    // shader + pipeline rebuild on every tile arrival. Every structural input
    // (mode, kernel, colour ramp) is fixed at construction; everything live is a
    // uniform.
    this.bundle = createHeatmapMaterial({
      mode: this.opts.mode,
      kernel: options.kernel ?? 'gaussian',
      densityTexture: this.target.texture,
      colorRange: options.colorRange,
    });

    this.splatMesh.name = `${this.id}:splats`;
    this.splatMesh.material = this.bundle.splat.material;
    this.splatMesh.geometry = makeBillboardQuadGeometry();
    // Hidden in the MAIN pass; the density pass flips it on for its isolated
    // render (see `renderDensity`). Culling is off because the mesh AABB covers
    // the splat CENTRES, not the pixel-space discs that bleed past them.
    this.splatMesh.visible = false;
    this.splatMesh.frustumCulled = false;

    this.resolveMesh.name = `${this.id}:resolve`;
    this.resolveMesh.material = this.bundle.ramp.material;
    this.resolveMesh.geometry = makeFullScreenQuadGeometry();
    this.resolveMesh.frustumCulled = false;
    this.resolveMesh.renderOrder = options.renderOrder ?? 10;
    // The hook that turns a normal draw into a two-pass render.
    this.resolveMesh.onBeforeRender = (renderer, _scene, camera) => {
      this.renderDensity(renderer as unknown as HeatmapRenderer, camera);
    };

    this.object.add(this.splatMesh);
    this.object.add(this.resolveMesh);
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;

    const buf = buildHeatmapBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      weightProperty: this.opts.weightProperty,
      weightScale: this.opts.weightScale,
    });
    this.splatCount = buf.count;

    // Geometry only — NEVER the material (it is built once per layer).
    this.splatMesh.geometry.dispose();

    if (buf.count === 0) {
      this.splatMesh.geometry = makeBillboardQuadGeometry();
      this.splatMesh.position.set(0, 0, 0);
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.splatMesh.geometry = this.makeSplatGeometry(buf);
    // RTC: centres are relative to `origin`; carry the absolute magnitude in the
    // f64 CPU transform. ENU/AV origins are ≈ [0,0,0] → a no-op there.
    this.splatMesh.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);
    this.pushUniforms(this.timeOrigin);
  }

  /** The merged instanced splat cloud: one camera-facing quad per point. */
  private makeSplatGeometry(buf: HeatmapBuffers): InstancedBufferGeometry {
    const geometry = makeBillboardQuadGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute(
      HEATMAP_ATTR.center,
      new InstancedBufferAttribute(buf.centers, 3),
    );
    geometry.setAttribute(
      HEATMAP_ATTR.weight,
      new InstancedBufferAttribute(buf.weights, 1),
    );
    geometry.setAttribute(
      HEATMAP_ATTR.start,
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute(
      HEATMAP_ATTR.end,
      new InstancedBufferAttribute(buf.ends, 1),
    );
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
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

  /**
   * Host pushes the drawing-buffer size on mount + every resize (duck-typed by
   * the r3f mount). Density is a SCREEN quantity, so both the splat radius and
   * the accumulation target are sized off it.
   */
  setViewport(width: number, height: number): void {
    this.opts.viewport = [width, height];
    const w = Math.max(1, Math.round(width * this.opts.resolutionScale));
    const h = Math.max(1, Math.round(height * this.opts.resolutionScale));
    // `setSize` keeps the SAME texture object (it only drops the GPU resource),
    // so the ramp material's baked `densityTexture` reference stays valid.
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    this.pushUniforms(this.currentTimeMs);
  }

  private uniformValues(absoluteTimeMs: number): HeatmapUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        windowHalf: this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
        wakeLength: this.opts.wakeLength,
        wakeTailScale: this.opts.wakeTailScale,
        trailLength: this.opts.trailLength,
        trailFade: this.opts.trailFade,
      },
      radiusPixels: this.opts.radiusPixels,
      intensity: this.opts.intensity,
      splatFalloff: this.opts.splatFalloff,
      // The splat quad is expanded in CLIP space, so it sizes against the
      // DRAWING buffer, not the (possibly downscaled) accumulation target.
      viewport: this.opts.viewport,
      colorDomain: this.opts.colorDomain,
      threshold: this.opts.threshold,
      opacity: this.opts.opacity,
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    updateHeatmapUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  /**
   * Pass 1 — accumulate the density field, run from the resolve quad's
   * `onBeforeRender` so it lands immediately before the composite that reads it.
   *
   * The target is cleared to BLACK/0 explicitly rather than by `autoClear`: the
   * host's clear colour is whatever the scene wants on screen (a sky, a paper
   * cream) and any non-zero value would be a constant density pedestal under the
   * whole map. Target, clear colour and `autoClear` are all restored in a
   * `finally`, so a throw inside the isolated render cannot leave the renderer
   * pointed at this layer's target — the same discipline `GpuPicker.pick` uses.
   *
   * Needs a live WebGPU device: browser-verified, not unit-tested.
   */
  private renderDensity(renderer: HeatmapRenderer, camera: unknown): void {
    if (!this.object.visible || this.splatCount === 0) return;
    const prevTarget = renderer.getRenderTarget?.() ?? null;
    const prevAutoClear = renderer.autoClear;
    const savedColor = renderer.getClearColor
      ? renderer.getClearColor(this.savedClear)
      : null;
    const savedAlpha = renderer.getClearAlpha ? renderer.getClearAlpha() : 1;
    try {
      renderer.setRenderTarget(this.target);
      renderer.setClearColor?.(0x000000, 0);
      renderer.autoClear = false;
      // Colour only — the target carries no depth or stencil attachment.
      renderer.clear?.(true, false, false);
      // Isolated render of the ONE mesh (three accepts any Object3D as the
      // scene, exactly as `GpuPicker.pick` does). The mesh is a child of this
      // layer's group, so its world matrix already carries the real parent
      // chain; it is only ever visible for the length of this call.
      this.splatMesh.visible = true;
      renderer.render(this.splatMesh, camera);
    } catch (err) {
      warnOnce(
        `heatmap-density:${this.id}`,
        `[stt-three] heatmap density pass failed for ${this.id}`,
        err,
      );
    } finally {
      this.splatMesh.visible = false;
      renderer.autoClear = prevAutoClear;
      if (savedColor) renderer.setClearColor?.(savedColor, savedAlpha);
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose(): void {
    this.splatMesh.geometry.dispose();
    this.resolveMesh.geometry.dispose();
    this.bundle.splat.material.dispose();
    this.bundle.ramp.material.dispose();
    this.target.dispose();
  }
}

/**
 * Accessor-alias resolution for the weight column: a STRING `getWeight` wins
 * over `weightProperty`; a FUNCTION `getWeight` warns once and falls back,
 * because binary tiles carry columns, not rows a JS accessor could run over.
 * Column-name semantics only — there is no constant-weight prop (an unset
 * weight already means "every point weighs 1").
 */
function resolveWeightProperty(opts: STTHeatmapLayerOptions): string | null {
  const alias = opts.getWeight;
  if (typeof alias === 'function') {
    warnOnce(
      'STTHeatmapLayer:getWeightFunction',
      '[stt-three] STTHeatmapLayer: `getWeight` takes a property-column NAME, ' +
        'not a function accessor (binary tiles cannot run per-feature JS). ' +
        'Falling back to `weightProperty`.',
    );
  } else if (typeof alias === 'string' && alias.length > 0) {
    return alias;
  }
  return opts.weightProperty ?? null;
}
