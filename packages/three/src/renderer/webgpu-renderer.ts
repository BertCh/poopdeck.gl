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

/**
 * Create and `init()` a `WebGPURenderer`, returning it plus the backend it
 * resolved to. Always await this before rendering.
 */
export async function createSttRenderer(
  opts: CreateRendererOptions = {},
): Promise<CreatedRenderer> {
  const forceWebGL = opts.forceWebGL ?? false;
  const renderer = new WebGPURenderer({
    canvas: opts.canvas,
    antialias: opts.antialias ?? true,
    alpha: opts.alpha ?? true,
    forceWebGL,
    powerPreference: opts.powerPreference ?? 'high-performance',
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
