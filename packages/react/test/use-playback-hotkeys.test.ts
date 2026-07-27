/**
 * usePlaybackHotkeys: the window-level keyboard map and its inert conditions.
 *
 * Driven against a plain mock PlaybackState (the hook only reads
 * onPlayPause/onSeek/onSpeedChange + timeController.getTime() + speedMultiplier),
 * so this exercises the key→action mapping, the seek clamp, the speed ladder,
 * and every short-circuit (disabled / no range / modifier / editable target /
 * already-handled) without the real engine. Uses real timers so the
 * performance.now()-based seek throttle behaves as in the browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { SPEED_STEPS } from '@poopdeck.gl/playback';
import {
  usePlaybackHotkeys,
  PLAYBACK_SHORTCUTS,
} from '../src/hooks/use-playback-hotkeys';
import type { PlaybackState } from '../src/hooks/use-playback';

const RANGE = { start: 0, end: 10_000 };

function mount(opts?: {
  time?: number;
  speed?: number;
  range?: { start: number; end: number };
  enabled?: boolean;
}) {
  const onPlayPause = vi.fn();
  const onSeek = vi.fn();
  const onSpeedChange = vi.fn();
  const playback = {
    timeController: { getTime: () => opts?.time ?? 5_000 },
    speedMultiplier: opts?.speed ?? 1,
    onPlayPause,
    onSeek,
    onSpeedChange,
  } as unknown as PlaybackState;
  const range = opts && 'range' in opts ? opts.range : RANGE;
  const utils = renderHook(() =>
    usePlaybackHotkeys(playback, range, opts?.enabled ?? true),
  );
  return { onPlayPause, onSeek, onSpeedChange, ...utils };
}

/** Dispatch a window keydown (the hook listens on window in the bubble phase). */
function press(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      cancelable: true,
      bubbles: true,
      ...init,
    }),
  );
}

afterEach(() => cleanup());

describe('usePlaybackHotkeys — play/pause', () => {
  it('Space and K toggle play/pause', () => {
    const k = mount();
    press(' ');
    press('k');
    press('K');
    expect(k.onPlayPause).toHaveBeenCalledTimes(3);
  });

  it('does not commit a seek for a play/pause key', () => {
    const k = mount();
    press(' ');
    expect(k.onSeek).not.toHaveBeenCalled();
  });
});

describe('usePlaybackHotkeys — seeking', () => {
  it("Arrow keys seek ±2% of the range from the controller's time", () => {
    const k = mount({ time: 5_000 });
    press('ArrowRight'); // 5000 + 10000*0.02 = 5200
    expect(k.onSeek).toHaveBeenLastCalledWith(5_200);
  });

  it('ArrowLeft seeks backward 2%', () => {
    const k = mount({ time: 5_000 });
    press('ArrowLeft'); // 5000 - 200
    expect(k.onSeek).toHaveBeenLastCalledWith(4_800);
  });

  it('J seeks backward 10% of the range', () => {
    const k = mount({ time: 5_000 });
    press('j');
    expect(k.onSeek).toHaveBeenLastCalledWith(4_000);
  });

  it('L seeks forward 10% of the range', () => {
    const k = mount({ time: 5_000 });
    press('l');
    expect(k.onSeek).toHaveBeenLastCalledWith(6_000);
  });

  it('Home jumps to the range start', () => {
    const k = mount({ time: 5_000 });
    press('Home');
    expect(k.onSeek).toHaveBeenLastCalledWith(0);
  });

  it('End jumps to the range end', () => {
    const k = mount({ time: 5_000 });
    press('End');
    expect(k.onSeek).toHaveBeenLastCalledWith(10_000);
  });

  it('clamps a seek to the range bounds', () => {
    const k = mount({ time: 9_900 });
    press('ArrowRight'); // 9900 + 200 = 10100 → clamped to 10000
    expect(k.onSeek).toHaveBeenLastCalledWith(10_000);
  });

  it('digit keys jump to N×10% of the range', () => {
    const k = mount();
    press('5'); // 0 + 10000 * 5/10
    expect(k.onSeek).toHaveBeenLastCalledWith(5_000);
  });

  it('throttles a held seek key (only the first within the window commits)', () => {
    const k = mount();
    press('ArrowRight');
    press('ArrowRight'); // < SEEK_THROTTLE_MS later (synchronous) → dropped
    expect(k.onSeek).toHaveBeenCalledTimes(1);
  });
});

describe('usePlaybackHotkeys — speed ladder', () => {
  it('steps along the shared @poopdeck.gl/playback SPEED_STEPS ladder (no local copy)', () => {
    // F3: the ladder is imported from playback, not re-declared here, so this
    // is now trivially the same array the hook steps along.
    expect(SPEED_STEPS).toEqual([
      0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10,
    ]);
  });

  it('> steps to the next-higher preset speed', () => {
    const k = mount({ speed: 1 }); // ladder: …,0.75,1,1.5,… → up = 1.5
    press('>');
    expect(k.onSpeedChange).toHaveBeenLastCalledWith(1.5);
  });

  it('< steps to the next-lower preset speed', () => {
    const k = mount({ speed: 1 }); // down = 0.75
    press('<');
    expect(k.onSpeedChange).toHaveBeenLastCalledWith(0.75);
  });

  it('snaps an off-ladder (Auto) speed to the nearest rung before stepping', () => {
    const k = mount({ speed: 1.1 }); // nearest rung = 1 → up = 1.5
    press('>');
    expect(k.onSpeedChange).toHaveBeenLastCalledWith(1.5);
  });

  it('leaves ArrowUp/ArrowDown entirely unmapped (they belong to the map)', () => {
    // deck.gl/maplibre/Cesium all pan on the arrows once their canvas has
    // focus. Claiming ↑/↓ at the window made ONE keypress both pan and change
    // speed, so speed moved to < / > (which is where YouTube keeps it).
    const k = mount({ speed: 1 });
    press('ArrowUp');
    press('ArrowDown');
    expect(k.onSpeedChange).not.toHaveBeenCalled();
  });
});

