// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTPathGeoLayer` — the Three port of deck's `AnimatedPathLayer` (WINDOW mode):
 * whole-feature visibility (each multi-vertex path is shown, with optional fade,
 * when its `[startTime, endTime]` overlaps the current time window). Geographic
 * (mercator / globe) sibling of the AV {@link STTWideLineLayer} — it is literally a
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
 *
 * PROGRESSIVE-REVEAL / TRAIL MODE (opt-in via {@link STTPathGeoLayerOptions.revealTrail}):
 * instead of the whole path appearing at once, it is drawn PROGRESSIVELY up to the
 * playhead — each vertex reveals as time reaches its per-vertex reveal time — so a
 * timeless line inks itself in along its length over its `[start,end]` span. This
 * is the Three port of deck's `AnimatedPathLayer` `revealTrail`/`revealDuration`/
 * `fadeTrail`: it feeds the base {@link STTWideLineLayer}'s reveal gate the arc-length
 * reveal times synthesized by the buffer builder, drives it with
 * `trailLength`/`trailFade`, and — per the project accessibility contract —
 * degrades to the static whole-path window render under {@link reducedMotion}.
 */

import {
  STTWideLineLayer,
  type STTWideLineLayerOptions,
} from './wide-line-layer.js';
import type { ThreeTimeWindowOptions } from '../lib/time-window.js';
import type {
  LineColorMode,
  LineSegmentBufferOptions,
} from '../lib/geo-line-buffers.js';

/**
 * Effectively-infinite trail length (ms) implementing "reveal and PERSIST": a
 * `revealDuration` of 0 keeps every vertex drawn once the playhead passes it (the
 * trail never erases behind the head), realized as a `trailLength` larger than any
 * single feature's own internal time span so `trailStart = currentTime −
 * trailLength` stays below every vertex time. 250 years clears every shipped
 * dataset (the widest single-feature span is the drifters' ~43-year tracks) with
 * headroom. Mirrors deck `AnimatedPathLayer`'s `REVEAL_PERSIST_TRAIL_MS`.
 */
const REVEAL_PERSIST_TRAIL_MS = 250 * 365 * 24 * 60 * 60 * 1000;

export interface STTPathGeoLayerOptions extends ThreeTimeWindowOptions {
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

  // ── Progressive-reveal / TRAIL mode (deck AnimatedPathLayer parity) ──────────
  /**
   * Progressive-reveal / TRAIL mode. When `true` (and {@link reducedMotion} is
   * not set), each path is drawn PROGRESSIVELY up to the playhead instead of
   * appearing whole: each vertex becomes visible as the playhead reaches its
   * per-vertex reveal time, so a timeless line inks itself in along its length
   * over its `[start,end]` span. Off (default) keeps the whole-path window mode,
   * byte-identical to the pre-reveal layer. Matches deck's `revealTrail`.
   * @default false
   */
  revealTrail?: boolean;
  /**
   * Trailing-window length in ms for {@link revealTrail}. `0` (default) PERSISTS
   * the whole revealed portion (draw-and-keep: the line stays once drawn); a
   * positive value renders a finite comet trail that erases behind the head after
   * this many ms. No effect unless `revealTrail` is on. Matches deck's
   * `revealDuration`. @default 0
   */
  revealDuration?: number;
  /**
   * In {@link revealTrail} mode, fade the trail head→tail (`true`, the classic
   * comet) or draw it at constant opacity (`false`, a solid snake). No effect
   * outside reveal mode. Matches deck's `fadeTrail`. @default true
   */
  fadeTrail?: boolean;
  /**
   * Accessibility: when `true`, suppress the {@link revealTrail} animation and
   * render the WHOLE path (window mode, no progressive draw). Wire the host's
   * `prefers-reduced-motion` here. No effect when `revealTrail` is off.
   * @default false
   */
  reducedMotion?: boolean;
}

