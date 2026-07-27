// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * GPU id-colour picking scaffold — click-to-inspect for the GPU-instanced
 * geographic layers (points / wide-lines / polygons / cells), complementing the
 * CPU oriented-box picker in `./box-pick.ts`.
 *
 * The CPU picker only works for the tens of CPU-resident object/ego boxes; the
 * heavy instanced clouds are shader-built, so a `Raycaster` can't hit them.
 * Instead we render the pickable object off-screen with a flat "id material" —
 * every feature painted a colour that encodes its integer feature index — into a
 * tiny render target at the cursor, then read the pixel back and decode the
 * index. This is the standard deck.gl / three id-buffer picking trick.
 *
 * The colour encode/decode math is the unit-tested seam. The render + readback
 * path (`GpuPicker`) is loosely typed against the WebGPU renderer and verified
 * visually, since it needs a live GPU device.
 *
 * ENCODING: a 24-bit feature index packs losslessly into the RGB channels (8
 * bits each, big-endian: r = high byte). Index 0 → black (0,0,0); the picker
 * treats a returned index outside the rendered feature count as "no hit", and
 * callers typically offset the cleared background to a sentinel so 0 stays a
 * valid feature. Alpha is reserved (the id material writes a=255 opaque).
 */

// The id-colour encode/decode math + per-feature id-colour builder live in
// `@poopdeck.gl/core/picking`, shared by every id-buffer backend. They are
// re-exported here under three's own names (`encodeId` / `decodeId`), which are
// part of this package's public API; `GpuPicker` below uses the imported
// `decodeId` binding directly.
import { Color } from 'three';
import {
  encodePickId as encodeId,
  decodePickId as decodeId,
  buildIdColors,
  MAX_PICK_ID,
} from '@poopdeck.gl/core/picking';

export { encodeId, decodeId, buildIdColors, MAX_PICK_ID };

/**
 * Background clear colour for the id pass: white decodes to {@link MAX_PICK_ID},
 * which is `>=` any real `featureCount`, so an empty-background readback is
 * reported as a miss — while feature index 0 (black) stays a valid hit.
 */
const SENTINEL_CLEAR = 0xffffff;

// ── GPU readback helper (visually verified; loosely typed) ──────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal structural view of the bits of the WebGPU renderer we touch. */
export interface PickRenderer {
  domElement: HTMLCanvasElement;
  getPixelRatio(): number;
  setRenderTarget(target: any | null): void;
  getRenderTarget?(): any | null;
  render(scene: any, camera: any): void;
  /**
   * three's async readback. NOTE: on the unified `WebGPURenderer` (WebGPU *and*
   * WebGL2 backends) this RETURNS the pixels — its 6th/7th args are
   * `textureIndex`/`faceIndex`, NOT an output buffer. So we consume the resolved
   * `TypedArray` rather than a pre-allocated `out`: a buffer passed in those
   * slots is silently read as a texture index, the readback stays all-zeros, and
   * every pick decodes to feature index 0.
   */
  readRenderTargetPixelsAsync(
    target: any,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<ArrayBufferView>;
  // Clear-colour save/restore for the sentinel background (see `pick`). Optional
  // so a lightweight mock renderer without them still drives the decode path.
  getClearColor?(target: any): any;
  getClearAlpha?(): number;
  setClearColor?(color: any, alpha?: number): void;
}

/** A render target ctor compatible with three's `RenderTarget` shape. */
export interface RenderTargetCtor {
  new (width: number, height: number, options?: any): any;
}

export interface GpuPickerOptions {
  /** Side length of the readback square in device pixels (default 1). */
  size?: number;
  /**
   * Feature count actually drawn this frame; a decoded index `>= featureCount`
   * (e.g. the cleared background) is reported as a miss (`null`).
   */
  featureCount?: number;
  /**
   * Run just before the (synchronous) id render — e.g. swap `scene` to its flat
   * id material.
   */
  onBeforeRender?: () => void;
  /**
   * Run just after the id render, in the same `finally` that restores the render
   * target — i.e. BEFORE the async readback yields — so a swapped-in id material
   * is restored without a concurrent render flashing it on-screen.
   */
  onAfterRender?: () => void;
}

/**
 * Off-screen id-buffer picker. Renders `scene` with `camera` (the scene/object
 * should be swapped to its id material by the caller) into a small render target
 * positioned at the cursor, reads back the centre pixel, and decodes the index.
 *
 * The id render target is owned by the picker and lazily (re)sized; remember to
 * `dispose()` it. Typed against {@link PickRenderer} so it works with the
 * project's WebGPU renderer without dragging in three's full type surface.
 */
export class GpuPicker {
  private readonly renderer: PickRenderer;
  private readonly TargetCtor: RenderTargetCtor;
  private readonly size: number;
  private target: any | null = null;

