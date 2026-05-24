/**
 * In-page probe installed via addInitScript before navigation.
 *
 * Publishes to window.__sttPerf — read by the harness via page.evaluate().
 *
 * Captures:
 *  - longtask entries (>50ms blocking the main thread)
 *  - frame timings via rAF (only during an active sample window, opened with
 *    window.__sttPerf.beginSample(label) and closed with endSample())
 *  - Worker construction (so we can confirm the WorkerTileDecoder pool spun
 *    up — a previous bug fell back to inline decode silently)
 *  - resource-timing for /data/*.stt range requests during each sample window
 *  - JS heap size (deltas across the run)
 *
 * The probe is the only piece of in-page instrumentation we install. Nothing
 * here depends on @stt/* internals, so the harness keeps working even if the
 * app's internal hooks move. (Future: thread an optional @stt instrumentation
 * import when we want decode/consolidate timings.)
 */

export const PAGE_PROBE_SCRIPT = `
(() => {
  if (window.__sttPerf) return;

  const state = {
    samples: {},          // label -> { frames: number[], startedAt: number, longTasks: any[], networkBytes: number, networkCount: number }
    activeLabel: null,
    workerUrls: [],
    rafActive: false,
    rafLast: 0,
    rafStart: 0,
    heapStart: 0,
    heapEnd: 0,
  };

  // Worker construction probe.
  const origWorker = window.Worker;
  function Wrapped(url, opts) {
    state.workerUrls.push(String(url));
    return new origWorker(url, opts);
  }
  Wrapped.prototype = origWorker.prototype;
  window.Worker = Wrapped;

  // PerformanceObserver: longtasks during the active sample.
  try {
    const po = new PerformanceObserver((list) => {
      if (!state.activeLabel) return;
      const bucket = state.samples[state.activeLabel];
      if (!bucket) return;
      for (const e of list.getEntries()) {
        // Discard pre-sample tasks: PerformanceObserver flushes buffered
        // entries on observe(); the .startTime guard handles that case.
        if (e.startTime < bucket.startedAt) continue;
        bucket.longTasks.push({ duration: e.duration, start: e.startTime });
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch (err) {
    // longtasks aren't supported everywhere; the harness handles missing data.
  }

  // PerformanceObserver: network bytes for *.stt range requests.
  try {
    const po = new PerformanceObserver((list) => {
      if (!state.activeLabel) return;
      const bucket = state.samples[state.activeLabel];
      if (!bucket) return;
      for (const e of list.getEntries()) {
        if (e.startTime < bucket.startedAt) continue;
        if (!/\\.stt(\\?|$)/.test(e.name)) continue;
        bucket.networkCount += 1;
        bucket.networkBytes += e.transferSize || e.encodedBodySize || 0;
      }
    });
    po.observe({ entryTypes: ['resource'] });
  } catch (err) {}

  function frameTick(now) {
    if (!state.rafActive) return;
    if (state.activeLabel) {
      const bucket = state.samples[state.activeLabel];
      if (bucket) bucket.frames.push(now - state.rafLast);
    }
    state.rafLast = now;
    requestAnimationFrame(frameTick);
  }

  window.__sttPerf = {
    /** Begin recording into a labelled bucket. */
    beginSample(label) {
      state.activeLabel = label;
      state.samples[label] = state.samples[label] || {
        frames: [],
        longTasks: [],
        networkBytes: 0,
        networkCount: 0,
        startedAt: performance.now(),
        endedAt: 0,
      };
      state.samples[label].startedAt = performance.now();
      // Start the rAF loop on the first sample.
      if (!state.rafActive) {
        state.rafActive = true;
        state.rafLast = performance.now();
        state.rafStart = state.rafLast;
        requestAnimationFrame(frameTick);
      }
      // Heap snapshot at the very start, once.
      if (performance.memory && state.heapStart === 0) {
        state.heapStart = performance.memory.usedJSHeapSize;
      }
    },

    /** Stop the current labelled recording. */
    endSample() {
      if (!state.activeLabel) return;
      state.samples[state.activeLabel].endedAt = performance.now();
      state.activeLabel = null;
    },

    /** Snapshot the current state into a plain object. */
    snapshot() {
      if (performance.memory) {
        state.heapEnd = performance.memory.usedJSHeapSize;
      }
      return {
        workerUrls: state.workerUrls.slice(),
        samples: JSON.parse(JSON.stringify(state.samples)),
        heap: {
          start: state.heapStart,
          end: state.heapEnd,
          delta: state.heapEnd - state.heapStart,
        },
      };
    },

    /** True if the page-side probe is healthy. */
    alive() {
      return true;
    },
  };
})();
`;
