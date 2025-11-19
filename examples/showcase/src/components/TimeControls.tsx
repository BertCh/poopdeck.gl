import React from "react";

interface TimeControlsProps {
  currentTime: number;
  timeRange: { start: number; end: number };
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (multiplier: number) => void;
  currentSpeedMultiplier: number;
}

const TimeControls: React.FC<TimeControlsProps> = ({
  currentTime,
  timeRange,
  isPlaying,
  onPlayPause,
  onSeek,
  onSpeedChange,
  currentSpeedMultiplier,
}) => {
  const handleSpeedChange = (newMultiplier: number) => {
    onSpeedChange(newMultiplier);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Progress calculation (for future progress bar feature)
  // const progress =
  //   ((currentTime - timeRange.start) / (timeRange.end - timeRange.start)) * 100;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "20px",
        left: "20px",
        right: "20px",
        background: "white",
        borderRadius: "8px",
        padding: "20px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <div className="control-group">
        <label>Timeline</label>
        <input
          type="range"
          min={timeRange.start}
          max={timeRange.end}
          value={currentTime}
          onChange={(e) => onSeek(Number(e.target.value))}
          style={{ width: "100%" }}
        />
        <div className="slider-value">{formatDate(currentTime)}</div>
      </div>

      <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
        <div className="time-controls" style={{ flex: 1 }}>
          <button onClick={onPlayPause} className={isPlaying ? "playing" : ""}>
            {isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
          <button onClick={() => onSeek(timeRange.start)}>⏮ Reset</button>
        </div>

        <div className="control-group" style={{ flex: 1 }}>
          <label>
            Speed: {currentSpeedMultiplier.toFixed(2)}x
            <span style={{ fontSize: "0.85em", color: "#666", marginLeft: "8px" }}>
              (higher = faster playback)
            </span>
          </label>
          <input
            type="range"
            min="1.0"
            max="100.0"
            step="0.5"
            value={currentSpeedMultiplier}
            onChange={(e) => handleSpeedChange(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div style={{ 
            display: "flex", 
            justifyContent: "space-between",
            fontSize: "0.85em",
            color: "#666",
            marginTop: "4px"
          }}>
            <span>1x (slowest)</span>
            <span>100x (fastest)</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TimeControls;
