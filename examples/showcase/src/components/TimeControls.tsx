import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlaybackGovernor, PlaybackGovernorState } from "@stt/deck.gl";

interface TimeControlsProps {
  currentTime: number;
  timeRange: { start: number; end: number };
  /** User intent (drives the play/pause glyph); the governor may still be gating. */
  isPlaying: boolean;
  /** Governor machine state (drives the buffering chip). */
  bufferState: PlaybackGovernorState;
  /**
   * The playback governor. Drag-scrubbing talks to it directly
   * (beginScrub/scrubTo/endScrub); committed seeks go through `onSeek` so the
   * page owns the commit path. Null only for the first paint — the page
   * creates it in a mount effect (StrictMode-safe lifecycle); scrub commits
   * fall back to `onSeek` until it exists.
   */
  governor: PlaybackGovernor | null;
  onPlayPause: () => void;
  /** Committed seek (keyboard arrows on the slider, jump-to-start). */
  onSeek: (time: number) => void;
  onSpeedChange: (multiplier: number) => void;
  currentSpeedMultiplier: number;
  targetPlaybackSeconds: number;
  /** Whether the opt-in Auto speed mode is active. */
  autoSpeed: boolean;
  /** Select Auto speed mode (any explicit preset/slider choice exits it). */
  onAutoSpeedSelect: () => void;
}

