// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * Standard video-player keyboard map for a fullscreen playback surface
 * (player-ergonomics review §3.1). One window-level keydown listener:
 *
 *   Space / K     toggle play–pause
 *   ← / →         committed seek −/+2% of the time range
 *   J / L         committed seek −/+10% of the time range
 *   Home / End    jump to range start / end
 *   ↑ / ↓         speed multiplier up / down the shared step ladder
 *   0–9           jump to N×10% of the range
 *
 * Inert when disabled, when no time range is known, when the event was
 * already handled (`defaultPrevented`), when a meta/ctrl/alt modifier is held
 * (browser shortcuts must win), or when focus is in a form field or
 * contenteditable — including the scrubber itself, whose native arrow
 * behavior is handled by PlaybackControls.
 *
 * Mount this ONLY on a fullscreen surface: scrolling/embed pages must not
 * capture window keys (Space there means "scroll the page").
 */
import { useEffect, useRef } from "react";
// The canonical speed-multiplier ladder lives in @poopdeck.gl/playback so
// keyboard stepping can only land on speeds Auto-speed also produces — no
// hand-maintained copy to drift.
import { SPEED_STEPS } from "@poopdeck.gl/playback";
import type { PlaybackState } from "./use-playback";

/**
 * A held key auto-repeats; every committed seek routes through
 * `governor.seekTo` which flushes prefetch. The governor's settle window
 * already coalesces commits, so no debounce is needed — but cap the rate so a
 * held arrow is a stream of ~6 seeks/s instead of a flushPrefetch storm at
 * the key-repeat rate.
 */
const SEEK_THROTTLE_MS = 150;

/** True when the keystroke belongs to a text/form control, not the player. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function usePlaybackHotkeys(
  playback: PlaybackState,
  timeRange: { start: number; end: number } | undefined,
  enabled = true,
): void {
  // The playback object is a fresh literal every render (it comes out of
  // useDemoPlayback); read it through render-synced refs so the window
  // listener binds once per `enabled` flip instead of once per render.
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;
  const lastSeekAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const pb = playbackRef.current;
      const range = timeRangeRef.current;
      if (!range) return;

      const span = range.end - range.start;
      // Committed seek, clamped to the range and rate-capped (see
      // SEEK_THROTTLE_MS). The exact playhead comes from the controller — the
      // hook's `currentTime` is the 20Hz-throttled UI clock and may trail it.
      const seekTo = (time: number) => {
        const now = performance.now();
        if (now - lastSeekAtRef.current < SEEK_THROTTLE_MS) return;
        lastSeekAtRef.current = now;
        pb.onSeek(Math.min(range.end, Math.max(range.start, time)));
      };
      const seekBy = (fraction: number) =>
        seekTo(pb.timeController.getTime() + span * fraction);
      // Step to the adjacent ladder rung. Auto speed can leave the current
      // multiplier off-ladder, so snap to the nearest rung first.
      const stepSpeed = (direction: 1 | -1) => {
        const current = pb.speedMultiplier;
        let nearest = 0;
        for (let i = 1; i < SPEED_STEPS.length; i++) {
          if (
            Math.abs(SPEED_STEPS[i] - current) <
            Math.abs(SPEED_STEPS[nearest] - current)
          ) {
            nearest = i;
          }
        }
        const next =
          SPEED_STEPS[
            Math.min(SPEED_STEPS.length - 1, Math.max(0, nearest + direction))
          ];
        if (next !== current) pb.onSpeedChange(next);
      };

      switch (event.key) {
        case " ":
        case "k":
        case "K":
          pb.onPlayPause();
          break; // preventDefault below: Space must not scroll the page
        case "ArrowLeft":
          seekBy(-0.02);
          break;
        case "ArrowRight":
          seekBy(0.02);
          break;
        case "j":
        case "J":
          seekBy(-0.1);
          break;
        case "l":
        case "L":
          seekBy(0.1);
          break;
        case "Home":
          seekTo(range.start);
          break;
        case "End":
          seekTo(range.end);
          break;
        case "ArrowUp":
          stepSpeed(1);
          break;
        case "ArrowDown":
          stepSpeed(-1);
          break;
        default: {
          // Digits 0–9: jump to N×10% of the range.
          if (event.key.length === 1 && event.key >= "0" && event.key <= "9") {
            seekTo(range.start + (span * Number(event.key)) / 10);
            break;
          }
          return; // unhandled — leave the event alone
        }
      }
      // Every handled key suppresses its native action (Space/arrow/Home/End
      // scrolling, browser quick-find on letter keys in some configurations).
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
