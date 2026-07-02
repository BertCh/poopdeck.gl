// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * useDeckClock — bind a {@link TimeController} to a deck.gl render surface so
 * the playhead advances inside deck's animation loop instead of on its own
 * requestAnimationFrame. One frame clock, no phase skew between "time advanced"
 * and "scene drawn".
 *
 * Returns props to spread onto `<DeckGL>`:
 *   - `userData`        mirrors the controller onto `context.userData.stt` so
 *                       every STT layer resolves time with no per-layer prop
 *                       (P1 — the deck-idiomatic global channel).
 *   - `_animate`        forces a redraw every frame *while playing*, so
 *                       `onBeforeRender` fires every frame (deck gates
 *                       `onBeforeRender` behind `needsRedraw`, and `_animate`
 *                       short-circuits that). While paused it's false — no
 *                       wasted redraws; seeks/interactions still redraw via
 *                       deck's normal path.
 *   - `onBeforeRender`  advances the controller once per drawn frame (P2).
 *
 * Kept separate from {@link usePlayback} so non-deck consumers (maplibre /
 * three / standalone) keep the controller's self-owned rAF untouched.
 */
import { useCallback, useEffect, useMemo } from "react";
import type { TimeController } from "@poopdeck.gl/playback";

/** deck.gl props to spread onto `<DeckGL>` to drive a {@link TimeController}. */
export interface DeckClockProps {
  /**
   * deck.gl `_animate`: forces an unconditional redraw every frame while
   * playing, which is what makes `onBeforeRender` fire every frame.
   */
  _animate: boolean;
  /**
   * deck.gl `onBeforeRender`: advances the shared controller in lockstep with
   * deck's render loop. Ignores deck's `{device, gl}` argument.
   */
  onBeforeRender: () => void;
  /**
   * deck.gl `userData`: the app-global channel every STT layer reads via
   * `context.userData.stt.timeController`.
   */
  userData: { stt: { timeController: TimeController } };
}

export function useDeckClock(
  timeController: TimeController,
  isPlaying: boolean,
): DeckClockProps {
  // Hand the per-frame advance to deck's loop for the lifetime of this surface;
  // restore the controller's self-owned rAF on unmount.
  useEffect(() => {
    timeController.attachExternalClock();
    return () => {
      timeController.detachExternalClock();
    };
  }, [timeController]);

  const onBeforeRender = useCallback(() => {
    timeController.advanceFrame();
  }, [timeController]);

  const userData = useMemo(
    () => ({ stt: { timeController } }),
    [timeController],
  );

  return { _animate: isPlaying, onBeforeRender, userData };
}
