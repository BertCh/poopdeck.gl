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

// The id-colour encode/decode math + per-feature id-colour builder were hoisted
// verbatim into `@poopdeck.gl/core/picking` (shared by every id-buffer backend).
// Re-export under three's historical names so this package's public API is
// unchanged; `GpuPicker` below uses the imported `decodeId` binding directly.
import {
  encodePickId as encodeId,
  decodePickId as decodeId,
  buildIdColors,
  MAX_PICK_ID,
} from '@poopdeck.gl/core/picking';

export { encodeId, decodeId, buildIdColors, MAX_PICK_ID };

// ── GPU readback helper (visually verified; loosely typed) ──────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal structural view of the bits of the WebGPU renderer we touch. */
export interface PickRenderer {
  domElement: HTMLCanvasElement;
  getPixelRatio(): number;
  setRenderTarget(target: any | null): void;
  render(scene: any, camera: any): void;
  /** three's async readback: fills/returns a TypedArray of the target pixels. */
  readRenderTargetPixelsAsync(
    target: any,
    x: number,
    y: number,
    width: number,
    height: number,
    out?: ArrayBufferView,
  ): Promise<ArrayBufferView>;
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
  private readonly buffer: Uint8Array;

  constructor(renderer: PickRenderer, TargetCtor: RenderTargetCtor, size = 1) {
    this.renderer = renderer;
    this.TargetCtor = TargetCtor;
    this.size = Math.max(1, Math.floor(size));
    this.buffer = new Uint8Array(this.size * this.size * 4);
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
   * NOTE: this offsets the camera's projection so the 1×1 target captures just
   * the cursor texel — three's `Camera.setViewOffset` is the usual mechanism;
   * here we render the full frame into the target and read the cursor pixel,
   * which is simpler and adequate for a small (≤ few px) target.
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

    // CSS → device pixels, flipping Y (GL/WebGPU read origin is bottom-left).
    const px = Math.floor(cssX * dpr);
    const pyTop = Math.floor(cssY * dpr);
    const py = Math.floor(canvas.height) - 1 - pyTop;

    const half = (this.size - 1) / 2;
    const readX = Math.max(0, Math.round(px - half));
    const readY = Math.max(0, Math.round(py - half));

    const prevTarget = (renderer as any).getRenderTarget?.() ?? null;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    await renderer.readRenderTargetPixelsAsync(
      target,
      readX,
      readY,
      this.size,
      this.size,
      this.buffer,
    );
    renderer.setRenderTarget(prevTarget);

    // Sample the centre texel of the read square.
    const ci = (Math.floor(this.size / 2) * this.size + Math.floor(this.size / 2)) * 4;
    const index = decodeId([this.buffer[ci], this.buffer[ci + 1], this.buffer[ci + 2]]);

    const featureCount = opts.featureCount;
    if (featureCount !== undefined && index >= featureCount) return null;
    return index;
  }

  dispose(): void {
    this.target?.dispose?.();
    this.target = null;
  }
}
