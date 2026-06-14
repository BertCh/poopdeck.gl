import { Page } from '@playwright/test';

/**
 * Metric bundle collected per dataset over a fixed playback window. All
 * timings are milliseconds; all sizes are megabytes. Fields are nullable
 * because some platforms (notably the SwiftShader CI path) don't expose
 * every signal — the runner records `null` rather than masking a missing
 * source with a zero.
 */
export interface DatasetMetrics {
  /** Real-time playback window we sampled over, in ms. */
  sampleWindowMs: number;

  /** rAF-derived FPS over the sample window. */
  fps: number;
  /** Total animation frames observed during the window. */
  frames: number;
  /** Median frame time in ms (lower is better). */
  frameTimeP50: number;
  /** 95th-percentile frame time in ms (the worst-typical frame). */
  frameTimeP95: number;
  /** Max frame time in ms (the single slowest frame). */
  frameTimeMax: number;

  /** JS heap (used) in MB at the END of the sample window. */
  jsHeapUsedMB: number | null;
  /** JS heap (total) in MB at the END of the sample window. */
  jsHeapTotalMB: number | null;
  /** Heap growth across the sample window in MB. Positive ⇒ allocating during playback. */
  jsHeapGrowthMB: number | null;
  /**
   * Cross-origin-isolated detailed memory measurement when available
   * (Chromium's `performance.measureUserAgentSpecificMemory`). Reports
   * total page memory across realms including GPU + worker — the closest
   * proxy we have to "true" footprint. `null` when the API is gated off.
   */
  detailedMemoryMB: number | null;

  /** Long-task count during the sample window. */
  longTaskCount: number;
  /** Total ms blocked by long tasks during the window. */
  longTaskTotalMs: number;
  /** Worst single long-task duration in ms. */
  longTaskMaxMs: number;

  /**
   * Tile-load timings derived from the @poopdeck.gl/layers probe channel. `null`
   * when the probe didn't emit any samples (e.g., heatmap-only datasets
   * without consolidations).
   */
  tilePrepare: { count: number; p50: number; p95: number } | null;
  tileDecode: { count: number; p50: number; p95: number; mb: number } | null;
  consolidations: { count: number; p50: number; p95: number } | null;
  renderLayers: { count: number; p50: number; p95: number } | null;

  /** Latest tileset/archive snapshot the probe published. */
  tilesetSnapshot: unknown | null;
  archiveSnapshot: unknown | null;
}

/**
 * Install the long-task observer and capture a memory baseline. Returns a
 * `collect()` that the caller invokes after exercising the page; collect
 * synthesises percentiles and tears the observer down.
 */
export async function startInPageCollectors(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface CollectorState {
      longTasks: Array<{ ms: number; ts: number }>;
      observer: PerformanceObserver | null;
      heapStart: { used: number; total: number } | null;
      sampleStart: number;
    }
    const g = window as unknown as { __sttCollector?: CollectorState };
    if (g.__sttCollector?.observer) {
      try {
        g.__sttCollector.observer.disconnect();
      } catch {
        /* ignore */
      }
    }
    const memSnap = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
      }
    ).memory ?? null;
    const state: CollectorState = {
      longTasks: [],
      observer: null,
      heapStart: memSnap
        ? { used: memSnap.usedJSHeapSize, total: memSnap.totalJSHeapSize }
        : null,
      sampleStart: performance.now(),
    };
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ ms: entry.duration, ts: entry.startTime });
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
      state.observer = obs;
    } catch {
      // longtask not supported — leave the observer null; we'll just report 0.
    }
    g.__sttCollector = state;
  });
}

/**
 * Sample rAF frame-times over `durationMs`, then collect heap + long-task +
 * probe metrics. `startInPageCollectors` MUST have been called before the
 * window of interest opened.
 */
