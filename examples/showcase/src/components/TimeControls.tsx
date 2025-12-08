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
  // Calculate progress percentage
  const progress = useMemo(() => {
    const total = timeRange.end - timeRange.start;
    if (total === 0) return 0;
    return ((currentTime - timeRange.start) / total) * 100;
  }, [currentTime, timeRange]);

  // Calculate remaining playback time
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
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  // Speed presets for quick selection
  const speedPresets = [
    { label: "0.5x", value: 0.5 },
    { label: "1x", value: 1 },
    { label: "2x", value: 2 },
    { label: "5x", value: 5 },
    { label: "10x", value: 10 },
  ];

  return (
    <div
      style={{
        position: "absolute",
        bottom: "20px",
        left: "360px",
        right: "20px",
        background: "rgba(255, 255, 255, 0.95)",
        borderRadius: "12px",
        padding: "16px 20px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Progress bar with current time display */}
      <div style={{ marginBottom: "12px" }}>
        <div style={{ 
          display: "flex", 
          justifyContent: "space-between", 
          alignItems: "center",
          marginBottom: "8px"
        }}>
          <span style={{ 
            fontSize: "14px", 
            fontWeight: 600, 
            color: "#1a1a1a"
          }}>
            {formatDate(currentTime)}
          </span>
          <span style={{ 
            fontSize: "12px", 
            color: "#666",
            display: "flex",
            alignItems: "center",
            gap: "8px"
          }}>
            <span style={{ 
              background: isPlaying ? "#4CAF50" : "#9e9e9e",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              display: "inline-block"
            }} />
            {isPlaying ? `${formatDuration(remainingSeconds)} remaining` : "Paused"}
          </span>
        </div>
        
        {/* Custom styled progress bar */}
        <div style={{ 
          position: "relative",
          height: "6px",
          background: "#e0e0e0",
          borderRadius: "3px",
          cursor: "pointer",
          overflow: "hidden"
        }}>
          <div style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            width: `${progress}%`,
            background: "linear-gradient(90deg, #4a90e2, #67b3f4)",
            borderRadius: "3px",
            transition: "width 0.1s ease-out"
          }} />
          <input
            type="range"
            min={timeRange.start}
            max={timeRange.end}
            value={currentTime}
            onChange={(e) => onSeek(Number(e.target.value))}
            style={{ 
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              cursor: "pointer",
              margin: 0
            }}
          />
        </div>
        
        {/* Time range labels */}
        <div style={{ 
          display: "flex", 
          justifyContent: "space-between",
          fontSize: "11px",
          color: "#999",
          marginTop: "4px"
        }}>
          <span>{formatDate(timeRange.start)}</span>
          <span>{formatDate(timeRange.end)}</span>
        </div>
      </div>

      {/* Controls row */}
      <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
        {/* Play/Pause and Reset buttons */}
        <div style={{ display: "flex", gap: "8px" }}>
          <button 
            onClick={onPlayPause}
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "50%",
              border: "none",
              background: isPlaying 
                ? "linear-gradient(135deg, #ff6b6b, #ee5a5a)"
                : "linear-gradient(135deg, #4CAF50, #45a049)",
              color: "white",
              fontSize: "18px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
              transition: "transform 0.1s, box-shadow 0.1s"
            }}
            onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.95)")}
            onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button 
            onClick={() => onSeek(timeRange.start)}
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "8px",
              border: "1px solid #e0e0e0",
              background: "white",
              fontSize: "14px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center"
            }}
            title="Reset to start"
          >
            ⏮
          </button>
        </div>

        {/* Speed control */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "12px", color: "#666", whiteSpace: "nowrap" }}>
            Speed:
          </span>
          
          {/* Speed presets */}
          <div style={{ display: "flex", gap: "4px" }}>
            {speedPresets.map((preset) => (
              <button
                key={preset.value}
                onClick={() => onSpeedChange(preset.value)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "4px",
                  border: "1px solid",
                  borderColor: Math.abs(currentSpeedMultiplier - preset.value) < 0.1 
                    ? "#4a90e2" 
                    : "#e0e0e0",
                  background: Math.abs(currentSpeedMultiplier - preset.value) < 0.1 
                    ? "#e3f2fd" 
                    : "white",
                  fontSize: "11px",
                  fontWeight: Math.abs(currentSpeedMultiplier - preset.value) < 0.1 
                    ? 600 
                    : 400,
                  color: Math.abs(currentSpeedMultiplier - preset.value) < 0.1 
                    ? "#1976d2" 
                    : "#666",
                  cursor: "pointer",
                  transition: "all 0.15s"
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          
          {/* Fine-grained speed slider */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="range"
              min="0.25"
              max="20"
              step="0.25"
              value={currentSpeedMultiplier}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              style={{ 
                flex: 1,
                height: "4px",
                cursor: "pointer"
              }}
            />
            <span style={{ 
              fontSize: "12px", 
              fontWeight: 600,
              color: "#1a1a1a",
              minWidth: "40px",
              textAlign: "right"
            }}>
              {currentSpeedMultiplier.toFixed(1)}x
            </span>
          </div>
        </div>

        {/* Playback duration indicator */}
        <div style={{ 
          fontSize: "11px", 
          color: "#666",
          textAlign: "right",
          whiteSpace: "nowrap"
        }}>
          Full loop: {formatDuration(targetPlaybackSeconds / currentSpeedMultiplier)}
        </div>
      </div>
    </div>
  );
};

export default TimeControls;
