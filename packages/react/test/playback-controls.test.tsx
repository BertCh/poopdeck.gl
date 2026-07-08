/**
 * PlaybackControls smoke test: the transport bar mounts and renders its
 * controls with a null governor and minimal props (the first-paint / no-engine
 * path). This guards against gross breakage from the extraction — a render
 * crash, a bad import — without re-testing the engine behavior the hooks cover.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PlaybackControls } from '../src/components/PlaybackControls';
import { usePlayback } from '../src/hooks/use-playback';

afterEach(() => cleanup());

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