  constructor(renderer: PickRenderer, TargetCtor: RenderTargetCtor, size = 1) {
    this.renderer = renderer;
    this.TargetCtor = TargetCtor;
    this.size = Math.max(1, Math.floor(size));
  }

  private ensureTarget(): any {
    if (!this.target) {
      this.target = new this.TargetCtor(this.size, this.size, {
        // Crisp integer ids — never filter the id buffer.
        depthBuffer: true,
        stencilBuffer: false,
      });
    }
    return this.target;
  }

  /**
   * Pick at CSS pixel `(cssX, cssY)` relative to the renderer's canvas.
   *
   * Returns the decoded feature index, or `null` if the readback pixel is the
   * cleared background / out of the drawn feature range. The caller must have
   * applied the id material to `scene` (and restored it afterward).
   *
   * The pass clears to a {@link SENTINEL_CLEAR} background (see the field doc) so
   * an empty pixel resolves to a miss rather than feature 0; the previous
   * clear-colour is restored (even on throw).
   *
   * We do NOT render the whole frame into the tiny target (that collapses the
   * full frustum into `size×size` pixels and leaves the cursor unresolved).
   * Instead `Camera.setViewOffset(fullW, fullH, offX, offY, size, size)` offsets
   * the frustum so the target shows only the `size×size` window centred on the
   * cursor; the readback origin is therefore always `(0,0)` (in-bounds), and the
   * cursor lands on the target's centre texel. `clearViewOffset()` is restored in
   * the same synchronous `finally` as the render target + clear colour.
   */
  async pick(
    scene: any,
    camera: any,
    cssX: number,
    cssY: number,
    opts: GpuPickerOptions = {},
  ): Promise<number | null> {
    const renderer = this.renderer;
    const target = this.ensureTarget();
    const dpr = renderer.getPixelRatio();
    const canvas = renderer.domElement;
    const size = this.size;

    // Full drawing-buffer dimensions (device px) and the cursor within them, in
    // `setViewOffset`'s top-left-origin coordinate frame (no Y-flip: the offset
    // camera + full-target readback already put the cursor at the centre texel).
    const fullW = Math.max(1, Math.floor(canvas.width));
    const fullH = Math.max(1, Math.floor(canvas.height));
    const cursorX = cssX * dpr;
    const cursorY = cssY * dpr;

    // Sub-region top-left. Near a canvas edge this may go negative / off-canvas
    // (rendered as the sentinel background); that's fine — the readback origin
    // stays (0,0) and only the cursor's centre texel is decoded.
    const half = (size - 1) / 2;
    const offX = cursorX - half;
    const offY = cursorY - half;

    const prevTarget = renderer.getRenderTarget?.() ?? null;
    // Save + swap the clear colour so the id pass's background is the sentinel,
    // not black (feature 0).
    const savedColor = renderer.getClearColor
      ? renderer.getClearColor(new Color())
      : null;
    const savedAlpha = renderer.getClearAlpha ? renderer.getClearAlpha() : 1;
    renderer.setClearColor?.(SENTINEL_CLEAR, 1);

    // Render the id pass, then restore the view offset + render target + clear
    // colour SYNCHRONOUSLY — before the async readback yields. Otherwise a
    // concurrent render (e.g. the r3f RenderPump's per-rAF `advance()`) could
    // fire during the `await` gap and draw the main scene into this pick target,
    // or leave the view offset applied on the live camera. The readback takes
    // `target` explicitly, so it stays correct after the restore.
    try {
      opts.onBeforeRender?.();
      camera.setViewOffset?.(fullW, fullH, offX, offY, size, size);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      camera.clearViewOffset?.();
      if (savedColor !== null) renderer.setClearColor?.(savedColor, savedAlpha);
      opts.onAfterRender?.();
    }
    // The unified renderer RETURNS the pixels (no output-buffer arg); consume the
    // resolved TypedArray. Read the whole target from origin (0,0) — the offset
    // camera already positioned the cursor at the centre texel.
    const pixels = await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      size,
      size,
    );

    // Sample the centre texel of the read square (RGBA8, one byte per channel).
    const data = pixels as unknown as Uint8Array;
    const ci = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
    const index = decodeId([data[ci], data[ci + 1], data[ci + 2]]);

    const featureCount = opts.featureCount;
    if (featureCount !== undefined && index >= featureCount) return null;
    return index;
  }

  dispose(): void {
    this.target?.dispose?.();
    this.target = null;
  }
}