const TimeControls: React.FC<TimeControlsProps> = ({
  currentTime,
  timeRange,
  isPlaying,
  bufferState,
  governor,
  onPlayPause,
  onSeek,
  onSpeedChange,
  currentSpeedMultiplier,
  targetPlaybackSeconds,
  autoSpeed,
  onAutoSpeedSelect,
}) => {
  // ── Drag-aware scrubbing ────────────────────────────────────────────────────
  // While the thumb is held, every move is a PREVIEW (instant feedback from
  // whatever tiles are resident — no fetch churn); the real seek commits on
  // release, or early if the position rests unchanged for the governor's
  // settle window while still dragging. Keyboard arrows (onChange without a
  // preceding pointerdown) are immediate commits.
  const draggingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrubValue, setScrubValue] = useState<number | null>(null);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const handleScrubStart = useCallback(() => {
    draggingRef.current = true;
    governor?.beginScrub();
  }, [governor]);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      if (draggingRef.current && governor) {
        setScrubValue(value);
        governor.scrubTo(value); // preview only
        // Settle commit: if the thumb rests here, commit without waiting for
        // release (video-player behaviour). Further movement re-arms it.
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          if (draggingRef.current) governor.seekTo(value);
        }, governor.seekSettleMs);
      } else {
        // Keyboard arrows / programmatic change — immediate commit.
        onSeek(value);
      }
    },
    [governor, onSeek, clearSettleTimer],
  );

  const handleScrubEnd = useCallback(
    (e: React.SyntheticEvent<HTMLInputElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      clearSettleTimer();
      const value = Number(e.currentTarget.value);
      setScrubValue(null);
      if (governor) {
        governor.endScrub(value);
      } else {
        onSeek(value);
      }
    },
    [governor, onSeek, clearSettleTimer],
  );

  useEffect(() => clearSettleTimer, [clearSettleTimer]);

  // While dragging, the slider (and the progress fill) follows the thumb, not
  // the throttled page time.
  const displayTime = scrubValue ?? currentTime;

  // ── Buffered ranges + ETA (the gray "buffered" bar + buffering chip) ───────
  const [bufferedRanges, setBufferedRanges] = useState<
    Array<{ start: number; end: number }>
  >([]);
  const [etaMs, setEtaMs] = useState<number | null>(null);
  const isBuffering =
    bufferState === "starting" ||
    bufferState === "buffering" ||
    bufferState === "seeking";

  useEffect(() => {
    if (!governor) return;
    let lastProgressUpdate = 0;
    const update = () => {
      setBufferedRanges(governor.getBufferedRanges({ maxRanges: 64 }));
      setEtaMs(
        governor.state === "starting" ||
          governor.state === "buffering" ||
          governor.state === "seeking"
          ? governor.getEtaMs()
          : null,
      );
    };
    // ~1Hz poll while mounted, plus immediate (throttled) refresh on buffer
    // progress events so the bar tracks loading without waiting a second.
    const onProgress = () => {
      const now = performance.now();
      if (now - lastProgressUpdate < 250) return;
      lastProgressUpdate = now;
      update();
    };
    update();
    const intervalId = setInterval(update, 1000);
    governor.on("progress", onProgress);
    return () => {
      clearInterval(intervalId);
      governor.off("progress", onProgress);
    };
  }, [governor]);

  const progress = useMemo(() => {
    const total = timeRange.end - timeRange.start;
    if (total === 0) return 0;
    return ((displayTime - timeRange.start) / total) * 100;
  }, [displayTime, timeRange]);

  const remainingSeconds = useMemo(() => {
    const remaining = (100 - progress) / 100;
    return (targetPlaybackSeconds / currentSpeedMultiplier) * remaining;
  }, [progress, targetPlaybackSeconds, currentSpeedMultiplier]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600)
      return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const speedPresets = [
    { label: "0.5x", value: 0.5 },
    { label: "1x", value: 1 },
    { label: "2x", value: 2 },
    { label: "5x", value: 5 },
    { label: "10x", value: 10 },
  ];

  const etaLabel =
    etaMs != null && Number.isFinite(etaMs) && etaMs > 0
      ? ` ~${Math.max(1, Math.round(etaMs / 1000))}s`
      : "…";

  return (
    <div className="space-y-3">
      {/* Time display */}
      <div className="flex justify-between items-center">
        <span
          className="text-xs font-medium font-mono"
          style={{ color: "var(--ink-900)" }}
        >
          {formatDate(displayTime)}
        </span>
        {isBuffering ? (
          <span
            className="text-[10px] flex items-center gap-1.5"
            style={{ color: "var(--ink-500)" }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full border-2 animate-spin"
              style={{
                borderColor: "var(--accent)",
                borderTopColor: "transparent",
              }}
            />
            Buffering{etaLabel}
          </span>
        ) : (
          <span
            className="text-[10px] flex items-center gap-1.5"
            style={{ color: "var(--ink-500)" }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: isPlaying ? "var(--accent)" : "var(--ink-400)" }}
            />
            {isPlaying ? `${formatDuration(remainingSeconds)} left` : "Paused"}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div
        className="relative h-1.5 rounded-full cursor-pointer"
        style={{ background: "var(--hairline)" }}
      >
        {/* Buffered ranges — the translucent "loaded" bar every video player
            has, straight from the tileset's coverage index. */}
        {bufferedRanges.map((range, i) => {
          const total = timeRange.end - timeRange.start;
          if (total <= 0) return null;
          const left = Math.max(
            0,
            Math.min(100, ((range.start - timeRange.start) / total) * 100),
          );
          const right = Math.max(
            0,
            Math.min(100, ((range.end - timeRange.start) / total) * 100),
          );
          if (right - left <= 0) return null;
          return (
            <div
              key={i}
              className="absolute top-0 h-full rounded-full"
              style={{
                left: `${left}%`,
                width: `${right - left}%`,
                background: "var(--ink-400)",
                opacity: 0.35,
              }}
            />
          );
        })}
        <div
          className="absolute left-0 top-0 h-full rounded-full"
          style={{ width: `${progress}%`, background: "var(--accent)" }}
        />
        <input
          type="range"
          min={timeRange.start}
          max={timeRange.end}
          value={displayTime}
          onPointerDown={handleScrubStart}
          onChange={handleSliderChange}
          onPointerUp={handleScrubEnd}
          onPointerCancel={handleScrubEnd}
          onBlur={handleScrubEnd}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>

      {/* Time range labels */}
      <div className="flex justify-between">
        <span className="text-[9px]" style={{ color: "var(--ink-400)" }}>
          {formatDate(timeRange.start)}
        </span>
        <span className="text-[9px]" style={{ color: "var(--ink-400)" }}>
          {formatDate(timeRange.end)}
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Play/Pause */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onPlayPause}
            className="w-8 h-8 rounded flex items-center justify-center text-sm transition-colors"
            style={{
              background: "var(--accent)",
              color: "#FFFFFF",
            }}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button
            onClick={() => onSeek(timeRange.start)}
            className="w-7 h-7 rounded flex items-center justify-center text-xs transition-colors"
            style={{
              background: "var(--surface)",
              color: "var(--ink-500)",
              border: "1px solid var(--hairline)",
            }}
          >
            ⏮
          </button>
        </div>

        {/* Speed presets */}
        <div className="flex items-center gap-1">
          <span
            className="text-[10px] mr-1 hidden sm:inline"
            style={{ color: "var(--ink-500)" }}
          >
            Speed:
          </span>
          {speedPresets.map((preset) => {
            const isActive =
              !autoSpeed && Math.abs(currentSpeedMultiplier - preset.value) < 0.1;
            return (
              <button
                key={preset.value}
                onClick={() => onSpeedChange(preset.value)}
                className="px-2 py-1 rounded text-[10px] transition-colors"
                style={{
                  background: isActive ? "var(--accent-soft)" : "transparent",
                  color: isActive ? "var(--accent)" : "var(--ink-500)",
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--hairline)"}`,
                }}
              >
                {preset.label}
              </button>
            );
          })}
          {/* Opt-in Auto speed: the governor caps speed at what the measured
              network can sustain; the resolved value is shown ("Auto 2.5x").
              Selecting any explicit preset/slider value exits Auto. */}
          <button
            onClick={onAutoSpeedSelect}
            className="px-2 py-1 rounded text-[10px] transition-colors"
            style={{
              background: autoSpeed ? "var(--accent-soft)" : "transparent",
              color: autoSpeed ? "var(--accent)" : "var(--ink-500)",
              border: `1px solid ${autoSpeed ? "var(--accent)" : "var(--hairline)"}`,
            }}
            title="Match playback speed to what the network can sustain"
          >
            {autoSpeed ? `Auto ${currentSpeedMultiplier.toFixed(1)}x` : "Auto"}
          </button>
        </div>

        {/* Fine slider */}
        <div className="flex-1 flex items-center gap-2 min-w-0 hidden md:flex">
          <input
            type="range"
            min="0.25"
            max="20"
            step="0.25"
            value={currentSpeedMultiplier}
            onChange={(e) => onSpeedChange(Number(e.target.value))}
            className="flex-1 h-1 cursor-pointer"
            style={{ accentColor: "var(--accent)" }}
          />
          <span
            className="text-[10px] font-medium min-w-[32px] text-right"
            style={{ color: "var(--ink-900)" }}
          >
            {currentSpeedMultiplier.toFixed(1)}x
          </span>
        </div>
      </div>
    </div>
  );
};

export default TimeControls;
