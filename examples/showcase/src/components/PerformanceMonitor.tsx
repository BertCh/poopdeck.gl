/**
 * Performance monitoring component for the showcase app
 *
 * Displays real-time statistics about tile loading, caching, and rendering
 */

import React, { useState, useEffect } from "react";

interface PerformanceStats {
  // Tile statistics
  tileCount: number;
  activeRequests: number;
  queuedRequests: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;

  // Performance metrics
  fps: number;
  frameTime: number;

  // Memory (approximation)
  estimatedMemoryMB: number;
}

interface PerformanceMonitorProps {
  /** Function to get current tileset stats */
  getTilesetStats?: () => any;

  /** Show/hide toggle */
  visible?: boolean;
}

export const PerformanceMonitor: React.FC<PerformanceMonitorProps> = ({
  getTilesetStats,
  visible = true,
}) => {
  const [stats, setStats] = useState<PerformanceStats>({
    tileCount: 0,
    activeRequests: 0,
    queuedRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0,
    fps: 60,
    frameTime: 16,
    estimatedMemoryMB: 0,
  });

  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!visible) return;

    let frameCount = 0;
    let lastTime = performance.now();
    let animationFrameId: number;

    const updateStats = () => {
      const now = performance.now();
      const deltaTime = now - lastTime;

      frameCount++;

      // Update every 500ms
      if (deltaTime >= 500) {
        const fps = Math.round((frameCount / deltaTime) * 1000);
        const frameTime = deltaTime / frameCount;

        // Get tileset stats if available
        const tilesetStats = getTilesetStats?.() || {};

        // Estimate memory usage (rough approximation)
        const estimatedMemoryMB =
          ((performance as any).memory?.usedJSHeapSize || 0) / (1024 * 1024);

        setStats({
          tileCount: tilesetStats.tileCount || 0,
          activeRequests: tilesetStats.activeRequests || 0,
          queuedRequests: tilesetStats.queuedRequests || 0,
          cacheHits: tilesetStats.hits || 0,
          cacheMisses: tilesetStats.misses || 0,
          cacheEvictions: tilesetStats.evictions || 0,
          fps,
          frameTime: Math.round(frameTime * 10) / 10,
          estimatedMemoryMB: Math.round(estimatedMemoryMB),
        });

        frameCount = 0;
        lastTime = now;
      }

      animationFrameId = requestAnimationFrame(updateStats);
    };

    animationFrameId = requestAnimationFrame(updateStats);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [visible, getTilesetStats]);

  if (!visible) return null;

  const hitRate =
    stats.cacheHits + stats.cacheMisses > 0
      ? Math.round(
          (stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100
        )
      : 0;

  return (
    <div
      style={{
        position: "fixed",
        top: expanded ? "10px" : "auto",
        bottom: expanded ? "auto" : "10px",
        right: "10px",
        background: "rgba(0, 0, 0, 0.85)",
        color: "#fff",
        padding: "12px",
        borderRadius: "8px",
        fontSize: "12px",
        fontFamily: "monospace",
        zIndex: 1000,
        minWidth: "200px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: expanded ? "8px" : 0,
          cursor: "pointer",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <strong>Performance</strong>
        <span style={{ fontSize: "10px" }}>{expanded ? "▼" : "▲"}</span>
      </div>

      {expanded && (
        <>
          <div
            style={{
              borderBottom: "1px solid rgba(255,255,255,0.2)",
              paddingBottom: "8px",
              marginBottom: "8px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>FPS:</span>
              <span
                style={{
                  color:
                    stats.fps >= 50
                      ? "#4ade80"
                      : stats.fps >= 30
                        ? "#fbbf24"
                        : "#ef4444",
                }}
              >
                {stats.fps}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Frame Time:</span>
              <span>{stats.frameTime}ms</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Memory:</span>
              <span>{stats.estimatedMemoryMB}MB</span>
            </div>
          </div>

          <div
            style={{
              borderBottom: "1px solid rgba(255,255,255,0.2)",
              paddingBottom: "8px",
              marginBottom: "8px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Tiles Cached:</span>
              <span>{stats.tileCount}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Active Requests:</span>
              <span
                style={{
                  color: stats.activeRequests > 0 ? "#60a5fa" : "#94a3b8",
                }}
              >
                {stats.activeRequests}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Queued:</span>
              <span>{stats.queuedRequests}</span>
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Cache Hits:</span>
              <span style={{ color: "#4ade80" }}>{stats.cacheHits}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Cache Misses:</span>
              <span style={{ color: "#fbbf24" }}>{stats.cacheMisses}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Hit Rate:</span>
              <span
                style={{
                  color:
                    hitRate >= 80
                      ? "#4ade80"
                      : hitRate >= 50
                        ? "#fbbf24"
                        : "#ef4444",
                }}
              >
                {hitRate}%
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Evictions:</span>
              <span>{stats.cacheEvictions}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default PerformanceMonitor;



