/**
 * Bottom timeline for the AV cockpit. Thin wrapper over the shared
 * {@link PlaybackControls} transport bar from `@poopdeck.gl/react` (the same
 * scrubber + play/pause + density strip + speed every showcase surface uses),
 * wired to the cockpit's `usePlayback` state so it talks to the SAME
 * TimeController + PlaybackGovernor the deck layers + gauges read. Keeping the
 * shared component means the cockpit's transport can't drift from the demos'.
 *
 * Phone widths get the bar's `compact` layout. That decision lives HERE rather
 * than on a prop because both callers — the cockpit's mobile chrome and the
 * worlds gallery's — want it identically, and a prop threaded through two
 * chrome components is a prop that eventually gets passed on one and forgotten
 * on the other.
 */
import React from 'react';
import { PlaybackControls } from '@poopdeck.gl/react';
import { useIsMobile } from '../../lib/useMediaQuery';
import { DARK_CONTROL_THEME } from '../../lib/controlTheme';
import type {
  PlaybackGovernor,
  PlaybackGovernorState,
} from '@poopdeck.gl/playback';

export interface TimelineProps {
  currentTime: number;
  timeRange: { start: number; end: number };
  isPlaying: boolean;
  bufferState: PlaybackGovernorState;
  governor: PlaybackGovernor | null;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (multiplier: number) => void;
  currentSpeedMultiplier: number;
  targetPlaybackSeconds: number;
  autoSpeed: boolean;
  onAutoSpeedSelect: () => void;
  /** Media-element `ended` — swaps the play glyph for replay. */
  ended?: boolean;
  /** Loop state + toggle. Declared explicitly rather than relying on the
   *  `{...playback}` spread carrying them invisibly past the type. */
  loop?: boolean;
  onLoopToggle?: () => void;
  /** Set on surfaces that also mount `usePlaybackHotkeys`. */
  keyboardShortcuts?: boolean;
}

const Timeline: React.FC<TimelineProps> = (props) => {
  const isMobile = useIsMobile();
  return (
    // The shared bar is authored in the site's LIGHT editorial theme, and this
    // card is black glass: without the token remap its `--surface` white icon
    // buttons and `--ink-900` near-black timestamp render as white chips and an
    // invisible date on a black panel. Same remap the deck viewer and the
    // Cesium page apply — see lib/controlTheme.
    <div
      className="rounded-lg border border-white/10 bg-black/60 backdrop-blur-md px-3 py-2 shadow-xl"
      style={DARK_CONTROL_THEME}
    >
      <PlaybackControls {...props} compact={isMobile} />
    </div>
  );
};

export default Timeline;
