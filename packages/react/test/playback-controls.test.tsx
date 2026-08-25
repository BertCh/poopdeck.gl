/**
 * PlaybackControls smoke test: the transport bar mounts and renders its
 * controls with a null governor and minimal props (the first-paint / no-engine
 * path). This guards against gross breakage from the extraction — a render
 * crash, a bad import — without re-testing the engine behavior the hooks cover.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { PlaybackControls } from '../src/components/PlaybackControls';
import type { PlaybackControlsProps } from '../src/components/PlaybackControls';
import { usePlayback } from '../src/hooks/use-playback';

afterEach(() => cleanup());

const RANGE = { start: 0, end: 10_000 };

const baseProps = (
  over: Partial<PlaybackControlsProps> = {},
): PlaybackControlsProps => ({
  currentTime: 0,
  timeRange: RANGE,
  isPlaying: false,
  bufferState: 'idle',
  governor: null,
  onPlayPause: () => {},
  onSeek: () => {},
  onSpeedChange: () => {},
  currentSpeedMultiplier: 1,
  targetPlaybackSeconds: 30,
  autoSpeed: false,
  onAutoSpeedSelect: () => {},
  ...over,
});

describe('PlaybackControls', () => {
  it('renders the transport bar with a null governor and minimal props', () => {
    const { container } = render(
      <PlaybackControls
        currentTime={0}
        timeRange={{ start: 0, end: 10_000 }}
        isPlaying={false}
        bufferState="idle"
        governor={null}
        onPlayPause={() => {}}
        onSeek={() => {}}
        onSpeedChange={() => {}}
        currentSpeedMultiplier={1}
        targetPlaybackSeconds={30}
        autoSpeed={false}
        onAutoSpeedSelect={() => {}}
      />,
    );
    expect(container.firstChild).not.toBeNull();
    // The scrubber (a range input) and at least one control button render.
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('renders straight from a usePlayback spread — <PlaybackControls {...pb} />', () => {
    // The one-liner integration the README promises: the hook's return is
    // spread-compatible (timeRange echoed, speed under the prop's name,
    // targetPlaybackSeconds defaulted). This also type-checks the contract —
    // a renamed member on either side fails compilation here.
    function Transport() {
      const pb = usePlayback({ timeRange: { start: 0, end: 10_000 } });
      return <PlaybackControls {...pb} />;
    }
    const { container } = render(<Transport />);
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
    expect(container.querySelector('button')).not.toBeNull();
  });
});

describe('PlaybackControls — HTML semantics', () => {
  it('gives every button an explicit type="button"', () => {
    // The bar is a published component; dropped into a consumer's <form> a
    // type-less button defaults to submit, so pressing Play would submit it.
    const { container } = render(
      <PlaybackControls
        {...baseProps({ onLoopToggle: () => {}, loop: true })}
      />,
    );
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button');
  });

  it('models the speed choices as one radio group, not toggle buttons', () => {
    // The presets and Auto are mutually exclusive, which is a radio group —
    // native radios also bring roving arrow-key traversal for free.
    const { container } = render(
      <PlaybackControls {...baseProps({ currentSpeedMultiplier: 2 })} />,
    );
    const radios = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(radios).toHaveLength(6); // 0.5/1/2/5/10 + Auto
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.filter((r) => r.checked)).toHaveLength(1);
    // No faked toggle semantics left behind.
    expect(container.querySelector('[aria-pressed]')).toBeNull();
  });

  it('scopes the radio group name per instance so two bars do not fuse', () => {
    const { container } = render(
      <>
        <PlaybackControls {...baseProps()} />
        <PlaybackControls {...baseProps()} />
      </>,
    );
    const names = new Set(
      Array.from(
        container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ).map((r) => r.name),
    );
    expect(names.size).toBe(2);
  });

  it('merges className and style onto the root', () => {
    const { container } = render(
      <PlaybackControls
        {...baseProps({ className: 'my-bar', style: { opacity: 0.5 } })}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('my-bar')).toBe(true);
    expect(root.style.opacity).toBe('0.5');
  });

  it('pads the scrub hit area out to the 24px target minimum', () => {
    // WCAG 2.5.8. The painted track stays 6px; the input covers 9+6+9.
    const { container } = render(<PlaybackControls {...baseProps()} />);
    const slider = container.querySelector(
      'input[type="range"][aria-label="Playback position"]',
    ) as HTMLInputElement;
    const hitArea = slider.parentElement as HTMLElement;
    expect(hitArea.style.paddingTop).toBe('9px');
    expect(hitArea.style.paddingBottom).toBe('9px');
    // …and a touch drag must scrub, not scroll the page.
    expect(slider.style.touchAction).toBe('none');
  });
});

describe('PlaybackControls — compact layout', () => {
  /**
   * The compact bar exists so a phone-width surface does not lose half its map
   * to the transport. These pin the trade it makes: one row fewer, the speed
   * group folded behind a chip, the hover/keyboard-only affordances gone — and
   * NOTHING actually removed, since every one of those still reaches the same
   * handler through the popover.
   */
  /** How many formatted timestamps the bar prints (they are all the same
   *  instant on this 10s range, so count rather than match). */
  const stampCount = (el: HTMLElement) =>
    (el.textContent ?? '').match(/Jan 1, 1970/g)?.length ?? 0;

  it('drops the range-endpoint row and the fine speed slider', () => {
    const wide = render(<PlaybackControls {...baseProps()} />);
    const wideRanges = wide.container.querySelectorAll(
      'input[type="range"]',
    ).length;
    // Playhead + both range endpoints.
    expect(stampCount(wide.container as HTMLElement)).toBe(3);
    expect(wideRanges).toBe(2);
    cleanup();

    const { container } = render(
      <PlaybackControls {...baseProps({ compact: true })} />,
    );
    // Scrubber only — the speed slider is gone.
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(1);
    // …and the endpoint row with it: the playhead label is the only stamp left.
    expect(stampCount(container as HTMLElement)).toBe(1);
  });

  it('keeps every speed choice reachable — as a real radio group in a popover', () => {
    const onSpeedChange = vi.fn();
    const { container, getByRole } = render(
      <PlaybackControls {...baseProps({ compact: true, onSpeedChange })} />,
    );
    // Collapsed: no radios on the bar itself.
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);

    const chip = getByRole('button', { name: /Playback speed/ });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');

    // Five presets + Auto, still one mutually-exclusive radio group.
    const radios = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(radios).toHaveLength(6);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);

    fireEvent.click(radios[2]); // 2x
    expect(onSpeedChange).toHaveBeenCalledWith(2);
  });

  it('closes the speed popover on Escape', () => {
    const { getByRole } = render(
      <PlaybackControls {...baseProps({ compact: true })} />,
    );
    const chip = getByRole('button', { name: /Playback speed/ });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides the hover-preview and shortcuts controls (mouse/keyboard only)', () => {
    const { queryByLabelText } = render(
      <PlaybackControls
        {...baseProps({
          compact: true,
          keyboardShortcuts: true,
          renderPreview: () => <span>frame</span>,
        })}
      />,
    );
    expect(queryByLabelText('Scrubber hover preview')).toBeNull();
    expect(queryByLabelText('Keyboard shortcuts')).toBeNull();
  });

  it('grows the transport targets for a thumb', () => {
    const { getByLabelText } = render(
      <PlaybackControls
        {...baseProps({ compact: true, onLoopToggle: () => {} })}
      />,
    );
    expect((getByLabelText('Play') as HTMLElement).style.height).toBe('44px');
    expect(
      (getByLabelText('Back 10 percent') as HTMLElement).style.height,
    ).toBe('34px');
  });

  it('still transports — play/pause and the skip buttons keep their handlers', () => {
    const onPlayPause = vi.fn();
    const onSeek = vi.fn();
    const { getByLabelText } = render(
      <PlaybackControls
        {...baseProps({
          compact: true,
          currentTime: 5_000,
          onPlayPause,
          onSeek,
        })}
      />,
    );
    fireEvent.click(getByLabelText('Play'));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
    fireEvent.click(getByLabelText('Forward 10 percent'));
    expect(onSeek).toHaveBeenCalledWith(6_000);
  });
});

