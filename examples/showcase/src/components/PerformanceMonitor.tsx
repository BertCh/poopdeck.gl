import React, { useState, useEffect } from 'react';
import { enableProbe, getSnapshot } from '@poopdeck.gl/layers';
import type { OverviewPreloadResult } from '@poopdeck.gl/layers';
import type { SourceRunway } from '@poopdeck.gl/playback';

interface PerformanceStats {
  tileCount: number;
  visibleTiles: number;
  activeRequests: number;
  priorityQueueLength: number;
  prefetchQueueLength: number;
  cacheHits: number;
  cacheMisses: number;
  cacheBytesMB: number;
  archiveCacheBytesMB: number;
  fps: number;
  frameTime: number;
  estimatedMemoryMB: number;
}

interface PerformanceMonitorProps {
  /**
   * Optional manual override. When unset (now the default), the HUD reads
   * tileset stats from the `globalThis.__sttProbe` snapshot channel that
   * `SpatioTemporalLayer` publishes to on every viewport / tileset update.
   * The earlier prop-based wiring was never connected by DemoPage, so the
   * cache panel showed all zeros.
   */
  getTilesetStats?: () => any;
  visible?: boolean;
  /**
   * Storyboard (overview preview tier) preload outcome, fed from the layer's
   * `onOverviewPreload` callback. Falls back to the `overview.preload`
   * snapshot channel when unset; the row is hidden while neither has fired.
   */
  overviewPreload?: OverviewPreloadResult | null;
  /**
   * Where the collapsed chip docks. DemoPage uses `top-right` because the
   * dataset Legend already owns the bottom-right corner. (Expanded view is
   * top-anchored either way — pre-existing behaviour.)
   */
  anchor?: 'bottom-right' | 'top-right';
  /**
   * Per-source buffered-runway probe (PlaybackGovernor.getSourceRunways),
   * threaded by the viewer that owns the governor. Polled only while the HUD
   * is expanded; one compact row per registered source so a starved source
   * (runway 0, not complete) is VISIBLE instead of silently rendering empty.
   */
  getSourceRunways?: () => SourceRunway[];
}

/** One-line "storyboard:" stat. */
function formatOverview(result: OverviewPreloadResult): string {
  const mb = Math.round((result.bytes / (1024 * 1024)) * 10) / 10;
  if (result.loaded) return `loaded (${result.tiles} tiles, ${mb} MB)`;
  if (result.reason === 'over-budget') return `skipped (over budget, ${mb} MB)`;
  if (result.reason === 'no-tiles') return 'skipped (no tiles)';
  return `skipped (${result.reason ?? 'unknown'})`;
}

interface TilesetSnapshot {
  tileCount?: number;
  visibleTiles?: number;
  activeRequests?: number;
  priorityQueueLength?: number;
  prefetchQueueLength?: number;
  hits?: number;
  misses?: number;
  evictions?: number;
  cacheBytes?: number;
}

interface ArchiveSnapshot {
  bytes?: number;
}

