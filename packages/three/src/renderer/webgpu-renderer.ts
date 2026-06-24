// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `WebGPURenderer` bootstrap with automatic WebGL2 fallback.
 *
 * TSL node materials only run through Three's node renderer (`WebGPURenderer`);
 * the classic `WebGLRenderer` cannot. A single `WebGPURenderer` uses the WebGPU
 * backend when the browser exposes it and transparently falls back to its own
 * WebGL2 backend otherwise — so the same TSL graph (which compiles to WGSL or
 * GLSL as needed) runs everywhere WebGL2 runs. `forceWebGL: true` pins the
 * WebGL2 backend (no WebGPU, no compute shaders) for maximum uniformity.
 *
 * `WebGPURenderer` requires an async `init()` before the first render — that is
 * the one wrinkle the r3f binding and the imperative mount both have to await.
 */

import { WebGPURenderer } from 'three/webgpu';

export type RendererBackend = 'webgpu' | 'webgl2';

export interface CreateRendererOptions {
  /** Pre-existing canvas (r3f supplies one; the imperative mount makes its own). */
  canvas?: HTMLCanvasElement;
  /** MSAA. @default true */
  antialias?: boolean;
  /** Transparent clear (lets a DOM/basemap show through). @default true */
  alpha?: boolean;
  /** Pin the WebGL2 backend even when WebGPU is available. @default false */
  forceWebGL?: boolean;
  /** GPU power hint. @default 'high-performance' */
  powerPreference?: 'high-performance' | 'low-power' | 'default';
}

export interface CreatedRenderer {
  renderer: WebGPURenderer;
  /** Which backend `init()` actually selected. */
  backend: RendererBackend;
}

/** True when the page can request a WebGPU adapter. */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as unknown as { gpu?: unknown }).gpu;
}

/** Structural view of the bits of the WebGPU API we touch (no `@webgpu/types`
 *  in this package's `types` list — the rest of the file casts around it too). */
interface GpuLike {
  requestAdapter(opts?: unknown): Promise<{
    features: Iterable<string>;
    limits: Record<string, number>;
    requestDevice(desc?: unknown): Promise<unknown>;
  } | null>;
}

/**
 * Pre-create a `GPUDevice` whose buffer-size ceilings are raised to the
 * adapter maximum, returning it (or `undefined` when WebGPU is unavailable /
 * the request fails — callers then fall through to Three's own adapter →
 * WebGL2 selection unchanged).
 *
 * Three's default device request leaves `maxBufferSize` at the WebGPU spec
 * default (256 MB). A dense LIDAR sweep ("density: full") packs hundreds of MB
 * of point columns into a SINGLE vertex buffer, which blows past that cap with
 * a "Buffer size exceeds the max buffer size limit" device error and a black
 * frame — while deck.gl's WebGL2 path, which has no equivalent single-buffer
 * cap, renders the same scene. We mirror Three's own adapter + feature
 * enumeration (so the device is a drop-in for the one it would have made) and
 * only add `requiredLimits` clamped to what the adapter actually reports —
 * exactly the "check the adapter limits before requesting a higher limit"
 * pattern the browser warns to follow. Handed to `WebGPURenderer({ device })`.
 */
export async function createHighLimitDevice(
  powerPreference: CreateRendererOptions['powerPreference'] = 'high-performance',
): Promise<unknown> {
  const gpu =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { gpu?: GpuLike }).gpu
      : undefined;
  if (!gpu) return undefined;
  try {
    const adapter = await gpu.requestAdapter({ powerPreference, featureLevel: 'compatibility' });
    if (!adapter) return undefined;
    const { maxBufferSize, maxStorageBufferBindingSize } = adapter.limits;
    const device = await adapter.requestDevice({
      requiredFeatures: [...adapter.features],
      requiredLimits: { maxBufferSize, maxStorageBufferBindingSize },
    });
    // One-line proof the high-limit device took effect — the default cap is
    // 256 MB, so anything above that means dense LIDAR buffers will fit.
    const granted = (device as { limits?: { maxBufferSize?: number } } | undefined)?.limits
      ?.maxBufferSize;
    // eslint-disable-next-line no-console
    console.info(
      `[stt-three] WebGPU device maxBufferSize = ${Math.round((granted ?? maxBufferSize) / 1048576)} MB`,
    );
    return device;
  } catch (err) {
    // Falling back to Three's own default device (256 MB cap) — surface why so a
    // recurring "buffer exceeds max" error isn't mistaken for the fix not landing.
    // eslint-disable-next-line no-console
    console.warn('[stt-three] high-limit WebGPU device request failed; using default device', err);
    return undefined;
  }
}

/**
 * Create and `init()` a `WebGPURenderer`, returning it plus the backend it
 * resolved to. Always await this before rendering.
 */
export async function createSttRenderer(
  opts: CreateRendererOptions = {},
): Promise<CreatedRenderer> {
  const forceWebGL = opts.forceWebGL ?? false;
  const powerPreference = opts.powerPreference ?? 'high-performance';
  // Build a high-buffer-limit device for the WebGPU path so dense LIDAR sweeps
  // don't blow the 256 MB default single-buffer cap. forceWebGL skips it (the
  // WebGL2 backend has no such cap and ignores `device`).
  const device = forceWebGL ? undefined : await createHighLimitDevice(powerPreference);
  const renderer = new WebGPURenderer({
    canvas: opts.canvas,
    antialias: opts.antialias ?? true,
    alpha: opts.alpha ?? true,
    forceWebGL,
    powerPreference,
    ...(device ? { device } : {}),
  } as ConstructorParameters<typeof WebGPURenderer>[0]);

  await renderer.init();

  return { renderer, backend: resolveBackend(renderer, forceWebGL) };
}

/** Inspect the live renderer to report which backend `init()` chose. */
export function resolveBackend(renderer: WebGPURenderer, forceWebGL = false): RendererBackend {
  if (forceWebGL) return 'webgl2';
  const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
  if (backend?.isWebGPUBackend) return 'webgpu';
  return isWebGPUAvailable() && !backend ? 'webgpu' : 'webgl2';
}
