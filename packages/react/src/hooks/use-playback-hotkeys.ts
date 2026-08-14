// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * Standard video-player keyboard map for a fullscreen playback surface.
 * One window-level keydown listener:
 *
 *   Space / K     toggle play–pause
 *   ← / →         committed seek −/+2% of the time range
 *   J / L         committed seek −/+10% of the time range
 *   , / .         fine step −/+0.2% (the scrubber's own step)
 *   Home / End    jump to range start / end
 *   < / >         speed multiplier down / up the shared step ladder
 *   0–9           jump to N×10% of the range
 *
 * ## Why `<` / `>` and not ↑ / ↓
 *
 * ↑/↓ is volume in a video player — a data player has no volume, but it DOES
 * have a map underneath, and deck.gl/maplibre/Cesium all pan on the arrow keys
 * once their canvas has focus (deck sets `tabIndex = 0` on it and defaults
 * `keyboard: true`). A window-level listener that claims ↑/↓ therefore fires
 * *in addition to* the map's own pan — one keypress, two reactions. So speed
 * moves to `<` / `>` (shift+comma / shift+period), which is where YouTube puts
 * it anyway, and the arrow keys are yielded to the map whenever the map has
 * focus (see `isMapSurface`). Focus the map → arrows pan; focus anything else
 * → ←/→ seek.
 *
 * ## Inert conditions
 *
 * Inert when disabled, when no time range is known, when the event was already
 * handled (`defaultPrevented`), when a meta/ctrl/alt modifier is held (browser
 * shortcuts must win), or when focus is in a form field or contenteditable —
 * including the scrubber itself, whose arrow behavior `PlaybackControls`
 * implements directly so both paths step by the same 2%.
 *
 * Two narrower yields, both of which exist so the player does not break the
 * thing it is sitting on top of:
 *
 *   - **Space on an activatable element.** A focused `<button>` activates on
 *     Space. Claiming Space at the window (and calling `preventDefault`, which
 *     suppresses that activation) means a keyboard user can Tab to Restart or a
 *     speed preset and be unable to press it. Space is yielded whenever the
 *     event target is a button/link/summary/`role="button"`.
 *   - **Arrow keys on a map canvas.** See above.
 *
 * Mount this ONLY on a fullscreen surface: scrolling/embed pages must not
 * capture window keys (Space there means "scroll the page").
 */
import { useEffect, useRef } from 'react';
// The canonical speed-multiplier ladder lives in @poopdeck.gl/playback so
// keyboard stepping can only land on speeds Auto-speed also produces — no
// hand-maintained copy to drift.
import { SPEED_STEPS } from '@poopdeck.gl/playback';
import type { PlaybackState } from './use-playback.js';

/**
 * A held key auto-repeats; every committed seek routes through
 * `governor.seekTo` which flushes prefetch. The governor's settle window
 * already coalesces commits, so no debounce is needed — but cap the rate so a
 * held arrow is a stream of ~6 seeks/s instead of a flushPrefetch storm at
 * the key-repeat rate.
 */
const SEEK_THROTTLE_MS = 150;

/** Coarse seek step, shared with the scrubber's own arrow handling. */
const SEEK_STEP_FRACTION = 0.02;
/** Fine seek step (`,`/`.`), matching the scrubber's native `step`. */
const FINE_STEP_FRACTION = 0.002;
/** Long seek step (J/L, PageUp/PageDown on the scrubber). */
const LONG_STEP_FRACTION = 0.1;

/** Elements that activate on Space — the player must not steal it from them. */
const ACTIVATABLE_SELECTOR =
  'button, summary, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"]';

/**
 * Elements whose own keyboard handling owns the arrow keys: any map canvas.
 * `[data-poopdeck-map]` is the explicit opt-in for a renderer that puts
 * something other than a bare `<canvas>` in the focus path.
 */
const MAP_SELECTOR = 'canvas, [data-poopdeck-map]';

/** True when the keystroke belongs to a text/form control, not the player. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** True when the focused element activates on Space (button, link, …). */
function isActivatableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(ACTIVATABLE_SELECTOR) != null
  );
}

/** True when the focused element is a map surface that pans on the arrows. */
function isMapSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(MAP_SELECTOR) != null;
}

/** One row of the keyboard map, for rendering a shortcuts panel. */
export interface PlaybackShortcut {
  /** Display form of the key(s), e.g. `'← / →'`. */
  keys: string;
  /** What it does, sentence case. */
  action: string;
}

/**
 * The keyboard map as data, exported so a UI can render it without a
 * hand-maintained copy that drifts from the switch below.
 * `PlaybackControls`' shortcuts panel reads exactly this.
 */
export const PLAYBACK_SHORTCUTS: readonly PlaybackShortcut[] = [
  { keys: 'Space / K', action: 'Play or pause' },
  { keys: '← / →', action: 'Seek ∓2% (map focused: pan)' },
  { keys: 'J / L', action: 'Seek ∓10%' },
  { keys: ', / .', action: 'Fine step ∓0.2%' },
  { keys: 'Home / End', action: 'Jump to start / end' },
  { keys: '< / >', action: 'Slower / faster' },
  { keys: '0 – 9', action: 'Jump to 0–90% of the range' },
];

export function usePlaybackHotkeys(
  playback: PlaybackState,
  timeRange: { start: number; end: number } | undefined,
  enabled = true,
): void {
  // The playback object is a fresh literal every render (it comes out of
  // useDemoPlayback); read it through refs so the window listener binds once
  // per `enabled` flip instead of once per render. Written in an EFFECT, not
  // during render — React 19 forbids render-phase ref writes, and a concurrent
  // render that gets thrown away would otherwise leave a value here that no
  // committed tree ever agreed to.
  const playbackRef = useRef(playback);
  const timeRangeRef = useRef(timeRange);
  useEffect(() => {
    playbackRef.current = playback;
    timeRangeRef.current = timeRange;
  });
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
      // hook's `currentTime` is the 10Hz-throttled UI clock and may trail it.
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
        case ' ':
          // A focused button activates on Space; claiming it here (and the
          // preventDefault below) would make that button unpressable.
          if (isActivatableTarget(event.target)) return;
          pb.onPlayPause();
          break;
        case 'k':
        case 'K':
          pb.onPlayPause();
          break;
        case 'ArrowLeft':
          // The map pans on the arrows once its canvas has focus; two
          // reactions to one keypress is worse than no seek.
          if (isMapSurface(event.target)) return;
          seekBy(-SEEK_STEP_FRACTION);
          break;
        case 'ArrowRight':
          if (isMapSurface(event.target)) return;
          seekBy(SEEK_STEP_FRACTION);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          // Deliberately unmapped — yielded to the map's pan (see the module
          // docstring). Speed lives on `<` / `>`.
          return;
        case 'j':
        case 'J':
          seekBy(-LONG_STEP_FRACTION);
          break;
        case 'l':
        case 'L':
          seekBy(LONG_STEP_FRACTION);
          break;
        case ',':
          seekBy(-FINE_STEP_FRACTION);
          break;
        case '.':
          seekBy(FINE_STEP_FRACTION);
          break;
        case 'Home':
          seekTo(range.start);
          break;
        case 'End':
          seekTo(range.end);
          break;
        case '<':
          stepSpeed(-1);
          break;
        case '>':
          stepSpeed(1);
          break;
        default: {
          // Digits 0–9: jump to N×10% of the range.
          if (event.key.length === 1 && event.key >= '0' && event.key <= '9') {
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

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
