/**
 * Bottom timeline for the AV cockpit. Thin wrapper over the shared
 * {@link PlaybackControls} transport bar from `@poopdeck.gl/react` (the same
 * scrubber + play/pause + density strip + speed every showcase surface uses),
 * wired to the cockpit's `usePlayback` state so it talks to the SAME
 * TimeController + PlaybackGovernor the deck layers + gauges read. Keeping the
 * shared component means the cockpit's transport can't drift from the demos'.
 */
import React from "react";
import { PlaybackControls } from "@poopdeck.gl/react";
import type { PlaybackGovernor, PlaybackGovernorState } from "@poopdeck.gl/playback";

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
}

const Timeline: React.FC<TimelineProps> = (props) => {
  return (
    <div className="rounded-lg border border-white/10 bg-black/60 backdrop-blur-md px-3 py-2 shadow-xl">
      <PlaybackControls {...props} />
    </div>
  );
};

export default Timeline;