describe('PlaybackControls — status announcements', () => {
  it('keeps the per-second countdown OUT of the live region', () => {
    // Inside aria-live the countdown makes a screen reader recite
    // "58s left, 57s left, …" for the whole session.
    const { container } = render(
      <PlaybackControls
        {...baseProps({ isPlaying: true, bufferState: 'playing' })}
      />,
    );
    const live = container.querySelector('output') as HTMLElement;
    expect(live).not.toBeNull();
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    // The countdown still renders — just as a sibling, not a live update.
    expect(container.textContent).toContain('left');
  });

  it('puts genuine transitions (buffering) IN the live region', () => {
    const { container } = render(
      <PlaybackControls
        {...baseProps({ isPlaying: true, bufferState: 'buffering' })}
      />,
    );
    const live = container.querySelector('output') as HTMLElement;
    expect(live.textContent).toContain('Buffering');
  });

  it('announces the ended state', () => {
    const { container } = render(
      <PlaybackControls {...baseProps({ ended: true })} />,
    );
    expect((container.querySelector('output') as HTMLElement).textContent).toBe(
      'Ended',
    );
  });
});

describe('PlaybackControls — transport', () => {
  it('shows a replay affordance when parked at the range end', () => {
    // The governor has exposed `ended` (and implemented replay-on-play) all
    // along; the bar never rendered it.
    const { getByLabelText, queryByLabelText } = render(
      <PlaybackControls {...baseProps({ ended: true })} />,
    );
    expect(getByLabelText('Replay')).toBeTruthy();
    expect(queryByLabelText('Play')).toBeNull();
  });

  it('restart seeks to the start AND plays (media replay convention)', () => {
    const onSeek = vi.fn();
    const onPlayPause = vi.fn();
    const { getByLabelText } = render(
      <PlaybackControls
        {...baseProps({
          currentTime: 5_000,
          isPlaying: false,
          onSeek,
          onPlayPause,
        })}
      />,
    );
    fireEvent.click(getByLabelText('Restart from beginning'));
    expect(onSeek).toHaveBeenCalledWith(RANGE.start);
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });

  it('skip buttons seek ±10% and clamp to the range', () => {
    const onSeek = vi.fn();
    const { getByLabelText } = render(
      <PlaybackControls {...baseProps({ currentTime: 5_000, onSeek })} />,
    );
    fireEvent.click(getByLabelText('Forward 10 percent'));
    expect(onSeek).toHaveBeenLastCalledWith(6_000);
    fireEvent.click(getByLabelText('Back 10 percent'));
    expect(onSeek).toHaveBeenLastCalledWith(4_000);
  });

  it('renders the loop toggle only when the handler is supplied', () => {
    const onLoopToggle = vi.fn();
    const { queryByLabelText: without } = render(
      <PlaybackControls {...baseProps()} />,
    );
    expect(without('Loop at the end of the range')).toBeNull();
    cleanup();
    const { getByLabelText } = render(
      <PlaybackControls {...baseProps({ loop: true, onLoopToggle })} />,
    );
    const toggle = getByLabelText('Loop at the end of the range');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(onLoopToggle).toHaveBeenCalledTimes(1);
  });
});

