// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Camera-synced **basemap overlay** controller.
 *
 * The toggleable street basemap (maplibre-gl, or any compatible raster map) is a
 * SEPARATE canvas sitting UNDER the transparent Three canvas — NOT a deck.gl
 * interleaved sublayer. Interleaving a maplibre basemap with deck forces the
 * `WebGLRenderer` path and would kill the TSL/WebGPU renderer outright, so here
 * the basemap is an independent map whose camera we drive each frame to match the
 * Three camera. The two canvases overlap pixel-for-pixel; the Three canvas is
 * transparent so the basemap shows through behind the data.
 *
 * This controller is deliberately **provider-agnostic**: it never imports
 * `maplibre-gl`. The host (the showcase) owns the actual map instance and passes
 * it in by STRUCTURAL type — anything with `jumpTo`/`getCanvas`/`remove` works
 * (maplibre-gl `Map`, mapbox-gl `Map`, a test mock…). Each `sync()` reads the
 * Three camera back into a geographic `{longitude, latitude, zoom, pitch, bearing}`
 * via {@link cameraToViewState} and pushes it to `map.jumpTo`, so orbiting the
 * Three camera drags the basemap along underneath with no animation lag.
 *
 * Only mercator/globe projections produce a meaningful view state (the ENU/AV
 * cockpit has no slippy basemap and never attaches this). The basemap itself is
 * always a flat web-mercator map; on a globe projection the recovered view state
 * is still the deck-compatible `{lng,lat,zoom,…}`, which a globe-capable basemap
 * (e.g. maplibre globe projection) consumes directly.
 */

import type { PerspectiveCamera } from 'three';
import type { Projection } from '../projection/local-enu.js';
import { cameraToViewState, type ViewStateCameraOptions } from '../projection/view-state.js';

/**
 * The minimal structural surface a host map must expose. Satisfied by maplibre-gl
 * and mapbox-gl `Map`. We keep it tiny on purpose — only what the overlay touches.
 */
export interface BasemapLike {
  /** Snap the map camera to a view state with no animation (per-frame sync). */
  jumpTo(options: {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  }): unknown;
  /** The map's backing canvas — the element stacked under the Three canvas. */
  getCanvas?(): HTMLCanvasElement;
  /** Tear the map down + release its WebGL context. */
  remove?(): void;
  /** Optional resize hook, called when the host canvas size changes. */
  resize?(): unknown;
}

export interface BasemapOverlayOptions extends ViewStateCameraOptions {
  /**
   * Start attached (syncing on every {@link BasemapOverlay.sync}). When detached,
   * `sync()` is a no-op so the basemap freezes (and the host can hide its canvas).
   * @default true
   */
  enabled?: boolean;
}

/**
 * Drives a host-provided basemap from a Three camera. Construct with the map, the
 * active {@link Projection}, and the camera; call {@link sync} once per frame.
 */
export class BasemapOverlay {
  private readonly map: BasemapLike;
  private readonly projection: Projection;
  private readonly camera: PerspectiveCamera;
  private readonly viewportHeight?: number;
  private attached: boolean;

  constructor(
    map: BasemapLike,
    projection: Projection,
    camera: PerspectiveCamera,
    opts: BasemapOverlayOptions = {},
  ) {
    this.map = map;
    this.projection = projection;
    this.camera = camera;
    this.viewportHeight = opts.viewportHeight;
    this.attached = opts.enabled ?? true;
  }

  /** Whether the overlay is currently syncing the basemap each frame. */
  get isAttached(): boolean {
    return this.attached;
  }

  /** The host map's backing canvas, if it exposes one (for stacking/visibility). */
  getCanvas(): HTMLCanvasElement | undefined {
    return this.map.getCanvas?.();
  }

  /** Resume per-frame syncing (and snap the basemap to the current camera now). */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.sync();
  }

  /** Pause syncing — the basemap freezes at its last view state until reattached. */
  detach(): void {
    this.attached = false;
  }

  /**
   * Read the Three camera back into a geographic view state and push it to the
   * basemap. No-op while detached. Call once per rendered frame.
   */
  sync(): void {
    if (!this.attached) return;
    const vs = cameraToViewState(this.projection, this.camera, {
      viewportHeight: this.viewportHeight,
    });
    this.map.jumpTo({
      center: [vs.longitude, vs.latitude],
      zoom: vs.zoom,
      pitch: vs.pitch,
      bearing: vs.bearing,
    });
  }

  /** Forward a host-canvas resize to the basemap (so its viewport tracks ours). */
  resize(): void {
    this.map.resize?.();
  }

  /** Detach and release the host map. Idempotent. */
  dispose(): void {
    this.attached = false;
    this.map.remove?.();
  }
}