const PerformanceMonitor: React.FC<PerformanceMonitorProps> = ({
  getTilesetStats,
  visible = true,
  overviewPreload = null,
  anchor = 'bottom-right',
  getSourceRunways,
}) => {
  const [stats, setStats] = useState<PerformanceStats>({
    tileCount: 0,
    visibleTiles: 0,
    activeRequests: 0,
    priorityQueueLength: 0,
    prefetchQueueLength: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheBytesMB: 0,
    archiveCacheBytesMB: 0,
    fps: 60,
    frameTime: 16,
    estimatedMemoryMB: 0,
  });
  const [expanded, setExpanded] = useState(false);
  const [runways, setRunways] = useState<SourceRunway[]>([]);

  // Per-source runway rows: poll the governor probe on the same 500 ms cadence
  // as the stats, but ONLY while the expanded panel can show them (a pure read
  // — no reason to probe behind the collapsed chip).
  useEffect(() => {
    if (!visible || !expanded || !getSourceRunways) {
      setRunways([]);
      return;
    }
    const update = () => setRunways(getSourceRunways());
    update();
    const intervalId = setInterval(update, 500);
    return () => clearInterval(intervalId);
  }, [visible, expanded, getSourceRunways]);

  useEffect(() => {
    if (!visible) return;
    // Activate the probe so SpatioTemporalLayer publishes snapshots. No-op
    // when already enabled.
    enableProbe();
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
        // Snapshot path is the new default; the prop callback is still
        // honoured if a consumer wants to inject custom stats.
        const tilesetStats: TilesetSnapshot =
          getTilesetStats?.() ??
          getSnapshot<TilesetSnapshot>('tileset.stats') ??
          {};
        const archiveStats: ArchiveSnapshot =
          getSnapshot<ArchiveSnapshot>('archive.stats') ?? {};
        const estimatedMemoryMB =
          ((performance as any).memory?.usedJSHeapSize || 0) / (1024 * 1024);

        setStats({
          tileCount: tilesetStats.tileCount ?? 0,
          visibleTiles: tilesetStats.visibleTiles ?? 0,
          activeRequests: tilesetStats.activeRequests ?? 0,
          priorityQueueLength: tilesetStats.priorityQueueLength ?? 0,
          prefetchQueueLength: tilesetStats.prefetchQueueLength ?? 0,
          cacheHits: (tilesetStats as any).hits ?? 0,
          cacheMisses: (tilesetStats as any).misses ?? 0,
          cacheBytesMB:
            Math.round(((tilesetStats.cacheBytes ?? 0) / (1024 * 1024)) * 10) /
            10,
          archiveCacheBytesMB:
            Math.round(((archiveStats.bytes ?? 0) / (1024 * 1024)) * 10) / 10,
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

  const hitRate =
    stats.cacheHits + stats.cacheMisses > 0
      ? Math.round(
          (stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100,
        )
      : 0;

  const getFpsColor = (fps: number) =>
    fps >= 50 ? '#0F9668' : fps >= 30 ? '#FFBD2E' : '#F9042C';

  // Storyboard preload outcome: prop first (DemoPage feeds onOverviewPreload
  // straight in), snapshot channel as a fallback for probe-driven consumers.
  const overview =
    overviewPreload ??
    getSnapshot<OverviewPreloadResult>('overview.preload') ??
    null;

  const dockTop = expanded || anchor === 'top-right';

  return (
    <div
      className="absolute z-50 rounded text-[10px] select-none"
      style={{
        top: dockTop ? 8 : 'auto',
        bottom: dockTop ? 'auto' : 8,
        right: 8,
        background: 'rgba(36, 39, 48, 0.95)',
        border: '1px solid #3A414C',
        minWidth: 140,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
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
        <div
          className="px-2.5 pb-2 space-y-1.5"
          style={{ borderTop: '1px solid #3A414C', paddingTop: 6 }}
        >
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
            <span>Tiles:</span>
            <span>
              {stats.visibleTiles}/{stats.tileCount}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Active:</span>
            <span
              style={{
                color: stats.activeRequests > 0 ? '#1FBAD6' : '#6A7485',
              }}
            >
              {stats.activeRequests}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Queue:</span>
            <span>
              {stats.priorityQueueLength}+{stats.prefetchQueueLength}
            </span>
          </div>
          {overview && (
            <div className="flex justify-between gap-2">
              <span>Storyboard:</span>
              <span
                className="text-right"
                style={{ color: overview.loaded ? '#0F9668' : '#6A7485' }}
              >
                {formatOverview(overview)}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Tileset MB:</span>
            <span>{stats.cacheBytesMB}</span>
          </div>
          <div className="flex justify-between">
            <span>Bytes MB:</span>
            <span>{stats.archiveCacheBytesMB}</span>
          </div>
          <div className="flex justify-between">
            <span>Hit Rate:</span>
            <span
              style={{
                color:
                  hitRate >= 80
                    ? '#0F9668'
                    : hitRate >= 50
                      ? '#FFBD2E'
                      : '#F9042C',
              }}
            >
              {hitRate}%
            </span>
          </div>
          {runways.length > 0 && (
            <>
              <div
                style={{ height: 1, background: '#3A414C', margin: '4px 0' }}
              />
              {/* One row per governor source: REQ sources gate the clock, OPT
                  sources continue-and-degrade. Runway = buffered sim-seconds
                  ahead of the playhead; red = starved (empty runway, more data
                  left), ✓ = fully buffered / dataset end. */}
              {runways.map((r) => {
                const starved = r.runwaySimMs === 0 && !r.complete;
                return (
                  <div key={r.id} className="flex justify-between gap-2">
                    <span className="truncate">
                      <span
                        style={{ color: r.required ? '#1FBAD6' : '#6A7485' }}
                      >
                        {r.required ? 'REQ' : 'OPT'}
                      </span>{' '}
                      {r.id}
                    </span>
                    <span
                      className="text-right shrink-0"
                      style={starved ? { color: '#F9042C' } : undefined}
                    >
                      {r.complete ? '✓ ' : ''}
                      {(r.runwaySimMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default PerformanceMonitor;
