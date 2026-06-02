import React, { useMemo } from "react";

interface TimeControlsProps {
  currentTime: number;
  timeRange: { start: number; end: number };
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (multiplier: number) => void;
  currentSpeedMultiplier: number;
  targetPlaybackSeconds: number;
}

const TimeControls: React.FC<TimeControlsProps> = ({
  currentTime,
  timeRange,
  isPlaying,
  onPlayPause,
  onSeek,
  onSpeedChange,
  currentSpeedMultiplier,
  targetPlaybackSeconds,
}) => {
  const progress = useMemo(() => {
    const total = timeRange.end - timeRange.start;
    if (total === 0) return 0;
    return ((currentTime - timeRange.start) / total) * 100;
  }, [currentTime, timeRange]);

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

  return (
    <div className="space-y-3">
      {/* Time display */}
      <div className="flex justify-between items-center">
        <span
          className="text-xs font-medium font-mono"
          style={{ color: "var(--ink-900)" }}
        >
          {formatDate(currentTime)}
        </span>
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
      </div>

      {/* Progress bar */}
      <div
        className="relative h-1.5 rounded-full cursor-pointer"
        style={{ background: "var(--hairline)" }}
      >
        <div
          className="absolute left-0 top-0 h-full rounded-full"
          style={{ width: `${progress}%`, background: "var(--accent)" }}
        />
        <input
          type="range"
          min={timeRange.start}
          max={timeRange.end}
          value={currentTime}
          onChange={(e) => onSeek(Number(e.target.value))}
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
              Math.abs(currentSpeedMultiplier - preset.value) < 0.1;
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