/**
 * Geographic path layer. Subclasses {@link STTWideLineLayer}. In the DEFAULT
 * (window) mode it pins `mode: 'window'` — whole-feature visibility. With
 * {@link STTPathGeoLayerOptions.revealTrail} it switches the base into the shared
 * `trail` gate (the SAME per-vertex vertex-collapse + fragment-fade the trips
 * kind uses, deck.gl #7509), fed the arc-length reveal times its
 * {@link bufferOptions} override asks {@link buildLineSegmentBuffers} to
 * synthesize (`revealTimes`), and drives it with `trailLength`/`trailFade`
 * (= `revealDuration`/`fadeTrail`). All rendering, RTC, and time-uniform
 * plumbing are inherited unchanged — reveal is pure configuration of the base,
 * so the `line`/`od-line` kinds (window/none mode, no `revealTimes`) are
 * byte-identical.
 */
export class STTPathGeoLayer extends STTWideLineLayer {
  /**
   * Whether progressive reveal is EFFECTIVE — opted in via `revealTrail` AND not
   * suppressed by `reducedMotion` (the accessibility contract every animated
   * surface here honors). Read by {@link bufferOptions} to gate the per-vertex
   * reveal-time synthesis; also decided the base `mode` in the constructor.
   * Mirrors deck AnimatedPathLayer.revealActive().
   */
  private readonly revealActive: boolean;

  constructor(options: STTPathGeoLayerOptions) {
    const revealActive =
      options.revealTrail === true && options.reducedMotion !== true;
    const base: STTWideLineLayerOptions = {
      id: options.id ?? 'path-geo',
      // Reveal routes through the shared `trail` gate (per-vertex reveal up to the
      // playhead); otherwise the whole-path `window` gate. `window` is the exact
      // fallback whenever reveal is inactive (off OR reduced motion).
      mode: revealActive ? 'trail' : 'window',
      colorMode: options.colorMode,
      widthPx: options.widthPx ?? 2,
      opacity: options.opacity,
      additive: options.additive,
      depthWrite: options.depthWrite,
      alphaCutoff: options.alphaCutoff,
      elevationProperty: options.elevationProperty ?? null,
      elevationScale: options.elevationScale ?? 1,
      zLift: options.zLift ?? 0,
      // Forward the full time-window vocabulary as-is; STTWideLineLayer resolves it
      // (defaulting windowHalf to 0). Passing the RAW values — not `?? 0` — is
      // load-bearing: a `windowHalf: 0` fallback would win over `timeWindow`.
      timeWindow: options.timeWindow,
      fadeInDuration: options.fadeInDuration,
      fadeOutDuration: options.fadeOutDuration,
      windowHalf: options.windowHalf,
      fadeIn: options.fadeIn,
      fadeOut: options.fadeOut,
      // Progressive reveal (deck revealTrail) → the trail gate's uniforms. A
      // zero/unset revealDuration PERSISTS the whole revealed portion via an
      // effectively-infinite trail (draw-and-keep); a positive one is a finite
      // comet trail. fadeTrail true fades head→tail (trailFade 1), false draws a
      // solid snake (trailFade 0). Omitted entirely when reveal is inactive, so
      // the window-mode build is byte-identical.
      ...(revealActive
        ? {
            trailLength:
              options.revealDuration && options.revealDuration > 0
                ? options.revealDuration
                : REVEAL_PERSIST_TRAIL_MS,
            trailFade: options.fadeTrail === false ? 0 : 1,
          }
        : {}),
    };
    super(base);
    this.revealActive = revealActive;
    // Retag the inherited GPU id-buffer pick as the `path` kind (the pick machinery
    // — provenance, id material, dispatch — is inherited from STTWideLineLayer whole).
    this.pickKind = 'path';
  }

  /**
   * Extend the base line-buffer options with `revealTimes` so the builder emits
   * the PER-VERTEX arc-length reveal times the `trail` gate reads (prefers the
   * tile's own `vertexTimestamps`, else synthesizes by cumulative distance).
   * Inactive ⇒ `revealTimes: false` and the builder leaves `timeA/timeB` at the
   * feature `[start,end]`, byte-identical to the window-mode base.
   */
  protected override bufferOptions(): LineSegmentBufferOptions {
    return { ...super.bufferOptions(), revealTimes: this.revealActive };
  }
}
