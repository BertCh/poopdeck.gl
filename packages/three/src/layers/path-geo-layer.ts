// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `PathGeoLayer` — the Three port of deck's `AnimatedPathLayer` (WINDOW mode):
 * whole-feature visibility (each multi-vertex path is shown, with optional fade,
 * when its `[startTime, endTime]` overlaps the current time window). Geographic
 * (mercator / globe) sibling of the AV {@link WideLineLayer} — it is literally a
 * thin configuration of that base, fixing `mode: 'window'` and exposing
 * path-vocabulary option names (`widthPx`, `pathColor`, fade) so callers read
 * like the deck `AnimatedPathLayer`.
 *
 * Every consecutive vertex pair of every LineString feature becomes one ribbon
 * quad instance (via {@link buildLineSegmentBuffers}); the GPU expands it to a
 * screen-pixel width and time-windows it on the feature's `[start,end]`. RTC is
 * inherited from the base (positions relative to a shared `origin`, written to
 * `object.position`).
 *
 * Unlocks the geographic path demos (trajectories, lane lines, density
 * iso-contour outlines) on the Three renderer.
 */

import { WideLineLayer, type WideLineLayerOptions } from './wide-line-layer.js';
import type { ThreeTimeWindowOptions } from '../lib/time-window.js';
import type { LineColorMode } from '../lib/geo-line-buffers.js';

export interface PathGeoLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** Per-feature color (categorical / ramp / constant). */
  colorMode: LineColorMode;
  /** Full path width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing trajectories). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  // geometry / elevation (stacked iso-contour relief)
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // window-mode time params — full-width `timeWindow` + `fadeIn/OutDuration`
  // and the lower-level `windowHalf` (@default 0, instantaneous) / `fadeIn` /
  // `fadeOut` aliases come from ThreeTimeWindowOptions.
}

/**
 * Window-mode geographic path layer. Subclasses {@link WideLineLayer} and pins
 * `mode: 'window'`; all rendering, RTC, and time-uniform plumbing are inherited.
 */
export class PathGeoLayer extends WideLineLayer {
  constructor(options: PathGeoLayerOptions) {
    const base: WideLineLayerOptions = {
      id: options.id ?? 'path-geo',
      mode: 'window',
      colorMode: options.colorMode,
      widthPx: options.widthPx ?? 2,
      opacity: options.opacity,
      additive: options.additive,
      depthWrite: options.depthWrite,
      alphaCutoff: options.alphaCutoff,
      elevationProperty: options.elevationProperty ?? null,
      elevationScale: options.elevationScale ?? 1,
      zLift: options.zLift ?? 0,
      // Forward the full time-window vocabulary as-is; WideLineLayer resolves it
      // (defaulting windowHalf to 0). Passing the RAW values — not `?? 0` — is
      // load-bearing: a `windowHalf: 0` fallback would win over `timeWindow`.
      timeWindow: options.timeWindow,
      fadeInDuration: options.fadeInDuration,
      fadeOutDuration: options.fadeOutDuration,
      windowHalf: options.windowHalf,
      fadeIn: options.fadeIn,
      fadeOut: options.fadeOut,
    };
    super(base);
  }
}