describe('usePlaybackHotkeys — yielding to the surface underneath', () => {
  /** Dispatch a keydown FROM a specific element (bubbles up to the window). */
  function pressFrom(el: Element, key: string) {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  }

  it('yields Space to a focused button so its own activation still works', () => {
    // A <button> activates on Space. Claiming it here (and preventDefault'ing,
    // which suppresses that activation) left keyboard users unable to press
    // the transport's own Restart / speed / preview buttons.
    const k = mount();
    const button = document.createElement('button');
    document.body.appendChild(button);
    pressFrom(button, ' ');
    expect(k.onPlayPause).not.toHaveBeenCalled();
    button.remove();
  });

  it('still takes K from a focused button (K is not an activation key)', () => {
    const k = mount();
    const button = document.createElement('button');
    document.body.appendChild(button);
    pressFrom(button, 'k');
    expect(k.onPlayPause).toHaveBeenCalledTimes(1);
    button.remove();
  });

  it('yields Space to any activatable ancestor, not just the exact target', () => {
    const k = mount();
    const button = document.createElement('button');
    const span = document.createElement('span');
    button.appendChild(span);
    document.body.appendChild(button);
    pressFrom(span, ' ');
    expect(k.onPlayPause).not.toHaveBeenCalled();
    button.remove();
  });

  it('yields the arrow keys to a focused map canvas', () => {
    const k = mount();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    pressFrom(canvas, 'ArrowRight');
    pressFrom(canvas, 'ArrowLeft');
    expect(k.onSeek).not.toHaveBeenCalled();
    canvas.remove();
  });

  it('yields the arrow keys to an explicit [data-poopdeck-map] surface', () => {
    const k = mount();
    const surface = document.createElement('div');
    surface.setAttribute('data-poopdeck-map', '');
    document.body.appendChild(surface);
    pressFrom(surface, 'ArrowRight');
    expect(k.onSeek).not.toHaveBeenCalled();
    surface.remove();
  });

  it('still takes Space and J/L from a focused map canvas', () => {
    // The map does not use those, so the player keeps them — only the keys
    // that genuinely collide are yielded.
    const k = mount();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    pressFrom(canvas, ' ');
    pressFrom(canvas, 'l');
    expect(k.onPlayPause).toHaveBeenCalledTimes(1);
    expect(k.onSeek).toHaveBeenCalledTimes(1);
    canvas.remove();
  });
});

describe('usePlaybackHotkeys — fine step', () => {
  it(', and . step ∓0.2% of the range', () => {
    const k = mount({ time: 5_000 }); // range 0–10_000 → 0.2% = 20ms
    press('.');
    expect(k.onSeek).toHaveBeenLastCalledWith(5_020);
  });

  it('exposes the map as data for a shortcuts UI', () => {
    // The panel in PlaybackControls renders exactly this, so the two can't
    // drift.
    expect(PLAYBACK_SHORTCUTS.length).toBeGreaterThan(0);
    expect(PLAYBACK_SHORTCUTS.map((s) => s.keys)).toContain('< / >');
    for (const s of PLAYBACK_SHORTCUTS) {
      expect(s.keys).toBeTruthy();
      expect(s.action).toBeTruthy();
    }
  });
});

describe('usePlaybackHotkeys — inert conditions', () => {
  it('does nothing when disabled', () => {
    const k = mount({ enabled: false });
    press(' ');
    press('ArrowRight');
    expect(k.onPlayPause).not.toHaveBeenCalled();
    expect(k.onSeek).not.toHaveBeenCalled();
  });

  it('does nothing when no time range is known', () => {
    const k = mount({ range: undefined });
    press(' ');
    expect(k.onPlayPause).not.toHaveBeenCalled();
  });

  it('ignores keys held with a meta/ctrl/alt modifier', () => {
    const k = mount();
    press(' ', { metaKey: true });
    press('ArrowRight', { ctrlKey: true });
    expect(k.onPlayPause).not.toHaveBeenCalled();
    expect(k.onSeek).not.toHaveBeenCalled();
  });

  it('ignores keys typed into a form field', () => {
    const k = mount();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(k.onPlayPause).not.toHaveBeenCalled();
    input.remove();
  });

  it('ignores an already-handled (defaultPrevented) event', () => {
    const k = mount();
    // A capture-phase listener consumes the event before the hook's
    // bubble-phase listener runs.
    const consume = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', consume, { capture: true });
    press(' ');
    window.removeEventListener('keydown', consume, { capture: true });
    expect(k.onPlayPause).not.toHaveBeenCalled();
  });

  it('leaves unmapped keys alone', () => {
    const k = mount();
    press('a');
    press('Tab');
    expect(k.onPlayPause).not.toHaveBeenCalled();
    expect(k.onSeek).not.toHaveBeenCalled();
    expect(k.onSpeedChange).not.toHaveBeenCalled();
  });
});
