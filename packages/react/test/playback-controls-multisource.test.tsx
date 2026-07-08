/**
 * PlaybackControls multi-source runway strip (multi-source coordination Phase 4).
 *
 * The transport bar polls `governor.getSourceRunways()` and, when 2+ sources are
 * registered, renders a compact per-source strip with the gating source (the
 * required, not-yet-complete source with the least runway) highlighted in the
 * accent colour. With 0 or 1 source the strip must NOT render (single-dataset
 * demos are visually unchanged). Here we drive the component with a minimal mock
 * governor exposing only the members the bar reads — the real governor's
 * probe math is covered by @poopdeck.gl/playback's own tests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { PlaybackGovernor, SourceRunway } from '@poopdeck.gl/playback';
import { PlaybackControls } from '../src/components/PlaybackControls';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A stand-in governor exposing only what PlaybackControls polls/calls. */
function makeMockGovernor(runways: SourceRunway[]): PlaybackGovernor {
  const g = {
    state: 'idle' as const,
    isCreeping: false,
    seekSettleMs: 200,
    getBufferedRanges: () => [],
    getSourceRunways: () => runways,
    getEtaMs: () => null,
    estimateCost: () => ({ bytes: 0, tiles: 0 }),
    on: () => {},
    off: () => {},
    beginScrub: () => {},
    scrubTo: () => {},
    endScrub: () => {},
    seekTo: () => {},
  };
  return g as unknown as PlaybackGovernor;
}

const baseProps = {
  currentTime: 5_000,
  timeRange: { start: 0, end: 10_000 },
  isPlaying: true,
  bufferState: 'idle' as const,
  onPlayPause: () => {},
  onSeek: () => {},
  onSpeedChange: () => {},
  currentSpeedMultiplier: 1,
  targetPlaybackSeconds: 30,
  autoSpeed: false,
  onAutoSpeedSelect: () => {},
};

describe('PlaybackControls multi-source runway strip', () => {
  it('renders one track per source and highlights the gating source', () => {
    // Two required sources (one lagging = gating) + one optional.
    const runways: SourceRunway[] = [
      {
        id: 'field',
        required: true,
        runwaySimMs: 4_000,
        complete: false,
        bytesPending: 10,
      },
      {
        id: 'cells',
        required: true,
        runwaySimMs: 1_000,
        complete: false,
        bytesPending: 50,
      }, // gating
      {
        id: 'tracks',
        required: false,
        runwaySimMs: 8_000,
        complete: false,
        bytesPending: 0,
      },
    ];
    const governor = makeMockGovernor(runways);

    let container!: HTMLElement;
    act(() => {
      ({ container } = render(
        <PlaybackControls {...baseProps} governor={governor} />,
      ));
    });

    // One titled track per source (titles carry the per-source words).
    const tracks = Array.from(container.querySelectorAll('[title]')).filter(
      (el) => /field|cells|tracks/.test(el.getAttribute('title') ?? ''),
    );
    expect(tracks.length).toBe(3);

    const gating = container.querySelector('[title^="cells:"]');
    expect(gating).not.toBeNull();
    expect(gating!.getAttribute('title')).toContain('gating');

    // The gating source's fill uses the accent colour; non-gating do not.
    const gatingFill = gating!.querySelector<HTMLElement>('div');
    expect(gatingFill?.style.background).toContain('--accent');

    const fieldTrack = container.querySelector('[title^="field:"]');
    const fieldFill = fieldTrack!.querySelector<HTMLElement>('div');
    expect(fieldFill?.style.background).not.toContain('--accent');
  });

  it('renders NO strip for a single source (degrades to the plain bar)', () => {
    const runways: SourceRunway[] = [
      {
        id: 'default',
        required: true,
        runwaySimMs: 4_000,
        complete: false,
        bytesPending: 0,
      },
    ];
    const governor = makeMockGovernor(runways);

    let container!: HTMLElement;
    act(() => {
      ({ container } = render(
        <PlaybackControls {...baseProps} governor={governor} />,
      ));
    });

    expect(container.querySelector('[title^="default:"]')).toBeNull();
    // The bar itself still renders.
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
  });

  it('highlights nothing when every required source is complete', () => {
    const runways: SourceRunway[] = [
      {
        id: 'a',
        required: true,
        runwaySimMs: 9_000,
        complete: true,
        bytesPending: 0,
      },
      {
        id: 'b',
        required: true,
        runwaySimMs: 9_000,
        complete: true,
        bytesPending: 0,
      },
    ];
    const governor = makeMockGovernor(runways);

    let container!: HTMLElement;
    act(() => {
      ({ container } = render(
        <PlaybackControls {...baseProps} governor={governor} />,
      ));
    });

    // Both tracks present, neither labelled gating, neither using accent.
    expect(container.querySelectorAll('[title*="gating"]').length).toBe(0);
    const fills = Array.from(
      container.querySelectorAll('[title^="a:"] div, [title^="b:"] div'),
    ) as HTMLElement[];
    for (const f of fills) expect(f.style.background).not.toContain('--accent');
  });
});
