import React, { useState, useEffect } from 'react';

interface PerformanceStats {
  tileCount: number;
  activeRequests: number;
  queuedRequests: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  fps: number;
  frameTime: number;
  estimatedMemoryMB: number;
}

interface PerformanceMonitorProps {
  getTilesetStats?: () => any;
  visible?: boolean;
}

const PerformanceMonitor: React.FC<PerformanceMonitorProps> = ({ getTilesetStats, visible = true }) => {
  const [stats, setStats] = useState<PerformanceStats>({
    tileCount: 0, activeRequests: 0, queuedRequests: 0, cacheHits: 0, cacheMisses: 0,
    cacheEvictions: 0, fps: 60, frameTime: 16, estimatedMemoryMB: 0,
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

      if (deltaTime >= 500) {
        const fps = Math.round((frameCount / deltaTime) * 1000);
        const frameTime = deltaTime / frameCount;
        const tilesetStats = getTilesetStats?.() || {};
        const estimatedMemoryMB = ((performance as any).memory?.usedJSHeapSize || 0) / (1024 * 1024);

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
    return () => cancelAnimationFrame(animationFrameId);
  }, [visible, getTilesetStats]);

  if (!visible) return null;

  const hitRate = stats.cacheHits + stats.cacheMisses > 0
    ? Math.round((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100)
    : 0;

  const getFpsColor = (fps: number) => fps >= 50 ? '#0F9668' : fps >= 30 ? '#FFBD2E' : '#F9042C';

  return (
    <div
      className="absolute z-50 rounded text-[10px] select-none"
      style={{
        top: expanded ? 8 : 'auto',
        bottom: expanded ? 'auto' : 8,
        right: 8,
        background: 'rgba(36, 39, 48, 0.95)',
        border: '1px solid #3A414C',
        minWidth: 140,
        fontFamily: 'JetBrains Mono, monospace',
        color: '#A0A7B4',
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex justify-between items-center px-2.5 py-1.5 transition-colors"
        style={{ color: '#FFFFFF' }}
      >
        <span className="font-medium">Perf</span>
        <span style={{ color: '#6A7485' }}>{expanded ? '▼' : '▲'}</span>
      </button>

      {expanded && (
        <div className="px-2.5 pb-2 space-y-1.5" style={{ borderTop: '1px solid #3A414C', paddingTop: 6 }}>
          <div className="flex justify-between">
            <span>FPS:</span>
            <span style={{ color: getFpsColor(stats.fps) }}>{stats.fps}</span>
          </div>
          <div className="flex justify-between">
            <span>Frame:</span>
            <span>{stats.frameTime}ms</span>
          </div>
          <div className="flex justify-between">
            <span>Memory:</span>
            <span>{stats.estimatedMemoryMB}MB</span>
          </div>
          <div style={{ height: 1, background: '#3A414C', margin: '4px 0' }} />
          <div className="flex justify-between">
            <span>Cached:</span>
            <span>{stats.tileCount}</span>
          </div>
          <div className="flex justify-between">
            <span>Active:</span>
            <span style={{ color: stats.activeRequests > 0 ? '#1FBAD6' : '#6A7485' }}>{stats.activeRequests}</span>
          </div>
          <div className="flex justify-between">
            <span>Hit Rate:</span>
            <span style={{ color: hitRate >= 80 ? '#0F9668' : hitRate >= 50 ? '#FFBD2E' : '#F9042C' }}>{hitRate}%</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default PerformanceMonitor;