export async function collectMetrics(
  page: Page,
  durationMs: number,
): Promise<DatasetMetrics> {
  const result = await page.evaluate(async (duration) => {
    interface ProbeBag {
      enabled?: boolean;
      consolidations?: Array<{ ms?: number; n?: number; layer?: string }>;
      renderLayers?: Array<{ ms?: number; tiles?: number; layer?: string }>;
      tilePrepare?: Array<{ ms?: number; tileKey?: string; layer?: string }>;
      decode?: Array<{ ms?: number; bytes?: number; tileKey?: string }>;
      snapshots?: Record<string, unknown>;
    }
    const probe = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
    // Clear probe arrays before sampling so we only count work within the
    // observation window, not whatever piled up during navigation.
    if (probe) {
      probe.tilePrepare = [];
      probe.decode = [];
      probe.consolidations = [];
      probe.renderLayers = [];
    }

    const frameTimes: number[] = [];
    const sampleStart = performance.now();
    await new Promise<void>((resolve) => {
      let last = sampleStart;
      const tick = (now: number) => {
        frameTimes.push(now - last);
        last = now;
        if (now - sampleStart < duration) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
    const sampleEnd = performance.now();
    const elapsed = sampleEnd - sampleStart;

    const sorted = [...frameTimes].sort((a, b) => a - b);
    const pick = (p: number) =>
      sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
        : 0;
    const fps = elapsed > 0 ? (frameTimes.length / elapsed) * 1000 : 0;

    const memSnap = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
      }
    ).memory ?? null;

    let detailedMemoryMB: number | null = null;
    const memApi = (
      performance as unknown as {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      }
    ).measureUserAgentSpecificMemory;
    if (typeof memApi === 'function') {
      try {
        const m = await memApi.call(performance);
        detailedMemoryMB = m.bytes / (1024 * 1024);
      } catch {
        // Origin not cross-origin isolated; leave null.
      }
    }

    const collector = (window as unknown as {
      __sttCollector?: {
        longTasks: Array<{ ms: number; ts: number }>;
        observer: PerformanceObserver | null;
        heapStart: { used: number; total: number } | null;
      };
    }).__sttCollector;
    if (collector?.observer) {
      try {
        collector.observer.disconnect();
      } catch {
        /* ignore */
      }
    }
    const longTasks = (collector?.longTasks ?? []).filter(
      (t) => t.ts >= sampleStart && t.ts <= sampleEnd,
    );
    const heapStart = collector?.heapStart ?? null;

    const summarise = (
      values: number[],
    ): { count: number; p50: number; p95: number } | null => {
      if (values.length === 0) return null;
      const s = [...values].sort((a, b) => a - b);
      return {
        count: s.length,
        p50: s[Math.floor(s.length * 0.5)],
        p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
      };
    };
    const probeMs = (arr: Array<{ ms?: number }> | undefined) =>
      (arr ?? []).map((s) => s.ms ?? 0).filter((n) => Number.isFinite(n));
    const tilePrepareSum = summarise(probeMs(probe?.tilePrepare));
    const tileDecodeMsArr = probeMs(probe?.decode);
    const tileDecodeBytes = (probe?.decode ?? []).reduce(
      (acc, s) => acc + (s.bytes ?? 0),
      0,
    );
    const tileDecodeSum = summarise(tileDecodeMsArr);
    const consolidationSum = summarise(probeMs(probe?.consolidations));
    const renderLayerSum = summarise(probeMs(probe?.renderLayers));

    return {
      sampleWindowMs: elapsed,
      fps,
      frames: frameTimes.length,
      frameTimeP50: pick(0.5),
      frameTimeP95: pick(0.95),
      frameTimeMax: sorted.length ? sorted[sorted.length - 1] : 0,
      jsHeapUsedMB: memSnap ? memSnap.usedJSHeapSize / (1024 * 1024) : null,
      jsHeapTotalMB: memSnap ? memSnap.totalJSHeapSize / (1024 * 1024) : null,
      jsHeapGrowthMB:
        memSnap && heapStart
          ? (memSnap.usedJSHeapSize - heapStart.used) / (1024 * 1024)
          : null,
      detailedMemoryMB,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((a, t) => a + t.ms, 0),
      longTaskMaxMs: longTasks.reduce((a, t) => Math.max(a, t.ms), 0),
      tilePrepare: tilePrepareSum,
      tileDecode: tileDecodeSum
        ? { ...tileDecodeSum, mb: tileDecodeBytes / (1024 * 1024) }
        : null,
      consolidations: consolidationSum,
      renderLayers: renderLayerSum,
      tilesetSnapshot: probe?.snapshots?.['tileset.stats'] ?? null,
      archiveSnapshot: probe?.snapshots?.['archive.stats'] ?? null,
    } as DatasetMetrics;
  }, durationMs);
  return result;
}