describe('PlaybackControls — scrubber keyboard', () => {
  const scrubber = (c: HTMLElement) =>
    c.querySelector(
      'input[type="range"][aria-label="Playback position"]',
    ) as HTMLInputElement;

  it('steps the focused scrubber by the SAME 2% the global hotkeys use', () => {
    // The native step is range/500 (kept small so DRAGGING stays smooth), so
    // before this the same arrow key moved 0.2% on the scrubber and 2%
    // everywhere else.
    vi.useFakeTimers();
    try {
      const onSeek = vi.fn();
      const { container } = render(
        <PlaybackControls {...baseProps({ currentTime: 5_000, onSeek })} />,
      );
      fireEvent.keyDown(scrubber(container), { key: 'ArrowRight' });
      // Commit is settle-debounced (200ms with no governor).
      expect(onSeek).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(250));
      expect(onSeek).toHaveBeenCalledWith(5_200); // +2% of 10_000
    } finally {
      vi.useRealTimers();
    }
  });

  it('accumulates repeats and commits ONCE when the key rests', () => {
    vi.useFakeTimers();
    try {
      const onSeek = vi.fn();
      const { container } = render(
        <PlaybackControls {...baseProps({ currentTime: 5_000, onSeek })} />,
      );
      const el = scrubber(container);
      // A held key repeats faster than React commits; each step must build on
      // the last chosen value, not on the last rendered one.
      fireEvent.keyDown(el, { key: 'ArrowRight' });
      fireEvent.keyDown(el, { key: 'ArrowRight' });
      fireEvent.keyDown(el, { key: 'ArrowRight' });
      act(() => void vi.advanceTimersByTime(250));
      expect(onSeek).toHaveBeenCalledTimes(1);
      expect(onSeek).toHaveBeenCalledWith(5_600);
    } finally {
      vi.useRealTimers();
    }
  });

  it('PageUp/PageDown step 10% and Home/End clamp to the range', () => {
    vi.useFakeTimers();
    try {
      const onSeek = vi.fn();
      const { container } = render(
        <PlaybackControls {...baseProps({ currentTime: 5_000, onSeek })} />,
      );
      fireEvent.keyDown(scrubber(container), { key: 'PageUp' });
      act(() => void vi.advanceTimersByTime(250));
      expect(onSeek).toHaveBeenLastCalledWith(6_000);

      fireEvent.keyDown(scrubber(container), { key: 'End' });
      act(() => void vi.advanceTimersByTime(250));
      expect(onSeek).toHaveBeenLastCalledWith(RANGE.end);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Tile-loading audit 2026-08 follow-up (found by a peer session's React audit,
// measured on a 4 s motionless hover: PAUSED armed 2× / fired 1×, PLAYING
// armed 40× / fired 0×). The settle effect depended on `renderPreview`'s
// IDENTITY; callers pass a fresh arrow per render and the parent re-renders
// ~10×/s during playback, so the cleanup killed the 120 ms timer before it
// could ever fire — the scrubber preview never advanced exactly when it was
// being used.
describe('hover preview settle survives parent re-renders (playback)', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('advances the preview to the hovered time while the parent re-renders every 100 ms with a fresh renderPreview', () => {
    vi.useFakeTimers();
    // rAF → run on the next macrotask so `advanceTimersByTime` drives it.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

    const rendered: number[] = [];
    const makeProps = (currentTime: number) =>
      baseProps({
        currentTime,
        isPlaying: true,
        // A NEW arrow every render, as real callers do.
        renderPreview: (t: number) => {
          rendered.push(t);
          return <span data-testid="pv">{t}</span>;
        },
      });

    const view = render(<PlaybackControls {...makeProps(0)} />);
    const toggle = view.container.querySelector(
      'button[title="Show a rendered preview of the map at the hovered time"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    act(() => {
      fireEvent.click(toggle);
    });

    const bar = view.container.querySelector(
      '[class*="cursor-pointer"]',
    ) as HTMLDivElement;
    expect(bar).not.toBeNull();
    Object.defineProperty(bar, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: 500,
        height: 20,
        right: 500,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    // Cursor rests at the midpoint → hovered time = 5,000 of [0, 10,000].
    // jsdom has no PointerEvent; the handler reads `pointerType` off the
    // native event, so dispatch a MouseEvent carrying it.
    act(() => {
      const ev = new MouseEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        clientX: 250,
        buttons: 0,
      });
      Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
      fireEvent(bar, ev);
    });
    act(() => void vi.advanceTimersByTime(1)); // the hover rAF lands

    // Playback: the parent re-renders every 100 ms for a full second, each
    // time with a new `renderPreview` identity and an advanced clock. The
    // settle timer is 120 ms, so under the old dependency it never fired.
    for (let i = 1; i <= 10; i++) {
      view.rerender(<PlaybackControls {...makeProps(i * 100)} />);
      act(() => void vi.advanceTimersByTime(100));
    }

    const pv = view.container.querySelector('[data-testid="pv"]');
    expect(pv).not.toBeNull();
    expect(pv!.textContent).toBe('5000');
    expect(rendered[rendered.length - 1]).toBe(5000);
    vi.unstubAllGlobals();
  });
});
