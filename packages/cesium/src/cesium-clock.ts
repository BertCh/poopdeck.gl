// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Drive the STT playhead from Cesium's render loop instead of per-frame React
 * state. On every DRAWN frame (`scene.preRender`) we READ the governor-owned
 * playback clock and apply the playhead to the layer — so point animation is
 * synced to the actual draw frame and runs off React's throttled UI clock.
 *
 * This is the Cesium analogue of `useDeckClock` (@poopdeck.gl/react), but the
 * READ-ONLY variant: it never advances the controller, so it structurally
 * cannot double-drive it. The controller keeps its own (governor-owned) rAF;
 * while playing that rAF emits `'tick'`, which we use to pump
 * `scene.requestRender()` so a Scene with `requestRenderMode:true` keeps
 * animating while playing and goes fully idle (zero renders) when paused —
 * matching deck.gl's `needsRedraw` idle. IMPORTANT: `requestRenderMode:true`
 * and this pump are an ATOMIC pair — enabling the former without
 * `requestRender:true` here silently freezes the playing animation.
 *
 * Cesium-only (needs a live Scene) → browser-verify; the pure wiring is
 * unit-tested against a fake Scene/clock (this module imports `cesium` for
 * TYPES only, so the test needs no browser globals).
 */

import type { Scene } from 'cesium';

/**
 * The minimal slice of a playback clock this helper reads — structurally
 * satisfied by `@poopdeck.gl/playback`'s `TimeController` with NO import, so the
 * Cesium backend keeps zero dependency on the playback package.
 */
export interface PlayheadClock {
  /** Absolute playhead, Unix ms (matches `TimeController.getTime`). */
  getTime(): number;
  /** Subscribe to per-frame ticks (governor rAF). Returns an unsubscribe fn. */
  on(event: 'tick', callback: (timeMs: number) => void): () => void;
  /** Subscribe to play/pause transitions. Returns an unsubscribe fn. */
  on(
    event: 'playState',
    callback: (playing: boolean, speed: number) => void,
  ): () => void;
}

export interface AttachCesiumClockOptions {
  /**
   * Pump `scene.requestRender()` from the clock so a Scene with
   * `requestRenderMode:true` animates while playing and repaints on seek/pause.
   * Leave false for the default continuous render loop (`preRender` fires every
   * frame regardless of this). @default false
   */
  requestRender?: boolean;
}

/**
 * Bind a governor-owned clock to a Cesium `Scene`: on every rendered frame READ
 * the clock and apply the playhead. Returns a disposer that removes every
 * listener — call it BEFORE `viewer.destroy()`, since the controller typically
 * outlives the component and a missed unsubscribe would call `requestRender`/
 * `apply` against a destroyed Scene.
 */
export function attachCesiumClock(
  scene: Scene,
  clock: PlayheadClock,
  apply: (timeMs: number) => void,
  options: AttachCesiumClockOptions = {},
): () => void {
  // preRender fires immediately before Cesium's primitive-update + draw pass, so
  // a color/uniform written by `apply` lands in the SAME frame.
  const removePreRender = scene.preRender.addEventListener(() =>
    apply(clock.getTime()),
  );

  let removeTick: (() => void) | undefined;
  let removePlayState: (() => void) | undefined;
  if (options.requestRender) {
    const pump = (): void => {
      scene.requestRender();
    };
    removeTick = clock.on('tick', pump);
    removePlayState = clock.on('playState', pump);
  }

  return () => {
    removePreRender();
    removeTick?.();
    removePlayState?.();
  };
}
