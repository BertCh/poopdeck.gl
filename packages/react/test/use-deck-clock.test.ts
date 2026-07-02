/**
 * useDeckClock: binds a TimeController to a deck.gl surface so the playhead
 * advances inside deck's render loop. Verifies the attach/detach lifecycle and
 * the deck props it returns (`_animate`, `onBeforeRender`, `userData`).
 *
 * Driven against a mock controller (the hook only calls attach/detach/advance),
 * so no real engine or WebGL is needed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useDeckClock } from '../src/hooks/use-deck-clock';
import type { TimeController } from '@poopdeck.gl/playback';

afterEach(() => cleanup());

function makeController() {
  return {
    attachExternalClock: vi.fn(),
    detachExternalClock: vi.fn(),
    advanceFrame: vi.fn(),
  };
}

describe('useDeckClock', () => {
  it('attaches the external clock on mount and detaches on unmount', () => {
    const c = makeController();
    const { unmount } = renderHook(() =>
      useDeckClock(c as unknown as TimeController, false),
    );
    expect(c.attachExternalClock).toHaveBeenCalledTimes(1);
    expect(c.detachExternalClock).not.toHaveBeenCalled();

    unmount();
    expect(c.detachExternalClock).toHaveBeenCalledTimes(1);
  });

  it('onBeforeRender advances the controller', () => {
    const c = makeController();
    const { result } = renderHook(() =>
      useDeckClock(c as unknown as TimeController, true),
    );
    result.current.onBeforeRender();
    result.current.onBeforeRender();
    expect(c.advanceFrame).toHaveBeenCalledTimes(2);
  });

  it('_animate mirrors isPlaying and userData carries the controller', () => {
    const c = makeController();
    const { result, rerender } = renderHook(
      ({ playing }: { playing: boolean }) =>
        useDeckClock(c as unknown as TimeController, playing),
      { initialProps: { playing: false } },
    );

    expect(result.current._animate).toBe(false);
    expect(result.current.userData).toEqual({ stt: { timeController: c } });

    rerender({ playing: true });
    expect(result.current._animate).toBe(true);
  });
});
